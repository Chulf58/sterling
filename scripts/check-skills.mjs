// Skill linter (spec §6 checks): stale file/API references in SKILL.md files
// AND commands/*.md fail the check (R2 72807b1f — the command surface was
// previously unlinted). Empty dirs pass.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintSkill, collectSkills, collectCommands } from './lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skills = collectSkills(join(root, 'skills'));
const commands = collectCommands(join(root, 'commands'));

const violations = [...skills, ...commands].flatMap((s) => lintSkill(s.content, s.file, root));
if (violations.length) {
  console.error('skill linter FAILED:');
  for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
  process.exit(1);
}
console.log(`skill linter: ok (${skills.length} skill(s), ${commands.length} command(s))`);
