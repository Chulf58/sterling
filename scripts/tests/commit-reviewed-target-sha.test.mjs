// COMMIT-REVIEWED CLI — `--target-sha` AMEND MODE (decision
// post-hoc-review-receipts-target-sha-amend, knowledge_get
// a899d6cc-0352-497f-ada5-f1accb643619; board 51d93c34 requirement 1).
//
// SPEC-ONLY, red-first, written from the DECISION RECORD (opened via
// knowledge_get, quoted in the launching brief's contract G1-G7) and the
// launching agent's contract text. scripts/commit-reviewed.mjs's --target-sha
// mode DOES NOT EXIST YET — this file was authored WITHOUT reading that
// script's internals beyond the CLI/refusal conventions already visible in
// its own test suite (H4 read wall honored: no Read/content-Grep of
// scripts/commit-reviewed.mjs was performed by this author).
//
// HARNESS PROVENANCE: the git()/makeRepo()/ledgerPath()/writeLedger()/
// readLedger()/stageChange()/runCommitReviewed()/readTrailerValues() idioms
// below are adapted (not imported) from scripts/tests/commit-reviewed.test.mjs
// and scripts/tests/commit-reviewed-hardening.test.mjs — same fixture shape
// (mkdtemp git repo, git init -b main, git config user.*, gpgsign off,
// .gitignore excluding .sterling/, a base commit, then .sterling/ created).
// This file additionally seeds .sterling/config.json (a minimal toolchain
// config, matching the CONFIG shape used by
// scripts/tests/h22-receipt-expiry.test.mjs) and drives every "reviewed"
// commit through PLAIN `git commit`, never through commit-reviewed.mjs itself
// — the amend mode's whole job is to retrofit receipts onto a commit that
// already exists.
//
// KEY DESIGN CHOICE, DERIVED DIRECTLY FROM THE CONTRACT TEXT (not invented):
// every --target-sha invocation below omits `-m` entirely, exactly as the
// contract's own invocation example does (`node scripts/commit-reviewed.mjs
// --target-sha <sha>`). This licenses a discriminating RED-TODAY assertion
// used throughout the refusal-path tests: today's commit-reviewed.mjs does
// not recognize --target-sha at all, so an invocation with no -m and no
// eligible ledger falls into the BASE spec's "missing -m" refusal path
// (scripts/tests/commit-reviewed.test.mjs test 1, stderr matches
// /-m|message/i). A correct --target-sha implementation must never cite that
// vocabulary — its own guards (tip-only, dirty tree, base_sha, publication)
// fire first and speak their own reasons. Asserting
// `assert.doesNotMatch(r.stderr, /-m|message/i)` therefore FAILS red today
// (today's real refusal reason IS the missing message) and PASSES once
// --target-sha mode ships with its own distinct refusal vocabulary — a
// contract-derived discriminator, not a guess at exact wording.
//
// THE FIXTURE SEAM (contract G6): the PUBLISHED-HISTORY GUARD has no waiver
// by design, which makes success cases untestable in a fixture repo with no
// remote (every repo here starts with none). Per the launching brief, this
// file specs a test-fixture-only seam: STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM
// = '1' treats a repo with NO configured upstream as unpublished (unset or
// '' is falsy/off, matching the STERLING_* convention already used elsewhere
// in this suite, e.g. STERLING_CURRENCY_DISABLE). Reachability from an
// actual configured remote ref BEATS the seam — pinned explicitly below.

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

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

// Anti-pattern ee89c3fd guard: flatten before interpolating multi-line
// stderr/stdout into an assertion message.
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-target-sha-'));
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
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
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

