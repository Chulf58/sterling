// ---------------------------------------------------------------------------
// HARDENING pins for SAME-SUBJECT SURFACING ON WRITE (board 7b8ec9a4, decision
// 7e3c66c5-0061-4dc0-bc58-55dac2dad8c0). The base spec lives in
// same-subject-surfacing.test.ts (harness, fixture vocabulary, and the
// `sameSubjectOf()` dual-shape reader are copied/adapted from there — this
// file does not import that file, per test-writer convention of not
// depending on a sibling spec file's internals).
//
// This file adds three pins the base spec does not cover:
//   1. WIRE-SURVIVES-UPDATE — same_subject must land somewhere the eventual
//      digest/receipt projection of a write result cannot strip it from,
//      i.e. it must be readable directly off whatever knowledgeUpdate()
//      returns (a top-level property of that return value — there is no
//      separate `knowledgeUpdateResult`-shaped method on SterlingTools:
//      only `knowledgeUpdate`, `knowledgeCreate`, `knowledgeSupersede`,
//      `knowledgeGet` were found callable in every sibling spec file read
//      for this file — knowledge-preflight.test.ts, dead-slug-disclosure.
//      test.ts, same-subject-surfacing.test.ts. No such method was located
//      by name anywhere in the tree, so this file pins the documented
//      fallback: the return of `knowledgeUpdate` itself must carry
//      same_subject, and — the other half of the same pin — the STORED
//      record fetched back via `knowledge_get` must never carry that key.
//   2. NEVER-PERSISTED — across create / update / supersede, no involved
//      record, refetched via knowledge_get, ever carries a `same_subject`
//      key. This is a persistence-boundary regression control: same_subject
//      is advisory disclosure attached to a write's RESPONSE only, never a
//      stored field.
//   3. NON-RULING-QUIET — a feature_article update (feature_article is not
//      one of the three ruling types: decision / anti_pattern /
//      research_finding) must carry no same_subject key anywhere in its
//      response, top-level or nested.
//
// EXPECTED FAILURE SHAPE (general, pre-fix): same_subject does not exist
// anywhere in any knowledge_create/update/supersede response today, so every
// `Array.isArray(...)` assertion below that expects it to exist is the line
// that reports red — a clean missing-key/false assertion, never a crash (all
// of knowledge_create/update/supersede/get already exist and succeed today).
// Per-test notes call out where a test is instead a regression control that
// is expected GREEN both before and after the fix.
//
// NOTE: this file is written blind to tools.ts / store/src/index.ts (H4).
// If the same_subject fixer has already landed by the time this runs, tests
// 1 may already be green — see the handoff for the reported status.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-20T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-same-subject-wire-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

// Top-level-only reader: per the WIRE-SURVIVES-UPDATE pin, same_subject must
// be readable directly off the value knowledgeUpdate() returns (that value
// IS the flattened record's own fields, per sibling harness notes — there is
// no `.record` wrapper on knowledgeUpdate's return, unlike knowledgeCreate).
function topLevelSameSubject(response: unknown): unknown[] | undefined {
  const r = response as Loose | undefined;
  if (r == null) return undefined;
  return Array.isArray(r.same_subject) ? (r.same_subject as unknown[]) : undefined;
}

// Dual-shape reader (top level OR nested under .record), used only for the
// NON-RULING-QUIET pin, which must find same_subject NOWHERE at all.
function hasSameSubjectAnywhere(response: unknown): boolean {
  const r = response as Loose | undefined;
  if (r == null) return false;
  if ('same_subject' in r) return true;
  const rec = r.record as Loose | undefined;
  return !!rec && 'same_subject' in rec;
}

function idsOf(list: unknown[] | undefined): string[] {
  if (!list) return [];
  return list
    .map((e) => (typeof e === 'string' ? e : (e as Loose | undefined)?.id))
    .filter((x): x is string => typeof x === 'string');
}

// Fixture vocabulary copied verbatim from same-subject-surfacing.test.ts —
// the exact "title 1x + body 2x" recipe that file's own AC1 uses to
// deterministically clear whatever same-subject detection floor the feature
// applies (reusing rather than inventing new vocabulary avoids a false red
// caused merely by insufficient fixture overlap).
const SUBJECT_CORE =
  'Wyvern armature Wyvern armature clip socket clip socket chassis chassis interchange across Heavy and LtMed ' +
  'builds without adapters or custom brackets, covering the full seventeen-bone frame and every fifty-six-socket mounting set.';

const TITLE_A = 'Wyvern armature clip socket chassis compatibility ruling';
const STATEMENT_A =
  'The seventeen-bone Wyvern armature family shares fifty-six interchangeable clip sockets across Heavy and ' +
  `LtMed chassis. ${SUBJECT_CORE}`;
const RATIONALE_A = 'Standardizing the Wyvern armature clip socket across Heavy and LtMed chassis reduces part count.';

const TITLE_B = 'Wyvern armature clip socket chassis incompatibility ruling';
const STATEMENT_B =
  'The seventeen-bone Wyvern armature family does NOT share interchangeable clip sockets across Heavy and LtMed ' +
  `chassis — each chassis requires its own dedicated fifty-six-socket set. ${SUBJECT_CORE}`;
const RATIONALE_B = 'Chassis-specific Wyvern armature clip sockets are required because Heavy and LtMed frames differ structurally.';

