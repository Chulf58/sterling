import { z } from 'zod';
import { envelopeFields, refineSupersession } from './envelope.js';
import { normalizeRepoPath, repoPath } from './paths.js';

// Durable record schemas — MVP-spine set (spec §16.1 item 2): decision,
// feature_article, note, todo, brief. Remaining §3.2 types arrive at full-build
// step 2 by adding registry members (the registry + checks already guard them).

// 'final' | 'phase:<n>' — §4 brief AC syntax; §3.2.3 article current_ac uses the
// same value space (article ACs originate from briefs).
export const verifiableAt = z.union([z.literal('final'), z.string().regex(/^phase:\d+$/)]);

const base = z.object(envelopeFields);

// §3.2.1 — immutable; revisiting one creates a new decision that supersedes.
export const decisionSchema = base
  .extend({
    type: z.literal('decision'),
    title: z.string().min(1),
    statement: z.string().min(1),
    alternatives_rejected: z.array(z.object({ option: z.string(), reason: z.string() })),
    rationale: z.string().min(1),
    file_keys: z.array(repoPath).optional(),
  })
  .superRefine(refineSupersession);

// §3.2.3 — versioned body + append-only history.
export const featureArticleSchema = base
  .extend({
    type: z.literal('feature_article'),
    slug: z.string().min(1),
    title: z.string().min(1),
    what_it_does: z.string().min(1),
    intended_behavior: z.string().min(1),
    files: z.array(z.object({ path: repoPath, role: z.string().min(1) })),
    current_ac: z.array(z.object({ ac_id: z.string().min(1), text: z.string().min(1), verifiable_at: verifiableAt })),
    dependencies: z.object({ relies_on: z.array(z.string()), relied_by: z.array(z.string()) }),
    steps_runbook: z.string().optional(),
    state: z.enum(['planned', 'built', 'wired_in', 'active', 'dormant', 'deprecated']),
    state_reason: z.string().optional(),
    wiring_todo_id: z.string().uuid().optional(),
    known_gaps: z
      .array(
        z.object({
          site: z.string().min(1),
          kind: z.enum(['mutation_survivor', 'other']),
          evidence: z.string().min(1),
          recorded_run: z.string().min(1),
        })
      )
      .optional(),
    version: z.number().int().positive(),
    history: z.array(z.object({ date: z.string().datetime(), event: z.string().min(1), target_id: z.string().uuid().optional() })),
    live_test_refs: z.array(z.object({ ac_id: z.string().min(1), test_paths: z.array(repoPath) })),
  })
  .superRefine((rec, ctx) => {
    refineSupersession(rec, ctx);
    if (rec.state === 'dormant' && (!rec.state_reason || !rec.wiring_todo_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "state 'dormant' requires state_reason and wiring_todo_id (§3.2.3)" });
    }
  });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'ISO date required');

// §3.2.2 — trigger and provenance are top-level, never buried in prose.
export const antiPatternSchema = base
  .extend({
    type: z.literal('anti_pattern'),
    title: z.string().min(1),
    trigger: z.string().min(1),
    guidance: z.string().min(1),
    wrong_way: z.string().min(1),
    right_way: z.string().min(1),
    source_evidence: z.string().min(1),
    file_keys: z.array(repoPath).optional(),
    severity: z.enum(['info', 'warn', 'block']).optional(),
    basis: z.enum(['codebase', 'platform', 'external']).default('codebase'),
  })
  .superRefine(refineSupersession);

// §3.2.4 — the decaying type: two clocks, freshness computed at read (lazy).
// Status adds flagged_stale; retrieval serves it only as "stale — re-verify".
export const researchFindingSchema = base
  .extend({
    type: z.literal('research_finding'),
    status: z.enum(['active', 'superseded', 'flagged_stale']),
    question: z.string().min(1),
    answer: z.string().min(1),
    source_urls: z.array(z.string()),
    source_date: isoDate,
    capture_date: isoDate,
    volatility_hint: z.enum(['fast', 'medium', 'stable']).optional(),
  })
  .superRefine(refineSupersession);

// §3.2.5 — large, stable, loaded on demand; never bulk-injected.
export const referenceMaterialSchema = base
  .extend({
    type: z.literal('reference_material'),
    title: z.string().min(1),
    kind: z.enum(['pdf', 'url', 'doc']),
    location: z.string().min(1),
    summary: z.string().min(1),
    source_date: isoDate,
    capture_date: isoDate,
    basis: z.enum(['codebase', 'platform', 'external']).default('codebase'),
  })
  .superRefine(refineSupersession);

