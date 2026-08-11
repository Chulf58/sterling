// ------------- Tasks-tab OBJECTIVE GROUPING (decision a8d2ce6c, slice 2) -------------
//
// SPEC-ONLY oracle, written BEFORE the grouping exists. Slice 1 shipped the field:
// a todo may carry an optional non-empty `objective` string (a grouping KEY, not a
// parent record — absent = standalone). Slice 2 is the DISPLAY half. Decision
// a8d2ce6c point (5), verbatim: "TUI Tasks tab groups children under a collapsed
// '▸ <objective> (N open)' header — a second consumer of the knowledgeSubgroups
// bucket→label→collapsed-card pattern plus ui.expanded."
//
// ACs pinned here (phrased at the entry point the user's eye actually reaches —
// buildDashboardState's Tasks-tab rows, plus the pure todoCards projection under it):
//   AC1  N todos sharing an objective collapse into ONE group header whose label
//        carries the objective name and the OPEN count; standalone items stay
//        ordinary flat cards; a grouped child is never also a top-level card.
//   AC2  collapsed by DEFAULT (ui.expanded, exactly the Knowledge tab's mechanism);
//        expanding the header reveals the children, each keeping its own record id
//        so selection still works per child.
//   AC3  two objectives → two headers, each nesting its own children; an objective
//        with ZERO open members renders NO header (never an empty group).
//   AC4  a system-source (maintenance) item NEVER groups — objectives are a
//        user-board concern; the Queue tab is untouched.
//
// ---------------------------------------------------------------------------------
// CONTRACT THIS ORACLE OWNS (decisions_made — not fixed by slice 1 or the decision
// text, so the oracle fixes them, exactly as the r-dd88/r-f9a7 oracles fixed the
// 'cat:'/'src:'/'sys:' id conventions):
//
//   • a group header is a ROW/ENTRY whose id is NAMESPACED with the 'obj:' prefix
//     (mirroring 'cat:' / 'src:' / 'sys:'), so it can never collide with a record
//     id and every CHILD row keeps its own todo id (that is what makes per-child
//     selection work). The remainder of the id is the coder's business — every test
//     below reads the header id back off the built state rather than hard-coding it.
//   • the header LABEL carries the objective name verbatim AND the open count in
//     the decision's shape: '(N open)'. The ▸/▾ fold glyph is the renderer's
//     business and is not asserted here.
//   • OPEN count == number of children the group renders: a closed (removed) child
//     counts in neither.
//   • an objective with >= 1 open member IS a group (a one-member group still gets
//     a header). The line the decision draws is at ZERO members — "a group with
//     zero open children stops rendering and a late-discovered slice re-materialises
//     it" — so the boundary asserted below is 1 vs 0, never 2 vs 1.
//   • activating a header is NAVIGATION: it toggles the fold and emits NO select
//     effect (identical to a Knowledge category/source row). Activating a child
//     emits the ordinary { type:'select', recordType:'todo', id:<child id> }.
//   • children render CONTIGUOUSLY under their own header; a collapsed group hides
//     its children even when a child's own id sits in ui.expanded (the fold above
//     wins, exactly as a collapsed Knowledge source hides an expanded card).
//   • the pure projection keeps its existing name and gains a TRAILING OPTIONAL
//     param: todoCards(store, expanded?) — the additive-optional-param idiom
//     (decision 34d61f60) the P4 `knowledge?` and System-tab `roster?` params used.
//     Group headers are returned INLINE, in display order, ahead of their children.
//   • ORDER between groups and standalone cards is deliberately NOT pinned (nothing
//     in the decision fixes it); what IS pinned is nesting, membership, counts and
//     determinism across rebuilds.
//
// CLEAN-RED discipline (mirrors system-tab.test.ts / the P2–P4 oracles):
//   • todoCards' committed signature takes ONE arg, so the second is reached through
//     a NARROW cast on the viewmodel namespace (VM) — the file COMPILES under tsc
//     strict today (a tsc error would be a build CRASH, which proves nothing).
//   • every store.create goes through mkTodo(), which casts its literal, so a
//     schema/type mismatch can never turn a red assertion into a compile error.
//   • every test EXISTENCE-asserts the header it is about to use, so an unimplemented
//     grouping yields a clean AssertionError, never a TypeError.
//   • buildDashboardState / reduce already exist and are defensive: today they return
//     five FLAT record rows for five user todos, so each assertion below fails RED on
//     an AssertionError.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { todoCards } from '../viewmodel.js';
import * as viewmodel from '../viewmodel.js';
import { buildDashboardState, initialUi, reduce, QUEUE_TAB, type UiState, type DashboardState } from '../state.js';

