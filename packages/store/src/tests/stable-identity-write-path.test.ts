// ---------------------------------------------------------------------------
// S2 FROZEN RED PINS — stable-identity wave, schema v2 + store write path
// (board 62b5976b, decision stable-identity-design-v2 / 2176748e-72f6-4cfc-
// a790-7fd67c7ee6aa, concept article record-identity / 6a4059f7). SPEC-ONLY:
// authored FROM THE DESIGN ALONE, before any of this exists on SterlingStore.
// Every test below is expected to fail RED on its own assertion (a thrown
// "not found" error naming the missing primitive, a schema-validation
// rejection, or a plain equality/deepEqual mismatch against today's
// pre-v2 behavior) — never on a bare crash of the whole file and never on a
// TypeScript compile error (all new-primitive calls go through named-failure
// adapters, mirroring the existing resolveTerminus / catalogStatus
// frozen-oracle convention in this same test directory).
//
// CONTRACT (S2, cited [stable-identity-design-v2] throughout):
//   1. record_versions / record_aliases / record_relations exist; version
//      history is NEVER searchable through records_fts / query().
//   2. Every knowledge_update/edit/append-shaped write mutates the record
//      IN PLACE (same id), bumps a server-owned integer `version` by 1, and
//      archives the full PRIOR snapshot into record_versions, readable by
//      (id, version). Todos gain the counter, keep stable ids, get no slug.
//   3. expected_version is a CAS token: UPDATE...WHERE id=? AND version=?.
//      A stale expected_version refuses LOUDLY naming both the expected and
//      the actual version, and changes NOTHING.
//   4. A write that also claims `resolves` (closing maintenance items) is
//      ONE transaction: if the drain refuses, the whole write rolls back
//      (no version bump, no snapshot, item(s) still open).
//   5. lifecycle ('live'|'retired') + freshness ('fresh'|'flagged_stale')
//      replace stored status/superseded_by; served records DERIVE status/
//      superseded_by. Retirement happens only via supersede/retire; at most
//      one successor; relation cycles rejected.
//   6. record_relations is authoritative: links[] materializes at read;
//      writing a typed edge (supersedes, cites, ...) lands in the table.
//   7. Exactly one records_fts row per record id, reflecting the CURRENT
//      version only — an in-place update REPLACES it, never duplicates it.
//
// ADAPTER NAMING NOTE (disclosed as a gap in the handoff too): no formal
// interface slice fixes the exact method names for the three generalized
// write shapes. The names below (`updateRecord`, `editRecordField`,
// `appendRecordField`, `getRecordVersion`) are the most direct generalization
// of the shipped `updateTodo` triad and the mcp tool names
// (knowledge_update/edit/append) already used throughout CLAUDE.md and the
// design decision. If the coder lands a different exact name, these adapters
// give a clear named-failure red rather than a silent pass or a bare crash —
// the BEHAVIORAL assertions below are the contract either way.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

const NOW = '2026-08-22T12:00:00.000Z';
const LATER = '2026-08-22T13:00:00.000Z';

// --- fixtures (mirrors store.test.ts's own envelope()/decision() shape —
// the CURRENTLY-VALID schema input, so a fixture failure never masquerades
// as the behavior under test) ---------------------------------------------

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
    file_keys: [],
    ...over,
  };
}

