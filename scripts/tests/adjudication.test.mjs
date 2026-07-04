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

// ------------------- phase_over_wide breadth flag (run r-68eb, brief afd9b684, AC1 — gate split axis) -------------------
//
// computeDivergenceFlags(brief, config?) gains an ADDITIVE optional config param. A phase is
// over-wide ⇔ (phase.interfaces ?? []).length STRICTLY EXCEEDS config.difficulty.split_interface_threshold
// (default 3 when the param is omitted). Each over-wide phase emits {kind:'phase_over_wide', detail}
// whose detail NAMES phase_id, interface count, threshold-in-effect, and subtask count (the human's
// tiebreak signal). The exact detail field-shape is NOT frozen (decision 288936ab) — so these tests
// assert the required VALUES appear in the flag, representation-robust, via a JSON stringify. The
// probe values are chosen distinct (interface count 5, subtask count 8, threshold 3/4) so a naive
// implementation that drops one of the four is caught. phase_id 'p1' is kept (renaming it would
// orphan AC1's 'phase:1' and trip ac_without_phase); its only digit is '1', which none of the probe
// numbers reuse.

// Builds a brief whose single phase p1 declares `interfaceCount` interfaces (all also declared in
// technical_design.interfaces, per the briefSchema superRefine) and `subtaskCount` subtasks, staying
// otherwise clean (files in scope, ac_ids present, risk_flags present) so the ONLY divergence in play
// is phase_over_wide.
function wideBrief({ interfaceCount = 5, subtaskCount = 8 } = {}) {
  const names = Array.from({ length: interfaceCount }, (_, i) => `iface_${i}`);
  const base = goodBrief();
  return {
    ...base,
    technical_design: { ...base.technical_design, interfaces: names.map((n) => ({ name: n, contract: `${n}() -> void` })) },
    phases: [{
      ...base.phases[0],
      interfaces: names,
      subtasks: Array.from({ length: subtaskCount }, (_, i) => `subtask ${i}`),
    }],
  };
}

const overWideFlags = (b, config) =>
  (config === undefined ? computeDivergenceFlags(b) : computeDivergenceFlags(b, config)).filter((f) => f.kind === 'phase_over_wide');

test('phase_over_wide: an over-wide phase (5 interfaces > default 3) is flagged, naming phase_id + interface count + threshold + subtask count', () => {
  const flags = overWideFlags(wideBrief({ interfaceCount: 5, subtaskCount: 8 }));
  assert.equal(flags.length, 1, 'exactly one phase_over_wide flag for the one over-wide phase');
  const s = JSON.stringify(flags[0]);
  assert.ok(s.includes('p1'), 'detail names the offending phase (phase_id)');
  assert.ok(s.includes('5'), 'detail names the interface count (5)');
  assert.ok(s.includes('3'), 'detail names the threshold in effect (default 3)');
  assert.ok(s.includes('8'), "detail names the phase's subtask count (8) — the human's tiebreak signal");
});

test('phase_over_wide: strictly greater — a phase with interfaces exactly AT the threshold (3) is NOT flagged', () => {
  assert.equal(overWideFlags(wideBrief({ interfaceCount: 3 })).length, 0, 'interfaces.length === threshold is within bounds (strictly-greater predicate)');
  assert.equal(overWideFlags(wideBrief({ interfaceCount: 4 })).length, 1, 'one over the threshold IS flagged');
});

test('phase_over_wide: a brief whose phases are all within threshold emits no such flag', () => {
  assert.deepEqual(overWideFlags(goodBrief()), [], 'the 1-interface goodBrief is within threshold — no phase_over_wide');
  // and the whole clean brief remains flag-free (the additive param must not manufacture flags)
  assert.deepEqual(computeDivergenceFlags(goodBrief()), []);
});

test('phase_over_wide: called WITHOUT the config param, the threshold falls back to the schema default (3)', () => {
  const flags = overWideFlags(wideBrief({ interfaceCount: 5, subtaskCount: 8 }), undefined);
  assert.equal(flags.length, 1, 'a no-config call still flags an over-wide phase at the default threshold 3');
  assert.ok(JSON.stringify(flags[0]).includes('3'), 'the fallback threshold reported in detail is 3');
});

test('phase_over_wide: a custom difficulty.split_interface_threshold governs (tunable)', () => {
  const wide = wideBrief({ interfaceCount: 5, subtaskCount: 8 });
  // raise the threshold above the phase's breadth ⇒ no longer over-wide
  assert.equal(
    overWideFlags(wide, { difficulty: { split_interface_threshold: 10 } }).length,
    0,
    '5 interfaces is within a custom threshold of 10 — not flagged'
  );
  // lower the threshold below the breadth ⇒ flagged, and the custom threshold is the one reported
  const tightened = overWideFlags(wide, { difficulty: { split_interface_threshold: 4 } });
  assert.equal(tightened.length, 1, '5 interfaces exceeds a custom threshold of 4 — flagged');
  assert.ok(JSON.stringify(tightened[0]).includes('4'), 'the threshold-in-effect reported in detail is the custom 4, not the default 3');
});

test('phase_over_wide: additive param — omitting config is byte-identical to passing the default threshold, and never disturbs existing flags', () => {
  // For a non-over-wide brief that trips an existing flag, omitting config === passing the default-3 config.
  const b = goodBrief({ risk_flags: [] });
  assert.deepEqual(
    computeDivergenceFlags(b),
    computeDivergenceFlags(b, { difficulty: { split_interface_threshold: 3 } }),
    'omitted config falls back to the schema default 3 — result is byte-identical'
  );
  // the existing divergence is still detected, and no phase_over_wide is fabricated, with the param omitted
  const kinds = computeDivergenceFlags(b).map((f) => f.kind);
  assert.ok(kinds.includes('no_risk_flags'), 'existing flag behavior is preserved when the param is omitted');
  assert.ok(!kinds.includes('phase_over_wide'), 'a within-threshold brief gains no phase_over_wide from the additive param');
});
