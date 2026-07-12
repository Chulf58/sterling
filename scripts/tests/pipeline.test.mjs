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
import { buildDiffJson } from '../lib/diff-json.mjs';

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

function runPhaseCommit(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'phase-commit.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

test('phase-commit.mjs (§8.1): refuses off the run branch, commits on it recording the sha, refuses unknown phase', () => {
  const { dir, store, cleanup } = makeGitProject();
  try {
    // off the run branch (run.branch is 'pending', tree on main) → refused, nothing recorded
    const refused = runPhaseCommit(dir, ['--run', 'r-git', '--phase', 'p1']);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /REFUSED: on 'main' but run 'r-git' owns 'pending'/);
    assert.deepEqual(store.getRun('r-git').phases[0].commits, [], 'refusal records nothing');

    startRunBranch({ cwd: dir, store, runId: 'r-git' });
    writeFileSync(join(dir, 'src', 'feature.mjs'), 'export const f = 7;\n');
    const ok = runPhaseCommit(dir, ['--run', 'r-git', '--phase', 'p1']);
    assert.equal(ok.status, 0, ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.equal(out.phase_id, 'p1');
    assert.equal(out.committed, git(dir, ['rev-parse', 'HEAD']), 'the commit is HEAD on the run branch');
    assert.deepEqual(store.getRun('r-git').phases[0].commits, [out.committed], 'sha recorded on the run record');

    const badPhase = runPhaseCommit(dir, ['--run', 'r-git', '--phase', 'nope']);
    assert.equal(badPhase.status, 2);
    assert.match(badPhase.stderr, /no phase 'nope' on run 'r-git'/);
  } finally {
    cleanup();
  }
});

function runReviewerSelection(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'reviewer-selection.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

test("reviewer-selection.mjs (§7.1): the active run's brief risk_flags reach selection; no run means no brief, reported not silent", () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-revsel-'));
  let store;
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const diffPath = join(dir, 'diff.json');
    // a diff with NO security/perf path or content signal — only the brief flag can dispatch
    writeFileSync(diffPath, JSON.stringify([{ path: 'src/plain.mjs', added_lines: ['const x = 1;'] }]));

    // no active run (conductor-direct): selection runs brief-less and the output says so
    let r = runReviewerSelection(dir, ['--diff-json', diffPath]);
    assert.equal(r.status, 0, r.stderr);
    let out = JSON.parse(r.stdout);
    assert.equal(out.brief, null, 'no run → no brief, stated in the output');
    assert.ok(out.skipped.some((s) => s.reviewer === 'security'), 'signal-less diff without a brief skips security');

    const brief = store.create({
      id: randomUUID(), type: 'brief', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
      slug: 'f', title: 'F', problem: 'p', feature: 'f',
      user_stated: { criteria: [], constraints: [] }, conductor_proposals: [],
      acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
      risk_flags: ['security_relevant'],
      blast_radius: { files: [{ path: 'src/plain.mjs', owning_articles: [] }], reconcile_list: [] },
      incidental_scope: [], out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'g', subtasks: ['s'], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });
    store.createRun({ id: 'r-rs', brief_ref: brief.id, branch: 'b', machine_state: 'running', phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW });

    // active run with a security_relevant brief: the flag alone dispatches security (the r-65c3 gap)
    r = runReviewerSelection(dir, ['--diff-json', diffPath]);
    assert.equal(r.status, 0, r.stderr);
    out = JSON.parse(r.stdout);
    const sec = out.dispatch.find((d) => d.reviewer === 'security');
    assert.ok(sec, 'security dispatched from the brief flag on a signal-less diff');
    assert.match(sec.why, /brief risk flag security_relevant/);
    assert.deepEqual(out.brief, { run_id: 'r-rs', risk_flags: ['security_relevant'] });

    // an explicit unknown --run refuses loud, never a silent brief-less selection
    r = runReviewerSelection(dir, ['--diff-json', diffPath, '--run', 'r-ghost']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no run 'r-ghost'/);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('diff-json (board 09c237d6): buildDiffJson merges tracked (committed/staged/unstaged) with UNTRACKED files, as line CONTENT', () => {
  const { dir, cleanup } = makeGitProjectNoRun(); // main has src/base.mjs
  try {
    // unstaged edit to a tracked file
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\nconst c = spawn(cmd);\n');
    // a staged-new file (in the index + on disk, so `git diff main` sees it)
    writeFileSync(join(dir, 'src', 'staged.mjs'), 'export const s = 2;\n');
    git(dir, ['add', 'src/staged.mjs']);
    // an UNTRACKED new file — the r-1417 blind spot: `git diff main` never sees it
    writeFileSync(join(dir, 'src', 'untracked.mjs'), 'export const u = 3;\nconst more = 4;\n');

    const diff = buildDiffJson({ cwd: dir, base: 'main' });
    const byPath = Object.fromEntries(diff.map((f) => [f.path, f.added_lines]));

    assert.ok(byPath['src/base.mjs']?.includes('const c = spawn(cmd);'), 'unstaged edit present as content');
    assert.ok(byPath['src/staged.mjs']?.includes('export const s = 2;'), 'staged-new file present');
    assert.ok(byPath['src/untracked.mjs'], 'UNTRACKED file present — the blind spot is closed');
    assert.deepEqual(byPath['src/untracked.mjs'], ['export const u = 3;', 'const more = 4;'], 'untracked lines are CONTENT, every line added');
  } finally {
    cleanup();
  }
});

test('reviewer-selection --base: an untracked-only change reaches the skeptic (r-1417 under-count regression)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    // 401 plain lines, untracked — no security/perf/export signals, only size
    const big = Array.from({ length: 401 }, (_, i) => `const x${i} = ${i};`).join('\n');
    writeFileSync(join(dir, 'src', 'big.mjs'), big + '\n');

    const r = runReviewerSelection(dir, ['--base', 'main']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const skeptic = out.dispatch.find((d) => d.reviewer === 'skeptic');
    assert.ok(skeptic, 'skeptic dispatched — untracked lines were counted (0 without the fix → skipped)');
    assert.match(skeptic.why, /401 added lines/);
  } finally {
    cleanup();
  }
});

test('reviewer-selection --base: an added line with a security signal dispatches security (content-not-line-numbers regression)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    // small untracked file whose CONTENT carries a security signal (spawn()
    // matches rs.security_content_patterns) — a line-numbers diff would miss it
    writeFileSync(join(dir, 'src', 'svc.mjs'), 'export function run(cmd) {\n  return spawn(cmd, [], { shell: true });\n}\n');

    const r = runReviewerSelection(dir, ['--base', 'main']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const sec = out.dispatch.find((d) => d.reviewer === 'security');
    assert.ok(sec, 'security dispatched from the added content signal');
    assert.match(sec.why, /content signal in 'src\/svc\.mjs'/);
    assert.ok(!out.dispatch.some((d) => d.reviewer === 'skeptic'), 'a tiny diff stays under the skeptic threshold');
  } finally {
    cleanup();
  }
});

test('diff-json: an added line whose content starts with "++ " is collected as content, not mis-read as a +++ header', () => {
  const { dir, cleanup } = makeGitProjectNoRun(); // src/base.mjs is committed on main
  try {
    // git emits this added line as `+++ plus-plus content` — it must NOT be taken
    // for a file header (it is inside a hunk, not preceded by its `--- ` pair)
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n++ plus-plus content\n');
    const diff = buildDiffJson({ cwd: dir, base: 'main' });
    const byPath = Object.fromEntries(diff.map((f) => [f.path, f.added_lines]));
    assert.ok(byPath['src/base.mjs']?.includes('++ plus-plus content'), 'the ++-prefixed line is kept as content of its file');
    assert.ok(!('plus-plus content' in byPath), 'no spurious file key from the mis-parsed header');
  } finally {
    cleanup();
  }
});

test('reviewer-selection --base: an option-looking base (--output=) cannot inject a git option — refuses loud, writes no file', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const probe = join(dir, 'injected.txt');
    const r = runReviewerSelection(dir, ['--base', `--output=${probe}`]);
    assert.notEqual(r.status, 0, 'a malformed/option-looking base fails loud, never a silent or arbitrary-write success');
    assert.ok(!existsSync(probe), 'git did not write the injected --output path (--end-of-options neutralized it)');
  } finally {
    cleanup();
  }
});

