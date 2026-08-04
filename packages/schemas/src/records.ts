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
    // `unverified` marks a files[] entry whose ROLE has not yet been written from
    // the actual source — an honest "I do not know this yet" (board db7cd16c).
    // A consuming project had been expressing exactly this in prose ("⚠⚠ ROLE NOT
    // YET WRITTEN FROM THE FILE"), which is the right instinct and the wrong
    // mechanism: a marker buried in a role string only helps if somebody reads it,
    // while a flag is QUERYABLE and the read-time state check can surface it. Set
    // it when creating an article ahead of the code; clear it by rewriting the
    // role from the file.
    files: z.array(z.object({ path: repoPath, role: z.string().min(1), unverified: z.boolean().optional() })),
    // §3.2.3 drift baseline (path → sha256 of the owned file's bytes), computed
    // SERVER-SIDE at create/reconcile — never author-supplied. The read-time
    // drift check confirms a content change against this before flagging, so a
    // git merge/checkout that only resets mtimes no longer raises false
    // reconcile_needed items (decision 65222971 → its baseline successor).
    file_baselines: z.record(z.string(), z.string()).optional(),
    current_ac: z.array(z.object({ ac_id: z.string().min(1), text: z.string().min(1), verifiable_at: verifiableAt })),
    // Concept-article marker (domain decision 7208729b, concept-article-layer
    // standard): set ONLY on concept articles — one per recurring domain concept
    // FAMILY (items, weapons, …). Enables class/family enumeration without
    // overloading stack_tags (the domain-mount manifest) and lets prep reserve
    // the concept slice. Optional — owning articles and legacy records omit it.
    concept_family: z.string().min(1).optional(),
    // Detached-working-tree resolution (comsoft-juiced incident 2026-07-17):
    // the SYMBOLIC name of the working tree this record's file paths resolve
    // against — a key into config.working_trees (name → tree path). Unset =
    // the project root. Machine-specific paths live in config, never in the
    // record (invariant 2); consumers (read-time drift, baselines, H7/H10
    // ownership) resolve per record or abstain LOUD on an unmapped name.
    working_tree: z.string().min(1).optional(),
    // relies_on/relied_by name other articles by SLUG — slugs survive version
    // supersession, record ids do not (decision 474b1c71).
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

// §3.2.5 models catalog: typed shape for KB-maintained model lists (run r-ea9e, AC7).
// Free strings at schema level (tier/status enums and id-regex are phase-2/4 territory
// per decision 98064d77 — do NOT add enum/regex constraints here).
export const modelsCatalogSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      tier: z.string(),
      status: z.string(),
    })
  ),
});

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
    // §3.2.5 drift baseline for a repo-located kind:doc (normalized location →
    // sha256 of its bytes), computed server-side at create/refresh. Same role as
    // feature_article.file_baselines: the read-time check confirms a real content
    // change before raising refresh_reference, so an mtime-only bump (a merge) is
    // not mistaken for an out-of-band edit. url/pdf locations carry none.
    file_baselines: z.record(z.string(), z.string()).optional(),
    // run r-ea9e, AC7: optional typed catalog field — legacy records round-trip
    // unchanged (field_baselines optional-field precedent); a catalog-bearing record
    // carries a validated modelsCatalogSchema payload.
    catalog: modelsCatalogSchema.optional(),
    // Detached-working-tree resolution for a repo-located kind:doc — same
    // semantics as featureArticleSchema.working_tree (comsoft-juiced 2026-07-17).
    working_tree: z.string().min(1).optional(),
  })
  .superRefine(refineSupersession)
  // §3.2 path invariant at the boundary: a kind:doc location doubles as a
  // file_key, so normalize it in the BODY too (audit finding 12/43) — otherwise a
  // 'docs\spec.md' / './docs/spec.md' body diverges from the normalized index key
  // and renameFileKey's exact-match rewrite misses it. Mirrors the fileKeys
  // extractor: only kind:doc, and an absolute/escaping location keeps its raw
  // value (pdf/url/external docs are never repo-relative).
  .transform((rec) => {
    if (rec.kind !== 'doc') return rec;
    try {
      return { ...rec, location: normalizeRepoPath(rec.location) };
    } catch {
      return rec;
    }
  });

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
  'research_owed', // §6 H16: conductor has research_owed work pending (session-event register, run r-0501)
  'concept_article_missing', // §6 H10: a concept_designed session event ended the session without its concept article (decision 7208729b)
  // An owned file is absent from the working tree but ALIVE on another git ref
  // — parked on an unmerged branch, not deleted. INFORMATIONAL: it demands no
  // reconcile, because no write can change the fact and the article is already
  // correct (the path becomes valid again on merge). It exists so the absence
  // arm stops minting an unclosable reconcile_needed that re-fires on every
  // read, and so the drain has somewhere honest to put the finding.
  'file_parked',
  // An article's METADATA contradicts reality: it claims `planned` while the code
  // it owns is demonstrably written, or it carries files[] roles still marked
  // unverified. Nothing watched the state field before — the hooks watch content
  // hashes — so an article sat at `planned` over a shipped, wired, probe-verified
  // feature, and anyone querying it would have concluded the feature did not
  // exist. The PROSE was right; the metadata was the lie, and metadata is what a
  // reader trusts first.
  'state_review',
] as const;

