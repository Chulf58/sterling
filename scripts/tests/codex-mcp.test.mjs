// SPARRING-PARTNER slice 1 — scripts/lib/codex-mcp.mjs
// (decision cd019e0b, sparring-partner-partnership-shape)
//
// Under test, per the declared interface slice only (no implementation read):
//   probeCodex({spawnFn, timeoutMs, env}) -> probe result
//     semantics: spawn error = binary absent; non-zero exit = not logged in;
//     success = wire-eligible.
//   CODEX_MCP_ENTRY = {command:'codex', args:['mcp-server']} exactly.
//   withCodexEntry(mcpServers, probeResult) — pure: adds a 'codex' key beside
//     existing entries on probe success, unchanged (no codex key) on failure;
//     never mutates its input.
//   codexSkipLine(reason) — a line starting 'codex mcp: skipped — ' with an
//     actionable reason distinguishing binary-absent from not-logged-in.
//
// probeCodex's OWN return shape is not part of the declared interface (only
// its semantics and how it composes with withCodexEntry are), so these tests
// deliberately never assert on probeResult's internal fields — they pipe it
// straight into withCodexEntry, which is the documented consumer, and assert
// on withCodexEntry's OWN observable output. This tests the real end-to-end
// contract (probe -> merged servers) without inventing an internal shape.
//
// SCOPED EXCEPTION as of decision ffe7c416 (host-native init, user-decided
// 2026-08-27): probeCodexWin's `command` field IS now part of the declared
// interface — defect (2) of that ruling is precisely that the resolved
// absolute path was being discarded, so "the path survives the probe" is an
// acceptance criterion and cannot be tested through withCodexEntry alone. The
// exception is narrow: it covers probeCodexWin's `ok`/`command`/`reason`
// fields only. It does NOT license exact-shape deepEquals on a probe result —
// see the Part D preamble below for why those were removed.
//
// spawnFn is modeled on node:child_process's spawnSync return convention
// (the one every other spawn wrapper in this repo already uses — see
// scripts/tests/init-ensure.test.mjs's runHook/init helpers): {error, status}.
// A fake spawnFn never spawns a real process and never depends on whether a
// real `codex` binary is installed or logged in on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeCodex, CODEX_MCP_ENTRY, withCodexEntry, codexSkipLine, probeCodexWin } from '../lib/codex-mcp.mjs';

function spawnErrorFn() {
  // mirrors a real spawnSync's return on ENOENT: no status, an .error set
  return { error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), status: null };
}
function nonZeroExitFn() {
  return { error: undefined, status: 1 };
}
function successExitFn() {
  return { error: undefined, status: 0 };
}

test('CODEX_MCP_ENTRY is exactly {command: "codex", args: ["mcp-server"]}', () => {
  assert.deepEqual(CODEX_MCP_ENTRY, { command: 'codex', args: ['mcp-server'] });
});

test('probeCodex: calls the injected spawnFn — never a real spawn, never depends on machine state', () => {
  let calls = 0;
  probeCodex({
    spawnFn: (...args) => {
      calls += 1;
      return successExitFn();
    },
    timeoutMs: 2000,
    env: {},
  });
  assert.equal(calls, 1, 'probeCodex invokes the injected spawnFn exactly once instead of a real child_process spawn');
});

test('probeCodex -> withCodexEntry: spawn error (binary absent) leaves mcpServers unchanged, existing entries preserved', () => {
  const original = Object.freeze({ sterling: Object.freeze({ command: 'node', args: ['main.js'] }) });
  const probeResult = probeCodex({ spawnFn: spawnErrorFn, timeoutMs: 2000, env: {} });
  const result = withCodexEntry(original, probeResult);
  assert.ok(!('codex' in result), 'no codex key added when the probe reports a spawn error (binary absent)');
  assert.deepEqual(result.sterling, { command: 'node', args: ['main.js'] }, 'existing sterling entry preserved');
});

test('probeCodex -> withCodexEntry: non-zero exit (not logged in) leaves mcpServers unchanged', () => {
  const original = Object.freeze({ sterling: Object.freeze({ command: 'node', args: ['main.js'] }) });
  const probeResult = probeCodex({ spawnFn: nonZeroExitFn, timeoutMs: 2000, env: {} });
  const result = withCodexEntry(original, probeResult);
  assert.ok(!('codex' in result), 'no codex key added when the probe reports a non-zero exit (not logged in)');
  assert.deepEqual(result.sterling, { command: 'node', args: ['main.js'] }, 'existing sterling entry preserved');
});

test('probeCodex -> withCodexEntry: successful probe (wire-eligible) adds codex beside existing entries', () => {
  const original = Object.freeze({ sterling: Object.freeze({ command: 'node', args: ['main.js'] }) });
  const probeResult = probeCodex({ spawnFn: successExitFn, timeoutMs: 2000, env: {} });
  const result = withCodexEntry(original, probeResult);
  assert.deepEqual(result.codex, CODEX_MCP_ENTRY, 'codex entry matches CODEX_MCP_ENTRY exactly on probe success');
  assert.deepEqual(result.sterling, { command: 'node', args: ['main.js'] }, 'existing sterling entry preserved beside codex');
});

