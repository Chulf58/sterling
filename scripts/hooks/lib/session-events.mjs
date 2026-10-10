// The session-event register: <project>/.sterling/transient/session-events.json, a
// compact JSON array that is only ever appended to (never deduplicated). H16 on Claude
// Code and the OpenCode plugin's research recorder (packages/opencode-plugin/src/
// research.mjs) write research_tool events through this one writer, so both hosts
// record the same shape and H10 and the plugin's settlement read one format.
// Builtins only (node:fs, node:path, node:sqlite): hooks and the OpenCode server bundle vendor this module.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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
      const tmp = `${eventsPath}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.tmp`;
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

const SQLITE_BUSY = 5;

/**
 * Run fn while holding a kernel-held lock: a `BEGIN IMMEDIATE` transaction on the small SQLite
 * database `<path>.lock.db`, opened with node:sqlite (which also runs under OpenCode's Bun,
 * packages/opencode-plugin/src/store.mjs). A contender waits up to timeoutMs through SQLite's
 * busy handler, then throws an Error with code SESSION_EVENTS_LOCK_HELD and runs nothing: callers
 * skip the write and say so, never write unlocked (decision register-writers-cooperating-lock).
 *
 * The lock is released by COMMIT, by closing the connection, or by the OS when the holding
 * process dies, so there is no pid, age or reclaim logic and no crash leaves a stale lock.
 * Nothing is ever written to the lock database and it stays in rollback-journal mode, so no
 * -journal or -wal file is left; the .lock.db file itself persists. Not reentrant: calling it
 * from inside fn waits on itself until timeoutMs. Not guaranteed: exclusion between machines or
 * WSL distros sharing one tree, or on a filesystem whose byte-range locks do not work.
 */
export function withSessionEventsLock(path, fn, { timeoutMs = 5000 } = {}) {
  const lockPath = `${path}.lock.db`;
  const db = new DatabaseSync(lockPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      db.exec('BEGIN IMMEDIATE');
    } catch (e) {
      if ((e?.errcode & 0xff) !== SQLITE_BUSY) throw e;
      const err = new Error(`${lockPath} is held by another writer that is still running; gave up after ${timeoutMs}ms and nothing was written`);
      err.code = SESSION_EVENTS_LOCK_HELD;
      throw err;
    }
    try {
      return fn();
    } finally {
      try {
        db.exec('COMMIT');
      } catch (e) {
        // Not rethrown, so fn's own result or error is kept; closing the connection below releases the lock.
        console.error(`session-events: COMMIT of the lock at ${lockPath} failed (${e?.message ?? e}); the lock is released by closing the connection`);
      }
    }
  } finally {
    db.close();
  }
}
