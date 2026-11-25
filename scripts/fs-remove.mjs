// fs-remove: conductor-invoked deletion that registers the file-touch so owning
// articles get reconciled. A registered debug scope is metadata only and never
// refuses a path (decision debug-scope-is-metadata-fs-helpers-stop-refusing).
//   node scripts/fs-remove.mjs <path>... [--target <dir>]
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRepoPath } from '@sterling/schemas';
import { arg, fail, openProject } from './lib/project.mjs';
import { resolveStoreRoot } from './lib/worktree-root.mjs';
import { ContainmentError, containedPath, existsContained, unlinkContained } from './lib/contained-fs.mjs';
import { observePaths } from './hooks/lib/reconcile-origins.mjs';

const target = arg('--target') ?? process.cwd();
const paths = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== target);
if (!paths.length) fail('usage: fs-remove.mjs <repo-relative path>... [--target <dir>]');

// Paths are checkout-relative: deletion, ownership lookup and observations must all
// share one root, so --target is the git checkout root (main or linked worktree) or a
// non-git directory. Any subdirectory of a checkout is refused, nested .sterling or not.
// A linked worktree has no .sterling/ (gitignored): the store is the main checkout's,
// while the files are deleted under `target` (GitHub issue #331).
// These variables relocate or hide git's checkout discovery (the probe here and the
// worktree probe inside resolveStoreRoot both inherit them), so a "not a git repository"
// answer under them proves nothing. Refuse rather than guess.
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];
const setLocationVars = GIT_LOCATION_ENV.filter((k) => process.env[k] !== undefined);
if (setLocationVars.length) {
  fail(`fs-remove REFUSED: ${setLocationVars.join(', ')} set in the environment alter git's checkout discovery; unset them and rerun. Nothing was removed.`, 2);
}
// Only a positive "not a git repository" answer (exit 128, message pinned with LC_ALL=C)
// takes the non-git path; a spawn error, timeout or any other git failure (dubious
// ownership, git missing) refuses, since the checkout root cannot be established.
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: target, encoding: 'utf8', timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
const notGit = !top.error && top.status === 128 && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(top.stderr ?? '');
if (!notGit) {
  if (top.error || top.status !== 0) {
    const why = top.error?.message ?? (String(top.stderr ?? '').trim() || `git exited ${top.status}`);
    fail(`fs-remove REFUSED: cannot establish the git checkout root of ${target} (${why}). Nothing was removed.`, 2);
  }
  if (realpathSync(top.stdout.trim()) !== realpathSync(target)) {
    fail(`fs-remove REFUSED: --target ${target} is inside the checkout ${top.stdout.trim()}; pass the checkout root with checkout-relative paths. Nothing was removed.`, 2);
  }
}
const storeRoot = resolveStoreRoot(target);
const { store } = openProject(storeRoot);
const now = new Date().toISOString();

const removed = [];
try {
  for (const p of paths) {
    const rel = normalizeRepoPath(p);
    try {
      containedPath(target, rel, 'file');
      if (!existsContained(target, rel, 'file')) fail(`fs-remove REFUSED: '${rel}' does not exist`, 2);
    } catch (e) {
      if (e instanceof ContainmentError) fail(`fs-remove REFUSED: ${e.message}; nothing was removed`, 2);
      throw e;
    }
  }
  for (const p of paths) {
    const rel = normalizeRepoPath(p);
    unlinkContained(target, rel);
    removed.push(rel);
    // Checkout evidence (decision maintenance-reconciliation-retains-checkout-evidence-and-use):
    // without it a worktree deletion is held for the conductor forever.
    const seen = observePaths(target, [rel], storeRoot);
    // file-touch registration (H7 semantics): owners need reconciliation
    for (const article of store.query({ types: ['feature_article'], file_keys: [rel], cap: 100 })) {
      // Atomic, (reason, feature_link, file)-keyed dedup in the store — one
      // definition instead of the four hand-rolled copies that raced each other
      // and dropped a second file's finding (board 2ded3b4b).
      store.enqueueSystemTodo({
        id: randomUUID(), type: 'todo', created_at: now, updated_at: now, author: 'system', status: 'active',
        superseded_by: null, links: [], scope: 'project', stack_tags: [],
        text: `reconcile article '${article.slug}' — '${rel}' was removed`,
        source: 'system', system_reason: 'reconcile_needed', file_keys: [rel], feature_link: article.id,
        ...(seen ? { observations: seen.observations } : {}),
      }, { operation_id: randomUUID() });
    }
  }
} finally {
  store.close();
}
console.log(JSON.stringify({ removed }));
