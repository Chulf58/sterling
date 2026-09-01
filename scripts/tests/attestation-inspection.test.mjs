// ---------------------------------------------------------------------------
// PIN GROUP — attestation inspection SHARED LIB (decision
// attestation-staleness-disclosure-only-never-a-refusing-gate / 1f069af4 v2,
// board attestation-gate 9868a0dd). SPEC-ONLY: scripts/lib/attestation-
// inspection.mjs DOES NOT EXIST YET. The module is loaded via a dynamic
// import() inside before(), guarded so a missing module produces a per-test
// AssertionError (via callInspect's own typeof check) rather than a bare
// module-resolution crash that would kill the whole suite before any test
// registers — the same "assertion-shaped, never a bare crash" discipline
// migration-preflight.test.mjs and migration-runner.test.mjs already use for
// spawned scripts, applied here to a directly-imported module instead.
//
// CONTRACT AUTHORED HERE (the decision gives FIELDS/SEMANTICS, not exact JSON
// shape or function name — per the test-writer mandate this file is the
// oracle for that shape, and the coder implements against it):
//
//   inspectAttestations({ projectRoot, touchedPaths, declaredGlobs }) -> {
//     available: boolean,
//     reason?: string,                    // present when available:false
//     reports?: [{                        // present when available:true, one per declared glob, IN ORDER, no de-dup
//       glob: string,
//       touched_count: number,            // touched paths matching this glob
//       comparable_count: number,         // of those, how many have >=1 LIVE covering attestation
//       verdicts: { approved: number, rejected: number, needs_rework: number }, // sums to comparable_count
//       uncovered_count: number,          // touched_count - comparable_count
//       examples: [{ path: string, verdict: 'approved'|'rejected'|'needs_rework'|'uncovered' }], // capped at 5
//       omitted_count: number,            // touched_count - examples.length
//     }, ...],
//     pathless_attestation_count?: number, // present when available:true — live attestations with empty/absent file_keys
//     skipped_malformed_count?: number,    // present when available:true — rows whose body JSON failed to parse
//   }
//
// AMBIGUITIES RESOLVED (flagged, not invented from nothing):
//   - examples cap = 5, taken literally from the decision's own "capped
//     examples (cap small, e.g. 5)" / "capped examples ... with +N more"
//     language — authored as an exact contract number since none is fixed
//     elsewhere.
//   - equal-inspected_at tiebreak direction: the decision says "id tiebreak
//     on equality" without naming a direction. Resolved as GREATEST id wins
//     (lexicographic string compare), matching the "greatest inspected_at"
//     comparator direction already named for the primary sort. T11 hardcodes
//     ids so this is unambiguous to grade.
//   - "lifecycle='superseded'" in the dispatch brief's adversarial-case list
//     is a description, not a literal enum value: knowledge_schema('attestation')
//     shows lifecycle is closed to {live, retired} (status, not lifecycle, is
//     {active, superseded}). T8 uses lifecycle:'retired' for the non-live
//     fixture row.
//   - glob semantics assumed standard POSIX/minimatch: '*' matches within one
//     path segment (never crosses '/'), '**' matches zero or more segments.
//     T16 pins both directions.
//   - within-priority ordering of examples (e.g. which two of three
//     'uncovered' paths get shown when only one slot remains) is NOT pinned —
//     only the CATEGORY at each position and the total count are pinned, to
//     avoid inventing a tie-break the decision never specifies.
//
// NAMED GAPS — NOT PINNED:
//   - no git integration is tested anywhere in this file (touchedPaths is a
//     plain input list; deleted-path semantics are the caller's concern per
//     the brief).
//   - config-level duplicate-glob VALIDATION/rejection is out of this
//     module's scope per the brief; T6 pins only that the module itself does
//     not silently de-dup what it's given.
// ---------------------------------------------------------------------------
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE_PATH = join(root, 'scripts', 'lib', 'attestation-inspection.mjs');
const NOW = '2026-08-31T09:00:00.000Z';

let DatabaseSync;
let inspectAttestations;
let importError;
before(async () => {
  ({ DatabaseSync } = await import('node:sqlite'));
  try {
    const mod = await import(pathToFileURL(MODULE_PATH).href);
    inspectAttestations = mod.inspectAttestations;
  } catch (err) {
    importError = err;
  }
});

/** Calls the module under test, but first asserts the export exists as a
 *  function — turning a not-yet-existing module into a normal, per-test
 *  AssertionError instead of a suite-wide crash. */
