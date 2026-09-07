// REVIEW-LEDGER `discharge` — THE `unattributable` AND `superseded` CLASSES, AND
// THE `digest` VERB (R1 PIN RE-CUT).
//
// AUTHORITY: decision review-receipt-rebuild-invariant-three-owner-modules-
// tri-state-liveness-receipt-bound-supersession (SUPERSESSION is receipt-bound,
// never timestamp-bound) + decision
// stale-receipts-2026-09-06-waived-because-superseded-discharge-is-truncation-blocked
// (observed_truncated removes NEGATIVE inference only; positive reads stay
// usable) + the R1 contract sheet §3.1 and §6 A9.
//
// THE TWO FORMS PINNED HERE:
//   ENTRY form  --superseded-by <entry_id>: a later reviewer-class receipt, SAME
//     BRANCH, finished_at strictly newer, lifecycle active|reserved|consumed,
//     whose POSITIVE observed_reads (never declared territory) cover every
//     covered path of the discharged receipt. Blobs need NOT be equal.
//   COMMIT form --superseded-by <sha40>: an ancestor of HEAD, a roster trailer
//     value, and a Review-Receipt trailer naming a receipt that is present,
//     consumed for THAT sha, strictly newer, and whose blobs equal the COMMIT
//     TREE's for every covered path. Committer/author dates are NEVER read.
//
// CONVENTIONS: refusals by `[code]` token / `--json`'s `code`; facts as fields.
//
// RETIRED IN THIS RE-CUT (each with its reason):
//   RETIRED: the `[refusal: <token>]` vocabulary and its S-UNIQUE source-text uniqueness pin — refusal identity now comes from the closed CODES set, which throws at construction on an unknown code, so a bespoke per-refusal token registry has nothing left to guard.
//   RETIRED: D-AUTH (three arms) and S-SYNC — both pin dischargeMarkerClass / isContentfulDisposition, the authenticity notions the rebuild collapses: a disposition either parses or the entry is malformed, so there is no second "authenticated?" verdict to keep in sync.
//   RETIRED: D10d (a survivor from another SESSION refuses) — inverted: supersession is bound to the BRANCH, not the session, so R1-C33 pins that a cross-session same-branch survivor DISCHARGES and only a branch mismatch refuses.
//   RETIRED: D10j (a TRUNCATED survivor always refuses) — inverted by the thoroughness rule: truncation removes negative inference only, so R1-C37 pins that a truncated survivor whose POSITIVE reads cover the territory discharges.
//   RETIRED: D10i's superseder-side content-evidence requirement — the superseder needs no blobs at all (blobs need not equal); what byte evidence now decides is which paths of the DISCHARGED receipt are covered at all (R1-C39).
//   RETIRED: D10h (supersession CYCLE as its own cause) — a survivor that is itself discharged is one cause with one code, [superseder_lifecycle_unacceptable]; the cycle spelling was a duplicate permutation.
//   RETIRED: D10n (the commit form's committer-instant comparison) — committer dates are mutable metadata a rebase rewrites; recency is now receipt-bound and R1-C45 pins the OPPOSITE control (a commit dated BEFORE the receipt still discharges).
//   RETIRED: D10g (the commit form checks the COMMIT'S OWN FILE LIST) — coverage did not disappear, it moved: under sheet §6 A12 the commit form requires the NAMED RECEIPT'S blob-backed covered paths to include every covered path of the discharged receipt, which R1-C51 pins. What is retired is asking the COMMIT which files it touched — a commit touching a path is not evidence anyone reviewed that path.
//   RETIRED: D11b's 'unparseable' and 'not-an-array' arms as separate cases — duplicate permutations of one code, [ledger_corrupt]; one arm kept.
//   RETIRED: S-ROSTER's "two regex literals are byte-identical" source comparison — converted: both files now IMPORT ROSTER_TRAILER_VALUE from scripts/lib/review-trailers.mjs and neither declares its own (pinned in direct-merge-trailer-pattern.test.mjs and review-trailers-owner.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const token = (c) => new RegExp('\\[' + c + '\\]');
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

// git with a pinned committer/author instant, so a pin can place a commit
// definitively BEFORE a receipt's finished_at rather than racing the wall clock.
// It exists here to prove those instants are NOT read.
function gitAtInstant(cwd, args, iso) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-review-ledger-newclass-'));
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
const ledgerDigest = (dir) => createHash('sha256').update(readFileSync(ledgerPath(dir))).digest('hex');

function assertNoLedgerResidue(dir, label) {
  const residue = readdirSync(join(dir, '.sterling')).filter((n) => /^review-ledger\.json\..+/.test(n) && !n.endsWith('.lock'));
  assert.deepEqual(residue, [], `${label}: the replace leaves no partial ledger behind — got ${JSON.stringify(residue)}`);
}

function stageChange(dir, relPath, content) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
}
const stagedBlob = (dir, relPath) => git(dir, ['hash-object', relPath]);

function runLedger(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function runLedgerJson(dir, args, env = ENV_SESSION) {
  const r = runLedger(dir, [...args, '--json'], env);
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (e) {
    parseError = e;
  }
  return { ...r, json, parseError };
}

function v2({
  entry_id,
  agent_type = 'reviewer-security',
  files,
  blobs = {},
  base_sha = null,
  session_id = SESSION,
  branch = 'main',
  agent_id = 'agent-0001',
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
    identity: { session_id, branch, base_sha, agent_id },
    territory: { files, source, attribution: 'block' },
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs, absent_paths: [] },
    disposition,
  };
}

/** A survivor receipt carrying POSITIVE observed-reads evidence. `reads` is the
 *  only thing coverage may be computed from; `files` (declared territory) proves
 *  assignment, never observation. */
function superseder({ entry_id = SUPERSEDER_ID, files, reads = files, blobs = {}, at, session_id = SESSION, branch = 'main', truncated = false, status = 'active', agent_type = 'reviewer-correctness' }) {
  return {
    ...v2({ entry_id, agent_type, files, blobs, session_id, branch, at, status }),
    observed_reads: reads,
    observed_source: 'subagent-transcript',
    ...(truncated ? { observed_truncated: true } : {}),
  };
}

const TARGET_ID = 'd0000000-0000-4000-8000-00000000000a';
const BYSTANDER_ID = 'd0000000-0000-4000-8000-00000000000b';
const SUPERSEDER_ID = 'd0000000-0000-4000-8000-00000000000c';
const COVER_A_ID = 'd0000000-0000-4000-8000-00000000000d';
const CODE = 'export const f = 1;\n';
const OTHER = 'export const f = 2;\n';
const bystander = (base_sha) => v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-bystander', files: ['src/base.mjs'], base_sha });

// ===========================================================================
// R1-C30 / R1-C31 — UNATTRIBUTABLE. The receipt's own territory.source is the
// proof; the class is never merely recorded on the caller's say-so.
// ===========================================================================

