// Record-id citation check (board item 10668ae3 — the PREVENTION half of the
// 2026-07-26 citation sweep; the sweep itself was the cure). Code and docs cite
// record ids constantly ("decision foreign_6dfbe675", "article stale-server-guard
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
// SLUG citations (rule 5 of decision c6985ed4; grammar in
// lib/checks.mjs collectSlugCitations) resolve the same way, cross-store and at
// any status, but a dangling slug is a WARNING that leaves the exit code alone
// while SLUG_CITATIONS_FAIL below is false. User-ruled 2026-10-14 ("Build it
// warn-only now"): the store forked on 2026-09-21 and about 216 cited records
// live only in the hobby computer's store until it is imported (board
// 907216e6). THE SWITCH: once that import lands and the warnings are cleared,
// set SLUG_CITATIONS_FAIL = true; dangling slugs then fail the check exactly
// like dangling ids. Nothing else changes.
//
// Outside an initialized project (no store) — and inside one whose PROJECT store
// holds no records at all, the consumer-clone shape — this is a loud no-op pass:
// the same shape as check-projection-fresh, whose store-reading pattern this mirrors.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openMounted, openProject } from './lib/project.mjs';
import { buildResolver } from './lib/citations.mjs';
import { nonAuthoringSelfRoot } from './lib/self-root-role.mjs';
import {
  lintRecordCitations,
  lintSlugCitations,
  collectSlugCitations,
  lintCitationCurrency,
  UNCITED_RECORD_WORDS,
  CITATION_OPT_OUT,
  countCitationOptOuts,
} from './lib/checks.mjs';

// The Sterling clone this script ships in: scripts/ and bin/ both sit one level
// below it, and the bin/ bundle rewrites import.meta.url to this source's path.
const selfRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.argv[2] ?? selfRoot;

// The one switch for slug citations (see the header): false = report dangling
// slugs as warnings, exit code unaffected; true = they fail like dangling ids.
const SLUG_CITATIONS_FAIL = false;
// How many slug warnings are printed; the full count is always reported.
const SLUG_WARNING_PRINT_CAP = 50;
const storePath = join(root, '.sterling', 'sterling.db');

if (!existsSync(storePath)) {
  console.log('record citations: skipped (no store)');
  process.exit(0);
}

// Scanned: authored source and docs. NOT scanned, each for a reason:
//   docs/historical/** — the retired spec, deliberately frozen as it was written;
//   docs/feedback/** — consuming-project reports, kept VERBATIM as evidence
//     (decision foreign_42f385ea). Their ids belong to the REPORTING machine's store, not
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
// (decision foreign_e6240afe). A consumer machine's Sterling
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
// Resolver seam (scripts/lib/citations.mjs, board c3705a15): id-universe
// build (recordIdIndex + the S5 record_aliases dead-id join) plus resolve()/
// getById() live there now, reused by scripts/knowledge-export.mjs. Kept
// open across the whole file loop below, closed once at every exit path.
let resolver;
try {
  resolver = buildResolver(store);
} catch (e) {
  store.close();
  throw e;
}
const { resolve, resolveSlug, getById, size: indexSize } = resolver;

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
// Currency (board 9d0fb893): WARN-only, scoped to pointer surfaces (AGENTS.md, CLAUDE.md,
// templates/target-agents-md.md, templates/target-claude-md.md, skills/**, commands/**) —
// see lib/checks.mjs for the full rationale. Never affects the exit code below.
const currencyWarnings = [];
let citations = 0;
let slugCitations = 0;
const slugWarnings = [];
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
  slugCitations += collectSlugCitations(content).length;
  slugWarnings.push(...lintSlugCitations(content, file, resolveSlug));
  currencyWarnings.push(...lintCitationCurrency(content, file, resolve, getById));
}
store.close();

if (SLUG_CITATIONS_FAIL) violations.push(...slugWarnings);
const slugResolved = slugCitations - slugWarnings.length;
const slugDistinct = new Set(slugWarnings.map((w) => w.slug)).size;
const slugSummary = SLUG_CITATIONS_FAIL
  ? `${slugResolved} slug citation(s) resolve`
  : `${slugResolved} slug citation(s) resolve, ${slugWarnings.length} dangling slug citation(s) (${slugDistinct} distinct slugs) WARN ONLY`;

