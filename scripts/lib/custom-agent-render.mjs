// Rendering adopted custom agents into every installed host (decisions
// custom-agents-are-adopted-into-a-source-folder-host-files-are-generated-projections and
// system-tab-redesign-one-agent-table-every-agent-every-host-settings-section; GitHub #312).
//
// An adopted agent is agent-sources/<key>.md (Claude-style frontmatter and body, written by
// adopt() in agent-adoption.mjs) plus config.models.<key>. syncCustomAgents renders it to
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
// NEVER BROADER. A restriction that a host cannot express refuses that host for that agent with
// a reason; it is never dropped (decision 4736b9ef). See translateTools for the mapping.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CORE_SCHEMA, load } from 'js-yaml';
import { AGENT_MODEL_KEY, CUSTOM_AGENT_KEY_RE, CUSTOM_AGENT_SLUG_RE, customAgentSlug, resolveHostSettings } from '@sterling/schemas';
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

// ── source parsing ───────────────────────────────────────────────────────────
// Frontmatter keys that restrict or extend an agent in a way no other host expresses: a host
// other than Claude refuses an agent that has one, rather than render it without.
const NON_PORTABLE_KEYS = ['hooks', 'mcpServers', 'permissionMode', 'isolation'];

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
 * `source` is parseSource output, `entry` the agent's config.models entry (any field may be absent).
 */
export function renderCustomAgent({ host, key, name, source, entry, sourceHash }) {
  const { data, body } = source;
  const cfg = entry ?? {};
  const srcModel = typeof data.model === 'string' ? data.model : undefined;
  if (host === 'claude') {
    // Everything the author wrote stays; model and effort are replaced only where config names one.
    const resolved = resolveHostSettings({ model: cfg.model, effort: cfg.effort }, 'claude');
    let fm = source.frontmatter;
    const setLine = (field, value) => {
      const re = new RegExp(`^${field}:.*$`, 'm');
      fm = re.test(fm) ? fm.replace(re, `${field}: ${value}`) : `${fm}\n${field}: ${value}`;
    };
    if (cfg.model) setLine('model', cfg.model);
    if (cfg.effort && resolved.effort) setLine('effort', resolved.effort);
    if (!/^name:/m.test(fm)) fm = `name: ${name}\n${fm}`;
    return { ok: true, name, content: withStamp(`---\n${fm}\n---`, body, host, key, sourceHash) };
  }
  const bad = NON_PORTABLE_KEYS.filter((k) => k in data);
  if (bad.length) return { ok: false, reason: `${host} cannot express the frontmatter key(s) ${bad.join(', ')}` };
  if (typeof data.description !== 'string' || data.description.trim() === '') return { ok: false, reason: `${host} needs a description in the source frontmatter` };
  const translated = translateTools(host, data);
  if (!translated.ok) return translated;
  if (host === 'opencode') {
    const resolved = resolveHostSettings({ model: cfg.model ?? (srcModel?.startsWith('claude-') ? srcModel : undefined), opencode_model: cfg.opencode_model }, 'opencode');
    const lines = ['---', `description: ${yamlString(data.description)}`, 'mode: subagent'];
    if (resolved.model !== 'inherit') lines.push(`model: ${resolved.model}`);
    if (translated.rules.length) lines.push('permission:', ...translated.rules.map((r) => `  ${r.action === '*' ? '"*"' : r.action}: ${r.verdict}`));
    lines.push('---');
    return { ok: true, name, content: withStamp(lines.join('\n'), body, host, key, sourceHash) };
  }
  const resolved = resolveHostSettings({ agy_model: cfg.agy_model }, 'agy');
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

/** Read one generated-file target: { state: 'absent' | 'owned' | 'refused', ... }. */
function inspectTarget(root, rel, host, key, sourcePath) {
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
    if (!existsSync(dir) || symlinkIn(root, rel)) return;
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
 */
export function planCustomAgents(projectRoot, config, { hosts } = {}) {
  const root = projectRoot;
  const models = config?.models ?? {};
  const result = { ops: [], written: [], unchanged: [], refused: [], removed: [], skipped: [] };
  const targetHosts = hosts ?? CUSTOM_HOSTS;
  const sources = readSources(root);
  const live = new Set();
  const refuse = (key, host, reason, path) => result.refused.push({ key, host, reason, ...(path ? { path } : {}) });

  // Parse every source once, then check output-name collisions across agents.
  const agents = [];
  for (const [key, src] of sources) {
    if (!Object.hasOwn(models, key)) {
      result.skipped.push({ key, reason: `config.models has no ${key} entry` });
      continue;
    }
    const full = join(root, src.path);
    if (symlinkIn(root, src.path)) {
      refuse(key, '*', `${src.path} is a symlink; Sterling does not read an agent through a link`, src.path);
      live.add(key);
      continue;
    }
    const text = readFileSync(full, 'utf8');
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
        r = renderCustomAgent({ host, key: a.key, name: a.name, source: a.source, entry: a.entry, sourceHash: a.sourceHash });
      } catch (err) {
        r = { ok: false, reason: err.message };
      }
      if (!r.ok) {
        refuse(a.key, host, `${r.reason}; ${host} gets no copy of ${a.src.path}`, rel);
        continue;
      }
      const t = inspectTarget(root, rel, host, a.key, a.src.path);
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
  // Removal: a stamped output whose agent is no longer live, and only when it is unedited. An output
  // of a live agent that this run did not render (a host not asked for) stays.
  for (const o of stampedOutputs(root)) {
    if (live.has(o.key)) continue;
    const t = inspectTarget(root, o.rel, o.host, o.key, `${AGENT_SOURCE_DIR}/${o.key}.md`);
    if (t.state === 'owned') {
      result.removed.push({ key: o.key, host: o.host, path: o.rel });
      result.ops.push({ path: o.rel, content: null, previous: t.disk });
    } else if (t.state === 'refused') {
      refuse(o.key, o.host, `${t.reason} (kept: its agent is gone but the file is not an unedited Sterling copy)`, o.rel);
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
 * `dryRun` returns the plan without writing. Returns { written, unchanged, refused, removed, skipped,
 * dryRun }. All writes are atomic; when one fails the ones already made are put back and the error
 * is rethrown, so the run converges fully or leaves the folders as they were.
 */
export function syncCustomAgents(projectRoot, config, { hosts, dryRun = false, env, home, probes } = {}) {
  const chosen = hosts ?? detectInstalledHosts(projectRoot, { env, home, probes });
  const plan = planCustomAgents(projectRoot, config, { hosts: chosen });
  const { ops, ...report } = plan;
  if (dryRun) return { ...report, dryRun: true };
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
