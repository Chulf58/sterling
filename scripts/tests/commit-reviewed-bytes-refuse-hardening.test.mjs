// COMMIT-REVIEWED — REVIEWED-BYTES REFUSE FLIP: **HARDENING PINS** (S2b-2 fix
// round; decision 57984926, slug
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design, §2).
//
// WHY A SECOND FILE: commit-reviewed-bytes-refuse.test.mjs is FROZEN (it pinned
// the flip itself and is red-first evidence for it). Two independent reviews of
// the shipped REFUSE flip found defects that suite cannot see — trailer
// injection through an agent-authored entry_id, evidence bypasses reachable by
// DELETING a blobs key rather than by changing one, self-contradictory evidence
// shapes that fall through the grandfather clause, alias-spelled keys, and a
// duplicate-trailer collapse in amend mode. These are NEW spec pins for the
// FIXED behaviour; nothing here edits or weakens the frozen suite.
//
// SPEC-ONLY, RED-FIRST. Authored from decision 57984926 §2 (opened with
// knowledge_get; the governing clauses are quoted at each family) and the
// launching brief's adjudications. H4 read wall honored: this file's author
// never Read nor content-Grepped scripts/commit-reviewed.mjs or
// scripts/hooks/lib/review-ledger-entry.mjs. Only the sibling TEST file above
// was read, for fixture conventions.
//
// HARNESS PROVENANCE: git()/makeRepo()/ledgerPath()/writeLedger()/readLedger()/
// readLedgerRaw()/stageChange()/hashBytes()/stagedBlob()/
// stageChangedSinceReview()/runCommitReviewed()/trailerValues()/refusalBlock()/
// v1()/v2()/CONFIG/seedConfig()/commitPlain()/treeBlob()/flat/isoAgo are
// commit-reviewed-bytes-refuse.test.mjs's idioms, carried over verbatim so the
// two suites cannot disagree about what a fixture MEANS. Deliberate harness
// deviations, both isolation-only: the mkdtemp prefix is
// 'sterling-commit-reviewed-hardening-', and v1() here takes reviewed_state
// VERBATIM (including a literal null) because family H3 pins a receipt whose
// reviewed_state key is PRESENT and null — the frozen helper deliberately
// treats null as "omit the key", which is the opposite fixture.
//
// THE TWO LOAD-BEARING FIXTURE CHOICES ARE INHERITED, NOT RESTATED CASUALLY:
//  1. every "mismatching" blob is a REAL `git hash-object` sha of DIFFERENT
//     bytes, never a placeholder (a placeholder is indistinguishable from
//     UNUSABLE evidence and could be grandfathered, making a refusal pin hollow);
//  2. index and worktree always agree, so no pin here depends on which one the
//     CLI reads — that distinction is not specified by §2.
//
// CONTROLS FIRST IN EVERY FAMILY (repo mutation discipline): each refusal pin
// below is its family's control fixture minus ONE property, so a green refusal
// can never be explained by "this shape refuses everything".

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

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const SEAM_ON = { STERLING_TARGET_SHA_ALLOW_NO_UPSTREAM: '1' };

// THE DECLARED FINGERPRINT SHAPE (launching brief, fix round): when a waiver
// cannot safely carry a receipt's own identifier, the trailer value is the
// deterministic v1-style fingerprint `receipt-<hex>`. A value matching this
// regex CANNOT contain a newline, a colon, or a 150-char opaque id — which is
// exactly why the shape, and not merely "non-empty", is what gets pinned.
const FINGERPRINT = /^receipt-[0-9a-f]+$/;

const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-commit-reviewed-hardening-'));
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
// Raw bytes, not the parsed value: a refusal that rewrites the ledger with the
// same logical content has still written to an agent-writable evidence file
// during a refusal path.
function readLedgerRaw(dir) {
  return existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null;
}

function stageChange(dir, relPath = 'src/feature.mjs', content = 'export const f = 1;\n') {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}

