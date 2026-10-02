// H19 — dispatch staging (AC5; board 7b01f139-7341-4d3c-9991-6c1c27ceafc7,
// probe evidence 35a89a0f-120e-4b18-97f9-63dc82016c74). SubagentStart hook (no
// matcher — every agent type): stages the SAME knowledge-delivery payload
// h19-knowledge-delivery.mjs computes for a governed touch, but for the
// territory named in the DISPATCH PROMPT rather than a file the spawned agent
// has touched yet. Closes the gap the board item names: N agents can start
// reasoning from one stale premise before any of their own Read/Edit ever
// fires the file-touch hook.
//
// LIVE-PROBED, not inferred (2026-08-04, research_finding foreign_35a89a0f):
// SubagentStart's hookSpecificOutput.additionalContext lands in the SPAWNED
// subagent's own context (not the parent's), on the WSL CLI headless surface,
// CC 2.1.220. Its stdin carries session_id, transcript_path, cwd, prompt_id,
// agent_id, agent_type, hook_event_name — THERE IS NO PROMPT FIELD. The
// dispatch prompt is therefore recovered through the dispatch-state machine
// (scripts/lib/dispatch-register.mjs's resolveDispatchStart) — NOT the parent
// transcript, which is measurably LAGGED at this event and cannot attribute a
// prompt to a spawn safely by any ordering trick (decision
// dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-
// replaces-transcript-attribution, superseding the earlier transcript-tail
// recovery this file used).
//
// Never a gate (AC7 precedent): internal failure degrades to no output, exit 1
// non-blocking (P5) — dispatch staging is an aid layered on top of the file-
// touch delivery, never a second place that can deny a spawn.
//
// H28 FOLD (2026-08-30, decision foreign_04982f45): h28-return-contract.mjs absorbed
// here — same SubagentStart event, same advisory/fail-open posture (both
// warnNonBlocking). EXEMPT_AGENT_TYPES and RETURN_CONTRACT below are its
// unchanged substance; the return contract is injected on EVERY dispatch
// regardless of the payload path above (ALWAYS inject, no dedup — the text
// is self-subordinating, so repeated injection is harmless). `finish()`
// combines the knowledge-delivery payload (may be empty) with the return
// contract into ONE additionalContext emission so neither clobbers the
// other (mirrors H25's two-advisory merge), and both arms stay inside this
// file's existing try/warnNonBlocking shape — the fold does not change h19's
// own failure posture.
import { readStdin, allow, warnNonBlocking, exitAfterWrite } from './lib/common.mjs';
import { openSubjectFan, warnFanDegraded } from './lib/subject-fan.mjs';
import { hazardLaneMode } from './lib/hazard-lane-mode.mjs';
// Path extraction, the path and subject channels, the delivery assembler, the plan
// and TDD lines and the return contract all live in lib/stage-brief.mjs — one
// mechanism, imported never reimplemented (decision foreign_f5638a84). Prompt
// RECOVERY no longer reads the parent transcript (decision dispatch-state-machine-
// pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution):
// this hook resolves its own dispatch's prompt through the dispatch-state machine.
import { resolveDispatchStart } from '../lib/dispatch-register.mjs';
import { EXEMPT_AGENT_TYPES, RETURN_CONTRACT, composeContext, dispatchChrome, stageBrief } from './lib/stage-brief.mjs';

const input = readStdin();

// TDD POSTURE and ACTIVE PLAN lines (implementor dispatches only) come from the
// shared lib (scripts/hooks/lib/stage-brief.mjs dispatchChrome): the SAME TDD
// posture line H1 injects, read fresh so a mid-session toggle reaches a freshly
// spawned agent, UNKNOWN for an unreadable config (never the default); and the
// bounded approved-plan line. Each is fail-open — a malformed config or lock
// costs only its own line, never h19's other staging.
const { tddPostureLine, activePlanLine } = dispatchChrome(input.cwd, input.agent_type);

