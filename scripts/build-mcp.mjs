// Bundle the MCP server into the committed mcp/ directory: mcp/sterling-mcp.mjs
// plus mcp/.build-id beside it (decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone —
// a /plugin install is a copy of the git tree with no build step, so the
// runnable server must be committed). Requires built packages (npm run build).
//   node scripts/build-mcp.mjs [--out-dir <dir>]
// --out-dir builds somewhere OTHER than the shipped mcp/ — a test that needs a
// built bundle must use it (the build-hooks shape, board 3e569411).
// THIN CLI: the esbuild options live ONCE in scripts/lib/bundled-artifacts.mjs;
// this file owns only the shipped-path default and the strict flag parsing.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { buildMcp } from './lib/bundled-artifacts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Parsed STRICTLY: an unrecognized or malformed argument refuses rather than
// falling through to the default, which overwrites the shipped bundle (P5).
const args = process.argv.slice(2);
let outDir = join(root, 'mcp');
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--out-dir') {
    console.error(`build-mcp: unrecognized argument '${args[i]}' — usage: build-mcp.mjs [--out-dir <dir>]`);
    process.exit(1);
  }
  const value = args[++i];
  if (!value || value.startsWith('--')) {
    console.error('build-mcp: --out-dir requires a directory argument');
    process.exit(1);
  }
  outDir = resolve(value);
}

mkdirSync(outDir, { recursive: true });
for (const file of await buildMcp({ root, outDir })) {
  console.log(`bundled: ${relative(root, file).split('\\').join('/')}`);
}
