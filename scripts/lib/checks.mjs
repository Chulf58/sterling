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
