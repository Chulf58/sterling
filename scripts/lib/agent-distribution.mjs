// Agent distribution core (spec §2.2, §12, §13, §16.1 Slice 1).
// The plugin is the distributor; THE PROJECT IS THE ENFORCEMENT SURFACE:
// templates ship in agent-templates/ (never platform-served), and concrete
// agents are generated into the target project's .claude/agents/ with a
// header carrying plugin version + template hash + content hash.
//
// State lives in the generated headers themselves — no side manifest to desync (P5).

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, lstatSync, unlinkSync, renameSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_MODEL_KEY, AGENT_TOOL_NAME_RE } from '@sterling/schemas';
import { MCP_PREFIXES } from './checks.mjs';
import { renderClaudeText } from './agent-fences.mjs';

// Dead-term check (spec §0.4, CLAUDE.md conduct rules): no residue of the
// predecessor's vocabulary in anything shipped, scaffolded, or generated.
export const DEAD_TERM_PATTERNS = [
  { term: 'Forge', re: /\bforge\b/i },
  { term: 'Quatermain/Quartermain(e)', re: /qua(?:rt?|t)ermaine?/i },
  { term: 'wave', re: /\bwaves?\b/i },
  { term: 'brainstormer', re: /brainstormers?/i },
];

export function findDeadTerms(text) {
  const hits = [];
  for (const { term, re } of DEAD_TERM_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ term, match: m[0] });
  }
  return hits;
}

// Strict variant for raw SOURCE-CODE scanning (board 481c9ec3, measured
// 2026-08-25): the case-insensitive whole-word DEAD_TERM_PATTERNS above is
// correct for shipped/scaffolded USER-FACING content (agent templates,
// generated CLAUDE.md, commands/skills prose, the hook-injection surface)
// where the banned codename can plausibly appear in any casing — but widening
// the scan to raw package source (packages/*/src, board c05da1d1) turned it
// into a false-positive generator: ordinary English verbs/nouns ('forge an
// id', 'a wave of calls') in code comments are not codename residue. A real
// codename residue in source is a standalone CAPITALIZED token — nobody
// writes the banned product name in lowercase mid-sentence there. Terms with
// no ordinary-English collision (Quatermain, brainstormer) keep whole-word
// case-insensitive matching; 'wave' has no capitalized-codename form distinct
// from the common noun, so per the item's own remedy it is dropped from the
// strict source scan rather than force-matched into false positives.
export const STRICT_DEAD_TERM_PATTERNS = [
  { term: 'Forge', re: /\bForge\b/ },
  { term: 'Quatermain/Quartermain(e)', re: /qua(?:rt?|t)ermaine?/i },
  { term: 'brainstormer', re: /brainstormers?/i },
];

export function findDeadTermsStrict(text) {
  const hits = [];
  for (const { term, re } of STRICT_DEAD_TERM_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ term, match: m[0] });
  }
  return hits;
}

// Line endings are normalized before hashing so checkout/editor CRLF churn in a
// target project never reads as a local modification.
const normalize = (s) => s.replace(/\r\n/g, '\n');

export function sha256(text) {
  return createHash('sha256').update(normalize(text), 'utf8').digest('hex');
}

export function parseTemplate(content, label) {
  const m = normalize(content).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`template ${label}: missing frontmatter block`);
  const [, frontmatter, body] = m;
  const nameMatch = frontmatter.match(/^name:\s*(\S+)\s*$/m);
  if (!nameMatch) throw new Error(`template ${label}: missing 'name' in frontmatter`);
  return { name: nameMatch[1], frontmatter, body };
}

// Hook command emission rule (spec §6, probe-verified): on Windows, hook
// commands run under git bash — a backslash path in an emitted command string
// is silently mangled and the hook degrades to a non-blocking no-op. Every
// emitted hook command must use quoted forward-slash paths. Refuse to emit
// otherwise; this is enforcement vanishing, not a style issue.
export function findBackslashHookCommands(frontmatter) {
  const bad = [];
  for (const m of frontmatter.matchAll(/^\s*command:\s*(.+)$/gm)) {
    if (m[1].includes('\\')) bad.push(m[1].trim());
  }
  return bad;
}

export const HEADER_RE =
  /^<!-- sterling-generated v=(\S+) template=(\S+) template_hash=([0-9a-f]{64}) content_hash=([0-9a-f]{64}) installed_at=(\S+) -->$/m;

// Per-agent model/effort resolution (design 98064d77 §a): model:/effort: in the
// shipped templates are {{MODEL}}/{{EFFORT}} substitution tokens, resolved at
// render time from config.models via AGENT_MODEL_KEY (reviewers fold to one key).
// Token-GATED: a template carrying no {{MODEL}}/{{EFFORT}} needs no config at all
// (config stays optional), so a token-free template renders byte-identically with
// or without config. When the tokens ARE present, config.models must resolve them
// or we refuse loudly (P5) rather than emit a half-baked frontmatter.
function resolveModelVars(templateContent, label, config) {
  if (!/\{\{MODEL\}\}|\{\{EFFORT\}\}/.test(templateContent)) return {};
  const { name } = parseTemplate(templateContent, label);
  const key = AGENT_MODEL_KEY[name];
  if (!key) {
    throw new Error(`model resolution failed for ${label}: agent '${name}' has no AGENT_MODEL_KEY entry — cannot resolve {{MODEL}}/{{EFFORT}}`);
  }
  const entry = config && config.models && config.models[key];
  if (!entry || typeof entry.model !== 'string' || typeof entry.effort !== 'string') {
    throw new Error(`model resolution failed for ${label}: config.models['${key}'] is missing model/effort — a tokenized template needs config.models (P5)`);
  }
  return { MODEL: entry.model, EFFORT: entry.effort };
}

