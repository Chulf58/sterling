import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { initialUi, type UiState } from '../state.js';
import * as stateMod from '../state.js';
import * as viewmodel from '../viewmodel.js';

// ===========================================================================
// TDD / MUTATION-VERIFICATION toggle rows (decision 752caf98,
// tdd-and-mutation-toggles-in-system-tab) — SPEC-ONLY, written against the
// decision's WIRING clause ("the TUI System tab gains two rows following the
// exact sparring_partner.enabled row pattern") without reading state.ts/
// main.ts. Mirrors packages/tui/src/tests/sparring-partner.test.ts's
// structure and CLEAN-RED discipline exactly, scoped to the toggle-only half
// of that pattern (tdd/mutation_verification carry no model field, so there
// is no free-text row here — only the ON/OFF row sparringRows[0] modeled).
//
// ---------------------------------------------------------------------------
// CONTRACT this oracle OWNS (not otherwise fixed by the interface slice or
// the decision text — this file defines it, exactly as sparring-partner.
// test.ts defined sparringRows/the effect shapes for its own slice):
//   • buildSystemTab's returned view carries two NEW separate arrays,
//     `tddRows: SystemRow[]` and `mutationRows: SystemRow[]`, alongside the
//     existing `rows` and `sparringRows` (both of those stay untouched).
//   • tddRows and mutationRows each carry EXACTLY ONE row — the toggle row —
//     mirroring sparringRows[0]'s shape (id/lines), never the model-row half
//     of that pattern (tdd/mutation_verification have no model field).
//   • the injected AgentRosterSnapshot (interface slice, extended for this
//     slice) carries two new fields: `tdd: { enabled: boolean }` and
//     `mutationVerification: { enabled: boolean }` (the live config values).
//   • cursor indices continue past the two sparringRows entries: tdd row =
//     configModels-key-count + 2, mutation row = configModels-key-count + 3.
//     DOWN past the mutation row clamps (it is the last row on the tab).
//   • the toggle effects: { type: 'tdd_toggle', enabled: boolean } and
//     { type: 'mutation_toggle', enabled: boolean } — the FLIPPED value, not
//     the pre-toggle value, exactly like sparring_toggle.
//   • ENTER and SPACE both toggle; no picker/selector opens for either row.
//   • while a config.models picker is open, tddRows and mutationRows are
//     BOTH empty — the same rule item 7 already pins for sparringRows in
//     sparring-partner.test.ts.
//
// CLEAN-RED discipline (mirrors sparring-partner.test.ts / run r-dd88 /
// r-f9a7): every test that reaches a not-directly-imported symbol
// existence-asserts it first, so a genuinely unimplemented surface fails on
// a clean AssertionError, never a TypeError.
// ===========================================================================

const SYS_TAB = 3;

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

interface CatalogEntry {
  id: string;
  label: string;
  tier: string;
  status: string;
}
interface CatalogStatusView {
  present: boolean;
  stale: boolean;
  staleDate: string | null;
  entries: CatalogEntry[];
}
interface RosterAgent {
  name: string;
  installedModel: string;
  installedEffort: string;
}
/** Extended for this slice with tdd + mutationVerification (see the CONTRACT
 *  comment above) — the two new fields the System tab's toggle rows read.
 *  sparringPartner/codexWired travel too since baseSnapshot must stay a valid
 *  AgentRosterSnapshot for the already-landed sparring-partner slice. */
interface AgentRosterSnapshot {
  agents: RosterAgent[];
  configModels: Record<string, { model: string; effort: string }>;
  catalog: CatalogStatusView;
  codexWired: boolean;
  sparringPartner: { enabled: boolean; model?: string };
  tdd: { enabled: boolean };
  mutationVerification: { enabled: boolean };
}

interface SystemLine {
  text: string;
  kind?: string;
  selected?: boolean;
}
interface SystemRow {
  id: string;
  key?: string;
  drift?: boolean;
  agents?: string[];
  lines: SystemLine[];
}
interface SystemTabView {
  rows: SystemRow[];
  banner: string | string[];
  sparringRows?: SystemRow[];
  tddRows?: SystemRow[];
  mutationRows?: SystemRow[];
}