test('reviewer-selection: exactly one diff input required (neither / both --base and --diff-json refuse loud)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const neither = runReviewerSelection(dir, []);
    assert.equal(neither.status, 2);
    assert.match(neither.stderr, /exactly one diff input/);

    writeFileSync(join(dir, 'd.json'), '[]');
    const both = runReviewerSelection(dir, ['--base', 'main', '--diff-json', join(dir, 'd.json')]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /exactly one diff input/);
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
});

test('test-integrity [direct]: a git RENAME of a test file is caught, not slipped (audit finding 21/43)', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    // a test with enough content that a rename+edit stays above git's rename threshold
    writeFileSync(join(dir, 'tests', 'orig.test.mjs'), 'export const cases = [1,2,3,4,5,6,7,8,9,10];\n// assertions below\n'.repeat(3));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'tests']);

    // rename WITH a weakening edit — git reports `R<score>\told\tnew`
    git(dir, ['mv', 'tests/orig.test.mjs', 'tests/renamed.test.mjs']);
    writeFileSync(join(dir, 'tests', 'renamed.test.mjs'), 'export const cases = [1,2,3,4,5,6,7,8,9,10];\n// assertions below\n'.repeat(3) + '// WEAKENED\n');
    git(dir, ['add', '-A']);
    const ti = gitTestIntegrity({ cwd: dir, testGlobs: ['tests/**'] });
    assert.equal(ti.no_git, false);
    assert.deepEqual(ti.modified, ['tests/renamed.test.mjs'], 'the renamed test surfaces as modified (was silently skipped before)');
    assert.deepEqual(ti.deleted, [], 'the old path is not double-counted as a deletion when the new path is a test');
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

