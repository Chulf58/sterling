import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { initialUi, buildSystemTab, buildDashboardState, reduce, type AgentRosterSnapshot, type OverpassView, type UiState, type UiEvent, type Effect } from '../state.js';
import { applyOverpassBypass, applyOverpassProvider, applyOverpassToggle } from '../config-writeback.js';
import { openDashboard } from '../controller.js';
import { SYSTEM_TAB } from '../state.js';

// ===========================================================================
// Overpass rows on the System tab (decisions
// overpass-toggle-work-mode-only-routes-every-lane-through-tiers and
// overpass-toggle-mechanism-dispatch-pin-opencode-json-overlay-loud-open-session-notice,
// board fa214efb). Modelled on auto-merge-toggle.test.ts.
//
// CONTRACT this oracle owns:
//   • buildSystemTab's view carries `overpassRows`: ids sys:overpass,
//     sys:overpass_provider, sys:overpass_bypass, in that order, only when the
//     snapshot's mode is 'work' AND its host is 'opencode'; otherwise [].
//   • cursor indexes keys + 6 .. + 8, after every existing row, so no existing
//     index moves; sysClamp grows by 3 only while the rows are offered.
//   • ENTER/SPACE on the toggles emit overpass_toggle / overpass_bypass_toggle
//     with the NEW value; anything that is not a plain OFF flips to OFF.
//   • ENTER on the provider row opens an edit buffer; ENTER commits a valid
//     provider id as overpass_provider, an invalid one is refused with a notice
//     and the buffer stays open; ESCAPE cancels.
//   • while Overpass is effective, a role's saved OpenCode override reads
//     "(inactive: Overpass)"; picking an override still emits opencode_model.
//   • an invalid present config reads INVALID in the rows, never throws.
// ===========================================================================

const SYS_TAB = 4;
const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });
const key = (name: string): UiEvent => ({ kind: 'key', name }) as UiEvent;
const ch = (c: string): UiEvent => ({ kind: 'char', ch: c });

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
    mode: 'work',
    host: 'opencode',
    ...over,
  } as AgentRosterSnapshot;
}

const view = (over: Partial<OverpassView> = {}): OverpassView => ({ enabled: false, provider: 'overpass', conductorBypass: false, effective: false, ...over });

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-row-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const texts = (snap: AgentRosterSnapshot, ui: UiState = st({ tab: SYS_TAB })): string[] => buildSystemTab(snap, ui, 120).overpassRows.map((r) => r.lines.map((l) => l.text).join(' '));

test('overpass rows: hidden in hobby mode, and in any mode that is not work', () => {
  for (const mode of ['hobby', undefined, null, 'bogus']) {
    assert.deepEqual(buildSystemTab(snapshot({ mode }), st({ tab: SYS_TAB }), 80).overpassRows, [], `mode ${String(mode)}`);
  }
});

test('overpass rows: hidden on the Claude Code host (no host, or any host but opencode), even in work mode with Overpass on', () => {
  for (const host of [undefined, 'claude', 'terminal']) {
    const snap = snapshot({ host, overpass: view({ enabled: true, effective: true }) });
    assert.deepEqual(buildSystemTab(snap, st({ tab: SYS_TAB }), 80).overpassRows, [], `host ${String(host)}`);
  }
});

test('overpass rows: three rows, ids in order, shown in work mode on OpenCode; the other row lists are untouched', () => {
  const snap = snapshot();
  const v = buildSystemTab(snap, st({ tab: SYS_TAB }), 80);
  assert.deepEqual(v.overpassRows.map((r) => r.id), ['sys:overpass', 'sys:overpass_provider', 'sys:overpass_bypass']);
  assert.equal(v.rows.length, Object.keys(snap.configModels).length + 1);
  assert.equal(v.autoMergeRows.length, 1);
  assert.equal(v.storageRows.length, 1);
});

test('overpass rows: values read ON/OFF, the provider id, and the bypass state; absent view means the defaults (Overpass off, bypass on)', () => {
  // Deliberate default change (user-ruled 2026-10-23, 'Defaults + reset + bypass ON'): the conductor bypass reads ON by default.
  assert.deepEqual(texts(snapshot()), ['  Overpass: OFF', '  Overpass provider: overpass', '  Conductor bypass: ON']);
  assert.deepEqual(
    texts(snapshot({ overpass: view({ enabled: true, provider: 'overpass-agentic', conductorBypass: true, effective: true }) })),
    ['  Overpass: ON', '  Overpass provider: overpass-agentic', '  Conductor bypass: ON'],
  );
});

