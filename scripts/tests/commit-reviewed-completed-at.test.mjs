// COMMIT-REVIEWED — completed_at RANGE-CHECK + CONTENT-EVIDENCE advisories.
//
// Authored from the dispatch SPEC (an independent reviewer found `grep` over
// scripts/tests/ returns ZERO hits for `COMPLETED_AT OUT OF RANGE`, `NO
// CONTENT EVIDENCE`, `REVIEWED BYTES CHANGED`), NOT from
// scripts/commit-reviewed.mjs's internals — H4 read wall: this file's author
// never read that script. The spec below is as given by the launching agent,
// who reports having run all five arms green locally against the landed
// implementation.
//
// Spec under test:
//   1. COMPLETED_AT RANGE CHECK: a ledger entry's `completed_at`, when
//      present, must fall between its `at` and "now". An out-of-range
//      `completed_at` (e.g. hundreds of hours in the future) is DISCARDED
//      entirely — the staleness horizon then falls back to `at` — rather than
//      clamped to `now`. (Clamping was tried first and MEASURED NOT TO WORK:
//      a 30h-old receipt with a future `completed_at` clamped to `now` read
//      as 0.0h fresh, silently hiding real staleness — this is why discard,
//      not clamp, is the correct fix, and why arm (a) below is load-bearing.)
//      When `completed_at` legitimately falls inside [`at`, now], neither the
//      COMPLETED_AT OUT OF RANGE nor the STALE RECEIPT (12h horizon, per the
//      spend-warnings suite) warning fires for a fresh receipt.
//   2. CONTENT-EVIDENCE CHECK: a ledger entry's `reviewed_state.blobs` records
//      the git blob shas of files the reviewer actually read content for. An
//      entry whose `blobs` is present-but-empty, OR whose every blob value
//      fails a 40-hex-character filter (i.e. carries no USABLE sha), trips a
//      NO CONTENT EVIDENCE warning. Aggregated across a ledger, the warning
//      names the count ("1 of the 2") and identifies ONLY the offending
//      entries by name — never the entries that do carry usable content
//      evidence.
//
// Fixture idiom copied VERBATIM from
// scripts/tests/commit-reviewed-spend-warnings.test.mjs (makeRepo/writeLedger/
// stageChange/runCommitReviewed/readTrailerValues/flat/isoAgo conventions),
// reproduced standalone per the same convention
// scripts/tests/commit-reviewed-file-scoping.test.mjs uses relative to its own
// base spec, plus a new `isoIn` helper (the mirror of `isoAgo` into the
// future) needed for arm (a)'s "+400h" fixture.
//
// Every ledger entry below stages and names the SAME file it claims to
// review, so file-scoping (board 51d93c34) can never defer it out of this
// run — the advisories under test here fire over entries that ARE eligible
// to be stamped/consumed this run, exactly like the spend-warnings suite.
//
// ---------------------------------------------------------------------------
// FIXTURE REVISION 2026-08-31 — decision 57984926 (slug review-ledger-v2-
// lifecycle-refuse-flip-and-external-review-design) §2 REFUSE FLIP, which
// executes the REFUSE-LATER half of user ruling b0ad640d. §2 verbatim:
//   "a mismatch on any staged/target path the receipt covers REFUSES ...
//    nothing consumed; a covered path whose evidence is partial/truncated/
//    INCONSISTENT also refuses ... v1 receipts with usable blobs are ENFORCED
//    (grandfather only genuinely absent evidence — schema absence does not
//    imply blob absence)".
// NOTHING ABOUT THIS SUITE'S SUBJECT CHANGED — it still specifies the
// completed_at range check and the content-evidence advisories. What changed
// is that its FIXTURES used to trip the new refusal INCIDENTALLY: a
// placeholder blob value ('a'.repeat(40)) is a USABLE-BUT-MISMATCHING sha, so
// under the flip it is a byte mismatch on a covered staged path and refuses
// the commit before the advisory under test can be judged. The placeholder
// constant is therefore GONE; arms (b), (a) and (e) now record the REAL blob
// sha of the staged bytes via `git hash-object` (the
// commit-reviewed-bytes-refuse.test.mjs idiom), which is what "the reviewer
// read exactly these bytes" actually looks like and keeps each arm's own
// assertions reachable. Arm (d) records an UNUSABLE value, which §2's
// inconsistent-evidence clause now refuses, so its expectation is inverted
// (see its header). Arm (c) is untouched: genuinely absent evidence
// (blobs:{}) is grandfathered by §2 clause 3 and still commits.
// The refusal behaviour ITSELF is pinned by scripts/tests/
// commit-reviewed-bytes-refuse.test.mjs (22/22 green) and is deliberately NOT
// re-specified here — this suite only has to survive it.
// ---------------------------------------------------------------------------

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-completed-at-'));
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

