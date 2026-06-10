// The brain (spec §5.1/§5.2): a deterministic state machine — pure function
// from (run record, exit, caps) to (action, next machine state). Zero LLM,
// zero tokens. The conductor is the hands: it executes exactly the returned
// action; mechanical actions are defaults it can hold, judgment actions wait.

import type { MachineState, RunRecord, Signal } from '@sterling/schemas';
import { SIGNALS } from '@sterling/schemas';

export interface ResolvedExit {
  signal: string;
  payload?: Record<string, unknown>;
  phase_id?: string;
  agent_role?: string;
}

/** §5.1 caps that convert loops into signals (tunable config). */
export interface BrainCaps {
  phase_death_cap: number;
  research_resume_per_phase: number;
}
export const DEFAULT_CAPS: BrainCaps = { phase_death_cap: 1, research_resume_per_phase: 2 };

export type BrainAction =
  | { action: 'spawn'; phase_id: string; respawn: boolean; note?: string }
  | { action: 'dispatch_support'; support_type: 'researcher'; payload?: unknown; note?: string }
  | { action: 'judgment_needed'; reason: string; payload?: unknown }
  | { action: 'complete_run' }
  | { action: 'halt'; reason: string };

export interface Reaction {
  action: BrainAction;
  nextState: MachineState;
}

interface ReactionEntry {
  /** §5.1 resolution flag: mechanical = table action executes as default; judgment = conductor must decide. */
  resolution: 'mechanical' | 'judgment' | 'mechanical_then_judgment';
  react(run: RunRecord, exit: ResolvedExit, caps: BrainCaps): Reaction;
}

function halt(reason: string): Reaction {
  return { action: { action: 'halt', reason }, nextState: 'halted' };
}

function judgment(reason: string, payload?: unknown): Reaction {
  return { action: { action: 'judgment_needed', reason, payload }, nextState: 'running' };
}

function phaseIndex(run: RunRecord, exit: ResolvedExit): number {
  if (exit.phase_id) return run.phases.findIndex((p) => p.id === exit.phase_id);
  return run.phases.findIndex((p) => p.status === 'in_progress');
}

function priorSignalCount(run: RunRecord, idx: number, signal: string): number {
  return run.phases[idx].signals.filter(
    (s) => typeof s === 'object' && s !== null && (s as { signal?: string }).signal === signal
  ).length;
}

