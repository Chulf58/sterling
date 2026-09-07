// REVIEW-LEDGER `discharge` — HARDENING PINS (R1 PIN RE-CUT).
//
// AUTHORITY: decision review-receipt-rebuild-invariant-three-owner-modules-
// tri-state-liveness-receipt-bound-supersession + the R1 contract sheet
// (§1.2 lifecycle/lock, §1.4 codes, §3.1, §6 A5 the lock primitive, A9 codes).
//
// WHAT THIS FILE PINS beyond its sibling review-ledger-discharge.test.mjs: the
// classifier's git edges (post-hoc clean worktree, pathspec metacharacters,
// untracked-and-ignored paths), the LOCK contract (owner-mkdir mutex, pid-verified
// takeover only, no force flag), and the two entry shapes that must never be
// spent (a legacy v1 entry; a v2 entry whose lifecycle fields do not parse).
//
// CONVENTIONS: refusals are asserted by their `[code]` token or by `--json`'s
// `code` field; required facts are asserted as fields; a refused discharge
// leaves the ledger byte-identical with no partial file behind.
//
// RETIRED IN THIS RE-CUT (each with its reason):
//   RETIRED: P1a/P2a/P2b/P5-0/P6a's broad prose alternations (/post.?hoc|amend|.../i etc.) — converted to [class_not_applicable] / [no_live_territory_disproved] with facts.
//   RETIRED: P2-0 and P2b — folded into the sibling file's R1-C07/R1-C08, which now pin the contradicted AND unknown identity arms together; keeping both here would be one cause pinned twice.
//   RETIRED: P3-0 and P3a (a discharge landing mid-`git commit` survives the consume write-back) — the one-phase snapshot-and-write-back spend they describe is gone. The two-phase select→reserve→commit→verify→finalize spend closes that race by RESERVING, so the contract that replaces them is R1-C29: discharge REFUSES a reserved entry.
//   RETIRED: P4a's "a v1 receipt carrying a bare status:'discharged' STILL SPENDS" — inverted by the rebuild: a v1 entry is read through one adapter as a legacy disposition and is NEVER spendable, marker or no marker (R1-C27 pins the new direction).
//   RETIRED: P4b's "unauthenticated discharge" vocabulary and the dischargeMarkerClass authenticity notion behind it — a disposition either parses or the entry is malformed; R1-C28 pins that shape by its code.
//   RETIRED: P7's two-candidate lock-path search and its "the exit code is deliberately not asserted" hedge — the lock dir is fixed at .sterling/review-ledger.lock and a lock whose owner cannot be verified dead is a REFUSAL, so both halves are now pinned outright.

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
const COMMIT_CLI = join(root, 'scripts', 'commit-reviewed.mjs');

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-review-ledger-discharge-hardening-'));
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

// The ledger lock is a FIXED path (contract sheet §1.2), one owner-mkdir mutex
// shared with the register (A5). Nothing here searches for it.
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
function commitFile(dir, relPath, content) {
  stageChange(dir, relPath, content);
  git(dir, ['commit', '-m', `seed ${relPath}`]);
}
const stagedBlob = (dir, relPath) => git(dir, ['hash-object', relPath]);
const porcelain = (dir) => git(dir, ['status', '--porcelain']);

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
function runCommitReviewed(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [COMMIT_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function reviewedByTrailers(dir, sha = 'HEAD') {
  return git(dir, ['log', '-1', '--format=%(trailers:key=Reviewed-By-Agent,valueonly,unfold)', sha]).split('\n').filter((l) => l.trim() !== '');
}

// A ReceiptV2 per contract sheet §1.2.
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

const TARGET_ID = 'e0000000-0000-4000-8000-00000000000a';
const BYSTANDER_ID = 'e0000000-0000-4000-8000-00000000000b';
const CODE = 'export const f = 1;\n';
const OTHER = 'export const f = 2;\n';
const bystander = (base_sha) => v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-bystander', files: ['src/base.mjs'], base_sha });

// ===========================================================================
// R1-C20 / R1-C21 — A POST-HOC REVIEWER'S CLEAN WORKTREE IS NOT "REVERTED".
// A receipt whose base_sha IS the current HEAD over a clean tree makes every
// declared path trivially equal to its base state — so a per-path comparison
// concludes "no live territory" for the FRESHEST possible receipt. That receipt
// is not residue: it is a completed review of work already committed, spendable
// through the --target-sha amend path, and discharging it destroys spendable
// evidence by the easiest route available (review after committing, then
// discharge).
// ===========================================================================

// PLACED FIRST as R1-C21's control, and it must pass for the OPPOSITE reason.
// SABOTAGE: gate no-live on `base_sha === HEAD` (the inverse over-correction of
// R1-C21's fix) -> this control refuses -> red here, green there. That pair of
// results is the signature of an over-narrow fix and no single pin can see it.
test('R1-C20 (CONTROL, first): no-live-territory still SUCCEEDS when base_sha is a genuine ANCESTOR of HEAD and every declared path was returned to its base bytes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, 'src/laneA.mjs', CODE);
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    commitFile(dir, 'src/unrelated.mjs', OTHER);
    stageChange(dir, 'src/laneA.mjs', OTHER);
    stageChange(dir, 'src/laneA.mjs', CODE); // a genuine round trip
    assert.notEqual(baseSha, git(dir, ['rev-parse', 'HEAD']), 'fixture guard: HEAD has genuinely moved past base_sha');

    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], base_sha: baseSha }), bystander(baseSha)]);
    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', 'the reviewed change was reverted; nothing of it remains to commit']);
    assert.equal(r.code, 0, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'discharged', 'the entry is discharged');
    assertNoLedgerResidue(dir, 'R1-C20');
  } finally {
    cleanup();
  }
});

