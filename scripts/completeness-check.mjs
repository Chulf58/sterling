// Per-phase completeness check [S] (spec §8.1, spine §16.1) — the mechanical
// half: handoffs present and in-contract, tests produced. The judgment half
// (subtask coverage), H12 wiring, reviewer dispatch, and test-integrity are
// not built in the spine — each is skipped LOUDLY where it would have run.
//   node scripts/completeness-check.mjs --run <id> --phase <id> [--target <dir>]
import { arg, fail, openProject, requireRun, requireBrief } from './lib/project.mjs';

const target = arg('--target') ?? process.cwd();
const { store } = openProject(target);
const run = requireRun(store, arg('--run'));
const brief = requireBrief(store, run);
const phaseId = arg('--phase') ?? run.phases.find((p) => p.status === 'in_progress')?.id;

const handoffs = store.readHandoffs(run.id, { phase_id: phaseId });
const problems = [];
if (handoffs.length === 0) problems.push(`no handoff written for phase '${phaseId}' — agents communicate through durable run records, never relay (§7.4)`);

const allowed = new Set([...brief.blast_radius.files.map((f) => f.path), ...brief.incidental_scope]);
for (const h of handoffs) {
  for (const change of h.what_changed) {
    if (!allowed.has(change.path)) problems.push(`handoff (${h.agent_role}) reports out-of-contract change: '${change.path}'`);
  }
}
if (!handoffs.some((h) => h.tests_produced.length > 0)) {
  problems.push(`no tests_produced recorded for phase '${phaseId}' — a TDD phase without tests is not complete`);
}

const now = new Date().toISOString();
const skipped = [];
for (const check of ['completeness-judgment', 'wiring-zero-consumer', 'reviewer-dispatch', 'test-integrity']) {
  store.recordCheckSkipped(check, 'not_built', run.id, now);
  skipped.push({ check, reason: 'not_built' });
}
store.close();

console.log(JSON.stringify({ phase_id: phaseId, problems, check_skipped: skipped }));
if (problems.length) fail(`completeness check FAILED:\n  ${problems.join('\n  ')}`);