function hashBytes(dir, content) {
  const r = spawnSync('git', ['hash-object', '--stdin'], { cwd: dir, input: content, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git hash-object --stdin: ${r.stderr}`);
  const sha = (r.stdout ?? '').trim();
  assert.match(sha, /^[0-9a-f]{40}$/, `fixture guard: hash-object must produce a usable 40-hex sha, got ${sha}`);
  return sha;
}

const stagedBlob = (dir, relPath) => git(dir, ['hash-object', relPath]);

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
// the trailer key.
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}
const reviewedByTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Reviewed-By-Agent', sha);
const waiverTrailers = (dir, sha = 'HEAD') => trailerValues(dir, 'Review-Bytes-Waiver', sha);
// The WHOLE committed message — subject, body and trailer block. Family H1 reads
// this rather than the parsed trailers alone, because a forged line that git
// declines to parse as a trailer is still a forged line sitting in the durable
// review record a human (and `git log --grep`) will read.
const commitMessage = (dir, sha = 'HEAD') => git(dir, ['log', '-1', '--format=%B', sha]);

function refusalBlock(stderr) {
  const i = stderr.search(/REVIEWED BYTES/);
  return i === -1 ? '' : stderr.slice(i);
}

// v1 (flat) receipt. DEVIATION FROM THE FROZEN HELPER, deliberate: when
// `reviewed_state` is passed it is written VERBATIM, so `reviewed_state: null`
// produces a receipt whose key is PRESENT and null (family H3b's fixture). The
// frozen helper omits the key on null, which is the grandfathered shape — the
// opposite of what H3b pins.
function v1({ agent_type, files, blobs, at = isoAgo(60_000), truncated, truncated_of, reviewed_state = undefined, session_id = SESSION, base_sha = undefined }) {
  const e = { agent_type, files, at, session_id, branch: 'main' };
  if (base_sha !== undefined) e.base_sha = base_sha;
  if (reviewed_state !== undefined) {
    e.reviewed_state = reviewed_state;
    return e;
  }
  e.reviewed_state = { blobs, completed_at: at };
  if (truncated !== undefined) e.reviewed_state.truncated = truncated;
  if (truncated_of !== undefined) e.reviewed_state.truncated_of = truncated_of;
  return e;
}

// v2 (nested) receipt — decision 57984926 §1, same shape as the frozen suite's
// helper and the v2 fixture in commit-reviewed-file-scoping.test.mjs S12.
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

function commitPlain(dir, message, relPath, content) {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}
const treeBlob = (dir, sha, relPath) => git(dir, ['rev-parse', `${sha}:${relPath}`]);

const OLD = 'export const f = 1; // the bytes the reviewer read\n';
const NEW = 'export const f = 2; // the bytes actually staged\n';

// ===========================================================================
// H1 — HOSTILE entry_id CANNOT FORGE A TRAILER.
//
// §2: "stamping one Review-Bytes-Waiver trailer per affected receipt (entry_id
// for v2, stable fingerprint for v1), trailers verified after commit/amend like
// Reviewed-By-Agent."
//
// THE DEFECT: entry_id is a field of an AGENT-WRITABLE evidence file. Copying
// it into a commit trailer verbatim makes the ledger a write primitive for the
// commit message — a newline in entry_id opens a second trailer line, and
// `Reviewed-By-Agent: reviewer-fake` in that position is indistinguishable, to
// the merge gate, from a real roster review. The fix adjudicated for this round:
// an entry_id that is not trailer-safe is NOT sanitized into the trailer, it is
// REPLACED by the deterministic v1-style fingerprint.
// ===========================================================================

// EXPECTED STATE: GREEN today (the frozen E1 already pins entry_id-in-trailer
// for a well-formed v2 receipt; this restates it as THIS family's control).
// PLACED FIRST: it must pass for the OPPOSITE reason to H1a/H1b. Without it, an
// implementation that ALWAYS stamps the fingerprint and never the entry_id
// satisfies H1a/H1b perfectly while silently discarding v2 receipt identity —
// the waiver trailer would stop identifying which receipt was overridden, which
// is the entire point of stamping one per affected receipt.
// SABOTAGE: replace the trailer value with the fingerprint unconditionally
// (drop the trailer-safety branch) -> the `includes(entryId)` assertion goes red
// here while H1a and H1b stay green.
test('H1-0 (CONTROL, first): a WELL-FORMED v2 entry_id is still carried verbatim in the Review-Bytes-Waiver trailer', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entryId = 'aaaaaaaa-0000-4000-8000-0000000000a0';
    writeLedger(dir, [
      v2({ entry_id: entryId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA }, base_sha: head }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'H1-0 well-formed entry_id', '--waive-bytes', 'reviewer re-read the changed lines by hand']);
    assert.equal(r.code, 0, `the waived commit must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const waivers = waiverTrailers(dir);
    assert.equal(waivers.length, 1, `exactly one waiver trailer for the one affected receipt — got ${JSON.stringify(waivers)}`);
    assert.ok(waivers[0].includes(entryId), `a SAFE entry_id identifies its own waiver — got ${JSON.stringify(waivers)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'and the ordinary stamp is unchanged');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today, on the CURRENT (pre-fix) tree, in one of two ways
// depending on what the shipped stamper does with the raw value:
//   - if it writes the entry_id verbatim, git parses the injected line as a
//     second trailer and `reviewedByTrailers` returns
//     ['reviewer-correctness','reviewer-fake'] (order per git) -> the deepEqual
//     goes red, and the FINGERPRINT assertion goes red too;
//   - if the post-commit trailer verification catches the mangled value, the run
//     exits non-zero -> the very first assertion (`r.code === 0`) goes red.
//   Either way the 150-char arm is red on the FINGERPRINT assertion, since a
//   150-char opaque id cannot match /^receipt-[0-9a-f]+$/.
// SABOTAGE (the injection half): copy entry_id into the trailer value verbatim
// -> the forged `Reviewed-By-Agent: reviewer-fake` line appears -> the
// reviewedByTrailers deepEqual and the raw-message assertion both go red.
// SABOTAGE (the sanitize-instead-of-replace half): flatten newlines in entry_id
// to spaces and stamp THAT -> no forged trailer, so the deepEqual stays green,
// but the value is `aaaaaaaa-... Reviewed-By-Agent: reviewer-fake` -> the
// FINGERPRINT assertion and the no-'reviewer-fake'-anywhere assertion go red.
//   That second sabotage is why this pin asserts a SHAPE and not merely "no
//   forged trailer": flattening leaves the attacker's text in the durable review
//   record, where `git log --grep` and a human reader both still see it.
// SABOTAGE (the bound half): apply the trailer-safety branch only to newlines,
// not to length -> the 150-char arm goes red while the LF arm stays green.
test('H1a/H1b: a HOSTILE v2 entry_id (embedded trailer line; 150 chars) never reaches the commit — the waiver trailer is the deterministic fingerprint, no forged Reviewed-By-Agent survives, and the run still exits 0', { skip: GIT_SKIP }, () => {
  const arms = [
    {
      label: 'newline-injection',
      entryId: 'aaaaaaaa-0000-4000-8000-0000000000a1\nReviewed-By-Agent: reviewer-fake',
      hostileText: 'reviewer-fake',
    },
    {
      label: '150-chars',
      entryId: `long-entry-id-${'z'.repeat(136)}`,
      hostileText: 'z'.repeat(136),
    },
  ];
  assert.equal(arms[1].entryId.length, 150, 'fixture guard: the long arm is exactly 150 characters');
  assert.ok(arms[0].entryId.includes('\n'), 'fixture guard: the injection arm really carries a newline');
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [
        v2({ entry_id: arm.entryId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA }, base_sha: head }),
      ]);

      const r = runCommitReviewed(dir, ['-m', `H1 ${arm.label}`, '--waive-bytes', 'reviewer re-read the changed lines by hand']);

      // Trailer verification passing IS exit 0: §2 requires trailers to be
      // verified after commit, so a value the stamper mangled cannot leave the
      // run green.
      assert.equal(r.code, 0, `[${arm.label}] a hostile entry_id must be neutralized, not turned into a failed commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, `[${arm.label}] the commit was created`);

      assert.deepEqual(
        reviewedByTrailers(dir),
        ['reviewer-correctness'],
        `[${arm.label}] EXACTLY ONE Reviewed-By-Agent trailer — a second, ledger-authored one is a forged review the merge gate would honor`
      );

      const waivers = waiverTrailers(dir);
      assert.equal(waivers.length, 1, `[${arm.label}] exactly one waiver trailer for the one affected receipt — got ${JSON.stringify(waivers)}`);
      assert.match(
        waivers[0],
        FINGERPRINT,
        `[${arm.label}] an unsafe entry_id is REPLACED by the deterministic fingerprint, never sanitized-and-stamped — got ${JSON.stringify(waivers)}`
      );

      const message = commitMessage(dir);
      assert.doesNotMatch(
        message,
        /^Reviewed-By-Agent:\s*reviewer-fake\s*$/m,
        `[${arm.label}] no forged Reviewed-By-Agent line anywhere in the message — message=${flat(message)}`
      );
      assert.ok(
        !message.includes(arm.hostileText),
        `[${arm.label}] the ledger-authored text does not reach the durable commit record at all — message=${flat(message)}`
      );

      assert.deepEqual(readLedger(dir), [], `[${arm.label}] the waived receipt is consumed exactly as an ordinary waiver`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// H2 — THE BLOB-KEY DELETION BYPASS.
//
// §2: "a covered path whose evidence is partial/truncated/inconsistent also
// refuses; GLOBALLY partial evidence passes when every path THIS commit touches
// is bound."
//
// THE DEFECT: the frozen B1/B2 pins only cover receipts that ADMIT incompleteness
// (v1 truncated:true, v2 status:'partial'). A receipt that CLAIMS complete
// evidence while simply omitting the blobs key for a staged path it declares is
// the cheapest possible bypass — delete one key and the path is neither
// compared nor flagged. "Complete" is a claim by the writer, not a fact; the
// binding test is whether every staged path the receipt covers is BOUND.
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the fix. CONTROL for the whole family,
// covering BOTH schema versions in one commit: identical fixtures to H2a/H2b
// except that the staged declared path IS bound, with a matching sha.
// SABOTAGE: refuse whenever a receipt declares more files than it binds
// (regardless of which are staged) -> src/base.mjs is declared-but-unbound in
// both receipts here, so an over-broad coverage rule refuses -> red. That is the
// over-reach H2a/H2b must not be satisfied by, and it would also contradict the
// frozen B0.
test('H2-0 (CONTROL, first): complete-evidence receipts (v1 and v2) whose declared STAGED paths are bound and matching commit normally — an unbound path this commit does not touch is not a defect', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    stageChange(dir, 'src/laneB.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v1({
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs', 'src/base.mjs'],
        blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') }, // src/base.mjs unbound, and not staged
      }),
      v2({
        entry_id: 'bbbbbbbb-0000-4000-8000-0000000000b0',
        agent_type: 'reviewer-security',
        files: ['src/laneB.mjs', 'src/base.mjs'],
        blobs: { 'src/laneB.mjs': stagedBlob(dir, 'src/laneB.mjs') },
        base_sha: head,
        status: 'complete',
      }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'H2-0 bound and matching']);
    assert.equal(r.code, 0, `bound+matching staged paths must commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir).sort(), ['reviewer-correctness', 'reviewer-security'], 'both receipts stamp');
    assert.deepEqual(readLedger(dir), [], 'both are consumed');
    assert.equal(refusalBlock(r.stderr), '', `no byte refusal — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today if the shipped flip iterates the BLOBS MAP (the
// omitted key is simply never visited, the run exits 0 and commits) — which is
// the bypass both reviews reported. The first assertion (`r.code === 1`), the
// HEAD-unmoved assertion and the ledger-byte-identical assertion all fire.
// SABOTAGE: iterate `Object.keys(blobs)` and compare those against the index,
// instead of iterating the STAGED paths the receipt covers and demanding a
// binding for each -> exit 0 -> red. Distinct from the frozen B1's sabotage:
// B1's receipt ADMITS truncation, so an implementation can pass B1 by keying
// off `truncated`/`status` alone and still be wide open here. That is exactly
// the hole this arm exists for — the truncation FLAG is not the guard, the
// BINDING is.
// SECOND SABOTAGE (grandfather over-reach): treat "no key for this path" as
// "genuinely absent evidence" and grandfather it -> exit 0 -> red. §2's
// grandfather is per-RECEIPT ("schema absence does not imply blob absence"), not
// per-path: this receipt demonstrably HAS evidence, it just does not cover the
// path it claims to.
test('H2a: a v1 receipt with NON-truncated reviewed_state that DECLARES a staged file but binds NO key for it REFUSES — deleting a blobs key is not a way to pass', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW); // staged + declared, but NOT in blobs
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v1({
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs', 'src/base.mjs'],
        // A NON-EMPTY map binding the WRONG path: this receipt indisputably has
        // content evidence, so the grandfather clause cannot reach it, and it
        // makes no truncation claim, so the frozen B1 guard cannot either.
        blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') },
      }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'H2a v1 complete, key deleted']);
    assert.equal(r.code, 1, `a covered staged path with no binding must REFUSE even when the receipt claims completeness — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'NO commit was created');
    assert.equal(readLedgerRaw(dir), before, 'NOTHING consumed — the ledger file is byte-identical after the refusal');
    const block = refusalBlock(r.stderr);
    assert.notEqual(block, '', `the refusal carries the REVIEWED BYTES anchor, as the frozen B1/B2 pin for the same class — stderr=${flat(r.stderr)}`);
    assert.match(block, /src\/laneA\.mjs/, `and names the unbound staged path — refusal=${flat(block)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today, same shape and same cause as H2a.
// SABOTAGE: gate the v2 binding check on `content_evidence.status !== 'complete'`
// -> a receipt that self-declares 'complete' is trusted about its own coverage,
// exit 0 -> red. The status field is written by the same agent as the blobs map;
// it is a claim, not a verification.
test('H2b: a v2 receipt with content_evidence.status "complete" that DECLARES a staged file but binds NO key for it REFUSES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({
        entry_id: 'bbbbbbbb-0000-4000-8000-0000000000b1',
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs', 'src/base.mjs'],
        blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') },
        base_sha: head,
        status: 'complete',
      }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'H2b v2 complete, key deleted']);
    assert.equal(r.code, 1, `'complete' is a CLAIM about coverage, not evidence of it — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    const block = refusalBlock(r.stderr);
    assert.notEqual(block, '', `the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
    assert.match(block, /src\/laneA\.mjs/, `and names the unbound staged path — refusal=${flat(block)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// H3 — CONTRADICTORY EVIDENCE IS NEVER GRANDFATHERED.
//
// §2: "v1 receipts with usable blobs are ENFORCED (grandfather only genuinely
// absent evidence — schema absence does not imply blob absence)."
//
// THE DEFECT: the grandfather clause is reached by asking "does this receipt
// have evidence?" — and both shapes below answer that question WRONGLY when the
// answer is read off a single field. A v2 receipt can declare
// status:'unavailable' while carrying a usable, MISMATCHING blob; a v1 receipt
// can carry `reviewed_state: null`, which every `?.` read collapses to "no
// evidence" although the key is present and the receipt is malformed, not
// legacy. Both are one-field edits to an agent-writable file that convert an
// enforced receipt into a grandfathered one.
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the fix — it is the frozen C0 shape,
// restated as THIS family's control because H3a/H3b are both "a receipt that
// LOOKS like it has no evidence". Without it, an implementation that simply
// deleted the grandfather clause passes H3a and H3b while bricking every
// pre-flip receipt still sitting in a live ledger.
// SABOTAGE: remove the grandfather branch (refuse whenever a covered staged path
// has no comparable blob, without first asking whether the receipt records
// evidence at all) -> this control refuses -> red, while H3a/H3b stay green.
test('H3-0 (CONTROL, first): a v1 receipt with NO reviewed_state key at all over a changed staged file STILL COMMITS — genuinely absent evidence stays grandfathered', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [{ agent_type: 'reviewer-legacy', files: ['src/laneA.mjs'], at: isoAgo(60_000), session_id: SESSION, branch: 'main' }]);

    const r = runCommitReviewed(dir, ['-m', 'H3-0 legacy receipt, no evidence key']);
    assert.equal(r.code, 0, `a receipt with no content evidence at all must NOT be refused — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the commit was created');
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-legacy'], 'and stamped as before');
    assert.deepEqual(readLedger(dir), [], 'and consumed as before');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the 'unavailable' status short-circuits into the
// grandfather path before the blobs map is looked at, so the run commits: exit
// 0 -> the first assertion fires).
// DISTINCT FROM THE FROZEN C3, which is deliberately either-reading: C3's
// receipt has an EMPTY blobs map, so "unavailable" and the evidence AGREE and §2
// genuinely does not say which clause wins. Here they CONTRADICT — the receipt
// carries a usable 40-hex sha for the staged path and that sha does not match.
// Under either reading of C3, a receipt whose own evidence contradicts its own
// status is "inconsistent" per clause 2 and refuses. The frozen C3 cannot see
// this class at all.
// SABOTAGE: branch on `content_evidence.status === 'unavailable'` FIRST and
// grandfather -> exit 0 -> red. That single line is the whole defect: status is
// agent-written, so it must never be able to disclaim evidence the same agent
// wrote.
test('H3a: a v2 receipt claiming content_evidence.status "unavailable" while carrying a USABLE MISMATCHING blob for the staged path REFUSES — a status field cannot disclaim the evidence beside it', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({
        entry_id: 'cccccccc-0000-4000-8000-0000000000c1',
        agent_type: 'reviewer-correctness',
        files: ['src/laneA.mjs'],
        blobs: { 'src/laneA.mjs': reviewedA }, // real, usable, and NOT the staged sha
        base_sha: head,
        status: 'unavailable',
        failure_reason: 'hashing did not run',
      }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'H3a v2 unavailable but evidence present']);
    assert.equal(r.code, 1, `contradictory evidence is 'inconsistent' under clause 2, never 'genuinely absent' under clause 3 — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    const block = refusalBlock(r.stderr);
    assert.notEqual(block, '', `the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
    assert.match(block, /src\/laneA\.mjs/, `and names the file — refusal=${flat(block)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (`reviewed_state: null` reads as absent through any
// optional-chain, so the receipt is grandfathered and the changed file is
// committed: exit 0 -> the first assertion fires).
// ADJUDICATED, NOT ASSUMED: §2 permits either "refuse" or "disclose as
// inconsistent" for this shape; the launching brief adjudicates REFUSE for this
// fix round, so this pin asserts refusal strictly rather than the either-reading
// form used by the frozen C2/C3. If that adjudication is revisited, this pin is
// the one that moves.
// SABOTAGE: read evidence as `entry.reviewed_state?.blobs ?? {}` and treat the
// empty result as absent -> exit 0 -> red. Note the difference from H3-0: there
// the KEY IS MISSING (a legacy receipt written before evidence existed); here
// the key is PRESENT and null (a receipt whose evidence was nulled out), and no
// legitimate writer produces that shape.
test('H3b: a v1 receipt whose reviewed_state key is PRESENT and null, covering a changed staged file, REFUSES — a nulled evidence key is malformed, not legacy', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const entry = v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], reviewed_state: null });
    assert.ok('reviewed_state' in entry && entry.reviewed_state === null, 'fixture guard: the key must be PRESENT and null, not omitted');
    writeLedger(dir, [entry]);
    const before = readLedgerRaw(dir);
    assert.match(before, /"reviewed_state":null/, 'fixture guard: the serialized ledger really carries the null key');

    const r = runCommitReviewed(dir, ['-m', 'H3b v1 nulled reviewed_state']);
    assert.equal(r.code, 1, `a nulled evidence key must not be silently committed as absent evidence — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(readLedgerRaw(dir), before, 'ledger byte-identical');
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `and it is a refusal, never a crash — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// H4 — ALIAS-SPELLED KEYS: INCONSISTENT EVIDENCE, NEVER FIRST-SPELLING-WINS.
//
// §2: "a covered path whose evidence is partial/truncated/inconsistent also
// refuses." Repo invariant 2: every path is stored/compared repo-relative with
// forward slashes, normalized in packages/schemas — no raw path enters the
// store.
//
// THE DEFECT: a blobs map is a plain object, so two SPELLINGS of one path can
// both be present with DIFFERENT shas. Whichever spelling the lookup happens to
// try first decides the verdict, and the loser is silently discarded — the
// clean spelling launders the dirty one. This family is written in place of a
// git-failure fail-closed pin, which cannot be triggered from a fixture repo
// (reported as a coverage gap rather than faked).
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the fix. CONTROL, placed first: the
// canonical spelling alone, matching. Its job is narrow but essential — it
// proves H4a's refusal comes from the CONTRADICTION and not from "any receipt
// touching src/laneA.mjs in this family refuses".
// SABOTAGE: refuse whenever a receipt binds a staged path at all -> red here,
// green in H4a.
test('H4-0 (CONTROL, first): the canonical spelling alone, matching, commits normally', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') } })]);

    const r = runCommitReviewed(dir, ['-m', 'H4-0 canonical spelling only']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness']);
    assert.deepEqual(readLedger(dir), []);
    assert.equal(refusalBlock(r.stderr), '', `no byte refusal — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today in BOTH orders if the lookup is a plain
// `blobs[path]` (the alias key is never consulted, so the matching canonical
// value decides and the run commits: exit 0). If instead the implementation
// normalizes keys into a map and lets one spelling overwrite the other, ONE
// order commits and the other refuses — which is precisely the
// first-spelling-wins defect, and is why both orders are asserted.
// SABOTAGE (the discard half): normalize keys with a last-write-wins reduce
// (`out[normalize(k)] = v`) -> the 'canonical-first' arm refuses (the alias
// overwrote it) and the 'alias-first' arm commits -> exactly one arm red, which
// no single-order fixture can see.
// SABOTAGE (the ignore half): look up only the canonical spelling and drop
// unrecognized keys -> both arms commit -> both red.
// WHY REFUSE AND NOT "PICK THE CANONICAL ONE": a receipt asserting two different
// shas for one file has not established what the reviewer read. Choosing the
// convenient assertion is the same failure as trusting the agent-written status
// field in H3a.
test('H4a: a blobs map recording BOTH "src/laneA.mjs" (matching) and "./src/laneA.mjs" (mismatching) for one staged file REFUSES as inconsistent evidence — in EITHER key order', { skip: GIT_SKIP }, () => {
  for (const order of ['canonical-first', 'alias-first']) {
    const { dir, cleanup } = makeRepo();
    try {
      const reviewedA = hashBytes(dir, OLD);
      stageChange(dir, 'src/laneA.mjs', NEW);
      const stagedA = stagedBlob(dir, 'src/laneA.mjs');
      assert.notEqual(reviewedA, stagedA, 'fixture guard: the two spellings really disagree');
      const head = git(dir, ['rev-parse', 'HEAD']);

      const blobs =
        order === 'canonical-first'
          ? { 'src/laneA.mjs': stagedA, './src/laneA.mjs': reviewedA }
          : { './src/laneA.mjs': reviewedA, 'src/laneA.mjs': stagedA };
      assert.equal(Object.keys(blobs).length, 2, 'fixture guard: both spellings survive as distinct keys');
      writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', `H4a ${order}`]);
      assert.equal(r.code, 1, `[${order}] two disagreeing shas for one path is inconsistent evidence and must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, `[${order}] no commit`);
      assert.equal(readLedgerRaw(dir), before, `[${order}] ledger byte-identical`);
      const block = refusalBlock(r.stderr);
      assert.notEqual(block, '', `[${order}] the refusal carries the REVIEWED BYTES anchor — stderr=${flat(r.stderr)}`);
      assert.match(block, /laneA\.mjs/, `[${order}] and names the file — refusal=${flat(block)}`);
    } finally {
      cleanup();
    }
  }
});

// AMBIGUITY PIN (reported, NOT resolved here) — when the two spellings AGREE
// there is no contradiction, so §2 supports committing; but a strict reading of
// the repo path invariant ("no raw path ever enters the store") supports
// refusing any non-normalized key outright. §2 does not choose. This pin
// therefore asserts only the invariant that holds under EITHER reading (the C2/
// C3 pattern from the frozen suite): no crash, and no SILENT acceptance of an
// unusable state. It exists so the conductor learns which way the fix went
// without a false red either way.
// SABOTAGE: let the alias key overwrite the canonical one with a value that is
// then never compared -> the commit branch loses its stamp -> red.
test('H4b (AMBIGUITY, either reading): two spellings of one path that AGREE are never silently mishandled — commit+stamp, or refuse+preserve', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', NEW);
    const stagedA = stagedBlob(dir, 'src/laneA.mjs');
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': stagedA, './src/laneA.mjs': stagedA } }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runCommitReviewed(dir, ['-m', 'H4b agreeing spellings']);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `an alias key must never crash the CLI — stderr=${flat(r.stderr)}`);
    if (r.code === 0) {
      assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'if it commits, the commit really happened');
      assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'and the receipt is stamped normally');
      assert.deepEqual(readLedger(dir), [], 'and consumed normally');
    } else {
      assert.equal(r.code, 1, `a refusal is exit 1, never another code — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, 'if it refuses, no commit was created');
      assert.equal(readLedgerRaw(dir), before, 'and nothing was consumed');
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// H5 — AMEND MODE KEEPS EVERY Reviewed-By-Agent TRAILER.
//
// §2: "--target-sha gets identical enforcement against the TARGET COMMIT'S
// TREE"; Reviewed-By-Agent stamping is UNCHANGED by the flip.
//
// THE DEFECT: git's `--trailer` defaults to `ifexists=addIfDifferent`, which
// silently DROPS a second trailer whose value equals an existing one. Two
// receipts from the same reviewer agent_type — an ordinary shape when one
// reviewer returns twice over different files — therefore collapse into one
// trailer, and the durable record then under-counts the reviews that happened.
// This is invisible to every single-receipt amend pin.
// ===========================================================================

// EXPECTED STATE: GREEN once --target-sha amend mode is live (pinned by
// commit-reviewed-target-sha.test.mjs and the frozen F0). CONTROL, placed
// first: it proves amend-mode stamping works at all, so a red H5a is a
// DUPLICATE-COLLAPSE finding and not "amend mode is broken today".
// SABOTAGE: skip stamping in amend mode -> red here and in H5a together, which
// is the signature that distinguishes the two failures.
test('H5-0 (CONTROL, first): --target-sha amend with ONE matching receipt stamps exactly one Reviewed-By-Agent trailer', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    seedConfig(dir);
    const targetSha = commitPlain(dir, 'reviewed change', 'src/reviewed.mjs', NEW);
    writeLedger(dir, [
      v1({
        agent_type: 'reviewer-correctness',
        files: ['src/reviewed.mjs'],
        blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') },
        base_sha: targetSha,
      }),
    ]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], { ...ENV_SESSION, ...SEAM_ON });
    assert.equal(r.code, 0, `a matching amend must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'exactly one trailer for one receipt');
    assert.deepEqual(readLedger(dir), [], 'the receipt is consumed');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today — with git's default addIfDifferent the second
// identical value is dropped, so `reviewedByTrailers` returns ONE element and
// the deepEqual against a two-element multiset fires. (If the current code
// instead de-duplicates by agent_type before stamping, the same assertion fires
// for the same reason.)
// SABOTAGE: revert the trailer to `ifexists=addIfDifferent` (or dedupe the
// stamped agent_type set) -> length 1 -> red. Nothing else in either suite can
// see this: every other stamping pin uses DISTINCT agent_types, where
// addIfDifferent and add behave identically. That is the whole reason this
// fixture repeats one agent_type rather than varying it.
// NOTE ON THE VERDICT'S CAUSE: exit 0 alone would be satisfiable by an amend
// that stamped nothing, so the multiset — not the exit code — carries this pin.
test('H5a: --target-sha amend with TWO receipts sharing one agent_type keeps BOTH Reviewed-By-Agent trailers — trailer.ifexists=add, never addIfDifferent', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    seedConfig(dir);
    // One target commit touching TWO files, so both receipts cover it.
    stageChange(dir, 'src/reviewed.mjs', NEW);
    stageChange(dir, 'src/other.mjs', NEW);
    git(dir, ['commit', '-m', 'reviewed change over two files']);
    const targetSha = git(dir, ['rev-parse', 'HEAD']);

    writeLedger(dir, [
      v1({
        agent_type: 'reviewer-correctness',
        files: ['src/reviewed.mjs'],
        blobs: { 'src/reviewed.mjs': treeBlob(dir, targetSha, 'src/reviewed.mjs') },
        at: isoAgo(90_000),
        base_sha: targetSha,
      }),
      v1({
        agent_type: 'reviewer-correctness',
        files: ['src/other.mjs'],
        blobs: { 'src/other.mjs': treeBlob(dir, targetSha, 'src/other.mjs') },
        at: isoAgo(60_000),
        base_sha: targetSha,
      }),
    ]);

    const r = runCommitReviewed(dir, ['--target-sha', targetSha], { ...ENV_SESSION, ...SEAM_ON });
    assert.equal(r.code, 0, `both receipts match the target tree, so the amend must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const newSha = git(dir, ['rev-parse', 'HEAD']);
    assert.notEqual(newSha, targetSha, 'the commit was amended');
    assert.deepEqual(
      reviewedByTrailers(dir, newSha),
      ['reviewer-correctness', 'reviewer-correctness'],
      'TWO reviews happened, so TWO trailers survive — a collapsed multiset under-reports the review record'
    );
    assert.deepEqual(readLedger(dir), [], 'both receipts are consumed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// H6 — A FLAG-SHAPED WAIVER REASON IS REFUSED.
//
// §2: "--waive-bytes '<single-line bounded sanitized reason>'".
//
// THE DEFECT: a reason beginning with `--` is either (a) a swallowed flag — the
// user typed `--waive-bytes --amend` and the CLI recorded "--amend" as the
// accountability text while silently dropping the flag they meant — or (b) an
// empty accountability record dressed as a reason. Both produce a commit whose
// waiver trailer documents nothing. The frozen E2a/E2b/E2c cover newline,
// overlong and empty reasons; this shape passes all three.
// ===========================================================================

// EXPECTED STATE: RED today only if the flag itself is unimplemented; otherwise
// GREEN today AND after the fix. CONTROL, placed first: a legitimate reason that
// CONTAINS `--` mid-string. It proves H6a's refusals come from the LEADING `--`
// (a flag-shaped argument) and not from a blanket ban on dashes in prose, which
// would quietly make ordinary reasons unwritable.
// SABOTAGE: reject any reason containing '--' anywhere -> red here, green in
// H6a — the over-broad reading this control forbids.
test('H6-0 (CONTROL, first): a waiver reason CONTAINING "--" mid-string is accepted and the commit lands', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA } })]);

    const r = runCommitReviewed(dir, ['-m', 'H6-0 dashes in prose', '--waive-bytes', 'reviewer re-read the changed lines -- by hand, see thread 01a057ee']);
    assert.equal(r.code, 0, `an ordinary reason that happens to contain "--" must be accepted — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'the waived commit was created');
    assert.equal(waiverTrailers(dir).length, 1, `and the waiver is recorded — got ${JSON.stringify(waiverTrailers(dir))}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today. For the bare `--` arm the likely current behaviour
// is that `--` is consumed as an end-of-options marker or accepted as the reason
// verbatim, so the run commits (exit 0) and `code !== 0` fires; for the
// `--waive-reviews` arm the reason is accepted verbatim and the same assertion
// fires.
// THE /reason/i ASSERTION IS THE DISCRIMINATOR, exactly as in the frozen E2a: a
// generic "unrecognized option" or "missing argument" failure would exit
// non-zero for a DIFFERENT cause, so without it a green here would not prove the
// reason was what was judged.
// SABOTAGE: accept any non-empty string as a reason (drop the flag-shape check)
// -> exit 0 -> red. SECOND SABOTAGE: refuse with a bare usage error that never
// says "reason" -> the /reason/i assertion goes red while `code !== 0` stays
// green — the wrong-cause shape this arm is built to separate.
test('H6a: a flag-shaped --waive-bytes reason ("--", or one starting with "--") is REFUSED about the REASON — no commit, ledger byte-identical', { skip: GIT_SKIP }, () => {
  for (const [label, reason] of [['bare-dashdash', '--'], ['flag-shaped', '--waive-reviews I already checked it']]) {
    const { dir, cleanup } = makeRepo();
    try {
      const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [v1({ agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': reviewedA } })]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', `H6a ${label}`, '--waive-bytes', reason]);
      assert.notEqual(r.code, 0, `[${label}] a flag-shaped waiver reason records no accountability and must be refused — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, `[${label}] no commit was created`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
      assert.match(r.stderr, /reason/i, `[${label}] the refusal must be ABOUT THE REASON, not a generic usage error — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// H7 — files[] IS PART OF THE v1 WAIVER FINGERPRINT.
//
// §2: "one Review-Bytes-Waiver trailer per affected receipt (entry_id for v2,
// stable fingerprint for v1)".
//
// THE DEFECT: "one per affected receipt" is only meaningful if the fingerprint
// SEPARATES receipts. A fingerprint computed over reviewer + timestamp alone
// collides for two receipts from the same reviewer at the same instant covering
// DIFFERENT territory — the commonest real shape, since receipts are minted by
// one Stop handler. The trailers then either duplicate an identical value or
// collapse to one, and the durable record no longer says which territory was
// overridden. The frozen E3 pins the opposite direction only (identical receipts
// fingerprint identically) and cannot see a collision.
// ===========================================================================

// EXPECTED STATE: GREEN today AND after the fix (it is the frozen E3's property,
// restated in-file as this family's control). PLACED FIRST and passing for the
// OPPOSITE reason to H7a: two receipts with the SAME territory must fingerprint
// the SAME. Without it, a fingerprint that is a per-stamp counter or a random
// value satisfies H7a's "they differ" assertion perfectly while identifying
// nothing at all.
// SABOTAGE: mint the fingerprint with randomUUID() or a stamping index -> the
// two values differ -> red here, while H7a stays green. That pair of results is
// the signature of a non-deterministic fingerprint.
// TOLERANT ON COUNT, STRICT ON VALUE: whether byte-identical receipts produce
// one trailer or two identical ones is not specified by §2, so this asserts the
// DISTINCT-value count, which is what "fingerprint" means either way.
test('H7-0 (CONTROL, first): two BYTE-IDENTICAL v1 receipts waived in one invocation fingerprint to ONE distinct value — the fingerprint is receipt-derived, not per-stamp', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const twin = {
      agent_type: 'reviewer-correctness',
      files: ['src/laneA.mjs'],
      at: '2026-08-31T09:00:00.000Z',
      session_id: SESSION,
      branch: 'main',
      base_sha: 'f'.repeat(40),
      reviewed_state: { blobs: { 'src/laneA.mjs': reviewedA }, completed_at: '2026-08-31T09:00:00.000Z' },
    };
    writeLedger(dir, [twin, JSON.parse(JSON.stringify(twin))]);

    const r = runCommitReviewed(dir, ['-m', 'H7-0 identical receipts', '--waive-bytes', 'stable fingerprint probe']);
    assert.equal(r.code, 0, `the waived commit must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const waivers = waiverTrailers(dir);
    assert.ok(waivers.length >= 1, `at least one waiver trailer is stamped — got ${JSON.stringify(waivers)}`);
    assert.equal(new Set(waivers).size, 1, `identical receipts fingerprint identically — got ${JSON.stringify(waivers)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today if files[] is outside the fingerprint — the two
// receipts then produce the SAME value, and git's addIfDifferent (or an explicit
// dedupe) collapses them, so either `waivers.length === 2` fires or, if both
// identical values survive, `new Set(waivers).size === 2` fires. GREEN today
// only if the shipped fingerprint already covers files[], in which case this is
// a regression guard rather than a fix pin — reported as such, not assumed.
// FIXTURE DESIGN, load-bearing: the two receipts differ in `files` and in
// NOTHING ELSE — same agent_type, same `at`, same session_id, same branch, same
// base_sha, and the SAME blobs map (both paths bound in both receipts). Varying
// agent_type would make the values differ for a reason that has nothing to do
// with territory and would leave the defect uncaught; varying blobs would leave
// it ambiguous whether files[] or blobs did the separating.
// SABOTAGE: drop files[] from the fingerprint input (hash agent_type + at +
// session_id only) -> the two values collide -> red, while H7-0 and the frozen
// E3 both stay green. Neither of those can see this class.
test('H7a: two v1 receipts identical EXCEPT files[], both waived in one invocation, produce DIFFERENT Review-Bytes-Waiver values — territory is part of the fingerprint', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const reviewedA = stageChangedSinceReview(dir, 'src/laneA.mjs', OLD, NEW);
    const reviewedB = stageChangedSinceReview(dir, 'src/laneB.mjs', OLD, NEW);
    const head = git(dir, ['rev-parse', 'HEAD']);

    // One shared, identical evidence map; the ONLY difference is territory.
    const sharedBlobs = { 'src/laneA.mjs': reviewedA, 'src/laneB.mjs': reviewedB };
    const common = {
      agent_type: 'reviewer-correctness',
      at: '2026-08-31T09:00:00.000Z',
      session_id: SESSION,
      branch: 'main',
      base_sha: 'f'.repeat(40),
    };
    const entryA = { ...common, files: ['src/laneA.mjs'], reviewed_state: { blobs: { ...sharedBlobs }, completed_at: common.at } };
    const entryB = { ...common, files: ['src/laneB.mjs'], reviewed_state: { blobs: { ...sharedBlobs }, completed_at: common.at } };
    assert.notDeepEqual(entryA.files, entryB.files, 'fixture guard: territory differs');
    assert.deepEqual(
      { ...entryA, files: null },
      { ...entryB, files: null },
      'fixture guard: the two receipts are identical in EVERY field except files[]'
    );
    writeLedger(dir, [entryA, entryB]);

    const r = runCommitReviewed(dir, ['-m', 'H7a territory in the fingerprint', '--waive-bytes', 'both lanes re-read by hand']);
    assert.equal(r.code, 0, `the waived commit must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.notEqual(git(dir, ['rev-parse', 'HEAD']), head, 'a commit was created');

    const waivers = waiverTrailers(dir);
    assert.equal(
      waivers.length,
      2,
      `one waiver trailer per AFFECTED receipt, and both receipts were affected — a length of 1 here means two distinct receipts fingerprinted to the same value and git collapsed them — got ${JSON.stringify(waivers)}`
    );
    assert.equal(
      new Set(waivers).size,
      2,
      `two DIFFERENT receipts must carry two DIFFERENT fingerprints, or the trailer cannot say which territory was overridden — got ${JSON.stringify(waivers)}`
    );
    for (const w of waivers) {
      assert.match(w, FINGERPRINT, `each v1 waiver value is the declared fingerprint shape — got ${JSON.stringify(waivers)}`);
    }
  } finally {
    cleanup();
  }
});
