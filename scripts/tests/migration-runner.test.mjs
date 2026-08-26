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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'migrate-stores.mjs');
const PREFLIGHT_SCRIPT = join(root, 'scripts', 'migration-preflight.mjs');
const NOW = '2026-08-22T12:00:00.000Z';

let SterlingStore;
let DatabaseSync;
let ProjectRegistry;
before(async () => {
  ({ SterlingStore, ProjectRegistry } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
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

// ===========================================================================
// board d055b150 — SUCCESSOR ELECTION + JOURNAL PROVENANCE
//
// The deepdots store's real multi_successor conflict (record c1bae7e0, three
// claimants) needed a human-ruled resolution routed through this journalled
// runner rather than a hand-edit of the SQLite file. --elect-successor
// <oldId>=<winnerId> (repeatable) is that route: it is consumed ONLY against
// a genuine multi_successor conflict on oldId whose claimant set contains
// winnerId, and refuses loudly (never silently no-ops) on a mismatch or a
// stale instruction. Separately, the runner's journal previously carried no
// caller identity at all — argv/cwd/pid/ppid/invoked_by close that gap.
// ===========================================================================

function buildAbsentTargetElectionFixture(path) {
  // The deepdots c1bae7e0 shape: the superseded id itself has NO local
  // record row — only the claimants' record_links edges reference it (a
  // project-local handoff, per the board item). Two real, healthy records
  // (W1, W2) each independently claim to supersede it.
  const idAbsent = randomUUID();
  const idW1 = randomUUID();
  const idW2 = randomUUID();
  const db = createLegacyDb(path);
  try {
    insertLegacyRecord(db, idW1, 'active', null, { title: 'W1', statement: 'w1 healthy' });
    insertLegacyRecord(db, idW2, 'active', null, { title: 'W2', statement: 'w2 healthy' });
    insertLegacyLink(db, idW1, 'supersedes', idAbsent);
    insertLegacyLink(db, idW2, 'supersedes', idAbsent);
    db.exec('PRAGMA user_version = 1');
  } finally {
    db.close();
  }
  return { idAbsent, idW1, idW2 };
}

test('S4-E1 [board d055b150]: --elect-successor resolves a multi-successor conflict, dropping the losing claimant and collapsing onto the elected winner', () => {
  const { dir, path } = tempDbPath();
  try {
    const fx = buildMultiSuccessorFixture(path);

    const r = runMigrate(['--db', path, '--elect-successor', `${fx.idP}=${fx.idQ1}`]);
    assert.equal(r.code, 0, `an election matching the claimant set must succeed: ${r.stderr}`);
    const report = parseJson(r.stdout, 'runner stdout');
    assert.equal(report.ok, true);

    const store = new SterlingStore(path);
    try {
      const q1 = store.get(fx.idQ1);
      assert.ok(q1, 'the elected winner Q1 survives as the terminus');
      assert.equal(q1.version, 2, 'Q1 is now version 2 — P folded into its history by the election');

      const aliasP = store.recordAliases().find((a) => a.historical_id === fx.idP);
      assert.ok(aliasP, 'P resolves via the alias index onto the elected winner');
      assert.equal(aliasP.canonical_id, fx.idQ1, 'P collapsed onto the ELECTED winner Q1, never the un-elected Q2');

      const q2Rel = store.db
        .prepare('SELECT count(*) AS n FROM record_relations WHERE source_id = ? OR target_id = ?')
        .get(fx.idQ2, fx.idQ2);
      assert.equal(q2Rel.n, 0, 'the losing claimant Q2 carries no relation to P — its edge was dropped by the election');
    } finally {
      store.close();
    }

    const manifest = parseJson(readFileSync(report.manifest_path, 'utf8'), 'manifest');
    const disclosed = JSON.stringify(manifest);
    assert.match(disclosed, /ELECTION/, 'the election is disclosed in the manifest, never silent');
    assert.match(disclosed, new RegExp(fx.idQ2), 'the dropped losing-claimant edge names the dropped claimant');
    assert.ok(
      manifest.invocation?.argv?.includes('--elect-successor'),
      'the election lands VERBATIM in the journal via argv'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-E2 [board d055b150]: --elect-successor naming a winner NOT among the claimants refuses loudly, never silently ignored', () => {
  const { path } = tempDbPath();
  const fx = buildMultiSuccessorFixture(path);
  const bogusWinner = randomUUID();

  const { code, stdout, stderr } = runMigrate(['--db', path, '--elect-successor', `${fx.idP}=${bogusWinner}`]);
  assert.notEqual(code, 0, 'an election naming a non-claimant winner must refuse, never silently ignore or invent');
  assert.equal(rawUserVersion(path), 1, 'user_version is never bumped when an election is rejected');

  const combined = stdout + stderr;
  assert.match(combined, /elect/i, 'the refusal names the election mechanism');
  assert.match(combined, new RegExp(bogusWinner), 'the refusal names the mismatched winner it was given');
  assert.match(
    combined,
    /re-run electing one of the listed claimants/i,
    'F3: the refusal appends the corrective REMEDY, not just the mismatch'
  );
});

test('S4-E3 [board d055b150]: --elect-successor naming a conflict that does not exist refuses as a stale instruction, never a silent no-op', () => {
  const { path } = tempDbPath();
  const fx = buildLegacyChainFixture(path); // a healthy chain: idA is singly-claimed, no conflict at all

  const { code, stdout, stderr } = runMigrate(['--db', path, '--elect-successor', `${fx.idA}=${fx.idB}`]);
  assert.notEqual(code, 0, 'an election for a conflict that does not exist is an error, not a no-op');
  assert.equal(rawUserVersion(path), 1, 'user_version is never bumped when a stale election is rejected');

  const combined = stdout + stderr;
  assert.match(combined, /stale|does not exist/i, 'the refusal names the election as stale/non-matching');
  assert.match(
    combined,
    /drop this --elect-successor and re-run/i,
    'F3: the refusal appends the corrective REMEDY, not just the diagnosis'
  );
});

test('S4-E4 [board d055b150]: election resolves a multi-successor conflict whose superseded target has NO local record row (the deepdots c1bae7e0 shape) — migration proceeds, the absence is disclosed explicitly', () => {
  const { dir, path } = tempDbPath();
  try {
    const fx = buildAbsentTargetElectionFixture(path);

    const r = runMigrate(['--db', path, '--elect-successor', `${fx.idAbsent}=${fx.idW1}`]);
    assert.equal(r.code, 0, `an election on an absent target must resolve cleanly, not crash or refuse: ${r.stderr}`);
    const report = parseJson(r.stdout, 'runner stdout');
    assert.equal(report.ok, true);

    const store = new SterlingStore(path);
    try {
      const w1 = store.get(fx.idW1);
      const w2 = store.get(fx.idW2);
      assert.ok(w1 && w2, 'both real claimants survive as ordinary live records, unaffected in content');

      const aliasForAbsent = store.recordAliases().find((a) => a.historical_id === fx.idAbsent);
      assert.equal(aliasForAbsent, undefined, 'the absent target is never aliased — there is no row to archive');

      const relCount = store.db
        .prepare('SELECT count(*) AS n FROM record_relations WHERE source_id = ? OR target_id = ?')
        .get(fx.idAbsent, fx.idAbsent);
      assert.equal(relCount.n, 0, 'no relation is minted for an id that never had a local record row');
    } finally {
      store.close();
    }

    const manifest = parseJson(readFileSync(report.manifest_path, 'utf8'), 'manifest');
    const disclosed = JSON.stringify(manifest);
    assert.match(disclosed, /ABSENT/, 'the absence of the superseded target is disclosed explicitly, not swept under the election');
    assert.match(disclosed, /ELECTION/, 'the election that resolved the conflict is disclosed too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// review fix F1 (roster review, board d055b150): the absent-target handling
// was gated on `electionsUsed.has(oldId)`, so a SINGLY-claimed absent target
// (no conflict at all, hence no election) fell through to collapseSuccessor,
// became a chain root, and crashed JSON.parse(alias.row.body) inside the
// transaction — the exact shape deepdots' own c1bae7e0 carries BEFORE any
// human ruling (a dangling link target, singly claimed until the OTHER two
// claimants are discovered). This must migrate cleanly, election or not.
function buildSingleClaimAbsentTargetFixture(path) {
  const idAbsent = randomUUID(); // no local record row at all
  const idW1 = randomUUID();
  const db = createLegacyDb(path);
  try {
    insertLegacyRecord(db, idW1, 'active', null, { title: 'W1', statement: 'w1 healthy, sole claimant' });
    insertLegacyLink(db, idW1, 'supersedes', idAbsent);
    db.exec('PRAGMA user_version = 1');
  } finally {
    db.close();
  }
  return { idAbsent, idW1 };
}

test('S4-E5 [board d055b150 review fix F1]: a SINGLY-claimed absent target (no conflict, no election) migrates cleanly with an ABSENT disclosure, never a crash', () => {
  const { dir, path } = tempDbPath();
  try {
    const fx = buildSingleClaimAbsentTargetFixture(path);

    const r = runMigrate(['--db', path]);
    assert.equal(r.code, 0, `a singly-claimed absent target must resolve cleanly, not crash: ${r.stderr}`);
    const report = parseJson(r.stdout, 'runner stdout');
    assert.equal(report.ok, true);

    const store = new SterlingStore(path);
    try {
      const w1 = store.get(fx.idW1);
      assert.ok(w1, 'the sole claimant survives as an ordinary live record');
      const aliasForAbsent = store.recordAliases().find((a) => a.historical_id === fx.idAbsent);
      assert.equal(aliasForAbsent, undefined, 'the absent target is never aliased — there is no row to archive');
      const relCount = store.db
        .prepare('SELECT count(*) AS n FROM record_relations WHERE source_id = ? OR target_id = ?')
        .get(fx.idAbsent, fx.idAbsent);
      assert.equal(relCount.n, 0, 'no relation is minted for an id that never had a local record row');
    } finally {
      store.close();
    }

    const manifest = parseJson(readFileSync(report.manifest_path, 'utf8'), 'manifest');
    const disclosed = JSON.stringify(manifest);
    assert.match(disclosed, /ABSENT/, 'the absence is disclosed even with no election involved');
    assert.doesNotMatch(disclosed, /ELECTION/, 'no election fired here — the disclosure must not falsely credit one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// review fix F2 (roster review, board d055b150): parseElections previously
// accepted any string on either side of '=', so a typo'd or space-padded id
// was only caught later as stale_election/election_mismatch AFTER classify()
// ran inside main() — i.e. AFTER the VACUUM INTO backup was already taken,
// contradicting the function's own "before a backup is even taken" comment.
test('S4-E6 [board d055b150 review fix F2]: a non-UUID-shaped --elect-successor id refuses BEFORE any backup or manifest is written', () => {
  const { dir, path } = tempDbPath();
  const fx = buildMultiSuccessorFixture(path);
  const before_ = dirSnapshot(dir);

  const { code, stdout, stderr } = runMigrate(['--db', path, '--elect-successor', `${fx.idP}=not-a-uuid`]);
  assert.notEqual(code, 0, 'a non-UUID-shaped election id must refuse, never be silently coerced');
  assert.equal(rawUserVersion(path), 1, 'user_version is untouched');

  const combined = stdout + stderr;
  assert.match(combined, /UUID-shaped/i, 'the refusal names the shape requirement');
  assert.deepEqual(
    dirSnapshot(dir),
    before_,
    'a syntactically invalid election refuses before any backup/manifest file is created — no litter'
  );
});

test('S4-P1 [board d055b150]: every journal carries invocation provenance — argv, cwd, pid, ppid, invoked_by — on a successful run', () => {
  const { dir, path } = tempDbPath();
  try {
    buildLegacyChainFixture(path);

    const r = runMigrate(['--db', path]);
    assert.equal(r.code, 0, `healthy chain migrates: ${r.stderr}`);
    const report = parseJson(r.stdout, 'runner stdout');
    const manifest = parseJson(readFileSync(report.manifest_path, 'utf8'), 'manifest');

    assert.ok(manifest.invocation, 'the journal carries an invocation block');
    assert.deepEqual(manifest.invocation.argv, ['--db', path], 'argv is the post-node args, sanitized verbatim');
    assert.equal(typeof manifest.invocation.cwd, 'string');
    assert.ok(manifest.invocation.cwd.length > 0, 'cwd is recorded');
    assert.equal(typeof manifest.invocation.pid, 'number');
    assert.ok(manifest.invocation.pid > 0, 'pid is recorded');
    assert.equal(typeof manifest.invocation.ppid, 'number');
    assert.ok(manifest.invocation.ppid > 0, 'ppid is recorded');
    assert.equal(manifest.invocation.invoked_by, 'direct', 'a run with no --invoked-by attributes itself as direct');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-P2 [board d055b150]: --invoked-by is recorded verbatim, including on a run refused BEFORE any mutation — provenance must survive a refusal', () => {
  const { path } = tempDbPath();
  const fx = buildMultiSuccessorFixture(path);

  const r = runMigrate(['--db', path, '--invoked-by', 'update-sweep']);
  assert.notEqual(r.code, 0, 'the multi-successor conflict still refuses when no election is given');
  const report = parseJson(r.stdout, 'runner stdout on refusal');
  const manifest = parseJson(readFileSync(report.manifest_path, 'utf8'), 'manifest');
  assert.equal(manifest.invocation.invoked_by, 'update-sweep', 'even a refused run is attributed to its caller');
});

// ===========================================================================
// PIN GROUP M3 — `--all-stores` MACHINE-WIDE ENUMERATION
// SPEC-ONLY: --all-stores currently exits 3 "not implemented" (per the
// dispatch brief). Every test below must therefore go RED TODAY on its own
// assertion (an exit-code mismatch against 3, or a JSON.parse on stdout that
// is not the expected report shape) — never a bare crash — mirroring this
// file's existing spec-only convention (see the header for S4).
//
// DESIGN SOURCE (decision stable-identity-design-v2, migration section):
// "enumerate all stores via ProjectRegistry + domain stores" — this pin
// group specifies that enumeration as three sources, unioned and deduped by
// resolved absolute path:
//   (i)   every REGISTERED project's own store: <repo_path>/.sterling/sterling.db
//   (ii)  every registered project's OWN CONFIG domain mounts:
//         <repo_path>/.sterling/config.json -> domain_paths: {name: path}
//         (the same domain_paths shape scripts/domain-doctor.mjs's own
//         sweep/resolveDomainMounts already reads — reused here, not
//         invented; see scripts/tests/domain-doctor.test.mjs's lossScenario
//         fixture for the exact shape)
//   (iii) every <root>/<domain>/sterling.db under the DEFAULT-ROOT domains
//         directory (or an override — see SEAM ASSUMPTIONS below)
//
// One JSON result line per UNIQUE physical store (same shape as a --db
// invocation's own stdout: the success/already_migrated/failure shapes
// documented at the top of this file); exit 0 iff every store is
// ok/already_migrated, exit 1 if any store failed, and processing CONTINUES
// past a per-store failure rather than aborting the whole run.
//
// SEAM ASSUMPTIONS (H4-blind; named per the dispatch brief's instruction,
// since --all-stores has no prior test coverage in this file to reuse):
//   - STERLING_REGISTRY_DB (env var): overrides the ProjectRegistry path.
//     This is NOT invented here — it is the established, already-shipped
//     test-isolation seam for packages/store's ProjectRegistry (decision
//     8f9e6db2; reused verbatim by scripts/tests/init-ensure.test.mjs).
//   - `--roots <dir>[,<dir>...]` (CLI flag): assumed to override the
//     default-root domains directory scan for source (iii) above, mirroring
//     scripts/domain-doctor.mjs's OWN `--roots` flag over the identical
//     physical layout (`<root>/<domain>/sterling.db` — see
//     scripts/tests/domain-doctor.test.mjs's `scan --roots` pin). Assumed to
//     REPLACE the default root(s) entirely, not add to them — the same way
//     domain-doctor's own --roots is exercised as a full override in its own
//     tests.
//   - HOME (env var): also overridden defensively in every test below, on
//     top of --roots, so that IF the real implementation's default-root
//     resolution does not fully honor --roots as a replacement, the
//     homedir()-based default at least resolves to an empty, isolated
//     directory rather than this machine's real ~/.sterling/domains.
//
// NAMED RISK, stated rather than hidden: if the real implementation does NOT
// treat --roots as a full replacement (e.g. it ADDS to the default root, or
// the WSL-mirror default path — documented on domain-doctor as
// `/mnt/c/Users/<user>/.sterling/domains` — resolves independently of HOME),
// a run of these tests on a machine that also has real registered projects
// or real domain stores could enumerate — and, worse, MIGRATE — real data as
// a side effect. This is inherent to spec-authoring blind to the
// implementation (H4): the coder must verify --roots and STERLING_REGISTRY_DB
// genuinely REPLACE their defaults before these pins are trusted to run
// safely in CI on a machine carrying live Sterling projects.
// ===========================================================================

function runMigrateEnv(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeRegistry(dir, entries) {
  const dbPath = join(dir, 'registry.db');
  const reg = new ProjectRegistry(dbPath);
  try {
    for (const e of entries) {
      reg.register({
        repo_path: e.repo_path,
        name: e.name,
        stack_tags: e.stack_tags ?? [],
        toolchains: e.toolchains ?? ['node'],
        sterling_version: '1.0.0',
        at: NOW,
      });
    }
  } finally {
    reg.close();
  }
  return dbPath;
}

function buildSingleLegacyRecordFixture(path) {
  const db = createLegacyDb(path);
  const id = randomUUID();
  try {
    insertLegacyRecord(db, id, 'active', null, { title: 'Solo', statement: 'solo record zzzsolomarker' });
    db.exec('PRAGMA user_version = 1');
  } finally {
    db.close();
  }
  return { id };
}

/** Splits stdout into whatever lines parse as JSON objects, silently
 *  skipping non-JSON lines (a pre-work refusal for a single store is only
 *  loosely text-pinned by this file's own convention — see S4-R1/R3 above —
 *  so a failing store's line is not required to be strict JSON). */
function parseJsonLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((v) => v !== null);
}

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- CONTROL, placed FIRST: proves the counting mechanism is not
// coincidentally capped/collapsed — two genuinely DIFFERENT store paths
// under --roots both enumerate. Without this, S4-ALL-3's "exactly 2 results"
// verdict would be equally explainable by an implementation that always
// reports 2 regardless of what is actually distinct on disk. ---

test('S4-ALL-3-CONTROL [--all-stores]: two DIFFERENT domain stores under --roots both enumerate (control for the dedupe pin below)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-control-'));
  try {
    const domainsRoot = join(dir, 'domains');
    const dbA = join(domainsRoot, 'alpha', 'sterling.db');
    const dbB = join(domainsRoot, 'beta', 'sterling.db');
    mkdirSync(dirname(dbA), { recursive: true });
    mkdirSync(dirname(dbB), { recursive: true });
    new SterlingStore(dbA).close();
    new SterlingStore(dbB).close();

    const registryDb = makeRegistry(dir, []);
    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });
    assert.equal(code, 0, `two independent, already-v2 stores must be a clean run: ${stderr}`);

    const results = parseJsonLines(stdout);
    assert.equal(
      results.length,
      2,
      'two genuinely DIFFERENT store paths must both be reported — proves counting keys on absolute PATH EQUALITY, not on a fixed/coincidental count'
    );
    assert.ok(results.some((r) => r.db === dbA), 'store A is reported');
    assert.ok(results.some((r) => r.db === dbB), 'store B is reported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-ALL-1 [--all-stores]: a registry project (legacy) + a default-root domain store (v2) are BOTH reported, the legacy one migrated, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-'));
  try {
    const domainsRoot = join(dir, 'domains');
    const domainDb = join(domainsRoot, 'mydomain', 'sterling.db');
    mkdirSync(dirname(domainDb), { recursive: true });
    const domainStore = new SterlingStore(domainDb);
    domainStore.close();
    assert.equal(rawUserVersion(domainDb), 2, 'precondition: the seeded domain store is already v2');

    const projectDir = join(dir, 'proj1');
    mkdirSync(join(projectDir, '.sterling'), { recursive: true });
    const projectDb = join(projectDir, '.sterling', 'sterling.db');
    buildSingleLegacyRecordFixture(projectDb);
    assert.equal(rawUserVersion(projectDb), 1, 'precondition: the seeded project store is legacy (v1)');

    const registryDb = makeRegistry(dir, [{ repo_path: projectDir, name: 'proj1' }]);

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });
    assert.equal(code, 0, `both seeded stores are healthy — the whole run must exit 0: ${stderr}`);

    const results = parseJsonLines(stdout);
    const byDb = Object.fromEntries(results.map((r) => [r.db, r]));

    assert.ok(byDb[projectDb], 'the registry project store is reported');
    assert.equal(byDb[projectDb].ok, true);
    assert.equal(byDb[projectDb].already_migrated, false, 'the legacy store was actually migrated, not a no-op');
    assert.equal(rawUserVersion(projectDb), 2, 'the legacy project store is bumped to v2 on disk — proves real work happened, not a fabricated success line');

    assert.ok(byDb[domainDb], 'the default-root domain store is reported');
    assert.equal(byDb[domainDb].ok, true);
    assert.equal(byDb[domainDb].already_migrated, true, 'the v2 domain store is a clean no-op');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-ALL-2 [--all-stores]: one store fails (a corrupt/unreadable file) — the other store still migrates, exit 1, the failing path is named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-fail-'));
  try {
    // Named "aaa-*" so it sorts/enumerates as a REGISTRY project — the
    // brief's own enumeration order lists registry projects BEFORE
    // default-root domain stores, so this exercises "continue past a
    // failure that happens before the rest of the run", not a lucky order.
    const projectDir = join(dir, 'aaa-corrupt');
    mkdirSync(join(projectDir, '.sterling'), { recursive: true });
    const corruptDb = join(projectDir, '.sterling', 'sterling.db');
    writeFileSync(corruptDb, 'this is not a sqlite file at all');

    const domainsRoot = join(dir, 'domains');
    const healthyDb = join(domainsRoot, 'zzz-healthy', 'sterling.db');
    mkdirSync(dirname(healthyDb), { recursive: true });
    const healthyStore = new SterlingStore(healthyDb);
    healthyStore.close();

    const registryDb = makeRegistry(dir, [{ repo_path: projectDir, name: 'aaa-corrupt' }]);

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });
    assert.equal(code, 1, 'one failed store must make the whole run exit 1, distinct from the all-ok exit-0 case');

    const combined = stdout + stderr;
    assert.match(combined, new RegExp(reEscape(corruptDb)), 'the failure names the exact path that could not be migrated');

    const results = parseJsonLines(stdout);
    const byDb = Object.fromEntries(results.map((r) => [r.db, r]));
    assert.ok(byDb[healthyDb], 'the healthy store, enumerated AFTER the failing one, is still reported — the run continues past the failure');
    assert.equal(byDb[healthyDb].ok, true, 'the healthy store migrates cleanly despite the earlier failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-ALL-3 [--all-stores]: the same domain store reachable via a project config mount AND the default-root scan enumerates exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-dedupe-'));
  try {
    const domainsRoot = join(dir, 'domains');
    const domainDb = join(domainsRoot, 'shared', 'sterling.db');
    mkdirSync(dirname(domainDb), { recursive: true });
    const domainStore = new SterlingStore(domainDb);
    domainStore.close();

    const projectDir = join(dir, 'proj1');
    mkdirSync(join(projectDir, '.sterling'), { recursive: true });
    const projectDb = join(projectDir, '.sterling', 'sterling.db');
    const projectStore = new SterlingStore(projectDb);
    projectStore.close();
    // the SAME shape domain-doctor.mjs's own lossScenario fixture uses
    // (scripts/tests/domain-doctor.test.mjs) — config.domain_paths mounting
    // an explicit path onto a stack tag.
    writeFileSync(
      join(projectDir, '.sterling', 'config.json'),
      JSON.stringify({ stack_tags: ['shared'], domain_paths: { shared: domainDb.replace(/\\/g, '/') } })
    );

    const registryDb = makeRegistry(dir, [{ repo_path: projectDir, name: 'proj1', stack_tags: ['shared'] }]);

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });
    assert.equal(code, 0, `both physical stores are already v2 — the whole run must exit 0: ${stderr}`);

    const results = parseJsonLines(stdout);
    assert.ok(
      results.some((r) => r.db === projectDb),
      "the registry project's own store is present (control: the count below is not merely coincidental)"
    );
    const domainHits = results.filter((r) => r.db === domainDb);
    assert.equal(domainHits.length, 1, 'the same absolute domain-store path, reachable via BOTH the project config mount and the default-root scan, is deduped to a single result line');
    assert.equal(results.length, 2, 'exactly two PHYSICAL stores exist on disk (the project store + the one shared domain store) — no phantom third entry from the un-deduped mount');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// review fix (round-trip 2026-08-26): two mutation survivors found in this
// PIN GROUP — neither the MISSING-store line shape nor the --all-stores /
// --elect-successor CONFLICT was pinned anywhere above. Same file, same
// S4-ALL idiom/isolation seams (STERLING_REGISTRY_DB, --roots, HOME).

test("S4-ALL-4 [--all-stores]: an enumerated store path that does not exist on disk emits a missing:true line and is NOT counted as a failure — exit stays 0 when everything else succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-missing-'));
  try {
    // a registry project that is real (repo_path/.sterling/ exists) but was
    // never store-inited — sterling.db itself is genuinely ABSENT, distinct
    // from S4-ALL-2's CORRUPT (present-but-unreadable) file.
    const projectDir = join(dir, 'never-inited');
    mkdirSync(join(projectDir, '.sterling'), { recursive: true });
    const missingDb = join(projectDir, '.sterling', 'sterling.db');
    assert.equal(existsSync(missingDb), false, 'precondition: genuinely absent, not merely unreadable');

    const domainsRoot = join(dir, 'domains');
    const healthyDb = join(domainsRoot, 'healthy', 'sterling.db');
    mkdirSync(dirname(healthyDb), { recursive: true });
    new SterlingStore(healthyDb).close();

    const registryDb = makeRegistry(dir, [{ repo_path: projectDir, name: 'never-inited' }]);

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });
    // Contrast with S4-ALL-2 (a genuine per-store failure DOES flip exit to
    // 1): this is the control that not every enumeration hiccup is a
    // failure — a store that was simply never created is a distinct, benign
    // outcome from a store that exists and cannot be read/migrated.
    assert.equal(code, 0, `a genuinely-absent enumerated store must not fail the run when every store that exists succeeds: ${stderr}`);

    const results = parseJsonLines(stdout);
    const byDb = Object.fromEntries(results.map((r) => [r.db, r]));

    assert.ok(byDb[missingDb], 'the missing store still gets its own result line — it is not silently dropped from enumeration');
    assert.equal(byDb[missingDb].missing, true, 'the missing store line is marked missing:true');
    assert.notEqual(byDb[missingDb].ok, false, 'a missing store must never be reported as a FAILURE (ok:false) — S4-ALL-2 already pins that real failures DO set ok:false/exit 1, so this line must read distinctly');

    assert.ok(byDb[healthyDb], 'the healthy store is still reported');
    assert.equal(byDb[healthyDb].ok, true, 'the healthy store migrates cleanly alongside the missing one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-ALL-5 [--all-stores]: `--all-stores` combined with `--elect-successor` refuses immediately, naming the conflict, without touching any store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-conflict-'));
  try {
    const domainsRoot = join(dir, 'domains');
    const healthyDir = join(domainsRoot, 'healthy');
    const healthyDb = join(healthyDir, 'sterling.db');
    mkdirSync(healthyDir, { recursive: true });
    new SterlingStore(healthyDb).close();
    const hashBefore = fileHash(healthyDb);
    const dirBefore = dirSnapshot(healthyDir);

    const registryDb = makeRegistry(dir, []);
    const bogusOld = randomUUID();
    const bogusWinner = randomUUID();

    const { code, stdout, stderr } = runMigrateEnv(
      ['--all-stores', '--roots', domainsRoot, '--elect-successor', `${bogusOld}=${bogusWinner}`],
      { STERLING_REGISTRY_DB: registryDb, HOME: join(dir, 'fake-home') }
    );
    assert.notEqual(
      code,
      0,
      '--elect-successor names a single store\'s conflict to resolve — combined with --all-stores (which store would it apply to?) it is an incoherent combination and must refuse'
    );

    const combined = stdout + stderr;
    assert.match(combined, /--all-stores/, 'the refusal names --all-stores as one half of the conflicting combination');
    assert.match(combined, /--elect-successor/, 'the refusal names --elect-successor as the other half of the conflicting combination');

    assert.equal(fileHash(healthyDb), hashBefore, 'the seeded store is byte-identical — the refusal happens before any store is even opened, let alone migrated');
    assert.deepEqual(dirSnapshot(healthyDir), dirBefore, 'no backup/manifest litter is created for a run refused before any store is touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// adjudicated post-fix pins round 2 (2026-08-26), same S4-ALL idiom/seams.

function runMigrateFrom(args, env, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test("S4-ALL-6 [--all-stores]: a RELATIVE domain_paths mount (\"./rel/foo.db\") resolves against the PROJECT's repo_path, never the sweep's own cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-relmount-'));
  try {
    const projectDir = join(dir, 'proj-rel');
    mkdirSync(join(projectDir, '.sterling'), { recursive: true });
    const projectDb = join(projectDir, '.sterling', 'sterling.db');
    new SterlingStore(projectDb).close();

    const correctDb = join(projectDir, 'rel', 'foo.db');
    mkdirSync(dirname(correctDb), { recursive: true });
    new SterlingStore(correctDb).close();

    writeFileSync(
      join(projectDir, '.sterling', 'config.json'),
      JSON.stringify({ stack_tags: ['foo'], domain_paths: { foo: './rel/foo.db' } })
    );

    const registryDb = makeRegistry(dir, [{ repo_path: projectDir, name: 'proj-rel', stack_tags: ['foo'] }]);

    const domainsRoot = join(dir, 'domains');
    mkdirSync(domainsRoot, { recursive: true }); // empty — default-root scan finds nothing extra

    // Discriminator: spawn from a DIFFERENT cwd than the project. A buggy
    // resolution of the relative mount against the SWEEP's own cwd (instead
    // of the project's repo_path) would compute <spawnCwd>/rel/foo.db.
    const spawnCwd = join(dir, 'elsewhere');
    mkdirSync(spawnCwd, { recursive: true });
    const wrongDb = join(spawnCwd, 'rel', 'foo.db');

    const { code, stdout, stderr } = runMigrateFrom(
      ['--all-stores', '--roots', domainsRoot],
      { STERLING_REGISTRY_DB: registryDb, HOME: join(dir, 'fake-home') },
      spawnCwd
    );
    assert.equal(code, 0, `every seeded store is already v2 — clean run: ${stderr}`);

    const results = parseJsonLines(stdout);
    const byDb = Object.fromEntries(results.map((r) => [r.db, r]));
    assert.ok(byDb[correctDb], "the relative mount resolves against the PROJECT's own repo_path — reported under <repoPath>/rel/foo.db");
    assert.ok(!byDb[wrongDb], "the relative mount must NOT resolve against the sweep's own spawn cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-ALL-7 [--all-stores]: a CORRUPT STERLING_REGISTRY_DB (non-SQLite garbage) exits nonzero naming the registry failure, while default-root stores still get their per-store lines (continuation)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-regcorrupt-'));
  try {
    const garbageRegistry = join(dir, 'registry.db');
    writeFileSync(garbageRegistry, 'not a sqlite database at all');

    const domainsRoot = join(dir, 'domains');
    const healthyDb = join(domainsRoot, 'healthy', 'sterling.db');
    mkdirSync(dirname(healthyDb), { recursive: true });
    new SterlingStore(healthyDb).close();

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: garbageRegistry,
      HOME: join(dir, 'fake-home'),
    });
    assert.notEqual(code, 0, 'a corrupt registry file must make the run exit nonzero');

    const combined = stdout + stderr;
    assert.match(combined, /registry/i, 'the failure names the registry as the source of the problem');

    const results = parseJsonLines(stdout);
    const byDb = Object.fromEntries(results.map((r) => [r.db, r]));
    assert.ok(byDb[healthyDb], 'default-root domain stores are still enumerated and reported despite the registry failure — continuation, not a full abort');
    assert.equal(byDb[healthyDb].ok, true, 'the healthy default-root store still migrates cleanly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-ALL-8 [--all-stores]: STERLING_REGISTRY_DB pointing at a NONEXISTENT path fails loudly, naming the exact path, exit nonzero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-regmissing-'));
  try {
    const missingRegistry = join(dir, 'does-not-exist', 'registry.db');
    assert.equal(existsSync(missingRegistry), false, 'precondition: genuinely absent');

    const domainsRoot = join(dir, 'domains');
    mkdirSync(domainsRoot, { recursive: true });

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: missingRegistry,
      HOME: join(dir, 'fake-home'),
    });
    assert.notEqual(code, 0, 'an EXPLICITLY-named but nonexistent registry path is a hard, loud failure — never a silent empty-registry fallback (the caller asserted this exact path)');

    const combined = stdout + stderr;
    assert.match(combined, new RegExp(reEscape(missingRegistry)), 'the failure names the exact registry path that was given but does not exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// completeness-gap pin (2026-08-26): a code path the fixer just closed had
// NO red-proof — a project whose config.json is corrupt must fail loudly for
// THAT config specifically, without suppressing the project's own default
// store from enumeration. Same S4-ALL idiom/seams.

test("S4-ALL-9 [--all-stores]: a project with a CORRUPT config.json (unparseable) is skipped BY NAME — the project's own sterling.db still gets its own result line, sweep exits nonzero", () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-corruptcfg-'));
  try {
    const projectDir = join(dir, 'proj-corrupt-cfg');
    mkdirSync(join(projectDir, '.sterling'), { recursive: true });
    const projectDb = join(projectDir, '.sterling', 'sterling.db');
    new SterlingStore(projectDb).close(); // the project's OWN store is healthy/v2

    const configPath = join(projectDir, '.sterling', 'config.json');
    writeFileSync(configPath, '{ not valid json at all');

    const domainsRoot = join(dir, 'domains');
    mkdirSync(domainsRoot, { recursive: true }); // empty — no default-root stores to confuse the picture

    const registryDb = makeRegistry(dir, [{ repo_path: projectDir, name: 'proj-corrupt-cfg' }]);

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });
    assert.notEqual(code, 0, 'an unparseable project config is a genuine failure and must not be swallowed into a clean exit 0 (log-and-continue-uncounted sabotage)');

    const combined = stdout + stderr;
    assert.match(combined, new RegExp(reEscape(configPath)), 'the failure names the exact corrupt config path');

    const results = parseJsonLines(stdout);
    const skippedLine = results.find((r) => r.skipped === true && JSON.stringify(r).includes(configPath));
    assert.ok(skippedLine, `a skipped:true line names the corrupt config path; results were: ${JSON.stringify(results)}`);

    const byDb = Object.fromEntries(results.map((r) => [r.db, r]));
    assert.ok(
      byDb[projectDb],
      "the project's OWN default store (sterling.db) still gets its own result line — a corrupt DOMAIN-MOUNT config must not suppress the project's default store (skip-the-whole-project sabotage)"
    );
    assert.equal(byDb[projectDb].ok, true, "the project's own store is healthy and reports cleanly despite the sibling config failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Codex round-4 pins (2026-08-26), fixer landing in parallel. Same S4-ALL
// idiom/seams.

test('S4-ALL-10a [--all-stores]: an EXPLICIT --roots path that does not exist exits NONZERO, naming that root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-rootmissing-'));
  try {
    const missingRoot = join(dir, 'does-not-exist-root');
    assert.equal(existsSync(missingRoot), false, 'precondition: genuinely absent');

    const registryDb = makeRegistry(dir, []); // no registered projects, no legacy anywhere

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', missingRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });
    assert.notEqual(
      code,
      0,
      'an EXPLICITLY-given but nonexistent --roots path is a hard, loud failure — the caller asserted this exact root (contrast: S4-ALL-10b below)'
    );

    const combined = stdout + stderr;
    assert.match(combined, new RegExp(reEscape(missingRoot)), 'the failure names the exact --roots path that was given but does not exist');

    const results = parseJsonLines(stdout);
    const failureLine = results.find((r) => (r.skipped === true || r.ok === false) && JSON.stringify(r).includes(missingRoot));
    assert.ok(failureLine, `a skipped:true/failure line names the missing --roots path; results were: ${JSON.stringify(results)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// CONTRAST ARM, same pin: an implicit/default domains root that is simply
// absent (no --roots flag at all) is BENIGN, unlike S4-ALL-10a's EXPLICIT
// assertion. Without this contrast, "a missing root fails" would be equally
// explainable by "any absent root always fails" — which is not the intent;
// only a caller-asserted, explicit root that turns out missing is an error.
//
// ELEVATED NAMED RISK for this specific arm (beyond the group's standing
// header note): it deliberately omits --roots to exercise the runner's OWN
// default-root resolution. HOME is overridden below as the only available
// defense; if the real default resolution ALSO consults a path independent
// of HOME (e.g. a hardcoded WSL-mirror fallback — the shape
// scripts/domain-doctor.mjs's OWN default uses per its article:
// homedir()/.sterling/domains PLUS /mnt/c/Users/<user>/.sterling/domains
// under WSL), this arm could reach REAL domain stores on a machine that has
// them — which describes this repo's own dev machine. VERIFY the
// default-root resolution is fully HOME-scoped (or add a matching isolation
// seam) before trusting this arm to run safely on a machine with live
// Sterling projects.
test('S4-ALL-10b [--all-stores] CONTRAST: no --roots flag at all, with a simply-absent default domains root, stays exit 0 (benign) — proves it is the EXPLICIT assertion that fails, not mere absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-rootdefault-'));
  try {
    const registryDb = makeRegistry(dir, []); // no registered projects either — isolates this to the roots question alone
    const fakeHome = join(dir, 'fake-home-never-created');
    assert.equal(existsSync(fakeHome), false, 'precondition: the fake HOME (and therefore its default domains dir) does not exist');

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores'], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: fakeHome,
    });
    assert.equal(code, 0, `a simply-absent DEFAULT domains root (no --roots given) must be benign — zero domain stores found is not a failure: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-ALL-11a [--all-stores]: a project config with stack_tags as a STRING (schema-invalid, not an array) still enumerates its own store ok, and a LATER-registered second project is unaffected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-badstacktags-'));
  try {
    const p1Dir = join(dir, 'proj1-badtags');
    mkdirSync(join(p1Dir, '.sterling'), { recursive: true });
    const p1Db = join(p1Dir, '.sterling', 'sterling.db');
    new SterlingStore(p1Db).close();
    writeFileSync(join(p1Dir, '.sterling', 'config.json'), JSON.stringify({ stack_tags: 'foo' })); // schema-invalid: string, not array

    const p2Dir = join(dir, 'proj2-healthy');
    mkdirSync(join(p2Dir, '.sterling'), { recursive: true });
    const p2Db = join(p2Dir, '.sterling', 'sterling.db');
    new SterlingStore(p2Db).close();

    const domainsRoot = join(dir, 'domains');
    mkdirSync(domainsRoot, { recursive: true }); // empty

    const registryDb = makeRegistry(dir, [
      { repo_path: p1Dir, name: 'proj1-badtags' },
      { repo_path: p2Dir, name: 'proj2-healthy' },
    ]);

    const { stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });

    const results = parseJsonLines(stdout);
    const byDb = Object.fromEntries(results.map((r) => [r.db, r]));

    assert.ok(byDb[p1Db], `proj1's own store still gets a result line despite its malformed stack_tags: ${stderr}`);
    assert.equal(byDb[p1Db].ok, true, "proj1's own store enumerates ok — a schema-invalid stack_tags value must not block the project's DEFAULT store");

    assert.ok(byDb[p2Db], 'a LATER-registered second project is unaffected — proves per-project catch, not a whole-loop abort');
    assert.equal(byDb[p2Db].ok, true, "proj2's store enumerates cleanly");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S4-ALL-11b [--all-stores]: a project config with a domain_paths value that is NOT a string (123, truthy) is skipped:true naming the project, counted as failed, and a LATER-registered second project is unaffected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-all-baddomainpath-'));
  try {
    const p1Dir = join(dir, 'proj1-badmount');
    mkdirSync(join(p1Dir, '.sterling'), { recursive: true });
    const p1Db = join(p1Dir, '.sterling', 'sterling.db');
    new SterlingStore(p1Db).close();
    writeFileSync(
      join(p1Dir, '.sterling', 'config.json'),
      JSON.stringify({ stack_tags: ['x'], domain_paths: { x: 123 } }) // schema-invalid: truthy non-string mount value
    );

    const p2Dir = join(dir, 'proj2-healthy');
    mkdirSync(join(p2Dir, '.sterling'), { recursive: true });
    const p2Db = join(p2Dir, '.sterling', 'sterling.db');
    new SterlingStore(p2Db).close();

    const domainsRoot = join(dir, 'domains');
    mkdirSync(domainsRoot, { recursive: true });

    const registryDb = makeRegistry(dir, [
      { repo_path: p1Dir, name: 'proj1-badmount' },
      { repo_path: p2Dir, name: 'proj2-healthy' },
    ]);

    const { code, stdout, stderr } = runMigrateEnv(['--all-stores', '--roots', domainsRoot], {
      STERLING_REGISTRY_DB: registryDb,
      HOME: join(dir, 'fake-home'),
    });
    assert.notEqual(code, 0, 'a schema-invalid domain_paths value is a genuine failure that must be counted, not swallowed');

    const results = parseJsonLines(stdout);
    const skippedLine = results.find((r) => r.skipped === true && JSON.stringify(r).includes(p1Dir));
    assert.ok(skippedLine, `a skipped:true line names the project with the invalid domain_paths value; results were: ${JSON.stringify(results)}`);

    const byDb = Object.fromEntries(results.map((r) => [r.db, r]));
    assert.ok(byDb[p2Db], `a LATER-registered second project is unaffected — per-project catch, not a whole-loop abort: ${stderr}`);
    assert.equal(byDb[p2Db].ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