interface ToggleEffect {
  type: string;
  enabled?: boolean;
}

const stateNs = stateMod as unknown as Record<string, unknown>;
const vmNs = viewmodel as unknown as Record<string, unknown>;
function resolve(name: string): unknown {
  return stateNs[name] !== undefined ? stateNs[name] : vmNs[name];
}
const buildSystemTab = resolve('buildSystemTab') as
  | ((snap: AgentRosterSnapshot, ui: UiState, width?: number) => SystemTabView)
  | undefined;

interface SystemArityStateMod {
  reduce: (
    store: SterlingStore,
    ui: UiState,
    event: unknown,
    viewport?: unknown,
    knowledge?: unknown,
    roster?: AgentRosterSnapshot,
  ) => { ui: UiState; effects: { type: string }[] };
}
const SR = stateMod as unknown as SystemArityStateMod;

const REVIEWER_AGENTS = ['reviewer-correctness', 'reviewer-security', 'reviewer-skeptic', 'reviewer-performance'];

function freshCatalog(): CatalogStatusView {
  return {
    present: true,
    stale: false,
    staleDate: null,
    entries: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet', status: 'active' },
    ],
  };
}

function baseSnapshot(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [
      { name: 'coder', installedModel: 'claude-sonnet-4-6', installedEffort: 'high' },
      ...REVIEWER_AGENTS.map((name) => ({ name, installedModel: 'claude-opus-4-8', installedEffort: 'low' })),
    ],
    configModels: {
      coder: { model: 'claude-sonnet-4-6', effort: 'high' },
      reviewers: { model: 'claude-opus-4-8', effort: 'low' },
      coder_hard: { model: 'claude-opus-4-8', effort: 'xhigh' },
      classifiers: { model: 'claude-haiku-4-5', effort: 'low' },
    },
    catalog: freshCatalog(),
    codexWired: true,
    sparringPartner: { enabled: true, model: undefined },
    tdd: { enabled: true },
    mutationVerification: { enabled: true },
    ...over,
  };
}

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tddmut-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function rowText(row: SystemRow): string {
  return row.lines.map((l) => l.text).join(' ');
}
// Existence-asserts before indexing, so a not-yet-implemented tddRows/
// mutationRows fails on a clean AssertionError, never a TypeError from
// reading `.lines` off `undefined` (CLEAN-RED discipline, mirrors the
// typeof-buildSystemTab guards used throughout this file and its sibling
// sparring-partner.test.ts).
function tddRowText(view: SystemTabView): string {
  assert.ok(Array.isArray(view.tddRows) && view.tddRows.length === 1, 'tddRows must be a one-entry array before its text can be read');
  return rowText(view.tddRows![0]);
}
function mutationRowText(view: SystemTabView): string {
  assert.ok(
    Array.isArray(view.mutationRows) && view.mutationRows.length === 1,
    'mutationRows must be a one-entry array before its text can be read',
  );
  return rowText(view.mutationRows![0]);
}

const key = (name: string) => ({ kind: 'key', name });

function drive(
  store: SterlingStore,
  ui: UiState,
  events: unknown[],
  roster?: AgentRosterSnapshot,
): { ui: UiState; effects: { type: string }[] } {
  let cur = ui;
  const all: { type: string }[] = [];
  for (const ev of events) {
    const r = SR.reduce(store, cur, ev, undefined, undefined, roster);
    cur = r.ui;
    for (const e of r.effects) all.push(e);
  }
  return { ui: cur, effects: all };
}
function findTddToggle(effects: { type: string }[]): ToggleEffect | undefined {
  return effects.find((e) => e.type === 'tdd_toggle') as ToggleEffect | undefined;
}
function findMutationToggle(effects: { type: string }[]): ToggleEffect | undefined {
  return effects.find((e) => e.type === 'mutation_toggle') as ToggleEffect | undefined;
}

