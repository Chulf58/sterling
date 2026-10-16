// The machine-level knowledge_move lock (decision move-a-record-between-domains-with-knowledge-move-same-id).
// Every move (all five steps) and every recovery run holds it for its whole duration, so recovery
// never reads the move journal while a move is writing it. See MountedStores.moveRecordBetweenDomains
// for the protocol and what the lock does not guarantee.
//
// The file holds {pid, proc_start, hostname, started_at, token} and appears with that content in
// one step (a private temp file hard-linked into place), so it is never seen empty. An existing lock is honoured while
// its owner is alive on this host AND is still the same process: the pid answers kill(pid, 0) and
// the pid's current start time (Linux /proc/<pid>/stat field 22) equals the stored one, so a
// recycled pid does not keep a dead owner's lock (anti_pattern 8e603e23, PID liveness alone is not
// process identity). Where /proc cannot be read the start time is null and liveness alone decides;
// acquireMoveLock reports that as a warning on every acquisition. A lock written on another host
// cannot be judged here and is honoured until the timeout.
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MoveLockOwner {
  pid: number;
  proc_start: string | null;
  hostname: string;
  started_at: string;
  token: string;
}

export interface MoveLockHandle {
  path: string;
  token: string;
  /** Set when this platform gives no process start time, so a recycled pid cannot be told apart. */
  warning?: string;
}

export interface MoveLockOptions {
  /** How long to wait for a live owner before refusing. 0 tries once. */
  timeoutMs?: number;
  pollMs?: number;
  /** Seams for tests; production uses the real process table. */
  isAlive?: (pid: number) => boolean;
  startTimeOf?: (pid: number) => string | null;
  pid?: number;
}

/** Another live process holds the move lock past the timeout. Nothing was written. */
export class MoveLockBusyError extends Error {
  constructor(readonly path: string, readonly owner: MoveLockOwner | undefined, waitedMs: number, readonly takeover = false) {
    super(
      takeover
        ? `knowledge_move lock ${path} was left by a process that is gone, and another process is taking it over now; waited ${waitedMs} ms. ` +
            `Nothing was written; retry in a moment.`
        : `knowledge_move lock ${path} is held by ${owner ? `pid ${owner.pid} on ${owner.hostname} since ${owner.started_at}` : 'a process that wrote it some other way (unreadable content)'}; ` +
            `waited ${waitedMs} ms. A move or a move recovery is running. Nothing was written; retry when it ends.`
    );
    this.name = 'MoveLockBusyError';
  }
}

export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The Linux /proc start time of `pid` (stat field 22), or null when it cannot be read. */
export function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function readOwner(path: string): { raw: string; owner?: MoveLockOwner; mtimeMs: number } | undefined {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(path, 'utf8');
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const v = JSON.parse(raw) as MoveLockOwner;
    if (Number.isInteger(v.pid) && typeof v.token === 'string' && typeof v.hostname === 'string') return { raw, owner: v, mtimeMs };
  } catch {
    /* unparseable: see UNPARSEABLE_GRACE_MS */
  }
  return { raw, mtimeMs };
}

/** Our writers make a lock or ticket appear with its whole content (createWithContent), so an
 *  unparseable one was written some other way. It is treated as held for this long after its last
 *  change, then as stale, so it neither blocks forever nor is taken from a writer still at work. */
export const UNPARSEABLE_GRACE_MS = 10_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Make `path` appear atomically with `content`: write a private temp file, hard-link it to
 *  `path` (EEXIST: someone else holds it, returns false), drop the temp. A temp left by a writer
 *  that died has a unique name and blocks no one. */
