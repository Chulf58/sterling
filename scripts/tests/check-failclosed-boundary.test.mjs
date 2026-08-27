// scripts/tests/check-failclosed-boundary.test.mjs
//
// FROZEN, adversarial pins for scripts/check-failclosed-boundary.mjs — a
// script that DOES NOT EXIST YET (board 4a66ba58, "the recipe replacement"
// for anti_pattern e13f0fb5). Written BLIND to any implementation: every
// test below is derived from the dispatch brief's AC1-AC7 and the board
// item's own recipe text (both are SPEC here, not code). House style is
// drawn only from sibling TEST files — h3-failclosed-boundary.test.mjs,
// h15-failclosed-boundary.test.mjs, checks.test.mjs — never from any
// check-*.mjs source (H4 denies that read to this role, correctly).
//
// ===========================================================================
// THE TESTABILITY CONTRACT — DEFINED HERE, BINDING ON THE IMPLEMENTER.
// No override like this exists in any shipped check-*.mjs; this is the
// interface the fixture-driven tests below require, modeled on
// check-record-citations.mjs's own precedent of taking an explicit directory
// argument rather than always scanning the live repo (scripts/tests/checks.test.mjs
// calls it as `[script, dir]`).
//
//   node scripts/check-failclosed-boundary.mjs
//     [--scan-dir <dir>]   default: <repoRoot>/scripts/hooks — every *.mjs
//                          file DIRECTLY inside it (not recursive; excludes
//                          lib/, per the brief) is a candidate hook.
//     [--manifest <file>]  default: none, meaning "use the in-file hardcoded
//                          MANIFEST (AC4)". When given, a JSON file of shape
//                            { "<basename>.mjs": "blocking"|"advisory"|"exempt" }
//                          REPLACES the in-file manifest outright for this
//                          run — a basename absent from it is "absent from
//                          manifest" per AC4, exactly as a real unclassified
//                          hook would be.
//     [--baseline <file>]  default: none, meaning "use the in-file/shipped
//                          baseline (AC7)". When given, a JSON file of shape
//                            { "<basename>.mjs": [ { "statement": "<verbatim
//                              source text of the offending top-level
//                              statement, single line in every fixture
//                              below>" } ] }
//                          REPLACES the shipped baseline for this run.
//                          STATEMENT TEXT, not line number, is the stable
//                          identity the AC's "survive unrelated line shifts"
//                          requirement demands — a line-keyed baseline is
//                          exactly the hollow ratchet AC5 exists to rule out.
//   With none of the three flags given (as `npm run check` invokes it), the
//   script scans the real scripts/hooks/ using its shipped manifest and
//   shipped baseline — AC7's arm, and the only test below passing no flags.
//
//   OUTPUT FORMAT relied on below: each finding is reported on a line
//   containing "<basename>:<line>" — the same file:line idiom this repo
//   already uses (scripts/tests/checks.test.mjs asserts `/y\.mjs:1/` against
//   check-record-citations.mjs's own output). Tests match this loosely
//   (basename immediately followed by ":" and the line number as an
//   integer) rather than pinning exact prose — AC1's "statement kind" is
//   deliberately left unpinned for the same reason.
//
//   EXIT CODES relied on below (AC6): 0 = pass, non-zero = fail. No
//   particular non-zero VALUE is pinned anywhere (AC6 does not name one).
//
// A NOTED TENSION IN AC5, RESOLVED BELOW, NOT SILENTLY: AC5's first bullet
// ("observed findings that are an exact SUBSET of the baseline -> exit 0")
// read maximally would permit a baseline entry with NOTHING observed to
// match it — the literal opposite of AC5's THIRD bullet ("a baseline entry
// with NO corresponding observed finding -> NON-ZERO exit demanding the
// stale entry be deleted"), which carries its own explicit purpose clause
// ("so the baseline can only shrink and cannot rot") and is echoed by the
// AC section's own title ("EXACT-FINDING RATCHET"). The tests below pin the
// EXACT-EQUALITY reading (observed(hook) must equal baseline(hook)
// precisely, neither more nor less, to pass) and the stale-entry-fails rule
// on its own terms; they deliberately do NOT pin "a baseline strictly
// larger than observed passes", because that is the exact clause bullet 3
// contradicts. Flagging this rather than picking silently.
//
// MUTATION DESIGN ONLY — never executed here (decision 23afbc83). Each test
// names the one-line sabotage that must flip it red.
// ===========================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'check-failclosed-boundary.mjs');

