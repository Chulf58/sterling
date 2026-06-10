import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tools-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function startRun(store: SterlingStore, phases = ['p1', 'p2']) {
  return store.createRun({
    id: 'r-0001',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-0001',
    machine_state: 'running',
    phases: phases.map((id, i) => ({ id, status: i === 0 ? 'in_progress' : 'pending', signals: [], commits: [] })),
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });
}

test('knowledge_create assembles the envelope server-side and emits check_skipped (never silent — §16.1.9)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record, check_skipped } = tools.knowledgeCreate('decision', {
      title: 'Use SQLite',
      statement: 'SQLite it is.',
      alternatives_rejected: [],
      rationale: 'Fits the criteria.',
      stack_tags: ['node'],
    });
    assert.equal(record.type, 'decision');
    assert.equal(record.status, 'active');
    assert.equal(record.author, 'conductor');
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(check_skipped, [{ check: 'dedup-merge', reason: 'not_built' }]);
    assert.throws(() => tools.knowledgeCreate('anti_pattern', { title: 'x' }), /unregistered record type/);
  } finally {
    cleanup();
  }
});

test('knowledge_update writes a new version and supersedes the prior; article version auto-bumps', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: v1 } = tools.knowledgeCreate('feature_article', {
      slug: 'csv-export',
      title: 'CSV export',
      what_it_does: 'Exports the board.',
      intended_behavior: 'User clicks Export and gets a file.',
      files: [{ path: 'src/export/csv.ts', role: 'serializer' }],
      current_ac: [{ ac_id: 'AC1', text: 'export works', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    const v2 = tools.knowledgeUpdate(v1.id, { what_it_does: 'Exports the board with headers.' });
    assert.equal((v2 as { version: number }).version, 2, 'version auto-bumped');
    assert.equal(tools.knowledgeGet(v1.id).status, 'superseded', 'prior retained and flagged');
    assert.ok(v2.links.some((l) => l.rel === 'supersedes' && l.target_id === v1.id));
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 1, 'only current version retrieved');
  } finally {
    cleanup();
  }
});

test('board tools: add/query separates board from maintenance queue; remove is todo-only', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: userTodo } = tools.boardAdd({ text: 'ship csv export', source: 'user', priority: 'high' });
    tools.boardAdd({ text: 'reconcile auth article', source: 'system', system_reason: 'reconcile_needed' });
    assert.equal(tools.boardQuery({}).length, 2);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'board view filters user');
    assert.equal(tools.boardQuery({ source: 'system' }).length, 1, 'maintenance queue is source=system');
    assert.throws(() => tools.boardAdd({ text: 'x', source: 'system' }), /system_reason/);

    const { record: d } = tools.knowledgeCreate('decision', {
      title: 't',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    assert.throws(() => tools.boardRemove(d.id), /not a todo/);
    const res = tools.boardRemove(userTodo.id);
    assert.deepEqual(res.check_skipped, [{ check: 'board-remove-artifact-binding', reason: 'not_built' }]);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0);
  } finally {
    cleanup();
  }
});

test('agent_exit: in-band rejection of non-enum signals; valid exit lands on the run record (§5.2)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'victory' }), /enum is closed/);
    const { recorded } = tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete' });
    assert.equal(recorded.signal, 'complete');
    assert.equal(store.getPendingExit('r-0001')!.phase_id, 'p1');
    assert.throws(
      () => tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'blocked' }),
      /unconsumed exit/,
      'a second exit before run_signal is a protocol violation'
    );
  } finally {
    cleanup();
  }
});

test('run_signal: reads the stored exit, applies the CAS transition, advances phases', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete' });
    const r1 = tools.runSignal();
    assert.deepEqual(r1.action, { action: 'spawn', phase_id: 'p2', respawn: false });
    const after = tools.runState();
    assert.equal(after.phases[0].status, 'complete');
    assert.equal(after.phases[1].status, 'in_progress');
    assert.equal(after.phases[0].signals.length, 1);
    assert.equal(store.getPendingExit('r-0001'), undefined, 'exit consumed');

    // final phase → completing + complete_run
    tools.agentExit({ phase_id: 'p2', agent_role: 'coder', signal: 'complete' });
    const r2 = tools.runSignal();
    assert.equal(r2.action.action, 'complete_run');
    assert.equal(tools.runState('r-0001').machine_state, 'completing');
  } finally {
    cleanup();
  }
});

test('run_signal: conductor-reported agent-died, respawn then death cap; no exit at all is guided', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.runSignal(), /no exit recorded.*agent-died/s);
    const died = { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'crash' as const } };
    const r1 = tools.runSignal({ exit: died });
    assert.equal(r1.action.action, 'spawn');
    assert.equal((r1.action as { respawn: boolean }).respawn, true);
    assert.equal(tools.runState().phases[0].status, 'in_progress', 'respawn keeps the phase open');

    const r2 = tools.runSignal({ exit: { ...died, payload: { observed: 'empty_output' } } });
    assert.equal(r2.action.action, 'judgment_needed');
    assert.equal(tools.runState().escalations.length, 1, 'escalation recorded on the run record');
  } finally {
    cleanup();
  }
});

test('run_signal: unknown signal reaching the brain halts the run loudly and durably (P5)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const r = tools.runSignal({ exit: { signal: 'garbage', phase_id: 'p1' } });
    assert.equal(r.action.action, 'halt');
    assert.equal(tools.runState('r-0001').machine_state, 'halted');
  } finally {
    cleanup();
  }
});

test('handoff pair: write validates, read filters by phase and files', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.handoffWrite({ handoff: { phase_id: 'p1' } }), /invalid/i);
    tools.handoffWrite({
      handoff: {
        phase_id: 'p1',
        agent_role: 'coder',
        what_changed: [{ path: 'src\\a.ts', change_role: 'implemented' }],
        wired: [],
        deferred: [],
        decisions_made: [],
        tests_produced: [],
        exit_signal: 'complete',
        unresolved: [],
      },
    });
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 1);
    assert.equal(tools.handoffRead({ files: ['src/a.ts'] }).length, 1);
    assert.equal(tools.handoffRead({ phase_id: 'p2' }).length, 0);
  } finally {
    cleanup();
  }
});
