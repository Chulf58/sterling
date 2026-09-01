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

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    lockLib = await import(pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'dispatch-register-lock.mjs')).href);
  } catch (err) {
    lockLibError = err;
  }
});

function missingLockLibMessage() {
  return (
    'scripts/hooks/lib/dispatch-register-lock.mjs is missing or failed to import' +
    (lockLibError ? ` (${lockLibError.message})` : '') +
    ' — expected exports acquireLock(lockDir, {retryMs?, staleMs?}) => ' +
    'Promise<{nonce, release: () => void} | null> and registerLockDir(projectDir) ' +
    '=> string. Per decision register-writers-cooperating-lock (1e0ba0d0) and the ' +
    'coordinator hardening message (wx create-exclusive, rename-to-tomb single-' +
    'winner steal, nonce-checked release).'
  );
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

// Best-effort: refresh the held lock directory's own mtime periodically so a
// slow CI runner never lets an externally-held lock APPEAR stale to the
// child hook under test while we hold it. If the real staleness check
// instead inspects an inner owner file's mtime rather than this directory's,
// this refresh has no protective effect — the hold-until-child-exit release
// timing used by D2/D3/H1-TIMEOUT/H10-TIMEOUT is what actually guarantees
// correctness regardless of which timestamp is authoritative.
function startMtimeRefresh(path, intervalMs = 500) {
  const timer = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      /* best-effort only */
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Exactly-one register-lock-skip disclosure line: must mention 'register'
// AND 'lock' AND a skip/timeout word. ASSUMED phrasing (no exact string is
// settled by any record) — deliberately tolerant of wording, strict on
// COUNT (a correct implementation discloses the skip once, not once per
// retry attempt).
function registerSkipLines(text) {
  return text.split('\n').filter((l) => /register/i.test(l) && /lock/i.test(l) && /(skip|timed?\s*out|timeout)/i.test(l));
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
      // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
      // standing): promoted entries are now v2-shaped (agent_type/at live under reviewer.agent_type/started_at),
      // while the SEEDED register `entries` above stay flat — key() must read either shape. entry_id is unusable
      // as the shared identity here: it exists ONLY on the promoted side (freshly minted per entry), so a seed
      // entry has nothing to compare it against — the composite agent_type::at identity is what this test's
      // intent actually needs (a stable value present on BOTH the seed and promoted sides), kept dual-shape-aware.
      const key = (e) => `${e.reviewer?.agent_type ?? e.agent_type}::${e.started_at ?? e.at}`;
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

test('C3 (control): sequential single Start + matching reviewer Stop — one entry appended, exactly one receipt promoted, register left empty', () => {
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
    assert.equal(reg.length, 0, 'the reviewer-class entry is removed from the register once promoted');

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
// D1a — deterministic lock arm: a held lock blocks a second acquirer until
// release. In-process acquire/acquire/release sequence.
// EXPECTED TODAY: RED — the module import fails (does not exist yet).
// SABOTAGE (once shipped): make acquireLock's retry loop non-blocking / a
// no-op wait (e.g. skip the retry and always immediately steal) — the
// "early" check (second acquirer must not resolve within 150ms of a live,
// non-stale first holder) goes red.
// ===========================================================================

test('D1a: a held lock blocks a second acquirer until release (deterministic, in-process)', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const lockDir = lockLib.registerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });

    const a = await lockLib.acquireLock(lockDir, { retryMs: 1000, staleMs: 60_000 });
    assert.ok(a, 'setup: the first acquire must succeed uncontended');

    const bPromise = lockLib.acquireLock(lockDir, { retryMs: 5000, staleMs: 60_000 });

    const early = await raceTimeout(bPromise, 150);
    assert.equal(early.resolved, false, 'a second acquirer must NOT enter while the first holder still holds a live, non-stale lock');

    await sleep(350);
    const releasedAt = Date.now();
    a.release();

    const late = await raceTimeout(bPromise, 5000);
    assert.equal(late.resolved, true, 'the second acquirer must succeed once the first holder releases, within its retry budget');
    assert.ok(late.value, 'the second acquire must resolve to a truthy lock, not null, once contention clears');
    assert.ok(Date.now() >= releasedAt, 'sanity: resolution happens at/after the release');

    if (late.value && typeof late.value.release === 'function') late.value.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// D1b — deterministic lock arm: OWNER NONCE. A stale-steal victim's late
// release() must not remove the new holder's lock.
// EXPECTED TODAY: RED — the module import fails (does not exist yet).
// SABOTAGE (once shipped): make release() unconditional (rmdir/unlink the
// owner without checking the stored nonce) — the "A's late release must NOT
// remove B's lock" assertion goes red.
// ===========================================================================

test("D1b: NONCE — a stale-steal victim's late release() does not remove the new holder's lock", async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const lockDir = lockLib.registerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });

    const a = await lockLib.acquireLock(lockDir, { retryMs: 200, staleMs: 100 });
    assert.ok(a, 'setup: the first acquire must succeed uncontended');

    await sleep(150); // now past staleMs=100 with A never releasing — A's lock is stale

    const b = await lockLib.acquireLock(lockDir, { retryMs: 1000, staleMs: 100 });
    assert.ok(b, 'a stale (expired, unreleased) lock must be stealable by a new acquirer');
    assert.notEqual(b.nonce, a.nonce, "stealing must mint a NEW nonce distinct from the stale holder's nonce");

    a.release(); // the ORIGINAL, now-superseded holder releasing late
    // Consistency check without assuming any internal file layout: B's lock
    // must still be genuinely held — a fresh, short-budget contender must
    // still be BLOCKED by B, proving A's late release did not free it.
    const stillBlocked = await lockLib.acquireLock(lockDir, { retryMs: 300, staleMs: 60_000 });
    assert.equal(stillBlocked, null, "A's late release must be a no-op against B's lock (nonce mismatch) — B must still be the exclusive holder");

    b.release();
    const freeNow = await lockLib.acquireLock(lockDir, { retryMs: 300, staleMs: 60_000 });
    assert.ok(freeNow, "B's own release DOES free the lock it actually owns");
    freeNow.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// D1c — deterministic lock arm: owner-write EXCLUSIVITY. A live, non-stale
// holder is never overwritten by a new acquirer; only once genuinely stale
// does a new acquirer steal it. See file header for why this drives the
// exclusivity/steal behavior through the public API rather than forging a
// raw owner file (D1c/D1d DISCLOSED SUBSTITUTION).
// EXPECTED TODAY: RED — the module import fails (does not exist yet).
// SABOTAGE (once shipped): make the exclusive owner-write silently overwrite
// an existing owner instead of failing/retrying (drop the 'wx' flag) — the
// "must never be overwritten" null-result assertion goes red.
// ===========================================================================

test('D1c: owner-write exclusivity — a live, non-stale holder is never overwritten; only after staleMs does a new acquirer steal it', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const lockDir = lockLib.registerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });

    const a = await lockLib.acquireLock(lockDir, { retryMs: 500, staleMs: 100_000 });
    assert.ok(a, 'setup: the first acquire must succeed uncontended');

    // Exclusivity: a short-budget, huge-staleMs contender must NEVER succeed
    // while A is live and non-stale — this is the 'wx' create-exclusive
    // rejection of an existing owner, not a timing coincidence.
    const blocked = await lockLib.acquireLock(lockDir, { retryMs: 300, staleMs: 100_000 });
    assert.equal(blocked, null, 'a live, non-stale owner must never be overwritten — the contender must exhaust its retry budget and resolve null');

    // A's own ownership must be untouched by the failed contender.
    a.release();
    const afterA = await lockLib.acquireLock(lockDir, { retryMs: 500, staleMs: 100_000 });
    assert.ok(afterA, "A's release must still work cleanly — the blocked contender's failed attempt left A's lock intact");

    // Eventual steal: once genuinely stale (tiny staleMs, real elapsed time),
    // a fresh acquirer DOES win it — single winner with exactly one
    // contender in this arm (D1d covers actual dual-contender racing).
    await sleep(20);
    const stolen = await lockLib.acquireLock(lockDir, { retryMs: 1000, staleMs: 5 });
    assert.ok(stolen, 'once the holder is stale, a new acquirer must be able to steal it');
    assert.notEqual(stolen.nonce, afterA.nonce, 'the steal mints a NEW nonce distinct from the (now-stale) previous holder');
    stolen.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// D1d — deterministic-ish lock arm: DUAL-STEALER SINGLE-WINNER. Two
// concurrent acquireLock calls contend over the same stale lock; neither
// ever observes a nonce collision, and the lock ends up in a cleanly
// re-acquirable state afterward. See D1c/D1d DISCLOSED SUBSTITUTION at the
// file header for why the "stale lock" is a real, never-released acquire
// rather than a hand-forged owner file with a backdated mtime.
// EXPECTED TODAY: RED — the module import fails (does not exist yet).
// SABOTAGE (once shipped): make the rename-to-tomb steal non-atomic (e.g.
// check-then-act instead of a single rename call) — under contention, both
// concurrent stealers can observe/mint the "same" nonce or the final
// fresh-acquire consistency check can fail (orphaned tomb/owner file).
// ===========================================================================

test('D1d: dual-stealer single-winner — two concurrent acquireLock calls against the same stale lock never collide, and the lock ends up consistent', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const lockDir = lockLib.registerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });

    // Establish a genuine (never-released) owner — stands in for "a stale
    // lock" without fabricating an undocumented internal file format.
    const orig = await lockLib.acquireLock(lockDir, { retryMs: 500, staleMs: 100_000 });
    assert.ok(orig, 'setup: the original acquire must succeed uncontended');
    await sleep(20); // ensure real elapsed time so a tiny staleMs below sees it as stale

    // staleMs = 5 ("0-ish" per the coordinator's ask) — both contenders
    // should treat the existing owner as immediately stealable.
    const [a, b] = await Promise.all([
      lockLib.acquireLock(lockDir, { retryMs: 3000, staleMs: 5 }),
      lockLib.acquireLock(lockDir, { retryMs: 3000, staleMs: 5 }),
    ]);

    assert.ok(a, 'contender A must eventually win a turn within its retry budget');
    assert.ok(b, 'contender B must eventually win a turn within its retry budget');
    assert.notEqual(a.nonce, orig.nonce, "A's nonce must be freshly minted, not the original stale holder's");
    assert.notEqual(b.nonce, orig.nonce, "B's nonce must be freshly minted, not the original stale holder's");
    assert.notEqual(a.nonce, b.nonce, 'A and B must never be handed the SAME nonce — that would mean two callers believe they hold one identical ownership token (a torn/non-atomic steal)');

    a.release();
    b.release();

    // Consistency check without assuming any internal file layout: the lock
    // must end up fully free — a fresh acquire must succeed immediately.
    const fresh = await lockLib.acquireLock(lockDir, { retryMs: 500, staleMs: 100_000 });
    assert.ok(fresh, 'after both contenders release, the lock must be in a clean, freshly-acquirable state — no lost dir, no orphaned owner/tomb file blocking future acquisition');
    fresh.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// D2 — integration arm: on register-lock timeout, a SubagentStart's
// mutation is SKIPPED, never written unlocked. Holds the register lock
// externally UNTIL THE CHILD HOOK EXITS (not a fixed sleep — see CI
// KNIFE-EDGE note below), refreshing the held lock's mtime periodically so a
// slow runner can never let the hold appear stale to the child.
// EXPECTED TODAY: RED — either the lock-lib import fails (assert.fail above
// short-circuits first), or, if the helper exists but the hook does not yet
// call it, the register would show the new entry appended (an unlocked
// write happened) instead of staying byte-identical.
// SABOTAGE (once shipped): on lock-acquire timeout inside the hook, fall
// through to writing the register unlocked anyway (reusing the ledger's
// unlocked-timeout-fallback shape) — the byte-identical assertion goes red.
//
// CI KNIFE-EDGE FIX: a fixed hold duration (e.g. 2.5s) is fragile — too
// short under CI load risks the hook acquiring before our hold even starts
// contending; too long is wasted time and, if it ever approached the
// stale-steal threshold, would let the hook steal instead of skip. Holding
// until the CHILD PROCESS ITSELF EXITS removes the guessing: we release
// only once the hook's own bounded retry-then-skip logic has already
// completed, by definition.
// ===========================================================================

test('D2: on register-lock timeout, SubagentStart SKIPS the mutation — register byte-unchanged, exactly one loud disclosure, exit 0', async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const seeded = [{ agent_id: 'existing-1', agent_type: 'coder', session_id: 's1', files: ['src/existing.mjs'], at: '2026-08-28T00:00:00.000Z' }];
    writeRegisterRaw(dir, seeded);
    const before_ = readFileSync(registerPath(dir), 'utf8');

    const lockDir = lockLib.registerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });
    const held = await lockLib.acquireLock(lockDir, { retryMs: 1000, staleMs: 60_000 });
    assert.ok(held, 'setup: the test must be able to hold the register lock externally');

    const stopRefresh = startMtimeRefresh(lockDir);
    const tPath = writeParentTranscript(dir, [taskBlock('Task', 'touch src/new.mjs')]);
    const r = await runHookAsync(HOOK_SCRIPT, h22Input(dir, { agent_id: 'blocked-1', agent_type: 'coder', transcript_path: tPath }), dir);
    stopRefresh();
    held.release();

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
// D3 — integration arm: STOP-EVIDENCE PRESERVATION. When a reviewer-class
// SubagentStop's register removal is skipped under a held lock, the receipt
// must still be promoted into review-ledger.json.
// EXPECTED TODAY: RED — same reasoning as D2.
// SABOTAGE (once shipped): make promotion conditional on the register
// removal having succeeded (e.g. only promote inside the same locked
// section as the removal, and skip promotion too on timeout) — the
// "receipt is promoted... even though removal was skipped" assertion goes
// red.
// ===========================================================================

