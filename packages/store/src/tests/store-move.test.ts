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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  MoveForkUnconfirmedError,
  MoveRegistryProjectError,
  FORK_CONFIRM_FLAG,
  FORK_LOSS_LIST_CAP,
  forkLoss,
  describeForkLoss,
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
  writePgFence,
  MoveAttachError,
  attachProject,
  planAttach,
  type StoreSnapshot,
} from '../store-move.js';
import { PG_TEST_NAMESPACE_ENV, pgStoreNames, routedCredentialsPath } from '../routing.js';
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

test('planMove: a domain a hobby project also mounts is planned unfenced and names that project; a work project already on Postgres sharing it does not fork it', () => {
  const base = tempDir();
  const creds = fakeCredentials(base);
  const shared = join(base, 'domains', 'shared.db');
  const own = join(base, 'domains', 'own.db');
  const work = project(join(base, 'work'), { stack: ['shared', 'own'], domainPaths: { shared, own } });
  const hobby = project(join(base, 'hobby'), { mode: 'hobby', stack: ['shared'], domainPaths: { shared }, storage: 'sqlite' });
  const otherWork = project(join(base, 'work2'), { stack: ['own'], domainPaths: { own }, storage: 'postgres' });
  const plan = planMove({ root: work, direction: 'to_postgres', registeredProjects: [work, hobby, otherWork, join(base, 'gone')], credentialsPath: creds });
  assert.deepEqual(plan.stores.map((s) => [s.identity.kind, s.identity.kind === 'domain' ? s.identity.name : 'p', s.fenceSource]), [['project', 'p', true], ['domain', 'shared', false], ['domain', 'own', true]]);
  assert.deepEqual(plan.stores[1].sharedWith, [{ root: hobby, mode: 'hobby', storage: 'sqlite' }]);
  assert.deepEqual(plan.skippedProjects, [join(base, 'gone')]);
  assert.deepEqual(plan.unreadableProjects, []);
  const back = planMove({ root: work, direction: 'to_sqlite', registeredProjects: [work, hobby, otherWork], credentialsPath: creds });
  assert.deepEqual(back.stores.map((s) => s.fenceSource), [true, true, false], 'exporting: the Postgres domain another work project mounts stays live');
  assert.deepEqual(back.stores[2].sharedWith, [{ root: otherWork, mode: 'work', storage: 'postgres' }]);
});

// Decision shared-domains-stay-forked-and-loud-while-projects-move-one-at-a-time (board 6fcfd161):
// moving to Postgres fences a domain's SQLite file only when every project mounting it is on Postgres, by config.storage.
test('planMove --to pg: a work project still on SQLite that mounts the domain keeps it unfenced and is named', () => {
  const base = tempDir();
  const creds = fakeCredentials(base);
  const shared = join(base, 'domains', 'shared.db');
  const work = project(join(base, 'work'), { stack: ['shared'], domainPaths: { shared } });
  const stillSqlite = project(join(base, 'work-sqlite'), { stack: ['shared'], domainPaths: { shared } });
  const explicitSqlite = project(join(base, 'work-sqlite-2'), { stack: ['shared'], domainPaths: { shared }, storage: 'sqlite' });
  const plan = planMove({ root: work, direction: 'to_postgres', registeredProjects: [work, stillSqlite, explicitSqlite], credentialsPath: creds });
  assert.equal(plan.stores[1].fenceSource, false, 'its writes would otherwise fail with StoreMovedError');
  assert.deepEqual(plan.stores[1].sharedWith, [
    { root: stillSqlite, mode: 'work', storage: 'sqlite' },
    { root: explicitSqlite, mode: 'work', storage: 'sqlite' },
  ]);
});

test('planMove --to pg: a domain every mounting project holds on Postgres is fenced, whatever their mode', () => {
  const base = tempDir();
  const creds = fakeCredentials(base);
  const shared = join(base, 'domains', 'shared.db');
  const work = project(join(base, 'work'), { stack: ['shared'], domainPaths: { shared } });
  const moved = project(join(base, 'moved'), { stack: ['shared'], domainPaths: { shared }, storage: 'postgres' });
  const moved2 = project(join(base, 'moved2'), { stack: ['shared'], domainPaths: { shared }, storage: 'postgres' });
  const plan = planMove({ root: work, direction: 'to_postgres', registeredProjects: [work, moved, moved2], credentialsPath: creds });
  assert.equal(plan.stores[1].fenceSource, true);
  assert.deepEqual(plan.stores[1].sharedWith, []);
});

