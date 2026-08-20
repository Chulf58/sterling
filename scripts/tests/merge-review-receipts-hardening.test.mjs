// REVIEW-RECEIPT MERGE GATE — HARDENING PINS (board d3752b2e-25f3-4bda-b127-bb3b56bc0430)
//
// Base spec: scripts/tests/merge-review-receipts.test.mjs (read in full — its
// harness conventions, `git()`/`writeAndCommit()`/`runDirectMerge()` idioms
// and `makeReceiptGateRepo()` fixture are reproduced/adapted here rather than
// imported, so this file stays a standalone, independently-runnable spec).
//
// This file adds four pins the base spec does not cover:
//
//   4. MERGE-COMMIT-NOT-EXEMPT — a merge commit is not automatically exempt
//      from the receipt gate just for being a merge commit. If its --cc
//      combined diff carries real conflict-resolution content (i.e. it is
//      not the trivial union of both parents), it is CODE-TOUCHING like any
//      other commit and must carry the trailer. The converse control: a
//      clean merge commit whose --cc combined diff is EMPTY (a disjoint-file
//      auto-merge) is exempt even without a trailer.
//   5. EMPTY-VALUE-TRAILER-REFUSED — a commit carrying the literal trailer
//      line `Reviewed-By-Agent:` with nothing after the colon is refused.
//      This deliberately SUPERSEDES the base spec file's item 2 prose
//      ("presence of the trailer KEY satisfies the gate ... value is free
//      text") — conductor-adjudicated: an empty value is no receipt at all.
//   6. EMPTY-REASON-WAIVE-REFUSED — `--waive-reviews ''` (empty string) is
//      refused, naming the non-empty-reason requirement, rather than being
//      accepted as a valid (if vacuous) waiver.
//   7. NO-MERGE-ON-REFUSAL — after any receipt refusal, the base branch
//      (`main`)'s HEAD is provably unmoved (git rev-parse before == after).
//      This assertion is also folded into tests 4 and 5 above, since it is
//      cheap and those scenarios are themselves refusals.
//
// Written BLIND to scripts/direct-merge.mjs's internals (H4 read wall) — only
// its CLI surface (--target, --waive-reviews, exit conventions, JSON stdout
// on success, stderr on refusal) is used, learned from the base spec file.
//
// EXPECTED FAILURE SHAPE (general, pre-fix): none of items 4-7's behavior
// exists in direct-merge.mjs today (no merge-commit-diff scoping, no
// empty-value trailer rejection, no --waive-reviews reason validation), so
// every `assert.notEqual(r.status, 0, ...)` below that expects a refusal is
// the line that reports red — today's direct-merge merges these branches
// successfully (status 0) instead. Per-test notes call out any deviation.

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

// Same as `git()` but tolerates a non-zero exit (used only for the merge
// attempt expected to conflict) — the caller inspects `.status` itself.
function gitAllowFail(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeReceiptGateRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-receipt-hardening-'));
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

// Writes `content` at `relPath`, stages, and commits. When `trailer` is
// given it is passed as a SEPARATE `-m` paragraph (subject, blank line,
// trailer line) — the shape a real Reviewed-By-Agent trailer needs. Unlike
// the base spec file's helper, this one does NOT assert the trailer parses
// with a non-empty value — several tests in this file deliberately construct
// an empty-value trailer, so that guard belongs in the individual tests that
// need it, not in the shared helper.
function writeAndCommit(dir, { path: relPath, content, subject, trailer }) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
  const args = trailer ? ['commit', '-m', subject, '-m', trailer] : ['commit', '-m', subject];
  git(dir, args);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const short = git(dir, ['rev-parse', '--short', sha]);
  return { sha, short, subject };
}