// PLACED FIRST as R1-C31's control.
// SABOTAGE: reject the class outright -> this goes red and every R1-C31 green is
// exposed as "refuses everything".
test('R1-C30 (CONTROL, first): --class unattributable discharges a receipt whose territory.source IS unattributable — evidence preserved, class recorded', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, source: 'unattributable' });
    const other = bystander(head);
    writeLedger(dir, [target, other]);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'unattributable', '--reason', 'batch-dispatched same-type reviewer; territory could never be bound to a block']);
    assert.equal(r.code, 0, `a receipt that records its own unattributability is dischargeable — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const after = readLedger(dir);
    assert.equal(after.length, 2, `NOTHING is deleted — got ${JSON.stringify(after)}`);
    const discharged = after.find((e) => e.entry_id === TARGET_ID);
    assert.equal(discharged.status, 'discharged', 'the status flips');
    assert.equal(discharged.disposition.class, 'unattributable', 'and records the class it was verified under');
    assert.deepEqual(discharged.territory, target.territory, 'the territory evidence — including the source that PROVED the class — is preserved');
    assert.deepEqual(after.find((e) => e.entry_id === BYSTANDER_ID), other, 'the bystander is untouched');
    assertNoLedgerResidue(dir, 'R1-C30');
  } finally {
    cleanup();
  }
});

// SABOTAGE: treat --class unattributable as an assertion the CLI merely records
// -> both arms discharge and the code/byte-identical assertions go red. A
// properly-attributed receipt is SPENDABLE, so discharging it retires live
// evidence on a claim its own record denies.
// TWO ARMS: a DIFFERENT source and NO source are different code paths.
test('R1-C31: --class unattributable is [class_not_applicable] when the receipt does not record it — a structured source, and no source at all', { skip: GIT_SKIP }, () => {
  for (const arm of ['structured-territory', 'no-source-recorded']) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const entry = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, ...(arm === 'no-source-recorded' ? { source: undefined } : {}) });
      writeLedger(dir, [entry]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'unattributable', '--reason', `${arm}: the class is proved by the receipt, not asserted by the caller`]);
      assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'class_not_applicable', `[${arm}] got ${JSON.stringify(r.json)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C32 … R1-C44 — SUPERSEDED, ENTRY FORM.
// ===========================================================================

// THE CONTROL FOR THE WHOLE ENTRY-FORM FAMILY. Every refusal below would be
// satisfied by a class that refuses unconditionally; without this green none of
// them carries a verdict.
// SABOTAGE (coverage half): drop the observed_reads coverage test -> R1-C35 goes
// red while this stays green, which is how the two are told apart.
// SABOTAGE (recording half): omit the survivor from the disposition facts -> the
// facts assertions go red while status stays green; a supersession whose survivor
// cannot be named from the record is not re-checkable by anyone later.
test('R1-C32 (CONTROL, first): --class superseded --superseded-by <entry_id> discharges against a newer same-branch receipt whose positive observed_reads cover the territory — facts{form:"entry",covered:{path:{by,observed_read:true}}}', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
    const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha: head, at: isoAgo(600_000) });
    const survivor = superseder({ files: ['src/base.mjs'], blobs, at: isoAgo(60_000) });
    writeLedger(dir, [target, survivor]);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'a fresh reviewer re-reviewed this territory at final bytes']);
    assert.equal(r.code, 0, `a verified supersession succeeds — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const after = readLedger(dir);
    assert.equal(after.length, 2, `NOTHING is deleted — got ${JSON.stringify(after)}`);
    const d = after.find((e) => e.entry_id === TARGET_ID).disposition;
    assert.equal(d.class, 'superseded', 'the class is recorded');
    assert.equal(d.facts.form, 'entry', `the FORM is recorded — the two forms verify different things and a later auditor must know which ran — got ${JSON.stringify(d.facts)}`);
    assert.deepEqual(
      d.facts.covered['src/base.mjs'],
      { by: SUPERSEDER_ID, observed_read: true },
      `each covered path records WHICH receipt covered it and that the evidence was a POSITIVE observed read — never a blob, since blobs need not be equal — got ${JSON.stringify(d.facts.covered)}`
    );
    assert.deepEqual(after.find((e) => e.entry_id === SUPERSEDER_ID), survivor, 'and the SURVIVOR is untouched — a discharge writes exactly one entry');
    assertNoLedgerResidue(dir, 'R1-C32');
  } finally {
    cleanup();
  }
});

// THE INVERSION, pinned in both directions in one test so neither half can be
// read alone: supersession is bound to the BRANCH, not the session.
// SABOTAGE: reinstate a session-equality check -> the cross-session arm goes red
// while the branch arm stays green. A reviewer resumed after a /clear earns its
// receipt in a NEW session on the SAME branch, and that receipt is exactly the
// survivor this class exists for.
// SABOTAGE (the other direction): drop the branch comparison -> the
// cross-branch arm discharges and its code assertion goes red. A receipt earned
// on another branch is evidence about other work.
test('R1-C33: a survivor from ANOTHER SESSION on the SAME BRANCH discharges; a survivor on ANOTHER BRANCH is [superseder_branch_mismatch]', { skip: GIT_SKIP }, () => {
  for (const arm of ['cross-session-same-branch', 'other-branch']) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha: head, at: isoAgo(600_000) });
      const survivor = superseder({
        files: ['src/base.mjs'],
        blobs,
        at: isoAgo(60_000),
        session_id: 'a-later-session',
        branch: arm === 'other-branch' ? 'feature/elsewhere' : 'main',
      });
      writeLedger(dir, [target, survivor]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', `${arm}: recency is receipt-bound and identity is branch-bound`]);
      if (arm === 'cross-session-same-branch') {
        assert.equal(r.code, 0, `[${arm}] a later session's receipt on this branch is a valid survivor — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'discharged', `[${arm}] the entry is discharged`);
      } else {
        assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'superseder_branch_mismatch', `[${arm}] got ${JSON.stringify(r.json)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      }
    } finally {
      cleanup();
    }
  }
});

// THE COMPARISON IS RECORD-TO-RECORD, NEVER RECORD-TO-WORKTREE. Both fixtures
// are checked out on 'feature' — a branch NEITHER receipt was earned on — so the
// currently-checked-out branch cannot supply the answer to either arm.
// SABOTAGE (the one this pin exists for): compare the survivor's branch to the
// CURRENT branch (or compare both receipts to it) -> 'recorded-mismatch'
// discharges (survivor 'feature' == checked out 'feature') and 'recorded-match'
// refuses (both 'main' != checked out 'feature'). BOTH ARMS FLIP TOGETHER, which
// is the signature: a single-arm pin here would be satisfied by the wrong
// implementation half the time.
// WHY IT MATTERS: a receipt is evidence about the branch it was EARNED on. Asking
// where the operator happens to stand makes the verdict depend on a `git checkout`
// nobody recorded, so the same two receipts would supersede or not according to
// which branch was open when the discharge was typed.
test('R1-C56: the entry form compares the SURVIVOR\'s recorded branch to the DISCHARGED RECEIPT\'s recorded branch, never to the checked-out branch — both arms run while standing on a third branch', { skip: GIT_SKIP }, () => {
  for (const arm of ['recorded-mismatch', 'recorded-match']) {
    const { dir, cleanup } = makeRepo();
    try {
      const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
      git(dir, ['checkout', '-b', 'feature']);
      assert.equal(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feature', 'fixture guard: the repo is standing on a branch neither receipt was earned on');

      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, branch: 'main', at: isoAgo(600_000) });
      const survivor = superseder({ files: ['src/base.mjs'], blobs, at: isoAgo(60_000), branch: arm === 'recorded-mismatch' ? 'feature' : 'main' });
      writeLedger(dir, [target, survivor]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', `${arm}: the two records are compared to each other`]);
      if (arm === 'recorded-match') {
        assert.equal(r.code, 0, `[${arm}] CONTROL — both receipts were earned on 'main', so the survivor supersedes wherever the operator is standing — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'discharged', `[${arm}] the entry is discharged`);
      } else {
        assert.equal(r.code, 1, `[${arm}] a survivor earned on 'feature' is evidence about 'feature', not about the 'main' receipt it is named against — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'superseder_branch_mismatch', `[${arm}] got ${JSON.stringify(r.json)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      }
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: default --superseded-by to "the newest other receipt" -> exit 0 on an
// unverifiable assertion and the code/byte-identical assertions go red. With
// nothing named there is nothing to verify, and `superseded` degrades to "I
// believe someone re-reviewed this" on a verb that retires review evidence.
// FIXTURE: a perfectly good survivor IS present, so the only possible cause of a
// refusal is that the caller did not name it.
test('R1-C34: --class superseded with NO --superseded-by is [argument_invalid] naming the flag — a supersession that names no survivor has nothing to verify', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
    writeLedger(dir, [
      v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha: head, at: isoAgo(600_000) }),
      superseder({ files: ['src/base.mjs'], blobs, at: isoAgo(60_000) }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--reason', 'no survivor named']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'argument_invalid', `got ${JSON.stringify(r.json)}`);
    assert.match(String(r.json.facts.flag), /superseded-by/, `facts.flag names the missing argument — got ${JSON.stringify(r.json.facts)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// SABOTAGE: test coverage with `.some()` instead of a superset, or compare only
// the first covered path -> a receipt whose second path nobody re-read is
// discharged and the code assertion goes red. Superseding on PARTIAL coverage
// retires review evidence for exactly the paths nobody looked at again — the
// refusal that once caught a real defect, kept here as its CODE and its FACTS.
test('R1-C35: --class superseded is [superseder_coverage_incomplete] with facts.uncovered when the survivor\'s observed_reads miss ANY covered path', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs'), 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs', 'src/laneA.mjs'], blobs, base_sha: head, at: isoAgo(600_000) });
    // The survivor read ONE of the two — everything else about it is correct.
    writeLedger(dir, [target, superseder({ files: ['src/base.mjs', 'src/laneA.mjs'], reads: ['src/base.mjs'], blobs, at: isoAgo(60_000) })]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'partial coverage must not discharge']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'superseder_coverage_incomplete', `got ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.json.facts.uncovered, ['src/laneA.mjs'], `facts.uncovered NAMES the path the survivor never read — got ${JSON.stringify(r.json.facts)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// SABOTAGE — THE ONE THIS PIN EXISTS FOR: fall back to observed_files when
// observed_reads is absent -> this discharges and the code assertion goes red.
// observed_files is reads UNION WRITES, so the fallback lets an agent's own
// WRITES count as having reviewed the file — the exact inversion of review
// evidence. The fixture's survivor carries a COVERING observed_files precisely so
// a fallback implementation passes everything else and fails only here.
test('R1-C36: a survivor recording NO observed_reads covers nothing — [superseder_coverage_incomplete]; there is NO fallback to observed_files (reads UNION writes)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
    const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha: head, at: isoAgo(600_000) });
    const survivor = {
      ...v2({ entry_id: SUPERSEDER_ID, agent_type: 'reviewer-correctness', files: ['src/base.mjs'], blobs, at: isoAgo(60_000) }),
      observed_files: ['src/base.mjs'], // covering — but reads ∪ WRITES, so not review evidence
      observed_source: 'subagent-transcript',
    };
    writeLedger(dir, [target, survivor]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'observed_files is not observed_reads']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'superseder_coverage_incomplete', `got ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.json.facts.uncovered, ['src/base.mjs'], `every covered path is uncovered, because nothing was positively read — got ${JSON.stringify(r.json.facts)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// THE THOROUGHNESS RULE, pinned in both directions. Truncation removes NEGATIVE
// inference ("absent from the list" no longer means "never read"); it never
// removes POSITIVE evidence ("this path is in the list" still means it was read).
// SABOTAGE: refuse whenever observed_truncated is set -> the 'covers' arm goes
// red. That is the exact perverse incentive this rule was written to remove: a
// review thorough enough to truncate its own transcript could discharge nothing,
// so a careful reviewer's work had to be waived past instead.
// SABOTAGE (the other direction): treat a truncated capture as covering
// EVERYTHING -> the 'misses-one' arm discharges and goes red.
test('R1-C37: a TRUNCATED survivor still discharges when its POSITIVE observed_reads cover the territory — and still refuses when they miss a path', { skip: GIT_SKIP }, () => {
  for (const arm of ['covers', 'misses-one']) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      stageChange(dir, 'src/laneA.mjs', CODE);
      const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs'), 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs', 'src/laneA.mjs'], blobs, base_sha: head, at: isoAgo(600_000) });
      const reads = arm === 'covers' ? ['src/base.mjs', 'src/laneA.mjs'] : ['src/base.mjs'];
      writeLedger(dir, [target, superseder({ files: ['src/base.mjs', 'src/laneA.mjs'], reads, blobs, at: isoAgo(60_000), truncated: true })]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', `${arm}: truncation removes negative inference only`]);
      if (arm === 'covers') {
        assert.equal(r.code, 0, `[${arm}] positively-recorded reads stay usable however large the transcript was — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        const d = readLedger(dir).find((e) => e.entry_id === TARGET_ID).disposition;
        assert.equal(d.facts.covered['src/laneA.mjs'].observed_read, true, `the truncated survivor's positive read is what carried the path — got ${JSON.stringify(d.facts.covered)}`);
      } else {
        assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'superseder_coverage_incomplete', `[${arm}] got ${JSON.stringify(r.json)}`);
        assert.deepEqual(r.json.facts.uncovered, ['src/laneA.mjs'], `[${arm}] got ${JSON.stringify(r.json.facts)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      }
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: require the survivor's blobs to equal the discharged receipt's ->
// this goes red. That requirement defeats the PRINCIPAL case: old bytes were
// reviewed, the code changed because that review prescribed a fix, and the final
// bytes were reviewed again. Supersession is newer evidence replacing older
// evidence, so DIFFERENT blobs are the normal shape, not a defect.
// WHICH GUARD CARRIES THE VERDICT: exit 0 together with the facts.covered entry
// carrying no blob field — a pass that recorded a blob would mean the comparison
// is still there, merely not enforced.
test('R1-C38: a survivor whose content_evidence.blobs DIFFER from the discharged receipt\'s still discharges — supersession is newer evidence, never equal bytes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const oldBlob = stagedBlob(dir, 'src/laneA.mjs');
    const target = v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': oldBlob }, base_sha: head, at: isoAgo(600_000) });
    stageChange(dir, 'src/laneA.mjs', OTHER);
    const newBlob = stagedBlob(dir, 'src/laneA.mjs');
    assert.notEqual(oldBlob, newBlob, 'fixture guard: the two receipts genuinely reviewed different bytes');
    const survivor = superseder({ files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': newBlob }, at: isoAgo(60_000) });
    writeLedger(dir, [target, survivor]);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'the fix this review prescribed changed the bytes it reviewed']);
    assert.equal(r.code, 0, `differing blobs are the normal shape of a corrective round — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const d = readLedger(dir).find((e) => e.entry_id === TARGET_ID).disposition;
    assert.deepEqual(Object.keys(d.facts.covered['src/laneA.mjs']).sort(), ['by', 'observed_read'], `the covered record carries NO blob — there is nothing to compare — got ${JSON.stringify(d.facts.covered)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: compute the discharged receipt's covered paths from territory.files
// alone -> the survivor no longer covers the blob-less path, the discharge
// refuses, and the exit-0 assertion goes red. A path the receipt DECLARED but for
// which it holds no byte evidence was never proved reviewed at any bytes, so it
// is not a path supersession has to account for — but it must still be VISIBLE,
// which is what facts.uncovered_declared is for.
// SABOTAGE (the visibility half): drop uncovered_declared -> only that assertion
// goes red, and a declared-but-unevidenced path vanishes from the record silently.
test('R1-C39: a declared path with NO usable byte evidence is not a covered path — supersession succeeds over the blob-backed paths and records facts.uncovered_declared', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const target = v2({
      entry_id: TARGET_ID,
      files: ['src/base.mjs', 'src/laneA.mjs'],
      blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, // laneA declared, never hashed
      base_sha: head,
      at: isoAgo(600_000),
    });
    // The survivor read ONLY the blob-backed path.
    writeLedger(dir, [target, superseder({ files: ['src/base.mjs'], reads: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, at: isoAgo(60_000) })]);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'the declared-but-unevidenced path was never proved reviewed at any bytes']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const d = readLedger(dir).find((e) => e.entry_id === TARGET_ID).disposition;
    assert.deepEqual(Object.keys(d.facts.covered), ['src/base.mjs'], `only the blob-backed path is a covered path — got ${JSON.stringify(d.facts.covered)}`);
    assert.deepEqual(d.facts.uncovered_declared, ['src/laneA.mjs'], `the declared path with no byte evidence is recorded, never silently dropped — got ${JSON.stringify(d.facts)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: change the finished_at comparison from strict (>) to (>=) -> the
// 'equal' and 'self' arms discharge and go red while 'older' stays refused,
// which is how a >= regression is told apart from a deleted guard.
// THREE ARMS: older, equal-instant, and the entry naming ITSELF — the last is a
// consequence of the same rule (an entry's own finished_at can never be strictly
// newer than itself), and pinning it here keeps one cause under one code.
test('R1-C40: a survivor whose finished_at is not STRICTLY newer is [superseder_not_newer] — older, equal-instant, and the entry naming itself', { skip: GIT_SKIP }, () => {
  for (const arm of ['older', 'equal', 'self']) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
      const targetAt = isoAgo(60_000);
      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha: head, at: targetAt });
      const entries = [target];
      if (arm !== 'self') entries.push(superseder({ files: ['src/base.mjs'], blobs, at: arm === 'equal' ? targetAt : isoAgo(600_000) }));
      writeLedger(dir, entries);
      const before = readLedgerRaw(dir);

      const named = arm === 'self' ? TARGET_ID : SUPERSEDER_ID;
      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', named, '--reason', `${arm}: the survivor must be strictly newer`]);
      assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'superseder_not_newer', `[${arm}] got ${JSON.stringify(r.json)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
    } finally {
      cleanup();
    }
  }
});

// THE ACCEPTABLE LIFECYCLE SET IS active|reserved|consumed — a survivor that has
// been SPENT is still evidence that the review happened, and after the rebuild a
// spent receipt stays in the ledger as 'consumed' rather than disappearing.
// SABOTAGE: keep the old "the survivor must be ACTIVE" rule -> both control arms
// go red, and every receipt spent by a commit stops being able to supersede
// anything — which retires the single most common survivor shape.
// SABOTAGE (the other direction): accept any status -> the 'discharged' arm
// discharges and goes red; a survivor already ruled unspendable cannot carry
// somebody else's review.
test('R1-C41: a RESERVED or CONSUMED survivor is acceptable and discharges; a DISCHARGED survivor is [superseder_lifecycle_unacceptable]', { skip: GIT_SKIP }, () => {
  const arms = [
    { label: 'reserved', status: 'reserved', ok: true },
    { label: 'consumed', status: 'consumed', ok: true },
    { label: 'discharged', status: 'discharged', ok: false },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha: head, at: isoAgo(600_000) });
      const survivor = { ...superseder({ files: ['src/base.mjs'], blobs, at: isoAgo(60_000), status: arm.status }) };
      if (arm.status === 'reserved') survivor.reservation = { nonce: 'n-1', at: isoAgo(50_000), index_blobs: blobs, operation: 'commit-reviewed' };
      if (arm.status === 'consumed') survivor.consumption = { commit_sha: head, consumed_at: isoAgo(50_000), nonce: 'n-1' };
      if (arm.status === 'discharged') survivor.disposition = { class: 'foreign-branch', reason: 'retired for an unrelated finding', at: isoAgo(50_000), head_sha: head, classifier_version: 2, facts: {} };
      writeLedger(dir, [target, survivor]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', `${arm.label}: the survivor's own lifecycle decides`]);
      if (arm.ok) {
        assert.equal(r.code, 0, `[${arm.label}] a spent or in-flight survivor is still evidence that the review happened — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'discharged', `[${arm.label}] the entry is discharged`);
      } else {
        assert.equal(r.code, 1, `[${arm.label}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'superseder_lifecycle_unacceptable', `[${arm.label}] got ${JSON.stringify(r.json)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm.label}] the ledger is byte-identical`);
      }
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE (not-found half): resolve an unknown superseder to the newest other
// receipt -> the 'absent' arm discharges and goes red.
// SABOTAGE (reviewer-class half): drop the kind gate -> the 'external' arm
// discharges and goes red. An external_review entry is conductor-attested
// evidence of a completed consult, NOT proof of a review, and it carries no
// agent_type at all; letting one supersede a roster receipt launders a consult
// into the mandatory independent review.
test('R1-C42: a superseder that is ABSENT is [superseder_not_found]; an external_review entry named as superseder is [superseder_not_reviewer_class]', { skip: GIT_SKIP }, () => {
  for (const arm of ['absent', 'external']) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha: head, at: isoAgo(600_000) });
      const entries = [target];
      if (arm === 'external') {
        entries.push({
          schema_version: 2,
          entry_id: SUPERSEDER_ID,
          kind: 'external_review',
          status: 'active',
          recorded_at: isoAgo(60_000),
          finished_at: isoAgo(60_000),
          provider: 'openai',
          model: 'gpt-5.2',
          thread_id: 'thread-1',
          round: 1,
          note: 'a consult, not a review',
          files: ['src/base.mjs'],
          disposition: null,
        });
      }
      writeLedger(dir, entries);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', `${arm}: the survivor must be a roster receipt that exists`]);
      assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, arm === 'absent' ? 'superseder_not_found' : 'superseder_not_reviewer_class', `[${arm}] got ${JSON.stringify(r.json)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
    } finally {
      cleanup();
    }
  }
});

// --covering IS EXPLICIT AND NEVER AN IMPLICIT LEDGER SEARCH. The real-world
// shape is several reviews jointly covering one territory, so the set cover is
// legitimate — but every member is checked exactly as the named survivor is.
// SABOTAGE (the set-cover half): ignore --covering and require the named survivor
// to cover everything alone -> the 'joint' arm goes red.
// SABOTAGE (the membership half): accept covering ids without checking them ->
// the 'stale-member' arm discharges and goes red, and a set cover becomes a way
// to launder any receipt into coverage by listing it.
test('R1-C43: --covering members jointly complete the coverage; a member that is older, off-branch or not reviewer-class is [covering_receipt_invalid] with facts.entry_id', { skip: GIT_SKIP }, () => {
  for (const arm of ['joint', 'stale-member']) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      stageChange(dir, 'src/laneA.mjs', CODE);
      const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs'), 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
      const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs', 'src/laneA.mjs'], blobs, base_sha: head, at: isoAgo(600_000) });
      const named = superseder({ entry_id: SUPERSEDER_ID, files: ['src/base.mjs'], reads: ['src/base.mjs'], blobs, at: isoAgo(60_000) });
      const member = superseder({
        entry_id: COVER_A_ID,
        files: ['src/laneA.mjs'],
        reads: ['src/laneA.mjs'],
        blobs,
        // 'stale-member' makes the member OLDER than the discharged receipt — the
        // one thing wrong with it; everything else stays correct.
        at: arm === 'joint' ? isoAgo(30_000) : isoAgo(900_000),
      });
      writeLedger(dir, [target, named, member]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--covering', COVER_A_ID, '--reason', `${arm}: the set cover is explicit and every member is checked`]);
      if (arm === 'joint') {
        assert.equal(r.code, 0, `[${arm}] two receipts jointly covering the territory is the real-world shape — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        const d = readLedger(dir).find((e) => e.entry_id === TARGET_ID).disposition;
        assert.equal(d.facts.covered['src/base.mjs'].by, SUPERSEDER_ID, `[${arm}] each path records WHICH receipt covered it — got ${JSON.stringify(d.facts.covered)}`);
        assert.equal(d.facts.covered['src/laneA.mjs'].by, COVER_A_ID, `[${arm}] including the covering member's own paths`);
      } else {
        assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'covering_receipt_invalid', `[${arm}] got ${JSON.stringify(r.json)}`);
        assert.equal(r.json.facts.entry_id, COVER_A_ID, `[${arm}] facts.entry_id names WHICH member failed — got ${JSON.stringify(r.json.facts)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      }
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: compute an unattributable receipt's covered paths from its declared
// territory -> the discharge succeeds on paths nobody could attribute to it, and
// the code assertion goes red. An unattributable receipt's declaration could not
// be bound to any one dispatch in the first place; its own positive observed
// reads are the only thing that names territory it actually touched.
// FIXTURE: the survivor covers the DECLARED path and not the OBSERVED one, so an
// implementation reading the declaration passes and one reading the observations
// refuses — the two are told apart by exactly this arrangement.
test('R1-C44: an UNATTRIBUTABLE receipt is covered only through its OWN positive observed paths, never through its declaration', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs'), 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    const target = {
      ...v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha: head, at: isoAgo(600_000), source: 'unattributable' }),
      observed_reads: ['src/laneA.mjs'], // what it actually touched
      observed_source: 'subagent-transcript',
    };
    writeLedger(dir, [target, superseder({ files: ['src/base.mjs'], reads: ['src/base.mjs'], blobs, at: isoAgo(60_000) })]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'the survivor covers the declaration, not the observation']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'superseder_coverage_incomplete', `got ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.json.facts.uncovered, ['src/laneA.mjs'], `the uncovered path is the OBSERVED one — the declaration was never the question — got ${JSON.stringify(r.json.facts)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C45 … R1-C50 — SUPERSEDED, COMMIT FORM.
// ===========================================================================

const SURVIVOR_RECEIPT_ID = 'd0000000-0000-4000-8000-00000000000f';

/** Builds the survivor COMMIT and the receipt bound to it. `commitAt` pins the
 *  committer AND author instants, so a pin can place the commit definitively
 *  before the receipt — which must change nothing, because those instants are
 *  never read. */
function survivorCommit(dir, { at, commitAt = null, rosterValue = 'reviewer-correctness', withReceiptTrailer = true, receiptId = SURVIVOR_RECEIPT_ID, content = OTHER } = {}) {
  stageChange(dir, 'src/laneA.mjs', content);
  const trailers = [`Reviewed-By-Agent: ${rosterValue}`];
  if (withReceiptTrailer) trailers.push(`Review-Receipt: ${receiptId}`);
  const args = ['commit', '-m', 'the survivor commit', '-m', trailers.join('\n')];
  if (commitAt) gitAtInstant(dir, args, commitAt);
  else git(dir, args);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const blob = git(dir, ['rev-parse', `${sha}:src/laneA.mjs`]);
  const receipt = {
    ...v2({ entry_id: receiptId, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, at, status: 'consumed' }),
    consumption: { commit_sha: sha, consumed_at: at, nonce: 'n-1' },
    observed_reads: ['src/laneA.mjs'],
    observed_source: 'subagent-transcript',
  };
  return { sha, blob, receipt };
}

// THE CONTROL FOR THE COMMIT-FORM FAMILY, and the pin that RETIRES committer-time
// recency outright: the survivor commit is DATED A YEAR BEFORE the discharged
// receipt finished, and it discharges anyway, because recency is proved by the
// consumed receipt the commit names — a value a rebase cannot rewrite.
// SABOTAGE: reinstate any comparison against `%cI`/`%aI` -> this control refuses
// and goes red while every refusal pin below stays green. That result pair is the
// signature of the retired design creeping back.
// SABOTAGE (facts half): omit facts.receipt_entry_id or facts.compared -> those
// assertions go red; a later auditor must be able to re-run the same comparison
// without guessing which receipt or which bytes were compared.
test('R1-C45 (CONTROL, first): the commit form discharges against an ancestor commit whose Review-Receipt names a consumed, strictly-newer receipt with matching tree blobs — even when the COMMIT IS DATED BEFORE the receipt', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const targetAt = isoAgo(600_000);
    const survivorAt = isoAgo(60_000);
    const { sha, receipt } = survivorCommit(dir, { at: survivorAt, commitAt: '2025-01-01T00:00:00+00:00' });
    const target = v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') }, base_sha: sha, at: targetAt });
    writeLedger(dir, [target, receipt]);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', sha, '--reason', 'the commit names a later receipt; its own date is metadata a rebase can rewrite']);
    assert.equal(r.code, 0, `committer and author instants are NEVER read — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const d = readLedger(dir).find((e) => e.entry_id === TARGET_ID).disposition;
    assert.equal(d.class, 'superseded', 'the class is recorded');
    assert.equal(d.facts.form, 'commit', `the FORM is recorded — got ${JSON.stringify(d.facts)}`);
    assert.equal(d.facts.receipt_entry_id, SURVIVOR_RECEIPT_ID, `and WHICH receipt carried the verdict — got ${JSON.stringify(d.facts)}`);
    assert.equal(d.facts.compared, 'commit-tree-blobs', `and WHAT was compared — got ${JSON.stringify(d.facts)}`);
    assert.deepEqual(readLedger(dir).find((e) => e.entry_id === SURVIVOR_RECEIPT_ID), receipt, 'the survivor receipt is untouched');
    assertNoLedgerResidue(dir, 'R1-C45');
  } finally {
    cleanup();
  }
});

// THE OTHER HALF OF THE SAME INVERSION: a commit dated well AFTER the receipt but
// carrying NO Review-Receipt trailer refuses. Recency is not a date; it is the
// binding.
// SABOTAGE: accept a roster trailer alone as the survivor -> this discharges and
// the code assertion goes red. A commit with a roster trailer says SOMETHING was
// reviewed; only the Review-Receipt binding says WHICH evidence, at which bytes.
test('R1-C46: a commit dated AFTER the receipt but carrying NO Review-Receipt trailer is [superseder_commit_receipt_unbound] — a date is not a binding', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { sha } = survivorCommit(dir, { at: isoAgo(60_000), commitAt: '2035-01-01T00:00:00+00:00', withReceiptTrailer: false });
    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') }, base_sha: sha, at: isoAgo(600_000) })]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', sha, '--reason', 'a late date proves nothing about review evidence']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'superseder_commit_receipt_unbound', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// SABOTAGE: drop the `merge-base --is-ancestor` check -> the abandoned-branch arm
// discharges and goes red. `rev-parse <sha>^{commit}` proves only that the OBJECT
// exists locally, which is true of every abandoned branch, every fetched ref and
// every commit a rebase orphaned.
// THE 'ancestor' ARM IS THE CONTROL for the refusing one.
test('R1-C47: a survivor commit that is NOT REACHABLE FROM HEAD is [superseder_commit_not_ancestor] — an object that merely exists here is not this history', { skip: GIT_SKIP }, () => {
  for (const arm of ['abandoned-branch', 'ancestor']) {
    const { dir, cleanup } = makeRepo();
    try {
      git(dir, ['checkout', '-b', 'abandoned']);
      const { sha, receipt } = survivorCommit(dir, { at: isoAgo(60_000) });
      // The abandoned arm walks back to main, so the commit stays a resolvable
      // OBJECT while ceasing to be an ancestor of HEAD.
      if (arm === 'abandoned-branch') git(dir, ['checkout', 'main']);
      const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const target = v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs: receipt.content_evidence.blobs, base_sha: sha, branch, at: isoAgo(600_000) });
      writeLedger(dir, [target, { ...receipt, identity: { ...receipt.identity, branch } }]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', sha, '--reason', `${arm}: the survivor must be on this history`]);
      if (arm === 'ancestor') {
        assert.equal(r.code, 0, `[${arm}] CONTROL — a commit ON this history is a valid survivor — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'discharged', `[${arm}] the entry is discharged`);
      } else {
        assert.equal(r.code, 1, `[${arm}] a stamped commit on an abandoned branch reviews OTHER work — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'superseder_commit_not_ancestor', `[${arm}] got ${JSON.stringify(r.json)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      }
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: accept any non-empty Reviewed-By-Agent value (the pre-rebuild
// `/^Reviewed-By-Agent:[ \t]*\S/m` shape) -> the 'names-nobody' arm discharges and
// goes red. The commit stands in for a receipt ONLY because the merge gate would
// accept it as reviewed, and that gate counts a value only when it names a roster
// reviewer.
// THE 'decorated' ARM IS THE CONTROL, and it is deliberately the DECORATED form:
// an over-anchored pattern demanding a bare token would refuse most real receipts
// in this repo's history, so the pin must catch that direction too.
test('R1-C48: the commit form requires a Reviewed-By-Agent value NAMING A ROSTER REVIEWER — `yes` is [superseder_commit_trailer_not_roster] naming the rejected value; a decorated `reviewer-<class> (model) — note` is accepted', { skip: GIT_SKIP }, () => {
  const arms = [
    { arm: 'names-nobody', value: 'yes', ok: false },
    { arm: 'decorated', value: 'reviewer-correctness (opus) — findings adjudicated', ok: true },
  ];
  for (const { arm, value, ok } of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const { sha, receipt } = survivorCommit(dir, { at: isoAgo(60_000), rosterValue: value });
      writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs: receipt.content_evidence.blobs, base_sha: sha, at: isoAgo(600_000) }), receipt]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', sha, '--reason', `${arm}: the trailer must be one the merge gate would count`]);
      if (ok) {
        assert.equal(r.code, 0, `[${arm}] CONTROL — a decorated roster value is what commit-reviewed and post-hoc receipts actually write — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'discharged', `[${arm}] the entry is discharged`);
      } else {
        assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'superseder_commit_trailer_not_roster', `[${arm}] got ${JSON.stringify(r.json)}`);
        assert.ok(
          JSON.stringify(r.json.facts).includes(value),
          `[${arm}] the facts NAME the value that was rejected, so the operator is not sent to git log to guess — got ${JSON.stringify(r.json.facts)}`
        );
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      }
    } finally {
      cleanup();
    }
  }
});

// THREE ARMS, three DIFFERENT ways the naming can fail to bind, all one code:
// the receipt is ABSENT from the ledger; the receipt exists but is not CONSUMED
// FOR THAT SHA (it names another commit); the receipt is bound but is not
// STRICTLY NEWER than the entry being discharged.
// SABOTAGE: check only that the named receipt exists -> the 'other-sha' and
// 'older' arms discharge and go red. A receipt consumed by a DIFFERENT commit is
// evidence about that commit's bytes, not this one's.
test('R1-C49: a Review-Receipt trailer that does not BIND is [superseder_commit_receipt_unbound] — receipt absent, consumed for another sha, or not strictly newer', { skip: GIT_SKIP }, () => {
  for (const arm of ['absent', 'other-sha', 'older']) {
    const { dir, cleanup } = makeRepo();
    try {
      const survivorAt = arm === 'older' ? isoAgo(900_000) : isoAgo(60_000);
      const { sha, receipt } = survivorCommit(dir, { at: survivorAt });
      const target = v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs: receipt.content_evidence.blobs, base_sha: sha, at: isoAgo(600_000) });
      const entries = [target];
      if (arm === 'other-sha') entries.push({ ...receipt, consumption: { ...receipt.consumption, commit_sha: 'b'.repeat(40) } });
      else if (arm !== 'absent') entries.push(receipt);
      writeLedger(dir, entries);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', sha, '--reason', `${arm}: the trailer must name evidence bound to THIS commit`]);
      assert.equal(r.code, 1, `[${arm}] stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'superseder_commit_receipt_unbound', `[${arm}] got ${JSON.stringify(r.json)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: skip the blob comparison against the commit TREE -> this discharges
// and the code assertion goes red. The receipt's own blobs are what tie the
// review to bytes; if they do not match the tree the commit actually holds, the
// commit is not the thing that receipt reviewed.
// FIXTURE: everything else binds — ancestor, roster trailer, consumed for this
// sha, strictly newer — so the blob map is the only possible cause.
test('R1-C50: a bound receipt whose blobs differ from the COMMIT TREE for a covered path is [superseder_commit_blob_mismatch]', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { sha, receipt } = survivorCommit(dir, { at: isoAgo(60_000) });
    const wrong = { ...receipt, content_evidence: { ...receipt.content_evidence, blobs: { 'src/laneA.mjs': 'c'.repeat(40) } } };
    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs: receipt.content_evidence.blobs, base_sha: sha, at: isoAgo(600_000) }), wrong]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', sha, '--reason', 'the named receipt reviewed different bytes than this commit holds']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'superseder_commit_blob_mismatch', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C51 — THE COMMIT FORM ALSO REQUIRES COVERAGE (sheet §6 A12).
//
// Binding a commit to bytes proves THE COMMIT was reviewed; it does not prove
// THIS RECEIPT'S TERRITORY was. So the receipt named by the Review-Receipt
// trailer must have blob-backed covered paths (receiptCoveredPaths) that include
// every trustworthy covered path of the discharged receipt, and a gap refuses
// with the SAME code the entry form uses.
// ===========================================================================

// TWO ARMS, and the 'covers' arm is the CONTROL that must pass for the opposite
// reason: it is the identical fixture with the named receipt's territory widened
// by one path, so a green refusal in the 'gap' arm cannot be explained by
// anything else in the commit form. EVERY OTHER CHECK PASSES IN BOTH ARMS —
// ancestor of HEAD, roster trailer, receipt present and consumed for THIS sha,
// strictly newer, blobs equal the commit tree for its own covered paths — so
// coverage is the only variable.
// SABOTAGE (the one this pin exists for): verify the commit form with the four
// binding checks alone and skip the coverage comparison -> the 'gap' arm
// discharges and its code/status/byte-identical assertions go red. The
// consequence is concrete: a receipt reviewing laneA alone would retire a receipt
// covering laneA AND laneB, and laneB's review requirement disappears behind a
// commit nobody reviewed it in.
// SABOTAGE (the facts half): refuse without facts.uncovered -> that assertion
// alone goes red, and the operator is told a coverage gap exists without being
// told which path it is — the entry form names it, and the two forms must not
// disagree about how much they say.
// SABOTAGE (the over-reach direction): compute the named receipt's coverage from
// its DECLARED territory rather than its blob-backed covered paths -> the 'gap'
// arm still refuses (its declaration is also narrow) but a receipt declaring a
// path it never hashed would start covering it; the entry-form pin R1-C39 is what
// catches that direction, and the two are read together.
test('R1-C51: the commit form REFUSES when the named receipt\'s blob-backed covered paths miss a covered path of the discharged receipt — [superseder_coverage_incomplete] facts.uncovered, same code as the entry form', { skip: GIT_SKIP }, () => {
  for (const arm of ['gap', 'covers']) {
    const { dir, cleanup } = makeRepo();
    try {
      // ONE commit touching BOTH paths, so the commit itself is above suspicion:
      // its tree holds both blobs and the receipt is bound to it.
      stageChange(dir, 'src/laneA.mjs', OTHER);
      stageChange(dir, 'src/laneB.mjs', OTHER);
      git(dir, ['commit', '-m', 'the survivor commit', '-m', `Reviewed-By-Agent: reviewer-correctness\nReview-Receipt: ${SURVIVOR_RECEIPT_ID}`]);
      const sha = git(dir, ['rev-parse', 'HEAD']);
      const blobA = git(dir, ['rev-parse', `${sha}:src/laneA.mjs`]);
      const blobB = git(dir, ['rev-parse', `${sha}:src/laneB.mjs`]);

      const targetBlobs = { 'src/laneA.mjs': blobA, 'src/laneB.mjs': blobB };
      const target = v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs', 'src/laneB.mjs'], blobs: targetBlobs, base_sha: sha, at: isoAgo(600_000) });

      // The named receipt: bound to THIS sha, strictly newer, blob-consistent
      // with the commit tree for every path it covers. Only its TERRITORY moves.
      const survivorAt = isoAgo(60_000);
      const namedFiles = arm === 'gap' ? ['src/laneA.mjs'] : ['src/laneA.mjs', 'src/laneB.mjs'];
      const namedBlobs = arm === 'gap' ? { 'src/laneA.mjs': blobA } : targetBlobs;
      const named = {
        ...v2({ entry_id: SURVIVOR_RECEIPT_ID, agent_type: 'reviewer-correctness', files: namedFiles, blobs: namedBlobs, at: survivorAt, status: 'consumed' }),
        consumption: { commit_sha: sha, consumed_at: survivorAt, nonce: 'n-1' },
        observed_reads: namedFiles,
        observed_source: 'subagent-transcript',
      };
      writeLedger(dir, [target, named]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', sha, '--reason', `${arm}: a commit binding is not a territory claim`]);
      if (arm === 'covers') {
        assert.equal(r.code, 0, `[${arm}] CONTROL — the named receipt covers every covered path, so the commit form discharges — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        const d = readLedger(dir).find((e) => e.entry_id === TARGET_ID).disposition;
        assert.equal(d.facts.form, 'commit', `[${arm}] the commit form is what ran — got ${JSON.stringify(d.facts)}`);
        assert.equal(d.facts.receipt_entry_id, SURVIVOR_RECEIPT_ID, `[${arm}] naming the receipt that carried the verdict`);
      } else {
        assert.equal(r.code, 1, `[${arm}] a receipt reviewing one of two paths cannot retire a receipt covering both — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'superseder_coverage_incomplete', `[${arm}] the SAME code the entry form uses — one contract, one name — got ${JSON.stringify(r.json)}`);
        assert.deepEqual(r.json.facts.uncovered, ['src/laneB.mjs'], `[${arm}] facts.uncovered NAMES the path the named receipt never covered — got ${JSON.stringify(r.json.facts)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
        assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', `[${arm}] and the receipt stays spendable`);
      }
      assertNoLedgerResidue(dir, `R1-C51/${arm}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C55 — A COMMIT MAY NAME SEVERAL RECEIPTS, AND EVERY ONE OF THEM IS JUDGED.
//
// One commit routinely spends several receipts, so it carries one Review-Receipt
// trailer per stamped receipt. Two consequences the sheet's singular phrasing
// hides: coverage is satisfied by the UNION of the named receipts' covered paths,
// and a single trailer that fails to bind poisons the whole survivor — because a
// commit carrying an unbindable attestation is a commit whose review record
// cannot be reconstructed, whatever else it also carries.
// ===========================================================================

const SURVIVOR_RECEIPT_B_ID = 'd0000000-0000-4000-8000-000000000010';

// TWO ARMS. 'union' is the CONTROL and must pass for the OPPOSITE reason: the
// same two trailers, both binding, jointly covering the discharged receipt's two
// paths. So a green refusal in 'second-unbound' cannot be explained by "several
// trailers are never accepted", and a green 'union' cannot be explained by "any
// commit with a trailer discharges" — the other arm reddens under that.
// SABOTAGE (the one this pin exists for): judge results[0] and return — the
// classic shape when a singular contract meets a plural input -> the
// 'second-unbound' arm DISCHARGES and its code/status/byte-identical assertions
// go red, while 'union' stays green. That pair of results is the whole signature:
// an implementation that stops at the first trailer looks perfectly correct on
// every single-receipt fixture in this file.
// SABOTAGE (the union half): require ONE named receipt to cover everything alone
// -> the 'union' arm refuses with superseder_coverage_incomplete and goes red,
// while 'second-unbound' stays green. Real commits are reviewed by several
// agents with disjoint territories; demanding a single superset receipt would
// make the commit form unusable for exactly the commits it is for.
// SABOTAGE (the facts half): record one receipt_entry_id and drop the per-path
// attribution -> only the covered-map assertions go red, and the record stops
// saying which review carried which path — which is what makes the discharge
// re-checkable a month later.
test('R1-C55: a commit carrying TWO Review-Receipt trailers — coverage is the UNION of the named receipts and facts say which covered which path; if the SECOND fails to bind the discharge refuses [superseder_commit_receipt_unbound] even though the first binds', { skip: GIT_SKIP }, () => {
  for (const arm of ['union', 'second-unbound']) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', OTHER);
      stageChange(dir, 'src/laneB.mjs', OTHER);
      git(dir, [
        'commit',
        '-m',
        'the survivor commit, reviewed by two agents',
        '-m',
        `Reviewed-By-Agent: reviewer-correctness\nReviewed-By-Agent: reviewer-security\nReview-Receipt: ${SURVIVOR_RECEIPT_ID}\nReview-Receipt: ${SURVIVOR_RECEIPT_B_ID}`,
      ]);
      const sha = git(dir, ['rev-parse', 'HEAD']);
      const blobA = git(dir, ['rev-parse', `${sha}:src/laneA.mjs`]);
      const blobB = git(dir, ['rev-parse', `${sha}:src/laneB.mjs`]);

      const target = v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs', 'src/laneB.mjs'], blobs: { 'src/laneA.mjs': blobA, 'src/laneB.mjs': blobB }, base_sha: sha, at: isoAgo(600_000) });
      const survivorAt = isoAgo(60_000);
      const bound = (entry_id, agent_type, path, blob) => ({
        ...v2({ entry_id, agent_type, files: [path], blobs: { [path]: blob }, at: survivorAt, status: 'consumed' }),
        consumption: { commit_sha: sha, consumed_at: survivorAt, nonce: `n-${entry_id.slice(-1)}` },
        observed_reads: [path],
        observed_source: 'subagent-transcript',
      });

      const entries = [target, bound(SURVIVOR_RECEIPT_ID, 'reviewer-correctness', 'src/laneA.mjs', blobA)];
      // 'second-unbound': the SECOND trailer names a receipt that is not in the
      // ledger at all. The first one binds perfectly and covers half the
      // territory, so an implementation that stops at the first is green here.
      if (arm === 'union') entries.push(bound(SURVIVOR_RECEIPT_B_ID, 'reviewer-security', 'src/laneB.mjs', blobB));
      writeLedger(dir, entries);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--superseded-by', sha, '--reason', `${arm}: every trailer on the survivor commit is judged`]);
      if (arm === 'union') {
        assert.equal(r.code, 0, `[${arm}] CONTROL — two bound receipts jointly covering the territory is the ordinary shape of a reviewed commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        const d = readLedger(dir).find((e) => e.entry_id === TARGET_ID).disposition;
        assert.equal(d.facts.form, 'commit', `[${arm}] the commit form ran — got ${JSON.stringify(d.facts)}`);
        assert.equal(d.facts.covered['src/laneA.mjs'].by, SURVIVOR_RECEIPT_ID, `[${arm}] each path records WHICH named receipt covered it — got ${JSON.stringify(d.facts.covered)}`);
        assert.equal(d.facts.covered['src/laneB.mjs'].by, SURVIVOR_RECEIPT_B_ID, `[${arm}] including the second one, so the union is provable and not merely claimed`);
      } else {
        assert.equal(r.code, 1, `[${arm}] one unbindable attestation makes the whole commit unusable as a survivor — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(r.json.code, 'superseder_commit_receipt_unbound', `[${arm}] got ${JSON.stringify(r.json)}`);
        assert.ok(
          JSON.stringify(r.json.facts).includes(SURVIVOR_RECEIPT_B_ID),
          `[${arm}] the facts name the trailer that failed, not merely that one did — the first receipt binds, so a bare refusal would send the operator at the wrong evidence: got ${JSON.stringify(r.json.facts)}`
        );
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
        assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', `[${arm}] and the receipt stays spendable`);
      }
      assertNoLedgerResidue(dir, `R1-C55/${arm}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C53 / R1-C54 — THE `digest` VERB. The concurrency token, obtainable from
// the same sanctioned script that demands it.
// ===========================================================================

// SABOTAGE (the hollow one): print the digest of a RE-SERIALIZATION of the parsed
// ledger rather than the file's bytes -> the byte-for-byte assertion goes red for
// this fixture (written INDENTED on purpose) and the round trip goes red with it.
// SABOTAGE (the "nothing else" one): add a banner, a label or a trailing note ->
// the exact-equality assertion goes red where a looser /match/ would not notice.
// The output is substituted straight into --digest, so anything else on stdout
// becomes part of the token.
// THE ROUND TRIP IS THE CONTROL: a digest that is merely SOME sha256 satisfies
// the shape assertions; only feeding it back into a real discharge proves it is
// THE token the verb accepts.
test('R1-C53: `digest` prints exactly the sha256 of the ledger bytes (64 lowercase hex + newline, nothing else), `digest --json` reports the same value, and both are accepted verbatim by discharge --digest', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' });
    writeFileSync(ledgerPath(dir), JSON.stringify([target, bystander(head)], null, 2));

    const r = runLedger(dir, ['digest']);
    assert.equal(r.code, 0, `digest succeeds on a readable ledger — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const expected = createHash('sha256').update(readFileSync(ledgerPath(dir))).digest('hex');
    assert.equal(r.stdout, `${expected}\n`, `the output is the hash of the EXACT bytes and NOTHING else — got ${JSON.stringify(r.stdout)}`);
    assert.match(r.stdout.trim(), /^[0-9a-f]{64}$/, 'lowercase hex, unprefixed');

    const j = runLedgerJson(dir, ['digest']);
    assert.equal(j.code, 0, `stdout=${j.stdout} stderr=${flat(j.stderr)}`);
    assert.equal(j.json.ok, true, `got ${JSON.stringify(j.json)}`);
    assert.ok(JSON.stringify(j.json).includes(expected), `the JSON form carries the same digest — got ${JSON.stringify(j.json)}`);

    const d = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', r.stdout.trim(), '--class', 'foreign-session', '--reason', 'the printed token is the token discharge accepts']);
    assert.equal(d.code, 0, `the printed digest is accepted verbatim — stdout=${d.stdout} stderr=${flat(d.stderr)}`);
    assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'discharged', 'and the discharge it authorized actually took effect');
  } finally {
    cleanup();
  }
});

// SABOTAGE: degrade any arm to a printed digest anyway -> that arm's exit-code
// and empty-stdout assertions go red. Each is a state where the printed number
// would be a valid sha256 of something that is NOT a ledger, carried straight
// into a --digest argument by a caller with no way to tell.
test('R1-C54: `digest` REFUSES a missing ledger with [ledger_absent], an unreadable one with [ledger_corrupt], and any flag with [argument_invalid] — printing nothing on stdout', { skip: GIT_SKIP }, () => {
  const arms = [
    ['missing', () => {}, [], 'ledger_absent'],
    ['corrupt', (dir) => writeFileSync(ledgerPath(dir), '{not json'), [], 'ledger_corrupt'],
    ['flag-given', (dir) => writeLedger(dir, []), ['--entry-id', TARGET_ID], 'argument_invalid'],
  ];
  for (const [label, seed, extra, code] of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      seed(dir);
      const h = runLedger(dir, ['digest', ...extra]);
      assert.equal(h.code, 1, `[${label}] must REFUSE — stdout=${JSON.stringify(h.stdout)} stderr=${flat(h.stderr)}`);
      assert.equal(h.stdout, '', `[${label}] and print NOTHING on stdout — a refusal that also prints a number is a token the caller will use — got ${JSON.stringify(h.stdout)}`);
      assert.match(h.stderr, token(code), `[${label}] the refusal carries its code — stderr=${flat(h.stderr)}`);
    } finally {
      cleanup();
    }
  }
});
