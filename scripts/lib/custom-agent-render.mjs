// Rendering adopted custom agents into every installed host (decisions
// custom-agents-are-adopted-into-a-source-folder-host-files-are-generated-projections and
// system-tab-redesign-one-agent-table-every-agent-every-host-settings-section; GitHub #312).
//
// An adopted agent is agent-sources/<key>.md (the author's own file, written by adopt() in
// agent-adoption.mjs) plus config.models.<key>. syncCustomAgents renders it to
//   Claude    .claude/agents/<name>.md
//   OpenCode  .opencode/agents/<name>.md   (not under sterling/, which is Sterling's own)
//   agy       .agents/agents/<name>/agent.md
// where <name> is the source's frontmatter `name` (its key slug when it has none).
//
// OWNERSHIP. Every generated file carries a stamp line holding the key, the source hash and the
// hash of the content without the stamp. Sterling overwrites a file only when it is stamped for
// the same key and host and still matches its own hash; an unstamped file, an edited copy or
// another agent's file is refused with the source path in the message and left alone. Removal
// (the config entry or the source went away) deletes only a stamped, unedited output.
//
// ORIGIN. The source keeps the frontmatter of the host it was written for, and adopt() records
// that host as the first frontmatter line, `sterling-origin: claude|opencode|agy` (ORIGIN_FIELD).
// A source without the line is a Claude agent (every source adopted before the field existed was
// read as one). The line is Sterling's bookkeeping and is never rendered. The origin host gets the
// author's frontmatter as written (model and effort replaced only where config names one); every
// other host gets a translation of the origin's own restriction format (sourceRestrictions):
// Claude tools/disallowedTools, OpenCode permission (V1 map) or permissions (V2 list), agy tools.
//
// NEVER BROADER. A restriction that a host cannot express refuses that host for that agent with
// a reason; it is never dropped (decision 4736b9ef). See translateTools for the mapping. When a
// host is refused, or an agent's output path changes, the copy Sterling wrote earlier is removed
// if unedited, so a broader old copy never stays installed; an edited one is kept and reported.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CORE_SCHEMA, load } from 'js-yaml';
import { AGENT_MODEL_KEY, CUSTOM_AGENT_KEY_RE, CUSTOM_AGENT_SLUG_RE, DEFAULT_OVERPASS_PROVIDER, customAgentSlug, hostRunsModel, opencodeModelRef, resolveHostSettings, toCanonicalConfig, twoModelsReason } from '@sterling/schemas';
import { AGENT_SOURCE_DIR } from './agent-adoption.mjs';
import { AGY_AGENTS_DIR, AGY_ROSTER, probeAgy } from './agy-setup.mjs';
import { writeFileAtomicIfChanged } from './atomic-write.mjs';
import { probeOpenCode } from './opencode-install.mjs';

export const CUSTOM_RENDERER = 'custom-agent/1';
export const CUSTOM_HOSTS = ['claude', 'opencode', 'agy'];
const STAMP_RE = /^<!-- sterling-custom renderer=(\S+) host=(claude|opencode|agy) key=(\S+) source_hash=([0-9a-f]{64}) content_hash=([0-9a-f]{64}) -->$/m;

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const normalize = (s) => s.replace(/\r\n/g, '\n');

// Names a generated file must never take: the governed roles and the two main-session agents.
const RESERVED_NAMES = new Set([...Object.keys(AGENT_MODEL_KEY), ...AGY_ROSTER, 'conductor', 'plan', 'build', 'general', 'explore']);

/** The folder and file of one output, relative to the project root. */
export function outputPath(host, name) {
  if (host === 'claude') return `.claude/agents/${name}.md`;
  if (host === 'opencode') return `.opencode/agents/${name}.md`;
  return `${AGY_AGENTS_DIR}/${name}/agent.md`;
}

