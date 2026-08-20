import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// ---------------------------------------------------------------------------
// Spec for board e725979c — three additions to the board/queue API:
//   1. board_edit(id, find, replace)   — exactly-once find/replace on a board
//      item's text, in place (mirrors board_update's identity semantics —
//      decision a91c80b5 — NOT knowledge_edit's version-bump semantics).
//   2. board_get(id)                   — full untruncated item by id/prefix,
//      mirroring the knowledge id ladder (8-char prefix, refuse-if-ambiguous).
//   3. maintenance_query({feature_slug}) — narrows the queue to items owned
//      by one article, combinable with system_reason.
//
// None of these three exist yet — every test below is expected to fail at
// the type-check/compile step (tools.boardEdit / tools.boardGet do not exist
// on SterlingTools; maintenance_query's param type does not carry
// feature_slug) rather than at a runtime assertion. That IS the correct red
// shape for a not-yet-declared method — see the per-test note.
//
// ASSUMPTION FLAGGED (no interface was declared for the return shape of
// board_edit — only the call signature board_edit(id, find, replace) was
// given): this file assumes board_edit returns `{ record, replaced }`,
// mirroring knowledge_edit's write contract (the AC explicitly invokes
// "knowledge_edit's ... semantics"), with `record` being the board item
// itself (id preserved, text/updated_at changed) and `replaced` describing
// the edit the way knowledge_edit's `replaced` does. The AC1/AC2 assertions
// that matter (id preservation, updated_at movement, exactly-once refusal)
// are written to depend only on `record`/the thrown message, never on the
// exact shape of `replaced`, to keep this assumption low-risk. If the
// conductor's implementation returns the bare record instead (mirroring
// board_update), only the `.record` vs bare-value indirection needs
// adjusting — flagged explicitly at the point of use below.
// ---------------------------------------------------------------------------

