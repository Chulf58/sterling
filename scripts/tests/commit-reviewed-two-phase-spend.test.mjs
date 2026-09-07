// COMMIT-REVIEWED — TWO-PHASE SPEND: select → reserve → commit → verify → finalize
// (R1 pin re-cut, group D; NEW FILE).
//
// AUTHORITY: decision `review-receipt-rebuild-invariant-three-owner-modules-tri-state-liveness-receipt-bound-supersession`
// (knowledge_get 24dc4c63) — "SPEND is two-phase and merge-gate-bound: under the lock,
// re-read, validate, RESERVE the selected entry ids (by entry_id …) with an operation
// nonce and the exact index blob map; commit; verify the commit tree and trailers; under
// the lock, FINALIZE the same reservations as consumed {commit_sha, consumed_at}; on crash
// a `reconcile` verb finalizes a uniquely matching commit or releases the reservation."
// Contract sheet §3.2 steps 1-5, §3.1 `reconcile`, §6 A5 (no age-based lock takeover),
// A9 (reservation.index_blobs = ONLY that receipt's covered paths staged in this commit).
//
// HOW THE INTERMEDIATE PHASE IS OBSERVED WITHOUT READING THE IMPLEMENTATION: a real git
// pre-commit hook snapshots .sterling/review-ledger.json while `git commit` is mid-flight —
// i.e. AFTER reserve and BEFORE finalize. That snapshot is the only honest evidence that
// two phases exist at all; without it "the ledger ended up consumed" is satisfied by a
// single-phase write, and "the ledger is unchanged after a failed commit" is satisfied by
// never reserving anything.
//
// Refusals/disclosures are asserted by their `[code]` token or by --json's `code`/`facts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = join(root, 'scripts', 'commit-reviewed.mjs');
const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();
// Permission-based injection is meaningless as root and unavailable on win32.
const PERM_SKIP = GIT_SKIP
  || (process.platform === 'win32' ? 'directory-permission injection is not available on win32' : false)
  || ((typeof process.getuid === 'function' && process.getuid() === 0) ? 'running as root: a read-only directory does not deny writes' : false);

const token = (c) => new RegExp('\\[' + c + '\\]');
const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-two-phase-'));
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
  return { dir, cleanup: () => { try { chmodSync(join(dir, '.sterling'), 0o755); } catch { /* already writable */ } rmSync(dir, { recursive: true, force: true }); } };
}

const ledgerPath = (dir) => join(dir, '.sterling', 'review-ledger.json');
const writeLedger = (dir, entries) => writeFileSync(ledgerPath(dir), JSON.stringify(entries));
const readLedger = (dir) => (existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null);
const readLedgerRaw = (dir) => (existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null);
const entryById = (dir, id) => (readLedger(dir) ?? []).find((e) => e.entry_id === id);

function stageChange(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

function indexBlob(dir, relPath) {
  const out = git(dir, ['ls-files', '-s', '--', relPath]);
  const m = out.match(/^\d+ ([0-9a-f]{40}) \d+\t/);
  assert.ok(m, `fixture guard: ${relPath} must be staged in the index — got ${out}`);
  return m[1];
}

function runCommitReviewed(dir, args = [], env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function runReviewLedger(dir, args = [], env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
const receiptTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Receipt', sha);
const waiverTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Bytes-Waiver', sha);

function soleJson(r) {
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `--json must print exactly ONE JSON object on stdout — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
  return parsed;
}

function v2({
  entry_id, agent_type, files, blobs = {}, base_sha, status = 'active',
  source = 'review-territory', evidence_status = 'complete', at = isoAgo(60_000),
  session_id = SESSION, branch = 'main', reservation, consumption,
}) {
  const e = {
    schema_version: 2, entry_id, kind: 'roster_receipt', status,
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch, base_sha, agent_id: `agent-${entry_id.slice(0, 8)}` },
    territory: { files, source, attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot', status: evidence_status, blobs,
      absent_paths: [], truncated_of: null, failure_reason: null,
    },
    disposition: null,
  };
  if (reservation !== undefined) e.reservation = reservation;
  if (consumption !== undefined) e.consumption = consumption;
  return e;
}

// A REAL pre-commit hook that snapshots the ledger mid-`git commit` — i.e. after RESERVE
// and before FINALIZE. `exitCode` 1 makes the commit itself fail (arm D104).
const snapshotHook = (exitCode = 0) => `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const src = path.join(process.cwd(), '.sterling', 'review-ledger.json');
const dst = path.join(process.cwd(), '.sterling', 'mid-commit-snapshot.json');
try { fs.copyFileSync(src, dst); } catch (e) { fs.writeFileSync(dst, JSON.stringify({ snapshot_error: String(e && e.message) })); }
process.exit(${exitCode});
`;

// A REAL post-commit hook — it runs AFTER the commit object exists and BEFORE
// commit-reviewed's finalize step. Making .sterling read-only here is the injection the
// decision's crash path describes: the commit is durable, the ledger write is not.
const FREEZE_STERLING_HOOK = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.chmodSync(path.join(process.cwd(), '.sterling'), 0o555);
`;

function installHook(dir, name, script) {
  const p = join(dir, '.git', 'hooks', name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
}
const readSnapshot = (dir) => {
  const p = join(dir, '.sterling', 'mid-commit-snapshot.json');
  assert.ok(existsSync(p), 'fixture guard: the pre-commit hook must have run and snapshotted the ledger');
  return JSON.parse(readFileSync(p, 'utf8'));
};
const snapshotEntry = (dir, id) => readSnapshot(dir).find((e) => e.entry_id === id);

const CODE = 'export const f = 1;\n';
const OTHER = 'export const g = 2;\n';

// Amend-mode harness (R1-D113 only) — the same seam the --target-sha suite uses.
const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};
const seedConfig = (dir) => writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
const SEAM_ON = { ...ENV_SESSION, STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM: '1' };
const treeBlob = (dir, sha, relPath) => git(dir, ['rev-parse', `${sha}:${relPath}`]);
function hashBytes(dir, content) {
  const r = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: content, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git hash-object --stdin: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

// ===========================================================================
// R1-D100 — THE CONTROL, PLACED FIRST. It is the only arm that proves the spend
// passes through a RESERVED state at all; every other arm below is this fixture
// minus one property, so none of their verdicts is attributable without it.
// ===========================================================================

// EXPECTED: RED today — today's spend is single-phase (read, commit, rewrite the ledger
// minus the stamped entries), so the mid-commit snapshot shows the entry still 'active'
// (or, with today's consume-on-success shape, unchanged), there is no reservation object,
// and the final state is DELETION rather than status 'consumed'.
// SABOTAGE: collapse reserve+finalize into one post-commit write -> the snapshot's
// status/reservation assertions red while the final-state assertions stay green. That
// exact pair of results is the signature of a single-phase implementation.
test('R1-D100 (CONTROL, first): a spend passes through RESERVED mid-commit and lands CONSUMED — reservation {nonce, operation} observed while git commit runs, then status consumed with consumption.commit_sha === HEAD and the reservation cleared', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installHook(dir, 'pre-commit', snapshotHook(0));
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '10000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D100 two-phase happy path']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'the commit was created');

    // PHASE 2 observed mid-flight.
    const mid = snapshotEntry(dir, id);
    assert.ok(mid, `the entry must still exist mid-commit — snapshot=${JSON.stringify(readSnapshot(dir))}`);
    assert.equal(mid.status, 'reserved', `mid-commit the entry is RESERVED, not active and not yet consumed — got ${JSON.stringify(mid.status)}`);
    assert.equal(mid.reservation?.operation, 'commit-reviewed', `got ${JSON.stringify(mid.reservation)}`);
    assert.ok(typeof mid.reservation?.nonce === 'string' && mid.reservation.nonce.length > 0, `the reservation carries an operation nonce — got ${JSON.stringify(mid.reservation)}`);
    assert.ok(typeof mid.reservation?.at === 'string' && mid.reservation.at.length > 0, `and when it was taken — got ${JSON.stringify(mid.reservation)}`);
    assert.equal(mid.consumption, undefined, 'and carries NO consumption yet — a consumption written before the commit exists would name a sha that may never land');

    // PHASE 5 observed after.
    const after = entryById(dir, id);
    assert.ok(after, 'the entry is still PRESENT — consumption is a status transition, never a deletion');
    assert.equal(after.status, 'consumed', `got ${JSON.stringify(after.status)}`);
    assert.equal(after.consumption?.commit_sha, head, 'consumption.commit_sha is the sha this run created');
    assert.equal(after.consumption?.nonce, mid.reservation.nonce, 'FINALIZE closes THE SAME reservation it opened — the nonce carries across');
    assert.equal(after.reservation, undefined, 'and the reservation is cleared once consumed');
    assert.deepEqual(receiptTrailers(dir), [id], 'one Review-Receipt trailer per receipt');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'beside one Reviewed-By-Agent trailer per receipt');
  } finally { cleanup(); }
});