// SABOTAGE (the one line this pin exists for): delete the
// base_sha-is-HEAD-over-a-clean-tree check -> exit 0 -> red here, green in
// R1-C20.
// SECOND SABOTAGE: treat "nothing differs" as conclusive no-live in every mode
// -> the same red. WHICH GUARD CARRIES THE VERDICT: the code assertion together
// with status-still-'active'; a refusal that had already mutated the entry would
// satisfy the exit code while having destroyed the spendability this pin
// protects.
test('R1-C21: no-live-territory is [class_not_applicable] when base_sha resolves to the CURRENT HEAD over a clean worktree — a post-hoc review is fresh evidence, not residue, and stays spendable', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(porcelain(dir), '', 'fixture guard: the worktree is CLEAN — index and worktree both equal HEAD');

    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], base_sha: head }), bystander(head)]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', 'clean tree at the reviewed base — asserted as no-live']);
    assert.equal(r.code, 1, `a receipt whose base IS HEAD over a clean tree has not had its territory reverted — the review simply happened after the commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'class_not_applicable', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', 'and the receipt stays ACTIVE, so it is still spendable through a --target-sha amend');
    assertNoLedgerResidue(dir, 'R1-C21');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C22 — DECLARED PATHS ARE COMPARED LITERALLY, NEVER AS PATHSPECS.
// `src/foo[1].mjs` handed to git as a pathspec is a character class matching
// `src/foo1.mjs`: the literal file is never compared while a DIFFERENT,
// unreviewed file decides the verdict. Both directions are wrong.
// ===========================================================================

const BRACKET = 'src/foo[1].mjs';
const DECOY = 'src/foo1.mjs';

// PLACED FIRST as the family control: without it, the success arms below are
// satisfied by a classifier that SKIPS any path it cannot resolve — the most
// likely shape of the defect, and one that otherwise reads as a clean pass.
// SABOTAGE: skip declared paths git cannot match -> this control discharges live
// territory -> red, while the success arms stay green.
test('R1-C22 (CONTROL, first): a declared path named "src/foo[1].mjs" that is MODIFIED refuses no-live with facts.live_paths naming it — the bracket name is really compared, not skipped', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    commitFile(dir, BRACKET, CODE);
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances — R1-C21's guard satisfied
    stageChange(dir, BRACKET, OTHER); // genuinely live
    assert.ok(porcelain(dir).includes('foo[1]'), `fixture guard: git really reports the bracket file as changed — porcelain=${flat(porcelain(dir))}`);

    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: [BRACKET], base_sha: baseSha })]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', 'a bracket-named path that is still live must not classify as no-live']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'no_live_territory_disproved', `got ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.json.facts.live_paths, [BRACKET], `facts.live_paths carries the path verbatim, brackets and all — got ${JSON.stringify(r.json.facts)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// SABOTAGE: hand the declared path to git without `--`/`:(literal)` -> both arms
// go red for one root cause from opposite directions: with no decoy the pathspec
// matches nothing and the verdict is unknown; with a live decoy the glob resolves
// to the MODIFIED src/foo1.mjs and the verdict is "live".
// SECOND SABOTAGE: require a globally clean worktree instead of comparing the
// DECLARED paths -> the 'decoy-live' arm alone goes red (its undeclared decoy is
// dirty), which is that over-reach's diagnosable signature rather than a
// pathspec bug's.
test('R1-C22b: a declared path named "src/foo[1].mjs" at its base state SUCCEEDS as no-live — with and without a src/foo1.mjs decoy that a glob would match instead', { skip: GIT_SKIP }, () => {
  for (const arm of ['no-decoy', 'decoy-live']) {
    const { dir, cleanup } = makeRepo();
    try {
      commitFile(dir, BRACKET, CODE);
      if (arm === 'decoy-live') commitFile(dir, DECOY, CODE);
      const baseSha = git(dir, ['rev-parse', 'HEAD']);
      commitFile(dir, 'src/unrelated.mjs', OTHER);
      if (arm === 'decoy-live') {
        stageChange(dir, DECOY, OTHER); // the glob's target is LIVE; it is NOT declared territory
        assert.ok(porcelain(dir).includes('foo1.mjs'), `fixture guard: the decoy is genuinely live — porcelain=${flat(porcelain(dir))}`);
      } else {
        assert.equal(porcelain(dir), '', 'fixture guard: this arm has a completely clean tree');
        assert.ok(!existsSync(join(dir, DECOY)), 'fixture guard: no decoy exists, so a glob would match nothing at all');
      }
      assert.ok(!porcelain(dir).includes('foo[1]'), `fixture guard: git reports the declared path as unchanged — porcelain=${flat(porcelain(dir))}`);

      writeLedger(dir, [v2({ entry_id: TARGET_ID, files: [BRACKET], base_sha: baseSha })]);
      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', `${arm}: the declared bracket-named path is back at base`]);
      assert.equal(r.code, 0, `[${arm}] a filename containing pathspec metacharacters is a filename, not a glob — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      const entry = readLedger(dir).find((e) => e.entry_id === TARGET_ID);
      assert.equal(entry.status, 'discharged', `[${arm}] the entry is discharged`);
      assert.deepEqual(entry.territory.files, [BRACKET], `[${arm}] with the declared path preserved verbatim`);
      assertNoLedgerResidue(dir, `R1-C22b/${arm}`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C23 — A PRESENT FILE IS LIVE TERRITORY, IGNORED OR NOT.
// An IGNORED untracked file is invisible to `git status --porcelain` and to
// `git diff`, so a classifier built on either concludes "absent, same as base"
// while the reviewed content sits on disk one `git add -f` from being committed.
// ===========================================================================

const IGNORED_PATH = 'src/generated.mjs';
const LOOSE_PATH = 'src/loose.mjs';

function makeIgnoreRepo() {
  const { dir, cleanup } = makeRepo();
  commitFile(dir, 'src/tracked.mjs', CODE);
  writeFileSync(join(dir, '.gitignore'), `.sterling/\n${IGNORED_PATH}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'ignore the generated path']);
  const baseSha = git(dir, ['rev-parse', 'HEAD']);
  commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances — R1-C21's guard satisfied
  return { dir, cleanup, baseSha };
}

// PLACED FIRST and passing for the OPPOSITE reason: the ignored file exists here
// too, but it is not DECLARED territory.
// SABOTAGE: refuse whenever any ignored file exists in the tree -> red here,
// green in R1-C23 — the over-reach this control forbids.
test('R1-C23-0 (CONTROL, first): an ignored file that exists but is NOT declared territory does not block a no-live discharge of a tracked at-base path', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, baseSha } = makeIgnoreRepo();
  try {
    writeFileSync(join(dir, IGNORED_PATH), CODE); // present on disk, ignored, UNDECLARED
    assert.equal(porcelain(dir), '', 'fixture guard: the ignored file is invisible to porcelain, so the tree reads clean');

    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/tracked.mjs'], base_sha: baseSha })]);
    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', 'the declared tracked path is at its base state']);
    assert.equal(r.code, 0, `only DECLARED paths are classified — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedger(dir)[0].status, 'discharged', 'the entry is discharged');
  } finally {
    cleanup();
  }
});

