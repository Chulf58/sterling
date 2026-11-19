import { AGY_MODEL_IDS, AGY_MODEL_NAMESPACE, CLAUDE_PROVIDER, CUSTOM_AGENT_KEY_PREFIX, DEFAULT_OVERPASS_PROVIDER, OVERPASS_MODEL_NAMESPACE, PLAN_MODEL_KEY, toCanonicalConfig, canonicalModelsSchema } from './config.js';

// Custom-agent identity and per-host capabilities (decisions
// custom-agents-are-adopted-into-a-source-folder-host-files-are-generated-projections and
// system-tab-redesign-one-agent-table-every-agent-every-host-settings-section; GitHub #312).
// Pure: nothing here reads a file. The adoption planner is scripts/lib/agent-adoption.mjs.

export const AGENT_HOSTS = ['claude', 'opencode', 'agy'] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

// ── Identity ─────────────────────────────────────────────────────────────────
// Before adoption an agent is identified by its host and its full relative path under the
// host's agent folder, without the extension: `opencode:team/scout`. The same name on two
// hosts is two agents.

export function discoveredAgentId(host: AgentHost, name: string): string {
  return `${host}:${name}`;
}

export function parseDiscoveredAgentId(id: string): { host: AgentHost; name: string } | null {
  const i = id.indexOf(':');
  if (i < 1) return null;
  const host = id.slice(0, i);
  const name = id.slice(i + 1);
  if (!(AGENT_HOSTS as readonly string[]).includes(host) || name === '') return null;
  return { host: host as AgentHost, name };
}

/**
 * The slug of an agent's relative path: lower-cased, every run of characters other than
 * a-z and 0-9 (the `/` of a subfolder included) becomes one `-`, leading and trailing `-`
 * trimmed. `team/scout` and `team-scout` therefore share a slug; adoption refuses the second
 * (planAdoption), never merges them. null when nothing is left or the slug exceeds 64 characters.
 */
export function customAgentSlug(name: string): string | null {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' || slug.length > 64 ? null : slug;
}

