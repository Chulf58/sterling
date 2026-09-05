// COMMIT-REVIEWED — UNATTRIBUTABLE RECEIPT CLASS (board c9f92090, slice 2,
// spec item (b)). SPEC ONLY, red-first, authored from the board record
// (opened via board_get), not from scripts/commit-reviewed.mjs's internals
// (H4 read wall honored — that CLI was never opened by this file's author).
//
// SPEC UNDER TEST (board c9f92090, verbatim clause (b)):
//   "commit-reviewed gains a class for source:'unattributable' -> NEVER
//    stamped, never consumed, left in the ledger with disclosure (the
//    DEFERRED posture); empty files[] WITHOUT that source keeps c45b6ee4
//    stamping so legacy receipts are unchanged."
// Board narrative context (design-settling note, same record): "the original
// 'files:[] source:unattributable' shape was FATAL AS WRITTEN: commit-reviewed
// classifies an EMPTY files[] as UNATTRIBUTED and ALWAYS STAMPS it (decision
// c45b6ee4), so an unattributable receipt with files:[] would stamp every
// commit unconditionally, weaker than today's misattributed receipt." — i.e.
// the whole reason this file exists is to pin that territory.source:
// 'unattributable' OVERRIDES the pre-existing "empty files[] -> always stamp"
// rule, not the other way around.
//
// HARNESS PROVENANCE: git()/makeRepo()/ledgerPath()/writeLedger()/readLedger()/
// readLedgerRaw()/stageChange()/commitFile()/stagedBlob()/runCommitReviewed()/
// reviewedByTrailers()/v2()/flat()/isoAgo() are the
// scripts/tests/commit-reviewed-structured-fallback.test.mjs and
// scripts/tests/commit-reviewed-spend-warnings.test.mjs idioms (both
// confirmed to exist via Read before writing this file), reused without
// importing or modifying either. Deliberate harness-only deviation: the
// mkdtemp prefix is 'sterling-commit-reviewed-unattributable-' so this suite
// cannot collide with its siblings in tmpdir. Standalone file: its own
// fixtures, no shared imports from any sibling test file.
//
// SABOTAGE (named by the launching brief, applies to every non-control test
// below): "commit-reviewed class flipped back to UNATTRIBUTED" — i.e. treat
// territory.source:'unattributable' as though it were the pre-existing
// c45b6ee4 UNATTRIBUTED classification (empty-files-always-stamp) instead of
// its own never-stamp class. Under that sabotage, U1/U2/U3 all go red (the
// receipt gets stamped and consumed instead of surviving un-consumed), while
// U0 (the control, which is genuinely the old UNATTRIBUTED shape) stays
// green regardless — which is exactly why U0 alone could never catch this
// sabotage.
// ===========================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-unattributable-'));
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