// ===========================================================================
// Item 1 — tddRows/mutationRows separate from rows and sparringRows; each
// carries exactly one row
// ===========================================================================

test('toggles 1: buildSystemTab exposes tddRows and mutationRows as separate single-entry arrays; rows/sparringRows untouched', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported (frozen phase-4 oracle)');
  const snap = baseSnapshot();
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  assert.equal(view.rows.length, Object.keys(snap.configModels).length, 'rows stays one entry per config.models key — untouched by this slice');
  assert.equal(view.sparringRows?.length, 2, 'sparringRows stays exactly [toggle, model] — untouched by this slice');
  assert.ok(Array.isArray(view.tddRows), 'tddRows is exported as a separate array on the view');
  assert.equal(view.tddRows!.length, 1, 'tddRows carries exactly one row — the toggle row');
  assert.ok(Array.isArray(view.mutationRows), 'mutationRows is exported as a separate array on the view');
  assert.equal(view.mutationRows!.length, 1, 'mutationRows carries exactly one row — the toggle row');
});

// ===========================================================================
// Item 2 — ON/OFF rendering, independently, for each row
// ===========================================================================

test('toggles 2: the tdd row shows ON when tdd.enabled=true and OFF when false, independent of mutationVerification', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const on = buildSystemTab!(baseSnapshot({ tdd: { enabled: true }, mutationVerification: { enabled: false } }), st({ tab: SYS_TAB }), 80);
  assert.match(tddRowText(on), /\bON\b/, 'tdd.enabled:true renders ON on the tdd row');
  assert.match(tddRowText(on), /tdd/i, 'the tdd row identifies itself as the TDD toggle');

  const off = buildSystemTab!(baseSnapshot({ tdd: { enabled: false }, mutationVerification: { enabled: true } }), st({ tab: SYS_TAB }), 80);
  assert.match(tddRowText(off), /\bOFF\b/, 'tdd.enabled:false renders OFF on the tdd row');
});

test('toggles 2: the mutation row shows ON when mutationVerification.enabled=true and OFF when false, independent of tdd', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const on = buildSystemTab!(baseSnapshot({ mutationVerification: { enabled: true }, tdd: { enabled: false } }), st({ tab: SYS_TAB }), 80);
  assert.match(mutationRowText(on), /\bON\b/, 'mutationVerification.enabled:true renders ON on the mutation row');
  assert.match(mutationRowText(on), /mutation/i, 'the mutation row identifies itself as the mutation-verification toggle');

  const off = buildSystemTab!(baseSnapshot({ mutationVerification: { enabled: false }, tdd: { enabled: true } }), st({ tab: SYS_TAB }), 80);
  assert.match(mutationRowText(off), /\bOFF\b/, 'mutationVerification.enabled:false renders OFF on the mutation row');
});

// ===========================================================================
// Item 3 — cursor traversal past sparringRows onto tddRows then mutationRows
// ===========================================================================

test('toggles 3: UP/DOWN traverse past sparringRows onto the tdd row then the mutation row, and clamp at the bottom', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    const numKeys = Object.keys(snap.configModels).length;
    // numKeys = sparring toggle row, numKeys+1 = sparring model row (both frozen
    // by sparring-partner.test.ts) — this slice's rows continue from there.

    let r = SR.reduce(store, st({ tab: SYS_TAB, cursor: numKeys + 1 }), key('DOWN'), undefined, undefined, snap);
    assert.equal(r.ui.cursor, numKeys + 2, 'DOWN from the sparring model row lands on the tdd toggle row');

    r = SR.reduce(store, r.ui, key('DOWN'), undefined, undefined, snap);
    assert.equal(r.ui.cursor, numKeys + 3, 'DOWN again lands on the mutation toggle row');

    const clamped = SR.reduce(store, r.ui, key('DOWN'), undefined, undefined, snap);
    assert.equal(clamped.ui.cursor, numKeys + 3, 'DOWN past the mutation row clamps — it is the last row on the tab');

    let up = SR.reduce(store, clamped.ui, key('UP'), undefined, undefined, snap);
    assert.equal(up.ui.cursor, numKeys + 2, 'UP from the mutation row returns to the tdd row');

    up = SR.reduce(store, up.ui, key('UP'), undefined, undefined, snap);
    assert.equal(up.ui.cursor, numKeys + 1, 'UP from the tdd row returns to the sparring model row');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Item 4 — ENTER/SPACE on either row: the flipped-value toggle effect, no
// picker opens
// ===========================================================================

test('toggles 4: ENTER on the tdd row emits tdd_toggle with the FLIPPED value; no picker opens', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ tdd: { enabled: true } });
    const numKeys = Object.keys(snap.configModels).length;
    const r = SR.reduce(store, st({ tab: SYS_TAB, cursor: numKeys + 2 }), key('ENTER'), undefined, undefined, snap);
    const toggle = findTddToggle(r.effects);
    assert.ok(toggle, 'ENTER on the tdd row emits a tdd_toggle effect');
    assert.equal(toggle!.enabled, false, 'the effect carries the flipped value (was true)');
    assert.equal(r.ui.selector, undefined, 'no picker opens for the tdd row');
  } finally {
    cleanup();
  }
});

