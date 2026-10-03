import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore } from '@sterling/store';
import { initialUi, type UiState } from '../state.js';
import * as stateMod from '../state.js';

// ===========================================================================
// Handoff files toggle row (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting).
// Copies the project mode row's pattern (project-mode-toggle.test.ts).
//
// CONTRACT this oracle owns:
//   • buildSystemTab's view carries a separate array `handoffRows: SystemRow[]`
//     with exactly one row, id 'sys:handoff_files', shown after modeRows.
//   • the AgentRosterSnapshot carries `handoff?: boolean | string | null`: the
//     EFFECTIVE setting (true/false), a string for a raw value that is not a
//     boolean (INVALID), null for an unreadable config (UNKNOWN). Absent → OFF.
//   • `handoffDetail?: string` says why, in brackets after the value: 'not set'
//     for an absent key, the tracked-files note for ON without a key, and the git
//     error for UNKNOWN when git could not say what is tracked.
//   • cursor index: configModels-key-count + 4 (after the project mode row); it
//     is the tab's last row, so DOWN clamps there.
//   • ENTER/SPACE emit { type: 'handoff_toggle', enabled } with the NEW value:
//     off → on, on → off, invalid → off (the default).
//   • hidden (empty array) while a config.models picker is open.
//   • applyHandoffToggle(e, onError?, path?) writes config.handoff.enabled and
//     nothing else.
// ===========================================================================

const SYS_TAB = 4;
const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

interface SystemRow { id: string; lines: { text: string; selected?: boolean }[] }
interface SystemTabView { rows: SystemRow[]; sparringRows?: SystemRow[]; tddRows?: SystemRow[]; modeRows?: SystemRow[]; handoffRows?: SystemRow[] }
interface Snapshot {
  agents: { name: string; installedModel: string; installedEffort: string }[];
  configModels: Record<string, { model: string; effort: string }>;
  catalog: { present: boolean; stale: boolean; staleDate: string | null; entries: { id: string; label: string; tier: string; status: string }[] };
  codexWired: boolean;
  sparringPartner: { enabled: boolean; model?: string };
  tdd: { enabled: boolean };
  mode?: string | null;
  handoff?: boolean | string | null;
}
interface ToggleEffect { type: string; enabled?: boolean; mode?: string }

const buildSystemTab = (stateMod as unknown as Record<string, unknown>).buildSystemTab as
  | ((snap: Snapshot, ui: UiState, width?: number) => SystemTabView)
  | undefined;
