// Single-instance lock (§11): one TUI per store. The lock file holds the
// owner's pid; a live owner turns later launches away, a dead one (crash,
// closed window) is taken over — no stale-lock lockout, no duplicate panes.
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

/** Acquire the lock: returns the live owner's pid when another instance holds
 *  it, or null after taking it (fresh, stale, or re-entrant). */
export function acquireTuiLock(lockPath: string, pid: number, isAlive: (pid: number) => boolean = pidIsAlive): number | null {
  if (existsSync(lockPath)) {
    const owner = Number(readFileSync(lockPath, 'utf8').trim());
    if (owner !== pid && isAlive(owner)) return owner;
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, String(pid));
  return null;
}

/** Release only a lock this pid owns — never clobber a newer instance's lock. */
export function releaseTuiLock(lockPath: string, pid: number): void {
  try {
    if (Number(readFileSync(lockPath, 'utf8').trim()) === pid) rmSync(lockPath, { force: true });
  } catch {
    // already gone — nothing to release
  }
}
