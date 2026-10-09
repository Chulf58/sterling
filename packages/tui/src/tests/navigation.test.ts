import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import {
  buildDashboardState,
  initialUi,
  reduce,
  AGENTS_TAB,
  HELP_LINES,
  KNOWLEDGE_TAB,
  QUIT_PROMPT,
  SYSTEM_TAB,
  TASKS_TAB,
  type AgentRosterSnapshot,
  type DashboardState,
  type UiEvent,
  type UiState,
  type Viewport,
} from '../state.js';
import { keyToEvent, windowBlock } from '../render.js';
import { openDashboard } from '../controller.js';
import type { SubagentBlock } from '../subagents.js';

// Board fb516a43 (TUI fix 3 of 4): navigation and scrolling. Each acceptance
// point is pinned through reduce() and the state the renderer draws, so a key
// and what ends up on screen are checked against each other.

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });
const key = (name: Extract<UiEvent, { kind: 'key' }>['name']): UiEvent => ({ kind: 'key', name });

let clock = Date.parse('2026-06-10T12:00:00.000Z');
function envelope(type: string) {
  const at = new Date((clock -= 1000)).toISOString();
  return { id: randomUUID(), type, created_at: at, updated_at: at, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}

function fixture(): { store: SterlingStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nav-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 12 catalog models: taller than the 6-line body the picker tests use. */
const ENTRIES = Array.from({ length: 12 }, (_, i) => ({ id: `claude-m${i}`, label: `model ${i}`, tier: 'opus', status: 'active' }));
function roster(): AgentRosterSnapshot {
  return {
    agents: [{ name: 'implementor', installedModel: 'claude-m0', installedEffort: 'low' }],
    configModels: { implementor: { model: 'claude-m0', effort: 'low' }, classifiers: { model: 'claude-m1', effort: 'low' } },
    catalog: { present: true, stale: false, staleDate: null, entries: ENTRIES },
  };
}

/** the body line (0-based, unscrolled) of the picker's highlighted option */
function highlightLine(s: DashboardState): number {
  for (const r of s.rows) {
    const i = r.lines.findIndex((l) => /^ {2}› /.test(l.text));
    if (i !== -1) return r.screenRow + i;
  }
  return -1;
}

test('picker: the highlight stays on screen as it moves, and ENTER confirms the option that is shown', () => {
  const { store, cleanup } = fixture();
  try {
    const snap = roster();
    const vp: Viewport = { maxBodyLines: 6 };
    const state = (ui: UiState) => buildDashboardState(store, ui, Infinity, 6, '', false, undefined, snap);
    const visible = (ui: UiState) => {
      const s = state(ui);
      const line = highlightLine(s);
      return line >= s.scroll && line < s.scroll + 6;
    };
    let ui = reduce(store, st({ tab: SYSTEM_TAB }), key('ENTER'), vp, undefined, snap).ui;
    assert.equal(ui.selector?.stage, 'model');
    for (let i = 1; i < ENTRIES.length; i++) {
      ui = reduce(store, ui, key('DOWN'), vp, undefined, snap).ui;
      assert.equal(ui.selector?.highlight, i);
      assert.ok(visible(ui), `DOWN to option ${i}: the highlight is inside the window`);
    }
    for (let i = ENTRIES.length - 2; i >= 0; i--) {
      ui = reduce(store, ui, key('UP'), vp, undefined, snap).ui;
      assert.ok(visible(ui), `UP to option ${i}: the highlight is inside the window`);
    }
    const back = state(ui);
    assert.ok(back.scroll <= back.rows.find((r) => r.id === 'sys:implementor')!.screenRow, 'back at the first option the row title shows again');
    ui = reduce(store, ui, key('END'), vp, undefined, snap).ui;
    assert.equal(ui.selector?.highlight, ENTRIES.length - 1, 'End jumps to the last option');
    assert.ok(visible(ui));
    ui = reduce(store, ui, key('PAGE_UP'), vp, undefined, snap).ui;
    assert.equal(ui.selector?.highlight, ENTRIES.length - 1 - 5, 'PgUp moves a page less one line');
    assert.ok(visible(ui));
    ui = reduce(store, ui, key('HOME'), vp, undefined, snap).ui;
    assert.equal(ui.selector?.highlight, 0);
    ui = reduce(store, ui, key('PAGE_DOWN'), vp, undefined, snap).ui;
    assert.equal(ui.selector?.highlight, 5);
    assert.ok(visible(ui));
    const shown = state(ui).rows.flatMap((r) => r.lines).find((l) => /^ {2}› /.test(l.text))!.text;
    ui = reduce(store, ui, key('ENTER'), vp, undefined, snap).ui;
    assert.equal(ui.selector?.stage, 'effort');
    assert.ok(shown.includes(ui.selector!.model!), `ENTER confirmed the option on screen ('${shown}')`);
  } finally {
    cleanup();
  }
});

test('System tab clicks: a row click runs ENTER on that row; a picker option click picks that option', () => {
  const { store, cleanup } = fixture();
  try {
    const snap = roster();
    const vp: Viewport = { maxBodyLines: 40 };
    const state = (ui: UiState) => buildDashboardState(store, ui, Infinity, 40, '', false, undefined, snap);
    /** the 1-based screen line of `row`'s line `i` */
    const yOf = (s: DashboardState, id: string, i = 0) => {
      const r = s.rows.find((x) => x.id === id)!;
      return s.bodyTop + 1 + r.screenRow + i - s.scroll;
    };
    const click = (ui: UiState, y: number) => reduce(store, ui, { kind: 'click', x: 3, y }, vp, undefined, snap);
    const ui0 = st({ tab: SYSTEM_TAB });
    const s0 = state(ui0);

    const tdd = click(ui0, yOf(s0, 'sys:tdd_enabled'));
    assert.deepEqual(tdd.effects, [{ type: 'tdd_toggle', enabled: false }], 'a click on the TDD row flips it, as ENTER does');
    assert.equal(tdd.ui.cursor, 4, 'and moves the cursor there (2 model keys + 2 sparring rows)');

    const storage = click(ui0, yOf(s0, 'sys:storage'));
    assert.equal(storage.ui, ui0, 'the read-only storage row does nothing');
    assert.deepEqual(storage.effects, []);
    const banner = click(ui0, yOf(s0, s0.rows[0]!.id));
    assert.equal(s0.rows[0]!.type, 'system-banner');
    assert.equal(banner.ui, ui0, 'the catalog banner does nothing');

    const open = click(ui0, yOf(s0, 'sys:classifiers', 0));
    assert.deepEqual(open.ui.selector, { key: 'classifiers', stage: 'model', highlight: 0 }, 'a click on a model row opens its picker');
    const s1 = state(open.ui);
    const row = s1.rows.find((r) => r.id === 'sys:classifiers')!;
    const firstOption = row.lines.length - ENTRIES.length;
    const title = click(open.ui, yOf(s1, 'sys:classifiers', 0));
    assert.equal(title.ui, open.ui, "the picker's title line does nothing");
    const picked = click(open.ui, yOf(s1, 'sys:classifiers', firstOption + 7));
    assert.equal(picked.ui.selector?.stage, 'effort');
    assert.equal(picked.ui.selector?.model, 'claude-m7', 'the clicked option is the one confirmed');
    const s2 = state(picked.ui);
    const effortRow = s2.rows.find((r) => r.id === 'sys:classifiers')!;
    const committed = click(picked.ui, yOf(s2, 'sys:classifiers', effortRow.lines.length - 3 + 2));
    assert.deepEqual(committed.effects.map((e) => e.type), ['model_swap']);
    assert.deepEqual((committed.effects[0] as { to: unknown }).to, { model: 'claude-m7', effort: 'high' }, 'the clicked effort is committed');
  } finally {
    cleanup();
  }
});

test('PgUp, PgDn, Home and End move the Tasks selection a page or to the ends, the window following it', () => {
  const { store, cleanup } = fixture();
  try {
    for (let i = 0; i < 30; i++) store.create({ ...envelope('todo'), text: `task ${String(i).padStart(2, '0')}`, source: 'user' });
    const vp: Viewport = { maxBodyLines: 10 };
    const go = (ui: UiState, name: Parameters<typeof key>[0]) => reduce(store, ui, key(name), vp).ui;
    const inView = (ui: UiState) => {
      const s = buildDashboardState(store, ui, Infinity, 10);
      const r = s.rows.find((x) => x.selected)!;
      return r.screenRow >= s.scroll && r.screenRow < s.scroll + 10;
    };
    let ui = st({ tab: TASKS_TAB });
    ui = go(ui, 'PAGE_DOWN');
    assert.equal(ui.cursor, 9, 'PgDn moves the window less one line');
    assert.ok(inView(ui));
    ui = go(ui, 'PAGE_DOWN');
    assert.equal(ui.cursor, 18);
    assert.ok(inView(ui));
    ui = go(ui, 'END');
    assert.equal(ui.cursor, 29, 'End selects the last row');
    assert.equal(ui.scroll, 20);
    ui = go(ui, 'PAGE_UP');
    assert.equal(ui.cursor, 20);
    assert.ok(inView(ui));
    ui = go(ui, 'HOME');
    assert.equal(ui.cursor, 0, 'Home selects the first row');
    assert.equal(ui.scroll, 0);
    assert.equal(go(ui, 'PAGE_UP').cursor, 0, 'PgUp at the top stays');
    // the terminal names reach the reducer
    assert.deepEqual(keyToEvent('PAGE_UP'), key('PAGE_UP'));
    assert.deepEqual(keyToEvent('PAGE_DOWN'), key('PAGE_DOWN'));
    assert.deepEqual(keyToEvent('HOME'), key('HOME'));
    assert.deepEqual(keyToEvent('END'), key('END'));
    assert.deepEqual(keyToEvent('F1'), key('HELP'));
  } finally {
    cleanup();
  }
});

test('help overlay: ? or F1 opens it over any tab, it lists the keys, scrolls, and any other key closes it', () => {
  const { store, cleanup } = fixture();
  try {
    store.create({ ...envelope('todo'), text: 'only task', source: 'user' });
    const vp: Viewport = { maxBodyLines: 5 };
    const ui0 = st({ tab: TASKS_TAB });
    const open = reduce(store, ui0, { kind: 'char', ch: '?' }, vp);
    assert.deepEqual(open.ui.help, { scroll: 0 });
    const s = buildDashboardState(store, open.ui, 48, 5);
    assert.equal(s.rows.length, 1);
    assert.equal(s.rows[0]!.id, 'help');
    const text = s.rows[0]!.lines.map((l) => l.text).join('\n');
    for (const k of ['PgUp/PgDn', 'Home/End', 'ctrl-c', '? or F1', 'q ', 'click']) assert.ok(text.includes(k), `the help names ${k}`);
    assert.ok(HELP_LINES.every((l) => l.length <= 48), 'every help line fits the 48-column pane');
    assert.ok(s.footer.length <= 48 && /closes/.test(s.footer), `help footer: '${s.footer}'`);
    // it scrolls inside a short body; End reaches the last line
    const end = reduce(store, open.ui, key('END'), vp);
    assert.equal(buildDashboardState(store, end.ui, 48, 5).scroll, HELP_LINES.length - 5);
    const down = reduce(store, open.ui, key('DOWN'), vp);
    assert.deepEqual(down.ui.help, { scroll: 1 });
    // any other key closes it without acting on the tab below ('q' does not ask, '2' does not switch)
    for (const ev of [key('ESCAPE'), key('ENTER'), { kind: 'char', ch: 'q' } as UiEvent, { kind: 'char', ch: '2' } as UiEvent, { kind: 'click', x: 1, y: 9 } as UiEvent]) {
      const closed = reduce(store, down.ui, ev, vp);
      assert.equal(closed.ui.help, undefined, `${JSON.stringify(ev)} closes the help`);
      assert.equal(closed.ui.tab, TASKS_TAB);
      assert.deepEqual(closed.effects, []);
      assert.equal(closed.ui.quitConfirm, undefined);
    }
    // F1 opens it from an open editor, and the editor's buffer is kept
    const editing = st({ tab: TASKS_TAB, boardEdit: { id: 'x', text: 'draft', version: 1 } });
    const f1 = reduce(store, editing, key('HELP'), vp);
    assert.ok(f1.ui.help);
    assert.deepEqual(reduce(store, f1.ui, key('ESCAPE'), vp).ui.boardEdit, editing.boardEdit);
    assert.equal(reduce(store, editing, { kind: 'char', ch: '?' }, vp).ui.boardEdit?.text, 'draft?', "'?' types into the editor");
    // Knowledge: '?' opens the help while the search is empty, and is search text once a query is typed
    assert.ok(reduce(store, st({ tab: KNOWLEDGE_TAB }), { kind: 'char', ch: '?' }, vp).ui.help);
    const typed = reduce(store, st({ tab: KNOWLEDGE_TAB, searchQuery: 'a' }), { kind: 'char', ch: '?' }, vp).ui;
    assert.equal(typed.help, undefined);
    assert.equal(typed.searchQuery, 'a?');
  } finally {
    cleanup();
  }
});

test('q asks for confirmation: the second q quits, any other key cancels the question', () => {
  const { store, cleanup } = fixture();
  try {
    const q: UiEvent = { kind: 'char', ch: 'q' };
    const ask = reduce(store, st(), q);
    assert.deepEqual(ask.effects, [], 'the first q does not quit');
    assert.equal(ask.ui.quitConfirm, true);
    assert.equal(ask.ui.notice, QUIT_PROMPT);
    assert.ok(`⚠ ${QUIT_PROMPT}`.length <= 48, 'the question fits the 48-column notice row');
    assert.equal(buildDashboardState(store, ask.ui, 48, 10).notice, `⚠ ${QUIT_PROMPT}`, 'the question is on the notice row');
    assert.deepEqual(reduce(store, ask.ui, q).effects, [{ type: 'quit' }], 'the second q quits');
    const cancelled = reduce(store, ask.ui, key('DOWN'));
    assert.equal(cancelled.ui.quitConfirm, undefined, 'any other key cancels');
    assert.equal(cancelled.ui.notice, undefined, 'and clears the question');
    assert.deepEqual(reduce(store, cancelled.ui, q).effects, [], 'a q after that asks again');
    // a wheel or click cancels it too
    assert.equal(reduce(store, ask.ui, { kind: 'wheel', dy: 1 }).ui.quitConfirm, undefined);
    // another notice that replaced the question (a held write) is left alone
    const held = { ...ask.ui, notice: 'board edit not saved — press q again to quit and discard them' };
    assert.equal(reduce(store, held, key('DOWN')).ui.notice, held.notice);
    // Knowledge keeps 'q' as search text
    assert.equal(reduce(store, st({ tab: KNOWLEDGE_TAB }), q).ui.quitConfirm, undefined);
  } finally {
    cleanup();
  }
});

test('Ctrl-C quits at once everywhere: every tab, the Tasks editor, the System picker and model field, the help', () => {
  const { store, cleanup } = fixture();
  try {
    const snap = roster();
    const quit = key('QUIT');
    const cases: [string, UiState][] = [
      ['Tasks', st({ tab: TASKS_TAB })],
      ['Tasks editor', st({ tab: TASKS_TAB, boardEdit: { id: 'x', text: 'draft', version: 1 } })],
      ['Knowledge with a query', st({ tab: KNOWLEDGE_TAB, searchQuery: 'abc' })],
      ['Agents', st({ tab: AGENTS_TAB })],
      ['System', st({ tab: SYSTEM_TAB })],
      ['System picker', st({ tab: SYSTEM_TAB, selector: { key: 'implementor', stage: 'model', highlight: 3 } })],
      ['System model field', st({ tab: SYSTEM_TAB, cursor: 3, sparringModelEdit: 'gpt' })],
      ['help', st({ help: { scroll: 0 } })],
      ['q asked', st({ quitConfirm: true, notice: QUIT_PROMPT })],
    ];
    for (const [name, ui] of cases) {
      const out = reduce(store, ui, quit, { agents: { running: 0 } }, undefined, snap);
      assert.deepEqual(out.effects, [{ type: 'quit' }], `${name}: Ctrl-C quits`);
    }
    assert.deepEqual(keyToEvent('CTRL_C'), quit);
  } finally {
    cleanup();
  }
});

test('Agents tab: the arrows, page keys, Home/End and the wheel scroll the card block, clamped to its height', () => {
  const { store, cleanup } = fixture();
  try {
    const vp: Viewport = { agents: { running: 2 }, agentsLines: 40, maxBodyLines: 10 };
    const go = (ui: UiState, ev: UiEvent) => reduce(store, ui, ev, vp).ui;
    let ui = st({ tab: AGENTS_TAB });
    ui = go(ui, key('DOWN'));
    assert.equal(ui.scroll, 1);
    ui = go(ui, key('PAGE_DOWN'));
    assert.equal(ui.scroll, 10);
    ui = go(ui, key('END'));
    assert.equal(ui.scroll, 30, 'End shows the last screenful');
    assert.equal(go(ui, key('DOWN')), ui, 'past the end nothing moves');
    ui = go(ui, key('PAGE_UP'));
    assert.equal(ui.scroll, 21);
    ui = go(ui, { kind: 'wheel', dy: 1 });
    assert.equal(ui.scroll, 24);
    ui = go(ui, key('HOME'));
    assert.equal(ui.scroll, 0);
    // the state clamps a stale offset to the block the host composed
    assert.equal(buildDashboardState(store, st({ tab: AGENTS_TAB, scroll: 99 }), 80, 10, '', false, undefined, undefined, vp.agents, Infinity, undefined, 40).scroll, 30);
    assert.equal(buildDashboardState(store, st({ tab: AGENTS_TAB, scroll: 99 }), 80, 10, '', false, undefined, undefined, vp.agents).scroll, 0, 'no block, no scroll');
    // a block that fits never scrolls
    assert.equal(reduce(store, st({ tab: AGENTS_TAB }), key('DOWN'), { ...vp, agentsLines: 8 }).ui.scroll ?? 0, 0);
  } finally {
    cleanup();
  }
});

test('Agents tab: windowBlock draws only the scrolled window of the card block, moved to the top', () => {
  const block: SubagentBlock = {
    height: 20,
    puts: Array.from({ length: 20 }, (_, y) => ({ x: 0, y, attr: {}, text: `line ${y}` })),
    pixels: Array.from({ length: 20 }, (_, y) => ({ x: 1, y, ch: '▀' })),
  };
  const w = windowBlock(block, 5, 10);
  assert.equal(w.height, 10);
  assert.deepEqual(w.puts.map((p) => [p.y, p.text]), Array.from({ length: 10 }, (_, i) => [i, `line ${i + 5}`]));
  assert.deepEqual(w.pixels.map((p) => p.y), Array.from({ length: 10 }, (_, i) => i), 'no portrait pixel outside the window');
  const tail = windowBlock(block, 15, 10);
  assert.equal(tail.height, 5, 'the window ends with the block');
  assert.deepEqual(windowBlock(block, 0, 30).puts.length, 20);
});

test('controller: the Agents block height is part of the frame key, so a shorter block re-clamps the scroll', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nav-ctl-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'));
  try {
    const vp = { width: 80, maxBodyLines: 10, showBanner: false, agents: { running: 1 }, agentsLines: 40 };
    await ctl.handle({ kind: 'tab', index: AGENTS_TAB }, vp);
    await ctl.handle(key('END'), vp);
    assert.equal(ctl.state(vp).scroll, 30);
    assert.equal(ctl.state({ ...vp, agentsLines: 20 }).scroll, 10, 'an agent that finished shortens the block: the window follows');
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
