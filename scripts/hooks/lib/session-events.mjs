// The session-event register: <project>/.sterling/transient/session-events.json, a
// compact JSON array that is only ever appended to (never deduplicated). H16 on Claude
// Code and the OpenCode plugin's research recorder (packages/opencode-plugin/src/
// research.mjs) write research_tool events through this one writer, so both hosts
// record the same shape and H10 and the plugin's settlement read one format.
// Builtins only: hooks and the OpenCode server bundle vendor this module.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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
export function appendSessionEvent(projectDir, event, lockOptions) {
  appendSessionEventsAt(join(projectDir, SESSION_EVENTS_REL), [event], lockOptions);
}

/**
 * Append events to the register at eventsPath under withSessionEventsLock, replacing the file
 * through a same-directory temp file and renameSync, so a reader never sees it empty or half
 * written. Every writer of session-events.json goes through here (issue #64: parallel H16 runs
 * with an unlocked read-modify-write threw "Unexpected end of JSON input" and lost events).
 * An unparsable register throws and is left as it is; an empty one is unparsable too.
 */
export function appendSessionEventsAt(eventsPath, newEvents, lockOptions) {
  mkdirSync(dirname(eventsPath), { recursive: true });
  withSessionEventsLock(
    eventsPath,
    () => {
      const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
      events.push(...newEvents);
      const tmp = `${eventsPath}.${process.pid}.${uniqueToken()}.tmp`;
      writeFileSync(tmp, JSON.stringify(events), { flag: 'wx' });
      try {
        renameSync(tmp, eventsPath);
      } catch (e) {
        try {
          unlinkSync(tmp);
        } catch {
          // the rename error below is the one that matters; a leftover temp file is named in it
        }
        throw e;
      }
    },
    lockOptions,
  );
}

export const SESSION_EVENTS_LOCK_HELD = 'session_events_lock_held';

/**
 * Run fn while holding `<path>.lock`, a file created with 'wx' (exclusive create) that holds
 * "<pid> <token>". Contention retries every ~retryMs (with jitter) until timeoutMs, then throws
 * an Error with code SESSION_EVENTS_LOCK_HELD and runs nothing: callers skip the write and say
 * so, never write unlocked (decision register-writers-cooperating-lock).
 *
 * A lock is stale when its pid is dead or the file is older than staleMs. Removing a stale lock
 * happens only while holding `<path>.lock.reclaim` (also 'wx'), and the lock is judged again
 * under it, so two waiters that both saw the same stale lock cannot each remove a lock the other
 * then created. Release removes the lock only when it still holds this holder's token.
 * Residuals: a holder that runs past staleMs can be reclaimed while alive; a recycled pid makes
 * a crashed holder's lock last until staleMs (anti_pattern 8e603e23); a crash inside the
 * microseconds a reclaim gate is held leaves the gate until it is staleMs old.
 */
export function withSessionEventsLock(path, fn, { timeoutMs = 5000, retryMs = 10, staleMs = 30000 } = {}) {
  const lockPath = `${path}.lock`;
  const token = `${process.pid} ${uniqueToken()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreate(lockPath, token)) break;
    if (isStale(lockPath, staleMs)) {
      reclaimStale(lockPath, staleMs);
      continue;
    }
    if (Date.now() >= deadline) {
      const err = new Error(`${lockPath} is held by another writer (${readLock(lockPath) ?? 'holder unknown'}) after ${timeoutMs}ms; nothing was written`);
      err.code = SESSION_EVENTS_LOCK_HELD;
      throw err;
    }
    sleepMs(retryMs + Math.floor(Math.random() * retryMs));
  }
  try {
    return fn();
  } finally {
    if (readLock(lockPath) === token) unlinkIfPresent(lockPath);
  }
}

function uniqueToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Synchronous wait: hooks and the scripts that share this writer have no event loop to yield to. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryCreate(lockPath, content) {
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readLock(lockPath) {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function pidIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

/** Stale: the recorded pid is dead, or the lock file is older than staleMs. A just-created lock with no content yet is judged by age only. */
function isStale(lockPath, staleMs) {
  let mtimeMs;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (Date.now() - mtimeMs > staleMs) return true;
  const pid = Number((readLock(lockPath) ?? '').split(' ')[0]);
  return Number.isInteger(pid) && pid > 0 && pidIsDead(pid);
}

function reclaimStale(lockPath, staleMs) {
  const gatePath = `${lockPath}.reclaim`;
  if (!tryCreate(gatePath, `${process.pid}`)) {
    if (isStale(gatePath, staleMs)) {
      console.error(`session-events: removing reclaim gate ${gatePath}, older than ${staleMs}ms (a crashed holder's leftover)`);
      unlinkIfPresent(gatePath);
    }
    return;
  }
  try {
    if (isStale(lockPath, staleMs)) {
      console.error(`session-events: removing stale lock ${lockPath} (${readLock(lockPath) ?? 'empty'}): its pid is dead or it is older than ${staleMs}ms`);
      unlinkIfPresent(lockPath);
    }
  } finally {
    unlinkIfPresent(gatePath);
  }
}

function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
