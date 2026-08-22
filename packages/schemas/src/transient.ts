import { z } from 'zod';
import { repoPath } from './paths.js';

// Run-scoped transient shapes (spec §3.2.9) — NOT knowledge-store records.
// They live with the run and are disposed after promotion (P4).

// The signal enum (spec §5.1 — CLOSED, totality-checked). Single source of
// truth: the brain's reaction table derives from this; the totality check
// fails any member without a reaction + resolution flag. Emitting anything
// else is a validation error; an unknown signal reaching the brain halts the
// run loudly (P5).
export const SIGNALS = [
  'complete',
  'research-needed',
  'review-unresolved',
  'blocked',
  'tests-invalid',
  'contract-violated',
  'bug-found',
  'phase-overflow',
  'agent-died',
] as const;
export const signalSchema = z.enum(SIGNALS);
export type Signal = z.infer<typeof signalSchema>;

// Typed payloads per signal (§5.1 payload column). agent_exit validates the
// emitting agent's payload in-band; agent-died is conductor-reported, never
// agent-emitted.
export const SIGNAL_PAYLOADS: Record<Signal, z.ZodTypeAny> = {
  complete: z.object({ handoff_ref: z.string().min(1) }),
  'research-needed': z.object({ question: z.string().min(1), context: z.string(), blocking: z.boolean() }),
  'review-unresolved': z.object({
    objections: z.array(z.unknown()),
    reviewer_agreement: z.enum(['agreed_broken', 'disagreed']),
  }),
  blocked: z.object({ reason: z.string().min(1) }),
  'tests-invalid': z.object({ evidence: z.string().min(1) }),
  'contract-violated': z.object({ path: repoPath, rule: z.string().min(1) }),
  'bug-found': z.object({
    description: z.string().min(1),
    location: z.string().min(1),
    depends_on_current_work: z.boolean(),
    workaround_built: z.boolean(),
  }),
  'phase-overflow': z.object({ agent: z.string().min(1), fill_pct: z.number() }),
  'agent-died': z.object({
    agent: z.string().min(1),
    phase_id: z.string().optional(),
    observed: z.enum(['crash', 'empty_output', 'malformed_exit']),
    raw_excerpt: z.string(),
  }),
};

// Backward-compatible aliases for the spine vocabulary (same enum object —
// one definition; the spine names remain in commit history and tests).
export const SPINE_SIGNALS = SIGNALS;
export const spineSignal = signalSchema;
export type SpineSignal = Signal;

// Disposition item (reviewer-knowledge-loop v2, run r-d630, phase 1 — AC1).
// handoffSchema.dispositions[]: reviewer declares per-mandatory-id outcome.
// 'not_applicable_because' requires a non-empty reason (zod refine);
// 'addressed' reason is optional. Defined ONCE here (invariant 1); the
// coverage check (role-conditional set-equality) lives in tools.ts phase 2.
const dispositionItemSchema = z
  .object({
    record_id: z.string().min(1),
    disposition: z.enum(['addressed', 'not_applicable_because']),
    reason: z.string().optional(),
  })
  .superRefine((item, ctx) => {
    if (item.disposition === 'not_applicable_because' && (!item.reason || item.reason.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "disposition 'not_applicable_because' requires a non-empty reason",
      });
    }
  });

export const handoffSchema = z.object({
  phase_id: z.string().min(1),
  agent_role: z.string().min(1),
  what_changed: z.array(z.object({ path: repoPath, change_role: z.string().min(1) })),
  wired: z.array(z.string()),
  deferred: z.array(z.string()),
  decisions_made: z.array(z.string()),
  tests_produced: z.array(repoPath),
  // §17 completeness decision order, structure-first half: per-subtask
  // evidence citations (subtask → diff files + tests). The completeness
  // script verifies cited evidence exists and passes; the honesty classifier
  // is deferred until real runs show dishonest citations slipping by.
  subtask_evidence: z
    .array(z.object({ subtask: z.string().min(1), files: z.array(repoPath), tests: z.array(repoPath) }))
    .optional(),
  // Reviewer disposition of per-phase mandatory items (AC1, run r-d630, phase 1).
  // Optional — non-reviewer handoffs omit it; legacy handoffs round-trip unchanged.
  dispositions: z.array(dispositionItemSchema).optional(),
  exit_signal: signalSchema,
  unresolved: z.array(z.string()),
});
export type Handoff = z.infer<typeof handoffSchema>;

export const MACHINE_STATES = ['running', 'completing', 'awaiting_merge_gate', 'merged', 'rejected', 'halted'] as const;
export const machineState = z.enum(MACHINE_STATES);
export type MachineState = z.infer<typeof machineState>;

