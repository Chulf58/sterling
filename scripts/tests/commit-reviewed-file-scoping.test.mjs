// COMMIT-REVIEWED — SELECTION BY COVERED-PATH OVERLAP AND COMMIT COVERAGE
// (R1 pin re-cut, group D).
//
// AUTHORITY: contract sheet §3.2 step 1 — "candidates = receipts with `receiptIsSpendable`
// ok whose territory overlaps the staged code paths; unattributable NEVER selected
// (disclosure); coverage: every staged code path must be covered by ≥1 selected receipt else
// `coverage_incomplete` (the incomplete-coverage refusal that caught a real defect, kept as a
// code)" — with §6 A9 (`receiptCoveredPaths` = declared paths that HAVE a usable blob) and
// the disclosure `receipt_no_overlap` ("a spendable receipt whose territory misses this diff
// — stays active").
//
// TWO SHIPPED RULES, RULED ON SEPARATELY BY SHEET AMENDMENT A13 — do not collapse them:
//   (1) the no-match STAMPING FALLBACK is RETIRED. A receipt whose territory misses the diff
//       is `receipt_no_overlap` and stays ACTIVE (R1-D13).
//   (2) decision c45b6ee4's UNSCOPED partition SURVIVES. A receipt with territory.files []
//       (source ≠ unattributable) is ALWAYS selected and stamped on a commit that otherwise
//       succeeds — disclosed `receipt_unscoped`, consumed with an EMPTY reservation map — but
//       it NEVER satisfies coverage of a code path (R1-D16a / R1-D16b).
// An earlier draft of this file read (2) as a casualty of (1); A13 overturned that. The two
// arms of R1-D16 are what keep the halves from being collapsed again in either direction.
//
// RETIRED: S4 (empty files[] is always stamped, asserted only as a trailer count) — the RULE
//   survives per A13 and is re-cut as R1-D16a/R1-D16b, which add the disclosure code, the
//   empty reservation map and the coverage half S4 never pinned.
// RETIRED: S5 (the no-match FALLBACK stamps everything) — retired with the fallback itself;
//   the non-overlap case is now the [receipt_no_overlap] disclosure (R1-D13) and, when it
//   leaves a staged path uncovered, [coverage_incomplete] (R1-D15).
// RETIRED: S6 (the stamped set is a strict subset) — its assertions are the trailer
//   deepEquals in R1-D13; a separate arm restated them.
// RETIRED: S9/S10/S11 (the agent_type+at+files multiset consume key and its shape stability)
//   — reservation and consumption are keyed by ENTRY_ID (decision 24dc4c63: "the old
//   agent_type+at+identity multiset key is retired for v2"), so the whole key-shape family
//   goes; the identity-partitioning CONTRACT it protected survives as R1-D19.
// RETIRED: S12 (a v2 entry is selected by file intersection) — every fixture in this file is
//   v2 now, so it is no longer a distinct pin.
// RETIRED: S13 (a structurally deficient v2 entry is withheld) — that is
//   [ledger_entry_malformed], pinned in commit-reviewed-bytes-v2-malformed.test.mjs.
// RETIRED: every `DEFERRED RECEIPT` / `RECORDS NO FILES` / `RECEIPT FILES DO NOT OVERLAP THIS
//   DIFF` banner assertion — converted to [code] tokens and --json `disclosures[].code`.

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
function soleJson(r) {
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `--json must print exactly ONE JSON object on stdout — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
  return parsed;
}
const hasDisclosure = (out, code, id) => (out.disclosures ?? []).some((d) => d.code === code && JSON.stringify(d).includes(id));

// A REAL pre-commit hook snapshotting the ledger mid-`git commit` — after RESERVE, before
// FINALIZE. The only way to read a reservation, which finalize then clears.
function installSnapshotHook(dir) {
  const p = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(p, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.copyFileSync(path.join(process.cwd(), '.sterling', 'review-ledger.json'), path.join(process.cwd(), '.sterling', 'mid-commit-snapshot.json'));
`, { mode: 0o755 });
  chmodSync(p, 0o755);
}
const snapshotEntry = (dir, id) =>
  JSON.parse(readFileSync(join(dir, '.sterling', 'mid-commit-snapshot.json'), 'utf8')).find((e) => e.entry_id === id);