/** The reserved config.models key of an adopted agent: `custom-<slug>`. */
export function customAgentKey(name: string): string | null {
  const slug = customAgentSlug(name);
  return slug === null ? null : `${CUSTOM_AGENT_KEY_PREFIX}${slug}`;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

/** The canonical models agy runs: its own, agy/<id> for each of AGY_MODEL_IDS. USER-RULED (decision
 *  one-model-per-agent-an-agent-has-a-single-model-not-a-claude, rationale point (5), "No agy copy,
 *  fail loudly"): an agent on a Claude model gets no agy copy, because agy agent files cannot name one. */
export const AGY_CANONICAL_MODELS: readonly string[] = AGY_MODEL_IDS.map((id) => `${AGY_MODEL_NAMESPACE}/${id}`);

export interface HostCapability {
  host: AgentHost;
  /** What the model control offers: `claude_catalog` (a model from the catalog), `opencode_ref`
   *  (<provider>/<model>) or `agy_enum` (exactly `values`). */
  model: { kind: 'claude_catalog' | 'opencode_ref' | 'agy_enum'; values?: readonly string[] };
  /** Effort levels the host's rendered agent carries; empty when the host has no effort control. */
  effortLevels: readonly string[];
  /** Which canonical models (<provider>/<id>) the host can run: every provider ('*') except the
   *  ones in `except`, the providers listed, or exactly the models listed. */
  runs: { providers: '*' | readonly string[]; except?: readonly string[] } | { models: readonly string[] };
}

/** One table of what each host lets a model or effort control do, and which models it runs.
 *  Claude: model from the catalog, effort low, medium or high, anthropic models only. OpenCode:
 *  a model reference, no effort (the renderer, renderFullOpenCodeAgent in
 *  scripts/lib/opencode-install.mjs, writes none), any provider but agy's own, which only agy
 *  runs. agy: inherit, flash_lite, flash or pro in its agent files, no effort (decision
 *  agy-model-accepts-only-agy-subagent-values-inherit-flash-lite-flash-pro), so of the canonical
 *  models it runs exactly AGY_CANONICAL_MODELS. */
export const AGENT_HOST_CAPABILITIES: Readonly<Record<AgentHost, HostCapability>> = Object.freeze({
  claude: { host: 'claude', model: { kind: 'claude_catalog' }, effortLevels: CLAUDE_EFFORT_LEVELS, runs: { providers: [CLAUDE_PROVIDER] } },
  opencode: { host: 'opencode', model: { kind: 'opencode_ref' }, effortLevels: [], runs: { providers: '*', except: [AGY_MODEL_NAMESPACE] } },
  agy: { host: 'agy', model: { kind: 'agy_enum', values: AGY_MODEL_IDS }, effortLevels: [], runs: { models: AGY_CANONICAL_MODELS } },
});

/** Whether `host` can run the canonical model `model` (<provider>/<id>; a bare id is a Claude id). */
export function hostRunsModel(model: string, host: AgentHost): boolean {
  const ref = model.includes('/') ? model : `${CLAUDE_PROVIDER}/${model}`;
  const runs = AGENT_HOST_CAPABILITIES[host].runs;
  if ('models' in runs) return runs.models.includes(ref);
  const provider = ref.slice(0, ref.indexOf('/'));
  if (runs.except?.includes(provider)) return false;
  return runs.providers === '*' || runs.providers.includes(provider);
}

/** A canonical model as OpenCode names it: overpass/<tier> becomes <provider>/<tier>; anything else is unchanged. */
export function opencodeModelRef(model: string, overpassProvider: string = DEFAULT_OVERPASS_PROVIDER): string {
  const prefix = `${OVERPASS_MODEL_NAMESPACE}/`;
  return model.startsWith(prefix) ? `${overpassProvider}/${model.slice(prefix.length)}` : model;
}

export const INHERIT = 'inherit';

/** The config.models.<key> fields the resolver reads; every one may be absent on a custom agent. */
export interface AgentModelSettings {
  model?: string;
  effort?: string;
  opencode_model?: string;
  agy_model?: string;
}

export interface ResolvedHostSettings {
  host: AgentHost;
  /** The effective model, or `inherit` when the entry names none (the host's own default). */
  model: string;
  /** Which field decided `model`: `override` (opencode_model, agy_model), `model`, or `inherit`. */
  modelFrom: 'override' | 'model' | 'inherit';
  /** The effective effort; undefined when none is set or the host has no effort control. */
  effort?: string;
  /** Whether the host can run the entry's model (hostRunsModel); true when the entry names none. */
  modelSupported: boolean;
  /** Whether the host has an effort control; false means the control is shown read-only or hidden. */
  effortSupported: boolean;
  /** An effort the entry holds that this host cannot carry (the value ignored), if any. */
  effortIgnored?: string;
}

/** The effective model and effort of one agent on one host, and whether each control exists there. */
export function resolveHostSettings(entry: AgentModelSettings | undefined, host: AgentHost): ResolvedHostSettings {
  const cap = AGENT_HOST_CAPABILITIES[host];
  const e = entry ?? {};
  const effortSupported = cap.effortLevels.length > 0;
  let model = INHERIT;
  let modelFrom: ResolvedHostSettings['modelFrom'] = 'inherit';
  let modelSupported = true;
  // A canonical entry names its one model as <provider>/<id> (decision
  // one-model-per-agent-an-agent-has-a-single-model-not-a-claude); a legacy entry names a bare
  // Claude id plus the per-host overrides, read as before until the cutover.
  const canonical = typeof e.model === 'string' && e.model.includes('/') ? e.model : undefined;
  if (host === 'claude') {
    if (canonical) {
      modelSupported = hostRunsModel(canonical, 'claude');
      ({ model, modelFrom } = { model: modelSupported ? canonical.slice(CLAUDE_PROVIDER.length + 1) : canonical, modelFrom: 'model' });
    } else if (e.model) ({ model, modelFrom } = { model: e.model, modelFrom: 'model' });
  } else if (host === 'opencode') {
    if (e.opencode_model) ({ model, modelFrom } = { model: e.opencode_model, modelFrom: 'override' });
    else if (canonical) ({ model, modelFrom } = { model: canonical, modelFrom: 'model' });
    else if (e.model) ({ model, modelFrom } = { model: `anthropic/${e.model}`, modelFrom: 'model' });
  } else if (e.agy_model) {
    ({ model, modelFrom } = { model: e.agy_model, modelFrom: 'override' });
  } else if (canonical) {
    // agy agent files name the bare enum value: agy/flash renders flash.
    modelSupported = hostRunsModel(canonical, 'agy');
    ({ model, modelFrom } = { model: modelSupported ? canonical.slice(AGY_MODEL_NAMESPACE.length + 1) : canonical, modelFrom: 'model' });
  }
  const out: ResolvedHostSettings = { host, model, modelFrom, modelSupported, effortSupported };
  if (e.effort !== undefined) {
    if (cap.effortLevels.includes(e.effort)) out.effort = e.effort;
    else out.effortIgnored = e.effort;
  }
  return out;
}

// ── Host fit ─────────────────────────────────────────────────────────────────
// A host gets a copy of an agent only when it can run the agent's one model (decision
// settings-redesign-build-shape-one-legacy-to-canonical-config): the renderers skip it and
// remove the stale unedited copy they generated, and the session context and the TUI list
// what is left out through unsupportedAgents.

/** One agent a host cannot run, or (host '*') an agent whose two legacy models are not chosen yet. */
export interface UnsupportedAgent {
  agent: string;
  host: AgentHost | '*';
  model?: string;
  reason: string;
}

/** The message for a role whose legacy entry still names two models. */
export function twoModelsReason(role: string): string {
  return `role ${role} has two models; run /sterling:update to choose`;
}

const isPlainObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Every agent in `config` (legacy or canonical, read through toCanonicalConfig) that one of `hosts`
 * cannot run, plus each role with an unresolved two-model conflict (host '*'). The Plan agent exists
 * only on OpenCode, so it is judged there only. Pure. Throws what toCanonicalConfig throws for a
 * legacy value it cannot carry, and a ZodError for an invalid models entry.
 */
export function unsupportedAgents(config: unknown, hosts: readonly AgentHost[] = AGENT_HOSTS): UnsupportedAgent[] {
  const { config: canon, conflicts } = toCanonicalConfig(config);
  const out: UnsupportedAgent[] = conflicts.map((c) => ({ agent: c.role, host: '*' as const, reason: twoModelsReason(c.role) }));
  const conflicted = new Set(conflicts.map((c) => c.role));
  const models = canonicalModelsSchema.parse(isPlainObj(canon) && isPlainObj(canon.models) ? canon.models : undefined) as Record<string, { model?: string }>;
  for (const agent of Object.keys(models).sort()) {
    const model = models[agent].model;
    if (conflicted.has(agent) || model === undefined) continue;
    for (const host of hosts) {
      if (agent === PLAN_MODEL_KEY && host !== 'opencode') continue;
      if (!hostRunsModel(model, host)) out.push({ agent, host, model, reason: `${host} cannot run ${model}, so it gets no copy of ${agent}` });
    }
  }
  return out;
}
