// PgDriver (pg-driver.ts): statement translation, schema names and the
// sterling_meta layout, SterlingStore on Postgres, and the NUL policy.
// Translation and naming run everywhere; the rest needs STERLING_TEST_PG=1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';
import {
  PgDriver,
  PgNulCharacterError,
  PgSchemaNameRefusedError,
  PgStoreExistsError,
  PgStoreMissingError,
  PgUnsupportedError,
  assertSterlingSchemaName,
  createPgStore,
  ensurePgLayout,
  pgDomainSchemaName,
  pgProjectSchemaName,
  translateStatement,
} from '../pg-driver.js';
import type { PgBridge } from '../pg-bridge.js';
import { PG_SKIP, dropTestSchemas, newTestPrefix, openTestBridge, schemasWithPrefix } from './pg-test-support.js';

// ---------------------------------------------------------------------------
// Translation (no network)
// ---------------------------------------------------------------------------

test('translateStatement numbers placeholders and leaves quoted text alone', () => {
  const t = translateStatement("SELECT body FROM records WHERE id = ? AND status != 'a?b' AND type IN (?, ?)", 's1');
  assert.equal(t.text, `SELECT body FROM "s1".records WHERE id = $1 AND status != 'a?b' AND type IN ($2, $3)`);
  assert.equal(t.params, 3);
});

test('translateStatement qualifies every store table, never a column or an alias-qualified name', () => {
  const t = translateStatement(
    'SELECT r.body FROM records r JOIN records_fts f ON f.record_id = r.id WHERE EXISTS (SELECT 1 FROM record_file_keys k WHERE k.record_id = r.id)',
    's1',
  );
  assert.equal(
    t.text,
    'SELECT r.body FROM "s1".records r JOIN "s1".records_fts f ON f.record_id = r.id WHERE EXISTS (SELECT 1 FROM "s1".record_file_keys k WHERE k.record_id = r.id)',
  );
});

test('translateStatement keeps the two upserts as written, which Postgres accepts', () => {
  const t = translateStatement(
    'INSERT INTO store_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    's1',
  );
  assert.equal(
    t.text,
    'INSERT INTO "s1".store_meta (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
});

test('translateStatement maps instr() to strpos() and marks records_fts writes', () => {
  assert.equal(translateStatement('SELECT body FROM records WHERE instr(body, ?) > 0', 's1').text, 'SELECT body FROM "s1".records WHERE strpos(body, $1) > 0');
  assert.equal(translateStatement('INSERT INTO records_fts (record_id, text) VALUES (?, ?)', 's1').derivedText, true);
  assert.equal(translateStatement('UPDATE records_fts SET text = ? WHERE record_id = ?', 's1').derivedText, true);
  assert.equal(translateStatement('SELECT body FROM records WHERE id = ?', 's1').derivedText, false);
});

// ---------------------------------------------------------------------------
// Schema names (no network)
// ---------------------------------------------------------------------------

test('schema names follow postgres-schema-names-sterling-p-uuid-sterling-d-domain', () => {
  assert.equal(pgProjectSchemaName('0B6E2F1A-1C2D-4E5F-8A9B-0C1D2E3F4A5B'), 'sterling_p_0b6e2f1a1c2d4e5f8a9b0c1d2e3f4a5b');
  assert.equal(pgDomainSchemaName('Genesys-Cloud'), 'sterling_d_genesys_cloud');
  assert.equal(pgDomainSchemaName('genesys_cloud'), 'sterling_d_genesys_cloud');
  assert.throws(() => pgProjectSchemaName('not-a-uuid'), PgSchemaNameRefusedError);
  assert.throws(() => pgDomainSchemaName(''), PgSchemaNameRefusedError);
  assert.throws(() => pgDomainSchemaName('x'.repeat(60)), PgSchemaNameRefusedError);
});

test('the schema guard refuses every name outside the sterling_ prefix', () => {
  for (const bad of ['opensterling', 'opensterling_live', 'public', 'pg_catalog', 'Sterling_meta', 'sterling', 'sterling_', 'sterling_x"; DROP', `sterling_${'a'.repeat(60)}`]) {
    assert.throws(() => assertSterlingSchemaName(bad), PgSchemaNameRefusedError, bad);
  }
  for (const good of ['sterling_meta', 'sterling_d_node', 'sterling_test_ab12_meta']) assertSterlingSchemaName(good);
});

// ---------------------------------------------------------------------------
// Against Served
// ---------------------------------------------------------------------------

let bridge: PgBridge | undefined;
const prefix = newTestPrefix();
const meta = `${prefix}_meta`;
let storeCounter = 0;

function live(): PgBridge {
  bridge ??= openTestBridge();
  return bridge;
}

function freshStoreSchema(): string {
  const schema = `${prefix}_${++storeCounter}`;
  ensurePgLayout(live(), meta);
  createPgStore(live(), { kind: 'test', name: schema, schema, metaSchema: meta });
  return schema;
}

function openStore(schema: string): SterlingStore {
  return new SterlingStore(join(tmpdir(), `${schema}.pg`), { driver: new PgDriver(live(), { schema, metaSchema: meta }) });
}

after(() => {
  if (!bridge) return;
  try {
    dropTestSchemas(bridge, prefix);
    assert.deepEqual(schemasWithPrefix(bridge, prefix), []);
  } finally {
    bridge.close();
  }
});

const NOW = '2026-06-10T12:00:00.000Z';

function decision(over: Record<string, unknown> = {}) {
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
    stack_tags: ['node'],
    title: 'Use Postgres',
    statement: 'Postgres holds work-mode stores.',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no joins' }],
    rationale: 'Shared across machines.',
    file_keys: ['packages/store/src/pg-driver.ts'],
    ...over,
  };
}

