// Red / green check [S] (spec §9.2) — conductor-invoked, never coder-invoked.
// All outcomes come from the toolchain adapter's classification; no agent ever
// infers test outcomes from raw runner output.
//   node scripts/test-check.mjs --expect red|green --scope <path> [--scope <path>...]
//                               [--run <id>] [--target <dir>] [--adapter <name>]
// red:   overall must be assertion_fail (a crash-red proves nothing; a pass means no oracle)
// green: overall must be pass; on green, the unbuilt mutation check is skipped LOUDLY.
import { arg, argAll, fail, openProject } from './lib/project.mjs';
import { loadAdapter } from './adapters/resolve.mjs';

const expect = arg('--expect');
if (expect !== 'red' && expect !== 'green') fail('usage: test-check.mjs --expect red|green --scope <path>...');
const scope = argAll('--scope');
if (!scope.length) fail('test-check: at least one --scope is required');

const target = arg('--target') ?? process.cwd();
const { store, config } = openProject(target);
const adapterName = arg('--adapter') ?? config.toolchains?.[0]?.adapter;
if (!adapterName) {
  store.close();
  fail('test-check: no toolchain declared in config and no --adapter given');
}

const adapter = await loadAdapter(adapterName);
const result = adapter.runTests({ cwd: target, scope });
const summary = { expect, overall: result.overall, results: result.results };

let ok;
if (expect === 'red') {
  if (result.overall === 'assertion_fail') ok = true;
  else if (result.overall === 'pass') summary.refusal = 'tests pass before implementation — not a valid red (no oracle)';
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
