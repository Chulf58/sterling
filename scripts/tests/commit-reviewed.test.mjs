// COMMIT-REVIEWED — BASE CLI CONTRACT (R1 pin re-cut, group D).
//
// AUTHORITY: decision `review-receipt-rebuild-invariant-three-owner-modules-tri-state-liveness-receipt-bound-supersession`
// (knowledge_get 24dc4c63) and the R1 contract sheet §1.4 (codes), §3.2 (spend), §6 A8/A9.
// Every refusal/disclosure is asserted by its `[code]` token or by --json's `code`/`facts`
// fields — never by sentence text. Consumption is a STATUS TRANSITION on the entry
// (status 'consumed' + consumption.commit_sha), never removal from the ledger.
//
// RETIRED: 'missing -m refuses with exit 1 and names the requirement' — prose assertion
//   (/-m|message/i) replaced by the [message_missing] code (R1-D01).
// RETIRED: 'zero un-consumed ledger entries (no ledger file at all) refuses' guidance-prose
//   assertions (/dispatch.*review/, /merge gate|commit bare/) — replaced by
//   [no_spendable_receipt] + facts.considered (R1-D06).
// RETIRED: 'zero un-consumed ledger entries (EMPTY array ledger) refuses identically' —
//   duplicate permutation of the same code; one arm per code (folded into R1-D06).
// RETIRED: 'with staged changes and 2 ledger entries ... CONSUMES the ledger' as
//   `deepEqual(ledgerAfter, [])` — consumption-by-removal is retired; the contract is now
//   status 'consumed' with consumption.commit_sha === HEAD (R1-D08).
// RETIRED: 'an IMMEDIATE second invocation ... (the ledger was consumed, zero entries
//   remain)' — the zero-entries premise is gone; re-cut as "a consumed receipt is never
//   selectable again" with facts.considered naming receipt_not_active (R1-D09).
// RETIRED: the ASSUMPTION marker on the nothing-staged arm — the sheet now names the code
//   [nothing_staged], so it is contract, not assumption (R1-D05).
// RETIRED: every v1 (flat agent_type/files/at) construction fixture — v1 entries are read
//   through the legacy adapter and are NEVER spendable (decision 24dc4c63); the single
//   surviving adapter pin is R1-D07b (legacy_entries_present).

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

// The pin convention (contract sheet §4): a refusal/disclosure is its code token.
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-'));
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
// Atomicity is asserted on RAW BYTES: a refusal that rewrites the file with the same
// logical content has still written to an evidence file during a refusal path.
const readLedgerRaw = (dir) => (existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null);

function stageChange(dir, relPath = 'src/feature.mjs', content = 'export const f = 1;\n') {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

// The INDEX blob (contract sheet §3.2 step 2 / A8) — the byte rule compares this.
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

// The EXACT read the merge gate uses, generalized over the trailer key (sheet §1.3).
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
const receiptTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Receipt', sha);

// ReceiptV2 per contract sheet §1.2 (+A3: a missing content_evidence.basis reads as
// 'stop-time-worktree-snapshot').
function v2({
  entry_id, agent_type, files, blobs = {}, index_blobs, base_sha,
  source = 'review-territory', status = 'active', evidence_status = 'complete',
  basis = 'stop-time-worktree-snapshot', at = isoAgo(60_000),
  session_id = SESSION, branch = 'main', consumption, reservation,
}) {
  const content_evidence = { status: evidence_status, blobs, absent_paths: [], truncated_of: null, failure_reason: null };
  if (basis !== undefined) content_evidence.basis = basis;
  if (index_blobs !== undefined) content_evidence.index_blobs = index_blobs;
  const e = {
    schema_version: 2, entry_id, kind: 'roster_receipt', status,
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch, base_sha, agent_id: `agent-${entry_id.slice(0, 8)}` },
    territory: { files, source, attribution: 'block' },
    content_evidence,
    disposition: null,
  };
  if (consumption !== undefined) e.consumption = consumption;
  if (reservation !== undefined) e.reservation = reservation;
  return e;
}

const entryById = (dir, id) => (readLedger(dir) ?? []).find((e) => e.entry_id === id);

function assertConsumedAt(dir, entryId, sha, label = '') {
  const e = entryById(dir, entryId);
  assert.ok(e, `${label} the receipt must still be PRESENT in the ledger after a spend — consumption is a status transition, never a deletion`);
  assert.equal(e.status, 'consumed', `${label} status must be 'consumed' — got ${JSON.stringify(e.status)}`);
  assert.equal(e.consumption?.commit_sha, sha, `${label} consumption.commit_sha must be the commit this run created`);
}

