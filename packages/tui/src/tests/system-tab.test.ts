import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { initialUi, TABS, type UiState } from '../state.js';
import * as stateMod from '../state.js';
import * as viewmodel from '../viewmodel.js';

// ===========================================================================
// FROZEN PHASE-4 oracle (run r-f9a7) — SPEC-ONLY, written before the TUI
// System tab exists. These pin brief tui-system-tab's phase-4 ACs at the level
// the TUI's PURE layers permit:
//
//   AC1  a new 'System' tab lists every registered agent with the model +
//        effort read from its INSTALLED .claude/agents/* frontmatter — the copy
//        that actually governs dispatch (buildSystemTab rows, per config.models
//        KEY, governed agents listed, the INSTALLED values shown).
//   AC4  an agent whose installed frontmatter disagrees with config.models
//        shows a visible DRIFT marker (driftOf + the row marker; a partially
//        applied projection surfaces as drift — the P5 backstop).
//   AC5  every swap emits ONE commit effect carrying the config.models write,
//        the surgical installed-frontmatter projection, and a swap DECISION
//        record titled 'Model swap: <key> <old>→<new> (System tab)'.
//
// Plus the phase-4 machinery the ACs ride on: the sixth TABS entry + hotkey/
// hit-test scaling by TABS.length; the inline selector state machine
// (open/navigate/commit/cancel); the effort rule (no xhigh/max for subagent
// keys, xhigh only on coder_hard); the ^claude- model-value refusal; the
// catalog-status banner (absent / fresh / stale-with-date); and rendering at
// the 33-column floor.
//
// OUT OF THIS ORACLE (impure — main.ts owns them, unreachable from the pure
// layers): the actual config.json write, the actual setInstalledModelEffort
// file rewrite, the actual store.create of the decision record, the tab-
// activation snapshot READ, and the "never on the 1 Hz loop" perf guarantee.
// We specify the EFFECT VALUE the impure layer runs, never the IO.
//
// ---------------------------------------------------------------------------
// CONTRACT this oracle OWNS (decisions_made — the coder implements to these;
// they are not otherwise fixed by the interface slice, so the test defines
// them, exactly as the run r-dd88 oracles defined the cat:/src: id conventions
// and the { type:'select', ... } effect shape):
//
//   • state.SYSTEM_TAB === 5; TABS[5] === 'System'; TABS.length === 6.
//   • buildSystemTab(snapshot, ui, width?) is a PURE projection returning
//     { rows, banner }. rows carry ONE row per config.models KEY, in the
//     configModels key insertion order, id 'sys:<key>'.
//   • driftOf(installedValue, configValue) is a pure SCALAR (string) comparison
//     → true iff the two differ.
//   • the drifted row exposes row.drift === true AND renders the word 'drift'
//     in its text (the visible AC4 marker); an aligned row does neither.
//   • reduce/buildDashboardState gain a TRAILING optional roster? param (after
//     the existing knowledge? param) — the additive-optional-param idiom of
//     decision 34d61f60. buildSystemTab reads the same snapshot from ui.
//   • inline selector protocol: on a key row ENTER opens the MODEL picker
//     (options = catalog entries, highlight at index 0); UP/DOWN move the
//     highlight; ENTER confirms the model and opens the EFFORT picker (options
//     honor the rule, highlight at index 0); ENTER commits (emits the effect);
//     ESCAPE cancels at any stage with no effect.
//   • the commit effect: { type:'model_swap', key, from:{model,effort},
//     to:{model,effort}, agents:string[] (governed agent names, [] for a
//     config-only key), decisionTitle }.  from = the CURRENT config value
//     (the authoritative copy being replaced).  decisionTitle follows the
//     convention 'Model swap: <key> <oldModel>→<newModel> (System tab)'.
//   • a selected model failing /^claude-/ is REFUSED at commit (no effect).
//
// CLEAN-RED discipline (mirrors the run r-dd88 vm/S/S4 casts in state.test.ts):
//   • the not-yet-exported symbols (SYSTEM_TAB, buildSystemTab, driftOf) are
//     reached through NARROW casts on the module namespaces so the file
//     COMPILES under tsc strict before they exist; a symbol may land in either
//     state.ts or viewmodel.ts, so it is resolved from EITHER namespace.
//   • every test that uses such a symbol EXISTENCE-asserts it FIRST, so an
//     unimplemented symbol yields a clean AssertionError, never a TypeError.
//   • reduce ALREADY exists and is defensive, so the selector/commit tests
//     drive it with a REAL store + the roster cast: today it ignores the extra
//     arg and the tab-5 ui, emitting no swap effect → the AC5 assertions fail
//     RED on AssertionError, never a crash.
// ===========================================================================

