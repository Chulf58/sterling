// ---------------------------------------------------------------------------
// board_remove / maintenance_remove — drained-vs-live PREFIX COLLISION guard
//
// Sibling to board-maintenance-id-resolution.test.ts (frozen at 10/10 — NOT
// edited here). That file pins the id-resolution ladder itself (full uuid ->
// exact slug -> unambiguous 8-char prefix) landing on board_remove and
// maintenance_remove. THIS file specifies a narrower, sharper problem that
// the ladder's own landing creates:
//
//   Board rows are HARD-DELETED (unlike knowledge rows, which are only ever
//   superseded/retired, never deleted — decision 9948475b). A caller cites an
//   8-char prefix P for item A; A is removed; if a LIVE item B also starts
//   with P, the prefix now silently retargets to B on the next citation, and
//   B is destroyed by a caller who believes they are still talking about A.
//   This window is invisible to the ambiguous-prefix refusal the ladder
//   already has, because at the moment of the SECOND call there is only ONE
//   live candidate (B) — nothing about the live table alone looks ambiguous.
//   The guard this file specifies closes that window by also checking
//   whatever removal trail the previously-drained item A left behind: if a
//   drained id and a live id share the resolving prefix, the call must
//   refuse rather than silently retarget.
//
// Written SPEC-ONLY, blind to tools.ts's in-flight diff (H4). Reuses the
// sibling file's harness and its seedPrefixTwin CONVENTION (force a second
// record to a chosen 8-char prefix via store.create on a JSON-cloned real
// record, since ids are server-minted and a collision cannot be produced
// through the public tools alone) — adapted here to BOARD/MAINTENANCE shapes
// instead of a decision-shaped twin, because what must collide is a genuine
// drained board/maintenance removal, not a merely-ambiguous knowledge record.
//
// Collision construction (seedBoardDrainedCollision / seedMaintenanceDrainedCollision):
//   1. add the LIVE item B through the normal tool — its server-minted id
//      fixes the prefix P under test.
//   2. add a throwaway "shape donor" item through the same normal tool, then
//      remove it by ITS OWN full id immediately (a full-uuid removal is
//      pre-existing, already-working behavior on both old and new code —
//      see SPEC 3 below — so this setup step never itself goes red). This
//      is cleanup only: it keeps the donor's real-id row from lingering on
//      the board/queue as an unrelated extra item.
//   3. clone the donor's shape via store.create with id forced to
//      `${P}-0000-4000-8000-000000000000` — a genuine, fully-shaped live
//      board/maintenance row that happens to share B's prefix.
//   4. remove THAT forced-id row by its own full id (again, pre-existing
//      full-uuid removal) — this is the drained item A the guard must find:
//      an id sharing prefix P, with a removal trail, while B is still live.
//
// EXPECTED FAILURE SHAPES on current code (no drained-vs-live guard exists
// yet — the ladder pinned by the sibling file resolves a prefix against the
// LIVE table alone):
//   - SPEC 1 / SPEC 2: `board_remove(P)` / `maintenance_remove(P)` do not
//     throw at all — P resolves unambiguously to the still-live B (A is
//     already gone from the live table, so today's resolver sees exactly one
//     candidate) and REMOVES it. `assert.throws` reports "Missing expected
//     exception" as the first failure; the follow-on "B must still exist"
//     assertion fails too, for the same reason — B really was destroyed.
//   - SPEC 3 / 4 / 5 / 6 are regression/boundary pins and are expected GREEN
//     today AND after the guard lands (see each test for why).
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-22T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-remove-prefix-collision-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function withForcedId(record: Loose, forcedId: string): Loose {
  return { ...(JSON.parse(JSON.stringify(record)) as Loose), id: forcedId };
}

function prefixedId(prefix: string): string {
  return `${prefix}-0000-4000-8000-000000000000`;
}

// Builds: a LIVE user-source board item, plus a drained item sharing its
// 8-char prefix (see file header for the construction steps). Returns the
// live id, the drained id, and the shared prefix.
function seedBoardDrainedCollision(
  store: SterlingStore,
  tools: SterlingTools,
  opts: { liveText: string; donorText: string }
): { liveId: string; drainedId: string; prefix: string } {
  const { record: live } = tools.boardAdd({ text: opts.liveText, source: 'user' }) as unknown as { record: Loose };
  const liveId = live.id as string;
  const prefix = liveId.slice(0, 8);

  const { record: donorShape } = tools.boardAdd({ text: opts.donorText, source: 'user' }) as unknown as { record: Loose };
  tools.boardRemove(donorShape.id as string); // discard the donor's own (non-colliding) real id

  const drainedId = prefixedId(prefix);
  store.create(withForcedId(donorShape, drainedId));
  tools.boardRemove(drainedId); // the removal that must leave a trail under `prefix`

  return { liveId, drainedId, prefix };
}

