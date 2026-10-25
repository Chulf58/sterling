// The rotation restore: gating on which session may consume the rotation note,
// and the per-process caches that keep the restore text across a session's turns
// (scripts/hooks/lib/rotation-restore.mjs, shared with H1).
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readLock as readPlanLock } from '../../../scripts/hooks/lib/plan-lock.mjs';
import { consumeRotationNote, readRotationNote, renderRotationRestore, rotationNotePath } from '../../../scripts/hooks/lib/rotation-restore.mjs';
import { adoptionText } from './claim-handover.mjs';
import { LOG_REL, errText, logLine } from './log.mjs';
import { addNotice } from './notices.mjs';
import { inWorkerChild } from './worker.mjs';

/**
 * `getSession()` returns the plugin's ctx.session (null before setup);
 * `renderRestore` defaults to the shared renderer; `adoptClaims(root, { from, to })`
 * moves the board claims session `from` holds in checkout `root` to session `to`
 * (store.adoptClaims, each entry with its `label`), or is absent. Inside the maintenance worker
 * child (`env`, worker.mjs inWorkerChild) the note is never read or consumed: the
 * worker's root session is not the session the user opens next.
 */
export function createRotationRestore({ getSession, now, renderRestore = renderRotationRestore, adoptClaims, env = process.env }) {
  // Restore text per session that consumed a rotation note, returned again on that
  // session's later prompts; context.mjs appends it only when it changed, so the
  // session sees it once. Process-lifetime only; a relaunched OpenCode does not re-send it.
  const restored = new Map();
  // Malformed rotation notes already announced, keyed by path and mtime: a note
  // that stays malformed is noticed once, not on every request.
  const malformedNoted = new Set();

  /**
   * The rotation restore for this request, or ''. The note is consumed only by
   * a ROOT session (no parentID) whose id differs from the note's session_id
   * and, when the session's created time is readable, that was created after
   * the note was written; otherwise the note stays for the session the user
   * opens next (decision on the P5 design hazard, conductor-ruled 2026-10-02).
   * A failed session lookup leaves the note, logs and notices; it never costs
   * the layer.
   */
  return async function rotationRestore(root, sessionID) {
    if (inWorkerChild(env)) return '';
    if (restored.has(sessionID)) return restored.get(sessionID);
    let note;
    try {
      note = readRotationNote(root);
    } catch (e) {
      // The note itself is unreadable (a parse failure): its cause and remedy
      // differ from a session-check failure, and it never clears on its own.
      const notePath = rotationNotePath(root);
      let key = notePath;
      try {
        key = `${notePath}@${statSync(notePath).mtimeMs}`;
      } catch {
        // the note vanished between the read and the stat; the path alone keys it
      }
      if (!malformedNoted.has(key)) {
        malformedNoted.add(key);
        logLine(root, `rotation note malformed: ${errText(e)}`);
        addNotice(root, `Sterling: the rotation note is malformed (${errText(e)}); delete ${notePath}. See ${LOG_REL}.`, now());
      }
      return '';
    }
    if (!note) return '';
    try {
      const session = getSession();
      if (typeof sessionID !== 'string' || !sessionID || sessionID === note.session_id) return '';
      if (!session || typeof session.get !== 'function') throw new Error('ctx.session.get is unavailable, so the session cannot be checked for a parent');
      const info = await session.get({ sessionID });
      if (info?.parentID) return '';
      const created = info?.time?.created;
      const noteAt = Date.parse(note.at ?? '');
      if (Number.isFinite(created) && Number.isFinite(noteAt) && created <= noteAt) {
        // Logged raw so a wrong time unit shows up in the plugin log.
        logLine(root, `rotation restore skipped for ${sessionID}: created before the note (time.created=${JSON.stringify(created)}, note.at=${JSON.stringify(note.at)} = ${noteAt} ms)`);
        return '';
      }
    } catch (e) {
      logLine(root, `rotation restore skipped for ${sessionID}: ${errText(e)}`);
      addNotice(root, `Sterling: a rotation note is waiting but could not be checked against this session (${errText(e)}); it was left in place. See ${LOG_REL}.`, now());
      return '';
    }
    // Claim hand-over (claim-handover.mjs): BEFORE the note is consumed, so a crash
    // between the two leaves the note for the next session; adoption is repeatable, so
    // running it again there is harmless. A failed adoption costs only the hand-over:
    // the orphan notice lists the claims and names board_adopt.
    let handover = '';
    if (adoptClaims && typeof note.session_id === 'string' && note.session_id) {
      try {
        handover = adoptionText(await adoptClaims(root, { from: note.session_id, to: sessionID }), note.session_id);
      } catch (e) {
        logLine(root, `rotation restore: claim hand-over from ${note.session_id} failed: ${errText(e)}`);
        handover = `BOARD CLAIM HAND-OVER FAILED (${errText(e)}): the claims session '${note.session_id}' held in this checkout were not adopted; adopt them with board_adopt from_session '${note.session_id}'.`;
      }
    }
    const consumed = consumeRotationNote(root);
    if (!consumed) return handover;
    let planLock = null;
    let planLockMalformed = false;
    try {
      const read = readPlanLock(join(root, '.sterling'));
      planLock = read.lock ?? null;
      planLockMalformed = Boolean(read.malformed);
    } catch (e) {
      planLockMalformed = true;
      logLine(root, `rotation restore: plan lock unreadable: ${errText(e)}`);
    }
    // The note is already consumed, so a render failure is logged and costs only the restore.
    try {
      const rendered = renderRestore(consumed, { cwd: root, host: 'opencode', planLock, planLockMalformed }).replace(/^\n+/, '');
      const text = handover ? `${rendered}\n\n${handover}` : rendered;
      restored.set(sessionID, text);
      return text;
    } catch (e) {
      logLine(root, `rotation restore: render failed after the note was consumed: ${errText(e)}`);
      if (handover) restored.set(sessionID, handover);
      return handover;
    }
  };
}
