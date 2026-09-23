// H16 — session-event register (spec §6, run r-0501). PostToolUse
// WebSearch|WebFetch|Task|Agent. Records research and agent-dispatch events
// to .sterling/transient/session-events.json in direct mode.
// Missing store: allow, no recording (fail-open, mirrors H7).
// Never deduplicates: the register is a pure append log.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readStdin, allow, warnNonBlocking, openStore } from './lib/common.mjs';

const input = readStdin();
const store = openStore(input.cwd);
if (!store) allow();

try {
  // direct mode: derive kind + detail from the tool call, then append
  const tool = input.tool_name;
  let kind, detail;
  if (tool === 'WebSearch') {
    kind = 'research_tool';
    detail = String(input.tool_input?.query ?? '');
  } else if (tool === 'WebFetch') {
    kind = 'research_tool';
    detail = String(input.tool_input?.url ?? '');
  } else {
    // Task or Agent
    kind = 'agent_dispatch';
    detail = String(input.tool_input?.subagent_type ?? '');
  }

  const event = { kind, detail, at: new Date().toISOString() };
  // Board d33d8ac4: an agent_dispatch event's OWN H22 register entry is only
  // joinable if the event carries the id that entry is keyed by. PostToolUse
  // on a background Task|Agent dispatch returns it at launch as
  // tool_response.agentId — the same field H22 itself reads authoritatively
  // (scripts/lib/dispatch-register.mjs recordDispatchPost, `tr.agentId`).
  // WebSearch/WebFetch have no dispatch to join and never carry this field.
  if (kind === 'agent_dispatch') {
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

  const eventsPath = join(input.cwd, '.sterling', 'transient', 'session-events.json');
  mkdirSync(dirname(eventsPath), { recursive: true });
  const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
  events.push(event);
  writeFileSync(eventsPath, JSON.stringify(events));
  allow();
} catch (e) {
  warnNonBlocking(`H16: session-event registration failed: ${e.message}`);
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
