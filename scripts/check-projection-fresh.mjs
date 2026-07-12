// Projection freshness check (spec §15 via §12; audit finding 25/43): the
// committed architecture.md is a GENERATED projection whose regeneration is NOT
// bound to a mechanical event, so it can silently lag the store (it had — ~23
// days). This check makes the drift fail LOUD instead of drifting quiet (P4/P5):
// it compares the file's header as-of stamp against the store's newest article
// updated_at — the SAME value architecture-projection.mjs stamps (max over all
// feature_article updated_at) — and fails when they differ, naming the fix.
//
// Outside an initialized project (no store) the check is a no-op pass — the
// projection is a Sterling-repo deliverable, not a consuming-project artifact.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { openProject } from './lib/project.mjs';

// Target defaults to the plugin/repo root (npm run check); an explicit dir arg
// lets the test — or a consuming project — point it elsewhere.
const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const archPath = join(root, 'architecture.md');
const storePath = join(root, '.sterling', 'sterling.db');

// no store / no file → nothing to check (a fresh clone or a consuming project)
if (!existsSync(storePath) || !existsSync(archPath)) {
  console.log('projection freshness: skipped (no store or no architecture.md)');
  process.exit(0);
}

const { store } = openProject(root);
let newest;
try {
  const articles = store.query({ types: ['feature_article'], cap: 1000 });
  newest = articles.map((a) => a.updated_at).sort().at(-1) ?? 'empty store';
} finally {
  store.close();
}

const header = readFileSync(archPath, 'utf8').slice(0, 400);
const m = header.match(/store state as of ([^)]+)\)/);
if (!m) {
  console.error('projection freshness FAILED: architecture.md has no "store state as of <stamp>" header — regenerate: node scripts/architecture-projection.mjs');
  process.exit(1);
}
const stamped = m[1].trim();

if (stamped !== newest) {
  console.error(
    `projection freshness FAILED: architecture.md is stale — header as-of ${stamped}, store newest article ${newest}.\n` +
      '  Regenerate and commit: node scripts/architecture-projection.mjs'
  );
  process.exit(1);
}
console.log(`projection freshness: ok (as of ${stamped})`);
