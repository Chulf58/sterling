// Conductor context pressure on OpenCode: H10's soft note and hard warning
// (context_watch.conductor soft_pct / hard_pct), measured from OpenCode's own
// step events (GitHub #82).
//
// Measurement. OpenCode 2.0.23 publishes session.step.started with data
// { sessionID, model: { providerID, id, variant } } and session.step.ended with
// data { sessionID, tokens: { input, output, reasoning, cache: { read, write } } };
// both sit in the same event group as session.execution.succeeded, which the
// plugin's event subscription already receives. Fill is H10's definition
// (lib/transcript.mjs fillPct: input + cache creation + cache read): the latest
// ended step's input + cache.read + cache.write, over the model's window. The
// window is context_watch.windows[providerID/id] ?? [id] ?? [id without a
// "[...]" suffix], then OpenCode's own model limit (ctx.model.list(), limit.context),
// then context_watch.windows.default; a window not from a per-model entry is named.
//
// Delivery. Each line is appended once to the root session's next prompt text,
// the way selection.mjs delivers the dashboard selection: it lands in the
// conversation once and is never re-rendered. Nothing goes into the system
// prompt, which context.mjs rebuilds on every request (a changing number there
// would break the prompt cache on every turn). Per session: the soft note at
// most once, the hard warning at most once (it spends the soft note too), and,
// when a turn has run but the fill cannot be measured, one "not measured" note
// naming why. These marks live in this process only, so a restarted OpenCode
// can repeat a line once for a resumed session.
import { parseConfig } from '@sterling/schemas';
import { readProjectConfig } from '../../../scripts/hooks/lib/operating-state.mjs';
import { remember } from './bounded.mjs';
import { sessionKind } from './dispatch.mjs';
import { errText } from './log.mjs';
import { inWorkerChild } from './worker.mjs';

const STEP_STARTED = 'session.step.started';
const STEP_ENDED = 'session.step.ended';
const STEP_FAILED = 'session.step.failed';
const EXECUTION_ENDS = new Set(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']);

/** The occupied context of one step's tokens (input + cache.read + cache.write), or null when they are missing or all zero. */
export function stepFillTokens(tokens) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const input = n(tokens?.input);
  const read = n(tokens?.cache?.read);
  const write = n(tokens?.cache?.write);
  if (input === null || read === null || write === null) return null;
  const used = input + read + write;
  return used > 0 ? used : null;
}

/**
 * `listModels()` returns OpenCode's model list (ctx.model.list()); `getSession()` and `parents` are what dispatch.mjs
 * sessionKind takes. Returns onEvent(ev), which records each session's latest model and fill, and
 * onPrompt(input), which appends at most one line to a root session's prompt text.
 */
