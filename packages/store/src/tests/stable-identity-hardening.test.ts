// ---------------------------------------------------------------------------
// S2b SUPPLEMENTARY FROZEN PINS — stable-identity wave, review-adjudicated
// contracts the main 22-pin suite (stable-identity-write-path.test.ts) left
// uncovered (decision stable-identity-design-v2 / 2176748e-72f6-4cfc-a790-
// 7fd67c7ee6aa, concept article record-identity / 6a4059f7). Authored FROM
// THAT CONTRACT LIST ALONE — no implementation was read, and none of these
// nine points is assumed already fixed; "fixes land in parallel" per the
// dispatch brief.
//
// Every test fails on its OWN assertion with a legible message, never on a
// bare crash of the file: unimplemented primitives are reached through the
// SAME named-failure adapters as the sibling suite (a thrown Error naming the
// missing method), never a raw TypeError from calling `undefined` — mirroring
// the resolveTerminus/catalogStatus frozen-oracle convention already used in
// this directory.
//
// Expected colors:
//   S2b-1..3, S2b-5..9  -> RED against the current working tree
//   S2b-4               -> may be RED or GREEN, pinned either way
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, MountedStores } from '../index.js';

const NOW = '2026-08-22T12:00:00.000Z';
const LATER = '2026-08-22T13:00:00.000Z';

// --- fixtures (mirrors store.test.ts / stable-identity-write-path.test.ts's
// own envelope()/decision() shape — the CURRENTLY-VALID schema input, so a
// fixture failure never masquerades as the behavior under test) ------------

function envelope(type: string, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
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
    statement: 'the original statement',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no joins' }],
    rationale: 'Meets all retrieval criteria.',
    ...over,
  };
}

/**
 * A record authored through the NEW (post-design) envelope shape: lifecycle +
 * freshness instead of status/superseded_by — same convention as
 * stable-identity-write-path.test.ts's lifecycleEnvelope(). Used only where a
 * pin specifically targets this shape.
 */
function lifecycleEnvelope(type: string, lifecycle: 'live' | 'retired', freshness: 'fresh' | 'flagged_stale', over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    lifecycle,
    freshness,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    ...over,
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stable-identity-hardening-'));
  return { dir, store: new SterlingStore(join(dir, 'sterling.db')) };
}

// --- SPEC-ONLY adapters: named "not found" red, never a bare TypeError ----
// (identical naming/contract to stable-identity-write-path.test.ts's
// callUpdateRecord/callGetRecordVersion — kept local since test files are
// independent modules.)

type Patch = Record<string, unknown>;
type WriteOpts = { expected_version?: number; resolves?: string[] };

function callUpdateRecord(store: SterlingStore, id: string, patch: Patch, opts?: WriteOpts): Record<string, unknown> {
  const fn = (store as unknown as { updateRecord?: (...a: unknown[]) => unknown }).updateRecord;
  if (typeof fn !== 'function') {
    throw new Error(
      'SterlingStore.updateRecord not found — expected `store.updateRecord(id, patch, opts?)` generalizing the updateTodo in-place triad to all types (stable-identity-design-v2)'
    );
  }
  return fn.call(store, id, patch, opts) as Record<string, unknown>;
}

function callGetRecordVersion(store: SterlingStore, id: string, version: number): Record<string, unknown> | undefined {
  const fn = (store as unknown as { getRecordVersion?: (...a: unknown[]) => unknown }).getRecordVersion;
  if (typeof fn !== 'function') {
    throw new Error(
      'SterlingStore.getRecordVersion not found — expected `store.getRecordVersion(id, version)` reading a permanent record_versions snapshot (stable-identity-design-v2)'
    );
  }
  return fn.call(store, id, version) as Record<string, unknown> | undefined;
}