// §5.1 reaction table — the full closed enum. `satisfies` makes the table
// compile-time total; the runtime totality test and commit-time check re-verify.
export const REACTIONS = {
  complete: {
    resolution: 'mechanical',
    react(run, exit) {
      const idx = phaseIndex(run, exit);
      if (idx === -1) return halt(`complete: no such phase '${exit.phase_id ?? '(current)'}' on run '${run.id}' (P5)`);
      if (idx === run.phases.length - 1) {
        return { action: { action: 'complete_run' }, nextState: 'completing' };
      }
      return { action: { action: 'spawn', phase_id: run.phases[idx + 1].id, respawn: false }, nextState: 'running' };
    },
  },
  'research-needed': {
    // mechanical dispatch, judgment resolve (§5.1): the classifier on the
    // finding routes resolve-vs-plan-broken when it lands; the dispatch is the default.
    resolution: 'mechanical_then_judgment',
    react(run, exit, caps) {
      const idx = phaseIndex(run, exit);
      if (idx === -1) return halt(`research-needed: no such phase '${exit.phase_id ?? '(current)'}' (P5)`);
      if (priorSignalCount(run, idx, 'research-needed') >= caps.research_resume_per_phase) {
        return judgment(
          `blocked: phase-underspecified — research-resume cap (${caps.research_resume_per_phase}) reached for phase '${run.phases[idx].id}' (§5.1)`,
          exit.payload
        );
      }
      return {
        action: {
          action: 'dispatch_support',
          support_type: 'researcher',
          payload: exit.payload,
          note: 'bounded brief, capped budget; on resolve: reset run branch to last phase commit (uncommitted partial work discarded — P7), re-run prep, respawn the phase with the finding staged; contradicts a plan assumption → escalate judgment: plan-broken',
        },
        nextState: 'running',
      };
    },
  },
  'review-unresolved': {
    resolution: 'judgment',
    react(_run, exit) {
      // post-cap (M) only; retry is futile by definition — surface the disagreement type
      return judgment('review-unresolved: surface to human with the disagreement type', exit.payload);
    },
  },
  blocked: {
    resolution: 'judgment',
    react(_run, exit) {
      return judgment('blocked', exit.payload);
    },
  },
  'tests-invalid': {
    resolution: 'judgment',
    react(_run, exit) {
      // never silently patched: route to test revision (re-dispatch test-writer with evidence) under human eye
      return judgment('tests-invalid: route to test revision under human eye — the fix loop never weakens its own oracle', exit.payload);
    },
  },
  'contract-violated': {
    resolution: 'judgment',
    react(_run, exit) {
      return judgment('contract-violated: gate-tripped — usually the plan mis-scoped the phase; re-plan', exit.payload);
    },
  },
  'bug-found': {
    resolution: 'judgment',
    react(_run, exit) {
      const p = exit.payload as { depends_on_current_work?: boolean; workaround_built?: boolean } | undefined;
      const suggested = p?.depends_on_current_work || p?.workaround_built ? 'halt-fix-resume' : 'board-and-continue';
      return judgment(`bug-found: discriminator suggests ${suggested}`, { ...exit.payload, suggested });
    },
  },
  'phase-overflow': {
    resolution: 'judgment',
    react(_run, exit) {
      // 95% block fired: work is rejected, not salvaged — route to re-decomposition (P7, §14)
      return judgment('phase-overflow: reject the work and re-decompose (P7) — per-agent overflow responses in §14', exit.payload);
    },
  },
  'agent-died': {
    resolution: 'mechanical_then_judgment',
    react(run, exit, caps) {
      const observed = exit.payload?.observed;
      if (observed === 'malformed_exit') {
        return judgment('agent-died: malformed_exit — a broken agent contract, not transient noise; never blind-retried', exit.payload);
      }
      if (observed !== 'crash' && observed !== 'empty_output') {
        return halt(`agent-died: unknown observed discriminator '${String(observed)}' (P5)`);
      }
      const idx = phaseIndex(run, exit);
      if (idx === -1) return halt(`agent-died: no such phase '${exit.phase_id ?? '(current)'}' on run '${run.id}' (P5)`);
      if (priorSignalCount(run, idx, 'agent-died') >= caps.phase_death_cap) {
        return judgment(`agent-died: per-phase death cap (${caps.phase_death_cap}) reached`, exit.payload);
      }
      return {
        action: {
          action: 'spawn',
          phase_id: run.phases[idx].id,
          respawn: true,
          note: 'discard uncommitted work (reset run branch to last phase commit — P7), re-run prep, respawn once',
        },
        nextState: 'running',
      };
    },
  },
} as const satisfies Record<Signal, ReactionEntry>;

/**
 * Compute the reaction. An unknown signal reaching the brain halts the run
 * loudly (P5) — the enum is closed; this is defense-in-depth behind agent_exit's
 * in-band validation.
 */
export function react(run: RunRecord, exit: ResolvedExit, caps: BrainCaps = DEFAULT_CAPS): Reaction {
  const entry = (REACTIONS as Record<string, ReactionEntry>)[exit.signal];
  if (!entry) {
    return halt(`unknown signal '${exit.signal}' reached the brain — the enum is closed (${SIGNALS.join(', ')}); halting loudly (P5)`);
  }
  if (run.machine_state !== 'running') {
    return halt(`signal '${exit.signal}' arrived while run '${run.id}' is '${run.machine_state}' (signals are processed only while running)`);
  }
  return entry.react(run, exit, caps);
}