const NOW = '2026-06-10T12:00:00.000Z';
const LATER = '2026-06-10T13:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-gaps-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function mkArticle(tools: SterlingTools, slug: string, path: string) {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: `${slug} does the thing`,
    intended_behavior: `${slug} intends`,
    files: [{ path, role: 'owner' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as { id: string; slug: string };
}

// Unwraps board_edit's assumed `{ record, replaced }` envelope. If the real
// implementation returns the bare record (board_update's shape) instead,
// this is the one place to change: `result` in place of `result.record`.
function editedItem(result: unknown): { id: string; text: string; updated_at: string; status: string } {
  return (result as { record: { id: string; text: string; updated_at: string; status: string } }).record;
}

// ---------------------------------------------------------------------------
// 1. board_edit — AC1: replaces one passage in place, id preserved, updated_at moves
// ---------------------------------------------------------------------------

test('AC1: board_edit replaces a unique passage in a user board item text without retransmitting it; id preserved, updated_at moves', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export with header', source: 'user', priority: 'low' }) as unknown as {
      record: { id: string; text: string; created_at: string; updated_at: string };
    };

    // A second clock sharing the SAME store — the harness freezes `now`, so a
    // second instance is how updated_at's movement becomes observable at all
    // (same idiom as board_update's own test).
    const laterTools = new SterlingTools({ store, now: () => LATER });

    // EXPECTED FAILURE TODAY: TS2339 "Property 'boardEdit' does not exist on
    // type 'SterlingTools'" (compile-time) — board_edit is not implemented.
    const after = editedItem(laterTools.boardEdit(original.id, 'with header', 'with headers'));

    assert.equal(after.id, original.id, 'the id is PRESERVED — board_edit is an in-place edit, not a supersession (decision a91c80b5)');
    assert.equal(after.text, 'ship csv export with headers', 'exactly the matched passage changed, the rest of the text intact');
    assert.equal(after.updated_at, LATER, 'updated_at moves to the write-time clock');
    assert.notEqual(after.updated_at, original.updated_at, 'and differs from the original stamp');
    assert.equal(after.status, 'active', 'editing a live item never changes its status');

    // still exactly one item on the board — an edit never mints a second record
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. board_edit — AC2: zero and multiple matches both refused, naming the
//    count; the item is left byte-for-byte unchanged either way.
// ---------------------------------------------------------------------------

test('AC2: board_edit refuses a zero-match find and an ambiguous multi-match find, naming the count, writing nothing', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({
      text: 'the widget breaks. the widget breaks again.',
      source: 'user',
    }) as unknown as { record: { id: string; text: string } };

    // EXPECTED FAILURE TODAY: TS2339 on tools.boardEdit — same as AC1.
    assert.throws(
      () => tools.boardEdit(original.id, 'absent phrase', 'x'),
      (e: Error) => {
        // Loose on exact wording (per the dispatch's instruction); pinned on
        // the fact that a ZERO match is distinguishable from a miss report —
        // mirrors knowledge_edit's 'does not appear ... nothing was written'.
        assert.match(e.message, /0|does not appear|no match/i, 'names the zero-match condition');
        return true;
      },
      'a find with zero matches is refused, not silently a no-op'
    );

    assert.throws(
      () => tools.boardEdit(original.id, 'the widget breaks', 'the widget is fine'),
      (e: Error) => {
        // The count (2) must be named — that is the one thing pinned per the
        // dispatch's "pin the count/id being named, not exact sentences".
        assert.match(e.message, /2/, 'the AMBIGUOUS-match refusal names the count of matches (2)');
        return true;
      },
      'a find with more than one match is refused, naming the count'
    );

    // both refusals wrote NOTHING — the item is unchanged, byte for byte.
    const [unchanged] = tools.boardQuery({ source: 'user' }) as unknown as { id: string; text: string }[];
    assert.equal(unchanged.id, original.id);
    assert.equal(unchanged.text, original.text, 'text is untouched by either refused edit');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. board_edit — AC3: works on maintenance (source:'system') items too.
// ---------------------------------------------------------------------------

test('AC3: board_edit edits a maintenance (source:system) item the same way — stale counts were half the measured defect', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: original } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing' — 3 callers found`,
      file_keys: ['src/thing.ts'],
    }) as unknown as { record: { id: string } };

    // EXPECTED FAILURE TODAY: TS2339 on tools.boardEdit — same as AC1/AC2.
    const after = editedItem(tools.boardEdit(original.id, '3 callers found', '5 callers found'));
    assert.equal(after.id, original.id, 'id preserved on a system item exactly as on a user item');
    assert.equal(after.text, `reconcile 'thing' — 5 callers found`);

    const [inQueue] = tools.maintenanceQuery({ cap: 10 }) as unknown as { id: string; text: string }[];
    assert.equal(inQueue.id, original.id);
    assert.equal(inQueue.text, `reconcile 'thing' — 5 callers found`, 'the maintenance_query view reflects the edit');

    // the exactly-once refusal applies here too — this is the SAME tool, not
    // a parallel implementation that could drift from the user-item path.
    assert.throws(() => tools.boardEdit(original.id, 'nonexistent text', 'x'), /0|does not appear|no match/i);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. board_get — AC4: full untruncated item by id; refuses unknown id naming
//    it; resolves an unambiguous 8-char prefix (mirrors the knowledge id
//    ladder tested for knowledge_get).
// ---------------------------------------------------------------------------

