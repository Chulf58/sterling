// The dispatch model resolver on OpenCode (decision
// subagent-model-choice-on-opencode-conductor-states-dispatch). While Overpass is NOT
// effective, each subagent call's model comes from the project's config.models, driven by
// the dispatch intent the conductor states on one brief line:
//   MODEL-INTENT: hard               the role's hard_task pin
//   MODEL-INTENT: review-of=<p>      a reviewer of work written on provider <p>; the
//                                    reviewer is moved off that provider when it can be
//   MODEL-INTENT: fallback=<reason>  the role's Claude model (models.<role>.model), announced
// A brief with no line runs on the role's normal model: opencode_model, else
// anthropic/<model>. The role's effort is sent as the OpenCode variant (`#<effort>`): model
// and effort stay separate in config and are composed only here.
//
// Precedence: a model the call names is a deliberate pin and is kept, with a line naming
// what config.models would have given (the decision's strongest objection to a fixed
// override order was that it erases such pins). The resolver fills only a call that names
// no model. While Overpass is effective none of this runs: overpass.mjs dispatchPin and
// OVERPASS-BYPASS decide exactly as before, and an intent line is ignored.
//
// Failure: a malformed or repeated MODEL-INTENT line refuses the dispatch (thrown out of
// execute.before, as a bad OVERPASS-BYPASS line is), because the conductor's own line is
// cheap to fix. A config.models value that fails validation never refuses and never drops
// the dispatch: the call keeps its own model and carries a loud line plus a notice.
import { CLAUDE_MODEL_ID_RE, OPENCODE_MODEL_REF_RE, configSchema, judgeProjectMode } from '@sterling/schemas';
import { agentRole } from './agent-name.mjs';
import { unfencedMarkers } from './overpass.mjs';

const INTENT_LINE = /^[ \t]*MODEL-INTENT:(.*)$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The message a dispatch is refused with when its MODEL-INTENT line cannot be read (`why` names the defect). */
export function intentRefusal(why) {
  return `Sterling refused this subagent dispatch: its brief carries a MODEL-INTENT line but ${why}. Use exactly one line, "MODEL-INTENT: hard", "MODEL-INTENT: review-of=<provider>" (the provider the reviewed work was written on, for example openai) or "MODEL-INTENT: fallback=<reason>", or drop the line to run on the role's normal model.`;
}

/**
 * The dispatch intent in a brief: { kind: 'normal' } when no unfenced MODEL-INTENT line is
 * there, else { kind: 'hard' }, { kind: 'review-of', author } or { kind: 'fallback', reason }.
 * Throws intentRefusal for two or more lines or a value that is none of those.
 */
export function parseIntent(prompt) {
  const lines = unfencedMarkers(prompt, INTENT_LINE);
  if (!lines.length) return { kind: 'normal' };
  if (lines.length > 1) throw new Error(intentRefusal(`it has ${lines.length} of them`));
  const value = lines[0];
  if (value === 'hard') return { kind: 'hard' };
  const review = /^review-of=(.*)$/.exec(value);
  if (review) {
    const author = review[1].trim();
    if (!PROVIDER_RE.test(author)) throw new Error(intentRefusal(`review-of names ${JSON.stringify(author)}, which is not a provider id such as openai or anthropic`));
    return { kind: 'review-of', author };
  }
  const fallback = /^fallback=(.*)$/.exec(value);
  if (fallback) {
    const reason = fallback[1].trim();
    if (!reason) throw new Error(intentRefusal('the fallback gives no reason'));
    return { kind: 'fallback', reason };
  }
  throw new Error(intentRefusal(`its value ${JSON.stringify(value)} is not one of hard, review-of=<provider> or fallback=<reason>`));
}

const providerOf = (ref) => ref.slice(0, ref.indexOf('/'));
const claudeRef = (entry) => `anthropic/${entry.model}`;