test('overpass rows: an invalid present config reads INVALID or UNKNOWN in the rows, never as a valid setting and never a throw', () => {
  const bad = texts(snapshot({ overpass: view({ enabled: '"yes"', provider: 'a/b', conductorBypass: '1' }) }));
  assert.equal(bad[0], '  Overpass: INVALID ("yes")');
  assert.equal(bad[1], '  Overpass provider: INVALID ("a/b")');
  assert.equal(bad[2], '  Conductor bypass: INVALID (1)');
  const notObject = texts(snapshot({ overpass: view({ invalid: '"on"', provider: null }) }));
  assert.deepEqual(notObject, ['  Overpass: INVALID ("on")', '  Overpass provider: INVALID ("on")', '  Conductor bypass: INVALID ("on")']);
  const providerNumber = texts(snapshot({ overpass: view({ provider: null, providerInvalid: '5' }) }));
  assert.equal(providerNumber[1], '  Overpass provider: INVALID (5)');
  const unreadable = texts(snapshot({ overpass: view({ enabled: null, provider: null, conductorBypass: null }) }));
  assert.deepEqual(unreadable, ['  Overpass: UNKNOWN (config unreadable)', '  Overpass provider: UNKNOWN (config unreadable)', '  Conductor bypass: UNKNOWN (config unreadable)']);
});

test('overpass rows: existing cursor positions do not move — the clamp still ends at the auto-merge row when the rows are hidden', () => {
  const { store, cleanup } = storeFixture();
  try {
    for (const snap of [snapshot({ mode: 'hobby' }), snapshot({ host: undefined })]) {
      const n = Object.keys(snap.configModels).length + 1;
      const clamped = reduce(store, st({ tab: SYS_TAB, cursor: n + 5 }), key('DOWN'), undefined, undefined, snap);
      assert.equal(clamped.ui.cursor, n + 5);
      const end = reduce(store, st({ tab: SYS_TAB, cursor: 0 }), key('END'), undefined, undefined, snap);
      assert.equal(end.ui.cursor, n + 5);
      // ENTER on the auto-merge row still emits the same effect
      const enter = reduce(store, st({ tab: SYS_TAB, cursor: n + 5 }), key('ENTER'), undefined, undefined, snap);
      assert.deepEqual(enter.effects.map((e: Effect) => e.type), ['auto_merge_toggle']);
    }
  } finally {
    cleanup();
  }
});

test('overpass rows: shown last — DOWN from auto-merge reaches them in order and clamps on the bypass row; UP walks back', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot();
    const n = Object.keys(snap.configModels).length + 1;
    let ui = st({ tab: SYS_TAB, cursor: n + 5 });
    for (const expected of [n + 6, n + 7, n + 8, n + 8]) {
      ui = reduce(store, ui, key('DOWN'), undefined, undefined, snap).ui;
      assert.equal(ui.cursor, expected);
    }
    const v = buildSystemTab(snap, ui, 80);
    assert.equal(v.overpassRows[2].lines[0].selected, true);
    assert.notEqual(v.overpassRows[0].lines[0].selected, true);
    assert.notEqual(v.autoMergeRows[0].lines[0].selected, true);
    assert.equal(reduce(store, st({ tab: SYS_TAB, cursor: 0 }), key('END'), undefined, undefined, snap).ui.cursor, n + 8);
    assert.equal(reduce(store, ui, key('UP'), undefined, undefined, snap).ui.cursor, n + 7);
  } finally {
    cleanup();
  }
});

test('overpass rows: the dashboard state draws them after the auto-merge row and before the read-only storage row', () => {
  const { store, cleanup } = storeFixture();
  try {
    const dash = buildDashboardState(store, st({ tab: SYS_TAB }), 80, undefined, undefined, undefined, undefined, snapshot());
    const ids = dash.rows.map((r) => r.id);
    assert.equal(ids.indexOf('sys:overpass'), ids.indexOf('sys:pr_auto_merge') + 1);
    assert.equal(ids.indexOf('sys:overpass_bypass'), ids.indexOf('sys:overpass') + 2);
    assert.equal(ids.indexOf('sys:storage'), ids.indexOf('sys:overpass_bypass') + 1);
  } finally {
    cleanup();
  }
});