// ── tool translation ─────────────────────────────────────────────────────────
// Claude tool name → what OpenCode and agy call it. `agy` is the agy built-ins, named
// by the measurement in agy-setup.mjs; the OpenCode actions are OC_ACTIONS below.
const TOOL_MAP = {
  Read: { agy: ['read_file'] },
  Grep: { agy: ['grep_search'] },
  Glob: { agy: ['find_by_name', 'list_dir'] },
  LS: { agy: ['list_dir'] },
  Bash: { agy: ['run_command', 'command_status'] },
  Edit: { agy: ['edit_file'] },
  Write: { agy: ['write_file'] },
  MultiEdit: { agy: ['multi_replace_file_content'] },
  NotebookEdit: { agy: null },
  WebFetch: { agy: ['read_url_content'] },
  WebSearch: { agy: ['search_web'] },
  Task: { agy: ['invoke_subagent', 'send_message'] },
  Agent: { agy: ['invoke_subagent', 'send_message'] },
  TodoWrite: { agy: [] },
};
// OpenCode permission actions in the order they are written, each with the Claude tools it
// covers. An action is one switch: granting it grants every member, so a grant of only some
// members (Edit without Write) cannot be expressed and refuses the host. `task` is granted by
// either of its two names. The action names are OpenCode's (opencode.ai permissions); the
// webfetch/websearch pair is two actions (anti-pattern opencode-agent-permission-denying-webfetch-
// but-not-websearch), and the five in OPENCODE_PERMISSION_KEYS are the ones Sterling's own roles use.
const OC_ACTIONS = [
  ['read', ['Read']],
  ['grep', ['Grep']],
  ['glob', ['Glob']],
  ['list', ['LS']],
  ['edit', ['Edit', 'Write', 'MultiEdit']],
  ['bash', ['Bash']],
  ['webfetch', ['WebFetch']],
  ['websearch', ['WebSearch']],
  ['task', ['Task', 'Agent']],
];
const AGY_ALL = [...new Set(Object.values(TOOL_MAP).flatMap((t) => t.agy ?? []))];

function toolList(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value).split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * Translate an agent's `tools` (allowlist) and `disallowedTools` (denylist) for one host.
 * Returns { ok: true, ... } or { ok: false, reason }.
 *   claude   verbatim, always ok.
 *   opencode ok: { rules: [{action, verdict}] }, in written order. With an allowlist the first rule is
 *            `*` deny and each later one an exact allow (builtin actions, then each MCP entry as
 *            <server>_<tool>); a denylist alone gives exact denies. Refused: an unknown tool name, a
 *            whole-server or wildcard MCP entry, or a partial grant of one action (Edit without Write).
 *   agy      ok: { tools } (null when unrestricted). Refused: an MCP allowlist entry (agy cannot
 *            limit MCP tools), a tool with no agy name, or an unknown name.
 */
export function translateTools(host, { tools, disallowedTools }) {
  if (host === 'claude') return { ok: true };
  const allow = toolList(tools);
  const deny = toolList(disallowedTools) ?? [];
  const names = [...(allow ?? []), ...deny];
  const unknown = names.filter((n) => !(n in TOOL_MAP) && !n.startsWith('mcp__'));
  if (unknown.length) return { ok: false, reason: `${host} cannot express the tool name(s) ${unknown.join(', ')}` };
  if (host === 'agy') {
    if ((allow ?? []).some((n) => n.startsWith('mcp__'))) return { ok: false, reason: 'agy cannot limit MCP tools per agent, so an allowlist naming MCP tools cannot be kept to what it lists' };
    const noAgy = [...(allow ?? []), ...deny.filter((n) => !n.startsWith('mcp__'))].filter((n) => TOOL_MAP[n].agy === null);
    if (noAgy.length) return { ok: false, reason: `agy has no tool for ${[...new Set(noAgy)].join(', ')}` };
    if (allow === null && deny.length === 0) return { ok: true, tools: null };
    const granted = new Set(allow === null ? AGY_ALL : allow.flatMap((n) => TOOL_MAP[n]?.agy ?? []));
    for (const n of deny) for (const t of TOOL_MAP[n]?.agy ?? []) granted.delete(t);
    return { ok: true, tools: AGY_ALL.filter((t) => granted.has(t)) };
  }
  // OpenCode. An allowlist becomes a leading deny-all and then one exact allow per granted action
  // (a `*` deny also hides the builtins, so each must be allowed back); no rule other than that
  // first one holds a wildcard. A denylist alone becomes exact denies. No tools line leaves the
  // agent unrestricted, as on Claude.
  const mcpAction = (entry) => {
    const m = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/.exec(entry);
    if (!m || m[2].includes('*')) return null;
    return `${m[1]}_${m[2]}`.replace(/[^A-Za-z0-9_-]/g, '_');
  };
  const mcpEntries = (list) => list.filter((n) => n.startsWith('mcp__'));
  const badMcp = names.filter((n) => n.startsWith('mcp__') && mcpAction(n) === null);
  if (badMcp.length) return { ok: false, reason: `opencode names an MCP tool as <server>_<tool>, so ${badMcp.join(', ')} (a whole server or a wildcard) cannot be kept to what it lists` };
  const granted = new Set(allow === null ? Object.keys(TOOL_MAP) : allow);
  for (const n of deny) granted.delete(n);
  const rules = [];
  if (allow !== null) rules.push({ action: '*', verdict: 'deny' });
  for (const [action, members] of OC_ACTIONS) {
    const have = members.filter((m) => granted.has(m));
    if (have.length === members.length || (action === 'task' && have.length > 0)) {
      if (allow !== null) rules.push({ action, verdict: 'allow' });
    } else if (have.length === 0) {
      if (allow === null) rules.push({ action, verdict: 'deny' });
    } else {
      return { ok: false, reason: `opencode grants ${action} as one permission, and this agent's tools allow only ${have.join(', ')} of ${members.join(', ')}` };
    }
  }
  const denied = new Set(mcpEntries(deny).map(mcpAction));
  if (allow !== null) {
    for (const e of mcpEntries(allow)) if (!denied.has(mcpAction(e)) && !rules.some((r) => r.action === mcpAction(e))) rules.push({ action: mcpAction(e), verdict: 'allow' });
  }
  for (const action of denied) rules.push({ action, verdict: 'deny' });
  return { ok: true, rules };
}

