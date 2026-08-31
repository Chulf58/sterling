// scripts/tests/commit-reviewed-file-scoping.test.mjs
//
// FILE-SCOPED STAMPING (board 51d93c34 requirement 2). Review receipts already
// record the files[] they reviewed; scripts/commit-reviewed.mjs used to ignore
// that field when stamping, so EVERY valid receipt landed on whatever happened
// to be staged and was then consumed. That forced concurrently-reviewed slices
// to commit as ONE unit (decision
// reviewed-set-commits-as-one-unit-until-receipts-are-file-scoped, c45b6ee4;
// measured instance: four same-session same-branch receipts covering THREE
// slices, all spent on commit cef717d).
//
// WHAT IS PINNED HERE:
//   - a receipt whose files[] INTERSECT the staged set is STAMPED;
//   - a receipt recording NO usable territory is ALWAYS STAMPED (an empty
//     files[] is the STRONGEST unverifiable-territory signal, never a
//     non-match) — see S4, which mutation-arm B proved was pinned by NOTHING;
//   - a receipt whose files[] match nothing staged, WHILE another receipt does
//     match, is DEFERRED: not stamped, not consumed, not deleted, disclosed by
//     name — see S2/S3;
//   - when NOTHING matches, the rule does not apply at all and every eligible
//     receipt is stamped exactly as before — see S5, the fallback, which is the
//     entire safety argument for shipping this on the merge-gate surface.
//
// NET INVARIANT (S6): the stamped set is always a strict SUBSET of the old
// behaviour's and is never empty while an eligible receipt exists. So this rule
// can only ever REMOVE a false attestation — it can never add a trailer, invent
// evidence, or turn a commit that succeeds today into a refusal.
//
// HARNESS PROVENANCE: everything from the imports down to `isoAgo` below is a
// verbatim copy of scripts/tests/commit-reviewed-spend-warnings.test.mjs
// LINES 52-120 (imports 52-58; root/CLI_PATH 60-61; GIT_SKIP 63-66; git() 68-72;
// makeRepo() 74-87; ledgerPath/writeLedger/readLedger 89-97; stageChange()
// 99-104; runCommitReviewed() 106-109; readTrailerValues() 111-114; flat 116-117;
// isoAgo 119-120). ONE deliberate deviation, harness-only and asserted by
// nothing: the mkdtemp prefix is 'sterling-commit-reviewed-file-scoping-' rather
// than 'sterling-commit-reviewed-spend-', so the two suites cannot collide in
// tmpdir. `runCommitReviewedEnv` (below) is NEW — S7 needs to plumb
// STERLING_SESSION_ID, which is the documented fixture seam the receipt-expiry
// mechanism reads (commit-reviewed.mjs currentSessionId()).

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-file-scoping-'));
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