const reduce = (stateMod as unknown as {
  reduce: (store: SterlingStore, ui: UiState, event: unknown, viewport?: unknown, knowledge?: unknown, roster?: Snapshot) => { ui: UiState; effects: ToggleEffect[] };
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-row-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function handoffRowText(view: SystemTabView): string {
  assert.ok(Array.isArray(view.handoffRows) && view.handoffRows.length === 1, 'handoffRows must be a one-entry array');
  return view.handoffRows![0].lines.map((l) => l.text).join(' ');
}

const key = (name: string) => ({ kind: 'key', name });

test('handoff row: a separate single-entry handoffRows array; the other row lists are untouched', () => {
  assert.strictEqual(typeof buildSystemTab, 'function');
  const snap = snapshot({ handoff: false });
  const view = buildSystemTab!(snap, st({ tab: SYS_TAB }), 80);
  assert.equal(view.rows.length, Object.keys(snap.configModels).length);
  assert.equal(view.sparringRows?.length, 2);
  assert.equal(view.tddRows?.length, 1);
  assert.equal(view.modeRows?.length, 1);
  assert.equal(view.handoffRows?.length, 1);
  assert.equal(view.handoffRows![0].id, 'sys:handoff_files');
});

test('handoff row: renders ON, OFF, OFF for an absent value, INVALID for a non-boolean and UNKNOWN for an unreadable config, in both modes', () => {
  assert.strictEqual(typeof buildSystemTab, 'function');
  for (const mode of ['hobby', 'work']) {
    assert.match(handoffRowText(buildSystemTab!(snapshot({ mode, handoff: true }), st({ tab: SYS_TAB }), 80)), /Handoff files: ON\b/, `${mode}: on`);
    assert.match(handoffRowText(buildSystemTab!(snapshot({ mode, handoff: false }), st({ tab: SYS_TAB }), 80)), /Handoff files: OFF\b/, `${mode}: off`);
  }
  assert.match(handoffRowText(buildSystemTab!(snapshot({ mode: 'work' }), st({ tab: SYS_TAB }), 80)), /Handoff files: OFF\b/, 'a missing value means off, in work mode too');
  const invalid = handoffRowText(buildSystemTab!(snapshot({ handoff: '"yes"' }), st({ tab: SYS_TAB }), 120));
  assert.match(invalid, /Handoff files: INVALID \("yes"\)/);
  assert.doesNotMatch(invalid, /\bON\b|\bOFF\b/, 'an invalid value never reads as on or off');
  const unknown = handoffRowText(buildSystemTab!(snapshot({ handoff: null }), st({ tab: SYS_TAB }), 120));
  assert.match(unknown, /Handoff files: UNKNOWN \(config unreadable\)/, 'an unreadable config is UNKNOWN, never the off default');
});

test('handoff row: says why — OFF (not set) for an absent key, ON by tracked files, UNKNOWN with the git reason — and a plain ON or OFF for an explicit key', () => {
  const row = (over: Record<string, unknown>) => handoffRowText(buildSystemTab!(snapshot(over), st({ tab: SYS_TAB }), 160));
  assert.match(row({ handoff: false, handoffDetail: 'not set' }), /Handoff files: OFF \(not set\)$/);
  assert.match(row({ handoff: true, handoffDetail: 'not set; handoff files are tracked in git' }), /Handoff files: ON \(not set; handoff files are tracked in git\)$/);
  const unknown = row({ handoff: null, handoffDetail: 'git ls-files exited 128: fatal: index file corrupt' });
  assert.match(unknown, /Handoff files: UNKNOWN \(git ls-files exited 128: fatal: index file corrupt\)$/);
  assert.doesNotMatch(unknown, /\bON\b|\bOFF\b|config unreadable/, 'a git failure never reads as on, off or a bad config');
  assert.match(row({ handoff: false }), /Handoff files: OFF$/);
  assert.match(row({ handoff: true }), /Handoff files: ON$/);
});

test('handoff row: DOWN from the project mode row lands on it; it is the last row (DOWN clamps); UP returns to the mode row', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ handoff: false });
    const n = Object.keys(snap.configModels).length;
    const down = reduce(store, st({ tab: SYS_TAB, cursor: n + 3 }), key('DOWN'), undefined, undefined, snap);
    assert.equal(down.ui.cursor, n + 4);
    const clamped = reduce(store, down.ui, key('DOWN'), undefined, undefined, snap);
    assert.equal(clamped.ui.cursor, n + 4);
    const up = reduce(store, clamped.ui, key('UP'), undefined, undefined, snap);
    assert.equal(up.ui.cursor, n + 3);
    const view = buildSystemTab!(snap, down.ui, 80);
    assert.equal(view.handoffRows![0].lines[0].selected, true, 'the row is marked selected under the cursor');
    assert.notEqual(view.modeRows![0].lines[0].selected, true, 'the mode row is not');
  } finally {
    cleanup();
  }
});

test('handoff row: ENTER and SPACE emit handoff_toggle with the NEW value (off→on, on→off, invalid→off); the mode is not touched', () => {
  const { store, cleanup } = storeFixture();
  try {
    const cases: [boolean | string | undefined, string, boolean][] = [
      [false, 'ENTER', true],
      [true, 'SPACE', false],
      [undefined, 'ENTER', true],
      ['"yes"', 'ENTER', false],
    ];
    for (const mode of ['hobby', 'work']) {
      for (const [handoff, k, next] of cases) {
        const snap = snapshot({ mode, ...(handoff === undefined ? {} : { handoff }) });
        const n = Object.keys(snap.configModels).length;
        const r = reduce(store, st({ tab: SYS_TAB, cursor: n + 4 }), key(k), undefined, undefined, snap);
        const effect = r.effects.find((e) => e.type === 'handoff_toggle');
        assert.ok(effect, `${k} on the handoff row emits handoff_toggle (from ${String(handoff)}, ${mode})`);
        assert.equal(effect!.enabled, next, `from ${String(handoff)} the new value is ${next}`);
        assert.equal(r.ui.selector, undefined);
        assert.equal(r.effects.some((e) => e.type === 'mode_toggle' || e.type === 'tdd_toggle'), false, 'no other row is touched');
      }
    }
  } finally {
    cleanup();
  }
});

test('mode row: toggling the mode emits no handoff_toggle', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ mode: 'hobby', handoff: false });
    const n = Object.keys(snap.configModels).length;
    const r = reduce(store, st({ tab: SYS_TAB, cursor: n + 3 }), key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(r.effects.map((e) => e.type), ['mode_toggle']);
  } finally {
    cleanup();
  }
});

