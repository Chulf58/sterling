import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { canonicalConfigSchema } from '@sterling/schemas';
import { buildSystemTab, initialUi, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type Effect, type UiState } from '../state.js';
import { applyAgentModel, applyOverpassProvider, applyWorkflow } from '../config-writeback.js';
import { openDashboard } from '../controller.js';
import { at, snap, SYS } from './system-nav.js';

// System tab layout (decision system-tab-layout-one-screen-with-three-sections-agents-one): AGENTS (one row
// per agent: agent | model | effort | hosts), WORKFLOW (merge path, reviewers, Copilot loop, auto-merge,
// TDD), PROJECT (Overpass provider, handoff files, storage read-only); a two-step model then effort picker;
// writes go to the canonical keys, validated with canonicalConfigSchema.

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, tab: SYSTEM_TAB, ...over });
const key = (name: string) => ({ kind: 'key' as const, name: name as never });
const agentRow = (lines: string[], name: string): string => lines.find((l) => l.replace(/^[› ]+/, '').split(/\s+/)[0] === name)!;
const text = (s: AgentRosterSnapshot, ui: UiState = st(), width = 200): string[] => buildSystemTab(s, ui, width).entries.flatMap((e) => e.row.lines.map((l) => l.text));

function press(s: AgentRosterSnapshot, ui: UiState, ...names: string[]): { ui: UiState; effects: Effect[] } {
  const store = new SterlingStore(':memory:');
  try {
    let cur = ui;
    const effects: Effect[] = [];
    for (const n of names) {
      const r = reduce(store, cur, key(n), undefined, undefined, s);
      cur = r.ui;
      effects.push(...r.effects);
    }
    return { ui: cur, effects };
  } finally {
    store.close();
  }
}

test('layout: Agents, Workflow and Project sections in that order; the agent table lists every agent', () => {
  const lines = text(snap());
  const heads = ['Agents', 'Workflow', 'Project'].map((h) => lines.indexOf(h));
  assert.ok(heads.every((i) => i >= 0) && heads[0] < heads[1] && heads[1] < heads[2], `headings in order: ${heads}`);
  const agentLines = lines.slice(heads[0] + 1, heads[1]);
  assert.match(agentLines[0], /agent\s+model\s+effort\s+hosts/);
  const names = agentLines.slice(1).map((l) => l.replace(/^[› ]+/, '').split(/\s+/)[0]);
  assert.deepEqual(names, ['conductor', 'plan', 'implementor', 'implementor-hard', 'reviewer', 'sparring', 'researcher', 'scout', 'librarian', 'preflight', 'maintenance-worker']);
  const wf = lines.slice(heads[1] + 1, heads[2]).map((l) => l.replace(/^[› ]+/, '').split(':')[0]);
  assert.deepEqual(wf, ['Merge path', 'Reviewers', 'Copilot loop', 'Auto-merge', 'TDD']);
  const proj = lines.slice(heads[2] + 1).map((l) => l.replace(/^[› ]+/, '').split(':')[0]);
  assert.deepEqual(proj, ['Overpass provider', 'Handoff files', 'Storage']);
  const all = lines.join('\n');
  for (const gone of ['Sparring partner', 'Default Codex model', 'Project mode', 'Conductor bypass', 'saved']) assert.doesNotMatch(all, new RegExp(gone), `${gone} is gone`);
});

test('layout: an agent row shows its one model and effort; an unset agent reads (unset) on its host default', () => {
  const lines = text(snap());
  assert.match(agentRow(lines, 'implementor'), /implementor\s+anthropic\/claude-sonnet-5-5\s+medium\s+all hosts/);
  assert.match(agentRow(lines, 'conductor'), /conductor\s+\(unset\)\s+-\s+host default/);
});

