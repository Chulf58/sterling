// prep [S] (spec §7.1, §3.7) — a script, not an agent (P3): stage file refs +
// knowledge for a phase. Judgment happened once, at planning (the phase spec
// declares files + rank_terms); prep is pure mechanics: filter → join → rank →
// cap via knowledge_query semantics, handoff_read for intersecting prior
// phases, and a knowledge_pack written as a free byproduct.
//   node scripts/prep.mjs --run <id> --phase <id> [--role <consumer>] [--target <dir>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { arg, fail, openMounted, requireRun, requireBrief, runDir } from './lib/project.mjs';

const target = arg('--target') ?? process.cwd();
// §3.4/P6: stage from the FULL retrieval surface — project knowledge AND the
// mounted shared-domain stores (stack_tags manifest), project-first. Run/brief/
// handoff reads and the pack write route project-local through MountedStores.
const { cwd, store, config } = openMounted(target);
const run = requireRun(store, arg('--run'));
const brief = requireBrief(store, run);
const phaseId = arg('--phase') ?? run.phases.find((p) => p.status === 'in_progress')?.id;
const phase = brief.phases.find((p) => p.phase_id === phaseId);
if (!phase) fail(`prep: no phase '${phaseId}' in brief '${brief.id}'`);

// Breadth backstop (two-axis phase discipline, decision 288936ab): an over-wide
// phase is a decomposition failure (P7), never absorbed by prep or the agents
// it dispatches. Checked immediately after phase resolution, BEFORE prep's
// first write/stamp — a refused phase stages nothing (no knowledge_pack, no
// dispatch slices, no review_mandatory). Strictly-greater: exactly-at-threshold
// stages normally.
const splitThreshold = config.difficulty?.split_interface_threshold ?? 3;
const interfaceCount = (phase.interfaces ?? []).length;
if (interfaceCount > splitThreshold) {
  fail(
    `prep: phase '${phaseId}' is over-wide — ${interfaceCount} interfaces exceeds the split threshold (${splitThreshold}). ` +
      `An over-wide phase is a decomposition failure (P7): split it into narrower phases at planning (each within the ` +
      `threshold), then re-run prep. Nothing was staged.`
  );
}

const role = arg('--role') ?? 'coder';

// Planning outputs are prep's inputs (§7.6); one-phase spine falls back to the blast radius.
const files = phase.files ?? brief.blast_radius.files.map((f) => f.path);
const rankTerms = phase.rank_terms ?? [];
const cap = config.prep_cap ?? 20;

const queryInputs = { file_keys: files, rank_terms: rankTerms.length ? rankTerms : undefined, cap };
// Concept-article slice (decision 7208729b, brief concept-article-layer-wiring):
// concept articles (feature_article.concept_family) get up to prep_concept_cap
// of the cap's slots, ranked among themselves; the remaining slots go to the
// general ranking. Neither class silently displaces the other; the split is
// computed from the same ranked pool the omission count already needed, so
// staging stays one retrieval pass. No concept articles → identical to before.
const conceptCap = config.prep_concept_cap ?? 5;
const pool = store.query({ ...queryInputs, cap: cap + 1000 });
const isConcept = (r) => r.type === 'feature_article' && r.concept_family;
const conceptPool = pool.filter(isConcept);
const conceptSlice = conceptPool.slice(0, Math.min(conceptCap, cap));
const generalPool = pool.filter((r) => !isConcept(r));
const generalSlice = generalPool.slice(0, cap - conceptSlice.length);
// Backfill: when the general pool cannot fill the cap, idle slots go to the
// concept tail — the sub-cap RESERVES capacity, it never wastes it (a scarce
// general pool must not strand concept articles below an empty cap;
// correctness review 2026-07-17).
const spare = cap - conceptSlice.length - generalSlice.length;
const conceptBackfill = spare > 0 ? conceptPool.slice(conceptSlice.length, conceptSlice.length + spare) : [];
// Preserve pool rank order in the staged set (concept + general interleaved as ranked).
const stagedIds = new Set([...conceptSlice, ...conceptBackfill, ...generalSlice].map((r) => r.id));
const returned = pool.filter((r) => stagedIds.has(r.id));
const totalMatching = pool.length;
const capOmissions = Math.max(0, totalMatching - returned.length);
const capOmissionsConcept = Math.max(0, conceptPool.length - conceptSlice.length - conceptBackfill.length);

// Mandatory items (§3.7): known_gaps on returned articles touching the phase's
// files — a mechanically proven map of prior blind spots. severity_block
// anti-patterns join this list when the type lands (full build). When it does,
// keep the query on DEFAULT retrieval (no include_unconfirmed): an H11-derived
// anti_pattern's severity is unconfirmed Haiku output steerable by note text
// (decision a6a0dd7b) — it must not gate a phase until a human confirms it.
const fileSet = new Set(files);
const mandatory = [];
for (const rec of returned) {
  if (rec.type === 'feature_article' && (rec.known_gaps?.length ?? 0) > 0 && rec.files.some((f) => fileSet.has(f.path))) {
    mandatory.push({ record_id: rec.id, reason: 'known_gap' });
  }
}

// required_by_contract (decision 628c4b7f (d)): the staged records the brief
// itself cited as governing this work — staged ids ∩ brief.decisions_made (a
// confirmed UUID array). Live from run one because this feature's own brief
// cites its decisions. These join the known_gaps into the per-phase reviewer
// mandatory set (the run-record home), but do NOT enter pack.mandatory —
// pack.mandatory stays byte-for-byte the §3.7 known_gap manifest.
const byId = new Map(returned.map((r) => [r.id, r]));
const decisionsMade = new Set(brief.decisions_made ?? []);
const requiredByContract = returned
  .filter((r) => decisionsMade.has(r.id))
  .map((r) => ({ record_id: r.id, reason: 'required_by_contract' }));

