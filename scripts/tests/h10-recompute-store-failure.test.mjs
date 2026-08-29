// H10 — a STORE WRITE FAILURE inside the article_missing LIVE RECOMPUTE must not
// be able to void the Stop duties that run downstream of it.
//
// SPEC ONLY. `scripts/hooks/h10-direct-capture.mjs` was NOT read to author this
// file — H4 denied the read AND denied content-mode Grep over `scripts/`, and
// neither was routed around. That matters more than usual here: the fix under
// test and the probe this file was derived from were written by the SAME coder
// dispatch, so an oracle anchored to the implementation would certify whatever
// the fix happens to do. The contract below comes from spec surfaces only —
//   * board `da8dcd27` (h10-now-opens-a-write-transaction-upstream-of-its-own-blocki),
//     measured at HEAD 80fa755, quoting file:line, the exit-1 consequence, and
//     the three weighed fix directions (a)/(b)/(c);
//   * anti_pattern `e13f0fb5` — "a blocking hook that reads loadConfig/openStore
//     UNGUARDED fails OPEN on a corrupt config/store — the F5 class recurs
//     across hooks";
//   * scripts/tests/h10-article-missing-live-recompute.test.mjs (the recompute's
//     own frozen ruling: a carried name leaves an item for exactly three
//     reasons — owner / gitignored / absent on disk — and D-1's "the recompute
//     is hoisted ABOVE the no-duty terminal release");
//   * scripts/tests/h10-fail-open-timestamps.test.mjs (harness idiom, and the
//     capture-duty nag's stderr surface `/nothing was captured/`, pinned there
//     twice — SPEC H and SPEC K — as "the standard capture-duty nag").
//
// THE DEFECT (board da8dcd27, :251-291 at the measured HEAD). The recompute runs
// `withRetry(() => store.withTransaction(...))` — a BEGIN IMMEDIATE *write*
// transaction — and it sits UPSTREAM of the capture duty's blocking `deny()`.
// H10's founding try/catch calls `warnNonBlocking`, never `deny` (the baselined
// F5 debt this hook carries). So ANY throw in that region exits 1, the runner
// reads non-2 as NON-BLOCKING, and EVERY remaining Stop duty is voided —
// including the blocking capture nag. `withRetry` gives up after 5 BUSY tries
// and rethrows, and rethrows on the FIRST try for a non-BUSY store refusal, so
// nothing exotic is needed: the board's own scenario is a concurrent MCP
// `board_add` holding the write lock past the budget. The session then ends with
// no nag shown and no `capture_owed` minted — the exact failure the capture lane
// exists to prevent.
//
// WHAT IS PINNED HERE, AND WHAT IS DELIBERATELY NOT. This file pins fix
// direction (b) only: the recompute's failure is CONTAINED and DISCLOSED, and
// the duties below it still run. It does NOT pin H10 as a whole becoming
// fail-closed — direction (a) retires a baselined hole and is its own
// adjudicated change. It does NOT move the recompute below the deny —
// direction (c) would reopen finding D, already pinned by D-1 in
// scripts/tests/h10-article-missing-live-recompute.test.mjs. Nothing here should
// be read as covering either.
//
// ---------------------------------------------------------------------------
// WHY EVERY ARMED ARM CARRIES TWO LIVENESS PROBES.
//
// "H10 exited 2" is a verdict with MORE THAN ONE possible cause, and so is "H10
// did not exit 1": the fix worked, OR the recompute never ran, OR the injected
// failure never armed, OR the hook died somewhere else entirely. Two structural
// probes give the verdict one cause, and every armed arm asserts BOTH:
//   (1) THE ARMING MARKER. The failure is injected through a PATH shim on
//       `git check-ignore`, a call H10 makes inside the region under test —
//       after `openStore`, before the transaction. The shim drops a marker file.
//       Marker present ⇒ the hook demonstrably got past config load and store
//       open and reached the region. Marker absent ⇒ the fixture failed, not the
//       fix, and the arm says so in its own message. This probe is
//       exit-code-independent and reads identically before and after the fix.
//   (2) THE UNWRITTEN KEY LIST. Every armed arm re-reads the seeded item and
//       requires it to still carry the prunable name `src/gone.mjs`. Under a
//       healthy store the recompute prunes it (CONTROL-1 proves that, same
//       fixture, opposite outcome), so its survival is positive evidence that
//       the write was genuinely REFUSED. Without it, "the nag fired" is
//       satisfied by a run in which nothing ever failed.
// The target arm adds the ORDINARY DUTY OUTPUT itself — the capture nag's
// spec-attested `/nothing was captured/` — so a green means "the hook ran to its
// blocking decision AND rendered its normal output", not merely "it failed to
// block".
//
// ---------------------------------------------------------------------------
// RED-BEFORE-THE-FIX IS NOT THE TEST OF WORTH — THE NAMED SABOTAGE IS.
// 3 of the 5 arms here (CONTROL-1, CONTROL-2, CONTROL-3) pass against the OLD
// broken code as well as the new. That is correct: a control that only passes
// after the fix is not a control. Each states its status and its own one-line
// sabotage beneath it. Without them the two target arms are satisfied by an
// implementation that never enters the recompute at all (measured by the coder:
// `if (false && reachedMissing.length)` left the target arm GREEN) or by one
// that prints the degrade notice on every single Stop.
//
// NO RED OUTPUT IS CLAIMED FROM THIS AUTHOR: the test-writer holds no Bash.
// These were never executed here.
// Run with:  node --test scripts/tests/h10-recompute-store-failure.test.mjs
//
// SOURCE, NOT BUNDLE: like every sibling h10 test, the harness spawns
// `scripts/hooks/h10-direct-capture.mjs` — the SOURCE hook. It never touches
// `hooks/h10-direct-capture.mjs`, which is the esbuild bundle and is STALE with
// respect to this fix. A green here gates the landed source with or without
// `npm run build:hooks`; it says NOTHING about the bundle the platform actually
// loads, and the conductor must rebuild before this fix is live.
//
// ---------------------------------------------------------------------------
// WHY THE FIXTURE IS SHAPED THIS WAY (read before editing it):
//   * A REAL git repo WITH A COMMIT. Several sites upstream of the deny record a
//     check_skipped when git cannot answer — those are unguarded store WRITES of
//     their own, a separate and narrower instance of the same class, deliberately
//     NOT fixed by this change. The commit keeps them from firing so this file
//     measures the recompute transaction and only it.
//   * A READABLE TRANSCRIPT, so the pressure/delegation cells parse and do not
//     record check_skipped rows of their own.
//   * ONE touched file, already in HEAD. One unowned touched file is below the
//     article-demand threshold (three, per the sibling file's CONTROL-1), so the
//     ARTICLE demand cannot fire and the CAPTURE duty is the sole duty in play.
//     That is what makes "H10 exited 2" unambiguous about WHICH gate spoke, and
//     the `/nothing was captured/` assertion confirms it rather than assuming it.
//
// HOW THE FAILURE IS DELIVERED, and why not with a held lock. A held SQLite write
// lock cannot isolate this region: SterlingStore's constructor itself opens a
// BEGIN IMMEDIATE to stamp the schema, so the hook would die inside openStore —
// OUTSIDE the founding try. That is a WIDER hole than the one under test; it is
// reported separately and this file's green must not be read as covering it.
// Instead the store's own live write guard delivers the refusal: bumping
// `PRAGMA user_version` from another process while the hook's handle is open
// makes every later write on that handle refuse, and the refusal is not
// SQLITE_BUSY, so `withRetry` rethrows on the first try — no sleeps, no races,
// no wall-clock dependence.
//
// NOT CONSTRUCTIBLE HERE, AND SAID PLAINLY RATHER THAN FAKED: an arm asserting
// the `check_skipped` ROW itself. Any injection that makes the recompute's write
// fail also makes the best-effort row write fail — that is not a gap in the
// fixture, it is the situation, and it is exactly why the stderr line is a
// SEPARATE requirement rather than a nicety. Two properties stand in for the row
// arm, and both are pinned: the row write must be GUARDED (an unguarded
// `recordCheckSkipped` in the new catch throws into the founding catch and turns
// TARGET-1 red), and it must not be able to SWALLOW the disclosure (a stderr
// write nested inside that guard, after the call, turns TARGET-2 red).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks'); // the SOURCE hook, never hooks/*.mjs

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const H10_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

