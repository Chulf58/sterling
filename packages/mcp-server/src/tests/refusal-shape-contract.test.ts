import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// ---------------------------------------------------------------------------
// board 03c92e2a (measured live 2026-08-22): a zod schema-validation failure
// on knowledge_append / knowledge_create was returned to the caller as a RAW
// ZOD ERROR ARRAY — e.g. for a history entry passed as a bare string instead
// of {date, event}:
//   [{"code":"invalid_type","expected":"object","received":"string","path":["history",19],"message":"Expected object, received string"}]
// Accurate but useless: it never says what a history entry should CONTAIN,
// so the caller has to separately call knowledge_schema or knowledge_get an
// existing record to learn the shape. This breaks the store surface's own
// standard that a refusal names its discriminator (decision d0b88e27, "A
// gate's refusal must name its DISCRIMINATOR, not just its rule") — every
// other refusal on this boundary (unknown field, knowledge_edit's zero/many
// find-match) already does this; this one path drops to raw library output.
//
// THE CONTRACT PINNED HERE (given by the work order, not invented):
//  1. names the FIELD PATH in caller-facing form, including array index
//  2. names RECEIVED vs EXPECTED at that path
//  3. enumerates the EXPECTED SHAPE of the failing element (each field: name,
//     required?, type) — "expected object" alone does not satisfy this
//  4. a CLOSED ENUM field lists its permitted values
//  5. NO raw zod artifact leaks ("code":"invalid_type", "received":"string",
//     a raw serialized issue array, the ZodError class name)
//  6. NO-DRIFT: the expected-shape text must be DERIVED from the same
//     registered zod schema knowledge_schema projects — cross-checked
//     programmatically against knowledge_schema's own live output, never a
//     hardcoded literal that could silently diverge from a real schema change
//  7. regression: the existing unknown-field refusal still names the valid
//     field set (tools.test.ts:177 pins "/does not define/" — unchanged here)
//  8. a nested/deep failure (not just a top-level array element) still names
//     a usable path
//  9. both knowledge_append and knowledge_create share this contract
//
// KNOWLEDGE-BASE CHECK (per the work order): queried decision d0b88e27 ("A
// gate's refusal must name its DISCRIMINATOR..."), 9948475b (knowledge_schema
// derives per-field {name, required, type, enum_values?} from the registered
// zod schema via a shared objectShapeFor helper — nothing hand-listed), and
// 8ed62c1b (knowledge_append's existing refusals already name the valid field
// set via the same knownFieldsFor helper the write guards use). No conflict
// with the contract above was found; the query windows were capped (see
// report) but the governing ruling on refusal shape was located directly.
// ---------------------------------------------------------------------------

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-refusal-shape-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

// Mirrors the known-valid feature_article payload shape established in
// tools.test.ts's `mkArticle` — restated here (this file cannot import a
// private const from another test file) rather than guessed.
function articlePayload(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'refusal-shape-fixture',
    title: 'refusal-shape-fixture',
    what_it_does: 'exists only to trigger validation failures',
    intended_behavior: 'n/a',
    files: [{ path: 'src/fixture.ts', role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    ...overrides,
  };
}

// Catches a thrown refusal and returns its message; fails loudly (not
// silently) if the call under test unexpectedly succeeds, so a red run
// reports "the call succeeded" rather than a confusing crash elsewhere.
function captureThrow(fn: () => unknown, label: string): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message ?? String(e);
  }
  assert.fail(`${label}: expected a refusal (thrown error), but the call succeeded`);
}

