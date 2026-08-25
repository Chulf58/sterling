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

const registryChecks = checkRegistryConsistency({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  // scripts/hooks/ is the convention-injection surface (H1 speaks into every
  // session ahead of every conductor) — the dead-term scan is strictly worse
  // at missing residue there than in templates/, which only gets stamped
  // occasionally. Board f4221f8a: a term banned everywhere else shipped in H1
  // undetected, and text copied VERBATIM out of H1 into a template then failed
  // the merge for carrying the very term H1 itself carried.
  //
  // packages/store/src + packages/tui/src (board c05da1d1): a banned term
  // living in store source propagated into 17 built bundles while this scan
  // stayed structurally blind to packages/ entirely. packages/mcp-server/src
  // + packages/schemas/src joined in the same board item's follow-up slice,
  // closing the remaining gap over comment-level residue in those packages.
  scanDirs: [
    join(pluginRoot, 'templates'),
    join(pluginRoot, 'commands'),
    join(pluginRoot, 'skills'),
    join(pluginRoot, 'scripts', 'hooks'),
    join(pluginRoot, 'packages', 'store', 'src'),
    join(pluginRoot, 'packages', 'tui', 'src'),
    join(pluginRoot, 'packages', 'mcp-server', 'src'),
    join(pluginRoot, 'packages', 'schemas', 'src'),
  ],
  // hooks/ is the BUILT bundle output (scripts/hooks/ above is its source) —
  // verify-only: a hit here means "rebuild bundles", not "edit this file".
  bundleScanDirs: [join(pluginRoot, 'hooks')],
});

// dead_term_bundle hits are advisory, not a failing violation: they name stale
// BUILT bundles awaiting a rebuild, never a source defect (board c05da1d1
// review follow-up) — reported below but excluded from the exit-1 set so
// `npm run check` does not refuse merely because bundles haven't been rebuilt
// yet. `violations` stays the sole exit-1 authority.
const violations = registryChecks.filter((v) => v.kind !== 'dead_term_bundle');
const bundleAdvisories = registryChecks.filter((v) => v.kind === 'dead_term_bundle');

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
// (The sole entry, h11-note-structure.mjs, left with the note surface on
// 2026-08-11 — decision 'note-surface-retired'.)
const HOOK_REGISTRATION_EXCEPTIONS = new Map([]);
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

if (bundleAdvisories.length > 0) {
  console.log(`agent registry consistency: ${bundleAdvisories.length} stale-bundle dead-term hit(s) (advisory, rebuild bundles):`);
  for (const v of bundleAdvisories) console.log(`  [${v.kind}] ${v.detail}`);
}

if (violations.length === 0) {
  console.log('agent registry consistency: ok');
  process.exit(0);
}
console.error('agent registry consistency FAILED:');
for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
process.exit(1);
