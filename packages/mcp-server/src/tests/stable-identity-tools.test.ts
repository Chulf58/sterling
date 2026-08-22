// ---------------------------------------------------------------------------
// S3 FROZEN RED PINS — stable-identity wave, TOOL SURFACE on schema v2
// (decision stable-identity-design-v2 / 2176748e-72f6-4cfc-a790-7fd67c7ee6aa).
// SPEC-ONLY: authored FROM THE DESIGN DECISION + the S3 dispatch contract
// list ALONE, before any of this is wired on SterlingTools. The store layer
// (packages/store) already ships updateRecord/editRecordField/
// appendRecordField/getRecordVersion, record_versions/record_aliases/
// record_relations, and lifecycle+freshness-derived status (S2, committed) —
// this file pins the TOOL CONTRACTS layered on top of those primitives, and
// deliberately does NOT re-pin store-level behavior already covered by
// packages/store/src/tests/stable-identity-write-path.test.ts and
// stable-identity-hardening.test.ts.
//
// TODAY (pre-S3), every knowledge_update/append/edit-shaped tool call still
// routes through the OLD auto-supersede ("re-mint") path for decision /
// anti_pattern / research_finding / feature_article / attestation alike: a
// successful write MINTS A NEW id and marks the addressed record
// 'superseded'. That is the single root cause behind almost every RED below
// (S3-1, S3-3, S3-4, S3-9's "same id after success" half). record_aliases /
// record_relations tables and the store-level primitives exist, but the
// TOOLS layer (SterlingTools) does not yet consult or drive them — that is
// the root cause of S3-5 and S3-6's REDs (knowledge_get/knowledge_update
// silently ignore the version param / never resolve an alias row at all).
//
// A few contract points ask to pin that EXISTING shipped behavior SURVIVES
// the rewiring (points 2, 7's status/derivation half, 8's visibility half).
// Those are marked REGRESSION CONTROL below and may already read GREEN on
// current HEAD — that is expected and correct (mirrors the precedent set by
// dead-slug-disclosure.test.ts's own regression-control tests 1/4/5/6): a
// point that says "pin that X survives" is not required to currently fail,
// only to keep passing after the rewiring. Every other test is annotated
// with its concrete expected-red failure shape inline.
//
// NAMED GAPS (cannot be pinned without inventing semantics the design does
// not state — flagged rather than guessed):
//   (g1) The exact JS parameter POSITION for `expected_version` on the
//        tools-layer knowledge_update/knowledge_append/knowledge_edit is not
//        fixed by any interface slice. resolves-claim.test.ts already froze
//        `knowledgeUpdate(id, patch, resolves?: string[])` as a 3rd
//        positional arg — this file assumes expected_version lands as a 4th
//        trailing positional arg (`knowledgeUpdate(id, patch, resolves,
//        expected_version)`), the least-disruptive extension of the already
//        frozen shape. If the real implementation instead folds it into an
//        options object, these tests still discriminate correctly (the
//        4th positional value is simply ignored today either way, producing
//        the same observable RED), but a coder landing a different exact
//        binding should treat this as documentation, not a spec violation.
//   (g2) knowledge_retire's re-homed relation edge: the design states "retire
//        writes the relation" but names no specific `rel` value (unlike
//        supersede's documented 'supersedes' edge). S3-8b therefore checks
//        only that SOME record_relations row connects the retired id and the
//        survivor id, in either direction — it never asserts a specific
//        `rel` string, so it cannot fail on that unspecified choice.
//   (g3) The exact reported shape for "version is server-owned/read-only" in
//        knowledge_schema is left to the implementation (point 10 says so
//        explicitly). S3-10 pins only the two OBSERVABLE surfaces the point
//        names: `required` never lists version/status/superseded_by, and
//        knowledge_create succeeds without a caller-supplied status/
//        superseded_by envelope.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-22T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-stable-identity-tools-'));
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

