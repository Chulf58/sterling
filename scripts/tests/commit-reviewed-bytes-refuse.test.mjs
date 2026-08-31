// COMMIT-REVIEWED — THE REVIEWED-BYTES **REFUSE** FLIP + `--waive-bytes`
// (campaign slice S2b-2; decision 57984926, slug
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design, §2 —
// which executes the REFUSE-LATER half of user ruling b0ad640d).
//
// SPEC-ONLY, RED-FIRST. Authored from the decision record (opened via
// knowledge_get, §2 quoted below) and the launching brief — NOT from
// scripts/commit-reviewed.mjs's internals. H4 read wall honored: this file's
// author never Read nor content-Grepped that script (nor
// scripts/hooks/lib/review-ledger-entry.mjs); only sibling TEST files were
// read, for fixture conventions.
//
// SPEC UNDER TEST (decision 57984926 §2, verbatim clauses):
//   "a mismatch on any staged/target path the receipt covers REFUSES,
//    aggregated into ONE refusal listing every mismatched receipt+file,
//    nothing consumed; a covered path whose evidence is partial/truncated/
//    inconsistent also refuses; GLOBALLY partial evidence passes when every
//    path THIS commit touches is bound; v1 receipts with usable blobs are
//    ENFORCED (grandfather only genuinely absent evidence — schema absence
//    does not imply blob absence); the no-reliable-intersection free-prose
//    case stays the existing attribution warning, never relabeled a byte
//    mismatch. --waive-bytes '<single-line bounded sanitized reason>' waives
//    per INVOCATION (one commit, one accountable decision), stamping one
//    Review-Bytes-Waiver trailer per affected receipt (entry_id for v2, stable
//    fingerprint for v1), trailers verified after commit/amend like
//    Reviewed-By-Agent; --target-sha gets identical enforcement against the
//    TARGET COMMIT'S TREE."
//   Reviewed-By-Agent stamping, consumption-on-success, foreign/deferred
//   behaviour are UNCHANGED (X0/X1 and the D family pin that).
//
// HARNESS PROVENANCE: git()/makeRepo()/ledgerPath()/writeLedger()/readLedger()/
// stageChange()/runCommitReviewed()/flat/isoAgo are the
// commit-reviewed-spend-warnings.test.mjs idioms (lines 52-120), with the
// commit-reviewed-file-scoping.test.mjs env seam (STERLING_SESSION_ID) folded
// into runCommitReviewed's third argument, and the
// commit-reviewed-target-sha.test.mjs additions (CONFIG + seedConfig(),
// commitPlain(), SEAM_ON = STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM) used only by
// the F (amend-mode) family. Deliberate harness-only deviation: the mkdtemp
// prefix is 'sterling-commit-reviewed-bytes-' so this suite cannot collide with
// its siblings in tmpdir.
//
// TWO FIXTURE CHOICES THAT ARE LOAD-BEARING, NOT COSMETIC:
//  1. EVERY "mismatching" blob value is a REAL git blob sha of DIFFERENT BYTES
//     (`git hash-object --stdin` over the pre-review content), never a
//     placeholder like 'a'.repeat(40). A placeholder is indistinguishable from
//     UNUSABLE evidence — the completed-at suite already pins that non-40-hex
//     and empty blobs read as "NO CONTENT EVIDENCE" — so a placeholder fixture
//     could be grandfathered by clause 3 and the refusal pin would go hollow,
//     passing for the wrong reason or failing for one. Every mismatch fixture
//     here is therefore the REAL "reviewer read v1 of the file, v2 is staged"
//     shape.
//  2. Index and worktree always AGREE (stageChange writes then `git add -A`),
//     so no pin here silently depends on whether the CLI reads the index blob
//     or the worktree blob. That distinction is NOT specified by §2 and is
//     reported as an open question rather than pinned here.

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

// Copied from commit-reviewed-target-sha.test.mjs — only the F family needs it.
const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const SEAM_ON = { STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM: '1' };

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

// Only the --target-sha family seeds a config, mirroring
// commit-reviewed-target-sha.test.mjs; the new-commit families deliberately do
// not, mirroring the spend-warnings/file-scoping harnesses.
function seedConfig(dir) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
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
// "NOTHING consumed / ledger byte-identical after" is asserted on the RAW
// BYTES, not the parsed value — a refusal that rewrites the file with the same
// logical content (reordered keys, reformatted, entries re-serialized) has
// still written to an agent-writable evidence file during a refusal path.
function readLedgerRaw(dir) {
  return existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null;
}