/** The System tab index used to DRIVE the entry points without passing a raw
 *  `undefined` tab (mirrors KNOW_TAB=2 in state.test.ts). The exported
 *  state.SYSTEM_TAB is asserted to equal this by the registry test below. */
const SYS_TAB = 5;

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

// ---- injected snapshot shape (interface slice: AgentRosterSnapshot) --------
interface CatalogEntry {
  id: string;
  label: string;
  tier: string;
  status: string;
}
/** The catalog-status VIEW the impure layer computes at tab activation
 *  (catalogStatus(record|null, now, thresholdDays) → present/stale/staleDate)
 *  and injects alongside the entries. Precomputed so buildSystemTab stays pure
 *  and deterministic (no `now` inside the projection). */
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
interface AgentRosterSnapshot {
  agents: RosterAgent[];
  configModels: Record<string, { model: string; effort: string }>;
  catalog: CatalogStatusView;
}

// ---- projected shapes buildSystemTab returns -------------------------------
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
}

// ---- the commit effect the impure layer runs (SYSTEM_TAB commit effect) ----
interface ModelSwapEffect {
  type: string;
  key?: string;
  from?: { model?: string; effort?: string };
  to?: { model?: string; effort?: string };
  agents?: string[];
  decisionTitle?: string;
}

// ---- narrow casts for not-yet-exported symbols (clean-red) -----------------
const stateNs = stateMod as unknown as Record<string, unknown>;
const vmNs = viewmodel as unknown as Record<string, unknown>;
/** Resolve a phase-4 symbol from EITHER the state or the viewmodel namespace
 *  (the interface slice calls buildSystemTab/driftOf a "state/viewmodel
 *  projection" — placement is the coder's call). Returns undefined until it
 *  exists, so callers existence-assert first. */
function resolve(name: string): unknown {
  return stateNs[name] !== undefined ? stateNs[name] : vmNs[name];
}
const buildSystemTab = resolve('buildSystemTab') as
  | ((snap: AgentRosterSnapshot, ui: UiState, width?: number) => SystemTabView)
  | undefined;
const driftOf = resolve('driftOf') as ((installed: string, config: string) => boolean) | undefined;

interface SystemTabConst {
  SYSTEM_TAB?: number;
}
const STc = stateMod as unknown as SystemTabConst;

/** reduce with the additive trailing roster? param (after knowledge?). The
 *  committed signature lacks it, so the cast lets tsc accept the extra arg
 *  before the coder adds it; the leading args stay real so today's code runs
 *  the (no-op-for-tab-5) path WITHOUT throwing. */
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

// ---- fixtures --------------------------------------------------------------
const REVIEWER_AGENTS = ['reviewer-correctness', 'reviewer-security', 'reviewer-skeptic', 'reviewer-performance'];

/** Catalog entries. Entry[0] is claude-opus-4-8 (the reviewers/coder_hard
 *  current model), so a single DOWN lands on entry[1] regardless of whether the
 *  picker highlights index 0 or the current model. 'Opus 4.1' is used by NO
 *  config key — its appearance is the "picker is open" tell. */
const CATALOG_ENTRIES: CatalogEntry[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet', status: 'active' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', tier: 'haiku', status: 'active' },
  { id: 'claude-opus-4-1', label: 'Opus 4.1', tier: 'opus', status: 'legacy' },
];
function freshCatalog(entries: CatalogEntry[] = CATALOG_ENTRIES): CatalogStatusView {
  return { present: true, stale: false, staleDate: null, entries };
}

