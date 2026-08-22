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
// SPARRING-PARTNER slice-2 oracle (article 'sparring-partner', interactions
// h + i; decision 'sparring-partner-partnership-shape' points 7/8) —
// SPEC-ONLY, written against the brief's numbered ACs without reading
// state.ts/main.ts. Slice 1 (config.sparring_partner.enabled + init wiring)
// already landed; this oracle covers the SYSTEM-TAB half: the toggle row +
// the free-text model-selector row.
//
// Implementation is reported to already exist for this slice, so GREEN is
// the expected outcome here — an assertion that fails is a FINDING to
// report (an implementation/spec mismatch), never something this file
// should be relaxed to accommodate.
//
// ---------------------------------------------------------------------------
// CONTRACT this oracle OWNS (not otherwise pinned by the interface slice —
// mirrors the "CONTRACT this oracle OWNS" precedent in system-tab.test.ts):
//   • buildSystemTab's returned view carries a SEPARATE `sparringRows: SystemRow[]`
//     alongside the existing `rows` (config.models rows are untouched).
//   • sparringRows has exactly two entries, in this fixed order: [0] the
//     enabled TOGGLE row, [1] the MODEL selector row.
//   • the injected AgentRosterSnapshot (interface slice, extended for this
//     slice) carries two new fields: `codexWired: boolean` (the machine
//     probe result) and `sparringPartner: { enabled: boolean; model?: string }`
//     (the live config.sparring_partner values).
//   • cursor indices continue past the last config.models row: toggle row =
//     configModels-key-count, model row = configModels-key-count + 1; DOWN
//     past the model row clamps (it is the last row on the tab).
//   • the toggle effect: { type: 'sparring_toggle', enabled: boolean } — the
//     FLIPPED value, not the pre-toggle value.
//   • the model-commit effect: { type: 'sparring_model', model: string } —
//     the accumulated free-text buffer verbatim ('' clears to unset).
//   • free-text edit mode is entered by ENTER on the model row and reached
//     via the same `reduce(store, ui, event, viewport?, knowledge?, roster?)`
//     entry point already used by the phase-4 System-tab oracle.
//
// CLEAN-RED discipline (mirrors run r-dd88 / r-f9a7): every test that reaches
// a not-directly-imported symbol existence-asserts it first, so a genuinely
// unimplemented surface fails on a clean AssertionError, never a TypeError.
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
/** Extended for this slice with codexWired + sparringPartner (see the CONTRACT
 *  comment above) — the two new fields the System tab's sparring rows read. */
interface AgentRosterSnapshot {
  agents: RosterAgent[];
  configModels: Record<string, { model: string; effort: string }>;
  catalog: CatalogStatusView;
  codexWired: boolean;
  sparringPartner: { enabled: boolean; model?: string };
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
}

interface SparringToggleEffect {
  type: string;
  enabled?: boolean;
}
interface SparringModelEffect {
  type: string;
  model?: string;
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
    ...over,
  };
}

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sparring-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function rowText(row: SystemRow): string {
  return row.lines.map((l) => l.text).join(' ');
}
function toggleRowText(view: SystemTabView): string {
  return rowText((view.sparringRows ?? [])[0]);
}
function modelRowText(view: SystemTabView): string {
  return rowText((view.sparringRows ?? [])[1]);
}

const key = (name: string) => ({ kind: 'key', name });
const charEv = (ch: string) => ({ kind: 'char', ch });

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
function findToggle(effects: { type: string }[]): SparringToggleEffect | undefined {
  return effects.find((e) => e.type === 'sparring_toggle') as SparringToggleEffect | undefined;
}
function findModelCommit(effects: { type: string }[]): SparringModelEffect | undefined {
  return effects.find((e) => e.type === 'sparring_model') as SparringModelEffect | undefined;
}

// ===========================================================================
// Item 1 — sparringRows separate from rows; rows untouched
// ===========================================================================