// Per-project tool extension (decision
// per-project-agent-extra-tools-config-appended-at-render, 587472e3):
// config.agents[<name>].extra_tools is appended, de-duplicated, to the rendered
// tools: line. Templates carry no token, so template_hash stays the raw template
// hash; content_hash covers the rendered frontmatter, so the result is not
// locally modified. Refused loudly (P5): an entry that is not one tool name (the
// value lands in frontmatter — a newline could inject hooks:), an agent with no
// tools: line (the main-session conductor and the inherit-all implementor,
// decision bc1894e5, inherit every tool — nothing to extend), and any entry
// that would grant Sterling MCP tools — including the whole-server form
// (`mcp__sterling`) and a wildcard spanning a Sterling prefix (`mcp__*`) —
// because Sterling grants stay the template's job (decision b4388c11).
function refusesSterlingGrant(entry) {
  // lowercased: the prefixes are lowercase, and a case variant must not slip past
  const lower = entry.toLowerCase();
  const wildcard = lower.endsWith('*');
  const stem = wildcard ? lower.slice(0, -1) : lower;
  return MCP_PREFIXES.some((p) => stem.startsWith(p) || stem === p.slice(0, -2) || (wildcard && p.startsWith(stem)));
}

function appendExtraTools(frontmatter, name, label, config) {
  const agentEntry = config?.agents?.[name];
  // The schema is lenient (passthrough) so a typo never breaks parseConfig;
  // refuse it here instead, by name — a silently ignored typo would grant nothing.
  const unknownKey = Object.keys(agentEntry ?? {}).find((key) => key !== 'extra_tools');
  if (unknownKey !== undefined) {
    throw new Error(`config.agents.${name}: unknown key '${unknownKey}' (${label}) — the only key is extra_tools (P5)`);
  }
  const extras = agentEntry?.extra_tools ?? [];
  if (!Array.isArray(extras)) {
    throw new Error(`config.agents.${name}.extra_tools (${label}) is not an array (got ${extras === null ? 'null' : typeof extras}) — it must be an array of tool names (P5)`);
  }
  if (extras.length === 0) return frontmatter;
  for (const entry of extras) {
    if (typeof entry !== 'string' || !AGENT_TOOL_NAME_RE.test(entry)) {
      throw new Error(`extra_tools for '${name}' (${label}): ${JSON.stringify(entry)} is not a valid tool name — one name, optional trailing *, no commas/whitespace/newlines (P5)`);
    }
    if (refusesSterlingGrant(entry)) {
      throw new Error(`extra_tools for '${name}' (${label}): '${entry}' would grant Sterling MCP tools — Sterling grants stay the template's job (decision b4388c11); remove it from config.agents.${name}.extra_tools`);
    }
  }
  const lines = frontmatter.split('\n');
  const idx = lines.findIndex((line) => /^tools:/.test(line));
  if (idx === -1) {
    throw new Error(`extra_tools for '${name}' (${label}): the agent has no tools: line, so it inherits every session tool (the main-session conductor, or an inherit-all agent such as the implementor, decision bc1894e5) and there is no allowlist to extend — remove config.agents.${name}`);
  }
  const tools = lines[idx].replace(/^tools:\s*/, '').split(',').map((t) => t.trim()).filter(Boolean);
  for (const entry of extras) if (!tools.includes(entry)) tools.push(entry);
  lines[idx] = `tools: ${tools.join(', ')}`;
  return lines.join('\n');
}

export function renderInstalledAgent(templateContent, label, { pluginVersion, now, vars = {}, config } = {}) {
  // Install-time variable substitution: installed agents are project-side and
  // cannot use ${CLAUDE_PLUGIN_ROOT}; templates carry {{NODE}}/{{HOOKS_DIR}}
  // tokens that install bakes to machine-detected forward-slash paths (§6
  // emission rule — the backslash check below guards the substituted result) and
  // {{MODEL}}/{{EFFORT}} tokens resolved per agent from config.models (98064d77).
  const allVars = { ...vars, ...resolveModelVars(templateContent, label, config) };
  // Fences (agent-fences.mjs): the Claude render keeps sterling-only content and
  // drops only its marker lines, and drops portable-only blocks whole, so a fenced
  // template installs byte-identically to its unfenced form. template_hash below
  // stays the hash of the RAW template.
  let substituted = renderClaudeText(templateContent, label);
  for (const [key, value] of Object.entries(allVars)) {
    substituted = substituted.split(`{{${key}}}`).join(value);
  }
  const parsed = parseTemplate(substituted, label);
  const { name, body } = parsed;
  const frontmatter = appendExtraTools(parsed.frontmatter, name, label, config);
  // WHOLE rendered template, not just the frontmatter: templates now carry
  // substitution tokens in the BODY too ({{GIT_RO}} — the absolute path H14
  // grants for read-only git), and a forgotten body variable would otherwise
  // ship silently as literal '{{GIT_RO}}' in an installed agent's prose, i.e. an
  // instruction the agent cannot run. Same P5 refusal either way. Verified
  // 2026-09-01 that no shipped template body carries a literal '{{…}}' as prose
  // rather than as a variable, so nothing legitimate is caught by widening.
  const unsubstituted = substituted.match(/\{\{[A-Z_]+\}\}/);
  if (unsubstituted) {
    throw new Error(`install substitution incomplete for ${label}: '${unsubstituted[0]}' has no value — refusing to install a half-baked agent (P5)`);
  }
  const badCommands = findBackslashHookCommands(frontmatter);
  if (badCommands.length) {
    throw new Error(
      `hook emission backslash check failed for ${label}: ${badCommands.join(' | ')} — emitted hook commands must use quoted forward-slash paths (spec §6)`
    );
  }
  const deadTerms = findDeadTerms(templateContent);
  if (deadTerms.length) {
    throw new Error(`dead-term check failed for ${label}: ${deadTerms.map((h) => h.match).join(', ')}`);
  }
  const withoutHeader = `---\n${frontmatter}\n---\n${body}`;
  const header = `<!-- sterling-generated v=${pluginVersion} template=${name} template_hash=${sha256(templateContent)} content_hash=${sha256(withoutHeader)} installed_at=${now} -->`;
  const installedContent = `---\n${frontmatter}\n---\n${header}\n${body}`;
  return { name, installedContent };
}

