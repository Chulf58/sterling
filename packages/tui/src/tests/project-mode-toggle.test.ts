import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { initialUi, type UiState } from '../state.js';
import * as stateMod from '../state.js';

// ===========================================================================
// Project mode toggle row (decision project-mode-hobby-work-toggle-decides-flow,
// slice S1). Copies the tdd toggle row's pattern (tdd-mutation-toggles.test.ts)
// and the config write-back pattern (config-writeback.test.ts).
//
// CONTRACT this oracle owns:
//   • buildSystemTab's view carries a separate array `modeRows: SystemRow[]`
//     with exactly one row, id 'sys:project_mode', shown after tddRows.
//   • the AgentRosterSnapshot carries `mode?: string | null` — the RAW config
//     value (absent → hobby; null → the config was unreadable → UNKNOWN). A
//     value other than hobby/work renders INVALID, never as either flow.
//   • cursor index: configModels-key-count + 3 (after the tdd row); it is the
//     tab's last row, so DOWN clamps there.
//   • ENTER/SPACE emit { type: 'mode_toggle', mode } with the NEW mode:
//     hobby → work, work → hobby, invalid → hobby (the default flow).
//   • hidden (empty array) while a config.models picker is open.
//   • applyModeToggle(e, onError?, path?) writes config.mode and nothing else.
// ===========================================================================

const SYS_TAB = 3;
const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

interface SystemRow { id: string; lines: { text: string; selected?: boolean }[] }
interface SystemTabView { rows: SystemRow[]; sparringRows?: SystemRow[]; tddRows?: SystemRow[]; modeRows?: SystemRow[] }
interface Snapshot {
  agents: { name: string; installedModel: string; installedEffort: string }[];
  configModels: Record<string, { model: string; effort: string }>;
  catalog: { present: boolean; stale: boolean; staleDate: string | null; entries: { id: string; label: string; tier: string; status: string }[] };
  codexWired: boolean;
  sparringPartner: { enabled: boolean; model?: string };
  tdd: { enabled: boolean };
  mode?: string | null;
}
interface ModeToggleEffect { type: string; mode?: string }

const buildSystemTab = (stateMod as unknown as Record<string, unknown>).buildSystemTab as
  | ((snap: Snapshot, ui: UiState, width?: number) => SystemTabView)
  | undefined;
const reduce = (stateMod as unknown as {
  reduce: (store: SterlingStore, ui: UiState, event: unknown, viewport?: unknown, knowledge?: unknown, roster?: Snapshot) => { ui: UiState; effects: ModeToggleEffect[] };
}).reduce;

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    agents: [{ name: 'implementor', installedModel: 'claude-opus-5-5', installedEffort: 'medium' }],
    configModels: {
      implementor: { model: 'claude-opus-5-5', effort: 'medium' },
      scout: { model: 'claude-sonnet-5', effort: 'low' },
    },
    catalog: { present: true, stale: false, staleDate: null, entries: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', status: 'active' }] },
    codexWired: true,
    sparringPartner: { enabled: true },
    tdd: { enabled: true },
    ...over,
  };
}

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function modeRowText(view: SystemTabView): string {
  assert.ok(Array.isArray(view.modeRows) && view.modeRows.length === 1, 'modeRows must be a one-entry array');
  return view.modeRows![0].lines.map((l) => l.text).join(' ');
}

const key = (name: string) => ({ kind: 'key', name });

test('mode row: a separate single-entry modeRows array; rows/sparringRows/tddRows untouched', () => {
  assert.strictEqual(typeof buildSystemTab, 'function');
  const snap = snapshot({ mode: 'hobby' });
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  assert.equal(view.rows.length, Object.keys(snap.configModels).length);
  assert.equal(view.sparringRows?.length, 2);
  assert.equal(view.tddRows?.length, 1);
  assert.equal(view.modeRows?.length, 1);
  assert.equal(view.modeRows![0].id, 'sys:project_mode');
});

test('mode row: renders HOBBY, WORK, HOBBY for an absent key, and INVALID for anything else', () => {
  assert.strictEqual(typeof buildSystemTab, 'function');
  assert.match(modeRowText(buildSystemTab!(snapshot({ mode: 'hobby' }), st({ tab: SYS_TAB }), 80)), /Project mode: HOBBY\b/);
  assert.match(modeRowText(buildSystemTab!(snapshot({ mode: 'work' }), st({ tab: SYS_TAB }), 80)), /Project mode: WORK\b/);
  assert.match(modeRowText(buildSystemTab!(snapshot(), st({ tab: SYS_TAB }), 80)), /Project mode: HOBBY\b/, 'a missing key means hobby');
  const invalid = modeRowText(buildSystemTab!(snapshot({ mode: 'Work' }), st({ tab: SYS_TAB }), 120));
  assert.match(invalid, /Project mode: INVALID \('Work'\)/);
  assert.doesNotMatch(invalid, /HOBBY|WORK\b/, 'an invalid value never reads as either flow');
  const unknown = modeRowText(buildSystemTab!(snapshot({ mode: null }), st({ tab: SYS_TAB }), 120));
  assert.match(unknown, /Project mode: UNKNOWN \(config unreadable\)/, 'an unreadable config is UNKNOWN, never the hobby default');
});

