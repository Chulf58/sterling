// H16 — session-event register (spec §6, run r-0501). PostToolUse
// WebSearch|WebFetch|Task|Agent. Records research and agent-dispatch events
// to .sterling/transient/session-events.json in direct mode.
// Missing store: allow, no recording (fail-open, mirrors H7).
// Never deduplicates: the register is a pure append log.
import { readStdin, allow, warnNonBlocking, openStoreOrDegrade } from './lib/common.mjs';
import { appendSessionEvent, researchToolEvent } from './lib/session-events.mjs';

const input = readStdin();
const store = openStoreOrDegrade(input.cwd, 'H16');
if (!store) allow();

try {
  // direct mode: derive kind + detail from the tool call, then append
  const tool = input.tool_name;
  const at = new Date().toISOString();
  let event;
  if (tool === 'WebSearch' || tool === 'WebFetch') {
    event = researchToolEvent(tool === 'WebSearch' ? input.tool_input?.query : input.tool_input?.url, { at, agentId: input.agent_id });
  } else {
    // Task or Agent
    event = { kind: 'agent_dispatch', detail: String(input.tool_input?.subagent_type ?? ''), at };
  }
  // Board d33d8ac4: an agent_dispatch event's OWN H22 register entry is only
  // joinable if the event carries the id that entry is keyed by. PostToolUse
  // on a background Task|Agent dispatch returns it at launch as
  // tool_response.agentId — the same field H22 itself reads authoritatively
  // (scripts/lib/dispatch-register.mjs recordDispatchPost, `tr.agentId`).
  //
  // A WebSearch/WebFetch made INSIDE a subagent also reaches this hook (the
  // matcher fires on subagent tool calls), and its hook input carries the
  // subagent's own agent_id (docs/historical/PROBES.md, Layer 0 probe: present
  // on every in-subagent hook event). Decision
  // subagent-web-research-is-tagged-and-gated-on-lane-return: record it, so H10
  // owes that research only after the lane returns. Its tool_use_id is the web
  // call's own, never a launch id, so it is deliberately not recorded: H10's
  // join would otherwise treat a register row's launch tool_use_id as another
  // round's. A conductor web call has no agent_id and stays untagged.
  // (researchToolEvent above adds that agent_id.)
  if (event.kind === 'agent_dispatch') {
    const agentId = input.tool_response?.agentId;
    if (typeof agentId === 'string' && agentId !== '') event.agent_id = agentId;
    // Sol review HIGH (board d33d8ac4): agent_id alone recurs across ROUNDS
    // of the SAME dispatch (a resumed agent keeps its id) and across
    // sessions, so it is not a unique join key on its own. tool_use_id IS
    // unique per launch — the same id H22 records on its dispatch-state
    // record (recordDispatchPre/Post, scripts/lib/dispatch-register.mjs) and,
    // via the state-machine resolver, on the register entry itself
    // (h22-dispatch-register.mjs SubagentStart). PostToolUse's own
    // tool_use_id is the exact join key H10 prefers; agent_id (+ session)
    // stays as the fallback when a round carries no tool_use_id at all.
    if (typeof input.tool_use_id === 'string' && input.tool_use_id !== '') event.tool_use_id = input.tool_use_id;
  }

  appendSessionEvent(input.cwd, event);
  allow();
} catch (e) {
  warnNonBlocking(`H16: session-event registration failed: ${e.message}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
