// Pins for the two new review-ledger discharge classes ('unattributable',
// 'superseded') and the `digest` verb — board 1d6d01bd, decision 57984926.
// Landed by the conductor: H5 freezes test paths for dispatched agents, so the
// coder that wrote scripts/review-ledger.mjs could not land its own pins.
// Sibling-file form, matching the existing convention for this CLI and already
// covered by the gate glob scripts/tests/review-ledger-*.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dischargeMarkerClass } from '../hooks/lib/review-ledger-entry.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

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
const bystander = (base_sha) => v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-bystander', files: ['src/base.mjs'], base_sha });

// ###########################################################################
// BOARD 1d6d01bd — THE TWO CLASSES THAT CLOSE THE MEASURED DEAD END, AND THE
// `digest` VERB THAT MAKES THE CONCURRENCY TOKEN OBTAINABLE.
//
// THE DEFECT THESE PIN (measured 2026-09-05, this repo's own ledger): eight
// roster receipts sat ACTIVE and could neither be SPENT nor DISCHARGED — six
// carrying territory.source 'unattributable' (which commit-reviewed refuses to
// stamp by construction) plus every stale-bytes receipt whose reviewer's work a
// fresh reviewer later re-did. RECOGNIZED_CLASSES held only foreign-session /
// foreign-branch / no-live-territory, none of which is true of any of them, so
// the honest operator had no route and the disclosures re-printed on every
// commit forever. The three prior dispositions were HAND REMOVALS with the
// evidence preserved in a decision record (df1b7c41, d7f9237e, ad259700) — the
// exact "delete it by hand" decision 57984926 §3 exists to abolish, performed
// three times because the verb had no class for the shape.
//
// THE REASON-VOCABULARY CONTRACT, EXTENDED. D6c already tells its three arms
// apart by per-arm refusal wording. The superseded class has a dozen distinct
// failure causes, several of them one word apart in English, so wording alone
// stops being an identity — every refusal added here carries a UNIQUE
// `[refusal: <token>]` tail, each pin asserts its own token, and S-UNIQUE pins
// that no two causes share one.
//
// WHETHER an 'unattributable'/'superseded' discharge is subsequently HONORED
// by the reading surfaces (H1's report, commit-reviewed's spending) is a
// verdict that belongs to scripts/hooks/lib/review-ledger-entry.mjs's
// isContentfulDisposition — since extended to mirror RECOGNIZED_CLASSES's
// full set, rather than only the original three class strings. S-SYNC (below)
// pins the two lists as SETS by comparing source text; the D-AUTH pins (also
// below) call isContentfulDisposition's actual entry point,
// dischargeMarkerClass, and pin its ACTUAL VERDICT for both new classes, so a
// regression that leaves both string-literal lists intact while breaking the
// comparison chain itself is still caught. These pins are about what the VERB
// verifies and records.
// ###########################################################################

const SUPERSEDER_ID = 'd0000000-0000-4000-8000-00000000000c';

// A refusal's identity token, as the CLI prints it. Asserted per pin rather than
// by prose: two of these refusals differ by a single word in English and would
// otherwise be indistinguishable from each other in a test.
const token = (t) => new RegExp(`\\[refusal: ${t}\\]`);

// ===========================================================================
// D9 — UNATTRIBUTABLE. The receipt's own territory.source is the proof.
// ===========================================================================

