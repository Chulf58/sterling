import { AGY_MODEL_IDS, CUSTOM_AGENT_KEY_PREFIX } from './config.js';

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

export interface HostCapability {
  host: AgentHost;
  /** What the model control offers: `claude_catalog` (a model from the catalog), `opencode_ref`
   *  (<provider>/<model>) or `agy_enum` (exactly `values`). */
  model: { kind: 'claude_catalog' | 'opencode_ref' | 'agy_enum'; values?: readonly string[] };
  /** Effort levels the host's rendered agent carries; empty when the host has no effort control. */
  effortLevels: readonly string[];
}

/** One table of what each host lets a model or effort control do. Claude: model from the
 *  catalog, effort low, medium or high. OpenCode: a model reference, no effort (the renderer,
 *  renderFullOpenCodeAgent in scripts/lib/opencode-install.mjs, writes none). agy: inherit,
 *  flash_lite, flash or pro, no effort (decision agy-model-accepts-only-agy-subagent-values-inherit-flash-lite-flash-pro). */
export const AGENT_HOST_CAPABILITIES: Readonly<Record<AgentHost, HostCapability>> = Object.freeze({
  claude: { host: 'claude', model: { kind: 'claude_catalog' }, effortLevels: CLAUDE_EFFORT_LEVELS },
  opencode: { host: 'opencode', model: { kind: 'opencode_ref' }, effortLevels: [] },
  agy: { host: 'agy', model: { kind: 'agy_enum', values: AGY_MODEL_IDS }, effortLevels: [] },
});

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
  /** Whether the host has a model control, always true today. */
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
  if (host === 'claude') {
    if (e.model) ({ model, modelFrom } = { model: e.model, modelFrom: 'model' });
  } else if (host === 'opencode') {
    if (e.opencode_model) ({ model, modelFrom } = { model: e.opencode_model, modelFrom: 'override' });
    else if (e.model) ({ model, modelFrom } = { model: `anthropic/${e.model}`, modelFrom: 'model' });
  } else if (e.agy_model) {
    ({ model, modelFrom } = { model: e.agy_model, modelFrom: 'override' });
  }
  const out: ResolvedHostSettings = { host, model, modelFrom, modelSupported: true, effortSupported };
  if (e.effort !== undefined) {
    if (cap.effortLevels.includes(e.effort)) out.effort = e.effort;
    else out.effortIgnored = e.effort;
  }
  return out;
}