// NEW (not in the spend-warnings harness): S7 must present a KNOWN current
// session so a receipt recording a different one reads FOREIGN. Env is the
// documented override commit-reviewed.mjs's currentSessionId() checks first,
// ahead of H1's .sterling/transient/session.json marker.
function runCommitReviewedEnv(dir, args, env) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// S1 (CONTROL, placed first): the pre-file-scoping behaviour, so a green S2
// cannot be produced by a CLI that simply stamps everything. Every receipt
// covers the staged file, so nothing is deferred and nothing survives.
// SABOTAGE: none needed — this arm must pass for the OPPOSITE reason to S2.
// ---------------------------------------------------------------------------
test('file-scoping S1 (CONTROL): two receipts that BOTH cover the staged file are both stamped and both consumed — no deferral', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000) },
      { agent_type: 'reviewer-security', files: ['src/laneA.mjs'], at: isoAgo(2_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'lane A, both reviewers']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /DEFERRED RECEIPT/, `nothing may be deferred when every receipt matches — stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir).sort(), ['reviewer-correctness', 'reviewer-security']);
    assert.deepEqual(readLedger(dir), [], 'both matching receipts are consumed');

    const summary = JSON.parse(r.stdout);
    assert.deepEqual(summary.deferred_receipts, [], 'deferred_receipts is present-as-EMPTY on a clean run, never absent');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S2: THE MEASURED SHAPE (decision c45b6ee4 — four receipts, three slices, all
// spent on one commit). Two lanes reviewed concurrently, only lane A staged.
// SABOTAGE: `stampEntries` -> `eligibleEntries` at commit-reviewed.mjs:563 and
// :781 -> two trailers and an emptied ledger; both assertions red.
// ---------------------------------------------------------------------------
test('file-scoping S2: with two disjoint-territory receipts, committing lane A stamps and consumes ONLY lane A — lane B survives, disclosed by name', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const laneB = { agent_type: 'reviewer-security', files: ['src/laneB.mjs'], at: isoAgo(2_000) };
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000) },
      laneB,
    ]);

    const r = runCommitReviewed(dir, ['-m', 'lane A only']);
    assert.equal(r.code, 0, `a scoped commit must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir), ['reviewer-correctness'], 'ONLY the receipt covering this diff is stamped — no false attestation for lane B');
    assert.deepEqual(readLedger(dir), [laneB], 'lane B survives BYTE-IDENTICAL: not stamped, not consumed, not deleted');

    assert.match(r.stderr, /DEFERRED RECEIPT/, `the withholding is disclosed, never silent — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /reviewer-security/, `the disclosure names the receipt — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /src\/laneB\.mjs/, `and the territory it actually reviewed — stderr=${flat(r.stderr)}`);

    const summary = JSON.parse(r.stdout);
    assert.deepEqual(summary.reviewed_by, ['reviewer-correctness'], 'the report claims only what was stamped');
    assert.ok(summary.deferred_receipts.some((d) => /reviewer-security/.test(d)), `deferred_receipts carries the same disclosure as stderr — got ${JSON.stringify(summary.deferred_receipts)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S3: the OTHER half of S2 — a deferred receipt is DEFERRED, not stranded. The
// whole point of leaving it un-consumed is that the commit staging its real
// territory can still spend it.
// SABOTAGE: consume from `eligibleEntries` in the S2 run -> lane B is gone and
// this second invocation refuses with the zero-entries guidance.
// ---------------------------------------------------------------------------
test('file-scoping S3: the receipt deferred by lane A is spent normally by the LATER commit that stages lane B — deferral is never stranding', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000) },
      { agent_type: 'reviewer-security', files: ['src/laneB.mjs'], at: isoAgo(2_000) },
    ]);
    assert.equal(runCommitReviewed(dir, ['-m', 'lane A']).code, 0);

    stageChange(dir, 'src/laneB.mjs');
    const r2 = runCommitReviewed(dir, ['-m', 'lane B']);
    assert.equal(r2.code, 0, `the deferred receipt must be spendable on its own slice — stdout=${r2.stdout} stderr=${flat(r2.stderr)}`);
    assert.deepEqual(readTrailerValues(dir), ['reviewer-security'], 'lane B commit carries exactly its own reviewer');
    assert.deepEqual(readLedger(dir), [], 'and NOW it is consumed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S4: THE UNPINNED RULE (measured: mutation arm B left the whole suite green).
// A receipt recording NO files is the STRONGEST unverifiable-territory signal,
// never "matches nothing" — H22's extractor legitimately records nothing for a
// real review ("do not modify X, only review it"). Withholding here would
// SILENTLY DESTROY merge-gate review evidence. Must be stamped even while
// scoping is actively deferring another receipt.
// SABOTAGE: `usableFiles(e).length === 0` -> `false` at commit-reviewed.mjs:400
// -> reviewer-blank is deferred; the trailer and ledger assertions go red.
// ---------------------------------------------------------------------------
test('file-scoping S4: a receipt recording NO files is stamped even while file-scoping is deferring another receipt — empty files[] is unverifiable, never a non-match', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const laneB = { agent_type: 'reviewer-security', files: ['src/laneB.mjs'], at: isoAgo(3_000) };
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000) },
      { agent_type: 'reviewer-blank', files: [], at: isoAgo(2_000) },
      { agent_type: 'reviewer-absent', at: isoAgo(2_500) },     // `files` key entirely absent
      { agent_type: 'reviewer-hostile', files: 'src/laneA.mjs', at: isoAgo(2_600) }, // non-array: unusable, not a crash
      laneB,
    ]);

    const r = runCommitReviewed(dir, ['-m', 'lane A + unattributed reviews']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(
      readTrailerValues(dir).sort(),
      ['reviewer-absent', 'reviewer-blank', 'reviewer-correctness', 'reviewer-hostile'],
      'every unattributed receipt is stamped alongside the matching one; only the attributed non-match is withheld'
    );
    assert.deepEqual(readLedger(dir), [laneB], 'exactly one receipt survives, and it is the attributed non-matching one');
    assert.match(r.stderr, /RECORDS NO FILES/, `the unverifiable-territory advisory still fires — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S5: THE FALLBACK — the entire safety argument for shipping this on the
// merge-gate surface. H22's files[] attribution is MEASURED unreliable (board
// 09e03d76: every receipt mis-attributed; research finding 289cd172: negated
// paths recorded, positively-asserted ones dropped, globs invisible). When NO
// receipt matches there is nothing to select on, so the rule must NOT fire —
// refusing there would brick the CLI and train --waive-reviews.
// SABOTAGE: drop `!fileScopingApplies ||` at commit-reviewed.mjs:400 -> the
// INTERNAL INVARIANT VIOLATED refusal fires, exit 1, every assertion red.
// ---------------------------------------------------------------------------
test('file-scoping S5 (FALLBACK): when NO eligible receipt matches the staged diff, file-scoping does not apply — every receipt is stamped and consumed exactly as before, never a refusal', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/elsewhere.mjs'], at: isoAgo(1_000) },
      { agent_type: 'reviewer-security', files: ['src/also-elsewhere.mjs'], at: isoAgo(2_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'nothing matches']);
    assert.equal(r.code, 0, `an all-non-matching ledger must NEVER refuse — a hard block here would brick the CLI on a known-unreliable signal — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readTrailerValues(dir).length, 2, 'both are stamped: no selection was possible');
    assert.deepEqual(readLedger(dir), [], 'and both are consumed, exactly as before file-scoping shipped');
    assert.doesNotMatch(r.stderr, /DEFERRED RECEIPT/, `nothing is deferred in the fallback — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /RECEIPT FILES DO NOT OVERLAP THIS DIFF/, `the pre-existing advisory still speaks here — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /ADVISORY ONLY/, `and still marks itself advisory — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S6: the never-easier property, asserted directly rather than inferred. No
// trailer may name a receipt that neither matches the diff nor is unattributed.
// SABOTAGE: push a synthetic agent_type into stampEntries -> red.
// ---------------------------------------------------------------------------
test('file-scoping S6: no stamped trailer ever names a receipt that both records territory AND misses this diff — the stamped set is a strict subset, never an invention', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000) },
      { agent_type: 'reviewer-security', files: ['src/laneB.mjs'], at: isoAgo(2_000) },
      { agent_type: 'reviewer-scope', files: ['src/laneC.mjs'], at: isoAgo(3_000) },
    ]);

    const r = runCommitReviewed(dir, ['-m', 'subset pin']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const trailers = readTrailerValues(dir);
    assert.ok(!trailers.includes('reviewer-security'), `a non-matching receipt must never appear as a trailer — got ${JSON.stringify(trailers)}`);
    assert.ok(!trailers.includes('reviewer-scope'), `nor the second one — got ${JSON.stringify(trailers)}`);
    assert.deepEqual(trailers, ['reviewer-correctness']);
    assert.ok(trailers.length >= 1, 'and the stamped set is never empty while an eligible receipt exists — a trailer-less commit would verify vacuously and land unreviewed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S7: the two withholdings are DIFFERENT and must stay reported apart — a
// foreign receipt (wrong session/branch, decision 0408b295) is not a
// file-scope deferral, and their remedies differ.
// SABOTAGE: merge deferredDisclosures into foreignDisclosures -> red.
// ---------------------------------------------------------------------------
test('file-scoping S7: a FOREIGN receipt and a file-scope DEFERRED receipt are disclosed through separate channels, and both survive un-consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const foreign = { agent_type: 'reviewer-foreign', files: ['src/laneA.mjs'], at: isoAgo(9 * 3_600_000), session_id: 'other-session', branch: 'main' };
    const deferred = { agent_type: 'reviewer-security', files: ['src/laneB.mjs'], at: isoAgo(2_000), session_id: 'this-session', branch: 'main' };
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000), session_id: 'this-session', branch: 'main' },
      foreign,
      deferred,
    ]);

    const r = runCommitReviewedEnv(dir, ['-m', 'foreign vs deferred'], { STERLING_SESSION_ID: 'this-session' });
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir), ['reviewer-correctness'], 'neither the foreign nor the deferred receipt is stamped');

    const summary = JSON.parse(r.stdout);
    assert.ok(summary.foreign_receipts.some((d) => /reviewer-foreign/.test(d)), `the foreign one is reported as FOREIGN — got ${JSON.stringify(summary.foreign_receipts)}`);
    assert.ok(!summary.foreign_receipts.some((d) => /reviewer-security/.test(d)), 'the deferred one is NOT reported as foreign — different cause, different remedy');
    assert.ok(summary.deferred_receipts.some((d) => /reviewer-security/.test(d)), `the deferred one is reported as DEFERRED — got ${JSON.stringify(summary.deferred_receipts)}`);
    assert.ok(!summary.deferred_receipts.some((d) => /reviewer-foreign/.test(d)), 'and the foreign one is NOT reported as deferred');

    const after = readLedger(dir);
    assert.equal(after.length, 2, `both withheld receipts survive — got ${JSON.stringify(after)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S8: the scoping DECISION normalizes paths, not merely the advisory. A
// backslash-spelled receipt path must MATCH, not be deferred — a cosmetic
// spelling difference must never withhold a real review's stamp.
// SABOTAGE: `stagedFiles.has(f)` (drop normalizePath) in touchesStaged at
// commit-reviewed.mjs:395 -> reviewer-correctness is deferred, red.
// ---------------------------------------------------------------------------
test('file-scoping S8: a backslash-spelled receipt path normalizes and MATCHES the staged path — path spelling never causes a deferral', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/café.mjs');
    const laneB = { agent_type: 'reviewer-security', files: ['src/laneB.mjs'], at: isoAgo(2_000) };
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src\\café.mjs'], at: isoAgo(1_000) },
      laneB,
    ]);

    const r = runCommitReviewed(dir, ['-m', 'normalized match']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir), ['reviewer-correctness'], 'the backslash path matched and was stamped');
    assert.deepEqual(readLedger(dir), [laneB], 'and only the genuinely disjoint receipt was deferred');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S9: THE DEFERRAL CLASS'S OWN FAILURE MODE (review, HIGH — closed at
// commit-reviewed.mjs:838). File scoping made `files` a PARTITION field, and
// the consume identity did not include it. The rule the consume block already
// states — every field that decides the partition must decide the consume — was
// therefore broken by the very feature built to stop review evidence being
// destroyed.
// THE SHAPE, which is exactly the concurrent-lane case this feature exists for:
// two reviewer-security dispatches in ONE message share agent_type AND the
// Start-millisecond `at`, and being same-session same-branch they share
// session_id/branch/base_sha too — so those five fields discriminate NOTHING.
// One records lane A, one lane B. Committing lane A stamps A and defers B; but
// `freshLedger.filter` claims the FIRST sameIdentity match, so with B ORDERED
// FIRST in the file, B is spliced out instead of A. Lane B's evidence is
// destroyed silently, "never consumed, never deleted" is broken, and A's
// receipt is then stamped onto the lane B commit through the no-match fallback:
// a trailer naming a review that never looked at that diff.
// Before file scoping this was harmless — both were stamped and the multiset
// consumed both. The DEFERRED class is what created the asymmetry.
// ORDERING IS LOAD-BEARING: the deferred receipt is written FIRST on purpose.
// With A first the buggy code happens to remove the right entry and the test
// would pass while the defect stood.
// SABOTAGE: revert the key list at commit-reviewed.mjs:838 to
// ['session_id', 'branch', 'base_sha'] -> the surviving entry is lane A's
// receipt rather than lane B's, reddening the deepEqual below. MEASURED: that
// sabotage leaves S1-S8 and all four other ledger suites green, so this is the
// only pin carrying the verdict.
// ---------------------------------------------------------------------------
test('file-scoping S9: two receipts identical in agent_type AND at AND session/branch/base_sha, differing ONLY in files[], consume the STAMPED one and leave the DEFERRED one byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    // Same agent_type, same Start-millisecond, same partition fields — a
    // genuine parallel-dispatch collision. files[] is the ONLY difference.
    const collidingAt = isoAgo(1_000);
    const deferredB = { agent_type: 'reviewer-security', files: ['src/laneB.mjs'], at: collidingAt, session_id: 'this-session', branch: 'main', base_sha: 'a'.repeat(40) };
    const stampedA = { agent_type: 'reviewer-security', files: ['src/laneA.mjs'], at: collidingAt, session_id: 'this-session', branch: 'main', base_sha: 'a'.repeat(40) };
    writeLedger(dir, [deferredB, stampedA]); // DEFERRED FIRST — see header

    const r = runCommitReviewedEnv(dir, ['-m', 'colliding identities, lane A'], { STERLING_SESSION_ID: 'this-session' });
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    assert.deepEqual(readTrailerValues(dir), ['reviewer-security'], 'exactly one trailer: only the lane A receipt was stamped');

    const after = readLedger(dir);
    assert.deepEqual(
      after,
      [deferredB],
      `the DEFERRED lane B receipt must survive BYTE-IDENTICAL and the STAMPED lane A receipt must be the one removed — a consume keyed on fields that cannot tell them apart destroys the wrong receipt: ${JSON.stringify(after)}`
    );
    assert.deepEqual(after[0].files, ['src/laneB.mjs'], 'and the survivor is unambiguously the lane B receipt, not lane A wearing the same identity');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S10 (CONTROL for S9, and the "still consume correctly" half): two receipts
// identical in EVERY field INCLUDING files[] share one partition verdict by
// construction, so both are stamped and the multiset splice must consume BOTH.
// Adding `files` to the identity key must not strand a genuine duplicate.
// SABOTAGE: replace the multiset splice with a Set-based `some()` consume ->
// one duplicate survives forever and the empty-ledger assertion reddens.
// ---------------------------------------------------------------------------
test('file-scoping S10 (CONTROL): two receipts identical in EVERY field including files[] are both stamped and BOTH consumed — the widened identity key strands no duplicate', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const collidingAt = isoAgo(1_000);
    const twin = { agent_type: 'reviewer-security', files: ['src/laneA.mjs'], at: collidingAt, session_id: 'this-session', branch: 'main', base_sha: 'a'.repeat(40) };
    writeLedger(dir, [{ ...twin }, { ...twin }]);

    const r = runCommitReviewedEnv(dir, ['-m', 'true duplicates'], { STERLING_SESSION_ID: 'this-session' });
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir), ['reviewer-security', 'reviewer-security'], 'no dedupe: one trailer per entry');
    assert.deepEqual(readLedger(dir), [], 'BOTH duplicates are consumed — neither survives forever');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S11: the widened key must be SHAPE-STABLE across every files[] form, since a
// key that mis-compares would either strand a stamped receipt (leak, board
// 09e03d76) or destroy a deferred one (S9). Both sides are parsed from the SAME
// file, so: absent normalizes to null on both sides and MATCHES; absent vs []
// correctly does NOT match; [] vs [] and ['x'] vs ['x'] deep-equal; a non-array
// string compares by string equality. S4's fixture already exercises all three
// unusable shapes; this asserts the consume half of them explicitly.
// SABOTAGE: make identityField return `e[k]` raw (dropping the undefined ->
// null normalization) -> the absent-files receipt no longer matches itself
// between the two reads, is never consumed, and the ledger is non-empty: red.
// ---------------------------------------------------------------------------
test('file-scoping S11: receipts whose files[] is absent, empty, or a non-array string are each consumed correctly once stamped — the widened identity key is shape-stable', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    // All unattributed (so all stamped via the always-stamp rule), each a
    // different files[] shape, all sharing agent_type and `at` so the key is
    // forced to discriminate on files alone.
    const collidingAt = isoAgo(1_000);
    writeLedger(dir, [
      { agent_type: 'reviewer-shape', at: collidingAt },                          // files absent
      { agent_type: 'reviewer-shape', files: [], at: collidingAt },               // files empty
      { agent_type: 'reviewer-shape', files: 'src/laneA.mjs', at: collidingAt },  // files non-array
    ]);

    const r = runCommitReviewed(dir, ['-m', 'files[] shapes']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readTrailerValues(dir).length, 3, 'every unattributed receipt is stamped');
    assert.deepEqual(readLedger(dir), [], 'and every one is consumed — absent, empty and non-array each match themselves across the two reads');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S12 — MUTATION-EXPOSED GAP, decision 57984926 (review-ledger-v2-lifecycle-
// refuse-flip-and-external-review-design), cited 2026-08-31: no frozen pin in
// this file or its siblings ever fed a v2-SHAPED ledger entry through
// commit-reviewed's eligibility/file-scoping path — every S1-S11 fixture
// above is flat v1. Sabotaging the adapter's `territory.files` mapping to
// `[]` left all 84 existing tests green; only a live probe's soft RECORDS NO
// FILES warning caught it. This pin closes that gap directly.
// EXPECTED STATE: GREEN today (the adapter already reads v2 correctly).
// SABOTAGE: map `territory.files` to `[]` when reading a v2 entry instead of
// the real declared array — the receipt's usable-files count collapses to
// zero, RECORDS NO FILES fires on stderr, and the `doesNotMatch` assertion
// below goes red while every OTHER assertion in this file (which only ever
// exercises flat v1 entries) stays green — that asymmetry is exactly why
// this pin exists as its own test rather than folding into an existing one.
// ---------------------------------------------------------------------------
test('file-scoping S12: a v2-shaped entry (schema_version:2, territory.files, identity{session_id,branch,base_sha}) is selected by file-intersection and stamped — no RECORDS NO FILES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const headSha = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      {
        schema_version: 2,
        entry_id: 'e2f1a1a0-0000-4000-8000-000000000001',
        kind: 'roster_receipt',
        status: 'active',
        started_at: isoAgo(1_000),
        finished_at: isoAgo(500),
        reviewer: { agent_type: 'reviewer-correctness', model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
        identity: { session_id: 'this-session', branch: 'main', base_sha: headSha },
        territory: { files: ['src/laneA.mjs'], source: 'review-territory', attribution: 'block' },
        content_evidence: { status: 'complete', blobs: {}, absent_paths: [], truncated_of: null, failure_reason: null },
        disposition: null,
      },
    ]);

    const r = runCommitReviewedEnv(dir, ['-m', 'v2 entry, file-intersection'], { STERLING_SESSION_ID: 'this-session' });
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir), ['reviewer-correctness'], 'the v2 entry is selected by file-intersection and stamped exactly as a flat entry would be');
    assert.deepEqual(readLedger(dir), [], 'the v2 entry is consumed');
    assert.doesNotMatch(r.stderr, /RECORDS NO FILES/, `a correctly-read territory.files must never trip the no-files advisory — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// S13 — MED-2, Codex outside-family review thread 01a0586b + decision 57984926
// (cited 2026-08-31): a STRUCTURALLY-DEFICIENT v2 entry — carrying
// schema_version:2 but missing entry_id/started_at/identity (the fields a
// real promotion always sets, per h22-ledger-v2-entry.test.mjs's V2-1) — must
// never be upgraded into a spendable receipt just because it claims v2. It
// must be withheld and disclosed, never silently stamped/consumed as though
// it were a complete entry.
// Mirrors scripts/tests/h22-receipt-expiry.test.mjs's B1/B2 "either reading"
// pattern for the lone-receipt exit-code ambiguity: this pin does NOT assert
// a fixed exit code (zero-eligible-receipts refusal vs. bare success is an
// open question that file already discloses, not this pin's to resolve) — it
// asserts the INVARIANT that holds under either reading.
// EXPECTED RED until the coder adds the structural completeness check.
// SABOTAGE: treat `schema_version === 2` alone as sufficient to consider an
// entry eligible/spendable (skip checking entry_id/started_at/identity
// presence) — the deficient entry gets stamped and consumed, flipping the
// `after.length` assertion (0 instead of 1) red.
// ---------------------------------------------------------------------------
test('file-scoping S13 (MED-2): a structurally-deficient v2 entry ({schema_version:2, reviewer:{agent_type}} only — no entry_id/started_at/identity) must NOT be stamped or consumed, and is disclosed — holds under either reading of the lone-receipt exit-code ambiguity', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    writeLedger(dir, [{ schema_version: 2, reviewer: { agent_type: 'reviewer-security' } }]);

    const r = runCommitReviewed(dir, ['-m', 'structurally-deficient v2']);

    if (r.code === 0) {
      assert.deepEqual(readTrailerValues(dir), [], 'if the commit succeeds bare, the deficient entry must never earn a Reviewed-By-Agent trailer');
    }
    const after = readLedger(dir);
    assert.equal(after.length, 1, 'the deficient entry survives — never silently spent as a real v2 receipt, regardless of exit code');
    assert.match(r.stderr, /reviewer-security/, `the withheld entry is named in the disclosure, not silently dropped — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});