function createWithContent(path: string, content: string): boolean {
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

type Probe = { isAlive: (pid: number) => boolean; startTimeOf: (pid: number) => string | null; host: string; now: () => number };

/** Whether a lock or ticket's owner is gone: dead or recycled pid on this host, or unparseable
 *  content past the grace. A file from another host is never judged gone. */
function ownerGone(seen: { owner?: MoveLockOwner; mtimeMs: number }, probe: Probe): boolean {
  const o = seen.owner;
  if (!o) return probe.now() - seen.mtimeMs >= UNPARSEABLE_GRACE_MS;
  if (o.hostname !== probe.host) return false;
  if (!probe.isAlive(o.pid)) return true;
  if (o.proc_start === null) return false;
  const cur = probe.startTimeOf(o.pid);
  return cur !== null && cur !== o.proc_start;
}

/**
 * Remove a stale lock whose content was `staleRaw`, so the caller can retry the create.
 * Only the holder of a TICKET for that stale content removes it, and only if the lock still has
 * that content; tokens are never reused, so a lock that changed since it was judged stale is never
 * removed. If a ticket's own holder died mid-takeover, the next taker does not delete that ticket
 * (two takers could both delete it and both proceed); it takes the next ticket in a chain named
 * after the stale content plus each dead ticket's content, so every level has exactly one winner.
 * The winner drops its ticket and the dead ones once the lock is gone; a slow taker that creates
 * one of those names later finds different lock content and removes nothing.
 * Returns 'removed' or 'retry' (the caller re-reads the lock) or 'taker-busy' (a live process is
 * taking it over; the caller waits).
 */
function takeOverStale(path: string, staleRaw: string, me: MoveLockOwner, probe: Probe): 'removed' | 'retry' | 'taker-busy' {
  let key = staleRaw;
  const dead: string[] = [];
  for (let depth = 0; depth < 16; depth++) {
    const ticket = `${path}.takeover-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    if (createWithContent(ticket, JSON.stringify(me))) {
      try {
        if (readOwner(path)?.raw === staleRaw) rmSync(path, { force: true });
        return 'removed';
      } finally {
        rmSync(ticket, { force: true });
        for (const d of dead) rmSync(d, { force: true });
      }
    }
    const t = readOwner(ticket);
    if (!t) return 'retry';
    if (!ownerGone(t, probe)) return 'taker-busy';
    dead.push(ticket);
    key = `${key}\u0000${t.raw}`;
  }
  return 'taker-busy';
}

/**
 * Take the lock: create it with its content in one step (createWithContent). A live,
 * same-identity owner on this host is waited for up to `timeoutMs`, then refused with
 * MoveLockBusyError. A stale lock (dead pid, recycled pid, unparseable past the grace) is removed
 * through takeOverStale and the create is retried; of several takers only the one whose create
 * succeeds holds the lock.
 */
export function acquireMoveLock(path: string, opts: MoveLockOptions = {}): MoveLockHandle {
  const isAlive = opts.isAlive ?? pidIsAlive;
  const startTimeOf = opts.startTimeOf ?? procStartTime;
  const pid = opts.pid ?? process.pid;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 25;
  const host = hostname();
  const procStart = startTimeOf(pid);
  const me: MoveLockOwner = { pid, proc_start: procStart, hostname: host, started_at: new Date().toISOString(), token: randomUUID() };
  const warning =
    procStart === null
      ? `knowledge_move lock: this platform gives no process start time (/proc/${pid}/stat unreadable), so a lock left by a dead process whose pid was reused is honoured until that process exits.`
      : undefined;
  const probe: Probe = { isAlive, startTimeOf, host, now: () => Date.now() };
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  for (;;) {
    if (createWithContent(path, JSON.stringify(me))) return { path, token: me.token, ...(warning ? { warning } : {}) };
    const seen = readOwner(path);
    if (!seen) continue;
    let takeover = false;
    if (ownerGone(seen, probe)) {
      const r = takeOverStale(path, seen.raw, me, probe);
      if (r !== 'taker-busy') continue;
      takeover = true;
    }
    const waited = Date.now() - started;
    if (waited >= timeoutMs) throw new MoveLockBusyError(path, takeover ? undefined : seen.owner, waited, takeover);
    sleep(Math.min(pollMs, Math.max(1, timeoutMs - waited)));
  }
}

/** Release the lock only when the file still carries `handle.token`. Returns whether it did. */
export function releaseMoveLock(handle: MoveLockHandle): boolean {
  const seen = readOwner(handle.path);
  if (!seen?.owner || seen.owner.token !== handle.token) return false;
  rmSync(handle.path, { force: true });
  return true;
}