// Exactly one JSON object on stdout in --json mode (sheet §3.1/§3.2).
function soleJson(r) {
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `--json must print exactly ONE JSON object on stdout — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
  return parsed;
}

const CODE = 'export const f = 1;\n';

// ===========================================================================
// R1-D08 — CONTROL, PLACED FIRST. Every refusal pin below is this fixture minus
// one property, so a green refusal can never be explained by "this mode refuses
// everything".
// ===========================================================================

// EXPECTED: RED today — today's CLI stamps no `Review-Receipt` trailer at all and
// consumes by DELETING the entry, so the receiptTrailers deepEqual and the
// assertConsumedAt status check both fire.
// SABOTAGE: drop the `Review-Receipt: <entry_id>` trailer from the trailer block ->
// the receiptTrailers assertion goes red while Reviewed-By-Agent stays green.
// SECOND SABOTAGE: finalize by splicing the entry out of the ledger instead of
// setting status 'consumed' -> assertConsumedAt's "still PRESENT" assertion reds.
test('R1-D08 (CONTROL, first): a spendable v2 receipt covering the staged path commits — one Reviewed-By-Agent and one Review-Receipt trailer, entry status consumed with consumption.commit_sha === HEAD', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/feature.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = 'd8000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-correctness', files: ['src/feature.mjs'],
      blobs: { 'src/feature.mjs': indexBlob(dir, 'src/feature.mjs') }, base_sha: base,
    })]);

    const r = runCommitReviewed(dir, ['-m', 'feature, fully reviewed']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'a new commit was created');
    assert.equal(git(dir, ['log', '-1', '--format=%s']), 'feature, fully reviewed', 'the commit subject carries the -m message');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'one Reviewed-By-Agent trailer per stamped receipt');
    assert.deepEqual(receiptTrailers(dir), [id], 'one Review-Receipt trailer per stamped receipt, valued by entry_id');
    assertConsumedAt(dir, id, head);
  } finally { cleanup(); }
});

// ===========================================================================
// ARGUMENT SURFACE (contract sheet §3.2 flags; codes message_missing,
// argument_invalid, waiver_reason_missing).
// ===========================================================================

// EXPECTED: RED today — today's refusal is prose ("-m is required"); no [code] token exists.
// SABOTAGE: render the refusal without the code token (message only) -> the token
// assertion reds while exit 1 and HEAD-unmoved stay green.
test('R1-D01: no -m at all refuses [message_missing] — exit 1, HEAD unmoved, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    const id = 'd1000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], blobs: { 'src/feature.mjs': indexBlob(dir, 'src/feature.mjs') }, base_sha: git(dir, ['rev-parse', 'HEAD']) })]);
    const before = readLedgerRaw(dir);
    const head = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, []);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.match(`${r.stdout}\n${r.stderr}`, token('message_missing'), `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit was made without a message');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// EXPECTED: RED today — an empty -m is treated as a missing message today (same prose),
// and no code token is emitted either way.
// SABOTAGE: implement the check as `if (msg)` (truthiness) instead of "a message value was
// supplied and is non-empty" -> an empty -m falls through to a later refusal with a
// different code -> the [message_missing] token assertion reds.
test('R1-D02: an explicitly EMPTY -m ("") refuses [message_missing] too — a falsy message is a message defect, not a missing flag', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeLedger(dir, [v2({ entry_id: 'd2000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/feature.mjs'], blobs: { 'src/feature.mjs': indexBlob(dir, 'src/feature.mjs') }, base_sha: git(dir, ['rev-parse', 'HEAD']) })]);
    const head = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', '']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.match(`${r.stdout}\n${r.stderr}`, token('message_missing'), `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
  } finally { cleanup(); }
});

