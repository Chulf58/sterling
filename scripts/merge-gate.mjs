// Merge gate [S] (spec §8.1 spine slice): the second of the two human gates.
// Without --decision: print the gate summary (state, escalations, every
// check_skipped — a wrong skip is auditable, never silent). With --decision:
// record the human's call via CAS. Branch operations are the §16.2 branch
// manager — skipped loudly here.
//   node scripts/merge-gate.mjs --run <id> [--decision merge|reject] [--target <dir>]
import { arg, fail, openProject, requireRun } from './lib/project.mjs';
import { isGitRepo, mergeRun, discardRun } from './lib/branch-manager.mjs';

const target = arg('--target') ?? process.cwd();
const { store } = openProject(target);
const run = requireRun(store, arg('--run'));
const decision = arg('--decision');

if (run.machine_state !== 'awaiting_merge_gate') {
  store.close();
  fail(`merge-gate: run '${run.id}' is '${run.machine_state}', not 'awaiting_merge_gate' — the gate opens after disposal (H9)`);
}

const summary = {
  run_id: run.id,
  branch: run.branch,
  phases: run.phases.map((p) => ({ id: p.id, status: p.status, signals: p.signals.length })),
  escalations: run.escalations,
  check_skipped: run.summaries?.check_skipped ?? [],
  scope_amendments: run.scope_amendments ?? [],
  // Disposal backstop surfaced at the gate (decision 628c4b7f (c)): the
  // undispositioned reviewer-mandatory remainder the disposal fold left on the
  // run summaries (P5 — the wire can be fooled, the gate cannot).
  undispositioned_mandatory: run.summaries?.undispositioned_mandatory ?? [],
  summaries: run.summaries ?? null,
};

if (!decision) {
  store.close();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}
if (decision !== 'merge' && decision !== 'reject') {
  store.close();
  fail("merge-gate: --decision must be 'merge' or 'reject'");
}

// Branch operations through the §8.1 branch manager; non-git projects degrade loud.
let branchNote;
if (isGitRepo(target) && run.base_branch) {
  branchNote = decision === 'merge' ? mergeRun({ cwd: target, store, runId: run.id }) : discardRun({ cwd: target, store, runId: run.id });
} else {
  const check = decision === 'merge' ? 'branch-merge' : 'branch-discard';
  store.recordCheckSkipped(check, run.base_branch ? 'no_git' : 'no_base_branch', run.id, new Date().toISOString());
  branchNote = { skipped: check };
}
// Merge-safe transition (audit findings 1/43, 18/43): apply the state change onto
// the FRESH body so any concurrent write is preserved (consistency with the other
// transition seams; at the merge gate the run is post-disposal so races are
// unlikely, but the seam is uniform).
const targetState = decision === 'merge' ? 'merged' : 'rejected';
store.casTransitionMerge('awaiting_merge_gate', run.id, (fresh) => ({ ...fresh, machine_state: targetState }));
store.close();
console.log(JSON.stringify({ run_id: run.id, decision, machine_state: targetState, branch: branchNote }));