test('withCodexEntry: never mutates its input — a frozen mcpServers object survives a successful probe untouched', () => {
  const original = Object.freeze({ sterling: Object.freeze({ command: 'node', args: ['main.js'] }) });
  const probeResult = probeCodex({ spawnFn: successExitFn, timeoutMs: 2000, env: {} });
  // a mutating implementation on a frozen object throws in strict ESM — the
  // call completing at all is part of the "never mutates" assertion.
  assert.doesNotThrow(() => withCodexEntry(original, probeResult), 'withCodexEntry does not attempt to write to its frozen input');
  assert.deepEqual(original, { sterling: { command: 'node', args: ['main.js'] } }, 'input object unchanged after the call');
});

test('withCodexEntry: empty mcpServers + successful probe yields ONLY the codex key', () => {
  const probeResult = probeCodex({ spawnFn: successExitFn, timeoutMs: 2000, env: {} });
  const result = withCodexEntry({}, probeResult);
  assert.deepEqual(result, { codex: CODEX_MCP_ENTRY }, 'an empty input plus a successful probe adds exactly one entry');
});

test('withCodexEntry: empty mcpServers + failed probe stays empty', () => {
  const probeResult = probeCodex({ spawnFn: spawnErrorFn, timeoutMs: 2000, env: {} });
  const result = withCodexEntry({}, probeResult);
  assert.deepEqual(result, {}, 'an empty input plus a failed probe adds nothing');
});

test('codexSkipLine: starts with the fixed "codex mcp: skipped — " prefix', () => {
  assert.match(codexSkipLine('binary-absent'), /^codex mcp: skipped — /);
  assert.match(codexSkipLine('not-logged-in'), /^codex mcp: skipped — /);
});

test('codexSkipLine: distinguishes binary-absent from not-logged-in with an actionable reason beyond the bare prefix', () => {
  const absentLine = codexSkipLine('binary-absent');
  const loginLine = codexSkipLine('not-logged-in');
  const prefix = 'codex mcp: skipped — ';
  assert.notEqual(absentLine, loginLine, 'the two reasons produce distinguishable skip lines');
  assert.ok(absentLine.length > prefix.length, 'binary-absent line carries content beyond the bare prefix (actionable)');
  assert.ok(loginLine.length > prefix.length, 'not-logged-in line carries content beyond the bare prefix (actionable)');
});

// =============================================================================
// Review addendum (mechanical blind spot 2, spec-only — probeCodex's implementation
// was NOT read to author these): TIMEOUT DISCRIMINATION.
//
// A real spawnSync on the probe's own timeoutMs expiry returns BOTH .error (code
// 'ETIMEDOUT') AND .signal ('SIGTERM') set — unlike a plain ENOENT (spawnErrorFn
// above), which sets .error with NO .signal. A probe that classifies "any .error"
// as binary-absent misreports a timeout (codex present but slow/hung, or a
// misbehaving sandbox) as "binary not installed" — a materially wrong skip reason
// for the user to act on. The fix under test discriminates a timeout into its own
// reason so codexSkipLine can report it distinctly.
//
// Unlike the header note above (probeResult's shape is otherwise not asserted),
// this addendum's whole acceptance criterion IS discriminating the reason value,
// so it is asserted directly here — that is the observable behavior this review
// exists to pin.
// =============================================================================

