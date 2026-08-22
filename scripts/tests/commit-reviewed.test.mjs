// COMMIT-REVIEWED CLI (part B of decision 12a26ca6-a301-466d-a45c-5e1eeff36694,
// slug review-receipt-ledger; board 7814acc3-bb22-4cc5-abd7-789d6396743f) —
// SPEC ONLY, red-first. scripts/commit-reviewed.mjs DOES NOT EXIST YET
// (confirmed via Grep before writing this file: only the decision record and
// the dispatch brief mention the path; no such file is present under
// scripts/).
//
// Spec under test (verified against the decision record; precedent named
// there is scripts/enforcement-stamp.mjs — a conductor-run CLI with
// no-nonsense argv parsing and a fail() helper that writes to stderr and
// exits 1):
//
//   Invocation: `node scripts/commit-reviewed.mjs -m "<message>"`.
//   - No -m / missing message: refuse, exit 1, stderr names the requirement.
//   - >=1 un-consumed entry in .sterling/review-ledger.json AND staged
//     changes present: creates a git commit whose message carries ONE
//     `Reviewed-By-Agent: <agent_type>` trailer per ledger entry, and
//     CONSUMES the stamped entries in the SAME act — removes them from the
//     ledger — so an immediate second invocation refuses (zero entries
//     left). The trailer must be readable via the EXACT read
//     scripts/direct-merge.mjs:143 uses:
//       git log -1 --format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)
//   - ZERO un-consumed entries (missing ledger, empty array, or already
//     consumed): refuses, exit 1, stderr gives guidance — dispatch a
//     reviewer, or commit bare and answer at the merge gate — and makes NO
//     commit at all (HEAD unmoved).
//
// The CLI is invoked with cwd = the fixture repo (mirrors
// scripts/enforcement-stamp.mjs's cwd-relative convention, exercised in
// scripts/tests/enforcement.test.mjs's runStampCli helper) — no --target
// flag is part of this spec.
//
// ASSUMPTION (stated per the launching agent's instruction to flag any
// spec ambiguity resolved by assumption): the decision record and brief are
// SILENT on what happens with >=1 ledger entries but NOTHING staged. Since
// P5 ("fail loud, never silent") governs this codebase and an empty commit
// that silently consumes real reviewer evidence for nothing would be a
// silent loss of that evidence, this file asserts the CLI refuses (nonzero
// exit) rather than creating an empty commit — see the dedicated test below,
// clearly marked as resting on this assumption rather than the decision
// record's explicit text.
//
// Harness: written BLIND to any commit-reviewed.mjs internals (none exist)
// and to scripts/direct-merge.mjs's internals (H4 read wall) — only the CLI
// surface described above and git's own trailer-parsing format string (given
// verbatim in the spec) are used. git()/makeReceiptGateRepo()-style fixture
// conventions are adapted from scripts/tests/merge-review-receipts.test.mjs
// and scripts/tests/enforcement.test.mjs's runStampCli idiom, without
// importing or modifying either file.

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

function gitAllowFail(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-'));
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

// Stage a new change so "staged changes present" holds for the CLI to commit.
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

// The EXACT read scripts/direct-merge.mjs:143 uses.
function readTrailerValues(dir, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

// ---------------------------------------------------------------------------
// (1) Missing -m: refuse, exit 1, names the requirement.
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs: missing -m refuses with exit 1 and names the requirement', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: '2026-08-22T00:00:00.000Z' }]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    // EXPECTED FAILURE SHAPE: the CLI does not exist yet — spawnSync's
    // module-not-found failure IS itself a nonzero exit, so `assert.equal
    // (r.code, 1, ...)` may coincidentally hold, but the message assertion
    // below (a specific vocabulary about the required message) will not,
    // since no such text is produced by a launch failure.
    const r = runCommitReviewed(dir, []);
    assert.equal(r.code, 1, `missing -m must refuse with exit 1 — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /-m|message/i, 'refusal names the missing message requirement');

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(afterHead, beforeHead, 'no commit was made without a message');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (2) Zero un-consumed entries: refuse, exit 1, guidance, no commit.
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs: zero un-consumed ledger entries (no ledger file at all) refuses — exit 1, guidance, NO commit made', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    assert.equal(existsSync(ledgerPath(dir)), false, 'precondition: no ledger file exists');
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    // EXPECTED FAILURE SHAPE: CLI missing -> module-not-found nonzero exit
    // may coincidentally satisfy `assert.equal(r.code, 1, ...)`, but the
    // guidance-text assertions below fail red (no such vocabulary exists).
    const r = runCommitReviewed(dir, ['-m', 'attempt without review']);
    assert.equal(r.code, 1, `zero ledger entries must refuse — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /dispatch.*review|reviewer/i, 'guidance names dispatching a reviewer');
    assert.match(r.stderr, /merge gate|commit bare/i, 'guidance names the bare-commit / merge-gate alternative');

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(afterHead, beforeHead, 'a refused commit-reviewed invocation must never create a commit');
  } finally {
    cleanup();
  }
});

