// ------------- Tasks-tab `blocked by` line (decision every-user-ask-is-boarded-at-intake-with-slim-blocked-by, rule 6) -------------
//
// A user board item may carry `blocked_by: string[]` (board slugs). The card shows
// ONE line, `blocked by: <slug>, <slug>`, listing only the blockers still OPEN (a
// blocker that was removed counts as closed). When every blocker is closed, or the
// item has none, the card shows no such line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { todoCards, blockedByLine } from '../viewmodel.js';
import { buildDashboardState, initialUi, TASKS_TAB } from '../state.js';

const NOW = '2026-10-01T12:00:00.000Z';

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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-blocked-by-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function mkTodo(store: SterlingStore, over: Record<string, unknown>): { id: string } {
  const rec = { ...envelope('todo'), source: 'user', ...over };
  return store.create(rec as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };
}

test('blockedByLine: lists the open slugs in order in the ruled shape', () => {
  assert.equal(blockedByLine(['define-the-schema', 'land-the-store']), 'blocked by: define-the-schema, land-the-store');
  assert.equal(blockedByLine(['define-the-schema']), 'blocked by: define-the-schema');
});

test('blockedByLine: no open blockers means no line', () => {
  assert.equal(blockedByLine([]), undefined);
});

test('todoCards: the card lists only OPEN blockers; a removed blocker drops off; all closed means no line', () => {
  const { store, cleanup } = fixture();
  try {
    const a = mkTodo(store, { text: 'Define the schema', slug: 'define-the-schema' });
    const b = mkTodo(store, { text: 'Land the store', slug: 'land-the-store' });
    const d = mkTodo(store, { text: 'Wire the consumer', slug: 'wire-the-consumer', blocked_by: ['define-the-schema', 'land-the-store'] });
    const card = () => todoCards(store).find((c) => c.id === d.id)!;
    assert.equal(card().blocked, 'blocked by: define-the-schema, land-the-store');
    store.remove(a.id);
    assert.equal(card().blocked, 'blocked by: land-the-store', 'the removed blocker counts as closed and is not listed');
    store.remove(b.id);
    assert.equal(card().blocked, undefined, 'every blocker closed: no line');
  } finally {
    cleanup();
  }
});

test('Tasks tab: the expanded card renders the blocked-by line as its own line', () => {
  const { store, cleanup } = fixture();
  try {
    mkTodo(store, { text: 'Define the schema', slug: 'define-the-schema' });
    const d = mkTodo(store, { text: 'Wire the consumer', slug: 'wire-the-consumer', blocked_by: ['define-the-schema'] });
    const state = buildDashboardState(store, { ...initialUi, tab: TASKS_TAB, expanded: [d.id] }, 80);
    const row = state.rows.find((r) => r.id === d.id);
    assert.ok(row, 'the blocked item has a row');
    const texts = row.lines.map((l) => l.text.trim());
    assert.ok(texts.includes('blocked by: define-the-schema'), `one line reads exactly 'blocked by: define-the-schema' — got ${JSON.stringify(texts)}`);
  } finally {
    cleanup();
  }
});