const NOW = '2026-06-10T12:00:00.000Z';

/** The Tasks tab (TABS[0]) — the board tab these ACs are about. */
const TASKS_TAB = 0;
/** The namespaced id prefix this oracle fixes for a group header row/entry. */
const OBJ = 'obj:';
/** Pane width used everywhere below: wide enough that no header label is clipped. */
const W = 80;

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });

type Row = DashboardState['rows'][number];

/** A todo entry as the pure projection exposes it. Narrowed to what this oracle
 *  reads, every extra field optional, so the cast is valid before the coder adds
 *  the grouping. */
interface TodoEntry {
  id: string;
  title: string;
}

/** todoCards with the additive trailing `expanded?` param (see the contract above).
 *  The committed signature lacks it, so the cast lets tsc accept the extra arg;
 *  the FIRST arg stays a real SterlingStore, so today's committed code runs its
 *  normal path WITHOUT throwing and the assertions fail on values, not crashes. */
interface ObjectiveViewmodel {
  todoCards?: (store: SterlingStore, expanded?: readonly string[]) => TodoEntry[];
}
const VM = viewmodel as unknown as ObjectiveViewmodel;

// --------------------------------- fixtures ---------------------------------

function envelope(type: string) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-obj-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Create a todo. The literal is cast so the not-yet-consumed `objective` field can
 *  never turn a RED assertion into a tsc/schema build error. */
function mkTodo(store: SterlingStore, over: Record<string, unknown>): { id: string } {
  const rec = { ...envelope('todo'), source: 'user', ...over };
  return store.create(rec as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };
}

const grouped = (store: SterlingStore, text: string, objective: string) => mkTodo(store, { text, objective });
const standalone = (store: SterlingStore, text: string) => mkTodo(store, { text });
const maintenance = (store: SterlingStore, text: string, over: Record<string, unknown> = {}) =>
  mkTodo(store, { text, source: 'system', system_reason: 'reconcile_needed', author: 'system', ...over });

// --------------------------------- helpers ----------------------------------

function build(store: SterlingStore, ui: UiState): DashboardState {
  return buildDashboardState(store, ui, W);
}
const ids = (s: DashboardState): string[] => s.rows.map((r) => r.id);
const rowText = (row: Row): string => row.lines.map((l) => l.text).join(' ');
const headers = (s: DashboardState): Row[] => s.rows.filter((r) => r.id.startsWith(OBJ));
/** Locate a group header by its objective name — tolerant about how the coder
 *  encodes the name into the id (only the 'obj:' prefix is pinned). */
function headerFor(s: DashboardState, objective: string): Row | undefined {
  return headers(s).find((r) => r.id.includes(objective) || rowText(r).includes(objective));
}
/** The `n` rows immediately following a header — the group's nesting slot. */
function nestedUnder(s: DashboardState, header: Row, n: number): string[] {
  const i = s.rows.findIndex((r) => r.id === header.id);
  return s.rows.slice(i + 1, i + 1 + n).map((r) => r.id);
}
const sorted = (xs: string[]): string[] => [...xs].sort();

// =============================================================================
// AC1 — one header for the shared objective, standalone items stay flat cards
// =============================================================================