test('overpass rows: hidden while a config.models picker is open', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot();
    const opened = reduce(store, st({ tab: SYS_TAB, cursor: 0 }), key('ENTER'), undefined, undefined, snap);
    assert.equal(buildSystemTab(snap, opened.ui, 80).overpassRows.length, 0);
  } finally {
    cleanup();
  }
});

test('overpass toggle: ENTER and SPACE emit overpass_toggle with the NEW value; anything but a plain OFF flips to OFF; no other row is touched', () => {
  const { store, cleanup } = storeFixture();
  try {
    const cases: [OverpassView | undefined, string, boolean][] = [
      [undefined, 'ENTER', true],
      [view({ enabled: false }), 'SPACE', true],
      [view({ enabled: true, effective: true }), 'ENTER', false],
      [view({ enabled: '"yes"' }), 'ENTER', false],
      [view({ enabled: null }), 'ENTER', false],
    ];
    for (const [v, k, next] of cases) {
      const snap = snapshot(v === undefined ? {} : { overpass: v });
      const n = Object.keys(snap.configModels).length + 1;
      const r = reduce(store, st({ tab: SYS_TAB, cursor: n + 6 }), key(k), undefined, undefined, snap);
      assert.deepEqual(r.effects.map((e: Effect) => e.type), ['overpass_toggle'], `${k}: exactly one overpass_toggle`);
      assert.equal((r.effects[0] as { enabled: boolean }).enabled, next);
      assert.equal(r.ui.selector, undefined);
    }
  } finally {
    cleanup();
  }
});

test('conductor bypass: ENTER and SPACE emit overpass_bypass_toggle with the NEW value; invalid or unknown flips to OFF', () => {
  const { store, cleanup } = storeFixture();
  try {
    const cases: [OverpassView | undefined, string, boolean][] = [
      [undefined, 'ENTER', false],
      [view({ conductorBypass: false }), 'ENTER', true],
      [view({ conductorBypass: true }), 'SPACE', false],
      [view({ conductorBypass: '1' }), 'ENTER', false],
      [view({ conductorBypass: null }), 'ENTER', false],
    ];
    for (const [v, k, next] of cases) {
      const snap = snapshot(v === undefined ? {} : { overpass: v });
      const n = Object.keys(snap.configModels).length + 1;
      const r = reduce(store, st({ tab: SYS_TAB, cursor: n + 8 }), key(k), undefined, undefined, snap);
      assert.deepEqual(r.effects.map((e: Effect) => e.type), ['overpass_bypass_toggle']);
      assert.equal((r.effects[0] as { enabled: boolean }).enabled, next);
    }
  } finally {
    cleanup();
  }
});

test('overpass provider: ENTER opens the edit prefilled with the current id; typing, BACKSPACE and a valid commit emit overpass_provider', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ overpass: view({ provider: 'overpass' }) });
    const n = Object.keys(snap.configModels).length + 1;
    let r = reduce(store, st({ tab: SYS_TAB, cursor: n + 7 }), key('ENTER'), undefined, undefined, snap);
    assert.equal(r.ui.overpassProviderEdit, 'overpass');
    assert.deepEqual(r.effects, []);
    assert.match(texts(snap, r.ui)[1], /Overpass provider: overpass▌$/, 'the buffer shows with a caret');
    r = reduce(store, r.ui, key('BACKSPACE'), undefined, undefined, snap);
    assert.equal(r.ui.overpassProviderEdit, 'overpas');
    for (const c of '-agentic.v_2') r = reduce(store, r.ui, ch(c), undefined, undefined, snap);
    assert.equal(r.ui.overpassProviderEdit, 'overpas-agentic.v_2', 'every printable key feeds the buffer');
    // navigation keys are no-ops while typing
    assert.equal(reduce(store, r.ui, key('DOWN'), undefined, undefined, snap).ui.cursor, n + 7);
    r = reduce(store, r.ui, key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(r.effects, [{ type: 'overpass_provider', provider: 'overpas-agentic.v_2' }]);
    assert.equal(r.ui.overpassProviderEdit, undefined);
  } finally {
    cleanup();
  }
});

