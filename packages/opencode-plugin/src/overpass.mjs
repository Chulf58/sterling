// The Overpass toggle on OpenCode (decisions overpass-toggle-work-mode-only-routes-every-lane-through-tiers
// and overpass-toggle-mechanism-dispatch-pin-opencode-json-overlay-loud-open-session-notice,
// points 2, 3, 4 and 8). The resolver is resolveOverpass in packages/schemas; this
// file applies what it says on these plugin seams:
//   - the dispatch pin: while Overpass is effective, every subagent call's model is
//     its role's lane model (config.overpass.roles tier, else the lane model), replacing
//     any model the call named (axis.mjs calls dispatchPin);
//   - the request effort: while effective, a request of a role with an effort set, on
//     exactly that role's lane model, carries it as options.reasoningEffort (requestEffort,
//     set from server.mjs's context hook); inside the maintenance worker's child the
//     effort its launch passed in the environment applies instead (workerRequestEffort);
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
// failed or interrupted write is retried rather than mistaken for a user's edit; how
// that record is settled, and what it cannot tell apart, is the invariant at settlePending.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OVERPASS_EFFORTS, OverpassUnknownRoleError, resolveOverpass } from '@sterling/schemas';
import { WORKER_EFFORT_ENV, WORKER_EFFORT_MODEL_ENV } from '../../../scripts/hooks/lib/maintenance-worker-opencode.mjs';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { CONDUCTOR_AGENT, PROJECT_CONFIG_REL, normalizeConfigText, projectConfigText, sterlingRootFrom, writeFileAtomic } from '../../../scripts/lib/opencode-install.mjs';
import { readCopyVersion } from '../../../scripts/lib/sterling-roots.mjs';
import { agentRole } from './agent-name.mjs';
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
  // `config` is the raw object read, for the model resolver that runs while Overpass is not effective (dispatch-model.mjs).
  return { res: resolveOverpass(config, { host: 'opencode' }), unreadable: null, config };
}

/** The loud line a dispatch carries when .sterling/config.json could not be read (`error` from dispatchOverpass). */
export function overpassUnknownLine(error) {
  return `Overpass routing UNKNOWN: .sterling/config.json could not be read (${error?.message ?? error}); dispatches are not routed through Overpass until it is fixed.`;
}

// A brief line that opts one dispatch out of the tier (decision
// overpass-per-dispatch-bypass-a-brief-line-overpass-bypass-re). Only a line that starts
// with the marker counts, so a brief that merely quotes it mid-sentence does not bypass,
// and a line inside a fenced code block (``` or ~~~, any info string, an unclosed fence
// running to the end) is quoted text, not a marker.
const BYPASS_LINE = /^[ \t]*OVERPASS-BYPASS:(.*)$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The text after the marker on every unfenced brief line that `lineRe` matches (its first
 * group, trimmed), in order. A line inside a fenced code block is quoted text and never
 * counts. Shared by the OVERPASS-BYPASS and MODEL-INTENT markers (dispatch-model.mjs).
 */
export function unfencedMarkers(prompt, lineRe) {
  if (typeof prompt !== 'string') return [];
  let fence = null;
  const found = [];
  for (const line of prompt.split(/\r?\n/)) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      continue;
    }
    const m = lineRe.exec(line);
    if (m) found.push(m[1].trim());
  }
  return found;
}

/**
 * The OVERPASS-BYPASS marker in a brief: null when no unfenced line carries one, else
 * { reason }. The reason is the first marker's, trimmed; it is empty when ANY unfenced
 * marker line has no reason, so a valid first marker cannot hide an empty second one.
 */
export function bypassMarker(prompt) {
  const reasons = unfencedMarkers(prompt, BYPASS_LINE);
  if (!reasons.length) return null;
  return { reason: reasons.every(Boolean) ? reasons[0] : '' };
}

/** The message a dispatch is refused with when its OVERPASS-BYPASS marker cannot be honoured (`why` names the defect). */
export function bypassRefusal(why) {
  return `Sterling refused this subagent dispatch: its brief carries an OVERPASS-BYPASS line but ${why}. A bypass must name the model the call should run on (the call's \`model\`) and say why on the marker line, as "OVERPASS-BYPASS: <reason>". Fix the dispatch and send it again, or drop the line to run on the Overpass tier.`;
}

