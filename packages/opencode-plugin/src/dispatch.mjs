// The dispatch register (H22) on OpenCode 2, and the root-session gate settlement uses.
//
// H22's Pre/Post/Failure arms on Claude Code's Task|Agent tool map onto the
// subagent tool: execute.before records the dispatch (recordDispatchPre, keyed by
// the tool call id); a completed execute.after binds the child session
// (recordDispatchPost); a failed one is terminal (recordDispatchFailure). The
// child session id is the subagent result's metadata.sessionID, read from the
// OpenCode 2.0.21 binary (`metadata:{sessionID,status}`), not measured in a live run.
// Post's prompt check compares the call's own input with itself: execute.after
// carries the same call id and input as execute.before, so the pairing holds by
// construction rather than by an echoed prompt.
//
// H22's SubagentStart arm (resolveAndRegisterStart) has no OpenCode event; its
// register round is written at the Post bind instead, with the files the brief
// names (H20's briefTerritory), so H20's DISPATCH OVERLAP sees a running subagent.
//
// OpenCode has no SubagentStop. A foreground subagent has finished when its call
// returns, so that dispatch is ended there; a background one (background: true)
// is ended when its child session's execution ends, succeeded, failed or
// interrupted (endChildDispatch, called from the settlement gate). A child that
// ends before its call's execute.after binds it is ended at that bind: the
// server notes every execution end (noteExecutionEnd) before the gate reads the
// register, and the bind checks for an end at or after the call's own Pre.
// Records a dead process left live are terminalized by sweepStaleDispatches at
// the first root request of the next process, as H1's sessionBoundarySweep does
// on Claude Code. TaskStop has no OpenCode equivalent and is not handled.
//
// Every state write goes through scripts/lib/dispatch-register.mjs, the one owner
// of the record shape and the lock. Its disclosures go to the plugin log, as H22's
// go to stderr.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { briefTerritory } from '../../../scripts/hooks/lib/dispatch-overlap.mjs';
import { parseReviewTerritory } from '../../../scripts/hooks/lib/dispatch-prompt.mjs';
import {
  finishDispatchAndRegisterEnd,
  readDispatchState,
  readRegister,
  recordDispatchFailure,
  recordDispatchPost,
  recordDispatchPre,
  registerPath,
  resolveAndRegisterStart,
  sessionBoundarySweep,
  withRegisterLock,
} from '../../../scripts/lib/dispatch-register.mjs';
import { render } from '../../../scripts/lib/review-errors.mjs';
import { agentRole } from './agent-name.mjs';
import { remember } from './bounded.mjs';
import { errText, logLine } from './log.mjs';

/** The H22 stdin shape for an OpenCode subagent call. */
function claudeShape(input) {
  const args = input.input && typeof input.input === 'object' ? input.input : {};
  return { tool_use_id: input.id, session_id: input.sessionID, tool_input: { prompt: args.prompt, subagent_type: args.agent, description: args.description } };
}

/** The child session a completed subagent call names, or null. */
export function childSessionOf(input) {
  const id = input?.result?.metadata?.sessionID;
  return typeof id === 'string' && id ? id : null;
}

function logDisclosures(root, result) {
  for (const d of result?.disclosures ?? []) logLine(root, `dispatch register: ${d}`);
}

/** Live dispatch-state records bound to `sessionID` as their child. */
function boundTo(scan, sessionID) {
  return scan.records.filter(({ record: r }) => !r.terminal && (r.post_binding?.agent_id ?? r.derived_binding?.agent_id ?? r.started?.agent_id) === sessionID);
}

/** End every live dispatch whose child is `sessionID` (a background subagent's execution end). */
export async function endChildDispatch(root, sessionID) {
  const scan = readDispatchState(root);
  if (scan.availability !== 'ok') return;
  for (const { record } of boundTo(scan, sessionID)) {
    const finished = await finishDispatchAndRegisterEnd(root, { session_id: record.session_id, agent_id: sessionID });
    logDisclosures(root, finished);
  }
}

/**
 * Whether the dispatch register or the dispatch state shows `sessionID` as a
 * live child: a register round for it that has not ended, or a dispatch-state
 * record bound to it that is not terminal.
 */
