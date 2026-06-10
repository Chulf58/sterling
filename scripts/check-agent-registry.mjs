// Agent-registry consistency check (spec §15, invariant 3) — commit-time/build
// check. Verifies templates ↔ registry 1:1, frontmatter names match registry
// names, no dead terms in shipped/scaffolded content (spec §0.4), and no
// backslash paths in any emitted hook command string (spec §6 emission rule).
// Exit codes: 0 = pass; 1 = violations (all listed).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { checkRegistryConsistency, findBackslashCommandsInHooksJson } from './lib/agent-distribution.mjs';
import { checkAdapterRegistry } from './adapters/resolve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const violations = checkRegistryConsistency({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  scanDirs: [join(pluginRoot, 'templates'), join(pluginRoot, 'commands'), join(pluginRoot, 'skills')],
});

// §6 hook-emission backslash check over the shipped hooks.json
const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
if (existsSync(hooksJsonPath)) {
  for (const cmd of findBackslashCommandsInHooksJson(JSON.parse(readFileSync(hooksJsonPath, 'utf8')))) {
    violations.push({ kind: 'backslash_hook_command', detail: `hooks/hooks.json: ${cmd}` });
  }
}

// §9.1 adapter registry check: every member loads and exports the fixed interface
for (const v of await checkAdapterRegistry()) {
  violations.push({ kind: `adapter_${v.kind}`, detail: v.detail });
}

if (violations.length === 0) {
  console.log('agent registry consistency: ok');
  process.exit(0);
}
console.error('agent registry consistency FAILED:');
for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
process.exit(1);