test('sparring 1: buildSystemTab exposes sparringRows separate from rows; rows stays exactly one entry per config.models key', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported (frozen phase-4 oracle)');
  const snap = baseSnapshot();
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  assert.equal(view.rows.length, Object.keys(snap.configModels).length, 'rows stays one entry per config.models key — the frozen phase-4 oracle is untouched');
  assert.ok(Array.isArray(view.sparringRows), 'sparringRows is exported as a separate array on the view');
  assert.equal(view.sparringRows!.length, 2, 'sparringRows carries exactly the toggle row and the model row');
});

// ===========================================================================
// Item 2 — toggle row ON/OFF + the not-wired-on-this-machine marker
// ===========================================================================

test('sparring 2: toggle row shows ON when enabled=true and OFF when enabled=false (codexWired true: no marker either way)', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const on = buildSystemTab!(baseSnapshot({ sparringPartner: { enabled: true, model: undefined }, codexWired: true }), st({ tab: SYS_TAB }), 80);
  assert.match(toggleRowText(on), /\bON\b/, 'enabled:true renders ON');
  assert.doesNotMatch(toggleRowText(on), /not wired on this machine/i, 'codexWired:true carries no absence marker (ON state)');

  const off = buildSystemTab!(baseSnapshot({ sparringPartner: { enabled: false, model: undefined }, codexWired: true }), st({ tab: SYS_TAB }), 80);
  assert.match(toggleRowText(off), /\bOFF\b/, 'enabled:false renders OFF');
  assert.doesNotMatch(toggleRowText(off), /not wired on this machine/i, 'codexWired:true carries no absence marker (OFF state)');
});

test('sparring 2: codexWired=false carries the "(not wired on this machine)" marker in BOTH toggle states (P5: a probe failure is never shown as a user choice)', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const on = buildSystemTab!(baseSnapshot({ sparringPartner: { enabled: true, model: undefined }, codexWired: false }), st({ tab: SYS_TAB }), 80);
  assert.match(toggleRowText(on), /\(not wired on this machine\)/, 'ON + machine-missing-Codex still shows the marker');
  assert.match(toggleRowText(on), /\bON\b/, 'the ON label itself is unaffected by the marker');

  const off = buildSystemTab!(baseSnapshot({ sparringPartner: { enabled: false, model: undefined }, codexWired: false }), st({ tab: SYS_TAB }), 80);
  assert.match(toggleRowText(off), /\(not wired on this machine\)/, 'OFF + machine-missing-Codex still shows the marker');
  assert.match(toggleRowText(off), /\bOFF\b/, 'the OFF label itself is unaffected by the marker');
});

// ===========================================================================
// Item 3 — model row: CLI default vs a set value
// ===========================================================================

test('sparring 3: model row shows "(CLI default)" when sparring_partner.model is unset', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const view = buildSystemTab!(baseSnapshot({ sparringPartner: { enabled: true, model: undefined } }), st({ tab: SYS_TAB }), 80);
  assert.match(modelRowText(view), /\(CLI default\)/, 'an unset model shows the CLI-default marker');
});

test('sparring 3: model row shows the configured value when sparring_partner.model is set', () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const view = buildSystemTab!(baseSnapshot({ sparringPartner: { enabled: true, model: 'gpt-5.6' } }), st({ tab: SYS_TAB }), 80);
  assert.match(modelRowText(view), /gpt-5\.6/, 'a set model value is shown verbatim');
  assert.doesNotMatch(modelRowText(view), /\(CLI default\)/, 'a set model does not also carry the CLI-default marker');
});

// ===========================================================================
// Item 4 — cursor traversal past config.models keys onto the sparring rows
// ===========================================================================

