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

// ------------------- mid-run scope amendment (run r-1417) -------------------

test('appendRunScopeAmendment: idempotent-on-path append; first {reason,at} stands; never touches machine_state; loud on missing run (interface slice 2)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    // guard: convert a not-yet-existing method into an ASSERTION-red (never a call-of-undefined crash).
    // The behavioral assertions below only run once the primitive exists.
    assert.equal(
      typeof (store as unknown as { appendRunScopeAmendment?: unknown }).appendRunScopeAmendment,
      'function',
      'SterlingStore must expose appendRunScopeAmendment(runId, {path, reason, at})'
    );
    const s = store as unknown as {
      appendRunScopeAmendment: (runId: string, a: { path: string; reason: string; at: string }) => void;
    };

    s.appendRunScopeAmendment(run.id, { path: 'src/amended.ts', reason: 'adjudicated', at: NOW });
    let after = store.getRun(run.id)! as unknown as { scope_amendments: { path: string; reason: string; at: string }[]; machine_state: string };
    assert.equal(after.scope_amendments.length, 1);
    assert.equal(after.scope_amendments[0].path, 'src/amended.ts');
    assert.equal(after.scope_amendments[0].reason, 'adjudicated');
    assert.equal(after.scope_amendments[0].at, NOW);
    assert.equal(after.machine_state, 'running', 'amendment append does not touch machine_state');

    // idempotent-on-path: a duplicate path is SKIPPED; the FIRST {reason, at} stands
    s.appendRunScopeAmendment(run.id, { path: 'src/amended.ts', reason: 'different reason', at: '2026-06-11T00:00:00.000Z' });
    after = store.getRun(run.id)! as unknown as typeof after;
    assert.equal(after.scope_amendments.length, 1, 'duplicate path is skipped (idempotent-on-path)');
    assert.equal(after.scope_amendments[0].reason, 'adjudicated', 'the first reason stands on a duplicate');
    assert.equal(after.scope_amendments[0].at, NOW, 'the first timestamp stands on a duplicate');

    // a distinct path appends a second entry
    s.appendRunScopeAmendment(run.id, { path: 'src/second.ts', reason: 'another', at: NOW });
    after = store.getRun(run.id)! as unknown as typeof after;
    assert.equal(after.scope_amendments.length, 2);
    assert.deepEqual(after.scope_amendments.map((a) => a.path).sort(), ['src/amended.ts', 'src/second.ts']);

    // loud on a missing run (mirrors appendRunEscalation)
    assert.throws(() => s.appendRunScopeAmendment('r-none', { path: 'src/x.ts', reason: 'r', at: NOW }), /no run/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
