import { z } from 'zod';

// Common record envelope (spec §3.2): on every durable record.

// The link-rel registry (invariant 3): the one place a rel is registered, and
// the set linkSchema validates against — store.addLink parses `rel` through
// linkSchema.shape.rel, so a member added here is accepted everywhere and a
// non-member is refused everywhere.
//
// `falsified_by` (board 038feb3e, adopted Codex+conductor joint 2026-08-31):
// marks a record whose CENTRAL CLAIM has been disproven, pointing FROM the
// falsified record TO a durable record carrying the falsifying evidence. It
// exists because supersession cannot express this case: knowledge_supersede
// requires a SURVIVOR to point at, and "this measurement did not reproduce"
// often has no replacement claim to write yet — which is exactly what leaves a
// false record standing unmarked. So the two are complements, not rivals:
// SUPERSESSION still REPLACES a ruling, `falsified_by` marks disproof WITHOUT
// pretending a successor exists. The rejected alternative was extending
// `evidence_basis` with a 'falsified' value — that field answers HOW a claim
// was established, a different axis from WHETHER it still holds, and a record
// can be measured AND falsified.
//
// It is a PLAIN SEMANTIC EDGE, like cites/informed_by/fulfills: it carries no
// lifecycle change (the falsified record stays live and readable — the point is
// that a reader still meets it, now with the contradiction attached), so it
// needs none of the machinery 'supersedes' does, and addLink's raw-edge refusal
// deliberately does not extend to it.
export const LINK_RELS = ['cites', 'informed_by', 'fulfills', 'supersedes', 'falsified_by'] as const;

export const linkSchema = z.object({
  rel: z.enum(LINK_RELS),
  target_id: z.string().uuid(),
});

export const AUTHOR_RE = /^(user|conductor|system|agent:[a-z0-9_-]+)$/;
export const SCOPE_RE = /^(project|domain:[a-z0-9_-]+)$/;

// ---------------------------------------------------------------------------
// Schema v2 identity fields (stable-identity slice S2, decision
// [stable-identity-design-v2]). LIFECYCLE + FRESHNESS are the AUTHORITATIVE
// pair that replaces stored status/superseded_by:
//   lifecycle  'live' | 'retired'          — retired ONLY via the supersede /
//                                            retire paths, both writing a
//                                            record_relations 'supersedes' edge
//   freshness  'fresh' | 'flagged_stale'   — orthogonal, so a stale record can
//                                            still be live
// The SERVED status/superseded_by are DERIVED from them by the store
// (retired → 'superseded'; else flagged_stale → 'flagged_stale'; else
// 'active'; superseded_by = the successor of the inbound supersedes relation
// when retired, else null). status/superseded_by therefore stay on the
// envelope as WRITE-SIDE COMPATIBILITY INPUTS ONLY — every pre-v2 caller and
// fixture keeps working, and the store normalizes them away before the body is
// stored. Keeping them REQUIRED (rather than flipping them optional here) is
// deliberate for this slice: it keeps the DurableRecord type stable for the
// tool/TUI layers that S3 rewires.
// ---------------------------------------------------------------------------
export const LIFECYCLE_VALUES = ['live', 'retired'] as const;
export const FRESHNESS_VALUES = ['fresh', 'flagged_stale'] as const;
export type Lifecycle = (typeof LIFECYCLE_VALUES)[number];
export type Freshness = (typeof FRESHNESS_VALUES)[number];

export const envelopeFields = {
  id: z.string().uuid(),
  type: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  author: z.string().regex(AUTHOR_RE, "author must be user | conductor | system | agent:<role>"),
  status: z.enum(['active', 'superseded']),
  // Separate from status on purpose: an enum conflated with a foreign key queries badly (§3.2).
  superseded_by: z.string().uuid().nullable(),
  // v2 identity trio — server-owned, optional on input (the store assigns them
  // and refuses an out-of-enum value loudly). `version` starts at 1 and is
  // bumped by every in-place write; feature_article narrows it to REQUIRED in
  // its own extend, because its pre-v2 chains author the number explicitly.
  lifecycle: z.enum(LIFECYCLE_VALUES).optional(),
  // freshness KEEPS ITS NAME (decision board-provenance-measured-at-head:
  // renaming is SQL column + envelope + v2-migration churn for zero behavior
  // change) but redocumented here — it tracks whether THIS RECORD was edited
  // (record-edit currency), never whether the world it describes is still
  // true. On a todo it is always 'fresh' (zero information — see digestRecord,
  // which omits it from the todo digest for that reason) and must not be
  // mistaken for the file_keys-changed provenance annotation board_query now
  // carries, which is the one that speaks to world truth.
  freshness: z.enum(FRESHNESS_VALUES).optional(),
  version: z.number().int().positive().optional(),
  links: z.array(linkSchema),
  scope: z.string().regex(SCOPE_RE, 'scope must be project | domain:<name>'),
  stack_tags: z.array(z.string()),
};

/** superseded_by is set iff status is superseded (spec §3.2). */
export function refineSupersession(rec: { status: string; superseded_by: string | null }, ctx: z.RefinementCtx): void {
  if (rec.status === 'superseded' && rec.superseded_by === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "status 'superseded' requires superseded_by" });
  }
  if (rec.status === 'active' && rec.superseded_by !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "status 'active' forbids superseded_by" });
  }
}
