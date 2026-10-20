// ------------------- boardReadiness(): the one readiness function -------------------
// decision board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start
// (AMENDED (a)): readiness is computed once, here, and the board tools'
// blocked_by_state, H1, H20, the TUI and the OpenCode plugin all read it.
//
// Per live user item: blockers (each stored slug, open or closed), blockers_open
// and unblocks as item names `name (id8)` (never bare slugs, the former ruling 'board-item-label-comes-from-current-text-the-slug-stays-an-immutable-address' (not in the current store)),
// needs, and state:
//   waiting  — needs 'user' or 'grill', whatever the blocker state
//   blocked  — at least one blocker still open (ahead of investigation and of no needs)
//   research — needs 'investigation'
//   ready    — otherwise
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, boardWaitAge, boardWriteOverlaps, compareBoardReadiness } from '../index.js';

const NOW = '2026-10-03T12:00:00.000Z';

function envelope(at = NOW) {
  return {
    id: randomUUID(),
    type: 'todo',
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-readiness-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

function mk(store: SterlingStore, over: Record<string, unknown>): { id: string } {
  const at = typeof over.updated_at === 'string' ? over.updated_at : NOW;
  return store.create({ ...envelope(at), source: 'user', ...over } as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };
}

const handle = (text: string, id: string) => `${text} (${id.slice(0, 8)})`;

test('boardReadiness: state per item — ready, research, waiting, blocked (user/grill wait whatever the blockers; blocked wins over investigation)', () => {
  const { store, cleanup } = fixture();
  try {
    const a = mk(store, { text: 'Define the schema', slug: 'define-the-schema' });
    const r = mk(store, { text: 'Investigate the hook', slug: 'investigate-the-hook', needs: 'investigation' });
    const u = mk(store, { text: 'Ask the user', slug: 'ask-the-user', needs: 'user' });
    const g = mk(store, { text: 'Grill the plan', slug: 'grill-the-plan', needs: 'grill' });
    const b = mk(store, { text: 'Wire the consumer', slug: 'wire-the-consumer', needs: 'grill', blocked_by: ['define-the-schema'] });
    const bi = mk(store, { text: 'Probe after schema', needs: 'investigation', blocked_by: ['define-the-schema'] });
    const bn = mk(store, { text: 'Build after schema', blocked_by: ['define-the-schema'] });
    const byId = new Map(store.boardReadiness().map((e) => [e.id, e]));
    assert.equal(byId.get(a.id)!.state, 'ready');
    assert.equal(byId.get(r.id)!.state, 'research');
    assert.equal(byId.get(u.id)!.state, 'waiting');
    assert.equal(byId.get(g.id)!.state, 'waiting');
    assert.equal(byId.get(b.id)!.state, 'waiting', 'needs grill waits for the user whatever the blocker state');
    assert.deepEqual(byId.get(b.id)!.blockers_open, [handle('Define the schema', a.id)], 'the open blocker stays reported on a waiting item');
    assert.equal(byId.get(bi.id)!.state, 'blocked', 'an open blocker wins over investigation');
    assert.equal(byId.get(bn.id)!.state, 'blocked');
    assert.equal(byId.get(b.id)!.needs, 'grill');
    assert.equal(byId.get(a.id)!.needs, undefined);
  } finally {
    cleanup();
  }
});

test('boardReadiness: blockers carry each slug and state; blockers_open and unblocks are item names, never slugs', () => {
  const { store, cleanup } = fixture();
  try {
    const a = mk(store, { text: 'Define the schema\nmore', slug: 'define-the-schema' });
    const b = mk(store, { text: 'Land the store', slug: 'land-the-store' });
    const d = mk(store, { text: 'Wire the consumer', slug: 'wire-the-consumer', blocked_by: ['define-the-schema', 'land-the-store'] });
    const get = (id: string) => store.boardReadiness().find((e) => e.id === id)!;
    assert.deepEqual(get(d.id).blockers, [
      { slug: 'define-the-schema', state: 'open' },
      { slug: 'land-the-store', state: 'open' },
    ]);
    assert.deepEqual(get(d.id).blockers_open, [handle('Define the schema', a.id), handle('Land the store', b.id)]);
    assert.deepEqual(get(a.id).unblocks, [handle('Wire the consumer', d.id)]);
    assert.deepEqual(get(d.id).unblocks, []);
    store.remove(a.id);
    assert.deepEqual(get(d.id).blockers, [
      { slug: 'define-the-schema', state: 'closed' },
      { slug: 'land-the-store', state: 'open' },
    ], 'a removed blocker reads as closed; the stored list is not rewritten');
    assert.deepEqual(get(d.id).blockers_open, [handle('Land the store', b.id)]);
    assert.equal(get(d.id).state, 'blocked');
    store.remove(b.id);
    assert.equal(get(d.id).state, 'ready', 'every blocker closed: ready');
    assert.deepEqual(get(d.id).blockers_open, []);
  } finally {
    cleanup();
  }
});

test('boardReadiness: system items are never listed; explicit records are judged against the live board', () => {
  const { store, cleanup } = fixture();
  try {
    mk(store, { text: 'Define the schema', slug: 'define-the-schema' });
    store.create({ ...envelope(), source: 'system', system_reason: 'reconcile_needed', text: 'reconcile x' } as unknown as Parameters<SterlingStore['create']>[0]);
    const all = store.boardReadiness();
    assert.equal(all.length, 1);
    const d = mk(store, { text: 'Wire', slug: 'wire', blocked_by: ['define-the-schema'] });
    const only = store.boardReadiness([store.get(d.id)!]);
    assert.equal(only.length, 1);
    assert.equal(only[0].id, d.id);
    assert.equal(only[0].state, 'blocked');
  } finally {
    cleanup();
  }
});

test('compareBoardReadiness: priority high > normal (absent) > low, then most recently updated first', () => {
  const { store, cleanup } = fixture();
  try {
    const low = mk(store, { text: 'Low', priority: 'low', updated_at: '2026-10-03T13:00:00.000Z' });
    const oldNormal = mk(store, { text: 'Old normal', updated_at: '2026-10-01T00:00:00.000Z' });
    const newNormal = mk(store, { text: 'New normal', priority: 'normal', updated_at: '2026-10-02T00:00:00.000Z' });
    const high = mk(store, { text: 'High', priority: 'high', updated_at: '2026-09-01T00:00:00.000Z' });
    const order = [...store.boardReadiness()].sort(compareBoardReadiness).map((e) => e.id);
    assert.deepEqual(order, [high.id, newNormal.id, oldNormal.id, low.id]);
  } finally {
    cleanup();
  }
});

// GitHub issue #175: needs 'external' waits on an outside party. Its state stays
// 'waiting' (readiness says what can run; needs says why not), and the shared
// result carries needs_reason and needs_set_at so every surface can word it.
test('boardReadiness: needs external is waiting whatever the blockers, with its reason and needs_set_at carried through', () => {
  const { store, cleanup } = fixture();
  try {
    const blocker = mk(store, { text: 'Blocker', slug: 'blocker' });
    const e = mk(store, { text: 'Vendor', slug: 'vendor', needs: 'external', needs_reason: 'vendor reply', needs_set_at: NOW, blocked_by: ['blocker'] });
    const r = store.boardReadiness().find((x) => x.id === e.id);
    assert.equal(r?.state, 'waiting');
    assert.equal(r?.needs, 'external');
    assert.equal(r?.needs_reason, 'vendor reply');
    assert.equal(r?.needs_set_at, NOW);
    assert.deepEqual(r?.blockers_open, [handle('Blocker', blocker.id)]);
    assert.equal('needs_reason' in (store.boardReadiness().find((x) => x.id === blocker.id) ?? {}), false);
  } finally {
    cleanup();
  }
});

test('boardWriteOverlaps: each item maps to the other items sharing a file_keys path; an item sharing none is absent', () => {
  const marks = boardWriteOverlaps([
    { id: 'a', name: 'A', file_keys: ['x.ts', 'y.ts'] },
    { id: 'b', name: 'B', file_keys: ['y.ts'] },
    { id: 'c', name: 'C', file_keys: ['z.ts'] },
  ]);
  assert.deepEqual([...marks.entries()], [['a', ['B']], ['b', ['A']]]);
});

test('boardWaitAge: date and days or hours from needs_set_at; since unknown without a valid stamp', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  assert.equal(boardWaitAge('2026-10-18T09:00:00.000Z', now), 'since 2026-10-18, 2d ago');
  assert.equal(boardWaitAge('2026-10-20T07:30:00.000Z', now), 'since 2026-10-20, 4h ago');
  assert.equal(boardWaitAge(undefined, now), 'since unknown');
  assert.equal(boardWaitAge('not a date', now), 'since unknown');
});
