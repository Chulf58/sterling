
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { buildDashboardState, initialUi, nodesFor } from '../state.js';
import * as viewmodel from '../viewmodel.js';

// ===========================================================================
// SPEC PIN (board c6e3561f arm 2, lane A2 fixer pass) — the Knowledge tab must
// carry the `inbound_supersedes` disclosure for an EXPANDED knowledge card by
// EVERY route that can render it (category tree AND search), and must pay a
// reverse-edge query only for cards that are actually RENDERED.
//
// THE FIXTURE IS THE POINT. An earlier version of this file built its fixtures
// with `store.supersede(oldId, newRecord)`, which RETIRES the target — and a
// retired record is filtered out of every tree/search query by the store's
// base filter (`packages/store/src/index.ts:1615`, "r.status != 'superseded'"),
// so the card never appears and those pins could not be satisfied. That is what
// produced the (false) conclusion that this code path is DORMANT.
//
// The LIVE route, traced by outside-family review and re-verified at HEAD
// 0e01c42:
//   - knowledge_create accepts caller-provided links[] (mcp-server/src/tools.ts);
//   - a full-uuid target is deliberately NOT existence-rechecked or rewritten;
//   - SterlingStore.create() (index.ts:881) validates no link target and passes
//     links straight to insertRecord();
//   - insertRecord() writes EVERY link, rel:'supersedes' included, into
//     record_relations WITHOUT retiring the target (index.ts:2708).
// So an ACTIVE, query-visible record CAN hold an inbound supersedes edge, and
// SterlingStore.inboundSupersedes(target) returns its holder. Fixtures here
// therefore create the holder with `links: [{rel:'supersedes', target_id}]`
// and NEVER call supersede().
//
// RENDER SURFACE (verified): the disclosure is appended to `card.body`, which
// becomes the wrapped kind:'body' lines of an expanded knowledge card. The
// trailing kind:'meta' line is built SOLELY from `card.detail`, so a pin
// asserting the disclosure there is red even when the feature works (PIN 2).
// ===========================================================================

const NOW = '2026-08-27T12:00:00.000Z';
const KNOW_TAB = 1;
const DISCLOSURE = /Superseded by \(inbound\)/;

type Ui = typeof initialUi;
const st = (over: Partial<Ui> = {}): Ui => ({ ...initialUi, ...over });

function envelope(type: string) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [] as { rel: string; target_id: string }[],
    scope: 'project',
    stack_tags: [] as string[],
  };
}

function decisionRec(over: Record<string, unknown> = {}) {
  return {
    ...envelope('decision'),
    title: 'a decision',
    statement: 'a statement',
    rationale: 'a rationale',
    alternatives_rejected: [] as { option: string; reason: string }[],
    ...over,
  };
}

/** feature_article carries FOUR required members an ad-hoc fixture forgets:
 *  current_ac, history and live_test_refs are all required arrays, and
 *  dependencies needs BOTH relies_on and relied_by
 *  (packages/schemas/src/records.ts:73, 109, 125, 126). Omitting them makes
 *  store.create throw a ZodError ("expected array") before any TUI code runs —
 *  which is exactly how revision 1's FINDING 2 (d) arm failed. Mirrors
 *  state.test.ts's featureArticleRec. */
