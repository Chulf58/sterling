// /sterling:init BOOTSTRAP — builtins-only entry point.
//
// WHY THIS EXISTS (boards 5634444c / 2a6b45c2; research_finding
// bootstrap-hole-fix-verified-clean-clone): a bare `git clone` + `npm ci`
// (no build yet) previously crashed here with a raw, unfriendly
// ERR_MODULE_NOT_FOUND — scripts/init-impl.mjs statically imports
// '@sterling/schemas' and '@sterling/store', and a static import HOISTS and
// resolves before any of init's own code (including its friendly
// mcpServerEntry refusal) ever gets a chance to run. This file imports ONLY
// node builtins, so it can always load, precheck that the workspaces are
// built, and print ONE loud, actionable refusal before anything downstream
// would throw a confusing raw module-resolution error.
//
// scripts/init.mjs MUST REMAIN THE SPAWNED ENTRY — H15's store_guard
// allow_scripts sanctions exactly this path (scripts/init.mjs), never
// scripts/init-impl.mjs, which is imported IN-PROCESS below and never
// spawned as its own script.
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Test seam (same falsy convention as STERLING_PLUGIN_ROOT_MATCH: '' behaves
// as unset) — lets a test point the precheck at a disposable fixture root
// without touching the real, already-built plugin clone.
const precheckRoot = process.env.STERLING_INIT_PRECHECK_ROOT || pluginRoot;

const nodeModulesOk = existsSync(join(precheckRoot, 'node_modules'));
const schemasDistOk = existsSync(join(precheckRoot, 'packages', 'schemas', 'dist', 'index.js'));
const storeDistOk = existsSync(join(precheckRoot, 'packages', 'store', 'dist', 'index.js'));

if (!nodeModulesOk) {
  console.error(`init REFUSED: dependencies are not installed — run \`npm ci\` in ${precheckRoot} (its prepare script builds the workspaces)`);
  process.exit(2);
}
if (!schemasDistOk || !storeDistOk) {
  console.error(`init REFUSED: workspace build output is missing — run \`npm run build && npm run build:tui\` in ${precheckRoot}`);
  process.exit(2);
}

// The implementation runs top-to-bottom exactly as before, in this same
// process (same argv, same exit codes) — the mcp-server-dist-only refusal
// (init-impl.mjs) still covers the one gap this precheck does not.
await import('./init-impl.mjs');