// §3.2.8 — refuted trails live here instead of dying; debug runs must not
// re-litigate false trails already disproved.
export const disconfirmedHypothesisSchema = base
  .extend({
    type: z.literal('disconfirmed_hypothesis'),
    question: z.string().min(1),
    rejected_answer: z.string().min(1),
    evidence: z.string().min(1),
    file_keys: z.array(repoPath).optional(),
  })
  .superRefine(refineSupersession);

// §3.2.6 — raw text immutable; extraction re-runnable.
export const noteSchema = base
  .extend({
    type: z.literal('note'),
    raw_text: z.string().min(1),
    captured_at: z.string().datetime(),
    capture_source: z.enum(['tui', 'command', 'conductor']),
    derived: z.array(z.string().uuid()),
  })
  .superRefine(refineSupersession);

export const SYSTEM_REASONS = [
  'reconcile_needed',
  'stale_research',
  'deletion_candidate',
  'capture_owed',
  'promotion_review',
  'wire_in_dormant',
  'refresh_reference', // §3.2.5: repo-located doc changed out-of-band; refresh summary + source_date
  'article_missing', // §6 H10: direct-mode work in unowned territory ended without its owning article
] as const;

// §3.2.7 — the board and the maintenance queue. There is no 'done' status:
// done = removed by the artifact-writing event (P4).
export const todoSchema = base
  .extend({
    type: z.literal('todo'),
    text: z.string().min(1),
    source: z.enum(['user', 'system']),
    file_keys: z.array(repoPath).optional(),
    feature_link: z.string().uuid().optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    system_reason: z.enum(SYSTEM_REASONS).optional(),
  })
  .superRefine((rec, ctx) => {
    refineSupersession(rec, ctx);
    if (rec.source === 'system' && !rec.system_reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "source 'system' requires system_reason (§3.2.7)" });
    }
  });

