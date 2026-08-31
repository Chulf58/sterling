// REVIEW-LEDGER `discharge` — THE EXPLICIT LIFECYCLE VERB
// (campaign slice S2b-3; decision 57984926, slug
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design, §3
// "FALLBACK NARROWING + DISCHARGE").
//
// SPEC-ONLY, RED-FIRST. `scripts/review-ledger.mjs` DOES NOT EXIST YET
// (confirmed by Glob before writing: no scripts/review-ledger*.mjs). Every pin
// below therefore fails on its FIRST ASSERTION today — spawning a missing
// module exits non-zero with a MODULE_NOT_FOUND stderr, so the assertions fire
// normally rather than crashing the harness.
//
// Authored from the decision record (opened via knowledge_get; §3 quoted
// verbatim below) and the launching brief — NOT from any implementation. H4
// read wall honored: this file's author never Read nor content-Grepped
// scripts/commit-reviewed.mjs or scripts/hooks/lib/*; only sibling TEST files
// were read, for fixture conventions.
//
// SPEC UNDER TEST (decision 57984926 §3, verbatim clause):
//   "DISCHARGE is a dedicated command (scripts/review-ledger.mjs discharge),
//    explicit-only, NEVER automatic: selector is entry_id (v2) or a generated
//    legacy handle + a SHA-256 digest of the exact ledger bytes as the
//    concurrency token (mtime rejected — granularity and preserved-mtime
//    rewrites defeat it); requires a recognized unspendable class (foreign
//    session, foreign branch, conclusive no-live structured territory);
//    preserves the original evidence, sets status:'discharged' +
//    disposition{reason, at, head_sha, classifier_version, class, underlying
//    facts}; atomic locked replace; H1, spending, amend spending, fallback
//    selection and counts all ignore discharged entries; NO resurrection
//    command (a mistake is corrected by re-dispatching a reviewer); deletion is
//    never silent — durable preservation promised, a future explicit archival
//    operation left open."
// And, for the no-live class (same section):
//   "NO-LIVE-TERRITORY classification ... applies ONLY when ALL hold: v2 roster
//    receipt, structured non-empty territory, usable base_sha, git conclusively
//    compares EVERY declared path (untracked and deletions checked explicitly),
//    every path returned to base state in the mode-appropriate view; any
//    ambiguity yields 'unknown', never no-live. MODE-SPECIFIC classifier
//    semantics ... new-commit mode compares receipt base -> effective
//    index/worktree."
//
// ===========================================================================
// ASSUMED INTERFACE — STATED SO THE CONDUCTOR CAN ADJUDICATE BEFORE THE CODER
// LOCKS IT. §3 fixes the SEMANTICS (selector + ledger-bytes digest + recognized
// class + reason) but names no flag spellings. This file assumes:
//
//     node scripts/review-ledger.mjs discharge \
//       --entry-id <uuid>            # the v2 selector
//       --digest <sha256-hex>        # SHA-256 of the EXACT current ledger bytes,
//                                    # lowercase hex, no prefix
//       --class <foreign-session|foreign-branch|no-live-territory>
//       --reason "<single-line reason>"
//
//   * cwd is the project root; the ledger is .sterling/review-ledger.json
//     (the path every sibling commit-reviewed suite already uses).
//   * exit 0 = discharged; exit 1 = refused. Refusals speak on stderr.
//   * STERLING_SESSION_ID is the current-session seam (the one documented in
//     commit-reviewed-file-scoping.test.mjs's runCommitReviewedEnv).
//   * The three class tokens are the decision's own three unspendable classes,
//     spelled as kebab-case tokens.
//   IF THE CODER PICKS DIFFERENT SPELLINGS, THIS FILE'S FLAG NAMES ARE THE
//   THING TO CHANGE — the assertions inside each test are the spec and stand
//   unchanged. Every flag-name red is a naming adjudication, not a defect.
//
// FIXTURE CHOICES THAT ARE LOAD-BEARING:
//   1. D0's target entry is GENUINELY foreign-session (identity.session_id !=
//      STERLING_SESSION_ID) so the pin is green under BOTH readings of §3 —
//      "the CLI merely records the asserted class" and "the CLI verifies the
//      class holds". A same-session fixture would be ambiguous under the
//      second reading, and §3 does not say which applies to the two foreign-*
//      classes (reported as ambiguity (a) below).
//   2. D6a's receipt base_sha is deliberately NOT HEAD (HEAD has advanced past
//      it on an unrelated file), so an implementation that "classifies no-live"
//      by comparing base_sha to HEAD cannot pass it.
//   3. Every ledger seeded here carries a BYSTANDER entry that no pin
//      discharges, so every write is checked for collateral damage.
//
// AMBIGUITIES FLAGGED, NOT RESOLVED (reported to the launching agent):
//   (a) Whether `--class foreign-session|foreign-branch` is VERIFIED by the CLI
//       or merely recorded as the conductor's assertion. §3 verifies only the
//       no-live class explicitly ("conclusive no-live structured territory").
//       Fixtures above are built to be green either way; NO pin asserts a
//       refusal for a mis-asserted foreign-* class.
//   (b) The "generated legacy handle" selector for v1 entries is unspecified
//       (§3 names it without defining its generation). NOTHING here pins it —
//       the brief scopes this slice's pins to the v2 entry_id selector.
//   (c) "underlying facts" in the disposition object is named by §3 without a
//       shape. D0 asserts the five NAMED keys and deliberately does not
//       constrain any additional key.
//   (d) Whether a second `discharge` on an already-discharged entry REFUSES or
//       NO-OPS is not stated. D5 pins the invariant that holds under either
//       (never a second state flip, disposition never rewritten).
//   (e) Whether --reason is bounded/sanitized the way §2's --waive-bytes reason
//       is. D8 pins only the MISSING/EMPTY case (an accountability record with
//       no reason is not an accountability record); no length or newline bound
//       is invented here.
// ===========================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');
const COMMIT_CLI = join(root, 'scripts', 'commit-reviewed.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };

// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-review-ledger-discharge-'));
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
function readLedgerRaw(dir) {
  return existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null;
}

// THE CONCURRENCY TOKEN: SHA-256 over the EXACT ledger bytes, per §3 (mtime was
// explicitly rejected). Computed from the file, never from a re-serialization
// of the fixture object — a re-serialized digest could differ from the bytes on
// disk and would make a "stale digest" red ambiguous.
function ledgerDigest(dir) {
  return createHash('sha256').update(readFileSync(ledgerPath(dir))).digest('hex');
}

// "atomic locked replace" is not directly observable from outside the process;
// what IS observable is that no half-written sibling survives the call. A
// `.lock` file is excluded — a lock is a legitimate artifact of the mechanism,
// a `.tmp`/`.new`/partial copy is residue (P4).
function assertNoLedgerResidue(dir, label) {
  const residue = readdirSync(join(dir, '.sterling')).filter(
    (n) => /^review-ledger\.json\..+/.test(n) && !n.endsWith('.lock')
  );
  assert.deepEqual(residue, [], `${label}: the replace leaves no partial ledger behind — got ${JSON.stringify(residue)}`);
}

function stageChange(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}
function commitFile(dir, relPath, content) {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', `seed ${relPath}`]);
  return git(dir, ['hash-object', relPath]);
}
function stagedBlob(dir, relPath) {
  return git(dir, ['hash-object', relPath]);
}

function runLedger(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runCommitReviewed(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [COMMIT_CLI, ...args], {
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

// v2 entry per decision 57984926 §1, structurally complete (a deficient v2
// entry is withheld for a DIFFERENT reason — file-scoping S13).
function v2({
  entry_id,
  agent_type,
  files,
  blobs = {},
  base_sha,
  session_id = SESSION,
  branch = 'main',
  source = 'review-territory',
  status = 'active',
  disposition = null,
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
    identity: { session_id, branch, base_sha },
    territory: { files, source, attribution: 'block' },
    content_evidence: { status: 'complete', blobs, absent_paths: [], truncated_of: null, failure_reason: null },
    disposition,
  };
}

const TARGET_ID = 'd0000000-0000-4000-8000-00000000000a';
const BYSTANDER_ID = 'd0000000-0000-4000-8000-00000000000b';
const CODE = 'export const f = 1;\n';
const OTHER = 'export const f = 2;\n';

// A bystander that no pin ever discharges — every write is checked against it.
function bystander(base_sha) {
  return v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-bystander', files: ['src/base.mjs'], base_sha });
}

// ===========================================================================
// D0 — THE HAPPY PATH (CONTROL, PLACED FIRST).
// Every refusal pin in this file (D2, D3, D7, D8, D6b, D6c) would be satisfied
// identically by a `discharge` that refuses EVERYTHING — including a stub that
// does not exist. This pin is the evidence that they are not: without D0 green,
// no refusal pin here carries a verdict.
// ===========================================================================

// EXPECTED STATE: RED today — scripts/review-ledger.mjs does not exist, so the
// spawn exits non-zero and the first assertion (`r.code === 0`) fails.
// SABOTAGE (preservation half): implement discharge as a DELETE (splice the
// entry out) -> `after.length === 2` and the evidence deepEqual go red. §3's
// "deletion is never silent — durable preservation promised" is the whole point
// of the verb, and a delete would otherwise look like a perfectly good pass.
// SABOTAGE (disposition half): write status:'discharged' but leave
// disposition null -> the five named-key assertions go red while status stays
// green. Those are two independent guards; both are load-bearing here.
test('discharge D0 (CONTROL, first): a v2 roster receipt is discharged by entry_id with a matching ledger digest — evidence PRESERVED, status discharged, disposition recorded, ledger still valid JSON', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({
      entry_id: TARGET_ID,
      agent_type: 'reviewer-security',
      files: ['src/base.mjs'],
      blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') },
      base_sha: head,
      session_id: 'a-session-that-ended', // genuinely foreign — fixture choice 1
    });
    const other = bystander(head);
    writeLedger(dir, [target, other]);

    const reason = 'session ended before the receipt could be spent; work landed under a later review';
    const tMin = Date.now() - 1_000;
    const r = runLedger(dir, [
      'discharge',
      '--entry-id', TARGET_ID,
      '--digest', ledgerDigest(dir),
      '--class', 'foreign-session',
      '--reason', reason,
    ]);
    assert.equal(r.code, 0, `a well-formed discharge must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const after = readLedger(dir);
    assert.ok(Array.isArray(after), `the ledger is still valid JSON holding an array — raw=${flat(readLedgerRaw(dir))}`);
    assert.equal(after.length, 2, `NOTHING is deleted — a discharge preserves the record, it does not remove it — got ${JSON.stringify(after)}`);

    const [discharged, untouched] = [after.find((e) => e.entry_id === TARGET_ID), after.find((e) => e.entry_id === BYSTANDER_ID)];
    assert.ok(discharged, 'the discharged entry is still addressable by its entry_id');
    assert.deepEqual(untouched, other, 'the bystander entry is byte-for-byte untouched — a discharge writes exactly one entry');

    // THE EVIDENCE IS THE POINT: every field that constitutes the review record
    // survives the state flip unchanged.
    assert.deepEqual(discharged.reviewer, target.reviewer, 'the reviewer provenance is preserved');
    assert.deepEqual(discharged.territory, target.territory, 'the reviewed territory is preserved');
    assert.deepEqual(discharged.content_evidence, target.content_evidence, 'the content evidence is preserved');
    assert.deepEqual(discharged.identity, target.identity, 'the identity is preserved');
    assert.equal(discharged.started_at, target.started_at, 'started_at is preserved');
    assert.equal(discharged.finished_at, target.finished_at, 'finished_at is preserved');

    assert.equal(discharged.status, 'discharged', 'the status flips to discharged');

    const d = discharged.disposition;
    assert.ok(d && typeof d === 'object', `the disposition object is recorded, never left null — got ${JSON.stringify(d)}`);
    assert.equal(d.reason, reason, 'the conductor-supplied reason is recorded verbatim');
    assert.equal(d.class, 'foreign-session', 'the recognized class is recorded');
    assert.equal(d.head_sha, git(dir, ['rev-parse', 'HEAD']), 'head_sha pins WHEN in history the discharge was decided');
    assert.ok(
      d.classifier_version !== undefined && d.classifier_version !== null && String(d.classifier_version) !== '',
      `classifier_version is recorded so a later reader knows which rules produced this verdict — got ${JSON.stringify(d.classifier_version)}`
    );
    const at = Date.parse(d.at);
    assert.ok(Number.isFinite(at), `disposition.at is a parseable timestamp — got ${JSON.stringify(d.at)}`);
    assert.ok(at >= tMin && at <= Date.now() + 1_000, `disposition.at is the moment of the discharge, not a copied review timestamp — got ${JSON.stringify(d.at)}`);

    assertNoLedgerResidue(dir, 'D0');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// D2 / D3 / D7 / D8 — THE REFUSAL FAMILY. Each refusal fixture is D0's fixture
// with EXACTLY ONE thing wrong, and every one of them supplies a CORRECT value
// for everything else, so a green cannot come from a different cause.
// ===========================================================================

// EXPECTED STATE: RED today (the CLI is absent, so `after` reads the seeded
// ledger and the code/naming assertions on a MODULE_NOT_FOUND stderr fail —
// specifically the /digest/i assertion, which a module-not-found message does
// not satisfy).
// SABOTAGE: accept the discharge whenever the digest is merely PRESENT (or
// compare it against a re-serialization of the parsed ledger rather than the
// bytes on disk) -> the concurrency token stops detecting the concurrent write,
// exit 0, status flips -> the code and status assertions go red. That is the
// exact failure §3 rejected mtime for.
test('discharge D2: a STALE digest (the ledger changed after the digest was taken) is REFUSED — nothing written, the ledger byte-identical, the refusal names the mismatch', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' });
    writeLedger(dir, [target]);

    const staleDigest = ledgerDigest(dir);
    // A CONCURRENT WRITER lands between the read and the discharge — exactly the
    // race the token exists for (an H22 promotion appending a fresh receipt).
    writeLedger(dir, [target, bystander(head)]);
    const before = readLedgerRaw(dir);
    assert.notEqual(staleDigest, ledgerDigest(dir), 'fixture guard: the ledger genuinely changed, so the digest is genuinely stale');

    const r = runLedger(dir, [
      'discharge',
      '--entry-id', TARGET_ID,
      '--digest', staleDigest,
      '--class', 'foreign-session',
      '--reason', 'stale token must not be honoured',
    ]);
    assert.notEqual(r.code, 0, `a stale concurrency token must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — a refused discharge writes nothing at all');
    assert.match(r.stderr, /digest|checksum|sha-?256|changed|stale/i, `the refusal must be ABOUT THE TOKEN MISMATCH, not a generic error — stderr=${flat(r.stderr)}`);
    assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', 'and the target entry is still active');
    assertNoLedgerResidue(dir, 'D2');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the CLI is absent; the /class/i assertion fails on
// a MODULE_NOT_FOUND stderr).
// SABOTAGE: record whatever `--class` string is supplied without checking it
// against the recognized set -> exit 0 and the entry flips to discharged with a
// made-up class -> the code, status and byte-identical assertions go red. An
// unrecognized class is exactly how "discharge" would decay into "delete
// anything I do not want to see" (P5: unknown signals halt).
test('discharge D3: an UNRECOGNIZED class is REFUSED — nothing written, ledger byte-identical, the refusal is about the class', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' });
    writeLedger(dir, [target, bystander(head)]);
    const before = readLedgerRaw(dir);

    // Everything else is CORRECT — a fresh digest, a real entry_id, a real
    // reason — so the only possible cause of a refusal is the class.
    const r = runLedger(dir, [
      'discharge',
      '--entry-id', TARGET_ID,
      '--digest', ledgerDigest(dir),
      '--class', 'because-i-said-so',
      '--reason', 'an unrecognized class must never be honoured',
    ]);
    assert.notEqual(r.code, 0, `an unrecognized unspendable class must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'NOTHING is written on the refusal path');
    assert.match(r.stderr, /class/i, `the refusal must be ABOUT THE CLASS — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `and it is a refusal, not a crash — stderr=${flat(r.stderr)}`);
    assertNoLedgerResidue(dir, 'D3');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the CLI is absent; the /entry|selector|not found/i
// assertion fails on a MODULE_NOT_FOUND stderr).
// SABOTAGE: fall back to "the only entry" / "the first entry" when the selector
// matches nothing -> the bystander is discharged, the length-2/status
// assertions go red. A forgiving selector on a state-changing operation is the
// shape anti-pattern no-bounded-trail-guard-for-destructive-addressing forbids.
test('discharge D7: an entry_id matching NO entry is REFUSED — no other entry is discharged in its place, ledger byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [bystander(head)]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge',
      '--entry-id', 'ffffffff-0000-4000-8000-00000000ffff',
      '--digest', ledgerDigest(dir),
      '--class', 'foreign-session',
      '--reason', 'no such entry',
    ]);
    assert.notEqual(r.code, 0, `an unknown selector must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.equal(readLedger(dir)[0].status, 'active', 'the ONLY entry present is not discharged as a consolation prize');
    assert.match(r.stderr, /entr|selector|not found|no match/i, `the refusal names the addressing failure — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the CLI is absent; the /reason/i assertion fails on
// a MODULE_NOT_FOUND stderr).
// SABOTAGE: default a missing/empty reason to '' or 'discharged' and proceed ->
// exit 0, the entry flips with an empty accountability record -> the code and
// byte-identical assertions go red. The reason IS the accountability §3 chose
// explicit discharge for over silent auto-discharge; an empty one is the
// auto-discharge that decision rejected, wearing a flag.
test('discharge D8: a MISSING or EMPTY --reason is REFUSED — an accountability record with no reason is not an accountability record', { skip: GIT_SKIP }, () => {
  for (const [label, extra] of [['missing', []], ['empty', ['--reason', '']]]) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' });
      writeLedger(dir, [target]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge',
        '--entry-id', TARGET_ID,
        '--digest', ledgerDigest(dir),
        '--class', 'foreign-session',
        ...extra,
      ]);
      assert.notEqual(r.code, 0, `[${label}] a discharge without a reason must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] ledger byte-identical`);
      assert.match(r.stderr, /reason/i, `[${label}] the refusal must be ABOUT THE REASON — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// D4 — DISCHARGED ENTRIES ARE INVISIBLE TO SPENDING (§3: "spending, amend
// spending, fallback selection and counts all ignore discharged entries").
// ===========================================================================

// EXPECTED STATE: GREEN today (two active receipts covering the staged file are
// both stamped and both consumed — file-scoping S1's shape in v2 clothing).
// PLACED FIRST in this family on purpose: D4's verdict ("only the active one
// stamps") has two possible causes — the discharged entry was ignored, or the
// second entry never stamps for some unrelated reason (a v2 adapter defect, a
// duplicate-agent_type dedupe, an eligibility rule). This control is identical
// EXCEPT that both entries are active, so it must pass for the OPPOSITE reason.
// SABOTAGE: dedupe stamped receipts by agent_type or stamp only the first
// eligible receipt -> one trailer instead of two -> red, and D4's green is
// exposed as meaningless.
test('discharge D4 (CONTROL): two ACTIVE v2 receipts covering the staged file are BOTH stamped and BOTH consumed — the same fixture as D4 minus the discharged status', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], blobs, base_sha: head }),
      v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs, base_sha: head }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D4 control: both active']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir).sort(), ['reviewer-correctness', 'reviewer-security'], 'both ACTIVE receipts are stamped');
    assert.deepEqual(readLedger(dir), [], 'and both are consumed');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today — nothing reads `status` yet, so the discharged
// receipt is stamped and consumed exactly like an active one: the trailer
// deepEqual (two values instead of one) and the survivor assertions both fail.
// SABOTAGE: filter discharged entries out of the STAMPED set but not out of the
// CONSUMED set -> the trailer assertion stays green while the survival
// assertions go red. That is the dangerous half: silently destroying preserved
// evidence is precisely what §3's "deletion is never silent" forbids, and the
// trailer pin alone cannot see it.
// SECOND SABOTAGE: read `status !== 'active'` as ineligible-but-consumable, or
// treat a missing status as discharged -> the D4 CONTROL above goes red, which
// is how a mis-read of the compatibility adapter ("missing status = active") is
// caught rather than mistaken for this pin passing.
test('discharge D4: a DISCHARGED v2 receipt covering the staged file is neither stamped nor consumed — only the active receipt spends, and the discharged one SURVIVES the consume write', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };

    const dischargedEntry = v2({
      entry_id: TARGET_ID,
      agent_type: 'reviewer-security',
      files: ['src/laneA.mjs'],
      blobs,
      base_sha: head,
      status: 'discharged',
      disposition: {
        reason: 'the session that produced it ended',
        at: isoAgo(30_000),
        head_sha: head,
        classifier_version: 1,
        class: 'foreign-session',
      },
    });
    writeLedger(dir, [
      dischargedEntry,
      v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs, base_sha: head }),
    ]);

    const r = runCommitReviewed(dir, ['-m', 'D4 discharged is not spendable']);
    assert.equal(r.code, 0, `an active receipt covers the diff, so the commit succeeds — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'a discharged receipt NEVER earns a Reviewed-By-Agent trailer — that would be an attestation from evidence already ruled unspendable');
    const after = readLedger(dir);
    assert.equal(after.length, 1, `the discharged entry survives the consume write — got ${JSON.stringify(after)}`);
    assert.deepEqual(after, [dischargedEntry], 'and survives byte-identical, disposition intact — preserved evidence is never collateral of a consume');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// D5 — NO RESURRECTION (§3: "NO resurrection command (a mistake is corrected by
// re-dispatching a reviewer)").
// ===========================================================================

// EXPECTED STATE: RED today (the CLI is absent, so the FIRST discharge fails
// and `first.code === 0` reddens).
// SABOTAGE (the one this pin exists for): make discharge idempotent by
// REWRITING the disposition on a second call -> the reason/at preservation
// assertions go red while status stays 'discharged'. A silently rewritten
// disposition is a second state flip wearing the first one's clothes: it lets a
// later, weaker justification overwrite the recorded one with no trace.
// EITHER-READING: §3 does not say whether a repeat discharge refuses or no-ops
// (ambiguity (d)), so the exit code is asserted only as "defined and not a
// crash"; the invariant pinned is that the RECORD never flips twice.
test('discharge D5: a second discharge of an already-discharged entry never flips state twice — the original disposition is preserved verbatim, whichever way the repeat is handled', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    // ONE construction, used for both the seed and the expected value. bystander()
    // defaults `at = isoAgo(60_000)`, which is evaluated PER CALL, so a second
    // construction differs from the seeded one by the milliseconds between them
    // and the deepEqual below could never pass on a byte-correct ledger. Same
    // idiom as D0's `const other = bystander(head)`.
    const other = bystander(head);
    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' }),
      other,
    ]);

    const firstReason = 'the original, accountable justification';
    const first = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'foreign-session', '--reason', firstReason,
    ]);
    assert.equal(first.code, 0, `the first discharge succeeds — stdout=${first.stdout} stderr=${flat(first.stderr)}`);
    const afterFirst = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
    assert.equal(afterFirst.status, 'discharged', 'precondition: the entry is discharged');

    // A fresh digest — the ledger legitimately changed — so a refusal here can
    // only be about the repeat, never about a stale token.
    const second = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'no-live-territory', '--reason', 'a different, later justification',
    ]);
    assert.doesNotMatch(second.stderr, /TypeError|ReferenceError/, `a repeat discharge must never crash — stderr=${flat(second.stderr)}`);

    const afterSecond = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
    assert.equal(afterSecond.status, 'discharged', 'the status is still discharged — never toggled, never re-flipped');
    assert.deepEqual(
      afterSecond.disposition,
      afterFirst.disposition,
      `the ORIGINAL disposition survives verbatim — a repeat discharge may refuse or no-op, but it may never overwrite the recorded justification: ${JSON.stringify(afterSecond.disposition)}`
    );
    assert.deepEqual(readLedger(dir).find((e) => e.entry_id === BYSTANDER_ID), other, 'and the bystander is still untouched');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the CLI is absent, so the first discharge fails and
// `first.code === 0` reddens).
// SABOTAGE: add any un-discharge/restore verb that sets status back to 'active'
// -> the status assertion goes red for that verb. §3 is explicit that a mistake
// is corrected by RE-DISPATCHING A REVIEWER, not by resurrecting spent-looking
// evidence: a resurrect verb would make the ledger's discharged state
// round-trippable and therefore worthless as a record.
// NOTE: this pin asserts the ABSENCE of an interface, so it invents no flag
// spellings — it names the four plausible verbs and requires that none of them
// produce an active entry, whatever the CLI calls its subcommands.
test('discharge D5b: the CLI exposes NO resurrection — no undischarge/restore/reactivate/resurrect verb returns a discharged entry to active', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' })]);

    const first = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'foreign-session', '--reason', 'unspendable, recorded',
    ]);
    assert.equal(first.code, 0, `precondition: the discharge succeeds — stdout=${first.stdout} stderr=${flat(first.stderr)}`);

    for (const verb of ['undischarge', 'restore', 'reactivate', 'resurrect']) {
      const r = runLedger(dir, [verb, '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--reason', 'put it back']);
      assert.notEqual(r.code, 0, `[${verb}] an unknown verb halts loudly (P5) rather than succeeding quietly — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(
        readLedger(dir).find((e) => e.entry_id === TARGET_ID).status,
        'discharged',
        `[${verb}] a discharged entry can never be returned to active — the correction for a mistaken discharge is re-dispatching a reviewer`
      );
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// D6 — NO-LIVE-TERRITORY IS CONCLUSIVE OR IT IS NOTHING.
// ===========================================================================

// EXPECTED STATE: RED today (the CLI is absent; `r.code === 0` reddens).
// FIXTURE (choice 2): HEAD has advanced PAST the receipt's base_sha on an
// unrelated file, and the reviewed file was changed and then reverted, so the
// declared path equals its base state in the index/worktree while base_sha is
// NOT HEAD.
// SABOTAGE (the shortcut this fixture exists to kill): classify no-live by
// comparing base_sha to HEAD (or by `git status --porcelain` being empty) ->
// with HEAD moved past base_sha the classifier says "unknown" and refuses ->
// exit 0 assertion red. Both shortcuts pass a naive fixture where base_sha ==
// HEAD, which is why this one deliberately moves HEAD.
// PLACED BEFORE D6b/D6c as their control: without it, their refusals are
// satisfied by a classifier that refuses no-live-territory unconditionally.
test('discharge D6a (CONTROL for the no-live family): --class no-live-territory succeeds when every declared path is back at its base state — even though HEAD has moved past base_sha', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, 'src/laneA.mjs', CODE);
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances; laneA untouched
    // A genuine round trip: laneA is edited, then returned to its base bytes.
    stageChange(dir, 'src/laneA.mjs', OTHER);
    stageChange(dir, 'src/laneA.mjs', CODE);
    assert.equal(
      stagedBlob(dir, 'src/laneA.mjs'),
      git(dir, ['rev-parse', `${baseSha}:src/laneA.mjs`]),
      'fixture guard: the declared path really is back at its base-state blob'
    );
    assert.notEqual(baseSha, git(dir, ['rev-parse', 'HEAD']), 'fixture guard: HEAD has genuinely moved past base_sha');

    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], base_sha: baseSha }),
      bystander(baseSha),
    ]);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'no-live-territory', '--reason', 'the reviewed change was reverted; nothing of it remains to commit',
    ]);
    assert.equal(r.code, 0, `a conclusive no-live classification must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const entry = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
    assert.equal(entry.status, 'discharged', 'the entry is discharged');
    assert.equal(entry.disposition.class, 'no-live-territory', 'and records the class it was classified under');
    assert.deepEqual(entry.territory, { files: ['src/laneA.mjs'], source: 'review-territory', attribution: 'block' }, 'with its territory evidence preserved');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: RED today (the CLI is absent; the /live|revert|differ/i
// assertion fails on a MODULE_NOT_FOUND stderr).
// SABOTAGE: classify no-live from the paths that DO match base and ignore the
// ones that do not (an `.some()` where §3 requires "EVERY declared path") ->
// both arms below discharge a receipt whose territory is still live -> the
// code/status assertions go red. That is the classifier defect with real
// consequences: discharging live territory destroys the requirement that the
// work be reviewed before it commits.
// TWO ARMS because §3 says deletions are checked EXPLICITLY: a MODIFIED path
// and a DELETED path are different comparisons and one guard need not cover the
// other.
test('discharge D6b: --class no-live-territory is REFUSED when a declared path DIFFERS from its base state — modified or deleted; live territory is never dischargeable as no-live', { skip: GIT_SKIP }, () => {
  for (const arm of ['modified', 'deleted']) {
    const { dir, cleanup } = makeRepo();
    try {
      commitFile(dir, 'src/laneA.mjs', CODE);
      commitFile(dir, 'src/laneB.mjs', CODE);
      const baseSha = git(dir, ['rev-parse', 'HEAD']);
      commitFile(dir, 'src/unrelated.mjs', OTHER);

      if (arm === 'modified') {
        stageChange(dir, 'src/laneA.mjs', OTHER); // still live
      } else {
        unlinkSync(join(dir, 'src', 'laneA.mjs'));
        git(dir, ['add', '-A']); // a deletion is a difference from base, not a revert
      }

      // laneB IS back at base — so a classifier that stops at the first
      // satisfied path, or that ORs across paths, would wrongly conclude
      // no-live. §3 requires EVERY declared path.
      writeLedger(dir, [
        v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs', 'src/laneB.mjs'], base_sha: baseSha }),
      ]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', 'no-live-territory', '--reason', `${arm} territory must not classify as no-live`,
      ]);
      assert.notEqual(r.code, 0, `[${arm}] a declared path that differs from base makes the classification NOT conclusive — REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical — a refused classification writes nothing`);
      assert.equal(readLedger(dir)[0].status, 'active', `[${arm}] and the receipt stays spendable`);
      assert.match(r.stderr, /live|revert|differ|base|classif|ambig/i, `[${arm}] the refusal is about the classification, not a generic error — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, /src\/laneA\.mjs/, `[${arm}] and names the path that is still live — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});

// EXPECTED STATE: RED today (the CLI is absent; the /class|structur|base|v2/i
// assertion fails on a MODULE_NOT_FOUND stderr).
// SABOTAGE: run the no-live comparison on whatever paths the entry happens to
// declare, without first checking the three PRECONDITIONS §3 lists (v2 roster
// receipt / structured non-empty territory / usable base_sha) -> all three arms
// discharge, and the code/status assertions go red. Each arm is a DIFFERENT
// precondition, so one guard cannot cover another: a legacy entry has no
// territory.source at all; a free-prose entry has measured-unreliable paths
// (finding 289cd172) whose "no live territory" verdict is about the wrong
// files; a null base_sha has nothing conclusive to compare against.
// NOTE the fixtures are otherwise CLEAN — the declared path is genuinely at its
// base state in every arm — so the ONLY possible cause of a refusal is the
// failed precondition, never a live-territory finding.
test('discharge D6c: --class no-live-territory is REFUSED when a precondition fails — legacy v1 entry, free-prose territory, or absent base_sha — even though the declared path IS at base state', { skip: GIT_SKIP }, () => {
  // Per-arm refusal wording. The legacy-v1 arm has a SECOND legitimate refusal
  // cause: §3's "generated legacy handle" is unspecified (header ambiguity (b)),
  // so a CLI that cannot address a v1 entry by entry_id at all refuses for an
  // addressing reason rather than a precondition reason — both are correct
  // refusals of the same request, so that arm accepts either wording.
  const REFUSAL_WORDS = {
    'legacy-v1': /class|structur|base|territor|ambig|v2|schema|entr|handle|not found|no match/i,
    'free-prose': /class|structur|base|territor|ambig|free.?prose|attribution/i,
    'no-base-sha': /class|structur|base|territor|ambig|base_sha/i,
  };
  for (const arm of ['legacy-v1', 'free-prose', 'no-base-sha']) {
    const { dir, cleanup } = makeRepo();
    try {
      commitFile(dir, 'src/laneA.mjs', CODE);
      const baseSha = git(dir, ['rev-parse', 'HEAD']);
      commitFile(dir, 'src/unrelated.mjs', OTHER); // laneA untouched: genuinely at base state

      let entry;
      if (arm === 'legacy-v1') {
        // A flat legacy receipt: no schema_version, no territory.source.
        entry = { entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], at: isoAgo(60_000), session_id: SESSION, branch: 'main', base_sha: baseSha };
      } else if (arm === 'free-prose') {
        entry = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], base_sha: baseSha, source: 'free-prose-fallback' });
      } else {
        entry = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], base_sha: null });
      }
      writeLedger(dir, [entry]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', 'no-live-territory', '--reason', `${arm}: preconditions for no-live are not met`,
      ]);
      assert.notEqual(r.code, 0, `[${arm}] any ambiguity yields 'unknown', never no-live — REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      assert.notEqual(readLedger(dir)[0].status, 'discharged', `[${arm}] the entry is NOT discharged`);
      assert.match(r.stderr, REFUSAL_WORDS[arm], `[${arm}] the refusal names the failed precondition — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});