// ── origin and source restrictions ───────────────────────────────────────────
export const ORIGIN_FIELD = 'sterling-origin';
// The key may be quoted ("sterling-origin" or 'sterling-origin'), which YAML reads as the same key.
const ORIGIN_LINE_RE = new RegExp(`^(?:${ORIGIN_FIELD}|"${ORIGIN_FIELD}"|'${ORIGIN_FIELD}')[ \t]*:.*(?:\n|$)`, 'm');

/** The host a parsed source was written for: { origin } or { error }. */
export function originOf(data) {
  const v = data[ORIGIN_FIELD];
  if (v === undefined) return { origin: 'claude' };
  if (!CUSTOM_HOSTS.includes(v)) return { error: `${ORIGIN_FIELD} must be one of ${CUSTOM_HOSTS.join(', ')}, got ${JSON.stringify(v)}` };
  return { origin: v };
}

/** The author's frontmatter block without the origin line. */
const withoutOrigin = (frontmatter) => frontmatter.replace(ORIGIN_LINE_RE, '').replace(/\n$/, '');

// OpenCode action names Sterling translates, with their aliases (OpenCode 2.0.22 reads bash as
// shell and write/patch as edit; opencode-install.mjs EDIT_FAMILY and SHELL_FAMILY).
const OC_ALIAS = { shell: 'bash', write: 'edit', patch: 'edit' };
const OC_V2_KEYS = ['permissions', 'request', 'system', 'disabled'];

/** OpenCode permission rules, in written order: [{ action, resource, effect }] or { reason }. */
function openCodeRules(data) {
  const v2 = OC_V2_KEYS.some((k) => k in data);
  const effectOk = (e) => e === 'allow' || e === 'deny' || e === 'ask';
  if (v2) {
    // a file with any V2 key is read by its permissions list alone (finding
    // opencode-agent-permission-wildcard-deny-then-exact-allow-works-for-mcp-tools)
    if (data.disabled === true) return { reason: 'the agent is disabled on OpenCode (disabled: true), and no other host can carry that' };
    const list = data.permissions ?? [];
    if (!Array.isArray(list)) return { reason: 'its permissions value is not a list of rules' };
    const rules = [];
    for (const r of list) {
      const resource = r?.resource ?? '*';
      if (typeof r?.action !== 'string' || typeof resource !== 'string' || !effectOk(r?.effect)) return { reason: `the permissions rule ${JSON.stringify(r)} is not {action, resource, effect}` };
      rules.push({ action: r.action, resource, effect: r.effect });
    }
    return rules;
  }
  if ('tools' in data) return { reason: 'its OpenCode tools map is not translated; write the same rules under permission' };
  const perm = data.permission;
  if (perm === undefined || perm === null) return [];
  if (typeof perm === 'string') return effectOk(perm) ? [{ action: '*', resource: '*', effect: perm }] : { reason: `permission ${JSON.stringify(perm)} is not allow, deny or ask` };
  if (typeof perm !== 'object' || Array.isArray(perm)) return { reason: 'its permission value is not a map' };
  const rules = [];
  for (const [action, value] of Object.entries(perm)) {
    if (typeof value === 'string' && effectOk(value)) rules.push({ action, resource: '*', effect: value });
    else if (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(effectOk)) {
      for (const [resource, effect] of Object.entries(value)) rules.push({ action, resource, effect });
    } else return { reason: `permission.${action} is not allow, deny, ask or a map of them` };
  }
  return rules;
}

