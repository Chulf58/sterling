// Shared hook plumbing. Hooks import workspace packages at AUTHOR time; the
// ship step esbuild-bundles them so the runtime is standalone (invariant 4).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRepoPath, toRepoRelative } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';

export function readStdin() {
  return JSON.parse(readFileSync(0, 'utf8'));
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
