// H29 codex-consult-failure — PostToolUse advisory on the codex MCP tools.
// SPEC (given verbatim by the dispatch brief — this file's oracle; no decision
// record exists yet for H29, and scripts/hooks/h29-codex-consult-failure.mjs
// was not read beyond what the brief itself specifies — the test-writer read
// wall (H4) denies it):
//   1. AUTH FAILURE (structural): tool_name mcp__codex__codex, tool_response
//      carrying isError:true with auth-shaped text (401/unauthorized/token)
//      -> hookSpecificOutput.additionalContext names the failure + a recovery
//      hint, exit 0.
//   2. TRANSPORT FAILURE (structural): isError:true with transport-shaped
//      text (e.g. ECONNRESET) -> advisory fires, exit 0.
//   3. STRING-SHAPED AUTH ERROR (fallback): a SHORT auth-shaped result string
//      with no structural marker -> fires via the short+auth-shaped fallback.
//   4. CLEAN SUCCESS: a normal successful codex result -> SILENT, exit 0.
//   5. LONG SUCCESS MENTIONING AUTH (the discriminating control, per the
//      brief's own framing): a long (>4000 char) successful review that
//      merely discusses auth/401 -> SILENT (the length floor prevents a
//      naive keyword-only matcher from false-firing on success prose).
//   6. NON-CODEX TOOL / never-blocks: any input -> exit is NEVER 2.
//
// Harness idiom copied from scripts/tests/h20-consult-carriage.test.mjs and
// scripts/tests/h23-output-axis.test.mjs (spawnSync the hook with JSON stdin;
// tmp project dir with a bare .sterling/config.json; assert on stdout/exit
// only, never on hook internals).
//
// CONTROL-ARM NOTE (decision a-ruling-change-is-verified-by-mutation-not-by-a-green-suite
// and this role's rubric): AUTH FAILURE (test 1) runs FIRST and is the control
// that establishes the mechanism is LIVE — it must fire. LONG SUCCESS
// MENTIONING AUTH (test 5) then shows the SAME auth vocabulary staying silent
// once wrapped in a long, successful result. Read together: test 1 rules out
// "the hook never advises at all" as the explanation for test 5's silence: a
// hook that is unconditionally silent would pass test 5 for the wrong reason,
// but it fails test 1, so a green test 5 is only meaningful alongside a green
// test 1 — recorded here explicitly so the pair is never read in isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h29-codex-consult-failure.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runRaw(raw, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h29-codex-consult-failure.mjs')], {
    input: raw,
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h29-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** additionalContext extracted from a hook's stdout, or null if the hook stayed silent. */
function advisoryOf(stdout) {
  if (!stdout || !stdout.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null; // malformed/non-JSON stdout is treated as "no advisory" by these pins
  }
  return parsed?.hookSpecificOutput?.additionalContext ?? null;
}

const postCodex = (dir, toolResponse, tool_name = 'mcp__codex__codex', extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name,
  tool_input: { prompt: 'review this diff for correctness' },
  tool_response: toolResponse,
  cwd: dir,
  ...extra,
});

// A recovery hint must point the reader toward FIXING the auth state, not
// merely restate that it failed — "unauthorized"/"401"/"token" alone must
// not satisfy this regex, only actionable recovery language does.
const RECOVERY_HINT_RE = /log\s*in|re-?auth(enticat)?e|refresh (your |the )?(session|token|login)|codex login|reconnect/i;
const AUTH_SHAPED_RE = /401|unauthorized|token/i;

// ---------------------------------------------------------------------------
// 1. AUTH FAILURE (structural) — also the LIVE-MECHANISM control for test 5
// ---------------------------------------------------------------------------

test('1: structural isError:true with auth-shaped text (401/unauthorized/token) fires an advisory naming the failure + a recovery hint, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      content: [{ type: 'text', text: 'Request failed with status 401: Unauthorized. Your token appears to be invalid or expired.' }],
      isError: true,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0, 'an advisory hook never blocks the tool call');
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'an advisory must be present for a structural auth failure');
    assert.match(ctx, AUTH_SHAPED_RE, 'the advisory names what failed (auth-shaped)');
    assert.match(ctx, RECOVERY_HINT_RE, 'the advisory carries an actionable recovery hint, not just a restated failure');
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 1: delete the isError:true auth-shaped branch entirely
// (e.g. `if (false && isAuthShaped(text)) { ... }`) -> stdout goes empty,
// advisoryOf() returns null, the `assert.ok(ctx, ...)` line goes red.

test('1b: codex-reply gets the same structural auth-failure advisory as codex', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      content: [{ type: 'text', text: '401 Unauthorized — the ChatGPT session token has expired.' }],
      isError: true,
    };
    const r = runHook(postCodex(dir, result, 'mcp__codex__codex-reply'), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'codex-reply must fire on the same auth-shaped structural failure as codex');
    assert.match(ctx, AUTH_SHAPED_RE);
  } finally {
    cleanup();
  }
});

// SABOTAGE for 1b: hardcode the tool_name check to `=== 'mcp__codex__codex'`
// (drop the codex-reply branch) -> ctx becomes null, `assert.ok(ctx, ...)`
// goes red.

// ---------------------------------------------------------------------------
// 2. TRANSPORT FAILURE (structural)
// ---------------------------------------------------------------------------