// EXPECTED: RED today — no [argument_invalid] code and no `facts.flag` field exist.
// SABOTAGE: report the offending token only in the message and leave facts.flag unset ->
// the facts assertion reds while the code assertion stays green. facts are the contract
// (sheet §4), not the sentence.
test('R1-D03: an unknown flag refuses [argument_invalid] with facts.flag naming the offending token, in --json', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    const head = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'x', '--not-a-real-flag', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.ok, false, `a refusal reports ok:false — got ${JSON.stringify(out)}`);
    assert.equal(out.code, 'argument_invalid', `got ${JSON.stringify(out)}`);
    assert.equal(out.facts?.flag, '--not-a-real-flag', `facts.flag must name the offending token — got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the flag is unimplemented; today's run refuses for an unrelated
// reason (or ignores it), and neither code token is emitted.
// ADJUDICATION (reported): the sheet gives both [argument_invalid] (missing value) and
// [waiver_reason_missing] (no reason). This pin splits them: a DANGLING --waive-bytes with
// no following token is an ARGUMENT defect; an EMPTY-string reason is a REASON defect.
// SABOTAGE: collapse the two into one code -> whichever arm's token assertion is not that
// code reds, and the pin names exactly which half was collapsed.
test('R1-D04: --waive-bytes with no value at all is [argument_invalid] facts.flag; --waive-bytes "" is [waiver_reason_missing] — a dangling flag and an empty reason are different defects', { skip: GIT_SKIP }, () => {
  for (const [label, args, code] of [
    ['dangling', ['-m', 'x', '--waive-bytes'], 'argument_invalid'],
    ['empty-reason', ['-m', 'x', '--waive-bytes', ''], 'waiver_reason_missing'],
  ]) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir);
      const head = git(dir, ['rev-parse', 'HEAD']);
      const r = runCommitReviewed(dir, [...args, '--json']);
      assert.equal(r.code, 1, `[${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      const out = soleJson(r);
      assert.equal(out.code, code, `[${label}] got ${JSON.stringify(out)}`);
      if (code === 'argument_invalid') {
        assert.equal(out.facts?.flag, '--waive-bytes', `[${label}] facts.flag names the flag whose value is missing — got ${JSON.stringify(out.facts)}`);
      }
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, `[${label}] no commit`);
    } finally { cleanup(); }
  }
});

// EXPECTED: RED today — today's contradiction refusal is prose-only (/contradict|conflict/),
// with no code token.
// SABOTAGE: check the contradiction as `if (msg && targetSha)` (truthiness) -> the
// empty-message arm bypasses it and refuses with [message_missing] instead -> that arm's
// token assertion reds while the non-empty arm stays green.
test('R1-D05: --target-sha combined with -m (real OR empty) refuses [argument_invalid] — amend mode cannot honour a caller-supplied message', { skip: GIT_SKIP }, () => {
  for (const [label, msg] of [['real', 'never honoured'], ['empty', '']]) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/seed.mjs', CODE);
      git(dir, ['commit', '-m', 'seed']);
      const targetSha = git(dir, ['rev-parse', 'HEAD']);
      const r = runCommitReviewed(dir, ['--target-sha', targetSha, '-m', msg, '--json']);
      assert.equal(r.code, 1, `[${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(soleJson(r).code, 'argument_invalid', `[${label}] got ${flat(r.stdout)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, `[${label}] HEAD unmoved`);
    } finally { cleanup(); }
  }
});

// ===========================================================================
// SELECT-STAGE REFUSALS (contract sheet §3.2 step 1).
// ===========================================================================

// EXPECTED: RED today — today's nothing-staged path refuses with prose and no code token.
// SABOTAGE: reach the select stage before checking the index -> the run refuses with
// [no_spendable_receipt] (or commits empty) -> the [nothing_staged] token reds.
test('R1-D06: nothing staged, with a spendable receipt present, refuses [nothing_staged] — the receipt is never consumed for an empty commit', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const id = 'd6000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/base.mjs'], blobs: { 'src/base.mjs': indexBlob(dir, 'src/base.mjs') }, base_sha: git(dir, ['rev-parse', 'HEAD']) })]);
    const before = readLedgerRaw(dir);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(git(dir, ['status', '--porcelain']), '', 'fixture guard: the tree is genuinely clean');

    const r = runCommitReviewed(dir, ['-m', 'nothing staged']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.match(`${r.stdout}\n${r.stderr}`, token('nothing_staged'), `stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical — the receipt survives');
    assert.equal(entryById(dir, id).status, 'active', 'and stays active');
  } finally { cleanup(); }
});

// EXPECTED: RED today — no [no_spendable_receipt] code and no facts.considered exist.
// SABOTAGE: emit facts.considered as a bare array of ids (no per-entry code) -> the
// {entry_id, code} shape assertion reds. The per-entry CODE is what tells an operator
// WHICH remedy applies; an id list alone reproduces today's undiagnosable refusal.
test('R1-D07: with a ledger present but no candidate, the refusal is [no_spendable_receipt] and facts.considered carries {entry_id, code} per rejected entry', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const foreign = 'd7000000-0000-4000-8000-000000000001';
    const unknownId = 'd7000000-0000-4000-8000-000000000002';
    writeLedger(dir, [
      v2({ entry_id: foreign, agent_type: 'reviewer-foreign', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, session_id: 'some-other-session' }),
      v2({ entry_id: unknownId, agent_type: 'reviewer-idless', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, session_id: null }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'no candidate', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'no_spendable_receipt', `got ${JSON.stringify(out)}`);
    const considered = out.facts?.considered ?? [];
    assert.ok(Array.isArray(considered) && considered.length === 2, `facts.considered lists every rejected entry — got ${JSON.stringify(considered)}`);
    const byId = Object.fromEntries(considered.map((c) => [c.entry_id, c.code]));
    assert.equal(byId[foreign], 'receipt_foreign_session', `got ${JSON.stringify(considered)}`);
    assert.equal(byId[unknownId], 'receipt_identity_unknown', `got ${JSON.stringify(considered)}`);
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// EXPECTED: RED today — a corrupt ledger refuses today, but with the same prose as the
// zero-entry case and no code token, so the distinction is unobservable.
// SABOTAGE: catch the JSON parse error and continue with `entries = []` -> the run refuses
// with [no_spendable_receipt] and the [ledger_corrupt] assertion reds. That is exactly the
// silent-degradation shape P5 forbids: an unreadable evidence file must not read as an
// empty one.
test('R1-D07b: a corrupt ledger refuses [ledger_corrupt], never [no_spendable_receipt] — unreadable evidence is not absent evidence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir);
    writeFileSync(ledgerPath(dir), '{ not json at all');
    const head = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'corrupt ledger']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, token('ledger_corrupt'), `stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(out, token('no_spendable_receipt'), `a corrupt ledger is not an empty one — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError|SyntaxError/, `a refusal, never a crash — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
  } finally { cleanup(); }
});

