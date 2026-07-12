// node toolchain adapter (spec §9.1) — core capability only: run tests over a
// scope and classify every result as pass | assertion_fail | crash. The red
// check's "fails on its assertions, not crashes" distinction happens HERE,
// never by an agent reading raw runner output.
//
// Classification (probe-verified on Node 24 TAP output):
//   not ok + code 'ERR_ASSERTION'  -> assertion_fail
//   not ok + anything else         -> crash (throws, syntax errors, file-level failures)
//   spawn failure / no TAP results -> crash
//
// TS-source scope (packages/<pkg>/src/**.test.ts) is BUILT and run from dist:
// the package tsconfig is Node16, so tests import siblings via `.js` specifiers
// that only resolve under dist — running the .ts directly fails to LOAD (a false
// crash). We compile each owning package once, then run its dist .test.js.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
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
  // TS-source test files (src/**.test.ts) must be built and run from dist (see
  // header); .mjs / compiled .js pass through unchanged. A build failure is a
  // legitimate crash — fail loud (P5), don't run against stale dist.
  const remapped = buildAndRemapTsScope(cwd, scope);
  if (remapped.buildOutput != null) {
    return { overall: 'crash', results: [], raw: remapped.buildOutput };
  }
  const args = ['--test', '--test-reporter', 'tap', ...remapped.scope];
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
 * Build every package owning a TS-source test in `scope`, then remap those
 * paths to their dist equivalents (the owning package's leading `src/` ->
 * `dist/`, trailing `.ts` -> `.js`). Non-TS / non-src paths pass through
 * untouched. Returns the rewritten scope; on a compile failure returns
 * `buildOutput` (non-null) so the caller surfaces a crash (P5). A TS path with
 * no owning tsconfig falls through unbuilt — it runs directly and fails
 * naturally.
 */
function buildAndRemapTsScope(cwd, scope) {
  const isTsSource = (p) => /(?:^|\/)src\//.test(p) && p.endsWith('.ts');
  const tsScope = scope.filter(isTsSource);
  if (tsScope.length === 0) return { scope };

  // Distinct owning package dirs (nearest ancestor with a tsconfig.json),
  // built once each.
  const pkgDirs = new Set();
  const ownerOf = new Map();
  for (const p of tsScope) {
    const pkgDir = findPackageDir(cwd, p);
    ownerOf.set(p, pkgDir);
    if (pkgDir) pkgDirs.add(pkgDir);
  }
  for (const pkgDir of pkgDirs) {
    // Run the compiler's JS entry through node — NOT the extensionless .bin/tsc
    // shim, which ENOENTs on native Windows (needs tsc.cmd). This form is
    // inherently cross-platform: no shell, no shim, no platform branch.
    const tsc = join(cwd, 'node_modules', 'typescript', 'bin', 'tsc');
    const build = spawnSync(process.execPath, [tsc, '-p', join(pkgDir, 'tsconfig.json')], { cwd, encoding: 'utf8', timeout: 120_000 });
    if (build.error) return { scope, buildOutput: String(build.error) };
    if (build.status !== 0) return { scope, buildOutput: `${build.stdout ?? ''}\n${build.stderr ?? ''}` };
  }

  // Anchor the remap to the OWNING pkgDir, not the first `/src/` in the path: a
  // `src` segment ABOVE the package (app/src/feature/src/x.test.ts owned by the
  // inner tsconfig) would otherwise rewrite the wrong segment. Strip only the
  // leading `src/` of the pkgDir-relative portion.
  const remapped = scope.map((p) => {
    const pkgDir = isTsSource(p) ? ownerOf.get(p) : null;
    if (!pkgDir) return p;
    const rel = (pkgDir === '.' ? p : p.slice(pkgDir.length + 1)).replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
    return pkgDir === '.' ? rel : `${pkgDir}/${rel}`;
  });
  return { scope: remapped };
}

// Nearest ancestor directory of `file` (under cwd) containing a tsconfig.json,
// returned cwd-relative POSIX; null if none.
function findPackageDir(cwd, file) {
  let dir = dirname(file);
  while (dir && dir !== '.' && dir !== '/') {
    if (existsSync(join(cwd, dir, 'tsconfig.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return existsSync(join(cwd, 'tsconfig.json')) ? '.' : null;
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

// Parse `node --test` TAP HIERARCHICALLY (audit finding 8/43, probe-verified on
// Node 24.14): a test inside describe()/subtests emits an INDENTED `ok`/`not ok`
// line carrying its own YAML diagnostic (type: 'test'), while the enclosing
// describe emits a top-level aggregate line (type: 'suite', code:
// 'ERR_TEST_FAILURE') whose failure merely means "a subtest failed". The prior
// parser matched only unindented lines and read the suite's ERR_TEST_FAILURE, so
// a describe-nested assertion failure (a valid TDD red) was misclassified as a
// crash. We now classify each LEAF test from its own block and skip suite
// aggregates. Discriminator is `type`, not `code`: a leaf THROW also carries
// ERR_TEST_FAILURE, so code alone cannot tell a crashing leaf from a suite.
function parseTap(stdout) {
  const lines = stdout.split(/\r?\n/);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(not )?ok \d+ - (.+?)(?: # .*)?$/);
    if (!m) continue;
    const [, , notOk, testName] = m;

    // Read this line's own YAML diagnostic block, fenced by '---' lines indented
    // beyond the ok line. type/code inside identify a leaf vs a suite aggregate.
    let type;
    let code;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j < lines.length && lines[j].trim() === '---') {
      const fenceIndent = lines[j].length - lines[j].trimStart().length;
      // TAP YAML diagnostics open with '---' and CLOSE with '...' (the YAML
      // end marker) at the same indent — not a second '---'. Reading to the
      // wrong marker would run into the next test's block.
      for (j++; j < lines.length; j++) {
        const line = lines[j];
        const trimmed = line.trim();
        if ((trimmed === '...' || trimmed === '---') && line.length - line.trimStart().length === fenceIndent) break;
        const t = line.match(/^\s+type:\s*'([^']+)'/);
        if (t) type = t[1];
        const c = line.match(/^\s+code:\s*'([^']+)'/);
        if (c) code = c[1];
      }
    }

    // Suite aggregates derive their outcome from children already parsed — skip
    // them so ERR_TEST_FAILURE (pass or fail) never pollutes classification.
    if (type === 'suite') continue;
    if (!notOk) {
      results.push({ name: testName, outcome: 'pass' });
      continue;
    }
    results.push({ name: testName, outcome: code === 'ERR_ASSERTION' ? 'assertion_fail' : 'crash' });
  }
  return results;
}
