import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { openDashboard } from '../controller.js';
import { buildSystemTab, initialUi, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type Effect, type UiEvent, type UiState } from '../state.js';

// System tab redesign, item 5 (board 4597ac90): every agent is a row of one table. An adopted custom agent
// (agent-sources/<key>.md plus config.models.<key>) is a full editable row; a not-yet-adopted one has an
// Adopt action; the host column says where each agent runs and with which model.

const VP = { width: 120, maxBodyLines: 80, showBanner: false };
const ALL_HOSTS = ['claude', 'opencode', 'agy'] as const;
const KEY = 'custom-team-scout';
const source = (extra = ''): string => `---\nname: team-scout\ndescription: Scouts the team folders\n${extra}---\nLook around.\n`;

function project(models: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-agent-table-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ models }, null, 2) + '\n');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8');
  const config = (): { models: Record<string, Record<string, unknown>> } => JSON.parse(read('.sterling/config.json'));
  return { dir, storePath: join(dir, '.sterling', 'sterling.db'), read, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const openTab = async (storePath: string, hosts: readonly ('claude' | 'opencode' | 'agy')[] = ALL_HOSTS) => {
  const ctl = openDashboard(storePath, { customAgentHosts: [...hosts] });
  await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
  return ctl;
};

test('an adopted custom agent is an editable row: setting model and effort writes config.models.<key> and renders every installed host', async () => {
  const p = project({ [KEY]: {} }, { [`agent-sources/${KEY}.md`]: source() });
  const ctl = await openTab(p.storePath);
  try {
    assert.ok(ctl.state(VP).rows.some((r) => r.id === `sys:${KEY}`), 'listed as a full agent row');
    await ctl.applyEffects([{ type: 'custom_agent_model', key: KEY, set: { model: 'claude-sonnet-5-5', effort: 'high' } }]);
    assert.deepEqual(p.config().models[KEY], { model: 'claude-sonnet-5-5', effort: 'high' });
    assert.match(p.read('.claude/agents/team-scout.md'), /^model: claude-sonnet-5-5$/m);
    assert.ok(existsSync(join(p.dir, '.opencode/agents/team-scout.md')), 'rendered for OpenCode');
    assert.ok(existsSync(join(p.dir, '.agents/agents/team-scout/agent.md')), 'rendered for agy');
    assert.match(ctl.ui().notice ?? '', /Custom agent 'custom-team-scout' updated; rendered for/);
    // the per-host overrides land in the matching host file only
    await ctl.applyEffects([{ type: 'custom_agent_model', key: KEY, set: { opencode_model: 'openai/gpt-5.6-terra', agy_model: 'flash' } }]);
    assert.match(p.read('.opencode/agents/team-scout.md'), /^model: openai\/gpt-5\.6-terra$/m);
    assert.match(p.read('.agents/agents/team-scout/agent.md'), /^model: flash$/m);
    assert.match(p.read('.claude/agents/team-scout.md'), /^model: claude-sonnet-5-5$/m, 'Claude keeps its own model');
    // null removes a field: inherit again
    await ctl.applyEffects([{ type: 'custom_agent_model', key: KEY, set: { model: null, effort: null, agy_model: null } }]);
    assert.equal('model' in p.config().models[KEY], false);
    assert.match(p.read('.agents/agents/team-scout/agent.md'), /^model: inherit$/m);
  } finally {
    ctl.close();
    p.cleanup();
  }
});

test('a render refusal is surfaced as a notice naming the host and the reason, and nothing is changed', async () => {
  // an unstamped file Sterling did not write sits where the Claude copy goes
  const p = project({ [KEY]: {} }, { [`agent-sources/${KEY}.md`]: source(), '.claude/agents/team-scout.md': '---\nname: team-scout\n---\nmine\n' });
  const ctl = await openTab(p.storePath);
  try {
    const before = p.read('.sterling/config.json');
    await ctl.applyEffects([{ type: 'custom_agent_model', key: KEY, set: { model: 'claude-sonnet-5-5', effort: 'low' } }]);
    assert.equal(p.read('.sterling/config.json'), before, 'config.json is unchanged');
    assert.match(ctl.ui().notice ?? '', /not changed — claude: .*team-scout\.md.*as they were/);
    assert.equal(p.read('.claude/agents/team-scout.md'), '---\nname: team-scout\n---\nmine\n', 'the foreign file is untouched');
    // and the row itself carries the refusal
    const row = ctl.state(VP).rows.find((r) => r.id === `sys:${KEY}`)!;
    assert.ok(row.lines.some((l) => /⚠ claude: /.test(l.text)), JSON.stringify(row.lines));
  } finally {
    ctl.close();
    p.cleanup();
  }
});

test('a model the schema refuses is not written (strict validation)', async () => {
  const p = project({ [KEY]: {} }, { [`agent-sources/${KEY}.md`]: source() });
  const ctl = await openTab(p.storePath);
  try {
    const before = p.read('.sterling/config.json');
    await ctl.applyEffects([{ type: 'custom_agent_model', key: KEY, set: { agy_model: 'claude-opus-5-5-high' } }]);
    assert.equal(p.read('.sterling/config.json'), before);
    assert.match(ctl.ui().notice ?? '', /not changed/);
  } finally {
    ctl.close();
    p.cleanup();
  }
});

function agentRoster(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [],
    hostInstalled: [],
    configModels: { [KEY]: { model: '', effort: '' } },
    customModels: { [KEY]: {} },
    adoptedAgents: [{ key: KEY, name: 'team-scout', hosts: ['claude', 'opencode', 'agy'], refusals: [] }],
    catalog: { present: true, stale: false, staleDate: null, entries: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', status: 'active', vendor: 'anthropic' }] },
    codexWired: true,
    sparringPartner: { enabled: true },
    tdd: { enabled: true },
    mode: 'hobby',
    agy: true,
    ...over,
  } as AgentRosterSnapshot;
}

function press(roster: AgentRosterSnapshot, ui: UiState, names: string[]): { ui: UiState; effects: Effect[] } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-agent-table-ui-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    let state = ui;
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
const tab = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, tab: SYSTEM_TAB, ...over });