test('AC4: board_get returns the full untruncated item, refuses an unknown id naming it, and resolves an unambiguous 8-char prefix', () => {
  const { tools, cleanup } = harness();
  try {
    const longText = `item: ${'y'.repeat(3000)}`;
    const { record: item } = tools.boardAdd({ text: longText, source: 'user', priority: 'high' }) as unknown as {
      record: { id: string; text: string };
    };

    // EXPECTED FAILURE TODAY: TS2339 "Property 'boardGet' does not exist on
    // type 'SterlingTools'" (compile-time) — board_get is not implemented.
    const full = tools.boardGet(item.id) as unknown as { id: string; text: string };
    assert.equal(full.id, item.id);
    assert.equal(full.text, longText, 'the FULL text, byte for byte — untruncated, unlike the digest projection');
    assert.ok(!/…$/.test(full.text), 'no clipping ellipsis — board_get is the escape hatch from the digest view');

    // 8-char prefix resolves when unambiguous — mirrors knowledge_get's ladder.
    const byPrefix = tools.boardGet(item.id.slice(0, 8)) as unknown as { id: string };
    assert.equal(byPrefix.id, item.id, 'an 8-char prefix resolves to the same item');

    // an unknown id is refused, naming the id that was not found.
    const unknownId = randomUUID();
    assert.throws(
      () => tools.boardGet(unknownId),
      (e: Error) => {
        assert.match(e.message, /no record|not found/i, 'names the miss');
        assert.ok(e.message.includes(unknownId), 'and names the SPECIFIC id that was not found');
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. maintenance_query — AC5: feature_slug filter narrows to items owned by
//    that article, excludes unlinked/other-owned items, combines with
//    system_reason.
// ---------------------------------------------------------------------------

test('AC5: maintenance_query({feature_slug}) returns only items owned by that article, excluding unlinked and other-owned items', () => {
  const { tools, cleanup } = harness();
  try {
    const alpha = mkArticle(tools, 'alpha-thing', 'src/alpha.ts');
    const beta = mkArticle(tools, 'beta-thing', 'src/beta.ts');

    const alphaReconcile = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'alpha-thing'`,
      file_keys: ['src/alpha.ts'],
      feature_link: alpha.id,
    }) as unknown as { record: { id: string } };
    const alphaRefresh = tools.maintenanceEnqueue({
      reason: 'refresh_reference',
      text: `refresh 'alpha-thing'`,
      file_keys: ['src/alpha.ts'],
      feature_link: alpha.id,
    }) as unknown as { record: { id: string } };
    tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'beta-thing'`,
      file_keys: ['src/beta.ts'],
      feature_link: beta.id,
    });
    tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `unlinked drift item`,
    });

    // EXPECTED FAILURE TODAY: either a TS2353 "Object literal may only
    // specify known properties, and 'feature_slug' does not exist in type
    // ..." at compile time (if maintenance_query's filter type is closed), or
    // a runtime assertion failure returning all 4 items unfiltered (if the
    // param type is loose and the filter is simply not implemented) — the
    // count assertion below (2, not 4) is what pins that shape either way.
    const owned = tools.maintenanceQuery({ feature_slug: 'alpha-thing', cap: 1000 } as unknown as Record<string, unknown>) as unknown as {
      id: string;
    }[];
    assert.equal(owned.length, 2, 'exactly the two alpha-owned items — beta and the unlinked item are excluded');
    assert.deepEqual(
      owned.map((i) => i.id).sort(),
      [alphaReconcile.record.id, alphaRefresh.record.id].sort(),
      'the two items are precisely alpha-thing\'s reconcile_needed and refresh_reference entries'
    );

    // combines with system_reason narrowing — a genuine AND, not an override.
    const ownedAndReason = tools.maintenanceQuery({
      feature_slug: 'alpha-thing',
      system_reason: 'reconcile_needed',
      cap: 1000,
    } as unknown as Record<string, unknown>) as unknown as { id: string }[];
    assert.equal(ownedAndReason.length, 1, 'feature_slug AND system_reason both narrow together');
    assert.equal(ownedAndReason[0].id, alphaReconcile.record.id);

    // a slug with no matching article: no items resolve to it, so the filter
    // yields nothing (this boundary was not pinned by an explicit refusal in
    // the dispatch's AC text — flagged as an inferred, not stated, shape; if
    // the intended behavior is instead to REFUSE an unresolvable slug, only
    // this one assertion needs to become an assert.throws).
    const unknownSlug = tools.maintenanceQuery({ feature_slug: 'no-such-article', cap: 1000 } as unknown as Record<string, unknown>) as unknown as {
      id: string;
    }[];
    assert.equal(unknownSlug.length, 0, 'INFERRED boundary: an unresolvable feature_slug narrows to nothing, not an error');
  } finally {
    cleanup();
  }
});