export function liveChildInRegister(root, sessionID) {
  const reg = readRegister(root);
  if (reg.availability === 'ok' && reg.entries.some((e) => e.agent_id === sessionID && !e.ended)) return true;
  const scan = readDispatchState(root);
  return scan.availability === 'ok' && boundTo(scan, sessionID).length > 0;
}

function describeInfo(info) {
  if (info === null || info === undefined) return 'nothing';
  if (typeof info !== 'object') return `a ${typeof info}`;
  return typeof info.id === 'string' && info.id ? `session ${info.id}` : 'a record with no id';
}

/**
 * Whether `sessionID` is a root or a child session, from session.get's parentID.
 * Returns { kind: 'root' } or { kind: 'child' }, or { why } when it cannot be
 * told: the lookup threw, or it answered for no session or for another one
 * (fail closed: such an answer is never read as a root). `parents` caches each
 * answer, since a session's parentID never changes.
 */
export async function sessionKind(session, sessionID, parents) {
  if (typeof sessionID !== 'string' || !sessionID) return { why: 'no sessionID' };
  if (!parents.has(sessionID)) {
    let info;
    try {
      if (!session || typeof session.get !== 'function') throw new Error('ctx.session.get is unavailable');
      info = await session.get({ sessionID });
    } catch (e) {
      return { why: errText(e) };
    }
    if (info?.id !== sessionID) return { why: `session.get answered ${describeInfo(info)} for session ${sessionID}` };
    remember(parents, sessionID, info.parentID ?? null);
  }
  return { kind: parents.get(sessionID) ? 'child' : 'root' };
}

/**
 * Decide whether an execution end for `sessionID` settles. Returns
 * { settle: true } for a root session, { settle: false } for a child (after
 * ending any background dispatch bound to it), and { settle: false, why } when
 * the session cannot be checked. Correct whether or not OpenCode emits the event
 * for child sessions: a child is recognised by its parentID or by the register,
 * and a session that cannot be checked is not settled (fail closed).
 */
export async function rootSessionGate(root, { session, sessionID, parents }) {
  if (typeof sessionID !== 'string' || !sessionID) return { settle: false, why: 'the event carries no sessionID' };
  if (liveChildInRegister(root, sessionID)) {
    await endChildDispatch(root, sessionID);
    return { settle: false };
  }
  const kind = await sessionKind(session, sessionID, parents);
  if (kind.why) return { settle: false, why: kind.why };
  if (kind.kind === 'child') {
    await endChildDispatch(root, sessionID);
    return { settle: false };
  }
  return { settle: true };
}

/**
 * The process-start sweep: H1's session-boundary step for OpenCode, run once at
 * the first root request of a process (context.mjs). Inside one register lock
 * hold, every non-terminal dispatch-state record becomes terminal
 * {reason: 'session-boundary'}, old tombstones are pruned, and the register and
 * its orphaned staging files are deleted, in H1's order. Returns a line to show
 * the model when the sweep refused or could not take the lock, else ''.
 */
export async function sweepStaleDispatches(root) {
  const transientDir = dirname(registerPath(root));
  try {
    mkdirSync(transientDir, { recursive: true });
    let refused = '';
    await withRegisterLock(
      root,
      () => {
        const sweep = sessionBoundarySweep(root, { now: Date.now() });
        if (sweep.refused) refused = sweep.refused;
        rmSync(registerPath(root), { force: true });
        const registerBasename = basename(registerPath(root));
        for (const f of readdirSync(transientDir)) {
          if (f.startsWith(`${registerBasename}.tmp-`)) rmSync(join(transientDir, f), { force: true });
        }
      },
      { retryMs: 100, timeoutMs: 2000 }
    );
    return refused ? `STERLING DISPATCH SWEEP: ${refused}` : '';
  } catch (e) {
    if (e?.code !== 'register_lock_held') throw e;
    return `STERLING DISPATCH SWEEP SKIPPED: ${render(e)}. Dispatch records a dead OpenCode process left live were not swept, so they can hold the settled snapshot; restart OpenCode to retry the sweep.`;
  }
}

