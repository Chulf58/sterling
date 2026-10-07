// queryEach and inboundSupersedesEach (board f6c4bc5d): one call answers a
// list, and element i must be exactly what the single-item method returns for
// item i. Runs on SQLite; with STERLING_TEST_PG=1 (pg-test-setup.ts) the same
// stores open on Postgres. The last test pins the Postgres round-trip saving:
// a read transaction's BEGIN rides with its first statement.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';
import { PgBridge } from '../pg-bridge.js';
import { PG_SKIP } from './pg-test-support.js';

const NOW = '2026-10-06T12:00:00.000Z';
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function openStore(): SterlingStore {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-query-each-'));
  dirs.push(dir);
  return new SterlingStore(join(dir, 'sterling.db'));
}

function envelope(type: string) {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}
const hazard = (i: number, fileKey: string) => ({
  ...envelope('anti_pattern'),
  title: `broker hazard ${i} widget`,
  trigger: `a hook dispatch widget case ${i}`,
  guidance: 'g',
  wrong_way: 'w',
  right_way: 'r',
  source_evidence: 'e',
  basis: 'codebase',
  file_keys: [fileKey],
});
const decision = (i: number) => ({
  ...envelope('decision'),
  title: `broker decision ${i} widget`,
  statement: `hooks reach the broker widget, case ${i}`,
  alternatives_rejected: [],
  rationale: 'r',
  file_keys: ['src/a.mjs'],
});

function seeded() {
  const store = openStore();
  for (let i = 0; i < 4; i++) store.create(hazard(i, i % 2 ? 'src/a.mjs' : 'src/b.mjs'));
  const decisions = [0, 1, 2].map((i) => store.create(decision(i)));
  // decision 0 is superseded by a newer one, so inboundSupersedes has something to find.
  const successor = store.supersede(decisions[0].id, { ...decision(9), title: 'broker decision successor widget' });
  return { store, decisions, successor };
}

test('queryEach: element i is query(list[i]) for ranked, mechanical, file-key and empty-result entries; an empty list is []', () => {
  const { store } = seeded();
  try {
    const list = [
      { types: ['anti_pattern'], rank_terms: ['widget'], cap: 40 },
      { types: ['decision'], rank_terms: ['widget'], cap: 2 },
      { types: ['decision'], rank_terms: ['nomatchterm'], cap: 40 },
      { types: ['anti_pattern', 'decision'], file_keys: ['src/a.mjs'], cap: 10 },
      { types: ['anti_pattern'] },
    ];
    const each = store.queryEach(list);
    assert.equal(each.length, list.length);
    list.forEach((opts, i) => assert.deepEqual(each[i], store.query(opts), `entry ${i}`));
    assert.ok(each[0].length > 0 && each[1].length === 2 && each[2].length === 0, 'the fixture exercises hits, a cap and an empty result');
    assert.deepEqual(store.queryEach([]), []);
  } finally {
    store.close();
  }
});

test('inboundSupersedesEach: element i is inboundSupersedes(ids[i]), repeated and unknown ids included; an empty list is []', () => {
  const { store, decisions, successor } = seeded();
  try {
    const ids = [decisions[0].id, decisions[1].id, 'no-such-id', decisions[0].id, successor.id];
    const each = store.inboundSupersedesEach(ids);
    assert.equal(each.length, ids.length);
    ids.forEach((id, i) => assert.deepEqual(each[i], store.inboundSupersedes(id), `id ${i}`));
    assert.deepEqual(each[0].map((r) => r.id), [successor.id], 'the superseded decision names its successor');
    assert.deepEqual(store.inboundSupersedesEach([]), []);
  } finally {
    store.close();
  }
});

test('Postgres: a read transaction sends its BEGIN in the same round trip as its first statement, never on its own; a write keeps its own BEGIN', { skip: PG_SKIP }, () => {
  const store = openStore();
  const calls: { text: string; prefix: string | undefined }[] = [];
  const original = PgBridge.prototype.query;
  PgBridge.prototype.query = function (this: PgBridge, text: string, values?: unknown[], prefix?: string) {
    calls.push({ text, prefix });
    return original.call(this, text, values, prefix);
  };
  try {
    store.create(hazard(1, 'src/a.mjs'));
    assert.equal(calls.filter((c) => c.prefix !== undefined).length, 0, 'a write transaction still sends BEGIN on its own (begin() takes the lock or throws)');
    calls.length = 0;
    assert.equal(store.queryEach([{ types: ['anti_pattern'], rank_terms: ['widget'] }, { types: ['decision'], rank_terms: ['widget'] }])[0].length, 1);
    assert.match(calls[0].prefix ?? '', /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/, 'the read BEGIN rides with the first SELECT');
    assert.equal(calls.filter((c) => /^\s*BEGIN/.test(c.text)).length, 0, 'no BEGIN goes out on its own');
    assert.equal(calls.filter((c) => c.text === 'COMMIT').length, 1, 'one read transaction for the whole list');
  } finally {
    PgBridge.prototype.query = original;
    store.close();
  }
});
