// BRANCH-MANAGER + DIRECT-MERGE SURVIVOR COVERAGE — relocated from the
// deleted scripts/tests/pipeline.test.mjs (decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1: the staged pipeline and
// its run/handoff protocol were removed; branch-manager.mjs's general git
// utilities and scripts/direct-merge.mjs survive as conductor-direct
// infrastructure). Sol (outside-family review) flagged the whole-file
// deletion of pipeline.test.mjs as HIGH: it removed coverage for these
// SURVIVING subjects along with the genuinely-dead run-branch tests.
//
// SURVIVING SUBJECTS covered here: branch-manager.mjs's isGitRepo,
// currentBranch, defaultBranch, mergeBranchInto, sweepMergedBranches (the
// run-branch-specific exports — startRunBranch, phaseCommit,
// resetToLastPhaseCommit, mergeRun, discardRun, wholeRunDiffFiles — are
// deleted alongside the pipeline and are NOT retested here); and
// scripts/direct-merge.mjs's merge+sweep, reconcile_needed debt refusal
// (grouped by owning article), push-to-origin, and version-bump gate
// behavior. NOT restored: reviewer-selection.mjs and diff-json.mjs tests
// (both scripts deleted), phase-commit.mjs / merge-gate.mjs / test-check.mjs
// tests (all pipeline-only or deleted), and completeness-check.mjs /
// subtask-evidence tests (completeness-check.mjs deleted with this slice).
//
// Every fixture below is independent of retired pipeline state —
// the old pipeline.test.mjs's own makeGitProjectNoRun/runDirectMerge helpers
// already avoided the run concept for every one of these tests; they are
// reproduced here under this file's own name per this project's existing
// idiom (scripts/tests/direct-merge-*.test.mjs duplicate this same harness
// rather than import it — those files export nothing, test files are not
// designed as modules).
//
// direct-merge's preflight closes its project store before merging; its tests
// below therefore run against the same no-run fixture as the branch helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isGitRepo, currentBranch, defaultBranch, mergeBranchInto, sweepMergedBranches } from '../lib/branch-manager.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-06-10T12:00:00.000Z';

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

async function makeGitProject() {
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
  const Store = await loadStore();
  new Store(join(dir, '.sterling', 'sterling.db')).close(); // store present, no run — the surviving shape
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runDirectMerge(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

test('branch manager (§8.2): mergeBranchInto --no-ff + safe-delete; sweep clears merged, keeps unmerged; dirty refuses', async () => {
  const { dir, cleanup } = await makeGitProject();
  try {
    assert.equal(defaultBranch(dir), 'main', 'no origin → main');
    assert.equal(isGitRepo(dir), true);

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

test('direct-merge.mjs: merges the current branch and sweeps the merged sibling (no active-run gate — the staged pipeline is gone)', async () => {
  const { dir, cleanup } = await makeGitProject();
  try {
    git(dir, ['checkout', '-b', 'feat/x']);
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'x']);
    git(dir, ['branch', 'old/merged']); // fully merged → swept

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.merged_into, 'main');
    assert.equal(out.branch_merged, 'feat/x');
    assert.deepEqual(out.branches_swept, ['old/merged']);
    assert.equal(currentBranch(dir), 'main');
    assert.equal(git(dir, ['branch', '--list', 'feat/x']), '', 'merged branch deleted');
    assert.equal(git(dir, ['branch', '--list', 'old/merged']), '', 'merged sibling swept');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: refuses on open reconcile_needed debt covering changed files; unrelated debt does not block; merges once drained (decision 9df61181)', async () => {
  const { dir, cleanup } = await makeGitProject();
  try {
    git(dir, ['checkout', '-b', 'feat/debt']);
    writeFileSync(join(dir, 'src', 'touched.mjs'), 'export const t = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'touched']);

    const Store = await loadStore();
    const store = new Store(join(dir, '.sterling', 'sterling.db'));
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

    const store2 = new Store(join(dir, '.sterling', 'sterling.db'));
    store2.remove(item.id, NOW);
    store2.close();
    const ok = runDirectMerge(dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).branch_merged, 'feat/debt');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: reconcile refusal GROUPS items by owning article (feature_link) with counts — N articles, not N items (N13)', async () => {
  const { dir, cleanup } = await makeGitProject();
  try {
    git(dir, ['checkout', '-b', 'feat/many-touches']);
    for (const f of ['a.mjs', 'b.mjs', 'c.mjs']) {
      writeFileSync(join(dir, 'src', f), `export const v_${f.replace('.mjs', '')} = 1;\n`);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'touch three files owned by one article']);

    const articleId = randomUUID();
    const Store = await loadStore();
    const store = new Store(join(dir, '.sterling', 'sterling.db'));
    const items = ['a.mjs', 'b.mjs', 'c.mjs'].map((f) =>
      store.create({
        id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
        text: `reconcile article — ${f} touched in direct mode`, source: 'system', system_reason: 'reconcile_needed', file_keys: [`src/${f}`], feature_link: articleId,
      })
    );
    store.close();

    const refused = runDirectMerge(dir);
    assert.notEqual(refused.status, 0, 'open debt still refuses the merge');
    assert.match(refused.stderr, /3 open reconcile_needed item\(s\) across 1 article\(s\)/, 'the refusal reads as 1 article, not 3 items');
    assert.match(refused.stderr, new RegExp(`article ${articleId} `), 'the group is headed by its owning article id');
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

test('direct-merge.mjs: legacy items with NO feature_link collapse into ONE bucket — never counted as N separate articles (N13 roster review)', async () => {
  const { dir, cleanup } = await makeGitProject();
  try {
    git(dir, ['checkout', '-b', 'feat/legacy-touches']);
    const files = ['x.mjs', 'y.mjs', 'z.mjs'];
    for (const f of files) {
      writeFileSync(join(dir, 'src', f), `export const v_${f.replace('.mjs', '')} = 1;\n`);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'touch three files with no feature_link (older/foreign items)']);

    const Store = await loadStore();
    const store = new Store(join(dir, '.sterling', 'sterling.db'));
    for (const f of files) {
      store.create({
        id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'system', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
        text: `reconcile — ${f} touched (no feature_link on this legacy item)`, source: 'system', system_reason: 'reconcile_needed', file_keys: [`src/${f}`],
      });
    }
    store.close();

    const refused = runDirectMerge(dir);
    assert.notEqual(refused.status, 0, 'open debt still refuses the merge');
    assert.match(refused.stderr, /3 open reconcile_needed item\(s\) across 0 article\(s\)/, 'zero REAL articles — all three items are legacy/unlinked');
    assert.match(refused.stderr, /plus 3 item\(s\) with no owning article/, 'the legacy items are named as one group of 3, not 3 groups of 1');
    const headerMatches = refused.stderr.match(/\(no owning article\)/g) ?? [];
    assert.equal(headerMatches.length, 1, 'exactly one shared bucket header for every unlinked item — never one per item');
  } finally {
    cleanup();
  }
});

test('direct-merge.mjs: pushes the base to origin after the merge (--no-push opts out); a worktree-pinned merged branch is skipped, never a sweep failure', async () => {
  const { dir, cleanup } = await makeGitProject();
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

test('direct-merge.mjs: an unbumped version refuses when the diff goes beyond generated projections; diverged fields refuse; a bump (or --allow-same-version) merges (decision be9168e8)', async () => {
  const { dir, cleanup } = await makeGitProject();
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
