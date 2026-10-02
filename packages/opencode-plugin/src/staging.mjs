// Child-session dispatch staging: H19's SubagentStart delivery for OpenCode
// (board cbee2b3d, audit f2ba68c2 row 24). A subagent's brief is the first user
// message of its own session, so attribution is exact by construction: no
// pending-dispatch register, no sidecar file, no guess between same-type
// siblings (decision h22-start-staging-only-when-attribution-is-unambiguous-no-sidecar).
// A child whose brief cannot be read is told its knowledge was not staged and
// to rely on its brief, the same loud degrade H19 prints. The staging itself
// (path and subject channels, the assembler, the plan, TDD and return-contract
// chrome) is scripts/hooks/lib/stage-brief.mjs, shared with h19-dispatch-staging.mjs.
// Hazards render whole: H19's read-only-lane pointer mode reads .claude/agents,
// a Claude Code surface that does not exist here.
import { EXEMPT_AGENT_TYPES, RETURN_CONTRACT, composeContext, dispatchChrome, stageBrief } from '../../../scripts/hooks/lib/stage-brief.mjs';

// A brief is a prompt, not a document: bound what is scanned.
const BRIEF_SCAN_CAP = 20_000;

/** The disclosure line a child gets when its brief could not be staged from. */
export function notStagedLine(kase) {
  return `STERLING DISPATCH STAGING (H19): this session's brief could not be staged from [${kase}] — YOUR KNOWLEDGE WAS NOT STAGED: no owning articles, hazards or decisions were delivered for your task. Do not assume the store is silent on it: rely on your dispatch brief for knowledge pointers and query the store for the area before acting. File-touch delivery still fires on your first read or edit.`;
}

/** The text of the session's first user message (its brief), or '' when there is none. */
export function briefOf(messages) {
  const first = Array.isArray(messages) ? messages.find((m) => m?.role === 'user') : null;
  if (!first) return '';
  const content = first.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '';
  return text.slice(0, BRIEF_SCAN_CAP);
}

/**
 * The context a child session gets for `brief`: the staged territory records
 * with the plan, TDD and return-contract chrome around them, or the chrome alone
 * when nothing governs the brief. `agent` is the child's OpenCode agent name (the
 * roster's implementor gets the TDD and plan lines). `disclosure` is a not-staged
 * line folded in beside the contract. `staged` is true when records were
 * delivered, so the caller keeps that text for the child's later requests: the
 * guard ledger is marked here, once, and would not deliver them again.
 */
export function stageChild({ store, root, sessionID, agent, brief, disclosure = '' }) {
  const chrome = dispatchChrome(root, agent);
  if (brief) {
    const built = stageBrief({
      store,
      cwd: root,
      prompts: [brief],
      guardId: { agentId: undefined, sessionId: sessionID },
      hazardMode: 'whole',
      leadingChrome: chrome.activePlanLine ? [chrome.activePlanLine] : [],
      trailingChrome: [
        ...(chrome.tddPostureLine ? [chrome.tddPostureLine] : []),
        ...(disclosure ? [disclosure] : []),
        ...(!EXEMPT_AGENT_TYPES.has(agent) ? [RETURN_CONTRACT] : []),
      ],
    });
    if (built) {
      built.record();
      return { text: built.text, staged: true };
    }
  }
  return { text: composeContext({ agentType: agent, ...chrome, unattributableLine: disclosure }), staged: false };
}