function baseSnapshot(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [
      { name: 'coder', installedModel: 'claude-sonnet-4-6', installedEffort: 'high' },
      ...REVIEWER_AGENTS.map((name) => ({ name, installedModel: 'claude-opus-4-8', installedEffort: 'low' })),
    ],
    // insertion order fixes the row order + the cursor index per key:
    // coder=0, reviewers=1, coder_hard=2, classifiers=3
    configModels: {
      coder: { model: 'claude-sonnet-4-6', effort: 'high' },
      reviewers: { model: 'claude-opus-4-8', effort: 'low' },
      coder_hard: { model: 'claude-opus-4-8', effort: 'xhigh' },
      classifiers: { model: 'claude-haiku-4-5', effort: 'low' },
    },
    catalog: freshCatalog(),
    ...over,
  };
}

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-systab-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Flatten every rendered line + the banner into one haystack for substring
 *  assertions that don't care WHERE (banner field vs a header row) a status
 *  line lives. */
function allText(view: SystemTabView): string {
  const banner = Array.isArray(view.banner) ? view.banner.join('\n') : (view.banner ?? '');
  return [banner, ...view.rows.flatMap((r) => r.lines.map((l) => l.text))].join('\n');
}
function rowText(row: SystemRow): string {
  return row.lines.map((l) => l.text).join(' ');
}
function rowOf(view: SystemTabView, key: string): SystemRow | undefined {
  return view.rows.find((r) => r.id === `sys:${key}` || r.key === key);
}

/** Drive reduce through a keystroke sequence, threading ui and collecting every
 *  effect emitted across all steps. */
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
function findSwap(effects: { type: string }[]): ModelSwapEffect | undefined {
  return effects.find((e) => (e as ModelSwapEffect).type === 'model_swap') as ModelSwapEffect | undefined;
}
const key = (name: string) => ({ kind: 'key', name });

// ===========================================================================
// TABS registry — the sixth tab; hotkey + hit-test scale by TABS.length
// ===========================================================================

test('phase4 registry: TABS gains "System" as the sixth entry; state.SYSTEM_TAB === 5', () => {
  assert.strictEqual(typeof STc.SYSTEM_TAB, 'number', 'state.SYSTEM_TAB must be an exported number');
  assert.equal(STc.SYSTEM_TAB, SYS_TAB, 'the System tab is index 5 (appended sixth)');
  assert.equal(TABS.length, 6, 'TABS grows to six entries');
  assert.equal(TABS[5], 'System', 'TABS[5] is the "System" label');
});

test('phase4 registry: the digit-6 hotkey scales via TABS.length and selects the System tab', () => {
  const { store, cleanup } = storeFixture();
  try {
    // '6' is out of range while TABS.length is 5 (RED: stays on tab 0); once the
    // sixth tab is registered it selects index 5 (GREEN). Hotkeys scale by count.
    const r = SR.reduce(store, st(), { kind: 'char', ch: '6' });
    assert.equal(r.ui.tab, SYS_TAB, "the '6' hotkey switches to the sixth (System) tab");
  } finally {
    cleanup();
  }
});

