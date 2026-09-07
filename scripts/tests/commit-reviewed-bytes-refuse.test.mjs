// COMMIT-REVIEWED — THE BYTE RULE (R1 pin re-cut, group D).
//
// AUTHORITY: decision `review-receipt-rebuild-invariant-three-owner-modules-tri-state-liveness-receipt-bound-supersession`
// (knowledge_get 24dc4c63) — "A commit spends a receipt only when the INDEX blob being
// committed equals the receipt's stop_worktree_blob for every covered path, or the operator
// waives visibly (Review-Bytes-Waiver)." Contract sheet §3.2 step 2, §6 A3 (a missing
// content_evidence.basis reads as 'stop-time-worktree-snapshot'), A8 (spend matches the
// Stop-time WORKTREE blob only; `index_blobs` is DIAGNOSTIC) and A13 — DELETIONS ARE
// COVERABLE: receiptCoveredPaths = declared paths with a usable blob UNION declared paths in
// content_evidence.absent_paths; a staged CONTENT matches the worktree blob, a staged
// DELETION matches membership in absent_paths, and any other combination is
// `receipt_bytes_mismatch` with `'absent'` on whichever side is absent.
//
// RETIRED: A1/A2/C1 as v1 fixtures — v1 entries are never spendable (24dc4c63); the
//   mismatch contract is re-cut on v2 with facts.mismatches (R1-D31/R1-D32).
// RETIRED: B0/B1/B2 (truncated/partial evidence refuses) — a declared path with neither a
//   usable blob NOR membership in absent_paths (A9 as amended by A13) is simply NOT COVERED,
//   so the verdict is [coverage_incomplete], not a byte mismatch; re-cut as R1-D34.
// RETIRED: C0/C2/C3 (grandfathering genuinely-absent evidence) — grandfathering is gone with
//   the fallback: a receipt that covers no staged path is never selected (R1-D41), and a
//   staged path nothing covers refuses [coverage_incomplete] (R1-D34).
// RETIRED: D1 (no-reliable-intersection FALLBACK stays a warning) — the no-match stamping
//   fallback is retired by the sheet's select step; a non-overlapping receipt is now a
//   [receipt_no_overlap] disclosure that stays ACTIVE (R1-D41).
// RETIRED: E2a/E2b/E2c as three separate arms — folded to one arm per distinct refusal
//   cause (R1-D38); the empty-reason arm moved to commit-reviewed.test.mjs R1-D04.
// RETIRED: E3 and the v1 waiver FINGERPRINT contract — a v2 waiver trailer is the entry_id
//   (sheet §3.2 step 3) and v1 receipts are never spent, so there is nothing to fingerprint.
// RETIRED: F0/F1/F2 (amend-mode byte enforcement) — moved wholesale to
//   commit-reviewed-target-sha.test.mjs, where the amend contract lives (§6 A9).
// RETIRED: every ALL-CAPS banner assertion (REVIEWED BYTES, NO CONTENT EVIDENCE, RECEIPT
//   FILES DO NOT OVERLAP THIS DIFF, ADVISORY ONLY) — converted to [code] tokens.

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-bytes-'));
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
// Writes the worktree WITHOUT staging — the only way index and worktree can disagree.
function writeWorktreeOnly(dir, relPath, content) {
  writeFileSync(join(dir, relPath), content);
}

function indexBlob(dir, relPath) {
  const out = git(dir, ['ls-files', '-s', '--', relPath]);
  const m = out.match(/^\d+ ([0-9a-f]{40}) \d+\t/);
  assert.ok(m, `fixture guard: ${relPath} must be staged in the index — got ${out}`);
  return m[1];
}
function hashBytes(dir, content) {
  const r = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: content, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git hash-object --stdin: ${r.stderr}`);
  const sha = (r.stdout ?? '').trim();
  assert.match(sha, /^[0-9a-f]{40}$/, `fixture guard: a usable 40-hex sha, got ${sha}`);
  return sha;
}

function runCommitReviewed(dir, args = [], env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
const waiverTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Bytes-Waiver', sha);

function soleJson(r) {
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `--json must print exactly ONE JSON object on stdout — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
  return parsed;
}

