// Tests restored from the pre-redesign System-tab suites (item-G review, loop 2 test audit), ported to the
// canonical layout: the behaviour still exists, only the old row layout went. Each names the main-branch
// test it replaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SterlingStore } from '@sterling/store';
import { buildSystemTab, initialUi, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type Effect, type UiEvent, type UiState } from '../state.js';
import { at, snap, SYS } from './system-nav.js';

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, tab: SYSTEM_TAB, ...over });
const allText = (s: AgentRosterSnapshot, ui: UiState = st(), width = 200): string[] => {
  const v = buildSystemTab(s, ui, width);
  return [...v.banner, ...v.entries.flatMap((e) => e.row.lines.map((l) => l.text))];
};
const rowText = (s: AgentRosterSnapshot, id: string, ui: UiState = st()): string => buildSystemTab(s, ui, 200).entries.find((e) => e.id === id)!.row.lines[0].text;

function drive(s: AgentRosterSnapshot, ui: UiState, events: UiEvent[]): { ui: UiState; effects: Effect[] } {
  const store = new SterlingStore(':memory:');
  try {
    let cur = ui;
    const effects: Effect[] = [];
    for (const ev of events) {
      const r = reduce(store, cur, ev, undefined, undefined, s);
      cur = r.ui;
      effects.push(...r.effects);
    }
    return { ui: cur, effects };
  } finally {
    store.close();
  }
}
const key = (name: string): UiEvent => ({ kind: 'key', name: name as never });
const ch = (c: string): UiEvent => ({ kind: 'char', ch: c } as UiEvent);

// system-tab.test.ts:511-530 on main: the catalog banner's three states.
test('catalog banner: an absent catalog is announced, a current one raises no stale line, a stale one carries its date', () => {
  const absent = buildSystemTab(snap({ catalog: { present: false, stale: false, staleDate: null, entries: [] } }), st(), 80).banner.join('\n');
  assert.match(absent, /catalog: none found/);
  const current = allText(snap(), st(), 80).join('\n');
  assert.doesNotMatch(current, /stale|none found/i);
  const stale = buildSystemTab(snap({ catalog: { present: true, stale: true, staleDate: '2026-01-15', entries: snap().catalog.entries } }), st(), 80).banner.join('\n');
  assert.match(stale, /stale/i);
  assert.match(stale, /2026-01-15/);
});

// system-tab.test.ts:734-751 on main: the 33-column floor, picker closed and open.
test('33-col floor: every System-tab line fits 33 columns with the picker closed and with it open', () => {
  const s = snap();
  for (const line of allText(s, st(), 33)) assert.ok(line.length <= 33, `closed: "${line}"`);
  const opened = drive(s, st({ cursor: at(s, 'sys:implementor') }), [key('ENTER')]);
  assert.ok(opened.ui.selector, 'the picker is open');
  const lines = allText(s, opened.ui, 33);
  assert.ok(lines.some((l) => /step 1 of 2/.test(l)), 'the open picker is drawn');
  for (const line of lines) assert.ok(line.length <= 33, `open: "${line}"`);
});

// tdd-mutation-toggles.test.ts:239-246 on main: the TDD row renders ON and OFF and names itself.
test('TDD row: ON when tdd.enabled is true, OFF when false, and the row identifies TDD', () => {
  const on = rowText(snap({ tdd: { enabled: true } }), SYS.tdd);
  assert.match(on, /\bON\b/);
  assert.match(on, /TDD/);
  const off = rowText(snap({ tdd: { enabled: false } }), SYS.tdd);
  assert.match(off, /\bOFF\b/);
  assert.match(off, /TDD/);
});

// overpass-toggle.test.ts:220-236 on main: keyboard editing of the Overpass provider.
test('Overpass provider: ENTER opens the edit prefilled; BACKSPACE and typed characters edit the buffer; navigation is a no-op while typing; ENTER commits', () => {
  const s = snap({ overpassProvider: 'overpass' });
  const cursor = at(s, SYS.overpassProvider);
  let r = drive(s, st({ cursor }), [key('ENTER')]);
  assert.equal(r.ui.overpassProviderEdit, 'overpass');
  assert.deepEqual(r.effects, []);
  assert.match(rowText(s, SYS.overpassProvider, r.ui), /Overpass provider: overpass▌$/, 'the buffer shows with a caret');
  r = drive(s, r.ui, [key('BACKSPACE')]);
  assert.equal(r.ui.overpassProviderEdit, 'overpas');
  r = drive(s, r.ui, [...'-agentic.v_2'].map(ch));
  assert.equal(r.ui.overpassProviderEdit, 'overpas-agentic.v_2', 'every printable key feeds the buffer');
  const nav = drive(s, r.ui, [key('DOWN'), key('UP')]);
  assert.equal(nav.ui.cursor, cursor, 'navigation keys do not move the cursor while typing');
  assert.equal(nav.ui.overpassProviderEdit, 'overpas-agentic.v_2');
  r = drive(s, r.ui, [key('ENTER')]);
  assert.deepEqual(r.effects, [{ type: 'overpass_provider', provider: 'overpas-agentic.v_2' }]);
  assert.equal(r.ui.overpassProviderEdit, undefined);
});

// overpass-toggle.test.ts:258-271 on main: cancelling the edit.
test('Overpass provider: ESCAPE cancels the edit with no effect, and switching tab drops it', () => {
  const s = snap({ overpassProvider: 'overpass' });
  const opened = drive(s, st({ cursor: at(s, SYS.overpassProvider) }), [key('ENTER')]);
  const esc = drive(s, { ...opened.ui, overpassProviderEdit: 'x/y' }, [key('ESCAPE')]);
  assert.equal(esc.ui.overpassProviderEdit, undefined);
  assert.deepEqual(esc.effects, []);
  const away = drive(s, { ...opened.ui, overpassProviderEdit: 'x' }, [{ kind: 'tab', index: 0 } as UiEvent]);
  assert.equal(away.ui.overpassProviderEdit, undefined);
  assert.deepEqual(away.effects, []);
});

// maintenance-worker-row.test.ts:220-226 on main, ported to the canonical agent rows: an unreadable config is
// disclosed on every agent row (the maintenance worker's included), never shown as unset, opens no picker and
// emits no write.
test('agent rows: an unreadable config is disclosed, not shown as unset; no row opens a picker or emits a write', () => {
  const s = snap({ configError: 'maintenance_worker is 5, not an object' });
  const v = buildSystemTab(s, st(), 200);
  const agentRows = v.entries.filter((e) => e.section === 'agents' && e.id.startsWith('sys:') && !e.id.startsWith('sys:heading') && !e.id.startsWith('sys:agents:'));
  const worker = agentRows.find((e) => e.id === 'sys:maintenance-worker');
  assert.ok(worker, 'the maintenance worker row is drawn');
  assert.match(worker!.row.lines[0].text, /UNKNOWN.*config unreadable: maintenance_worker is 5, not an object/);
  for (const e of agentRows) {
    assert.doesNotMatch(e.row.lines[0].text, /\(unset\)/, `${e.id} is not shown as unset`);
    assert.equal(e.cursorable, false, `${e.id} takes no cursor`);
  }
  const total = v.entries.filter((e) => e.cursorable).length;
  for (let c = 0; c < total; c++) {
    const r = drive(s, st({ cursor: c }), [key('ENTER')]);
    assert.equal(r.ui.selector, undefined, `cursor ${c}: no picker opens`);
    assert.deepEqual(r.effects.filter((e) => e.type === 'agent_model'), [], `cursor ${c}: no model write`);
  }
});
