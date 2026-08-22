// ---------------------------------------------------------------------------
// Id-resolution ladder parity for the BOARD/MAINTENANCE tool surface
//
// REWRITTEN 2026-08-22 — DELIBERATE RULING REVERSAL, NOT A CODE-REGRESSION FIX.
// This file was 10/10 green under the ORIGINAL ruling (decision
// [one-id-resolution-ladder-for-the-whole-knowledge-surface-app] / 2debab53-d329-477c-8126-71916c238cd5,
// v3): board_update, board_remove AND maintenance_remove all resolved an
// unambiguous 8-char prefix, guarded on the two destructive tools by a
// removal-trail collision check. That guard was RETRACTED THE SAME DAY by
// decision [id-ladder-extends-to-board-tools-with-collision-guard] / 6d5a6719-bc6a-4139-8ae4-dc6a026e72bb
// (v5) after two INDEPENDENT reviews (the roster reviewer-correctness agent
// and Codex, different model families, same conclusion) proved the guard
// does not make prefix-addressed deletion safe:
//   1. CRITICAL — validateResolveClaim (the resolves:[] claim validator used
//      by knowledge_update/append/edit) was exempted from the guard on a
//      FALSE "in-place edit" rationale — every claim it returns is actually
//      HARD-DELETED. See board-remove-prefix-collision-guard.test.ts (this
//      file's sibling, now repurposed) for that pin.
//   2. The removal trails the guard consulted are capped at 50 rows each and
//      evicted by ANY created/updated/removed activity, not just removals —
//      so the guard is frequently just ABSENT, and an absent trail reads as
//      permission to delete.
//   3. Prefix resolution spans every mounted store while the guard read only
//      the project store.
// THE NEW, STANDING CONTRACT (decision 6d5a6719, superseding 2debab53's
// "board_remove... still demands the exact full id" clause back into force
// for board_remove, maintenance_remove AND validateResolveClaim):
//   - board_remove and maintenance_remove accept an EXACT ID ONLY. An 8-char
//     prefix — ambiguous or not, matching a real record or not — is REFUSED,
//     naming the full-uuid requirement and WHY: board/maintenance rows are
//     HARD-DELETED, and a stale prefix could silently retarget to a
//     different item. Never a bare "no record"; never the drain-log/aged-out
//     misdiagnosis wording (that was a separately-fixed defect and must stay
//     fixed).
//   - board_update KEEPS prefix resolution — an in-place edit is recoverable
//     and visible, unlike a hard delete, so the hazard the guard existed for
//     does not apply to it. This file's board_update cases are UNCHANGED
//     from the original ruling and are kept passing throughout.
//
// This file therefore now specifies TWO DIFFERENT CONTRACTS on ONE ladder:
// board_update resolves a prefix; board_remove/maintenance_remove never do.
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-maint-id-resolution-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mkDecision(tools: SterlingTools, title: string): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
  }).record as unknown as Loose;
}

// Forces a second (decision-shaped) record whose id shares `primaryId`'s
// first 8 chars — the same convention id-resolution.test.ts and
// tools.test.ts's own knowledge_get ambiguity test both use.
function seedPrefixTwin(store: SterlingStore, tools: SterlingTools, primaryId: string): string {
  const prefix = primaryId.slice(0, 8);
  const seed = mkDecision(tools, 'ambiguity twin seed');
  store.create({
    ...(JSON.parse(JSON.stringify(seed)) as Loose),
    id: `${prefix}-0000-4000-8000-000000000000`,
  });
  return prefix;
}

// Long-form, non-prefix-shaped identifier that cannot resolve through any
// rung of the ladder (not a uuid, not a slug, not an 8-char prefix of any
// hex id) — the same constant id-resolution.test.ts uses.
const UNRESOLVABLE = 'zzz-totally-unresolvable-identifier-ffff';