// `basis: null` produces a PRE-REBUILD v2 receipt whose content_evidence has no `basis`
// key at all (A3's compatibility case).
function v2({
  entry_id, agent_type, files, blobs = {}, index_blobs, base_sha, status = 'active',
  source = 'review-territory', evidence_status = 'complete', basis = 'stop-time-worktree-snapshot',
  at = isoAgo(60_000), session_id = SESSION, branch = 'main', absent_paths = [],
}) {
  const content_evidence = { status: evidence_status, blobs, absent_paths, truncated_of: null, failure_reason: null };
  if (basis !== null) content_evidence.basis = basis;
  if (index_blobs !== undefined) content_evidence.index_blobs = index_blobs;
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status,
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch, base_sha, agent_id: `agent-${entry_id.slice(0, 8)}` },
    territory: { files, source, attribution: 'block' },
    content_evidence,
    disposition: null,
  };
}

const OLD = 'export const f = 1; // the bytes the reviewer read\n';
const NEW = 'export const f = 2; // the bytes actually staged\n';

// A REAL pre-commit hook that snapshots the ledger mid-`git commit` — i.e. after RESERVE and
// before FINALIZE. It is the only way to read a reservation, which finalize then clears.
const SNAPSHOT_HOOK = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.copyFileSync(path.join(process.cwd(), '.sterling', 'review-ledger.json'), path.join(process.cwd(), '.sterling', 'mid-commit-snapshot.json'));
`;
function installHook(dir, name, script) {
  const p = join(dir, '.git', 'hooks', name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
}
const snapshotEntry = (dir, id) =>
  JSON.parse(readFileSync(join(dir, '.sterling', 'mid-commit-snapshot.json'), 'utf8')).find((e) => e.entry_id === id);

// Commits `relPath`, then STAGES ITS DELETION. Returns the blob it had while it existed —
// i.e. what a Stop-time snapshot would have recorded had the file still been present.
function stageDeletion(dir, relPath, content = OLD) {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', `seed ${relPath}`]);
  const blobWhilePresent = git(dir, ['rev-parse', `HEAD:${relPath}`]);
  git(dir, ['rm', '-q', '--', relPath]);
  assert.equal(git(dir, ['ls-files', '-s', '--', relPath]), '', `fixture guard: ${relPath} must have NO index entry once its deletion is staged`);
  assert.match(git(dir, ['diff', '--cached', '--name-only']), new RegExp(relPath.replace('.', '\\.')), 'fixture guard: the deletion is genuinely staged');
  return blobWhilePresent;
}

// ===========================================================================
// R1-D30 — CONTROL, PLACED FIRST. Every refusal below is this fixture minus a
// matching blob, so a green refusal cannot be explained by "this mode refuses
// everything".
// ===========================================================================

// EXPECTED: GREEN today for the commit itself; RED on the consumed-status assertion
// (today's spend deletes the entry).
// SABOTAGE: invert the blob comparison (refuse when the recorded sha EQUALS the index sha)
// -> exit 1 and every assertion reds. This control carries the verdict for the whole file.
test('R1-D30 (CONTROL, first): a v2 receipt whose content_evidence.blobs equals the INDEX blob commits — stamped, consumed, no byte refusal', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '30000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D30 matching bytes']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness']);
    assert.deepEqual(waiverTrailers(dir), [], 'no waiver trailer where nothing was waived');
    assert.equal(entryById(dir, id).status, 'consumed', 'consumption is a status transition');
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, token('receipt_bytes_mismatch'), `stderr=${flat(r.stderr)}`);
  } finally { cleanup(); }
});

// EXPECTED: RED today — today's byte check is advisory, so the run exits 0 and the first
// assertion fires; there is no facts.mismatches structure at all.
// SABOTAGE: downgrade the verdict from refusal to disclosure -> exit 0, HEAD moves, the
// entry is consumed -> red. That is today's behaviour, which is why this pin is red now.
test('R1-D31: an index blob differing from the receipt\'s recorded blob refuses [receipt_bytes_mismatch] with facts.mismatches[{path, receipt_blob, index_blob}] — exit 1, no commit, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewed = hashBytes(dir, OLD);
    stageChange(dir, 'src/laneA.mjs', NEW);
    const staged = indexBlob(dir, 'src/laneA.mjs');
    assert.notEqual(reviewed, staged, 'fixture guard: the reviewed bytes genuinely differ from the staged bytes');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '31000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewed }, base_sha: base })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D31 changed since review', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'receipt_bytes_mismatch', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.mismatches, [{ path: 'src/laneA.mjs', receipt_blob: reviewed, index_blob: staged }],
      `the facts name the path and BOTH shas — an operator cannot adjudicate a mismatch without them — got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'nothing consumed — ledger byte-identical');
  } finally { cleanup(); }
});