// The REAL blob sha of a path as it currently sits in the index/worktree
// (stageChange writes then `git add -A`, so the two always agree here).
// Idiom copied from commit-reviewed-bytes-refuse.test.mjs's `stagedBlob`.
// USING THIS INSTEAD OF A PLACEHOLDER IS LOAD-BEARING under decision
// 57984926 §2: a 40-hex placeholder is USABLE evidence that MISMATCHES, which
// now refuses the commit and makes every advisory assertion in the arm
// unreachable. The fixture guard below is what keeps a silent git change from
// turning this helper into another placeholder.
function stagedBlob(dir, relPath) {
  const sha = git(dir, ['hash-object', relPath]);
  assert.match(sha, /^[0-9a-f]{40}$/, `fixture guard: hash-object must produce a usable 40-hex sha for ${relPath}, got ${sha}`);
  return sha;
}

function runCommitReviewed(dir, args = []) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => (s ?? '').replace(/\r?\n/g, ' | ');

// Date.now()-relative ISO timestamps, never hardcoded dates — both directions.
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const isoIn = (msFuture) => new Date(Date.now() + msFuture).toISOString();

// (The former `VALID_SHA = 'a'.repeat(40)` placeholder is deliberately gone —
// see the FIXTURE REVISION header. Under decision 57984926 §2 it is not a
// harmless stand-in but a usable blob sha that mismatches the staged bytes,
// i.e. exactly the shape the flip refuses. Use `stagedBlob(dir, path)`.)