// Same idea for a system-source maintenance item (maintenance_remove's own
// source scoping — see idempotent-remove.test.ts AC4).
function seedMaintenanceDrainedCollision(
  store: SterlingStore,
  tools: SterlingTools,
  opts: { liveText: string; donorText: string }
): { liveId: string; drainedId: string; prefix: string } {
  const { record: live } = tools.maintenanceEnqueue({
    reason: 'article_missing',
    text: opts.liveText,
    file_keys: ['src/live-collision-target.ts'],
  }) as unknown as { record: Loose };
  const liveId = live.id as string;
  const prefix = liveId.slice(0, 8);

  const { record: donorShape } = tools.maintenanceEnqueue({
    reason: 'article_missing',
    text: opts.donorText,
    file_keys: ['src/donor-collision-shape.ts'],
  }) as unknown as { record: Loose };
  tools.maintenanceRemove(donorShape.id as string);

  const drainedId = prefixedId(prefix);
  store.create(withForcedId(donorShape, drainedId));
  tools.maintenanceRemove(drainedId);

  return { liveId, drainedId, prefix };
}

// ---------------------------------------------------------------------------
// SPEC 1 — board_remove refuses on a drained-vs-live prefix collision
// ---------------------------------------------------------------------------

test('SPEC 1: board_remove refuses a prefix that collides between a LIVE item and a previously-drained item sharing the same prefix — naming both ids, directing re-issue by full uuid — and the live item survives', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { liveId, drainedId, prefix } = seedBoardDrainedCollision(store, tools, {
      liveText: 'live item B — must survive the refused call',
      donorText: 'drained item A — hard-deleted under the same prefix',
    });

    assert.throws(
      () => tools.boardRemove(prefix),
      (err: Error) => {
        assert.ok(err.message.includes(liveId), `refusal must name the live candidate id (${liveId}) — got: "${err.message}"`);
        assert.ok(err.message.includes(drainedId), `refusal must name the drained candidate id (${drainedId}) — got: "${err.message}"`);
        assert.match(err.message, /full uuid|full id/i, 'refusal directs the caller to re-issue with the full uuid');
        return true;
      },
      'EXPECTED FAILURE on current code: board_remove has no drained-vs-live collision guard — it resolves `prefix` against the live table alone, finds `liveId` as the sole candidate, and REMOVES it; assert.throws reports "Missing expected exception" here'
    );

    const remaining = tools.boardQuery({ source: 'user' }) as unknown as { id: string }[];
    assert.equal(
      remaining.length,
      1,
      'EXPECTED FAILURE on current code too: on unguarded code the live item was actually removed by the call above, so exactly one item does not remain'
    );
    assert.equal(remaining[0]?.id, liveId, 'the surviving item is exactly the live one — never coin-flipped or silently retargeted');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 2 — same guard on maintenance_remove (system-source scoping)
// ---------------------------------------------------------------------------

test('SPEC 2: maintenance_remove refuses a prefix that collides between a LIVE system-source item and a previously-drained item sharing the same prefix — naming both ids, directing re-issue by full uuid — and the live item survives', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { liveId, drainedId, prefix } = seedMaintenanceDrainedCollision(store, tools, {
      liveText: 'live maintenance item B — must survive the refused call',
      donorText: 'drained maintenance item A — hard-deleted under the same prefix',
    });

    assert.throws(
      () => tools.maintenanceRemove(prefix),
      (err: Error) => {
        assert.ok(err.message.includes(liveId), `refusal must name the live candidate id (${liveId}) — got: "${err.message}"`);
        assert.ok(err.message.includes(drainedId), `refusal must name the drained candidate id (${drainedId}) — got: "${err.message}"`);
        assert.match(err.message, /full uuid|full id/i, 'refusal directs the caller to re-issue with the full uuid');
        return true;
      },
      'EXPECTED FAILURE on current code: maintenance_remove has no drained-vs-live collision guard — it resolves `prefix` against the live queue alone, finds `liveId` as the sole candidate, and REMOVES it; assert.throws reports "Missing expected exception" here'
    );

    const remaining = tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[];
    assert.equal(
      remaining.length,
      1,
      'EXPECTED FAILURE on current code too: on unguarded code the live item was actually removed by the call above, so exactly one item does not remain'
    );
    assert.equal(remaining[0]?.id, liveId, 'the surviving item is exactly the live one — never coin-flipped or silently retargeted');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 3 — a full uuid is NEVER guarded (unambiguous by construction)
// ---------------------------------------------------------------------------

test('SPEC 3: board_remove(full uuid) succeeds and removes the live item even amid an identical drained/live prefix collision — the guard must not apply to a full uuid (regression pin, expected GREEN before and after the guard lands)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { liveId } = seedBoardDrainedCollision(store, tools, {
      liveText: 'live item B — removed by its own full uuid',
      donorText: 'drained item A sharing the prefix',
    });

    const result = tools.boardRemove(liveId) as unknown as { removed?: string; id?: string };
    const removedId = result.removed ?? result.id;
    assert.equal(
      removedId,
      liveId,
      'a full uuid is unambiguous by construction — the drained-vs-live collision guard must never refuse it, regardless of any colliding prefix elsewhere'
    );
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'the live item is actually gone');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 4 — non-colliding drain log entries never over-fire the guard
// ---------------------------------------------------------------------------