function articleRec(over: Record<string, unknown> = {}) {
  return {
    ...envelope('feature_article'),
    slug: `slug-${randomUUID().slice(0, 8)}`,
    title: 'an article',
    what_it_does: 'does a thing',
    intended_behavior: 'behaves',
    files: [] as { path: string; role: string }[],
    current_ac: [{ ac_id: 'AC1', text: 'it works', verifiable_at: 'final' }],
    dependencies: { relies_on: [] as string[], relied_by: [] as string[] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seeded' }],
    live_test_refs: [] as { ac_id: string; test_paths: string[] }[],
    ...over,
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-inbound-supersedes-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, cleanup };
}

/** The live shape: an ACTIVE target plus an ACTIVE holder whose links carry a
 *  raw rel:'supersedes' edge onto it (clause/partial override, board c6e3561f
 *  arm 1). Neither record is retired, so both stay query-visible. */
function activeInboundEdge(store: SterlingStore, targetOver: Record<string, unknown> = {}) {
  const target = store.create(decisionRec({ title: 'the target decision', ...targetOver })) as { id: string };
  const holder = store.create(
    decisionRec({
      title: 'the clause-level override',
      statement: 'overrides one clause of the target',
      links: [{ rel: 'supersedes', target_id: target.id }],
    }),
  ) as { id: string };
  return { target, holder };
}

const bodyLines = (row: { lines: { text: string; kind: string }[] }): string[] =>
  row.lines.filter((l) => l.kind === 'body').map((l) => l.text);
const bodyText = (row: { lines: { text: string; kind: string }[] }): string => bodyLines(row).join('\n');

/** The Card behind a rendered record id, straight from the pure projection —
 *  render-independent, so a parity assertion over it cannot be confused by row
 *  indentation (see PIN 1). */
function projectedCard(store: SterlingStore, ui: Ui, id: string) {
  for (const node of nodesFor(store, ui)) {
    if (node.kind === 'card' && node.card.id === id) return node.card;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PIN 0 (fixture oracle / CONTROL for the whole file, placed FIRST): the live
// route really does leave an ACTIVE record holding an inbound supersedes edge.
// This must pass for the OPPOSITE reason to everything below: it asserts the
// STORE, not the TUI. If it goes red, no TUI pin here means anything.
// STATUS: measured GREEN by the conductor on revision 1.
//
// SABOTAGE: none available in the files this lane owns — it pins store
// behaviour (index.ts insertRecord + baseFilter), deliberately out of scope.
// ---------------------------------------------------------------------------
test('oracle: an ACTIVE record can hold an inbound rel:supersedes edge and stays query-visible (the route is LIVE, not dormant)', () => {
  const { store, cleanup } = fixture();
  try {
    const { target, holder } = activeInboundEdge(store);

    const inbound = store.inboundSupersedes(target.id);
    assert.equal(inbound.length, 1, 'the reverse-edge read finds the holder');
    assert.equal((inbound[0] as { id: string }).id, holder.id);

    const visible = store.query({ types: ['decision'], cap: 50 }).map((r) => (r as { id: string }).id);
    assert.ok(visible.includes(target.id), 'the TARGET was NOT retired by the link write — it is still served by query()');
    assert.ok(visible.includes(holder.id), 'the holder is served too');

    const entries = viewmodel.toInboundSupersedesEntries(inbound);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, holder.id);
    assert.equal(entries[0].status, 'active', 'the holder itself is active');
    assert.equal(entries[0].superseded_by, undefined, 'active status → superseded_by omitted');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PIN 1 (FINDING 1 — route parity). REWRITTEN in revision 2. The substance was
// already fixed and measured working: revision 1 showed the disclosure present
// by BOTH routes. It failed on a DEFECT IN THIS PIN — it compared the two
// routes' RENDERED body text, which legitimately differs in leading whitespace:
//
//   - `wrapText` splits every paragraph on ' ' (state.ts:462-464), so the
//     section's own leading two spaces are DISCARDED on every wrapped line, by
//     both routes equally;
//   - the only surviving indent is `' '.repeat(2 + pad.length)` (state.ts:683),
//     i.e. the card's TREE DEPTH — 6 for a depth-2 tree card, 2 for a depth-0
//     flat search card — and it is applied to EVERY body line of the card, the
//     statement line included, not to the disclosure specially.
//
// So the 6-vs-2 difference revision 1 tripped on is a whole-card property of
// "nested tree vs flat search list" — the flat search list is the DESIGNED
// behaviour (article tui-dashboard: a non-empty query "replaces the tree with a
// FLAT, source-tagged" list). Indenting search results to tree depth to make a
// pin pass would be a silent behaviour change, so the pin moves instead — and
// it moves to a STRICTER surface, not a looser one:
//   (i)  the pure projection: nodesFor's Card.body must be BYTE-IDENTICAL
//        between the two routes (exact equality, no tolerance — any content
//        divergence at all fails, including a single differing space);
//   (ii) the rendered surface: both routes must actually SHOW the disclosure;
//   (iii) the indent difference is pinned as a WHOLE-CARD property — the first
//        body line (the statement) carries the same 6-vs-2 difference — so a
//        future change that made the DISCLOSURE's indentation route-dependent
//        would fail here even though (i) held.
//
// CONTROL (asserted first, must pass for the opposite reason): an unrelated
// record with no inbound edge carries no disclosure on either route.
//
// SABOTAGE (PREDICTED, not executed): in nodesFor's project-store search
// branch, replace `hydrateInbound({ ...toCard(r), source: 'project' }, ui,
// store)` with `{ ...toCard(r), source: 'project' }` → (i) and the search half
// of (ii) go red while the tree half stays green (the pre-fix asymmetry).
// ---------------------------------------------------------------------------
test('FINDING 1: an expanded card discloses its inbound superseder by BOTH routes — tree and search — with a byte-identical Card.body', () => {
  const { store, cleanup } = fixture();
  try {
    const { target, holder } = activeInboundEdge(store, { statement: 'zephyrine clause under override' });
    const plain = store.create(
      decisionRec({ title: 'unrelated zephyrine decision', statement: 'zephyrine with no inbound edge at all' }),
    ) as { id: string };

    const expanded = ['cat:decision', 'src:decision:project', target.id, plain.id];
    const treeUi = st({ tab: KNOW_TAB, expanded });
    const searchUi = st({ tab: KNOW_TAB, expanded, searchQuery: 'zephyrine' });

    // --- (i) PURE PROJECTION: same card, byte-identical body, both routes
    const treeCard = projectedCard(store, treeUi, target.id);
    const searchCard = projectedCard(store, searchUi, target.id);
    const treePlainCard = projectedCard(store, treeUi, plain.id);
    const searchPlainCard = projectedCard(store, searchUi, plain.id);
    assert.ok(treeCard, 'the target is a card in the tree (it was never retired)');
    assert.ok(searchCard, 'the target is a card in the search results (a red here is visibility, not disclosure)');
    assert.ok(treePlainCard && searchPlainCard, 'the control record is a card on both routes');

    // CONTROL first — must pass for the opposite reason: nothing to disclose.
    assert.doesNotMatch(treePlainCard!.body, DISCLOSURE, 'CONTROL (tree): a record with no inbound edge discloses nothing');
    assert.doesNotMatch(searchPlainCard!.body, DISCLOSURE, 'CONTROL (search): a record with no inbound edge discloses nothing');
    assert.equal(searchPlainCard!.body, treePlainCard!.body, 'CONTROL: an untouched record already renders identically by both routes');

    assert.match(treeCard!.body, DISCLOSURE, 'tree route: the expanded target carries the disclosure');
    assert.match(searchCard!.body, DISCLOSURE, 'search route: the expanded target carries the disclosure too (FINDING 1)');
    assert.ok(treeCard!.body.includes(holder.id.slice(0, 8)), 'the disclosure names the holder');
    assert.equal(
      searchCard!.body,
      treeCard!.body,
      'PARITY: byte-identical Card.body — one record cannot disclose differently depending on how the user reached it',
    );

    // --- (ii) RENDERED SURFACE: the user actually sees it on both routes
    const treeRow = buildDashboardState(store, treeUi, 80).rows.find((r) => r.id === target.id);
    const searchRow = buildDashboardState(store, searchUi, 80).rows.find((r) => r.id === target.id);
    assert.ok(treeRow && searchRow, 'the target renders as an expanded card on both routes');
    assert.match(bodyText(treeRow!), DISCLOSURE, 'rendered tree card shows the disclosure');
    assert.match(bodyText(searchRow!), DISCLOSURE, 'rendered search card shows the disclosure');

    // --- (iii) the leading-indent difference is a WHOLE-CARD depth property,
    // not a disclosure property: it is identical on the FIRST body line (the
    // statement) and on the disclosure line, and stripping it makes the two
    // rendered bodies match exactly.
    const treeBody = bodyLines(treeRow!).filter((l) => l.trim().length > 0);
    const searchBody = bodyLines(searchRow!).filter((l) => l.trim().length > 0);
    const indentOf = (l: string) => l.length - l.trimStart().length;
    assert.equal(indentOf(treeBody[0]), 6, 'a depth-2 tree card indents EVERY body line by 6 (2 + pad), statement line included');
    assert.equal(indentOf(searchBody[0]), 2, 'a depth-0 flat search card indents every body line by 2 — the flat-list design, not a disclosure difference');
    const discTree = treeBody.find((l) => /- /.test(l) && l.includes(holder.id.slice(0, 8)))!;
    const discSearch = searchBody.find((l) => /- /.test(l) && l.includes(holder.id.slice(0, 8)))!;
    assert.equal(indentOf(discTree), indentOf(treeBody[0]), 'the disclosure line takes the SAME indent as the rest of the tree card');
    assert.equal(indentOf(discSearch), indentOf(searchBody[0]), 'the disclosure line takes the SAME indent as the rest of the search card');
    assert.deepEqual(
      searchBody.map((l) => l.trimStart()),
      treeBody.map((l) => l.trimStart()),
      'with the row depth removed, the two rendered bodies are identical line for line',
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PIN 2 (FINDING 3, verified and pinned so it is not re-learned): the
// disclosure lands on the BODY lines, never on the trailing kind:'meta' line
// (which is built solely from card.detail). This pin exists to protect future
// pin authors from asserting on the wrong surface.
// STATUS: measured GREEN by the conductor on revision 1.
//
// SABOTAGE (PREDICTED, not executed): in state.ts's expanded-knowledge-card
// branch, append the section to the meta line instead — the doesNotMatch below
// goes red.
// ---------------------------------------------------------------------------
test('FINDING 3: the disclosure renders in the BODY lines; the trailing meta line stays card.detail only', () => {
  const { store, cleanup } = fixture();
  try {
    const { target } = activeInboundEdge(store);
    const s = buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project', target.id] }), 80);
    const row = s.rows.find((r) => r.id === target.id)!;
    const meta = row.lines.at(-1)!;

    assert.equal(meta.kind, 'meta', 'the last line of an expanded knowledge card is the meta line');
    assert.match(bodyText(row), DISCLOSURE, 'the disclosure is in the body lines');
    assert.doesNotMatch(
      meta.text,
      DISCLOSURE,
      'the meta line carries card.detail only — a pin asserting the disclosure HERE would be red even when the feature works',
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PIN 3 (FINDING 2 — the HONEST bound): a reverse-edge query is paid for each
// RENDERED, EXPANDED knowledge card, and for nothing else.
//
// The earlier claim ("one query for the expanded card") was false in both
// directions: ui.expanded is ADDITIVE (state.ts:827's toggle never collapses
// siblings), so N expanded cards cost N queries — and cards behind a COLLAPSED
// sub-category were also charged a query despite never rendering.
// STATUS: measured GREEN by the conductor on revision 1.
//
// (a)/(a2) are the CONTROLS that rule out "always fires".
//
// SABOTAGE (PREDICTED, not executed): drop
// `if (!ui.expanded.includes(card.id)) return card;` from hydrateInbound →
// (a2) goes red (calls become the fetched-row count).
// ---------------------------------------------------------------------------
test('FINDING 2: reverse-edge queries are bounded by RENDERED + EXPANDED cards — zero when nothing renders, N for N visible expanded cards', () => {
  const { store, cleanup } = fixture();
  try {
    const { target } = activeInboundEdge(store);
    const second = store.create(decisionRec({ title: 'second card' })) as { id: string };
    for (let i = 0; i < 3; i++) store.create(decisionRec({ title: `filler ${i}` }));
    // 6 decision records now sit under cat:decision / src:decision:project

    const calls: string[] = [];
    const real = store.inboundSupersedes.bind(store);
    store.inboundSupersedes = ((id: string) => {
      calls.push(id);
      return real(id);
    }) as typeof store.inboundSupersedes;

    // (a) CONTROL — fully collapsed: no card renders, no query runs
    buildDashboardState(store, st({ tab: KNOW_TAB, expanded: [] }), 80);
    assert.equal(calls.length, 0, '(a) fully collapsed tree: zero reverse-edge queries');

    // (a2) CONTROL — cards render but none is expanded: still zero
    calls.length = 0;
    buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project'] }), 80);
    assert.equal(calls.length, 0, '(a2) six cards rendered, none expanded: still zero — a collapsed card never shows a body');

    // (b) ONE visible expanded card among six fetched rows → exactly one query
    calls.length = 0;
    const one = buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project', target.id] }), 80);
    assert.ok(one.rows.some((r) => r.id === target.id), 'the expanded card is present in the tree');
    assert.deepEqual(calls, [target.id], '(b) exactly one query, for the one expanded card — not one per fetched row');

    // (c) TWO visible expanded cards → exactly two queries (the HONEST bound:
    //     per rendered expanded card, NOT one per tick)
    calls.length = 0;
    buildDashboardState(store, st({ tab: KNOW_TAB, expanded: ['cat:decision', 'src:decision:project', target.id, second.id] }), 80);
    assert.deepEqual(new Set(calls), new Set([target.id, second.id]), '(c) both expanded cards are hydrated');
    assert.equal(calls.length, 2, '(c) exactly N queries for N rendered expanded cards — the bound is per RENDERED card, never "one"');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PIN 4 (FINDING 2, the tightening): hydration happens at the node-push site,
// AFTER sub-category visibility is known — so a fetched-but-unrendered card
// costs nothing even though its id sits in ui.expanded.
//
// REVISION 2 FIX — this arm failed on revision 1 for a PIN DEFECT, not a
// behavioural miss: its articleRec omitted feature_article's required
// current_ac / history / live_test_refs arrays and dependencies.relied_by, so
// store.create threw a ZodError ("expected array") before any TUI code ran. The
// fixture is fixed above; the assertions are unchanged in substance.
//
// SABOTAGE (PREDICTED, not executed): hydrate g.cards BEFORE the
// `if (!ui.expanded.includes(subId(...))) continue;` guard (the pre-fix,
// record-level position) → the (d) assertion goes red with 1 call for a card
// that never renders, while every other pin in this file stays green.
// ---------------------------------------------------------------------------
test('FINDING 2 (d): an expanded card hidden behind a COLLAPSED sub-category costs no reverse-edge query', () => {
  const { store, cleanup } = fixture();
  try {
    // two components → the sub-category level appears (no collapse-single-bucket)
    const tui = store.create(
      articleRec({ title: 'TUI article', files: [{ path: 'packages/tui/src/state.ts', role: 'impl' }] }),
    ) as { id: string };
    store.create(articleRec({ title: 'Store article', files: [{ path: 'packages/store/src/index.ts', role: 'impl' }] }));
    store.create(
      decisionRec({
        title: 'holder pointing at the TUI article',
        links: [{ rel: 'supersedes', target_id: tui.id }],
      }),
    );

    const calls: string[] = [];
    const real = store.inboundSupersedes.bind(store);
    store.inboundSupersedes = ((id: string) => {
      calls.push(id);
      return real(id);
    }) as typeof store.inboundSupersedes;

    // source expanded (records fetched, sub-categories rendered) and the card id
    // IS in ui.expanded — but its sub-category is COLLAPSED, so it never renders.
    const collapsedSub = buildDashboardState(
      store,
      st({ tab: KNOW_TAB, expanded: ['cat:feature_article', 'src:feature_article:project', tui.id] }),
      80,
    );
    assert.ok(collapsedSub.rows.some((r) => r.type === 'subcategory'), 'the sub-category level is in play (two components)');
    assert.ok(!collapsedSub.rows.some((r) => r.id === tui.id), 'the card is NOT rendered while its sub-category is collapsed');
    assert.equal(calls.length, 0, '(d) a fetched-but-unrendered expanded card costs nothing');

    // CONTROL — must pass for the opposite reason: open the sub-category and the
    // very same ui.expanded entry now DOES cost exactly one query, and discloses.
    calls.length = 0;
    const openSub = buildDashboardState(
      store,
      st({
        tab: KNOW_TAB,
        expanded: ['cat:feature_article', 'src:feature_article:project', 'sub:feature_article:project:packages/tui', tui.id],
      }),
      80,
    );
    const row = openSub.rows.find((r) => r.id === tui.id);
    assert.ok(row, 'CONTROL: the card renders once its sub-category is expanded');
    assert.deepEqual(calls, [tui.id], 'CONTROL: now exactly one query is paid, for the card that actually renders');
    assert.match(bodyText(row!), DISCLOSURE, 'CONTROL: and the rendered card discloses its inbound superseder');
  } finally {
    cleanup();
  }
});
