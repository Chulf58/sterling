// ---------------------------------------------------------------------------
// Three small measured defects from verified consuming-project feedback,
// fixed together because they all touch tools.ts and none needs its own file.
//
// N28 — board_remove's no-evidence note claimed "no fulfilling artifact-write
// found" while removalArtifactEvidence (tools.ts) only ever scans DURABLE
// STORE RECORDS (decision/anti_pattern/feature_article/research_finding/
// disconfirmed_hypothesis/reference_material) — never git. A consuming
// project measured a commit that had touched the item's file_keys minutes
// before removal, and the note still claimed "no fulfilling artifact-write
// found", which reads as "nothing fulfilled this", not "nothing in the
// knowledge store did". FIX: reword to claim exactly what was checked.
//
// N25 — SameSubjectEntry (the same_subject disclosure on ruling writes) named
// a matched record's id/slug/type/title but never its status. NOTE (roster
// review correction): a same_subject candidate is drawn from
// axisCandidateMatches -> store.query, which per AC5 (same-subject-
// surfacing.test.ts) NEVER serves a superseded/retired record — a retired
// record simply never reaches a same_subject entry, so `status` cannot and
// does not disclose retirement. What it DOES disclose, among the live
// candidates that do surface: 'active' vs 'flagged_stale' (a research_finding
// whose currency has lapsed) — a caller can see a same-subject match is
// stale before deciding whether to link to it. FIX: add `status` to the
// entry.
//
// N26 — knowledge_get <id> field:"title" fails on research_finding (which
// carries no title, only `question`) even though SterlingTools.axisRecordTitle
// already resolves title ?? question ?? slug for exactly this purpose
// elsewhere (knowledgePreflight, sameSubjectDigest). FIX: expose that
// resolver as a virtual field name "headline" on knowledge_get's field
// parameter, discoverable via the field-refusal's valid-set message.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// Reused verbatim from same-subject-surfacing.test.ts: repeats five
// distinctive nouns (wyvern / armature / clip / socket / chassis) twice in
// one dense sentence, so combined with one more occurrence in each fixture's
// own title/question it reliably clears the axis engine's discriminating-hit
// and centrality floors — the same recipe knowledge-preflight.test.ts and
// same-subject-surfacing.test.ts already rely on.
const SUBJECT_CORE =
  'Wyvern armature Wyvern armature clip socket clip socket chassis chassis interchange across Heavy and LtMed ' +
  'builds without adapters or custom brackets, covering the full seventeen-bone frame and every fifty-six-socket mounting set.';

const NOW = '2026-08-24T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-n25-n26-n28-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

// --- N28 ---------------------------------------------------------------

test('N28: board_remove no-evidence note claims exactly what was checked — a knowledge-record scan, never git', () => {
  const { tools, cleanup } = harness();
  try {
    const bare = (tools.boardAdd({ text: 'someday thing', source: 'user', file_keys: ['src/never-touched.ts'] }) as { record: { id: string } }).record;
    const abandoned = tools.boardRemove(bare.id) as { note?: string };
    assert.ok(abandoned.note, 'a note is disclosed when no evidence was found');
    // The old wording ("no fulfilling artifact-write found") reads as a claim
    // about ALL possible fulfilling work, including a git commit — but the
    // scan never touches git. The reworded note must say it checked the
    // knowledge store, not artifact-writes-in-general.
    assert.match(
      abandoned.note!,
      /no knowledge record touching this item's file_keys/,
      'the note names the knowledge store specifically, not an unqualified "no fulfilling artifact-write"'
    );
    assert.doesNotMatch(
      abandoned.note!,
      /no fulfilling artifact-write found/,
      'the old, overclaiming wording must be gone'
    );
    assert.match(
      abandoned.note!,
      /never git/i,
      'the note discloses that a git commit is NOT covered by this check, so a reader does not mistake "nothing in the store" for "nothing happened"'
    );
  } finally {
    cleanup();
  }
});