test('planMove --to pg: a registered project whose config cannot be read counts as on SQLite for every domain and is named; --to sqlite still refuses it', () => {
  const base = tempDir();
  const creds = fakeCredentials(base);
  const a = join(base, 'domains', 'a.db');
  const b = join(base, 'domains', 'b.db');
  const work = project(join(base, 'work'), { stack: ['a', 'b'], domainPaths: { a, b } });
  const broken = project(join(base, 'broken'), { stack: [] });
  writeFileSync(join(broken, '.sterling', 'config.json'), '{ not json');
  const oddStorage = project(join(base, 'odd'), { stack: [], storage: 'mysql' });
  const plan = planMove({ root: work, direction: 'to_postgres', registeredProjects: [work, broken, oddStorage], credentialsPath: creds });
  assert.deepEqual(plan.stores.map((s) => s.fenceSource), [true, false, false], 'the project store is fenced; no domain is, not even one the broken config may not mount');
  for (const s of plan.stores.slice(1)) {
    assert.deepEqual(s.sharedWith, [
      { root: broken, mode: null, storage: null },
      { root: oddStorage, mode: null, storage: null },
    ]);
  }
  assert.deepEqual(plan.unreadableProjects.map((u) => u.root), [broken, oddStorage]);
  assert.ok(plan.unreadableProjects.every((u) => u.reason.length > 0), 'each is named with its reason');
  assert.ok(plan.unreadableProjects[1].reason.includes('storage'), plan.unreadableProjects[1].reason);
  assert.throws(() => planMove({ root: work, direction: 'to_sqlite', registeredProjects: [work, broken], credentialsPath: creds }), MoveRegistryProjectError);
});

// Peers are judged by config.storage in both directions; mode is report metadata only. The four mode/storage
// combinations, each a peer mounting the one shared domain, with storage always set explicitly.
const PEER_COMBINATIONS = [
  { mode: 'work', storage: 'sqlite' },
  { mode: 'work', storage: 'postgres' },
  { mode: 'hobby', storage: 'sqlite' },
  { mode: 'hobby', storage: 'postgres' },
] as const;

for (const peer of PEER_COMBINATIONS) {
  test(`planMove: a ${peer.mode} peer on ${peer.storage} storage that mounts the domain, in both directions`, () => {
    const base = tempDir();
    const creds = fakeCredentials(base);
    const shared = join(base, 'domains', 'shared.db');
    const work = project(join(base, 'work'), { stack: ['shared'], domainPaths: { shared }, storage: 'sqlite' });
    const other = project(join(base, 'peer'), { mode: peer.mode, stack: ['shared'], domainPaths: { shared }, storage: peer.storage });
    const holder = [{ root: other, mode: peer.mode, storage: peer.storage }];
    const onSqlite = peer.storage === 'sqlite';

    const toPg = planMove({ root: work, direction: 'to_postgres', registeredProjects: [work, other], credentialsPath: creds }).stores[1];
    assert.equal(toPg.fenceSource, !onSqlite, '--to pg fences the SQLite copy only when the peer is on Postgres');
    assert.deepEqual(toPg.sharedWith, onSqlite ? holder : []);
    assert.deepEqual(toPg.forkedWith, []);

    const toSqlite = planMove({ root: work, direction: 'to_sqlite', registeredProjects: [work, other], credentialsPath: creds }).stores[1];
    assert.equal(toSqlite.fenceSource, onSqlite, '--to sqlite leaves the Postgres copy live for a peer on Postgres');
    assert.deepEqual(toSqlite.sharedWith, onSqlite ? [] : holder);
    assert.deepEqual(toSqlite.forkedWith, onSqlite ? holder : [], 'a peer on SQLite writes the SQLite copy, so a live copy there is a fork');
  });
}

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

test('planAttach: refuses by name in a hobby project, with no identity, with unreadable credentials, and when storage is already postgres', () => {
  const base = tempDir();
  const creds = fakeCredentials(base);
  const hobby = project(join(base, 'hobby'), { mode: 'hobby' });
  assert.throws(() => planAttach({ root: hobby, credentialsPath: creds }), (e: unknown) => e instanceof MoveModeError && (e as Error).message.includes('hobby project'));
  const anon = project(join(base, 'anon'), { id: false });
  assert.throws(() => planAttach({ root: anon, credentialsPath: creds }), MoveIdentityMissingError);
  const work = project(join(base, 'work'), {});
  assert.throws(() => planAttach({ root: work, credentialsPath: join(base, 'missing.json') }), MoveCredentialsError);
  const attached = project(join(base, 'attached'), { storage: 'postgres' });
  assert.throws(
    () => planAttach({ root: attached, credentialsPath: creds }),
    (e: unknown) => e instanceof MoveAttachError && e.check === 'storage' && e.schema === null && e.message.includes('already postgres'),
  );
  const plan = planAttach({ root: work, credentialsPath: creds });
  assert.equal(plan.localSqlitePath, join(work, '.sterling', 'sterling.db'));
  assert.equal(plan.fenceLocal, false);
  for (const root of [hobby, anon, work, attached]) assert.equal(existsSync(join(root, '.sterling', 'sterling.db')), false, 'the plan writes nothing');
});

