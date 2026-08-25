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

test('direct-merge.mjs: refuses on open reconcile_needed debt covering changed files; unrelated debt does not block; merges once drained (decision 9df61181)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    git(dir, ['checkout', '-b', 'feat/debt']);
    writeFileSync(join(dir, 'src', 'touched.mjs'), 'export const t = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'touched']);

    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const item = store.create({
      id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
      text: "reconcile article 'x' — files it owns were touched in direct mode", source: 'system', system_reason: 'reconcile_needed', file_keys: ['src/touched.mjs'],
    });
    store.create({
      id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
      text: "reconcile article 'y' — unrelated to this branch", source: 'system', system_reason: 'reconcile_needed', file_keys: ['src/unrelated.mjs'],
    });
    store.close();

    const refused = runDirectMerge(dir);
    assert.notEqual(refused.status, 0, 'open debt on a changed file must refuse the merge');
    assert.match(refused.stderr, /reconcile_needed/);
    assert.match(refused.stderr, /src\/touched\.mjs/);
    assert.doesNotMatch(refused.stderr, /src\/unrelated\.mjs/, 'debt off the branch does not block');

    const store2 = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    store2.remove(item.id, NOW);
    store2.close();
    const ok = runDirectMerge(dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).branch_merged, 'feat/debt');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: reconcile refusal GROUPS items by owning article (feature_link) with counts — N articles, not N items (N13)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    git(dir, ['checkout', '-b', 'feat/many-touches']);
    for (const f of ['a.mjs', 'b.mjs', 'c.mjs']) {
      writeFileSync(join(dir, 'src', f), `export const v_${f.replace('.mjs', '')} = 1;\n`);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'touch three files owned by one article']);

    const articleId = randomUUID();
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const items = ['a.mjs', 'b.mjs', 'c.mjs'].map((f) =>
      store.create({
        id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
        text: `reconcile article — ${f} touched in direct mode`, source: 'system', system_reason: 'reconcile_needed', file_keys: [`src/${f}`], feature_link: articleId,
      })
    );
    store.close();

    const refused = runDirectMerge(dir);
    assert.notEqual(refused.status, 0, 'open debt still refuses the merge');
    // EXPECTED FAILURE SHAPE (red before the fix): the unhardened refusal
    // prints one line PER ITEM with no grouping header at all — the
    // `/3 item\(s\) across 1 article\(s\)/` line and the single `article
    // <id>` header line below are the ones expected to fail red against it.
    assert.match(refused.stderr, /3 open reconcile_needed item\(s\) across 1 article\(s\)/, 'the refusal reads as 1 article, not 3 items');
    assert.match(refused.stderr, new RegExp(`article ${articleId} `), 'the group is headed by its owning article id');
    // Every item id stays available under the article's group — grouping
    // must never be lossy, only denser.
    for (const item of items) {
      assert.match(refused.stderr, new RegExp(item.id), `item ${item.id} is still individually listed under its article group`);
    }
    for (const f of ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']) {
      assert.match(refused.stderr, new RegExp(f.replace('.', '\\.')));
    }
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: legacy items with NO feature_link collapse into ONE bucket — never counted as N separate articles (N13 roster review)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    git(dir, ['checkout', '-b', 'feat/legacy-touches']);
    const files = ['x.mjs', 'y.mjs', 'z.mjs'];
    for (const f of files) {
      writeFileSync(join(dir, 'src', f), `export const v_${f.replace('.mjs', '')} = 1;\n`);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'touch three files with no feature_link (older/foreign items)']);

    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    for (const f of files) {
      store.create({
        id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
        text: `reconcile — ${f} touched (no feature_link on this legacy item)`, source: 'system', system_reason: 'reconcile_needed', file_keys: [`src/${f}`],
      });
    }
    store.close();

    const refused = runDirectMerge(dir);
    assert.notEqual(refused.status, 0, 'open debt still refuses the merge');
    // EXPECTED FAILURE SHAPE (red before the fix): keying the no-article
    // bucket per-item (e.g. by t.id) produces 3 separate buckets — the
    // headline would read "across 3 article(s)", over-counting the legacy
    // case exactly like the per-item shape N13 was meant to compress. The
    // `across 0 article\(s\)` assertion is the one expected to fail red
    // against that shape.
    assert.match(refused.stderr, /3 open reconcile_needed item\(s\) across 0 article\(s\)/, 'zero REAL articles — all three items are legacy/unlinked');
    assert.match(refused.stderr, /plus 3 item\(s\) with no owning article/, 'the legacy items are named as one group of 3, not 3 groups of 1');
    // Only ONE "(no owning article)" header line exists, not three.
    const headerMatches = refused.stderr.match(/\(no owning article\)/g) ?? [];
    assert.equal(headerMatches.length, 1, 'exactly one shared bucket header for every unlinked item — never one per item');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: pushes the base to origin after the merge (--no-push opts out); a worktree-pinned merged branch is skipped, never a sweep failure', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  const outside = mkdtempSync(join(tmpdir(), 'sterling-dm-push-'));
  try {
    // a local bare origin the push can land on — no network, no credentials
    const originDir = join(outside, 'origin.git');
    git(outside, ['init', '--bare', '-b', 'main', originDir]);
    git(dir, ['remote', 'add', 'origin', originDir]);
    git(dir, ['push', '-u', 'origin', 'main']);

    // a merged branch PINNED by a worktree (outside the repo — an inside path
    // would trip the dirty-tree refusal): git refuses to delete it, and the old
    // sweep failed the whole gate over that housekeeping
    git(dir, ['branch', 'pinned/merged']);
    git(dir, ['worktree', 'add', join(outside, 'wt'), 'pinned/merged']);

    git(dir, ['checkout', '-b', 'feat/push']);
    writeFileSync(join(dir, 'src', 'p.mjs'), 'export const p = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'p']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pushed, true, 'the merge is pushed to origin');
    assert.ok(!out.branches_swept.includes('pinned/merged'), 'worktree-pinned branch is not in the swept list');
    assert.ok(git(dir, ['branch', '--list', 'pinned/merged']).includes('pinned/merged'), 'pinned branch survives the sweep');
    assert.equal(git(originDir, ['rev-parse', 'main']), git(dir, ['rev-parse', 'main']), 'origin main equals local main');

    // --no-push: the merge lands locally, the push is skipped LOUD
    git(dir, ['checkout', '-b', 'feat/local']);
    writeFileSync(join(dir, 'src', 'l.mjs'), 'export const l = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'l']);
    const noPush = runDirectMerge(dir, ['--no-push']);
    assert.equal(noPush.status, 0, noPush.stderr);
    assert.equal(JSON.parse(noPush.stdout).pushed, false);
    assert.match(noPush.stderr, /push to origin SKIPPED/);
    assert.notEqual(git(originDir, ['rev-parse', 'main']), git(dir, ['rev-parse', 'main']), 'origin must NOT have the --no-push merge');
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('direct-merge.mjs: an unbumped version refuses when the diff goes beyond generated projections; diverged fields refuse; a bump (or --allow-same-version) merges (decision be9168e8)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    // a plugin-shaped repo: manifest + package.json at 0.1.0 on the base
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '0.1.0' }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.1.0' }));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'versioned base']);

    git(dir, ['checkout', '-b', 'feat/unbumped']);
    writeFileSync(join(dir, 'src', 'v.mjs'), 'export const v = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'substantive change, no bump']);

    const refused = runDirectMerge(dir);
    assert.notEqual(refused.status, 0, 'a substantive diff with an unmoved version must refuse');
    assert.match(refused.stderr, /version .* did not move|did not move/);

    // diverged fields refuse even after a bump attempt
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '0.1.1' }));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump plugin only']);
    const diverged = runDirectMerge(dir);
    assert.notEqual(diverged.status, 0);
    assert.match(diverged.stderr, /DIVERGED/);

    // both fields moved together → merges
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.1.1' }));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump package.json too']);
    const ok = runDirectMerge(dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).branch_merged, 'feat/unbumped');

    // --allow-same-version: the deliberate escape for a no-bump merge
    git(dir, ['checkout', '-b', 'feat/nobump']);
    writeFileSync(join(dir, 'src', 'w.mjs'), 'export const w = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'no bump, waived']);
    const waived = runDirectMerge(dir, ['--allow-same-version']);
    assert.equal(waived.status, 0, waived.stderr);
  } finally {
    cleanup();
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

    // Unresolvable-phase refusals (R2 board d0bdfe56 — mirror of prep/test-check,
    // P5): an off-brief --phase refuses loud, and with the phase no longer
    // in_progress an OMITTED --phase refuses instead of silently skipping the
    // subtask-evidence half against ALL handoffs.
    const offBrief = spawnSync(process.execPath, [join(root, 'scripts', 'completeness-check.mjs'), '--run', 'r-ac4', '--phase', 'p999', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
    assert.notEqual(offBrief.status, 0, 'an off-brief phase must refuse');
    assert.match(offBrief.stderr, /not in the run's brief/);
    const s2 = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    s2.updateRunOptimistic('r-ac4', (run) => ({ ...run, phases: run.phases.map((p) => ({ ...p, status: 'done' })) }));
    s2.close();
    const noPhase = spawnSync(process.execPath, [join(root, 'scripts', 'completeness-check.mjs'), '--run', 'r-ac4', '--target', dir], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
    assert.notEqual(noPhase.status, 0, 'no resolvable phase must refuse, not silently under-verify');
    assert.match(noPhase.stderr, /no resolvable phase/);
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

// A run that rebuilds the bundles (`npm run build:hooks`) after touching a bundle input
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