test('SPEC 4 (regression): a drain log containing removals under a DIFFERENT prefix does not block a live prefix removal (expected GREEN before and after the guard lands)', () => {
  const { tools, cleanup } = harness();
  try {
    // an unrelated item, removed by its own full id — a drain trail exists,
    // but under a prefix that does not match the one resolved below.
    const { record: unrelated } = tools.boardAdd({ text: 'unrelated drained item', source: 'user' }) as unknown as {
      record: { id: string };
    };
    tools.boardRemove(unrelated.id);

    const { record: live } = tools.boardAdd({ text: 'live item resolved by prefix', source: 'user' }) as unknown as {
      record: { id: string };
    };
    const prefix = live.id.slice(0, 8);
    assert.notEqual(
      prefix,
      unrelated.id.slice(0, 8),
      'sanity precondition: the drained item does not share the prefix under test'
    );

    const result = tools.boardRemove(prefix) as unknown as { removed?: string; id?: string };
    const removedId = result.removed ?? result.id;
    assert.equal(removedId, live.id, 'a non-colliding drain log entry must not make the guard over-fire on an unrelated prefix');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'the live item was actually removed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 5 — an empty drain log never over-fires the guard
// ---------------------------------------------------------------------------

test('SPEC 5 (regression): an empty drain log does not block a live prefix removal (expected GREEN before and after the guard lands)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: live } = tools.boardAdd({ text: 'only item on the board', source: 'user' }) as unknown as {
      record: { id: string };
    };
    const prefix = live.id.slice(0, 8);

    const result = tools.boardRemove(prefix) as unknown as { removed?: string; id?: string };
    const removedId = result.removed ?? result.id;
    assert.equal(removedId, live.id, 'prefix resolution still works with no drain log entries at all');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'the live item was actually removed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 6 — board_update is deliberately NOT guarded (recoverable in-place
// edit, not an irreversible delete — user ruling)
// ---------------------------------------------------------------------------

test('SPEC 6: board_update succeeds and updates the live item amid an identical drained/live prefix collision — deliberately not guarded (user ruling: in-place edit is recoverable, unlike delete; pins against a future over-correction, expected GREEN before and after)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { liveId, prefix } = seedBoardDrainedCollision(store, tools, {
      liveText: 'live item B — original text',
      donorText: 'drained item A sharing the prefix',
    });

    const updated = tools.boardUpdate(prefix, { text: 'live item B — updated text' }) as unknown as {
      id: string;
      text: string;
    };
    assert.equal(updated.id, liveId, 'board_update resolves the same collision-prone prefix without refusing');
    assert.equal(updated.text, 'live item B — updated text', 'the update actually landed');

    const [onBoard] = tools.boardQuery({ source: 'user' }) as unknown as { id: string; text: string }[];
    assert.equal(onBoard.id, liveId);
    assert.equal(
      onBoard.text,
      'live item B — updated text',
      'pin: a future over-correction that guards board_update the same way as board_remove must be caught by this test'
    );
  } finally {
    cleanup();
  }
});
