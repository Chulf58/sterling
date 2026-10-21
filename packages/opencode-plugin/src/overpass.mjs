// The Overpass toggle on OpenCode (decisions overpass-toggle-work-mode-only-routes-every-lane-through-tiers
// and overpass-toggle-mechanism-dispatch-pin-opencode-json-overlay-loud-open-session-notice,
// points 2, 3, 4 and 8). The resolver is resolveOverpass in packages/schemas; this
// file applies what it says on the three plugin seams:
//   - the dispatch pin: while Overpass is effective, every subagent call's model is
//     the lane model, replacing any model the call named (axis.mjs calls dispatchPin);
//   - the opencode.json overlay: while effective, agent.plan.model is the lane model
//     and, unless the conductor is bypassed, agent["sterling/conductor"].model is the
//     conductor model. A `variant` on those entries is taken out while the tier model
//     is set, because effort comes from the tier member. What was there before is kept
//     in OVERLAY_REL and put back when Overpass stops being effective;
//   - the open-session notice: a conductor or Plan session whose model differs from
//     the one Overpass gives its agent is told, every turn, to pick it in /models or
//     start a new session. Sterling never switches a session's model.
//
// Ownership: OVERLAY_REL (plain JSON, written with fs, never the store) records, per
// agent entry Sterling changed, the model it wrote, the values of `model` and
// `variant` it replaced, and whether the entry existed. Removal touches an entry only
// while its model is still exactly the one Sterling wrote; an entry the user has
// changed since is theirs and is left alone. A change the user makes while Overpass
// is on is kept as the value to put back, so the latest choice returns. A write of
// opencode.json is bracketed by a `pending` record in that file (convergeOverlay), so a
// failed or interrupted write is retried rather than mistaken for a user's edit.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveOverpass } from '@sterling/schemas';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { CONDUCTOR_AGENT, PROJECT_CONFIG_REL, normalizeConfigText, projectConfigText, writeFileAtomic } from '../../../scripts/lib/opencode-install.mjs';
import { remember } from './bounded.mjs';

export const OVERLAY_REL = '.sterling/overpass-overlay.json';
export const PLAN_AGENT = 'plan';
// The entry keys the overlay owns while it is in place: `model` is set, `variant` is taken out.
const OWNED_KEYS = ['model', 'variant'];

/** The project's Overpass resolution on this host. Throws on an unreadable config or an invalid overpass block. */
export function projectOverpass(root) {
  return resolveOverpass(loadConfig(root) ?? {}, { host: 'opencode' });
}

/**
 * The project's Overpass resolution for a subagent dispatch: { res, unreadable }. When
 * .sterling/config.json cannot be read or parsed, or is not a JSON object, `res` is null
 * and `unreadable` is the error: the dispatch goes ahead unrouted with overpassUnknownLine,
 * because a broken config must not stop every dispatch in a project that never turned
 * Overpass on. Throws when the config reads but its overpass block is invalid
 * (resolveOverpass), which refuses the dispatch (overpassRefusal).
 */
export function dispatchOverpass(root) {
  let config;
  try {
    config = loadConfig(root) ?? {};
  } catch (e) {
    return { res: null, unreadable: e };
  }
  if (!isObject(config)) return { res: null, unreadable: new Error('it is not a JSON object') };
  return { res: resolveOverpass(config, { host: 'opencode' }), unreadable: null };
}

/** The loud line a dispatch carries when .sterling/config.json could not be read (`error` from dispatchOverpass). */
export function overpassUnknownLine(error) {
  return `Overpass routing UNKNOWN: .sterling/config.json could not be read (${error?.message ?? error}); dispatches are not routed through Overpass until it is fixed.`;
}

/**
 * The dispatch pin for a subagent call's arguments: { model, line }. `model` is the lane
 * model while Overpass is effective (null otherwise, and the call is left alone); `line`
 * names the model a call asked for when the toggle replaced it, else null.
 */
