// Postgres search (decision postgres-search-ranking-per-query-idf-no-stats-triggers):
// the query builder, and pins for phrases, repeated words, prefix overlap,
// Danish accents, punctuation, empty normalization and the tsvector limits
// (16,383 positions, 256 positions per lexeme, of which to_tsvector keeps 255). The builder runs everywhere;
// the rest needs STERLING_TEST_PG=1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';
import { PG_RANKINGS, PgDriver, createPgStore, ensurePgLayout, pgDialectFor, pgSearchQuery, type PgRanking } from '../pg-driver.js';
import type { PgBridge } from '../pg-bridge.js';
import { PG_SKIP, dropTestSchemas, newTestPrefix, openTestBridge, schemasWithPrefix } from './pg-test-support.js';

// ---------------------------------------------------------------------------
// The query builder (no network)
// ---------------------------------------------------------------------------

const built = (terms: string[], matchAll?: boolean) => JSON.parse(pgSearchQuery(terms, matchAll)) as { match: string | null; clauses: { q: string; w: string[]; p: boolean }[]; words: string[]; prefixes: string[] };

test('pgSearchQuery: a term is folded into words joined by <->, terms join with | or &', () => {
  assert.equal(built(['store']).match, "('store')");
  assert.equal(built(['driver-seam', 'Store']).match, "('driver' <-> 'seam') | ('store')");
  assert.equal(built(['driver-seam', 'Store'], true).match, "('driver' <-> 'seam') & ('store')");
  assert.deepEqual(built(['driver-seam']).clauses, [{ q: "'driver' <-> 'seam'", w: ['driver', 'seam'], p: false }]);
});

test('pgSearchQuery: a trailing star is read before the fold and becomes :* on the last word', () => {
  assert.equal(built(['stor*']).match, "('stor':*)");
  assert.equal(built(['store-sch*']).match, "('store' <-> 'sch':*)");
  assert.deepEqual(built(['store-sch*']).prefixes, ['sch']);
  assert.equal((JSON.parse(pgSearchQuery(['stor*', 'sch*', 'plain'], undefined)) as { prefixq: string | null }).prefixq, "'stor':* | 'sch':*");
  assert.equal((JSON.parse(pgSearchQuery(['plain'], undefined)) as { prefixq: string | null }).prefixq, null);
  assert.equal(built(['fo*o']).match, "('fo' <-> 'o')", 'a star inside a term is punctuation, as it is to unicode61');
});

test('pgSearchQuery: Danish and punctuation fold as record text does', () => {
  assert.equal(built(['Århus']).match, "('arhus')");
  assert.equal(built(['blåbærgrød']).match, "('blabærgrød')");
  assert.equal(built(['C++']).match, "('c')");
  assert.equal(built(["it's"]).match, "('it' <-> 's')");
});

test('pgSearchQuery: a term that folds to nothing matches nothing, as an empty FTS5 phrase does', () => {
  assert.equal(built(['*']).match, null, "a bare '*' is no prefix and folds to nothing");
  assert.equal(built(['---', '...']).match, null);
  assert.equal(built(['---', 'store']).match, "('store')", 'an OR leaves the empty term out');
  assert.equal(built(['---', 'store'], true).match, null, 'an AND with an empty term matches nothing');
});

test('pgSearchQuery: repeated words stay, so tf counts them; the word list for the tf scan is distinct', () => {
  assert.deepEqual(built(['aa-bb-aa']).clauses[0].w, ['aa', 'bb', 'aa']);
  assert.deepEqual(built(['aa-bb-aa', 'aa']).words, ['aa', 'bb']);
});