// clause 5 — no raw zod artifact leaks, in any of the shapes zod is known to
// serialize as: the raw issue-array JSON, the exact "code"/"received" keys
// from the observed incident, or the ZodError class name.
function assertNoRawZodLeak(message: string, label: string) {
  assert.ok(!message.includes('"code":"invalid_type"'), `${label}: no raw zod issue code leaks verbatim`);
  assert.ok(!message.includes('"received":"string"'), `${label}: no raw zod "received" field leaks verbatim`);
  assert.ok(!/^\s*\[\s*\{/.test(message), `${label}: message is not a raw serialized zod issue array`);
  assert.ok(!message.includes('ZodError'), `${label}: no ZodError class name leak`);
}

type FieldDescriptor = {
  name: string;
  type: string;
  enum_values?: string[];
  element_fields?: { name: string; type: string; enum_values?: string[] }[];
};

// clause 6 (no-drift) helper: assert every name/type/enum the refusal claims
// for a nested element is present VERBATIM in whatever knowledge_schema is
// reporting RIGHT NOW for that element — never a value we typed in by hand.
// If the schema legitimately grows a field, knowledge_schema's live output
// changes and this keeps passing (it re-reads the field list every call). If
// the refusal's text is instead a second, hand-written description that
// silently drifts from the schema, this fails: the drifted/removed/renamed
// field will be present in one side and absent in the other.
function assertElementShapeNamesAndTypesMatchLiveSchema(
  message: string,
  elementFields: { name: string; type: string; enum_values?: string[] }[],
  label: string
) {
  for (const ef of elementFields) {
    assert.ok(message.includes(ef.name), `${label}: refusal names sub-field '${ef.name}' (pulled live from knowledge_schema, not hardcoded)`);
    assert.ok(message.includes(ef.type), `${label}: refusal states sub-field '${ef.name}''s type as '${ef.type}' (pulled live from knowledge_schema)`);
    if (ef.enum_values) {
      for (const v of ef.enum_values) {
        assert.ok(message.includes(v), `${label}: refusal lists enum value '${v}' for '${ef.name}' (pulled live from knowledge_schema)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// clauses 1, 2, 5 — reproduces the measured defect verbatim: 19 prior
// history entries, then a bare string appended as entry 20 (index 19), the
// exact path the incident report quoted.
//
// EXPECTED FAILURE SHAPE (red, pre-fix): today this throws the raw zod issue
// array stringified into .message (or a message built from it), so
// `message.includes('history[19]')` fails (no such caller-facing token
// exists — the raw form is `"path":["history",19]`), and
// assertNoRawZodLeak's `"code":"invalid_type"` / `"received":"string"`
// checks fail because those exact substrings ARE present verbatim today.
// ---------------------------------------------------------------------------
test('AC1+AC2+AC5: knowledge_append names the exact failing index (history[19]) and received-vs-expected, never the raw zod issue array (reproduces board 03c92e2a verbatim)', () => {
  const { tools, cleanup } = harness();
  try {
    const priorEntries = Array.from({ length: 19 }, (_, i) => ({ date: NOW, event: `entry-${i}` }));
    const { record } = tools.knowledgeCreate('feature_article', articlePayload({ history: priorEntries }));

    const message = captureThrow(
      () => tools.knowledgeAppend((record as { id: string }).id, 'history', ['not an object — the exact observed shape']),
      'history[19] bad element'
    );

    // clause 1: field path in caller-facing form, WITH the array index.
    assert.ok(message.includes('history[19]'), `refusal names the exact index that failed (history[19]); got: ${message}`);

    // clause 2: received vs expected at that path.
    assert.match(message, /string/i, 'names what was RECEIVED (a string)');
    assert.match(message, /object/i, 'names what was EXPECTED (an object)');

    // clause 5: no raw zod artifact.
    assertNoRawZodLeak(message, 'history[19] refusal');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// clauses 3, 6 — the expected SHAPE (both fields, named, typed, and marked
// required) must be enumerated, and must be derived live from the same
// schema knowledge_schema projects rather than a hand-written literal.
//
// Required-ness is grounded EMPIRICALLY against the schema's own actual
// enforcement (omit each field alone and confirm the write is refused)
// rather than assumed, so this test does not depend on knowledge_schema
// exposing a `required` flag on nested element_fields — it depends only on
// name/type/enum_values, which the files[]/current_ac[]/alternatives_rejected[]
// nested-enum fix already established knowledge_schema reports.
//
// EXPECTED FAILURE SHAPE (red, pre-fix): message.includes('date') and
// message.includes('event') both fail today because the raw zod message for
// a top-level type mismatch never mentions the object's field names at all
// (it only reports the path that failed, not the shape it expected) —
// "Expected object, received string" contains neither token.
// ---------------------------------------------------------------------------
test('AC3+AC6 (no-drift): the refusal enumerates history\'s {date, event} shape by name and type pulled LIVE from knowledge_schema, and marks both required to match the schema\'s own enforcement', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.knowledgeCreate('feature_article', articlePayload());
    const id = (record as { id: string }).id;
    const message = captureThrow(() => tools.knowledgeAppend(id, 'history', ['bad-entry']), 'history bad element (shape enumeration)');

    // NO-DRIFT (clause 6): read the expected shape from knowledge_schema's
    // OWN live projection, not a literal typed into this test.
    const historyField = (tools.knowledgeSchema('feature_article').fields as FieldDescriptor[]).find((f) => f.name === 'history');
    assert.ok(historyField, 'history is reported as a field at all by knowledge_schema');

    // ENVELOPE-KEY ASSUMPTION (same posture as schema-nested-enums.test.ts's
    // precedent for files[]/current_ac[]/alternatives_rejected[]): the nested
    // element shape rides on `element_fields`, an array of
    // { name, type, enum_values? }. If the implementer names the key
    // differently, rename here consciously — the point under test is that
    // ONE live source drives both knowledge_schema's report and the refusal
        // text, not the exact key chosen for it.
    const elementFields = historyField!.element_fields;
    assert.ok(
      Array.isArray(elementFields) && elementFields.length > 0,
      "knowledge_schema('feature_article').history must report its element shape (date/event) via element_fields — wiring history into the same nested-shape projection files[]/current_ac[]/alternatives_rejected[] already use is part of satisfying the no-drift requirement (clause 6)"
    );
    assertElementShapeNamesAndTypesMatchLiveSchema(message, elementFields!, 'history[N] shape enumeration');

    // Required-ness, grounded empirically: omitting either field alone must
    // itself be refused (proves the schema truly requires it), independent
    // of any literal I might otherwise have hardcoded.
    const missingEvent = captureThrow(() => tools.knowledgeAppend(id, 'history', [{ date: NOW }]), 'history entry missing event');
    assert.match(missingEvent, /event/i, 'omitting "event" is itself refused — proves the schema requires it');
    const missingDate = captureThrow(() => tools.knowledgeAppend(id, 'history', [{ event: 'x' }]), 'history entry missing date');
    assert.match(missingDate, /date/i, 'omitting "date" is itself refused — proves the schema requires it');

    // The shape-enumeration message must mark both as required, matching
    // the enforcement just proven above.
    assert.match(message, /date[^\n]{0,60}required|required[^\n]{0,60}date/i, 'shape enumeration marks "date" required');
    assert.match(message, /event[^\n]{0,60}required|required[^\n]{0,60}event/i, 'shape enumeration marks "event" required');

    // ---- STRENGTHENING (board 5402a024 / this dispatch): the two window
    // regexes above and assertElementShapeNamesAndTypesMatchLiveSchema are
    // INCLUSION checks — they pass against a hand-written literal, against a
    // literal carrying a spurious extra field, and against types/markers
    // bound to the WRONG field as long as the words land inside a 60-char
    // window. Nothing below is removed; the exact structural form is added
    // beside it. See assertShapeListedExactly for what "exact" means here.
    assertShapeListedExactly(message, elementFields!, 'feature_article.history');

    assertNoRawZodLeak(message, 'history[N] shape enumeration');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// clause 9 — the boundary is shared: knowledge_create must refuse a bad
// array element the same way knowledge_append does, not just at append time.
//
// EXPECTED FAILURE SHAPE (red, pre-fix): same as AC1 — the raw zod array
// leaks, `history[1]` is absent from the message, and the element shape
// (date/event) is never named.
// ---------------------------------------------------------------------------
test('AC9: knowledge_create refuses a bad history element under the SAME contract as knowledge_append — the boundary is shared, not append-only', () => {
  const { tools, cleanup } = harness();
  try {
    const message = captureThrow(
      () =>
        tools.knowledgeCreate(
          'feature_article',
          articlePayload({
            history: [{ date: NOW, event: 'ok' }, 'bad-entry-at-create-time'],
          })
        ),
      'create-time bad history element'
    );

    assert.ok(message.includes('history[1]'), `refusal names the exact failing index (history[1]); got: ${message}`);
    assert.match(message, /string/i, 'names what was RECEIVED (a string)');
    assert.match(message, /object/i, 'names what was EXPECTED (an object)');
    assert.ok(message.includes('date'), 'element shape names the "date" sub-field');
    assert.ok(message.includes('event'), 'element shape names the "event" sub-field');
    assertNoRawZodLeak(message, 'create-time history[1] refusal');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// clause 7 — regression pin: the already-good unknown-field refusal must
// keep naming the valid field set exactly as it does today (decision
// 8ed62c1b: "naming the valid set via the same knownFieldsFor helper the
// write guards use"; tools.test.ts:177 pins the "/does not define/" wording
// unchanged). Cross-checked live against knowledge_schema rather than a
// hardcoded field list, so this stays correct if the type grows a field.
// ---------------------------------------------------------------------------
test('AC7 (regression): unknown-field refusal on knowledge_append still names the complete valid field set for the type', () => {
  const { tools, cleanup } = harness();
  try {
    const { record } = tools.knowledgeCreate('feature_article', articlePayload());
    const message = captureThrow(() => tools.knowledgeAppend((record as { id: string }).id, 'not_a_real_field', ['x']), 'unknown field');

    assert.match(message, /does not define/, 'existing wording preserved (tools.test.ts:177 pin) — not weakened by this fix');

    const schema = tools.knowledgeSchema('feature_article') as { required: string[]; optional: string[] };
    const validFields = [...schema.required, ...schema.optional];
    assert.ok(validFields.length > 0, 'sanity: knowledge_schema reports at least one valid field for feature_article');
    for (const field of validFields) {
      assert.ok(message.includes(field), `unknown-field refusal names valid field '${field}' — derived live from knowledge_schema, not hardcoded`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// clause 4 — a closed-enum field failure must list its permitted values,
// pulled live from knowledge_schema rather than hardcoded, so a schema
// change that adds/removes a member is tracked automatically.
//
// EXPECTED FAILURE SHAPE (red, pre-fix): the raw zod "invalid_enum_value"
// issue for volatility_hint either leaks its raw form or (if partially
// message-ified already) never enumerates fast/medium/stable at all.
// ---------------------------------------------------------------------------
test('AC4: a closed-enum field failure (research_finding.volatility_hint) lists the permitted values, pulled live from knowledge_schema', () => {
  const { tools, cleanup } = harness();
  try {
    const message = captureThrow(
      () =>
        tools.knowledgeCreate('research_finding', {
          question: 'does an invalid volatility_hint get refused with its enum listed?',
          answer: 'it should',
          source_urls: [],
          source_date: '2026-01-01',
          capture_date: '2026-01-01',
          volatility_hint: 'blazing',
        }),
      'invalid volatility_hint'
    );

    assert.ok(message.includes('volatility_hint'), 'refusal names the failing field');

    // NO-DRIFT: read the permitted set live rather than hardcoding
    // ['fast','medium','stable'] here.
    const field = (tools.knowledgeSchema('research_finding').fields as FieldDescriptor[]).find((f) => f.name === 'volatility_hint');
    assert.ok(field?.enum_values && field.enum_values.length > 0, 'volatility_hint is reported as a closed enum by knowledge_schema');
    for (const v of field!.enum_values!) {
      assert.ok(message.includes(v), `refusal lists permitted value '${v}' (pulled live from knowledge_schema)`);
    }

    // ---- STRENGTHENING: the loop above is an INCLUSION check — it passes
    // just as happily against a renderer that emits the three real members
    // PLUS an invalid extra ('glacial'), which is exactly the sabotage the
    // reviewers demonstrated. Assert the permitted SET instead: exactly the
    // schema's members, no extras, and never the rejected value itself.
    assertExactEnumSet(message, field!.enum_values!, 'research_finding.volatility_hint', [field!.name, field!.type]);
    const permittedRegion = extractDelimitedList(message, field!.enum_values!, 'research_finding.volatility_hint');
    assert.ok(
      !wordPresent(permittedRegion, 'blazing'),
      `the REJECTED value must never appear inside the permitted-values list (that would tell the caller its bad value is legal); permitted region was: ${permittedRegion}`
    );

    assertNoRawZodLeak(message, 'volatility_hint refusal');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// clause 8 — a failure nested two levels deep (an object field whose OWN
// array-of-scalars field has a bad element) must still name a usable path,
// not just the top-level array-of-objects case (history/files/current_ac).
//
// EXPECTED FAILURE SHAPE (red, pre-fix): raw zod path ["dependencies",
// "relies_on", 0] leaks in its serialized form; 'relies_on[0]' (or an
// equivalent caller-facing rendering) is absent.
// ---------------------------------------------------------------------------
test('AC8: a validation failure nested two levels deep (dependencies.relies_on[0]) still names a usable path', () => {
  const { tools, cleanup } = harness();
  try {
    const message = captureThrow(
      () =>
        tools.knowledgeCreate(
          'feature_article',
          articlePayload({
            dependencies: { relies_on: [123], relied_by: [] },
          })
        ),
      'dependencies.relies_on[0] bad element'
    );

    assert.ok(message.includes('dependencies'), 'refusal names the outer object field');
    assert.ok(message.includes('relies_on'), 'refusal names the nested array field');
    assert.ok(
      message.includes('relies_on[0]') || message.includes('relies_on.0') || /relies_on[^a-zA-Z0-9][^\n]{0,10}0/.test(message),
      `refusal names the specific failing index within relies_on; got: ${message}`
    );
    assert.match(message, /number/i, 'names what was RECEIVED (a number)');
    assert.match(message, /string/i, 'names what was EXPECTED (a string)');
    assertNoRawZodLeak(message, 'dependencies.relies_on[0] refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DERIVATION PINS (this dispatch). Board 5402a024: "a test which passes while
// pinning nothing is the most expensive defect this repo has."
//
// WHY THIS SECTION EXISTS. Two independent reviews confirmed the shipped
// implementation genuinely derives the expected-shape text from the shared
// schema walk — but only BY READING THE CODE. Every assertion above is an
// INCLUSION check ("this name/type/enum member appears somewhere in the
// string"), and the reviewers demonstrated that all of these sabotages still
// pass it:
//   S1  replace the derived renderer with the literal
//       "{date: string (required), event: string (required)}"
//   S2  add a spurious "ghost: number (optional)" to that literal
//   S3  emit the correct enum members PLUS an invalid extra ("glacial")
//   S4  attach types / required-markers to the WRONG fields, as long as the
//       words land inside a loose substring window
//
// TWO COMPLEMENTARY STRATEGIES, both implemented below.
//
// (A) EXACTNESS. The rendered shape is PARSED into a structure and compared
//     to knowledge_schema's live projection: the entry-name SET must be equal
//     (kills S2 and any silently-dropped field), each entry's type must equal
//     ITS OWN field's type (kills S4's type half), each entry carries its own
//     required/optional marker (kills S4's marker half — a marker sitting in
//     the wrong entry leaves the right entry bare), and where required-ness is
//     derivable empirically the marker VALUE is checked too. Enum sets are
//     compared as SETS, never by inclusion (kills S3).
//
// (B) BREADTH. The assertion is driven over EVERY record type in the registry
//     (enumerated at RUNTIME from RECORD_TYPES — never a list typed into this
//     file) and EVERY array-of-objects field the schema walk reports for that
//     type. A hand-written literal cannot satisfy ~8 distinct element shapes
//     across 3 record types, and a NEW record type is covered automatically:
//     the fixture-totality gate fails by name if one is added uncovered. This
//     is the real derivation proof; (A) is what makes each individual case
//     un-fudgeable.
//
// FORMAT ASSUMPTION, DECLARED (same posture as the ENVELOPE-KEY ASSUMPTION
// comments above and in schema-nested-enums.test.ts): the parser assumes the
// element shape is rendered as a brace-delimited group of comma/newline
// separated `name<sep>type<marker>` entries — the very form the reviewers'
// sabotage literal took, and the form knowledge_schema's own type strings use
// ('{path, role, unverified}[]'). It is deliberately tolerant about ordering,
// separators and whitespace. If the shipped renderer uses a different shape,
// these tests fail with the FULL MESSAGE quoted in the assertion text so the
// format is adjudicated ONCE and the parser retargeted — they never silently
// pass. The parser is only a decoder; every expected VALUE it compares against
// comes from tools.knowledgeSchema() at call time.
// ===========================================================================

// --- The registry, at runtime. -------------------------------------------
// The specifier is assembled rather than written as a literal ON PURPOSE: a
// literal would be statically resolved by tsc, and if @sterling/schemas is
// not a declared dependency of this package the whole package build would
// break (a crash-red proves nothing — the repo's own precedent, e.g.
// schemas.test.ts's dynamic-import comments). Assembled, resolution happens at
// runtime and any failure lands on the assertion below with its reason.
const SCHEMAS_PACKAGE = ['@sterling', '/', 'schemas'].join('');

async function registeredRecordTypes(): Promise<string[]> {
  let mod: Record<string, unknown> | undefined;
  try {
    mod = (await import(SCHEMAS_PACKAGE)) as unknown as Record<string, unknown>;
  } catch (e) {
    assert.fail(
      `${SCHEMAS_PACKAGE} must be importable here — the breadth sweep enumerates the record-type registry at RUNTIME so a newly added record type is covered automatically, and a hand-typed list is exactly the second source of truth this whole contract exists to forbid. Import failed: ${(e as Error).message}`
    );
  }
  const registry = mod!.RECORD_TYPES as Record<string, unknown> | undefined;
  assert.ok(
    registry && typeof registry === 'object',
    'RECORD_TYPES must be exported from the schemas index (invariant 3: registries first) — it is the only legitimate source for "every registered record type"'
  );
  const types = Object.keys(registry!).sort();
  assert.ok(types.length > 0, 'RECORD_TYPES must not be empty');
  return types;
}

// --- Loose tool view. -----------------------------------------------------
// Mirrors knowledge-update-stale.test.ts's cast: the sweep addresses tools by
// a STRING type name, which the statically-typed surface narrows to a union.
type Loose = Record<string, unknown>;
type EField = { name: string; type: string; enum_values?: string[]; element_fields?: EField[] };
type SchemaReport = { required: string[]; optional: string[]; fields: EField[] };

function looseTools(t: unknown) {
  return t as unknown as {
    knowledgeCreate: (type: string, fields: Loose) => { record: Loose };
    knowledgeUpdate: (id: string, body: Loose) => Loose;
    knowledgeAppend: (id: string, field: string, entries: unknown[]) => Loose;
    knowledgeEdit: (id: string, field: string, find: string, replace: string) => Loose;
    knowledgeSchema: (type: string) => SchemaReport;
    knowledgeGet: (id: string) => Loose;
  };
}

// --- Minimal valid bodies, one per registered type. ------------------------
// These are FIXTURES (a known-good baseline to perturb), not oracles: every
// expected value asserted anywhere below is read from knowledge_schema at call
// time. Each body is the body-only form knowledge_create takes (no envelope),
// transcribed from the known-valid payloads in packages/schemas/src/tests/
// schemas.test.ts rather than guessed.
let fixtureSeq = 0;
function uniq(prefix: string) {
  fixtureSeq += 1;
  return `${prefix}-${fixtureSeq}`;
}

function validBodyFor(type: string): Loose | undefined {
  switch (type) {
    case 'feature_article':
      return articlePayload({ slug: uniq('refusal-sweep'), title: uniq('refusal-sweep') });
    case 'decision':
      return {
        title: uniq('sweep-decision'),
        statement: 'a statement',
        alternatives_rejected: [{ option: 'an option', reason: 'a reason' }],
        rationale: 'a rationale',
        file_keys: ['src/fixture.ts'],
      };
    case 'anti_pattern':
      return {
        title: uniq('sweep-anti-pattern'),
        trigger: 'when the fixture is needed',
        guidance: 'do the right thing',
        wrong_way: 'the wrong way',
        right_way: 'the right way',
        source_evidence: 'this test file',
        file_keys: ['src/fixture.ts'],
        severity: 'block',
      };
    case 'research_finding':
      return {
        question: 'is this fixture valid?',
        answer: 'yes',
        source_urls: [],
        source_date: '2026-01-01',
        capture_date: '2026-01-01',
        volatility_hint: 'medium',
      };
    case 'reference_material':
      return {
        title: uniq('sweep-reference'),
        kind: 'url',
        location: 'https://example.com/fixture',
        summary: 'a summary',
        source_date: '2026-01-01',
        capture_date: '2026-01-01',
        basis: 'platform',
      };
    case 'disconfirmed_hypothesis':
      return {
        question: 'was the cache stale?',
        rejected_answer: 'no — clock skew',
        evidence: 'this test file',
        file_keys: ['src/fixture.ts'],
      };
    case 'attestation':
      return {
        artifact_key: uniq('sweep-artifact'),
        verdict: 'approved',
        inspector: 'cuj',
        inspected_at: '2026-01-01',
        instrument: 'fixture',
        notes: 'fixture',
        file_keys: ['src/fixture.ts'],
      };
    case 'todo':
      return { text: uniq('sweep-task'), source: 'user' };
    case 'brief':
      return {
        slug: uniq('sweep-brief'),
        title: uniq('sweep-brief'),
        problem: 'no way to get data out',
        feature: 'export the board as CSV',
        user_stated: { criteria: ['must be Excel-openable'], constraints: [] },
        conductor_proposals: [{ text: 'stream rather than buffer', status: 'unconfirmed' }],
        acceptance_criteria: [
          { ac_id: 'AC1', text: 'user clicks Export and gets a file', verifiable_at: 'final' },
          { ac_id: 'AC2', text: 'header row present', verifiable_at: 'phase:1' },
        ],
        technical_design: { approach: 'serializer module', interfaces: [], shared_structures: [] },
        blast_radius: { files: [{ path: 'src/export/csv.ts', owning_articles: [] }], reconcile_list: [] },
        incidental_scope: ['src/board/types.ts'],
        out_of_scope: ['changing board storage'],
        phases: [
          {
            phase_id: 'p1',
            goal: 'serializer',
            subtasks: ['write serializer'],
            ac_ids: ['AC2'],
            difficulty: { level: 'normal', reasons: [] },
            model_hint: 'sonnet',
          },
        ],
        decisions_made: [],
      };
    default:
      return undefined;
  }
}

// Envelope/server-owned fields are EXCLUDED from the enum sweep: passing them
// is refused by a DIFFERENT (and correct) guard — "status/superseded_by are
// server-owned and refused loudly if you pass them" (CLAUDE.md; pinned in
// schema-nested-enums.test.ts AC4) — so a refusal there proves nothing about
// the enum renderer. The sweep asserts its own floor so this exclusion can
// never hollow it out.
const SERVER_OWNED_FIELDS = new Set(['id', 'type', 'status', 'superseded_by', 'version', 'created_at', 'updated_at', 'author']);

// =========================== message decoding ==============================

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary presence that does not treat '_' as a boundary, so 'files'
// never matches inside 'test_files' and 'role' never matches inside 'roles'.
function wordPresent(text: string, word: string) {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(word)}([^A-Za-z0-9_]|$)`).test(text);
}

function norm(s: string) {
  return s.replace(/\s+/g, '').toLowerCase();
}

// Every balanced group for a delimiter pair, innermost included, as inner text.
function delimitedGroups(text: string, open: string, close: string): string[] {
  const out: string[] = [];
  const stack: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === open) stack.push(i);
    else if (text[i] === close && stack.length > 0) out.push(text.slice(stack.pop()! + 1, i));
  }
  return out;
}

function tokensOf(text: string): string[] {
  return (text.match(/[A-Za-z_][A-Za-z0-9_:.\-]*/g) ?? []).map((t) => t.replace(/[.:\-]+$/, '').toLowerCase()).filter((t) => t.length > 0);
}

// Prose words a rendering may legitimately weave into a shape entry or a
// permitted-values list. Deliberately TYPE-FREE: 'string'/'number'/'boolean'
// are NOT here, so a type word appearing in an entry it does not belong to is
// caught rather than absorbed.
const STRUCTURAL_WORDS = new Set([
  'required',
  'optional',
  'one',
  'of',
  'or',
  'and',
  'either',
  'permitted',
  'allowed',
  'values',
  'value',
  'enum',
  'default',
  'defaults',
  'must',
  'be',
  'is',
  'are',
  'the',
  'a',
  'an',
]);

// Locate the group that renders the element shape: the SHORTEST balanced brace
// group naming every element field. Preference is given to a group that also
// carries the field TYPES, because knowledge_schema's own top-level type
// string for the field ('{path, role, unverified}[]') is itself a brace group
// naming every element field and would otherwise win on length.
function findShapeGroup(message: string, efs: EField[], label: string): string {
  const names = efs.map((e) => e.name);
  const groups = delimitedGroups(message, '{', '}').filter((g) => names.every((n) => wordPresent(g, n)));
  assert.ok(
    groups.length > 0,
    `${label}: the refusal must render the failing element's EXPECTED SHAPE as a brace-delimited listing naming every sub-field the schema walk reports (${names.join(', ')}). No such group was found, so the shape either is not rendered or uses a different form than this parser decodes — adjudicate the format once and retarget the parser; do not weaken this into a substring check. Full message: ${message}`
  );
  const withTypes = groups.filter((g) => efs.every((e) => norm(g).includes(norm(e.type))));
  const pool = withTypes.length > 0 ? withTypes : groups;
  return pool.reduce((shortest, g) => (g.length < shortest.length ? g : shortest), pool[0]);
}

// Split a shape group into per-field entries: commas/semicolons/newlines at
// depth 0, where depth counts {} [] () so a nested type ('{ac_id, text}[]') or
// an inline enum list ('[fast, medium, stable]') never splits an entry.
// QUOTE-AWARE: a rendered type may contain quoted literals ('literal "final" |
// string'), and a comma inside such a literal is part of the type, not a
// separator.
const ENTRY_HEAD = /^["'`]?[A-Za-z_][A-Za-z0-9_]*["'`]?\s*\??\s*:/;

function splitEntries(group: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of group) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  const trimmed = parts.map((p) => p.replace(/^[\s\-*•|]+/, '').replace(/[\s.,;]+$/, '')).filter((p) => p.length > 0);

  // DEFENSIVE RE-JOIN: a type carrying a depth-0, unquoted comma would have
  // been split mid-type above. Such a fragment is not a new entry — it has no
  // `name:` head — so it is folded back into the entry it belongs to. Only
  // applied when the previous part DOES have a `name:` head, so a renderer
  // that separates name from type some other way is unaffected.
  const merged: string[] = [];
  for (const part of trimmed) {
    if (merged.length > 0 && !ENTRY_HEAD.test(part) && ENTRY_HEAD.test(merged[merged.length - 1])) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}, ${part}`;
      continue;
    }
    merged.push(part);
  }
  return merged;
}

type ParsedEntry = { name: string; type?: string; marker?: 'required' | 'optional'; raw: string };

// PARSED FROM BOTH ENDS, never by splitting the middle. A rendered type is NOT
// a single token: the registry's ugliest one is
// `verifiable_at: literal "final" | string (required)`, whose type contains
// spaces, double quotes and a '|' (and could defensively contain parentheses or
// a comma). So: take the NAME up to the first separator, take the required-ness
// MARKER off the end, and the type is the WHOLE REMAINDER — tokenizing the
// middle truncated `literal "final" | string` to `literal` and produced a false
// red against a renderer that was in fact correct.
function parseEntry(entry: string): ParsedEntry | undefined {
  const m = /^["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*\??\s*(?:[:=]|\s|-)/.exec(entry) ?? /^["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?$/.exec(entry);
  if (!m) return undefined;
  const name = m[1];
  let rest = entry.slice(m[0].length).trim();

  // marker off the END first (the observed form is a trailing '(required)') …
  let marker: 'required' | 'optional' | undefined;
  const tail = /[\s(\[]*\b(required|optional)\b[\s)\]]*$/i.exec(rest);
  if (tail) {
    marker = tail[1].toLowerCase() as 'required' | 'optional';
    rest = rest.slice(0, tail.index).trim();
  } else {
    // … tolerating a leading-marker rendering too ('(required) string').
    const head = /^[\s(\[]*\b(required|optional)\b[\s)\]:]*/i.exec(rest);
    if (head) {
      marker = head[1].toLowerCase() as 'required' | 'optional';
      rest = rest.slice(head[0].length).trim();
    }
  }

  // everything that is left IS the type, verbatim — compared with whitespace
  // normalized on both sides by the caller.
  const type = rest.replace(/[\s,;]+$/, '').trim() || undefined;
  return { name, type, marker, raw: entry };
}

// THE EXACTNESS ORACLE. Structural comparison against knowledge_schema's live
// element_fields — never substring co-presence.
function assertShapeListedExactly(message: string, efs: EField[], label: string, requiredNames?: Set<string>) {
  const group = findShapeGroup(message, efs, label);
  const parsed = splitEntries(group)
    .map(parseEntry)
    .filter((p): p is ParsedEntry => p !== undefined);

  // (1) SET EQUALITY — kills S2 (a ghost 'ghost: number (optional)' entry) and
  // any silently-dropped field. An inclusion check cannot see either.
  assert.deepEqual(
    parsed.map((p) => p.name).sort(),
    efs.map((e) => e.name).sort(),
    `${label}: the rendered shape must list EXACTLY the sub-fields the schema walk reports — no extra (ghost) field, none missing. Rendered group was '{${group}}'; knowledge_schema reports [${efs.map((e) => e.name).join(', ')}]`
  );

  const usesMarkers = parsed.some((p) => p.marker !== undefined);

  for (const ef of efs) {
    const entry = parsed.find((p) => p.name === ef.name)!;

    // (2) TYPE BOUND TO ITS OWN FIELD — kills S4's type half. Co-presence of
    // the word 'string' somewhere in the message is not evidence that THIS
    // field is a string.
    //
    // TWO HALVES, both exact. A sub-field carrying a closed enum is rendered
    // with its permitted values INLINE — 'rel: enum (one of: cites,
    // informed_by, fulfills, supersedes) (required)' — which is clause 4
    // applied at the element level and is correct, not noise. Comparing the
    // whole thing against `type` alone would read that legitimate enrichment
    // as a mismatch. So the base type is compared against the walk's `type`
    // and the members against the walk's `enum_values`, separately and
    // exactly; neither half is relaxed to a substring check. (The member half
    // is asserted as a SET at (6) below, on the same entry text.)
    const declaredType = entry.type ?? '';
    const carriesMembers =
      ef.enum_values !== undefined && ef.enum_values.length > 0 && ef.enum_values.every((v) => wordPresent(declaredType, v));

    if (carriesMembers) {
      // Excise the permitted-values listing, then require what REMAINS to be
      // exactly the walk's type. The "(one of: …)" wrapper is tolerated as a
      // rendering form; a wrong base type ('string' where the walk says
      // 'enum') still fails, as does any foreign token left behind.
      const memberRegion = extractDelimitedList(declaredType, ef.enum_values!, `${label}.${ef.name}`);
      const expectedTypeTokens = tokensOf(ef.type);
      const baseTokens = tokensOf(declaredType.replace(memberRegion, ' ')).filter(
        (tk) => expectedTypeTokens.includes(tk) || !STRUCTURAL_WORDS.has(tk)
      );
      assert.deepEqual(
        baseTokens.slice().sort(),
        expectedTypeTokens.slice().sort(),
        `${label}: with the permitted-values listing excised, the type rendered for '${ef.name}' must be exactly the walk's type ('${ef.type}'). Entry was '${entry.raw}'; remainder tokenized to ${JSON.stringify(baseTokens)}`
      );
    } else {
      assert.equal(
        norm(declaredType),
        norm(ef.type),
        `${label}: the type rendered for '${ef.name}' must be ITS OWN type from the schema walk ('${ef.type}'), not merely a type present somewhere in the message. Entry was '${entry.raw}'`
      );
    }

    // (3) EVERY entry carries its own required-ness marker — kills S4's marker
    // half: a 'required' that drifted into the wrong entry leaves the right
    // entry bare, which an over-wide substring window cannot detect.
    if (usesMarkers) {
      assert.ok(
        entry.marker !== undefined,
        `${label}: '${ef.name}' must carry its OWN required/optional marker (clause 3 names required-ness per field). Some entry in this listing has one, so a bare entry means a marker is bound to the wrong field. Entry was '${entry.raw}'`
      );
    }

    // (4) marker VALUE, where required-ness was derived empirically from the
    // schema's own enforcement (see deriveRequiredElementFields).
    if (requiredNames && entry.marker) {
      assert.equal(
        entry.marker,
        requiredNames.has(ef.name) ? 'required' : 'optional',
        `${label}: '${ef.name}' is marked '${entry.marker}', but the schema's OWN enforcement (omit-one-field probe) says it is ${requiredNames.has(ef.name) ? 'REQUIRED' : 'OPTIONAL'}. Entry was '${entry.raw}'`
      );
    }

    // (5) ENTRY VOCABULARY — nothing in an entry that the schema walk does not
    // report for that field. Catches a foreign/ghost token smuggled into an
    // otherwise well-formed entry.
    const allowed = new Set<string>([
      ...tokensOf(ef.name),
      ...tokensOf(ef.type),
      ...(ef.enum_values ?? []).flatMap((v) => tokensOf(v)),
      ...STRUCTURAL_WORDS,
    ]);
    for (const tok of tokensOf(entry.raw)) {
      assert.ok(
        allowed.has(tok),
        `${label}: the entry for '${ef.name}' names '${tok}', which the schema walk does not report for it — a foreign token in a derived shape means the text is not derived. Entry was '${entry.raw}'`
      );
    }

    // (6) a nested closed enum inside the element is listed as an exact SET.
    if (ef.enum_values && ef.enum_values.length > 0) {
      assertExactEnumSet(entry.raw, ef.enum_values, `${label}.${ef.name}`, [ef.name, ef.type]);
    }
  }
}