// EXPECTED: RED today — no reservation object exists at all, so `mid.reservation` is
// undefined and the deepEqual fires.
// SABOTAGE: set reservation.index_blobs to the WHOLE staged index map (or to every declared
// path of the receipt) instead of only that receipt's covered paths staged in this commit ->
// the deepEqual reds. This is the pin for A9's narrowing: an over-wide reservation makes the
// verify step compare bytes the receipt never covered, which either fails legitimate spends
// or silently binds a commit to evidence that does not exist.
test('R1-D101: reservation.index_blobs contains EXACTLY that receipt\'s covered paths staged in this commit — not its unstaged declared paths, not another receipt\'s paths', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installHook(dir, 'pre-commit', snapshotHook(0));
    // src/laneUnstaged.mjs exists in HEAD and is DECLARED by receipt A, but is not staged.
    stageChange(dir, 'src/laneUnstaged.mjs', CODE);
    git(dir, ['commit', '-m', 'seed unstaged lane']);
    stageChange(dir, 'src/laneA.mjs', CODE);
    stageChange(dir, 'src/laneB.mjs', OTHER);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = '10100000-0000-4000-8000-000000000001';
    const idB = '10100000-0000-4000-8000-000000000002';
    const blobA = indexBlob(dir, 'src/laneA.mjs');
    const blobB = indexBlob(dir, 'src/laneB.mjs');
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs', 'src/laneUnstaged.mjs'], blobs: { 'src/laneA.mjs': blobA, 'src/laneUnstaged.mjs': git(dir, ['rev-parse', 'HEAD:src/laneUnstaged.mjs']) }, base_sha: base }),
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': blobB }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D101 reservation scope']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);

    assert.deepEqual(snapshotEntry(dir, idA).reservation.index_blobs, { 'src/laneA.mjs': blobA },
      `receipt A reserves only its own STAGED covered path — got ${JSON.stringify(snapshotEntry(dir, idA).reservation)}`);
    assert.deepEqual(snapshotEntry(dir, idB).reservation.index_blobs, { 'src/laneB.mjs': blobB },
      `and receipt B only its own — got ${JSON.stringify(snapshotEntry(dir, idB).reservation)}`);
  } finally { cleanup(); }
});

// EXPECTED: RED today — 'reserved' is not a status today, so a hand-written reserved entry
// is either read as spendable (exit 0, double-booked) or ignored with the generic
// zero-entries prose; [reservation_conflict] does not exist.
// SABOTAGE: treat a reserved entry as selectable (select on `status !== 'consumed'`) -> the
// run commits and steals a reservation another operation holds -> exit 0 and every
// assertion reds.
test('R1-D102: a receipt already RESERVED by another operation is not selectable — as the sole candidate the run refuses [reservation_conflict], nothing committed, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '10200000-0000-4000-8000-000000000001';
    const blob = indexBlob(dir, 'src/laneA.mjs');
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': blob }, base_sha: base, status: 'reserved',
      reservation: { nonce: 'other-operation-nonce', at: isoAgo(5_000), operation: 'commit-reviewed', index_blobs: { 'src/laneA.mjs': blob } },
    })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D102 reserved elsewhere', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.equal(soleJson(r).code, 'reservation_conflict', `got ${flat(r.stdout)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'nothing committed');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical — another operation\'s reservation is never overwritten');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the first run deletes the entry, so the second run refuses with the
