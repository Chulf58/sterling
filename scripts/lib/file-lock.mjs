// A cross-process lock file for short read-compare-write sections (multi-session toolkit,
// decision sterling-ports-ch-hub-s-whole-multi-session-toolkit-session). It guards the
// per-checkout owner record (owner-record.mjs), which both the scripts and the Sterling
// OpenCode plugin write, and the sender's delivery journal (delivery-journal.mjs). It uses
// only node:fs, so the plugin can import it, and it waits asynchronously, so a plugin hook
// never blocks its event loop.
//
// The protocol is the knowledge_move lock's (packages/store/src/move-lock.ts), ported:
// - the lock holds { pid, proc_start, hostname, token } and appears whole: a private temp
//   file hard-linked into place (link fails with EEXIST while another holder's file is there),
//   so it is never seen empty (hazard d351483b);
// - its owner is gone only when its pid is dead on this host, or the pid now belongs to another
//   process (its /proc start time differs: PID liveness alone is not process identity, hazard
//   8e603e23), or the content is unparseable past UNPARSEABLE_GRACE_MS; a lock from another
//   host is never judged gone;
// - a stale lock is removed only by the holder of a TICKET named after its exact content, and
//   only while the lock still has that content. Lock content is never reused (a fresh token
//   each time), so a lock taken after the stale one was judged is never removed. The lock is
//   never renamed or moved aside (anti-pattern 5fc3e084: an unverified lock is never displaced).
//   A ticket whose own holder died is not deleted; the next taker takes the next ticket of a
//   chain, so each level has exactly one winner.
// NOT guaranteed: locks across machines or pid namespaces, and a holder that hangs while alive
// keeps the lock (waiters give up after waitMs, loudly). Where /proc cannot be read the start
// time is null and liveness alone decides.
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const UNPARSEABLE_GRACE_MS = 10_000;

export class LockTimeout extends Error {
  constructor(message) {
    super(message);
    this.lockTimeout = true;
  }
}

export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists under another user.
    return e?.code === 'EPERM';
  }
}

/** The start time of `pid` (field 22 of /proc/<pid>/stat), or null where it cannot be read. */
export function procStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

// Makes `path` appear with `content` in one step; false when it already exists.
function createWithContent(path, content) {
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function readLock(path) {
  let raw;
  let mtimeMs;
  try {
    raw = readFileSync(path, 'utf8');
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    if (e?.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const v = JSON.parse(raw);
    if (Number.isInteger(v?.pid) && typeof v.token === 'string' && typeof v.hostname === 'string') return { raw, owner: v, mtimeMs };
  } catch {
    // unparseable: see UNPARSEABLE_GRACE_MS
  }
  return { raw, mtimeMs };
}

function ownerGone(seen, probe) {
  const o = seen.owner;
  if (!o) return probe.now() - seen.mtimeMs >= UNPARSEABLE_GRACE_MS;
  if (o.hostname !== probe.host) return false;
  if (!probe.isAlive(o.pid)) return true;
  if (o.proc_start === null || o.proc_start === undefined) return false;
  const cur = probe.startTimeOf(o.pid);
  return cur !== null && cur !== o.proc_start;
}

// Removes the stale lock whose content was `staleRaw`: 'removed', 'retry' (re-read the lock) or
// 'taker-busy' (a live process is taking it over; wait).
function takeOverStale(path, staleRaw, me, probe) {
  let key = staleRaw;
  const dead = [];
  for (let depth = 0; depth < 16; depth++) {
    const ticket = `${path}.takeover-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    if (createWithContent(ticket, me)) {
      try {
        probe.beforeRemove?.();
        if (readLock(path)?.raw === staleRaw) rmSync(path, { force: true });
        return 'removed';
      } finally {
        rmSync(ticket, { force: true });
        for (const d of dead) rmSync(d, { force: true });
      }
    }
    const t = readLock(ticket);
    if (!t) return 'retry';
    if (!ownerGone(t, probe)) return 'taker-busy';
    dead.push(ticket);
    key = `${key}\u0000${t.raw}`;
  }
  return 'taker-busy';
}

/**
 * Takes the lock at `path`, waiting up to waitMs; returns a release function, which removes the
 * lock only while it still carries this holder's token. A wait that runs out throws LockTimeout.
 * isAlive, startTimeOf, pid and beforeRemove are seams for tests.
 */
export async function takeFileLock(path, { waitMs = 5_000, pollMs = 25, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isAlive = pidIsAlive, startTimeOf = procStartTime, pid = process.pid, beforeRemove } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const host = hostname();
  const token = randomUUID();
  const me = JSON.stringify({ pid, proc_start: startTimeOf(pid), hostname: host, token });
  const probe = { isAlive, startTimeOf, host, now, beforeRemove };
  const end = now() + waitMs;
  for (;;) {
    if (createWithContent(path, me)) {
      return () => {
        if (readLock(path)?.owner?.token === token) rmSync(path, { force: true });
      };
    }
    const seen = readLock(path);
    if (!seen) continue;
    if (ownerGone(seen, probe) && takeOverStale(path, seen.raw, me, probe) !== 'taker-busy') continue;
    if (now() >= end) throw new LockTimeout(`the lock ${path} stayed taken for ${waitMs} ms`);
    await sleep(pollMs);
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