// §4 — the brief-as-contract; the single authoritative copy lives in the store.
export const briefSchema = base
  .extend({
    type: z.literal('brief'),
    slug: z.string().min(1),
    title: z.string().min(1),
    problem: z.string().min(1),
    feature: z.string().min(1),
    user_stated: z.object({
      criteria: z.array(z.string()),
      constraints: z.array(z.string()),
    }),
    conductor_proposals: z.array(z.object({ text: z.string().min(1), status: z.enum(['confirmed', 'unconfirmed']) })),
    acceptance_criteria: z.array(z.object({ ac_id: z.string().min(1), text: z.string().min(1), verifiable_at: verifiableAt })),
    technical_design: z.object({
      approach: z.string(),
      interfaces: z.array(z.object({ name: z.string(), contract: z.string() })),
      shared_structures: z.array(z.string()),
    }),
    // §7.1/§7.6: proposed at planning, human-confirmed at the gate, frozen into
    // data before the run — reviewer-selection's first signal source.
    risk_flags: z.array(z.enum(['security_relevant', 'perf_sensitive'])).optional(),
    blast_radius: z.object({
      files: z.array(z.object({ path: repoPath, owning_articles: z.array(z.string().uuid()) })),
      reconcile_list: z.array(z.string().uuid()),
    }),
    incidental_scope: z.array(repoPath),
    out_of_scope: z.array(z.string()),
    phases: z.array(
      z.object({
        phase_id: z.string().min(1),
        goal: z.string().min(1),
        subtasks: z.array(z.string()),
        ac_ids: z.array(z.string()),
        difficulty: z.object({ level: z.enum(['normal', 'hard']), reasons: z.array(z.string()) }),
        model_hint: z.string(),
        // prep's staging inputs are planning outputs (§7.1/§7.6): the phase
        // declares its file list + rank_terms. Optional pending §4 alignment
        // (raised as a spec gap); prep falls back to blast_radius files.
        files: z.array(repoPath).optional(),
        rank_terms: z.array(z.string().regex(/^\S{1,64}$/)).optional(),
        // §8.1: the phase's interface slice (names into technical_design.
        // interfaces) — the test-writer's REQUIRED input; a phase without
        // declared interfaces gives it nothing to write against (spawn check).
        interfaces: z.array(z.string().min(1)).optional(),
      })
    ),
    decisions_made: z.array(z.string().uuid()),
  })
  .superRefine((rec, ctx) => {
    refineSupersession(rec, ctx);
    // a phase's interface slice must reference declared design interfaces —
    // a dangling name would hand the test-writer a contract that doesn't exist
    const declared = new Set(rec.technical_design.interfaces.map((i) => i.name));
    for (const phase of rec.phases) {
      for (const name of phase.interfaces ?? []) {
        if (!declared.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `phase '${phase.phase_id}' references undeclared interface '${name}' (§8.1 interface slice must come from technical_design.interfaces)`,
          });
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// Record-type registry (invariant 3, spec §15): the single source of truth for
// durable types. The store consults it on every write — an unregistered type
// is rejected loudly. fts/fileKeys extractors keep the store generic; rank
// indexes title + body-equivalents per type (§3.4).
// ---------------------------------------------------------------------------

export interface RecordTypeEntry {
  schema: z.ZodTypeAny;
  /** decision records are immutable (§3.2.1): supersession is the only change path */
  immutable: boolean;
  fts: (record: Record<string, unknown>) => string;
  fileKeys: (record: Record<string, unknown>) => string[];
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export const RECORD_TYPES: Record<string, RecordTypeEntry> = {
  decision: {
    schema: decisionSchema,
    immutable: true,
    fts: (r) => [s(r.title), s(r.statement), s(r.rationale)].join('\n'),
    fileKeys: (r) => (r.file_keys as string[] | undefined) ?? [],
  },
  anti_pattern: {
    schema: antiPatternSchema,
    immutable: false,
    fts: (r) => [s(r.title), s(r.trigger), s(r.guidance), s(r.wrong_way), s(r.right_way)].join('\n'),
    fileKeys: (r) => (r.file_keys as string[] | undefined) ?? [],
  },
  research_finding: {
    schema: researchFindingSchema,
    immutable: false,
    fts: (r) => [s(r.question), s(r.answer)].join('\n'),
    fileKeys: () => [],
  },
  reference_material: {
    schema: referenceMaterialSchema,
    immutable: false,
    fts: (r) => [s(r.title), s(r.summary)].join('\n'),
    // §3.2.5: repo-located docs join the reconcile economy — for kind:doc a
    // repo-relative location doubles as a file_key (H7 pressure applies);
    // pdf/url locations are external and carry none.
    fileKeys: (r) => {
      if (r.kind !== 'doc') return [];
      try {
        return [normalizeRepoPath(r.location as string)];
      } catch {
        return []; // absolute/escaping location: not repo-located
      }
    },
  },
  disconfirmed_hypothesis: {
    schema: disconfirmedHypothesisSchema,
    immutable: false,
    fts: (r) => [s(r.question), s(r.rejected_answer), s(r.evidence)].join('\n'),
    fileKeys: (r) => (r.file_keys as string[] | undefined) ?? [],
  },
  feature_article: {
    schema: featureArticleSchema,
    immutable: false,
    fts: (r) => [s(r.slug), s(r.title), s(r.what_it_does), s(r.intended_behavior), s(r.steps_runbook)].join('\n'),
    fileKeys: (r) => ((r.files as { path: string }[] | undefined) ?? []).map((f) => f.path),
  },
  note: {
    schema: noteSchema,
    immutable: false,
    fts: (r) => s(r.raw_text),
    fileKeys: () => [],
  },
  todo: {
    schema: todoSchema,
    immutable: false,
    fts: (r) => s(r.text),
    fileKeys: (r) => (r.file_keys as string[] | undefined) ?? [],
  },
  brief: {
    schema: briefSchema,
    immutable: false,
    fts: (r) => [s(r.slug), s(r.title), s(r.problem), s(r.feature)].join('\n'),
    fileKeys: (r) => {
      const br = r.blast_radius as { files?: { path: string }[] } | undefined;
      return (br?.files ?? []).map((f) => f.path);
    },
  },
};

export type RecordType = keyof typeof RECORD_TYPES;

export type DurableRecord =
  | z.infer<typeof decisionSchema>
  | z.infer<typeof antiPatternSchema>
  | z.infer<typeof researchFindingSchema>
  | z.infer<typeof referenceMaterialSchema>
  | z.infer<typeof disconfirmedHypothesisSchema>
  | z.infer<typeof featureArticleSchema>
  | z.infer<typeof noteSchema>
  | z.infer<typeof todoSchema>
  | z.infer<typeof briefSchema>;

/** The one validation gate for durable writes: unregistered type = loud rejection. */
export function validateRecord(input: unknown): DurableRecord {
  if (typeof input !== 'object' || input === null || typeof (input as { type?: unknown }).type !== 'string') {
    throw new Error('validateRecord: input has no record type');
  }
  const type = (input as { type: string }).type;
  const entry = RECORD_TYPES[type];
  if (!entry) {
    throw new Error(`validateRecord: unregistered record type '${type}' — register it in RECORD_TYPES (spec §15) before writing`);
  }
  return entry.schema.parse(input) as DurableRecord;
}
