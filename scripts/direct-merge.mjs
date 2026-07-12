// Direct merge [S] (spec §8.2): the conductor-direct counterpart to the §8.1
// merge gate (merge-gate.mjs). The human invoking it IS the merge-to-main
// decision — Sterling's second gate — so run it only once the change is
// committed and reconciled. It merges the current conductor-direct branch
// --no-ff into the base, then gives direct mode the branch hygiene runs already
// get from mergeRun: deletes the merged branch and sweeps every other
// fully-merged branch (git branch -d — refuses unmerged, never loses work).
// Refuses during an active run (a run merges through merge-gate.mjs, which keeps
// the disposal/promotion gate), on a dirty tree, or when already on the base.
//   node scripts/direct-merge.mjs [--into <branch>] [--branch <branch>] [--target <dir>]
import { spawnSync } from 'node:child_process';
import { arg, fail, openProject } from './lib/project.mjs';
import { isGitRepo, currentBranch, defaultBranch, mergeBranchInto, sweepMergedBranches } from './lib/branch-manager.mjs';

const target = arg('--target') ?? process.cwd();
if (!isGitRepo(target)) fail('direct-merge: not a git repository');

// A run owns the working tree and merges through the §8.1 gate, which runs
// disposal + promotion first — never route a run merge through here (P5).
const { store } = openProject(target);
const active = store.getRun();
const openTodos = store.query({ types: ['todo'], cap: 1000 });
store.close();
if (active) {
  fail(`direct-merge: run '${active.id}' is active (${active.machine_state}) — a run merges through merge-gate.mjs, not direct-merge`);
}

const into = arg('--into') ?? defaultBranch(target);
const branch = arg('--branch') ?? currentBranch(target);
if (branch === into) {
  fail(`direct-merge: currently on the base branch '${into}' — checkout the branch to merge, or pass --branch`);
}

// Gate precondition (merge.md): every affected article reconciled. Open
// reconcile_needed debt on files this branch changed refuses the merge — the
// §8.2 mirror of dispose-run's article_unreconciled refusal (decision 9df61181).
const diff = spawnSync('git', ['diff', '--name-only', '--end-of-options', `${into}...${branch}`], { cwd: target, encoding: 'utf8', timeout: 60_000 });
if (diff.status !== 0) fail(`direct-merge: git diff ${into}...${branch} failed: ${(diff.stderr || '').trim()}`);
const changed = new Set(diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
const debt = openTodos.filter(
  (t) => t.source === 'system' && t.system_reason === 'reconcile_needed' && (t.file_keys ?? []).some((k) => changed.has(k))
);
if (debt.length > 0) {
  fail(
    `direct-merge: ${debt.length} open reconcile_needed item(s) cover files this branch changed — reconcile before merging:\n` +
      debt.map((t) => `  - ${t.id}  ${t.text}  [${(t.file_keys ?? []).join(', ')}]`).join('\n') +
      '\nknowledge_update the owning article (the update auto-drains its item), then rerun.'
  );
}

const merged = mergeBranchInto({ cwd: target, branch, into });
const swept = sweepMergedBranches({ cwd: target, into });
console.log(JSON.stringify({ ...merged, branches_swept: swept }, null, 2));