test('the host column names each host with its effective model; agy shows no effort control and offers exactly its four values', () => {
  const roster = agentRoster({ customModels: { [KEY]: { model: 'claude-sonnet-5-5', effort: 'high', agy_model: 'flash' } }, configModels: { [KEY]: { model: 'claude-sonnet-5-5', effort: 'high', agy_model: 'flash' } } });
  const row = buildSystemTab(roster, tab(), 200).rows.find((r) => r.key === KEY)!;
  assert.equal(row.lines[0].text.trim().replace('› ', ''), 'team-scout (custom): claude-sonnet-5-5 high');
  const hosts = row.lines.find((l) => l.text.trim().startsWith('on: '))!.text.trim();
  assert.equal(hosts, 'on: Claude claude-sonnet-5-5 high · OpenCode anthropic/claude-sonnet-5-5 (effort unsupported) · agy flash (effort unsupported)');
  // the picker offers the four agy values after the catalog, and a clear option for the model
  const open = press(roster, tab(), ['ENTER']);
  const options = buildSystemTab(roster, open.ui, 200).rows[0].lines.filter((l) => l.kind === 'option').map((l) => l.text.trim().replace('› ', ''));
  assert.deepEqual(options.filter((t) => t.includes('Antigravity only')), ['inherit (Antigravity only)', 'flash_lite (Antigravity only)', 'flash (Antigravity only)', 'pro (Antigravity only)']);
  assert.ok(options.some((t) => t.startsWith('inherit: ')), 'the model can be set back to inherit');
});

test('the editor flow for a custom row: model, then effort, then one custom_agent_model effect; an agy pick and inherit commit at once', () => {
  const roster = agentRoster();
  const swap = press(roster, tab(), ['ENTER', 'ENTER', 'ENTER']); // model 0, effort low
  assert.deepEqual(swap.effects, [{ type: 'custom_agent_model', key: KEY, set: { model: 'claude-opus-5-5', effort: 'low' } }]);
  // agy options start after the one catalog entry: entry 0, then inherit, flash_lite, flash, pro
  const agy = press(roster, tab(), ['ENTER', 'DOWN', 'DOWN', 'ENTER']);
  assert.deepEqual(agy.effects, [{ type: 'custom_agent_model', key: KEY, set: { agy_model: 'flash_lite' } }]);
  const noAgy = press(agentRoster({ adoptedAgents: [{ key: KEY, name: 'team-scout', hosts: ['claude'], refusals: [] }] }), tab(), ['ENTER', 'DOWN', 'ENTER']);
  assert.deepEqual(noAgy.effects, []);
  assert.match(noAgy.ui.notice ?? '', /not rendered for agy/);
});

