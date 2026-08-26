// SLICE S0 of the hollow-test mutation arm — THE ROUTING PIN (AC5 control, AC4
// treatment). SPEC ONLY, red-first. Written blind (H4 read wall).
//
// Governing records:
//   decision  1dab2a9f [hollow-test-mutation-arm-design-accepted-sequenced-enablement]
//   anti_pat  37b3cb0a [a-test-that-builds-in-place-ships-whatever-is-in-the-working-tree]
//   decision  23afbc83 [conductor-executes-test-writer-sabotage-clean-room]
//   board     5402a024 precondition P1 (BLOCKING)
//
// THE FINDING THIS FILE CLOSES. An outside-family review (Codex, gpt-5,
// read-only) found the accepted harness would be a NO-OP as specified: the
// enforcement tests HARD-CODE their spawn location
// (scripts/tests/enforcement.test.mjs:14,23; scripts/tests/h24-gate-exit-lint.test.mjs:43;
// scripts/tests/h27-dispatch-signatures.test.mjs:53) and NO STERLING_HOOKS_DIR
// consumer exists anywhere in the repo. Setting that variable changes nothing, so
// every mutant would report SURVIVED (or KILLED by accident) while in fact
// testing UNMUTATED source. An arm that silently tests unmutated source is WORSE
// than no arm, because it certifies hollowness as coverage. These two pins exist
// to make that outcome IMPOSSIBLE TO PASS SILENTLY.
//
// HOW AC4 MAKES A NO-OP RELOCATION IMPOSSIBLE TO PASS. It does not set the
// variable and then assert the normal result — that pin passes against unmutated
// source and is precisely the hollow pin this mechanism exists to catch. Instead:
//   1. A RELOCATED hook directory is built containing ONE hook whose behavior
//      DIFFERS OBSERVABLY from the live one: a force-allow stub (always exit 0)
//      that also APPENDS A LINE TO A WITNESS FILE at a path baked into its source.
//   2. The named enforcement test file is run as a CHILD suite with the routing
//      seam pointed at that directory.
//   3. Three assertions, each of which a no-op relocation fails:
//      (a) THE WITNESS FILE EXISTS with >= 1 recorded spawn. Nothing but a
//          genuine relocation can write it — if the child suite still spawns
//          scripts/hooks/, the file is never created. This is the assertion that
//          CARRIES THE VERDICT.
//      (b) The child suite reports `# fail >= 1`. The stub's DIFFERENT behavior
//          (allow where the live hook denies) must actually be OBSERVED by the
//          suite's own assertions — routing that reaches a directory nobody
//          spawns from would satisfy (a) only if the spawn happened, and (b)
//          proves the spawn's RESULT flowed into a verdict.
//      (c) The child suite still reports `# pass >= 1`. This is CONTROL-B in
//          miniature: the permissive path stays green, so the red in (b) is "the
//          pin discriminates", not "everything exploded". It also rules out an
//          import-time crash producing a non-zero exit for the wrong reason.
//   A no-op relocation (today's tree) fails (a) and (b) while passing (c).
//
// WHY A FILESYSTEM WITNESS RATHER THAN A PRINTED MARKER: a stub that writes to
// stderr would perturb the child suite's ALLOW-path assertions and weaken (c).
// The witness is also immune to TAP formatting, reporter changes, and output
// interleaving — a printed marker is not.
//
// MUTATION DISCIPLINE (23afbc83): the stub below is a TEST FIXTURE written into a
// temp directory at run time, not a mutation of anything in the repo. This file
// DESIGNS the sabotage for each pin and never executes one; the conductor applies
// the named one-liner to a clean-room copy and confirms the flip.
//
// COUPLING TO FLAG (not fixed here): AC4 requires the routing seam to be live in
// scripts/tests/h24-gate-exit-lint.test.mjs — that file's HOOKS constant
// (line 44) must honour STERLING_HOOKS_DIR. That edit is nominally S1 work and
// the file is frozen (H5), so S0 must either carry it through the frozen-test
// repair route or S1 must land before this pin can go green. S1 must extend the
// same seam to enforcement.test.mjs and h27-dispatch-signatures.test.mjs; this
// pin covers ONE named file by design (the cheapest of the three: no store, pure
// config + command-text analysis) and is not evidence about the other two.
//
// EXPECTED FAILURE SHAPE TODAY:
//   AC5 CONTROL — GREEN today (it must be; it is the evidence AC4's red is real).
//     If it is RED, the child-suite harness is broken and AC4's verdict means
//     nothing — read it as INCONCLUSIVE, never as a pass.
//   AC4 — RED at assertion (a): `assert.ok(existsSync(WITNESS), ...)`, because no
//     STERLING_HOOKS_DIR consumer exists, so the child suite spawns
//     scripts/hooks/h24-gate-exit-lint.mjs and the stub is never invoked. The
//     `# fail >= 1` assertion is red for the same root cause.
//
// HARNESS NOTE: runTargetSuite scrubs NODE_TEST* from the forwarded env before
// spawning the child `node --test` process — this exists so the clean-room
// mutation protocol (23afbc83) can actually observe the child suite's own
// counters, not as test-only tidiness. Without it, the child inherits this
// file's own NODE_TEST_CONTEXT, node:test treats the spawn as a recursive
// invocation, skips running files, and emits no `# pass`/`# fail` counters at
// all — both AC4 and AC5 would then die at "could not read node:test counters"
// regardless of what the routing seam or any mutation does.
//
// HARNESS NOTE (2): the child spawn REQUIRES `--test-reporter tap` — on this
// Node version the default reporter emits `ℹ pass N` / `ℹ fail N`, never the
// `# pass N` / `# fail N` lines this file's regex parses, so without it AC4 and
// AC5 both die at "could not read node:test counters" regardless of routing or
// mutation. Precedent: scripts/adapters/node.mjs:43 passes the same flag for the
// same reason — do not remove this as noise.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The routing seam's variable name is fixed by the accepted design (decision
// 1dab2a9f / board 5402a024 precondition P1); it is not invented here.
const SEAM = 'STERLING_HOOKS_DIR';