test('AC1: three todos sharing "Animation pass" collapse into ONE group header carrying the name + open count (3); the two standalone items stay ordinary cards and no grouped child is a top-level card', () => {
  const { store, cleanup } = fixture();
  try {
    const c1 = grouped(store, 'rig the walk cycle', 'Animation pass');
    const c2 = grouped(store, 'retarget the idle', 'Animation pass');
    const c3 = grouped(store, 'blend the run', 'Animation pass');
    const s1 = standalone(store, 'bump the changelog');
    const s2 = standalone(store, 'fix the tooltip typo');

    const s = build(store, st({ tab: TASKS_TAB }));

    const hs = headers(s);
    assert.equal(hs.length, 1, 'exactly ONE group header for the one shared objective');
    const header = hs[0];
    assert.ok(header.id.startsWith(OBJ), `the header id is namespaced with '${OBJ}' so it can never collide with a record id (got '${header.id}')`);

    const label = rowText(header);
    assert.match(label, /Animation pass/, 'the header label carries the objective name verbatim');
    assert.match(label, /\(3 open\)/, "the header label carries the OPEN count in the decision's '(N open)' shape");
    assert.equal(header.lines.length, 1, 'a collapsed group header is a single line');

    // the two standalone items are ordinary flat cards, still keyed by record id
    const rowIds = ids(s);
    assert.ok(rowIds.includes(s1.id), 'the first standalone item is an ordinary card, keyed by its record id');
    assert.ok(rowIds.includes(s2.id), 'the second standalone item is an ordinary card');

    // the three grouped children are NOT top-level cards (that is the explosion this fixes)
    for (const child of [c1, c2, c3]) {
      assert.ok(!rowIds.includes(child.id), `grouped child ${child.id} is not a top-level card`);
    }
    assert.deepEqual(
      sorted(rowIds),
      sorted([header.id, s1.id, s2.id]),
      'the Tasks tab shows exactly one header + the two standalone cards — five flat cards collapsed to three entries'
    );
  } finally {
    cleanup();
  }
});

// =============================================================================
// AC2 — collapsed by default via ui.expanded; expanding reveals the children
// =============================================================================

test('AC2: collapsed by DEFAULT — the children are absent from the visible entries, and stay absent even when a CHILD id sits in ui.expanded (the fold above wins)', () => {
  const { store, cleanup } = fixture();
  try {
    const c1 = grouped(store, 'rig the walk cycle', 'Animation pass');
    const c2 = grouped(store, 'retarget the idle', 'Animation pass');
    const c3 = grouped(store, 'blend the run', 'Animation pass');
    standalone(store, 'bump the changelog');

    // default ui: nothing expanded
    const collapsed = build(store, st({ tab: TASKS_TAB }));
    const header = headerFor(collapsed, 'Animation pass');
    assert.ok(header, 'the "Animation pass" group header is present when collapsed');
    for (const child of [c1, c2, c3]) {
      assert.ok(!ids(collapsed).includes(child.id), `child ${child.id} is hidden while the group is collapsed`);
    }

    // a child's OWN expansion cannot punch through a collapsed group
    const childExpanded = build(store, st({ tab: TASKS_TAB, expanded: [c2.id] }));
    assert.ok(
      !ids(childExpanded).includes(c2.id),
      "expanding a CHILD id while its group is folded reveals nothing — the group's fold governs visibility"
    );
    assert.ok(headerFor(childExpanded, 'Animation pass'), 'the header itself is still rendered');
  } finally {
    cleanup();
  }
});

