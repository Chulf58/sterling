// H15 store-guard — FAIL-CLOSED BOUNDARY pins (board 01afa03e — see the item
// for the confirmed evidence; anti_pattern e13f0fb5 owns the F5 "gate voids
// itself on a non-blocking exit 1" class).
//
// THE DEFECT PINNED HERE: every statement between process start and the deny
// decision must sit inside the fail-closed boundary — not merely the
// config/store read. Two statements did not: `readStdin()` and the
// store-mention preprocessing (`unquotedText(command)`), the latter compiling
// a RegExp built from the command's own heredoc DELIMITER. An uncaught throw
// in either exits 1, which the hook runner treats as NON-BLOCKING — the
// guarded command runs UNEXAMINED. Reproduced against HEAD 2026-08-26.
//
// WHY AN OVERSIZED DELIMITER AND NOT A METACHAR ONE: the metachar case is
// already escaped and already pinned (h15-precision.test.mjs, "AC-D"). Escaping
// makes the pattern VALID, not SMALL — V8 raises "Regular expression too large"
// when the pattern is COMPILED by .match(), not when new RegExp constructs it.
// Measured on this Node: 32,000 chars compiles, 65,000 throws; 70,000 is used
// below for margin.
//
// NOT A NARROWING OF THE DENY SURFACE: decision ccc44a8e fences the
// classify-by-static-text approach as TERMINAL and decision 2c3e3136 parks the
// tokenizer rewrite. Every pin below only converts a VOIDED gate into a DENY;
// no command that denies today is allowed after it.
//
// MUTATION DESIGN ONLY — never executed here (decision 23afbc83). Each test
// names the one-line sabotage that must flip it red, applied to a clean-room
// mutant COPY of the hook, never to the shipped file.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

// >65k: above V8's compiled-pattern size limit, so the delimiter-derived
// RegExp throws when it is matched. Small enough to build instantly.
const BIG = 'A'.repeat(70_000);

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runRaw(stdin, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h15-store-guard.mjs')], {
    input: stdin,
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    // H1's clone-currency probe must never fire inside a hook unit test.
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runHook(command, cwd) {
  return runRaw(
    JSON.stringify({
      session_id: 's1',
      transcript_path: join(cwd, 't', 's1.jsonl'),
      cwd,
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'coder',
      tool_input: { command },
    }),
    cwd
  );
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h15failclosed-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

// =========================================================================
// CONTROL ARMS — PLACED FIRST. Every SUBJECT below asserts a DENY, and a
// guard that has degenerated into deny-everything would satisfy all of them
// identically. These four must pass for the OPPOSITE reason: two ALLOWs that
// prove the gate still has an allow surface, and two DENYs that prove the
// ORDINARY classify path (not the fail-closed catch) is what refuses a real
// store write. Read together they say: the subjects' verdicts come from the
// boundary, not from breakage.
// =========================================================================

test('CONTROL-1: a command naming no store path at all is ALLOWED — H15 has not degenerated into deny-everything', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(runHook('ls /tmp', dir).code, 0);
  } finally {
    cleanup();
  }
});
// SABOTAGE: `process.exit(2)` before any check in the hook → CONTROL-1 red.

test('CONTROL-2: a plain store write is denied by the ORDINARY classifier, not by a fail-closed catch', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook('rm -rf .sterling', dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /shell write access to the Sterling store is denied/);
    assert.doesNotMatch(r.stderr, /ENVIRONMENT DEFECT/, 'a normal store write must NOT route through an environment-defect denial');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make classifyFragment always return { write: false } → CONTROL-2 red.

test('CONTROL-3: a quote-spliced store write with an ordinary heredoc is denied by the ordinary classifier — the splice path itself still works', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook("rm -rf .st''erling <<EOF\nbody\nEOF", dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /shell write access to the Sterling store is denied/);
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the `|| STORE_MENTION_RE.test(unquotedText(command))` half of
// the mention test → CONTROL-3 red (the splice escapes entirely).

test('CONTROL-4: a huge heredoc BODY with a small delimiter is ALLOWED — command SIZE alone never denies; only a delimiter-derived oversized pattern does', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(runHook(`cat <<EOF\n${BIG}\nEOF`, dir).code, 0, 'if this is red, the pins below are measuring input size, not the boundary');
  } finally {
    cleanup();
  }
});
// SABOTAGE: deny whenever command.length > 50_000 → CONTROL-4 red, and the
// subjects below would then pass for the WRONG reason.

