// node toolchain adapter (spec §9.1) — core capability only: run tests over a
// scope and classify every result as pass | assertion_fail | crash. The red
// check's "fails on its assertions, not crashes" distinction happens HERE,
// never by an agent reading raw runner output.
//
// Classification (probe-verified on Node 24 TAP output):
//   not ok + code 'ERR_ASSERTION'  -> assertion_fail
//   not ok + anything else         -> crash (throws, syntax errors, file-level failures)
//   spawn failure / no TAP results -> crash
import { spawnSync } from 'node:child_process';

export const name = 'node';

// Optional capabilities (§9.1): declared absent — consuming checks must record
// check_skipped at their call sites, never silently pass (P5).
export const capabilities = { mutation: false, static_wiring: false };

// The single definition of "what is a test file" — consumed by H4's read wall
// and H5's test freeze. Baked into project config at init.
export const testPathGlobs = ['**/*.test.mjs', '**/*.test.js', '**/*.test.ts', 'tests/**', 'test/**'];

// Declared run commands — init bakes these into code-touching agents' Bash
// allowlists (H14, §7.1).
export const runCommands = { test: 'node --test' };

export function runTests({ cwd, scope = [] }) {
  const args = ['--test', '--test-reporter', 'tap', ...scope];
  // Sanitize: if the adapter itself runs under a node test runner (checks do),
  // NODE_TEST_CONTEXT leaks into the child and silently switches its output
  // protocol — classification would misread every result.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const proc = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120_000, env });
  if (proc.error) {
    return { overall: 'crash', results: [], raw: String(proc.error) };
  }
  const raw = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  const results = parseTap(proc.stdout ?? '');
  if (results.length === 0) {
    // no parseable test results is never a pass (P5)
    return { overall: 'crash', results: [], raw };
  }
  const overall = results.some((r) => r.outcome === 'crash')
    ? 'crash'
    : results.some((r) => r.outcome === 'assertion_fail')
      ? 'assertion_fail'
      : 'pass';
  return { overall, results, raw };
}

function parseTap(stdout) {
  const lines = stdout.split(/\r?\n/);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(not )?ok \d+ - (.+?)(?: # .*)?$/);
    if (!m) continue;
    const [, notOk, testName] = m;
    if (!notOk) {
      results.push({ name: testName, outcome: 'pass' });
      continue;
    }
    let outcome = 'crash';
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
      const code = lines[j].match(/^\s+code:\s*'([^']+)'/);
      if (code) {
        outcome = code[1] === 'ERR_ASSERTION' ? 'assertion_fail' : 'crash';
        break;
      }
    }
    results.push({ name: testName, outcome });
  }
  return results;
}
