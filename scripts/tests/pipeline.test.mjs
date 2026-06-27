import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  startRunBranch,
  phaseCommit,
  resetToLastPhaseCommit,
  mergeRun,
  discardRun,
  wholeRunDiffFiles,
  isGitRepo,
  currentBranch,
  defaultBranch,
  mergeBranchInto,
  sweepMergedBranches,
} from '../lib/branch-manager.mjs';
import { writeBaseline, compareBaseline, gitTestIntegrity } from '../lib/test-integrity.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-git-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const run = store.createRun({
    id: 'r-git',
    brief_ref: randomUUID(),
    branch: 'pending',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, run, cleanup };
}

test('branch manager: run branch in-place, per-phase commits recorded, reset, merge --no-ff (§8.1)', () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    const { branch, base } = startRunBranch({ cwd: dir, store, runId: 'r-git' });
    assert.equal(branch, 'sterling/run-r-git');
    assert.equal(base, 'main');
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), branch, 'checked out IN-PLACE — the observed tree is the run');
    assert.equal(store.getRun('r-git').base_branch, 'main');

    // phase work + commit recorded on the run record
    writeFileSync(join(dir, 'src', 'feature.mjs'), 'export const f = 2;\n');
    const sha = phaseCommit({ cwd: dir, store, runId: 'r-git', phaseId: 'p1' });
    assert.deepEqual(store.getRun('r-git').phases[0].commits, [sha]);
    assert.deepEqual(wholeRunDiffFiles({ cwd: dir, store, runId: 'r-git' }), ['src/feature.mjs']);

    // agent-died reset: uncommitted partial work discarded back to the phase commit (P7)
    writeFileSync(join(dir, 'src', 'partial.mjs'), 'broken');
    writeFileSync(join(dir, 'src', 'feature.mjs'), 'export const f = 999; // partial');
    resetToLastPhaseCommit({ cwd: dir });
    assert.equal(existsSync(join(dir, 'src', 'partial.mjs')), false);
    assert.match(readFileSync(join(dir, 'src', 'feature.mjs'), 'utf8'), /f = 2/);

    // merge gate approval: --no-ff into base, run branch deleted
    mergeRun({ cwd: dir, store, runId: 'r-git' });
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.ok(existsSync(join(dir, 'src', 'feature.mjs')), 'merged work present on main');
    const branches = git(dir, ['branch', '--list', 'sterling/*']);
    assert.equal(branches, '', 'run branch deleted after merge');
  } finally {
    cleanup();
  }
});

test('branch manager: dirty tree refuses run start; discard leaves main untouched (P7)', () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    writeFileSync(join(dir, 'src', 'dirty.mjs'), 'x');
    assert.throws(() => startRunBranch({ cwd: dir, store, runId: 'r-git' }), /dirty.*owns the whole tree/s);
    rmSync(join(dir, 'src', 'dirty.mjs'));

    startRunBranch({ cwd: dir, store, runId: 'r-git' });
    writeFileSync(join(dir, 'src', 'rejected.mjs'), 'export const r = 1;\n');
    phaseCommit({ cwd: dir, store, runId: 'r-git', phaseId: 'p1' });
    discardRun({ cwd: dir, store, runId: 'r-git' });
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(existsSync(join(dir, 'src', 'rejected.mjs')), false, 'rejection is cheap: branch deleted, main untouched');
  } finally {
    cleanup();
  }
});

