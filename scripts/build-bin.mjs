// Bundle every script a command, a skill or H1 invokes into the committed bin/
// directory, one standalone bin/<name>.mjs per BIN_ENTRIES member (decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone —
// a /plugin install has no node_modules and no packages/*/dist, so each must
// run without them). The scripts/ sources stay; bin/ is their build output.
// Requires built packages (npm run build).
//   node scripts/build-bin.mjs [--out-dir <dir>]
// --out-dir builds somewhere OTHER than the shipped bin/ — a test that needs a
// built bundle must use it (the build-hooks shape, board 3e569411).
// THIN CLI: the esbuild options live ONCE in scripts/lib/bundled-artifacts.mjs;
// this file owns only the shipped-path default and the strict flag parsing.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { buildBins } from './lib/bundled-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Parsed STRICTLY: an unrecognized or malformed argument refuses rather than
// falling through to the default, which overwrites the shipped bundles (P5).
const args = process.argv.slice(2);
let outDir = join(root, 'bin');
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--out-dir') {
    console.error(`build-bin: unrecognized argument '${args[i]}' — usage: build-bin.mjs [--out-dir <dir>]`);
    process.exit(1);
  }
  const value = args[++i];
  if (!value || value.startsWith('--')) {
    console.error('build-bin: --out-dir requires a directory argument');
    process.exit(1);
  }
  outDir = resolve(value);
}

mkdirSync(outDir, { recursive: true });
for (const file of await buildBins({ root, outDir })) {
  console.log(`bundled: ${relative(root, file).split('\\').join('/')}`);
}