// The named enforcement test file this pin routes. Its hard-coded spawn location
// is one of the three the review cited (h24-gate-exit-lint.test.mjs:43).
const TARGET_SUITE = join(root, 'scripts', 'tests', 'h24-gate-exit-lint.test.mjs');
const TARGET_HOOK = 'h24-gate-exit-lint.mjs';

let reloc;
let WITNESS;

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// A stand-in "bundle": standalone (one node: import, no workspace resolution),
// FORCE-ALLOW (always exit 0, where the live hook DENIES with exit 2 on a masked
// gate invocation), and silent on stdout/stderr so the suite's allow-path
// assertions are undisturbed. Its only trace is the witness file.
function writeForceAllowStub(dir, witnessPath) {
  const src = [
    "import { appendFileSync } from 'node:fs';",
    `const WITNESS = ${JSON.stringify(witnessPath)};`,
    'let raw = "";',
    'function done(reason) {',
    '  try { appendFileSync(WITNESS, `spawned ${reason} bytes=${raw.length}\\n`); } catch {}',
    '  process.exit(0);',
    '}',
    // A hard ceiling so a stdin that never closes can never hang the child suite.
    'const guard = setTimeout(() => done("timeout"), 10000);',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { raw += c; });',
    'process.stdin.on("end", () => { clearTimeout(guard); done("stdin-end"); });',
    'process.stdin.on("error", () => { clearTimeout(guard); done("stdin-error"); });',
    '',
  ].join('\n');
  writeFileSync(join(dir, TARGET_HOOK), src);
}

// Runs the named enforcement suite as a CHILD process and parses node:test's own
// summary counters. Both streams are scanned so a reporter that routes the
// summary to stderr does not silently zero the counts.
function runTargetSuite({ seamDir }) {
  const env = { ...process.env };
  delete env[SEAM];
  // NODE_TEST_CONTEXT (and any sibling NODE_TEST* var) leaks in via the
  // {...process.env} spread above because THIS file is itself running under
  // `node --test`. node:test detects that var on the child and prints
  // "run() is being called recursively within a test file. skipping running
  // files.", emitting NO `# pass`/`# fail` counters — a harness defect, not a
  // routing outcome, and it would silently swallow both AC4 and AC5's verdicts.
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) delete env[key];
  }
  if (seamDir) env[SEAM] = seamDir;

  const r = spawnSync(process.execPath, ['--test', '--test-reporter', 'tap', TARGET_SUITE], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 600_000,
  });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const num = (label) => {
    const m = text.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { status: r.status, pass: num('pass'), fail: num('fail'), text };
}

before(() => {
  reloc = mkdtempSync(join(tmpdir(), 'sterling-s0-reloc-'));
  WITNESS = join(mkdtempSync(join(tmpdir(), 'sterling-s0-witness-')), `witness-${randomUUID()}.log`);
  writeForceAllowStub(reloc, WITNESS);
  assert.ok(existsSync(TARGET_SUITE), `the named enforcement suite is missing: ${TARGET_SUITE}`);
  assert.ok(!existsSync(WITNESS), 'the witness file must not exist before any suite runs');
});

