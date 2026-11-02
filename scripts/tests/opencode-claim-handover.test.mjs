import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoverFailedText } from '../../packages/opencode-plugin/src/claim-handover.mjs';

class StoreOutcomeUncertainError extends Error {
  name = 'StoreOutcomeUncertainError';
}
class ClaimAdoptionIncomplete extends Error {
  name = 'ClaimAdoptionIncomplete';
  constructor(partial, cause) {
    super('board_adopt: stopped', { cause });
    this.partial = partial;
  }
}

test('uncertain commit outcome with empty partial.adopted does not claim nothing was adopted', () => {
  const err = new ClaimAdoptionIncomplete({ adopted: [] }, new StoreOutcomeUncertainError('rollback failed'));
  const text = handoverFailedText(err, 'ses_old');
  assert.doesNotMatch(text, /stopped before adopting any claim/);
  assert.match(text, /whether the last claim was adopted is not known/);
  assert.match(text, /board_adopt from_session 'ses_old'/);
});

test('uncertain commit outcome with adopted items keeps the committed list and flags the next one', () => {
  const err = new ClaimAdoptionIncomplete(
    { adopted: [{ id: 'abcdef12-0000', name: 'First task' }] },
    new StoreOutcomeUncertainError('rollback failed')
  );
  const text = handoverFailedText(err, 'ses_old');
  assert.match(text, /adopted 1 \(abcdef12\)/);
  assert.match(text, /whether the last claim was adopted is not known/);
});

test('a certain failure with empty partial.adopted keeps the known-no-adoption wording', () => {
  const err = new ClaimAdoptionIncomplete({ adopted: [] }, new Error('boom'));
  assert.match(handoverFailedText(err, 'ses_old'), /it stopped before adopting any claim/);
});
