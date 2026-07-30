// consume-exit [S] (spec §5.2, run-proven r-0001): a NON-TERMINAL step's
// `complete` is phase-scoped — the conductor consumes it as the next §8.1
// step instead of signalling the brain. Recorded on the run record via
// same-state CAS (clears the pending-exit slot; the audit trail holds).
// Abnormal exits are REFUSED here: they go to run_signal immediately.
//   node scripts/consume-exit.mjs --run <id> [--step <label>] [--discard-orphan] [--target <dir>]
// --discard-orphan (P5 recovery, incident 2026-07-03 run r-ea9e): a pending
// 'complete' whose phase_id is NOT on the run (e.g. a conductor-direct
// subagent's agent_exit binding to the active run) deadlocks the wire — every
// later agent_exit refuses on the full slot, and normal consumption cannot
// resolve the phase. With the flag, such an exit is consumed OFF the record:
// a same-state CAS with the run body unchanged clears the slot; nothing is
// appended to any phase, and the discard is printed loudly. The flag does
// nothing when the phase resolves — normal consumption always wins.
import { arg, fail, openProject, requireRun } from './lib/project.mjs';
import { stateRefusal } from './lib/run-state.mjs';

const target = arg('--target') ?? process.cwd();
const { store } = openProject(target);
const run = requireRun(store, arg('--run'));
const step = arg('--step');
const discardOrphan = process.argv.includes('--discard-orphan');

try {
  const exit = store.getPendingExit(run.id);
  if (!exit) {
    // NEVER-EXITED vs ALREADY-CONSUMED have OPPOSITE remedies, and one message
    // covered both: fabricate an agent-died signal, versus do nothing and proceed.
    // The run's own phase signals discriminate them.
    const consumed = run.phases.flatMap((p) => (p.signals ?? []).map((s) => `${p.id}:${typeof s === 'string' ? s : s.signal ?? '?'}`));
    fail(
      `consume-exit REFUSED: no pending exit on run '${run.id}'. Two very different causes: (a) the agent never called agent_exit — ` +
        `report it to the brain as agent-died{observed:'empty_output'} via run_signal; or (b) this exit was ALREADY consumed by an earlier ` +
        `consume-exit/run_signal, in which case do NOTHING and proceed to the next step. ` +
        (consumed.length
          ? `Signals already on this run: ${consumed.join(', ')} — if the step you are consuming is in that list, you are in case (b).`
          : 'This run carries NO phase signals yet, which points at case (a).'),
      2
    );
  }
  if (exit.signal !== 'complete') {
    fail(
      `consume-exit REFUSED: pending exit is '${exit.signal}' — abnormal exits go to run_signal immediately, from any position (§5.2)`,
      2
    );
  }
  if (run.machine_state !== 'running') {
    fail(
      `consume-exit REFUSED: ${stateRefusal({
        runId: run.id,
        observed: run.machine_state,
        expected: 'running',
        why: 'A phase-scoped complete is consumed only while the run is still executing phases.',
      })}`,
      2
    );
  }
  const idx = exit.phase_id
    ? run.phases.findIndex((p) => p.id === exit.phase_id)
    : run.phases.findIndex((p) => p.status === 'in_progress');
  if (idx === -1 && discardOrphan) {
    // Orphan consumption: the run body is unchanged — the same-state transition
    // exists solely to clear the pending-exit slot. Merge-safe (audit findings
    // 1/43, 18/43): an identity mutate on the FRESH body preserves any concurrent
    // hook write (a stale-body rewrite here would have dropped it).
    store.casTransitionMerge(run.machine_state, run.id, (fresh) => fresh);
    console.log(
      JSON.stringify({
        discarded_orphan_exit: { signal: exit.signal, phase_id: exit.phase_id ?? null, agent_role: exit.agent_role ?? null },
        run_id: run.id,
      })
    );
  } else if (idx === -1) {
    fail(
      `consume-exit REFUSED: no phase '${exit.phase_id ?? '(current)'}' on run '${run.id}' — an orphan 'complete' (e.g. a conductor-direct subagent's exit bound to the active run) can be cleared explicitly with --discard-orphan`,
      2
    );
  } else {
    // same-state transition: machine_state unchanged; it records the intra-phase
    // signal and clears pending_exit. Merge-safe (audit findings 1/43, 18/43): the
    // signal is appended onto the FRESH phases inside casTransitionMerge's retry
    // loop, so a concurrent hook write (H7 reconcile mark, H6/H8 escalation) is
    // preserved rather than clobbered by a rewrite from the stale snapshot.
    const at = new Date().toISOString();
    store.casTransitionMerge(run.machine_state, run.id, (fresh) => {
      const fIdx = exit.phase_id
        ? fresh.phases.findIndex((p) => p.id === exit.phase_id)
        : fresh.phases.findIndex((p) => p.status === 'in_progress');
      const phases = fresh.phases.map((p, i) =>
        i === fIdx
          ? {
              ...p,
              signals: [
                ...p.signals,
                { signal: 'complete', payload: exit.payload ?? null, agent_role: exit.agent_role ?? null, intra_phase: true, step: step ?? null, at },
              ],
            }
          : p
      );
      return { ...fresh, phases };
    });
    console.log(
      JSON.stringify({ consumed: 'complete', run_id: run.id, phase_id: run.phases[idx].id, agent_role: exit.agent_role ?? null, step: step ?? null })
    );
  }
} finally {
  store.close();
}