// zero-entries prose and there is no consumed entry left whose consumption.commit_sha could
// be checked for re-pointing.
// SABOTAGE: finalize by setting consumption unconditionally on every entry named in the
// trailer block -> the second run re-points the first receipt at the new sha -> the
// "unchanged" assertion reds while the exit code stays 1.
test('R1-D103 (MULTIPLICITY): a consumed receipt is never spent twice, and a later run never RE-POINTS its consumption.commit_sha at a newer commit', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '10300000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const first = runCommitReviewed(dir, ['-m', 'D103 first spend']);
    assert.equal(first.code, 0, `stdout=${flat(first.stdout)} stderr=${flat(first.stderr)}`);
    const firstSha = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(entryById(dir, id).consumption.commit_sha, firstSha, 'fixture guard: round one really consumed it');

    // Stage a further change on the SAME path — the receipt's territory still overlaps.
    stageChange(dir, 'src/laneA.mjs', 'export const f = 99;\n');
    const second = runCommitReviewed(dir, ['-m', 'D103 second spend attempt']);
    assert.equal(second.code, 1, `a consumed receipt must not carry a second commit — stdout=${flat(second.stdout)} stderr=${flat(second.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), firstSha, 'no second commit was created');
    assert.equal(entryById(dir, id).consumption.commit_sha, firstSha, 'and the original consumption is UNCHANGED — never re-pointed');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the mid-commit snapshot shows no reservation (single-phase), so the
// "was reserved" assertion fires. The byte-identical assertion may pass today for the wrong
// reason (nothing was ever written), which is exactly why the snapshot assertion is first.
// SABOTAGE: on a failed `git commit`, exit without releasing -> the entry is left 'reserved'
// forever and the post-run byte-identical assertion reds. That is the leak the release path
// exists to prevent: a lost commit would otherwise strand real review evidence.
// SECOND SABOTAGE: release by rewriting the entry with re-serialized fields (same logical
// content, different bytes) -> the raw-bytes assertion reds while the status assertion stays
// green.
test('R1-D104: when `git commit` itself fails, the reservation is RELEASED — the entry was demonstrably reserved mid-flight and the ledger is byte-identical to its pre-run bytes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installHook(dir, 'pre-commit', snapshotHook(1)); // snapshot, then fail the commit
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '10400000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D104 commit fails']);
    assert.equal(r.code, 1, `a failed commit must propagate as exit 1 — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.match(`${r.stdout}\n${r.stderr}`, token('commit_failed'), `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit was created');

    assert.equal(snapshotEntry(dir, id).status, 'reserved', 'CONTROL HALF: the entry really WAS reserved before the commit failed — without this, "byte-identical" is satisfied by never reserving');
    assert.equal(readLedgerRaw(dir), before, 'and the release restores the ledger to its exact pre-run bytes');
    assert.equal(entryById(dir, id).status, 'active', 'the receipt is spendable again');
  } finally { cleanup(); }
});

// EXPECTED: RED today — there is no reserved state and no [finalize_failed] code; today's
// post-commit failure path reports its own prose.
// INJECTION: a post-commit hook makes .sterling read-only, so the durable commit exists but
// the finalize write cannot land. This is the one arm whose injection mechanism I could not
// execute (no Bash in this role); if it does not reach the finalize step, R1-D106 below
// pins the same contract through the reconcile remedy and is the fallback the brief allows.
// SABOTAGE: swallow the finalize write error and report success -> exit 0 while the ledger
// still says 'reserved' -> a merge-gate-visible commit exists whose receipt is unbound; both
// the exit-code and the [finalize_failed] assertions red.
test('R1-D105: when FINALIZE cannot write after the commit exists, entries stay RESERVED and the run exits 1 with [finalize_failed], facts.reserved[] naming them and the reconcile remedy', { skip: PERM_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installHook(dir, 'post-commit', FREEZE_STERLING_HOOK);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '10500000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D105 finalize cannot write', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'fixture guard: the commit itself DID land — this is the post-commit failure class, not a refusal');
    const out = soleJson(r);
    assert.equal(out.code, 'finalize_failed', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.reserved, [id], `facts.reserved names every entry left reserved — got ${JSON.stringify(out.facts)}`);
    assert.match(JSON.stringify(out.facts), /reconcile/, `and the facts carry the reconcile remedy — got ${JSON.stringify(out.facts)}`);

    chmodSync(join(dir, '.sterling'), 0o755);
    const stuck = entryById(dir, id);
    assert.equal(stuck.status, 'reserved', 'the entry is left RESERVED — never silently consumed, never silently released while a commit naming it exists');
    assert.equal(stuck.consumption, undefined, 'and carries no consumption');
  } finally { cleanup(); }
});

// EXPECTED: RED today — `reconcile` does not exist as a verb (contract sheet §3.1 adds it),
// so the CLI refuses with a usage error and the status stays 'reserved'.
// SABOTAGE: finalize any reserved entry whose entry_id appears in ANY reachable commit
// without comparing the reservation's index_blobs to that commit's tree -> the arm below
// still passes, so this pin is paired with its own negative: the second half asserts a
// reserved entry with NO matching commit is RELEASED, not finalized. One arm alone cannot
// tell "finalize on match" from "finalize on anything".
test('R1-D106 (crash recovery): `review-ledger.mjs reconcile` finalizes a RESERVED entry whose Review-Receipt commit is reachable with a matching tree, and RELEASES one with no matching commit', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // A real commit carrying the Review-Receipt trailer for `bound`, created by plain git.
    const boundId = '10600000-0000-4000-8000-000000000001';
    const orphanId = '10600000-0000-4000-8000-000000000002';
    stageChange(dir, 'src/laneA.mjs', CODE);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    git(dir, ['commit', '-m', `D106 crashed spend\n\nReviewed-By-Agent: reviewer-correctness\nReview-Receipt: ${boundId}`]);
    const commitSha = git(dir, ['rev-parse', 'HEAD']);
    assert.deepEqual(receiptTrailers(dir), [boundId], 'fixture guard: the commit really carries the Review-Receipt trailer');

    writeLedger(dir, [
      v2({ entry_id: boundId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: commitSha, status: 'reserved',
        reservation: { nonce: 'crashed-nonce-1', at: isoAgo(60_000), operation: 'commit-reviewed', index_blobs: { 'src/laneA.mjs': blob } } }),
      v2({ entry_id: orphanId, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: commitSha, status: 'reserved',
        reservation: { nonce: 'crashed-nonce-2', at: isoAgo(60_000), operation: 'commit-reviewed', index_blobs: { 'src/laneA.mjs': blob } } }),
    ]);

    const r = runReviewLedger(dir, ['reconcile', '--json']);
    assert.equal(r.code, 0, `reconcile must succeed — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);

    const bound = entryById(dir, boundId);
    assert.equal(bound.status, 'consumed', `a uniquely matching commit finalizes the reservation — got ${JSON.stringify(bound.status)}`);
    assert.equal(bound.consumption?.commit_sha, commitSha, 'bound to THAT commit');
    assert.equal(bound.consumption?.nonce, 'crashed-nonce-1', 'closing the reservation it actually held');

    const orphan = entryById(dir, orphanId);
    assert.equal(orphan.status, 'active', 'a reservation with NO commit naming it is RELEASED, never finalized against someone else\'s commit');
    assert.equal(orphan.reservation, undefined, 'and its reservation is cleared');
    assert.equal(orphan.consumption, undefined, 'with no consumption invented');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the ledger lock is not an owner-mkdir mutex with a pid-verified
// takeover on this path, and [ledger_lock_held] does not exist.
// SABOTAGE (A5's whole subject): take the lock over on AGE instead of on a verified-dead pid
// -> the run commits straight through a lock a live writer holds -> exit 0 and every
// assertion reds. The fixture's owner pid is THIS process, which is provably alive, so an
// age rule and a liveness rule give opposite verdicts here.
test('R1-D107: a held ledger lock whose owner pid is ALIVE on this host refuses [ledger_lock_held] — nothing committed, ledger byte-identical, no age-based takeover', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '10700000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);
    const before = readLedgerRaw(dir);

    const lockDir = join(dir, '.sterling', 'review-ledger.lock');
    mkdirSync(lockDir, { recursive: true });
    // Deliberately OLD (`at` two hours ago) but owned by a LIVE pid on THIS host.
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: isoAgo(2 * 3_600_000), nonce: 'live-owner' }));

    const r = runCommitReviewed(dir, ['-m', 'D107 lock held', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'ledger_lock_held', `got ${JSON.stringify(out)}`);
    assert.equal(out.facts?.owner?.pid, process.pid, `the refusal names the owner it found — got ${JSON.stringify(out.facts)}`);
    assert.ok(typeof out.facts?.lock_dir === 'string' && out.facts.lock_dir.length > 0, `and the lock dir the operator must clear by hand — got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'nothing committed');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    assert.ok(existsSync(lockDir), 'and the lock is NOT stolen');
  } finally { cleanup(); }
});

// EXPECTED: RED today — no Review-Receipt trailer exists, so the receiptTrailers assertion
// fires; the waiver-count assertion also reds because today's advisory-only byte check
// stamps no waiver.
// SABOTAGE: stamp one Review-Receipt trailer per INVOCATION instead of one per receipt ->
// the two-element deepEqual reds while Reviewed-By-Agent stays correct, which is the shape
// that makes a multi-receipt commit unverifiable at the merge gate (direct-merge binds each
// trailer to one consumed receipt).
// SECOND SABOTAGE: stamp Review-Bytes-Waiver for every receipt rather than only waived ones
// -> the waiver deepEqual reds.
test('R1-D108: the trailer block carries one Reviewed-By-Agent and one Review-Receipt per SELECTED receipt, and one Review-Bytes-Waiver per WAIVED receipt only', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // laneA's bytes moved since review (waived); laneB's match (not waived).
    stageChange(dir, 'src/laneA.mjs', CODE);
    stageChange(dir, 'src/laneB.mjs', OTHER);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const staleBlob = 'b'.repeat(39) + '0';
    const idA = '10800000-0000-4000-8000-000000000001';
    const idB = '10800000-0000-4000-8000-000000000002';
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': staleBlob }, base_sha: base }),
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': indexBlob(dir, 'src/laneB.mjs') }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D108 trailers', '--waive-bytes', 'reviewer re-read the changed lines by hand']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.deepEqual(reviewedByTrailers(dir).sort(), ['reviewer-correctness', 'reviewer-security'], 'one roster trailer per receipt');
    assert.deepEqual(receiptTrailers(dir).sort(), [idA, idB].sort(), 'one Review-Receipt trailer per receipt, valued by entry_id');
    assert.deepEqual(waiverTrailers(dir), [idA], 'exactly one waiver trailer, for the AFFECTED receipt only');
    assertBothConsumed();

    function assertBothConsumed() {
      for (const id of [idA, idB]) {
        const e = entryById(dir, id);
        assert.equal(e.status, 'consumed', `${id} consumed`);
        assert.equal(e.consumption.commit_sha, head, `${id} bound to this commit`);
      }
    }
  } finally { cleanup(); }
});

// POST-COMMIT VERIFY FAILURE (contract sheet §6 A13): `commit_verify_failed`, the commit
// exists, the reservations STAY reserved, remedy `review-ledger.mjs reconcile`, exit 1. The
// harness reaches this step: the commit object is created and only then does the trailer read
// come back empty, which is the `facts.missing_trailers` half of the code.
// EXPECTED: RED today — the code does not exist, and today's entry is deleted on this path
// rather than left reserved (today's CLI does fail loudly here, so the exit code is green).
// SABOTAGE: skip the post-commit verification entirely -> exit 0 and the receipt is consumed
// against a commit the merge gate will refuse -> the exit-code and status assertions red.
// SECOND SABOTAGE: verify, refuse, but RELEASE the reservations -> the reserved-status
// assertion reds while the code assertion stays green; the release is `reconcile`'s call to
// make after comparing the tree, not this run's, because the commit really does exist.
test('R1-D109: when the committed trailer block does not survive, the run refuses [commit_verify_failed] with facts.missing_trailers — the commit exists, the receipt stays RESERVED, and the reconcile remedy is named', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // A prepare-commit-msg hook stitches a non-trailer line into the final paragraph, which
    // makes git's own trailer parser see NO trailers at all.
    installHook(dir, 'prepare-commit-msg', `#!/usr/bin/env node
const fs = require('fs');
const file = process.argv[2];
let msg = fs.readFileSync(file, 'utf8');
msg = msg.replace(/\\n\\n(Reviewed-By-Agent:[^]*)$/, '\\n\\nnot a trailer line\\n$1');
fs.writeFileSync(file, msg);
`);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '10900000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D109 trailer destroyed', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), base, 'fixture guard: the commit itself DID land — this is the post-commit class, not a refusal');
    assert.deepEqual(receiptTrailers(dir), [], 'fixture guard: the hook really destroyed the trailer paragraph');
    const out = soleJson(r);
    assert.equal(out.code, 'commit_verify_failed', `got ${JSON.stringify(out)}`);
    assert.ok((out.facts?.missing_trailers ?? []).length > 0, `the facts name WHICH trailers were not readable — got ${JSON.stringify(out.facts)}`);
    assert.match(JSON.stringify(out.facts), /reconcile/, `and carry the reconcile remedy — got ${JSON.stringify(out.facts)}`);
    const e = entryById(dir, id);
    assert.ok(e, 'the receipt is still in the ledger');
    assert.equal(e.status, 'reserved', 'and stays RESERVED — the commit exists, so releasing it here would strand a real binding; reconcile decides after comparing the tree');
    assert.equal(e.consumption, undefined, 'nothing is consumed against an unverifiable commit');
  } finally { cleanup(); }
});

// ===========================================================================
// PINS ADDED FROM THE CORRECTNESS REVIEW OF THE REBUILT CLI (R1-D110..R1-D114).
// Each one covers a state transition the earlier pins reached only in the happy
// direction: a terminal receipt being re-touched, a release under concurrent
// writes, verification against the COMMITTED tree rather than the intended one,
// the amend re-bind's byte check, and a reservation that disappears under the
// run's feet.
// ===========================================================================

// C1 — A TERMINAL RECEIPT IS NEVER RE-TOUCHED. Selection happens outside the lock, so the
// only durable guarantee is about the OUTCOME: a receipt already carrying `consumption` (or
// `disposition`) comes out of ANY run byte-identical. Arm (b) is the one with teeth — the run
// SUCCEEDS there, so a finalize that writes consumption to every trailer-named entry, or that
// rewrites the whole ledger from its own model, silently re-points a settled binding.
// EXPECTED: RED today on arm (b)'s success path (consumption is a new shape) and on arm (a)'s
// code assertion.
// SABOTAGE (the clobber): finalize by mapping over ALL entries and stamping consumption where
// the entry_id appears anywhere in this run's trailer set -> the pre-existing consumed
// receipt's commit_sha is re-pointed at the new commit -> arm (b)'s deepEqual reds while every
// exit code stays green. That is a silent rewrite of settled evidence, invisible to D103.
// SABOTAGE (the resurrection): select on `status !== 'discharged'` -> the consumed receipt is
// reserved again -> arm (a) exits 0 and its deepEqual reds.
test('R1-D110 (C1): a receipt already CONSUMED or DISCHARGED is never reserved and comes out of ANY run byte-identical — alone the run refuses, and beside a fresh receipt the run succeeds without touching it', { skip: GIT_SKIP }, () => {
  const makeTerminal = (label, base, blob) => (label === 'consumed'
    ? v2({ entry_id: '11000000-0000-4000-8000-00000000000c', agent_type: 'reviewer-spent', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base,
        status: 'consumed', consumption: { commit_sha: 'a'.repeat(40), consumed_at: isoAgo(90_000), nonce: 'settled-nonce' } })
    : { ...v2({ entry_id: '11000000-0000-4000-8000-00000000000d', agent_type: 'reviewer-closed', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base, status: 'discharged' }),
        disposition: { class: 'superseded', reason: 'closed by a later round', at: isoAgo(90_000), head_sha: 'b'.repeat(40), classifier_version: 2, facts: {} } });

  // (a) the terminal receipt is the ONLY entry.
  for (const label of ['consumed', 'discharged']) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', CODE);
      const base = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [makeTerminal(label, base, indexBlob(dir, 'src/laneA.mjs'))]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', `D110a ${label}`, '--json']);
      assert.equal(r.code, 1, `[alone/${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.ok(['no_spendable_receipt', 'reservation_conflict'].includes(soleJson(r).code), `[alone/${label}] got ${flat(r.stdout)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), base, `[alone/${label}] no commit`);
      assert.equal(readLedgerRaw(dir), before, `[alone/${label}] the terminal entry is byte-identical`);
    } finally { cleanup(); }
  }
  // (b) the terminal receipt sits BESIDE a fresh covering receipt and the run SUCCEEDS.
  for (const label of ['consumed', 'discharged']) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', CODE);
      const base = git(dir, ['rev-parse', 'HEAD']);
      const blob = indexBlob(dir, 'src/laneA.mjs');
      const settled = makeTerminal(label, base, blob);
      const freshId = '11000000-0000-4000-8000-00000000000f';
      writeLedger(dir, [settled, v2({ entry_id: freshId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base })]);

      const r = runCommitReviewed(dir, ['-m', `D110b ${label}`]);
      assert.equal(r.code, 0, `[beside/${label}] a fresh receipt covers the diff — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      const head = git(dir, ['rev-parse', 'HEAD']);
      assert.deepEqual(receiptTrailers(dir), [freshId], `[beside/${label}] only the fresh receipt is bound to this commit`);
      assert.deepEqual(entryById(dir, settled.entry_id), settled,
        `[beside/${label}] THE SETTLED ENTRY IS BYTE-IDENTICAL — a finalize that stamps consumption across the ledger re-points evidence that was already accounted for`);
      assert.equal(entryById(dir, freshId).consumption?.commit_sha, head, `[beside/${label}] and the fresh one is consumed normally`);
    } finally { cleanup(); }
  }
});

// C2 — THE RELEASE CLEARS ONLY ITS OWN RESERVATIONS. R1-D104 pins the release under NO
// contention (the whole file byte-identical); this arm pins it under a concurrent append,
// which is the realistic shape — H22's promoteAtStop lands a receipt while `git commit` runs.
// The two are consistent and neither substitutes for the other: D104 would go green under a
// snapshot-restore release, and this arm is the one that catches it.
// EXPECTED: RED today — there is no reservation to release, and today's failure path leaves
// the ledger alone rather than reconciling a concurrent write.
// SABOTAGE (named by the review): release by restoring a pre-reserve snapshot of the ledger ->
// the hook's appended receipt vanishes, destroying a real reviewer's evidence with no trace ->
// the "appended receipt PRESENT" assertion reds while exit code, code token and the released
// status all stay green. Nothing else in this file can see that.
test('R1-D111 (C2): when the commit fails, the release clears ONLY this run\'s reservations — a receipt appended mid-commit by another writer survives, the selected receipt returns to active, exit 1 [commit_failed]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const appendedId = '11100000-0000-4000-8000-00000000000a';
    installHook(dir, 'pre-commit', `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(process.cwd(), '.sterling', 'review-ledger.json');
const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
entries.push({
  schema_version: 2, entry_id: '${appendedId}', kind: 'roster_receipt', status: 'active',
  started_at: '2026-09-07T00:00:00.000Z', finished_at: '2026-09-07T00:00:00.000Z',
  reviewer: { agent_type: 'reviewer-security', model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
  identity: { session_id: 'this-session', branch: 'main', base_sha: null, agent_id: 'agent-concurrent' },
  territory: { files: ['src/laneZ.mjs'], source: 'review-territory', attribution: 'block' },
  content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs: {}, absent_paths: [], truncated_of: null, failure_reason: null },
  disposition: null
});
fs.writeFileSync(p, JSON.stringify(entries));
process.exit(1);
`);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '11100000-0000-4000-8000-00000000000b';
    const selected = v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base });
    writeLedger(dir, [selected]);

    const r = runCommitReviewed(dir, ['-m', 'D111 concurrent append then commit failure']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.match(`${r.stdout}\n${r.stderr}`, token('commit_failed'), `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit was created');

    assert.ok(entryById(dir, appendedId), 'THE CONCURRENTLY APPENDED RECEIPT SURVIVES — a snapshot-restore release would have erased it');
    assert.equal(entryById(dir, appendedId).status, 'active', 'and is untouched by this run');
    assert.deepEqual(entryById(dir, id), selected, 'the selected receipt is back exactly as it was — active, with no reservation left behind');
  } finally { cleanup(); }
});

// H1 — VERIFY MEASURES THE COMMITTED TREE, NOT THE INTENDED ONE. A pre-commit hook that edits
// a covered file and stages it is the ordinary formatter/linter shape, and it means the blob
// that lands is NOT the blob the reservation recorded — i.e. the commit contains bytes no
// reviewer saw.
// EXPECTED: RED today — there is no post-commit tree comparison at all, so the run exits 0 and
// consumes against a commit carrying unreviewed bytes.
// SABOTAGE: verify only that the TRAILERS are present and skip the tree comparison -> exit 0,
// the receipt is consumed, and a formatter has silently laundered unreviewed bytes into a
// reviewed commit -> the exit-code, code, facts and reserved-status assertions all red while
// D109 (the missing-trailers half of the same code) stays green. The two halves of
// commit_verify_failed need both pins.
// CONTROL: the second arm runs the identical fixture with NO hook and must be CONSUMED, so a
// green refusal above cannot be explained by "verification refuses everything".
test('R1-D112 (H1): when a pre-commit hook changes a covered staged file, the COMMITTED blob differs from the reserved one — [commit_verify_failed] with facts.differences[{path, expected, actual}], the receipt stays RESERVED and the commit\'s Review-Receipt trailer is unbound', { skip: GIT_SKIP }, () => {
  // CONTROL first: same fixture, no hook.
  {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', CODE);
      const base = git(dir, ['rev-parse', 'HEAD']);
      const id = '11200000-0000-4000-8000-00000000000a';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

      const r = runCommitReviewed(dir, ['-m', 'D112 control, tree unchanged']);
      assert.equal(r.code, 0, `[control] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(entryById(dir, id).status, 'consumed', '[control] an unmodified tree verifies and finalizes');
    } finally { cleanup(); }
  }
  // The defect.
  {
    const { dir, cleanup } = makeRepo();
    try {
      installHook(dir, 'pre-commit', `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
fs.writeFileSync('src/laneA.mjs', 'export const f = 1; // reformatted by a hook, reviewed by nobody\\n');
execFileSync('git', ['add', 'src/laneA.mjs']);
`);
      stageChange(dir, 'src/laneA.mjs', CODE);
      const base = git(dir, ['rev-parse', 'HEAD']);
      const reservedBlob = indexBlob(dir, 'src/laneA.mjs');
      const id = '11200000-0000-4000-8000-00000000000b';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reservedBlob }, base_sha: base })]);

      const r = runCommitReviewed(dir, ['-m', 'D112 hook rewrites a covered file', '--json']);
      assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      const head = git(dir, ['rev-parse', 'HEAD']);
      assert.notEqual(head, base, 'fixture guard: the commit DID land — this is the post-commit class');
      const committedBlob = treeBlob(dir, head, 'src/laneA.mjs');
      assert.notEqual(committedBlob, reservedBlob, 'fixture guard: the hook really changed the committed bytes');

      const out = soleJson(r);
      assert.equal(out.code, 'commit_verify_failed', `got ${JSON.stringify(out)}`);
      assert.deepEqual(out.facts?.differences, [{ path: 'src/laneA.mjs', expected: reservedBlob, actual: committedBlob }],
        `the facts name the path and BOTH blobs — got ${JSON.stringify(out.facts)}`);
      assert.deepEqual(receiptTrailers(dir, head), [id], 'the commit carries the trailer — it is PRESENT but UNBOUND, which is exactly what direct-merge refuses');
      assert.equal(entryById(dir, id).status, 'reserved', 'and the receipt stays RESERVED for reconcile to adjudicate, never consumed against bytes nobody reviewed');
    } finally { cleanup(); }
  }
});

