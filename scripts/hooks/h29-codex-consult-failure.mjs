// H29 — CODEX CONSULT-FAILURE observer (board 923e3836; concept family
// sparring-partner, article slug sparring-partner). PostToolUse on
// mcp__codex__codex|mcp__codex__codex-reply — the FIRST runtime seam that
// observes a LIVE consult failing. Until now only PreToolUse H20 rode the
// codex matcher (it stages retrieval INTO the consult); nothing watched what
// the consult RETURNED. So a mid-session auth-token death (the WSL bridge runs
// on a COPY of the desktop app's ChatGPT OAuth token, finding
// codex-mcp-live-probe-this-machine) would degrade the sparring partner
// SILENTLY — and Codex is now the DEFAULT independent reviewer on every
// significant code-touching diff (decision codex-preferred-for-read-shaped-
// analysis). A silent failure would therefore remove one of the two review
// families while the conductor believed the diff had been independently
// reviewed: a FALSE-ASSURANCE failure, worse than a missing review, which is
// exactly why P5 wants this LOUD.
//
// ADVISORY, NEVER A GATE: this hook NEVER exits 2. A failure surfaces loudly
// (stderr for the human + additionalContext for the model) and the process
// exits 0; a clean success result is silent. This matches the sparring-
// partner article's advisory-only posture (AC3: no mechanism blocks, denies,
// or gates on the partner's opinion or its unavailability).
//
// HEURISTIC DETECTION — DISCLOSED LIMITATION (board 923e3836, measurement
// half still OPEN): the exact error shape `codex mcp-server` returns when the
// copied token is dead has NOT been observed, so failure classification is a
// HEURISTIC (looksLikeAuthFailure over the raw result text), not a confirmed
// error contract. Two conservative floors keep false positives off a
// SUCCESSFUL consult — whose analysis can itself legitimately discuss "auth"
// or "401" when Codex reviews auth code:
//   (1) a STRUCTURAL error marker (isError / is_error / a truthy error field /
//       status|type === 'error') is the primary trigger — a normal content
//       return carries none of these;
//   (2) a fallback for an unmeasured STRING-shaped error: text with no
//       structural marker fires ONLY when it both looksLikeAuthFailure AND is
//       SHORT (< AUTH_TEXT_MAX) — a real error message is short, a full Codex
//       review is many KB, so the length floor keeps a long successful
//       analysis that merely mentions auth from tripping it.
// The raw result text is ALWAYS emitted on a fire, so the currently-unmeasured
// shape gets CAPTURED the first time a real failure is seen (P5: fail loud,
// never a silent skip or a swallowed shape) — record it against the finding
// codex-mcp-live-probe-this-machine / the sparring-partner article.
//
// REUSE, NOT REIMPLEMENTATION: looksLikeAuthFailure + consultFailureMessage
// are imported from the canonical copy in scripts/lib/codex-mcp.mjs (that
// module imports only node:child_process, so esbuild bundles it standalone at
// ship time — the same author-time-import / bundle-time-resolve mechanism h20
// uses for @sterling/store). No heuristic is duplicated here.
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { looksLikeAuthFailure, consultFailureMessage } from '../lib/codex-mcp.mjs';

// A real error message is terse; a full Codex review is many KB. Below this
// length an auth-shaped body with no structural error marker is treated as a
// probable string-shaped failure rather than a passing mention inside a
// successful analysis.
const AUTH_TEXT_MAX = 4000;

/**
 * Best-effort raw text out of a tool_response whose exact shape is UNMEASURED.
 * Pulls the MCP CallToolResult content[] text, an error/message field, and
 * falls back to the whole stringified response so nothing is ever swallowed —
 * the point is to CAPTURE the shape, not to parse a known one.
 */
function extractResultText(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  const parts = [];
  if (Array.isArray(resp.content)) {
    for (const c of resp.content) {
      if (typeof c === 'string') parts.push(c);
      else if (c && typeof c.text === 'string') parts.push(c.text);
    }
  }
  if (typeof resp.error === 'string') parts.push(resp.error);
  else if (resp.error && typeof resp.error.message === 'string') parts.push(resp.error.message);
  if (typeof resp.message === 'string') parts.push(resp.message);
  return parts.length ? parts.join('\n') : JSON.stringify(resp);
}

/** A structural error marker on the (unmeasured) result object. */
function hasStructuralError(resp) {
  if (resp == null || typeof resp !== 'object') return false;
  if (resp.isError === true || resp.is_error === true) return true;
  if (resp.error != null && resp.error !== false) return true;
  if (resp.status === 'error' || resp.type === 'error') return true;
  return false;
}

try {
  const input = readStdin();

  // Defensive: the hooks.json matcher already scopes this to the two codex
  // tools, but mirror h20's guard so a mis-registration cannot mis-fire.
  const tool = input.tool_name;
  if (typeof tool !== 'string' || !tool.startsWith('mcp__codex__')) allow();

  const resp = input.tool_response;
  const text = extractResultText(resp);

  const structural = hasStructuralError(resp);
  const authShapedShort = !structural && text.length > 0 && text.length < AUTH_TEXT_MAX && looksLikeAuthFailure(text);
  if (!structural && !authShapedShort) allow(); // clean success — silent (P1)

  // consultFailureMessage reuses looksLikeAuthFailure internally to pick the
  // auth-recovery hint vs the generic transport message, and ALWAYS carries the
  // raw error text so the shape is measured on first observation.
  const classified = consultFailureMessage(text);

  const block = [
    `STERLING CODEX CONSULT-FAILURE (H29) — a live sparring-partner consult (${tool}) returned a FAILURE result.`,
    `Codex is the DEFAULT independent reviewer on code-touching diffs (decision codex-preferred-for-read-shaped-analysis); ` +
      `a SILENT failure removes one review family while you believe the diff was independently reviewed — a false-assurance failure (board 923e3836, P5).`,
    classified,
    `NOTE: the exact auth-death error shape from \`codex mcp-server\` is UNMEASURED (board 923e3836), so detection here is HEURISTIC. ` +
      `The raw result above is emitted so the shape can be CAPTURED on this first real failure — record it against the finding ` +
      `codex-mcp-live-probe-this-machine / the sparring-partner article, then trust it less until it is observed.`,
  ].join('\n');

  // BOTH channels: stderr so the human sees it in the terminal, additionalContext
  // so the model reading the consult result sees it too. exit 0 — advisory, never
  // a gate (AC3), never exit 2.
  process.stderr.write(block + '\n');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: block },
    })
  );
  allow();
} catch (e) {
  // Observer is an aid, never a gate: loud but NON-blocking (P5), exit 1.
  warnNonBlocking(`H29: codex consult-failure observer failed: ${(e && e.message) || e}`);
}
// no close: every path above exits the process, releasing any handle (board f81b1987)
