// run-gate.mjs tests (board babf3a9e) — SPEC ONLY, red-first.
// Governing decision: knowledge_get 98549344-e355-42da-93dd-ce7c2dc4dfcb
// (slug toolchain-success-predicates-run-gate).
//
// Measured defect this exists for (consuming-project retro 2026-08-17):
// Blender exited 0 after a genuine export failure and the gate stayed green
// on a broken artifact ("the Blender-class case", exercised below as the
// output_regex_absent test). scripts/run-gate.mjs does not exist yet, so
// EVERY test below is red today: node fails to resolve the missing module
// and exits non-zero with a module-resolution error on stderr, which is why
// every test asserts on SPECIFIC stderr/stdout content (not bare exit-code
// polarity alone) — a module-not-found exit is non-zero, which would
// trivially (and wrongly) satisfy a bare "exits non-zero" assertion, so the
// content assertion is what keeps each test honestly red for the right
// reason and honestly green only once run-gate actually behaves as specced.
//
// Contract under test: `node scripts/run-gate.mjs <command_key>`, run with
// cwd inside a Sterling project (temp dir holding .sterling/config.json only
// — no store.db; the contract never mentions the store). It resolves
// config.toolchains[].run_commands[<command_key>], executes it via the shell
// in cwd, and judges SUCCESS = (child exit 0) AND (every declared criterion
// in config.toolchains[].success_predicates[<command_key>]). On failure it
// exits non-zero with a verdict on stderr naming exactly which criterion
// failed (or that the exit code itself was non-zero); with no predicate
// declared, exit code alone governs and the verdict says so explicitly. An
// unknown command_key is a loud non-zero refusal naming the declared keys.
// The child's own stdout/stderr passes through to run-gate's own streams.
//
// Toolchain shape (adapter/path_globs/test_globs/run_commands) mirrors
// scripts/tests/h14-robustness.test.mjs's CONFIG precedent; success_predicates
// lives ALONGSIDE run_commands on the same toolchain entry, keyed by the same
// run_command key (never nested inside the run_commands string value — that
// would break H14's Object.values flatMap, per the governing decision).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_GATE = join(root, 'scripts', 'run-gate.mjs');

function makeProject(config) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-run-gate-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  return dir;
}

