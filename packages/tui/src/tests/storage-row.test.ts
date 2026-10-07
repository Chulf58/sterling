import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_TAB, buildSystemTab, initialUi, reduce, type AgentRosterSnapshot, type UiState } from '../state.js';
import { SterlingStore } from '@sterling/store';
import { openDashboard } from '../controller.js';

// System-tab Storage row (board 6ca1a3c5, decision
// storage-backend-is-its-own-config-key-written-only-by-store-move). READ-ONLY
// row, id 'sys:storage', in view.storageRows. Four separate states, using store
// routing's rule: absent → SQLite, 'sqlite' → SQLite, 'postgres' → Served
// Postgres, anything else → UNRECOGNIZED with the raw value (never SQLite);
// null (unreadable config) → UNKNOWN, never the default. It is not a toggle:
// no cursor index, no effect.

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

function snapshot(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [],
    configModels: { implementor: { model: 'claude-opus-5-5', effort: 'medium' } },
    catalog: { present: true, stale: false, staleDate: null, entries: [] },
    codexWired: true,
    sparringPartner: { enabled: true },
    tdd: { enabled: true },
    mode: 'hobby',
    handoff: false,
    ...over,
  };
}

const storageText = (snap: AgentRosterSnapshot, ui: UiState = st()): string => {
  const rows = buildSystemTab(snap, ui, 200).storageRows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'sys:storage');
  assert.equal(rows[0].lines.length, 1);
  return rows[0].lines[0].text;
};

test('Storage row: postgres reads SERVED POSTGRES', () => {
  const text = storageText(snapshot({ storage: 'postgres' }));
  assert.match(text, /Storage: SERVED POSTGRES \(read-only; switch with the move-store skill\)/);
  assert.doesNotMatch(text, /SQLITE/);
});

test('Storage row: absent and explicit sqlite both read SQLITE, told apart by the bracket', () => {
  assert.match(storageText(snapshot({ storage: undefined })), /Storage: SQLITE \(not set\) \(read-only/);
  const explicit = storageText(snapshot({ storage: 'sqlite' }));
  assert.match(explicit, /Storage: SQLITE \(read-only/);
  assert.doesNotMatch(explicit, /not set/);
});

test('Storage row: an unrecognized value reads UNRECOGNIZED with the raw value, never SQLite', () => {
  const text = storageText(snapshot({ storage: 'mysql' }));
  assert.match(text, /Storage: UNRECOGNIZED \(mysql\)/);
  assert.doesNotMatch(text, /SQLITE|SERVED POSTGRES/);
  assert.match(storageText(snapshot({ storage: '5' })), /UNRECOGNIZED \(5\)/);
});

test('Storage row: an unreadable config reads UNKNOWN, never the SQLite default', () => {
  const text = storageText(snapshot({ storage: null }));
  assert.match(text, /Storage: UNKNOWN \(config unreadable\)/);
  assert.doesNotMatch(text, /SQLITE/);
});

test('Storage row is read-only: never selected, no cursor index, no effect, hidden under a model picker', () => {
  const snap = snapshot({ storage: 'postgres' });
  const keys = Object.keys(snap.configModels).length;
  // The cursor clamp still ends at the handoff row (keys + 4); the storage row adds no stop.
  const down = reduce({} as SterlingStore, st({ tab: 4, cursor: keys + 4 }), { type: 'key', key: 'DOWN' } as never, undefined, undefined, snap);
  assert.equal(down.ui.cursor, keys + 4);
  for (let c = 0; c <= keys + 5; c++) {
    assert.notEqual(buildSystemTab(snap, st({ cursor: c }), 200).storageRows[0].lines[0].selected, true);
  }
  const enter = reduce({} as SterlingStore, st({ tab: 4, cursor: keys + 4 }), { type: 'key', key: 'ENTER' } as never, undefined, undefined, snap);
  assert.deepEqual(enter.effects.filter((e) => /storage/.test(JSON.stringify(e))), []);
  const picker = buildSystemTab(snap, st({ selector: { key: 'implementor', stage: 'model', highlight: 0 } }), 200);
  assert.deepEqual(picker.storageRows, []);
});

// The store is opened on a plain config first, then config.json is rewritten before
// the System tab activates: the roster reads the file on activation, and a store
// whose config says 'postgres' or junk would otherwise be routed or refused at open.
const VP = { width: 100, maxBodyLines: 40, showBanner: false };

async function rosterStorage(rawConfig: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tui-storage-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const configPath = join(dir, '.sterling', 'config.json');
  writeFileSync(configPath, JSON.stringify({ tdd: { enabled: true } }));
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'));
  try {
    writeFileSync(configPath, rawConfig);
    await ctl.handle({ kind: 'tab', index: SYSTEM_TAB }, VP);
    return ctl.roster()?.storage;
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the controller reads config.storage RAW for the row, keeping the four states separate', async () => {
  assert.equal(await rosterStorage('{"storage":"postgres"}'), 'postgres');
  assert.equal(await rosterStorage('{"storage":"sqlite"}'), 'sqlite');
  assert.equal(await rosterStorage('{"tdd":{"enabled":true}}'), undefined, 'absent stays undefined (SQLite default)');
  assert.equal(await rosterStorage('{"storage":"mysql"}'), 'mysql');
  assert.equal(await rosterStorage('{"storage":5}'), '5', 'a non-string value comes back as its JSON text');
  assert.equal(await rosterStorage('{ not json'), null, 'an unreadable config is null (UNKNOWN)');
  for (const junk of ['[]', 'false', '0', '""', '5']) {
    assert.equal(await rosterStorage(junk), null, `a config of ${junk} parses but is not an object: UNKNOWN, never the SQLite default`);
  }
});
