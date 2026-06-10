import { z } from 'zod';
import { repoPath } from './paths.js';

// Run-scoped transient shapes (spec §3.2.9) — NOT knowledge-store records.
// They live with the run and are disposed after promotion (P4).

// Signal enum — MVP-spine members only (spec §16.1 item 4). Single source of
// truth: the brain's reaction table (Slice 3) derives from this and the
// totality check fails any member without a reaction + resolution flag.
export const SPINE_SIGNALS = ['complete', 'blocked', 'agent-died'] as const;
export const spineSignal = z.enum(SPINE_SIGNALS);
export type SpineSignal = z.infer<typeof spineSignal>;

export const handoffSchema = z.object({
  phase_id: z.string().min(1),
  agent_role: z.string().min(1),
  what_changed: z.array(z.object({ path: repoPath, change_role: z.string().min(1) })),
  wired: z.array(z.string()),
  deferred: z.array(z.string()),
  decisions_made: z.array(z.string()),
  tests_produced: z.array(repoPath),
  exit_signal: spineSignal,
  unresolved: z.array(z.string()),
});
export type Handoff = z.infer<typeof handoffSchema>;

export const MACHINE_STATES = ['running', 'completing', 'awaiting_merge_gate', 'merged', 'rejected', 'halted'] as const;
export const machineState = z.enum(MACHINE_STATES);
export type MachineState = z.infer<typeof machineState>;

export const runRecordSchema = z.object({
  id: z.string().min(1),
  brief_ref: z.string().uuid(),
  branch: z.string().min(1),
  machine_state: machineState,
  phases: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string(),
      signals: z.array(z.unknown()),
      commits: z.array(z.string()),
    })
  ),
  dispatch_counts: z.record(z.string(), z.number().int().nonnegative()),
  escalations: z.array(z.unknown()),
  started_at: z.string().datetime(),
  // Written once by dispose-run (§3.7, §16.1 Slice 5): only summary facts
  // survive disposal — the packs and check_skipped rows themselves are
  // run-scoped and die with the run. Shown at the merge gate.
  summaries: z
    .object({
      check_skipped: z.array(z.object({ check_name: z.string(), reason: z.string(), count: z.number().int().positive() })),
      knowledge_packs: z.array(
        z.object({
          phase_id: z.string(),
          consumer_role: z.string(),
          returned: z.number().int().nonnegative(),
          cap_omissions: z.number().int().nonnegative(),
          mandatory: z.array(z.object({ record_id: z.string(), reason: z.string() })),
        })
      ),
      snapshot_path: z.string(),
    })
    .optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;
