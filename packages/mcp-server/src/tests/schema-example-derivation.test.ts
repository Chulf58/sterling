import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { RECORD_TYPES } from '@sterling/schemas';
import { SterlingTools } from '../tools.js';

// ---------------------------------------------------------------------------
// board 89672420 (spec: knowledge_schema must return a shape-correct EXAMPLE
// value per field, DERIVED from the registered zod schema, never
// hand-maintained). Three pins, authored spec-first and BLIND to whatever the
// coder lands in packages/mcp-server/ and packages/schemas/ concurrently.
//
// THE ASK, verbatim from the board item: "`knowledge_schema(<type>)` returns
// each field with `required`, its type, and closed enum values — but no
// EXAMPLE of a correctly-shaped value... `alternatives_rejected` being
// `{option, reason}[]` rather than `string[]` is the canonical case."
// DONE WHEN: "knowledge_schema returns a shape-correct example per field (or
// per type) derived from the registered schema, not hand-maintained; the
// alternatives_rejected case specifically is covered; and a pin asserts the
// example stays derived so it cannot rot into a second copy."
//
// TODAY (pre-fix), all three tests below are expected to fail because no
// field reports a non-empty `example` at all — see each test's own EXPECTED
// FAILURE SHAPE comment for the exact assertion that fires first.
// ---------------------------------------------------------------------------

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-schema-example-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type FieldDescriptor = {
  name: string;
  type: string;
  example?: unknown;
  enum_values?: string[];
  server_owned?: boolean;
  element_fields?: FieldDescriptor[];
};
type SchemaReport = { type: string; fields: FieldDescriptor[]; required: string[]; optional: string[] };

function schemaOf(tools: SterlingTools, type: string): SchemaReport {
  return (tools as unknown as { knowledgeSchema: (t: string) => SchemaReport }).knowledgeSchema(type);
}

// A FieldShape.example is documented (describe-zod-projection.test.ts AC(c))
// as a non-empty STRING on the field descriptor. For a scalar (string-typed)
// field the string IS the value; for a non-scalar field (array/object) the
// string must be a JSON-serialization of the example value, because there is
// no other way to carry a structured value inside a string-typed field. This
// helper decodes either form without assuming which one a given field uses.
function valueFromExample(example: unknown): unknown {
  if (typeof example !== 'string') return example;
  try {
    return JSON.parse(example);
  } catch {
    return example;
  }
}

// ===========================================================================
// PIN 1 — SHAPE CORRECTNESS. The canonical case named by the external report:
// alternatives_rejected's example must be {option, reason}[], never string[].
//
// EXPECTED FAILURE SHAPE (red, pre-fix): `alts?.example` is `undefined` today
// (knowledge_schema reports no `example` field at all), so the very first
// assertion — 'alternatives_rejected carries a non-empty example' — fails.
// Once an example exists, this test is also the regression guard against the
// exact bug named in the board item: an example of `["reason one", "reason
// two"]` (string[], the wrong shape) parses as an array of strings, and the
// per-element `typeof el === 'object'` check fails naming the string found.
//
// NAMED SABOTAGE: hand-write `alternatives_rejected`'s example as a bare
// string[] literal (e.g. `["no time", "too risky"]`) instead of deriving it
// from the schema's actual {option, reason} object member — the per-element
// object/option/reason assertions go red immediately, and they do so on a
// value that "looks like a plausible example" in isolation.
// ===========================================================================