test('AC2: expanding the header (ui.expanded holds the header id — the Knowledge tab mechanism) reveals exactly the three children, contiguous under their header, each keeping its OWN record id; screenRow accounting stays exact', () => {
  const { store, cleanup } = fixture();
  try {
    const c1 = grouped(store, 'rig the walk cycle', 'Animation pass');
    const c2 = grouped(store, 'retarget the idle', 'Animation pass');
    const c3 = grouped(store, 'blend the run', 'Animation pass');
    const s1 = standalone(store, 'bump the changelog');
    const s2 = standalone(store, 'fix the tooltip typo');

    const collapsed = build(store, st({ tab: TASKS_TAB }));
    const header = headerFor(collapsed, 'Animation pass');
    assert.ok(header, 'the group header exists to be expanded');

    const s = build(store, st({ tab: TASKS_TAB, expanded: [header!.id] }));
    const openHeader = headerFor(s, 'Animation pass');
    assert.ok(openHeader, 'the header survives its own expansion');

    // the three children appear, each under its OWN record id (per-child selection)
    assert.deepEqual(
      sorted(nestedUnder(s, openHeader!, 3)),
      sorted([c1.id, c2.id, c3.id]),
      'the three children occupy the three rows immediately under the header, keyed by their own record ids'
    );
    // each exactly once — an expanded group must not also emit top-level duplicates
    for (const child of [c1, c2, c3]) {
      assert.equal(ids(s).filter((id) => id === child.id).length, 1, `child ${child.id} appears exactly once`);
    }
    // the standalone cards are untouched by the expansion
    assert.deepEqual(
      sorted(ids(s)),
      sorted([openHeader!.id, c1.id, c2.id, c3.id, s1.id, s2.id]),
      'header + three children + two standalone cards'
    );

    // contiguous screenRow accounting (the hit-test depends on it)
    let expected = 0;
    for (const r of s.rows) {
      assert.equal(r.screenRow, expected, `row ${r.id} starts at the running offset`);
      expected += r.lines.length;
    }
  } finally {
    cleanup();
  }
});

test('AC2 selection: activating the header is NAVIGATION (toggles the fold, no select effect); activating a revealed child emits the ordinary select effect carrying THAT CHILD\'s id — by keyboard and by click', () => {
  const { store, cleanup } = fixture();
  try {
    const c1 = grouped(store, 'rig the walk cycle', 'Animation pass');
    grouped(store, 'retarget the idle', 'Animation pass');
    grouped(store, 'blend the run', 'Animation pass');
    standalone(store, 'bump the changelog');

    const collapsed = build(store, st({ tab: TASKS_TAB }));
    const header = headerFor(collapsed, 'Animation pass');
    assert.ok(header, 'the group header exists');
    const headerIdx = collapsed.rows.findIndex((r) => r.id === header!.id);
    assert.ok(headerIdx >= 0, 'the header is reachable by cursor');

    // ENTER on the header: navigation only — no select effect, fold toggled
    const onHeader = reduce(store, st({ tab: TASKS_TAB, cursor: headerIdx }), { kind: 'key', name: 'ENTER' }, { width: W });
    assert.deepEqual(onHeader.effects, [], 'activating a group header is navigation — no select effect');
    assert.ok(onHeader.ui.expanded.includes(header!.id), 'activating the header expands the group (its id enters ui.expanded)');

    // ENTER on a child of the now-open group: the ordinary per-record select effect
    const openUi = st({ tab: TASKS_TAB, expanded: [header!.id] });
    const open = build(store, openUi);
    const childIdx = open.rows.findIndex((r) => r.id === c1.id);
    assert.ok(childIdx >= 0, 'the first child is reachable by cursor once the group is open');
    const onChild = reduce(store, { ...openUi, cursor: childIdx }, { kind: 'key', name: 'ENTER' }, { width: W });
    assert.deepEqual(
      onChild.effects,
      [{ type: 'select', recordType: 'todo', id: c1.id }],
      'activating a child selects THAT child — per-child selection survives the grouping'
    );

    // and by click: the child's own screen line maps back to the child, not the header
    const childRow = open.rows[childIdx];
    const clicked = reduce(store, openUi, { kind: 'click', x: 1, y: 4 + childRow.screenRow }, { width: W });
    assert.equal(clicked.effects.length, 1, 'a click on a child line produces exactly one effect');
    assert.deepEqual(clicked.effects[0], { type: 'select', recordType: 'todo', id: c1.id }, 'the click selects the child under the cursor line');
  } finally {
    cleanup();
  }
});