function stageChange(dir, relPath = 'src/feature.mjs', content = 'export const f = 1;\n') {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

// A REAL git blob sha for bytes that are NOT in the tree — the honest
// "these are the bytes the reviewer read" fixture. See header note 1.
function hashBytes(dir, content) {
  const r = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: content, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git hash-object --stdin: ${r.stderr}`);
  const sha = (r.stdout ?? '').trim();
  assert.match(sha, /^[0-9a-f]{40}$/, `fixture guard: hash-object must produce a usable 40-hex sha, got ${sha}`);
  return sha;
}

// The blob sha of a path as it currently sits in the index/worktree (they are
// kept identical throughout this suite — see header note 2).
function stagedBlob(dir, relPath) {
  return git(dir, ['hash-object', relPath]);
}

// Stages `relPath` at `newContent` and returns the blob sha of `oldContent` —
// i.e. "the reviewer read the old bytes, the new bytes are what is staged".
function stageChangedSinceReview(dir, relPath, oldContent, newContent) {
  const reviewedSha = hashBytes(dir, oldContent);
  stageChange(dir, relPath, newContent);
  assert.notEqual(reviewedSha, stagedBlob(dir, relPath), 'fixture guard: the reviewed bytes must genuinely differ from the staged bytes');
  return reviewedSha;
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

// The EXACT read scripts/direct-merge.mjs's receipt gate uses, generalized over
// the trailer key so the waiver trailer is verified the same way §2 requires
// ("trailers verified after commit/amend like Reviewed-By-Agent").
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
const waiverTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Bytes-Waiver', sha);

// THE REFUSAL BLOCK: stderr from the first 'REVIEWED BYTES' anchor onward.
// Positive AND negative naming assertions are made against this slice rather
// than whole stderr, so an unrelated advisory printed BEFORE the refusal can
// never satisfy (or falsify) a naming pin. If an implementation interleaves
// unrelated advisories AFTER the fatal refusal, a red negative assertion here
// is a legitimate question about that output ordering, not a wording nit.
function refusalBlock(stderr) {
  const i = stderr.search(/REVIEWED BYTES/);
  return i === -1 ? '' : stderr.slice(i);
}

// v1 (flat) receipt.
function v1({ agent_type, files, blobs, at = isoAgo(60_000), truncated, truncated_of, reviewed_state = undefined }) {
  const e = { agent_type, files, at, session_id: SESSION, branch: 'main' };
  if (reviewed_state !== undefined) {
    if (reviewed_state !== null) e.reviewed_state = reviewed_state;
    return e;
  }
  e.reviewed_state = { blobs, completed_at: at };
  if (truncated !== undefined) e.reviewed_state.truncated = truncated;
  if (truncated_of !== undefined) e.reviewed_state.truncated_of = truncated_of;
  return e;
}

// v2 (nested) receipt, shape per decision 57984926 §1 and the v2 fixture
// already frozen in commit-reviewed-file-scoping.test.mjs S12.
function v2({
  entry_id,
  agent_type,
  files,
  blobs,
  base_sha,
  status = 'complete',
  absent_paths = [],
  truncated_of = null,
  failure_reason = null,
  at = isoAgo(60_000),
}) {
  return {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status: 'active',
    started_at: at,
    finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: { status, blobs, absent_paths, truncated_of, failure_reason },
    disposition: null,
  };
}

const OLD = 'export const f = 1; // the bytes the reviewer read\n';
const NEW = 'export const f = 2; // the bytes actually staged\n';

// ===========================================================================
// X — UNCHANGED BEHAVIOUR CONTROLS (spec clause 7). PLACED FIRST for the whole
// file: every refusal pin below is the SAME fixture minus a matching blob, so
// a green refusal cannot be explained by "this mode refuses everything" while
// these two are green.
// ===========================================================================

// EXPECTED STATE: GREEN today (matching bytes are today's silent-success path
// as well as tomorrow's).
// SABOTAGE: invert the blob comparison (refuse when the recorded sha EQUALS the
// staged sha) -> exit 1, no trailer, ledger unconsumed -> every assertion red.
// This control carries the verdict for the whole file: without it, an
// unconditional-refuse implementation passes every A/B/C refusal pin.
test('X0 (CONTROL, first): v1 receipt whose recorded blob MATCHES the staged blob — commit succeeds, Reviewed-By-Agent stamped, ledger consumed, no byte refusal', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') } })]);

    const r = runCommitReviewed(dir, ['-m', 'X0 matching bytes']);
    assert.equal(r.code, 0, `matching reviewed bytes must commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'a commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'the Reviewed-By-Agent stamp is untouched by the flip');
    assert.deepEqual(waiverTrailers(dir), [], 'no waiver trailer is stamped when nothing was waived');
    assert.deepEqual(readLedger(dir), [], 'consumption-on-success is untouched by the flip');
    assert.equal(refusalBlock(r.stderr), '', `no byte refusal may be emitted for matching bytes — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: GREEN today (v2 entries already read through the adapter —
// file-scoping S12 pins that; this adds the content_evidence.blobs half).
// SABOTAGE: read v2 content evidence from `reviewed_state.blobs` (the v1 path)
// instead of `content_evidence.blobs` -> the v2 receipt reads as having no
// evidence; harmless here but it makes C1's refusal unreachable, so this
// control + C1 together are what prove the v2 blob path is actually read.
test('X1 (CONTROL): v2 receipt whose content_evidence.blobs MATCHES the staged blob — commit succeeds, stamped, consumed, no byte refusal', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({
        entry_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs'],
        blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') },
        base_sha: base,
      }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'X1 v2 matching bytes']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness']);
    assert.deepEqual(readLedger(dir), [], 'the v2 receipt is consumed');
    assert.equal(refusalBlock(r.stderr), '', `stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// A — MISMATCH REFUSES (clause 1).
// ===========================================================================

// EXPECTED STATE: RED today — today's check is advisory-only, so the CLI exits
// 0 and the very first assertion (`r.code === 1`) fails; the HEAD-unmoved and
// ledger-byte-identical assertions would fail too (today the commit lands and
// the receipt is consumed).
// SABOTAGE: downgrade the mismatch verdict from refusal to warning (emit the
// advisory and continue) -> exit 0, HEAD moves, ledger emptied -> red. That is
// exactly today's behaviour, which is why this pin is red before the flip.
test('A1: a v1 receipt whose recorded blob differs from the staged blob REFUSES — exit 1, no commit, ledger byte-identical, refusal names the receipt and the file', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedSha = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entries = [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedSha } })];
    writeLedger(dir, entries);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'A1 changed since review']);
    assert.equal(r.code, 1, `a covered staged path whose bytes changed must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'NO commit was created');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed — the ledger file is byte-identical after the refusal');

    const block = refusalBlock(r.stderr);
    assert.notEqual(block, '', `the refusal must carry the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
    assert.match(block, /reviewer-correctness/, `the refusal names the receipt — refusal=${flat(block)}`);
    assert.match(block, /src\/laneA\.mjs/, `and the file whose bytes moved — refusal=${flat(block)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (exit 0, both assertions on the aggregated refusal
// unreachable because refusalBlock is empty).
// SABOTAGE (the one this pin exists for): refuse on the FIRST mismatch found
// (return/throw inside the per-receipt loop) instead of collecting all of them
// -> the second receipt/file never appears in the block -> the
// `reviewer-security` and `src/laneB.mjs` assertions go red while `r.code === 1`
// stays green. A single-mismatch fixture cannot see that failure at all, which
// is why this pin uses two receipts mismatching two DIFFERENT files.
// SECOND SABOTAGE (nothing-consumed half): consume the CLEAN receipt before
// evaluating the byte verdict -> the ledger raw-bytes assertion goes red while
// the naming assertions stay green.
test('A2: two receipts each mismatching a DIFFERENT staged file aggregate into ONE refusal naming both — and the third, clean receipt is neither named nor consumed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const reviewedB = stageChangedSinceReview(dir, 'src/laneB.mjs', OLD, NEW);
    stageChange(dir, 'src/laneC.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);

    const entries = [
      v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA } }),
      v1({ agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': reviewedB } }),
      v1({ agent_type: 'reviewer-clean', files: ['src/laneC.mjs'], blobs: { 'src/laneC.mjs': stagedBlob(dir, 'src/laneC.mjs') } }),
    ];
    writeLedger(dir, entries);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'A2 two mismatches']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit was created');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed — not even the clean receipt');

    const block = refusalBlock(r.stderr);
    assert.match(block, /reviewer-correctness/, `the aggregated refusal names the first mismatched receipt — refusal=${flat(block)}`);
    assert.match(block, /src\/laneA\.mjs/, `and its file — refusal=${flat(block)}`);
    assert.match(block, /reviewer-security/, `AND the second mismatched receipt — a refusal that stops at the first mismatch fails here — refusal=${flat(block)}`);
    assert.match(block, /src\/laneB\.mjs/, `and its file — refusal=${flat(block)}`);
    assert.doesNotMatch(block, /reviewer-clean/, `the receipt whose bytes still match must NOT be listed as mismatched — refusal=${flat(block)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (exit 0).
// SABOTAGE: enforce only entries carrying `reviewed_state` (the v1 field name)
// and skip v2 `content_evidence` -> the v2 mismatch is invisible, exit 0 -> red.
// Paired with X1: X1 proves a matching v2 receipt is not refused, so a green
// C1 cannot come from "v2 receipts are always refused".
test('C1: a v2 receipt (content_evidence.status complete) whose recorded blob differs REFUSES, and the refusal identifies the entry', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedSha = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entryId = 'bbbbbbbb-0000-4000-8000-000000000002';
    const entries = [
      v2({ entry_id: entryId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedSha }, base_sha: head }),
    ];
    writeLedger(dir, entries);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'C1 v2 mismatch']);
    assert.equal(r.code, 1, `a v2 blob mismatch must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');

    const block = refusalBlock(r.stderr);
    assert.match(block, /src\/laneA\.mjs/, `the refusal names the file — refusal=${flat(block)}`);
    assert.ok(
      block.includes(entryId) || /reviewer-correctness/.test(block),
      `the refusal must IDENTIFY the offending v2 receipt — by entry_id or by reviewer agent_type — refusal=${flat(block)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// B — PARTIAL / TRUNCATED EVIDENCE (clause 2, both halves).
// ===========================================================================

// EXPECTED STATE: GREEN today (advisory-only posture commits everything) — but
// it is the CONTROL that must stay green AFTER the flip, and it must pass for
// the OPPOSITE reason to B1: globally-partial evidence is fine because every
// path THIS commit touches is bound and matching.
// SABOTAGE: treat `truncated:true` as a whole-receipt refusal regardless of
// which paths are bound -> exit 1 -> red. That sabotage is the over-broad
// reading of clause 2 this control exists to forbid.
test('B0 (CONTROL): GLOBALLY partial evidence (truncated:true) still COMMITS when every path this commit touches is bound with a matching sha', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const entries = [
      v1({
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs', 'src/base.mjs'],
        blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') }, // src/base.mjs UNBOUND, but it is not staged
        truncated: true,
        truncated_of: 2,
      }),
    ];
    writeLedger(dir, entries);

    const r = runCommitReviewed(dir, ['-m', 'B0 globally partial, locally complete']);
    assert.equal(r.code, 0, `partial-but-sufficient evidence must NOT refuse — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'and it is stamped normally');
    assert.deepEqual(readLedger(dir), [], 'and consumed normally');
    assert.equal(refusalBlock(r.stderr), '', `no byte refusal — the unbound path is not one this commit touches — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (exit 0; today an unbound covered path is at most a
// content-evidence advisory).
// SABOTAGE: compare only the paths PRESENT in blobs (iterate the blobs map)
// instead of iterating the staged paths the receipt COVERS -> an unbound staged
// path is silently skipped, exit 0 -> red. This is the single most likely
// implementation shortcut and no other pin in this file catches it: A1/A2/C1
// all bind the offending path.
test('B1: a v1 truncated receipt whose UNBOUND declared file is staged REFUSES — evidence that does not cover this commit is not evidence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW); // staged, DECLARED by the receipt, but NOT in blobs
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entries = [
      v1({
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs', 'src/base.mjs'],
        blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, // bound+matching, but the WRONG path
        truncated: true,
        truncated_of: 2,
      }),
    ];
    writeLedger(dir, entries);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'B1 truncated, staged path unbound']);
    assert.equal(r.code, 1, `a covered staged path with NO usable evidence, on a receipt that admits truncation, must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    assert.match(refusalBlock(r.stderr), /src\/laneA\.mjs/, `the refusal names the unbound staged path — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (exit 0).
// SABOTAGE: read only `reviewed_state.truncated` and never
// `content_evidence.status === 'partial'` -> the v2 partial receipt is treated
// as complete, its unbound staged path is skipped, exit 0 -> red.
test('B2: a v2 receipt with content_evidence.status "partial" whose UNBOUND declared file is staged REFUSES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entries = [
      v2({
        entry_id: 'cccccccc-0000-4000-8000-000000000003',
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs', 'src/base.mjs'],
        blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') },
        base_sha: head,
        status: 'partial',
        truncated_of: 2,
      }),
    ];
    writeLedger(dir, entries);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'B2 v2 partial, staged path unbound']);
    assert.equal(r.code, 1, `content_evidence.status 'partial' over an unbound staged path must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    assert.match(refusalBlock(r.stderr), /src\/laneA\.mjs/, `stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// C — GRANDFATHERING (clause 3): ONLY genuinely absent evidence.
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the flip (the warning posture is
// explicitly unchanged for this class). This is the control that proves a green
// A1/B1/C1 is not "the flip refuses every receipt it cannot verify".
// SABOTAGE: refuse whenever a covered staged path has no recorded blob,
// WITHOUT first checking that the receipt records evidence at all -> the
// legacy no-evidence receipt refuses -> red. That sabotage is precisely the
// over-broad flip clause 3 forbids, and it would brick every pre-flip receipt
// still sitting in a live ledger.
test('C0 (CONTROL): a v1 receipt with NO reviewed_state at all, whose staged file changed, STILL COMMITS — genuinely absent evidence is grandfathered, warning posture unchanged', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [{ agent_type: 'reviewer-legacy', files: ['src/laneA.mjs'], at: isoAgo(60_000), session_id: SESSION, branch: 'main' }]);

    const r = runCommitReviewed(dir, ['-m', 'C0 legacy receipt, no reviewed_state']);
    assert.equal(r.code, 0, `a receipt with no content evidence at all must NOT be refused — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-legacy'], 'and stamped as before');
    assert.deepEqual(readLedger(dir), [], 'and consumed as before');
    assert.deepEqual(waiverTrailers(dir), [], 'no waiver was involved — nothing was waived');
  } finally {
    cleanup();
  }
});

// AMBIGUITY PIN (reported, NOT resolved here) — §2 says "grandfather only
// genuinely absent evidence — schema absence does not imply blob absence", and
// separately that "inconsistent" evidence refuses. A receipt that RECORDS a
// blob for the staged path but whose value is UNUSABLE ('not-a-sha' — the
// completed-at suite pins that shape as "NO CONTENT EVIDENCE") sits between the
// two clauses and §2 does not say which wins. So this pin asserts only the
// invariant that holds under EITHER reading (the pattern
// commit-reviewed-file-scoping.test.mjs S13 uses for its exit-code ambiguity):
// the CLI must not crash, and must not SILENTLY treat the unusable value as
// verified evidence — either it refuses and consumes nothing, or it commits
// and says something about the missing evidence.
// SABOTAGE: pass a non-40-hex blob value through the comparison as if usable
// (drop the usable-sha filter) -> the string never equals a real sha, so the
// commit refuses with NO disclosure that the evidence was unusable; under the
// commit branch the advisory disappears -> the disclosure assertion goes red.
test('C2 (AMBIGUITY, either reading): a v1 receipt recording an UNUSABLE blob value for the staged path is never silently accepted as verified — refuse+preserve, or commit+disclose', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entries = [v1({ agent_type: 'reviewer-unusable', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': 'not-a-sha' } })];
    writeLedger(dir, entries);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'C2 unusable blob value']);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `an unusable blob value must never crash the CLI — stderr=${flat(r.stderr)}`);
    if (r.code === 0) {
      assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'if it commits, the commit really happened');
      assert.match(
        r.stderr,
        /NO CONTENT EVIDENCE|REVIEWED BYTES/,
        `if the unusable value is grandfathered, the missing evidence must still be DISCLOSED — stderr=${flat(r.stderr)}`
      );
    } else {
      assert.equal(r.code, 1, `a refusal is exit 1, never another code — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'if it refuses, no commit was created');
      assert.equal(readLedgerRaw(dir), before, 'and nothing was consumed');
      assert.notEqual(refusalBlock(r.stderr), '', `and the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
    }
  } finally {
    cleanup();
  }
});

// AMBIGUITY PIN (reported, NOT resolved here) — v2 content_evidence.status
// 'unavailable' with a failure_reason is the v2 spelling of "the hashing never
// ran". Clause 3 grandfathers "genuinely absent evidence" but names only the v1
// no-reviewed_state case; clause 2 refuses "partial/truncated/inconsistent" and
// does not name 'unavailable'. Same either-reading invariant as C2.
// SABOTAGE: treat 'unavailable' as 'complete' with an empty blob map -> the
// staged path compares against nothing, the run neither refuses NOR discloses
// -> the disclosure assertion in the exit-0 branch goes red.
test('C3 (AMBIGUITY, either reading): a v2 receipt with content_evidence.status "unavailable" is never silently accepted as verified — refuse+preserve, or commit+disclose', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entries = [
      v2({
        entry_id: 'dddddddd-0000-4000-8000-000000000004',
        agent_type: 'reviewer-unavailable',
        files: ['src/laneA.mjs'],
        blobs: {},
        base_sha: head,
        status: 'unavailable',
        failure_reason: 'hashing did not run',
      }),
    ];
    writeLedger(dir, entries);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'C3 v2 unavailable evidence']);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `stderr=${flat(r.stderr)}`);
    if (r.code === 0) {
      assert.match(
        r.stderr,
        /NO CONTENT EVIDENCE|REVIEWED BYTES/,
        `if 'unavailable' is grandfathered, the absence must still be DISCLOSED — stderr=${flat(r.stderr)}`
      );
    } else {
      assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
      assert.equal(readLedgerRaw(dir), before, 'nothing consumed');
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// D — THE FLIP NEVER WIDENS PAST THE PATHS THIS COMMIT TOUCHES (clause 4).
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the flip.
// SABOTAGE: evaluate the byte check over the receipt's DECLARED files instead
// of over the staged paths it covers -> the free-prose receipt's stale blob for
// src/elsewhere.mjs turns into a refusal, exit 1 -> red. That is the exact
// mis-scoping clause 4 forbids ("never relabeled a byte mismatch"), and it
// would brick the fallback the file-scoping suite's S5 calls the entire safety
// argument for shipping on the merge-gate surface.
test('D1: the no-reliable-intersection FALLBACK stays a WARNING — a receipt that overlaps nothing staged, carrying a stale blob for its own territory, still commits and is stamped', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    // src/elsewhere.mjs exists in the tree and HAS moved since the review, but
    // it is not staged; only src/feature.mjs is.
    stageChange(dir, 'src/elsewhere.mjs', OLD);
    git(dir, ['commit', '-m', 'elsewhere at the reviewed bytes']);
    const reviewedElsewhere = stagedBlob(dir, 'src/elsewhere.mjs');
    stageChange(dir, 'src/elsewhere.mjs', NEW);
    git(dir, ['commit', '-m', 'elsewhere moved on']);
    stageChange(dir, 'src/feature.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [v1({ agent_type: 'reviewer-freeprose', files: ['src/elsewhere.mjs'], blobs: { 'src/elsewhere.mjs': reviewedElsewhere } })]);

    const r = runCommitReviewed(dir, ['-m', 'D1 fallback stays advisory']);
    assert.equal(r.code, 0, `a receipt covering NO staged path must never produce a byte refusal — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created via the existing fallback');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-freeprose'], 'the fallback still stamps exactly as before');
    assert.deepEqual(readLedger(dir), [], 'and still consumes');
    assert.match(r.stderr, /RECEIPT FILES DO NOT OVERLAP THIS DIFF/, `the pre-existing attribution advisory still speaks — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /ADVISORY ONLY/, `and still marks itself advisory — stderr=${flat(r.stderr)}`);
    assert.deepEqual(waiverTrailers(dir), [], 'and no waiver trailer is invented');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: GREEN today AND after the flip.
// SABOTAGE: run the byte check over ALL eligible receipts rather than the
// STAMPED CANDIDATES -> the deferred lane B receipt's stale blob refuses a
// commit that never touches lane B, exit 1 -> red. Distinct from D1's sabotage:
// D1 mis-scopes WITHIN a receipt (declared vs staged paths), D2 mis-scopes
// ACROSS receipts (eligible vs stamped-candidate) — one guard does not cover
// the other, which is why both arms exist.
test('D2: a DEFERRED receipt (its territory is not staged) carrying a stale blob does not refuse the commit — it survives un-consumed exactly as file-scoping pins', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneB.mjs', OLD);
    git(dir, ['commit', '-m', 'lane B at the reviewed bytes']);
    const reviewedB = stagedBlob(dir, 'src/laneB.mjs');
    stageChange(dir, 'src/laneB.mjs', NEW);
    git(dir, ['commit', '-m', 'lane B moved on']);
    stageChange(dir, 'src/laneA.mjs', NEW);

    const deferred = v1({ agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': reviewedB } });
    writeLedger(dir, [
      v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') } }),
      deferred,
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D2 deferred receipt with stale bytes']);
    assert.equal(r.code, 0, `a deferred receipt's bytes are not this commit's business — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'only the matching receipt is stamped');
    assert.deepEqual(readLedger(dir), [deferred], 'and the deferred one survives byte-identical');
    assert.equal(refusalBlock(r.stderr), '', `no byte refusal — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// E — --waive-bytes (clause 5).
// ===========================================================================

// EXPECTED STATE: RED today — today's CLI does not know the flag; it either
// refuses it as unrecognized (exit != 0, first assertion red) or ignores it.
// THIS IS ALSO THE CONTROL FOR E2a/E2b/E2c: those three assert that a BAD
// reason refuses, and an implementation that simply rejects the whole flag
// would satisfy them for the wrong reason. E0 green + E2* green together are
// what prove the refusals come from the REASON, not from the FLAG.
// SABOTAGE: stamp a Review-Bytes-Waiver trailer for every stamped receipt
// whenever --waive-bytes is present, rather than only for AFFECTED ones -> the
// zero-trailers assertion goes red.
test('E0 (CONTROL): --waive-bytes with NO byte mismatch present commits normally and stamps ZERO Review-Bytes-Waiver trailers — no spurious waivers', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') } })]);

    const r = runCommitReviewed(dir, ['-m', 'E0 waiver with nothing to waive', '--waive-bytes', 'belt and braces, nothing actually mismatched']);
    assert.equal(r.code, 0, `a waiver flag with nothing to waive must be accepted, not refused — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'the ordinary stamp is unaffected');
    assert.deepEqual(waiverTrailers(dir), [], 'and NOT ONE waiver trailer is stamped — a waiver trailer is evidence of an accountable override, never decoration');
    assert.deepEqual(readLedger(dir), [], 'consumed normally');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the flag is unknown; with two mismatches present
// today's advisory-only run would commit but stamp no waiver trailers, so the
// `waivers.length === 2` assertion is red even in the most forgiving reading).
// SABOTAGE (per-invocation half): stamp ONE waiver trailer per invocation
// instead of one per affected receipt -> length 1, red.
// SABOTAGE (affected-only half): stamp one per STAMPED receipt -> length 3 and
// 'reviewer-clean' appears, red.
// SABOTAGE (identity half): put the reason (or the agent_type) in the trailer
// value instead of the entry_id for a v2 receipt -> the entry_id assertion red.
test('E1: --waive-bytes waives the WHOLE INVOCATION — the commit succeeds, every receipt is stamped and consumed, and exactly one Review-Bytes-Waiver trailer per AFFECTED receipt carries its identity', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const reviewedB = stageChangedSinceReview(dir, 'src/laneB.mjs', OLD, NEW);
    stageChange(dir, 'src/laneC.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entryId = 'eeeeeeee-0000-4000-8000-000000000005';

    writeLedger(dir, [
      v2({ entry_id: entryId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA }, base_sha: head }),
      v1({ agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': reviewedB } }),
      v1({ agent_type: 'reviewer-clean', files: ['src/laneC.mjs'], blobs: { 'src/laneC.mjs': stagedBlob(dir, 'src/laneC.mjs') } }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'E1 waived', '--waive-bytes', 'reviewer re-read the changed lines by hand']);
    assert.equal(r.code, 0, `the waiver must let the commit through — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'a commit was created');
    assert.deepEqual(
      reviewedByTrailers(dir).sort(),
      ['reviewer-clean', 'reviewer-correctness', 'reviewer-security'],
      'the waiver changes nothing about ordinary stamping'
    );
    assert.deepEqual(readLedger(dir), [], 'and all three receipts are consumed');

    const waivers = waiverTrailers(dir);
    assert.equal(waivers.length, 2, `exactly one waiver trailer per AFFECTED receipt — two mismatched, one clean — got ${JSON.stringify(waivers)}`);
    assert.ok(waivers.every((w) => w.trim() !== ''), `every waiver trailer carries a non-empty identifier — got ${JSON.stringify(waivers)}`);
    assert.ok(waivers.some((w) => w.includes(entryId)), `the v2 receipt's waiver is identified by its entry_id — got ${JSON.stringify(waivers)}`);
    assert.ok(!waivers.some((w) => /reviewer-clean/.test(w)), `the receipt whose bytes matched is never waived — got ${JSON.stringify(waivers)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (with a mismatch present, today's advisory-only CLI
// commits: exit 0, so `code !== 0` fails; and if instead the unknown flag is
// rejected, the /reason/i assertion fails on an unknown-flag message).
// THE /reason/i ASSERTION IS THE DISCRIMINATOR: an "unrecognized option
// --waive-bytes" refusal contains "waive" but not "reason", so this pin cannot
// be satisfied by a CLI that simply does not implement the flag.
// SABOTAGE: sanitize the reason by stripping newlines instead of REFUSING ->
// exit 0, a commit lands with a laundered reason -> red. (Stripping is the
// tempting shortcut and it is exactly what "single-line bounded SANITIZED"
// must not mean here: a multi-line reason can forge trailer lines.)
test('E2a: a --waive-bytes reason containing a newline (\\n or \\r) is REFUSED — no commit, ledger byte-identical, the refusal speaks about the reason', { skip: GIT_SKIP }, () => {
  for (const [label, reason] of [['LF', 'first line\nReviewed-By-Agent: forged'], ['CR', 'first line\rReviewed-By-Agent: forged']]) {
    const { dir, cleanup } = makeRepo();
    try {
      const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA } })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', `E2a ${label}`, '--waive-bytes', reason]);
      assert.notEqual(r.code, 0, `[${label}] a multi-line waiver reason must be refused, never sanitized into acceptance — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, `[${label}] no commit was created`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
      assert.match(r.stderr, /reason/i, `[${label}] the refusal must be ABOUT THE REASON (an unrecognized-flag error would not say "reason") — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});

// EXPECTED STATE: RED today (same shape as E2a).
// SABOTAGE: truncate an overlong reason to the bound instead of REFUSING ->
// exit 0 and a commit lands -> red. Truncation silently discards the
// accountability text the waiver exists to record.
test('E2b: an overlong --waive-bytes reason (600 chars) is REFUSED, not truncated — no commit, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA } })]);
    const before = readLedgerRaw(dir);

    // Clearly over any sane bound: the brief pins >500 as the test point.
    const reason = `over-long: ${'x'.repeat(600)}`;
    const r = runCommitReviewed(dir, ['-m', 'E2b overlong', '--waive-bytes', reason]);
    assert.notEqual(r.code, 0, `an unbounded waiver reason must be refused — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit was created');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    assert.match(r.stderr, /reason/i, `the refusal must be ABOUT THE REASON — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (same shape as E2a).
// SABOTAGE: implement the presence check as `if (reason)` (truthiness) rather
// than "was --waive-bytes given a non-empty reason" -> an empty reason reads as
// "no waiver requested", the byte refusal fires for the ORIGINAL reason, and
// the /reason/i assertion goes red while `code !== 0` stays green. That is the
// hollow shape this arm exists to catch: the same exit code for a different
// cause. (Mirrors CONTRADICTION-b in the --target-sha suite.)
test('E2c: an EMPTY --waive-bytes reason ("") is REFUSED as a reason defect — not silently treated as "no waiver requested"', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA } })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'E2c empty reason', '--waive-bytes', '']);
    assert.notEqual(r.code, 0, `an empty waiver reason must be refused — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit was created');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    assert.match(r.stderr, /reason/i, `the refusal must name the REASON defect, not fall through to the byte refusal — stderr=${flat(r.stderr)}`);
    assert.deepEqual(waiverTrailers(dir, head), [], 'and nothing was stamped anywhere');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (no waiver trailers exist at all, so both runs
// produce empty arrays and the length assertion fires first).
// ASSUMPTION, DISCLOSED: §2 says "a stable fingerprint for v1" without defining
// it. This pin reads "stable" as DETERMINISTIC GIVEN THE RECEIPT — two
// byte-identical v1 receipts waived over byte-identical staged content produce
// the SAME fingerprint. If an implementation derives the fingerprint from the
// commit sha, the invocation time, or a fresh uuid, this goes red — and that is
// a spec question for the conductor, not a wording nit: a per-invocation random
// value is not a fingerprint of anything and cannot identify which receipt was
// waived.
// SABOTAGE: mint the v1 fingerprint with randomUUID() (or hash the new commit
// sha) -> the two runs disagree -> red, while E1's count/entry_id assertions all
// stay green. E1 cannot see this class at all.
test('E3: the v1 waiver fingerprint is STABLE — two byte-identical receipts waived over identical content yield the identical fingerprint', { skip: GIT_SKIP }, () => {
  const fingerprints = [];
  for (const label of ['run-1', 'run-2']) {
    const { dir, cleanup } = makeRepo();
    try {
      const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
      // Every field a literal, so the two receipts are byte-identical.
      writeLedger(dir, [
        {
          agent_type: 'reviewer-correctness',
          files: ['src/laneA.mjs'],
          at: '2026-08-31T09:00:00.000Z',
          session_id: SESSION,
          branch: 'main',
          base_sha: 'f'.repeat(40),
          reviewed_state: { blobs: { 'src/laneA.mjs': reviewedA }, completed_at: '2026-08-31T09:00:00.000Z' },
        },
      ]);

      const r = runCommitReviewed(dir, ['-m', `E3 ${label}`, '--waive-bytes', 'stable fingerprint probe']);
      assert.equal(r.code, 0, `[${label}] the waived commit must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      const waivers = waiverTrailers(dir);
      assert.equal(waivers.length, 1, `[${label}] exactly one waiver trailer for the one affected v1 receipt — got ${JSON.stringify(waivers)}`);
      fingerprints.push(waivers[0]);
    } finally {
      cleanup();
    }
  }
  assert.equal(
    fingerprints[0],
    fingerprints[1],
    `a v1 waiver fingerprint must be derived from the RECEIPT, so identical receipts fingerprint identically — got ${JSON.stringify(fingerprints)}`
  );
});

// ===========================================================================
// F — --target-sha AMEND MODE GETS IDENTICAL ENFORCEMENT, MEASURED AGAINST THE
// TARGET COMMIT'S TREE (clause 6).
// NOTE ON WHAT IS AND IS NOT TESTABLE HERE: amend mode already refuses a dirty
// index or worktree (the --target-sha suite's G2a/G2b), so the target commit's
// tree and the worktree are necessarily identical during a legal amend. That
// means no fixture can distinguish "compared against `git ls-tree`" from
// "compared against the worktree" — these arms pin the VERDICT, not the read
// mechanism, and that limit is reported rather than papered over.
// ===========================================================================

// Creates a real commit via PLAIN `git commit` and returns its sha (idiom from
// commit-reviewed-target-sha.test.mjs).
function commitPlain(dir, message, relPath, content) {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}
// The blob sha of a path as it sits in a COMMIT'S TREE — the measurement clause
// 6 names (`git ls-tree` semantics; `rev-parse <sha>:<path>` is the same read).
const treeBlob = (dir, sha, relPath) => git(dir, ['rev-parse', `${sha}:${relPath}`]);

// EXPECTED STATE: GREEN once --target-sha amend mode is live (it is pinned by
// commit-reviewed-target-sha.test.mjs), and it is the CONTROL for F1: identical
// fixture, matching blob, opposite verdict.
// SABOTAGE: compare the receipt's blob against the target commit's PARENT tree
// instead of the target tree -> a legitimately-reviewed amend refuses -> red.
test('F0 (CONTROL): --target-sha amend whose receipt blob MATCHES the blob in the TARGET COMMIT\'S TREE amends normally — stamped, consumed, no waiver trailer', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    seedConfig(dir);
    const targetSha = commitPlain(dir, 'reviewed change', 'src/reviewed.mjs', NEW);
    writeLedger(dir, [
      v1({ agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') } }),
    ].map((e) => ({ ...e, base_sha: targetSha })));

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], { ...ENV_SESSION, ...SEAM_ON });
    assert.equal(r.code, 0, `a matching amend must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), targetSha, 'the commit was amended');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'stamped exactly as the amend suite pins');
    assert.deepEqual(waiverTrailers(dir), [], 'no waiver trailer where nothing was waived');
    assert.deepEqual(readLedger(dir), [], 'the receipt is consumed');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the byte check is advisory in every mode, so the
// amend succeeds and `r.code === 1` fails).
// SABOTAGE: apply the byte enforcement only on the staged-diff path and skip it
// entirely in amend mode (an `if (!targetSha)` guard around the check) -> the
// amend goes through, exit 0, HEAD moves -> red. That guard is invisible to
// every A/B/C pin above, which all run in new-commit mode.
test('F1: --target-sha amend whose receipt blob DIFFERS from the blob in the target commit\'s tree REFUSES — exit 1, nothing amended, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    seedConfig(dir);
    const targetSha = commitPlain(dir, 'reviewed change', 'src/reviewed.mjs', NEW);
    const reviewedSha = hashBytes(dir, OLD); // a REAL blob sha for bytes that are not in the target tree
    assert.notEqual(reviewedSha, treeBlob(dir, targetSha, 'src/reviewed.mjs'), 'fixture guard: the recorded bytes really differ from the target tree');

    const entries = [
      { ...v1({ agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': reviewedSha } }), base_sha: targetSha },
    ];
    writeLedger(dir, entries);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], { ...ENV_SESSION, ...SEAM_ON });
    assert.equal(r.code, 1, `amend mode gets IDENTICAL enforcement — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'NOTHING was amended');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');

    const block = refusalBlock(r.stderr);
    assert.notEqual(block, '', `the refusal carries the REVIEWED BYTES anchor in amend mode too — stderr=${flat(r.stderr)}`);
    assert.match(block, /src\/reviewed\.mjs/, `and names the file — refusal=${flat(block)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today.
// SABOTAGE: accept --waive-bytes only on the new-commit path and ignore it in
// amend mode -> the amend refuses despite the waiver, exit 1 -> red.
test('F2: --target-sha amend + --waive-bytes over a byte mismatch AMENDS and carries the waiver trailer beside Reviewed-By-Agent', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    seedConfig(dir);
    const targetSha = commitPlain(dir, 'reviewed change', 'src/reviewed.mjs', NEW);
    const reviewedSha = hashBytes(dir, OLD);
    writeLedger(dir, [
      { ...v1({ agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': reviewedSha } }), base_sha: targetSha },
    ]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--waive-bytes', 'post-hoc review re-read the amended file'], { ...ENV_SESSION, ...SEAM_ON });
    assert.equal(r.code, 0, `the waiver must work in amend mode too — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const newSha = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(newSha, targetSha, 'the commit was amended');
    assert.deepEqual(reviewedByTrailers(dir, newSha), ['reviewer-correctness'], 'the ordinary stamp is present');

    const waivers = waiverTrailers(dir, newSha);
    assert.equal(waivers.length, 1, `exactly one waiver trailer for the one affected receipt — got ${JSON.stringify(waivers)}`);
    assert.ok(waivers[0].trim() !== '', `and it carries a non-empty identifier — got ${JSON.stringify(waivers)}`);
    assert.deepEqual(readLedger(dir), [], 'the waived receipt is consumed');
  } finally {
    cleanup();
  }
});