// EXPECTED: RED today (exit 0; no facts.mismatches exists).
// SABOTAGE (the one this pin exists for): refuse on the FIRST mismatch found instead of
// collecting all of them -> facts.mismatches has one element and the length assertion reds
// while the code assertion stays green. A single-mismatch fixture cannot see that at all.
// SECOND SABOTAGE: reserve/consume the CLEAN receipt before evaluating the byte verdict ->
// the ledger raw-bytes assertion reds while the facts assertions stay green.
test('R1-D32: two receipts mismatching two DIFFERENT staged paths aggregate into ONE refusal listing BOTH — and the third, clean receipt is neither listed nor consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = hashBytes(dir, OLD);
    const reviewedB = hashBytes(dir, OLD + '// B\n');
    stageChange(dir, 'src/laneA.mjs', NEW);
    stageChange(dir, 'src/laneB.mjs', NEW + '// B\n');
    stageChange(dir, 'src/laneC.mjs', NEW + '// C\n');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = '32000000-0000-4000-8000-000000000001';
    const idB = '32000000-0000-4000-8000-000000000002';
    const idC = '32000000-0000-4000-8000-000000000003';
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA }, base_sha: base }),
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': reviewedB }, base_sha: base }),
      v2({ entry_id: idC, agent_type: 'reviewer-clean', files: ['src/laneC.mjs'], blobs: { 'src/laneC.mjs': indexBlob(dir, 'src/laneC.mjs') }, base_sha: base }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D32 two mismatches', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'receipt_bytes_mismatch', `got ${JSON.stringify(out)}`);
    const paths = (out.facts?.mismatches ?? []).map((m) => m.path).sort();
    assert.deepEqual(paths, ['src/laneA.mjs', 'src/laneB.mjs'], `both mismatches are aggregated into ONE refusal — got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed — not even the clean receipt');
  } finally { cleanup(); }
});

// A8'S OWN PIN: `index_blobs` is DIAGNOSTIC and is NEVER an alternative match.
// EXPECTED: RED today — today's evidence reader has no notion of index_blobs as a
// non-matching field, and the byte verdict is advisory anyway.
// SABOTAGE (exactly the one A8 forbids): fall back to content_evidence.index_blobs when
// content_evidence.blobs disagrees -> the run commits, exit 0 -> red. No other pin in this
// file can see that fallback, because every other fixture omits index_blobs entirely.
// CONTROL: R1-D30 (same shape, matching blobs, commits) proves the refusal here is caused by
// the blobs field and not by the presence of index_blobs.
test('R1-D33 (A8): a receipt whose content_evidence.index_blobs matches the index while content_evidence.blobs does NOT still refuses [receipt_bytes_mismatch] — index_blobs is diagnostic, never a second chance to match', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewed = hashBytes(dir, OLD);
    stageChange(dir, 'src/laneA.mjs', NEW);
    const staged = indexBlob(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '33000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': reviewed },
      index_blobs: { 'src/laneA.mjs': staged }, // matches the index — and must not rescue the spend
      base_sha: base,
    })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D33 index_blobs is not a match', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'receipt_bytes_mismatch', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.mismatches, [{ path: 'src/laneA.mjs', receipt_blob: reviewed, index_blob: staged }],
      `the mismatch is reported against the Stop-time WORKTREE blob — got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// A9'S NARROWING: a declared path with no usable blob is NOT COVERED — so it is a coverage
// defect, never a byte mismatch.
// EXPECTED: RED today — today an unbound declared path is at most a content-evidence
// advisory, so the run exits 0.
// SABOTAGE (the conflation this pin forbids): report an unbound covered path as a
// [receipt_bytes_mismatch] with a null/undefined receipt_blob -> the code assertion reds
// while the exit code stays 1. The two codes carry DIFFERENT remedies: a mismatch is waived
// with --waive-bytes, a coverage hole is not waivable at all and needs a fresh review round.
test('R1-D34 (A9): a staged path a receipt DECLARES but binds no usable blob for is UNCOVERED — the run refuses [coverage_incomplete] with facts.uncovered, never [receipt_bytes_mismatch]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '34000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-correctness',
      files: ['src/laneA.mjs', 'src/base.mjs'],
      blobs: { 'src/base.mjs': indexBlob(dir, 'src/base.mjs') }, // the STAGED path is unbound
      base_sha: base,
    })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D34 unbound staged path', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'coverage_incomplete', `an unbound declared path is a coverage hole, not a byte mismatch — got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.uncovered, ['src/laneA.mjs'], `got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// A3'S COMPATIBILITY PIN.
// EXPECTED: GREEN once the rebuild lands (a missing `basis` reads as the Stop-time snapshot);
// RED today only on the consumed-status assertion.
// SABOTAGE: require content_evidence.basis === 'stop-time-worktree-snapshot' to be PRESENT
// -> every pre-rebuild v2 receipt in a live ledger becomes unspendable overnight -> exit 1
// and every assertion reds. That is the migration break A3 exists to forbid, and no other
// pin in this file omits `basis`.
test('R1-D35 (A3): a PRE-REBUILD v2 receipt with NO content_evidence.basis key still spends — the missing field reads as stop-time-worktree-snapshot, never as unusable evidence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '35000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, basis: null })]);
    assert.doesNotMatch(readLedgerRaw(dir), /"basis"/, 'fixture guard: the serialized receipt really carries no basis key');

    const r = runCommitReviewed(dir, ['-m', 'D35 pre-rebuild v2 shape']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness']);
    assert.equal(entryById(dir, id).status, 'consumed');
  } finally { cleanup(); }
});

