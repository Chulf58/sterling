// The store move (store-move.ts): issue Chulf58/sterling#26 items 6 and 8,
// decisions postgres-importer-write-fence-batched-copy-shared-domains-fork and
// store-move-skill-two-way-one-direction-at-a-time-no-live-sync.
//
// The SQLite-only tests run everywhere. The Postgres tests need
// STERLING_TEST_PG=1 and skip by name without it; they work under one
// sterling_test_<random> prefix that is dropped when the file finishes.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore, ensurePgLayout, PgDriver, PgLockTimeoutError, type PgBridge } from '../index.js';
import {
  MOVE_BRIDGE_WAIT_MS,
  MOVE_FENCE_KEY,
  MoveIdCollisionError,
  MoveIdentityMissingError,
  MoveCredentialsError,
  MoveConfigMissingError,
  MoveModeError,
  MoveNulCharacterError,
  MoveSourceFencedError,
  MoveTargetNotEmptyError,
  MoveVerificationError,
  assertNoInternalCollision,
  buildManifest,
  diffManifests,
  exportStore,
  importStore,
  inPgMoveTransaction,
  latestPgReceipt,
  planMove,
  readPgFence,
  readSqliteFence,
  readSqliteReceipt,
  snapshotPgStore,
  snapshotSqliteStore,
  readProjectStorage,
  writeProjectStorage,
  MoveStorageSettingError,
  MoveConfigInvalidError,
  writeSqliteFence,
  type StoreSnapshot,
} from '../store-move.js';
import { PG_SKIP, dropTestSchemas, newTestPrefix, openTestBridge } from './pg-test-support.js';
import { decision, openSqliteStore, seedStore } from './store-move-fixture.js';

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sterling-store-move-'));
  temps.push(d);
  return d;
}
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const digestOf = (snap: StoreSnapshot) => buildManifest(snap).manifest.digest;

// ---------------------------------------------------------------------------
// SQLite-only
// ---------------------------------------------------------------------------

test('manifest: the same content read as numbers or as decimal strings (SQLite vs Postgres int8) gives one digest, in any row order', () => {
  const asSqlite: StoreSnapshot = new Map([['activity_log', [[1n, 'a', 'created', 'decision', 'r1', 't'], [2n, 'b', 'created', 'decision', 'r2', 'u']]]]);
  const asPgReversed: StoreSnapshot = new Map([['activity_log', [[BigInt('2'), 'b', 'created', 'decision', 'r2', 'u'], [BigInt('1'), 'a', 'created', 'decision', 'r1', 't']]]]);
  assert.equal(digestOf(asSqlite), digestOf(asPgReversed));
  const changed: StoreSnapshot = new Map([['activity_log', [[1n, 'a', 'created', 'decision', 'r1', 't'], [2n, 'b', 'created', 'decision', 'r2', 'v']]]]);
  assert.notEqual(digestOf(asSqlite), digestOf(changed));
});

test('manifest: a satellite-table divergence is named while the records table matches', () => {
  const dir = tempDir();
  const path = join(dir, 'a.db');
  seedStore(path, { label: 'sat' });
  const before = buildManifest(snapshotSqliteStore(path));
  const raw = new DatabaseSync(path);
  try {
    raw.prepare("UPDATE record_file_keys SET path = 'src/elsewhere.ts' WHERE rowid = (SELECT min(rowid) FROM record_file_keys)").run();
    raw.prepare("INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, 'x', 1, 'now')").run(randomUUID());
  } finally {
    raw.close();
  }
  const afterDetail = buildManifest(snapshotSqliteStore(path));
  assert.equal(afterDetail.manifest.tables.records.digest, before.manifest.tables.records.digest, 'records alone cannot see it');
  const diffs = diffManifests(before, afterDetail);
  assert.deepEqual(diffs.map((d) => d.table).sort(), ['record_aliases', 'record_file_keys']);
  const fk = diffs.find((d) => d.table === 'record_file_keys')!;
  assert.equal(fk.missing.length, 1);
  assert.equal(fk.extra.length, 1);
  assert.equal(diffs.find((d) => d.table === 'record_aliases')!.extra.length, 1);
});

