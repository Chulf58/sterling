import { z } from 'zod';

// Run-scoped transient shapes (spec §3.2.9) — NOT knowledge-store records.
// The staged pipeline (signals, handoffs, machine states, run records) was
// removed per decision sterling-claude-code-scale-down-boundary (2ad87dd1);
// only the session-event register survives — it backs the knowledge-loop
// events (no_capture, capture_pending, concept_designed, …) below.

// Session-event register shape (run r-0501, interface slice 1). A run-scoped
// append log at .sterling/transient/session-events.json; defined ONCE here
// (invariant 1); written by H16 (research_tool, agent_dispatch),
// debug-scope.mjs (debug_scope), concept-designed.mjs (concept_designed —
// detail carries the concept FAMILY slug; decision foreign_7208729b), and
// no-capture.mjs (no_capture — detail carries the REASON; board 7bbec3bd:
// an explicit declaration that a Stop produced nothing durable, satisfying
// H10's capture duty for every touch/debug_scope event EARLIER than it; work
// arriving after the declaration re-arms the duty. A false declaration is
// drift, not a bypass). Since 2026-08-09 (board 1af5d630/75b1a05f) no_capture,
// concept_designed and the SIXTH kind capture_pending are also writable via
// the MCP tool surface — the scripts stay as the no-server fallback.
// capture_pending: detail carries "<target> — <reason>" (and `target` carries
// the target alone, see the field below), declaring the capture
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
// test_append (board 17204d1e): the ADDITIVE sibling of test_repair — the
// conductor appended a NEW case to a frozen test rather than repairing a
// wrong one; detail carries the test path plus what the new case pins and
// why it is additive. Written by scripts/test-repair.mjs --append. Kept a
// distinct kind so appends and repairs are never conflated in the register.
// READER ASYMMETRY (deliberate, not an oversight): a test_repair event
// discharges H10's per-path capture duty (h10-direct-capture.mjs kind-filters
// 'test_repair' only) — a test_append event does NOT, so the capture duty
// stays armed for an appended case. This is the safe direction (consistent
// with decision no-capture-discharge-is-lane-scoped) and the two kinds are
// NOT siblings for that purpose — do not assume parity when wiring a reader.
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
    'test_append',
  ]),
  detail: z.string().min(1),
  at: z.string().min(1),
  lane: noCaptureLaneSchema.optional(),
  // capture_pending only (board f003082d): the declared target, trimmed, as its
  // own field. H10 keys a lapsed declaration's capture_owed debt on it alone,
  // so one target declared with two reasons is one debt. OPTIONAL because a
  // legacy event carries only the joined detail; H10 keys such an event on the
  // whole detail (never a split on ' — ', which may occur inside a target).
  // Trimmed before the length check, so a whitespace-only target is refused.
  target: z.string().trim().min(1).optional(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;