// ------------------- mid-run scope amendment (run r-1417) -------------------

// AC4 — completeness-check treats a run.scope_amendments path as in-contract at its PER-HANDOFF
// citation site (:26 union). A subtask citation to an out-of-brief-but-amended file passes; without
// the amendment reaching the run (feature not yet shipped) the out-of-contract citation blocks (red).
test('completeness-check: a subtask citation to a run.scope_amendments path passes (AC4, :26 citation union site)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-amend-cite-'));
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
      // src/amended.mjs is deliberately OUTSIDE blast_radius/incidental/out_of_scope
      blast_radius: { files: [{ path: 'tests/a.test.mjs', owning_articles: [] }], reconcile_list: [] },
      incidental_scope: [], out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'g', subtasks: ['build amended'], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });
    store.createRun({
      id: 'r-ac4', brief_ref: brief.id, branch: 'b', machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW,
      scope_amendments: [{ path: 'src/amended.mjs', reason: 'adjudicated mid-run', at: NOW }],
    });

    writeFileSync(join(dir, 'src', 'amended.mjs'), 'export const a = 1;');
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(1, 1));");
    store.writeHandoff('r-ac4', { phase_id: 'p1', agent_role: 'coder', what_changed: [{ path: 'src/amended.mjs', change_role: 'built' }], wired: [], deferred: [], decisions_made: [], tests_produced: ['tests/a.test.mjs'], subtask_evidence: [{ subtask: 'build amended', files: ['src/amended.mjs'], tests: ['tests/a.test.mjs'] }], exit_signal: 'complete', unresolved: [] }, NOW);
    store.close();
    store = undefined;

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'completeness-check.mjs'), '--run', 'r-ac4', '--phase', 'p1', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 120_000 });
    assert.equal(r.status, 0, `a citation to an amended (in-contract) path must pass — ${r.stderr}`);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// :108 — completeness-check --final unions the run's amendments into the WHOLE-RUN diff scope
