import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';

function runRecord(over: Record<string, unknown> = {}) {
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

function handoff(over: Record<string, unknown> = {}) {
  return {
    phase_id: 'p1',
    agent_role: 'coder',
    what_changed: [{ path: 'src/a.ts', change_role: 'implemented' }],
    wired: [],
    deferred: [],
    decisions_made: [],
    tests_produced: [],
    exit_signal: 'complete',
    unresolved: [],
    ...over,
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-runs-'));
  return { dir, store: new SterlingStore(join(dir, 'sterling.db')) };
}

test('createRun validates, getRun resolves active; one active run at a time (§7.5)', () => {
  const { dir, store } = tempStore();
  try {
    assert.throws(() => store.createRun(runRecord({ machine_state: 'flying' })), /invalid/i);
    const run = store.createRun(runRecord());
    assert.equal(store.getRun()!.id, run.id);
    assert.equal(store.getRun('r-0001')!.branch, 'sterling/run-r-0001');
    assert.throws(() => store.createRun(runRecord({ id: 'r-0002' })), /one active run at a time/);
    // merged runs are inactive — a new run may start
    store.casTransition('running', { ...run, machine_state: 'merged' });
    assert.equal(store.getRun(), undefined);
    store.createRun(runRecord({ id: 'r-0002', branch: 'sterling/run-r-0002' }));
    assert.equal(store.getRun()!.id, 'r-0002');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casTransition: stale observed state is rejected loudly and changes nothing (§5.2)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const next = { ...run, machine_state: 'completing' };
    store.casTransition('running', next);
    assert.equal(store.getRun(run.id)!.machine_state, 'completing');
    // replay with the same observed state — exactly the conductor-after-compaction case
    assert.throws(() => store.casTransition('running', { ...run, machine_state: 'halted' }), /CAS rejected/);
    assert.equal(store.getRun(run.id)!.machine_state, 'completing', 'rejected CAS must not change state');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pending exit: recorded once, never silently overwritten, consumed by transition (§5.2)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const exit = { signal: 'complete', phase_id: 'p1', agent_role: 'coder', at: NOW };
    store.recordPendingExit(run.id, exit);
    assert.equal(store.getPendingExit(run.id)!.signal, 'complete');
    assert.throws(() => store.recordPendingExit(run.id, { ...exit, signal: 'blocked' }), /unconsumed exit/);
    store.casTransition('running', { ...run, machine_state: 'completing' });
    assert.equal(store.getPendingExit(run.id), undefined, 'transition consumes the pending exit');
    assert.throws(() => store.recordPendingExit('r-none', exit), /no run/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff pair: schema-validated write; read by phase and by files; path-normalized join (§10)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    assert.throws(() => store.writeHandoff(run.id, handoff({ exit_signal: 'victory' }), NOW), /invalid/i);
    assert.throws(() => store.writeHandoff('r-none', handoff(), NOW), /no run/);
    store.writeHandoff(run.id, handoff(), NOW);
    store.writeHandoff(run.id, handoff({ phase_id: 'p2', what_changed: [{ path: 'src/b.ts', change_role: 'edited' }] }), NOW);
    assert.equal(store.readHandoffs(run.id).length, 2);
    assert.equal(store.readHandoffs(run.id, { phase_id: 'p1' }).length, 1);
    const byFile = store.readHandoffs(run.id, { files: ['src\\a.ts'] });
    assert.equal(byFile.length, 1, 'backslash query path normalizes and joins');
    assert.equal(byFile[0].phase_id, 'p1');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendRunEscalation: appends under optimistic concurrency, loud on missing run', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    store.appendRunEscalation(run.id, { kind: 'context_warn', agent_id: 'a1', fill_pct: 63 });
    store.appendRunEscalation(run.id, { kind: 'context_warn', agent_id: 'a1', fill_pct: 71 });
    const after = store.getRun(run.id)!;
    assert.equal(after.escalations.length, 2);
    assert.equal((after.escalations[1] as { fill_pct: number }).fill_pct, 71);
    assert.equal(after.machine_state, 'running', 'escalation append does not touch machine_state');
    assert.throws(() => store.appendRunEscalation('r-none', {}), /no run/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check_skipped: recorded and listable, run-scoped or global (§16.1.9)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    store.recordCheckSkipped('dedup-merge', 'not_built', run.id, NOW);
    store.recordCheckSkipped('noise-gate', 'not_built', undefined, NOW);
    assert.equal(store.listCheckSkipped().length, 2);
    assert.deepEqual(
      store.listCheckSkipped(run.id).map((c) => c.check_name),
      ['dedup-merge']
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