test('sparring 4: UP/DOWN traverse past the config.models keys onto the toggle row then the model row, and clamp at the bottom', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot();
    const numKeys = Object.keys(snap.configModels).length;

    let r = SR.reduce(store, st({ tab: SYS_TAB, cursor: numKeys - 1 }), key('DOWN'), undefined, undefined, snap);
    assert.equal(r.ui.cursor, numKeys, 'DOWN from the last config-key row lands on the toggle row');

    r = SR.reduce(store, r.ui, key('DOWN'), undefined, undefined, snap);
    assert.equal(r.ui.cursor, numKeys + 1, 'DOWN again lands on the model row');

    const clamped = SR.reduce(store, r.ui, key('DOWN'), undefined, undefined, snap);
    assert.equal(clamped.ui.cursor, numKeys + 1, 'DOWN past the model row clamps — it is the last row on the tab');

    let up = SR.reduce(store, clamped.ui, key('UP'), undefined, undefined, snap);
    assert.equal(up.ui.cursor, numKeys, 'UP from the model row returns to the toggle row');

    up = SR.reduce(store, up.ui, key('UP'), undefined, undefined, snap);
    assert.equal(up.ui.cursor, numKeys - 1, 'UP from the toggle row returns to the last config-key row');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Item 5 — ENTER/SPACE on the toggle row: sparring_toggle with the flipped
// value, no picker opens
// ===========================================================================

test('sparring 5: ENTER on the toggle row emits sparring_toggle with the FLIPPED value; no picker opens', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ sparringPartner: { enabled: true, model: undefined } });
    const numKeys = Object.keys(snap.configModels).length;
    const r = SR.reduce(store, st({ tab: SYS_TAB, cursor: numKeys }), key('ENTER'), undefined, undefined, snap);
    const toggle = findToggle(r.effects);
    assert.ok(toggle, 'ENTER on the toggle row emits a sparring_toggle effect');
    assert.equal(toggle!.enabled, false, 'the effect carries the flipped value (was true)');
    assert.equal(r.ui.selector, undefined, 'no picker opens for the toggle row');
  } finally {
    cleanup();
  }
});

test('sparring 5: SPACE on the toggle row emits sparring_toggle with the flipped value (false -> true)', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ sparringPartner: { enabled: false, model: undefined } });
    const numKeys = Object.keys(snap.configModels).length;
    const r = SR.reduce(store, st({ tab: SYS_TAB, cursor: numKeys }), key('SPACE'), undefined, undefined, snap);
    const toggle = findToggle(r.effects);
    assert.ok(toggle, 'SPACE on the toggle row emits a sparring_toggle effect');
    assert.equal(toggle!.enabled, true, 'the effect carries the flipped value (was false)');
    assert.equal(r.ui.selector, undefined, 'no picker opens for the toggle row');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Item 6 — model row free-text edit: typed chars accumulate (incl. digits and
// 'q'), BACKSPACE deletes, ENTER commits, ESCAPE cancels, empty commits ''
// ===========================================================================

test('sparring 6: ENTER opens free-text edit; letters/digits/space/"q" all feed the buffer (never trigger quit); BACKSPACE deletes; ENTER commits the buffer', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ sparringPartner: { enabled: true, model: undefined } });
    const numKeys = Object.keys(snap.configModels).length;
    const ui0 = st({ tab: SYS_TAB, cursor: numKeys + 1 });
    const events = [
      key('ENTER'),
      charEv('g'), charEv('p'), charEv('t'), charEv('-'), charEv('5'), charEv(' '), charEv('q'),
      key('BACKSPACE'),
      key('ENTER'),
    ];
    const res = drive(store, ui0, events, snap);
    assert.ok(!res.effects.some((e) => e.type === 'quit'), 'typing "q" while editing feeds the buffer — it never triggers quit');
    const commit = findModelCommit(res.effects);
    assert.ok(commit, 'the final ENTER commits a sparring_model effect');
    assert.equal(commit!.model, 'gpt-5', 'the committed buffer reflects every typed char minus the backspaced trailing q, trimmed at commit (an invisible trailing space in a model name would 400 at consult — repair 2026-08-21)');
  } finally {
    cleanup();
  }
});

