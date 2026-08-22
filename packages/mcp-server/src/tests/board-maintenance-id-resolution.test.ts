// ---------------------------------------------------------------------------
// Id-resolution ladder parity for the BOARD/MAINTENANCE tool surface
// (decision 2debab53 — full uuid -> exact slug -> unambiguous 8-char citation
// prefix). knowledge_get and the five knowledge WRITE tools already carry
// this ladder (see id-resolution.test.ts, sibling file). This file extends
// the SAME contract to three more tools, per the work order:
//
//   1. board_update(<8-char prefix>, patch)        — resolves and updates.
//   2. board_remove(<8-char prefix>)                — resolves and removes.
//   3. maintenance_remove(<8-char prefix>)          — resolves and removes.
//   4. an AMBIGUOUS 8-char prefix (two records sharing it) is refused naming
//      the ambiguity — never resolves to either record, never a coin-flip —
//      for all three tools above.
//   5. a genuinely unknown id/prefix is refused saying no such record
//      exists; the refusal must NOT assert the item "aged out of the drain
//      log" or otherwise misdiagnose an unresolved prefix as a missing
//      record — this is maintenance_remove's own sharp edge (see below).
//
// Written SPEC-ONLY, blind to tools.ts's in-flight diff. Existing tests in
// tools.test.ts / board-objective.test.ts / idempotent-remove.test.ts /
// domain-routing.test.ts already pin: board_update's full-uuid form, the
// unknown-fields/empty-patch/not-a-task refusals, and board_update's
// "no record" wording for an unknown FULL uuid; board_remove's full-id
// removal shape (`.removed`); and maintenance_remove's full-id removal,
// idempotent already-drained success, and the drain-log wording for a
// genuinely-unknown FULL UUID. None of those are touched or duplicated here
// — this file is additive, targeting only the PREFIX-shaped forms decision
// 2debab53 introduces.
//
// EXPECTED FAILURE SHAPES on current code (none of these three tools
// resolve a prefix today — each does a plain exact-id lookup):
//   - the "accepts a prefix" tests (SPEC 1/2/3) fail because the tool throws
//     a plain "no record '<prefix>'"-style refusal (an 8-char string is
//     never a real stored id) before the update/removal can happen, so the
//     post-call assertions (id preserved, item updated/gone) are never
//     reached — the thrown error IS the red.
//   - the "ambiguous prefix" tests (SPEC 4) fail for the same root cause:
//     no resolution is attempted at all, so no ambiguity is ever detected —
//     the /ambiguous|multiple matches/i match fails against whatever plain
//     not-found message the tool currently throws instead.
//   - the maintenance_remove misdiagnosis test (SPEC 5) fails today because
//     an unresolvable prefix, never having matched any current OR historical
//     record, falls through into maintenance_remove's idempotent-drain-log
//     fallback (board 83478fc6 / idempotent-remove.test.ts), which checks
//     the drain log and reports "no trace of it in the drain log" — reading
//     as "this WAS a real maintenance item, now gone" when the identifier
//     was never resolvable to begin with. The fix must short-circuit on the
//     ladder's own "cannot resolve" outcome with a plain unresolved-identifier
//     refusal, before ever reaching that fallback.
//
// Ambiguity construction: identical convention to id-resolution.test.ts's
// seedPrefixTwin — a raw DECISION record forced (via store.create) to share
// the target record's 8-char id prefix. The ladder resolves prefixes across
// every record type in the store (recordIdIndex serves the whole mounted
// fan, at any status — sqlite-store AC7/AC8), so a decision-shaped twin is a
// genuine ambiguity for a board/maintenance item's prefix too; ids are
// server-minted, so a collision cannot be produced through the public
// create/add tools alone.
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

// A SHORT (8-char) unresolvable form specifically for maintenance_remove's
// misdiagnosis test: exactly the SHAPE a real prefix would have, but
// guaranteed never to be a substring of any hex-uuid id ('z' is not a hex
// digit), so it is guaranteed to resolve to zero records rather than
// accidentally colliding with a seeded id.
const UNRESOLVABLE_PREFIX = 'zzzzzzzz';

// ---------------------------------------------------------------------------
// SPEC 1 — board_update resolves an unambiguous 8-char prefix
// ---------------------------------------------------------------------------