// H2 — THE AMEND RE-BIND VERIFIES BYTES BEFORE IT MOVES ANYTHING. Amend mode requires a clean
// tree and preserves the tree exactly (R1-D90), so the amended tree always equals the target
// tree; the only way a prior receipt can disagree with it is to have disagreed all along.
// A13 requires that disagreement to refuse BEFORE the amend. This is the THIRD arm of the
// fail-closed family whose other two (absent / not-consumed-for-old-sha) are
// commit-reviewed-target-sha.test.mjs R1-D99 — a resolver that checks presence and status but
// never compares blobs passes both of those and fails only here.
// EXPECTED: RED today — neither the code nor the re-bind exists.
// SABOTAGE: re-bind on presence-and-status alone, without re-verifying the prior receipt's
// blobs against the amended tree -> the amend proceeds, exit 0, and a receipt that never
// matched the tree is carried forward into a NEW sha, laundering a stale attestation through
// the operation that rewrote the commit -> the exit-code, HEAD-unmoved and ledger assertions
// all red.
test('R1-D113 (H2): a prior receipt consumed for the old sha whose blobs do NOT equal the amended tree refuses [target_sha_prior_receipt_unbound] BEFORE amending — nothing is re-bound and nothing is rewritten', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    seedConfig(dir);
    const priorId = '11300000-0000-4000-8000-00000000000a';
    const freshId = '11300000-0000-4000-8000-00000000000b';
    stageChange(dir, 'src/laneA.mjs', CODE);
    git(dir, ['commit', '-m', `prior round\n\nReviewed-By-Agent: reviewer-correctness\nReview-Receipt: ${priorId}`]);
    const targetSha = git(dir, ['rev-parse', 'HEAD']);
    assert.deepEqual(receiptTrailers(dir, targetSha), [priorId], 'fixture guard: the target carries a prior binding');
    const treeSha = treeBlob(dir, targetSha, 'src/laneA.mjs');
    const staleSha = hashBytes(dir, 'export const f = 0; // the bytes the prior reviewer read\n');
    assert.notEqual(staleSha, treeSha, 'fixture guard: the prior receipt genuinely disagrees with the tree');

    writeLedger(dir, [
      // present, consumed for the OLD sha — but its blobs never matched that tree.
      { ...v2({ entry_id: priorId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': staleSha }, base_sha: targetSha, status: 'consumed' }),
        consumption: { commit_sha: targetSha, consumed_at: isoAgo(90_000), nonce: 'prior-nonce' } },
      v2({ entry_id: freshId, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': treeSha }, base_sha: targetSha }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json'], SEAM_ON);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.equal(soleJson(r).code, 'target_sha_prior_receipt_unbound', `got ${flat(r.stdout)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'the refusal lands BEFORE the amend — nothing was rewritten');
    assert.equal(readLedgerRaw(dir), before, 'and nothing was re-bound: the prior consumption still names the OLD sha, the fresh receipt is untouched');
  } finally { cleanup(); }
});

// H4 — A RESERVATION THAT DISAPPEARS UNDER THE RUN'S FEET IS LOUD. The commit exists and
// carries a Review-Receipt trailer; if finalize cannot find that entry in `reserved` state it
// must refuse rather than paper over the gap, because exiting 0 here ships a merge-visible
// trailer bound to nothing.
// EXPECTED: RED today — no reserved state exists, so the condition is unreachable and today's
// run exits 0.
// SABOTAGE (the papering-over): treat "not currently reserved" at finalize as already-done and
// return success -> exit 0 with an unbound Review-Receipt trailer on a landed commit -> the
// exit-code and code assertions red. This is the inverse of D103's double-spend guard: there
// the danger is writing twice, here it is writing nothing and claiming success.
// SECOND SABOTAGE: refuse, but with facts that do not name the entry -> only the facts
// assertion reds; without the entry_id an operator cannot tell reconcile what to look at.
test('R1-D114 (H4): if the selected entry is no longer RESERVED at finalize, the run refuses loudly with the entry named in facts — never exit 0 with an unbound Review-Receipt trailer', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const id = '11400000-0000-4000-8000-00000000000a';
    installHook(dir, 'pre-commit', `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(process.cwd(), '.sterling', 'review-ledger.json');
const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const e of entries) {
  if (e.entry_id === '${id}') { e.status = 'active'; delete e.reservation; }
}
fs.writeFileSync(p, JSON.stringify(entries));
`);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D114 reservation vanishes mid-commit', '--json']);
    assert.equal(r.code, 1, `an unaccountable finalize must refuse, never report success — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'fixture guard: the commit itself landed');
    const out = soleJson(r);
    assert.ok(['finalize_failed', 'commit_verify_failed'].includes(out.code), `got ${JSON.stringify(out)}`);
    assert.match(JSON.stringify(out.facts), new RegExp(id), `the facts name the entry the run cannot account for — got ${JSON.stringify(out.facts)}`);
    assert.notEqual(entryById(dir, id).status, 'consumed', 'and nothing is consumed on the strength of a reservation that is gone');
  } finally { cleanup(); }
});

// R1-D115 — A MULTI-RECEIPT SPEND IS ALL-OR-NOTHING. Two receipts both cover the staged path;
// one of them is settled by another writer while this run is in flight. The property that must
// hold is not "the run notices eventually" but "no commit exists whose Review-Receipt trailers
// name a receipt this run did not itself carry reserved→consumed" — a partially-bound commit
// is exactly what direct-merge refuses, and it would have to be un-committed by hand.
//
// RE-CUT: R1-D115 defect arm — lock-ignoring writer is detected at finalize, not before commit (A22)
//
// WHY THE DEFECT ARM DOES NOT ASSERT "HEAD unmoved" (sheet §6 A22): the interposition is a
// pre-commit hook, i.e. a writer that rewrites the ledger DURING the commit and OUTSIDE the
// ledger lock. No re-validation under the lock can see it, so refusing before the commit
// exists is unsatisfiable in contract, not merely unimplemented. The race is detected at
// FINALIZE: the run refuses [reservation_conflict] naming B, nothing is consumed, A is
// released to its exact pre-run state, B's foreign consumption is untouched — and the commit
// that exists carries trailers no receipt is bound to. That residue is the A7 posture: the
// remedy is a fresh review round or a visible waiver on a re-commit; reconcile cannot bind B,
// because B belongs to another writer.
//
// EXPECTED: GREEN for the defect arm against the current tree; the CONTROL is RED where it
// depends on the `receipts` report field and the consumed-status shape.
// SABOTAGE (the partial spend): on discovering one selected receipt is no longer reservable,
// drop it and proceed with the rest -> a commit lands carrying a trailer for B that B's own
// ledger entry contradicts -> the HEAD-unmoved and B-untouched assertions red.
// SABOTAGE (the clobber): re-reserve B regardless of its status -> B's settled consumption is
// overwritten with this run's sha -> the byte-identical assertion reds alone.
// CONTROL, PLACED FIRST and passing for the OPPOSITE reason: with no interposition the SAME
// two-receipt fixture commits and the commit's trailer set EQUALS the report's `receipts`
// exactly — so a green refusal below cannot be explained by "a two-receipt spend never works".
test('R1-D115 (CONTROL, first): with no interposition, a two-receipt spend binds exactly what it reports — the commit\'s Review-Receipt trailer set EQUALS report.receipts, and both entries are consumed for HEAD', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const idA = '11500000-0000-4000-8000-00000000000a';
    const idB = '11500000-0000-4000-8000-00000000000b';
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D115 control, two receipts', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const out = soleJson(r);
    // The coordinator's exact read: valueonly, no unfold.
    const trailers = git(dir, ['log', '-1', '--format=%(trailers:key=Review-Receipt,valueonly)', head]).split('\n').filter((l) => l.trim() !== '');
    assert.deepEqual(trailers.sort(), [...(out.receipts ?? [])].sort(),
      `the commit binds EXACTLY what the report claims — a report that over- or under-states its bindings is unauditable — trailers=${JSON.stringify(trailers)} report.receipts=${JSON.stringify(out.receipts)}`);
    assert.deepEqual(trailers.sort(), [idA, idB].sort(), 'and both receipts really are bound');
    for (const id of [idA, idB]) assert.equal(entryById(dir, id).consumption?.commit_sha, head, `${id} consumed for HEAD`);
  } finally { cleanup(); }
});