test('pgDialectFor: each ranking names its own versioned scale; an unknown one is refused', () => {
  assert.deepEqual(
    PG_RANKINGS.map((r) => pgDialectFor(r).scoreScale),
    ['pg_bm25_v1', 'pg_idf_tsrank_v1', 'pg_tsrank_cd_v1'],
  );
  assert.throws(() => pgDialectFor('bm42' as PgRanking), /ranking must be one of/);
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

function freshStore(ranking?: PgRanking): { store: SterlingStore; schema: string } {
  const schema = `${prefix}_${++storeCounter}`;
  ensurePgLayout(live(), meta);
  createPgStore(live(), { kind: 'test', name: schema, schema, metaSchema: meta });
  const store = new SterlingStore(join(tmpdir(), `${schema}.pg`), { driver: new PgDriver(live(), { schema, metaSchema: meta, ranking }) });
  return { store, schema };
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

/** A todo: its search text is its text alone, so dl and tf are known. */
function todo(text: string) {
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
    text,
    source: 'system',
    system_reason: 'reconcile_needed',
    file_keys: ['src/a.ts'],
  };
}

function ids(store: SterlingStore, terms: string[], matchAll?: boolean): string[] {
  return store.query({ types: ['todo'], rank_terms: terms, match_all: matchAll, cap: 50 }).map((r) => r.id);
}

/** The score the store ranks by, per record id, read through the driver's own search fragments. */
function scores(store: SterlingStore, terms: string[]): Record<string, number> {
  const internal = store as unknown as {
    db: { dialect: { searchJoin: string; searchJoinBinds: number; searchMatch: string; searchScore: string; searchOrder: string; searchQuery: (t: string[], m: boolean | undefined) => string }; prepare: (sql: string) => { all: (...a: unknown[]) => { id: string; score: number }[] } };
  };
  const d = internal.db.dialect;
  const match = d.searchQuery(terms, undefined);
  const rows = internal.db
    .prepare(`SELECT r.id AS id, ${d.searchScore} AS score FROM records r ${d.searchJoin} WHERE ${d.searchMatch} ORDER BY ${d.searchOrder}`)
    .all(...Array(d.searchJoinBinds).fill(match), match);
  return Object.fromEntries(rows.map((r) => [r.id, r.score]));
}

function ftsRows(schema: string): { record_id: string; dl: number; text: string }[] {
  return live().query(`SELECT record_id, dl, text FROM "${schema}".records_fts`).rows as { record_id: string; dl: number; text: string }[];
}

/** FTS5's bm25 for one document, from its clauses' df and tf. */
function bm25(n: number, avgdl: number, dl: number, clauses: { df: number; tf: number }[]): number {
  let sum = 0;
  for (const { df, tf } of clauses) {
    let idf = Math.log((n - df + 0.5) / (df + 0.5));
    if (idf <= 0) idf = 1e-6;
    sum += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * dl) / avgdl));
  }
  return sum;
}

function stats(schema: string) {
  const rows = ftsRows(schema);
  const avgdl = rows.reduce((a, r) => a + r.dl, 0) / rows.length;
  return { n: rows.length, avgdl, dl: Object.fromEntries(rows.map((r) => [r.record_id, r.dl])) };
}

test('records_fts on Postgres holds the folded text, a tsvector and the word count', { skip: PG_SKIP }, () => {
  const { store, schema } = freshStore();
  try {
    const t = store.create(todo('Blåbærgrød i Århus: C++ og "citater"!'));
    const row = ftsRows(schema).find((r) => r.record_id === t.id)!;
    assert.equal(row.text, 'blabærgrød i arhus c og citater');
    assert.equal(row.dl, 6);
    const tsv = live().query(`SELECT tsv::text AS t FROM "${schema}".records_fts WHERE record_id = $1`, [t.id]).rows[0].t;
    assert.equal(tsv, "'arhus':3 'blabærgrød':1 'c':4 'citater':6 'i':2 'og':5", 'one position per folded word');
    store.updateTodo(t.id, { ...t, text: 'Ny tekst' });
    assert.equal(ftsRows(schema).find((r) => r.record_id === t.id)!.text, 'ny tekst', 'the update site folds too');
  } finally {
    store.close();
  }
});

