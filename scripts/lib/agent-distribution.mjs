// Agent distribution core (spec §2.2, §12, §13, §16.1 Slice 1).
// The plugin is the distributor; THE PROJECT IS THE ENFORCEMENT SURFACE:
// templates ship in agent-templates/ (never platform-served), and concrete
// agents are generated into the target project's .claude/agents/ with a
// header carrying plugin version + template hash + content hash.
//
// State lives in the generated headers themselves — no side manifest to desync (P5).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_MODEL_KEY } from '@sterling/schemas';

// Dead-term check (spec §0.4, CLAUDE.md conduct rules): no residue of the
// predecessor's vocabulary in anything shipped, scaffolded, or generated.
export const DEAD_TERM_PATTERNS = [
  { term: 'Forge', re: /\bforge\b/i },
  { term: 'Quatermain/Quartermain(e)', re: /quart?ermaine?/i },
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

export function renderInstalledAgent(templateContent, label, { pluginVersion, now, vars = {}, config } = {}) {
  // Install-time variable substitution: installed agents are project-side and
  // cannot use ${CLAUDE_PLUGIN_ROOT}; templates carry {{NODE}}/{{HOOKS_DIR}}
  // tokens that install bakes to machine-detected forward-slash paths (§6
  // emission rule — the backslash check below guards the substituted result) and
  // {{MODEL}}/{{EFFORT}} tokens resolved per agent from config.models (98064d77).
  const allVars = { ...vars, ...resolveModelVars(templateContent, label, config) };
  let substituted = templateContent;
  for (const [key, value] of Object.entries(allVars)) {
    substituted = substituted.split(`{{${key}}}`).join(value);
  }
  const { name, frontmatter, body } = parseTemplate(substituted, label);
  const unsubstituted = frontmatter.match(/\{\{[A-Z_]+\}\}/);
  if (unsubstituted) {
    throw new Error(`install substitution incomplete for ${label}: '${unsubstituted[0]}' has no value — refusing to install a half-baked hook command (P5)`);
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
// anti_pattern 60e8463d): installed agents bake NODE/HOOKS_DIR into frontmatter
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

export function loadRegistry(registryPath) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (registry.version !== 1 || !Array.isArray(registry.agents)) {
    throw new Error(`agent registry ${registryPath}: unsupported shape (expected {version: 1, agents: []})`);
  }
  return registry;
}

export const RESTART_INSTRUCTION = [
  '================================================================',
  'RESTART REQUIRED — project subagents load at session start.',
  'Agents installed into .claude/agents/ are NOT visible to a',
  'session that was already running. Restart Claude Code in this',
  'project before the first pipeline run; the run is blocked until',
  'the runtime visibility check confirms the installed agent set.',
  '================================================================',
].join('\n');

export function installAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion, now, vars = {}, config }) {
  const registry = loadRegistry(registryPath);
  mkdirSync(targetAgentsDir, { recursive: true });
  const report = [];
  for (const entry of registry.agents) {
    const templateContent = readFileSync(join(templatesDir, entry.file), 'utf8');
    const { name, installedContent } = renderInstalledAgent(templateContent, entry.file, { pluginVersion, now, vars, config });
    if (name !== entry.name) {
      throw new Error(`registry/template name mismatch: registry says '${entry.name}', template says '${name}'`);
    }
    writeFileSync(join(targetAgentsDir, `${name}.md`), installedContent);
    report.push({ name, status: 'installed' });
  }
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
// Statuses: installed | refreshed | header_repaired | machine_rebaked |
// up_to_date | locally_modified_up_to_date | refused_local_modification |
// foreign_file.
export function syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion, now, vars = {}, config }) {
  const registry = loadRegistry(registryPath);
  mkdirSync(targetAgentsDir, { recursive: true });
  const report = [];
  for (const entry of registry.agents) {
    const templateContent = readFileSync(join(templatesDir, entry.file), 'utf8');
    const installedPath = join(targetAgentsDir, `${entry.name}.md`);
    const renderCandidate = () => {
      const { name, installedContent } = renderInstalledAgent(templateContent, entry.file, { pluginVersion, now, vars, config });
      if (name !== entry.name) {
        throw new Error(`registry/template name mismatch: registry says '${entry.name}', template says '${name}'`);
      }
      return installedContent;
    };
    if (!existsSync(installedPath)) {
      writeFileSync(installedPath, renderCandidate());
      report.push({ name: entry.name, status: 'installed' });
      continue;
    }
    const installed = readFileSync(installedPath, 'utf8');
    const header = parseInstalledHeader(installed);
    if (!header) {
      // Not Sterling-generated: never overwrite a file we did not write.
      report.push({ name: entry.name, status: 'foreign_file', instruction: refuseInstruction(entry.name) });
      continue;
    }
    const modified = isLocallyModified(installed, header);
    const stale = header.templateHash !== sha256(templateContent);
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
        report.push({ name: entry.name, status: 'refused_local_modification', instruction: refuseInstruction(entry.name) });
      }
    } else if (modified) {
      report.push({ name: entry.name, status: 'locally_modified_up_to_date' });
    } else if (stale) {
      writeFileSync(installedPath, renderCandidate());
      report.push({ name: entry.name, status: 'refreshed' });
    } else {
      // Unmodified + template-current — but hash bookkeeping cannot see a
      // machine-context flip (anti_pattern 60e8463d: nine× up_to_date while
      // every hook command pointed at the other context's node). Compare the
      // baked hook command lines against a fresh render with THIS machine's
      // vars: command drift on an UNMODIFIED install is provably baked-var
      // drift (the body hash matches the header, so no human edited it) →
      // re-bake loudly. Body-only divergence (config.models values) stays
      // up_to_date: config authority is realized at install/refresh/swap
      // (98064d77) and the System tab's drift marker owns its visibility.
      const candidate = renderCandidate();
      const sameCommands =
        JSON.stringify(extractHookCommandLines(installed)) === JSON.stringify(extractHookCommandLines(candidate));
      if (!sameCommands) {
        writeFileSync(installedPath, candidate);
        report.push({ name: entry.name, status: 'machine_rebaked' });
      } else {
        report.push({ name: entry.name, status: 'up_to_date' });
      }
    }
  }
  return { report, restartInstruction: RESTART_INSTRUCTION };
}

