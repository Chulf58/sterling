// Consistency/extension check cores (spec §6 checks, §7.3, §15) — pure
// functions over file contents so the day-one scripts and the tests share one
// definition. Empty sets pass: the checks exist before the members (invariant 3).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// §7.3 agent-prompt contract: every agent definition contains, in order.
// The linter enforces presence; missing = build failure.
export const PROMPT_CONTRACT_SECTIONS = [
  { key: 'role', re: /^#+\s*role\b/im },
  { key: 'inputs', re: /^#+\s*inputs\b/im },
  { key: 'rubric', re: /^#+\s*(rubric|priorities)\b/im },
  { key: 'worked_example', re: /^#+\s*worked example/im },
  { key: 'output_contract', re: /^#+\s*output contract/im },
  { key: 'scope_boundaries', re: /^#+\s*scope boundaries/im },
  { key: 'exit_signals', re: /^#+\s*exit signals/im },
];

export function lintAgentPrompt(content, label) {
  const violations = [];
  let lastIndex = -1;
  for (const section of PROMPT_CONTRACT_SECTIONS) {
    const m = content.match(section.re);
    if (!m) {
      violations.push({ kind: 'missing_section', detail: `${label}: '${section.key}' (§7.3)` });
      continue;
    }
    if (m.index < lastIndex) violations.push({ kind: 'section_out_of_order', detail: `${label}: '${section.key}' out of order (§7.3)` });
    lastIndex = m.index;
  }
  return violations;
}

// §7.4 spawn contracts: every agent role declares a required-inputs manifest.
export function checkSpawnContract(content, label) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return [{ kind: 'missing_frontmatter', detail: label }];
  if (!/^required_inputs:/m.test(fm[1])) {
    return [{ kind: 'missing_required_inputs', detail: `${label}: no required-inputs manifest in frontmatter (§7.4)` }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tool-grant linter (board bc272f83; decision e7a805b6, research_finding 4211a9f7).
// The failure mode this guards is SILENT: Claude Code ignores an agent `tools:`
// entry naming a tool that is not mounted, so the agent simply lacks it and says
// nothing. That class has bitten twice — the `mcp__plugin_sterling_sterling__`
// prefix being wrong under the strict-mcp launcher, and `ToolSearch` missing
// (store tools are served DEFERRED to subagents, so without it a correctly-named
// tool is present-but-uncallable). Nothing mechanical checked either one.
//
// Rules enforced per template:
//   1. every `mcp__…` grant resolves to a REAL registered Sterling tool
//   2. every granted store tool names BOTH prefixes (the launcher decides which
//      one mounts; init generates both launchers, so both must be declared)
//   3. a template granting any store tool also grants ToolSearch
// ---------------------------------------------------------------------------
export const MCP_PREFIXES = ['mcp__sterling__', 'mcp__plugin_sterling_sterling__'];

// Derived, never duplicated: the registered tool surface is server.ts's
// registerTool('<name>') calls. A hardcoded second list would drift from the
// server the way the prefix drifted from the launcher (the REVIEWER_ROLES
// precedent: a second source of truth is the bug).
export function readRegisteredToolNames(serverTsPath) {
  const src = readFileSync(serverTsPath, 'utf8');
  const names = [...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(
      `tool-grant linter: no registerTool('<name>') calls found in ${serverTsPath} — the extraction shape changed; fix the linter rather than letting it pass vacuously (P5)`
    );
  }
  return new Set(names);
}

export function parseToolsLine(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const line = fm[1].match(/^tools:\s*(.+)$/m);
  if (!line) return null;
  return line[1]
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function lintToolGrants(content, label, registeredTools) {
  const grants = parseToolsLine(content);
  if (grants === null) return [{ kind: 'missing_tools_line', detail: `${label}: no 'tools:' line in frontmatter` }];

  const violations = [];
  const baseNames = new Set();

  for (const grant of grants) {
    if (!grant.startsWith('mcp__')) continue;
    const prefix = MCP_PREFIXES.find((p) => grant.startsWith(p));
    if (!prefix) {
      violations.push({ kind: 'unknown_mcp_prefix', detail: `${label}: '${grant}' uses no known Sterling MCP prefix` });
      continue;
    }
    const base = grant.slice(prefix.length);
    if (!registeredTools.has(base)) {
      violations.push({
        kind: 'unknown_mcp_tool',
        detail: `${label}: '${grant}' names '${base}', which is not a registered Sterling tool`,
      });
      continue;
    }
    baseNames.add(base);
  }

  // both prefixes per granted store tool — a single-prefix grant is dead under
  // whichever launcher does not mount it, silently.
  for (const base of [...baseNames].sort()) {
    for (const prefix of MCP_PREFIXES) {
      if (!grants.includes(prefix + base)) {
        violations.push({
          kind: 'missing_mcp_prefix',
          detail: `${label}: store tool '${base}' is granted without '${prefix}${base}' — dead under the launcher that mounts that prefix`,
        });
      }
    }
  }

  // ToolSearch is required whenever any store tool is granted (deferred serving).
  if (baseNames.size > 0 && !grants.includes('ToolSearch')) {
    violations.push({
      kind: 'missing_toolsearch',
      detail: `${label}: grants Sterling store tools but not 'ToolSearch' — store tools are served deferred, so they would be present-but-uncallable`,
    });
  }

  return violations;
}

// §6 skill linter: stale file references in SKILL.md (and commands/*.md) files.
// Prefix/extension coverage widened by R2 board 72807b1f: skills|commands
// prefixes (cross-skill references were previously unlinted) + sh|bat.
export function lintSkill(content, label, rootDir) {
  const violations = [];
  const refs =
    content.match(/(?<![\w:])(?:scripts|templates|agent-templates|hooks|packages|skills|commands)\/[\w./-]+\.(?:mjs|md|json|ts|sh|bat)\b/g) ?? [];
  for (const ref of new Set(refs)) {
    if (!existsSync(join(rootDir, ref))) {
      violations.push({ kind: 'stale_file_reference', detail: `${label}: '${ref}' does not exist` });
    }
  }
  return violations;
}

// commands/*.md — linted through the same reference grammar (R2 72807b1f).
export function collectCommands(commandsDir) {
  if (!existsSync(commandsDir)) return [];
  return readdirSync(commandsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: `commands/${f}`, content: readFileSync(join(commandsDir, f), 'utf8') }));
}

export function collectAgentTemplates(templatesDir) {
  if (!existsSync(templatesDir)) return [];
  return readdirSync(templatesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, content: readFileSync(join(templatesDir, f), 'utf8') }));
}

export function collectSkills(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const p = join(skillsDir, entry.name, 'SKILL.md');
      if (existsSync(p)) out.push({ file: `${entry.name}/SKILL.md`, content: readFileSync(p, 'utf8') });
    }
  }
  return out;
}