function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeHook(scanDir, basename, lines) {
  writeFileSync(join(scanDir, basename), lines.join('\n') + '\n');
}

function writeJson(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function lineOf(lines, marker) {
  const i = lines.findIndex((l) => l.includes(marker));
  assert.ok(i >= 0, `fixture marker not found: ${marker}`);
  return i + 1;
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd, timeout: 120_000 });
  return {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

// Every finding for `basename` reported on the output as "<basename>:<line>".
function findingLines(output, basename) {
  const re = new RegExp(`${basename.replace(/\./g, '\\.')}:(\\d+)\\b`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(output))) out.push(Number(m[1]));
  return out;
}

// =========================================================================
// CONTROL ARMS — PLACED FIRST. Every SUBJECT below asserts a nonzero exit
// (a finding), and a checker that had degenerated into fail-everything
// would satisfy them identically. These four pass for the OPPOSITE reason:
// two clean PASSES proving the checker still has a pass surface at all
// (deny-everything has not happened), one PASS proving a non-blocking
// classification genuinely exempts a hook rather than the fixture merely
// happening to be clean, and one PASS-preceded-by-a-FAIL proving the
// baseline actually suppresses a *detected* finding by identity, not that
// detection itself is broken.
// =========================================================================

const CONTROL1_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  '',
  'let input;',
  'try {',
  '  input = 1;',
  '} catch (e) {',
  "  deny('boundary');",
  '}',
];

test('CONTROL-1: a genuinely correct BLOCKING hook (everything inside a try/catch->deny) scans clean — the checker has a pass surface, it is not deny-everything', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-control1-');
  try {
    writeHook(dir, 'ctrl1-clean.mjs', CONTROL1_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ctrl1-clean.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.equal(r.code, 0, r.out);
  } finally {
    cleanup();
  }
});
// SABOTAGE: unconditionally push one synthetic finding regardless of what
// was scanned -> CONTROL-1 red.

const CONTROL2_LINES = [
  "import { readStdin } from '../lib/common.mjs';",
  '',
  'const cfg = readStdin();',
  'if (cfg) { console.log(cfg); }',
  'class Advisory {}',
];

test('CONTROL-2: an ADVISORY hook with messy top-level statements and zero deny() calls passes cleanly — advisory classification genuinely exempts the boundary rule', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-control2-');
  try {
    writeHook(dir, 'ctrl2-advisory.mjs', CONTROL2_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ctrl2-advisory.mjs': 'advisory' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.equal(r.code, 0, r.out);
  } finally {
    cleanup();
  }
});
// SABOTAGE: apply the boundary rule to every scanned hook regardless of its
// manifest classification -> CONTROL-2 red (this file gains three findings).

const CONTROL3_LINES = [
  "import { allow, deny } from '../lib/contract.mjs';",
  '',
  'const cfg = loadConfigMaybeThrows();',
  'try {',
  '  doStuff();',
  '} catch (e) {',
  '  allow();',
  '}',
];