test('overpass provider: an invalid id is refused with a visible notice, nothing is emitted, and the buffer stays open', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot();
    const n = Object.keys(snap.configModels).length + 1;
    for (const bad of ['', '   ', 'a/b', 'a#b', 'has space', 'ü']) {
      const r = reduce(store, st({ tab: SYS_TAB, cursor: n + 7, overpassProviderEdit: bad }), key('ENTER'), undefined, undefined, snap);
      assert.deepEqual(r.effects, [], `'${bad}' emits nothing`);
      assert.equal(r.ui.overpassProviderEdit, bad, 'the buffer is kept for correction');
      assert.match(r.ui.notice ?? '', /^Overpass provider refused: /);
      assert.match(buildSystemTab(snap, r.ui, 200).banner[0], /Overpass provider refused/);
    }
  } finally {
    cleanup();
  }
});

test('overpass provider: ESCAPE cancels the edit; an invalid saved id opens an empty buffer; a tab switch drops the edit', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ overpass: view({ provider: 'a/b' }) });
    const n = Object.keys(snap.configModels).length + 1;
    const opened = reduce(store, st({ tab: SYS_TAB, cursor: n + 7 }), key('ENTER'), undefined, undefined, snap);
    assert.equal(opened.ui.overpassProviderEdit, '', 'an invalid saved id is not prefilled');
    const esc = reduce(store, { ...opened.ui, overpassProviderEdit: 'x/y', notice: 'n' }, key('ESCAPE'), undefined, undefined, snap);
    assert.equal(esc.ui.overpassProviderEdit, undefined);
    assert.deepEqual(esc.effects, []);
    const away = reduce(store, { ...opened.ui, overpassProviderEdit: 'x' }, { kind: 'tab', index: 0 }, undefined, undefined, snap);
    assert.equal(away.ui.overpassProviderEdit, undefined);
  } finally {
    cleanup();
  }
});

test('overpass rows: when the mode leaves work the cursor clamps back to the auto-merge row', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ mode: 'hobby' });
    const n = Object.keys(snap.configModels).length + 1;
    const r = reduce(store, st({ tab: SYS_TAB, cursor: n + 8 }), key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(r.effects.map((e: Effect) => e.type), ['auto_merge_toggle']);
    assert.equal(r.ui.cursor, n + 5);
  } finally {
    cleanup();
  }
});

const roleText = (snap: AgentRosterSnapshot, role = 'Implementor'): string => {
  const row = buildSystemTab(snap, st({ tab: SYS_TAB }), 200).rows.find((r) => r.lines[0].text.includes(`${role}:`));
  return row ? row.lines.map((l) => l.text).join('\n') : '';
};
const withOverride = (over: Partial<AgentRosterSnapshot>): AgentRosterSnapshot =>
  snapshot({
    configModels: {
      implementor: { model: 'claude-opus-5-5', effort: 'medium', opencode_model: 'openai/gpt-6-terra' },
      scout: { model: 'claude-sonnet-5', effort: 'low' },
    },
    ...over,
  });

// Changed 2026-10-23 (board 4e7a6bfc, user-ruled "As proposed"): while Overpass is effective the saved
// override is the dimmed line 'saved OpenCode: <model>' (kind meta, like 'saved:'), not
// 'OpenCode: <model> (inactive: Overpass)'.
test('override labels: a saved OpenCode override reads as a dimmed saved OpenCode line only while Overpass is effective', () => {
  const effective = buildSystemTab(withOverride({ overpass: view({ enabled: true, effective: true }) }), st({ tab: SYS_TAB }), 200).rows[0].lines;
  assert.deepEqual(effective.map((l) => l.text), ['› Implementor: agentic-auto (Overpass)', '    saved: claude-opus-5-5 medium', '    saved OpenCode: openai/gpt-6-terra']);
  assert.deepEqual(effective.slice(1).map((l) => l.kind), ['meta', 'meta'], 'both saved lines are dimmed');
  assert.doesNotMatch(effective.map((l) => l.text).join('\n'), /inactive/);
  for (const snap of [
    withOverride({}),
    withOverride({ overpass: view({ enabled: true, effective: false }) }),
    withOverride({ mode: 'hobby', overpass: view({ enabled: true, effective: true }) }),
    withOverride({ host: undefined, overpass: view({ enabled: true, effective: true }) }),
  ]) {
    const text = roleText(snap);
    assert.match(text, /OpenCode: openai\/gpt-6-terra$/m);
    assert.doesNotMatch(text, /inactive/);
  }
});

