import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { SterlingStore } from '@sterling/store';
import { App } from '../app.js';
import { todoCards, noteCards, runView } from '../viewmodel.js';

const NOW = '2026-06-10T12:00:00.000Z';

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tui-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  store.create({ ...envelope('todo'), text: 'ship the csv export', source: 'user', priority: 'high' });
  store.create({ ...envelope('todo'), text: 'system item stays hidden', source: 'system', system_reason: 'reconcile_needed' });
  store.create({ ...envelope('note'), raw_text: 'rate limits are per-org\nmore detail', captured_at: NOW, capture_source: 'tui', derived: [] });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('view models: board filters user todos; notes first-line; run view summarizes the record (§11)', () => {
  const { store, cleanup } = fixture();
  try {
    const todos = todoCards(store);
    assert.equal(todos.length, 1, 'board view filters source=user');
    assert.equal(todos[0].title, 'ship the csv export');
    assert.match(todos[0].detail, /priority: high/);
    assert.equal(noteCards(store)[0].title, 'rate limits are per-org');
    assert.equal(runView(store), undefined);

    store.createRun({
      id: 'r-tui',
      brief_ref: randomUUID(),
      branch: 'b',
      machine_state: 'running',
      phases: [
        { id: 'p1', status: 'complete', signals: [{ signal: 'complete' }], commits: [] },
        { id: 'p2', status: 'in_progress', signals: [], commits: [] },
      ],
      dispatch_counts: {},
      escalations: [{ kind: 'context_warn', fill_pct: 63 }, { kind: 'judgment_needed', reason: 'blocked' }],
      started_at: NOW,
    });
    const rv = runView(store)!;
    assert.equal(rv.phaseLabel, 'phase 2 of 2');
    assert.equal(rv.lastSignal, 'complete');
    assert.equal(rv.warnFlags, 1);
    assert.equal(rv.pendingJudgment, 'blocked');
  } finally {
    cleanup();
  }
});

test('App renders tabs and cards; enter writes the one-shot selection ROW in the store (§11/H2)', async () => {
  const { store, cleanup } = fixture();
  try {
    const { lastFrame, stdin, unmount } = render(<App store={store} pollMs={0} />);
    await sleep(50);
    assert.match(lastFrame()!, /Todos/);
    assert.match(lastFrame()!, /ship the csv export/);
    assert.ok(!/system item stays hidden/.test(lastFrame()!), 'maintenance queue never pollutes the board tab');

    stdin.write('\r'); // select + expand the focused card
    await sleep(50);
    const sel = store.takeSelection();
    assert.ok(sel, 'selection row written transactionally');
    assert.equal(sel!.type, 'todo');
    assert.match(lastFrame()!, /priority: high/, 'expanded detail visible');
    assert.equal(store.takeSelection(), undefined, 'one-shot: consumed');

    stdin.write('[C'); // right arrow → Notes
    await sleep(50);
    assert.match(lastFrame()!, /rate limits are per-org/);

    stdin.write('[C'); // → Live-run
    await sleep(50);
    assert.match(lastFrame()!, /no active run/);
    unmount();
  } finally {
    cleanup();
  }
});
