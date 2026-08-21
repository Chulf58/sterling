// REVIEW-RECEIPT MERGE GATE (board d3752b2e-25f3-4bda-b127-bb3b56bc0430)
//
// Spec under test (not yet implemented in scripts/direct-merge.mjs):
//   1. CODE-TOUCHING: a commit whose diff includes >=1 path matching the registered
//      toolchain globs **/*.ts or **/*.mjs. Commits touching only other files (docs/*.md,
//      rulings.md, etc.) are exempt.
//   2. RECEIPT: a git commit trailer `Reviewed-By-Agent: <free text>` with a NON-EMPTY
//      value — a receipt naming nobody is not a receipt (conductor-adjudicated 2026-08-20,
//      superseding this spec's original key-presence prose; pinned in
//      merge-review-receipts-hardening.test.mjs EMPTY-VALUE-TRAILER-REFUSED).
//   3. REFUSE: a branch with >=1 code-touching commit missing the trailer refuses the
//      merge (non-zero exit, no merge performed), naming each offending commit
//      (short sha + subject) and both remedies (amend/record the trailer, or
//      --waive-reviews "<reason>").
//   4. PASS: all code-touching branch commits carry the trailer -> the receipt gate does
//      not refuse.
//   5. MIXED: refusal names ONLY the untrailered commit(s).
//   6. EXEMPT: a docs-only commit without the trailer never blocks.
//   7. WAIVE: --waive-reviews "<reason>" proceeds AND loudly lists each waived commit
//      (short sha) with the reason.
//   8. REGRESSION PIN: the pre-existing dirty-working-tree refusal still fires
//      regardless of trailers.
//
// These tests are written BLIND to scripts/direct-merge.mjs's internals (H4 read wall) —
// only its CLI surface (--target, exit conventions, JSON stdout on success, stderr on
// refusal) is used, learned from scripts/tests/pipeline.test.mjs's existing
// runDirectMerge() calls.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

// A git project with a store but NO active run (the conductor-direct state that
// scripts/tests/pipeline.test.mjs's makeGitProjectNoRun() also exercises), plus a
// .sterling/config.json declaring this repo's registered toolchain globs — the
// **/*.mjs / **/*.ts pair the CODE-TOUCHING definition (spec item 1) keys on.
function makeReceiptGateRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-receipt-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({
      toolchains: [
        { adapter: 'node', path_globs: ['**/*.mjs', '**/*.ts'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } },
      ],
    })
  );
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close(); // store present, no active run
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Writes `content` at `relPath`, stages, and commits. When `trailer` is given it is
// passed as a SEPARATE `-m` paragraph, which is how a real Reviewed-By-Agent trailer
// reaches a commit message (subject, blank line, trailer line). We then verify with
// `git log --format=%(trailers:...)` that git's own trailer parser recognizes it — a
// guard against a fixture bug (e.g. missing blank-line separation) manufacturing a
// false red for the wrong reason.
function writeAndCommit(dir, { path: relPath, content, subject, trailer }) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
  const args = trailer ? ['commit', '-m', subject, '-m', trailer] : ['commit', '-m', subject];
  git(dir, args);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const short = git(dir, ['rev-parse', '--short', sha]);
  if (trailer) {
    const parsedValue = git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]);
    assert.notEqual(parsedValue, '', "fixture bug: 'Reviewed-By-Agent' did not parse as a git trailer on this commit — check the blank-line-before-trailer formatting");
  }
  return { sha, short, subject };
}

function runDirectMerge(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

// ---- PASS (spec item 4) ----
// Expected red shape: this is a CONTROL case. Today's direct-merge has no receipt check
// at all, so it already performs the merge unconditionally (status 0) — this assertion
// is expected to be GREEN both before and after the gate ships. It exists to pin that
// the gate, once built, does not over-refuse a fully-reviewed branch.
test('direct-merge.mjs: a code-touching commit carrying the Reviewed-By-Agent trailer merges — receipt gate does not refuse', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/trailered']);
    writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature',
      trailer: 'Reviewed-By-Agent: reviewer-correctness (opus) — findings adjudicated',
    });

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `a fully-trailered code-touching commit must not be refused by the receipt gate — stdout=${r.stdout} stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.branch_merged, 'feat/trailered');
    assert.equal(out.merged_into, 'main');
  } finally {
    cleanup();
  }
});

// ---- REFUSE (spec item 3) ----
// Expected red shape: today's direct-merge has no receipt check, so it merges this
// untrailered code-touching commit successfully (status 0, JSON stdout, real merge on
// main). `assert.notEqual(r.status, 0, ...)` fails first, with r.stdout in the message —
// a legible "missing refusal", not a crash.
test('direct-merge.mjs: a code-touching commit WITHOUT the review trailer refuses — names the offending commit and both remedies', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/untrailered']);
    const c1 = writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature without review',
    });

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `an untrailered code-touching commit must refuse the merge, not succeed — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, new RegExp(c1.short), 'refusal names the offending commit by short sha');
    assert.match(r.stderr, /add feature without review/, 'refusal names the offending commit by subject');
    assert.match(r.stderr, /Reviewed-By-Agent/, 'refusal names the amend/record-trailer remedy');
    assert.match(r.stderr, /--waive-reviews/, 'refusal names the --waive-reviews remedy');
  } finally {
    cleanup();
  }
});

