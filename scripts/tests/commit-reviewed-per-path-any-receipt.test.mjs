// COMMIT-REVIEWED — THE BYTE RULE IS A PER-PATH *ANY-RECEIPT* JOIN (frozen pins).
//
// AUTHORITY (governing): decision
// `commit-reviewed-byte-rule-is-existential-per-path-spent-receipts-record-assigned-paths`
// (knowledge_get dae6cf46) — its statement supersedes the earlier dispatch brief wherever the
// two differ. Cites decision
// `review-receipt-rebuild-invariant-three-owner-modules-tri-state-liveness-receipt-bound-supersession`
// (knowledge_get 24dc4c63), contract sheet §3.2 step 2 / §6 A3, A8, A9, A13. Reported by board
// item 8590a004 (HIGH, consumer-measured 2026-09-08 on clone 0.14.1 @ HEAD 3540340).
//
// THE RULING PINNED HERE:
//   * EXISTENTIAL PER PATH — for each staged code path, matched_by = the eligible selected
//     scoped receipts whose effective evidence for that path equals the comparison blob (sha
//     equal, or 'absent' for a deletion); the path is SATISFIED when matched_by is non-empty;
//   * a MISMATCH is recorded only when matched_by is EMPTY, at most one aggregate per path,
//     carrying the index blob and every disagreeing {entry_id, receipt_blob};
//   * THE SPENT SET = (a) every scoped receipt contributing at least one matched path, PLUS
//     (b) under --waive-bytes, EVERY scoped receipt whose evidence mismatched on a globally
//     unmatched path — waiver contributors are RESERVED, STAMPED AND CONSUMED like any other
//     spend (an unbound waiver, i.e. a Review-Bytes-Waiver id that was never stamped, is the
//     defect Codex surfaced against the first spec) — PLUS (c) unscoped receipts as today;
//   * Review-Bytes-Waiver ids are a SUBSET of the Review-Receipt ids;
//   * a scoped candidate in neither (a) nor (b) is NOT reserved, stamped or consumed: it stays
//     ACTIVE and is disclosed once as [receipt_not_spent_stale_bytes] {entry_id, paths};
//   * ASSIGNED PATHS PERSIST — for each spent scoped receipt, assigned = matched ∪ waived paths
//     for this commit; the consumption record persists them as `paths`, and commit
//     verification, the --target-sha rebind, direct-merge's receipt binding check and the
//     superseded discharge verifier all check EXACTLY those, never every covered path. A LEGACY
//     consumption record with no `paths` keeps today's all-covered-paths interpretation;
//   * coverage_incomplete is UNCHANGED — the union of usable evidence over all eligible
//     overlapping receipts, not over contributing ones;
//   * every downstream artifact (trailers, age disclosures, multi_spend, the success JSON)
//     derives from the SPENT SET, never from the candidate selection.
//
// THE MEASURED DEFECT these pins freeze: `computeByteRule` iterates (receipt, path) pairs and
// records a mismatch for every pair whose blob differs, so a fix-after-review slice — the
// original roster receipt carrying the PRE-FIX blob plus a later delta receipt carrying the
// staged blob, both active — refuses [receipt_bytes_mismatch] although a receipt attesting the
// exact staged bytes exists. The only route through was --waive-bytes on a fully reviewed diff,
// and the waiver was then attributed to all six spent receipts INCLUDING the matching delta
// receipt, so the ledger overstated what had been waived.
//
// SPEC-ONLY / NO SHELL: this file was authored blind to the fix (H4 read wall) and the author
// holds no Bash, so no arm below has been executed. Each test states its EXPECTED colour today
// and the ONE-LINE SABOTAGE that must turn it red; the conductor runs the red gate.
//
// FIXTURE PROVENANCE: helpers (makeRepo / writeLedger / stageChange / indexBlob / hashBytes /
// runCommitReviewed / trailerValues / soleJson / v2) are COPIED from
// scripts/tests/commit-reviewed-bytes-refuse.test.mjs and
// scripts/tests/commit-reviewed-two-phase-spend.test.mjs; the merge-gate harness
// (makeReceiptGateRepo / runDirectMerge / consumedReceipt / escapeRegex) is COPIED from
// scripts/tests/direct-merge-trailer-pattern.test.mjs, and the multi_spend threshold (>3) and
// its `facts.count` shape are read from the FROZEN PINS in
// scripts/tests/commit-reviewed-spend-warnings.test.mjs R1-D20/R1-D21 rather than from the
// implementation constant — nothing private is imported.
// Per anti-pattern: raw child stderr/stdout is never interpolated into an assertion message
// un-flattened; `flat()` collapses it to one line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_PATH = join(root, 'scripts', 'commit-reviewed.mjs');

const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');

const token = (c) => new RegExp('\\[' + c + '\\]');
const ANY_CODE_TOKEN = /\[[a-z0-9_]+\]/;
const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// THE PROBE, AND WHY IT IS SPELLED THIS WAY. A silently-skipped arm is worse than a failing
// one: it reads as a pass. So the probe (a) runs `git --version` through the SAME spawn shape
// and the SAME env the fixtures use — `env: process.env`, which is what `git()` below inherits
// and what runCommitReviewed merges its session vars into — so it cannot answer for a
// different git than the tests would get, and (b) carries its own diagnosis in the skip
// reason, so a skipped run says WHY rather than "not available".
const GIT_PROBE = spawnSync('git', ['--version'], { encoding: 'utf8', env: process.env, timeout: 30_000 });
const GIT_OK = !GIT_PROBE.error && GIT_PROBE.status === 0;
const GIT_SKIP = GIT_OK
  ? false
  : `git probe FAILED, so every arm needing a repo is skipped — spawn('git', ['--version'], { env: process.env }) returned status=${GIT_PROBE.status} signal=${GIT_PROBE.signal} error=${flat(GIT_PROBE.error?.message)} stderr=${flat(GIT_PROBE.stderr)}`;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${flat(r.stderr)}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-per-path-'));
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

function indexBlob(dir, relPath) {
  const out = git(dir, ['ls-files', '-s', '--', relPath]);
  const m = out.match(/^\d+ ([0-9a-f]{40}) \d+\t/);
  assert.ok(m, `fixture guard: ${relPath} must be staged in the index — got ${flat(out)}`);
  return m[1];
}

