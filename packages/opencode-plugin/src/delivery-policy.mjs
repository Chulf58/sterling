// The STERLING-DELIVERY policy of an OpenCode session (decision
// blind-lane-sterling-delivery-off-brief-line, point 4; GitHub #88). A child
// (subagent) session whose brief carries `STERLING-DELIVERY: off` gets no store
// records from child staging (context.mjs), the file-touch and shell delivery
// (delivery.mjs) or the output axis (axis.mjs). A root session is never blinded.
//
// The in-memory map below is a CACHE, never the authority: a session missing
// from it (a new process after a plugin reload, an evicted entry) has its policy
// derived again from its own first user message, read through ctx.session.context
// when the caller has no messages at hand (the tool hooks), combined with the
// dispatch-state record the subagent call wrote (dispatch.mjs -> recordDispatchPre
// stores `delivery: 'off'`, read through readDeliveryPolicy). The brief is parsed
// whole, before staging's scan cap (staging.mjs rawBriefOf).
//
// Resolution, first answer wins:
//   - cached 'off' or 'on' -> that ('off' is never replaced by 'on')
//   - session kind unknown (session.get failed) -> 'unknown' when an off lane
//     may exist (an off session cached here, a live off dispatch record, or
//     unreadable dispatch state), else 'on'
//   - root -> 'on'
//   - child, brief readable -> 'off' when the brief or its own dispatch record
//     says off, else 'on'
//   - child, brief unreadable -> readDeliveryPolicy's answer (own record, else
//     'unknown' beside a live off sibling of the same parent); 'on' becomes
//     'unknown' when this process saw an off child of the same parent
// 'unknown' is never cached, so the next call tries again. Suppressing callers
// disclose with slice A's notices (dispatch-prompt.mjs), which name no records.
import { deliveryPolicyNotice, parseSterlingDelivery } from '../../../scripts/hooks/lib/dispatch-prompt.mjs';
import { readDeliveryPolicy, readDispatchState } from '../../../scripts/lib/dispatch-register.mjs';
import { remember } from './bounded.mjs';
import { sessionKind } from './dispatch.mjs';
import { errText, logLine } from './log.mjs';
import { rawBriefOf } from './staging.mjs';

/** The messages ctx.session.context returns for `sessionID` (OpenCode 2.0.23: "all messages after the last compaction"). */
async function contextMessages(session, sessionID) {
  if (typeof session?.context !== 'function') throw new Error('ctx.session.context is unavailable');
  const got = await session.context({ sessionID });
  const messages = Array.isArray(got) ? got : got?.data;
  if (!Array.isArray(messages)) throw new Error(`ctx.session.context answered ${got === null ? 'null' : typeof got} for session ${sessionID}, not a message list`);
  return messages;
}

/**
 * One location's policy tracker. `getSession()` returns ctx.session; `parents` is the
 * location's shared session-to-parentID cache (dispatch.mjs sessionKind).
 * resolve(root, sessionID, messages?) -> 'on' | 'off' | 'unknown'; pass `messages`
 * when the caller has them (the context hook), else they are read from the session.
 * disclose(sessionID, policy) -> the notice for a suppressing policy the first time
 * it is due in that session, else ''. markDisclosed(sessionID, policy) records a
 * notice delivered another way (the staged system prompt).
 */
export function createDeliveryPolicy({ getSession, parents, readPolicy = readDeliveryPolicy, readState = readDispatchState }) {
  const policies = new Map();
  const disclosed = new Map();

  /** Whether an off lane may exist: one cached here, a live off dispatch record, or dispatch state that cannot be read. */
  function offLaneMayExist(root) {
    for (const p of policies.values()) if (p === 'off') return true;
    const scan = readState(root);
    if (scan.availability === 'absent') return false;
    if (scan.availability !== 'ok' || scan.poisoned.length > 0) return true;
    return scan.records.some(({ record }) => !record.terminal && record.delivery === 'off');
  }

  function offSiblingSeen(sessionID, parentID) {
    for (const [id, p] of policies) if (p === 'off' && id !== sessionID && parents.get(id) === parentID) return true;
    return false;
  }

  async function resolve(root, sessionID, messages) {
    const cached = policies.get(sessionID);
    if (cached !== undefined) return cached;
    const kind = await sessionKind(getSession?.(), sessionID, parents);
    if (kind.why) {
      let may;
      try {
        may = offLaneMayExist(root);
      } catch (e) {
        logLine(root, `delivery policy: the dispatch state could not be scanned (${errText(e)})`);
        may = true;
      }
      if (may) logLine(root, `delivery policy: session ${sessionID} could not be classified (${kind.why}) while an off lane may exist, so delivery is held back`);
      return may ? 'unknown' : 'on';
    }
    if (kind.kind === 'root') return remember(policies, sessionID, 'on');
    const parentID = parents.get(sessionID);
    let brief = '';
    if (messages !== undefined) brief = rawBriefOf(messages);
    else {
      try {
        brief = rawBriefOf(await contextMessages(getSession?.(), sessionID));
      } catch (e) {
        logLine(root, `delivery policy: the brief of child session ${sessionID} could not be read (${errText(e)}); the dispatch state decides`);
      }
    }
    const recorded = readPolicy(root, { session_id: parentID, agent_id: sessionID });
    let policy;
    if (brief) policy = parseSterlingDelivery(brief).policy === 'off' || recorded === 'off' ? 'off' : 'on';
    else policy = recorded === 'on' && offSiblingSeen(sessionID, parentID) ? 'unknown' : recorded;
    if (policy !== 'unknown') remember(policies, sessionID, policy);
    return policy;
  }

  function markDisclosed(sessionID, policy) {
    const seen = disclosed.get(sessionID) ?? new Set();
    seen.add(policy);
    remember(disclosed, sessionID, seen);
  }

  function disclose(sessionID, policy) {
    const notice = deliveryPolicyNotice(policy);
    if (!notice || disclosed.get(sessionID)?.has(policy)) return '';
    markDisclosed(sessionID, policy);
    return notice;
  }

  return { resolve, disclose, markDisclosed };
}
