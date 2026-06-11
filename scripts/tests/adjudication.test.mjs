import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { computeDivergenceFlags } from '../grill-plan-flags.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
let SterlingTools;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ SterlingTools } = await import(pathToFileURL(join(root, 'packages', 'mcp-server', 'dist', 'index.js')).href));
});

function runScript(script, args, cwd) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8', cwd, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function goodBrief(over = {}) {
  return {
    id: randomUUID(), type: 'brief', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug: 'sum', title: 'Sum', problem: 'p', feature: 'f',
    user_stated: { criteria: ['user said: integers'], constraints: [] },
    conductor_proposals: [{ text: 'stream output', status: 'confirmed' }],
    acceptance_criteria: [
      { ac_id: 'AC1', text: 'sum works end to end', verifiable_at: 'phase:1' },
      { ac_id: 'AC2', text: 'whole feature holds', verifiable_at: 'final' },
    ],
    technical_design: { approach: 'one module', interfaces: [{ name: 'sum', contract: 'sum(a,b) -> number' }], shared_structures: [] },
    risk_flags: ['perf_sensitive'],
    blast_radius: { files: [{ path: 'src/sum.mjs', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: ['src/main.mjs'],
    out_of_scope: ['src/legacy/**'],
    phases: [
      { phase_id: 'p1', goal: 'g', subtasks: ['build sum'], ac_ids: ['AC1'], files: ['src/sum.mjs'], interfaces: ['sum'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' },
    ],
    decisions_made: [],
    ...over,
  };
}

test('consume-exit (§5.2): intra-phase complete consumed via same-state CAS; abnormal exits refused toward run_signal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-consume-'));
  let store;
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
    store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const tools = new SterlingTools({ store });
    const brief = store.create(goodBrief());
    store.createRun({
      id: 'r-x', brief_ref: brief.id, branch: 'b', machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {}, escalations: [], started_at: NOW,
    });

    // nothing pending
    let r = runScript('consume-exit.mjs', ['--run', 'r-x', '--target', dir], dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no pending exit/);

    // test-writer's intra-phase complete: consumed, recorded, slot cleared, state unchanged
    tools.agentExit({ run_id: 'r-x', phase_id: 'p1', agent_role: 'test-writer', signal: 'complete', payload: { handoff_ref: 'p1/test-writer' } });
    r = runScript('consume-exit.mjs', ['--run', 'r-x', '--step', 'tests-written', '--target', dir], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).agent_role, 'test-writer');
    let run = store.getRun('r-x');
    assert.equal(run.machine_state, 'running', 'same-state CAS: no transition');
    assert.equal(run.phases[0].status, 'in_progress', 'phase stays open — complete was intra-phase');
    assert.equal(run.phases[0].signals.length, 1);
    assert.equal(run.phases[0].signals[0].intra_phase, true);
    assert.equal(store.getPendingExit('r-x'), undefined, 'pending slot cleared');

    // abnormal exit: consume refuses, directing to run_signal
    tools.agentExit({ run_id: 'r-x', phase_id: 'p1', agent_role: 'coder', signal: 'blocked', payload: { reason: 'missing креds' } });
    r = runScript('consume-exit.mjs', ['--run', 'r-x', '--target', dir], dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /abnormal exits go to run_signal/);
    // run_signal handles it from this mid-phase position
    const blocked = tools.runSignal({ run_id: 'r-x' });
    assert.equal(blocked.action.action, 'judgment_needed');

    // phase-boundary complete: run_signal advances (single phase → completion sequence); audit trail holds both signals
    tools.agentExit({ run_id: 'r-x', phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    const boundary = tools.runSignal({ run_id: 'r-x' });
    assert.equal(boundary.action.action, 'complete_run');
    run = store.getRun('r-x');
    assert.equal(run.machine_state, 'completing');
    assert.deepEqual(
      run.phases[0].signals.map((s) => s.signal),
      ['complete', 'blocked', 'complete'],
      'audit trail: intra-phase complete + abnormal + boundary complete all recorded'
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('grill-plan-flags (§7.6): clean gate-ready brief raises nothing; each divergence kind flags', () => {
  assert.deepEqual(computeDivergenceFlags(goodBrief()), []);

  const kinds = (b) => computeDivergenceFlags(b).map((f) => f.kind);

  assert.ok(
    kinds(goodBrief({ acceptance_criteria: [...goodBrief().acceptance_criteria, { ac_id: 'AC3', text: 'orphan', verifiable_at: 'phase:2' }] })).includes('ac_without_phase')
  );
  assert.ok(kinds(goodBrief({ phases: [{ ...goodBrief().phases[0], ac_ids: [] }] })).includes('phase_without_acs'));
  assert.ok(kinds(goodBrief({ conductor_proposals: [{ text: 'maybe stream?', status: 'unconfirmed' }] })).includes('unconfirmed_proposal'));
  assert.ok(kinds(goodBrief({ incidental_scope: ['src/legacy/old.mjs'] })).includes('scope_conflict'));
  assert.ok(kinds(goodBrief({ phases: [{ ...goodBrief().phases[0], files: ['src/elsewhere.mjs'] }] })).includes('phase_file_outside_scope'));
  assert.ok(kinds(goodBrief({ phases: [{ ...goodBrief().phases[0], interfaces: [] }] })).includes('phase_missing_interfaces'));
  assert.ok(kinds(goodBrief({ risk_flags: [] })).includes('no_risk_flags'));
});

test('grill-plan-flags CLI reads the brief from the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-flags-'));
  let store;
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
    store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const brief = store.create(goodBrief({ risk_flags: [] }));
    const r = runScript('grill-plan-flags.mjs', ['--brief', brief.id, '--target', dir], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).flags.map((f) => f.kind), ['no_risk_flags']);
    assert.equal(runScript('grill-plan-flags.mjs', ['--brief', randomUUID(), '--target', dir], dir).code, 2);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
