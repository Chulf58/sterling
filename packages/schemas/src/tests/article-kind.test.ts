// ------------------- SPEC: article_kind marker gates the structured n/a exemption -------------------
// (board a9280db7; ruling: decision article-kind-marker-gates-structured-na-exemption,
//  knowledge_get c48380bf — that record's statement is the spec pinned below, opened before
//  writing a line of this file.)
//
// RULING PINNED (verbatim substance):
//   (1) feature_article gains `article_kind`, a CLOSED enum — 'feature' (default), 'probe',
//       'tool', 'concept' — subsuming the existing concept_family marker's role as the kind
//       axis (concept_family stays as-is; the enum is the queryable authority).
//   (2) live_test_refs and current_ac accept, ONLY on kind probe|tool, a structured exemption
//       {not_applicable: {reason, ruling_record_id?}} parallel to the existing
//       untestable_because pattern — an empty array on a written/touched record is REJECTED
//       with a message naming both honest routes (real content, or the structured exemption).
//   (3) kind 'feature' rejects the exemption outright — the demand stays undiluted where those
//       fields do real work.
//   (4) current_ac's exemption is narrower than live_test_refs' in INTENT ("a probe that makes
//       falsifiable claims writes probe-native ACs; the exemption is only for what the article
//       genuinely cannot possess") — this is an authorial/content judgement, not something a
//       zod schema can check, so it is NOT pinned here as a distinct structural rule. What IS
//       pinned is the STRUCTURAL parallel: current_ac accepts the identical {not_applicable:
//       {reason, ruling_record_id?}} shape, gated by the same kind check as live_test_refs.
//   (5) Existing empty-array records migrate lazily (fix-forward on next touch, no bulk
//       migration) — this is a WRITE-PIPELINE/mcp-server concern, invisible to a pure
//       schema.parse() call. At the schema layer there is no "is this record new or existing"
//       signal, so every parse of a probe|tool record enforces the same rule. This file pins
//       schema-level behavior only.
//
// AMBIGUITY RESOLVED BY READING AN EXISTING FROZEN TEST (not by guessing): does kind 'feature'
// (explicit or defaulted) keep accepting an empty live_test_refs/current_ac array at parse time?
// `schemas.test.ts` (~line 690-703, "feature_article.concept_family: optional marker
// round-trips...") already parses a feature_article with `current_ac: []` and
// `live_test_refs: []` and asserts it succeeds — that test is FROZEN and I never touch it. Since
// that record carries no article_kind (so it defaults to 'feature' once the field exists), the
// only reading consistent with that frozen pin is: kind 'feature' keeps accepting empty arrays
// unchanged. Test 1 below re-establishes the same fact as a fresh, owned pin (never editing the
// frozen one) and doubles as the CONTROL arm for Test 8's rejection.
//
// SHAPE INFERENCE: the decision states the exemption replaces "real content" — i.e. the whole
// field's value becomes `{not_applicable: {...}}` instead of an array — not a per-item marker
// inside the array (that per-item shape already exists, distinctly, as
// `current_ac[].untestable_because: {reason, blocking_record_id}` — see
// decision-authority-and-article-honesty.test.ts SPEC B(a) — which is a DIFFERENT, pre-existing
// mechanism with a REQUIRED blocking_record_id and a different field name. The new exemption
// deliberately uses a different name (`ruling_record_id`, marked optional with `?`) and a
// different key (`not_applicable`, not `untestable_because`) at the whole-field level, so the
// two are not confused in these tests.
//
// featureArticleSchema already exists (only `article_kind` and the exemption shape are new), so
// this is a STATIC import per the `current_ac[].untestable_because` precedent in
// decision-authority-and-article-honesty.test.ts — never a compile-time reference to a
// not-yet-declared top-level export. Every not-yet-existing FIELD is read back through `unknown`
// casts so a missing field fails an assertion below, never a TypeScript compile error.
//
// envelope/articleBase are duplicated deliberately (same rationale as the sibling spec file):
// importing them from schemas.test.ts would re-execute every test it declares.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { featureArticleSchema } from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';

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

// `currentAc`/`liveTestRefs` accept either a real array OR (once implemented) the structured
// exemption object — both are plain `unknown` inputs here since the union is not yet declared.
function articleBase(
  currentAc: unknown,
  liveTestRefs: unknown,
  extra: Record<string, unknown> = {}
) {
  return {
    ...envelope('feature_article'),
    slug: 'probe-alpha',
    title: 'Probe Alpha',
    what_it_does: 'Investigates whether the cache eviction policy is LRU.',
    intended_behavior: 'A probe verifies a single falsifiable claim about the running system.',
    files: [],
    current_ac: currentAc,
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active' as const,
    version: 1,
    history: [{ date: NOW, event: 'originating probe' }],
    live_test_refs: liveTestRefs,
    ...extra,
  };
}