/** A seeded store and a byte copy of it taken as the fork's other side, then `change` run on the source. */
function forkPair(label: string, change: (path: string, ids: string[]) => void): { source: StoreSnapshot; target: StoreSnapshot; ids: string[] } {
  const dir = tempDir();
  const path = join(dir, 'source.db');
  const { ids } = seedStore(path, { label });
  const copy = join(dir, 'target.db');
  copyFileSync(path, copy);
  change(path, ids);
  return { source: snapshotSqliteStore(path), target: snapshotSqliteStore(copy), ids };
}

const rawWrite = (path: string, sql: string, ...params: (string | number)[]): void => {
  const db = new DatabaseSync(path);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
};

test('forkLoss: an alias-only divergence is counted and names the record it points to', () => {
  const { source, target, ids } = forkPair('aliasonly', (path, ids) =>
    rawWrite(path, 'INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, 1, ?)', randomUUID(), ids[3], '2026-10-07T00:00:00.000Z'),
  );
  const loss = forkLoss(source, target);
  assert.deepEqual(Object.keys(loss.tables), ['record_aliases'], 'the records table matches');
  assert.deepEqual(loss.tables.record_aliases, { only_in_source: 1, only_in_target: 0, changed: 0 });
  assert.deepEqual([loss.only_in_source, loss.only_in_target, loss.differs, loss.unattributed_rows], [0, 0, 1, 0]);
  assert.deepEqual(loss.listed, [{ id: ids[3], title: 'aliasonly article', kind: 'differs' }]);
});

test('forkLoss: a version-only divergence is counted and names its record', () => {
  const { source, target, ids } = forkPair('versiononly', (path, ids) =>
    rawWrite(path, 'INSERT INTO record_versions (record_id, version, archived_at, body) VALUES (?, 99, ?, ?)', ids[1], '2026-10-07T00:00:00.000Z', '{}'),
  );
  const loss = forkLoss(source, target);
  assert.deepEqual(Object.keys(loss.tables), ['record_versions'], 'the records table matches');
  assert.deepEqual(loss.tables.record_versions, { only_in_source: 1, only_in_target: 0, changed: 0 });
  assert.deepEqual([loss.only_in_source, loss.only_in_target, loss.differs], [0, 0, 1]);
  assert.deepEqual(loss.listed, [{ id: ids[1], title: 'versiononly cites the first', kind: 'differs' }]);
});

test('forkLoss: a retirement in the source is counted: the retired record row changed, the relation to its replacement and the log row are only in the source', () => {
  const { source, target, ids } = forkPair('retireonly', (path, ids) => {
    const store = openSqliteStore(path);
    try {
      store.retireInFavorOf(ids[1], ids[3], '2026-10-07T00:00:00.000Z');
    } finally {
      store.close();
    }
  });
  const loss = forkLoss(source, target);
  // Measured 2026-10-07: retireInFavorOf rewrites the record row in place and adds one relation and one activity row.
  assert.deepEqual(loss.tables, {
    records: { only_in_source: 0, only_in_target: 0, changed: 1 },
    record_relations: { only_in_source: 1, only_in_target: 0, changed: 0 },
    activity_log: { only_in_source: 1, only_in_target: 0, changed: 0 },
  });
  assert.deepEqual([loss.only_in_source, loss.only_in_target, loss.differs, loss.unattributed_rows], [0, 0, 2, 0]);
  assert.deepEqual(
    [...loss.listed].sort((x, y) => x.title.localeCompare(y.title)),
    [
      { id: ids[3], title: 'retireonly article', kind: 'differs' },
      { id: ids[1], title: 'retireonly cites the first', kind: 'differs' },
    ],
  );
  assert.match(describeForkLoss(loss), /0 record\(s\) only in the SQLite copy, 0 only in Postgres, 2 that differ/);
});