test('phrases: a term with punctuation matches its words only when adjacent and in order; tf counts adjacent pairs', { skip: PG_SKIP }, () => {
  const { store, schema } = freshStore();
  try {
    const adjacent = store.create(todo('the driver seam holds'));
    const apart = store.create(todo('the seam of the driver'));
    const twice = store.create(todo('aa bb aa xx bb'));
    assert.deepEqual(ids(store, ['driver-seam']), [adjacent.id]);
    assert.deepEqual(ids(store, ['seam-driver']), []);
    assert.ok(!ids(store, ['driver-seam']).includes(apart.id));
    // Astra's probe: one 'aa bb' in 'aa bb aa xx bb' is tf 1, not 2.
    const s = stats(schema);
    const got = scores(store, ['aa-bb'])[twice.id];
    assert.ok(Math.abs(got - bm25(s.n, s.avgdl, s.dl[twice.id], [{ df: 1, tf: 1 }])) < 1e-9, `phrase tf is 1: got ${got}`);
  } finally {
    store.close();
  }
});

test('repeated words: tf comes from tsvector positions and the score is FTS5 bm25 with per-query N, avgdl and df', { skip: PG_SKIP }, () => {
  const { store, schema } = freshStore();
  try {
    const five = store.create(todo('alpha alpha alpha alpha alpha beta'));
    const one = store.create(todo('alpha gamma delta epsilon zeta eta'));
    store.create(todo('theta iota kappa'));
    const s = stats(schema);
    const got = scores(store, ['alpha']);
    assert.ok(Math.abs(got[five.id] - bm25(s.n, s.avgdl, 6, [{ df: 2, tf: 5 }])) < 1e-9);
    assert.ok(Math.abs(got[one.id] - bm25(s.n, s.avgdl, 6, [{ df: 2, tf: 1 }])) < 1e-9);
    assert.deepEqual(ids(store, ['alpha']), [five.id, one.id]);
    const both = scores(store, ['alpha', 'beta']);
    assert.ok(Math.abs(both[five.id] - bm25(s.n, s.avgdl, 6, [{ df: 2, tf: 5 }, { df: 1, tf: 1 }])) < 1e-9, 'clauses sum');
    assert.equal(store.countAboveScore({ types: ['todo'], rank_terms: ['alpha'] }, got[one.id]), 2);
    assert.equal(store.countAboveScore({ types: ['todo'], rank_terms: ['alpha'] }, got[five.id]), 1, 'min_score is a floor on the same score');
  } finally {
    store.close();
  }
});

test('prefix overlap: a prefix counts documents for df, never a sum of lexeme dfs, and counts every matching token for tf', { skip: PG_SKIP }, () => {
  const { store, schema } = freshStore();
  try {
    const both = store.create(todo('store storage stored'));
    const single = store.create(todo('store only here'));
    store.create(todo('nothing relevant'));
    assert.deepEqual(new Set(ids(store, ['stor*'])), new Set([both.id, single.id]));
    assert.deepEqual(ids(store, ['stor']), [], 'without the star it is an exact word');
    const s = stats(schema);
    const got = scores(store, ['stor*']);
    assert.ok(Math.abs(got[both.id] - bm25(s.n, s.avgdl, 3, [{ df: 2, tf: 3 }])) < 1e-9, `df 2 (documents), tf 3: got ${got[both.id]}`);
    assert.ok(Math.abs(got[single.id] - bm25(s.n, s.avgdl, 3, [{ df: 2, tf: 1 }])) < 1e-9);
    assert.deepEqual(ids(store, ['store-stor*']), [both.id], 'a phrase whose last word is a prefix');
  } finally {
    store.close();
  }
});

test('Danish accents: å and é fold to a and e on both sides; æ and ø stay letters of their own', { skip: PG_SKIP }, () => {
  const { store } = freshStore();
  try {
    const t = store.create(todo('Blåbærgrød fra Århus, café på Ærø'));
    for (const term of ['arhus', 'Århus', 'blabærgrød', 'blåbærgrød', 'cafe', 'café', 'ærø', 'ÆRØ']) assert.deepEqual(ids(store, [term]), [t.id], term);
    for (const term of ['blabaergrod', 'aero']) assert.deepEqual(ids(store, [term]), [], `${term}: æ and ø are not spelled out`);
  } finally {
    store.close();
  }
});