// ---------------------------------------------------------------------------
// (b) CONTROL, placed first: a legitimate completed_at between `at` and now,
// on a fresh (well under the 12h horizon) receipt — neither warning fires.
// This is the arm that rules out "the checker warns on every receipt
// carrying a completed_at at all" as an explanation for (a) going green.
// FIELD PLACEMENT IS LOAD-BEARING (corrected after a real run — see (a)'s
// header): the CLI reads `reviewed_state.completed_at`, a nested field, NOT
// a top-level ledger-entry `completed_at`. A top-level `completed_at` parses
// to NaN internally and is silently skipped, which would make this control
// pass VACUOUSLY (neither warning fires because the field was never read at
// all, not because it was legitimately in range) — the exact same trap (a)
// fell into. It must be a STRING (`.toISOString()`), not a Date object.
// FIXTURE UPDATED for decision 57984926 §2 (the expectation is UNCHANGED):
// the recorded blob is now the REAL staged blob sha, not a placeholder. With
// a placeholder this control refused (exit 1) on a byte mismatch and could no
// longer rule anything out — a control that dies for an unrelated reason is
// worse than no control. Matching bytes are also what a genuine in-range
// review looks like, so the arm is now honest end to end.
// SABOTAGE: change the in-range branch to ALSO emit COMPLETED_AT OUT OF RANGE
// unconditionally (or widen the >12h STALE horizon check to fire on any
// completed_at) — the COMPLETED_AT / STALE RECEIPT `doesNotMatch` assertions
// below go red. The third `doesNotMatch` (REVIEWED BYTES) has its OWN
// sabotage and is not defence in depth for those two: invert the blob
// comparison so a MATCHING sha refuses (the same one-liner
// commit-reviewed-bytes-refuse.test.mjs X0 names) — only that assertion, plus
// the exit-0 one, goes red. Two assertions, two distinct guards.
// ---------------------------------------------------------------------------
test('completed_at (b) CONTROL: a completed_at legitimately between at and now, on a fresh receipt with matching reviewed bytes, trips NEITHER warning', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      {
        agent_type: 'reviewer-control',
        files: ['src/feature.mjs'],
        at: isoAgo(5 * 3_600_000),
        reviewed_state: {
          completed_at: isoAgo(2 * 3_600_000),
          blobs: { 'src/feature.mjs': stagedBlob(dir, 'src/feature.mjs') },
        },
      },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'completed_at control']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /REVIEWED BYTES/, `the reviewed bytes MATCH the staged bytes, so decision 57984926 §2's refusal must never fire here — if it does, this control is dead and (a) proves nothing — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /COMPLETED_AT OUT OF RANGE/, `a legitimately in-range completed_at must not be flagged — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /STALE RECEIPT/, `a receipt completed 2h ago is well under the 12h horizon — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (a) THE LOAD-BEARING ARM: an out-of-range completed_at (+400h future) is
// DISCARDED, so the staleness horizon falls back to `at` (30h ago) — both
// COMPLETED_AT OUT OF RANGE and STALE RECEIPT (naming ~30.0h) must fire.
// FIELD PLACEMENT + TYPE ARE LOAD-BEARING (found by a real run, not by
// reading the code — H4 denies that): the CLI reads `reviewed_state.
// completed_at` (nested), and only when it is a STRING `Date.parse` accepts
// — commit-reviewed.mjs:860-862 collapses a Date object, a number, or a
// missing/top-level field to NaN and SILENTLY skips the out-of-range guard
// (:888 is gated on `!Number.isNaN(rawCompletedMs)`). A first draft of this
// arm put `completed_at` at the TOP LEVEL of the ledger entry; it passed 2 of
// 3 assertions (STALE RECEIPT, 30.0h) while COMPLETED_AT OUT OF RANGE never
// fired — a HOLLOW pin on the very property this arm exists to specify,
// because `completed_at` was never read at all and the "fallback" it
// exercised was actually "there was never anything to discard". Fixed here
// to nest it under `reviewed_state` as `.toISOString()`.
// ALL THREE ASSERTIONS BELOW ARE LOAD-BEARING TOGETHER, NOT INDEPENDENTLY:
// STALE RECEIPT + 30.0h alone are satisfiable by an implementation that never
// reads completed_at at all (that is exactly the bug just described); only
// the COMPLETED_AT OUT OF RANGE assertion proves the discard path itself ran.
// Do not "simplify" this arm down to the staleness pair — that reintroduces
// the hollow shape this comment exists to prevent.
// SABOTAGE (implementer-stated): change `completedMs = NaN` to `completedMs =
// rawCompletedMs` at the point completed_at is validated — the out-of-range
// value is no longer discarded, the staleness horizon reads from the future
// completed_at instead of `at`, computes ~0h fresh, and the STALE RECEIPT
// assertion below goes red (this was MEASURED: clamping to `now` produces the
// identical failure, since clamped-to-now is also ~0h fresh).
// FIXTURE UPDATED for decision 57984926 §2 (the expectation is UNCHANGED, and
// deliberately so): the recorded blob is now the REAL staged blob sha. The
// placeholder made this arm refuse on a BYTE mismatch, which is a different
// subject entirely — and a refusal that fires before the horizon is computed
// would have made the exit-0 assertion red for a reason having nothing to do
// with completed_at. Keeping exit 0 here is itself load-bearing: a STALE
// receipt is a WARNING, never a refusal (§2 flips only the reviewed-BYTES
// verdict), so this arm also pins that the flip did not silently promote the
// staleness advisory into a refusal.
// ---------------------------------------------------------------------------
test('completed_at (a): an out-of-range completed_at (+400h future) is discarded — horizon falls back to `at` (30h ago), both warnings fire, and staleness still WARNS rather than refusing (decision 57984926 §2 flips bytes only)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      {
        agent_type: 'reviewer-outofrange',
        files: ['src/feature.mjs'],
        at: isoAgo(30 * 3_600_000),
        reviewed_state: {
          completed_at: isoIn(400 * 3_600_000),
          blobs: { 'src/feature.mjs': stagedBlob(dir, 'src/feature.mjs') },
        },
      },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'completed_at out of range']);
    assert.equal(r.code, 0, `neither an out-of-range completed_at nor a 30h-stale receipt may refuse the commit — only a reviewed-BYTES mismatch does that (decision 57984926 §2) — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /COMPLETED_AT OUT OF RANGE/, `stderr must flag the discarded completed_at — this is the assertion that proves the field was actually READ, not silently skipped — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /STALE RECEIPT/, `stderr must still carry the staleness warning, computed from the fallback horizon — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /30\.0h/, `the staleness must be computed from \`at\` (30h ago), not the discarded future completed_at (which would read ~0.0h) — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) NO CONTENT EVIDENCE: reviewed_state present but blobs:{} (empty).
// UNCHANGED by decision 57984926 §2 — an empty blobs map is GENUINELY ABSENT
// evidence, which clause 3 grandfathers, so this arm still commits (exit 0)
// with the advisory. IT IS ALSO (d)'s CONTROL, and (d) says so: (c) commits
// and (d) refuses through the same harness on the same staged file, which is
// what proves (d)'s refusal comes from PRESENT-but-unusable evidence rather
// than from "this CLI refuses anything it cannot verify". Do not delete or
// weaken this arm without re-reading (d).
// SABOTAGE (inferred, not implementer-verified — the exact call site was not
// disclosed for this arm): change the "no usable blob shas" guard from
// `Object.keys(usableBlobs).length === 0` to `false` (never fires on an empty
// blobs object) — the `/NO CONTENT EVIDENCE/` match below goes red.
// ---------------------------------------------------------------------------
test('completed_at (c): reviewed_state.blobs present but empty trips NO CONTENT EVIDENCE', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      {
        agent_type: 'reviewer-emptyblobs',
        files: ['src/feature.mjs'],
        at: isoAgo(1_000),
        reviewed_state: { blobs: {} },
      },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'empty blobs']);
    assert.equal(r.code, 0, `an empty-blobs receipt must not refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /NO CONTENT EVIDENCE/, `stderr must flag the empty reviewed_state.blobs — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) PRESENT-BUT-UNUSABLE EVIDENCE ON A COVERED STAGED PATH NOW REFUSES.
// EXPECTATION INVERTED by decision 57984926 §2 (was: commits with a NO
// CONTENT EVIDENCE warning). §2's inconsistent-evidence clause — "a covered
// path whose evidence is partial/truncated/INCONSISTENT also refuses" —
// governs a value that is RECORDED for a staged path but carries no usable
// sha: §2 grandfathers "only genuinely ABSENT evidence", and 'not-a-sha' is
// present, not absent. (commit-reviewed-bytes-refuse.test.mjs C2 pinned this
// same shape as an either-reading AMBIGUITY at authoring time; the launching
// conductor adjudicated it to the refuse reading, and that suite's C2 stays
// green under it because its refuse branch is the one that runs.)
// THE ARM'S SUBJECT IS UNCHANGED — present-but-unusable content evidence is
// NEVER SILENTLY ACCEPTED AS VERIFIED. Only the sanction moved, from warn to
// refuse, so the pin follows it rather than being deleted.
// ITS CONTROL IS ARM (c), IMMEDIATELY ABOVE, and it is load-bearing: (c)
// stages the same file through the same harness with `blobs: {}` and COMMITS
// (exit 0). So a green refusal here cannot be explained by "this CLI refuses
// every receipt it cannot verify" — genuinely absent evidence still commits;
// only PRESENT-but-unusable evidence refuses. Read (c) and (d) as one pair.
// WHAT IS DELIBERATELY NOT ASSERTED: the exact refusal wording, and which
// internal branch produced it. An unusable value can never equal a real blob
// sha, so no exit code can distinguish "refused because the value is
// unusable" from "refused because it compared unequal" — that discrimination
// lives in the message, and message wording for this class is the
// bytes-refuse suite's territory (C2), not this suite's. The disclosure
// assertion below therefore accepts either vocabulary while still forbidding
// the one outcome that matters: a silent refusal that says nothing about the
// evidence at all.
// SABOTAGE: grandfather any receipt whose covered staged path has no USABLE
// sha (i.e. treat present-but-unusable as absent, routing 'not-a-sha' down
// clause 3's genuinely-absent path) — the commit lands, exit 0, and the
// `r.code === 1` / HEAD-unmoved / ledger-byte-identical assertions all go red.
// SECOND SABOTAGE (disclosure half): refuse but print nothing about the
// evidence (drop both the NO CONTENT EVIDENCE advisory and the REVIEWED BYTES
// anchor for this class) — exit stays 1 and only the disclosure assertion
// goes red, which is the half that pins "never SILENTLY".
// ---------------------------------------------------------------------------
test('completed_at (d): reviewed_state.blobs present with a non-40-hex value on a STAGED covered path REFUSES and discloses the unusable evidence — decision 57984926 §2 inconsistent-evidence clause (was: NO CONTENT EVIDENCE warning + commit)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      {
        agent_type: 'reviewer-badsha',
        files: ['src/feature.mjs'],
        at: isoAgo(1_000),
        reviewed_state: { blobs: { 'src/feature.mjs': 'not-a-sha' } },
      },
    ]);
    const before = readFileSync(ledgerPath(dir), 'utf8');

    const r = runCommitReviewed(dir, ['-m', 'non-hex blob sha']);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `an unusable blob value must never crash the CLI — stderr=${flat(r.stderr)}`);
    assert.equal(r.code, 1, `present-but-unusable evidence on a covered staged path must REFUSE (decision 57984926 §2) — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit was created');
    assert.equal(readFileSync(ledgerPath(dir), 'utf8'), before, 'NOTHING consumed — the ledger file is byte-identical after the refusal');
    assert.match(
      r.stderr,
      /NO CONTENT EVIDENCE|REVIEWED BYTES/,
      `the unusability must be DISCLOSED, never a bare refusal — this is the half that pins "present-but-unusable evidence is never silently accepted" — stderr=${flat(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (e) AGGREGATION: two receipts, one carrying a valid 40-hex blob and one
// with no reviewed_state at all — the warning names the count ("1 of the 2")
// and identifies ONLY the second (offending) receipt.
// FIXTURE UPDATED for decision 57984926 §2 (the expectation is UNCHANGED):
// the good receipt's blob is now the REAL staged blob sha instead of a
// placeholder, so it is genuinely "the reviewer read these bytes" and the
// commit still succeeds. The grandfathered half is untouched — §2 clause 3
// grandfathers "only genuinely absent evidence", and reviewer-noevidence
// carries no reviewed_state at all, so it still commits and is still the one
// receipt the advisory names. THAT PAIRING IS ALSO THE ARM'S CONTROL: one
// receipt with usable+matching evidence and one with none both pass through
// the same run, so "1 of the 2" cannot be produced by a mode that refuses or
// flags everything.
// SABOTAGE (inferred, not implementer-verified): report the raw entry count
// instead of the offending subset (e.g. always print "2 of the 2", or name
// both agent_types instead of only the offending one) — the `/1 of the 2/`
// match, or the exclusivity check that reviewer-goodblob is absent from the
// warning, goes red.
// ---------------------------------------------------------------------------
test('completed_at (e): of two receipts, one with a valid blob and one with no reviewed_state, the warning says "1 of the 2" and names ONLY the offending one', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      {
        agent_type: 'reviewer-goodblob',
        files: ['src/feature.mjs'],
        at: isoAgo(1_000),
        reviewed_state: { blobs: { 'src/feature.mjs': stagedBlob(dir, 'src/feature.mjs') } },
      },
      {
        agent_type: 'reviewer-noevidence',
        files: ['src/feature.mjs'],
        at: isoAgo(2_000),
        // no reviewed_state key at all
      },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'one good, one missing reviewed_state']);
    assert.equal(r.code, 0, `usable+matching evidence beside genuinely ABSENT evidence must still commit under decision 57984926 §2 (grandfathering clause) — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /NO CONTENT EVIDENCE/, `stderr must carry the aggregated warning — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /1 of the 2/, `the warning must name the count of offending receipts out of the total — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /reviewer-noevidence/, `the warning must name the offending receipt — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /NO CONTENT EVIDENCE[^\n]*reviewer-goodblob/, `the receipt WITH usable content evidence must never be named by this warning — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});