// A git project with a store but NO active run — the conductor-direct state.
function makeGitProjectNoRun() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dm-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close(); // store present, no active run
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runDirectMerge(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

test('direct merge (§8.2): mergeBranchInto --no-ff + safe-delete; sweep clears merged, keeps unmerged; dirty refuses', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    assert.equal(defaultBranch(dir), 'main', 'no origin → main');

    git(dir, ['checkout', '-b', 'fix/one']);
    writeFileSync(join(dir, 'src', 'one.mjs'), 'export const one = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'one']);
    git(dir, ['branch', 'stale/merged']); // points at fix/one's tip — fully merged once fix/one lands
    // an UNMERGED branch (unique commit) the sweep must keep
    git(dir, ['checkout', '-b', 'fix/keep', 'main']);
    writeFileSync(join(dir, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'keep']);

    git(dir, ['checkout', 'fix/one']);
    const merged = mergeBranchInto({ cwd: dir, branch: 'fix/one', into: 'main' });
    assert.deepEqual(merged, { merged_into: 'main', branch_merged: 'fix/one' });
    assert.equal(currentBranch(dir), 'main', 'lands on base after merge');
    assert.ok(existsSync(join(dir, 'src', 'one.mjs')), 'merged work on main');
    assert.equal(git(dir, ['branch', '--list', 'fix/one']), '', 'merged branch deleted');

    const swept = sweepMergedBranches({ cwd: dir, into: 'main' });
    assert.deepEqual(swept, ['stale/merged'], 'only the fully-merged branch swept');
    assert.ok(git(dir, ['branch', '--list', 'fix/keep']).includes('fix/keep'), 'unmerged branch kept');

    // dirty tree refuses (P5: never stash silently)
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 2;\n');
    assert.throws(() => mergeBranchInto({ cwd: dir, branch: 'fix/keep', into: 'main' }), /dirty/);
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: refuses during an active run; merges + sweeps when none (§8.2 gate)', () => {
  // active run → refuse: a run merges through merge-gate.mjs (keeps the disposal gate)
  const withRun = makeGitProject();
  try {
    const r = runDirectMerge(withRun.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /run 'r-git' is active/);
  } finally {
    withRun.cleanup();
  }

  // no active run → merges the current branch and sweeps the merged sibling
  const clean = makeGitProjectNoRun();
  try {
    git(clean.dir, ['checkout', '-b', 'feat/x']);
    writeFileSync(join(clean.dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    git(clean.dir, ['add', '-A']);
    git(clean.dir, ['commit', '-m', 'x']);
    git(clean.dir, ['branch', 'old/merged']); // fully merged → swept

    const r = runDirectMerge(clean.dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.merged_into, 'main');
    assert.equal(out.branch_merged, 'feat/x');
    assert.deepEqual(out.branches_swept, ['old/merged']);
    assert.equal(currentBranch(clean.dir), 'main');
    assert.equal(git(clean.dir, ['branch', '--list', 'feat/x']), '', 'merged branch deleted');
    assert.equal(git(clean.dir, ['branch', '--list', 'old/merged']), '', 'merged sibling swept');
  } finally {
    clean.cleanup();
  }
});

test('test-integrity: frozen baseline detects modification and deletion; clean baseline passes (§9.2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ti-'));
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), 'test-a-v1');
    writeFileSync(join(dir, 'tests', 'b.test.mjs'), 'test-b-v1');
    const runDir = join(dir, '.sterling', 'runs', 'r-1');
    assert.equal(writeBaseline({ cwd: dir, runDir, phaseId: 'p1', testFiles: ['tests/a.test.mjs', 'tests/b.test.mjs'] }), 2);

    assert.deepEqual(compareBaseline({ cwd: dir, runDir, phaseId: 'p1' }), { baseline_missing: false, modified: [], deleted: [] });
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), 'test-a-WEAKENED');
    rmSync(join(dir, 'tests', 'b.test.mjs'));
    const r = compareBaseline({ cwd: dir, runDir, phaseId: 'p1' });
    assert.deepEqual(r.modified, ['tests/a.test.mjs']);
    assert.deepEqual(r.deleted, ['tests/b.test.mjs']);
    assert.equal(compareBaseline({ cwd: dir, runDir, phaseId: 'p9' }).baseline_missing, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test-integrity [direct]: vs git HEAD — modified/deleted test files flagged, additions fine, no-git degrades', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'x.test.mjs'), 'v1');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'tests']);

    writeFileSync(join(dir, 'tests', 'x.test.mjs'), 'v2-weakened');
    writeFileSync(join(dir, 'tests', 'new.test.mjs'), 'brand new');
    const ti = gitTestIntegrity({ cwd: dir, testGlobs: ['tests/**'] });
    assert.equal(ti.no_git, false);
    assert.deepEqual(ti.modified, ['tests/x.test.mjs']);
    assert.deepEqual(ti.deleted, []);
  } finally {
    cleanup();
  }
  const bare = mkdtempSync(join(tmpdir(), 'sterling-nogit-'));
  try {
    assert.equal(gitTestIntegrity({ cwd: bare, testGlobs: ['tests/**'] }).no_git, true);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('subtask-evidence (§17 structure-first): uncited subtask, missing citation target, failing cited test all block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-cite-'));
  let store;
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] }));
    store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const brief = store.create({
      id: randomUUID(), type: 'brief', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
      slug: 'f', title: 'F', problem: 'p', feature: 'f',
      user_stated: { criteria: [], constraints: [] }, conductor_proposals: [],
      acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
      blast_radius: { files: [{ path: 'src/a.mjs', owning_articles: [] }, { path: 'tests/a.test.mjs', owning_articles: [] }], reconcile_list: [] },
      incidental_scope: [], out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'g', subtasks: ['build a', 'wire a'], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });
    store.createRun({ id: 'r-c', brief_ref: brief.id, branch: 'b', machine_state: 'running', phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW });
    let handoffSeq = 0;
    const handoff = (evidence) =>
      store.writeHandoff(
        'r-c',
        { phase_id: 'p1', agent_role: 'coder', what_changed: [{ path: 'src/a.mjs', change_role: 'built' }], wired: [], deferred: [], decisions_made: [], tests_produced: ['tests/a.test.mjs'], subtask_evidence: evidence, exit_signal: 'complete', unresolved: [] },
        `2026-06-10T12:00:0${handoffSeq++}.000Z` // later handoffs supersede earlier citations
      );

    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;');
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(1, 1));");
    const comp = () => spawnSync(process.execPath, [join(root, 'scripts', 'completeness-check.mjs'), '--run', 'r-c', '--phase', 'p1', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 120_000 });

    // only one of two subtasks cited
    handoff([{ subtask: 'build a', files: ['src/a.mjs'], tests: ['tests/a.test.mjs'] }]);
    let r = comp();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no citation for subtask 'wire a'/);

    // both cited, but one citation points at a missing file
    handoff([
      { subtask: 'build a', files: ['src/a.mjs'], tests: ['tests/a.test.mjs'] },
      { subtask: 'wire a', files: ['src/ghost.mjs'], tests: [] },
    ]);
    r = comp();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /'wire a' cites 'src\/ghost.mjs' which does not exist/);

    // fully cited and existing, but the cited test fails
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(1, 2));");
    handoff([
      { subtask: 'build a', files: ['src/a.mjs'], tests: ['tests/a.test.mjs'] },
      { subtask: 'wire a', files: ['src/a.mjs'], tests: ['tests/a.test.mjs'] },
    ]);
    r = comp();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cited tests are assertion_fail/);

    // green citation passes
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(1, 1));");
    r = comp();
    assert.equal(r.status, 0, r.stderr);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('completeness blocks when a frozen test was weakened during the loop', () => {
  // minimal project: store + config + run + brief + handoff + tampered baseline
  const dir = mkdtempSync(join(tmpdir(), 'sterling-weaken-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] }));
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const brief = store.create({
      id: randomUUID(), type: 'brief', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
      slug: 'f', title: 'F', problem: 'p', feature: 'f',
      user_stated: { criteria: [], constraints: [] }, conductor_proposals: [],
      acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
      blast_radius: { files: [{ path: 'tests/y.test.mjs', owning_articles: [] }], reconcile_list: [] },
      incidental_scope: [], out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });
    store.createRun({ id: 'r-w', brief_ref: brief.id, branch: 'b', machine_state: 'running', phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW });
    store.writeHandoff('r-w', { phase_id: 'p1', agent_role: 'test-writer', what_changed: [{ path: 'tests/y.test.mjs', change_role: 'authored' }], wired: [], deferred: [], decisions_made: [], tests_produced: ['tests/y.test.mjs'], exit_signal: 'complete', unresolved: [] }, NOW);

    writeFileSync(join(dir, 'tests', 'y.test.mjs'), 'oracle-v1');
    writeBaseline({ cwd: dir, runDir: join(dir, '.sterling', 'runs', 'r-w'), phaseId: 'p1', testFiles: ['tests/y.test.mjs'] });
    writeFileSync(join(dir, 'tests', 'y.test.mjs'), 'oracle-WEAKENED');
    store.close();

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'completeness-check.mjs'), '--run', 'r-w', '--phase', 'p1', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /test-integrity.*MODIFIED/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('merge gate runs real branch operations in a git project', () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [] }));
    startRunBranch({ cwd: dir, store, runId: 'r-git' });
    writeFileSync(join(dir, 'src', 'feature.mjs'), 'export const f = 2;\n');
    phaseCommit({ cwd: dir, store, runId: 'r-git', phaseId: 'p1' });
    store.casTransition('running', { ...store.getRun('r-git'), machine_state: 'completing' });
    store.casTransition('completing', { ...store.getRun('r-git'), machine_state: 'awaiting_merge_gate' });

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'merge-gate.mjs'), '--run', 'r-git', '--decision', 'merge', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).branch, { merged_into: 'main' });
    assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(store.getRun('r-git').machine_state, 'merged');
  } finally {
    cleanup();
  }
});
