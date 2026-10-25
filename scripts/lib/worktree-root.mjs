import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isSterlingRoot } from '../hooks/lib/store-backend.mjs';

// Opt-in worktree detection (board ks-dashboards-gap-1). A LINKED git worktree
// never has `.sterling/` (it is gitignored), so resolveProject, which reads only
// <cwd>/.sterling, reports "not an initialized project" there. Callers that can
// work from a worktree ask this first and pass the returned mainRoot to
// openProject; every other caller keeps resolveProject's behaviour unchanged.
// A linked worktree is one whose `--git-dir` differs from its `--git-common-dir`;
// the main checkout is the parent of the common dir. Returns
// { worktree, mainRoot } (real paths) for a linked worktree, or null for the
// main checkout, a non-git directory, git failing, and a bare-repo main (whose
// common dir is not `<checkout>/.git`, so there is no main checkout to name).
export function resolveLinkedWorktree(cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  const [gitDir, commonDir, toplevel] = r.stdout.split('\n').map((l) => l.trim());
  if (!gitDir || !commonDir || !toplevel) return null;
  const gitDirReal = realpathSync(resolve(cwd, gitDir));
  const commonReal = realpathSync(resolve(cwd, commonDir));
  if (gitDirReal === commonReal || basename(commonReal) !== '.git') return null;
  return { worktree: realpathSync(toplevel), mainRoot: dirname(commonReal) };
}

// The directory that holds a script's .sterling/ (config, store, PR-loop marker)
// for a `--target`. The main checkout's config wins for a linked worktree; only
// when the main checkout has none and the worktree carries its own (a copy, per
// anti-pattern e76fd6b9) does the worktree become the root, so the config, the
// store and the PR-loop marker all live in the one root that holds the config,
// never split across two. Outside a worktree it is `target` itself.
export function resolveStoreRoot(target, linkedWorktree = resolveLinkedWorktree(target)) {
  if (!linkedWorktree) return target;
  const configRel = join('.sterling', 'config.json');
  const worktreeOnlyConfig = !existsSync(join(linkedWorktree.mainRoot, configRel)) && existsSync(join(linkedWorktree.worktree, configRel));
  return worktreeOnlyConfig ? linkedWorktree.worktree : linkedWorktree.mainRoot;
}

// Each linked-worktree probe per directory, so a long-lived caller (the OpenCode
// plugin asks on every event) spawns git once per directory, not once per call.
const linkedProbes = new Map();
function linkedWorktreeOnce(dir) {
  if (!linkedProbes.has(dir)) linkedProbes.set(dir, resolveLinkedWorktree(dir));
  return linkedProbes.get(dir);
}

function gitFileAt(dir) {
  try {
    return statSync(join(dir, '.git')).isFile();
  } catch {
    return false; // no .git entry here (ENOENT, or an unreadable parent): not a checkout boundary
  }
}

/**
 * The two roots a Sterling session in `from` works with, or null outside a
 * Sterling project: { storeRoot, checkoutRoot }. storeRoot holds the project's one
 * store, config, board, ledgers and handoffs; checkoutRoot is the git checkout
 * whose HEAD, files and .sterling/transient state belong to this session. They
 * differ only in a linked git worktree, wherever it sits: outside the main
 * checkout, or nested inside it (.claude/worktrees/*), where the old ancestor walk
 * reached the MAIN root and shared its transient state.
 *
 * Walks up from `from`. At a directory whose `.git` is a FILE (a linked worktree's
 * or a submodule's toplevel) it asks git: a linked worktree whose store root
 * (resolveStoreRoot: the main checkout's config wins) is a Sterling root answers
 * there. A submodule (git-dir equals common-dir) and a worktree of a non-Sterling
 * repo keep walking, exactly as before. Otherwise the first Sterling root found
 * answers with both roots equal, which is the old behaviour for every plain project.
 *
 * Does NOT guarantee: that checkoutRoot is a git toplevel for a plain project (it
 * is the Sterling root, as before); that the worktree still exists after the
 * first probe (results are cached per directory for the process's life); a
 * bare-repo main (resolveLinkedWorktree returns null there, so the walk goes on).
 */
export function resolveProjectRoots(from, isRoot = isSterlingRoot) {
  if (!from) return null;
  let dir = resolve(String(from));
  for (;;) {
    if (gitFileAt(dir)) {
      const linked = linkedWorktreeOnce(dir);
      if (linked) {
        const storeRoot = resolveStoreRoot(linked.worktree, linked);
        if (isRoot(storeRoot)) return { storeRoot, checkoutRoot: linked.worktree };
      }
    }
    if (isRoot(dir)) return { storeRoot: dir, checkoutRoot: dir };
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root: bounded, never walks forever
    dir = parent;
  }
}

/**
 * The directory holding the store and config for `dir`: the store root when `dir`
 * is itself a linked worktree's checkout root of a Sterling project, else `dir`
 * unchanged. Deliberately not a walk: a directory that is not a worktree toplevel
 * answers for itself, so a caller's "is there a config here" keeps its meaning.
 * Store and config readers that a checkout-rooted caller reaches (the OpenCode
 * plugin passes the checkout) go through this.
 */
export function storeRootFor(dir, isRoot = isSterlingRoot) {
  if (!dir) return dir;
  const at = resolve(String(dir));
  if (!gitFileAt(at)) return dir;
  const linked = linkedWorktreeOnce(at);
  if (!linked || realOf(at) !== linked.worktree) return dir;
  const storeRoot = resolveStoreRoot(linked.worktree, linked);
  return isRoot(storeRoot) ? storeRoot : dir;
}

function realOf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p; // vanished between the stat and here: compare the lexical path, which then never matches git's realpath
  }
}
