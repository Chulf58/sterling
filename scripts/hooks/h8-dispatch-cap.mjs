// H8 — dispatch cap (spec §6 H8). PreToolUse Task|Agent, blocking exit-2.
// Probe-verified (step 5): subagent spawning IS a PreToolUse tool call
// (tool_name 'Agent', tool_input.subagent_type) and exit 2 blocks the spawn —
// current docs claim otherwise (SubagentStart-only); the probe wins.
// Increment the per-agent-type run counter; over cap → deny + escalate.
// Respawns count under this cap (§5.1).
import { readStdin, deny, allow, loadConfig, openStore } from './lib/common.mjs';
import { AGENT_MODEL_KEY } from '@sterling/schemas';

// The guarded pipeline agent types = the registered Sterling roster (the keys of
// AGENT_MODEL_KEY — registry-backed, one source of truth). A platform-default
// type like 'general-purpose' is not a member, so it is never slice-guarded.
const PIPELINE_AGENT_TYPES = new Set(Object.keys(AGENT_MODEL_KEY));

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
  return (
    `H8: pipeline dispatch of '${agentType}' during an active run carries no knowledge slice. ` +
    `Every guarded dispatch must include, on its own line, either the prep-stamped marker ` +
    `'STERLING-SLICE run=<id> phase=<id> role=<role> staged=<ISO>' (paste the reviewer/builder ` +
    `dispatch_slice prep wrote), or 'SLICE-WAIVED: <reason>' to waive by convention (fixer-mode). ` +
    `Neither was present — spawning is denied (§7.4). A slice-denied dispatch consumes no cap slot.`
  );
}

const input = readStdin();
const agentType = input.tool_input?.subagent_type;
if (!agentType) allow();

const store = openStore(input.cwd);
if (!store) allow();

try {
  const run = store.getRun();
  if (!run || run.machine_state !== 'running') allow(); // the cap is per-run

  // Slice-presence check ORDERED BEFORE the cap increment: a denied dispatch
  // consumes no cap slot and is not a cap escalation (decision 628c4b7f (e)).
  const sliceDeny = sliceDenial(agentType, input.tool_input?.prompt);
  if (sliceDeny) deny(sliceDeny);

  const cap = loadConfig(input.cwd)?.caps?.dispatch_per_agent_type ?? 25;
  const current = run.dispatch_counts[agentType] ?? 0;
  if (current + 1 > cap) {
    store.appendRunEscalation(run.id, {
      kind: 'dispatch_cap_exceeded',
      agent_type: agentType,
      cap,
      at: new Date().toISOString(),
    });
    deny(
      `H8: dispatch cap exceeded — '${agentType}' has been dispatched ${current}x this run (cap ${cap}). This run is looping; escalate to the human instead of spawning again (§5.1).`
    );
  }
  store.incrementDispatchCount(run.id, agentType);
  allow();
} finally {
  store.close();
}
