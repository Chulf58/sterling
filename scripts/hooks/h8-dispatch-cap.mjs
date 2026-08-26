// H8 — dispatch cap (spec §6 H8). PreToolUse Task|Agent, blocking exit-2.
// Probe-verified (step 5): subagent spawning IS a PreToolUse tool call
// (tool_name 'Agent', tool_input.subagent_type) and exit 2 blocks the spawn —
// current docs claim otherwise (SubagentStart-only); the probe wins.
// Increment the per-agent-type run counter; over cap → deny + escalate.
// Respawns count under this cap (§5.1).
import { readStdin, deny, allow, loadConfig, openStore, withRetry } from './lib/common.mjs';
import { PIPELINE_AGENT_TYPES } from '@sterling/schemas';

// The guarded set is the registry's PIPELINE class only (AGENT_CLASS-derived,
// one source of truth). It was previously the keys of AGENT_MODEL_KEY — i.e.
// the whole roster — which silently enrolled the conductor-direct agents
// (librarian, debugger) in slice-guarding and cap-counting the moment they were
// registered: a mid-run dispatch was denied for lacking a knowledge slice it was
// never meant to carry. A platform-default type like 'general-purpose' is not a
// member either, so it is never slice-guarded.

// Slice-presence guard (decision 628c4b7f (e)): during an active run a guarded
// pipeline dispatch must carry either the prep-stamped STERLING-SLICE marker or
// a SLICE-WAIVED: <reason> line (fixer-mode waives by convention). Returns a
// deny message when neither is present, else null. Line-anchored, multiline.
const SLICE_MARKER_RE = /^STERLING-SLICE /m;
const SLICE_WAIVER_RE = /^SLICE-WAIVED: .+/m;
export function sliceDenial(agentType, prompt) {
  if (!PIPELINE_AGENT_TYPES.has(agentType)) return null;
  const text = typeof prompt === 'string' ? prompt : '';
  if (SLICE_MARKER_RE.test(text) || SLICE_WAIVER_RE.test(text)) return null;
  // FORMATTING vs ABSENCE. Both regexes are LINE-ANCHORED (/^…/m), so a marker
  // that is present but indented, bulleted, inside a fence, or trailing other prose
  // on its line does not match — and "Neither was present" then reads as a
  // falsehood to a caller looking straight at the token in the prompt it just sent.
  // That is resolved by trial-and-error re-indenting, which is exactly the H14
  // quoting failure. Distinguish the two, and for the waiver name the empty-reason
  // case ('SLICE-WAIVED:' with nothing after it fails the `.+`).
  const looseMarker = /STERLING-SLICE/.test(text);
  const looseWaiver = /SLICE-WAIVED/.test(text);
  let why;
  if (looseMarker || looseWaiver) {
    const token = looseMarker ? 'STERLING-SLICE' : 'SLICE-WAIVED';
    why =
      `The text '${token}' IS present but did not match: both forms are LINE-ANCHORED, so the token must start its own line ` +
      `with nothing before it — not indented, not bulleted, not inside a code fence, and not appended after other prose. ` +
      (looseWaiver && !looseMarker ? `A waiver also needs a non-empty reason after the colon. ` : '') +
      `Move it to column 0 of its own line and redispatch.`;
  } else {
    why = `Neither token appears anywhere in the prompt — spawning is denied (§7.4).`;
  }
  return (
    `H8: pipeline dispatch of '${agentType}' during an active run carries no knowledge slice. ` +
    `Every guarded dispatch must include, on its own line, either the prep-stamped marker ` +
    `'STERLING-SLICE run=<id> phase=<id> role=<role> staged=<ISO>' (paste the reviewer/builder ` +
    `dispatch_slice prep wrote), or 'SLICE-WAIVED: <reason>' to waive by convention (fixer-mode). ` +
    `${why} A slice-denied dispatch consumes no cap slot.`
  );
}

