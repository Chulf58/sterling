// The dispatch register (H22) on OpenCode 2, and the root-session gate settlement uses.
//
// H22's Pre/Post/Failure arms on Claude Code's Task|Agent tool map onto the
// subagent tool: execute.before records the dispatch (recordDispatchPre, keyed by
// the tool call id); a completed execute.after binds the child session
// (recordDispatchPost); a failed one is terminal (recordDispatchFailure). The
// child session id is the subagent result's metadata.sessionID, read from the
// OpenCode 2.0.21 binary (`metadata:{sessionID,status}`), not measured in a live run.
// Post's prompt check compares the call's own input with itself: execute.after
// carries the same call id and input as execute.before, so the pairing holds by
// construction rather than by an echoed prompt.
//
// OpenCode has no SubagentStop. A foreground subagent has finished when its call
// returns, so that dispatch is ended there; a background one (background: true)
// is ended when its child session's execution ends (endChildDispatch, called from
// the settlement gate). TaskStop has no OpenCode equivalent and is not handled.
//
// Every state write goes through scripts/lib/dispatch-register.mjs, the one owner
// of the record shape and the lock. Its disclosures go to the plugin log, as H22's
// go to stderr.
import { finishDispatchAndRegisterEnd, readDispatchState, readRegister, recordDispatchFailure, recordDispatchPost, recordDispatchPre } from '../../../scripts/lib/dispatch-register.mjs';
import { logLine } from './log.mjs';

/** The H22 stdin shape for an OpenCode subagent call. */
function claudeShape(input) {
  const args = input.input && typeof input.input === 'object' ? input.input : {};
  return { tool_use_id: input.id, session_id: input.sessionID, tool_input: { prompt: args.prompt, subagent_type: args.agent, description: args.description } };
}

/** The child session a completed subagent call names, or null. */
export function childSessionOf(input) {
  const id = input?.result?.metadata?.sessionID;
  return typeof id === 'string' && id ? id : null;
}

function logDisclosures(root, result) {
  for (const d of result?.disclosures ?? []) logLine(root, `dispatch register: ${d}`);
}

/** Live dispatch-state records bound to `sessionID` as their child. */
function boundTo(scan, sessionID) {
  return scan.records.filter(({ record: r }) => !r.terminal && (r.post_binding?.agent_id ?? r.derived_binding?.agent_id ?? r.started?.agent_id) === sessionID);
}

/** End every live dispatch whose child is `sessionID` (a background subagent's execution end). */
export async function endChildDispatch(root, sessionID) {
  const scan = readDispatchState(root);
  if (scan.availability !== 'ok') return;
  for (const { record } of boundTo(scan, sessionID)) {
    const finished = await finishDispatchAndRegisterEnd(root, { session_id: record.session_id, agent_id: sessionID });
    logDisclosures(root, finished);
  }
}

/**
 * Whether the dispatch register or the dispatch state shows `sessionID` as a
 * live child: a register round for it that has not ended, or a dispatch-state
 * record bound to it that is not terminal.
 */
export function liveChildInRegister(root, sessionID) {
  const reg = readRegister(root);
  if (reg.availability === 'ok' && reg.entries.some((e) => e.agent_id === sessionID && !e.ended)) return true;
  const scan = readDispatchState(root);
  return scan.availability === 'ok' && boundTo(scan, sessionID).length > 0;
}

/**
 * Decide whether a session.execution.succeeded for `sessionID` settles. Returns
 * { settle: true } for a root session, { settle: false } for a child (after
 * ending any background dispatch bound to it), and { settle: false, why } when
 * the session cannot be checked. Correct whether or not OpenCode emits the event
 * for child sessions: a child is recognised by its parentID or by the register,
 * and a session that cannot be checked is not settled (fail closed).
 * `parents` caches each session's parentID, which never changes.
 */
export async function rootSessionGate(root, { session, sessionID, parents }) {
  if (typeof sessionID !== 'string' || !sessionID) return { settle: false, why: 'the event carries no sessionID' };
  if (liveChildInRegister(root, sessionID)) {
    await endChildDispatch(root, sessionID);
    return { settle: false };
  }
  if (!parents.has(sessionID)) {
    try {
      if (!session || typeof session.get !== 'function') throw new Error('ctx.session.get is unavailable');
      const info = await session.get({ sessionID });
      parents.set(sessionID, info?.parentID ?? null);
    } catch (e) {
      return { settle: false, why: String((e && e.message) || e) };
    }
  }
  if (parents.get(sessionID)) {
    await endChildDispatch(root, sessionID);
    return { settle: false };
  }
  return { settle: true };
}

/** execute.before / execute.after for the subagent tool. */
export function createDispatchHandlers({ rootOf, fenced }) {
  async function onBefore(input) {
    if (input?.tool !== 'subagent') return;
    const root = rootOf();
    if (!root) return;
    await fenced('dispatch', root, async () => logDisclosures(root, await recordDispatchPre(root, claudeShape(input))));
  }

  async function onAfter(input) {
    if (input?.tool !== 'subagent') return;
    const root = rootOf();
    if (!root) return;
    await fenced('dispatch', root, async () => {
      const shape = claudeShape(input);
      if (input.status !== 'completed') {
        logDisclosures(root, await recordDispatchFailure(root, shape));
        return;
      }
      const child = childSessionOf(input);
      if (!child) {
        logLine(root, `dispatch register: subagent call ${input.id} returned no metadata.sessionID, so its child session was not bound`);
        return;
      }
      logDisclosures(root, await recordDispatchPost(root, { ...shape, tool_response: { agentId: child, prompt: shape.tool_input.prompt } }));
      if (input.input?.background !== true) logDisclosures(root, await finishDispatchAndRegisterEnd(root, { session_id: input.sessionID, agent_id: child }));
    });
  }

  return { onBefore, onAfter };
}
