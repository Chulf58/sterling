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
// With no timer, nothing ends a git that waits on a terminal prompt, so prompts
// are switched off, and the step is announced first so a long silence is not
// taken for a hang and interrupted (an interrupt is the same kill).
function git(cwd, args, { allowFail = false, treeWrite = false } = {}) {
  if (treeWrite) {
    console.error(`branch-manager: running \`git ${args[0]}\` with no time limit; this can take minutes on a slow drive; do not interrupt it.`);
  }
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(treeWrite ? { maxBuffer: Infinity, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } } : { timeout: 60_000 }),
  });
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
  // `rev-parse --verify --quiet` exits 1 for a ref that does not exist; any other
  // non-zero exit is git failing to answer, which is not "absent".
  const mergeHead = mergeR?.status === 0 ? true : mergeR?.status === 1 ? false : null;
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
  const here = onBranch ?? 'the checked-out branch';
  if (mergeHead === true) {
    lines.push(
      `\`git ${step}\` stopped on conflicts: a merge of ${branch} is in progress on ${here}.`,
      `Do NOT \`git add\` or commit here: that would finish the conflicted merge on ${here}.`,
      `Abort it and go back to ${branch} (this discards the conflict markers; every commit on ${branch} is intact):`,
      '  git merge --abort'
    );
  } else {
    lines.push(
      `Do NOT \`git add\` or commit here until \`git status --short\` prints nothing: the changed paths were`,
      `partly written by the failed \`git ${step}\`, they are not your edits, and committing them puts a half-merge on ${here}.`,
      `Recover (this discards the partly written files; every commit on ${branch} is intact):`
    );
    if (mergeHead === null) lines.push('  git merge --abort        (only if a merge is in progress; git says so if not)');
  }
  // mergeBranchInto refuses to start unless `git status --porcelain` is empty, so
  // the tree had no untracked path before the step: any `??` path that outlives
  // the forced checkout was written by git (for example a file the base moved).
  // No -x: ignored files (.sterling/, node_modules/) were there before and stay.
  lines.push(
    `  git checkout -f ${branch}`,
    'If `git status --short` then still lists `??` paths, git wrote them (the merge only starts on a tree',
    'with no untracked paths). List them, then remove them:',
    '  git clean -nd',
    '  git clean -fd',
    mergeHead === true
      ? `Once \`git status --short\` prints nothing, resolve the conflicts on ${branch} (merge ${here} into it, fix them, commit), then rerun the merge.`
      : 'Once `git status --short` prints nothing, rerun the merge.'
  );
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