// =============================================================================
// AC3 — two objectives → two groups; a zero-member objective renders nothing
// =============================================================================

test('AC3: two different objectives yield TWO headers, each nesting only its own children; an objective whose only member was CLOSED yields no header at all (no empty group)', () => {
  const { store, cleanup } = fixture();
  try {
    const a1 = grouped(store, 'rig the walk cycle', 'Animation pass');
    const a2 = grouped(store, 'retarget the idle', 'Animation pass');
    const p1 = grouped(store, 'tune the ragdoll', 'Physics pass');
    const p2 = grouped(store, 'fix the cloth jitter', 'Physics pass');
    // the whole membership of a third objective is closed → the group stops rendering
    const gone = grouped(store, 'the only slice of a finished objective', 'Retired pass');
    store.remove(gone.id, '2026-06-10T12:30:00.000Z');

    const collapsed = build(store, st({ tab: TASKS_TAB }));
    assert.equal(headers(collapsed).length, 2, 'exactly two headers — one per objective with at least one OPEN member');

    const anim = headerFor(collapsed, 'Animation pass');
    const phys = headerFor(collapsed, 'Physics pass');
    assert.ok(anim, 'the "Animation pass" header is present');
    assert.ok(phys, 'the "Physics pass" header is present');
    assert.match(rowText(anim!), /\(2 open\)/, 'each header counts only its own open members');
    assert.match(rowText(phys!), /\(2 open\)/, 'the second group counts its own two members');

    // no empty header anywhere, by name or by id
    assert.ok(
      !headers(collapsed).some((r) => /Retired pass/.test(rowText(r)) || r.id.includes('Retired pass')),
      'an objective with ZERO open members renders NO header (never an empty group)'
    );
    assert.ok(!ids(collapsed).includes(gone.id), 'the closed child is gone from the board entirely');

    // expand both: each group nests exactly its own children
    const s = build(store, st({ tab: TASKS_TAB, expanded: [anim!.id, phys!.id] }));
    const animOpen = headerFor(s, 'Animation pass')!;
    const physOpen = headerFor(s, 'Physics pass')!;
    assert.deepEqual(sorted(nestedUnder(s, animOpen, 2)), sorted([a1.id, a2.id]), 'the animation children nest under the animation header');
    assert.deepEqual(sorted(nestedUnder(s, physOpen, 2)), sorted([p1.id, p2.id]), 'the physics children nest under the physics header');
    assert.equal(s.rows.length, 6, 'two headers + four children, nothing else');
  } finally {
    cleanup();
  }
});

test('AC3 boundary: an objective with exactly ONE open member is still a group — "(1 open)" — and a group shrinks to its open members when one child closes', () => {
  const { store, cleanup } = fixture();
  try {
    const only = grouped(store, 'the single declared slice', 'Physics pass');
    const a1 = grouped(store, 'rig the walk cycle', 'Animation pass');
    const a2 = grouped(store, 'retarget the idle', 'Animation pass');
    const a3 = grouped(store, 'blend the run', 'Animation pass');
    store.remove(a3.id, '2026-06-10T12:30:00.000Z'); // one of three closed → 2 open

    const collapsed = build(store, st({ tab: TASKS_TAB }));
    const one = headerFor(collapsed, 'Physics pass');
    assert.ok(one, 'a one-member objective still gets a header — the line is drawn at ZERO members, not at two');
    assert.match(rowText(one!), /\(1 open\)/, 'the single-member group reports one open item');

    const anim = headerFor(collapsed, 'Animation pass');
    assert.ok(anim, 'the animation header is present');
    assert.match(rowText(anim!), /\(2 open\)/, 'a CLOSED child counts in neither the label nor the children');

    const s = build(store, st({ tab: TASKS_TAB, expanded: [one!.id, anim!.id] }));
    assert.deepEqual(nestedUnder(s, headerFor(s, 'Physics pass')!, 1), [only.id], 'the one-member group reveals its single child');
    assert.deepEqual(
      sorted(nestedUnder(s, headerFor(s, 'Animation pass')!, 2)),
      sorted([a1.id, a2.id]),
      'the shrunk group reveals exactly its two open children'
    );
    assert.ok(!ids(s).includes(a3.id), 'the closed child is not revealed by the expansion');
  } finally {
    cleanup();
  }
});

