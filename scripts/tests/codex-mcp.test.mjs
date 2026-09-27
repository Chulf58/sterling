// SPARRING-PARTNER slice 1 — scripts/lib/codex-mcp.mjs
// (decision foreign_cd019e0b, sparring-partner-partnership-shape)
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
// SCOPED EXCEPTION: the failure-path table below asserts probeCodex's
// `ok`/`reason`/`command` fields directly, because "a failed probe carries no
// command" cannot be seen through withCodexEntry alone. It does NOT license
// exact-shape deepEquals on a probe result.
//
// spawnFn is modeled on node:child_process's spawnSync return convention
// (the one every other spawn wrapper in this repo already uses — see
// scripts/tests/init-ensure.test.mjs's runHook/init helpers): {error, status}.
// A fake spawnFn never spawns a real process and never depends on whether a
// real `codex` binary is installed or logged in on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeCodex, CODEX_MCP_ENTRY, withCodexEntry, codexSkipLine } from '../lib/codex-mcp.mjs';

function spawnErrorFn() {
  // mirrors a real spawnSync's return on ENOENT: no status, an .error set
  return { error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), status: null };
}
function nonZeroExitFn() {
  return { error: undefined, status: 1 };
}
function successExitFn() {
  return { error: undefined, status: 0, stdout: 'Usage: codex mcp-server\n' };
}

test('CODEX_MCP_ENTRY is exactly {command: "codex", args: ["mcp-server"]}', () => {
  assert.deepEqual(CODEX_MCP_ENTRY, { command: 'codex', args: ['mcp-server'] });
});

test('probeCodex: calls the injected spawnFn for version, capability, and login — never a real spawn or machine-state dependency', () => {
  const calls = [];
  probeCodex({
    spawnFn: (...args) => {
      calls.push(args.slice(0, 2));
      return successExitFn();
    },
    timeoutMs: 2000,
    env: {},
  });
  assert.deepEqual(calls, [
    ['codex', ['--version']],
    ['codex', ['mcp-server', '--help']],
    ['codex', ['login', 'status']],
  ], 'probe invokes only non-interactive version/capability checks before login status');
});

test('probeCodex -> withCodexEntry: logged-in binary whose mcp-server help fails is omitted, with a versioned pinned-server skip route', () => {
  const calls = [];
  const probeResult = probeCodex({
    spawnFn: (_cmd, args) => {
      calls.push(args);
      if (args[0] === '--version') return { error: undefined, status: 0, stdout: 'codex-cli 0.155.1\n' };
      if (args[0] === 'mcp-server') return { error: undefined, status: 0, stdout: 'Usage: codex [OPTIONS] [PROMPT]\n' };
      throw new Error('login status must not run after a missing mcp-server capability');
    },
    timeoutMs: 2000,
    env: {},
  });
  assert.ok(!('codex' in withCodexEntry({ sterling: { command: 'node' } }, probeResult)), 'missing mcp-server never writes a dead codex entry');
  assert.deepEqual(calls, [['--version'], ['mcp-server', '--help']], 'capability failure avoids an unnecessary login check');
  assert.match(codexSkipLine(probeResult.reason, probeResult.version), /0\.155\.1.*user-scope pinned Codex MCP server/i);
});

