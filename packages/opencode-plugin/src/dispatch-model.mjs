// The dispatch model resolver on OpenCode. Every subagent call's model comes from the agent's
// ONE canonical model in config.models (decisions one-model-per-agent-an-agent-has-a-single-model-not-a-claude,
// overpass-tiers-are-ordinary-model-choices-in-each-agent-s-pi and
// settings-redesign-build-shape-one-legacy-to-canonical-config): the config is read through the
// legacy-to-canonical transform (toCanonicalConfig), so a legacy file and a canonical one give
// the same answer. An agent's model is <provider>/<id>, sent with its optional effort as the
// OpenCode variant (`#<effort>`); an Overpass tier, overpass/<tier>, is a logical namespace
// mapped through config.overpass.provider and sent without a variant, because a tier's effort
// reaches the request as its reasoning effort (overpass.mjs requestEffort).
//
// There is no MODEL-INTENT line any more (hard, review-of and fallback are gone with the one
// model), and no Overpass switch: a brief's MODEL-INTENT or OVERPASS-BYPASS line is plain text.
//
// Precedence: a model the call names is a deliberate pin and is kept, with a line naming what
// config.models would have given (decision subagent-model-choice-on-opencode-conductor-states-dispatch).
// The resolver fills only a call that names no model.
//
// Failure: a role whose legacy entry still names two models (a Claude model and a different
// OpenCode model, not yet chosen by /sterling:update) refuses the dispatch loudly, on either model
// (conductor ruling 2026-11-19: the transform's proposal is not used). A config.models value that
// fails validation never refuses: the call keeps its own model and carries a loud line plus a notice.
import { DEFAULT_OVERPASS_PROVIDER, OVERPASS_MODEL_NAMESPACE, OVERPASS_PROVIDER_RE, canonicalModelsSchema, opencodeModelRef, toCanonicalConfig, twoModelsReason } from '@sterling/schemas';
import { agentRole } from './agent-name.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TIER_PREFIX = `${OVERPASS_MODEL_NAMESPACE}/`;

/** The message a dispatch to a role with an unresolved two-model conflict is refused with. */
export function conflictRefusal(role) {
  return `Sterling refused this subagent dispatch: ${twoModelsReason(role)}. Nothing was sent, on either model.`;
}

/**
 * The project's model routing, read once from a raw config (legacy or canonical):
 * { provider, conflicts: Set<role>, entries: { [key]: entry } } where an entry is
 * { canonical, model, effort?, tier } (`model` the OpenCode reference, overpass/<tier> mapped
 * through the provider) or { problem }. The eight shipped roles always have an entry (their
 * defaults). `modelsProblem` is set when config.models is not an object. Throws what
 * toCanonicalConfig throws for a legacy value it cannot carry, and for an overpass block or
 * provider that is not valid, so the caller refuses rather than guess a route. `agentKeys`
 * (Map<served name, config key>, custom-agent-render.mjs openCodeCustomAgentKeys) maps an
 * adopted agent's served name to its custom-<slug> key; see routingKey.
 */
export function projectRouting(config, { agentKeys } = {}) {
  const { config: canon, conflicts } = toCanonicalConfig(isObject(config) ? config : {});
  const overpass = canon.overpass;
  if (overpass !== undefined && !isObject(overpass)) throw new Error(`config.overpass is ${JSON.stringify(overpass)} — it must be an object`);
  const provider = overpass?.provider ?? DEFAULT_OVERPASS_PROVIDER;
  if (typeof provider !== 'string' || !OVERPASS_PROVIDER_RE.test(provider)) throw new Error(`config.overpass.provider is ${JSON.stringify(provider)} — it must be letters, digits, '-', '_' and '.'`);
  const routing = { provider, conflicts: new Set(conflicts.map((c) => c.role)), entries: {}, agentKeys: agentKeys instanceof Map ? agentKeys : new Map() };
  const raw = canon.models;
  if (raw !== undefined && !isObject(raw)) {
    routing.modelsProblem = `config.models is ${JSON.stringify(raw)}, not an object`;
    return routing;
  }
  const add = (key, e) => {
    if (e.model === undefined) return;
    const tier = e.model.startsWith(TIER_PREFIX);
    routing.entries[key] = { canonical: e.model, model: opencodeModelRef(e.model, provider), ...(e.effort === undefined ? {} : { effort: e.effort }), tier };
  };
  for (const [key, e] of Object.entries(canonicalModelsSchema.parse({}))) add(key, e);
  for (const [key, value] of Object.entries(raw ?? {})) {
    const parsed = canonicalModelsSchema.safeParse({ [key]: value });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      routing.entries[key] = { problem: `config.models.${[key, ...issue.path.slice(1)].join('.')}: ${issue.message}` };
      continue;
    }
    delete routing.entries[key];
    add(key, parsed.data[key]);
  }
  return routing;
}

/** The config.models key an agent name is routed by: an adopted agent's served name maps to its
 *  custom-<slug> key (routing.agentKeys); any other name is its role (agentRole). */
export function routingKey(routing, agent) {
  const role = agentRole(agent);
  return typeof role === 'string' && routing?.agentKeys?.has(role) ? routing.agentKeys.get(role) : role;
}

