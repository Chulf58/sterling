// H24 gate-invocation exit lint (board 7d88b237) — SPEC ONLY, red-first.
//
// Governing decision: knowledge_get 6cdd1b02-4d4f-4d7d-b9cd-2887265e7f90
// (slug gate-exit-lint-h24-masked-exit-codes) is the authority on semantics.
// Summary pinned here for the reader, not a re-derivation: a new hook,
// scripts/hooks/h24-gate-exit-lint.mjs, joins the global PreToolUse
// Bash|PowerShell entry. GATES = config.toolchains[].run_commands values
// UNION the builtin floor ['node --test', 'npm test', 'npm run check']. A
// command segment INVOKES a gate when it STARTS WITH the gate string at a
// token boundary. When a gate invocation is followed AT TOP LEVEL (quote-
// aware — separators inside quotes never count) by ';' or '||', the call is
// DENIED (exit 2) naming the gate, the masking construct, the remedy
// ('&&' propagates a red exit), and board 7d88b237. '&&' and pipes are
// deliberately ALLOWED. A gate that IS the final command is always allowed,
// wherever it sits in a '&&' chain or after a ';'. Fail posture: a corrupt or
// unreadable config degrades to the BUILTIN FLOOR ONLY — still enforcing the
// universal gates, never fully open, never wedging all Bash.
//
// scripts/hooks/h24-gate-exit-lint.mjs DOES NOT EXIST YET (confirmed via
// Glob before writing this file). Every test below is RED against today's
// tree: spawnSync launches `node <missing-path>`, node exits nonzero with a
// "Cannot find module" stderr, and every assertion below (which compares
// captured r.code/r.stderr — never a throw inside the test body) fails as a
// plain, catchable assertion_fail — never a test-runner crash. That failure
// shape is the CORRECT and EXPECTED one for this spec-only phase (task
// instruction) and is called out per-test below and in the handoff.
//
// Harness idiom mirrors scripts/tests/h20-prior-answers.test.mjs's spawnSync
// runHook idiom (process.execPath + hook path, JSON stdin, {code,stdout,
// stderr} return) and scripts/tests/h14-robustness.test.mjs's makeProject/
// CONFIG conventions, pointed at scripts/hooks/h24-gate-exit-lint.mjs. No
// store is involved — this hook is pure config + command-text analysis, so
// no SterlingStore import/before() hook is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Routing seam (slice S1, decision 1dab2a9f / board 5402a024 precondition P1):
// STERLING_HOOKS_DIR overrides the spawn directory so a mutation-arm clean-room
// bundle is reachable. Unset falls back to today's hard-coded scripts/hooks —
// byte-identical behavior to before this seam existed.
const HOOKS = process.env.STERLING_HOOKS_DIR || join(root, 'scripts', 'hooks');
const HOOK_PATH = join(HOOKS, 'h24-gate-exit-lint.mjs');

// The exact config shape given by the task: a config-declared non-floor gate
// ('blender --background --python export.py') is exercised alongside the
// builtin floor throughout.
const CONFIG = {
  toolchains: [
    {
      adapter: 'node',
      path_globs: ['**/*.mjs'],
      run_commands: {
        test: 'node --test',
        check: 'npm run check',
        export: 'blender --background --python export.py',
      },
    },
  ],
};

