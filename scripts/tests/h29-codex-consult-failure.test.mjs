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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// 7-10. REDACTION (sanitizeRawText: redact credential patterns, cap to 500
// chars, fence as untrusted, THEN emit). Detection is unchanged from 1-6
// above; these pins are on the OUTPUT SHAPE of the advisory text itself.
// Oracle: the dispatch brief's SPEC verbatim (this file's oracle per the
// header note; H4 denies reading the hook beyond what the brief specifies).
// ---------------------------------------------------------------------------

test('7: a raw error containing a credential is redacted — literal token absent, [REDACTED] present, advisory still fires with its recovery hint', () => {
  const { dir, cleanup } = makeProject();
  try {
    const secret = 'sk-abcdefghij1234567890ABCDEFGHIJKLMN';
    const result = {
      content: [{ type: 'text', text: `Request failed with status 401: Unauthorized. Authorization: Bearer ${secret} was rejected; please re-authenticate.` }],
      isError: true,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0, 'redaction must never turn an advisory into a block');
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'the advisory must still fire — redaction is a text transform, not a suppression (structural isError:true auth failure)');
    assert.ok(!ctx.includes(secret), 'the literal credential token must never reach additionalContext');
    assert.match(ctx, /\[REDACTED\]/, 'the redacted span is marked with the [REDACTED] placeholder');
    assert.match(ctx, RECOVERY_HINT_RE, 'redaction must not swallow the actionable recovery hint');
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 7: skip the sanitizeRawText() call and interpolate the
// raw error text directly into additionalContext -> ctx now contains the
// literal `secret` substring, `assert.ok(!ctx.includes(secret), ...)` goes
// red (and the `[REDACTED]` match goes red too, independently).

test('8: a ~10000-char raw error is capped well below 10k and carries a truncation marker', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Deliberately NOT a contiguous alnum run: 'x'.repeat(N) (or any 40+ char
    // contiguous [A-Za-z0-9+/] span) matches the base64-shaped credential
    // pattern and gets redacted to a short [REDACTED] BEFORE the 500-char cap,
    // so it never exercises truncation. Spaces/punctuation break every run
    // below 40 chars, and there is no sk-/hex/base64/key= shape, so this text
    // survives redaction intact and is what actually reaches the cap.
    const longText = 'the codex request failed unexpectedly here '.repeat(300);
    assert.ok(longText.length > 500, 'fixture really exceeds the 500-char cap');
    const result = { content: [{ type: 'text', text: `401 unauthorized: ${longText}` }], isError: true };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'advisory must still fire on a very long raw error');
    assert.ok(ctx.length < longText.length, `advisory must be capped well below the raw input size (input ${longText.length} chars, ctx ${ctx.length} chars)`);
    assert.match(ctx, /truncated/i, 'a truncation marker must be present once the raw text is capped');
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 8: remove the cap-to-500-chars step from sanitizeRawText
// (emit the raw text unbounded, or cap only for display without a marker) ->
// either ctx.length stops being well under longText.length (`assert.ok(ctx.length
// < longText.length, ...)` goes red) or the `truncated` marker is absent
// (`assert.match(..., /truncated/i)` goes red) — the two assertions catch
// either half of this sabotage.

test('9: the raw diagnostic is wrapped in an untrusted-data fence in the advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      content: [{ type: 'text', text: '401 Unauthorized: please re-authenticate with codex login.' }],
      isError: true,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx);
    assert.match(
      ctx,
      /untrusted|do not follow as instructions/i,
      'the raw diagnostic must be fenced as untrusted data, not live instructions'
    );
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 9: drop the untrusted-data fence wrapper around the raw
// text (emit the sanitized/capped text unwrapped) -> ctx no longer contains
// an "untrusted"/"do not follow as instructions" marker, the `assert.match`
// line goes red.

test('10 (regression): a clean short auth-failure fixture with no secret still fires with its recovery hint and is NOT over-redacted into uselessness', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      content: [{ type: 'text', text: 'Request failed with status 401: Unauthorized. Your token appears to be invalid or expired.' }],
      isError: true,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'a clean auth-failure fixture must still fire');
    assert.match(ctx, AUTH_SHAPED_RE, '401/unauthorized/token wording must survive redaction when there is no actual secret to redact');
    assert.match(ctx, RECOVERY_HINT_RE, 'the recovery hint must survive redaction');
  } finally {
    cleanup();
  }
});