// THE ONE SURVIVING v1 ADAPTER PIN (decision 24dc4c63: v1 entries are read through ONE
// adapter, never rewritten by reading, never spent).
// EXPECTED: RED today — today a v1 entry IS spendable and would stamp and be consumed.
// SABOTAGE: let the legacy adapter's output into the candidate set -> the v1 entry stamps,
// exit 0, and the [legacy_entries_present]/[no_spendable_receipt] assertions red.
// SECOND SABOTAGE: read v1 entries and rewrite them into v2 shape on read -> the
// byte-identical assertion reds while the exit code stays 1.
test('R1-D09: a v1 (flat) entry is DISCLOSED [legacy_entries_present] and NEVER spent — the run refuses [no_spendable_receipt] and the ledger is byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    writeLedger(dir, [{ agent_type: 'reviewer-legacy', files: ['src/laneA.mjs'], at: isoAgo(60_000), session_id: SESSION, branch: 'main' }]);
    const before = readLedgerRaw(dir);
    const head = git(dir, ['rev-parse', 'HEAD']);

    const r = runCommitReviewed(dir, ['-m', 'legacy entry only']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, token('legacy_entries_present'), `the v1 entry is LISTED — stderr=${flat(r.stderr)}`);
    assert.match(out, token('no_spendable_receipt'), `and never selected — stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'the v1 entry is never rewritten by being read');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the entry would already be gone (consumed-by-deletion), so
// facts.considered cannot name it at all.
// SABOTAGE: select on `status !== 'discharged'` instead of `status === 'active'` -> a
// consumed receipt is re-selected and double-spent -> exit 0, a second commit lands with
// the same Review-Receipt trailer -> every assertion reds. This is the multiplicity pin.
test('R1-D10: a receipt already status "consumed" is never spent twice — the second run refuses [no_spendable_receipt] naming it receipt_not_active', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = 'da000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({
      entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base,
      status: 'consumed', consumption: { commit_sha: 'a'.repeat(40), consumed_at: isoAgo(1_000), nonce: 'nonce-1' },
    })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'double spend attempt', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'no_spendable_receipt', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.considered, [{ entry_id: id, code: 'receipt_not_active' }], `got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no second commit');
    assert.equal(readLedgerRaw(dir), before, 'the consumed receipt is untouched');
  } finally { cleanup(); }
});

// EXPECTED: RED today — today's success path prints a summary object AND human advisory
// lines on stderr, but there is no --json mode contract and no `ok` field.
// SABOTAGE: print the human summary on stdout beside the JSON object -> JSON.parse throws
// -> soleJson reds. "Exactly one JSON object on stdout" is the machine contract the merge
// surfaces read; a second line makes it unparseable.
test('R1-D11: --json prints exactly ONE JSON object on stdout on SUCCESS too, carrying ok:true and the created commit sha', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = 'db000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'json mode', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.ok, true, `got ${JSON.stringify(out)}`);
    assert.equal(out.commit_sha, git(dir, ['rev-parse', 'HEAD']), `the report names the sha it created — got ${JSON.stringify(out)}`);
    assert.ok(Array.isArray(out.disclosures), `disclosures[] is present-as-array even when empty — got ${JSON.stringify(out.disclosures)}`);
  } finally { cleanup(); }
});