function runDirectMerge(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

// ---------------------------------------------------------------------------
// 4a — MERGE-COMMIT-NOT-EXEMPT: a merge commit resolving a real conflict
// carries real code content and must not be exempted just for being a merge
// commit.
//
// Expected red shape: today's direct-merge has no merge-commit awareness at
// all (no receipt check whatsoever), so it merges this conflict-resolving,
// untrailered merge commit successfully (status 0). `assert.notEqual(r.status,
// 0, ...)` is the line that reports red, with stdout/stderr embedded — a
// legible "missing refusal", not a crash.
// ---------------------------------------------------------------------------
test('direct-merge.mjs (hardening) MERGE-COMMIT-NOT-EXEMPT: a merge commit whose --cc combined diff carries real conflict-resolution content is not exempt from the receipt gate', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/conflict-side']);
    writeAndCommit(dir, {
      path: 'src/shared.mjs',
      content: 'export const shared = "side";\n',
      subject: 'side: change shared value',
      trailer: 'Reviewed-By-Agent: reviewer-correctness (opus) — side reviewed',
    });

    git(dir, ['checkout', 'main']);
    git(dir, ['checkout', '-b', 'feat/conflict']);
    writeAndCommit(dir, {
      path: 'src/shared.mjs',
      content: 'export const shared = "feature";\n',
      subject: 'feature: change shared value',
      trailer: 'Reviewed-By-Agent: reviewer-correctness (opus) — feature reviewed',
    });

    const mergeAttempt = gitAllowFail(dir, ['merge', '--no-edit', 'feat/conflict-side']);
    assert.notEqual(mergeAttempt.status, 0, 'fixture guard: expected feat/conflict-side to conflict with feat/conflict on src/shared.mjs');

    // Resolve by hand: write a final value neither parent had, stage, and
    // complete the merge commit with the default (untrailered) message.
    writeFileSync(join(dir, 'src', 'shared.mjs'), 'export const shared = "resolved";\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--no-edit']);

    const mergeSha = git(dir, ['rev-parse', 'HEAD']);
    const mergeShort = git(dir, ['rev-parse', '--short', mergeSha]);
    const mergeSubject = git(dir, ['log', '-1', '--format=%s', mergeSha]);

    // Fixture guard: confirm this merge commit's combined diff is NOT empty
    // — it must actually carry conflict-resolution content, per the spec's
    // own definition of the non-exempt case.
    const combined = git(dir, ['show', '--format=', '--cc', mergeSha]);
    assert.notEqual(combined.trim(), '', 'fixture guard: a hand-resolved conflict merge must have a non-empty --cc combined diff');

    const mainBefore = git(dir, ['rev-parse', 'main']);
    const r = runDirectMerge(dir);
    assert.notEqual(
      r.status,
      0,
      `a merge commit resolving a real conflict must not be exempted just for being a merge commit — stdout=${r.stdout} stderr=${r.stderr}`
    );
    assert.match(r.stderr, new RegExp(mergeShort), 'refusal names the merge commit by short sha');
    assert.match(r.stderr, new RegExp(escapeRegex(mergeSubject)), 'refusal names the merge commit by subject');
    assert.match(r.stderr, /Reviewed-By-Agent/, 'refusal names the amend/record-trailer remedy');
    assert.match(r.stderr, /--waive-reviews/, 'refusal names the --waive-reviews remedy');

    const mainAfter = git(dir, ['rev-parse', 'main']);
    assert.equal(mainAfter, mainBefore, 'a refused merge must never move the base branch HEAD (NO-MERGE-ON-REFUSAL)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4b — MERGE-COMMIT-EXEMPT (control): a clean merge of disjoint files, whose
// --cc combined diff is empty, is NOT blocked even without a trailer.
//
// Expected shape: this is a CONTROL case. Today's direct-merge has no
// receipt check at all, so it already merges this branch unconditionally
// (status 0) — expected GREEN both before and after the gate ships. It
// exists to pin that the merge-commit scoping in 4a does not over-reach and
// start blocking every merge commit indiscriminately.
// ---------------------------------------------------------------------------
test('direct-merge.mjs (hardening) MERGE-COMMIT-EXEMPT (control): a clean merge commit with an empty --cc combined diff is not blocked, even without a trailer', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/clean-side']);
    writeAndCommit(dir, {
      path: 'src/clean-b.mjs',
      content: 'export const cleanB = 1;\n',
      subject: 'side: add clean-b',
      trailer: 'Reviewed-By-Agent: reviewer-correctness (opus) — side reviewed',
    });

    git(dir, ['checkout', 'main']);
    git(dir, ['checkout', '-b', 'feat/clean']);
    writeAndCommit(dir, {
      path: 'src/clean-a.mjs',
      content: 'export const cleanA = 1;\n',
      subject: 'feature: add clean-a',
      trailer: 'Reviewed-By-Agent: reviewer-correctness (opus) — feature reviewed',
    });

    // Disjoint files -> clean, non-conflicting merge. Both branches diverge
    // from the common ancestor with their own commit, so this is a genuine
    // three-way merge (not a fast-forward) and still produces a real merge
    // commit with two parents.
    git(dir, ['merge', '--no-edit', 'feat/clean-side']);
    const mergeSha = git(dir, ['rev-parse', 'HEAD']);

    const combined = git(dir, ['show', '--format=', '--cc', mergeSha]);
    assert.equal(combined.trim(), '', 'fixture guard: a clean disjoint-file merge must have an empty --cc combined diff');

    const r = runDirectMerge(dir);
    assert.equal(
      r.status,
      0,
      `a clean merge commit (empty --cc combined diff) must not be blocked by the receipt gate even without a trailer — stdout=${r.stdout} stderr=${r.stderr}`
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.branch_merged, 'feat/clean');
    assert.equal(out.merged_into, 'main');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5 — EMPTY-VALUE-TRAILER-REFUSED
//
// Expected red shape: today's direct-merge has no receipt check at all
// (baseline) — it would merge this commit successfully. Once the base
// receipt gate exists (parallel fixer), it might treat trailer-key presence
// alone as satisfying (per the base spec file's original, now-superseded,
// prose) and merge it anyway. Either way, `assert.notEqual(r.status, 0, ...)`
// is the line that reports red until the empty-value hardening also lands.
// ---------------------------------------------------------------------------
test('direct-merge.mjs (hardening) EMPTY-VALUE-TRAILER-REFUSED: a commit with a literal empty-value Reviewed-By-Agent trailer is refused', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/empty-trailer']);
    const c1 = writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature with empty-value trailer',
      trailer: 'Reviewed-By-Agent:',
    });

    // Fixture guard: confirm the commit message really does carry the bare,
    // empty-value trailer line as intended (protects against a fixture bug
    // — e.g. missing blank-line separation — manufacturing a false red for
    // the wrong reason).
    const body = git(dir, ['log', '-1', '--format=%B', c1.sha]);
    assert.match(body, /^Reviewed-By-Agent:\s*$/m, 'fixture guard: the commit message carries the literal empty-value trailer line');

    const mainBefore = git(dir, ['rev-parse', 'main']);
    const r = runDirectMerge(dir);
    assert.notEqual(
      r.status,
      0,
      `an empty-value Reviewed-By-Agent trailer must be treated as no receipt at all, not a satisfied gate — stdout=${r.stdout} stderr=${r.stderr}`
    );
    assert.match(r.stderr, new RegExp(c1.short), 'refusal names the offending commit by short sha');
    assert.match(r.stderr, /add feature with empty-value trailer/, 'refusal names the offending commit by subject');
    assert.match(r.stderr, /Reviewed-By-Agent/, 'refusal names the amend/record-trailer remedy');
    assert.match(r.stderr, /--waive-reviews/, 'refusal names the --waive-reviews remedy');

    const mainAfter = git(dir, ['rev-parse', 'main']);
    assert.equal(mainAfter, mainBefore, 'a refused merge must never move the base branch HEAD (NO-MERGE-ON-REFUSAL)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6 — EMPTY-REASON-WAIVE-REFUSED
//
// Expected red shape: --waive-reviews is either unrecognized today (an
// argument-parsing refusal that would coincidentally pass `assert.notEqual
// (r.status, 0, ...)` but then fail the subsequent content assertions about
// "reason"/"non-empty" naming, since an unrecognized-flag error will not use
// that vocabulary), or once --waive-reviews with a real reason lands (per
// the base spec file), an empty string might be accepted as a "reason" with
// no further validation, making status 0 and the `assert.notEqual` line the
// one that reports red. Either way the failure is legible: stdout+stderr are
// embedded in every message.
// ---------------------------------------------------------------------------
test('direct-merge.mjs (hardening) EMPTY-REASON-WAIVE-REFUSED: --waive-reviews with an empty-string reason is refused, naming the non-empty-reason requirement', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/empty-waive-reason']);
    writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature without review, empty waive reason attempted',
    });

    const mainBefore = git(dir, ['rev-parse', 'main']);
    const r = runDirectMerge(dir, ['--waive-reviews', '']);
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(
      r.status,
      0,
      `--waive-reviews with an empty-string reason must be refused, not accepted as a valid waiver — stdout=${r.stdout} stderr=${r.stderr}`
    );
    assert.match(combined, /--waive-reviews/, `refusal names the flag under discussion — got: ${combined}`);
    assert.match(combined, /reason/i, `refusal names the reason requirement — got: ${combined}`);
    assert.match(combined, /non-empty|empty|required|missing/i, `refusal states the reason must be non-empty — got: ${combined}`);

    const mainAfter = git(dir, ['rev-parse', 'main']);
    assert.equal(mainAfter, mainBefore, 'a refused waive attempt must never move the base branch HEAD (NO-MERGE-ON-REFUSAL)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7 — NO-MERGE-ON-REFUSAL (dedicated pin, classic untrailered-commit case)
//
// Expected red shape: today's direct-merge merges this untrailered
// code-touching commit successfully (status 0), so `assert.notEqual(r.status,
// 0, ...)` fails first with stdout embedded — there is no refusal to pin the
// HEAD-unmoved claim against yet.
// ---------------------------------------------------------------------------
test('direct-merge.mjs (hardening) NO-MERGE-ON-REFUSAL: after a plain untrailered-commit refusal, the base branch HEAD is provably unmoved', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/no-merge-on-refusal']);
    writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature without review (no-merge-on-refusal pin)',
    });

    const mainBefore = git(dir, ['rev-parse', 'main']);
    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `expected a receipt refusal to pin the HEAD-unmoved claim against — stdout=${r.stdout} stderr=${r.stderr}`);

    const mainAfter = git(dir, ['rev-parse', 'main']);
    assert.equal(
      mainAfter,
      mainBefore,
      'a refused merge must leave the base branch HEAD exactly where it was — no partial or attempted merge commit landed on main'
    );
  } finally {
    cleanup();
  }
});
