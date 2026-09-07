// REVIEW-LEDGER `reconcile` — CRASH RECOVERY FOR A TWO-PHASE SPEND (NEW FILE,
// R1 PIN RE-CUT).
//
// AUTHORITY: decision review-receipt-rebuild-invariant-three-owner-modules-
// tri-state-liveness-receipt-bound-supersession ("on crash a `reconcile` verb
// finalizes a uniquely matching commit or releases the reservation"), contract
// sheet §3.1 (the verb), §1.2 (reservation/consumption shapes) and §6 A5 (one
// owner-mkdir lock, no force flag) / A7 (reconcile is crash recovery for RESERVED
// entries ONLY — there is no rebind/re-attest verb).
//
// THE SHAPE OF THE SPEND THIS RECOVERS: select → RESERVE (status 'reserved' with
// a nonce and the exact index blob map) → commit → verify → FINALIZE (reserved →
// consumed {commit_sha, consumed_at, nonce}). If the process dies between the
// commit and the finalize, the entry stays reserved and NOTHING else may touch
// it — discharge refuses it, other spenders refuse it. `reconcile` is the only
// way out, and it decides from git rather than from anyone's memory:
//   * exactly one commit reachable from HEAD carrying `Review-Receipt: <id>`
//     whose TREE BLOBS equal the reservation's index_blobs -> finalize consumed;
//   * no such commit -> release to active (the reservation is cleared);
//   * several -> [reconcile_ambiguous], nothing written;
//   * nothing reserved at all -> ok with reconciled: [] — an empty queue is not
//     a refusal.
//
// CONVENTIONS: refusals by `[code]` token / `--json`'s `code`; facts as fields;
// a refused reconcile leaves the ledger byte-identical.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
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

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-review-ledger-reconcile-'));
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
const lockDir = (dir) => join(dir, '.sterling', 'review-ledger.lock');
const ownerTokenPath = (dir) => join(lockDir(dir), 'owner.json');

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

function runLedger(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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
  status = 'active',
  reservation = undefined,
  consumption = undefined,
  disposition = null,
  at = isoAgo(60_000),
}) {
  const e = {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status,
    started_at: at,
    finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch, base_sha, agent_id: 'agent-0001' },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs, absent_paths: [] },
    disposition,
  };
  if (reservation) e.reservation = reservation;
  if (consumption) e.consumption = consumption;
  return e;
}

const RESERVED_ID = 'f0000000-0000-4000-8000-00000000000a';
const BYSTANDER_ID = 'f0000000-0000-4000-8000-00000000000b';
const NONCE = 'op-4242';
const CODE = 'export const f = 1;\n';
const OTHER = 'export const f = 2;\n';

/** The state a crash between "commit" and "finalize" leaves behind: a committed
 *  commit carrying `Review-Receipt: <id>`, and a ledger entry still RESERVED with
 *  the exact index blob map that was staged. */
function crashedSpend(dir, { entryId = RESERVED_ID, withTrailer = true, content = CODE } = {}) {
  stageChange(dir, 'src/laneA.mjs', content);
  const blob = git(dir, ['hash-object', 'src/laneA.mjs']);
  const trailers = ['Reviewed-By-Agent: reviewer-security'];
  if (withTrailer) trailers.push(`Review-Receipt: ${entryId}`);
  git(dir, ['commit', '-m', 'the spent commit', '-m', trailers.join('\n')]);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const reservation = { nonce: NONCE, at: isoAgo(5_000), index_blobs: { 'src/laneA.mjs': blob }, operation: 'commit-reviewed' };
  const entry = v2({ entry_id: entryId, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: sha, status: 'reserved', reservation });
  return { sha, blob, reservation, entry };
}

// ===========================================================================
// R1-C100 — AN EMPTY QUEUE IS NOT A REFUSAL (CONTROL, PLACED FIRST).
// Every pin below reads a `reconciled` array or a refusal code; without this one
// they are all satisfied by a verb that refuses unconditionally, and a verb that
// refuses on an empty queue would be run once, distrusted, and never run again
// at exactly the moment it is needed.
// ===========================================================================

