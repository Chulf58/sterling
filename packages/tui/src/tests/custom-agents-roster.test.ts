import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { buildSystemTab, initialUi, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type Effect, type UiEvent, type UiState } from '../state.js';
import { discoverCustomAgents } from '../custom-agents.js';

// System tab roster (GitHub issue #307, user ruling 2026-11-18 "Installed roles + custom"):
// a governed role is listed only while an agent file for it is installed; custom agents
// from the project's agent folders are read-only rows that never emit an effect.

const CATALOG = [{ id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', status: 'active', vendor: 'anthropic' }];

function snapshot(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [{ name: 'implementor', installedModel: 'claude-sonnet-5-5', installedEffort: 'high' }],
    configModels: {
      implementor: { model: 'claude-sonnet-5-5', effort: 'high' },
      scout: { model: 'claude-sonnet-5-5', effort: 'low' },
    },
    catalog: { present: true, stale: false, staleDate: null, entries: CATALOG },
    ...over,
  };
}

const ui = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, tab: SYSTEM_TAB, ...over });

function drive(roster: AgentRosterSnapshot, names: string[], cursor = 0): { ui: UiState; effects: Effect[] } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-roster-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    let state = ui({ cursor });
    const effects: Effect[] = [];
    for (const name of names) {
      const r = reduce(store, state, { kind: 'key', name } as UiEvent, undefined, undefined, roster);
      state = r.ui;
      effects.push(...r.effects);
    }
    return { ui: state, effects };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an uninstalled governed role is not listed; an installed one is, in any host folder', () => {
  const keys = (r: AgentRosterSnapshot) => buildSystemTab(r, ui()).rows.map((x) => x.key);
  assert.equal(keys(snapshot()).includes('implementor'), true, 'implementor has an installed agent file');
  assert.equal(keys(snapshot()).includes('scout'), false, 'scout has no installed agent file');
  assert.equal(keys(snapshot({ hostInstalled: ['scout'] })).includes('scout'), true, 'an OpenCode or agy install counts');
});

test('an installed governed role stays editable: ENTER opens its model picker', () => {
  const r = drive(snapshot(), ['ENTER']);
  assert.equal(r.ui.selector?.key, 'implementor');
  assert.equal(r.ui.selector?.stage, 'model');
});

const custom = [
  { name: 'helper', source: 'claude' as const, model: 'claude-haiku-5' },
  { name: 'nomodel', source: 'opencode' as const },
  { name: 'broken', source: 'agy' as const, error: 'frontmatter is not closed' },
];

test('custom agents show read-only with their frontmatter model, inherit/default, or an error marker', () => {
  const rows = buildSystemTab(snapshot({ customAgents: custom }), ui()).customRows.map((x) => x.lines[0].text.trim());
  assert.deepEqual(rows, [
    'helper (claude): claude-haiku-5  read-only',
    'nomodel (opencode): inherit/default  read-only',
    'broken (agy): ⚠ frontmatter is not closed  read-only',
  ]);
});

test('custom rows take no cursor index: moving to the end and pressing ENTER or SPACE never emits an effect for them', () => {
  const roster = snapshot({ customAgents: custom });
  const keysBefore = buildSystemTab(roster, ui()).rows.length;
  const r = drive(roster, ['END', 'ENTER', 'SPACE', 'ENTER']);
  assert.equal(r.effects.some((e) => JSON.stringify(e).includes('helper') || JSON.stringify(e).includes('nomodel') || JSON.stringify(e).includes('broken')), false);
  assert.equal(buildSystemTab(roster, ui({ cursor: 0 })).rows.length, keysBefore, 'custom agents add no governed row');
  assert.equal(buildSystemTab(roster, ui({ cursor: 0 })).rows.some((x) => String(x.key).startsWith('custom:')), false);
});

test('discoverCustomAgents reads the three agent folders, skips Sterling roles and stamped files, and marks a malformed file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-custom-'));
  try {
    const put = (rel: string, text: string) => {
      const p = join(dir, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text);
    };
    put('.claude/agents/helper.md', '---\nname: helper\nmodel: claude-haiku-5\n---\nbody\n');
    put('.claude/agents/implementor.md', '---\nname: implementor\nmodel: x\n---\n');
    put('.claude/agents/stamped.md', '---\nname: stamped\n---\n<!-- sterling-generated v=1 -->\n');
    put('.opencode/agents/team/plain.md', 'no frontmatter\n');
    put('.opencode/agents/sterling/reviewer.md', '---\nmodel: y\n---\n');
    put('.agents/agents/agyone/agent.md', '---\nname: agyone\nmodel: "gemini-4-argon-low"\n---\n');
    put('.agents/agents/badone/agent.md', '---\nname: badone\nmodel: z\n');
    assert.deepEqual(discoverCustomAgents(dir), [
      { name: 'agyone', source: 'agy', model: 'gemini-4-argon-low' },
      { name: 'badone', source: 'agy', error: 'frontmatter is not closed' },
      { name: 'helper', source: 'claude', model: 'claude-haiku-5' },
      { name: 'plain', source: 'opencode' },
    ]);
    assert.deepEqual(discoverCustomAgents(join(dir, 'nowhere')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