test('forkLoss: the list is capped at FORK_LOSS_LIST_CAP while every count stays complete; identical copies differ in nothing', () => {
  const { source, target } = forkPair('capped', (path) => {
    const store = openSqliteStore(path);
    try {
      for (let i = 0; i < FORK_LOSS_LIST_CAP + 5; i++) store.create(decision({ title: `capped extra ${i}` }));
    } finally {
      store.close();
    }
  });
  const loss = forkLoss(source, target);
  assert.equal(loss.only_in_source, FORK_LOSS_LIST_CAP + 5);
  assert.equal(loss.tables.records.only_in_source, FORK_LOSS_LIST_CAP + 5);
  assert.equal(loss.listed.length, FORK_LOSS_LIST_CAP);
  assert.match(describeForkLoss(loss), /and 5 more$/);
  const same = forkPair('same', () => {});
  assert.deepEqual(forkLoss(same.source, same.target), { only_in_source: 0, only_in_target: 0, differs: 0, tables: {}, unattributed_rows: 0, listed: [] });
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

test('a forked shared domain is copied and left unfenced; a later run lists what the SQLite copy gained, refuses without the confirm flag, and with it copies and merges nothing', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'shared.db');
  const seeded = seedStore(path, { label: 'fork' });
  const schema = nextSchema();
  const identity = { kind: 'domain', name: 'fork' } as const;
  const first = importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: false });
  assert.equal(first.outcome, 'copied');
  assert.equal(first.source_fenced, false);
  assert.equal(readSqliteFence(path), null, 'the SQLite copy stays writable for projects still on SQLite');
  const pgDigest = () => buildManifest(snapshotPgStore(live().bridge, schema)).manifest.digest;
  const pgBefore = pgDigest();
  const receiptBefore = latestPgReceipt(live().bridge, live().meta, schema);
  // A project still on SQLite writes; the copies diverge: one new record, one changed record.
  const store = openSqliteStore(path);
  const added = store.create(decision({ title: 'written by a hobby project after the fork' }));
  const art = store.get(seeded.ids[3])!;
  store.updateRecord(art.id, { ...art, what_it_does: 'Changed in the SQLite copy after the fork.' });
  store.close();

  const refused = (e: unknown): boolean => {
    assert.ok(e instanceof MoveForkUnconfirmedError, String(e));
    const err = e as MoveForkUnconfirmedError;
    assert.deepEqual([err.loss.only_in_source, err.loss.only_in_target, err.loss.differs], [1, 0, 1]);
    assert.deepEqual(err.loss.listed, [
      { id: added.id, title: 'written by a hobby project after the fork', kind: 'only_in_source' },
      { id: art.id, title: 'fork article', kind: 'differs' },
    ]);
    assert.deepEqual(err.loss.tables.records, { only_in_source: 1, only_in_target: 0, changed: 1 });
    assert.equal(err.loss.tables.record_versions?.only_in_source, 1, 'the archived version of the changed article');
    assert.ok(err.message.includes(added.id) && err.message.includes('written by a hobby project after the fork'), err.message);
    assert.ok(err.message.includes(FORK_CONFIRM_FLAG), 'the refusal names the flag');
    return true;
  };
  assert.throws(() => importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: false }), refused);
  const dry = importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: false, dryRun: true });
  assert.equal(dry.dry_run_refusal?.name, 'MoveForkUnconfirmedError');
  assert.equal(pgDigest(), pgBefore, 'the refusal changed nothing in Postgres');
  assert.equal(latestPgReceipt(live().bridge, live().meta, schema)?.move_id, receiptBefore?.move_id, 'and wrote no receipt');
  assert.equal(readSqliteFence(path), null);

  const again = importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: false, confirmFork: true });
  assert.equal(again.outcome, 'fork_already_copied');
  assert.equal(again.hash_match, false);
  assert.equal(again.source_fenced, false);
  assert.deepEqual([again.fork_loss?.only_in_source, again.fork_loss?.only_in_target, again.fork_loss?.differs, again.fork_loss?.listed.map((l) => l.id)], [1, 0, 1, [added.id, art.id]]);
  assert.equal(pgDigest(), pgBefore, 'nothing was copied or merged');
  assert.equal(latestPgReceipt(live().bridge, live().meta, schema)?.move_id, receiptBefore?.move_id);
  assert.equal(readSqliteFence(path), null, 'still a fork: the SQLite copy stays writable');
});