// check. An amended file that is changed across the run is in-contract; without the amendment the
// whole-run diff carries an out-of-contract file and --final blocks (red).
test('completeness-check --final: an amended file in the whole-run diff is in-contract (:108 whole-run union site)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-amend-final-'));
  let store;
  try {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@sterling.local']);
    git(dir, ['config', 'user.name', 'Sterling Test']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
    writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] }));
    store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const brief = store.create({
      id: randomUUID(), type: 'brief', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
      slug: 'f', title: 'F', problem: 'p', feature: 'f',
      user_stated: { criteria: [], constraints: [] }, conductor_proposals: [],
      acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
      // src/extra.mjs is OUTSIDE the brief; only the amendment can make the whole-run diff clean
      blast_radius: { files: [{ path: 'tests/a.test.mjs', owning_articles: [] }], reconcile_list: [] },
      incidental_scope: [], out_of_scope: [],
      phases: [{ phase_id: 'p1', goal: 'g', subtasks: ['build extra'], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
      decisions_made: [],
    });
    store.createRun({
      id: 'r-final', brief_ref: brief.id, branch: 'pending', machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW,
      scope_amendments: [{ path: 'src/extra.mjs', reason: 'adjudicated mid-run', at: NOW }],
    });

    startRunBranch({ cwd: dir, store, runId: 'r-final' });
    writeFileSync(join(dir, 'src', 'extra.mjs'), 'export const e = 1;\n'); // out-of-brief, AMENDED
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(1, 1));\n");
    phaseCommit({ cwd: dir, store, runId: 'r-final', phaseId: 'p1' });

    store.writeHandoff('r-final', { phase_id: 'p1', agent_role: 'coder', what_changed: [{ path: 'src/extra.mjs', change_role: 'built' }], wired: [], deferred: [], decisions_made: [], tests_produced: ['tests/a.test.mjs'], subtask_evidence: [{ subtask: 'build extra', files: ['src/extra.mjs'], tests: ['tests/a.test.mjs'] }], exit_signal: 'complete', unresolved: [] }, NOW);
    store.close();
    store = undefined;

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'completeness-check.mjs'), '--run', 'r-final', '--phase', 'p1', '--final', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 120_000 });
    assert.equal(r.status, 0, `--final must treat an amended whole-run-diff file as in-contract — ${r.stderr}`);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ------- generated hook bundles in the whole-run diff (decision 66c15d77 corollary retired) -------

// The enforcement suite runs build-hooks.mjs in-repo, so any run touching a bundle input
// (scripts/hooks/**, packages/schemas/**, packages/store/**) sweeps regenerated hooks/h*.mjs
// bundles into its whole-run diff. --final derives a diff'd bundle as in-contract from its
// CAUSE — another diff file under the input roots that is itself in the allowed set — so
// briefs list real sources, not every bundle (r-1417's interim rule). Sources live at BASE
// so only deliberate writes appear in the diff; a generating source must EXIST to derive.
function makeBundleFixture({ blastPaths }) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-bundlederive-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'scripts', 'hooks', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'hooks', 'h1-alpha.mjs'), '// hook source\n');
  writeFileSync(join(dir, 'scripts', 'hooks', 'h5-beta.mjs'), '// hook source\n');
  writeFileSync(join(dir, 'scripts', 'hooks', 'lib', 'contract.mjs'), '// shared lib\n');
  writeFileSync(join(dir, 'hooks', 'h1-alpha.mjs'), '// bundle v1\n');
  writeFileSync(join(dir, 'hooks', 'h5-beta.mjs'), '// bundle v1\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const brief = store.create({
    id: randomUUID(), type: 'brief', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug: 'f', title: 'F', problem: 'p', feature: 'f',
    user_stated: { criteria: [], constraints: [] }, conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
    blast_radius: { files: blastPaths.map((path) => ({ path, owning_articles: [] })), reconcile_list: [] },
    incidental_scope: [], out_of_scope: [],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: ['change input'], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  });
  store.createRun({
    id: 'r-bundle', brief_ref: brief.id, branch: 'pending', machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }], dispatch_counts: {}, escalations: [], started_at: NOW,
  });
  startRunBranch({ cwd: dir, store, runId: 'r-bundle' });
  return { dir, store };
}