const AT = '2026-08-29T09:00:00.000Z';

function envelope(type, at) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

const REAL_GIT = (() => {
  const r = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
})();

/** The injection is a POSIX `sh` shim resolved through PATH. On native Windows a
 *  PATH entry named `git` with no extension is never executed, so the failure
 *  would silently NOT be injected and the armed arms would pass vacuously — the
 *  precise failure this file exists to prevent. Probe and skip LOUDLY instead
 *  (the chmodDenialWorks/symlinkWorks idiom of the sibling h1 suite). */
const shimWorks = () => process.platform !== 'win32' && REAL_GIT !== '';

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `fixture: git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-txfail-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(H10_CONFIG));

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), '// touched\n');
  git(dir, ['init']);
  git(dir, ['add', 'src/a.mjs']);
  git(dir, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'base']);

  mkdirSync(join(dir, 't'), { recursive: true });
  writeFileSync(
    join(dir, 't', 's1.jsonl'),
    `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0 }, model: 'claude-fable-5' } })}\n`
  );

  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

/**
 * Arms the store's live write guard against the hook's already-open handle, at a
 * point INSIDE the region under test: the shim bumps `PRAGMA user_version` from
 * a separate process the first time H10 asks git to answer `check-ignore`, which
 * it does after opening the store and before the recompute's transaction.
 *
 * Returns the marker path as well as the env — the marker is the liveness probe
 * described in the header, and every armed arm asserts it.
 */
function armWriteRefusalOnFirstCheckIgnore(dir) {
  const shimDir = join(dir, '.sterling', 'shim');
  mkdirSync(shimDir, { recursive: true });
  const bumper = join(shimDir, 'bump.mjs');
  const db = join(dir, '.sterling', 'sterling.db');
  writeFileSync(
    bumper,
    `import { DatabaseSync } from 'node:sqlite';\n` +
      `const d = new DatabaseSync(${JSON.stringify(db)});\n` +
      `const v = d.prepare('PRAGMA user_version').get().user_version;\n` +
      `d.exec('PRAGMA user_version = ' + (v + 1));\n` +
      `d.close();\n`
  );
  const shim = join(shimDir, 'git');
  const marker = join(shimDir, 'bumped');
  writeFileSync(
    shim,
    `#!/bin/sh\n` +
      `for a in "$@"; do\n` +
      `  if [ "$a" = "check-ignore" ] && [ ! -f ${JSON.stringify(marker)} ]; then\n` +
      `    : > ${JSON.stringify(marker)}\n` +
      `    ${JSON.stringify(process.execPath)} ${JSON.stringify(bumper)} >/dev/null 2>&1\n` +
      `    break\n` +
      `  fi\n` +
      `done\n` +
      `exec ${JSON.stringify(REAL_GIT)} "$@"\n`
  );
  chmodSync(shim, 0o755);
  return { env: { PATH: `${shimDir}:${process.env.PATH}` }, marker };
}

