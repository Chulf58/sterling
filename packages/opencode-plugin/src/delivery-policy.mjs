// The STERLING-DELIVERY policy of an OpenCode session (decision
// blind-lane-sterling-delivery-off-brief-line, point 4; GitHub #88). A child
// (subagent) session whose brief carries `STERLING-DELIVERY: off` gets no store
// records from child staging (context.mjs), the file-touch and shell delivery
// (delivery.mjs) or the output axis (axis.mjs). A root session is never blinded.
//
// The in-memory maps below are a CACHE, never the authority: a session missing
// from them (a new process after a plugin reload, an evicted entry) has its
// policy derived again. Evidence sources and what each may establish:
//   - the context hook's messages (model-request shape {role, content}): the
//     child's brief as OpenCode sends it, parsed whole before staging's scan cap
//     (staging.mjs rawBriefOf). It may establish 'off', and 'on' (exact
//     attribution: a child's brief is its own first user message).
//   - ctx.session.context (durable messages; OpenCode 2.0.23 Session.Message.User
//     is {id, metadata?, time, type: 'user', text, files?, agents?, skills?}, read
//     from the 2.0.23 binary). It holds only the messages after the last
//     compaction, so its first user message may be "Continue", not the brief:
//     an off line in ANY user message establishes 'off'; it never establishes 'on'.
//   - the dispatch-state record the subagent call wrote (dispatch.mjs ->
//     recordDispatchPre stores `delivery: 'off'`), read through readDeliveryPolicy.
//
// Resolution:
//   - 'off' is monotonic: once seen for a session it is never replaced, and every
//     resolution re-checks it before answering, so an older overlapping call
//     cannot answer 'on' after a newer one established 'off'
//   - session kind unknown (session.get failed) -> 'unknown' when an off lane
//     may exist (an off session cached here, a live off dispatch record, or
//     unreadable dispatch state), else 'on'
//   - root -> 'on'
//   - child: 'off' from any source above; else 'on' when the context hook's
//     brief was seen; else readDeliveryPolicy's answer (own record, else
//     'unknown' beside a live off sibling of the same parent), with 'on' turned
//     into 'unknown' when this process saw an off child of the same parent
// Only 'off' and the brief-seen fact are cached; the dispatch state is read on
// each resolution, so later off evidence there is never shadowed by a cached 'on'.
// Suppressing callers disclose with slice A's notices (dispatch-prompt.mjs),
// which name no records.
import { deliveryPolicyNotice, parseSterlingDelivery } from '../../../scripts/hooks/lib/dispatch-prompt.mjs';
import { readDeliveryPolicy, readDispatchState } from '../../../scripts/lib/dispatch-register.mjs';
import { remember } from './bounded.mjs';
import { sessionKind } from './dispatch.mjs';
import { errText, logLine } from './log.mjs';
import { rawBriefOf } from './staging.mjs';

/** The texts of the user messages ctx.session.context returns for `sessionID`: durable Session.Message.User only ({type: 'user', text}). */
async function contextUserTexts(session, sessionID) {
  if (typeof session?.context !== 'function') throw new Error('ctx.session.context is unavailable');
  const got = await session.context({ sessionID });
  const messages = Array.isArray(got) ? got : got?.data;
  if (!Array.isArray(messages)) throw new Error(`ctx.session.context answered ${got === null ? 'null' : typeof got} for session ${sessionID}, not a message list`);
  return messages.filter((m) => m?.type === 'user' && typeof m.text === 'string').map((m) => m.text);
}

/** Whether the first user message of model-request `messages` (the context hook's) carries the off directive, and whether it is readable at all. */
function briefPolicy(messages) {
  const brief = rawBriefOf(messages);
  return { readable: brief !== '', off: parseSterlingDelivery(brief).policy === 'off' };
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
  // Sessions established off (never removed but by the size cap), roots, and children whose brief the context hook showed.
  const off = new Map();
  const roots = new Map();
  const briefSeen = new Map();
  // Children whose durable context was read without an off line, so it is not fetched again.
  const contextRead = new Map();
  const disclosed = new Map();

  /** Whether an off lane may exist: one cached here, a live off dispatch record, or dispatch state that cannot be read. */
  function offLaneMayExist(root) {
    if (off.size > 0) return true;
    const scan = readState(root);
    if (scan.availability === 'absent') return false;
    if (scan.availability !== 'ok' || scan.poisoned.length > 0) return true;
    return scan.records.some(({ record }) => !record.terminal && record.delivery === 'off');
  }

  function offSiblingSeen(sessionID, parentID) {
    for (const id of off.keys()) if (id !== sessionID && parents.get(id) === parentID) return true;
    return false;
  }

  const setOff = (sessionID) => (remember(off, sessionID, true), 'off');

  async function resolve(root, sessionID, messages) {
    if (off.has(sessionID)) return 'off';
    if (roots.has(sessionID)) return 'on';
    const kind = await sessionKind(getSession?.(), sessionID, parents);
    if (off.has(sessionID)) return 'off';
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
    if (kind.kind === 'root') {
      remember(roots, sessionID, true);
      return 'on';
    }
    if (messages !== undefined) {
      const brief = briefPolicy(messages);
      if (brief.off) return setOff(sessionID);
      if (brief.readable) remember(briefSeen, sessionID, true);
    } else if (!briefSeen.has(sessionID) && !contextRead.has(sessionID)) {
      try {
        const texts = await contextUserTexts(getSession?.(), sessionID);
        if (texts.some((t) => parseSterlingDelivery(t).policy === 'off')) return setOff(sessionID);
        remember(contextRead, sessionID, true);
      } catch (e) {
        logLine(root, `delivery policy: the durable context of child session ${sessionID} could not be read (${errText(e)}); the dispatch state decides`);
      }
      if (off.has(sessionID)) return 'off';
    }
    const parentID = parents.get(sessionID);
    const recorded = readPolicy(root, { session_id: parentID, agent_id: sessionID });
    if (recorded === 'off' || off.has(sessionID)) return setOff(sessionID);
    if (briefSeen.has(sessionID)) return 'on';
    return recorded === 'on' && offSiblingSeen(sessionID, parentID) ? 'unknown' : recorded;
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