function finalCheckBundleRun(dir, store, changedPath) {
  writeFileSync(join(dir, 'tests', 'a.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(1, 1));\n");
  phaseCommit({ cwd: dir, store, runId: 'r-bundle', phaseId: 'p1' });
  store.writeHandoff('r-bundle', { phase_id: 'p1', agent_role: 'coder', what_changed: [{ path: changedPath, change_role: 'changed' }], wired: [], deferred: [], decisions_made: [], tests_produced: ['tests/a.test.mjs'], subtask_evidence: [{ subtask: 'change input', files: [changedPath], tests: ['tests/a.test.mjs'] }], exit_signal: 'complete', unresolved: [] }, NOW);
  store.close();
  return spawnSync(process.execPath, [join(root, 'scripts', 'completeness-check.mjs'), '--run', 'r-bundle', '--phase', 'p1', '--final', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 120_000 });
}

test('completeness-check --final: regenerated bundles derive in-contract from an in-contract bundle-input cause', () => {
  const { dir, store } = makeBundleFixture({ blastPaths: ['scripts/hooks/lib/contract.mjs', 'tests/a.test.mjs'] });
  try {
    writeFileSync(join(dir, 'scripts', 'hooks', 'lib', 'contract.mjs'), '// shared lib v2\n');
    writeFileSync(join(dir, 'hooks', 'h1-alpha.mjs'), '// bundle v2\n');
    writeFileSync(join(dir, 'hooks', 'h5-beta.mjs'), '// bundle v2\n');
    const r = finalCheckBundleRun(dir, store, 'scripts/hooks/lib/contract.mjs');
    assert.equal(r.status, 0, `bundles regenerated from an in-contract input must pass --final without being brief-listed — ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('completeness-check --final: a bundle change with NO in-contract cause is still refused (no blanket allow)', () => {
  const { dir, store } = makeBundleFixture({ blastPaths: ['tests/a.test.mjs'] });
  try {
    writeFileSync(join(dir, 'hooks', 'h1-alpha.mjs'), '// bundle v2\n');
    const r = finalCheckBundleRun(dir, store, 'tests/a.test.mjs');
    assert.notEqual(r.status, 0, 'a bundle change with no in-contract bundle-input cause must refuse');
    assert.match(r.stderr, /whole-run diff outside contract: 'hooks\/h1-alpha\.mjs'/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('completeness-check --final: a hooks/*.mjs file with no generating source never derives, even with a cause', () => {
  const { dir, store } = makeBundleFixture({ blastPaths: ['scripts/hooks/lib/contract.mjs', 'tests/a.test.mjs'] });
  try {
    writeFileSync(join(dir, 'scripts', 'hooks', 'lib', 'contract.mjs'), '// shared lib v2\n');
    writeFileSync(join(dir, 'hooks', 'h1-alpha.mjs'), '// bundle v2\n'); // real bundle — derives
    writeFileSync(join(dir, 'hooks', 'h9-rogue.mjs'), '// no source\n'); // stray — must refuse
    const r = finalCheckBundleRun(dir, store, 'scripts/hooks/lib/contract.mjs');
    assert.notEqual(r.status, 0, 'a sourceless hooks/*.mjs must refuse even when a rebuild cause is present');
    assert.match(r.stderr, /whole-run diff outside contract: 'hooks\/h9-rogue\.mjs'/);
    assert.doesNotMatch(r.stderr, /h1-alpha/, 'the real bundle must still derive in the same run');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