test('the last project to leave a forked domain meets the fork too: refused without the flag and nothing fenced; with it the SQLite copy is fenced and nothing copied', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'shared.db');
  seedStore(path, { label: 'lastfork' });
  const schema = nextSchema();
  const identity = { kind: 'domain', name: 'lastfork' } as const;
  importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: false });
  const store = openSqliteStore(path);
  const added = store.create(decision({ title: 'written before the last project moved' }));
  store.close();
  const pgBefore = buildManifest(snapshotPgStore(live().bridge, schema)).manifest.digest;
  // Every project mounting it is on Postgres now, so this move fences the SQLite copy.
  assert.throws(
    () => importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true }),
    (e: unknown) => e instanceof MoveForkUnconfirmedError && e.loss.listed.some((l) => l.id === added.id),
  );
  assert.equal(readSqliteFence(path), null, 'a refusal fences nothing');
  const done = importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true, confirmFork: true });
  assert.equal(done.outcome, 'fork_already_copied');
  assert.equal(done.source_fenced, true);
  assert.ok(readSqliteFence(path)?.manifest_digest, 'the SQLite copy is fenced with its content digest');
  assert.equal(buildManifest(snapshotPgStore(live().bridge, schema)).manifest.digest, pgBefore, 'nothing was copied');
  // A re-run after a crash at this point meets the same fork and still needs the flag.
  assert.throws(() => importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true }), MoveForkUnconfirmedError);
  assert.equal(importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true, confirmFork: true }).outcome, 'fork_already_copied');
});

test('a re-run with both copies as the receipt left them is a replay; once only the Postgres copy changed it is the fork, refused without the flag', { skip: PG_SKIP }, () => {
  const path = join(tempDir(), 'shared.db');
  seedStore(path, { label: 'pgside' });
  const schema = nextSchema();
  const identity = { kind: 'domain', name: 'pgside' } as const;
  importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: false });
  // A crash re-run: neither copy changed since the receipt.
  assert.equal(importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: false }).outcome, 'replayed');
  // A project on Postgres writes to the Postgres copy; the SQLite copy is untouched.
  live().bridge.query(`INSERT INTO "${schema}".store_meta (key, value, updated_at) VALUES ('written_on_postgres', 'x', '2026-10-07T00:00:00.000Z')`);
  for (const fenceSource of [false, true]) {
    assert.throws(
      () => importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource }),
      (e: unknown) =>
        e instanceof MoveForkUnconfirmedError &&
        e.loss.tables.store_meta?.only_in_target === 1 &&
        e.loss.unattributed_rows === 1 &&
        e.message.includes(FORK_CONFIRM_FLAG),
      `fenceSource ${fenceSource}: not a replay`,
    );
  }
  assert.equal(readSqliteFence(path), null, 'the refusal fenced nothing');
  const done = importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true, confirmFork: true });
  assert.equal(done.outcome, 'fork_already_copied');
  assert.ok(readSqliteFence(path), 'confirmed by the last project on SQLite: the SQLite copy is fenced');
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

// ---------------------------------------------------------------------------
// Attach (STERLING_TEST_PG=1): a second machine joins a project already on Postgres
// ---------------------------------------------------------------------------

/**
 * Machine A's stores moved to Postgres under this file's prefix (as the router
 * names them, through STERLING_TEST_PG_NAMESPACE), and machine B: a fresh
 * clone with the same project.json and a config with no storage key.
 * `skip` names stores A never moved ('project', 'alpha', 'beta'). Domain
 * schemas are named by domain alone, so each fixture gets its own domain names.
 */
let attachFixtures = 0;
function attachFixture(opts: { skip?: string[] } = {}) {
  process.env[PG_TEST_NAMESPACE_ENV] = live().prefix;
  const base = tempDir();
  const projectId = randomUUID();
  const n = ++attachFixtures;
  const stack = [`alpha${n}`, `beta${n}`];
  const names = pgStoreNames(projectId, stack);
  assert.equal(names.metaSchema, live().meta);
  const moves: [string, string, { kind: 'project' | 'domain'; name: string }][] = [
    ['project', names.projectSchema, { kind: 'project', name: projectId }],
    ...names.domains.map((d, i): [string, string, { kind: 'domain'; name: string }] => [['alpha', 'beta'][i], d.schema, { kind: 'domain', name: d.name }]),
  ];
  for (const [key, schema, identity] of moves) {
    if (opts.skip?.includes(key)) continue;
    const path = join(base, 'machine-a', `${key}.db`);
    seedStore(path, { label: `attach-${key}-${projectId.slice(0, 8)}` });
    importStore({ ...pgOpts(), schema, sqlitePath: path, identity, fenceSource: true });
  }
  const b = join(base, 'machine-b');
  mkdirSync(join(b, '.sterling'), { recursive: true });
  writeFileSync(join(b, '.sterling', 'config.json'), JSON.stringify({ mode: 'work', stack_tags: stack, domain_paths: { [stack[0]]: join(b, 'd', 'alpha.db'), [stack[1]]: join(b, 'd', 'beta.db') }, kept: 'yes' }, null, 2));
  writeFileSync(join(b, '.sterling', 'project.json'), JSON.stringify({ project_id: projectId }));
  const cfgPath = join(b, '.sterling', 'config.json');
  return { b, projectId, stack, names, cfgPath, configText: () => readFileSync(cfgPath, 'utf8'), plan: (fenceLocal = false) => planAttach({ root: b, credentialsPath: routedCredentialsPath(), fenceLocal }) };
}

