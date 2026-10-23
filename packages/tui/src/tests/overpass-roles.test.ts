import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { initialUi, buildSystemTab, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type OverpassView, type UiState, type UiEvent } from '../state.js';
import { applyOverpassRole } from '../config-writeback.js';
import { openDashboard } from '../controller.js';

// ===========================================================================
// Agent rows with Overpass effective (decision
// system-tab-agent-catalog-with-overpass-on-each-row-shows-the, board 8cee0260):
//   • effective → '<Label>: <tier> (Overpass)[ <effort>]' plus a dimmed
//     'saved: <model> <effort>' line; the tier is config.overpass.roles over the
//     per-role defaults (DEFAULT_OVERPASS_ROLE_TIERS).
//   • ENTER on the row opens a tier picker, then an effort picker ('default'
//     clears), and commits ONE overpass_role effect: no model_swap, no
//     opencode_model.
//   • a model/effort picker never opens on a role row while effective; one that
//     is already open is refused with a notice.
//   • not effective → the rows are exactly the pre-Overpass rows.
//   • applyOverpassRole writes config.overpass.roles.<role> only.
// ===========================================================================

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, tab: SYSTEM_TAB, ...over });
const key = (name: string): UiEvent => ({ kind: 'key', name }) as UiEvent;

function snapshot(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [
      { name: 'implementor', installedModel: 'claude-opus-5-5', installedEffort: 'medium' },
      { name: 'scout', installedModel: 'claude-sonnet-5', installedEffort: 'low' },
      { name: 'sparring', installedModel: 'claude-fable-5-1', installedEffort: 'high' },
    ],
    configModels: {
      implementor: { model: 'claude-opus-5-5', effort: 'medium', opencode_model: 'openai/gpt-6-terra' },
      scout: { model: 'claude-sonnet-5', effort: 'low' },
      sparring: { model: 'claude-fable-5-1', effort: 'high' },
      classifiers: { model: 'claude-haiku-5', effort: 'low' },
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
const on = (roles?: OverpassView['roles']): OverpassView => view({ enabled: true, effective: true, ...(roles ? { roles } : {}) });

const rowTexts = (snap: AgentRosterSnapshot, ui: UiState = st()): string[] =>
  buildSystemTab(snap, ui, 120).rows.flatMap((r) => r.lines.map((l) => l.text));

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-roles-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const OFF_ROWS = [
  '› Implementor: claude-opus-5-5 medium',
  '    implementor',
  '    OpenCode: openai/gpt-6-terra',
  '  Scout: claude-sonnet-5 low',
  '    scout',
  '  Sparring: claude-fable-5-1 high',
  '    sparring',
  '  Classifiers: claude-haiku-5 low',
];

test('Overpass off: the agent rows are exactly the pre-Overpass rows, whatever the view carries', () => {
  assert.deepEqual(rowTexts(snapshot()), OFF_ROWS);
  assert.deepEqual(rowTexts(snapshot({ overpass: view({ enabled: true, effective: false, roles: { implementor: { tier: 'agentic-high' } } }) })), OFF_ROWS);
  assert.deepEqual(rowTexts(snapshot({ mode: 'hobby', overpass: on() })), OFF_ROWS, 'hobby mode');
  assert.deepEqual(rowTexts(snapshot({ host: undefined, overpass: on() })), OFF_ROWS, 'not the OpenCode host');
});

test('Overpass on: each role row reads its tier with (Overpass), the saved model dimmed beneath; defaults show without a roles block', () => {
  const rows = rowTexts(snapshot({ overpass: on() }));
  assert.deepEqual(rows, [
    '› Implementor: agentic-premium (Overpass)',
    '    saved: claude-opus-5-5 medium',
    '    implementor',
    '    OpenCode: openai/gpt-6-terra (inactive: Overpass)',
    '  Scout: agentic-high (Overpass)',
    '    saved: claude-sonnet-5 low',
    '    scout',
    '  Sparring: agentic-premium-max (Overpass)',
    '    saved: claude-fable-5-1 high',
    '    sparring',
    '  Classifiers: claude-haiku-5 low',
  ]);
  const saved = buildSystemTab(snapshot({ overpass: on() }), st(), 120).rows[0].lines[1];
  assert.equal(saved.kind, 'meta', 'the saved line is the dimmed kind');
});

test('Overpass on: a configured tier and effort show on the row', () => {
  const rows = rowTexts(snapshot({ overpass: on({ implementor: { tier: 'agentic-premium-max', effort: 'high' }, scout: { tier: 'agentic-lite' } }) }));
  assert.equal(rows[0], '› Implementor: agentic-premium-max (Overpass) high');
  assert.ok(rows.includes('  Scout: agentic-lite (Overpass)'));
});

test('Overpass on: the saved line is the configured model and effort; a drifted installed copy adds only the drift marker', () => {
  const clean = rowTexts(snapshot({ overpass: on() }))[1];
  assert.equal(clean, '    saved: claude-opus-5-5 medium');
  const drifted = snapshot({ overpass: on(), agents: [{ name: 'implementor', installedModel: 'claude-old', installedEffort: 'low' }, { name: 'scout', installedModel: 'claude-sonnet-5', installedEffort: 'low' }] });
  const rows = rowTexts(drifted);
  assert.equal(rows[1], '    saved: claude-opus-5-5 medium  drift', 'the config.models value shows, never the installed one');
  assert.ok(!rows.some((r) => r.includes('claude-old')), 'the installed model is not shown anywhere on the row');
  assert.equal(rows.find((r) => r.includes('saved: claude-sonnet-5')), '    saved: claude-sonnet-5 low', 'an undrifted role has no marker');
});

test('tier and effort edit: ENTER, pick a tier, pick an effort commits ONE overpass_role effect and nothing else', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ overpass: on() });
    const r1 = reduce(store, st({ cursor: 0 }), key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(r1.ui.selector, { key: 'implementor', stage: 'tier', highlight: 1 }, 'the picker opens on the current tier agentic-premium');
    assert.deepEqual(r1.effects, []);
    const options = buildSystemTab(snap, r1.ui, 120).rows[0].lines.filter((l) => l.kind === 'option').map((l) => l.text.trim());
    assert.deepEqual(options, ['tier agentic-high', '› tier agentic-premium', 'tier agentic-premium-max']);
    const r2 = reduce(store, r1.ui, key('DOWN'), undefined, undefined, snap);
    const r3 = reduce(store, r2.ui, key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(r3.ui.selector, { key: 'implementor', stage: 'role_effort', highlight: 0, tier: 'agentic-premium-max' });
    const efforts = buildSystemTab(snap, r3.ui, 120).rows[0].lines.filter((l) => l.kind === 'option').map((l) => l.text.replace('›', '').trim());
    assert.deepEqual(efforts, ['effort default', 'effort low', 'effort medium', 'effort high', 'effort xhigh', 'effort max']);
    let ui = r3.ui;
    for (let i = 0; i < 3; i++) ui = reduce(store, ui, key('DOWN'), undefined, undefined, snap).ui;
    const r4 = reduce(store, ui, key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(r4.effects, [{ type: 'overpass_role', role: 'implementor', tier: 'agentic-premium-max', effort: 'high' }]);
    assert.equal(r4.ui.selector, undefined);
  } finally {
    cleanup();
  }
});

test("tier and effort edit: 'default' commits no effort, and a custom current tier stays an option", () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ overpass: on({ scout: { tier: 'agentic-lite', effort: 'low' } }) });
    const open = reduce(store, st({ cursor: 1 }), key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(open.ui.selector, { key: 'scout', stage: 'tier', highlight: 3 }, 'agentic-lite is offered, after the named tiers, and preselected');
    const efforts = reduce(store, open.ui, key('ENTER'), undefined, undefined, snap);
    assert.equal(efforts.ui.selector?.highlight, 1, 'the effort picker opens on the current effort');
    const cleared = reduce(store, { ...efforts.ui, selector: { ...efforts.ui.selector!, highlight: 0 } }, key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(cleared.effects, [{ type: 'overpass_role', role: 'scout', tier: 'agentic-lite' }]);
  } finally {
    cleanup();
  }
});