/** An OpenCode origin's restriction as Claude tools/disallowedTools, or { reason }. */
function fromOpenCode(data) {
  const rules = openCodeRules(data);
  if (!Array.isArray(rules)) return rules;
  const known = new Set(OC_ACTIONS.map(([a]) => a));
  for (const r of rules) {
    if (r.action !== '*' && !known.has(OC_ALIAS[r.action] ?? r.action)) return { reason: `its OpenCode rule for ${r.action} names a tool or pattern no other host has a name for` };
  }
  // the last matching rule wins; a rule for one resource (a command or path pattern) after the last
  // whole-action rule makes the action depend on what it touches, which no other host can say
  const verdict = (action) => {
    let v;
    let partial = false;
    for (const r of rules) {
      if (r.action !== '*' && (OC_ALIAS[r.action] ?? r.action) !== action) continue;
      if (r.resource === '*') {
        v = r.effect;
        partial = false;
      } else partial = true;
    }
    if (partial) return { reason: `OpenCode allows ${action === '*' ? 'every tool' : action} only for some patterns, and that cannot be written without the patterns` };
    if (v === 'ask') return { reason: `OpenCode asks before ${action === '*' ? 'every tool' : action}; allowing it would be broader and denying it narrower than written` };
    return { v };
  };
  const base = verdict('*');
  if (base.reason) return base;
  const allowlist = base.v === 'deny';
  const tools = [];
  const disallowedTools = [];
  for (const [action, members] of OC_ACTIONS) {
    const r = verdict(action);
    if (r.reason) return r;
    if (allowlist && r.v === 'allow') tools.push(...members);
    if (!allowlist && r.v === 'deny') disallowedTools.push(...members);
  }
  return { tools: allowlist ? tools : null, disallowedTools };
}

/** An agy origin's tools list as Claude tools: a Claude tool is granted only when agy grants every one of its agy tools. */
function fromAgy(data) {
  if (data.tools === undefined || data.tools === null) return { tools: null, disallowedTools: [] };
  if (!Array.isArray(data.tools) || data.tools.some((t) => typeof t !== 'string')) return { reason: 'its agy tools value is not a list of tool names' };
  const unknown = data.tools.filter((t) => !AGY_ALL.includes(t));
  if (unknown.length) return { reason: `the agy tool(s) ${unknown.join(', ')} have no name on other hosts` };
  const granted = new Set(data.tools);
  const tools = Object.entries(TOOL_MAP)
    .filter(([, t]) => Array.isArray(t.agy) && t.agy.length > 0 && t.agy.every((n) => granted.has(n)))
    .map(([name]) => name);
  return { tools, disallowedTools: [] };
}

/** The source's restriction in Claude terms ({ tools, disallowedTools }), read in its origin's own format, or { reason }. */
export function sourceRestrictions(origin, data) {
  if (origin === 'opencode') return fromOpenCode(data);
  if (origin === 'agy') return fromAgy(data);
  return { tools: data.tools, disallowedTools: data.disallowedTools };
}

// Frontmatter keys that restrict or extend an agent in a way no other host expresses, per origin:
// a host other than the origin refuses an agent that has one, rather than render it without.
// agy's mcpServers declares the agent's own MCP servers (agy-setup.mjs renders one per agent),
// which a Claude or OpenCode copy would silently lose (board 83a09944).
const NON_PORTABLE_KEYS = { claude: ['hooks', 'mcpServers', 'permissionMode', 'isolation'], opencode: [], agy: ['mcpServers'] };

/**
 * Why `host` cannot carry the restrictions of a source written for `origin`, or null when it can.
 * The origin host always can: it gets the author's own lines.
 */
export function hostRestrictionRefusal(host, origin, data) {
  if (host === origin) return null;
  const bad = NON_PORTABLE_KEYS[origin].filter((k) => k in data);
  if (bad.length) return `${host} cannot express the frontmatter key(s) ${bad.join(', ')}`;
  const restr = sourceRestrictions(origin, data);
  if (restr.reason) return `${host} cannot be given this ${origin} agent's permissions: ${restr.reason}`;
  if (host === 'claude') {
    const tools = toolList(restr.tools);
    if (tools !== null && tools.length === 0) return 'claude cannot write an agent that may use no tool at all (an empty tools line is read as every tool)';
    return null;
  }
  const t = translateTools(host, restr);
  if (!t.ok) return t.reason;
  if (host === 'agy' && Array.isArray(t.tools) && t.tools.length === 0) return 'agy cannot write an agent that may use no tool at all';
  return null;
}

