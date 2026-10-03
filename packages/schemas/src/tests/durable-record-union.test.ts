// Review finding on feat/supersede-small-types: the DurableRecord union had
// drifted from RECORD_TYPES. open_question was registered but absent from the
// union, so `record.type === 'open_question'` was a TS2367 and a caller had to
// widen to `string` to mention it. This file pins the two against each other.
//
// RECORD_TYPES is typed Record<string, RecordTypeEntry>, so its keys carry no
// literal types and the comparison cannot be made by the compiler alone. It is
// made in two halves:
//   - COMPILE TIME: UNION_TYPES is Record<DurableRecord['type'], true>, so a
//     union member missing from the map, or a key the union does not have, is
//     a compile error in this file.
//   - RUN TIME: the map's keys equal Object.keys(RECORD_TYPES).
// A type registered without widening the union fails the run-time half; adding
// it to the map to make that pass fails the compile-time half until the union
// has it too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_TYPES, type DurableRecord } from '../index.js';

// Guards the compile-time half itself: if any member's `type` widened to
// `string`, Record<DurableRecord['type'], true> would accept any key at all.
type TypeIsLiteralUnion = string extends DurableRecord['type'] ? never : true;
const typeIsLiteralUnion: TypeIsLiteralUnion = true;

const UNION_TYPES: Record<DurableRecord['type'], true> = {
  anti_pattern: true,
  attestation: true,
  brief: true,
  decision: true,
  disconfirmed_hypothesis: true,
  feature_article: true,
  open_question: true,
  reference_material: true,
  research_finding: true,
  todo: true,
};

test('registry consistency: every RECORD_TYPES member is a DurableRecord member, and the union names no unregistered type', () => {
  assert.equal(typeIsLiteralUnion, true);
  assert.deepEqual(
    Object.keys(UNION_TYPES).sort(),
    Object.keys(RECORD_TYPES).sort(),
    'DurableRecord and RECORD_TYPES must name the same types: a registered type missing from the union cannot be narrowed on by any caller'
  );
});
