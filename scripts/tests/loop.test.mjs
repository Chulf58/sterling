import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(root, 'scripts');
const NOW = '2026-06-10T12:00:00.000Z';
const BEFORE_RUN = '2026-06-09T12:00:00.000Z';

let SterlingStore;
let SterlingTools;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ SterlingTools } = await import(pathToFileURL(join(root, 'packages', 'mcp-server', 'dist', 'index.js')).href));
});

function runScript(script, args, cwd) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', cwd, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

function articleFields(briefId, { traceAC = true, fulfills = [] } = {}) {
  return {
    slug: 'calc-add',
    title: 'Calculator addition',
    what_it_does: 'Adds two numbers via the calc module.',
    intended_behavior: 'add(a, b) returns the arithmetic sum.',
    files: [{ path: 'src/calc.mjs', role: 'implementation' }],
    current_ac: [{ ac_id: 'AC1', text: 'add(2,3) returns 5 end to end', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief', target_id: briefId }],
    live_test_refs: traceAC ? [{ ac_id: 'AC1', test_paths: ['tests/calc.test.mjs'] }] : [],
    links: fulfills.map((id) => ({ rel: 'fulfills', target_id: id })),
  };
}

function makeLoopProject({ backupPath = true, reconcileGapArticle = false, mountDomain = false, decisionInDecisionsMade = false, phaseInterfaces = [], splitThreshold = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-loop-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const config = {
    toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }],
    prep_cap: 10,
  };
  // AC2 breadth backstop: an optional custom split_interface_threshold, on the SAME
  // config field the gate flag and H8 read (difficulty.split_interface_threshold).
  // Omitted → the schema default (3) governs and existing callers write no difficulty
  // block, so their behavior is byte-identical.
  if (splitThreshold != null) config.difficulty = { split_interface_threshold: splitThreshold };
  // opt-in domain mount (read-side wiring test): stack_tags ARE the mount
  // manifest (§3.3); domain_paths pins the shared store inside the temp dir so
  // the test never touches the real ~/.sterling/domains.
  if (mountDomain) {
    config.stack_tags = ['node'];
    config.domain_paths = { node: join(dir, 'domains', 'node', 'sterling.db').replace(/\\/g, '/') };
  }
  if (backupPath) config.backup_path = join(dir, 'backups').replace(/\\/g, '/');
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));

  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store });

  // seeded knowledge: a decision and a prior article with a known gap on the blast file
  const decision = store.create({
    ...envelope('decision', BEFORE_RUN),
    title: 'Numbers stay numbers',
    statement: 'calc functions never coerce strings.',
    alternatives_rejected: [],
    rationale: 'Coercion bugs.',
    file_keys: ['src/calc.mjs'],
  });
  const gapArticle = store.create({
    ...envelope('feature_article', BEFORE_RUN),
    ...articleFields(randomUUID()),
    slug: 'calc-legacy',
    known_gaps: [{ site: 'src/calc.mjs:1', kind: 'mutation_survivor', evidence: 'survivor in run r-0', recorded_run: 'r-0' }],
    history: [{ date: BEFORE_RUN, event: 'originating brief' }],
    links: [],
  });
  const todo = store.create({ ...envelope('todo', BEFORE_RUN), text: 'ship calc add', source: 'user', priority: 'normal' });

  const brief = store.create({
    ...envelope('brief'),
    slug: 'calc-add',
    title: 'Calculator addition',
    problem: 'No addition.',
    feature: 'add(a,b)',
    user_stated: { criteria: ['user said: integers must work'], constraints: [] },
    conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'add(2,3) returns 5 end to end', verifiable_at: 'final' }],
    technical_design: { approach: 'single module', interfaces: phaseInterfaces.map((n) => ({ name: n, contract: `${n}() -> void` })), shared_structures: [] },
    blast_radius: {
      files: [
        { path: 'src/calc.mjs', owning_articles: [] },
        { path: 'src/main.mjs', owning_articles: [] },
        { path: 'tests/calc.test.mjs', owning_articles: [] },
      ],
      reconcile_list: reconcileGapArticle ? [gapArticle.id] : [],
    },
    incidental_scope: [],
    out_of_scope: [],
    phases: [
      { phase_id: 'p1', goal: 'implement add', subtasks: ['write add'], ac_ids: ['AC1'], interfaces: phaseInterfaces, difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet', rank_terms: ['calc'] },
    ],
    // required_by_contract (AC3) = staged ids ∩ brief.decisions_made — the seeded
    // decision is staged (file-keyed to the phase file), so opting it into
    // decisions_made makes the join non-empty.
    decisions_made: decisionInDecisionsMade ? [decision.id] : [],
  });
  const run = store.createRun({
    id: 'r-loop',
    brief_ref: brief.id,
    branch: 'sterling/run-r-loop',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });

  // a DOMAIN-scoped record in the mounted shared store, file-keyed to the phase's
  // blast file — prep must fan across the mount to stage it (read-side wiring).
  let domainDecision;
  if (mountDomain) {
    mkdirSync(dirname(config.domain_paths.node), { recursive: true });
    const domainStore = new SterlingStore(config.domain_paths.node);
    domainDecision = domainStore.create({
      ...envelope('decision', BEFORE_RUN),
      scope: 'domain:node',
      title: 'shared node calc lesson',
      statement: 'cross-project calc guidance.',
      alternatives_rejected: [],
      rationale: 'domain knowledge.',
      file_keys: ['src/calc.mjs'],
    });
    domainStore.close();
  }

  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, decision, gapArticle, todo, brief, run, domainDecision, cleanup };
}

