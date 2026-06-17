import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { todoCards, noteCards, articleCards, runView } from '../viewmodel.js';
import { buildDashboardState, initialUi, reduce, runEffects, screenLineToRow, visibleBodyLines, wrapText, RUN_TAB, ARTICLES_TAB, QUEUE_TAB, TABS, type UiState } from '../state.js';
import { keyToEvent, mouseToEvent } from '../render.js';

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

test('articleCards: groups derive from owned paths; body carries intended behavior', () => {
  const { store, cleanup } = fixture();
  try {
    article(store, 'alpha-store', 'Alpha store layer', 'persists widgets in sqlite', [
      'packages/store/src/index.ts',
      'packages/schemas/src/records.ts',
      'scripts/dispose-run.mjs',
      'STERLING-SPEC.md',
    ]);
    const [card] = articleCards(store);
    assert.deepEqual(card.groups, ['packages/store', 'packages/schemas', 'scripts', '(root)']);
    assert.match(card.body, /persists widgets in sqlite/);
    assert.match(card.body, /→ intended: works as designed/);
    assert.match(card.detail, /alpha-store · active · v1 · 4 file\(s\) · relies on 0/);
  } finally {
    cleanup();
  }
});

test('buildDashboardState: rows with screen offsets; expansion adds detail lines; empty + run tabs', () => {
  const { store, t1, cleanup } = fixture();
  try {
    let s = buildDashboardState(store, initialUi);
    assert.deepEqual(s.tabs.map((t) => t.active), [true, false, false, false, false]);
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

test('articles tab: folder tree from owned files — groups fold/unfold, articles select+expand', () => {
  const { store, cleanup } = fixture();
  try {
    const a = article(store, 'alpha-store', 'Alpha store layer', 'persists widgets in sqlite', [
      'packages/store/src/index.ts',
      'packages/schemas/src/records.ts',
    ]);
    article(store, 'beta-tui', 'Beta dashboard', 'renders the dashboard pane', ['packages/tui/src/main.ts', 'scripts/build-tui.mjs']);

    // default: collapsed folder list, sorted, with counts
    let ui = st({ tab: ARTICLES_TAB });
    let s = buildDashboardState(store, ui);
    assert.deepEqual(
      s.rows.map((r) => r.id),
      ['group:packages/schemas', 'group:packages/store', 'group:packages/tui', 'group:scripts']
    );
    assert.match(s.rows[0].lines[0].text, /▸ packages\/schemas \(1\)/);

    // enter on a folder unfolds it — no selection effect
    const open = reduce(store, ui, { kind: 'key', name: 'ENTER' });
    assert.deepEqual(open.effects, [], 'folding is navigation, not selection');
    ui = open.ui;
    s = buildDashboardState(store, ui);
    assert.deepEqual(s.rows.map((r) => r.id).slice(0, 2), ['group:packages/schemas', a.id]);
    assert.match(s.rows[0].lines[0].text, /▾/);
    assert.match(s.rows[1].lines[0].text, /^\s{4}Alpha store layer/, 'article row is indented under its folder');

    // activating the article selects + expands it (body + meta)
    ui = { ...ui, cursor: 1 };
    const sel = reduce(store, ui, { kind: 'key', name: 'ENTER' });
    assert.deepEqual(sel.effects, [{ type: 'select', recordType: 'feature_article', id: a.id }]);
    s = buildDashboardState(store, sel.ui);
    const row = s.rows.find((r) => r.id === a.id)!;
    assert.ok(row.lines.length > 1, 'expanded article shows its body');
    assert.match(row.lines.at(-1)!.text, /alpha-store · active/);

    // the same article appears under every folder it owns files in
    const both = reduce(store, st({ tab: ARTICLES_TAB, cursor: 1, expanded: ['group:packages/schemas', 'group:packages/store'] }), {
      kind: 'key',
      name: 'DOWN',
    });
    const rows = buildDashboardState(store, both.ui).rows.map((r) => r.id);
    assert.equal(rows.filter((id) => id === a.id).length, 2, 'multi-group ownership lists the card twice');
  } finally {
    cleanup();
  }
});

test('articles search: / edits, chars (digits, q) append instead of acting, FTS prefix filters, enter keeps, esc clears', () => {
  const { store, cleanup } = fixture();
  try {
    const a = article(store, 'alpha-store', 'Alpha store layer', 'persists widgets in sqlite', ['packages/store/src/index.ts']);
    article(store, 'beta-tui', 'Beta dashboard', 'renders the dashboard pane', ['packages/tui/src/main.ts']);

    let ui = st({ tab: ARTICLES_TAB });
    ({ ui } = reduce(store, ui, { kind: 'char', ch: '/' }));
    assert.equal(ui.searchEditing, true);

    for (const ch of ['w', 'i', 'd', '1', 'q']) ({ ui } = reduce(store, ui, { kind: 'char', ch }));
    assert.equal(ui.searchQuery, 'wid1q', 'digits and q are input while editing — no tab switch, no quit');
    assert.equal(ui.tab, ARTICLES_TAB);

    ({ ui } = reduce(store, ui, { kind: 'key', name: 'BACKSPACE' }));
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'BACKSPACE' }));
    assert.equal(ui.searchQuery, 'wid');

    // FTS prefix: 'wid*' matches 'widgets' — flat ranked result list, no folders
    let s = buildDashboardState(store, ui);
    assert.deepEqual(s.rows.map((r) => r.id), [a.id], 'prefix search filters to the matching article');
    assert.equal(s.searchLine, 'search: wid▌');

    // enter leaves input mode but keeps the filter; esc clears back to the tree
    ({ ui } = reduce(store, ui, { kind: 'key', name: 'ENTER' }));
    assert.equal(ui.searchEditing, false);
    assert.equal(ui.searchQuery, 'wid');
    assert.equal(buildDashboardState(store, ui).searchLine, 'search: wid');
    const quits = reduce(store, ui, { kind: 'char', ch: 'q' });
    assert.deepEqual(quits.effects, [{ type: 'quit' }], 'q quits again once not editing');

    ({ ui } = reduce(store, ui, { kind: 'key', name: 'ESCAPE' }));
    assert.equal(ui.searchQuery, '');
    s = buildDashboardState(store, ui);
    assert.equal(s.searchLine, undefined);
    assert.ok(s.rows.every((r) => r.type === 'group'), 'tree is back after esc');

    // no matches → loud empty state
    ({ ui } = reduce(store, ui, { kind: 'char', ch: '/' }));
    for (const ch of ['z', 'z', 'z']) ({ ui } = reduce(store, ui, { kind: 'char', ch }));
    assert.equal(buildDashboardState(store, ui).emptyMessage, '(no matches)');
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
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: 1 }));
    assert.equal(ui.cursor, 1);
    ({ ui } = reduce(store, ui, { kind: 'wheel', dy: -1 }));
    assert.equal(ui.cursor, 0);

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