function hashBytes(dir, content) {
  const r = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: content, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git hash-object --stdin: ${flat(r.stderr)}`);
  const sha = (r.stdout ?? '').trim();
  assert.match(sha, /^[0-9a-f]{40}$/, `fixture guard: a usable 40-hex sha, got ${flat(sha)}`);
  return sha;
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
// The `discharge` concurrency token: the sha256 of the EXACT ledger bytes (review-ledger-cli).
const ledgerDigest = (dir) => createHash('sha256').update(readFileSync(ledgerPath(dir))).digest('hex');

function installHook(dir, name, script) {
  const p = join(dir, '.git', 'hooks', name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
}
// Permission injection is meaningless as root and unavailable on win32 (copied verbatim from
// commit-reviewed-two-phase-spend.test.mjs, whose PERM_SKIP guards the same class of arm).
const PERM_SKIP = GIT_SKIP
  || (process.platform === 'win32' ? 'directory-permission injection is not available on win32' : false)
  || ((typeof process.getuid === 'function' && process.getuid() === 0) ? 'running as root: a read-only directory does not deny writes' : false);

// The amend-mode seam (P15 only), copied from commit-reviewed-target-sha.test.mjs: amend mode
// reads the registered toolchain globs from .sterling/config.json, and the env var is the
// suite's no-upstream allowance.
const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};
const seedConfig = (dir) => writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
const SEAM_ON = { ...ENV_SESSION, STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM: '1' };

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

const disclosure = (out, code) => (out.disclosures ?? []).filter((d) => d && d.code === code);
const hasDisclosureNaming = (out, code, id) => disclosure(out, code).some((d) => JSON.stringify(d).includes(id));
const bothChannels = (r) => `${r.stdout}\n${r.stderr}`;

function v2({
  entry_id, agent_type, files, blobs = {}, base_sha, status = 'active',
  source = 'review-territory', evidence_status = 'complete', basis = 'stop-time-worktree-snapshot',
  at = isoAgo(60_000), session_id = SESSION, branch = 'main', absent_paths = [],
}) {
  const content_evidence = { basis, status: evidence_status, blobs, absent_paths, truncated_of: null, failure_reason: null };
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

// A receipt that was NOT spent must come out of the run untouched in every field that carries
// liveness. This is deliberately field-precise rather than a whole-object deepEqual: the ruling
// says the receipt "stays ACTIVE and is disclosed", and a whole-object compare would also forbid
// benign annotation the ruling never spoke about. These four are the ones with teeth — a
// reservation, a consumption or a disposition each means the receipt was spent or retired.
function assertUnspent(dir, id, label) {
  const e = entryById(dir, id);
  assert.ok(e, `[${label}] the un-spent receipt is still PRESENT in the ledger`);
  assert.equal(e.status, 'active', `[${label}] a scoped receipt contributing no matching path stays ACTIVE — got ${JSON.stringify(e.status)}`);
  assert.equal(e.reservation, undefined, `[${label}] with no reservation left behind — got ${JSON.stringify(e.reservation)}`);
  assert.equal(e.consumption, undefined, `[${label}] and nothing consumed against it — got ${JSON.stringify(e.consumption)}`);
  assert.equal(e.disposition, null, `[${label}] and it is NOT discharged either — the ruling keeps it spendable by its own slice — got ${JSON.stringify(e.disposition)}`);
}

function assertConsumed(dir, id, head, label) {
  const e = entryById(dir, id);
  assert.ok(e, `[${label}] ${id} is still present`);
  assert.equal(e.status, 'consumed', `[${label}] ${id} consumed — got ${JSON.stringify(e.status)}`);
  assert.equal(e.consumption?.commit_sha, head, `[${label}] ${id} bound to THIS commit — got ${JSON.stringify(e.consumption)}`);
}

const P = 'src/laneP.mjs';   // the shared path both receipts cover
const Q = 'src/laneQ.mjs';   // the second path, used by the mixed arm
const R = 'src/laneR.mjs';   // the path NO receipt covers, used by the coverage control

const OLD1 = 'export const f = 1; // the bytes the ORIGINAL reviewer read\n';
const OLD2 = 'export const f = 2; // the bytes a SECOND stale reviewer read\n';
const NEW = 'export const f = 3; // the bytes actually staged\n';
const Q_OLD = 'export const g = 1; // lane Q before the fix\n';
const Q_NEW = 'export const g = 2; // lane Q as staged\n';

// Fixture builder shared by P2, P5, P7 and (with two stale blobs) P3/P4/P8. Returns the repo,
// the ids, and the blobs, so each arm differs from its neighbours in exactly one property.
function twoReceiptsOnOnePath({ staleBlobFor, matchingBlobFor, extraStaged = [] }) {
  const { dir, cleanup } = makeRepo();
  const stale = hashBytes(dir, staleBlobFor);
  stageChange(dir, P, NEW);
  for (const [path, content] of extraStaged) stageChange(dir, path, content);
  const staged = indexBlob(dir, P);
  assert.notEqual(stale, staged, 'fixture guard: receipt A genuinely attests bytes that are NOT what is staged');
  const base = git(dir, ['rev-parse', 'HEAD']);
  const idA = 'aa000000-0000-4000-8000-0000000000a1';
  const idB = 'bb000000-0000-4000-8000-0000000000b1';
  // A is the ORIGINAL roster receipt (older); B is the later delta receipt — the exact shape
  // the consumer measured.
  const blobB = matchingBlobFor === 'index' ? staged : hashBytes(dir, matchingBlobFor);
  const receiptA = v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: stale }, base_sha: base, at: isoAgo(600_000) });
  const receiptB = v2({ entry_id: idB, agent_type: 'reviewer-delta', files: [P], blobs: { [P]: blobB }, base_sha: base, at: isoAgo(60_000) });
  writeLedger(dir, [receiptA, receiptB]);
  return { dir, cleanup, idA, idB, staged, staleA: stale, blobB, base };
}

// ===========================================================================
// P0 — THE SKIP GUARD, AND THE ONLY TEST IN THIS FILE THAT NEVER SKIPS.
// A conditional skip is invisible: every pin below can report "pass" on a host
// where the probe misfired, and a suite that skips itself is indistinguishable
// from a suite that holds. This arm closes that by asserting the probe against
// what the fixtures can ACTUALLY do — it initialises a real throwaway repo — so a
// probe that says "no git" on a host with git, or that answers for a different git
// than the fixtures get, fails loudly instead of silently disarming twelve pins.
// ===========================================================================

// EXPECTED TODAY: GREEN on any host with git; on a genuinely git-less host it is still GREEN
// and PRINTS the diagnosis (the second arm), which is the behaviour the reviewers asked for.
// SABOTAGE (the misfire this exists for): tighten the probe (require a minimum version, add an
// env var the fixtures do not pass, drop `env: process.env` so a PATH-scoped git disappears)
// while git still works -> `git init` succeeds here and GIT_SKIP is truthy, so the
// mutual-consistency assertion reds. Nothing else in this file can see that: every other arm
// would simply skip.
// SABOTAGE (the reason half): return a bare 'git not available on this host' -> the
// diagnosis assertions red; a skip reason that does not name status/stderr cannot be
// distinguished from a mis-scoped probe by whoever reads the run.
test('PER-PATH P0 (SKIP GUARD, never skipped): the git probe agrees with what the fixtures can do — if a real `git init` works then GIT_SKIP is false, and when it is set the reason names status/error/stderr', () => {
  let realGitWorks = false;
  let dir = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'sterling-per-path-probe-'));
    const r = spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8', env: process.env, timeout: 30_000 });
    realGitWorks = !r.error && r.status === 0;
  } catch {
    realGitWorks = false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  if (realGitWorks) {
    assert.equal(GIT_SKIP, false,
      `git WORKS on this host but the probe disarmed the suite — a silent skip reads as a pass, which is how twelve pins go quiet at once. probe: ${String(GIT_SKIP)}`);
    assert.equal(GIT_OK, true, 'and the probe flag agrees');
  } else {
    assert.ok(typeof GIT_SKIP === 'string' && GIT_SKIP.length > 0, 'a git-less host must SKIP with a stated reason, never silently');
    for (const marker of ['status=', 'stderr=']) {
      assert.ok(GIT_SKIP.includes(marker), `the skip reason carries its own diagnosis (${marker}) — reason=${flat(GIT_SKIP)}`);
    }
  }

  // The store-dist gate is the file's OTHER conditional skip, and it gets the same treatment:
  // if the dist is present, only a git failure may disarm the merge-gate arms.
  if (existsSync(STORE_DIST)) {
    assert.equal(STORE_SKIP, GIT_SKIP,
      `with packages/store/dist present, the merge-gate arms may only be skipped for the git reason — got ${String(STORE_SKIP)}`);
  } else {
    assert.ok(typeof STORE_SKIP === 'string' && STORE_SKIP.includes('dist'),
      `an unbuilt store must skip with a reason naming the build — got ${String(STORE_SKIP)}`);
  }
});

// ===========================================================================
// P1 — THE CONTROL, PLACED FIRST. Every arm below is this fixture plus one more
// receipt; without it a green "the run commits" anywhere else could be explained
// by "this mode commits whatever it is given", and a green refusal in P3 could be
// explained by "this mode refuses everything".
// ===========================================================================

// EXPECTED TODAY: GREEN. One receipt whose evidence equals the index blob is exactly today's
// happy path, and it must stay green through the fix — a per-path ANY-receipt join with one
// receipt in the set degenerates to today's rule.
// SABOTAGE: invert the per-path comparison (satisfy the path when the receipt blob DIFFERS from
// the index blob) -> exit 1 and every assertion below reds.
// WHICH GUARD CARRIES THE VERDICT: the blob equality itself. This arm intentionally has no
// second layer — that is what makes it usable as the control for the rest of the file.
test('PER-PATH P1 (CONTROL, first): a single receipt whose evidence equals the index blob commits — Review-Receipt names it, Reviewed-By-Agent names its type, status consumed, no mismatch and no waiver', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, P, NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = 'cc000000-0000-4000-8000-0000000000c1';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: indexBlob(dir, P) }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'P1 control: one matching receipt', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'the commit was created');
    assert.deepEqual(receiptTrailers(dir), [id], 'one Review-Receipt trailer, valued by entry_id');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'beside one Reviewed-By-Agent trailer');
    assert.deepEqual(waiverTrailers(dir), [], 'nothing was waived, so no waiver trailer');
    assert.doesNotMatch(bothChannels(r), token('receipt_bytes_mismatch'), `no byte refusal — stderr=${flat(r.stderr)}`);
    assertConsumed(dir, id, head, 'control');
  } finally { cleanup(); }
});

// ===========================================================================
// P2 — THE DEFECT ITSELF. Receipt A (the original roster review) attests the
// PRE-FIX blob for P; receipt B (the later delta review) attests the STAGED blob.
// The path is therefore attested by a receipt that read exactly these bytes, and
// the commit must land with B spent and A left alone.
// ===========================================================================

// EXPECTED TODAY: RED. Today's (receipt, path) loop records a mismatch for A and the run
// refuses [receipt_bytes_mismatch] — the very refusal the consumer measured. The first failing
// assertion is `assert.equal(r.code, 0, ...)`; with that removed the next would be the absent
// [receipt_bytes_mismatch] check, then the trailer deepEqual (today no commit exists at all, so
// receiptTrailers reads the base commit's empty trailer set).
// SABOTAGE (the regression to today): restore the per-(receipt, path) mismatch loop — record a
// mismatch for every selected receipt whose blob for a covered path differs — and exit 0 becomes
// exit 1: `r.code`, the token check and every trailer/status assertion red together.
// SECOND SABOTAGE (the narrowing half, invisible to the first): keep the per-path join but
// reserve/stamp EVERY selected receipt instead of only the contributors -> `receiptTrailers`
// reads [idA, idB], `assertUnspent` reds on A's status, and the exit code stays 0. The two
// halves of the ruling need both sabotages: "no refusal" and "A is not spent" are different
// guards, and the second is the one that keeps the ledger honest about who attested what.
test('PER-PATH P2 (THE DEFECT): with one stale and one matching receipt on the SAME staged path the commit lands — no [receipt_bytes_mismatch], no [bytes_waived], the trailer names the MATCHING receipt only, and the stale receipt stays ACTIVE disclosed [receipt_not_spent_stale_bytes]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, idA, idB } = twoReceiptsOnOnePath({ staleBlobFor: OLD1, matchingBlobFor: 'index' });
  try {
    const base = git(dir, ['rev-parse', 'HEAD']);
    const r = runCommitReviewed(dir, ['-m', 'P2 stale roster receipt beside a matching delta receipt', '--json']);
    assert.equal(r.code, 0, `a path attested by SOME selected receipt is satisfied — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'the commit was created');

    assert.doesNotMatch(bothChannels(r), token('receipt_bytes_mismatch'), `a mismatch is recorded only for a path NO receipt matches — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(bothChannels(r), token('bytes_waived'), `and nothing needed waiving, so no waiver is disclosed — stderr=${flat(r.stderr)}`);
    assert.deepEqual(waiverTrailers(dir), [], 'nor stamped');

    assert.deepEqual(receiptTrailers(dir), [idB], 'ONLY the contributing receipt is bound to this commit');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-delta'], 'and only its reviewer is credited');
    assertConsumed(dir, idB, head, 'P2');
    assertUnspent(dir, idA, 'P2');

    const out = soleJson(r);
    assert.ok(hasDisclosureNaming(out, 'receipt_not_spent_stale_bytes', idA),
      `the withholding is DISCLOSED and names the receipt that was not spent — got ${JSON.stringify(out.disclosures)}`);
  } finally { cleanup(); }
});

// ===========================================================================
// P3 — THE OTHER SIDE OF THE JOIN. Both receipts are stale for P (different stale
// blobs), so NO receipt matches and the refusal is unchanged. Without this arm,
// P2's green is satisfied by "never refuse on bytes at all".
// ===========================================================================

// EXPECTED TODAY: MIXED, and the mix is the point. From the shape the frozen suites pin
// (commit-reviewed-bytes-refuse.test.mjs R1-D31/R1-D32/R1-D124b assert
// facts.mismatches === [{path, receipt_blob, index_blob}] exactly), today:
//   * exit 1 — GREEN today;
//   * code 'receipt_bytes_mismatch' — GREEN today;
//   * mismatches[0].path === P — GREEN today;
//   * mismatches.length === 1 — RED today: today's per-(receipt, path) loop emits TWO entries,
//     both with path P (that duplication is the defect's fingerprint);
//   * the refusal names BOTH entry ids — RED today: today's mismatch entry carries no entry_id
//     at all, and R1-D31's deepEqual proves the triple is the whole object.
// SABOTAGE (the false-satisfaction shape): satisfy a path when ANY receipt merely COVERS it
// (declared + blob present) rather than when its blob EQUALS the index blob -> exit 0, the run
// commits on evidence nobody holds, and every assertion here reds.
// SECOND SABOTAGE (aggregation): emit one mismatch per (receipt, path) pair -> the length
// assertion reds while exit code, code and path stay green. That is exactly today's shape, so
// this pin is the one that detects a half-applied fix.
test('PER-PATH P3: when EVERY selected receipt is stale for the staged path the refusal is unchanged — [receipt_bytes_mismatch], exactly ONE mismatch entry for that path, naming BOTH receipts, no commit, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, idA, idB, staged } = twoReceiptsOnOnePath({ staleBlobFor: OLD1, matchingBlobFor: OLD2 });
  try {
    const base = git(dir, ['rev-parse', 'HEAD']);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'P3 both receipts stale', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'receipt_bytes_mismatch', `got ${JSON.stringify(out)}`);

    const mismatches = out.facts?.mismatches ?? [];
    assert.equal(mismatches.length, 1, `ONE mismatch per unmatched PATH, not one per (receipt, path) pair — got ${JSON.stringify(out.facts)}`);
    assert.equal(mismatches[0]?.path, P, `got ${JSON.stringify(out.facts)}`);
    assert.equal(mismatches[0]?.index_blob, staged, `reported against the INDEX blob being committed — got ${JSON.stringify(out.facts)}`);

    const shown = JSON.stringify(out);
    assert.ok(shown.includes(idA) && shown.includes(idB),
      `the refusal names BOTH stale receipts — an operator cannot adjudicate "nobody attests these bytes" without knowing who was asked — got ${shown}`);

    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'nothing reserved and nothing consumed — ledger byte-identical');
  } finally { cleanup(); }
});

// ===========================================================================
// P4 — THE WAIVER ON A GENUINELY UNMATCHED PATH. P3's fixture plus --waive-bytes:
// the operator overrides, both stale receipts are spent for the path nobody
// matched, and BOTH are named as waived.
//
// WAIVER CONTRIBUTORS ARE *SPENT*, not merely named (decision dae6cf46, spent set
// clause (b), adopted over a minimal deterministic contributor): every stale
// receipt on a globally unmatched path is reserved, stamped AND consumed. The
// rejected first spec — record bytes_waived against receipts that were never
// stamped — mints an UNBOUND WAIVER: a Review-Bytes-Waiver id with no matching
// Review-Receipt id, which direct-merge's additive binding rule then cannot
// resolve (see P9 for the subset relation and P10b for the gate's side of it).
// ===========================================================================

// EXPECTED TODAY: RED on the disclosure's entry_ids field. Today's [bytes_waived] disclosure is
// pinned only by code (commit-reviewed-bytes-refuse.test.mjs R1-D37 asserts
// `d.code === 'bytes_waived'` and nothing else), so `entry_ids` is an ADDED field the dispatch
// contract names ("bytes_waived.entry_ids contains A and B"); the exit code, the commit, the
// waiver trailers and both consumptions are plausibly green today (today's waivedIds sweeps in
// every selected receipt whose overlap includes a mismatched path — which here is both, for the
// right reason).
// SABOTAGE: name only the FIRST stale receipt in the waiver (bytes_waived / the trailer set) ->
// the two-element assertions red while the exit code stays 0. A waiver that under-reports whose
// evidence was overridden is not an accountable override.
// SECOND SABOTAGE: let the waiver suppress the disclosure and stamp nothing -> the `waived`
// existence assertion and the trailer deepEqual red together; --waive-bytes is never silent.
test('PER-PATH P4: --waive-bytes over P3\'s ledger commits — [bytes_waived] names BOTH stale receipts in entry_ids, one Review-Bytes-Waiver trailer each, and both are consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, idA, idB } = twoReceiptsOnOnePath({ staleBlobFor: OLD1, matchingBlobFor: OLD2 });
  try {
    const base = git(dir, ['rev-parse', 'HEAD']);
    const r = runCommitReviewed(dir, ['-m', 'P4 waived: nobody attests these bytes', '--waive-bytes', 'operator re-read the changed lines by hand', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'the waived commit was created');

    const out = soleJson(r);
    const waived = disclosure(out, 'bytes_waived')[0];
    assert.ok(waived, `the waiver is DISCLOSED, never silent — got ${JSON.stringify(out.disclosures)}`);
    assert.deepEqual([...(waived.entry_ids ?? [])].sort(), [idA, idB].sort(),
      `bytes_waived names exactly the receipts SPENT for a path nobody matched — got ${JSON.stringify(waived)}`);

    assert.deepEqual(waiverTrailers(dir).sort(), [idA, idB].sort(), 'one Review-Bytes-Waiver trailer per waived receipt, valued by entry_id');
    assert.deepEqual(receiptTrailers(dir).sort(), [idA, idB].sort(),
      'and each waived receipt is ALSO stamped as spent — a waiver id with no Review-Receipt id beside it is an unbound waiver the merge gate cannot resolve');
    assertConsumed(dir, idA, head, 'P4');
    assertConsumed(dir, idB, head, 'P4');
    for (const id of [idA, idB]) {
      assert.deepEqual(entryById(dir, id).consumption?.paths, [P],
        `a waiver contributor's ASSIGNED paths are the paths it was waived for — got ${JSON.stringify(entryById(dir, id).consumption)}`);
    }
  } finally { cleanup(); }
});