function v2({
  entry_id, agent_type, files, blobs = {}, base_sha, source = 'review-territory',
  at = isoAgo(60_000), session_id = SESSION, branch = 'main',
}) {
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active',
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch, base_sha, agent_id: `agent-${entry_id.slice(0, 8)}` },
    territory: { files, source, attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot', status: 'complete', blobs,
      absent_paths: [], truncated_of: null, failure_reason: null,
    },
    disposition: null,
  };
}

// ===========================================================================
// R1-D12 — CONTROL, PLACED FIRST: when every receipt covers the staged path,
// nothing is withheld. Without it, "only the covering receipt was stamped" is
// satisfied by a CLI that stamps at most one receipt for any reason.
// ===========================================================================

// EXPECTED: RED today only on the consumed-status assertions and the Review-Receipt trailers.
// SABOTAGE: cap the stamped set at one receipt -> the two-element trailer deepEquals red.
test('R1-D12 (CONTROL, first): two receipts that BOTH cover the staged path are both stamped and both consumed — nothing withheld, no receipt_no_overlap', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/laneA.mjs');
    const id1 = '12000000-0000-4000-8000-000000000001';
    const id2 = '12000000-0000-4000-8000-000000000002';
    writeLedger(dir, [
      v2({ entry_id: id1, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
      v2({ entry_id: id2, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D12 both cover lane A', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir).sort(), ['reviewer-correctness', 'reviewer-security']);
    assert.deepEqual(receiptTrailers(dir).sort(), [id1, id2].sort());
    const out = soleJson(r);
    assert.ok(!codes(out).includes('receipt_no_overlap'), `nothing may be withheld when every receipt covers — got ${JSON.stringify(out.disclosures)}`);
    for (const id of [id1, id2]) assert.equal(entryById(dir, id).status, 'consumed', `${id} consumed`);

    function codes(o) { return (o.disclosures ?? []).map((d) => d.code); }
  } finally { cleanup(); }
});

// THE MEASURED SHAPE (decision c45b6ee4: four receipts, three slices, all spent on one
// commit). Two lanes reviewed concurrently, only lane A staged.
// EXPECTED: RED today — today lane B is DEFERRED with prose and no code; there is no
// [receipt_no_overlap] and no Review-Receipt trailer.
// SABOTAGE: select every spendable receipt instead of only those whose covered paths overlap
// the staged set -> lane B is stamped onto a commit its reviewer never saw -> the trailer
// deepEquals and the surviving-entry assertion all red. That false attestation is the entire
// reason the overlap rule exists.
test('R1-D13: with two disjoint-territory receipts, committing lane A stamps and consumes ONLY lane A — lane B is disclosed [receipt_no_overlap], stays ACTIVE and byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneB.mjs');
    git(dir, ['commit', '-m', 'seed lane B']);
    const laneBBlob = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = '13000000-0000-4000-8000-000000000001';
    const idB = '13000000-0000-4000-8000-000000000002';
    const laneB = v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlob }, base_sha: base });
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base }),
      laneB,
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D13 lane A only', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'ONLY the covering receipt is stamped — no false attestation for lane B');
    assert.deepEqual(receiptTrailers(dir), [idA], 'and only its entry_id is bound to the commit');
    const out = soleJson(r);
    assert.ok(hasDisclosure(out, 'receipt_no_overlap', idB), `the withholding is disclosed and names the receipt — got ${JSON.stringify(out.disclosures)}`);
    assert.match(r.stderr, token('receipt_no_overlap'), `and reaches the human channel — stderr=${flat(r.stderr)}`);
    assert.deepEqual(entryById(dir, idB), laneB, 'lane B survives EXACTLY as written: not stamped, not reserved, not consumed, not deleted');
  } finally { cleanup(); }
});

