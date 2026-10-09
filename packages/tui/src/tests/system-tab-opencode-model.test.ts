import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import {
  buildSystemTab, initialUi, reduce, SYSTEM_TAB,
  type AgentRosterSnapshot, type CatalogEntry, type Effect, type OpenCodeModelEffect, type UiEvent, type UiState,
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
    // cursor 0 = implementor (governs the implementor agent), 1 = classifiers (no agent)
    configModels: { implementor, classifiers: { model: 'claude-haiku-4-5', effort: 'low' } },
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

test('an OpenAI pick on a key with no agent is refused with a notice', () => {
  const r = drive(snapshot(), 1, ['ENTER', 'DOWN', 'ENTER']);
  assert.equal(r.effects.length, 0);
  assert.match(r.ui.notice ?? '', /OpenCode model refused: 'classifiers' has no agent/);
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