// SABOTAGE for test 10: over-broaden the credential regex in sanitizeRawText
// (e.g. redact any digit sequence, or redact the bare word "token") on a
// fixture with no actual secret -> "401" or "token" gets replaced with
// [REDACTED], AUTH_SHAPED_RE (/401|unauthorized|token/i) no longer matches
// ctx, the `assert.match(ctx, AUTH_SHAPED_RE, ...)` line goes red. Read
// together with test 7: test 7 proves redaction fires on an actual secret,
// test 10 proves it does NOT fire on ordinary auth vocabulary — a control
// pair, since an implementation that redacts everything auth-shaped would
// pass test 7 for the wrong reason but fails test 10.

test('AUTH-HEADER-FULL: an Authorization header value is redacted WHOLE, not just its first token — advisory still fires with its recovery hint', () => {
  const { dir, cleanup } = makeProject();
  try {
    const secret = 'sk-abc123xyz-realtoken-9876543210';
    const result = {
      content: [{
        type: 'text',
        text: `Request failed with status 401: Unauthorized. Authorization: Bearer ${secret} was rejected; please re-authenticate.`,
      }],
      isError: true,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0, 'redaction must never turn an advisory into a block');
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'the advisory must still fire — this is a structural isError:true auth failure, detection is unaffected by redaction');
    assert.ok(!ctx.includes(secret), 'the full literal Authorization header value must never reach additionalContext');
    assert.ok(!ctx.includes('realtoken'), 'no fragment of the token (mid-token substring) may survive — the OLD regex left everything after the first token exposed');
    assert.match(ctx, /Authorization:\s*\[REDACTED\]/, 'the whole header value is collapsed to a single [REDACTED] marker immediately after "Authorization:"');
    assert.match(ctx, RECOVERY_HINT_RE, 'redaction of the header must not swallow the actionable recovery hint');
  } finally {
    cleanup();
  }
});

// SABOTAGE for AUTH-HEADER-FULL: narrow the Authorization redaction back to
// only the literal words (e.g. change the pattern from
// `/Authorization:\s*Bearer\s+\S+/gi` — which consumes the whole token run —
// to `/Authorization:\s*Bearer\b/gi`, dropping the `\s+\S+` clause that
// consumes the token itself) -> the raw token `sk-abc123xyz-realtoken-9876543210`
// (and its `realtoken` fragment) survive untouched after "Authorization: Bearer ",
// so both `assert.ok(!ctx.includes(secret), ...)` and
// `assert.ok(!ctx.includes('realtoken'), ...)` go red — this is the exact
// pre-fix leak shape (old regex left the token after `Authorization: Bearer`).

