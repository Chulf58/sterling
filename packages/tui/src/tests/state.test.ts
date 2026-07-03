import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, MountedStores } from '@sterling/store';
import { todoCards, noteCards, runView } from '../viewmodel.js';
import * as viewmodel from '../viewmodel.js';
import { buildDashboardState, initialUi, reduce, runEffects, screenLineToRow, visibleBodyLines, wrapText, RUN_TAB, QUEUE_TAB, TABS, type UiState, type DashboardState } from '../state.js';
import * as stateMod from '../state.js';
import { bannerLines, bannerPaletteIndex, ART_WIDTH, WORDMARK, BANNER_ROWS } from '../banner.js';
import { keyToEvent, mouseToEvent, draw } from '../render.js';

const NOW = '2026-06-10T12:00:00.000Z';

/** UiState literal helper — defaults from initialUi, overrides on top. */
const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

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

function article(store: SterlingStore, slug: string, title: string, what: string, files: string[]) {
  return store.create({
    ...envelope('feature_article'),
    slug,
    title,
    what_it_does: what,
    intended_behavior: 'works as designed',
    files: files.map((path) => ({ path, role: 'impl' })),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seeded' }],
    live_test_refs: [],
  }) as { id: string };
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
    assert.deepEqual(s.tabs.map((t) => t.active), [true, false, false, false, false, false]);
    assert.deepEqual(s.rows.map((r) => r.screenRow), [0, 1]);
    assert.equal(s.rows[0].selected, true);
    assert.equal(s.rows[0].lines.length, 1, 'collapsed by default: one title line');

    s = buildDashboardState(store, st({ expanded: [t1.id] }));
    const meta = s.rows[0].lines.at(-1)!;
    assert.equal(meta.kind, 'meta');
    assert.match(meta.text, /priority: high/);
    assert.deepEqual(s.rows.map((r) => r.screenRow), [0, 2], 'expanded row occupies body + meta lines');

    s = buildDashboardState(store, st({ tab: RUN_TAB }));
    assert.equal(s.emptyMessage, 'no active run');
    assert.equal(s.runSelected, true);
  } finally {
    cleanup();
  }
});

test('queue tab (§3.2.7/§11): system items only, fixed half divider with truncation, completed drain-log lines never clickable', () => {
  const { store, t1, cleanup } = fixture();
  try {
    // pending: ONLY system-source todos (the fixture has one + 2 user todos)
    let ui = st({ tab: QUEUE_TAB });
    let s = buildDashboardState(store, ui);
    assert.equal(s.rows.length, 1, 'user todos never appear on the queue tab');
    assert.match(s.rows[0].lines[0].text, /hidden maintenance/);
    assert.match(s.rows[0].id, /.+/);
    assert.notEqual(s.rows[0].id, t1.id);

    // completed section exists with the fixed divider; empty state is loud
    assert.ok(s.queueCompleted, 'completed section always present on the queue tab');
    assert.deepEqual(s.queueCompleted!.lines, ['(nothing completed yet)']);

    // drain a system item through the store → `HH:mm <verb> · <target>` (§11):
    // no quoted name + no file keys → the text itself is the target
    const extra = store.create({ ...envelope('todo'), text: 'refresh ref y', source: 'system', system_reason: 'refresh_reference' }) as { id: string };
    store.remove(extra.id, '2026-06-10T12:34:00.000Z');
    s = buildDashboardState(store, ui);
    assert.equal(s.queueCompleted!.lines.length, 1);
    assert.match(s.queueCompleted!.lines[0], /^(\d{2}-\d{2} )?\d{2}:\d{2} refreshed · refresh ref y$/, 'left stamp + DRAIN_VERBS verb + target');

    // quoted-name target extraction + file-key fallback with (+N)
    const named = store.create({
      ...envelope('todo'),
      text: "reconcile article 'tui-dashboard' — files it owns were touched in direct mode",
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['packages/tui/src/state.ts'],
    }) as { id: string };
    store.remove(named.id, '2026-06-10T12:35:00.000Z');
    const keyed = store.create({
      ...envelope('todo'),
      text: 'article missing: direct-mode work touched 3 file(s) no feature_article owns',
      source: 'system',
      system_reason: 'article_missing',
      file_keys: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'],
    }) as { id: string };
    store.remove(keyed.id, '2026-06-10T12:30:00.000Z'); // OLDEST stamp drained LAST, on purpose
    s = buildDashboardState(store, ui);
    assert.equal(s.queueCompleted!.lines.length, 3);
    assert.match(s.queueCompleted!.lines[1], / updated · tui-dashboard$/, "quoted 'name' wins as the target");
    // ordering is the drain SEQUENCE (newest drain first), never the displayed
    // stamp — the last-drained item carries the oldest stamp yet sits on top
    assert.match(s.queueCompleted!.lines[0], / created · src\/a\.mjs \(\+2\)$/, 'file-key fallback with (+N); seq beats stamp');

    // fixed half split: maxBodyLines 6 → divider at body offset 3; pending
    // truncated in the STATE layer so clicks can never hit clipped rows
    for (let i = 0; i < 5; i++) store.create({ ...envelope('todo'), text: `q-item ${i}`, source: 'system', system_reason: 'capture_owed' });
    s = buildDashboardState(store, ui, Infinity, 6);
    assert.equal(s.queueCompleted!.startRow, 3);
    const pendingLines = s.rows.length ? s.rows.at(-1)!.screenRow + s.rows.at(-1)!.lines.length : 0;
    assert.ok(pendingLines <= 2, 'pending clipped above the divider (one line reserved for the overflow note)');
    assert.match(s.queueCompleted!.overflow!, /… \d+ more pending/);

    // a click in the completed region maps to no row — log lines are not records
    const lineInCompleted = 4 + s.queueCompleted!.startRow + 1; // 1-based terminal line of the first completed entry
    assert.equal(screenLineToRow(s, lineInCompleted, 6), -1);
    const clicked = reduce(store, ui, { kind: 'click', x: 1, y: lineInCompleted }, { maxBodyLines: 6 });
    assert.deepEqual(clicked.effects, [], 'completed entries cannot be selected');
    assert.deepEqual(clicked.ui, ui);

    // pending items ARE selectable as usual
    const sel = reduce(store, ui, { kind: 'key', name: 'ENTER' });
    assert.equal(sel.effects.length, 1);
    assert.equal((sel.effects[0] as { recordType: string }).recordType, 'todo');
  } finally {
    cleanup();
  }
});

test('screenLineToRow: maps clicks through bodyTop and expanded heights', () => {
  const { store, t1, cleanup } = fixture();
  try {
    const s = buildDashboardState(store, st({ expanded: [t1.id] }));
    // terminal lines are 1-based; body starts after header + tab bar + blank (bodyTop=3) → line 4
    assert.equal(screenLineToRow(s, 4), 0, 'first row');
    assert.equal(screenLineToRow(s, 5), 0, 'its expanded detail line still maps to row 0');
    assert.equal(screenLineToRow(s, 6), 1, 'second todo shifted down by the expansion');
    assert.equal(screenLineToRow(s, 1), -1, 'header row is not a body row');
    assert.equal(screenLineToRow(s, 99), -1);
  } finally {
    cleanup();
  }
});

test('header row: project folder name rides on the state; tabs shift to the second row (bodyTop=3)', () => {
  const { store, cleanup } = fixture();
  try {
    // no name threaded → empty header, but the body still starts at line 3
    // (0-based: header, tab bar, blank) so the geometry is stable
    assert.equal(buildDashboardState(store, initialUi).projectName, '');
    assert.equal(buildDashboardState(store, initialUi).bodyTop, 3);

    const s = buildDashboardState(store, initialUi, Infinity, Infinity, 'Sterling');
    assert.equal(s.projectName, 'Sterling', 'the folder name is carried for the renderer to draw on row 0');

    // tab-bar clicks now land on terminal line 2 — the project name owns line 1
    const tabClick = reduce(store, initialUi, { kind: 'click', x: 9, y: 2 });
    assert.equal(tabClick.ui.tab, 1, 'Notes selected on the shifted tab row');

    // a click on the header row itself selects nothing
    const headerClick = reduce(store, initialUi, { kind: 'click', x: 1, y: 1 });
    assert.deepEqual(headerClick.effects, []);
    assert.deepEqual(headerClick.ui, initialUi);
  } finally {
    cleanup();
  }
});

test('banner (§11): width-aware rows, suppression, palette gradient endpoints', () => {
  // full 3-row art at/above its width; the 1-line wordmark below it; clipped narrower
  assert.deepEqual(bannerLines(ART_WIDTH, true), [...BANNER_ROWS]);
  assert.deepEqual(bannerLines(Infinity, true), [...BANNER_ROWS], 'unbounded width gets the art');
  assert.deepEqual(bannerLines(ART_WIDTH - 1, true), [WORDMARK], 'too narrow for art → 1-line wordmark');
  assert.deepEqual(bannerLines(5, true), [WORDMARK.slice(0, 5)], 'narrower than the wordmark → clipped');
  assert.deepEqual(bannerLines(0, true), [], 'no room → nothing');
  assert.deepEqual(bannerLines(ART_WIDTH, false), [], 'suppressed → nothing regardless of width');

  // gradient: light at the left, steel at the right; clamps; always a palette index
  assert.notEqual(bannerPaletteIndex(0), bannerPaletteIndex(1), 'endpoints differ');
  for (const t of [-1, 0, 0.5, 1, 2]) {
    const idx = bannerPaletteIndex(t);
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx <= 255, `valid 256-palette index at t=${t}`);
  }
  assert.equal(bannerPaletteIndex(-1), bannerPaletteIndex(0), 'clamps below 0');
  assert.equal(bannerPaletteIndex(2), bannerPaletteIndex(1), 'clamps above 1');
});

test('banner layout: bodyTop follows banner height; suppressed = today\'s layout; geometry ripples', () => {
  const { store, cleanup } = fixture();
  try {
    // suppressed (default): banner empty, bodyTop=3 — the prior fixed layout
    let s = buildDashboardState(store, initialUi);
    assert.deepEqual(s.banner, []);
    assert.equal(s.bodyTop, 3, 'no banner → today\'s layout');

    // shown wide: 3 art rows push bodyTop to 6; body screenRows stay body-relative
    s = buildDashboardState(store, initialUi, Infinity, Infinity, 'Sterling', true);
    assert.deepEqual(s.banner, [...BANNER_ROWS]);
    assert.equal(s.bodyTop, 6, 'banner.length (3) + header + tabs + spacer');
    assert.equal(s.projectName, 'Sterling');
    assert.deepEqual(s.rows.map((r) => r.screenRow), [0, 1], 'rows stay body-relative');

    // clicks map through the banner-shifted bodyTop: first body row is line 7
    assert.equal(screenLineToRow(s, 7), 0, 'first body row under a 3-row banner');
    assert.equal(screenLineToRow(s, 6), -1, 'the spacer line is not a body row');

    // tab-bar click now lands on terminal line bodyTop-1 (=5), not 2
    const tabClick = reduce(store, initialUi, { kind: 'click', x: 9, y: 5 }, { showBanner: true });
    assert.equal(tabClick.ui.tab, 1, 'Notes selected on the banner-shifted tab row');
    // a click on a banner row selects nothing
    const bannerClick = reduce(store, initialUi, { kind: 'click', x: 1, y: 2 }, { showBanner: true });
    assert.deepEqual(bannerClick.effects, []);
    assert.deepEqual(bannerClick.ui, initialUi);

    // visibleBodyLines shrinks by the banner height (sync with the draw() clamp)
    assert.equal(visibleBodyLines(12, 0), 7, 'no banner: height - 5');
    assert.equal(visibleBodyLines(12, 3), 4, '3-row banner steals 3 lines');
    assert.equal(visibleBodyLines(6, 3), 0, 'degenerate pane under a banner: nothing clickable');
  } finally {
    cleanup();
  }
});

