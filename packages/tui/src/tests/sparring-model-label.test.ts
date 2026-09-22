import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { initialUi, type UiState } from '../state.js';
import * as stateMod from '../state.js';
import * as viewmodel from '../viewmodel.js';

// ===========================================================================
// SPARRING MODEL ROW — LABEL + COMMIT NOTICE (board 7423f7a2 slice 5, item 2;
// decision foreign_8b329d57 'codex-resumed-pinned-gpt-5-6-sol-server-side' as corrected
// forward; decision foreign_ea68735d 'sparring-partner-partnership-shape' point 8).
//
// SPEC-ONLY ORACLE, written blind: no state.ts / main.ts / viewmodel.ts was
// read. The row-builder API (buildSystemTab → view.sparringRows, [0] toggle /
// [1] model; reduce(store, ui, event, viewport?, knowledge?, roster?); the
// sparring_model commit effect) is copied as a CONVENTION from the sibling
// oracle packages/tui/src/tests/sparring-partner.test.ts — its assertions are
// not duplicated and that file is untouched.
//
// WHAT THIS FILE OWNS (and sparring-partner.test.ts does not):
//   • the model row's LABEL is 'Default Codex model', not a bare 'Model'. The
//     word DEFAULT is the load-bearing part: the value is what a consult gets
//     when the call names no model — an explicit call-site model still wins
//     (H20 injection, pinned in scripts/tests/h20-consult-model-injection.test.mjs
//     M-1), and a running codex-reply thread keeps its opener's model because
//     that tool's schema has no model field (research_finding foreign_be284452).
//   • committing a model raises a ui.notice stating both of those limits, at
//     the moment the user sets the value — the user's report was "it just says
//     default and doesn't work", so the row must now say what it actually does.
//
// The '(CLI default)' placeholder for an unset value is FROZEN behaviour
// (sparring-partner.test.ts 'sparring 3') — re-pinned here only to prove the
// label rename did not take the placeholder with it.
//
// SABOTAGE DISCIPLINE: each test names the one-line change that must redden it.
// ===========================================================================

const SYS_TAB = 3;

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

interface CatalogEntry {
  id: string;
  label: string;
  tier: string;
  status: string;
}
interface CatalogStatusView {
  present: boolean;
  stale: boolean;
  staleDate: string | null;
  entries: CatalogEntry[];
}
interface RosterAgent {
  name: string;
  installedModel: string;
  installedEffort: string;
}
interface AgentRosterSnapshot {
  agents: RosterAgent[];
  configModels: Record<string, { model: string; effort: string }>;
  catalog: CatalogStatusView;
  codexWired: boolean;
  sparringPartner: { enabled: boolean; model?: string };
}

interface SystemLine {
  text: string;
  kind?: string;
  selected?: boolean;
}
interface SystemRow {
  id: string;
  key?: string;
  drift?: boolean;
  agents?: string[];
  lines: SystemLine[];
}
interface SystemTabView {
  rows: SystemRow[];
  banner: string | string[];
  sparringRows?: SystemRow[];
}

const stateNs = stateMod as unknown as Record<string, unknown>;
const vmNs = viewmodel as unknown as Record<string, unknown>;
function resolve(name: string): unknown {
  return stateNs[name] !== undefined ? stateNs[name] : vmNs[name];
}
const buildSystemTab = resolve('buildSystemTab') as
  | ((snap: AgentRosterSnapshot, ui: UiState, width?: number) => SystemTabView)
  | undefined;

interface SystemArityStateMod {
  reduce: (
    store: SterlingStore,
    ui: UiState,
    event: unknown,
    viewport?: unknown,
    knowledge?: unknown,
    roster?: AgentRosterSnapshot,
  ) => { ui: UiState; effects: { type: string }[] };
}
const SR = stateMod as unknown as SystemArityStateMod;

const REVIEWER_AGENTS = ['reviewer-correctness', 'reviewer-security', 'reviewer-skeptic', 'reviewer-performance'];

function freshCatalog(): CatalogStatusView {
  return {
    present: true,
    stale: false,
    staleDate: null,
    entries: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet', status: 'active' },
    ],
  };
}

function baseSnapshot(over: Partial<AgentRosterSnapshot> = {}): AgentRosterSnapshot {
  return {
    agents: [
      { name: 'coder', installedModel: 'claude-sonnet-4-6', installedEffort: 'high' },
      ...REVIEWER_AGENTS.map((name) => ({ name, installedModel: 'claude-opus-4-8', installedEffort: 'low' })),
    ],
    configModels: {
      coder: { model: 'claude-sonnet-4-6', effort: 'high' },
      reviewers: { model: 'claude-opus-4-8', effort: 'low' },
      coder_hard: { model: 'claude-opus-4-8', effort: 'xhigh' },
      classifiers: { model: 'claude-haiku-4-5', effort: 'low' },
    },
    catalog: freshCatalog(),
    codexWired: true,
    sparringPartner: { enabled: true, model: undefined },
    ...over,
  };
}

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sparring-label-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function rowText(row: SystemRow): string {
  return row.lines.map((l) => l.text).join(' ');
}
function modelRowText(view: SystemTabView): string {
  return rowText((view.sparringRows ?? [])[1]);
}

const key = (name: string) => ({ kind: 'key', name });
const charEv = (ch: string) => ({ kind: 'char', ch });