test("CONTROL-3: an EXEMPT hook (h24's own shape — a catch that calls allow(), never deny()) passes cleanly — the exempt classification is honored, not an accident of clean code", () => {
  const { dir, cleanup } = makeDir('sterling-fcb-control3-');
  try {
    writeHook(dir, 'ctrl3-exempt.mjs', CONTROL3_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ctrl3-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.equal(r.code, 0, r.out);
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat 'exempt' the same as 'blocking' (ignore the manifest's
// exempt entries) -> CONTROL-3 red (loadConfigMaybeThrows() and the sham
// allow()-only catch are both reported).

const CONTROL4_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  '',
  'const leaked = doInit();',
  'let input;',
  'try {',
  '  input = 1;',
  '} catch (e) {',
  "  deny('boundary');",
  '}',
];

test('CONTROL-4: a finding IS detected without a matching baseline entry (nonzero), and the SAME finding is suppressed once baselined (zero) — the baseline matches by identity, it is not that nothing was ever found', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-control4-');
  try {
    writeHook(dir, 'ctrl4-known.mjs', CONTROL4_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ctrl4-known.mjs': 'blocking' });

    const emptyBaseline = writeJson(dir, 'baseline-empty.json', {});
    const unbaselined = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', emptyBaseline], root);
    assert.notEqual(unbaselined.code, 0, 'sanity: this fixture must contain a genuine, detectable finding');

    const matchingBaseline = writeJson(dir, 'baseline-match.json', {
      'ctrl4-known.mjs': [{ statement: 'const leaked = doInit();' }],
    });
    const baselined = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', matchingBaseline], root);
    assert.equal(baselined.code, 0, `an exact baseline match must pass: ${baselined.out}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE: ignore the --baseline file entirely (the ratchet is a no-op) ->
// CONTROL-4 red on its SECOND assertion (still nonzero after baselining).
// The FIRST assertion is what stops the opposite sabotage (detection itself
// broken) from hiding behind this control.

// =========================================================================
// AC1 — BOUNDARY RULE: several guarded islands, not "the first try".
// =========================================================================

const AC1_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  '',
  'let first;',
  'try {',
  '  first = 1;',
  '} catch (e) {',
  "  deny('island A');",
  '}',
  '',
  'sideEffect();',
  '',
  'let second;',
  'try {',
  '  second = 2;',
  '} catch (e) {',
  "  deny('island B');",
  '}',
];

test('AC1: two guarded islands with an UNGUARDED statement between them — the middle statement is reported, and ONLY the middle statement', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac1-');
  try {
    writeHook(dir, 'ac1-two-islands.mjs', AC1_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ac1-two-islands.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0, 'an unbaselined finding must fail the check');
    const observed = findingLines(r.out, 'ac1-two-islands.mjs');
    assert.deepEqual(
      observed,
      [lineOf(AC1_LINES, 'sideEffect();')],
      `expected exactly one finding at the statement BETWEEN the two islands, got lines ${observed}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: stop scanning top-level statements once the FIRST try/catch->deny
// is found (treat "the first try" as the whole boundary) -> AC1 red: the
// reported finding set changes (empty, or wrongly includes island-B
// internals) instead of being exactly [sideEffect() line].

// =========================================================================
// AC2 — THE SAFE LIST IS TINY.
// =========================================================================

const AC2_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  "import { fileURLToPath } from 'node:url';",
  '',
  'function helper() { return 1; }',
  '',
  'let uninitialized;',
  '',
  'const badConst = fileURLToPath(import.meta.url);',
  'const BAD_RE = /adversarial/;',
  'class BadClass {}',
  'helper();',
  'if (uninitialized) { helper(); }',
  'await Promise.resolve();',
  '',
  'let input;',
  'try {',
  '  input = 1;',
  '} catch (e) {',
  "  deny('boundary');",
  '}',
];

test('AC2: the safe list is tiny — imports/functions/uninitialized vars pass silently; an initialized const, a regex-literal const, a class, a bare call, an if, and a top-level await are each a finding', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac2-');
  try {
    writeHook(dir, 'ac2-safelist.mjs', AC2_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ac2-safelist.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0);
    const expected = ['badConst', 'BAD_RE', 'class BadClass', 'helper();', 'if (uninitialized)', 'await Promise']
      .map((m) => lineOf(AC2_LINES, m))
      .sort((a, b) => a - b);
    const observed = findingLines(r.out, 'ac2-safelist.mjs').sort((a, b) => a - b);
    assert.deepEqual(observed, expected, `expected exactly the six adversarial statements, got lines ${observed}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE: widen the safe list to permit any top-level `const` declaration
// (not just an uninitialized `let`) -> AC2 red: badConst and BAD_RE drop out
// of the finding set while the other four remain — an asymmetric change the
// exact-set assertion catches that a bare count would not.

// =========================================================================
// AC3 — THE CATCH MUST ACTUALLY DENY.
// =========================================================================

const AC3_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  '',
  'let input;',
  'try {',
  '  input = 1;',
  '} catch (e) {',
  "  console.warn('not fail-closed', e);",
  '}',
  '',
  'afterFakeBoundary();',
];

test('AC3: a top-level try whose catch does NOT reach deny() is not credited as a fail-closed boundary — the statement after it is still a finding, or the report says no boundary was found', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac3-');
  try {
    writeHook(dir, 'ac3-fake-boundary.mjs', AC3_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ac3-fake-boundary.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0, 'a sham try (catch never reaches deny) must never be credited as satisfying the boundary rule');
    const reportedAfter = findingLines(r.out, 'ac3-fake-boundary.mjs').includes(
      lineOf(AC3_LINES, 'afterFakeBoundary();')
    );
    const noBoundaryMsg = /no fail-closed boundary/i.test(r.out);
    assert.ok(
      reportedAfter || noBoundaryMsg,
      `expected either the post-try statement reported as a finding, or an explicit "no fail-closed boundary" report; got: ${r.out}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: credit ANY top-level try/catch as a fail-closed boundary
// regardless of what its catch body does (drop the "catch reaches deny"
// check) -> AC3 red: the sham try is wrongly credited, afterFakeBoundary()
// goes unreported and no "no boundary" message appears either, so the run
// exits 0 and the assertion fails.

// =========================================================================
// AC4 — CLASSIFICATION, AND UNKNOWN SHAPES FAIL LOUDLY.
// =========================================================================

const AC4A_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  '',
  'function maybeDeny(x) {',
  '  if (x) deny("actually blocking");',
  '}',
];

test('AC4a: the manifest calls a hook "advisory" but it contains a call to the imported deny binding — the SCRIPT fails, the manifest is wrong', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac4a-');
  try {
    writeHook(dir, 'ac4a-mislabeled.mjs', AC4A_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ac4a-mislabeled.mjs': 'advisory' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0, 'advisory-but-calls-deny must fail the check');
    assert.match(r.out, /ac4a-mislabeled\.mjs/);
    assert.match(r.out, /advisory/i);
  } finally {
    cleanup();
  }
});
// SABOTAGE: only cross-check the manifest against the AST for hooks already
// classified 'blocking' (skip the check for 'advisory' entries) -> AC4a red
// (exit 0 despite the mismatch).

const AC4B_LINES = ['export const nothing = 1;'];

test('AC4b: a hook file present on disk but ABSENT from the manifest fails — a new hook is never silently skipped', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac4b-');
  try {
    writeHook(dir, 'ac4b-unclassified.mjs', AC4B_LINES);
    const manifest = writeJson(dir, 'manifest.json', {});
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0, 'an unclassified hook must fail the check');
    assert.match(r.out, /ac4b-unclassified\.mjs/);
  } finally {
    cleanup();
  }
});
// SABOTAGE: default an unrecognized basename to 'advisory' instead of
// failing -> AC4b red (exit 0, the new hook silently skipped).

test('AC4c: a manifest entry naming a file that no longer exists on disk is a STALE manifest — the script fails', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac4c-');
  try {
    const manifest = writeJson(dir, 'manifest.json', { 'ac4c-ghost.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0, 'a manifest entry for a file absent from disk must fail, not be silently ignored');
    assert.match(r.out, /ac4c-ghost\.mjs/, 'the failure must name the stale manifest entry');
  } finally {
    cleanup();
  }
});
// SABOTAGE: iterate only over files found ON DISK and never cross-check them
// against the manifest's OWN keys -> AC4c red (a ghost entry is never
// noticed, exit 0).

// =========================================================================
// AC5 — EXACT-FINDING RATCHET, NOT A COUNT.
// =========================================================================

test('AC5a: a baseline entry with NO corresponding observed finding (the old hole was fixed, nothing new appeared) fails, demanding the stale entry be deleted', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac5stale-');
  try {
    writeHook(dir, 'ac5-stale.mjs', CONTROL1_LINES); // clean file: no findings at all
    const manifest = writeJson(dir, 'manifest.json', { 'ac5-stale.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {
      'ac5-stale.mjs': [{ statement: 'const longFixedIssue = doInit();' }],
    });
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0, 'a stale baseline entry must fail the check, not silently pass');
    assert.match(r.out, /ac5-stale\.mjs/);
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat the baseline as a pure allow-list ceiling — pass whenever
// observed findings are <= baselined ones, without checking each baseline
// entry actually still has an observed match -> AC5a red (exit 0).

const AC5_SWAP_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  '',
  'const newHole = leakSomething();',
  'let input;',
  'try {',
  '  input = 1;',
  '} catch (e) {',
  "  deny('boundary');",
  '}',
];

test('AC5b [SWAP CASE]: a baselined finding is fixed but a DIFFERENT new one appears — the finding COUNT is unchanged (1 -> 1) and it must still FAIL; a count-based ratchet would wrongly pass this', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac5swap-');
  try {
    writeHook(dir, 'ac5-swap.mjs', AC5_SWAP_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ac5-swap.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {
      'ac5-swap.mjs': [{ statement: 'const oldHole = leakOldThing();' }],
    });
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0, 'a swapped finding (same count, different identity) must still fail');
    assert.match(r.out, /ac5-swap\.mjs/);
  } finally {
    cleanup();
  }
});
// SABOTAGE: replace per-hook exact-SET comparison with a per-hook COUNT
// comparison (pass if len(observed) === len(baseline[hook])) -> AC5b flips
// from fail to pass (1 === 1), and the assertion goes red. This is the
// literal defect the AC exists to prevent.

const AC5_BASE_STATEMENT = 'const known = leakKnownThing();';
function buildShifted(prefixLines) {
  return [
    ...prefixLines,
    "import { deny } from '../lib/contract.mjs';",
    '',
    AC5_BASE_STATEMENT,
    'let input;',
    'try {',
    '  input = 1;',
    '} catch (e) {',
    "  deny('boundary');",
    '}',
  ];
}

test('AC5c: an unrelated statement shifting the SAME finding to a different line neither makes it "new" nor makes the baseline entry "stale" — identity is not keyed by line number', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac5shift-');
  try {
    const manifest = writeJson(dir, 'manifest.json', { 'ac5-shift.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {
      'ac5-shift.mjs': [{ statement: AC5_BASE_STATEMENT }],
    });

    writeHook(dir, 'ac5-shift.mjs', buildShifted([]));
    const before = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.equal(before.code, 0, `unshifted baseline match should pass: ${before.out}`);

    writeHook(dir, 'ac5-shift.mjs', buildShifted(['// an unrelated comment', '// two lines of preamble']));
    const after = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.equal(after.code, 0, `the SAME finding two lines lower must still match the unchanged baseline: ${after.out}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE: key findings by (basename, line) instead of (basename, statement
// text) -> the second assertion goes red (the shifted finding reads as both
// "new" and the old line as "stale").

// =========================================================================
// AC6 — REPORTING.
// =========================================================================

const AC6_H1_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  '',
  'const firstLeak = leakOne();',
  'let input;',
  'try {',
  '  input = 1;',
  '} catch (e) {',
  "  deny('boundary');",
  '}',
];
const AC6_H2_LINES = [
  "import { deny } from '../lib/contract.mjs';",
  '',
  'const secondLeak = leakTwo();',
  'let input;',
  'try {',
  '  input = 1;',
  '} catch (e) {',
  "  deny('boundary');",
  '}',
];

test('AC6a: violations across MULTIPLE hooks are ALL collected in one run — the script does not die on the first', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac6multi-');
  try {
    writeHook(dir, 'ac6-first.mjs', AC6_H1_LINES);
    writeHook(dir, 'ac6-second.mjs', AC6_H2_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ac6-first.mjs': 'blocking', 'ac6-second.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0);
    assert.ok(findingLines(r.out, 'ac6-first.mjs').length >= 1, `expected ac6-first.mjs findings in: ${r.out}`);
    assert.ok(findingLines(r.out, 'ac6-second.mjs').length >= 1, `expected ac6-second.mjs findings in: ${r.out}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE: exit immediately after reporting the FIRST file's violation
// (die on first) -> AC6a red — the second file's finding never appears
// because the process exited before it was scanned.

test('AC6b: while the baseline is non-empty, a passing run prints the remaining baselined-debt COUNT', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac6debt-');
  try {
    writeHook(dir, 'ac6-debt-a.mjs', AC6_H1_LINES);
    writeHook(dir, 'ac6-debt-b.mjs', AC6_H2_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ac6-debt-a.mjs': 'blocking', 'ac6-debt-b.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {
      'ac6-debt-a.mjs': [{ statement: 'const firstLeak = leakOne();' }],
      'ac6-debt-b.mjs': [{ statement: 'const secondLeak = leakTwo();' }],
    });
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.equal(r.code, 0, `an exact two-entry baseline match must pass: ${r.out}`);
    assert.match(r.out, /\b2\b/, 'the remaining debt count (2) must be printed');
    assert.match(r.out, /debt|baselined|known-open/i, 'the count must be presented as debt, not an unlabeled number');
  } finally {
    cleanup();
  }
});
// SABOTAGE: only print the debt-count line on a FAILING run, never on a
// passing one -> AC6b red (the message is absent from this exit-0 run).

const AC6_MALFORMED_LINES = ['function broken( {', '  return'];

test('AC6c: a malformed/unparseable hook file fails LOUDLY — never an uncaught crash, and never silently passed', () => {
  const { dir, cleanup } = makeDir('sterling-fcb-ac6malformed-');
  try {
    writeHook(dir, 'ac6-malformed.mjs', AC6_MALFORMED_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'ac6-malformed.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const r = run(['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline], root);
    assert.notEqual(r.code, 0, 'a malformed file must never be silently passed');
    assert.equal(r.signal, null, 'the process must exit cleanly, never be killed by a signal');
    assert.doesNotMatch(r.out, /\n\s+at\s+\S+\s*\(/, 'a raw Node stack trace is a CRASH, not a loud, actionable failure');
    assert.match(r.out, /ac6-malformed\.mjs/, 'the failure must name the offending file');
  } finally {
    cleanup();
  }
});
// SABOTAGE: remove the try/catch around each per-file parse call, letting a
// genuinely unparseable file throw uncaught out of the whole process ->
// AC6c red (r.out gains a raw stack-frame line matching the doesNotMatch
// regex).

// =========================================================================
// AC7 — REAL-REPO ARM.
// =========================================================================

test("AC7: the real repo at HEAD passes — the shipped baseline covers exactly today's known-open set (invoked with no flags, cwd = repo root, as npm run check would)", () => {
  const r = run([], root);
  assert.equal(r.code, 0, `expected the real-repo scan to pass at HEAD; got: ${r.out}`);
});
// SABOTAGE: empty the shipped baseline (or point the default --scan-dir at
// scripts/hooks/lib/ instead of scripts/hooks/) -> AC7 red, since the nine
// known-open hooks (h4-read-wall, h14-bash-allowlist, h5-frozen-tests,
// h18-test-write-wall, h8-dispatch-cap, h9-stop-backstop, h20-mechanism-axis,
// h10-direct-capture, h6-context-watch) would then report as unbaselined.