// Creates a real commit via PLAIN `git commit` (never through
// commit-reviewed.mjs) and returns its full 40-char sha.
function commitPlain(dir, message, relPath = 'src/reviewed.mjs', content = 'export const reviewed = 1;\n') {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// Like commitPlain, but forces `--cleanup=verbatim` on the ORIGINAL commit's
// creation too — git's DEFAULT cleanup mode ("strip") collapses consecutive
// blank lines and trims trailing whitespace, which would silently destroy
// the double-blank-line fixture the byte-fidelity pin below depends on
// before the amend even runs. This function exists solely to get an
// intentionally-unusual message onto disk UNMODIFIED so the amend's own
// fidelity (not git's ordinary commit-time cleanup) is what is being pinned.
function commitPlainVerbatim(dir, message, relPath = 'src/reviewed.mjs', content = 'export const reviewed = 1;\n') {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '--cleanup=verbatim', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// Raw (byte-faithful) commit body read — `git log --format=%B` reliably adds
// exactly ONE trailing newline as a formatting artifact of the log command
// itself, which is NOT part of the stored message; a plain `.trim()` (as
// used by the shared git() helper) would also eat every OTHER blank line at
// the message's edges, which is exactly the fidelity this pin exists to
// protect. Only that one artifact newline is stripped here.
function readCommitBodyRaw(dir, sha = 'HEAD') {
  const r = spawnSync('git', ['log', '-1', '--format=%B', sha], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git log %B ${sha}: ${r.stderr}`);
  let out = r.stdout;
  if (out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}

function runCommitReviewed(dir, args = [], env = {}) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The EXACT read scripts/direct-merge.mjs's receipt-gate uses.
function readTrailerValues(dir, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

// Seam ON (test-fixture-only, per the contract's spec'd env var).
const SEAM_ON = { STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM: '1' };

// A local bare repo used as `origin`, so reachability can be exercised
// without any real network access.
function makeBareRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-target-sha-bare-'));
  git(dir, ['init', '--bare', '-b', 'main']);
  return dir;
}

// ---------------------------------------------------------------------------
// G7 CONTROL-A: without --target-sha, the normal -m happy path is unaffected
// by the new flag's existence — placed FIRST as the control the whole file's
// refusal pins lean on (it establishes the OLD path still behaves as the
// base spec already pins).
// EXPECTED STATE: GREEN today (this is the base spec's own happy path,
// unmodified) — this is a regression control, not a new-behavior pin.
// SABOTAGE: route every invocation through the target-sha amend branch
// regardless of whether --target-sha was passed -> the -m happy path breaks
// (no new commit created via the normal flow) -> red.
// ---------------------------------------------------------------------------
test('G7 CONTROL-A: without --target-sha, the normal -m commit path still succeeds and stamps a trailer exactly as today', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: isoAgo(1_000) }]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'plain path unaffected by target-sha']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), beforeHead, 'a new commit was created via the normal path');
    assert.deepEqual(readTrailerValues(dir), ['reviewer-correctness']);
    assert.deepEqual(readLedger(dir), [], 'the ledger entry is consumed exactly as the base spec pins');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G7 CONTROL-B: without --target-sha, missing -m still refuses (light
// control, per the contract's explicit instruction).
// EXPECTED STATE: GREEN today (base spec test 1, unmodified).
// SABOTAGE: drop the -m requirement whenever --target-sha is absent from
// argv -> an unmarked commit succeeds silently -> red.
// ---------------------------------------------------------------------------
test('G7 CONTROL-B: without --target-sha, missing -m still refuses exactly as today', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], at: isoAgo(1_000) }]);
    const beforeHead = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, []);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /-m|message/i);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), beforeHead, 'no commit was made');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G6 CONTROL: seam OFF, no upstream configured at all -> refuses (publication
// status is UNPROVABLE without the fixture seam). Placed as the CONTROL for
// the immediately following HAPPY test, which is identical in every respect
// except the seam is ON — same fixture, opposite verdict, for the documented
// reason (the seam), so a green HAPPY test cannot be produced by a CLI that
// ignores the publication guard entirely.
// EXPECTED STATE: RED today — not because of the eventual guard (which
// cannot fire yet) but because the discriminating assertion
// (doesNotMatch /-m|message/i) fails: today's real refusal reason for an
// argv with no -m is exactly "missing -m", which this test asserts must NOT
// be the reason once --target-sha mode ships.
// SABOTAGE: make STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM's absence a no-op
// (treat "no upstream" as always safe to amend) -> exit 0 instead of
// refusing -> red.
// ---------------------------------------------------------------------------
test('G6 CONTROL (seam OFF): with no upstream configured and the seam unset, --target-sha refuses — publication status is unprovable', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed change, no seam');
    const entries = [{ agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], at: isoAgo(1_000), base_sha: targetSha }];
    writeLedger(dir, entries);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha]);
    assert.notEqual(r.code, 0, `no upstream + seam off must refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /-m|message/i, `the refusal must be the publication guard, not a reused missing-message reason — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'nothing was amended');
    assert.deepEqual(readLedger(dir), entries, 'the ledger is untouched, byte-identical');
  } finally {
    cleanup();
  }
});

// A deliberately awkward original body: a MULTI-PARAGRAPH message containing
// a genuine DOUBLE blank line (git's default "strip" cleanup would collapse
// consecutive blank lines into one, and a naive amend re-cleanup would do
// the same) and a "Key: value"-shaped line sitting in a NON-final paragraph
// (git's trailer parser only treats the FINAL paragraph as trailer-shaped —
// this line must survive as ordinary body text, never mistaken for a
// trailer nor stripped as one). Strengthens the review finding that the
// prior %s-only ("subject line only") comparison was hollow: it could not
// have detected either failure mode.
const MULTI_PARAGRAPH_BODY =
  'Reviewed feature, multi-paragraph message\n' +
  '\n' +
  'Key: value\n' +
  'Second line of paragraph two.\n' +
  '\n' +
  '\n' + // deliberate DOUBLE blank line before the final paragraph
  'Closing paragraph with more detail, not a trailer.';

// ---------------------------------------------------------------------------
// HAPPY PATH (G1 tip control, G2 clean-tree control, G3 base_sha-match
// control, G4 MATCHED, G5 full success shape). This is the single test every
// refusal pin below is implicitly contrasted against: identical setup minus
// whatever one guard each refusal test is isolating.
// EXPECTED STATE: RED today — no amend behavior exists; r.code will not be 0
// against a message-preserving, trailer-stamped, sha-reporting, tree/parent-
// stable success.
// SABOTAGE (message fidelity): re-cleanup the message on amend (e.g. rebuild
// via the default "strip" cleanup instead of `--cleanup=verbatim -F -`) ->
// the double blank line collapses to one -> the %B equality assertion goes
// red even though the trailer itself still stamps correctly — a hollowness
// the old %s-only check could not have caught.
// SABOTAGE (tree/parent): rebuild the commit via a fresh `git commit` rather
// than `git commit --amend` (or otherwise reconstruct the tree instead of
// reusing the original one) -> the tree/parent equality assertions go red.
// ---------------------------------------------------------------------------
test('HAPPY: tip sha, clean tree, matching base_sha, seam ON, no upstream — amends in place, preserves the message BYTE-FAITHFULLY, stamps one trailer, reports both shas, keeps tree+parent unchanged, consumes only the stamped receipt', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const originalSha = commitPlainVerbatim(dir, MULTI_PARAGRAPH_BODY, 'src/laneA.mjs');
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000), base_sha: originalSha }]);

    const r = runCommitReviewed(dir, ['--target-sha', originalSha], SEAM_ON);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const newSha = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(newSha, originalSha, 'the commit was amended (new sha)');

    // BYTE-FAITHFUL message pin (1): the full %B, not just the subject line.
    const expectedBody = `${MULTI_PARAGRAPH_BODY}\n\nReviewed-By-Agent: reviewer-correctness`;
    assert.equal(
      readCommitBodyRaw(dir, newSha),
      expectedBody,
      'the amended body is byte-identical to the original (double blank line and the mid-message "Key: value" line intact) plus exactly the appended trailer block'
    );

    assert.deepEqual(readTrailerValues(dir, newSha), ['reviewer-correctness'], 'exactly one trailer, readable via the exact direct-merge format');
    assert.deepEqual(readLedger(dir), [], 'the stamped receipt is consumed');

    // POST-CONDITION pin (3): the amend changes nothing but the message —
    // same tree, same parent.
    assert.equal(git(dir, [`rev-parse`, `${newSha}^{tree}`]), git(dir, [`rev-parse`, `${originalSha}^{tree}`]), 'the amended commit has the IDENTICAL tree — the amend touches only the message');
    assert.equal(git(dir, [`rev-parse`, `${newSha}^`]), git(dir, [`rev-parse`, `${originalSha}^`]), 'the amended commit has the IDENTICAL parent');

    const combined = `${r.stdout}\n${r.stderr}`;
    assert.match(combined, new RegExp(originalSha), 'the OLD sha is reported');
    assert.match(combined, new RegExp(newSha), 'the NEW sha is reported');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECOND-AMEND ARM (2): a commit already carrying a stamped trailer from a
// FIRST --target-sha amend is amended AGAIN (a fresh receipt whose base_sha
// is the FIRST amend's NEW sha) — round one's Reviewed-By-Agent trailer must
// survive round two, not be orphaned. This is a REGRESSION pin against a
// measured defect in the implementation currently landing in parallel: an
// amend that rebuilds the trailer block from ONLY the freshly-stamped
// receipt set (rather than appending to whatever trailers the target commit
// already carries) silently drops every trailer from a prior round.
// EXPECTED STATE: RED against current code (both because --target-sha does
// not exist yet, AND — per the coordinator's explicit note — this specific
// pin must stay red until the orphaning defect is fixed even once amend
// mode otherwise lands).
// SABOTAGE: build the second amend's trailer block from `stampedThisRound`
// alone instead of `existingTrailers(targetSha) + stampedThisRound` -> round
// one's 'reviewer-correctness' trailer disappears from the final read -> red.
// ---------------------------------------------------------------------------
test('SECOND-AMEND: a second --target-sha amend on top of a first one preserves BOTH rounds\' Reviewed-By-Agent trailers — round one is never orphaned', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const originalSha = commitPlain(dir, 'reviewed feature, round one', 'src/laneA.mjs');
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(2_000), base_sha: originalSha }]);

    const r1 = runCommitReviewed(dir, ['--target-sha', originalSha], SEAM_ON);
    assert.equal(r1.code, 0, `round one must succeed — stdout=${r1.stdout} stderr=${flat(r1.stderr)}`);
    const shaAfterRound1 = git(dir, ['rev-parse', 'HEAD']);
    assert.deepEqual(readTrailerValues(dir, shaAfterRound1), ['reviewer-correctness'], 'fixture guard: round one really did stamp its trailer');

    // A FRESH receipt whose base_sha is round one's OUTPUT sha — exactly the
    // shape a second, later review of the (now-amended) commit would produce.
    writeLedger(dir, [{ agent_type: 'reviewer-security', files: ['src/laneA.mjs'], at: isoAgo(1_000), base_sha: shaAfterRound1 }]);

    const r2 = runCommitReviewed(dir, ['--target-sha', shaAfterRound1], SEAM_ON);
    assert.equal(r2.code, 0, `round two must succeed — stdout=${r2.stdout} stderr=${flat(r2.stderr)}`);
    const shaAfterRound2 = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(shaAfterRound2, shaAfterRound1, 'round two produced a new sha');

    const trailersAfterRound2 = readTrailerValues(dir, shaAfterRound2);
    assert.ok(trailersAfterRound2.includes('reviewer-correctness'), `round one's trailer must survive round two — got ${JSON.stringify(trailersAfterRound2)}`);
    assert.ok(trailersAfterRound2.includes('reviewer-security'), `round two's trailer must be present too — got ${JSON.stringify(trailersAfterRound2)}`);
    assert.equal(trailersAfterRound2.length, 2, `exactly the two trailers from both rounds, no more, no less — got ${JSON.stringify(trailersAfterRound2)}`);
    assert.deepEqual(readLedger(dir), [], 'round two\'s receipt was consumed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// CONTRADICTION (4, tightened): --target-sha and -m are mutually exclusive —
// amend mode preserves the ORIGINAL commit's message, so a caller-supplied
// -m can never be honored. Both arms stage a REAL change matching a ledger
// receipt's files[] exactly, so that if the contradiction is NOT detected,
// today's/tomorrow's normal -m path would happily create a genuine new
// commit and move HEAD — the starkest possible signal that the guard is
// missing. ASSUMPTION (disclosed): neither the decision record nor the
// launching contract names the exact refusal vocabulary; "contradict" is
// inferred from the coordinator's own framing of this requirement and is a
// best-effort match, not a settled term.
// ---------------------------------------------------------------------------

// (a) the ordinary case: a real, non-empty -m alongside --target-sha.
// EXPECTED STATE: RED today — today's CLI has no contradiction check at all;
// depending on how it treats the unrecognized --target-sha token it either
// (i) proceeds down the normal -m path and actually commits, moving HEAD
// (failing the HEAD-unchanged assertion outright), or (ii) refuses for an
// unrelated reason that never says "contradict" (failing the vocabulary
// assertion) — either way this test is red before the guard exists.
// SABOTAGE: never check for -m when --target-sha is present (only ever
// derive the message from the target commit) -> a caller's -m is silently
// ignored rather than refused -> the vocabulary/HEAD-moved assertions go red.
test('CONTRADICTION-a: --target-sha combined with a real -m message refuses — amend mode cannot honor a caller-supplied message', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed, before the contradictory invocation');
    stageChange(dir, 'src/extra.mjs', 'export const extra = 1;\n');
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/extra.mjs'], at: isoAgo(1_000), base_sha: targetSha }]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha, '-m', 'this message must never be honored'], SEAM_ON);
    assert.notEqual(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /contradict|conflict|mutually exclusive|cannot.*(combine|use).*(-m|--target-sha)/i, `the refusal names the contradiction — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'HEAD is unmoved — no commit was made from the staged change');
    assert.equal(readLedger(dir).length, 1, 'the ledger is untouched');
  } finally {
    cleanup();
  }
});

// (b) the tightened edge case: an EXPLICITLY EMPTY -m ("").
// EXPECTED STATE: RED today — today's CLI treats a falsy `''` exactly like a
// missing -m (base spec test 1's own vocabulary, /-m|message/i), never
// "contradict"; a naive future fix that checks `if (msg)` rather than
// "was -m present on argv at all" would ALSO stay silently wrong here.
// SABOTAGE: implement the contradiction check as `if (msg && targetSha)`
// (truthiness) instead of "argv included -m at all" -> an empty-string -m
// bypasses the check entirely -> the vocabulary assertion goes red.
test('CONTRADICTION-b (TIGHTENED): --target-sha combined with an explicitly EMPTY -m ("") ALSO refuses — a falsy message must not bypass the contradiction check', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed, before the empty-message invocation');
    stageChange(dir, 'src/extra2.mjs', 'export const extra2 = 1;\n');
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/extra2.mjs'], at: isoAgo(1_000), base_sha: targetSha }]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha, '-m', ''], SEAM_ON);
    assert.notEqual(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /contradict|conflict|mutually exclusive|cannot.*(combine|use).*(-m|--target-sha)/i, `an explicitly-empty -m must still be recognized as "a message was supplied" — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'HEAD is unmoved');
    assert.equal(readLedger(dir).length, 1, 'the ledger is untouched');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G6: reachability from the ACTUAL remote ref BEATS the seam — pushing the
// target commit to a local bare `origin` must refuse even with the seam ON.
// EXPECTED STATE: RED today (discriminating assertion as above).
// SABOTAGE: invert the reachability check (treat "reachable from remote" as
// safe to amend) -> exit 0, HEAD moves -> red.
// ---------------------------------------------------------------------------
test('G6: a target commit reachable from the ACTUAL remote ref refuses even with the seam ON', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  const bare = makeBareRemote();
  try {
    const targetSha = commitPlain(dir, 'reviewed, but already pushed');
    git(dir, ['remote', 'add', 'origin', bare]);
    git(dir, ['push', '-u', 'origin', 'main']);
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], at: isoAgo(1_000), base_sha: targetSha }]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.notEqual(r.code, 0, `reachable-from-remote must refuse even with the seam ON — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /-m|message/i, `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'nothing was amended');
    assert.equal(readLedger(dir).length, 1, 'the ledger is untouched');
  } finally {
    cleanup();
    rmSync(bare, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G6 (provable-unpublished, no seam needed): an origin IS configured and IS
// reachable, but the target commit was never pushed to it — this is a
// genuinely PROVABLE unpublished state, distinct from "no upstream at all",
// so the seam should not be required here at all (seam left OFF).
// EXPECTED STATE: RED today.
// SABOTAGE: treat "an origin remote is configured" alone (without actually
// querying its ref) as sufficient grounds to refuse -> a provably-unpublished
// commit refuses unnecessarily -> red (exit 0 expected, gets nonzero).
// ---------------------------------------------------------------------------
test('G6: an origin that IS configured and reachable, but does not contain the target commit, proceeds WITHOUT needing the seam', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  const bare = makeBareRemote();
  try {
    // Push the BASE commit only, so origin/main exists and is reachable —
    // then create the reviewed commit locally, never pushed.
    git(dir, ['remote', 'add', 'origin', bare]);
    git(dir, ['push', '-u', 'origin', 'main']);
    const targetSha = commitPlain(dir, 'reviewed, never pushed');
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], at: isoAgo(1_000), base_sha: targetSha }]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha]); // seam OFF deliberately
    assert.equal(r.code, 0, `origin configured+reachable but the commit itself was never pushed must proceed without the seam — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), targetSha, 'the commit was amended');
    assert.deepEqual(readLedger(dir), [], 'the receipt was consumed');
  } finally {
    cleanup();
    rmSync(bare, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G1: a non-tip sha (HEAD~1) is refused — nothing amended.
// EXPECTED STATE: RED today.
// SABOTAGE: drop the tip-equality check (only require the sha to resolve to
// SOME commit reachable from HEAD) -> HEAD~1 is accepted, HEAD moves -> red.
// ---------------------------------------------------------------------------
test('G1: --target-sha resolving to a non-tip commit (HEAD~1) is refused — the message names the tip-only rule, nothing amended', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const firstSha = commitPlain(dir, 'first reviewed change', 'src/first.mjs');
    const tipSha = commitPlain(dir, 'second change on top', 'src/second.mjs');
    assert.equal(git(dir, ['rev-parse', 'HEAD']), tipSha);
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/first.mjs'], at: isoAgo(1_000), base_sha: firstSha }]);

    const r = runCommitReviewed(dir, ['--target-sha', firstSha], SEAM_ON);
    assert.notEqual(r.code, 0, `a non-tip sha must refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /tip/i, 'the refusal names the tip-only rule');
    assert.doesNotMatch(r.stderr, /-m|message/i, `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), tipSha, 'HEAD is unmoved — nothing was amended');
    assert.equal(readLedger(dir).length, 1, 'the ledger is untouched');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G2a: dirty INDEX (staged, uncommitted) blocks the amend.
// EXPECTED STATE: RED today.
// SABOTAGE: only check the worktree diff (git diff), never the staged/index
// diff (git diff --cached) -> a dirty index is silently allowed through ->
// red.
// ---------------------------------------------------------------------------
test('G2a: a dirty INDEX (staged but uncommitted) refuses the amend — nothing amended, ledger untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed, then something staged');
    stageChange(dir, 'src/uncommitted.mjs', 'export const oops = 1;\n'); // staged, not committed
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], at: isoAgo(1_000), base_sha: targetSha }]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.notEqual(r.code, 0, `a dirty index must refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /-m|message/i, `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'nothing was amended');
    assert.equal(readLedger(dir).length, 1, 'the ledger is untouched');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G2b: dirty WORKTREE (unstaged modification of a tracked file) blocks the
// amend.
// EXPECTED STATE: RED today.
// SABOTAGE: only check the index diff (git diff --cached), never the
// worktree diff -> a dirty worktree is silently allowed through -> red.
// ---------------------------------------------------------------------------
test('G2b: a dirty WORKTREE (unstaged modification) refuses the amend — nothing amended, ledger untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed, then modified unstaged');
    writeFileSync(join(dir, 'src', 'reviewed.mjs'), 'export const reviewed = 2; // unstaged edit\n'); // NOT git add'd
    writeLedger(dir, [{ agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], at: isoAgo(1_000), base_sha: targetSha }]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.notEqual(r.code, 0, `a dirty worktree must refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /-m|message/i, `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'nothing was amended');
    assert.equal(readLedger(dir).length, 1, 'the ledger is untouched');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G3a: NO receipt qualifies (one missing base_sha, one with a different
// base_sha) -> LOUD refusal naming base_sha, nothing amended, ledger
// byte-identical.
// EXPECTED STATE: RED today.
// SABOTAGE: when zero receipts match base_sha, fall back to stamping every
// receipt anyway (as if base_sha were not required) -> exit 0, message not
// preserved as a refusal -> red.
// ---------------------------------------------------------------------------
test('G3a: with NO receipt carrying a matching base_sha (one missing, one different), the CLI refuses loudly naming base_sha — nothing amended, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed, mismatched base_sha only');
    const entries = [
      { agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], at: isoAgo(1_000) }, // base_sha absent
      { agent_type: 'reviewer-security', files: ['src/reviewed.mjs'], at: isoAgo(2_000), base_sha: 'a'.repeat(40) }, // different
    ];
    writeLedger(dir, entries);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.notEqual(r.code, 0, `zero base_sha-matching receipts must refuse loudly — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /base_sha/i, 'the refusal names base_sha, not a silent skip');
    assert.doesNotMatch(r.stderr, /-m|message/i, `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'nothing was amended');
    assert.deepEqual(readLedger(dir), entries, 'the ledger is byte-identical — neither entry was consumed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G3b: a MIXED ledger (one base_sha-matching, one not) succeeds, stamps ONLY
// the matching receipt, and the non-matching one survives un-consumed —
// never a silent skip/delete.
// EXPECTED STATE: RED today.
// SABOTAGE: consume the non-matching receipt too when filtering by base_sha
// (delete rather than leave it) -> the survivor assertion fails -> red.
// ---------------------------------------------------------------------------
test('G3b: a mixed ledger stamps ONLY the base_sha-matching receipt; the non-matching one survives un-consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed, mixed base_sha');
    const wrongEntry = { agent_type: 'reviewer-security', files: ['src/reviewed.mjs'], at: isoAgo(2_000), base_sha: 'b'.repeat(40) };
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], at: isoAgo(1_000), base_sha: targetSha },
      wrongEntry,
    ]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.equal(r.code, 0, `at least one base_sha-matching receipt exists — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir), ['reviewer-correctness'], 'only the matching receipt is stamped');
    assert.deepEqual(readLedger(dir), [wrongEntry], 'the non-matching receipt survives byte-identical — never consumed, never deleted');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G4a: a receipt recording NO files (empty array) is ALWAYS stamped (the
// existing MATCHED/UNATTRIBUTED/DEFERRED partition applies unchanged), even
// though this is a fresh amend context rather than a staged-diff commit.
// EXPECTED STATE: RED today.
// SABOTAGE: treat an empty files[] as a non-match under the target-sha
// diff-derived file set (defer it instead of always-stamping) -> the
// unattributed trailer never appears -> red.
// ---------------------------------------------------------------------------
test('G4a: a receipt with files:[] is stamped alongside a receipt matching the commit\'s own diff — empty files[] is never a non-match', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed lane A only', 'src/laneA.mjs');
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000), base_sha: targetSha },
      { agent_type: 'reviewer-blank', files: [], at: isoAgo(2_000), base_sha: targetSha },
    ]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir).sort(), ['reviewer-blank', 'reviewer-correctness'], 'both are stamped: the diff-matching one and the unattributed one');
    assert.deepEqual(readLedger(dir), [], 'both are consumed');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// G4b: the target file set is the commit's OWN diff (git diff-tree). A