// EXPECTED: RED today only in that the first run's consumption is now a status change;
// the second run's behaviour is today's too.
// SABOTAGE: consume every eligible receipt in the first run -> lane B is gone and the second
// run refuses [no_spendable_receipt] -> red. Withholding is DEFERRAL, never stranding: the
// commit staging lane B must still be able to spend it.
test('R1-D14: the receipt withheld by the lane A commit is spent normally by the LATER commit that stages lane B', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneB.mjs');
    git(dir, ['commit', '-m', 'seed lane B']);
    const laneBBlobAtReview = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = '14000000-0000-4000-8000-000000000001';
    const idB = '14000000-0000-4000-8000-000000000002';
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base }),
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlobAtReview }, base_sha: base }),
    ]);

    assert.equal(runCommitReviewed(dir, ['-m', 'D14 lane A']).code, 0, 'round one commits lane A');
    assert.equal(entryById(dir, idB).status, 'active', 'lane B is still spendable after round one');

    // Stage lane B's own slice, and point the still-active receipt at the bytes now staged
    // (a fresh review of lane B) so the byte rule is satisfied and the only question left is
    // whether the withheld receipt is still spendable.
    stageChange(dir, 'src/laneB.mjs', 'export const laneB = 2;\n');
    const restaged = indexBlob(dir, 'src/laneB.mjs');
    // Point the still-active receipt at the bytes now staged (a fresh review of lane B).
    const ledger = readLedger(dir);
    ledger.find((e) => e.entry_id === idB).content_evidence.blobs['src/laneB.mjs'] = restaged;
    writeLedger(dir, ledger);

    const r2 = runCommitReviewed(dir, ['-m', 'D14 lane B']);
    assert.equal(r2.code, 0, `the withheld receipt must be spendable on its own slice — stdout=${flat(r2.stdout)} stderr=${flat(r2.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-security'], 'the lane B commit carries exactly its own reviewer');
    assert.equal(entryById(dir, idB).status, 'consumed', 'and NOW it is consumed');
  } finally { cleanup(); }
});

// THE INCOMPLETE-COVERAGE REFUSAL THAT CAUGHT A REAL DEFECT (sheet §3.2 step 1, kept as a
// code with its byte-identical-ledger assertion).
// EXPECTED: RED today — today an uncovered staged path is at most an advisory and the commit
// lands; there is no [coverage_incomplete] and no facts.uncovered.
// SABOTAGE: check coverage only over the paths the SELECTED receipts declare, instead of over
// the STAGED set -> the uncovered lane is invisible, exit 0, a commit lands carrying a review
// trailer for a diff half of which nobody reviewed -> every assertion reds.
test('R1-D15: a staged code path that NO selected receipt covers refuses [coverage_incomplete] with facts.uncovered — even though another staged path IS covered; ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    stageChange(dir, 'src/laneUnreviewed.mjs', 'export const nobody = 1;\n');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = '15000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D15 half the diff is unreviewed', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'coverage_incomplete', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.uncovered, ['src/laneUnreviewed.mjs'], `the facts name exactly the uncovered path — got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical — the covering receipt is not consumed for a refused commit');
  } finally { cleanup(); }
});

