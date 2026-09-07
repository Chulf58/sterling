// COMMIT-REVIEWED — `--target-sha` AMEND MODE (R1 pin re-cut, group D).
//
// AUTHORITY: decision `post-hoc-review-receipts-target-sha-amend` (knowledge_get a899d6cc)
// and contract sheet §6 A9, which keeps that contract whole and names its codes:
// `target_sha_unresolvable`, `target_sha_not_head`, `target_sha_tree_dirty`,
// `target_sha_published`, `target_sha_publication_unprovable`. Eligible receipts are those
// whose `identity.base_sha` === the TARGET sha; territory is the target commit's OWN
// diff-tree; the byte rule runs against the TARGET COMMIT'S TREE; then
// `git commit --amend --no-edit` adds the trailers and finalize consumes with the NEW sha.
//
// RETIRED: the `doesNotMatch(/-m|message/i)` discriminator used throughout the old file — it
//   existed only because --target-sha did not exist yet and every refusal fell through to the
//   missing-message path; each refusal now asserts its own [code].
// RETIRED: G7 CONTROL-A / CONTROL-B (the plain -m path still works) — pinned in
//   commit-reviewed.test.mjs R1-D08 and R1-D01.
// RETIRED: CONTRADICTION-a / CONTRADICTION-b — folded into commit-reviewed.test.mjs R1-D05,
//   which covers both the real and the empty message with the [argument_invalid] code.
// RETIRED: G4a (a receipt with files:[] is always stamped in amend mode) — an empty territory
//   covers nothing (commit-reviewed-file-scoping.test.mjs R1-D16); amend mode inherits that.
// RETIRED: the `tip` / `base_sha` / `deferred` prose assertions — converted to [code] tokens.
// ADOPTED FROM OTHER FILES (their amend halves live here now): the byte rule against the
//   target tree (was commit-reviewed-bytes-refuse F0/F1/F2) and the trailer-preservation /
//   duplicate-trailer pins (was commit-reviewed-bytes-refuse-hardening H5-0/H5a).
// ADDED BY SHEET AMENDMENT A13: the amend RE-BINDS every receipt already consumed for the OLD
//   sha to the NEW one in the same finalize (R1-D98), and refuses
//   [target_sha_prior_receipt_unbound] BEFORE amending when a preserved Review-Receipt trailer
//   names a receipt the ledger cannot account for (R1-D99).

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

const token = (c) => new RegExp('\\[' + c + '\\]');
const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const SEAM_ON = { ...ENV_SESSION, STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM: '1' };
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
function makeBareRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-target-sha-bare-'));
  git(dir, ['init', '--bare', '-b', 'main']);
  return dir;
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
function commitPlain(dir, message, relPath = 'src/reviewed.mjs', content = 'export const reviewed = 1;\n') {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}
// `--cleanup=verbatim` on the ORIGINAL commit too, so git's own commit-time cleanup cannot
// destroy the fixture before the amend's fidelity is what is being measured.
function commitPlainVerbatim(dir, message, relPath = 'src/reviewed.mjs', content = 'export const reviewed = 1;\n') {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '--cleanup=verbatim', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}
// `git log --format=%B` adds exactly ONE trailing newline of its own; only that artifact is
// stripped, because every OTHER edge newline is the fidelity under test.
function commitBodyRaw(dir, sha = 'HEAD') {
  const r = spawnSync('git', ['log', '-1', '--format=%B', sha], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git log %B ${sha}: ${r.stderr}`);
  let out = r.stdout;
  if (out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}
// The blob of a path as it sits in a COMMIT'S TREE — the measurement A9 names for amend mode.
const treeBlob = (dir, sha, relPath) => git(dir, ['rev-parse', `${sha}:${relPath}`]);
function hashBytes(dir, content) {
  const r = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: content, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git hash-object --stdin: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function runCommitReviewed(dir, args = [], env = SEAM_ON) {
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
const waiverTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Bytes-Waiver', sha);
function soleJson(r) {
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); },
    `--json must print exactly ONE JSON object on stdout — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
  return parsed;
}

function v2({ entry_id, agent_type, files, blobs = {}, base_sha, at = isoAgo(60_000) }) {
  return {
    schema_version: 2, entry_id, kind: 'roster_receipt', status: 'active',
    started_at: at, finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id: SESSION, branch: 'main', base_sha, agent_id: `agent-${entry_id.slice(0, 8)}` },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: {
      basis: 'stop-time-worktree-snapshot', status: 'complete', blobs,
      absent_paths: [], truncated_of: null, failure_reason: null,
    },
    disposition: null,
  };
}

