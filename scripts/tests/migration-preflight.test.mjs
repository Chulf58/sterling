// ---------------------------------------------------------------------------
// PIN GROUP B — migration preflight report (stable-identity wave S1,
// decision stable-identity-design-v2 / 2176748e, board dee719dd). SPEC-ONLY:
// scripts/migration-preflight.mjs DOES NOT EXIST YET. Every test below
// spawns it as a child process; until the file exists, node itself refuses
// to run it (a MODULE_NOT_FOUND-shaped failure printed to stderr, non-zero
// exit, empty stdout) — so every assertion on `code`/`stdout` below fails on
// its own AssertionError (an exit-code mismatch or a JSON.parse on an empty
// string), never a bare test-runner crash, because every test wraps the
// child-process call and asserts on its OWN result rather than throwing
// through an unguarded require/import.
//
// CLI + JSON CONTRACT AUTHORED HERE (none was declared upstream — the brief
// gave the required FIELDS, not the invocation shape or field names; per the
// test-writer mandate this file is the oracle for that shape, and the coder
// implements against it):
//
//   node scripts/migration-preflight.mjs --db <path-to-sterling.db>
//
//   stdout (on success) is a single JSON object:
//     {
//       superseded_by_type: { <recordType>: <count>, ... },
//       chains: { count: <n>, max_depth: <n>, depth_distribution: { "<depth>": <n>, ... } },
//       links_targeting_superseded: <n>,
//       links_targeting_missing: <n>,
//       historical_id_count: <n>,
//       prefix_collisions: <n>,
//     }
//   or, when the store is already past the migrated schema version:
//     { already_migrated: true, ... }  // additional fields are the coder's choice
//
// DEFINITIONS THIS ORACLE PINS (resolving spec ambiguity — flagged, not
// invented from nothing):
//   - "chain" = a run of records connected by the RECIPROCAL links[{rel:
//     'supersedes'}] edge that store.supersede() writes on the new record
//     pointing at the old one. A retireInFavorOf duplicate (superseded_by
//     set, but deliberately NO supersedes link — that absence is exactly
//     what distinguishes the fixture's duplicate case from its chain case)
//     is counted toward superseded_by_type / historical_id_count but is NOT
//     a chain and contributes no chain-depth entry.
//   - "depth" of a chain = the number of NODES in it (an A->B->C chain,
//     all three via supersede(), is depth 3 — matching the spec's own prose
//     "one supersession chain of depth 3 (A->B->C)").
//   - "links targeting superseded/missing" counts only links[] entries
//     (the record_links edges), never the plain superseded_by scalar
//     pointer written by retireInFavorOf/supersede — so the chain's own
//     supersedes edges (C->B, B->A) are exactly what populate
//     links_targeting_superseded (both targets are superseded), and the
//     duplicate's superseded_by (D->E) contributes nothing to either count.
//   - "historical (non-terminus) id" = an id whose record is itself
//     superseded and is NOT the terminus of its own lineage (i.e. every
//     superseded record). In the B1 fixture that is exactly {A, B, D}.
//   - "8-char prefix collision count" = the number of DISTINCT 8-char id
//     prefixes shared by 2 or more ids (current + historical), i.e. a
//     collision-GROUP count, not a pair count.
// ---------------------------------------------------------------------------
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'migration-preflight.mjs');
const NOW = '2026-08-22T12:00:00.000Z';

let SterlingStore;
let DatabaseSync;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ DatabaseSync } = await import('node:sqlite'));
});

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'migration-preflight-'));
  return { dir, path: join(dir, 'sterling.db') };
}

function envelope(type, over = {}) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    ...over,
  };
}

function decision(over = {}) {
  return {
    ...envelope('decision', over),
    title: over.title ?? 'a decision',
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
  };
}

// test-repair 2026-08-22: the fixture previously built its store through the
// LIVE SterlingStore, whose schema moved to v2 in the stable-identity S2 slice
// (record_links replaced by record_relations; supersede/retire now write
// relations) — insertDanglingLink's PRAGMA table_info('record_links') came
// back empty and produced invalid SQL (B1/B2 red at HEAD, pre-existing).
// Preflight's whole subject is a PRE-MIGRATION v1 store, so the fixture now
// builds the raw v1 shape directly (real v1 DDL from git 6f443e8, the same
// source the migration-runner fixture uses). [stable-identity-design-v2]
const V1_DDL = `
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
CREATE TABLE IF NOT EXISTS record_links (
  source_id TEXT NOT NULL,
  rel TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (source_id, rel, target_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(record_id UNINDEXED, text);
`;