export function createPressureWatch({ rootOf, fenced, getSession, parents, listModels, env = process.env }) {
  // Per session: { model, used, ran, soft, hard, noted } (bounded, bounded.mjs).
  const sessions = new Map();
  // The OpenCode window of each providerID/id already looked up.
  const opencodeWindows = new Map();

  function stateOf(sessionID) {
    return sessions.get(sessionID) ?? remember(sessions, sessionID, { model: null, used: null, ran: false, soft: false, hard: false, noted: false });
  }

  function onEvent(ev) {
    const sessionID = ev?.data?.sessionID;
    if (typeof sessionID !== 'string' || !sessionID) return;
    if (ev.type === STEP_STARTED) {
      const model = ev.data.model;
      if (model && typeof model.id === 'string' && model.id) stateOf(sessionID).model = { providerID: typeof model.providerID === 'string' ? model.providerID : '', id: model.id };
    } else if (ev.type === STEP_ENDED || ev.type === STEP_FAILED) {
      const s = stateOf(sessionID);
      s.ran = true;
      const used = stepFillTokens(ev.data.tokens);
      if (used !== null) s.used = used;
    } else if (EXECUTION_ENDS.has(ev.type)) {
      stateOf(sessionID).ran = true;
    }
  }

  /** OpenCode's own context limit for `model`, or { why } when the model list cannot give one. */
  async function opencodeWindow(model) {
    const key = `${model.providerID}/${model.id}`;
    if (opencodeWindows.has(key)) return { window: opencodeWindows.get(key) };
    let list;
    try {
      list = await listModels?.();
    } catch (e) {
      return { why: `OpenCode's model list failed: ${errText(e)}` };
    }
    if (!Array.isArray(list)) return { why: `OpenCode's model list is ${list === undefined ? 'unavailable' : 'not an array'}` };
    const found = list.find((m) => m?.providerID === model.providerID && (m?.modelID === model.id || m?.id === model.id));
    const window = found?.limit?.context;
    if (typeof window !== 'number' || !(window > 0)) return { why: `OpenCode's model list has no context limit for ${key}` };
    opencodeWindows.set(key, window);
    return { window };
  }

  /** The window for `model` and where it came from: { window, source } or { why }. */
  async function windowFor(model, windows) {
    const base = model.id.replace(/\[[^\]]*\]$/, '');
    const own = windows[`${model.providerID}/${model.id}`] ?? windows[model.id] ?? windows[base];
    if (own !== undefined) return { window: own, source: '' };
    const oc = await opencodeWindow(model);
    if (oc.window) return { window: oc.window, source: " (window from OpenCode's model list)" };
    if (windows.default !== undefined) return { window: windows.default, source: ' (window from context_watch.windows.default)' };
    return { why: `${oc.why}, and context_watch.windows has no entry for it and no default` };
  }

  const notMeasured = (why) =>
    `Sterling context pressure: not measured for this session (${why}), so no soft or hard context-pressure line will appear; watch the session's length yourself. (once per session)`;

  /** The one line due for session state `s`, or '' (and marks it spent). */
  async function lineFor(root, s) {
    if (s.hard || !s.ran) return '';
    const note = (why) => {
      if (s.noted) return '';
      s.noted = true;
      return notMeasured(why);
    };
    if (s.used === null) return note('OpenCode reported no token usage for this session\'s turns to the plugin');
    if (!s.model) return note('OpenCode reported no model for this session\'s turns');
    const { config, configUnreadable } = readProjectConfig(root);
    if (configUnreadable) return note('.sterling/config.json is unreadable');
    let cw;
    try {
      cw = parseConfig(config ?? {}).context_watch;
    } catch (e) {
      return note(`.sterling/config.json is invalid: ${errText(e)}`);
    }
    const w = await windowFor(s.model, cw.windows);
    const modelName = `${s.model.providerID}/${s.model.id}`;
    if (w.why) return note(`no context window for ${modelName}: ${w.why}`);
    const fill = (100 * s.used) / w.window;
    // As H10: past 100% the window is wrong for this model, not the session full.
    if (fill > 100) return note(`${s.used} tokens exceed the ${w.window}-token window${w.source} for ${modelName}, so that window is wrong for it`);
    const { soft_pct: soft, hard_pct: hard } = cw.conductor;
    if (fill >= hard) {
      s.hard = true;
      s.soft = true;
      return `Sterling context warning: fill ${fill.toFixed(1)}% of the ${w.window}-token window is past the ${hard}% target → finish the open work and commit it; delegate reads and mechanical work to subagents (P1).${w.source} (once per session)`;
    }
    if (fill >= soft && !s.soft) {
      s.soft = true;
      return `Sterling context pressure: fill ${fill.toFixed(1)}% ≥ soft threshold ${soft}% → prefer finishing open work, delegate reads to subagents.${w.source} (once per session)`;
    }
    return '';
  }

  async function onPrompt(input) {
    if (inWorkerChild(env)) return;
    const root = rootOf();
    if (!root) return;
    const sessionID = input?.sessionID;
    const s = typeof sessionID === 'string' ? sessions.get(sessionID) : undefined;
    // Nothing has run in this session yet (or this process has not seen it): nothing to say.
    if (!s || s.hard || !s.ran) return;
    await fenced('prompt', root, async () => {
      if (typeof input?.prompt?.text !== 'string') throw new Error(`unrecognized prompt shape (prompt.text is ${typeof input?.prompt?.text})`);
      const kind = await sessionKind(getSession?.(), sessionID, parents);
      if (kind.why) throw new Error(`context pressure skipped: could not tell whether session ${sessionID} is a root session (${kind.why})`);
      if (kind.kind !== 'root') return;
      const line = await lineFor(root, s);
      if (line) input.prompt.text = `${input.prompt.text}\n\n${line}`;
    });
  }

  return { onEvent, onPrompt };
}