// A deliberately awkward original body: a genuine DOUBLE blank line (git's default "strip"
// cleanup collapses these) and a "Key: value"-shaped line in a NON-final paragraph (which must
// survive as ordinary text, never be read as a trailer).
const MULTI_PARAGRAPH_BODY =
  'Reviewed feature, multi-paragraph message\n\nKey: value\nSecond line of paragraph two.\n\n\nClosing paragraph with more detail, not a trailer.';

// ===========================================================================
// R1-D90 — THE HAPPY PATH, PLACED FIRST. Every refusal below is this setup minus
// exactly one guard, so no refusal verdict is attributable without it.
// ===========================================================================

// EXPECTED: RED today on the Review-Receipt trailer and the consumed-status assertions; the
// message-fidelity and tree/parent halves already hold.
// SABOTAGE (message fidelity): rebuild the message through git's default "strip" cleanup
// instead of `--cleanup=verbatim -F -` -> the double blank line collapses -> only the %B
// equality assertion reds, a hollowness a subject-line-only check could never catch.
// SABOTAGE (tree/parent): rebuild via a fresh `git commit` rather than `--amend` -> the
// tree/parent equality assertions red.
// SABOTAGE (the binding): finalize with the OLD sha -> the consumption assertion reds while
// everything else stays green; a receipt bound to a sha that no longer exists is exactly the
// unbound attestation direct-merge is built to refuse.
test('R1-D90 (HAPPY, first): tip sha, clean tree, matching base_sha, seam ON — amends in place, message byte-faithful, one roster + one Review-Receipt trailer, tree and parent unchanged, both shas reported, receipt consumed with the NEW sha', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const originalSha = commitPlainVerbatim(dir, MULTI_PARAGRAPH_BODY, 'src/laneA.mjs');
    const id = '90000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': treeBlob(dir, originalSha, 'src/laneA.mjs') }, base_sha: originalSha })]);

    const r = runCommitReviewed(dir, ['--target-sha', originalSha]);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    const newSha = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(newSha, originalSha, 'the commit was amended');

    assert.equal(commitBodyRaw(dir, newSha),
      `${MULTI_PARAGRAPH_BODY}\n\nReviewed-By-Agent: reviewer-correctness\nReview-Receipt: ${id}`,
      'the amended body is byte-identical to the original plus exactly the appended trailer block');
    assert.deepEqual(reviewedByTrailers(dir, newSha), ['reviewer-correctness']);
    assert.deepEqual(receiptTrailers(dir, newSha), [id]);
    assert.equal(git(dir, ['rev-parse', `${newSha}^{tree}`]), git(dir, ['rev-parse', `${originalSha}^{tree}`]), 'IDENTICAL tree — the amend touches only the message');
    assert.equal(git(dir, ['rev-parse', `${newSha}^`]), git(dir, ['rev-parse', `${originalSha}^`]), 'IDENTICAL parent');
    const combined = `${r.stdout}\n${r.stderr}`;
    assert.match(combined, new RegExp(originalSha), 'the OLD sha is reported');
    assert.match(combined, new RegExp(newSha), 'and the NEW one');
    assert.equal(entryById(dir, id).consumption?.commit_sha, newSha, 'the receipt is consumed against the NEW sha, which is the one that exists');
  } finally { cleanup(); }
});

