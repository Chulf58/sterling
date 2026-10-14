// Pending notices: written by any handler, appended once to the conductor's next
// prompt by the context handler (context.mjs onPrompt), and pruned at the end of
// the execution that showed them (settle.mjs).
//
// The file is shared by every OpenCode process on the project (the user's and the
// maintenance worker's child), so each read-modify-write runs under the repo's
// cross-process lock, the kernel-held one in scripts/hooks/lib/session-events.mjs
// (decision session-events-and-register-locks-are-kernel-held-never-reclaimed-by-age).
// Without it a prune that read the file before another process added a notice would
// write back its old copy and lose that notice. A writer that cannot get the lock in
// NOTICES_LOCK_TIMEOUT_MS throws and writes nothing; it never writes unlocked.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withSessionEventsLock } from '../../../scripts/hooks/lib/session-events.mjs';

export const NOTICES_REL = '.sterling/transient/opencode-notices.json';
// Below the context handler's 4000 ms budget: every hold is one small JSON read and write.
const NOTICES_LOCK_TIMEOUT_MS = 2000;

/** Runs fn (a synchronous read-modify-write of the notices file) holding the notices lock. */
function withNoticesLock(root, fn) {
  const path = join(root, NOTICES_REL);
  mkdirSync(dirname(path), { recursive: true });
  return withSessionEventsLock(path, fn, { timeoutMs: NOTICES_LOCK_TIMEOUT_MS });
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readNotices(root) {
  const p = join(root, NOTICES_REL);
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${NOTICES_REL} is not a JSON array`);
  return parsed;
}

/**
 * `key`, when given, names the notice's normalized content: a notice that is re-minted
 * with new incidental wording (a dispatch count, agent ids) keeps the same key, and
 * the context handler shows a key once per session (context.mjs dueText).
 */
export function addNotice(root, text, now = new Date().toISOString(), key = undefined) {
  withNoticesLock(root, () => {
    const notices = readNotices(root);
    if (notices.some((n) => !n.shown_at && (n.text === text || (key !== undefined && n.key === key)))) return;
    notices.push({ id: randomUUID(), at: now, text, ...(key === undefined ? {} : { key }) });
    writeJsonAtomic(join(root, NOTICES_REL), notices);
  });
}

// A claim older than this is taken to belong to a delivery that died (a crashed process):
// the notice is offered again, so a lost claim costs a repeat, never the notice. It is well
// above the context handler's 4000 ms budget, inside which a claim is committed or released.
export const NOTICE_CLAIM_TTL_MS = 60_000;

const claimLive = (n, nowMs) => typeof n.claim === 'string' && nowMs - Date.parse(n.claimed_at ?? '') < NOTICE_CLAIM_TTL_MS;

/**
 * The notices not shown and not claimed by another delivery, each claimed for this one.
 * Returns { notices, commit(), release() }: commit stamps them shown_at `now` (call it once
 * the text carrying them is delivered), release drops the claim so the next delivery offers
 * them again. Nothing is shown until commit, so a delivery that fails loses no notice and
 * settlement (pruneShownNotices) never prunes one unseen.
 */
export function claimNotices(root, now) {
  const nowMs = Date.parse(now);
  const token = randomUUID();
  const fresh = withNoticesLock(root, () => {
    const notices = readNotices(root);
    const open = notices.filter((n) => !n.shown_at && !claimLive(n, nowMs));
    if (!open.length) return [];
    for (const n of open) Object.assign(n, { claim: token, claimed_at: now });
    writeJsonAtomic(join(root, NOTICES_REL), notices);
    return open;
  });
  const settle = (fn) => {
    if (!fresh.length) return;
    withNoticesLock(root, () => {
      const notices = readNotices(root);
      const mine = notices.filter((n) => n.claim === token);
      if (!mine.length) return;
      for (const n of mine) {
        delete n.claim;
        delete n.claimed_at;
        fn(n);
      }
      writeJsonAtomic(join(root, NOTICES_REL), notices);
    });
  };
  return {
    notices: fresh,
    commit: () => settle((n) => { n.shown_at = now; }),
    release: () => settle(() => {}),
  };
}

/**
 * The notices not shown yet, each stamped shown_at `now`, in one step (claimNotices then
 * commit), for a caller that has already delivered them.
 */
export function takeNotices(root, now) {
  const claimed = claimNotices(root, now);
  claimed.commit();
  return claimed.notices;
}

/** Removes the shown notices. `afterRead` is a test seam, run between the read and the write. */
export function pruneShownNotices(root, { afterRead } = {}) {
  withNoticesLock(root, () => {
    const notices = readNotices(root);
    afterRead?.();
    const left = notices.filter((n) => !n.shown_at);
    if (left.length === notices.length) return;
    if (left.length) writeJsonAtomic(join(root, NOTICES_REL), left);
    else rmSync(join(root, NOTICES_REL), { force: true });
  });
}