test('mode row: DOWN from the tdd row lands on it; it is the last row (DOWN clamps); UP returns to tdd', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ mode: 'hobby' });
    const n = Object.keys(snap.configModels).length;
    const down = reduce(store, st({ tab: SYS_TAB, cursor: n + 2 }), key('DOWN'), undefined, undefined, snap);
    assert.equal(down.ui.cursor, n + 3);
    const clamped = reduce(store, down.ui, key('DOWN'), undefined, undefined, snap);
    assert.equal(clamped.ui.cursor, n + 3);
    const up = reduce(store, clamped.ui, key('UP'), undefined, undefined, snap);
    assert.equal(up.ui.cursor, n + 2);
    const selected = buildSystemTab!(snap, down.ui, 80).modeRows![0].lines[0];
    assert.equal(selected.selected, true, 'the row is marked selected under the cursor');
  } finally {
    cleanup();
  }
});

test('mode row: ENTER and SPACE emit mode_toggle with the NEW mode (hobby→work, work→hobby, invalid→hobby); no picker', () => {
  const { store, cleanup } = storeFixture();
  try {
    const cases: [string | undefined, string, string][] = [
      ['hobby', 'ENTER', 'work'],
      ['work', 'SPACE', 'hobby'],
      [undefined, 'ENTER', 'work'],
      ['bogus', 'ENTER', 'hobby'],
    ];
    for (const [mode, k, next] of cases) {
      const snap = snapshot(mode === undefined ? {} : { mode });
      const n = Object.keys(snap.configModels).length;
      const r = reduce(store, st({ tab: SYS_TAB, cursor: n + 3 }), key(k), undefined, undefined, snap);
      const effect = r.effects.find((e) => e.type === 'mode_toggle');
      assert.ok(effect, `${k} on the mode row emits mode_toggle (from ${mode})`);
      assert.equal(effect!.mode, next, `from ${String(mode)} the new mode is ${next}`);
      assert.equal(r.ui.selector, undefined);
      assert.equal(r.effects.some((e) => e.type === 'tdd_toggle'), false, 'the tdd row is not touched');
    }
  } finally {
    cleanup();
  }
});

test('mode row: hidden while a config.models picker is open', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ mode: 'work' });
    const opened = reduce(store, st({ tab: SYS_TAB, cursor: 0 }), key('ENTER'), undefined, undefined, snap);
    const view = buildSystemTab!(snap, opened.ui, 80);
    assert.ok(Array.isArray(view.modeRows));
    assert.equal(view.modeRows!.length, 0);
  } finally {
    cleanup();
  }
});

test('mode row: the dashboard state draws it after the tdd row', () => {
  const { store, cleanup } = storeFixture();
  try {
    const build = (stateMod as unknown as Record<string, unknown>).buildDashboardState as (
      store: SterlingStore, ui: UiState, width?: number, maxBodyLines?: number, projectName?: string, bannerShown?: boolean, knowledge?: unknown, roster?: Snapshot,
    ) => { rows: { id: string }[] };
    const dash = build(store, st({ tab: SYS_TAB }), 80, undefined, undefined, undefined, undefined, snapshot({ mode: 'work' }));
    const ids = dash.rows.map((r) => r.id);
    assert.ok(ids.includes('sys:project_mode'));
    assert.equal(ids.indexOf('sys:project_mode'), ids.indexOf('sys:tdd_enabled') + 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// write-back: the round trip through .sterling/config.json
// ---------------------------------------------------------------------------

type Writeback = { applyModeToggle?: (e: { type: 'mode_toggle'; mode: 'hobby' | 'work' }, onError?: (m: string) => void, path?: string) => boolean };

test('applyModeToggle: writes config.mode at the explicit path, keeps every other key, and round-trips', async () => {
  const mod = (await import('../config-writeback.js')) as unknown as Writeback;
  assert.strictEqual(typeof mod.applyModeToggle, 'function', 'applyModeToggle must be exported');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-wb-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    const cfgPath = join(dir, '.sterling', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ project_name: 'x', tdd: { enabled: false }, models: { scout: { model: 'm', effort: 'low' } } }, null, 2));
    assert.equal(mod.applyModeToggle!({ type: 'mode_toggle', mode: 'work' }, undefined, cfgPath), true);
    const afterWork = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(afterWork, { project_name: 'x', tdd: { enabled: false }, models: { scout: { model: 'm', effort: 'low' } }, mode: 'work' });
    assert.equal(mod.applyModeToggle!({ type: 'mode_toggle', mode: 'hobby' }, undefined, cfgPath), true);
    assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).mode, 'hobby');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyModeToggle: an unreadable config reports the failure through onError and returns false', async () => {
  const mod = (await import('../config-writeback.js')) as unknown as Writeback;
  assert.strictEqual(typeof mod.applyModeToggle, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mode-wb-'));
  try {
    const errors: string[] = [];
    const ok = mod.applyModeToggle!({ type: 'mode_toggle', mode: 'work' }, (m) => errors.push(m), join(dir, 'missing', 'config.json'));
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /mode toggle failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