// EXPECTED: RED today — the codes do not exist; today's refusals are prose.
// SABOTAGE (unresolvable): accept any 40-hex string without resolving it -> git fails later
// with an opaque error and no code -> red.
// SABOTAGE (not-head): only require the sha to be reachable from HEAD -> HEAD~1 is accepted,
// descendants are rewritten, HEAD moves -> the HEAD-unmoved assertion reds. Tip-only is what
// keeps the blast radius to one commit.
test('R1-D91: an unresolvable --target-sha refuses [target_sha_unresolvable] and a NON-TIP sha refuses [target_sha_not_head] — nothing amended, ledger byte-identical', { skip: GIT_SKIP }, () => {
  for (const [label, pick, code] of [
    ['unresolvable', () => 'f'.repeat(40), 'target_sha_unresolvable'],
    ['non-tip', (d) => git(d, ['rev-parse', 'HEAD~1']), 'target_sha_not_head'],
  ]) {
    const { dir, cleanup } = makeRepo();
    try {
      const firstSha = commitPlain(dir, 'first reviewed change', 'src/first.mjs');
      const tipSha = commitPlain(dir, 'second change on top', 'src/second.mjs');
      writeLedger(dir, [v2({ entry_id: '91000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/first.mjs'], blobs: { 'src/first.mjs': treeBlob(dir, firstSha, 'src/first.mjs') }, base_sha: firstSha })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['--target-sha', pick(dir), '--json']);
      assert.equal(r.code, 1, `[${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(soleJson(r).code, code, `[${label}] got ${flat(r.stdout)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), tipSha, `[${label}] HEAD is unmoved`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
    } finally { cleanup(); }
  }
});

// EXPECTED: RED today — the code does not exist.
// SABOTAGE (index half): check only `git diff` (the worktree) -> the dirty-index arm is
// allowed through and the amend silently changes the reviewed tree -> that arm reds.
// SABOTAGE (worktree half): check only `git diff --cached` -> the other arm reds. The two
// arms are what make the halves distinguishable; either check alone passes one of them.
test('R1-D92: a dirty INDEX and a dirty WORKTREE each refuse [target_sha_tree_dirty] — the amend must not be able to change the reviewed tree', { skip: GIT_SKIP }, () => {
  for (const label of ['dirty-index', 'dirty-worktree']) {
    const { dir, cleanup } = makeRepo();
    try {
      const targetSha = commitPlain(dir, 'reviewed, then dirtied');
      if (label === 'dirty-index') stageChange(dir, 'src/uncommitted.mjs', 'export const oops = 1;\n');
      else writeFileSync(join(dir, 'src', 'reviewed.mjs'), 'export const reviewed = 2; // unstaged edit\n');
      writeLedger(dir, [v2({ entry_id: '92000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') }, base_sha: targetSha })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json']);
      assert.equal(r.code, 1, `[${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(soleJson(r).code, 'target_sha_tree_dirty', `[${label}] got ${flat(r.stdout)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, `[${label}] nothing was amended`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
    } finally { cleanup(); }
  }
});

// EXPECTED: RED today — the code does not exist.
// SABOTAGE: invert the reachability check (treat "reachable from the remote" as safe) -> the
// amend rewrites published history -> exit 0 and every assertion reds. There is no waiver
// here by design (decision a899d6cc): the guard is what makes never-amend-after-push
// structural rather than remembered.
test('R1-D93: a target commit reachable from the ACTUAL remote ref refuses [target_sha_published] EVEN with the seam ON — the seam never overrides real publication', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  const bare = makeBareRemote();
  try {
    const targetSha = commitPlain(dir, 'reviewed, but already pushed');
    git(dir, ['remote', 'add', 'origin', bare]);
    git(dir, ['push', '-u', 'origin', 'main']);
    writeLedger(dir, [v2({ entry_id: '93000000-0000-4000-8000-000000000001', agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') }, base_sha: targetSha })]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json']);
    assert.equal(r.code, 1, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.equal(soleJson(r).code, 'target_sha_published', `got ${flat(r.stdout)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, 'nothing was amended');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
  } finally { cleanup(); rmSync(bare, { recursive: true, force: true }); }
});

// THE PAIR THAT MAKES THE PUBLICATION GUARD ATTRIBUTABLE: same guard, opposite verdicts, for
// documented reasons — (a) no upstream and the seam OFF is UNPROVABLE and refuses; (b) an
// upstream that IS configured and reachable but does not contain the commit is PROVABLY
// unpublished and proceeds with no seam at all.
// EXPECTED: RED today for both arms — the codes do not exist and amend mode does not run.
// SABOTAGE: treat "an origin remote is configured" as sufficient grounds to refuse, without
// querying its ref -> arm (b) refuses a provably-unpublished commit -> that arm reds while
// (a) stays green, which is the signature of a guard that never actually asks the remote.
test('R1-D94: no upstream + seam OFF refuses [target_sha_publication_unprovable], while a configured-and-reachable upstream that does NOT contain the commit proceeds WITHOUT the seam', { skip: GIT_SKIP }, () => {
  // (a) unprovable
  {
    const { dir, cleanup } = makeRepo();
    try {
      const targetSha = commitPlain(dir, 'reviewed, no upstream');
      writeLedger(dir, [v2({ entry_id: '94000000-0000-4000-8000-00000000000a', agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') }, base_sha: targetSha })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json'], ENV_SESSION); // seam OFF
      assert.equal(r.code, 1, `[unprovable] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(soleJson(r).code, 'target_sha_publication_unprovable', `[unprovable] got ${flat(r.stdout)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, '[unprovable] nothing was amended');
      assert.equal(readLedgerRaw(dir), before, '[unprovable] ledger byte-identical');
    } finally { cleanup(); }
  }
  // (b) provably unpublished
  {
    const { dir, cleanup } = makeRepo();
    const bare = makeBareRemote();
    try {
      git(dir, ['remote', 'add', 'origin', bare]);
      git(dir, ['push', '-u', 'origin', 'main']);
      const targetSha = commitPlain(dir, 'reviewed, never pushed');
      const id = '94000000-0000-4000-8000-00000000000b';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') }, base_sha: targetSha })]);

      const r = runCommitReviewed(dir, ['--target-sha', targetSha], ENV_SESSION); // seam OFF deliberately
      assert.equal(r.code, 0, `[provable] a provably-unpublished commit needs no seam — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.notEqual(git(dir, ['rev-parse', 'HEAD']), targetSha, '[provable] the commit was amended');
      assert.equal(entryById(dir, id).status, 'consumed', '[provable] and the receipt consumed');
    } finally { cleanup(); rmSync(bare, { recursive: true, force: true }); }
  }
});

// ELIGIBILITY IS identity.base_sha === THE TARGET SHA (decision a899d6cc G3, kept by A9).
// EXPECTED: RED today — [receipt_deferred] does not exist and the surviving entry is deleted
// rather than left active.
// SABOTAGE: when zero receipts match base_sha, fall back to stamping every receipt anyway ->
// arm (a) exits 0 and amends -> red. base_sha equality is the only thing tying a post-hoc
// review to THIS commit rather than to some other state of the tree.
// SECOND SABOTAGE: consume the non-matching receipt too while filtering -> arm (b)'s
// survivor assertion reds while its trailer assertion stays green.
test('R1-D95: only receipts whose identity.base_sha === the TARGET sha are eligible — zero matching refuses, and a mixed ledger stamps only the matching one while the other is disclosed [receipt_deferred] and stays ACTIVE', { skip: GIT_SKIP }, () => {
  // (a) none matching
  {
    const { dir, cleanup } = makeRepo();
    try {
      const targetSha = commitPlain(dir, 'reviewed, mismatched base_sha only');
      writeLedger(dir, [
        v2({ entry_id: '95000000-0000-4000-8000-00000000000a', agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') }, base_sha: null }),
        v2({ entry_id: '95000000-0000-4000-8000-00000000000b', agent_type: 'reviewer-security', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') }, base_sha: 'a'.repeat(40) }),
      ]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json']);
      assert.equal(r.code, 1, `[none] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(soleJson(r).code, 'no_spendable_receipt', `[none] got ${flat(r.stdout)}`);
      assert.match(r.stderr, token('receipt_deferred'), `[none] and the base_sha mismatch is named — stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, '[none] nothing was amended');
      assert.equal(readLedgerRaw(dir), before, '[none] ledger byte-identical');
    } finally { cleanup(); }
  }
  // (b) mixed
  {
    const { dir, cleanup } = makeRepo();
    try {
      const targetSha = commitPlain(dir, 'reviewed, mixed base_sha');
      const idOk = '95000000-0000-4000-8000-00000000000c';
      const idWrong = '95000000-0000-4000-8000-00000000000d';
      const blob = treeBlob(dir, targetSha, 'src/reviewed.mjs');
      const wrong = v2({ entry_id: idWrong, agent_type: 'reviewer-security', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': blob }, base_sha: 'b'.repeat(40) });
      writeLedger(dir, [v2({ entry_id: idOk, agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': blob }, base_sha: targetSha }), wrong]);

      const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json']);
      assert.equal(r.code, 0, `[mixed] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], '[mixed] only the matching receipt is stamped');
      assert.ok((soleJson(r).disclosures ?? []).some((d) => d.code === 'receipt_deferred' && JSON.stringify(d).includes(idWrong)), `[mixed] got ${flat(r.stdout)}`);
      assert.deepEqual(entryById(dir, idWrong), wrong, '[mixed] the non-matching receipt survives byte-identical');
    } finally { cleanup(); }
  }
});

// TERRITORY IS THE TARGET COMMIT'S OWN DIFF-TREE, not the working tree.
// EXPECTED: RED today — [receipt_no_overlap] does not exist and the withheld entry is deleted.
// SABOTAGE: derive the target file set from the working tree (or skip the overlap partition
// once base_sha has filtered) -> the non-covering receipt is stamped onto a commit its
// reviewer never saw -> the trailer deepEqual reds.
test('R1-D96: the target file set is the commit\'s OWN diff-tree — a base_sha-matching receipt whose territory misses it is withheld [receipt_no_overlap] and stays ACTIVE', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitPlain(dir, 'seed lane B', 'src/laneB.mjs', 'export const b = 1;\n');
    const targetSha = commitPlain(dir, 'reviewed lane A only', 'src/laneA.mjs');
    const idA = '96000000-0000-4000-8000-000000000001';
    const idB = '96000000-0000-4000-8000-000000000002';
    const laneB = v2({ entry_id: idB, agent_type: 'reviewer-security', files: ['src/laneB.mjs'], blobs: { 'src/laneB.mjs': treeBlob(dir, targetSha, 'src/laneB.mjs') }, base_sha: targetSha });
    writeLedger(dir, [
      v2({ entry_id: idA, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': treeBlob(dir, targetSha, 'src/laneA.mjs') }, base_sha: targetSha }),
      laneB,
    ]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json']);
    assert.equal(r.code, 0, `stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'only the diff-matching receipt is stamped');
    assert.ok((soleJson(r).disclosures ?? []).some((d) => d.code === 'receipt_no_overlap' && JSON.stringify(d).includes(idB)), `got ${flat(r.stdout)}`);
    assert.deepEqual(entryById(dir, idB), laneB, 'the withheld receipt survives byte-identical');
  } finally { cleanup(); }
});

// THE BYTE RULE AGAINST THE TARGET COMMIT'S TREE (moved here from the byte-rule suite).
// EXPECTED: RED today for the refusal and waiver arms — the byte verdict is advisory in every
// mode today, so the amend goes through.
// SABOTAGE: apply the byte enforcement only on the staged-diff path (an `if (!targetSha)`
// guard around the check) -> the mismatch arm amends, exit 0 -> red. That guard is invisible
// to every new-commit byte pin, which is exactly why the amend arms live here.
// SECOND SABOTAGE: accept --waive-bytes only on the new-commit path -> the waiver arm refuses
// despite the waiver -> red. The two arms fail under different one-liners.
test('R1-D97: the byte rule in amend mode measures the TARGET COMMIT\'S TREE — a mismatch refuses [receipt_bytes_mismatch], and --waive-bytes amends with the waiver trailer', { skip: GIT_SKIP }, () => {
  // (a) mismatch refuses
  {
    const { dir, cleanup } = makeRepo();
    try {
      const targetSha = commitPlain(dir, 'reviewed change', 'src/reviewed.mjs', 'export const reviewed = 2;\n');
      const stale = hashBytes(dir, 'export const reviewed = 1; // the bytes the reviewer read\n');
      assert.notEqual(stale, treeBlob(dir, targetSha, 'src/reviewed.mjs'), 'fixture guard: the recorded bytes really differ from the target tree');
      writeLedger(dir, [v2({ entry_id: '97000000-0000-4000-8000-00000000000a', agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': stale }, base_sha: targetSha })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json']);
      assert.equal(r.code, 1, `[mismatch] amend mode gets IDENTICAL enforcement — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      const out = soleJson(r);
      assert.equal(out.code, 'receipt_bytes_mismatch', `[mismatch] got ${JSON.stringify(out)}`);
      assert.equal(out.facts?.mismatches?.[0]?.index_blob, treeBlob(dir, targetSha, 'src/reviewed.mjs'), `[mismatch] the comparison side is the TARGET COMMIT'S TREE — got ${JSON.stringify(out.facts)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, '[mismatch] NOTHING was amended');
      assert.equal(readLedgerRaw(dir), before, '[mismatch] ledger byte-identical');
    } finally { cleanup(); }
  }
  // (b) waived amends
  {
    const { dir, cleanup } = makeRepo();
    try {
      const targetSha = commitPlain(dir, 'reviewed change', 'src/reviewed.mjs', 'export const reviewed = 2;\n');
      const stale = hashBytes(dir, 'export const reviewed = 1; // the bytes the reviewer read\n');
      const id = '97000000-0000-4000-8000-00000000000b';
      writeLedger(dir, [v2({ entry_id: id, agent_type: 'reviewer-correctness', files: ['src/reviewed.mjs'], blobs: { 'src/reviewed.mjs': stale }, base_sha: targetSha })]);

      const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--waive-bytes', 'post-hoc review re-read the amended file']);
      assert.equal(r.code, 0, `[waived] the waiver must work in amend mode too — stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      const newSha = git(dir, ['rev-parse', 'HEAD']);
      assert.notEqual(newSha, targetSha, '[waived] the commit was amended');
      assert.deepEqual(reviewedByTrailers(dir, newSha), ['reviewer-correctness'], '[waived] the ordinary stamp is present');
      assert.deepEqual(waiverTrailers(dir, newSha), [id], '[waived] and exactly one waiver trailer, valued by entry_id');
      assert.equal(entryById(dir, id).consumption?.commit_sha, newSha, '[waived] consumed against the new sha');
    } finally { cleanup(); }
  }
});

// TRAILER PRESERVATION ACROSS A SECOND AMEND, plus THE RE-BIND (contract sheet §6 A13:
// "--target-sha rewrites the target commit's sha, so every receipt already consumed for the
// OLD sha … is re-bound in the same finalize step to the NEW sha"). Also NO trailer collapse
// for a repeated agent_type (git's default `ifexists=addIfDifferent` drops the second
// identical value).
// EXPECTED: RED today on the Review-Receipt assertions, on the duplicate roster trailer, and
// on the re-bind (today nothing records which sha a receipt paid for at all).
// SABOTAGE (orphaning): build the second amend's trailer block from the freshly-stamped
// receipts alone rather than from existing trailers + new ones -> round one's trailers vanish
// -> the round-one assertions red.
// SABOTAGE (collapse): use `trailer.ifexists=addIfDifferent` (git's default) -> the second
// receipt's identical Reviewed-By-Agent value is silently dropped, one roster trailer instead
// of two -> only the length assertion reds while the Review-Receipt lines stay correct, which
// is precisely the asymmetric signature this arm exists to expose.
// SABOTAGE (the re-bind, and the reason A13 exists): preserve round one's trailer but leave
// its consumption pointing at the OLD sha -> the commit carries a Review-Receipt trailer whose
// receipt is consumed for a sha that no longer exists, which sheet §3.3 makes direct-merge
// REFUSE -> only the round-one consumption assertion reds, and it reds silently green
// everywhere else. That is the whole defect: an amend that manufactures an unmergeable commit.
test('R1-D98 (SECOND AMEND + RE-BIND): a second --target-sha amend preserves every round\'s trailers, keeps BOTH Reviewed-By-Agent lines for one repeated agent_type, and RE-BINDS round one\'s consumption to the NEW sha', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const originalSha = commitPlain(dir, 'reviewed feature, round one', 'src/laneA.mjs');
    const blob = treeBlob(dir, originalSha, 'src/laneA.mjs');
    const id1 = '98000000-0000-4000-8000-000000000001';
    writeLedger(dir, [v2({ entry_id: id1, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: originalSha })]);

    const r1 = runCommitReviewed(dir, ['--target-sha', originalSha]);
    assert.equal(r1.code, 0, `round one must succeed — stdout=${flat(r1.stdout)} stderr=${flat(r1.stderr)}`);
    const sha1 = git(dir, ['rev-parse', 'HEAD']);
    assert.deepEqual(receiptTrailers(dir, sha1), [id1], 'fixture guard: round one really bound its receipt');

    // Round two: TWO fresh receipts sharing one agent_type, based on round one's output sha.
    const id2 = '98000000-0000-4000-8000-000000000002';
    const id3 = '98000000-0000-4000-8000-000000000003';
    const blob1 = treeBlob(dir, sha1, 'src/laneA.mjs');
    const ledger = readLedger(dir);
    ledger.push(
      v2({ entry_id: id2, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob1 }, base_sha: sha1 }),
      v2({ entry_id: id3, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob1 }, base_sha: sha1 }),
    );
    writeLedger(dir, ledger);

    const r2 = runCommitReviewed(dir, ['--target-sha', sha1]);
    assert.equal(r2.code, 0, `round two must succeed — stdout=${flat(r2.stdout)} stderr=${flat(r2.stderr)}`);
    const sha2 = git(dir, ['rev-parse', 'HEAD']);
    const roster = reviewedByTrailers(dir, sha2);
    assert.ok(roster.includes('reviewer-correctness'), `round one's trailer survives round two — got ${JSON.stringify(roster)}`);
    assert.equal(roster.filter((v) => v === 'reviewer-security').length, 2, `BOTH round-two trailers survive — git's default addIfDifferent would collapse them to one — got ${JSON.stringify(roster)}`);
    assert.deepEqual(receiptTrailers(dir, sha2).sort(), [id1, id2, id3].sort(), 'and every round\'s Review-Receipt binding is present exactly once');
    for (const id of [id2, id3]) assert.equal(entryById(dir, id).consumption?.commit_sha, sha2, `${id} consumed against the new sha`);
    assert.equal(entryById(dir, id1).consumption?.commit_sha, sha2,
      'THE RE-BIND: round one\'s receipt is re-bound to the NEW sha in the same finalize — a preserved trailer whose receipt still names the rewritten sha is exactly what direct-merge refuses');
    assert.equal(entryById(dir, id1).status, 'consumed', 'and it stays consumed throughout — the re-bind moves the sha, never the lifecycle');
  } finally { cleanup(); }
});

// THE RE-BIND'S FAIL-CLOSED HALF (A13): a preserved Review-Receipt trailer the ledger cannot
// account for refuses BEFORE the amend, so an unaccountable binding is never carried forward
// into a new sha.
// EXPECTED: RED today — [target_sha_prior_receipt_unbound] does not exist, and today's amend
// preserves whatever trailers it finds without ever resolving them.
// SABOTAGE: preserve prior Review-Receipt trailers without resolving them against the ledger
// -> the amend proceeds, exit 0, and the new commit inherits a trailer naming a receipt that
// was never consumed for the commit it claims -> the exit-code and HEAD-unmoved assertions
// red. THE TWO ARMS ARE NOT REDUNDANT: (a) the receipt is ABSENT from the ledger entirely,
// (b) the receipt EXISTS and is active but was never consumed for the old sha — a resolver
// that only checks existence passes (b) and a resolver that only checks status passes (a).
test('R1-D99 (RE-BIND, fail closed): a preserved Review-Receipt trailer whose receipt is ABSENT, or present but NOT consumed for the old sha, refuses [target_sha_prior_receipt_unbound] BEFORE amending', { skip: GIT_SKIP }, () => {
  for (const label of ['absent', 'not-consumed-for-old-sha']) {
    const { dir, cleanup } = makeRepo();
    try {
      // Both ids are well-formed uuids on purpose: a non-uuid would make the entry
      // ledger_entry_malformed (A13) and collapse the two arms into one cause.
      const priorId = '99000000-0000-4000-8000-0000000000aa';
      const freshId = '99000000-0000-4000-8000-0000000000ff';
      // A commit already carrying a Review-Receipt trailer, created by plain git.
      stageChange(dir, 'src/laneA.mjs');
      git(dir, ['commit', '-m', `prior round\n\nReviewed-By-Agent: reviewer-correctness\nReview-Receipt: ${priorId}`]);
      const targetSha = git(dir, ['rev-parse', 'HEAD']);
      assert.deepEqual(receiptTrailers(dir, targetSha), [priorId], 'fixture guard: the target really carries a prior binding');
      const blob = treeBlob(dir, targetSha, 'src/laneA.mjs');

      const entries = [v2({ entry_id: freshId, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: targetSha })];
      if (label === 'not-consumed-for-old-sha') {
        // present, well-formed, but ACTIVE — it never paid for the target commit.
        entries.unshift(v2({ entry_id: priorId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: targetSha }));
      }
      writeLedger(dir, entries);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['--target-sha', targetSha, '--json']);
      assert.equal(r.code, 1, `[${label}] stdout=${flat(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(soleJson(r).code, 'target_sha_prior_receipt_unbound', `[${label}] got ${flat(r.stdout)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), targetSha, `[${label}] the refusal lands BEFORE the amend — nothing was rewritten`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
    } finally { cleanup(); }
  }
});
