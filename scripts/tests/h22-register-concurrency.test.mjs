// H22 DISPATCH-REGISTER CONCURRENCY — spec-first pin for board 673ca3f6
// (H22 dispatch-register append race silently destroys review evidence).
//
// SPEC (from board 673ca3f6, verbatim evidence, not inferred from
// scripts/hooks/h22-dispatch-register.mjs, which this file never reads):
// ".sterling/transient/dispatch-register.json is a whole-array
// read-modify-write with NO lock — the h22-dispatch-register article itself
// documents that only the LEDGER write is lock-guarded ... but that rationale
// is wrong for reviewer-class entries: a lost REGISTER entry means the
// SubagentStop promotion finds no match (clean no-op by design) and the
// review receipt is never minted." Measured 2026-08-28: two reviewer
// SubagentStart events fired near-simultaneously and only ONE register entry
// survived; the lost entry's SubagentStop later found no match and its
// review-ledger receipt was never minted.
//
// Corroborating records (knowledge_get'd, not paraphrased from memory):
//   - decision review-receipt-ledger (12a26ca6): SubagentStop PROMOTES a
//     reviewer-class entry (agent_type strictly prefixed 'reviewer-') into
//     the durable ledger .sterling/review-ledger.json instead of just
//     deleting it; the ledger write itself IS lock-guarded — "unlike the
//     register a lost ledger update is PERMANENT". The register
//     read-modify-write was NOT lock-guarded.
//   - feature_article h22-dispatch-register (5eee48d3): confirms the above
//     mechanism and that an unmatched SubagentStop is "a clean no-op" by
//     design — the exact behavior that turns a lost register append into a
//     silently lost review receipt.
//   - decision register-writers-cooperating-lock (1e0ba0d0): SETTLES the fix
//     shape — an EXTRACTED shared lock helper
//     (scripts/hooks/lib/dispatch-register-lock.mjs) guards every register
//     writer (H22 Start append, H22 Stop remove/promote, H22's prune pass,
//     H10's residue_reported_at stamping rewrite, H1's SessionStart
//     deletion). Timeout posture DIFFERS from the ledger's: on register-lock
//     timeout the mutation is SKIPPED with one loud stderr line — never
//     written unlocked. A found reviewer-class entry is STILL promoted to
//     the ledger even when its register removal is skipped (bounded
//     over-deferral in H10 is acceptable; lost review evidence is not).
//   - Coordinator hardening message (mid-task, same session): create-
//     exclusive owner write ('wx' — an existing owner file means the
//     acquisition attempt LOST, retry); single-winner steal via
//     rename-to-unique-tomb then rm; release = re-read nonce, if own
//     rename-to-tomb + rm (ENOENT = no-op); the lib exports
//     registerLockDir() used by all four writers; the ledger append gains
//     agent_id idempotency (same agent_id already present → skip, with a
//     stderr note).
//
// CONTRACT PINNED HERE:
//   C1  — N concurrent SubagentStart, N distinct agent_ids: no lost append.
//   C2  — N concurrent SubagentStop for N distinct reviewer-class entries:
//         no lost ledger promotion.
//   C3  — control: today's sequential single-event behavior is unchanged.
//   D1a — deterministic, in-process: a held lock blocks a second acquirer
//         until release.
//   D1b — deterministic, in-process: OWNER NONCE — a stale-steal victim's
//         late release() must not remove the new holder's lock.
//   D1c — deterministic, in-process: owner-write EXCLUSIVITY — a live,
//         non-stale holder is never overwritten; only past staleMs does a
//         new acquirer steal it.
//   D1d — deterministic-ish, in-process: DUAL-STEALER SINGLE-WINNER — two
//         concurrent acquireLock calls contending over the same stale lock
//         never observe a nonce collision, and the lock ends up in a
//         cleanly re-acquirable state.
//   D2  — integration: on register-lock timeout, SubagentStart SKIPS its
//         mutation (byte-identical register), discloses exactly once, exits 0.
//   D3  — integration: on register-lock timeout, a reviewer-class
//         SubagentStop's receipt is STILL promoted to the ledger even though
//         its register removal is skipped.
//   LOCK-PATH — static pin: h1-session-start.mjs and h10-direct-capture.mjs
//         both import registerLockDir from the shared helper.
//   H1-TIMEOUT / H10-TIMEOUT — integration: while the register lock is held
//         externally, H1's SessionStart deletion and H10's residue-stamping
//         rewrite both skip their register mutation (byte-unchanged),
//         exit 0, and (H1) disclose the skip.
//   LEDGER-IDEMPOTENCY — two Stops for the SAME reviewer agent_id (simulating
//         a skipped-removal retry) produce exactly ONE ledger receipt.
//
// PROBABILISTIC PIN — READ BEFORE TRIAGING A FAILURE:
//   C1/C2 assert against a genuine CROSS-PROCESS OS-level race on an
//   unlocked read-modify-write. GREEN-WITH-THE-LOCK is deterministic (every
//   round passes every time). RED-WITHOUT is LIKELY-BUT-NOT-CERTAIN per
//   round — a given round can occasionally interleave cleanly and pass
//   despite the missing lock. That asymmetry is accepted for a frozen pin: a
//   flaky-red unlocked implementation still fails CI eventually (this file
//   runs the batch 3x to raise exposure), and once locked it is
//   always-green, never flaky-green. The D1x arms below run IN-PROCESS
//   (cooperative event-loop interleaving of concurrent acquireLock()
//   promises, not separate OS processes) and are the PRIMARY proof per
//   decision 1e0ba0d0 — "the probabilistic pin alone is insufficient because
//   a scheduler can serialize the unfixed code into an accidental pass."
//
// HARNESS LIMITATION (disclosed honestly): true microsecond-simultaneous
// filesystem access across OS processes is not cheaply reachable from this
// harness (C1/C2). We use `spawn` (not `spawnSync`) and launch all N child
// hook processes back-to-back before awaiting any, which starts all N OS
// process creations essentially concurrently — but process spawn/startup
// itself carries jitter, so the race window is real but not guaranteed to
// fire every round. The D1x arms sidestep this entirely by racing
// acquireLock() calls IN-PROCESS.
//
// D1c/D1d DISCLOSED SUBSTITUTION: the coordinator's literal ask was to
// "create the lock dir + owner yourself" (D1c) and "create a stale lock dir
// (backdated mtime)" (D1d) — i.e. manually forge the raw on-disk lock
// artifacts. Doing that would require assuming an UNDOCUMENTED internal
// owner-file name/content schema no settled record fixes (only the
// mechanism — 'wx' create, rename-to-tomb steal, nonce-checked release — is
// settled, not the file layout). Inventing that schema risks either testing
// NOTHING (a wrong filename the real code never touches) or freezing an
// implementation detail the decision does not fix — both violate "never
// invent an interface." Instead, D1c/D1d drive the SAME exclusivity,
// steal-timing, and single-winner properties entirely through the PUBLIC
// acquireLock()/release() surface: a real (never-released) acquire stands in
// for "an existing/stale owner," and a tiny `staleMs` on the contender makes
// real elapsed time (not a forged mtime) cross the staleness threshold. This
// exercises the real 'wx'-exclusivity and steal code paths without guessing
// their on-disk shape.
//
// ASSUMED INTERFACE (module does not exist yet — a specifying test, not a
// verified fact; the decision + coordinator message settle BEHAVIOR, not the
// exact JS calling convention):
//
//   export async function acquireLock(lockDir, opts = {}) -> Promise<Lock | null>
//     - opts.retryMs (~1000 default): bounded time to keep retrying while a
//       live, non-stale holder's owner file exists.
//     - opts.staleMs (~10000 default): once a held owner's age exceeds
//       staleMs, a new acquirer steals it (single-winner rename-to-tomb),
//       minting a NEW owner nonce.
//     - resolves null on normal contention timeout (retry budget exhausted,
//       held lock never went stale) — never throws for that case.
//     - Lock shape: { nonce, release() } — release() is a no-op unless it
//       still holds the CURRENT owner nonce.
//   export function registerLockDir(projectDir) -> string
//     - the SAME lock directory path every one of the four register writers
//       (H22 Start, H22 Stop, H10's residue stamp, H1's SessionStart delete)
//       must use, so external holds in this file genuinely contend with the
//       hook processes under test.
//
// SABOTAGE PER PIN is stated on each test below.
//
// ===========================================================================
// R1 PIN RE-CUT (contract sheet §1.1/§1.4, §6 A1/A4/A5/A6/A9).
// The lock helper moves: scripts/hooks/lib/dispatch-register-lock.mjs is
// DELETED and its behaviour is absorbed by scripts/lib/dispatch-register.mjs as
// ONE owner-mkdir primitive, withOwnerMkdirLock(lockDir, fn, {retryMs,
// timeoutMs}), with NO age-based takeover and NO force flag: a lock is taken
// over ONLY when owner.host is this host AND owner.pid is verified not running.
//   RETIRED: 'D1a: a held lock blocks a second acquirer until release'
//     — acquireLock/release is gone; the contract is now scope-bound. Re-cut as
//       R1-A95 (a held lock refuses with register_lock_held) + R1-A96 (mutual
//       exclusion), and the pid/host/age takeover rules are pinned at their owner
//       in scripts/tests/dispatch-register-owner.test.mjs (R1-A31..A38).
//   RETIRED: 'D1b: NONCE — a stale-steal victim's late release()...'
//     — there is no stale steal to be a victim of; a nonce-mismatch release is
//       unreachable once takeover requires a verified-dead owner.
//   RETIRED: 'D1c: owner-write exclusivity ... only after staleMs does a new
//            acquirer steal it' and 'D1d: dual-stealer single-winner'
//     — both pin the age-based steal that A5 removes. The exclusivity half they
//       carried survives as R1-A96 (mutual exclusion) here and R1-A32/A33 there.
//   RETIRED: 'LOCK-PATH: h1-session-start.mjs and h10-direct-capture.mjs both
//            import registerLockDir from the shared dispatch-register-lock.mjs helper'
//     — a source-text import-specifier pin is a placement assertion, not a
//       behaviour. Replaced BEHAVIOURALLY by H1-TIMEOUT / H10-TIMEOUT below,
//       which hold the OWNER module's lock dir and observe both hooks skip: a
//       hook importing a respelled or duplicated lock would not contend with it
//       and would fail those pins.
//   RETIRED: 'C3 (control): ... register left empty' (the removal half only)
//     — A1: Stop marks `ended`. Re-cut in place.
//   RETIRED: 'LEDGER-IDEMPOTENCY: two Stops for the same reviewer agent_id ...
//            yield exactly ONE ledger receipt' AS WRITTEN
//     — it re-seeded an UNENDED entry between the two Stops, which under A4 is a
//       new round and SHOULD mint a second receipt. The idempotency that
//       survives is structural: a second Stop against an already-ENDED entry
//       finds no unended round, so it promotes nothing. Re-cut as R1-A97/A98.
//   CONVERTED: the register-lock skip disclosure is asserted by
//     token('register_lock_held') instead of a word-soup regex.
//   RE-CUT: D3 — a held lock promotes nothing (double-promotion route), 2026-09-07
// The mtime-refresh machinery is gone with the age takeover: this process is
// alive on this host, so a lock it holds is never stealable at any age, which
// removes the CI knife-edge the old harness worked around.
// ===========================================================================

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const HOOK_SCRIPT = 'h22-dispatch-register.mjs';

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
};

