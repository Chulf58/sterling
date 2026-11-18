import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import {
  buildSystemTab, initialUi, reduce, SYSTEM_TAB,
  type AgentRosterSnapshot, type CatalogEntry, type Effect, type OpenCodeModelEffect, type AgyModelEffect, type UiEvent, type UiState,
} from '../state.js';

// The System tab's OpenCode-only model override (decision
// opencode-only-model-override-per-role-for-openai-picks): a Claude entry swaps
// config.models as before; an OpenAI entry is accepted only as the role's
// OpenCode override, and a set override can be cleared from the same picker.

const CATALOG: CatalogEntry[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', status: 'active', vendor: 'anthropic' },
  { id: 'gpt-5.6-terra', label: 'Terra', tier: 'gpt', status: 'active', vendor: 'openai' },
];

function snapshot(implementor: AgentRosterSnapshot['configModels'][string] = { model: 'claude-sonnet-5-5', effort: 'high' }): AgentRosterSnapshot {
  return {
    agents: [{ name: 'implementor', installedModel: implementor.model, installedEffort: implementor.effort }],
    // implementor is installed in the Claude, OpenCode and agy folders; scout is listed through `hostInstalled`
    // but is in neither the OpenCode nor the agy list unless a test adds it (overrides are validated per host)
    hostInstalled: ['scout'],
    opencodeInstalled: ['implementor'],
    agyInstalled: ['implementor'],
    // cursor 0 = implementor (governs the implementor agent), 1 = scout (a config key whose agent is not installed here)
    configModels: { implementor, scout: { model: 'claude-sonnet-5-5', effort: 'low' } },
    catalog: { present: true, stale: false, staleDate: null, entries: CATALOG },
  };
}

function drive(roster: AgentRosterSnapshot, cursor: number, names: string[]): { ui: UiState; effects: Effect[] } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-model-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    let ui: UiState = { ...initialUi, tab: SYSTEM_TAB, cursor };
    const effects: Effect[] = [];
    for (const name of names) {
      const r = reduce(store, ui, { kind: 'key', name } as UiEvent, undefined, undefined, roster);
      ui = r.ui;
      effects.push(...r.effects);
    }
    return { ui, effects };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const overrideOf = (effects: Effect[]) => effects.find((e): e is OpenCodeModelEffect => e.type === 'opencode_model');

test('an OpenAI pick commits as the OpenCode override only: no model_swap, no effort stage', () => {
  const r = drive(snapshot(), 0, ['ENTER', 'DOWN', 'ENTER']);
  assert.equal(r.effects.some((e) => e.type === 'model_swap'), false, 'config.models model is not swapped');
  assert.deepEqual(overrideOf(r.effects), {
    type: 'opencode_model', key: 'implementor', from: undefined, to: 'openai/gpt-5.6-terra',
    model: 'claude-sonnet-5-5', effort: 'high', agents: ['implementor'],
  });
  assert.equal(r.ui.selector, undefined, 'the picker closed on the pick');
});

test('a Claude pick still walks model then effort and emits a model_swap, not an override', () => {
  const r = drive(snapshot(), 0, ['ENTER', 'ENTER', 'ENTER']);
  assert.equal(overrideOf(r.effects), undefined);
  const swap = r.effects.find((e) => e.type === 'model_swap');
  assert.ok(swap && swap.type === 'model_swap');
  assert.equal(swap.to.model, 'claude-opus-5-5');
});

test('an OpenAI pick on a key with no OpenCode agent installed is refused with a notice', () => {
  const r = drive(snapshot(), 1, ['ENTER', 'DOWN', 'ENTER']);
  assert.equal(r.effects.length, 0);
  assert.match(r.ui.notice ?? '', /OpenCode model refused: 'scout' has no OpenCode agent installed/);
});

test('the row shows a set override; the picker marks OpenAI entries OpenCode-only and offers a clear option', () => {
  const roster = snapshot({ model: 'claude-sonnet-5-5', effort: 'high', opencode_model: 'openai/gpt-5.6-terra' });
  const plain = buildSystemTab(roster, { ...initialUi, tab: SYSTEM_TAB, cursor: 0 });
  const row = plain.rows.find((r) => r.key === 'implementor')!;
  assert.ok(row.lines.some((l) => l.text === '    OpenCode: openai/gpt-5.6-terra'), JSON.stringify(row.lines));
  assert.match(row.lines[0].text, /claude-sonnet-5-5 high/, 'the title line keeps the Claude model');

  const open = drive(roster, 0, ['ENTER']);
  const options = buildSystemTab(roster, open.ui).rows[0].lines.filter((l) => l.kind === 'option').map((l) => l.text.trim());
  assert.deepEqual(options, [
    '› claude-opus-5-5 Opus 5.5',
    'openai/gpt-5.6-terra Terra (OpenCode only)',
    'OpenCode: use the Claude model',
  ]);

  // DOWN reaches the clear option (the last), and ENTER clears the override
  const cleared = drive(roster, 0, ['ENTER', 'DOWN', 'DOWN', 'DOWN', 'ENTER']);
  assert.deepEqual(overrideOf(cleared.effects), {
    type: 'opencode_model', key: 'implementor', from: 'openai/gpt-5.6-terra', to: undefined,
    model: 'claude-sonnet-5-5', effort: 'high', agents: ['implementor'],
  });
});

test('without an override the picker offers no clear option', () => {
  const r = drive(snapshot(), 0, ['ENTER', 'DOWN', 'DOWN', 'DOWN']);
  assert.equal(r.ui.selector?.highlight, 1, 'DOWN stops on the last catalog entry');
});

