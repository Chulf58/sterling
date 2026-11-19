// Overpass tiers and the conductor and Plan models on OpenCode. Since the settings redesign
// (decisions overpass-tiers-are-ordinary-model-choices-in-each-agent-s-pi and
// settings-redesign-build-shape-one-legacy-to-canonical-config) there is no Overpass switch: an
// agent whose one model in config.models is overpass/<tier> runs on <provider>/<tier>, mapped
// through config.overpass.provider (dispatch-model.mjs projectRouting reads the config through
// the legacy-to-canonical transform). This file applies that on these plugin seams:
//   - the resolution (overpassResolution): which agents run on a tier, and the conductor's
//     and Plan's own selections (models.conductor, models.plan);
//   - the request effort: a request of a role on a tier with an effort set, on exactly that
//     role's tier model, carries it as options.reasoningEffort (requestEffort, set from
//     server.mjs's context hook); inside the maintenance worker's child the effort its launch
//     passed in the environment applies instead (workerRequestEffort);
//   - the opencode.json overlay: agent.plan.model is models.plan and
//     agent["sterling/conductor"].model is models.conductor, each only when selected. A
//     model's effort is written as the entry's `variant`, except on a tier, whose effort is
//     not an OpenCode variant (the variant is then taken out). What was there before is
//     kept in OVERLAY_REL and put back when the selection goes;
//   - the open-session notice: a conductor or Plan session whose model differs from its
//     selection is told, every turn, to pick it in /models or start a new session. Sterling
//     never switches a session's model.
//
// Ownership: OVERLAY_REL (plain JSON, written with fs, never the store) records, per
// agent entry Sterling changed, the model (and any variant) it wrote, the values of `model`
// and `variant` it replaced, and whether the entry existed. A record written before
// variants were written has no `wroteVariant`: Sterling wrote no variant there.
// Removal touches an entry only while its model is still exactly the one Sterling wrote; an entry the user has
// changed since is theirs and is left alone. A change the user makes while Overpass
// is on is kept as the value to put back, so the latest choice returns. A write of
// opencode.json is bracketed by a `pending` record in that file (convergeOverlay), so a
// failed or interrupted write is retried rather than mistaken for a user's edit; how
// that record is settled, and what it cannot tell apart, is the invariant at settlePending.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONDUCTOR_MODEL_KEY, MAINTENANCE_WORKER_ROLE, OVERPASS_EFFORTS, OverpassUnknownRoleError, PLAN_MODEL_KEY } from '@sterling/schemas';
import { WORKER_EFFORT_ENV, WORKER_EFFORT_MODEL_ENV } from '../../../scripts/hooks/lib/maintenance-worker-opencode.mjs';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { CONDUCTOR_AGENT, PROJECT_CONFIG_REL, normalizeConfigText, projectConfigText, sterlingRootFrom, writeFileAtomic } from '../../../scripts/lib/opencode-install.mjs';
import { readCopyVersion } from '../../../scripts/lib/sterling-roots.mjs';
import { agentRole } from './agent-name.mjs';
import { projectRouting } from './dispatch-model.mjs';
import { remember } from './bounded.mjs';

export const OVERLAY_REL = '.sterling/overpass-overlay.json';
export const PLAN_AGENT = 'plan';
// The entry keys the overlay owns while it is in place: `model` is set, `variant` is taken out.
const OWNED_KEYS = ['model', 'variant'];

/**
 * What the canonical models give Overpass and the overlay, from projectRouting's `routing`:
 * { provider, effective, roles, plan, conductor, routing }. `roles` holds each agent on a tier
 * (other than the conductor and Plan): { model: <provider>/<tier>, effort? }. `plan` and
 * `conductor` are their own selections, { model, tier, variant? } (variant = effort, never on a
 * tier), or null when none is made. `effective` is true when any agent runs on a tier. A role with
 * an unresolved two-model conflict or an invalid entry is in none of them.
 */
