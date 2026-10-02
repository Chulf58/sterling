import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { describeZod, schemaFor, RECORD_TYPES } from '../index.js';

// ---------------------------------------------------------------------------
// board be5e1d04: describeZod hides string FORMAT constraints from its
// projection. z.union([z.literal('final'), z.string().regex(/^phase:\d+$/)])
// (the real shape behind verifiable_at) renders as `'final' | string` — the
// regex is invisible, and a consumer read that as "accepts any string" and
// filed a defect that was not one (reference 5d31ea8a). Likewise
// history[].date renders bare `string` with no ISO-instant requirement
// visible. Required behavior after the fix (spec, not code — H4):
//   (a) a string schema carrying .regex() projects the pattern visibly
//   (b) a .datetime()/ISO-instant string constraint projects visibly
//   (c) FieldShape gains an `example`, carried by at least one field
//   (d) an unconstrained plain string still projects as plain string
//       (CONTROL — asserted FIRST: a verdict with more than one possible
//       cause needs a control arm that passes for the opposite reason).
// ---------------------------------------------------------------------------

test('CONTROL: an unconstrained plain string still projects as plain "string" with no format annotation', () => {
  const desc = describeZod(z.string());
  assert.equal(desc, 'string', 'a plain, unconstrained string must not gain any format annotation from this fix');
});

test('AC(a): a string schema carrying .regex() projects the pattern source visibly (the verifiable_at union shape from the spec)', () => {
  const schema = z.union([z.literal('final'), z.string().regex(/^phase:\d+$/)]);
  const desc = describeZod(schema);
  assert.ok(
    desc.includes(String.raw`^phase:\d+$`),
    `projection must surface the regex pattern verbatim so a consumer never mistakes it for accepts-any-string; got: ${JSON.stringify(desc)}`
  );
});

test('AC(b): a string schema carrying .datetime() projects the ISO-instant constraint visibly, and differs from an unconstrained string', () => {
  const schema = z.string().datetime();
  const desc = describeZod(schema);
  assert.match(
    desc,
    /iso|datetime/i,
    `projection must name the ISO/datetime constraint so history[].date-shaped fields are not read as accepts-any-string; got: ${JSON.stringify(desc)}`
  );
  assert.notEqual(desc, 'string', 'a datetime-constrained string must not render identically to the unconstrained control — that is the exact bug being fixed');
});

test('AC(c): schemaFor-produced FieldShape carries a non-empty `example` on at least one field across the registry', () => {
  const withExample: { type: string; field: string; example: string }[] = [];
  for (const type of Object.keys(RECORD_TYPES)) {
    const shape = schemaFor(type) as { fields: { name: string; example?: unknown }[] };
    for (const f of shape.fields) {
      if (typeof f.example === 'string' && f.example.length > 0) {
        withExample.push({ type, field: f.name, example: f.example });
      }
    }
  }
  assert.ok(
    withExample.length > 0,
    `at least one field across the registry must carry a non-empty example (FieldShape.example); found none across ${Object.keys(RECORD_TYPES).length} registered types`
  );
});

test('AC(b)+(c) regression site: schemaFor(feature_article).history[].date carries the datetime-flavored type AND a non-empty example', () => {
  const shape = schemaFor('feature_article') as {
    fields: { name: string; element_fields?: { name: string; type: string; example?: unknown }[] }[];
  };
  const historyField = shape.fields.find((f) => f.name === 'history');
  assert.ok(historyField, 'history is a reported field of feature_article');
  const dateField = historyField?.element_fields?.find((ef) => ef.name === 'date');
  assert.ok(dateField, 'history[].date is reported as a nested element field');
  assert.match(
    dateField!.type,
    /iso|datetime/i,
    `history[].date's projected type must name the ISO/datetime constraint, not render as bare "string"; got: ${JSON.stringify(dateField!.type)}`
  );
  assert.ok(
    typeof dateField!.example === 'string' && dateField!.example.length > 0,
    'history[].date must carry a non-empty example on its nested FieldShape — the regression site the roster review flagged'
  );
});