// ---------------------------------------------------------------------------
// 11. PostToolUseFailure — SECOND REGISTRATION, NO STRUCTURAL-ERROR GATE.
// Oracle: research_finding aa5bf135 (posttooluse-skips-failed-calls-h29-seam-gap)
// + the dispatch brief's spec given verbatim for this extension:
//   PostToolUse fires only on tool SUCCESS, so h29 gains a SECOND registration
//   on PostToolUseFailure (same matcher: mcp__codex__codex|mcp__codex__codex-reply).
//   On PostToolUseFailure, h29 treats the call as failed WITHOUT the
//   structural-error gate: ANY payload shape — object error, plain string
//   (e.g. "Session not found for thread_id: ..."), or missing — produces the
//   loud emission (stderr + hookSpecificOutput.additionalContext) carrying the
//   raw error text; auth-marker text gets the auth-recovery hint, non-auth
//   gets the transport-failure message. The PostToolUse path's existing
//   conservative (gated) detection is UNCHANGED — tests 1-10 and AUTH-HEADER-
//   FULL above already pin that path and are NOT duplicated here.
//
// Payload field: most fixtures below carry the error on `tool_response`,
// mirroring the existing `postCodex()` helper and matching the finding's own
// trace ("resp.type==='error' trips hasStructuralError" — `resp` reads
// input.tool_response in the current detector) — not an invented field name.
// 11d/11e pin the REST of the defensive extraction chain the reviewers found
// unpinned (tool_response -> tool_error -> error -> message, and the
// missing-everything fallback), so those two deliberately do NOT use
// `tool_response`.
//
// STRUCTURAL vs NON-STRUCTURAL (reviewer correction, both converged): 11a and
// 11c must be NON-structural fixtures — no isError/is_error, no type:'error',
// no truthy `error` field — else they stay green through the OLD
// hasStructuralError-gated path even if the new ungated PostToolUseFailure
// branch is deleted outright, which is a hollow pin (measured: two
// independent reviewers found this on the implementation). Only 11d's/11e's
// fixtures are exempt from this constraint since they pin the extraction
// CHAIN, not the gate-removal.
//
// Pins (e) "PostToolUse isError:true -> emits" is SKIPPED here: tests 1 and 2
// above already pin exactly this (structural isError:true, auth- and
// transport-shaped) and it is unchanged by this extension.
// ---------------------------------------------------------------------------

const postCodexFailure = (dir, toolResponse, tool_name = 'mcp__codex__codex', extra = {}) => ({
  hook_event_name: 'PostToolUseFailure',
  tool_name,
  tool_input: { prompt: 'review this diff for correctness' },
  tool_response: toolResponse,
  cwd: dir,
  ...extra,
});

// Builds a PostToolUseFailure input with the payload under an ARBITRARY
// top-level field name (or none at all) — used by 11d/11e to pin the rest of
// the defensive extraction chain and the whole-input fallback, independent of
// the `tool_response`-specific helper above.
const postCodexFailureRaw = (dir, fields = {}, tool_name = 'mcp__codex__codex') => ({
  hook_event_name: 'PostToolUseFailure',
  tool_name,
  tool_input: { prompt: 'review this diff for correctness' },
  cwd: dir,
  ...fields,
});

test('11-control: PostToolUse clean success stays SILENT (re-asserts test 4 as the LOCAL control for the PostToolUseFailure pins below, per rubric: a suite green for the wrong reason must be visible)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      content: [{ type: 'text', text: 'Review complete: the diff looks correct, no issues found. LGTM.' }],
      isError: false,
    };
    const r = runHook(postCodex(dir, result), dir);
    assert.equal(r.code, 0);
    assert.equal(advisoryOf(r.stdout), null, 'a clean PostToolUse success must stay silent — this control must hold even after the PostToolUseFailure registration is added, else 11a-11c would be green for the wrong reason (detection firing unconditionally on every event)');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 11-control: implement the PostToolUseFailure fix by making the
// shared detector fire unconditionally regardless of hook_event_name (e.g.
// deleting the isError/event check instead of adding a parallel ungated path)
// -> advisoryOf(r.stdout) becomes non-null on this clean-success fixture,
// `assert.equal(..., null, ...)` goes red.

