// Spawn-contract validation (spec §7.4, §6 checks) — commit-time: every
// registered agent template declares a required-inputs manifest. The
// producibility cross-check against upstream outputs deepens when the roster
// lands; the manifest requirement holds from day one. Empty registry passes.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkSpawnContract, collectAgentTemplates } from './lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templates = collectAgentTemplates(join(root, 'agent-templates'));

const violations = templates.flatMap((t) => checkSpawnContract(t.content, t.file));
if (violations.length) {
  console.error('spawn-contract check FAILED:');
  for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
  process.exit(1);
}
console.log(`spawn-contract check: ok (${templates.length} template(s))`);
