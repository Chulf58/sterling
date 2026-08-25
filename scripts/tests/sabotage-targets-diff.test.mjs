// SABOTAGE-TARGETS-THE-DIFF CHECK (board 4a867546-2b3e-44ff-a5df-83fd4e9228f6) —
// SPEC ONLY, red-first. scripts/commit-reviewed.mjs's sabotage-vs-diff warning
// DOES NOT EXIST YET (confirmed via Grep before writing this file: only the
// board item's evidence — a passing mutation check sabotaging barrel_heat.gd
// while the diff changed machine_gun.gd, caught only by reviewers — mentions
// this behavior; no such check is present under scripts/).
//
// Spec under test (board 4a867546, verbatim fix line): "at commit time, warn
// 'SABOTAGE TARGETS <file>, WHICH THIS DIFF DOES NOT CHANGE'." The warning is
// loud but non-blocking — the commit still proceeds — distinguishing this from
// every OTHER refusal path scripts/commit-reviewed.mjs already has (missing
// -m, zero ledger entries, corrupt ledger, etc. — see
// scripts/tests/commit-reviewed.test.mjs, read in full for harness
// conventions, NOT modified, NOT imported).
//
// SEAM / ASSUMPTION (flagged per the launching agent's instruction — read this
// before trusting pins (a)/(b) below): the board item and its cited evidence
// describe WHERE the sabotage/mutation-check input comes from only in prose
// ("both inputs are already written down") — no existing test fixture in
// scripts/tests seeds a "recorded sabotage target" artifact for
// commit-reviewed.mjs (grepped for sabotage/mutation_observed/known_gaps
// across scripts/tests: known_gaps is a feature_article field unrelated to
// this CLI; nothing else matches). Lacking a discoverable fixture convention,
// this file ASSUMES the most structurally consistent surface: an OPTIONAL
// `sabotage_targets: string[]` field riding on a review-ledger entry (the
// artifact commit-reviewed.mjs already reads at commit time via
// .sterling/review-ledger.json, per scripts/tests/commit-reviewed.test.mjs's
// writeLedger() convention — the natural place to attach data recorded by the
// same reviewing act that produced the mutation check). If the real
// implementation reads a differently-named field, a separate file, or a
// different location, pins (a) and (b) below will need their seed data
// updated to match — see the report for this flagged as the open seam
// question. Pin (c) (no sabotage record at all) does not depend on this
// assumption at all: it is the absence case, which looks identical regardless
// of the real field's name.
//
// Harness: git()/makeRepo()/ledgerPath()/writeLedger()/stageChange()/
// runCommitReviewed() are reproduced standalone from
// scripts/tests/commit-reviewed.test.mjs's own helpers (that file's header
// notes the same idiom is reused, uncopied, by
// scripts/tests/commit-reviewed-hardening.test.mjs) — read for convention,
// never imported, never modified. Written BLIND to scripts/commit-reviewed.mjs
// internals (H4 read wall; a fixer is landing this in a parallel lane).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = join(root, 'scripts', 'commit-reviewed.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sabotage-diff-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function writeLedger(dir, entries) {
  writeFileSync(ledgerPath(dir), JSON.stringify(entries));
}
function readLedger(dir) {
  return existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null;
}

function stageChange(dir, relPath = 'src/feature.mjs', content = 'export const f = 1;\n') {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

function runCommitReviewed(dir, args = []) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function combinedOutput(r) {
  return `${r.stdout}\n${r.stderr}`;
}

// ---------------------------------------------------------------------------
// (a) CONTROL — the sabotage target IS in the staged diff: no warning, commit
// proceeds normally. Placed first per the control-arm requirement: this test
// must pass for the OPPOSITE reason from (b) — because the target genuinely
// IS covered by the diff, not because the check is simply never wired.
// ---------------------------------------------------------------------------

test('sabotage-targets-diff CONTROL: sabotage target IS in the staged diff — no warning is emitted, commit proceeds', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    writeLedger(dir, [
      {
        agent_type: 'reviewer-correctness',
        files: ['src/feature.mjs'],
        at: '2026-08-24T00:00:00.000Z',
        sabotage_targets: ['src/feature.mjs'], // same path as the staged change
      },
    ]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'feature reviewed, sabotage targeted the diff']);
    // EXPECTED FAILURE SHAPE: the CLI/check does not exist yet — spawnSync's
    // module-not-found nonzero exit fails this assertion first.
    assert.equal(r.code, 0, `a sabotage target that IS in the diff must still succeed — stdout=${r.stdout} stderr=${r.stderr}`);

    // NAMED SABOTAGE for this pin: drop the diff-membership check entirely so
    // the warning fires unconditionally on every commit — that flips this
    // exact assertion red (an unexpected warning appears where none should).
    assert.doesNotMatch(
      combinedOutput(r),
      /SABOTAGE TARGETS/i,
      'no sabotage warning is emitted when the named target genuinely is part of the staged diff'
    );

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(afterHead, beforeHead, 'the commit was created');
    assert.deepEqual(readLedger(dir), [], 'the ledger entry was consumed normally, same as any clean commit');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) sabotage names a file OUTSIDE the diff — the warning names that exact
