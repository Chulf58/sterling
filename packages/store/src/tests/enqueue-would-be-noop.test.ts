// SterlingStore.enqueueWouldBeNoop: the read-only half of enqueueSystemTodo's
// dedupe rule, so a read-time minter can skip the write transaction when the
// open item is already current (board 7a75851c review: a hundred overdue
// findings must not cost a hundred write transactions per read). One home for
// the identity key: the check and the enqueue share systemTodoKey.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore } from '../index.js';
import { sqliteOnly } from './pg-test-support.js';

const NOW = '2026-10-03T12:00:00.000Z';
const FINDING = '11111111-1111-4111-8111-111111111111'; // not-a-citation: fixture id
const OTHER_FINDING = '22222222-2222-4222-8222-222222222222'; // not-a-citation: fixture id

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-noop-'));
  const path = join(dir, 'sterling.db');
  const store = new SterlingStore(path);
  return {
    store,
    path,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type SysTodo = { system_reason: string; text: string; feature_link?: string; file_keys?: string[]; [k: string]: unknown };

const sys = (over: Partial<SysTodo> = {}): SysTodo => ({
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
  feature_link: FINDING,
  ...over,
});

test('no open item: the enqueue would write, so the check says false', () => {
  const { store, cleanup } = harness();
  try {
    assert.equal(store.enqueueWouldBeNoop(sys()), false);
  } finally {
    cleanup();
  }
});

test('an open item with the same identity and the same text: the enqueue would be a pure no-op', () => {
  const { store, cleanup } = harness();
  try {
    store.enqueueSystemTodo(sys());
    assert.equal(store.enqueueWouldBeNoop(sys()), true);
  } finally {
    cleanup();
  }
});

test('changed text (escalation), changed file_keys or another subject are NOT no-ops: the write path must still run', () => {
  const { store, cleanup } = harness();
  try {
    store.enqueueSystemTodo(sys({ system_reason: 'refresh_reference', file_keys: ['docs/a.md'], text: 'changed on disk' }));
    const same = { system_reason: 'refresh_reference', file_keys: ['docs/a.md'] };
    assert.equal(store.enqueueWouldBeNoop(sys({ ...same, text: 'changed on disk' })), true);
    assert.equal(store.enqueueWouldBeNoop(sys({ ...same, text: 'no longer exists on disk' })), false, 'text escalation updates the item');
    assert.equal(store.enqueueWouldBeNoop(sys({ ...same, text: 'changed on disk', feature_link: OTHER_FINDING })), false, 'another subject is another item');
  } finally {
    cleanup();
  }
});

test('the reconcile_needed fold lane is never reported as a no-op (its union/fold rule lives only in the write path)', () => {
  const { store, cleanup } = harness();
  try {
    const item = sys({ system_reason: 'reconcile_needed', file_keys: ['src/a.ts'] });
    store.enqueueSystemTodo(item);
    assert.equal(store.enqueueWouldBeNoop(item), false);
  } finally {
    cleanup();
  }
});

test('the check takes no write path: it answers while a second connection has moved user_version (a write would be refused)', { skip: sqliteOnly('moves user_version through a second SQLite connection; Postgres counterpart in pg-store-parity.test.ts') }, () => {
  const { store, path, cleanup } = harness();
  try {
    store.enqueueSystemTodo(sys());
    const other = new DatabaseSync(path);
    try {
      const v = (other.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      other.exec(`PRAGMA user_version = ${v + 1}`);
    } finally {
      other.close();
    }
    assert.throws(() => store.enqueueSystemTodo(sys({ feature_link: OTHER_FINDING })), /Live schema version drift/);
    assert.equal(store.enqueueWouldBeNoop(sys()), true);
  } finally {
    cleanup();
  }
});