// Changed from "still emits the plain opencode_model effect": decision
// system-tab-agent-catalog-with-overpass-on-each-row-shows-the makes the saved model
// and OpenCode override uneditable while Overpass is effective; ENTER on a role row
// now opens the tier picker (the full contract is in overpass-roles.test.ts).
test('override labels: editing an override while Overpass is effective is refused, and nothing is emitted', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = withOverride({
      overpass: view({ enabled: true, effective: true }),
      catalog: {
        present: true,
        stale: false,
        staleDate: null,
        entries: [{ id: 'gpt-6-astra', label: 'Astra', tier: 'frontier', status: 'active', vendor: 'openai' }],
      },
    });
    const opened = reduce(store, st({ tab: SYS_TAB, cursor: 0 }), key('ENTER'), undefined, undefined, snap);
    assert.equal(opened.ui.selector?.key, 'implementor');
    assert.equal(opened.ui.selector?.stage, 'tier', 'the row opens the tier picker, not the model picker');
    const picked = reduce(store, st({ tab: SYS_TAB, cursor: 0, selector: { key: 'implementor', stage: 'model', highlight: 0 } }), key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(picked.effects, []);
    assert.match(picked.ui.notice ?? '', /Overpass is on/);
  } finally {
    cleanup();
  }
});