test("D3: a reviewer-class SubagentStop's receipt is STILL promoted to the ledger when its register removal is skipped under a held lock", async () => {
  if (!lockLib) {
    assert.fail(missingLockLibMessage());
    return;
  }
  const dir = makeProject();
  try {
    const entry = { agent_id: 'rev-blocked-1', agent_type: 'reviewer-blocked', session_id: 's1', files: ['src/blocked.mjs'], at: '2026-08-28T00:00:00.000Z' };
    writeRegisterRaw(dir, [entry]);

    const lockDir = lockLib.registerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });
    const held = await lockLib.acquireLock(lockDir, { retryMs: 1000, staleMs: 60_000 });
    assert.ok(held, 'setup: the test must be able to hold the register lock externally');

    const stopRefresh = startMtimeRefresh(lockDir);
    const r = await runHookAsync(
      HOOK_SCRIPT,
      h22Input(dir, { agent_id: entry.agent_id, agent_type: entry.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }),
      dir
    );
    stopRefresh();
    held.release();

    assert.equal(r.code, 0, `a lock timeout is disclosed, never denies the spawn — stderr: ${r.stderr}`);
    const skipLines = registerSkipLines(`${r.stdout}\n${r.stderr}`);
    assert.equal(skipLines.length, 1, `D3 must also loudly disclose its own register-lock timeout exactly once, found ${skipLines.length}: ${JSON.stringify(r.stderr.split('\n'))}`);

    const ledger = readLedger(dir);
    // SUPERSEDED 2026-08-31 by decision 57984926 (review-ledger-v2-lifecycle-refuse-flip-and-external-review-design,
    // standing): a v2-promoted entry carries agent_type/at at reviewer.agent_type/started_at; dual-shape lookup
    // keeps this search working for either shape (mirrors the C2 fix in this same file).
    const promoted = ledger.find((e) => (e.reviewer?.agent_type ?? e.agent_type) === entry.agent_type && (e.started_at ?? e.at) === entry.at);
    assert.ok(promoted, 'the reviewer-class receipt is promoted into the ledger even though the register removal was skipped under lock contention');

    const reg = readRegister(dir);
    assert.ok(
      reg.some((e) => e.agent_id === entry.agent_id),
      'the register removal was skipped under the held lock — the entry remains behind (bounded over-deferral is acceptable; lost review evidence is not)'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// LOCK-PATH — static pin: h1-session-start.mjs and h10-direct-capture.mjs
// both import registerLockDir from the shared lock helper, by the SAME
// specifier. This is a cheap source-text check (readFileSync on the two
// hook scripts AT TEST-RUN TIME, not a Read-tool inspection by the test
// author) — it never depends on the lock-lib import above.
// EXPECTED TODAY: RED — neither file imports registerLockDir yet.
// SABOTAGE (once shipped): respell the import specifier in either file
// (e.g. a typo'd relative path, or importing from a copy-pasted duplicate
// module instead of the shared one) — the match fails, proving the pin
// actually reads the live specifier rather than a cached assumption.
// ===========================================================================

test('LOCK-PATH: h1-session-start.mjs and h10-direct-capture.mjs both import registerLockDir from the shared dispatch-register-lock.mjs helper', () => {
  const h1Src = readFileSync(join(HOOKS, 'h1-session-start.mjs'), 'utf8');
  const h10Src = readFileSync(join(HOOKS, 'h10-direct-capture.mjs'), 'utf8');
  const importRe = /import\s*\{[^}]*\bregisterLockDir\b[^}]*\}\s*from\s*['"]([^'"]*dispatch-register-lock\.mjs)['"]/;

  const h1Match = h1Src.match(importRe);
  const h10Match = h10Src.match(importRe);

  assert.ok(h1Match, 'h1-session-start.mjs must import registerLockDir from the shared dispatch-register-lock.mjs helper (a respelled/duplicated specifier must fail this match)');
  assert.ok(h10Match, 'h10-direct-capture.mjs must import registerLockDir from the shared dispatch-register-lock.mjs helper (a respelled/duplicated specifier must fail this match)');
});

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

    const lockDir = lockLib.registerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });
    const held = await lockLib.acquireLock(lockDir, { retryMs: 1000, staleMs: 60_000 });
    assert.ok(held, 'setup: the test must be able to hold the register lock externally');
    const stopRefresh = startMtimeRefresh(lockDir);

    const r = await runHookAsync(
      'h1-session-start.mjs',
      { session_id: 's1', transcript_path: join(dir, 't', 'none.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' },
      dir,
      { NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root }
    );
    stopRefresh();
    held.release();

    assert.equal(r.code, 0, `H1 must still exit 0 even when the register deletion is skipped — stderr: ${r.stderr}`);
    const after = readFileSync(registerPath(dir), 'utf8');
    assert.equal(after, before_, 'the register survives — the deletion is skipped under a held lock, never forced through unlocked');
    assert.match(`${r.stdout}\n${r.stderr}`, /register.*(skip|lock)|(skip|lock).*register/i, 'the skipped cleanup is disclosed, not silently dropped');
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

    const lockDir = lockLib.registerLockDir(dir);
    mkdirSync(lockDir, { recursive: true });
    const held = await lockLib.acquireLock(lockDir, { retryMs: 1000, staleMs: 60_000 });
    assert.ok(held, 'setup: the test must be able to hold the register lock externally');
    const stopRefresh = startMtimeRefresh(lockDir);

    const r = await runHookAsync(
      'h10-direct-capture.mjs',
      { session_id: 's1', transcript_path: join(dir, 't', 'none.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop' },
      dir
    );
    stopRefresh();
    held.release();

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

test('LEDGER-IDEMPOTENCY: two Stops for the same reviewer agent_id (simulating a skipped-removal retry) yield exactly ONE ledger receipt', () => {
  const dir = makeProject();
  try {
    const entry = { agent_id: 'rev-idem-1', agent_type: 'reviewer-idem', session_id: 's1', files: ['src/idem.mjs'], at: '2026-08-28T00:00:00.000Z' };
    writeRegisterRaw(dir, [entry]);

    const first = runHookSync(HOOK_SCRIPT, h22Input(dir, { agent_id: entry.agent_id, agent_type: entry.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(first.code, 0, first.stderr);

    let ledger = readLedger(dir);
    assert.equal(ledger.length, 1, 'the first Stop promotes exactly one receipt');

    // Simulate the skipped-removal retry shape: the SAME register entry is
    // still present (as a prior lock-timeout skip would have left it), and a
    // SECOND Stop fires for the same agent_id.
    writeRegisterRaw(dir, [entry]);
    const second = runHookSync(HOOK_SCRIPT, h22Input(dir, { agent_id: entry.agent_id, agent_type: entry.agent_type, session_id: 's1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(second.code, 0, second.stderr);

    ledger = readLedger(dir);
    assert.equal(ledger.length, 1, 'the SECOND Stop for the same agent_id must be idempotent — the ledger must still hold exactly ONE receipt, not two');
    assert.match(
      `${second.stdout}\n${second.stderr}`,
      new RegExp(entry.agent_id),
      `the disclosure must name the actual duplicate IDENTITY (its agent_id, "${entry.agent_id}"), not merely a generic word — proving the dedupe reasons about identity, not a stock phrase`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
