// ---------------------------------------------------------------------------
// PIN GROUP S4 — migration RUNNER (stable-identity wave S4, decision
// stable-identity-design-v2 / 2176748e, board 60fa6960). SPEC-ONLY:
// scripts/migrate-stores.mjs DOES NOT EXIST YET (that exact name/path is
// ADOPTED here, per the dispatch brief's instruction, and the coder should
// document the same assumption in the script's own header). Every test below
// spawns it as a child process — until the file exists, node itself refuses
// to run it (a MODULE_NOT_FOUND-shaped failure printed to stderr, non-zero
// exit, empty stdout) — so every assertion on `code`/`stdout` below fails on
// its OWN AssertionError (an exit-code mismatch, or a JSON.parse on an empty
// string), never a bare test-runner crash, because every test wraps the
// child-process call and asserts on its own result rather than throwing
// through an unguarded require/import. This mirrors migration-preflight.
// test.mjs's own convention exactly (same wave, same pattern).
//
// CLI + JSON CONTRACT AUTHORED HERE (no interface slice fixes the invocation
// shape or field names for a brand-new script — per the test-writer mandate
// this file is the oracle for that shape, and the coder implements against
// it, exactly as migration-preflight.test.mjs already did for its sibling
// script):
//
//   node scripts/migrate-stores.mjs --db <path-to-sterling.db>
//
//   stdout (on a FRESH, successful migration) is a single JSON object:
//     {
//       ok: true,
//       already_migrated: false,
//       db: <path>,
//       backup_path: <path to a VACUUM INTO backup, created BEFORE mutation>,
//       manifest_path: <path to a journal/manifest JSON file>,
//       schema_version_before: 1,
//       schema_version_after: 2,
//     }
//     exit code 0.
//
//   stdout (on a store ALREADY at/past the migrated version — idempotent
//   no-op) is:
//     { ok: true, already_migrated: true, db: <path>, schema_version: 2 }
//     exit code 0. A second run is byte-identical in effect (no litter, no
//     mutation) — the store's own read-only preflight report already pins
//     this exact marker name (already_migrated) for the sibling script
//     (migration-preflight.test.mjs B3), so this runner reuses the SAME
//     vocabulary rather than inventing a second one.
//
//   stdout (on a REFUSED run — verification failed after an attempted
//   migration) is:
//     { ok: false, reason: <string mentioning "verif...">, detail: <string>,
//       backup_path: <path — the run's backup, taken before the attempt>,
//       manifest_path: <path — records the failure and why> }
//     exit code non-zero. user_version is left UNCHANGED (never bumped).
//
//   a REFUSAL that happens BEFORE any work starts (missing db path, a
//   too-new/unsupported schema version) is not required to emit the JSON
//   shape above — these are pinned more loosely, via a text match against
//   the COMBINED stdout+stderr, mirroring migration-preflight.test.mjs's own
//   B4 convention, since no report can meaningfully be built before the
//   store can even be opened.
//
// LEGACY (PRE-v2) PHYSICAL FIXTURE — AUTHORED HERE, FLAGGED AS AN ASSUMPTION:
// no live code in this repository can produce a genuinely pre-v2-shaped
// database file any more. Evidence: schema-version-guard.test.ts's own A1
// pin shows every freshly-constructed SterlingStore is immediately stamped
// user_version=2, and its A2 pin *simulates* "a pre-v2 (S1-era) store" by
// building a REAL, fully-v2-shaped store and then rolling the pragma marker
// backward on an "otherwise real [v2] schema" — it does not, and (per A1)
// cannot, construct a database with the actual pre-v2 table layout, because
// the live SterlingStore constructor now unconditionally bootstraps the v2
// tables. store.test.ts independently confirms the OLD table name for what
// is now record_relations was record_links ("record_links replaced by
// record_relations in schema v2"). Given no interface slice and no reachable
// live code fixes the genuine legacy DDL, this file DEFINES the minimal
// legacy contract the runner must accept — the same move migration-preflight
// .test.mjs made for its CLI/JSON shape, applied here to the migration
// INPUT shape instead of the report OUTPUT shape:
//
//   CREATE TABLE records (
//     id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
//     superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
//     body TEXT NOT NULL   -- full legacy JSON envelope: id/type/status/
//                          -- superseded_by/created_at/updated_at/author/
//                          -- scope/stack_tags/links:[] plus type-specific
//                          -- fields (title/statement/alternatives_rejected/
//                          -- rationale/file_keys for a decision) — the SAME
//                          -- shape store.create()'s own decision()/envelope()
//                          -- fixtures already use elsewhere in this suite
//                          -- family (stable-identity-write-path.test.ts),
//                          -- confirmed still accepted by today's create().
//   );
//   CREATE TABLE record_links (
//     source_id TEXT NOT NULL, rel TEXT NOT NULL, target_id TEXT NOT NULL,
//     created_at TEXT
//   );   -- old name/shape for what record_relations replaced; edge
//        -- direction (source = the NEW/successor record, target = the OLD
//        -- one) matches record_relations' own proven direction
//        -- (stable-identity-write-path.test.ts S2-6b).
//   PRAGMA user_version = 1;
//
// If the runner's actual legacy-detection differs from this shape (a
// different table name, different columns), the fixture-building helpers
// below throw in isolation (a SQLite "no such table"/column-mismatch error)
// rather than silently mis-testing unrelated behavior — the same isolation
// guarantee stable-identity-hardening.test.ts's S2b-8 already relies on for
// its own hand-inserted record_aliases row. THIS IS A NAMED RISK, not a
// certainty: if this authored legacy shape diverges from what real,
// pre-existing project .sterling/sterling.db files actually look like on
// disk, a runner built to pass these pins will not migrate a real store even
// though it passes every test here — flagged explicitly in the handoff.
//
// legacy_resolution — the field name pinned on an alias-resolved read is
// taken VERBATIM from the settled design's own prose (decision
// stable-identity-design-v2): "reads through an alias return the archived
// snapshot + a legacy_resolution block" — quoted, not invented.
//
// NAMED GAPS — NOT PINNED (the design does not fix these; naming rather than
// inventing, per the dispatch brief):
//   - exact journal/manifest FILE NAME or on-disk location convention beyond
//     "a real file exists at the path the tool itself names in its own JSON
//     output" — no format/schema for that file is pinned beyond the fields
//     explicitly required by contract point 5 (counts, backup path, schema
//     versions before/after).
//   - CLI flags beyond --db (e.g. --force, --dry-run, --yes) — none pinned.
//   - multi-store enumeration (ProjectRegistry + domain stores fan-out) —
//     process-environment-dependent, cannot be constructed inside a single
//     temp-dir fixture; UNPINNABLE HERE, not faked. This file pins
//     single-store --db behavior only.
//   - active-run / live-server PID refusal — depends on real OS processes
//     and .sterling/ run-lock state outside a fixture db file;
//     UNPINNABLE HERE, not faked.
//   - the exact backup FILE NAME convention — only its existence, its path
//     (as named by the tool), and its CONTENT (a faithful pre-migration
//     snapshot) are pinned, never a specific filename pattern.
//   - whether verify-before-bump is implemented as one SQL transaction with
//     an automatic rollback, or as a mutate-then-restore-from-backup
//     sequence — only the observable END STATE is pinned (user_version
//     unchanged, source restorable via the named backup), never the
//     mechanism.
// ---------------------------------------------------------------------------
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'migrate-stores.mjs');
const PREFLIGHT_SCRIPT = join(root, 'scripts', 'migration-preflight.mjs');
const NOW = '2026-08-22T12:00:00.000Z';