// UNSCOPED RECEIPTS (contract sheet §6 A13): territory.files [] with source ≠ unattributable
// is the ALWAYS-STAMPED partition the decision KEEPS. Two arms, because the rule has two
// halves that pull in opposite directions and either one alone is satisfiable by the wrong
// implementation: it is always SELECTED and STAMPED (arm a), and it NEVER satisfies COVERAGE
// (arm b). A build that only implements the first stamps unscoped receipts onto unreviewed
// diffs; one that only implements the second bricks the "review only, do not modify" dispatch
// whose receipt legitimately records no territory.
// EXPECTED: arm (a) RED today on the disclosure code, the empty reservation map and the
// consumed status; arm (b) RED today (today the unscoped receipt is stamped and the commit
// succeeds, so exit 0 and no facts.considered).
// SABOTAGE (arm a): treat an empty territory as a non-overlap -> the receipt is withheld,
// merge-gate review evidence for a real review is silently dropped -> the trailer and
// consumed assertions red.
// SABOTAGE (arm b): let an unscoped receipt count toward coverage -> exit 0 and a code diff
// nobody reviewed commits carrying a review trailer -> the exit-code and facts assertions red.
// The two sabotages are one-line changes in OPPOSITE directions; neither arm sees the other's.
test('R1-D16a (A13): an UNSCOPED receipt (territory.files []) beside a covering receipt is ALWAYS stamped and consumed, disclosed [receipt_unscoped], with an EMPTY reservation map', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installSnapshotHook(dir);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idCovering = '16000000-0000-4000-8000-00000000000a';
    const idUnscoped = '16000000-0000-4000-8000-00000000000b';
    writeLedger(dir, [
      v2({ entry_id: idCovering, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base }),
      v2({ entry_id: idUnscoped, agent_type: 'reviewer-blank', files: [], blobs: {}, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D16a unscoped beside a covering receipt', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.deepEqual(reviewedByTrailers(dir).sort(), ['reviewer-blank', 'reviewer-correctness'], 'the unscoped receipt IS stamped — withholding it would destroy real merge-gate evidence');
    assert.deepEqual(receiptTrailers(dir).sort(), [idCovering, idUnscoped].sort(), 'and bound like any other');
    const out = soleJson(r);
    assert.ok(hasDisclosure(out, 'receipt_unscoped', idUnscoped), `the unscoped stamp is DISCLOSED, never silent — got ${JSON.stringify(out.disclosures)}`);
    assert.deepEqual(snapshotEntry(dir, idUnscoped).reservation.index_blobs, {}, `an unscoped receipt reserves NOTHING — got ${JSON.stringify(snapshotEntry(dir, idUnscoped).reservation)}`);
    for (const id of [idCovering, idUnscoped]) assert.equal(entryById(dir, id).consumption?.commit_sha, head, `${id} consumed against this commit`);
  } finally { cleanup(); }
});

test('R1-D16b (A13): an UNSCOPED receipt ALONE against a code diff never satisfies coverage — the run refuses [coverage_incomplete] and facts.considered names it as receipt_unscoped', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '16000000-0000-4000-8000-00000000000c';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-blank', files: [], blobs: {}, base_sha: base })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'D16b unscoped alone', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'coverage_incomplete', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.uncovered, ['src/laneA.mjs'], `got ${JSON.stringify(out.facts)}`);
    assert.deepEqual(out.facts?.considered, [{ entry_id: id, code: 'receipt_unscoped' }],
      `the refusal names WHY the only receipt could not close the gap — got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.deepEqual(reviewedByTrailers(dir, base), [], 'nothing was stamped anywhere');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// THE CODE-PATH CLASSIFIER (A13: one exported `isCodePath`; these fixtures are its pinned
// example — `src/**/*.mjs` is code, `docs/**/*.md` is not).
// EXPECTED: RED today — today's classifier is an inline predicate with no pinned example, and
// the consumed-status assertion is new either way.
// SABOTAGE: treat every staged path as a code path -> the docs file becomes an uncovered code
// path and the run refuses [coverage_incomplete] -> exit 0 and the consumed assertions red. A
// prose-only commit would then be unspendable, which is the inverse failure of D15's.
test('R1-D15b (A13): a staged NON-code path (docs/**/*.md) needs no review coverage — a commit staging a covered src/**/*.mjs beside an uncovered docs file succeeds', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs');
    stageChange(dir, 'docs/notes.md', '# notes nobody has to review\n');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = '15b00000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D15b code beside prose']);
    assert.equal(r.code, 0, `only CODE paths need coverage — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), base, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness']);
    assert.equal(entryById(dir, id).status, 'consumed');
  } finally { cleanup(); }
});

// EXPECTED: GREEN today and after (path normalization is the path owner's job); this pin is
// a regression guard for a cosmetic difference silently withholding a real review's stamp.
// THE PATH IS PURE ASCII ON PURPOSE: an earlier draft used `src/café.mjs`, which an
// NFD-normalising filesystem re-spells on disk, so the arm could red for a unicode reason
// having nothing to do with the separator this pin is about. One variable per pin.
// SABOTAGE: compare declared paths against the staged set without normalizing -> the
// backslash spelling misses, the receipt is withheld, the staged path is uncovered and the
// run refuses [coverage_incomplete] -> every assertion reds.
test('R1-D17: a backslash-spelled declared path normalizes and MATCHES the staged path — separator spelling never withholds a stamp', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/nested/lane.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blob = indexBlob(dir, 'src/nested/lane.mjs');
    const id = '17000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src\\nested\\lane.mjs'], blobs: { 'src\\nested\\lane.mjs': blob }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'D17 normalized match']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'the backslash path matched and was stamped');
    assert.equal(entryById(dir, id).status, 'consumed');
  } finally { cleanup(); }
});