/**
 * A record authored through the NEW (post-design) envelope shape: lifecycle +
 * freshness instead of status/superseded_by, per contract point 5's explicit
 * "replacing stored status/superseded_by". Used ONLY by the contract-5 tests
 * that specifically target this shape — if create() does not yet accept it,
 * THOSE tests (and only those) fail red on the create() call itself, which is
 * an accurate, isolated red for that contract point rather than a generic
 * fixture failure bleeding into unrelated pins.
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stable-identity-'));
  return { dir, store: new SterlingStore(join(dir, 'sterling.db')) };
}

// --- SPEC-ONLY adapters: named "not found" red, never a bare TypeError ----

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

function callEditRecordField(store: SterlingStore, id: string, field: string, find: string, replace: string, opts?: WriteOpts): Record<string, unknown> {
  const fn = (store as unknown as { editRecordField?: (...a: unknown[]) => unknown }).editRecordField;
  if (typeof fn !== 'function') {
    throw new Error(
      'SterlingStore.editRecordField not found — expected `store.editRecordField(id, field, find, replace, opts?)` (knowledge_edit-shaped write, exactly-once find per stable-identity-design-v2)'
    );
  }
  return fn.call(store, id, field, find, replace, opts) as Record<string, unknown>;
}

function callAppendRecordField(store: SterlingStore, id: string, field: string, entry: unknown, opts?: WriteOpts): Record<string, unknown> {
  const fn = (store as unknown as { appendRecordField?: (...a: unknown[]) => unknown }).appendRecordField;
  if (typeof fn !== 'function') {
    throw new Error(
      'SterlingStore.appendRecordField not found — expected `store.appendRecordField(id, field, entry, opts?)` (knowledge_append-shaped in-transaction write per stable-identity-design-v2)'
    );
  }
  return fn.call(store, id, field, entry, opts) as Record<string, unknown>;
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

/** Raw table-name snapshot — the same out-of-band convention schema-version-guard.test.ts uses. */
function rawTableNames(store: SterlingStore): string[] {
  const s = store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => { name: string }[] } } };
  return s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name).sort();
}

/** Raw record_relations edge lookup — mirrors store.test.ts's own raw record_links introspection. */
function rawRelation(store: SterlingStore, sourceId: string, rel: string, targetId: string): unknown[] {
  const s = store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } };
  return s.db.prepare('SELECT * FROM record_relations WHERE source_id = ? AND rel = ? AND target_id = ?').all(sourceId, rel, targetId);
}

// ===========================================================================
// PIN GROUP 1 — schema v2 tables exist; version history is never searchable
// [stable-identity-design-v2]
// ===========================================================================