async function callInspect(args) {
  assert.equal(
    typeof inspectAttestations,
    'function',
    'scripts/lib/attestation-inspection.mjs must export inspectAttestations as a function' +
      (importError ? ` (module import failed: ${importError.message})` : ` (export was: ${typeof inspectAttestations})`)
  );
  return await inspectAttestations(args);
}

// ── fixture plumbing ────────────────────────────────────────────────────────

// v2-shaped `records` table — the real column set (id/type/status/
// superseded_by/lifecycle/freshness/version/scope/created_at/updated_at/
// author/derived_unconfirmed/body), taken from the same v2 DDL sibling suite
// domain-doctor-v2-repair.test.mjs already pins for a fixture 'records' table
// carrying the v2 'lifecycle' column (a TEST file, not implementation).
const RECORDS_V2_DDL = `
  CREATE TABLE records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    superseded_by TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'live',
    freshness TEXT NOT NULL DEFAULT 'fresh',
    version INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    author TEXT NOT NULL,
    derived_unconfirmed INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL
  );
`;

function tempProjectRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'attestation-inspect-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return dir;
}

function dbPathFor(projectRoot) {
  return join(projectRoot, '.sterling', 'sterling.db');
}

/** Builds a real WAL-mode sterling.db (packages/store is WAL+FTS5 per the
 *  repo's own documented facts) at projectRoot/.sterling/sterling.db, with
 *  the given raw rows inserted directly (fixture setup — not store code). A
 *  forced TRUNCATE checkpoint before close gives every test a clean,
 *  deterministic "before" directory snapshot (sterling.db alone), so T17/T18
 *  are not at the mercy of the fixture's OWN write session's WAL cleanup. */