export function overpassResolution(routing) {
  const usable = (key) => {
    const e = routing.entries[key];
    return e && !e.problem && !routing.conflicts.has(key) ? e : null;
  };
  const roles = {};
  for (const key of Object.keys(routing.entries)) {
    if (key === PLAN_MODEL_KEY || key === CONDUCTOR_MODEL_KEY) continue;
    const e = usable(key);
    if (e?.tier) roles[key] = { model: e.model, ...(e.effort ? { effort: e.effort } : {}) };
  }
  const selection = (key) => {
    const e = usable(key);
    return e ? { model: e.model, tier: e.tier, ...(e.effort && !e.tier ? { variant: e.effort } : {}) } : null;
  };
  const plan = selection(PLAN_MODEL_KEY);
  const conductor = selection(CONDUCTOR_MODEL_KEY);
  const effective = Object.keys(roles).length > 0 || plan?.tier === true || conductor?.tier === true;
  return { provider: routing.provider, effective, roles, plan, conductor, routing };
}

/** The project's resolution on this host (overpassResolution). Throws on an unreadable config or a value the transform cannot carry. */
export function projectOverpass(root) {
  return overpassResolution(projectRouting(loadConfig(root) ?? {}));
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
  // `routing` is what dispatch-model.mjs resolves each dispatch from.
  const routing = projectRouting(config);
  return { res: overpassResolution(routing), unreadable: null, routing };
}

/** The loud line a dispatch carries when .sterling/config.json could not be read (`error` from dispatchOverpass). */
export function overpassUnknownLine(error) {
  return `Model routing UNKNOWN: .sterling/config.json could not be read (${error?.message ?? error}); dispatches get no model from config.models, Overpass tiers included, until it is fixed.`;
}

// The availability check (GitHub #257, #258, #281; user-ruled 2026-11-17 "Check and refuse
// loudly"). INVARIANT: a routed tier model `<provider>/<tier>` (an agent whose model is overpass/<tier>)
// counts as available only when OpenCode's model list (ctx.model.list(), read at the moment
// of the check) has an entry with that providerID and that id. A route the list lacks is
// MISSING: a dispatch to it is refused before it starts, a worker launch on it is skipped,
// and the session is told; nothing is moved to a direct provider (decision
// overpass-toggle-mechanism-dispatch-pin-opencode-json-overlay-loud-open-session-notice).
// A list that times out, fails, is not a list or holds no model at all is UNKNOWN (an
// empty list is one OpenCode has not filled yet: the session that asks runs on a model),
// and UNKNOWN never refuses: the dispatch goes to its tier unchecked and says so. Nothing
// is remembered between checks, so a route that loads is allowed at the next check.
// NOT GUARANTEED: a listed model can still fail at request time (a key rejected after the
// list was filled, a gateway outage), and OpenCode then reports it as before. The
// maintenance worker's child disables the project's OpenCode config, so a provider defined
// only there is listed for the parent but not loaded in the child; the parent's list is
// the only one checked. A list read before the gateway plugin has registered its provider
// reads as missing for that one check; the next check reads it again.

/**
 * OpenCode's model list for the availability check: { state: 'listed', providers } (a Map
 * of providerID to the Set of its model ids) or { state: 'unknown', why }. `list` and
 * `error` are boundedModelList's result, the list already through modelListItems.
 */
export function readInventory({ list, error } = {}) {
  if (error) return { state: 'unknown', why: `OpenCode's model list could not be read (${error?.message ?? error})` };
  if (!Array.isArray(list)) return { state: 'unknown', why: "OpenCode's model list could not be read (it is not a list)" };
  const providers = new Map();
  for (const m of list) {
    if (typeof m?.providerID !== 'string' || !m.providerID) continue;
    const ids = [m.id, m.modelID].filter((v) => typeof v === 'string' && v);
    if (!ids.length) continue;
    if (!providers.has(m.providerID)) providers.set(m.providerID, new Set());
    for (const id of ids) providers.get(m.providerID).add(id);
  }
  if (!providers.size) return { state: 'unknown', why: "OpenCode's model list lists no model at all, so OpenCode has not filled it yet" };
  return { state: 'listed', providers };
}

