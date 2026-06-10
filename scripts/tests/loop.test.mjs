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

function makeLoopProject({ backupPath = true, reconcileGapArticle = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-loop-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const config = {
    toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }],
    prep_cap: 10,
  };
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
    technical_design: { approach: 'single module', interfaces: [], shared_structures: [] },
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
      { phase_id: 'p1', goal: 'implement add', subtasks: ['write add'], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet', rank_terms: ['calc'] },
    ],
    decisions_made: [],
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
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, decision, gapArticle, todo, brief, run, cleanup };
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
      { check: 'completeness-judgment', reason: 'not_built' },
      { check: 'reviewer-dispatch', reason: 'not_built' },
      { check: 'whole-run-diff', reason: 'no_base_branch' },
    ]);
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
      'completeness-judgment',
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
    assert.ok(gateSummary.summaries.check_skipped.length >= 8, 'the merge-gate summary lists every skip (§9.1)');

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