function writeHandoffs(tools, { decisions = ['kept add minimal'] } = {}) {
  tools.handoffWrite({
    handoff: {
      phase_id: 'p1',
      agent_role: 'test-writer',
      what_changed: [{ path: 'tests/calc.test.mjs', change_role: 'authored AC1 test' }],
      wired: [],
      deferred: [],
      decisions_made: [],
      tests_produced: ['tests/calc.test.mjs'],
      exit_signal: 'complete',
      unresolved: [],
    },
  });
  tools.handoffWrite({
    handoff: {
      phase_id: 'p1',
      agent_role: 'coder',
      what_changed: [
        { path: 'src/calc.mjs', change_role: 'implemented add' },
        { path: 'src/main.mjs', change_role: 'wired add into the entry point' },
      ],
      wired: ['add'],
      deferred: [],
      decisions_made: decisions,
      tests_produced: [],
      subtask_evidence: [{ subtask: 'write add', files: ['src/calc.mjs', 'src/main.mjs'], tests: ['tests/calc.test.mjs'] }],
      exit_signal: 'complete',
      unresolved: [],
    },
  });
}

/** Drive the fixture to 'completing' with capture done, then optionally break one condition. */
function makeReadyToDispose(opts = {}) {
  const fix = makeLoopProject(opts);
  const { store, tools, brief, todo } = fix;
  writeHandoffs(tools, { decisions: opts.decisions === 'none' ? [] : ['kept add minimal'] });
  if (opts.decisions === 'captured' || opts.decisions === undefined) {
    tools.knowledgeCreate('decision', { title: 'Minimal add', statement: 'No generics.', alternatives_rejected: [], rationale: 'Spine.' });
  }
  let article;
  if (opts.article !== false) {
    ({ record: article } = tools.knowledgeCreate(
      'feature_article',
      articleFields(brief.id, { traceAC: opts.traceAC !== false, fulfills: [todo.id] })
    ));
    if (!opts.leaveTodo) tools.boardRemove(todo.id);
  }
  store.casTransition('running', { ...store.getRun('r-loop'), machine_state: 'completing' });
  return { ...fix, article };
}

// ---------------------------------------------------------------------------
// dispose-run refusal paths — one per promotion condition (invariant 6)
// ---------------------------------------------------------------------------

function assertRefused(fix, pattern, expectedState = 'completing') {
  const stateBefore = fix.store.getRun('r-loop').machine_state;
  const handoffsBefore = fix.store.readHandoffs('r-loop').length;
  const r = runScript('dispose-run.mjs', ['--run', 'r-loop', '--target', fix.dir], fix.dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, pattern);
  assert.match(r.stderr, /nothing was deleted/);
  assert.equal(stateBefore, expectedState);
  assert.equal(fix.store.getRun('r-loop').machine_state, expectedState, 'refusal must not change state');
  assert.equal(fix.store.readHandoffs('r-loop').length, handoffsBefore, 'refusal must not delete rows');
  return r;
}

