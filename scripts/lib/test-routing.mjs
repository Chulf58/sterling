// Multi-toolchain test routing (audit finding 19/43, generalized by R2 board
// 641d4cae): route each test path to the adapter of the toolchain whose
// test_globs match it, then combine — a multi-toolchain project (e.g. node +
// pester) otherwise ran ALL tests through toolchains[0]'s adapter,
// misclassifying the second stack's suite as a crash. Unmatched paths fall to
// toolchains[0], so single-toolchain projects are unchanged. The ONE routing
// definition, consumed by completeness-check (cited-evidence + AC-traced
// sites) AND test-check (red/green gate).
import { matchesGlob } from '@sterling/schemas';
import { loadAdapter } from '../adapters/resolve.mjs';

/**
 * Returns { overall, results } combined across the routed adapters, or
 * undefined when there is nothing to run / no toolchain declared. overall
 * combines conservatively: any crash → crash, else any assertion_fail →
 * assertion_fail, else pass.
 */
export async function runTestsRouted({ cwd, config, scope }) {
  const toolchains = config.toolchains ?? [];
  if (toolchains.length === 0 || scope.length === 0) return undefined;
  const byAdapter = new Map();
  for (const p of scope) {
    const tc = toolchains.find((t) => (t.test_globs ?? []).some((g) => matchesGlob(p, g))) ?? toolchains[0];
    if (!byAdapter.has(tc.adapter)) byAdapter.set(tc.adapter, []);
    byAdapter.get(tc.adapter).push(p);
  }
  const overalls = [];
  const results = [];
  for (const [adapterName, paths] of byAdapter) {
    const mod = await loadAdapter(adapterName);
    if (typeof mod?.runTests === 'function') {
      const r = mod.runTests({ cwd, scope: paths });
      overalls.push(r.overall);
      results.push(...(r.results ?? []));
    }
  }
  if (overalls.length === 0) return undefined;
  const overall = overalls.includes('crash') ? 'crash' : overalls.includes('assertion_fail') ? 'assertion_fail' : 'pass';
  return { overall, results };
}