// base_sha-matching receipt whose files[] miss that diff entirely, while
// another base_sha-matching receipt DOES match, is DEFERRED — not stamped,
// not consumed, disclosed by name.
// EXPECTED STATE: RED today.
// SABOTAGE: skip the file-scoping partition once base_sha has already
// filtered the set (stamp every base_sha-eligible receipt regardless of
// files[]) -> the deferred receipt gets stamped too -> red.
// ---------------------------------------------------------------------------
test('G4b: the commit\'s own diff (not the working tree) is the target file set — a base_sha-matching receipt whose files miss it entirely is DEFERRED, not stamped, disclosed by name', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetSha = commitPlain(dir, 'reviewed lane A only', 'src/laneA.mjs');
    const laneB = { agent_type: 'reviewer-security', files: ['src/laneB.mjs'], at: isoAgo(2_000), base_sha: targetSha };
    writeLedger(dir, [
      { agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], at: isoAgo(1_000), base_sha: targetSha },
      laneB,
    ]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(readTrailerValues(dir), ['reviewer-correctness'], 'only the diff-matching receipt is stamped');
    assert.deepEqual(readLedger(dir), [laneB], 'the deferred receipt survives byte-identical');
    assert.match(r.stderr, /deferred/i, 'the withholding is disclosed');
    assert.match(r.stderr, /reviewer-security/, 'the disclosure names the receipt');
    assert.match(r.stderr, /src\/laneB\.mjs/, 'and the territory it actually reviewed');
  } finally {
    cleanup();
  }
});