// ---- EXEMPT (spec item 6) ----
// Expected red shape: another CONTROL case — a docs-only commit was never going to be
// blocked by a receipt gate that doesn't exist yet either, so this is expected GREEN
// pre-implementation too. It pins that the gate's file-glob filter (spec item 1) is
// correctly scoped and never widens to non-code paths.
test('direct-merge.mjs: a docs-only commit without the trailer is exempt from the receipt gate', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'docs/only']);
    writeAndCommit(dir, {
      path: 'rulings.md',
      content: '# Rulings\n\nnote.\n',
      subject: 'update rulings doc',
    });

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `a docs-only commit must never be blocked by the receipt gate — stdout=${r.stdout} stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.branch_merged, 'docs/only');
  } finally {
    cleanup();
  }
});

// ---- MIXED (spec item 5) ----
// Expected red shape: same as REFUSE above — today's merge succeeds outright
// (status 0), so `assert.notEqual(r.status, 0, ...)` fails first with the actual
// stdout/stderr shown, a legible missing-refusal rather than a crash.
test('direct-merge.mjs: mixed trailered/untrailered code-touching commits — refusal names ONLY the untrailered one', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/mixed']);
    const trailered = writeAndCommit(dir, {
      path: 'src/one.mjs',
      content: 'export const one = 1;\n',
      subject: 'add reviewed change',
      trailer: 'Reviewed-By-Agent: reviewer-correctness (opus) — findings adjudicated',
    });
    const untrailered = writeAndCommit(dir, {
      path: 'src/two.mjs',
      content: 'export const two = 2;\n',
      subject: 'add unreviewed change',
    });

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a mix with even one untrailered code-touching commit must refuse — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, new RegExp(untrailered.short), 'refusal names the untrailered commit by short sha');
    assert.match(r.stderr, /add unreviewed change/, 'refusal names the untrailered commit by subject');
    assert.doesNotMatch(r.stderr, new RegExp(trailered.short), 'the already-reviewed commit must NOT be listed as offending, by sha');
    assert.doesNotMatch(r.stderr, /add reviewed change/, 'the already-reviewed commit must NOT be listed as offending, by subject');
  } finally {
    cleanup();
  }
});

// ---- WAIVE (spec item 7) ----
// Expected red shape: --waive-reviews is an unrecognized flag today. Whether that
// surfaces as an argument-parsing refusal (non-zero exit) or is silently ignored and
// the merge just proceeds (status 0 but with NEITHER the sha nor the reason ever
// printed), either way the `assert.match(combined, ...)` calls fail against today's
// output — the failing assertion messages embed stdout+stderr, making the actual
// cause (flag unsupported, output missing) legible rather than a bare crash.
test('direct-merge.mjs: --waive-reviews proceeds and loudly lists each waived commit with the reason', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/waived']);
    const c1 = writeAndCommit(dir, {
      path: 'src/legacy.mjs',
      content: 'export const legacy = 1;\n',
      subject: 'pre-mechanism legacy change',
    });

    const r = runDirectMerge(dir, ['--waive-reviews', 'historical commits pre-mechanism']);
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.status, 0, `--waive-reviews must let the merge proceed — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(combined, new RegExp(c1.short), `the waived commit must be named by short sha, loud not silent — got: ${combined}`);
    assert.match(combined, /historical commits pre-mechanism/, `the waiver reason must be echoed back, loud not silent — got: ${combined}`);
  } finally {
    cleanup();
  }
});

// ---- REGRESSION PIN (spec item 8) ----
// Expected shape: this pins PRE-EXISTING behavior (scripts/tests/pipeline.test.mjs
// already covers mergeBranchInto's dirty-tree refusal at the branch-manager level via
// /dirty/). It is expected to be GREEN already today AND after the receipt gate ships —
// its purpose is to catch a regression where an implementation of the new gate
// accidentally reorders or short-circuits the existing dirty-tree check.
test('direct-merge.mjs: a dirty working tree still refuses even when every commit carries the review trailer (regression pin)', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/dirty']);
    writeAndCommit(dir, {
      path: 'src/clean-commit.mjs',
      content: 'export const c = 1;\n',
      subject: 'fully reviewed change',
      trailer: 'Reviewed-By-Agent: reviewer-correctness (opus) — findings adjudicated',
    });
    // dirty the tree AFTER the commit — nothing staged or committed
    writeFileSync(join(dir, 'src', 'clean-commit.mjs'), 'export const c = 999; // uncommitted\n');

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, 'a dirty working tree must refuse the merge regardless of review receipts');
    assert.match(r.stderr, /dirty/i, 'the pre-existing dirty-tree refusal still fires');
  } finally {
    cleanup();
  }
});