/**
 * The dispatch pin for a subagent call's arguments: { model, line, notice? }. `model` is the
 * lane model while Overpass is effective (null otherwise, and the call is left alone); `line`
 * names the model a call asked for when the toggle replaced it, else null. A brief with an
 * OVERPASS-BYPASS marker keeps the call's own model (`model` null, `line` and `notice` say
 * so); the marker with no model on the call or an empty reason throws, which refuses the
 * dispatch. Without Overpass in effect the marker means nothing and is ignored.
 */
export function dispatchPin(res, args) {
  if (!res.effective) return { model: null, line: null };
  const lane = laneRoute(res, args?.agent).model;
  const marker = bypassMarker(args?.prompt);
  if (marker) {
    const named = args?.model;
    if (typeof named !== 'string' || !named) throw new Error(bypassRefusal('the call names no model'));
    if (!marker.reason) throw new Error(bypassRefusal('the marker gives no reason'));
    return {
      model: null,
      line: `OVERPASS-BYPASS: Overpass bypassed for this dispatch: it was sent to ${named} instead of ${lane} (reason: ${marker.reason}).`,
      notice: `Sterling Overpass: Overpass bypassed for a subagent dispatch: it was sent to ${named} instead of ${lane} (reason: ${marker.reason}).`,
    };
  }
  const asked = args?.model;
  const replaced = typeof asked === 'string' && asked && asked !== lane;
  return {
    model: lane,
    line: replaced ? `OVERPASS: this dispatch ran on ${lane}, not ${asked} as the call named; while Overpass is on every subagent lane takes the tier model (config.overpass).` : null,
  };
}

/**
 * The Overpass route of a subagent `agent` (an OpenCode agent name): { model, effort? }.
 * A Sterling role (agentRole) takes its config.overpass.roles entry; any other agent
 * takes the default lane model with no effort.
 */
export function laneRoute(res, agent) {
  const role = agentRole(agent);
  return (typeof role === 'string' && Object.hasOwn(res.roles ?? {}, role) && res.roles[role]) || { model: res.laneModel };
}

/**
 * The client reasoning effort for one model request of `agent` on `model` (the context
 * hook's Model.Ref, { providerID, id }), or null to leave the request alone. Set only
 * while Overpass is effective, the request's session is known to come from a dispatch
 * that was not bypassed (`dispatched`, from createLaneDispatches().dispatchOf; null when
 * that cannot be told), the agent maps to a role with an effort set, and the request runs
 * on exactly that role's lane model. A bypassed dispatch is never touched, even one that
 * named the role's own lane model, and neither is any other model.
 */
export function requestEffort(res, agent, model, dispatched) {
  if (!res?.effective) return null;
  if (!dispatched || dispatched.bypassed !== false) return null;
  const role = agentRole(agent);
  if (typeof role !== 'string' || !Object.hasOwn(res.roles ?? {}, role)) return null;
  const route = res.roles[role];
  if (!route?.effort) return null;
  if (!model || typeof model.providerID !== 'string' || typeof model.id !== 'string') return null;
  return `${model.providerID}/${model.id}` === route.model ? route.effort : null;
}

/**
 * The client reasoning effort for one model request inside the maintenance worker's
 * `opencode run` child, or null. The worker launch decides the effort (the Overpass
 * maintenance-worker role's, or the one pinned for a chained run) and passes it with its
 * model in the child's environment (maintenance-worker-opencode.mjs opencodeEnv). Like
 * requestEffort, it applies only to a request on exactly that model, and only a known
 * effort level is sent.
 */
export function workerRequestEffort(env, model) {
  const effort = env?.[WORKER_EFFORT_ENV];
  const routeModel = env?.[WORKER_EFFORT_MODEL_ENV];
  if (typeof effort !== 'string' || !OVERPASS_EFFORTS.includes(effort) || typeof routeModel !== 'string' || !routeModel) return null;
  if (!model || typeof model.providerID !== 'string' || typeof model.id !== 'string') return null;
  return `${model.providerID}/${model.id}` === routeModel ? effort : null;
}

