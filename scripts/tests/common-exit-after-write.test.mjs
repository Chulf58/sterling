// R0 (objective rebuild-2026-09, board 6654707f) — hook stdout write-then-exit
// helper: scripts/hooks/lib/common.mjs's exitAfterWrite/allow/deny/
// warnNonBlocking, factory makeExitHelpers({ stdout, stderr, exit }).
//
// SPEC-ONLY ORACLE. Authoritative spec: decision
// hook-stdout-exit-after-write-callback-bound-exit-deny-stays-synchronous
// (knowledge_get fa147ba4-c7fe-4a15-8ff6-0b08e2a203fa) — read WHOLE, never the
// implementation (H4 wall; the coder builds scripts/hooks/lib/common.mjs in
// parallel from the same record). Every pin below names, in a comment
// immediately above or below the test, the ONE-LINE sabotage that must turn it
// red (decision a-ruling-change-is-verified-by-mutation-not-by-a-green-suite).
//
// The module does not exist yet at authoring time. Unit pins therefore import
// makeExitHelpers via a per-test dynamic import (loadHelpers()) rather than a
// top-level static import, so a missing module fails ONLY the tests that need
// it — the spawned-process pins (a)-(c), which do not import common.mjs into
// THIS process at all (they spawn a child that does), and the CONTROL half of
// (a), which never references common.mjs, still parse and run standalone.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const COMMON_PATH = join(HOOKS, 'lib', 'common.mjs');
const COMMON_URL = pathToFileURL(COMMON_PATH).href;

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

async function loadHelpers() {
  const mod = await import(COMMON_URL);
  return mod.makeExitHelpers;
}

// ---------------------------------------------------------------------------
// Deterministic payload builder, shared between the parent (for verification)
// and the strings embedded into spawned child scripts (for generation) — a
// fixed marker at the tail lets the test detect a truncation that cuts off
// anywhere, not merely a byte-count mismatch.
// ---------------------------------------------------------------------------
const MARKER = 'TAIL-MARKER-9f3a1b7c';
function makePayload(size) {
  if (size <= MARKER.length) return 'A'.repeat(size);
  return 'A'.repeat(size - MARKER.length) + MARKER;
}
const ONE_MIB = 1024 * 1024;
const PAYLOAD_SRC = `
const MARKER = ${JSON.stringify(MARKER)};
function makePayload(size) {
  if (size <= MARKER.length) return 'A'.repeat(size);
  return 'A'.repeat(size - MARKER.length) + MARKER;
}
`;

function mkChildDir() {
  return mkdtempSync(join(tmpdir(), 'sterling-exit-helper-'));
}

function spawnChild(scriptFile, args = [], opts = {}) {
  return spawn(process.execPath, [scriptFile, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

async function collectExit(child, { pause300 = false } = {}) {
  const chunks = [];
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
  });
  if (pause300) {
    child.stdout.on('data', (c) => chunks.push(c));
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 300);
  } else {
    child.stdout.on('data', (c) => chunks.push(c));
  }
  const [code] = await once(child, 'exit');
  return { code, stdout: Buffer.concat(chunks), stderr };
}

// ---------------------------------------------------------------------------
// (a) CONTROL (bare write truncates on this machine) + PIN (exitAfterWrite
// delivers every byte, exit code as requested).
// ---------------------------------------------------------------------------

