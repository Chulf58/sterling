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
//   - same return shape as probeCodex: {ok:true} | {ok:false, reason} with
//     reason ∈ {binary-absent, not-logged-in, timeout}.
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

test('probeCodexWin: resolves via spawnFn("where.exe", ["codex"], ...) — the WINDOWS PATH through WSL interop — then runs "<resolved> login status" through the same injected spawnFn; both steps succeeding yields {ok:true}', () => {
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
  assert.deepEqual(result, { ok: true }, 'both steps succeeding yields ok:true');
});
// SABOTAGE: call spawnFn('codex', ...) directly instead of resolving through
// where.exe first — calls[0].cmd would be 'codex', not 'where.exe', and the
// deepEqual on calls[0] goes red.

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
  assert.deepEqual(result, { ok: true }, 'login status against the forced path succeeds');
});
// SABOTAGE: read STERLING_CODEX_WIN_PATH but still call where.exe first as a
// sanity check before honoring it — whereCalled flips true and that assertion
// goes red.

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
