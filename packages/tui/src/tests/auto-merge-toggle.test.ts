import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore } from '@sterling/store';
import { initialUi, buildSystemTab, buildDashboardState, reduce, type AgentRosterSnapshot, type UiState, type UiEvent, type Effect } from '../state.js';
import { applyAutoMergeToggle } from '../config-writeback.js';

// ===========================================================================
// PR auto-merge toggle row (decision
// work-mode-pr-auto-merge-when-copilot-loop-ends-clean, board 2ebbea9d).
// Copies the handoff files row's pattern (handoff-toggle.test.ts).
//
// CONTRACT this oracle owns:
//   • buildSystemTab's view carries `autoMergeRows: SystemRow[]` with exactly
//     one row, id 'sys:pr_auto_merge', drawn after the handoff files row.
//   • AgentRosterSnapshot.autoMergeOnClean: true/false, a string for a raw value
//     the judge refuses (INVALID), null for an unreadable config (UNKNOWN).
//     Absent → ON, the shipped default.
//   • cursor index: configModels-key-count + 5; it is the tab's last row, so
//     DOWN clamps there.
//   • ENTER/SPACE emit { type: 'auto_merge_toggle', enabled } with the NEW
//     value: on → off, off → on, absent → off, invalid or unknown → off (the
//     side that never merges).
//   • hidden while a config.models picker is open.
//   • applyAutoMergeToggle writes config.pr_review.auto_merge_on_clean and keeps
//     copilot_logins and every other key.
// ===========================================================================

const SYS_TAB = 4;
const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });
const key = (name: string): UiEvent => ({ kind: 'key', name }) as UiEvent;

function snapshot(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
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
  } as AgentRosterSnapshot;
}

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-auto-merge-row-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function rowText(snap: AgentRosterSnapshot, ui: UiState = st({ tab: SYS_TAB }), width = 120): string {
  const view = buildSystemTab(snap, ui, width);
  assert.equal(view.autoMergeRows.length, 1, 'autoMergeRows must be a one-entry array');
  return view.autoMergeRows[0].lines.map((l) => l.text).join(' ');
}

test('auto-merge row: one row, id sys:pr_auto_merge; the other row lists are untouched', () => {
  const snap = snapshot();
  const view = buildSystemTab(snap, st({ tab: SYS_TAB }), 80);
  assert.equal(view.rows.length, Object.keys(snap.configModels).length + 1);
  assert.equal(view.handoffRows.length, 1);
  assert.equal(view.storageRows.length, 1);
  assert.equal(view.autoMergeRows.length, 1);
  assert.equal(view.autoMergeRows[0].id, 'sys:pr_auto_merge');
});

test('auto-merge row: ON when absent (the default), ON, OFF, INVALID for a refused value and UNKNOWN for an unreadable config', () => {
  assert.match(rowText(snapshot()), /Auto-merge clean PRs \(work mode\): ON$/, 'absent means on');
  assert.match(rowText(snapshot({ autoMergeOnClean: true })), /: ON$/);
  assert.match(rowText(snapshot({ autoMergeOnClean: false })), /: OFF$/);
  const invalid = rowText(snapshot({ autoMergeOnClean: '"yes"' }));
  assert.match(invalid, /: INVALID \("yes"\)$/);
  assert.doesNotMatch(invalid, /\bON\b|\bOFF\b/, 'an invalid value never reads as on or off');
  for (const root of ['null', '7', '"x"', '[]']) {
    const text = rowText(snapshot({ autoMergeOnClean: root }));
    assert.match(text, new RegExp(`: INVALID \\(${root.replace(/[[\]]/g, '\\$&')}\\)$`), `a ${root} config root shows INVALID`);
    assert.doesNotMatch(text, /\bON\b|\bOFF\b/);
  }
  assert.match(rowText(snapshot({ autoMergeOnClean: null })), /: UNKNOWN \(config unreadable\)$/, 'never the on default');
});

test('auto-merge row: DOWN from the handoff row lands on it; it is the last row (DOWN clamps); UP returns to the handoff row', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot();
    const n = Object.keys(snap.configModels).length + 1;
    const down = reduce(store, st({ tab: SYS_TAB, cursor: n + 4 }), key('DOWN'), undefined, undefined, snap);
    assert.equal(down.ui.cursor, n + 5);
    const clamped = reduce(store, down.ui, key('DOWN'), undefined, undefined, snap);
    assert.equal(clamped.ui.cursor, n + 5);
    const up = reduce(store, clamped.ui, key('UP'), undefined, undefined, snap);
    assert.equal(up.ui.cursor, n + 4);
    const view = buildSystemTab(snap, down.ui, 80);
    assert.equal(view.autoMergeRows[0].lines[0].selected, true);
    assert.notEqual(view.handoffRows[0].lines[0].selected, true);
  } finally {
    cleanup();
  }
});

