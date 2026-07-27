// Shared hook plumbing. Hooks import workspace packages at AUTHOR time; the
// ship step esbuild-bundles them so the runtime is standalone (invariant 4).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { normalizeRepoPath, toRepoRelative } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';

/**
 * Nearest ancestor of `from` holding .sterling/sterling.db, or null when the walk
 * reaches the filesystem root without finding one (= not a Sterling project, so
 * hooks stay silent — P1, no ceremony outside Sterling repos).
 *
 * Keyed on the DB FILE, deliberately NOT on a bare .sterling DIRECTORY: ~/.sterling
 * exists on every machine (it holds the domain stores + registry.db) and is
 * emphatically not a project root — a walk that stopped at the directory would
 * resolve the entire enforcement surface against a store that isn't there.
 */
export function projectRoot(from) {
  if (!from) return null;
  let dir = resolve(String(from));
  for (;;) {
    if (existsSync(join(dir, '.sterling', 'sterling.db'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root — bounded, never walks forever
    dir = parent;
  }
}

/**
 * Hook stdin, with cwd NORMALIZED TO THE PROJECT ROOT.
 *
 * Every consumer in this layer already treats input.cwd as the project root: it
 * joins .sterling/ onto it (store, config, read-ledger, transient markers, debug
 * scope, delivery guard) and resolves repo-relative tool paths against it. The
 * platform, however, hands the hook the SHELL's working directory, which follows a
 * Bash `cd` — confirmed deterministic 2026-07-27 (board 51b1e2c0): a `cd` into any
 * subdirectory made H3 fail CLOSED on 'no Sterling store' while H7/H9/H13/H15/H16/H19
 * took their no-store branch and went SILENTLY inert, disarming the whole
 * knowledge-duty layer with no throw, no residue and no detector.
 *
 * Normalizing once at this boundary fixes every consumer instead of eleven call
 * sites. When no project is found above, cwd is left EXACTLY as given — absent and
 * unevaluable stay distinct (hooks-suite AC1), so a non-Sterling project is still
 * silently allowed rather than gated against someone else's store.
 */
export function readStdin() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const root = projectRoot(input.cwd);
  if (root) input.cwd = root;
  return input;
}

/** Block: exit 2 with the rule named on stderr (§6 — exit 1 is non-blocking by platform semantics). */
export function deny(message) {
  process.stderr.write(message);
  process.exit(2);
}

export function allow() {
  process.exit(0);
}

/** Non-blocking internal failure: loud on stderr, exit 1 (P5: visible, never a silent gate-void). */
export function warnNonBlocking(message) {
  process.stderr.write(message);
  process.exit(1);
}

export function loadConfig(cwd) {
  const p = join(cwd, '.sterling', 'config.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Synchronous sleep for the store busy-retry (no async in a hook body). */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry a store op past a transient SQLITE_BUSY (the live MCP server can hold a
 * brief lock); a persistent / non-busy throw (corrupt db) propagates — the
 * caller decides the terminal state (blocking gates deny, P5).
 */
export function withRetry(fn) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/SQLITE_BUSY|database is locked|is locked|busy/i.test(msg)) throw e;
      last = e;
      sleepMs(25 * (i + 1));
    }
  }
  throw last;
}

/** Open the project store if the project is Sterling-initialized; null otherwise. */
export function openStore(cwd) {
  const p = join(cwd, '.sterling', 'sterling.db');
  return existsSync(p) ? new SterlingStore(p) : null;
}

/**
 * Repo-relative POSIX form of a tool path (absolute or relative), or null when
 * the path is outside the repository (§3.2 path invariant at the hook boundary).
 */
export function repoRel(toolPath, cwd) {
  if (!toolPath) return null;
  const fwd = String(toolPath).replace(/\\/g, '/');
  try {
    if (/^[A-Za-z]:/.test(fwd) || fwd.startsWith('/')) return toRepoRelative(fwd, cwd);
    return normalizeRepoPath(fwd);
  } catch {
    return null;
  }
}
