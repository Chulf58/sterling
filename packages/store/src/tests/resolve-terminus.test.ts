// ---------------------------------------------------------------------------
// resolveTerminus(id) — supersession-terminus disclosure (decision de1a7329:
// ids stay version-pinned; the fix DISCLOSES the chain, it never silently
// redirects). SPEC-ONLY, written before the method exists on SterlingStore.
//
// Every test below calls through `callResolveTerminus`, which looks up
// `store.resolveTerminus` at runtime and throws a NAMED "not found" error if
// it is absent — so on the CURRENT store every test in this file fails RED
// on that thrown Error (never a bare TypeError, and never a tsc compile
// break for the whole package), and once the method lands each test's own
// equality/deepEqual assertions on {id, status, hops, truncated} become the
// oracle. This mirrors the frozen-oracle casting convention already used in
// store.test.ts (e.g. catalogStatus / bootstrapCatalogIfAbsent) for a method
// declared in the interface slice but not yet on the class.
//
// Fixtures wire status/superseded_by DIRECTLY through store.create() — the
// same pattern store.test.ts already uses for its superseded research_finding
// fixture (`rf('superseded')` with a synthetic superseded_by) — rather than
// through store.supersede(), because AC4 needs a malformed/cyclic chain that
// the real supersede() path could never produce (it always points forward to
// a brand-new id, never back to an existing one).
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

const NOW = '2026-08-20T12:00:00.000Z';

interface Terminus {
  id: string;
  status: string;
  hops: number;
  truncated?: boolean;
}

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
    stack_tags: ['node'],
  };
}