test('auto-merge row: ENTER and SPACE emit auto_merge_toggle with the NEW value (on→off, off→on, absent→off, invalid→off, unknown→off); no other row is touched', () => {
  const { store, cleanup } = storeFixture();
  try {
    const cases: [boolean | string | null | undefined, string, boolean][] = [
      [true, 'ENTER', false],
      [false, 'SPACE', true],
      [undefined, 'ENTER', false],
      ['"yes"', 'ENTER', false],
      [null, 'ENTER', false],
    ];
    for (const [value, k, next] of cases) {
      const snap = snapshot(value === undefined ? {} : { autoMergeOnClean: value });
      const n = Object.keys(snap.configModels).length + 1;
      const r = reduce(store, st({ tab: SYS_TAB, cursor: n + 5 }), key(k), undefined, undefined, snap);
      const types = r.effects.map((e: Effect) => e.type);
      assert.deepEqual(types, ['auto_merge_toggle'], `${k} from ${String(value)}: exactly one auto_merge_toggle`);
      assert.equal((r.effects[0] as { enabled: boolean }).enabled, next, `from ${String(value)} the new value is ${next}`);
      assert.equal(r.ui.selector, undefined);
    }
  } finally {
    cleanup();
  }
});

test('auto-merge row: hidden while a config.models picker is open', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot();
    const opened = reduce(store, st({ tab: SYS_TAB, cursor: 0 }), key('ENTER'), undefined, undefined, snap);
    assert.equal(buildSystemTab(snap, opened.ui, 80).autoMergeRows.length, 0);
  } finally {
    cleanup();
  }
});

test('auto-merge row: the dashboard state draws it right after the handoff files row', () => {
  const { store, cleanup } = storeFixture();
  try {
    const dash = buildDashboardState(store, st({ tab: SYS_TAB }), 80, undefined, undefined, undefined, undefined, snapshot());
    const ids = dash.rows.map((r) => r.id);
    assert.equal(ids.indexOf('sys:pr_auto_merge'), ids.indexOf('sys:handoff_files') + 1);
    assert.ok(ids.indexOf('sys:pr_auto_merge') > 0);
  } finally {
    cleanup();
  }
});

test('applyAutoMergeToggle: writes pr_review.auto_merge_on_clean, keeps copilot_logins and every other key, and replaces a non-object pr_review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-auto-merge-wb-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    const cfgPath = join(dir, '.sterling', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ mode: 'work', pr_review: { copilot_logins: ['copilot-pull-request-reviewer[bot]'] } }, null, 2));
    assert.equal(applyAutoMergeToggle({ type: 'auto_merge_toggle', enabled: false }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { mode: 'work', pr_review: { copilot_logins: ['copilot-pull-request-reviewer[bot]'], auto_merge_on_clean: false } });
    assert.equal(applyAutoMergeToggle({ type: 'auto_merge_toggle', enabled: true }, undefined, cfgPath), true);
    assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).pr_review.auto_merge_on_clean, true);
    writeFileSync(cfgPath, JSON.stringify({ mode: 'work' }));
    assert.equal(applyAutoMergeToggle({ type: 'auto_merge_toggle', enabled: false }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { mode: 'work', pr_review: { auto_merge_on_clean: false } });
    writeFileSync(cfgPath, JSON.stringify({ pr_review: 'on' }));
    assert.equal(applyAutoMergeToggle({ type: 'auto_merge_toggle', enabled: false }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { pr_review: { auto_merge_on_clean: false } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyAutoMergeToggle: an unreadable config reports the failure through onError and returns false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-auto-merge-wb-'));
  try {
    const errors: string[] = [];
    assert.equal(applyAutoMergeToggle({ type: 'auto_merge_toggle', enabled: true }, (m) => errors.push(m), join(dir, 'missing', 'config.json')), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /auto-merge toggle failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-merge notices: say what the switch changes, and only for work mode', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', 'src', 'controller.ts'), 'utf8');
  const on = src.match(/'auto-merge turned on[^']*'/)?.[0];
  const off = src.match(/'auto-merge turned off[^']*'/)?.[0];
  assert.ok(on && off, 'both notices are present');
  assert.match(on, /work mode/);
  assert.match(on, /squash-merged/);
  assert.match(off, /human merges/);
});
