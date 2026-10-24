import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { MAINTENANCE_WORKER_CLAUDE_EFFORT, MAINTENANCE_WORKER_CLAUDE_MODEL } from '@sterling/schemas';
import { initialUi, buildSystemTab, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type OverpassView, type UiState, type UiEvent, type Effect } from '../state.js';
import { openDashboard } from '../controller.js';

// ===========================================================================
// The Maintenance worker row (board c97ddc97, user-ruled 2026-10-23, "Row + its
// own Overpass tier"): the last model row, after the config.models rows. Overpass
// off: its model is maintenance_worker.opencode_model, 'not set: worker will not
// start' when empty, with the claude CLI model shown beneath; ENTER opens a model
// picker that commits a worker_model effect. Overpass on: its tier (role
// 'maintenance-worker', default agentic-auto since 2026-10-23, agentic-high before), edited like the other roles.
// ===========================================================================

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, tab: SYSTEM_TAB, ...over });
const key = (name: string): UiEvent => ({ kind: 'key', name }) as UiEvent;
const view = (over: Partial<OverpassView> = {}): OverpassView => ({ enabled: false, provider: 'overpass', conductorBypass: false, effective: false, ...over });
const on = (roles?: OverpassView['roles']): OverpassView => view({ enabled: true, effective: true, ...(roles ? { roles } : {}) });

const CATALOG = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', status: 'active', vendor: 'anthropic' },
  { id: 'gpt-6.1-sol', label: 'Sol 6.1', tier: 'sol', status: 'active', vendor: 'openai' },
];

function snapshot(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [{ name: 'implementor', installedModel: 'claude-sonnet-5-5', installedEffort: 'high' }],
    configModels: { implementor: { model: 'claude-sonnet-5-5', effort: 'high' } },
    catalog: { present: true, stale: false, staleDate: null, entries: CATALOG },
    codexWired: true,
    sparringPartner: { enabled: true },
    tdd: { enabled: true },
    mode: 'work',
    host: 'opencode',
    ...over,
  } as AgentRosterSnapshot;
}

const WORKER_CURSOR = 1; // after the one config.models row
const workerRow = (snap: AgentRosterSnapshot, ui: UiState = st()) => buildSystemTab(snap, ui, 120).rows.find((r) => r.key === 'maintenance-worker')!;
const texts = (snap: AgentRosterSnapshot, ui: UiState = st()) => workerRow(snap, ui).lines.map((l) => l.text);

function drive(snap: AgentRosterSnapshot, ui: UiState, names: string[]): { ui: UiState; effects: Effect[] } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-worker-row-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const effects: Effect[] = [];
    for (const name of names) {
      const r = reduce(store, ui, key(name), undefined, undefined, snap);
      ui = r.ui;
      effects.push(...r.effects);
    }
    return { ui, effects };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('worker row, Overpass off, no model: reads "not set: worker will not start" and names the claude CLI model', () => {
  assert.deepEqual(texts(snapshot()), [
    '  Maintenance worker: not set: worker will not start',
    `    claude CLI, when on PATH: ${MAINTENANCE_WORKER_CLAUDE_MODEL} ${MAINTENANCE_WORKER_CLAUDE_EFFORT}`,
  ]);
  assert.equal(workerRow(snapshot()).agents?.length, 0, 'no agent governs it');
});

test('worker row, Overpass off, model set: the title shows maintenance_worker.opencode_model; a non-string value reads invalid', () => {
  assert.equal(texts(snapshot({ maintenanceWorker: { opencodeModel: 'openai/gpt-6.1-sol' } }))[0], '  Maintenance worker: openai/gpt-6.1-sol');
  assert.equal(texts(snapshot({ maintenanceWorker: { opencodeModel: null, invalid: '5' } }))[0], '  Maintenance worker: invalid 5');
  assert.equal(texts(snapshot(), st({ cursor: WORKER_CURSOR }))[0].startsWith('› '), true, 'the cursor marker lands on it');
});

// Changed 2026-10-24 (ruled option a): the worker now has a default effort, high, sent through its child's
// environment, so its Overpass title shows 'high (default)'.
test('worker row, Overpass on: its tier with (Overpass) and effort, the saved model dimmed as saved OpenCode, no claude CLI line', () => {
  assert.deepEqual(texts(snapshot({ overpass: on() })), ['  Maintenance worker: agentic-auto (Overpass) high (default)']);
  const set = snapshot({ overpass: on({ 'maintenance-worker': { tier: 'agentic-premium', effort: 'high' } }), maintenanceWorker: { opencodeModel: 'openai/gpt-6.1-sol' } });
  assert.deepEqual(texts(set), ['  Maintenance worker: agentic-premium (Overpass) high', '    saved OpenCode: openai/gpt-6.1-sol']);
  assert.equal(workerRow(set).lines[1].kind, 'meta', 'dimmed like the saved line');
});

