// Projection freshness check (spec §15 via §12; audit finding 25/43): the
// committed architecture.md is a GENERATED projection whose regeneration is NOT
// bound to a mechanical event, so it can silently lag the store (it had — ~23
// days). This check makes the drift fail LOUD instead of drifting quiet (P4/P5):
// it compares the file's header as-of stamp against the store's newest article
// updated_at — the SAME value architecture-projection.mjs stamps (max over all
// feature_article updated_at) — and fails when they differ, naming the fix.
//
// rulings.md (decision 255f58b7, closes board 8f81704a) is the SECOND member of
// this arm, registered here rather than as a separate script: same failure
// mode (regeneration not bound to a mechanical event), same header shape, same
// store_authority carve-out — the only difference is which record types feed
// the as-of stamp (decision + anti_pattern, not feature_article), so each
// projection is described as one row of {file, label, types, regenerate} and
// checked by one shared function.
//
// Outside an initialized project (no store) the check is a no-op pass — both
// projections are Sterling-repo deliverables, not consuming-project artifacts.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { openProject } from './lib/project.mjs';

// Target defaults to the plugin/repo root (npm run check); an explicit dir arg
// lets the test — or a consuming project — point it elsewhere.
const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = join(root, '.sterling', 'sterling.db');

const PROJECTIONS = [
  {
    file: 'architecture.md',
    label: 'architecture.md',
    types: ['feature_article'],
    regenerate: 'node scripts/architecture-projection.mjs',
    noRecordsSkipReason: 'store holds no articles — a consumer clone',
  },
  {
    file: 'rulings.md',
    label: 'rulings.md',
    types: ['decision', 'anti_pattern'],
    regenerate: 'node scripts/rulings-projection.mjs',
    noRecordsSkipReason: 'store holds no decisions or anti_patterns — a consumer clone',
  },
];

// no store → nothing to check anywhere (a fresh clone or a consuming project)
if (!existsSync(storePath)) {
  console.log('projection freshness: skipped (no store)');
  process.exit(0);
}

const { store, config } = openProject(root);
let failed = false;
try {
  for (const proj of PROJECTIONS) {
    const path = join(root, proj.file);
    if (!existsSync(path)) {
      console.log(`projection freshness: skipped (no ${proj.file})`);
      continue;
    }

    const records = store.query({ types: proj.types, cap: 5000 });
    const newest = records.map((r) => r.updated_at).sort().at(-1) ?? null;

    // An initialized store holding NONE of the feeding types is the same
    // situation as no store at all, one step further in: a consumer machine's
    // Sterling clone has a store (init creates it) but no knowledge (.sterling/
    // is gitignored, so records never travel with the repo). Comparing the
    // committed projection against an empty store reports staleness that
    // cannot exist there — and it aborted the consumer update sequence at its
    // check step (decision e6240afe-e94b-4c1f-8eed-bafe32fb4d89, verified
    // 2026-07-27 against an init'd empty root). Skip LOUD, never silently pass.
    if (newest === null) {
      console.log(`projection freshness: skipped (${proj.noRecordsSkipReason})`);
      continue;
    }

    const header = readFileSync(path, 'utf8').slice(0, 400);
    const m = header.match(/store state as of ([^)]+)\)/);
    if (!m) {
      console.error(
        `projection freshness FAILED: ${proj.file} has no "store state as of <stamp>" header — regenerate: ${proj.regenerate}`
      );
      failed = true;
      continue;
    }
    const stamped = m[1].trim();

    // STORE AUTHORITY (config `store_authority`), one step further in than the
    // no-records skip above and the exact analogue of the citation arm's. A
    // SECONDARY store did not produce the committed projection, so a mismatch
    // here carries no information — and unlike every other check in the
    // battery, its stated remedy would do harm: regenerating from a store that
    // holds fewer records projects a SMALLER file, silently regressing a shared
    // file (observed on architecture.md: 53 lines against the repo's 65).
    // Report the drift, never act on it.
    if (stamped !== newest && (config?.store_authority ?? 'primary') === 'secondary') {
      console.log(
        `projection freshness: ${proj.file} as-of ${stamped}, this store's newest ${proj.label} record ${newest} — REPORTED, NOT FAILED (store_authority='secondary').\n` +
          `  The committed projection was generated from the primary store; do NOT regenerate here, it would shrink the file to this store's contents.`
      );
      continue;
    }

    if (stamped !== newest) {
      console.error(
        `projection freshness FAILED: ${proj.file} is stale — header as-of ${stamped}, store newest ${proj.label} record ${newest}.\n` +
          `  Regenerate and commit: ${proj.regenerate}`
      );
      failed = true;
      continue;
    }
    console.log(`projection freshness: ok (${proj.file} as of ${stamped}, store_authority=${config?.store_authority ?? 'primary'})`);
  }
} finally {
  store.close();
}

process.exit(failed ? 1 : 0);
