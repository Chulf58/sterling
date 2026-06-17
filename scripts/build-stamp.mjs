// Build-stamp (stale-server guard, P5/P7). After tsc, hash the built SERVER
// outputs (schemas + store + mcp-server dist .js, excluding tests) into a
// content build-id written beside the server entry at
// packages/mcp-server/dist/.build-id. CONTENT-hash, not mtime: a no-op rebuild
// (same source) yields the SAME id, so H1's staleness check never false-alarms
// on a rebuild that changed nothing — it fires only when the server's actual
// code changed and the running process was not restarted. The server records
// this id at boot (packages/mcp-server/src/runtime.ts) and H1 compares it.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// the server (dist/main.js) loads exactly these three compiled packages
const SERVER_DIST_DIRS = ['packages/schemas/dist', 'packages/store/dist', 'packages/mcp-server/dist'];

function walkJs(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a dist dir not yet built — skip (the hash still covers the rest)
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'tests') continue; // server behavior excludes test files
      out = out.concat(walkJs(full));
    } else if (e.name.endsWith('.js')) {
      out.push(full); // .js only — .js.map / .d.ts / .build-id never affect behavior
    }
  }
  return out;
}

const files = SERVER_DIST_DIRS.flatMap((d) => walkJs(join(root, d)))
  .map((f) => relative(root, f).replace(/\\/g, '/'))
  .sort();

const h = createHash('sha256');
for (const rel of files) {
  h.update(rel);
  h.update('\0');
  h.update(readFileSync(join(root, rel)));
}
const id = h.digest('hex').slice(0, 16);

const out = join(root, 'packages', 'mcp-server', 'dist', '.build-id');
writeFileSync(out, id);
console.log(`build-stamp: ${id} (${files.length} server files) -> packages/mcp-server/dist/.build-id`);
