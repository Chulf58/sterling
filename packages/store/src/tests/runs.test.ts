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

test('casTransitionMerge: transitions machine_state while PRESERVING a concurrent body write; clears the pending exit (audit findings 1/43, 18/43)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const artA = randomUUID();
    store.recordPendingExit(run.id, { signal: 'complete', phase_id: 'p1', agent_role: 'coder', at: NOW });
    // the race: a hook appends a reconcile mark AFTER the caller conceptually read
    // the run but BEFORE the transition commits. casTransitionMerge re-reads the
    // FRESH body inside its loop, so the mark must survive the state transition —
    // the old casTransition rebuilt the whole body from the stale read and dropped it.
    store.appendRunReconcileNeeded(run.id, artA);
    const applied = store.casTransitionMerge('running', run.id, (fresh) => ({ ...fresh, machine_state: 'completing' }));
    assert.equal(applied.machine_state, 'completing', 'state transitioned');
    const after = store.getRun(run.id)!;
    assert.equal(after.machine_state, 'completing');
    assert.deepEqual(after.reconcile_needed, [artA], 'the concurrent reconcile mark SURVIVED the transition (not clobbered)');
    assert.equal(store.getPendingExit(run.id), undefined, 'the transition consumed the pending exit');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casTransitionMerge: a stale observed machine_state is rejected loudly, nothing changes (§5.2 preserved)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    store.casTransitionMerge('running', run.id, (fresh) => ({ ...fresh, machine_state: 'completing' }));
    assert.throws(
      () => store.casTransitionMerge('running', run.id, (fresh) => ({ ...fresh, machine_state: 'halted' })),
      /CAS rejected/,
      'observed state no longer matches → loud reject'
    );
    assert.equal(store.getRun(run.id)!.machine_state, 'completing', 'rejected transition changed nothing');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('casTransitionMerge: RETRIES on a body change under it and still commits, merging the concurrent write (retry path)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    const artA = randomUUID();
    let injected = false;
    const applied = store.casTransitionMerge('running', run.id, (fresh) => {
      // on the FIRST pass only, land a concurrent hook write after this read so the
      // primitive's body-guarded UPDATE misses and must retry against the fresh body
      if (!injected) {
        injected = true;
        store.appendRunReconcileNeeded(run.id, artA);
      }
      return { ...fresh, machine_state: 'completing' };
    });
    assert.equal(applied.machine_state, 'completing');
    assert.deepEqual(store.getRun(run.id)!.reconcile_needed, [artA], 'the write that forced the retry is preserved, not lost');
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

// ------------------- reviewer knowledge loop v2 (run r-d630, phase 1 — AC1) -------------------

test('setRunReviewMandatory: replace-by-phase under optimistic update; never touches machine_state; loud on missing run (AC1)', () => {
  const { dir, store } = tempStore();
  try {
    const run = store.createRun(runRecord());
    // guard: convert a not-yet-existing method into an ASSERTION-red (never a call-of-undefined crash).
    assert.equal(
      typeof (store as unknown as { setRunReviewMandatory?: unknown }).setRunReviewMandatory,
      'function',
      'SterlingStore must expose setRunReviewMandatory(runId, phaseId, items)'
    );
    const s = store as unknown as {
      setRunReviewMandatory: (runId: string, phaseId: string, items: { record_id: string; reason: string }[]) => void;
    };
    type Mand = { phase_id: string; record_id: string; reason: string };
    const A = randomUUID(), B = randomUUID(), C = randomUUID(), D = randomUUID();

    // set p1 -> {A, B}; the phaseId param stamps phase_id on each stored entry
    s.setRunReviewMandatory(run.id, 'p1', [{ record_id: A, reason: 'governing design decision' }, { record_id: B, reason: 'anti-pattern' }]);
    let after = store.getRun(run.id)! as unknown as { review_mandatory: Mand[]; machine_state: string };
    assert.ok(Array.isArray(after.review_mandatory), 'review_mandatory is an array after the first set (assertion-red, not a crash)');
    const p1first = after.review_mandatory.filter((m) => m.phase_id === 'p1');
    assert.equal(p1first.length, 2, 'p1 carries both items');
    assert.deepEqual(p1first.map((m) => m.record_id).sort(), [A, B].sort(), 'p1 record_ids landed');
    const a = after.review_mandatory.find((m) => m.record_id === A)!;
    assert.equal(a.phase_id, 'p1', 'the phaseId param stamps phase_id on each entry');
    assert.equal(a.reason, 'governing design decision', 'the per-item reason is preserved');
    assert.equal(after.machine_state, 'running', 'setRunReviewMandatory does not touch machine_state');

    // set p2 -> {C}: a DIFFERENT phase — p1 must remain untouched (replace is per-phase, not global)
    s.setRunReviewMandatory(run.id, 'p2', [{ record_id: C, reason: 'convention' }]);
    after = store.getRun(run.id)! as unknown as typeof after;
    assert.equal(after.review_mandatory.filter((m) => m.phase_id === 'p1').length, 2, 'p1 remains after setting p2');
    assert.equal(after.review_mandatory.filter((m) => m.phase_id === 'p2').length, 1, 'p2 has its one item');
    assert.equal(after.machine_state, 'running', 'still no machine_state change');

    // REPLACE-BY-PHASE: re-set p1 -> {D}. p1's old {A,B} are GONE; p2's {C} is untouched.
    s.setRunReviewMandatory(run.id, 'p1', [{ record_id: D, reason: 'new decision' }]);
    after = store.getRun(run.id)! as unknown as typeof after;
    assert.deepEqual(after.review_mandatory.filter((m) => m.phase_id === 'p1').map((m) => m.record_id), [D], 'p1 is REPLACED, not appended (old A, B removed)');
    assert.equal(after.review_mandatory.filter((m) => m.phase_id === 'p2').length, 1, 'p2 untouched by re-setting p1');

    // BOUNDARY: setting an EMPTY list for a phase clears that phase only
    s.setRunReviewMandatory(run.id, 'p1', []);
    after = store.getRun(run.id)! as unknown as typeof after;
    assert.equal(after.review_mandatory.filter((m) => m.phase_id === 'p1').length, 0, 'empty items clears p1');
    assert.equal(after.review_mandatory.filter((m) => m.phase_id === 'p2').length, 1, 'p2 still intact after clearing p1');

    // LOUD on a missing run (mirrors appendRunEscalation / appendRunScopeAmendment; P5)
    assert.throws(() => s.setRunReviewMandatory('r-none', 'p1', [{ record_id: A, reason: 'r' }]), /no run/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
