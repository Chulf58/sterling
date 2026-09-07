// COMMIT-REVIEWED — HARDENING: concurrent ledger writes, entry validation, trailer
// multiplicity, the project guard, and the verification target (R1 pin re-cut, group D).
//
// AUTHORITY: contract sheet §1.2 (`readLedger`/`writeLedger` under `withLedgerLock`;
// `classifyLedgerEntry` → `{kind:'malformed', code:'ledger_entry_malformed'}`), §3.2 steps
// 3-5. Every property here is exercised through REAL git hooks in the fixture repo, which is
// the only way to observe "while git commit runs" without reading the implementation.
//
// RETIRED: CONSUME-ONLY-AFTER-SUCCESS — re-cut as the reserve/release pin
//   commit-reviewed-two-phase-spend.test.mjs R1-D104, which additionally proves the entry was
//   reserved before the release (this file's version could not tell "released" from
//   "never reserved").
// RETIRED: N2 TRAILER SURVIVES — it is the happy path, pinned as commit-reviewed.test.mjs
//   R1-D08; a second copy added no distinct failure.
// RETIRED: N2 TRAILER DESTROYED with its `COMMIT SUCCEEDED` / `UNMERGEABLE` prose assertions
//   — re-cut as commit-reviewed-two-phase-spend.test.mjs R1-D109, asserted by outcome
//   (not consumed, not reported successful) rather than by wording.
// RETIRED: every v1 (flat agent_type/files/at) fixture — v1 entries are never spendable; the
//   validation family is re-cut onto reviewer.agent_type inside a v2 receipt.

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

function makeRepo({ sterling = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-harden-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  if (sterling) mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ledgerPath = (dir) => join(dir, '.sterling', 'review-ledger.json');
const writeLedger = (dir, entries) => writeFileSync(ledgerPath(dir), JSON.stringify(entries));
const readLedger = (dir) => (existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null);
const readLedgerRaw = (dir) => (existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null);
const entryById = (dir, id) => (readLedger(dir) ?? []).find((e) => e.entry_id === id);

function stageChange(dir, relPath, content = 'export const f = 1;\n') {
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
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
const receiptTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Receipt', sha);
const commitMessage = (dir, sha = 'HEAD') => git(dir, ['log', '-1', '--format=%B', sha]);

function installHook(dir, name, script) {
  const p = join(dir, '.git', 'hooks', name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
}

function v2({ entry_id, agent_type, files, blobs = {}, base_sha, at = isoAgo(60_000) }) {
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active',
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha, agent_id: 'agent-fixture' },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot', status: 'complete', blobs,
      absent_paths: [], truncated_of: null, failure_reason: null,
    },
    disposition: null,
  };
}

// A pre-commit hook that APPENDS a fresh entry to the ledger while `git commit` is mid-flight
// — i.e. between this run's reserve and its finalize.
const HOOK_APPEND_ENTRY = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const p = path.join(process.cwd(), '.sterling', 'review-ledger.json');
let entries = [];
try { entries = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { entries = []; }
entries.push({
  schema_version: 2, entry_id: 'aaaaaaaa-0000-4000-8000-000000000999', kind: 'roster_receipt', status: 'active',
  started_at: '2026-09-07T00:00:00.000Z', finished_at: '2026-09-07T00:00:00.000Z',
  reviewer: { agent_type: 'reviewer-security', model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
  identity: { session_id: 'this-session', branch: 'main', base_sha: null, agent_id: 'agent-hook' },
  territory: { files: ['src/hookadded.mjs'], source: 'review-territory', attribution: 'block' },
  content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs: {}, absent_paths: [], truncated_of: null, failure_reason: null },
  disposition: null
});
fs.writeFileSync(p, JSON.stringify(entries));
`;

// A post-commit hook that lands a SECOND, untrailered commit — any concurrent process moving
// HEAD between this run's commit and its own later reads.
const HOOK_MOVE_HEAD = `#!/usr/bin/env node
const fs = require('fs');
const { execFileSync } = require('child_process');
fs.writeFileSync('post-commit-hook-file.mjs', '// landed by the post-commit hook\\n');
execFileSync('git', ['add', '-A']);
execFileSync('git', ['commit', '--no-verify', '-m', 'unrelated commit landed by a concurrent process']);
`;

// ===========================================================================

// EXPECTED: RED today — today's finalize writes back an in-memory snapshot minus the stamped
// entries, so the hook's concurrent append is erased; the survivor assertions fire.
// SABOTAGE: finalize by writing the pre-commit snapshot (or `[]`) instead of re-reading the
// ledger under the lock and transitioning ONLY the reserved entry_ids -> the hook's entry
// vanishes -> red. That erasure destroys a real reviewer's evidence with no trace at all,
// which is why the re-read is part of the finalize contract rather than an optimisation.
test('R1-D82 (CONSUME-SNAPSHOT): an entry appended to the ledger by a pre-commit hook WHILE git commit runs survives finalize — only the reserved entry_ids are transitioned', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installHook(dir, 'pre-commit', HOOK_APPEND_ENTRY);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '82000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D82 hook appends mid-commit']);
    assert.equal(r.code, 0, `the hook exits 0, so the commit must land — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(receiptTrailers(dir), [id], 'the trailer set reflects only what was reserved before the hook ran');

    const after = readLedger(dir);
    assert.equal(after.length, 2, `both entries are present after the run — got ${JSON.stringify(after.map((e) => e.entry_id))}`);
    assert.equal(entryById(dir, id).status, 'consumed', 'the reserved entry is finalized');
    const hookEntry = after.find((e) => e.reviewer?.agent_type === 'reviewer-security');
    assert.ok(hookEntry, 'the concurrently-appended entry is NOT erased');
    assert.equal(hookEntry.status, 'active', 'and is untouched — it was never reserved by this run');
  } finally { cleanup(); }
});