test('tier and effort edit: ESCAPE cancels at either stage with no effect', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ overpass: on() });
    const tier = reduce(store, st({ cursor: 0 }), key('ENTER'), undefined, undefined, snap);
    const esc1 = reduce(store, tier.ui, key('ESCAPE'), undefined, undefined, snap);
    assert.equal(esc1.ui.selector, undefined);
    assert.equal(esc1.ui.notice, undefined);
    const effort = reduce(store, tier.ui, key('ENTER'), undefined, undefined, snap);
    const esc2 = reduce(store, effort.ui, key('ESCAPE'), undefined, undefined, snap);
    assert.deepEqual([esc1.effects, esc2.effects, esc2.ui.selector], [[], [], undefined]);
  } finally {
    cleanup();
  }
});

test('refusal: no model picker opens on a role row while Overpass is effective, and an open one is refused with a notice', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ overpass: on() });
    for (const cursor of [0, 1, 2]) {
      const opened = reduce(store, st({ cursor }), key('ENTER'), undefined, undefined, snap);
      assert.equal(opened.ui.selector?.stage, 'tier', `cursor ${cursor}`);
    }
    for (const stage of ['model', 'effort'] as const) {
      const r = reduce(store, st({ cursor: 0, selector: { key: 'implementor', stage, highlight: 0, model: 'claude-opus-5-5' } }), key('ENTER'), undefined, undefined, snap);
      assert.deepEqual(r.effects, [], `${stage} stage emits nothing`);
      assert.equal(r.ui.selector, undefined);
      assert.match(r.ui.notice ?? '', /Overpass is on/);
    }
  } finally {
    cleanup();
  }
});

