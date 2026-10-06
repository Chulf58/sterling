// Bundles the Sterling OpenCode 2 server plugin (packages/opencode-plugin/src/server.mjs)
// into the committed single file opencode/sterling-server.mjs. Registered in
// scripts/lib/bundled-artifacts.mjs, so check-bundles-fresh gates it.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { buildOpencode } from './lib/bundled-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
let outFile = join(root, 'opencode', 'sterling-server.mjs');
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--out-file') {
    console.error(`build-opencode: unrecognized argument '${args[i]}' — usage: build-opencode.mjs [--out-file <path>]`);
    process.exit(1);
  }
  const value = args[++i];
  if (!value || value.startsWith('--')) {
    console.error('build-opencode: --out-file requires a path argument');
    process.exit(1);
  }
  outFile = resolve(value);
}

mkdirSync(dirname(outFile), { recursive: true });
for (const file of await buildOpencode({ root, outFile })) {
  console.log(`bundled: ${relative(root, file).split('\\').join('/')}`);
}