function buildDb(projectRoot, rows) {
  const dbPath = dbPathFor(projectRoot);
  const db = new DatabaseSync(dbPath);
  db.exec(RECORDS_V2_DDL);
  const stmt = db.prepare(
    `INSERT INTO records (id, type, status, superseded_by, lifecycle, freshness, version, scope, created_at, updated_at, author, derived_unconfirmed, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    stmt.run(
      r.id, r.type, r.status, r.superseded_by ?? null, r.lifecycle, r.freshness ?? 'fresh', r.version ?? 1,
      r.scope ?? 'project', r.created_at ?? NOW, r.updated_at ?? NOW, r.author ?? 'user', 0, r.rawBody
    );
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return dbPath;
}

/** A live/retired attestation row, body per knowledge_schema('attestation'). */
function attestationRow({
  id = randomUUID(), verdict = 'approved', inspectedAt = '2026-08-20', fileKeys = [],
  lifecycle = 'live', artifactKey = 'artifact', inspector = 'human-tester',
} = {}) {
  const status = lifecycle === 'retired' ? 'superseded' : 'active';
  const body = {
    id, type: 'attestation', created_at: NOW, updated_at: NOW, author: 'user',
    status, superseded_by: null, lifecycle, freshness: 'fresh', version: 1,
    links: [], scope: 'project', stack_tags: [],
    artifact_key: artifactKey, verdict, inspector, inspected_at: inspectedAt,
    file_keys: fileKeys,
  };
  return {
    id, type: 'attestation', status, superseded_by: null, lifecycle, freshness: 'fresh', version: 1,
    scope: 'project', created_at: NOW, updated_at: NOW, author: 'user', rawBody: JSON.stringify(body),
  };
}

/** A non-attestation (decision) row, to prove the type filter is real. */
function decisionRow({ id = randomUUID(), fileKeys = [] } = {}) {
  const body = {
    id, type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, lifecycle: 'live', freshness: 'fresh', version: 1, links: [], scope: 'project',
    stack_tags: [], title: 't', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: fileKeys,
  };
  return {
    id, type: 'decision', status: 'active', superseded_by: null, lifecycle: 'live', freshness: 'fresh',
    version: 1, scope: 'project', created_at: NOW, updated_at: NOW, author: 'conductor', rawBody: JSON.stringify(body),
  };
}

/** An attestation row whose body column is NOT parseable JSON. */
function malformedRow({ id = randomUUID() } = {}) {
  return {
    id, type: 'attestation', status: 'active', superseded_by: null, lifecycle: 'live', freshness: 'fresh',
    version: 1, scope: 'project', created_at: NOW, updated_at: NOW, author: 'user', rawBody: 'not-json{{{',
  };
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Recursively asserts no key in FORBIDDEN_KEYS appears anywhere in obj. */
function assertNoFreshnessPredicate(obj, path = '$') {
  const FORBIDDEN = new Set(['fresh', 'stale', 'is_fresh', 'is_stale', 'currency', 'up_to_date']);
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    assert.ok(!FORBIDDEN.has(k), `no freshness/staleness predicate field is allowed anywhere in the result (found '${k}' at ${path})`);
    assertNoFreshnessPredicate(v, `${path}.${k}`);
  }
}

// ── T1: happy-path baseline / CONTROL for the adversarial tests below ──────

test('T1: a single live approved attestation covering its touched path — full baseline shape', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [attestationRow({ verdict: 'approved', inspectedAt: '2026-08-20', fileKeys: ['src/a.ts'] })]);

  const result = await callInspect({ projectRoot, touchedPaths: ['src/a.ts'], declaredGlobs: ['src/*.ts'] });

  assert.equal(result.available, true, 'a valid, present db must be available:true');
  assert.equal(result.reports.length, 1, 'one declared glob -> one report');
  const r = result.reports[0];
  assert.equal(r.glob, 'src/*.ts');
  assert.equal(r.touched_count, 1);
  assert.equal(r.comparable_count, 1);
  assert.deepEqual(r.verdicts, { approved: 1, rejected: 0, needs_rework: 0 });
  assert.equal(r.uncovered_count, 0);
  assert.equal(r.examples.length, 1);
  assert.equal(r.examples[0].verdict, 'approved');
  assert.equal(r.omitted_count, 0);
  assert.equal(result.pathless_attestation_count, 0, 'no pathless attestations exist in this fixture — this is the CONTROL other pathless tests compare against');
  assert.equal(result.skipped_malformed_count, 0, 'no malformed rows exist in this fixture — the CONTROL for T3');
});
// SABOTAGE: return a hardcoded stub `{ available: true, reports: [] }` regardless of input.
// EXPECTED RED: `assert.equal(result.reports.length, 1, ...)` fails (0 !== 1).

// ── T2: missing db file ─────────────────────────────────────────────────────

test('T2: a missing sterling.db returns { available:false, reason }, never throws', async () => {
  const projectRoot = tempProjectRoot(); // .sterling/ exists, sterling.db does not
  assert.equal(existsSync(dbPathFor(projectRoot)), false, 'precondition: db genuinely absent');

  let result;
  await assert.doesNotReject(async () => {
    result = await callInspect({ projectRoot, touchedPaths: ['src/a.ts'], declaredGlobs: ['src/*.ts'] });
  }, 'a missing db must be handled internally, never surfaced as a thrown/rejected error');

  assert.equal(result.available, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'reason must be a non-empty disclosure, not a blank placeholder');
});
// SABOTAGE: delete the existsSync/try-catch guard around the DatabaseSync open, letting the
// ENOENT propagate.
// EXPECTED RED: `assert.doesNotReject(...)` fails — the async callback rejects with an ENOENT-shaped error.

// ── T3: malformed JSON row is skipped and disclosed, other rows still served ─

test('T3: one malformed-JSON row is skipped+disclosed; other live rows are still served', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [
    attestationRow({ verdict: 'approved', fileKeys: ['src/a.ts'] }),
    malformedRow(),
  ]);

  const result = await callInspect({ projectRoot, touchedPaths: ['src/a.ts'], declaredGlobs: ['src/*.ts'] });

  assert.equal(result.available, true, 'one bad row must not take down the whole read (never total unavailability)');
  assert.equal(result.skipped_malformed_count, 1, 'exactly the one malformed row is disclosed as skipped');
  const r = result.reports[0];
  assert.equal(r.comparable_count, 1, 'the valid attestation is still counted');
  assert.deepEqual(r.verdicts, { approved: 1, rejected: 0, needs_rework: 0 });
});
// SABOTAGE: remove the per-row try/catch around JSON.parse(body), letting one bad row throw
// and abort the whole query loop.
// EXPECTED RED: either `assert.equal(result.available, true, ...)` fails (available flips to
// false / whole call throws), or `skipped_malformed_count` stays undefined/0 while
// `comparable_count` also drops to 0 because the loop aborted before reaching the good row.

// ── T4: exact-match coverage; NO glob expansion of file_keys ────────────────

test('T4: coverage is EXACT file_keys membership — a file_keys entry that looks like a glob never widens', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [
    attestationRow({ id: randomUUID(), verdict: 'approved', fileKeys: ['src/foo.ts'] }), // literal match -> covers foo.ts
    attestationRow({ id: randomUUID(), verdict: 'approved', fileKeys: ['src/*.ts'] }),   // glob-shaped STRING, must NOT widen to cover bar.ts
  ]);

  const result = await callInspect({
    projectRoot,
    touchedPaths: ['src/foo.ts', 'src/bar.ts'],
    declaredGlobs: ['src/*.ts'],
  });

  const r = result.reports[0];
  assert.equal(r.touched_count, 2);
  assert.equal(r.comparable_count, 1, 'only foo.ts has a literal covering file_keys entry');
  assert.equal(r.uncovered_count, 1, 'bar.ts stays uncovered despite the decoy glob-shaped file_keys string');
  const byVerdict = r.examples.map((e) => e.verdict).sort();
  assert.ok(r.examples.some((e) => e.path === 'src/bar.ts' && e.verdict === 'uncovered'), 'bar.ts is reported uncovered, not covered-by-the-decoy');
  void byVerdict;
});
// SABOTAGE: compare touched paths against file_keys entries with a glob-match function instead
// of strict string equality (e.g. `minimatch(touchedPath, fileKeyEntry)`).
// EXPECTED RED: `assert.equal(r.uncovered_count, 1, ...)` fails (becomes 0) because bar.ts now
// matches the decoy attestation's 'src/*.ts' file_keys entry.

// ── T5: declared globs select which touched paths are even compared ────────

test('T5: touched paths not matching ANY declared glob are excluded from every report', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [attestationRow({ verdict: 'approved', fileKeys: ['docs/readme.md'] })]);

  const result = await callInspect({
    projectRoot,
    touchedPaths: ['src/a.ts', 'docs/readme.md'],
    declaredGlobs: ['docs/**'],
  });

  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].touched_count, 1, 'only docs/readme.md matches the sole declared glob; src/a.ts is excluded entirely');
  assert.equal(result.reports[0].comparable_count, 1);
});
// SABOTAGE: build reports over ALL touchedPaths regardless of glob membership (ignore
// declaredGlobs entirely when populating touched_count).
// EXPECTED RED: `assert.equal(result.reports[0].touched_count, 1, ...)` fails (becomes 2).

// ── T6: duplicate declared glob strings each get an independent report ─────

test('T6: identical duplicate glob strings produce TWO independent reports (module does not de-dup)', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [attestationRow({ verdict: 'approved', fileKeys: ['src/a.ts'] })]);

  const result = await callInspect({
    projectRoot,
    touchedPaths: ['src/a.ts'],
    declaredGlobs: ['src/*.ts', 'src/*.ts'],
  });

  assert.equal(result.reports.length, 2, 'duplicate glob strings are reported per-declaration, as-is — de-duplication is config validation\'s job, out of this module\'s scope');
  assert.equal(result.reports[0].glob, 'src/*.ts');
  assert.equal(result.reports[1].glob, 'src/*.ts');
  assert.deepEqual(result.reports[0], result.reports[1], 'both reports over the identical declaration are identical in content');
});
// SABOTAGE: dedupe declaredGlobs via `[...new Set(declaredGlobs)]` before building reports.
// EXPECTED RED: `assert.equal(result.reports.length, 2, ...)` fails (becomes 1).

// ── T7: rejected/needs_rework count as COVERED, never uncovered ────────────

test('T7: rejected and needs_rework verdicts are covered-with-verdict-shown, never uncovered', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [
    attestationRow({ verdict: 'rejected', fileKeys: ['src/r.ts'] }),
    attestationRow({ verdict: 'needs_rework', fileKeys: ['src/n.ts'] }),
    attestationRow({ verdict: 'approved', fileKeys: ['src/a.ts'] }), // CONTROL: proves the mechanism detects coverage at all
  ]);

  const result = await callInspect({
    projectRoot,
    touchedPaths: ['src/r.ts', 'src/n.ts', 'src/a.ts'],
    declaredGlobs: ['src/*.ts'],
  });
  const r = result.reports[0];

  assert.equal(r.comparable_count, 3, 'all three paths have a live covering record');
  assert.deepEqual(r.verdicts, { approved: 1, rejected: 1, needs_rework: 1 });
  assert.equal(r.uncovered_count, 0, 'rejected/needs_rework must never land in uncovered_count');
});
// SABOTAGE: only count verdict==='approved' toward comparable_count/covered
// (`if (verdict !== 'approved') continue;` when tallying).
// EXPECTED RED: `assert.equal(r.comparable_count, 3, ...)` fails (becomes 1), and
// `assert.equal(r.uncovered_count, 0, ...)` fails (becomes 2).

// ── T8: superseded/non-live attestations never count ───────────────────────

test('T8: a retired (non-live) attestation provides no coverage; a live one on a different path does (control)', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [
    attestationRow({ verdict: 'approved', fileKeys: ['src/live.ts'], lifecycle: 'live' }),     // control: DOES cover
    attestationRow({ verdict: 'approved', fileKeys: ['src/retired.ts'], lifecycle: 'retired' }), // must NOT cover
  ]);

  const result = await callInspect({
    projectRoot,
    touchedPaths: ['src/live.ts', 'src/retired.ts'],
    declaredGlobs: ['src/*.ts'],
  });
  const r = result.reports[0];

  assert.equal(r.comparable_count, 1, 'only the live attestation counts as coverage');
  assert.equal(r.uncovered_count, 1, 'the path covered only by a retired attestation is reported uncovered');
  assert.ok(r.examples.some((e) => e.path === 'src/retired.ts' && e.verdict === 'uncovered'));
});
// SABOTAGE: drop the `lifecycle = 'live'` predicate from the query/filter (select all
// type='attestation' rows regardless of lifecycle).
// EXPECTED RED: `assert.equal(r.comparable_count, 1, ...)` fails (becomes 2), and
// `assert.equal(r.uncovered_count, 1, ...)` fails (becomes 0).

// ── T9: pathless attestations never cover; counted separately ──────────────

test('T9: a pathless attestation (no file_keys) covers nothing, and is counted separately', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [
    attestationRow({ verdict: 'approved', fileKeys: [] }),                 // pathless
    attestationRow({ verdict: 'approved', fileKeys: ['src/covered.ts'] }), // control: DOES cover
  ]);

  const result = await callInspect({
    projectRoot,
    touchedPaths: ['src/covered.ts', 'src/uncovered.ts'],
    declaredGlobs: ['src/*.ts'],
  });
  const r = result.reports[0];

  assert.equal(r.comparable_count, 1, 'only the file_keys-bearing attestation counts as coverage');
  assert.equal(r.uncovered_count, 1);
  assert.equal(result.pathless_attestation_count, 1, 'the pathless attestation is disclosed in its own store-health field, not folded into coverage');
});
// SABOTAGE: treat an attestation with empty file_keys as covering every touched path (a
// vacuous-match bug) instead of excluding it from coverage entirely.
// EXPECTED RED: `assert.equal(r.uncovered_count, 1, ...)` fails (becomes 0).

// ── T10: freshest inspected_at wins the verdict ─────────────────────────────

test('T10: two live covering attestations on one path — the FRESHEST inspected_at wins the verdict', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [
    attestationRow({ id: randomUUID(), verdict: 'needs_rework', inspectedAt: '2026-08-10', fileKeys: ['src/p.ts'] }), // older
    attestationRow({ id: randomUUID(), verdict: 'approved', inspectedAt: '2026-08-30', fileKeys: ['src/p.ts'] }),     // fresher
  ]);

  const result = await callInspect({ projectRoot, touchedPaths: ['src/p.ts'], declaredGlobs: ['src/*.ts'] });
  const r = result.reports[0];

  assert.equal(r.comparable_count, 1, 'one path, one counted verdict — the two records do not double-count');
  assert.deepEqual(r.verdicts, { approved: 1, rejected: 0, needs_rework: 0 }, 'the FRESHER record (2026-08-30, approved) wins over the older needs_rework');
});
// SABOTAGE: sort covering records by inspected_at ASCENDING and take the first (oldest) instead
// of the freshest.
// EXPECTED RED: `assert.deepEqual(r.verdicts, ...)` fails — needs_rework:1/approved:0 instead.

// ── T11: equal inspected_at ties break deterministically by id ─────────────

test('T11: equal inspected_at on the same path ties break by id — GREATEST id wins (authored convention)', async () => {
  const projectRoot = tempProjectRoot();
  const idLow = 'aaaaaaaa-0000-4000-8000-000000000001';
  const idHigh = 'bbbbbbbb-0000-4000-8000-000000000002';
  buildDb(projectRoot, [
    attestationRow({ id: idLow, verdict: 'needs_rework', inspectedAt: '2026-08-20', fileKeys: ['src/p.ts'] }),
    attestationRow({ id: idHigh, verdict: 'approved', inspectedAt: '2026-08-20', fileKeys: ['src/p.ts'] }),
  ]);

  const result = await callInspect({ projectRoot, touchedPaths: ['src/p.ts'], declaredGlobs: ['src/*.ts'] });
  const r = result.reports[0];

  assert.deepEqual(r.verdicts, { approved: 1, rejected: 0, needs_rework: 0 }, `idHigh (${idHigh}) > idLow (${idLow}) lexicographically — the greater id must win the tie`);
});
// SABOTAGE: on an inspected_at tie, keep whichever row the SQL query happened to return first
// (undefined/insertion-order tiebreak) instead of comparing ids.
// EXPECTED RED: flaky-or-wrong — `assert.deepEqual(r.verdicts, ...)` fails whenever insertion
// order does not happen to match the id-descending order (deterministically wrong once the
// fixture's insert order is set to match idLow-then-idHigh, i.e. NOT id-descending).

// ── T12: non-attestation records are never treated as coverage ─────────────

test('T12: a non-attestation (decision) record with matching file_keys provides no coverage', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [decisionRow({ fileKeys: ['src/p.ts'] })]);

  const result = await callInspect({ projectRoot, touchedPaths: ['src/p.ts'], declaredGlobs: ['src/*.ts'] });
  const r = result.reports[0];

  assert.equal(r.comparable_count, 0, 'a decision record must never satisfy attestation coverage');
  assert.equal(r.uncovered_count, 1);
});
// SABOTAGE: drop the `type = 'attestation'` predicate from the query (select any
// lifecycle='live' row and read file_keys off it).
// EXPECTED RED: `assert.equal(r.comparable_count, 0, ...)` fails (becomes 1).

// ── T13/T14: dormant / empty adversarial cases ──────────────────────────────

test('T13: empty declaredGlobs -> dormant: reports:[], but still available:true', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [attestationRow({ verdict: 'approved', fileKeys: ['src/a.ts'] })]);

  const result = await callInspect({ projectRoot, touchedPaths: ['src/a.ts'], declaredGlobs: [] });

  assert.equal(result.available, true, 'a readable store with zero declared globs is still available, just dormant');
  assert.deepEqual(result.reports, [], 'zero declared globs means zero reports');
});
// SABOTAGE: return `available: false` (or a single placeholder report) when declaredGlobs is empty.
// EXPECTED RED: `assert.equal(result.available, true, ...)` fails, or
// `assert.deepEqual(result.reports, [], ...)` fails (non-empty array).

test('T14: empty touchedPaths -> reports:[], regardless of declaredGlobs', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [attestationRow({ verdict: 'approved', fileKeys: ['src/a.ts'] })]);

  const result = await callInspect({ projectRoot, touchedPaths: [], declaredGlobs: ['src/*.ts', 'docs/**'] });

  assert.equal(result.available, true);
  assert.deepEqual(result.reports, [], 'no touched paths means no reports, even with declared globs present');
});
// SABOTAGE: still emit one report per declared glob with touched_count:0 when touchedPaths is empty.
// EXPECTED RED: `assert.deepEqual(result.reports, [], ...)` fails (length 2 instead of 0).

// ── T15: capped examples, priority order, omitted_count ─────────────────────

test('T15: examples are capped at 5, prioritized rejected > needs_rework > uncovered > approved', async () => {
  const projectRoot = tempProjectRoot();
  const rows = [
    attestationRow({ verdict: 'rejected', fileKeys: ['src/r1.ts'] }),
    attestationRow({ verdict: 'rejected', fileKeys: ['src/r2.ts'] }),
    attestationRow({ verdict: 'needs_rework', fileKeys: ['src/n1.ts'] }),
    attestationRow({ verdict: 'needs_rework', fileKeys: ['src/n2.ts'] }),
    attestationRow({ verdict: 'approved', fileKeys: ['src/a1.ts'] }),
    attestationRow({ verdict: 'approved', fileKeys: ['src/a2.ts'] }),
  ];
  buildDb(projectRoot, rows);
  // uAA/uBB/uCC touched but never covered by any attestation -> uncovered.
  const touchedPaths = ['src/r1.ts', 'src/r2.ts', 'src/n1.ts', 'src/n2.ts', 'src/a1.ts', 'src/a2.ts', 'src/uAA.ts', 'src/uBB.ts', 'src/uCC.ts'];

  const result = await callInspect({ projectRoot, touchedPaths, declaredGlobs: ['src/*.ts'] });
  const r = result.reports[0];

  assert.equal(r.touched_count, 9);
  assert.equal(r.examples.length, 5, 'cap is 5');
  assert.equal(r.omitted_count, 4, 'touched_count(9) - examples.length(5) = 4');
  assert.deepEqual(r.examples.slice(0, 2).map((e) => e.verdict).sort(), ['rejected', 'rejected'], 'the two rejected examples fill the first two slots');
  assert.deepEqual(r.examples.slice(2, 4).map((e) => e.verdict).sort(), ['needs_rework', 'needs_rework'], 'the two needs_rework examples fill the next two slots');
  assert.equal(r.examples[4].verdict, 'uncovered', 'the 5th (last) slot goes to an uncovered example — uncovered outranks approved, and no approved example fits within the cap');
  assert.ok(!r.examples.some((e) => e.verdict === 'approved'), 'approved examples are entirely squeezed out by the cap given higher-priority categories');
});
// SABOTAGE: build examples with priority order reversed (approved > uncovered > needs_rework > rejected).
// EXPECTED RED: `assert.deepEqual(r.examples.slice(0, 2)..., ['rejected','rejected'], ...)` fails
// (first two slots would be 'approved' instead).

// ── T16: glob semantics — ** crosses directories, single * does not ────────

test('T16: ** matches across path segments; a single * stays within one segment', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [
    attestationRow({ id: randomUUID(), verdict: 'approved', fileKeys: ['src/a.ts'] }),
    attestationRow({ id: randomUUID(), verdict: 'approved', fileKeys: ['src/deep/nested/b.ts'] }),
  ]);
  const touchedPaths = ['src/a.ts', 'src/deep/nested/b.ts', 'other/c.ts'];

  const result = await callInspect({
    projectRoot,
    touchedPaths,
    declaredGlobs: ['src/**/*.ts', 'src/*.ts'],
  });

  const doubleStar = result.reports.find((r) => r.glob === 'src/**/*.ts');
  const singleStar = result.reports.find((r) => r.glob === 'src/*.ts');

  assert.equal(doubleStar.touched_count, 2, '`src/**/*.ts` matches both src/a.ts and the nested src/deep/nested/b.ts, never other/c.ts');
  assert.equal(singleStar.touched_count, 1, '`src/*.ts` matches only src/a.ts — it must NOT cross the directory boundary into src/deep/nested/b.ts');
});
// SABOTAGE: implement a single '*' with a regex fragment that also matches '/' (e.g. `.*`
// instead of `[^/]*`).
// EXPECTED RED: `assert.equal(singleStar.touched_count, 1, ...)` fails (becomes 2).

// ── T17'/T18': read-only IN PLACE, manage nothing (decision 1f069af4 v2; the
// snapshot-copy design was REVERSED 2026-09-01, Codex thread 01a05c7b; pins
// renegotiated by the conductor via test-repair — the old T18 asserted the
// copy-era no-litter property, which the reversal deliberately abandons).
// THE CONTRACT IS NOT "NO SIDECARS". SQLite may materialize its own -wal/-shm to
// serve a read; those are SQLite's. DELETING them was the original defect — a
// TOCTOU that can unlink another connection's LIVE WAL and lose committed rows —
// and AVOIDING them (copy, or immutable=1) costs correctness: both silently miss
// WAL-resident rows, which is what T20 below pins. What is pinned here is that
// the module writes nothing, deletes nothing, and adds no file of its own.

test("T17': inspection never mutates the main db file bytes", async () => {
  const projectRoot = tempProjectRoot();
  const dbPath = buildDb(projectRoot, [attestationRow({ verdict: 'approved', fileKeys: ['src/a.ts'] })]);
  const before_ = fileHash(dbPath);

  const result = await callInspect({ projectRoot, touchedPaths: ['src/a.ts'], declaredGlobs: ['src/*.ts'] });
  assert.equal(result.available, true);
  assert.equal(result.reports[0].comparable_count, 1, 'sanity: it genuinely read the store, so the hash below is not vacuous');

  assert.equal(fileHash(dbPath), before_, 'the main db file must be byte-identical — a WRITABLE handle would checkpoint the WAL into it on close, which is a write by a feature whose whole contract is "changes nothing"');
});
// SABOTAGE: open with `new DatabaseSync(dbPath)` (no `{ readOnly: true }`).
// EXPECTED RED: the writable close checkpoints pending WAL frames into the main
// file, changing its bytes.

test("T18': inspection performs NO application-level sidecar management, and leaves journal mode untouched", async () => {
  const projectRoot = tempProjectRoot();
  const dbPath = buildDb(projectRoot, [attestationRow({ verdict: 'approved', fileKeys: ['src/a.ts'] })]);
  const dir = dirname(dbPath);
  const readMode = () => {
    const d = new DatabaseSync(dbPath, { readOnly: true });
    const m = d.prepare('PRAGMA journal_mode').get().journal_mode;
    d.close();
    return m;
  };
  const modeBefore = readMode();

  const result = await callInspect({ projectRoot, touchedPaths: ['src/a.ts'], declaredGlobs: ['src/*.ts'] });
  assert.equal(result.available, true);

  // SQLite-managed -wal/-shm are ALLOWED to appear (creating one is harmless;
  // deleting one is the defect). Nothing ELSE may: no temp copy, no backup, no
  // stray file of this module's own making.
  const ALLOWED = new Set(['sterling.db', 'sterling.db-wal', 'sterling.db-shm']);
  assert.deepEqual(readdirSync(dir).filter((f) => !ALLOWED.has(f)), [], `the inspector creates no file of its own in the store directory: ${JSON.stringify(readdirSync(dir).sort())}`);
  assert.ok(existsSync(dbPath), 'the database itself is still there');
  assert.equal(readMode(), modeBefore, 'journal mode is untouched — the inspector issues no journal-mode pragma');
});
// SABOTAGE: reinstate the copy protocol (copy main+-wal into a temp dir, or write
// any scratch file beside the store).
// EXPECTED RED: the ALLOWED filter catches the stray file — and T20 below goes red
// too, which is the point: the copy is not an atomic snapshot.

test('T20 [WAL-RESIDENT]: an attestation committed but NOT checkpointed is FOUND', async () => {
  const projectRoot = tempProjectRoot();
  const dbPath = dbPathFor(projectRoot);
  const writer = new DatabaseSync(dbPath);
  writer.exec(RECORDS_V2_DDL);
  writer.exec('PRAGMA journal_mode = WAL');
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // Written AFTER the last checkpoint and never checkpointed: this row lives in
  // the -wal only. The writer handle stays OPEN so a close cannot checkpoint it.
  const r = attestationRow({ verdict: 'approved', fileKeys: ['src/wal.ts'] });
  writer.prepare(
    `INSERT INTO records (id, type, status, superseded_by, lifecycle, freshness, version, scope, created_at, updated_at, author, derived_unconfirmed, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.id, r.type, r.status, null, r.lifecycle, r.freshness, r.version, r.scope, r.created_at, r.updated_at, r.author, 0, r.rawBody);
  try {
    assert.ok(existsSync(`${dbPath}-wal`), 'precondition: the row really is WAL-resident');

    const result = await callInspect({ projectRoot, touchedPaths: ['src/wal.ts'], declaredGlobs: ['src/*.ts'] });
    assert.equal(result.available, true);
    assert.equal(result.reports[0].comparable_count, 1,
      'a committed-but-uncheckpointed attestation MUST be found: reporting "no comparable human record" for a record that exists is a false negative dressed as a fact — exactly what a raw main+wal copy (torn by a concurrent checkpoint) and immutable=1 (ignores the WAL) both produce');
    assert.equal(result.reports[0].uncovered_count, 0);
  } finally {
    writer.close();
  }
});
// SABOTAGE (VERIFIED 2026-09-01 by the coder, confirmed in code before reading the result):
// open `file:${dbPath}?immutable=1` instead of the plain path.
// EXPECTED RED — and exactly what happened: comparable_count 0 !== 1.

// ── T19: no freshness/staleness predicate anywhere in the result ───────────

test('T19: available:true result never carries a computed freshness/staleness field', async () => {
  const projectRoot = tempProjectRoot();
  buildDb(projectRoot, [
    attestationRow({ verdict: 'approved', inspectedAt: '2026-08-01', fileKeys: ['src/a.ts'] }),
    attestationRow({ verdict: 'rejected', inspectedAt: '2020-01-01', fileKeys: ['src/old.ts'] }), // deliberately ancient
  ]);

  const result = await callInspect({
    projectRoot,
    touchedPaths: ['src/a.ts', 'src/old.ts'],
    declaredGlobs: ['src/*.ts'],
  });

  assert.equal(result.available, true);
  assert.ok(result.reports.length > 0 && result.reports[0].comparable_count > 0, 'sanity: the result is genuinely populated, not an empty stub the freshness check would pass vacuously');
  assertNoFreshnessPredicate(result);
});
// SABOTAGE: add a computed convenience field, e.g. `report.is_fresh = (Date.now() - Date.parse(newestInspectedAt)) < THRESHOLD`,
// to any report or the top-level result (a plausible-looking staleness heuristic the decision
// explicitly forbids: "currency ... is UNPROVABLE ... no freshness predicate is computable and none is claimed").
// EXPECTED RED: `assertNoFreshnessPredicate(result)` throws on the newly-added forbidden key.