function spawnTimeoutFn() {
  // mirrors a real spawnSync's return when the child is killed after exceeding
  // options.timeout: BOTH .error (code ETIMEDOUT) AND .signal (SIGTERM) are set.
  // This is the discriminator vs spawnErrorFn's plain ENOENT (.error, no .signal).
  return { error: Object.assign(new Error('spawn codex ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null };
}

test('probeCodex: a spawnSync-shaped timeout (error ETIMEDOUT + signal SIGTERM) yields reason "timeout", not "binary-absent"', () => {
  const probeResult = probeCodex({ spawnFn: spawnTimeoutFn, timeoutMs: 2000, env: {} });
  assert.equal(probeResult.reason, 'timeout', 'a timed-out probe (error + signal set together) must report reason "timeout"');
  assert.notEqual(probeResult.reason, 'binary-absent', 'a timeout must NOT be misclassified as binary-absent merely because .error happens to be set');
});

test('probeCodex: the existing plain-ENOENT fake (error set, NO signal) is unaffected — still classified "binary-absent"', () => {
  const probeResult = probeCodex({ spawnFn: spawnErrorFn, timeoutMs: 2000, env: {} });
  assert.equal(probeResult.reason, 'binary-absent', 'a plain spawn error with no signal remains binary-absent (regression guard on the existing fake)');
});

test('probeCodex -> withCodexEntry: a timeout result leaves mcpServers unchanged, same as any other failed probe', () => {
  const original = Object.freeze({ sterling: Object.freeze({ command: 'node', args: ['main.js'] }) });
  const probeResult = probeCodex({ spawnFn: spawnTimeoutFn, timeoutMs: 2000, env: {} });
  const result = withCodexEntry(original, probeResult);
  assert.ok(!('codex' in result), 'no codex key added when the probe times out');
  assert.deepEqual(result.sterling, { command: 'node', args: ['main.js'] }, 'existing sterling entry preserved');
});

test('codexSkipLine("timeout") starts with the fixed prefix and is distinguishable from both other reason lines', () => {
  const prefix = 'codex mcp: skipped — ';
  const timeoutLine = codexSkipLine('timeout');
  const absentLine = codexSkipLine('binary-absent');
  const loginLine = codexSkipLine('not-logged-in');
  assert.match(timeoutLine, /^codex mcp: skipped — /, 'timeout skip line carries the fixed prefix');
  assert.ok(timeoutLine.length > prefix.length, 'timeout skip line carries content beyond the bare prefix (actionable)');
  assert.notEqual(timeoutLine, absentLine, 'timeout line is distinguishable from the binary-absent line');
  assert.notEqual(timeoutLine, loginLine, 'timeout line is distinguishable from the not-logged-in line');
});

// =============================================================================
// Native-Windows probe — probeCodexWin({spawnFn, timeoutMs, env}) (board 43051819,
// article sparring-partner, dispatch spec only — scripts/lib/codex-mcp.mjs's
// implementation was NOT read to author these; it landed before its tests
// because H5 correctly denied the implementing agent test-file writes).
//
// DECLARED CONTRACT under test:
//   - {ok:true, command:<the resolved ABSOLUTE path>} on success, or
//     {ok:false, reason} with reason ∈ {binary-absent, not-logged-in, timeout}
//     and NO command, on every failure.
//
//     AMENDED by decision ffe7c416 (host-native init, user-decided 2026-08-27).
//     Two pins in this section previously asserted `deepEqual(result, {ok:true})`
//     — an EXACT-SHAPE check that forbids the resolved path surviving, which is
//     exactly the defect the ruling orders closed: ffe7c416 defect (2) records
//     that CODEX_MCP_ENTRY hardcoded a bare `codex` and threw away the path
//     where.exe had just resolved, so a successful probe did NOT prove the
//     written entry would spawn (npm installs codex as codex.cmd, hostile to
//     shell-less spawning, and research_finding 0c712d94 measured PATH to be an
//     unreliable presence oracle on the very host this must work on). Those two
//     deepEquals are now `assert.equal(result.ok, true)` PLUS a POSITIVE
//     assertion on result.command. The exact-shape discipline is not simply
//     dropped: the CONTROL ARM immediately below pins command === undefined on
//     every failure path, so "attach the path on success" cannot be satisfied by
//     an implementation that blanket-attaches a command to everything.
//   - resolves the binary via spawnFn('where.exe', ['codex'], ...) — reaching
//     the WINDOWS PATH through WSL interop — deliberately NOT spawnSync('codex')
//     directly, which would resolve under WSL's OWN PATH instead.
//   - runs '<resolved> login status' through the SAME injected spawnFn.
//   - env.STERLING_CODEX_WIN_PATH: KEY-PRESENCE (not truthiness) bypasses the
//     where.exe detection — defined-even-if-empty bypasses; '' specifically
//     forces binary-absent (nothing to run login status against).
//
// spawnFn stub convention: dispatches on the first argument, mirroring
// probeCodex's fakes above and node:child_process's spawnSync return shape
// ({error, status[, signal, stdout]}). Never spawns a real process, never
// depends on whether a real `codex` binary is installed/logged-in on this
// machine — determinism holds on every OS this suite runs on, including WSL
// where no real where.exe resolution would ever succeed for a Windows path.
// =============================================================================

const WIN_CODEX_PATH = 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd';

function winWhereOkThenFn(loginResult) {
  return (cmd) => {
    if (cmd === 'where.exe') return { error: undefined, status: 0, stdout: WIN_CODEX_PATH + '\r\n' };
    if (cmd === WIN_CODEX_PATH) return loginResult;
    throw new Error(`unexpected spawnFn call for cmd ${cmd} — only 'where.exe' then the resolved path are expected`);
  };
}

function winTimeoutResult(what) {
  // spawnSync's shape when the child is killed on options.timeout: BOTH .error
  // (ETIMEDOUT) and .signal (SIGTERM). The discriminator vs a plain ENOENT.
  return { error: Object.assign(new Error(`spawn ${what} ETIMEDOUT`), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null };
}

// Every way probeCodexWin can fail, as a table — the CONTROL ARM's fixture set.
const WIN_FAILURE_CASES = [
  {
    name: 'where.exe non-zero exit (codex not on the Windows PATH)',
    env: {},
    reason: 'binary-absent',
    spawnFn: (cmd) => (cmd === 'where.exe' ? { error: undefined, status: 1, stdout: '' } : { error: undefined, status: 0 }),
  },
  {
    name: 'where.exe itself unreachable (ENOENT — no WSL interop)',
    env: {},
    reason: 'binary-absent',
    spawnFn: (cmd) => (cmd === 'where.exe'
      ? { error: Object.assign(new Error('spawn where.exe ENOENT'), { code: 'ENOENT' }), status: null }
      : { error: undefined, status: 0 }),
  },
  {
    // BOUNDARY THE DISPATCH SPEC DID NOT NAME. `where.exe` can exit 0 having
    // printed nothing useful; an implementation that gates on `status === 0`
    // alone then reports SUCCESS carrying an EMPTY command, which is strictly
    // worse than the bare-'codex' defect ffe7c416 closes — it writes an MCP
    // entry with no command at all. Classified binary-absent because nothing
    // was resolved; the ok:false and command:undefined assertions are the
    // load-bearing half, the reason value is this suite's oracle call.
    name: 'where.exe exits 0 but resolves NOTHING (whitespace-only stdout)',
    env: {},
    reason: 'binary-absent',
    spawnFn: (cmd) => (cmd === 'where.exe' ? { error: undefined, status: 0, stdout: '  \r\n' } : { error: undefined, status: 0 }),
  },
  {
    name: 'resolution step times out',
    env: {},
    reason: 'timeout',
    spawnFn: (cmd) => (cmd === 'where.exe' ? winTimeoutResult('where.exe') : { error: undefined, status: 0 }),
  },
  {
    name: 'login status exits non-zero (not logged in)',
    env: {},
    reason: 'not-logged-in',
    spawnFn: winWhereOkThenFn({ error: undefined, status: 1 }),
  },
  {
    name: 'login status times out',
    env: {},
    reason: 'timeout',
    spawnFn: winWhereOkThenFn(winTimeoutResult('codex')),
  },
  {
    name: 'STERLING_CODEX_WIN_PATH defined-but-EMPTY (nothing to run login status against)',
    env: { STERLING_CODEX_WIN_PATH: '' },
    reason: 'binary-absent',
    spawnFn: () => { throw new Error('an empty forced path must never spawn anything'); },
  },
];

test('CONTROL ARM (ffe7c416 command carriage): EVERY probeCodexWin failure path carries NO command — ok:false and command === undefined', () => {
  // PLACED FIRST, AND IT MUST PASS FOR THE OPPOSITE REASON to the two success
  // pins below. "result.command === the resolved path on success" has more than
  // one possible cause: a correct implementation that carries the resolution
  // forward, OR a blanket one that stamps a command onto every result it
  // returns (e.g. always setting `command: forced ?? resolved ?? 'codex'`).
  // Those two are indistinguishable from the success side alone — the second
  // would wire a bogus MCP entry off a FAILED probe, which is worse than the
  // bare-'codex' defect ffe7c416 exists to close, and it would read as a fully
  // green suite. This arm is what tells them apart: it is green only when the
  // command is attached BECAUSE the probe succeeded.
  for (const c of WIN_FAILURE_CASES) {
    const result = probeCodexWin({ spawnFn: c.spawnFn, timeoutMs: 2000, env: c.env });
    assert.equal(result.ok, false, `${c.name}: probe reports failure`);
    assert.equal(result.reason, c.reason, `${c.name}: the discriminating reason survives`);
    assert.equal(result.command, undefined, `${c.name}: a FAILED probe resolves NO usable command — an entry must never be wired from it`);
  }
});
// SABOTAGE: attach the command unconditionally rather than only on the success
// branch (e.g. build the result object as `{ok, reason, command: forcedOrResolved}`
// for every return) — the `result.command === undefined` assertion goes red on
// the failure cases that DID resolve something (the empty-forced-path case and
// the not-logged-in case, whose where.exe step succeeded before login failed).
// SECOND SABOTAGE (the one this arm is really for): return
// `{ok:false, reason, command:'codex'}` as a "safe default" — every success pin
// below stays green, and only this arm goes red.

test('probeCodexWin: resolves via spawnFn("where.exe", ["codex"], ...) — the WINDOWS PATH through WSL interop — then runs "<resolved> login status" through the same injected spawnFn; both steps succeeding yields ok:true CARRYING the resolved path', () => {
  // CONTROL ARM for the STERLING_CODEX_WIN_PATH bypass tests below: this proves
  // where.exe DOES get called and login status DOES get attempted (and DOES
  // reach {ok:true}) when no override is set — so a bypass test's "where.exe
  // never called" assertion means the SEAM did it, not a general omission bug
  // that never calls where.exe at all.
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'where.exe') return { error: undefined, status: 0, stdout: WIN_CODEX_PATH + '\r\n' };
    if (cmd === WIN_CODEX_PATH) return { error: undefined, status: 0 };
    throw new Error(`unexpected spawnFn call for cmd ${cmd}`);
  };
  const result = probeCodexWin({ spawnFn, timeoutMs: 2000, env: {} });
  assert.equal(calls.length, 2, 'exactly two spawnFn calls — resolve, then login status');
  assert.deepEqual(calls[0], { cmd: 'where.exe', args: ['codex'] }, 'first call resolves via where.exe, NOT spawnSync("codex") directly (which would resolve under WSL\'s own PATH)');
  assert.deepEqual(calls[1], { cmd: WIN_CODEX_PATH, args: ['login', 'status'] }, 'second call runs "<resolved> login status" on the path where.exe returned');
  assert.equal(result.ok, true, 'both steps succeeding yields ok:true');
  assert.equal(
    result.command,
    WIN_CODEX_PATH,
    'the probe CARRIES the path where.exe resolved (decision ffe7c416 defect 2): a probe that proves an absolute executable spawns, then hands back nothing but ok:true, forces the caller onto a bare "codex" that is NOT known to spawn — the exact gap that left codex-on-Windows broken after a SUCCESSFUL probe'
  );
});
// SABOTAGE: call spawnFn('codex', ...) directly instead of resolving through
// where.exe first — calls[0].cmd would be 'codex', not 'where.exe', and the
// deepEqual on calls[0] goes red.
// SABOTAGE (ffe7c416 defect 2, the pin's own subject): return a bare `{ok:true}`
// from the success branch, dropping the resolved path — the
// `result.command === WIN_CODEX_PATH` assertion goes red while every other
// assertion in this test stays green, so the failure names the defect exactly.
// WHICH GUARD CARRIES THE VERDICT: the success branch's own construction of the
// result object. Nothing else in probeCodexWin defends this — there is no
// second layer here, so a single-guard mutation IS the whole story (contrast
// init-ensure win case 6, where isManagedCodexAddWin is one of several).

test('probeCodexWin: where.exe non-zero exit (codex not on the Windows PATH) -> {ok:false, reason:"binary-absent"}, login-status never invoked', () => {
  let loginCalled = false;
  const spawnFn = (cmd) => {
    if (cmd === 'where.exe') return { error: undefined, status: 1, stdout: '' };
    loginCalled = true;
    return { error: undefined, status: 0 };
  };
  const result = probeCodexWin({ spawnFn, timeoutMs: 2000, env: {} });
  assert.deepEqual(result, { ok: false, reason: 'binary-absent' });
  assert.equal(loginCalled, false, 'a where.exe miss short-circuits before ever attempting login status');
});
// SABOTAGE: treat where.exe's non-zero exit as success (proceed to call login
// status anyway) — loginCalled flips true and that assertion goes red; or
// misclassify the reason as 'not-logged-in' — the deepEqual on result goes red.

test('probeCodexWin: where.exe spawn error (ENOENT — where.exe itself unreachable) -> {ok:false, reason:"binary-absent"}', () => {
  const spawnFn = (cmd) => {
    if (cmd === 'where.exe') return { error: Object.assign(new Error('spawn where.exe ENOENT'), { code: 'ENOENT' }), status: null };
    throw new Error('login status must never be attempted when where.exe itself cannot spawn');
  };
  const result = probeCodexWin({ spawnFn, timeoutMs: 2000, env: {} });
  assert.deepEqual(result, { ok: false, reason: 'binary-absent' });
});
// SABOTAGE: classify only `status !== 0` as binary-absent and leave a set
// `.error` (no status at all, ENOENT-shaped) unhandled — the call either
// throws instead of returning a probe result, or returns a reason other than
// 'binary-absent', and the deepEqual goes red either way.

test('probeCodexWin: where.exe resolves, login status exits non-zero -> {ok:false, reason:"not-logged-in"}', () => {
  const result = probeCodexWin({ spawnFn: winWhereOkThenFn({ error: undefined, status: 1 }), timeoutMs: 2000, env: {} });
  assert.deepEqual(result, { ok: false, reason: 'not-logged-in' });
});
// SABOTAGE: classify any login-status non-zero exit as 'binary-absent' (reuse
// the where.exe-miss branch instead of a distinct not-logged-in branch) — the
// deepEqual goes red on the reason value.

test('probeCodexWin: login-status spawnSync-shaped timeout (error ETIMEDOUT + signal SIGTERM) -> reason "timeout", never "not-logged-in" or "binary-absent"', () => {
  const timeoutResult = { error: Object.assign(new Error('spawn codex ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null };
  const result = probeCodexWin({ spawnFn: winWhereOkThenFn(timeoutResult), timeoutMs: 2000, env: {} });
  assert.equal(result.reason, 'timeout', 'a timed-out login-status step (error + signal set together) must report reason "timeout"');
  assert.notEqual(result.reason, 'not-logged-in', 'must not be misclassified as not-logged-in merely because the exit was non-success-shaped');
  assert.notEqual(result.reason, 'binary-absent', 'must not be misclassified as binary-absent merely because .error happens to be set');
});
// SABOTAGE: classify "any .error set" on the login-status step as binary-absent
// or not-logged-in without checking .signal first (same bug class as
// probeCodex's own timeout-discrimination review addendum above) — a hung or
// slow codex login-status call would then misreport under the wrong reason.

test('probeCodexWin: where.exe-resolution spawnSync-shaped timeout (error ETIMEDOUT + signal SIGTERM) -> reason "timeout", login-status never attempted', () => {
  let loginCalled = false;
  const spawnFn = (cmd) => {
    if (cmd === 'where.exe') return { error: Object.assign(new Error('spawn where.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM', status: null };
    loginCalled = true;
    return { error: undefined, status: 0 };
  };
  const result = probeCodexWin({ spawnFn, timeoutMs: 2000, env: {} });
  assert.equal(result.reason, 'timeout');
  assert.equal(loginCalled, false, 'a timed-out resolution step never proceeds to login status');
});
// SABOTAGE: treat a timed-out where.exe call identically to a plain miss
// (reason 'binary-absent') — the result.reason assertion goes red.

// ---- two resolution boundaries the dispatch spec did not name --------------
// Both are Windows-specific properties of `where.exe` output, and both produce
// a probe that reports SUCCESS while carrying a command that cannot spawn —
// the exact failure mode ffe7c416 defect (2) exists to close, reached by a
// different route than the one the ruling documents.

test('probeCodexWin: where.exe exits 0 but resolves NOTHING (empty / whitespace-only stdout) -> ok:false, reason "binary-absent", NO command — never a success carrying an empty command string', () => {
  for (const stdout of ['', '\r\n', '   \r\n  ']) {
    let loginCalled = false;
    const spawnFn = (cmd) => {
      if (cmd === 'where.exe') return { error: undefined, status: 0, stdout };
      loginCalled = true;
      return { error: undefined, status: 0 };
    };
    const result = probeCodexWin({ spawnFn, timeoutMs: 2000, env: {} });
    assert.equal(result.ok, false, `stdout ${JSON.stringify(stdout)}: nothing was resolved, so the probe must FAIL — a status-0-only gate reports success here`);
    assert.equal(result.reason, 'binary-absent', `stdout ${JSON.stringify(stdout)}: nothing on the Windows PATH matched, which is binary-absent`);
    assert.equal(result.command, undefined, `stdout ${JSON.stringify(stdout)}: no command is carried — an empty-string command would be written straight into the MCP config and never start a server`);
    assert.equal(loginCalled, false, `stdout ${JSON.stringify(stdout)}: nothing was resolved, so there is no path to run "login status" against`);
  }
});
// SABOTAGE: gate resolution on `status === 0` alone (ignore whether stdout
// actually held a path) — the probe proceeds to spawn '' for login status,
// loginCalled flips true and result.ok becomes true, so three of the four
// assertions go red on the very first fixture.
// WHICH GUARD CARRIES THE VERDICT: the emptiness check on where.exe's stdout,
// after the exit-status check. There is no second layer — the status check
// alone cannot see this case, which is the whole point of the pin.

test('probeCodexWin: where.exe returning SEVERAL matches resolves the FIRST line only — a multi-line blob is not a spawnable command', () => {
  // Real `where.exe codex` prints one line PER match, and an npm-global codex
  // installs as BOTH an extensionless shim and codex.cmd, so multi-line output
  // is the ordinary case on the target host, not an exotic one. An
  // implementation that trims the whole stdout instead of taking a line hands
  // back "C:\\...\\codex.cmd\r\nC:\\...\\codex" as a command.
  //
  // FIXTURE ORDERING IS DELIBERATE: the .cmd is FIRST, so this pin stays green
  // under BOTH defensible policies (take the first match, or prefer the .cmd)
  // and goes red only for the ones that are actually broken — take the last
  // match, or keep the whole blob. The pin is about spawnability, not about
  // adjudicating a preference the ruling never stated.
  const WIN_CODEX_SHIM = 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex';
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'where.exe') return { error: undefined, status: 0, stdout: `${WIN_CODEX_PATH}\r\n${WIN_CODEX_SHIM}\r\n` };
    if (cmd === WIN_CODEX_PATH) return { error: undefined, status: 0 };
    throw new Error(`unexpected spawnFn call for cmd ${JSON.stringify(cmd)} — only the first where.exe match is a spawnable candidate`);
  };
  const result = probeCodexWin({ spawnFn, timeoutMs: 2000, env: {} });
  assert.equal(result.ok, true, 'a multi-match resolution is still a successful resolution');
  assert.equal(result.command, WIN_CODEX_PATH, 'exactly the first match is carried — not the last, and not both joined');
  assert.ok(!/[\r\n]/.test(result.command), 'no line terminator survives into the command: a command containing a newline cannot be spawned, and would be written verbatim into the generated MCP config');
  assert.deepEqual(calls[1], { cmd: WIN_CODEX_PATH, args: ['login', 'status'] }, 'and login status was verified against THAT candidate — the probe proves the command it carries, rather than proving one path and reporting another');
});
// SABOTAGE: resolve with `stdout.trim()` over the whole buffer instead of its
// first line — result.command becomes the two paths joined by CRLF, so the
// equality, the no-newline guard and the calls[1] deepEqual all go red (the
// fake's throw fires first in practice, which is itself the signal that the
// resolved command was never spawnable).
// SABOTAGE (subtler): take the LAST line (e.g. filter(Boolean).pop()) —
// result.command becomes the extensionless shim; the fake throws on the
// unexpected login-status target and the command equality goes red.

test('probeCodexWin: STERLING_CODEX_WIN_PATH set (non-empty) bypasses where.exe detection entirely — login status runs directly against the given path', () => {
  const FORCED_PATH = 'C:\\forced\\codex.exe';
  let whereCalled = false;
  const spawnFn = (cmd) => {
    if (cmd === 'where.exe') {
      whereCalled = true;
      return { error: undefined, status: 0, stdout: WIN_CODEX_PATH };
    }
    if (cmd === FORCED_PATH) return { error: undefined, status: 0 };
    throw new Error(`unexpected spawnFn call for cmd ${cmd}`);
  };
  const result = probeCodexWin({ spawnFn, timeoutMs: 2000, env: { STERLING_CODEX_WIN_PATH: FORCED_PATH } });
  assert.equal(whereCalled, false, 'where.exe is never invoked once STERLING_CODEX_WIN_PATH is defined — even the plain-path case bypasses detection (see the control-arm test above, where where.exe IS called with no override)');
  assert.equal(result.ok, true, 'login status against the forced path succeeds');
  assert.equal(
    result.command,
    FORCED_PATH,
    'the FORCED path is what the probe carries forward — not the where.exe fixture path, not a bare "codex" (decision ffe7c416 defect 2). This is also what makes STERLING_CODEX_WIN_PATH a usable command seam for init-ensure.test.mjs, which drives the end-to-end wiring through it'
  );
  assert.notEqual(result.command, WIN_CODEX_PATH, 'the seam wins over detection — the where.exe fixture path never leaks into a forced-path result');
});
// SABOTAGE: read STERLING_CODEX_WIN_PATH but still call where.exe first as a
// sanity check before honoring it — whereCalled flips true and that assertion
// goes red.
// SABOTAGE (command carriage): on the forced-path branch, return `{ok:true}`
// without the command, or return the where.exe-detected path instead of the
// forced one — the `result.command === FORCED_PATH` assertion goes red, and the
// notEqual guard catches specifically the "seam honored for detection but the
// detected path still wins the result" mix-up.

test('probeCodexWin: STERLING_CODEX_WIN_PATH set to the EMPTY STRING forces binary-absent — defined-even-if-empty still bypasses where.exe, but an empty path has nothing to run login status against', () => {
  let anySpawnCalled = false;
  const spawnFn = () => {
    anySpawnCalled = true;
    return { error: undefined, status: 0 };
  };
  const result = probeCodexWin({ spawnFn, timeoutMs: 2000, env: { STERLING_CODEX_WIN_PATH: '' } });
  assert.deepEqual(result, { ok: false, reason: 'binary-absent' });
  assert.equal(anySpawnCalled, false, 'an empty forced path never spawns anything — neither where.exe nor a login-status attempt against an empty command');
});
// SABOTAGE: check `env.STERLING_CODEX_WIN_PATH` by TRUTHINESS instead of KEY
// PRESENCE (e.g. `if (env.STERLING_CODEX_WIN_PATH)`) — an empty string is
// falsy, so this falls through to the real where.exe path; spawnFn here has no
// where.exe branch, so the call throws instead of returning {ok:false,
// reason:'binary-absent'}, and/or anySpawnCalled flips true — either way this
// pin goes red, which is exactly how it catches the truthiness-vs-presence bug.

// =============================================================================
// Part E (decision ffe7c416, defect 2) — withCodexEntry consumes the probe's
// CARRIED COMMAND. Spec-only: scripts/lib/codex-mcp.mjs was NOT read to author
// these.
//
// Carrying the path out of probeCodexWin (Part D above) only closes half the
// defect; the other half is the consumer. CODEX_MCP_ENTRY's bare `codex` stays
// the FALLBACK for a probe that carries no path (the WSL/Linux probeCodex, whose
// success genuinely means "the `codex` on PATH ran"), so the two arms below are
// a matched pair and each is the other's control:
//   path present -> the entry's command IS that path;
//   path absent  -> the entry is exactly CODEX_MCP_ENTRY, unchanged.
// An implementation satisfying only one of them is a defect in the other
// direction, and neither arm alone can see it.
// =============================================================================

const ENTRY_PATH = 'C:\\x\\codex.cmd';

test('withCodexEntry: a probe carrying a command wires THAT ABSOLUTE PATH as the entry command (ffe7c416 defect 2 — the bare "codex" is what left codex-on-Windows unable to spawn)', () => {
  const result = withCodexEntry({}, { ok: true, command: ENTRY_PATH });
  assert.deepEqual(
    result,
    { codex: { command: ENTRY_PATH, args: ['mcp-server'] } },
    'exactly one entry, whose command is the probed path and whose args are still the mcp-server invocation'
  );
});
// SABOTAGE: ignore probeResult.command and splice in CODEX_MCP_ENTRY regardless
// (the pre-ruling behavior) — the deepEqual goes red on command:'codex'.
// SABOTAGE (subtler): carry the command but drop args (`{command}` only) — the
// deepEqual goes red on the missing args, catching an entry that would be
// written into an MCP config and then never start a server.

test('withCodexEntry: the path-carrying entry gets its OWN args array — mutating the produced entry cannot corrupt the shared CODEX_MCP_ENTRY constant', () => {
  const result = withCodexEntry({}, { ok: true, command: ENTRY_PATH });
  // Identity FIRST, mutation second, deliberately: if the arrays are shared this
  // assertion fails and the test aborts BEFORE the push below, so a genuine
  // defect never corrupts the module constant for the tests that run after it.
  assert.notEqual(result.codex.args, CODEX_MCP_ENTRY.args, 'the entry does not alias CODEX_MCP_ENTRY.args — a shared array makes every caller a mutator of the shared constant');
  assert.notEqual(result.codex, CODEX_MCP_ENTRY, 'nor does the entry alias the CODEX_MCP_ENTRY object itself');
  result.codex.args.push('--canary');
  assert.deepEqual(CODEX_MCP_ENTRY.args, ['mcp-server'], 'the shared constant is untouched after mutating the produced entry');
  assert.deepEqual(CODEX_MCP_ENTRY, { command: 'codex', args: ['mcp-server'] }, 'CODEX_MCP_ENTRY as a whole survives — it is the fallback every no-path caller still receives');
});
// SABOTAGE: build the path-carrying entry as `{...CODEX_MCP_ENTRY, command}` —
// the spread is shallow, so `args` is still the SHARED array; the first
// notEqual goes red. (This is the whole point of the pin: the spread form looks
// correct and is the form an implementer reaches for first.)

test('withCodexEntry: a successful probe carrying NO command falls back to CODEX_MCP_ENTRY exactly — the bare-command entry survives for the probe that legitimately has no path (control arm for the pin above)', () => {
  const result = withCodexEntry({}, { ok: true });
  assert.deepEqual(result, { codex: CODEX_MCP_ENTRY }, 'no path carried -> the shipped bare entry, unchanged');
  assert.deepEqual(result.codex, { command: 'codex', args: ['mcp-server'] }, 'spelled out, so the pin does not merely compare CODEX_MCP_ENTRY to itself');
});
// SABOTAGE: make the command mandatory (e.g. `command: probeResult.command`
// unconditionally) — the fallback entry's command becomes undefined and both
// deepEquals go red. This arm must pass for the OPPOSITE reason to the
// path-carrying pin above: it is green only when the path is used BECAUSE it
// was present, not because a command is always taken from the probe.

test('withCodexEntry: a FAILED probe wires nothing even when it carries a command — ok, never command presence, is what gates the entry', () => {
  // Boundary the spec did not name: a one-line implementation that keys off
  // `probeResult.command` instead of `probeResult.ok` looks right and passes
  // every other pin in this file, but it would wire an MCP entry off a probe
  // that reported NOT LOGGED IN — a server that spawns and then fails.
  const result = withCodexEntry({ sterling: { command: 'node', args: ['main.js'] } }, { ok: false, reason: 'not-logged-in', command: ENTRY_PATH });
  assert.ok(!('codex' in result), 'a failed probe adds no codex entry, whatever else it carries');
  assert.deepEqual(result.sterling, { command: 'node', args: ['main.js'] }, 'existing entries preserved');
});
// SABOTAGE: gate on `if (probeResult.command)` instead of `if (probeResult.ok)`
// — the codex key appears and the `!('codex' in result)` assertion goes red.

test('withCodexEntry: purity holds for the path-carrying arm too — a frozen input yields a NEW object, input untouched, existing entries preserved beside codex', () => {
  const original = Object.freeze({ sterling: Object.freeze({ command: 'node', args: ['main.js'] }) });
  let result;
  // a mutating implementation on a frozen object throws in strict ESM — the call
  // completing at all is part of the assertion.
  assert.doesNotThrow(() => { result = withCodexEntry(original, { ok: true, command: ENTRY_PATH }); }, 'withCodexEntry does not attempt to write to its frozen input');
  assert.notEqual(result, original, 'a NEW object is returned, never the input');
  assert.deepEqual(original, { sterling: { command: 'node', args: ['main.js'] } }, 'input unchanged after the call');
  assert.deepEqual(result.codex, { command: ENTRY_PATH, args: ['mcp-server'] }, 'the path-carrying entry is present in the returned object');
  assert.deepEqual(result.sterling, { command: 'node', args: ['main.js'] }, 'existing sterling entry preserved beside codex');
});
// SABOTAGE: mutate and return the input (`mcpServers.codex = entry; return
// mcpServers;`) — the frozen input makes the assignment throw in strict mode, so
// doesNotThrow goes red; on a non-frozen input the notEqual identity assertion
// is what catches it, which is why both are asserted rather than either alone.