export function parseInstalledHeader(content) {
  const m = normalize(content).match(HEADER_RE);
  if (!m) return null;
  const [line, pluginVersion, template, templateHash, contentHash, installedAt] = m;
  return { headerLine: line, pluginVersion, template, templateHash, contentHash, installedAt };
}

export function isLocallyModified(content, header) {
  const withoutHeader = normalize(content).replace(header.headerLine + '\n', '');
  return sha256(withoutHeader) !== header.contentHash;
}

// Machine-activation surface (P5; the 2026-07-03 dead-hooks incident,
// anti_pattern foreign_60e8463d): installed agents bake NODE/HOOKS_DIR into frontmatter
// hook commands at install time (d53dc92c) — an install produced by the OTHER
// machine context (WSL vs native Windows) is self-consistent and
// template-current, so hash bookkeeping alone reads it up_to_date while every
// baked command points at an unresolvable node and every hook fails
// non-blocking. The frontmatter hook command lines ARE that machine surface:
// extract them for drift comparison (syncAgents) and node-path executability
// probing (checkAgentsVisible, H1).
export function extractHookCommandLines(content) {
  const m = normalize(content).match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*command:\s*(.+)$/gm)].map((x) => x[1].trim());
}

// Every double-quoted token of every baked command: the node executable AND
// the hook script path — BOTH must resolve for a hook to run (review follow-up
// on 946125ff: a same-node/different-HOOKS_DIR flip must not slip the probe).
export function extractBakedCommandPaths(content) {
  const paths = new Set();
  for (const line of extractHookCommandLines(content)) {
    for (const m of line.matchAll(/"([^"]+)"/g)) paths.add(m[1]);
  }
  return [...paths];
}

// The frontmatter model:/effort: values of an agent file (null where the header
// carries no such line) — the surface config_drift compares (256d1059).
export function extractModelEffort(content) {
  const m = normalize(content).match(/^---\n([\s\S]*?)\n---\n/);
  const fm = m ? m[1] : '';
  return {
    model: fm.match(/^model:\s*(\S+)\s*$/m)?.[1] ?? null,
    effort: fm.match(/^effort:\s*(\S+)\s*$/m)?.[1] ?? null,
  };
}

// The frontmatter tools: entries of an agent file (null when it carries no tools:
// line) — the second surface config_drift compares (587472e3).
export function extractTools(content) {
  const m = normalize(content).match(/^---\n([\s\S]*?)\n---\n/);
  const line = (m ? m[1] : '').match(/^tools:\s*(.*)$/m);
  return line ? line[1].split(',').map((t) => t.trim()).filter(Boolean) : null;
}

// One description of a config_drift report entry for every printer
// (sync-agents, init): names only the surfaces that actually drifted.
export function describeConfigDrift(r) {
  const parts = [];
  const { installed: i, configured: c } = r;
  if (i.model !== c.model || i.effort !== c.effort) {
    const me = ({ model, effort }) => `model=${model ?? '(none)'} effort=${effort ?? '(none)'}`;
    parts.push(`installed ${me(i)}, config.models resolves ${me(c)}`);
  }
  if (r.tools) {
    const t = [];
    if (r.tools.missing.length) t.push(`missing ${r.tools.missing.join(', ')}`);
    if (r.tools.unexpected.length) t.push(`unexpected ${r.tools.unexpected.join(', ')}`);
    parts.push(`tools: ${t.join('; ')} (installed vs template + config.agents extra_tools)`);
  }
  return parts.join('; ');
}

export const CONFIG_DRIFT_FIX = 'node scripts/install-agents.mjs (--target <dir> for a sibling)';

// Surgical model/effort swap (design 98064d77 §b): the TUI System tab's write
// projection. Given an ALREADY-INSTALLED agent file, rewrite ONLY the frontmatter
// model:/effort: lines and re-stamp the generated header's content_hash, reusing
// this module's sha256/HEADER machinery (6d5935d3) so the result is self-consistent
// (isLocallyModified === false) and a later sync-agents refresh does not read the
// swap as a local modification (AC6). It is deliberately frontmatter-SCOPED: body
// lines that merely start with model:/effort: are left untouched. Machine vars
// (NODE/HOOKS_DIR baked into hook commands) are byte-identical — a swap can NEVER
// flip the WSL↔Windows machine boundary (d53dc92c). template_hash is preserved (a
// swap does not change template identity); installed_at is re-stamped to `now`
// because, like header_repaired, a swap needs a restart to govern dispatch.
export function setInstalledModelEffort(installedContent, { model, effort, pluginVersion, now }) {
  const normalized = normalize(installedContent);
  const header = parseInstalledHeader(normalized);
  if (!header) {
    throw new Error('setInstalledModelEffort: no sterling-generated header — refusing to swap a file this module did not generate');
  }
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('setInstalledModelEffort: missing frontmatter block');
  const frontmatter = m[1]
    .split('\n')
    .map((line) => {
      if (/^model:\s/.test(line)) return `model: ${model}`;
      if (/^effort:\s/.test(line)) return `effort: ${effort}`;
      return line;
    })
    .join('\n');
  // m[2] is `${headerLine}\n${body}` — drop the stale header, keep the body verbatim.
  const body = m[2].replace(header.headerLine + '\n', '');
  const withoutHeader = `---\n${frontmatter}\n---\n${body}`;
  const newHeader =
    `<!-- sterling-generated v=${pluginVersion} template=${header.template} template_hash=${header.templateHash} content_hash=${sha256(withoutHeader)} installed_at=${now} -->`;
  return `---\n${frontmatter}\n---\n${newHeader}\n${body}`;
}