// Session-event register shape (run r-0501, interface slice 1). A run-scoped
// append log at .sterling/transient/session-events.json; defined ONCE here
// (invariant 1); written by H16 (research_tool, agent_dispatch),
// debug-scope.mjs (debug_scope), concept-designed.mjs (concept_designed —
// detail carries the concept FAMILY slug; decision 7208729b), and
// no-capture.mjs (no_capture — detail carries the REASON; board 7bbec3bd:
// an explicit declaration that a Stop produced nothing durable, satisfying
// H10's capture duty for every touch/debug_scope event EARLIER than it; work
// arriving after the declaration re-arms the duty. A false declaration is
// drift, not a bypass). Since 2026-08-09 (board 1af5d630/75b1a05f) no_capture,
// concept_designed and the SIXTH kind capture_pending are also writable via
// the MCP tool surface — the scripts stay as the no-server fallback.
// capture_pending: detail carries "<target> — <reason>", declaring the capture
// EXISTS and its write is in flight on a named commit/agent/lane; H10 defers
// the capture duty one Stop (registers preserved, so a landed write settles
// cleanly) and converts a still-pending duty to ONE deduped capture_owed item
// on the next — pending work defers or lands on the queue, never evaporates.
// test_repair (decision frozen-test-repair-signatures-plus-visible-repair,
// 7a4c3fb6-dc23-4c2f-9369-d2592132f408; board a06e4a1c): the VISIBLE-REPAIR
// half — the conductor stays sanctioned to hand-repair a demonstrably buggy
// frozen test (H5 rides coder/debugger frontmatter only), but the repair
// must stop being invisible. detail carries the repaired repo-relative test
// path plus the evidence for why the TEST, not the code, was wrong; written
// by scripts/test-repair.mjs (a CLI, not a hook — mirrors no-capture.mjs's
// append shape). Never a durable store record.
//
// LANE (decision no-capture-discharge-is-lane-scoped,
// 51ebe0dd-099e-40a9-abc5-d3c8cc767883; USER-RULED 2026-08-22): a no_capture
// declaration is scoped to the duty lane it actually claims. OPTIONAL because a
// BARE declaration is the pre-ruling behavior — it covers the CAPTURE lane only
// — and because every no_capture event written BEFORE this field existed must
// read the same way: field-absent means 'capture', NEVER 'all'. A legacy event
// cannot silently gain research-clearing power it never had, since a locally
// true "typo fix, nothing durable" would then silently discharge an unrelated
// earlier research duty (P5 fail-loud / P2 the KB is the product: silent
// knowledge loss is the severe direction). Both producers — scripts/no-capture.mjs
// (--lane) and the no_capture MCP tool — refuse an unrecognized value LOUDLY,
// naming this set, rather than coercing it to a lane the human did not claim.
export const NO_CAPTURE_LANES = ['research', 'capture', 'all'] as const;
export const noCaptureLaneSchema = z.enum(NO_CAPTURE_LANES);
export type NoCaptureLane = z.infer<typeof noCaptureLaneSchema>;

export const sessionEventSchema = z.object({
  kind: z.enum([
    'research_tool',
    'agent_dispatch',
    'debug_scope',
    'concept_designed',
    'no_capture',
    'capture_pending',
    'test_repair',
  ]),
  detail: z.string().min(1),
  at: z.string().min(1),
  lane: noCaptureLaneSchema.optional(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

// Shared mandatory tuple (decision 628c4b7f, run r-d630, phase 1 — AC1).
// Defined ONCE here (invariant 1); reused by runRecordSchema.review_mandatory
// and (phase 2+) summaries.undispositioned_mandatory.
export const reviewMandatoryItemSchema = z.object({
  phase_id: z.string().min(1),
  record_id: z.string().min(1),
  reason: z.string().min(1),
});

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
  // H7 (§6): articles whose files were touched mid-run — reconciliation due at
  // completion; dispose-run verifies the union of this and the brief's list.
  reconcile_needed: z.array(z.string()).optional(),
  // Mid-run scope amendment (brief mid-run-scope-amendment, decision 8e6f9491):
  // the conductor's human-gated "amend and continue" on a blast-radius omission.
  // Exact repo-relative paths only; run-scoped, dies with the run (P4). scopeCheck
  // unions these into the allowed set AFTER the out_of_scope loop, so an amendment
  // can never open an out_of_scope path.
  scope_amendments: z.array(z.object({ path: repoPath, reason: z.string().min(1), at: z.string().min(1) })).optional(),
  // Per-phase reviewer mandatory set (decision 628c4b7f, run r-d630, phase 1 — AC1):
  // stamped by prep via setRunReviewMandatory; readable at handoffWrite (phase 2),
  // dispose-run, and merge-gate. Replace-by-phase — see SterlingStore.setRunReviewMandatory.
  // Optional; legacy runs round-trip unchanged.
  review_mandatory: z.array(reviewMandatoryItemSchema).optional(),
  // §8.1 branch model: the branch the run started from — the merge gate's
  // target; recorded by the branch manager at run-branch creation.
  base_branch: z.string().optional(),
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
      // Disposal backstop (decision 628c4b7f (c)): the per-phase reviewer
      // mandatory ids left undispositioned across the run's reviewer handoffs,
      // folded in by dispose-run BEFORE transients are deleted (P4) and printed
      // at the merge gate (P5) — the wire can be fooled, the gate cannot. Reuses
      // the shared mandatory tuple (invariant 1). Optional so legacy summaries
      // round-trip unchanged.
      undispositioned_mandatory: z.array(reviewMandatoryItemSchema).optional(),
      // Per-agent CONTEXT-FILL fold (board 6b2dd7b0, decision 378e09ed #5):
      // peak/median fill_pct per agent_type from the run's h6-fills.jsonl,
      // folded by dispose-run BEFORE runs/<id>/ is deleted — the only per-agent
      // telemetry a run produces was previously deleted unread at the exact
      // moment this summary was assembled (a standing P4 violation). The values
      // are fractions of the model WINDOW, deliberately not tokens or dollars
      // (true token totals need subagent-transcript usage reads — a separate,
      // probe-first slice; the transcript path has moved once already).
      // Optional so legacy summaries round-trip unchanged.
      agent_fill: z
        .array(
          z.object({
            agent_type: z.string(),
            samples: z.number().int().positive(),
            peak_fill_pct: z.number(),
            median_fill_pct: z.number(),
          })
        )
        .optional(),
      snapshot_path: z.string(),
    })
    .optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;
