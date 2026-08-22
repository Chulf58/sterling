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
import { probeCodex, CODEX_MCP_ENTRY, withCodexEntry, codexSkipLine } from '../lib/codex-mcp.mjs';

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
