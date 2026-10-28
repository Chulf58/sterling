// The owner record of one checkout (multi-session toolkit slice 3, decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session): the root conductor session that
// owns a checkout, so wake-project and notify-project know where a delivery goes.
//
// ONE AUTHORITY. The record is the file the Sterling OpenCode plugin already writes for the
// launcher (packages/opencode-plugin/src/conductor-session.mjs, GitHub issue #187):
// <checkout>/.sterling/transient/opencode-conductor-session, one line holding the session id. The
// launcher (templates/launcher-tmux.sh) reopens that session after a crash; wake and notify send
// to it. One file has both roles, so the session a crashed window reopens and the session a
// sender wakes cannot disagree. Its mtime is the time it was set.
//
// WRITERS are the checkout's own runtime only: the plugin, when the user prompts a root conductor
// session there (recordOwner; the newest prompt wins, so a /new takes over by being used), and
// `wake-project --set-owner`, which must be run from a checkout of the same project
// (transitionOwner, a compare-and-set against what it read before it validated the session).
// Senders read it and never write it. Both writes run under one lock file beside the record
// (file-lock.mjs), so a set-owner compare and its rename cannot straddle a plugin write.
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { withFileLock } from './file-lock.mjs';

export const OWNER_RECORD_REL = '.sterling/transient/opencode-conductor-session';
const SESSION_RE = /^ses_[A-Za-z0-9]+$/;
// The plugin writes inside a prompt hook with a 4 s budget; a script waits a little longer.
export const OWNER_LOCK_WAIT_MS = 3_000;

export const ownerRecordPath = (checkout) => join(checkout, OWNER_RECORD_REL);
const lockPath = (checkout) => `${ownerRecordPath(checkout)}.lock`;

/**
 * The owner of `checkout`: { session, set_at } (set_at an ISO time), or null when no record
 * exists. A record that is not one session id throws: a hand edit or a torn file is never
 * read as "no owner".
 */
export function readOwner(checkout) {
  const path = ownerRecordPath(checkout);
  let text;
  let mtime;
  try {
    text = readFileSync(path, 'utf8');
    mtime = statSync(path).mtime;
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  const session = text.replace(/\n$/, '');
  if (!SESSION_RE.test(session)) throw new Error(`the owner record ${path} does not hold one session id; fix or remove it by hand (the plugin writes it again on the next prompt)`);
  return { session, set_at: mtime.toISOString() };
}

function write(checkout, session) {
  const path = ownerRecordPath(checkout);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${session}\n`);
}

function checkId(session, what) {
  if (typeof session !== 'string' || !SESSION_RE.test(session)) throw new Error(`${what}: ${JSON.stringify(session)} is not a session id`);
}

/**
 * Runs fn({ current, write }) under the record's lock: `current` is the session the record names
 * (null for none) and write(session) replaces it. A caller whose decision depends on more than the
 * record (the plugin's prompt order) makes that decision inside fn, so it cannot go stale while
 * the lock is awaited. Returns fn's value.
 */
export async function withOwnerRecord(checkout, fn, { waitMs = OWNER_LOCK_WAIT_MS } = {}) {
  return withFileLock(lockPath(checkout), () => fn({
    current: readOwner(checkout)?.session ?? null,
    write: (session) => {
      checkId(session, 'owner record');
      write(checkout, session);
    },
  }), { waitMs });
}

/**
 * `session` was prompted by the user in this checkout, so it is the owner now, whatever the record
 * held. Writes only when the record differs. Returns { changed }.
 */
export async function recordOwner(checkout, session, options) {
  checkId(session, 'owner record');
  return withOwnerRecord(checkout, ({ current, write }) => {
    if (current === session) return { changed: false };
    write(session);
    return { changed: true };
  }, options);
}

/**
 * Compare-and-set: makes `next` the owner only while the record still names `expect` (null for
 * no record). Answers { status: 'written', previous } or { status: 'conflict', current }.
 */
export async function transitionOwner(checkout, { expect, next }, { waitMs = OWNER_LOCK_WAIT_MS } = {}) {
  checkId(next, 'new owner');
  if (expect !== null) checkId(expect, 'expected owner');
  return withFileLock(lockPath(checkout), () => {
    const current = readOwner(checkout)?.session ?? null;
    if (current !== expect) return { status: 'conflict', current };
    if (current !== next) write(checkout, next);
    return { status: 'written', previous: current };
  }, { waitMs });
}