test('commit-reviewed.mjs: zero un-consumed ledger entries (EMPTY array ledger) refuses identically', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, []);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'attempt with empty ledger']);
    assert.equal(r.code, 1, `an empty-array ledger must refuse exactly like a missing one — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /dispatch.*review|reviewer/i);
    assert.match(r.stderr, /merge gate|commit bare/i);

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(afterHead, beforeHead);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (3) Happy path: stamps every entry's trailer and consumes them.
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs: with staged changes and 2 ledger entries, commits with ONE trailer per entry (readable via the exact direct-merge git format string) and CONSUMES the ledger', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: '2026-08-22T00:00:00.000Z' },
      { agent_type: 'reviewer-security', files: ['src/feature.mjs'], at: '2026-08-22T00:01:00.000Z' },
    ]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    // EXPECTED FAILURE SHAPE: the CLI does not exist — spawnSync reports a
    // module-not-found nonzero exit, so `assert.equal(r.code, 0, ...)` is the
    // line that fails red first, with stdout/stderr embedded for legibility.
    const r = runCommitReviewed(dir, ['-m', 'add feature, fully reviewed']);
    assert.equal(r.code, 0, `a staged change with 2 un-consumed ledger entries must succeed — stdout=${r.stdout} stderr=${r.stderr}`);

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(afterHead, beforeHead, 'a new commit was created');

    const subject = git(dir, ['log', '-1', '--format=%s']);
    assert.equal(subject, 'add feature, fully reviewed', 'the commit subject carries the -m message');

    const trailers = readTrailerValues(dir);
    assert.deepEqual(trailers.sort(), ['reviewer-correctness', 'reviewer-security'].sort(), 'one Reviewed-By-Agent trailer per ledger entry, readable via the exact direct-merge format string');

    const ledgerAfter = readLedger(dir);
    assert.deepEqual(ledgerAfter, [], 'the stamped entries are CONSUMED — removed from the ledger in the same act');
  } finally {
    cleanup();
  }
});

test('commit-reviewed.mjs: an IMMEDIATE second invocation after the happy path refuses (the ledger was consumed, zero entries remain)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/first.mjs');
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/first.mjs'], at: '2026-08-22T00:00:00.000Z' }]);

    const first = runCommitReviewed(dir, ['-m', 'first reviewed change']);
    assert.equal(first.code, 0, `first invocation must succeed — stdout=${first.stdout} stderr=${first.stderr}`);
    const headAfterFirst = git(dir, ['rev-parse', 'HEAD']);

    // second invocation: stage something new, but the ledger is now empty
    stageChange(dir, 'src/second.mjs');
    const second = runCommitReviewed(dir, ['-m', 'second change, no fresh review']);
    // EXPECTED FAILURE SHAPE: this whole test is red-from-scratch (the CLI
    // does not exist), but is written to remain meaningful once the happy
    // path above passes: the FIRST invocation's `assert.equal(first.code, 0)`
    // fails red today. Once that passes, this second-invocation refusal is
    // the assertion that pins P4 consumption.
    assert.equal(second.code, 1, `the second invocation must refuse — the ledger was already consumed — stdout=${second.stdout} stderr=${second.stderr}`);
    assert.match(second.stderr, /dispatch.*review|reviewer/i);

    const headAfterSecond = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(headAfterSecond, headAfterFirst, 'the refused second invocation made no commit');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (4) Boundary — malformed ledger is treated as zero entries, never a crash.
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs: a malformed (corrupt JSON) ledger is treated as zero un-consumed entries — refuses, never crashes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeFileSync(ledgerPath(dir), '{ not json at all');
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'attempt with corrupt ledger']);
    assert.notEqual(r.code, 0, `a corrupt ledger must not silently succeed as if reviewed — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(r.code, 1, 'refusal, not a crash — same exit code family as the zero-entry refusal');

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(afterHead, beforeHead, 'no commit made against a corrupt ledger');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (5) ASSUMPTION-MARKED: no staged changes at all, even with entries present.
// See file header — the decision record is silent here; this pins a refusal
// rather than a silent empty commit, per P5. If the conductor's actual build
// instead defines a different contract (e.g. delegating entirely to `git
// commit`'s own "nothing to commit" exit), this specific test — and only
// this one — should be revisited against that ruling.
// ---------------------------------------------------------------------------

test('commit-reviewed.mjs (ASSUMPTION): with ledger entries present but NOTHING staged, the CLI refuses rather than creating an empty commit that silently consumes review evidence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // no stageChange() call — the tree is clean relative to HEAD
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/base.mjs'], at: '2026-08-22T00:00:00.000Z' }]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);
    const status = gitAllowFail(dir, ['status', '--porcelain']);
    assert.equal((status.stdout ?? '').trim(), '', 'fixture guard: the working tree is genuinely clean, nothing staged');

    const r = runCommitReviewed(dir, ['-m', 'nothing staged']);
    assert.notEqual(r.code, 0, `with nothing staged, the CLI must not create an empty commit that consumes real review evidence for nothing — stdout=${r.stdout} stderr=${r.stderr}`);

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(afterHead, beforeHead, 'no commit made with nothing staged');
    const ledgerAfter = readLedger(dir);
    assert.equal(ledgerAfter.length, 1, 'the ledger entry must survive untouched — it was never legitimately consumed');
  } finally {
    cleanup();
  }
});
