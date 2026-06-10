import { z } from 'zod';

// Common record envelope (spec §3.2): on every durable record.

export const LINK_RELS = ['cites', 'informed_by', 'fulfills', 'supersedes'] as const;

export const linkSchema = z.object({
  rel: z.enum(LINK_RELS),
  target_id: z.string().uuid(),
});

export const AUTHOR_RE = /^(user|conductor|system|agent:[a-z0-9_-]+)$/;
export const SCOPE_RE = /^(project|domain:[a-z0-9_-]+)$/;

export const envelopeFields = {
  id: z.string().uuid(),
  type: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  author: z.string().regex(AUTHOR_RE, "author must be user | conductor | system | agent:<role>"),
  status: z.enum(['active', 'superseded']),
  // Separate from status on purpose: an enum conflated with a foreign key queries badly (§3.2).
  superseded_by: z.string().uuid().nullable(),
  links: z.array(linkSchema),
  scope: z.string().regex(SCOPE_RE, 'scope must be project | domain:<name>'),
  stack_tags: z.array(z.string()),
  // §3.2.6: note-extraction candidates are flagged lower-trust; excluded from
  // retrieval unless the caller opts in. Lives on the envelope because any
  // extractable type (decision, anti-pattern, ...) can carry it.
  derived_unconfirmed: z.boolean().optional(),
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
