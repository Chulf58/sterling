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
    // every governed role counts as installed here (System tab lists installed roles only, issue #307)
    hostInstalled: ['implementor', 'implementor-hard', 'researcher', 'scout', 'librarian', 'reviewer', 'sparring', 'preflight'] as string[],
    configModels: { implementor: { model: 'claude-opus-5-5', effort: 'medium' } },
    catalog: { present: true, stale: false, staleDate: null, entries: [] },
    codexWired: true,
    sparringPartner: { enabled: true },
    tdd: { enabled: true },
    mode: 'work', // the auto-merge row is disabled in hobby mode
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
  const entries = buildSystemTab(snap, st({ tab: SYSTEM_TAB }), 200).entries;
  assert.equal(entries.some((e) => e.id === 'sys:storage' && e.cursorable), false, 'the storage row holds no cursor stop');
  const cursorable = entries.filter((e) => e.cursorable);
  const last = cursorable.length - 1;
  assert.equal(cursorable[last].id, 'sys:pr_auto_merge', 'in work mode the auto-merge setting is the last selectable row');
  // DOWN from the real last selectable row (work mode) stays there: the storage row adds no stop below it
  const down = reduce({} as SterlingStore, st({ tab: SYSTEM_TAB, cursor: last }), { kind: 'key', name: 'DOWN' }, undefined, undefined, snap);
  assert.equal(down.ui.cursor, last);
  // DOWN does move the cursor everywhere else, so the event reaches the reducer
  const moved = reduce({} as SterlingStore, st({ tab: SYSTEM_TAB, cursor: last - 1 }), { kind: 'key', name: 'DOWN' }, undefined, undefined, snap);
  assert.equal(moved.ui.cursor, last);
  for (let c = 0; c <= last; c++) {
    assert.notEqual(buildSystemTab(snap, st({ cursor: c }), 200).storageRows[0].lines[0].selected, true);
  }
  // ENTER on the last selectable row acts on THAT row, never on storage
  const enter = reduce({} as SterlingStore, st({ tab: SYSTEM_TAB, cursor: last }), { kind: 'key', name: 'ENTER' }, undefined, undefined, snap);
  const action = cursorable[last].action;
  assert.equal(action?.kind, 'toggle');
  assert.deepEqual(enter.effects, [(action as { effect: unknown }).effect], 'ENTER flips the auto-merge setting');
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
  for (const junk of ['null', '[]', 'false', '0', '""', '5']) {
    assert.equal(await rosterStorage(junk), null, `a config of ${junk} parses but is not an object: UNKNOWN, never the SQLite default`);
  }
});

// Startup is where an unrecognized config.storage is refused: every store open refuses it
// (fail loud, P5), so openDashboard throws before any row exists. main.ts lets that throw
// reach the terminal, so the message is what the user reads. It must name the key, the raw
// value and the valid values. The UNRECOGNIZED and UNKNOWN rows above cover a config that
// changes while the TUI is already running.
test('openDashboard refuses an unrecognized config.storage at startup, naming the key, the raw value and the valid values', () => {
  for (const [raw, shown] of [['"mysql"', '"mysql"'], ['5', '5'], ['"Postgres"', '"Postgres"']] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'sterling-tui-refuse-'));
    try {
      mkdirSync(join(dir, '.sterling'), { recursive: true });
      writeFileSync(join(dir, '.sterling', 'config.json'), `{"storage":${raw}}`);
      assert.throws(
        () => openDashboard(join(dir, '.sterling', 'sterling.db')),
        (e: unknown) => {
          const err = e as Error;
          assert.equal(err.name, 'StoreSettingsError');
          assert.ok(err.message.includes(`config.storage is ${shown}`), err.message);
          assert.ok(err.message.includes("must be 'sqlite' or 'postgres'"), err.message);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