// The portable (OpenCode) roster lives in the registry itself (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections): an entry
// with an `opencode` block is rendered to <target>/.opencode/agents/ by
// scripts/lib/opencode-agents.mjs; an entry without one (librarian, conductor) is
// not. The permission keys and values are the ones OpenCode documents
// (opencode.ai/docs/agents, fetched 2026-09-24); anything else is refused, never
// passed through.
export const OPENCODE_PERMISSION_KEYS = ['edit', 'bash', 'webfetch', 'task'];
export const OPENCODE_PERMISSION_VALUES = ['allow', 'ask', 'deny'];

function validateOpenCodeEntry(entry, where) {
  const block = entry.opencode;
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error(`${where} must be an object`);
  const unknown = Object.keys(block).find((key) => key !== 'permission' && key !== 'description');
  if (unknown !== undefined) throw new Error(`${where}: unknown key '${unknown}' — the keys are permission and description`);
  // description: the portable frontmatter description, for a template whose own
  // description names something an engineer without Sterling does not have.
  if (block.description !== undefined && (typeof block.description !== 'string' || !block.description.trim() || /[\r\n]/.test(block.description))) {
    throw new Error(`${where}.description must be one non-empty line of text`);
  }
  if (block.permission === undefined) return;
  if (!block.permission || typeof block.permission !== 'object' || Array.isArray(block.permission)) throw new Error(`${where}.permission must be an object`);
  for (const [key, value] of Object.entries(block.permission)) {
    if (!OPENCODE_PERMISSION_KEYS.includes(key)) throw new Error(`${where}.permission: unknown key '${key}' (known: ${OPENCODE_PERMISSION_KEYS.join(', ')})`);
    if (!OPENCODE_PERMISSION_VALUES.includes(value)) throw new Error(`${where}.permission.${key}: '${value}' is not one of ${OPENCODE_PERMISSION_VALUES.join(', ')}`);
  }
}

export function loadRegistry(registryPath) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (registry.version !== 1 || !Array.isArray(registry.agents)) {
    throw new Error(`agent registry ${registryPath}: unsupported shape (expected {version: 1, agents: []})`);
  }
  const names = new Set();
  const files = new Set();
  for (const [index, entry] of registry.agents.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`agent registry ${registryPath}: agents[${index}] must be an object`);
    }
    if (typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.name)) {
      throw new Error(`agent registry ${registryPath}: agents[${index}].name must be a safe agent name`);
    }
    if (typeof entry.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/.test(entry.file)) {
      throw new Error(`agent registry ${registryPath}: agents[${index}].file must be a template filename ending in .md`);
    }
    if (entry.opencode !== undefined) validateOpenCodeEntry(entry, `agent registry ${registryPath}: agents[${index}].opencode`);
    if (names.has(entry.name) || files.has(entry.file)) {
      throw new Error(`agent registry ${registryPath}: duplicate agent name or template file at agents[${index}]`);
    }
    names.add(entry.name);
    files.add(entry.file);
  }
  return registry;
}

export const RESTART_INSTRUCTION = [
  '================================================================',
  'RESTART REQUIRED — project subagents load at session start.',
  'Agents installed into .claude/agents/ are NOT visible to a',
  'session that was already running. Restart Claude Code in this',
  'project before dispatching any of the agents above.',
  '================================================================',
].join('\n');

export function agentChangesRequireRestart(report) {
  return report.some((entry) => ['installed', 'refreshed', 'header_repaired', 'machine_rebaked', 'retired'].includes(entry.status));
}

function prepareRegisteredAgents({ templatesDir, registryPath, pluginVersion, now, vars, config }) {
  const registry = loadRegistry(registryPath);
  // config.agents keys name registered agents (587472e3): a typo would otherwise
  // grant nothing, silently.
  const registered = new Set(registry.agents.map((entry) => entry.name));
  for (const key of Object.keys(config?.agents ?? {})) {
    if (!registered.has(key)) {
      throw new Error(`config.agents: '${key}' is not a registered agent (registered: ${[...registered].join(', ')}) — fix or remove it in .sterling/config.json`);
    }
  }
  // Render every replacement before modifying or retiring anything. In particular,
  // a bad template/config may not turn a registry typo into an irreversible prune.
  return registry.agents.map((entry) => {
    const templateContent = readFileSync(join(templatesDir, entry.file), 'utf8');
    const { name, installedContent } = renderInstalledAgent(templateContent, entry.file, { pluginVersion, now, vars, config });
    if (name !== entry.name) {
      throw new Error(`registry/template name mismatch: registry says '${entry.name}', template says '${name}'`);
    }
    return { ...entry, templateContent, installedContent };
  });
}

export function retirementRefuseInstruction(name) {
  return [
    `REFUSED: '${name}' looks like a retired Sterling agent but cannot be safely removed.`,
    'Choose one of the following:',
    '  1) archive the file outside .claude/agents/,',
    '  2) adopt it as your own custom agent by removing the Sterling header, or',
    '  3) delete it.',
  ].join('\n');
}

