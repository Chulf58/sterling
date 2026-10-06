// Postgres equivalents of the backend-neutral behaviour that the SQLite-only
// tests reach through the SQLite file (user_version, a second DatabaseSync
// connection). On Postgres the version lives in the registry row
// <meta>.stores.schema_version, and "another client" is a second bridge.
// Counterparts: schema-version-guard A2/A3, schema-version-live-write-guard
// B2/B3/B4, store-meta, enqueue-would-be-noop. Needs STERLING_TEST_PG=1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPPORTED_SCHEMA_VERSION, SchemaMigrationRequiredError, SterlingStore, UnsupportedSchemaVersionError } from '../index.js';
import { PgDriver, createPgStore, ensurePgLayout } from '../pg-driver.js';
import type { PgBridge } from '../pg-bridge.js';
import { PG_SKIP, dropTestSchemas, newTestPrefix, openTestBridge, schemasWithPrefix } from './pg-test-support.js';

const prefix = newTestPrefix();
const meta = `${prefix}_meta`;
let counter = 0;
let bridge: PgBridge | undefined;
let other: PgBridge | undefined;

const live = (): PgBridge => (bridge ??= openTestBridge());
/** A second client: its own connection, as a second process would have. */
const otherClient = (): PgBridge => (other ??= openTestBridge());

after(() => {
  try {
    if (bridge) {
      dropTestSchemas(bridge, prefix);
      assert.deepEqual(schemasWithPrefix(bridge, prefix), []);
    }
  } finally {
    bridge?.close();
    other?.close();
  }
});

function newSchema(): string {
  const schema = `${prefix}_${++counter}`;
  ensurePgLayout(live(), meta);
  createPgStore(live(), { kind: 'test', name: schema, schema, metaSchema: meta });
  return schema;
}

function open(schema: string): SterlingStore {
  return new SterlingStore(join(tmpdir(), `${schema}.pg`), { driver: new PgDriver(live(), { schema, metaSchema: meta }) });
}

function setVersion(schema: string, version: number): void {
  otherClient().query(`UPDATE "${meta}".stores SET schema_version = $1 WHERE schema_name = $2`, [version, schema]);
}

const NOW = '2026-10-06T12:00:00.000Z';

function decision() {
  return {
    id: randomUUID(),
    type: 'decision',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    title: 'Parity',
    statement: 'Same behaviour on both backends.',
    alternatives_rejected: [{ option: 'none', reason: 'n/a' }],
    rationale: 'parity',
  };
}

function sysTodo(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type: 'todo',
    created_at: NOW,
    updated_at: NOW,
    author: 'system',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    text: 're-verify finding',
    source: 'system',
    system_reason: 'stale_research',
    feature_link: '11111111-1111-4111-8111-111111111111',
    ...over,
  };
}

test('A1 parity: a fresh Postgres store is stamped at the supported version on open', { skip: PG_SKIP }, () => {
  const schema = newSchema();
  open(schema).close();
  assert.equal(Number(live().query(`SELECT schema_version FROM "${meta}".stores WHERE schema_name = $1`, [schema]).rows[0].schema_version), SUPPORTED_SCHEMA_VERSION);
});

test('A3 parity: a store whose version is newer than this code supports refuses to open and writes nothing', { skip: PG_SKIP }, () => {
  const schema = newSchema();
  open(schema).close();
  setVersion(schema, SUPPORTED_SCHEMA_VERSION + 1);
  const tables = live().query('SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1', [schema]).rows[0].n;
  assert.throws(() => open(schema), UnsupportedSchemaVersionError);
  assert.equal(live().query('SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1', [schema]).rows[0].n, tables);
});

test('A2 parity: an existing store below the supported version opens read-only; reads work, writes refuse naming the migration', { skip: PG_SKIP }, () => {
  const schema = newSchema();
  const store = open(schema);
  const created = store.create(decision());
  store.close();
  setVersion(schema, SUPPORTED_SCHEMA_VERSION - 1);
  const legacy = open(schema);
  try {
    assert.equal(legacy.get(created.id)?.id, created.id);
    assert.throws(() => legacy.create(decision()), SchemaMigrationRequiredError);
    assert.throws(() => legacy.setMeta('k', 'v'), SchemaMigrationRequiredError);
  } finally {
    legacy.close();
  }
});

test('B2/B3 parity: a write after another client moved the version is refused, names both versions, and leaves no row', { skip: PG_SKIP }, () => {
  const schema = newSchema();
  const store = open(schema);
  try {
    setVersion(schema, SUPPORTED_SCHEMA_VERSION + 1);
    const rec = decision();
    assert.throws(() => store.create(rec), (e: Error) => /Live schema version drift/.test(e.message) && e.message.includes(String(SUPPORTED_SCHEMA_VERSION + 1)));
    assert.equal(live().query(`SELECT count(*) AS n FROM "${schema}".records WHERE id = $1`, [rec.id]).rows[0].n, 0);
  } finally {
    store.close();
  }
});

test('B4 parity: a read after the version moved does not throw', { skip: PG_SKIP }, () => {
  const schema = newSchema();
  const store = open(schema);
  try {
    const created = store.create(decision());
    setVersion(schema, SUPPORTED_SCHEMA_VERSION + 1);
    assert.equal(store.get(created.id)?.id, created.id);
  } finally {
    store.close();
  }
});

test('store_meta parity: a fresh store has no keys, setMeta round-trips, overwrites in place and survives a reopen; an empty key is refused', { skip: PG_SKIP }, () => {
  const schema = newSchema();
  const store = open(schema);
  try {
    assert.equal(store.getMeta('description'), undefined);
    store.setMeta('description', 'first');
    store.setMeta('description', 'second');
    assert.equal(store.getMeta('description'), 'second');
    assert.throws(() => store.setMeta('', 'x'));
    assert.equal(live().query(`SELECT count(*) AS n FROM "${schema}".store_meta`).rows[0].n, 1, 'one row, overwritten in place');
  } finally {
    store.close();
  }
  const reopened = open(schema);
  try {
    assert.equal(reopened.getMeta('description'), 'second');
  } finally {
    reopened.close();
  }
});

test('enqueue-would-be-noop parity: the check answers while another client has moved the version, and a write would be refused', { skip: PG_SKIP }, () => {
  const schema = newSchema();
  const store = open(schema);
  try {
    store.enqueueSystemTodo(sysTodo());
    setVersion(schema, SUPPORTED_SCHEMA_VERSION + 1);
    assert.throws(() => store.enqueueSystemTodo(sysTodo({ feature_link: '22222222-2222-4222-8222-222222222222' })), /Live schema version drift/);
    assert.equal(store.enqueueWouldBeNoop(sysTodo()), true);
  } finally {
    store.close();
  }
});