// ===========================================================================
// P5 — THE WAIVER'S CONTROL, AND THE LEDGER-OVERSTATEMENT PIN. P2's fixture with
// --waive-bytes: nothing needed waiving, so nothing may be reported as waived. This
// is the arm that catches the consumer's second finding — [bytes_waived] recorded
// against six spent receipts including the one that matched.
// ===========================================================================

// EXPECTED TODAY: RED. Today the path counts as mismatched (because A is stale), so the run
// either refuses without the flag or, with it, waives and consumes BOTH receipts: the
// `waiverTrailers` deepEqual([]) and `assertUnspent(A)` both fire. The exit code is plausibly
// green today.
// SABOTAGE (precisely today's waivedIds): compute the waived set from the per-(receipt, path)
// mismatch list instead of from the set of paths NO receipt matched -> [bytes_waived] appears
// naming A and B, A is consumed, and the assertions red while the commit still lands. Nothing
// else in this file can see that: P4 wants both receipts waived and would stay green.
test('PER-PATH P5 (CONTROL for P4): --waive-bytes over P2\'s ledger commits with NO [bytes_waived] at all, zero waiver trailers, and the stale receipt still un-spent — a waiver is never attributed to a path some receipt attested', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, idA, idB } = twoReceiptsOnOnePath({ staleBlobFor: OLD1, matchingBlobFor: 'index' });
  try {
    const base = git(dir, ['rev-parse', 'HEAD']);
    const r = runCommitReviewed(dir, ['-m', 'P5 waiver flag with nothing to waive', '--waive-bytes', 'belt and braces', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'the commit was created');

    const out = soleJson(r);
    assert.deepEqual(disclosure(out, 'bytes_waived'), [],
      `nothing needed waiving, so the ledger must not claim anything was — got ${JSON.stringify(out.disclosures)}`);
    assert.deepEqual(waiverTrailers(dir), [], 'and not one Review-Bytes-Waiver trailer is stamped');
    assert.deepEqual(receiptTrailers(dir), [idB], 'the waiver flag does not widen the spent set');
    assertConsumed(dir, idB, head, 'P5');
    assertUnspent(dir, idA, 'P5');
  } finally { cleanup(); }
});

// ===========================================================================
// P6 — MIXED CONTRIBUTION. Receipt A attests P (matching) and Q (stale); receipt B
// attests Q (matching). Every path is attested by SOMEBODY, so both receipts
// contributed at least one matching path and both are spent.
//
// ORDERING IS LOAD-BEARING HERE, deliberately: A is the NEWER receipt and is the
// stale one for Q, while the OLDER B is the one that attests Q's staged bytes. So a
// "newest covering receipt wins per path" implementation — a plausible and wrong
// reading of the ruling — gives the opposite verdict on Q and refuses. P2 cannot
// see that, because there the newest receipt is also the matching one.
// ===========================================================================

// EXPECTED TODAY: RED. Today A's stale blob for Q records a mismatch and the run refuses:
// `r.code` fires first, then the trailer deepEqual.
// SABOTAGE (the "every path" narrowing): spend only receipts ALL of whose covered staged paths
// match, instead of those contributing AT LEAST ONE matching path -> A is not spent, the
// trailer deepEqual and `assertConsumed(A)` red while the exit code may stay 0 (Q still
// attested by B) — a commit that credits only half the review that produced it.
// SABOTAGE (newest-wins): resolve each path against the NEWEST covering receipt rather than any
// -> Q is judged by the newer stale A, a mismatch is recorded, exit 1, everything reds.
test('PER-PATH P6 (MIXED): receipt A attests path P and is stale for Q while the OLDER receipt B attests Q — both paths are attested, both receipts are spent, no mismatch and no waiver', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const qStale = hashBytes(dir, Q_OLD);
    stageChange(dir, P, NEW);
    stageChange(dir, Q, Q_NEW);
    const pStaged = indexBlob(dir, P);
    const qStaged = indexBlob(dir, Q);
    assert.notEqual(qStale, qStaged, 'fixture guard: A genuinely attests stale bytes for Q');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = 'aa000000-0000-4000-8000-0000000000a6';
    const idB = 'bb000000-0000-4000-8000-0000000000b6';
    writeLedger(dir, [
      // A is the NEWER receipt, and the stale one for Q.
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: [P, Q], blobs: { [P]: pStaged, [Q]: qStale }, base_sha: base, at: isoAgo(30_000) }),
      // B is the OLDER receipt, and the one that attests Q's staged bytes.
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: [Q], blobs: { [Q]: qStaged }, base_sha: base, at: isoAgo(600_000) }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'P6 mixed contribution across two paths', '--json']);
    assert.equal(r.code, 0, `every staged path is attested by some selected receipt — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'the commit was created');

    assert.doesNotMatch(bothChannels(r), token('receipt_bytes_mismatch'), `stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(bothChannels(r), token('bytes_waived'), `and nothing was waived — stderr=${flat(r.stderr)}`);
    assert.deepEqual(waiverTrailers(dir), [], 'no waiver trailer');

    assert.deepEqual(receiptTrailers(dir).sort(), [idA, idB].sort(), 'BOTH receipts contributed a matching path, so both are bound to this commit');
    assert.deepEqual(reviewedByTrailers(dir).sort(), ['reviewer-correctness', 'reviewer-security'], 'and both reviewers are credited');
    assertConsumed(dir, idA, head, 'P6');
    assertConsumed(dir, idB, head, 'P6');

    const out = soleJson(r);
    assert.ok(!hasDisclosureNaming(out, 'receipt_not_spent_stale_bytes', idA),
      `a receipt that DID contribute a matching path is never reported as un-spent — got ${JSON.stringify(out.disclosures)}`);
  } finally { cleanup(); }
});

// ===========================================================================
// P7 — COVERAGE IS UNCHANGED, AND IS A DIFFERENT VERDICT FROM THE BYTE RULE. P2's
// fixture plus a staged code path R that NO receipt declares. The byte rule is
// satisfied for P (B attests it), and the run must still refuse — on coverage.
// This is the control against reading the new join as "no receipt mismatched, so
// we are fine": an uncovered path has no receipts at all, which makes "no receipt
// recorded a mismatch for R" trivially and dangerously true.
// ===========================================================================

// EXPECTED TODAY: the exit code and `facts.uncovered` are plausibly GREEN (R1-D34 pins that
// shape today), but `out.code` is UNDETERMINED-TO-RED: today A is also stale for P, so a byte
// mismatch exists too and whichever verdict today's CLI evaluates first wins. I cannot read the
// implementation to settle the ordering (H4), so this arm is reported as red-or-green on the
// `code` assertion and the conductor's red run decides; either way it is the pin that keeps the
// two verdicts distinct after the fix, when only the coverage hole remains.
// SABOTAGE: derive coverage from the paths some receipt MATCHED (or skip the coverage verdict
// once the byte rule passes) -> R is swallowed, the run commits, and the exit-code/code/
// uncovered assertions red together. The remedies differ — a mismatch is waivable with
// --waive-bytes, a coverage hole needs a fresh review round — so collapsing them would let
// --waive-bytes launder an unreviewed file into a reviewed commit.
// SECOND SABOTAGE: compute the covered union over CONTRIBUTING receipts only (the fix's
// narrowing, wrongly applied to coverage) -> unchanged here by construction, which is why the
// mixed arm P6 (where A's contribution is what covers P) is its partner rather than its
// duplicate.
test('PER-PATH P7 (COVERAGE CONTROL): a staged code path no receipt declares still refuses [coverage_incomplete] with facts.uncovered, even though every other path is attested — coverage is the union over SELECTED receipts, not a byte verdict', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = twoReceiptsOnOnePath({ staleBlobFor: OLD1, matchingBlobFor: 'index', extraStaged: [[R, 'export const unreviewed = true;\n']] });
  try {
    const base = git(dir, ['rev-parse', 'HEAD']);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'P7 an unreviewed staged path', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'coverage_incomplete', `a path NO receipt declares is a coverage hole, never a byte verdict — got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.uncovered, [R], `got ${JSON.stringify(out.facts)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), base, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); }
});

// ===========================================================================
// P8 — THE --json MISMATCH SHAPE. The refusal entry keeps EXACTLY its three
// existing keys and the per-path evidence about who was consulted lands BESIDE it
// in `facts.receipts_by_path`.
//
// PLACEMENT CORRECTED (and this is a finding, not a preference): carrying the
// consulted receipts INSIDE the mismatch entry — the first brief's
// `mismatches[].receipts` — would turn four FROZEN assertions red, because
// commit-reviewed-bytes-refuse.test.mjs R1-D31, R1-D33, R1-D124b and R1-D124c each
// deepEqual `facts.mismatches` against an exact array of {path, receipt_blob,
// index_blob} objects, and deepEqual forbids a fourth key. So the entry shape is
// pinned CLOSED here (Object.keys), which actively protects those four, and the
// new evidence is a sibling field — the placement the later ruling states and
// P16 pins in the single-receipt case.
// ===========================================================================