test('dispose-run refuses: no active run at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-norun-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ backup_path: join(dir, 'b').replace(/\\/g, '/') }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  store.close();
  try {
    const r = runScript('dispose-run.mjs', ['--target', dir], dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no_active_run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispose-run refuses: wrong machine_state (running)', () => {
  const fix = makeLoopProject();
  try {
    writeHandoffs(fix.tools);
    assertRefused(fix, /wrong_state/, 'running');
  } finally {
    fix.cleanup();
  }
});

test('dispose-run refuses: backup path missing — snapshots are a promotion condition', () => {
  const fix = makeReadyToDispose({ backupPath: false });
  try {
    assertRefused(fix, /backup_path_missing/);
    assert.equal(fix.store.getRun('r-loop').machine_state, 'completing', 'refusal leaves state untouched');
  } finally {
    fix.cleanup();
  }
});

test('dispose-run refuses: feature article missing (capture gate did not run)', () => {
  const fix = makeReadyToDispose({ article: false });
  try {
    assertRefused(fix, /feature_article_missing/);
  } finally {
    fix.cleanup();
  }
});

test('dispose-run refuses: reconcile_list article not reconciled during the run', () => {
  // gapArticle predates the run and sits on the reconcile list, untouched
  const fix = makeReadyToDispose({ reconcileGapArticle: true });
  try {
    assertRefused(fix, /article_unreconciled/);
    // reconciling it (versioned update during the run) clears the refusal
    fix.tools.knowledgeUpdate(fix.gapArticle.id, { what_it_does: 'Reconciled to current reality.', version: 2 });
    const r = runScript('dispose-run.mjs', ['--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  } finally {
    fix.cleanup();
  }
});

test('dispose-run refuses: handoffs report decisions but none were captured', () => {
  const fix = makeReadyToDispose({ decisions: 'uncaptured' });
  try {
    assertRefused(fix, /decisions_uncaptured/);
  } finally {
    fix.cleanup();
  }
});

test('dispose-run refuses: an AC has no traced test on the article', () => {
  const fix = makeReadyToDispose({ traceAC: false });
  try {
    assertRefused(fix, /ac_untraced.*AC1/);
  } finally {
    fix.cleanup();
  }
});

test('dispose-run refuses: fulfilled todo still on the board', () => {
  const fix = makeReadyToDispose({ leaveTodo: true });
  try {
    assertRefused(fix, /fulfilled_todo_still_on_board/);
  } finally {
    fix.cleanup();
  }
});

test('prep [S] fans the knowledge_pack across mounted domain stores (read-side domain wiring)', () => {
  const fix = makeLoopProject({ mountDomain: true });
  const { dir, decision, domainDecision } = fix;
  try {
    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', dir], dir);
    assert.equal(prep.code, 0, prep.stderr);
    const pack = JSON.parse(readFileSync(join(dir, '.sterling', 'runs', 'r-loop', 'knowledge_pack-p1.json'), 'utf8'));
    assert.ok(pack.returned_record_ids.includes(decision.id), 'project-scoped record staged (project-first)');
    assert.ok(
      pack.returned_record_ids.includes(domainDecision.id),
      'DOMAIN-scoped record staged — prep fans the pack across mounted domain stores'
    );
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the loop, end to end — spine acceptance (§16.1)
// ---------------------------------------------------------------------------

test('one-phase pipeline end-to-end: brief → prep → red → green → completeness → capture → dispose → merge gate', () => {
  const fix = makeLoopProject();
  const { dir, store, tools, brief, todo, decision, gapArticle } = fix;
  try {
    // prep [S]: stages knowledge, writes the pack
    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', dir], dir);
    assert.equal(prep.code, 0, prep.stderr);
    const pack = JSON.parse(readFileSync(join(dir, '.sterling', 'runs', 'r-loop', 'knowledge_pack-p1.json'), 'utf8'));
    assert.ok(pack.returned_record_ids.includes(decision.id), 'file-keyed decision staged');
    assert.ok(pack.returned_record_ids.includes(gapArticle.id), 'gap article staged');
    assert.deepEqual(pack.mandatory, [{ record_id: gapArticle.id, reason: 'known_gap' }], 'known gaps are mandatory items (§3.7)');

    // test-writer stand-in: stub + adversarial test (assertion-red, not crash-red)
    writeFileSync(join(dir, 'src', 'calc.mjs'), 'export const add = () => 0;\n');
    writeFileSync(
      join(dir, 'tests', 'calc.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/calc.mjs';\ntest('AC1: add(2,3) is 5', () => assert.equal(add(2, 3), 5));\n"
    );

    // red check: must fail on assertions; freezes the phase's test baseline (§9.2)
    const red = runScript('test-check.mjs', ['--expect', 'red', '--scope', 'tests/calc.test.mjs', '--run', 'r-loop', '--phase', 'p1', '--target', dir], dir);
    assert.equal(red.code, 0, red.stdout + red.stderr);
    assert.equal(JSON.parse(red.stdout).overall, 'assertion_fail');
    assert.equal(JSON.parse(red.stdout).baseline_frozen, 1, 'oracle frozen at red');

    // a green expectation at this point correctly fails
    const notGreen = runScript('test-check.mjs', ['--expect', 'green', '--scope', 'tests/calc.test.mjs', '--target', dir], dir);
    assert.equal(notGreen.code, 1);

    // coder stand-in implements AND wires (H12 is live for node now); handoffs through the store (§7.4)
    writeFileSync(join(dir, 'src', 'calc.mjs'), 'export const add = (a, b) => a + b;\n');
    writeFileSync(join(dir, 'src', 'main.mjs'), "import { add } from './calc.mjs';\nconsole.log(add(2, 3));\n");
    writeHandoffs(tools);

    // green check: pass + mutation check skipped loudly where it would have run
    const green = runScript('test-check.mjs', ['--expect', 'green', '--scope', 'tests/calc.test.mjs', '--run', 'r-loop', '--target', dir], dir);
    assert.equal(green.code, 0, green.stdout + green.stderr);
    assert.deepEqual(JSON.parse(green.stdout).check_skipped, [{ check: 'mutation-check', reason: 'not_built' }]);

    // exit wire + brain: single phase completes the run
    tools.agentExit({ run_id: 'r-loop', phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    const signal = tools.runSignal({ run_id: 'r-loop' });
    assert.equal(signal.action.action, 'complete_run');
    assert.equal(store.getRun('r-loop').machine_state, 'completing');

    // completeness [S] (final): mechanical checks pass; judgment/reviewers/test-integrity
    // skip loudly; H12 wiring RUNS (node adapter static_wiring live, step 7) and is clean
    const comp = runScript('completeness-check.mjs', ['--run', 'r-loop', '--phase', 'p1', '--final', '--target', dir], dir);
    assert.equal(comp.code, 0, comp.stderr);
    const compOut = JSON.parse(comp.stdout);
    assert.deepEqual(compOut.check_skipped, [
      { check: 'reviewer-dispatch', reason: 'not_built' },
      { check: 'whole-run-diff', reason: 'no_base_branch' },
    ]);
    assert.ok(!compOut.problems.some((p) => /subtask-evidence/.test(p)), 'every subtask cited with existing, passing evidence (§17 structure-first)');
    assert.deepEqual(compOut.wiring.violations, [], 'add is wired via src/main.mjs — H12 live and clean');
    assert.ok(!compOut.problems.some((p) => /test-integrity/.test(p)), 'frozen baseline intact — integrity ran clean');

    // capture: article (AC-traced, fulfills the todo), decision, todo removed by the fulfilling write
    const { record: article } = tools.knowledgeCreate('feature_article', articleFields(brief.id, { traceAC: true, fulfills: [todo.id] }));
    tools.knowledgeCreate('decision', { title: 'Minimal add', statement: 'No generics.', alternatives_rejected: [], rationale: 'Spine scope.' });
    tools.boardRemove(todo.id);

    // dispose-run: verifies, snapshots, disposes rows + dir, advances state
    const dispose = runScript('dispose-run.mjs', ['--run', 'r-loop', '--target', dir], dir);
    assert.equal(dispose.code, 0, dispose.stdout + dispose.stderr);
    const out = JSON.parse(dispose.stdout);
    assert.ok(existsSync(out.snapshot), 'snapshot exists at the backup path');
    assert.equal(existsSync(join(dir, '.sterling', 'runs', 'r-loop')), false, 'runs/<id>/ disposed');
    assert.equal(store.readHandoffs('r-loop').length, 0, 'handoff rows disposed');
    assert.equal(store.listCheckSkipped('r-loop').length, 0, 'check_skipped rows disposed after folding');

    const after = store.getRun('r-loop');
    assert.equal(after.machine_state, 'awaiting_merge_gate');
    assert.equal(after.summaries.knowledge_packs[0].mandatory[0].record_id, gapArticle.id, 'pack summary survives on the run record');

    // SPINE ACCEPTANCE (§16.1): the run completed with every unbuilt check skipped loudly
    const skippedNames = new Set(after.summaries.check_skipped.map((s) => s.check_name));
    for (const expected of [
      'dedup-merge',
      'board-remove-artifact-binding',
      'mutation-check',
      'reviewer-dispatch',
      'whole-run-diff',
      'objection-triage',
      'mutation-survivors-to-known-gaps',
    ]) {
      assert.ok(skippedNames.has(expected), `spine acceptance: '${expected}' must have been skipped loudly`);
    }

    // the snapshot is a valid store containing the captured article
    const restored = new SterlingStore(out.snapshot);
    try {
      assert.equal(restored.get(article.id).slug, 'calc-add');
    } finally {
      restored.close();
    }

    // merge gate: summary first, then the human decision
    const gate = runScript('merge-gate.mjs', ['--run', 'r-loop', '--target', dir], dir);
    assert.equal(gate.code, 0, gate.stderr);
    const gateSummary = JSON.parse(gate.stdout);
    assert.ok(gateSummary.summaries.check_skipped.length >= 7, 'the merge-gate summary lists every skip (§9.1)');

    const merged = runScript('merge-gate.mjs', ['--run', 'r-loop', '--decision', 'merge', '--target', dir], dir);
    assert.equal(merged.code, 0, merged.stderr);
    assert.equal(store.getRun('r-loop').machine_state, 'merged');

    // gate refuses to act outside awaiting_merge_gate
    const again = runScript('merge-gate.mjs', ['--run', 'r-loop', '--decision', 'merge', '--target', dir], dir);
    assert.equal(again.code, 1);
  } finally {
    fix.cleanup();
  }
});

test('test-check red freezes the baseline even when --phase is OMITTED (resolves the run\'s in-progress phase) — audit finding 16/43', () => {
  const fix = makeLoopProject();
  const { dir } = fix;
  try {
    // an assertion-red without --phase: previously the freeze was silently skipped
    writeFileSync(join(dir, 'src', 'calc.mjs'), 'export const add = () => 0;\n');
    writeFileSync(
      join(dir, 'tests', 'calc.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/calc.mjs';\ntest('AC1', () => assert.equal(add(2, 3), 5));\n"
    );
    const red = runScript('test-check.mjs', ['--expect', 'red', '--scope', 'tests/calc.test.mjs', '--run', 'r-loop', '--target', dir], dir);
    assert.equal(red.code, 0, red.stdout + red.stderr);
    const out = JSON.parse(red.stdout);
    assert.equal(out.overall, 'assertion_fail');
    assert.equal(out.baseline_frozen, 1, 'phase resolved from the run\'s in_progress phase; oracle frozen without --phase');
    assert.ok(existsSync(join(dir, '.sterling', 'runs', 'r-loop', 'test-baseline-p1.json')), 'baseline file written for the resolved phase');
  } finally {
    fix.cleanup();
  }
});

test('dispose-run success is reachable from the ready fixture (control for the refusal tests)', () => {
  const fix = makeReadyToDispose();
  try {
    const r = runScript('dispose-run.mjs', ['--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fix.store.getRun('r-loop').machine_state, 'awaiting_merge_gate');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// dispose-run --abort: sanctioned pre-green teardown (run blocked before green)
// ---------------------------------------------------------------------------

test('dispose-run --abort: a pre-green run normal-disposal REFUSES is torn down to rejected', () => {
  // r-loop is the pre-green fixture: machine_state 'running', phase p1 in_progress,
  // no capture done — exactly a run that cannot reach the merge gate.
  const fix = makeLoopProject();
  try {
    const runBefore = fix.store.getRun('r-loop');
    assert.equal(runBefore.machine_state, 'running');
    assert.equal(runBefore.phases[0].status, 'in_progress');

    // a left-over run-scoped artifact, to prove the dir is torn down
    mkdirSync(join(fix.dir, '.sterling', 'runs', 'r-loop'), { recursive: true });
    writeFileSync(join(fix.dir, '.sterling', 'runs', 'r-loop', 'knowledge_pack-p1.json'), '{}');

    // NORMAL dispose-run refuses a pre-green run (wrong_state) and changes nothing
    const refused = runScript('dispose-run.mjs', ['--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /wrong_state/);
    assert.equal(fix.store.getRun('r-loop').machine_state, 'running', 'refusal leaves the run untouched');

    // --abort drives it to 'rejected' and tears down the transient state + dir
    const aborted = runScript('dispose-run.mjs', ['--abort', '--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
    // LOUD summary printed before acting
    assert.match(aborted.stderr, /tearing down run 'r-loop'/);
    assert.match(aborted.stderr, /machine_state : running/);
    assert.match(aborted.stderr, /p1=in_progress/);
    const out = JSON.parse(aborted.stdout);
    assert.deepEqual(
      { run_id: out.run_id, aborted: out.aborted, machine_state: out.machine_state },
      { run_id: 'r-loop', aborted: true, machine_state: 'rejected' }
    );
    // no git in this fixture + no base_branch → branch discard skipped LOUDLY, never a crash
    assert.deepEqual(out.branch, { skipped: 'branch-discard', reason: 'no_base_branch' });

    // 'rejected' is non-active → getRun() (no id) stops returning it
    assert.equal(fix.store.getRun(), undefined, 'no active run after abort');
    assert.equal(fix.store.getRun('r-loop').machine_state, 'rejected', 'the run record persists, terminal');
    // runs/<id>/ is gone
    assert.equal(existsSync(join(fix.dir, '.sterling', 'runs', 'r-loop')), false, 'run dir torn down');

    // durable knowledge captured during the run is NOT touched by abort
    assert.ok(fix.store.get(fix.decision.id), 'seeded decision survives abort');

    // P4 purge (R2 board 82f04007): the abort event ends the run's life — its
    // handoff + check_skipped rows go with it (incl. the branch-discard skip
    // recorded during this very abort; previously only disposeRunRows deleted
    // rows and it refuses non-'completing' runs, so aborted runs leaked forever).
    assert.deepEqual(fix.store.readHandoffs('r-loop'), [], 'no handoff rows survive an abort');
    assert.deepEqual(fix.store.listCheckSkipped('r-loop'), [], 'no check_skipped rows survive an abort');

    // abort refuses a second time — the run is now terminal
    const again = runScript('dispose-run.mjs', ['--abort', '--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already terminal \('rejected'\)/);
  } finally {
    fix.cleanup();
  }
});

test('dispose-run --abort: discards the run branch (real git), leaving the base untouched', () => {
  const fix = makeLoopProject();
  try {
    const { dir, store } = fix;
    // a real git project with the run checked out on its branch, base recorded
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'abort@sterling.local']);
    git(dir, ['config', 'user.name', 'Abort Test']);
    writeFileSync(join(dir, 'base.txt'), 'on main\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base', '--no-verify']);
    git(dir, ['checkout', '-b', 'sterling/run-r-loop']);
    writeFileSync(join(dir, 'wip.txt'), 'abandoned run work\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'wip', '--no-verify']);
    // record the base_branch the way startRunBranch would
    store.casTransition('running', { ...store.getRun('r-loop'), base_branch: 'main' });
    store.casTransition('running', { ...store.getRun('r-loop'), machine_state: 'halted' });

    const aborted = runScript('dispose-run.mjs', ['--abort', '--run', 'r-loop', '--target', dir], dir);
    assert.equal(aborted.code, 0, aborted.stdout + aborted.stderr);
    const out = JSON.parse(aborted.stdout);
    assert.equal(out.machine_state, 'rejected');
    assert.deepEqual(out.branch, { base_untouched: 'main' });

    // back on the base branch, the run branch deleted, the abandoned commit gone from main
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'checked out base after abort');
    assert.equal(git(dir, ['branch', '--list', 'sterling/run-r-loop']), '', 'run branch deleted');
    assert.equal(existsSync(join(dir, 'wip.txt')), false, 'abandoned run work is not on the base branch');
    assert.equal(store.getRun(), undefined, 'no active run after abort');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 (run r-d630 phase 3) — prep emits role-scoped dispatch slices + stamps
// run.review_mandatory; the knowledge_pack manifest is unchanged.
// ---------------------------------------------------------------------------

const RUN_DIR = (dir) => join(dir, '.sterling', 'runs', 'r-loop');
const SLICE_MARKER = (role) =>
  new RegExp(`^STERLING-SLICE run=r-loop phase=p1 role=${role} staged=\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$`);

test('AC3: prep emits reviewer + builder slices (marker line 1); reviewer body = decision/anti_pattern only + known_gap mandatory; builder body = full pack; pack manifest unchanged; review_mandatory stamped', () => {
  const fix = makeLoopProject(); // decisions_made [] → required_by_contract empty; only the known_gap is mandatory
  const { dir, store, decision, gapArticle, brief } = fix;
  try {
    // a plain feature_article keyed on the phase file, NOT a known_gap and NOT in
    // decisions_made: it must be STAGED (broad pack) yet EXCLUDED from the reviewer
    // slice (reviewer = anti_pattern/decision only), while present in the builder slice.
    const plainArticle = store.create({
      ...envelope('feature_article'),
      ...articleFields(brief.id),
      slug: 'calc-plain',
      links: [],
    });

    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', dir], dir);
    assert.equal(prep.code, 0, prep.stderr);

    const reviewerPath = join(RUN_DIR(dir), 'dispatch_slice-p1-reviewer.md');
    const builderPath = join(RUN_DIR(dir), 'dispatch_slice-p1-builder.md');
    assert.equal(existsSync(reviewerPath), true, 'prep emits runs/<id>/dispatch_slice-p1-reviewer.md');
    assert.equal(existsSync(builderPath), true, 'prep emits runs/<id>/dispatch_slice-p1-builder.md');

    const reviewer = readFileSync(reviewerPath, 'utf8');
    const builder = readFileSync(builderPath, 'utf8');

    // line 1 is the deterministic marker; ISO asserted by FORMAT, not exact value
    assert.match(reviewer.split('\n')[0], SLICE_MARKER('reviewer'), 'reviewer slice line 1 is the STERLING-SLICE marker');
    assert.match(builder.split('\n')[0], SLICE_MARKER('builder'), 'builder slice line 1 is the STERLING-SLICE marker');

    // reviewer body: decision (allowed type) present by full UUID; the plain
    // feature_article (non-mandatory) ABSENT — no feature_articles as knowledge records
    assert.ok(reviewer.includes(decision.id), 'reviewer slice carries the file-keyed decision (full UUID)');
    assert.ok(!reviewer.includes(plainArticle.id), 'a non-mandatory feature_article is NOT in the reviewer slice');

    // mandatory section: the known_gap record by full UUID with its reason
    assert.ok(reviewer.includes(gapArticle.id), 'the known_gap record is a mandatory item (full UUID)');
    assert.match(reviewer, /known_gap/, 'the mandatory known_gap item carries its reason');

    // builder body: the FULL staged pack — decision + both articles by full UUID
    assert.ok(builder.includes(decision.id), 'builder slice renders the decision');
    assert.ok(builder.includes(plainArticle.id), 'builder slice renders the plain feature_article (full pack)');
    assert.ok(builder.includes(gapArticle.id), 'builder slice renders the gap article (full pack)');

    // the knowledge_pack manifest is unchanged in shape/content
    const pack = JSON.parse(readFileSync(join(RUN_DIR(dir), 'knowledge_pack-p1.json'), 'utf8'));
    assert.ok(pack.returned_record_ids.includes(decision.id), 'pack manifest still stages the decision');
    assert.ok(pack.returned_record_ids.includes(gapArticle.id), 'pack manifest still stages the gap article');
    assert.deepEqual(pack.mandatory, [{ record_id: gapArticle.id, reason: 'known_gap' }], 'pack.mandatory byte-unchanged (known_gap only)');

    // run.review_mandatory stamped for the phase = the mandatory union (known_gap only here)
    const rm = (store.getRun('r-loop').review_mandatory ?? []).filter((m) => m.phase_id === 'p1');
    assert.deepEqual(
      [...new Set(rm.map((m) => m.record_id))].sort(),
      [gapArticle.id].sort(),
      'prep stamps run.review_mandatory for p1 with the mandatory record ids'
    );
    assert.equal(rm.find((m) => m.record_id === gapArticle.id)?.reason, 'known_gap', 'the stamped known_gap item carries its reason');
  } finally {
    fix.cleanup();
  }
});

test('AC3: a non-empty required_by_contract join (staged decision ∈ brief.decisions_made) lands the decision as a mandatory item with an excerpt, and stamps it into review_mandatory alongside the known_gap', () => {
  const fix = makeLoopProject({ decisionInDecisionsMade: true }); // decisions_made = [decision.id]
  const { dir, store, decision, gapArticle } = fix;
  try {
    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', dir], dir);
    assert.equal(prep.code, 0, prep.stderr);

    const reviewerPath = join(RUN_DIR(dir), 'dispatch_slice-p1-reviewer.md');
    assert.equal(existsSync(reviewerPath), true, 'prep emits runs/<id>/dispatch_slice-p1-reviewer.md');
    const reviewer = readFileSync(reviewerPath, 'utf8');

    // required_by_contract mandatory item: decision by full UUID, its reason, and a
    // mechanical excerpt of its primary structured field (the decision.statement)
    assert.ok(reviewer.includes(decision.id), 'the required_by_contract decision is a mandatory item (full UUID)');
    assert.match(reviewer, /required_by_contract/, 'the mandatory item names the required_by_contract lane');
    assert.ok(reviewer.includes('calc functions never coerce strings'), 'the mandatory item carries a mechanical excerpt of the record primary field');

    // run.review_mandatory = known_gap ∪ required_by_contract for the phase
    const rm = (store.getRun('r-loop').review_mandatory ?? []).filter((m) => m.phase_id === 'p1');
    const ids = new Set(rm.map((m) => m.record_id));
    assert.ok(ids.has(gapArticle.id), 'known_gap id stamped');
    assert.ok(ids.has(decision.id), 'required_by_contract id stamped (the union)');
    assert.equal(rm.find((m) => m.record_id === decision.id)?.reason, 'required_by_contract', 'the decision item is stamped as required_by_contract');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC5 (run r-d630 phase 3) — dispose-run folds the undispositioned remainder into
// the surviving summaries BEFORE deleting transients; merge-gate prints it.
// ---------------------------------------------------------------------------

function writeReviewerHandoff(store, agent_role, dispositions, at) {
  store.writeHandoff(
    'r-loop',
    {
      phase_id: 'p1',
      agent_role,
      what_changed: [],
      wired: [],
      deferred: [],
      decisions_made: [],
      tests_produced: [],
      dispositions,
      exit_signal: 'complete',
      unresolved: [],
    },
    at
  );
}

test('AC5: dispose-run folds a populated undispositioned remainder into surviving summaries, and merge-gate prints it — a wrong role-string handoff bypasses the wire out-of-band, so its dispositions never count', () => {
  const fix = makeReadyToDispose();
  const { store } = fix;
  try {
    const m1 = randomUUID();
    const m2 = randomUUID();
    store.setRunReviewMandatory('r-loop', 'p1', [
      { record_id: m1, reason: 'known_gap' },
      { record_id: m2, reason: 'required_by_contract' },
    ]);
    // out-of-band: dispositions carried under a NON-reviewer role string (a typo of a
    // reviewer role). The phase-2 wire check ignores it; the fold must credit ONLY the
    // exact REVIEWER_ROLES, so m1/m2 remain undispositioned (catches a prefix-match mutant).
    writeReviewerHandoff(
      store,
      'reviewer-correctnes', // typo → not a REVIEWER_ROLE
      [
        { record_id: m1, disposition: 'addressed' },
        { record_id: m2, disposition: 'addressed' },
      ],
      '2026-06-10T12:30:00.000Z'
    );

    const dispose = runScript('dispose-run.mjs', ['--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(dispose.code, 0, dispose.stdout + dispose.stderr);
    assert.equal(existsSync(RUN_DIR(fix.dir)), false, 'transients deleted (the fold ran BEFORE deletion)');

    const und = store.getRun('r-loop').summaries?.undispositioned_mandatory;
    assert.ok(Array.isArray(und), 'dispose folds summaries.undispositioned_mandatory (it survives disposal)');
    const ids = new Set(und.map((x) => x.record_id));
    assert.ok(ids.has(m1) && ids.has(m2), 'both mandatory ids remain undispositioned — a non-reviewer role string never counts');
    assert.ok(und.every((x) => x.phase_id === 'p1'), 'the remainder is folded per-phase');

    const gate = runScript('merge-gate.mjs', ['--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(gate.code, 0, gate.stderr);
    const gs = JSON.parse(gate.stdout);
    assert.ok(Array.isArray(gs.summaries.undispositioned_mandatory), 'merge-gate summary carries undispositioned_mandatory');
    const gateIds = new Set(gs.summaries.undispositioned_mandatory.map((x) => x.record_id));
    assert.ok(gateIds.has(m1) && gateIds.has(m2), 'the gate prints the populated remainder (the wire was bypassed out-of-band)');
  } finally {
    fix.cleanup();
  }
});

test('AC5: undispositioned_mandatory is EMPTY when a genuine reviewer-role handoff dispositions every mandatory id — dispose folds [] and merge-gate prints empty', () => {
  const fix = makeReadyToDispose();
  const { store } = fix;
  try {
    const m1 = randomUUID();
    const m2 = randomUUID();
    store.setRunReviewMandatory('r-loop', 'p1', [
      { record_id: m1, reason: 'known_gap' },
      { record_id: m2, reason: 'required_by_contract' },
    ]);
    // an exact REVIEWER_ROLES handoff covering both ids (both disposition verbs)
    writeReviewerHandoff(
      store,
      'reviewer-correctness',
      [
        { record_id: m1, disposition: 'addressed' },
        { record_id: m2, disposition: 'not_applicable_because', reason: 'not exercised on this path' },
      ],
      '2026-06-10T12:30:00.000Z'
    );

    const dispose = runScript('dispose-run.mjs', ['--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(dispose.code, 0, dispose.stdout + dispose.stderr);

    const und = store.getRun('r-loop').summaries?.undispositioned_mandatory;
    assert.ok(Array.isArray(und), 'undispositioned_mandatory is present (an array) even when coverage is complete');
    assert.deepEqual(und, [], 'empty when the wire enforcement did its job (every mandatory id dispositioned by a reviewer handoff)');

    const gate = runScript('merge-gate.mjs', ['--run', 'r-loop', '--target', fix.dir], fix.dir);
    assert.equal(gate.code, 0, gate.stderr);
    const gs = JSON.parse(gate.stdout);
    assert.deepEqual(gs.summaries.undispositioned_mandatory, [], 'merge-gate prints an empty undispositioned_mandatory when coverage was complete');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC2 (run r-68eb phase 2) — prep breadth backstop: prep REFUSES to stage a phase
// whose interface count STRICTLY EXCEEDS config.difficulty.split_interface_threshold
// (default 3). Refusal is a HARD backstop: non-zero exit; nothing staged — no
// knowledge_pack, no dispatch_slice files, no review_mandatory stamp; the message
// names phase/count/threshold and the split remedy. The check sits immediately after
// phase resolution, BEFORE prep's first write. A within-threshold phase stages
// exactly as today. Probe interface counts are chosen distinct (5, 4, 3) so an
// off-by-one (>= vs >) mutant is caught by the exactly-at-threshold boundary.
// ---------------------------------------------------------------------------

// The over-wide-run artefact paths prep would otherwise create.
const packPath = (dir) => join(RUN_DIR(dir), 'knowledge_pack-p1.json');
const reviewerSlicePath = (dir) => join(RUN_DIR(dir), 'dispatch_slice-p1-reviewer.md');
const builderSlicePath = (dir) => join(RUN_DIR(dir), 'dispatch_slice-p1-builder.md');
const p1ReviewMandatory = (store) => (store.getRun('r-loop').review_mandatory ?? []).filter((m) => m.phase_id === 'p1');

function assertPrepStagedNothing(dir, store) {
  assert.equal(existsSync(packPath(dir)), false, 'a breadth-refused phase writes NO knowledge_pack');
  assert.equal(existsSync(reviewerSlicePath(dir)), false, 'a breadth-refused phase writes NO reviewer dispatch slice');
  assert.equal(existsSync(builderSlicePath(dir)), false, 'a breadth-refused phase writes NO builder dispatch slice');
  assert.deepEqual(p1ReviewMandatory(store), [], 'a breadth-refused phase stamps NO review_mandatory for the phase');
}

test('AC2: prep REFUSES an over-wide phase — non-zero exit, names phase/count/threshold + split remedy, and stages NOTHING (no pack, no slices, no review_mandatory)', () => {
  // 5 interfaces on p1 > default threshold 3 → over-wide
  const fix = makeLoopProject({ phaseInterfaces: ['iface_a', 'iface_b', 'iface_c', 'iface_d', 'iface_e'] });
  const { dir, store } = fix;
  try {
    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', dir], dir);
    assert.notEqual(prep.code, 0, 'prep must exit non-zero on an over-wide phase (hard backstop)');
    const msg = prep.stderr + prep.stdout;
    assert.match(msg, /p1/, 'the refusal names the offending phase');
    assert.match(msg, /\b5\b/, 'the refusal names the interface count (5)');
    assert.match(msg, /\b3\b/, 'the refusal names the threshold in effect (default 3)');
    assert.match(msg, /split/i, 'the refusal names the split remedy');
    assertPrepStagedNothing(dir, store);
  } finally {
    fix.cleanup();
  }
});

test('AC2: prep breadth refusal is STRICTLY greater — a phase with interfaces exactly AT the threshold (3) stages normally; one over (4) is refused, staging nothing', () => {
  // exactly-at-threshold (3): NOT over-wide → stages exactly as today
  const at = makeLoopProject({ phaseInterfaces: ['iface_a', 'iface_b', 'iface_c'] });
  try {
    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', at.dir], at.dir);
    assert.equal(prep.code, 0, 'interfaces.length === threshold is within bounds — prep stages');
    assert.equal(existsSync(packPath(at.dir)), true, 'the within-threshold phase writes its knowledge_pack');
    assert.equal(existsSync(reviewerSlicePath(at.dir)), true, 'and its reviewer dispatch slice');
    assert.equal(existsSync(builderSlicePath(at.dir)), true, 'and its builder dispatch slice');
  } finally {
    at.cleanup();
  }
  // one over the threshold (4): refused, nothing staged
  const over = makeLoopProject({ phaseInterfaces: ['iface_a', 'iface_b', 'iface_c', 'iface_d'] });
  try {
    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', over.dir], over.dir);
    assert.notEqual(prep.code, 0, 'one interface over the threshold IS refused');
    assert.match(prep.stderr + prep.stdout, /\b4\b/, 'the refusal names the interface count (4)');
    assertPrepStagedNothing(over.dir, over.store);
  } finally {
    over.cleanup();
  }
});

test('AC2: the SAME config field governs — a custom difficulty.split_interface_threshold widens and tightens the prep breadth gate', () => {
  // 5 interfaces is within a custom threshold of 10 → prep stages
  const wide = makeLoopProject({ phaseInterfaces: ['a', 'b', 'c', 'd', 'e'], splitThreshold: 10 });
  try {
    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', wide.dir], wide.dir);
    assert.equal(prep.code, 0, '5 interfaces is within a custom threshold of 10 — prep reads difficulty.split_interface_threshold');
    assert.equal(existsSync(packPath(wide.dir)), true, 'the within-custom-threshold phase stages its pack');
  } finally {
    wide.cleanup();
  }
  // 3 interfaces exceeds a custom threshold of 2 → refused (proves the field, not a hardcoded 3)
  const tight = makeLoopProject({ phaseInterfaces: ['a', 'b', 'c'], splitThreshold: 2 });
  try {
    const prep = runScript('prep.mjs', ['--run', 'r-loop', '--phase', 'p1', '--target', tight.dir], tight.dir);
    assert.notEqual(prep.code, 0, '3 interfaces exceeds a custom threshold of 2 — refused');
    assert.match(prep.stderr + prep.stdout, /\b2\b/, 'the refusal reports the custom threshold in effect (2), not the default 3');
    assertPrepStagedNothing(tight.dir, tight.store);
  } finally {
    tight.cleanup();
  }
});