function assertAttachRefused(fx: ReturnType<typeof attachFixture>, check: string, schema: string | null, fenceLocal = false): void {
  const before = fx.configText();
  assert.throws(
    () => attachProject(fx.plan(fenceLocal), live().bridge),
    (e: unknown) => e instanceof MoveAttachError && e.check === check && e.schema === schema && e.message.startsWith(`attach check '${check}' failed: `) && (schema === null || e.message.includes(schema)) && e.message.includes('Nothing was changed'),
  );
  assert.equal(fx.configText(), before, 'a refused attach leaves the config byte for byte');
}

test('attach: with every schema registered, receipted and unfenced it writes config.storage = postgres and copies nothing; a dry run writes nothing', { skip: PG_SKIP }, () => {
  const fx = attachFixture();
  const before = fx.configText();
  const dry = attachProject(fx.plan(), live().bridge, { dryRun: true });
  assert.equal(dry.storageSwitched, false);
  assert.equal(fx.configText(), before, 'the dry run wrote nothing');
  const digests = [fx.names.projectSchema, ...fx.names.domains.map((d) => d.schema)].map((s) => digestOf(snapshotPgStore(live().bridge, s)));
  const done = attachProject(fx.plan(), live().bridge);
  assert.equal(done.storageSwitched, true);
  assert.deepEqual(done.stores.map((s) => [s.identity.kind, s.schema]), [['project', fx.names.projectSchema], ...fx.names.domains.map((d) => ['domain', d.schema])]);
  assert.ok(done.stores.every((s) => s.receipt.move_id.length > 0));
  assert.deepEqual(done.local, { path: join(fx.b, '.sterling', 'sterling.db'), records: 0, occupied: [], action: 'absent' });
  const cfg = JSON.parse(fx.configText());
  assert.deepEqual([cfg.storage, cfg.mode, cfg.kept], ['postgres', 'work', 'yes'], 'storage written; mode and every other key kept');
  assert.deepEqual([fx.names.projectSchema, ...fx.names.domains.map((d) => d.schema)].map((s) => digestOf(snapshotPgStore(live().bridge, s))), digests, 'the Postgres stores are unchanged');
  assert.equal(existsSync(join(fx.b, '.sterling', 'sterling.db')), false, 'no SQLite store was created');
  assert.throws(() => fx.plan(), (e: unknown) => e instanceof MoveAttachError && e.check === 'storage', 'a second attach is refused: already postgres');
});

test('attach: a project schema never moved is refused by name (registered)', { skip: PG_SKIP }, () => {
  const fx = attachFixture({ skip: ['project'] });
  assertAttachRefused(fx, 'registered', fx.names.projectSchema);
});

test('attach: a mounted domain schema never moved is refused by name (registered)', { skip: PG_SKIP }, () => {
  const fx = attachFixture({ skip: ['beta'] });
  assertAttachRefused(fx, 'registered', fx.names.domains[1].schema);
});

test('attach: a registered schema with no receipt is refused by name (receipt)', { skip: PG_SKIP }, () => {
  const fx = attachFixture();
  const schema = fx.names.domains[0].schema;
  live().bridge.query(`DELETE FROM "${live().meta}".move_receipts WHERE target_schema = $1`, [schema]);
  assertAttachRefused(fx, 'receipt', schema);
});

test('attach: a schema whose latest receipt is from another store is refused by name (receipt)', { skip: PG_SKIP }, () => {
  const fx = attachFixture();
  const schema = fx.names.projectSchema;
  const row = live().bridge.query(`SELECT move_id, receipt FROM "${live().meta}".move_receipts WHERE target_schema = $1`, [schema]).rows[0];
  const receipt = { ...JSON.parse(String(row.receipt)), source_kind: 'domain', source_name: 'someone-else' };
  live().bridge.query(`UPDATE "${live().meta}".move_receipts SET receipt = $1 WHERE move_id = $2`, [JSON.stringify(receipt), row.move_id]);
  assertAttachRefused(fx, 'receipt', schema);
});