// ── source parsing ───────────────────────────────────────────────────────────
export function parseSource(text) {
  const m = normalize(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { error: 'the source has no frontmatter block' };
  let data;
  try {
    data = load(m[1], { schema: CORE_SCHEMA });
  } catch (err) {
    return { error: `the source frontmatter is not valid YAML: ${err.message.split('\n')[0]}` };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) return { error: 'the source frontmatter is not a mapping' };
  return { frontmatter: m[1], body: m[2], data };
}

// ── hosts ────────────────────────────────────────────────────────────────────
/**
 * Which hosts are installed: claude when the project has a .claude folder (Claude Code has no
 * version probe in Sterling), opencode and agy by the probes setupOpenCode and setupAgy use.
 * `probes` is the seam tests use.
 */
export function detectInstalledHosts(projectRoot, { env = process.env, home = homedir(), probes = {} } = {}) {
  const po = probes.opencode ?? probeOpenCode;
  const pa = probes.agy ?? probeAgy;
  return CUSTOM_HOSTS.filter((h) => {
    if (h === 'claude') return existsSync(join(projectRoot, '.claude'));
    if (h === 'opencode') return po({ env, home }).installed === true;
    return pa({ env, home }).installed === true;
  });
}

// ── rendering ────────────────────────────────────────────────────────────────
const yamlString = (s) => JSON.stringify(s);

function stamp(host, key, sourceHash, content) {
  return `<!-- sterling-custom renderer=${CUSTOM_RENDERER} host=${host} key=${key} source_hash=${sourceHash} content_hash=${sha256(content)} -->`;
}

function withStamp(frontmatterBlock, body, host, key, sourceHash) {
  const content = `${frontmatterBlock}\n${body}`;
  return `${frontmatterBlock}\n${stamp(host, key, sourceHash, content)}\n${body}`;
}

/**
 * Render one agent for one host. Returns { ok: true, name, content } or { ok: false, reason }.
 * `source` is parseSource output, `entry` the agent's canonical config.models entry ({ model?,
 * effort? }, the model <provider>/<id>; planCustomAgents reads it through toCanonicalConfig).
 * A host that cannot run the entry's model is refused (hostRunsModel; decision
 * settings-redesign-build-shape-one-legacy-to-canonical-config). The source's origin host
 * (ORIGIN_FIELD, Claude when absent) gets the author's frontmatter as written; every other host
 * gets the origin's restrictions translated, or a refusal. `overpassProvider` maps an
 * overpass/<tier> model on OpenCode.
 */
export function renderCustomAgent({ host, key, name, source, entry, sourceHash, overpassProvider = DEFAULT_OVERPASS_PROVIDER }) {
  const { data, body } = source;
  const cfg = entry ?? {};
  if (cfg.model && !hostRunsModel(cfg.model, host)) return { ok: false, reason: `${host} cannot run ${cfg.model}, the model config.models.${key} names` };
  const o = originOf(data);
  if (o.error) return { ok: false, reason: o.error };
  const origin = o.origin;
  const srcModel = typeof data.model === 'string' ? data.model : undefined;
  if (host === origin) {
    // Everything the author wrote stays; the model (and Claude's effort) is replaced only where config names one.
    let fm = withoutOrigin(source.frontmatter);
    const setLine = (field, value) => {
      const re = new RegExp(`^${field}:.*$`, 'm');
      fm = re.test(fm) ? fm.replace(re, `${field}: ${value}`) : `${fm}\n${field}: ${value}`;
    };
    if (host === 'claude') {
      const resolved = resolveHostSettings({ model: cfg.model, effort: cfg.effort }, 'claude');
      if (cfg.model) setLine('model', resolved.model);
      if (cfg.effort && resolved.effort) setLine('effort', resolved.effort);
      if (!/^name:/m.test(fm)) fm = `name: ${name}\n${fm}`;
    } else if (host === 'opencode') {
      const resolved = resolveHostSettings({ model: cfg.model }, 'opencode');
      if (cfg.model && resolved.model !== 'inherit') setLine('model', opencodeModelRef(resolved.model, overpassProvider));
    } else if (cfg.model) {
      // agy agent files name the bare enum value (agy/flash renders flash); renderCustomAgent refused any other model above.
      setLine('model', resolveHostSettings({ model: cfg.model }, 'agy').model);
    }
    return { ok: true, name, content: withStamp(`---\n${fm}\n---`, body, host, key, sourceHash) };
  }
  const refusal = hostRestrictionRefusal(host, origin, data);
  if (refusal) return { ok: false, reason: refusal };
  if (typeof data.description !== 'string' || data.description.trim() === '') return { ok: false, reason: `${host} needs a description in the source frontmatter` };
  const restr = sourceRestrictions(origin, data);
  if (host === 'claude') {
    // a Claude copy of another host's agent: its name, description and the translated tools lines
    const fromOc = origin === 'opencode' ? /^anthropic\/(claude-.+)$/.exec(srcModel ?? '')?.[1] : undefined;
    const resolved = resolveHostSettings({ model: cfg.model, effort: cfg.effort }, 'claude');
    const lines = ['---', `name: ${name}`, `description: ${yamlString(data.description)}`];
    if (cfg.model || fromOc) lines.push(`model: ${cfg.model ? resolved.model : fromOc}`);
    if (cfg.effort && resolved.effort) lines.push(`effort: ${resolved.effort}`);
    const tools = toolList(restr.tools);
    const denied = toolList(restr.disallowedTools) ?? [];
    if (tools !== null) lines.push(`tools: ${tools.join(', ')}`);
    if (denied.length) lines.push(`disallowedTools: ${denied.join(', ')}`);
    lines.push('---');
    return { ok: true, name, content: withStamp(lines.join('\n'), body, host, key, sourceHash) };
  }
  const translated = translateTools(host, restr);
  if (host === 'opencode') {
    const claudeModel = origin === 'claude' && srcModel?.startsWith('claude-') ? srcModel : undefined;
    const resolved = resolveHostSettings({ model: cfg.model ?? claudeModel }, 'opencode');
    const lines = ['---', `description: ${yamlString(data.description)}`, 'mode: subagent'];
    if (resolved.model !== 'inherit') lines.push(`model: ${opencodeModelRef(resolved.model, overpassProvider)}`);
    if (translated.rules.length) lines.push('permission:', ...translated.rules.map((r) => `  ${r.action === '*' ? '"*"' : r.action}: ${r.verdict}`));
    lines.push('---');
    return { ok: true, name, content: withStamp(lines.join('\n'), body, host, key, sourceHash) };
  }
  const resolved = resolveHostSettings({ model: cfg.model }, 'agy');
  const lines = ['---', `name: ${name}`, `description: ${yamlString(data.description)}`, `model: ${resolved.model}`, 'mainAgent: false', 'subagent: true'];
  if (translated.tools !== null) lines.push('tools:', ...translated.tools.map((t) => `  - ${t}`));
  lines.push('---');
  return { ok: true, name, content: withStamp(lines.join('\n'), body, host, key, sourceHash) };
}

// ── files ────────────────────────────────────────────────────────────────────
/** The first path component under root that is a symlink, or null. */
function symlinkIn(root, rel) {
  let p = root;
  for (const part of rel.split('/')) {
    p = join(p, part);
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    }
    if (st.isSymbolicLink()) return p;
  }
  return null;
}

