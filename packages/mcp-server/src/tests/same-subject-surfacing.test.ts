// ---------------------------------------------------------------------------
// Spec for SAME-SUBJECT SURFACING ON WRITE (board 7b8ec9a4, decision
// 7e3c66c5-0061-4dc0-bc58-55dac2dad8c0).
//
// TODAY: ruling-type writes (knowledge_create / knowledge_update /
// knowledge_supersede on decision / anti_pattern / research_finding) carry
// no cross-record awareness at all — two active records can assert opposite
// things about the same subject and neither write is ever told about the
// other. THE FIX (spec, not implementation): these three write tools gain a
// `same_subject` disclosure in their response — an array of {id, slug,
// type, title} entries naming OTHER active records (never the writer's own
// lineage, never anything already superseded) that appear to govern the
// same subject as the record just written. The write always SUCCEEDS —
// same_subject is advisory disclosure, never a block.
//
// This file is written BLIND to tools.ts and packages/store/src/index.ts —
// only sibling test files were read for harness conventions and fixture
// shapes: knowledge-preflight.test.ts (the `knowledgePreflight` call idiom,
// used here ONLY to arrange/guard fixture vocabulary richness — preflight
// already exists and is unrelated to same_subject itself),
// knowledge-supersede.test.ts and dead-slug-disclosure.test.ts (harness,
// `knowledgeSupersede`/`knowledgeUpdate` call shapes and return shapes:
// knowledge_create returns `{record, check_skipped}`, knowledge_update
// returns the new record's fields directly/flattened (no `.record`
// wrapper), knowledge_supersede returns some response object of unknown
// exact shape whose disclosure fields were previously only ever asserted
// via JSON.stringify(result) — never a named field — because that tool's
// own response shape was never pinned by a prior blind spec either).
//
// Because the exact envelope shape `same_subject` lands on is genuinely
// unknown (top-level sibling of `record`, e.g. `{record, same_subject}`,
// vs. nested inside the record fields themselves), every assertion below
// goes through `sameSubjectOf()`, which checks both the top level of the
// response and, if absent there, a nested `.record.same_subject` — so the
// test discriminates on the FEATURE (does the array exist and name the
// right things) rather than on a guessed envelope shape.
//
// EXPECTED FAILURE SHAPE ON CURRENT CODE (general): `same_subject` does not
// exist anywhere in any of these responses today. `sameSubjectOf(...)`
// therefore returns `undefined` for every call, and every
// `assert.ok(Array.isArray(list), ...)` below is the line that reports red
// — a clean missing-key assertion failure, never a thrown error or a crash
// (all of knowledge_create / knowledge_update / knowledge_supersede /
// knowledge_preflight already exist and succeed today). Per-test notes below
// call out any deviation from this general shape.
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-same-subject-'));
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

// `same_subject`, wherever it eventually lands, is read defensively: check
// the top level of whatever the write tool returned, and fall back to a
// nested `record.same_subject` if the top level doesn't carry it. Either
// shape satisfies "the response carries a same_subject array" per the spec.
function sameSubjectOf(response: unknown): unknown[] | undefined {
  const r = response as Loose | undefined;
  if (r == null) return undefined;
  if (Array.isArray(r.same_subject)) return r.same_subject as unknown[];
  const rec = r.record as Loose | undefined;
  if (rec && Array.isArray(rec.same_subject)) return rec.same_subject as unknown[];
  return undefined;
}

function idsOf(list: unknown[] | undefined): string[] {
  if (!list) return [];
  return list
    .map((e) => (typeof e === 'string' ? e : (e as Loose | undefined)?.id))
    .filter((x): x is string => typeof x === 'string');
}

// The `knowledgePreflight` idiom, copied from knowledge-preflight.test.ts,
// used ONLY to guard fixture vocabulary richness in AC1 below — it is an
// existing, already-built tool, unrelated to same_subject itself.
function preflight(tools: SterlingTools, text: string): { answerability: string; matches: { id: string }[] } {
  return (
    tools as unknown as { knowledgePreflight: (t: string) => { answerability: string; matches: { id: string }[] } }
  ).knowledgePreflight(text);
}