test('attach: a schema fenced on the Postgres side (moved back to SQLite) is refused by name (fence)', { skip: PG_SKIP }, () => {
  const fx = attachFixture();
  const schema = fx.names.domains[1].schema;
  writePgFence(live().bridge, live().meta, schema, { move_id: randomUUID(), to: 'sqlite:/elsewhere/beta.db', fenced_at: '2026-10-06T09:00:00.000Z', manifest_digest: null });
  assertAttachRefused(fx, 'fence', schema);
});

test('attach: a local project SQLite file is fenced when empty, refused while it holds records, and fenced on --fence-local', { skip: PG_SKIP }, () => {
  // Holds records, no choice made: refused by name, the file untouched.
  const held = attachFixture();
  const local = join(held.b, '.sterling', 'sterling.db');
  seedStore(local, { label: 'machine-b-local' });
  const localDigest = digestOf(snapshotSqliteStore(local));
  assertAttachRefused(held, 'local_store', null);
  assert.equal(readSqliteFence(local), null, 'the refusal fenced nothing');
  // A dry run with the choice made reports and writes nothing.
  const dry = attachProject(held.plan(true), live().bridge, { dryRun: true });
  assert.equal(dry.local.action, 'would_fence');
  assert.equal(readSqliteFence(local), null);
  // The choice made: fenced toward the project schema with the digest of what it froze, then switched.
  const done = attachProject(held.plan(true), live().bridge);
  assert.equal(done.local.action, 'fenced');
  assert.ok(done.local.records > 0);
  const fence = readSqliteFence(local);
  assert.equal(fence?.to, `postgres:${held.names.projectSchema}`);
  assert.equal(fence?.manifest_digest, localDigest, 'a later move back from this machine can replace the file as an untouched copy');
  assert.equal(JSON.parse(held.configText()).storage, 'postgres');

  // An empty local store (as init leaves it) is fenced without the choice: nothing in it is lost.
  const empty = attachFixture();
  const emptyPath = join(empty.b, '.sterling', 'sterling.db');
  openSqliteStore(emptyPath).close();
  const emptyDone = attachProject(empty.plan(), live().bridge);
  assert.deepEqual([emptyDone.local.action, emptyDone.local.records], ['fenced', 0]);
  assert.ok(readSqliteFence(emptyPath));
  assert.equal(JSON.parse(empty.configText()).storage, 'postgres');

  // A re-run after a crash between the fence and the switch: the file is already fenced toward this schema, so the choice stands.
  const resumed = attachFixture();
  const resumedPath = join(resumed.b, '.sterling', 'sterling.db');
  seedStore(resumedPath, { label: 'machine-b-resumed' });
  writeSqliteFence(resumedPath, { move_id: randomUUID(), to: `postgres:${resumed.names.projectSchema}`, fenced_at: '2026-10-06T09:00:00.000Z', manifest_digest: null });
  assert.equal(attachProject(resumed.plan(), live().bridge).local.action, 'already_fenced');
  assert.equal(JSON.parse(resumed.configText()).storage, 'postgres');

  // A local file already fenced toward somewhere else is refused by name.
  const elsewhere = attachFixture();
  const elsewherePath = join(elsewhere.b, '.sterling', 'sterling.db');
  openSqliteStore(elsewherePath).close();
  writeSqliteFence(elsewherePath, { move_id: randomUUID(), to: 'postgres:sterling_p_other', fenced_at: '2026-10-06T09:00:00.000Z', manifest_digest: null });
  const before = elsewhere.configText();
  assert.throws(() => attachProject(elsewhere.plan(true), live().bridge), MoveSourceFencedError);
  assert.equal(elsewhere.configText(), before);
});