const REAL_AC = [{ ac_id: 'AC1', text: 'probe result recorded in the log', verifiable_at: 'final' }];
const REAL_REFS = [{ ac_id: 'AC1', test_paths: ['tests/probe-alpha.test.ts'] }];

function thrownMessage(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

// ===================== Test 1 (CONTROL, first): default kind + baseline unaffected =====================

test('CONTROL: article_kind defaults to "feature"; a default/explicit-feature article keeps accepting empty live_test_refs + current_ac (baseline unaffected, per the frozen concept_family pin in schemas.test.ts)', () => {
  // EXPECTED RED (before article_kind exists): featureArticleSchema is a strict schema, so a
  // body with no article_kind field simply omits an unknown key today — this parses FINE right
  // now, meaning the RED here is specifically the `.article_kind === 'feature'` assertion
  // failing (today it is `undefined`), never a thrown error.
  // SABOTAGE: remove `.default('feature')` from the article_kind zod field (leave it a bare
  // optional enum) -> `.article_kind` comes back `undefined` instead of `'feature'` -> red.
  const noKind = articleBase([], []);
  let parsedNoKind: { article_kind?: string } | undefined;
  assert.doesNotThrow(() => {
    parsedNoKind = featureArticleSchema.parse(noKind) as unknown as typeof parsedNoKind;
  }, 'a feature_article with no article_kind and empty arrays must still parse (unchanged baseline)');
  assert.equal(parsedNoKind!.article_kind, 'feature', 'article_kind defaults to "feature" when absent');

  // Explicit 'feature' behaves identically to the default.
  // SABOTAGE: make kind gating apply to EVERY kind including 'feature' (i.e. reject empty
  // arrays regardless of kind) -> this assertion goes red, and it is what tells Test 8's
  // rejection apart from an over-broad "empty arrays are now always invalid" bug.
  const explicitFeature = articleBase([], [], { article_kind: 'feature' });
  let parsedExplicit: { article_kind?: string } | undefined;
  assert.doesNotThrow(() => {
    parsedExplicit = featureArticleSchema.parse(explicitFeature) as unknown as typeof parsedExplicit;
  }, 'explicit article_kind: "feature" with empty arrays must still parse');
  assert.equal(parsedExplicit!.article_kind, 'feature');
});

// ===================== Test 2: closed enum totality =====================

test('article_kind: closed enum — feature|probe|tool|concept each parse with real content; an unknown kind is rejected', () => {
  // EXPECTED RED (before the field exists): a strict schema either silently drops the unknown
  // `article_kind` key (if additionalProperties are stripped rather than refused) or throws on
  // it outright. Either way the read-back equality assertions below fail — 'article_kind' comes
  // back undefined/absent instead of echoing the kind that was sent, or the parse throws where
  // this test expects success.
  // SABOTAGE: swap `z.enum(['feature','probe','tool','concept'])` for a bare `z.string()` ->
  // the "unknown kind rejected" assert.throws below goes red (no throw).
  for (const kind of ['feature', 'probe', 'tool', 'concept'] as const) {
    const body = articleBase(REAL_AC, REAL_REFS, { article_kind: kind });
    let parsed: { article_kind?: string } | undefined;
    assert.doesNotThrow(() => {
      parsed = featureArticleSchema.parse(body) as unknown as typeof parsed;
    }, `article_kind '${kind}' with real content must parse`);
    assert.equal(parsed!.article_kind, kind, `article_kind '${kind}' round-trips unchanged`);
  }

  assert.throws(
    () => featureArticleSchema.parse(articleBase(REAL_AC, REAL_REFS, { article_kind: 'bogus' })),
    /invalid/i,
    'a kind outside the closed four-member enum is rejected'
  );
});

// ===================== Test 3: concept kind coexists with concept_family =====================

test("article_kind: 'concept' coexists with the pre-existing concept_family marker — both present parses, both survive", () => {
  // EXPECTED RED: same failure mode as Test 2 — article_kind is absent/undefined from the
  // parsed result, or the parse throws where none is expected.
  // SABOTAGE: add a zod .refine() that rejects a record carrying both concept_family AND
  // article_kind (a mutual-exclusion the decision never asks for) -> this parse throws
  // unexpectedly -> red.
  const body = articleBase(REAL_AC, REAL_REFS, {
    article_kind: 'concept',
    concept_family: 'weapons',
  });
  let parsed: { article_kind?: string; concept_family?: string } | undefined;
  assert.doesNotThrow(() => {
    parsed = featureArticleSchema.parse(body) as unknown as typeof parsed;
  }, "article_kind: 'concept' together with concept_family must parse");
  assert.equal(parsed!.article_kind, 'concept');
  assert.equal(parsed!.concept_family, 'weapons', 'concept_family is untouched by the new kind axis');
});

// ===================== Test 4 (positive, precedes the negative Test 6): structured exemption accepted =====================

test("probe/tool: the structured {not_applicable: {reason, ruling_record_id?}} exemption is accepted IN PLACE OF real content on both live_test_refs and current_ac — ruling_record_id is optional", () => {
  // EXPECTED RED: today neither `article_kind` nor the exemption shape exists, so passing an
  // object where an array is expected either throws a type-mismatch ZodError (schema currently
  // demands an array) or, if the field were loosely typed, would silently pass — the
  // `assert.doesNotThrow` + read-back-equality pair below fails either way until the union is
  // implemented and gated correctly.
  // SABOTAGE: keep live_test_refs/current_ac typed as a bare array with no exemption union at
  // all -> every assert.doesNotThrow below goes red (ZodError: expected array, received object).
  const ruling = randomUUID();

  // live_test_refs exemption, without ruling_record_id, on kind 'probe'
  const probeNoRuling = articleBase(REAL_AC, { not_applicable: { reason: 'no test harness exists for this probe; verified via manual log inspection' } }, { article_kind: 'probe' });
  let p1: { live_test_refs?: { not_applicable?: { reason: string; ruling_record_id?: string } } } | undefined;
  assert.doesNotThrow(() => {
    p1 = featureArticleSchema.parse(probeNoRuling) as unknown as typeof p1;
  }, 'live_test_refs exemption without ruling_record_id must parse on kind probe');
  assert.equal(p1!.live_test_refs!.not_applicable!.reason, 'no test harness exists for this probe; verified via manual log inspection');
  assert.equal(p1!.live_test_refs!.not_applicable!.ruling_record_id, undefined, 'ruling_record_id is optional — absent stays absent');

  // live_test_refs exemption, WITH ruling_record_id, on kind 'tool'
  const toolWithRuling = articleBase(REAL_AC, { not_applicable: { reason: 'this tool is exercised only by a decommissioned CI job', ruling_record_id: ruling } }, { article_kind: 'tool' });
  let p2: { live_test_refs?: { not_applicable?: { reason: string; ruling_record_id?: string } } } | undefined;
  assert.doesNotThrow(() => {
    p2 = featureArticleSchema.parse(toolWithRuling) as unknown as typeof p2;
  }, 'live_test_refs exemption WITH ruling_record_id must parse on kind tool');
  assert.equal(p2!.live_test_refs!.not_applicable!.ruling_record_id, ruling, 'ruling_record_id survives parsing when present');

  // current_ac exemption, without ruling_record_id, on kind 'probe'
  const probeAcNoRuling = articleBase({ not_applicable: { reason: 'this probe asserts a runtime fact with no discrete acceptance criteria' } }, REAL_REFS, { article_kind: 'probe' });
  let p3: { current_ac?: { not_applicable?: { reason: string; ruling_record_id?: string } } } | undefined;
  assert.doesNotThrow(() => {
    p3 = featureArticleSchema.parse(probeAcNoRuling) as unknown as typeof p3;
  }, 'current_ac exemption without ruling_record_id must parse on kind probe');
  assert.equal(p3!.current_ac!.not_applicable!.reason, 'this probe asserts a runtime fact with no discrete acceptance criteria');

  // current_ac exemption, WITH ruling_record_id, on kind 'tool'
  const toolAcWithRuling = articleBase({ not_applicable: { reason: 'ACs retired when the tool was folded into another', ruling_record_id: ruling } }, REAL_REFS, { article_kind: 'tool' });
  let p4: { current_ac?: { not_applicable?: { reason: string; ruling_record_id?: string } } } | undefined;
  assert.doesNotThrow(() => {
    p4 = featureArticleSchema.parse(toolAcWithRuling) as unknown as typeof p4;
  }, 'current_ac exemption WITH ruling_record_id must parse on kind tool');
  assert.equal(p4!.current_ac!.not_applicable!.ruling_record_id, ruling);
});

// ===================== Test 5 (negative): empty array rejected on probe|tool, message names both routes =====================

test('probe/tool: an EMPTY array on live_test_refs or current_ac is REJECTED — the message names both honest routes (real content, or the structured exemption)', () => {
  // EXPECTED RED: today an empty array parses FINE for every kind (no gate exists at all), so
  // every assert.ok(msg, ...) below fails — `thrownMessage` returns null because parse()
  // succeeds instead of throwing.
  // SABOTAGE: gate the rejection on the field being MISSING rather than merely EMPTY (e.g.
  // `if (val === undefined)` instead of `if (Array.isArray(val) && val.length === 0)`) -> an
  // empty array (`[]`) slips through unrejected -> the assert.ok(msg) calls below go red.
  for (const kind of ['probe', 'tool'] as const) {
    // live_test_refs empty
    const emptyRefs = articleBase(REAL_AC, [], { article_kind: kind });
    const msgRefs = thrownMessage(() => featureArticleSchema.parse(emptyRefs));
    assert.ok(msgRefs, `kind '${kind}': an empty live_test_refs array must be rejected`);
    assert.match(msgRefs!, /not_applicable/i, `kind '${kind}': the refusal names the structured-exemption route`);
    assert.match(msgRefs!, /content|test_paths|ac_id/i, `kind '${kind}': the refusal also names the real-content route`);

    // current_ac empty
    const emptyAc = articleBase([], REAL_REFS, { article_kind: kind });
    const msgAc = thrownMessage(() => featureArticleSchema.parse(emptyAc));
    assert.ok(msgAc, `kind '${kind}': an empty current_ac array must be rejected`);
    assert.match(msgAc!, /not_applicable/i, `kind '${kind}': the refusal names the structured-exemption route`);
    assert.match(msgAc!, /content|ac_id|text/i, `kind '${kind}': the refusal also names the real-content route`);
  }
});

// ===================== Test 6: the exemption's reason must be non-empty =====================

test("probe/tool: the not_applicable exemption's reason must be a NON-EMPTY string (parallel to the existing untestable_because.reason precedent) — an empty or missing reason is rejected", () => {
  // EXPECTED RED: today the exemption shape does not exist at all, so passing an object where
  // an array is expected throws a generic type-mismatch — the throw itself is not evidence this
  // specific rule is enforced (see the CONTROL note above: Test 4 must already be green for this
  // test's throws to mean what they claim).
  // SABOTAGE: make `reason` optional or accept an empty string on the exemption object (e.g.
  // `z.string()` instead of `z.string().min(1)`) -> the empty-reason assertion below goes red
  // (parse succeeds where it must throw).
  assert.throws(
    () => featureArticleSchema.parse(articleBase(REAL_AC, { not_applicable: { reason: '' } }, { article_kind: 'probe' })),
    /invalid|empty|at least 1|required/i,
    'an empty-string reason on the live_test_refs exemption is rejected'
  );
  assert.throws(
    () => featureArticleSchema.parse(articleBase(REAL_AC, { not_applicable: {} }, { article_kind: 'probe' })),
    /invalid|required|reason/i,
    'a missing reason on the live_test_refs exemption is rejected'
  );
  assert.throws(
    () => featureArticleSchema.parse(articleBase({ not_applicable: { reason: '' } }, REAL_REFS, { article_kind: 'tool' })),
    /invalid|empty|at least 1|required/i,
    'an empty-string reason on the current_ac exemption is rejected'
  );
});

// ===================== Test 7: kind 'feature' rejects the exemption shape outright =====================

test("feature kind (explicit or defaulted) REJECTS the not_applicable exemption shape outright on both fields — the demand stays undiluted where those fields do real work", () => {
  // CONTROL already established by Test 1: kind 'feature' (default and explicit) parses FINE
  // with a plain empty array. That is what makes the throws below attributable specifically to
  // the EXEMPTION SHAPE being disallowed on this kind, and not to a blanket "feature can no
  // longer have empty/odd live_test_refs/current_ac" bug.
  // EXPECTED RED: today there is no article_kind and no exemption shape, so passing an object
  // where an array is expected throws a generic type-mismatch for EVERY kind including probe and
  // tool — this test would (today) pass for the wrong reason. It is included anyway per the
  // brief's explicit requirement to pin decision point (3); the true oracle only exists once
  // Test 4's positive probe/tool acceptance is also green (a reader of a red run must check both
  // together, exactly as the mutation-verification discipline requires).
  // SABOTAGE: extend the exemption union to ALL kinds (drop the kind !== 'feature' condition
  // from the gate) -> the assert.throws calls below go red (parse succeeds where it must not).
  const explicitFeature = articleBase(REAL_AC, { not_applicable: { reason: 'trying to dodge the demand' } }, { article_kind: 'feature' });
  assert.throws(
    () => featureArticleSchema.parse(explicitFeature),
    /invalid|feature|not_applicable/i,
    'explicit article_kind "feature" rejects the live_test_refs exemption shape'
  );

  const defaultedFeature = articleBase({ not_applicable: { reason: 'trying to dodge the demand' } }, REAL_REFS);
  assert.throws(
    () => featureArticleSchema.parse(defaultedFeature),
    /invalid|feature|not_applicable/i,
    'defaulted (omitted) article_kind rejects the current_ac exemption shape exactly like explicit "feature"'
  );
});
