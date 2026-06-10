// Agent-registry consistency check (spec §15, invariant 3) — commit-time/build
// check. Verifies templates ↔ registry 1:1, frontmatter names match registry
// names, no dead terms in shipped/scaffolded content (spec §0.4), and no
// backslash paths in any emitted hook command string (spec §6 emission rule).
// Exit codes: 0 = pass; 1 = violations (all listed).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { checkRegistryConsistency } from './lib/agent-distribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const violations = checkRegistryConsistency({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  scanDirs: [join(pluginRoot, 'templates'), join(pluginRoot, 'commands'), join(pluginRoot, 'skills')],
});

if (violations.length === 0) {
  console.log('agent registry consistency: ok');
  process.exit(0);
}
console.error('agent registry consistency FAILED:');
for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
process.exit(1);
