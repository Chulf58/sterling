// COMMIT-REVIEWED SPEND-WARNING ADVISORIES (board 09e03d76, branch
// sterling/board-fanout-aug25) — authored from the dispatch SPEC, not from
// scripts/commit-reviewed.mjs's internals (H4 read wall: this file's author
// never read that script). The implementation is reported as already landed
// on this branch, so these pins are expected to run GREEN today; a failure
// is reported as a finding against the spec below, not "fixed" here.
//
// Spec under test (as given by the launching agent):
//   Three advisory classes, evaluated over the un-consumed review-ledger
//   entries at commit-reviewed time. NONE of them ever refuses the commit —
//   they are advisory-only. Each firing warning:
//     (a) prints to stderr, and
//     (b) is pushed into a NEW `spend_warnings[]` array key in the stdout
//         summary JSON.
//   Classes:
//     1. MULTI-SPEND: more than 3 un-consumed receipts are about to be
//        stamped/consumed in this one commit.
//     2. NO FILE OVERLAP: a receipt's `files` share zero paths with the
//        currently staged diff (both sides path-normalized — forward
//        slashes, matching non-ASCII bytes — before comparing). ANY overlap
//        (even partial, mixed with unstaged paths) suppresses this warning
//        for that receipt.
//     3. STALENESS: a receipt whose `at` is more than 12h in the past, OR
//        whose `at` cannot be parsed into an age at all (the literal string
//        'n/a', or the `at` key missing entirely) — the latter reported as
//        "RECEIPT AGE UNVERIFIABLE" quoting the offending value, distinct
//        from the >12h "STALE RECEIPT" case.
//   None of the three classes filters entries out of the stamp/consume path:
//   every valid entry still gets exactly one Reviewed-By-Agent trailer and
//   is still consumed from the ledger, warnings or not.
//
// Fixture idiom copied from scripts/tests/commit-reviewed.test.mjs
// (makeRepo/writeLedger/stageChange/runCommitReviewed conventions), adapted
// with a flatten() helper for interpolating child stderr into assertion
// messages per anti-pattern ee89c3fd (never interpolate raw multi-line
// stderr into an assertion message — flatten it to one line first).
//
// Timestamps are always Date.now()-relative ISO strings (never hardcoded
// dates) so the staleness pins do not rot as the calendar moves.
//
// STRENGTHENING PASS (coordinator-directed, post-review): the spend_warnings[]
// element shape is now confirmed as plain strings carrying the SAME text as
// the corresponding stderr line, so P1/P3/P5/P7 now assert BOTH channels
// against the same marker regex (a class that only console.errors, or pushes
// a placeholder string, goes red). P7 also now proves the 'n/a' and the
// missing-`at` entries produce two DISTINCT warnings, not two identical ones.
// P2 additionally pins spend_warnings deep-equals [] on a clean run. Two new
// pins were added from freshly-landed implementation fixes: P10 (a JSON-valid
// but hostile, non-string `at`) and P11 (a RECORDS NO FILES advisory for
// empty/absent `files`).

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-spend-'));
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

