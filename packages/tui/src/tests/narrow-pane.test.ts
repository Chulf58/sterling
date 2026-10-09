import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import {
  buildDashboardState,
  fitTabs,
  initialUi,
  reduce,
  screenLineToRow,
  visibleBodyLines,
  ARTICLE_STATE_FILTERS,
  AGENTS_TAB,
  KNOWLEDGE_TAB,
  QUEUE_TAB,
  STATE_GLYPHS,
  SYSTEM_TAB,
  TASKS_TAB,
  type DashboardState,
  type UiState,
} from '../state.js';
import { draw, type AttrLike } from '../render.js';
import { bannerLines, COMPACT_BELOW_HEIGHT, COMPACT_SCENE_ROWS, FULL_SCENE_ROWS } from '../banner.js';
import { themeFor, PLAIN_THEME, XTERM } from '../theme.js';
import { openDashboard } from '../controller.js';

// Board c533a872 (TUI fix 2 of 4): the narrow-pane layout. Each acceptance
// point is pinned through the state layer AND the renderer or the click
// hit-test, so the screen and the clicks are checked against each other.

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

let clock = Date.parse('2026-06-10T12:00:00.000Z');
function envelope(type: string) {
  const at = new Date((clock -= 1000)).toISOString();
  return { id: randomUUID(), type, created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}

function fixture(): { store: SterlingStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-narrow-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Put = { x: number; y: number; attr: AttrLike; str: string };
function capture(width: number, height: number) {
  const puts: Put[] = [];
  const screen = {
    width,
    height,
    fill() {},
    put(o: { x: number; y: number; attr: AttrLike }, str: string) {
      puts.push({ ...o, str });
    },
    draw() {},
  };
  return { screen, puts };
}

const cellsWidth = (s: DashboardState): number => s.tabs.reduce((n, t) => n + t.label.length + 2, 0);
/** the 1-based x of tab i's first label character, as the hit-test measures it */
function tabX(s: DashboardState, i: number): number {
  let x = 1;
  for (let j = 0; j < i; j++) x += s.tabs[j]!.label.length + 2;
  return x + 1;
}

// ---------------------------------------------------------------------------
// 1. Abbreviated tabs keep the active tab visible and clickable
// ---------------------------------------------------------------------------

test('narrow tabs: a long Agents label is shortened from its text; the active tab keeps its name and the bar fits', () => {
  const tabs = ['Tasks (13)', 'Knowledge', 'Queue', 'Agents (2 running · 3 quiet)', 'System'].map((label, index) => ({ label, active: index === 3, index }));
  assert.deepEqual(fitTabs(tabs, Infinity), tabs, 'an unbounded pane keeps every label');
  for (const width of [80, 68, 49, 40, 33, 25]) {
    const fitted = fitTabs(tabs, width);
    const used = fitted.reduce((n, t) => n + t.label.length + 2, 0);
    assert.ok(used <= width, `width ${width}: the bar uses ${used} columns`);
    assert.match(fitted[3]!.label, /^Agents/, `width ${width}: the active tab keeps its name`);
  }
  assert.equal(fitTabs(tabs, 68)[3]!.label, 'Agents (2 running · 3 quiet)', 'room for everything → nothing shortened');
  assert.deepEqual(fitTabs(tabs, 63).map((t) => t.label), ['Tasks', 'Knowledge', 'Queue', 'Agents (2 running · 3 quiet)', 'System'], 'inactive counts go first');
  assert.deepEqual(fitTabs(tabs, 49).map((t) => t.label), ['Tasks', 'Knowledge', 'Queue', 'Agents', 'System']);
  assert.deepEqual(fitTabs(tabs, 33).map((t) => t.label), ['Tas', 'Kno', 'Que', 'Agents', 'Sys']);
  assert.deepEqual(fitTabs(tabs, 25).map((t) => t.label), ['T', 'K', 'Q', 'Agents', 'S']);
  assert.deepEqual(fitTabs(tabs, 18).map((t) => t.label), ['T', 'K', 'Q', 'Age…', 'S'], 'below every step the active name is clipped, never dropped');
});

test('narrow tabs: at 33 columns every tab, the active one included, is drawn inside the pane and a click on it switches to it', () => {
  const { store, cleanup } = fixture();
  try {
    const agents = { running: 2 };
    for (const active of [TASKS_TAB, KNOWLEDGE_TAB, QUEUE_TAB, AGENTS_TAB, SYSTEM_TAB]) {
      const ui = st({ tab: active });
      const s = buildDashboardState(store, ui, 33, 20, '', false, undefined, undefined, agents);
      assert.ok(cellsWidth(s) <= 33, `tab ${active}: the bar fits 33 columns`);
      const { screen, puts } = capture(33, 30);
      draw(screen, s);
      const activeCell = s.tabs.find((t) => t.active)!;
      const put = puts.find((p) => p.y === s.bodyTop - 2 && p.str === ` ${activeCell.label} `);
      assert.ok(put && put.x + put.str.length <= 33, `tab ${active}: the active tab is drawn inside the pane`);
      for (let i = 0; i < s.tabs.length; i++) {
        const r = reduce(store, ui, { kind: 'click', x: tabX(s, i), y: s.bodyTop - 1 }, { width: 33, maxBodyLines: 20, agents });
        assert.equal(r.ui.tab, s.tabs[i]!.index, `from tab ${active}, a click on '${s.tabs[i]!.label}' switches to it`);
      }
    }
  } finally {
    cleanup();
  }
});

test('narrow tabs: under 3 columns per tab the bar is a window that always holds the active tab, and every drawn cell clicks to its own tab', () => {
  const tabs = ['Tasks (13)', 'Knowledge', 'Queue', 'Agents (2 running · 3 quiet)', 'System'].map((label, index) => ({ label, active: index === 4, index }));
  assert.deepEqual(fitTabs(tabs, 12).map((t) => [t.label, t.index]), [['A', 3], ['System', 4]], 'width 12: the active tab plus the neighbour that fits');
  assert.deepEqual(fitTabs(tabs, 8).map((t) => [t.label, t.index]), [['System', 4]]);
  assert.deepEqual(fitTabs(tabs, 5).map((t) => [t.label, t.index]), [['Sy…', 4]], 'width 5: the active name clipped to the pane');
  const { store, cleanup } = fixture();
  try {
    const agents = { running: 2 };
    for (const width of [12, 8, 5]) {
      for (const active of [TASKS_TAB, KNOWLEDGE_TAB, QUEUE_TAB, AGENTS_TAB, SYSTEM_TAB]) {
        const ui = st({ tab: active, cursor: 1 });
        const s = buildDashboardState(store, ui, width, 20, '', false, undefined, undefined, agents);
        assert.ok(cellsWidth(s) <= width, `width ${width}, tab ${active}: the bar uses ${cellsWidth(s)} columns`);
        const at = s.tabs.findIndex((t) => t.active);
        assert.notEqual(at, -1, `width ${width}, tab ${active}: the active tab is in the bar`);
        const { screen, puts } = capture(width, 30);
        draw(screen, s);
        const put = puts.find((p) => p.y === s.bodyTop - 2 && p.str === ` ${s.tabs[at]!.label} `);
        assert.ok(put && put.x + put.str.length <= width, `width ${width}, tab ${active}: the active tab is drawn inside the pane`);
        for (let i = 0; i < s.tabs.length; i++) {
          const r = reduce(store, ui, { kind: 'click', x: tabX(s, i), y: s.bodyTop - 1 }, { width, maxBodyLines: 20, agents });
          assert.equal(r.ui.tab, s.tabs[i]!.index, `width ${width}: a click on '${s.tabs[i]!.label}' goes to tab ${s.tabs[i]!.index}`);
          assert.equal(r.ui.cursor, 0, 'the click switched (a switch resets the cursor)');
        }
      }
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Warnings: one notice row in the warning colour
// ---------------------------------------------------------------------------

test('notice row: a notice is its own row above the footer, in the warning colour, on every tab', () => {
  const { store, cleanup } = fixture();
  try {
    for (const tab of [TASKS_TAB, KNOWLEDGE_TAB, QUEUE_TAB, AGENTS_TAB, SYSTEM_TAB]) {
      const s = buildDashboardState(store, st({ tab, notice: 'selection not handed to the next prompt — disk I/O error' }), 40, 20, '', false, undefined, undefined, { running: 0 });
      assert.equal(s.notice, '⚠ selection not handed to the next prom…', `tab ${tab}: the notice is clipped to the 40-column pane`);
      assert.doesNotMatch(s.footer, /⚠/, `tab ${tab}: the footer keeps its key help`);
      assert.ok(!s.rows.some((r) => r.lines.some((l) => l.text.startsWith('⚠'))), `tab ${tab}: the notice is not a body row`);
      const { screen, puts } = capture(40, 30);
      draw(screen, s, { theme: themeFor('256') });
      const drawn = puts.filter((p) => p.str.startsWith('⚠'));
      assert.equal(drawn.length, 1, `tab ${tab}: exactly one notice row`);
      assert.equal(drawn[0]!.y, 28, 'the row just above the footer');
      assert.equal(drawn[0]!.attr.color, XTERM.amber, 'amber, the warning colour');
      assert.equal(drawn[0]!.attr.bold, true);
    }
    const plain = capture(40, 30);
    draw(plain.screen, buildDashboardState(store, st({ notice: 'x' }), 40, 20));
    assert.deepEqual(plain.puts.find((p) => p.str === '⚠ x')!.attr, { ...PLAIN_THEME.text, bold: true }, 'plain level: bold, never dim');
    assert.equal(buildDashboardState(store, st(), 40, 20).notice, undefined, 'no notice → no row');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Footer: pinned, at most 48 columns, mode-specific
// ---------------------------------------------------------------------------

test('footer: at most 48 columns, different per tab and for the Tasks editor, pinned to the last row', () => {
  const { store, cleanup } = fixture();
  try {
    store.create({ ...envelope('todo'), text: 'only todo', source: 'user' });
    const agents = { running: 0 };
    const modes: [string, UiState][] = [
      ['tasks', st({ tab: TASKS_TAB })],
      ['tasks edit', st({ tab: TASKS_TAB, boardEdit: { id: 'x', text: 'y', version: 1 } })],
      ['knowledge', st({ tab: KNOWLEDGE_TAB })],
      ['queue', st({ tab: QUEUE_TAB })],
      ['agents', st({ tab: AGENTS_TAB })],
      ['system', st({ tab: SYSTEM_TAB })],
    ];
    const footers = modes.map(([name, ui]) => {
      const f = buildDashboardState(store, ui, Infinity, 20, '', false, undefined, undefined, agents).footer;
      assert.ok(f.length <= 48, `${name}: '${f}' is ${f.length} columns`);
      return f;
    });
    assert.equal(new Set(footers).size, modes.length, 'every mode has its own footer');
    assert.match(footers[1]!, /enter save · esc cancel/);
    assert.match(footers[2]!, /type to search/);
    assert.doesNotMatch(footers[2]!, /1-\d tabs/, 'digits type into the search on Knowledge, so the footer does not offer them');
    // clipped to a narrower pane
    const narrow = buildDashboardState(store, st(), 33, 20).footer;
    assert.equal(narrow.length, 33);
    assert.ok(narrow.endsWith('…'));
    // pinned: one short row of content, the footer still sits on the last row
    const { screen, puts } = capture(48, 30);
    const s = buildDashboardState(store, st(), 48, visibleBodyLines(30));
    draw(screen, s);
    assert.equal(puts.find((p) => p.str === s.footer)!.y, 29);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. The article state tag is one glyph
// ---------------------------------------------------------------------------

test('state glyph: every article state has a distinct 1-character glyph', () => {
  const states = ARTICLE_STATE_FILTERS.filter((s) => s !== 'all');
  for (const s of states) assert.equal([...(STATE_GLYPHS[s] ?? '')].length, 1, `${s} has one glyph`);
  assert.equal(new Set(states.map((s) => STATE_GLYPHS[s])).size, states.length, 'no two states share a glyph');
});

// ---------------------------------------------------------------------------
// 5. Queue: pending and history scroll independently; the footer is reserved
// ---------------------------------------------------------------------------

function queueFixture() {
  const f = fixture();
  // 10 pending system items; every create also logs an activity line, so the
  // history (completed + activity, capped at 15 each) is taller than its half
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push((f.store.create({ ...envelope('todo'), text: `pending ${i}`, source: 'system', system_reason: 'capture_owed' }) as { id: string }).id);
  return { ...f, ids };
}

test('queue: the footer never covers the completed header, and the pending window stops above the divider', () => {
  const { store, cleanup } = queueFixture();
  try {
    const height = 20;
    const max = visibleBodyLines(height);
    const s = buildDashboardState(store, st({ tab: QUEUE_TAB }), 48, max);
    const qc = s.queueCompleted!;
    const { screen, puts } = capture(48, height);
    draw(screen, s);
    const header = puts.find((p) => p.str === qc.header)!;
    assert.equal(header.y, s.bodyTop + qc.startRow);
    assert.equal(puts.filter((p) => p.y === header.y).length, 1, 'nothing else is drawn on the completed header row');
    assert.equal(puts.find((p) => p.str === s.footer)!.y, height - 1, 'the footer is on the last row');
    assert.ok(puts.filter((p) => p.str !== s.footer).every((p) => p.y <= height - 3), 'the history stops above the reserved notice and footer rows');
    const belowWindow = puts.filter((p) => p.y >= s.bodyTop + qc.pendingLines! && p.y < s.bodyTop + qc.startRow);
    assert.deepEqual(belowWindow.map((p) => p.str), [qc.overflow], 'between the pending window and the divider only the overflow note is drawn');
    assert.match(qc.overflow!, /… \d+ more pending/);
  } finally {
    cleanup();
  }
});

test('queue: ↓ past the window scrolls the pending list, and a click on a scrolled row selects that record', () => {
  const { store, cleanup } = queueFixture();
  try {
    const max = visibleBodyLines(20);
    const vp = { width: 48, maxBodyLines: max };
    let ui = st({ tab: QUEUE_TAB });
    const window = buildDashboardState(store, ui, 48, max).queueCompleted!.pendingLines!;
    for (let i = 0; i < window + 2; i++) ui = reduce(store, ui, { kind: 'key', name: 'DOWN' }, vp).ui;
    assert.equal(ui.cursor, window + 2);
    assert.ok((ui.scroll ?? 0) > 0, 'the pending list scrolled to follow the cursor');
    const s = buildDashboardState(store, ui, 48, max);
    const cursorRow = s.rows[ui.cursor]!;
    const line = s.bodyTop + 1 + cursorRow.screenRow - s.scroll;
    assert.ok(line - 1 - s.bodyTop < s.queueCompleted!.pendingLines!, 'the selected row is inside the window');
    assert.equal(screenLineToRow(s, line, max), ui.cursor);
    const clicked = reduce(store, ui, { kind: 'click', x: 3, y: line }, vp);
    assert.deepEqual(clicked.effects, [{ type: 'select', recordType: 'todo', id: cursorRow.id }]);
    const { screen, puts } = capture(48, 20);
    draw(screen, s);
    assert.ok(puts.some((p) => p.y === line - 1 && p.str.includes(cursorRow.lines[0]!.text.trim())), 'the renderer drew that row on that line');
  } finally {
    cleanup();
  }
});

test('queue: the wheel scrolls the list under the pointer; the other list stays put', () => {
  const { store, cleanup } = queueFixture();
  try {
    const max = visibleBodyLines(20);
    const vp = { width: 48, maxBodyLines: max };
    const ui = st({ tab: QUEUE_TAB });
    const s = buildDashboardState(store, ui, 48, max);
    const historyLine = s.bodyTop + s.queueCompleted!.startRow + 2; // 1-based, below the completed header
    const pendingLine = s.bodyTop + 1;

    const h = reduce(store, ui, { kind: 'wheel', dy: 1, y: historyLine }, vp).ui;
    assert.equal(h.historyScroll, 3, 'the history list scrolled');
    assert.equal(h.scroll ?? 0, 0, 'the pending list did not');
    assert.equal(h.cursor, 0, 'the wheel does not move the cursor');
    const hs = buildDashboardState(store, h, 48, max);
    assert.equal(hs.queueCompleted!.scroll, 3);
    const before = capture(48, 20);
    draw(before.screen, s);
    const after = capture(48, 20);
    draw(after.screen, hs);
    const firstHistory = (c: ReturnType<typeof capture>) => c.puts.find((p) => p.y === s.bodyTop + s.queueCompleted!.startRow + 1)!.str;
    assert.notEqual(firstHistory(after), firstHistory(before), 'the renderer drew the history from its new offset');
    assert.equal(after.puts.find((p) => p.y === s.bodyTop + s.queueCompleted!.startRow)!.str, '— completed —', 'the header stays put');

    const p = reduce(store, ui, { kind: 'wheel', dy: 1, y: pendingLine }, vp).ui;
    assert.equal(p.scroll, 3, 'the pending list scrolled');
    assert.equal(p.historyScroll ?? 0, 0, 'the history list did not');

    // a wheel over the tab bar, the notice row or the footer scrolls nothing
    const height = 20;
    for (const [where, y] of [['tab bar', s.bodyTop - 1], ['spacer', s.bodyTop], ['notice row', height - 1], ['footer', height]] as const) {
      const r = reduce(store, ui, { kind: 'wheel', dy: 1, y }, vp);
      assert.equal(r.ui, ui, `a wheel over the ${where} (line ${y}) is a no-op`);
    }
    // the last drawn lines of each list still take it
    assert.equal(reduce(store, ui, { kind: 'wheel', dy: 1, y: s.bodyTop + s.queueCompleted!.startRow }, vp).ui.scroll, 3, 'the overflow-note line belongs to pending');
    assert.equal(reduce(store, ui, { kind: 'wheel', dy: 1, y: s.bodyTop + max }, vp).ui.historyScroll, 3, 'the last body line belongs to history');

    // clamped at both ends, and a tab switch resets both lists
    let far = ui;
    for (let i = 0; i < 20; i++) far = reduce(store, far, { kind: 'wheel', dy: 1, y: historyLine }, vp).ui;
    const fs = buildDashboardState(store, far, 48, max);
    assert.equal(far.historyScroll, fs.queueCompleted!.scroll, 'the reducer clamps to what the state draws');
    assert.equal(reduce(store, ui, { kind: 'wheel', dy: -1, y: historyLine }, vp).ui.historyScroll, 0);
    const switched = reduce(store, { ...far, scroll: 3 }, { kind: 'key', name: 'RIGHT' }, vp).ui;
    assert.equal(switched.historyScroll, undefined);
    assert.equal(switched.scroll, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Panes under 24 rows get the 4-row banner, and clicks still land
// ---------------------------------------------------------------------------

test('short pane: under 24 rows the compact banner is drawn, and the tab-bar and body clicks land on the moved rows', () => {
  const { store, cleanup } = fixture();
  try {
    const t1 = store.create({ ...envelope('todo'), text: 'first todo', source: 'user' }) as { id: string };
    store.create({ ...envelope('todo'), text: 'second todo', source: 'user' });
    const tall = buildDashboardState(store, st(), 80, visibleBodyLines(COMPACT_BELOW_HEIGHT, FULL_SCENE_ROWS - 1), 'demo', true, undefined, undefined, undefined, COMPACT_BELOW_HEIGHT);
    assert.equal(tall.banner.length, FULL_SCENE_ROWS - 1, '24 rows → the full scene');

    const height = COMPACT_BELOW_HEIGHT - 4;
    const bannerRows = bannerLines(80, true, height).length;
    assert.equal(bannerRows, COMPACT_SCENE_ROWS - 1);
    const max = visibleBodyLines(height, bannerRows);
    const s = buildDashboardState(store, st(), 80, max, 'demo', true, undefined, undefined, undefined, height);
    assert.equal(s.banner.length, COMPACT_SCENE_ROWS - 1, 'under 24 rows → the compact scene');
    assert.equal(s.bodyTop, COMPACT_SCENE_ROWS - 1 + 3);

    // the renderer draws the tabs on the row the hit-test reads
    const { screen, puts } = capture(80, height);
    draw(screen, s);
    assert.equal(puts.find((p) => p.str.startsWith(' Tasks'))!.y, s.bodyTop - 2, 'tab bar on 0-based row bodyTop-2 = 1-based line bodyTop-1');
    assert.equal(puts.find((p) => p.str.includes('first todo'))!.y, s.bodyTop, 'first body row on 0-based row bodyTop');

    const vp = { width: 80, maxBodyLines: max, showBanner: true, height };
    const tab = reduce(store, st(), { kind: 'click', x: tabX(s, 1), y: s.bodyTop - 1 }, vp);
    assert.equal(tab.ui.tab, KNOWLEDGE_TAB, 'the tab-bar click lands on the compact layout');
    const row = reduce(store, st(), { kind: 'click', x: 3, y: s.bodyTop + 1 }, vp);
    assert.deepEqual(row.effects, [{ type: 'select', recordType: 'todo', id: t1.id }], 'the first body line selects the first todo');
    // without the height the reducer would read the full-scene layout: the same line is a banner row
    const stale = reduce(store, st(), { kind: 'click', x: tabX(s, 1), y: s.bodyTop - 1 }, { width: 80, maxBodyLines: max, showBanner: true });
    assert.equal(stale.ui.tab, TASKS_TAB, 'control: the height is what moves the click row');
  } finally {
    cleanup();
  }
});

test('short pane: the controller threads the height, so its cached frame follows a resize', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-narrow-ctl-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'), { deferWrites: true });
  try {
    const vp = { width: 80, maxBodyLines: 10, showBanner: true };
    assert.equal(ctl.state({ ...vp, height: 40 }).bodyTop, FULL_SCENE_ROWS - 1 + 3);
    assert.equal(ctl.state({ ...vp, height: 20 }).bodyTop, COMPACT_SCENE_ROWS - 1 + 3);
    assert.equal(ctl.state(vp).bodyTop, FULL_SCENE_ROWS - 1 + 3, 'a host without a height keeps the full scene');
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