function makeProject({ config = CONFIG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h24-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeCorruptProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h24-corrupt-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{ not valid json ,,,');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeBareProject() {
  // .sterling/ entirely absent — no config.json, no .sterling dir at all.
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h24-bare-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Input shape per the task: {hook_event_name:'PreToolUse', tool_name:'Bash',
// tool_input:{command}, cwd}.
function gateInput(cwd, command, toolName = 'Bash') {
  return { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { command }, cwd };
}

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runHookRaw(rawStdin, cwd) {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: rawStdin,
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Deny assertions must be honest: exit code 2 AND a stderr match naming the
// gate, the masking construct, the remedy ('&&'), and the board. Never a
// vacuous index/boolean comparison.
function assertDeny(r, { gate, construct }) {
  assert.equal(r.code, 2, `expected deny (exit 2), got ${r.code}; stderr: ${r.stderr}`);
  // STRENGTHENED (review finding 2026-08-21): matching gate/construct anywhere
  // in stderr was vacuous — the remedy sentence always contains both ';' and
  // '||' verbatim, and the 'Command:' echo always contains the gate text. The
  // discriminating surface is the denial's FIRST line, which must name the
  // EXACT gate that matched and the EXACT separator that masked it.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    r.stderr,
    new RegExp(`'${esc(gate)}' is followed at top level by '${esc(construct)}'`),
    'denial must name the exact matched gate and the exact masking construct on its first line'
  );
  assert.match(r.stderr, /&&/, "denial must name the remedy — chaining with '&&' propagates a red exit");
  assert.match(r.stderr, /6cdd1b02/, 'denial cites decision 6cdd1b02');
}

function assertAllow(r) {
  assert.equal(r.code, 0, `expected allow (exit 0), got ${r.code}; stderr: ${r.stderr}`);
}

const SEMI = ';';
const OR = '||';

// ---------------------------------------------------------------------------
// DENY — a declared gate invocation masked by a top-level ';' or '||'
// ---------------------------------------------------------------------------

test('H24 DENY: the measured incident shape — "node --test x.test.mjs; echo $?" masks the suite exit with $?', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today, hook missing): r.code is whatever node's
    // "Cannot find module" exit produces (not 2), so assert.equal(r.code, 2)
    // fails as a plain AssertionError before any stderr regex is evaluated.
    const r = runHook(gateInput(dir, 'node --test x.test.mjs; echo $?'), dir);
    assertDeny(r, { gate: 'node --test', construct: SEMI });
  } finally {
    cleanup();
  }
});

test('H24 DENY: "npm run check ; true" — a config-declared multi-word gate masked by \';\'', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 2) fails first (module-not-found exit).
    const r = runHook(gateInput(dir, 'npm run check ; true'), dir);
    assertDeny(r, { gate: 'npm run check', construct: SEMI });
  } finally {
    cleanup();
  }
});

test('H24 DENY: "node --test x || true" — masked by top-level \'||\'', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 2) fails first.
    const r = runHook(gateInput(dir, 'node --test x || true'), dir);
    assertDeny(r, { gate: 'node --test', construct: OR });
  } finally {
    cleanup();
  }
});

test('H24 DENY: config-declared gate NOT in the builtin floor — "blender --background --python export.py; echo done"', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 2) fails first. This case
    // specifically pins that GATES include config.run_commands values, not
    // only the builtin floor.
    const r = runHook(gateInput(dir, 'blender --background --python export.py; echo done'), dir);
    assertDeny(r, { gate: 'blender --background --python export.py', construct: SEMI });
  } finally {
    cleanup();
  }
});

test('H24 DENY: gate inside a \'&&\' chain, then masked by \';\' — "cd pkg && node --test x; ls"', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 2) fails first. Pins that
    // the gate need not be the FIRST segment — it is denied wherever a ';'
    // or '||' follows it at top level, even mid-chain.
    const r = runHook(gateInput(dir, 'cd pkg && node --test x; ls'), dir);
    assertDeny(r, { gate: 'node --test', construct: SEMI });
  } finally {
    cleanup();
  }
});

test('H24 DENY: PowerShell parity — tool_name \'PowerShell\' with "node --test x; echo done" denies exactly like Bash', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 2) fails first. Pins that
    // H24 rides the SAME global PreToolUse entry for Bash and PowerShell —
    // the hook must not special-case on tool_name.
    const r = runHook(gateInput(dir, 'node --test x; echo done', 'PowerShell'), dir);
    assertDeny(r, { gate: 'node --test', construct: SEMI });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ALLOW — legitimate compositions that must never be denied
// ---------------------------------------------------------------------------

