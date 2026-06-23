// 'none' toolchain adapter (spec §9.1): a first-class "this scope has NO
// automated checks" declaration — for docs/instructional projects (permanent)
// and not-yet-coded projects (a clean placeholder until the real stack is
// known). All capabilities false, no test globs, no run commands. So
// resolveToolchains bakes empty declarations: H4/H5 freeze nothing and H14
// allowlists no test command; the test/prep stages find nothing to run.
//
// runTests exists only to satisfy the fixed adapter interface (checkAdapterRegistry
// requires it). It is a LOUD no-op: it returns overall 'skipped' — NEVER 'pass'
// (P5: a missing capability degrades loud, never silently green). With no test
// globs it is never invoked in practice; if a stage ever does call it, 'skipped'
// fails the green-expecting checks loudly rather than masking a gap.
export const name = 'none';

export const capabilities = { mutation: false, static_wiring: false };

export const testPathGlobs = [];

export const runCommands = {};

export function runTests() {
  return {
    overall: 'skipped',
    results: [],
    raw: 'none adapter: no automated checks for this toolchain (capabilities all false)',
  };
}