test('handoff row: hidden while a config.models picker is open', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ handoff: true });
    const opened = reduce(store, st({ tab: SYS_TAB, cursor: 0 }), key('ENTER'), undefined, undefined, snap);
    const view = buildSystemTab!(snap, opened.ui, 80);
    assert.ok(Array.isArray(view.handoffRows));
    assert.equal(view.handoffRows!.length, 0);
  } finally {
    cleanup();
  }
});

test('handoff row: the dashboard state draws it after the project mode row', () => {
  const { store, cleanup } = storeFixture();
  try {
    const build = (stateMod as unknown as Record<string, unknown>).buildDashboardState as (
      store: SterlingStore, ui: UiState, width?: number, maxBodyLines?: number, projectName?: string, bannerShown?: boolean, knowledge?: unknown, roster?: Snapshot,
    ) => { rows: { id: string }[] };
    const dash = build(store, st({ tab: SYS_TAB }), 80, undefined, undefined, undefined, undefined, snapshot({ handoff: true }));
    const ids = dash.rows.map((r) => r.id);
    assert.ok(ids.includes('sys:handoff_files'));
    assert.equal(ids.indexOf('sys:handoff_files'), ids.indexOf('sys:project_mode') + 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// write-back: the round trip through .sterling/config.json
// ---------------------------------------------------------------------------

type Writeback = { applyHandoffToggle?: (e: { type: 'handoff_toggle'; enabled: boolean }, onError?: (m: string) => void, path?: string) => boolean };

test('applyHandoffToggle: writes config.handoff.enabled at the explicit path, keeps every other key (the mode included), and round-trips', async () => {
  const mod = (await import('../config-writeback.js')) as unknown as Writeback;
  assert.strictEqual(typeof mod.applyHandoffToggle, 'function', 'applyHandoffToggle must be exported');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-wb-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    const cfgPath = join(dir, '.sterling', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ project_name: 'x', mode: 'hobby', tdd: { enabled: false } }, null, 2));
    assert.equal(mod.applyHandoffToggle!({ type: 'handoff_toggle', enabled: true }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { project_name: 'x', mode: 'hobby', tdd: { enabled: false }, handoff: { enabled: true } });
    assert.equal(mod.applyHandoffToggle!({ type: 'handoff_toggle', enabled: false }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).handoff, { enabled: false });
    // a value that is not an object is replaced, never spread
    writeFileSync(cfgPath, JSON.stringify({ mode: 'work', handoff: 'yes' }));
    assert.equal(mod.applyHandoffToggle!({ type: 'handoff_toggle', enabled: false }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { mode: 'work', handoff: { enabled: false } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyHandoffToggle: an unreadable config reports the failure through onError and returns false', async () => {
  const mod = (await import('../config-writeback.js')) as unknown as Writeback;
  assert.strictEqual(typeof mod.applyHandoffToggle, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-wb-'));
  try {
    const errors: string[] = [];
    const ok = mod.applyHandoffToggle!({ type: 'handoff_toggle', enabled: true }, (m) => errors.push(m), join(dir, 'missing', 'config.json'));
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /handoff toggle failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The notices, composed inline in controller.ts (shared by the terminal entry
// and the OpenCode plugin), so this pins their source text. The mode notices say
// only how work ships. The handoff notices carry what the mode notices used to
// claim: /sterling:update (or init) writes both file sets, sync-agents only the
// portable agents.
// ---------------------------------------------------------------------------
test('toggle notices: the mode notices say only how work ships; the handoff notices name what writes the files', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'src', 'controller.ts'), 'utf8');
  const work = src.match(/'project mode set to work[^']*'/)?.[0];
  const hobby = src.match(/'project mode set to hobby[^']*'/)?.[0];
  const on = src.match(/'handoff files turned on[^']*'/)?.[0];
  const off = src.match(/'handoff files turned off[^']*'/)?.[0];
  assert.ok(work && hobby && on && off, 'all four notices are present');
  assert.match(work, /pull request/);
  assert.match(hobby, /direct merge|merges directly/);
  for (const n of [work, hobby]) assert.doesNotMatch(n, /OpenCode|handoff/i, 'a mode notice makes no claim about the handoff files');
  assert.match(on, /\/sterling:update/);
  assert.match(on, /\binit\b/);
  assert.doesNotMatch(on, /sync-agents[^.]*projection/, 'sync-agents does not run the handoff projection');
  assert.match(on, /sync-agents[^.]*only[^.]*portable agents/, 'sync-agents is named as the agents-only path');
  assert.match(off, /NOT deleted/);
});
