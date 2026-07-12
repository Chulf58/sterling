// Per-phase completeness check [S] (spec §8.1, spine §16.1) — the mechanical
// half: handoffs present and in-contract, tests produced. With --final it is
// the run-completion script and runs H12 (wiring + zero-consumer) through the
// adapter capability. The judgment half (subtask coverage), reviewer dispatch,
// and test-integrity are not built — each is skipped LOUDLY where it would run.
//   node scripts/completeness-check.mjs --run <id> --phase <id> [--final] [--target <dir>]
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { arg, fail, openProject, requireRun, requireBrief, runDir } from './lib/project.mjs';
import { loadAdapter } from './adapters/resolve.mjs';
import { runTestsRouted } from './lib/test-routing.mjs';
import { runWiringCheck } from './lib/wiring-check.mjs';
import { compareBaseline } from './lib/test-integrity.mjs';
import { isGitRepo, wholeRunDiffFiles } from './lib/branch-manager.mjs';

const target = arg('--target') ?? process.cwd();
const { store, config } = openProject(target);
const run = requireRun(store, arg('--run'));
const brief = requireBrief(store, run);
const phaseId = arg('--phase') ?? run.phases.find((p) => p.status === 'in_progress')?.id;
const isFinal = process.argv.includes('--final');

// Fail loud on an unresolvable phase (P5, R2 board d0bdfe56 — prep and
// test-check already refuse the same condition): with phaseId undefined the
// handoff read degraded to ALL handoffs (so 'no handoff written' could never
// fire) and the whole subtask-evidence half was skipped with no problem and no
// check_skipped — exit 0 while verifying much less than invoked for. After the
// last boundary exit no phase is in_progress, so --final callers pass --phase
// explicitly (the documented CLI form).
if (!phaseId) {
  store.close();
  fail('completeness-check: no resolvable phase — no phase is in_progress; pass --phase explicitly');
}
if (!brief.phases.some((p) => p.phase_id === phaseId)) {
  store.close();
  fail(`completeness-check: phase '${phaseId}' is not in the run's brief`);
}

const handoffs = store.readHandoffs(run.id, { phase_id: phaseId });
const problems = [];
if (handoffs.length === 0) problems.push(`no handoff written for phase '${phaseId}' — agents communicate through durable run records, never relay (§7.4)`);

// Mid-run scope amendments (brief mid-run-scope-amendment, decision 8e6f9491) are
// in-contract everywhere the contract is checked — union them here too (:26).
const amendmentPaths = (run.scope_amendments ?? []).map((a) => a.path);
const allowed = new Set([...brief.blast_radius.files.map((f) => f.path), ...brief.incidental_scope, ...amendmentPaths]);
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
skip('reviewer-dispatch', 'not_built');

// Per-subtask evidence (§17 decision order, structure-first half): every phase
// subtask must carry a citation in a handoff; cited files and tests must exist;
// cited tests must pass. The honesty classifier is deferred by decision (§17).
const phase = brief.phases.find((p) => p.phase_id === phaseId);
if (phase) {
  // evidence reads from the LATEST handoff per role: fixer iterations supersede
  // their earlier attempts' citations (handoffs are ordered by created_at)
  const latestByRole = new Map();
  for (const h of handoffs) latestByRole.set(h.agent_role, h);
  const citations = [...latestByRole.values()].flatMap((h) => h.subtask_evidence ?? []);
  const citedTests = new Set();
  for (const subtask of phase.subtasks) {
    const cited = citations.filter((c) => c.subtask === subtask);
    if (cited.length === 0) {
      problems.push(`subtask-evidence: no citation for subtask '${subtask}' — every subtask is evidenced or the phase is not complete (§17)`);
      continue;
    }
    for (const c of cited) {
      for (const f of [...c.files, ...c.tests]) {
        if (!existsSync(join(target, f))) problems.push(`subtask-evidence: '${subtask}' cites '${f}' which does not exist`);
      }
      c.tests.forEach((t) => citedTests.add(t));
    }
  }
  if (citedTests.size) {
    const overall = (await runTestsRouted({ cwd: target, config, scope: [...citedTests] }))?.overall;
    if (overall !== undefined && overall !== 'pass') {
      problems.push(`subtask-evidence: cited tests are ${overall}, not green — citations must point at passing evidence`);
    }
  }
}

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

  // every AC has passing traced tests: route each produced test to its owning
  // toolchain's adapter, then combine (finding 19/43 — not all through toolchains[0])
  const allTests = [...new Set(store.readHandoffs(run.id).flatMap((h) => h.tests_produced))];
  const suiteOverall = (await runTestsRouted({ cwd: target, config, scope: allTests }))?.overall;
  if (suiteOverall !== undefined && suiteOverall !== 'pass') {
    problems.push(`final completeness: the run's traced test suite is ${suiteOverall}, not green — ACs are not collectively satisfied`);
  }

  // whole-run diff within contract (needs the branch manager's base)
  if (isGitRepo(target) && run.base_branch) {
    const allowed = new Set([...brief.blast_radius.files.map((f) => f.path), ...brief.incidental_scope, ...amendmentPaths]);
    const diffFiles = wholeRunDiffFiles({ cwd: target, store, runId: run.id });
    // Generated hook bundles (build-hooks.mjs: scripts/hooks/h*.mjs → hooks/<name>.mjs,
    // lib + workspace packages inlined) regenerate whenever any bundle input changes,
    // and the enforcement suite runs build-hooks in-repo — so a run touching an input
    // sweeps regenerated bundles into the whole-run diff (decision 66c15d77). A diff'd
    // bundle is in-contract when its regeneration CAUSE is: some other in-contract diff
    // file under the bundle-input roots. Never a blanket allow — a bundle change with
    // no in-contract cause still refuses, a bundle with no generating source still
    // refuses, and hooks/** stays agent-unwritable (H3 self-protection, H17) regardless.
    const bundleInput = (f) => ['scripts/hooks/', 'packages/schemas/', 'packages/store/'].some((p) => f.startsWith(p));
    const rebuildCaused = diffFiles.some((f) => bundleInput(f) && allowed.has(f));
    const isGeneratedBundle = (f) => /^hooks\/h[^/]*\.mjs$/.test(f) && existsSync(join(target, 'scripts', f));
    for (const f of diffFiles) {
      if (allowed.has(f)) continue;
      if (rebuildCaused && isGeneratedBundle(f)) continue;
      problems.push(`whole-run diff outside contract: '${f}' (§8.1 final completeness)`);
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