// Breadth backstop (two-axis phase discipline, decision 288936ab): a guarded
// dispatch whose STERLING-SLICE marker names a phase over the configured
// split_interface_threshold is denied — bigness is a decomposition failure
// (P7), never absorbed at dispatch. Ordered AFTER sliceDenial (the marker must
// already be present to be judged) and BEFORE the cap increment: a
// breadth-denied dispatch consumes no cap slot. Markerless/SLICE-WAIVED
// prompts and phase ids absent from the brief are not this guard's business —
// they fall through to the slice guard or pass unchecked, same as before.
const BREADTH_MARKER_RE = /^STERLING-SLICE run=\S+ phase=(\S+) role=\S+ staged=\S+$/m;
export function breadthDenial(prompt, brief, config) {
  const text = typeof prompt === 'string' ? prompt : '';
  const match = BREADTH_MARKER_RE.exec(text);
  if (!match) return null; // no marker to judge — sliceDenial's business, not this guard's
  const phaseId = match[1];
  const phase = brief?.phases?.find((p) => p.phase_id === phaseId);
  if (!phase) return null; // unknown phase — never judged here
  const threshold = config?.difficulty?.split_interface_threshold ?? 3;
  const count = (phase.interfaces ?? []).length;
  if (count <= threshold) return null;
  return (
    `H8: pipeline dispatch names phase '${phaseId}', which is over-wide — ${count} interfaces exceeds ` +
    `the split threshold (${threshold}). An over-wide phase is a decomposition failure (P7): split it into ` +
    `narrower phases at planning, then re-dispatch. Spawning is denied — a breadth-denied dispatch consumes no cap slot.`
  );
}

const input = readStdin();
const agentType = input.tool_input?.subagent_type;
if (!agentType) allow();

// A BLOCKING gate that cannot verify must DENY, never void itself via an
// uncaught exit-1 (decision 2422e76a's fail-closed rule; audit finding 5/43).
let store;
try {
  store = openStore(input.cwd);
  if (!store) allow();

  const run = withRetry(() => store.getRun());
  if (!run || run.machine_state !== 'running') allow(); // the cap is per-run

  // Slice-presence check ORDERED BEFORE the cap increment: a denied dispatch
  // consumes no cap slot and is not a cap escalation (decision 628c4b7f (e)).
  const prompt = input.tool_input?.prompt;
  const sliceDeny = sliceDenial(agentType, prompt);
  if (sliceDeny) deny(sliceDeny);

  const config = loadConfig(input.cwd);

  // Breadth check: needs the run's brief to see the named phase's interface
  // count. Loaded only here (not in the slice-denied path above), and it must
  // still run BEFORE the cap increment (decision 628c4b7f (e) extended).
  const brief = run.brief_ref ? withRetry(() => store.get(run.brief_ref)) : null;
  const breadthDeny = breadthDenial(prompt, brief, config);
  if (breadthDeny) deny(breadthDeny);

  const cap = config?.caps?.dispatch_per_agent_type ?? 25;
  const current = run.dispatch_counts[agentType] ?? 0;
  if (current + 1 > cap) {
    withRetry(() =>
      store.appendRunEscalation(run.id, {
        kind: 'dispatch_cap_exceeded',
        agent_type: agentType,
        cap,
        at: new Date().toISOString(),
      })
    );
    deny(
      `H8: dispatch cap exceeded — '${agentType}' has been dispatched ${current}x this run (cap ${cap}). This run is looping; escalate to the human instead of spawning again (§5.1). ` +
        `This denial repeats by design for every further dispatch of that type in this run — it is the terminal per-run loop cap (§5.1), not a retryable hook failure.`
    );
  }
  withRetry(() => store.incrementDispatchCount(run.id, agentType));
  allow();
} catch (e) {
  deny(`H8: dispatch gate failed (${(e && e.message) || e}) — failing closed (P5); retry the dispatch`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
