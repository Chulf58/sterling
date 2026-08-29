// Bundle the TUI (spec §11): esbuild single file, zero runtime node_modules
// resolution — the standalone launch path has no SessionStart hook to heal
// the environment, so there must be nothing to repair.
// Requires built packages (npm run build).
//   node scripts/build-tui.mjs [--out-file <path>]
// --out-file builds somewhere OTHER than the shipped bundle. A test that needs a
// built bundle must use it — building in place makes merely RUNNING the suite
// regenerate a tracked artifact from whatever happens to be in dist/ (the
// build-hooks shape, board 3e569411).
// THIN CLI: the esbuild options live ONCE in scripts/lib/bundled-artifacts.mjs
// (the bundled-artifact graph, board 16783088) — this file owns only the
// shipped-path default and the strict flag parsing. The freshness checker
// calls the same buildTui() into a temp target, so the options CANNOT drift
// between builder and checker.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { buildTui } from './lib/bundled-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Parsed STRICTLY: an unrecognized or malformed argument refuses rather than
// falling through to the default, which overwrites the shipped bundle (P5).
const args = process.argv.slice(2);
let outFile = join(root, 'packages', 'tui', 'bundle', 'sterling-tui.mjs');
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--out-file') {
    console.error(`build-tui: unrecognized argument '${args[i]}' — usage: build-tui.mjs [--out-file <path>]`);
    process.exit(1);
  }
  const value = args[++i];
  if (!value || value.startsWith('--')) {
    console.error('build-tui: --out-file requires a path argument');
    process.exit(1);
  }
  outFile = resolve(value);
}

await buildTui({ root, outFile });
console.log(`bundled: ${relative(root, outFile).split('\\').join('/')}`);
