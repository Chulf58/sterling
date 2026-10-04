// SLOW AND FAILED TREE-WRITING GIT STEPS in /sterling:merge (board 7e4850cf,
// Dome Farmer report 2026-10-03): `git merge` ran past branch-manager's 60 s
// spawn timeout on a large repo on a Windows drive, was killed while it wrote
// the working tree, and left the base branch checked out at its old commit with
// thousands of half-written paths and no word about the repo state.
//
// Pins:
//  1. a checkout or merge that takes longer than the old timeout is not killed;
//  2. a failed checkout or merge prints the branch, HEAD, whether MERGE_HEAD
//     exists, the changed-path count and the recovery command, and that
//     command restores a clean tree on the feature branch.
//
// The slow git is a preload that replaces child_process.spawnSync inside the
// direct-merge process: a real 65 s sleep per test is not affordable, so the
// stub answers a named git step the way spawnSync does when its timeout fires
// (status null, SIGTERM, error.code ETIMEDOUT) whenever the caller passed a
// timeout shorter than the step's simulated runtime, and runs real git
// otherwise. Same harness idiom as the other direct-merge-*.test.mjs files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mergeBranchInto } from '../lib/branch-manager.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
async function loadStore() {
  if (!SterlingStore) {
    ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  }
  return SterlingStore;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

// SLOW_GIT_STEPS: git subcommands that "take 65 s" — killed only if the caller
// set a shorter timeout. LOUD_GIT_STEPS: git subcommands that "print more than
// any finite buffer" — killed with ENOBUFS, as spawnSync does, unless the caller
// lifted maxBuffer to Infinity. PROMPTLESS_GIT_STEPS: git subcommands that
// would wait on a terminal prompt unless GIT_TERMINAL_PROMPT=0 is in the child
// environment. KILLED_GIT_STRAY: the killed step also leaves a path that is in
// neither HEAD nor the feature branch. KILLED_GIT_STEP: a git subcommand that dies part-way
// regardless (the state a killed merge leaves: some files of the incoming
// branch written, the index and HEAD untouched).
const PRELOAD = `
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const real = cp.spawnSync;
const SIMULATED_RUNTIME_MS = 65_000;
const slow = (process.env.SLOW_GIT_STEPS ?? '').split(',').filter(Boolean);
const loud = (process.env.LOUD_GIT_STEPS ?? '').split(',').filter(Boolean);
const promptless = (process.env.PROMPTLESS_GIT_STEPS ?? '').split(',').filter(Boolean);
const killed = process.env.KILLED_GIT_STEP ?? '';
const dead = (code) => ({
  pid: 0, status: null, signal: 'SIGTERM', stdout: '', stderr: '', output: [null, '', ''],
  ...(code ? { error: Object.assign(new Error('spawnSync git ' + code), { code }) } : {}),
});
cp.spawnSync = function (cmd, args, opts) {
  const step = cmd === 'git' && Array.isArray(args) ? args[0] : null;
  if (step && slow.includes(step) && opts?.timeout && opts.timeout < SIMULATED_RUNTIME_MS) return dead('ETIMEDOUT');
  if (step && loud.includes(step) && opts?.maxBuffer !== Infinity) return dead('ENOBUFS');
  if (step && promptless.includes(step) && opts?.env?.GIT_TERMINAL_PROMPT !== '0') return dead('WOULD_PROMPT');
  if (step && step === killed) {
    if (process.env.KILLED_GIT_STRAY) {
      fs.mkdirSync(path.join(opts.cwd, 'stray'), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, 'stray', 'z.mjs'), 'export const z = 1;\\n');
    }
    fs.writeFileSync(path.join(opts.cwd, 'src', 'x.mjs'), 'export const x = 1;\\n');
    fs.writeFileSync(path.join(opts.cwd, 'src', 'base.mjs'), 'export const base = 2;\\n');
    return dead(null);
  }
  return real.apply(this, arguments);
};
syncBuiltinESMExports();
`;

async function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dm-slow-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const Store = await loadStore();
  new Store(join(dir, '.sterling', 'sterling.db')).close();
  const preload = join(dir, '.sterling', 'slow-git-preload.cjs');
  writeFileSync(preload, PRELOAD);
  return { dir, preload, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// feat/x adds src/x.mjs and changes src/base.mjs, so a part-written merge shows
// both an untracked and a modified path on the base.
function commitFeature(dir) {
  git(dir, ['checkout', '-b', 'feat/x']);
  writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 2;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'x']);
}