// EXPECTED: RED today — today the two withholdings are separated only by two prose channels
// (foreign_receipts / deferred_receipts); neither code exists.
// SABOTAGE: merge the two disclosure channels into one code -> whichever assertion names the
// other code reds. They carry DIFFERENT remedies: a foreign receipt needs a review in THIS
// session, a non-overlapping one needs the commit that stages its own territory.
test('R1-D18: a FOREIGN receipt and a NON-OVERLAPPING receipt are disclosed under DIFFERENT codes (receipt_foreign vs receipt_no_overlap) and both stay ACTIVE', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneB.mjs');
    git(dir, ['commit', '-m', 'seed lane B']);
    const laneBBlob = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const blobA = indexBlob(dir, 'src/laneA.mjs');
    const idOk = '18000000-0000-4000-8000-000000000001';
    const idForeign = '18000000-0000-4000-8000-000000000002';
    const idNoOverlap = '18000000-0000-4000-8000-000000000003';
    writeLedger(dir, [
      v2({ entry_id: idOk, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blobA }, base_sha: base }),
      v2({ entry_id: idForeign, agent_type: 'reviewer-foreign', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blobA }, base_sha: base, session_id: 'some-other-session' }),
      v2({ entry_id: idNoOverlap, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlob }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D18 foreign vs non-overlapping', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'neither withheld receipt is stamped');
    const out = soleJson(r);
    assert.ok(hasDisclosure(out, 'receipt_foreign', idForeign), `got ${JSON.stringify(out.disclosures)}`);
    assert.ok(!hasDisclosure(out, 'receipt_no_overlap', idForeign), 'the foreign one is NOT reported as a non-overlap — different cause, different remedy');
    assert.ok(hasDisclosure(out, 'receipt_no_overlap', idNoOverlap), `got ${JSON.stringify(out.disclosures)}`);
    assert.ok(!hasDisclosure(out, 'receipt_foreign', idNoOverlap), 'and the non-overlapping one is not reported as foreign');
    for (const id of [idForeign, idNoOverlap]) assert.equal(entryById(dir, id).status, 'active', `${id} stays active`);
  } finally { cleanup(); }
});

// IDENTITY PARTITIONING, re-cut onto entry_id keying. THE ORDERING IS LOAD-BEARING: the
// WITHHELD receipt is written FIRST on purpose, because a consume keyed on fields that cannot
// tell the two apart happens to remove the right entry when the stamped one is first.
// EXPECTED: RED today — today's consume key is a multiset over (agent_type, at, identity),
// which these two receipts share entirely, so the FIRST match is spliced out and the WRONG
// receipt's evidence is destroyed.
// SABOTAGE: key the reservation/consumption on anything but entry_id (agent_type + finished_at
// + identity) -> the surviving entry is lane A's rather than lane B's -> the deepEqual reds.
test('R1-D19: two receipts identical in agent_type, timestamps and identity — differing only in entry_id and territory — consume the COVERING one and leave the other byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneB.mjs');
    git(dir, ['commit', '-m', 'seed lane B']);
    const laneBBlob = git(dir, ['rev-parse', 'HEAD:src/laneB.mjs']);
    stageChange(dir, 'src/laneA.mjs');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const collidingAt = isoAgo(1_000);
    const idB = '19000000-0000-4000-8000-000000000001';
    const idA = '19000000-0000-4000-8000-000000000002';
    const withheld = v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': laneBBlob }, base_sha: base, at: collidingAt });
    const covering = v2({ entry_id: idA, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': indexBlob(dir, 'src/laneA.mjs') }, base_sha: base, at: collidingAt });
    writeLedger(dir, [withheld, covering]); // WITHHELD FIRST — see the header note

    const r = runCommitReviewed(dir, ['-m', 'D19 colliding identities']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(receiptTrailers(dir), [idA], 'exactly the covering receipt is bound to the commit');
    assert.deepEqual(entryById(dir, idB), withheld, 'the withheld receipt survives BYTE-IDENTICAL — a key that cannot tell them apart destroys the wrong one');
    assert.equal(entryById(dir, idA).status, 'consumed', 'and the covering one is the one consumed');
  } finally { cleanup(); }
});
