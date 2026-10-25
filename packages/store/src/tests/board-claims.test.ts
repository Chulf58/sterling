// Board task claims (decision
// board-task-claims-for-parallel-sessions-claim-generation-ren): a claim is
// written by compare-and-set under the write lock, carries a generation that
// a takeover bumps, expires to 'check owner' after the lease, and an old
// holder's renew or release after a takeover is refused naming where the task
// moved. Races use two SterlingStore handles on one SQLite file, the way two
// sessions do; the interleaving is forced by running B's write from a hook on
// A just before A opens its write transaction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, boardClaimView, boardReadinessOf } from '../index.js';

const T0 = '2026-10-25T09:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
type Claimed = { id: string; version: number; updated_at: string; claim?: Record<string, unknown> & { generation: number; holder_session: string; renewed_at: string } };

function todo(source: 'user' | 'system' = 'user') {
  return {
    id: randomUUID(),
    type: 'todo',
    created_at: T0,
    updated_at: T0,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    text: 'board item to claim',
    source,
    ...(source === 'system' ? { system_reason: 'reconcile_needed' } : {}),
  };
}

function pair() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-claims-'));
  const path = join(dir, 'sterling.db');
  const a = new SterlingStore(path);
  const b = new SterlingStore(path);
  return {
    a,
    b,
    close: () => {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run `between` once, the first time `store` opens a write transaction, just before it begins. */
function beforeFirstWriteTx(store: SterlingStore, between: () => void): void {
  const handle = store as unknown as { tx: (fn: () => void) => void };
  const original = handle.tx.bind(store);
  let fired = false;
  handle.tx = (fn: () => void) => {
    if (!fired) {
      fired = true;
      between();
    }
    original(fn);
  };
}

const get = (s: SterlingStore, id: string) => s.get(id) as unknown as Claimed;

test('two sessions claim one item at once: exactly one wins, the other is refused naming the winner', () => {
  const { a, b, close } = pair();
  try {
    const item = a.create(todo()) as unknown as Claimed;
    beforeFirstWriteTx(a, () => b.claimTodo(item.id, { session: 'sess-B', checkout: 'wt-b', now: at(0) }));
    assert.throws(
      () => a.claimTodo(item.id, { session: 'sess-A', checkout: 'main', now: at(0) }),
      /board_claim: session 'sess-B' in checkout 'wt-b' holds this task at claim generation \d+.*Nothing was written/
    );
    const stored = get(a, item.id);
    assert.equal(stored.claim?.holder_session, 'sess-B');
    assert.equal(stored.claim?.checkout, 'wt-b');
  } finally {
    close();
  }
});

test('re-claiming by the holder keeps the generation; a claim never moves updated_at', () => {
  const { a, close } = pair();
  try {
    const item = a.create(todo()) as unknown as Claimed;
    const first = a.claimTodo(item.id, { session: 's1', checkout: 'main', now: at(0) }) as unknown as Claimed;
    const again = a.claimTodo(item.id, { session: 's1', checkout: 'wt-1', now: at(5) }) as unknown as Claimed;
    assert.equal(again.claim?.generation, first.claim?.generation);
    assert.equal(again.claim?.checkout, 'wt-1');
    assert.equal(again.claim?.renewed_at, at(5));
    assert.equal(again.updated_at, item.updated_at, 'a claim is not a content edit, so the board order does not move');
  } finally {
    close();
  }
});

test('expiry: held within the lease, expired (check owner) after it; readiness carries the claim', () => {
  const { a, close } = pair();
  try {
    const item = a.create(todo()) as unknown as Claimed;
    a.claimTodo(item.id, { session: 's1', checkout: 'main', now: at(0) });
    const held = a.boardReadiness(undefined, { now: Date.parse(at(59)), leaseMinutes: 60 })[0];
    assert.equal(held.claim?.state, 'held');
    assert.equal(held.claim?.minutes_since_renewal, 59);
    const expired = a.boardReadiness(undefined, { now: Date.parse(at(60)), leaseMinutes: 60 })[0];
    assert.equal(expired.claim?.state, 'expired');
    assert.equal(expired.state, 'ready', 'the readiness state is unchanged; the claim is reported beside it');
    assert.equal(a.boardReadiness(undefined, { now: Date.parse(at(20)), leaseMinutes: 15 })[0].claim?.state, 'expired', 'the lease comes from the caller');
    assert.equal(boardClaimView(undefined, 0, 60), undefined);
    assert.deepEqual(boardClaimView({ holder_session: 's' }, 0, 60), { state: 'unreadable' });
    // The pure rule over another project's rows (the cross-project read path).
    const rows = [{ ...(get(a, item.id) as unknown as Record<string, unknown>) }] as unknown as Parameters<typeof boardReadinessOf>[0];
    assert.equal(boardReadinessOf(rows, rows, () => undefined, { now: Date.parse(at(61)), leaseMinutes: 60 })[0].claim?.state, 'expired');
  } finally {
    close();
  }
});

test('a claim by another session is refused even when expired; takeover bumps the generation and records the old holder', () => {
  const { a, close } = pair();
  try {
    const item = a.create(todo()) as unknown as Claimed;
    const g1 = (a.claimTodo(item.id, { session: 'old', checkout: 'wt-old', now: at(0) }) as unknown as Claimed).claim!.generation;
    assert.throws(
      () => a.claimTodo(item.id, { session: 'new', checkout: 'main', leaseMinutes: 60, now: at(90) }),
      /shows as check owner.*board_takeover naming expected_holder 'old' and expected_generation/
    );
    assert.throws(
      () => a.takeoverClaim(item.id, { session: 'new', checkout: 'main', expected_holder: 'old', expected_generation: g1 + 7, now: at(90) }),
      /the claim changed since you read it — session 'old' in checkout 'wt-old' holds it at generation/
    );
    const taken = a.takeoverClaim(item.id, { session: 'new', checkout: 'main', expected_holder: 'old', expected_generation: g1, now: at(90) }) as unknown as Claimed;
    assert.ok(taken.claim!.generation > g1, 'takeover bumps the generation');
    assert.equal(taken.claim!.holder_session, 'new');
    assert.deepEqual(taken.claim!.taken_over_from, { holder_session: 'old', checkout: 'wt-old', generation: g1, renewed_at: at(0), at: at(90) });

    // The old holder's renew and release are refused and told where the task went.
    const moved = /the task moved — session 'new' in checkout 'main' holds it now at claim generation \d+, taken over from you at .*Nothing was written/;
    assert.throws(() => a.reaffirmClaim(item.id, { session: 'old', generation: g1, now: at(91) }), moved);
    assert.throws(() => a.releaseClaim(item.id, { session: 'old', generation: g1, now: at(91) }), moved);
    assert.equal(a.renewClaimIfDue(item.id, { session: 'old', leaseMinutes: 60, now: at(200) }).renewed, false, 'task work by the old holder renews nothing');
    assert.equal(get(a, item.id).claim!.holder_session, 'new');

    // The new holder: a stale generation is refused, the right one releases.
    assert.throws(() => a.reaffirmClaim(item.id, { session: 'new', generation: g1, now: at(92) }), /stale claim generation/);
    a.releaseClaim(item.id, { session: 'new', generation: taken.claim!.generation, now: at(93) });
    assert.equal(get(a, item.id).claim, undefined);
    assert.throws(() => a.reaffirmClaim(item.id, { session: 'new', generation: taken.claim!.generation }), /has no claim now/);
    assert.throws(() => a.takeoverClaim(item.id, { session: 'x', checkout: 'c', expected_holder: 'new', expected_generation: 1 }), /no claim to take over/);
    const reclaimed = a.claimTodo(item.id, { session: 'third', checkout: 'c', now: at(94) }) as unknown as Claimed;
    assert.ok(reclaimed.claim!.generation > taken.claim!.generation, 'a generation never repeats on one item');
  } finally {
    close();
  }
});

test('a takeover racing a renewal by the old holder: the takeover reads the claim under the lock', () => {
  const { a, b, close } = pair();
  try {
    const item = a.create(todo()) as unknown as Claimed;
    const g1 = (a.claimTodo(item.id, { session: 'old', checkout: 'wt-old', now: at(0) }) as unknown as Claimed).claim!.generation;
    // B takes over first; A (the old holder) then tries to reaffirm the generation it held.
    beforeFirstWriteTx(a, () => b.takeoverClaim(item.id, { session: 'new', checkout: 'main', expected_holder: 'old', expected_generation: g1, now: at(70) }));
    assert.throws(() => a.reaffirmClaim(item.id, { session: 'old', generation: g1, now: at(70) }), /the task moved — session 'new'/);
  } finally {
    close();
  }
});

test('renewal by task work is coalesced: no write inside a quarter of the lease, one write after it', () => {
  const { a, close } = pair();
  try {
    const item = a.create(todo()) as unknown as Claimed;
    a.claimTodo(item.id, { session: 's1', checkout: 'main', now: at(0) });
    const v0 = get(a, item.id).version;
    for (const m of [1, 5, 10, 14]) {
      assert.equal(a.renewClaimIfDue(item.id, { session: 's1', leaseMinutes: 60, now: at(m) }).renewed, false, `minute ${m}`);
    }
    assert.equal(get(a, item.id).version, v0, 'no version (and so no archived body) per call inside lease/4');
    assert.equal(a.renewClaimIfDue(item.id, { session: 's1', leaseMinutes: 60, now: at(15) }).renewed, true);
    assert.equal(get(a, item.id).version, v0 + 1);
    assert.equal(get(a, item.id).claim!.renewed_at, at(15));
    assert.equal(a.renewClaimIfDue(item.id, { session: 's1', leaseMinutes: 60, now: at(20) }).renewed, false);
    assert.equal(a.renewClaimIfDue(randomUUID(), { session: 's1', leaseMinutes: 60 }).renewed, false, 'an unknown id renews nothing');
  } finally {
    close();
  }
});

test('updateTodo cannot set, drop or revert a claim; a holder renewal rides inside the edit', () => {
  const { a, close } = pair();
  try {
    const item = a.create(todo()) as unknown as Claimed;
    const forged = { holder_session: 'forger', checkout: 'x', generation: 99, claimed_at: T0, renewed_at: T0 };
    const afterForge = a.updateTodo(item.id, { ...get(a, item.id), text: 'edited', claim: forged }) as unknown as Claimed;
    assert.equal(afterForge.claim, undefined, 'a claim in the merged body is not stored');

    const claimed = a.claimTodo(item.id, { session: 's1', checkout: 'main', now: at(0) }) as unknown as Claimed;
    const { claim: _dropped, ...withoutClaim } = get(a, item.id) as unknown as Record<string, unknown>;
    const afterDrop = a.updateTodo(item.id, { ...withoutClaim, text: 'edited again' }) as unknown as Claimed;
    assert.deepEqual(afterDrop.claim, claimed.claim, 'an edit body without the claim keeps the stored claim');

    const early = a.updateTodo(item.id, { ...get(a, item.id), text: 'early edit' }, {}, { session: 's1', leaseMinutes: 60, now: at(10) }) as unknown as Claimed;
    assert.equal(early.claim!.renewed_at, at(0), 'inside lease/4 the edit does not renew');
    const late = a.updateTodo(item.id, { ...get(a, item.id), text: 'late edit' }, {}, { session: 's1', leaseMinutes: 60, now: at(30) }) as unknown as Claimed;
    assert.equal(late.claim!.renewed_at, at(30), 'the holder editing its item renews the claim in the same write');
    const other = a.updateTodo(item.id, { ...get(a, item.id), text: 'by another' }, {}, { session: 's2', leaseMinutes: 60, now: at(59) }) as unknown as Claimed;
    assert.equal(other.claim!.renewed_at, at(30), 'an edit by another session renews nothing');
  } finally {
    close();
  }
});

test('claims go on user board tasks only', () => {
  const { a, close } = pair();
  try {
    const sys = a.create(todo('system')) as unknown as Claimed;
    assert.throws(() => a.claimTodo(sys.id, { session: 's1', checkout: 'main' }), /maintenance-queue item; only source:'user' board tasks are claimed/);
    assert.equal(get(a, sys.id).claim, undefined);
  } finally {
    close();
  }
});
