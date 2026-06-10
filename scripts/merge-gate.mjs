// Merge gate [S] (spec §8.1 spine slice): the second of the two human gates.
// Without --decision: print the gate summary (state, escalations, every
// check_skipped — a wrong skip is auditable, never silent). With --decision:
// record the human's call via CAS. Branch operations are the §16.2 branch
// manager — skipped loudly here.
//   node scripts/merge-gate.mjs --run <id> [--decision merge|reject] [--target <dir>]
import { arg, fail, openProject, requireRun } from './lib/project.mjs';

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

// Branch manager (run branch merge/discard) is §16.2 step 8 — skipped loudly.
store.recordCheckSkipped(decision === 'merge' ? 'branch-merge' : 'branch-discard', 'not_built', run.id, new Date().toISOString());
const next = { ...run, machine_state: decision === 'merge' ? 'merged' : 'rejected' };
store.casTransition('awaiting_merge_gate', next);
store.close();
console.log(JSON.stringify({ run_id: run.id, decision, machine_state: next.machine_state, note: 'branch operations skipped loudly (branch manager not built)' }));