/** Read one generated-file target: { state: 'absent' | 'owned' | 'refused', ... }. A path in `vacated` reads as absent. */
function inspectTarget(root, rel, host, key, sourcePath, vacated = []) {
  if (vacated.includes(rel)) return { state: 'absent' };
  const link = symlinkIn(root, rel);
  if (link) return { state: 'refused', reason: `${rel} is reached through the symlink ${link}; Sterling does not write through links` };
  const path = join(root, rel);
  if (!existsSync(path)) return { state: 'absent' };
  if (!lstatSync(path).isFile()) return { state: 'refused', reason: `${rel} exists and is not a file` };
  const disk = normalize(readFileSync(path, 'utf8'));
  const h = disk.match(STAMP_RE);
  if (!h) return { state: 'refused', reason: `${rel} carries no Sterling stamp (a file Sterling did not write); the agent's source is ${sourcePath ?? AGENT_SOURCE_DIR}. Move it aside or delete it, then sync again` };
  if (h[2] !== host || h[3] !== key) return { state: 'refused', reason: `${rel} is stamped for ${h[2]}:${h[3]}, not ${host}:${key}; it is not overwritten` };
  if (sha256(disk.replace(`${h[0]}\n`, '')) !== h[5]) return { state: 'refused', reason: `${rel} was edited after Sterling wrote it; edit the source ${sourcePath} instead, or delete the copy so Sterling can regenerate it` };
  return { state: 'owned', disk };
}

/** Every stamped custom-agent output in the three host folders: [{host, key, rel}]. */
function stampedOutputs(root) {
  const out = [];
  const scan = (host, rel) => {
    const dir = join(root, rel);
    // a regular file where the folder belongs holds no stamped copy; the portable-agent sync reports it as its own refusal
    if (!existsSync(dir) || symlinkIn(root, rel) || !lstatSync(dir).isDirectory()) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (host === 'agy' ? !e.isDirectory() : !(e.isFile() && e.name.endsWith('.md'))) continue;
      const fileRel = host === 'agy' ? `${rel}/${e.name}/agent.md` : `${rel}/${e.name}`;
      if (!existsSync(join(root, fileRel)) || !lstatSync(join(root, fileRel)).isFile()) continue;
      const m = normalize(readFileSync(join(root, fileRel), 'utf8')).match(STAMP_RE);
      if (m && m[2] === host) out.push({ host, key: m[3], rel: fileRel });
    }
  };
  scan('claude', '.claude/agents');
  scan('opencode', '.opencode/agents');
  scan('agy', AGY_AGENTS_DIR);
  return out;
}