function makeProject(prefix = 'sterling-h22-conc-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  return dir;
}

function h22Input(dir, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(dir, 't', 'parent.jsonl'),
    cwd: dir,
    prompt_id: 'pr-1',
    agent_id: 'agent-1',
    agent_type: 'coder',
    hook_event_name: 'SubagentStart',
    ...over,
  };
}

function writeParentTranscript(dir, blocks, name = 'parent.jsonl') {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  const line = { type: 'assistant', message: { content: blocks } };
  writeFileSync(p, JSON.stringify(line) + '\n');
  return p;
}
const taskBlock = (name, prompt) => ({ type: 'tool_use', name, input: { prompt } });

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}
function readRegister(dir) {
  if (!existsSync(registerPath(dir))) return [];
  return JSON.parse(readFileSync(registerPath(dir), 'utf8'));
}
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), JSON.stringify(content));
}

function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function readLedger(dir) {
  if (!existsSync(ledgerPath(dir))) return [];
  return JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
}

// Sequential (blocking) runner.
function runHookSync(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Concurrent (non-blocking) runner — spawn, not spawnSync, so N invocations
// can be in flight against the same register/lock at once. See HARNESS
// LIMITATION note above for what "concurrent" honestly means here.
function runHookAsync(script, input, cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HOOKS, script)], {
      cwd,
      env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: String(err) }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const ROUNDS = 3;