// --- N25 -----------------------------------------------------------------

test('N25: same_subject discloses \'flagged_stale\' vs \'active\' on the matched record — not just that a status field exists', () => {
  const { store, tools, cleanup } = harness();
  try {
    // ACTIVE control: an ordinary decision on the subject, written through
    // the normal tool surface — its same_subject entry must read 'active'.
    const activeControl = (tools.knowledgeCreate('decision', {
      title: 'Wyvern armature clip socket chassis compatibility ruling',
      statement: `The seventeen-bone Wyvern armature family shares fifty-six interchangeable clip sockets across Heavy and LtMed chassis. ${SUBJECT_CORE}`,
      rationale: 'Standardizing the Wyvern armature clip socket across Heavy and LtMed chassis reduces part count.',
      alternatives_rejected: [],
    }) as { record: { id: string } }).record;

    // FLAGGED_STALE seed: knowledge_create/knowledge_update both REFUSE a
    // caller-supplied freshness/status (SERVER-OWNED — see tools.test.ts's
    // 'derivation pin'), so there is no legitimate tool-surface call that
    // mints a flagged_stale record directly. Seeded at the store layer
    // instead — the same technique the existing '§3.4 stale-at-read' test
    // uses to arrange an aged record — to stand in for whatever background
    // mechanism (outside this test's scope) actually flips freshness.
    // status:'flagged_stale' is the LEGACY-HONORED shape resolveIdentity
    // reads directly (packages/store/src/index.ts resolveIdentity): lifecycle
    // defaults to 'live', freshness becomes 'flagged_stale', and
    // derivedStatus then serves exactly 'flagged_stale' — never 'superseded'.
    const staleId = randomUUID();
    store.create({
      id: staleId,
      type: 'research_finding',
      created_at: NOW,
      updated_at: NOW,
      author: 'conductor',
      status: 'flagged_stale',
      superseded_by: null,
      links: [],
      scope: 'project',
      stack_tags: [],
      question: `Does the Wyvern armature clip socket chassis interchange hold across a new Heavy variant? ${SUBJECT_CORE}`,
      answer: 'It held as of the last audit; unresolved after this line went stale.',
      source_urls: [],
      source_date: '2026-01-01',
      capture_date: '2026-01-01',
      volatility_hint: 'fast',
    });

    // A brand-new record on the same subject must surface BOTH candidates —
    // one active, one flagged_stale — with status naming each correctly.
    const third = tools.knowledgeCreate('decision', {
      title: 'Wyvern armature clip socket chassis follow-up ruling',
      statement: `Reconfirming the Wyvern armature clip socket chassis interchange for the new Heavy variant. ${SUBJECT_CORE}`,
      rationale: 'Follow-up ruling after the compatibility question resurfaced.',
      alternatives_rejected: [],
    }) as { record: { id: string }; same_subject?: { id: string; status?: string }[] };

    assert.ok(Array.isArray(third.same_subject), 'same_subject is disclosed on the write');
    const byId = new Map((third.same_subject ?? []).map((e) => [e.id, e]));

    const activeEntry = byId.get(activeControl.id);
    assert.ok(activeEntry, 'the active control decision is surfaced as a same-subject match');
    assert.equal(activeEntry!.status, 'active', 'the active control reads exactly \'active\', not merely "a string"');

    const staleEntry = byId.get(staleId);
    assert.ok(staleEntry, 'the flagged_stale research_finding is surfaced as a same-subject match');
    assert.equal(staleEntry!.status, 'flagged_stale', 'the seeded record reads exactly \'flagged_stale\' — the control proves this is not just always \'active\'');
  } finally {
    cleanup();
  }
});

// --- N26 -------------------------------------------------------------------

