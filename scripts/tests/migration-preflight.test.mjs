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

/** Introspects record_links' real columns at runtime rather than guessing the
 *  schema — fills any NOT NULL column without a default with a sane
 *  placeholder so the dangling-link fixture works regardless of exact shape. */
function insertDanglingLink(store, sourceId, missingTargetId, rel = 'cites') {
  const cols = store.db.prepare("PRAGMA table_info('record_links')").all();
  const pkCount = cols.filter((c) => c.pk).length;
  const values = {};
  for (const c of cols) {
    // Only a single-column pk is a rowid alias sqlite can assign; every
    // column of a composite pk (source_id, rel, target_id) still needs a value.
    if (c.pk && pkCount === 1) continue;
    if (c.name === 'source_id') { values[c.name] = sourceId; continue; }
    if (c.name === 'target_id') { values[c.name] = missingTargetId; continue; }
    if (/rel/i.test(c.name)) { values[c.name] = rel; continue; }
    if (c.notnull && c.dflt_value == null) {
      if (/(at|date|time)$/i.test(c.name)) values[c.name] = NOW;
      else if (/id$/i.test(c.name)) values[c.name] = randomUUID();
      else values[c.name] = '';
    }
  }
  const names = Object.keys(values);
  const placeholders = names.map(() => '?').join(', ');
  store.db.prepare(`INSERT INTO record_links (${names.join(', ')}) VALUES (${placeholders})`).run(...names.map((n) => values[n]));
}

/** Builds the exact B1 fixture: a 3-node supersede() chain (A->B->C), one
 *  retireInFavorOf duplicate (D->E, no supersedes link), one record (F)
 *  carrying a links[] entry at a never-created id, and two ids engineered to
 *  share an 8-char prefix (A and D) to exercise the collision counter. */
function buildB1Fixture(path) {
  const store = new SterlingStore(path);
  const idA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const idD = 'aaaaaaaa-2222-4222-8222-222222222222';

  const a = store.create(decision({ id: idA, title: 'A' }));
  const b = store.supersede(a.id, decision({ title: 'B' }));
  const c = store.supersede(b.id, decision({ title: 'C' }));

  const d = store.create(decision({ id: idD, title: 'D (duplicate)' }));
  const e = store.create(decision({ title: 'E (survivor)' }));
  store.retireInFavorOf(d.id, e.id, NOW);

  const f = store.create(decision({ title: 'F (dangling link source)' }));
  const missingTargetId = randomUUID();
  insertDanglingLink(store, f.id, missingTargetId);

  store.close();
  return { idA, idB: b.id, idC: c.id, idD, idE: e.id, idF: f.id, missingTargetId };
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