let SterlingStore;
let DatabaseSync;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ DatabaseSync } = await import('node:sqlite'));
});

function tempDbPath(prefix = 'migration-runner-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: join(dir, 'sterling.db') };
}

function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runMigrate(args) {
  return run(SCRIPT, args);
}

function runPreflight(args) {
  return run(PREFLIGHT_SCRIPT, args);
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function dirSnapshot(dir) {
  return readdirSync(dir).sort();
}

function rawUserVersion(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA user_version').get();
    return row ? row.user_version : NaN;
  } finally {
    db.close();
  }
}

function rawSetUserVersion(path, value) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version = ${value}`);
  } finally {
    db.close();
  }
}

function parseJson(text, label) {
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(text);
  }, `${label} must be a single parseable JSON object: ${text}`);
  return parsed;
}

// --- legacy (pre-v2) fixture builder — AUTHORED, see file header ----------

function legacyEnvelopeBody(over = {}) {
  return {
    type: 'decision',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    title: 'a decision',
    statement: 'the statement',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no joins' }],
    rationale: 'r',
    file_keys: [],
    ...over,
  };
}

// test-repair 2026-08-22: fixture DDL replaced with the REAL v1 schema, taken
// verbatim from git show 6f443e8:packages/store/src/index.ts (the S1 commit —
// the exact DDL every real pre-v2 store on this machine was built with). The
// authored approximation was missing scope/author/derived_unconfirmed on
// records, invented a created_at column on record_links (the real table is
// PK-only), lacked records_fts + the tag/file-key index tables, and never
// stamped user_version=1 — a runner built to pass the approximation would not
// migrate a real store. [stable-identity-design-v2]
function createLegacyDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      superseded_by TEXT,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      author TEXT NOT NULL,
      derived_unconfirmed INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_records_type_status ON records(type, status);
    CREATE TABLE IF NOT EXISTS record_stack_tags (
      record_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (record_id, tag)
    );
    CREATE TABLE IF NOT EXISTS record_file_keys (
      record_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (record_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_file_keys_path ON record_file_keys(path);
    CREATE TABLE IF NOT EXISTS record_links (
      source_id TEXT NOT NULL,
      rel TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (source_id, rel, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_links_target ON record_links(target_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(record_id UNINDEXED, text);
  `);
  // Real S1-era stores are stamped 1 (schema-version-guard A1/A2 of that era);
  // pre-marker stores are 0 — the runner must accept both, the fixture uses 1.
  db.exec('PRAGMA user_version = 1');
  return db;
}