test('viewport clamp: rows the renderer clips are not clickable (off-screen click regression)', () => {
  const { store, t1, cleanup } = fixture();
  try {
    // visibleBodyLines mirrors the draw() clamp: body spans lines bodyTop+1 .. height-2
    assert.equal(visibleBodyLines(8), 3);
    assert.equal(visibleBodyLines(4), 0);
    assert.equal(visibleBodyLines(2), 0, 'degenerate pane: nothing clickable');

    // one visible body line: the first todo (line 4) hits, the second (line 5) is clipped
    const s = buildDashboardState(store, initialUi);
    assert.equal(screenLineToRow(s, 4, 1), 0);
    assert.equal(screenLineToRow(s, 5, 1), -1, 'clipped row must not map');

    // an expanded row's detail line beyond the viewport is not a hit either
    const sx = buildDashboardState(store, st({ expanded: [t1.id] }));
    assert.equal(screenLineToRow(sx, 5, 1), -1, 'hidden detail line must not map');

    // through reduce: a click below the viewport is a no-op (no selection effect, no expand)
    const clipped = reduce(store, initialUi, { kind: 'click', x: 1, y: 5 }, { maxBodyLines: 1 });
    assert.deepEqual(clipped.effects, []);
    assert.deepEqual(clipped.ui, initialUi);
  } finally {
    cleanup();
  }
});

test('wrapText: word boundaries, hard-broken long words, preserved newlines', () => {
  assert.deepEqual(wrapText('a bb ccc', 5), ['a bb', 'ccc']);
  assert.deepEqual(wrapText('abcdefgh', 3), ['abc', 'def', 'gh']);
  assert.deepEqual(wrapText('line one\nline two', 8), ['line one', 'line two']);
  assert.deepEqual(wrapText('a\n\nb', 5), ['a', '', 'b'], 'blank lines survive');
  assert.deepEqual(wrapText('a bb ccc', Infinity), ['a bb ccc'], 'Infinity width: newline split only');
});

test('expanded cards wrap the full body at the pane width; collapsed titles clip with ellipsis', () => {
  const { store, cleanup } = fixture();
  try {
    const long = store.create({
      ...envelope('todo'),
      text: 'a very long todo text that cannot possibly fit on one narrow pane line',
      source: 'user',
      priority: 'low',
    }) as { id: string };
    const width = 24;

    // collapsed: one line, clipped with an ellipsis affordance
    let s = buildDashboardState(store, st(), width);
    const collapsed = s.rows.find((r) => r.id === long.id)!;
    assert.equal(collapsed.lines.length, 1);
    assert.equal(collapsed.lines[0].text.length, width);
    assert.match(collapsed.lines[0].text, /…$/);

    // expanded: full body wrapped (every line within width), then the meta line
    s = buildDashboardState(store, st({ expanded: [long.id] }), width);
    const expanded = s.rows.find((r) => r.id === long.id)!;
    assert.ok(expanded.lines.length > 3, 'body wraps over multiple lines');
    assert.equal(expanded.lines[0].kind, 'title');
    assert.equal(expanded.lines.at(-1)!.kind, 'meta');
    for (const line of expanded.lines.slice(0, -1)) assert.ok(line.text.length <= width, `fits: "${line.text}"`);
    const joined = expanded.lines
      .slice(0, -1)
      .map((l) => l.text.trim())
      .join(' ');
    assert.equal(joined.replace(/\s+/g, ' ').replace(/^› /, ''), 'a very long todo text that cannot possibly fit on one narrow pane line');

    // hit-test: a click on a middle wrapped body line maps to the card, and the
    // rows below shift by the wrapped height
    const idx = s.rows.findIndex((r) => r.id === long.id);
    const mid = 4 + s.rows[idx].screenRow + 2; // terminal line of the card's 3rd display line
    assert.equal(screenLineToRow(s, mid), idx);
    const { ui } = reduce(store, st({ expanded: [long.id] }), { kind: 'click', x: 1, y: mid }, { width });
    assert.deepEqual(ui.expanded, [], 'clicking the wrapped body collapses the card');
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
    const charQuit = reduce(store, ui, { kind: 'char', ch: 'q' });
    assert.deepEqual(charQuit.effects, [{ type: 'quit' }], "the 'q' char quits outside search input");
  } finally {
    cleanup();
  }
});

test('reduce: digit hotkeys select tabs directly; out-of-range digits are a no-op', () => {
  const { store, cleanup } = fixture();
  try {
    let ui: UiState = st({ cursor: 1 });
    ({ ui } = reduce(store, ui, { kind: 'tab', index: TABS.length - 1 }));
    assert.equal(ui.tab, TABS.length - 1, 'last tab reachable by its digit');
    assert.equal(ui.cursor, 0, 'tab switch resets the cursor');

    ({ ui } = reduce(store, ui, { kind: 'tab', index: 0 }));
    assert.equal(ui.tab, 0);

    ({ ui } = reduce(store, ui, { kind: 'char', ch: String(TABS.length) }));
    assert.equal(ui.tab, TABS.length - 1, 'digit chars switch tabs outside search input');

    const before = ui;
    ({ ui } = reduce(store, ui, { kind: 'tab', index: TABS.length }));
    assert.deepEqual(ui, before, 'digit past the registered tab count is ignored');
    ({ ui } = reduce(store, ui, { kind: 'char', ch: '9' }));
    assert.deepEqual(ui, before, 'out-of-range digit char is ignored too');
  } finally {
    cleanup();
  }
});

test('reduce: mouse — wheel scrolls, click activates by screen line, tab-bar click switches, right-click collapses', () => {
  const { store, t1, t2, cleanup } = fixture();
  try {
    let ui: UiState = initialUi;
    // wheel scrolls the viewport now (not the cursor); with content that fits the
    // pane (unbounded viewport here) it is a clamped no-op. The dedicated 'scroll:'
    // test pins the real scroll behaviour.
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: 1 }));
    assert.equal(ui.cursor, 0, 'wheel no longer moves the cursor');
    assert.equal(ui.scroll ?? 0, 0, 'nothing to scroll when the body fits');

    // click the second todo (body line 5 when nothing is expanded; bodyTop=3)
    const click = reduce(store, ui, { kind: 'click', x: 5, y: 5 });
    assert.deepEqual(click.effects, [{ type: 'select', recordType: 'todo', id: t2.id }]);
    assert.deepEqual(click.ui.expanded, [t2.id]);
    assert.equal(click.ui.cursor, 1, 'click moves the cursor');

    // with t2 expanded, clicking THROUGH the shifted layout still hits t1's line
    const clickFirst = reduce(store, click.ui, { kind: 'click', x: 5, y: 4 });
    assert.equal(clickFirst.effects[0]!.type, 'select');
    assert.equal((clickFirst.effects[0] as { id: string }).id, t1.id);

    // tab bar is the SECOND row now (project name is row 1): ' Todos  Notes … ' — Notes after ' Todos ' (7 cols)
    const tabClick = reduce(store, ui, { kind: 'click', x: 9, y: 2 });
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

test('scroll: wheel scrolls the viewport, arrows follow the cursor, hit-test tracks the offset, resets on tab switch', () => {
  const { store, cleanup } = fixture(); // 2 user todos already
  try {
    for (let i = 0; i < 8; i++) store.create({ ...envelope('todo'), text: `todo ${i}`, source: 'user' });
    // 10 user todos, 1 collapsed line each → 10 body lines; the pane shows 3
    const vp = { maxBodyLines: 3, width: 80 };

    // the rendered state exposes the clamped scroll (maxScroll = 10 − 3 = 7)
    let s = buildDashboardState(store, st(), 80, 3);
    assert.equal(s.rows.length, 10);
    assert.equal(s.scroll, 0, 'collapsed default starts at the top');

    // wheel scrolls the viewport by lines, clamped to maxScroll
    let ui = st();
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: 1 }, vp));
    assert.equal(ui.scroll, 3, 'wheel down scrolls 3 lines');
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: 1 }, vp));
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: 1 }, vp));
    assert.equal(ui.scroll, 7, 'wheel clamps at maxScroll (10 rows − 3 visible)');
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: -1 }, vp));
    assert.equal(ui.scroll, 4, 'wheel up scrolls back');

    // the click hit-test tracks the offset: at scroll 4 the first visible body
    // line (terminal line bodyTop+1 = 4) maps to row 4, not row 0
    s = buildDashboardState(store, st({ scroll: 4 }), 80, 3);
    assert.equal(s.scroll, 4);
    assert.equal(screenLineToRow(s, 4, 3), 4, 'first visible line maps through the scroll offset');
    assert.equal(screenLineToRow(s, 6, 3), 6, 'last visible line');
    assert.equal(screenLineToRow(s, 7, 3), -1, 'beyond the 3-line window is not clickable');

    // arrows move the selection and the viewport FOLLOWS it
    let r = reduce(store, st({ cursor: 2, scroll: 5 }), { kind: 'key', name: 'UP' }, vp);
    assert.equal(r.ui.cursor, 1);
    assert.equal(r.ui.scroll, 1, 'a cursor above the window pulls the viewport up to it');
    r = reduce(store, st({ cursor: 8, scroll: 7 }), { kind: 'key', name: 'UP' }, vp);
    assert.equal(r.ui.cursor, 7);
    assert.equal(r.ui.scroll, 7, 'a cursor already in view leaves the viewport put');

    // a tab switch resets the scroll
    r = reduce(store, st({ scroll: 5 }), { kind: 'key', name: 'TAB' }, vp);
    assert.equal(r.ui.scroll, 0, 'tab switch resets scroll');

    // back-compat: an unbounded viewport never scrolls (wheel is a clamped no-op)
    assert.equal(reduce(store, st(), { kind: 'wheel', dy: 1 }).ui.scroll ?? 0, 0);
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
    const ui: UiState = st({ tab: RUN_TAB });
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
  assert.deepEqual(keyToEvent('CTRL_C'), { kind: 'key', name: 'QUIT' });
  assert.deepEqual(keyToEvent('ESCAPE'), { kind: 'key', name: 'ESCAPE' });
  assert.deepEqual(keyToEvent('BACKSPACE'), { kind: 'key', name: 'BACKSPACE' });
  // printable keys travel as chars — the state layer decides by mode
  assert.deepEqual(keyToEvent('q'), { kind: 'char', ch: 'q' });
  assert.deepEqual(keyToEvent('1'), { kind: 'char', ch: '1' });
  assert.deepEqual(keyToEvent('/'), { kind: 'char', ch: '/' });
  assert.deepEqual(keyToEvent(' '), { kind: 'char', ch: ' ' });
  assert.equal(keyToEvent('F5'), undefined, 'unmapped named keys stay inert');
  assert.deepEqual(mouseToEvent('MOUSE_LEFT_BUTTON_PRESSED', { x: 3, y: 4 }), { kind: 'click', x: 3, y: 4 });
  assert.deepEqual(mouseToEvent('MOUSE_RIGHT_BUTTON_PRESSED', { x: 1, y: 1 }), { kind: 'rightclick' });
  assert.deepEqual(mouseToEvent('MOUSE_WHEEL_DOWN', { x: 0, y: 0 }), { kind: 'wheel', dy: 1 });
  assert.deepEqual(mouseToEvent('MOUSE_WHEEL_UP', { x: 0, y: 0 }), { kind: 'wheel', dy: -1 });
  assert.equal(mouseToEvent('MOUSE_MOTION', { x: 0, y: 0 }), undefined);
});