// EXPECTED TODAY: RED ONLY ON THE NEW FIELD. The legacy triple is what today emits, so the
// Object.keys assertion and the index_blob/receipt_blob assertions pass today;
// `facts.receipts_by_path` is undefined, so the `receipts_by_path` assertions are the first
// (and only) ones that fire. Deliberately phrased so it does NOT re-pin P3's aggregation: it
// selects the first entry FOR PATH P, which exists today (twice) and after the fix (once).
// SABOTAGE: omit `facts.receipts_by_path` -> the presence assertion reds alone.
// SECOND SABOTAGE: populate receipts_by_path[P] with only the receipt whose blob was hoisted
// into the legacy `receipt_blob` -> the two-element deepEqual reds while everything else stays
// green. That is the shape that leaves an operator believing one receipt was consulted when
// two were — the reporting half of the measured defect.
// THIRD SABOTAGE: fill the legacy `receipt_blob` with a placeholder ('multiple', null, '') to
// signal multiplicity -> the membership assertion reds; the legacy key must stay a real 40-hex
// blob from one of the consulted receipts or every frozen deepEqual in the older suite breaks.
// FOURTH SABOTAGE (the frozen-suite guard): add the evidence INSIDE the mismatch entry as
// `receipts` -> the Object.keys assertion reds here AND R1-D31/R1-D33/R1-D124b/R1-D124c red in
// the sibling suite. This arm is the early warning for that, one file away from the four pins
// it protects.
test('PER-PATH P8 (--json shape): a mismatch entry stays EXACTLY {path, receipt_blob, index_blob} — the consulted receipts land in facts.receipts_by_path[path] as [{entry_id, receipt_blob}], never as a fourth key inside the entry', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, idA, idB, staged, staleA, blobB } = twoReceiptsOnOnePath({ staleBlobFor: OLD1, matchingBlobFor: OLD2 });
  try {
    const r = runCommitReviewed(dir, ['-m', 'P8 mismatch reporting shape', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    const m = (out.facts?.mismatches ?? []).find((e) => e && e.path === P);
    assert.ok(m, `a mismatch entry for the unmatched path — got ${JSON.stringify(out.facts)}`);

    // The legacy keys, unchanged AND CLOSED — the older suite deepEquals this exact triple.
    assert.deepEqual(Object.keys(m).sort(), ['index_blob', 'path', 'receipt_blob'],
      `the mismatch entry keeps EXACTLY three keys — a fourth reds four frozen deepEquals in commit-reviewed-bytes-refuse.test.mjs — got ${JSON.stringify(m)}`);
    assert.equal(m.index_blob, staged, `index_blob is the blob being committed — got ${JSON.stringify(m)}`);
    assert.ok([staleA, blobB].includes(m.receipt_blob),
      `receipt_blob stays a REAL blob held by one of the consulted receipts, never a multiplicity placeholder — got ${JSON.stringify(m)}`);

    // The added sibling field.
    const byPath = out.facts?.receipts_by_path;
    assert.ok(byPath && Array.isArray(byPath[P]), `facts.receipts_by_path names the consulted receipts per path — got ${JSON.stringify(out.facts)}`);
    assert.deepEqual(
      byPath[P].map((x) => ({ entry_id: x?.entry_id, receipt_blob: x?.receipt_blob })).sort((x, y) => String(x.entry_id).localeCompare(String(y.entry_id))),
      [{ entry_id: idA, receipt_blob: staleA }, { entry_id: idB, receipt_blob: blobB }].sort((x, y) => x.entry_id.localeCompare(y.entry_id)),
      `every receipt consulted for that path, with the blob it actually held — got ${JSON.stringify(byPath[P])}`);
  } finally { cleanup(); }
});

// ===========================================================================
// P9 — WAIVER IDS ARE A SUBSET OF RECEIPT IDS, PINNED WHERE THE TWO SETS DIFFER.
// P4 pins the two sets EQUAL (both receipts waived), so it cannot see a waiver
// stamped for a receipt that was never spent. Here the sets are deliberately
// UNEQUAL — three spent receipts, two of them waived — which is the only shape
// where "subset" has content: the strict inclusion Waiver ⊂ Receipt, non-empty on
// both sides.
// ===========================================================================

// EXPECTED TODAY: RED. Today path P mismatches for BOTH A and B, so the run refuses without
// the flag and, with it, today's `waivedIds` (every selected receipt overlapping a mismatched
// PATH) sweeps in C as well — C overlaps only Q, so the sweep depends on today's per-(receipt,
// path) mismatch list; the `waiverTrailers` deepEqual is the assertion with teeth here and the
// exit code is plausibly green.
// SABOTAGE (the unbound waiver — the shape Codex rejected): stamp Review-Bytes-Waiver from the
// set of stale receipts while stamping Review-Receipt only for matching contributors -> the
// subset assertion reds naming the unbound ids, and direct-merge would then refuse the commit
// it just produced (its additive rule resolves each waiver id against a bound receipt).
// SABOTAGE (over-attribution — the consumer's measured second defect): include the MATCHING
// receipt C in the waiver set -> the `waiverTrailers` deepEqual and the `entry_ids` deepEqual
// red while the subset assertion stays GREEN, because an over-wide waiver set is still a subset
// of an over-wide receipt set. That pair of results is why both assertions are here: the subset
// relation alone cannot see over-attribution, and the exact sets alone cannot see unboundness.
test('PER-PATH P9: with two stale receipts on an unmatched path and one matching receipt elsewhere, --waive-bytes stamps all three as spent and waives ONLY the two stale ones — Review-Bytes-Waiver ids are a strict, non-empty SUBSET of the Review-Receipt ids', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const staleA = hashBytes(dir, OLD1);
    const staleB = hashBytes(dir, OLD2);
    stageChange(dir, P, NEW);
    stageChange(dir, Q, Q_NEW);
    const qStaged = indexBlob(dir, Q);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = 'aa000000-0000-4000-8000-0000000000a9';
    const idB = 'bb000000-0000-4000-8000-0000000000b9';
    const idC = 'cc000000-0000-4000-8000-0000000000c9';
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: staleA }, base_sha: base }),
      v2({ entry_id: idB, agent_type: 'reviewer-security', files: [P], blobs: { [P]: staleB }, base_sha: base }),
      v2({ entry_id: idC, agent_type: 'reviewer-clean', files: [Q], blobs: { [Q]: qStaged }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'P9 waiver ids are bound receipt ids', '--waive-bytes', 'operator re-read the changed lines by hand', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);

    const receipts = receiptTrailers(dir);
    const waivers = waiverTrailers(dir);
    assert.deepEqual(receipts.sort(), [idA, idB, idC].sort(), 'all three receipts are spent — two as waiver contributors, one as a matching contributor');
    assert.deepEqual(waivers.sort(), [idA, idB].sort(), 'only the receipts spent for the path NOBODY matched are waived — the matching receipt is never named');

    const missing = waivers.filter((w) => !receipts.includes(w));
    assert.deepEqual(missing, [], `every Review-Bytes-Waiver id must ALSO appear as a Review-Receipt id — an unbound waiver is unresolvable at the merge gate — unbound=${JSON.stringify(missing)}`);
    assert.ok(waivers.length > 0 && waivers.length < receipts.length,
      `CONTROL against a vacuous subset: the waiver set must be non-empty and STRICTLY smaller here — receipts=${JSON.stringify(receipts)} waivers=${JSON.stringify(waivers)}`);

    const waived = disclosure(soleJson(r), 'bytes_waived')[0];
    assert.ok(waived, 'the waiver is disclosed');
    assert.deepEqual([...(waived.entry_ids ?? [])].sort(), [idA, idB].sort(), `and the disclosure names the same two — got ${JSON.stringify(waived)}`);

    for (const id of [idA, idB, idC]) assertConsumed(dir, id, head, 'P9');
  } finally { cleanup(); }
});

// ===========================================================================
// P10 — ASSIGNED PATHS PERSIST ON THE CONSUMPTION RECORD. Same fixture as P6
// (receipt R attests P and is stale for Q; receipt S attests Q), different
// property: what the LEDGER remembers about what each spend paid for. This is the
// field every downstream verifier reads after the reservation is gone — the
// rejected "narrow only the reservation" design failed exactly here, because
// reservation data disappears at finalization.
// ===========================================================================

// EXPECTED TODAY: RED. Today the run refuses on R's stale Q evidence (so `r.code` fires
// first); even with the byte rule fixed, `consumption.paths` does not exist today, so both
// deepEquals would fire.
// SABOTAGE (the rejected design): keep the narrowing in the reservation only and omit `paths`
// from the consumption record -> both deepEquals red, and the receipt then reads as a
// legacy all-covered-paths record at the merge gate, which rejects it for Q (P10b's control arm
// is that rejection, so this pin and P10b fail together for one cause — the report must name
// P10 as the source).
// SECOND SABOTAGE: persist every COVERED path instead of the assigned ones -> R's deepEqual
// reds alone (it would read ['src/laneP.mjs','src/laneQ.mjs']) while S's stays green, because S
// covers exactly what it matched. A single-receipt fixture cannot tell those apart.
test('PER-PATH P10 (ASSIGNED PATHS PERSIST): each spent receipt\'s consumption record carries `paths` = exactly the paths it paid for — R pays for P alone although it also covers a stale Q, and S pays for Q', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const qStale = hashBytes(dir, Q_OLD);
    stageChange(dir, P, NEW);
    stageChange(dir, Q, Q_NEW);
    const pStaged = indexBlob(dir, P);
    const qStaged = indexBlob(dir, Q);
    assert.notEqual(qStale, qStaged, 'fixture guard: R genuinely attests stale bytes for Q');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idR = 'aa000000-0000-4000-8000-0000000000aa';
    const idS = 'bb000000-0000-4000-8000-0000000000bb';
    writeLedger(dir, [
      v2({ entry_id: idR, agent_type: 'reviewer-correctness', files: [P, Q], blobs: { [P]: pStaged, [Q]: qStale }, base_sha: base }),
      v2({ entry_id: idS, agent_type: 'reviewer-security', files: [Q], blobs: { [Q]: qStaged }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'P10 assigned paths', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assertConsumed(dir, idR, head, 'P10');
    assertConsumed(dir, idS, head, 'P10');

    assert.deepEqual(entryById(dir, idR).consumption?.paths, [P],
      `R is spent for the path it MATCHED, never for the stale one it merely covers — got ${JSON.stringify(entryById(dir, idR).consumption)}`);
    assert.deepEqual(entryById(dir, idS).consumption?.paths, [Q],
      `and S for its own — got ${JSON.stringify(entryById(dir, idS).consumption)}`);
  } finally { cleanup(); }
});

// ===========================================================================
// THE MERGE-GATE HALF (P10b / P11). Harness copied from
// scripts/tests/direct-merge-trailer-pattern.test.mjs (R1-C91), which is the only
// place the additive Review-Receipt binding rule is reachable end-to-end: the
// verifier is not imported by any test today, so the CLI is the honest seam.
//
// The store dist is loaded LAZILY and only by these two tests — a top-level
// `before` importing it would fail the whole file (including the nine pins above,
// which need no store) on an unbuilt workspace.
// ===========================================================================

const STORE_DIST = join(root, 'packages', 'store', 'dist', 'index.js');
const STORE_SKIP = GIT_SKIP || (existsSync(STORE_DIST) ? false : 'packages/store/dist is not built — run the workspace build first');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function makeReceiptGateRepo() {
  const { SterlingStore } = await import(pathToFileURL(STORE_DIST).href);
  const dir = mkdtempSync(join(tmpdir(), 'sterling-per-path-merge-gate-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({ toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs', '**/*.ts'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } }] })
  );
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close(); // store present, no active run
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runDirectMerge(dir, extra = []) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Writes SEVERAL files into ONE commit — the shape a multi-path slice commit has,
// which the single-path helper in the sibling suite cannot produce.
function commitFiles(dir, { files, subject, trailerBlock }) {
  for (const [relPath, content] of files) {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', subject, '-m', trailerBlock]);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  return { sha, short: git(dir, ['rev-parse', '--short', sha]) };
}
const treeBlob = (dir, sha, relPath) => git(dir, ['rev-parse', `${sha}:${relPath}`]);

// A consumed ReceiptV2 bound to `sha`. `paths` is OMITTED entirely when not given —
// that absence is the legacy shape P11 pins, and it must not be spelled as [] or null.
function consumedReceipt({ entry_id, agent_type = 'reviewer-correctness', files, blobs, sha, paths, branch = 'main', at = isoAgo(60_000) }) {
  const consumption = { commit_sha: sha, consumed_at: at, nonce: `n-${entry_id.slice(0, 8)}` };
  if (paths !== undefined) consumption.paths = paths;
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'consumed',
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: 'a-session', branch, base_sha: null, agent_id: `agent-${entry_id.slice(0, 8)}` },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs, absent_paths: [] },
    consumption,
    disposition: null,
  };
}

