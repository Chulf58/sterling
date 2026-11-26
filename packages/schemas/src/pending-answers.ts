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

export const pendingAnswersResolveInputSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1),
    outcome: z.enum(PENDING_ANSWER_OUTCOMES),
    record_id: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.outcome !== 'recorded' || v.record_id !== undefined, { message: "outcome 'recorded' needs record_id: the decision (slug or id) that holds the answer" });