function insertV1Record(db, rec) {
  db.prepare(
    'INSERT INTO records (id, type, status, superseded_by, scope, created_at, updated_at, author, derived_unconfirmed, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(rec.id, rec.type, rec.status, rec.superseded_by, rec.scope, rec.created_at, rec.updated_at, rec.author, JSON.stringify(rec));
  db.prepare('INSERT INTO records_fts (record_id, text) VALUES (?, ?)').run(rec.id, rec.title ?? '');
}

function insertV1Link(db, sourceId, rel, targetId) {
  db.prepare('INSERT INTO record_links (source_id, rel, target_id) VALUES (?, ?, ?)').run(sourceId, rel, targetId);
}

/** Builds the exact B1 fixture as a raw pre-migration v1 store: a 3-node
 *  legacy supersede chain (A->B->C, reciprocal record_links edges), one
 *  retire-shaped duplicate (D->E via superseded_by column, no supersedes
 *  link), one record (F) carrying a links[] entry at a never-created id, and
 *  two ids sharing an 8-char prefix (A and D) for the collision counter. */
function buildB1Fixture(path) {
  const db = new DatabaseSync(path);
  db.exec(V1_DDL);
  db.exec('PRAGMA user_version = 1');
  const idA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const idD = 'aaaaaaaa-2222-4222-8222-222222222222';
  const idB = randomUUID();
  const idC = randomUUID();
  const idE = randomUUID();
  const idF = randomUUID();
  const missingTargetId = randomUUID();

  insertV1Record(db, decision({ id: idC, title: 'C' }));
  insertV1Record(db, decision({ id: idB, title: 'B', status: 'superseded', superseded_by: idC }));
  insertV1Record(db, decision({ id: idA, title: 'A', status: 'superseded', superseded_by: idB }));
  insertV1Link(db, idB, 'supersedes', idA);
  insertV1Link(db, idC, 'supersedes', idB);

  insertV1Record(db, decision({ id: idE, title: 'E (survivor)' }));
  insertV1Record(db, decision({ id: idD, title: 'D (duplicate)', status: 'superseded', superseded_by: idE }));

  insertV1Record(db, decision({ id: idF, title: 'F (dangling link source)', links: [{ rel: 'cites', target_id: missingTargetId }] }));
  insertV1Link(db, idF, 'cites', missingTargetId);

  db.close();
  return { idA, idB, idC, idD, idE, idF, missingTargetId };
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('B1: the preflight report over the fixture matches every pinned field, count, and definition', () => {
  const { path } = tempDbPath();
  try {
    const fx = buildB1Fixture(path);
    const { code, stdout, stderr } = run(['--db', path]);
    assert.equal(code, 0, `preflight must exit 0 on a normal (not-yet-migrated) store: ${stderr}`);

    let report;
    assert.doesNotThrow(() => { report = JSON.parse(stdout); }, `stdout must be a single parseable JSON object: ${stdout}`);

    assert.deepEqual(
      report.superseded_by_type,
      { decision: 3 },
      'A, B (chain, non-terminus) and D (retired duplicate) are the three superseded decision rows; C/E/F stay active'
    );

    assert.equal(report.chains.count, 1, 'exactly one supersedes-linked chain exists (A->B->C) — the duplicate D->E is not a chain');
    assert.equal(report.chains.max_depth, 3, 'the chain has 3 nodes (A, B, C)');
    assert.deepEqual(report.chains.depth_distribution, { 3: 1 }, 'one chain observed, at depth 3');

    assert.equal(
      report.links_targeting_superseded,
      2,
      'the chain\'s own supersedes edges (C->B, B->A) both target a now-superseded id; the duplicate\'s superseded_by is not a links[] edge and contributes nothing'
    );
    assert.equal(report.links_targeting_missing, 1, 'exactly one links[] edge (F -> the never-created id) targets a missing record');

    assert.equal(report.historical_id_count, 3, 'A, B, D are superseded and are not the terminus of their own lineage (C and E are termini)');

    assert.equal(
      report.prefix_collisions,
      1,
      'A and D were engineered to share an 8-char id prefix — exactly one collision GROUP among all current+historical ids'
    );

    void fx;
  } finally {
    // temp dirs are process-scoped and not shared across tests — no
    // cross-test coupling; left for the OS/test-runner to reap.
  }
});

test('B2: the preflight run is READ-ONLY — the db file is byte-identical before and after', () => {
  const { path } = tempDbPath();
  buildB1Fixture(path);
  const before_ = fileHash(path);
  const { code, stderr } = run(['--db', path]);
  assert.equal(code, 0, `preflight must succeed on the fixture: ${stderr}`);
  const after = fileHash(path);
  assert.equal(after, before_, 'the report must never write to the db — identical byte hash before and after');
});

test('B3: a store already at or past the migrated schema version reports already_migrated, not a count', () => {
  const { path } = tempDbPath();
  // A normal, empty store — then force user_version to 2, simulating "the
  // stable-identity migration has already run" (post-migration marker),
  // per the spec's own instruction to "simulate 2".
  const seed = new SterlingStore(path);
  seed.close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 2');
  raw.close();

  const { code, stdout, stderr } = run(['--db', path]);
  assert.equal(code, 0, `an already-migrated store is a clean, non-error report: ${stderr}`);
  let report;
  assert.doesNotThrow(() => { report = JSON.parse(stdout); }, `stdout must still be parseable JSON: ${stdout}`);
  assert.equal(report.already_migrated, true, 'a store at/past the migrated version reports the already_migrated marker, not superseded/chain counts');
});

test('B4: a missing/unreadable db path fails loudly, naming the path, and exits non-zero', () => {
  const { dir } = tempDbPath();
  const missing = join(dir, 'does-not-exist.db');
  assert.equal(existsSync(missing), false, 'precondition: the path genuinely does not exist');

  const { code, stdout, stderr } = run(['--db', missing]);
  assert.notEqual(code, 0, 'a missing db path is a hard failure, never a clean exit');
  assert.match(stdout + stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the failure names the exact path that could not be read');
});