const N = 8;

// ===========================================================================
// D-ARMS SETUP
// ===========================================================================

let lockLib = null;
let lockLibError = null;
before(async () => {
  try {
    lockLib = await import(pathToFileURL(join(root, 'scripts', 'lib', 'dispatch-register.mjs')).href);
  } catch (err) {
    lockLibError = err;
  }
});

function missingLockLibMessage() {
  return (
    'scripts/lib/dispatch-register.mjs is missing or failed to import' +
    (lockLibError ? ` (${lockLibError.message})` : '') +
    ' — expected exports registerLockDir(projectDir) => string and ' +
    'withOwnerMkdirLock(lockDir, fn, {retryMs?, timeoutMs?}), the ONE owner-mkdir ' +
    'primitive shared by the register and the ledger (contract sheet §1.1, §6 A5): ' +
    'mkdir + owner.json {pid, host, at, nonce}, takeover ONLY when owner.host is ' +
    'this host AND owner.pid is verified not running, no age takeover, no force flag.'
  );
}

// A GENUINE hold, forged directly in the declared on-disk shape: this process is
// alive on this host, so under A5 the lock is never takeable at any age. That is
// what lets the integration arms below hold it across a child's whole lifetime
// without a mtime-refresh race.
function holdRegisterLock(dir) {
  const lockDir = lockLib.registerLockDir(dir);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce: 'test-holder' })
  );
  return () => rmSync(lockDir, { recursive: true, force: true });
}

