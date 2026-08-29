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

function runCommitReviewed(dir, args = []) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => (s ?? '').replace(/\r?\n/g, ' | ');

// Date.now()-relative ISO timestamps, never hardcoded dates — both directions.
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const isoIn = (msFuture) => new Date(Date.now() + msFuture).toISOString();

const VALID_SHA = 'a'.repeat(40);

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
// SABOTAGE: change the in-range branch to ALSO emit COMPLETED_AT OUT OF RANGE
// unconditionally (or widen the >12h STALE horizon check to fire on any
// completed_at) — both `doesNotMatch` assertions below go red.
// ---------------------------------------------------------------------------
test('completed_at (b) CONTROL: a completed_at legitimately between at and now, on a fresh receipt, trips NEITHER warning', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      {
        agent_type: 'reviewer-control',
        files: ['src/feature.mjs'],
        at: isoAgo(5 * 3_600_000),
        reviewed_state: { completed_at: isoAgo(2 * 3_600_000), blobs: { 'src/feature.mjs': VALID_SHA } },
      },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'completed_at control']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
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
// ---------------------------------------------------------------------------
test('completed_at (a): an out-of-range completed_at (+400h future) is discarded — horizon falls back to `at` (30h ago), both warnings fire', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      {
        agent_type: 'reviewer-outofrange',
        files: ['src/feature.mjs'],
        at: isoAgo(30 * 3_600_000),
        reviewed_state: { completed_at: isoIn(400 * 3_600_000), blobs: { 'src/feature.mjs': VALID_SHA } },
      },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'completed_at out of range']);
    assert.equal(r.code, 0, `an out-of-range completed_at must not refuse the commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /COMPLETED_AT OUT OF RANGE/, `stderr must flag the discarded completed_at — this is the assertion that proves the field was actually READ, not silently skipped — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /STALE RECEIPT/, `stderr must still carry the staleness warning, computed from the fallback horizon — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /30\.0h/, `the staleness must be computed from \`at\` (30h ago), not the discarded future completed_at (which would read ~0.0h) — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) NO CONTENT EVIDENCE: reviewed_state present but blobs:{} (empty).
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
// (d) NO CONTENT EVIDENCE: reviewed_state.blobs present with a value that
// fails the 40-hex filter ('not-a-sha').
// SABOTAGE (inferred, not implementer-verified): loosen the 40-hex filter
// regex (e.g. `/^[0-9a-f]{1,40}$/i` instead of requiring exactly 40 hex
// chars, or drop the filter and accept any truthy string) — 'not-a-sha'
// passes as "usable" and the `/NO CONTENT EVIDENCE/` match below goes red.
// ---------------------------------------------------------------------------
test('completed_at (d): reviewed_state.blobs present with a non-40-hex value trips NO CONTENT EVIDENCE', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [
      {
        agent_type: 'reviewer-badsha',
        files: ['src/feature.mjs'],
        at: isoAgo(1_000),
        reviewed_state: { blobs: { 'src/feature.mjs': 'not-a-sha' } },
      },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'non-hex blob sha']);
    assert.equal(r.code, 0, `a non-hex-blob receipt must not refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /NO CONTENT EVIDENCE/, `stderr must flag the unusable ('not-a-sha') blob value — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (e) AGGREGATION: two receipts, one carrying a valid 40-hex blob and one
// with no reviewed_state at all — the warning names the count ("1 of the 2")
// and identifies ONLY the second (offending) receipt.
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
        reviewed_state: { blobs: { 'src/feature.mjs': VALID_SHA } },
      },
      {
        agent_type: 'reviewer-noevidence',
        files: ['src/feature.mjs'],
        at: isoAgo(2_000),
        // no reviewed_state key at all
      },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'one good, one missing reviewed_state']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /NO CONTENT EVIDENCE/, `stderr must carry the aggregated warning — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /1 of the 2/, `the warning must name the count of offending receipts out of the total — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /reviewer-noevidence/, `the warning must name the offending receipt — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /NO CONTENT EVIDENCE[^\n]*reviewer-goodblob/, `the receipt WITH usable content evidence must never be named by this warning — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});
