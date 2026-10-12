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

export function addNotice(root, text, now = new Date().toISOString()) {
  withNoticesLock(root, () => {
    const notices = readNotices(root);
    if (notices.some((n) => n.text === text && !n.shown_at)) return;
    notices.push({ id: randomUUID(), at: now, text });
    writeJsonAtomic(join(root, NOTICES_REL), notices);
  });
}

/**
 * The notices not shown yet, each stamped shown_at `now`. They are delivered once, into
 * the prompt that starts an execution, which keeps them in the conversation, so a shown
 * notice is never returned again; it is pruned at that execution's end.
 */
export function takeNotices(root, now) {
  return withNoticesLock(root, () => {
    const notices = readNotices(root);
    const fresh = notices.filter((n) => !n.shown_at);
    if (!fresh.length) return [];
    for (const n of fresh) n.shown_at = now;
    writeJsonAtomic(join(root, NOTICES_REL), notices);
    return fresh;
  });
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