// Retire only recognized, unmodified generated artifacts. lstat is deliberate:
// a symlink in .claude/agents is neither our regular file nor ours to follow.
export function retireAgents({ targetAgentsDir, registryNames, fs = {} }) {
  const io = { readdirSync, lstatSync, readFileSync, unlinkSync, renameSync, linkSync, ...fs };
  const report = [];
  let entries;
  try {
    entries = io.readdirSync(targetAgentsDir);
  } catch (err) {
    return [{ name: targetAgentsDir, status: 'retired_scan_failed', refused: true, instruction: `${retirementRefuseInstruction(targetAgentsDir)}\nUnable to scan the agent directory: ${err?.code ?? err?.message ?? err}` }];
  }
  for (const filename of entries) {
    if (!filename.endsWith('.md')) continue;
    const name = filename.slice(0, -3);
    if (registryNames.has(name)) continue;
    const path = join(targetAgentsDir, filename);
    let stat;
    try {
      stat = io.lstatSync(path);
    } catch (err) {
      report.push({ name, status: 'retired_read_failed', refused: true, instruction: `${retirementRefuseInstruction(name)}\nUnable to inspect the file: ${err?.code ?? err?.message ?? err}` });
      continue;
    }
    if (!stat.isFile()) continue;
    let content;
    try {
      content = io.readFileSync(path, 'utf8');
    } catch (err) {
      report.push({ name, status: 'retired_read_failed', refused: true, instruction: `${retirementRefuseInstruction(name)}\nUnable to read the file: ${err?.code ?? err?.message ?? err}` });
      continue;
    }
    if (!content.includes('<!-- sterling-generated')) continue;
    const header = parseInstalledHeader(content);
    if (!header) {
      report.push({ name, status: 'retired_unrecognized', refused: true, instruction: retirementRefuseInstruction(name) });
      continue;
    }
    let frontmatterName;
    try {
      frontmatterName = parseTemplate(content.replace(header.headerLine + '\n', ''), filename).name;
    } catch {
      frontmatterName = undefined;
    }
    if (name !== frontmatterName || name !== header.template) {
      report.push({ name, status: 'retired_identity_mismatch', refused: true, instruction: retirementRefuseInstruction(name) });
      continue;
    }
    if (isLocallyModified(content, header)) {
      report.push({ name, status: 'retired_but_modified', refused: true, instruction: retirementRefuseInstruction(name) });
      continue;
    }
    // Rename first: after this atomic move the original pathname is free for a
    // user's concurrent replacement, and every verify/delete operation below
    // addresses only our quarantined inode.
    const quarantine = join(targetAgentsDir, `.sterling-retire-${name}-${randomUUID()}`);
    const verifyQuarantine = () => {
      const qstat = io.lstatSync(quarantine);
      if (!qstat.isFile()) throw new Error('quarantine is not a regular file');
      if (qstat.dev !== stat.dev || qstat.ino !== stat.ino) throw new Error('quarantine file identity changed');
      const qcontent = io.readFileSync(quarantine, 'utf8');
      const qheader = parseInstalledHeader(qcontent);
      let qname;
      try { qname = parseTemplate(qcontent.replace(qheader?.headerLine + '\n', ''), filename).name; } catch { qname = undefined; }
      if (!qheader || qname !== name || qheader.template !== name || isLocallyModified(qcontent, qheader)) throw new Error('quarantine identity or hash verification failed');
    };
    try {
      io.renameSync(path, quarantine);
      verifyQuarantine();
      // Deliberate test seam: production has no hook here; a test can replace
      // the quarantined pathname between verification and deletion.
      io.afterQuarantineVerify?.({ path, quarantine, name });
      verifyQuarantine();
      io.unlinkSync(quarantine);
      report.push({ name, status: 'retired' });
    } catch (err) {
      // Never overwrite a file that appeared at the original path.  Restore
      // only into an absent name; otherwise preserve the quarantine for manual
      // inspection and fail loud.
      let restored = false;
      try {
        // link is an atomic no-clobber restore: even a dangling symlink or a
        // concurrent creation at `path` yields EEXIST instead of replacement.
        io.linkSync(quarantine, path);
        restored = true;
        io.unlinkSync(quarantine);
      } catch { /* leave quarantine in place */ }
      report.push({ name, status: 'retired_delete_failed', refused: true, instruction: `${retirementRefuseInstruction(name)}\nUnable to retire safely (${err?.code ?? err?.message ?? err}); ${restored ? 'the candidate was restored.' : `it remains quarantined at ${quarantine}.`}` });
    }
  }
  return report;
}

export function installAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion, now, vars = {}, config, retirementFs }) {
  const prepared = prepareRegisteredAgents({ templatesDir, registryPath, pluginVersion, now, vars, config });
  mkdirSync(targetAgentsDir, { recursive: true });
  const report = [];
  for (const entry of prepared) {
    const installedPath = join(targetAgentsDir, `${entry.name}.md`);
    if (existsSync(installedPath)) {
      const installed = readFileSync(installedPath, 'utf8');
      const header = parseInstalledHeader(installed);
      if (!header) {
        report.push({ name: entry.name, status: 'foreign_file', refused: true, instruction: refuseInstruction(entry.name) });
        continue;
      }
      if (isLocallyModified(installed, header)) {
        if (header.templateHash === sha256(entry.templateContent)) {
          report.push({ name: entry.name, status: 'locally_modified_up_to_date' });
          continue;
        }
        const installedBody = normalize(installed).replace(header.headerLine + '\n', '');
        const candidateBody = entry.installedContent.replace(parseInstalledHeader(entry.installedContent).headerLine + '\n', '');
        if (installedBody === candidateBody) {
          writeFileSync(installedPath, entry.installedContent);
          report.push({ name: entry.name, status: 'header_repaired' });
        } else {
          report.push({ name: entry.name, status: 'refused_local_modification', refused: true, instruction: refuseInstruction(entry.name) });
        }
        continue;
      }
    }
    writeFileSync(installedPath, entry.installedContent);
    report.push({ name: entry.name, status: 'installed' });
  }
  report.push(...retireAgents({ targetAgentsDir, registryNames: new Set(prepared.map((entry) => entry.name)), fs: retirementFs }));
  return { report, restartInstruction: RESTART_INSTRUCTION };
}

export function refuseInstruction(name) {
  return [
    `REFUSED: '${name}' was locally modified after install (content hash mismatch).`,
    'Sterling will not overwrite local changes. To resolve, either:',
    `  1) keep your changes — review the new template (agent-templates/) against`,
    `     .claude/agents/${name}.md and re-apply them on the fresh version, or`,
    `  2) discard your changes — delete .claude/agents/${name}.md and re-run`,
    '     /sterling:sync-agents to install the fresh version.',
    '(Header-only drift — an installed body byte-identical to the current template',
    'render — is repaired automatically; this refusal means the content genuinely differs.)',
    'A guided three-way review is deliberately stubbed for now (spec §16.1 Slice 1).',
  ].join('\n');
}