/**
 * Which subagent dispatch each child session came from, so a request in the child knows
 * whether its dispatch was bypassed. In memory and bounded (bounded.mjs).
 *
 * The link, as OpenCode 2.1.2's subagent tool makes it: execute.before gives the call id,
 * the parent session and the arguments; the tool then creates the child session with
 * parentID set to the parent and reports `progress({ sessionID: child, status: 'running' })`
 * BEFORE it prompts the child, which reaches plugins as a session.tool.progress event
 * ({ sessionID: parent, id: call id, metadata: { sessionID: child } }); the completed call's
 * result carries the same metadata.sessionID (execute.after). Either links child to call.
 *
 * A dispatch is keyed by (parent session, call id), since call ids are only unique within
 * a session. dispatchOf answers only for a child positively linked to its own recorded
 * dispatch whose parent equals the child's actual parent. Anything else (not linked yet,
 * evicted by the bound, recorded before a restart, a parent mismatch) is unknown, and
 * unknown sends no effort: a child's first requests before its link arrives go without.
 */
export function createLaneDispatches() {
  const calls = new Map();
  const children = new Map();
  const keyOf = (parent, callID) => (typeof parent === 'string' && parent && typeof callID === 'string' && callID ? JSON.stringify([parent, callID]) : null);
  /** Links call `callID` of `parentSessionID` to `child`; a call already linked to another child keeps it. */
  const linkChild = (parentSessionID, callID, child) => {
    const key = keyOf(parentSessionID, callID);
    const call = key && calls.get(key);
    if (!call || typeof child !== 'string' || !child || (call.child && call.child !== child)) return;
    call.child = child;
    remember(children, child, key);
  };
  return {
    /** A subagent call that passed the dispatch pin: execute.before's sessionID, id and arguments. */
    noteDispatch(parentSessionID, callID, args) {
      const key = keyOf(parentSessionID, callID);
      if (key) remember(calls, key, { parent: parentSessionID, role: agentRole(args?.agent), bypassed: bypassMarker(args?.prompt) !== null, child: null });
    },
    linkChild,
    /** A call that ended: linked to `child` when its result names one, else its record is dropped. */
    endCall(parentSessionID, callID, child) {
      if (child) return linkChild(parentSessionID, callID, child);
      const key = keyOf(parentSessionID, callID);
      if (key && calls.get(key)?.child === null) calls.delete(key);
    },
    onEvent(ev) {
      if (ev?.type === 'session.tool.progress') linkChild(ev.data?.sessionID, ev.data?.id, ev.data?.metadata?.sessionID);
    },
    /** { bypassed } for child session `sessionID` of agent `agent`, whose actual parent is `parentID`; null when unknown. */
    dispatchOf(sessionID, parentID, agent) {
      const call = calls.get(children.get(sessionID));
      if (!call || call.child !== sessionID || typeof parentID !== 'string' || call.parent !== parentID || call.role !== agentRole(agent)) return null;
      return { bypassed: call.bypassed };
    },
  };
}

/** This plugin's own Sterling version, from its copy's package.json; 'unknown (<why>)' when it cannot be read. */
export function pluginVersion(moduleUrl = import.meta.url) {
  try {
    const v = readCopyVersion(sterlingRootFrom(moduleUrl), 'opencode');
    return v.version ?? `unknown (${v.reason})`;
  } catch (e) {
    return `unknown (${e?.message ?? e})`;
  }
}

/**
 * The message a subagent dispatch is refused with when the config reads but its overpass
 * block is invalid (`error` from dispatchOverpass). An unknown role key was most likely
 * written by a newer Sterling than this plugin (GitHub #202), so that message names this
 * plugin's version (`version`, default pluginVersion()) and the update that teaches it the role.
 */