test('collision: an id that is both a record and an alias in the source is refused by name', () => {
  const dir = tempDir();
  const path = join(dir, 'a.db');
  const seeded = seedStore(path, { label: 'coll' });
  const raw = new DatabaseSync(path);
  try {
    raw.prepare("INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, 'other', 1, 'now')").run(seeded.ids[0]);
  } finally {
    raw.close();
  }
  assert.throws(() => assertNoInternalCollision(snapshotSqliteStore(path), 'fixture'), (e: unknown) => e instanceof MoveIdCollisionError && (e as Error).message.includes(seeded.ids[0]));
});

test('fence: written under the write lock, read back, excluded from the manifest, and the snapshot never touches the live file', () => {
  const dir = tempDir();
  const path = join(dir, 'a.db');
  seedStore(path, { label: 'fence' });
  const digestBefore = digestOf(snapshotSqliteStore(path));
  assert.equal(readSqliteFence(path), null);
  const fence = { move_id: randomUUID(), to: 'postgres:sterling_test_x', fenced_at: '2026-10-06T09:00:00.000Z', manifest_digest: null };
  writeSqliteFence(path, fence);
  assert.deepEqual(readSqliteFence(path), fence);
  assert.equal(digestOf(snapshotSqliteStore(path)), digestBefore, 'the fence row is not content');
});

test('snapshot of a hot WAL store: sees a committed row the main file lacks, and leaves the main file and -wal bytes unchanged', () => {
  const dir = tempDir();
  const path = join(dir, 'hot.db');
  seedStore(path, { label: 'hot' });
  const writer = new DatabaseSync(path);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    const id = randomUUID();
    writer.prepare("INSERT INTO store_meta (key, value, updated_at) VALUES ('hot', ?, 'now')").run(id);
    assert.ok(existsSync(`${path}-wal`), 'the WAL holds the uncheckpointed row');
    const mainBefore = readFileSync(path);
    const walBefore = readFileSync(`${path}-wal`);
    const snap = snapshotSqliteStore(path);
    assert.ok((snap.get('store_meta') ?? []).some((r) => r[1] === id), 'the snapshot holds the committed row');
    assert.deepEqual(readFileSync(path), mainBefore, 'main file bytes unchanged');
    assert.deepEqual(readFileSync(`${path}-wal`), walBefore, '-wal bytes unchanged');
    assert.ok(existsSync(`${path}-shm`), 'the writer-owned -shm is left in place');
  } finally {
    writer.close();
  }
});

function fakeCredentials(dir: string): string {
  const p = join(dir, 'served.json');
  writeFileSync(p, JSON.stringify({ host: 'localhost', port: 5432, database: 'x', user: 'x', password: 'x', connect_timeout_ms: 1000 }));
  chmodSync(p, 0o600);
  return p;
}

function project(dir: string, opts: { mode?: string; id?: boolean; stack?: string[]; domainPaths?: Record<string, string>; storage?: string }): string {
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const cfg = { mode: opts.mode ?? 'work', stack_tags: opts.stack ?? [], domain_paths: opts.domainPaths ?? {}, kept: 'yes', ...(opts.storage ? { storage: opts.storage } : {}) };
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(cfg, null, 2));
  if (opts.id !== false) writeFileSync(join(dir, '.sterling', 'project.json'), JSON.stringify({ project_id: randomUUID() }));
  return dir;
}

test('planMove: refuses by name with no config, in a hobby project, with no identity, and with unreadable credentials', () => {
  const base = tempDir();
  const creds = fakeCredentials(base);
  const none = join(base, 'none');
  mkdirSync(none);
  assert.throws(() => planMove({ root: none, direction: 'to_postgres', registeredProjects: [], credentialsPath: creds }), MoveConfigMissingError);
  const hobby = project(join(base, 'hobby'), { mode: 'hobby' });
  assert.throws(() => planMove({ root: hobby, direction: 'to_postgres', registeredProjects: [], credentialsPath: creds }), (e: unknown) => e instanceof MoveModeError && (e as Error).message.includes('hobby project'));
  assert.equal(planMove({ root: hobby, direction: 'to_sqlite', registeredProjects: [], credentialsPath: creds }).mode, 'hobby', 'moving back needs no mode: it is the way out for a postgres store in a hobby project');
  const anon = project(join(base, 'anon'), { id: false });
  assert.throws(() => planMove({ root: anon, direction: 'to_postgres', registeredProjects: [], credentialsPath: creds }), MoveIdentityMissingError);
  const work = project(join(base, 'work'), {});
  assert.throws(() => planMove({ root: work, direction: 'to_postgres', registeredProjects: [], credentialsPath: join(base, 'missing.json') }), MoveCredentialsError);
  const odd = project(join(base, 'odd'), { storage: 'mysql' });
  // The config schema or the move's own reader refuses it; either way by a named MoveError that names the key.
  assert.throws(
    () => planMove({ root: odd, direction: 'to_postgres', registeredProjects: [], credentialsPath: creds }),
    (e: unknown) => (e instanceof MoveStorageSettingError || e instanceof MoveConfigInvalidError) && (e as Error).message.includes('storage'),
  );
});

