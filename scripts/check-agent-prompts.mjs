// Prompt linter (spec §7.3) — commit-time: every registered agent template
// carries the seven contract sections in order. Empty registry passes
// (the check exists before the members — invariant 3).
// ALSO enforces absence-claim discipline (board 00d8d8c6) on the roles that
// report negatives most often — see lintAbsenceDiscipline for why a template
// rule rather than more conductor prose.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lintAgentPrompt, lintAbsenceDiscipline, collectAgentTemplates } from './lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templates = collectAgentTemplates(join(root, 'agent-templates')).filter((t) => t.file !== 'registry.json');

const violations = templates.flatMap((t) => [...lintAgentPrompt(t.content, t.file), ...lintAbsenceDiscipline(t.content, t.file)]);
if (violations.length) {
  console.error('prompt linter FAILED:');
  for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
  process.exit(1);
}
console.log(`prompt linter: ok (${templates.length} template(s))`);
