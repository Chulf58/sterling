// Record-id citation check (board item 10668ae3 — the PREVENTION half of the
// 2026-07-26 citation sweep; the sweep itself was the cure). Code and docs cite
// record ids constantly ("decision 6dfbe675", "article stale-server-guard
// 8f48f67c"), and nothing checked that the cited record EXISTS. A cross-machine
// knowledge import remapped record prose but not code citations, leaving five
// files citing origin-machine ids that resolve to nothing here — found by eye,
// with no detector. This is the detector: knowledge-transfer-export's rule 8
// becomes mechanical instead of prose.
//
// THE WHOLE DIFFICULTY IS FALSE POSITIVES — a naive version reports dozens of
// violations against a clean repo. Two rules stop that, and both are load-bearing:
//   1. resolve across MOUNTED stores, not just the project store — legitimately
//      cited ids live in the shared ~/.sterling/domains/<tag>/ stores;
//   2. resolve at ANY status — store.query() serves active records only, but
//      citing a SUPERSEDED record is legitimate and common (a comment names the
//      decision that originally justified a design). Tombstones pass.
// Plus the type-word rule in lib/checks.mjs: board/todo/note/maintenance ids are
// NOT required to resolve, because those records are removed when drained (P4).
//
// Outside an initialized project (no store) this is a loud no-op pass — the same
// shape as check-projection-fresh, whose store-reading pattern this mirrors.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openMounted } from './lib/project.mjs';
import { lintRecordCitations, UNCITED_RECORD_WORDS, CITATION_OPT_OUT, countCitationOptOuts } from './lib/checks.mjs';

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = join(root, '.sterling', 'sterling.db');

if (!existsSync(storePath)) {
  console.log('record citations: skipped (no store)');
  process.exit(0);
}

// Scanned: authored source and docs. NOT scanned, each for a reason:
//   docs/historical/** — the retired spec, deliberately frozen as it was written;
//   hooks/** — generated bundles (their sources are scanned, and check-bundles-fresh
//     already proves the two match byte for byte);
//   config.generated_projections — architecture.md is projected FROM the articles,
//     so its ids are the articles' business, not the tree's (the e1275166 precedent).
const SCANNED_EXTENSIONS = ['.mjs', '.ts', '.md'];
const EXCLUDED_PREFIXES = ['docs/historical/', 'hooks/'];

const { store, config } = openMounted(root);
let index;
try {
  index = store.recordIdIndex();
} finally {
  store.close();
}

const fullIds = new Set(index.map((r) => r.id));
const byPrefix = new Map();
for (const r of index) {
  const p = r.id.slice(0, 8);
  if (!byPrefix.has(p)) byPrefix.set(p, []);
  byPrefix.get(p).push(r);
}

/** undefined = nothing anywhere (the only failure), 'ambiguous' = prefix hits
 *  several records, otherwise the resolved record. A FULL id must match a full
 *  id: a prefix collision must never let a wrong-record citation pass. */
function resolve(id) {
  if (id.length > 8) return fullIds.has(id) ? { status: 'full' } : undefined;
  const hits = byPrefix.get(id);
  if (!hits || hits.length === 0) return undefined;
  return hits.length > 1 ? 'ambiguous' : hits[0];
}

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
if (tracked.status !== 0) {
  console.error(`record citations FAILED: git ls-files did not run in '${root}': ${tracked.stderr ?? ''}`);
  process.exit(1);
}

const excludedFiles = new Set(config?.generated_projections ?? []);
const files = tracked.stdout
  .split('\0')
  .filter(Boolean)
  .filter((f) => SCANNED_EXTENSIONS.some((e) => f.endsWith(e)))
  .filter((f) => !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)))
  .filter((f) => !excludedFiles.has(f));

const violations = [];
let citations = 0;
let optOuts = 0;
for (const file of files) {
  const abs = join(root, file);
  if (!existsSync(abs)) continue; // tracked but deleted in the working tree
  const content = readFileSync(abs, 'utf8');
  // Counted and reported, never silent: an opt-out is a bypass surface, so the
  // number of lines using it is part of the check's own output (P5).
  optOuts += countCitationOptOuts(content);
  const found = lintRecordCitations(content, file, (id) => {
    citations += 1;
    return resolve(id);
  });
  violations.push(...found);
}

if (violations.length > 0) {
  console.error(`record citations FAILED: ${violations.length} citation(s) do not resolve:`);
  for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
  console.error(
    '  Fix the citation to name a record that exists in this store (an id from another machine is the usual cause), or drop the id.'
  );
  process.exit(1);
}

console.log(
  `record citations: ok (${citations} citation(s) in ${files.length} file(s) resolve against ${index.length} records; ` +
    `${optOuts} line(s) opted out via '${CITATION_OPT_OUT}'; ` +
    `${UNCITED_RECORD_WORDS.join('/')} ids excluded by design — those records are removed when drained)`
);