/** Whether route `ref` (`<provider>/<tier>`) is in inventory `inv` (readInventory): { state: 'available' | 'missing' | 'unknown', why? }. */
export function routeAvailability(inv, ref) {
  if (inv?.state !== 'listed') return { state: 'unknown', why: inv?.why ?? 'no model list was read' };
  const slash = ref.indexOf('/');
  const provider = ref.slice(0, slash);
  const tier = ref.slice(slash + 1);
  const ids = inv.providers.get(provider);
  if (!ids) return { state: 'missing', why: `OpenCode lists no model from the provider '${provider}' (it is not loaded, or its gateway rejected the credential and dropped its models)` };
  if (!ids.has(tier)) return { state: 'missing', why: `the provider '${provider}' is loaded, but OpenCode lists no tier '${tier}' on it (it lists ${[...ids].sort().join(', ')})` };
  return { state: 'available' };
}

/** The fix steps for a missing route. */
export function missingRouteRemedy(provider) {
  return `To fix: check the ${provider} credential (the gateway drops its models when it rejects the key), then run /reload in the TUI (or \`opencode reload\`) so OpenCode loads the provider again; or choose another model for that agent in config.models (TUI System tab).`;
}

/** The message a dispatch to a missing route is refused with. */
export function missingRouteRefusal(res, agent, model, why) {
  return `Sterling refused this subagent dispatch: the Overpass route ${model} for ${agent || 'this agent'} is not available: ${why}. Nothing was sent, and the dispatch is not moved to a direct provider. ${missingRouteRemedy(res.provider)} Then dispatch again.`;
}

/** The line a dispatch carries when the availability of its route is UNKNOWN. */
export function unknownRouteLine(model, why) {
  return `OVERPASS: Overpass availability UNKNOWN: ${why}; this dispatch was sent to ${model} unchecked, and OpenCode reports it if that model is not loaded.`;
}

/** Each distinct tier model an agent runs on, with who runs on it: [{ model, users }]. */
export function overpassRoutes(res) {
  const byModel = new Map();
  const add = (model, user) => {
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push(user);
  };
  if (res.conductor?.tier) add(res.conductor.model, 'the conductor');
  for (const [role, route] of Object.entries(res.roles ?? {})) add(route.model, role === MAINTENANCE_WORKER_ROLE ? 'the maintenance worker' : role);
  if (res.plan?.tier) add(res.plan.model, 'Plan');
  return [...byModel].map(([model, users]) => ({ model, users }));
}

/** The session line for inventory `inv` while Overpass is effective: '' when every route is available. */
export function availabilityLine(res, inv) {
  if (!res?.effective) return '';
  if (inv?.state !== 'listed') {
    return `STERLING OVERPASS: Overpass ON, availability UNKNOWN: ${inv?.why ?? 'no model list was read'}, so whether the routed tier models are loaded is not known. Dispatches still go to their tier models unchecked (OpenCode reports one that is not loaded); this is checked again at the next prompt and dispatch.`;
  }
  const missing = overpassRoutes(res)
    .map((r) => ({ ...r, ...routeAvailability(inv, r.model) }))
    .filter((r) => r.state === 'missing');
  if (!missing.length) return '';
  return `STERLING OVERPASS: Overpass ON but not available: ${missing.map((r) => `${r.model} (${r.users.join(', ')}): ${r.why}`).join('; ')}. A subagent dispatch to a missing route is refused before it starts and the maintenance worker does not launch on one; nothing falls back to a direct provider. ${missingRouteRemedy(res.provider)}`;
}

/** The session line once every route is available again after a missing or UNKNOWN line. */
export function availableAgainLine(res) {
  return `STERLING OVERPASS: Overpass is available again: every routed tier model is loaded (${overpassRoutes(res).map((r) => r.model).join(', ')}).`;
}

/**
 * The client reasoning effort for one model request of `agent` on `model` (the context
 * hook's Model.Ref, { providerID, id }), or null to leave the request alone. Set only
 * when the request's session is known to come from a dispatch (`dispatched`, from
 * createLaneDispatches().dispatchOf; null when that cannot be told), the agent maps to a role
 * on an Overpass tier with an effort set, and the request runs on exactly that role's tier
 * model. Any other model, a call's own named one included, is never touched.
 */