const customOnly = (over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot => agentRoster({ configModels: {}, customModels: {}, adoptedAgents: [], ...over });

test('a not-yet-adopted agent: ENTER asks for the plan, ESC cancels, ENTER confirms; adoption moves the file, creates the key without a model, renders every host', async () => {
  const text = `---\nname: team-helper\ndescription: Scouts\n---\nLook.\n`;
  const p = project({}, { '.opencode/agents/team/helper.md': text });
  const ctl = await openTab(p.storePath);
  try {
    const id = 'opencode:team/helper';
    assert.ok(ctl.state(VP).rows.some((r) => r.lines[0].text.includes(`${id} (not adopted)`)), 'listed with its host-qualified identity');
    await ctl.applyEffects([{ type: 'adopt_plan', id }]);
    assert.equal(ctl.ui().adoptConfirm?.ok, true);
    assert.match((ctl.ui().adoptConfirm?.lines ?? []).join('\n'), /move \.opencode\/agents\/team\/helper\.md to agent-sources\/custom-team-helper\.md[\s\S]*new key custom-team-helper[\s\S]*ENTER adopts, ESC cancels/);
    assert.ok(ctl.state(VP).rows.some((r) => r.lines.some((l) => /ENTER adopts, ESC cancels/.test(l.text))), 'the confirm is drawn under the row');
    // cancel: nothing changes
    await ctl.handle({ kind: 'key', name: 'ESCAPE' }, VP);
    assert.equal(ctl.ui().adoptConfirm, undefined);
    assert.ok(existsSync(join(p.dir, '.opencode/agents/team/helper.md')));
    assert.deepEqual(p.config().models, {});
    // confirm: a click on the row presses ENTER there (the plan opens with the cursor on the row), then ENTER adopts
    const st = ctl.state(VP);
    const row = st.rows.find((r) => r.lines[0].text.includes(`${id} (not adopted)`))!;
    await ctl.handle({ kind: 'click', x: 5, y: st.bodyTop + 1 + row.screenRow - st.scroll }, VP);
    assert.equal(ctl.ui().adoptConfirm?.id, id, 'the click opened the confirm');
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    assert.equal(existsSync(join(p.dir, '.opencode/agents/team/helper.md')), false, `the original moved: ${ctl.ui().notice}`);
    assert.equal(p.read('agent-sources/custom-team-helper.md'), text.replace('---\n', '---\nsterling-origin: opencode\n'), 'the original plus its origin line');
    assert.deepEqual(p.config().models['custom-team-helper'], {}, 'no fabricated model or effort');
    for (const rel of ['.claude/agents/team-helper.md', '.opencode/agents/team-helper.md', '.agents/agents/team-helper/agent.md']) assert.ok(existsSync(join(p.dir, rel)), rel);
    assert.match(ctl.ui().notice ?? '', /Adopted opencode:team\/helper as custom-team-helper/);
    assert.ok(ctl.state(VP).rows.some((r) => r.id === 'sys:custom-team-helper'), 'now a full row');
  } finally {
    ctl.close();
    p.cleanup();
  }
});

test('a slug collision is refused in the confirm and nothing moves', async () => {
  const text = `---\nname: team-helper\ndescription: Scouts\n---\nLook.\n`;
  const p = project({}, { '.opencode/agents/team/helper.md': text, '.opencode/agents/team-helper.md': text });
  const ctl = await openTab(p.storePath);
  try {
    await ctl.applyEffects([{ type: 'adopt_plan', id: 'opencode:team/helper' }]);
    assert.equal(ctl.ui().adoptConfirm?.ok, false);
    assert.match((ctl.ui().adoptConfirm?.lines ?? []).join('\n'), /refused \(key-collision\): .*both become custom-team-helper/);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    assert.equal(ctl.ui().adoptConfirm, undefined, 'ENTER on a refused plan only closes it');
    assert.ok(existsSync(join(p.dir, '.opencode/agents/team/helper.md')));
    assert.deepEqual(p.config().models, {});
  } finally {
    ctl.close();
    p.cleanup();
  }
});

test('an adopt row is a cursor stop: ENTER on it emits adopt_plan and nothing else', () => {
  const roster = customOnly({ customAgents: [{ name: 'helper', source: 'claude', model: 'claude-haiku-5', file: '.claude/agents/helper.md' }] });
  const entries = buildSystemTab(roster, tab()).entries;
  const adopt = entries.find((e) => e.id === 'sys:custom:claude:0')!;
  assert.equal(adopt.cursorable, true);
  const r = press(roster, tab({ cursor: 1 }), ['ENTER']); // 0 = the worker row, 1 = the adopt row
  assert.deepEqual(r.effects, [{ type: 'adopt_plan', id: 'claude:helper' }]);
});

// ── review fixes: the full render is checked before anything moves; the confirm belongs to its row ──

test('adoption is refused before anything moves when an installed host would refuse, with the per-host reason', async () => {
  const text = `---\nname: team-helper\ndescription: Scouts\n---\nLook.\n`;
  // a folder sits where the Claude copy would go
  const p = project({}, { '.opencode/agents/team/helper.md': text, '.claude/agents/team-helper.md/keep': 'mine\n' });
  const ctl = await openTab(p.storePath);
  try {
    await ctl.applyEffects([{ type: 'adopt_run', id: 'opencode:team/helper' }]);
    assert.match(ctl.ui().notice ?? '', /Adopt opencode:team\/helper failed — claude: .*exists and is not a file/);
    assert.equal(p.read('.opencode/agents/team/helper.md'), text, 'the original is where it was');
    for (const rel of ['.opencode/agents/team-helper.md', '.agents/agents/team-helper/agent.md']) assert.equal(existsSync(join(p.dir, rel)), false, `no output left behind: ${rel}`);
    assert.equal(existsSync(join(p.dir, 'agent-sources')), false, 'no source written');
    assert.deepEqual(p.config().models, {});
    assert.equal(p.read('.claude/agents/team-helper.md/keep'), 'mine\n');
  } finally {
    ctl.close();
    p.cleanup();
  }
});

test('an open adoption confirm is dropped by a click on another row and by a tab switch; it never adopts from there', async () => {
  const text = `---\nname: team-helper\ndescription: Scouts\n---\nLook.\n`;
  const p = project({}, { '.opencode/agents/team/helper.md': text });
  const ctl = await openTab(p.storePath);
  const id = 'opencode:team/helper';
  try {
    await ctl.applyEffects([{ type: 'adopt_plan', id }]);
    assert.equal(ctl.ui().adoptConfirm?.ok, true);
    const st = ctl.state(VP);
    const tdd = st.rows.find((r) => r.id === 'sys:tdd_enabled')!;
    await ctl.handle({ kind: 'click', x: 5, y: st.bodyTop + 1 + tdd.screenRow - st.scroll }, VP);
    assert.ok(existsSync(join(p.dir, '.opencode/agents/team/helper.md')), `a click on TDD did not adopt: ${ctl.ui().notice}`);
    assert.equal(ctl.ui().adoptConfirm, undefined, 'the confirm is gone');
    // tab away and back, then ENTER on whatever the cursor is on: no adoption
    await ctl.applyEffects([{ type: 'adopt_plan', id }]);
    await ctl.handle({ kind: 'tab', index: 0 }, VP);
    assert.equal(ctl.ui().adoptConfirm, undefined, 'a tab switch drops the confirm');
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    assert.ok(existsSync(join(p.dir, '.opencode/agents/team/helper.md')), 'ENTER after the tab switch did not adopt');
    assert.deepEqual(p.config().models, {});
  } finally {
    ctl.close();
    p.cleanup();
  }
});

test('ENTER confirms only while the cursor is on the adoption row it was opened from', () => {
  const roster = customOnly({ customAgents: [{ name: 'helper', source: 'claude', model: 'claude-haiku-5', file: '.claude/agents/helper.md' }] });
  const confirm = { id: 'claude:helper', ok: true, lines: ['ENTER adopts, ESC cancels'] };
  const elsewhere = press(roster, tab({ cursor: 0, adoptConfirm: confirm }), ['ENTER']);
  assert.equal(elsewhere.effects.some((e) => e.type === 'adopt_run'), false);
  assert.equal(elsewhere.ui.adoptConfirm, undefined);
  const same = press(roster, tab({ cursor: 1, adoptConfirm: confirm }), ['ENTER']);
  assert.deepEqual(same.effects, [{ type: 'adopt_run', id: 'claude:helper' }]);
});