/** True when any host folder holds a stamped custom-agent copy: the sync has outputs to reconcile even with no custom key left. */
export function hasCustomOutputs(projectRoot) {
  return stampedOutputs(projectRoot).length > 0;
}

function readSources(root) {
  const dir = join(root, AGENT_SOURCE_DIR);
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue;
    const key = f.slice(0, -3);
    if (!CUSTOM_AGENT_KEY_RE.test(key)) continue;
    out.set(key, { key, path: `${AGENT_SOURCE_DIR}/${f}` });
  }
  return out;
}

/**
 * Plan the sync without writing: { ops, written, unchanged, refused, removed, skipped }.
 * ops are { path, content, previous } (content null removes the file).
 * `pending` ({ key, text }) plans a source that is not on disk yet, and `vacated` lists paths to
 * read as absent: together they plan an adoption before anything moves (the original leaves its
 * host folder and the source arrives in agent-sources/).
 */
export function planCustomAgents(projectRoot, config, { hosts, pending, vacated = [] } = {}) {
  const root = projectRoot;
  // One model per agent: the entries are read through the legacy-to-canonical transform. An agent
  // whose legacy entry still names two models is not rendered and its copies stay as they are
  // (`frozen`) until /sterling:update asks which to keep.
  const { config: canon, conflicts } = toCanonicalConfig(config ?? {});
  const models = canon?.models ?? {};
  const overpassProvider = canon?.overpass?.provider ?? DEFAULT_OVERPASS_PROVIDER;
  const frozen = new Set(conflicts.map((c) => c.role));
  const result = { ops: [], written: [], unchanged: [], refused: [], removed: [], skipped: [] };
  const targetHosts = hosts ?? CUSTOM_HOSTS;
  const sources = readSources(root);
  if (pending) sources.set(pending.key, { key: pending.key, path: `${AGENT_SOURCE_DIR}/${pending.key}.md`, text: pending.text });
  const live = new Set();
  // every (host, key, path) this run renders: a stamped copy outside this set is obsolete
  const desired = new Set();
  const slot = (host, key, rel) => `${host}\0${key}\0${rel}`;
  const refuse = (key, host, reason, path) => result.refused.push({ key, host, reason, ...(path ? { path } : {}) });

  // Parse every source once, then check output-name collisions across agents.
  const agents = [];
  for (const [key, src] of sources) {
    if (!Object.hasOwn(models, key)) {
      result.skipped.push({ key, reason: `config.models has no ${key} entry` });
      continue;
    }
    const full = join(root, src.path);
    if (src.text === undefined && symlinkIn(root, src.path)) {
      refuse(key, '*', `${src.path} is a symlink; Sterling does not read an agent through a link`, src.path);
      live.add(key);
      continue;
    }
    const text = src.text ?? readFileSync(full, 'utf8');
    const source = parseSource(text);
    live.add(key);
    if (source.error) {
      refuse(key, '*', `${src.path}: ${source.error}`, src.path);
      continue;
    }
    const declared = typeof source.data.name === 'string' ? source.data.name : undefined;
    const name = declared ?? key.slice('custom-'.length);
    if (!CUSTOM_AGENT_SLUG_RE.test(name) || customAgentSlug(name) !== name) {
      refuse(key, '*', `${src.path}: the agent name ${JSON.stringify(name)} must be lower-case letters, digits and single hyphens to name a file on every host`, src.path);
      continue;
    }
    if (RESERVED_NAMES.has(name)) {
      refuse(key, '*', `${src.path}: the name ${name} belongs to a Sterling role, so no host file is written for it`, src.path);
      continue;
    }
    if (frozen.has(key)) {
      refuse(key, '*', `${twoModelsReason(key)}; its copies are left as they are until then`, src.path);
      continue;
    }
    agents.push({ key, src, source, name, entry: models[key], sourceHash: sha256(normalize(text)) });
  }
  const byName = new Map();
  for (const a of agents) byName.set(a.name, [...(byName.get(a.name) ?? []), a.key]);
  for (const a of agents) {
    const same = byName.get(a.name);
    if (same.length > 1) {
      refuse(a.key, '*', `${a.src.path}: the name ${a.name} is also the output name of ${same.filter((k) => k !== a.key).join(', ')}; rename one`, a.src.path);
      continue;
    }
    for (const host of targetHosts) {
      const rel = outputPath(host, a.name);
      let r;
      try {
        r = renderCustomAgent({ host, key: a.key, name: a.name, source: a.source, entry: a.entry, sourceHash: a.sourceHash, overpassProvider });
      } catch (err) {
        r = { ok: false, reason: err.message };
      }
      if (!r.ok) {
        refuse(a.key, host, `${r.reason}; ${host} gets no copy of ${a.src.path}`, rel);
        continue;
      }
      desired.add(slot(host, a.key, rel));
      const t = inspectTarget(root, rel, host, a.key, a.src.path, vacated);
      if (t.state === 'refused') {
        refuse(a.key, host, t.reason, rel);
        continue;
      }
      if (t.state === 'owned' && t.disk === r.content) {
        result.unchanged.push({ key: a.key, host, path: rel });
        continue;
      }
      result.written.push({ key: a.key, host, path: rel, status: t.state === 'absent' ? 'created' : 'refreshed' });
      result.ops.push({ path: rel, content: r.content, previous: t.state === 'owned' ? t.disk : null });
    }
  }
  // Removal, by the desired set: a stamped output that this run does not render at that path is
  // obsolete (its agent is gone, its source no longer parses, the host now refuses it, or its name
  // changed) and is removed when unedited, so a broader earlier copy never stays installed. An
  // edited one is kept and reported. The one exception: an output of a live agent on a host this
  // run was not asked to render stays as it is.
  for (const o of stampedOutputs(root)) {
    if (desired.has(slot(o.host, o.key, o.rel))) continue;
    if (live.has(o.key) && !targetHosts.includes(o.host)) continue;
    if (frozen.has(o.key)) continue;
    const why = !live.has(o.key) ? 'its agent is gone' : 'Sterling no longer generates this copy for the current source';
    const t = inspectTarget(root, o.rel, o.host, o.key, `${AGENT_SOURCE_DIR}/${o.key}.md`, vacated);
    if (t.state === 'owned') {
      result.removed.push({ key: o.key, host: o.host, path: o.rel });
      result.ops.push({ path: o.rel, content: null, previous: t.disk });
    } else if (t.state === 'refused') {
      refuse(o.key, o.host, `${t.reason} (kept and still installed: ${why}, but the file is not an unedited Sterling copy, so it is not deleted; it may allow more than the source now does, so remove it by hand)`, o.rel);
    }
  }
  return result;
}

