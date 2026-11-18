import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SterlingStore } from '@sterling/store';
import { buildDashboardState, initialUi, reduce, SYSTEM_TAB, type AgentRosterSnapshot, type Effect, type OverpassView, type UiEvent, type UiState } from '../state.js';

// System tab: what the screen draws (every row's text and selection marker) and what ENTER/SPACE do (effects and
// the UI patch) at every cursor index, for representative fixtures.
// Item 1 of the redesign (a refactor) generated it from the code before the refactor and matched it byte for byte.
// Item 2 (2026-11-18) regenerated it deliberately. The visible changes it captures: 'Agents' and 'Settings'
// headings; group labels (Sparring, Workflow, Overpass, Storage) in the Settings section; the Overpass rows
// listed in every fixture, dimmed with '(work mode on OpenCode only)' when not offered; the PR auto-merge row
// dimmed with '(acts only in work mode)' in hobby mode and no longer a cursor stop there; the Maintenance worker
// row without its 'claude CLI, when on PATH' line. Regenerate only on a deliberate change:
//   UPDATE_SYSTEM_SNAPSHOT=1 node --test packages/tui/dist/tests/system-tab-snapshot.test.js
const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tests', 'system-tab-snapshot.json');

const ALL = ['implementor', 'implementor-hard', 'researcher', 'scout', 'librarian', 'reviewer', 'sparring', 'preflight'];
const view = (over: Partial<OverpassView> = {}): OverpassView => ({ enabled: false, provider: 'overpass', conductorBypass: false, effective: false, ...over });

function base(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [
      { name: 'implementor', installedModel: 'claude-sonnet-5-5', installedEffort: 'high' },
      { name: 'scout', installedModel: 'claude-opus-5-5', installedEffort: 'low' },
    ],
    hostInstalled: ALL,
    opencodeInstalled: ['implementor'],
    agyInstalled: ['implementor', 'scout'],
    configModels: {
      implementor: { model: 'claude-sonnet-5-5', effort: 'high', opencode_model: 'openai/gpt-5.6-terra', agy_model: 'flash' },
      scout: { model: 'claude-sonnet-5-5', effort: 'low' },
      reviewer: { model: 'claude-opus-5-5', effort: 'high' },
    },
    catalog: {
      present: true, stale: false, staleDate: null,
      entries: [
        { id: 'claude-opus-5-5', label: 'Opus 5.5', tier: 'opus', status: 'active', vendor: 'anthropic' },
        { id: 'gpt-5.6-terra', label: 'Terra', tier: 'gpt', status: 'active', vendor: 'openai' },
      ],
    },
    codexWired: true,
    sparringPartner: { enabled: true, model: 'gpt-x' },
    tdd: { enabled: true },
    mode: 'hobby',
    handoff: false,
    storage: undefined,
    autoMergeOnClean: true,
    ...over,
  } as AgentRosterSnapshot;
}

const FIXTURES: Record<string, { roster: AgentRosterSnapshot; ui?: Partial<UiState> }> = {
  'hobby plain': { roster: base() },
  'work, opencode, overpass off': { roster: base({ mode: 'work', host: 'opencode', overpass: view() } as Partial<AgentRosterSnapshot>) },
  'work, opencode, overpass on': { roster: base({ mode: 'work', host: 'opencode', overpass: view({ enabled: true, effective: true, conductorBypass: true }) } as Partial<AgentRosterSnapshot>) },
  'agy installed': { roster: base({ agy: true }) },
  'custom and storage rows': {
    roster: base({
      storage: 'sqlite',
      customAgents: [{ name: 'helper', source: 'claude', model: 'claude-haiku-5' }, { name: 'broken', source: 'agy', error: 'frontmatter is not closed' }],
    } as Partial<AgentRosterSnapshot>),
  },
  'model picker open': { roster: base({ agy: true }), ui: { selector: { key: 'implementor', stage: 'model', highlight: 1 } } },
  'effort picker open': { roster: base(), ui: { selector: { key: 'scout', stage: 'effort', highlight: 2, model: 'claude-opus-5-5' } } },
  'overpass tier picker open': {
    roster: base({ mode: 'work', host: 'opencode', overpass: view({ enabled: true, effective: true }) } as Partial<AgentRosterSnapshot>),
    ui: { selector: { key: 'implementor', stage: 'tier', highlight: 0 } },
  },
  'sparring model edit': { roster: base(), ui: { sparringModelEdit: 'typed' } },
  'notice banner': { roster: base(), ui: { notice: 'something happened' } },
};

function withStore<T>(fn: (store: SterlingStore) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-system-snapshot-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const key = (name: string): UiEvent => ({ kind: 'key', name }) as UiEvent;
const uiPatchOf = (a: UiState, b: UiState): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof UiState>) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = b[k] ?? null;
  }
  return out;
};

function capture(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  withStore((store) => {
    for (const [name, f] of Object.entries(FIXTURES)) {
      const per: Record<string, unknown> = {};
      for (let cursor = 0; cursor <= 16; cursor++) {
        const ui: UiState = { ...initialUi, tab: SYSTEM_TAB, cursor, ...(f.ui ?? {}) };
        const state = buildDashboardState(store, ui, 100, Infinity, '', false, undefined, f.roster);
        const enter = reduce(store, ui, key('ENTER'), undefined, undefined, f.roster);
        const space = reduce(store, ui, key('SPACE'), undefined, undefined, f.roster);
        per[`cursor ${cursor}`] = {
          rows: state.rows.map((r) => ({ id: r.id, screenRow: r.screenRow, selected: r.selected, lines: r.lines.map((l) => `${l.kind}|${l.text}`) })),
          enter: { effects: enter.effects as Effect[], ui: uiPatchOf(ui, enter.ui) },
          space: { effects: space.effects as Effect[], ui: uiPatchOf(ui, space.ui) },
        };
      }
      // navigation: where the cursor lands after keys from the top
      const walk = (names: string[]): number => {
        let ui: UiState = { ...initialUi, tab: SYSTEM_TAB, ...(f.ui ?? {}) };
        for (const n of names) ui = reduce(store, ui, key(n), undefined, undefined, f.roster).ui;
        return ui.cursor;
      };
      per.navigation = {
        down25: walk(Array(25).fill('DOWN')),
        end: walk(['END']),
        endUp: walk(['END', 'UP']),
        home: walk(['END', 'HOME']),
        pageDown: walk(['PAGE_DOWN']),
      };
      out[name] = per;
    }
  });
  return JSON.parse(JSON.stringify(out));
}

test('the System tab draws and acts exactly as it did before the single-list refactor (rows, selection, ENTER/SPACE effects, navigation)', () => {
  const now = capture();
  if (process.env.UPDATE_SYSTEM_SNAPSHOT === '1' || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 1) + '\n');
    return;
  }
  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, Record<string, unknown>>;
  for (const name of Object.keys(FIXTURES)) {
    for (const k of Object.keys((now as Record<string, Record<string, unknown>>)[name])) {
      assert.deepEqual((now as Record<string, Record<string, unknown>>)[name][k], expected[name][k], `${name}: ${k}`);
    }
  }
  assert.deepEqual(Object.keys(now), Object.keys(expected));
});
