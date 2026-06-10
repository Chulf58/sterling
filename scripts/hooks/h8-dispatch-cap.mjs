// H8 — dispatch cap (spec §6 H8). PreToolUse Task|Agent, blocking exit-2.
// Probe-verified (step 5): subagent spawning IS a PreToolUse tool call
// (tool_name 'Agent', tool_input.subagent_type) and exit 2 blocks the spawn —
// current docs claim otherwise (SubagentStart-only); the probe wins.
// Increment the per-agent-type run counter; over cap → deny + escalate.
// Respawns count under this cap (§5.1).
import { readStdin, deny, allow, loadConfig, openStore } from './lib/common.mjs';

const input = readStdin();
const agentType = input.tool_input?.subagent_type;
if (!agentType) allow();

const store = openStore(input.cwd);
if (!store) allow();

try {
  const run = store.getRun();
  if (!run || run.machine_state !== 'running') allow(); // the cap is per-run

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