// /sterling:sync-agents core (spec §13): header hash compare; refresh clean+stale
// installs; refuse to overwrite local modification (refuse-and-instruct stub for
// the three-way review). A "modified" install whose body is byte-identical to
// the fresh render is header-only drift (stale generated header, not a divergent
// edit) — repaired, not refused. An UNMODIFIED, template-current install whose
// baked hook command lines differ from a fresh render with THIS machine's vars
// is a machine-context flip (invisible to hash bookkeeping — anti_pattern
// 60e8463d) — re-baked loudly as machine_rebaked, never reported up_to_date.
// An unmodified, template-current, machine-current install whose frontmatter
// model/effort differs from the resolved config.models entry reports
// config_drift (decision sync-agents-reports-config-models-drift-loudly-without-rewriting,
// 256d1059) and is NOT written: install/refresh/swap stay the only surfaces that
// realize config authority. Precedence: every writing or refusing status wins
// over config_drift — refreshed / header_repaired / machine_rebaked write a fresh
// render that already carries the configured values, and a locally modified file
// (locally_modified_up_to_date, refused_local_modification) is the user's, so its
// model line is not ours to call drift. config_drift replaces only up_to_date.
// Statuses: installed | refreshed | header_repaired | machine_rebaked |
// config_drift | up_to_date | locally_modified_up_to_date |
// refused_local_modification | foreign_file.
export function syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion, now, vars = {}, config, retirementFs }) {
  const prepared = prepareRegisteredAgents({ templatesDir, registryPath, pluginVersion, now, vars, config });
  mkdirSync(targetAgentsDir, { recursive: true });
  const report = [];
  for (const entry of prepared) {
    const installedPath = join(targetAgentsDir, `${entry.name}.md`);
    const renderCandidate = () => entry.installedContent;
    if (!existsSync(installedPath)) {
      writeFileSync(installedPath, renderCandidate());
      report.push({ name: entry.name, status: 'installed' });
      continue;
    }
    const installed = readFileSync(installedPath, 'utf8');
    const header = parseInstalledHeader(installed);
    if (!header) {
      // Not Sterling-generated: never overwrite a file we did not write.
      report.push({ name: entry.name, status: 'foreign_file', refused: true, instruction: refuseInstruction(entry.name) });
      continue;
    }
    const modified = isLocallyModified(installed, header);
    const stale = header.templateHash !== sha256(entry.templateContent);
    if (modified && stale) {
      // Provable equivalence before refusing: bodies are compared byte-for-byte
      // against the fresh render with THIS machine's vars baked, so a
      // cross-machine var difference (e.g. WSL vs Windows node paths) never
      // reads as repairable — it still refuses.
      const candidate = renderCandidate();
      const installedBody = normalize(installed).replace(header.headerLine + '\n', '');
      const candidateBody = candidate.replace(parseInstalledHeader(candidate).headerLine + '\n', '');
      if (installedBody === candidateBody) {
        writeFileSync(installedPath, candidate);
        report.push({ name: entry.name, status: 'header_repaired' });
      } else {
        report.push({ name: entry.name, status: 'refused_local_modification', refused: true, instruction: refuseInstruction(entry.name) });
      }
    } else if (modified) {
      report.push({ name: entry.name, status: 'locally_modified_up_to_date' });
    } else if (stale) {
      writeFileSync(installedPath, renderCandidate());
      report.push({ name: entry.name, status: 'refreshed' });
    } else {
      // Unmodified + template-current — but hash bookkeeping cannot see a
      // machine-context flip (anti_pattern foreign_60e8463d: nine× up_to_date while
      // every hook command pointed at the other context's node). Compare the
      // baked hook command lines against a fresh render with THIS machine's
      // vars: command drift on an UNMODIFIED install is provably baked-var
      // drift (the body hash matches the header, so no human edited it) →
      // re-bake loudly. A frontmatter model/effort divergence from config.models
      // is reported loudly as config_drift and NOT written: config authority is
      // realized at install/refresh/swap (98064d77), and sync only reports it
      // (256d1059 — an all-green up_to_date over a dead config bump is the
      // silent failure of anti_pattern 85d15143).
      const candidate = renderCandidate();
      const sameCommands =
        JSON.stringify(extractHookCommandLines(installed)) === JSON.stringify(extractHookCommandLines(candidate));
      const installedModel = extractModelEffort(installed);
      const configuredModel = extractModelEffort(candidate);
      // Tools compare as sets: config.agents extra_tools is the only config input
      // to this line (587472e3), so any difference is an unrealized extras change.
      const installedTools = extractTools(installed) ?? [];
      const configuredTools = extractTools(candidate) ?? [];
      const missing = configuredTools.filter((t) => !installedTools.includes(t));
      const unexpected = installedTools.filter((t) => !configuredTools.includes(t));
      const modelDrift = installedModel.model !== configuredModel.model || installedModel.effort !== configuredModel.effort;
      if (!sameCommands) {
        writeFileSync(installedPath, candidate);
        report.push({ name: entry.name, status: 'machine_rebaked' });
      } else if (modelDrift || missing.length || unexpected.length) {
        const drift = { name: entry.name, status: 'config_drift', installed: installedModel, configured: configuredModel, fix: CONFIG_DRIFT_FIX };
        if (missing.length || unexpected.length) drift.tools = { missing, unexpected };
        report.push(drift);
      } else {
        report.push({ name: entry.name, status: 'up_to_date' });
      }
    }
  }
  report.push(...retireAgents({ targetAgentsDir, registryNames: new Set(prepared.map((entry) => entry.name)), fs: retirementFs }));
  return { report, restartInstruction: RESTART_INSTRUCTION };
}

