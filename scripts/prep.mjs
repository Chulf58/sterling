// prep [S] (spec §7.1, §3.7) — a script, not an agent (P3): stage file refs +
// knowledge for a phase. Judgment happened once, at planning (the phase spec
// declares files + rank_terms); prep is pure mechanics: filter → join → rank →
// cap via knowledge_query semantics, handoff_read for intersecting prior
// phases, and a knowledge_pack written as a free byproduct.
//   node scripts/prep.mjs --run <id> --phase <id> [--role <consumer>] [--target <dir>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { arg, fail, openProject, requireRun, requireBrief, runDir } from './lib/project.mjs';

const target = arg('--target') ?? process.cwd();
const { cwd, store, config } = openProject(target);
const run = requireRun(store, arg('--run'));
const brief = requireBrief(store, run);
const phaseId = arg('--phase') ?? run.phases.find((p) => p.status === 'in_progress')?.id;
const phase = brief.phases.find((p) => p.phase_id === phaseId);
if (!phase) fail(`prep: no phase '${phaseId}' in brief '${brief.id}'`);
const role = arg('--role') ?? 'coder';

// Planning outputs are prep's inputs (§7.6); one-phase spine falls back to the blast radius.
const files = phase.files ?? brief.blast_radius.files.map((f) => f.path);
const rankTerms = phase.rank_terms ?? [];
const cap = config.prep_cap ?? 20;

const queryInputs = { file_keys: files, rank_terms: rankTerms.length ? rankTerms : undefined, cap };
const returned = store.query(queryInputs);
const totalMatching = store.query({ ...queryInputs, cap: cap + 1000 }).length;
const capOmissions = Math.max(0, totalMatching - returned.length);

// Mandatory items (§3.7): known_gaps on returned articles touching the phase's
// files — a mechanically proven map of prior blind spots. severity_block
// anti-patterns join this list when the type lands (full build).
const fileSet = new Set(files);
const mandatory = [];
for (const rec of returned) {
  if (rec.type === 'feature_article' && (rec.known_gaps?.length ?? 0) > 0 && rec.files.some((f) => fileSet.has(f.path))) {
    mandatory.push({ record_id: rec.id, reason: 'known_gap' });
  }
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
  prior_handoffs: priorHandoffs.map((h) => ({ phase_id: h.phase_id, agent_role: h.agent_role })),
  staged_at: new Date().toISOString(),
};

const dir = runDir(cwd, run.id);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `knowledge_pack-${phaseId}.json`), JSON.stringify(pack, null, 2));
store.close();
console.log(JSON.stringify({ written: `knowledge_pack-${phaseId}.json`, returned: returned.length, mandatory: mandatory.length, cap_omissions: capOmissions }));