export function requestEffort(res, agent, model, dispatched) {
  if (!res?.effective) return null;
  if (!dispatched) return null;
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
 * Which subagent dispatch each child session came from, so a request in the child is known
 * to be a dispatched lane's. In memory and bounded (bounded.mjs).
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
      if (key) remember(calls, key, { parent: parentSessionID, role: agentRole(args?.agent), child: null });
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
    /** { role } for child session `sessionID` of agent `agent`, whose actual parent is `parentID`; null when unknown. */
    dispatchOf(sessionID, parentID, agent) {
      const call = calls.get(children.get(sessionID));
      if (!call || call.child !== sessionID || typeof parentID !== 'string' || call.parent !== parentID || call.role !== agentRole(agent)) return null;
      return { role: call.role };
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
  const head = `Sterling refused this subagent dispatch: the model settings in .sterling/config.json cannot be read (${error?.message ?? error}).`;
  const tail = 'While they cannot be read, a dispatch might run on another model than the one chosen for it, so none runs.';
  if (error instanceof OverpassUnknownRoleError) {
    return `${head} This Sterling plugin is version ${version ?? pluginVersion()} and does not know the role ${JSON.stringify(error.role)}; a newer Sterling most likely wrote it. Run \`opencode plugin update\`, then /reload, so the plugin knows that role. ${tail} Or remove that role from overpass.roles, then dispatch again.`;
  }
  return `${head} ${tail} Fix that value in .sterling/config.json (TUI System tab), then dispatch again.`;
}

/** The agent entries the overlay should hold: { [agent]: { model, variant? } }, from each agent's own selection. */
export function desiredOverlay(res) {
  const out = {};
  const want = (sel) => ({ model: sel.model, ...(sel.variant ? { variant: sel.variant } : {}) });
  if (res?.plan) out[PLAN_AGENT] = want(res.plan);
  if (res?.conductor) out[CONDUCTOR_AGENT] = want(res.conductor);
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

/**
 * True when git tracks .opencode/opencode.json (Sterling writes that file only while it is
 * untracked); throws when git cannot say.
 */
function isTracked(root) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--', PROJECT_CONFIG_REL], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (/not a git repository/i.test(String(e.stderr ?? ''))) return false;
    throw new Error(`could not check whether git tracks ${PROJECT_CONFIG_REL} (${String(e.stderr || e.message).trim()})`);
  }
  return out.trim() !== '';
}

/**
 * The notice for a tracked opencode.json while Overpass is on: the overlay write is
 * skipped and nothing else changes (decision
 * overpass-with-a-tracked-opencode-opencode-json-keep-routing).
 */
export const TRACKED_OVERLAY_NOTICE = `Sterling Overpass: ${PROJECT_CONFIG_REL} is tracked by git, and Sterling does not write tracked project files, so the conductor and Plan run on the models that file gives them, not on their config.models selections. Subagent dispatches still get their models from config.models.`;

/**
 * The notice for Sterling-written entries a tracked opencode.json still holds, so the
 * team can restore them by hand; Sterling never writes the tracked file.
 */