// ===========================================================================
// FROZEN P2 oracle (run r-dd88) — SPEC-ONLY, written before the viewmodel
// knowledge surface exists. These pin the brief's phase-P2 interfaces
// (viewmodel.KNOWLEDGE_CATEGORIES / toCard / knowledgeBySource / knowledgeSearch
// + Card.source) against ACs AC3 (all five categories mapped), AC4 (readable
// multi-section bodies, title never replaced by body) and AC5 (flat, source-
// tagged, bm25 AND search). They MUST fail RED on AssertionError, never by
// throwing, until the coder implements the surface.
//
// CLEAN-RED discipline (mirrors the frozen P1 oracle in mounted.test.ts):
//   • the not-yet-existent symbols are reached through NARROW casts on the
//     viewmodel module namespace, so the file COMPILES under tsc strict before
//     the exports exist (a tsc error would be a build CRASH = refused);
//   • an EXISTENCE assertion runs FIRST in every test, so an unimplemented
//     symbol yields a clean AssertionError rather than a TypeError throw.
// The fixtures use the already-shipped (P1) MountedStores + bySource.
// ===========================================================================

/** A knowledge category entry as KNOWLEDGE_CATEGORIES exposes it (brief
 *  interface viewmodel.KNOWLEDGE_CATEGORIES). Narrowed to the two fields the
 *  oracle reads so tsc compiles before the registry is declared. */
interface CategoryEntry {
  type: string;
  label: string;
}

/** Card narrowed to exactly what the P2 oracle asserts (the real Card gains an
 *  optional source? in P2 — not depended on here so tsc compiles regardless). */
interface CardLike {
  id: string;
  type: string;
  title: string;
  body: string;
  detail: string;
  source?: string;
}

/** The viewmodel knowledge surface (brief interfaces) — every member optional so
 *  the cast is valid before the coder adds them; each test existence-asserts the
 *  member it uses FIRST. */
interface KnowledgeViewmodel {
  KNOWLEDGE_CATEGORIES?: CategoryEntry[];
  toCard?: (rec: unknown) => CardLike;
  knowledgeCountBySource?: (store: MountedStores, type: string) => { source: string; count: number }[];
  knowledgeSearch?: (store: MountedStores, rankTerms: string[]) => CardLike[];
}
const vm = viewmodel as unknown as KnowledgeViewmodel;

// -- record builders (full valid envelopes per @sterling/schemas) ------------
function kenv(type: string, scope = 'project') {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope, stack_tags: [] };
}
function decisionRec(over: Record<string, unknown> = {}) {
  return {
    ...kenv('decision'),
    title: 'Compose over ATTACH',
    statement: 'MountedStores composes self-contained SterlingStores',
    rationale: 'each store is already tested in isolation',
    alternatives_rejected: [{ option: 'SQLite ATTACH', reason: 'couples schema lifecycles' }],
    ...over,
  };
}
function antiPatternRec(over: Record<string, unknown> = {}) {
  return {
    ...kenv('anti_pattern'),
    title: 'Bypassing the store write path',
    trigger: 'editing .sterling/ with a shell script',
    guidance: 'route every write through the MCP tool surface',
    wrong_way: 'sqlite3 .sterling/sterling.db "INSERT ..."',
    right_way: 'call knowledge_create through the server',
    source_evidence: 'the stale-server incident 2026-06-16',
    severity: 'block',
    basis: 'codebase',
    ...over,
  };
}
function researchRec(over: Record<string, unknown> = {}) {
  return {
    ...kenv('research_finding'),
    question: 'Can SQLite WAL open over a //wsl.localhost 9p mount?',
    answer: 'No — the driver reports "database is locked"; use a stale VACUUM-INTO snapshot',
    source_urls: ['https://example.test/wsl-9p'],
    source_date: '2026-06-20',
    capture_date: '2026-06-20',
    ...over,
  };
}
function referenceRec(over: Record<string, unknown> = {}) {
  return {
    ...kenv('reference_material'),
    title: 'terminal-kit ScreenBuffer reference',
    kind: 'url',
    location: 'https://example.test/terminal-kit',
    summary: 'delta draw + 256-palette attrs',
    source_date: '2026-06-18',
    capture_date: '2026-06-18',
    basis: 'external',
    ...over,
  };
}
function featureArticleRec(over: Record<string, unknown> = {}) {
  return {
    ...kenv('feature_article'),
    slug: 'tui-knowledge',
    title: 'TUI knowledge explorer',
    what_it_does: 'projects every knowledge category across the mounted stores',
    intended_behavior: 'the observer finally observes all knowledge, not just articles',
    files: [{ path: 'packages/tui/src/viewmodel.ts', role: 'impl' }],
    current_ac: [{ ac_id: 'AC3', text: 'all five categories surface', verifiable_at: 'final' }],
    dependencies: { relies_on: ['sqlite-store'], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seeded' }],
    live_test_refs: [],
    ...over,
  };
}

/** MountedStores fixture (mirrors mounted.test.ts's harness): a project store
 *  plus one mounted domain store, both real on disk. */
function mountedFixture(domains: string[] = ['node']) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-vm-knowledge-'));
  const mounts = domains.map((name) => ({ name, dbPath: join(dir, 'domains', name, 'sterling.db') }));
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), mounts);
  return { dir, stores, cleanup: () => { stores.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('P2 AC3: KNOWLEDGE_CATEGORIES is the exact ordered registry — 5 knowledge types, note + disconfirmed_hypothesis EXCLUDED', () => {
  assert.ok(Array.isArray(vm.KNOWLEDGE_CATEGORIES), 'viewmodel.KNOWLEDGE_CATEGORIES must be an exported array (AC3)');
  const cats = vm.KNOWLEDGE_CATEGORIES!;
  // exact set AND order (the tree iterates this registry in order)
  assert.deepEqual(
    cats.map((c) => c.type),
    ['feature_article', 'decision', 'anti_pattern', 'research_finding', 'reference_material'],
    'the five knowledge categories, in this order'
  );
  // explicit exclusions — note has its own tab, disconfirmed_hypothesis is niche
  assert.ok(!cats.some((c) => c.type === 'note'), 'note is NOT a knowledge category (it has its own tab)');
  assert.ok(!cats.some((c) => c.type === 'disconfirmed_hypothesis'), 'disconfirmed_hypothesis is excluded');
  // every entry carries a non-empty human label
  for (const c of cats) assert.ok(typeof c.label === 'string' && c.label.length > 0, `category '${c.type}' has a label`);
});

test('P2 AC3+AC4: toCard(feature_article) — title from title field; multi-section body (What it does / Intended behaviour); detail metadata', () => {
  assert.strictEqual(typeof vm.toCard, 'function', 'viewmodel.toCard must exist (AC3)');
  const card = vm.toCard!(featureArticleRec());
  assert.equal(card.type, 'feature_article');
  assert.equal(card.title, 'TUI knowledge explorer', 'title comes from the article title field, verbatim');
  // AC4: the body is MULTI-SECTION (blank-line separated), not one unbroken blob
  assert.ok(card.body.includes('\n\n'), 'body has at least one blank-line section separator (AC4: never one line)');
  assert.match(card.body, /What it does:/i, "labeled 'What it does:' section");
  assert.match(card.body, /Intended behaviour:|Intended behavior:/i, "labeled intended-behaviour section");
  assert.match(card.body, /projects every knowledge category/, 'what_it_does content present');
  assert.match(card.body, /the observer finally observes all knowledge/, 'intended_behavior content present');
  // AC4: the title text must NOT be embedded as the first body line (title never replaced by body)
  assert.ok(!card.body.startsWith(card.title), 'the body does not begin with the title (title kept separate, AC4)');
  // detail carries the article's structured metadata
  assert.match(card.detail, /tui-knowledge/, 'detail names the slug');
  assert.match(card.detail, /active/, 'detail names the state');
});

test('P2 AC3+AC4: toCard(decision) — title; body = statement + Why/rationale + rejected alternatives, blank-separated', () => {
  assert.strictEqual(typeof vm.toCard, 'function', 'viewmodel.toCard must exist (AC3)');
  const card = vm.toCard!(decisionRec());
  assert.equal(card.type, 'decision');
  assert.equal(card.title, 'Compose over ATTACH', 'title from the decision title field');
  assert.ok(card.body.includes('\n\n'), 'decision body is multi-section (AC4)');
  assert.match(card.body, /MountedStores composes self-contained SterlingStores/, 'statement present in the body');
  assert.match(card.body, /Why:|Rationale:/i, 'a labeled rationale section');
  assert.match(card.body, /each store is already tested in isolation/, 'rationale content present');
  // rejected alternatives are surfaced (option AND its reason), not dropped
  assert.match(card.body, /SQLite ATTACH/, 'rejected option surfaced');
  assert.match(card.body, /couples schema lifecycles/, "rejected option's reason surfaced");
});

test('P2 AC3+AC4: toCard(anti_pattern) — title; body = trigger + wrong/right (do/don\'t) + guidance; detail carries severity', () => {
  assert.strictEqual(typeof vm.toCard, 'function', 'viewmodel.toCard must exist (AC3)');
  const card = vm.toCard!(antiPatternRec());
  assert.equal(card.type, 'anti_pattern');
  assert.equal(card.title, 'Bypassing the store write path', 'title from the anti_pattern title field');
  assert.ok(card.body.includes('\n\n'), 'anti_pattern body is multi-section (AC4)');
  assert.match(card.body, /editing \.sterling\/ with a shell script/, 'trigger present');
  assert.match(card.body, /sqlite3 \.sterling/, 'wrong_way present');
  assert.match(card.body, /call knowledge_create through the server/, 'right_way present');
  assert.match(card.body, /route every write through the MCP tool surface/, 'guidance present');
  // severity is structured metadata — on the detail line, not buried in prose
  assert.match(card.detail, /block/, 'detail carries the severity');
});

test('P2 AC3+AC4: toCard(research_finding) — title from question; body = question + A:/answer; detail carries dates', () => {
  assert.strictEqual(typeof vm.toCard, 'function', 'viewmodel.toCard must exist (AC3)');
  const card = vm.toCard!(researchRec());
  assert.equal(card.type, 'research_finding');
  assert.match(card.title, /Can SQLite WAL open over a \/\/wsl\.localhost 9p mount\?/, 'title from the question (the type has no title field)');
  assert.ok(card.title.length > 0, 'research_finding still gets a non-empty title');
  assert.ok(card.body.includes('\n\n'), 'research_finding body is multi-section (AC4)');
  assert.match(card.body, /A:|Answer:/i, 'a labeled answer section');
  assert.match(card.body, /database is locked/, 'answer content present');
  // the two clocks are metadata — surfaced on detail
  assert.match(card.detail, /2026-06-20/, 'detail carries a capture/source date');
});

test('P2 AC3+AC4: toCard(reference_material) — title; body = summary + location; detail carries kind', () => {
  assert.strictEqual(typeof vm.toCard, 'function', 'viewmodel.toCard must exist (AC3)');
  const card = vm.toCard!(referenceRec());
  assert.equal(card.type, 'reference_material');
  assert.equal(card.title, 'terminal-kit ScreenBuffer reference', 'title from the reference title field');
  assert.match(card.body, /delta draw \+ 256-palette attrs/, 'summary present in the body');
  assert.match(card.body, /https:\/\/example\.test\/terminal-kit/, 'location surfaced (where to find the material)');
  // kind is structured metadata
  assert.match(card.detail, /url/, 'detail carries the kind');
});

test('P2 AC4: toCard bodies are never a single unbroken line for ANY multi-field type', () => {
  assert.strictEqual(typeof vm.toCard, 'function', 'viewmodel.toCard must exist (AC4)');
  // Every multi-field knowledge type must produce a blank-line-separated body —
  // the literal defect the brief calls out ('shown as one continuous line').
  for (const rec of [featureArticleRec(), decisionRec(), antiPatternRec(), researchRec(), referenceRec()]) {
    const card = vm.toCard!(rec);
    assert.ok(card.body.length > 0, `${(rec as { type: string }).type}: body is non-empty`);
    assert.ok(
      card.body.split('\n').length > 1,
      `${(rec as { type: string }).type}: body spans multiple lines, never one blob (AC4)`
    );
  }
});

test('P2 AC3: knowledgeCountBySource — per-source COUNT(*), project FIRST then domains; EMPTY sources dropped; counts exact (no body fetch)', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    assert.strictEqual(typeof vm.knowledgeCountBySource, 'function', 'viewmodel.knowledgeCountBySource must exist (AC3)');

    // project: one decision; domain 'node': one decision. Both are 'decision' type.
    stores.create(decisionRec({ title: 'project decision' }));
    stores.create(decisionRec({ ...kenv('decision', 'domain:node'), title: 'domain decision' }));

    const counts = vm.knowledgeCountBySource!(stores, 'decision');
    // both sources non-empty → project first, then the domain (manifest order)
    assert.deepEqual(counts.map((g) => g.source), ['project', 'node'], 'project source first, then mounted domain');
    assert.equal(counts.find((g) => g.source === 'project')!.count, 1, 'exactly one decision in the project store');
    assert.equal(counts.find((g) => g.source === 'node')!.count, 1, 'exactly one decision in the node domain store');

    // EMPTY sources dropped: a type that exists ONLY in the project store
    stores.create(referenceRec({ title: 'project-only ref' }));
    const refCounts = vm.knowledgeCountBySource!(stores, 'reference_material');
    assert.deepEqual(refCounts.map((g) => g.source), ['project'], 'the empty domain source is dropped (AC3 — empty sources hidden)');
    assert.equal(refCounts[0].count, 1);
    // (record source-tagging + cross-store isolation are proven by the P4 tree
    // tests, which now fetch records per expanded source via querySource.)
  } finally {
    cleanup();
  }
});