test('worker row, Overpass on: ENTER opens the tier picker, the effort picker follows, and the commit is one overpass_role effect for maintenance-worker', () => {
  const snap = snapshot({ overpass: on() });
  const opened = drive(snap, st({ cursor: WORKER_CURSOR }), ['ENTER']);
  assert.deepEqual(opened.ui.selector, { key: 'maintenance-worker', stage: 'tier', highlight: 3 });
  const lines = texts(snap, opened.ui);
  assert.ok(lines.some((l) => l.includes('tier agentic-premium-max')), lines.join('\n'));
  // tiers listed: low, high, conductor, auto, premium, premium-max; highlight starts on auto, one DOWN reaches premium; efforts: default, low, medium, high
  const done = drive(snap, st({ cursor: WORKER_CURSOR }), ['ENTER', 'DOWN', 'ENTER', 'DOWN', 'DOWN', 'DOWN', 'ENTER']);
  assert.deepEqual(done.effects, [{ type: 'overpass_role', role: 'maintenance-worker', tier: 'agentic-premium', effort: 'high' }]);
});

test('worker row, Overpass off: ENTER opens a model picker of OpenCode references; picking commits a worker_model effect and nothing else', () => {
  const snap = snapshot();
  const opened = drive(snap, st({ cursor: WORKER_CURSOR }), ['ENTER']);
  assert.deepEqual(opened.ui.selector, { key: 'maintenance-worker', stage: 'model', highlight: 0 });
  assert.deepEqual(texts(snap, opened.ui).slice(2), ['  › anthropic/claude-opus-5-5 Opus 5.5', '    openai/gpt-6.1-sol Sol 6.1']);
  const picked = drive(snap, st({ cursor: WORKER_CURSOR }), ['ENTER', 'DOWN', 'ENTER']);
  assert.deepEqual(picked.effects, [{ type: 'worker_model', from: undefined, to: 'openai/gpt-6.1-sol' }]);
  assert.equal(picked.ui.selector, undefined);
});

test('worker row, Overpass off, model set: the picker ends with a clear option that emits worker_model with no `to`', () => {
  const snap = snapshot({ maintenanceWorker: { opencodeModel: 'openai/gpt-6.1-sol' } });
  const cleared = drive(snap, st({ cursor: WORKER_CURSOR }), ['ENTER', 'END', 'ENTER']);
  assert.deepEqual(cleared.effects, [{ type: 'worker_model', from: 'openai/gpt-6.1-sol', to: undefined }]);
});

test('worker row, Overpass on: an open model picker is refused with a notice and no effect', () => {
  const snap = snapshot({ overpass: on() });
  const r = drive(snap, st({ cursor: WORKER_CURSOR, selector: { key: 'maintenance-worker', stage: 'model', highlight: 0 } }), ['ENTER']);
  assert.deepEqual(r.effects, []);
  assert.match(r.ui.notice ?? '', /Overpass is on/);
});

test('worker row: it shifts every row after it by one, and an empty catalog with no saved model opens no picker', () => {
  const snap = snapshot({ catalog: { present: true, stale: false, staleDate: null, entries: [] } });
  const r = drive(snap, st({ cursor: WORKER_CURSOR }), ['ENTER']);
  assert.equal(r.ui.selector, undefined);
  assert.match(r.ui.notice ?? '', /model catalog empty or invalid/);
  const v = buildSystemTab(snapshot(), st(), 120);
  assert.equal(v.sparringRows[0].lines[0].text.startsWith('  Sparring partner'), true);
  const sparring = drive(snapshot(), st({ cursor: WORKER_CURSOR + 1 }), ['ENTER']);
  assert.deepEqual(sparring.effects.map((e) => e.type), ['sparring_toggle'], 'the first row after the worker is the sparring toggle');
});

// --- controller write-back ----------------------------------------------------

const VP = { width: 100, maxBodyLines: 60, showBanner: false };

async function withConfig(config: unknown, body: (ctl: ReturnType<typeof openDashboard>, configPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-worker-row-wb-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config, null, 2) + '\n');
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'), { host: 'opencode' });
  try {
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    await body(ctl, configPath);
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('controller: the roster reads maintenance_worker.opencode_model (set, unset, not a string)', async () => {
  await withConfig({ maintenance_worker: { enabled: true, opencode_model: 'openai/gpt-6.1-sol' } }, async (ctl) => {
    assert.deepEqual(ctl.roster()?.maintenanceWorker, { opencodeModel: 'openai/gpt-6.1-sol' });
  });
  await withConfig({}, async (ctl) => {
    assert.deepEqual(ctl.roster()?.maintenanceWorker, { opencodeModel: null });
  });
  await withConfig({ maintenance_worker: { opencode_model: 5 } }, async (ctl) => {
    assert.deepEqual(ctl.roster()?.maintenanceWorker, { opencodeModel: null, invalid: '5' });
  });
});

test('controller: a worker_model effect sets then clears maintenance_worker.opencode_model, keeping enabled and every other key', async () => {
  await withConfig({ mode: 'hobby', maintenance_worker: { enabled: false } }, async (ctl, configPath) => {
    await ctl.applyEffects([{ type: 'worker_model', to: 'openai/gpt-6.1-sol' }]);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { mode: 'hobby', maintenance_worker: { enabled: false, opencode_model: 'openai/gpt-6.1-sol' } });
    assert.deepEqual(ctl.roster()?.maintenanceWorker, { opencodeModel: 'openai/gpt-6.1-sol' }, 'the roster is refreshed');
    await ctl.applyEffects([{ type: 'worker_model', from: 'openai/gpt-6.1-sol' }]);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { mode: 'hobby', maintenance_worker: { enabled: false } });
  });
});