// Runtime visibility check: project subagents load at session start, so the
// installed agent set is visible only if every registered agent is installed
// AND the current session started after the newest install. Nothing in the
// current (post-scale-down, direct-mode-only) harness gates dispatch on this
// automatically — it is a manual/CI check (scripts/check-agents-visible.mjs)
// an operator can run to confirm a fresh install before trusting it.
// probeExecutability (opt-in; the check-agents-visible CLI always enables it):
// additionally verify every baked hook node path resolves on THIS machine —
// visibility alone said 'ok' during the 2026-07-03 incident while every hook
// failed non-blocking (enforcement silently absent, anti_pattern foreign_60e8463d).
// Opt-in so the lib contract (pure visibility) is unchanged for existing callers.
export function checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt, probeExecutability = false }) {
  const registry = loadRegistry(registryPath);
  const problems = [];
  const sessionStart = Date.parse(sessionStartedAt);
  if (Number.isNaN(sessionStart)) {
    throw new Error(`checkAgentsVisible: unparseable sessionStartedAt '${sessionStartedAt}'`);
  }
  for (const entry of registry.agents) {
    const installedPath = join(targetAgentsDir, `${entry.name}.md`);
    // DEGRADE LOUD, NEVER SILENT (board 4fa477f2) — the same repair the H1
    // machine-activation guard carries, not a second idiom. This read used to sit
    // behind an existsSync() gate with no catch of its own, so ONE directory named
    // `coder.md` (EISDIR), ONE EACCES file, ONE symlink loop (ELOOP) or ONE race
    // deletion between the two calls threw out of the whole loop: every REMAINING
    // agent went unprobed and the gate's actionable problems[] report (with its
    // hook_node_unresolvable remediation) was replaced by a raw stack trace naming
    // no agent. A partial failure must not be reported as a total one, in the guard
    // whose entire purpose is to refuse to be silent about absent enforcement
    // (02a1ed39: nine consecutive `up_to_date` while every agent hook was dead).
    // Deriving BOTH verdicts from the read's own error code also closes the
    // existsSync/readFileSync race, and stops existsSync answering `false` — i.e.
    // `missing_agent`, i.e. "install it" — to an EACCES that means "I could not look".
    // Only ENOENT means genuinely absent; everything else is REPORTED. ENOTDIR is
    // deliberately NOT absence (review finding): it means an ANCESTOR component of
    // the path is not a directory — `.claude/agents` is itself a file, say — for
    // which "install the agent" is the wrong remedy, because the install would hit
    // the same broken ancestor. That is a cannot-look, so it reports
    // unreadable_agent with its code in the detail (visible:false either way; this
    // is message accuracy, not a hole).
    let installed;
    try {
      installed = readFileSync(installedPath, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        problems.push({ name: entry.name, reason: 'missing_agent' });
      } else {
        problems.push({
          name: entry.name,
          reason: 'unreadable_agent',
          detail: `${installedPath} could not be read (${err?.code ?? err?.message ?? err}) — whether its hooks run on this machine is UNKNOWN; an unreadable agent file is not a healthy one`,
        });
      }
      continue;
    }
    const header = parseInstalledHeader(installed);
    if (!header) {
      problems.push({ name: entry.name, reason: 'missing_generated_header' });
      continue;
    }
    const installedAt = Date.parse(header.installedAt);
    if (Number.isNaN(installedAt)) {
      problems.push({ name: entry.name, reason: 'unparseable_installed_at' });
    } else if (installedAt > sessionStart) {
      problems.push({ name: entry.name, reason: 'restart_required' });
    }
    if (probeExecutability) {
      const unresolved = extractBakedCommandPaths(installed).find((p) => !existsSync(p));
      if (unresolved) {
        problems.push({ name: entry.name, reason: 'hook_node_unresolvable', detail: unresolved });
      }
    }
  }
  return { visible: problems.length === 0, problems };
}

/**
 * §6 emission rule applied to hooks.json: walk every {type:'command'} handler
 * and flag backslash paths in command strings (git bash mangles them silently
 * — enforcement vanishes; Layer 0 finding).
 */
export function findBackslashCommandsInHooksJson(node) {
  const bad = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.type === 'command' && typeof n.command === 'string' && n.command.includes('\\')) bad.push(n.command);
      Object.values(n).forEach(walk);
    }
  };
  walk(node);
  return bad;
}

// Extensions the dead-term scan reads as text. `.ts` covers packages/*/src —
// the scan previously covered only shipped markdown/mjs/json/bat surfaces and
// was structurally blind to TypeScript source (board c05da1d1: a banned term
// lived in packages/store/src/index.ts and propagated into 17 built bundles
// undetected).
const DEAD_TERM_SCAN_EXT_RE = /\.(md|json|mjs|bat|ts)$/;

// Source scanning skips a `tests/` path segment: the dead-term ban targets
// shipped/scaffolded content, not internal test-file prose citing a past
// decision's own phase labels (e.g. frozen pins referencing "stable-identity
// wave S1/S2") — those are a separate, out-of-scope residue for whichever
// lane owns that file, not this scan's concern.
const isTestPath = (p) => /[\\/]tests[\\/]/.test(p);

function collectDeadTermScanFiles(dir, { excludeTests = false } = {}) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const f of readdirSync(dir, { recursive: true })) {
    const p = join(dir, String(f));
    if (excludeTests && isTestPath(p)) continue;
    if (DEAD_TERM_SCAN_EXT_RE.test(p) && statSync(p).isFile()) files.push(p);
  }
  return files;
}