test('P2 AC3: knowledgeCountBySource over a type with NO records anywhere → [] (every source dropped)', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    assert.strictEqual(typeof vm.knowledgeCountBySource, 'function', 'viewmodel.knowledgeCountBySource must exist (AC3)');
    // nothing of this type created anywhere → both sources empty → both dropped
    const counts = vm.knowledgeCountBySource!(stores, 'anti_pattern');
    assert.deepEqual(counts, [], 'no records of the type anywhere → no source entries (all empty dropped)');
  } finally {
    cleanup();
  }
});

test('P2 AC5: knowledgeSearch — flat, source-tagged cards spanning ALL categories; ranked', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    assert.strictEqual(typeof vm.knowledgeSearch, 'function', 'viewmodel.knowledgeSearch must exist (AC5)');

    // one record per category, all sharing the term 'sterling', across both stores
    const fa = stores.create(featureArticleRec({ what_it_does: 'sterling knowledge explorer projection' })) as { id: string };
    const dec = stores.create(decisionRec({ statement: 'sterling composes mounted stores' })) as { id: string };
    const ap = stores.create(antiPatternRec({ guidance: 'sterling writes go through the tool surface' })) as { id: string };
    const rf = stores.create(researchRec({ answer: 'sterling uses a stale snapshot bridge' })) as { id: string };
    const rm = stores.create(referenceRec({ summary: 'sterling terminal-kit notes' })) as { id: string };
    const domFa = stores.create(featureArticleRec({ ...kenv('feature_article', 'domain:node'), slug: 'node-fa', what_it_does: 'sterling node domain article' })) as { id: string };

    const cards = vm.knowledgeSearch!(stores, ['sterling*']);
    assert.ok(Array.isArray(cards), 'knowledgeSearch returns a flat array of cards');
    const ids = new Set(cards.map((c) => c.id));
    // spans ALL FIVE categories (a search is not article-only)
    for (const [label, id] of [['feature_article', fa.id], ['decision', dec.id], ['anti_pattern', ap.id], ['research_finding', rf.id], ['reference_material', rm.id]] as const) {
      assert.ok(ids.has(id), `search spans the ${label} category`);
    }
    // every returned card is SOURCE-TAGGED (project or a domain name)
    for (const c of cards) assert.ok(c.source === 'project' || c.source === 'node', `card ${c.id} is source-tagged (got '${c.source}')`);
    // a domain record surfaces too, tagged to its store
    assert.equal(cards.find((c) => c.id === domFa.id)?.source, 'node', 'domain match tagged source=node');
    // flat list — no nesting; each card appears once
    assert.equal(cards.length, new Set(cards.map((c) => c.id)).size, 'flat de-duplicated list');
  } finally {
    cleanup();
  }
});

test('P2 AC5: knowledgeSearch uses AND (match_all) — a multi-term query returns only records matching EVERY term', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    assert.strictEqual(typeof vm.knowledgeSearch, 'function', 'viewmodel.knowledgeSearch must exist (AC5)');

    // 'both' has alpha AND beta; 'onlyAlpha' has alpha but not beta; 'onlyBeta' the reverse
    const both = stores.create(decisionRec({ statement: 'alpha beta together', rationale: 'r' })) as { id: string };
    const onlyAlpha = stores.create(decisionRec({ statement: 'alpha alone', rationale: 'r' })) as { id: string };
    const onlyBeta = stores.create(decisionRec({ statement: 'beta alone', rationale: 'r' })) as { id: string };

    const cards = vm.knowledgeSearch!(stores, ['alpha', 'beta']);
    const ids = new Set(cards.map((c) => c.id));
    assert.ok(ids.has(both.id), 'AND: the record with BOTH terms matches');
    assert.ok(!ids.has(onlyAlpha.id), 'AND: a record with only the first term is excluded');
    assert.ok(!ids.has(onlyBeta.id), 'AND: a record with only the second term is excluded');
  } finally {
    cleanup();
  }
});