// Accepts a refusal delivered as a throw OR as a {ok:false, code} return — the
// sheet settles the CODE and the behaviour, not the calling convention.
async function refusalOf(fn) {
  try {
    const value = await fn();
    return { code: value?.code, facts: value?.facts, value };
  } catch (err) {
    return { code: err?.code, facts: err?.facts, err };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Races `promise` against a `ms` timer WITHOUT rejecting/losing either side —
// used to prove a promise has NOT yet resolved at a given point in time.
function raceTimeout(promise, ms) {
  return Promise.race([
    promise.then((value) => ({ resolved: true, value })),
    sleep(ms).then(() => ({ resolved: false })),
  ]);
}

// CONVERTED (§4): the register-lock skip disclosure is identified by its CODE,
// never by wording. Strict on COUNT — a correct implementation discloses the
// skip once, not once per retry attempt.
const CODE_LOCK_HELD = /\[register_lock_held\]/;
function registerSkipLines(text) {
  return text.split('\n').filter((l) => CODE_LOCK_HELD.test(l));
}

// ===========================================================================
// C1 — concurrent SubagentStart, N distinct agent_ids, no lost append.
// EXPECTED TODAY: FLAKY-RED. The register write is an unlocked whole-array
// read-modify-write; two concurrent Starts can both read the same
// pre-append snapshot and each write back an array containing only their
// own entry, silently dropping the other. Any round where reg.length !== N
// or the surviving agent_id set is missing a member fails the assertion.
// SABOTAGE: remove/bypass the future lock on the SubagentStart path only.
// ===========================================================================

test('C1: N concurrent SubagentStart events for N distinct agent_ids — no lost append (probabilistic, 3 rounds)', async () => {
  for (let round = 0; round < ROUNDS; round++) {
    const dir = makeProject();
    try {
      const tPath = writeParentTranscript(dir, [taskBlock('Task', `round ${round} shared dispatch message touching src/shared.mjs`)]);
      const ids = Array.from({ length: N }, (_, i) => `agent-c1-r${round}-${i}`);

      const promises = ids.map((id) =>
        runHookAsync(HOOK_SCRIPT, h22Input(dir, { agent_id: id, agent_type: 'coder', transcript_path: tPath }), dir)
      );
      const results = await Promise.all(promises);

      for (const r of results) {
        assert.equal(r.code, 0, `round ${round}: the hook must never exit non-zero under concurrent Starts, even under a lost-append race — stderr: ${r.stderr}`);
      }

      const reg = readRegister(dir);
      const survivingIds = new Set(reg.map((e) => e.agent_id));
      assert.equal(
        reg.length,
        N,
        `round ${round}: expected all ${N} concurrent Starts to survive, found ${reg.length} — a lost append under the unlocked register read-modify-write (board 673ca3f6)`
      );
      assert.deepEqual(
        [...survivingIds].sort(),
        [...ids].sort(),
        `round ${round}: surviving agent_id set does not match the full dispatched set — some Start's append was silently overwritten by a concurrent sibling`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ===========================================================================
// C2 — concurrent SubagentStop for N distinct reviewer-class entries, no
// lost promotion into review-ledger.json.
// EXPECTED TODAY: FLAKY-RED.
// SABOTAGE: remove/bypass the future lock on the SubagentStop path only
// (the ledger write's OWN lock is different and must stay intact for this
// sabotage to isolate the register-side race).
// ===========================================================================

test('C2: concurrent SubagentStop for N distinct reviewer-class entries — no lost ledger promotion (probabilistic, 3 rounds)', async () => {
  for (let round = 0; round < ROUNDS; round++) {
    const dir = makeProject();
    try {
      const entries = Array.from({ length: N }, (_, i) => ({
        agent_id: `rev-r${round}-${i}`,
        agent_type: `reviewer-r${round}-${i}`, // strictly prefixed 'reviewer-' => reviewer-class
        session_id: 's1',
        files: [`src/r${round}-${i}.mjs`],
        at: new Date(Date.UTC(2026, 7, 28, 0, round, i)).toISOString(),
      }));
      writeRegisterRaw(dir, entries);

      const promises = entries.map((e) =>
        runHookAsync(HOOK_SCRIPT, h22Input(dir, { agent_id: e.agent_id, agent_type: e.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }), dir)
      );
      const results = await Promise.all(promises);

      for (const r of results) {
        assert.equal(r.code, 0, `round ${round}: the hook must never exit non-zero under concurrent Stops — stderr: ${r.stderr}`);
      }

      const ledger = readLedger(dir);
      // RE-CUT (R1): the join between the seeded register entries and the
      // promoted receipts is now DISPATCH IDENTITY (identity.agent_id), not the
      // agent_type+at composite — that composite was the retired consume key,
      // and reusing it here would keep a retired notion alive inside a test.
      const key = (e) => e.identity?.agent_id ?? e.agent_id;
      const expectedKeys = new Set(entries.map(key));
      const actualKeys = new Set(ledger.map(key));

      assert.equal(
        ledger.length,
        N,
        `round ${round}: expected all ${N} reviewer-class Stops to promote a receipt, found ${ledger.length} — a lost register entry means the matching Stop found nothing and silently no-op'd (the measured harm in board 673ca3f6)`
      );
      assert.deepEqual(
        [...actualKeys].sort(),
        [...expectedKeys].sort(),
        `round ${round}: promoted receipt identity set does not match the full seeded set — some reviewer-class entry's review evidence never reached the ledger`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ===========================================================================
// C3 — control: sequential single-event behavior is unchanged.
// EXPECTED TODAY AND AFTER ANY FUTURE LOCK: GREEN, deterministically.
// ===========================================================================

test('C3 (control, re-cut A1): sequential single Start + matching reviewer Stop — one entry appended, exactly one receipt promoted, the entry MARKED ended and kept', () => {
  const dir = makeProject();
  try {
    const tPath = writeParentTranscript(dir, [taskBlock('Task', 'solo dispatch touching src/solo.mjs')]);

    const start = runHookSync(HOOK_SCRIPT, h22Input(dir, { agent_id: 'solo-1', agent_type: 'reviewer-solo', transcript_path: tPath }), dir);
    assert.equal(start.code, 0, start.stderr);

    let reg = readRegister(dir);
    assert.equal(reg.length, 1, 'a single sequential Start appends exactly one entry');
    assert.equal(reg[0].agent_id, 'solo-1');

    const stop = runHookSync(HOOK_SCRIPT, h22Input(dir, { agent_id: 'solo-1', agent_type: 'reviewer-solo', session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(stop.code, 0, stop.stderr);

    reg = readRegister(dir);
    assert.equal(reg.length, 1, 'A1: promotion does not delete the entry');
    assert.equal(reg[0].ended?.event, 'subagent-stop', 'the promoted entry is MARKED ended, so inactive-confirmed has evidence on disk');

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1, 'exactly one receipt is promoted for the sole sequential reviewer Stop');
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): agent_type now lives at reviewer.agent_type on a v2-promoted entry (dual-shape, mirrors C2 above).
    assert.equal(ledger[0].reviewer?.agent_type ?? ledger[0].agent_type, 'reviewer-solo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// R1-A95/A96 — the LOCK arms, deterministic and in-process, re-cut onto the ONE
// owner-mkdir primitive (A5). The pid/host/age takeover rules themselves are
// pinned at their owner in scripts/tests/dispatch-register-owner.test.mjs
// (R1-A31..A38); what is pinned HERE is the property the register writers
// depend on: a held lock refuses rather than being forced, and two writers are
// never inside it at once.
// SABOTAGE (A95): make the lock advisory — enter the critical section when the
// owner file already exists — and A95 goes red on `ran === false` while A96
// goes red on `maxInside === 1`.
// ===========================================================================

test('R1-A95: a lock held by a LIVE owner on this host refuses a second entrant with [register_lock_held] — and the critical section is entered once it is released', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const release = holdRegisterLock(dir);
    const lockDir = lockLib.registerLockDir(dir);

    let ran = false;
    const blocked = await refusalOf(() =>
      lockLib.withOwnerMkdirLock(lockDir, () => { ran = true; }, { retryMs: 20, timeoutMs: 200 })
    );
    assert.equal(blocked.code, 'register_lock_held', `expected register_lock_held, got ${JSON.stringify(blocked)}`);
    assert.equal(ran, false, 'the critical section never ran while the lock was held');
    assert.equal(blocked.facts?.lock_dir, lockDir, 'the refusal names the directory the operator must inspect by hand');

    release();
    const after = await lockLib.withOwnerMkdirLock(lockDir, () => 'entered', { retryMs: 20, timeoutMs: 2000 });
    assert.equal(after, 'entered', 'once the holder is gone the lock is cleanly acquirable — no orphaned owner file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The exclusivity property the whole primitive exists for, deterministic and
// in-process. A no-op lock fails it immediately; a lock that serialises but
// leaks its owner file fails the release check.
test('R1-A96: two concurrent withOwnerMkdirLock calls never overlap their critical sections, and the lock ends up released', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const lockDir = lockLib.registerLockDir(dir);
    let inside = 0;
    let maxInside = 0;
    const body = async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await sleep(40);
      inside -= 1;
      return 'ok';
    };
    const results = await Promise.all([
      refusalOf(() => lockLib.withOwnerMkdirLock(lockDir, body, { retryMs: 10, timeoutMs: 3000 })),
      refusalOf(() => lockLib.withOwnerMkdirLock(lockDir, body, { retryMs: 10, timeoutMs: 3000 })),
    ]);
    assert.equal(maxInside, 1, 'two writers must never be inside the register lock at once');
    assert.ok(results.some((r) => r.code === undefined), 'at least one contender must get in');
    for (const r of results) {
      if (r.code !== undefined) assert.equal(r.code, 'register_lock_held', 'the only legitimate loss is a held-lock refusal');
    }
    // The mutex IS the directory, so release must remove the DIRECTORY: an
    // implementation that unlinks owner.json but leaves the dir still holds the
    // mkdir and deadlocks the next writer (same correction as owner R1-A31/A36).
    assert.equal(existsSync(lockDir), false, 'the lock DIRECTORY is gone — the next writer is not deadlocked by an ownerless leftover');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// D1b — RETIRED — see the R1 ledger in this file's header. A stale-steal victim
// cannot exist once takeover requires a verified-dead owner (A5), so there is
// no late-release-after-steal path left to pin.

// D1c — RETIRED — see the R1 ledger. The exclusivity half survives as R1-A96 above;
// the pid/host takeover rules (and the absence of an age takeover) are pinned at
// their owner in scripts/tests/dispatch-register-owner.test.mjs R1-A32..A35.

// D1d — RETIRED — see the R1 ledger. A5 removes the age-based steal outright, so
// "two stealers race for one stale lock" is no longer a reachable state.

// ===========================================================================
// D2 — integration arm: on register-lock contention, a SubagentStart's
// mutation is SKIPPED, never written unlocked. The lock is held by THIS
// process, on THIS host, for the whole lifetime of the child — under A5 that
// is unstealable at any age, which retires the CI knife-edge the old
// mtime-refresh harness worked around.
// EXPECTED TODAY: RED — either the lock-lib import fails (assert.fail above
// short-circuits first), or, if the helper exists but the hook does not yet
// call it, the register would show the new entry appended (an unlocked
// write happened) instead of staying byte-identical.
// SABOTAGE (once shipped): on lock-acquire timeout inside the hook, fall
// through to writing the register unlocked anyway (reusing the ledger's
// unlocked-timeout-fallback shape) — the byte-identical assertion goes red.
// ===========================================================================

test('D2: on register-lock contention, SubagentStart SKIPS the mutation — register byte-unchanged, exactly one [register_lock_held] disclosure, exit 0', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const seeded = [{ agent_id: 'existing-1', agent_type: 'coder', session_id: 's1', files: ['src/existing.mjs'], at: '2026-08-28T00:00:00.000Z' }];
    writeRegisterRaw(dir, seeded);
    const before_ = readFileSync(registerPath(dir), 'utf8');

    const release = holdRegisterLock(dir);
    const tPath = writeParentTranscript(dir, [taskBlock('Task', 'touch src/new.mjs')]);
    const r = await runHookAsync(HOOK_SCRIPT, h22Input(dir, { agent_id: 'blocked-1', agent_type: 'coder', transcript_path: tPath }), dir);
    release();

    assert.equal(r.code, 0, `a lock timeout is disclosed, never denies the spawn — stderr: ${r.stderr}`);
    const skipLines = registerSkipLines(`${r.stdout}\n${r.stderr}`);
    assert.equal(skipLines.length, 1, `expected exactly one register-lock-skip disclosure line, found ${skipLines.length}: ${JSON.stringify(r.stderr.split('\n'))}`);

    const after = readFileSync(registerPath(dir), 'utf8');
    assert.equal(after, before_, 'the register is byte-identical — the mutation was skipped, never written unlocked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RE-CUT: D3 — a held lock promotes nothing (double-promotion route), 2026-09-07
//
// The previous D3 asserted the OPPOSITE — that the receipt is promoted even
// though the register marking is skipped. Under A1 (Stop MARKS, never deletes)
// that is a double-promotion route, not evidence preservation: the entry stays
// UNENDED, so the next Stop for the same round binds it again and promotes a
// second receipt for one review. The ruled contract is all-or-nothing under the
// lock — the Stop writes NOTHING and says so loudly, and the round is settled by
// a later Stop that actually gets the lock.
// SABOTAGE: promote outside the locked section (the old behaviour) -> the
// ledger-byte-identical assertion goes red while D3-CONTROL stays green, which
// is what separates "promotion is gated on the lock" from "promotion is broken".
// ===========================================================================

test('D3: under a HELD register lock a reviewer-class SubagentStop writes NOTHING — ledger and register byte-identical, one [register_lock_held] disclosure, exit 0', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const entry = { agent_id: 'rev-blocked-1', agent_type: 'reviewer-blocked', session_id: 's1', files: ['src/blocked.mjs'], at: '2026-08-28T00:00:00.000Z', attribution: 'block' };
    writeRegisterRaw(dir, [entry]);
    const registerBefore = readFileSync(registerPath(dir), 'utf8');
    const ledgerBefore = existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null;

    const release = holdRegisterLock(dir);
    const lockDir = lockLib.registerLockDir(dir);
    const r = await runHookAsync(
      HOOK_SCRIPT,
      h22Input(dir, { agent_id: entry.agent_id, agent_type: entry.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }),
      dir
    );
    release();

    assert.equal(r.code, 0, `a lock refusal is disclosed, never denies the spawn — stderr: ${r.stderr}`);
    const text = `${r.stdout}\n${r.stderr}`;
    const skipLines = registerSkipLines(text);
    assert.equal(skipLines.length, 1, `exactly one [register_lock_held] disclosure, found ${skipLines.length}: ${JSON.stringify(r.stderr.split('\n'))}`);
    assert.ok(skipLines[0].includes(lockDir), `the disclosure names the lock dir the operator must inspect by hand; got: ${skipLines[0]}`);
    assert.match(text, /coordination, not evidence/, 'and states the remedy posture: the lock is coordination, removed by hand only once no writer runs');

    assert.equal(
      existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null,
      ledgerBefore,
      'NO receipt is appended under a held lock — promoting while the entry stays unended is the double-promotion route'
    );
    assert.equal(readFileSync(registerPath(dir), 'utf8'), registerBefore, 'the register is byte-identical — no marking, no rewrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// D3-CONTROL, and it carries the verdict's other half: without this arm the
// byte-identical assertions above are satisfied just as well by a Stop that
// never promotes at all.
// SABOTAGE: gate promotion on something other than the lock (e.g. never promote
// on Stop) -> this goes red while D3 stays green.
test('D3-CONTROL: the SAME fixture with NO lock held promotes exactly one receipt and marks the round ended', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const entry = { agent_id: 'rev-blocked-1', agent_type: 'reviewer-blocked', session_id: 's1', files: ['src/blocked.mjs'], at: '2026-08-28T00:00:00.000Z', attribution: 'block' };
    writeRegisterRaw(dir, [entry]);

    const r = await runHookAsync(
      HOOK_SCRIPT,
      h22Input(dir, { agent_id: entry.agent_id, agent_type: entry.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, CODE_LOCK_HELD, 'nothing was contended, so nothing is disclosed');

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1, 'the uncontended Stop promotes exactly one receipt');
    assert.equal((ledger[0].identity?.agent_id ?? ledger[0].agent_id), entry.agent_id, 'joined on dispatch identity, mirroring C2');
    assert.equal(readRegister(dir)[0].ended?.event, 'subagent-stop', 'and the round is settled, so no later Stop can promote it again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// LOCK-PATH — RETIRED (see the R1 ledger in this file's header). It asserted,
// by source-text regex, WHICH specifier two hook files import from: a module-
// placement pin, not a behaviour. Its real content — that H1 and H10 take the
// SAME lock as the owner module — is now pinned BEHAVIOURALLY by H1-TIMEOUT and
// H10-TIMEOUT below, which hold the lock dir the owner module names and observe
// both hooks skip their mutation. A hook importing a respelled or duplicated
// lock helper would not contend with that dir at all, and would delete/stamp
// the register instead of skipping — which is exactly what those two arms fail
// on. That is a strictly stronger pin than the specifier match.
// ===========================================================================

// ===========================================================================
// H1-TIMEOUT — integration arm: while the register lock is held externally,
// H1's SessionStart register deletion is skipped — the register survives,
// exit 0, and the skip is disclosed loudly.
// EXPECTED TODAY: RED — either the lock-lib import fails, or H1 does not yet
// participate in the lock at all (it would delete the register unlocked,
// so `after` would not exist / would not equal `before_`).
// SABOTAGE (once shipped): have H1 delete the register unconditionally
// before/without acquiring the lock — the byte-identical-survival assertion
// goes red.
// ===========================================================================

test('H1-TIMEOUT: while the register lock is held, SessionStart(startup) skips the register deletion — register survives, exit 0, skip disclosed', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    writeRegisterRaw(dir, [{ agent_id: 'stale-1', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], at: '2026-08-28T00:00:00.000Z' }]);
    const before_ = readFileSync(registerPath(dir), 'utf8');

    const release = holdRegisterLock(dir);

    const r = await runHookAsync(
      'h1-session-start.mjs',
      { session_id: 's1', transcript_path: join(dir, 't', 'none.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' },
      dir,
      { NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root }
    );
    release();

    assert.equal(r.code, 0, `H1 must still exit 0 even when the register deletion is skipped — stderr: ${r.stderr}`);
    const after = readFileSync(registerPath(dir), 'utf8');
    assert.equal(after, before_, 'the register survives — the deletion is skipped under a held lock, never forced through unlocked');
    // CONVERTED (§4) + the BEHAVIOURAL replacement for the retired LOCK-PATH
    // import-specifier pin: H1 can only contend with, and disclose, a lock it
    // takes from the OWNER module — a respelled or duplicated helper would not
    // see this lock dir at all and would delete the register instead.
    assert.match(`${r.stdout}\n${r.stderr}`, CODE_LOCK_HELD, 'the skipped cleanup is disclosed with its code, not silently dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// H10-TIMEOUT — integration arm: while the register lock is held externally,
// an H10 Stop shaped to stamp residue_reported_at (the full-deferral shape
// from scripts/tests/h22-dispatch-register.mjs's H10 cases) skips that
// write — register byte-unchanged, exit 0.
// EXPECTED TODAY: RED — either the lock-lib import fails, or H10 does not
// yet attempt any register write at all (today's H10 "never mutates the
// dispatch register" per the pre-hardening article/tests), so there is no
// stamp attempt to skip and this pin cannot yet be satisfied by the
// intended mechanism.
// SABOTAGE (once shipped): have H10 stamp residue_reported_at unconditionally
// without acquiring the lock — the byte-identical assertion goes red.
// ===========================================================================

test('H10-TIMEOUT: while the register lock is held, an H10 Stop that would stamp residue_reported_at skips the write — register byte-unchanged, exit 0', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const liveEntry = { agent_id: 'sub-timeout-1', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], at: new Date().toISOString() };
    writeRegisterRaw(dir, [liveEntry]);
    const before_ = readFileSync(registerPath(dir), 'utf8');

    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.mjs'), '// touched\n');
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src/x.mjs', at: new Date().toISOString() }]));

    const release = holdRegisterLock(dir);

    const r = await runHookAsync(
      'h10-direct-capture.mjs',
      { session_id: 's1', transcript_path: join(dir, 't', 'none.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' },
      dir
    );
    release();

    assert.equal(r.code, 0, `H10 must still exit 0 even when its residue stamp is skipped under lock contention — stderr: ${r.stderr}`);
    const after = readFileSync(registerPath(dir), 'utf8');
    assert.equal(after, before_, 'the register is byte-identical — the residue_reported_at stamp attempt was skipped, never written unlocked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// DISPATCH-IDENTITY DISCRIMINATION — CONTROL, placed FIRST (Codex outside-
// family review, thread 01a0586b + decision 57984926, cited 2026-08-31): the
// LEDGER-IDEMPOTENCY pin below only ever re-seeds the SAME agent_id, so it
// cannot distinguish "dedupe keys on dispatch identity" from "dedupe keys on
// agent_type+at" — both readings produce the same green there. This CONTROL
// varies agent_id while holding agent_type AND started_at (`at`) fixed: two
// genuinely DISTINCT reviewer dispatches that collide on agent_type+at must
// BOTH promote. A dedupe keyed on agent_type+at (instead of dispatch
// identity) would silently discard the second receipt — real data loss, not
// idempotency.
// EXPECTED RED until dedupe keys on dispatch identity (agent_id), not on
// agent_type+at.
// SABOTAGE: key the ledger-append idempotency check on `${agent_type}::${at}`
// instead of the dispatch identity — `ledger.length` stays 1 instead of 2.
// ===========================================================================

test('DISPATCH-IDENTITY (control): two DISTINCT reviewer dispatches sharing agent_type AND started_at (`at`) both promote — dedupe must key on dispatch identity, not on agent_type+at', () => {
  const dir = makeProject();
  try {
    const sharedAt = '2026-08-29T00:00:00.000Z';
    const entryA = { agent_id: 'rev-collide-a', agent_type: 'reviewer-collide', session_id: 's1', files: ['src/collide-a.mjs'], at: sharedAt };
    const entryB = { agent_id: 'rev-collide-b', agent_type: 'reviewer-collide', session_id: 's1', files: ['src/collide-b.mjs'], at: sharedAt };
    writeRegisterRaw(dir, [entryA, entryB]);

    const stopA = runHookSync(HOOK_SCRIPT, h22Input(dir, { agent_id: entryA.agent_id, agent_type: entryA.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(stopA.code, 0, stopA.stderr);
    const stopB = runHookSync(HOOK_SCRIPT, h22Input(dir, { agent_id: entryB.agent_id, agent_type: entryB.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(stopB.code, 0, stopB.stderr);

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 2, 'two DISTINCT dispatches sharing agent_type+at must both promote — neither is a duplicate of the other');
    const entryIds = ledger.map((e) => e.entry_id).filter(Boolean);
    if (entryIds.length === ledger.length) {
      assert.notEqual(entryIds[0], entryIds[1], 'two genuinely distinct promotions mint distinct entry_ids');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// LEDGER-IDEMPOTENCY — two Stops for the SAME reviewer agent_id (simulating
// the skipped-removal retry shape: the register entry is re-seeded exactly
// as a prior lock-timeout would have left it behind) must produce exactly
// ONE ledger receipt for that agent_id, not two.
// EXPECTED TODAY: RED — no idempotency check exists yet; two Stops for the
// same agent_id today would append two separate ledger entries.
// SABOTAGE (once shipped): drop the agent_id idempotency check from the
// ledger append path — the second-Stop "still exactly one receipt"
// assertion goes red.
// STRENGTHENED 2026-08-31 (Codex outside-family review, thread 01a0586b +
// decision 57984926): Codex called the old generic-word disclosure match
// non-probative — it could pass under a wrong agent_type+at-keyed dedupe just
// as easily as a correct agent_id-keyed one. The disclosure assertion below
// now demands the actual duplicate IDENTITY (the literal agent_id) appear,
// not merely a stock phrase; the DISPATCH-IDENTITY control above proves the
// OTHER half (different identity, same type+time -> never treated as a dup).
// ===========================================================================

// R1-A97 (re-cut of LEDGER-IDEMPOTENCY): idempotency is now STRUCTURAL, not a
// dedupe key. A Stop binds the single UNENDED (session_id, agent_id) round; once
// that round is marked ended there is nothing left to bind, so a repeated Stop
// promotes nothing and refreshes nothing. The old fixture re-seeded an UNENDED
// entry between the two Stops, which under A4 is a NEW round and must mint a
// second receipt — R1-A98 pins exactly that, so the two arms cannot both be
// satisfied by a blanket "never promote twice for one agent_id".
// SABOTAGE: make Stop promote whenever a matching agent_id exists, ignoring the
// ended marker -> A97 goes red (two receipts) while A98 stays green.
test('R1-A97: a repeated Stop against an already-ENDED round promotes nothing — the register holds one receipt and one ended entry', () => {
  const dir = makeProject();
  try {
    const entry = { agent_id: 'rev-idem-1', agent_type: 'reviewer-idem', session_id: 's1', files: ['src/idem.mjs'], at: '2026-08-28T00:00:00.000Z', attribution: 'block' };
    writeRegisterRaw(dir, [entry]);

    const stopInput = h22Input(dir, { agent_id: entry.agent_id, agent_type: entry.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' });
    const first = runHookSync(HOOK_SCRIPT, stopInput, dir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(readLedger(dir).length, 1, 'the first Stop promotes exactly one receipt');
    assert.equal(readRegister(dir)[0].ended?.event, 'subagent-stop', 'and marks the round ended');

    const second = runHookSync(HOOK_SCRIPT, stopInput, dir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(readLedger(dir).length, 1, 'a Stop with no unended round to bind promotes nothing — no second receipt');
    assert.equal(readRegister(dir).length, 1, 'and appends no phantom entry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// R1-A98 CONTROL (A4, measured): a resumed round has its OWN Start and its OWN
// receipt. This is the arm that stops A97 from being satisfied by "one receipt
// per agent_id, ever", which would silently lose every corrective review round.
// SABOTAGE: dedupe the ledger append on agent_id -> A98 goes red (one receipt
// instead of two) while A97 stays green.
test('R1-A98 CONTROL: a SECOND round for the same agent_id (its own Start, its own Stop) mints its OWN receipt', () => {
  const dir = makeProject();
  try {
    const base = { agent_id: 'rev-idem-2', agent_type: 'reviewer-idem', session_id: 's1', files: ['src/idem.mjs'], attribution: 'block' };
    writeRegisterRaw(dir, [
      { ...base, round: 1, at: '2026-08-28T00:00:00.000Z', ended: { at: '2026-08-28T00:05:00.000Z', event: 'subagent-stop' } },
      { ...base, round: 2, at: '2026-08-28T01:00:00.000Z' },
    ]);

    const r = runHookSync(HOOK_SCRIPT, h22Input(dir, { agent_id: base.agent_id, agent_type: base.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const ledger = readLedger(dir);
    assert.equal(ledger.length, 1, 'round 2 mints its own receipt');
    assert.equal(ledger[0].started_at ?? ledger[0].at, '2026-08-28T01:00:00.000Z', "the receipt binds round 2's Start, not round 1's");

    const reg = readRegister(dir);
    assert.equal(reg.length, 2, 'both rounds survive on disk');
    assert.equal(reg[0].ended.at, '2026-08-28T00:05:00.000Z', "round 1's terminal instant is never refreshed");
    assert.equal(reg[1].ended?.event, 'subagent-stop', 'round 2 is the round that was marked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
