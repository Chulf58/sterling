// H25 dispatch-capability — TDD/mutation-verification toggle ADVISORY
// (slice 3C, board 7e7279c4, objective dome-farmer-issues-2026-09-05).
// SPEC-ONLY, blind to the coder's parallel implementation.
//
// Governing knowledge:
//   decision 752caf98 (tdd-and-mutation-toggles-in-system-tab): OFF silences
//   the automatic default only; an explicit ask still works; H5/H18 are
//   untouched by either state; both toggles default TRUE when absent.
//   decision 466ac94f (dispatch-capability-advisory-h25): H25 is warn-only —
//   it NEVER denies (never exit 2). This pin set extends that posture to a
//   new axis (the TDD/mutation config toggles), not a new enforcement
//   program (policy data + existing hook, per the dispatch brief).
//   board 7e7279c4: the toggles were prose-only — nothing in scripts/hooks
//   consumed config.tdd.enabled / config.mutation_verification.enabled.
//
// THE SPEC (from the dispatch brief, not read from the coder's diff):
//   H25 gains two additional, independent, WARN-ONLY checks on the outgoing
//   Task/Agent dispatch:
//     (a) TDD axis: subagent_type === 'test-writer' AND
//         config.tdd.enabled === false -> warns
//         "tests-first is OFF in this project; dispatch a test-writer only
//         on an explicit ask"
//     (b) mutation axis: the dispatch prompt matches /\b(mutation|sabotage|
//         mutant)\b/i AND config.mutation_verification.enabled === false ->
//         warns accordingly (the mutation-verification analogue of (a);
//         exact wording is not given by the spec, so this file pins the
//         REQUIRED CONTENT — mentions mutation verification, that it is
//         OFF, and that an explicit ask still works — not a literal string).
//         Reviewer fix (this round): every occurrence matched the LITERAL
//         two-word sequence /mutation verification/i, which is a literal-
//         string pin wearing a content-pin's clothing — a compliant
//         "mutation-verification" (hyphenated) wording would have turned
//         every WARN arm red and every CONTROL arm green-for-the-wrong-
//         reason simultaneously. Widened to /mutation[\s-]?verification/i
//         throughout (chosen over pinning the coder's literal string, since
//         the spec explicitly does not fix this wording the way TDD_WARN_TEXT
//         fixes the tdd axis — a tolerant content match is the correct pin
//         shape here, not a tightened literal).
//   Both axes are independently gated: each fires only when its OWN flag is
//   false, never when the flag is true, and never for a subagent_type/
//   prompt that does not match its own trigger condition. Warn-only means
//   exit code is always 0 — never a denial (exit 2).
//
// Harness copied from scripts/tests/h25-dispatch-capability.test.mjs
// (spawnSync runHook, .claude/agents/<type>.md fixture, hookSpecificOutput.
// additionalContext parsing) — extended with a .sterling/config.json
// fixture carrying the two toggle blocks, since this new axis reads project
// config the existing H25 suite never needed. Agent defs below omit the
// `tools:` frontmatter line entirely (all-tools default, per that suite's
// case 9) so no unrelated capability warning pollutes these assertions.
//
// EXPECTED STATE TODAY: the H25 hook already exists (an earlier slice
// shipped the tool-capability advisory), so process spawn succeeds and exit
// code is already 0 for every case — these tests do NOT fail on r.code the
// way a from-scratch-hook spec would. Every WARN-case test instead fails on
// its content assertion (parseAdditionalContext(r) does not yet contain the
// TDD/mutation-axis wording, because neither config key is consulted yet)
// until the coder lands the two checks. The CONTROL/SILENT-case tests may
// already pass today for the wrong reason (nothing warns about this axis at
// all yet) — expected for a not-yet-implemented axis, not a defect in the
// pin; once implemented, they start proving the gating rather than passing
// by default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const HOOK_PATH = join(HOOKS, 'h25-dispatch-capability.mjs');

