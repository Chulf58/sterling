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
// Plus the type-word rule in lib/checks.mjs: board/todo/maintenance ids are
// NOT required to resolve, because those records are removed when drained (P4).
//
// Outside an initialized project (no store) — and inside one whose PROJECT store
// holds no records at all, the consumer-clone shape — this is a loud no-op pass:
// the same shape as check-projection-fresh, whose store-reading pattern this mirrors.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openMounted, openProject } from './lib/project.mjs';
import {
  lintRecordCitations,
  lintCitationCurrency,
  UNCITED_RECORD_WORDS,
  CITATION_OPT_OUT,
  countCitationOptOuts,
} from './lib/checks.mjs';

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = join(root, '.sterling', 'sterling.db');

if (!existsSync(storePath)) {
  console.log('record citations: skipped (no store)');
  process.exit(0);
}

// Scanned: authored source and docs. NOT scanned, each for a reason:
//   docs/historical/** — the retired spec, deliberately frozen as it was written;
//   docs/feedback/** — consuming-project reports, kept VERBATIM as evidence
//     (decision 42f385ea). Their ids belong to the REPORTING machine's store, not
//     this one, so they are correct there and unresolvable here — exactly the
//     "an id from another machine" case this check's own failure message names.
//     They are also third-party text: the 'not-a-citation' opt-out would work
//     mechanically, but editing markers into a document whose whole value is that
//     it is unaltered would trade the evidence for a green check.
//   hooks/** — generated bundles (their sources are scanned, and check-bundles-fresh
//     already proves the two match byte for byte);
//   config.generated_projections — architecture.md is projected FROM the articles,
//     so its ids are the articles' business, not the tree's (the e1275166 precedent).
const SCANNED_EXTENSIONS = ['.mjs', '.ts', '.md'];
const EXCLUDED_PREFIXES = ['docs/historical/', 'docs/feedback/', 'hooks/'];

// CONSUMER-CLONE PRECONDITION, one step further in than the no-store skip above
// (decision e6240afe-e94b-4c1f-8eed-bafe32fb4d89). A consumer machine's Sterling
// clone HAS a store — init creates it — but holds no knowledge, because
// .sterling/ is gitignored and records never travel with the repo. Every
// citation in the tree then "fails" for want of knowledge rather than for a bad
// id, which aborted the consumer update sequence at its check step (verified
// 2026-07-27 against an init'd empty root: all citations reported unresolved).
// The probe is the PROJECT store, not the mounted fan: the shared domain stores
// are per-machine and can hold plenty while this repo's own project-scoped
// records — what the tree actually cites — are absent, which is exactly what the
// first version of this guard got wrong. A PARTIALLY populated project store
// still fails loud: that is the mid-import state this check exists to surface.
const probe = openProject(root);
let projectRecordCount;
try {
  projectRecordCount = probe.store.recordIdIndex().length;
} finally {
  probe.store.close();
}
if (projectRecordCount === 0) {
  console.log('record citations: skipped (project store holds no records — a consumer clone)');
  process.exit(0);
}

const { store, config } = openMounted(root);
let index;
try {
  index = store.recordIdIndex();
} catch (e) {
  store.close();
  throw e;
}

// Stable identity (S5, decision stable-identity-design-v2): the migration
// collapses legacy chain members into record_aliases — every pre-migration
// historical id must KEEP resolving (the design's no-false-positives promise),
// so the dead-id index joins the resolution set as synthetic rows whose
// status reads 'superseded' (they forward to a canonical live record).
let aliasRows = [];
try {
  aliasRows = store.recordAliases();
} catch {
  aliasRows = []; // pre-v2 store: no alias table, nothing to join
}
for (const a of aliasRows) {
  index.push({ id: a.historical_id, type: 'alias', status: 'superseded' });
}

const fullIds = new Set(index.map((r) => r.id));
const byId = new Map(index.map((r) => [r.id, r]));
const byPrefix = new Map();
for (const r of index) {
  const p = r.id.slice(0, 8);
  if (!byPrefix.has(p)) byPrefix.set(p, []);
  byPrefix.get(p).push(r);
}