test('2: structural isError:true with transport-shaped text (ECONNRESET) fires an advisory, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      content: [{ type: 'text', text: 'Error: read ECONNRESET at TLSSocket.onStreamRead (internal stream handling)' }],
      isError: true,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'a transport failure must also surface an advisory');
    assert.match(ctx, /ECONNRESET|transport|connection/i, 'the advisory names the transport-shaped failure');
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 2: narrow the structural-failure branch to ONLY match
// AUTH_SHAPED_RE (drop transport-shaped detection) -> ctx becomes null on
// this ECONNRESET fixture, `assert.ok(ctx, ...)` goes red.

// ---------------------------------------------------------------------------
// 3. STRING-SHAPED AUTH ERROR (fallback)
// ---------------------------------------------------------------------------

test('3: a short auth-shaped result STRING with no structural marker fires via the short+auth-shaped fallback', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = '401 Unauthorized: please re-authenticate with codex login.';
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'a bare auth-shaped string with no isError field must still fire via the fallback path');
    assert.match(ctx, AUTH_SHAPED_RE);
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 3: require tool_response to be a structured object with
// an isError field before ever checking auth-shaped text (delete the bare-
// string fallback branch) -> this fixture (a plain string) never matches,
// ctx becomes null, `assert.ok(ctx, ...)` goes red.

// ---------------------------------------------------------------------------
// 4. CLEAN SUCCESS
// ---------------------------------------------------------------------------

test('4: a normal successful codex result stays SILENT, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      content: [{ type: 'text', text: 'Review complete: the diff looks correct, no issues found. LGTM.' }],
      isError: false,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0);
    assert.equal(advisoryOf(r.stdout), null, 'a clean success must never produce an advisory');
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 4: make the hook fire unconditionally (always emit the
// auth-failure advisory regardless of isError) -> advisoryOf(r.stdout) is
// no longer null, `assert.equal(..., null, ...)` goes red.

// ---------------------------------------------------------------------------
// 5. LONG SUCCESS MENTIONING AUTH — the discriminating control (see header)
// ---------------------------------------------------------------------------

test('5: a long (>4000 char) successful review that merely DISCUSSES auth/401 stays SILENT — the length floor prevents false-fire', () => {
  const { dir, cleanup } = makeProject();
  try {
    const filler =
      'This review pass walked the authentication module end to end. '.repeat(80) +
      'Historically this service returned 401 for unauthorized token refreshes before the fix; ' +
      'the current diff replaces that with a clean 200 path and adds a regression test. '.repeat(20);
    assert.ok(filler.length > 4000, 'fixture really exceeds the 4000-char floor');
    const result = {
      content: [{ type: 'text', text: filler }],
      isError: false,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0);
    assert.equal(
      advisoryOf(r.stdout),
      null,
      'a long, successful result that merely discusses auth/401 in review prose must not be mistaken for an actual failure'
    );
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 5: change the auth-shaped fallback to scan the FULL text
// for AUTH_SHAPED_RE regardless of isError/length (drop the length floor
// and/or the isError:false short-circuit) -> this fixture's text contains
// "401" and "unauthorized", advisoryOf(r.stdout) becomes non-null, the
// `assert.equal(..., null, ...)` line goes red. Read together with test 1
// (which must stay green under the same mutation, since it is a SHORT
// isError:true fixture): this sabotage is the one that specifically proves
// the length/success floor is load-bearing, not just "the hook never fires".

// ---------------------------------------------------------------------------
// 6. NON-CODEX TOOL / never-blocks
// ---------------------------------------------------------------------------

test('6a: a non-codex tool_name is ignored — exit is never 2, no advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cat run.log' },
        tool_response: '401 Unauthorized token expired ECONNRESET',
        cwd: dir,
      },
      dir
    );
    assert.notEqual(r.code, 2, 'a non-codex tool must never be blocked');
    assert.equal(advisoryOf(r.stdout), null, 'a non-codex tool_name must never produce a codex-consult advisory');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 6a: drop the tool_name-prefix gate so any PostToolUse event's
// tool_response is scanned for auth/transport shape -> this fixture's text
// is deliberately auth+transport-shaped, so advisoryOf(r.stdout) becomes
// non-null, the second assertion goes red.

test('6b: malformed non-JSON stdin never crashes and never exits 2', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('{not json at all', dir);
    assert.notEqual(r.code, 2, 'malformed stdin must never be treated as a block');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 6b: remove the try/catch around JSON.parse(stdin) so a parse
// error propagates as an uncaught exception -> node exits with a non-zero
// crash code; on this repo's hook convention that is asserted indirectly by
// requiring code !== 2 AND (defensively) the process not literally crashing
// with an uncaught-exception stack on stderr — the crash-hardening pin below
// makes that half explicit.

test('6b-hardening: malformed non-JSON stdin does not crash with an uncaught exception', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('{not json at all', dir);
    assert.doesNotMatch(r.stderr, /Uncaught|Unhandled|Error: Unexpected token/i, 'a malformed stdin must be handled, not crash the hook process');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 6b-hardening: delete the try/catch around JSON.parse so a
// syntax error throws uncaught -> node prints "SyntaxError: Unexpected
// token ..." to stderr, the doesNotMatch assertion goes red.

test('6c: a codex tool_response missing entirely never crashes and never exits 2', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__codex__codex', tool_input: { prompt: 'x' }, cwd: dir }, dir);
    assert.notEqual(r.code, 2, 'a missing tool_response must never be treated as a block');
    assert.equal(advisoryOf(r.stdout), null, 'nothing to classify means no advisory');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 6c: treat an undefined tool_response as auth-shaped by
// default (e.g. a truthiness bug where `!result` is read as "could be an
// error") -> advisoryOf(r.stdout) becomes non-null, the second assertion
// goes red.