after(() => {
  rmSync(reloc, { recursive: true, force: true });
  rmSync(dirname(WITNESS), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC5 — THE CONTROL ARM, PLACED FIRST. With the seam UNSET the same child spawn
// hits the LIVE hook and sees LIVE behavior. It must pass for the OPPOSITE reason
// to AC4: green because nothing was relocated. Without it, AC4's red has more
// than one possible cause (a broken child spawn, a wedged suite, a bad node flag)
// and its verdict would be unreadable — decision cf863d84's control-arm rule.
// SABOTAGE: point the child spawn at a nonexistent suite path -> AC5 red
// (`# pass >= 1` and `status === 0` both fire), proving this arm is not
// unconditionally green.
// SABOTAGE (2nd layer): make the child suite honour STERLING_HOOKS_DIR from the
// AMBIENT environment even when the runner deletes it -> AC5 red at the
// witness-absent assertion.
// ---------------------------------------------------------------------------
test('AC5 CONTROL: with the routing seam UNSET the named suite hits the LIVE hook and passes', () => {
  const r = runTargetSuite({ seamDir: null });

  assert.ok(r.pass !== null && r.fail !== null, `could not read node:test counters from the child run — the harness itself is broken: ${oneLine(r.text)}`);
  assert.ok(r.pass >= 1, `the child suite ran no passing tests (# pass ${r.pass}) — a green exit would mean nothing: ${oneLine(r.text)}`);
  assert.equal(r.fail, 0, `the named suite is RED against the live tree, so it cannot serve as the mutation target: ${oneLine(r.text)}`);
  assert.equal(r.status, 0, `child suite exited non-zero with the seam unset: ${oneLine(r.text)}`);
  assert.ok(
    !existsSync(WITNESS),
    'the relocated stub ran even though the seam was UNSET — the default spawn location is not the live hook directory',
  );
});

// ---------------------------------------------------------------------------
// AC4 — THE ROUTING PIN. See the header for why a no-op relocation cannot pass.
// SABOTAGE (the named one, and the exact failure Codex found): remove the
//   STERLING_HOOKS_DIR read from scripts/tests/h24-gate-exit-lint.test.mjs so its
//   HOOKS constant is hard-coded to scripts/hooks again -> AC4 red at the WITNESS
//   assertion, which CARRIES THE VERDICT; the `# fail >= 1` assertion goes red
//   from the same root cause, and `# pass >= 1` stays green (that is the point).
// SABOTAGE (2nd, proving the pin is behavioral and not path-cosmetic): make the
//   seam resolve to the live directory whenever the override path is not a
//   sibling of scripts/hooks -> AC4 red identically, because the stub still never
//   runs. A pin that only compared PATH STRINGS would survive both.
// NOT HOLLOW BY CONSTRUCTION: no assertion here can be satisfied by unmutated
//   source. The witness file cannot exist unless a process spawned the relocated
//   stub, and `# fail >= 1` cannot occur unless that stub's differing verdict
//   reached an assertion in the named suite.
// ---------------------------------------------------------------------------
test('AC4: with the routing seam SET, the named suite spawns the RELOCATED hook and observes its different behavior', () => {
  const r = runTargetSuite({ seamDir: reloc });

  // (a) The verdict-carrying assertion: the relocated stub actually ran.
  assert.ok(
    existsSync(WITNESS),
    `the relocated hook was NEVER SPAWNED: the named suite still ran scripts/hooks/${TARGET_HOOK} while ${SEAM} pointed at ${reloc}. Every mutant would report SURVIVED against UNMUTATED source (board 5402a024 precondition P1). Child output: ${oneLine(r.text)}`,
  );
  const spawns = readFileSync(WITNESS, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(spawns >= 1, `the witness file is empty — no spawn of the relocated hook was recorded: ${oneLine(r.text)}`);

  // (b) The differing behavior reached the suite's own assertions.
  assert.ok(r.pass !== null && r.fail !== null, `could not read node:test counters from the child run: ${oneLine(r.text)}`);
  assert.ok(
    r.fail >= 1,
    `the relocated FORCE-ALLOW hook produced NO failing test (# fail ${r.fail}) — either the suite never observed the relocated behavior, or its deny assertions do not discriminate: ${oneLine(r.text)}`,
  );
  assert.notEqual(r.status, 0, `the child suite exited 0 while reporting # fail ${r.fail}: ${oneLine(r.text)}`);

  // (c) CONTROL-B in miniature: the permissive path is still green, so (b) is
  // "the pin discriminates", not "the mutation broke everything".
  assert.ok(
    r.pass >= 1,
    `NOTHING passed under the relocated hook (# pass ${r.pass}) — the child suite crashed or every test went red, so the failure in (b) carries no information: ${oneLine(r.text)}`,
  );
});