// A SHORT (8-char) identifier, exactly the SHAPE a real prefix would have,
// but guaranteed never to be a substring of any hex-uuid id ('z' is not a
// hex digit) — used to prove the exact-id-only refusal fires uniformly for
// prefix-shaped input regardless of whether it would ever have matched
// anything under the old ladder.
const UNRESOLVABLE_PREFIX = 'zzzzzzzz';

// The new contract's required refusal content (decision 6d5a6719): names the
// full-uuid requirement, and names WHY (hard-delete / silent-retarget risk).
// Flexible alternation, not an exact string match — the precise wording is
// the implementer's to choose; the SUBSTANCE is what the ruling pins.
const FULL_UUID_REQUIRED = /full uuid|full id/i;
const HARD_DELETE_REASON = /hard.?delet|permanent(ly)? delet|irreversib|retarget/i;

// ---------------------------------------------------------------------------
// UNCHANGED — board_update keeps the ladder (recoverable in-place edit).
// These three cases were true under the original ruling and remain true
// unchanged under the reversal; they are NOT touched by decision 6d5a6719.
// ---------------------------------------------------------------------------

test('board_update: an unambiguous 8-char prefix of an existing board item resolves and updates it (KEPT — board_update is not a destructive path, decision 6d5a6719 leaves it on the ladder)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user', priority: 'low' }) as unknown as {
      record: { id: string; text: string; priority: string };
    };
    const prefix = original.id.slice(0, 8);

    const updated = tools.boardUpdate(prefix, { text: 'ship csv export with headers' }) as unknown as {
      id: string;
      text: string;
      priority: string;
    };

    assert.equal(updated.id, original.id, 'the prefix resolves to the SAME item board_get already resolves it to');
    assert.equal(updated.text, 'ship csv export with headers', 'the write landed on the resolved item');
    assert.equal(updated.priority, 'low', 'untouched fields persist through a prefix-addressed update');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'still exactly one item — resolution never mints a second record');
  } finally {
    cleanup();
  }
});