function drive(
  store: SterlingStore,
  ui: UiState,
  events: unknown[],
  roster?: AgentRosterSnapshot,
): { ui: UiState; effects: { type: string }[] } {
  let cur = ui;
  const all: { type: string }[] = [];
  for (const ev of events) {
    const r = SR.reduce(store, cur, ev, undefined, undefined, roster);
    cur = r.ui;
    for (const e of r.effects) all.push(e);
  }
  return { ui: cur, effects: all };
}

// ===========================================================================
// label 1 — the row is labelled 'Default Codex model', and the bare 'Model'
// label is REPLACED rather than supplemented.
// ===========================================================================

// SABOTAGE: revert the row label literal to 'Model' (one string) — red on the
// first assertion.
test("label 1: the sparring model row is labelled 'Default Codex model' — the bare 'Model' label is gone, not merely joined", () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported (frozen phase-4 oracle)');
  const view = buildSystemTab!(baseSnapshot({ sparringPartner: { enabled: true, model: 'gpt-5.6-sol' } }), st({ tab: SYS_TAB }), 80);
  const text = modelRowText(view);
  assert.match(
    text,
    /Default Codex model/i,
    "the row says DEFAULT: it is the model a consult gets when the call names none — an explicit call-site model still wins (decision 8b329d57, corrected-forward mechanism)", // not-a-citation: fixture id
  );
  const stripped = text.replace(/Default Codex model/gi, '');
  assert.doesNotMatch(
    stripped,
    /(^|\s)Model\b/i,
    "the old bare 'Model' label is replaced, not left beside the new one — two labels on one row is how a reader learns the wrong thing",
  );
  assert.match(text, /gpt-5\.6-sol/, 'the configured value is still shown verbatim beside the new label');
});

// ===========================================================================
// label 2 — the rename does NOT take the unset placeholder with it.
// ===========================================================================

// SABOTAGE: drop the '(CLI default)' placeholder branch when rewriting the row
// (render '' or '-' for an unset model) — red on the placeholder assertion.
test("label 2: with no model configured the row still shows '(CLI default)' under the new label", () => {
  assert.strictEqual(typeof buildSystemTab, 'function', 'buildSystemTab must be exported');
  const view = buildSystemTab!(baseSnapshot({ sparringPartner: { enabled: true, model: undefined } }), st({ tab: SYS_TAB }), 80);
  const text = modelRowText(view);
  assert.match(text, /Default Codex model/i, 'the new label is on the unset row too, not only when a value is set');
  assert.match(
    text,
    /\(CLI default\)/,
    "the unset placeholder is frozen behaviour (sparring-partner.test.ts 'sparring 3') and survives the rename — H20 injects nothing in this state, so the CLI default is literally what a consult gets",
  );
});

// ===========================================================================
// label 3 — committing a model raises the ui.notice that states the two limits.
// ===========================================================================

// SABOTAGE: delete the ui.notice assignment in the sparring_model commit branch
// — red on the notice assertions, while the CONTROL arm below (cancel → no
// notice) stays green either way, so a green here cannot be "notice is always
// set regardless of what happened".
test('label 3: committing a model sets a ui.notice saying explicit calls override it and existing Codex threads keep their opener\'s model', () => {
  const { store, cleanup } = storeFixture();
  try {
    const snap = baseSnapshot({ sparringPartner: { enabled: true, model: undefined } });
    const numKeys = Object.keys(snap.configModels).length;
    const ui0 = st({ tab: SYS_TAB, cursor: numKeys + 1 });

    // CONTROL FIRST (must pass for the OPPOSITE reason): an ESCAPEd edit commits
    // nothing, so it must NOT produce the override notice. Without this arm a
    // green below is equally explained by "the notice is set on every keypress".
    const cancelled = drive(store, ui0, [key('ENTER'), charEv('g'), charEv('p'), charEv('t'), key('ESCAPE')], snap);
    assert.equal(
      cancelled.effects.find((e) => e.type === 'sparring_model'),
      undefined,
      'control: ESCAPE commits nothing',
    );
    assert.doesNotMatch(
      cancelled.ui.notice ?? '',
      /overrid/i,
      'control: no commit, no override notice — the notice is tied to the COMMIT, not to opening the row',
    );

    const committed = drive(store, ui0, [key('ENTER'), charEv('g'), charEv('p'), charEv('t'), key('ENTER')], snap);
    const commit = committed.effects.find((e) => e.type === 'sparring_model') as { type: string; model?: string } | undefined;
    assert.ok(commit, 'ENTER commits a sparring_model effect (frozen: sparring-partner.test.ts item 6)');
    assert.equal(commit!.model, 'gpt', 'the committed buffer is the typed value — unchanged by this slice');

    const notice = committed.ui.notice ?? '';
    assert.notEqual(notice, '', 'a commit surfaces a notice — the user set a value and must be told what it governs');
    assert.match(
      notice,
      /overrid|explicit|call-site|call site/i,
      'the notice states that a model named on the call itself overrides this default (the H20 injection only fills an OMITTED model)',
    );
    assert.match(
      notice,
      /thread/i,
      "the notice names the thread limit: codex-reply carries no model field, so an in-flight thread keeps its opener's model (research_finding be284452)", // not-a-citation: fixture id
    );
    assert.match(
      notice,
      /existing|already|open|in progress|in-flight|opener/i,
      'the thread caveat is about EXISTING threads specifically — a bare mention of threads would not tell the user why their next reply still lands elsewhere',
    );
  } finally {
    cleanup();
  }
});
