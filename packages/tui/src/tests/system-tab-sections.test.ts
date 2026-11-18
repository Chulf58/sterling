import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { buildSystemTab, initialUi, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type Effect, type OverpassView, type UiEvent, type UiState } from '../state.js';
import { at, SYS } from './system-nav.js';

// System tab redesign, item 2 (board b8c309aa): an Agents section and a Settings section with grouped
// settings; a setting that does not apply now is shown dimmed with its reason, holds no cursor index and
// emits no effect; one rule decides what an on/off toggle does with an invalid value.

const ALL = ['implementor', 'implementor-hard', 'researcher', 'scout', 'librarian', 'reviewer', 'sparring', 'preflight'];
const view = (over: Partial<OverpassView> = {}): OverpassView => ({ enabled: false, provider: 'overpass', conductorBypass: false, effective: false, ...over });

function snap(over: Record<string, unknown> = {}): AgentRosterSnapshot {
  return {
    agents: [{ name: 'implementor', installedModel: 'claude-sonnet-5-5', installedEffort: 'high' }],
    hostInstalled: ALL,
    configModels: { implementor: { model: 'claude-sonnet-5-5', effort: 'high' } },
    catalog: { present: true, stale: false, staleDate: null, entries: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', status: 'active', vendor: 'anthropic' }] },
    codexWired: true,
    sparringPartner: { enabled: true },
    tdd: { enabled: true },
    mode: 'work',
    handoff: false,
    autoMergeOnClean: true,
    host: 'opencode',
    overpass: view(),
    customAgents: [{ name: 'helper', source: 'claude', model: 'claude-haiku-5' }],
    storage: 'sqlite',
    ...over,
  } as AgentRosterSnapshot;
}

const ui = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, tab: SYSTEM_TAB, ...over });
const key = (name: string): UiEvent => ({ kind: 'key', name }) as UiEvent;

function press(roster: AgentRosterSnapshot, cursor: number, name: string): { ui: UiState; effects: Effect[] } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sections-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    return reduce(store, ui({ cursor }), key(name), undefined, undefined, roster);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the tab lists an Agents section (roster, then custom agents) and a Settings section with its groups, in that order', () => {
  const ids = buildSystemTab(snap(), ui(), 100).entries.map((e) => e.id);
  const order = ['sys:heading:agents', 'sys:implementor', 'sys:maintenance-worker', 'sys:custom:claude:0', 'sys:heading:settings', 'sys:group:sparring', 'sys:sparring_enabled', 'sys:group:workflow', 'sys:tdd_enabled', 'sys:group:overpass', 'sys:overpass', 'sys:group:storage', 'sys:storage'];
  const at2 = order.map((id) => ids.indexOf(id));
  assert.ok(at2.every((i) => i >= 0), `every id is listed: ${JSON.stringify(ids)}`);
  assert.deepEqual([...at2].sort((a, b) => a - b), at2, 'in this order');
  const entries = buildSystemTab(snap(), ui(), 100).entries;
  assert.equal(entries.find((e) => e.id === 'sys:heading:agents')?.row.lines[0].text, 'Agents');
  assert.equal(entries.find((e) => e.id === 'sys:heading:settings')?.row.lines[0].text, 'Settings');
  for (const e of entries.filter((x) => x.id.startsWith('sys:heading:') || x.id.startsWith('sys:group:'))) assert.equal(e.cursorable, false, `${e.id} holds no cursor index`);
  assert.equal(entries.find((e) => e.id === 'sys:storage')?.section, 'settings', 'storage is a read-only setting');
});

test('a setting outside its conditions is shown dimmed with its reason, holds no cursor index and emits no effect', () => {
  // Overpass: not offered outside work mode on OpenCode; auto-merge: acts only in work mode
  const cases: Array<[string, AgentRosterSnapshot, string[], string]> = [
    ['hobby on OpenCode', snap({ mode: 'hobby' }), [SYS.overpass, SYS.overpassProvider, SYS.overpassBypass, SYS.autoMerge], ''],
    ['work without OpenCode', snap({ host: undefined }), [SYS.overpass, SYS.overpassProvider, SYS.overpassBypass], ''],
  ];
  for (const [name, roster, ids] of cases) {
    const entries = buildSystemTab(roster, ui(), 120).entries;
    for (const id of ids) {
      const e = entries.find((x) => x.id === id)!;
      assert.ok(e, `${name}: ${id} is still listed`);
      assert.equal(e.cursorable, false, `${name}: ${id} holds no cursor index`);
      assert.equal(e.action, undefined);
      assert.match(e.row.lines[0].text, id === SYS.autoMerge ? /\(acts only in work mode\)$/ : /\(work mode on OpenCode only\)$/, `${name}: ${id} says why`);
      assert.equal(e.row.lines[0].kind, 'meta', 'dimmed');
      assert.equal(e.row.lines[0].selected, undefined, 'never selected');
    }
    // no cursor stop and no key reaches them: ENTER and SPACE at every cursor position emit nothing of theirs
    const live = entries.filter((x) => x.cursorable).length;
    for (let c = 0; c < live + 3; c++) {
      for (const name2 of ['ENTER', 'SPACE']) {
        const types = press(roster, c, name2).effects.map((x) => x.type);
        for (const t of types) assert.ok(!(ids.includes(SYS.autoMerge) && t === 'auto_merge_toggle') && !t.startsWith('overpass'), `${name}: cursor ${c} ${name2} → ${t}`);
      }
    }
  }
});

