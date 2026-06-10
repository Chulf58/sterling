// The brain (spec §5.2): a deterministic state machine — pure function from
// (run record, exit) to (action, next machine state). Zero LLM, zero tokens.
// The conductor is the hands: it executes exactly the returned action.

import type { MachineState, RunRecord, SpineSignal } from '@sterling/schemas';
import { SPINE_SIGNALS } from '@sterling/schemas';

export interface ResolvedExit {
  signal: string;
  payload?: Record<string, unknown>;
  phase_id?: string;
  agent_role?: string;
}

export type BrainAction =
  | { action: 'spawn'; phase_id: string; respawn: boolean; note?: string }
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
  react(run: RunRecord, exit: ResolvedExit): Reaction;
}

function halt(reason: string): Reaction {
  return { action: { action: 'halt', reason }, nextState: 'halted' };
}

function phaseIndex(run: RunRecord, exit: ResolvedExit): number {
  if (exit.phase_id) return run.phases.findIndex((p) => p.id === exit.phase_id);
  return run.phases.findIndex((p) => p.status === 'in_progress');
}

// §5.1 reaction table, spine members only (§16.1 item 4). `satisfies` makes the
// table compile-time total over the enum; the runtime totality test re-checks it.
export const REACTIONS = {
  complete: {
    resolution: 'mechanical',
    react(run, exit) {
      const idx = phaseIndex(run, exit);
      if (idx === -1) return halt(`complete: no such phase '${exit.phase_id ?? '(current)'}' on run '${run.id}' (P5)`);
      if (idx === run.phases.length - 1) {
        // final phase → run-completion sequence (final completeness → capture → merge gate)
        return { action: { action: 'complete_run' }, nextState: 'completing' };
      }
      return {
        action: { action: 'spawn', phase_id: run.phases[idx + 1].id, respawn: false },
        nextState: 'running',
      };
    },
  },
  blocked: {
    resolution: 'judgment',
    react(_run, exit) {
      return {
        action: { action: 'judgment_needed', reason: 'blocked', payload: exit.payload },
        nextState: 'running',
      };
    },
  },
  'agent-died': {
    resolution: 'mechanical_then_judgment',
    react(run, exit) {
      const observed = exit.payload?.observed;
      if (observed === 'malformed_exit') {
        // a broken agent contract, not transient noise — never blind-retried (§5.1)
        return {
          action: { action: 'judgment_needed', reason: 'agent-died: malformed_exit', payload: exit.payload },
          nextState: 'running',
        };
      }
      if (observed !== 'crash' && observed !== 'empty_output') {
        return halt(`agent-died: unknown observed discriminator '${String(observed)}' (P5)`);
      }
      const idx = phaseIndex(run, exit);
      if (idx === -1) return halt(`agent-died: no such phase '${exit.phase_id ?? '(current)'}' on run '${run.id}' (P5)`);
      const priorDeaths = run.phases[idx].signals.filter(
        (s) => typeof s === 'object' && s !== null && (s as { signal?: string }).signal === 'agent-died'
      ).length;
      if (priorDeaths >= 1) {
        // second death in the same phase → escalate (per-phase death cap, default 1)
        return {
          action: { action: 'judgment_needed', reason: 'agent-died: per-phase death cap reached', payload: exit.payload },
          nextState: 'running',
        };
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
} as const satisfies Record<SpineSignal, ReactionEntry>;

/**
 * Compute the reaction. An unknown signal reaching the brain halts the run
 * loudly (P5) — the enum is closed; this is defense-in-depth behind agent_exit's
 * in-band validation.
 */
export function react(run: RunRecord, exit: ResolvedExit): Reaction {
  const entry = (REACTIONS as Record<string, ReactionEntry>)[exit.signal];
  if (!entry) {
    return halt(`unknown signal '${exit.signal}' reached the brain — the enum is closed (${SPINE_SIGNALS.join(', ')}); halting loudly (P5)`);
  }
  if (run.machine_state !== 'running') {
    return halt(`signal '${exit.signal}' arrived while run '${run.id}' is '${run.machine_state}' (signals are processed only while running)`);
  }
  return entry.react(run, exit);
}
