// Skill linter (spec §6 checks): stale file/API references in SKILL.md files
// fail the check. Empty skills dir passes.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintSkill, collectSkills } from './lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skills = collectSkills(join(root, 'skills'));

const violations = skills.flatMap((s) => lintSkill(s.content, s.file, root));
if (violations.length) {
  console.error('skill linter FAILED:');
  for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
  process.exit(1);
}
console.log(`skill linter: ok (${skills.length} skill(s))`);
