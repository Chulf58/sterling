// Shared clone-currency READ (board 4ccf0644): is the Sterling CLONE at
// `root` behind origin's default branch? This is a passive, READ-ONLY probe
// — it never runs `git fetch` itself, so it never opens a second fetch path
// beside H1's own throttled one (decision 558895a9, scripts/hooks/h1-session-
// start.mjs). It only computes the behind-count against whatever ref state
// H1's own SessionStart cadence (or a manual fetch/update) has already left
// behind — the exact same LOCAL computation H1 performs after its own
// throttled fetch, just without ever triggering a fetch of its own.
//
// Mirrors H1's guard conditions (declared-authoring role, worktree, no
// origin, off the default branch) so this caveat only ever fires where H1's
// own signal would also fire — never a second, differently-scoped notion of
// "current".
//
// BOOTSTRAP INDEPENDENCE: imported by scripts/lib/consumer-checks.mjs at
// load time AND dynamically by the generated sterling-check.mjs launcher
// itself, which must run on a clone where nothing is built — builtins only.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * @param {string} root - the Sterling CLONE root (not a consuming project)
 * @returns {{ behind: number } | null} null when the probe does not apply
 *   (no .git dir, a worktree, a declared-authoring clone, no origin, off the
 *   default branch) or on any git failure — fail-open, never throws (P1).
 */
export function readCloneCurrency(root) {
  try {
    // Honored FIRST, exactly as H1 does (h1-session-start.mjs): this is the
    // hook-test hermeticity switch — the battery must never touch git here
    // either, so this read-only probe stays silenced everywhere H1 is.
    if (process.env.STERLING_CURRENCY_DISABLE === '1') return null;
    const gitDir = join(root, '.git');
    // .git as a FILE is a worktree — an authoring-machine shape; skip.
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return null;

    let role = null;
    try {
      role = JSON.parse(readFileSync(join(root, '.sterling', 'config.json'), 'utf8')).machine_role;
    } catch {
      // no config or malformed — the safe posture is consumer
    }
    if (role === 'authoring') return null;

    const git = (args, timeout = 5_000) => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout });
      return r.status === 0 ? (r.stdout ?? '').trim() : null;
    };
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const hasOrigin = (git(['remote']) ?? '').split('\n').includes('origin');
    if (!hasOrigin) return null;
    const defaultBranch = (git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) ?? '').replace(/^origin\//, '') || 'main';
    if (!branch || branch !== defaultBranch) return null;

    const behind = Number.parseInt(git(['rev-list', '--count', `HEAD..origin/${defaultBranch}`]) ?? '', 10);
    return Number.isFinite(behind) ? { behind } : null;
  } catch {
    return null;
  }
}

/**
 * One rendered caveat line for sterling-check.mjs's output, or null when
 * current / not applicable — informational only, never a failure signal.
 */
export function cloneCurrencyCaveat(root) {
  const result = readCloneCurrency(root);
  if (!result || result.behind <= 0) return null;
  return `⚠ Sterling clone is ${result.behind} update(s) behind origin — these check results may be running an outdated ruleset. Run /sterling:update (or double-click sterling-update.bat), then restart the session.`;
}