test('probeCodex -> withCodexEntry: mcp-server help succeeds keeps the codex entry', () => {
  const probeResult = probeCodex({
    spawnFn: (_cmd, args) => {
      if (args[0] === '--version') return { error: undefined, status: 0, stdout: 'codex-cli 0.153.4\n' };
      return { error: undefined, status: 0, stdout: 'Usage: codex mcp-server\n' };
    },
    timeoutMs: 2000,
    env: {},
  });
  assert.deepEqual(withCodexEntry({}, probeResult), { codex: CODEX_MCP_ENTRY });
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
  const probeResult = probeCodex({ spawnFn: (_cmd, args) => {
    if (args[0] === '--version') return { error: undefined, status: 0, stdout: 'codex 0.155.1' };
    if (args[0] === 'mcp-server') return { error: undefined, status: 0, stdout: 'codex mcp-server' };
    return { error: undefined, status: 1 };
  }, timeoutMs: 2000, env: {} });
  assert.equal(probeResult.reason, 'not-logged-in');
  assert.match(codexSkipLine(probeResult.reason), /not logged in/i);
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
// probeCodex FAILURE PATHS, as a table — ported from the retired native-Windows
// probe's control arm (that probe was removed with the native launcher,
// decision native-windows-launcher-retired-wsl2-only). Two properties that were
// pinned only on that probe also hold for the surviving one:
//   - a timeout at the LOGIN-STATUS step (after version and capability succeed)
//     is 'timeout', never 'not-logged-in' or 'binary-absent' — the tests above
//     only time out the first spawn;
//   - no failed probe carries a command, so withCodexEntry wires nothing from it.
// =============================================================================

function stepFn(overrides) {
  // A spawnFn that succeeds at every step except the one overridden by name.
  return (_cmd, args) => {
    const step = args[0] === '--version' ? 'version' : args[0] === 'mcp-server' ? 'capability' : 'login';
    if (overrides[step]) return overrides[step];
    if (step === 'version') return { error: undefined, status: 0, stdout: 'codex-cli 0.153.4\n' };
    if (step === 'capability') return { error: undefined, status: 0, stdout: 'Usage: codex mcp-server\n' };
    return { error: undefined, status: 0 };
  };
}

const PROBE_FAILURE_CASES = [
  { name: 'version spawn error (ENOENT)', reason: 'binary-absent', spawnFn: stepFn({ version: spawnErrorFn() }) },
  { name: 'version step times out', reason: 'timeout', spawnFn: stepFn({ version: spawnTimeoutFn() }) },
  { name: 'capability step times out', reason: 'timeout', spawnFn: stepFn({ capability: spawnTimeoutFn() }) },
  { name: 'login status exits non-zero (not logged in)', reason: 'not-logged-in', spawnFn: stepFn({ login: { error: undefined, status: 1 } }) },
  { name: 'login status times out', reason: 'timeout', spawnFn: stepFn({ login: spawnTimeoutFn() }) },
];

test('probeCodex: every failure path reports its discriminating reason, carries NO command, and wires no codex entry — including a timeout at the login-status step', () => {
  // CONTROL, PLACED FIRST: the same step-dispatching fake with no override is a
  // SUCCESS, so each failure below is caused by its one overridden step.
  const ok = probeCodex({ spawnFn: stepFn({}), timeoutMs: 2000, env: {} });
  assert.equal(ok.ok, true, 'CONTROL: the un-overridden fake is a successful probe');
  assert.deepEqual(withCodexEntry({}, ok), { codex: CODEX_MCP_ENTRY }, 'CONTROL: and it wires the bare CODEX_MCP_ENTRY');
  for (const c of PROBE_FAILURE_CASES) {
    const result = probeCodex({ spawnFn: c.spawnFn, timeoutMs: 2000, env: {} });
    assert.equal(result.ok, false, `${c.name}: probe reports failure`);
    assert.equal(result.reason, c.reason, `${c.name}: the discriminating reason survives`);
    assert.equal(result.command, undefined, `${c.name}: a FAILED probe carries no command`);
    assert.ok(!('codex' in withCodexEntry({ sterling: { command: 'node' } }, result)), `${c.name}: no codex entry is wired`);
  }
});
// SABOTAGE: move the login-status timeout check below the non-zero-status check
// — the 'login status times out' row reports 'not-logged-in' and goes red.

// =============================================================================
// Part E (decision foreign_ffe7c416, defect 2) — withCodexEntry consumes the probe's
// CARRIED COMMAND. Spec-only: scripts/lib/codex-mcp.mjs was NOT read to author
// these.
//
// withCodexEntry still honours a probe result that carries a command (its only
// producer, the native-Windows probe, was retired with the native launcher —
// decision native-windows-launcher-retired-wsl2-only — but the helper's contract
// is unchanged). CODEX_MCP_ENTRY's bare `codex` is the FALLBACK for a probe that
// carries no path (probeCodex, whose success genuinely means "the `codex` on
// PATH ran"), so the two arms below are
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