// §11 queue drain verbs: draining means the fulfilling artifact was written,
// so the reason implies the deed. `satisfies` keeps this total — a new
// maintenance lane cannot ship without its completed-section verb.
export const DRAIN_VERBS = {
  reconcile_needed: 'updated',
  stale_research: 're-verified',
  deletion_candidate: 'deleted',
  capture_owed: 'captured',
  promotion_review: 'reviewed',
  wire_in_dormant: 'wired',
  refresh_reference: 'refreshed',
  article_missing: 'created',
  research_owed: 'captured',
  concept_article_missing: 'created',
  // 'merged', not 'updated': the item closes when the branch holding the file
  // lands, which is an event rather than a write. Naming it after a write would
  // invite exactly the no-op version bump the closing rule forbids.
  file_parked: 'merged',
  // The deed is fixing the metadata to match the code (or confirming it already
  // does) — not reconciling the prose, which may well be correct already.
  state_review: 'corrected',
} as const satisfies Record<(typeof SYSTEM_REASONS)[number], string>;

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
// AGENT_MODEL_KEY — run r-ea9e, AC7 (TUI System tab).
// Plain record: every registered agent name (agent-templates/registry.json)
// → the config.models key that governs its model+effort. Totality-tested in
// schemas.test.ts; coder_hard/classifiers are config-only keys (no installed
// agent) and are NOT map keys.
// ---------------------------------------------------------------------------
export const AGENT_MODEL_KEY = {
  'test-writer': 'test_writer',
  coder: 'coder',
  'reviewer-correctness': 'reviewers',
  'reviewer-security': 'reviewers',
  'reviewer-skeptic': 'reviewers',
  'reviewer-performance': 'reviewers',
  'implementation-architect': 'implementation_architect',
  researcher: 'researcher',
  explorer: 'explorer',
  librarian: 'librarian',
  debugger: 'debugger',
} as Record<string, string>;

// REVIEWER_ROLES (decision 628c4b7f, run r-d630, phase 1 — AC1): derived from
// AGENT_MODEL_KEY — exactly the keys that map to 'reviewers'. Single source of
// truth; a hardcoded list was explicitly rejected (second source of truth would
// drift from the roster). Totality-tested in schemas.test.ts vs registry.json.
export const REVIEWER_ROLES: Set<string> = new Set(
  Object.keys(AGENT_MODEL_KEY).filter((k) => AGENT_MODEL_KEY[k] === 'reviewers')
);

// ---------------------------------------------------------------------------
// AGENT_CLASS — the roster holds TWO agent classes and the distinction is
// LOAD-BEARING, not documentation (council wf_0d90ab18-436, black/green):
//   'pipeline'         — dispatched inside a run; carries handoff_write/agent_exit;
//                        slice-guarded and cap-counted by H8.
//   'conductor_direct' — dispatched outside a run by the conductor; holds NO
//                        agent_exit/handoff_write (both are run-scoped and refused
//                        with `no active run`), so it reports its signal as the
//                        first line of its final text.
// Mirrors the `class` field in agent-templates/registry.json; totality-tested
// against it in schemas.test.ts exactly as AGENT_MODEL_KEY is. Deriving H8's
// guarded set from AGENT_MODEL_KEY's KEYS was the defect this replaces: adding a
// conductor-direct agent silently enrolled it in pipeline slice-guarding and
// cap-counting, so a mid-run dispatch was denied for lacking a knowledge slice it
// was never meant to carry.
// ---------------------------------------------------------------------------
export const AGENT_CLASS = {
  'test-writer': 'pipeline',
  coder: 'pipeline',
  'reviewer-correctness': 'pipeline',
  'reviewer-security': 'pipeline',
  'reviewer-skeptic': 'pipeline',
  'reviewer-performance': 'pipeline',
  'implementation-architect': 'pipeline',
  researcher: 'pipeline',
  explorer: 'pipeline',
  librarian: 'conductor_direct',
  debugger: 'conductor_direct',
} as Record<string, string>;

