import { z } from 'zod';

// Pending answers: every answered question form (OpenCode `question`, Claude Code
// `AskUserQuestion`) is appended to .sterling/transient/pending-answers.json until the
// agent resolves it as recorded or not a decision (decision
// answered-question-forms-are-kept-as-pending-answers-in-a-tra). The writers are
// scripts/hooks/lib/pending-answers.mjs; this is the shape they and the MCP tool share.
export const PENDING_ANSWER_OUTCOMES = ['recorded', 'not_a_decision'] as const;

export const pendingAnswerEntrySchema = z
  .object({
    id: z.string().min(1),
    host: z.enum(['opencode', 'claude']),
    session: z.string(),
    time: z.string(),
    call_id: z.string().min(1),
    questions: z.array(
      z
        .object({
          header: z.string(),
          question: z.string(),
          raw_answer: z.string().optional(),
          multiple: z.boolean(),
          options: z.array(z.object({ label: z.string(), description: z.string() }).strict()),
          picks: z.array(z.object({ label: z.string(), custom: z.boolean() }).strict()),
        })
        .strict()
    ),
  })
  .strict();
export type PendingAnswerEntry = z.infer<typeof pendingAnswerEntrySchema>;

export const pendingAnswersFileSchema = z.array(pendingAnswerEntrySchema);

// The resolve input's field shapes, shared by the served tool schema and the enforced schema
// (one definition: the two had diverged on empty ids).
export const pendingAnswersResolveShape = {
  ids: z.array(z.string().trim().min(1)).min(1).describe('Full pending-answer ids exactly as the PENDING ANSWERS notice prints them (32 hex characters, a pending-answer id and not a record uuid); an unknown id refuses the whole call'),
  outcome: z.enum(PENDING_ANSWER_OUTCOMES).describe("'recorded' (a live decision holds the answer; needs record_id) or 'not_a_decision'"),
  record_id: z.string().trim().min(1).optional().describe('For outcome recorded: the live decision that holds the answer, as its slug or id; a missing or non-decision record refuses the whole call'),
};

export const pendingAnswersResolveInputSchema = z
  .object(pendingAnswersResolveShape)
  .strict()
  .refine((v) => v.outcome !== 'recorded' || v.record_id !== undefined, { message: "outcome 'recorded' needs record_id: the decision (slug or id) that holds the answer" });
