// Two writers on one store (board 895d3c6c): retireInFavorOf validates the
// retiree AND the survivor inside its write transaction, and updateTodo's
// expected_version refuses a write merged from a stale read. Each case opens
// two SterlingStore handles on the same store, the way two sessions or two
// machines do. The interleaving is forced deterministically: handle B's write
// is run from a hook on handle A, at the point where A has done everything it
// does before taking the write lock. The Postgres cases need STERLING_TEST_PG=1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';
import { PgDriver, createPgStore, ensurePgLayout } from '../pg-driver.js';
import type { PgBridge } from '../pg-bridge.js';
import { PG_SKIP, PG_TESTS_ENABLED, dropTestSchemas, newTestPrefix, openTestBridge, schemasWithPrefix } from './pg-test-support.js';

const NOW = '2026-10-06T12:00:00.000Z';
const LATER = '2026-10-06T13:00:00.000Z';

function envelope(type: string) {
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
    stack_tags: [],
  };
}

function decision(statement: string) {
  return { ...envelope('decision'), title: `decision ${statement}`, statement, alternatives_rejected: [], rationale: 'r' };
}

function userTodo() {
  return { ...envelope('todo'), text: 'board item', source: 'user', priority: 'normal' };
}

type Pair = { a: SterlingStore; b: SterlingStore; close: () => void };

function sqlitePair(): Pair {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-two-writer-'));
  const path = join(dir, 'sterling.db');
  const a = new SterlingStore(path);
  const b = new SterlingStore(path);
  return {
    a,
    b,
    close: () => {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const prefix = newTestPrefix();
const meta = `${prefix}_meta`;
let counter = 0;
const bridges: PgBridge[] = [];
let admin: PgBridge | undefined;

function bridge(): PgBridge {
  const br = openTestBridge();
  bridges.push(br);
  return br;
}

function pgPair(): Pair {
  admin ??= bridge();
  const schema = `${prefix}_${++counter}`;
  ensurePgLayout(admin, meta);
  createPgStore(admin, { kind: 'test', name: schema, schema, metaSchema: meta });
  const a = new SterlingStore(join(tmpdir(), `${schema}-a.pg`), { driver: new PgDriver(bridge(), { schema, metaSchema: meta }) });
  const b = new SterlingStore(join(tmpdir(), `${schema}-b.pg`), { driver: new PgDriver(bridge(), { schema, metaSchema: meta }) });
  return {
    a,
    b,
    close: () => {
      a.close();
      b.close();
    },
  };
}

after(() => {
  if (!PG_TESTS_ENABLED) return;
  try {
    if (admin && !admin.closed) {
      dropTestSchemas(admin, prefix);
      assert.deepEqual(schemasWithPrefix(admin, prefix), []);
    }
  } finally {
    for (const br of bridges) if (!br.closed) br.close();
  }
});

/** Run `between` once, the first time `store` opens a write transaction, just before it begins. */
function beforeFirstWriteTx(store: SterlingStore, between: () => void): void {
  const handle = store as unknown as { tx: (fn: () => void) => void };
  const original = handle.tx.bind(store);
  let fired = false;
  handle.tx = (fn: () => void) => {
    if (!fired) {
      fired = true;
      between();
    }
    original(fn);
  };
}

function crossedRetireIsRefused(pair: Pair): void {
  const { a, b } = pair;
  const x = a.create(decision('x'));
  const y = a.create(decision('y'));
  // A retires X in favour of Y; B retires Y in favour of X and commits first.
  beforeFirstWriteTx(a, () => b.retireInFavorOf(y.id, x.id, LATER));
  assert.throws(
    () => a.retireInFavorOf(x.id, y.id, LATER),
    /replacement '.*' is itself retired/,
    'A must see, under its write lock, that its survivor Y was retired by B'
  );
  const xAfter = b.get(x.id) as unknown as { status: string; superseded_by: string | null };
  const yAfter = b.get(y.id) as unknown as { status: string; superseded_by: string | null };
  assert.equal(yAfter.status, 'superseded', "B's retirement of Y stands");
  assert.equal(yAfter.superseded_by, x.id);
  assert.equal(xAfter.status, 'active', 'X stays live: there is no cycle of two retired records forwarding to each other');
  assert.equal(xAfter.superseded_by, null);
}

function staleTodoWriteIsRefused(pair: Pair): void {
  const { a, b } = pair;
  const item = a.create(userTodo()) as unknown as Record<string, unknown> & { id: string; version: number };
  const read = a.get(item.id) as unknown as Record<string, unknown> & { version: number };
  b.updateTodo(item.id, { ...read, priority: 'high', updated_at: LATER }, { expected_version: read.version });
  assert.throws(
    () => a.updateTodo(item.id, { ...read, text: 'board item, reworded', updated_at: LATER }, { expected_version: read.version }),
    /stale expected_version/,
    "a write merged from the pre-B read must be refused, not revert B's priority"
  );
  const final = b.get(item.id) as unknown as { priority: string; text: string; version: number };
  assert.equal(final.priority, 'high');
  assert.equal(final.text, 'board item');
  assert.equal(final.version, read.version + 1);
}

test('two writers, SQLite: crossed retirements X->Y and Y->X cannot both commit', () => {
  const pair = sqlitePair();
  try {
    crossedRetireIsRefused(pair);
  } finally {
    pair.close();
  }
});

test('two writers, Postgres: crossed retirements X->Y and Y->X cannot both commit', { skip: PG_SKIP }, () => {
  const pair = pgPair();
  try {
    crossedRetireIsRefused(pair);
  } finally {
    pair.close();
  }
});

test('two writers, SQLite: updateTodo with the version read before another handle wrote is refused', () => {
  const pair = sqlitePair();
  try {
    staleTodoWriteIsRefused(pair);
  } finally {
    pair.close();
  }
});

test('two writers, Postgres: updateTodo with the version read before another handle wrote is refused', { skip: PG_SKIP }, () => {
  const pair = pgPair();
  try {
    staleTodoWriteIsRefused(pair);
  } finally {
    pair.close();
  }
});