// THE INDEX IS THE SUBJECT, NOT THE WORKTREE (A8). No pre-rebuild fixture could see this:
// every one of them kept index and worktree identical on purpose.
// EXPECTED: RED today on both arms — today's comparison reads the worktree, so the verdicts
// are exactly inverted.
// SABOTAGE: compare `git hash-object <path>` (the worktree) instead of `git ls-files -s`
// (the index) -> arm (a) refuses and arm (b) commits — both arms red, and in opposite
// directions, which is the signature this pair exists to produce.
test('R1-D36 (A8): the byte rule compares the INDEX being committed — a receipt matching the staged index commits although the worktree has moved on, and one matching only the worktree refuses', { skip: GIT_SKIP }, () => {
  // (a) receipt matches the INDEX; the worktree has drifted -> COMMITS.
  {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', NEW);
      const staged = indexBlob(dir, 'src/laneA.mjs');
      writeWorktreeOnly(dir, 'src/laneA.mjs', 'export const drifted = 3;\n');
      const base = git(dir, ['rev-parse', 'HEAD']);
      const id = '36000000-0000-4000-8000-00000000000a';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': staged }, base_sha: base })]);

      const r = runCommitReviewed(dir, ['-m', 'D36a index matches']);
      assert.equal(r.code, 0, `[index-match] the commit records the INDEX, so the index is what the receipt must equal — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(entryById(dir, id).status, 'consumed', '[index-match] consumed');
    } finally { cleanup(); }
  }
  // (b) receipt matches the WORKTREE only -> REFUSES.
  {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', NEW);
      const staged = indexBlob(dir, 'src/laneA.mjs');
      const drifted = 'export const drifted = 3;\n';
      writeWorktreeOnly(dir, 'src/laneA.mjs', drifted);
      const worktreeSha = hashBytes(dir, drifted);
      assert.notEqual(worktreeSha, staged, 'fixture guard: index and worktree genuinely differ');
      const base = git(dir, ['rev-parse', 'HEAD']);
      const id = '36000000-0000-4000-8000-00000000000b';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': worktreeSha }, base_sha: base })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', 'D36b worktree matches only', '--json']);
      assert.equal(r.code, 1, `[worktree-only] bytes that are not being committed are not evidence for this commit — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(soleJson(r).facts?.mismatches?.[0]?.index_blob, staged, `[worktree-only] the facts report the INDEX blob — got ${flat(r.stdout)}`);
      assert.equal(readLedgerRaw(dir), before, '[worktree-only] ledger byte-identical');
    } finally { cleanup(); }
  }
});