// Runtime visibility check (spec §12): project subagents load at session
// start, so the installed agent set is visible only if every registered agent
// is installed AND the current session started after the newest install.
// The first pipeline run is blocked until this passes.
// probeExecutability (opt-in; the check-agents-visible CLI always enables it):
// additionally verify every baked hook node path resolves on THIS machine —
// visibility alone said 'ok' during the 2026-07-03 incident while every hook
// failed non-blocking (enforcement silently absent, anti_pattern 60e8463d).
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
    if (!existsSync(installedPath)) {
      problems.push({ name: entry.name, reason: 'missing_agent' });
      continue;
    }
    const installed = readFileSync(installedPath, 'utf8');
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

// Registry consistency check (spec §15, invariant 3): templates dir and
// registry must agree 1:1; template frontmatter names must match registry
// names; shipped/scaffolded content carries no dead terms and no backslash
// hook commands. Returns a violations list; empty = pass.
export function checkRegistryConsistency({ templatesDir, registryPath, scanDirs = [] }) {
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
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir, { recursive: true })) {
      const p = join(dir, String(f));
      if (/\.(md|json|mjs|bat)$/.test(p) && statSync(p).isFile()) {
        scanTargets.push(p);
      }
    }
  }
  for (const p of scanTargets) {
    const hits = findDeadTerms(readFileSync(p, 'utf8'));
    for (const h of hits) violations.push({ kind: 'dead_term', detail: `${p}: '${h.match}' (${h.term})` });
  }
  return violations;
}