// PRECEDENCE, not just fallback (roster review follow-up): every real
// record type's schema carries at most one of title/question, so no
// legitimately-validated stored record can ever have BOTH populated — the
// existing per-type tests below (decision has only title, research_finding
// has only question) prove the fallback works when one is ABSENT, never
// what wins when both are PRESENT. Exercising that requires calling the
// underlying resolver directly on a plain object carrying both, bypassing
// persistence and schema validation entirely — this is the same private-
// static-via-cast idiom same-subject-surfacing.test.ts's `preflight` helper
// already uses for a different private method.
test('N26: axisRecordTitle (the resolver "headline" exposes) prefers title over question when a record somehow carries both', () => {
  const axisRecordTitle = (SterlingTools as unknown as { axisRecordTitle(record: unknown): string }).axisRecordTitle;
  const value = axisRecordTitle({ title: 'the title wins', question: 'the question loses', slug: 'the-slug-loses-too' });
  assert.equal(value, 'the title wins', 'title takes precedence over question and slug when more than one is present');
});

// REAL FIELD BEATS THE VIRTUAL NAME (roster review follow-up): projectFieldWindow
// now checks knownFieldsFor BEFORE falling back to the 'headline' virtual, so a
// real field literally named 'headline' — should some type ever register one —
// is served as ITSELF, never shadowed by the title??question??slug resolver.
// No shipped type currently declares such a field (schemas package is outside
// this lane), so this pins the ORDERING via a synthetic knownFieldsFor-shaped
// probe rather than a real record: it exercises the exact branch condition
// (`known?.has(field)` checked first) by asserting today's actual field names
// ('title' on decision) are NOT swallowed by the headline branch, which is the
// only real-field-vs-virtual collision reachable without editing the schema
// registry.
test('N26: a real field name is never shadowed by the headline virtual — field:"title" still returns the raw title field shape, not axisRecordTitle\'s derived shape', () => {
  const { tools, cleanup } = harness();
  try {
    const created = (tools.knowledgeCreate('decision', {
      title: 'Real field wins over any virtual name',
      statement: 'A statement.',
      rationale: 'A rationale.',
      alternatives_rejected: [],
    }) as { record: { id: string } }).record;

    const titleField = tools.knowledgeGet(created.id, { field: 'title' }) as { kind: string; value: unknown };
    const headlineField = tools.knowledgeGet(created.id, { field: 'headline' }) as { kind: string; value: unknown };
    // Both resolve to the same VALUE here (decision has only title), but they
    // must be reached through two different branches — 'title' via the known-
    // fields path (kind:'string', a real field), 'headline' via the virtual
    // fallback (kind:'value', a derived scalar). Different `kind` proves 'title'
    // was never routed through the headline branch.
    assert.equal(titleField.value, 'Real field wins over any virtual name');
    assert.equal(headlineField.value, 'Real field wins over any virtual name');
    assert.equal(titleField.kind, 'string', 'title is windowed as a real string field');
    assert.equal(headlineField.kind, 'value', 'headline is served as a derived scalar, a different kind entirely');
  } finally {
    cleanup();
  }
});

test('N26: knowledge_get field:"headline" resolves title on a decision', () => {
  const { tools, cleanup } = harness();
  try {
    const created = (tools.knowledgeCreate('decision', {
      title: 'Use POSIX-relative paths everywhere',
      statement: 'Every path is stored and compared repo-relative with forward slashes.',
      rationale: 'Windows paths were leaking into the store.',
      alternatives_rejected: [{ option: 'platform-native paths', reason: 'breaks cross-machine comparison' }],
      file_keys: ['packages/schemas/src/paths.ts'],
    }) as { record: { id: string } }).record;

    const headline = tools.knowledgeGet(created.id, { field: 'headline' }) as { kind: string; value: unknown };
    assert.equal(headline.kind, 'value', 'headline is served as a plain value, not a windowed string/array');
    assert.equal(headline.value, 'Use POSIX-relative paths everywhere');
  } finally {
    cleanup();
  }
});

