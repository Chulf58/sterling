import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SPINE_SIGNALS, type RunRecord } from '@sterling/schemas';
import { react, REACTIONS } from '../brain.js';

const NOW = '2026-06-10T12:00:00.000Z';

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r-0001',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-0001',
    machine_state: 'running',
    phases: [
      { id: 'p1', status: 'in_progress', signals: [], commits: [] },
      { id: 'p2', status: 'pending', signals: [], commits: [] },
    ],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
    ...over,
  };
}

// THE TOTALITY TEST (spec §5.1/§5.2, invariant 5): every member of the closed
// signal enum has a reaction and a resolution flag, and the reaction is defined
// for a representative context. Adding an enum member without wiring it fails here.
test('totality: every spine signal has a reaction entry with a resolution flag', () => {
  assert.deepEqual(Object.keys(REACTIONS).sort(), [...SPINE_SIGNALS].sort(), 'reaction table and enum must match exactly');
  for (const signal of SPINE_SIGNALS) {
    const entry = REACTIONS[signal];
    assert.ok(
      ['mechanical', 'judgment', 'mechanical_then_judgment'].includes(entry.resolution),
      `${signal} needs a resolution flag`
    );
    const probe =
      signal === 'agent-died'
        ? { signal, phase_id: 'p1', payload: { observed: 'crash' } }
        : { signal, phase_id: 'p1', payload: {} };
    const { action, nextState } = react(run(), probe);
    assert.ok(action && typeof action.action === 'string', `${signal} must produce a defined action`);
    assert.ok(nextState, `${signal} must produce a next machine state`);
  }
});

test('unknown signal halts the run loudly — the enum is closed (P5)', () => {
  const { action, nextState } = react(run(), { signal: 'victory', phase_id: 'p1' });
  assert.equal(action.action, 'halt');
  assert.match((action as { reason: string }).reason, /unknown signal 'victory'/);
  assert.match((action as { reason: string }).reason, /closed/);
  assert.equal(nextState, 'halted');
});

test('complete: non-final phase spawns the next; final phase starts the run-completion sequence', () => {
  const mid = react(run(), { signal: 'complete', phase_id: 'p1' });
  assert.deepEqual(mid.action, { action: 'spawn', phase_id: 'p2', respawn: false });
  assert.equal(mid.nextState, 'running');

  const fin = react(run(), { signal: 'complete', phase_id: 'p2' });
  assert.equal(fin.action.action, 'complete_run');
  assert.equal(fin.nextState, 'completing');

  const ghost = react(run(), { signal: 'complete', phase_id: 'p9' });
  assert.equal(ghost.action.action, 'halt');
});

test('blocked: judgment escalation with payload, run stays running', () => {
  const r = react(run(), { signal: 'blocked', phase_id: 'p1', payload: { reason: 'missing credentials' } });
  assert.equal(r.action.action, 'judgment_needed');
  assert.deepEqual((r.action as { payload: unknown }).payload, { reason: 'missing credentials' });
  assert.equal(r.nextState, 'running');
});

test('agent-died: first crash/empty respawns once; second death escalates; malformed never blind-retries (§5.1)', () => {
  const first = react(run(), { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'crash' } });
  assert.equal(first.action.action, 'spawn');
  assert.equal((first.action as { respawn: boolean }).respawn, true);
  assert.equal((first.action as { phase_id: string }).phase_id, 'p1', 'respawn targets the SAME phase');

  const afterOneDeath = run();
  afterOneDeath.phases[0].signals.push({ signal: 'agent-died', at: NOW });
  const second = react(afterOneDeath, { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'empty_output' } });
  assert.equal(second.action.action, 'judgment_needed');
  assert.match((second.action as { reason: string }).reason, /death cap/);

  const malformed = react(run(), { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'malformed_exit', raw_excerpt: 'lorem' } });
  assert.equal(malformed.action.action, 'judgment_needed');
  assert.match((malformed.action as { reason: string }).reason, /malformed_exit/);

  const garbage = react(run(), { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'vibes' } });
  assert.equal(garbage.action.action, 'halt');
});

test('signals are processed only while running — anything else halts loudly', () => {
  const r = react(run({ machine_state: 'completing' }), { signal: 'complete', phase_id: 'p2' });
  assert.equal(r.action.action, 'halt');
  assert.match((r.action as { reason: string }).reason, /'completing'/);
});

test('brain is pure: reacting does not mutate the run record', () => {
  const r = run();
  const snapshot = JSON.stringify(r);
  react(r, { signal: 'complete', phase_id: 'p1' });
  react(r, { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'crash' } });
  assert.equal(JSON.stringify(r), snapshot);
});