test('sparring 6: ESCAPE cancels the model edit with no sparring_model effect; the row reverts to the original config value', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ sparringPartner: { enabled: true, model: 'original-model' } });
    const numKeys = Object.keys(snap.configModels).length;
    const ui0 = st({ tab: SYS_TAB, cursor: numKeys + 1 });
    const res = drive(store, ui0, [key('ENTER'), charEv('z'), charEv('z'), key('ESCAPE')], snap);
    assert.equal(findModelCommit(res.effects), undefined, 'ESCAPE emits no sparring_model effect');
    const view = buildSystemTab!(snap, res.ui, 80);
    assert.match(modelRowText(view), /original-model/, 'the row shows the original config value after cancel, not the abandoned edit');
  } finally {
    cleanup();
  }
});

test('sparring 6: backspacing the prefilled value to empty and committing emits sparring_model with model \'\' (clear to unset); an untouched ENTER is a safe re-commit, never a silent clear (repair 2026-08-21)', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ sparringPartner: { enabled: true, model: 'some-model' } });
    const numKeys = Object.keys(snap.configModels).length;
    const ui0 = st({ tab: SYS_TAB, cursor: numKeys + 1 });
    // The edit PREFILLS the current value ('some-model', 10 chars): an untouched
    // ENTER re-commits it unchanged (safe no-op), never silently clears.
    const untouched = drive(store, ui0, [key('ENTER'), key('ENTER')], snap);
    const noop = findModelCommit(untouched.effects);
    assert.ok(noop, 'ENTER with an untouched prefilled buffer still commits a sparring_model effect');
    assert.equal(noop!.model, 'some-model', 'an untouched commit carries the prefilled value — open-then-ENTER never clears the model');
    // Clearing is EXPLICIT: backspace the prefill to empty, then commit ''.
    const events = [key('ENTER'), ...Array.from({ length: 10 }, () => key('BACKSPACE')), key('ENTER')];
    const res = drive(store, ui0, events, snap);
    const commit = findModelCommit(res.effects);
    assert.ok(commit, 'ENTER on a backspaced-to-empty buffer still commits a sparring_model effect');
    assert.equal(commit!.model, '', 'an emptied buffer commits the empty string — the clear-to-unset signal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Item 7 — while a config.models picker is open, sparringRows is empty
// ===========================================================================

test('sparring 7: while a config.models picker is open, sparringRows is empty', () => {
  const { store, cleanup } = storeFixture();
  try {
    assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
    const snap = baseSnapshot();
    const opened = drive(store, st({ tab: SYS_TAB, cursor: 0 }), [key('ENTER')], snap);
    const view = buildSystemTab!(snap, opened.ui, 80);
    assert.deepEqual(view.sparringRows ?? [], [], 'sparringRows is empty while the config.models picker is open');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Item 8 — switching tabs mid-edit discards the in-progress model edit
// ===========================================================================

test('sparring 8: switching tabs mid-edit discards the in-progress model edit', () => {
  const { store, cleanup } = storeFixture();
  try {
    assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
    const snap = baseSnapshot({ sparringPartner: { enabled: true, model: undefined } });
    const numKeys = Object.keys(snap.configModels).length;
    const ui0 = st({ tab: SYS_TAB, cursor: numKeys + 1 });

    const editing = drive(store, ui0, [key('ENTER'), charEv('z'), charEv('z'), charEv('z')], snap);
    const awayThenBack = drive(store, editing.ui, [{ kind: 'tab', index: 0 }, { kind: 'tab', index: SYS_TAB }], snap);

    assert.equal(findModelCommit(awayThenBack.effects), undefined, 'no sparring_model effect leaks from the discarded edit');
    const view = buildSystemTab!(snap, awayThenBack.ui, 80);
    assert.doesNotMatch(modelRowText(view), /zzz/, 'the abandoned "zzz" buffer never appears — discarded on tab switch');
    assert.match(modelRowText(view), /\(CLI default\)/, 'the model row reflects the real (unset) config, not a stale edit buffer');
  } finally {
    cleanup();
  }
});
