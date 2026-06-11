import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { todoCards, noteCards, runView } from '../viewmodel.js';
import { buildDashboardState, initialUi, reduce, runEffects, screenLineToRow, visibleBodyLines, TABS, type UiState } from '../state.js';
import { keyToEvent, mouseToEvent } from '../render.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-state-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const t1 = store.create({ ...envelope('todo'), text: 'first todo', source: 'user', priority: 'high' }) as { id: string };
  const t2 = store.create({ ...envelope('todo'), text: 'second todo', source: 'user' }) as { id: string };
  store.create({ ...envelope('todo'), text: 'hidden maintenance', source: 'system', system_reason: 'reconcile_needed' });
  store.create({ ...envelope('note'), raw_text: 'a note\nbody', captured_at: NOW, capture_source: 'tui', derived: [] });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, t1, t2, cleanup };
}

test('view models: board filters source=user; note first line; run view summarizes (§11)', () => {
  const { store, cleanup } = fixture();
  try {
    assert.deepEqual(todoCards(store).map((c) => c.title), ['first todo', 'second todo']);
    assert.equal(noteCards(store)[0].title, 'a note');
    assert.equal(runView(store), undefined);
    store.createRun({
      id: 'r-1',
      brief_ref: randomUUID(),
      branch: 'b',
      machine_state: 'running',
      phases: [
        { id: 'p1', status: 'complete', signals: [{ signal: 'complete' }], commits: [] },
        { id: 'p2', status: 'in_progress', signals: [], commits: [] },
      ],
      dispatch_counts: {},
      escalations: [{ kind: 'context_warn', fill_pct: 70 }, { kind: 'judgment_needed', reason: 'blocked' }],
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

test('buildDashboardState: rows with screen offsets; expansion adds detail lines; empty + run tabs', () => {
  const { store, t1, cleanup } = fixture();
  try {
    let s = buildDashboardState(store, initialUi);
    assert.deepEqual(s.tabs.map((t) => t.active), [true, false, false]);
    assert.deepEqual(s.rows.map((r) => r.screenRow), [0, 1]);
    assert.equal(s.rows[0].selected, true);
    assert.equal(s.rows[0].detail, undefined, 'collapsed by default');

    s = buildDashboardState(store, { tab: 0, cursor: 0, expanded: [t1.id] });
    assert.match(s.rows[0].detail!, /priority: high/);
    assert.deepEqual(s.rows.map((r) => r.screenRow), [0, 2], 'expanded row occupies two lines');

    s = buildDashboardState(store, { tab: 2, cursor: 0, expanded: [] });
    assert.equal(s.emptyMessage, 'no active run');
    assert.equal(s.runSelected, true);
  } finally {
    cleanup();
  }
});

test('screenLineToRow: maps clicks through bodyTop and expanded heights', () => {
  const { store, t1, cleanup } = fixture();
  try {
    const s = buildDashboardState(store, { tab: 0, cursor: 0, expanded: [t1.id] });
    // terminal lines are 1-based; body starts after tab bar + blank (bodyTop=2) → line 3
    assert.equal(screenLineToRow(s, 3), 0, 'first row');
    assert.equal(screenLineToRow(s, 4), 0, 'its expanded detail line still maps to row 0');
    assert.equal(screenLineToRow(s, 5), 1, 'second todo shifted down by the expansion');
    assert.equal(screenLineToRow(s, 1), -1, 'tab bar is not a row');
    assert.equal(screenLineToRow(s, 99), -1);
  } finally {
    cleanup();
  }
});

test('viewport clamp: rows the renderer clips are not clickable (off-screen click regression)', () => {
  const { store, t1, cleanup } = fixture();
  try {
    // visibleBodyLines mirrors the draw() clamp: body spans lines bodyTop+1 .. height-2
    assert.equal(visibleBodyLines(8), 4);
    assert.equal(visibleBodyLines(4), 0);
    assert.equal(visibleBodyLines(2), 0, 'degenerate pane: nothing clickable');

    // one visible body line: the first todo (line 3) hits, the second (line 4) is clipped
    const s = buildDashboardState(store, initialUi);
    assert.equal(screenLineToRow(s, 3, 1), 0);
    assert.equal(screenLineToRow(s, 4, 1), -1, 'clipped row must not map');

    // an expanded row's detail line beyond the viewport is not a hit either
    const sx = buildDashboardState(store, { tab: 0, cursor: 0, expanded: [t1.id] });
    assert.equal(screenLineToRow(sx, 4, 1), -1, 'hidden detail line must not map');

    // through reduce: a click below the viewport is a no-op (no selection effect, no expand)
    const clipped = reduce(store, initialUi, { kind: 'click', x: 1, y: 4 }, 1);
    assert.deepEqual(clipped.effects, []);
    assert.deepEqual(clipped.ui, initialUi);
  } finally {
    cleanup();
  }
});

test('reduce: keys — tab cycling, cursor clamp, enter selects + toggles expand, quit', () => {
  const { store, t1, cleanup } = fixture();
  try {
    let ui: UiState = initialUi;
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'RIGHT' }));
    assert.equal(ui.tab, 1);
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'LEFT' }));
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'LEFT' }));
    assert.equal(ui.tab, TABS.length - 1, 'left wraps');
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'TAB' }));
    assert.equal(ui.tab, 0, 'tab key cycles forward');

    ({ ui } = reduce(store, ui, { kind: 'key', name: 'DOWN' }));
    assert.equal(ui.cursor, 1);
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'DOWN' }));
    assert.equal(ui.cursor, 1, 'clamped at last card');
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'UP' }));
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'UP' }));
    assert.equal(ui.cursor, 0, 'clamped at first card');

    const enter = reduce(store, ui, { kind: 'key', name: 'ENTER' });
    assert.deepEqual(enter.effects, [{ type: 'select', recordType: 'todo', id: t1.id }]);
    assert.deepEqual(enter.ui.expanded, [t1.id]);
    const again = reduce(store, enter.ui, { kind: 'key', name: 'SPACE' });
    assert.deepEqual(again.ui.expanded, [], 'second activation collapses');

    const quit = reduce(store, ui, { kind: 'key', name: 'QUIT' });
    assert.deepEqual(quit.effects, [{ type: 'quit' }]);
  } finally {
    cleanup();
  }
});

