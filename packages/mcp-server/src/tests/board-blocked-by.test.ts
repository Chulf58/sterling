// ------------------- board `blocked_by` field, TOOL half -------------------
// decision every-user-ask-is-boarded-at-intake-with-slim-blocked-by, rule 6.
//
// board_add and board_update accept `blocked_by` on source:'user' items. Each
// entry is resolved through the same ladder as board_get (slug, full uuid,
// 8-char prefix) and STORED as the blocker's immutable slug (decision: slugs are
// immutable addresses). An unresolvable entry, a non-open or non-board target,
// a self-block, or blocked_by on a system item is refused naming the problem,
// with nothing written. A blocker that is later removed reads as closed:
// board_get's `blocked_by_state` and board_query's text/full rows report each
// entry's current state. No cycle detection, no ready filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-10-01T12:00:00.000Z';

// harness() is duplicated from tools.test.ts deliberately: that module is not an
// exporter of its fixtures, and importing it would re-execute its whole suite.
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-blocked-by-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type Loose = Record<string, unknown>;

function add(tools: SterlingTools, args: Loose): Loose {
  return tools.boardAdd(args).record as unknown as Loose;
}

function userItem(tools: SterlingTools, headline: string, extra: Loose = {}): Loose {
  return add(tools, { text: `${headline}\nsee packages/store/src/index.ts:1`, source: 'user', objective: 'standalone', ...extra });
}

function boardSize(tools: SterlingTools): number {
  return tools.boardQuery({ source: 'user' }).length;
}

test('board_add blocked_by: a slug, a full id and an 8-char prefix are all accepted and each is STORED as the blocker slug', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    const b = userItem(tools, 'Land the store');
    const c = userItem(tools, 'Shape the tool');
    const d = userItem(tools, 'Wire the consumer', { blocked_by: [a.slug, b.id, (c.id as string).slice(0, 8)] });
    assert.deepEqual(d.blocked_by, [a.slug, b.slug, c.slug]);
    const stored = tools.boardGet(d.id as string) as unknown as Loose;
    assert.deepEqual(stored.blocked_by, [a.slug, b.slug, c.slug], 'the stored field holds slugs, never the id forms the caller passed');
  } finally {
    cleanup();
  }
});

test('board_add blocked_by: an unresolvable entry is refused NAMING it, and nothing is written', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    const before = boardSize(tools);
    assert.throws(
      () => userItem(tools, 'Wire the consumer', { blocked_by: [a.slug, 'no-such-board-item'] }),
      (err: Error) => /blocked_by/.test(err.message) && /no-such-board-item/.test(err.message)
    );
    assert.equal(boardSize(tools), before, 'the refused add wrote nothing');
  } finally {
    cleanup();
  }
});

test('board_add blocked_by: a non-board record is refused naming it, and nothing is written', () => {
  const { tools, cleanup } = harness();
  try {
    const decision = tools.knowledgeCreate('decision', {
      slug: 'some-decision',
      title: 'Some decision',
      statement: 'A decision that is not a board item.',
      rationale: 'Fixture.',
      alternatives_rejected: [],
      file_keys: [],
    }).record as unknown as Loose;
    const before = boardSize(tools);
    assert.throws(
      () => userItem(tools, 'Wire the consumer', { blocked_by: [decision.slug] }),
      (err: Error) => /blocked_by/.test(err.message) && /some-decision/.test(err.message)
    );
    assert.equal(boardSize(tools), before);
  } finally {
    cleanup();
  }
});

test('board_add blocked_by: REFUSED on a source:system item, loudly, and nothing is written', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    assert.throws(
      () => add(tools, { text: 'reconcile auth article', source: 'system', system_reason: 'reconcile_needed', blocked_by: [a.slug] }),
      (err: Error) => /'blocked_by' orders source:'user' board tasks only/.test(err.message)
    );
    assert.equal(tools.boardQuery({ source: 'system' }).length, 0);
  } finally {
    cleanup();
  }
});

