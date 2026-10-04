// Branch manager (spec §8.2): conductor-direct branch hygiene only — the
// What remains:
// isGitRepo (used repo-wide) and the direct-mode merge + branch-sweep helpers
// (mergeBranchInto, sweepMergedBranches, currentBranch, defaultBranch)
// scripts/direct-merge.mjs drives.
import { spawnSync } from 'node:child_process';

// treeWrite: a step that rewrites the working tree (checkout, merge) gets NO
// wall-clock timeout. spawnSync's timeout kills git with SIGTERM, and git killed
// while it writes the tree leaves the base checked out at its old commit with a
// partly written tree, no MERGE_HEAD and no lock: thousands of paths that look
// like local edits, one `git add` away from a half-merge on the base (Dome
// Farmer, 2026-10-03: a merge of 325 commits on a Windows drive under WSL2
// outran the 60 s below). No finite value is safe on a slow drive, so there is
// none. maxBuffer is lifted for the same reason: spawnSync also kills the child
// when its output passes 1 MB, and a large merge prints a long diffstat.
function git(cwd, args, { allowFail = false, treeWrite = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...(treeWrite ? { maxBuffer: Infinity } : { timeout: 60_000 }) });
  if (r.status !== 0 && !allowFail) {
    // Evidence capture for the unreproduced 'fatal: stash failed' class (board
    // aa01da07): a spawnSync that never ran or timed out has status null and an
    // error/signal — name that state instead of printing 'failed (null)', so a
    // recurrence is distinguishable from a real git nonzero exit at the message.
    const spawnState =
      r.error ? `spawn-error ${r.error.code ?? r.error.message}` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    throw new Error(`git ${args.join(' ')} failed (${spawnState}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout ?? '').trim();
}

// NOTE for whoever next investigates `fatal: stash failed` from the merge steps
// below (board f37e1dae, 2026-08-03 — CAUSE STILL UNIDENTIFIED): do NOT "fix" it
// by refreshing the index here. That was tried and reverted. `git merge` does
// spawn `git stash create` (GIT_TRACE-confirmed on 2.53.0, even for a clean tree
// with the single default strategy), and that child DOES exit 1 with empty stdout
// and stderr when index entries look stat-stale while content is identical — a
// state reachable on /mnt/c when WSL git and Windows git.exe both write one
// .git/index, and invisible to the dirty-tree gates below because `git status
// --porcelain` content-compares and reports clean. Detector: `git diff-files
// --quiet` exits 1 while `status --porcelain` is empty. BUT git's own save_state()
// calls refresh_index() and writes the index back immediately BEFORE spawning
// that child, so git already self-cures this state: a poisoned index did not
// break a merge in 6/6 conductor trials, and reproduction was unstable even for
// the agent that first reported it (3/3, then 0/3, then 1/4). A pre-merge refresh
// is therefore a no-op duplicating git's own behaviour, and cannot be the cause.

export function isGitRepo(cwd) {
  return spawnSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8', timeout: 30_000 }).status === 0;
}

// ── Conductor-direct branch hygiene (§8.2) ──────────────────────────────────
// The direct-mode counterpart to mergeRun/discardRun above. Runs auto-clean
// their branch on merge; conductor-direct branches had no lifecycle and so
// accreted. These are run-agnostic and SAFE-delete only — `git branch -d`
// refuses an unmerged branch, so a sweep can never lose work (unlike the run
// path's -D, which is sound only because a run branch is fully merged or
// discarded by construction).

/** The branch currently checked out. */
export function currentBranch(cwd) {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** The base to merge back into: origin's default if known, else main, else master. Fail loud if none. */
export function defaultBranch(cwd) {
  const sym = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (sym) return sym.replace(/^origin\//, '');
  for (const b of ['main', 'master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true })) return b;
  }
  throw new Error('branch-manager: cannot determine the default branch (no origin/HEAD, no main, no master) — pass --into');
}

/** What a failed tree-writing step left behind, and how to get back to the
 *  feature branch. Read-only: it never resets or checks out anything, because
 *  discarding tree contents is the user's call. A value git could not give is
 *  printed as unknown and treated as not clean. */
function repoStateReport({ cwd, branch, step }) {
  const read = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: Infinity });
    return r.error || r.signal ? null : r;
  };
  const sym = read(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const onBranch = sym === null ? null : sym.status === 0 ? sym.stdout.trim() : '(detached HEAD)';
  const headR = read(['rev-parse', 'HEAD']);
  const head = headR?.status === 0 ? headR.stdout.trim() : null;
  const mergeR = read(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  const mergeHead = mergeR === null ? null : mergeR.status === 0;
  const statusR = read(['status', '--porcelain']);
  const changed = statusR?.status === 0 ? statusR.stdout.split('\n').filter(Boolean).length : null;
  const unknown = 'unknown (git could not answer)';
  const lines = [
    `REPO STATE after the failed \`git ${step}\` (nothing was reset or discarded for you):`,
    `  branch:     ${onBranch ?? unknown}`,
    `  HEAD:       ${head ?? unknown}`,
    `  MERGE_HEAD: ${mergeHead === null ? unknown : mergeHead ? 'present (a merge is in progress)' : 'absent'}`,
    `  changed paths: ${changed === null ? unknown : `${changed} (git status --porcelain)`}`,
  ];
  if (changed === 0 && mergeHead === false) {
    lines.push(
      onBranch === branch
        ? `The working tree is clean and still on ${branch}. Nothing to recover.`
        : `The working tree is clean. Return to the branch with: git checkout ${branch}`
    );
    return lines.join('\n');
  }
  lines.push(
    'Do NOT `git add` or commit here until `git status --short` prints nothing: the changed',
    `paths are a partly written merge of ${branch}, not your edits, and committing them puts a half-merge on ${onBranch ?? 'the checked-out branch'}.`,
    `Recover (this discards the partly written files; every commit on ${branch} is intact):`
  );
  if (mergeHead !== false) lines.push('  git merge --abort');
  lines.push(`  git checkout -f ${branch}`, 'then check that `git status --short` prints nothing, and rerun the merge.');
  return lines.join('\n');
}

/** Conductor-direct merge: --no-ff merge `branch` into `into`, then SAFE-delete `branch`. Requires a clean tree (fail loud, never stash). */
export function mergeBranchInto({ cwd, branch, into, message }) {
  const status = git(cwd, ['status', '--porcelain']);
  if (status) {
    // "commit or discard" is the wrong remedy for an UNTRACKED entry (?? in
    // porcelain) — on a Sterling project these are exactly the init-generated
    // machine-local launchers (sterling.bat, sterling-launch.sh,
    // .claude-plugin/sterling-mcp*.json), and "commit" would land machine junk
    // on the base branch. Give each kind its own remedy (direct-merge.mjs's
    // pre-check does the same split; this is the library invariant it fronts).
    const lines = status.split('\n').filter(Boolean);
    const untracked = lines.filter((l) => l.startsWith('??'));
    const tracked = lines.filter((l) => !l.startsWith('??'));
    const parts = ['branch-manager: working tree is dirty — refusing to merge:'];
    if (tracked.length > 0) parts.push(`${tracked.length} tracked change(s) — commit or discard before merging:`, ...tracked.map((l) => `  ${l}`));
    if (untracked.length > 0) {
      parts.push(
        `${untracked.length} untracked path(s) — decide their disposition first (commit, .gitignore, move out of the repo, or remove); "commit" is not always correct:`,
        ...untracked.map((l) => `  ${l}`)
      );
    }
    throw new Error(parts.join('\n'));
  }
  for (const args of [
    ['checkout', into],
    ['merge', '--no-ff', branch, '-m', message ?? `Merge ${branch} into ${into}`],
  ]) {
    try {
      git(cwd, args, { treeWrite: true });
    } catch (e) {
      throw new Error(`${e.message}\n${repoStateReport({ cwd, branch, step: args[0] })}`);
    }
  }
  git(cwd, ['branch', '-d', branch]);
  return { merged_into: into, branch_merged: branch };
}

/** Delete every local branch already fully merged into `into` (safe -d; never `into` or the current branch). Returns the deleted names.
 *  A `+`-prefixed line is a branch CHECKED OUT IN A WORKTREE — git refuses to
 *  delete it, so attempting to made the whole sweep (and the gate's exit code)
 *  fail over housekeeping (observed 2026-08-05: nine leftover agent worktrees).
 *  Skipped instead: the branch is merged, deleting it loses nothing, and the
 *  next sweep after the worktree is removed picks it up. */
export function sweepMergedBranches({ cwd, into }) {
  const cur = currentBranch(cwd);
  const candidates = git(cwd, ['branch', '--merged', into])
    .split('\n')
    .filter((l) => !l.startsWith('+'))
    .map((l) => l.replace(/^\*?\s*/, '').trim())
    .filter((b) => b && b !== into && b !== cur && !b.startsWith('('));
  const deleted = [];
  for (const b of candidates) {
    git(cwd, ['branch', '-d', b]);
    deleted.push(b);
  }
  return deleted;
}