// Commits `relPath` at `content` and returns its blob sha — used so a
// receipt's declared territory really exists in the tree and its recorded
// blob really matches it (no reviewed-bytes REFUSE-flip ambiguity, decision
// 57984926 §2, contaminating a pin whose verdict is about source-gating).
function commitFile(dir, relPath, content) {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', `seed ${relPath}`]);
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

// v2 (nested) receipt, shape per decision 57984926 §1 (already-shipped) plus
// this slice's new `source: 'unattributable'` literal.
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

function parseSummary(r) {
  let summary;
  assert.doesNotThrow(() => {
    summary = JSON.parse(r.stdout);
  }, `a successful commit must print a parseable JSON summary on stdout — stdout=${flat(r.stdout)}`);
  return summary;
}

// ===========================================================================
// U0 (CONTROL, placed FIRST): an EMPTY files[] WITHOUT territory.source:
// 'unattributable' is the pre-existing decision c45b6ee4 UNATTRIBUTED
// classification — it still ALWAYS stamps. Without this control, a green
// U1/U2/U3 (all "never stamped") is indistinguishable from "commit-reviewed
// now refuses to stamp any empty-files receipt", which would silently break
// every legacy receipt that relies on c45b6ee4.
// EXPECTED STATE: GREEN today AND after this slice (c45b6ee4 is unaffected;
// this slice only adds a NEW class, it narrows nothing that already stamps).
// SABOTAGE: narrow the never-stamp rule to "territory.files is empty" instead
// of "territory.source === 'unattributable'" — this receipt (empty files,
// ordinary source) would then defer/refuse instead of stamp, reddening
// every assertion below.
// ===========================================================================

test('unattributable U0 (CONTROL, placed FIRST): an EMPTY files[] WITHOUT source:"unattributable" is the pre-existing UNATTRIBUTED class — still ALWAYS stamped and consumed (decision c45b6ee4 unaffected)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [
      v2({
        entry_id: 'u0000000-0000-4000-8000-000000000000',
        agent_type: 'reviewer-blank',
        files: [],
        blobs: {},
        base_sha: head,
        source: 'review-territory',
      }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'U0 control: ordinary empty-territory receipt']);
    assert.equal(r.code, 0, `an ordinary empty-files receipt (no unattributable marker) must still succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-blank'], 'stamped exactly as decision c45b6ee4 requires');
    assert.deepEqual(readLedger(dir), [], 'and consumed');

    const summary = parseSummary(r);
    assert.deepEqual(summary.unattributable_receipts ?? [], [], 'no unattributable_receipts on a clean run — the key, if present, is empty, never populated by an ordinary empty-files receipt');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// U1 (THE DEFECT FIX): territory.source:'unattributable' with an EMPTY
// files[] — the exact shape the board record calls "FATAL AS WRITTEN" —
// must NEVER be stamped, despite being structurally identical to U0's
// always-stamp shape except for the source field.
// EXPECTED STATE: RED before this slice (today's c45b6ee4 classifier reads
// only "files[] is empty", so this receipt would stamp exactly like U0).
// SABOTAGE: the named mutation — treat source:'unattributable' as a synonym
// for the pre-existing UNATTRIBUTED class (empty-files-always-stamp) —
// reddens every assertion below identically to how U0 passes.
// ===========================================================================

test('unattributable U1 (THE DEFECT FIX): territory.source:"unattributable" with an EMPTY files[] is the ONLY entry present — the commit REFUSES, nothing is stamped, ledger survives byte-identical, disclosed by name', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [
      v2({
        entry_id: 'u1000000-0000-4000-8000-000000000001',
        agent_type: 'reviewer-unsafe',
        files: [],
        blobs: {},
        base_sha: head,
        source: 'unattributable',
      }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'U1 unattributable, empty files, sole entry']);
    assert.equal(r.code, 1, `an unattributable receipt is never eligible to stamp — with nothing else present the commit REFUSES — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'NO commit was created');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed — the unattributable receipt survives byte-identical through the refusal');
    assert.match(r.stderr, /reviewer-unsafe/, `the refusal names the withheld receipt — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /unattributable/i, `and states why it was withheld — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// U2: territory.source:'unattributable' with NON-EMPTY files[] that DO
// overlap the staged diff — proves the gating is on the source field alone,
// never on file-overlap (a receipt that WOULD otherwise be a clean MATCHED
// stamp is still withheld).
// EXPECTED STATE: RED before this slice.
// SABOTAGE: same named mutation as U1 — this receipt would stamp (its files
// genuinely overlap), reddening the byte-identical/no-trailer assertions.
// ===========================================================================

test('unattributable U2: territory.source:"unattributable" with files[] that DO overlap the staged diff is STILL never stamped — the source field gates, not file-overlap', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const laneBBlob = commitFile(dir, 'src/laneB.mjs', CODE);
    stageChange(dir, 'src/laneB.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const stagedBlob = git(dir, ['hash-object', 'src/laneB.mjs']);

    writeLedger(dir, [
      v2({
        entry_id: 'u2000000-0000-4000-8000-000000000002',
        agent_type: 'reviewer-unsafe-overlap',
        files: ['src/laneB.mjs'],
        blobs: { 'src/laneB.mjs': stagedBlob },
        base_sha: head,
        source: 'unattributable',
      }),
    ]);
    const before = readLedgerRaw(dir);
    void laneBBlob; // seeded only to establish a real prior blob; not asserted directly

    const r = runCommitReviewed(dir, ['-m', 'U2 unattributable, overlapping files, sole entry']);
    assert.equal(r.code, 1, `overlap never rescues an unattributable receipt — the commit REFUSES — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'NO commit was created');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed');
    assert.match(r.stderr, /reviewer-unsafe-overlap/, `the refusal names the withheld receipt — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// U3: a MIXED ledger — one ELIGIBLE receipt covering the staged diff, one
// unattributable receipt (also overlapping, to keep file-match from being a
// confound) — the commit succeeds, stamps ONLY the eligible receipt, and the
// unattributable one survives un-consumed, disclosed by name AND reported in
// summary.unattributable_receipts.
// EXPECTED STATE: RED before this slice (today the unattributable receipt has
// no distinct class at all, so with non-empty overlapping files it would be
// MATCHED and stamped alongside the eligible one — two trailers instead of
// one).
// SABOTAGE: same named mutation — the unattributable receipt gets stamped
// too, producing two trailers and an emptied ledger.
// ===========================================================================

test('unattributable U3: a MIXED ledger stamps the ELIGIBLE receipt and leaves the unattributable one un-consumed, disclosed by name and in unattributable_receipts', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const laneABlob = commitFile(dir, 'src/laneA.mjs', CODE);
    stageChange(dir, 'src/laneA.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const stagedBlob = git(dir, ['hash-object', 'src/laneA.mjs']);
    void laneABlob;

    const eligible = v2({
      entry_id: 'u3000000-0000-4000-8000-000000000003',
      agent_type: 'reviewer-eligible',
      files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': stagedBlob },
      base_sha: head,
      source: 'review-territory',
    });
    const unattributable = v2({
      entry_id: 'u3000000-0000-4000-8000-000000000004',
      agent_type: 'reviewer-unsafe-mixed',
      files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': stagedBlob },
      base_sha: head,
      source: 'unattributable',
    });
    writeLedger(dir, [eligible, unattributable]);

    const r = runCommitReviewed(dir, ['-m', 'U3 mixed: one eligible, one unattributable']);
    assert.equal(r.code, 0, `at least one eligible receipt exists, so the commit succeeds — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-eligible'], 'ONLY the eligible receipt is stamped — the unattributable one never gets a trailer, even though its files genuinely overlap');

    const ledgerAfter = readLedger(dir);
    assert.equal(ledgerAfter.length, 1, 'exactly the unattributable receipt survives, un-consumed');
    assert.equal(ledgerAfter[0].entry_id, unattributable.entry_id);

    assert.match(r.stderr, /reviewer-unsafe-mixed/, `disclosure names the surviving unattributable receipt — stderr=${flat(r.stderr)}`);

    const summary = parseSummary(r);
    assert.ok(Array.isArray(summary.unattributable_receipts), `summary.unattributable_receipts must be an array — got ${JSON.stringify(summary.unattributable_receipts)}`);
    assert.ok(
      summary.unattributable_receipts.some((x) => JSON.stringify(x).includes('reviewer-unsafe-mixed')),
      `summary.unattributable_receipts must name the withheld receipt (reviewer-unsafe-mixed) — got ${JSON.stringify(summary.unattributable_receipts)}`
    );
    assert.ok(
      !summary.unattributable_receipts.some((x) => JSON.stringify(x).includes('reviewer-eligible')),
      'the eligible, stamped receipt must never appear in unattributable_receipts'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// U4 (--target-sha NEVER STAMPS UNATTRIBUTABLE, board c9f92090 clause (7)):
// U1-U3 above prove the never-stamp class through the ORDINARY -m flow only.
// The SAME gating must hold through --target-sha amend mode — the source
// field gates regardless of which commit path invoked it. Harness idiom
// (SEAM_ON / STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM) adapted from
// scripts/tests/commit-reviewed-target-sha.test.mjs (confirmed to exist via
// Read before writing this test), reused without importing.
// SABOTAGE: same named mutation as U1/U2/U3 (source:'unattributable' treated
// as the pre-existing UNATTRIBUTED class) — under --target-sha this receipt
// would amend the commit and stamp a trailer, reddening every assertion
// below.
// ===========================================================================

const SEAM_ON = { ...ENV_SESSION, STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM: '1' };

test('unattributable U4: --target-sha amend mode ALSO never stamps a source:"unattributable" receipt, even as the sole entry with matching base_sha', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneC.mjs', CODE);
    git(dir, ['commit', '-m', 'seed laneC, to be amended']);
    const targetSha = git(dir, ['rev-parse', 'HEAD']);
    const blob = git(dir, ['hash-object', 'src/laneC.mjs']);

    writeLedger(dir, [
      v2({
        entry_id: 'u4000000-0000-4000-8000-000000000005',
        agent_type: 'reviewer-unsafe-amend',
        files: ['src/laneC.mjs'],
        blobs: { 'src/laneC.mjs': blob },
        base_sha: targetSha,
        source: 'unattributable',
      }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.notEqual(r.code, 0, `an unattributable receipt is never eligible to amend-stamp — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'nothing was amended');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed — the receipt survives byte-identical');
    assert.match(r.stderr, /reviewer-unsafe-amend/, `the refusal names the withheld receipt — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /unattributable/i, 'and states why');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONSUME-DURING-REFRESH (board c9f92090 clause (5)): commit-reviewed
// records {finished_at, resume_count} at the ELIGIBILITY READ; at CONSUME
// time, if those markers moved (a concurrent H22 resume-refresh landed
// mid-commit — simulated here via a REAL git pre-commit hook, mirroring
// scripts/tests/commit-reviewed-hardening.test.mjs's installPreCommitHook
// idiom, confirmed to exist via Read, reproduced standalone here rather than
// imported), the entry is LEFT unconsumed with a named disclosure — the
// commit itself still succeeds and still stamps, because the trailer
// decision was already correct at the moment it was made; only the
// ledger's own bookkeeping defers to the fresher write. --target-sha amend
// mode gets the SAME protection with its own distinct disclosure wording.
// CONTROL is placed FIRST: without it, a green C1/C2 ("the entry survives")
// is indistinguishable from a far more aggressive, wrong implementation that
// never consumes ANYTHING (a broken/no-op consume step) — the control proves
// the ORDINARY, non-racing case still gets cleanly consumed.
// SABOTAGE (C1/C2): consume by blindly deleting every entry_id the CLI
// decided to stamp, ignoring whatever is on disk at consume time — the
// refreshed entry would be silently destroyed instead of surviving with its
// hook-written values, and neither disclosure would ever fire.
// SABOTAGE (CONTROL): make consume unconditionally skip deletion (mimicking
// "always defer") — the ledger would never empty, reddening the
// deepEqual([]) assertion, and this is exactly the pathology the CONTROL's
// placement-first exists to catch that C1/C2 alone cannot.
// ===========================================================================

function installPreCommitHook(dir, script) {
  const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hookPath, script, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
}

// Rewrites the named v2 entry (by entry_id) IN PLACE — same entry_id, bumped
// finished_at/resume_count — simulating a concurrent H22 resume-refresh
// landing while `git commit`/`git commit --amend` is mid-flight.
const refreshHookScript = (entryId, newFinishedAt) => `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(process.cwd(), '.sterling', 'review-ledger.json');
let entries = [];
try { entries = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { entries = []; }
const idx = entries.findIndex((e) => e.entry_id === '${entryId}');
if (idx !== -1) {
  const prev = entries[idx];
  entries[idx] = Object.assign({}, prev, { finished_at: '${newFinishedAt}', resume_count: (prev.resume_count || 0) + 1 });
}
fs.writeFileSync(p, JSON.stringify(entries));
`;

test('CONSUME-DURING-REFRESH CONTROL (placed FIRST): an UNTOUCHED entry (no concurrent refresh) consumes normally — no disclosure, ledger emptied', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneF.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const stagedBlob = git(dir, ['hash-object', 'src/laneF.mjs']);

    writeLedger(dir, [
      v2({ entry_id: 'c0000000-0000-4000-8000-000000000012', agent_type: 'reviewer-consume-control', files: ['src/laneF.mjs'], blobs: { 'src/laneF.mjs': stagedBlob }, base_sha: head, source: 'review-territory' }),
    ]);
    // Deliberately no pre-commit hook installed at all.

    const r = runCommitReviewed(dir, ['-m', 'control: nothing refreshes mid-commit']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-consume-control']);
    assert.deepEqual(readLedger(dir), [], 'with no concurrent refresh, the entry is consumed exactly as the base spec pins');
    assert.doesNotMatch(r.stderr, /REFRESHED DURING (COMMIT|AMEND)/, 'no spurious disclosure when nothing actually raced');
  } finally {
    cleanup();
  }
});

test('CONSUME-DURING-REFRESH C1 (-m path): a pre-commit hook that refreshes the stamped v2 entry mid-commit leaves it un-consumed with its REFRESHED values — commit still succeeds and stamps', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const entryId = 'c1000000-0000-4000-8000-000000000010';
    stageChange(dir, 'src/laneD.mjs', STAGED);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const stagedBlob = git(dir, ['hash-object', 'src/laneD.mjs']);

    writeLedger(dir, [
      v2({ entry_id: entryId, agent_type: 'reviewer-consume', files: ['src/laneD.mjs'], blobs: { 'src/laneD.mjs': stagedBlob }, base_sha: head, source: 'review-territory' }),
    ]);
    installPreCommitHook(dir, refreshHookScript(entryId, '2026-09-05T12:00:00.000Z'));

    const r = runCommitReviewed(dir, ['-m', 'C1 refreshed mid-commit']);
    assert.equal(r.code, 0, `the commit succeeds — the pre-commit hook itself exits 0 — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-consume'], 'the trailer is stamped — the eligibility decision made before the hook ran was correct and stands');

    const ledgerAfter = readLedger(dir);
    assert.equal(ledgerAfter.length, 1, 'the entry SURVIVES — it is left un-consumed, never silently deleted');
    assert.equal(ledgerAfter[0].entry_id, entryId);
    assert.equal(ledgerAfter[0].finished_at, '2026-09-05T12:00:00.000Z', "the surviving entry carries the HOOK's refreshed finished_at, not the original");
    assert.equal(ledgerAfter[0].resume_count, 1, "and the hook's bumped resume_count");
    assert.match(r.stderr, /REFRESHED DURING COMMIT/, 'the deferred consume is disclosed by exact name');
  } finally {
    cleanup();
  }
});

test('CONSUME-DURING-REFRESH C2 (--target-sha amend twin): the SAME mid-commit refresh during an amend leaves the entry un-consumed with a DURING AMEND disclosure — the amend still succeeds and stamps', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const entryId = 'c2000000-0000-4000-8000-000000000011';
    stageChange(dir, 'src/laneE.mjs', CODE);
    git(dir, ['commit', '-m', 'seed laneE, to be amended']);
    const targetSha = git(dir, ['rev-parse', 'HEAD']);
    const blob = git(dir, ['hash-object', 'src/laneE.mjs']);

    writeLedger(dir, [
      v2({ entry_id: entryId, agent_type: 'reviewer-consume-amend', files: ['src/laneE.mjs'], blobs: { 'src/laneE.mjs': blob }, base_sha: targetSha, source: 'review-territory' }),
    ]);
    installPreCommitHook(dir, refreshHookScript(entryId, '2026-09-05T13:00:00.000Z'));

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.equal(r.code, 0, `the amend succeeds — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), targetSha, 'the commit was amended (new sha)');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-consume-amend'], 'the trailer is stamped on the amended commit');

    const ledgerAfter = readLedger(dir);
    assert.equal(ledgerAfter.length, 1, 'the entry survives un-consumed');
    assert.equal(ledgerAfter[0].entry_id, entryId);
    assert.equal(ledgerAfter[0].finished_at, '2026-09-05T13:00:00.000Z', "carries the hook's refreshed finished_at");
    assert.match(r.stderr, /DURING AMEND/, 'the amend twin names its own disclosure distinctly');
  } finally {
    cleanup();
  }
});
