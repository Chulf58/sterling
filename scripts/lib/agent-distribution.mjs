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

export function renderInstalledAgent(templateContent, label, { pluginVersion, now }) {
  const { name, frontmatter, body } = parseTemplate(templateContent, label);
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

export function installAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion, now }) {
  const registry = loadRegistry(registryPath);
  mkdirSync(targetAgentsDir, { recursive: true });
  const report = [];
  for (const entry of registry.agents) {
    const templateContent = readFileSync(join(templatesDir, entry.file), 'utf8');
    const { name, installedContent } = renderInstalledAgent(templateContent, entry.file, { pluginVersion, now });
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
    'A guided three-way review is deliberately stubbed for now (spec §16.1 Slice 1).',
  ].join('\n');
}

// /sterling:sync-agents core (spec §13): header hash compare; refresh clean+stale
// installs; refuse to overwrite local modification (refuse-and-instruct stub for
// the three-way review). Statuses: installed | refreshed | up_to_date |
// locally_modified_up_to_date | refused_local_modification | foreign_file.
export function syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion, now }) {
  const registry = loadRegistry(registryPath);
  mkdirSync(targetAgentsDir, { recursive: true });
  const report = [];
  for (const entry of registry.agents) {
    const templateContent = readFileSync(join(templatesDir, entry.file), 'utf8');
    const installedPath = join(targetAgentsDir, `${entry.name}.md`);
    const render = () => {
      const { name, installedContent } = renderInstalledAgent(templateContent, entry.file, { pluginVersion, now });
      if (name !== entry.name) {
        throw new Error(`registry/template name mismatch: registry says '${entry.name}', template says '${name}'`);
      }
      writeFileSync(installedPath, installedContent);
    };
    if (!existsSync(installedPath)) {
      render();
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
      report.push({ name: entry.name, status: 'refused_local_modification', instruction: refuseInstruction(entry.name) });
    } else if (modified) {
      report.push({ name: entry.name, status: 'locally_modified_up_to_date' });
    } else if (stale) {
      render();
      report.push({ name: entry.name, status: 'refreshed' });
    } else {
      report.push({ name: entry.name, status: 'up_to_date' });
    }
  }
  return { report, restartInstruction: RESTART_INSTRUCTION };
}

// Runtime visibility check (spec §12): project subagents load at session
// start, so the installed agent set is visible only if every registered agent
// is installed AND the current session started after the newest install.
// The first pipeline run is blocked until this passes.
export function checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt }) {
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
    const header = parseInstalledHeader(readFileSync(installedPath, 'utf8'));
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