export function overpassRefusal(error, { version } = {}) {
  const head = `Sterling refused this subagent dispatch: the Overpass setting in .sterling/config.json is invalid (${error?.message ?? error}).`;
  const tail = 'While it is invalid, a dispatch might run on a direct provider instead of through Overpass, so none runs.';
  if (error instanceof OverpassUnknownRoleError) {
    return `${head} This Sterling plugin is version ${version ?? pluginVersion()} and does not know the role ${JSON.stringify(error.role)}; a newer Sterling most likely wrote it. Run \`opencode plugin update\`, then /reload, so the plugin knows that role. ${tail} Or remove that role from overpass.roles, or set "overpass": {"enabled": false} to turn Overpass off, then dispatch again.`;
  }
  return `${head} ${tail} Fix that value in .sterling/config.json (TUI System tab), or set "overpass": {"enabled": false} to turn Overpass off, then dispatch again.`;
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
  // `pending.notes` (recovery notes not yet delivered) is absent in records written before it existed.
  if (parsed.pending?.notes !== undefined && !(Array.isArray(parsed.pending.notes) && parsed.pending.notes.every((n) => typeof n === 'string'))) {
    throw new Error(`${OVERLAY_REL} has "pending.notes" that is not a list of notes; nothing is changed until it is fixed or removed`);
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
const sameOwned = (a, b) => ownedText(a) === ownedText(b);
const describeOwned = (fields) => (Object.hasOwn(fields ?? {}, 'model') ? `model ${JSON.stringify(fields.model)}` : 'no model') + (Object.hasOwn(fields ?? {}, 'variant') ? `, variant ${JSON.stringify(fields.variant)}` : ', no variant');

// Recovery of an interrupted overlay write (settlePending). INVARIANT: a pending record
// holds, per agent entry the write touched, the entry before it, the entry it meant to
// leave and the ownership to take if it landed. Settling decides per entry, from the
// owned fields (model, variant) of the entry as it is now: when they are exactly what
// they were before the write, the write did not land and the old ownership stands;
// otherwise it is taken as landed and the pending ownership applies. Sterling later
// undoes a model only while it equals the `wrote` of the ownership that stands, so an
// entry whose owned fields changed after an unconfirmed write is undone only where its
// model is the very one that write set; any other model there is the user's and stays.
// When that leaves a model the old ownership would have undone, a note names the values
// from before Overpass, so the user can put them back and nothing is dropped silently.
// Such a note is kept in the next pending record (`pending.notes`) until a convergence
// completes and returns it, so a later failed write cannot lose it.
// NOT GUARANTEED: the owned fields alone cannot tell a write that never landed from one
// that landed and was then set back by hand to exactly the old model and variant. That
// case is decided, by ruling, as not landed: turning Overpass off then restores the
// pre-Overpass model and variant, so that hand edit is undone, because the other reading
// would leave a write that really failed on the gateway tier after Overpass is off. Nor
// can they tell a hand edit to exactly the model the write meant to set (read as
// landed). And when the write did not land and the user then changed only the variant
// of a tier entry, the tier model stays with the note instead of being undone, because
// that state is the same as the user choosing the tier again.
/**
 * Settles an update a failed or interrupted write left pending (see the invariant
 * above). Returns { own, settled, notes }: `own` without `pending`, and the recovery
 * notes not yet delivered: those the pending record carried, then one for each entry
 * left to the user that the old ownership would have undone.
 */
function settlePending(own, agents) {
  if (!own.pending) return { own, settled: false, notes: [] };
  const { pending } = own;
  const agent = { ...own.agent };
  const notes = [...(pending.notes ?? [])];
  for (const name of Object.keys(pending.after)) {
    const entry = agents[name];
    if (sameOwned(entry, pending.before[name])) continue;
    const old = agent[name];
    const next = Object.hasOwn(pending.agent, name) ? pending.agent[name] : undefined;
    if (next) agent[name] = next;
    else delete agent[name];
    if (sameOwned(entry, pending.after[name]) || !old || !isObject(entry) || entry.model !== old.wrote || next?.wrote === entry.model) continue;
    notes.push(`agent.${name} had its model or variant changed by hand while a Sterling update of it was unconfirmed, so its model ${JSON.stringify(entry.model)} is taken as yours and stays; before Overpass it had ${describeOwned(old.prior)}`);
  }
  return { own: { agent }, settled: true, notes };
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
  const { own: settledOwn, settled, notes: recoveryNotes } = settlePending(stored, agents);
  const notes = [...recoveryNotes];
  const own = { agent: { ...settledOwn.agent } };
  const names = new Set([...Object.keys(want), ...Object.keys(own.agent)]);
  let ownChanged = settled;
  const before = {};
  const after = {};
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
  // Recovery notes ride in the pending record until this write completes, so a failure below cannot lose them.
  writeOwnership(root, { agent: settledOwn.agent, pending: { before, after, agent: own.agent, ...(recoveryNotes.length ? { notes: recoveryNotes } : {}) } }, fs);
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