test('reduce: digit hotkeys select tabs directly; out-of-range digits are a no-op', () => {
  const { store, cleanup } = fixture();
  try {
    let ui: UiState = { tab: 0, cursor: 1, expanded: [] };
    ({ ui } = reduce(store, ui, { kind: 'tab', index: TABS.length - 1 }));
    assert.equal(ui.tab, TABS.length - 1, 'last tab reachable by its digit');
    assert.equal(ui.cursor, 0, 'tab switch resets the cursor');

    ({ ui } = reduce(store, ui, { kind: 'tab', index: 0 }));
    assert.equal(ui.tab, 0);

    const before = ui;
    ({ ui } = reduce(store, ui, { kind: 'tab', index: TABS.length }));
    assert.deepEqual(ui, before, 'digit past the registered tab count is ignored');
  } finally {
    cleanup();
  }
});

test('reduce: mouse — wheel scrolls, click activates by screen line, tab-bar click switches, right-click collapses', () => {
  const { store, t1, t2, cleanup } = fixture();
  try {
    let ui: UiState = initialUi;
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: 1 }));
    assert.equal(ui.cursor, 1);
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: -1 }));
    assert.equal(ui.cursor, 0);

    // click the second todo (body line 4 when nothing is expanded)
    const click = reduce(store, ui, { kind: 'click', x: 5, y: 4 });
    assert.deepEqual(click.effects, [{ type: 'select', recordType: 'todo', id: t2.id }]);
    assert.deepEqual(click.ui.expanded, [t2.id]);
    assert.equal(click.ui.cursor, 1, 'click moves the cursor');

    // with t2 expanded, clicking THROUGH the shifted layout still hits t1's line
    const clickFirst = reduce(store, click.ui, { kind: 'click', x: 5, y: 3 });
    assert.equal(clickFirst.effects[0]!.type, 'select');
    assert.equal((clickFirst.effects[0] as { id: string }).id, t1.id);

    // tab bar: ' Todos  Notes  Live-run ' — Notes starts after ' Todos ' (7 cols)
    const tabClick = reduce(store, ui, { kind: 'click', x: 9, y: 1 });
    assert.equal(tabClick.ui.tab, 1, 'clicked Notes');

    const rc = reduce(store, click.ui, { kind: 'rightclick' });
    assert.deepEqual(rc.ui.expanded, [], 'right-click collapses everything');

    // click in dead space: no-op
    const dead = reduce(store, ui, { kind: 'click', x: 1, y: 50 });
    assert.deepEqual(dead.effects, []);
  } finally {
    cleanup();
  }
});

test('reduce + runEffects: run-tab activation selects the run; effects write the one-shot store row (§11/H2)', () => {
  const { store, cleanup } = fixture();
  try {
    store.createRun({
      id: 'r-sel',
      brief_ref: randomUUID(),
      branch: 'b',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: NOW,
    });
    const ui: UiState = { tab: 2, cursor: 0, expanded: [] };
    const { effects } = reduce(store, ui, { kind: 'key', name: 'ENTER' });
    assert.deepEqual(effects, [{ type: 'select', recordType: 'run', id: 'r-sel' }]);
    const quit = runEffects(store, effects, () => NOW);
    assert.equal(quit, false);
    assert.deepEqual({ ...store.takeSelection() }, { type: 'run', record_id: 'r-sel', at: NOW });
    assert.equal(store.takeSelection(), undefined, 'one-shot');
    assert.equal(runEffects(store, [{ type: 'quit' }]), true);
  } finally {
    cleanup();
  }
});

test('renderer translation tables: terminal-kit names map to the state vocabulary', () => {
  assert.deepEqual(keyToEvent('UP'), { kind: 'key', name: 'UP' });
  assert.deepEqual(keyToEvent('q'), { kind: 'key', name: 'QUIT' });
  assert.deepEqual(keyToEvent('CTRL_C'), { kind: 'key', name: 'QUIT' });
  assert.deepEqual(keyToEvent('1'), { kind: 'tab', index: 0 }, 'digit hotkeys map to 0-based tab index');
  assert.deepEqual(keyToEvent('9'), { kind: 'tab', index: 8 }, 'translation is tab-count agnostic; reduce validates');
  assert.equal(keyToEvent('0'), undefined);
  assert.equal(keyToEvent('F5'), undefined);
  assert.deepEqual(mouseToEvent('MOUSE_LEFT_BUTTON_PRESSED', { x: 3, y: 4 }), { kind: 'click', x: 3, y: 4 });
  assert.deepEqual(mouseToEvent('MOUSE_RIGHT_BUTTON_PRESSED', { x: 1, y: 1 }), { kind: 'rightclick' });
  assert.deepEqual(mouseToEvent('MOUSE_WHEEL_DOWN', { x: 0, y: 0 }), { kind: 'wheel', dy: 1 });
  assert.deepEqual(mouseToEvent('MOUSE_WHEEL_UP', { x: 0, y: 0 }), { kind: 'wheel', dy: -1 });
  assert.equal(mouseToEvent('MOUSE_MOTION', { x: 0, y: 0 }), undefined);
});
