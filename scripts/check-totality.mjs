// Totality check (spec §5.1/§5.2, invariant 5) — commit-time script form of
// the brain's totality test: every signal enum member has a reaction entry
// with a resolution flag; no reaction exists for a non-member. Requires built
// packages (npm run build).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Freshness guard (R2 board f5bf6593): this check validates COMPILED dist — a
// signal added to src without a rebuild was invisible (stale dist exits 0).
// Newest src mtime > newest dist mtime (1s epsilon) ⇒ fail loud, never
// validate a stale build. A missing dist still fails via the import below.
function newestMtime(dir, ext) {
  let newest = null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = newestMtime(full, ext);
      if (sub !== null && (newest === null || sub > newest)) newest = sub;
    } else if (e.name.endsWith(ext)) {
      const m = statSync(full).mtimeMs;
      if (newest === null || m > newest) newest = m;
    }
  }
  return newest;
}
for (const pkg of ['packages/schemas', 'packages/mcp-server']) {
  const src = newestMtime(join(root, pkg, 'src'), '.ts');
  const dist = newestMtime(join(root, pkg, 'dist'), '.js');
  if (src !== null && dist !== null && src > dist + 1000) {
    console.error(`totality check FAILED: ${pkg}/src is newer than ${pkg}/dist — validating a stale build proves nothing; run npm run build first`);
    process.exit(1);
  }
}

const schemas = await import(pathToFileURL(join(root, 'packages', 'schemas', 'dist', 'index.js')).href);
const brain = await import(pathToFileURL(join(root, 'packages', 'mcp-server', 'dist', 'index.js')).href);

const enumMembers = [...schemas.SPINE_SIGNALS].sort();
const tableMembers = Object.keys(brain.REACTIONS).sort();
const violations = [];
for (const m of enumMembers) {
  const entry = brain.REACTIONS[m];
  if (!entry) violations.push(`enum member '${m}' has no reaction in the table`);
  else {
    if (!entry.resolution) violations.push(`'${m}' has no resolution flag`);
    if (typeof entry.react !== 'function') violations.push(`'${m}' has no reaction function`);
  }
}
for (const m of tableMembers) {
  if (!enumMembers.includes(m)) violations.push(`reaction table member '${m}' is not in the signal enum`);
}

if (violations.length) {
  console.error('totality check FAILED:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`totality check: ok (${enumMembers.length} signals, all wired)`);