test('toggles 4: SPACE on the mutation row emits mutation_toggle with the flipped value (false -> true); no picker opens', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ mutationVerification: { enabled: false } });
    const numKeys = Object.keys(snap.configModels).length;
    const r = SR.reduce(store, st({ tab: SYS_TAB, cursor: numKeys + 3 }), key('SPACE'), undefined, undefined, snap);
    const toggle = findMutationToggle(r.effects);
    assert.ok(toggle, 'SPACE on the mutation row emits a mutation_toggle effect');
    assert.equal(toggle!.enabled, true, 'the effect carries the flipped value (was false)');
    assert.equal(r.ui.selector, undefined, 'no picker opens for the mutation row');
  } finally {
    cleanup();
  }
});

test('toggles 4: toggling tdd emits no mutation_toggle effect, and vice versa (the two rows are independent controls)', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ tdd: { enabled: true }, mutationVerification: { enabled: true } });
    const numKeys = Object.keys(snap.configModels).length;
    const tddOnly = SR.reduce(store, st({ tab: SYS_TAB, cursor: numKeys + 2 }), key('ENTER'), undefined, undefined, snap);
    assert.ok(findTddToggle(tddOnly.effects), 'the tdd row emits tdd_toggle');
    assert.equal(findMutationToggle(tddOnly.effects), undefined, 'the tdd row never emits mutation_toggle');

    const mutationOnly = SR.reduce(store, st({ tab: SYS_TAB, cursor: numKeys + 3 }), key('ENTER'), undefined, undefined, snap);
    assert.ok(findMutationToggle(mutationOnly.effects), 'the mutation row emits mutation_toggle');
    assert.equal(findTddToggle(mutationOnly.effects), undefined, 'the mutation row never emits tdd_toggle');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Item 5 — while a config.models picker is open, tddRows/mutationRows are
// empty (mirrors the frozen sparringRows rule, sparring-partner.test.ts item 7)
// ===========================================================================

