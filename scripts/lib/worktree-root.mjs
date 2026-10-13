import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