// Locate the region rendering a permitted-values SET: prefer the shortest
// balanced [..] / {..} / (..) group naming every member; failing that, the
// minimal window covering all members, extended across trailing/leading
// list separators so a spuriously appended member ('glacial') falls INSIDE
// the region rather than escaping just past its edge.
function extractDelimitedList(message: string, members: string[], label: string): string {
  const candidates: string[] = [];
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
    ['(', ')'],
  ] as const) {
    for (const g of delimitedGroups(message, open, close)) {
      if (members.every((m) => wordPresent(g, m))) candidates.push(g);
    }
  }
  if (candidates.length > 0) {
    return candidates.reduce((shortest, g) => (g.length < shortest.length ? g : shortest), candidates[0]);
  }

  // fallback: minimal covering window, then grow across list separators
  let lo = Number.POSITIVE_INFINITY;
  let hi = -1;
  for (const m of members) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRe(m)})([^A-Za-z0-9_]|$)`, 'g');
    const hit = re.exec(message);
    assert.ok(
      hit !== null,
      `${label}: the refusal must name permitted value '${m}'. Full message: ${message}`
    );
    const start = hit!.index + hit![1].length;
    lo = Math.min(lo, start);
    hi = Math.max(hi, start + m.length);
  }
  let end = hi;
  for (;;) {
    const tail = /^\s*[,|/]\s*[A-Za-z_][A-Za-z0-9_:.\-]*/.exec(message.slice(end));
    if (!tail) break;
    end += tail[0].length;
  }
  let begin = lo;
  for (;;) {
    const head = /[A-Za-z_][A-Za-z0-9_:.\-]*\s*[,|/]\s*$/.exec(message.slice(0, begin));
    if (!head) break;
    begin -= head[0].length;
  }
  return message.slice(begin, end);
}

// Enum SET equality — kills S3 ('fast, medium, stable, glacial' passes every
// inclusion check ever written).
//
// `allowExtra` absorbs the tokens a located list region may legitimately carry
// besides the members themselves — the owning field's own name and its type
// word, e.g. when the region resolves to '{volatility_hint: fast|medium|stable}'
// or to a whole shape entry. It never absorbs a foreign enum member, which is
// the thing being detected.
function assertExactEnumSet(region: string, members: string[], label: string, allowExtra: string[] = []) {
  const listRegion = extractDelimitedList(region, members, label);
  const expected = new Set([...members.flatMap((m) => tokensOf(m)), ...allowExtra.flatMap((x) => tokensOf(x)), ...label.split(/[^A-Za-z0-9_]+/).map((s) => s.toLowerCase()).filter((s) => s.length > 0)]);
  const found = tokensOf(listRegion).filter((t) => !STRUCTURAL_WORDS.has(t));
  const foreign = found.filter((t) => !expected.has(t));
  assert.deepEqual(
    foreign,
    [],
    `${label}: the permitted-values listing must be EXACTLY the schema's closed set [${members.join(', ')}] — it also names ${JSON.stringify(foreign)}, which the enum does not contain. Listing region was '${listRegion}'`
  );
  for (const m of members) {
    assert.ok(
      wordPresent(listRegion, m),
      `${label}: permitted value '${m}' must appear inside the permitted-values listing itself, not merely somewhere in the message. Listing region was '${listRegion}'`
    );
  }
}