test('planMove: a domain a hobby project also mounts is planned unfenced and names that project; a work project sharing it does not fork it', () => {
  const base = tempDir();
  const creds = fakeCredentials(base);
  const shared = join(base, 'domains', 'shared.db');
  const own = join(base, 'domains', 'own.db');
  const work = project(join(base, 'work'), { stack: ['shared', 'own'], domainPaths: { shared, own } });
  const hobby = project(join(base, 'hobby'), { mode: 'hobby', stack: ['shared'], domainPaths: { shared } });
  const otherWork = project(join(base, 'work2'), { stack: ['own'], domainPaths: { own } });
  const plan = planMove({ root: work, direction: 'to_postgres', registeredProjects: [work, hobby, otherWork, join(base, 'gone')], credentialsPath: creds });
  assert.deepEqual(plan.stores.map((s) => [s.identity.kind, s.identity.kind === 'domain' ? s.identity.name : 'p', s.fenceSource]), [['project', 'p', true], ['domain', 'shared', false], ['domain', 'own', true]]);
  assert.deepEqual(plan.stores[1].sharedWith, [{ root: hobby, mode: 'hobby' }]);
  assert.deepEqual(plan.skippedProjects, [join(base, 'gone')]);
  const back = planMove({ root: work, direction: 'to_sqlite', registeredProjects: [work, hobby, otherWork], credentialsPath: creds });
  assert.deepEqual(back.stores.map((s) => s.fenceSource), [true, true, false], 'exporting: the Postgres domain another work project mounts stays live');
  assert.deepEqual(back.stores[2].sharedWith, [{ root: otherWork, mode: 'work' }]);
});

test('writeProjectStorage: switches config.storage, keeps config.mode and every other key; absent reads as sqlite', () => {
  const dir = project(tempDir(), {});
  const cfgPath = join(dir, '.sterling', 'config.json');
  assert.equal(readProjectStorage(dir), 'sqlite');
  assert.equal(writeProjectStorage(dir, 'sqlite'), false, 'absent already means sqlite: nothing written');
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).storage, undefined);
  assert.equal(writeProjectStorage(dir, 'postgres'), true);
  let cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.deepEqual([cfg.storage, cfg.mode, cfg.kept], ['postgres', 'work', 'yes']);
  assert.equal(writeProjectStorage(dir, 'postgres'), false);
  assert.equal(writeProjectStorage(dir, 'sqlite'), true);
  cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.deepEqual([cfg.storage, cfg.mode], ['sqlite', 'work']);
});

// ---------------------------------------------------------------------------
// Postgres (STERLING_TEST_PG=1)
// ---------------------------------------------------------------------------

let pg: { bridge: PgBridge; prefix: string; meta: string; n: number } | undefined;
function live() {
  if (pg === undefined) {
    const bridge = openTestBridge({ waitTimeoutMs: MOVE_BRIDGE_WAIT_MS });
    const prefix = newTestPrefix();
    const meta = `${prefix}_meta`;
    ensurePgLayout(bridge, meta);
    pg = { bridge, prefix, meta, n: 0 };
  }
  return pg;
}
after(() => {
  if (pg && !pg.bridge.closed) {
    try {
      dropTestSchemas(pg.bridge, pg.prefix);
    } finally {
      pg.bridge.close();
    }
  }
});

function nextSchema(): string {
  const p = live();
  return `${p.prefix}_s${++p.n}`;
}

const pgOpts = () => ({ bridge: live().bridge, metaSchema: live().meta });