// The set H8 slice-guards and cap-counts: pipeline agents ONLY.
export const PIPELINE_AGENT_TYPES: Set<string> = new Set(
  Object.keys(AGENT_CLASS).filter((k) => AGENT_CLASS[k] === 'pipeline')
);

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
  /**
   * The type's HEADLINE fields — what identifies a record when the caller wants
   * the landscape rather than the bodies (knowledge_query projection:'digest').
   * Field name → whether it is emitted whole or clipped to DIGEST_CLIP.
   *
   * Unlike knownFieldsFor this CANNOT be derived from the schema: WHICH field is
   * the headline is an editorial judgement (anti_pattern leads with `trigger`,
   * research_finding with its two clocks), and no shape encodes that. So it is a
   * hand-maintained list of field names — the exact thing decision 44e45931
   * warns about — and it is DECLARATIVE rather than a closure for that reason:
   * a map of names can be checked against knownFieldsFor(type), so renaming a
   * schema field fails the registry test loudly instead of silently emptying
   * the digest. A closure reading r.trigger would just stop finding anything
   * (invariant 3: the registry's consistency check exists before its members).
   */
  digest: Record<string, 'plain' | 'clip'>;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Headline clip (projection:'digest'). Long enough for an anti_pattern trigger
 * to be actionable without opening the record, short enough that a 100-record
 * digest stays an order of magnitude under one full-body window.
 */
export const DIGEST_CLIP = 160;

const clipped = (v: unknown, n: number = DIGEST_CLIP): string | undefined => {
  const text = s(v).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length <= n ? text : `${text.slice(0, n)}…`;
};

export const RECORD_TYPES: Record<string, RecordTypeEntry> = {
  decision: {
    schema: decisionSchema,
    immutable: true,
    fts: (r) => [s(r.title), s(r.statement), s(r.rationale)].join('\n'),
    fileKeys: (r) => (r.file_keys as string[] | undefined) ?? [],
    // Title only, as asked: a decision's title is written to state the ruling.
    digest: { title: 'plain' },
  },
  anti_pattern: {
    schema: antiPatternSchema,
    immutable: false,
    fts: (r) => [s(r.title), s(r.trigger), s(r.guidance), s(r.wrong_way), s(r.right_way)].join('\n'),
    fileKeys: (r) => (r.file_keys as string[] | undefined) ?? [],
    // trigger is the field that tells a reader whether the hazard applies to
    // what they are about to do — the whole point of scanning hazards — and
    // severity is the order H19 already renders them in.
    digest: { title: 'plain', trigger: 'clip', severity: 'plain' },
  },
  research_finding: {
    schema: researchFindingSchema,
    immutable: false,
    fts: (r) => [s(r.question), s(r.answer)].join('\n'),
    fileKeys: () => [],
    // No title on this type — the question IS the identity. Both clocks ride
    // along because a finding's currency decides whether it may be used at all.
    digest: { question: 'clip', source_date: 'plain', capture_date: 'plain' },
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
    // location is this type's path-bearing field (§3.2.5), so it is what a
    // reader needs to go open the thing.
    digest: { title: 'plain', kind: 'plain', location: 'plain' },
  },
  disconfirmed_hypothesis: {
    schema: disconfirmedHypothesisSchema,
    immutable: false,
    fts: (r) => [s(r.question), s(r.rejected_answer), s(r.evidence)].join('\n'),
    fileKeys: (r) => (r.file_keys as string[] | undefined) ?? [],
    // The rejected answer is the reusable half — it stops the question being
    // re-asked and re-answered the same wrong way.
    digest: { question: 'clip', rejected_answer: 'clip' },
  },
  feature_article: {
    schema: featureArticleSchema,
    immutable: false,
    // concept_family joins the FTS text so a family query ranks its concept
    // article (class enumeration stays a consumer-side filter on the field).
    fts: (r) => [s(r.slug), s(r.title), s(r.concept_family), s(r.what_it_does), s(r.intended_behavior), s(r.steps_runbook)].join('\n'),
    fileKeys: (r) => ((r.files as { path: string }[] | undefined) ?? []).map((f) => f.path),
    // slug leads: it is the STABLE handle across versions (decision 474b1c71),
    // and the id in the envelope beside it is not. version + state say whether
    // this is a moving target and whether it is wired yet.
    digest: { slug: 'plain', title: 'plain', state: 'plain', version: 'plain', concept_family: 'plain' },
  },
  note: {
    schema: noteSchema,
    immutable: false,
    fts: (r) => s(r.raw_text),
    fileKeys: () => [],
    digest: { raw_text: 'clip' },
  },
  todo: {
    schema: todoSchema,
    immutable: false,
    fts: (r) => s(r.text),
    fileKeys: (r) => (r.file_keys as string[] | undefined) ?? [],
    // The measured worst case for full bodies: board items run to ~8 KB each,
    // so a whole-board read spilled 478 KB. system_reason is what sorts the
    // maintenance queue into lanes; priority/source sort the board.
    digest: { text: 'clip', source: 'plain', priority: 'plain', system_reason: 'plain' },
  },
  brief: {
    schema: briefSchema,
    immutable: false,
    fts: (r) => [s(r.slug), s(r.title), s(r.problem), s(r.feature)].join('\n'),
    fileKeys: (r) => {
      const br = r.blast_radius as { files?: { path: string }[] } | undefined;
      return (br?.files ?? []).map((f) => f.path);
    },
    digest: { slug: 'plain', title: 'plain', problem: 'clip' },
  },
};