test('the same settings are live in work mode on OpenCode: cursorable, with an effect', () => {
  const roster = snap();
  for (const id of [SYS.autoMerge, SYS.overpass, SYS.overpassProvider, SYS.overpassBypass]) {
    const e = buildSystemTab(roster, ui(), 120).entries.find((x) => x.id === id)!;
    assert.equal(e.cursorable, true, id);
    assert.equal(e.disabled, undefined);
  }
  assert.deepEqual(press(roster, at(roster, SYS.autoMerge), 'ENTER').effects, [{ type: 'auto_merge_toggle', enabled: false }]);
});

// One rule for every on/off setting (decision system-tab-redesign-one-agent-table-every-agent-every-host-settings-section):
// unset flips from the setting's default; exactly ON turns OFF; exactly OFF turns ON; anything else (an invalid value,
// an unreadable config) turns OFF, never ON on a guess. The project mode follows it with hobby as its OFF side.
test('toggle rule: an invalid or unreadable value turns the setting OFF, unset flips from its default, ON and OFF flip', () => {
  const toggles: Array<[string, string, string, boolean]> = [
    // id, effect type, snapshot field, default
    [SYS.tdd, 'tdd_toggle', 'tdd', true],
    [SYS.sparringEnabled, 'sparring_toggle', 'sparringPartner', true],
  ];
  const enabledOf = (roster: AgentRosterSnapshot, id: string): unknown => (press(roster, at(roster, id), 'ENTER').effects[0] as { enabled?: unknown }).enabled;
  for (const [id, , field] of toggles) {
    assert.equal(enabledOf(snap({ [field]: { enabled: true } }), id), false, `${id}: ON → OFF`);
    assert.equal(enabledOf(snap({ [field]: { enabled: false } }), id), true, `${id}: OFF → ON`);
    assert.equal(enabledOf(snap({ [field]: { enabled: 'yes' } }), id), false, `${id}: invalid → OFF`);
    assert.equal(enabledOf(snap({ [field]: { enabled: 0 } }), id), false, `${id}: a falsy non-boolean → OFF, not ON`);
    assert.equal(enabledOf(snap({ [field]: {} }), id), false, `${id}: unset flips from its default (ON)`);
  }
  assert.equal(enabledOf(snap({ handoff: false }), SYS.handoff), true);
  assert.equal(enabledOf(snap({ handoff: true }), SYS.handoff), false);
  assert.equal(enabledOf(snap({ handoff: 'maybe' }), SYS.handoff), false, 'handoff: invalid → OFF');
  assert.equal(enabledOf(snap({ handoff: null }), SYS.handoff), false, 'handoff: unreadable → OFF');
  assert.equal(enabledOf(snap({ handoff: undefined }), SYS.handoff), true, 'handoff: unset flips from OFF');
  assert.equal(enabledOf(snap({ autoMergeOnClean: false }), SYS.autoMerge), true);
  assert.equal(enabledOf(snap({ autoMergeOnClean: 'x' }), SYS.autoMerge), false, 'auto-merge: invalid → OFF');
  assert.equal(enabledOf(snap({ autoMergeOnClean: null }), SYS.autoMerge), false, 'auto-merge: unreadable → OFF');
  assert.equal(enabledOf(snap({ autoMergeOnClean: undefined }), SYS.autoMerge), false, 'auto-merge: unset flips from ON');
  assert.equal(enabledOf(snap({ overpass: view({ enabled: false }) }), SYS.overpass), true);
  assert.equal(enabledOf(snap({ overpass: view({ enabled: '"yes"' as never }) }), SYS.overpass), false, 'overpass: invalid → OFF');
  assert.equal(enabledOf(snap({ overpass: view({ conductorBypass: 2 as never }) }), SYS.overpassBypass), false, 'bypass: invalid → OFF');
  const modeTo = (mode: unknown): unknown => (press(snap({ mode }), at(snap({ mode }), SYS.mode), 'ENTER').effects[0] as { mode?: unknown }).mode;
  assert.equal(modeTo('hobby'), 'work');
  assert.equal(modeTo('work'), 'hobby');
  assert.equal(modeTo('later'), 'hobby', 'mode: invalid → hobby, its OFF side');
  assert.equal(modeTo(null), 'hobby', 'mode: unreadable → hobby');
});