// =============================================================================
// AC4 — objectives are a USER-board concern; maintenance items never group
// =============================================================================

test('AC4: a system-source item carrying an objective NEVER groups — it stays off the Tasks tab, is excluded from the group count, and the Queue tab shows it as a plain row with no group headers', () => {
  const { store, cleanup } = fixture();
  try {
    const u1 = grouped(store, 'rig the walk cycle', 'Animation pass');
    const u2 = grouped(store, 'retarget the idle', 'Animation pass');
    const s1 = standalone(store, 'bump the changelog');
    // a maintenance item physically carrying the same objective string: lanes group
    // the queue, objectives group the board — this must not be a third group member
    const sys = maintenance(store, "reconcile article 'tui-dashboard'", { objective: 'Animation pass', file_keys: ['packages/tui/src/state.ts'] });

    const tasks = build(store, st({ tab: TASKS_TAB }));
    const header = headerFor(tasks, 'Animation pass');
    assert.ok(header, 'the user-board group header is present');
    assert.match(rowText(header!), /\(2 open\)/, 'the group counts the TWO user items only — the maintenance item is not a member');
    assert.ok(!ids(tasks).includes(sys.id), 'the maintenance item never appears on the Tasks tab (unchanged source filter)');
    assert.deepEqual(sorted(ids(tasks)), sorted([header!.id, s1.id]), 'one header + one standalone card, nothing from the queue');

    // and with the group open, the maintenance item is still not one of its children
    const open = build(store, st({ tab: TASKS_TAB, expanded: [header!.id] }));
    assert.deepEqual(sorted(nestedUnder(open, headerFor(open, 'Animation pass')!, 2)), sorted([u1.id, u2.id]), 'exactly the two user children');
    assert.ok(!ids(open).includes(sys.id), 'the maintenance item is not revealed as a child');

    // the Queue tab is untouched: the item is an ordinary row keyed by its record id
    const queue = build(store, st({ tab: QUEUE_TAB }));
    assert.equal(headers(queue).length, 0, 'the Queue tab never renders group headers — objectives are a user-board concern');
    assert.ok(ids(queue).includes(sys.id), 'the maintenance item is an ordinary queue row, keyed by its own record id');
    for (const t of [u1, u2, s1]) assert.ok(!ids(queue).includes(t.id), 'user items still never appear on the queue tab');
  } finally {
    cleanup();
  }
});

// =============================================================================
// Regression + determinism
// =============================================================================