function runDirectMerge(dir, preload, env) {
  return spawnSync(process.execPath, ['--require', preload, join(root, 'scripts', 'direct-merge.mjs'), '--target', dir], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

test('direct-merge.mjs: a checkout and a merge that each run longer than the 60 s git timeout are not killed, and the merge lands', async () => {
  const { dir, preload, cleanup } = await makeGitProject();
  try {
    commitFeature(dir);
    const r = runDirectMerge(dir, preload, { SLOW_GIT_STEPS: 'checkout,merge' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ETIMEDOUT/);
    const out = JSON.parse(r.stdout);
    assert.equal(out.merged_into, 'main');
    assert.equal(out.branch_merged, 'feat/x');
    assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal(git(dir, ['log', '-1', '--format=%s']), 'Merge feat/x into main');
    assert.equal(git(dir, ['status', '--porcelain']), '', 'the merged tree is clean');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: a checkout and a merge whose output passes any finite spawn buffer are not killed, and the merge lands', async () => {
  const { dir, preload, cleanup } = await makeGitProject();
  try {
    commitFeature(dir);
    const r = runDirectMerge(dir, preload, { LOUD_GIT_STEPS: 'checkout,merge' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ENOBUFS/);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/x');
    assert.equal(git(dir, ['log', '-1', '--format=%s']), 'Merge feat/x into main');
    assert.equal(git(dir, ['status', '--porcelain']), '');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: the untimed checkout and merge run with GIT_TERMINAL_PROMPT=0 and each is announced on stderr first', async () => {
  const { dir, preload, cleanup } = await makeGitProject();
  try {
    commitFeature(dir);
    const r = runDirectMerge(dir, preload, { PROMPTLESS_GIT_STEPS: 'checkout,merge' });
    assert.equal(r.status, 0, r.stderr);
    const checkoutAt = r.stderr.search(/^branch-manager: running `git checkout` with no time limit.*minutes on a slow drive.*do not interrupt/m);
    const mergeAt = r.stderr.search(/^branch-manager: running `git merge` with no time limit.*minutes on a slow drive.*do not interrupt/m);
    assert.ok(checkoutAt !== -1 && mergeAt > checkoutAt, r.stderr);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/x', 'stdout is still one JSON report');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: a killed merge that left a path in neither HEAD nor the branch prints the git clean step, and the printed commands end with a clean tree', async () => {
  const { dir, preload, cleanup } = await makeGitProject();
  try {
    commitFeature(dir);
    const r = runDirectMerge(dir, preload, { KILLED_GIT_STEP: 'merge', KILLED_GIT_STRAY: '1' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /changed paths:\s+3\b/);
    assert.match(r.stderr, /partly written by the failed `git merge`/);
    const checkoutAt = r.stderr.search(/^ {2}git checkout -f feat\/x$/m);
    const listAt = r.stderr.search(/^ {2}git clean -nd$/m);
    const cleanAt = r.stderr.search(/^ {2}git clean -fd$/m);
    assert.ok(checkoutAt !== -1 && listAt > checkoutAt && cleanAt > listAt, r.stderr);
    assert.doesNotMatch(r.stderr, /git clean -\w*x/, 'ignored files are never offered for deletion');

    // Following the printed commands in order.
    git(dir, ['checkout', '-f', 'feat/x']);
    assert.equal(git(dir, ['status', '--porcelain']), '?? stray/', 'the forced checkout alone leaves the stray path');
    assert.match(git(dir, ['clean', '-nd']), /stray\//);
    git(dir, ['clean', '-fd']);
    assert.equal(git(dir, ['status', '--porcelain']), '');
    assert.ok(existsSync(join(dir, '.sterling', 'sterling.db')), 'the ignored store survives git clean -fd');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: a merge step killed part-way reports branch, HEAD, MERGE_HEAD, the changed-path count and a recovery command that restores a clean tree', async () => {
  const { dir, preload, cleanup } = await makeGitProject();
  try {
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    commitFeature(dir);
    const r = runDirectMerge(dir, preload, { KILLED_GIT_STEP: 'merge' });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, '', 'no merged report on a failed merge');
    assert.match(r.stderr, /direct-merge: git merge --no-ff feat\/x .* failed \(killed by SIGTERM\)/);
    assert.match(r.stderr, /branch:\s+main\b/);
    assert.ok(r.stderr.includes(`HEAD:       ${baseSha}`), r.stderr);
    assert.match(r.stderr, /MERGE_HEAD:\s+absent/);
    assert.match(r.stderr, /changed paths:\s+2\b/);
    assert.match(r.stderr, /Do NOT `git add` or commit/);
    assert.match(r.stderr, /^ {2}git checkout -f feat\/x$/m);
    assert.doesNotMatch(r.stderr, /git merge --abort/, 'no merge is in progress, so abort is not offered');

    // The gate discards nothing itself: the part-written tree is still there.
    assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'main');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), baseSha);
    assert.equal(git(dir, ['status', '--porcelain']).split('\n').length, 2);

    // The printed recovery command returns to the pre-run state.
    git(dir, ['checkout', '-f', 'feat/x']);
    assert.equal(git(dir, ['status', '--porcelain']), '');
    assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'feat/x');
    assert.equal(readFileSync(join(dir, 'src', 'base.mjs'), 'utf8'), 'export const base = 2;\n');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: a merge that stops on a conflict reports MERGE_HEAD present and offers git merge --abort before the checkout', async () => {
  const { dir, preload, cleanup } = await makeGitProject();
  try {
    commitFeature(dir);
    git(dir, ['checkout', 'main']);
    writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 3;\n');
    git(dir, ['commit', '-am', 'main moves']);
    const mainSha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', 'feat/x']);

    const r = runDirectMerge(dir, preload, {});
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /direct-merge: git merge --no-ff feat\/x .* failed \(exit 1\)/);
    assert.match(r.stderr, /branch:\s+main\b/);
    assert.ok(r.stderr.includes(`HEAD:       ${mainSha}`), r.stderr);
    assert.match(r.stderr, /MERGE_HEAD:\s+present/);
    assert.match(r.stderr, /changed paths:\s+2\b/);
    assert.match(r.stderr, /Do NOT `git add` or commit/);
    assert.match(r.stderr, /stopped on conflicts/);
    assert.match(r.stderr, /resolve the conflicts on feat\/x/);
    assert.doesNotMatch(r.stderr, /partly written/, 'a conflict stop is not a partly written tree');
    const abortAt = r.stderr.search(/^ {2}git merge --abort$/m);
    const checkoutAt = r.stderr.search(/^ {2}git checkout -f feat\/x$/m);
    assert.ok(abortAt !== -1 && checkoutAt > abortAt, r.stderr);

    assert.ok(existsSync(join(dir, '.git', 'MERGE_HEAD')), 'the gate leaves the conflicted merge for the user');
    git(dir, ['merge', '--abort']);
    git(dir, ['checkout', '-f', 'feat/x']);
    assert.equal(git(dir, ['status', '--porcelain']), '');
  } finally {
    cleanup();
  }
});

test('mergeBranchInto: a failed checkout of the base that changed nothing says the tree is clean and names no forced command', async () => {
  const { dir, cleanup } = await makeGitProject();
  try {
    commitFeature(dir);
    const featSha = git(dir, ['rev-parse', 'HEAD']);
    // A base that does not exist: `git checkout` exits non-zero and writes nothing.
    let message = '';
    try {
      mergeBranchInto({ cwd: dir, branch: 'feat/x', into: 'no-such-base' });
    } catch (e) {
      message = e.message;
    }
    assert.match(message, /^git checkout no-such-base failed \(exit 1\)/);
    assert.match(message, /branch:\s+feat\/x\b/);
    assert.ok(message.includes(`HEAD:       ${featSha}`), message);
    assert.match(message, /MERGE_HEAD:\s+absent/);
    assert.match(message, /changed paths:\s+0\b/);
    assert.match(message, /working tree is clean and still on feat\/x/);
    assert.doesNotMatch(message, /checkout -f|Do NOT/);
    assert.equal(git(dir, ['symbolic-ref', '--short', 'HEAD']), 'feat/x');
    assert.equal(git(dir, ['status', '--porcelain']), '');
  } finally {
    cleanup();
  }
});