// Registry consistency check (spec §15, invariant 3): templates dir and
// registry must agree 1:1; template frontmatter names must match registry
// names; shipped/scaffolded content carries no dead terms and no backslash
// hook commands. Returns a violations list; empty = pass.
//
// `bundleScanDirs` is a separate, VERIFY-ONLY surface (board c05da1d1): built
// bundles (hooks/*.mjs, packages/*/dist, the tui bundle) inline whatever their
// source carried, so a hit there is stale-bundle residue, not a source defect
// — the fix is `npm run build` (rebuild), never an edit to the bundle itself.
// Reported as its own `dead_term_bundle` kind so tooling and humans can tell
// the two apart at a glance.
//
// `codeScanDirs` is a separate surface from `scanDirs` (board 481c9ec3): raw
// package source (packages/*/src) is scanned with STRICT_DEAD_TERM_PATTERNS
// (case-sensitive capitalized codename tokens) instead of the relaxed
// case-insensitive DEAD_TERM_PATTERNS `scanDirs` uses — code comments carry
// ordinary English prose ('forge an id') that the relaxed patterns false-flag.
export function checkRegistryConsistency({ templatesDir, registryPath, scanDirs = [], codeScanDirs = [], bundleScanDirs = [] }) {
  const violations = [];
  let registry;
  try {
    registry = loadRegistry(registryPath);
  } catch (e) {
    return [{ kind: 'registry_unloadable', detail: e.message }];
  }
  const templateFiles = existsSync(templatesDir)
    ? readdirSync(templatesDir).filter((f) => f.endsWith('.md'))
    : [];
  const registered = new Map(registry.agents.map((a) => [a.file, a]));
  for (const file of templateFiles) {
    if (!registered.has(file)) violations.push({ kind: 'unregistered_template', detail: file });
  }
  for (const entry of registry.agents) {
    const tPath = join(templatesDir, entry.file);
    if (!existsSync(tPath)) {
      violations.push({ kind: 'missing_template_file', detail: `${entry.name} -> ${entry.file}` });
      continue;
    }
    const content = readFileSync(tPath, 'utf8');
    try {
      const { name, frontmatter } = parseTemplate(content, entry.file);
      if (name !== entry.name) {
        violations.push({ kind: 'name_mismatch', detail: `registry '${entry.name}' vs template '${name}' (${entry.file})` });
      }
      for (const cmd of findBackslashHookCommands(frontmatter)) {
        violations.push({ kind: 'backslash_hook_command', detail: `${entry.file}: ${cmd}` });
      }
    } catch (e) {
      violations.push({ kind: 'unparseable_template', detail: e.message });
    }
  }
  const scanTargets = [...templateFiles.map((f) => join(templatesDir, f))];
  for (const dir of scanDirs) {
    scanTargets.push(...collectDeadTermScanFiles(dir, { excludeTests: true }));
  }
  for (const p of scanTargets) {
    const hits = findDeadTerms(readFileSync(p, 'utf8'));
    for (const h of hits) violations.push({ kind: 'dead_term', detail: `${p}: '${h.match}' (${h.term})` });
  }
  for (const dir of codeScanDirs) {
    for (const p of collectDeadTermScanFiles(dir, { excludeTests: true })) {
      const hits = findDeadTermsStrict(readFileSync(p, 'utf8'));
      for (const h of hits) violations.push({ kind: 'dead_term', detail: `${p}: '${h.match}' (${h.term})` });
    }
  }
  for (const dir of bundleScanDirs) {
    for (const p of collectDeadTermScanFiles(dir)) {
      const hits = findDeadTerms(readFileSync(p, 'utf8'));
      for (const h of hits) {
        violations.push({
          kind: 'dead_term_bundle',
          detail: `${p}: '${h.match}' (${h.term}) — stale bundle, rebuild via npm run build once the source is clean`,
        });
      }
    }
  }
  return violations;
}

// Route A activation (decision conductor-instructions-via-main-session-agent-route-a):
// a project's .claude/settings.json "agent" key is what turns an installed but inert
// .claude/agents/conductor.md into the session's actual system prompt. Written only
// once the conductor's OWN install/sync result was a success — never guessed at from a
// half-installed state (P5). Preserves every other settings key; a settings file that
// already names a DIFFERENT agent is a deliberate project choice, refused loudly rather
// than silently overwritten.
const CONDUCTOR_ACTIVATION_SUCCESS_STATUSES = new Set(['installed', 'up_to_date', 'refreshed', 'header_repaired']);

export function ensureConductorActivation(targetDir, agentResults) {
  const conductorResult = (agentResults ?? []).find((r) => r.name === 'conductor');
  if (!conductorResult || !CONDUCTOR_ACTIVATION_SUCCESS_STATUSES.has(conductorResult.status)) {
    return {
      activation: 'skipped',
      reason: conductorResult
        ? `conductor's own install/sync result was '${conductorResult.status}', not installed/up_to_date/refreshed/header_repaired`
        : "no 'conductor' entry in the agent install/sync report",
    };
  }

  const settingsPath = join(targetDir, '.claude', 'settings.json');
  let parsed;
  // Preserved on write, never assumed: a hand-authored settings.json may carry a
  // leading BOM (stripped before parsing, never rewritten back), CRLF line
  // endings, and/or no trailing newline. A brand-new file uses the plain LF +
  // trailing-newline defaults this function always used.
  let eol = '\n';
  let trailingNewline = true;
  if (existsSync(settingsPath)) {
    let raw = readFileSync(settingsPath, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    eol = raw.includes('\r\n') ? '\r\n' : '\n';
    trailingNewline = /\r?\n$/.test(raw);
    try {
      parsed = JSON.parse(raw);
    } catch {
      const reason = `${settingsPath} is not valid JSON — refusing to touch it; add "agent": "conductor" by hand`;
      console.error(`REFUSED: ${reason}`);
      return { activation: 'refused', reason };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const reason = `${settingsPath} does not contain a JSON object — refusing to touch it; add "agent": "conductor" by hand`;
      console.error(`REFUSED: ${reason}`);
      return { activation: 'refused', reason };
    }
  } else {
    parsed = {};
  }

  if ('agent' in parsed) {
    if (parsed.agent === 'conductor') {
      return { activation: 'already' };
    }
    const reason = `${settingsPath} already sets "agent": "${parsed.agent}" — refusing to overwrite a deliberate choice`;
    console.error(`REFUSED: ${reason}`);
    return { activation: 'refused', reason };
  }

  parsed.agent = 'conductor';
  mkdirSync(join(targetDir, '.claude'), { recursive: true });
  const tmp = `${settingsPath}.tmp-${randomUUID()}`;
  let body = JSON.stringify(parsed, null, 2);
  if (eol === '\r\n') body = body.replace(/\n/g, '\r\n');
  if (trailingNewline) body += eol;
  writeFileSync(tmp, body);
  renameSync(tmp, settingsPath);
  return { activation: 'written', path: settingsPath };
}