test('phase4 registry: a tab-bar click on the sixth cell hit-tests to the System tab (layout scales by TABS.length)', () => {
  const { store, cleanup } = storeFixture();
  try {
    // the established tab-bar layout (state.test.ts: Notes clicked at x=9) is a
    // 1-space-padded cell per label on terminal row 2: cell_i starts at
    // 1 + Σ_{j<i}(len_j + 2); its label's first char is start+1. The sixth cell
    // must appear by the SAME formula — that IS the scaling contract.
    const start = 1 + TABS.slice(0, 5).reduce((acc, label) => acc + label.length + 2, 0);
    const x = start + 1;
    const r = SR.reduce(store, st(), { kind: 'click', x, y: 2 });
    assert.equal(r.ui.tab, SYS_TAB, 'clicking the sixth tab cell selects the System tab');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC1 — the roster: one row per config.models KEY, governed agents listed,
// the INSTALLED frontmatter values shown (the copy that governs dispatch)
// ===========================================================================

test('AC1: buildSystemTab renders exactly one row per config.models KEY, in key order, id "sys:<key>"', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported (state/viewmodel projection)');
  const snap = baseSnapshot();
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  assert.ok(Array.isArray(view.rows), 'buildSystemTab returns a rows array');
  assert.deepEqual(
    view.rows.map((r) => r.id),
    Object.keys(snap.configModels).map((k) => `sys:${k}`),
    'one row per config.models key, in configModels key order',
  );
});

test('AC1: a governed key (reviewers) lists ALL four governed agents and shows the installed model + effort', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const view = buildSystemTab!(baseSnapshot(), st({ tab: SYS_TAB }), 80);
  const reviewers = rowOf(view, 'reviewers');
  assert.ok(reviewers, 'the reviewers row is present');
  const text = rowText(reviewers!);
  for (const name of REVIEWER_AGENTS) {
    assert.match(text, new RegExp(name), `the reviewers row lists the governed agent ${name}`);
  }
  assert.match(text, /claude-opus-4-8/, 'the reviewers row shows the installed model');
  assert.match(text, /\blow\b/, 'the reviewers row shows the installed effort');
});

test('AC1: config-only keys (coder_hard, classifiers) appear as rows with no governed agent, showing their config model+effort', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const view = buildSystemTab!(baseSnapshot(), st({ tab: SYS_TAB }), 80);
  const hard = rowOf(view, 'coder_hard');
  assert.ok(hard, 'the coder_hard config-only row is present');
  const hardText = rowText(hard!);
  // no installed/registered agent maps to coder_hard, so no agent name is listed on it
  for (const name of ['coder', ...REVIEWER_AGENTS]) {
    assert.doesNotMatch(hardText, new RegExp(name), `coder_hard is config-only — it does not list the agent ${name}`);
  }
  assert.match(hardText, /claude-opus-4-8/, 'coder_hard shows its config model');
  assert.match(hardText, /xhigh/, 'coder_hard shows its config effort (xhigh)');
  assert.ok(rowOf(view, 'classifiers'), 'the classifiers config-only row is present');
});

test('AC1: every registered agent in the snapshot appears in exactly one row (the tab lists every agent)', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const snap = baseSnapshot();
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  for (const agent of snap.agents) {
    const hits = view.rows.filter((r) => new RegExp(agent.name).test(rowText(r)));
    assert.equal(hits.length, 1, `agent ${agent.name} is listed in exactly one row`);
  }
});

test('AC1: the row shows the INSTALLED frontmatter value (the governing copy), NOT the config value, when they differ', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  // coder: installed frontmatter says opus-4-8, but config.models says sonnet-4-6.
  // The tab must surface the INSTALLED opus value — the copy that governs dispatch.
  const snap = baseSnapshot({
    agents: [
      { name: 'coder', installedModel: 'claude-opus-4-8', installedEffort: 'xhigh' },
      ...REVIEWER_AGENTS.map((name) => ({ name, installedModel: 'claude-opus-4-8', installedEffort: 'low' })),
    ],
  });
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  const coder = rowOf(view, 'coder');
  assert.ok(coder, 'the coder row is present');
  const text = rowText(coder!);
  assert.match(text, /claude-opus-4-8/, 'the installed model (opus-4-8) is shown — the governing frontmatter copy');
  assert.match(text, /xhigh/, 'the installed effort (xhigh) is shown, not the config effort');
});

// ===========================================================================
// AC4 — drift: driftOf primitive + the visible row marker
// ===========================================================================

test('AC4: driftOf is a pure scalar comparison — equal values do not drift, differing values do', () => {
  assert.strictEqual(typeof driftOf, 'function', 'driftOf must be exported');
  // aligned
  assert.equal(driftOf!('claude-opus-4-8', 'claude-opus-4-8'), false, 'identical model strings do not drift');
  assert.equal(driftOf!('low', 'low'), false, 'identical effort strings do not drift');
  // divergent
  assert.equal(driftOf!('claude-sonnet-4-6', 'claude-opus-4-8'), true, 'differing model strings drift');
  assert.equal(driftOf!('high', 'low'), true, 'differing effort strings drift');
  // boundary: a missing installed value is drift (nothing governs → disagreement)
  assert.equal(driftOf!('', 'claude-opus-4-8'), true, 'a blank installed value drifts against a set config value');
  assert.equal(driftOf!('claude-opus-4-8', ''), true, 'a set installed value drifts against a blank config value');
});

