// H28 — default return-contract injector (board f6a7a74c, USER-APPROVED per an
// explicit Codex design). SubagentStart hook (no matcher — every agent type):
// injects a STATIC, SELF-SUBORDINATING return-contract block into the SPAWNED
// subagent's own context via hookSpecificOutput.additionalContext.
//
// WHY: the largest lane in the aug-2026 feedback batch returned ~250 words
// only because its brief happened to carry a word cap + no-pasted-diffs clause
// — "the single highest-leverage convention in the contract and it is enforced
// only by prose in each brief" (reference ec532e7a §11). H27 exists but is
// opt-in and was opted into in none of the three measured sessions. This makes
// the return contract the DEFAULT on the dispatch surface.
//
// SEAM (verified, h19-dispatch-staging precedent, research_finding 35a89a0f):
// SubagentStart's hookSpecificOutput.additionalContext lands in the SPAWNED
// subagent's context — the ONLY seam that reaches the subagent (a PreToolUse
// hook's updatedInput is silently ignored on the Agent tool).
//
// DESIGN (Codex-refined, built EXACTLY — no added cleverness):
//  - The injected text is STATIC and SELF-SUBORDINATING: its first clause cedes
//    precedence to any explicit output requirement in the agent definition or
//    dispatch brief, so role/brief contracts are NEVER displaced and repeated
//    injection is harmless.
//  - NO transcript parsing, NO opt-out marker, NO dedup in v1 (a union-scan of
//    parallel siblings' prompts would suppress the wrong sibling; double-
//    injection is harmless because the text subordinates itself). ALWAYS inject.
//  - EXEMPTIONS are only true platform-internal agents whose output is not a
//    human-facing work product. Reviewers, Explore/explorer, researchers,
//    general-purpose and Plan are NOT exempt — their reports benefit MOST from
//    conclusion-not-transcript. (h25's BUILTIN_AGENT_TYPES set is deliberately
//    NOT reused — Codex: it is too broad for an exemption set.)
//  - Advisory, FAIL-OPEN: no exit-2, no state, no gate. Malformed/absent stdin
//    degrades to a non-blocking warning; a spawn is never blocked.
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';

// True platform-internal agents whose output configures the harness rather than
// being a human-facing work product. Kept deliberately NARROW (not h25's
// builtin list): only agents whose report a return contract would be noise for.
const EXEMPT_AGENT_TYPES = new Set(['statusline-setup']);

// STATIC and SELF-SUBORDINATING — the first clause cedes precedence, so this
// never displaces a role/brief output contract and re-injection is harmless.
const RETURN_CONTRACT =
  'STERLING DEFAULT RETURN CONTRACT — Explicit output requirements in your ' +
  'agent definition or dispatch brief take precedence. Otherwise, return the ' +
  'conclusion, not a work transcript: maximum ~250 words; no pasted diffs, raw ' +
  'logs, or step-by-step narration. Report only the outcome, decisive evidence, ' +
  'relevant files/tests, and unresolved risks.';

try {
  const input = readStdin();

  // Exempt platform-internal agents — their output is not a human-facing work
  // product, so a return contract would only be noise (P1).
  if (EXEMPT_AGENT_TYPES.has(input.agent_type)) allow();

  // Always inject otherwise — no transcript read, no dedup, no state.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: RETURN_CONTRACT },
    })
  );
  allow();
} catch (e) {
  // Advisory, never a gate: internal failure is loud but NON-blocking (P5
  // visibility, no AC7-style violation) — a spawn is never blocked.
  warnNonBlocking(`H28: return-contract injection failed: ${(e && e.message) || e}`);
}