/** Raw record_relations edge lookup — mirrors store.test.ts's own raw introspection (line ~313-314). */
function rawRelation(store: SterlingStore, sourceId: string, rel: string, targetId: string): unknown[] {
  const s = store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } };
  return s.db.prepare('SELECT * FROM record_relations WHERE source_id = ? AND rel = ? AND target_id = ?').all(sourceId, rel, targetId);
}

/** Raw db handle — same internal-handle convention as store.test.ts:313. */
function rawDb(store: SterlingStore) {
  return (store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } } }).db;
}

// ===========================================================================
// S2b-1 — CAS loser semantics under sequential interleave
// [stable-identity-design-v2]
// ===========================================================================

test('S2b-1 [stable-identity-design-v2]: CAS loser semantics under sequential interleave — a second updateRecord still carrying the now-stale expected_version refuses naming BOTH versions, never a raw SQLite error, and writes NOTHING', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ statement: 'v1' }));
    const winner = callUpdateRecord(store, d.id, { ...d, statement: 'v2 winner' }, { expected_version: 1 });
    assert.equal(winner.version, 2, 'precondition: the first sequential updateRecord(expected_version:1) landed at version 2');

    let caught: unknown;
    try {
      callUpdateRecord(store, d.id, { ...d, statement: 'v3 loser, replaying the same stale expected_version' }, { expected_version: 1 });
      assert.fail('a SECOND updateRecord still carrying expected_version:1 (now stale) must throw');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, 'the refusal is a real Error, not a bare crash');
    const message = (caught as Error).message;
    assert.match(message, /1/, 'the message names the EXPECTED version the stale caller supplied (1)');
    assert.match(message, /2/, 'the message names the ACTUAL current version (2)');
    assert.doesNotMatch(
      message,
      /SQLITE_CONSTRAINT|UNIQUE constraint failed|SqliteError/i,
      'the refusal is a named CAS error, never a raw SQLite uniqueness/constraint error leaking through'
    );

    const after = store.get(d.id) as unknown as { version: number; statement: string };
    assert.equal(after.version, 2, 'no v3 landed — version unchanged after the refusal');
    assert.equal(after.statement, 'v2 winner', 'content unchanged after the refusal');
    assert.equal(callGetRecordVersion(store, d.id, 3), undefined, 'no orphan v3 snapshot was written for the refused loser write');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S2b-2 — retire-cycle refusal: a retired record cannot be named a successor
// [stable-identity-design-v2]
// ===========================================================================