// Empirical required-ness for an element shape, derived from the SCHEMA'S OWN
// ENFORCEMENT: synthesize a fully-populated element from the reported types,
// confirm it is accepted, then omit each sub-field in turn — refusal means
// required. Returns undefined (assertions degrade to marker-presence only)
// whenever a type cannot be synthesized or the all-present baseline is itself
// refused, so a field with a refinement this test cannot satisfy never
// produces a false verdict.
// A uuid is used for 'string' rather than a short token like 'x' because it
// satisfies the STRICTEST plausible string constraint as well as the loosest:
// z.string(), z.string().min(1), z.string().uuid() and a repo-path field all
// accept it. That matters for sibling fields — a link element's reference
// target is uuid-shaped, and a sibling that fails validation would add a second
// issue to the refusal and could mask the one under test.
function synthValue(ef: EField): unknown {
  if (ef.enum_values && ef.enum_values.length > 0) return ef.enum_values[0];
  switch (norm(ef.type)) {
    case 'string':
      return randomUUID();
    case 'string[]':
      return [randomUUID()];
    case 'boolean':
      return true;
    case 'number':
      return 1;
    default:
      return undefined;
  }
}

function deriveRequiredElementFields(
  t: ReturnType<typeof looseTools>,
  type: string,
  field: string,
  efs: EField[]
): Set<string> | undefined {
  const full: Loose = {};
  for (const ef of efs) {
    const v = synthValue(ef);
    if (v === undefined) return undefined;
    full[ef.name] = v;
  }
  try {
    t.knowledgeCreate(type, { ...validBodyFor(type)!, [field]: [full] });
  } catch {
    return undefined;
  }
  const required = new Set<string>();
  for (const ef of efs) {
    const minus: Loose = { ...full };
    delete minus[ef.name];
    try {
      t.knowledgeCreate(type, { ...validBodyFor(type)!, [field]: [minus] });
    } catch {
      required.add(ef.name);
    }
  }
  return required;
}

