// Branch manager (spec §8.1, branch model LOCKED): the run executes on the run
// branch checked out IN-PLACE in the single working tree — the observed tree
// IS the run; no worktrees. Phase commits clean the tree at phase boundaries;
// agent-died resets to the last phase commit; rejection deletes the branch
// with main untouched (P7: rejection is cheap by design).
import { spawnSync } from 'node:child_process';

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
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

export function runBranchName(runId) {
  return `sterling/run-${runId}`;
}

/** Run-branch creation at gate approval. Requires a clean tree (fail loud, never stash silently). */
export function startRunBranch({ cwd, store, runId }) {
  const status = git(cwd, ['status', '--porcelain']);
  if (status) {
    throw new Error(`branch-manager: working tree is dirty — a run owns the whole tree (§8.1); commit or discard first:\n${status}`);
  }
  const base = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = runBranchName(runId);
  git(cwd, ['checkout', '-b', branch]);
  store.updateRunOptimistic(runId, (run) => ({ ...run, branch, base_branch: base }));
  return { branch, base };
}

/** Per-phase commit: cleans the tree at the phase boundary; sha recorded on the run record. */
export function phaseCommit({ cwd, store, runId, phaseId, message }) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message ?? `sterling run ${runId} phase ${phaseId}`, '--no-verify']);
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  store.updateRunOptimistic(runId, (run) => ({
    ...run,
    phases: run.phases.map((p) => (p.id === phaseId ? { ...p, commits: [...p.commits, sha] } : p)),
  }));
  return sha;
}

/** agent-died / research-resume reset (P7): discard uncommitted partial work back to the last phase commit. */
export function resetToLastPhaseCommit({ cwd }) {
  git(cwd, ['reset', '--hard', 'HEAD']);
  git(cwd, ['clean', '-fd']);
}

/** Does a local branch exist? Used by the gate to make a post-wedge retry idempotent. */
export function branchExists(cwd, branch) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) !== '';
}

/** Merge gate approval: --no-ff merge into the base branch, then delete the run branch. */
export function mergeRun({ cwd, store, runId }) {
  const run = store.getRun(runId);
  if (!run?.base_branch) throw new Error(`branch-manager: run '${runId}' has no recorded base_branch`);
  git(cwd, ['checkout', run.base_branch]);
  git(cwd, ['merge', '--no-ff', run.branch, '-m', `sterling: merge run ${runId}`]);
  git(cwd, ['branch', '-D', run.branch]);
  return { merged_into: run.base_branch };
}

/** Run rejection: branch deleted, base untouched. */
export function discardRun({ cwd, store, runId }) {
  const run = store.getRun(runId);
  if (!run?.base_branch) throw new Error(`branch-manager: run '${runId}' has no recorded base_branch`);
  git(cwd, ['checkout', run.base_branch]);
  git(cwd, ['branch', '-D', run.branch]);
  return { base_untouched: run.base_branch };
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
  git(cwd, ['checkout', into]);
  git(cwd, ['merge', '--no-ff', branch, '-m', message ?? `Merge ${branch} into ${into}`]);
  git(cwd, ['branch', '-d', branch]);
  return { merged_into: into, branch_merged: branch };
}

/** Delete every local branch already fully merged into `into` (safe -d; never `into` or the current branch). Returns the deleted names. */
export function sweepMergedBranches({ cwd, into }) {
  const cur = currentBranch(cwd);
  const candidates = git(cwd, ['branch', '--merged', into])
    .split('\n')
    .map((l) => l.replace(/^[*+]?\s*/, '').trim())
    .filter((b) => b && b !== into && b !== cur && !b.startsWith('('));
  const deleted = [];
  for (const b of candidates) {
    git(cwd, ['branch', '-d', b]);
    deleted.push(b);
  }
  return deleted;
}

/** Final-completeness input (§8.1): the whole-run diff file list vs the base branch. */
export function wholeRunDiffFiles({ cwd, store, runId }) {
  const run = store.getRun(runId);
  if (!run?.base_branch) throw new Error(`branch-manager: run '${runId}' has no recorded base_branch`);
  const out = git(cwd, ['diff', '--name-only', `${run.base_branch}...HEAD`]);
  return out ? out.split('\n').map((p) => p.replace(/\\/g, '/')) : [];
}