function readTrailerValues(dir, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => (s ?? '').replace(/\r?\n/g, ' | ');

// Date.now()-relative ISO timestamps, never hardcoded dates.
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// ---------------------------------------------------------------------------
// MULTI-SPEND: P2 (CONTROL, placed first) then P1.
// ---------------------------------------------------------------------------

test('spend-warnings P2 (CONTROL): exactly 3 fresh, overlapping receipts is AT the multi-spend threshold, not over it — no MULTI-SPEND warning', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src/feature.mjs'], at: isoAgo(1_000) },
      { agent_type: 'reviewer-b', files: ['src/feature.mjs'], at: isoAgo(2_000) },
      { agent_type: 'reviewer-c', files: ['src/feature.mjs'], at: isoAgo(3_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P2 control']);
    assert.equal(r.code, 0, `3 receipts must still succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /MULTI-SPEND/, `3 receipts is the control boundary, not over it — stderr=${flat(r.stderr)}`);

    const summary = JSON.parse(r.stdout);
    assert.deepEqual(summary.spend_warnings, [], `a clean run must expose spend_warnings as an EMPTY array (the key is present-as-empty, not absent) — got ${JSON.stringify(summary.spend_warnings)}`);
  } finally {
    cleanup();
  }
});

test('spend-warnings P1: 4 fresh, overlapping receipts trip MULTI-SPEND — warned on stderr AND in spend_warnings[], commit still succeeds and ledger is fully consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src/feature.mjs'], at: isoAgo(1_000) },
      { agent_type: 'reviewer-b', files: ['src/feature.mjs'], at: isoAgo(2_000) },
      { agent_type: 'reviewer-c', files: ['src/feature.mjs'], at: isoAgo(3_000) },
      { agent_type: 'reviewer-d', files: ['src/feature.mjs'], at: isoAgo(4_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P1']);
    assert.equal(r.code, 0, `4 receipts must not refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /MULTI-SPEND — 4 review receipts/, `stderr must name the count — stderr=${flat(r.stderr)}`);

    const summary = JSON.parse(r.stdout);
    assert.ok(Array.isArray(summary.spend_warnings) && summary.spend_warnings.length >= 1, `spend_warnings[] must carry the MULTI-SPEND entry — got ${JSON.stringify(summary.spend_warnings)}`);
    assert.ok(summary.spend_warnings.some((w) => /MULTI-SPEND/.test(w)), `spend_warnings[] must contain the SAME MULTI-SPEND text as stderr, not an unrelated placeholder — got ${JSON.stringify(summary.spend_warnings)}`);

    const trailers = readTrailerValues(dir);
    assert.equal(trailers.length, 4, 'one trailer per entry regardless of the advisory');

    assert.deepEqual(readLedger(dir), [], 'the ledger is still fully consumed — advisory only, never a refusal');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE OVERLAP: P4 (CONTROL) then P3.
// ---------------------------------------------------------------------------

test('spend-warnings P4 (CONTROL): a receipt whose files include the staged path (mixed with an unstaged path) has PARTIAL overlap — no DO-NOT-OVERLAP warning', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src/feature.mjs', 'src/unstaged-other.mjs'], at: isoAgo(1_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P4 control']);
    assert.equal(r.code, 0, `partial overlap must still succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /DO NOT OVERLAP/, `any overlap at all suppresses the warning — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

test('spend-warnings P3: a receipt whose files share NOTHING with the staged diff is warned by name, marked advisory-only, and still commits/consumes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src/elsewhere.mjs'], at: isoAgo(1_000) },
    ]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'spend P3']);
    assert.equal(r.code, 0, `zero-overlap receipt must not refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /RECEIPT FILES DO NOT OVERLAP THIS DIFF/, `stderr must carry the overlap warning — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /src\/elsewhere\.mjs/, `the warning must name the offending file — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /ADVISORY ONLY/, `the warning must mark itself advisory-only — stderr=${flat(r.stderr)}`);

    const summary = JSON.parse(r.stdout);
    assert.ok(summary.spend_warnings.some((w) => /DO NOT OVERLAP/.test(w)), `spend_warnings[] must contain the SAME overlap-warning text as stderr, not an unrelated placeholder — got ${JSON.stringify(summary.spend_warnings)}`);

    const afterHead = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(afterHead, beforeHead, 'a commit was still created despite the advisory');
    assert.deepEqual(readLedger(dir), [], 'the entry was still consumed despite the advisory');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// STALENESS (>12h): P6 (CONTROL) then P5.
// ---------------------------------------------------------------------------

test('spend-warnings P6 (CONTROL): a receipt only seconds old is not stale — no STALE RECEIPT warning', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src/feature.mjs'], at: isoAgo(5_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P6 control']);
    assert.equal(r.code, 0, `a fresh receipt must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /STALE RECEIPT/, `a 5-second-old receipt must not be flagged stale — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

test('spend-warnings P5: a receipt 30 hours old trips STALE RECEIPT, names its age and the 12h horizon, and still commits/consumes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src/feature.mjs'], at: isoAgo(30 * 3_600_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P5']);
    assert.equal(r.code, 0, `a stale receipt must not refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /STALE RECEIPT/, `stderr must carry the stale-receipt warning — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /30\.0h old/, `stderr must name the receipt's age in hours — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /12h/, `stderr must name the 12h staleness horizon — stderr=${flat(r.stderr)}`);

    const summary = JSON.parse(r.stdout);
    assert.ok(summary.spend_warnings.some((w) => /STALE RECEIPT/.test(w)), `spend_warnings[] must contain the SAME stale-receipt text as stderr, not an unrelated placeholder — got ${JSON.stringify(summary.spend_warnings)}`);

    assert.deepEqual(readLedger(dir), [], 'the stale entry was still consumed');
    assert.equal(readTrailerValues(dir).length, 1, 'the stale entry still gets its trailer');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AGE UNVERIFIABLE: P7 (at:'n/a' and at absent, both flagged distinctly).
// ---------------------------------------------------------------------------

test('spend-warnings P7: an unparseable `at` ("n/a") and a missing `at` key trip TWO DISTINCT RECEIPT AGE UNVERIFIABLE warnings (never two identical ones) in both channels, and both entries are still stamped and consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src/feature.mjs'], at: 'n/a' },
      { agent_type: 'reviewer-b', files: ['src/feature.mjs'] }, // `at` key entirely absent -> undefined
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P7']);
    assert.equal(r.code, 0, `unverifiable-age receipts must not refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const unverifiableCount = (r.stderr.match(/RECEIPT AGE UNVERIFIABLE/g) ?? []).length;
    assert.ok(unverifiableCount >= 2, `both the 'n/a' and the missing-'at' entry must be flagged unverifiable — saw ${unverifiableCount} — stderr=${flat(r.stderr)}`);

    // The two warnings must be DISTINCT: one quotes 'n/a' verbatim, a
    // SEPARATE one names the absent key's actual value (undefined) — a naive
    // implementation that defaults a missing `at` to the string 'n/a' before
    // formatting would produce two IDENTICAL "n/a" lines and fail the second
    // assertion below red.
    assert.match(r.stderr, /RECEIPT AGE UNVERIFIABLE[^\n]*["']n\/a["']/, `one warning must quote the 'n/a' value verbatim — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /RECEIPT AGE UNVERIFIABLE[^\n]*<absent>/, `a SEPARATE warning must identify the missing-'at' entry via the '<absent>' label, distinct from the 'n/a' one — stderr=${flat(r.stderr)}`);

    const summary = JSON.parse(r.stdout);
    assert.ok(summary.spend_warnings.some((w) => /RECEIPT AGE UNVERIFIABLE/.test(w) && /["']n\/a["']/.test(w)), `spend_warnings[] must carry the 'n/a' warning, same text as stderr — got ${JSON.stringify(summary.spend_warnings)}`);
    assert.ok(summary.spend_warnings.some((w) => /RECEIPT AGE UNVERIFIABLE/.test(w) && /<absent>/.test(w)), `spend_warnings[] must carry a SEPARATE warning for the missing-'at' entry via '<absent>', same text as stderr — got ${JSON.stringify(summary.spend_warnings)}`);

    assert.deepEqual(readLedger(dir), [], 'both entries were still consumed despite unverifiable age');
    assert.equal(readTrailerValues(dir).length, 2, 'both entries still get their trailer despite unverifiable age');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// P8: the never-a-refusal wall. RE-CUT BY RULING, not by accident (board
// 51d93c34 requirement 2 — file-scoped stamping). The old P8 stamped a receipt
// naming 'src/elsewhere.mjs' onto a commit staging 'src/feature.mjs', which is
// precisely the false attestation the new ruling removes; it must not be
// "repaired" back to that expectation.
// THE CLASS LIST CHANGED FOR A REASON: DO-NOT-OVERLAP is now reachable ONLY in
// the no-receipt-matches fallback, and DEFERRED only when some receipt DOES
// match, so the two are structurally mutually exclusive and can never fire in
// one run. P3 (unchanged) keeps the overlap-advisory arm; file-scoping S5 keeps
// the fallback arm. What P8 still owns is its real subject: no combination of
// advisories may refuse a commit.
// ---------------------------------------------------------------------------

test('spend-warnings P8: every simultaneously-reachable advisory class firing at once still never refuses — exit is not 1, each stamped entry gets one trailer, and the file-scope-deferred entry survives', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    const deferred = { agent_type: 'reviewer-b', files: ['src/elsewhere.mjs'], at: isoAgo(120_000) };
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src/feature.mjs'], at: isoAgo(60_000) },
      deferred,                                                                        // DEFERRED (file scope)
      { agent_type: 'reviewer-c', files: ['src/feature.mjs'], at: isoAgo(30 * 3_600_000) }, // STALE RECEIPT
      { agent_type: 'reviewer-d', files: ['src/feature.mjs'], at: 'n/a' },              // AGE UNVERIFIABLE
      { agent_type: 'reviewer-e', files: [], at: isoAgo(90_000) },                      // RECORDS NO FILES
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P8']);
    assert.notEqual(r.code, 1, `no combination of advisories may refuse the commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.code, 0, `the wall is a full success, not merely a non-1 exit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    assert.match(r.stderr, /MULTI-SPEND — 4 review receipts/, `4 stamped (a,c,d,e) is over the threshold — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /STALE RECEIPT/, `stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /RECEIPT AGE UNVERIFIABLE/, `stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /RECORDS NO FILES/, `stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /DEFERRED RECEIPT/, `the file-scoped withholding is disclosed — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /DO NOT OVERLAP/, `the overlap advisory is structurally unreachable once a receipt matches — stderr=${flat(r.stderr)}`);

    assert.equal(readTrailerValues(dir).length, 4, 'one trailer per STAMPED entry; the deferred one contributes none');
    assert.deepEqual(readLedger(dir), [deferred], 'the deferred receipt survives un-consumed; every stamped one is gone');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// P9: path normalization on the overlap check — non-ASCII + backslash paths.
// ---------------------------------------------------------------------------

test('spend-warnings P9: a receipt file path using backslashes still overlaps a staged non-ASCII path once normalized — no DO-NOT-OVERLAP warning', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/café.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: ['src\\café.mjs'], at: isoAgo(1_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P9']);
    assert.equal(r.code, 0, `normalized-overlap receipt must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(
      r.stderr,
      /DO NOT OVERLAP/,
      `a backslash-separated path must normalize to the same forward-slash, matching-bytes path as the staged file — stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// P10: a JSON-valid but HOSTILE `at` value must not crash the pipeline.
// ---------------------------------------------------------------------------

test('spend-warnings P10: a JSON-valid but hostile `at` ({toString:null}) must not crash the advisory pipeline — still commits, stamps, consumes, and warns age-unverifiable in both channels', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/elsewhere.mjs'], at: { toString: null } },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P10']);
    // EXPECTED FAILURE SHAPE under the named sabotage (interpolating raw
    // `${e.at}` into any advisory template): the object's own `toString` is
    // `null` and it inherits no primitive-producing `valueOf`, so template
    // coercion throws `TypeError: Cannot convert object to primitive value` —
    // the process crashes before (or instead of) emitting valid JSON on
    // stdout, `r.code` is nonzero, and every assertion below fails red.
    assert.equal(r.code, 0, `a hostile-but-JSON-valid 'at' must not crash the CLI — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /TypeError/, `no raw-interpolation crash may leak into stderr — stderr=${flat(r.stderr)}`);

    let summary;
    assert.doesNotThrow(() => { summary = JSON.parse(r.stdout); }, `stdout must remain valid JSON even for a hostile 'at' — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    assert.match(r.stderr, /RECEIPT AGE UNVERIFIABLE/, `an age-unverifiable-style warning must still fire on stderr for a non-string, unserializable 'at' — stderr=${flat(r.stderr)}`);
    assert.ok(summary.spend_warnings.some((w) => /RECEIPT AGE UNVERIFIABLE/.test(w)), `spend_warnings[] must carry the same age-unverifiable warning as stderr — got ${JSON.stringify(summary.spend_warnings)}`);

    assert.equal(readTrailerValues(dir).length, 1, 'the hostile entry still gets its trailer');
    assert.deepEqual(readLedger(dir), [], 'the hostile entry was still consumed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// P11: RECORDS NO FILES — an entry with an empty or entirely absent `files`.
// ---------------------------------------------------------------------------

test('spend-warnings P11: a receipt with files:[] and a receipt with files entirely absent both trip RECORDS NO FILES in both channels, and still commit/consume', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-a', files: [], at: isoAgo(1_000) },
      { agent_type: 'reviewer-b', at: isoAgo(2_000) }, // `files` key entirely absent
    ]);

    const r = runCommitReviewed(dir, ['-m', 'spend P11']);
    // EXPECTED FAILURE SHAPE under the named sabotage (an `entryFiles.length >
    // 0` guard that silently SKIPS the no-files case instead of warning):
    // neither count below reaches 2 (both stay at 0), and the two `>= 2`
    // assertions fail red — while the commit/consume assertions stay green,
    // isolating exactly the guard being pinned.
    assert.equal(r.code, 0, `a files-less receipt must not refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const stderrCount = (r.stderr.match(/RECORDS NO FILES/g) ?? []).length;
    assert.ok(stderrCount >= 2, `both the empty-array and the absent-'files' entry must be flagged — saw ${stderrCount} — stderr=${flat(r.stderr)}`);

    const summary = JSON.parse(r.stdout);
    const arrayCount = summary.spend_warnings.filter((w) => /RECORDS NO FILES/.test(w)).length;
    assert.ok(arrayCount >= 2, `spend_warnings[] must carry both RECORDS NO FILES entries, same text as stderr — got ${JSON.stringify(summary.spend_warnings)}`);

    assert.equal(readTrailerValues(dir).length, 2, 'both files-less entries still get their trailer');
    assert.deepEqual(readLedger(dir), [], 'both files-less entries were still consumed');
  } finally {
    cleanup();
  }
});