function runGate(commandKey, cwd) {
  const r = spawnSync(process.execPath, [RUN_GATE, commandKey], {
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function projectWith(run_commands, success_predicates) {
  const toolchain = {
    adapter: 'node',
    path_globs: ['**/*.mjs'],
    test_globs: ['**/*.test.mjs'],
    run_commands,
  };
  if (success_predicates) toolchain.success_predicates = success_predicates;
  return makeProject({ toolchains: [toolchain] });
}

// ---------------------------------------------------------------------------

test('exit-0 child, no predicates declared for the key: run-gate exits 0 and the verdict states exit-code-only governance', () => {
  const dir = projectWith({ build: `node -e "console.log('BUILD OK'); process.exit(0)"` });
  const r = runGate('build', dir);
  assert.equal(r.code, 0, `expected success; stderr: ${r.stderr}`);
  assert.match(
    r.stdout + r.stderr,
    /exit code alone governs/i,
    'no predicate declared for "build" — the verdict must say exit code alone governs, explicitly'
  );
});

test('exit-0 child, a declared output_regex that matches the combined output: exit 0', () => {
  const dir = projectWith(
    { build: `node -e "console.log('BUILD OK'); process.exit(0)"` },
    { build: { output_regex: 'BUILD OK' } }
  );
  const r = runGate('build', dir);
  assert.equal(r.code, 0, `expected success; stderr: ${r.stderr}`);
});

test('THE MEASURED CLASS: exit-0 child whose output matches a declared output_regex_absent — run-gate exits non-zero, verdict names output_regex_absent (the Blender case: exit 0 on a genuinely broken export)', () => {
  const dir = projectWith(
    { export: `node -e "console.log('Error: export failed'); process.exit(0)"` },
    { export: { output_regex_absent: 'Error: export failed' } }
  );
  const r = runGate('export', dir);
  assert.notEqual(r.code, 0, 'a child that printed the forbidden error text must not read as success even though it exited 0');
  assert.match(r.stderr, /output_regex_absent/i, 'the verdict names output_regex_absent as the failing criterion');
});

test('exit-0 child, a declared output_regex that does NOT match: non-zero, verdict names output_regex', () => {
  const dir = projectWith(
    { build: `node -e "console.log('something else entirely'); process.exit(0)"` },
    { build: { output_regex: 'BUILD OK' } }
  );
  const r = runGate('build', dir);
  assert.notEqual(r.code, 0, 'the declared output_regex never matched — this must fail the gate');
  assert.match(r.stderr, /\boutput_regex\b/, 'the verdict names output_regex as the failing criterion (not output_regex_absent)');
});

test('exit-0 child, a declared artifact whose file is missing: non-zero, verdict names the artifact path', () => {
  const dir = projectWith(
    { build: `node -e "process.exit(0)"` },
    { build: { artifact: { path: 'dist/ghost.bin' } } }
  );
  const r = runGate('build', dir);
  assert.notEqual(r.code, 0, 'the declared artifact was never written — this must fail the gate');
  assert.match(r.stderr, /dist\/ghost\.bin/, 'the verdict names the missing artifact path');
});

test('artifact present but under min_bytes: non-zero naming min_bytes; the same artifact at/over min_bytes: exit 0', () => {
  const under = projectWith(
    { build: `node -e "require('fs').writeFileSync('out.bin', Buffer.alloc(10))"` },
    { build: { artifact: { path: 'out.bin', min_bytes: 20 } } }
  );
  const rUnder = runGate('build', under);
  assert.notEqual(rUnder.code, 0, 'a 10-byte artifact fails a min_bytes:20 predicate');
  assert.match(rUnder.stderr, /min_bytes/i, 'the verdict names min_bytes as the failing criterion');

  const atLeast = projectWith(
    { build: `node -e "require('fs').writeFileSync('out.bin', Buffer.alloc(20))"` },
    { build: { artifact: { path: 'out.bin', min_bytes: 20 } } }
  );
  const rOk = runGate('build', atLeast);
  assert.equal(rOk.code, 0, `a 20-byte artifact must satisfy min_bytes:20 (>=, not strictly >); stderr: ${rOk.stderr}`);
});

test('artifact predicate with no min_bytes declared: presence alone is sufficient, even for a zero-byte file', () => {
  const dir = projectWith(
    { build: `node -e "require('fs').writeFileSync('out.bin', Buffer.alloc(0))"` },
    { build: { artifact: { path: 'out.bin' } } }
  );
  const r = runGate('build', dir);
  assert.equal(r.code, 0, `min_bytes is optional — a present zero-byte file must satisfy a bare {path} artifact criterion; stderr: ${r.stderr}`);
});

test('non-zero child exit fails the gate even when every declared predicate passes — exit code AND predicates, never predicate-overrides-exit', () => {
  const dir = projectWith(
    { build: `node -e "console.log('BUILD OK'); process.exit(3)"` },
    { build: { output_regex: 'BUILD OK' } }
  );
  const r = runGate('build', dir);
  assert.notEqual(r.code, 0, 'the child exited 3 — a passing predicate never overrides a failing exit code');
  assert.match(r.stdout, /BUILD OK/, "the child's own output is still passed through even though the overall run failed");
  assert.match(r.stderr, /exit code/i, 'the verdict names the exit code itself as a failing criterion');
});

test('an unknown command_key is a loud non-zero refusal naming the declared keys', () => {
  const dir = projectWith({
    build: `node -e "process.exit(0)"`,
    check: `node -e "process.exit(0)"`,
  });
  const r = runGate('deploy', dir);
  assert.notEqual(r.code, 0, 'a command_key with no run_commands entry must be refused, never silently run or silently succeed');
  assert.match(r.stderr, /build/, 'the refusal names the declared key "build"');
  assert.match(r.stderr, /check/, 'the refusal names the declared key "check"');
});

test('a corrupt config.json is a loud non-zero refusal, never a silent green', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-run-gate-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{ this is not valid json');
  const r = runGate('build', dir);
  assert.notEqual(r.code, 0, 'an unparseable config.json must refuse loud, not default to a silent success');
  assert.match(r.stderr, /config/i, 'the refusal mentions the config it could not read/parse');
});

test("the child's own stdout is passed through to run-gate's stdout (a human still sees the tool's output)", () => {
  const dir = projectWith({ build: `node -e "console.log('PASSTHROUGH-MARKER-7f3a'); process.exit(0)"` });
  const r = runGate('build', dir);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /PASSTHROUGH-MARKER-7f3a/, "the child's stdout marker must appear in run-gate's own stdout");
});

// ---------------------------------------------------------------------------
// Review findings pinned below (board babf3a9e, governing decision
// knowledge_get 98549344-e355-42da-93dd-ce7c2dc4dfcb). ADD-ONLY: nothing
// above this line was touched. A fixer is landing the corresponding repairs
// in parallel — see each test's own EXPECTED FAILURE SHAPE comment for what
// is red today vs. what turns green once the fix lands.
// ---------------------------------------------------------------------------

test('D1 (review finding): output_regex_absent must not be defeated by stdout truncation on large output — a small maxBuffer would silently drop the forbidden marker and wrongly pass', () => {
  const fillerChars = 1_700_000; // > 1.5MB of filler, comfortably past node's spawnSync default 1MB maxBuffer
  const dir = projectWith(
    { export: `node -e "process.stdout.write('x'.repeat(${fillerChars})); console.log('Error: export failed'); process.exit(0)"` },
    { export: { output_regex_absent: 'Error: export failed' } }
  );
  const r = runGate('export', dir);
  // EXPECTED FAILURE SHAPE (pre-fix, this is the measured D1 defect): with a
  // ~1MB maxBuffer, the forbidden marker sits past the truncation point, so
  // run-gate's captured output never contains it — the predicate wrongly
  // reads as satisfied and r.code comes back 0, so assert.notEqual(r.code, 0)
  // is the assertion that fires. Once the fix raises maxBuffer to 64MB, the
  // marker survives capture and both assertions below pass.
  assert.notEqual(r.code, 0, 'a >1.5MB-prefixed forbidden marker must still fail the gate — a small maxBuffer must never silently truncate it away into a false pass');
  assert.match(r.stderr, /output_regex_absent/i, 'the verdict names output_regex_absent as the failing criterion even with 1.5MB+ of preceding filler output');
});

test('D2 (review finding): a mis-shaped success_predicates entry (a criterion nested at the top level instead of inside an artifact object) is refused, never silently accepted or silently ignored', () => {
  const misNested = projectWith(
    { export: `node -e "process.exit(0)"` },
    { export: { min_bytes: 5 } } // WRONG SHAPE: min_bytes belongs inside artifact:{...}, not floating at this level
  );
  const r1 = runGate('export', misNested);
  // EXPECTED FAILURE SHAPE (pre-fix): if the runner trusts the zod schema
  // alone and the schema (or the runner's own reading of it) does not reject
  // this shape, min_bytes:5 is silently read as "no recognized criterion" and
  // the key governs by exit code alone (r.code 0) — assert.notEqual(r1.code, 0)
  // fires, or the stderr prefix assertion fires if some other non-zero path
  // is taken without the exact refusal wording.
  assert.notEqual(r1.code, 0, 'a mis-shaped predicate (min_bytes floating at the criterion level) must be refused, not silently run as if no predicate were declared');
  assert.ok(r1.stderr.startsWith('run-gate: invalid success_predicates'), `stderr must start with the exact refusal prefix; got: ${JSON.stringify(r1.stderr.slice(0, 80))}`);

  const emptyCriterion = projectWith(
    { export: `node -e "process.exit(0)"` },
    { export: {} } // WRONG: no criterion declared at all — not "no predicate", a malformed one
  );
  const r2 = runGate('export', emptyCriterion);
  // EXPECTED FAILURE SHAPE (pre-fix): same class as above — an empty
  // criterion object for a declared key must be refused independently of
  // whatever the zod schema allows (belt-and-suspenders per the task); before
  // the runner-side validation lands this likely reads as exit-code-only
  // governance (r2.code 0), failing assert.notEqual(r2.code, 0).
  assert.notEqual(r2.code, 0, 'an empty criterion object for a declared key must be refused — the runner validates shape independently of the zod schema');
  assert.ok(r2.stderr.startsWith('run-gate: invalid success_predicates'), `stderr must start with the exact refusal prefix; got: ${JSON.stringify(r2.stderr.slice(0, 80))}`);
});

test('D3 (review finding): an empty-string criterion value (output_regex_absent: "") is refused, never silently treated as "no constraint"', () => {
  const dir = projectWith(
    { export: `node -e "process.exit(0)"` },
    { export: { output_regex_absent: '' } }
  );
  const r = runGate('export', dir);
  // EXPECTED FAILURE SHAPE (pre-fix): an empty string is falsy-ish but not
  // undefined, so a naive `if (criterion.output_regex_absent)` guard skips
  // it silently (treats it as absent) and the key governs by exit code alone
  // — r.code comes back 0, failing assert.notEqual(r.code, 0) below.
  assert.notEqual(r.code, 0, 'an empty-string criterion must be refused rather than silently skipped (an empty regex trivially matches everything — the opposite of a no-op)');
  assert.ok(r.stderr.startsWith('run-gate: invalid success_predicates'), `stderr must start with the exact refusal prefix; got: ${JSON.stringify(r.stderr.slice(0, 80))}`);
});

test('G1 (review finding): a success_predicates entry with no matching run_commands key is an orphan predicate — refused for EVERY key on that project, never silently ignored', () => {
  const dir = projectWith(
    { check: `node -e "process.exit(0)"` }, // no "build" entry in run_commands — the orphan
    { build: { output_regex: 'anything' } } // predicate declared for a key that has no command
  );

  // Invoking the orphaned key itself:
  const rBuild = runGate('build', dir);
  // EXPECTED FAILURE SHAPE (pre-fix): if orphan predicates are never
  // validated, run-gate falls through to "unknown command_key" handling
  // (a different, pre-existing refusal) rather than the D-series exact
  // "run-gate: invalid success_predicates" prefix — the startsWith assertion
  // fires even though r.code is already non-zero for the wrong reason.
  assert.notEqual(rBuild.code, 0, 'invoking a key whose only trace is an orphan predicate must be refused');
  assert.ok(rBuild.stderr.startsWith('run-gate: invalid success_predicates'), `stderr must start with the exact refusal prefix; got: ${JSON.stringify(rBuild.stderr.slice(0, 80))}`);
  assert.match(rBuild.stderr, /build/, 'the refusal names the orphaned key "build"');

  // Invoking a wholly unrelated, otherwise-valid key on the SAME project must
  // refuse identically — the config as a whole is invalid, not just the
  // "build" invocation, proving this is config-wide validation.
  const rCheck = runGate('check', dir);
  // EXPECTED FAILURE SHAPE (pre-fix): if validation is done lazily per
  // invoked key (checking only whether ITS run_commands/predicates line up),
  // invoking "check" — which has a real run_commands entry and no predicate
  // of its own — would succeed (r.code 0), failing assert.notEqual below.
  // This is exactly the case that pins "ANY key refuses", not just the
  // orphaned one.
  assert.notEqual(rCheck.code, 0, 'an orphan predicate anywhere in success_predicates invalidates the whole config — invoking an unrelated valid key must still refuse');
  assert.ok(rCheck.stderr.startsWith('run-gate: invalid success_predicates'), `stderr must start with the exact refusal prefix; got: ${JSON.stringify(rCheck.stderr.slice(0, 80))}`);
});

test('G2 (review finding): an invalid output_regex pattern is refused with a named-pattern message, never an uncaught regex-compile crash', () => {
  const dir = projectWith(
    { export: `node -e "process.exit(0)"` },
    { export: { output_regex: '([unclosed' } }
  );
  const r = runGate('export', dir);
  // EXPECTED FAILURE SHAPE (pre-fix): an unguarded `new RegExp(pattern)` on an
  // invalid pattern throws a SyntaxError uncaught, which node reports as an
  // exit-1 crash whose stderr is a raw stack trace ("at Object...") rather
  // than the exact refusal wording — the startsWith assertion fires, and the
  // "does not contain a raw stack" assertion may fire too since a bare crash
  // stack IS the entire stderr in that failure mode.
  assert.notEqual(r.code, 0, 'an unparseable regex pattern must be refused, never silently treated as a non-matching (or matching) pattern');
  assert.ok(r.stderr.startsWith('run-gate: invalid success_predicates'), `stderr must start with the exact refusal prefix; got: ${JSON.stringify(r.stderr.slice(0, 80))}`);
  assert.match(r.stderr, /\(\[unclosed/, 'the refusal names the offending pattern itself');
  assert.ok(!r.stderr.includes('at Object'), 'stderr must be a clean named refusal, never a raw uncaught stack trace as the only output');
});

test('G3 (review finding): an artifact path predicate that escapes the project root via traversal is refused at validation time, never followed outside the project', () => {
  const dir = projectWith(
    { export: `node -e "process.exit(0)"` },
    { export: { artifact: { path: '../../outside.bin' } } }
  );
  const r = runGate('export', dir);
  // EXPECTED FAILURE SHAPE (pre-fix): if the artifact path is joined to cwd
  // and existence-checked with no repo-boundary check, this predicate is
  // evaluated (rather than refused) against whatever happens to sit two
  // directories above the temp project dir — most likely "does not exist",
  // which produces a DIFFERENT (artifact-missing) verdict than the exact
  // "invalid success_predicates" refusal this test requires, so the
  // startsWith assertion fires.
  assert.notEqual(r.code, 0, 'an artifact path predicate that escapes the project root must be refused');
  assert.ok(r.stderr.startsWith('run-gate: invalid success_predicates'), `stderr must start with the exact refusal prefix; got: ${JSON.stringify(r.stderr.slice(0, 80))}`);
  assert.match(r.stderr, /\.\.\/\.\.\/outside\.bin/, 'the refusal names the escaping path');
});