test('regression: a board with NO objectives renders exactly today\'s flat cards (zero group headers, one line each) while an otherwise identical grouped board renders a header; repeated builds are identical (deterministic order)', () => {
  // flat half — the zero-change guarantee for boards that never declare an objective
  const flat = fixture();
  try {
    const t1 = standalone(flat.store, 'first todo');
    const t2 = standalone(flat.store, 'second todo');
    maintenance(flat.store, 'hidden maintenance');
    const s = build(flat.store, st({ tab: TASKS_TAB }));
    assert.equal(headers(s).length, 0, 'no objectives declared → no group headers at all');
    assert.deepEqual(ids(s), [t1.id, t2.id], "an ungrouped board is exactly today's flat card list, in order");
    for (const r of s.rows) assert.equal(r.lines.length, 1, 'collapsed cards stay one line each');
  } finally {
    flat.cleanup();
  }

  // grouped half — the same shapes with an objective declared
  const g = fixture();
  try {
    grouped(g.store, 'rig the walk cycle', 'Animation pass');
    grouped(g.store, 'retarget the idle', 'Animation pass');
    standalone(g.store, 'bump the changelog');

    const a = build(g.store, st({ tab: TASKS_TAB }));
    assert.equal(headers(a).length, 1, 'the declared objective produces one header');

    // determinism: same store, same ui → byte-identical row ids and rendered lines
    const b = build(g.store, st({ tab: TASKS_TAB }));
    assert.deepEqual(ids(b), ids(a), 'a rebuild produces the same row order (deterministic grouping)');
    assert.deepEqual(b.rows.map(rowText), a.rows.map(rowText), 'and the same rendered text');

    const header = headerFor(a, 'Animation pass')!;
    const openA = build(g.store, st({ tab: TASKS_TAB, expanded: [header.id] }));
    const openB = build(g.store, st({ tab: TASKS_TAB, expanded: [header.id] }));
    assert.deepEqual(ids(openB), ids(openA), 'the expanded order is deterministic too');
  } finally {
    g.cleanup();
  }
});

// =============================================================================
// The pure projection under the tab (todoCards + the additive expanded? param)
// =============================================================================

test('AC1/AC2 at the pure projection: todoCards(store, expanded?) returns the group header INLINE — collapsed it is one entry carrying the objective name + "(3 open)" and no children; expanding it inserts the three children after it; the user-only filter is unchanged', () => {
  const { store, cleanup } = fixture();
  try {
    assert.strictEqual(typeof VM.todoCards, 'function', 'viewmodel.todoCards must stay exported (the board card list)');
    const c1 = grouped(store, 'rig the walk cycle', 'Animation pass');
    const c2 = grouped(store, 'retarget the idle', 'Animation pass');
    const c3 = grouped(store, 'blend the run', 'Animation pass');
    const s1 = standalone(store, 'bump the changelog');
    maintenance(store, 'hidden maintenance');

    // collapsed (no expanded arg — the default)
    const entries = VM.todoCards!(store);
    const heads = entries.filter((e) => e.id.startsWith(OBJ));
    assert.equal(heads.length, 1, 'exactly one group entry for the shared objective');
    assert.match(heads[0].title, /Animation pass/, 'the group entry label carries the objective name');
    assert.match(heads[0].title, /\(3 open\)/, "and the open count in the '(N open)' shape");
    assert.deepEqual(
      sorted(entries.map((e) => e.id)),
      sorted([heads[0].id, s1.id]),
      'collapsed: the group entry plus the standalone card — no children, no maintenance item'
    );
    assert.equal(entries.find((e) => e.id === s1.id)!.title, 'bump the changelog', "a standalone entry's title is still its todo text");

    // expanded: the children follow the header, in order, each keyed by record id
    const opened = VM.todoCards!(store, [heads[0].id]);
    const at = opened.findIndex((e) => e.id === heads[0].id);
    assert.ok(at >= 0, 'the group entry is still present when expanded');
    assert.deepEqual(
      opened.slice(at + 1, at + 4).map((e) => e.id),
      [c1.id, c2.id, c3.id],
      'the three children follow their header, keyed by their own record ids'
    );
    assert.equal(opened.length, 5, 'header + three children + one standalone card');
    assert.ok(
      !opened.some((e) => /hidden maintenance/.test(e.title)),
      'the projection is still user-source only — grouping never widens the board filter'
    );

    // the committed one-arg call keeps compiling and behaving (todoCards(store))
    assert.deepEqual(
      sorted(todoCards(store).map((c) => c.id)),
      sorted(entries.map((e) => e.id)),
      'the one-arg call is the collapsed view — the new param is additive and optional'
    );
  } finally {
    cleanup();
  }
});