// --- tools-layer fixture builders (read from knowledge-supersede.test.ts /
// resolves-claim.test.ts / attestation-immutability.test.ts — the shared
// house convention, not guessed) ------------------------------------------

function mkDecision(tools: SterlingTools, title: string, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement: 'a statement',
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  }).record as unknown as Loose;
}

function mkArticle(tools: SterlingTools, slug: string): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does the thing.',
    intended_behavior: 'behaves as described.',
    files: [{ path: `src/${slug}.ts`, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as Loose;
}

function mkAttestation(tools: SterlingTools, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('attestation', {
    artifact_key: 'part-0042',
    verdict: 'approved',
    inspector: 'jane.doe',
    inspected_at: NOW,
    ...overrides,
  }).record as unknown as Loose;
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

function decisionCount(tools: SterlingTools): number {
  return tools.knowledgeQuery({ types: ['decision'] }).length;
}

type SchemaReport = {
  required: string[];
  optional: string[];
  fields: { name: string; type: string; enum_values?: string[] }[];
};
function schemaOf(tools: SterlingTools, type: string): SchemaReport {
  return (tools as unknown as { knowledgeSchema: (t: string) => SchemaReport }).knowledgeSchema(type);
}

// --- store-level primitives (S2, already committed) used ONLY to arrange
// fixtures that the tools layer cannot yet produce on its own (a genuinely
// in-place, same-id version history). Reused with the same defensive
// "named-failure, never a bare TypeError" adapter S2's own suite uses, since
// this file must never assume tools.ts internals about how it calls them. --

type WriteOpts = { expected_version?: number; resolves?: string[] };

function callStoreUpdateRecord(store: SterlingStore, id: string, patch: Loose, opts?: WriteOpts): Loose {
  const fn = (store as unknown as { updateRecord?: (...a: unknown[]) => unknown }).updateRecord;
  if (typeof fn !== 'function') {
    throw new Error(
      'SterlingStore.updateRecord not found — S2 (committed) was expected to ship this primitive; cannot arrange an in-place version-history fixture without it (stable-identity-design-v2)'
    );
  }
  return fn.call(store, id, patch, opts) as Loose;
}

function envelope(type: string, at = NOW): Loose {
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

function rawDecisionEnvelope(overrides: Loose = {}): Loose {
  return {
    ...envelope('decision'),
    title: 'a raw decision',
    statement: 'v1 archived content',
    alternatives_rejected: [],
    rationale: 'r',
    file_keys: [],
    ...overrides,
  };
}

function rawInsertAlias(store: SterlingStore, historicalId: string, canonicalId: string, archivedVersion: number, createdAt: string): void {
  const s = store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } } };
  s.db
    .prepare('INSERT INTO record_aliases (historical_id, canonical_id, archived_version, created_at) VALUES (?, ?, ?, ?)')
    .run(historicalId, canonicalId, archivedVersion, createdAt);
}

function rawAnyRelationBetween(store: SterlingStore, idA: string, idB: string): unknown[] {
  const s = store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } };
  return s.db
    .prepare(
      'SELECT * FROM record_relations WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)'
    )
    .all(idA, idB, idB, idA);
}

function rawRelation(store: SterlingStore, sourceId: string, rel: string, targetId: string): unknown[] {
  const s = store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } };
  return s.db.prepare('SELECT * FROM record_relations WHERE source_id = ? AND rel = ? AND target_id = ?').all(sourceId, rel, targetId);
}

// --- tools-layer adapters for the two parameters that do not exist on the
// TOOLS class signature yet (knowledge_get's version param, knowledge_update's
// expected_version). Both are cast-through calls — never a "not found" throw,
// because JS silently accepts and ignores extra call-site arguments, so the
// RED here is always on the resulting ASSERTION, never on a TypeError. -----

function callGetAtVersion(tools: SterlingTools, id: string, version: number): Loose {
  return (tools as unknown as { knowledgeGet: (id: string, version?: number) => Loose }).knowledgeGet(id, version);
}