function printSlugWarnings() {
  if (SLUG_CITATIONS_FAIL || slugWarnings.length === 0) return;
  console.log(
    `record citations: ${slugWarnings.length} slug citation(s) (${slugDistinct} distinct slugs) resolve to no record — WARN ONLY, exit code unaffected (SLUG_CITATIONS_FAIL=false):`
  );
  for (const w of slugWarnings.slice(0, SLUG_WARNING_PRINT_CAP)) console.log(`  [${w.kind}] ${w.detail}`);
  if (slugWarnings.length > SLUG_WARNING_PRINT_CAP) {
    console.log(`  ... and ${slugWarnings.length - SLUG_WARNING_PRINT_CAP} more`);
  }
}

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

// MACHINE ROLE, for Sterling's own tree only (GitHub issue #84). The citations in
// Sterling's source name records minted in the AUTHORING machine's project store.
// A consumer clone that has a populated project store of its own (so the
// empty-store skip above misses it) cannot resolve them, and failing here
// aborted /sterling:update at its check step on every rerun. So when the checked
// root IS the clone this script ships in, only machine_role 'authoring' enforces;
// 'consumer' and undeclared report the full list and pass, naming the role.
// Every OTHER project root (a consuming project run through sterling-check)
// keeps the plain enforcement: init never writes machine_role there, and that
// project's own store minted the ids its tree cites.
// The self-root and role predicate is shared with check-projection-fresh.
const relaxed = nonAuthoringSelfRoot(root, selfRoot, config);

if (violations.length > 0 && relaxed) {
  const { roleText } = relaxed;
  console.log(
    `record citations: ${violations.length} citation(s) do not resolve — REPORTED, NOT FAILED — ${roleText} (only the authoring machine's store can judge a citation):`
  );
  for (const v of violations) console.log(`  [${v.kind}] ${v.detail}`);
  console.log(
    "  This is Sterling's own tree on a machine that did not mint the ids it cites. On the authoring machine, declare machine_role 'authoring' in .sterling/config.json, where these must resolve."
  );
  printCurrencyWarnings();
  printSlugWarnings();
} else if (violations.length > 0 && authority === 'secondary') {
  console.log(
    `record citations: ${violations.length} citation(s) do not resolve — REPORTED, NOT FAILED (store_authority='secondary'):`
  );
  for (const v of violations) console.log(`  [${v.kind}] ${v.detail}`);
  console.log(
    "  This store did not mint the ids the tree cites, so a dangling id here is expected rather than a defect — and by the same token a citation written HERE is unchecked. On the store that mints them, leave store_authority='primary' (the default), where these must resolve."
  );
  printCurrencyWarnings();
  printSlugWarnings();
} else if (violations.length > 0) {
  console.error(`record citations FAILED: ${violations.length} citation(s) do not resolve:`);
  for (const v of violations) console.error(`  [${v.kind}] ${v.detail}`);
  console.error(
    '  Fix the citation to name a record that exists in this store (an id from another machine is the usual cause), or drop the id.'
  );
  printCurrencyWarnings();
  printSlugWarnings();
  // exitCode, not exit(): the warning list can be long, and exit() right after
  // console.log to a pipe can cut the output short.
  process.exitCode = 1;
} else {
  printCurrencyWarnings();
  console.log(
    `record citations: ok (${citations} citation(s) in ${files.length} file(s) resolve against ${indexSize} records; ` +
      `${slugSummary}; ` +
      `${optOuts} line(s) opted out via '${CITATION_OPT_OUT}'; ` +
      `store_authority=${authority}; ` +
      `${currencyWarnings.length} currency warning(s) on pointer surfaces (superseded citation still resolving elsewhere); ` +
      `${UNCITED_RECORD_WORDS.join('/')} ids excluded by design — those records are removed when drained)`
  );
  printSlugWarnings();
}
