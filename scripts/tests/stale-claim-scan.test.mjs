// Tests for the stale-claim scan (board fd8d081c). The point of this suite is
// BOTH directions: it must fire on the real pattern (sensitivity) and stay quiet
// on the two false-positive classes measured 2026-08-03, when the first version
// scored precision 0/16 over five real diffs of this repo (specificity). A scan
// that is silent because it matches nothing is worse than useless — it is
// reassuring — so the true-positive case is the first test here on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanStaleClaims,
  symbolsCalledIn,
  absenceClaimsIn,
  declaredSymbolsIn,
  looksLikeSymbol,
  stripStringLiterals,
  STALE_CLAIM_OPT_OUT,
} from '../lib/stale-claim-scan.mjs';

function harness({ files = {}, diff = [], isTest = () => false, capability = true }) {
  return scanStaleClaims({
    diff,
    candidates: Object.keys(files),
    readFile: (p) => files[p] ?? null,
    isTest,
    capability,
  });
}

test('SENSITIVITY: a new caller for a declared symbol flags another file comment claiming it is unwired', () => {
  const files = {
    'src/economy.mjs': 'export function broadcast_trade_signal(x) { return x; }\n',
    'src/header.mjs': '// broadcast_trade_signal is not yet wired to the economy loop\nexport const a = 1;\n',
  };
  const diff = [{ path: 'src/farm.mjs', added_lines: ['  broadcast_trade_signal(signal);'] }];
  const { findings, symbols_added } = harness({ files, diff });
  assert.deepEqual(symbols_added, ['broadcast_trade_signal']);
  assert.equal(findings.length, 1, 'the stale header must be reported');
  assert.equal(findings[0].path, 'src/header.mjs');
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].symbol, 'broadcast_trade_signal');
  assert.equal(findings[0].marker, 'not yet');
});

test('SENSITIVITY: camelCase symbols are caught too, and the line number is exact', () => {
  const files = {
    'a.mjs': 'export function staticWiring() {}\n',
    'b.mjs': '// line one\n// line two\n// staticWiring is not implemented for this adapter\n',
  };
  const diff = [{ path: 'c.mjs', added_lines: ['const r = staticWiring({ cwd });'] }];
  const { findings } = harness({ files, diff });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
});

test('SPECIFICITY 1: an everyday word that is also a function name raises nothing (the `test(` case)', () => {
  // Measured false positive: `test(` from node:test made every comment containing
  // the word "test" a finding. `test` carries no snake_case and no internal capital.
  const files = {
    'x.mjs': '// completeness and test-integrity are not built — skipped loudly\nexport const q = 1;\n',
  };
  const diff = [{ path: 'y.test.mjs', added_lines: ["test('does a thing', () => {});"] }];
  const { findings, symbols_added } = harness({ files, diff });
  assert.deepEqual(symbols_added, [], 'a bare lowercase dictionary word is not a symbol');
  assert.equal(findings.length, 0);
});

test('SPECIFICITY 2: an identifier inside a string literal raises nothing (the `loudly` case)', () => {
  // Measured false positive: a test title '… skipped loudly (P5)' yielded `loudly`.
  const files = { 'x.mjs': '// the artifact-write binding is not built yet — skipped loudly\n' };
  const diff = [{ path: 'y.mjs', added_lines: ["assert.match(out, /skipped loudly (P5)/);", "log('refuse boot loudly (P5)');"] }];
  const { findings } = harness({ files, diff });
  assert.equal(findings.length, 0);
});

test('SPECIFICITY 3: a symbol the repo never declares cannot be the subject of a stale claim', () => {
  const files = { 'x.mjs': '// some_third_party is not yet available here\n' };
  const diff = [{ path: 'y.mjs', added_lines: ['some_third_party(1);'] }];
  const { findings, symbols_added } = harness({ files, diff });
  assert.deepEqual(symbols_added, [], 'undeclared symbols are dropped');
  assert.equal(findings.length, 0);
});

test('a caller added in a TEST file is not wiring landing', () => {
  const files = {
    'a.mjs': 'export function my_thing() {}\n',
    'b.mjs': '// my_thing is not wired yet\n',
  };
  const diff = [{ path: 'a.test.mjs', added_lines: ['my_thing();'] }];
  const { findings } = harness({ files, diff, isTest: (p) => p.endsWith('.test.mjs') });
  assert.equal(findings.length, 0);
});

test('a call inside a comment is not wiring landing', () => {
  const files = {
    'a.mjs': 'export function my_thing() {}\n',
    'b.mjs': '// my_thing is not wired yet\n',
  };
  const diff = [{ path: 'c.mjs', added_lines: ['// later: my_thing(x) once it exists'] }];
  const { findings } = harness({ files, diff });
  assert.equal(findings.length, 0);
});

test(`the ${STALE_CLAIM_OPT_OUT} marker suppresses a genuine exception`, () => {
  const files = {
    'a.mjs': 'export function my_thing() {}\n',
    'b.mjs': `// my_thing is not yet wired for the legacy path (${STALE_CLAIM_OPT_OUT})\n`,
  };
  const diff = [{ path: 'c.mjs', added_lines: ['my_thing();'] }];
  const { findings } = harness({ files, diff });
  assert.equal(findings.length, 0);
});

test('non-comment code containing an absence phrase is never a claim', () => {
  const files = {
    'a.mjs': 'export function my_thing() {}\n',
    'b.mjs': 'const msg = "my_thing is not yet wired";\n',
  };
  const diff = [{ path: 'c.mjs', added_lines: ['my_thing();'] }];
  const { findings } = harness({ files, diff });
  assert.equal(findings.length, 0, 'only comment lines carry claims');
});

test('an absent adapter capability SKIPS LOUDLY and is not a pass', () => {
  const { findings, skipped } = harness({ files: {}, diff: [], capability: false });
  assert.deepEqual(findings, []);
  assert.ok(skipped, 'skipped must be reported, never null');
  assert.match(skipped.reason, /^capability_absent:/);
});

test('unit: looksLikeSymbol accepts code-shaped names and rejects dictionary words', () => {
  for (const ok of ['broadcast_trade_signal', 'staticWiring', 'my_thing', '$scope_x']) {
    assert.equal(looksLikeSymbol(ok), true, `${ok} should be symbol-shaped`);
  }
  for (const no of ['test', 'write', 'source', 'refuse', 'loudly', 'value']) {
    assert.equal(looksLikeSymbol(no), false, `${no} should NOT be symbol-shaped`);
  }
});

test('unit: stripStringLiterals removes single, double and backtick contents', () => {
  assert.equal(stripStringLiterals(`a('x(') + b("y(") + c(\`z(\`)`), 'a("") + b("") + c("")');
});

test('unit: declaredSymbolsIn finds declarations and export lists', () => {
  const d = declaredSymbolsIn('export function alpha_one() {}\nconst beta_two = 1;\nexport { gamma_three as g };\nclass delta_four {}\n');
  for (const n of ['alpha_one', 'beta_two', 'gamma_three', 'delta_four']) assert.ok(d.has(n), `${n} missing`);
});

test('unit: absenceClaimsIn requires marker and symbol on the SAME line', () => {
  const text = '// my_thing does the work\n// something else is not yet wired\n';
  assert.equal(absenceClaimsIn(text, new Set(['my_thing'])).length, 0, 'split across lines must not match');
});

test('unit: symbolsCalledIn ignores language keywords', () => {
  const s = symbolsCalledIn(['if (x) { while (y) { switch (z) {} } }']);
  assert.deepEqual([...s], []);
});