// ===========================================================================
// --waive-bytes (contract sheet §3.2 step 2 + the [bytes_waived] disclosure).
// ===========================================================================

// EXPECTED: RED today — no waiver trailer is stamped today (the byte verdict is advisory,
// so nothing is ever "waived") and [bytes_waived] does not exist.
// SABOTAGE: stamp the waiver trailer for every SELECTED receipt rather than only AFFECTED
// ones -> the two-element trailer set reds while the exit code stays 0.
// SECOND SABOTAGE: put the reason (or the agent_type) in the trailer value instead of the
// entry_id -> the entry_id assertion reds; a waiver that cannot be resolved back to a
// receipt is not an accountable override.
test('R1-D37: --waive-bytes lets a mismatch through — the commit lands, [bytes_waived] is disclosed, and exactly one Review-Bytes-Waiver trailer per AFFECTED receipt carries its entry_id', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = hashBytes(dir, OLD);
    stageChange(dir, 'src/laneA.mjs', NEW);
    stageChange(dir, 'src/laneC.mjs', NEW + '// C\n');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = '37000000-0000-4000-8000-000000000001';
    const idC = '37000000-0000-4000-8000-000000000002';
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA }, base_sha: base }),
      v2({ entry_id: idC, agent_type: 'reviewer-clean', files: ['src/laneC.mjs'], blobs: { 'src/laneC.mjs': indexBlob(dir, 'src/laneC.mjs') }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D37 waived', '--waive-bytes', 'reviewer re-read the changed lines by hand', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.ok((out.disclosures ?? []).some((d) => d.code === 'bytes_waived'), `the waiver is DISCLOSED, never silent — got ${JSON.stringify(out.disclosures)}`);
    assert.deepEqual(waiverTrailers(dir), [idA], 'one waiver trailer, for the affected receipt only');
    assert.deepEqual(reviewedByTrailers(dir).sort(), ['reviewer-clean', 'reviewer-correctness'], 'ordinary stamping is unaffected');
    for (const id of [idA, idC]) assert.equal(entryById(dir, id).status, 'consumed', `${id} consumed`);
  } finally { cleanup(); }
});

// CONTROL for R1-D37 and R1-D38: proves the waiver flag is ACCEPTED, so a refusal in D38
// cannot come from "the flag is rejected outright".
// EXPECTED: RED today — the flag is unknown to today's CLI, so it either refuses (exit != 0)
// or ignores it; the zero-trailer assertion is reachable only once the flag parses.
// SABOTAGE: stamp a waiver trailer whenever --waive-bytes is present -> the empty-array
// assertion reds. A waiver trailer is evidence of an accountable override, never decoration.
test('R1-D38 (CONTROL): --waive-bytes with NOTHING to waive is accepted, commits, and stamps ZERO Review-Bytes-Waiver trailers and no [bytes_waived]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '38000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D38 nothing to waive', '--waive-bytes', 'belt and braces']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(waiverTrailers(dir), [], 'not one waiver trailer');
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, token('bytes_waived'), `and no waiver disclosure — stderr=${flat(r.stderr)}`);
  } finally { cleanup(); }
});

