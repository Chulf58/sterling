import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { buildSystemTab, initialUi, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type Effect, type UiEvent, type UiState } from '../state.js';
import { discoverCustomAgents, installedGovernedAgents } from '../custom-agents.js';

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

// Changed 2026-11-18 (System tab redesign, item 5): a not-yet-adopted agent is shown with its host-qualified identity
// (host:path), the model from its own file, and an Adopt action, so its row now holds a cursor index; a file that
// could not be read stays read-only with its error marker.
test('custom agents show host:name with the file\'s own model and an adopt hint; an unreadable one stays read-only with its error', () => {
  const rows = buildSystemTab(snapshot({ customAgents: custom }), ui()).customRows.map((x) => x.lines[0].text.trim());
  assert.deepEqual(rows, [
    'claude:helper (not adopted): claude-haiku-5 — ENTER to adopt',
    'opencode:nomodel (not adopted): inherit/default — ENTER to adopt',
    'agy:broken: ⚠ frontmatter is not closed (read-only)',
  ]);
  const entries = buildSystemTab(snapshot({ customAgents: custom }), ui()).entries.filter((e) => e.id.startsWith('sys:custom:'));
  assert.deepEqual(entries.map((e) => e.cursorable), [true, true, false]);
  assert.deepEqual(entries.map((e) => e.action?.kind), ['adopt', 'adopt', undefined]);
});

test('an unreadable custom row takes no cursor index, and moving to the end never selects an adopt row', () => {
  const roster = snapshot({ customAgents: custom });
  const keysBefore = buildSystemTab(roster, ui()).rows.length;
  const r = drive(roster, ['END', 'ENTER', 'SPACE', 'ENTER']);
  assert.equal(r.effects.some((e) => JSON.stringify(e).includes('helper') || JSON.stringify(e).includes('nomodel') || JSON.stringify(e).includes('broken')), false);
  assert.equal(buildSystemTab(roster, ui({ cursor: 0 })).rows.length, keysBefore, 'custom agents add no governed row');
  assert.equal(buildSystemTab(roster, ui({ cursor: 0 })).rows.some((x) => String(x.key).startsWith('custom:')), false);
});

function project(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-custom-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('discoverCustomAgents reads the three agent folders, skips Sterling roles at their managed location and stamped files, and marks a malformed file', () => {
  const { dir, cleanup } = project({
    '.claude/agents/helper.md': '---\nname: helper\nmodel: claude-haiku-5\n---\nbody\n',
    '.claude/agents/implementor.md': '---\nname: implementor\nmodel: x\n---\n',
    '.claude/agents/stamped.md': '---\nname: stamped\n---\n<!-- sterling-generated v=1 -->\n',
    '.opencode/agents/team/plain.md': 'no frontmatter\n',
    '.opencode/agents/sterling/reviewer.md': '---\nmodel: y\n---\n',
    '.agents/agents/agyone/agent.md': '---\nname: agyone\nmodel: "gemini-4-argon-low"\n---\n',
    '.agents/agents/badone/agent.md': '---\nname: badone\nmodel: z\n',
  });
  try {
    assert.deepEqual(discoverCustomAgents(dir), [
      { name: 'agyone', source: 'agy', model: 'gemini-4-argon-low' },
      { name: 'badone', source: 'agy', error: 'frontmatter is not closed' },
      { name: 'helper', source: 'claude', model: 'claude-haiku-5' },
      { name: 'team/plain', source: 'opencode' },
    ]);
    assert.deepEqual(discoverCustomAgents(join(dir, 'nowhere')), []);
  } finally {
    cleanup();
  }
});

// Review fix (issue #307): a governed basename outside Sterling's managed location is the user's own agent.
test('a Sterling role name outside its managed location is a custom agent under its own path, and does not count as installed', () => {
  const { dir, cleanup } = project({
    '.opencode/agents/team/scout.md': '---\nmodel: openai/own\n---\n',
    '.opencode/agents/sterling/reviewer.md': '---\nmodel: y\n---\n',
    '.agents/agents/team/scout/agent.md': '---\nmodel: gemini-4-argon-low\n---\n',
  });
  try {
    assert.deepEqual(discoverCustomAgents(dir), [
      { name: 'team/scout', source: 'agy', model: 'gemini-4-argon-low' },
      { name: 'team/scout', source: 'opencode', model: 'openai/own' },
    ]);
    assert.deepEqual(installedGovernedAgents(dir), { claude: [], opencode: ['reviewer'], agy: [] }, 'scout is not installed anywhere; only the managed reviewer is');
  } finally {
    cleanup();
  }
});

test('a governed role at its managed location counts as installed per host and is not a custom row', () => {
  const { dir, cleanup } = project({
    '.claude/agents/scout.md': '---\nmodel: m\n---\n',
    '.opencode/agents/sterling/scout.md': '---\nmodel: m\n---\n',
    '.agents/agents/scout/agent.md': '---\nmodel: m\n---\n',
  });
  try {
    assert.deepEqual(installedGovernedAgents(dir), { claude: ['scout'], opencode: ['scout'], agy: ['scout'] });
    assert.deepEqual(discoverCustomAgents(dir), []);
  } finally {
    cleanup();
  }
});

// Review fix: the frontmatter is parsed as YAML, not matched with a regex.
test('a quoted model with a trailing comment shows the model; a model that does not parse is an error row', () => {
  const { dir, cleanup } = project({
    '.claude/agents/quoted.md': '---\nmodel: "openai/a" # pinned\n---\n',
    '.claude/agents/broken.md': '---\nmodel: [\n---\n',
    '.claude/agents/listed.md': '---\nmodel:\n  - a\n  - b\n---\n',
  });
  try {
    const found = discoverCustomAgents(dir);
    assert.deepEqual(found.find((a) => a.name === 'quoted'), { name: 'quoted', source: 'claude', model: 'openai/a' });
    assert.match(found.find((a) => a.name === 'broken')?.error ?? '', /not valid YAML/);
    assert.equal(found.find((a) => a.name === 'listed')?.error, 'frontmatter model is not a scalar');
  } finally {
    cleanup();
  }
});
