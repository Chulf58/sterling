// ------------------- board `needs` and `unblocks`, TOOL half -------------------
// decision board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start.
//
// board_add and board_update set `needs` (user | grill | investigation) on
// source:'user' items; board_update with needs:'' clears it. A system item is
// refused naming the field, with nothing written. board_get and board_query's
// text/full rows return `needs` and `unblocks`: the live items whose blocked_by
// names this one, as `name (id8)`, never bare slugs (the former ruling 'board-item-label-comes-from-current-text-the-slug-stays-an-immutable-address' (not in the current store)).
// blocked_by_state keeps its stored-slug shape and now comes from the store's
// one readiness function, boardReadiness().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-03T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-needs-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  return { store, tools, cleanup: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

type Loose = Record<string, unknown>;

function userItem(tools: SterlingTools, headline: string, extra: Loose = {}): Loose {
  return tools.boardAdd({ text: `${headline}\nsee packages/store/src/index.ts:1`, source: 'user', objective: 'standalone', ...extra }).record as unknown as Loose;
}

const handle = (headline: string, id: unknown) => `${headline} (${String(id).slice(0, 8)})`;

test('board_add needs: stored on a user item; absent when not passed', () => {
  const { tools, cleanup } = harness();
  try {
    const g = userItem(tools, 'Grill the plan', { needs: 'grill' });
    assert.equal(g.needs, 'grill');
    assert.equal((tools.boardGet(g.id as string) as unknown as Loose).needs, 'grill');
    const plain = userItem(tools, 'Plain task');
    assert.equal('needs' in plain, false);
  } finally {
    cleanup();
  }
});

test('board_add needs: refused on a system item, naming the field, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const before = tools.boardQuery({ source: 'system' }).length;
    assert.throws(
      () => tools.boardAdd({ text: 'reconcile x', source: 'system', system_reason: 'reconcile_needed', needs: 'investigation' }),
      /board_add: 'needs' marks source:'user' board tasks only/
    );
    assert.equal(tools.boardQuery({ source: 'system' }).length, before);
  } finally {
    cleanup();
  }
});

test('board_add needs: a value outside user|grill|investigation is refused', () => {
  const { tools, cleanup } = harness();
  try {
    assert.throws(() => userItem(tools, 'Bad needs', { needs: 'review' }), /needs/);
  } finally {
    cleanup();
  }
});

test('board_update needs: sets, changes, and an empty string clears it to absent', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Investigate the hook');
    assert.equal((tools.boardUpdate(a.id as string, { needs: 'investigation' }) as unknown as Loose).needs, 'investigation');
    assert.equal((tools.boardUpdate(a.id as string, { needs: 'user' }) as unknown as Loose).needs, 'user');
    const cleared = tools.boardUpdate(a.id as string, { needs: '' }) as unknown as Loose;
    assert.equal('needs' in cleared, false, 'needs:"" clears the field');
    assert.equal('needs' in (tools.boardGet(a.id as string) as unknown as Loose), false);
  } finally {
    cleanup();
  }
});

test('board_update needs: refused on a system item', () => {
  const { tools, cleanup } = harness();
  try {
    const s = tools.boardAdd({ text: 'reconcile y', source: 'system', system_reason: 'reconcile_needed' }).record as unknown as Loose;
    assert.throws(() => tools.boardUpdate(s.id as string, { needs: 'user' }), /board_update: 'needs' marks source:'user' board tasks only/);
  } finally {
    cleanup();
  }
});

test('board_get and board_query: unblocks lists dependents as name (id8); blocked_by_state keeps slugs; needs on text rows', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema', { needs: 'investigation' });
    const d = userItem(tools, 'Wire the consumer', { blocked_by: [a.slug] });
    const e = userItem(tools, 'Ship the docs', { blocked_by: [a.slug] });
    const got = tools.boardGet(a.id as string) as unknown as Loose;
    assert.deepEqual([...(got.unblocks as string[])].sort(), [handle('Wire the consumer', d.id), handle('Ship the docs', e.id)].sort());
    const gotD = tools.boardGet(d.id as string) as unknown as Loose;
    assert.deepEqual(gotD.blocked_by_state, [{ slug: a.slug, state: 'open' }]);
    assert.equal('unblocks' in gotD, false, 'no dependents: no unblocks key');
    const rows = tools.boardQueryResult({ source: 'user' }).records as unknown as Loose[];
    const rowA = rows.find((r) => r.id === a.id)!;
    assert.equal(rowA.needs, 'investigation');
    assert.equal((rowA.unblocks as string[]).length, 2);
    const rowD = rows.find((r) => r.id === d.id)!;
    assert.deepEqual(rowD.blocked_by_state, [{ slug: a.slug, state: 'open' }]);
  } finally {
    cleanup();
  }
});