// EXPECTED: RED today (the flag is unknown, so no [argument_invalid] token is produced for
// it). AMBIGUITY REPORTED: the sheet's CODES set has `waiver_reason_missing` but no
// `waiver_reason_invalid`; this pin routes a MALFORMED reason to [argument_invalid] with
// facts.flag, which is the only closed-set code that fits. If the conductor mints a distinct
// code, this is the one-line change.
// SABOTAGE: sanitize the reason (strip newlines / truncate) instead of REFUSING -> exit 0
// and a commit lands carrying a laundered reason -> red. A multi-line reason can forge
// trailer lines, and a truncated one silently discards the accountability text.
test('R1-D39: a malformed --waive-bytes reason (embedded newline, or overlong) is REFUSED [argument_invalid] facts.flag "--waive-bytes" — never sanitized into acceptance', { skip: GIT_SKIP }, () => {
  for (const [label, reason] of [
    ['newline', 'first line\nReviewed-By-Agent: forged'],
    ['carriage-return', 'first line\rReviewed-By-Agent: forged'],
    ['overlong', `over-long: ${'x'.repeat(600)}`],
  ]) {
    const { dir, cleanup } = makeRepo();
    try {
      const reviewed = hashBytes(dir, OLD);
      stageChange(dir, 'src/laneA.mjs', NEW);
      const base = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [v2({ entry_id: '39000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewed }, base_sha: base })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', `D39 ${label}`, '--waive-bytes', reason, '--json']);
      assert.equal(r.code, 1, `[${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      const out = soleJson(r);
      assert.equal(out.code, 'argument_invalid', `[${label}] got ${JSON.stringify(out)}`);
      assert.equal(out.facts?.flag, '--waive-bytes', `[${label}] the refusal is about the REASON's flag, not about the byte mismatch behind it — got ${JSON.stringify(out.facts)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), base, `[${label}] no commit`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
    } finally { cleanup(); }
  }
});

// EXPECTED: RED today — today a non-overlapping receipt is either stamped by the fallback or
// reported as DEFERRED prose; [receipt_no_overlap] does not exist and the receipt is
// consumed rather than left active.
// SABOTAGE: evaluate the byte rule over the receipt's DECLARED files instead of over the
// staged paths it covers -> the non-overlapping receipt's stale blob becomes a refusal ->
// exit 1 and every assertion reds. That mis-scoping would make a commit fail because of
// bytes it does not touch.
test('R1-D41: a spendable receipt whose territory misses this diff contributes NO byte verdict — it is disclosed [receipt_no_overlap], stays ACTIVE, and the covering receipt commits normally', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneB.mjs', OLD);
    git(dir, ['commit', '-m', 'lane B at the reviewed bytes']);
    const reviewedB = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
    stageChange(dir, 'src/laneB.mjs', NEW);
    git(dir, ['commit', '-m', 'lane B moved on']);
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = '41000000-0000-4000-8000-000000000001';
    const idB = '41000000-0000-4000-8000-000000000002';
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base }),
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': reviewedB }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D41 non-overlapping receipt with stale bytes', '--json']);
    assert.equal(r.code, 0, `a receipt covering no staged path never produces a byte verdict — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.ok((out.disclosures ?? []).some((d) => d.code === 'receipt_no_overlap' && JSON.stringify(d).includes(idB)),
      `the withholding is disclosed and names the receipt — got ${JSON.stringify(out.disclosures)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'only the covering receipt is stamped');
    assert.equal(entryById(dir, idB).status, 'active', 'and the non-overlapping receipt stays ACTIVE, spendable by its own slice');
    assert.equal(entryById(dir, idA).status, 'consumed');
  } finally { cleanup(); }
});

// ===========================================================================
// R1-D124 — DELETIONS ARE COVERABLE (contract sheet §6 A13). The two arms are ONE
// fixture differing in a single field: whether the receipt's Stop-time snapshot
// recorded the path as ABSENT or as PRESENT-with-a-blob. Neither arm carries a
// verdict without the other — a green refusal in (b) alone is satisfied by
// "a staged deletion always refuses", which is exactly what A13 overturns.
// ===========================================================================

