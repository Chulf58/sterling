// ---------------------------------------------------------------------------
// SPEC-ONLY pins for the board_query lane-advisory disclosure (undecided-slug
// dispatch brief, no decision id supplied to this dispatch). WRITTEN BLIND to
// the in-flight coder diff to packages/mcp-server/src/tools.ts — H4 forbids
// reading it while this slice lands. Harness and envelope-shape idioms copied
// verbatim from sibling conventions only, no implementation source read:
//   - store/tools instantiation + addRaw/queryResult casting idiom:
//     board-query-objective-filter.test.ts, board-provenance.test.ts
//   - boardQueryResult is the PROJECTING/ENVELOPE seam ({matched_filter,
//     returned, cap, capped, records, ...}) — count-projection.test.ts,
//     board-provenance.test.ts, board-item-name-render.test.ts all confirm
//     this is the seam the real MCP tool surface calls; boardQuery() is a
//     lower, non-enveloping seam and must NOT be used here (a scan that only
//     ran there would be unreachable from any real caller).
//   - structurally-typed ToolsView cast so the file COMPILES at HEAD against
//     an UNDECLARED field (`lane_advisory` does not exist on the real return
//     type yet): board-item-slug-mint.test.ts, board-item-name-render.test.ts.
//
// THE INTERFACE UNDER TEST (given verbatim in the dispatch brief — no other
// interface record was supplied, so this shape IS the declared interface):
//
//   lane_advisory: {
//     serialized_lane: 'implementation',
//     parallel_safe_lanes: ['read_only_scoping', 'test_authoring'],
//     collisions: [ { paths: [...], items: [{ id, name }, ...] } ]
//   }
//
// ASSUMPTIONS FLAGGED (no field-level interface was declared for these; each
// is the smallest reading of the brief plus the house rule it cites — see
// full flags in the handoff report, not resolved silently here):
//   (a) `parallel_safe_lanes` order is NOT pinned — AC2 only requires BOTH
//       lanes be named, so the assertion is order-insensitive (sorted-array
//       compare) rather than pinning the brief's example order literally.
//   (b) `name` on a collision item (AC7, "human-readable name beside its
//       id") is assumed to be the item's already-minted `slug` (S1,
//       board-item-slug-mint.test.ts / board-item-name-render.test.ts
//       establish `slug` as this codebase's one existing human-readable-name
//       concept for a todo). If the real field derives the name some other
//       way (e.g. from `text`), this is the line to move; the ANTI-bare-id
//       verdict (name !== id, name is a non-empty string distinct from the
//       raw uuid) is the part of AC7 pinned independently of that guess.
//   (c) the scan is keyed on EXACT shared file_keys path strings (not globs
//       or prefixes) — the brief says "sharing a file_keys path", read
//       literally as string equality, matching how file_keys is filtered
//       elsewhere in this surface (board_query's own `file_keys` param).
//
// EXPECTED STATE AT HEAD: RED (or import/compile-only if the coder lane
// landed first) — `lane_advisory` does not exist on boardQueryResult's return
// type today. Every test below names its single-line sabotage.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-29T12:00:00.000Z';

type Loose = Record<string, unknown>;

interface CollisionItem {
  id: string;
  name: string;
}
interface CollisionGroup {
  paths: string[];
  items: CollisionItem[];
}
interface LaneAdvisory {
  serialized_lane: string;
  parallel_safe_lanes: string[];
  collisions: CollisionGroup[];
}
interface Envelope {
  matched_filter: number;
  returned: number;
  cap: number;
  capped: boolean;
  records: Loose[];
  lane_advisory?: LaneAdvisory;
}

