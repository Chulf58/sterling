import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, MountedStores } from '@sterling/store';
import { todoCards, noteCards, articleCards, runView } from '../viewmodel.js';
import * as viewmodel from '../viewmodel.js';
import { buildDashboardState, initialUi, reduce, runEffects, screenLineToRow, visibleBodyLines, wrapText, RUN_TAB, ARTICLES_TAB, QUEUE_TAB, TABS, type UiState } from '../state.js';
import { bannerLines, bannerPaletteIndex, ART_WIDTH, WORDMARK, BANNER_ROWS } from '../banner.js';
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
  knowledgeBySource?: (store: MountedStores, type: string) => { source: string; cards: CardLike[] }[];
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

test('P2 AC3: knowledgeBySource — project FIRST then domains; toCard-mapped cards; cards carry source; EMPTY sources dropped', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    assert.strictEqual(typeof vm.knowledgeBySource, 'function', 'viewmodel.knowledgeBySource must exist (AC3)');

    // project: one decision; domain 'node': one decision. Both are 'decision' type.
    const projDec = stores.create(decisionRec({ title: 'project decision' })) as { id: string };
    const domDec = stores.create(decisionRec({ ...kenv('decision', 'domain:node'), title: 'domain decision' })) as { id: string };

    const groups = vm.knowledgeBySource!(stores, 'decision');
    // both sources are non-empty → project first, then the domain (manifest order)
    assert.deepEqual(groups.map((g) => g.source), ['project', 'node'], 'project source first, then mounted domain');

    const proj = groups.find((g) => g.source === 'project')!;
    const node = groups.find((g) => g.source === 'node')!;
    // each source's records mapped via toCard (Card shape, decision type)
    assert.ok(proj.cards.every((c) => c.type === 'decision'), 'project group holds decision cards');
    assert.ok(proj.cards.some((c) => c.id === projDec.id), 'the project decision is under project');
    assert.ok(node.cards.some((c) => c.id === domDec.id), 'the domain decision is under node');
    assert.ok(!proj.cards.some((c) => c.id === domDec.id), 'a domain record never appears under project');
    // cards are SOURCE-TAGGED with their physical store
    assert.equal(proj.cards.find((c) => c.id === projDec.id)!.source, 'project', 'project card tagged source=project');
    assert.equal(node.cards.find((c) => c.id === domDec.id)!.source, 'node', 'domain card tagged source=node');

    // EMPTY sources dropped: query a type that exists ONLY in the project store
    const onlyProj = stores.create(referenceRec({ title: 'project-only ref' })) as { id: string };
    const refGroups = vm.knowledgeBySource!(stores, 'reference_material');
    assert.deepEqual(refGroups.map((g) => g.source), ['project'], 'the empty domain source is dropped (AC3 — empty sources hidden)');
    assert.ok(refGroups[0].cards.some((c) => c.id === onlyProj.id));
  } finally {
    cleanup();
  }
});

test('P2 AC3: knowledgeBySource over a type with NO records anywhere → empty (every source dropped)', () => {
  const { stores, cleanup } = mountedFixture(['node']);
  try {
    assert.strictEqual(typeof vm.knowledgeBySource, 'function', 'viewmodel.knowledgeBySource must exist (AC3)');
    // nothing of this type created anywhere → both sources empty → both dropped
    const groups = vm.knowledgeBySource!(stores, 'anti_pattern');
    assert.deepEqual(groups, [], 'no records of the type anywhere → no source groups (all empty dropped)');
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