test('round trip SQLite -> Postgres -> SQLite: identical id sets and content hashes, the side left is fenced each way, a body NUL survives', { skip: PG_SKIP }, () => {
  const dir = tempDir();
  const path = join(dir, 'project.db');
  const seeded = seedStore(path, { label: 'trip', nulInBody: true });
  const original = buildManifest(snapshotSqliteStore(path));
  const schema = nextSchema();
  const identity = { kind: 'project' as const, name: 'trip' };

  const imported = importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true });
  assert.equal(imported.outcome, 'copied');
  assert.equal(imported.hash_match, true);
  assert.ok(imported.tables.record_versions.rows > 0 && imported.tables.record_aliases.rows > 0 && imported.tables.queue_drain_log.rows > 0 && imported.tables.record_relations.rows > 0);
  const onPg = buildManifest(snapshotPgStore(live().bridge, schema));
  assert.deepEqual(diffManifests(original, onPg), []);
  assert.equal(onPg.manifest.digest, original.manifest.digest);
  const sqliteFence = readSqliteFence(path);
  assert.equal(sqliteFence?.to, `postgres:${schema}`, 'the SQLite side left is fenced toward its counterpart');
  assert.equal(sqliteFence?.manifest_digest, original.manifest.digest);
  assert.equal(readPgFence(live().bridge, schema), null);
  assert.equal(latestPgReceipt(live().bridge, live().meta, schema)?.source_digest, original.manifest.digest);

  // The store reads the copy through its own driver: search works and the NUL is intact.
  const onPgStore = new SterlingStore(`postgres:${schema}`, { driver: new PgDriver(live().bridge, { schema, metaSchema: live().meta }) });
  try {
    assert.equal((onPgStore.get(seeded.nulId!) as { statement: string }).statement, 'before\u0000after', 'the NUL survived into Postgres');
    assert.ok(onPgStore.query({ rank_terms: ['revised'] }).length > 0, 'search text was rebuilt on Postgres');
  } finally {
    onPgStore.close();
  }

  // Back to the SAME file: it is the untouched copy the import left, so it is replaced.
  const exported = exportStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true });
  assert.equal(exported.outcome, 'replaced');
  assert.equal(digestOf(snapshotSqliteStore(path)), original.manifest.digest);
  assert.equal(readSqliteFence(path), null, 'the SQLite side is live again');
  assert.equal(readPgFence(live().bridge, schema)?.to, `sqlite:${path}`, 'the Postgres side left is fenced');
  assert.equal(readSqliteReceipt(path)?.move_id, exported.move_id);

  // A Postgres side fenced toward this file refuses an export anywhere else.
  const fresh = join(dir, 'fresh', 'sterling.db');
  assert.throws(() => exportStore({ ...pgOpts(), schema, sqlitePath: fresh, identity, fenceSource: true }), MoveSourceFencedError);
  assert.equal(existsSync(fresh), false, 'the refusal created nothing');
  const reopened = openSqliteStore(path);
  try {
    assert.equal((reopened.get(seeded.nulId!) as { statement: string }).statement, 'before\u0000after', 'the NUL survived both directions');
    assert.ok(reopened.query({ rank_terms: ['revised'] }).length > 0, 'search text was rebuilt');
  } finally {
    reopened.close();
  }
});

test('replay: a second import with the same source manifest changes nothing and writes no second receipt', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'p.db');
  seedStore(path, { label: 'replay' });
  const schema = nextSchema();
  const identity = { kind: 'domain' as const, name: 'replay' };
  const first = importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true });
  const digest = digestOf(snapshotPgStore(live().bridge, schema));
  const receipts = () => Number(live().bridge.query(`SELECT count(*)::int AS n FROM "${live().meta}".move_receipts WHERE target_schema = $1`, [schema]).rows[0].n);
  assert.equal(receipts(), 1);
  const second = importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true });
  assert.equal(second.outcome, 'replayed');
  assert.equal(second.move_id, first.move_id, 'the re-run continues the fenced move');
  assert.equal(second.pg_statements, 0);
  assert.equal(digestOf(snapshotPgStore(live().bridge, schema)), digest);
  assert.equal(receipts(), 1);
});