test('(a) CONTROL: bare process.stdout.write + process.exit truncates a 1 MiB payload on this machine; PIN: exitAfterWrite delivers every byte and the requested exit code', async () => {
  const dir = mkChildDir();
  try {
    // --- CONTROL, first: proves the truncation is real on this host/harness,
    // so a green PIN below means "the helper fixes it", not "nothing ever
    // truncates here anyway".
    const bareScript = join(dir, 'bare-child.mjs');
    writeFileSync(
      bareScript,
      `${PAYLOAD_SRC}
const payload = makePayload(${ONE_MIB});
process.stdout.write(payload);
process.exit(0);
`,
    );
    const bareChild = spawnChild(bareScript);
    const bareResult = await collectExit(bareChild);
    assert.ok(
      bareResult.stdout.length < ONE_MIB,
      `CONTROL: a bare write must truncate below the full ${ONE_MIB} bytes on this machine (measured 146,176-182,720 of 1,048,576) — got ${bareResult.stdout.length}; if this ever reads the full length the CONTROL fixture itself is stale for this host`,
    );

    // --- PIN: the same 1 MiB payload through exitAfterWrite, for both a
    // clean and a non-zero requested exit code.
    const pinnedScript = join(dir, 'pinned-child.mjs');
    writeFileSync(
      pinnedScript,
      `import { exitAfterWrite } from ${JSON.stringify(COMMON_URL)};
${PAYLOAD_SRC}
const payload = makePayload(${ONE_MIB});
const code = Number(process.argv[2]);
exitAfterWrite(payload, code);
`,
    );
    for (const requested of [0, 1]) {
      const child = spawnChild(pinnedScript, [String(requested)]);
      const { code, stdout } = await collectExit(child);
      assert.equal(
        stdout.length,
        ONE_MIB,
        `PIN: exitAfterWrite must deliver all ${ONE_MIB} bytes for requested code ${requested} — got ${stdout.length}`,
      );
      assert.ok(
        stdout.toString('utf8').endsWith(MARKER),
        'PIN: the tail marker must survive intact — a partial delivery would cut it off',
      );
      assert.equal(code, requested, `PIN: exit code must equal the requested code ${requested} — got ${code}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE (CONTROL side): none needed — this arm measures the platform, not
// the helper; it must stay green regardless of the helper's state.
// SABOTAGE (PIN side): replace exitAfterWrite's body with a bare
// `stream.write(payload); exit(code);` (drop the callback-bound exit) — the
// PIN's stdout.length assertion goes red for at least one requested code,
// reproducing the CONTROL's own truncation inside the "fixed" path.

// ---------------------------------------------------------------------------
// (b) A reader that pauses stdout for 300ms before resuming still gets every
// byte — the exit must not race a paused/backpressured pipe.
// ---------------------------------------------------------------------------

test('(b) a reader that pauses stdout 300ms before resuming still receives the full 1 MiB payload', async () => {
  const dir = mkChildDir();
  try {
    const script = join(dir, 'pause-child.mjs');
    writeFileSync(
      script,
      `import { exitAfterWrite } from ${JSON.stringify(COMMON_URL)};
${PAYLOAD_SRC}
const payload = makePayload(${ONE_MIB});
exitAfterWrite(payload, 0);
`,
    );
    const child = spawnChild(script);
    const { code, stdout } = await collectExit(child, { pause300: true });
    assert.equal(stdout.length, ONE_MIB, `pausing the reader must not lose bytes — got ${stdout.length}`);
    assert.ok(stdout.toString('utf8').endsWith(MARKER), 'the tail marker must survive a paused reader');
    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: exit as soon as stream.write() RETURNS (its boolean return value)
// instead of waiting for the write callback — with the reader paused 300ms
// the process exits before the OS pipe buffer drains and this test goes red
// on the stdout.length assertion (fewer than ONE_MIB bytes received).

// ---------------------------------------------------------------------------
// (c) EPIPE: destroying the read end must exit non-zero, disclose the
// failure on stderr, and never crash as an unhandled 'error' event.
// ---------------------------------------------------------------------------

test("(c) EPIPE: a destroyed read end makes exitAfterWrite exit 1 (requested 0), naming the failure on stderr, with no 'Unhandled error' crash", async () => {
  const dir = mkChildDir();
  try {
    const script = join(dir, 'epipe-child.mjs');
    writeFileSync(
      script,
      `import { exitAfterWrite } from ${JSON.stringify(COMMON_URL)};
${PAYLOAD_SRC}
const payload = makePayload(${ONE_MIB});
await new Promise((r) => setTimeout(r, 150));
exitAfterWrite(payload, 0);
`,
    );
    const child = spawnChild(script);
    // Destroy the read end immediately; the child writes 150ms later so the
    // destroy is guaranteed to land first.
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, `a write failing via EPIPE with requested code 0 must exit 1, never a clean 0 — got ${code}`);
    assert.match(stderr, /stdout/i, "the helper's own stderr line names stdout as the failing stream");
    assert.match(stderr, /EPIPE/, "the helper's own stderr line names the EPIPE error code");
    assert.doesNotMatch(stderr, /Unhandled 'error'/, 'no unhandled-error crash text');
    assert.doesNotMatch(stderr, /ERR_UNHANDLED_ERROR/, 'no unhandled-error crash text');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: attach the write callback but never `stream.once('error', ...)`
// before writing — Node's default behavior for an unhandled stream 'error'
// event is to throw and crash the process; this test goes red on the exit
// code (no longer a clean, disclosed 1) and/or picks up default crash text
// instead of the helper's own stderr line.

// ---------------------------------------------------------------------------
// Stub stream + exit recorder for the in-process unit pins (d)-(j).
// ---------------------------------------------------------------------------

/**
 * mode: 'ok' (default) — write(chunk, cb) calls cb() synchronously, success.
 *       'cb-error'      — cb(err) then also emits 'error' (both signals fire;
 *                          settle-once must be proven by the helper).
 *       'throw'         — write() throws synchronously before returning.
 *       'sync-cb'       — cb() is invoked synchronously, before write()
 *                          returns (proves pending is counted before write).
 *       'deferred'      — cb is stashed; call fireDeferred(err?) to settle it
 *                          later, under the test's own control.
 */
class StubStream {
  constructor({ mode = 'ok' } = {}) {
    this.mode = mode;
    this.writes = [];
    this._listeners = {};
    this._deferredCb = null;
  }
  write(chunk, cb) {
    this.writes.push(chunk);
    if (this.mode === 'throw') {
      throw new Error('synchronous stub write throw');
    }
    if (this.mode === 'sync-cb') {
      cb();
      return true;
    }
    if (this.mode === 'cb-error') {
      cb(new Error('stub write callback error'));
      this._emit('error', new Error('stub write error event'));
      return true;
    }
    if (this.mode === 'deferred') {
      this._deferredCb = cb;
      return true;
    }
    cb();
    return true;
  }
  once(event, fn) {
    (this._listeners[event] ??= []).push(fn);
  }
  removeListener(event, fn) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((f) => f !== fn);
  }
  off(event, fn) {
    this.removeListener(event, fn);
  }
  _emit(event, ...args) {
    for (const fn of (this._listeners[event] || []).slice()) fn(...args);
  }
  fireDeferred(err) {
    const cb = this._deferredCb;
    this._deferredCb = null;
    if (cb) cb(err);
  }
}

/**
 * A stdout stub built on a REAL node:events EventEmitter, so once/on/
 * removeListener/listenerCount are Node's own implementations rather than the
 * hand-rolled bookkeeping in StubStream. Only `write` is added: it stashes the
 * callback for the test to settle with fireDeferred(err?). This is what makes
 * `listenerCount('error')` a trustworthy observation of the helper's attach/
 * remove behaviour.
 */
class EmitterStubStream extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this._deferredCb = null;
  }
  write(chunk, cb) {
    this.writes.push(chunk);
    this._deferredCb = cb;
    return true;
  }
  fireDeferred(err) {
    const cb = this._deferredCb;
    this._deferredCb = null;
    if (cb) cb(err);
  }
}

function exitRecorder() {
  const calls = [];
  const fn = (code) => calls.push(code);
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// (d) A write reported failed via BOTH the callback and the 'error' event
// settles ONCE.
// ---------------------------------------------------------------------------

test("(d) a write whose callback reports an error AND the stream also emits 'error' settles exactly ONCE: one exit call, code 1, onWritten never runs", async () => {
  const makeExitHelpers = await loadHelpers();
  const stdout = new StubStream({ mode: 'cb-error' });
  const stderr = new StubStream({ mode: 'ok' });
  const exit = exitRecorder();
  let onWrittenCalled = false;
  const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
  exitAfterWrite('payload', 0, {
    onWritten: () => {
      onWrittenCalled = true;
    },
  });
  assert.equal(exit.calls.length, 1, 'a write reported failed via both signals must settle exactly once — got ' + exit.calls.length + ' exit calls');
  assert.equal(exit.calls[0], 1, 'a failed write with requested code 0 exits 1, never a clean 0');
  assert.equal(onWrittenCalled, false, 'onWritten must never run for a failed write');
});
// SABOTAGE: drop the PER-WRITE `settled` flag (the guard that makes the first
// of the two signals win and the second a no-op) — the callback error and the
// stub's `_emit('error', ...)` then each run the settle path, and
// exit.calls.length becomes 2. Note what carries this verdict: the settle-once
// property is the `settled` flag, NOT `removeListener` — removing the listener
// is a separate obligation, pinned on its own immediately below, and stripping
// it alone leaves THIS test green whenever the flag is intact.

// ---------------------------------------------------------------------------
// (d, second half) The write's 'error' listener is attached BEFORE the write
// and REMOVED when the write settles — success arm and failure arm. Uses a
// real EventEmitter so listenerCount() is Node's own accounting.
// ---------------------------------------------------------------------------

test("(d) the stdout 'error' listener is attached before the write and removed once the write settles — both the success and the failure arm", async () => {
  const makeExitHelpers = await loadHelpers();

  // --- SUCCESS arm.
  {
    const stdout = new EmitterStubStream();
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('payload', 0);
    // CONTROL, first: the listener really was attached before the write — so a
    // count of 0 after settle means REMOVED, never "never attached at all".
    assert.equal(
      stdout.listenerCount('error'),
      1,
      "CONTROL: exactly one 'error' listener must be attached before the write is issued — without this arm a green removal assertion is satisfied by a helper that never listens",
    );
    stdout.fireDeferred();
    assert.deepEqual(exit.calls, [0], 'the settled write exits once with the requested code');
    assert.equal(
      stdout.listenerCount('error'),
      0,
      "a settled write must remove its 'error' listener — a listener surviving the settle can fire a second exit for a later, unrelated stream error",
    );
  }

  // --- FAILURE arm: the callback reports an error; the listener must still go.
  {
    const stdout = new EmitterStubStream();
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('payload', 0);
    assert.equal(stdout.listenerCount('error'), 1, "CONTROL: the 'error' listener is attached before the write");
    stdout.fireDeferred(new Error('write failed'));
    assert.deepEqual(exit.calls, [1], 'a failed write with requested code 0 exits 1');
    assert.equal(
      stdout.listenerCount('error'),
      0,
      "a write that settles via its CALLBACK with an error must also remove the 'error' listener — no 'error' event fired here, so nothing removes it implicitly",
    );
  }
});
// SABOTAGE: delete the `stream.removeListener('error', onError)` from the
// settle path — both `listenerCount('error') === 0` assertions go red (they
// read 1), while test (d) above stays green. That asymmetry is the point: the
// settle-once flag and the listener removal are two different guards, and each
// is now pinned by the test that names it.

// ---------------------------------------------------------------------------
// (e) A synchronous stream.write throw exits 1 for requested 0, and
// preserves a non-zero requested code.
// ---------------------------------------------------------------------------

test('(e) a synchronous stream.write throw exits 1 for requested code 0, and preserves a non-zero requested code (2 stays 2)', async () => {
  const makeExitHelpers = await loadHelpers();
  {
    const stdout = new StubStream({ mode: 'throw' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('payload', 0);
    assert.deepEqual(exit.calls, [1], 'a synchronous write throw with requested code 0 must exit 1, never a clean 0');
    assert.equal(stderr.writes.length, 1, 'exactly one stderr line reports the failure');
  }
  {
    const stdout = new StubStream({ mode: 'throw' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('payload', 2);
    assert.deepEqual(exit.calls, [2], 'a synchronous write throw with a requested non-zero code preserves that code, never remapped to 1');
  }
});
// SABOTAGE: remove the try/catch around the synchronous stream.write() call
// — the StubStream's thrown Error propagates up through exitAfterWrite and
// out of the test body uncaught, so both arms fail (the second arm's
// deepEqual([2]) never even runs, or the whole test errors instead of
// asserting).

// ---------------------------------------------------------------------------
// (f) A synchronously-settling write (callback fires before write() returns)
// still yields exactly one exit call — proves pending is counted BEFORE the
// write is issued.
// ---------------------------------------------------------------------------

test('(f) a stream whose write calls its callback SYNCHRONOUSLY before returning still yields exactly one exit call with the requested code', async () => {
  const makeExitHelpers = await loadHelpers();
  const stdout = new StubStream({ mode: 'sync-cb' });
  const stderr = new StubStream({ mode: 'ok' });
  const exit = exitRecorder();
  const { exitAfterWrite, allow } = makeExitHelpers({ stdout, stderr, exit });
  exitAfterWrite('payload', 0);
  assert.equal(
    exit.calls.length,
    1,
    'a synchronously-settling write must yield exactly one exit call — pending must be counted before stream.write() is invoked, or a synchronous callback settles against a not-yet-incremented counter (double exit, or none)',
  );
  assert.deepEqual(exit.calls, [0]);

  // The instance has now settled with nothing pending. Two further terminal
  // calls on the SAME instance must each be absorbed by the shared `finished`
  // latch ("finish is idempotent: the first ACTUAL process.exit wins"), and
  // neither may throw. If the pending counter had gone NEGATIVE, these are the
  // calls that would expose it: allow() consults `pending`, and a second
  // exitAfterWrite('') takes the nothing-pending synchronous branch.
  assert.doesNotThrow(() => allow(), 'allow() after a settled write must not throw');
  assert.deepEqual(
    exit.calls,
    [0],
    'allow() after the write already settled adds NO further exit call — the first exit wins (finish is idempotent)',
  );
  exitAfterWrite('', 0);
  assert.deepEqual(
    exit.calls,
    [0],
    "a second exitAfterWrite('', 0) after the instance has already exited adds NO further exit call — one exit per process, the first one wins",
  );
});
// SABOTAGE (what this test DOES pin): remove the idempotency latch from finish
// (let every terminal call reach `exit`) — the post-settle allow() and the
// second exitAfterWrite('', 0) each append a code and the two deepEqual([0])
// assertions go red (they read [0, 0] / [0, 0, 0]).
// SABOTAGE (pending++ ORDER) — HONEST LIMIT, stated rather than claimed: moving
// `pending++` to AFTER stream.write() is observable here ONLY if the settle
// path tests `pending === 0` — the decrement then runs against a counter still
// at 0, reaches -1, no exit ever fires, and `exit.calls.length === 1` goes red.
// If the settle path tests `--pending <= 0` instead, the sabotaged order still
// produces exactly one exit and this test stays GREEN. The increment's position
// is not otherwise observable from outside the helper with any stub reachable
// from this file (a negative counter is re-zeroed by the very increment that
// was moved), so the record's "pending is incremented BEFORE stream.write" is
// pinned only to that extent. The arms above pin the one-exit-per-process
// invariant, which is what the ordering exists to protect.

// ---------------------------------------------------------------------------
// (g) Nothing pending: exitAfterWrite('', 0) exits synchronously. A pending
// write: allow() is a no-op until the write settles.
// ---------------------------------------------------------------------------

test('(g) an empty payload with nothing pending exits synchronously; allow() while a write is pending is a no-op until it settles', async () => {
  const makeExitHelpers = await loadHelpers();

  {
    const stdout = new StubStream({ mode: 'ok' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('', 0);
    assert.deepEqual(exit.calls, [0], 'an empty payload with nothing pending must exit synchronously, before the call returns');
    assert.equal(stdout.writes.length, 0, 'an empty payload must never attempt a stdout write');
  }

  {
    const stdout = new StubStream({ mode: 'ok' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { allow } = makeExitHelpers({ stdout, stderr, exit });
    allow();
    assert.deepEqual(exit.calls, [0], 'allow() with nothing pending exits synchronously with 0 — unchanged non-returning semantics');
  }

  {
    const stdout = new StubStream({ mode: 'deferred' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite, allow } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('payload', 0);
    allow();
    assert.equal(exit.calls.length, 0, 'allow() must be a no-op while a write is pending — the pending finish carries');
    stdout.fireDeferred();
    assert.deepEqual(exit.calls, [0], 'once the pending write settles, exit fires exactly once with 0');
  }
});
// SABOTAGE: make allow() unconditionally call exit(0) regardless of pending
// state (drop the pending-aware guard) — the third arm's
// `assert.equal(exit.calls.length, 0)` right after calling allow() goes red
// (a call is already recorded before the deferred write ever settles).

// ---------------------------------------------------------------------------
// (h) warnNonBlocking() while pending discloses without exiting; deny() while
// pending still hard-exits 2 synchronously.
// ---------------------------------------------------------------------------

test('(h) warnNonBlocking() while a write is pending discloses on stderr without exiting; deny() while pending still hard-exits 2 synchronously (a block is never lowered)', async () => {
  const makeExitHelpers = await loadHelpers();

  {
    const stdout = new StubStream({ mode: 'deferred' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite, warnNonBlocking } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('pending-payload', 0);
    assert.equal(exit.calls.length, 0, 'setup: the write is deferred/pending, nothing has exited yet');

    warnNonBlocking('advisory message x');
    assert.equal(exit.calls.length, 0, 'warnNonBlocking must not exit while a write is pending');
    const stderrText = stderr.writes.join('');
    assert.match(stderrText, /advisory message x/, 'the advisory message reaches stderr immediately');

    stdout.fireDeferred();
    assert.deepEqual(exit.calls, [0], 'once the pending write settles, exit fires exactly once with the requested code 0 — a delivered envelope outranks an advisory failure');
  }

  {
    const stdout = new StubStream({ mode: 'deferred' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite, deny } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('pending-payload', 0);
    assert.equal(exit.calls.length, 0, 'setup: the write is still pending');

    deny('deny message m');
    assert.deepEqual(exit.calls, [2], 'deny() while a write is pending must still hard-exit 2 synchronously — a block is never lowered');
    assert.match(stderr.writes.join(''), /deny message m/, 'the deny message reaches stderr');

    // deny() takes the shared `finished` latch ITSELF before exit(2), so the
    // stdout write settling afterwards in this injected instance can never add
    // a second exit (amended record; Codex review 01a07a8b HIGH).
    stdout.fireDeferred();
    assert.deepEqual(
      exit.calls,
      [2],
      'the pending write settling AFTER deny() adds nothing — deny took the shared finished latch, so the block stands alone and is never followed by the envelope exit',
    );
  }

  {
    // warnNonBlocking() with NOTHING pending takes the latch the same way.
    const stdout = new StubStream({ mode: 'deferred' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { warnNonBlocking } = makeExitHelpers({ stdout, stderr, exit });

    warnNonBlocking('advisory with nothing pending');
    assert.deepEqual(
      exit.calls,
      [1],
      'warnNonBlocking() with nothing pending is a synchronous stderr write + immediate exit 1 — it does not wait for anything',
    );
    assert.match(stderr.writes.join(''), /advisory with nothing pending/, 'the advisory message reaches stderr');
    assert.equal(stdout.writes.length, 0, 'warnNonBlocking never touches stdout');

    stdout.fireDeferred(); // nothing was ever written: there is no callback to settle
    assert.deepEqual(exit.calls, [1], 'with nothing pending there is nothing to settle later — the exit list is unchanged');
  }
});
// SABOTAGE: make warnNonBlocking() call exit(0) immediately instead of
// deferring to the pending write's own settle — the first arm's
// `assert.equal(exit.calls.length, 0)` right after warnNonBlocking() goes
// red. A second, independent sabotage: make deny() check pending state and
// defer like warnNonBlocking() instead of hard-exiting immediately — the
// second arm's `assert.deepEqual(exit.calls, [2])` (checked BEFORE the
// deferred write is ever settled) goes red because exit.calls is still [].
// A third, independent sabotage: route deny() through finish() (or drop the
// latch-taking so deny exits WITHOUT marking the process finished) — the
// post-settle `deepEqual(exit.calls, [2])` goes red, reading [2, 0]: the
// truncated envelope's exit follows the block, subordinating a block to
// exitCode (reviewer-correctness F6). A fourth: make warnNonBlocking() exit 0
// with nothing pending — the third arm's `deepEqual(exit.calls, [1])` reads
// [0].

// ---------------------------------------------------------------------------
// (i) Exactly ONE stdout envelope per process: a second non-empty payload is
// suppressed and disclosed on stderr; stderr writes are never suppressed.
// ---------------------------------------------------------------------------

test('(i) a second non-empty stdout envelope is suppressed (stdout.write called once) and disclosed on stderr; multiple stderr writes are never suppressed', async () => {
  const makeExitHelpers = await loadHelpers();
  const stdout = new StubStream({ mode: 'ok' });
  const stderr = new StubStream({ mode: 'ok' });
  const exit = exitRecorder();
  const { exitAfterWrite, warnNonBlocking } = makeExitHelpers({ stdout, stderr, exit });

  exitAfterWrite('first-payload', 0);
  exitAfterWrite('second-payload-should-be-dropped', 0);

  assert.equal(stdout.writes.length, 1, 'stdout.write must be called exactly once across two exitAfterWrite calls');
  assert.equal(stdout.writes[0], 'first-payload', 'only the first payload reaches stdout');

  const stderrAfterSecond = stderr.writes.join('');
  assert.match(stderrAfterSecond, /second-payload-should/, 'the dropped second payload is disclosed on stderr, carrying a prefix of it');

  warnNonBlocking('warn-one');
  warnNonBlocking('warn-two');
  assert.ok(stderr.writes.some((w) => w.includes('warn-one')), 'first stderr message must not be suppressed');
  assert.ok(stderr.writes.some((w) => w.includes('warn-two')), 'second stderr message must not be suppressed either — stderr is prose, never deduped');
});
// SABOTAGE: drop the `stdoutWritten` guard so a second non-empty
// exitAfterWrite call also calls stream.write() — stdout.writes.length
// becomes 2, and stdout.writes[0] is no longer necessarily 'first-payload'
// depending on write order.

// ---------------------------------------------------------------------------
// (n) stdoutWritten is set BEFORE the write ATTEMPT, not after a successful
// one: a failed attempt may already have emitted a partial JSON prefix, so a
// second envelope must be suppressed even when the first write THREW.
// ---------------------------------------------------------------------------

test('(n) a write that throws still counts as the one stdout envelope: a second exitAfterWrite is suppressed and disclosed, and its requested code is not honoured', async () => {
  const makeExitHelpers = await loadHelpers();
  const stdout = new StubStream({ mode: 'throw' });
  const stderr = new StubStream({ mode: 'ok' });
  const exit = exitRecorder();
  const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });

  exitAfterWrite('first-and-only', 0);
  assert.equal(stdout.writes.length, 1, 'setup: the first payload reached stream.write(), which then threw');
  assert.deepEqual(exit.calls, [1], 'setup: the throwing write with requested code 0 exits 1');

  exitAfterWrite('second', 0);
  assert.equal(
    stdout.writes.length,
    1,
    'stdout.write must NOT be attempted a second time — stdoutWritten is set before the first ATTEMPT, because a failed attempt may already have put a partial JSON prefix on the wire and a second payload would concatenate onto it',
  );
  assert.match(
    stderr.writes.join(''),
    /second/,
    'the suppressed second payload is disclosed on stderr, carrying (a prefix of) the dropped text',
  );
  assert.deepEqual(
    exit.calls,
    [1],
    "a suppressed second payload's requested code is NOT honoured and never raises or lowers the standing exit — the first envelope's exit stands",
  );
});
// SABOTAGE: set `stdoutWritten = true` in the write's SUCCESS path (after the
// callback) instead of before the write attempt — the second exitAfterWrite no
// longer sees an envelope as written, calls stream.write() again, and
// `stdout.writes.length === 1` goes red (reads 2).

// ---------------------------------------------------------------------------
// (o) deny()'s and warnNonBlocking()'s stderr write is BEST-EFFORT: a throwing
// stderr stream must never void the block. Previously a throwing stderr
// propagated out of deny() as an uncaught exception, ending the process with
// exit 1 — turning a BLOCK into a non-blocking exit.
// ---------------------------------------------------------------------------

test('(o) a stderr stream that throws never voids the exit: deny() still exits 2 and warnNonBlocking() still exits 1, with no exception escaping', async () => {
  const makeExitHelpers = await loadHelpers();

  {
    const stdout = new StubStream({ mode: 'ok' });
    const stderr = new StubStream({ mode: 'throw' });
    const exit = exitRecorder();
    const { deny } = makeExitHelpers({ stdout, stderr, exit });
    assert.doesNotThrow(
      () => deny('deny message m'),
      'a failing stderr write must be swallowed — an exception escaping deny() ends the process with exit 1 and turns a block into a non-blocking exit',
    );
    assert.deepEqual(exit.calls, [2], 'deny() still exits 2 after its stderr write failed — fail-closed');
    assert.equal(stderr.writes.length, 1, 'the stderr write was attempted exactly once (it threw)');
  }

  {
    const stdout = new StubStream({ mode: 'ok' });
    const stderr = new StubStream({ mode: 'throw' });
    const exit = exitRecorder();
    const { warnNonBlocking } = makeExitHelpers({ stdout, stderr, exit });
    assert.doesNotThrow(() => warnNonBlocking('advisory w'), 'a failing stderr write must be swallowed by warnNonBlocking too');
    assert.deepEqual(exit.calls, [1], 'warnNonBlocking() with nothing pending still exits 1 after its stderr write failed');
    assert.equal(stderr.writes.length, 1, 'the stderr write was attempted exactly once (it threw)');
  }
});
// SABOTAGE: remove the try/catch around deny()'s (or warnNonBlocking()'s)
// stderr write — the StubStream's thrown Error escapes the call, the
// assert.doesNotThrow goes red, and the exit never happens at all
// (exit.calls stays []).

// ---------------------------------------------------------------------------
// (j) Ordering: exit never fires before the pending callback; onWritten runs
// exactly once, AFTER the callback and BEFORE exit; a failed write never
// runs onWritten; an onWritten that throws still lets exit fire with the
// requested code.
// ---------------------------------------------------------------------------

test('(j) exit never fires before a pending write settles; onWritten runs exactly once, after settle and before exit; a failed write skips onWritten; a throwing onWritten still exits with the requested code', async () => {
  const makeExitHelpers = await loadHelpers();

  // Ordering: onWritten before exit, both after the deferred callback fires.
  {
    const order = [];
    const stdout = new StubStream({ mode: 'deferred' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = (code) => order.push(['exit', code]);
    const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('payload', 0, { onWritten: () => order.push(['onWritten']) });
    assert.deepEqual(order, [], 'exit (and onWritten) must not fire before the pending write callback settles');
    stdout.fireDeferred();
    assert.deepEqual(order, [['onWritten'], ['exit', 0]], 'onWritten must run exactly once, after the write settles and before exit');
  }

  // Failed write: onWritten never runs.
  {
    const stdout = new StubStream({ mode: 'deferred' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    let onWrittenCalled = false;
    const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('payload', 0, {
      onWritten: () => {
        onWrittenCalled = true;
      },
    });
    stdout.fireDeferred(new Error('write failed'));
    assert.equal(onWrittenCalled, false, 'onWritten must never run for a failed write');
    assert.deepEqual(exit.calls, [1], 'the failed write still exits (1 for requested 0)');
  }

  // A throwing onWritten still yields the requested exit code, one stderr line.
  {
    const stdout = new StubStream({ mode: 'ok' });
    const stderr = new StubStream({ mode: 'ok' });
    const exit = exitRecorder();
    const { exitAfterWrite } = makeExitHelpers({ stdout, stderr, exit });
    exitAfterWrite('payload', 0, {
      onWritten: () => {
        throw new Error('onWritten boom');
      },
    });
    assert.deepEqual(exit.calls, [0], 'a throwing onWritten must not change the requested exit code');
    assert.equal(stderr.writes.length, 1, 'exactly one stderr line reports the onWritten failure');
  }
});
// SABOTAGE (ordering): call exit() from inside the write callback BEFORE
// invoking onWritten (swap the two statements) — order becomes
// [['exit', 0]] with onWritten never recorded, or recorded after 'exit',
// and the deepEqual assertion goes red.
// SABOTAGE (failed-write skip): call onWritten unconditionally regardless of
// the settle error — onWrittenCalled becomes true on the failed-write arm.
// SABOTAGE (throw survives): remove the try/catch around the onWritten()
// call — the thrown Error propagates out of exitAfterWrite uncaught and the
// test errors instead of asserting exit.calls === [0].

// ---------------------------------------------------------------------------
// (k) h19 ENQUEUE mode (rung=prompt/default) keeps its guard bookkeeping
// without a stream callback — there is no stdout write in that path at all.
// Already pinned: scripts/tests/h19-delivery.test.mjs:151-168 ("guard: same
// file and same-article new file stay silent; a NEW owning article
// re-arms") drives h19-knowledge-delivery.mjs through a real enqueue and
// asserts the guard converges (no re-delivery for an already-seen file/
// article, and a genuinely new owning article re-arms) — this IS "the guard
// bookkeeping updates right after a successful enqueuePending, with no
// stream callback in the picture", exercised end-to-end. Not duplicated
// here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (l) h20-mechanism-axis spawned with a closed stdout must never exit 0 for
// a consult that would otherwise produce an envelope.
// ---------------------------------------------------------------------------

test('(l) CONTROL: the same h20 codex consult with stdout OPEN exits 0 and emits one updatedInput envelope carrying the model pin; PIN: with the stdout read end destroyed it exits non-zero, naming its own stdout failure and never crashing unhandled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-closed-stdout-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(
      join(dir, '.sterling', 'config.json'),
      JSON.stringify({ sparring_partner: { enabled: true, model: 'gpt-5.6-sol' } }),
    );
    // An empty store is sufficient: the sparring_partner.model pin alone
    // makes h20 emit an updatedInput envelope even with no knowledge records
    // seeded (fixture shape per scripts/tests/h20-consult-model-injection.test.mjs
    // M-C0/M-6 — the model pin line is always emitted for a codex consult).
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    store.close();

    const h20 = join(HOOKS, 'h20-mechanism-axis.mjs');
    const HOOK_INPUT = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__codex__codex',
      tool_input: { prompt: 'x' },
      cwd: dir,
    });

    // --- CONTROL, first: with stdout OPEN this exact fixture produces an
    // envelope and exits 0. Without it, the PIN below has more than one
    // possible cause — "this fixture denies/errors whatever stdout does" would
    // satisfy `notEqual(code, 0)` identically, and so would any unrelated
    // crash. The control forces the green to carry its evidence: the ONLY
    // difference between the two arms is the destroyed read end.
    {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', h20], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: dir,
      });
      child.stdin.end(HOOK_INPUT);
      const { code, stdout, stderr } = await collectExit(child);
      assert.equal(
        code,
        0,
        `CONTROL: with stdout open, an envelope-producing codex consult must exit 0 — got ${code}; stderr: ${stderr.slice(0, 300)}`,
      );
      const text = stdout.toString('utf8').trim();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        assert.fail(`CONTROL: stdout must be exactly ONE JSON object — parse failed (${err.message}); stdout: ${text.slice(0, 300)}`);
      }
      assert.equal(typeof parsed, 'object', 'CONTROL: the envelope is a JSON object');
      assert.ok(
        parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedInput,
        `CONTROL: the envelope carries hookSpecificOutput.updatedInput — got ${text.slice(0, 300)}`,
      );
      assert.match(
        JSON.stringify(parsed.hookSpecificOutput.updatedInput),
        /gpt-5\.6-sol/,
        'CONTROL: the updatedInput carries the sparring_partner.model pin from the fixture config — this is the payload the PIN arm must never silently lose',
      );
    }

    // --- PIN: identical spawn, read end destroyed before the child writes.
    {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', h20], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: dir,
      });
      child.stdout.destroy();
      child.stdin.end(HOOK_INPUT);
      let stderr = '';
      child.stderr.on('data', (c) => {
        stderr += c.toString('utf8');
      });
      const [code] = await once(child, 'exit');
      assert.notEqual(
        code,
        0,
        `a codex-consult envelope that fails to deliver (stdout destroyed) must never exit 0 — got exit ${code}; stderr: ${stderr.slice(0, 300)}`,
      );
      // ... and non-zero for the RIGHT reason: the helper's own disclosure of a
      // failed stdout hand-off, not an unrelated crash that happens to be
      // non-zero too.
      assert.match(stderr, /stdout/i, `the failure disclosed on stderr names stdout as the failing stream — stderr: ${stderr.slice(0, 400)}`);
      assert.match(stderr, /EPIPE/, `the failure disclosed on stderr names the EPIPE error code — stderr: ${stderr.slice(0, 400)}`);
      assert.doesNotMatch(stderr, /Unhandled 'error'/, "a destroyed read end must not surface as an unhandled 'error' event crash");
      assert.doesNotMatch(stderr, /ERR_UNHANDLED_ERROR/, 'no unhandled-error crash text');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE (PIN): revert h20's emitEnvelope call site to swallow a stdout write
// failure and exit 0 anyway (the pre-migration shape the record calls out:
// "the catch path that exited 0 to keep the model pin exits 1 when the
// ENVELOPE write itself fails") — the PIN arm's notEqual(code, 0) goes red
// while the CONTROL stays green, which is what identifies the cause.
// SABOTAGE (CONTROL): drop the model pin from h20's updatedInput, or emit two
// JSON objects on stdout instead of one — the CONTROL's /gpt-5\.6-sol/ match
// or its single-object JSON.parse goes red, proving the fixture really does
// produce a deliverable envelope rather than nothing at all.