/** The role's config.models entry judged by the schema (defaults applied): { entry } | { entry: null } | { problem }. */
function roleEntry(config, role) {
  const models = config?.models;
  if (models !== undefined && !isObject(models)) return { problem: `config.models is ${JSON.stringify(models)}, not an object` };
  const raw = models ?? {};
  const parsed = configSchema.shape.models.safeParse(Object.hasOwn(raw, role) ? { [role]: raw[role] } : {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { problem: `config.models.${[role, ...issue.path.slice(1)].join('.')}: ${issue.message}` };
  }
  return { entry: Object.hasOwn(parsed.data, role) ? parsed.data[role] : null };
}

/** A hard_task model as an OpenCode reference: <provider>/<model> as is, a Claude id on anthropic, else null. */
function hardRef(model) {
  if (OPENCODE_MODEL_REF_RE.test(model)) return model;
  if (CLAUDE_MODEL_ID_RE.test(model)) return `anthropic/${model}`;
  return null;
}

/**
 * The pure resolver: (role, intent, raw config, project mode) -> what config.models gives
 * the dispatch. Returns null when the role has no config.models entry (an agent Sterling
 * does not configure: the call is left alone), { problem } when the entry fails validation,
 * else { model, variant, ref, note }: `ref` is `model#variant`, `note` says why, in words.
 * `mode` is read only for review-of, through the strict mode judge; null means judge config.mode.
 */
export function resolveDispatchModel(role, intent, config, mode = null) {
  if (typeof role !== 'string' || !role) return null;
  const judged = roleEntry(config, role);
  if (judged.problem) return { problem: judged.problem };
  const { entry } = judged;
  if (!entry) return null;
  const normal = entry.opencode_model ?? claudeRef(entry);
  let model = normal;
  let variant = entry.effort;
  let note = `config.models.${role}`;
  if (intent.kind === 'hard') {
    if (!entry.hard_task) note = `config.models.${role} (MODEL-INTENT hard, but ${role} has no hard_task, so its normal model)`;
    else {
      const ref = hardRef(entry.hard_task.model);
      if (!ref) return { problem: `config.models.${role}.hard_task.model is ${JSON.stringify(entry.hard_task.model)}, neither a Claude model id nor <provider>/<model>` };
      model = ref;
      variant = entry.hard_task.effort ?? entry.effort;
      note = `config.models.${role}.hard_task (MODEL-INTENT hard)`;
    }
  } else if (intent.kind === 'review-of') {
    let judgedMode = mode;
    if (judgedMode === null) {
      try {
        judgedMode = judgeProjectMode(config?.mode, '.sterling/config.json');
      } catch (e) {
        return { problem: e.message };
      }
    }
    const alt = claudeRef(entry);
    if (judgedMode === 'work') note = `config.models.${role} (work mode: every pre-PR reviewer runs on the normal reviewer model, whoever wrote the work)`;
    else if (providerOf(normal) !== intent.author) note = `config.models.${role} (already a different provider from the author's ${intent.author})`;
    else if (providerOf(alt) !== intent.author) {
      model = alt;
      note = `config.models.${role}.model (the author wrote on ${intent.author}, so the dispatch moves to the role's Claude model)`;
    } else note = `config.models.${role} (CROSS-FAMILY NOT POSSIBLE: the author wrote on ${intent.author} and this role configures no model on another provider)`;
  } else if (intent.kind === 'fallback') {
    model = claudeRef(entry);
    note = `config.models.${role}.model (announced fallback: ${intent.reason})`;
  }
  return { model, variant, ref: `${model}#${variant}`, note };
}

/**
 * The model step for one subagent call while Overpass is not effective: { model, line,
 * notice? }. `model` is what to set on the call (null leaves the call as it is); `line` goes
 * on the call's result; `notice` also reaches the conductor's session. Throws intentRefusal.
 */
export function dispatchModel(config, args) {
  const intent = parseIntent(args?.prompt);
  const role = agentRole(args?.agent);
  const named = typeof args?.model === 'string' && args.model ? args.model : null;
  // A call that resumes a subagent session (`sessionID` on 2.1.2's subagent tool, the old task_id)
  // keeps that session's own model: a model on the call would beat it and switch a warm session
  // (an Opus lane resumed as Sonnet). Only an explicit intent line resolves a model for a resume.
  if (typeof args?.sessionID === 'string' && args.sessionID && intent.kind === 'normal') {
    return { model: null, line: named ? null : 'MODEL: resumed session keeps its own model (no MODEL-INTENT line, so config.models is not applied).' };
  }
  const res = resolveDispatchModel(role, intent, config);
  if (res === null) {
    return intent.kind === 'normal'
      ? { model: null, line: null }
      : { model: null, line: `MODEL: the MODEL-INTENT line was not applied: the agent ${JSON.stringify(args?.agent)} has no config.models entry, so the call ${named ? `kept ${named}` : 'runs on the agent\'s own model'}.` };
  }
  if (res.problem) {
    const text = `config.models is invalid (${res.problem}), so this dispatch was not given a model from it and ${named ? `kept ${named} as the call named` : 'runs on the agent\'s own model'}. Fix the value in .sterling/config.json (TUI System tab).`;
    return { model: null, line: `MODEL: ${text}`, notice: `Sterling models: ${text}` };
  }
  if (named) {
    const differs = named !== res.ref;
    const line = differs ? `MODEL: kept ${named} as the call named; ${res.note} gives ${res.ref}. Omit the call's model to run on config.models.` : null;
    const notice = intent.kind === 'fallback' ? `Sterling models: fallback dispatch on ${named} (reason: ${intent.reason}).` : undefined;
    return notice ? { model: null, line: line ?? `MODEL: fallback dispatch on ${named} (reason: ${intent.reason}).`, notice } : { model: null, line };
  }
  const line = `MODEL: this dispatch runs on ${res.ref}, from ${res.note}.`;
  return intent.kind === 'fallback'
    ? { model: res.ref, line, notice: `Sterling models: fallback dispatch on ${res.ref} (reason: ${intent.reason}).`, resolved: true }
    : { model: res.ref, line, resolved: true };
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