/**
 * The shared digest envelope + the type's headline fields (§3.4 read side).
 *
 * `id` stays a FULL uuid deliberately: an 8-char prefix resolves through
 * knowledge_get since decision 27f148c2, but handing back a truncated id is how
 * a caller ends up pasting one into a tool that wants the whole thing. The
 * point of the digest is to make the NEXT call cheap, so the handle it returns
 * has to be the one that works everywhere.
 *
 * An unregistered type yields the envelope alone rather than throwing — a
 * projection is a read convenience and must never be the thing that makes a
 * read fail.
 */
export function digestRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: record.id,
    type: record.type,
    status: record.status,
    updated_at: record.updated_at,
  };
  const entry = RECORD_TYPES[s(record.type)];
  if (!entry) return out;
  for (const [field, mode] of Object.entries(entry.digest)) {
    // Absent/empty headline fields are OMITTED rather than emitted as null: an
    // optional field then costs nothing, which is the entire point of a digest.
    const value = mode === 'clip' ? clipped(record[field]) : record[field];
    if (value !== undefined && value !== null && value !== '') out[field] = value;
  }
  return out;
}

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

/**
 * The field names a registered type actually accepts, derived from its own
 * schema so nothing is listed twice (invariant 1). Each record schema is
 * base.extend({...}).superRefine(...), i.e. a ZodEffects wrapping the object, so
 * the shape has to be unwrapped rather than read off the top — and reference_
 * material chains two refinements, hence the loop rather than one step.
 */
function objectShapeFor(type: string): Record<string, unknown> | undefined {
  const entry = RECORD_TYPES[type];
  if (!entry) return undefined;
  let schema: unknown = entry.schema;
  // unwrap ZodEffects/ZodDefault layers until the ZodObject with .shape surfaces
  for (let i = 0; i < 10 && schema && typeof schema === 'object'; i++) {
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    if (shape) return shape;
    const inner = (schema as { _def?: { schema?: unknown; innerType?: unknown } })._def;
    schema = inner?.schema ?? inner?.innerType;
  }
  return undefined;
}

export function knownFieldsFor(type: string): Set<string> | undefined {
  const shape = objectShapeFor(type);
  return shape ? new Set(Object.keys(shape)) : undefined;
}

/** One field's shape, as knowledge_schema reports it. */
export interface FieldShape {
  name: string;
  required: boolean;
  /** A readable rendering of the zod type: 'string', 'string[]', '{option, reason}[]', 'enum', … */
  type: string;
  /** Present only for closed sets — the whole point of asking. */
  enum_values?: string[];
}

/**
 * Render a zod type as a short readable string, plus its enum values when it is
 * a closed set. Bounded recursion: a malformed or exotically-nested schema
 * degrades to 'unknown' rather than throwing, because a SCHEMA READ must never
 * be why a call fails.
 */