test('R1-D115 (second-pass HIGH): when one of two selected receipts is settled by a LOCK-IGNORING writer mid-commit, the spend refuses [reservation_conflict] naming it at FINALIZE — nothing consumed, the other receipt released, the foreign consumption byte-identical, and the commit left carrying UNBOUND trailers', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const idA = '11500000-0000-4000-8000-00000000000c';
    const idB = '11500000-0000-4000-8000-00000000000d';
    const OTHER_SHA = 'c'.repeat(40);
    // Another writer settles B for a DIFFERENT commit while this run is in flight.
    installHook(dir, 'pre-commit', `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(process.cwd(), '.sterling', 'review-ledger.json');
const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
for (const e of entries) {
  if (e.entry_id === '${idB}') {
    e.status = 'consumed';
    delete e.reservation;
    e.consumption = { commit_sha: '${OTHER_SHA}', consumed_at: '2026-09-07T00:00:00.000Z', nonce: 'other-writer-nonce' };
  }
}
fs.writeFileSync(p, JSON.stringify(entries));
`);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const receiptA = v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base });
    writeLedger(dir, [
      receiptA,
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D115 B settled mid-run', '--json']);

    // THE INVARIANTS.
    assert.equal(r.code, 1, `a spend that cannot bind everything it selected must refuse — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(entryById(dir, idB).consumption, { commit_sha: OTHER_SHA, consumed_at: '2026-09-07T00:00:00.000Z', nonce: 'other-writer-nonce' },
      'B\'s settled consumption is byte-identical — this run never overwrites another writer\'s binding');
    assert.notEqual(entryById(dir, idA).status, 'consumed', 'and A is not consumed either: the spend is all-or-nothing, never partial');

    // THE FINALIZE-TIME VERDICT (A22).
    const out = soleJson(r);
    assert.equal(out.code, 'reservation_conflict', `got ${JSON.stringify(out)}`);
    assert.match(JSON.stringify(out.facts), new RegExp(idB), `the facts name the receipt that moved — got ${JSON.stringify(out.facts)}`);
    assert.deepEqual(entryById(dir, idA), receiptA, 'A is released to its EXACT pre-run state — active, with no reservation left behind');

    // THE RESIDUE, PINNED RATHER THAN LEFT IMPLICIT: a commit exists and its trailers bind
    // nothing. This is the assertion that separates the correct refusal from the dangerous
    // near-miss — a run that consumed A "because A was fine" would leave a HALF-bound commit,
    // which reads to the merge gate as reviewed.
    const head = git(dir, ['rev-parse', 'HEAD']);
    const trailers = git(dir, ['log', '-1', '--format=%(trailers:key=Review-Receipt,valueonly)', head]).split('\n').filter((l) => l.trim() !== '');
    for (const bound of trailers) {
      const e = entryById(dir, bound);
      assert.notEqual(e?.consumption?.commit_sha, head,
        `every Review-Receipt trailer on the created commit is UNBOUND — no receipt is consumed for ${head} — trailers=${JSON.stringify(trailers)}`);
    }
  } finally { cleanup(); }
});
