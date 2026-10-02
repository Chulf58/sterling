// The session-event register: <project>/.sterling/transient/session-events.json, a
// compact JSON array that is only ever appended to (never deduplicated). H16 on Claude
// Code and the OpenCode plugin's research recorder (packages/opencode-plugin/src/
// research.mjs) write research_tool events through this one writer, so both hosts
// record the same shape and H10 and the plugin's settlement read one format.
// Builtins only: hooks and the OpenCode server bundle vendor this module.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SESSION_EVENTS_REL = join('.sterling', 'transient', 'session-events.json');

/**
 * A research_tool event: detail is the search query or the fetched url. agentId tags a
 * web call made inside a subagent (decision subagent-web-research-is-tagged-and-gated-on-lane-return);
 * an empty or missing one leaves the event untagged.
 */
export function researchToolEvent(detail, { at = new Date().toISOString(), agentId } = {}) {
  const event = { kind: 'research_tool', detail: String(detail ?? ''), at };
  if (typeof agentId === 'string' && agentId !== '') event.agent_id = agentId;
  return event;
}

/** Append one event to the project's register, creating it. An unparsable register throws and is left as it is. */
export function appendSessionEvent(projectDir, event) {
  const eventsPath = join(projectDir, SESSION_EVENTS_REL);
  mkdirSync(dirname(eventsPath), { recursive: true });
  const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
  events.push(event);
  writeFileSync(eventsPath, JSON.stringify(events));
}