function describeZod(node: unknown, depth = 0): { type: string; enum_values?: string[] } {
  if (!node || typeof node !== 'object' || depth > 6) return { type: 'unknown' };
  const def = (node as { _def?: Record<string, unknown> })._def;
  const name = def?.typeName as string | undefined;
  switch (name) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodAny':
    case 'ZodUnknown':
      return { type: 'any' };
    case 'ZodEnum': {
      const values = (def?.values as string[] | undefined) ?? [];
      return { type: 'enum', enum_values: values };
    }
    case 'ZodNativeEnum':
      return { type: 'enum' };
    case 'ZodLiteral':
      return { type: `literal ${JSON.stringify(def?.value)}` };
    case 'ZodArray': {
      const inner = describeZod(def?.type, depth + 1);
      return { type: `${inner.type}[]`, ...(inner.enum_values ? { enum_values: inner.enum_values } : {}) };
    }
    case 'ZodObject': {
      const shape = (node as { shape?: Record<string, unknown> }).shape ?? {};
      return { type: `{${Object.keys(shape).join(', ')}}` };
    }
    case 'ZodRecord':
      return { type: 'record<string, string>' };
    case 'ZodUnion': {
      const opts = ((def?.options as unknown[]) ?? []).map((o) => describeZod(o, depth + 1));
      // A union of literals IS a closed set, so report it as one — that is what
      // verifiable_at ('final' | 'phase:<n>') and similar fields actually are.
      const literals = opts.filter((o) => o.type.startsWith('literal '));
      if (literals.length === opts.length && opts.length) {
        return { type: opts.map((o) => o.type.replace('literal ', '')).join(' | ') };
      }
      return { type: opts.map((o) => o.type).join(' | ') };
    }
    // Wrappers: describe what they wrap. optionality is reported separately, so
    // it is deliberately NOT folded into the type string.
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return describeZod(def?.innerType, depth + 1);
    case 'ZodEffects':
      return describeZod(def?.schema, depth + 1);
    default:
      return { type: name ? name.replace(/^Zod/, '').toLowerCase() : 'unknown' };
  }
}

/**
 * The shape of a registered record type, DERIVED from its own zod schema
 * (board 7acfbe48 / feedback §2.7).
 *
 * Field shapes were learnable only by having a write REJECTED. Five documented
 * rejections across five different fields in one consuming project, three more
 * in the session that built this — `title` required on anti_pattern then on
 * decision then on feature_article, `version`/`history`/`live_test_refs`
 * required, `concept_family` documented as a "mark" but actually a string,
 * `alternatives_rejected` an array of OBJECTS not strings, `volatility_hint` a
 * closed enum refusing the entirely plausible 'low'. The refusals are GOOD —
 * they name the field and beat silently dropping data — but guess-and-fail is a
 * poor way to learn a shape, and the standing workaround (query an existing
 * record of that type and reverse-engineer it) is a workaround for a missing
 * read.
 *
 * Derived, never listed: exactly like knownFieldsFor, this reads the registered
 * schema, so a field becomes discoverable the moment it is defined and invariant
 * 1 still holds. There is no second list to drift.
 */
export function schemaFor(type: string): { type: string; fields: FieldShape[] } | undefined {
  const shape = objectShapeFor(type);
  if (!shape) return undefined;
  const fields: FieldShape[] = Object.entries(shape).map(([name, node]) => {
    const described = describeZod(node);
    const required = !(node as { isOptional?: () => boolean }).isOptional?.();
    return { name, required, type: described.type, ...(described.enum_values ? { enum_values: described.enum_values } : {}) };
  });
  return { type, fields };
}

/**
 * Keys in `candidate` that the type does not define — the input half of the
 * fail-loud rule (P5). zod objects STRIP unknown keys, so without this a
 * misfiled field (reference_material has no `files`/`file_keys`; its paths come
 * from `location`) was accepted, silently dropped, and the write returned
 * SUCCESS — caught only by later querying for the thing the write was supposed
 * to have done. Reported to a sibling project 2026-07-29, and the same defect
 * class as the tool-parameter strip closed by decision b47889b7: a write surface
 * must not claim to have stored what it discarded.
 *
 * Returns [] for an unregistered type — that is validateRecord's louder error to
 * raise, not this one's to pre-empt.
 */
export function unknownFieldsIn(type: string, candidate: Record<string, unknown>): string[] {
  const known = knownFieldsFor(type);
  if (!known) return [];
  return Object.keys(candidate).filter((k) => !known.has(k));
}

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