/**
 * An open `article_missing` item this session's paths REACH (src/a.mjs), carrying
 * one prunable name that does not exist on disk (src/gone.mjs). Reaching it is
 * what makes the hook enter the recompute at all; the prunable name is what makes
 * the recompute do real WRITE work, so its survival or removal is observable
 * evidence about whether the transaction committed.
 *
 * The prune ruling is not invented here: the sibling frozen file's E-2 pins that
 * a carried name whose file is absent on disk leaves the item.
 */
function seedReachedDemand(store, at) {
  return store.create({
    ...envelope('todo', at),
    text: 'article_missing fixture naming 2 file(s)',
    source: 'system',
    system_reason: 'article_missing',
    file_keys: ['src/a.mjs', 'src/gone.mjs'],
    priority: 'normal',
    lifecycle: 'live',
    freshness: 'fresh',
    version: 1,
  });
}

/** One touched file that still exists and has no owning article — arms the
 *  CAPTURE duty and nothing else. */
function armCaptureDuty(dir, at) {
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify([{ path: 'src/a.mjs', at }]));
}

function stop(dir, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h10-direct-capture.mjs')], {
    input: JSON.stringify({
      session_id: 's1',
      transcript_path: join(dir, 't', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: 'Stop',
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 120_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const demands = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'article_missing');
const keysOf = (store) => {
  const open = demands(store);
  assert.equal(open.length, 1, 'fixture: exactly one open article_missing item is expected throughout this file');
  return [...open[0].file_keys].sort();
};

/**
 * THE CAPTURE NAG'S SURFACE. Spec-attested, not transcribed from the hook:
 * scripts/tests/h10-fail-open-timestamps.test.mjs pins `/nothing was captured/`
 * twice (SPEC H, SPEC K) as "the standard capture-duty nag". Used here as the
 * ORDINARY DUTY OUTPUT probe — a code 2 alone would not show WHICH gate spoke.
 */
const CAPTURE_NAG = /nothing was captured/i;

/**
 * THE DISCLOSURE. Deliberately CONTRACT-SHAPED rather than a transcription of
 * one sentence: a single stderr line that (a) NAMES the article_missing
 * recompute and (b) STATES the degraded condition. P5 fixes that a duty which
 * quietly did not run must say so; it does not fix the wording, and pinning the
 * wording would anchor this oracle to the implementation it is checking. If the
 * disclosure exists but spans two lines, that is evidence for the conductor —
 * not a licence to weaken the pin.
 */
const DEGRADED = /(skip|fail|could not|couldn't|cannot|unable|error|degrad)/i;
function disclosureLine(stderr) {
  return (
    stderr
      .split('\n')
      .find((l) => /recompute/i.test(l) && /article[_ -]?missing/i.test(l)) ?? ''
  );
}

// =========================================================================
// GROUP 1 — CONTAINMENT. The recompute's write transaction fails and the Stop
// must still reach the blocking capture nag.
//
// CONTROL-1 and CONTROL-2 open the group and must pass for the OPPOSITE reason
// to TARGET-1: one proves the recompute genuinely RUNS AND WRITES when the store
// is healthy, the other proves the injected refusal genuinely STOPS that write.
// Strip either and TARGET-1 is satisfied by an implementation that simply never
// enters the recompute — measured by the coder, whose `if (false &&
// reachedMissing.length)` sabotage left the target arm GREEN.
// =========================================================================

test('CONTROL-1: with the store WRITABLE the recompute runs, WRITES, and the ordinary capture nag fires — the target arms are evidence only while this holds', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedReachedDemand(store, AT);
    armCaptureDuty(dir, AT);

    const r = stop(dir);

    // ORDINARY DUTY OUTPUT — the hook ran to its blocking decision and rendered
    // its normal output. Asserted before anything else so the key-list evidence
    // below is known to come from a completed run.
    assert.equal(r.code, 2, `CONTROL-1: the capture duty is unmet, so H10 soft-blocks once: ${r.stderr}`);
    assert.match(r.stderr, CAPTURE_NAG, `CONTROL-1: and the block is the CAPTURE nag specifically — one unowned touched file is below the article-demand threshold, so no other duty is in play: ${r.stderr}`);

    assert.deepEqual(
      keysOf(store),
      ['src/a.mjs'],
      'CONTROL-1: the recompute RAN and COMMITTED — src/gone.mjs is absent on disk and was pruned, src/a.mjs is still unowned and was kept. If this arm fails, the armed arms below are not measuring a CONTAINED transaction failure, they are measuring a transaction that never happened'
    );
  } finally {
    cleanup();
  }
});
// STATUS: GREEN before the fix AND after — it pins the behaviour the fix must not
// break, not the fix itself.
// SABOTAGE (one line): `if (false && reachedMissing.length)` — never enter the
// recompute. src/gone.mjs survives, the deepEqual fires, caught. This is the ONLY
// arm that catches a "fix" which disables the lane, and every other arm in this
// file stays green under it.

test('CONTROL-2: the injected failure really does REFUSE the recompute\'s write — an armed arm that passes because nothing was ever attempted proves nothing', (t) => {
  if (!shimWorks()) {
    t.skip('the PATH shim needs POSIX sh + a resolvable git — the failure cannot be injected on this host');
    return;
  }
  const { dir, store, cleanup } = makeProject();
  try {
    seedReachedDemand(store, AT);
    armCaptureDuty(dir, AT);
    const { env, marker } = armWriteRefusalOnFirstCheckIgnore(dir);

    const r = stop(dir, env);

    // LIVENESS PROBE (1) — exit-code-independent, and identical before and after
    // the fix. It is what separates "the failure was contained" from "the hook
    // died before it ever reached the region".
    assert.ok(
      existsSync(marker),
      `CONTROL-2: the arming point was never reached — H10 did not ask git to answer check-ignore, so no failure was injected at all. That is a FIXTURE failure, not a finding about the fix; every armed arm below is void until it is fixed. stderr: ${r.stderr}`
    );
    assert.ok(
      r.code === 1 || r.code === 2,
      `CONTROL-2: H10 must reach a verdict, not vanish. Board da8dcd27 measures the UNFIXED behaviour as exit 1 (founding catch -> warnNonBlocking) and the fixed behaviour as exit 2 (capture nag); a 0 means no duty fired and the fixture is wrong, a null means the process was killed or timed out. Got ${r.code}: ${r.stderr}`
    );

    // LIVENESS PROBE (2) — same fixture as CONTROL-1, opposite outcome. THAT
    // DIFFERENCE IS THE INJECTION.
    assert.deepEqual(
      keysOf(store),
      ['src/a.mjs', 'src/gone.mjs'],
      'CONTROL-2: the recompute did NOT write — the item still carries the stale src/gone.mjs that CONTROL-1 saw pruned, and the transaction left no partial state behind either'
    );
  } finally {
    cleanup();
  }
});
// STATUS: GREEN before the fix AND after (it asserts nothing about containment).
// SABOTAGE (one line): disarm the shim — drop the `[ ! -f marker ]` bump so no
// user_version change occurs. The recompute then commits, src/gone.mjs is pruned,
// the deepEqual fires, caught. Read together with CONTROL-1 this arm is the
// diagnosis separator: if BOTH go red on their key lists the injection broke; if
// only TARGET-1 goes red on its exit code, the containment regressed.

test('TARGET-1: a store write failure inside the article_missing recompute is CONTAINED — the blocking capture nag downstream of it still fires, instead of the whole Stop exiting 1 non-blocking', (t) => {
  if (!shimWorks()) {
    t.skip('the PATH shim needs POSIX sh + a resolvable git — the failure cannot be injected on this host');
    return;
  }
  const { dir, store, cleanup } = makeProject();
  try {
    seedReachedDemand(store, AT);
    armCaptureDuty(dir, AT);
    const { env, marker } = armWriteRefusalOnFirstCheckIgnore(dir);

    const r = stop(dir, env);

    // This arm carries its OWN evidence rather than borrowing CONTROL-2's: the
    // marker proves the region was reached, the surviving key proves the write
    // was genuinely refused. Both are asserted before the verdict, so a green
    // here can only mean "a real failure was contained".
    assert.ok(existsSync(marker), `TARGET-1: the arming point was never reached — no failure was injected, so this arm's verdict is void. FIXTURE failure, not a finding. stderr: ${r.stderr}`);
    assert.deepEqual(
      keysOf(store),
      ['src/a.mjs', 'src/gone.mjs'],
      'TARGET-1: the write was genuinely REFUSED (src/gone.mjs survives, where CONTROL-1 saw it pruned). Without this the assertion below is satisfied by a run in which nothing failed'
    );

    assert.equal(
      r.code,
      2,
      `TARGET-1: H10 must still DENY. The recompute could not write, but the capture duty below it is untouched by that failure. Exit 1 here is the reported defect exactly: the store failure escaped into the founding catch, warnNonBlocking ran instead of deny, the runner read non-2 as NON-BLOCKING, and EVERY remaining Stop duty was voided — the session ends with no nag, no capture_owed, and the conductor is told nothing. stderr: ${r.stderr}`
    );
    assert.match(
      r.stderr,
      CAPTURE_NAG,
      `TARGET-1: and the block must be the CAPTURE nag specifically — a code 2 raised by some other duty would not show that the capture lane survived the failure. stderr: ${r.stderr}`
    );

    // DIAGNOSTIC ONLY, and flagged as such: unlike CAPTURE_NAG above, this
    // phrase has no prior-test attestation, so a reword makes it vacuously true
    // rather than falsely red. It is kept because when it DOES match it names
    // the exact escape path, which the exit code alone does not.
    assert.doesNotMatch(
      r.stderr,
      /session-end duties skipped/i,
      `TARGET-1 (diagnostic): the founding catch's non-blocking warn must NOT be what handled this — reaching it means the throw escaped the recompute and took every downstream duty with it. stderr: ${r.stderr}`
    );
  } finally {
    cleanup();
  }
});
// STATUS: RED before the fix (exit 1, the `assert.equal(r.code, 2)` fires), GREEN
// after. This is the arm the board was raised for.
// SABOTAGE (one line): `throw e;` at the top of the recompute's new catch — i.e.
// restore the bare `withRetry(() => store.withTransaction(...))`. Exit 1, caught.
// SECOND SABOTAGE, DIFFERENT GUARD, SAME ARM: drop the try/catch around the
// catch-block's `recordCheckSkipped(...)` call. With the store unwritable that
// call throws too, the throw reaches the founding catch, and the arm goes red the
// same way — which is how this file pins the row write's GUARDEDNESS without
// being able to observe the row itself.
// LOAD-BEARING GUARD: the containment try/catch around the transaction. There is
// no defence in depth behind it — H10's founding catch is the baselined F5 hole
// and reaching it IS the failure, so a single-guard mutation here is a true red,
// not a layered one.

// =========================================================================
// GROUP 2 — DISCLOSURE. Containment alone is not the contract: a silently
// degraded Stop is still a P5 failure. `article_missing` sits outside
// UPDATE_RESOLVABLE_LANES and never auto-drains, so a silently skipped heal
// leaves a stale demand whose prescribed remedy is "create the owning article"
// for a file that may already have one.
//
// CONTROL-3 opens the group and must pass for the OPPOSITE reason to TARGET-2:
// a HEALTHY recompute that ran, wrote, and said NOTHING. Without it, TARGET-2 is
// satisfied by an implementation that prints the degrade notice on every Stop —
// which is worse than the bug, because a notice that fires every session is a
// notice nobody reads (P1).
// =========================================================================

test('CONTROL-3 (silence control): a HEALTHY recompute discloses NOTHING — the degrade notice is an exception report, never a per-Stop banner', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedReachedDemand(store, AT);
    armCaptureDuty(dir, AT);

    const r = stop(dir);

    // Positive evidence that the region RAN and did its work — this arm's
    // silence is only meaningful once "the recompute executed" is established
    // separately. A bare doesNotMatch would be green for a hook that crashed.
    assert.equal(r.code, 2, `CONTROL-3: the hook ran to its blocking decision: ${r.stderr}`);
    assert.match(r.stderr, CAPTURE_NAG, `CONTROL-3: and rendered its ordinary duty output: ${r.stderr}`);
    assert.deepEqual(keysOf(store), ['src/a.mjs'], 'CONTROL-3: the recompute RAN and COMMITTED — so the silence below is the silence of a healthy run, not of a run that never got there');

    assert.equal(
      disclosureLine(r.stderr),
      '',
      `CONTROL-3: nothing was skipped, so nothing is disclosed. An unconditional notice passes TARGET-2 while telling the conductor nothing, and trains the reader to ignore the one Stop where it matters. stderr: ${r.stderr}`
    );
  } finally {
    cleanup();
  }
});
// STATUS: GREEN before the fix AND after (the notice does not exist before the
// fix, and must not fire on a healthy run after it).
// SABOTAGE (one line): hoist the stderr disclosure out of the catch so it prints
// on every recompute — disclosureLine becomes non-empty, the assert fires, caught.