test('S2b-2 [stable-identity-design-v2]: retire-cycle refusal — retireInFavorOf(B, A) refuses when A is already retired; B stays live, served, and carries no successor', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(decision({ statement: 'a (will be retired first)' }));
    const b = store.create(decision({ statement: 'b (retires in favor of a — a red herring precondition)' }));

    store.retireInFavorOf(a.id, b.id, LATER); // A retired in favor of B: A is now retired, B is now live/served

    const bBefore = store.get(b.id) as unknown as { status: string; superseded_by: string | null };
    assert.equal(bBefore.status, 'active', 'precondition: b is live after winning the first retirement');
    assert.equal(bBefore.superseded_by, null, 'precondition: b carries no successor yet');

    assert.throws(
      () => store.retireInFavorOf(b.id, a.id, LATER),
      /live|retired/i,
      "retireInFavorOf(B, A) must refuse — A (the proposed replacement) is RETIRED, and a successor must be a LIVE record"
    );

    const bAfter = store.get(b.id) as unknown as { status: string; superseded_by: string | null };
    assert.equal(bAfter.status, 'active', 'b is STILL live after the refused retirement attempt');
    assert.equal(bAfter.superseded_by, null, 'b STILL carries no successor after the refusal');

    const aAfter = store.get(a.id) as unknown as { status: string; superseded_by: string | null };
    assert.equal(aAfter.status, 'superseded', 'a is unchanged by the refused attempt — still retired');
    assert.equal(aAfter.superseded_by, b.id, "a's successor is still b, untouched by the refused attempt naming a as a successor");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S2b-3 — addLink must refuse rel 'supersedes'
// [stable-identity-design-v2]
// ===========================================================================

test("S2b-3 [stable-identity-design-v2]: addLink refuses rel 'supersedes' — that edge is written ONLY by the supersede/retire paths (one-successor invariant)", () => {
  const { dir, store } = tempStore();
  try {
    const source = store.create(decision({ statement: 'source' }));
    const target = store.create(decision({ statement: 'target' }));

    assert.throws(
      () => store.addLink(source.id, 'supersedes', target.id),
      /supersede|retire/i,
      'addLink must throw, naming the sanctioned supersede/retire paths, when asked to write a manual supersedes edge'
    );

    assert.equal(
      rawRelation(store, source.id, 'supersedes', target.id).length,
      0,
      'no relation row was written for the refused edge'
    );
    const src = store.get(source.id) as unknown as { status: string; superseded_by: string | null };
    const tgt = store.get(target.id) as unknown as { status: string; superseded_by: string | null };
    assert.equal(src.status, 'active', "the source record's served status is unchanged by the refused addLink");
    assert.equal(src.superseded_by, null);
    assert.equal(tgt.status, 'active', "the target record's served status is unchanged by the refused addLink");
    assert.equal(tgt.superseded_by, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S2b-4 — MountedStores accepts the new envelope shape (may be red or green)
// [stable-identity-design-v2]
// ===========================================================================

test('S2b-4 [stable-identity-design-v2]: MountedStores.create() AND the project-store default route both accept lifecycle:live/freshness:fresh with NO legacy status/superseded_by, and serve derived status active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stable-identity-hardening-mounted-'));
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), []);
  try {
    const viaMounted = stores.create({
      ...lifecycleEnvelope('decision', 'live', 'fresh'),
      title: 'via MountedStores',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    const servedMounted = stores.get(viaMounted.id) as unknown as { status: string };
    assert.ok(servedMounted, 'MountedStores.create() accepted the new envelope shape and the record is served');
    assert.equal(servedMounted.status, 'active', 'MountedStores serves the new-envelope record with derived status active');

    // the project-store default route: the plain SterlingStore backing every
    // MountedStores.project mount, accepting the same new envelope shape
    // directly through the store's own default create() path.
    const viaProject = stores.project.create({
      ...lifecycleEnvelope('decision', 'live', 'fresh'),
      title: 'via project store',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    const servedProject = stores.project.get(viaProject.id) as unknown as { status: string };
    assert.ok(servedProject, 'the project-store default route accepted the new envelope shape and the record is served');
    assert.equal(servedProject.status, 'active', 'the project-store default route serves the new-envelope record with derived status active');
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S2b-5 — renameFileKey is a versioned write
// [stable-identity-design-v2]
// ===========================================================================

test('S2b-5 [stable-identity-design-v2]: renameFileKey is a versioned write — version bumps, the prior body is archived at the pre-rename version, and query() on the OLD path token stops surfacing the record while the NEW path surfaces it', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ file_keys: ['old/path.ts'] }));
    assert.equal(store.query({ file_keys: ['old/path.ts'] }).length, 1, 'precondition: the record joins on the OLD file key');

    store.renameFileKey('old/path.ts', 'new/path.ts');

    const after = store.get(d.id) as unknown as { version: number; file_keys: string[] };
    assert.equal(after.version, 2, 'renameFileKey bumps the server-owned version like any other write');
    assert.ok(after.file_keys.includes('new/path.ts'), 'the served record now carries the new path');
    assert.ok(!after.file_keys.includes('old/path.ts'), 'the served record no longer carries the old path');

    const archived = callGetRecordVersion(store, d.id, 1);
    assert.ok(archived, 'the pre-rename body is archived at version 1');
    assert.deepEqual(archived!.file_keys, ['old/path.ts'], 'the archived snapshot carries the OLD path, untouched by the rename');

    assert.equal(store.query({ file_keys: ['old/path.ts'] }).length, 0, 'the OLD path token no longer surfaces the record');
    assert.equal(store.query({ file_keys: ['new/path.ts'] }).length, 1, 'the NEW path surfaces the record');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S2b-6 — enqueueSystemTodo text-update is a versioned write
// [stable-identity-design-v2]
// ===========================================================================

test('S2b-6 [stable-identity-design-v2]: enqueueSystemTodo text-update (dedup/escalation branch) is a versioned write — id stable, version bumps, prior body archived, and query() finds it by the NEW text', () => {
  const { dir, store } = tempStore();
  try {
    const link = randomUUID();
    const base = (over: Record<string, unknown> = {}) => ({
      ...envelope('todo'),
      text: 'reconcile article x — src/a.ts changed on disk',
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['src/a.ts'],
      feature_link: link,
      ...over,
    });

    const first = store.enqueueSystemTodo(base());
    assert.equal(first.deduped, false, 'precondition: the first enqueue is a fresh item');

    const second = store.enqueueSystemTodo(
      base({ text: 'reconcile article x — src/a.ts DELETED on disk zzzescalatedmarker', updated_at: LATER })
    );
    assert.equal(second.record.id, first.record.id, 'the same-lane escalated enqueue keeps the SAME id');
    assert.equal(second.text_updated, true, 'the text-update branch fired (escalated severity)');
    assert.equal((second.record as unknown as { version: number }).version, 2, 'the text-update write bumps the universal version counter');

    const archived = callGetRecordVersion(store, first.record.id, 1);
    assert.ok(archived, 'the prior body is archived at version 1');
    assert.equal(archived!.text, 'reconcile article x — src/a.ts changed on disk', 'the archived snapshot carries the ORIGINAL text');

    assert.equal(
      store.query({ types: ['todo'], rank_terms: ['zzzescalatedmarker'] }).length,
      1,
      'query() with rank_terms matching the NEW text finds the updated item'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S2b-7 — create() refuses a born-dead record
// [stable-identity-design-v2]
// ===========================================================================

test('S2b-7 [stable-identity-design-v2]: create() refuses a born-dead record — lifecycle:retired with no legacy superseded_by cannot be created directly; nothing is written', () => {
  const { dir, store } = tempStore();
  try {
    const bornDead = {
      ...lifecycleEnvelope('decision', 'retired', 'fresh'),
      title: 'born dead',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    };

    assert.throws(
      () => store.create(bornDead),
      /retired|successor|supersede/i,
      'create() must refuse a record authored already lifecycle:retired — a retired record must arrive via supersede/retire and carry a successor'
    );

    assert.equal(store.get(bornDead.id as string), undefined, 'nothing was written for the refused create');
    assert.equal(store.count({ types: ['decision'] }), 0, 'no decision record landed at all');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S2b-8 — remove() clears aliases
// [stable-identity-design-v2]
// ===========================================================================

test('S2b-8 [stable-identity-design-v2]: remove() clears record_aliases rows pointing at the removed record — no dead alias resolving to nothing', () => {
  const { dir, store } = tempStore();
  try {
    const canonical = store.create(decision({ statement: 'canonical target' }));

    // raw-insert a historical alias row via the store's internal db handle —
    // same internal-handle convention as store.test.ts:313-314. Column names
    // (historical_id / canonical_id / archived_version) are taken verbatim
    // from the record-identity concept article's own description of the
    // table ("a dead-id lookup mapping every pre-migration historical id to
    // (canonical_id, archived_version)") — no formal interface slice pins the
    // exact column names, so if these differ, THIS insert throws in isolation
    // rather than masquerading as a pass of the behavior under test.
    const db = rawDb(store);
    const historicalId = randomUUID();
    // test-repair 2026-08-22: the shipped DDL also carries a NOT NULL created_at
    // column — the flagged uncertainty above landed here; fixture completed,
    // assertion unchanged [stable-identity-design-v2]
    db.prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)').run(
      historicalId,
      canonical.id,
      1,
      '2026-08-22T00:00:00.000Z'
    );

    const before = db.prepare('SELECT * FROM record_aliases WHERE canonical_id = ?').all(canonical.id);
    assert.equal(before.length, 1, 'precondition: the alias row exists, pointing at the canonical record');

    store.remove(canonical.id);

    const after = db.prepare('SELECT * FROM record_aliases WHERE canonical_id = ?').all(canonical.id);
    assert.equal(after.length, 0, 'remove() clears aliases pointing at the removed record — no dead alias left resolving to nothing');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// S2b-9 — tx-counter resilience across consecutive failed writes
// [stable-identity-design-v2]
// ===========================================================================

test('S2b-9 [stable-identity-design-v2]: tx-counter resilience — after a write that fails mid-transaction, a SUBSEQUENT unrelated write on the same store still fails atomically with no leaked partial effects, and the store stays writable', () => {
  const { dir, store } = tempStore();
  try {
    // first failure: an unresolvable `resolves` claim rolls back mid-transaction
    // (same shape as the frozen S2-4b pin in stable-identity-write-path.test.ts)
    // — this is the PRIOR failed write whose aftermath this test probes.
    const articleA = store.create({
      ...envelope('feature_article'),
      slug: 'txres-a',
      title: 'A',
      what_it_does: 'a',
      intended_behavior: 'a',
      files: [],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [],
      live_test_refs: [],
    });
    assert.throws(
      () => callUpdateRecord(store, articleA.id, { ...articleA, what_it_does: 'a updated' }, { resolves: [randomUUID()] }),
      /./,
      'setup: the FIRST write fails mid-transaction on an unresolvable resolves claim'
    );

    // a completely unrelated record, written AFTER that failure
    const d = store.create(decision({ statement: 'zzztxresmarker original' }));
    assert.equal(
      store.query({ types: ['decision'], rank_terms: ['zzztxresmarker'] }).length,
      1,
      'precondition: the unrelated record is live and indexed after the prior failure'
    );

    // force THIS write to fail too, and prove its partial effects never leak
    assert.throws(
      () => callUpdateRecord(store, d.id, { ...d, statement: 'zzztxresmarker SHOULD NOT LEAK' }, { resolves: [randomUUID()] }),
      /./,
      'the SECOND, unrelated write also fails mid-transaction on its own unresolvable resolves claim'
    );

    const after = store.get(d.id) as unknown as { version: number; statement: string };
    assert.equal(after.version, 1, 'no version bump leaked from the failed second write');
    assert.equal(after.statement, 'zzztxresmarker original', 'no partial content change leaked from the failed second write');
    assert.equal(callGetRecordVersion(store, d.id, 2), undefined, 'no orphan record_versions snapshot leaked from the failed second write');
    assert.equal(
      store.query({ types: ['decision'], rank_terms: ['SHOULD'] }).length,
      0,
      "the failed write's FTS text never leaked into the index"
    );
    assert.equal(
      store.query({ types: ['decision'], rank_terms: ['zzztxresmarker'] }).length,
      1,
      'still exactly one live row for the id — no duplicate/orphan row from the failed transaction'
    );

    // the transaction machinery is still armed: a genuine, valid write right
    // after two consecutive failures still lands and is fully atomic
    const finalWrite = callUpdateRecord(store, d.id, { ...d, statement: 'zzztxresmarker committed for real' });
    assert.equal(finalWrite.version, 2, 'a valid write after two consecutive failures still commits normally — the tx machinery re-armed, not left wedged');
    assert.equal(
      store.query({ types: ['decision'], rank_terms: ['zzztxresmarker'] }).length,
      1,
      'still exactly one live row after the successful recovery write'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