test('config write-back: overpass_toggle, overpass_provider and overpass_bypass_toggle each write one key and keep the rest; a non-object overpass is replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-wb-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    const cfgPath = join(dir, '.sterling', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ mode: 'work', overpass: { enabled: false, provider: 'overpass', conductor_bypass: false } }, null, 2));
    assert.equal(applyOverpassToggle({ type: 'overpass_toggle', enabled: true }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { mode: 'work', overpass: { enabled: true, provider: 'overpass', conductor_bypass: false } });
    assert.equal(applyOverpassProvider({ type: 'overpass_provider', provider: 'overpass-agentic' }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).overpass, { enabled: true, provider: 'overpass-agentic', conductor_bypass: false });
    assert.equal(applyOverpassBypass({ type: 'overpass_bypass_toggle', enabled: true }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).overpass, { enabled: true, provider: 'overpass-agentic', conductor_bypass: true });
    writeFileSync(cfgPath, JSON.stringify({ mode: 'work' }));
    assert.equal(applyOverpassToggle({ type: 'overpass_toggle', enabled: true }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { mode: 'work', overpass: { enabled: true } });
    writeFileSync(cfgPath, JSON.stringify({ overpass: 'on' }));
    assert.equal(applyOverpassBypass({ type: 'overpass_bypass_toggle', enabled: true }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), { overpass: { conductor_bypass: true } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config write-back: an invalid provider is refused at the writer and writes nothing; an unreadable config reports through onError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-wb-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    const cfgPath = join(dir, '.sterling', 'config.json');
    const before = JSON.stringify({ overpass: { provider: 'overpass' } });
    writeFileSync(cfgPath, before);
    const errors: string[] = [];
    assert.equal(applyOverpassProvider({ type: 'overpass_provider', provider: 'a/b' }, (m) => errors.push(m), cfgPath), false);
    assert.match(errors[0], /Overpass provider update failed/);
    assert.equal(readFileSync(cfgPath, 'utf8'), before);
    const missing = join(dir, 'missing', 'config.json');
    assert.equal(applyOverpassToggle({ type: 'overpass_toggle', enabled: true }, (m) => errors.push(m), missing), false);
    assert.match(errors[1], /Overpass toggle failed/);
    assert.equal(applyOverpassBypass({ type: 'overpass_bypass_toggle', enabled: true }, (m) => errors.push(m), missing), false);
    assert.match(errors[2], /Overpass conductor bypass toggle failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- through the real controller --------------------------------------------

const VP = { width: 100, maxBodyLines: 60, showBanner: false };

function fixture(config: Record<string, unknown>): { dir: string; storePath: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-ctl-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return { dir, storePath: join(dir, '.sterling', 'sterling.db'), configPath };
}

const rowIds = (ctl: ReturnType<typeof openDashboard>): string[] => ctl.state(VP).rows.map((r) => r.id);

test('controller: the OpenCode host in work mode shows the rows and writes each key through handle(); the notices say what changed', async () => {
  const f = fixture({ mode: 'work' });
  const ctl = openDashboard(f.storePath, { host: 'opencode' });
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    assert.equal(ctl.roster()?.host, 'opencode');
    assert.deepEqual(ctl.roster()?.overpass, { enabled: false, provider: 'overpass', conductorBypass: true, effective: false });
    assert.ok(rowIds(ctl).includes('sys:overpass'));
    // the rows are last: DOWN clamps on the bypass row, the provider row sits above it, the toggle above that
    for (let i = 0; i < 40; i++) await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    let written = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.deepEqual(written.overpass, { conductor_bypass: false });
    assert.match(ctl.ui().notice ?? '', /^conductor bypass turned off — /);
    assert.equal(ctl.roster()?.overpass?.conductorBypass, false, 'the roster reloads after the write');

    await ctl.handle({ kind: 'key', name: 'UP' }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    for (const c of 'ab/c') await ctl.handle({ kind: 'char', ch: c }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    assert.match(ctl.ui().notice ?? '', /^Overpass provider refused: /);
    assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).overpass.provider, undefined, 'nothing was written for the refused id');
    // the buffer was prefilled with 'overpass' and then got 'ab/c': clear all 12 characters
    for (let i = 0; i < 12; i++) await ctl.handle({ kind: 'key', name: 'BACKSPACE' }, VP);
    for (const c of 'acme-1') await ctl.handle({ kind: 'char', ch: c }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    written = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.equal(written.overpass.provider, 'acme-1');
    assert.match(ctl.ui().notice ?? '', /^Overpass provider set to 'acme-1'/);

    await ctl.handle({ kind: 'key', name: 'UP' }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    written = JSON.parse(readFileSync(f.configPath, 'utf8'));
    assert.deepEqual(written.overpass, { conductor_bypass: false, provider: 'acme-1', enabled: true });
    assert.equal(written.mode, 'work', 'the mode is untouched');
    assert.match(ctl.ui().notice ?? '', /^Overpass turned on — /);
    assert.equal(ctl.roster()?.overpass?.effective, true, 'work mode on OpenCode with Overpass on is effective');
  } finally {
    ctl.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('controller: the rows are hidden without the OpenCode host, and in hobby mode on OpenCode', async () => {
  for (const [opts, mode] of [[{}, 'work'], [{ host: 'opencode' as const }, 'hobby']] as const) {
    const f = fixture({ mode });
    const ctl = openDashboard(f.storePath, opts);
    try {
      await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
      assert.equal(rowIds(ctl).some((id) => id.startsWith('sys:overpass')), false, `${JSON.stringify(opts)} ${mode}`);
      for (let i = 0; i < 40; i++) await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
      await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
      assert.equal(JSON.parse(readFileSync(f.configPath, 'utf8')).overpass, undefined, 'the last cursor stop is still the auto-merge row');
    } finally {
      ctl.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test('controller: an invalid present overpass config reaches the rows as INVALID without crashing the tab, and a toggle repairs it', async () => {
  const cases: [Record<string, unknown>, RegExp[]][] = [
    [{ mode: 'work', overpass: 'on' }, [/Overpass: INVALID \("on"\)/, /Overpass provider: INVALID \("on"\)/, /Conductor bypass: INVALID \("on"\)/]],
    [{ mode: 'work', overpass: { enabled: 'yes', provider: 'a/b', conductor_bypass: 2 } }, [/Overpass: INVALID \("yes"\)/, /Overpass provider: INVALID \("a\/b"\)/, /Conductor bypass: INVALID \(2\)/]],
    [{ mode: 'work', overpass: { provider: 7 } }, [/Overpass: OFF/, /Overpass provider: INVALID \(7\)/, /Conductor bypass: ON/]],
  ];
  for (const [config, expected] of cases) {
    const f = fixture(config);
    const ctl = openDashboard(f.storePath, { host: 'opencode' });
    try {
      await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
      const text = ctl.state(VP).rows.filter((r) => r.id.startsWith('sys:overpass')).map((r) => r.lines[0].text).join('\n');
      for (const re of expected) assert.match(text, re);
      assert.equal(ctl.roster()?.overpass?.effective, false, 'an invalid config is never effective');
    } finally {
      ctl.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});