test('PIN 1 (shape correctness): knowledge_schema(decision).alternatives_rejected example is {option, reason}[] — never string[]', () => {
  const { tools, cleanup } = harness();
  try {
    const dec = schemaOf(tools, 'decision');
    const alts = dec.fields.find((f) => f.name === 'alternatives_rejected');
    assert.ok(alts, 'alternatives_rejected is reported at all');
    assert.equal(alts?.type, '{option, reason}[]', 'top-level type string unchanged by this fix');
    assert.ok(
      typeof alts?.example === 'string' && (alts!.example as string).length > 0,
      'alternatives_rejected carries a non-empty example — the exact field the external report named as causing 4 of 6 rejected writes'
    );

    const parsed = valueFromExample(alts!.example);
    assert.ok(Array.isArray(parsed), `alternatives_rejected example decodes to an array; got: ${JSON.stringify(parsed)}`);
    const arr = parsed as unknown[];
    assert.ok(arr.length > 0, 'the example array is non-empty — an empty [] teaches nothing about element shape');
    for (const el of arr) {
      assert.equal(typeof el, 'object', `each alternatives_rejected example element is an OBJECT, not a bare string (the canonical bug the board item names); got element: ${JSON.stringify(el)}`);
      assert.ok(el !== null && !Array.isArray(el), 'element is a plain object, not null or a nested array');
      assert.ok('option' in (el as object), `element carries 'option'; got: ${JSON.stringify(el)}`);
      assert.ok('reason' in (el as object), `element carries 'reason'; got: ${JSON.stringify(el)}`);
      assert.equal(typeof (el as Record<string, unknown>).option, 'string', "'option' is a string");
      assert.equal(typeof (el as Record<string, unknown>).reason, 'string', "'reason' is a string");
    }

    // CONTROL, placed to demonstrate this test's shape logic actually
    // discriminates rather than always expecting "object": decision.file_keys
    // is a genuine string[] field. Its example must decode to an array of
    // bare STRINGS — the opposite verdict, for the opposite (correct) reason.
    // If this control ever failed the same way the main assertion is meant
    // to catch, it would mean the check above cannot tell array-of-object
    // from array-of-string apart, and would be worthless as a pin.
    const fileKeys = dec.fields.find((f) => f.name === 'file_keys');
    assert.ok(fileKeys, 'file_keys is reported (control fixture)');
    if (typeof fileKeys?.example === 'string' && fileKeys.example.length > 0) {
      const fkParsed = valueFromExample(fileKeys.example);
      assert.ok(Array.isArray(fkParsed), 'file_keys example decodes to an array (control)');
      for (const el of fkParsed as unknown[]) {
        assert.equal(typeof el, 'string', `CONTROL: file_keys is genuinely string[], so its example elements must be bare strings, not objects; got: ${JSON.stringify(el)}`);
      }
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 2 — THE EXAMPLE ACTUALLY VALIDATES. The strongest anti-hollow check
// available: assemble a create-body from ONLY the projection's own reported
// examples for a type's required[] fields, and require knowledge_create (the
// entry point that runs the body through that type's registered zod schema)
// to accept it. A plausible-looking-but-wrongly-shaped example (e.g. an
// alternatives_rejected example that reads as `[{"option": "x"}]` missing
// `reason`, or a string masquerading as an object) fails HERE even though it
// would pass a shallower "is this a non-empty string" check.
//
// ONE record type is a named, adjudicated exception to "written via
// knowledge_create": `todo`, whose write path is board_add, not
// knowledge_create (established precedent: refusal-shape-contract.test.ts's
// DERIVATION-B sweep excludes it for the identical reason). This is a NAMED
// exception asserted explicitly below — not an anonymous "any one type may
// fail" tolerance. An anonymous tolerance cannot tell a legitimate exemption
// from a regression; measured live against the real implementation, EVERY
// other registered type (0 of 8 non-`todo` types) refuses, so the bar here
// is zero refusals outside the one named exception.
//
// EXPECTED FAILURE SHAPE (red, pre-fix): no field reports a non-empty
// `example`, so the very first per-type assertion — 'TYPE.FIELD is required
// but reports no usable example' — fires for the first required field of the
// first registered type (alphabetically, `anti_pattern` or `attestation`
// depending on registration order).
//
// NAMED SABOTAGE: hand-write a per-type example TABLE that is shaped
// correctly today but composed independently of the live zod schema (e.g. a
// switch statement returning a literal object per type name) — the moment
// any one type's required field's example is subtly wrong (a bad enum
// member, a missing nested key, an example for a field the schema actually
// makes optional-only-under-a-refinement), knowledge_create throws and this
// test names exactly which type refused and the underlying field-level error
// (not merely "no example present"). MEASURED 2026-08-28: a deliberately
// wrong `alternatives_rejected` example (`["no time","too risky"]`, string[]
// instead of {option,reason}[]) is exactly this sabotage — it must now fail
// this pin by name (`decision: ...`), not slip through an anonymous
// tolerance the way it did before this tightening.
// ===========================================================================

test('PIN 2 (anti-hollow): assembling each type\'s reported required-field examples is ACCEPTED by that type\'s OWN knowledge_create — zero refusals outside the one NAMED exception', () => {
  const { tools, cleanup } = harness();
  try {
    const types = Object.keys(RECORD_TYPES).sort();
    assert.ok(types.length > 0, 'RECORD_TYPES must not be empty (sanity)');

    // The ONE named exception, asserted explicitly: `todo` is written via
    // board_add, not knowledge_create. Any OTHER type refusing is a
    // regression, never absorbed by this set.
    const KNOWN_EXCEPTIONS = new Set(['todo']);

    const accepted: string[] = [];
    const refused: string[] = [];

    for (const type of types) {
      if (KNOWN_EXCEPTIONS.has(type)) continue;

      const report = schemaOf(tools, type);
      const body: Record<string, unknown> = {};
      let missingExample: string | undefined;
      for (const name of report.required) {
        const field = report.fields.find((f) => f.name === name);
        if (!field || typeof field.example !== 'string' || field.example.length === 0) {
          missingExample = name;
          break;
        }
        body[name] = valueFromExample(field.example);
      }
      if (missingExample) {
        assert.fail(`${type}.${missingExample} is required but knowledge_schema reports no usable (non-empty string) example to assemble a write from`);
      }

      try {
        (tools as unknown as { knowledgeCreate: (t: string, b: Record<string, unknown>) => unknown }).knowledgeCreate(type, body);
        accepted.push(type);
      } catch (e) {
        // Named per type AND per the underlying field-level refusal message
        // (knowledge_create's own refusals already name the failing field —
        // see refusal-shape-contract.test.ts), so a future breakage is
        // diagnosable as "TYPE refused because of FIELD", not just "a type
        // refused".
        refused.push(`${type}: ${(e as Error).message}`);
      }
    }

    // ANTI-VACUITY: every non-excepted type was actually attempted and
    // accounted for (accepted + refused together cover the full set) — a
    // silently-skipped type would hide behind a passing accepted-count check.
    assert.equal(
      accepted.length + refused.length,
      types.length - KNOWN_EXCEPTIONS.size,
      'every registered type outside the named exception was attempted exactly once'
    );

    // THE ASSERTION: zero refusals outside the one named exception. Measured
    // live: 0 of 8 non-`todo` types refuse against the real implementation,
    // so there is no slack to grant here — any refusal names a real
    // regression, by exact type and field.
    assert.deepEqual(
      refused,
      [],
      `every registered type outside the named exception (${[...KNOWN_EXCEPTIONS].join(', ')}) must accept a body assembled purely from knowledge_schema's own reported examples. Refusal(s), each naming its type and the underlying field-level error:\n${refused.join('\n')}`
    );
    assert.ok(accepted.length > 0, 'sanity: at least one type was actually exercised (anti-vacuity floor)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 3 — STAYS DERIVED. Checked against the SCHEMA OBJECT ITSELF (each
// type's live registered zod schema, via its own `.safeParse({})`), never
// against a fixed field-name list typed into this test file. Every top-level
// field that the schema's OWN runtime validation names as missing-and-thus-
// required must carry a non-empty example.
//
// WHY THIS RESISTS A HARDCODED LITERAL: the expected coverage SET is not
// written anywhere in this file — it is recomputed, per type, from
// `RECORD_TYPES[type].schema.safeParse({})`'s own issues at the moment the
// test runs. A static per-type example table can satisfy this only by
// independently re-deriving the exact same coverage the schema itself
// reports for EVERY registered type — which is strictly more bookkeeping
// than deriving it once, generically, from the same schema object. A table
// that instead special-cases the handful of fields the author remembered
// (the exact failure mode board 89672420 exists to close — 'alternatives_
// rejected' was one silently-dropped field among many) fails the moment a
// required field it did not anticipate turns up in the sweep.
//
// CONTROL (placed first): 'decision.title' is independently known-required
// (pinned elsewhere in this suite via `dec.required.includes('title')`), so
// it must appear in the schema-derived required set below. This proves the
// safeParse-based derivation mechanism actually finds real required fields
// rather than vacuously finding none — the two possible causes of "every
// required field has an example" (genuinely derived vs. the loop silently
// iterating zero fields) are told apart by this control succeeding for the
// verifiable reason (title truly is required) rather than by default.
//
// EXPECTED FAILURE SHAPE (red, pre-fix): the control assertion itself
// ('decision.title' found in the live-schema-derived required set) is
// expected to PASS today (safeParse({}) already reports title as missing —
// that mechanism needs no fix). The failure fires one step later, on the
// first field lacking a non-empty `example` — today that is every field, so
// it fires on 'decision.title' (or whichever field sorts first) reporting no
// example.
//
// NAMED SABOTAGE: derive examples for only the fields enumerated in a
// hand-written allowlist (e.g. the ~10 fields covered by pre-existing tests)
// rather than iterating the schema's own required set — any registered type
// with a required field outside that allowlist (a real candidate: research_
// finding's `source_date`, or attestation's `inspected_at`) reports no
// example and this test names exactly that type.field pair as uncovered.
// ===========================================================================

test('PIN 3 (stays derived): every top-level field a type\'s LIVE registered zod schema itself requires carries a non-empty example', () => {
  const { tools, cleanup } = harness();
  try {
    type SafeParseResult = { success: boolean; error?: { issues: { path: (string | number)[] }[] } };
    const registry = RECORD_TYPES as unknown as Record<string, { schema: { safeParse: (v: unknown) => SafeParseResult } }>;

    const requiredPairs: { type: string; name: string }[] = [];
    for (const type of Object.keys(registry)) {
      const result = registry[type].schema.safeParse({});
      if (result.success) continue; // nothing required at all for this type
      const names = new Set(
        (result.error?.issues ?? [])
          .filter((iss) => iss.path.length === 1)
          .map((iss) => String(iss.path[0]))
      );
      for (const name of names) requiredPairs.push({ type, name });
    }

    // CONTROL — asserted first, for the reason stated above.
    assert.ok(
      requiredPairs.some((p) => p.type === 'decision' && p.name === 'title'),
      `CONTROL: decision.title is independently known-required (pinned elsewhere via dec.required.includes('title')) and must be found by this schema-derived sweep too — its absence would mean the derivation mechanism finds nothing real, making every assertion below vacuous. Found pairs: ${JSON.stringify(requiredPairs)}`
    );
    assert.ok(requiredPairs.length >= 10, `sanity floor: expected at least 10 (type, required-field) pairs across the registry; found ${requiredPairs.length}`);

    const uncovered: string[] = [];
    for (const { type, name } of requiredPairs) {
      const report = schemaOf(tools, type);
      const field = report.fields.find((f) => f.name === name);
      if (!field) {
        uncovered.push(`${type}.${name}: zod itself requires this field but knowledge_schema does not report it at all`);
        continue;
      }
      if (typeof field.example !== 'string' || field.example.length === 0) {
        uncovered.push(`${type}.${name}: zod's own validation (schema.safeParse({})) names this required, but no non-empty example is reported`);
      }
    }
    assert.deepEqual(uncovered, [], `every field the live schema itself requires must carry a derived example:\n${uncovered.join('\n')}`);
  } finally {
    cleanup();
  }
});