function makeProject(config) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h25-tdd-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (config !== undefined) {
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// No `tools:` line -> all-tools default (see the sibling suite's case 9),
// so no unrelated H25 capability warning pollutes these TDD/mutation-axis
// assertions.
function writeAgentDef(dir, type) {
  writeFileSync(
    join(dir, '.claude', 'agents', `${type}.md`),
    `---\nname: ${type}\n---\nBody prose for the agent definition.\n`
  );
}

function taskInput(cwd, { subagent_type, prompt, tool_name = 'Task' }) {
  return { hook_event_name: 'PreToolUse', tool_name, tool_input: { subagent_type, prompt }, cwd };
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

function parseAdditionalContext(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout was not valid JSON: ${JSON.stringify(r.stdout)}`);
  }
  return parsed?.hookSpecificOutput?.additionalContext ?? '';
}

const BOTH_OFF = { tdd: { enabled: false }, mutation_verification: { enabled: false } };
const BOTH_ON = { tdd: { enabled: true }, mutation_verification: { enabled: true } };

const TDD_WARN_TEXT =
  'tests-first is OFF in this project; dispatch a test-writer only on an explicit ask';

// -----------------------------------------------------------------------
// CONTROL, placed first: both flags ON, test-writer dispatch, plain prompt
// (no mutation keyword) -> SILENT on both axes. This is the arm a
// hardcoded/unconditional "test-writer always warns" implementation would
// FAIL — only a genuinely config-gated check stays silent here.
// -----------------------------------------------------------------------
test('CONTROL: both toggles ON, test-writer dispatch, plain prompt -> silent on both axes', () => {
  const { dir, cleanup } = makeProject(BOTH_ON);
  try {
    writeAgentDef(dir, 'test-writer');
    const r = runHook(
      taskInput(dir, { subagent_type: 'test-writer', prompt: 'author the pins for AC3 from the spec alone' }),
      dir
    );
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.doesNotMatch(ctx, /tests-first/i, 'no tdd-axis warning when config.tdd.enabled is true');
    assert.doesNotMatch(ctx, /mutation[\s-]?verification/i, 'no mutation-axis warning when config.mutation_verification.enabled is true');
  } finally {
    cleanup();
  }
});
// Sabotage: make the tdd-axis check unconditional on subagent_type ===
// 'test-writer' alone (drop the `config.tdd.enabled === false` guard) —
// this test goes red (a tdd-axis warning appears despite tdd.enabled: true).

test('WARN (tdd axis): both toggles OFF, test-writer dispatch, plain prompt -> warns the exact tdd-axis text, exit 0', () => {
  const { dir, cleanup } = makeProject(BOTH_OFF);
  try {
    writeAgentDef(dir, 'test-writer');
    const r = runHook(
      taskInput(dir, { subagent_type: 'test-writer', prompt: 'author the pins for AC3 from the spec alone' }),
      dir
    );
    assert.equal(r.code, 0, `warn-only: expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.ok(ctx.includes(TDD_WARN_TEXT), `expected the exact tdd-axis warning text; got: ${ctx}`);
    assert.doesNotMatch(ctx, /mutation[\s-]?verification/i, 'plain prompt carries no mutation keyword — mutation axis must stay silent');
  } finally {
    cleanup();
  }
});
// Sabotage: invert the guard from `config.tdd.enabled === false` to
// `=== true` (or delete the check) — this test goes red (no warning text
// found).

test('CONTROL: both toggles OFF, CODER dispatch (not test-writer), plain prompt -> silent on the tdd axis', () => {
  const { dir, cleanup } = makeProject(BOTH_OFF);
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'implement the change described in the brief' }),
      dir
    );
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.doesNotMatch(ctx, /tests-first/i, 'the tdd-axis warning is scoped to subagent_type === test-writer, never a coder dispatch');
  } finally {
    cleanup();
  }
});
// Sabotage: drop the `subagent_type === 'test-writer'` condition (apply the
// tdd-axis check to any dispatch while tdd.enabled is false) — this test
// goes red (a coder dispatch would also warn).

test('WARN (mutation axis): both toggles OFF, coder dispatch, prompt mentions "mutation" -> warns the mutation-axis content, exit 0', () => {
  const { dir, cleanup } = makeProject(BOTH_OFF);
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'apply the mutation sabotage plan and check the result' }),
      dir
    );
    assert.equal(r.code, 0, `warn-only: expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, /mutation[\s-]?verification/i, 'warning must mention mutation verification');
    assert.match(ctx, /\boff\b/i, 'warning must state the toggle is OFF');
    assert.match(ctx, /explicit ask/i, 'warning must state an explicit ask still works, mirroring the tdd-axis remedy');
    assert.doesNotMatch(ctx, new RegExp(TDD_WARN_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'coder is not test-writer — the tdd-axis text must not appear');
  } finally {
    cleanup();
  }
});
// Sabotage: invert the guard from `config.mutation_verification.enabled ===
// false` to `=== true` (or delete the check) — this test goes red (no
// mutation-axis warning content found).

test('CONTROL: both toggles ON, prompt mentions "mutation" -> silent on the mutation axis (config-gated, not keyword-triggered)', () => {
  const { dir, cleanup } = makeProject(BOTH_ON);
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'apply the mutation sabotage plan and check the result' }),
      dir
    );
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.doesNotMatch(ctx, /mutation[\s-]?verification/i, 'no mutation-axis warning when config.mutation_verification.enabled is true, even though the keyword is present');
  } finally {
    cleanup();
  }
});
// Sabotage: fire the mutation-axis warning whenever the keyword regex
// matches, regardless of config.mutation_verification.enabled — this test
// goes red (a warning appears despite mutation_verification.enabled: true).

