// research_tool events on OpenCode. On Claude Code H16 records each WebSearch/WebFetch
// into the session-event register, and settlement's research_owed duty is weighed from
// those events; without this recorder the duty could never fire on OpenCode. It writes
// the same shape through H16's writer (scripts/hooks/lib/session-events.mjs).
// Tool names and argument shapes measured in the OpenCode 2.0.21 binary: webfetch {url}
// and websearch {query} (its permission defaults and tool-title switch name both).
// Only a completed call is recorded, as PostToolUse fires only after a tool succeeds.
// Events are untagged: H16's agent_id tag for in-subagent research has no OpenCode
// counterpart in settlement, so a subagent's web call counts like the main session's.
// A completed subagent call is recorded as an agent_dispatch event in H16's shape:
// detail is the agent name (sterling/researcher on OpenCode), agent_id the child
// session (the result's metadata.sessionID) and tool_use_id the call id.
import { appendSessionEvent, researchToolEvent } from '../../../scripts/hooks/lib/session-events.mjs';
import { childSessionOf } from './dispatch.mjs';

/** The argument each web research tool's detail comes from. */
export const RESEARCH_TOOLS = { webfetch: 'url', websearch: 'query' };

/** H16's agent_dispatch event for a completed subagent call. */
function agentDispatchEvent(input, at) {
  const event = { kind: 'agent_dispatch', detail: String(input.input?.agent ?? ''), at };
  const child = childSessionOf(input);
  if (child) event.agent_id = child;
  if (typeof input.id === 'string' && input.id !== '') event.tool_use_id = input.id;
  return event;
}

/** The execute.after handler that records a completed web research call or subagent dispatch. */
export function createResearchRecorder({ rootOf, fenced, now }) {
  return async function onAfter(input) {
    if (input?.tool === 'subagent' && input.status === 'completed') {
      const root = rootOf();
      if (!root) return;
      await fenced('research', root, () => appendSessionEvent(root, agentDispatchEvent(input, now())));
      return;
    }
    const field = Object.hasOwn(RESEARCH_TOOLS, input?.tool) ? RESEARCH_TOOLS[input.tool] : null;
    if (!field || input.status !== 'completed') return;
    const root = rootOf();
    if (!root) return;
    await fenced('research', root, () => appendSessionEvent(root, researchToolEvent(input.input?.[field], { at: now() })));
  };
}