test('board_update: an unambiguous 8-char prefix of an existing board item resolves and updates it (SPEC 1, decision 2debab53)', () => {
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

// ---------------------------------------------------------------------------
// SPEC 4 (board_update variant) — ambiguous prefix refused, writes nothing
// ---------------------------------------------------------------------------

test('board_update: an AMBIGUOUS 8-char prefix is refused, naming the ambiguity — never resolves to either record, writes nothing (SPEC 4)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user', priority: 'low' }) as unknown as {
      record: { id: string; text: string };
    };
    const prefix = seedPrefixTwin(store, tools, original.id);

    assert.throws(
      () => tools.boardUpdate(prefix, { text: 'should never land' }),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: board_update does no prefix resolution — it throws "no record '${prefix}'" instead, so this /ambiguous|multiple matches/i match fails`
    );

    const [unchanged] = tools.boardQuery({ source: 'user' }) as unknown as { id: string; text: string }[];
    assert.equal(unchanged.id, original.id, 'exactly the original item remains — the twin never lands on the board');
    assert.equal(unchanged.text, 'ship csv export', 'the ambiguous-prefix update call wrote NOTHING to the real item');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 5 (board_update boundary) — a genuinely unresolvable identifier
// ---------------------------------------------------------------------------

test('board_update: a genuinely unresolvable identifier is refused naming it, never a silent no-op', () => {
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
// SPEC 2 — board_remove resolves an unambiguous 8-char prefix
// ---------------------------------------------------------------------------

test('board_remove: an unambiguous 8-char prefix of an existing board item resolves and removes it (SPEC 2, decision 2debab53)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user' }) as unknown as {
      record: { id: string };
    };
    const prefix = original.id.slice(0, 8);

    const result = tools.boardRemove(prefix) as unknown as { removed?: string; id?: string };
    const removedId = result.removed ?? result.id;
    assert.equal(removedId, original.id, 'the prefix resolves to and removes the SAME item board_get already resolves it to');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'the item is gone from the board');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 4 (board_remove variant) — ambiguous prefix refused
// ---------------------------------------------------------------------------

test('board_remove: an AMBIGUOUS 8-char prefix is refused, naming the ambiguity — never removes either record (SPEC 4)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: original } = tools.boardAdd({ text: 'ship csv export', source: 'user' }) as unknown as {
      record: { id: string };
    };
    const prefix = seedPrefixTwin(store, tools, original.id);

    assert.throws(
      () => tools.boardRemove(prefix),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: board_remove does no prefix resolution — it throws "no record '${prefix}'" (or, worse, removes on an accidental match) instead, so this /ambiguous|multiple matches/i match fails`
    );

    const remaining = tools.boardQuery({ source: 'user' }) as unknown as { id: string }[];
    assert.equal(remaining.length, 1, 'the item was NOT removed by the ambiguous-prefix call');
    assert.equal(remaining[0].id, original.id, 'and it is exactly the original — nothing was coin-flipped');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 5 (board_remove boundary) — a genuinely unresolvable identifier
// ---------------------------------------------------------------------------

test('board_remove: a genuinely unresolvable identifier is refused naming it, item pool untouched', () => {
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

// ---------------------------------------------------------------------------
// SPEC 3 — maintenance_remove resolves an unambiguous 8-char prefix
// ---------------------------------------------------------------------------

test('maintenance_remove: an unambiguous 8-char prefix of an existing maintenance item resolves and removes it (SPEC 3, decision 2debab53)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/y.ts',
      file_keys: ['src/y.ts'],
    }) as unknown as { record: { id: string } };
    const prefix = item.id.slice(0, 8);

    const result = tools.maintenanceRemove(prefix) as { removed?: string; id?: string; already_drained?: boolean };
    const removedId = result.removed ?? result.id;
    assert.equal(removedId, item.id, 'the prefix resolves to and removes the SAME maintenance item');
    assert.notEqual(result.already_drained, true, 'a genuine live removal must not be marked already_drained');
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 0, 'gone from the open queue');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 4 (maintenance_remove variant) — ambiguous prefix refused
// ---------------------------------------------------------------------------

test('maintenance_remove: an AMBIGUOUS 8-char prefix is refused, naming the ambiguity — never removes either record (SPEC 4)', () => {
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
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: maintenance_remove does no prefix resolution — it throws "no record '${prefix}'" (or falls into the drain-log fallback) instead, so this /ambiguous|multiple matches/i match fails`
    );

    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 1, 'the item was NOT removed by the ambiguous-prefix call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 5 — the sharp edge: maintenance_remove must not misdiagnose an
// unresolved prefix as an item that "aged out of the drain log". This is
// distinct from (and does not touch) idempotent-remove.test.ts's own
// regression pin that a genuinely-unknown FULL UUID keeps the drain-log
// wording ("no trace of it in the drain log") — that pin covers a
// full-uuid-shaped identifier that really was checked against the log. This
// test covers the NEW case decision 2debab53 introduces: a PREFIX-shaped
// identifier that never resolves to any candidate id in the first place, so
// there is nothing meaningful to check the drain log against at all.
// ---------------------------------------------------------------------------

test('maintenance_remove: a genuinely unresolvable 8-char prefix is refused as "no such record" — NEVER misdiagnosed as an item that aged out of the drain log (SPEC 5)', () => {
  const { tools, cleanup } = harness();
  try {
    // an open item stays in the queue throughout, so a naive "the queue
    // happens to be empty" shortcut cannot coincidentally satisfy this test.
    tools.maintenanceEnqueue({ reason: 'article_missing', text: 'no article owns src/w.ts', file_keys: ['src/w.ts'] });

    assert.throws(
      () => tools.maintenanceRemove(UNRESOLVABLE_PREFIX),
      (err: Error) => {
        assert.match(err.message, /no such record|no record|not found/i, 'names the miss plainly, as an unresolved identifier');
        assert.ok(
          !/aged out|drain log/i.test(err.message),
          `EXPECTED FAILURE on current code: an unresolved prefix falls through to the idempotent-remove fallback and is reported via drain-log wording ("no trace of it in the drain log") instead of a clean unresolved-identifier refusal — got: "${err.message}"`
        );
        return true;
      },
      'a genuinely unresolvable prefix must be refused as "no such record", not as "already drained"'
    );

    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 1, 'the genuinely-open item is untouched by the refused call');
  } finally {
    cleanup();
  }
});

test('maintenance_remove: a genuinely unresolvable (non-prefix-shaped) identifier is refused naming it, never via drain-log wording (SPEC 5)', () => {
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