// review_mandatory = known_gap ∪ required_by_contract (dedupe by record_id;
// a known_gap wins a tie so its lane name is the one carried).
const mandatoryUnion = [];
const seenMandatory = new Set();
for (const item of [...mandatory, ...requiredByContract]) {
  if (seenMandatory.has(item.record_id)) continue;
  seenMandatory.add(item.record_id);
  mandatoryUnion.push(item);
}

// Intra-run blast radius: prior phases' handoffs intersecting this phase's files (§7.4).
const priorHandoffs = store.readHandoffs(run.id, { files });

const pack = {
  consumer_role: role,
  run_id: run.id,
  phase_id: phaseId,
  query_inputs: queryInputs,
  returned_record_ids: returned.map((r) => r.id),
  mandatory,
  cap_omissions: capOmissions,
  // Slice-distinguished omission count (AC11, concept-article-layer-wiring):
  // concept articles dropped by the concept sub-cap. Additive pack field —
  // dispose-run's summary fold picks its known fields and is unaffected.
  cap_omissions_concept: capOmissionsConcept,
  prior_handoffs: priorHandoffs.map((h) => ({ phase_id: h.phase_id, agent_role: h.agent_role })),
  staged_at: new Date().toISOString(),
};

const dir = runDir(cwd, run.id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `knowledge_pack-${phaseId}.json`), JSON.stringify(pack, null, 2));

// ---------------------------------------------------------------------------
// Role-scoped dispatch slices + review_mandatory stamp (decision 628c4b7f (d)).
// The single standard invocation emits BOTH slices; delivery-by-prompt retires
// the H4 pack seam without touching H4. Line 1 is the deterministic marker H8
// checks for; the body is retrieval rendered mechanically (P3 — no LLM).
// ---------------------------------------------------------------------------
const EXCERPT_CHARS = 600; // mechanical truncation of a record's primary field

// The primary structured field per type — the one field an excerpt truncates.
function primaryField(rec) {
  switch (rec.type) {
    case 'decision':
      return rec.statement;
    case 'anti_pattern':
      return rec.guidance;
    case 'feature_article':
      return rec.what_it_does;
    case 'research_finding':
      return rec.answer;
    case 'reference_material':
      return rec.summary;
    case 'note':
      return rec.raw_text;
    default:
      return rec.title ?? '';
  }
}
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const oneLiner = (rec) => collapse(primaryField(rec)).slice(0, 120);
const excerpt = (rec) => collapse(primaryField(rec)).slice(0, EXCERPT_CHARS);
const marker = (role) => `STERLING-SLICE run=${run.id} phase=${phaseId} role=${role} staged=${new Date().toISOString()}`;

// Reviewer slice (spec §7.4): narrows to anti_pattern + decision knowledge
// records, plus the mandatory union (known_gap ∪ required_by_contract) each with
// its reason + a mechanical excerpt of its primary field.
const reviewerKnowledge = returned.filter((r) => r.type === 'anti_pattern' || r.type === 'decision');
const reviewerLines = [
  marker('reviewer'),
  '',
  '# Reviewer knowledge slice — anti-patterns & decisions keyed to this phase',
  '',
  ...(reviewerKnowledge.length
    ? reviewerKnowledge.map((r) => `- ${r.type} — ${r.title} [${r.id}] — ${oneLiner(r)}`)
    : ['(no anti-pattern or decision records staged for this phase)']),
  '',
  '## Mandatory review items — each needs a disposition in your handoff',
  '',
  ...(mandatoryUnion.length
    ? mandatoryUnion.flatMap((m) => {
        const rec = byId.get(m.record_id);
        const title = rec?.title ?? '(record not in staged pack)';
        return [`- ${m.reason}: ${title} [${m.record_id}]`, `  ${rec ? excerpt(rec) : ''}`];
      })
    : ['(no mandatory items for this phase)']),
  '',
];
writeFileSync(join(dir, `dispatch_slice-${phaseId}-reviewer.md`), reviewerLines.join('\n'));

// Builder slice (coder/test-writer): the full staged pack, title + full UUID +
// one-liner — the existing broad retrieval, delivered by prompt.
const builderLines = [
  marker('builder'),
  '',
  '# Builder knowledge pack — full staged retrieval for this phase',
  '',
  ...(returned.length
    ? returned.map((r) => `- ${r.type} — ${r.title ?? r.slug ?? '(untitled)'} [${r.id}] — ${oneLiner(r)}`)
    : ['(no records staged for this phase)']),
  '',
];
writeFileSync(join(dir, `dispatch_slice-${phaseId}-builder.md`), builderLines.join('\n'));

// Stamp the per-phase reviewer mandatory set onto the run record (phase-1
// primitive, replace-by-phase) — the only home readable at handoffWrite,
// dispose-run, and merge-gate (decision 628c4b7f (a)).
store.setRunReviewMandatory(run.id, phaseId, mandatoryUnion.map((m) => ({ record_id: m.record_id, reason: m.reason })));

store.close();
console.log(JSON.stringify({ written: `knowledge_pack-${phaseId}.json`, returned: returned.length, mandatory: mandatory.length, cap_omissions: capOmissions, cap_omissions_concept: capOmissionsConcept }));