// EXPECTED TODAY: the CONTROL arm is GREEN (today's verifier compares every covered path, so
// the stale Q blob refuses [superseder_commit_blob_mismatch]); the `assigned-paths` arm is RED
// — `consumption.paths` is not read today, so the same commit refuses with the same code and
// the `r.code === 0` / `branch_merged` assertions fire. The two arms are ONE fixture differing
// in a single field, so neither is interpretable alone: the control's refusal proves the blob
// rule is enforced in this harness at all, and without it the green merge below is satisfied by
// "this gate never checks blobs".
// SABOTAGE (the over-reach direction): honour `paths` as a blanket "check nothing" -> the
// control arm merges and reds, because a receipt claiming ['src/laneP.mjs'] would then also
// escape verification for the path it DID assign.
// SABOTAGE (the whole feature): keep verifying every covered path -> the assigned-paths arm
// refuses and reds while the control stays green. That is today's state, and it is why a fix
// that stops at commit-reviewed leaves the slice unmergeable — the receipt spent for P alone
// would be rejected at the gate for the Q bytes a NEWER receipt attested.
test('PER-PATH P10b (MERGE GATE): direct-merge verifies a consumed receipt over its ASSIGNED paths only — a receipt with consumption.paths ["src/laneP.mjs"] merges although its evidence for src/laneQ.mjs is stale, while the SAME receipt without `paths` still refuses [superseder_commit_blob_mismatch]', { skip: STORE_SKIP }, async () => {
  for (const arm of ['no-paths (CONTROL, first)', 'assigned-paths']) {
    const { dir, cleanup } = await makeReceiptGateRepo();
    try {
      const branch = 'feat/assigned-paths';
      git(dir, ['checkout', '-b', branch]);
      const idR = 'aa000000-0000-4000-8000-0000000000ab';
      const idS = 'bb000000-0000-4000-8000-0000000000bc';
      const c = commitFiles(dir, {
        files: [[P, NEW], [Q, Q_NEW]],
        subject: `per-path slice (${arm})`,
        trailerBlock: [
          'Reviewed-By-Agent: reviewer-correctness',
          'Reviewed-By-Agent: reviewer-security',
          `Review-Receipt: ${idR}`,
          `Review-Receipt: ${idS}`,
        ].join('\n'),
      });
      const treeP = treeBlob(dir, c.sha, P);
      const treeQ = treeBlob(dir, c.sha, Q);
      const staleQ = 'c'.repeat(40);
      assert.notEqual(staleQ, treeQ, 'fixture guard: R genuinely holds bytes for Q that the commit does not');

      // R covers BOTH paths but was spent for P alone; S attests Q and was spent for it.
      const R = consumedReceipt({ entry_id: idR, files: [P, Q], blobs: { [P]: treeP, [Q]: staleQ }, sha: c.sha, branch, paths: arm === 'assigned-paths' ? [P] : undefined });
      const S = consumedReceipt({ entry_id: idS, agent_type: 'reviewer-security', files: [Q], blobs: { [Q]: treeQ }, sha: c.sha, branch, paths: arm === 'assigned-paths' ? [Q] : undefined });
      writeLedger(dir, [R, S]);

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      if (arm === 'assigned-paths') {
        assert.equal(r.code, 0, `[${arm}] a receipt spent for P alone must not be rejected for Q bytes a NEWER receipt attested — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.equal(JSON.parse(r.stdout).branch_merged, branch, `[${arm}] the branch really merged — stdout=${flat(r.stdout)}`);
      } else {
        assert.notEqual(r.code, 0, `[${arm}] CONTROL — with no assigned paths the legacy all-covered-paths rule applies and the stale Q evidence is a claim about bytes nobody reviewed — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, token('superseder_commit_blob_mismatch'), `[${arm}] and it refuses with the blob code — stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, new RegExp(escapeRegex(c.short)), `[${arm}] naming the offending commit — stderr=${flat(r.stderr)}`);
        assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${arm}] main never moved — this is the assertion that carries the verdict`);
      }
    } finally { cleanup(); }
  }
});

// EXPECTED TODAY: GREEN, both arms — this is the migration control, and it must STAY green
// through the fix. A pre-fix ledger is full of consumption records with no `paths`, and their
// meaning is unchanged: bound across every covered path.
// SABOTAGE (the migration break): read a MISSING `paths` as an empty assignment ("verify
// nothing") -> arm (b) merges and reds; every legacy receipt in every consumer's ledger would
// silently stop being verified, which converts the whole additive binding rule into a no-op for
// history. Arm (a) is the pair that keeps that verdict attributable: if the reader instead
// treated a missing `paths` as "verify nothing MATCHES", arm (a) would refuse and red alone.
// WHICH GUARD CARRIES THE VERDICT: arm (b)'s refusal. Arm (a) is a compat control — a green
// there could also be explained by a gate that merges everything, which is exactly what arm
// (b) rules out.
test('PER-PATH P11 (LEGACY CONTROL, must stay green): a consumed receipt written with NO `paths` key keeps today\'s all-covered-paths interpretation — it merges when every covered blob matches the tree, and still refuses [superseder_commit_blob_mismatch] when one covered blob does not', { skip: STORE_SKIP }, async () => {
  for (const arm of ['all-covered-match', 'one-covered-stale']) {
    const { dir, cleanup } = await makeReceiptGateRepo();
    try {
      const branch = 'feat/legacy-no-paths';
      git(dir, ['checkout', '-b', branch]);
      const id = 'dd000000-0000-4000-8000-0000000000dd';
      const c = commitFiles(dir, {
        files: [[P, NEW], [Q, Q_NEW]],
        subject: `legacy consumed receipt (${arm})`,
        trailerBlock: ['Reviewed-By-Agent: reviewer-correctness', `Review-Receipt: ${id}`].join('\n'),
      });
      const blobs = { [P]: treeBlob(dir, c.sha, P), [Q]: arm === 'one-covered-stale' ? 'c'.repeat(40) : treeBlob(dir, c.sha, Q) };
      // No `paths` key at all — the legacy shape.
      const legacy = consumedReceipt({ entry_id: id, files: [P, Q], blobs, sha: c.sha, branch });
      assert.equal('paths' in legacy.consumption, false, 'fixture guard: the consumption record genuinely has NO paths key — not [], not null');
      writeLedger(dir, [legacy]);

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      if (arm === 'all-covered-match') {
        assert.equal(r.code, 0, `[${arm}] a pre-fix ledger must keep merging — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.equal(JSON.parse(r.stdout).branch_merged, branch, `[${arm}] the branch really merged — stdout=${flat(r.stdout)}`);
      } else {
        assert.notEqual(r.code, 0, `[${arm}] a legacy record still binds across ALL its covered paths — reading an absent paths key as "verify nothing" would retire the binding rule for all history — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, token('superseder_commit_blob_mismatch'), `[${arm}] stderr=${flat(r.stderr)}`);
        assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${arm}] main never moved`);
      }
    } finally { cleanup(); }
  }
});

// ===========================================================================
// P12 — multi_spend COUNTS THE SPENT SET, NOT THE CANDIDATES. Five candidates on
// one path: four attest the staged blob, one is stale. Spent = 4, which is OVER the
// threshold; candidates = 5, so a count taken from the earlier selection reports 5.
//
// THE THRESHOLD IS READ FROM THE FROZEN PINS, NOT FROM THE CODE (H4):
// commit-reviewed-spend-warnings.test.mjs R1-D20 pins that exactly 3 selected
// receipts do NOT disclose (the boundary is `> 3`) and R1-D21 pins 4 receipts
// disclosing once with `facts.count === 4`. Four spent is therefore the smallest
// fixture where the disclosure is present AND the spent/candidate counts differ.
// ===========================================================================

// EXPECTED TODAY: RED. Today the stale fifth receipt records a mismatch and the run refuses, so
// `r.code` fires first; with the byte rule fixed but the count taken from the candidate set, the
// `facts.count === 4` assertion fires next.
// SABOTAGE (the one this pin exists for): count the CANDIDATE selection instead of the spent set
// -> facts.count reads 5 and the count/naming assertions red while the exit code and the
// trailer count stay green. Nothing else in this file reads the disclosure's count, and
// commit-reviewed-spend-warnings.test.mjs cannot see it either — every fixture there spends
// every receipt it selects.
// SECOND SABOTAGE: keep the count correct but leave the un-spent receipt named in the
// disclosure's facts -> the `doesNotMatch` on the stale id reds alone; a crowding disclosure
// that names a receipt this commit did not spend sends an operator to the wrong evidence.
test('PER-PATH P12: multi_spend counts the SPENT receipts — 5 candidates of which 4 are spent discloses facts.count 4 (not 5), never names the un-spent one, and stamps exactly 4 Review-Receipt trailers', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const stale = hashBytes(dir, OLD1);
    stageChange(dir, P, NEW);
    const staged = indexBlob(dir, P);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const spentIds = [
      'ee000000-0000-4000-8000-0000000000e1',
      'ee000000-0000-4000-8000-0000000000e2',
      'ee000000-0000-4000-8000-0000000000e3',
      'ee000000-0000-4000-8000-0000000000e4',
    ];
    const staleId = 'ff000000-0000-4000-8000-0000000000ff';
    writeLedger(dir, [
      ...spentIds.map((id, i) => v2({ entry_id: id, agent_type: `reviewer-${i}`, files: [P], blobs: { [P]: staged }, base_sha: base })),
      v2({ entry_id: staleId, agent_type: 'reviewer-stale', files: [P], blobs: { [P]: stale }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'P12 crowded commit with one stale candidate', '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const out = soleJson(r);

    const multi = disclosure(out, 'multi_spend');
    assert.equal(multi.length, 1, `exactly one multi-spend disclosure per invocation — got ${JSON.stringify(out.disclosures)}`);
    assert.equal(multi[0].facts?.count, 4, `the count is the SPENT set — a candidate-set count would read 5 — got ${JSON.stringify(multi[0])}`);
    assert.doesNotMatch(JSON.stringify(multi[0]), new RegExp(escapeRegex(staleId)),
      `and the disclosure never names a receipt this commit did not spend — got ${JSON.stringify(multi[0])}`);

    assert.deepEqual(receiptTrailers(dir).sort(), [...spentIds].sort(), 'four Review-Receipt trailers, one per spent receipt');
    for (const id of spentIds) assertConsumed(dir, id, head, 'P12');
    assertUnspent(dir, staleId, 'P12');
    assert.ok(hasDisclosureNaming(out, 'receipt_not_spent_stale_bytes', staleId),
      `the un-spent candidate is disclosed on its own channel — got ${JSON.stringify(out.disclosures)}`);
  } finally { cleanup(); }
});

// ===========================================================================
// P13 — AN EMPTY ASSIGNMENT ON A SCOPED RECEIPT IS UNBOUND, NOT UNIVERSALLY
// SATISFIED. `paths: []` is the one value where "check exactly the assigned
// paths" degenerates into checking NOTHING, so it is the cheapest possible forgery
// against the whole assigned-paths design: a receipt that reviewed anything, or
// nothing, binds a commit it never attested. The gate must read an empty
// assignment on a SCOPED receipt as a claim it cannot check.
//
// THE CONTROL IS AN UNSCOPED RECEIPT (territory.files []), which legitimately has
// nothing to assign and merges as it does today (spent-set clause (c), "unscoped
// receipts as today"). Placed FIRST, because without it a refusal above is
// satisfied by "any receipt with an empty paths array refuses", which would break
// the unscoped class the ruling deliberately left alone.
// ===========================================================================

// EXPECTED TODAY: the CONTROL arm is GREEN (an unscoped consumed receipt binds today, its
// covered-path set being empty); the SCOPED arm is UNDETERMINED-TO-GREEN — today
// `consumption.paths` is not read at all, so today's verifier checks the receipt's covered
// paths and the scoped receipt's blob MATCHES the tree, which merges. That makes the scoped arm
// RED today on `r.code !== 0`. Either way it is the pin that stops the fix from shipping an
// empty-assignment bypass.
// SABOTAGE (the bypass): treat `paths: []` as "no paths to verify, therefore verified" -> the
// scoped arm merges and reds while the control stays green. That single line is the difference
// between "verify exactly the assignment" and "accept any receipt that declares no assignment".
// SABOTAGE (the over-reach direction): refuse on any empty `paths` regardless of scope -> the
// CONTROL reds, which is how an over-broad guard is told apart from a correct one.
test('PER-PATH P13: a SCOPED consumed receipt whose consumption.paths is EMPTY does not bind — direct-merge refuses [superseder_commit_receipt_unbound] naming the empty assignment; an UNSCOPED receipt (territory.files []) with the same empty paths still merges', { skip: STORE_SKIP }, async () => {
  for (const arm of ['unscoped (CONTROL, first)', 'scoped-empty-assignment']) {
    const { dir, cleanup } = await makeReceiptGateRepo();
    try {
      const branch = 'feat/empty-assignment';
      git(dir, ['checkout', '-b', branch]);
      const id = 'a1000000-0000-4000-8000-0000000000e0';
      const c = commitFiles(dir, {
        files: [[P, NEW]],
        subject: `empty assignment (${arm})`,
        trailerBlock: ['Reviewed-By-Agent: reviewer-correctness', `Review-Receipt: ${id}`].join('\n'),
      });
      const scoped = arm === 'scoped-empty-assignment';
      const receipt = consumedReceipt({
        entry_id: id,
        files: scoped ? [P] : [],
        blobs: scoped ? { [P]: treeBlob(dir, c.sha, P) } : {},
        sha: c.sha, branch, paths: [],
      });
      assert.deepEqual(receipt.consumption.paths, [], 'fixture guard: the assignment really is the empty array, not an absent key');
      writeLedger(dir, [receipt]);

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      if (scoped) {
        assert.notEqual(r.code, 0, `[${arm}] a scoped receipt that assigned NOTHING attests nothing about this commit — an empty assignment must never read as "verified" — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, token('superseder_commit_receipt_unbound'), `[${arm}] stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, /assigned[ _-]?paths|assignment/i, `[${arm}] and the refusal says WHY it could not bind — an operator cannot tell an empty assignment from a wrong sha otherwise — stderr=${flat(r.stderr)}`);
        assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${arm}] main never moved — this is the assertion that carries the verdict`);
      } else {
        assert.equal(r.code, 0, `[${arm}] CONTROL — an unscoped receipt has nothing to assign and binds exactly as it does today — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.equal(JSON.parse(r.stdout).branch_merged, branch, `[${arm}] the branch really merged — stdout=${flat(r.stdout)}`);
      }
    } finally { cleanup(); }
  }
});

// ===========================================================================
// P14 — A MALFORMED ASSIGNMENT IS A MALFORMED ENTRY: NEVER BINDING, NEVER
// SPENDABLE, ALWAYS DISCLOSED. Three shapes, each a different failure of the
// same invariant (`paths` ⊆ the receipt's covered territory, normalized, unique):
//   '../x'      — ESCAPES THE REPO. The path invariant says every stored path is
//                 repo-relative POSIX; a traversal segment in an agent-writable
//                 ledger is the shape that turns a verifier's path join into a
//                 read outside the tree.
//   ['A','A']   — DUPLICATE. Harmless-looking, and the reason it matters is that a
//                 duplicate makes any COUNT taken from the assignment (multi_spend,
//                 a coverage tally) disagree with the set it is meant to summarise.
//   ['B'] with only A covered — OUTSIDE THE TERRITORY. A receipt cannot assign
//                 itself a path it never reviewed; this is the forgery the subset
//                 rule exists for, and it is invisible to the other two shapes.
// ===========================================================================

// EXPECTED TODAY: RED on every merge-gate arm — `consumption.paths` is not read today, so all
// three malformed receipts bind on their covered paths and the branch merges (`r.code !== 0`
// fires first in each). The commit-reviewed arm at the end is RED today on the disclosure
// assertion. The CONTROL (well-formed assignment) is RED today for the P10b reason: today's
// verifier checks every covered path.
// SABOTAGE (validate nothing): accept `paths` as given -> all three arms merge and red while
// the control stays green.
// SABOTAGE (normalize instead of refuse): resolve '../x' or de-duplicate ['A','A'] into
// acceptance -> those two arms merge and red. A laundered assignment is worse than a refused
// one: it is a silent rewrite of what a reviewer attested, and the ledger then reads as
// authoritative.
// SABOTAGE (drop the subset check only): keep traversal/duplicate validation -> the
// outside-territory arm alone reds, which is why it is a separate arm rather than a permutation.
test('PER-PATH P14: a consumption.paths that escapes the repo, repeats a path, or names a path outside the receipt\'s covered territory makes the ENTRY malformed — it never binds at the merge gate, is never spendable, and is disclosed', { skip: STORE_SKIP }, async () => {
  const malformed = {
    traversal: () => ['../x'],
    duplicate: () => [P, P],
    'outside-territory': () => [Q],
  };
  for (const arm of ['well-formed (CONTROL, first)', 'traversal', 'duplicate', 'outside-territory']) {
    const { dir, cleanup } = await makeReceiptGateRepo();
    try {
      const branch = 'feat/malformed-assignment';
      git(dir, ['checkout', '-b', branch]);
      const id = 'a1000000-0000-4000-8000-0000000000e1';
      const c = commitFiles(dir, {
        files: [[P, NEW]],
        subject: `malformed assignment (${arm})`,
        trailerBlock: ['Reviewed-By-Agent: reviewer-correctness', `Review-Receipt: ${id}`].join('\n'),
      });
      const paths = arm in malformed ? malformed[arm]() : [P];
      writeLedger(dir, [consumedReceipt({ entry_id: id, files: [P], blobs: { [P]: treeBlob(dir, c.sha, P) }, sha: c.sha, branch, paths })]);

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      if (arm in malformed) {
        assert.notEqual(r.code, 0, `[${arm}] a malformed entry is not evidence — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.match(r.stderr, ANY_CODE_TOKEN, `[${arm}] and the refusal is never silent: it carries a [code] from the closed set — stderr=${flat(r.stderr)}`);
        assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${arm}] main never moved — this is the assertion that carries the verdict`);
      } else {
        assert.equal(r.code, 0, `[${arm}] CONTROL — a well-formed assignment binds, so the refusals above are caused by the MALFORMATION and not by this harness — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.equal(JSON.parse(r.stdout).branch_merged, branch, `[${arm}] the branch really merged — stdout=${flat(r.stdout)}`);
      }
    } finally { cleanup(); }
  }
});