test('N26: knowledge_get field:"headline" resolves question on a research_finding (which carries no title)', () => {
  const { tools, cleanup } = harness();
  try {
    const created = (tools.knowledgeCreate('research_finding', {
      question: 'Does the SDK zod-to-json-schema conversion serve a top-level discriminated union as an empty object schema?',
      answer: 'Yes — verified empirically against the installed SDK.',
      source_urls: [],
      source_date: NOW,
      capture_date: NOW,
      volatility_hint: 'stable',
      file_keys: ['packages/mcp-server/src/server.ts'],
    }) as { record: { id: string } }).record;

    const headline = tools.knowledgeGet(created.id, { field: 'headline' }) as { kind: string; value: unknown };
    assert.equal(headline.kind, 'value');
    assert.equal(
      headline.value,
      'Does the SDK zod-to-json-schema conversion serve a top-level discriminated union as an empty object schema?'
    );
  } finally {
    cleanup();
  }
});

test('N26: knowledge_get field:"headline" resolves title on a feature_article', () => {
  const { tools, cleanup } = harness();
  try {
    const created = (tools.knowledgeCreate('feature_article', {
      slug: 'headline-test-feature',
      title: 'Headline Test Feature',
      what_it_does: 'Exercises the headline virtual field for a feature_article.',
      intended_behavior: 'Always resolves title first.',
      current_ac: [],
      files: [{ path: 'src/whatever.ts', role: 'owns' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'built',
      history: [],
      live_test_refs: [],
    }) as { record: { id: string } }).record;

    const headline = tools.knowledgeGet(created.id, { field: 'headline' }) as { kind: string; value: unknown };
    assert.equal(headline.kind, 'value');
    assert.equal(headline.value, 'Headline Test Feature');
  } finally {
    cleanup();
  }
});

test('N26: the field-refusal error names "headline" in its valid-set message so it is discoverable', () => {
  const { tools, cleanup } = harness();
  try {
    const created = (tools.knowledgeCreate('decision', {
      title: 'Some ruling',
      statement: 'Something was decided.',
      rationale: 'Some context.',
      alternatives_rejected: [{ option: 'a', reason: 'b' }],
      file_keys: ['src/x.ts'],
    }) as { record: { id: string } }).record;

    assert.throws(
      () => tools.knowledgeGet(created.id, { field: 'not_a_real_field' }),
      /headline/,
      'the refusal for an unknown field mentions "headline" as a valid (virtual) field name'
    );
  } finally {
    cleanup();
  }
});

test('N26: field:"headline" refuses offset/length — it is a derived scalar, not windowable', () => {
  const { tools, cleanup } = harness();
  try {
    const created = (tools.knowledgeCreate('decision', {
      title: 'Some other ruling',
      statement: 'Something else was decided.',
      rationale: 'Some other context.',
      alternatives_rejected: [{ option: 'a', reason: 'b' }],
      file_keys: ['src/y.ts'],
    }) as { record: { id: string } }).record;

    assert.throws(
      () => tools.knowledgeGet(created.id, { field: 'headline', offset: 0, length: 5 }),
      /not.*windowable|windowable/i
    );
  } finally {
    cleanup();
  }
});

test('N28: a KEYLESS item with no citing record gets the could-not-run wording, never the file_keys negative (review pin)', () => {
  const { tools, cleanup } = harness();
  try {
    const keyless = (tools.boardAdd({ text: 'free-floating idea', source: 'user' }) as { record: { id: string } }).record;
    const r = tools.boardRemove(keyless.id) as { artifact_evidence: unknown[]; note?: string };
    assert.deepEqual(r.artifact_evidence, []);
    assert.match(r.note ?? '', /no file_keys.*could not run/i);
    // The load-bearing arm: regressing to the unconditional wording goes red.
    assert.doesNotMatch(r.note ?? '', /no knowledge record touching this item's file_keys/);
  } finally {
    cleanup();
  }
});