// test-repair 2026-08-22: INSERTs aligned with the real v1 columns (scope,
// author, derived_unconfirmed added; record_links created_at removed) and the
// FTS row every real create() wrote is populated. [stable-identity-design-v2]
function insertLegacyRecord(db, id, status, supersededBy, over = {}) {
  const body = legacyEnvelopeBody({ id, status, superseded_by: supersededBy, ...over });
  db.prepare(
    'INSERT INTO records (id, type, status, superseded_by, scope, created_at, updated_at, author, derived_unconfirmed, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, body.type, status, supersededBy, body.scope, body.created_at, body.updated_at, body.author, 0, JSON.stringify(body));
  db.prepare('INSERT INTO records_fts (record_id, text) VALUES (?, ?)').run(
    id,
    [body.title, body.statement, body.rationale].filter(Boolean).join(' ')
  );
}

function insertLegacyLink(db, sourceId, rel, targetId) {
  db.prepare('INSERT INTO record_links (source_id, rel, target_id) VALUES (?, ?, ?)').run(sourceId, rel, targetId);
}

/** Builds the exact legacy A->B->C fixture the dispatch brief describes: a
 *  3-node supersede chain, terminus C live, using the OLD status/
 *  superseded_by columns + record_links reciprocal edges (source=new,
 *  target=old), PRAGMA user_version=1. */
function buildLegacyChainFixture(path) {
  const idA = randomUUID();
  const idB = randomUUID();
  const idC = randomUUID();
  const db = createLegacyDb(path);
  try {
    insertLegacyRecord(db, idA, 'superseded', idB, { title: 'Decision A', statement: 'A original statement zzzlegacymarkerA' });
    insertLegacyRecord(db, idB, 'superseded', idC, { title: 'Decision B', statement: 'B original statement zzzlegacymarkerB' });
    insertLegacyRecord(db, idC, 'active', null, { title: 'Decision C', statement: 'C original statement zzzlegacymarkerC' });
    insertLegacyLink(db, idB, 'supersedes', idA);
    insertLegacyLink(db, idC, 'supersedes', idB);
    db.exec('PRAGMA user_version = 1');
  } finally {
    db.close();
  }
  return { idA, idB, idC };
}

/** A dangling superseded_by: X claims to be superseded by an id with no
 *  corresponding record and no record_links edge at all — a broken pointer
 *  the design's verify step ("every relation target resolves") must catch. */
// test-repair 2026-08-22: the column-only missing-successor shape is now,
// deliberately, the PROMOTION tombstone (pin S4-M4; 41 live knowledge_promote
// tombstones on the repo store name their domain-store successor) — the shape
// that still REFUSES is a chain claim via record_links whose claimed record is
// missing: identity genuinely at stake, nowhere disclosed to have gone. The
// fixture carries BOTH the column pointer and the link edge so the claim is
// link-surfaced and cannot classify as a promotion. [stable-identity-design-v2]
function buildDanglingFixture(path) {
  const idX = randomUUID();
  const idY = randomUUID();
  const missingId = randomUUID();
  const db = createLegacyDb(path);
  try {
    insertLegacyRecord(db, idX, 'superseded', missingId, { title: 'X', statement: 'x dangling zzzdanglingmarker' });
    insertLegacyLink(db, missingId, 'supersedes', idX); // link-claimed successor that does not exist
    insertLegacyRecord(db, idY, 'active', null, { title: 'Y', statement: 'y healthy' });
    db.exec('PRAGMA user_version = 1');
  } finally {
    db.close();
  }
  return { idX, idY, missingId };
}

/** A multi-successor conflict: TWO distinct records (Q1, Q2) both carry a
 *  record_links supersedes edge targeting the SAME record P — the design's
 *  verify step ("no multi-successor") must catch this. */
// test-repair 2026-08-22: the original fixture (column names Q1, Q2 link-only)
// is now mechanically RESOLVABLE — v1 served only the superseded_by column, so
// a link-only extra claim never served and is dropped, disclosed (live
// adjudication: decision a127e6e1, claimed by its rewrite AND an amendment
// mis-encoded as supersession). The refusal this pin guards remains for the
// shape with NO column corroboration: two link-only claimants and a NULL
// column — no serving surface ever picked a winner, so the runner must not
// invent one. [stable-identity-design-v2]
function buildMultiSuccessorFixture(path) {
  const idP = randomUUID();
  const idQ1 = randomUUID();
  const idQ2 = randomUUID();
  const db = createLegacyDb(path);
  try {
    insertLegacyRecord(db, idP, 'superseded', null, { title: 'P', statement: 'p zzzmultimarker' });
    insertLegacyRecord(db, idQ1, 'active', null, { title: 'Q1', statement: 'q1' });
    insertLegacyRecord(db, idQ2, 'active', null, { title: 'Q2', statement: 'q2' });
    insertLegacyLink(db, idQ1, 'supersedes', idP);
    insertLegacyLink(db, idQ2, 'supersedes', idP); // conflicting second successor — neither column-corroborated
    db.exec('PRAGMA user_version = 1');
  } finally {
    db.close();
  }
  return { idP, idQ1, idQ2 };
}

function rawRecordRow(path, id) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

// ===========================================================================
// CONTRACT 1 — REFUSALS BEFORE WORK
// ===========================================================================

test('S4-R1: a missing/unreadable db path fails loudly, naming the path, exits non-zero, and creates no litter', () => {
  const { dir } = tempDbPath();
  const missing = join(dir, 'does-not-exist.db');
  assert.equal(existsSync(missing), false, 'precondition: the path genuinely does not exist');
  const before_ = dirSnapshot(dir);

  const { code, stdout, stderr } = runMigrate(['--db', missing]);
  assert.notEqual(code, 0, 'a missing db path is a hard failure, never a clean exit');
  assert.match(
    stdout + stderr,
    new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the failure names the exact path that could not be read'
  );
  assert.deepEqual(dirSnapshot(dir), before_, 'no file (backup, manifest, or otherwise) is created for a path that never existed');
});

test('S4-R2: an already-migrated store reports already_migrated and exits 0; a second run is still a no-op — byte-identical, still says already_migrated', () => {
  const { dir, path } = tempDbPath();
  try {
    const seed = new SterlingStore(path);
    seed.close();
    assert.equal(rawUserVersion(path), 2, 'precondition: a freshly created store is already stamped to the current schema version');

    const hashBefore = fileHash(path);
    const first = runMigrate(['--db', path]);
    assert.equal(first.code, 0, `an already-migrated store is a clean, non-error run: ${first.stderr}`);
    const firstReport = parseJson(first.stdout, 'first run stdout');
    assert.equal(firstReport.already_migrated, true, 'an at/past-version store reports the already_migrated marker');
    assert.equal(fileHash(path), hashBefore, 'reporting already_migrated must not mutate the store');

    const second = runMigrate(['--db', path]);
    assert.equal(second.code, 0, 'a second run over the same already-migrated store is still a clean no-op');
    const secondReport = parseJson(second.stdout, 'second run stdout');
    assert.equal(secondReport.already_migrated, true, 'repeated runs keep reporting already_migrated — idempotent');
    assert.equal(fileHash(path), hashBefore, 'a second run changes nothing at all — same byte hash as before either run');
  } finally {
    // temp dirs are process-scoped, not shared across tests.
  }
});

test('S4-R3: a store whose schema version exceeds what this code supports refuses, naming found/supported versions and "downgrade" (reusing the store\'s own guard message), and leaves no backup litter', () => {
  const { dir, path } = tempDbPath();
  try {
    const seed = new SterlingStore(path);
    seed.close();
    rawSetUserVersion(path, 99);
    const hashBefore = fileHash(path);
    const dirBefore = dirSnapshot(dir);

    const { code, stdout, stderr } = runMigrate(['--db', path]);
    assert.notEqual(code, 0, 'a too-new schema version is a hard refusal, never a clean exit');
    const combined = stdout + stderr;
    assert.match(combined, /schema/i, 'names the concept "schema" (mirrors schema-version-guard.test.ts A4\'s frozen guard message)');
    assert.match(combined, /99/, 'names the FOUND version (99)');
    assert.match(combined, /2/, 'names the SUPPORTED version (2)');
    assert.match(combined, /downgrade/i, 'instructs against running an older build over a newer schema');

    assert.equal(fileHash(path), hashBefore, 'a too-new refusal never mutates the source db');
    assert.deepEqual(dirSnapshot(dir), dirBefore, 'a too-new refusal creates no backup/manifest litter');
  } finally {
    // temp dirs are process-scoped, not shared across tests.
  }
});

// ===========================================================================
// CONTRACT 2 — BACKUP FIRST
// ===========================================================================

test('S4-B1: a successful migration creates a VACUUM INTO backup BEFORE any mutation — the backup is a faithful pre-migration (v1) snapshot', () => {
  const { path } = tempDbPath();
  const fx = buildLegacyChainFixture(path);
  const originalRowA = rawRecordRow(path, fx.idA);
  assert.ok(originalRowA, 'precondition: A exists pre-migration with its original body');

  const { code, stdout, stderr } = runMigrate(['--db', path]);
  assert.equal(code, 0, `a healthy legacy chain must migrate successfully: ${stderr}`);
  const report = parseJson(stdout, 'migrate stdout');
  assert.equal(typeof report.backup_path, 'string', 'the report names a backup_path');
  assert.ok(existsSync(report.backup_path), 'the named backup file actually exists on disk');

  assert.equal(rawUserVersion(report.backup_path), 1, 'the backup captures the PRE-migration schema version — proves it was taken before the bump');
  const backedUpRowA = rawRecordRow(report.backup_path, fx.idA);
  assert.ok(backedUpRowA, 'the backup contains the original (pre-migration) record A');
  assert.equal(backedUpRowA.status, 'superseded', 'the backup preserves the ORIGINAL legacy status column, untouched by the migration');
  assert.equal(JSON.parse(backedUpRowA.body).statement, JSON.parse(originalRowA.body).statement, 'the backup body is byte-for-byte the pre-migration content');
});

// ===========================================================================
// CONTRACT 3 — THE DATA MIGRATION (chain collapse, aliasing, relations,
// FTS) — one large multi-assertion pin, mirroring migration-preflight.test
// .mjs's own B1 convention for a single richly-fixtured contract.
// ===========================================================================

test('S4-M1: a legacy A->B->C chain migrates to a single terminus record C, with A/B aliased, archived, delinked, and FTS reflecting only the live set', () => {
  const { path } = tempDbPath();
  const fx = buildLegacyChainFixture(path);

  const { code, stderr } = runMigrate(['--db', path]);
  assert.equal(code, 0, `the healthy chain fixture must migrate successfully: ${stderr}`);
  assert.equal(rawUserVersion(path), 2, 'user_version is bumped to the current schema version on success');

  const store = new SterlingStore(path);
  try {
    // -- terminus keeps its id, holds the CURRENT content --
    const servedC = store.get(fx.idC);
    assert.ok(servedC, 'the terminus C still resolves directly by its own id');
    assert.equal(servedC.id, fx.idC, 'the terminus id never changes');
    assert.equal(servedC.statement, 'C original statement zzzlegacymarkerC', 'the terminus serves its own current content');
    assert.equal(servedC.version, 3, 'C is now version 3 — A (v1) and B (v2) folded into its history, C itself the third');

    // -- every record still resolves (A and B via the ALIAS INDEX) --
    // test-repair 2026-08-22: the original read was store.get(historical_id)
    // expecting legacy_resolution, but store.get() is deliberately NOT
    // alias-aware — alias resolution lives at the TOOL layer (S3; frozen pin
    // S3-6b: a live records row per historical id would make every dead id
    // writable). At store level the contract is: the alias index maps the
    // historical id, and the archived snapshot is readable at that version.
    // [stable-identity-design-v2]
    const aliasA = store.recordAliases().find((a) => a.historical_id === fx.idA);
    const aliasB = store.recordAliases().find((a) => a.historical_id === fx.idB);
    assert.ok(aliasA, 'A still resolves (via the alias index) rather than 404ing');
    assert.ok(aliasB, 'B still resolves (via the alias index) rather than 404ing');

    assert.equal(aliasA.canonical_id, fx.idC, 'A resolves to canonical id C');
    assert.equal(aliasA.archived_version, 1, 'A is archived as C\'s version 1 (oldest in the chain)');
    const snapA = store.getRecordVersion(fx.idC, 1);
    assert.equal(snapA?.statement, 'A original statement zzzlegacymarkerA', 'the archived snapshot serves the ARCHIVED (A\'s own) content, not C\'s current content');

    assert.equal(aliasB.canonical_id, fx.idC, 'B resolves to canonical id C');
    assert.equal(aliasB.archived_version, 2, 'B is archived as C\'s version 2 (middle of the chain)');
    const snapB = store.getRecordVersion(fx.idC, 2);
    assert.equal(snapB?.statement, 'B original statement zzzlegacymarkerB', 'the archived snapshot serves B\'s own archived content');

    // -- record_aliases maps A and B to (canonical C, their archived version) --
    const aliasRows = store.db
      .prepare('SELECT historical_id, canonical_id, archived_version FROM record_aliases WHERE historical_id IN (?, ?)')
      .all(fx.idA, fx.idB);
    assert.equal(aliasRows.length, 2, 'exactly two alias rows minted — one each for A and B');
    const byHistorical = Object.fromEntries(aliasRows.map((r) => [r.historical_id, r]));
    assert.equal(byHistorical[fx.idA].canonical_id, fx.idC);
    assert.equal(byHistorical[fx.idA].archived_version, 1);
    assert.equal(byHistorical[fx.idB].canonical_id, fx.idC);
    assert.equal(byHistorical[fx.idB].archived_version, 2);

    // -- the archived snapshots are readable via the version-history primitive --
    const v1 = store.getRecordVersion(fx.idC, 1);
    const v2 = store.getRecordVersion(fx.idC, 2);
    assert.ok(v1, 'version 1 of the terminus (A\'s content) is archived and resolvable');
    assert.equal(v1.statement, 'A original statement zzzlegacymarkerA');
    assert.ok(v2, 'version 2 of the terminus (B\'s content) is archived and resolvable');
    assert.equal(v2.statement, 'B original statement zzzlegacymarkerB');

    // -- intra-chain supersedes links are REMOVED from live records --
    const intraChainRelations = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM record_relations WHERE rel = 'supersedes' AND (source_id IN (?, ?, ?) OR target_id IN (?, ?, ?))`
      )
      .get(fx.idA, fx.idB, fx.idC, fx.idA, fx.idB, fx.idC);
    assert.equal(intraChainRelations.n, 0, 'no supersedes relation rows remain among A/B/C — the chain became version history, not a live relation');

    // -- record_relations carries no cycle and at most one successor anywhere --
    const allSupersedes = store.db.prepare(`SELECT source_id, target_id FROM record_relations WHERE rel = 'supersedes'`).all();
    const successorsByTarget = new Map();
    for (const { source_id, target_id } of allSupersedes) {
      const set = successorsByTarget.get(target_id) ?? new Set();
      set.add(source_id);
      successorsByTarget.set(target_id, set);
    }
    for (const [target, sources] of successorsByTarget) {
      assert.ok(sources.size <= 1, `target ${target} has at most one successor (found ${sources.size})`);
    }
    const adjacency = new Map();
    for (const { source_id, target_id } of allSupersedes) {
      const set = adjacency.get(source_id) ?? new Set();
      set.add(target_id);
      adjacency.set(source_id, set);
    }
    for (const start of adjacency.keys()) {
      const seen = new Set();
      const stack = [start];
      while (stack.length) {
        const node = stack.pop();
        if (node === start && seen.size > 0) assert.fail(`cycle detected reaching back to ${start}`);
        if (seen.has(node)) continue;
        seen.add(node);
        for (const next of adjacency.get(node) ?? []) stack.push(next);
      }
    }

    // -- records_fts serves exactly the live set --
    const liveDecisions = store.query({ cap: 1000 });
    assert.equal(liveDecisions.filter((r) => r.id === fx.idA || r.id === fx.idB).length, 0, 'A and B are not part of the live serving set');
    assert.equal(liveDecisions.filter((r) => r.id === fx.idC).length, 1, 'C is the sole live record for this chain');
    assert.equal(store.query({ rank_terms: ['zzzlegacymarkerA'] }).length, 0, 'A\'s text no longer ranks — it lives only in archived history');
    assert.equal(store.query({ rank_terms: ['zzzlegacymarkerB'] }).length, 0, 'B\'s text no longer ranks — it lives only in archived history');
    assert.equal(store.query({ rank_terms: ['zzzlegacymarkerC'] }).length, 1, 'C\'s current text ranks exactly once');
  } finally {
    store.close();
  }
});

// ===========================================================================
// CONTRACT 5 — JOURNAL
// ===========================================================================

test('S4-J1: a successful run writes a journal/manifest artifact naming the backup and recording per-store counts and before/after schema versions', () => {
  const { path } = tempDbPath();
  buildLegacyChainFixture(path);

  const { code, stdout, stderr } = runMigrate(['--db', path]);
  assert.equal(code, 0, `the healthy chain fixture must migrate successfully: ${stderr}`);
  const report = parseJson(stdout, 'migrate stdout');
  assert.equal(typeof report.manifest_path, 'string', 'the report names a manifest_path');
  assert.ok(existsSync(report.manifest_path), 'the named manifest/journal file actually exists on disk');

  const manifestText = readFileSync(report.manifest_path, 'utf8');
  const manifest = parseJson(manifestText, 'manifest file contents');

  assert.equal(manifest.schema_version_before, 1, 'the manifest records the PRE-migration schema version');
  assert.equal(manifest.schema_version_after, 2, 'the manifest records the POST-migration schema version');
  assert.equal(typeof manifest.backup_path, 'string', 'the manifest names the backup it made');
  assert.ok(existsSync(manifest.backup_path), 'the manifest\'s named backup file exists');
  assert.ok(manifest.counts, 'the manifest records per-store counts');
  assert.equal(typeof manifest.counts.records, 'number', 'a records count is present (exact definition not pinned — see file header)');
  assert.equal(manifest.counts.chains_collapsed, 1, 'exactly one supersede chain (A->B->C) was collapsed');
  assert.equal(manifest.counts.aliases_minted, 2, 'exactly two aliases were minted (A and B)');
});

// ===========================================================================
// CONTRACT 4 — VERIFY BEFORE BUMP
// ===========================================================================

test('S4-V1: a dangling superseded_by (pointing at a missing id) fails verification — user_version stays unchanged and the source is restorable from the named backup', () => {
  const { path } = tempDbPath();
  const fx = buildDanglingFixture(path);
  const originalRowX = rawRecordRow(path, fx.idX);

  const { code, stdout, stderr } = runMigrate(['--db', path]);
  assert.notEqual(code, 0, 'a dangling superseded_by must fail verification, never silently succeed');
  assert.equal(rawUserVersion(path), 1, 'user_version is NEVER bumped when verification fails');

  const combined = stdout + stderr;
  assert.match(combined, /verif/i, 'the failure names verification as the reason');
  assert.match(combined, /dangl|missing|unresolv/i, 'the failure names the specific broken-link shape');

  const report = parseJson(stdout, 'migrate stdout on verify failure');
  assert.equal(report.ok, false, 'the structured report says ok:false');
  assert.equal(typeof report.backup_path, 'string', 'even a failed run names its backup, making the source restorable');
  assert.ok(existsSync(report.backup_path), 'the named backup exists');
  assert.equal(rawUserVersion(report.backup_path), 1, 'the backup is the pre-migration (v1) snapshot');

  // restorability, proven by CONTENT rather than a byte-hash (this file does
  // not pin whether the live source is also left byte-identical — see NAMED
  // GAPS): the backup's row for X is the exact pre-run body, so restoring
  // from it reproduces the original store exactly.
  const backedUpRowX = rawRecordRow(report.backup_path, fx.idX);
  assert.ok(backedUpRowX, 'the backup contains the original dangling record X');
  assert.equal(backedUpRowX.superseded_by, originalRowX.superseded_by, 'the backup preserves the exact original (dangling) superseded_by pointer');
  assert.equal(JSON.parse(backedUpRowX.body).statement, JSON.parse(originalRowX.body).statement, 'the backup body is byte-for-byte the pre-migration content');
});

test('S4-V2: two records both claiming to supersede the same id (multi-successor conflict) fails verification — user_version stays unchanged, source restorable', () => {
  const { path } = tempDbPath();
  const fx = buildMultiSuccessorFixture(path);
  const originalRowP = rawRecordRow(path, fx.idP);

  const { code, stdout, stderr } = runMigrate(['--db', path]);
  assert.notEqual(code, 0, 'a multi-successor conflict must fail verification, never silently pick a winner');
  assert.equal(rawUserVersion(path), 1, 'user_version is NEVER bumped when verification fails');

  const combined = stdout + stderr;
  assert.match(combined, /verif/i, 'the failure names verification as the reason');
  assert.match(combined, /multi|successor|conflict/i, 'the failure names the specific multi-successor shape');

  const report = parseJson(stdout, 'migrate stdout on verify failure');
  assert.equal(report.ok, false, 'the structured report says ok:false');
  assert.equal(typeof report.backup_path, 'string', 'even a failed run names its backup, making the source restorable');
  assert.ok(existsSync(report.backup_path), 'the named backup exists');
  assert.equal(rawUserVersion(report.backup_path), 1, 'the backup is the pre-migration (v1) snapshot');

  const backedUpRowP = rawRecordRow(report.backup_path, fx.idP);
  assert.ok(backedUpRowP, 'the backup contains the original conflicted record P');
  assert.equal(JSON.parse(backedUpRowP.body).statement, JSON.parse(originalRowP.body).statement, 'the backup body is byte-for-byte the pre-migration content');
});

// ===========================================================================
// CONTRACT 6 — READ-ONLY REPORT KINSHIP
// ===========================================================================

test('S4-K1: after a successful migration, migration-preflight.mjs on the same store reports already_migrated', () => {
  const { path } = tempDbPath();
  buildLegacyChainFixture(path);

  const migrated = runMigrate(['--db', path]);
  assert.equal(migrated.code, 0, `the healthy chain fixture must migrate successfully: ${migrated.stderr}`);

  const preflight = runPreflight(['--db', path]);
  assert.equal(preflight.code, 0, `the S1 preflight report must run cleanly against a migrated store: ${preflight.stderr}`);
  const report = parseJson(preflight.stdout, 'preflight stdout');
  assert.equal(report.already_migrated, true, 'the S1 preflight script recognizes the post-migration schema version and reports its own already_migrated marker (B3\'s contract)');
});

// test-repair 2026-08-22 (additive, review M1/B2): the RETIREMENT branch —
// superseded_by column with NO record_links edge — and the successor-less
// tombstone (status 'superseded', superseded_by NULL) had zero fixture
// coverage; the latter crashed the runner on an undefined bind until review
// fix B2. This pin covers both shapes. [stable-identity-design-v2]
test('S4-M2 [stable-identity-design-v2]: retirement shape keeps its record (lifecycle retired + supersedes relation), and a successor-less legacy tombstone migrates as retired with NO relation and NO alias', () => {
  const { dir, path } = tempDbPath();
  try {
    const db = createLegacyDb(path);
    const idE = randomUUID(); // survivor
    const idG = randomUUID(); // retirement shape: superseded_by E, no link
    const idH = randomUUID(); // successor-less tombstone: superseded_by NULL
    insertLegacyRecord(db, idE, 'active', null, { title: 'E survivor' });
    insertLegacyRecord(db, idG, 'superseded', idE, { title: 'G duplicate' });
    insertLegacyRecord(db, idH, 'superseded', null, { title: 'H orphan tombstone' });
    db.close();

    const r = runMigrate(['--db', path]);
    assert.equal(r.code, 0, `migration succeeds on retirement + successor-less shapes: ${r.stderr}`);

    const store = new SterlingStore(path);
    try {
      const g = store.get(idG);
      assert.ok(g, 'the retirement-shaped record SURVIVES as a record (no alias collapse)');
      assert.equal(g.status, 'superseded', 'G derives superseded');
      assert.equal(g.superseded_by, idE, 'G derives its successor from the supersedes relation');
      const gRel = store.db
        .prepare("SELECT source_id FROM record_relations WHERE rel = 'supersedes' AND target_id = ?")
        .all(idG);
      assert.equal(gRel.length, 1, 'exactly one supersedes relation targets G');
      assert.equal(gRel[0].source_id, idE, 'the relation runs successor -supersedes-> retired');

      const h = store.get(idH);
      assert.ok(h, 'the successor-less tombstone SURVIVES as a record');
      assert.equal(h.superseded_by, null, 'no successor was invented for it');
      const hRel = store.db
        .prepare("SELECT count(*) AS n FROM record_relations WHERE source_id = ? OR target_id = ?")
        .get(idH, idH);
      assert.equal(hRel.n, 0, 'no relation was minted for a record with no successor');
      const aliases = store.db
        .prepare('SELECT count(*) AS n FROM record_aliases WHERE historical_id IN (?, ?)')
        .get(idG, idH);
      assert.equal(aliases.n, 0, 'neither shape is aliased — both keep their own ids');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// test-repair 2026-08-22 (additive, live-store finding): the legacy update
// path COPIED links[] forward on every re-mint, so a real store's terminus
// carries supersedes edges to ALL its ancestors — the extra edges are
// transitive copies, not second successors, and the runner must collapse
// them (disclosed) instead of refusing. Found live on the node domain store:
// a linear 3-chain refused as multi_successor. [stable-identity-design-v2]
test('S4-M3 [stable-identity-design-v2]: a terminus carrying COPIED transitive supersedes edges to its grand-ancestors migrates cleanly — linear column chain wins, transitive edges dropped and disclosed', () => {
  const { dir, path } = tempDbPath();
  try {
    const db = createLegacyDb(path);
    const idA = randomUUID();
    const idB = randomUUID();
    const idC = randomUUID();
    insertLegacyRecord(db, idC, 'active', null, { title: 'C terminus' });
    insertLegacyRecord(db, idB, 'superseded', idC, { title: 'B middle' });
    insertLegacyRecord(db, idA, 'superseded', idB, { title: 'A root' });
    insertLegacyLink(db, idB, 'supersedes', idA);
    insertLegacyLink(db, idC, 'supersedes', idB);
    insertLegacyLink(db, idC, 'supersedes', idA); // the copied transitive edge
    db.close();

    const r = runMigrate(['--db', path]);
    assert.equal(r.code, 0, `a linear chain with copied transitive edges migrates: ${r.stderr}`);
    const report = parseJson(r.stdout, 'runner stdout');
    assert.equal(report.ok, true);

    const store = new SterlingStore(path);
    try {
      const c = store.get(idC);
      assert.ok(c, 'terminus survives under its own id');
      assert.equal(c.version, 3, 'terminus is version 3 of a 3-chain');
      const aliases = store.db
        .prepare('SELECT historical_id FROM record_aliases WHERE canonical_id = ? ORDER BY archived_version')
        .all(idC)
        .map((row) => row.historical_id);
      assert.deepEqual(aliases, [idA, idB], 'A and B alias onto the terminus at versions 1 and 2');
    } finally {
      store.close();
    }

    const manifest = parseJson(readFileSync(report.manifest_path, 'utf8'), 'manifest');
    const disclosed = JSON.stringify(manifest);
    assert.match(disclosed, /transitive/i, 'the dropped transitive edge is DISCLOSED in the manifest, never silent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// test-repair 2026-08-22 (additive, live-store finding #2): knowledge_promote
// tombstones a project record with superseded_by = the id the record got in a
// DOMAIN store — a successor that deliberately does not exist locally. The
// column-only, target-missing signature is the promotion shape the design
// says to classify distinctly; it must migrate (retired, foreign successor
// recorded and disclosed), never refuse as corruption. [stable-identity-design-v2]
test('S4-M4 [stable-identity-design-v2]: a promote tombstone (superseded_by names a FOREIGN, non-local id; no link) migrates retired with the foreign successor served and disclosed', () => {
  const { dir, path } = tempDbPath();
  try {
    const db = createLegacyDb(path);
    const idP = randomUUID();
    const foreignId = randomUUID(); // never created locally — lives in a domain store
    insertLegacyRecord(db, idP, 'superseded', foreignId, { title: 'P promoted-away' });
    db.close();

    const r = runMigrate(['--db', path]);
    assert.equal(r.code, 0, `a promote tombstone migrates: ${r.stderr}`);
    const report = parseJson(r.stdout, 'runner stdout');
    assert.equal(report.ok, true);

    const store = new SterlingStore(path);
    try {
      const p = store.get(idP);
      assert.ok(p, 'the tombstone survives as a record');
      assert.equal(p.status, 'superseded', 'derives superseded');
      assert.equal(p.superseded_by, foreignId, 'the FOREIGN successor is served — exactly what v1 served');
    } finally {
      store.close();
    }
    const manifest = parseJson(readFileSync(report.manifest_path, 'utf8'), 'manifest');
    assert.match(JSON.stringify(manifest), /PROMOTION tombstone|foreign/i, 'the foreign successor is DISCLOSED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