// THE OTHER HALF OF P14: the SPEND side. A malformed entry must not be selectable, and its
// exclusion must be VISIBLE — a ledger entry silently ignored is indistinguishable from one
// that was never written, which is how real review evidence disappears without a trace.
// EXPECTED TODAY: RED on the disclosure assertion. Today's parseReceipt has no notion of
// `paths`, so the malformed CONSUMED entry is skipped as terminal (not selectable for other
// reasons) and nothing is disclosed about it.
// SABOTAGE: skip a malformed entry silently -> the disclosure assertion reds alone while the
// commit still lands. SECOND SABOTAGE: treat a malformed entry as a hard refusal -> the exit-0
// and trailer assertions red; one unparseable entry must not wedge a ledger that also holds a
// perfectly good receipt (that is the migration hazard the disclosure channel exists for).
test('PER-PATH P14b: a malformed-assignment entry beside a healthy active receipt is NOT spendable and is DISCLOSED — the healthy receipt still commits and the malformed one is left untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, P, NEW);
    const staged = indexBlob(dir, P);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const badId = 'a1000000-0000-4000-8000-0000000000e2';
    const goodId = 'a1000000-0000-4000-8000-0000000000e3';
    const bad = {
      ...v2({ entry_id: badId, agent_type: 'reviewer-malformed', files: [P], blobs: { [P]: staged }, base_sha: base, status: 'consumed' }),
      consumption: { commit_sha: 'a'.repeat(40), consumed_at: isoAgo(90_000), nonce: 'settled', paths: ['../x'] },
    };
    writeLedger(dir, [bad, v2({ entry_id: goodId, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: staged }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'P14b malformed entry beside a healthy one', '--json']);
    assert.equal(r.code, 0, `one malformed entry must not wedge a ledger that also holds a spendable receipt — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.deepEqual(receiptTrailers(dir), [goodId], 'only the healthy receipt is spent');
    assertConsumed(dir, goodId, head, 'P14b');
    assert.deepEqual(entryById(dir, badId), bad, 'and the malformed entry comes out byte-identical — never repaired in place, never dropped');

    const out = soleJson(r);
    assert.ok((out.disclosures ?? []).some((d) => JSON.stringify(d).includes(badId)),
      `the malformed entry is DISCLOSED by id — a silently ignored ledger entry is indistinguishable from one that was never written — got ${JSON.stringify(out.disclosures)}`);
  } finally { cleanup(); }
});

// ===========================================================================
// P15 — THE AMEND REBIND HONOURS AN ASSIGNMENT IT DID NOT MAKE. A commit landed
// with --waive-bytes carries `Review-Bytes-Waiver: A` and a receipt A consumed for
// paths it was WAIVED for, i.e. whose blobs deliberately do NOT equal the tree.
// The amend path (§6 A9 / R1-D98) re-binds every already-consumed receipt to the
// new sha and refuses [target_sha_prior_receipt_unbound] when a preserved
// Review-Receipt trailer names a receipt it cannot account for — and a waived
// receipt is exactly the receipt whose bytes it cannot re-verify.
//
// WHY THIS IS ITS OWN PIN: without it, "waiver contributors are spent" (P4/P9)
// makes every waived commit PERMANENTLY UN-AMENDABLE, which is a fresh dead end
// created by this very fix. The assignment is what carries the answer: A's assigned
// paths were waived, so the rebind re-verifies nothing for them.
// ===========================================================================

// EXPECTED TODAY: RED. The amend refuses [target_sha_prior_receipt_unbound] (or the byte rule
// refuses first on A's stale blob), so `r.code === 0` fires; `consumption.paths` does not
// exist today either.
// SABOTAGE (the dead end): re-verify a preserved receipt's bytes over its COVERED paths during
// the rebind -> the amend refuses and every assertion here reds, while P4/P9 stay green. That
// pair of results is the signature of the trap: the spend succeeded and the amend became
// impossible.
// SABOTAGE (the over-reach direction): let a preserved Review-Receipt trailer skip verification
// whenever ANY waiver trailer is present -> the waiver-trailer-preserved assertion still
// passes, so this arm does NOT catch it; that direction is R1-C93's third arm in
// direct-merge-trailer-pattern.test.mjs (a waiver naming another entry_id), which stays green
// and is the pin that does. Named here so the gap is visible rather than assumed covered.
test('PER-PATH P15: a commit that landed with --waive-bytes can still be amended with --target-sha — the waiver trailer is preserved, the waived receipt re-binds to the new sha keeping its assigned paths, and there is no [target_sha_prior_receipt_unbound]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // Amend mode reads the toolchain globs from .sterling/config.json (the seam the target-sha
    // suite seeds); without it the CODE-TOUCHING classification has nothing to key on.
    seedConfig(dir);
    const stale = hashBytes(dir, OLD1);
    stageChange(dir, P, NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = 'a1000000-0000-4000-8000-0000000000f1';
    writeLedger(dir, [v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: stale }, base_sha: base })]);

    const first = runCommitReviewed(dir, ['-m', 'P15 landed under a waiver', '--waive-bytes', 'operator re-read the changed lines by hand']);
    assert.equal(first.code, 0, `fixture guard: the waived commit must land first — stdout=${flat(first.stdout)} stderr=${flat(first.stderr)}`);
    const targetSha = git(dir, ['rev-parse', 'HEAD']);
    assert.deepEqual(waiverTrailers(dir, targetSha), [idA], 'fixture guard: the commit really carries the waiver trailer');
    assert.deepEqual(entryById(dir, idA).consumption?.paths, [P], 'fixture guard: and A is consumed for the path it was waived for');

    // A post-hoc receipt for the SAME path, eligible for amend mode (base_sha === target sha),
    // attesting the target commit's own tree.
    const idB = 'a1000000-0000-4000-8000-0000000000f2';
    const entries = readLedger(dir);
    entries.push(v2({ entry_id: idB, agent_type: 'reviewer-security', files: [P], blobs: { [P]: treeBlob(dir, targetSha, P) }, base_sha: targetSha, at: isoAgo(5_000) }));
    writeLedger(dir, entries);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], SEAM_ON);
    assert.equal(r.code, 0, `a waived commit must stay amendable — otherwise "waiver contributors are spent" makes every waived commit a dead end — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, token('target_sha_prior_receipt_unbound'), `stderr=${flat(r.stderr)}`);

    const newSha = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(newSha, targetSha, 'the commit was amended');
    assert.equal(git(dir, ['rev-parse', `${newSha}^{tree}`]), git(dir, ['rev-parse', `${targetSha}^{tree}`]), 'IDENTICAL tree — the amend touches only the message');
    assert.deepEqual(waiverTrailers(dir, newSha), [idA], 'the waiver trailer is PRESERVED — an override that vanishes on an amend is an override nobody can audit');
    assert.deepEqual(receiptTrailers(dir, newSha).sort(), [idA, idB].sort(), 'and both the preserved and the new receipt are named');

    assert.equal(entryById(dir, idA).consumption?.commit_sha, newSha, 'the waived receipt re-binds to the sha that now exists');
    assert.deepEqual(entryById(dir, idA).consumption?.paths, [P], 'keeping its assigned paths — the rebind moves the sha, never the assignment');
    assert.equal(entryById(dir, idB).consumption?.commit_sha, newSha, 'and the post-hoc receipt is consumed against it');
  } finally { cleanup(); }
});

