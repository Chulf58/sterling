// Red / green check [S] (spec §9.2) — conductor-invoked, never coder-invoked.
// All outcomes come from the toolchain adapter's classification; no agent ever
// infers test outcomes from raw runner output.
//   node scripts/test-check.mjs --expect red|green --scope <path> [--scope <path>...]
//                               [--run <id>] [--phase <id>] [--target <dir>] [--adapter <name>]
// red:   overall must be assertion_fail (a crash-red proves nothing; a pass means no oracle)
// green: overall must be pass; on green, the unbuilt mutation check is skipped LOUDLY.
import { join } from 'node:path';
import { arg, argAll, fail, openProject } from './lib/project.mjs';
import { loadAdapter } from './adapters/resolve.mjs';
import { runTestsRouted } from './lib/test-routing.mjs';
import { writeBaseline } from './lib/test-integrity.mjs';

const expect = arg('--expect');
if (expect !== 'red' && expect !== 'green') fail('usage: test-check.mjs --expect red|green --scope <path>...');
const scope = argAll('--scope');
if (!scope.length) fail('test-check: at least one --scope is required');

const target = arg('--target') ?? process.cwd();
const { store, config } = openProject(target);

// Route each scope path to its owning toolchain's adapter (R2 board 641d4cae —
// the 19/43 multi-toolchain routing previously landed only in completeness-check,
// so a red/green check over a second toolchain's tests misclassified as crash).
// An explicit --adapter forces that adapter for the whole scope.
let result;
const adapterName = arg('--adapter');
if (adapterName) {
  const adapter = await loadAdapter(adapterName);
  result = adapter.runTests({ cwd: target, scope });
} else {
  result = await runTestsRouted({ cwd: target, config, scope });
  if (result === undefined) {
    store.close();
    fail('test-check: no toolchain declared in config and no --adapter given');
  }
}
const summary = { expect, overall: result.overall, results: result.results };

let ok;
if (expect === 'red') {
  if (result.overall === 'assertion_fail') {
    ok = true;
    // freeze the phase's oracle (§9.2): the baseline test-integrity compares against.
    // phase_id binds to the run's CURRENT phase when --phase is omitted (the freeze
    // is a red-check EVENT, not a remembered flag — P4; audit finding 16/43). Skip
    // LOUDLY (never silently) when there is a run but no resolvable phase.
    const run = arg('--run') ? store.getRun(arg('--run')) : store.getRun();
    const runId = run?.id;
    const phaseId = arg('--phase') ?? run?.phases.find((p) => p.status === 'in_progress')?.id;
    if (runId && phaseId) {
      const frozen = writeBaseline({ cwd: target, runDir: join(target, '.sterling', 'runs', runId), phaseId, testFiles: scope });
      summary.baseline_frozen = frozen;
    } else if (runId && !phaseId) {
      store.recordCheckSkipped('test-integrity-baseline', 'no_resolvable_phase', runId, new Date().toISOString());
      summary.check_skipped = [{ check: 'test-integrity-baseline', reason: 'no_resolvable_phase' }];
    }
  } else if (result.overall === 'pass') summary.refusal = 'tests pass before implementation — not a valid red (no oracle)';
  else summary.refusal = 'tests crash before implementation — a crash-red proves nothing (§9.2); fix the test scaffold';
} else {
  ok = result.overall === 'pass';
  if (!ok) summary.refusal = `expected green, got ${result.overall}`;
  if (ok) {
    // The mutation check runs after coder-green (§9.2) and is not built —
    // skipped loudly at exactly the point it would have run (§16.1.9).
    const runId = arg('--run') ?? store.getRun()?.id;
    store.recordCheckSkipped('mutation-check', 'not_built', runId, new Date().toISOString());
    summary.check_skipped = [{ check: 'mutation-check', reason: 'not_built' }];
  }
}
store.close();
console.log(JSON.stringify(summary));
process.exit(ok ? 0 : 1);