// =========================================================================
// SUBJECTS — the preprocessing boundary (the store-mention test).
// =========================================================================

test('AC1: a quote-spliced store write whose heredoc delimiter makes the preprocessing RegExp throw is DENIED, not silently allowed by the crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Raw text contains no ".sterling" (the splice hides it), so the mention
    // test must consult unquotedText — which throws. Pre-fix this exited 1,
    // which the runner reads as ALLOW: a real `rm -rf .sterling` ran.
    const r = runHook(`rm -rf .st''erling <<${BIG}\nbody\n${BIG}`, dir);
    assert.equal(r.code, 2, 'exit 1 here is a VOIDED gate — the platform treats non-2 as non-blocking');
    assert.match(r.stderr, /ENVIRONMENT DEFECT \(H15\)/);
    assert.match(r.stderr, /preprocessing the command text/, 'the denial must name the boundary that refused, so a reader can tell a fail-closed refusal from ordinary classification');
  } finally {
    cleanup();
  }
});
// SABOTAGE: change the new preprocessing catch's `deny(` to `allow(` → AC1 red
// (exit 0). NOTE the second, weaker mutation this pin also survives: deleting
// the try/catch entirely reproduces the original defect and AC1 goes red with
// exit 1. Both must be checked — the assertion on the message text is what
// stops a future engine that no longer throws from turning this pin hollow
// (without it, AC1 would still be green via the ordinary classifier).

test('AC2: a throwing heredoc delimiter DENIES even when no store path is mentioned — a gate that cannot evaluate refuses (P5)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`echo hi <<${BIG}\nbody\n${BIG}`, dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /preprocessing the command text/);
  } finally {
    cleanup();
  }
});
// SABOTAGE: same `deny(` → `allow(` in the preprocessing catch → AC2 red.
// This is the ACCEPTED COST arm, pinned deliberately: an innocent command with
// a pathological delimiter is refused rather than passed unexamined, because
// the gate genuinely cannot tell the two apart at that point.

// =========================================================================
// SUBJECT — the input boundary.
// =========================================================================

test('AC3: unparseable hook stdin DENIES — a gate that cannot read its own input has verified nothing', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('{ not json', dir);
    assert.equal(r.code, 2, 'exit 1 would let the command run unexamined');
    assert.match(r.stderr, /\[stdin\] hook input could not be read/);
  } finally {
    cleanup();
  }
});
// SABOTAGE: change the new stdin catch's `deny(` to `allow(` → AC3 red.

// =========================================================================
// LAYER SEPARATION — this one is carried by the PRE-EXISTING outer catch, not
// by either new boundary. A RAW store mention short-circuits the `||`, so
// unquotedText never runs; splitFragments then compiles the same oversized
// pattern INSIDE the old try. Pinned so a later reader can see WHICH guard
// owns WHICH verdict instead of assuming one catch covers all four.
// =========================================================================

test('AC4: a RAW store mention plus a throwing heredoc delimiter is denied by the pre-existing evaluation catch, not by the new preprocessing catch', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(`rm -rf .sterling <<${BIG}\nbody\n${BIG}`, dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Internal error while evaluating shell command safety/);
    assert.doesNotMatch(r.stderr, /preprocessing the command text/, 'the short-circuit means unquotedText is never reached on this input');
  } finally {
    cleanup();
  }
});
// SABOTAGE: change the OUTER fragment-loop catch's `deny(` to `allow(` → AC4
// red, while AC1/AC2/AC3 stay green. That asymmetry IS the layer-separation
// evidence: three different guards, three disjoint verdicts, no overlap.