function callUpdateWithExpectedVersion(tools: SterlingTools, id: string, patch: Loose, expectedVersion: number, resolves?: string[]): Loose {
  // (g1) assumed 4th positional slot — see file header.
  return (
    tools as unknown as {
      knowledgeUpdate: (id: string, patch: Loose, resolves?: string[], expectedVersion?: number) => Loose;
    }
  ).knowledgeUpdate(id, patch, resolves, expectedVersion);
}

// ===========================================================================
// CONTRACT POINT 1 — stable id through the tools
// ===========================================================================

test('S3-1a [stable-identity-design-v2]: knowledge_update on a decision returns an echo whose id EQUALS the input id, with version bumped and previous_version carried', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecision(tools, 's3-1a-decision');
    const updated = tools.knowledgeUpdate(d.id as string, { rationale: 'r2' }) as unknown as Loose;

    // EXPECTED RED today: knowledge_update still auto-supersedes, minting a
    // NEW id and leaving d.id superseded — this fails on the id equality.
    assert.equal(updated.id, d.id, 'the id must NEVER change across an ordinary update (stable-identity-design-v2 item 1)');
    assert.equal(updated.version, 2, 'version bumps from 1 to 2');
    assert.equal(updated.previous_version, 1, 'the echo carries previous_version alongside the new version');

    const original = get(tools, d.id as string);
    assert.equal(original.status, 'active', 'the ORIGINAL id is still live and active — no fork, no tombstone left behind');
  } finally {
    cleanup();
  }
});

test('S3-1b [stable-identity-design-v2]: knowledge_update on a feature_article returns an echo whose id EQUALS the input id', () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkArticle(tools, 's3-1b-article');
    const updated = tools.knowledgeUpdate(a.id as string, { what_it_does: 'updated body' }) as unknown as Loose;
    assert.equal(updated.id, a.id, 'EXPECTED RED today: an ordinary feature_article update currently mints a new id (see knowledge-update-stale.test.ts baseline)');
    assert.equal(updated.version, 2);
  } finally {
    cleanup();
  }
});

test('S3-1c [stable-identity-design-v2]: knowledge_update on a research_finding returns an echo whose id EQUALS the input id', () => {
  const { tools, cleanup } = harness();
  try {
    const rf = tools.knowledgeCreate('research_finding', {
      question: 's3-1c question?',
      answer: 'a',
      source_urls: [],
      source_date: '2026-05-20',
      capture_date: '2026-06-01',
    }).record as unknown as Loose;

    const updated = tools.knowledgeUpdate(rf.id as string, { answer: 'a revised' }) as unknown as Loose;
    assert.equal(updated.id, rf.id, 'EXPECTED RED today: research_finding also currently auto-supersedes on update');
    assert.equal(updated.version, 2);
  } finally {
    cleanup();
  }
});

test('S3-1d [stable-identity-design-v2]: knowledge_edit and knowledge_append likewise echo the SAME id and a bumped version', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecision(tools, 's3-1d-decision', { rationale: 'MARKER_TO_EDIT lives here' });
    const edited = tools.knowledgeEdit(d.id as string, 'rationale', 'MARKER_TO_EDIT', 'EDITED') as unknown as { record: Loose };
    assert.equal(edited.record.id, d.id, 'EXPECTED RED today: knowledge_edit delegates to the same auto-supersede update core, minting a new id');
    assert.equal(edited.record.version, 2);

    // test-repair 2026-08-22: the pin read appended.id at the TOP level while
    // reading edited.record.id two lines earlier — an internal inconsistency
    // that forced a redundant receipt spread (shape decision 9c8e4601 had
    // already rejected). The echo's record carries id+version; read it there,
    // consistently. [stable-identity-design-v2]
    const appended = tools.knowledgeAppend(edited.record.id as string, 'alternatives_rejected', [{ option: 'x', reason: 'y' }]) as unknown as { record: Loose };
    assert.equal(appended.record.id, edited.record.id, 'knowledge_append echoes the SAME id — no re-mint');
    assert.equal(appended.record.version, 3);
  } finally {
    cleanup();
  }
});

