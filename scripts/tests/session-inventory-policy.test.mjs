import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConductorCandidate, isNonInputNotice } from '../lib/session-policy.mjs';
import { isConductorCandidate as scriptCandidate } from '../lib/session-inventory.mjs';

test('scripts re-exports the shared conductor predicate', () => {
  assert.equal(scriptCandidate, isConductorCandidate);
});

test('only unarchived top-level conductor or legacy sessions are candidates', () => {
  for (const agent of [undefined, 'sterling/conductor', 'sterling-maintenance-worker', null, '']) {
    for (const parentID of [undefined, null, 'ses_parent', '', false]) {
      for (const archived of [undefined, 0, 10]) {
        const session = { agent, parentID, time: { archived } };
        assert.equal(isConductorCandidate(session), (agent === undefined || agent === 'sterling/conductor') && parentID == null && !archived, JSON.stringify(session));
      }
    }
  }
});

test('only synthetic shell metadata or the exact Sterling context prefix is a non-input notice', () => {
  const text = 'STERLING CONTEXT (added by the Sterling plugin, not typed by the user): status';
  for (const entry of [
    { type: 'synthetic', payload: { text } },
    { type: 'synthetic', payload: { metadata: { source: 'shell' } } },
  ]) assert.equal(isNonInputNotice(entry), true);
  for (const entry of [
    null, 'text', {}, { type: 'user', payload: { text } },
    { type: 'synthetic', payload: { text: ` ${text}` } },
    { type: 'synthetic', payload: { text: 'STERLING CONTEXT (added by another plugin' } },
    { type: 'synthetic', payload: { text: 7 } },
    { type: 'synthetic', payload: { metadata: { source: 'subagent' } } },
  ]) assert.equal(isNonInputNotice(entry), false, JSON.stringify(entry));
});

// likelyReset: the ordering-only sign of a manual /clear.
import { readFileSync } from 'node:fs';
import { likelyReset } from '../lib/session-policy.mjs';
import { likelyReset as scriptLikelyReset } from '../lib/session-inventory.mjs';

const SET_AT = '2026-10-26T09:00:00.000Z';
const AT = Date.parse(SET_AT);
const OWNER = { session: 'ses_old', set_at: SET_AT, reason: 'set-owner' };

test('likelyReset: a conductor created after the owner was recorded is the sign, whatever the owner is doing', () => {
  const tops = [{ id: 'ses_old', created: AT - 60_000, updated: AT + 1 }, { id: 'ses_new', created: AT + 5_000, updated: AT + 5_000 }];
  assert.deepEqual(likelyReset(OWNER, tops).map((t) => t.id), ['ses_new']);
  // Only the order of creation counts: no update time is read, so a session nobody touched since is still the newer one.
  assert.deepEqual(likelyReset(OWNER, [{ id: 'ses_new', created: AT + 1 }]).map((t) => t.id), ['ses_new']);
});

test('likelyReset: older than the entry, at the same moment, the owner itself and a session without a creation time never count', () => {
  const tops = [{ id: 'ses_old', created: AT + 10 }, { id: 'ses_before', created: AT - 1 }, { id: 'ses_same', created: AT }, { id: 'ses_none' }, { id: 'ses_text', created: 'later' }];
  assert.deepEqual(likelyReset(OWNER, tops), []);
});

test('likelyReset: only the newest of several count, all of them on a tie and in the order given; an entry without a readable set_at counts none', () => {
  const tops = [{ id: 'ses_a', created: AT + 1 }, { id: 'ses_b', created: AT + 9 }, { id: 'ses_c', created: AT + 9 }];
  assert.deepEqual(likelyReset(OWNER, tops).map((t) => t.id), ['ses_b', 'ses_c']);
  for (const entry of [undefined, null, { session: 'ses_old' }, { session: 'ses_old', set_at: 'yesterday' }]) assert.deepEqual(likelyReset(entry, tops), []);
});

test('the manual /clear rule exists once: the inventory re-exports it and keeps no copy of its own', () => {
  assert.equal(scriptLikelyReset, likelyReset);
  const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.doesNotMatch(source('../lib/session-inventory.mjs'), /function\s+likelyReset|(?:const|let)\s+likelyReset\s*=/);
  assert.equal(source('../lib/session-policy.mjs').match(/export function likelyReset/g).length, 1);
});