// UNATTRIBUTABLE-START DISCLOSURE (decision dispatch-state-machine-pre-slot-
// post-binding-locked-start-resolution-replaces-transcript-attribution §6):
// set inside main() once resolveDispatchStart's verdict is known, and folded
// into combinedContext() beside the return contract — never a transcript
// fallback, exactly one line, on 'unattributable' only ('resume' emits
// nothing extra). The line is addressed to the CHILD (decision
// h22-start-staging-only-when-attribution-is-unambiguous-no-sidecar (3)): it
// says its knowledge was not staged and that its brief is what to rely on,
// because no Start-time key exists for same-type parallel Starts. A throw
// before attribution settles is the same unattributable Start and gets the
// same line in the catch below, named by the PHASE that threw: 'store' ->
// [store-unavailable] (openSubjectFan failed, attribution never attempted),
// 'resolution' -> [resolution-failed] (resolveDispatchStart itself threw).
let unattributableLine = '';
let startPhase = 'store';
function notStagedLine(kase) {
  return `STERLING DISPATCH STAGING (H19): this spawn's dispatch could not be attributed at Start [${kase}] — YOUR KNOWLEDGE WAS NOT STAGED: no owning articles, hazards or decisions were delivered for your task. Do not assume the store is silent on it: rely on your dispatch brief for knowledge pointers and query the store for the area before acting. File-touch delivery still fires on your first Read/Edit.`;
}

// THE ONE-ENVELOPE RULE IS THE HELPER'S NOW (decision hook-stdout-exit-after-
// write-callback-bound-exit-deny-stays-synchronous): exitAfterWrite suppresses a
// second non-empty stdout payload and DISCLOSES the drop on stderr, so the local
// `emitted` flag this file used to carry is gone — one mechanism, not two that
// can disagree. The same call is also what makes the exit wait for the stream to
// take the payload, so a large staging envelope is never truncated by the exit.

// Combines PAYLOAD (the knowledge-delivery text, may be '') with the return
// contract (h28 fold — omitted only for EXEMPT_AGENT_TYPES) into one string.
function combinedContext(payload) {
  return composeContext({ agentType: input.agent_type, activePlanLine, payload, tddPostureLine, unattributableLine });
}

/** The stdout envelope, in the one shape this hook emits. */
function envelope(out) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: out } });
}

// Emits the combined context (if any) and allows — used at every early exit
// below so the return contract still injects even when the knowledge-payload
// path has nothing to stage (h28's own posture: ALWAYS inject).
function finish(payload) {
  const out = combinedContext(payload);
  if (out) return exitAfterWrite(envelope(out), 0);
  return allow();
}