test('punctuation: it separates words on both sides, so dotted, hyphenated and slashed spellings meet', { skip: PG_SKIP }, () => {
  const { store } = freshStore();
  try {
    const t = store.create(todo('see packages/store/src/pg-driver.ts and C++ (it\'s fine)'));
    for (const term of ['pg-driver', 'pg_driver', 'pg.driver', 'src/pg-driver.ts', 'C++', "it's"]) assert.deepEqual(ids(store, [term]), [t.id], term);
    assert.deepEqual(ids(store, ['driver.pg']), [], 'order still counts');
  } finally {
    store.close();
  }
});

test('empty normalization: a term with no letters or digits matches nothing and never errors', { skip: PG_SKIP }, () => {
  const { store } = freshStore();
  try {
    const t = store.create(todo('store something'));
    assert.deepEqual(ids(store, ['*']), []);
    assert.deepEqual(ids(store, ['---', '!!!']), []);
    assert.equal(store.countAboveScore({ types: ['todo'], rank_terms: ['---'] }, -1000), 0);
    assert.deepEqual(ids(store, ['---', 'store']), [t.id]);
    assert.deepEqual(ids(store, ['---', 'store'], true), []);
    const empty = store.create(todo('!!! ---'));
    assert.equal(stats(freshSchemaOf(store)).dl[empty.id], 0, 'a record whose text folds to nothing has dl 0');
  } finally {
    store.close();
  }
});

function freshSchemaOf(store: SterlingStore): string {
  return (store as unknown as { db: PgDriver }).db.schema;
}

test('limits: to_tsvector keeps 255 positions of a lexeme (the documented cap is 256), so tf caps at 255; positions past 16,383 collapse onto 16,383', { skip: PG_SKIP }, () => {
  const { store, schema } = freshStore();
  try {
    const many = store.create(todo(`${'manyword '.repeat(300)}end`));
    const s1 = stats(schema);
    assert.equal(s1.dl[many.id], 301, 'dl counts every word');
    const positions = live().query(`SELECT cardinality(u.positions) AS n FROM "${schema}".records_fts f, unnest(f.tsv) u WHERE f.record_id = $1 AND u.lexeme = 'manyword'`, [many.id]).rows[0].n;
    assert.equal(positions, 255, 'measured on Served (PostgreSQL 18): to_tsvector stores 255 of the 300');
    const got = scores(store, ['manyword'])[many.id];
    assert.ok(Math.abs(got - bm25(s1.n, s1.avgdl, 301, [{ df: 1, tf: 255 }])) < 1e-9, `tf is 255, not 300: got ${got}`);

    const filler = Array.from({ length: 17000 }, (_, i) => `w${i % 1000}`).join(' ');
    const long = store.create(todo(`nearone neartwo ${filler} farone fartwo`));
    assert.equal(stats(schema).dl[long.id], 17004);
    assert.deepEqual(ids(store, ['nearone-neartwo']), [long.id], 'a phrase inside the first 16,383 positions is found');
    assert.deepEqual(ids(store, ['fartwo']), [long.id], 'a word past 16,383 is still found');
    assert.deepEqual(ids(store, ['farone-fartwo']), [], 'KNOWN LIMIT: a phrase whose words all sit past 16,383 is not found on Postgres');
  } finally {
    store.close();
  }
});

test('every ranking candidate answers the same match set and ranks the stronger match first', { skip: PG_SKIP }, () => {
  for (const ranking of PG_RANKINGS) {
    const { store } = freshStore(ranking);
    try {
      const strong = store.create(todo('rareword rareword rareword common'));
      const weak = store.create(todo('rareword common common common'));
      store.create(todo('common filler words'));
      assert.deepEqual(new Set(ids(store, ['rareword', 'common'])), new Set([strong.id, weak.id, ...ids(store, ['common'])]), ranking);
      assert.equal(ids(store, ['rareword'])[0], strong.id, ranking);
      assert.equal(store.scoreScale(), pgDialectFor(ranking).scoreScale);
      assert.equal(store.countAboveScore({ types: ['todo'], rank_terms: ['rareword'] }, 0), 2, ranking);
    } finally {
      store.close();
    }
  }
});