test('S2-1a [stable-identity-design-v2]: a freshly created store has record_versions, record_aliases, record_relations tables', () => {
  const { dir, store } = tempStore();
  try {
    const tables = rawTableNames(store);
    assert.ok(tables.includes('record_versions'), 'record_versions (full-snapshot, append-only, permanent history) must exist');
    assert.ok(tables.includes('record_aliases'), 'record_aliases (historical_id -> canonical_id + archived_version) must exist');
    assert.ok(tables.includes('record_relations'), 'record_relations (typed edges, authoritative supersedes home) must exist');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-1b [stable-identity-design-v2]: archived version content is NOT searchable — an old token gone from the current version does not rank', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ statement: 'the archivetokenzzz original statement' }));
    assert.equal(store.query({ types: ['decision'], rank_terms: ['archivetokenzzz'] }).length, 1, 'precondition: the token is searchable in the CURRENT version');

    callUpdateRecord(store, d.id, { ...d, statement: 'a completely different statement', updated_at: LATER });

    assert.equal(
      store.query({ types: ['decision'], rank_terms: ['archivetokenzzz'] }).length,
      0,
      'the OLD token now lives only in the archived record_versions snapshot — query()/records_fts must never surface it'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN GROUP 2 — stable id + universal server-owned version across
// update/edit/append-shaped writes, all record types, no slug on todos
// [stable-identity-design-v2]
// ===========================================================================

test('S2-2a [stable-identity-design-v2]: every newly created record carries a server-owned version starting at 1 (generalized beyond feature_article)', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision());
    assert.equal((d as unknown as { version: number }).version, 1, 'a decision — a type that never carried version before — now starts at version 1');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-2b [stable-identity-design-v2]: updateRecord mutates IN PLACE — same id, version bumps 1->2, full prior snapshot archived and readable by (id, version)', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ statement: 'v1 statement' }));
    const patched = callUpdateRecord(store, d.id, { ...d, statement: 'v2 statement', updated_at: LATER });

    assert.equal(patched.id, d.id, 'the id never changes across an in-place update');
    assert.equal(patched.version, 2, 'version bumps by exactly 1');
    assert.equal(patched.statement, 'v2 statement');

    const served = store.get(d.id) as unknown as { statement: string; version: number };
    assert.equal(served.statement, 'v2 statement', 'get() reflects the SAME record, mutated');
    assert.equal(served.version, 2);

    const archived = callGetRecordVersion(store, d.id, 1);
    assert.ok(archived, 'the prior version (1) is archived and resolvable');
    assert.equal(archived!.statement, 'v1 statement', 'the archived snapshot is the FULL prior record, not a diff');
    assert.equal(archived!.version, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-2c [stable-identity-design-v2]: append-only — an archived snapshot never changes across later writes, and reads of it are byte-identical every time', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ statement: 'v1 statement' }));
    callUpdateRecord(store, d.id, { ...d, statement: 'v2 statement', updated_at: LATER });
    const v1First = callGetRecordVersion(store, d.id, 1);

    callUpdateRecord(store, d.id, { ...d, statement: 'v3 statement', updated_at: '2026-08-22T14:00:00.000Z' });
    const v1Second = callGetRecordVersion(store, d.id, 1);

    assert.deepEqual(v1Second, v1First, 'record_versions is append-only — writing v3 must not retroactively alter the v1 snapshot');
    assert.equal(v1Second!.statement, 'v1 statement', 'the original v1 text survives forever, untouched by later writes');

    const v2 = callGetRecordVersion(store, d.id, 2);
    assert.equal(v2!.statement, 'v2 statement', 'v2 is independently archived and still resolvable after v3 lands');

    assert.equal(callGetRecordVersion(store, d.id, 5), undefined, 'a version number that was never archived resolves to nothing — never fabricated');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-2d [stable-identity-design-v2]: todos gain the version counter, keep a stable id, and never carry a slug', () => {
  const { dir, store } = tempStore();
  try {
    const t = store.create({ ...envelope('todo'), text: 'reconcile auth article', source: 'user', priority: 'low' });
    assert.equal((t as unknown as { version: number }).version, 1, 'a todo now starts at version 1 too');
    assert.ok(!('slug' in t), 'todos never get a slug');

    const patched = store.updateTodo(t.id, { ...t, text: 'reconcile auth article thoroughly', updated_at: LATER });
    assert.equal(patched.id, t.id, 'id stable across updateTodo, as before');
    assert.equal((patched as unknown as { version: number }).version, 2, 'updateTodo now also bumps the universal version counter');
    assert.ok(!('slug' in patched), 'still no slug after an in-place update');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-2e [stable-identity-design-v2]: editRecordField requires the find text to match EXACTLY ONCE — zero and multiple matches both refuse, naming the count, nothing written', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ rationale: 'Meets all retrieval criteria.' }));

    // zero matches
    assert.throws(
      () => callEditRecordField(store, d.id, 'rationale', 'this text is not present anywhere', 'replacement'),
      /0|zero|no match/i,
      'a find string matching nowhere refuses, naming the count (0)'
    );
    assert.equal((store.get(d.id) as unknown as { version: number }).version, 1, 'a zero-match refusal writes nothing — version unchanged');

    // multiple matches
    const dup = store.create(decision({ rationale: 'dup dup two occurrences' }));
    assert.throws(
      () => callEditRecordField(store, dup.id, 'rationale', 'dup', 'once'),
      /2|two|multiple/i,
      'a find string matching twice refuses, naming the count (2) — an unreviewable blind replace is never allowed'
    );
    assert.equal((store.get(dup.id) as unknown as { version: number }).version, 1, 'a multi-match refusal writes nothing — version unchanged');

    // exactly one match succeeds
    const patched = callEditRecordField(store, d.id, 'rationale', 'Meets all retrieval criteria.', 'Meets all retrieval and ranking criteria.');
    assert.equal(patched.id, d.id);
    assert.equal(patched.version, 2, 'an exactly-once match succeeds and bumps version');
    assert.equal(patched.rationale, 'Meets all retrieval and ranking criteria.');
    assert.ok(callGetRecordVersion(store, d.id, 1), 'the prior version is archived on a successful edit too');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-2f [stable-identity-design-v2]: appendRecordField grows an array field in place, in one transaction, bumping version and archiving the prior array', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ alternatives_rejected: [{ option: 'JSON files', reason: 'no joins' }] }));
    const patched = callAppendRecordField(store, d.id, 'alternatives_rejected', { option: 'flat files', reason: 'no query planner' });

    assert.equal(patched.id, d.id, 'append mutates in place — same id');
    assert.equal(patched.version, 2, 'append bumps version like update/edit');
    const arr = patched.alternatives_rejected as { option: string }[];
    assert.equal(arr.length, 2, 'the array grew by exactly one entry');
    assert.deepEqual(arr.map((a) => a.option), ['JSON files', 'flat files'], 'append adds, never replaces, the prior entries');

    const archived = callGetRecordVersion(store, d.id, 1);
    assert.equal((archived!.alternatives_rejected as unknown[]).length, 1, 'the PRE-append array is archived at version 1, untouched');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN GROUP 3 — expected_version CAS: UPDATE ... WHERE id=? AND version=?
// [stable-identity-design-v2]
// ===========================================================================

test('S2-3a [stable-identity-design-v2]: updateRecord with the CORRECT expected_version succeeds', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision());
    const patched = callUpdateRecord(store, d.id, { ...d, statement: 'v2' }, { expected_version: 1 });
    assert.equal(patched.version, 2);
    assert.equal(patched.statement, 'v2');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-3b [stable-identity-design-v2]: a STALE expected_version refuses LOUDLY naming BOTH the expected and the actual version, and changes NOTHING', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ statement: 'v1' }));
    callUpdateRecord(store, d.id, { ...d, statement: 'v2' }); // real version is now 2, no CAS supplied

    let caught: unknown;
    try {
      callUpdateRecord(store, d.id, { ...d, statement: 'attempted v3 from a stale read' }, { expected_version: 1 });
      assert.fail('a stale expected_version must throw');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    const message = (caught as Error).message;
    assert.match(message, /1/, 'the message names the EXPECTED version supplied by the stale caller (1)');
    assert.match(message, /2/, 'the message names the ACTUAL current version (2)');

    const after = store.get(d.id) as unknown as { statement: string; version: number };
    assert.equal(after.version, 2, 'no version bump on a rejected CAS');
    assert.equal(after.statement, 'v2', 'no content change on a rejected CAS');
    assert.equal(callGetRecordVersion(store, d.id, 3), undefined, 'no orphan snapshot row for the version the rejected write would have produced');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-3c [stable-identity-design-v2] CAS race shape, non-idempotent by design: two callers both observed version 1 — the first commits, the SECOND replay with the SAME expected_version fails even though it is a repeat of an already-successful shape', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ statement: 'v1' }));
    const observedVersion = (d as unknown as { version: number }).version;
    assert.equal(observedVersion, 1);

    // caller A wins the race
    const winner = callUpdateRecord(store, d.id, { ...d, statement: 'winner content' }, { expected_version: observedVersion });
    assert.equal(winner.version, 2);

    // caller B raced on the SAME originally-observed version — must be rejected,
    // never silently treated as an idempotent no-op or a successful merge.
    assert.throws(
      () => callUpdateRecord(store, d.id, { ...d, statement: 'loser content' }, { expected_version: observedVersion }),
      /./,
      'a second writer racing on the same stale observed version is rejected — CAS provides no accidental idempotency'
    );
    assert.equal((store.get(d.id) as unknown as { statement: string }).statement, 'winner content', "the loser's content never lands");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN GROUP 4 — single-transaction write + resolves drain
// [stable-identity-design-v2]
// ===========================================================================

test('S2-4a [stable-identity-design-v2]: updateRecord with resolves closes the named maintenance item atomically alongside the version bump', () => {
  const { dir, store } = tempStore();
  try {
    const article = store.create({ ...envelope('feature_article'), slug: 'x', title: 'X', what_it_does: 'x', intended_behavior: 'x', files: [], current_ac: [], dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1, history: [], live_test_refs: [] }); // test-repair 2026-08-22: fixture omitted the required state enum [stable-identity-design-v2]
    const item = store.create({ ...envelope('todo'), text: 'reconcile x', source: 'system', system_reason: 'reconcile_needed', file_keys: [] });

    const patched = callUpdateRecord(store, article.id, { ...article, what_it_does: 'x updated' }, { resolves: [item.id] });

    assert.equal(patched.version, 2, 'the record write landed');
    assert.equal(store.get(item.id), undefined, 'the claimed maintenance item is closed in the same transaction');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-4b [stable-identity-design-v2]: an unresolvable resolves claim rolls back the ENTIRE transaction — the record write is undone too, and any OTHER valid item in the same claim is NOT drained either', () => {
  const { dir, store } = tempStore();
  try {
    const article = store.create({ ...envelope('feature_article'), slug: 'y', title: 'Y', what_it_does: 'y', intended_behavior: 'y', files: [], current_ac: [], dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1, history: [], live_test_refs: [] }); // test-repair 2026-08-22: fixture omitted the required state enum [stable-identity-design-v2]
    const validItem = store.create({ ...envelope('todo'), text: 'reconcile y', source: 'system', system_reason: 'reconcile_needed', file_keys: [] });
    const bogusId = randomUUID(); // never created — an unresolvable claim

    assert.throws(
      () => callUpdateRecord(store, article.id, { ...article, what_it_does: 'y updated' }, { resolves: [validItem.id, bogusId] }),
      /./,
      'a resolves claim naming a nonexistent item refuses'
    );

    const afterArticle = store.get(article.id) as unknown as { version: number; what_it_does: string };
    assert.equal(afterArticle.version, 1, 'the record write rolled back too — no version bump');
    assert.equal(afterArticle.what_it_does, 'y', 'no partial content change');
    assert.equal(callGetRecordVersion(store, article.id, 2), undefined, 'no orphan snapshot for the rolled-back write');
    assert.ok(store.get(validItem.id), 'the OTHER, genuinely valid item in the same claim is STILL OPEN — atomicity, not partial drain');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-4c [stable-identity-design-v2]: resolves is not idempotent across calls — reusing an already-closed item id in a later claim refuses, and does not partially apply the record write', () => {
  const { dir, store } = tempStore();
  try {
    const article = store.create({ ...envelope('feature_article'), slug: 'z', title: 'Z', what_it_does: 'z', intended_behavior: 'z', files: [], current_ac: [], dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1, history: [], live_test_refs: [] }); // test-repair 2026-08-22: fixture omitted the required state enum [stable-identity-design-v2]
    const item = store.create({ ...envelope('todo'), text: 'reconcile z', source: 'system', system_reason: 'reconcile_needed', file_keys: [] });

    const first = callUpdateRecord(store, article.id, { ...article, what_it_does: 'z v2' }, { resolves: [item.id] });
    assert.equal(first.version, 2);
    assert.equal(store.get(item.id), undefined, 'item closed on the first claim');

    assert.throws(
      () => callUpdateRecord(store, article.id, { ...article, what_it_does: 'z v3' }, { resolves: [item.id] }),
      /./,
      'reclaiming an already-closed item id refuses — an unclaimed write must never silently "succeed" against a dead reference'
    );
    assert.equal((store.get(article.id) as unknown as { version: number; what_it_does: string }).version, 2, 'the second, failed claim did not bump version again');
    assert.equal((store.get(article.id) as unknown as { what_it_does: string }).what_it_does, 'z v2', 'no partial content change from the refused second write');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN GROUP 5 — lifecycle + freshness with derived status/superseded_by
// compatibility [stable-identity-design-v2]
// ===========================================================================

test('S2-5a [stable-identity-design-v2]: supersede sets lifecycle retired/live on old/new, and status/superseded_by are DERIVED from lifecycle + the inbound supersedes relation', () => {
  const { dir, store } = tempStore();
  try {
    const v1 = store.create(decision({ statement: 'v1' }));
    const v2 = store.supersede(v1.id, decision({ statement: 'v2' }));

    const oldRec = store.get(v1.id) as unknown as { lifecycle?: string; status: string; superseded_by: string | null };
    assert.equal(oldRec.lifecycle, 'retired', 'the superseded record carries lifecycle:retired');
    assert.equal(oldRec.status, 'superseded', 'status is DERIVED: retired lifecycle -> superseded');
    assert.equal(oldRec.superseded_by, v2.id, 'superseded_by is DERIVED from the inbound supersedes relation, not a stored column value the caller set');

    const newRec = store.get(v2.id) as unknown as { lifecycle?: string; status: string; superseded_by: string | null };
    assert.equal(newRec.lifecycle, 'live', 'the successor carries lifecycle:live');
    assert.equal(newRec.status, 'active', 'a live record with fresh freshness derives status:active');
    assert.equal(newRec.superseded_by, null, 'a live record has no successor');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-5b [stable-identity-design-v2]: a record authored with freshness:flagged_stale and lifecycle:live derives status:flagged_stale (new envelope shape)', () => {
  const { dir, store } = tempStore();
  try {
    const rec = store.create({
      ...lifecycleEnvelope('research_finding', 'live', 'flagged_stale'),
      question: 'q',
      answer: 'a',
      source_urls: [],
      source_date: '2026-01-01',
      capture_date: '2026-01-01',
      volatility_hint: 'medium',
    });
    const served = store.get(rec.id) as unknown as { status: string; lifecycle: string; freshness: string };
    assert.equal(served.lifecycle, 'live');
    assert.equal(served.freshness, 'flagged_stale');
    assert.equal(served.status, 'flagged_stale', 'derived status mirrors the pre-v2 flagged_stale served status — API compatibility preserved');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-5c [stable-identity-design-v2]: retireInFavorOf (duplicate consolidation) mints NO new record, sets lifecycle:retired, and derives status/superseded_by the same way supersede does', () => {
  const { dir, store } = tempStore();
  try {
    const dup = store.create(decision({ statement: 'a duplicate decision' }));
    const survivor = store.create(decision({ statement: 'the survivor' }));
    const before = store.count({ types: ['decision'] });

    store.retireInFavorOf(dup.id, survivor.id, LATER);

    // test-repair 2026-08-22: retire stops the record being SERVED (decision 9948475b; store.test.ts
    // pins the same served-count rule), so the served count drops by one — which still proves no new
    // record was minted (supersede would net UNCHANGED: one retired, one minted). [stable-identity-design-v2]
    assert.equal(store.count({ types: ['decision'] }), before - 1, 'retire is duplicate consolidation — no new record is minted, and the retired duplicate stops being served');
    const retired = store.get(dup.id) as unknown as { lifecycle?: string; status: string; superseded_by: string | null };
    assert.equal(retired.lifecycle, 'retired');
    assert.equal(retired.status, 'superseded', 'derived the same way as a superseded record — API compatibility');
    assert.equal(retired.superseded_by, survivor.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-5d [stable-identity-design-v2]: at most ONE successor per record — a record already retired cannot be superseded OR retired again by either path', () => {
  const { dir, store } = tempStore();
  try {
    const v1 = store.create(decision({ statement: 'v1' }));
    store.supersede(v1.id, decision({ statement: 'v2' }));

    assert.throws(() => store.supersede(v1.id, decision({ statement: 'v3 attempted' })), /already superseded|retired/i, 'a second supersede on an already-retired record refuses');

    const anotherSurvivor = store.create(decision({ statement: 'another survivor' }));
    assert.throws(
      () => store.retireInFavorOf(v1.id, anotherSurvivor.id, LATER),
      /./,
      'a record already carrying a successor cannot ALSO be retired in favor of a second one — one successor max, across both paths'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-5e [stable-identity-design-v2]: relation cycles are rejected — a record cannot be "superseded" by a new record sharing its own id (self-cycle)', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(decision({ statement: 'a' }));
    assert.throws(
      () => store.supersede(a.id, decision({ id: a.id, statement: 'a again, same id' })),
      /cycle|self/i,
      'superseding a record with a "new" record carrying the SAME id is a self-cycle in the relation graph — must be refused, never silently accepted as a no-op update'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN GROUP 6 — record_relations is authoritative; links[] materializes at
// read [stable-identity-design-v2]
// ===========================================================================

test('S2-6a [stable-identity-design-v2]: addLink writes a row into record_relations, and the served links[] materializes from it', () => {
  const { dir, store } = tempStore();
  try {
    const source = store.create(decision({ statement: 'source' }));
    const target = store.create(decision({ statement: 'target' }));
    store.addLink(source.id, 'cites', target.id);

    assert.equal(rawRelation(store, source.id, 'cites', target.id).length, 1, 'the typed edge landed in record_relations, the authoritative home');
    const served = store.get(source.id) as unknown as { links: { rel: string; target_id: string }[] };
    assert.ok(served.links.some((l) => l.rel === 'cites' && l.target_id === target.id), 'links[] is materialized at read from record_relations');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S2-6b [stable-identity-design-v2]: supersede\'s auto-ensured supersedes edge also lands in record_relations', () => {
  const { dir, store } = tempStore();
  try {
    const v1 = store.create(decision({ statement: 'v1' }));
    const v2 = store.supersede(v1.id, decision({ statement: 'v2' }));
    assert.equal(rawRelation(store, v2.id, 'supersedes', v1.id).length, 1, 'the supersedes edge is a row in record_relations, not just a links[] artifact');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN GROUP 7 — exactly one records_fts row per id, current version only
// [stable-identity-design-v2]
// ===========================================================================

test('S2-7 [stable-identity-design-v2]: an in-place update REPLACES the FTS row — the old text stops ranking, the new text ranks, and there is still exactly one live row for the id', () => {
  const { dir, store } = tempStore();
  try {
    const d = store.create(decision({ statement: 'contains zzztokenone marker' }));
    assert.equal(store.query({ types: ['decision'], rank_terms: ['zzztokenone'] }).length, 1, 'precondition: version-1 text is indexed');

    callUpdateRecord(store, d.id, { ...d, statement: 'contains zzztokentwo marker', updated_at: LATER });
    assert.equal(store.query({ types: ['decision'], rank_terms: ['zzztokenone'] }).length, 0, 'the OLD text no longer ranks — the row was REPLACED, not left alongside a new one');
    assert.equal(store.query({ types: ['decision'], rank_terms: ['zzztokentwo'] }).length, 1, 'the NEW text ranks exactly once');

    callUpdateRecord(store, d.id, { ...d, statement: 'contains zzztokenthree marker', updated_at: '2026-08-22T14:00:00.000Z' });
    assert.equal(store.query({ types: ['decision'], rank_terms: ['zzztokentwo'] }).length, 0, 'the SECOND generation of old text is also gone, not accumulated');
    assert.equal(store.query({ types: ['decision'], rank_terms: ['zzztokenthree'] }).length, 1);
    assert.equal(store.query({ types: ['decision'], cap: 100 }).filter((r) => r.id === d.id).length, 1, 'exactly one live record row for this id — no duplication anywhere in the pipeline');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