/**
 * The pure resolver: (role, routing) -> what config.models gives the dispatch. null when the
 * role has no model (an agent Sterling does not configure, or a custom agent left on the host's
 * default: the call is left alone); { conflict: true } for an unresolved two-model role;
 * { problem } when the entry fails validation; else { model, variant, ref, note, overpass }:
 * `ref` is what to send (`model#variant`, or `model` when no effort or on a tier).
 */
export function resolveDispatchModel(role, routing) {
  if (typeof role !== 'string' || !role) return null;
  if (routing.conflicts.has(role)) return { conflict: true };
  if (routing.modelsProblem) return { problem: routing.modelsProblem };
  const entry = Object.hasOwn(routing.entries, role) ? routing.entries[role] : null;
  if (!entry) return null;
  if (entry.problem) return { problem: entry.problem };
  const { model, effort, tier } = entry;
  if (tier) {
    const note = `config.models.${role}, the Overpass tier ${entry.canonical} on provider '${routing.provider}'${effort ? ` with effort ${effort} sent as the request's reasoning effort` : ''}`;
    return { model, variant: undefined, ref: model, note, overpass: true };
  }
  return { model, variant: effort, ref: effort ? `${model}#${effort}` : model, note: `config.models.${role}`, overpass: false };
}

/**
 * The model step for one subagent call: { model, line, notice?, resolved?, overpass? }. `model`
 * is what to set on the call (null leaves the call as it is); `line` goes on the call's result;
 * `notice` also reaches the conductor's session; `overpass` marks a tier route for the
 * availability check. Throws conflictRefusal for a role with two models.
 */
export function dispatchModel(routing, args) {
  const role = routingKey(routing, args?.agent);
  const named = typeof args?.model === 'string' && args.model ? args.model : null;
  // A call that resumes a subagent session (`sessionID` on 2.1.2's subagent tool, the old task_id)
  // keeps that session's own model: a model on the call would beat it and switch a warm session.
  if (typeof args?.sessionID === 'string' && args.sessionID) {
    return { model: null, line: named ? null : 'MODEL: resumed session keeps its own model (config.models is not applied).' };
  }
  const res = resolveDispatchModel(role, routing);
  if (res === null) return { model: null, line: null };
  if (res.conflict) throw new Error(conflictRefusal(role));
  if (res.problem) {
    const text = `config.models is invalid (${res.problem}), so this dispatch was not given a model from it and ${named ? `kept ${named} as the call named` : 'runs on the agent\'s own model'}. Fix the value in .sterling/config.json (TUI System tab).`;
    return { model: null, line: `MODEL: ${text}`, notice: `Sterling models: ${text}` };
  }
  if (named) {
    const line = named !== res.ref ? `MODEL: kept ${named} as the call named; ${res.note} gives ${res.ref}. Omit the call's model to run on config.models.` : null;
    return { model: null, line };
  }
  return { model: res.ref, line: `MODEL: this dispatch runs on ${res.ref}, from ${res.note}.`, resolved: true, overpass: res.overpass };
}

const variantIds = (entry) => (Array.isArray(entry?.variants) ? entry.variants.map((v) => (typeof v === 'string' ? v : v?.id)).filter((v) => typeof v === 'string') : null);

/**
 * The models in a `ctx.model.list()` result. OpenCode 2.1.2's plugin context returns the
 * HTTP shape, `{ location, data: [Model.Info] }` (the binary's `model.list` wraps the
 * registry's array as `{ location, data }`; GET /api/model documents the same body), not
 * a bare array, so reading it as an array failed every dispatch's variant check and the
 * pressure watch's window lookup with no error to report. A bare array is accepted too;
 * anything else comes back unchanged for the caller to refuse as "not a list".
 */
export function modelListItems(result) {
  if (Array.isArray(result?.data)) return result.data;
  return result;
}

/**
 * The variant guard (user-ruled 2026-10-23, "Send for all, verify live"): a resolved
 * `provider/model#variant` whose model OpenCode lists without that variant runs without
 * it, and the note says so, rather than the dispatch failing. `list` is OpenCode's model
 * list (modelListItems of ctx.model.list(): items { providerID, id or modelID, variants: [{ id }] }).
 * Returns { model, note }: `note` is null when the variant is listed. A model that is not
 * in the list, or a list that could not be read (`listError`), keeps the variant, and the
 * note says it was not checked: OpenCode refuses an unavailable model loudly on its own.
 */
export function checkVariant(ref, list, listError = null) {
  const hash = ref.lastIndexOf('#');
  if (hash === -1) return { model: ref, note: null };
  const base = ref.slice(0, hash);
  const variant = ref.slice(hash + 1);
  if (listError || !Array.isArray(list)) return { model: ref, note: `(variant ${variant} not checked: OpenCode's model list could not be read${listError ? `: ${listError.message ?? listError}` : ''})` };
  const slash = base.indexOf('/');
  const providerID = base.slice(0, slash);
  const id = base.slice(slash + 1);
  const entry = list.find((m) => m?.providerID === providerID && (m?.modelID === id || m?.id === id));
  if (!entry) return { model: ref, note: `(variant ${variant} not checked: ${base} is not in OpenCode's model list)` };
  const ids = variantIds(entry) ?? [];
  if (ids.includes(variant)) return { model: ref, note: null };
  return { model: base, note: `(variant ${variant} dropped: OpenCode lists ${ids.length ? `only ${ids.join(', ')}` : 'no variants'} for ${base}, so this dispatch runs on ${base} with its default effort)` };
}