// EXPECTED: RED today — today an unsafe agent_type is interpolated straight into the trailer
// block with no shape check, so 4 trailers land instead of 1 and no code is emitted.
// SABOTAGE: build the trailer by plain interpolation of `reviewer.agent_type` -> a literal
// newline splits the commit message, `null` stringifies to "null" and an object to
// "[object Object]", all three stamp as if valid -> the trailer deepEqual and the
// no-forged-line assertion red together.
// SECOND SABOTAGE: drop malformed entries silently -> only the [ledger_entry_malformed]
// assertion reds, which is the half pinning that evidence is never discarded in silence.
test('R1-D83 (VALIDATION): receipts whose reviewer.agent_type is unsafe (embedded newline), null, or an object are [ledger_entry_malformed] — skipped, disclosed, left in the ledger, while a valid receipt beside them spends', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const good = '83000000-0000-4000-8000-000000000004';
    const bad = ['83000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000002', '83000000-0000-4000-8000-000000000003'];
    writeLedger(dir, [
      v2({ entry_id: bad[0], agent_type: 'reviewer-good\nCo-authored-by: attacker', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: bad[1], agent_type: null, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: bad[2], agent_type: { nested: true }, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: good, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D83 mixed valid/invalid entries']);
    assert.equal(r.code, 0, `a ledger with one valid receipt still spends — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'exactly one trailer — the sole safe entry');
    assert.deepEqual(receiptTrailers(dir), [good], 'and exactly one Review-Receipt binding');
    assert.doesNotMatch(commitMessage(dir), /Co-authored-by: attacker/, 'no forged line reaches the durable commit message');
    assert.match(`${r.stdout}\n${r.stderr}`, token('ledger_entry_malformed'), `the skipped entries are DISCLOSED — stderr=${flat(r.stderr)}`);
    for (const id of bad) assert.ok(entryById(dir, id), `${id} survives in the ledger un-consumed`);
  } finally { cleanup(); }
});

// EXPECTED: RED today — today all three garbage entries are stamped and the run exits 0.
// SABOTAGE: fall back to "spend whatever parses well enough" when nothing is selectable ->
// exit 0 with garbage trailers -> red. A ledger of only malformed entries is a ledger with
// zero evidence, and it must refuse exactly like an empty one.
test('R1-D84 (VALIDATION): a ledger of ONLY malformed entries refuses [no_spendable_receipt] — nothing is stamped, HEAD is unmoved, the ledger is byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    writeLedger(dir, [
      v2({ entry_id: '84000000-0000-4000-8000-000000000001', agent_type: 'reviewer-good\nCo-authored-by: attacker', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: '84000000-0000-4000-8000-000000000002', agent_type: null, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D84 only invalid entries']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.match(`${r.stdout}\n${r.stderr}`, token('no_spendable_receipt'), `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// EXPECTED: RED today only on the two Review-Receipt trailers and the consumed statuses; the
// roster-trailer half already holds.
// SABOTAGE: de-duplicate trailers by value (build a Set of agent_types before stamping) ->
// one roster trailer instead of two -> red. Each receipt is a distinct piece of review
// evidence even when the reviewer ROLE recurs, and the Review-Receipt trailers are what keep
// the two distinguishable at the merge gate.
test('R1-D85 (DUPLICATES): two receipts sharing one agent_type stamp TWO Reviewed-By-Agent lines and TWO distinct Review-Receipt lines — no dedupe by value', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const id1 = '85000000-0000-4000-8000-000000000001';
    const id2 = '85000000-0000-4000-8000-000000000002';
    writeLedger(dir, [
      v2({ entry_id: id1, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: id2, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D85 two rounds from one reviewer role']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness', 'reviewer-correctness'], 'one roster trailer line PER receipt');
    assert.deepEqual(receiptTrailers(dir).sort(), [id1, id2].sort(), 'and one Review-Receipt line per receipt, distinct by entry_id');
    for (const id of [id1, id2]) assert.equal(entryById(dir, id).status, 'consumed', `${id} consumed`);
  } finally { cleanup(); }
});

// THE PROJECT GUARD (contract sheet §6 A13: `not_sterling_project` — "no .sterling/ at the
// project root → refusal BEFORE any git action").
// EXPECTED: RED today — the code does not exist and today's guard reuses the zero-receipt
// guidance, which presupposes a Sterling-governed repo.
// SABOTAGE: treat "ledger file missing" (because .sterling/ itself is missing) identically to
// "ledger present but empty" -> [no_spendable_receipt] here instead -> both the code and the
// doesNotMatch assertion red, and the operator is told to dispatch a reviewer in a repo
// Sterling does not govern.
// SECOND SABOTAGE: run the guard AFTER the staged-diff read or any other git action -> the
// code assertion may stay green while the refusal is no longer the first thing that happens;
// the `--json` object is what pins that it refused rather than proceeded.
test('R1-D86 (PROJECT GUARD): invoked where .sterling/ does not exist at all, the CLI refuses [not_sterling_project] — never [no_spendable_receipt] — and makes no commit', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo({ sterling: false });
  try {
    assert.equal(existsSync(join(dir, '.sterling')), false, 'fixture guard: genuinely not a Sterling project');
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'D86 outside any Sterling project', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    let out;
    assert.doesNotThrow(() => { out = JSON.parse(r.stdout); }, `--json must print exactly ONE JSON object even here — stdout=${flat(r.stdout)}`);
    assert.equal(out.code, 'not_sterling_project', `got ${JSON.stringify(out)}`);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, token('no_spendable_receipt'),
      `a missing project is not an empty ledger — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
  } finally { cleanup(); }
});

// A DANGLING --target-sha SELECTS A DIFFERENT MODE, which is the worst shape an argument
// defect can take: today the flag with no value falls through to NEW-COMMIT mode, so an
// operator who meant to amend an existing commit silently creates a new one instead — and the
// amend guards (tip-only, clean tree, publication) never run at all.
// EXPECTED: RED today — the fall-through succeeds (or refuses for an unrelated reason) and
// there is no [argument_invalid] code.
// SABOTAGE: parse the flag as `argv[i+1] ?? null` and treat null as "not in amend mode" -> a
// new commit is created, exit 0 -> the exit-code and HEAD-unmoved assertions red. A flag whose
// ABSENT VALUE changes the operation must refuse, never default.
// TWO ARMS, because "no value" has two spellings and a parser can get one right and the other
// wrong: (a) the flag is the LAST token, so nothing follows it; (b) the next token is ANOTHER
// FLAG, which a naive `argv[i+1]` parser swallows as the value and then reports as an
// unresolvable sha — a different, misleading refusal for the same operator mistake.
test('R1-D88 (ARGUMENT): --target-sha with a MISSING value refuses [argument_invalid] facts.flag "--target-sha" — never falling through to new-commit mode, and never swallowing the next FLAG as its value', { skip: GIT_SKIP }, () => {
  for (const [label, args] of [
    ['last-token', ['--json', '--target-sha']],
    ['next-token-is-a-flag', ['--target-sha', '--json']],
  ]) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs');
      const base = git(dir, ['rev-parse', 'HEAD']);
      const id = '88000000-0000-4000-8000-000000000001';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, args);
      assert.equal(r.code, 1, `[${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      let out;
      assert.doesNotThrow(() => { out = JSON.parse(r.stdout); }, `[${label}] --json must still print exactly ONE JSON object — stdout=${flat(r.stdout)}`);
      assert.equal(out.code, 'argument_invalid', `[${label}] got ${JSON.stringify(out)}`);
      assert.equal(out.facts?.flag, '--target-sha',
        `[${label}] facts.flag names the flag whose value is missing — not '--json' swallowed as a sha, and not a target_sha_unresolvable refusal that sends the operator looking for a commit — got ${JSON.stringify(out.facts)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), base, `[${label}] no commit was created in either mode`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
    } finally { cleanup(); }
  }
});

// EXPECTED: RED today on the consumption.commit_sha assertion — today's consume records no
// sha at all, so the "which commit did this receipt pay for" question has no answer to be
// wrong about.
// SABOTAGE: verify and finalize against a bare `git rev-parse HEAD` read AFTER the commit
// instead of against the sha this invocation created -> the run either reports a false
// trailer-destroyed failure or binds the receipt to the hook's unrelated commit -> the exit
// code or the consumption.commit_sha assertion reds. Both outcomes are silent
// mis-attribution: the merge gate would then resolve the receipt against a commit no reviewer
// ever saw.
test('R1-D87 (VERIFICATION TARGET): a post-commit hook that moves HEAD does not fool verification — the receipt is consumed against the sha THIS invocation created, never against whatever HEAD became', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installHook(dir, 'post-commit', HOOK_MOVE_HEAD);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '87000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D87 hook lands a second commit after']);
    assert.equal(r.code, 0, `verification must target the created sha, not the moving HEAD — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);

    const headSha = git(dir, ['rev-parse', 'HEAD']);
    const createdSha = git(dir, ['rev-parse', 'HEAD~1']);
    assert.equal(git(dir, ['log', '-1', '--format=%s', headSha]), 'unrelated commit landed by a concurrent process', 'fixture guard: HEAD really moved past the reviewed commit');
    assert.deepEqual(receiptTrailers(dir, createdSha), [id], 'the reviewed commit carries the binding');
    assert.deepEqual(receiptTrailers(dir, headSha), [], 'fixture guard: the hook-landed commit carries none');
    assert.equal(entryById(dir, id).consumption?.commit_sha, createdSha, 'and the consumption names THAT commit, not HEAD');
  } finally { cleanup(); }
});
