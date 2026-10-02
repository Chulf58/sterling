// store_meta (board 675daf9d part (a), decision projects-mount-domains-and-sibling-projects):
// one key/value table in every store, created additively by the DDL, read and
// written through getMeta/setMeta. A domain's description is its 'description' key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, SUPPORTED_SCHEMA_VERSION, SchemaMigrationRequiredError } from '../index.js';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-store-meta-'));
  return { dir, path: join(dir, 'sterling.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function rawMetaRows(path: string): { key: string; value: string; updated_at: string }[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT key, value, updated_at FROM store_meta ORDER BY key').all() as {
      key: string;
      value: string;
      updated_at: string;
    }[];
  } finally {
    db.close();
  }
}

test('store_meta: a fresh store has the table and no keys; getMeta of an unset key is undefined', () => {
  const t = tempDb();
  const store = new SterlingStore(t.path);
  try {
    assert.equal(store.getMeta('description'), undefined);
    assert.deepEqual(rawMetaRows(t.path), [], 'the table exists and is empty');
  } finally {
    store.close();
    t.cleanup();
  }
});

test('store_meta: setMeta round-trips, overwrites in place, stamps updated_at, and survives a reopen', () => {
  const t = tempDb();
  let store = new SterlingStore(t.path);
  try {
    store.setMeta('description', 'Genesys Cloud: routing, flows, APIs');
    assert.equal(store.getMeta('description'), 'Genesys Cloud: routing, flows, APIs');
    const first = rawMetaRows(t.path);
    assert.equal(first.length, 1);
    assert.ok(!Number.isNaN(Date.parse(first[0].updated_at)), 'updated_at is an ISO timestamp');

    store.setMeta('description', 'second');
    assert.equal(store.getMeta('description'), 'second');
    assert.equal(rawMetaRows(t.path).length, 1, 'one row per key: overwrite, never a second row');

    store.close();
    store = new SterlingStore(t.path);
    assert.equal(store.getMeta('description'), 'second', 'the value is durable across a reopen');
  } finally {
    store.close();
    t.cleanup();
  }
});

test('store_meta: an empty key is refused and nothing is written', () => {
  const t = tempDb();
  const store = new SterlingStore(t.path);
  try {
    assert.throws(() => store.setMeta('', 'x'), /key/);
    assert.deepEqual(rawMetaRows(t.path), []);
  } finally {
    store.close();
    t.cleanup();
  }
});

test('store_meta: additive — an existing v2 store without the table gains it on open with no user_version bump', () => {
  const t = tempDb();
  try {
    new SterlingStore(t.path).close();
    const raw = new DatabaseSync(t.path);
    raw.exec('DROP TABLE store_meta');
    raw.close();

    const store = new SterlingStore(t.path);
    try {
      store.setMeta('description', 'd');
      assert.equal(store.getMeta('description'), 'd');
    } finally {
      store.close();
    }
    const check = new DatabaseSync(t.path, { readOnly: true });
    const v = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    check.close();
    assert.equal(v, SUPPORTED_SCHEMA_VERSION, 'the schema version is unchanged by the additive table');
  } finally {
    t.cleanup();
  }
});

test('store_meta: a pre-v2 (read-only) store refuses getMeta and setMeta with the migration error', () => {
  const t = tempDb();
  try {
    const raw = new DatabaseSync(t.path);
    raw.exec('CREATE TABLE records (id TEXT PRIMARY KEY); PRAGMA user_version = 1;');
    raw.close();
    const store = new SterlingStore(t.path);
    try {
      assert.throws(() => store.getMeta('description'), SchemaMigrationRequiredError);
      assert.throws(() => store.setMeta('description', 'x'), SchemaMigrationRequiredError);
    } finally {
      store.close();
    }
  } finally {
    t.cleanup();
  }
});