// ------------------- needs: external and board_query readiness (GitHub issue #175) -------------------
// decision board-needs-external-waits-on-outside-party-and-board-query-exposes-readiness.

function clockHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-external-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  let t = Date.parse('2026-10-20T08:00:00.000Z');
  const clock = { tick: () => (t += 60_000) };
  const tools = new SterlingTools({ store, now: () => new Date(t).toISOString() });
  return { store, tools, clock, at: () => new Date(t).toISOString(), cleanup: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

const item = (tools: SterlingTools, id: unknown) => tools.boardGet(id as string) as unknown as Loose;

test('board_add needs external: refused without a needs_reason, nothing written; stamped needs_set_at with one; needs_set_at from the caller refused', () => {
  const { tools, at, cleanup } = clockHarness();
  try {
    assert.throws(() => userItem(tools, 'Wait on vendor', { needs: 'external' }), /board_add: needs 'external' requires a needs_reason/);
    assert.throws(() => userItem(tools, 'Wait on vendor', { needs: 'external', needs_reason: '  ' }), /requires a needs_reason/);
    assert.throws(() => userItem(tools, 'Wait on vendor', { needs: 'user', needs_set_at: at() }), /needs_set_at is server-owned/);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'nothing was saved');
    const e = userItem(tools, 'Wait on vendor', { needs: 'external', needs_reason: 'vendor reply to the 10-18 mail' });
    assert.equal(e.needs_set_at, at());
    assert.equal(e.needs_reason, 'vendor reply to the 10-18 mail');
    assert.equal('needs_set_at' in userItem(tools, 'No needs'), false);
  } finally {
    cleanup();
  }
});

test('board_update needs_set_at: stamped on a value change, kept through a priority edit and a reason-only correction, removed with needs', () => {
  const { tools, clock, cleanup } = clockHarness();
  try {
    const a = userItem(tools, 'Wait on the meeting');
    clock.tick();
    tools.boardUpdate(a.id as string, { needs: 'external', needs_reason: 'meeting on Thursday' });
    const stamped = item(tools, a.id).needs_set_at;
    assert.equal(typeof stamped, 'string');
    clock.tick();
    tools.boardUpdate(a.id as string, { priority: 'high' });
    assert.equal(item(tools, a.id).needs_set_at, stamped, 'an unrelated priority edit keeps it');
    clock.tick();
    tools.boardUpdate(a.id as string, { needs_reason: 'meeting moved to Friday' });
    assert.equal(item(tools, a.id).needs_set_at, stamped, 'a reason-only correction keeps it');
    clock.tick();
    tools.boardUpdate(a.id as string, { needs: 'external' });
    assert.equal(item(tools, a.id).needs_set_at, stamped, 'setting the same value again keeps it');
    assert.equal(item(tools, a.id).needs_reason, 'meeting moved to Friday', 'and keeps the reason');
    clock.tick();
    tools.boardUpdate(a.id as string, { needs: 'user', needs_reason: 'pick a date' });
    assert.notEqual(item(tools, a.id).needs_set_at, stamped, 'a value change re-stamps it');
    tools.boardUpdate(a.id as string, { needs: '' });
    const cleared = item(tools, a.id);
    assert.equal('needs' in cleared, false);
    assert.equal('needs_reason' in cleared, false, 'clearing needs clears the reason');
    assert.equal('needs_set_at' in cleared, false, 'clearing needs clears the timestamp');
  } finally {
    cleanup();
  }
});

test('board_update needs external: keeps an existing reason; refused with none, nothing updated', () => {
  const { tools, cleanup } = clockHarness();
  try {
    const a = userItem(tools, 'Ask the user', { needs: 'user', needs_reason: 'waiting for the mail from Kim' });
    tools.boardUpdate(a.id as string, { needs: 'external' });
    assert.equal(item(tools, a.id).needs, 'external');
    assert.equal(item(tools, a.id).needs_reason, 'waiting for the mail from Kim');
    assert.throws(() => tools.boardUpdate(a.id as string, { needs_reason: '' }), /needs 'external' requires a needs_reason.*this call clears it/);
    const b = userItem(tools, 'No reason yet');
    assert.throws(() => tools.boardUpdate(b.id as string, { needs: 'external' }), /needs 'external' requires a needs_reason.*this item has none and this call gives none/);
    assert.equal('needs' in item(tools, b.id), false, 'nothing was updated');
    assert.equal(item(tools, a.id).needs_reason, 'waiting for the mail from Kim');
  } finally {
    cleanup();
  }
});

