// Single-instance lock (§11): one TUI per store. The lock file holds the owner's
// pid AND a start-time identity token (Linux /proc) so a RECYCLED pid can't lock
// a new TUI out — a launch honors the lock only when the pid is alive AND still
// the same process that wrote it. A dead owner (crash, closed window), a pid the
// OS has reassigned to an unrelated process, or garbage content are all taken
// over — no stale-lock lockout, no duplicate panes. Platforms without /proc
// (native Windows) have no token and fall back to pid-liveness alone.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence probe, no signal delivered
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive but not ours
  }
}

/** A process-identity token that changes when a pid is recycled: the Linux
 *  /proc start-time (clock ticks since boot — stat field 22). Returns null when
 *  it can't be read — a dead pid, or a platform without /proc (native Windows). */
export function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) may itself contain spaces and ')' — parse AFTER the last ')'
    // so field offsets are stable: state (field 3) is index 0, starttime (22) is 19.
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** Honor an existing lock only when the owner is alive AND still the SAME process
 *  that wrote it. When identity can't be established — a legacy bare-pid lock or a
 *  platform without /proc — reuse is indistinguishable from continuity, so we
 *  trust liveness alone (the pre-identity behavior). */
function ownerStillHolds(storedToken: string | undefined, currentToken: string | null): boolean {
  if (!storedToken || currentToken === null) return true; // unverifiable → trust liveness
  return storedToken === currentToken; // verifiable → a recycled pid (new start-time) is rejected
}

/** Acquire the lock: returns the live owner's pid when another instance holds it,
 *  or null after taking it (fresh, stale, recycled-pid, or re-entrant). */
export function acquireTuiLock(
  lockPath: string,
  pid: number,
  isAlive: (pid: number) => boolean = pidIsAlive,
  startTimeOf: (pid: number) => string | null = procStartTime,
): number | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = startTimeOf(pid);
  const content = token ? `${pid} ${token}` : String(pid);
  // Atomic exclusive create (audit finding 40/43): the prior existsSync-then-write
  // let two simultaneous launches both pass the check and both write, producing two
  // live TUIs on one store (AC7 breach). 'wx' fails if the file exists, so exactly
  // one racer creates it; the loser falls to the honor-check and either backs off
  // to the live owner or takes over a dead/recycled one and retries the create.
  //
  // Two invariants (group-6 review): (a) a takeover removes the lock ONLY if it
  // STILL names the dead owner we read — never a racer's fresh live lock (re-read
  // immediately before rmSync); (b) we return null ("acquired") ONLY after a
  // successful create OR when a lock file demonstrably EXISTS (an EEXIST we cannot
  // take over) — never with no file written.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath, content, { flag: 'wx' });
      return null; // we created it — we own it
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let parts: string[];
    try {
      parts = readFileSync(lockPath, 'utf8').trim().split(/\s+/);
    } catch {
      continue; // vanished between our create and read — retry the exclusive create
    }
    const ownerRaw = parts[0];
    const owner = Number(ownerRaw);
    if (owner === pid) return null; // re-entrant: this pid already holds it
    if (isAlive(owner) && ownerStillHolds(parts[1], startTimeOf(owner))) return owner; // live, same-identity owner
    // dead / recycled / garbage → take over, but remove ONLY if the file's owner
    // field is UNCHANGED since our read (a racer may have replaced it with a fresh
    // LIVE lock between our read and now — never delete that). Raw-string compare
    // so garbage content ('not-a-pid') matches itself (Number(garbage) is NaN,
    // and NaN !== NaN would wrongly skip the takeover).
    try {
      const cur = readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0];
      if (cur === ownerRaw) rmSync(lockPath, { force: true });
      // else: replaced since our read — loop and re-evaluate the new owner
    } catch {
      /* vanished — loop retries the exclusive create */
    }
  }
  // Retries exhausted (a live owner kept winning the create race, or the file kept
  // churning). A file EXISTS here — never claim acquired without one: report a live
  // owner if present, else honor the existing file as the single instance.
  try {
    const owner = Number(readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0]);
    if (owner !== pid && isAlive(owner)) return owner;
  } catch {
    // the file genuinely vanished at the last moment — one final atomic claim
    try {
      writeFileSync(lockPath, content, { flag: 'wx' });
    } catch {
      /* someone else just created it — they own it, we proceed as the honored one */
    }
  }
  return null;
}

/** Release only a lock this pid owns — never clobber a newer instance's lock. */
export function releaseTuiLock(lockPath: string, pid: number): void {
  try {
    const owner = Number(readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0]);
    if (owner === pid) rmSync(lockPath, { force: true });
  } catch {
    // already gone — nothing to release
  }
}