test('attach: a receipt that is not a complete to_postgres receipt for this schema is refused by name (receipt)', { skip: PG_SKIP }, () => {
  const fx = attachFixture();
  const schema = fx.names.domains[0].schema;
  const row = live().bridge.query(`SELECT move_id, receipt FROM "${live().meta}".move_receipts WHERE target_schema = $1`, [schema]).rows[0];
  const full = JSON.parse(String(row.receipt));
  const setReceipt = (r: unknown) => live().bridge.query(`UPDATE "${live().meta}".move_receipts SET receipt = $1 WHERE move_id = $2`, [JSON.stringify(r), row.move_id]);
  const variants: Record<string, unknown>[] = [
    { move_id: full.move_id, source_digest: full.source_digest, source_kind: full.source_kind, source_name: full.source_name },
    { ...full, direction: 'to_sqlite' },
    { ...full, target: 'postgres:sterling_d_somewhere_else' },
    { ...full, source: '' },
    { ...full, committed_at: 42 },
    { ...full, tables: { records: full.tables.records } },
    { ...full, tables: { ...full.tables, records: { rows: 'many', digest: full.tables.records.digest } } },
  ];
  for (const v of variants) {
    setReceipt(v);
    assertAttachRefused(fx, 'receipt', schema);
  }
  setReceipt(full);
  assert.equal(attachProject(fx.plan(), live().bridge).storageSwitched, true, 'the intact receipt is accepted');
});

test('attach: a local store with no records but rows in other tables is refused by name, naming the tables', { skip: PG_SKIP }, () => {
  const fx = attachFixture();
  const local = join(fx.b, '.sterling', 'sterling.db');
  openSqliteStore(local).close();
  const raw = new DatabaseSync(local);
  try {
    raw.prepare("INSERT INTO activity_log (at, verb, type, record_id, title) VALUES ('2026-10-06T09:00:00.000Z', 'created', 'decision', 'r1', 'local only')").run();
    raw.prepare("INSERT INTO store_meta (key, value, updated_at) VALUES ('local_note', 'kept here', '2026-10-06T09:00:00.000Z')").run();
  } finally {
    raw.close();
  }
  const before = fx.configText();
  assert.throws(
    () => attachProject(fx.plan(), live().bridge),
    (e: unknown) => e instanceof MoveAttachError && e.check === 'local_store' && e.message.includes('activity_log (1)') && e.message.includes('store_meta (1)'),
  );
  assert.equal(fx.configText(), before);
  assert.equal(readSqliteFence(local), null);
  assert.equal(attachProject(fx.plan(true), live().bridge).local.action, 'fenced', '--fence-local is the choice that lets it through');
});

test('attach: resuming a same-target fence whose digest was never recorded records it, so a later move back replaces the file', { skip: PG_SKIP }, () => {
  const fx = attachFixture();
  const local = join(fx.b, '.sterling', 'sterling.db');
  seedStore(local, { label: 'machine-b-crashed' });
  const digest = digestOf(snapshotSqliteStore(local));
  // A crash between the two fence writes: the fence is there, its digest is not.
  writeSqliteFence(local, { move_id: randomUUID(), to: `postgres:${fx.names.projectSchema}`, fenced_at: '2026-10-06T09:00:00.000Z', manifest_digest: null });
  assert.equal(attachProject(fx.plan(), live().bridge, { dryRun: true }).local.action, 'already_fenced');
  assert.equal(readSqliteFence(local)?.manifest_digest, null, 'a dry run records nothing');
  const done = attachProject(fx.plan(), live().bridge);
  assert.equal(done.local.action, 'already_fenced');
  assert.equal(readSqliteFence(local)?.manifest_digest, digest);
  const back = exportStore({ ...pgOpts(), schema: fx.names.projectSchema, sqlitePath: local, identity: { kind: 'project', name: fx.projectId }, fenceSource: true });
  assert.equal(back.outcome, 'replaced', 'the fenced local file is the untouched copy a move back replaces');
});

test('attach: a mount added to the config after the plan is refused by name before anything is fenced or written (mounts)', { skip: PG_SKIP }, () => {
  const fx = attachFixture();
  const plan = fx.plan();
  const local = join(fx.b, '.sterling', 'sterling.db');
  openSqliteStore(local).close();
  const cfg = JSON.parse(fx.configText());
  const added = `gamma${fx.stack[0].slice('alpha'.length)}`;
  cfg.stack_tags = [...cfg.stack_tags, added];
  cfg.domain_paths = { ...cfg.domain_paths, [added]: join(fx.b, 'd', 'gamma.db') };
  writeFileSync(fx.cfgPath, JSON.stringify(cfg, null, 2));
  const before = fx.configText();
  assert.throws(
    () => attachProject(plan, live().bridge),
    (e: unknown) => e instanceof MoveAttachError && e.check === 'mounts' && e.message.includes(added) && e.message.includes('Nothing was changed'),
  );
  assert.equal(fx.configText(), before, 'storage was not written');
  assert.equal(readSqliteFence(local), null, 'the local store was not fenced');
});