// file, and the commit still succeeds (warning, never refusal).
// ---------------------------------------------------------------------------

test('sabotage-targets-diff: sabotage target is OUTSIDE the staged diff — the warning names that exact file and the commit still succeeds', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    writeLedger(dir, [
      {
        agent_type: 'reviewer-correctness',
        files: ['src/feature.mjs'],
        at: '2026-08-24T00:00:00.000Z',
        sabotage_targets: ['src/other-untouched.mjs'], // never staged
      },
    ]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'feature reviewed, sabotage targeted an unrelated file']);
    // EXPECTED FAILURE SHAPE: the CLI/check does not exist yet — the commit
    // succeeding coincidentally does not help; the warning-text match below is
    // the assertion expected to fail red first, since no such vocabulary
    // exists in any current output.
    assert.equal(r.code, 0, `the warning is non-blocking — the commit must still succeed — stdout=${r.stdout} stderr=${r.stderr}`);

    // NAMED SABOTAGE for this pin: invert the diff-membership comparison so
    // every sabotage target is treated as already "in the diff" (e.g. `if
    // (!inDiff)` becomes `if (inDiff)`, or the check is deleted outright) —
    // that suppresses the warning this exact test requires and flips it red.
    // Note this is the COMPLEMENTARY sabotage to (a)'s "always warn": (a)
    // catches "warn unconditionally", this test catches "never warn" /
    // "treat everything as in-diff" — together they bound the check from both
    // sides.
    assert.match(
      combinedOutput(r),
      /SABOTAGE TARGETS[^\n]*src\/other-untouched\.mjs[^\n]*WHICH THIS DIFF DOES NOT CHANGE/,
      'the warning names the exact sabotage-targeted file that the diff does not change, in the specified shape'
    );

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(afterHead, beforeHead, 'the commit was created despite the warning — this is a warning, never a refusal');
    assert.deepEqual(readLedger(dir), [], 'the ledger entry was still consumed — the warning does not block normal consumption');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) no sabotage record at all — no warning, no crash. Does not depend on
// the seam assumption above: entries simply omit the (possibly
// differently-named, possibly differently-located) sabotage field entirely.
// ---------------------------------------------------------------------------

test('sabotage-targets-diff: no sabotage/mutation-check record at all on the ledger entry — no warning, no crash, commit proceeds normally', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    writeLedger(dir, [
      {
        agent_type: 'reviewer-correctness',
        files: ['src/feature.mjs'],
        at: '2026-08-24T00:00:00.000Z',
        // no sabotage_targets key at all, and no sibling artifact seeded either
      },
    ]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'feature reviewed, no sabotage record present']);
    // EXPECTED FAILURE SHAPE (today): the CLI does not exist at all yet, so
    // spawnSync's module-not-found nonzero exit fails `assert.equal(r.code,
    // 0, ...)` first. Once the base CLI exists but the sabotage check is
    // absent/naive, this line should already be green (there is nothing to
    // warn about) — it is pinned here as a NEVER-CRASH regression guard: a
    // naive implementation that assumes the field is always present (e.g.
    // `entry.sabotage_targets.forEach(...)` with no guard) throws a
    // TypeError reading `.forEach` of undefined, which shows up here as a
    // nonzero/crash exit — that is the behavior this test forbids.
    assert.equal(r.code, 0, `a ledger entry with no sabotage record must commit cleanly, never crash — stdout=${r.stdout} stderr=${r.stderr}`);

    // NAMED SABOTAGE for this pin: remove the guard around reading the
    // (optional) sabotage field — e.g. iterate `entry.sabotage_targets`
    // directly without an `Array.isArray(...)`/undefined check — which
    // throws on this exact fixture and flips the exit-code assertion red.
    assert.doesNotMatch(combinedOutput(r), /SABOTAGE TARGETS/i, 'no sabotage warning is fabricated when no such record exists');

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(afterHead, beforeHead, 'the commit was created normally');
    assert.deepEqual(readLedger(dir), [], 'the ledger entry was consumed normally');
  } finally {
    cleanup();
  }
});