/** Every regular file among `files`, which the round records as its file_entries (H22's regularFileEntries). */
function regularFiles(root, files) {
  const out = [];
  for (const f of files) {
    let st;
    try {
      st = statSync(join(root, f), { throwIfNoEntry: false });
    } catch (e) {
      if (e?.code !== 'ENOTDIR') logLine(root, `dispatch register: could not stat territory entry '${f}' (${e?.code ?? errText(e)}); it keeps the directory prefix match`);
      continue;
    }
    if (st?.isFile()) out.push(f);
  }
  return out;
}

/** H22's Start round for a bound child, written through resolveAndRegisterStart with the files its brief names. */
async function registerRound(root, input, child) {
  // The resolver matches the dispatch-state record, which holds OpenCode's own name; the round holds the role H20 compares.
  const agentType = agentRole(input.input?.agent);
  const { refusal } = await resolveAndRegisterStart(root, { session_id: input.sessionID, agent_id: child, agent_type: input.input?.agent }, (res) => {
    const attributed = res.source === 'post' && typeof res.prompt === 'string';
    const declared = attributed ? parseReviewTerritory(res.prompt) : null;
    const files = attributed ? briefTerritory(res.prompt, root) : [];
    return {
      agent_id: child,
      agent_type: typeof agentType === 'string' && agentType ? agentType : null,
      session_id: input.sessionID,
      files,
      file_entries: regularFiles(root, files),
      files_source: !attributed ? 'unattributable' : declared.present && declared.valid ? 'review-territory' : 'free-prose-fallback',
      attribution: attributed ? 'block' : 'none',
      attribution_case: res.case,
      tool_use_id: typeof res.tool_use_id === 'string' && res.tool_use_id ? res.tool_use_id : null,
      at: new Date().toISOString(),
    };
  });
  if (refusal) logLine(root, `dispatch register: no round was registered for child session ${child}: ${render(refusal)}`);
}

/**
 * execute.before / execute.after for the subagent tool, and noteExecutionEnd(sessionID),
 * which the server calls for every execution end before the settlement gate runs.
 */
export function createDispatchHandlers({ rootOf, fenced, now = () => Date.now() }) {
  // When each in-flight subagent call's Pre ran, and when each session's execution last ended.
  const preAt = new Map();
  const endedAt = new Map();

  function noteExecutionEnd(sessionID) {
    if (typeof sessionID === 'string' && sessionID) remember(endedAt, sessionID, now());
  }

  async function onBefore(input) {
    if (input?.tool !== 'subagent') return;
    const root = rootOf();
    if (!root) return;
    remember(preAt, input.id, now());
    await fenced('dispatch', root, async () => logDisclosures(root, await recordDispatchPre(root, claudeShape(input))));
  }

  async function onAfter(input) {
    if (input?.tool !== 'subagent') return;
    const root = rootOf();
    if (!root) return;
    const pre = preAt.get(input.id);
    preAt.delete(input.id);
    await fenced('dispatch', root, async () => {
      const shape = claudeShape(input);
      if (input.status !== 'completed') {
        logDisclosures(root, await recordDispatchFailure(root, shape));
        return;
      }
      const child = childSessionOf(input);
      if (!child) {
        logLine(root, `dispatch register: subagent call ${input.id} returned no metadata.sessionID, so its child session was not bound`);
        return;
      }
      logDisclosures(root, await recordDispatchPost(root, { ...shape, tool_response: { agentId: child, prompt: shape.tool_input.prompt } }));
      await registerRound(root, input, child);
      const end = { session_id: input.sessionID, agent_id: child };
      if (input.input?.background !== true) {
        logDisclosures(root, await finishDispatchAndRegisterEnd(root, end));
        return;
      }
      const ended = endedAt.get(child);
      if (ended !== undefined && pre !== undefined && ended >= pre) {
        logLine(root, `dispatch register: child session ${child} ended before subagent call ${input.id} returned, so its dispatch is ended at the bind`);
        logDisclosures(root, await finishDispatchAndRegisterEnd(root, end));
      }
    });
  }

  return { onBefore, onAfter, noteExecutionEnd };
}