test('AC4: a row whose installed model disagrees with config shows a visible drift marker; an aligned row does not', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  // reviewers installed on sonnet, config on opus → model drift on the reviewers row.
  const snap = baseSnapshot({
    agents: [
      { name: 'coder', installedModel: 'claude-sonnet-4-6', installedEffort: 'high' },
      ...REVIEWER_AGENTS.map((name) => ({ name, installedModel: 'claude-sonnet-4-6', installedEffort: 'low' })),
    ],
  });
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  const reviewers = rowOf(view, 'reviewers')!;
  assert.equal(reviewers.drift, true, 'the reviewers row is flagged drift (installed sonnet ≠ config opus)');
  assert.match(rowText(reviewers), /drift/i, 'the drift is visible in the reviewers row text (AC4 marker)');

  const coder = rowOf(view, 'coder')!;
  assert.notEqual(coder.drift, true, 'the aligned coder row is not flagged drift');
  assert.doesNotMatch(rowText(coder), /drift/i, 'no drift marker on the aligned coder row');
});

test('AC4: EFFORT-only disagreement (model equal) still drifts the row', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  // models all match config; only the reviewers effort differs (installed high vs config low)
  const snap = baseSnapshot({
    agents: [
      { name: 'coder', installedModel: 'claude-sonnet-4-6', installedEffort: 'high' },
      ...REVIEWER_AGENTS.map((name) => ({ name, installedModel: 'claude-opus-4-8', installedEffort: 'high' })),
    ],
  });
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  const reviewers = rowOf(view, 'reviewers')!;
  assert.equal(reviewers.drift, true, 'an effort-only disagreement drifts the row');
  assert.match(rowText(reviewers), /drift/i, 'effort drift is visible on the row');
});

test('AC4/AC5 (P5 backstop): a partially applied projection — config updated but one governed agent still on the old model — surfaces as drift', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  // A swap wrote config.models.reviewers → sonnet and re-stamped three of four
  // reviewer files, but reviewer-security's frontmatter still holds opus (the
  // file write partially failed). The one disagreeing agent must show drift —
  // the AC4 marker is the P5 backstop for a partial projection (decision 98064d77c).
  const snap = baseSnapshot({
    agents: [
      { name: 'coder', installedModel: 'claude-sonnet-4-6', installedEffort: 'high' },
      { name: 'reviewer-correctness', installedModel: 'claude-sonnet-4-6', installedEffort: 'low' },
      { name: 'reviewer-security', installedModel: 'claude-opus-4-8', installedEffort: 'low' }, // stale — not re-stamped
      { name: 'reviewer-skeptic', installedModel: 'claude-sonnet-4-6', installedEffort: 'low' },
      { name: 'reviewer-performance', installedModel: 'claude-sonnet-4-6', installedEffort: 'low' },
    ],
    configModels: {
      coder: { model: 'claude-sonnet-4-6', effort: 'high' },
      reviewers: { model: 'claude-sonnet-4-6', effort: 'low' }, // config already swapped to sonnet
      coder_hard: { model: 'claude-opus-4-8', effort: 'xhigh' },
      classifiers: { model: 'claude-haiku-4-5', effort: 'low' },
    },
  });
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  const reviewers = rowOf(view, 'reviewers')!;
  assert.equal(reviewers.drift, true, 'the partially projected reviewers row is flagged drift (one agent still on opus)');
  assert.match(rowText(reviewers), /drift/i, 'the partial projection is visible as drift (P5 backstop)');
});

// ===========================================================================
// Catalog-status banner — absent / fresh / stale-with-date
// ===========================================================================

test('catalog banner: an ABSENT catalog is announced', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const snap = baseSnapshot({ catalog: { present: false, stale: false, staleDate: null, entries: [] } });
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  assert.match(allText(view), /no catalog|catalog.*(absent|missing|none)|absent|not found/i, 'the banner announces the catalog is absent');
});