// ---------------------------------------------------------------------------
// Fixture vocabulary. `SUBJECT_CORE` repeats five distinctive nouns
// (wyvern / armature / clip / socket / chassis) twice in one dense
// sentence; combined with one more occurrence of each in every fixture's
// own title, that reaches the same "title 1x + body 2x = freq 3" recipe
// knowledge-preflight.test.ts's CENTRAL_TITLE/CENTRAL_TRIGGER used to
// deterministically dominate a record's own top-6 vocabulary by raw
// frequency — reused here (not imported) so the preflight guard in AC1
// passes independently of the new same_subject feature.
// ---------------------------------------------------------------------------
const SUBJECT_CORE =
  'Wyvern armature Wyvern armature clip socket clip socket chassis chassis interchange across Heavy and LtMed ' +
  'builds without adapters or custom brackets, covering the full seventeen-bone frame and every fifty-six-socket mounting set.';

function mkDecision(tools: SterlingTools, title: string, statement: string, rationale = 'r'): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale,
  }).record as unknown as Loose;
}

function createDecision(tools: SterlingTools, title: string, statement: string, rationale = 'r'): unknown {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale,
  });
}

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

// ===========================================================================
// 1 — CREATE-SURFACES: creating a second, opposing decision about the same
//     distinctive subject succeeds and its response names the first.
// ===========================================================================