/** undefined = nothing anywhere (the only failure), 'ambiguous' = prefix hits
 *  several records, otherwise the resolved {id,type,status} row — a FULL id.
 *  A FULL id must match a full id: a prefix collision must never let a
 *  wrong-record citation pass. The returned row's `.id` and `.status` are what
 *  the currency check (lintCitationCurrency) needs on top of plain existence. */
function resolve(id) {
  if (id.length > 8) return fullIds.has(id) ? byId.get(id) : undefined;
  const hits = byPrefix.get(id);
  if (!hits || hits.length === 0) return undefined;
  return hits.length > 1 ? 'ambiguous' : hits[0];
}

// Full-body lookup for the currency walk ONLY — recordIdIndex (above) omits
// superseded_by by design (it is the cheap id/type/status projection every
// existence check needs; a currency walk needs the chain, so it pays for a
// get() per hop instead of widening that index for every caller). Kept open
// across the whole file loop below, closed once at every exit path.
const getById = (id) => store.get(id);

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
if (tracked.status !== 0) {
  store.close();
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
// Currency (board 9d0fb893): WARN-only, scoped to pointer surfaces (CLAUDE.md,
// templates/target-claude-md.md, skills/**, commands/**) — see lib/checks.mjs
// for the full rationale. Never affects the exit code below.
const currencyWarnings = [];
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
  currencyWarnings.push(...lintCitationCurrency(content, file, resolve, getById));
}
store.close();

function printCurrencyWarnings() {
  if (currencyWarnings.length === 0) return;
  console.log(`record citations: ${currencyWarnings.length} currency warning(s) — WARN ONLY, exit code unaffected:`);
  for (const w of currencyWarnings) console.log(`  [${w.kind}] ${w.detail}`);
}

// STORE AUTHORITY, one step further in than the consumer-clone skip above (config
// `store_authority`). That skip covers an EMPTY project store; this covers the
// other shape the same cause produces — a store holding plenty of records under
// ITS OWN ids while the tree cites another store's. Only the minting store can
// read a dangling citation as a defect; anywhere else every citation looks
// dangling for want of that id namespace, so the arm reports and passes instead
// of halting a check run nobody there can fix (P1). Never silent: the full list
// still prints, and the ok line names the setting, so a weakened arm is never
// mistaken for a clean one (P5). Currency warnings need no separate authority
// branch: on a secondary store a foreign citation mostly fails to resolve at
// all, so `resolve()` already returns falsy and lintCitationCurrency never
// gets a hit to walk — the same conditional posture falls out for free.
const authority = config?.store_authority ?? 'primary';

if (violations.length > 0 && authority === 'secondary') {
  console.log(
    `record citations: ${violations.length} citation(s) do not resolve — REPORTED, NOT FAILED (store_authority='secondary'):`
  );
  for (const v of violations) console.log(`  [${v.kind}] ${v.detail}`);
  console.log(
    "  This store did not mint the ids the tree cites, so a dangling id here is expected rather than a defect — and by the same token a citation written HERE is unchecked. On the store that mints them, leave store_authority='primary' (the default), where these must resolve."
  );
  printCurrencyWarnings();
  process.exit(0);
}

if (violations.length > 0) {
  console.error(`record citations FAILED: ${violations.length} citation(s) do not resolve:`);
  for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
  console.error(
    '  Fix the citation to name a record that exists in this store (an id from another machine is the usual cause), or drop the id.'
  );
  printCurrencyWarnings();
  process.exit(1);
}

printCurrencyWarnings();
console.log(
  `record citations: ok (${citations} citation(s) in ${files.length} file(s) resolve against ${index.length} records; ` +
    `${optOuts} line(s) opted out via '${CITATION_OPT_OUT}'; ` +
    `store_authority=${authority}; ` +
    `${currencyWarnings.length} currency warning(s) on pointer surfaces (superseded citation still resolving elsewhere); ` +
    `${UNCITED_RECORD_WORDS.join('/')} ids excluded by design — those records are removed when drained)`
);
