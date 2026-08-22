// ---------------------------------------------------------------------------
// REPLACED 2026-08-22 — this file's original subject (the drained-vs-live
// removal-trail collision guard on board_remove/maintenance_remove) was
// RETRACTED, not merely superseded-by-a-better-guard. Decision
// [id-ladder-extends-to-board-tools-with-collision-guard] / 6d5a6719-bc6a-4139-8ae4-dc6a026e72bb
// (v5) found, via two INDEPENDENT reviews (the roster reviewer-correctness
// agent and Codex — different model families, same conclusion):
//   1. CRITICAL — validateResolveClaim (the resolves:[] claim validator
//      shared by knowledge_update/append/edit) was exempted from the guard
//      on a FALSE "in-place edit" rationale: every claim it returns is
//      actually HARD-DELETED. A prefix reaching `resolves:[]` was therefore
//      exactly as dangerous as one reaching board_remove, through the one
//      exemption the guard's own author granted himself.
//   2. The removal trails the guard consulted (queue_drain_log,
//      activity_log) are capped at 50 rows EACH and evicted by ANY
//      created/updated/removed activity, not just removals — so the guard
//      was frequently just ABSENT, and an absent trail reads as permission
//      to delete.
//   3. Prefix resolution spans every mounted store while the guard read
//      only the project store.
// The general lesson (quoted in the ruling): "a bounded, evictable audit
// trail cannot make a forgiving addressing form safe for an operation that
// destroys." The fix is not a better guard — it is no guard: board_remove,
// maintenance_remove and validateResolveClaim now accept an EXACT ID ONLY
// (decision one-id-resolution-ladder-for-the-whole-knowledge-surface-app /
// 2debab53's original clause, restored). board_get/board_update/board_edit
// keep the ladder — a wrong target there is recoverable, not destroyed.
//
// DISPOSITION CHOICE (test-writer, 2026-08-22): the old guard-collision
// machinery (seedBoardDrainedCollision / seedMaintenanceDrainedCollision) is
// KEPT and REPURPOSED here, rather than folded into
// board-maintenance-id-resolution.test.ts, because this file's charter is
// now the CROSS-CUTTING invariant the retracted guard's absence leaves in
// its place — "no prefix reaches ANY destructive path, on any tool, under
// any construction" — spanning board_remove, maintenance_remove AND
// validateResolveClaim's resolves:[] parameter. The sibling file's charter
// is narrower and tool-local: what the ladder DOES vs DOES NOT resolve on
// each of board_update/board_remove/maintenance_remove individually. Folding
// the resolves:[] (knowledge-surface) cases into a board/maintenance-shaped
// harness file would blur that line for no benefit; a dedicated file keeps
// the "nothing destructive is prefix-addressable, full stop" property
// legible as ONE property proven across THREE call sites.
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

// The new contract's required refusal content (decision 6d5a6719): names the
// full-uuid requirement, and names WHY (hard-delete / silent-retarget risk).
// Flexible alternation, not an exact string — the precise wording is the
// implementer's to choose; the SUBSTANCE is what the ruling pins.
const FULL_UUID_REQUIRED = /full uuid|full id/i;
const HARD_DELETE_REASON = /hard.?delet|permanent(ly)? delet|irreversib|retarget/i;

function withForcedId(record: Loose, forcedId: string): Loose {
  return { ...(JSON.parse(JSON.stringify(record)) as Loose), id: forcedId };
}

function prefixedId(prefix: string): string {
  return `${prefix}-0000-4000-8000-000000000000`;
}

// Builds: a LIVE user-source board item, plus a drained item sharing its
// 8-char prefix — the EXACT scenario the retracted guard existed to catch.
// Uses full-uuid removals for setup steps (those are pre-existing, always
// worked behavior, before and after this ruling — see the regression pins
// below).
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
  tools.boardRemove(drainedId); // the removal that leaves a trail under `prefix`

  return { liveId, drainedId, prefix };
}

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
// PROPERTY — the retracted guard's own hardest trigger case is STILL caught,
// but now by the simpler blanket rule rather than by surveilling removal
// trails. These two are CONTINUITY pins, not red discriminators: the old
// guard ALSO refused in exactly this scenario (that was this file's own
// SPEC 1/2 before the rewrite), so this is expected GREEN before and after —
// the discriminating red for "prefix bypass on a destructive path" lives in
// board-maintenance-id-resolution.test.ts's NON-colliding-prefix cases,
// where old (guard) code had no reason to refuse at all.
// ---------------------------------------------------------------------------