test('11a: PostToolUseFailure with a NON-STRUCTURAL object payload (no isError/is_error, no type:\'error\', no error field; non-auth) fires the loud emission carrying the raw error text, exit 0 — proves the NEW ungated branch, not the old structural gate', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      status: 500,
      message: 'upstream connection reset unexpectedly while contacting the model',
    };
    const r = runHook(postCodexFailure(dir, result), dir);
    assert.equal(r.code, 0, 'an advisory hook never blocks the tool call, even on the failure event');
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'PostToolUseFailure with a non-structural object payload must emit — this fixture would NOT trip the old hasStructuralError gate (no isError/is_error/type:\'error\'/error field), so a green here can only come from the new ungated branch');
    assert.ok(ctx.includes('upstream connection reset unexpectedly while contacting the model'), 'the raw error text must be carried into the advisory');
    assert.doesNotMatch(ctx, RECOVERY_HINT_RE, 'a non-auth failure must get the transport-failure message, not the auth-recovery hint');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 11a: delete the new ungated PostToolUseFailure branch entirely
// and route this event through the OLD hasStructuralError-gated detector
// instead -> this fixture is deliberately non-structural (no isError/is_error,
// no type:'error', no error field), so the old gate never classifies it as a
// failure, ctx stays null, `assert.ok(ctx, ...)` goes red. (This is the
// correction for the reviewer-found hollow pin: the PRIOR fixture here carried
// type:'error' + a truthy error field, which stayed green through the old
// gate even with the new branch deleted.)