export function strandedNotice(stranded) {
  const parts = stranded.map(({ name, model, prior }) => `agent.${name} (model ${JSON.stringify(model)}; before Overpass: ${describeOwned(prior)})`);
  return `Sterling Overpass: ${PROJECT_CONFIG_REL} is tracked by git, and Sterling does not write tracked project files, so it still holds models Sterling wrote: ${parts.join(', ')}. Put the earlier values back by hand if you do not want these.`;
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
 * unreadable opencode.json or ownership file, or a failed write. A tracked opencode.json
 * that needs a write (ownership included) is left alone and returns `skippedTracked: true`
 * with `stranded`: [{ name, model, prior }] for each Sterling-written entry it could not undo. `fs` ({ writeFile, rename }) is writeFileAtomic's test seam.
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
  const stranded = [];
  const before = {};
  const after = {};
  const touch = (name, entry) => {
    if (!Object.hasOwn(before, name)) before[name] = agents[name] === undefined ? null : agents[name];
    if (entry === undefined) delete agents[name];
    else agents[name] = entry;
    after[name] = entry === undefined ? null : entry;
  };
  for (const name of [...names].sort()) {
    const wanted = want[name];
    const model = wanted?.model;
    const variant = wanted?.variant;
    const rec = own.agent[name];
    const entry = agents[name];
    if (entry !== undefined && !isObject(entry)) throw new Error(`${PROJECT_CONFIG_REL}: "agent.${name}" is not an object, so the Overpass agent models were not changed`);
    if (model) {
      const cur = entry ?? {};
      let next = rec;
      if (!next) next = { created: entry === undefined, prior: pick(cur, OWNED_KEYS) };
      else {
        // Changed by hand while Sterling's value was in place: that value is the one to put back.
        const prior = { ...next.prior };
        if (cur.model !== next.wrote) {
          if (Object.hasOwn(cur, 'model')) prior.model = cur.model;
          else delete prior.model;
        }
        if (Object.hasOwn(cur, 'variant') && cur.variant !== next.wroteVariant) prior.variant = cur.variant;
        next = { ...next, prior };
      }
      next = { ...next, wrote: model };
      if (variant) next.wroteVariant = variant;
      else delete next.wroteVariant;
      if (JSON.stringify(next) !== JSON.stringify(rec)) {
        own.agent[name] = next;
        ownChanged = true;
      }
      if (cur.model !== model || cur.variant !== variant || entry === undefined) {
        const updated = { ...cur, model };
        if (variant) updated.variant = variant;
        else delete updated.variant;
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
    stranded.push({ name, model: rec.wrote, prior: rec.prior });
    const restored = { ...entry };
    delete restored.model;
    // A variant Sterling wrote goes with its model; one the user set since stays.
    if (rec.wroteVariant !== undefined && restored.variant === rec.wroteVariant) delete restored.variant;
    if (Object.hasOwn(rec.prior ?? {}, 'model')) restored.model = rec.prior.model;
    if (Object.hasOwn(rec.prior ?? {}, 'variant') && !Object.hasOwn(restored, 'variant')) restored.variant = rec.prior.variant;
    touch(name, rec.created && !Object.keys(restored).length ? undefined : restored);
  }
  const changed = Object.keys(after).length > 0;
  if (!changed && !ownChanged) return { changed: false, notes };
  // Checked before ANY write, ownership included. Nothing is written for a tracked file:
  // ownership and any pending record stay as they were, so a later call (after the file
  // is untracked) settles and writes as usual. `stranded` names the entries Sterling
  // wrote that this call would have undone and could not, so they can be put back by hand.
  if (isTracked(root)) return { changed: false, notes: [], skippedTracked: true, stranded };
  if (!changed) {
    writeOwnership(root, own, fs);
    return { changed: false, notes };
  }
  if (Object.keys(agents).length || config.agent !== undefined) config.agent = agents;
  // Recovery notes ride in the pending record until this write completes, so a failure below cannot lose them.
  writeOwnership(root, { agent: settledOwn.agent, pending: { before, after, agent: own.agent, ...(recoveryNotes.length ? { notes: recoveryNotes } : {}) } }, fs);
  writeText(path, projectConfigText(config), fs);
  writeOwnership(root, own, fs);
  return { changed, notes };
}

/** The model config.models gives `agent`'s sessions (the conductor or Plan), or null when it selects none. */
export function expectedSessionModel(res, agent) {
  if (agent === CONDUCTOR_AGENT) return res?.conductor?.model ?? null;
  if (agent === PLAN_AGENT) return res?.plan?.model ?? null;
  return null;
}

/** The loud notice for a conductor or Plan session running on another model, or ''. */
export function mismatchNotice(res, agent, model) {
  const expected = expectedSessionModel(res, agent);
  if (!expected || !model || model === expected) return '';
  return `STERLING MODELS: config.models gives this agent ${expected}, but this session runs on ${model}: pick ${expected} in /models or start a new session. Sterling does not switch an open session's model.`;
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
