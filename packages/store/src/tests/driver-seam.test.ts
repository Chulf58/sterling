// Driver seam pins (board item "Postgres store 2 of 7: driver seam"; decision
// postgres-store-design-sync-driver-seam-schema-per-store-advisory-locks, design
// point 1). SterlingStore talks to a StoreDriver; the SQLite driver is the only
// one. These pins cover the seam itself: every existing store test already pins
// that behaviour on SQLite is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SterlingStore,
  SqliteDriver,
  sqliteDialect,
  DEFAULT_BUSY_TIMEOUT_MS,
  SUPPORTED_SCHEMA_VERSION,
  type StoreDriver,
  type StoreDialect,
} from '../index.js';

const NOW = '2026-10-05T12:00:00.000Z';

function envelope(type: string) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [] as { rel: string; target_id: string }[],
    scope: 'project',
    stack_tags: ['node'],
  };
}

function decision(over: Record<string, unknown> = {}) {
  return {
    ...envelope('decision'),
    title: 'Use a driver seam',
    statement: 'The store talks to a driver.',
    alternatives_rejected: [{ option: 'async rewrite', reason: 'every caller changes' }],
    rationale: 'Callers stay synchronous.',
    ...over,
  };
}

function article(over: Record<string, unknown> = {}) {
  return {
    ...envelope('feature_article'),
    slug: 'driver-seam',
    title: 'Driver seam',
    what_it_does: 'Routes every statement through a seamword driver.',
    intended_behavior: 'A second backend can be added.',
    files: [{ path: 'packages/store/src/driver.ts', role: 'interface' }],
    current_ac: [{ ac_id: 'AC1', text: 'the suite passes', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
    ...over,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sterling-driver-seam-'));
}

function busyTimeout(target: { prepare: StoreDriver['prepare'] }): unknown {
  return target.prepare('PRAGMA busy_timeout').get()?.timeout;
}

/** The store's driver, reached the way the existing tests reach `db`. */
function driverOf(store: SterlingStore): StoreDriver {
  return (store as unknown as { db: StoreDriver }).db;
}

/**
 * A driver that forwards everything to a real SqliteDriver and records what
 * SterlingStore asked of it. `dialect` replaces the inner driver's dialect when
 * given.
 */
function recordingDriver(path: string, dialect?: StoreDialect) {
  const inner = new SqliteDriver(path);
  const events: string[] = [];
  const sql: string[] = [];
  const driver: StoreDriver = {
    dialect: dialect ?? inner.dialect,
    prepare(text) {
      sql.push(text);
      return inner.prepare(text);
    },
    exec(text) {
      sql.push(text);
      inner.exec(text);
    },
    close() {
      events.push('close');
      inner.close();
    },
    begin() {
      events.push('begin');
      inner.begin();
    },
    commit() {
      events.push('commit');
      inner.commit();
    },
    rollback() {
      events.push('rollback');
      inner.rollback();
    },
    schemaVersion() {
      events.push('schemaVersion');
      return inner.schemaVersion();
    },
    setSchemaVersion(version) {
      events.push(`setSchemaVersion:${version}`);
      inner.setSchemaVersion(version);
    },
    hasSchema() {
      events.push('hasSchema');
      return inner.hasSchema();
    },
    prepareReadOnly() {
      events.push('prepareReadOnly');
      inner.prepareReadOnly();
    },
    prepareWritable(isFresh) {
      events.push(`prepareWritable:${isFresh}`);
      inner.prepareWritable(isFresh);
    },
    journalMode() {
      events.push('journalMode');
      return inner.journalMode();
    },
    snapshot(targetPath) {
      events.push(`snapshot:${targetPath}`);
      inner.snapshot(targetPath);
    },
  };
  return { driver, events, sql };
}

test('SqliteDriver serves the statement API: exec, prepare, run, get, all, close', () => {
  const dir = tempDir();
  try {
    const driver = new SqliteDriver(join(dir, 'raw.db'));
    driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const ran = driver.prepare('INSERT INTO t (name) VALUES (?)').run('one');
    assert.equal(Number(ran.changes), 1);
    assert.equal(Number(ran.lastInsertRowid), 1);
    driver.prepare('INSERT INTO t (name) VALUES (?)').run('two');
    assert.deepEqual({ ...driver.prepare('SELECT name FROM t WHERE id = ?').get(2) }, { name: 'two' });
    assert.equal(driver.prepare('SELECT name FROM t WHERE id = ?').get(99), undefined);
    assert.deepEqual(
      driver.prepare('SELECT name FROM t ORDER BY id').all().map((r) => r.name),
      ['one', 'two'],
    );
    driver.close();
    assert.throws(() => driver.prepare('SELECT 1'), 'a closed driver serves nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteDriver transaction: rollback discards, commit keeps', () => {
  const dir = tempDir();
  try {
    const driver = new SqliteDriver(join(dir, 'raw.db'));
    driver.exec('CREATE TABLE t (name TEXT NOT NULL)');
    driver.begin();
    driver.prepare('INSERT INTO t (name) VALUES (?)').run('discarded');
    driver.rollback();
    driver.begin();
    driver.prepare('INSERT INTO t (name) VALUES (?)').run('kept');
    driver.commit();
    assert.deepEqual(driver.prepare('SELECT name FROM t').all().map((r) => r.name), ['kept']);
    driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteDriver busy timeout: 5000 ms by default, the option replaces it, a bad value is refused', () => {
  const dir = tempDir();
  try {
    assert.equal(DEFAULT_BUSY_TIMEOUT_MS, 5000);
    const byDefault = new SqliteDriver(join(dir, 'a.db'));
    assert.equal(busyTimeout(byDefault), 5000);
    byDefault.close();
    const short = new SqliteDriver(join(dir, 'b.db'), { busyTimeoutMs: 1000 });
    assert.equal(busyTimeout(short), 1000);
    short.close();
    for (const bad of [-1, 1.5, Number.NaN, '1000' as unknown as number]) {
      assert.throws(() => new SqliteDriver(join(dir, 'bad.db'), { busyTimeoutMs: bad }), /busyTimeoutMs/);
    }
    assert.equal(existsSync(join(dir, 'bad.db')), false, 'a refused option opens no file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteDriver open steps: a new file has no schema and version 0; prepareWritable builds it', () => {
  const dir = tempDir();
  try {
    const driver = new SqliteDriver(join(dir, 'raw.db'));
    assert.equal(driver.hasSchema(), false);
    assert.equal(driver.schemaVersion(), 0);
    driver.prepareWritable(true);
    assert.equal(driver.hasSchema(), true);
    assert.equal(driver.journalMode(), 'wal');
    assert.equal(driver.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    assert.equal(driver.schemaVersion(), 0, 'stamping the version is the store\'s step, not prepareWritable\'s');
    driver.setSchemaVersion(7);
    assert.equal(driver.schemaVersion(), 7);
    driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteDriver.snapshot writes a readable copy', () => {
  const dir = tempDir();
  try {
    const driver = new SqliteDriver(join(dir, 'raw.db'));
    driver.exec('CREATE TABLE t (name TEXT NOT NULL)');
    driver.prepare('INSERT INTO t (name) VALUES (?)').run("it's");
    const target = join(dir, "copy's.db");
    driver.snapshot(target);
    driver.close();
    const copy = new SqliteDriver(target);
    assert.deepEqual(copy.prepare('SELECT name FROM t').all().map((r) => r.name), ["it's"]);
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SterlingStore opens on a SqliteDriver and passes busyTimeoutMs through to it', () => {
  const dir = tempDir();
  try {
    const byDefault = new SterlingStore(join(dir, 'a.db'));
    assert.ok(driverOf(byDefault) instanceof SqliteDriver);
    assert.equal(busyTimeout(driverOf(byDefault)), 5000);
    byDefault.close();
    const short = new SterlingStore(join(dir, 'b.db'), { busyTimeoutMs: 1000 });
    assert.equal(busyTimeout(driverOf(short)), 1000);
    // the option survives the whole open, schema build and stamp included
    short.create(decision());
    assert.equal(busyTimeout(driverOf(short)), 1000);
    short.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SterlingStore refuses busyTimeoutMs together with an injected driver', () => {
  const dir = tempDir();
  try {
    const { driver } = recordingDriver(join(dir, 's.db'));
    assert.throws(
      () => new SterlingStore(join(dir, 's.db'), { driver, busyTimeoutMs: 1000 }),
      /busyTimeoutMs.*driver/,
    );
    driver.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SterlingStore opens an injected driver in the fixed order and stamps a fresh store inside one transaction', () => {
  const dir = tempDir();
  try {
    const { driver, events } = recordingDriver(join(dir, 's.db'));
    const store = new SterlingStore(join(dir, 's.db'), { driver });
    assert.deepEqual(events, [
      'schemaVersion',
      'hasSchema',
      'prepareWritable:true',
      'begin',
      'schemaVersion',
      `setSchemaVersion:${SUPPORTED_SCHEMA_VERSION}`,
      'commit',
      'schemaVersion',
    ]);
    store.close();

    // An already-stamped store owes no stamp, so its open takes no write lock.
    const second = recordingDriver(join(dir, 's.db'));
    new SterlingStore(join(dir, 's.db'), { driver: second.driver }).close();
    assert.deepEqual(second.events, ['schemaVersion', 'prepareWritable:false', 'schemaVersion', 'close']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SterlingStore opens an older store that has a schema through prepareReadOnly, and writes nothing', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 's.db');
    const seed = new SqliteDriver(path);
    seed.prepareWritable(true);
    seed.setSchemaVersion(SUPPORTED_SCHEMA_VERSION - 1);
    seed.close();

    const { driver, events } = recordingDriver(path);
    const store = new SterlingStore(path, { driver });
    assert.deepEqual(events, ['schemaVersion', 'hasSchema', 'prepareReadOnly']);
    assert.throws(() => store.create(decision()), /migrat/i);
    assert.ok(!events.includes('begin'), 'a read-only store never takes the write lock');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SterlingStore closes the driver and refuses a store newer than it supports', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 's.db');
    const seed = new SqliteDriver(path);
    seed.setSchemaVersion(SUPPORTED_SCHEMA_VERSION + 1);
    seed.close();

    const { driver, events } = recordingDriver(path);
    assert.throws(() => new SterlingStore(path, { driver }), { name: 'UnsupportedSchemaVersionError' });
    assert.deepEqual(events, ['schemaVersion', 'close']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every write runs inside the driver transaction: one begin and one commit, or one rollback', () => {
  const dir = tempDir();
  try {
    const { driver, events } = recordingDriver(join(dir, 's.db'));
    const store = new SterlingStore(join(dir, 's.db'), { driver });
    const tx = () => events.filter((e) => e === 'begin' || e === 'commit' || e === 'rollback');

    events.length = 0;
    const kept = store.create(decision());
    assert.deepEqual(tx(), ['begin', 'commit']);

    events.length = 0;
    assert.throws(() => store.create(decision({ id: kept.id })), 'a duplicate id is refused');
    const failed = tx();
    assert.ok(!failed.includes('commit'), 'a refused write commits nothing');
    assert.equal(failed.filter((e) => e === 'begin').length, failed.filter((e) => e === 'rollback').length);

    // The store is still usable and still atomic after the failure.
    events.length = 0;
    store.create(decision());
    assert.deepEqual(tx(), ['begin', 'commit']);
    assert.equal(store.query({ types: ['decision'] }).length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no transaction statement reaches the statement API: BEGIN, COMMIT and ROLLBACK are the driver\'s', () => {
  const dir = tempDir();
  try {
    const { driver, sql } = recordingDriver(join(dir, 's.db'));
    const store = new SterlingStore(join(dir, 's.db'), { driver });
    const kept = store.create(decision());
    assert.throws(() => store.create(decision({ id: kept.id })));
    store.close();
    const leaked = sql.filter((s) => /^\s*(BEGIN|COMMIT|ROLLBACK|PRAGMA|VACUUM)\b/i.test(s));
    assert.deepEqual(leaked, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journalMode() and snapshot() go through the driver', () => {
  const dir = tempDir();
  try {
    const { driver, events } = recordingDriver(join(dir, 's.db'));
    const store = new SterlingStore(join(dir, 's.db'), { driver });
    store.create(decision());
    events.length = 0;
    assert.equal(store.journalMode(), 'wal');
    const target = join(dir, 'backup', 'copy.db').replace(/\\/g, '/');
    store.snapshot(target);
    assert.deepEqual(events, ['journalMode', `snapshot:${target}`]);
    assert.throws(() => store.snapshot(target), /refusing to overwrite/);
    assert.deepEqual(events, ['journalMode', `snapshot:${target}`], 'the overwrite refusal is the store\'s, before the driver is asked');
    store.close();
    const copy = new SterlingStore(target);
    assert.equal(copy.query({ types: ['decision'] }).length, 1);
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sqliteDialect is today\'s SQL, byte for byte', () => {
  assert.equal(sqliteDialect.searchJoin, 'JOIN records_fts f ON f.record_id = r.id');
  assert.equal(sqliteDialect.searchMatch, 'records_fts MATCH ?');
  assert.equal(sqliteDialect.searchScore, '(-bm25(records_fts))');
  assert.equal(sqliteDialect.searchOrder, 'bm25(records_fts) ASC');
  assert.equal(sqliteDialect.searchQuery(['store', 'driv*'], undefined), '"store" OR "driv"*');
  assert.equal(sqliteDialect.searchQuery(['store', 'driv*'], true), '"store" AND "driv"*');
  assert.equal(sqliteDialect.searchQuery(['a"b', '*'], false), '"a""b" OR "*"');
  assert.equal(sqliteDialect.jsonText('body', 'slug'), "json_extract(body, '$.slug')");
  assert.equal(sqliteDialect.jsonText('r.body', 'source'), "json_extract(r.body, '$.source')");
  assert.equal(sqliteDialect.insertionOrder(), 'rowid');
  assert.equal(sqliteDialect.insertionOrder('x'), 'x.rowid');
  assert.equal(
    sqliteDialect.insertIgnore('record_relations', ['source_id', 'rel', 'target_id', 'created_at']),
    'INSERT OR IGNORE INTO record_relations (source_id, rel, target_id, created_at) VALUES (?, ?, ?, ?)',
  );
});

test('each dialect hook is what the store sends at its sites: a marked dialect shows up in the SQL', () => {
  const dir = tempDir();
  try {
    const searchQueries: string[] = [];
    const marked: StoreDialect = {
      searchJoin: `/*searchJoin*/ ${sqliteDialect.searchJoin}`,
      searchMatch: `/*searchMatch*/ ${sqliteDialect.searchMatch}`,
      searchScore: `/*searchScore*/ ${sqliteDialect.searchScore}`,
      searchOrder: `/*searchOrder*/ ${sqliteDialect.searchOrder}`,
      searchQuery(terms, matchAll) {
        const q = sqliteDialect.searchQuery(terms, matchAll);
        searchQueries.push(q);
        return q;
      },
      jsonText: (column, key) => `/*jsonText:${key}*/ ${sqliteDialect.jsonText(column, key)}`,
      insertionOrder: (alias) => `/*insertionOrder*/ ${sqliteDialect.insertionOrder(alias)}`,
      insertIgnore: (table, columns) => `/*insertIgnore*/ ${sqliteDialect.insertIgnore(table, columns)}`,
    };
    const { driver, sql } = recordingDriver(join(dir, 's.db'), marked);
    const store = new SterlingStore(join(dir, 's.db'), { driver });
    const count = (marker: string) => sql.filter((s) => s.includes(marker)).length;

    const cited = store.create(decision());
    const made = store.create(article({ links: [{ rel: 'cites', target_id: cited.id }] }));
    assert.equal(count('/*insertIgnore*/'), 1, 'the relation insert');

    // The marked SQL still runs and still answers: comments change nothing.
    assert.deepEqual(store.get(made.id)?.links, [{ rel: 'cites', target_id: cited.id }]);
    assert.ok(count('/*insertionOrder*/') >= 1, 'the relation read behind get()');

    sql.length = 0;
    store.recordAliases();
    assert.equal(count('/*insertionOrder*/'), 1, 'recordAliases()');

    sql.length = 0;
    assert.equal(store.articlesBySlug('driver-seam').length, 1);
    assert.equal(sql.filter((s) => s.includes('/*jsonText:slug*/')).length, 1, 'articlesBySlug()');

    sql.length = 0;
    assert.equal(store.recordsBySlug('driver-seam').length, 1);
    assert.equal(sql.filter((s) => s.includes('/*jsonText:slug*/')).length, 1, 'recordsBySlug()');

    sql.length = 0;
    assert.deepEqual(store.supersededRecordsBySlug('driver-seam'), []);
    const retired = sql.filter((s) => s.includes('/*jsonText:slug*/'));
    assert.equal(retired.length, 1, 'supersededRecordsBySlug()');
    assert.ok(retired[0].includes('/*insertionOrder*/'), 'its insertion-order tiebreak');

    sql.length = 0;
    assert.deepEqual(store.inboundSupersedes(made.id), []);
    assert.equal(count('/*insertionOrder*/'), 1, 'inboundSupersedes()');

    sql.length = 0;
    assert.deepEqual(store.query({ types: ['todo'], source: 'user' }), []);
    assert.equal(count('/*jsonText:source*/'), 1, 'the source filter');

    sql.length = 0;
    const ranked = store.query({ types: ['feature_article'], rank_terms: ['seamword'] });
    assert.deepEqual(ranked.map((r) => r.id), [made.id]);
    const rankedSql = sql.find((s) => s.includes('/*searchMatch*/'));
    assert.ok(rankedSql, 'query() with rank_terms');
    assert.ok(rankedSql.includes('/*searchJoin*/') && rankedSql.includes('/*searchOrder*/'));
    assert.deepEqual(searchQueries, ['"seamword"']);

    sql.length = 0;
    assert.equal(store.countAboveScore({ types: ['feature_article'], rank_terms: ['seamword'] }, -1000), 1);
    const countSql = sql.find((s) => s.includes('/*searchScore*/'));
    assert.ok(countSql, 'countAboveScore()');
    assert.ok(countSql.includes('/*searchJoin*/') && countSql.includes('/*searchMatch*/'));
    assert.deepEqual(searchQueries, ['"seamword"', '"seamword"']);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SterlingStore source names no database library: index.ts has no DatabaseSync and no node:sqlite import', () => {
  // dist/tests/ -> src/
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const store = readFileSync(join(src, 'index.ts'), 'utf8');
  assert.equal(store.includes('DatabaseSync'), false);
  assert.equal(/from\s+'node:sqlite'/.test(store), false);
  assert.ok(readFileSync(join(src, 'sqlite-driver.ts'), 'utf8').includes('DatabaseSync'), 'the SQLite driver is where it lives');
  assert.equal(/from\s+'node:sqlite'/.test(readFileSync(join(src, 'driver.ts'), 'utf8')), false, 'the interface names no backend');
});