test('END in the model picker reaches the clear option when an override is set', () => {
  const r = drive(snapshot({ model: 'claude-sonnet-5-5', effort: 'high', opencode_model: 'openai/gpt-5.6-terra' }), 0, ['ENTER', 'END', 'ENTER']);
  assert.equal(overrideOf(r.effects)?.to, undefined, 'the last option clears the override');
  assert.equal(overrideOf(r.effects)?.from, 'openai/gpt-5.6-terra');
});

// The System tab's Antigravity-only model override (GitHub issue #306): with agy
// installed the picker offers every agy id after the catalog; a pick commits at
// once as an agy_model effect, and a set override adds a clear option.
const agyOf = (effects: Effect[]) => effects.find((e): e is AgyModelEffect => e.type === 'agy_model');

test('an agy pick sets agy_model only: no model_swap, no opencode_model, no effort stage', () => {
  const roster = { ...snapshot(), agy: true };
  // entries: 0 opus, 1 terra; agy ids start at 2
  const r = drive(roster, 0, ['ENTER', 'DOWN', 'DOWN', 'ENTER']);
  assert.equal(r.effects.some((e) => e.type === 'model_swap' || e.type === 'opencode_model'), false);
  assert.deepEqual(agyOf(r.effects), { type: 'agy_model', key: 'implementor', from: undefined, to: 'inherit', model: 'claude-sonnet-5-5', effort: 'high' });
  assert.equal(r.ui.selector, undefined);
});

test('a set agy_model shows on the row and END reaches the clear option, which clears it', () => {
  const roster = { ...snapshot({ model: 'claude-sonnet-5-5', effort: 'high', agy_model: 'flash' }), agy: true };
  const row = buildSystemTab(roster, { ...initialUi, tab: SYSTEM_TAB, cursor: 0 }).rows.find((x) => x.key === 'implementor')!;
  assert.ok(row.lines.some((l) => l.text === '    Antigravity: flash'), JSON.stringify(row.lines));
  const r = drive(roster, 0, ['ENTER', 'END', 'ENTER']);
  assert.deepEqual(agyOf(r.effects), { type: 'agy_model', key: 'implementor', from: 'flash', to: undefined, model: 'claude-sonnet-5-5', effort: 'high' });
});

test('without agy installed and no override the picker offers no agy ids', () => {
  const r = drive(snapshot(), 0, ['ENTER', 'END', 'ENTER']);
  assert.equal(agyOf(r.effects), undefined);
});

test('an agy pick on a key with no agy agent installed is refused with a notice', () => {
  const r = drive({ ...snapshot(), agy: true }, 1, ['ENTER', 'DOWN', 'DOWN', 'ENTER']);
  assert.equal(r.effects.length, 0);
  assert.match(r.ui.notice ?? '', /Antigravity model refused: 'scout' has no agy agent installed/);
});

// Review fix (issue #307): an override is validated against the hosts it governs, not against the
// Claude install. The two refusal tests above now name the host; these two prove a role installed in
// only one non-Claude host accepts that host's override and refuses the other's.
test('a role installed only in agy (no Claude agent) accepts an agy pick and refuses an OpenCode pick', () => {
  const roster = { ...snapshot(), agy: true, agyInstalled: ['implementor', 'scout'] };
  const agy = drive(roster, 1, ['ENTER', 'DOWN', 'DOWN', 'ENTER']);
  assert.deepEqual(agyOf(agy.effects), { type: 'agy_model', key: 'scout', from: undefined, to: 'inherit', model: 'claude-sonnet-5-5', effort: 'low' });
  const oc = drive(roster, 1, ['ENTER', 'DOWN', 'ENTER']);
  assert.equal(oc.effects.length, 0);
  assert.match(oc.ui.notice ?? '', /OpenCode model refused: 'scout' has no OpenCode agent installed/);
});

test('a role installed only in the OpenCode folder (no Claude agent) accepts an OpenCode pick for that agent and refuses an agy pick', () => {
  const roster = { ...snapshot(), agy: true, opencodeInstalled: ['implementor', 'scout'] };
  const oc = drive(roster, 1, ['ENTER', 'DOWN', 'ENTER']);
  assert.deepEqual(overrideOf(oc.effects), { type: 'opencode_model', key: 'scout', from: undefined, to: 'openai/gpt-5.6-terra', model: 'claude-sonnet-5-5', effort: 'low', agents: ['scout'] });
  const agy = drive(roster, 1, ['ENTER', 'DOWN', 'DOWN', 'ENTER']);
  assert.equal(agy.effects.length, 0);
  assert.match(agy.ui.notice ?? '', /Antigravity model refused: 'scout' has no agy agent installed/);
});

// Review fix: the picker opens when the catalog is empty but agy options or a clear option exist.
test('with an empty catalog the picker still opens when agy is installed, and a saved agy override can be cleared', () => {
  const empty = { present: true, stale: false, staleDate: null, entries: [] as CatalogEntry[] };
  const roster = { ...snapshot({ model: 'claude-sonnet-5-5', effort: 'high', agy_model: 'flash' }), agy: true, catalog: empty };
  const open = drive(roster, 0, ['ENTER']);
  assert.equal(open.ui.selector?.stage, 'model', 'the picker opened');
  const cleared = drive(roster, 0, ['ENTER', 'END', 'ENTER']);
  assert.equal(agyOf(cleared.effects)?.to, undefined);
  assert.equal(agyOf(cleared.effects)?.from, 'flash');
  const none = drive({ ...snapshot(), catalog: empty }, 0, ['ENTER']);
  assert.match(none.ui.notice ?? '', /model catalog empty/, 'no agy, no override, no catalog: still refused');
});