// SABOTAGE: drop the ignored-file probe (an existsSync / `git ls-files --others
// --ignored` check) -> the 'ignored' arm discharges -> red, while
// 'plain-untracked' stays green. EXACTLY ONE ARM RED is the signature of an
// ignore-blind classifier; BOTH red means untracked paths are not checked at
// all, which is a different defect and a different fix.
test('R1-C23: a declared path that EXISTS as an untracked file is [no_live_territory_disproved] — including when .gitignore hides it from git status', { skip: GIT_SKIP }, () => {
  for (const arm of ['plain-untracked', 'ignored']) {
    const { dir, cleanup, baseSha } = makeIgnoreRepo();
    try {
      const declared = arm === 'ignored' ? IGNORED_PATH : LOOSE_PATH;
      writeFileSync(join(dir, declared), CODE); // the reviewed content, present on disk, never committed
      if (arm === 'ignored') {
        assert.equal(porcelain(dir), '', 'fixture guard: the ignored arm reads CLEAN through porcelain — that is the whole defect');
      } else {
        assert.ok(porcelain(dir).includes('loose.mjs'), `fixture guard: the plain-untracked arm is visible to porcelain — porcelain=${flat(porcelain(dir))}`);
      }
      assert.throws(() => git(dir, ['rev-parse', `${baseSha}:${declared}`]), `fixture guard: [${arm}] the declared path is genuinely ABSENT from the base tree`);

      writeLedger(dir, [v2({ entry_id: TARGET_ID, files: [declared], base_sha: baseSha })]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', `${arm}: asserted no-live while the reviewed file sits on disk`]);
      assert.equal(r.code, 1, `[${arm}] .gitignore hides a file from git; it does not make the reviewed work gone — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'no_live_territory_disproved', `[${arm}] got ${JSON.stringify(r.json)}`);
      assert.deepEqual(r.json.facts.live_paths, [declared], `[${arm}] facts.live_paths names the path that still exists — got ${JSON.stringify(r.json.facts)}`);
      assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
      assert.equal(readLedger(dir)[0].status, 'active', `[${arm}] and the receipt stays spendable`);
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// R1-C24 / R1-C25 — THE LEDGER LOCK (A5).
// ONE owner-mkdir primitive, no age takeover, no force flag: a lock is taken
// over ONLY when its owner.host is this host AND its owner.pid is verified not
// running immediately before publication. Everything else is a refusal naming
// the lock dir and the owner, because a lock is COORDINATION, not evidence.
// ===========================================================================

// A pid that is guaranteed dead ON THIS HOST: run a throwaway child to
// completion and reuse its pid, then verify with signal 0 rather than assuming.
function deadPidOnThisHost() {
  const r = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, 'fixture guard: the throwaway child ran and exited');
  const pid = r.pid;
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `fixture guard: pid ${pid} is genuinely not running on this host`);
  return pid;
}

function plantLock(dir, owner) {
  mkdirSync(lockDir(dir), { recursive: true });
  writeFileSync(ownerTokenPath(dir), JSON.stringify(owner));
}

// PLACED FIRST as the family control, and it must pass for the OPPOSITE reason:
// a lock whose owner is PROVABLY dead on THIS host is taken over and the
// discharge completes. Without it, R1-C25's refusals are satisfied by a CLI that
// refuses whenever a lock directory exists at all — which would wedge the verb
// permanently after any crash.
// SABOTAGE: remove the pid-verification takeover -> this control refuses -> red
// here, green in R1-C25.
test('R1-C24 (CONTROL, first): a lock whose owner pid is verified DEAD on THIS host is taken over — the discharge completes and the lock directory is released', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' })]);
    plantLock(dir, { pid: deadPidOnThisHost(), host: hostname(), at: isoAgo(60_000), nonce: 'dead-owner' });

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'the previous holder is gone']);
    assert.equal(r.code, 0, `a verified-dead same-host owner is the ONE takeover case — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(readLedger(dir)[0].status, 'discharged', 'and the discharge really happened');
    assert.equal(existsSync(lockDir(dir)), false, 'the lock is released when the run finishes — a mutex left behind wedges the next writer');
  } finally {
    cleanup();
  }
});

// SABOTAGE (the theft half): rmSync the lock directory before acquiring it, or
// treat any existing lock as stale by AGE -> both arms discharge and the
// existsSync/token-bytes assertions go red. Breaking a live lock reopens exactly
// the concurrent-write race the digest and the locked replace exist to close.
// SABOTAGE (the facts half): refuse without facts.lock_dir / facts.owner -> only
// those assertions go red, and the operator — who must remove the directory by
// hand after confirming no writer runs — is told to do so without being told
// where or whose it is.
// TWO ARMS, two DIFFERENT reasons a takeover is forbidden: the owner is ALIVE
// here, or the owner is on ANOTHER HOST where this process cannot check at all.
test('R1-C25: a lock owned by a LIVE process, or by ANY process on another host, is [ledger_lock_held] with facts{lock_dir,owner} — the directory and its owner token survive byte-identical', { skip: GIT_SKIP }, () => {
  const arms = [
    { label: 'alive-same-host', owner: { pid: process.pid, host: hostname(), at: isoAgo(1_000), nonce: 'live-owner' } },
    { label: 'dead-other-host', owner: { pid: deadPidOnThisHost(), host: 'another-machine', at: isoAgo(1_000), nonce: 'foreign-owner' } },
  ];
  for (const arm of arms) {
    const { dir, cleanup } = makeRepo();
    try {
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' })]);
      const before = readLedgerRaw(dir);
      const ownerBytes = JSON.stringify(arm.owner);
      plantLock(dir, arm.owner);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', `${arm.label}: contending with a lock this process may not take`]);
      assert.notEqual(r.code, null, `[${arm.label}] the lock wait is BOUNDED — the process never exited (signal=${r.signal}) — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.code, 1, `[${arm.label}] a lock whose owner cannot be verified dead on this host is a REFUSAL — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'ledger_lock_held', `[${arm.label}] got ${JSON.stringify(r.json)}`);
      assert.equal(r.json.facts.lock_dir.split('\\').join('/').endsWith('.sterling/review-ledger.lock'), true, `[${arm.label}] facts.lock_dir names the directory the operator must clear — got ${JSON.stringify(r.json.facts)}`);
      assert.equal(r.json.facts.owner.pid, arm.owner.pid, `[${arm.label}] facts.owner.pid names the holder — got ${JSON.stringify(r.json.facts.owner)}`);
      assert.equal(r.json.facts.owner.host, arm.owner.host, `[${arm.label}] facts.owner.host names where it runs`);

      assert.ok(existsSync(lockDir(dir)), `[${arm.label}] the lock directory is never removed by a waiter`);
      assert.equal(readFileSync(ownerTokenPath(dir), 'utf8'), ownerBytes, `[${arm.label}] and the owner token is never rewritten — a waiter does not restate another holder's claim`);
      assert.equal(readLedgerRaw(dir), before, `[${arm.label}] the ledger is byte-identical`);
    } finally {
      cleanup();
    }
  }
});

// SABOTAGE: add a --force-lock (or a break-lock verb) as an escape hatch -> the
// code assertion goes red. A5 is explicit that there is no force flag anywhere:
// the operator removes the directory by hand after confirming no writer runs,
// and an escape hatch on a coordination primitive is how a concurrent write
// becomes routine.
test('R1-C26: there is NO --force-lock and NO break-lock escape hatch — the flag is [argument_invalid] and the planted lock survives untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeLedger(dir, [v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended' })]);
    const owner = { pid: process.pid, host: hostname(), at: isoAgo(1_000), nonce: 'live-owner' };
    plantLock(dir, owner);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'force is not a thing', '--force-lock']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'argument_invalid', `an unknown flag is a usage error, never an accepted override — got ${JSON.stringify(r.json)}`);
    assert.match(String(r.json.facts.flag), /force/, `facts.flag names the rejected flag — got ${JSON.stringify(r.json.facts)}`);
    assert.ok(existsSync(lockDir(dir)), 'the lock is untouched');
    assert.equal(readFileSync(ownerTokenPath(dir), 'utf8'), JSON.stringify(owner), "and so is its owner token");
    assert.equal(readLedgerRaw(dir), before, 'and the ledger is byte-identical');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C27 / R1-C28 — TWO SHAPES THAT MUST NEVER BE SPENT.