test('hosts column: an openai model says it cannot run on Claude Code; an agy model on the others; a Claude model runs everywhere but agy', () => {
  const s = snap({ models: { reviewer: { model: 'openai/gpt-5.6-sol', effort: 'high' }, scout: { model: 'agy/flash' }, implementor: { model: 'anthropic/claude-sonnet-5-5' } }, hosts: ['claude', 'opencode', 'agy'] });
  const lines = text(s);
  assert.match(agentRow(lines, 'reviewer'), /can't run on Claude Code, agy/);
  assert.match(agentRow(lines, 'scout'), /can't run on Claude Code, OpenCode/);
  assert.match(agentRow(lines, 'implementor'), /can't run on agy/);
});

test('hosts column: a role with an unresolved two-model conflict says to run /sterling:update', () => {
  assert.match(agentRow(text(snap({ twoModels: ['reviewer'] })), 'reviewer'), /role reviewer has two models; run \/sterling:update to choose/);
});

test('picker: step 1 lists models grouped by provider (anthropic, openai, agy, overpass); step 2 offers effort including unset; ENTER twice commits', () => {
  const s = snap();
  const open = press(s, st({ cursor: at(s, 'sys:implementor') }), 'ENTER');
  assert.equal(open.ui.selector?.stage, 'model');
  const picker = text(s, open.ui).join('\n');
  for (const group of ['anthropic', 'openai', 'agy', 'overpass']) assert.match(picker, new RegExp(`^\\s+${group}$`, 'm'), `${group} group`);
  for (const ref of ['anthropic/claude-opus-5-5', 'openai/gpt-5.6-sol', 'agy/flash', 'overpass/agentic-auto']) assert.ok(picker.includes(ref), ref);
  assert.match(picker, /step 1 of 2: model/);
  assert.equal(open.effects.length, 0);
  // the highlight starts on the current model; move to openai/gpt-5.6-sol and confirm
  let ui = open.ui;
  while (!text(s, ui).some((l) => l.includes('›') && l.includes('openai/gpt-5.6-sol'))) ui = press(s, ui, 'DOWN').ui;
  const step2 = press(s, ui, 'ENTER');
  assert.equal(step2.ui.selector?.stage, 'effort');
  assert.equal(step2.ui.selector?.model, 'openai/gpt-5.6-sol');
  const efforts = text(s, step2.ui).filter((l) => /^\s+(› )?\s*effort (unset|low|medium|high|xhigh|max)$/.test(l));
  assert.deepEqual(efforts.map((l) => l.replace(/^.*effort /, '')), ['unset', 'low', 'medium', 'high'], 'no xhigh or max off an Overpass tier');
  const done = press(s, step2.ui, 'DOWN', 'DOWN', 'ENTER');
  assert.deepEqual(done.effects, [{ type: 'agent_model', key: 'implementor', model: 'openai/gpt-5.6-sol', effort: 'medium' }]);
  assert.equal(done.ui.selector, undefined);
  const unset = press(s, step2.ui, 'ENTER');
  assert.deepEqual(unset.effects, [{ type: 'agent_model', key: 'implementor', model: 'openai/gpt-5.6-sol' }]);
});

test('picker: an Overpass tier offers max; an agy model offers only unset; ESCAPE closes without an effect', () => {
  const s = snap();
  const pick = (ref: string): ReturnType<typeof press> => {
    let ui = press(s, st({ cursor: at(s, 'sys:scout') }), 'ENTER').ui;
    while (!text(s, ui).some((l) => l.includes('›') && l.includes(ref))) ui = press(s, ui, 'DOWN').ui;
    return press(s, ui, 'ENTER');
  };
  const tier = pick('overpass/agentic-premium-max');
  assert.ok(text(s, tier.ui).some((l) => l.includes('effort max')));
  const agy = pick('agy/pro');
  assert.equal(text(s, agy.ui).filter((l) => /^\s+(› )?\s*effort /.test(l)).length, 1);
  const closed = press(s, agy.ui, 'ESCAPE');
  assert.equal(closed.ui.selector, undefined);
  assert.equal(closed.effects.length, 0);
});

test('workflow: the Copilot loop is dimmed with its reason under the direct merge path, and holds no cursor', () => {
  const s = snap();
  const view = buildSystemTab(s, st(), 200);
  const loop = view.entries.find((e) => e.id === SYS.copilotLoop)!;
  assert.equal(loop.disabled, 'needs the pull-request merge path');
  assert.equal(loop.cursorable, false);
  assert.match(loop.row.lines[0].text, /Copilot loop: OFF {2}\(needs the pull-request merge path\)/);
  assert.equal(view.entries.find((e) => e.id === SYS.autoMerge)!.disabled, 'needs the pull-request merge path');
  assert.throws(() => at(s, SYS.copilotLoop));
  const pr = snap({ workflow: { merge: 'pr', reviewers: 3, copilot_loop: false, auto_merge_on_clean: true } });
  assert.equal(buildSystemTab(pr, st(), 200).entries.find((e) => e.id === SYS.copilotLoop)!.cursorable, true);
  assert.equal(buildSystemTab(pr, st(), 200).entries.find((e) => e.id === SYS.autoMerge)!.disabled, 'needs the Copilot loop on');
  const on = snap({ workflow: { merge: 'pr', reviewers: 3, copilot_loop: true, auto_merge_on_clean: true } });
  assert.equal(buildSystemTab(on, st(), 200).entries.find((e) => e.id === SYS.autoMerge)!.cursorable, true);
});

test('workflow: ENTER flips the merge path and the loop; the reviewer count steps 1..5 and wraps, never leaving the bounds', () => {
  const s = snap();
  assert.deepEqual(press(s, st({ cursor: at(s, SYS.mergePath) }), 'ENTER').effects, [{ type: 'workflow_set', field: 'merge', value: 'pr' }]);
  const pr = snap({ workflow: { merge: 'pr', reviewers: 1, copilot_loop: false, auto_merge_on_clean: true } });
  assert.deepEqual(press(pr, st({ cursor: at(pr, SYS.copilotLoop) }), 'ENTER').effects, [{ type: 'workflow_set', field: 'copilot_loop', value: true }]);
  const seen: number[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const r = snap({ workflow: { merge: 'direct', reviewers: n, copilot_loop: false, auto_merge_on_clean: true } });
    const e = press(r, st({ cursor: at(r, SYS.reviewers) }), 'ENTER').effects[0] as { value: number };
    seen.push(e.value);
  }
  assert.deepEqual(seen, [2, 3, 4, 5, 1]);
});

test('project: the Overpass provider edits as text and commits a valid id; an invalid id keeps the buffer open', () => {
  const s = snap();
  const open = press(s, st({ cursor: at(s, SYS.overpassProvider) }), 'ENTER');
  assert.equal(open.ui.overpassProviderEdit, 'overpass');
  const bad = { ...open.ui, overpassProviderEdit: 'a/b' };
  const refused = press(s, bad, 'ENTER');
  assert.equal(refused.effects.length, 0);
  assert.notEqual(refused.ui.overpassProviderEdit, undefined);
  const ok = press(s, { ...open.ui, overpassProviderEdit: 'mygw' }, 'ENTER');
  assert.deepEqual(ok.effects, [{ type: 'overpass_provider', provider: 'mygw' }]);
});

test('project: handoff flips; storage is read-only with no cursor', () => {
  const s = snap({ storage: 'postgres' });
  assert.deepEqual(press(s, st({ cursor: at(s, SYS.handoff) }), 'ENTER').effects, [{ type: 'handoff_toggle', enabled: true }]);
  const storage = buildSystemTab(s, st(), 200).entries.find((e) => e.id === 'sys:storage')!;
  assert.equal(storage.cursorable, false);
  assert.match(storage.row.lines[0].text, /Storage: SERVED POSTGRES \(read-only/);
  assert.match(text(snap({ storage: null })).join('\n'), /Storage: UNKNOWN/);
  assert.match(text(snap({ storage: 'weird' })).join('\n'), /Storage: UNRECOGNIZED \(weird\)/);
});

// ── canonical writes ────────────────────────────────────────────────────────

function configFixture(config: Record<string, unknown>): { dir: string; path: string; read: () => Record<string, any>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-system-write-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const path = join(dir, '.sterling', 'config.json');
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return { dir, path, read: () => JSON.parse(readFileSync(path, 'utf8')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('canonical writes: agent_model replaces models.<key> whole (no per-host field survives) and the result passes canonicalConfigSchema', () => {
  const f = configFixture({ models: { implementor: { model: 'claude-sonnet-5-5', effort: 'medium', opencode_model: 'openai/gpt-5.6-terra' } }, tdd: { enabled: true } });
  try {
    const errors: string[] = [];
    assert.equal(applyAgentModel({ type: 'agent_model', key: 'implementor', model: 'openai/gpt-5.6-sol', effort: 'high' }, (m) => errors.push(m), f.path), true, errors.join());
    const written = f.read();
    assert.deepEqual(written.models.implementor, { model: 'openai/gpt-5.6-sol', effort: 'high' });
    assert.deepEqual(written.tdd, { enabled: true });
    assert.equal(applyAgentModel({ type: 'agent_model', key: 'scout', model: 'overpass/agentic-auto', effort: 'max' }, undefined, f.path), true);
    assert.deepEqual(f.read().models.scout, { model: 'overpass/agentic-auto', effort: 'max' });
  } finally {
    f.cleanup();
  }
});

test('canonical writes: a model the schema refuses is never written (max off an Overpass tier, a bare id)', () => {
  const f = configFixture({ models: {} });
  try {
    const before = readFileSync(f.path, 'utf8');
    const errors: string[] = [];
    assert.equal(applyAgentModel({ type: 'agent_model', key: 'scout', model: 'anthropic/claude-opus-5-5', effort: 'max' }, (m) => errors.push(m), f.path), false);
    assert.equal(applyAgentModel({ type: 'agent_model', key: 'scout', model: 'claude-opus-5-5' }, (m) => errors.push(m), f.path), false);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /not a valid canonical config/);
    assert.match(errors[1], /not a canonical model/);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  } finally {
    f.cleanup();
  }
});

test('canonical writes: workflow_set writes config.workflow from the current read (a legacy work mode records pr, 3, loop on) and refuses reviewers outside 1-5', () => {
  const f = configFixture({ mode: 'work', pr_review: { auto_merge_on_clean: false, copilot_logins: ['x'] } });
  try {
    assert.equal(applyWorkflow({ type: 'workflow_set', field: 'reviewers', value: 4 }, undefined, f.path), true);
    const written = f.read();
    assert.deepEqual(written.workflow, { merge: 'pr', reviewers: 4, copilot_loop: true, auto_merge_on_clean: false });
    const before = readFileSync(f.path, 'utf8');
    const errors: string[] = [];
    for (const value of [0, 6]) assert.equal(applyWorkflow({ type: 'workflow_set', field: 'reviewers', value }, (m) => errors.push(m), f.path), false);
    assert.equal(errors.length, 2);
    assert.equal(readFileSync(f.path, 'utf8'), before);
  } finally {
    f.cleanup();
  }
});

test('canonical writes: overpass_provider keeps the other overpass keys; a bad id is refused', () => {
  const f = configFixture({ workflow: { merge: 'direct' }, overpass: { provider: 'overpass' } });
  try {
    assert.equal(applyOverpassProvider({ type: 'overpass_provider', provider: 'gw.1' }, undefined, f.path), true);
    assert.deepEqual(f.read().overpass, { provider: 'gw.1' });
    assert.equal(applyOverpassProvider({ type: 'overpass_provider', provider: 'a/b' }, () => undefined, f.path), false);
    assert.equal(canonicalConfigSchema.safeParse(f.read()).success, true);
  } finally {
    f.cleanup();
  }
});

test('controller: the System tab reads the canonical config and an agent_model effect writes models.<key> through handle()', async () => {
  const f = configFixture({ workflow: { merge: 'pr', reviewers: 2, copilot_loop: true, auto_merge_on_clean: false }, overpass: { provider: 'gw' }, models: { reviewer: { model: 'openai/gpt-5.6-sol', effort: 'high' } } });
  const ctl = openDashboard(join(f.dir, '.sterling', 'sterling.db'));
  try {
    await ctl.handle({ kind: 'key', name: 'RIGHT' } as never, { width: 120, maxBodyLines: 80, showBanner: false });
    for (let i = 0; i < 6 && ctl.ui().tab !== SYSTEM_TAB; i++) await ctl.handle({ kind: 'key', name: 'RIGHT' } as never, { width: 120, maxBodyLines: 80, showBanner: false });
    assert.equal(ctl.ui().tab, SYSTEM_TAB);
    const roster = ctl.roster()!;
    assert.deepEqual(roster.workflow, { merge: 'pr', reviewers: 2, copilot_loop: true, auto_merge_on_clean: false });
    assert.equal(roster.overpassProvider, 'gw');
    assert.equal(roster.models.reviewer.model, 'openai/gpt-5.6-sol');
    await ctl.applyEffects([{ type: 'agent_model', key: 'scout', model: 'anthropic/claude-haiku-5-5', effort: 'low' }, { type: 'workflow_set', field: 'reviewers', value: 5 }]);
    const written = f.read();
    assert.deepEqual(written.models.scout, { model: 'anthropic/claude-haiku-5-5', effort: 'low' });
    assert.equal(written.workflow.reviewers, 5);
    assert.equal(ctl.roster()!.workflow!.reviewers, 5);
  } finally {
    ctl.close();
    f.cleanup();
  }
});