export function dispatchPin(res, args) {
  if (!res.effective) return { model: null, line: null };
  const asked = args?.model;
  const replaced = typeof asked === 'string' && asked && asked !== res.laneModel;
  return {
    model: res.laneModel,
    line: replaced ? `OVERPASS: this dispatch ran on ${res.laneModel}, not ${asked} as the call named; while Overpass is on every subagent lane takes the tier model (config.overpass).` : null,
  };
}

/** The message a subagent dispatch is refused with when the config reads but its overpass block is invalid (`error` from dispatchOverpass). */
export function overpassRefusal(error) {
  return `Sterling refused this subagent dispatch: the Overpass setting in .sterling/config.json is invalid (${error?.message ?? error}). While it is invalid, a dispatch might run on a direct provider instead of through Overpass, so none runs. Fix that value in .sterling/config.json (TUI System tab), or set "overpass": {"enabled": false} to turn Overpass off, then dispatch again.`;
}

/** The agent entries the overlay should hold: { [agent]: model }. */
export function desiredOverlay(res) {
  const out = {};
  if (!res.effective) return out;
  out[PLAN_AGENT] = res.laneModel;
  if (res.conductorRouted) out[CONDUCTOR_AGENT] = res.conductorModel;
  return out;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `text` written to `path` atomically (writeFileAtomic), its directory created first. `fs` is the writer's test seam. */
function writeText(path, text, fs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, text, fs);
}