// ===========================================================================
// P16 — THE SINGLE-RECEIPT MISMATCH KEEPS ITS OLD SHAPE AND GAINS THE NEW FIELD.
// P8 pins receipts_by_path where TWO receipts disagree; this pins the ONE-receipt
// case, which is the shape the four frozen deepEquals in
// commit-reviewed-bytes-refuse.test.mjs assert — so it is simultaneously the new
// field's pin and a CONTROL that adding it did not disturb `mismatches`.
// ===========================================================================

// EXPECTED TODAY: RED only on the receipts_by_path assertions. The `mismatches` deepEqual is
// exactly R1-D31's shape and is GREEN today; the exit code and code are green too.
// SABOTAGE: emit receipts_by_path only when more than one receipt was consulted -> the
// single-receipt arm reds while P8 stays green. An operator debugging the ordinary
// one-reviewer case would otherwise get less evidence than in the crowded case, for no reason.
// SECOND SABOTAGE: build receipts_by_path from the receipts that MATCHED rather than the ones
// consulted -> the array is empty here and reds, while the mismatches deepEqual stays green.
test('PER-PATH P16: with ONE stale receipt the refusal keeps facts.mismatches === [{path, receipt_blob, index_blob}] exactly AND carries facts.receipts_by_path[path] === [{entry_id, receipt_blob}]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewed = hashBytes(dir, OLD1);
    stageChange(dir, P, NEW);
    const staged = indexBlob(dir, P);
    assert.notEqual(reviewed, staged, 'fixture guard: the reviewed bytes genuinely differ from the staged bytes');
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = 'a1000000-0000-4000-8000-0000000000f6';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: reviewed }, base_sha: base })]);

    const r = runCommitReviewed(dir, ['-m', 'P16 one stale receipt', '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const out = soleJson(r);
    assert.equal(out.code, 'receipt_bytes_mismatch', `got ${JSON.stringify(out)}`);
    assert.deepEqual(out.facts?.mismatches, [{ path: P, receipt_blob: reviewed, index_blob: staged }],
      `the legacy triple is unchanged — this is the shape four frozen deepEquals depend on — got ${JSON.stringify(out.facts)}`);
    assert.deepEqual(out.facts?.receipts_by_path?.[P], [{ entry_id: id, receipt_blob: reviewed }],
      `and the consulted receipt is named per path even in the single-receipt case — got ${JSON.stringify(out.facts)}`);
  } finally { cleanup(); }
});

// ===========================================================================
// P17 — A TRAILER THE RUN DID NOT STAMP IS A VERIFY FAILURE. D109 (two-phase
// suite) pins the MISSING-trailer half of commit_verify_failed. This is the
// EXTRA-trailer half, and it is the more dangerous one: an injected
// `Review-Bytes-Waiver` naming an ACTIVE receipt turns the commit into an
// accountable-looking override nobody authorised, and the merge gate will HONOUR
// it (R1-C93 arm 1 merges a blob-mismatched receipt on the strength of that
// trailer). A commit-msg hook is the ordinary shape that can do this — every
// consumer machine has writable .git/hooks.
// ===========================================================================

// EXPECTED TODAY: RED. Today's post-commit verification checks that the trailers it WROTE are
// readable; it has no notion of an unexpected one, so the run exits 0, the receipt is consumed,
// and the injected waiver reaches main. `r.code === 1` fires first.
// SABOTAGE (today's shape): verify trailer PRESENCE only, never the absence of extras -> exit 0,
// the receipt is consumed, and every assertion here reds. D109 stays green throughout, which is
// why the two halves need two pins.
// SABOTAGE (the release direction): refuse but RELEASE the reservation -> the reserved-status
// assertion reds while the code assertion stays green. The commit EXISTS and names the receipt,
// so releasing here strands a real binding; reconcile decides after comparing the tree (and P18
// pins that it must NOT finalize this one).
test('PER-PATH P17: when a commit-msg hook injects a Review-Bytes-Waiver naming an ACTIVE receipt, commit-reviewed refuses [commit_verify_failed] naming the unexpected trailer — the receipt stays RESERVED, is not consumed, and the injected id is not silently adopted', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const unspentId = 'a1000000-0000-4000-8000-0000000000f7';
    const spentId = 'a1000000-0000-4000-8000-0000000000f8';
    // A REAL commit-msg hook: it appends one trailer line to the final paragraph, which is
    // exactly where commit-reviewed's own trailer block sits, so git parses it as a trailer.
    installHook(dir, 'commit-msg', `#!/usr/bin/env node
const fs = require('fs');
const file = process.argv[2];
let msg = fs.readFileSync(file, 'utf8');
if (!msg.endsWith('\\n')) msg += '\\n';
fs.writeFileSync(file, msg + 'Review-Bytes-Waiver: ${unspentId}\\n');
`);
    const stale = hashBytes(dir, OLD1);
    stageChange(dir, P, NEW);
    const staged = indexBlob(dir, P);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({ entry_id: spentId, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: staged }, base_sha: base }),
      v2({ entry_id: unspentId, agent_type: 'reviewer-stale', files: [P], blobs: { [P]: stale }, base_sha: base }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'P17 injected waiver trailer', '--json']);
    assert.equal(r.code, 1, `a trailer the run did not stamp is a verification failure — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'fixture guard: the commit itself DID land — this is the post-commit class, not a refusal');
    assert.deepEqual(waiverTrailers(dir, head), [unspentId], 'fixture guard: the hook really injected the waiver trailer');

    const out = soleJson(r);
    assert.equal(out.code, 'commit_verify_failed', `got ${JSON.stringify(out)}`);
    assert.ok(JSON.stringify(out.facts ?? {}).includes(unspentId),
      `the facts NAME the unexpected trailer — an operator told only "verify failed" cannot tell an injected waiver from a lost one — got ${JSON.stringify(out.facts)}`);

    const spent = entryById(dir, spentId);
    assert.equal(spent.status, 'reserved', `the receipt stays RESERVED, never consumed against a commit carrying a waiver nobody authorised — got ${JSON.stringify(spent.status)}`);
    assert.equal(spent.consumption, undefined, 'and carries no consumption');
    assertUnspent(dir, unspentId, 'P17');
  } finally { cleanup(); }
});

// ===========================================================================
// P18 — RECONCILE MUST NOT LAUNDER A COMMIT IT CANNOT VOUCH FOR. Reconcile's job
// (§3.1) is to finalize a reservation whose commit is uniquely matching, and to
// release one with no commit. A commit whose Review-Receipt trailer matches but
// whose Review-Bytes-Waiver trailer was STRIPPED is neither: it names the receipt
// but no longer carries the override that justified spending it. Finalizing there
// would convert a refused spend into a consumed one through the recovery path —
// i.e. the remedy becomes the bypass.
// ===========================================================================

// EXPECTED TODAY: RED. Today reconcile matches on the Review-Receipt trailer plus the tree, so
// the stripped-waiver commit looks uniquely matching and it finalizes — the status assertion
// fires. (Today's byte rule also refuses this spend up front, so the arm depends on the fix
// landing first; that ordering is stated here rather than assumed.)
// SABOTAGE (the laundering): finalize on the Review-Receipt trailer alone -> the receipt is
// consumed, the assertions red, and a waived spend that FAILED verification is retroactively
// blessed by the recovery verb. D106 in the two-phase suite stays green throughout.
// SABOTAGE (the opposite over-reach): RELEASE it instead -> the reserved-status assertion reds
// the other way; a commit that exists and names the receipt must not have its evidence quietly
// returned to the pool either, because the commit is still out there naming it.
test('PER-PATH P18: reconcile does NOT finalize a reservation whose commit lost its Review-Bytes-Waiver trailer — the receipt stays RESERVED and the missing trailer is named', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // A REAL commit-msg hook that STRIPS the waiver trailer the run stamped.
    installHook(dir, 'commit-msg', `#!/usr/bin/env node
const fs = require('fs');
const file = process.argv[2];
const msg = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, msg.split('\\n').filter((l) => !l.startsWith('Review-Bytes-Waiver:')).join('\\n'));
`);
    const stale = hashBytes(dir, OLD1);
    stageChange(dir, P, NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const id = 'a1000000-0000-4000-8000-0000000000f9';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: stale }, base_sha: base })]);

    const spend = runCommitReviewed(dir, ['-m', 'P18 waiver trailer stripped by a hook', '--waive-bytes', 'operator re-read the changed lines by hand', '--json']);
    assert.equal(spend.code, 1, `fixture guard: the spend must FAIL verification — stdout=${flat(spend.stdout)} stderr=${flat(spend.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'fixture guard: the commit itself landed');
    assert.deepEqual(waiverTrailers(dir, head), [], 'fixture guard: the hook really stripped the waiver trailer');
    assert.deepEqual(receiptTrailers(dir, head), [id], 'fixture guard: while the Review-Receipt trailer survived — which is what makes the commit look "uniquely matching"');
    assert.equal(entryById(dir, id).status, 'reserved', 'fixture guard: and the receipt is left reserved by the failed verify');

    const rec = runReviewLedger(dir, ['reconcile', '--json']);
    const stuck = entryById(dir, id);
    assert.equal(stuck.status, 'reserved', `reconcile must not turn a REFUSED waived spend into a consumed one — the recovery path is not a second route past verification — got ${JSON.stringify(stuck.status)}`);
    assert.equal(stuck.consumption, undefined, 'and no consumption is invented');
    assert.match(`${rec.stdout}\n${rec.stderr}`, /Review-Bytes-Waiver|waiver/i,
      `and reconcile SAYS what stopped it — stdout=${flat(rec.stdout)} stderr=${flat(rec.stderr)}`);
  } finally { cleanup(); }
});