test('P2 regression: project-local readers (todoCards/noteCards) stay project-only — never fanned across domains', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    // a user todo + a note in the PROJECT store
    stores.create({ ...kenv('todo'), text: 'project todo', source: 'user', priority: 'high' });
    stores.create({ ...kenv('note'), raw_text: 'project note\nbody', captured_at: NOW, capture_source: 'tui', derived: [] });
    // a user todo + a note physically in the DOMAIN store — must NOT surface in the board/notes tabs
    stores.create({ ...kenv('todo', 'domain:node'), text: 'domain todo', source: 'user' });
    stores.create({ ...kenv('note', 'domain:node'), raw_text: 'domain note', captured_at: NOW, capture_source: 'tui', derived: [] });

    // the project-local readers take the PROJECT store, not the MountedStores fan-out
    const todoTitles = todoCards(stores.project).map((c) => c.title);
    assert.deepEqual(todoTitles, ['project todo'], 'board reads the project store only — no domain todos');
    const noteTitles = noteCards(stores.project).map((c) => c.title);
    assert.deepEqual(noteTitles, ['project note'], 'notes read the project store only — no domain notes');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// FROZEN P3 oracle (run r-dd88) — SPEC-ONLY, written before the state-layer
// Knowledge explorer exists. These pin the brief's phase-P3 contract at the
// ENTRY POINTS (buildDashboardState / reduce / screenLineToRow) against ACs:
//   AC1  3-level collapse/expand tree (category → source → record), collapsed
//        by default; empty categories/sources hidden.
//   AC4  an expanded record renders READABLE: a 'title' line, a blank
//        separator, wrapped 'body' lines (≤ pane width), a dim 'meta' line —
//        the title is NEVER replaced by the body (the literal defect fixed).
//   AC5  an always-visible search field: typing → flat, source-tagged,
//        AND-filtered list; empty query → full tree; Esc clears.
//   AC9  on the Knowledge tab printable keys (digits, 'q') feed the SEARCH
//        FIELD; QUIT still quits; arrows navigate; other tabs keep hotkeys.
//
// PHASE-BOUNDARY constraint (brief): P3 is the STATE-LAYER phase ONLY. The
// MountedStores cross-store threading is P4. buildDashboardState / reduce keep
// taking the PROJECT SterlingStore — the signature does NOT change — so the
// Knowledge tree is sourced from the project store ALONE and the SOURCE level
// shows exactly ONE source named 'project'. These tests therefore use the bare
// fixture() store, NEVER MountedStores, and never expect domain/multi-source
// nodes.
//
// CLEAN-RED discipline (mirrors the P2 oracle's `vm` pattern above):
//   • KNOWLEDGE_TAB does not exist yet — it is reached through a NARROW cast on
//     the state module namespace (`S`) so the file COMPILES under tsc strict;
//     each test that needs it existence-asserts it FIRST (clean AssertionError,
//     never a TypeError throw).
//   • the behavioral assertions drive the ALREADY-EXPORTED entry points
//     (buildDashboardState / reduce / screenLineToRow) with the literal tab
//     index 2, so they never pass `undefined` as a tab. Today those entry
//     points return the OLD folder-tree / '/'-search shape, so the new-shape
//     assertions fail RED on an AssertionError.
// ===========================================================================

/** State-module surface the P3 oracle reaches for symbols not yet exported.
 *  Every member optional so the cast is valid before the coder adds them; each
 *  test existence-asserts the member it uses FIRST. */
interface KnowledgeStateMod {
  KNOWLEDGE_TAB?: number;
}
const S = stateMod as unknown as KnowledgeStateMod;

/** The Knowledge tab index is unchanged from ARTICLES_TAB (2) — used to drive
 *  buildDashboardState / reduce without depending on the not-yet-renamed const
 *  (so we never pass `undefined` as a tab → no throw). */
const KNOW_TAB = 2;

/** Seed one record of every knowledge category into a bare project store, plus
 *  a couple of extra decisions so a source/category holds multiple cards. */
function seedKnowledge(store: SterlingStore) {
  const dec = store.create(decisionRec()) as { id: string };
  const dec2 = store.create(decisionRec({ title: 'Compose over inheritance', statement: 'prefer composition' })) as { id: string };
  const ap = store.create(antiPatternRec()) as { id: string };
  const rf = store.create(researchRec()) as { id: string };
  const rm = store.create(referenceRec()) as { id: string };
  const fa = store.create(featureArticleRec()) as { id: string };
  return { dec, dec2, ap, rf, rm, fa };
}

test('P3 AC9-prereq: the Articles tab is renamed Knowledge — KNOWLEDGE_TAB === 2 and TABS[2] === "Knowledge"', () => {
  assert.strictEqual(typeof S.KNOWLEDGE_TAB, 'number', 'state.KNOWLEDGE_TAB must be an exported number (replaces ARTICLES_TAB)');
  assert.equal(S.KNOWLEDGE_TAB, 2, 'the knowledge tab keeps index 2');
  assert.equal(TABS[2], 'Knowledge', 'TABS[2] is the renamed "Knowledge" label');
});

test('P3 AC1: collapsed by default — the Knowledge tab shows ONLY non-empty category rows, in KNOWLEDGE_CATEGORIES order; empty categories absent', () => {
  const { store, cleanup } = fixture();
  try {
    // seed only THREE of the five categories so the empty ones must be hidden
    const dec = store.create(decisionRec()) as { id: string };
    const ap = store.create(antiPatternRec()) as { id: string };
    const fa = store.create(featureArticleRec()) as { id: string };
    void dec; void ap; void fa;

    const s = buildDashboardState(store, st({ tab: KNOW_TAB }));
    // every visible row is a collapsed CATEGORY node (id 'cat:<type>'), one line each
    assert.ok(s.rows.length > 0, 'the Knowledge tab renders category rows for the seeded categories');
    assert.ok(s.rows.every((r) => r.id.startsWith('cat:')), 'collapsed default: only category rows are visible (no source/card rows)');
    assert.ok(s.rows.every((r) => r.lines.length === 1), 'a collapsed category is a single line');
    // exactly the THREE non-empty categories, in registry order; the two empty ones absent
    assert.deepEqual(
      s.rows.map((r) => r.id),
      ['cat:feature_article', 'cat:decision', 'cat:anti_pattern'],
      'non-empty categories only, in KNOWLEDGE_CATEGORIES order; empty research/reference hidden'
    );
  } finally {
    cleanup();
  }
});

test('P3 AC1: drill-down — expanding a category reveals one src:<type>:project source row; expanding that reveals the card rows; same affordance per level', () => {
  const { store, cleanup } = fixture();
  try {
    const { dec, dec2 } = seedKnowledge(store);

    // expand the decision CATEGORY → its single project source row appears, with a count
    let s = buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:decision'] }));
    const catRow = s.rows.find((r) => r.id === 'cat:decision')!;
    assert.ok(catRow, 'the decision category row is present');
    const srcRow = s.rows.find((r) => r.id === 'src:decision:project');
    assert.ok(srcRow, 'expanding a category reveals exactly one source row, named project (P3: project store only)');
    // P3 phase-boundary: there is NO domain source — only the single 'project' source
    assert.deepEqual(
      s.rows.filter((r) => r.id.startsWith('src:decision:')).map((r) => r.id),
      ['src:decision:project'],
      'a single project source under the category (no MountedStores fan-out in P3)'
    );
    assert.match(srcRow!.lines[0].text, /2/, 'the source row carries its record count (two decisions seeded)');
    // the decision CARD rows are NOT yet visible — the source is still collapsed
    assert.ok(!s.rows.some((r) => r.id === dec.id), 'card rows stay hidden until the source is expanded');

    // expand the source too → the decision card rows appear, under the source
    s = buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project'] }));
    const cardIds = s.rows.filter((r) => r.type === 'feature_article' || r.id === dec.id || r.id === dec2.id).map((r) => r.id);
    assert.ok(s.rows.some((r) => r.id === dec.id), 'first decision card visible under the expanded source');
    assert.ok(s.rows.some((r) => r.id === dec2.id), 'second decision card visible under the expanded source');
    void cardIds;
  } finally {
    cleanup();
  }
});

test('P3 AC1: activate() is navigation on category/source (NO select effect) and select+expand on a card (a select effect)', () => {
  const { store, cleanup } = fixture();
  try {
    const { dec } = seedKnowledge(store);

    // cursor on the first (category) row → ENTER toggles expansion, emits NO select effect
    const onCat = reduce(store, st({ tab: KNOW_TAB, cursor: 0 }), { kind: 'key', name: 'ENTER' });
    assert.deepEqual(onCat.effects, [], 'activating a category is navigation — no select effect');
    assert.notDeepEqual(onCat.ui.expanded, st().expanded, 'activating a category toggled its expansion');

    // with the decision category + source expanded, put the cursor on a decision CARD row and ENTER
    const expandedUi = st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project'] });
    const sExpanded = buildDashboardState(store, expandedUi);
    const cardIdx = sExpanded.rows.findIndex((r) => r.id === dec.id);
    assert.ok(cardIdx >= 0, 'the decision card row is reachable when its category + source are expanded');

    // activating a SOURCE row emits no select effect either
    const srcIdx = sExpanded.rows.findIndex((r) => r.id === 'src:decision:project');
    const onSrc = reduce(store, { ...expandedUi, cursor: srcIdx }, { kind: 'key', name: 'ENTER' });
    assert.deepEqual(onSrc.effects, [], 'activating a source is navigation — no select effect');

    // activating the CARD selects + expands it, exactly like today's cards
    const onCard = reduce(store, { ...expandedUi, cursor: cardIdx }, { kind: 'key', name: 'ENTER' });
    assert.deepEqual(onCard.effects, [{ type: 'select', recordType: 'decision', id: dec.id }], 'activating a card selects it (select effect with its type+id)');
    assert.ok(onCard.ui.expanded.includes(dec.id), 'activating a card also expands it');
  } finally {
    cleanup();
  }
});

test('P3 AC4: an expanded card renders READABLE — title line first, blank separator, wrapped body lines (≤ width), dim meta last; title NEVER replaced by body', () => {
  const { store, cleanup } = fixture();
  try {
    const { dec } = seedKnowledge(store);
    const width = 32;
    const expandedUi = st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project', dec.id] });
    const s = buildDashboardState(store, expandedUi, width);

    const card = s.rows.find((r) => r.id === dec.id)!;
    assert.ok(card, 'the expanded decision card row is present');
    assert.ok(card.lines.length >= 3, 'an expanded card has title + body + meta lines');

    // first line is the TITLE, kind 'title', carrying the record's title verbatim —
    // this is the literal defect: today the first line is the wrapped BODY mis-styled.
    assert.equal(card.lines[0].kind, 'title', 'the FIRST line is the title (never the body)');
    assert.match(card.lines[0].text, /Compose over ATTACH/, 'the title text is the record title, proving the title is not replaced by body text');
    assert.ok(!/MountedStores composes/.test(card.lines[0].text), 'the first line is NOT the decision statement (body must not occupy the title line)');

    // a BLANK separator line exists between title and body
    assert.ok(card.lines.some((l) => l.text.trim() === ''), 'a blank separator line is present');

    // the last line is the dim META line
    assert.equal(card.lines.at(-1)!.kind, 'meta', 'the LAST line is the dim meta line');

    // the body is rendered as 'body' lines, EACH wrapped to ≤ the pane width
    // (never one unbroken line). The seeded decision body is long enough to wrap.
    const bodyLines = card.lines.filter((l) => l.kind === 'body');
    assert.ok(bodyLines.length >= 1, 'the body is present as body-kind lines');
    for (const l of card.lines) assert.ok(l.text.length <= width, `every line fits the pane width: "${l.text}"`);
    assert.ok(bodyLines.some((l) => /MountedStores composes/.test(l.text) || /composition/.test(l.text) || /tested in isolation/.test(l.text)), 'the body content surfaces in body lines');
  } finally {
    cleanup();
  }
});

test('P3 AC4: screenRow accounting stays exact across the 3 depths + a multi-line expansion (deep body click maps to its card)', () => {
  const { store, cleanup } = fixture();
  try {
    const { dec } = seedKnowledge(store);
    const width = 32;
    const expandedUi = st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project', dec.id] });
    const s = buildDashboardState(store, expandedUi, width);

    // screenRows are contiguous: each row begins exactly where the previous ended
    let expected = 0;
    for (const r of s.rows) {
      assert.equal(r.screenRow, expected, `row ${r.id} starts at the running offset`);
      expected += r.lines.length;
    }

    // a click on a DEEP line of the expanded card body maps back to that card row
    const cardIdx = s.rows.findIndex((r) => r.id === dec.id);
    assert.ok(cardIdx >= 0, 'the expanded card is in the row list');
    const card = s.rows[cardIdx];
    assert.ok(card.lines.length >= 3, 'the card is multi-line');
    // bodyTop=3 (no banner) → terminal lines are 1-based at 4 + screenRow + lineOffset.
    // hit a middle (body) line of the card, not its first/last:
    const midOffset = Math.min(2, card.lines.length - 1);
    const termLine = 4 + card.screenRow + midOffset;
    assert.equal(screenLineToRow(s, termLine), cardIdx, 'a click on a deep expanded-body line maps to the card row');
  } finally {
    cleanup();
  }
});

test('P3 AC5: typing on the Knowledge tab (no "/") builds searchQuery; the tree is REPLACED by a flat source-tagged card list; searchLine reflects the live query', () => {
  const { store, cleanup } = fixture();
  try {
    seedKnowledge(store);
    let ui = st({ tab: KNOW_TAB });

    // an always-visible field: a printable char feeds the query directly — no '/' first
    for (const ch of ['c', 'o', 'm', 'p', 'o', 's', 'e']) ({ ui } = reduce(store, ui, { kind: 'char', ch }));
    assert.equal(ui.searchQuery, 'compose', 'printable chars build the query on the Knowledge tab (always-visible field, no "/" toggle)');
    assert.equal(ui.tab, KNOW_TAB, 'typing never switches tabs on the Knowledge tab');

    const s = buildDashboardState(store, ui);
    // the tree is REPLACED by a flat card list — no category/source nodes remain
    assert.ok(!s.rows.some((r) => r.id.startsWith('cat:')), 'a non-empty query replaces the category tree (no category rows)');
    assert.ok(!s.rows.some((r) => r.id.startsWith('src:')), 'no source rows in the flat search result');
    assert.ok(s.rows.length > 0, 'the flat result lists the matching cards');
    // the live query is reflected on searchLine (always-visible field)
    assert.ok(typeof s.searchLine === 'string' && /compose/.test(s.searchLine!), 'searchLine reflects the live query');
  } finally {
    cleanup();
  }
});

test('P3 AC5: a TWO-term query is AND — only records matching BOTH terms survive; single-term matches are excluded', () => {
  const { store, cleanup } = fixture();
  try {
    // 'both' has alpha AND beta; the others have only one of the terms
    const both = store.create(decisionRec({ statement: 'alpha beta together', rationale: 'r' })) as { id: string };
    const onlyAlpha = store.create(decisionRec({ title: 'A', statement: 'alpha alone', rationale: 'r' })) as { id: string };
    const onlyBeta = store.create(decisionRec({ title: 'B', statement: 'beta alone', rationale: 'r' })) as { id: string };

    let ui = st({ tab: KNOW_TAB });
    // type 'alpha beta' (the space is a printable char that separates terms)
    for (const ch of 'alpha beta'.split('')) ({ ui } = reduce(store, ui, { kind: 'char', ch }));
    assert.equal(ui.searchQuery, 'alpha beta', 'the two-term query is built char by char, space included');

    const s = buildDashboardState(store, ui);
    const ids = new Set(s.rows.map((r) => r.id));
    assert.ok(ids.has(both.id), 'AND: the record with BOTH terms is in the flat result');
    assert.ok(!ids.has(onlyAlpha.id), 'AND: a single-term (alpha only) record is excluded');
    assert.ok(!ids.has(onlyBeta.id), 'AND: a single-term (beta only) record is excluded');
  } finally {
    cleanup();
  }
});

test('P3 AC5: an empty query restores the full category tree; Esc clears the query and resets the cursor to 0', () => {
  const { store, cleanup } = fixture();
  try {
    seedKnowledge(store);
    let ui = st({ tab: KNOW_TAB });
    for (const ch of ['c', 'o', 'm', 'p', 'o', 's', 'e']) ({ ui } = reduce(store, ui, { kind: 'char', ch }));

    // backspacing to empty restores the tree (empty field → full tree)
    let cleared = ui;
    for (let i = 0; i < 'compose'.length; i++) ({ ui: cleared } = reduce(store, cleared, { kind: 'key', name: 'BACKSPACE' }));
    assert.equal(cleared.searchQuery, '', 'backspacing empties the query');
    const treeBack = buildDashboardState(store, cleared);
    assert.ok(treeBack.rows.some((r) => r.id.startsWith('cat:')), 'an empty query restores the category tree');

    // Esc clears the query AND resets the cursor to 0
    const moved = { ...ui, cursor: 3 };
    const esc = reduce(store, moved, { kind: 'key', name: 'ESCAPE' });
    assert.equal(esc.ui.searchQuery, '', 'Esc clears the query');
    assert.equal(esc.ui.cursor, 0, 'Esc resets the cursor to 0');
    const afterEsc = buildDashboardState(store, esc.ui);
    assert.ok(afterEsc.rows.some((r) => r.id.startsWith('cat:')), 'the category tree is back after Esc');
  } finally {
    cleanup();
  }
});

test('P3 AC9: on the Knowledge tab printable keys feed the SEARCH FIELD — "q" and digits do NOT quit or switch tabs', () => {
  const { store, cleanup } = fixture();
  try {
    seedKnowledge(store);
    let ui = st({ tab: KNOW_TAB });

    // 'q' is part of the query, not a quit
    const qPress = reduce(store, ui, { kind: 'char', ch: 'q' });
    assert.deepEqual(qPress.effects, [], "'q' does not quit on the Knowledge tab (it feeds the search field)");
    assert.equal(qPress.ui.searchQuery, 'q', "'q' is appended to the query");
    ui = qPress.ui;

    // digits append too — no tab switch
    const onePress = reduce(store, ui, { kind: 'char', ch: '1' });
    assert.deepEqual(onePress.effects, [], 'a digit does not switch tabs on the Knowledge tab');
    assert.equal(onePress.ui.tab, KNOW_TAB, 'still on the Knowledge tab');
    assert.equal(onePress.ui.searchQuery, 'q1', 'the digit is appended to the query');

    // the QUIT key event still quits (Ctrl-C → name 'QUIT')
    const quit = reduce(store, ui, { kind: 'key', name: 'QUIT' });
    assert.deepEqual(quit.effects, [{ type: 'quit' }], 'the QUIT key still quits on the Knowledge tab');
  } finally {
    cleanup();
  }
});

test('P3 AC9: arrows navigate the Knowledge tree (cursor moves, no quit); other tabs keep their digit/q hotkeys (regression guard)', () => {
  const { store, cleanup } = fixture();
  try {
    seedKnowledge(store);

    // UP/DOWN move the cursor over the Knowledge rows
    const down = reduce(store, st({ tab: KNOW_TAB, cursor: 0 }), { kind: 'key', name: 'DOWN' });
    assert.equal(down.ui.cursor, 1, 'DOWN advances the cursor on the Knowledge tab');
    const up = reduce(store, down.ui, { kind: 'key', name: 'UP' });
    assert.equal(up.ui.cursor, 0, 'UP retreats the cursor on the Knowledge tab');

    // cross-check: on a NON-Knowledge tab, 'q' still quits and a digit still switches tabs
    const onTodos = st({ tab: 0 });
    const qQuit = reduce(store, onTodos, { kind: 'char', ch: 'q' });
    assert.deepEqual(qQuit.effects, [{ type: 'quit' }], "'q' keeps quitting on the Todos tab (hotkeys preserved off the Knowledge tab)");
    const digit = reduce(store, onTodos, { kind: 'char', ch: '2' });
    assert.equal(digit.ui.tab, 1, "a digit still switches tabs off the Knowledge tab (TABS index '2' → tab 1)");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// FROZEN P4 oracle (run r-dd88) — SPEC-ONLY, written before the multi-store
// Knowledge tab + the render bold exist. These pin phase-P4's contract:
//   AC1  the Knowledge tree's SOURCE level shows the PROJECT source FIRST, then
//        each mounted domain as its own source node; a category's count sums
//        records across ALL its sources; empty sources hidden.
//   AC2  a record physically in a mounted DOMAIN store appears under that
//        domain's source node; project records under 'project', project-first.
//   AC4  an EXPANDED knowledge record's TITLE line is drawn BOLD (the renderer
//        merges { bold: row.expanded } into the title attr); category/source
//        toggle rows render through the title kind; a NON-expanded title is not
//        bold. (The readable title/blank/body/meta STRUCTURE already passes from
//        P3 — P4 adds only the bold.)
//   AC7  a skip-missing MountedStores over a domain whose db does NOT exist
//        skips the missing store (never creates it), shows the REMAINING
//        sources, and never crashes.
//
// THE NEW INTERFACE (ADDITIVE): P4 adds a trailing OPTIONAL `knowledge?:
// MountedStores` to buildDashboardState / reduce / nodesFor — the signature is
// NOT otherwise changed. When `knowledge` is provided, the Knowledge tab (tab
// 2) sources its tree from it (knowledgeBySource → source level, project first
// then each mounted domain in manifest order, empty sources dropped;
// knowledgeSearch → the flat AND results). The first param `store` stays the
// project SterlingStore for the project-local tabs. When `knowledge` is ABSENT
// (every EXISTING test above), the Knowledge tab is PROJECT-ONLY — unchanged.
//
// CLEAN-RED discipline (mirrors the P2/P3 `vm`/`S` casts):
//   • the committed signatures do NOT have `knowledge`, so calling with it
//     would be a tsc ARITY error → a build CRASH = refused. The new-arity entry
//     points are reached through a NARROW cast on the state module namespace
//     (`S4`) so the file COMPILES under tsc strict before the param is added.
//   • the FIRST positional arg is ALWAYS a REAL SterlingStore (stores.project),
//     and `knowledge` is the MountedStores — so today's committed code (which
//     ignores the extra arg) runs the PROJECT-ONLY path WITHOUT throwing
//     (`.query` exists on the project store). At RED the domain record lives
//     ONLY in the domain store, so the project-only path shows no domain source
//     → the AC1/AC2 multi-source assertions fail RED on AssertionError. CLEAN.
//   • the render test passes a FAKE ScreenLike that never throws; at the
//     committed render the title attr has no `bold`, so the bold assertion
//     fails RED on AssertionError, never a throw.
// ===========================================================================

/** The new-arity state surface (brief: trailing optional `knowledge?:
 *  MountedStores`). Cast lets tsc accept the extra arg before the coder adds
 *  it; the FIRST arg is always a real SterlingStore so today's code never
 *  throws on the ignored extra arg. */
interface KnowledgeArityStateMod {
  buildDashboardState: (
    store: SterlingStore,
    ui: UiState,
    width?: number,
    maxBodyLines?: number,
    projectName?: string,
    showBanner?: boolean,
    knowledge?: MountedStores
  ) => DashboardState;
  reduce: (
    store: SterlingStore,
    ui: UiState,
    event: unknown,
    viewport?: unknown,
    knowledge?: MountedStores
  ) => { ui: UiState; effects: { type: string }[] };
}
const S4 = stateMod as unknown as KnowledgeArityStateMod;

/** A fake ScreenLike (brief render contract) that records every put() so the
 *  render test can inspect the title-line attr. It NEVER throws — fill/draw are
 *  no-ops — so a RED render test fails on an assertion, not a crash. */
interface PutCapture {
  x?: number;
  y?: number;
  attr?: { bold?: boolean; inverse?: boolean; dim?: boolean } | Record<string, unknown>;
  str: string;
  [k: string]: unknown;
}
function fakeScreen(width = 80, height = 40) {
  const captured: PutCapture[] = [];
  const screen = {
    width,
    height,
    fill() {},
    put(opts: Record<string, unknown>, str: string) {
      captured.push({ ...(opts as object), str } as PutCapture);
    },
    draw() {},
  };
  return { screen, captured };
}

/** A skip-missing MountedStores over a domain whose db does NOT exist on disk.
 *  The 3rd ctor arg `{ skipMissing: true }` is the already-shipped P1 surface. */
function skipMissingFixture(domainName = 'absent') {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-p4-skip-'));
  const missingDb = join(dir, 'domains', domainName, 'sterling.db');
  const projectDb = join(dir, '.sterling', 'sterling.db');
  const stores = new MountedStores(projectDb, [{ name: domainName, dbPath: missingDb }], { skipMissing: true });
  return { dir, stores, missingDb, cleanup: () => { stores.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('P4 AC1/AC2: with the `knowledge` arg, the SOURCE level shows project FIRST then each domain; a domain record sits under its domain source; the category count sums across sources', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    assert.strictEqual(typeof vm.knowledgeCountBySource, 'function', 'the knowledgeCountBySource viewmodel must exist (the tree badges read counts from it)');

    // one decision PHYSICALLY in the project store, one PHYSICALLY in the 'node' domain store
    const projDec = stores.create(decisionRec({ title: 'project decision' })) as { id: string };
    const domDec = stores.create(decisionRec({ ...kenv('decision', 'domain:node'), title: 'domain decision' })) as { id: string };

    // expand the decision CATEGORY (the knowledge arg makes the tab multi-store)
    let s = S4.buildDashboardState(
      stores.project,
      st({ tab: KNOW_TAB, expanded: ['cat:decision'] }),
      undefined,
      undefined,
      '',
      false,
      stores
    );

    // AC1: project source FIRST, then the 'node' domain — exactly two source rows
    const srcIds = s.rows.filter((r) => r.id.startsWith('src:decision:')).map((r) => r.id);
    assert.deepEqual(
      srcIds,
      ['src:decision:project', 'src:decision:node'],
      'two sources: project FIRST, then the mounted node domain (manifest order)'
    );

    // AC1: the CATEGORY count sums BOTH sources (one project + one domain = 2)
    const catRow = s.rows.find((r) => r.id === 'cat:decision')!;
    assert.ok(catRow, 'the decision category row is present');
    assert.match(catRow.lines[0].text, /2/, "the category count sums records across ALL its sources (1 project + 1 domain)");

    // AC2: expand BOTH sources → the project decision sits under project, the
    // domain decision under node; neither leaks into the other source
    s = S4.buildDashboardState(
      stores.project,
      st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project', 'src:decision:node'] }),
      undefined,
      undefined,
      '',
      false,
      stores
    );
    const rowIds = s.rows.map((r) => r.id);
    const projSrcIdx = rowIds.indexOf('src:decision:project');
    const nodeSrcIdx = rowIds.indexOf('src:decision:node');
    const projCardIdx = rowIds.indexOf(projDec.id);
    const domCardIdx = rowIds.indexOf(domDec.id);
    assert.ok(projSrcIdx >= 0 && nodeSrcIdx >= 0, 'both source rows are present when expanded');
    assert.ok(projCardIdx >= 0, 'the project decision card is rendered');
    assert.ok(domCardIdx >= 0, 'the DOMAIN decision card is rendered (it lives only in the node store — proves the knowledge arg fanned out)');
    // the project card sits between the project source and the node source;
    // the domain card sits after the node source — each under its own source node
    assert.ok(projCardIdx > projSrcIdx && projCardIdx < nodeSrcIdx, 'the project decision is nested under the project source');
    assert.ok(domCardIdx > nodeSrcIdx, 'the domain decision is nested under the node source, not under project');
  } finally {
    cleanup();
  }
});

test('P4 AC2: a record physically in the node DOMAIN store NEVER appears under the project source (cross-store isolation through the knowledge arg)', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    const projDec = stores.create(decisionRec({ title: 'project decision' })) as { id: string };
    const domDec = stores.create(decisionRec({ ...kenv('decision', 'domain:node'), title: 'domain decision' })) as { id: string };

    const s = S4.buildDashboardState(
      stores.project,
      st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project'] }),
      undefined,
      undefined,
      '',
      false,
      stores
    );
    // the project source is expanded, the node source is collapsed: the project
    // card is visible, the domain card is NOT (it belongs under the node source)
    assert.ok(s.rows.some((r) => r.id === projDec.id), 'the project decision is visible under the expanded project source');
    assert.ok(!s.rows.some((r) => r.id === domDec.id), 'the domain decision never appears under the project source (it lives under the node source)');
  } finally {
    cleanup();
  }
});

test('perf: the collapsed Knowledge tree runs COUNT(*) badges and fetches NO record bodies until a source is expanded (todo e22aefc7)', () => {
  const { store, cleanup } = fixture();
  try {
    store.create(decisionRec());
    store.create(antiPatternRec());

    // spy: tally count() vs query() on the project store
    let counts = 0;
    let queries = 0;
    const realCount = store.count.bind(store);
    const realQuery = store.query.bind(store);
    store.count = (...a) => { counts++; return realCount(...a); };
    store.query = (...a) => { queries++; return realQuery(...a); };

    // ALL COLLAPSED (the default view): badges only → COUNT(*) runs, ZERO body fetches
    const collapsed = buildDashboardState(store, st({ tab: KNOW_TAB, expanded: [] }), 80);
    assert.ok(counts >= 1, 'collapsed view runs COUNT(*) for the category badges');
    assert.equal(queries, 0, 'collapsed view fetches NO record bodies — the perf fix (was: query cap:500 per category every frame)');
    assert.ok(collapsed.rows.some((r) => r.id === 'cat:decision'), 'the decision category badge still renders from the count');

    // EXPAND a category + its source → NOW exactly that source is queried for bodies
    queries = 0;
    buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project'] }), 80);
    assert.ok(queries >= 1, 'expanding a source fetches that source’s records (query)');
  } finally {
    cleanup();
  }
});

test('P4 AC7: skip-missing — the absent domain db is NEVER created; buildDashboardState with that MountedStores renders only the existing source(s) and never throws', () => {
  const { stores, missingDb, cleanup } = skipMissingFixture('absent');
  try {
    // the missing store was SKIPPED, never created (the P1 skip-missing contract)
    assert.equal(existsSync(missingDb), false, 'the absent domain db file was NOT created (skip-missing never touches it)');

    // a decision lives in the project store; the absent domain has no store at all
    const projDec = stores.create(decisionRec({ title: 'project only' })) as { id: string };

    // expanding the category must NOT throw, and must show ONLY the project source
    // (the absent domain was skipped, so there is no 'absent' source node)
    let s: DashboardState | undefined;
    assert.doesNotThrow(() => {
      s = S4.buildDashboardState(
        stores.project,
        st({ tab: KNOW_TAB, expanded: ['cat:decision'] }),
        undefined,
        undefined,
        '',
        false,
        stores
      );
    }, 'a skip-missing MountedStores with a skipped domain renders without throwing (AC7)');

    const srcIds = s!.rows.filter((r) => r.id.startsWith('src:decision:')).map((r) => r.id);
    // the knowledge-fan assertion that depends on the param: ONLY the existing
    // source surfaces, and there is NO node for the skipped domain. (At RED the
    // project-only path also shows just 'project' — but this is the AC7 oracle's
    // non-crash + remaining-source guarantee; the multi-source RED is pinned by
    // the AC1/AC2 test above, which the project-only path fails on assertion.)
    assert.deepEqual(srcIds, ['src:decision:project'], 'only the existing (project) source remains; the skipped domain has no source node');
    assert.ok(!srcIds.some((id) => id.endsWith(':absent')), 'no source node for the skipped, never-created domain');
    assert.ok(s!.rows.some((r) => r.id === 'cat:decision'), 'the decision category still renders from the surviving project source');
    void projDec;
  } finally {
    cleanup();
  }
});

test('P4 AC4 (render): an EXPANDED knowledge record draws its TITLE line BOLD; a non-expanded title is NOT bold', () => {
  const { store, cleanup } = fixture();
  try {
    const dec = store.create(decisionRec()) as { id: string };

    // EXPANDED: build a DashboardState with the decision category + source + the
    // card itself expanded, then draw to a fake screen and inspect the title put.
    const expandedUi = st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project', dec.id] });
    const sExp = buildDashboardState(store, expandedUi, 60);
    const expCard = sExp.rows.find((r) => r.id === dec.id)!;
    assert.ok(expCard, 'the expanded decision card row is present');
    assert.equal(expCard.lines[0].kind, 'title', "the card's first line is the title (P3 structure)");
    const titleText = expCard.lines[0].text;
    assert.ok(titleText.length > 0, 'the title line has text to match the captured put against');

    const { screen, captured } = fakeScreen(60, 40);
    draw(screen, sExp);
    // find the captured put for the EXPANDED card's title line (by its text)
    const titlePut = captured.find((p) => typeof p.str === 'string' && p.str.includes(titleText.trim()) && p.str.trim().length > 0);
    assert.ok(titlePut, 'the expanded title line was drawn (a put captured its text)');
    assert.equal((titlePut!.attr as { bold?: boolean }).bold, true, "an EXPANDED record's title line is drawn BOLD (attr merges { bold: row.expanded })");

    // NON-expanded: the same card collapsed → its single title line is NOT bold
    const collapsedUi = st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project'] });
    const sCol = buildDashboardState(store, collapsedUi, 60);
    const colCard = sCol.rows.find((r) => r.id === dec.id)!;
    assert.ok(colCard, 'the collapsed decision card row is present');
    const colTitleText = colCard.lines[0].text;
    const { screen: screen2, captured: captured2 } = fakeScreen(60, 40);
    draw(screen2, sCol);
    const colTitlePut = captured2.find((p) => typeof p.str === 'string' && p.str.includes(colTitleText.trim()) && p.str.trim().length > 0);
    assert.ok(colTitlePut, 'the collapsed title line was drawn');
    assert.notEqual((colTitlePut!.attr as { bold?: boolean }).bold, true, 'a NON-expanded title line is NOT bold (bold is row.expanded only)');
  } finally {
    cleanup();
  }
});

test('P4 AC2 (search): with the `knowledge` arg, a query yields a FLAT source-tagged list spanning BOTH stores (project + domain matches)', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    assert.strictEqual(typeof vm.knowledgeSearch, 'function', 'the P2 knowledgeSearch viewmodel must exist (P4 sources flat search from it)');

    // a matching decision in the project store and one in the node domain store
    const projDec = stores.create(decisionRec({ statement: 'sterling project match', rationale: 'r' })) as { id: string };
    const domDec = stores.create(decisionRec({ ...kenv('decision', 'domain:node'), statement: 'sterling domain match', rationale: 'r' })) as { id: string };

    // type 'sterling' into the always-visible field, then build with the knowledge arg
    let ui = st({ tab: KNOW_TAB });
    for (const ch of 'sterling'.split('')) {
      const r = S4.reduce(stores.project, ui, { kind: 'char', ch }, undefined, stores);
      ui = r.ui;
    }
    assert.equal(ui.searchQuery, 'sterling', 'the query is built char by char on the Knowledge tab');

    const s = S4.buildDashboardState(stores.project, ui, undefined, undefined, '', false, stores);
    const ids = new Set(s.rows.map((r) => r.id));
    // flat list: no tree nodes
    assert.ok(!s.rows.some((r) => r.id.startsWith('cat:') || r.id.startsWith('src:')), 'a query replaces the tree with a flat card list');
    // BOTH the project and the DOMAIN match surface (the fan-out spans stores)
    assert.ok(ids.has(projDec.id), 'the project decision matches and is listed');
    assert.ok(ids.has(domDec.id), 'the DOMAIN decision matches and is listed (search fans across the mounted stores via the knowledge arg)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Sub-category level (4th tree level) + the Articles→Features rename. The
// Knowledge tree groups an expanded source's records by code COMPONENT derived
// from their file keys (single-bucket dominant), collapsing the level when a
// source resolves to a single bucket.
// ---------------------------------------------------------------------------

test('rename: the feature_article category label is "Features" (not "Articles")', () => {
  assert.equal(
    viewmodel.KNOWLEDGE_CATEGORIES.find((c) => c.type === 'feature_article')!.label,
    'Features',
    'the feature_article category is labeled Features',
  );
  const { store, cleanup } = fixture();
  try {
    article(store, 'a', 'A', 'x', ['packages/tui/src/x.ts']);
    const catRow = buildDashboardState(store, st({ tab: KNOW_TAB })).rows.find((r) => r.id === 'cat:feature_article')!;
    assert.match(catRow.lines[0].text, /Features/, 'the category row renders "Features"');
    assert.ok(!/Articles/.test(catRow.lines[0].text), 'the old "Articles" label is gone');
  } finally {
    cleanup();
  }
});

test('sub-categories (viewmodel): subgroupKey / subcatLabel / subcategoryOf / knowledgeSubgroups — dominant component, lexicographic tie-break, prettify with raw-key fallback', () => {
  // folder key: two-deep where present, else one-deep, else (root)
  assert.equal(viewmodel.subgroupKey('packages/tui/src/state.ts'), 'packages/tui');
  assert.equal(viewmodel.subgroupKey('scripts/init.mjs'), 'scripts');
  assert.equal(viewmodel.subgroupKey('scripts/hooks/h7.mjs'), 'scripts/hooks');
  assert.equal(viewmodel.subgroupKey('CLAUDE.md'), '(root)');

  // friendly labels; an unmapped key falls back to the RAW key (never a silent "Other")
  assert.equal(viewmodel.subcatLabel('packages/tui'), 'TUI');
  assert.equal(viewmodel.subcatLabel('scripts/hooks'), 'Hooks');
  assert.equal(viewmodel.subcatLabel('skills/debug'), 'skills/debug');

  // dominant component = the key owning the MOST files (2× store beats 1× tui)
  const dominant = {
    type: 'feature_article',
    files: [
      { path: 'packages/tui/src/x.ts', role: 'impl' },
      { path: 'packages/store/src/a.ts', role: 'impl' },
      { path: 'packages/store/src/b.ts', role: 'impl' },
    ],
  };
  assert.equal(viewmodel.subcategoryOf(dominant), 'packages/store');

  // tie (1 each) → lexicographically smallest key wins (packages/store < packages/tui)
  const tie = { type: 'decision', file_keys: ['packages/tui/src/x.ts', 'packages/store/src/a.ts'] };
  assert.equal(viewmodel.subcategoryOf(tie), 'packages/store');

  // no file keys → the general bucket
  assert.equal(viewmodel.subcategoryOf({ type: 'research_finding' }), viewmodel.SUBCAT_GENERAL);

  // grouping is single-bucket, ordered (registry order), general LAST, empty dropped
  const groups = viewmodel.knowledgeSubgroups([
    { type: 'feature_article', id: '1', slug: 'a', title: 'A', state: 'active', what_it_does: '', intended_behavior: '', files: [{ path: 'packages/store/src/a.ts', role: 'impl' }], dependencies: { relies_on: [] }, version: 1 },
    { type: 'feature_article', id: '2', slug: 'b', title: 'B', state: 'active', what_it_does: '', intended_behavior: '', files: [{ path: 'packages/tui/src/b.ts', role: 'impl' }], dependencies: { relies_on: [] }, version: 1 },
    { type: 'research_finding', id: '3', question: 'q', answer: 'a', source_date: '2026-01-01', capture_date: '2026-01-01' },
  ]);
  assert.deepEqual(groups.map((g) => g.key), ['packages/tui', 'packages/store', '(general)'], 'registry order first, general last');
  assert.deepEqual(groups.map((g) => g.label), ['TUI', 'Store', '(general)'], 'friendly display labels');
  assert.deepEqual(groups.map((g) => g.cards.length), [1, 1, 1], 'one card per bucket (single-bucket)');
});

test('sub-categories: an expanded source spanning >1 component shows sub-category nodes; cards stay hidden until a sub-category expands; source badge == sum of sub-category counts', () => {
  const { store, cleanup } = fixture();
  try {
    article(store, 'tui-a', 'TUI A', 'x', ['packages/tui/src/state.ts']);
    article(store, 'tui-b', 'TUI B', 'x', ['packages/tui/src/render.ts', 'packages/tui/src/banner.ts']);
    article(store, 'store-a', 'Store A', 'x', ['packages/store/src/index.ts']);

    const s = buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:feature_article', 'src:feature_article:project'] }));

    // sub-category rows appear in registry order (TUI before Store), with friendly labels + counts
    const subRows = s.rows.filter((r) => r.type === 'subcategory');
    assert.deepEqual(
      subRows.map((r) => r.id),
      ['sub:feature_article:project:packages/tui', 'sub:feature_article:project:packages/store'],
      'one foldable sub-category per component, registry-ordered',
    );
    assert.match(subRows[0].lines[0].text, /TUI \(2\)/, 'TUI bucket holds the two tui articles');
    assert.match(subRows[1].lines[0].text, /Store \(1\)/, 'Store bucket holds the one store article');

    // cards are NOT visible until a sub-category is expanded
    assert.ok(!s.rows.some((r) => r.type === 'feature_article'), 'card rows stay hidden while sub-categories are collapsed');

    // the source badge (COUNT(*)) equals the sum of the sub-category counts (3 == 2 + 1)
    const srcRow = s.rows.find((r) => r.id === 'src:feature_article:project')!;
    assert.match(srcRow.lines[0].text, /\(3\)/, 'source badge equals the sum of its sub-category counts (AC16 invariant)');
  } finally {
    cleanup();
  }
});

test('sub-categories: expanding a sub-category reveals its cards one level deeper (depth 3); siblings stay collapsed; screenRows stay contiguous', () => {
  const { store, cleanup } = fixture();
  try {
    const tuiA = article(store, 'tui-a', 'TUI A', 'x', ['packages/tui/src/state.ts']);
    const storeA = article(store, 'store-a', 'Store A', 'x', ['packages/store/src/index.ts']);
    const expanded = ['cat:feature_article', 'src:feature_article:project', 'sub:feature_article:project:packages/tui'];
    const s = buildDashboardState(store, st({ tab: KNOW_TAB, expanded }), 80);

    const card = s.rows.find((r) => r.id === tuiA.id)!;
    assert.ok(card, 'the TUI article card is visible under its expanded sub-category');
    // depth 3 → marker(2) + pad(6) = 8 leading spaces (one level deeper than a depth-2 flat card)
    assert.ok(card.lines[0].text.startsWith('        '), 'a depth-3 card is indented under its sub-category (8 leading spaces)');
    assert.match(card.lines[0].text, /TUI A/, 'the card carries its title');

    // the Store sub-category stays collapsed → its card is not shown
    assert.ok(!s.rows.some((r) => r.id === storeA.id), 'a collapsed sibling sub-category keeps its cards hidden');

    // screenRows remain contiguous across all four depths
    let expectedRow = 0;
    for (const r of s.rows) {
      assert.equal(r.screenRow, expectedRow, `row ${r.id} starts at the running offset`);
      expectedRow += r.lines.length;
    }
  } finally {
    cleanup();
  }
});

test('sub-categories: collapse-single-bucket — a source whose records all map to ONE component lists cards flat at depth 2 (no sub-category level)', () => {
  const { store, cleanup } = fixture();
  try {
    const a = article(store, 'tui-a', 'TUI A', 'x', ['packages/tui/src/state.ts']);
    const b = article(store, 'tui-b', 'TUI B', 'x', ['packages/tui/src/render.ts']);
    const s = buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:feature_article', 'src:feature_article:project'] }), 80);

    assert.ok(!s.rows.some((r) => r.type === 'subcategory'), 'a single-bucket source inserts NO sub-category level');
    assert.ok(s.rows.some((r) => r.id === a.id) && s.rows.some((r) => r.id === b.id), 'both cards list directly under the source');
    // depth 2 → 6 leading spaces (marker 2 + pad 4), NOT the depth-3 eight
    const card = s.rows.find((r) => r.id === a.id)!;
    assert.ok(card.lines[0].text.startsWith('      ') && !card.lines[0].text.startsWith('        '), 'flat cards stay at depth 2');
  } finally {
    cleanup();
  }
});

test('sub-categories: a category whose records have no file keys (research) lists flat — no (general) wrapper level', () => {
  const { store, cleanup } = fixture();
  try {
    const rf = store.create(researchRec()) as { id: string };
    store.create(researchRec({ question: 'a second question?' }));
    const s = buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:research_finding', 'src:research_finding:project'] }));
    assert.ok(!s.rows.some((r) => r.type === 'subcategory'), 'no file keys → single (general) bucket → no sub-category level');
    assert.ok(s.rows.some((r) => r.id === rf.id), 'research cards list directly under the source');
  } finally {
    cleanup();
  }
});

test('sub-categories: activating a sub-category row toggles its fold (navigation, no select effect)', () => {
  const { store, cleanup } = fixture();
  try {
    article(store, 'tui-a', 'TUI A', 'x', ['packages/tui/src/state.ts']);
    article(store, 'store-a', 'Store A', 'x', ['packages/store/src/index.ts']);
    const expandedUi = st({ tab: KNOW_TAB, expanded: ['cat:feature_article', 'src:feature_article:project'] });
    const s = buildDashboardState(store, expandedUi);
    const subIdx = s.rows.findIndex((r) => r.type === 'subcategory');
    assert.ok(subIdx >= 0, 'a sub-category row is present');

    const res = reduce(store, { ...expandedUi, cursor: subIdx }, { kind: 'key', name: 'ENTER' });
    assert.deepEqual(res.effects, [], 'activating a sub-category is navigation — no select effect');
    assert.ok(res.ui.expanded.includes(s.rows[subIdx].id), 'activating a sub-category expands it');
  } finally {
    cleanup();
  }
});