function decision(over: Record<string, unknown> = {}) {
  return {
    ...envelope('decision'),
    title: 'a decision',
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
    ...over,
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-terminus-'));
  return { dir, store: new SterlingStore(join(dir, 'sterling.db')) };
}

/** SPEC-ONLY adapter: resolveTerminus does not exist yet — named failure, not a bare TypeError. */
function callResolveTerminus(store: SterlingStore, id: string): Terminus | null {
  const fn = (store as unknown as { resolveTerminus?: (rid: string) => Terminus | null }).resolveTerminus;
  if (typeof fn !== 'function') {
    throw new Error('SterlingStore.resolveTerminus not found — expected `store.resolveTerminus(id)`');
  }
  return fn.call(store, id);
}

/**
 * Builds a chain of `hops + 1` decision records r0..r_hops, wired directly via
 * store.create(): r_hops is active, every r_i (i < hops) is superseded with
 * superseded_by pointing at r_{i+1}. Returns the ids in chain order.
 */
function buildChain(store: SterlingStore, hops: number): string[] {
  const ids = Array.from({ length: hops + 1 }, () => randomUUID());
  store.create(decision({ id: ids[hops], title: `r${hops}` }));
  for (let i = hops - 1; i >= 0; i--) {
    store.create(decision({ id: ids[i], title: `r${i}`, status: 'superseded', superseded_by: ids[i + 1] }));
  }
  return ids;
}

test('resolveTerminus AC1: a LIVE (active) record resolves to itself at hops:0', () => {
  const { dir, store } = tempStore();
  try {
    const live = store.create(decision({ title: 'live' }));
    const res = callResolveTerminus(store, live.id);
    assert.deepEqual(res, { id: live.id, status: 'active', hops: 0 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTerminus AC2: a three-node chain A->B->C(active) resolves A and B both to C, with hops counted per-origin', () => {
  const { dir, store } = tempStore();
  try {
    const [a, b, c] = buildChain(store, 2); // r0=A (superseded), r1=B (superseded), r2=C (active)

    const fromA = callResolveTerminus(store, a);
    assert.equal(fromA?.id, c, 'A resolves all the way to the chain end C, not to its own one-hop pointer B');
    assert.equal(fromA?.status, 'active');
    assert.equal(fromA?.hops, 2);
    assert.ok(!fromA?.truncated, 'a fully-resolved chain is not truncated');

    const fromB = callResolveTerminus(store, b);
    assert.equal(fromB?.id, c);
    assert.equal(fromB?.status, 'active');
    assert.equal(fromB?.hops, 1, 'B is one hop from the terminus, not two');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTerminus AC3: an unknown id returns null', () => {
  const { dir, store } = tempStore();
  try {
    assert.equal(callResolveTerminus(store, randomUUID()), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTerminus AC4 (cycle safety): A -> B -> A terminates, returns the LAST record reached before the revisit, truncated:true, never throws', () => {
  const { dir, store } = tempStore();
  try {
    const idA = randomUUID();
    const idB = randomUUID();
    // Malformed chain: each points at the other. Only reachable by writing the
    // rows directly — store.supersede() can never produce a back-reference.
    store.create(decision({ id: idA, title: 'A', status: 'superseded', superseded_by: idB }));
    store.create(decision({ id: idB, title: 'B', status: 'superseded', superseded_by: idA }));

    let res: Terminus | null = null as Terminus | null;
    assert.doesNotThrow(() => {
      res = callResolveTerminus(store, idA);
    }, 'a cyclic chain must never throw');
    assert.ok(res, 'a cyclic chain still returns a terminus, not null');
    assert.equal(res!.id, idB, 'traversal from A visits B next; A reappears on the third step, so B is the last record reached before the revisit');
    assert.equal(res!.status, 'superseded', "B's own status is reported honestly — it is not the active record either");
    assert.equal(res!.hops, 1);
    assert.equal(res!.truncated, true, 'a chain that revisits a record is disclosed as truncated, never silently resolved');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTerminus AC4 (self-loop boundary): A superseded_by itself resolves to A at hops:0, truncated:true, never hangs', () => {
  const { dir, store } = tempStore();
  try {
    const idA = randomUUID();
    store.create(decision({ id: idA, title: 'self-loop', status: 'superseded', superseded_by: idA }));

    let res: Terminus | null = null as Terminus | null;
    assert.doesNotThrow(() => {
      res = callResolveTerminus(store, idA);
    });
    assert.equal(res!.id, idA, 'the starting record is the last one reached before the immediate revisit');
    assert.equal(res!.hops, 0);
    assert.equal(res!.truncated, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTerminus AC4 (32-hop boundary, exact): a chain of exactly 32 hops resolves FULLY to the active terminus, not truncated', () => {
  const { dir, store } = tempStore();
  try {
    const ids = buildChain(store, 32); // r0..r32, r32 active — exactly 32 hops from r0
    const res = callResolveTerminus(store, ids[0]);
    assert.equal(res?.id, ids[32], 'exactly 32 hops still reaches the true active terminus');
    assert.equal(res?.status, 'active');
    assert.equal(res?.hops, 32);
    assert.ok(!res?.truncated, 'reaching the terminus AT the 32-hop limit is not a truncation');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTerminus AC4 (32-hop boundary, past it): a chain of 33 hops truncates at hops:32, never reaching the true (deeper) terminus', () => {
  const { dir, store } = tempStore();
  try {
    const ids = buildChain(store, 33); // r0..r33, r33 active — 33 hops from r0, one past the cap
    let res: Terminus | null = null as Terminus | null;
    assert.doesNotThrow(() => {
      res = callResolveTerminus(store, ids[0]);
    }, 'a long non-cyclic chain must never hang or throw');
    assert.equal(res!.hops, 32, 'traversal stops at the 32-hop cap');
    assert.equal(res!.truncated, true, 'a chain deeper than 32 hops is disclosed as truncated');
    assert.equal(res!.id, ids[32], 'the reported record is the last one reached within the cap (still superseded)');
    assert.notEqual(res!.id, ids[33], 'a truncated result never claims to be the true, unreached terminus');
    assert.equal(res!.status, 'superseded');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
