// Agent-registry consistency check (spec §15, invariant 3) — commit-time/build
// check. Verifies templates ↔ registry 1:1, frontmatter names match registry
// names, no dead terms in shipped/scaffolded content (spec §0.4), and no
// backslash paths in any emitted hook command string (spec §6 emission rule).
// Exit codes: 0 = pass; 1 = violations (all listed).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

// Invariant-3 totality for the HOOKS extensible set (R2 board 0d4824b8): every
// bundled hook must be REGISTERED somewhere (hooks.json or an agent-template
// frontmatter) and sources ↔ bundles must be 1:1 — a hook added and bundled but
// registered nowhere is the P5 'half-wired extension' and previously passed
// every checker. Deliberate exceptions are listed with their reason.
const HOOK_REGISTRATION_EXCEPTIONS = new Map([
  ['h11-note-structure.mjs', 'trigger moved into the MCP server (PostToolUse never fires on MCP tool calls — research_finding 5e7d0a78)'],
]);
const bundlesDir = join(pluginRoot, 'hooks');
const hookSrcDir = join(pluginRoot, 'scripts', 'hooks');
const hookFile = (f) => f.startsWith('h') && f.endsWith('.mjs');
const bundles = existsSync(bundlesDir) ? readdirSync(bundlesDir).filter(hookFile) : [];
const hookSources = existsSync(hookSrcDir) ? readdirSync(hookSrcDir).filter(hookFile) : [];
for (const s of hookSources) {
  if (!bundles.includes(s)) violations.push({ kind: 'hook_unbundled', detail: `scripts/hooks/${s} has no hooks/${s} bundle — run node scripts/build-hooks.mjs` });
}
for (const b of bundles) {
  if (!hookSources.includes(b)) violations.push({ kind: 'hook_orphan_bundle', detail: `hooks/${b} has no generating source scripts/hooks/${b}` });
}
const registered = new Set();
if (existsSync(hooksJsonPath)) {
  const hooksJsonText = readFileSync(hooksJsonPath, 'utf8');
  for (const b of bundles) if (hooksJsonText.includes(b)) registered.add(b);
}
const templatesDir = join(pluginRoot, 'agent-templates');
if (existsSync(templatesDir)) {
  for (const f of readdirSync(templatesDir).filter((f) => f.endsWith('.md'))) {
    const content = readFileSync(join(templatesDir, f), 'utf8');
    for (const b of bundles) if (content.includes(b)) registered.add(b);
  }
}
for (const b of bundles) {
  if (!registered.has(b) && !HOOK_REGISTRATION_EXCEPTIONS.has(b)) {
    violations.push({
      kind: 'hook_unregistered',
      detail: `hooks/${b} is bundled but registered nowhere (hooks.json or agent-template frontmatter) — a half-wired extension (P5); register it or add a documented exception`,
    });
  }
}

if (violations.length === 0) {
  console.log('agent registry consistency: ok');
  process.exit(0);
}
console.error('agent registry consistency FAILED:');
for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
process.exit(1);