// SABOTAGE: treat "nothing reserved" as [reconcile_no_match] and exit 1 -> the
// exit-code and ok:true assertions go red.
// SABOTAGE (the write half): rewrite the ledger even when there is nothing to do
// -> the byte-identical assertion goes red; a no-op that rewrites an evidence
// file invalidates every outstanding digest token for no reason.
test('R1-C100 (CONTROL, first): with NOTHING reserved, `reconcile` exits 0 with ok:true and reconciled:[] — and the ledger is byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [
      v2({ entry_id: BYSTANDER_ID, files: ['src/base.mjs'], base_sha: head }),
      v2({ entry_id: RESERVED_ID, files: ['src/base.mjs'], base_sha: head, status: 'consumed', consumption: { commit_sha: head, consumed_at: isoAgo(10_000), nonce: NONCE } }),
    ]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['reconcile']);
    assert.equal(r.code, 0, `an empty queue is not a refusal — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.parseError, null, `--json emits exactly one parseable object — stdout=${JSON.stringify(r.stdout)}`);
    assert.equal(r.json.ok, true, `got ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.json.reconciled, [], `and reports that it did nothing, explicitly — got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — an ACTIVE and a CONSUMED entry are both none of this verb’s business');
    assertNoLedgerResidue(dir, 'R1-C100');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C101 — THE FINALIZE PATH.
// ===========================================================================

// SABOTAGE (the whole pin): finalize from the reservation alone, without finding
// the commit -> a reservation whose commit never landed would be marked consumed
// against nothing; here it passes, so pair it with R1-C102, whose release arm
// goes red under the same edit. The two are read together.
// SABOTAGE (the nonce half): mint a fresh nonce at finalize time instead of
// carrying the reservation's -> the nonce assertion goes red alone. The nonce is
// what ties this consumption to THAT reservation; a new one makes the pairing
// unprovable after the fact.
// SABOTAGE (the reservation half): leave `reservation` in place beside the new
// `consumption` -> the undefined assertion goes red, and the entry stays visible
// to a second reconcile forever.
test('R1-C101: a RESERVED entry whose commit is reachable from HEAD with matching tree blobs is FINALIZED to consumed {commit_sha, consumed_at, nonce} — the reservation is cleared and the bystander untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { sha, entry } = crashedSpend(dir);
    const bystander = v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-bystander', files: ['src/base.mjs'], base_sha: sha });
    writeLedger(dir, [entry, bystander]);
    const tMin = Date.now() - 1_000;

    const r = runLedgerJson(dir, ['reconcile']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.ok, true, `got ${JSON.stringify(r.json)}`);
    assert.equal(r.json.reconciled.length, 1, `exactly one entry was reconciled — got ${JSON.stringify(r.json.reconciled)}`);

    const after = readLedger(dir).find((e) => e.entry_id === RESERVED_ID);
    assert.equal(after.status, 'consumed', `the entry is finalized — got ${JSON.stringify(after)}`);
    assert.equal(after.consumption.commit_sha, sha, 'bound to the commit that named it');
    assert.equal(after.consumption.nonce, NONCE, `carrying the RESERVATION's nonce, so the pairing stays provable — got ${JSON.stringify(after.consumption)}`);
    const at = Date.parse(after.consumption.consumed_at);
    assert.ok(Number.isFinite(at) && at >= tMin && at <= Date.now() + 1_000, `consumed_at is the moment of the finalize — got ${JSON.stringify(after.consumption.consumed_at)}`);
    assert.equal(after.reservation, undefined, 'and the reservation is cleared — an entry cannot be both reserved and consumed');

    for (const k of ['reviewer', 'territory', 'content_evidence', 'identity']) {
      assert.deepEqual(after[k], entry[k], `${k} survives the finalize unchanged`);
    }
    assert.deepEqual(readLedger(dir).find((e) => e.entry_id === BYSTANDER_ID), bystander, 'the ACTIVE bystander is byte-for-byte untouched');
    assertNoLedgerResidue(dir, 'R1-C101');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C102 — THE RELEASE PATH, in the two ways a match can fail to exist.
// ===========================================================================

// SABOTAGE (the release half): leave the entry reserved when no commit matches ->
// both arms go red and a receipt whose commit never landed is wedged forever:
// discharge refuses it, spending refuses it, and the operator has no sanctioned
// move left.
// SABOTAGE (the blob half): match on the trailer alone and skip the blob
// comparison -> the 'blob-mismatch' arm FINALIZES and goes red while 'no-commit'
// stays green. That is the dangerous half: it would bind a receipt to a commit
// carrying DIFFERENT bytes than the ones that were staged and reviewed, which is
// precisely the attestation the byte rule exists to prevent.
// SABOTAGE (the preservation half): drop the reservation AND the entry -> the
// survival assertions go red; a released entry must return to exactly the state
// it was in before the spend began.
test('R1-C102: a RESERVED entry with NO matching commit is RELEASED to active with its reservation cleared — both when no commit names it and when a naming commit\'s tree blobs differ', { skip: GIT_SKIP }, () => {
  for (const arm of ['no-commit', 'blob-mismatch']) {
    const { dir, cleanup } = makeRepo();
    try {
      const crashed = crashedSpend(dir, { withTrailer: arm !== 'no-commit' });
      // 'blob-mismatch': the commit DOES name the entry, but the reservation
      // recorded a different index blob than the tree the commit holds.
      const reservation = arm === 'blob-mismatch' ? { ...crashed.reservation, index_blobs: { 'src/laneA.mjs': 'c'.repeat(40) } } : crashed.reservation;
      const entry = { ...crashed.entry, reservation };
      writeLedger(dir, [entry]);

      const r = runLedgerJson(dir, ['reconcile']);
      assert.equal(r.code, 0, `[${arm}] a release is an ordinary outcome, not a refusal — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      const after = readLedger(dir).find((e) => e.entry_id === RESERVED_ID);
      assert.equal(after.status, 'active', `[${arm}] the entry returns to ACTIVE so it can be spent or discharged again — got ${JSON.stringify(after)}`);
      assert.equal(after.reservation, undefined, `[${arm}] and the reservation is cleared`);
      assert.equal(after.consumption, undefined, `[${arm}] with NO consumption invented — nothing was proved to have been spent`);
      for (const k of ['reviewer', 'territory', 'content_evidence', 'identity']) {
        assert.deepEqual(after[k], entry[k], `[${arm}] ${k} survives the release unchanged`);
      }
      assert.equal(r.json.reconciled.length, 1, `[${arm}] and the release is REPORTED, never silent — got ${JSON.stringify(r.json)}`);
      assertNoLedgerResidue(dir, `R1-C102/${arm}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C103 — AMBIGUITY IS A REFUSAL, NOT A CHOICE.
// ===========================================================================

// SABOTAGE: finalize against matches[0] (or the newest match) -> the code
// assertion goes red and the entry is bound to whichever commit the walk happened
// to reach first. Two commits both claiming one receipt is a state a human must
// look at: binding either one records an attestation nobody made.
// FIXTURE: BOTH commits carry the trailer AND hold the reservation's exact blob
// for the covered path, so neither can be excluded on the evidence.
test('R1-C103: TWO reachable commits naming the same reserved entry is [reconcile_ambiguous] — the entry stays reserved and the ledger is byte-identical', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { entry } = crashedSpend(dir);
    // A SECOND commit naming the same receipt; it touches an unrelated file, so
    // the covered path's tree blob is unchanged and both commits match.
    stageChange(dir, 'src/unrelated.mjs', OTHER);
    git(dir, ['commit', '-m', 'a second commit claiming the same receipt', '-m', `Reviewed-By-Agent: reviewer-security\nReview-Receipt: ${RESERVED_ID}`]);
    writeLedger(dir, [entry]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['reconcile']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'reconcile_ambiguous', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — nothing is bound on a guess');
    assert.equal(readLedger(dir)[0].status, 'reserved', 'and the entry stays reserved for a human to resolve');
    assert.match(runLedger(dir, ['reconcile']).stderr, token('reconcile_ambiguous'), 'and the human rendering carries the same code');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C104 — THE LOCK BINDS HERE TOO (A5).
// ===========================================================================

// SABOTAGE: skip the lock for reconcile because "it only tidies up" -> the
// existsSync/token assertions go red and two writers can finalize the same
// reservation concurrently, which is the exact race the two-phase spend exists to
// close.
// SABOTAGE (the force half): add a --force-lock escape hatch -> the second arm's
// code assertion goes red.
test('R1-C104: `reconcile` takes the ledger lock — a live foreign owner is [ledger_lock_held] with facts{lock_dir,owner}, and there is no --force-lock', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { entry } = crashedSpend(dir);
    writeLedger(dir, [entry]);
    const before = readLedgerRaw(dir);
    const owner = { pid: process.pid, host: hostname(), at: isoAgo(1_000), nonce: 'live-owner' };
    mkdirSync(lockDir(dir), { recursive: true });
    writeFileSync(ownerTokenPath(dir), JSON.stringify(owner));

    const held = runLedgerJson(dir, ['reconcile']);
    assert.notEqual(held.code, null, `the lock wait is BOUNDED (signal=${held.signal}) — stdout=${held.stdout} stderr=${flat(held.stderr)}`);
    assert.equal(held.code, 1, `a lock whose owner is alive on this host is a refusal — stdout=${held.stdout} stderr=${flat(held.stderr)}`);
    assert.equal(held.json.code, 'ledger_lock_held', `got ${JSON.stringify(held.json)}`);
    assert.equal(held.json.facts.owner.pid, owner.pid, `facts.owner names the holder — got ${JSON.stringify(held.json.facts)}`);
    assert.ok(String(held.json.facts.lock_dir).length > 0, `facts.lock_dir names the directory the operator must clear by hand — got ${JSON.stringify(held.json.facts)}`);
    assert.equal(readFileSync(ownerTokenPath(dir), 'utf8'), JSON.stringify(owner), 'the owner token is never rewritten by a waiter');
    assert.equal(readLedgerRaw(dir), before, 'and the ledger is byte-identical');

    const forced = runLedgerJson(dir, ['reconcile', '--force-lock']);
    assert.equal(forced.code, 1, `stdout=${forced.stdout} stderr=${flat(forced.stderr)}`);
    assert.equal(forced.json.code, 'argument_invalid', `there is no force flag anywhere in this mechanism — got ${JSON.stringify(forced.json)}`);
    assert.ok(existsSync(lockDir(dir)), 'and the lock survives the attempt');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C105 — SCOPE: RESERVED ENTRIES ONLY (A7).
// ===========================================================================

// SABOTAGE: widen reconcile to "re-bind any receipt whose commit it can find" ->
// the byte-identical assertion goes red. There is NO rebind/re-attest verb by
// design: after a rebase a Review-Receipt binding is broken, and the remedy is a
// fresh review round or a visible bytes waiver — never a verb that quietly
// re-points old evidence at new shas.
// THE FIXTURE IS DELIBERATELY TEMPTING: the CONSUMED entry names a sha that no
// longer exists on this history, and a commit reachable from HEAD carries its
// entry_id — exactly the shape a rebind would "fix".
test('R1-C105: `reconcile` touches RESERVED entries only — a consumed entry whose commit_sha is stale is left exactly as it is, because there is no rebind verb', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { sha, blob } = crashedSpend(dir, { entryId: BYSTANDER_ID });
    const staleConsumed = v2({
      entry_id: BYSTANDER_ID,
      files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': blob },
      base_sha: sha,
      status: 'consumed',
      consumption: { commit_sha: 'a'.repeat(40), consumed_at: isoAgo(10_000), nonce: 'old-nonce' },
    });
    const discharged = v2({
      entry_id: RESERVED_ID,
      files: ['src/base.mjs'],
      base_sha: sha,
      status: 'discharged',
      disposition: { class: 'foreign-session', reason: 'earned elsewhere', at: isoAgo(10_000), head_sha: sha, classifier_version: 2, facts: {} },
    });
    writeLedger(dir, [staleConsumed, discharged]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['reconcile']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(r.json.reconciled, [], `nothing is reserved, so nothing is reconciled — got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical — a stale consumption is not re-pointed at a commit that happens to name it');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C106 — TWO RESERVED ENTRIES, DIFFERENT FATES, ONE RUN.
// ===========================================================================

// SABOTAGE: stop at the first reserved entry -> the second entry's assertion goes
// red and half a crashed spend stays wedged. A crash leaves EVERY receipt the
// commit selected reserved, so the recovery has to be per-entry rather than
// per-run.
// SABOTAGE (the cross-contamination half): apply one entry's verdict to all of
// them -> whichever arm disagrees goes red; the fixture is built so the two
// outcomes are opposite (one finalizes, one releases).
test('R1-C106: one run reconciles EVERY reserved entry on its own evidence — the entry its commit names is finalized, the entry nothing names is released', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const { sha, blob, reservation } = crashedSpend(dir);
    const finalizable = v2({ entry_id: RESERVED_ID, files: ['src/laneA.mjs'], blobs: { 'src/laneA.mjs': blob }, base_sha: sha, status: 'reserved', reservation });
    const orphan = v2({
      entry_id: BYSTANDER_ID,
      agent_type: 'reviewer-correctness',
      files: ['src/laneA.mjs'],
      blobs: { 'src/laneA.mjs': blob },
      base_sha: sha,
      status: 'reserved',
      reservation: { nonce: 'op-orphan', at: isoAgo(5_000), index_blobs: { 'src/laneA.mjs': blob }, operation: 'commit-reviewed' },
    });
    writeLedger(dir, [finalizable, orphan]);

    const r = runLedgerJson(dir, ['reconcile']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const after = readLedger(dir);
    assert.equal(after.find((e) => e.entry_id === RESERVED_ID).status, 'consumed', 'the entry the commit NAMES is finalized');
    assert.equal(after.find((e) => e.entry_id === BYSTANDER_ID).status, 'active', 'the entry NO commit names is released — no trailer names it, so nothing binds it');
    assert.equal(after.find((e) => e.entry_id === BYSTANDER_ID).reservation, undefined, 'and its reservation is cleared');
    assert.equal(r.json.reconciled.length, 2, `both outcomes are reported — got ${JSON.stringify(r.json.reconciled)}`);
  } finally {
    cleanup();
  }
});
