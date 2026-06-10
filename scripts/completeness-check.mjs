// Per-phase completeness check [S] (spec §8.1, spine §16.1) — the mechanical
// half: handoffs present and in-contract, tests produced. With --final it is
// the run-completion script and runs H12 (wiring + zero-consumer) through the
// adapter capability. The judgment half (subtask coverage), reviewer dispatch,
// and test-integrity are not built — each is skipped LOUDLY where it would run.
//   node scripts/completeness-check.mjs --run <id> --phase <id> [--final] [--target <dir>]
import { arg, fail, openProject, requireRun, requireBrief } from './lib/project.mjs';
import { loadAdapter } from './adapters/resolve.mjs';
import { runWiringCheck } from './lib/wiring-check.mjs';

const target = arg('--target') ?? process.cwd();
const { store, config } = openProject(target);
const run = requireRun(store, arg('--run'));
const brief = requireBrief(store, run);
const phaseId = arg('--phase') ?? run.phases.find((p) => p.status === 'in_progress')?.id;
const isFinal = process.argv.includes('--final');

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
for (const check of ['completeness-judgment', 'reviewer-dispatch', 'test-integrity']) {
  store.recordCheckSkipped(check, 'not_built', run.id, now);
  skipped.push({ check, reason: 'not_built' });
}

// H12 runs at final completeness, through the adapter capability (§6 H12, §9.1)
let wiring = null;
if (isFinal) {
  const adapterName = config.toolchains?.[0]?.adapter;
  const adapterModule = adapterName ? await loadAdapter(adapterName) : { name: 'none', capabilities: {} };
  const article = store
    .query({ types: ['feature_article'], cap: 1000 })
    .find((a) => a.history.some((h) => h.target_id === brief.id));
  wiring = runWiringCheck({
    adapterModule,
    cwd: target,
    scope: brief.blast_radius.files.map((f) => f.path),
    article,
    store,
    now,
  });
  if (wiring.skipped) {
    store.recordCheckSkipped(wiring.skipped.check, wiring.skipped.reason, run.id, now);
    skipped.push(wiring.skipped);
  }
  problems.push(...wiring.violations);
}
store.close();

console.log(JSON.stringify({ phase_id: phaseId, problems, check_skipped: skipped, wiring }));
if (problems.length) fail(`completeness check FAILED:\n  ${problems.join('\n  ')}`);
