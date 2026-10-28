// A cross-process lock file for short read-compare-write sections (multi-session toolkit,
// decision sterling-ports-ch-hub-s-whole-multi-session-toolkit-session). It guards the
// per-checkout owner record (owner-record.mjs), which both the scripts and the Sterling
// OpenCode plugin write, and the sender's delivery journal (delivery-journal.mjs). It uses
// only node:fs, so the plugin can import it.
//
// INVARIANT: at most one holder per lock path among live processes. The lock is a file that
// appears whole: its content (pid and a nonce) is written to a private temp file first and
// published with link(), which fails with EEXIST while another holder's file is there (an
// empty or half-written lock is never visible; hazard d351483b). A lock whose pid no longer
// runs is stale. It is taken over by renaming it away, which only one process can do, and the
// renamed file is checked to be the stale one observed; a live lock caught by that rename is
// put back.
// NOT guaranteed: locks across machines or pid namespaces (a pid is judged on this machine),
// and a holder that hangs while alive keeps the lock (waiters give up after waitMs, loudly).
import { linkSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class LockTimeout extends Error {
  constructor(message) {
    super(message);
    this.lockTimeout = true;
  }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists under another user.
    return e?.code === 'EPERM';
  }
};

function readLock(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

// One try: true when this process now holds the lock.
function tryTake(path, content) {
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Removes the lock at `path` when it is still exactly the stale `seen` content.
function takeOverStale(path, seen) {
  const aside = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if (e?.code === 'ENOENT') return;
    throw e;
  }
  const caught = readLock(aside);
  if (caught === seen) {
    unlinkSync(aside);
    return;
  }
  // The rename caught a lock taken after the stale one was read: put it back.
  try {
    linkSync(aside, path);
  } catch (e) {
    throw new Error(`lock ${path}: a live lock was moved aside while a stale one was cleared and could not be put back (${e.code ?? e.message}); remove ${aside} by hand once no run of this tool is active`);
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Takes the lock at `path`, waiting up to waitMs; returns a release function. A wait that runs
 * out throws LockTimeout. `sleep` lets a caller pick the wait (default 25 ms).
 */
export async function takeFileLock(path, { waitMs = 5_000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const end = now() + waitMs;
  for (;;) {
    if (tryTake(path, content)) {
      return () => {
        // Only our own lock is removed: a lock someone took over after we were judged dead stays.
        if (readLock(path) === content) unlinkSync(path);
      };
    }
    const seen = readLock(path);
    if (seen !== null) {
      let pid = null;
      try {
        pid = JSON.parse(seen)?.pid;
      } catch {
        pid = null;
      }
      // Content that is not ours to judge (not JSON, no pid) is never taken for stale: wait it out.
      if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) {
        takeOverStale(path, seen);
        continue;
      }
    }
    if (now() >= end) throw new LockTimeout(`the lock ${path} stayed taken for ${waitMs} ms`);
    await sleep(25);
  }
}

/** Runs fn while holding the lock at `path`; returns fn's value. */
export async function withFileLock(path, fn, options) {
  const release = await takeFileLock(path, options);
  try {
    return await fn();
  } finally {
    release();
  }
}
