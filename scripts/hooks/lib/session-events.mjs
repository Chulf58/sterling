// The session-event register: <project>/.sterling/transient/session-events.json, a
// compact JSON array that is only ever appended to (never deduplicated). H16 on Claude
// Code and the OpenCode plugin's research recorder (packages/opencode-plugin/src/
// research.mjs) write research_tool events through this one writer, so both hosts
// record the same shape and H10 and the plugin's settlement read one format.
// Builtins only: hooks and the OpenCode server bundle vendor this module.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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
 * an Error with code SESSION_EVENTS_LOCK_HELD naming the lock path and its holder's pid, and runs
 * nothing: callers skip the write and say so, never write unlocked (decision
 * register-writers-cooperating-lock).
 *
 * A lock is reclaimed only when its holder's pid is verified dead (process.kill(pid, 0) fails
 * with ESRCH), never on age: a live holder keeps its lock however long fn runs, so two writers
 * are never inside fn together. Removing a dead holder's lock happens only while holding
 * `<path>.lock.reclaim` (also 'wx'), and the holder is checked again under it, so two waiters
 * that both saw the same dead lock cannot each remove a lock the other then created. Release
 * removes the lock only when it still holds this holder's token.
 * Residuals: a dead holder's pid reused by a live process, or a lock with no readable pid (a
 * crash between create and write), is never reclaimed; every append then times out naming the
 * lock, which a human removes. A holder in another pid namespace (another WSL distro or machine
 * sharing the tree) can look dead. A reclaim gate left by a dead process is removed by a check
 * that two waiters can race.
 */
export function withSessionEventsLock(path, fn, { timeoutMs = 5000, retryMs = 10 } = {}) {
  const lockPath = `${path}.lock`;
  const token = `${process.pid} ${uniqueToken()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryCreate(lockPath, token)) break;
    const holder = readLock(lockPath);
    if (holder === null) continue; // released between the create and the read: try again now
    if (holderIsDead(holder)) {
      reclaimDead(lockPath);
      continue;
    }
    if (Date.now() >= deadline) {
      const pid = holderPid(holder);
      const who = pid === null ? `a writer whose pid cannot be read (lock content ${JSON.stringify(holder)})` : `live pid ${pid}`;
      const err = new Error(
        `${lockPath} is held by ${who}; gave up after ${timeoutMs}ms and nothing was written. If no Sterling writer with that pid is running (a reused pid), remove ${lockPath} by hand`,
      );
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

function holderPid(content) {
  const pid = Number(content.split(' ')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** True only when the holder's pid is readable and the OS says no such process exists. */
function holderIsDead(content) {
  const pid = holderPid(content);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

function reclaimDead(lockPath) {
  const gatePath = `${lockPath}.reclaim`;
  if (!tryCreate(gatePath, `${process.pid}`)) {
    const gate = readLock(gatePath);
    if (gate !== null && holderIsDead(gate)) {
      console.error(`session-events: removing reclaim gate ${gatePath} left by dead pid ${holderPid(gate)}`);
      unlinkIfPresent(gatePath);
    }
    return;
  }
  try {
    const holder = readLock(lockPath);
    if (holder !== null && holderIsDead(holder)) {
      console.error(`session-events: removing lock ${lockPath} left by dead pid ${holderPid(holder)}`);
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