test('catalog banner: a FRESH catalog is NOT announced as stale', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const view = buildSystemTab!(baseSnapshot(), st({ tab: SYS_TAB }), 80);
  assert.doesNotMatch(allText(view), /stale/i, 'a fresh catalog raises no stale announcement');
});

test('catalog banner: a STALE catalog is announced WITH its date', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const snap = baseSnapshot({ catalog: { present: true, stale: true, staleDate: '2026-01-15', entries: CATALOG_ENTRIES } });
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  const text = allText(view);
  assert.match(text, /stale/i, 'a stale catalog raises a stale announcement');
  assert.match(text, /2026-01-15/, 'the stale announcement carries the catalog date');
});

// ===========================================================================
// Inline selector state machine — open / navigate / commit / cancel
// ===========================================================================

test('selector open: ENTER on a key row opens the MODEL picker listing the catalog entries', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    // cursor on the coder row (index 0); ENTER opens the picker.
    const opened = drive(store, st({ tab: SYS_TAB, cursor: 0 }), [key('ENTER')], snap);
    const view = buildSystemTab!(snap, opened.ui, 80);
    const text = allText(view);
    // every catalog entry surfaces as an option — including 'Opus 4.1', which is
    // used by NO config key, so its presence proves the picker (not the roster) is open.
    assert.match(text, /claude-opus-4-1|Opus 4\.1/, 'the model picker lists the catalog entry unused by any config key (picker is open)');
    assert.match(text, /claude-sonnet-4-6|Sonnet 4\.6/, 'the picker lists the other catalog models too');
  } finally {
    cleanup();
  }
});

test('selector open: the plain roster (no picker) does NOT surface the unused catalog entry', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const view = buildSystemTab!(baseSnapshot(), st({ tab: SYS_TAB }), 80);
  assert.doesNotMatch(allText(view), /claude-opus-4-1|Opus 4\.1/, 'the closed roster never shows the unused catalog entry');
});

test('audit finding 24/43: ENTER on an EMPTY catalog does NOT open the picker — it surfaces a ⚠ notice', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ catalog: { present: true, stale: false, staleDate: null, entries: [] } });
    const r = drive(store, st({ tab: SYS_TAB, cursor: 0 }), [key('ENTER')], snap);
    assert.equal(r.ui.selector, undefined, 'no picker opens on an empty catalog');
    assert.match(r.ui.notice ?? '', /catalog empty|invalid|nothing to pick/i, 'a notice explains why');
    assert.match(allText(buildSystemTab!(snap, r.ui, 80)), /⚠/, 'the notice renders as a ⚠ banner row');
  } finally {
    cleanup();
  }
});

test('audit finding 24/43: committing a non-claude model is REFUSED with a visible notice (not a silent close)', () => {
  const { store, cleanup } = storeFixture();
  try {
    // a catalog whose only entry is a non-claude id → the commit fails MODEL_VALUE_RE
    const snap = baseSnapshot({ catalog: freshCatalog([{ id: 'gpt-5x', label: 'GPT 5X', tier: 'opus', status: 'active' }]) });
    // coder row: open model picker, confirm the (only) entry, advance to effort, commit
    const r = drive(store, st({ tab: SYS_TAB, cursor: 0 }), [key('ENTER'), key('ENTER'), key('ENTER')], snap);
    assert.equal(findSwap(r.effects), undefined, 'no model_swap effect emitted for a non-claude model');
    assert.equal(r.ui.selector, undefined, 'the picker closed');
    assert.match(r.ui.notice ?? '', /refused/i, 'the refusal is surfaced, not silent');
  } finally {
    cleanup();
  }
});

test('selector effort rule: a subagent key (reviewers) offers efforts EXCLUDING xhigh and max', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    // ENTER opens model picker, ENTER confirms model → advances to the EFFORT picker.
    const atEffort = drive(store, st({ tab: SYS_TAB, cursor: 1 }), [key('ENTER'), key('ENTER')], snap);
    const view = buildSystemTab!(snap, atEffort.ui, 80);
    const text = allText(view);
    assert.match(text, /minimal|\blow\b|medium|\bhigh\b/i, 'the effort picker offers allowed efforts');
    assert.doesNotMatch(text, /xhigh/i, 'a subagent key never offers xhigh (§7.2 hard rule)');
    assert.doesNotMatch(text, /\bmax\b/i, 'a subagent key never offers max');
  } finally {
    cleanup();
  }
});