test('AC1 CREATE-SURFACES: knowledge_create of an opposing decision succeeds and its response names the pre-existing active decision on the same subject', () => {
  const { tools, cleanup } = harness();
  try {
    const recA = mkDecision(tools, TITLE_A, STATEMENT_A, RATIONALE_A);

    // Fixture-richness guard (independent of same_subject): the preflight
    // axis floors must already see record A as governing this subject
    // before we rely on the new feature to see it too. This call must
    // PASS TODAY — knowledge_preflight already exists.
    const pf = preflight(tools, `${TITLE_B}: ${STATEMENT_B}`);
    assert.equal(pf.answerability, 'verify_targets', 'fixture guard: preflight must already see record A as governing this subject');
    assert.ok(pf.matches.some((m) => m.id === recA.id), 'fixture guard: preflight names record A specifically');

    const created = createDecision(tools, TITLE_B, STATEMENT_B, RATIONALE_B) as Loose;
    const recB = created.record as Loose;
    assert.equal(recB.status, 'active', 'the opposing create SUCCEEDS — same_subject is disclosure, never a block');
    assert.equal(get(tools, recA.id as string).status, 'active', 'record A is untouched by record B being created');

    const list = sameSubjectOf(created);
    assert.ok(
      Array.isArray(list),
      'EXPECTED RED: same_subject is undefined on today\'s knowledge_create response — this is the failing line until the feature exists'
    );
    const entry = (list as Loose[]).find((e) => e && (e as Loose).id === recA.id);
    assert.ok(entry, 'the same_subject array names record A by id');
    assert.ok('slug' in (entry as Loose), 'entry carries a slug field');
    assert.ok('type' in (entry as Loose), 'entry carries a type field');
    assert.ok('title' in (entry as Loose), 'entry carries a title field');
    assert.equal((entry as Loose).type, 'decision');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 2 — UNRELATED-QUIET: unrelated vocabulary never surfaces the first
//     record. This is a REGRESSION CONTROL — it is expected to hold true
//     both today and after the feature ships (an absent/empty field
//     trivially satisfies "absent or empty").
// ===========================================================================

test('AC2 UNRELATED-QUIET (regression control): creating a decision with entirely unrelated vocabulary never names the pre-existing subject-specific record', () => {
  const { tools, cleanup } = harness();
  try {
    const recA = mkDecision(tools, TITLE_A, STATEMENT_A, RATIONALE_A);

    const created = createDecision(
      tools,
      'Adopt trunk-based branching for the release pipeline',
      'The release pipeline switches from long-lived feature branches to trunk-based development with short-lived branches and feature flags.',
      'Reduces merge conflicts and integration drift.'
    ) as Loose;
    assert.equal((created.record as Loose).status, 'active');

    const list = sameSubjectOf(created);
    const ids = idsOf(list);
    assert.ok(!ids.includes(recA.id as string), 'unrelated vocabulary must never name the Wyvern/armature/chassis record — same_subject is absent, empty, or names something else entirely');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 3 — SELF-LINEAGE-EXCLUDED: updating a record never names its own prior
//     version or its own new self, even while it DOES name a genuinely
//     different, still-active, same-subject record.
// ===========================================================================

test('AC3 SELF-LINEAGE-EXCLUDED: knowledge_update on a decision names a different same-subject record but never its own prior version or itself', () => {
  const { tools, cleanup } = harness();
  try {
    const recA = mkDecision(tools, TITLE_A, STATEMENT_A, RATIONALE_A);
    const recB = mkDecision(tools, TITLE_B, STATEMENT_B, RATIONALE_B);

    const updated = tools.knowledgeUpdate(recA.id as string, { rationale: 'small tweak, subject unchanged' }) as unknown as Loose;
    assert.equal(updated.status, 'active', 'the update succeeds regardless of any same-subject disclosure');
    assert.equal(get(tools, recA.id as string).status, 'superseded', 'the prior version is retired by the update as usual');

    const list = sameSubjectOf(updated);
    assert.ok(
      Array.isArray(list),
      'EXPECTED RED: same_subject is undefined on today\'s knowledge_update response — this is the failing line until the feature exists'
    );
    const ids = idsOf(list);
    assert.ok(ids.includes(recB.id as string), 'the update names the genuinely different, still-active same-subject record B');
    assert.ok(!ids.includes(recA.id as string), 'the update must NEVER name its own prior version (A) in its own supersede chain');
    assert.ok(!ids.includes(updated.id as string), 'the update must NEVER name itself');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 4 — SUPERSEDE-EXCLUDES-OLD: superseding a decision never names the
//     record it just retired, but DOES name a third, unrelated-lineage,
//     still-active record on the same subject.
// ===========================================================================

test('AC4 SUPERSEDE-EXCLUDES-OLD: knowledge_supersede names a third unrelated-lineage same-subject record but never the record it just superseded', () => {
  const { tools, cleanup } = harness();
  try {
    const recC = mkDecision(
      tools,
      'Wyvern armature clip socket chassis audit note',
      `An independent audit of the Wyvern armature clip socket program across Heavy and LtMed chassis. ${SUBJECT_CORE}`,
      'Filed for the quarterly parts review.'
    );
    const recA = mkDecision(tools, TITLE_A, STATEMENT_A, RATIONALE_A);

    const result = tools.knowledgeSupersede(recA.id as string, {
      title: 'Wyvern armature clip socket chassis compatibility ruling (revised)',
      statement: `Revised: ${STATEMENT_A}`,
      alternatives_rejected: [],
      rationale: 'r2',
    }) as unknown as Loose;

    const pinnedOld = get(tools, recA.id as string);
    assert.equal(pinnedOld.status, 'superseded', 'the supersede succeeds regardless of any same-subject disclosure');
    const newId = pinnedOld.superseded_by as string;
    assert.ok(newId, 'the old record forwards to a new active record');
    assert.equal(get(tools, newId).status, 'active');

    const list = sameSubjectOf(result);
    assert.ok(
      Array.isArray(list),
      'EXPECTED RED: same_subject is undefined on today\'s knowledge_supersede response — this is the failing line until the feature exists'
    );
    const ids = idsOf(list);
    assert.ok(ids.includes(recC.id as string), 'the third, unrelated-lineage, still-active record C IS named');
    assert.ok(!ids.includes(recA.id as string), 'the just-superseded old record A must NEVER be named');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 5 — SUPERSEDED-NEVER-SURFACE: a record that is status 'superseded' (here
//     arranged via knowledge_update) must never appear in ANY subsequent
//     same_subject list, even though its own live replacement should.
// ===========================================================================

test('AC5 SUPERSEDED-NEVER-SURFACE: a record superseded via knowledge_update never appears in a later same_subject list; its live replacement does', () => {
  const { tools, cleanup } = harness();
  try {
    const recD = mkDecision(
      tools,
      'Wyvern armature clip socket chassis audit note 2',
      `A second independent audit of the Wyvern armature clip socket program across Heavy and LtMed chassis. ${SUBJECT_CORE}`,
      'Filed for a follow-up review.'
    );
    const recD2 = tools.knowledgeUpdate(recD.id as string, { rationale: 'updated rationale, same subject' }) as unknown as Loose;
    assert.equal(get(tools, recD.id as string).status, 'superseded', 'precondition: D is now retired');
    assert.equal(recD2.status, 'active', 'precondition: D2 is the live head');

    const created = createDecision(tools, TITLE_B, STATEMENT_B, RATIONALE_B) as Loose;
    assert.equal((created.record as Loose).status, 'active');

    const list = sameSubjectOf(created);
    assert.ok(
      Array.isArray(list),
      'EXPECTED RED: same_subject is undefined on today\'s knowledge_create response — this is the failing line until the feature exists'
    );
    const ids = idsOf(list);
    assert.ok(ids.includes(recD2.id as string), 'the live replacement D2 is named');
    assert.ok(!ids.includes(recD.id as string), 'the superseded record D must NEVER appear in any same_subject list');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 6 — NON-BLOCKING invariant: every write kind (create / update / supersede)
//     succeeds in the presence of same-subject conflicts. This is a
//     REGRESSION CONTROL — none of it depends on same_subject existing, so
//     it is expected to pass both today and after the feature ships; it
//     exists to catch an over-reaching implementation that turns
//     disclosure into a block.
// ===========================================================================

test('AC6 NON-BLOCKING (regression control): create, update, and supersede all succeed in the presence of same-subject conflicts', () => {
  const { tools, cleanup } = harness();
  try {
    const recA = mkDecision(tools, TITLE_A, STATEMENT_A, RATIONALE_A);
    assert.equal(get(tools, recA.id as string).status, 'active');

    const created = createDecision(tools, TITLE_B, STATEMENT_B, RATIONALE_B) as Loose;
    const recB = created.record as Loose;
    assert.equal(recB.status, 'active', 'a same-subject CONFLICTING create still succeeds');

    const updatedB = tools.knowledgeUpdate(recB.id as string, { rationale: 'tweaked, still conflicting' }) as unknown as Loose;
    assert.equal(updatedB.status, 'active', 'a same-subject update still succeeds');

    tools.knowledgeSupersede(recA.id as string, {
      title: 'Wyvern armature clip socket chassis compatibility ruling (replaced)',
      statement: `Replaced: ${STATEMENT_A}`,
      alternatives_rejected: [],
      rationale: 'replacement rationale',
    });
    const pinnedA = get(tools, recA.id as string);
    assert.equal(pinnedA.status, 'superseded');
    const newId = pinnedA.superseded_by as string;
    assert.equal(get(tools, newId).status, 'active', 'a same-subject supersede still succeeds and produces an active replacement');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// 7 — CAP: with 7+ active same-subject records already in store, creating
//     an 8th caps its same_subject disclosure at no more than 5 entries.
// ===========================================================================

test('AC7 CAP: same_subject caps its disclosure at no more than 5 entries even when 7+ active records share the subject', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 7; i++) {
      mkDecision(
        tools,
        `Wyvern armature clip socket chassis ruling variant ${i}`,
        `Variant ${i} restates the Wyvern armature clip socket subject across Heavy and LtMed chassis. ${SUBJECT_CORE}`,
        `Variant ${i} rationale.`
      );
    }

    const created = createDecision(
      tools,
      'Wyvern armature clip socket chassis ruling variant 8 (final)',
      `Variant 8 restates the Wyvern armature clip socket subject across Heavy and LtMed chassis. ${SUBJECT_CORE}`,
      'Variant 8 rationale.'
    ) as Loose;
    assert.equal((created.record as Loose).status, 'active', 'the 8th same-subject create still succeeds — the cap bounds disclosure, never the write');

    const list = sameSubjectOf(created);
    assert.ok(
      Array.isArray(list),
      'EXPECTED RED: same_subject is undefined on today\'s knowledge_create response — this is the failing line until the feature exists'
    );
    assert.ok((list as unknown[]).length > 0, 'at least one of the 7 pre-existing same-subject records is disclosed');
    assert.ok((list as unknown[]).length <= 5, 'same_subject is capped — never an unbounded inventory of every matching record');
  } finally {
    cleanup();
  }
});
