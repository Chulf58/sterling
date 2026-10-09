import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { buildDashboardState, initialUi, reduce, ARTICLE_STATE_FILTERS, KNOWLEDGE_TAB, STATE_GLYPHS, type UiState } from '../state.js';
import { keyToEvent } from '../render.js';
import { toCard } from '../viewmodel.js';

const NOW = '2026-06-10T12:00:00.000Z';
const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

function articleRec(slug: string, state: string, over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug, title: `${slug} title`, what_it_does: 'does a thing', intended_behavior: 'behaves',
    files: [{ path: 'packages/tui/src/viewmodel.ts', role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state, version: 1,
    history: [{ date: NOW, event: 'seeded' }], live_test_refs: [],
    ...over,
  };
}
function decisionRec() {
  return {
    id: randomUUID(), type: 'decision', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    title: 'A ruling', statement: 'we do X', rationale: 'because', alternatives_rejected: [],
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-article-state-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  store.create(articleRec('built-one', 'built'));
  store.create(articleRec('active-one', 'active'));
  store.create(articleRec('dormant-one', 'dormant', { state_reason: 'parked', wiring_todo_id: randomUUID() }));
  store.create(decisionRec());
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const EXPANDED = ['cat:feature_article', 'src:feature_article:project', 'cat:decision', 'src:decision:project'];
const titles = (s: ReturnType<typeof buildDashboardState>) => s.rows.map((r) => r.lines[0]!.text);

test('article state: toCard carries state for a feature_article and nothing for other types', () => {
  assert.equal(toCard(articleRec('a', 'wired_in')).state, 'wired_in');
  assert.equal(toCard(decisionRec()).state, undefined);
});

test('article state: the Knowledge tab shows a state column on article rows and nothing on other rows', () => {
  const { store, cleanup } = fixture();
  try {
    const lines = titles(buildDashboardState(store, st({ tab: KNOWLEDGE_TAB, expanded: EXPANDED })));
    // the state column is one glyph and a space (board c533a872: a 12-column tag did not fit a narrow pane)
    assert.ok(lines.find((l) => l.includes('built-one title'))!.endsWith(`${STATE_GLYPHS.built} built-one title`));
    assert.ok(lines.find((l) => l.includes('dormant-one title'))!.endsWith(`${STATE_GLYPHS.dormant} dormant-one title`));
    const ruling = lines.find((l) => l.includes('A ruling'))!;
    assert.ok(Object.values(STATE_GLYPHS).every((g) => !ruling.includes(g)), 'a non-article row carries no state column');
  } finally {
    cleanup();
  }
});

test('article state: ctrl-f is translated to STATE_FILTER and cycles all -> each state -> all, Knowledge tab only', () => {
  assert.deepEqual(ARTICLE_STATE_FILTERS, ['all', 'planned', 'built', 'wired_in', 'active', 'dormant', 'deprecated']);
  assert.deepEqual(keyToEvent('CTRL_F'), { kind: 'key', name: 'STATE_FILTER' });
  const { store, cleanup } = fixture();
  try {
    const ev = keyToEvent('CTRL_F')!;
    let ui = st({ tab: KNOWLEDGE_TAB, cursor: 3, scroll: 2 });
    const seen: (string | undefined)[] = [];
    for (let i = 0; i < ARTICLE_STATE_FILTERS.length; i++) {
      ui = reduce(store, ui, ev, {}).ui;
      seen.push(ui.stateFilter);
    }
    assert.deepEqual(seen, ['planned', 'built', 'wired_in', 'active', 'dormant', 'deprecated', undefined], 'cycles through every state then back to all');
    assert.equal(reduce(store, st({ tab: KNOWLEDGE_TAB, cursor: 3 }), ev, {}).ui.cursor, 0, 'cursor resets when the filter changes');
    assert.equal(reduce(store, st({ tab: 0 }), ev, {}).ui.stateFilter, undefined, 'inert outside the Knowledge tab');
  } finally {
    cleanup();
  }
});

test('article state: a state filter keeps only matching articles, leaves other types, and is shown on the search line', () => {
  const { store, cleanup } = fixture();
  try {
    const s = buildDashboardState(store, st({ tab: KNOWLEDGE_TAB, expanded: EXPANDED, stateFilter: 'built' }));
    const lines = titles(s);
    assert.ok(lines.some((l) => l.includes('built-one title')));
    assert.ok(!lines.some((l) => l.includes('active-one title')));
    assert.ok(!lines.some((l) => l.includes('dormant-one title')));
    assert.ok(lines.some((l) => l.includes('A ruling')), 'non-article rows are not filtered');
    assert.match(s.searchLine ?? '', /state: built/);
    const all = buildDashboardState(store, st({ tab: KNOWLEDGE_TAB, expanded: EXPANDED }));
    assert.doesNotMatch(all.searchLine ?? '', /state:/, 'no filter indicator while showing all');
  } finally {
    cleanup();
  }
});

test('article state: the filter also applies to search results', () => {
  const { store, cleanup } = fixture();
  try {
    const lines = titles(buildDashboardState(store, st({ tab: KNOWLEDGE_TAB, searchQuery: 'does', stateFilter: 'active' })));
    assert.ok(lines.some((l) => l.includes('active-one title')));
    assert.ok(!lines.some((l) => l.includes('built-one title')));
  } finally {
    cleanup();
  }
});