test('controller: a worker_model effect with a value that is not provider/model writes nothing', async () => {
  await withConfig({ maintenance_worker: { enabled: true } }, async (ctl, configPath) => {
    const before = readFileSync(configPath, 'utf8');
    await ctl.applyEffects([{ type: 'worker_model', to: 'not a model' }]);
    assert.equal(readFileSync(configPath, 'utf8'), before);
    assert.match(ctl.ui().notice ?? '', /Maintenance worker model not changed — 'not a model' is not a <provider>\/<model> id/);
  });
});

// Sol review (MEDIUM): an unreadable or non-object config is not "model unset"
// (anti-pattern config-derived-posture-line-collapses-absent-into-unusable).
test('controller: an unreadable or non-object config reads as unreadable, never as not set; a blank or non-string model reads as invalid', async () => {
  // openDashboard itself refuses a config that is malformed when it opens, so the config is damaged
  // after the dashboard is open and the roster is reloaded by leaving the System tab and returning.
  const unreadableOf = async (config: unknown) => {
    let seen: AgentRosterSnapshot['maintenanceWorker'];
    await withConfig({}, async (ctl, configPath) => {
      writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config));
      await ctl.handle({ kind: 'tab', index: 0 }, VP);
      await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
      seen = ctl.roster()?.maintenanceWorker;
    });
    return seen;
  };
  const malformed = await unreadableOf('{ not json');
  assert.equal(malformed?.opencodeModel, null);
  assert.match(malformed?.unreadable ?? '', /JSON/i, 'malformed JSON names the parse failure');
  for (const [text, reason] of [['[]', 'config.json holds [], not an object'], ['5', 'config.json holds 5, not an object'], ['false', 'config.json holds false, not an object'], ['null', 'config.json holds null, not an object']] as const) {
    assert.deepEqual(await unreadableOf(text), { opencodeModel: null, unreadable: reason }, text);
  }
  assert.deepEqual(await unreadableOf({ maintenance_worker: 5 }), { opencodeModel: null, unreadable: 'maintenance_worker is 5, not an object' });
  assert.deepEqual(await unreadableOf({ maintenance_worker: null }), { opencodeModel: null, unreadable: 'maintenance_worker is null, not an object' });
  assert.deepEqual(await unreadableOf({ maintenance_worker: [] }), { opencodeModel: null, unreadable: 'maintenance_worker is [], not an object' });
  assert.deepEqual(await unreadableOf({ maintenance_worker: { opencode_model: '' } }), { opencodeModel: null, invalid: '""' }, 'the worker refuses a blank model, so it is not "unset"');
  assert.deepEqual(await unreadableOf({ maintenance_worker: { opencode_model: ['x'] } }), { opencodeModel: null, invalid: '["x"]' });
  assert.deepEqual(await unreadableOf({ maintenance_worker: { enabled: true } }), { opencodeModel: null }, 'absent really is unset');
  assert.deepEqual(await unreadableOf({}), { opencodeModel: null });
});

// Changed 2026-10-24 (ruled option a): the worker now has a default effort, high, sent through its child's
// environment, so its Overpass title shows 'high (default)'.
test('worker row: an unreadable config renders as config unreadable (no "not set", no claude CLI claim); Overpass on keeps the tier and adds the problem; the model picker will not open', () => {
  const unreadable = { opencodeModel: null, unreadable: 'maintenance_worker is 5, not an object' };
  const off = texts(snapshot({ maintenanceWorker: unreadable }));
  assert.deepEqual(off, ['  Maintenance worker: config unreadable: maintenance_worker is 5, not an object']);
  assert.ok(!off.join('\n').includes('not set'));
  assert.deepEqual(texts(snapshot({ overpass: on(), maintenanceWorker: unreadable })), ['  Maintenance worker: agentic-auto (Overpass) high (default)', '    maintenance_worker unreadable: maintenance_worker is 5, not an object']);
  const r = drive(snapshot({ maintenanceWorker: unreadable }), st({ cursor: WORKER_CURSOR }), ['ENTER']);
  assert.equal(r.ui.selector, undefined);
  assert.deepEqual(r.effects, []);
  assert.match(r.ui.notice ?? '', /Maintenance worker model not editable: config unreadable: maintenance_worker is 5/);
});

test('worker row: a blank or non-string model reads invalid, not not set', () => {
  assert.equal(texts(snapshot({ maintenanceWorker: { opencodeModel: null, invalid: '""' } }))[0], '  Maintenance worker: invalid ""');
});
