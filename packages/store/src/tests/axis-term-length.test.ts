import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as storeMod from '../index.js';

// The axis extractors feed rank_terms; rankTerms rejects a term over 64 chars,
// so one over-long token in tool output used to throw the whole delivery.
test('axis extractors drop a term longer than AXIS_MAX_TERM_LEN and stay within what rank_terms accepts', () => {
  const max = storeMod.AXIS_MAX_TERM_LEN;
  const longTerm = 'x'.repeat(max + 1);
  const okTerm = 'y'.repeat(max);
  const text = `flywheel ${longTerm} ${okTerm} ballast`;
  for (const terms of [storeMod.extractAxisTerms(text, 16), storeMod.extractAxisTermsUncapped(text)]) {
    assert.ok(!terms.includes(longTerm), 'an over-long term is dropped');
    assert.ok(terms.includes(okTerm), 'a term exactly at the bound is kept');
    assert.ok(terms.includes('flywheel') && terms.includes('ballast'));
    assert.doesNotThrow(() => storeMod.rankTerms.parse(terms), 'every extracted term passes the rank_terms validator');
  }
  assert.equal(max, 64);
  assert.throws(() => storeMod.rankTerms.parse([longTerm]));
});
