// start-run [S] — the owned run-creation surface at GATE APPROVAL (§8.1,
// r-0001 exposed the gap; the hand driver dies here). The run record + machine
// state begin at gate approval; everything before is conversation + the brief.
// Gates, in order: brief exists and is active · agent set visible (§12 restart
// gate) · git repo with a CLEAN tree (the run owns the whole tree) · no active
// run (store-enforced). Creates the run record and checks out the run branch.
//   node scripts/start-run.mjs --brief <id> --session-started <ISO> [--run-id <id>] [--target <dir>]
import { randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, fail, openProject } from './lib/project.mjs';
import { isGitRepo, startRunBranch, runBranchName } from './lib/branch-manager.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(arg('--target') ?? process.cwd());
const briefId = arg('--brief');
const sessionStartedAt = arg('--session-started');
if (!briefId || !sessionStartedAt) {
  fail('usage: start-run.mjs --brief <id> --session-started <ISO> [--run-id <id>] [--target <dir>]', 2);
}

const { store } = openProject(target);
try {
  const brief = store.get(briefId);
  if (!brief || brief.type !== 'brief') fail(`start-run REFUSED: '${briefId}' is not a brief in the store`, 2);
  if (brief.status !== 'active') fail(`start-run REFUSED: brief '${briefId}' is ${brief.status}`, 2);

  // §12: the first pipeline run is blocked until the runtime check confirms
  // the installed agent set is visible to THIS session.
  const { checkAgentsVisible } = await import('./lib/agent-distribution.mjs');
  const visibility = checkAgentsVisible({
    registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
    targetAgentsDir: join(target, '.claude', 'agents'),
    sessionStartedAt,
  });
  if (!visibility.visible) {
    fail(
      `start-run REFUSED: installed agent set is not visible to this session:\n  ${visibility.problems.map((p) => `${p.name}: ${p.reason}`).join('\n  ')}\nRestart Claude Code in this project, then approve the gate again.`,
      2
    );
  }

  if (!isGitRepo(target)) {
    fail('start-run REFUSED: not a git repository — the run executes on a run branch in-place (§8.1 branch model, locked)', 2);
  }
  // clean-tree check BEFORE the run record exists: a dirty-tree refusal must
  // not leave an orphaned active run blocking the retry
  const { spawnSync } = await import('node:child_process');
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
  if (dirty) fail(`start-run REFUSED: working tree is dirty — a run owns the whole tree (§8.1); commit or discard first:\n${dirty}`, 2);

  const runId = arg('--run-id') ?? `r-${randomBytes(2).toString('hex')}`;
  const run = store.createRun({
    id: runId,
    brief_ref: brief.id,
    branch: runBranchName(runId), // set properly by startRunBranch below
    machine_state: 'running',
    phases: brief.phases.map((p, i) => ({ id: p.phase_id, status: i === 0 ? 'in_progress' : 'pending', signals: [], commits: [] })),
    dispatch_counts: {},
    escalations: [],
    started_at: new Date().toISOString(),
  });
  const { branch, base } = startRunBranch({ cwd: target, store, runId: run.id });
  console.log(JSON.stringify({ run_id: run.id, branch, base, phases: run.phases.map((p) => p.id) }));
} finally {
  store.close();
}
