import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SIGNALS, SIGNAL_PAYLOADS, type RunRecord } from '@sterling/schemas';
import { react, REACTIONS, DEFAULT_CAPS } from '../brain.js';

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

// Representative valid payloads per §5.1 — also exercised against SIGNAL_PAYLOADS.
const PROBE_PAYLOADS: Record<string, Record<string, unknown>> = {
  complete: { handoff_ref: 'p1/coder' },
  'research-needed': { question: 'rate limit scope?', context: 'phase p1', blocking: true },
  'review-unresolved': { objections: [{ id: 1 }], reviewer_agreement: 'disagreed' },
  blocked: { reason: 'missing credentials' },
  'tests-invalid': { evidence: 'AC2 contradicts AC1 at tests/x.test.mjs:14' },
  'contract-violated': { path: 'src/out.ts', rule: 'outside blast_radius' },
  'bug-found': { description: 'off-by-one', location: 'src/calc.mjs:3', depends_on_current_work: false, workaround_built: false },
  'phase-overflow': { agent: 'coder', fill_pct: 96.2 },
  'agent-died': { agent: 'coder', observed: 'crash', raw_excerpt: '' },
};

// THE TOTALITY TEST (spec §5.1/§5.2, invariant 5): every member of the closed
// enum has a reaction entry with a resolution flag and a defined reaction; its
// typed payload schema exists and accepts the representative payload. Adding a
// member without wiring fails here.
test('totality: all nine signals wired with reaction + resolution + payload schema', () => {
  assert.equal(SIGNALS.length, 9);
  assert.deepEqual(Object.keys(REACTIONS).sort(), [...SIGNALS].sort(), 'reaction table and enum must match exactly');
  assert.deepEqual(Object.keys(SIGNAL_PAYLOADS).sort(), [...SIGNALS].sort(), 'payload registry and enum must match exactly');
  for (const signal of SIGNALS) {
    const entry = REACTIONS[signal];
    assert.ok(['mechanical', 'judgment', 'mechanical_then_judgment'].includes(entry.resolution), `${signal}: resolution flag`);
    assert.ok(SIGNAL_PAYLOADS[signal].safeParse(PROBE_PAYLOADS[signal]).success, `${signal}: probe payload must validate`);
    const { action, nextState } = react(run(), { signal, phase_id: 'p1', payload: PROBE_PAYLOADS[signal] });
    assert.ok(action && typeof action.action === 'string', `${signal}: defined action`);
    assert.ok(nextState, `${signal}: defined next state`);
  }
});

test('unknown signal halts the run loudly — the enum is closed (P5)', () => {
  const { action, nextState } = react(run(), { signal: 'victory', phase_id: 'p1' });
  assert.equal(action.action, 'halt');
  assert.match((action as { reason: string }).reason, /unknown signal 'victory'/);
  assert.equal(nextState, 'halted');
});

test('complete: spawn next / completion sequence; ghost phase halts', () => {
  assert.deepEqual(react(run(), { signal: 'complete', phase_id: 'p1' }).action, { action: 'spawn', phase_id: 'p2', respawn: false });
  const fin = react(run(), { signal: 'complete', phase_id: 'p2' });
  assert.equal(fin.action.action, 'complete_run');
  assert.equal(fin.nextState, 'completing');
  assert.equal(react(run(), { signal: 'complete', phase_id: 'p9' }).action.action, 'halt');
});

test('research-needed: mechanical researcher dispatch; cap converts to phase-underspecified judgment (§5.1)', () => {
  const first = react(run(), { signal: 'research-needed', phase_id: 'p1', payload: PROBE_PAYLOADS['research-needed'] });
  assert.equal(first.action.action, 'dispatch_support');
  assert.equal((first.action as { support_type: string }).support_type, 'researcher');
  assert.match((first.action as { note: string }).note, /reset run branch/, 'resolve path discards partial work (P7)');
  assert.equal(first.nextState, 'running');

  const capped = run();
  capped.phases[0].signals.push({ signal: 'research-needed', at: NOW }, { signal: 'research-needed', at: NOW });
  const r = react(capped, { signal: 'research-needed', phase_id: 'p1', payload: PROBE_PAYLOADS['research-needed'] });
  assert.equal(r.action.action, 'judgment_needed');
  assert.match((r.action as { reason: string }).reason, /phase-underspecified/);
});

test('judgment signals: review-unresolved, blocked, tests-invalid, contract-violated, phase-overflow', () => {
  for (const signal of ['review-unresolved', 'blocked', 'tests-invalid', 'contract-violated', 'phase-overflow'] as const) {
    const r = react(run(), { signal, phase_id: 'p1', payload: PROBE_PAYLOADS[signal] });
    assert.equal(r.action.action, 'judgment_needed', signal);
    assert.equal(r.nextState, 'running', `${signal}: judgment waits, the run is not torn down`);
  }
  assert.match(
    (react(run(), { signal: 'tests-invalid', phase_id: 'p1', payload: PROBE_PAYLOADS['tests-invalid'] }).action as { reason: string }).reason,
    /never weakens its own oracle/
  );
});

test('bug-found: discriminator routes halt-fix-resume vs board-and-continue (§5.1)', () => {
  const incidental = react(run(), { signal: 'bug-found', phase_id: 'p1', payload: PROBE_PAYLOADS['bug-found'] });
  assert.match((incidental.action as { reason: string }).reason, /board-and-continue/);
  const depends = react(run(), {
    signal: 'bug-found',
    phase_id: 'p1',
    payload: { ...PROBE_PAYLOADS['bug-found'], depends_on_current_work: true },
  });
  assert.match((depends.action as { reason: string }).reason, /halt-fix-resume/);
  const workaround = react(run(), {
    signal: 'bug-found',
    phase_id: 'p1',
    payload: { ...PROBE_PAYLOADS['bug-found'], workaround_built: true },
  });
  assert.match((workaround.action as { reason: string }).reason, /halt-fix-resume/);
});

test('agent-died: respawn once per cap; repeat/malformed escalate; caps are tunable', () => {
  const first = react(run(), { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'crash' } });
  assert.equal(first.action.action, 'spawn');
  assert.equal((first.action as { respawn: boolean }).respawn, true);

  const afterOne = run();
  afterOne.phases[0].signals.push({ signal: 'agent-died', at: NOW });
  assert.equal(react(afterOne, { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'empty_output' } }).action.action, 'judgment_needed');
  // raising the cap permits a second respawn
  assert.equal(
    react(afterOne, { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'empty_output' } }, { ...DEFAULT_CAPS, phase_death_cap: 2 }).action.action,
    'spawn'
  );

  assert.equal(react(run(), { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'malformed_exit' } }).action.action, 'judgment_needed');
  assert.equal(react(run(), { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'vibes' } }).action.action, 'halt');
});

test('signals are processed only while running; brain is pure', () => {
  assert.equal(react(run({ machine_state: 'completing' }), { signal: 'complete', phase_id: 'p2' }).action.action, 'halt');
  const r = run();
  const snapshot = JSON.stringify(r);
  for (const signal of SIGNALS) react(r, { signal, phase_id: 'p1', payload: PROBE_PAYLOADS[signal] });
  assert.equal(JSON.stringify(r), snapshot, 'reacting never mutates the run record');
});