test('H24 ALLOW: "node --test x" — the gate is the final (only) command', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): r.code is the module-not-found exit
    // (nonzero, but not necessarily 0), so assert.equal(r.code, 0) fails.
    const r = runHook(gateInput(dir, 'node --test x'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW: "cd pkg && node --test x" — the gate is final in a \'&&\' chain', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails (nonzero from missing hook).
    const r = runHook(gateInput(dir, 'cd pkg && node --test x'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW: "node --test a && echo done" — \'&&\' propagates a red exit, deliberately allowed', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails.
    const r = runHook(gateInput(dir, 'node --test a && echo done'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW: pipes are deliberately allowed — "node --test a | tail -5" and "npm run check 2>&1 | grep FAILED"', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: both assert.equal(r.code, 0) calls fail.
    const r1 = runHook(gateInput(dir, 'node --test a | tail -5'), dir);
    assertAllow(r1);
    const r2 = runHook(gateInput(dir, 'npm run check 2>&1 | grep FAILED'), dir);
    assertAllow(r2);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW: separator BEFORE the gate — "echo hi; node --test x"', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails. Pins that the
    // lint only fires when a gate is FOLLOWED by a masking separator, never
    // when one merely appears earlier in the command line.
    const r = runHook(gateInput(dir, 'echo hi; node --test x'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW: no gate at all — "ls; echo $?"', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails.
    const r = runHook(gateInput(dir, 'ls; echo $?'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW boundary: "node --testify; echo hi" — \'--testify\' is not \'--test\' at a token boundary', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails. Pins the
    // token-boundary rule: a gate string must match a full token prefix, not
    // merely a leading-character substring.
    const r = runHook(gateInput(dir, 'node --testify; echo hi'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW boundary: "npm run checker; true" — \'checker\' is not \'check\' at a token boundary (same rule, a multi-word gate)', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails. The same
    // token-boundary rule pinned above, applied to a config-declared
    // multi-word gate rather than the floor's single-flag gate.
    const r = runHook(gateInput(dir, 'npm run checker; true'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW: gate string appears only as a quoted ARGUMENT, not a segment start — "echo \'node --test\'; true"', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails. Pins that
    // "invokes a gate" means the segment STARTS WITH the gate string, not
    // that the gate string appears anywhere in the command line.
    const r = runHook(gateInput(dir, "echo 'node --test'; true"), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW: \';\' inside quotes never counts as a top-level separator — "node --test x --grep \'a;b\'"', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails. Pins quote-aware
    // scanning: the gate IS invoked and IS the final command once the
    // quoted ';' is correctly excluded from top-level separator scanning.
    const r = runHook(gateInput(dir, "node --test x --grep 'a;b'"), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW (explicit scope choice — one test pins this): subshell contents are opaque — "(node --test a; true)"', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails. This pins a
    // DELIBERATE scope choice from the governing decision: the lint does not
    // parse inside '(...)' subshells, so a masking construct hidden inside a
    // subshell is allowed at the top level even though, read naively, the
    // gate looks masked. A future implementation that widens scope to parse
    // subshell contents would need this test updated deliberately, not by
    // accident.
    const r = runHook(gateInput(dir, '(node --test a; true)'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fail posture — corrupt/absent config, malformed stdin, non-Bash tool_name
// ---------------------------------------------------------------------------

test('H24 fail posture: corrupt .sterling/config.json — the builtin floor still denies "node --test x; true"', () => {
  const { dir, cleanup } = makeCorruptProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 2) fails first (module-not-found).
    const r = runHook(gateInput(dir, 'node --test x; true'), dir);
    assertDeny(r, { gate: 'node --test', construct: SEMI });
  } finally {
    cleanup();
  }
});

test('H24 fail posture: corrupt config — a command masking ONLY the config-declared blender gate ALLOWS (config was unreadable, only the floor holds)', () => {
  const { dir, cleanup } = makeCorruptProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails (nonzero from
    // missing hook). This pins that degrading to "floor only" on a corrupt
    // config is not the same as "deny everything" — a non-floor gate that
    // cannot be read from config is simply not recognized as a gate at all,
    // so masking it is allowed.
    const r = runHook(gateInput(dir, 'blender --background --python export.py; echo done'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 fail posture: .sterling/ absent entirely — the builtin floor still denies "npm test; true"', () => {
  const { dir, cleanup } = makeBareProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 2) fails first.
    const r = runHook(gateInput(dir, 'npm test; true'), dir);
    assertDeny(r, { gate: 'npm test', construct: SEMI });
  } finally {
    cleanup();
  }
});

test('H24 fail posture: malformed (non-JSON) stdin — exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: today's failure is a module-not-found exit,
    // which is very unlikely to equal 0, so assert.equal(r.code, 0) fails.
    // Once the hook exists, this pins that a stdin parse failure must not
    // crash into a nonzero/denying exit — it must degrade to a silent allow.
    const r = runHookRaw('this is not { json at all', dir);
    assert.equal(r.code, 0, `expected exit 0 on malformed stdin, got ${r.code}; stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H24 fail posture: tool_name \'Read\' — exit 0 even with a masked gate string sitting in tool_input.command', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails (nonzero from
    // missing hook). Pins that H24 only inspects Bash/PowerShell invocations
    // — a masked-looking command string under an unrelated tool_name (Read
    // does not even execute a command) must never be evaluated as a gate
    // invocation.
    const r = runHook(gateInput(dir, 'node --test x; true', 'Read'), dir);
    assert.equal(r.code, 0, `expected exit 0 for tool_name Read, got ${r.code}; stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Review findings pinned below (board babf3a9e / 7d88b237, governing
// decision knowledge_get 98549344-e355-42da-93dd-ce7c2dc4dfcb): run-gate.mjs
// joins the builtin gate floor, so masking ITS OWN exit is denied like any
// other gate — and the matcher must be PATH-AGNOSTIC (a consuming project
// invokes the clone's run-gate.mjs through an arbitrary absolute path, never
// the repo-relative "scripts/run-gate.mjs" this repo happens to use). ADD-
// ONLY: nothing above this line was touched. A fixer is landing the
// corresponding repair in parallel.
//
// NOTE per task instruction: these DENY cases assert directly on r.code and
// a stderr match rather than calling assertDeny — assertDeny's first-line
// regex expects the EXACT matched gate text on its own, and it is not
// pinned down here whether a run-gate invocation is reported the same way
// the plain floor literals ('node --test', 'npm test', ...) are.
// ---------------------------------------------------------------------------

test('H24 DENY (review finding, board babf3a9e/7d88b237): "node scripts/run-gate.mjs export; echo $?" masks run-gate\'s own exit', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(gateInput(dir, 'node scripts/run-gate.mjs export; echo $?'), dir);
    // EXPECTED FAILURE SHAPE (pre-fix): run-gate.mjs is not yet part of the
    // builtin gate floor, so the hook does not recognize this command as a
    // gate invocation at all — r.code stays 0 (allowed), failing the
    // assert.equal(r.code, 2) below.
    assert.equal(r.code, 2, `expected deny (exit 2), got ${r.code}; stderr: ${r.stderr}`);
    assert.match(r.stderr, /run-gate/i, 'the denial names run-gate as the matched gate');
    assert.match(r.stderr, /;/, "the denial identifies ';' as the masking construct");
    assert.match(r.stderr, /6cdd1b02/, 'denial cites decision 6cdd1b02');
  } finally {
    cleanup();
  }
});

test('H24 DENY (G4 review finding — path-agnostic matcher): a CONSUMER project\'s absolute clone path still denies "node /home/user/sterling-clone/scripts/run-gate.mjs export; true"', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(gateInput(dir, 'node /home/user/sterling-clone/scripts/run-gate.mjs export; true'), dir);
    // EXPECTED FAILURE SHAPE (pre-fix): if the matcher hard-codes the
    // repo-relative literal "scripts/run-gate.mjs" (or run-gate is not
    // recognized at all yet), an arbitrary absolute clone path never
    // matches, so r.code stays 0 and this assert.equal(r.code, 2) fails —
    // pinning that the matcher must recognize run-gate.mjs regardless of
    // whatever path prefix sits in front of it on a consumer machine.
    assert.equal(r.code, 2, `expected deny (exit 2) regardless of the clone's absolute path, got ${r.code}; stderr: ${r.stderr}`);
    assert.match(r.stderr, /run-gate/i, 'the denial names run-gate as the matched gate even at a consumer-machine absolute path');
    assert.match(r.stderr, /6cdd1b02/, 'denial cites decision 6cdd1b02');
  } finally {
    cleanup();
  }
});

test('H24 ALLOW boundary: "node scripts/run-gate.mjs.bak; true" — the ".bak" suffix means this is not actually run-gate.mjs at a token boundary', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(gateInput(dir, 'node scripts/run-gate.mjs.bak; true'), dir);
    // EXPECTED FAILURE SHAPE: if the matcher is a naive substring/prefix
    // check ("contains run-gate.mjs") rather than a token-boundary match, a
    // ".bak" backup file is wrongly caught as a gate invocation and this
    // command is wrongly denied (r.code === 2) instead of allowed, failing
    // assertAllow's assert.equal(r.code, 0).
    assertAllow(r);
  } finally {
    cleanup();
  }
});

test('H24 ALLOW: "node scripts/run-gate.mjs export && git add -A" — \'&&\' propagates a red exit, deliberately allowed for run-gate same as any other gate', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (pre-fix): if run-gate is not yet recognized as
    // a gate at all, this already reads as allowed (r.code 0) for the WRONG
    // reason (no gate detected, rather than "gate detected, && correctly
    // allowed"). Paired with the two DENY cases above, which DO exercise
    // detection directly, this pins both "run-gate is a recognized gate" and
    // "the recognition does not overreach into legitimate && chains".
    const r = runHook(gateInput(dir, 'node scripts/run-gate.mjs export && git add -A'), dir);
    assertAllow(r);
  } finally {
    cleanup();
  }
});