function article(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type: 'feature_article',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    slug: 'pg-export',
    title: 'PG export',
    what_it_does: 'Exports things.',
    intended_behavior: 'It exports.',
    files: [{ path: 'src/export.ts', role: 'serializer' }],
    current_ac: [{ ac_id: 'AC1', text: 'exports', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
    ...over,
  };
}

test('ensurePgLayout creates the meta schema with the registry, layout version and migration-lock row', { skip: PG_SKIP }, () => {
  ensurePgLayout(live(), meta);
  ensurePgLayout(live(), meta);
  const tables = live()
    .query('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [meta])
    .rows.map((r) => r.tablename);
  assert.deepEqual(tables, ['layout', 'migration_lock', 'stores']);
  assert.deepEqual(live().query(`SELECT layout_version FROM "${meta}".layout`).rows, [{ layout_version: 1 }]);
  assert.equal(live().query(`SELECT count(*) AS n FROM "${meta}".migration_lock`).rows[0].n, 1);
});

test('a store that was never created is a named error, and opening it creates nothing', { skip: PG_SKIP }, () => {
  ensurePgLayout(live(), meta);
  const schema = `${prefix}_never`;
  assert.throws(() => new PgDriver(live(), { schema, metaSchema: meta }), PgStoreMissingError);
  assert.deepEqual(schemasWithPrefix(live(), prefix).filter((s) => s === schema), []);
});

test('a store needs both its schema and its registry row', { skip: PG_SKIP }, () => {
  const rowOnly = freshStoreSchema();
  live().query(`DROP SCHEMA "${rowOnly}"`);
  assert.throws(() => new PgDriver(live(), { schema: rowOnly, metaSchema: meta }), (e: Error) => e instanceof PgStoreMissingError && /schema/.test(e.message));

  const schemaOnly = freshStoreSchema();
  live().query(`DELETE FROM "${meta}".stores WHERE schema_name = $1`, [schemaOnly]);
  assert.throws(() => new PgDriver(live(), { schema: schemaOnly, metaSchema: meta }), (e: Error) => e instanceof PgStoreMissingError && /registry/.test(e.message));
});

test('createPgStore refuses an existing store and a second name that maps to the same schema', { skip: PG_SKIP }, () => {
  const schema = freshStoreSchema();
  assert.throws(() => createPgStore(live(), { kind: 'test', name: schema, schema, metaSchema: meta }), PgStoreExistsError);
  assert.throws(() => createPgStore(live(), { kind: 'test', name: `${schema}-other`, schema, metaSchema: meta }), (e: Error) => e instanceof PgStoreExistsError && /other/.test(e.message));
  assert.throws(() => createPgStore(live(), { kind: 'test', name: 'x', schema: 'opensterling', metaSchema: meta }), PgSchemaNameRefusedError);
});

test('SterlingStore opens a fresh Postgres store, stamps its version and round-trips a record', { skip: PG_SKIP }, () => {
  const schema = freshStoreSchema();
  const store = openStore(schema);
  try {
    assert.equal(store.journalMode(), 'postgres');
    const created = store.create(decision());
    const got = store.get(created.id);
    assert.deepEqual(got, created);
    const version = live().query(`SELECT schema_version FROM "${meta}".stores WHERE schema_name = $1`, [schema]).rows[0].schema_version;
    assert.ok(Number(version) > 0, 'the fresh store was stamped');
  } finally {
    store.close();
  }
  const reopened = openStore(schema);
  try {
    assert.equal(reopened.query({ types: ['decision'] }).length, 1);
  } finally {
    reopened.close();
  }
});

test('ranked search on Postgres matches through the tsvector index and names its score scale', { skip: PG_SKIP }, () => {
  const store = openStore(freshStoreSchema());
  try {
    const hit = store.create(decision({ title: 'Postgres search', statement: 'Ranked search runs on Postgres.' }));
    store.create(decision({ title: 'Unrelated', statement: 'Nothing to see.' }));
    assert.deepEqual(store.query({ rank_terms: ['postgres'] }).map((r) => r.id), [hit.id]);
    assert.equal(store.countAboveScore({ rank_terms: ['postgres'] }, 0), 1);
    assert.equal(store.scoreScale(), 'pg_bm25_v1');
  } finally {
    store.close();
  }
});

test('the driver refuses snapshot and lastInsertRowid by name', { skip: PG_SKIP }, () => {
  const schema = freshStoreSchema();
  const driver = new PgDriver(live(), { schema, metaSchema: meta });
  try {
    assert.throws(() => driver.snapshot(join(tmpdir(), 'x.db')), PgUnsupportedError);
    driver.prepareWritable(true);
    const res = driver.prepare('INSERT INTO store_meta (key, value, updated_at) VALUES (?, ?, ?)').run('k', 'v', NOW);
    assert.equal(res.changes, 1);
    assert.throws(() => res.lastInsertRowid, PgUnsupportedError);
  } finally {
    driver.close();
  }
});

test('NUL policy: the body is lossless, search text holds no NUL, a raw NUL parameter fails loud', { skip: PG_SKIP }, () => {
  const schema = freshStoreSchema();
  const store = openStore(schema);
  try {
    const created = store.create(decision({ statement: 'before\u0000after' }));
    assert.equal((store.get(created.id) as { statement?: string } | undefined)?.statement, 'before\u0000after');
    const fts = live().query(`SELECT text FROM "${schema}".records_fts WHERE record_id = $1`, [created.id]).rows[0].text as string;
    // The fold (search-fold.ts) runs at the write site and makes NUL a word separator, before the driver's own strip is reached.
    assert.ok(fts.includes('before after') && !fts.includes('\u0000'), 'records_fts text holds no NUL: the fold made it a separator');
    const driver = new PgDriver(live(), { schema, metaSchema: meta });
    try {
      assert.throws(() => driver.prepare('SELECT value FROM store_meta WHERE key = ?').get('a\u0000b'), PgNulCharacterError);
    } finally {
      driver.close();
    }
  } finally {
    store.close();
  }
});

test('NUL policy: a slug lookup reads past a NUL in the body and keeps a literal backslash-u0000 text sequence intact', { skip: PG_SKIP }, () => {
  // Ruled 2026-10-06 (slice 3B): jsonText removes only real \u0000 escapes
  // before parsing. The literal six characters \u0000 in a field are stored as
  // the JSON text \\u0000 (an escaped backslash) and must survive.
  const store = openStore(freshStoreSchema());
  try {
    const literal = 'see the \\u0000 escape';
    const created = store.create(article({ what_it_does: 'has a \u0000 in it', intended_behavior: literal }));
    const found = store.articlesBySlug('pg-export');
    assert.deepEqual(found.map((r) => r.id), [created.id]);
    const got = store.get(created.id) as { what_it_does?: string; intended_behavior?: string } | undefined;
    assert.equal(got?.what_it_does, 'has a \u0000 in it');
    assert.equal(got?.intended_behavior, literal);
    assert.equal(literal.length, 'see the '.length + 6 + ' escape'.length, 'the fixture holds the six-character text, not a NUL');
  } finally {
    store.close();
  }
});

test('NUL policy: the extraction strips a NUL inside the extracted value itself and keeps the escaped-backslash form', { skip: PG_SKIP }, () => {
  const schema = freshStoreSchema();
  openStore(schema).close();
  const driver = new PgDriver(live(), { schema, metaSchema: meta });
  try {
    const body = JSON.stringify({ slug: 'a\u0000b', literal: 'x\\u0000y' });
    const sql = `SELECT ${driver.dialect.jsonText('t.b', 'slug')} AS slug, ${driver.dialect.jsonText('t.b', 'literal')} AS literal FROM (SELECT CAST(? AS text) AS b) t`;
    const row = driver.prepare(sql).get(body) as { slug: string; literal: string };
    assert.equal(row.slug, 'ab');
    assert.equal(row.literal, 'x\\u0000y');
  } finally {
    driver.close();
  }
});
