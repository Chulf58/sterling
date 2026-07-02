// Phase commit [S] (spec §8.1): the conductor-invoked per-phase commit at the
// phase boundary — cleans the tree on the RUN BRANCH and records the sha on
// the run record (phases[].commits). Thin CLI over branch-manager's
// phaseCommit, which previously had no runtime caller (board 29652985):
// runs committed via raw git and commits[] stayed empty, so the TUI and
// resetToLastPhaseCommit had no recorded shas to lean on.
//   node scripts/phase-commit.mjs --run <id> --phase <id> [--message <m>] [--target <dir>]
import { arg, fail, openProject, requireRun } from './lib/project.mjs';
import { currentBranch, isGitRepo, phaseCommit } from './lib/branch-manager.mjs';

const target = arg('--target') ?? process.cwd();
const phaseId = arg('--phase');
if (!phaseId) fail('usage: phase-commit.mjs --run <id> --phase <id> [--message <m>] [--target <dir>]', 2);

const { store } = openProject(target);
const run = requireRun(store, arg('--run'));

try {
  if (!isGitRepo(target)) fail('phase-commit REFUSED: not a git repository', 2);
  if (run.machine_state !== 'running') {
    fail(`phase-commit REFUSED: run '${run.id}' is '${run.machine_state}', not running`, 2);
  }
  if (!run.phases.some((p) => p.id === phaseId)) {
    fail(`phase-commit REFUSED: no phase '${phaseId}' on run '${run.id}'`, 2);
  }
  const branch = currentBranch(target);
  if (branch !== run.branch) {
    fail(
      `phase-commit REFUSED: on '${branch}' but run '${run.id}' owns '${run.branch}' — a phase commit lands only on the run branch (§8.1)`,
      2
    );
  }
  const sha = phaseCommit({ cwd: target, store, runId: run.id, phaseId, message: arg('--message') });
  console.log(JSON.stringify({ committed: sha, run_id: run.id, phase_id: phaseId, branch }));
} finally {
  store.close();
}