test('a non-empty foreign target is refused by name, and the refusal fences nothing', { skip: PG_SKIP }, () => {
  const dir = tempDir();
  const foreign = join(dir, 'foreign.db');
  seedStore(foreign, { label: 'foreign' });
  const schema = nextSchema();
  importStore({ ...pgOpts(), schema, sqlitePath: foreign, identity: { kind: 'domain', name: 'foreign' }, fenceSource: true });
  const path = join(dir, 'mine.db');
  seedStore(path, { label: 'mine' });
  assert.throws(() => importStore({ ...pgOpts(), schema, sqlitePath: path, identity: { kind: 'domain', name: 'mine' }, fenceSource: true }), (e: unknown) => e instanceof MoveTargetNotEmptyError && (e as Error).message.includes('not empty'));
  assert.equal(readSqliteFence(path), null, 'the source was not fenced');
  // The other way: a non-empty SQLite file that is no move's copy.
  const exportSchema = nextSchema();
  const src = join(dir, 'src.db');
  seedStore(src, { label: 'src' });
  importStore({ ...pgOpts(), schema: exportSchema, sqlitePath: src, identity: { kind: 'domain', name: 'src' }, fenceSource: true });
  assert.throws(() => exportStore({ ...pgOpts(), schema: exportSchema, sqlitePath: path, identity: { kind: 'domain', name: 'src' }, fenceSource: true }), MoveTargetNotEmptyError);
  assert.equal(readPgFence(live().bridge, exportSchema), null, 'the Postgres source was not fenced');
});

test('a collision in records or record_aliases between source and target is refused by name', { skip: PG_SKIP }, () => {
  const dir = tempDir();
  const path = join(dir, 'src.db');
  const seeded = seedStore(path, { label: 'clash' });
  // Target 1: a different store whose alias historical_id is one of the source's record ids.
  const t1 = join(dir, 't1.db');
  seedStore(t1, { label: 't1' });
  let raw = new DatabaseSync(t1);
  raw.prepare("INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, 'x', 1, 'now')").run(seeded.ids[2]);
  raw.close();
  const s1 = nextSchema();
  importStore({ ...pgOpts(), schema: s1, sqlitePath: t1, identity: { kind: 'domain', name: 't1' }, fenceSource: false });
  assert.throws(() => importStore({ ...pgOpts(), schema: s1, sqlitePath: path, identity: { kind: 'domain', name: 'clash' }, fenceSource: true }), (e: unknown) => e instanceof MoveIdCollisionError && (e as Error).message.includes(seeded.ids[2]));
  // Target 2: a store holding a record under one of the source's ids.
  const t2 = join(dir, 't2.db');
  const store = openSqliteStore(t2);
  store.create(decision({ id: seeded.ids[0], title: 'same id, other meaning' }));
  store.close();
  const s2 = nextSchema();
  importStore({ ...pgOpts(), schema: s2, sqlitePath: t2, identity: { kind: 'domain', name: 't2' }, fenceSource: false });
  assert.throws(() => importStore({ ...pgOpts(), schema: s2, sqlitePath: path, identity: { kind: 'domain', name: 'clash' }, fenceSource: true }), (e: unknown) => e instanceof MoveIdCollisionError && (e as Error).message.includes(seeded.ids[0]));
  assert.equal(readSqliteFence(path), null);
});

test('verification: a satellite row lost during the copy is detected, named, and nothing is committed', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'p.db');
  seedStore(path, { label: 'verify' });
  const schema = nextSchema();
  assert.throws(
    () =>
      importStore({
        ...pgOpts(),
        schema,
        sqlitePath: path,
        identity: { kind: 'domain', name: 'verify' },
        fenceSource: true,
        hooks: { beforeVerify: ({ bridge, schema: s }) => void bridge!.query(`DELETE FROM "${s}".record_stack_tags WHERE ctid = (SELECT min(ctid) FROM "${s}".record_stack_tags)`) },
      }),
    (e: unknown) => e instanceof MoveVerificationError && (e as Error).message.includes('record_stack_tags'),
  );
  assert.equal(Number(live().bridge.query(`SELECT count(*)::int AS n FROM "${schema}".records`).rows[0].n), 0, 'rolled back');
  assert.equal(latestPgReceipt(live().bridge, live().meta, schema), null, 'no receipt');
  assert.ok(readSqliteFence(path) !== null, 'the source stays fenced after a failed copy, so it never silently reopens');
  // A re-run without the fault completes the same move.
  const rerun = importStore({ ...pgOpts(), schema, sqlitePath: path, identity: { kind: 'domain', name: 'verify' }, fenceSource: true });
  assert.equal(rerun.outcome, 'copied');
  assert.equal(rerun.move_id, readSqliteFence(path)!.move_id);
});

