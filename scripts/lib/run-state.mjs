// Run-state refusal wording, defined once (decision pending — see the history
// entry on run-disposal-gate). THE DEFECT THIS EXISTS TO KILL: four gates
// (dispose-run's promotion check, merge-gate, consume-exit, and the run_signal
// pair) each printed the OBSERVED state and the EXPECTED one and stopped there —
// so "you are too early" and "this already happened" shared one sentence and one
// remedy. Told to an already-merged run, merge-gate's "the gate opens after
// disposal" sends the operator to run disposal on a run that has been merged;
// dispose-run then refuses from the other side, costing a full round trip. The
// discriminator is not the state name, which was always printed — it is WHICH SIDE
// of the expected state the observed one sits on.
import { MACHINE_STATES } from '@sterling/schemas';

// Lifecycle ORDER. This is ordering information the enum does not carry, so it
// lives here rather than being derived from MACHINE_STATES' array order by
// accident. 'merged' and 'rejected' are terminal ALTERNATIVES, not successive
// steps — both simply sit after the gate.
const LIFECYCLE = ['running', 'completing', 'awaiting_merge_gate', 'merged', 'rejected'];

// Deliberately OFF the sequence: a halted run is not "before" or "after"
// anything, it is parked on an escalation. Collapsing it into the ordering would
// reintroduce the very confusion this module removes.
const OFF_AXIS = ['halted'];

/** Every machine state must be classified, or the phrasing silently degrades to
 *  "off the sequence" for a state that actually has a position. Exported so the
 *  totality test can assert it against the schema enum rather than a copy. */
export function unclassifiedStates() {
  return MACHINE_STATES.filter((s) => !LIFECYCLE.includes(s) && !OFF_AXIS.includes(s));
}

const NEXT_MOVE = {
  running: 'the run is still executing phases — finish or escalate it; this gate does not apply yet',
  completing: 'disposal belongs here — run `node scripts/dispose-run.mjs [--run <id>]`',
  awaiting_merge_gate:
    'disposal has ALREADY run — the merge gate is next: `node scripts/merge-gate.mjs --run <id>` to see the summary, then `--decision merge|reject`',
  merged: 'the run is TERMINAL and its merge decision is recorded — there is nothing to do',
  rejected: 'the run is TERMINAL and was rejected — there is nothing to do',
  halted: 'the run is HALTED on an escalation — resolve that first (the escalations are on the run record)',
};

/**
 * One refusal sentence that says which side of `expected` the run actually sits
 * on, and what to do from there.
 *   runId/observed/expected — as read from the run record.
 *   why — the gate's own one-clause reason it wants `expected`.
 */
export function stateRefusal({ runId, observed, expected, why }) {
  const oi = LIFECYCLE.indexOf(observed);
  const ei = LIFECYCLE.indexOf(expected);
  let side;
  if (oi === -1) {
    side = `'${observed}' is not a point in the run lifecycle at all`;
  } else if (oi < ei) {
    side = `'${observed}' comes BEFORE '${expected}' — this is too EARLY`;
  } else {
    side = `'${observed}' comes AFTER '${expected}' — this has ALREADY happened, so re-running it is not the fix`;
  }
  const next = NEXT_MOVE[observed] ?? `'${observed}' is not a state this build knows — that is a defect, report it rather than working around it`;
  return `run '${runId}' is '${observed}', not '${expected}'. ${side}. ${why} NEXT: ${next}`;
}
