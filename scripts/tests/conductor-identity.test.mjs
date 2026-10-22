// isConductorSession: the one host-neutral conductor check (GitHub #199).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONDUCTOR_AGENT, WORKER_AGENT, isConductorSession } from '../lib/conductor-identity.mjs';
import { CONDUCTOR_AGENT as installConductorAgent } from '../lib/opencode-install.mjs';
import { WORKER_AGENT as launcherWorkerAgent } from '../hooks/lib/maintenance-worker.mjs';
import { OPENCODE_WORKER_AGENT } from '../hooks/lib/maintenance-worker-opencode.mjs';

test('an OpenCode root session under sterling/conductor is a conductor', () => {
  assert.equal(isConductorSession({ agent: 'sterling/conductor' }), true);
});

test('an OpenCode root session with no agent field is a conductor', () => {
  assert.equal(isConductorSession({}), true);
  assert.equal(isConductorSession({ agent: undefined }), true);
  assert.equal(isConductorSession({ agent: null }), true);
  assert.equal(isConductorSession({ agent: '' }), true);
});

test('a Claude Code root session under conductor is a conductor', () => {
  assert.equal(isConductorSession({ agent: 'conductor' }), true);
});

test('the maintenance worker is never a conductor, with or without a parent', () => {
  assert.equal(isConductorSession({ agent: 'sterling-maintenance-worker' }), false);
  assert.equal(isConductorSession({ agent: WORKER_AGENT }), false);
  assert.equal(isConductorSession({ agent: WORKER_AGENT, parentID: 'ses_parent' }), false);
});

test('a subagent session with a parent is not a conductor, even under a conductor agent name or with no agent', () => {
  assert.equal(isConductorSession({ agent: 'sterling/implementor', parentID: 'ses_parent' }), false);
  assert.equal(isConductorSession({ agent: 'sterling/conductor', parentID: 'ses_parent' }), false);
  assert.equal(isConductorSession({ agent: 'conductor', parentID: 'ses_parent' }), false);
  assert.equal(isConductorSession({ parentID: 'ses_parent' }), false);
});

test('a root session under another top-level agent is not a conductor', () => {
  for (const agent of ['build', 'plan', 'implementor', 'sterling/implementor', 'sterling/librarian', 'Conductor', 'sterling/conductor ']) {
    assert.equal(isConductorSession({ agent }), false, agent);
  }
  assert.equal(isConductorSession({ agent: 42 }), false);
});

test('a missing or non-object session is not a conductor', () => {
  for (const s of [undefined, null, 'sterling/conductor', 7]) assert.equal(isConductorSession(s), false);
});

test('every Sterling name site shares the one set of constants', () => {
  assert.equal(CONDUCTOR_AGENT, 'sterling/conductor');
  assert.equal(WORKER_AGENT, 'sterling-maintenance-worker');
  assert.equal(installConductorAgent, CONDUCTOR_AGENT);
  assert.equal(launcherWorkerAgent, WORKER_AGENT);
  assert.equal(OPENCODE_WORKER_AGENT, WORKER_AGENT);
});