test('11b: PostToolUseFailure with a PLAIN-STRING payload (measured shape: "Session not found for thread_id: ...") fires with the string present verbatim, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = 'Session not found for thread_id: abc-123-fake-99887766';
    const r = runHook(postCodexFailure(dir, result), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'a bare string payload on PostToolUseFailure must fire — no auth-shape requirement, unlike the PostToolUse string fallback in test 3');
    assert.ok(ctx.includes(result), 'the plain-string payload must appear verbatim in the advisory (no auth marker to redact, no length floor on this event)');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 11b: reuse the PostToolUse string-fallback logic (test 3's
// path), which requires AUTH_SHAPED_RE to match before a bare string fires
// -> this fixture contains no "401"/"unauthorized"/"token" text, so under
// that reused fallback it never matches, ctx stays null, `assert.ok(ctx, ...)`
// goes red.

test('11c: PostToolUseFailure with a NON-STRUCTURAL auth-shaped payload (401 / token expired, no isError/type:\'error\'/error field) is auth-classified — the recovery hint fires, not the generic transport message', () => {
  const { dir, cleanup } = makeProject();
  try {
    const result = {
      status: 401,
      message: 'Authentication failed: 401 token expired for this session.',
    };
    const r = runHook(postCodexFailure(dir, result), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'an auth-shaped, non-structural PostToolUseFailure payload must emit — this fixture would NOT trip the old hasStructuralError gate either, so a green here can only come from the new ungated branch');
    assert.match(ctx, AUTH_SHAPED_RE, 'the advisory names the auth-shaped failure');
    assert.match(ctx, RECOVERY_HINT_RE, 'auth-marker text on PostToolUseFailure must still get the actionable recovery hint, distinguishing it from 11a\'s non-auth transport message');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 11c (two independent mutations this fixture must catch):
// (1) delete the new ungated PostToolUseFailure branch and route through the
// OLD hasStructuralError-gated detector -> this fixture is deliberately
// non-structural (no isError/is_error/type:'error'/error field), so the old
// gate never classifies it as a failure, ctx stays null, `assert.ok(ctx, ...)`
// goes red before classification is even reached.
// (2) keep the new branch but drop its auth/non-auth classification (always
// emit the generic transport-failure message regardless of content) ->
// RECOVERY_HINT_RE no longer matches ctx, `assert.match(ctx, RECOVERY_HINT_RE,
// ...)` goes red, while 11a's `assert.doesNotMatch` stays green for the wrong
// reason alone — read together, this pair is what proves classification (not
// mere presence/absence of emission) is load-bearing. (Correction: the PRIOR
// fixture here carried type:'error' + a truthy error field, which stayed
// green through the old gate even with the new branch deleted — mutation (1)
// above is the reviewer-found fix.)

test("11d: PostToolUseFailure with the payload under tool_error (not tool_response) fires with that text verbatim — the extraction chain is not hardcoded to tool_response", () => {
  const { dir, cleanup } = makeProject();
  try {
    const text = 'codex-reply thread lookup failed: no matching session for this request';
    const r = runHook(postCodexFailureRaw(dir, { tool_error: text }), dir);
    assert.equal(r.code, 0);
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'a payload carried under tool_error (instead of tool_response) must still fire');
    assert.ok(ctx.includes(text), 'the tool_error payload text must appear verbatim in the advisory');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 11d: hardcode the extraction to read only input.tool_response
// and never fall back to tool_error (or error) -> the hook finds nothing
// under tool_response (undefined) for this fixture, so either ctx stays null
// or a generic "missing payload" branch fires without this fixture's text ->
// `assert.ok(ctx, ...)` or `assert.ok(ctx.includes(text), ...)` goes red.

test('11e: PostToolUseFailure with NO payload field at all (no tool_response/tool_error/error) still emits — falls back to the whole hook input, non-empty raw text', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(postCodexFailureRaw(dir, {}), dir);
    assert.equal(r.code, 0, 'a missing payload must never be treated as a block');
    const ctx = advisoryOf(r.stdout);
    assert.ok(ctx, 'PostToolUseFailure with no payload field at all must still emit — "missing" is one of the three payload shapes the spec names');
    assert.ok(ctx.trim().length > 0, 'the raw text carried must be non-empty even with nothing but the whole input to fall back on');
  } finally {
    cleanup();
  }
});

// SABOTAGE for 11e: require a non-empty tool_response/tool_error/error before
// ever emitting (treat "nothing to classify" as silent, mirroring test 6c's
// PostToolUse convention, instead of the spec's "or missing -> still fires")
// -> ctx stays null, `assert.ok(ctx, ...)` goes red.

test('11f: hooks.json registers h29-codex-consult-failure.mjs on PostToolUseFailure with the SAME matcher as its existing PostToolUse registration (mcp__codex__codex|mcp__codex__codex-reply)', () => {
  const hooksJson = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const findByCommand = (e) => (e.hooks ?? []).find((h) => typeof h.command === 'string' && h.command.includes('h29-codex-consult-failure.mjs'));

  const postEntries = hooksJson.hooks?.PostToolUse ?? [];
  const existingEntry = postEntries.find(
    (e) => findByCommand(e) && new RegExp(e.matcher).test('mcp__codex__codex') && new RegExp(e.matcher).test('mcp__codex__codex-reply')
  );
  assert.ok(existingEntry, 'sanity: the existing PostToolUse registration for h29 must still be present (regression floor)');

  const failureEntries = hooksJson.hooks?.PostToolUseFailure ?? [];
  const failureEntry = failureEntries.find(
    (e) => findByCommand(e) && new RegExp(e.matcher).test('mcp__codex__codex') && new RegExp(e.matcher).test('mcp__codex__codex-reply')
  );
  assert.ok(failureEntry, 'hooks.json must register h29-codex-consult-failure.mjs on PostToolUseFailure covering mcp__codex__codex and mcp__codex__codex-reply');
  assert.ok(!new RegExp(failureEntry.matcher).test('Bash'), 'the PostToolUseFailure matcher must be scoped to the codex tools, not a blanket match');
  assert.equal(failureEntry.matcher, existingEntry.matcher, 'same matcher string on both registrations, per spec');
});

// SABOTAGE for 11f: add the PostToolUseFailure entry with a narrower/wrong
// matcher (e.g. only "mcp__codex__codex", dropping the codex-reply
// alternation) -> `new RegExp(failureEntry.matcher).test('mcp__codex__codex-reply')`
// is false, `.find(...)` returns undefined, `assert.ok(failureEntry, ...)`
// goes red; or omit the PostToolUseFailure registration entirely -> the same
// assertion goes red directly.