function mkDecision(tools: SterlingTools, title: string, statement: string, rationale = 'r'): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale,
  }).record as unknown as Loose;
}

// ===========================================================================
// 1 — WIRE-SURVIVES-UPDATE
// ===========================================================================

test('WIRE-SURVIVES-UPDATE: knowledge_update response exposes same_subject at the top level, and the stored record never carries the key', () => {
  const { tools, cleanup } = harness();
  try {
    const recA = mkDecision(tools, TITLE_A, STATEMENT_A, RATIONALE_A);
    const recB = mkDecision(tools, TITLE_B, STATEMENT_B, RATIONALE_B);

    const updated = tools.knowledgeUpdate(recA.id as string, {
      rationale: 'tweaked, still same subject as B',
    }) as unknown as Loose;
    assert.equal(updated.status, 'active', 'the update succeeds regardless of any same-subject disclosure');

    const list = topLevelSameSubject(updated);
    assert.ok(
      Array.isArray(list),
      "EXPECTED RED (pre-fix): same_subject is undefined at the top level of today's knowledge_update return — this is the failing line until the wiring exists"
    );
    const ids = idsOf(list);
    assert.ok(ids.includes(recB.id as string), 'the update response names the still-active same-subject sibling B');

    // The other half of the pin: whatever landed on the in-memory response
    // must NEVER be a field of the STORED record. Re-fetch through
    // knowledge_get (a fresh read, not the write's own return value) and
    // assert the key is simply absent — this is expected GREEN both before
    // and after the fix; it exists to catch an implementation that persists
    // same_subject onto the record row instead of attaching it only to the
    // write response.
    const stored = get(tools, updated.id as string);
    assert.ok(!('same_subject' in stored), 'the STORED record, re-fetched via knowledge_get, must never carry a same_subject key');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 2 — NEVER-PERSISTED across create / update / supersede
// ===========================================================================

test('NEVER-PERSISTED: after create, update, and supersede with same-subject conflicts, knowledge_get on every involved id shows no same_subject key', () => {
  const { tools, cleanup } = harness();
  try {
    const recA = mkDecision(tools, TITLE_A, STATEMENT_A, RATIONALE_A);
    const createdB = tools.knowledgeCreate('decision', {
      title: TITLE_B,
      statement: STATEMENT_B,
      alternatives_rejected: [],
      rationale: RATIONALE_B,
    }) as unknown as Loose;
    const recB = createdB.record as Loose;

    const recA2 = tools.knowledgeUpdate(recA.id as string, { rationale: 'tweak, still conflicting' }) as unknown as Loose;

    const supersedeResult = tools.knowledgeSupersede(recB.id as string, {
      title: 'Wyvern armature clip socket chassis incompatibility ruling (revised)',
      statement: `Revised: ${STATEMENT_B}`,
      alternatives_rejected: [],
      rationale: 'r2',
    }) as unknown as Loose;
    const pinnedOldB = get(tools, recB.id as string);
    const newBId = pinnedOldB.superseded_by as string;
    assert.ok(newBId, 'precondition: the supersede produced a new active head for B');

    // Every id that has been a party to any of the above writes.
    const involvedIds = [recA.id as string, recA2.id as string, recB.id as string, newBId];
    for (const id of involvedIds) {
      const stored = get(tools, id);
      assert.ok(!('same_subject' in stored), `stored record ${id} must never carry a same_subject key`);
    }
    // The write RESPONSES themselves are not re-asserted here (that is
    // covered by AC1/AC3/AC4 in same-subject-surfacing.test.ts and by
    // WIRE-SURVIVES-UPDATE above); this test's entire purpose is the
    // storage boundary, so it only reads back through knowledge_get.
    void supersedeResult;
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 3 — NON-RULING-QUIET
// ===========================================================================

test('NON-RULING-QUIET: a feature_article update response carries no same_subject key anywhere, top-level or nested', () => {
  const { tools, cleanup } = harness();
  try {
    const created = tools.knowledgeCreate('feature_article', {
      slug: 'wyvern-armature-clip-socket-docs',
      title: 'Wyvern armature clip socket chassis interchange — owning article',
      what_it_does: `Documents the Wyvern armature clip socket chassis interchange program. ${SUBJECT_CORE}`,
      intended_behavior: 'Describes current interchange behavior across Heavy and LtMed chassis.',
      files: [{ path: 'src/wyvern.ts', role: 'impl' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    }) as unknown as Loose;
    const article = created.record as Loose;

    // A same-subject decision exists too, so if the implementation ever
    // over-reaches beyond the three ruling types, this fixture gives it
    // something to (wrongly) surface.
    mkDecision(tools, TITLE_A, STATEMENT_A, RATIONALE_A);

    const updated = tools.knowledgeUpdate(article.id as string, {
      what_it_does: `Documents the Wyvern armature clip socket chassis interchange program (updated). ${SUBJECT_CORE}`,
    }) as unknown as Loose;
    assert.equal(updated.state, 'active', 'the feature_article update succeeds');

    assert.ok(
      !hasSameSubjectAnywhere(updated),
      'a non-ruling-type (feature_article) write response must carry no same_subject key at all — same_subject is scoped to decision/anti_pattern/research_finding only'
    );
  } finally {
    cleanup();
  }
});
