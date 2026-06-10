// Per-phase completeness check [S] (spec §8.1, spine §16.1) — the mechanical
// half: handoffs present and in-contract, tests produced. With --final it is
// the run-completion script and runs H12 (wiring + zero-consumer) through the
// adapter capability. The judgment half (subtask coverage), reviewer dispatch,
// and test-integrity are not built — each is skipped LOUDLY where it would run.
//   node scripts/completeness-check.mjs --run <id> --phase <id> [--final] [--target <dir>]
import { join } from 'node:path';
import { arg, fail, openProject, requireRun, requireBrief, runDir } from './lib/project.mjs';
import { loadAdapter } from './adapters/resolve.mjs';
import { runWiringCheck } from './lib/wiring-check.mjs';
import { compareBaseline } from './lib/test-integrity.mjs';
import { isGitRepo, wholeRunDiffFiles } from './lib/branch-manager.mjs';

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
const skip = (check, reason) => {
  store.recordCheckSkipped(check, reason, run.id, now);
  skipped.push({ check, reason });
};
for (const check of ['completeness-judgment', 'reviewer-dispatch']) skip(check, 'not_built');

// test-integrity (§9.2): the phase's frozen baseline written at the red check
const integrity = compareBaseline({ cwd: target, runDir: runDir(target, run.id), phaseId });
if (integrity.baseline_missing) {
  skip('test-integrity', 'no_baseline_for_phase');
} else {
  for (const f of integrity.modified) problems.push(`test-integrity: frozen test '${f}' was MODIFIED during the loop (§9.2 — the oracle never weakens itself)`);
  for (const f of integrity.deleted) problems.push(`test-integrity: frozen test '${f}' was DELETED during the loop`);
}

// Final completeness (§8.1): every AC's traced tests pass (verifiable_at
// honored — final ACs run HERE), whole-run diff within contract, H12 wiring,
// reconcile list fully reconciled.
let wiring = null;
if (isFinal) {
  const adapterName = config.toolchains?.[0]?.adapter;
  const adapterModule = adapterName ? await loadAdapter(adapterName) : { name: 'none', capabilities: {} };

  // every AC has passing traced tests: run the union of produced tests
  const allTests = [...new Set(store.readHandoffs(run.id).flatMap((h) => h.tests_produced))];
  if (allTests.length && typeof adapterModule.runTests === 'function') {
    const suite = adapterModule.runTests({ cwd: target, scope: allTests });
    if (suite.overall !== 'pass') {
      problems.push(`final completeness: the run's traced test suite is ${suite.overall}, not green — ACs are not collectively satisfied`);
    }
  }

  // whole-run diff within contract (needs the branch manager's base)
  if (isGitRepo(target) && run.base_branch) {
    const allowed = new Set([...brief.blast_radius.files.map((f) => f.path), ...brief.incidental_scope]);
    for (const f of wholeRunDiffFiles({ cwd: target, store, runId: run.id })) {
      if (!allowed.has(f)) problems.push(`whole-run diff outside contract: '${f}' (§8.1 final completeness)`);
    }
  } else {
    skip('whole-run-diff', run.base_branch ? 'no_git' : 'no_base_branch');
  }

  // reconcile list (brief ∪ H7 marks) fully reconciled — same rule dispose-run enforces
  for (const id of new Set([...brief.blast_radius.reconcile_list, ...(run.reconcile_needed ?? [])])) {
    const rec = store.get(id);
    if (rec && rec.status === 'active' && rec.updated_at < run.started_at) {
      problems.push(`reconcile_list: article '${id}' not reconciled during the run`);
    }
  }

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
  if (wiring.skipped) skip(wiring.skipped.check, wiring.skipped.reason);
  problems.push(...wiring.violations);
}
store.close();

console.log(JSON.stringify({ phase_id: phaseId, problems, check_skipped: skipped, wiring }));
if (problems.length) fail(`completeness check FAILED:\n  ${problems.join('\n  ')}`);