test('an abandoned copy that changed after its fence is refused, not replaced', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'p.db');
  seedStore(path, { label: 'changed' });
  const schema = nextSchema();
  importStore({ ...pgOpts(), schema, sqlitePath: path, identity: { kind: 'domain', name: 'changed' }, fenceSource: true });
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE record_file_keys SET path = 'src/late-write.ts' WHERE rowid = (SELECT min(rowid) FROM record_file_keys)").run();
  raw.close();
  assert.throws(() => exportStore({ ...pgOpts(), schema, sqlitePath: path, identity: { kind: 'domain', name: 'changed' }, fenceSource: true }), (e: unknown) => e instanceof MoveTargetNotEmptyError && (e as Error).message.includes('changed after the fence'));
});

test('a source fenced toward another counterpart is refused by name', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'p.db');
  seedStore(path, { label: 'elsewhere' });
  writeSqliteFence(path, { move_id: randomUUID(), to: 'postgres:sterling_test_somewhere_else', fenced_at: 'then', manifest_digest: null });
  assert.throws(() => importStore({ ...pgOpts(), schema: nextSchema(), sqlitePath: path, identity: { kind: 'domain', name: 'x' }, fenceSource: true }), MoveSourceFencedError);
});

test('a NUL in a column outside the JSON body is refused by name before anything is fenced', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'p.db');
  seedStore(path, { label: 'nulcol' });
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE store_meta SET value = ? WHERE key = 'description'").run('bad\u0000value');
  raw.close();
  assert.throws(() => importStore({ ...pgOpts(), schema: nextSchema(), sqlitePath: path, identity: { kind: 'domain', name: 'nulcol' }, fenceSource: true }), (e: unknown) => e instanceof MoveNulCharacterError && (e as Error).message.includes('store_meta.value'));
  assert.throws(() => snapshotSqliteStore(path), MoveNulCharacterError, 'every SQLite read refuses it rather than cut the value short');
  assert.equal(readSqliteFence(path), null);
});

test('a forked shared domain is copied, left unfenced, and a later run does not copy it again', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'shared.db');
  seedStore(path, { label: 'fork' });
  const schema = nextSchema();
  const first = importStore({ ...pgOpts(), schema, sqlitePath: path, identity: { kind: 'domain', name: 'fork' }, fenceSource: false });
  assert.equal(first.outcome, 'copied');
  assert.equal(first.source_fenced, false);
  assert.equal(readSqliteFence(path), null, 'the SQLite copy stays writable for hobby projects');
  // The hobby side writes; the copies diverge.
  const store = openSqliteStore(path);
  store.create(decision({ title: 'written by a hobby project after the fork' }));
  store.close();
  const again = importStore({ ...pgOpts(), schema, sqlitePath: path, identity: { kind: 'domain', name: 'fork' }, fenceSource: false });
  assert.equal(again.outcome, 'fork_already_copied');
  assert.equal(again.hash_match, false);
});

test('lock parity: a move transaction holds the same store lock a PgDriver writer takes', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'p.db');
  seedStore(path, { label: 'lock' });
  const schema = nextSchema();
  importStore({ ...pgOpts(), schema, sqlitePath: path, identity: { kind: 'domain', name: 'lock' }, fenceSource: true });
  const other = openTestBridge();
  try {
    const writer = new PgDriver(other, { schema, metaSchema: live().meta, lockTimeoutMs: 300 });
    inPgMoveTransaction(live().bridge, live().meta, schema, {}, () => {
      assert.throws(() => writer.begin(), PgLockTimeoutError);
    });
    writer.begin();
    writer.rollback();
  } finally {
    other.close();
  }
});

test('the fence key is a plain store_meta row, so SterlingStore can check it after begin()', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'p.db');
  seedStore(path, { label: 'fencerow' });
  const schema = nextSchema();
  importStore({ ...pgOpts(), schema, sqlitePath: path, identity: { kind: 'domain', name: 'fencerow' }, fenceSource: true });
  exportStore({ ...pgOpts(), schema, sqlitePath: join(tempDir(), 'out.db'), identity: { kind: 'domain', name: 'fencerow' }, fenceSource: true });
  const row = live().bridge.query(`SELECT value FROM "${schema}".store_meta WHERE key = $1`, [MOVE_FENCE_KEY]).rows[0];
  assert.ok(row && JSON.parse(String(row.value)).move_id);
});
