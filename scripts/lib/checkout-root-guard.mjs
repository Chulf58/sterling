// Shared preflight of fs-remove and fs-move (GitHub issue #331): paths are
// checkout-relative, so --target must be the git checkout root (main or linked
// worktree) or a non-git directory. Refuses (exit 2) otherwise, before any write.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fail } from './project.mjs';

// These variables relocate or hide git's checkout discovery (the probe here and the
// worktree probe inside resolveStoreRoot both inherit them), so a "not a git repository"
// answer under them proves nothing. Refuse rather than guess.
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

// `script` names the caller in messages; `untouched` finishes "Nothing was <untouched>."
export function requireCheckoutRoot(target, script, untouched) {
  const setLocationVars = GIT_LOCATION_ENV.filter((k) => process.env[k] !== undefined);
  if (setLocationVars.length) {
    fail(`${script} REFUSED: ${setLocationVars.join(', ')} set in the environment alter git's checkout discovery; unset them and rerun. Nothing was ${untouched}.`, 2);
  }
  // Only a positive "not a git repository" answer (exit 128, message pinned with LC_ALL=C)
  // takes the non-git path; a spawn error, timeout or any other git failure (dubious
  // ownership, git missing) refuses, since the checkout root cannot be established.
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: target, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
  const notGit = !top.error && top.status === 128 && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(top.stderr ?? '');
  if (notGit) return;
  if (top.error || top.status !== 0) {
    const why = top.error?.message ?? (String(top.stderr ?? '').trim() || `git exited ${top.status}`);
    fail(`${script} REFUSED: cannot establish the git checkout root of ${target} (${why}). Nothing was ${untouched}.`, 2);
  }
  if (realpathSync(top.stdout.trim()) !== realpathSync(target)) {
    fail(`${script} REFUSED: --target ${target} is inside the checkout ${top.stdout.trim()}; pass the checkout root with checkout-relative paths. Nothing was ${untouched}.`, 2);
  }
}