test('board_remove refuses a prefix that collides between a LIVE item and a previously-drained item sharing the same prefix — via the plain exact-id-only rule, not by consulting a removal trail — live item survives (continuity pin: expected GREEN before and after, since the retracted guard also refused here)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { liveId, prefix } = seedBoardDrainedCollision(store, tools, {
      liveText: 'live item B — must survive the refused call',
      donorText: 'drained item A — hard-deleted under the same prefix',
    });

    assert.throws(
      () => tools.boardRemove(prefix),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `refusal must name the full-uuid requirement — got: "${err.message}"`);
        return true;
      },
      'expected to throw both before (guard-based refusal) and after (blanket exact-id-only refusal) this ruling'
    );

    const remaining = tools.boardQuery({ source: 'user' }) as unknown as { id: string }[];
    assert.equal(remaining.length, 1, 'the live item was not removed');
    assert.equal(remaining[0]?.id, liveId, 'and it is exactly the live one');
  } finally {
    cleanup();
  }
});

test('maintenance_remove refuses a prefix that collides between a LIVE item and a previously-drained item sharing the same prefix — via the plain exact-id-only rule — live item survives (continuity pin: expected GREEN before and after)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { liveId, prefix } = seedMaintenanceDrainedCollision(store, tools, {
      liveText: 'live maintenance item B — must survive the refused call',
      donorText: 'drained maintenance item A — hard-deleted under the same prefix',
    });

    assert.throws(
      () => tools.maintenanceRemove(prefix),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `refusal must name the full-uuid requirement — got: "${err.message}"`);
        return true;
      },
      'expected to throw both before (guard-based refusal) and after (blanket exact-id-only refusal) this ruling'
    );

    const remaining = tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[];
    assert.equal(remaining.length, 1, 'the live item was not removed');
    assert.equal(remaining[0]?.id, liveId, 'and it is exactly the live one');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// REGRESSION — a full uuid is NEVER subject to this rule (unambiguous and
// exact by construction); board_update is DELIBERATELY never subject to it
// either (recoverable in-place edit, not a destroy). Both expected GREEN
// before and after — neither was ever guarded, so the ruling reversal does
// not touch them.
// ---------------------------------------------------------------------------

test('board_remove(full uuid) succeeds and removes the live item even amid an identical drained/live prefix collision — a full uuid is never subject to the exact-id-only refusal because it already IS an exact id (regression pin, expected GREEN before and after)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { liveId } = seedBoardDrainedCollision(store, tools, {
      liveText: 'live item B — removed by its own full uuid',
      donorText: 'drained item A sharing the prefix',
    });

    const result = tools.boardRemove(liveId) as unknown as { removed?: string; id?: string };
    const removedId = result.removed ?? result.id;
    assert.equal(removedId, liveId, 'a full uuid removes unconditionally, regardless of any colliding prefix elsewhere');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'the live item is actually gone');
  } finally {
    cleanup();
  }
});

test('board_update succeeds and updates the live item amid an identical drained/live prefix collision — board_update is DELIBERATELY not subject to the exact-id-only rule (user ruling: in-place edit is recoverable, unlike delete) — pins against a future over-correction, expected GREEN before and after', () => {
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
      'pin: a future attempt to extend the exact-id-only rule to board_update must be caught by this test'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// CRITICAL FINDING (item 2 of the rewrite brief) — validateResolveClaim, the
// resolves:[] claim validator shared by knowledge_update/append/edit, hard-
// deletes every claim it returns. It was exempted from the (now-retracted)
// guard on a FALSE "in-place edit" rationale. Fixture modeled on
// resolves-claim.test.ts's own AC1/refusal shapes.
// ---------------------------------------------------------------------------

const mkArticle = (tools: SterlingTools, slug: string, path: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: [{ path, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as { id: string };

type Resolving = {
  knowledgeUpdate(id: string, patch: Record<string, unknown>, resolves?: string[]): unknown;
};
const widen = (tools: SterlingTools) => tools as unknown as Resolving;

function openIds(tools: SterlingTools): string[] {
  return (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);
}

test('CRITICAL: knowledge_update\'s resolves:[] parameter refuses an 8-char prefix — validateResolveClaim hard-deletes every claim it returns, so a prefix there is exactly as dangerous as one handed to board_remove — refusal names the full-uuid requirement, and the maintenance item the prefix names is STILL OPEN afterwards (survival asserted explicitly — the whole defect was SILENT deletion, not merely "did it throw")', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing'`,
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    }) as unknown as { record: { id: string } };
    const prefix = item.id.slice(0, 8);
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'reconciled' }, [prefix]),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `refusal must name the full-uuid requirement — got: "${err.message}"`);
        return true;
      },
      'EXPECTED FAILURE on current (pre-reversal) code: validateResolveClaim was exempted from the (now-retracted) guard on a false "in-place edit" rationale — it resolves the prefix via the same base ladder as everything else, finds `item.id` unambiguously (fresh store, no twin), and HARD-DELETES it inside the same transaction as the write; assert.throws reports "Missing expected exception" here, since current code does not refuse a resolves:[] prefix at all'
    );

    assert.ok(
      openIds(tools).includes(item.id),
      'EXPECTED FAILURE on current code too: the item was actually hard-deleted by the unrefused prefix claim, so it does NOT survive — this is the exact silent-deletion hazard the ruling closes'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call — the write itself must not land either');
  } finally {
    cleanup();
  }
});