test('selector effort rule: coder_hard DOES offer xhigh (the one key permitted xhigh)', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    // coder_hard is key index 2; open model picker then confirm → effort picker.
    const atEffort = drive(store, st({ tab: SYS_TAB, cursor: 2 }), [key('ENTER'), key('ENTER')], snap);
    const view = buildSystemTab!(snap, atEffort.ui, 80);
    assert.match(allText(view), /xhigh/i, 'coder_hard offers xhigh');
  } finally {
    cleanup();
  }
});

test('AC5 commit (governed key): ENTER→DOWN→ENTER→ENTER emits ONE model_swap effect with config write, governed agents, and the titled decision', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    // reviewers row (cursor 1): open model picker (highlights opus-4-8 at index 0),
    // DOWN → sonnet-4-6 (index 1), ENTER confirm model, ENTER commit (effort[0]).
    const res = drive(
      store,
      st({ tab: SYS_TAB, cursor: 1 }),
      [key('ENTER'), key('DOWN'), key('ENTER'), key('ENTER')],
      snap,
    );
    const swap = findSwap(res.effects);
    assert.ok(swap, 'the commit emits exactly one model_swap effect');
    assert.equal(res.effects.filter((e) => (e as ModelSwapEffect).type === 'model_swap').length, 1, 'exactly one swap effect, never a burst');
    assert.equal(swap!.key, 'reviewers', 'the effect names the config.models key being swapped');
    assert.equal(swap!.from?.model, 'claude-opus-4-8', 'from = the CURRENT config model (the authoritative copy being replaced)');
    assert.equal(swap!.to?.model, 'claude-sonnet-4-6', 'to = the newly selected model');
    // the governed agents (for the surgical setInstalledModelEffort projection)
    assert.deepEqual([...(swap!.agents ?? [])].sort(), [...REVIEWER_AGENTS].sort(), 'the effect carries the four governed reviewer agents for the frontmatter projection');
    // the durable decision title convention (AC5 + decision 98064d77e), verbatim
    const title = swap!.decisionTitle ?? '';
    assert.ok(title.startsWith('Model swap: reviewers '), `decision title names the key: "${title}"`);
    assert.ok(title.includes('claude-opus-4-8→claude-sonnet-4-6'), `decision title records old→new: "${title}"`);
    assert.ok(title.endsWith('(System tab)'), `decision title carries the (System tab) provenance: "${title}"`);
    // the effort committed for a subagent key honors the rule
    assert.ok(typeof swap!.to?.effort === 'string' && swap!.to!.effort.length > 0, 'the effect carries a committed effort');
    assert.notEqual(swap!.to?.effort, 'xhigh', 'a subagent swap never commits xhigh');
    assert.notEqual(swap!.to?.effort, 'max', 'a subagent swap never commits max');
  } finally {
    cleanup();
  }
});

test('AC5 commit (config-only key): a coder_hard swap emits the effect with NO governed agents (config write + decision only, no frontmatter projection)', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    // coder_hard row (cursor 2): open → DOWN to sonnet-4-6 (index 1) → confirm → commit.
    const res = drive(
      store,
      st({ tab: SYS_TAB, cursor: 2 }),
      [key('ENTER'), key('DOWN'), key('ENTER'), key('ENTER')],
      snap,
    );
    const swap = findSwap(res.effects);
    assert.ok(swap, 'a config-only key still emits a swap effect (AC5: every swap is recorded)');
    assert.equal(swap!.key, 'coder_hard', 'the effect names the coder_hard key');
    assert.equal(swap!.from?.model, 'claude-opus-4-8', 'from = the current coder_hard config model');
    assert.equal(swap!.to?.model, 'claude-sonnet-4-6', 'to = the selected model');
    assert.deepEqual(swap!.agents ?? [], [], 'a config-only key governs no installed agent — no frontmatter file to project');
    assert.ok((swap!.decisionTitle ?? '').startsWith('Model swap: coder_hard '), 'the decision is still titled for the config-only key');
  } finally {
    cleanup();
  }
});