test('Overpass off: ENTER on a role row opens the model picker and the swap walks as before', () => {
  const { store, cleanup } = storeFixture();
  try {
    for (const snap of [snapshot(), snapshot({ overpass: view({ enabled: true, effective: false }) })]) {
      const r = reduce(store, st({ cursor: 0 }), key('ENTER'), undefined, undefined, snap);
      assert.deepEqual(r.ui.selector, { key: 'implementor', stage: 'model', highlight: 0 });
    }
  } finally {
    cleanup();
  }
});

test('classifiers is not an Overpass role: its row and picker are unchanged while Overpass is effective', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = snapshot({ overpass: on() });
    const r = reduce(store, st({ cursor: 3 }), key('ENTER'), undefined, undefined, snap);
    assert.deepEqual(r.ui.selector, { key: 'classifiers', stage: 'model', highlight: 0 });
  } finally {
    cleanup();
  }
});

// --- write-back ---------------------------------------------------------------

function cfgFixture(config: unknown): { dir: string; cfgPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-roles-wb-'));
  mkdirSync(join(dir, '.sterling'));
  const cfgPath = join(dir, '.sterling', 'config.json');
  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n');
  return { dir, cfgPath };
}

test('config write-back: applyOverpassRole sets only overpass.roles.<role>, keeping other keys, other roles and config.models', () => {
  const models = { implementor: { model: 'claude-opus-5-5', effort: 'medium', opencode_model: 'openai/gpt-6-terra' } };
  const { dir, cfgPath } = cfgFixture({ mode: 'work', models, overpass: { enabled: true, provider: 'overpass', roles: { reviewer: { tier: 'agentic-high', effort: 'low' }, implementor: { tier: 'agentic-high' } } } });
  try {
    assert.equal(applyOverpassRole({ type: 'overpass_role', role: 'implementor', tier: 'agentic-premium-max', effort: 'high' }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')), {
      mode: 'work',
      models,
      overpass: { enabled: true, provider: 'overpass', roles: { reviewer: { tier: 'agentic-high', effort: 'low' }, implementor: { tier: 'agentic-premium-max', effort: 'high' } } },
    });
    assert.equal(applyOverpassRole({ type: 'overpass_role', role: 'implementor', tier: 'agentic-premium' }, undefined, cfgPath), true);
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf8')).overpass.roles.implementor, { tier: 'agentic-premium' }, 'no effort key after a default pick');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config write-back: applyOverpassRole creates a missing overpass or roles block and replaces one that is not an object', () => {
  for (const config of [{ mode: 'work' }, { overpass: { enabled: true } }, { overpass: 'on' }, { overpass: { roles: ['x'] } }]) {
    const { dir, cfgPath } = cfgFixture(config);
    try {
      assert.equal(applyOverpassRole({ type: 'overpass_role', role: 'scout', tier: 'agentic-high', effort: 'max' }, undefined, cfgPath), true);
      const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
      assert.deepEqual(written.overpass.roles, { scout: { tier: 'agentic-high', effort: 'max' } }, JSON.stringify(config));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('config write-back: applyOverpassRole refuses an unknown role, a bad or non-string tier or effort, and a block the resolver would throw on, and writes nothing', () => {
  const { dir, cfgPath } = cfgFixture({ overpass: { enabled: true } });
  try {
    const before = readFileSync(cfgPath, 'utf8');
    const errors: string[] = [];
    for (const e of [
      { type: 'overpass_role' as const, role: 'conductor', tier: 'agentic-high' },
      { type: 'overpass_role' as const, role: 'scout', tier: 'premium' },
      { type: 'overpass_role' as const, role: 'scout', tier: 'agentic-high', effort: 'extreme' },
      // RegExp.test would coerce this array to 'agentic-high' and let it through
      { type: 'overpass_role' as const, role: 'scout', tier: ['agentic-high'] as unknown as string },
      { type: 'overpass_role' as const, role: 'scout', tier: 'agentic-high', effort: ['high'] as unknown as string },
    ]) assert.equal(applyOverpassRole(e, (m) => errors.push(m), cfgPath), false);
    assert.equal(errors.length, 5);
    assert.match(errors[0], /Overpass role update failed — config\.overpass\.roles has the unknown role "conductor"/);
    assert.equal(readFileSync(cfgPath, 'utf8'), before);
    assert.equal(applyOverpassRole({ type: 'overpass_role', role: 'scout', tier: 'agentic-high' }, (m) => errors.push(m), join(dir, 'missing.json')), false);
    assert.match(errors[5], /Overpass role update failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config write-back: applyOverpassRole judges the whole proposed block, so an already-invalid sibling refuses the write', () => {
  const { dir, cfgPath } = cfgFixture({ overpass: { enabled: true, roles: { reviewer: { tier: 'premium' } } } });
  try {
    const before = readFileSync(cfgPath, 'utf8');
    const errors: string[] = [];
    assert.equal(applyOverpassRole({ type: 'overpass_role', role: 'scout', tier: 'agentic-high' }, (m) => errors.push(m), cfgPath), false);
    assert.match(errors[0], /config\.overpass\.roles\.reviewer\.tier/);
    assert.equal(readFileSync(cfgPath, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- through the real controller --------------------------------------------

const VP = { width: 100, maxBodyLines: 60, showBanner: false };

test('controller: Overpass on shows the tier rows from config; the picker commit writes overpass.roles only and the row updates', async () => {
  const models = { implementor: { model: 'claude-opus-5-5', effort: 'medium' } };
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-roles-ctl-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, JSON.stringify({ mode: 'work', models, overpass: { enabled: true, roles: { implementor: { effort: 'low' } } } }, null, 2) + '\n');
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'), { host: 'opencode' });
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    assert.deepEqual(ctl.roster()?.overpass?.roles?.implementor, { tier: 'agentic-premium', effort: 'low' });
    const first = (): string => ctl.state(VP).rows.find((r) => r.id === 'sys:implementor')!.lines[0].text.trim();
    assert.equal(first(), '› Implementor: agentic-premium (Overpass) low');
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    await ctl.handle({ kind: 'key', name: 'DOWN' }, VP); // tier → agentic-premium-max
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    await ctl.handle({ kind: 'key', name: 'HOME' }, VP); // effort → default
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(written.overpass, { enabled: true, roles: { implementor: { tier: 'agentic-premium-max' } } });
    assert.deepEqual(written.models, models, 'config.models is untouched');
    assert.match(ctl.ui().notice ?? '', /^Overpass tier for 'implementor' set to agentic-premium-max with no effort override/);
    assert.equal(first(), '› Implementor: agentic-premium-max (Overpass)');
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('controller: Overpass switched on between two model edits of one batch refuses the later one from the bytes it would write, config stays byte-identical', async () => {
  const models = { implementor: { model: 'claude-opus-5-5', effort: 'medium' } };
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-roles-race-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, JSON.stringify({ mode: 'work', models }, null, 2) + '\n');
  const external = JSON.stringify({ mode: 'work', models, overpass: { enabled: true } }, null, 2) + '\n';
  // Overpass goes on in the window of the first write (after its read, before its rename).
  // The batch started with Overpass off, so only a read made for the second edit sees it.
  let fired = false;
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'), {
    host: 'opencode',
    configWriteFs: { beforeRename: () => { if (!fired) { fired = true; writeFileSync(configPath, external); } } },
  });
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    assert.equal(ctl.roster()?.overpass?.effective, false, 'Overpass is off when the batch starts');
    await ctl.applyEffects([
      { type: 'model_swap', key: 'implementor', from: { model: 'claude-opus-5-5', effort: 'medium' }, to: { model: 'claude-sonnet-5', effort: 'high' }, agents: [], decisionTitle: 't' },
      { type: 'opencode_model', key: 'implementor', to: 'openai/gpt-6-terra', model: 'claude-opus-5-5', effort: 'medium', agents: [] },
    ]);
    assert.equal(fired, true, 'the interleaving ran');
    assert.equal(readFileSync(configPath, 'utf8'), external, 'config.json is byte-identical to what the other writer left');
    assert.match(ctl.ui().notice ?? '', /^Overpass is on — .*Nothing was written\./);
    assert.equal(ctl.roster()?.overpass?.effective, true, 'the roster is refreshed');
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('controller: Overpass switched on since the roster loaded refuses a model swap and an OpenCode override on a role, writes nothing and refreshes the roster', async () => {
  const models = { implementor: { model: 'claude-opus-5-5', effort: 'medium' }, classifiers: { model: 'claude-haiku-5', effort: 'low' } };
  const dir = mkdtempSync(join(tmpdir(), 'sterling-overpass-roles-stale-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, JSON.stringify({ mode: 'work', models }, null, 2) + '\n');
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'), { host: 'opencode' });
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    assert.equal(ctl.roster()?.overpass?.effective, false, 'the roster the picker opened on has Overpass off');
    // another session switches Overpass on while the picker is open
    const external = JSON.stringify({ mode: 'work', models, overpass: { enabled: true } }, null, 2) + '\n';
    writeFileSync(configPath, external);
    await ctl.applyEffects([
      { type: 'model_swap', key: 'implementor', from: { model: 'claude-opus-5-5', effort: 'medium' }, to: { model: 'claude-sonnet-5', effort: 'high' }, agents: ['implementor'], decisionTitle: 't' },
      { type: 'opencode_model', key: 'implementor', to: 'openai/gpt-6-terra', model: 'claude-opus-5-5', effort: 'medium', agents: ['implementor'] },
    ]);
    assert.equal(readFileSync(configPath, 'utf8'), external, 'config.json is byte-identical');
    assert.match(ctl.ui().notice ?? '', /^Overpass is on — .*Nothing was written\./);
    assert.equal(ctl.roster()?.overpass?.effective, true, 'the roster is refreshed');
    // classifiers is not an Overpass role: its swap is not refused by this check
    await ctl.applyEffects([
      { type: 'model_swap', key: 'classifiers', from: { model: 'claude-haiku-5', effort: 'low' }, to: { model: 'claude-haiku-5-1', effort: 'low' }, agents: [], decisionTitle: 't' },
    ]);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).models.classifiers.model, 'claude-haiku-5-1');
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