// Structurally-typed view so the file COMPILES at HEAD against a field
// (`lane_advisory`) that does not exist on the real return type yet — the
// board-item-slug-mint.test.ts / board-item-name-render.test.ts idiom.
interface ToolsView {
  boardAdd(fields: Loose): { record: Loose };
  boardQueryResult(filter: Loose): Envelope;
  // Added for the GAP3 raw-row fixtures below (seedLegacySluglessItemWithFields)
  // — the same `boardRemove` the sibling raw-row idiom
  // (board-item-slug-mint.test.ts / board-item-name-render.test.ts) uses to
  // discard the placeholder item cloned before mutation.
  boardRemove(id: string): Loose;
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-lane-collision-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const real = new SterlingTools({ store, now: () => NOW });
  const tools = real as unknown as ToolsView;
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function addRecord(tools: ToolsView, fields: Loose): Loose {
  return tools.boardAdd(fields).record;
}

const idsOf = (items: CollisionItem[]): string[] => items.map((i) => i.id).sort();

// ===========================================================================
// AC8 — CONTROL, FIRST. Must pass for the OPPOSITE reason to every arm below:
// it proves an ORDINARY query (single item, or items with no shared paths)
// behaves exactly as it does today and gains NOTHING. Without this, "the
// envelope has no lane_advisory below" could be explained by the mechanism
// never running at all rather than by the absence rule (AC3) actually firing
// on a genuine no-collision case.
// ===========================================================================
test('AC8 (control): a single item, and items with no shared file_keys, behave exactly as an ordinary board_query does today — no lane_advisory, records untouched', () => {
  // SABOTAGE that must turn this RED: in packages/mcp-server/src/tools.ts,
  // make boardQueryResult ALWAYS attach a lane_advisory key (even an empty
  // one) regardless of whether any collision was found.
  const { tools, cleanup } = harness();
  try {
    const solo = addRecord(tools, { text: 'A LONE ITEM.\n\nbody.', source: 'user', file_keys: ['src/solo.ts'] });
    const r1 = tools.boardQueryResult({ source: 'user' });
    assert.equal(r1.matched_filter, 1, 'sanity: one item on the board');
    assert.ok(!('lane_advisory' in r1), 'a single item can never collide — no lane_advisory key at all');
    assert.equal((r1.records[0].id as string), solo.id, 'the one item is returned unchanged');

    const a = addRecord(tools, { text: 'ITEM A.\n\nbody.', source: 'user', file_keys: ['src/a.ts'] });
    const b = addRecord(tools, { text: 'ITEM B.\n\nbody.', source: 'user', file_keys: ['src/b.ts'] });
    const r2 = tools.boardQueryResult({ source: 'user' });
    assert.equal(r2.matched_filter, 3, 'sanity: three items now, disjoint file_keys');
    assert.ok(!('lane_advisory' in r2), 'disjoint file_keys across every item — still no collision, still no key');
    assert.deepEqual(
      idsOf(r2.records.map((r) => ({ id: r.id as string, name: '' }))),
      [a.id, b.id, solo.id].sort(),
      'and the record set is exactly the three items added, nothing filtered'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC3 — restated head-on with a genuine near-miss: two items exist and DO
// share a path with a SYSTEM item (so path-sharing is happening in the
// store) but the USER-source set itself has no internal collision. Proves
// absence is a real computed absence, not an accident of an empty board.
// ===========================================================================
test('AC3: no USER-source collision => lane_advisory key is ABSENT from the envelope entirely (asserted by `in`, not falsiness)', () => {
  // SABOTAGE that must turn this RED: in packages/mcp-server/src/tools.ts,
  // change `if (collisions.length) env.lane_advisory = {...}` to
  // unconditionally set `env.lane_advisory = { ...， collisions: [] }`.
  const { tools, cleanup } = harness();
  try {
    addRecord(tools, { text: 'USER OWNS SHARED.\n\nbody.', source: 'user', file_keys: ['src/shared.ts'] });
    addRecord(tools, { text: 'SYSTEM ALSO TOUCHES SHARED', source: 'system', system_reason: 'reconcile_needed', file_keys: ['src/shared.ts'] });

    const r = tools.boardQueryResult({});
    assert.equal(r.matched_filter, 2, 'sanity: both items matched by the unfiltered query');
    assert.ok(
      !('lane_advisory' in r),
      'only ONE user-source item touches the path — a user/system pair is never a qualifying collision — key must be absent, not present-and-empty'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC1 + AC2 + AC7 — the positive case, all three asserted on one fixture:
// two user items sharing a path produce a named collision group; the block
// names the serialized lane and both parallel-safe lanes; each item in the
// group carries a human-readable name beside its id.
// ===========================================================================
test('AC1/AC2/AC7: two USER items sharing a file_keys path produce a collision group naming both item ids + the shared path; the block names serialized_lane + both parallel-safe lanes; each item carries {id, name} with name never bare', () => {
  // AC1 SABOTAGE: in tools.ts, compare file_keys with strict array equality
  // (or index-only) instead of any-shared-path, so two items sharing one of
  // several file_keys paths are never grouped.
  // AC2 SABOTAGE: hardcode `parallel_safe_lanes: []` (or omit the key).
  // AC7 SABOTAGE: build collision items as `{ id }` only, dropping `name`.
  const { tools, cleanup } = harness();
  try {
    const a = addRecord(tools, { text: 'IMPLEMENT THE SHARED MODULE.\n\nbody.', source: 'user', file_keys: ['src/shared.ts', 'src/a-only.ts'] });
    const b = addRecord(tools, { text: 'WIRE THE SHARED MODULE.\n\nbody.', source: 'user', file_keys: ['src/shared.ts', 'src/b-only.ts'] });
    const c = addRecord(tools, { text: 'AN UNRELATED ITEM.\n\nbody.', source: 'user', file_keys: ['src/unrelated.ts'] });

    const r = tools.boardQueryResult({ source: 'user' });
    assert.equal(r.matched_filter, 3, 'sanity: three user items');
    assert.ok(r.lane_advisory, 'AC1: two items sharing a path must produce a lane_advisory block');

    const advisory = r.lane_advisory!;
    assert.equal(advisory.collisions.length, 1, 'AC1: exactly one collision group — c never joins, it shares no path');
    const group = advisory.collisions[0];
    assert.deepEqual(group.paths, ['src/shared.ts'], 'AC1: the group names the shared path, and only the shared one');
    assert.deepEqual(idsOf(group.items), [a.id, b.id].sort(), 'AC1: the group names exactly the two colliding item ids');
    assert.ok(
      !idsOf(group.items).includes(c.id as string),
      'AC1: the unrelated item never joins the group'
    );

    // AC2 — serialized_lane + BOTH parallel-safe lanes named. Order is not
    // pinned (see ASSUMPTION (a) at file header); both members must be present.
    assert.equal(advisory.serialized_lane, 'implementation', 'AC2: the constrained lane is named implementation');
    assert.deepEqual(
      [...advisory.parallel_safe_lanes].sort(),
      ['read_only_scoping', 'test_authoring'].sort(),
      'AC2: both parallel-safe lanes are named, order-insensitive'
    );

    // AC7 — every item in the group carries {id, name}, name human-readable,
    // never a bare id. See ASSUMPTION (b): name is checked against the
    // item's already-minted slug, the one existing "name" concept for a todo.
    for (const rawItem of [a, b]) {
      const entry = group.items.find((i) => i.id === rawItem.id);
      assert.ok(entry, `AC7: item ${String(rawItem.id)} is present in the group`);
      assert.equal(typeof entry!.name, 'string', 'AC7: name is a string');
      assert.ok(entry!.name.length > 0, 'AC7: name is non-empty');
      assert.notEqual(entry!.name, entry!.id, 'AC7: name is never the bare id repeated');
      assert.ok(!/^[0-9a-f-]{36}$/.test(entry!.name), 'AC7: name is not itself a uuid dressed up as a name');
      assert.equal(entry!.name, rawItem.slug as string, "AC7 (assumption b): name is the item's minted slug — the codebase's one existing human-readable-name concept for a todo");
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC4 — SYSTEM-source items never join a collision group, even sharing a
// path with TWO colliding user items (so the group is already forming).
// ===========================================================================
test('AC4: a SYSTEM-source item sharing the same path as a genuine user/user collision never joins the group, and never appears in `items` or contributes its id', () => {
  // SABOTAGE that must turn this RED: in tools.ts, scan `boardFiltered(filter)`
  // (which spans both sources) for the collision instead of filtering to
  // source === 'user' first.
  const { tools, cleanup } = harness();
  try {
    const a = addRecord(tools, { text: 'USER ITEM A ON SHARED.\n\nbody.', source: 'user', file_keys: ['src/shared.ts'] });
    const b = addRecord(tools, { text: 'USER ITEM B ON SHARED.\n\nbody.', source: 'user', file_keys: ['src/shared.ts'] });
    const sys = addRecord(tools, {
      text: 'SYSTEM ITEM ALSO ON SHARED',
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['src/shared.ts'],
    });

    const r = tools.boardQueryResult({});
    assert.equal(r.matched_filter, 3, 'sanity: all three items matched by an unfiltered query');
    assert.ok(r.lane_advisory, 'the genuine user/user collision still fires');
    const group = r.lane_advisory!.collisions[0];
    assert.deepEqual(idsOf(group.items), [a.id, b.id].sort(), 'AC4: only the two user items are in the group');
    assert.ok(
      !group.items.some((i) => i.id === sys.id),
      'AC4: the system item never appears in `items`, despite sharing the exact same path'
    );
    assert.ok(
      !JSON.stringify(r.lane_advisory).includes(sys.id as string),
      'AC4: the system item id does not appear anywhere in the lane_advisory block'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC5 — the scan runs over the FULL MATCHED SET, not the post-cap window.
// Three user items share a path; cap:1 windows `records` to one item, but
// the collision must still report all colliding ids.
// ===========================================================================
test('AC5: with cap SMALLER than the colliding set, the collision is still reported in full — the scan runs over the matched set, not the post-cap `records` window', () => {
  // SABOTAGE that must turn this RED: in tools.ts, compute the collision scan
  // AFTER slicing to `cap` (i.e. run it over `records` instead of the full
  // boardFiltered(filter) result before the cap is applied).
  const { tools, cleanup } = harness();
  try {
    const a = addRecord(tools, { text: 'ITEM ONE ON SHARED.\n\nbody.', source: 'user', file_keys: ['src/shared.ts'] });
    const b = addRecord(tools, { text: 'ITEM TWO ON SHARED.\n\nbody.', source: 'user', file_keys: ['src/shared.ts'] });
    const c = addRecord(tools, { text: 'ITEM THREE ON SHARED.\n\nbody.', source: 'user', file_keys: ['src/shared.ts'] });

    const r = tools.boardQueryResult({ source: 'user', cap: 1 });
    assert.equal(r.matched_filter, 3, 'the TRUE matched total is still 3 — cap never changes matched_filter');
    assert.equal(r.records.length, 1, 'sanity: the records window is genuinely capped to 1');
    assert.equal(r.capped, true, 'sanity: capped is true — more matched than shown');

    assert.ok(r.lane_advisory, 'AC5: the collision fires even though the returned window is too small to see it by eye');
    const group = r.lane_advisory!.collisions[0];
    assert.deepEqual(
      idsOf(group.items),
      [a.id, b.id, c.id].sort(),
      'AC5: all THREE colliding ids are named, not just the one item inside the cap window'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC6 — `records` is returned completely unchanged: same items, same
// content, nothing filtered or rewritten, when a collision is present.
// ===========================================================================
test('AC6: `records` is returned COMPLETELY UNCHANGED when a collision fires — same count, same ids, same text/priority/file_keys verbatim, nothing filtered or annotated', () => {
  // SABOTAGE that must turn this RED: in tools.ts, when a collision is
  // detected, append a marker/annotation string to the colliding items'
  // `text` field (mirroring the unrelated file_keys-changed annotation
  // pattern elsewhere in this file) instead of leaving records untouched.
  const { tools, cleanup } = harness();
  try {
    const aText = 'ITEM A ON SHARED.\n\nbody prose for A.';
    const bText = 'ITEM B ON SHARED.\n\nbody prose for B.';
    const cText = 'UNRELATED ITEM C.\n\nbody prose for C.';
    const a = addRecord(tools, { text: aText, source: 'user', priority: 'high', file_keys: ['src/shared.ts'] });
    const b = addRecord(tools, { text: bText, source: 'user', priority: 'low', file_keys: ['src/shared.ts'] });
    const c = addRecord(tools, { text: cText, source: 'user', file_keys: ['src/unrelated.ts'] });

    const r = tools.boardQueryResult({ source: 'user' });
    assert.ok(r.lane_advisory, 'sanity: the collision does fire on this fixture');
    assert.equal(r.matched_filter, 3, 'sanity: three items matched');
    assert.equal(r.records.length, 3, 'AC6: no record was filtered out because it participates in a collision');

    const byId = new Map(r.records.map((rec) => [rec.id as string, rec]));
    assert.equal(byId.get(a.id as string)!.text, aText, 'AC6: item A text is byte-for-byte unchanged — no collision annotation appended');
    assert.equal(byId.get(b.id as string)!.text, bText, 'AC6: item B text is byte-for-byte unchanged');
    assert.equal(byId.get(c.id as string)!.text, cText, 'AC6: the non-colliding item is unchanged too');
    assert.equal(byId.get(a.id as string)!.priority, 'high', 'AC6: priority untouched');
    assert.equal(byId.get(b.id as string)!.priority, 'low', 'AC6: priority untouched');
    assert.deepEqual(byId.get(a.id as string)!.file_keys, ['src/shared.ts'], 'AC6: file_keys untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GAP 1 — MULTI-PATH GROUP MERGING (reviewer-confirmed gap, added post-review).
// Groups are keyed by their item-id SET (tools.ts:5090), so two paths shared
// by the SAME PAIR of items must merge into ONE group with paths.length===2.
// GAP1a pins the positive merge; GAP1b pins the negative that makes the merge
// meaningful — a third item sharing only ONE of the two paths must not fold
// into that group, because introducing it changes the item-id set for that
// one path.
// ===========================================================================
test('GAP1a: two items sharing TWO file_keys paths merge into ONE collision group with paths.length===2 — not two separate 1-path groups (group key = item-id SET, tools.ts:5090)', () => {
  // SABOTAGE that must turn this RED: in tools.ts, change the collision group
  // key from the item-id SET (`items.map(id).join(' ')`) to a per-path key
  // (e.g. key by the path string itself), so the two shared paths each mint
  // their own group instead of merging into one.
  const { tools, cleanup } = harness();
  try {
    const a = addRecord(tools, { text: 'GAP1A ITEM A SHARES TWO PATHS.\n\nbody.', source: 'user', file_keys: ['src/gap1-p1.ts', 'src/gap1-p2.ts'] });
    const b = addRecord(tools, { text: 'GAP1A ITEM B SHARES TWO PATHS.\n\nbody.', source: 'user', file_keys: ['src/gap1-p1.ts', 'src/gap1-p2.ts'] });

    const r = tools.boardQueryResult({ source: 'user' });
    assert.ok(r.lane_advisory, 'the shared paths produce a collision');
    const groups = r.lane_advisory!.collisions;
    assert.equal(groups.length, 1, 'GAP1a: exactly ONE group — the two paths merge because A and B share BOTH of them identically, nobody else touches either');
    const [group] = groups;
    assert.deepEqual(idsOf(group.items), [a.id as string, b.id as string].sort(), 'GAP1a: the group names exactly A and B');
    assert.equal(group.paths.length, 2, 'GAP1a: the merged group carries BOTH shared paths — paths.length === 2, not 1');
    assert.deepEqual([...group.paths].sort(), ['src/gap1-p1.ts', 'src/gap1-p2.ts'], 'GAP1a: both paths are present, none dropped by the merge');
  } finally {
    cleanup();
  }
});

test('GAP1b (negative — the merge is exact-item-set-only): a THIRD item sharing only ONE of two paths never folds into the pair\'s group; the two paths split into separate groups keyed by their own distinct item sets', () => {
  // SABOTAGE that must turn this RED: in tools.ts, widen the group key to
  // merge on ANY shared path overlap (e.g. key by set INTERSECTION, or by a
  // single representative path) instead of exact item-id-set equality, so
  // item C below gets folded into the {A,B} group.
  const { tools, cleanup } = harness();
  try {
    const a = addRecord(tools, { text: 'GAP1B ITEM A.\n\nbody.', source: 'user', file_keys: ['src/gap1-q1.ts', 'src/gap1-q2.ts'] });
    const b = addRecord(tools, { text: 'GAP1B ITEM B.\n\nbody.', source: 'user', file_keys: ['src/gap1-q1.ts', 'src/gap1-q2.ts'] });
    const c = addRecord(tools, { text: 'GAP1B ITEM C SHARES ONLY ONE PATH.\n\nbody.', source: 'user', file_keys: ['src/gap1-q1.ts'] });
    const aId = a.id as string;
    const bId = b.id as string;
    const cId = c.id as string;

    const r = tools.boardQueryResult({ source: 'user' });
    assert.ok(r.lane_advisory, 'the shared paths still produce collisions');
    const groups = r.lane_advisory!.collisions;

    const sortedAB = [aId, bId].sort();
    const sortedABC = [aId, bId, cId].sort();
    const exactAB = groups.find((g) => JSON.stringify(idsOf(g.items)) === JSON.stringify(sortedAB));
    const withC = groups.find((g) => JSON.stringify(idsOf(g.items)) === JSON.stringify(sortedABC));

    assert.ok(exactAB, 'GAP1b: a group whose item set is EXACTLY {A,B} must still exist (formed by q2, which only they share)');
    assert.equal(exactAB!.paths.length, 1, 'GAP1b: that exact-{A,B} group carries only q2 — q1 does NOT merge into it, because q1\'s item set is {A,B,C}, not {A,B}');
    assert.deepEqual(exactAB!.paths, ['src/gap1-q2.ts'], 'GAP1b: specifically the one path only A and B share');
    assert.ok(!exactAB!.items.some((i) => i.id === cId), 'GAP1b: item C never appears in the exact-{A,B} group');

    assert.ok(withC, 'GAP1b: item C appears in its own group, formed over q1, which all three share');
    assert.deepEqual(idsOf(withC!.items), sortedABC, 'GAP1b: that group\'s item set is exactly {A,B,C}');
    assert.deepEqual(withC!.paths, ['src/gap1-q1.ts'], 'GAP1b: and it carries only q1 — never merged with q2');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GAP 2 — ORDERING DETERMINISM (reviewer-confirmed gap). Groups sort
// widest-collision-first (tools.ts:5107); paths within a group sort. GAP2a
// pins group ordering across three DIFFERENT widths (item counts) so
// "widest first" cannot pass by accident on a two-group fixture. GAP2b pins
// that a group's `paths` array is sorted, not left in file_keys insertion
// order.
// ===========================================================================
test('GAP2a: collision groups sort WIDEST (most colliding items) FIRST — pinned across three groups of three different widths so the ordering cannot pass by accident (tools.ts:5107)', () => {
  // SABOTAGE that must turn this RED: reverse the widest-first sort
  // comparator in tools.ts's collision-group sort (or delete the sort call
  // entirely, leaving groups in insertion/Map order).
  const { tools, cleanup } = harness();
  try {
    const wide = [
      addRecord(tools, { text: 'GAP2A WIDE ITEM 1.\n\nbody.', source: 'user', file_keys: ['src/gap2-wide.ts'] }),
      addRecord(tools, { text: 'GAP2A WIDE ITEM 2.\n\nbody.', source: 'user', file_keys: ['src/gap2-wide.ts'] }),
      addRecord(tools, { text: 'GAP2A WIDE ITEM 3.\n\nbody.', source: 'user', file_keys: ['src/gap2-wide.ts'] }),
      addRecord(tools, { text: 'GAP2A WIDE ITEM 4.\n\nbody.', source: 'user', file_keys: ['src/gap2-wide.ts'] }),
    ];
    const mid = [
      addRecord(tools, { text: 'GAP2A MID ITEM 1.\n\nbody.', source: 'user', file_keys: ['src/gap2-mid.ts'] }),
      addRecord(tools, { text: 'GAP2A MID ITEM 2.\n\nbody.', source: 'user', file_keys: ['src/gap2-mid.ts'] }),
      addRecord(tools, { text: 'GAP2A MID ITEM 3.\n\nbody.', source: 'user', file_keys: ['src/gap2-mid.ts'] }),
    ];
    const narrow = [
      addRecord(tools, { text: 'GAP2A NARROW ITEM 1.\n\nbody.', source: 'user', file_keys: ['src/gap2-narrow.ts'] }),
      addRecord(tools, { text: 'GAP2A NARROW ITEM 2.\n\nbody.', source: 'user', file_keys: ['src/gap2-narrow.ts'] }),
    ];

    const r = tools.boardQueryResult({ source: 'user' });
    assert.equal(r.matched_filter, 9, 'sanity: four + three + two items, three disjoint paths');
    assert.ok(r.lane_advisory, 'three independent path collisions fire');
    const groups = r.lane_advisory!.collisions;
    assert.equal(groups.length, 3, 'sanity: exactly three collision groups, one per disjoint path');

    assert.deepEqual(
      groups.map((g) => g.items.length),
      [4, 3, 2],
      `GAP2a: groups sort by item count DESCENDING — widest collision first. Got widths ${JSON.stringify(groups.map((g) => g.items.length))}`
    );
    assert.deepEqual(
      idsOf(groups[0].items),
      idsOf(wide.map((it) => ({ id: it.id as string, name: '' }))),
      'GAP2a: position 0 is genuinely the 4-item (wide) group'
    );
    assert.deepEqual(
      idsOf(groups[2].items),
      idsOf(narrow.map((it) => ({ id: it.id as string, name: '' }))),
      'GAP2a: position 2 is genuinely the 2-item (narrow) group'
    );
    void mid;
  } finally {
    cleanup();
  }
});

test('GAP2b: paths within a single collision group are returned SORTED, never left in file_keys insertion order (tools.ts, same sort pass as GAP2a, ~5107)', () => {
  // SABOTAGE that must turn this RED: remove (or skip) the `.sort()` applied
  // to a group's `paths` array before it is placed on the envelope, leaving
  // whatever Set/insertion order the scan built it in.
  const { tools, cleanup } = harness();
  try {
    const a = addRecord(tools, {
      text: 'GAP2B ITEM A.\n\nbody.',
      source: 'user',
      file_keys: ['src/gap2b-zzz.ts', 'src/gap2b-aaa.ts', 'src/gap2b-mmm.ts'],
    });
    const b = addRecord(tools, {
      text: 'GAP2B ITEM B.\n\nbody.',
      source: 'user',
      file_keys: ['src/gap2b-mmm.ts', 'src/gap2b-zzz.ts', 'src/gap2b-aaa.ts'],
    });

    const r = tools.boardQueryResult({ source: 'user' });
    assert.ok(r.lane_advisory, 'the three shared paths produce a collision');
    assert.equal(r.lane_advisory!.collisions.length, 1, 'sanity: one group, formed by all three shared paths');
    const [group] = r.lane_advisory!.collisions;
    assert.deepEqual(idsOf(group.items), [a.id as string, b.id as string].sort(), 'sanity: the group is A and B');
    assert.equal(group.paths.length, 3, 'sanity: all three shared paths are present');
    assert.deepEqual(
      group.paths,
      ['src/gap2b-aaa.ts', 'src/gap2b-mmm.ts', 'src/gap2b-zzz.ts'],
      `GAP2b: paths are sorted alphabetically regardless of insertion order in either item's file_keys. Got ${JSON.stringify(group.paths)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GAP 3 — THE SLUGLESS NAME FALLBACK (reviewer-confirmed gap). boardItemName
// (tools.ts ~5131) falls back to the clipped first non-blank line of `text`
// for an item with no slug, and to the literal '(unnamed board item)' when
// there is neither a slug nor any non-blank line. The existing AC7 pin above
// only exercises `name === rawItem.slug`; these two pin the fallback branch
// directly, as a DELIBERATE divergence from headlineRecord's stricter
// "absent name over wrong name" rule (packages/schemas/src/records.ts:806-816)
// — the justification being that a bare-uuid collision group is exactly the
// unanswerable-question failure the human-readable-name rule exists to
// prevent, so this surface renders SOMETHING rather than nothing.
// ===========================================================================

// A slugless LEGACY board row with CALLER-CONTROLLED `text` / `file_keys`. A
// NEW helper extending the sibling raw-row idiom (seedLegacySluglessItem in
// board-item-slug-mint.test.ts / board-item-name-render.test.ts) rather than
// modifying it: those two fixed their text to a mint-friendly headline, and
// GAP3 needs to control the text precisely (a leading blank line; an
// all-whitespace body) to exercise both fallback arms.
function seedLegacySluglessItemWithFields(store: SterlingStore, tools: ToolsView, overrides: Loose): string {
  const modern = addRecord(tools, {
    text: 'A PLACEHOLDER HEADLINE FOR THE RAW ROW.\n\nbody.',
    source: 'user',
    file_keys: ['src/gap3-placeholder.ts'],
  });
  const legacy = JSON.parse(JSON.stringify(modern)) as Loose;
  delete legacy.slug;
  legacy.id = randomUUID();
  Object.assign(legacy, overrides);
  store.create(legacy as unknown as Parameters<SterlingStore['create']>[0]);
  tools.boardRemove(modern.id as string); // full uuid — the permitted address form
  return legacy.id as string;
}

test('GAP3a: the slugless NAME FALLBACK is the clipped first NON-BLANK line of `text` (leading blank lines skipped), never the raw id or an empty string (boardItemName, tools.ts ~5131)', () => {
  // SABOTAGE that must turn this RED: in tools.ts's boardItemName, when
  // item.slug is falsy, return item.id (or any id-derived string) instead of
  // the clipped first non-blank line of text.
  const { store, tools, cleanup } = harness();
  try {
    const legacyId = seedLegacySluglessItemWithFields(store, tools, {
      text: '\n\nA SLUGLESS ITEM SHOWING THE TEXT FALLBACK\n\nbody prose.',
      file_keys: ['src/gap3a-shared.ts'],
    });
    addRecord(tools, { text: 'A NORMAL SIBLING ON THE SAME PATH.\n\nbody.', source: 'user', file_keys: ['src/gap3a-shared.ts'] });

    const r = tools.boardQueryResult({ source: 'user' });
    assert.ok(r.lane_advisory, 'the shared path produces a collision, exercising boardItemName for both items');
    const group = r.lane_advisory!.collisions[0];
    const entry = group.items.find((i) => i.id === legacyId);
    assert.ok(entry, 'GAP3a: the slugless item is present in the collision group');
    assert.equal(
      entry!.name,
      'A SLUGLESS ITEM SHOWING THE TEXT FALLBACK',
      `GAP3a: with no slug, the name falls back to the first NON-BLANK line of text — the leading blank line is skipped. Got "${String(entry!.name)}"`
    );
    assert.notEqual(entry!.name, legacyId, 'GAP3a: the fallback name is never the bare id');
  } finally {
    cleanup();
  }
});

test('GAP3b: the slugless name fallback is the LITERAL string "(unnamed board item)" when there is neither a slug NOR any non-blank line of text (boardItemName, tools.ts ~5131) — the deliberate divergence from headlineRecord\'s stricter rule', () => {
  // SABOTAGE that must turn this RED: in tools.ts's boardItemName, when there
  // is no slug and no non-blank line in text, return '' (or undefined, or the
  // raw id) instead of the literal string '(unnamed board item)'.
  const { store, tools, cleanup } = harness();
  try {
    const legacyId = seedLegacySluglessItemWithFields(store, tools, {
      text: '   \n\n\t\n   ',
      file_keys: ['src/gap3b-shared.ts'],
    });
    addRecord(tools, { text: 'A NORMAL SIBLING ON THE SAME PATH.\n\nbody.', source: 'user', file_keys: ['src/gap3b-shared.ts'] });

    const r = tools.boardQueryResult({ source: 'user' });
    assert.ok(r.lane_advisory, 'the shared path produces a collision, exercising boardItemName for both items');
    const group = r.lane_advisory!.collisions[0];
    const entry = group.items.find((i) => i.id === legacyId);
    assert.ok(entry, 'GAP3b: the blank-text slugless item is present in the collision group');
    assert.equal(
      entry!.name,
      '(unnamed board item)',
      `GAP3b: with no slug and no non-blank text line, the name is the literal fallback string. Got "${String(entry!.name)}"`
    );
  } finally {
    cleanup();
  }
});
