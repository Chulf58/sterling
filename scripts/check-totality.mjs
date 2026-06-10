// Totality check (spec §5.1/§5.2, invariant 5) — commit-time script form of
// the brain's totality test: every signal enum member has a reaction entry
// with a resolution flag; no reaction exists for a non-member. Requires built
// packages (npm run build).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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