// EXPECTED: RED today — a declared path with no blob is uncovered today, so a commit that
// only deletes a file refuses; and there is no reservation to inspect.
// SABOTAGE (the A9 shape, i.e. today's rule): define receiptCoveredPaths as blob-backed paths
// only, without the absent_paths union -> src/gone.mjs is uncovered, the run refuses
// [coverage_incomplete] -> exit 0 and every assertion reds. A commit that DELETES a reviewed
// file would then be unspendable at all, which is the gap A13 closes.
// SECOND SABOTAGE: record the deletion in the reservation as index_blobs[path] = 'absent' (a
// string) or omit the key -> the `null` assertion reds while the exit code stays 0; the
// verify step compares that map against the commit tree, and a sentinel string would compare
// equal to nothing.
test('R1-D124a (CONTROL, A13): a receipt whose content_evidence.absent_paths names src/gone.mjs SPENDS a commit that deletes src/gone.mjs — and the reservation records the deletion as index_blobs[path] = null', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // ORDER IS LOAD-BEARING: stageDeletion makes its own seed COMMIT, and the snapshot hook
    // reads a ledger that does not exist yet — install it only after the seed has landed.
    stageDeletion(dir, 'src/gone.mjs');
    installHook(dir, 'pre-commit', SNAPSHOT_HOOK);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '12400000-0000-4000-8000-00000000000a';
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-correctness', files: ['src/gone.mjs'],
      blobs: {}, absent_paths: ['src/gone.mjs'], base_sha: base,
    })]);

    const r = runCommitReviewed(dir, ['-m', 'D124a delete a reviewed file']);
    assert.equal(r.code, 0, `a reviewed DELETION is covered evidence — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'the deleting commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'and it is stamped');

    const mid = snapshotEntry(dir, id);
    assert.ok('src/gone.mjs' in (mid.reservation?.index_blobs ?? {}), `the deletion is RESERVED, not skipped — got ${JSON.stringify(mid.reservation)}`);
    assert.equal(mid.reservation.index_blobs['src/gone.mjs'], null, `and recorded as null — got ${JSON.stringify(mid.reservation.index_blobs)}`);
    assert.equal(entryById(dir, id).consumption?.commit_sha, head, 'the receipt is consumed against the deleting commit');
  } finally { cleanup(); }
});

// EXPECTED: RED today — today the receipt's blob for a path with no index entry is simply
// skipped, so the run either commits or refuses for a coverage reason; there is no
// facts.mismatches entry and certainly no `'absent'` sentinel.
// SABOTAGE: skip the byte comparison for any path with no index entry (`if (!indexBlob)
// continue`) -> a receipt that reviewed the file's CONTENT silently pays for a commit that
// DELETES it, exit 0 -> every assertion reds. That is a false attestation in the most literal
// sense: the reviewer approved bytes, the commit removed them, and nobody was told.
test('R1-D124b (A13): a receipt whose blobs name src/gone.mjs as PRESENT refuses [receipt_bytes_mismatch] when the commit DELETES it — facts.mismatches[0].index_blob === "absent"', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const blobWhilePresent = stageDeletion(dir, 'src/gone.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '12400000-0000-4000-8000-00000000000b';
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-correctness', files: ['src/gone.mjs'],
      blobs: { 'src/gone.mjs': blobWhilePresent }, absent_paths: [], base_sha: base,
    })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D124b delete a file reviewed as present', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'receipt_bytes_mismatch', `a present-vs-deleted disagreement is a MISMATCH, not a coverage hole — got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.mismatches, [{ path: 'src/gone.mjs', receipt_blob: blobWhilePresent, index_blob: 'absent' }],
      `the absent side is reported as the literal 'absent' sentinel — got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// THE THIRD COMBINATION A13 names, which neither arm above reaches: the receipt recorded the
// path ABSENT at Stop, but the commit stages CONTENT for it.
// EXPECTED: RED today — absent_paths is not consulted at spend at all today.
// SABOTAGE: treat absent_paths membership as "covered, nothing to compare" -> a receipt that
// reviewed a file's REMOVAL pays for a commit that RE-ADDS it, exit 0 -> red. Symmetric to
// D124b and caught by neither it nor D124a.
test('R1-D124c (A13): a receipt whose absent_paths names src/gone.mjs refuses [receipt_bytes_mismatch] when the commit STAGES CONTENT for it — facts.mismatches[0].receipt_blob === "absent"', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/gone.mjs', NEW);
    const staged = indexBlob(dir, 'src/gone.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '12400000-0000-4000-8000-00000000000c';
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-correctness', files: ['src/gone.mjs'],
      blobs: {}, absent_paths: ['src/gone.mjs'], base_sha: base,
    })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D124c re-add a file reviewed as absent', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'receipt_bytes_mismatch', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.mismatches, [{ path: 'src/gone.mjs', receipt_blob: 'absent', index_blob: staged }], `got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});