test('board_update blocked_by: REFUSED on a source:system item, and the item is unchanged', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    const sys = add(tools, { text: 'reconcile auth article', source: 'system', system_reason: 'reconcile_needed' });
    assert.throws(
      () => tools.boardUpdate(sys.id as string, { blocked_by: [a.slug] }),
      (err: Error) => /'blocked_by' orders source:'user' board tasks only/.test(err.message)
    );
    const after = tools.boardGet(sys.id as string) as unknown as Loose;
    assert.equal('blocked_by' in after, false);
  } finally {
    cleanup();
  }
});

test('board_update blocked_by: an item cannot block itself — by slug or by id prefix — and nothing is written', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    for (const self of [a.slug as string, (a.id as string).slice(0, 8)]) {
      assert.throws(
        () => tools.boardUpdate(a.id as string, { blocked_by: [self] }),
        (err: Error) => /blocked_by/.test(err.message) && /itself/.test(err.message)
      );
    }
    const after = tools.boardGet(a.id as string) as unknown as Loose;
    assert.equal('blocked_by' in after, false);
    assert.equal(after.version, a.version, 'no write landed');
  } finally {
    cleanup();
  }
});

test('board_update blocked_by: an unresolvable entry is refused naming it, and the existing list is untouched', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    const d = userItem(tools, 'Wire the consumer', { blocked_by: [a.slug] });
    assert.throws(
      () => tools.boardUpdate(d.id as string, { blocked_by: ['ghost-item'] }),
      (err: Error) => /ghost-item/.test(err.message)
    );
    const after = tools.boardGet(d.id as string) as unknown as Loose;
    assert.deepEqual(after.blocked_by, [a.slug]);
  } finally {
    cleanup();
  }
});

test('board_update blocked_by: a prefix is normalised to the slug; an empty list clears the field', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    const d = userItem(tools, 'Wire the consumer');
    const updated = tools.boardUpdate(d.id as string, { blocked_by: [(a.id as string).slice(0, 8)] }) as unknown as Loose;
    assert.deepEqual(updated.blocked_by, [a.slug]);
    const cleared = tools.boardUpdate(d.id as string, { blocked_by: [] }) as unknown as Loose;
    assert.equal('blocked_by' in cleared, false, 'an empty list stores the field absent, not an empty array');
  } finally {
    cleanup();
  }
});

test('blocker state: board_get reports each blocker open, and a REMOVED blocker as closed', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    const b = userItem(tools, 'Land the store');
    const d = userItem(tools, 'Wire the consumer', { blocked_by: [a.slug, b.slug] });
    let got = tools.boardGet(d.id as string) as unknown as Loose;
    assert.deepEqual(got.blocked_by_state, [
      { slug: a.slug, state: 'open' },
      { slug: b.slug, state: 'open' },
    ]);
    tools.boardRemove(a.id as string);
    got = tools.boardGet(d.id as string) as unknown as Loose;
    assert.deepEqual(got.blocked_by, [a.slug, b.slug], 'the stored list is unchanged by the removal');
    assert.deepEqual(got.blocked_by_state, [
      { slug: a.slug, state: 'closed' },
      { slug: b.slug, state: 'open' },
    ]);
  } finally {
    cleanup();
  }
});

test('blocker state: board_get on an item with no blocked_by carries no blocked_by_state', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    const got = tools.boardGet(a.id as string) as unknown as Loose;
    assert.equal('blocked_by_state' in got, false);
  } finally {
    cleanup();
  }
});

test('blocker state: board_query text and full projections carry blocked_by and each entry state; a removed blocker reads closed', () => {
  const { tools, cleanup } = harness();
  try {
    const a = userItem(tools, 'Define the schema');
    const d = userItem(tools, 'Wire the consumer', { blocked_by: [a.slug] });
    tools.boardRemove(a.id as string);
    for (const projection of ['text', 'full'] as const) {
      const rows = tools.boardQueryResult({ source: 'user', projection }).records as unknown as Loose[];
      const row = rows.find((r) => r.id === d.id);
      assert.ok(row, `${projection}: the blocked item is listed`);
      assert.deepEqual(row.blocked_by, [a.slug], `${projection}: blocked_by is carried`);
      assert.deepEqual(row.blocked_by_state, [{ slug: a.slug, state: 'closed' }], `${projection}: the removed blocker reads closed`);
    }
  } finally {
    cleanup();
  }
});
