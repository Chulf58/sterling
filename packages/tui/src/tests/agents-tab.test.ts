import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { AGENTS_TAB, SYSTEM_TAB, TABS, buildDashboardState, initialUi, reduce, visibleTabs, type AgentsTab, type DashboardState, type UiState } from '../state.js';

// The Agents tab belongs to the Claude Code terminal dashboard: it sits after Queue and before
// System, shows the running count in its label, and exists only for a host that enables it through
// Viewport.agents. The OpenCode full view does not, so its tab bar and keys are as they were.

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-agents-tab-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const on = (running: number): { agents: AgentsTab; width: number } => ({ agents: { running }, width: 120 });
const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });
const labels = (s: DashboardState): string[] => s.tabs.map((t) => t.label);

test('agents tab: it sits after Queue and before System', () => {
  assert.deepEqual([...TABS], ['Tasks', 'Knowledge', 'Queue', 'Agents', 'System']);
  assert.equal(AGENTS_TAB, TABS.indexOf('Queue') + 1);
  assert.equal(SYSTEM_TAB, AGENTS_TAB + 1);
});

test('agents tab: enabled by the host, the bar shows "Agents (N)" with the running count; disabled, it is absent', () => {
  const { store, cleanup } = fixture();
  try {
    assert.deepEqual(labels(buildDashboardState(store, initialUi, 120, 20, '', false, undefined, undefined, { running: 2 })).slice(2), ['Queue', 'Agents (2)', 'System']);
    assert.deepEqual(labels(buildDashboardState(store, initialUi, 120, 20, '', false, undefined, undefined, { running: 0 })).slice(3), ['Agents (0)', 'System']);
    assert.deepEqual(labels(buildDashboardState(store, initialUi)), ['Tasks (0)', 'Knowledge', 'Queue', 'System'], 'a host without the Agents tab keeps its four tabs');
    assert.deepEqual(visibleTabs(), [0, 1, 2, 4]);
    assert.deepEqual(visibleTabs({ running: 0 }), [0, 1, 2, 3, 4]);
  } finally {
    cleanup();
  }
});

test('agents tab: the Agents body is empty, never "(empty)", and its footer names the tab count', () => {
  const { store, cleanup } = fixture();
  try {
    const s = buildDashboardState(store, st({ tab: AGENTS_TAB }), 120, 20, '', false, undefined, undefined, { running: 1 });
    assert.equal(s.emptyMessage, undefined);
    assert.deepEqual(s.rows, []);
    assert.match(s.footer, /1-5 tabs/);
    assert.deepEqual(s.tabs.map((t) => t.active), [false, false, false, true, false]);
  } finally {
    cleanup();
  }
});

test('agents tab: keys, digits and clicks reach it only when the host enables it', () => {
  const { store, cleanup } = fixture();
  try {
    // enabled: left/right walk all five tabs in order, a digit picks the n-th, the event index is the TABS index
    let ui: UiState = st({ tab: 2 });
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'RIGHT' }, on(1)));
    assert.equal(ui.tab, AGENTS_TAB);
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'RIGHT' }, on(1)));
    assert.equal(ui.tab, SYSTEM_TAB);
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'LEFT' }, on(1)));
    assert.equal(ui.tab, AGENTS_TAB);
    assert.equal(reduce(store, st(), { kind: 'char', ch: '4' }, on(1)).ui.tab, AGENTS_TAB, 'digit 4 is Agents');
    assert.equal(reduce(store, st(), { kind: 'char', ch: '5' }, on(1)).ui.tab, SYSTEM_TAB, 'digit 5 is System');
    assert.equal(reduce(store, st(), { kind: 'tab', index: AGENTS_TAB }, on(1)).ui.tab, AGENTS_TAB);
    // a click on the Agents cell of the bar selects it, a click on the System cell after it selects System
    const s = buildDashboardState(store, st(), 120, 20, '', false, undefined, undefined, { running: 1 });
    let x = 1;
    const starts = s.tabs.map((t) => {
      const at = x;
      x += t.label.length + 2;
      return at + 1;
    });
    assert.equal(reduce(store, st(), { kind: 'click', x: starts[3]!, y: 2 }, on(1)).ui.tab, AGENTS_TAB);
    assert.equal(reduce(store, st(), { kind: 'click', x: starts[4]!, y: 2 }, on(1)).ui.tab, SYSTEM_TAB);
    // disabled: right from Queue skips Agents, digit 5 is nothing
    assert.equal(reduce(store, st({ tab: 2 }), { kind: 'key', name: 'RIGHT' }).ui.tab, SYSTEM_TAB);
    assert.equal(reduce(store, st(), { kind: 'char', ch: '5' }).ui.tab, 0);
  } finally {
    cleanup();
  }
});