test('board_query readiness: text and full rows carry readiness, blockers_open and shares_write_path_with; headline and digest do not', () => {
  const { tools, clock, cleanup } = clockHarness();
  try {
    const blocker = userItem(tools, 'First this', { file_keys: ['src/x.ts'] });
    clock.tick();
    const blocked = userItem(tools, 'Then this', { blocked_by: [blocker.id] });
    clock.tick();
    const other = userItem(tools, 'Same file too', { file_keys: ['src/x.ts'] });
    clock.tick();
    const waits = userItem(tools, 'Vendor', { needs: 'external', needs_reason: 'vendor reply' });
    const rows = (projection: 'text' | 'full' | 'headline' | 'digest') =>
      new Map(tools.boardQueryResult({ source: 'user', projection }).records.map((r) => [(r as Loose).id, r as Loose]));
    for (const projection of ['text', 'full'] as const) {
      const r = rows(projection);
      assert.equal(r.get(blocker.id)?.readiness, 'ready');
      assert.deepEqual(r.get(blocker.id)?.shares_write_path_with, [handle('Same file too', other.id)]);
      assert.equal(r.get(blocked.id)?.readiness, 'blocked');
      assert.deepEqual(r.get(blocked.id)?.blockers_open, [handle('First this', blocker.id)]);
      assert.equal('blockers_open' in (r.get(blocker.id) ?? {}), false, 'omitted when empty');
      assert.equal(r.get(waits.id)?.readiness, 'waiting');
      assert.equal(r.get(waits.id)?.needs, 'external');
      assert.equal(r.get(waits.id)?.needs_reason, 'vendor reply');
      assert.equal(typeof r.get(waits.id)?.needs_set_at, 'string');
    }
    for (const projection of ['headline', 'digest'] as const) {
      for (const r of rows(projection).values()) assert.equal('readiness' in r, false, `${projection} rows are unchanged`);
    }
  } finally {
    cleanup();
  }
});

test('board_query paging: a blocker outside the page keeps the item blocked, and write-path overlaps count READY items on other pages', () => {
  const { tools, clock, cleanup } = clockHarness();
  try {
    const blocker = userItem(tools, 'Old blocker', { file_keys: ['src/y.ts'] });
    clock.tick();
    const sharer = userItem(tools, 'Old sharer', { file_keys: ['src/z.ts'] });
    clock.tick();
    const ready = userItem(tools, 'New ready', { file_keys: ['src/z.ts'] });
    clock.tick();
    const blocked = userItem(tools, 'New blocked', { blocked_by: [blocker.id] });
    // Order is updated_at DESC: the first page of 2 holds only the two new items.
    const page = tools.boardQueryResult({ source: 'user', cap: 2 }).records as Loose[];
    assert.deepEqual(page.map((r) => r.id), [blocked.id, ready.id]);
    assert.equal(page[0].readiness, 'blocked');
    assert.deepEqual(page[0].blockers_open, [handle('Old blocker', blocker.id)]);
    assert.deepEqual(page[1].shares_write_path_with, [handle('Old sharer', sharer.id)]);

    const readyOnly = tools.boardQueryResult({ source: 'user', readiness: ['ready'], cap: 1 });
    assert.equal(readyOnly.matched_filter, 3, 'the filter is applied over the whole board before paging');
    assert.deepEqual((readyOnly.records as Loose[]).map((r) => r.id), [ready.id]);
    assert.ok(!(readyOnly.records as Loose[]).some((r) => r.id === blocked.id));
    const next = readyOnly.next_cursor as string;
    assert.equal(typeof next, 'string');
    assert.deepEqual((tools.boardQueryResult({ source: 'user', readiness: ['ready'], cap: 5, cursor: next }).records as Loose[]).map((r) => r.id), [sharer.id, blocker.id]);
    assert.throws(() => tools.boardQueryResult({ source: 'user', cap: 5, cursor: next }), /readiness/, 'the readiness filter is part of the cursor identity');
    assert.deepEqual((tools.boardQueryResult({ source: 'user', readiness: ['blocked', 'waiting'] }).records as Loose[]).map((r) => r.id), [blocked.id]);
  } finally {
    cleanup();
  }
});