// ===========================================================================

// THE INVERSION, stated plainly: a v1 entry used to spend. It no longer does.
// A legacy entry is read through ONE adapter as a 'legacy' disposition, is never
// rewritten by reading and is never spendable; its only exit is
// `discharge --legacy-handle`.
// SABOTAGE: let the spend path fall back to the legacy shape "for compatibility"
// -> the commit succeeds, a trailer appears, and the code/HEAD/trailer
// assertions go red.
// SABOTAGE (the disclosure half): exclude legacy entries silently -> only the
// [legacy_entries_present] assertion goes red, and a stuck consumer is left with
// a receipt that stopped counting and no line anywhere saying so.
// TWO ARMS because the bare `status` field is the exact key an agent-writable
// ledger can add: it must change NOTHING either way, so neither arm can be
// explained by the marker.
test('R1-C27: a LEGACY v1 entry is never spendable — with or without a bare status marker the commit refuses, no trailer is minted, the entry survives, and [legacy_entries_present] is disclosed', { skip: GIT_SKIP }, () => {
  for (const marker of [false, true]) {
    const { dir, cleanup } = makeRepo();
    try {
      stageChange(dir, 'src/laneA.mjs', CODE);
      const head = git(dir, ['rev-parse', 'HEAD']);
      const at = isoAgo(60_000);
      const legacy = {
        agent_type: 'reviewer-security',
        files: ['src/laneA.mjs'],
        at,
        session_id: SESSION,
        branch: 'main',
        base_sha: head,
        reviewed_state: { blobs: { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') }, completed_at: at },
        ...(marker ? { status: 'discharged' } : {}),
      };
      assert.ok(!('schema_version' in legacy), 'fixture guard: this is a v1 entry — no schema_version at all');
      writeLedger(dir, [legacy]);
      const before = readLedgerRaw(dir);

      const r = runCommitReviewed(dir, ['-m', `R1-C27 legacy marker=${marker}`]);
      assert.equal(r.code, 1, `[marker=${marker}] a legacy entry cannot carry a commit — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'HEAD']), head, `[marker=${marker}] no commit was created`);
      assert.match(r.stderr, token('legacy_entries_present'), `[marker=${marker}] the legacy entries are DISCLOSED, so the operator learns why nothing was spendable — stderr=${flat(r.stderr)}`);
      assert.equal(readLedgerRaw(dir), before, `[marker=${marker}] and the ledger is byte-identical — a legacy entry is never rewritten by being read`);
    } finally {
      cleanup();
    }
  }
});

// PLACED FIRST as R1-C28's control and passing for the OPPOSITE reason: a
// WELL-FORMED discharged entry is excluded from spending WITHOUT being reported
// as malformed.
// SABOTAGE: report every discharged entry as malformed -> the doesNotMatch
// assertion goes red here while R1-C28 stays green. That pair separates
// "detected the malformation" from "narrates everything".
test('R1-C28-0 (CONTROL, first): a WELL-FORMED discharged v2 receipt is excluded from spending, survives intact, and is NOT reported as malformed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    const discharged = v2({
      entry_id: TARGET_ID,
      files: ['src/laneA.mjs'],
      blobs,
      base_sha: head,
      status: 'discharged',
      disposition: { class: 'foreign-session', reason: 'the session that produced it ended', at: isoAgo(30_000), head_sha: head, classifier_version: 2, facts: {} },
    });
    writeLedger(dir, [discharged, v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs, base_sha: head })]);

    const r = runCommitReviewed(dir, ['-m', 'R1-C28-0 control: well-formed discharge']);
    assert.equal(r.code, 0, `an active receipt covers the diff, so the commit lands — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'only the active receipt stamps');
    assert.deepEqual(readLedger(dir).find((e) => e.entry_id === TARGET_ID), discharged, 'the discharged receipt survives byte-identical');
    assert.doesNotMatch(r.stderr, token('ledger_entry_malformed'), `a properly discharged receipt is not reported as malformed — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE (the not-spending half): treat an unparseable lifecycle as ACTIVE ->
// two trailers appear and the trailer deepEqual goes red. A v2 entry whose
// `status` says discharged while no disposition parses was not produced by the
// verb; the fail-closed direction is not to spend it.
// SABOTAGE (the disclosure half): drop the entry silently -> only the
// [ledger_entry_malformed] assertion goes red. A receipt that stops counting
// with no line anywhere saying so is how review evidence disappears unnoticed.
// SABOTAGE (the preservation half): drop malformed entries from the write-back
// -> the survival deepEqual goes red; an entry nobody can parse is still
// somebody's evidence.
test('R1-C28: a v2 entry whose lifecycle does not parse (status "discharged", no disposition) is [ledger_entry_malformed] — disclosed, never spent, never rewritten', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    stageChange(dir, 'src/laneA.mjs', CODE);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const blobs = { 'src/laneA.mjs': stagedBlob(dir, 'src/laneA.mjs') };
    const malformed = v2({ entry_id: TARGET_ID, files: ['src/laneA.mjs'], blobs, base_sha: head, status: 'discharged', disposition: null });
    writeLedger(dir, [malformed, v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/laneA.mjs'], blobs, base_sha: head })]);

    const r = runCommitReviewed(dir, ['-m', 'R1-C28 unparseable lifecycle']);
    assert.equal(r.code, 0, `the active receipt covers the diff, so the commit lands — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.deepEqual(reviewedByTrailers(dir), ['reviewer-correctness'], 'the malformed entry never earns a trailer');
    assert.deepEqual(readLedger(dir).find((e) => e.entry_id === TARGET_ID), malformed, 'and is preserved, neither consumed nor rewritten');
    assert.match(r.stderr, token('ledger_entry_malformed'), `the skip is DISCLOSED by its code — stderr=${flat(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C29 — THE RESERVATION IS WHAT CLOSES THE MID-COMMIT RACE.
// This is the pin that replaces the retired write-back-ordering family.
// ===========================================================================

// SABOTAGE: let discharge treat any non-'discharged' status as dischargeable ->
// the reserved entry is retired while a commit is mid-flight on it, and the
// code/status/reservation assertions go red. The reservation is the only record
// of an in-flight spend; retiring it strands the reconcile verb with nothing to
// finalize.
// WHICH GUARD CARRIES THE VERDICT: the surviving `reservation` object, not the
// exit code — a refusal that had already cleared the reservation would satisfy
// the code assertion while destroying the recovery path.
test('R1-C29: an entry RESERVED by an in-flight commit cannot be discharged — [entry_not_active], and its reservation survives intact for `reconcile`', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    const reservation = { nonce: 'op-42', at: isoAgo(2_000), index_blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') }, operation: 'commit-reviewed' };
    const reserved = { ...v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], base_sha: head, session_id: 'a-session-that-ended', status: 'reserved' }), reservation };
    writeLedger(dir, [reserved]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'a discharge landing while a commit is in flight']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'entry_not_active', `got ${JSON.stringify(r.json)}`);
    assert.equal(r.json.facts.status, 'reserved', `facts.status names the blocking state, whose remedy is the reconcile verb — got ${JSON.stringify(r.json.facts)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.deepEqual(readLedger(dir)[0].reservation, reservation, 'and the reservation survives intact');
    assertNoLedgerResidue(dir, 'R1-C29');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C29b — THE LEDGER IS AGENT-WRITABLE, SO ITS STRINGS ARE UNTRUSTED INPUT.
//
// Two fields of a ledger entry are handed to other machinery: identity.base_sha
// reaches git, and territory.files reach the filesystem. Both arrive from a file
// any agent in the session can write, so both are attacker-shaped input:
//   * an OPTION-SHAPED base_sha ("--help", "--upload-pack=…") passed as a
//     positional turns a comparison into a different git command;
//   * a TRAVERSAL-SHAPED base_sha or territory path ("../../x") reaches outside
//     the repository the receipt claims to be about.
// The ruling: neither is ever handed on as-is, and neither may produce a
// SPURIOUS SUCCESS — the discharge refuses (fail closed) and writes nothing.
// A CONSEQUENCE WORTH STATING PLAINLY, because it is a real constraint on the
// rebuild: identity.base_sha is validated as sha40-or-null, so an option-shaped
// value makes the entry malformed rather than merely unusable. Either refusal
// code below is accepted; a success is not.
// ===========================================================================

const REFUSAL_CODES = ['class_not_applicable', 'ledger_entry_malformed', 'no_live_territory_disproved', 'superseder_not_found', 'superseder_coverage_incomplete'];

// SABOTAGE (the one this pin exists for): interpolate identity.base_sha into a
// git invocation without a `--` separator and without validating its shape ->
// "--help" is consumed as an OPTION. git then exits 0 printing usage, a
// comparison that never ran reads as "nothing differs", and the no-live arm
// DISCHARGES: the exit-code assertion goes red on a spurious success, which is
// the worst possible failure of this verb.
// SABOTAGE (the traversal half): resolve base_sha or a declared path against the
// repo root with plain join() and no containment check -> "../../x" escapes the
// repository the receipt is about.
// SABOTAGE (the fail-open half): treat an unusable base_sha as "no base to
// compare, so nothing is live" -> both no-live arms discharge and go red. UNABLE
// TO COMPARE IS NOT COMPARED-AND-EQUAL.
// TWO CLASSES because they consume the value differently: no-live-territory reads
// base_sha to build the comparison, and superseded reads it as part of the
// entry's identity — a guard placed in one verifier does not cover the other.
test('R1-C29b: an OPTION-SHAPED or TRAVERSAL-SHAPED identity.base_sha is never handed to git as a positional — no-live-territory and superseded both REFUSE and write nothing, never a spurious success', { skip: GIT_SKIP }, () => {
  for (const base_sha of ['--help', '--upload-pack=touch /tmp/pwned', '../../x']) {
    for (const cls of ['no-live-territory', 'superseded']) {
      const { dir, cleanup } = makeRepo();
      try {
        const blobs = { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') };
        const target = v2({ entry_id: TARGET_ID, files: ['src/base.mjs'], blobs, base_sha, at: isoAgo(600_000) });
        // A perfectly good survivor is present, so the superseded arm cannot
        // refuse for want of one: the only thing wrong is the hostile base_sha.
        const survivor = {
          ...v2({ entry_id: BYSTANDER_ID, agent_type: 'reviewer-correctness', files: ['src/base.mjs'], blobs, at: isoAgo(60_000) }),
          observed_reads: ['src/base.mjs'],
          observed_source: 'subagent-transcript',
        };
        writeLedger(dir, [target, survivor]);
        const before = readLedgerRaw(dir);

        const args = ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', cls, '--reason', `hostile base_sha ${base_sha} under ${cls}`];
        if (cls === 'superseded') args.push('--superseded-by', BYSTANDER_ID);
        const r = runLedgerJson(dir, args);

        const label = `${cls}/${base_sha}`;
        assert.notEqual(r.code, null, `[${label}] the run TERMINATES — an option-shaped value must not put git into an interactive or waiting state (signal=${r.signal})`);
        assert.equal(r.code, 1, `[${label}] fail closed: a value that cannot be trusted as a sha is never treated as one — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.ok(REFUSAL_CODES.includes(r.json.code), `[${label}] the refusal carries one of the closed-set codes rather than a crash or a bare non-zero exit — got ${JSON.stringify(r.json)}`);
        assert.equal(readLedgerRaw(dir), before, `[${label}] the ledger is byte-identical`);
        assert.equal(readLedger(dir).find((e) => e.entry_id === TARGET_ID).status, 'active', `[${label}] and nothing was discharged`);
        assertNoLedgerResidue(dir, `R1-C29b/${label}`);
      } finally {
        cleanup();
      }
    }
  }
});

// THE DISCRIMINATING FIXTURE, and the reason this arm is separate: the file the
// traversal points at is written with the DECLARED PATH'S BASE BYTES, so an
// implementation that resolves the traversal and hashes what it finds concludes
// "unchanged since base" and DISCHARGES. A correct one never reads it at all and
// refuses, because a path outside the repository is not evidence about the
// repository. Without those bytes matching, a refusal would prove nothing — it
// would be indistinguishable from "the file was different".
// SABOTAGE: resolve declared paths with a plain join() and no containment check
// -> the discharge succeeds on the strength of a file outside the repo and the
// exit-code assertion goes red.
// SABOTAGE (the write half): let the classifier or the disposition write through
// a declared path -> the victim-bytes assertion goes red; nothing outside the
// repository is ever touched, read or written.
// SECOND ARM (the CONTROL, so the refusal is not "any two-path receipt refuses"):
// the same receipt with both paths INSIDE the repo and both at base state
// discharges — proving the refusal above is caused by the traversal and not by
// the shape of the fixture.
test('R1-C29b-traversal: a declared territory path escaping the repository is NO EVIDENCE — never read from disk, never written to, and no-live-territory refuses even when the outside file holds the base bytes', { skip: GIT_SKIP }, () => {
  for (const arm of ['traversal', 'inside']) {
    const { dir, cleanup } = makeRepo();
    // The victim sits OUTSIDE the repository, one level above it, and is removed
    // whatever happens.
    const victimName = `sterling-r1c29b-victim-${process.pid}-${arm}.mjs`;
    const victimPath = join(dir, '..', victimName);
    try {
      commitFile(dir, 'src/laneA.mjs', CODE);
      const baseSha = git(dir, ['rev-parse', 'HEAD']);
      commitFile(dir, 'src/unrelated.mjs', OTHER); // HEAD advances — R1-C21's guard satisfied

      // The outside file holds EXACTLY the base bytes of a tracked path, so a
      // traversal-resolving implementation would compute a matching blob.
      writeFileSync(victimPath, CODE);
      const victimBytes = readFileSync(victimPath, 'utf8');

      const declared = arm === 'traversal' ? `../${victimName}` : 'src/laneA.mjs';
      const files = arm === 'traversal' ? ['src/laneA.mjs', declared] : ['src/laneA.mjs'];
      writeLedger(dir, [v2({ entry_id: TARGET_ID, files, base_sha: baseSha })]);
      const before = readLedgerRaw(dir);

      const r = runLedgerJson(dir, ['discharge', '--entry-id', TARGET_ID, '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', `${arm}: a path outside the repository is not evidence about it`]);

      if (arm === 'inside') {
        assert.equal(r.code, 0, `[${arm}] CONTROL — the same shape with every declared path inside the repo and at base state discharges — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.equal(readLedger(dir)[0].status, 'discharged', `[${arm}] the entry is discharged`);
      } else {
        assert.equal(r.code, 1, `[${arm}] the classifier must not resolve a declared path outside the repository — the outside file holds the base bytes, so a resolving implementation would call this 'unchanged' and discharge — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
        assert.ok(REFUSAL_CODES.includes(r.json.code), `[${arm}] the refusal carries a closed-set code rather than a crash — got ${JSON.stringify(r.json)}`);
        assert.equal(readLedgerRaw(dir), before, `[${arm}] the ledger is byte-identical`);
        assert.equal(readLedger(dir)[0].status, 'active', `[${arm}] and nothing was discharged`);
      }
      assert.equal(readFileSync(victimPath, 'utf8'), victimBytes, `[${arm}] the file outside the repository is byte-identical — nothing outside the repo is ever written through a ledger-supplied path`);
    } finally {
      rmSync(victimPath, { force: true });
      cleanup();
    }
  }
});