test('TARGET-2: the contained failure is DISCLOSED on stderr — and the disclosure survives the check_skipped row write failing, which under a store failure it always does', (t) => {
  if (!shimWorks()) {
    t.skip('the PATH shim needs POSIX sh + a resolvable git — the failure cannot be injected on this host');
    return;
  }
  const { dir, store, cleanup } = makeProject();
  try {
    seedReachedDemand(store, AT);
    armCaptureDuty(dir, AT);
    const { env, marker } = armWriteRefusalOnFirstCheckIgnore(dir);

    const r = stop(dir, env);

    assert.ok(existsSync(marker), `TARGET-2: the arming point was never reached — no failure was injected, so this arm's verdict is void. FIXTURE failure, not a finding. stderr: ${r.stderr}`);
    assert.deepEqual(
      keysOf(store),
      ['src/a.mjs', 'src/gone.mjs'],
      'TARGET-2: the write was genuinely refused — this is the condition the disclosure is supposed to describe'
    );

    const line = disclosureLine(r.stderr);
    assert.notEqual(
      line,
      '',
      `TARGET-2: the skipped recompute must NAME ITSELF on stderr. This is not belt-and-braces on top of the check_skipped row — under a store write failure the row CANNOT land (measured: the coder's S2 sabotage removed the stderr line and the run showed the capture nag alone, with nothing anywhere recording that the heal had been skipped). A degraded Stop that looks identical to a healthy one is the P5 failure this hook exists to prevent, on a lane that never auto-drains and that nothing else re-raises. stderr: ${r.stderr}`
    );
    assert.match(
      line,
      DEGRADED,
      `TARGET-2: and it must state the DEGRADED CONDITION, not merely mention the lane — "recomputing article_missing" and "article_missing recompute skipped" read the same to a grep and opposite to a human. Line was: ${line}`
    );
  } finally {
    cleanup();
  }
});
// STATUS: RED before the fix (no such line exists — the throw escapes into the
// founding catch, whose warn is generic and names no lane), GREEN after.
// SABOTAGE (one line): `if (false) process.stderr.write(` on the disclosure —
// the line vanishes, the notEqual fires, caught. The coder measured exactly this
// sabotage and confirmed the row does not stand in for it.
// SECOND SABOTAGE, THE ORDERING ONE, AND THE REASON THIS ARM IS SEPARATE FROM
// TARGET-1: move the stderr write INSIDE the guard around recordCheckSkipped,
// after the call. With the store unwritable the row write throws first, the
// guard swallows it, and the disclosure never reaches stderr — the hook then
// CONTAINS the failure (TARGET-1 stays green) and hides it (this arm goes red).
// That pair is the whole point: containment and disclosure are two properties,
// and exactly one implementation shape satisfies both.