test('WARN (regex variant + BOTH AXES co-fire): both toggles OFF, test-writer dispatch, prompt says "sabotage" -> both axes warn without clobbering each other', () => {
  const { dir, cleanup } = makeProject(BOTH_OFF);
  try {
    writeAgentDef(dir, 'test-writer');
    const r = runHook(
      taskInput(dir, { subagent_type: 'test-writer', prompt: 'run the sabotage check before reporting' }),
      dir
    );
    assert.equal(r.code, 0, `warn-only: expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.ok(ctx.includes(TDD_WARN_TEXT), `expected the tdd-axis text (test-writer + tdd off) present; got: ${ctx}`);
    assert.match(ctx, /mutation[\s-]?verification/i, 'expected the mutation-axis content present ("sabotage" is a recognized keyword variant)');
  } finally {
    cleanup();
  }
});
// Sabotage: narrow the mutation-keyword regex to /\bmutation\b/i only,
// dropping the sabotage/mutant alternation — the mutation-axis match above
// goes red while the tdd-axis match stays green, isolating exactly which
// half broke.

test('WARN (case-insensitivity): both toggles OFF, coder dispatch, prompt says "MUTATION" (uppercase) -> still warns the mutation axis', () => {
  const { dir, cleanup } = makeProject(BOTH_OFF);
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'confirm the MUTATION result before merging' }),
      dir
    );
    assert.equal(r.code, 0, `warn-only: expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, /mutation[\s-]?verification/i, 'uppercase "MUTATION" in the prompt must still trigger the mutation-axis warning');
  } finally {
    cleanup();
  }
});
// Sabotage: drop the case-insensitive `/i` flag from the keyword regex —
// this test goes red (uppercase "MUTATION" no longer matches).

test('DEFAULT: config carries neither tdd nor mutation_verification keys -> both default ON, test-writer dispatch stays silent', () => {
  const { dir, cleanup } = makeProject({}); // present but empty config — neither key set
  try {
    writeAgentDef(dir, 'test-writer');
    const r = runHook(
      taskInput(dir, { subagent_type: 'test-writer', prompt: 'author the pins for AC3 from the spec alone' }),
      dir
    );
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.doesNotMatch(ctx, /tests-first/i, 'absent config keys must default to ON (decision 752caf98), never silently opt out to false');
  } finally {
    cleanup();
  }
});
// Sabotage: default a missing tdd/mutation_verification block to `false`
// (opt-out by default) instead of the documented default TRUE — this test
// goes red (a tdd-axis warning appears despite no explicit config).

// ===========================================================================
// COVERAGE GAPS closed per external review (5 named sabotages predicted
// GREEN against the suite as it stood; each gets its own pin below).
// ===========================================================================

test('GAP 1: config carries neither key AT ALL, prompt DOES mention "mutation" -> silent (absent mutation_verification key must default ON, not OFF)', () => {
  // The earlier DEFAULT test's prompt has no mutation keyword, so it can
  // only prove the TDD half of the absent-config default. This prompt
  // deliberately DOES carry a mutation keyword, isolating the mutation half.
  const { dir, cleanup } = makeProject({}); // present but empty config — neither key set
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'apply the mutation sabotage plan and check the result' }),
      dir
    );
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.doesNotMatch(
      ctx,
      /mutation[\s-]?verification/i,
      'an absent mutation_verification key must default to ON (decision 752caf98) — silently reading it as OFF is the gap this pin closes'
    );
  } finally {
    cleanup();
  }
});
// Named sabotage (verbatim from review): `config?.mutation_verification?.
// enabled === false` -> `!== true`. With the key absent, `config?.
// mutation_verification?.enabled` is `undefined`; `undefined === false` is
// false (correct, no warn) but `undefined !== true` is TRUE (wrongly warns)
// — this test goes red under that mutation because a mutation-axis warning
// appears despite no config at all.

test('GAP 2: prompt says "inspect the surviving mutant" (not "mutation"/"sabotage") -> still warns the mutation axis', () => {
  const { dir, cleanup } = makeProject(BOTH_OFF);
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'inspect the surviving mutant and decide if the pin is hollow' }),
      dir
    );
    assert.equal(r.code, 0, `warn-only: expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, /mutation[\s-]?verification/i, 'the word "mutant" must be a recognized keyword-regex alternative, same as "mutation"/"sabotage"');
  } finally {
    cleanup();
  }
});
// Named sabotage (verbatim from review): `MUTATION_WORD_RE = /\b(mutation|
// sabotage|mutant)\b/i` -> drop the `mutant` alternative (regex becomes
// /\b(mutation|sabotage)\b/i). This test goes red — "mutant" no longer
// matches and the mutation-axis warning never fires. (The sibling "sabotage"
// keyword is already exercised by the "WARN (regex variant + BOTH AXES
// co-fire)" test above — that pin was already genuine, not a gap.)