test('selector cancel: ESCAPE after opening dismisses the picker and emits NO swap effect', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    const ui0 = st({ tab: SYS_TAB, cursor: 1 });
    // open, then confirm the picker is showing the unused catalog entry
    const opened = drive(store, ui0, [key('ENTER')], snap);
    assert.match(allText(buildSystemTab!(snap, opened.ui, 80)), /claude-opus-4-1|Opus 4\.1/, 'the picker is open after ENTER');
    // ESCAPE from the opened state → picker gone, no effect
    const cancelled = drive(store, opened.ui, [key('ESCAPE')], snap);
    assert.equal(findSwap(cancelled.effects), undefined, 'cancel emits no swap effect');
    assert.doesNotMatch(allText(buildSystemTab!(snap, cancelled.ui, 80)), /claude-opus-4-1|Opus 4\.1/, 'ESCAPE dismisses the picker (options no longer shown)');
    // and no swap escaped across the whole open→cancel sequence
    assert.equal(findSwap([...opened.effects, ...cancelled.effects]), undefined, 'no swap effect anywhere in the open→cancel path');
  } finally {
    cleanup();
  }
});

test('selector validation: a selected model failing /^claude-/ is REFUSED at commit (no effect); a valid claude model commits', () => {
  const { store, cleanup } = storeFixture();
  try {
    // catalog with a non-claude id at a KNOWN index (1): [opus-4-8, gpt-4o, sonnet-4-6]
    const badCatalog = freshCatalog([
      { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' },
      { id: 'gpt-4o', label: 'GPT-4o', tier: 'gpt', status: 'active' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet', status: 'active' },
    ]);
    const snap = baseSnapshot({ catalog: badCatalog });

    // (refusal) coder row (cursor 0): DOWN once → gpt-4o (index 1) → confirm → commit.
    const refused = drive(
      store,
      st({ tab: SYS_TAB, cursor: 0 }),
      [key('ENTER'), key('DOWN'), key('ENTER'), key('ENTER')],
      snap,
    );
    assert.equal(findSwap(refused.effects), undefined, 'a non-claude model value is refused before commit — no swap effect (^claude- floor)');

    // (happy path, red anchor) coder current is sonnet; confirm opus-4-8 (index 0, a
    // valid claude id ≠ current) → commit → a swap effect IS emitted.
    const ok = drive(
      store,
      st({ tab: SYS_TAB, cursor: 0 }),
      [key('ENTER'), key('ENTER'), key('ENTER')],
      snap,
    );
    const swap = findSwap(ok.effects);
    assert.ok(swap, 'a valid claude model commits (proves the refusal above is validation, not a dead path)');
    assert.equal(swap!.to?.model, 'claude-opus-4-8', 'the valid claude model is the committed target');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 33-column floor — narrow rendering (perf_sensitive)
// ===========================================================================

test('33-col floor: every rendered roster line fits within the 33-column pane', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const view = buildSystemTab!(baseSnapshot(), st({ tab: SYS_TAB }), 33);
  const banner = Array.isArray(view.banner) ? view.banner : [view.banner ?? ''];
  for (const line of banner) assert.ok(line.length <= 33, `banner line fits 33 cols: "${line}"`);
  for (const row of view.rows) {
    for (const line of row.lines) {
      assert.ok(line.text.length <= 33, `row ${row.id} line fits 33 cols: "${line.text}"`);
    }
  }
});

test('33-col floor: an OPEN selector still renders within the 33-column pane', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    const opened = drive(store, st({ tab: SYS_TAB, cursor: 1 }), [key('ENTER')], snap);
    const view = buildSystemTab!(snap, opened.ui, 33);
    for (const row of view.rows) {
      for (const line of row.lines) {
        assert.ok(line.text.length <= 33, `open-selector line fits 33 cols: "${line.text}"`);
      }
    }
  } finally {
    cleanup();
  }
});