function readOwnership(root) {
  const path = join(root, OVERLAY_REL);
  if (!existsSync(path)) return { agent: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${OVERLAY_REL} is not valid JSON (${e.message}); it records which .opencode/opencode.json agent models Sterling wrote for Overpass, so nothing is changed until it is fixed or removed`);
  }
  if (!isObject(parsed) || !isObject(parsed.agent)) throw new Error(`${OVERLAY_REL} is not an object with an "agent" object; nothing is changed until it is fixed or removed`);
  if (parsed.pending !== undefined && !(isObject(parsed.pending) && isObject(parsed.pending.agent) && isObject(parsed.pending.before) && isObject(parsed.pending.after))) {
    throw new Error(`${OVERLAY_REL} has a "pending" value that is not an interrupted-update record; nothing is changed until it is fixed or removed`);
  }
  return parsed;
}

function writeOwnership(root, own, fs) {
  const path = join(root, OVERLAY_REL);
  if (Object.keys(own.agent).length || own.pending) writeText(path, `${JSON.stringify(own, null, 2)}\n`, fs);
  else rmSync(path, { force: true });
}

/** Throws when git tracks .opencode/opencode.json: Sterling writes that file only while it is untracked. */
function refuseTracked(root) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--', PROJECT_CONFIG_REL], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (/not a git repository/i.test(String(e.stderr ?? ''))) return;
    throw new Error(`could not check whether git tracks ${PROJECT_CONFIG_REL} (${String(e.stderr || e.message).trim()})`);
  }
  if (out.trim()) throw new Error(`${PROJECT_CONFIG_REL} is tracked by git, and Sterling writes it only while it is untracked (decision sterling-on-opencode-installs-global-plugins-plus-untracked-project-config), so the Overpass agent models were not changed; untrack it (git rm --cached ${PROJECT_CONFIG_REL} and commit)`);
}

const pick = (entry, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(entry, k)).map((k) => [k, entry[k]]));
// The owned fields of an agent entry, in a fixed key order, as text; an absent entry is null.
// Only these decide whether a pending write landed: another key the user edits, or the
// order JSON keeps keys in, says nothing about Sterling's write.
const ownedText = (entry) => JSON.stringify(entry === undefined || entry === null ? null : pick(entry, OWNED_KEYS));
const modelText = (entry) => JSON.stringify(entry === undefined || entry === null ? null : [Object.hasOwn(entry, 'model'), entry.model ?? null]);

/**
 * Whether a pending write of `name` landed, judged on the owned fields only: the entry
 * holds the `model` and `variant` the write meant to leave, or it holds the model the
 * write set when that model differed from the one before (so a `variant` the user added
 * afterwards does not hide a landed write).
 */
function landed(entry, before, after) {
  if (ownedText(entry) === ownedText(after)) return true;
  return modelText(after) !== modelText(before) && modelText(entry) === modelText(after);
}

/**
 * Settles an update a failed or interrupted write left pending: per agent it names, the
 * ownership it intended is taken when opencode.json shows the write landed (landed),
 * else the ownership from before stays (the write did not land, so the update is
 * computed again from the old record, never from a half-done one). Either way the
 * record kept carries the values to put back, until a later write replaces it.
 */
function settlePending(own, agents) {
  if (!own.pending) return { own, settled: false };
  const { pending } = own;
  const agent = { ...own.agent };
  for (const name of Object.keys(pending.after)) {
    if (!landed(agents[name], pending.before[name], pending.after[name])) continue;
    if (Object.hasOwn(pending.agent, name)) agent[name] = pending.agent[name];
    else delete agent[name];
  }
  return { own: { agent }, settled: true };
}

/**
 * Brings .opencode/opencode.json's Sterling-owned agent entries in line with `res`.
 * Writes nothing when nothing changes. Returns { changed, notes }: `notes` names an entry
 * whose ownership was dropped because the user changed or removed it. Throws on an
 * unreadable opencode.json or ownership file, a tracked opencode.json that needs a write,
 * or a failed write. `fs` ({ writeFile, rename }) is writeFileAtomic's test seam.
 *
 * A change to opencode.json is committed in three steps: the ownership file first gets a
 * `pending` record (the entries before, the entries after, the ownership after), then
 * opencode.json is written, then the ownership file is written without `pending`. A
 * failure anywhere leaves the pending record, which the next call settles first
 * (settlePending), so a lost write is retried and never read as a user's edit.
 */
export function convergeOverlay(root, res, { fs } = {}) {
  const want = desiredOverlay(res);
  const stored = readOwnership(root);
  if (!Object.keys(want).length && !Object.keys(stored.agent).length && !stored.pending) return { changed: false, notes: [] };
  const path = join(root, PROJECT_CONFIG_REL);
  let config = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(normalizeConfigText(readFileSync(path, 'utf8')));
    } catch (e) {
      throw new Error(`${PROJECT_CONFIG_REL} is not valid JSON (${e.message}), so the Overpass agent models were not changed`);
    }
    if (!isObject(config)) throw new Error(`${PROJECT_CONFIG_REL} is not a JSON object, so the Overpass agent models were not changed`);
  }
  if (config.agent !== undefined && !isObject(config.agent)) throw new Error(`${PROJECT_CONFIG_REL}: "agent" is not an object, so the Overpass agent models were not changed`);
  const agents = { ...(config.agent ?? {}) };
  const { own: settledOwn, settled } = settlePending(stored, agents);
  const own = { agent: { ...settledOwn.agent } };
  const names = new Set([...Object.keys(want), ...Object.keys(own.agent)]);
  let ownChanged = settled;
  const before = {};
  const after = {};
  const notes = [];
  const touch = (name, entry) => {
    if (!Object.hasOwn(before, name)) before[name] = agents[name] === undefined ? null : agents[name];
    if (entry === undefined) delete agents[name];
    else agents[name] = entry;
    after[name] = entry === undefined ? null : entry;
  };
  for (const name of [...names].sort()) {
    const model = want[name];
    const rec = own.agent[name];
    const entry = agents[name];
    if (entry !== undefined && !isObject(entry)) throw new Error(`${PROJECT_CONFIG_REL}: "agent.${name}" is not an object, so the Overpass agent models were not changed`);
    if (model) {
      const cur = entry ?? {};
      let next = rec;
      if (!next) next = { created: entry === undefined, prior: pick(cur, OWNED_KEYS) };
      else {
        // Changed by hand while Overpass was on: that value is the one to put back.
        const prior = { ...next.prior };
        if (cur.model !== next.wrote) {
          if (Object.hasOwn(cur, 'model')) prior.model = cur.model;
          else delete prior.model;
        }
        if (Object.hasOwn(cur, 'variant')) prior.variant = cur.variant;
        next = { ...next, prior };
      }
      next = { ...next, wrote: model };
      if (JSON.stringify(next) !== JSON.stringify(rec)) {
        own.agent[name] = next;
        ownChanged = true;
      }
      if (cur.model !== model || Object.hasOwn(cur, 'variant') || entry === undefined) {
        const updated = { ...cur, model };
        delete updated.variant;
        touch(name, updated);
      }
      continue;
    }
    // Not wanted: undo what Sterling wrote, and only that.
    delete own.agent[name];
    ownChanged = true;
    if (entry === undefined) {
      notes.push(`agent.${name} was removed by hand, so there was nothing to undo`);
      continue;
    }
    if (entry.model !== rec.wrote) {
      notes.push(`agent.${name}.model is ${JSON.stringify(entry.model)}, not the ${rec.wrote} Sterling wrote, so it is yours and stays`);
      continue;
    }
    const restored = { ...entry };
    delete restored.model;
    if (Object.hasOwn(rec.prior ?? {}, 'model')) restored.model = rec.prior.model;
    if (Object.hasOwn(rec.prior ?? {}, 'variant') && !Object.hasOwn(restored, 'variant')) restored.variant = rec.prior.variant;
    touch(name, rec.created && !Object.keys(restored).length ? undefined : restored);
  }
  const changed = Object.keys(after).length > 0;
  if (!changed) {
    if (ownChanged) writeOwnership(root, own, fs);
    return { changed: false, notes };
  }
  refuseTracked(root);
  if (Object.keys(agents).length || config.agent !== undefined) config.agent = agents;
  writeOwnership(root, { agent: settledOwn.agent, pending: { before, after, agent: own.agent } }, fs);
  writeText(path, projectConfigText(config), fs);
  writeOwnership(root, own, fs);
  return { changed, notes };
}

/** The model Overpass gives `agent`'s sessions, or null when it gives that agent none. */
export function expectedSessionModel(res, agent) {
  if (!res.effective) return null;
  if (agent === CONDUCTOR_AGENT) return res.conductorRouted ? res.conductorModel : null;
  if (agent === PLAN_AGENT) return res.laneModel;
  return null;
}

/** The loud notice for a conductor or Plan session running on another model, or ''. */
export function mismatchNotice(res, agent, model) {
  const expected = expectedSessionModel(res, agent);
  if (!expected || !model || model === expected) return '';
  return `STERLING OVERPASS: Overpass is ON but this session runs on ${model}: pick ${expected} in /models or start a new session. Sterling does not switch an open session's model.`;
}

/**
 * Per-session agent and model, as the plugin sees them: the model from each
 * session.step.started event ({ providerID, id }, as pressure.mjs reads it) and the agent
 * from that event's `agent` or the context hook's input.agent. Bounded (bounded.mjs).
 */
export function createSessionModels() {
  const sessions = new Map();
  const stateOf = (id) => sessions.get(id) ?? remember(sessions, id, { agent: null, model: null });
  return {
    noteAgent(sessionID, agent) {
      if (typeof sessionID === 'string' && sessionID && typeof agent === 'string' && agent) stateOf(sessionID).agent = agent;
    },
    onEvent(ev) {
      if (ev?.type !== 'session.step.started') return;
      const { sessionID, model, agent } = ev.data ?? {};
      if (typeof sessionID !== 'string' || !sessionID) return;
      const s = stateOf(sessionID);
      if (typeof agent === 'string' && agent) s.agent = agent;
      if (model && typeof model.id === 'string' && model.id) s.model = typeof model.providerID === 'string' && model.providerID ? `${model.providerID}/${model.id}` : model.id;
    },
    get: (sessionID) => sessions.get(sessionID) ?? null,
  };
}