// SABOTAGE: record the class without reading territory.source (accept whatever
// --class says) -> D9b goes red, since a 'review-territory' receipt would then
// discharge too. SABOTAGE (other direction): reject the class outright -> this
// control goes red and every D9b green is exposed as "refuses everything".
// PLACED FIRST as the control for D9b, per this file's convention.
test('discharge D9a (CONTROL, first): --class unattributable discharges a receipt whose territory.source IS unattributable — evidence preserved, class recorded', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, source: 'unattributable' });
    const other = bystander(head);
    writeLedger(dir, [target, other]);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'unattributable',
      '--reason', 'batch-dispatched same-type reviewer; territory could not be bound to a block, so commit-reviewed will never stamp it',
    ]);
    assert.equal(r.code, 0, `a receipt that records its own unattributability is dischargeable — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const after = readLedger(dir);
    assert.equal(after.length, 2, `NOTHING is deleted — this class replaces the hand-removal precedent, it does not automate it — got ${JSON.stringify(after)}`);
    const discharged = after.find((e) => e.entry_id === TARGET_ID);
    assert.equal(discharged.status, 'discharged', 'the status flips');
    assert.equal(discharged.disposition.class, 'unattributable', 'and records the class it was verified under');
    assert.deepEqual(discharged.territory, target.territory, 'the territory evidence — including the source that PROVED the class — is preserved');
    assert.deepEqual(discharged.content_evidence, target.content_evidence, 'and so is the content evidence');
    assert.deepEqual(after.find((e) => e.entry_id === BYSTANDER_ID), other, 'the bystander is untouched');
    assertNoLedgerResidue(dir, 'D9a');
  } finally {
    cleanup();
  }
});

// SABOTAGE: treat --class unattributable as a conductor assertion the CLI merely
// records -> both arms discharge and the code/status/byte-identical assertions go
// red. A properly-attributed receipt is SPENDABLE, so discharging it retires live
// review evidence on a claim its own record denies.
// TWO ARMS because the two shapes fail differently in the code: one records a
// DIFFERENT source, the other records NO source at all.
test('discharge D9b: --class unattributable is REFUSED when the receipt does NOT record it — contradicted, never discharged on the assertion', { skip: GIT_SKIP }, () => {
  for (const arm of ['structured-territory', 'no-source-recorded']) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const entry = v2({
        entry_id: TARGET_ID,
        agent_type: 'reviewer-security',
        files: ['src/base.mjs'],
        base_sha: head,
        ...(arm === 'no-source-recorded' ? { source: undefined } : {}),
      });
      writeLedger(dir, [entry]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', 'unattributable', '--reason', `${arm}: the class must be proved by the receipt, not asserted by the caller`,
      ]);
      assert.notEqual(r.code, 0, `[${arm}] a receipt that does not record 'unattributable' must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical — a refused discharge writes nothing`);
      assert.match(r.stderr, token('class-contradicted-by-receipt'), `[${arm}] the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${arm}] and it is a refusal, not a crash — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// D10 — SUPERSEDED. Verified against a NAMED survivor, in two forms.
// ===========================================================================

/** A v2 receipt carrying the OBSERVED-READS evidence a superseder needs.
 *  `observed_reads` does not exist in any ledger yet (H22 records only the
 *  merged observed_files today; the split lands in a later slice), so these
 *  fixtures are authored against the field the CLI reads — which is exactly why
 *  D10e pins the refusal a superseder WITHOUT it gets. */
function superseder({ entry_id = SUPERSEDER_ID, files, reads = files, blobs, at, session_id = SESSION, branch = 'main', truncated = false }) {
  return {
    ...v2({ entry_id, agent_type: 'reviewer-correctness', files, blobs, base_sha: null, session_id, branch, at }),
    observed_reads: reads,
    observed_source: 'subagent-transcript',
    ...(truncated ? { observed_truncated: true } : {}),
  };
}

// EXPECTED STATE: the CONTROL for the whole superseded family. Every refusal pin
// below would be satisfied identically by a class that refuses unconditionally;
// without this green none of them carries a verdict.
// SABOTAGE (coverage half): drop the observed_reads superset test -> D10c goes
// red, this stays green — which is how the two are told apart.
// SABOTAGE (recording half): omit superseded_by from the disposition -> the
// survivor is no longer nameable from the record and this pin goes red while the
// status assertion stays green.
test('discharge D10a (CONTROL, first): --class superseded --superseded-by <entry_id> discharges against a newer same-session receipt whose observed_reads cover the territory — survivor recorded on the marker', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: isoAgo(600_000) });
    const survivor = superseder({ files: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, at: isoAgo(60_000) });
    writeLedger(dir, [target, survivor]);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', SUPERSEDER_ID,
      '--reason', 'a fresh alone-dispatched reviewer re-reviewed this territory at final bytes',
    ]);
    assert.equal(r.code, 0, `a verified supersession must succeed — stdout=${r.stdout} stderr=${flat(r.stderr)}`);

    const after = readLedger(dir);
    assert.equal(after.length, 2, `NOTHING is deleted — got ${JSON.stringify(after)}`);
    const discharged = after.find((e) => e.entry_id === TARGET_ID);
    assert.equal(discharged.status, 'discharged', 'the status flips');
    assert.equal(discharged.disposition.class, 'superseded', 'the class is recorded');
    assert.equal(
      discharged.disposition.superseded_by,
      SUPERSEDER_ID,
      `the NAMED SURVIVOR is recorded ON THE MARKER — it is the one thing that makes this class re-checkable later; got ${JSON.stringify(discharged.disposition)}`
    );
    assert.deepEqual(discharged.content_evidence, target.content_evidence, 'the discharged receipt keeps its own evidence');
    assert.deepEqual(after.find((e) => e.entry_id === SUPERSEDER_ID), survivor, 'and the SURVIVOR is untouched — a discharge writes exactly one entry');
    assertNoLedgerResidue(dir, 'D10a');
  } finally {
    cleanup();
  }
});