test('toggles 5: while a config.models picker is open, tddRows and mutationRows are both empty (but still present as arrays)', () => {
  const { store, cleanup } = storeFixture();
  try {
    assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
    const snap = baseSnapshot();
    const opened = drive(store, st({ tab: SYS_TAB, cursor: 0 }), [key('ENTER')], snap);
    const view = buildSystemTab!(snap, opened.ui, 80);
    // Deliberately NOT `view.tddRows ?? []` here: that fallback would make an
    // unimplemented (undefined) field indistinguishable from a correctly-empty
    // array and pass hollow before the field exists. Array.isArray on a bare
    // `undefined` is false, so this stays a clean AssertionError until the
    // field is real.
    assert.ok(Array.isArray(view.tddRows), 'tddRows must be exported as an array even while the config.models picker is open');
    assert.equal(view.tddRows!.length, 0, 'tddRows is empty while the config.models picker is open');
    assert.ok(Array.isArray(view.mutationRows), 'mutationRows must be exported as an array even while the config.models picker is open');
    assert.equal(view.mutationRows!.length, 0, 'mutationRows is empty while the config.models picker is open');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Item 6 — bounded-viewport scroll: the System tab must honor the
// reducer-maintained ui.scroll through buildDashboardState exactly like the
// card tabs do (state.test.ts: `buildDashboardState(store, st({scroll:4}),
// 80, 3)` -> `s.scroll === 4`). Reported today: the System tab's branch of
// buildDashboardState hardcodes `scroll: 0` in its returned DashboardState,
// ignoring ui.scroll — so this pin is RED until that hardcoding is replaced
// with the same ui.scroll passthrough the card tabs already get.
//
// CONTRACT this test OWNS (not otherwise fixed by the brief): buildDashboardState
// is extended with a trailing optional `roster: AgentRosterSnapshot` argument
// (mirroring the same extension already made to `reduce`'s signature) so the
// System tab's row count is derivable when computing scroll bounds.
// ===========================================================================

test('toggles 6: buildDashboardState honors ui.scroll on the System tab — the mutation row (last row) stays inside a bounded viewport after DOWN-walking, not hardcoded to 0', async () => {
  const { store, cleanup } = storeFixture();
  try {
    assert.strictEqual(typeof stateMod.buildDashboardState, 'function', 'buildDashboardState must be exported');
    const snap = baseSnapshot();
    const numKeys = Object.keys(snap.configModels).length;
    const maxBodyLines = 2; // total SYS_TAB rows (numKeys config rows + 2 sparring + 1 tdd + 1 mutation) exceed this
    const vp = { maxBodyLines, width: 80 };

    // DOWN-walk from the top all the way onto the mutation row (cursor
    // numKeys+3, the last row on the tab), letting the reducer's revealAt
    // push ui.scroll as the cursor passes out of the small viewport — the
    // exact mechanism state.test.ts pins for the card tabs.
    let cur = st({ tab: SYS_TAB, cursor: 0, scroll: 0 });
    let lastEffects: { type: string }[] = [];
    for (let i = 0; i < numKeys + 3; i++) {
      const r = SR.reduce(store, cur, key('DOWN'), vp, undefined, snap);
      cur = r.ui;
      lastEffects = r.effects;
    }
    void lastEffects;
    assert.equal(cur.cursor, numKeys + 3, 'DOWN-walked all the way onto the mutation row (the last row on the tab)');
    assert.ok((cur.scroll ?? 0) > 0, 'precondition: the reducer already pushes ui.scroll forward to keep the cursor in view');

    // The bug under test: buildDashboardState's SYS_TAB branch is reported to
    // hardcode `scroll: 0` in the returned DashboardState instead of mirroring
    // ui.scroll like every card tab already does.
    const buildDashboardState = stateMod.buildDashboardState as unknown as (
      store: SterlingStore,
      ui: UiState,
      width?: number,
      maxBodyLines?: number,
      projectName?: string,
      bannerShown?: boolean,
      knowledge?: unknown,
      roster?: AgentRosterSnapshot,
    ) => { scroll?: number };
    const dash = buildDashboardState(store, cur, 80, maxBodyLines, undefined, undefined, undefined, snap);

    assert.equal(
      dash.scroll,
      cur.scroll,
      'DashboardState.scroll must mirror ui.scroll on the System tab exactly like the card tabs — not hardcoded to 0',
    );
    assert.ok(
      (dash.scroll ?? 0) > 0,
      'the selected mutation row must sit inside the bounded viewport, which requires a nonzero scroll',
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Item 7 — regression pin, board 8fc765e2: SPEC-ONLY, written blind to the
// concurrent fix in state.ts. systemDashboardState prepends view.banner
// row(s) before the selectable rows; the reported defect is that revealAt
// computes its scroll target against a row index that ignores this banner
// offset, so the reveal window lands banner.length rows too early and the
// selected row can sit just below the fold. Asserted at the OBSERVABLE
// level — is the selected row actually inside the revealed (clickable)
// window — via the same screenLineToRow hit-test mechanism state.test.ts
// uses for click-clipping, never a hardcoded scroll/index literal.
//
// CONTROL-DESIGN CORRECTION (this pin's second revision): a first attempt
// used 'fresh catalog' as a 'no banner' control. A sabotage run
// (bannerOffset forced to 0 in state.ts) broke BOTH arms identically,
// proving the control was mislabeled — a fresh, populated catalog carries a
// nonzero banner row too (system-tab.test.ts's own CONTRACT names three
// CONTENTS of one always-rendered catalog-status line — 'absent / fresh /
// stale-with-date' — not three presence states). MEASURED below, not
// assumed: no reachable System-tab catalog state is bannerless, so the
// control cannot be built on banner ABSENCE. It is instead built on CODE-PATH
// independence: revealAt only runs inside reduce()'s cursor-movement
// handling (toggles 6: buildDashboardState only mirrors whatever ui.scroll
// it is given, it does not itself invoke revealAt), so a UI state built
// directly at cursor 0 / scroll 0 — never routed through reduce()'s DOWN/UP
// handling — cannot possibly be affected by a bannerOffset mutation inside
// revealAt, regardless of how many banner rows the roster actually carries.
// ===========================================================================

test('toggles 7 (board 8fc765e2): a notice banner does not push the selected row below the revealed viewport window', () => {
  const { store, cleanup } = storeFixture();
  try {
    assert.strictEqual(typeof stateMod.buildDashboardState, 'function', 'buildDashboardState must be exported');
    assert.strictEqual(typeof stateMod.screenLineToRow, 'function', 'screenLineToRow must be exported');

    const numKeys = Object.keys(baseSnapshot().configModels).length;
    const totalSelectableRows = numKeys + 4; // config rows + 2 sparring + 1 tdd + 1 mutation (frozen: toggles 1-6)
    const maxBodyLines = 2; // total SYS_TAB rows exceed this — the roster is taller than the viewport
    const vp = { maxBodyLines, width: 80 };
    const lastRowCursor = numKeys + 3; // the mutation row — the last selectable row on the tab

    interface DashRow { selected?: boolean }
    interface Dash { rows: DashRow[]; bodyTop: number; scroll?: number }
    const buildDashboardState = stateMod.buildDashboardState as unknown as (
      store: SterlingStore,
      ui: UiState,
      width?: number,
      maxBodyLines?: number,
      projectName?: string,
      bannerShown?: boolean,
      knowledge?: unknown,
      roster?: AgentRosterSnapshot,
    ) => Dash;
    const screenLineToRow = stateMod.screenLineToRow as unknown as (dash: Dash, line: number, maxBodyLines?: number) => number;

    // MEASURE the banner-row count for a given roster: build at a stationary
    // cursor (no reduce call — see the CONTROL-DESIGN CORRECTION note above)
    // and diff the returned row count against the known selectable-row count.
    function bannerRowCount(snap: AgentRosterSnapshot): number {
      const dash = buildDashboardState(store, st({ tab: SYS_TAB, cursor: 0, scroll: 0 }), 80, maxBodyLines, undefined, undefined, undefined, snap);
      return dash.rows.length - totalSelectableRows;
    }

    // Confirms in-pin (not just in a code comment) that 'fresh catalog' is
    // NOT a bannerless scenario — this is why it is not used as the control.
    const freshBannerCount = bannerRowCount(baseSnapshot({ catalog: freshCatalog() }));
    assert.ok(
      freshBannerCount > 0,
      `precondition: even a fresh, populated catalog must carry a nonzero banner row (measured ${freshBannerCount}) — ` +
        'if this is 0, no bannerless System-tab state exists via this route and the CONTROL below still holds on code-path grounds alone',
    );

    // The banner arm's own scenario: an ABSENT catalog raises a notice
    // banner (system-tab.test.ts: 'catalog banner: an ABSENT catalog is
    // announced'). MEASURED nonzero, not assumed.
    const bannerSnap = baseSnapshot({ catalog: { present: false, stale: false, staleDate: null, entries: [] } });
    const bannerCount = bannerRowCount(bannerSnap);
    assert.ok(bannerCount > 0, `the absent-catalog scenario must actually raise a notice banner row (measured ${bannerCount})`);
    assert.ok(
      bannerCount < maxBodyLines,
      `sanity precondition for the CONTROL arm below: the banner row count (${bannerCount}) must be smaller than ` +
        `maxBodyLines (${maxBodyLines}) so row 0 is trivially visible at scroll 0 without needing any reveal computation`,
    );

    // The observable property: is the selected row inside the window the
    // renderer would actually draw (and a click could actually hit)?
    // Computed via screenLineToRow, never via a hardcoded scroll value or
    // index arithmetic of our own — that would just re-implement the bug
    // under test rather than observe it.
    //
    // COORDINATE SPACE: screenLineToRow returns the row's POSITION in
    // dash.rows (an array index — state.test.ts: a 2-line expanded row at
    // lines 4-5 and the next row at line 6 both map to consecutive indices
    // 0, 1, never to a cumulative line offset), not any per-row starting-line
    // field. Locate the selected row the same way — by its POSITION in
    // dash.rows — so both sides of the comparison live in the same space.
    function assertSelectedRowVisible(dash: Dash, label: string): void {
      const selectedIndex = dash.rows.findIndex((r) => r.selected);
      assert.notEqual(selectedIndex, -1, `${label}: a selected row is present in the built DashboardState`);
      const visibleIndices = new Set<number>();
      for (let line = dash.bodyTop + 1; line <= dash.bodyTop + maxBodyLines; line++) {
        const idx = screenLineToRow(dash, line, maxBodyLines);
        if (idx !== -1) visibleIndices.add(idx);
      }
      assert.ok(
        visibleIndices.has(selectedIndex),
        `${label}: selected row (rows[] index ${selectedIndex}) must be inside the revealed window ` +
          `(visible indices: [${[...visibleIndices].join(',')}], scroll=${dash.scroll})`,
      );
    }

    // CONTROL ARM FIRST — SAME banner-present roster as the treatment arm
    // below, but the cursor is never moved: built directly at cursor 0 /
    // scroll 0, bypassing reduce()'s DOWN handling entirely, so revealAt is
    // never invoked. This must pass for a DIFFERENT reason than the
    // treatment arm: not because the banner offset was computed correctly,
    // but because nothing here ever asks revealAt a question — a
    // bannerOffset mutation inside revealAt has no code path to reach this
    // arm at all.
    const controlUi = st({ tab: SYS_TAB, cursor: 0, scroll: 0 });
    const controlDash = buildDashboardState(store, controlUi, 80, maxBodyLines, undefined, undefined, undefined, bannerSnap);
    assert.equal(controlDash.scroll, 0, 'CONTROL: no cursor movement occurred, so scroll was never touched by revealAt');
    assertSelectedRowVisible(controlDash, 'CONTROL (stationary cursor, revealAt never invoked)');

    // TREATMENT ARM — the same bannerSnap, DOWN-walked from the top onto the
    // mutation row (the last selectable row), exactly like toggles 6. This
    // is the arm that actually exercises revealAt's banner-offset arithmetic.
    function driveToLastRow(snap: AgentRosterSnapshot): UiState {
      let cur = st({ tab: SYS_TAB, cursor: 0, scroll: 0 });
      for (let i = 0; i < lastRowCursor; i++) {
        cur = SR.reduce(store, cur, key('DOWN'), vp, undefined, snap).ui;
      }
      assert.equal(cur.cursor, lastRowCursor, 'DOWN-walked onto the mutation row (the last selectable row on the tab)');
      return cur;
    }
    const treatmentDash = buildDashboardState(store, driveToLastRow(bannerSnap), 80, maxBodyLines, undefined, undefined, undefined, bannerSnap);
    assertSelectedRowVisible(treatmentDash, 'banner present, cursor DOWN-walked past the fold');
  } finally {
    cleanup();
  }
});