// P18's CONTROL, and the arm that proves reconcile still WORKS. The injection is the one the
// two-phase suite uses (§6 A13's crash path): a post-commit hook makes .sterling read-only, so
// the commit is durable and the finalize write is not. Reconcile then finalizes from the
// reservation's own index_blobs — which, after the fix, are exactly the ASSIGNED paths, so the
// consumption it writes carries them.
// EXPECTED TODAY: RED on `consumption.paths` (the field does not exist today); the reconcile
// status half is plausibly green.
// SABOTAGE: finalize from the receipt's COVERED paths instead of the reservation's index_blobs
// -> the paths deepEqual reds (it would read both paths) while the status stays consumed. A
// crash must not widen an assignment: the reservation is the only record of what this spend
// was paying for.
test('PER-PATH P18b (CONTROL): when only the FINALIZE write failed, reconcile DOES finalize the same waived reservation — consumed against that commit with consumption.paths taken from the reservation\'s index_blobs', { skip: PERM_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    installHook(dir, 'post-commit', `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.chmodSync(path.join(process.cwd(), '.sterling'), 0o555);
`);
    const stale = hashBytes(dir, OLD1);
    stageChange(dir, P, NEW);
    stageChange(dir, Q, Q_NEW);
    const qStaged = indexBlob(dir, Q);
    const base = git(dir, ['rev-parse', 'HEAD']);
    const idA = 'a1000000-0000-4000-8000-0000000000fa';
    const idC = 'a1000000-0000-4000-8000-0000000000fb';
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: [P], blobs: { [P]: stale }, base_sha: base }),
      v2({ entry_id: idC, agent_type: 'reviewer-clean', files: [Q], blobs: { [Q]: qStaged }, base_sha: base }),
    ]);

    const spend = runCommitReviewed(dir, ['-m', 'P18b finalize cannot write', '--waive-bytes', 'operator re-read the changed lines by hand', '--json']);
    assert.equal(spend.code, 1, `fixture guard: the finalize write must fail — stdout=${flat(spend.stdout)} stderr=${flat(spend.stderr)}`);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(head, base, 'fixture guard: the commit itself landed');
    chmodSync(join(dir, '.sterling'), 0o755);
    assert.equal(entryById(dir, idA).status, 'reserved', 'fixture guard: the waived receipt is stuck reserved');

    const rec = runReviewLedger(dir, ['reconcile', '--json']);
    assert.equal(rec.code, 0, `reconcile must succeed on a commit it CAN vouch for — stdout=${flat(rec.stdout)} stderr=${flat(rec.stderr)}`);
    const doneA = entryById(dir, idA);
    assert.equal(doneA.status, 'consumed', `got ${JSON.stringify(doneA.status)}`);
    assert.equal(doneA.consumption?.commit_sha, head, 'bound to THAT commit');
    assert.deepEqual(doneA.consumption?.paths, [P],
      `and the assignment comes from the reservation's index_blobs — a crash must never WIDEN what a spend paid for — got ${JSON.stringify(doneA.consumption)}`);
    assert.deepEqual(entryById(dir, idC).consumption?.paths, [Q], 'the other receipt keeps its own assignment');
  } finally {
    try { chmodSync(join(dir, '.sterling'), 0o755); } catch { /* already writable */ }
    cleanup();
  }
});

// ===========================================================================
// P19 — SUPERSESSION CREDITS ONLY WHAT THE SUPERSEDER WAS SPENT FOR. The commit
// form of `discharge --class superseded` proves recency and coverage from the
// receipts NAMED by that commit's Review-Receipt trailers. Under the
// assigned-paths rule each such receipt's credit is exactly its assignment — so a
// superseder spent for P alone cannot retire an older receipt whose live territory
// is Q, even though it DECLARES Q. Getting this wrong retires real review evidence
// on the strength of bytes the superseder never attested, and a discharged receipt
// is not recoverable by re-running anything.
//
// COVERAGE IS A UNION OVER *BOUND* RECEIPTS, AND THAT IS BY DESIGN — frozen pin
// R1-C55 in review-ledger-superseded-classes.test.mjs: real commits are reviewed by
// several agents with disjoint territories, so a SECOND receipt bound to this
// commit and assigned Q would legitimately discharge a Q-territory receipt, and
// this pin must not be read as forbidding that. What the fixture below therefore
// controls for is the difference between BOUND-AND-ASSIGNED and merely PRESENT:
// `otherId` sits in the ledger covering Q but is stale, unspent and ABSENT from
// the trailer block, so no bound receipt assigns Q. An earlier draft of this arm
// had `otherId` bound and assigned Q, which made the discharge CORRECT under
// R1-C55 and the pin a false accusation — the fixture, not the code, was wrong.
//
// BOTH ARMS NOW SHARE ONE COMMIT SHAPE (trailer names the superseder alone) and
// differ in exactly ONE variable: the territory of the receipt being discharged.
// ===========================================================================

// EXPECTED TODAY: the CONTROL arm (discharging the P-receipt) is RED — today's commit form
// requires the named receipt's blobs to equal the commit tree for EVERY covered path, and the
// superseder is deliberately stale on Q, so today it refuses. The Q arm REFUSES today too, but
// for the WRONG CAUSE (the blob check, not the assignment), which is exactly why its code and
// facts are now pinned by name rather than by "some [code] appeared": a same-verdict,
// different-cause refusal must not read as a pass. That asymmetry is also why the control is
// load-bearing and why the Q arm alone would prove nothing.
// SABOTAGE (the reporting half): refuse with the right verdict but no facts.uncovered, or list
// every path considered instead of only the uncovered one -> the deepEqual reds alone. A
// coverage refusal an operator cannot localise sends them to re-review the whole territory.
// SABOTAGE (the credit widening): compute coverage from the superseder's DECLARED territory (or
// its covered paths) rather than its assigned paths -> the Q arm discharges and reds, retiring
// a receipt on evidence nobody produced.
// SABOTAGE (bound vs merely present): union the assignments of every receipt IN THE LEDGER that
// looks newer, rather than only those BOUND by this commit's Review-Receipt trailers -> the
// unspent, stale `otherId` contributes Q, the Q arm discharges and reds. This is the sabotage
// the corrected fixture exists to catch, and R1-C55 (union over BOUND receipts) stays green
// under it, so neither pin substitutes for the other.
// SABOTAGE (the credit narrowing to nothing): treat an assignment as covering no path -> the
// CONTROL arm refuses and reds, which is how an over-tight fix is told apart from a correct one.
test('PER-PATH P19: with the superseder as the commit\'s ONLY bound receipt and assigned P alone, discharge succeeds for an older P-territory receipt and REFUSES for a Q-territory one — credit comes from ASSIGNED paths of BOUND receipts, never from declared territory nor from an unspent receipt that merely covers Q', { skip: GIT_SKIP }, () => {
  for (const arm of ['discharge-P (CONTROL, first)', 'discharge-Q']) {
    const { dir, cleanup } = makeRepo();
    try {
      const targetId = 'a1000000-0000-4000-8000-0000000000c1';
      const superId = 'a1000000-0000-4000-8000-0000000000c2';
      const otherId = 'a1000000-0000-4000-8000-0000000000c3';

      // One commit carrying both paths and binding the SUPERSEDER ALONE. No bound receipt
      // assigns Q, which is the whole premise of the Q arm; see the R1-C55 note above.
      stageChange(dir, P, NEW);
      stageChange(dir, Q, Q_NEW);
      git(dir, ['commit', '-m', `P19 superseder commit\n\nReviewed-By-Agent: reviewer-correctness\nReview-Receipt: ${superId}`]);
      const sha = git(dir, ['rev-parse', 'HEAD']);
      const treeP = treeBlob(dir, sha, P);
      const staleQ = hashBytes(dir, Q_OLD);
      assert.deepEqual(receiptTrailers(dir, sha), [superId], 'fixture guard: the commit binds the superseder and NOTHING else — a second bound receipt assigned Q would legitimately discharge (R1-C55)');

      const coveredByTarget = arm === 'discharge-Q' ? Q : P;
      const target = v2({
        entry_id: targetId, agent_type: 'reviewer-old', files: [coveredByTarget],
        blobs: { [coveredByTarget]: coveredByTarget === P ? treeP : staleQ },
        base_sha: sha, at: isoAgo(600_000),
      });
      // The superseder DECLARES both paths and is stale on Q; it was spent for P alone.
      const superseder = {
        ...v2({ entry_id: superId, agent_type: 'reviewer-correctness', files: [P, Q], blobs: { [P]: treeP, [Q]: staleQ }, base_sha: sha, status: 'consumed', at: isoAgo(30_000) }),
        consumption: { commit_sha: sha, consumed_at: isoAgo(30_000), nonce: 'n-super', paths: [P] },
      };
      // A receipt that COVERS Q but is stale, UNSPENT and unbound — the ordinary
      // fix-after-review leftover (P2's shape). It is in the ledger and it must credit
      // NOTHING: only receipts BOUND by this commit's trailers can, and only for their
      // assigned paths.
      const other = v2({ entry_id: otherId, agent_type: 'reviewer-security', files: [Q], blobs: { [Q]: staleQ }, base_sha: sha, at: isoAgo(30_000) });
      writeLedger(dir, [target, superseder, other]);
      assert.equal(other.status, 'active', 'fixture guard: the Q-covering receipt is UNSPENT, so it is not bound to this commit and cannot contribute coverage');

      const r = runReviewLedger(dir, [
        'discharge', '--entry-id', targetId, '--digest', ledgerDigest(dir),
        '--class', 'superseded', '--superseded-by', sha,
        '--reason', 'a later reviewed commit covers this territory', '--json',
      ]);
      const after = (readLedger(dir) ?? []).find((e) => e.entry_id === targetId);

      if (arm === 'discharge-Q') {
        assert.notEqual(r.code, 0, `[${arm}] the superseder was never spent for Q, so it cannot retire a receipt whose territory is Q — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        // --json puts the refusal on STDOUT as one object ({ok:false, code, facts, message}) —
        // the same channel the sibling superseded-classes suite parses. Asserting a bracketed
        // [code] token on stderr was wrong about the CHANNEL, and it also under-pinned the
        // verdict: a refusal for the wrong CAUSE would have satisfied it.
        const out = soleJson(r);
        assert.equal(out.ok, false, `[${arm}] the refusal object says so — got ${JSON.stringify(out)}`);
        assert.equal(out.code, 'superseder_coverage_incomplete',
          `[${arm}] the cause is COVERAGE — the superseder's assignment does not reach this receipt's territory; a blob-mismatch or lifecycle code here would mean the verifier refused for a different reason and the pin proves nothing — got ${JSON.stringify(out)}`);
        assert.deepEqual(out.facts?.uncovered, [Q],
          `[${arm}] and the facts name EXACTLY the path no bound assignment covers — got ${JSON.stringify(out.facts)}`);
        assert.equal(after.status, 'active', `[${arm}] THE VERDICT-CARRYING ASSERTION: the receipt is still live — a discharge cannot be undone by re-running anything — got ${JSON.stringify(after.status)}`);
        assert.equal(after.disposition, null, `[${arm}] and no disposition was written — got ${JSON.stringify(after.disposition)}`);
      } else {
        assert.equal(r.code, 0, `[${arm}] CONTROL — the superseder WAS spent for P, so a P-territory receipt is legitimately superseded; without this the refusal above is satisfied by "this form refuses everything" — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
        assert.equal(after.status, 'discharged', `[${arm}] got ${JSON.stringify(after.status)}`);
        assert.equal(after.disposition?.class, 'superseded', `[${arm}] got ${JSON.stringify(after.disposition)}`);
      }
    } finally { cleanup(); }
  }
});
