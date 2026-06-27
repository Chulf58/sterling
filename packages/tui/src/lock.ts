// Single-instance lock (§11): one TUI per store. The lock file holds the owner's
// pid AND a start-time identity token (Linux /proc) so a RECYCLED pid can't lock
// a new TUI out — a launch honors the lock only when the pid is alive AND still
// the same process that wrote it. A dead owner (crash, closed window), a pid the
// OS has reassigned to an unrelated process, or garbage content are all taken
// over — no stale-lock lockout, no duplicate panes. Platforms without /proc
// (native Windows) have no token and fall back to pid-liveness alone.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if (existsSync(lockPath)) {
    const [ownerStr, ownerToken] = readFileSync(lockPath, 'utf8').trim().split(/\s+/);
    const owner = Number(ownerStr);
    if (owner !== pid && isAlive(owner) && ownerStillHolds(ownerToken, startTimeOf(owner))) return owner;
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = startTimeOf(pid);
  writeFileSync(lockPath, token ? `${pid} ${token}` : String(pid));
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