test('board_update: an AMBIGUOUS 8-char prefix is refused, naming the ambiguity — never resolves to either record, writes nothing (KEPT, unchanged by decision 6d5a6719)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user' }) as unknown as {
      record: { id: string; text: string };
    };
    const prefix = seedPrefixTwin(store, tools, original.id);

    assert.throws(
      () => tools.boardUpdate(prefix, { text: 'should never land' }),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE if this ever regresses: board_update stops resolving prefixes at all and throws "no record '${prefix}'" instead, so this /ambiguous|multiple matches/i match fails`
    );

    const [unchanged] = tools.boardQuery({ source: 'user' }) as unknown as { id: string; text: string }[];
    assert.equal(unchanged.id, original.id, 'exactly the original item remains — the twin never lands on the board');
    assert.equal(unchanged.text, 'ship csv export', 'the ambiguous-prefix update call wrote NOTHING to the real item');
  } finally {
    cleanup();
  }
});

test('board_update: a genuinely unresolvable identifier is refused naming it, never a silent no-op (KEPT, unchanged by decision 6d5a6719)', () => {
  const { tools, cleanup } = harness();
  try {
    tools.boardAdd({ text: 'untouched item', source: 'user' });

    assert.throws(
      () => tools.boardUpdate(UNRESOLVABLE, { text: 'x' }),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal states the identifier AS GIVEN'
    );
    assert.equal(
      (tools.boardQuery({ source: 'user' })[0] as unknown as { text: string }).text,
      'untouched item',
      'the unrelated item is unaffected by the refused call'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FLIPPED — board_remove is now exact-id-only (decision 6d5a6719 retracts
// the collision guard AND the prefix rung for this destructive tool).
// ---------------------------------------------------------------------------

test('board_remove: an 8-char prefix that WOULD have resolved unambiguously is now REFUSED — RULING REVERSAL (decision id-ladder-extends-to-board-tools-with-collision-guard / 6d5a6719): the refusal names the full-uuid requirement and the hard-delete/silent-retarget reason, and the item SURVIVES', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user' }) as unknown as {
      record: { id: string };
    };
    const prefix = original.id.slice(0, 8);

    assert.throws(
      () => tools.boardRemove(prefix),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `refusal must name the full-uuid requirement — got: "${err.message}"`);
        assert.match(
          err.message,
          HARD_DELETE_REASON,
          `refusal must name WHY: board rows are hard-deleted and a stale prefix could silently retarget — got: "${err.message}"`
        );
        assert.ok(!/aged out|drain log/i.test(err.message), 'must not be the drain-log/aged-out misdiagnosis wording');
        return true;
      },
      'EXPECTED FAILURE on current (pre-reversal, guard-based) code: an unambiguous, non-colliding prefix resolves fine under the ladder+guard and the item is REMOVED — assert.throws reports "Missing expected exception" here'
    );

    const remaining = tools.boardQuery({ source: 'user' }) as unknown as { id: string }[];
    assert.equal(
      remaining.length,
      1,
      'EXPECTED FAILURE on current code too: on guard-based code the item was actually removed by the call above, so it does not survive'
    );
    assert.equal(remaining[0].id, original.id, 'the item is untouched — addressable again only by its full uuid');
  } finally {
    cleanup();
  }
});

test('board_remove: an AMBIGUOUS 8-char prefix is refused the same exact-id-only way — nothing is removed either way (regression pin; exact refusal wording for the ambiguous case is not independently verifiable without reading tools.ts, see report)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user' }) as unknown as {
      record: { id: string };
    };
    const prefix = seedPrefixTwin(store, tools, original.id);

    assert.throws(
      () => tools.boardRemove(prefix),
      'a prefix must still be refused when it happens to be ambiguous — the exact-id-only rule does not carve out an exception for this case'
    );

    const remaining = tools.boardQuery({ source: 'user' }) as unknown as { id: string }[];
    assert.equal(remaining.length, 1, 'the item was NOT removed by the ambiguous-prefix call');
    assert.equal(remaining[0].id, original.id, 'and it is exactly the original — nothing was coin-flipped');
  } finally {
    cleanup();
  }
});

test('board_remove: a genuinely unresolvable (non-prefix-shaped) identifier is refused naming it, item pool untouched (KEPT, unchanged by decision 6d5a6719 — this was never about a prefix candidate)', () => {
  const { tools, cleanup } = harness();
  try {
    tools.boardAdd({ text: 'untouched item', source: 'user' });

    assert.throws(
      () => tools.boardRemove(UNRESOLVABLE),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal states the identifier AS GIVEN'
    );
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'nothing was removed by the refused call');
  } finally {
    cleanup();
  }
});

test('board_remove: a FULL uuid still succeeds and removes the item — the exact-id path is unaffected by the ruling reversal (ADDED, regression pin, expected GREEN before and after)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user' }) as unknown as {
      record: { id: string };
    };

    const result = tools.boardRemove(original.id) as unknown as { removed?: string; id?: string };
    const removedId = result.removed ?? result.id;
    assert.equal(removedId, original.id, 'the full uuid removes the item directly, no resolution needed');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'the item is gone');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FLIPPED — maintenance_remove is now exact-id-only, same as board_remove.
// ---------------------------------------------------------------------------

test('maintenance_remove: an 8-char prefix that WOULD have resolved unambiguously is now REFUSED — RULING REVERSAL (decision 6d5a6719): names the full-uuid requirement and the hard-delete reason, item SURVIVES, and the refusal is NEVER the drain-log/aged-out wording (that misdiagnosis was a separately-fixed defect and must stay fixed)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/y.ts',
      file_keys: ['src/y.ts'],
    }) as unknown as { record: { id: string } };
    const prefix = item.id.slice(0, 8);

    assert.throws(
      () => tools.maintenanceRemove(prefix),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `refusal must name the full-uuid requirement — got: "${err.message}"`);
        assert.match(err.message, HARD_DELETE_REASON, `refusal must name WHY — got: "${err.message}"`);
        assert.ok(!/aged out|drain log/i.test(err.message), 'must not be the drain-log/aged-out misdiagnosis wording — that defect stays fixed');
        return true;
      },
      'EXPECTED FAILURE on current (pre-reversal, guard-based) code: an unambiguous, non-colliding prefix resolves fine and the item is REMOVED — assert.throws reports "Missing expected exception" here'
    );

    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 1, 'EXPECTED FAILURE on current code too: on guard-based code the item was actually removed, so it does not survive');
  } finally {
    cleanup();
  }
});

test('maintenance_remove: an AMBIGUOUS 8-char prefix is refused the same exact-id-only way — nothing is removed either way (regression pin; exact refusal wording for the ambiguous case is not independently verifiable without reading tools.ts, see report)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/z.ts',
      file_keys: ['src/z.ts'],
    }) as unknown as { record: { id: string } };
    const prefix = seedPrefixTwin(store, tools, item.id);

    assert.throws(
      () => tools.maintenanceRemove(prefix),
      'a prefix must still be refused when it happens to be ambiguous — the exact-id-only rule does not carve out an exception for this case'
    );

    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 1, 'the item was NOT removed by the ambiguous-prefix call');
  } finally {
    cleanup();
  }
});

test('maintenance_remove: an 8-char-SHAPED identifier that would not have matched any record under the old ladder is STILL refused via the full-uuid-required message — not a bare "no such record", and never the drain-log/aged-out wording (FLIPPED from the old "no such record" oracle)', () => {
  const { tools, cleanup } = harness();
  try {
    // an open item stays in the queue throughout, so a naive "the queue
    // happens to be empty" shortcut cannot coincidentally satisfy this test.
    tools.maintenanceEnqueue({ reason: 'article_missing', text: 'no article owns src/w.ts', file_keys: ['src/w.ts'] });

    assert.throws(
      () => tools.maintenanceRemove(UNRESOLVABLE_PREFIX),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `refusal must name the full-uuid requirement even for a non-matching prefix — got: "${err.message}"`);
        assert.ok(
          !/aged out|drain log/i.test(err.message),
          `must not be misdiagnosed via drain-log wording — got: "${err.message}"`
        );
        return true;
      },
      'EXPECTED FAILURE on current (pre-reversal) code: today an 8-char-shaped, non-matching identifier is refused via the FIXED plain "no such record" wording (the historical drain-log misdiagnosis was already patched separately) — that message does not mention the full-uuid requirement, so this assertion is red until the new exact-id-only contract lands'
    );

    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 1, 'the genuinely-open unrelated item is untouched by the refused call');
  } finally {
    cleanup();
  }
});

test('maintenance_remove: a genuinely unresolvable (non-prefix-shaped) identifier is refused naming it, never via drain-log wording (KEPT, unchanged by decision 6d5a6719 — this was never about a prefix candidate)', () => {
  const { tools, cleanup } = harness();
  try {
    assert.throws(
      () => tools.maintenanceRemove(UNRESOLVABLE),
      (err: Error) => {
        assert.ok(err.message.includes(UNRESOLVABLE), 'the refusal states the identifier AS GIVEN');
        assert.ok(
          !/aged out|drain log/i.test(err.message),
          `must not misdiagnose a nonsense identifier as an already-drained item — got: "${err.message}"`
        );
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('maintenance_remove: a FULL uuid still succeeds and removes the item — the exact-id path is unaffected by the ruling reversal (ADDED, regression pin, expected GREEN before and after)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/v.ts',
      file_keys: ['src/v.ts'],
    }) as unknown as { record: { id: string } };

    const result = tools.maintenanceRemove(item.id) as { removed?: string; id?: string; already_drained?: boolean };
    const removedId = result.removed ?? result.id;
    assert.equal(removedId, item.id, 'the full uuid removes the item directly, no resolution needed');
    assert.notEqual(result.already_drained, true, 'a genuine live removal must not be marked already_drained');
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 0, 'gone from the open queue');
  } finally {
    cleanup();
  }
});
