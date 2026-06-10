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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { matchesGlob } from '@sterling/schemas';

export const name = 'node';

// Optional capabilities (§9.1): static_wiring implemented (H12's static half);
// mutation deliberately absent — consuming checks record check_skipped at the
// call site, never silently pass (P5). Revisit mutation on real run data.
export const capabilities = { mutation: false, static_wiring: true };

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

/**
 * static_wiring (§9.1, H12's static half): exports declared in the scope files
 * that are referenced ONLY by test files = built-but-not-wired. Mechanical:
 * declaration regexes + word-boundary reference search over project sources.
 */
export function staticWiring({ cwd, scope = [] }) {
  const scopeSet = new Set(scope.map((p) => p.replace(/\\/g, '/')));
  const allFiles = walkSources(cwd);
  const exportsByFile = [];
  for (const file of allFiles) {
    if (!scopeSet.has(file)) continue;
    const content = readFileSync(join(cwd, file), 'utf8');
    const names = new Set();
    for (const m of content.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      names.add(m[1]);
    }
    for (const m of content.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const renamed = part.trim().match(/(?:[\w$]+\s+as\s+)?([\w$]+)\s*$/);
        if (renamed) names.add(renamed[1]);
      }
    }
    if (names.size) exportsByFile.push({ file, names: [...names] });
  }

  const isTest = (file) => testPathGlobs.some((g) => matchesGlob(file, g));
  const test_only_exports = [];
  for (const { file, names } of exportsByFile) {
    for (const exportName of names) {
      const re = new RegExp(`\\b${exportName.replace(/[$]/g, '\\$&')}\\b`);
      let nonTestRef = false;
      let testRef = false;
      for (const other of allFiles) {
        if (other === file) continue;
        if (!re.test(readFileSync(join(cwd, other), 'utf8'))) continue;
        if (isTest(other)) testRef = true;
        else {
          nonTestRef = true;
          break;
        }
      }
      if (!nonTestRef && testRef) test_only_exports.push({ file, name: exportName });
    }
  }
  return { test_only_exports };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.sterling', '.claude']);

function walkSources(cwd, dir = cwd, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walkSources(cwd, full, out);
    } else if (/\.(mjs|js|ts|tsx|jsx)$/.test(entry)) {
      out.push(relative(cwd, full).replace(/\\/g, '/'));
    }
  }
  return out;
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