// ---------------------------------------------------------------------------
// STRATEGY B — the derivation proof. Every registered record type, every
// array-of-objects field the schema walk reports for it.
//
// SABOTAGE THAT MAKES THIS RED:
//  * replace the derived renderer with ANY hardcoded literal (S1) — it cannot
//    be right for feature_article.history AND .files AND .current_ac AND
//    .live_test_refs AND decision.alternatives_rejected AND brief.phases …
//    simultaneously; the set-equality assertion fires on the first mismatch.
//  * add a ghost field to the derived output (S2) — set equality fires.
//  * swap two fields' types or markers (S4) — per-entry binding fires.
//  * make the owner lookup key off anything other than the failing field
//    itself (e.g. reuse another type's field of the same name) — the shape
//    listed for brief.acceptance_criteria would then be feature_article's
//    current_ac shape and set equality fires.
// ---------------------------------------------------------------------------
test('DERIVATION-B: for EVERY registered record type and EVERY array-of-objects field the schema walk reports, a bad element refusal enumerates EXACTLY that field\'s element shape (registry enumerated at runtime — a new record type is covered automatically)', async () => {
  const { tools, cleanup } = harness();
  const t = looseTools(tools);
  try {
    const types = await registeredRecordTypes();

    // FIXTURE TOTALITY: a record type added later must not slip through
    // silently uncovered. This is the "automatically cover it" mechanism —
    // the sweep fails BY NAME rather than quietly sweeping 8 of 9 types.
    for (const type of types) {
      assert.ok(
        validBodyFor(type) !== undefined,
        `record type '${type}' is in RECORD_TYPES but this sweep has no minimal valid fixture for it — a new type was registered without extending validBodyFor, so the derivation sweep would silently skip it. Add a minimal valid body (see the fixtures above) rather than narrowing the sweep.`
      );
    }

    // FIXTURE VALIDITY GATE: each baseline must actually be accepted, so a
    // later shape failure is unambiguously the perturbation we introduced and
    // not a stale fixture. Failures are COLLECTED, not thrown one at a time,
    // so a single red run names every non-creatable type — and the gate is
    // asserted at the very END of this test, after the derivation work has
    // run over the types that do work. (Two types are known candidates for a
    // legitimate refusal here, since neither was verifiable from the surfaces
    // available while authoring: `todo`, whose documented write path is
    // board_add, and `brief`, which may have its own tool. If either refuses,
    // that is a one-time adjudication of which surface the sweep should use —
    // not a reason to narrow the sweep.)
    const baselineRefused: string[] = [];
    const usable: string[] = [];
    for (const type of types) {
      try {
        t.knowledgeCreate(type, validBodyFor(type)!);
        usable.push(type);
      } catch (e) {
        baselineRefused.push(`${type}: ${(e as Error).message}`);
      }
    }

    // Collect (type, field) pairs from the LIVE schema walk.
    const pairs: { type: string; field: string; efs: EField[] }[] = [];
    for (const type of usable) {
      const report = t.knowledgeSchema(type);
      assert.ok(Array.isArray(report.fields), `knowledge_schema('${type}') must report a fields array`);
      for (const f of report.fields) {
        if (Array.isArray(f.element_fields) && f.element_fields.length > 0) {
          pairs.push({ type, field: f.name, efs: f.element_fields });
        }
      }
    }

    // ANTI-VACUITY. If element_fields reporting regressed to empty, the loop
    // below would run zero times and this test would pass while proving
    // nothing — the exact defect class board 5402a024 names.
    assert.ok(
      pairs.length >= 4,
      `the sweep must find at least 4 array-of-objects fields across the registry (feature_article's files/current_ac/history/live_test_refs and decision's alternatives_rejected are the ones already pinned as element_fields-reporting elsewhere in the suite); found ${pairs.length}: ${JSON.stringify(pairs.map((p) => `${p.type}.${p.field}`))}. A near-empty sweep means knowledge_schema stopped reporting element_fields, which would make every assertion here vacuous — the board 5402a024 defect class.`
    );
    assert.ok(
      new Set(pairs.map((p) => p.type)).size >= 2,
      `the sweep must span at least 2 record types — breadth across types is what a hand-written literal cannot satisfy; got ${JSON.stringify([...new Set(pairs.map((p) => p.type))])}`
    );

    for (const { type, field, efs } of pairs) {
      // NEUTRAL PAYLOAD, deliberately: the submitted value carries none of the
      // tokens asserted below ('string', 'object', any sub-field name), so a
      // refusal that merely echoes the received value cannot satisfy them. A
      // descriptive payload here would make these assertions self-fulfilling.
      const message = captureThrow(
        () => t.knowledgeCreate(type, { ...validBodyFor(type)!, [field]: ['BARE_VALUE_42'] }),
        `${type}.${field}[0] bare-scalar element`
      );

      // caller-facing path with the index (clause 1), for every field, not
      // just history.
      assert.ok(
        message.includes(`${field}[0]`),
        `${type}: the refusal must name the exact failing element as '${field}[0]' in caller-facing form; got: ${message}`
      );
      assert.match(message, /string/i, `${type}.${field}: names what was RECEIVED (a string)`);
      assert.match(message, /object/i, `${type}.${field}: names what was EXPECTED (an object)`);

      // THE DERIVATION ASSERTION.
      const requiredNames = deriveRequiredElementFields(t, type, field, efs);
      assertShapeListedExactly(message, efs, `${type}.${field}`, requiredNames);

      assertNoRawZodLeak(message, `${type}.${field}[0] refusal`);
    }

    // The gate, asserted LAST so the derivation verdict above is available in
    // the same run: no registered type may be excluded from the sweep by a
    // refused baseline.
    assert.deepEqual(
      baselineRefused,
      [],
      `every registered record type must have an accepted minimal fixture, or it is silently excluded from the derivation sweep. Refused: ${JSON.stringify(baselineRefused, null, 2)}`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// STRATEGY B, enum half — every closed enum the schema walk reports, at the
// TOP level of every registered type, listed as an exact set.
//
// SABOTAGE THAT MAKES THIS RED: hardcode any single enum's members (S1 for
// enums) — the sweep spans volatility_hint, kind, basis, severity, source,
// state, verdict and whatever else the registry defines; add an invalid extra
// member to any of them (S3) — set equality fires; name a DIFFERENT field's
// members at this path — set equality fires.
// ---------------------------------------------------------------------------
test('DERIVATION-B (enums): for EVERY registered type and EVERY top-level closed-enum field, an invalid value refusal lists EXACTLY the schema\'s permitted set — no extras, no other field\'s members', async () => {
  const { tools, cleanup } = harness();
  const t = looseTools(tools);
  try {
    const types = await registeredRecordTypes();
    const BOGUS = 'definitely_not_a_member';
    const enumPairs: { type: string; field: string; members: string[]; isArray: boolean; fieldType: string }[] = [];

    for (const type of types) {
      for (const f of t.knowledgeSchema(type).fields) {
        if (SERVER_OWNED_FIELDS.has(f.name)) continue;
        if (Array.isArray(f.enum_values) && f.enum_values.length > 0) {
          enumPairs.push({ type, field: f.name, members: f.enum_values, isArray: /\[\]\s*$/.test(f.type), fieldType: f.type });
        }
      }
    }

    // ANTI-VACUITY, and a guard on SERVER_OWNED_FIELDS: the exclusion list
    // must never be what makes this sweep empty.
    assert.ok(
      enumPairs.length >= 5,
      `the enum sweep must find at least 5 caller-writable closed-enum fields across the registry (research_finding.volatility_hint, reference_material.kind, anti_pattern.severity, todo.source, feature_article.state are five on their own); found ${enumPairs.length}: ${JSON.stringify(enumPairs.map((p) => `${p.type}.${p.field}`))}`
    );

    for (const { type, field, members, isArray, fieldType } of enumPairs) {
      const message = captureThrow(
        () => t.knowledgeCreate(type, { ...validBodyFor(type)!, [field]: isArray ? [BOGUS] : BOGUS }),
        `${type}.${field} invalid enum value`
      );

      assert.ok(
        message.includes(field),
        `${type}: the refusal must name the failing field '${field}'; got: ${message}`
      );
      // clause 4, exactly: the permitted SET, pulled live, nothing else.
      assertExactEnumSet(message, members, `${type}.${field}`, [field, fieldType]);
      const region = extractDelimitedList(message, members, `${type}.${field}`);
      assert.ok(
        !wordPresent(region, BOGUS),
        `${type}.${field}: the rejected value must never appear inside the permitted-values listing. Listing region was '${region}'`
      );
      assertNoRawZodLeak(message, `${type}.${field} enum refusal`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ITEM 1 — NESTED ENUM (an enum below the top level).
//
// A REAL SUBJECT EXISTS, and this test covers it: `links[].rel` is a closed
// enum of exactly cites / informed_by / fulfills / supersedes, and `links` is
// present on EVERY record type — so the sweep below covers the nested-enum
// path once per registered type, not zero times.
//
// PROVENANCE, because I originally reported the opposite: I could not see
// links[].rel from the surfaces available to a spec-only role — the H4 read
// wall denies records.ts to the test-writer (by design), and the fact is not
// visible in any existing test file. It was supplied by the conductor. That
// gap is boarded (670b2b44); this case is its concrete evidence, and the
// cheapest fix shape it points to is granting spec-only roles the
// knowledge_schema tool, which would have handed over the fact directly with
// no file read and no change to the wall.
//
// The candidates I could see and correctly ruled out stay ruled out:
// current_ac[].verifiable_at is validated by SYNTAX ('final' ok, 'phase1'
// rejected, 'phase:1' ok) — a literal-union/regex reporting invalid_union with
// no options, exactly the trap the work order warned about — and files[].role
// is a free string (schemas.test.ts uses both 'impl' and 'serializer').
//
// The test stays DERIVATION-DRIVEN: it asks the schema walk for element-level
// enums rather than naming links[].rel, so any future nested enum is covered
// automatically. What replaced the old "if none exists" branch is a FLOOR (see
// below) — an unreachable path was not left behind.
//
// This also pins something stronger than the reviews expected: the renderer
// resolves nested enum members properly rather than degrading to a
// less-specific fallback at depth.
//
// SABOTAGE THAT MAKES THIS RED: resolve the permitted set at a nested path
// from anywhere but that same walk's enum_values for that sub-field — a
// hardcoded set, the parent field's set, or a top-level field's set; exact set
// equality on the located region fires on any of them.
// ---------------------------------------------------------------------------
test('ITEM 1: a closed enum NESTED below the top level lists the permitted values belonging to the field at the RENDERED PATH — and never another field\'s values', async () => {
  const { tools, cleanup } = harness();
  const t = looseTools(tools);
  try {
    const types = await registeredRecordTypes();
    const nested: { type: string; field: string; efs: EField[]; ef: EField }[] = [];
    for (const type of types) {
      for (const f of t.knowledgeSchema(type).fields) {
        for (const ef of f.element_fields ?? []) {
          if (Array.isArray(ef.enum_values) && ef.enum_values.length > 0) {
            nested.push({ type, field: f.name, efs: f.element_fields!, ef });
          }
        }
      }
    }

    // ANTI-VACUITY FLOOR (replaces the earlier "if none exists, document it"
    // branch, which is now unreachable and was removed rather than left as a
    // dead path). A real element-level enum exists — links[].rel, on every
    // record type — so an EMPTY discovery result no longer means "nothing to
    // cover", it means the nested enum_values projection regressed and every
    // assertion below would be silently skipped. That is the board 5402a024
    // defect class, so it fails loudly here instead.
    const inventory = types.flatMap((type) =>
      t.knowledgeSchema(type).fields.flatMap((f) =>
        (f.element_fields ?? []).map((ef) => `${type}.${f.name}[].${ef.name}:${ef.type}${ef.enum_values ? ` enum=${JSON.stringify(ef.enum_values)}` : ''}`)
      )
    );
    assert.ok(
      nested.length > 0,
      `at least one element-level closed enum must be discoverable from the schema walk for this test to have a subject: links[].rel (cites/informed_by/fulfills/supersedes) is one, and 'links' is a field of every record type. Found none, which means the enum was removed or knowledge_schema stopped reporting enum_values on nested sub-fields — either way the nested-enum path is now untested. Element-field inventory: ${JSON.stringify(inventory)}`
    );

    for (const { type, field, efs, ef } of nested) {
      const element: Loose = {};
      let synthesizable = true;
      for (const sib of efs) {
        const v = synthValue(sib);
        if (v === undefined) synthesizable = false;
        else element[sib.name] = v;
      }
      element[ef.name] = 'definitely_not_a_member';
      const message = captureThrow(
        () => t.knowledgeCreate(type, { ...validBodyFor(type)!, [field]: [element] }),
        `${type}.${field}[0].${ef.name} invalid nested enum value${synthesizable ? '' : ' (siblings partially synthesized)'}`
      );

      // the RENDERED PATH must reach the nested field, not stop at the array.
      assert.ok(
        message.includes(`${field}[0]`) && wordPresent(message, ef.name),
        `${type}: the refusal must name the nested failing path (${field}[0].${ef.name}); got: ${message}`
      );
      // the permitted set belongs to THIS field: exact set equality means no
      // sibling's or other type's members can appear here.
      assertExactEnumSet(message, ef.enum_values!, `${type}.${field}[].${ef.name}`, [field, ef.name, ef.type]);
      assertNoRawZodLeak(message, `${type}.${field}[0].${ef.name} nested enum refusal`);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ITEM 2 — NON-ZOD PASS-THROUGH. A store/tool failure that is NOT a zod
// validation issue must surface with its OWN message, unchanged, and must not
// be dressed up as a validation failure by the new renderer.
//
// The provocable non-validation failure on this exact boundary is the
// stale-address VERSION CONFLICT already pinned by
// knowledge-update-stale.test.ts (its fixture pattern — raw legacy rows via
// store.create — is reused here verbatim, so nothing about the implementation
// had to be read to build it).
//
// SABOTAGE THAT MAKES THIS RED: wrap the whole knowledge_append body in the
// new render-validation-failure catch (rather than catching ZodError only), so
// every refusal from that path acquires the validation idiom — /version
// conflict/ and /nothing was written/ then vanish from the message.
// ---------------------------------------------------------------------------
test('ITEM 2: a NON-validation failure (stale-address version conflict) keeps its own message and is NEVER re-rendered as a validation failure', () => {
  const { store, tools, cleanup } = harness();
  const t = looseTools(tools);
  try {
    const mkLegacy = (id: string, slug: string, version: number, supersededBy: string | null) =>
      store.create({
        id,
        type: 'feature_article',
        created_at: NOW,
        updated_at: NOW,
        author: 'conductor',
        status: supersededBy ? 'superseded' : 'active',
        superseded_by: supersededBy,
        links: [],
        scope: 'project',
        stack_tags: ['node'],
        slug,
        title: slug,
        what_it_does: `${slug} does things`,
        intended_behavior: `${slug} intends`,
        files: [{ path: 'src/x.mjs', role: 'owner' }],
        current_ac: [],
        dependencies: { relies_on: [], relied_by: [] },
        state: 'active',
        version,
        history: [{ date: NOW, event: 'genesis' }],
        live_test_refs: [],
      } as never) as unknown as Loose;

    const head = mkLegacy(randomUUID(), 'passthrough-subject', 2, null);
    const stale = mkLegacy(randomUUID(), 'passthrough-subject', 1, head.id as string);

    // A perfectly VALID history entry, addressed to a stale record: the only
    // thing wrong here is the address, so no validation idiom may appear.
    const message = captureThrow(
      () => t.knowledgeAppend(stale.id as string, 'history', [{ date: NOW, event: 'stale append' }]),
      'stale-address append with a VALID entry'
    );

    assert.match(message, /version conflict/i, 'the non-validation refusal keeps its own discriminator, unchanged');
    assert.match(message, /nothing was written/i, 'and its own disclosure that no write landed');

    // It must NOT be re-rendered in the validation idiom: no expected-shape
    // listing for history, and no invented validation path.
    const historyEfs = (t.knowledgeSchema('feature_article').fields.find((f) => f.name === 'history')?.element_fields ?? []).map((e) => e.name);
    assert.ok(historyEfs.length > 0, 'sanity: knowledge_schema reports history\'s element sub-fields (the tokens a wrongly-rendered validation message would carry)');
    for (const group of delimitedGroups(message, '{', '}')) {
      assert.ok(
        !historyEfs.every((n) => wordPresent(group, n)),
        `a non-validation failure must not carry the expected-SHAPE listing — the shape renderer belongs to zod issues only. Offending group '{${group}}' in: ${message}`
      );
    }
    assert.ok(
      !/history\[\d+\]/.test(message),
      `a non-validation failure must not invent a validation element path; got: ${message}`
    );
    assertNoRawZodLeak(message, 'stale-address append');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ITEM 3 — knowledge_edit INHERITANCE. The claim under test is that
// knowledge_edit inherits the fix by delegating to the same validation path as
// knowledge_append/knowledge_create. Pinned the only way that is actually
// provable from outside: the SAME violation on the SAME record, provoked
// through knowledge_update and through knowledge_edit, must produce the
// IDENTICAL refusal body once the tool-name prefix is stripped.
//
// (knowledge_edit only ever rewrites a long STRING field, so it cannot reach
// the array-element shape renderer at all — the provocable zod failure is an
// empty value on a min(1) string. concept_family is used because
// packages/schemas/src/tests/schemas.test.ts already pins that '' is rejected
// there, so the violation is a known schema fact rather than a guess.)
//
// SABOTAGE THAT MAKES THIS RED: give knowledge_edit its own catch/message for
// validation failures instead of routing through the shared renderer — the two
// bodies immediately stop matching.
// ---------------------------------------------------------------------------
test('ITEM 3: knowledge_edit inherits the rendered refusal — the same violation through knowledge_update and knowledge_edit yields the identical body (only the tool name differs)', () => {
  const { tools, cleanup } = harness();
  const t = looseTools(tools);
  try {
    const created = t.knowledgeCreate(
      'feature_article',
      articlePayload({ slug: 'edit-inheritance-subject', title: 'edit-inheritance-subject', concept_family: 'weapons' })
    ).record;
    const id = created.id as string;

    const viaUpdate = captureThrow(() => t.knowledgeUpdate(id, { concept_family: '' }), 'knowledge_update -> empty concept_family');
    const viaEdit = captureThrow(() => t.knowledgeEdit(id, 'concept_family', 'weapons', ''), 'knowledge_edit -> empty concept_family');

    // basics first, so a body mismatch is diagnosed against a known-good floor
    for (const [label, msg] of [
      ['knowledge_update', viaUpdate],
      ['knowledge_edit', viaEdit],
    ] as const) {
      assert.ok(msg.includes('concept_family'), `${label}: the refusal names the caller-facing field path; got: ${msg}`);
      assertNoRawZodLeak(msg, `${label} empty concept_family`);
    }

    const stripTool = (m: string) => m.replace(/^\s*knowledge_[a-z_]+\s*:\s*/i, '').trim();
    assert.equal(
      stripTool(viaEdit),
      stripTool(viaUpdate),
      `knowledge_edit must delegate to the SAME validation-refusal renderer, not carry a second description of the same failure. Bodies differ:\n  via knowledge_edit:   ${viaEdit}\n  via knowledge_update: ${viaUpdate}`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ITEM 4 — DEEP OBJECT-IN-OBJECT, with a COLLIDING key name.
//
// The reviewers flagged that the owner lookup for the expected-shape text keys
// off the second-to-last path segment against TOP-LEVEL field names — correct
// for every shape in the registry today, but it would print a confidently
// wrong shape if a nested key ever collided with a top-level array-of-objects
// field name.
//
// Such a shape DOES exist, so nothing is invented here: brief.blast_radius is
// an object whose `files` member is an array of objects
// ({path, owning_articles}) — and `files` is ALSO the name of
// feature_article's top-level array-of-objects field, whose element shape is
// {path, role, unverified}. The failing path is therefore
// blast_radius.files[0], whose second-to-last segment is the colliding name
// 'files'.
//
// THE LOAD-BEARING CONTRACT is the negative: never print a confidently WRONG
// shape. The positive is deliberately a disjunction — resolve the true nested
// shape, or list no element shape at all — because "must resolve arbitrarily
// deep nested shapes" is not a behavior the work order declares, and inventing
// it here would manufacture a false requirement.
//
// SABOTAGE THAT MAKES THIS RED: resolve the expected shape by matching the
// path's second-to-last segment against the union of every type's top-level
// fields (or against feature_article's, or against a global name->shape map) —
// the refusal then describes brief.blast_radius.files[0] using
// feature_article.files' {path, role, unverified}, and the 'role'/'unverified'
// assertions fire.
// ---------------------------------------------------------------------------
test('ITEM 4: a deep object-in-object failure whose nested key COLLIDES with another type\'s top-level array-of-objects field never borrows that type\'s shape (brief.blast_radius.files[0] vs feature_article.files)', () => {
  const { tools, cleanup } = harness();
  const t = looseTools(tools);
  try {
    const brief = validBodyFor('brief')!;

    // precondition: the collision is real, and the two shapes really differ.
    const faFiles = t.knowledgeSchema('feature_article').fields.find((f) => f.name === 'files');
    const faNames = (faFiles?.element_fields ?? []).map((e) => e.name);
    assert.ok(faNames.length > 0, "sanity: knowledge_schema reports feature_article.files' element sub-fields");
    const discriminators = faNames.filter((n) => n !== 'path');
    assert.ok(
      discriminators.length > 0,
      `sanity: feature_article.files' element shape must carry at least one sub-field beyond 'path' (got [${faNames.join(', ')}]) — those are the tokens that expose a borrowed shape`
    );

    // NEUTRAL PAYLOAD (load-bearing here): a descriptive value mentioning
    // 'owning_articles' or containing braces would satisfy the positive
    // assertion below out of the echoed received value alone — the assertion
    // would then be pinning my own input string, not the renderer.
    const message = captureThrow(
      () =>
        t.knowledgeCreate('brief', {
          ...brief,
          blast_radius: { files: ['BARE_VALUE_42'], reconcile_list: [] },
        }),
      'brief.blast_radius.files[0] bare-scalar element'
    );

    // clause 1/8 — a usable path naming BOTH segments.
    assert.ok(message.includes('blast_radius'), `the refusal names the outer object field; got: ${message}`);
    assert.ok(
      message.includes('files[0]'),
      `the refusal names the exact failing nested element (files[0]); got: ${message}`
    );

    // THE NEGATIVE (load-bearing): never feature_article.files' shape.
    for (const tok of discriminators) {
      assert.ok(
        !wordPresent(message, tok),
        `the refusal must NOT describe brief.blast_radius.files[] using feature_article.files' element shape — '${tok}' is a sub-field of a DIFFERENT type's top-level 'files' field and has no business at this path. Got: ${message}`
      );
    }

    // THE POSITIVE (disjunction, deliberately): the true nested shape, or no
    // element shape at all. A confidently wrong shape is the only failure.
    const namesTrueShape = wordPresent(message, 'owning_articles');
    const namesNoShape = delimitedGroups(message, '{', '}').length === 0;
    assert.ok(
      namesTrueShape || namesNoShape,
      `at a nested path the refusal must either resolve the TRUE element shape ({path, owning_articles}) or render no element shape at all — it must never render a shape it cannot actually derive for this path. Got: ${message}`
    );

    assertNoRawZodLeak(message, 'brief.blast_radius.files[0] refusal');
  } finally {
    cleanup();
  }
});
