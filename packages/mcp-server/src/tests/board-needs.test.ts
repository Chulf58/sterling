// ------------------- board `needs` and `unblocks`, TOOL half -------------------
// decision board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start.
//
// board_add and board_update set `needs` (user | grill | investigation) on
// source:'user' items; board_update with needs:'' clears it. A system item is
// refused naming the field, with nothing written. board_get and board_query's
// text/full rows return `needs` and `unblocks`: the live items whose blocked_by
// names this one, as `name (id8)`, never bare slugs (decision 11b8b08c).
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
