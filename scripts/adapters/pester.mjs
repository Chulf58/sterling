// pester toolchain adapter (spec §9.1) — PowerShell / Pester v5. Runs tests over
// a scope and classifies every result as pass | assertion_fail | crash, the same
// contract the node adapter implements. Classification happens HERE, never by an
// agent reading raw Pester output.
//
// Classification (probe-verified on Pester 5.7.1 / Windows PowerShell 5.1):
//   test Result 'Passed'                                       -> pass
//   test Result 'Failed' + FullyQualifiedErrorId
//        == 'PesterAssertionFailed' (a Should failure)         -> assertion_fail
//   test Result 'Failed' + any other error id (throw / unexpected
//        exception / discovery error surfaced as a test)       -> crash
//   spawn failure / Pester missing / no parseable results      -> crash
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const name = 'pester';

// Optional capabilities (§9.1): neither implemented for PowerShell yet — consuming
// checks record check_skipped at the call site, never silently pass (P5).
export const capabilities = { mutation: false, static_wiring: false };

// The single definition of "what is a test file" (Pester convention) — consumed by
// H4's read wall and H5's test freeze. Baked into project config at init.
export const testPathGlobs = ['**/*.Tests.ps1', 'tests/**/*.ps1'];

// Declared run command — init bakes this into code-touching agents' Bash allowlists
// (H14, §7.1).
export const runCommands = { test: 'Invoke-Pester' };

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-pester.ps1');
const START = '@@PESTER_JSON_START@@';
const END = '@@PESTER_JSON_END@@';

// Prefer pwsh (PowerShell 7+); fall back to Windows PowerShell. Memoized.
let psExe;
function powershellExe() {
  if (psExe) return psExe;
  const probe = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
  psExe = probe.error ? 'powershell.exe' : 'pwsh';
  return psExe;
}

export function runTests({ cwd, scope = [] }) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RUNNER, ...scope];
  const proc = spawnSync(powershellExe(), args, { cwd, encoding: 'utf8', timeout: 180_000 });
  if (proc.error) return { overall: 'crash', results: [], raw: String(proc.error) };
  const raw = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  const summary = extractJson(proc.stdout ?? '');
  if (!summary || summary.ok !== true) return { overall: 'crash', results: [], raw };
  const tests = Array.isArray(summary.tests) ? summary.tests : summary.tests ? [summary.tests] : [];
  const results = tests
    .filter((t) => t.result !== 'Skipped' && t.result !== 'NotRun')
    .map((t) => ({ name: t.name, outcome: classify(t) }));
  // no parseable test results is never a pass (P5)
  if (results.length === 0) return { overall: 'crash', results: [], raw };
  const overall = results.some((r) => r.outcome === 'crash')
    ? 'crash'
    : results.some((r) => r.outcome === 'assertion_fail')
      ? 'assertion_fail'
      : 'pass';
  return { overall, results, raw };
}

function classify(t) {
  if (t.result === 'Passed') return 'pass';
  return t.errId === 'PesterAssertionFailed' ? 'assertion_fail' : 'crash';
}

function extractJson(stdout) {
  const s = stdout.indexOf(START);
  const e = stdout.indexOf(END);
  if (s === -1 || e === -1 || e < s) return null;
  try {
    return JSON.parse(stdout.slice(s + START.length, e).trim());
  } catch {
    return null;
  }
}