// THE BODY IS A FUNCTION, AND EVERY TERMINAL CALL INSIDE IT IS A `return`: the
// exit now happens in the stdout write callback, so a bare `finish('')` would
// no longer stop the statements after it the way its hard exit did.
async function main(input) {
  try {
    // The subject fan: the project store plus the mounted domains. stageBrief's
    // path arm passes file_keys, which the fan answers from the project store only.
    const store = openSubjectFan(input.cwd);
    if (!store) return finish(''); // not a Sterling project — no ceremony for the payload half (P1)
    startPhase = 'resolution';

    // DISPATCH-STATE RESOLUTION replaces the old parent-transcript prompt scan
    // (decision dispatch-state-machine-pre-slot-post-binding-locked-start-
    // resolution-replaces-transcript-attribution §5/§6). 'resume' emits nothing
    // extra; 'unattributable' stages no territory and gets exactly one line
    // beside the return contract; a resolved prompt is staged normally.
    const resolution = await resolveDispatchStart(
      input.cwd,
      { session_id: input.session_id, agent_id: input.agent_id, agent_type: input.agent_type },
      { consumer: 'h19' }
    );
    startPhase = 'settled';
    if (resolution.source === 'unattributable') {
      unattributableLine = notStagedLine(resolution.case);
    }

    const prompts = typeof resolution.prompt === 'string' ? [resolution.prompt] : [];
    // PATH + SUBJECT STAGING is the shared lib's (scripts/hooks/lib/stage-brief.mjs,
    // also called by the OpenCode context hook); only the brief's source differs.
    // The chrome (plan line, TDD posture, unattributable-start line, return
    // contract) is folded into the SAME assembleDelivery call there, so the cap is
    // charged on the FINAL composed context.
    // READ-ONLY LANE EXCEPTION (user ruling 2026-09-28): a lane holding no
    // file-write tool (agent_type is on SubagentStart's stdin) gets hazards as
    // discovery POINTERS — see h19-knowledge-delivery.mjs.
    const staged = stageBrief({
      store,
      cwd: input.cwd,
      prompts,
      guardId: { agentId: input.agent_id, sessionId: input.session_id },
      hazardMode: hazardLaneMode(input, input.cwd),
      leadingChrome: activePlanLine ? [activePlanLine] : [],
      trailingChrome: [
        ...(tddPostureLine ? [tddPostureLine] : []),
        ...(unattributableLine ? [unattributableLine] : []),
        ...(!EXEMPT_AGENT_TYPES.has(input.agent_type) ? [RETURN_CONTRACT] : []),
      ],
    });
    // A domain or config.json the fan could not read is one loud stderr line; the
    // project store's staging above is unaffected.
    warnFanDegraded(store, 'H19');
    if (!staged) return finish('');
    const out = staged.text;

    // Side effect first, guard second (the ordering rule mirrored from
    // h19-knowledge-delivery.mjs): a throw before this line leaves the guard
    // untouched, so a later touch of the same territory — the main file-touch
    // hook, or a later dispatch — still delivers it. The return contract (h28
    // fold) rides the SAME emission, so a fresh knowledge payload and the return
    // contract never clobber each other in two separate writes.
    // THE ORDERING IS MECHANICAL: the guard write rides `onWritten`, so it runs
    // only after the stream has actually taken the envelope — a failed write
    // leaves every staged record eligible for the next dispatch, and the process
    // exits non-zero rather than reporting a clean staging.
    if (!out) {
      staged.record();
      return allow();
    }
    return exitAfterWrite(envelope(out), 0, { onWritten: staged.record });
  } catch (e) {
    // Staging is an aid, never a gate: internal failure is loud but NON-blocking
    // (P5 visibility without an AC7-style violation). The return contract (h28
    // fold) must still land on a throw here — pre-fold it ran in its own
    // process and was unaffected by an h19 crash (a malformed config, a
    // store-query throw, a render throw all now share this one process).
    // THE HELPER HOLDS THE ONE-ENVELOPE RULE: if an envelope already went out
    // above, this second payload is suppressed and disclosed on stderr and that
    // write's exit 0 carries; an EXEMPT agent still gets nothing, since
    // combinedContext('') reduces to '' for it exactly as it does elsewhere.
    // EXIT CODE IS LOAD-BEARING when the contract is delivered: a hook that
    // exits NONZERO cannot rely on the platform honoring its hookSpecificOutput,
    // so a catch-emit followed by exit 1 would be theatre — the failure note
    // rides stderr (try-wrapped) and the process exits 0, exactly the finish('')
    // shape the review prescribed. Only when NOTHING can be emitted (an exempt
    // agent, or a failed write) does the warnNonBlocking exit-1 posture remain,
    // preserving the platform's failed-hook signal — and warnNonBlocking is
    // itself pending-aware, so it never lowers a delivered envelope's exit 0.
    try {
      process.stderr.write(`H19: dispatch staging failed: ${(e && e.message) || e}\n`);
    } catch {
      /* a failed stderr note must not change the delivery outcome */
    }
    if (startPhase === 'store') unattributableLine = notStagedLine('store-unavailable');
    else if (startPhase === 'resolution') unattributableLine = notStagedLine('resolution-failed');
    const out = combinedContext('');
    if (out) return exitAfterWrite(envelope(out), 0);
    return warnNonBlocking(`H19: dispatch staging failed and nothing was emitted`);
  }
}

main(input);
