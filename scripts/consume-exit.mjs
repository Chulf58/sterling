// consume-exit [S] (spec §5.2, run-proven r-0001): a NON-TERMINAL step's
// `complete` is phase-scoped — the conductor consumes it as the next §8.1
// step instead of signalling the brain. Recorded on the run record via
// same-state CAS (clears the pending-exit slot; the audit trail holds).
// Abnormal exits are REFUSED here: they go to run_signal immediately.
//   node scripts/consume-exit.mjs --run <id> [--step <label>] [--target <dir>]
import { arg, fail, openProject, requireRun } from './lib/project.mjs';

const target = arg('--target') ?? process.cwd();
const { store } = openProject(target);
const run = requireRun(store, arg('--run'));
const step = arg('--step');

try {
  const exit = store.getPendingExit(run.id);
  if (!exit) fail(`consume-exit REFUSED: no pending exit on run '${run.id}'`, 2);
  if (exit.signal !== 'complete') {
    fail(
      `consume-exit REFUSED: pending exit is '${exit.signal}' — abnormal exits go to run_signal immediately, from any position (§5.2)`,
      2
    );
  }
  if (run.machine_state !== 'running') {
    fail(`consume-exit REFUSED: run '${run.id}' is '${run.machine_state}', not running`, 2);
  }
  const idx = exit.phase_id
    ? run.phases.findIndex((p) => p.id === exit.phase_id)
    : run.phases.findIndex((p) => p.status === 'in_progress');
  if (idx === -1) fail(`consume-exit REFUSED: no phase '${exit.phase_id ?? '(current)'}' on run '${run.id}'`, 2);

  const phases = run.phases.map((p, i) =>
    i === idx
      ? {
          ...p,
          signals: [
            ...p.signals,
            { signal: 'complete', payload: exit.payload ?? null, agent_role: exit.agent_role ?? null, intra_phase: true, step: step ?? null, at: new Date().toISOString() },
          ],
        }
      : p
  );
  // same-state CAS: machine_state unchanged; the swap clears pending_exit
  store.casTransition(run.machine_state, { ...run, phases });
  console.log(
    JSON.stringify({ consumed: 'complete', run_id: run.id, phase_id: run.phases[idx].id, agent_role: exit.agent_role ?? null, step: step ?? null })
  );
} finally {
  store.close();
}