function restore(root, done) {
  const failed = [];
  for (const op of done.reverse()) {
    try {
      const path = join(root, op.path);
      if (op.previous === null) {
        rmSync(path, { force: true });
        pruneEmptyAgyDir(root, op.path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomicIfChanged(path, op.previous);
      }
    } catch (err) {
      failed.push(`${op.path}: ${err.message}`);
    }
  }
  if (failed.length) throw new Error(`could not restore ${failed.join('; ')}`);
}

function pruneEmptyAgyDir(root, rel) {
  if (!rel.startsWith(`${AGY_AGENTS_DIR}/`)) return;
  const dir = join(root, dirname(rel));
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Render every adopted agent to every installed host. `hosts` defaults to detectInstalledHosts;
 * `dryRun` returns the plan without writing; `pending` and `vacated` are planCustomAgents'.
 * `requireClean` lists keys that must render with no refusal: when one has any, the run throws
 * before writing anything. Returns { written, unchanged, refused, removed, skipped, dryRun }. All
 * writes are atomic; when one fails the ones already made are put back (the `done` journal) and
 * the error is rethrown, so the run converges fully or leaves the folders as they were.
 */
export function syncCustomAgents(projectRoot, config, { hosts, dryRun = false, env, home, probes, pending, vacated, requireClean = [] } = {}) {
  const chosen = hosts ?? detectInstalledHosts(projectRoot, { env, home, probes });
  const plan = planCustomAgents(projectRoot, config, { hosts: chosen, pending, vacated });
  const { ops, ...report } = plan;
  if (dryRun) return { ...report, dryRun: true };
  const blocking = report.refused.filter((r) => requireClean.includes(r.key));
  if (blocking.length) throw new Error(blocking.map((r) => `${r.host}: ${r.reason}`).join('; '));
  const done = [];
  try {
    for (const op of ops) {
      const path = join(projectRoot, op.path);
      if (op.content === null) {
        rmSync(path);
        done.push(op);
        pruneEmptyAgyDir(projectRoot, op.path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomicIfChanged(path, op.content);
        done.push(op);
      }
    }
  } catch (err) {
    try {
      restore(projectRoot, done);
    } catch (restoreErr) {
      throw new Error(`${err.message}; rollback: ${restoreErr.message}`, { cause: err });
    }
    throw err;
  }
  return { ...report, dryRun: false };
}