test('S3-1e [stable-identity-design-v2]: a SECOND knowledge_update keeps the SAME id again — not just the first update', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecision(tools, 's3-1e-decision');
    const v2 = tools.knowledgeUpdate(d.id as string, { rationale: 'r2' }) as unknown as Loose;
    const v3 = tools.knowledgeUpdate(v2.id as string, { rationale: 'r3' }) as unknown as Loose;

    assert.equal(v2.id, d.id, 'EXPECTED RED today: first update already mints a new id');
    assert.equal(v3.id, d.id, 'EXPECTED RED today: a second update must ALSO preserve the original id — never a fresh id per write');
    assert.equal(v3.version, 3, 'version keeps counting on the one stable id');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 2 — EXCEPTION: attestation stays immutable (concept
// replacement survives the rewiring). REGRESSION CONTROL: this is the
// EXISTING shipped shape (attestation-immutability.test.ts, already green);
// pinned here again under the S3 name so a coder cannot "fix" attestation
// into the new same-id path by accident while wiring points 1/3/4/5.
// ===========================================================================

test('S3-2 [stable-identity-design-v2] REGRESSION CONTROL: knowledge_update on an attestation still mints a NEW id and marks the original superseded — the stable-id rewiring does NOT apply to attestation', () => {
  const { tools, cleanup } = harness();
  try {
    const created = mkAttestation(tools, { notes: 'first pass' });
    const originalId = created.id as string;

    const updated = tools.knowledgeUpdate(originalId, { notes: 'follow-up notes' }) as unknown as Loose;
    assert.notEqual(updated.id, originalId, 'attestation keeps concept-replacement semantics: a NEW id every time, never in-place');
    assert.equal(updated.status, 'active');

    const original = get(tools, originalId);
    assert.equal(original.status, 'superseded', 'the original attestation is superseded, exactly as before this wave');
    assert.equal(original.superseded_by, updated.id);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 3 — expected_version CAS through the tool
// ===========================================================================

test('S3-3a [stable-identity-design-v2]: knowledge_update with the CORRECT expected_version succeeds through the tool', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecision(tools, 's3-3a-decision');
    const updated = callUpdateWithExpectedVersion(tools, d.id as string, { rationale: 'r2' }, 1);

    // EXPECTED RED today: expected_version is a positional arg the current
    // signature does not consume at all — the call is indistinguishable from
    // a plain update, which itself mints a NEW id (point 1's root cause), so
    // this fails on the id-equality assertion first.
    assert.equal(updated.id, d.id, 'a correctly-CAS\'d update must still preserve the stable id');
    assert.equal(updated.version, 2);
  } finally {
    cleanup();
  }
});

test('S3-3b [stable-identity-design-v2]: a STALE expected_version through the tool refuses, naming BOTH versions, and the record is fully unchanged', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecision(tools, 's3-3b-decision', { rationale: 'v1' });
    // Advance the real version to 2 without a CAS token.
    tools.knowledgeUpdate(d.id as string, { rationale: 'v2' });

    assert.throws(
      () => callUpdateWithExpectedVersion(tools, d.id as string, { rationale: 'attempted v3 from a stale read' }, 1),
      (err: Error) => {
        assert.match(err.message, /1/, 'names the stale expected version (1)');
        assert.match(err.message, /2/, 'names the actual current version (2)');
        return true;
      },
      'EXPECTED RED today: the extra positional argument is silently ignored, so this call currently SUCCEEDS (and mints a new id under the old core) instead of throwing — assert.throws itself reports the missing exception'
    );

    const head = get(tools, d.id as string);
    assert.equal(head.rationale, 'v2', 'no clobber from the rejected stale write');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 4 — caller-supplied version is stripped, never authoritative
// ===========================================================================

test('S3-4a [stable-identity-design-v2]: knowledge_create with a smuggled version:42 in the payload is server-owned — the created record starts at version 1', () => {
  const { tools, cleanup } = harness();
  try {
    // EXPECTED RED today, one of two shapes: either 'version' is refused as
    // an unknown field for 'decision' (current strict-field validation,
    // mirroring knowledge-supersede.test.ts's own unknown-field refusal
    // tests) — this test then fails on that thrown error — OR it is silently
    // accepted and the caller's 42 lands verbatim, failing the equality
    // assertion below. Either is a legible red for "version is not yet a
    // server-owned universal field."
    const created = tools.knowledgeCreate('decision', {
      title: 's3-4a-decision',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
      version: 42,
    }).record as unknown as Loose;
    assert.equal(created.version, 1, 'the server-owned counter starts at 1 regardless of a caller-forged value');
  } finally {
    cleanup();
  }
});

test('S3-4b [stable-identity-design-v2]: knowledge_update with a smuggled version:42 in the patch never lands — the echo carries the SERVER counter (prior+1), never the caller value', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecision(tools, 's3-4b-decision');
    // EXPECTED RED today: same dual failure shape as S3-4a — either a
    // thrown unknown-field refusal, or (if silently accepted) the caller's
    // 42 landing verbatim rather than the correct server-computed 2.
    const updated = tools.knowledgeUpdate(d.id as string, { rationale: 'r2', version: 42 }) as unknown as Loose;
    assert.equal(updated.version, 2, 'the server computes prior+1 — never the caller-forged value');
    assert.notEqual(updated.version, 42);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 5 — knowledge_get version param
// ===========================================================================

test('S3-5a [stable-identity-design-v2]: knowledge_get(id, version:1) after an update serves the PRE-UPDATE snapshot, not the current head', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecision(tools, 's3-5a-decision', { rationale: 'v1 rationale' });
    tools.knowledgeUpdate(d.id as string, { rationale: 'v2 rationale' });

    const archived = callGetAtVersion(tools, d.id as string, 1);
    // EXPECTED RED today: the version argument is silently ignored, so this
    // call returns whatever the CURRENT head content is (and today that
    // current-head lookup is on a superseded/never-again-served old id
    // besides) — the archived rationale never surfaces.
    assert.equal(archived.rationale, 'v1 rationale', 'version:1 must serve the ORIGINAL pre-update content');
    assert.equal(archived.version, 1);
  } finally {
    cleanup();
  }
});

test('S3-5b [stable-identity-design-v2]: knowledge_get(id, version) for a version number that never existed refuses LOUDLY, naming the version — never a silent latest', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecision(tools, 's3-5b-decision');
    assert.throws(
      () => callGetAtVersion(tools, d.id as string, 999),
      /999/,
      'EXPECTED RED today: the version argument is ignored, so this call silently succeeds and returns the current (v1) record instead of refusing — assert.throws reports the missing exception'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 6 — legacy_resolution via record_aliases
// ===========================================================================

test('S3-6a [stable-identity-design-v2]: knowledge_get on a raw-aliased historical id returns the ARCHIVED snapshot plus a legacy_resolution block naming canonical_id/archived_version/current_version', () => {
  const { store, tools, cleanup } = harness();
  try {
    // Arrange entirely through the already-shipped STORE primitives (S2) —
    // never through the tools layer's not-yet-stable-id update path.
    const canonical = store.create(rawDecisionEnvelope({ statement: 'v1 archived content' }));
    const bumped = callStoreUpdateRecord(store, canonical.id as string, { ...canonical, statement: 'v2 current content' });
    assert.equal(bumped.id, canonical.id, 'sanity: the store-level primitive is already in-place (S2, committed)');
    assert.equal(bumped.version, 2, 'sanity: the canonical head is now at version 2');

    const historicalId = randomUUID(); // a pre-migration id nothing else carries
    rawInsertAlias(store, historicalId, canonical.id as string, 1, NOW);

    // EXPECTED RED today: SterlingTools.knowledgeGet has no awareness of
    // record_aliases at all — historicalId resolves to nothing in the
    // records table, so this throws the ordinary "unresolved identifier"
    // refusal rather than returning anything.
    let resolved: Loose | undefined;
    assert.doesNotThrow(() => {
      resolved = tools.knowledgeGet(historicalId) as unknown as Loose;
    }, 'a raw-aliased historical id must resolve, not throw "no such record"');

    assert.ok(resolved, 'sanity: the assignment above ran');
    assert.equal(resolved!.statement, 'v1 archived content', 'serves the ARCHIVED version-1 snapshot, not the current head');

    const legacy = resolved!.legacy_resolution as { canonical_id: string; archived_version: number; current_version: number } | undefined;
    assert.ok(legacy, 'carries a legacy_resolution block');
    assert.equal(legacy!.canonical_id, canonical.id, 'names the canonical id');
    assert.equal(legacy!.archived_version, 1, 'names the archived version served');
    assert.equal(legacy!.current_version, 2, 'names the canonical record\'s CURRENT version, for the reader to know they are behind');
  } finally {
    cleanup();
  }
});

test('S3-6b [stable-identity-design-v2]: a WRITE tool (knowledge_update) addressed at a raw-aliased historical id REFUSES, naming the canonical id', () => {
  const { store, tools, cleanup } = harness();
  try {
    const canonical = store.create(rawDecisionEnvelope({ statement: 'v1 archived content' }));
    callStoreUpdateRecord(store, canonical.id as string, { ...canonical, statement: 'v2 current content' });

    const historicalId = randomUUID();
    rawInsertAlias(store, historicalId, canonical.id as string, 1, NOW);

    assert.throws(
      () => tools.knowledgeUpdate(historicalId, { rationale: 'should never land' }),
      new RegExp(escapeRegex(canonical.id as string)),
      'EXPECTED RED today: knowledge_update does not consult record_aliases at all, so it throws the ordinary "unresolved identifier" refusal naming the HISTORICAL id (or nothing useful), never the canonical id this test requires'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 7 — knowledge_supersede re-homed onto record_relations
// ===========================================================================

test('S3-7a [stable-identity-design-v2]: after knowledge_supersede, the successor\'s served links[] carries the supersedes edge, and the old record derives status/superseded_by from it', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 's3-7a-old');
    const result = tools.knowledgeSupersede(old.id as string, {
      title: 's3-7a-new',
      statement: 'replacement statement',
      alternatives_rejected: [],
      rationale: 'r2',
    }) as unknown as Loose;

    const pinnedOld = get(tools, old.id as string);
    const newId = pinnedOld.superseded_by as string;
    assert.ok(newId, 'sanity: the old record forwards to a new id (already-shipped supersede behavior)');

    const newRec = get(tools, newId);
    const links = (newRec.links as { rel: string; target_id: string }[] | undefined) ?? [];
    assert.ok(
      links.some((l) => l.rel === 'supersedes' && l.target_id === old.id),
      "the successor's served links[] must carry the supersedes edge, materialized from record_relations (relation-backed, per stable-identity-design-v2 item 4)"
    );

    assert.equal(pinnedOld.status, 'superseded', 'REGRESSION CONTROL: the old record still serves status superseded');
    assert.equal(pinnedOld.superseded_by, newId, 'REGRESSION CONTROL: superseded_by still forwards to the successor');
    void result;
  } finally {
    cleanup();
  }
});

test('S3-7b [stable-identity-design-v2] REGRESSION CONTROL: knowledge_supersede\'s orphan detection still fires over enumerated rulings the new fields leave uncovered', () => {
  const { tools, cleanup } = harness();
  try {
    const rulingStatement =
      '1. The BigRocket parts attach to the heavy mount. 2. The Flak parts are assigned by projectile category.';
    const old = mkDecision(tools, 's3-7b-old', { statement: rulingStatement });
    const before = decisionCount(tools);

    assert.throws(
      () =>
        tools.knowledgeSupersede(old.id as string, {
          title: 's3-7b-new',
          statement: 'The BigRocket parts attach to the heavy mount, confirmed and unchanged.',
          alternatives_rejected: [],
          rationale: 'r2',
        }),
      /Flak|orphans_acknowledged/i,
      'the orphan-detection guard must survive the relations rewiring — an uncovered ruling still refuses'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the orphan refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 8 — knowledge_retire re-homed onto record_relations
// ===========================================================================

test('S3-8a [stable-identity-design-v2] REGRESSION CONTROL: after knowledge_retire, the retired record stops being served by knowledge_query, but knowledge_get(id) still resolves it', () => {
  const { tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 's3-8a-dupe');
    const survivor = mkDecision(tools, 's3-8a-survivor');
    const before = decisionCount(tools);

    (tools as unknown as { knowledgeRetire: (id: string, inFavorOf: string) => unknown }).knowledgeRetire(dupe.id as string, survivor.id as string);

    const served = tools.knowledgeQuery({ types: ['decision'] }) as unknown as Loose[];
    assert.ok(served.every((r) => r.id !== dupe.id), 'the retired record stops being served');
    assert.equal(served.length, before - 1, 'served count drops by one — no new row minted');

    const pinned = get(tools, dupe.id as string);
    assert.equal(pinned.status, 'superseded', 'knowledge_get(id) still resolves the retired record');
    assert.equal(pinned.superseded_by, survivor.id);
  } finally {
    cleanup();
  }
});

test('S3-8b [stable-identity-design-v2]: knowledge_retire writes a record_relations edge connecting the retired id and the survivor (g2: exact rel value unspecified by the design, not asserted)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 's3-8b-dupe');
    const survivor = mkDecision(tools, 's3-8b-survivor');

    (tools as unknown as { knowledgeRetire: (id: string, inFavorOf: string) => unknown }).knowledgeRetire(dupe.id as string, survivor.id as string);

    // EXPECTED RED today: the pre-S3 retireInFavorOf path (as exercised
    // through the tools layer) does not write into record_relations at all —
    // superseded_by is a stored column, not a relation edge — so this query
    // returns zero rows.
    const rows = rawAnyRelationBetween(store, dupe.id as string, survivor.id as string);
    assert.ok(rows.length > 0, 'retire must be RE-HOMED onto record_relations: some row must connect the retired id and the survivor');
  } finally {
    cleanup();
  }
});

test('S3-8c [stable-identity-design-v2] REGRESSION CONTROL: knowledge_retire still refuses in_favor_of naming an already-superseded (tombstoned) survivor', () => {
  const { tools, cleanup } = harness();
  try {
    const a = mkDecision(tools, 's3-8c-a');
    // test-repair 2026-08-22: knowledge_update now mutates IN PLACE under the
    // stable-id model (id stable, version bump) and no longer tombstones the
    // record — only knowledge_supersede/knowledge_retire mint a tombstone.
    // Build the precondition via a real supersede so `a` is genuinely
    // superseded, matching what this refusal must still reject. [stable-identity-design-v2]
    tools.knowledgeSupersede(a.id as string, {
      title: 's3-8c-a-v2',
      statement: 'v2 via knowledge_supersede',
      alternatives_rejected: [],
      rationale: 'r2',
    });
    assert.equal(get(tools, a.id as string).status, 'superseded', 'precondition: a is now a tombstone');

    const b = mkDecision(tools, 's3-8c-b');
    assert.throws(
      () => (tools as unknown as { knowledgeRetire: (id: string, inFavorOf: string) => unknown }).knowledgeRetire(b.id as string, a.id as string),
      /superseded|tombstone|active/i,
      'in_favor_of must still be a LIVE record — this refusal must survive the relations rewiring'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 9 — write + resolves is atomic THROUGH THE TOOL
// ===========================================================================

test('S3-9a [stable-identity-design-v2]: a successful knowledge_update carrying a VALID resolves claim preserves the stable id (rides the single write, not a post-hoc drain)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 's3-9a-article');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 's3-9a-article'`,
      file_keys: [`src/s3-9a-article.ts`],
      feature_link: article.id as string,
    });

    const updated = tools.knowledgeUpdate(article.id as string, { what_it_does: 'reconciled' }, [item.id]) as unknown as Loose;

    // EXPECTED RED today: this write currently mints a NEW id under the old
    // auto-supersede core, even though the resolves claim itself already
    // drains correctly (proven green elsewhere by resolves-claim.test.ts).
    assert.equal(updated.id, article.id, 'the id must stay stable even on a write that also claims maintenance debt');
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).some((t: Loose) => t.id === item.id), false, 'the claimed item still drains');
  } finally {
    cleanup();
  }
});

test('S3-9b [stable-identity-design-v2] REGRESSION CONTROL: a knowledge_update carrying resolves with ONE invalid item id refuses AND the record is fully unchanged AND a valid item named alongside stays open', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 's3-9b-article');
    const { record: validItem } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 's3-9b-article'`,
      file_keys: [`src/s3-9b-article.ts`],
      feature_link: article.id as string,
    });
    const bogusId = randomUUID();
    const before = get(tools, article.id as string);

    assert.throws(
      () => tools.knowledgeUpdate(article.id as string, { what_it_does: 'x' }, [validItem.id, bogusId]),
      new RegExp(escapeRegex(bogusId)),
      'a resolves claim naming a nonexistent item refuses, naming it'
    );

    const after = get(tools, article.id as string);
    assert.equal(after.id, before.id, 'the record identity is unaffected by the rolled-back write');
    assert.equal(after.version, before.version, 'no version bump on the refused write — the whole write rolled back, not just the record fields');
    assert.equal(after.what_it_does, before.what_it_does, 'no partial content change');
    assert.ok(
      tools.maintenanceQuery({ cap: 1000 }).some((t: Loose) => t.id === validItem.id),
      'the OTHER, genuinely valid item named in the same claim is STILL OPEN — atomicity, not partial drain'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTRACT POINT 10 — knowledge_schema reports the v2 shape
// ===========================================================================

test('S3-10a [stable-identity-design-v2]: knowledge_schema(\'decision\') reports a "version" field, never listed as caller-required', () => {
  const { tools, cleanup } = harness();
  try {
    const schema = schemaOf(tools, 'decision');
    // EXPECTED RED today: 'decision' has no version field at all pre-v2 —
    // the .find below returns undefined, failing the assert.ok.
    const versionField = schema.fields.find((f) => f.name === 'version');
    assert.ok(versionField, 'the universal server-owned version field must be reported for every type, per stable-identity-design-v2 item 1');
    assert.ok(!schema.required.includes('version'), 'version is never caller-required — it is server-owned');
  } finally {
    cleanup();
  }
});

test('S3-10b [stable-identity-design-v2]: knowledge_schema(\'decision\').required never lists status or superseded_by as caller-required (g3: the schema surface for read-only-ness is otherwise left to the implementation)', () => {
  const { tools, cleanup } = harness();
  try {
    const schema = schemaOf(tools, 'decision');
    assert.ok(!schema.required.includes('status'), 'status is server/lifecycle-derived, never caller-required');
    assert.ok(!schema.required.includes('superseded_by'), 'superseded_by is server/relation-derived, never caller-required');
  } finally {
    cleanup();
  }
});

test('S3-10c [stable-identity-design-v2] REGRESSION CONTROL: knowledge_create accepts a decision envelope WITHOUT status or superseded_by supplied by the caller', () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('decision', {
      title: 's3-10c-decision',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    }).record as unknown as Loose;
    assert.equal(created.status, 'active', 'status is set server-side without the caller ever supplying it');
  } finally {
    cleanup();
  }
});
