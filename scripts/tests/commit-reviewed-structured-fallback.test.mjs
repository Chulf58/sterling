// COMMIT-REVIEWED — STRUCTURED-TERRITORY FALLBACK NARROWING
// (campaign slice S2b-3; decision 57984926, slug
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design, §3
// "FALLBACK NARROWING + DISCHARGE").
//
// SPEC-ONLY, RED-FIRST. Authored from the decision record (opened via
// knowledge_get; §3 quoted verbatim below) and the launching brief — NOT from
// scripts/commit-reviewed.mjs's internals. H4 read wall honored: this file's
// author never Read nor content-Grepped scripts/commit-reviewed.mjs,
// scripts/review-ledger.mjs or scripts/hooks/lib/*; only sibling TEST files
// were read, for fixture conventions.
//
// SPEC UNDER TEST (decision 57984926 §3, verbatim clause):
//   "for STRUCTURED territory (source:'review-territory') the no-match
//    stamping fallback is REMOVED — a structured receipt matching nothing
//    staged DEFERS, and the commit refuses if no other roster receipt covers
//    the staged diff; the fallback survives ONLY for free-prose/legacy
//    attribution (research finding 289cd172's measured unreliability is
//    exactly what it exists for)."
// Everything else about stamping, deferral, consumption and the pre-existing
// attribution advisory is UNCHANGED — F0/F0b/F2/F4 pin that.
//
// HARNESS PROVENANCE: git()/makeRepo()/ledgerPath()/writeLedger()/readLedger()/
// readLedgerRaw()/stageChange()/runCommitReviewed()/trailer reading/flat/isoAgo
// are the scripts/tests/commit-reviewed-file-scoping.test.mjs and
// scripts/tests/commit-reviewed-bytes-refuse.test.mjs idioms (the
// STERLING_SESSION_ID env seam is the one documented in file-scoping's
// runCommitReviewedEnv). Deliberate harness-only deviation: the mkdtemp prefix
// is 'sterling-commit-reviewed-structured-fallback-' so this suite cannot
// collide with its siblings in tmpdir. Standalone file: its own fixtures, no
// shared imports from any sibling test file.
//
// ===========================================================================
// FIXTURE CHOICES THAT ARE LOAD-BEARING, NOT COSMETIC:
//
//  1. F0b AND F1 ARE THE SAME FIXTURE DIFFERING IN EXACTLY ONE FIELD —
//     territory.source ('free-prose-fallback' vs 'review-territory'). That
//     pair is what carries the verdict for this whole file: a green F1 that
//     came from "this mode refuses every non-matching receipt" would redden
//     F0b, and a green F0b that came from "the fallback always stamps" would
//     redden F1. Neither pin means anything without the other.
//  2. EVERY receipt's content_evidence/reviewed_state blobs MATCH the real
//     current blob of every file it declares. This suite must be neutral with
//     respect to slice S2b-2's reviewed-bytes REFUSE flip (decision 57984926
//     §2) whether or not that slice has landed: a stale blob here would make a
//     refusal ambiguous between "structured territory covered nothing" and
//     "the bytes moved", which is exactly the multi-cause verdict this role is
//     required to avoid.
//  3. Every v2 entry is STRUCTURALLY COMPLETE (entry_id, started_at,
//     identity{session_id,branch,base_sha}) because
//     commit-reviewed-file-scoping.test.mjs S13 pins that a structurally
//     deficient v2 entry is withheld — a short fixture would be withheld for
//     the wrong reason.
//
// ===========================================================================
// AMBIGUITIES FLAGGED, NOT RESOLVED (reported to the launching agent):
//
//   (i)  F3 (mixed structured-no-match + free-prose-no-match, nothing else
//        matching): §3's refusal condition reads "the commit refuses if no
//        other roster receipt covers the staged diff". Under a LITERAL reading
//        of "covers", the free-prose receipt does not COVER the staged diff
//        either (it matches nothing) — it is merely stamped by the surviving
//        fallback — so the commit would refuse. Under the launching brief's
//        reading (pinned below) the surviving free-prose fallback satisfies the
//        condition and the commit succeeds. F3 pins the BRIEF's reading
//        explicitly so the conductor can adjudicate a red here as a spec
//        question rather than an implementation defect. THIS IS THE ONE PIN IN
//        THIS FILE THAT MAY BE WRONG ABOUT THE SPEC RATHER THAN ABOUT THE CODE.
//   (ii) F5: a v1 (flat) receipt carrying `files_source: 'review-territory'`
//        — the pre-v2 flat spelling shipped by decision 8f137474 — is neither
//        clearly "structured territory" (§3 names the v2 nested
//        `territory.source`) nor clearly "legacy attribution" (§3's fallback
//        survivor). §3 does not say which wins. F5 therefore asserts ONLY the
//        invariant that holds under EITHER reading, the pattern
//        commit-reviewed-bytes-refuse.test.mjs C2/C3 uses.
//  (iii) DISCLOSURE WORDING: F2's deferral disclosure asserts the ALREADY
//        SHIPPED `DEFERRED RECEIPT` anchor (pinned by file-scoping S2). F1/F3
//        assert only that the withheld receipt is named, because §3 does not
//        state whether the NEW structured deferral reuses that channel or gets
//        its own. A red on a naming assertion here is a real disclosure gap; a
//        red on an anchor string would have been a wording nit, so no new
//        anchor string is invented.
// ===========================================================================

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

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };

// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
// Date.now()-relative ISO timestamps, never hardcoded dates.
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-structured-fallback-'));
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
// "NOTHING consumed" is asserted on the RAW BYTES, not the parsed value — a
// refusal that rewrites the file with the same logical content has still
// written to an agent-writable evidence file during a refusal path.
function readLedgerRaw(dir) {
  return existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null;
}

function stageChange(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

// Commits `relPath` at `content` and returns its blob sha — used so a receipt's
// declared territory really exists in the tree and its recorded blob really
// matches it (fixture choice 2 in the header).
function commitFile(dir, relPath, content) {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', `seed ${relPath}`]);
  return git(dir, ['hash-object', relPath]);
}

function stagedBlob(dir, relPath) {
  return git(dir, ['hash-object', relPath]);
}

function runCommitReviewed(dir, args = [], env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function reviewedByTrailers(dir, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

// v1 (flat) receipt — the legacy shape. `files_source` is only set when a pin
// deliberately exercises the flat pre-v2 spelling (F5).
function v1({ agent_type, files, blobs, files_source, at = isoAgo(60_000) }) {
  const e = { agent_type, files, at, session_id: SESSION, branch: 'main' };
  if (blobs) e.reviewed_state = { blobs, completed_at: at };
  if (files_source !== undefined) e.files_source = files_source;
  return e;
}

// v2 (nested) receipt, shape per decision 57984926 §1 and the v2 fixture
// already frozen in commit-reviewed-file-scoping.test.mjs S12.
function v2({
  entry_id,
  agent_type,
  files,
  blobs = {},
  base_sha,
  source = 'review-territory',
  status = 'active',
  at = isoAgo(60_000),
}) {
  return {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status,
    started_at: at,
    finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha },
    territory: { files, source, attribution: 'block' },
    content_evidence: { status: 'complete', blobs, absent_paths: [], truncated_of: null, failure_reason: null },
    disposition: null,
  };
}

const CODE = 'export const f = 1;\n';
const STAGED = 'export const staged = 2;\n';

// ===========================================================================
// F0 / F0b — THE SURVIVING FALLBACK (CONTROLS, PLACED FIRST).
// Both must pass for the OPPOSITE reason to F1: the fallback still stamps a
// receipt whose attribution is known-unreliable. Without these two green, a
// green F1 is indistinguishable from "the CLI now refuses any non-matching
// receipt", which is the over-broad reading §3 explicitly forbids.
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the narrowing (legacy attribution is
// the fallback's whole reason to exist — finding 289cd172).
// SABOTAGE: narrow the fallback on "the receipt declares files" rather than on
// "the receipt's territory is STRUCTURED" -> this legacy receipt defers, the
// commit refuses, and every assertion below goes red. That sabotage is the
// exact over-reach that would brick every pre-v2 receipt sitting in a live
// ledger, and no other pin in this file catches it.
test('structured-fallback F0 (CONTROL, first): a LEGACY v1 receipt matching nothing staged still falls back — stamped, consumed, commit succeeds, advisory unchanged', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const laneBBlob = commitFile(dir, 'src/laneB.mjs', CODE);
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [v1({ agent_type: 'reviewer-legacy', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlob } })]);

    const r = runCommitReviewed(dir, ['-m', 'F0 legacy no-match falls back']);
    assert.equal(r.code, 0, `a legacy receipt matching nothing must NEVER refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created via the surviving fallback');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-legacy'], 'the fallback still stamps exactly as before');
    assert.deepEqual(readLedger(dir), [], 'and still consumes');
    assert.match(r.stderr, /RECEIPT FILES DO NOT OVERLAP THIS DIFF/, `the pre-existing attribution advisory still speaks — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /ADVISORY ONLY/, `and still marks itself advisory — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: GREEN today AND after the narrowing.
// SABOTAGE: key the narrowing on `schema_version === 2` (i.e. "v2 entries no
// longer fall back") instead of on territory.source -> this receipt defers, the
// commit refuses, red. THIS IS THE CONTROL THAT PAIRS WITH F1: the two fixtures
// differ in ONE field, so together they prove the verdict is carried by
// territory.source and by nothing else.
test('structured-fallback F0b (CONTROL): a v2 receipt whose territory.source is FREE-PROSE-FALLBACK, matching nothing staged, still falls back — stamped, consumed, commit succeeds', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const laneBBlob = commitFile(dir, 'src/laneB.mjs', CODE);
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [
      v2({
        entry_id: 'f0b00000-0000-4000-8000-000000000001',
        agent_type: 'reviewer-freeprose',
        files: ['src/laneB.mjs'],
        blobs: { 'src/laneB.mjs': laneBBlob },
        base_sha: head,
        source: 'free-prose-fallback',
      }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'F0b free-prose v2 no-match falls back']);
    assert.equal(r.code, 0, `free-prose attribution keeps the fallback, v2 or not — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-freeprose'], 'stamped by the surviving fallback');
    assert.deepEqual(readLedger(dir), [], 'and consumed');
    assert.match(r.stderr, /RECEIPT FILES DO NOT OVERLAP THIS DIFF/, `the pre-existing advisory still speaks — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// F1 — THE NARROWING ITSELF.
// ===========================================================================

// EXPECTED STATE: RED today — today the fallback stamps every eligible receipt
// when nothing matches (file-scoping S5), so the CLI exits 0 and the very first
// assertion (`r.code === 1`) fails; the HEAD-unmoved, ledger-byte-identical and
// no-trailer assertions would all fail too.
// SABOTAGE: restore the fallback for structured territory (treat
// source:'review-territory' the same as free-prose when nothing matches) ->
// exit 0, HEAD moves, the receipt is stamped and consumed -> red. That is
// exactly today's behaviour, which is why this pin is red before the change.
// SECOND SABOTAGE (the deferral half): make the structured no-match case
// REFUSE but also consume/rewrite the ledger -> the byte-identical assertion
// reddens while the exit-code assertion stays green.
test('structured-fallback F1: a STRUCTURED v2 receipt matching nothing staged, with no other receipt covering the diff, DEFERS and the commit REFUSES — exit 1, no commit, ledger byte-identical, the receipt named', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const laneBBlob = commitFile(dir, 'src/laneB.mjs', CODE);
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [
      v2({
        entry_id: 'f1000000-0000-4000-8000-000000000002',
        agent_type: 'reviewer-security',
        files: ['src/laneB.mjs'],
        blobs: { 'src/laneB.mjs': laneBBlob },
        base_sha: head,
        source: 'review-territory',
      }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'F1 structured no-match']);
    assert.equal(r.code, 1, `structured territory that covers nothing staged must never be stamped by fallback — the commit REFUSES — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'NO commit was created');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed — the deferred receipt survives byte-identical through the refusal');
    assert.match(r.stderr, /reviewer-security/, `the refusal names the deferred receipt — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /src\/laneB\.mjs/, `and the territory it actually reviewed — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// F2 — DEFERRAL WHEN SOMETHING ELSE COVERS THE DIFF (the already-shipped path,
// asserted here so the narrowing cannot turn it into a refusal).
// ===========================================================================

// EXPECTED STATE: GREEN today (file-scoping S2 already defers an attributed
// non-matching receipt when another receipt matches) AND after the narrowing.
// SABOTAGE: implement the narrowing as "a structured receipt matching nothing
// staged refuses the commit" WITHOUT the "if no other roster receipt covers the
// staged diff" qualifier -> exit 1 here, and the commit that legitimately has
// its own reviewer is blocked -> red. That is the single most likely
// over-implementation of §3 and F1 alone cannot see it.
test('structured-fallback F2: a STRUCTURED no-match receipt beside a receipt that DOES cover the staged diff — the covering receipt is stamped, the structured one survives un-consumed and is disclosed by name', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const laneBBlob = commitFile(dir, 'src/laneB.mjs', CODE);
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    const structured = v2({
      entry_id: 'f2000000-0000-4000-8000-000000000003',
      agent_type: 'reviewer-security',
      files: ['src/laneB.mjs'],
      blobs: { 'src/laneB.mjs': laneBBlob },
      base_sha: head,
      source: 'review-territory',
    });
    writeLedger(dir, [
      v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') } }),
      structured,
    ]);

    const r = runCommitReviewed(dir, ['-m', 'F2 covered by another receipt']);
    assert.equal(r.code, 0, `a commit whose diff IS covered must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'only the covering receipt is stamped — no false attestation for lane B');
    assert.deepEqual(readLedger(dir), [structured], 'the structured receipt survives byte-identical: deferred, not consumed, not deleted');
    assert.match(r.stderr, /DEFERRED RECEIPT/, `the withholding is disclosed through the already-shipped deferral channel — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /reviewer-security/, `and names the receipt — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// F3 — MIXED: ONE STRUCTURED NO-MATCH + ONE FREE-PROSE NO-MATCH.
// See header ambiguity (i): this pin encodes the launching brief's reading.
// ===========================================================================

// EXPECTED STATE: RED today — today's fallback stamps BOTH receipts and
// consumes both, so `reviewedByTrailers` is two entries and `readLedger` is
// empty: the trailer deepEqual and the survivor deepEqual both fail.
// SABOTAGE: apply the narrowing to the whole INVOCATION rather than per
// receipt ("if any receipt is structured, no receipt falls back") -> the
// free-prose receipt is not stamped either, and the trailer assertion reddens.
// SECOND SABOTAGE: keep the fallback for the structured receipt -> two trailers
// and an emptied ledger -> red.
// IF THIS PIN GOES RED WITH exit 1 AND AN EMPTY TRAILER SET, read the header's
// ambiguity (i) before treating it as an implementation defect.
test('structured-fallback F3: with ONE structured no-match and ONE free-prose no-match and nothing else, the FREE-PROSE receipt alone falls back and stamps — the structured one defers and survives', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const laneBBlob = commitFile(dir, 'src/laneB.mjs', CODE);
    const laneCBlob = commitFile(dir, 'src/laneC.mjs', CODE);
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    const structured = v2({
      entry_id: 'f3000000-0000-4000-8000-000000000004',
      agent_type: 'reviewer-security',
      files: ['src/laneB.mjs'],
      blobs: { 'src/laneB.mjs': laneBBlob },
      base_sha: head,
      source: 'review-territory',
    });
    const freeProse = v2({
      entry_id: 'f3000000-0000-4000-8000-000000000005',
      agent_type: 'reviewer-freeprose',
      files: ['src/laneC.mjs'],
      blobs: { 'src/laneC.mjs': laneCBlob },
      base_sha: head,
      source: 'free-prose-fallback',
    });
    writeLedger(dir, [structured, freeProse]);

    const r = runCommitReviewed(dir, ['-m', 'F3 mixed attribution, nothing matches']);
    assert.equal(r.code, 0, `the surviving free-prose fallback carries this commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-freeprose'], 'ONLY the free-prose receipt falls back — the structured one is never stamped onto a diff it did not cover');
    assert.deepEqual(readLedger(dir), [structured], 'and the structured receipt survives byte-identical, un-consumed');
    assert.match(r.stderr, /reviewer-security/, `the withheld structured receipt is disclosed by name, never silently dropped — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// F4 — THE NARROWING NEVER REACHES UNVERIFIABLE TERRITORY (CONTROL).
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the narrowing. §3 scopes the removal to
// STRUCTURED territory, which decision 57984926 §3 states as
// "source:'review-territory'" with the classifier's own precondition
// "structured NON-EMPTY territory"; file-scoping S4 already pins that an empty
// files[] is the STRONGEST unverifiable-territory signal, never a non-match.
// SABOTAGE: treat source:'review-territory' as structured REGARDLESS of whether
// files[] is non-empty -> this receipt is deferred, the commit refuses, and
// merge-gate review evidence for a real "review only, do not modify" dispatch
// is silently withheld -> every assertion red.
test('structured-fallback F4 (CONTROL): a v2 receipt with source review-territory but an EMPTY files[] is unverifiable territory, not a non-match — still stamped and consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [
      v2({
        entry_id: 'f4000000-0000-4000-8000-000000000006',
        agent_type: 'reviewer-blank',
        files: [],
        blobs: {},
        base_sha: head,
        source: 'review-territory',
      }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'F4 structured but empty territory']);
    assert.equal(r.code, 0, `empty territory is unverifiable, never a non-match — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-blank'], 'the unattributed receipt is stamped exactly as file-scoping S4 requires');
    assert.deepEqual(readLedger(dir), [], 'and consumed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// F5 — AMBIGUITY PIN (header (ii)): the FLAT pre-v2 `files_source` spelling.
// Asserts only the invariant that holds under EITHER reading.
// ===========================================================================

// EXPECTED STATE: today exit 0 with a stamp, so today it passes through the
// "fallback survives" branch below. It is written to survive EITHER
// adjudication; what it forbids is the silent third outcome — a receipt that is
// neither stamped nor deferred, i.e. evidence destroyed without disclosure.
// SABOTAGE: consume the flat-structured receipt without stamping it (drop it
// from the fallback set but still splice it out of the ledger) -> under the
// exit-0 branch the trailer assertion reddens; under the exit-1 branch the
// byte-identical assertion reddens. Either way the silent-destruction shape is
// caught, which is the one outcome BOTH readings forbid.
test('structured-fallback F5 (AMBIGUITY, either reading): a v1 receipt carrying the FLAT files_source "review-territory" and matching nothing is never silently dropped — stamped+consumed, or deferred+preserved with disclosure', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const laneBBlob = commitFile(dir, 'src/laneB.mjs', CODE);
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [
      v1({
        agent_type: 'reviewer-flatstructured',
        files: ['src/laneB.mjs'],
        blobs: { 'src/laneB.mjs': laneBBlob },
        files_source: 'review-territory',
      }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'F5 flat files_source']);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `the flat spelling must never crash the CLI — stderr=${flat(r.stderr)}`);

    if (r.code === 0) {
      assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'if it commits, the commit really happened');
      assert.deepEqual(reviewedByTrailers(dir), ['reviewer-flatstructured'], 'if the flat spelling reads as LEGACY, the fallback stamps it — it is never consumed without being stamped');
      assert.deepEqual(readLedger(dir), [], 'and consumed');
    } else {
      assert.equal(r.code, 1, `a refusal is exit 1, never another code — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'if the flat spelling reads as STRUCTURED, no commit was created');
      assert.equal(readLedgerRaw(dir), before, 'and nothing was consumed');
      assert.match(r.stderr, /reviewer-flatstructured/, `and the withheld receipt is named — stderr=${flat(r.stderr)}`);
    }
  } finally {
    cleanup();
  }
});