// SABOTAGE: default --superseded-by to "the newest other receipt" (or accept the
// class with no survivor at all) -> exit 0, the entry flips on an unverifiable
// assertion -> the code and byte-identical assertions go red. With nothing named
// there is nothing to verify, and "superseded" degrades to "I believe someone
// re-reviewed this" on a verb that makes reviewer evidence invisible.
test('discharge D10b: --class superseded with NO --superseded-by is REFUSED — a supersession that names no survivor has nothing to verify', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: isoAgo(600_000) });
    // A perfectly good survivor IS present — so the only possible cause of a
    // refusal is that the caller did not name it.
    writeLedger(dir, [target, superseder({ files: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, at: isoAgo(60_000) })]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'superseded', '--reason', 'no survivor named']);
    assert.notEqual(r.code, 0, `the survivor is REQUIRED — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, /--superseded-by/, `the refusal names the missing argument — stderr=${flat(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `and it is a refusal, not a crash — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: test coverage with `.some()` instead of a superset (or compare only
// the first declared path) -> this discharges a receipt whose second path nobody
// re-read -> the code/status assertions go red. Superseding on PARTIAL coverage
// retires review evidence for exactly the paths nobody looked at again.
test("discharge D10c: --class superseded is REFUSED when the survivor's observed_reads miss ANY covered path — the superset is required, not an overlap", { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs'), 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs', 'src/laneA.mjs'], base_sha: head, at: isoAgo(600_000) });
    // The survivor read ONE of the two — everything else about it is correct.
    writeLedger(dir, [target, superseder({ files: ['src/base.mjs', 'src/laneA.mjs'], reads: ['src/base.mjs'], blobs, at: isoAgo(60_000) })]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'partial coverage must not discharge',
    ]);
    assert.notEqual(r.code, 0, `partial coverage is not supersession — REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('superseder-observed-reads-incomplete'), `the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /src\/laneA\.mjs/, `and NAMES the path the survivor never read — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: drop the identity comparison and accept any newer covering receipt
// -> a receipt from another session discharges this one -> the code and status
// assertions go red. A receipt earned elsewhere is evidence about other work; if
// THAT is the fact, foreign-session/foreign-branch are the classes for it.
// NOTE the survivor is otherwise perfect (newer, covering, blob-bound), so the
// identity is the only possible cause.
test('discharge D10d: --class superseded is REFUSED when the named survivor belongs to another SESSION — identity must be known and equal on both sides', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: isoAgo(600_000) });
    writeLedger(dir, [
      target,
      superseder({ files: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, at: isoAgo(60_000), session_id: 'a-different-session' }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'a foreign-session survivor is evidence about other work',
    ]);
    assert.notEqual(r.code, 0, `a survivor from another session must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('superseder-identity-mismatch'), `the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE — THE ONE THIS PIN EXISTS FOR: fall back to observed_files when
// observed_reads is absent -> this discharges, and the code/status assertions go
// red. observed_files is reads UNION WRITES, so the fallback would let an agent's
// own WRITES count as having reviewed the file — the exact inversion of review
// evidence. The fixture's survivor carries a covering observed_files precisely so
// a fallback implementation passes everything else and fails only here.
test('discharge D10e: --class superseded is REFUSED when the survivor records NO observed_reads — there is NO fallback to observed_files (reads UNION WRITES)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: isoAgo(600_000) });
    const survivor = {
      ...v2({
        entry_id: SUPERSEDER_ID,
        agent_type: 'reviewer-correctness',
        files: ['src/base.mjs'],
        blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') },
        base_sha: null,
        at: isoAgo(60_000),
      }),
      observed_files: ['src/base.mjs'], // covering — but reads ∪ WRITES, so not review evidence
      observed_source: 'subagent-transcript',
    };
    writeLedger(dir, [target, survivor]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'observed_files is not observed_reads',
    ]);
    assert.notEqual(r.code, 0, `a survivor with no observed_reads must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('superseder-predates-observed-reads'), `the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /observed_files/, `and states WHY there is no fallback, so the next reader does not add one as a convenience — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: accept any commit sha as a survivor without reading its trailers ->
// the no-trailer arm discharges -> its code/status assertions go red. A commit
// with no review attestation is evidence that work LANDED, not that anything
// reviewed it: accepting one would let committing the work discharge the
// requirement to review it.
// THE OK ARM IS THE CONTROL for the refusing arm.
test('discharge D10f: --class superseded --superseded-by <40-hex sha> — a commit carrying a Reviewed-By-Agent trailer and covering the territory discharges; the SAME commit without the trailer is REFUSED', { skip: GIT_SKIP }, () => {
  for (const arm of ['trailer', 'no-trailer']) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', CODE);
      git(dir, ['commit', '-m', arm === 'trailer' ? 'the survivor commit\n\nReviewed-By-Agent: reviewer-correctness' : 'the survivor commit, unreviewed']);
      const sha = git(dir, ['rev-parse', 'HEAD']);
      const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/laneA.mjs'], base_sha: sha, at: isoAgo(600_000) });
      writeLedger(dir, [target, bystander(sha)]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', 'superseded', '--superseded-by', sha, '--reason', `${arm}: the commit form is verified against the commit itself`,
      ]);

      if (arm === 'trailer') {
        assert.equal(r.code, 0, `[${arm}] a stamped commit covering the territory is a valid survivor — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        const discharged = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
        assert.equal(discharged.status, 'discharged', `[${arm}] the status flips`);
        assert.equal(discharged.disposition.class, 'superseded', `[${arm}] the class is recorded`);
        assert.equal(discharged.disposition.superseded_by, sha, `[${arm}] and the survivor COMMIT is recorded on the marker`);
        assert.deepEqual(discharged.content_evidence, target.content_evidence, `[${arm}] with the receipt's own evidence preserved`);
        assertNoLedgerResidue(dir, 'D10f');
      } else {
        assert.notEqual(r.code, 0, `[${arm}] an unreviewed commit is not review evidence — REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
        assert.match(r.stderr, token('superseder-commit-lacks-review-trailer'), `[${arm}] the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
      }
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: skip the file-coverage check on the commit form -> a stamped commit
// that touched something else entirely discharges this receipt -> the code and
// status assertions go red. The trailer says SOMETHING was reviewed; the file
// list is what says it was THIS territory.
test('discharge D10g: the commit form is REFUSED when the stamped commit does not touch a covered path — a trailer is not a blank cheque over the repository', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/unrelated.mjs', OTHER);
    git(dir, ['commit', '-m', 'a reviewed commit about something else\n\nReviewed-By-Agent: reviewer-correctness']);
    const sha = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: sha, at: isoAgo(600_000) })]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', sha, '--reason', 'the commit reviewed other files',
    ]);
    assert.notEqual(r.code, 0, `a commit that never touched the territory cannot supersede its review — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('superseder-commit-territory-incomplete'), `the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
    assert.match(r.stderr, /src\/base\.mjs/, `and names the uncovered path — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: rest the cycle case on the "survivor must be active" test alone (drop
// the explicit check) -> the refusal still fires but under the WRONG token, so the
// token assertion goes red. Two receipts naming each other retire both while
// nothing reviewed anything; the refusal has to say that, not "not active".
test('discharge D10h: a SUPERSESSION CYCLE is REFUSED — an entry already discharged as superseded BY THIS ONE can never supersede it back', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: isoAgo(600_000) });
    const survivor = {
      ...superseder({ files: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, at: isoAgo(60_000) }),
      status: 'discharged',
      disposition: {
        reason: 'retired in favour of the other one',
        at: isoAgo(30_000),
        head_sha: head,
        classifier_version: 1,
        class: 'superseded',
        superseded_by: TARGET_ID, // …which is the entry now trying to name IT
      },
    };
    writeLedger(dir, [target, survivor]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'mutual supersession must not retire both',
    ]);
    assert.notEqual(r.code, 0, `a cycle must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('supersession-cycle'), `the refusal names the CYCLE, not a generic inactivity — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: delete the blob-evidence-per-covered-path check at
// review-ledger.mjs:1218-1233 -> this pin goes red while D10a stays green —
// D10a's survivor already carries a usable blob for its one covered path and
// never exercises a gap, so it cannot tell the deleted guard apart from an
// always-passing one.
test("discharge D10i: --class superseded is REFUSED when the survivor's observed_reads cover every path but content_evidence.blobs lacks a usable sha for one covered path", { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    stageChange(dir, 'src/laneA.mjs', CODE);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs', 'src/laneA.mjs'], base_sha: head, at: isoAgo(600_000) });
    // observed_reads covers BOTH paths — only the blob evidence is incomplete.
    const survivor = superseder({
      files: ['src/base.mjs', 'src/laneA.mjs'],
      reads: ['src/base.mjs', 'src/laneA.mjs'],
      blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, // laneA.mjs has no usable sha
      at: isoAgo(60_000),
    });
    writeLedger(dir, [target, survivor]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'reads cover both paths but blob evidence is incomplete for one',
    ]);
    assert.notEqual(r.code, 0, `full read coverage without full blob evidence must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('superseder-content-evidence-incomplete'), `the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: delete the truncation check at review-ledger.mjs:1198-1205 -> this
// pin goes red. The fixture's observed_reads and blobs are otherwise a perfect,
// fully-covering survivor (it would pass D10a's shape) — only `truncated: true`
// distinguishes it, which is exactly the `superseder()` option no prior test in
// this file ever passed.
test("discharge D10j: --class superseded is REFUSED when the survivor's observed capture is marked TRUNCATED — a superset over a truncated set proves nothing", { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: isoAgo(600_000) });
    const survivor = superseder({
      files: ['src/base.mjs'],
      blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') },
      at: isoAgo(60_000),
      truncated: true,
    });
    writeLedger(dir, [target, survivor]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'a truncated observed capture cannot verify coverage',
    ]);
    assert.notEqual(r.code, 0, `a truncated observed capture must REFUSE even though its observed_reads appears to cover the territory — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('superseder-observed-reads-truncated'), `the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: change the finished_at comparison at review-ledger.mjs:1162-1175
// from strict (>) to >= -> the EQUAL arm goes red (it would then discharge)
// while the OLDER arm stays red for an unrelated, unchanged reason — which is
// how a >= regression is told apart from a guard that was deleted outright.
// NOTE ON PROVENANCE: authored strictly from the brief's stated design
// (strictly-newer: an equal instant refuses, same token as a strictly-older
// one). H4 denied this agent a read of review-ledger.mjs to confirm which
// operator :1162-1175 actually implements, so if the code instead accepts
// equal instants (>=), this pin's 'equal' arm is EXPECTED to fail — that
// mismatch is a finding for the conductor to confirm against source, not
// something this test should be weakened to avoid.
test("discharge D10k: --class superseded is REFUSED when the named survivor's finished_at is not STRICTLY newer than the discharged entry — older AND equal instants both refuse", { skip: GIT_SKIP }, () => {
  for (const arm of ['older', 'equal']) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      const targetAt = isoAgo(60_000);
      const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: targetAt });
      const survivorAt = arm === 'equal' ? targetAt : isoAgo(600_000); // 'older' -> survivor finished BEFORE the target
      const survivor = superseder({ files: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, at: survivorAt });
      writeLedger(dir, [target, survivor]);
      const before = readLedgerRaw(dir);

      const r = runLedger(dir, [
        'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
        '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', `${arm}: the survivor must be strictly newer`,
      ]);
      assert.notEqual(r.code, 0, `[${arm}] a survivor that is not strictly newer must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      assert.match(r.stderr, token('superseder-not-newer'), `[${arm}] the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: drop the named survivor's own active-status check at
// review-ledger.mjs:1136 -> this pin goes red while D10h (the CYCLE, a
// different cause at a different line) stays green — D10h's fixture is
// discharged specifically FOR NAMING THIS TARGET, so it cannot exercise "the
// survivor is inactive for an unrelated reason" on its own.
test('discharge D10l: --class superseded is REFUSED when the named survivor is itself already discharged — for an unrelated reason, not a cycle', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: isoAgo(600_000) });
    const survivor = {
      ...superseder({ files: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, at: isoAgo(60_000) }),
      status: 'discharged',
      disposition: {
        reason: 'retired for an unrelated foreign-session finding',
        at: isoAgo(30_000),
        head_sha: head,
        classifier_version: 1,
        class: 'foreign-session',
      },
    };
    writeLedger(dir, [target, survivor]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', SUPERSEDER_ID, '--reason', 'a discharged survivor cannot supersede anything further',
    ]);
    assert.notEqual(r.code, 0, `a survivor that is not itself active must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('superseder-not-active'), `the refusal carries its own identity token, distinct from the CYCLE token D10h asserts — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: drop the self-reference check at review-ledger.mjs:1108 -> the
// entry looks itself up as its own named survivor and this pin goes red; a
// receipt cannot be evidence that ITSELF was reviewed again.
test('discharge D10m: --class superseded --superseded-by <the SAME entry-id> is REFUSED — an entry cannot supersede itself', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, at: isoAgo(600_000) });
    writeLedger(dir, [target]);
    const before = readLedgerRaw(dir);

    const r = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir),
      '--class', 'superseded', '--superseded-by', TARGET_ID, '--reason', 'an entry cannot be its own survivor',
    ]);
    assert.notEqual(r.code, 0, `naming the entry itself as its own superseder must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.match(r.stderr, token('superseder-is-the-discharged-entry'), `the refusal carries its own identity token — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// D11 — THE `digest` VERB. The concurrency token, obtainable from the same
// sanctioned script that demands it (every other route to it names a
// `.sterling/` path in a shell, which H15 denies).
// ===========================================================================

// SABOTAGE (the hollow-test one): print a digest of a RE-SERIALIZATION of the
// parsed ledger rather than the file's bytes -> the byte-for-byte assertion goes
// red for this fixture (written INDENTED on purpose), and the round-trip arm goes
// red too. That is exactly the substitution decision 57984926 §3 rejected mtime
// for, one level down.
// SABOTAGE (the "nothing else" one): add a banner, a label or a trailing note ->
// the exact-equality assertion goes red while a looser /match/ would not have
// noticed. The output is substituted straight into --digest, so anything else on
// stdout becomes part of the token.
// THE ROUND TRIP IS THE CONTROL: a digest that is merely SOME sha256 would
// satisfy the shape assertions; only feeding it back into a real discharge proves
// it is THE token the verb accepts.
test('discharge D11a: `digest` prints exactly the sha256 of the ledger bytes (64 lowercase hex + newline, nothing else) — and that value is accepted by discharge --digest', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const target = v2({ entry_id: TARGET_ID, agent_type: 'reviewer-security', files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' });
    writeFileSync(ledgerPath(dir), JSON.stringify([target, bystander(head)], null, 2));

    const r = runLedger(dir, ['digest']);
    assert.equal(r.code, 0, `digest must succeed on a readable ledger — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const expected = createHash('sha256').update(readFileSync(ledgerPath(dir))).digest('hex');
    assert.equal(
      r.stdout,
      `${expected}\n`,
      `the output is the hash of the EXACT bytes and NOTHING else — one line, 64 lowercase hex, a trailing newline. got=${JSON.stringify(r.stdout)}`
    );
    assert.match(r.stdout.trim(), /^[0-9a-f]{64}$/, 'lowercase hex, unprefixed');

    // THE ROUND TRIP.
    const d = runLedger(dir, [
      'discharge', '--entry-id', TARGET_ID, '--digest', r.stdout.trim(),
      '--class', 'foreign-session', '--reason', 'the printed token is the token discharge accepts',
    ]);
    assert.equal(d.code, 0, `the printed digest must be accepted verbatim as the concurrency token — stdout=${d.stdout} stderr=${flat(d.stderr)}`);
    assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'discharged', 'and the discharge it authorized actually took effect');
  } finally {
    cleanup();
  }
});

// SABOTAGE: degrade any of these to a printed digest anyway -> the arm's
// exit-code assertion goes red. Each is a state where the printed number would be
// a valid sha256 of something that is NOT a ledger, carried straight into a
// --digest argument by a caller who has no way to tell.
test('discharge D11b: `digest` REFUSES a missing, non-regular or unparseable ledger, and REFUSES any flag — it takes zero arguments', { skip: GIT_SKIP }, () => {
  const arms = [
    ['missing', () => {}, [], /no review ledger/i],
    ['non-regular', (dir) => mkdirSync(ledgerPath(dir), { recursive: true }), [], /regular file/i],
    ['unparseable', (dir) => writeFileSync(ledgerPath(dir), '{not json'), [], /valid JSON/i],
    ['not-an-array', (dir) => writeFileSync(ledgerPath(dir), '{"entries":[]}'), [], /array/i],
    ['flag-given', (dir) => writeLedger(dir, []), ['--entry-id', TARGET_ID], /no arguments/i],
  ];
  for (const [label, seed, extra, wording] of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      seed(dir);
      const r = runLedger(dir, ['digest', ...extra]);
      assert.notEqual(r.code, 0, `[${label}] must REFUSE — stdout=${JSON.stringify(r.stdout)} stderr=${flat(r.stderr)}`);
      assert.equal(r.stdout, '', `[${label}] and print NOTHING on stdout — a refusal that also prints a number is a token the caller will use — got ${JSON.stringify(r.stdout)}`);
      assert.match(r.stderr, wording, `[${label}] the refusal names the real problem — stderr=${flat(r.stderr)}`);
      assert.doesNotMatch(r.stderr, /TypeError|ReferenceError/, `[${label}] and it is a refusal, not a crash — stderr=${flat(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// S-UNIQUE — THE REASON-VOCABULARY CONTRACT, STATED AS ITS OWN CLAIM.
// ===========================================================================

// This is a claim about the SOURCE, not about a run: two refusal causes sharing
// one token are indistinguishable at every surface that reads them (a caller, a
// test, a later reader of disposition.facts.refusal_class), and the duplicate is
// invisible in any single refusal's output. Asserted here rather than left to
// review because it is mechanically checkable and silently broken by the next
// copy-pasted refusal.
// SABOTAGE: give two classRefusal() calls the same token -> red, naming it.
// CONTROL (non-vacuity): the token set must be NON-EMPTY — a regex that matched
// nothing would otherwise report "all unique" forever.
test('discharge S-UNIQUE: every refusal token in review-ledger.mjs is used by exactly ONE cause', () => {
  const src = readFileSync(join(root, 'scripts', 'review-ledger.mjs'), 'utf8');
  const tokens = [...src.matchAll(/classRefusal\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(
    tokens.length >= 10,
    `CONTROL: the extractor must actually find the refusal tokens — if this is 0 the uniqueness assertion below is vacuous and the pattern is what changed, not the code. found=${JSON.stringify(tokens)}`
  );
  const duplicates = tokens.filter((t, i) => tokens.indexOf(t) !== i);
  assert.deepEqual([...new Set(duplicates)], [], `two refusal causes share one identity token — tokens=${JSON.stringify(tokens)}`);
});

// ===========================================================================
// S-SYNC — RECOGNIZED_CLASSES (scripts/review-ledger.mjs — what `discharge`
// ACCEPTS) and the classes isContentfulDisposition authenticates
// (scripts/hooks/lib/review-ledger-entry.mjs — what a written marker is
// TRUSTED as, at every reading surface) must name the SAME SET. The docblock
// above isContentfulDisposition says so explicitly ("this is §3's closed set,
// mirroring scripts/review-ledger.mjs's RECOGNIZED_CLASSES") — nothing
// mechanically enforced it until this pin.
//
// THE DEFECT THIS PIN EXISTS FOR (measured, this repo, 2026-09-06): two
// classes ('unattributable', 'superseded') were added to RECOGNIZED_CLASSES
// but never mirrored into isContentfulDisposition's comparison chain. The
// consequence is silent and severe: `discharge --class unattributable` (or
// `superseded`) EXITS 0 and flips the entry to status:'discharged' — but the
// marker then classifies as unauthenticated at every reading surface, so H1
// keeps reporting the receipt forever and commit-reviewed keeps disclosing
// it. A verb that reports success and changes nothing, forever.
// ===========================================================================

// Extracts the quoted string literals inside the RECOGNIZED_CLASSES
// declaration, tolerant of `= [...]` or `= new Set([...])` and either quote
// style. Scoped to the declaration's own bracket span, not the whole file.
function extractRecognizedClasses(src) {
  const m = src.match(/RECOGNIZED_CLASSES\s*=\s*(?:new Set\()?\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map((x) => x[1]);
}

// Extracts the isContentfulDisposition FUNCTION BODY by BRACE-COUNTING from
// its opening `{` (tolerant of `function isContentfulDisposition(...)` or a
// `const isContentfulDisposition = (...) =>` form), then extracts every
// `d.class === '...'` comparison found ONLY inside that span — so an
// unrelated `d.class === ...` elsewhere in the file cannot pollute the count.
// A single regex cannot safely bound a function body against nested braces
// (nested conditionals, object literals, comments), so this walks the source
// counting braces instead of trying to match the whole function in one shot.
function extractAuthenticatedClasses(src) {
  const start = src.search(
    /(?:function\s+isContentfulDisposition\s*\([^)]*\)|(?:const|let|var)\s+isContentfulDisposition\s*=\s*(?:function)?\s*\([^)]*\)\s*=>)\s*\{/
  );
  if (start === -1) return { classes: [], found: false };
  const openBrace = src.indexOf('{', start);
  let depth = 1;
  let i = openBrace + 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  const body = src.slice(openBrace + 1, i - 1);
  const classes = [...body.matchAll(/d\.class\s*===\s*['"]([a-z0-9-]+)['"]/g)].map((x) => x[1]);
  return { classes, found: true };
}

// SABOTAGE: delete `d.class === 'superseded'` from isContentfulDisposition ->
// the authenticated-set extraction drops 'superseded' -> the expected-
// membership control for 'superseded' in `authenticated` goes red FIRST,
// naming it by itself; even if that control were absent, the set-equality
// assertion below would then name 'superseded' as accepted by
// RECOGNIZED_CLASSES but never authenticated, and spell out the silent
// no-op consequence.
test('discharge S-SYNC: RECOGNIZED_CLASSES (review-ledger.mjs) and the classes isContentfulDisposition authenticates (review-ledger-entry.mjs) are the SAME SET', () => {
  const ledgerSrc = readFileSync(join(root, 'scripts', 'review-ledger.mjs'), 'utf8');
  const entrySrc = readFileSync(join(root, 'scripts', 'hooks', 'lib', 'review-ledger-entry.mjs'), 'utf8');

  const recognized = extractRecognizedClasses(ledgerSrc);
  const { classes: authenticated, found } = extractAuthenticatedClasses(entrySrc);

  // CONTROLS FIRST — a vacuous extraction must fail loudly, never pass as "[] === []".
  assert.ok(
    recognized.length > 0,
    `CONTROL: could not extract any class from RECOGNIZED_CLASSES in scripts/review-ledger.mjs — the extractor's pattern is what changed, not the code, so the equality check below would be vacuous`
  );
  assert.ok(
    found,
    `CONTROL: could not locate the isContentfulDisposition function in scripts/hooks/lib/review-ledger-entry.mjs — the extractor's pattern is what changed, not the code`
  );
  assert.ok(
    authenticated.length > 0,
    `CONTROL: isContentfulDisposition was found but yielded zero 'd.class === ...' comparisons — the extractor's pattern is what changed, not the code, so the equality check below would be vacuous`
  );

  const EXPECTED_MEMBERS = ['foreign-session', 'foreign-branch', 'no-live-territory', 'unattributable', 'superseded'];
  for (const cls of EXPECTED_MEMBERS) {
    assert.ok(
      recognized.includes(cls),
      `RECOGNIZED_CLASSES must still include '${cls}' — got ${JSON.stringify(recognized)} (a drifted extraction pattern would silently stop matching real classes)`
    );
    assert.ok(
      authenticated.includes(cls),
      `isContentfulDisposition must still authenticate '${cls}' — got ${JSON.stringify(authenticated)} (a drifted extraction pattern would silently stop matching real comparisons)`
    );
  }

  const recognizedSet = new Set(recognized);
  const authenticatedSet = new Set(authenticated);
  const acceptedButNotAuthenticated = recognized.filter((c) => !authenticatedSet.has(c));
  const authenticatedButNotAccepted = authenticated.filter((c) => !recognizedSet.has(c));

  assert.deepEqual(
    acceptedButNotAuthenticated,
    [],
    `discharge ACCEPTS ${JSON.stringify(acceptedButNotAuthenticated)} but isContentfulDisposition never AUTHENTICATES ${acceptedButNotAuthenticated.length === 1 ? 'it' : 'them'} — ` +
      `a --class in this list exits 0 and flips the entry to 'discharged', but the marker then reads as unauthenticated at every reading surface (H1's report, commit-reviewed's spending), so the receipt keeps disclosing forever. ` +
      `recognized=${JSON.stringify(recognized)} authenticated=${JSON.stringify(authenticated)}`
  );
  assert.deepEqual(
    authenticatedButNotAccepted,
    [],
    `isContentfulDisposition authenticates ${JSON.stringify(authenticatedButNotAccepted)} but RECOGNIZED_CLASSES never accepts ${authenticatedButNotAccepted.length === 1 ? 'it' : 'them'} — dead code authenticating a class the verb can never write. ` +
      `recognized=${JSON.stringify(recognized)} authenticated=${JSON.stringify(authenticated)}`
  );
});

// ===========================================================================
// D-AUTH — THE BEHAVIOURAL PIN FOR THE CROSS-FILE AUTHENTICATOR.
//
// S-SYNC (above) proves RECOGNIZED_CLASSES and isContentfulDisposition's
// comparison chain name the SAME SET — by comparing SOURCE TEXT. That is a
// real pin, but it stays GREEN under real regressions that never touch either
// string-literal list: adding `&& d.facts !== undefined` to
// isContentfulDisposition, or an early `if (d.class === 'unattributable')
// return false;` inserted above the chain, both leave the two lists
// byte-identical while silently turning the discharge back into a no-op.
// These pins call the ACTUAL FUNCTION, `dischargeMarkerClass`, and assert its
// ACTUAL VERDICT for a real marker shape — the thing S-SYNC cannot see.
// ===========================================================================

// CONTROL, FIRST: an invented class must NOT authenticate. Without this arm, a
// dischargeMarkerClass hardcoded to return 'authenticated' unconditionally
// would satisfy both class-specific pins below and neither would carry a
// verdict.
// SABOTAGE: make dischargeMarkerClass return 'authenticated' unconditionally
// (or drop its class check entirely) -> this control goes red, exposing that
// the function authenticates everything rather than the closed set.
test('discharge D-AUTH (CONTROL, first): dischargeMarkerClass does NOT authenticate an invented, unrecognized class', () => {
  const verdict = dischargeMarkerClass({
    schema_version: 2,
    status: 'discharged',
    v2_deficient: false,
    disposition: { reason: 'x', class: 'not-a-real-class' },
  });
  assert.equal(verdict, 'unauthenticated', `an invented class must not authenticate — got ${JSON.stringify(verdict)}`);
});

// SABOTAGE: add `&& d.facts !== undefined` to isContentfulDisposition's
// comparison chain, or an early `if (d.class === 'unattributable') return
// false;` above the chain -> this arm goes red while S-SYNC (source-text
// comparison) stays green, since neither regression touches either
// class-name string literal.
test("discharge D-AUTH: dischargeMarkerClass authenticates a discharged v2 marker with disposition.class 'unattributable'", () => {
  const verdict = dischargeMarkerClass({
    schema_version: 2,
    status: 'discharged',
    v2_deficient: false,
    disposition: { reason: 'x', class: 'unattributable' },
  });
  assert.equal(verdict, 'authenticated', `an 'unattributable' marker must authenticate — got ${JSON.stringify(verdict)}`);
});

// SABOTAGE: same class of regression, targeted at 'superseded' specifically —
// the two new classes could be mirrored ASYMMETRICALLY (one added to the
// comparison chain, the other missed), which the shared control above cannot
// catch and which S-SYNC's set-equality check WOULD catch only if the source
// text itself dropped the literal; this arm catches a chain-order or
// short-circuit bug that never touches the literal at all.
test("discharge D-AUTH: dischargeMarkerClass authenticates a discharged v2 marker with disposition.class 'superseded'", () => {
  const verdict = dischargeMarkerClass({
    schema_version: 2,
    status: 'discharged',
    v2_deficient: false,
    disposition: { reason: 'x', class: 'superseded' },
  });
  assert.equal(verdict, 'authenticated', `a 'superseded' marker must authenticate — got ${JSON.stringify(verdict)}`);
});
