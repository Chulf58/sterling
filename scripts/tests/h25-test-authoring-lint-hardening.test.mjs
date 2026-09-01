// H25 test-authoring dispatch-time lint — HARDENING supplement (board
// 2f57ec84-d8f3-4ce4-96ad-1bc516ea6034). SPEC ONLY.
//
// This file adds SUPPLEMENTAL spec pins on top of
// scripts/tests/h25-test-authoring-lint.test.mjs (the base suite — NOT
// modified, NOT read for its implementation, only for its harness idiom and
// documented trigger/exemption semantics) while a fixer hardens
// scripts/hooks/h25-dispatch-capability.mjs in a parallel lane. It pins nine
// specific behaviors the base suite's cases do not exercise:
//
//   1. Clause-scoped negation: a prohibition clause about EXISTING tests
//      must not silence a SEPARATE authoring clause in the same brief.
//   2. A curly-apostrophe-free baseline control, paired with case 5.
//   3-4. Bare/singular "test" used as a manual-testing verb (not the plural
//      artifact noun) must not be mistaken for the authoring trigger.
//   5. A negation using the CURLY apostrophe (’, U+2019) must still be
//      recognized as a negation, not just the straight ' (U+0027).
//   6-7. "TDD" mentioned in a brief that says tests ALREADY EXIST (frozen /
//      already-exist phrasing) must not trigger — the base suite only pins
//      the positive "TDD: start with the tests" case, never this negative.
//   8. Combination with the base H25 capability advisory: BOTH advisories
//      must land in ONE additionalContext emission when a narrow-grant
//      dispatch's brief both names an ungranted tool and instructs test
//      authoring.
//   9. Robustness: a present-but-malformed .sterling/config.json must not
//      swallow or crash away the (unrelated) capability advisory.
//
// Every test also pins the cross-cutting posture invariant: exit code is
// NEVER 2 (this hook only ever advises, never denies), matching both base
// suites' posture tests.
//
// Per the anti-pattern on this path (knowledge_get
// ee89c3fd-c7d2-43a0-9d4b-e33465cd5c4c): never interpolate raw, possibly
// multi-line child-process stderr into an assertion message that is
// expected to fail — a stray "code:" line can start a YAML block and poison
// the TAP crash/assertion classifier. Every stderr interpolation below goes
// through oneLine() first.

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

// Flattens stderr for safe embedding in an assertion message that is
// expected to fail today (anti-pattern ee89c3fd).
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Same node-toolchain test_globs fixture convention as the base suite.
const CONFIG = {
  toolchains: [
    {
      adapter: 'node',
      path_globs: ['**/*.mjs', '**/*.ts'],
      test_globs: ['tests/**', '**/*.test.mjs'],
      run_commands: { test: 'node --test' },
    },
  ],
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h25-tal-hard-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Case 9's fixture: a PRESENT but syntactically INVALID .sterling/config.json
// — not missing, not empty, just malformed JSON. Distinguishes "no config"
// (which a robust hook should treat as absent-config-defaults) from
// "config present but unparseable" (which must not crash the whole hook).
function makeProjectBadConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h25-tal-hard-badcfg-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{ this is not valid JSON,,, ');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Broad grant covering every platform-tool token that might incidentally
// appear inside a test-authoring brief, so the PRE-EXISTING capability warn
// never fires and confounds the test-authoring-only cases (1-7).
const PIPELINE_TOOLS =
  'Read, Write, Edit, MultiEdit, Grep, Glob, Bash, WebSearch, WebFetch, Task, TodoWrite, mcp__plugin_sterling_sterling__knowledge_query';

// Case 8's fixture: a narrow grant that DELIBERATELY lacks Bash — mirrors
// the base capability suite's TEST_WRITER_TOOLS narrow-grant convention
// (scripts/tests/h25-dispatch-capability.test.mjs), but for a non-test-writer
// pipeline type so the test-authoring exemption does not also apply.
const CODER_TOOLS_NO_BASH =
  'Read, Write, Edit, MultiEdit, Grep, Glob, mcp__plugin_sterling_sterling__knowledge_query';

// Case 9's fixture: identical shape to the base capability suite's
// TEST_WRITER_TOOLS (Read/Write/Edit/MultiEdit/Grep/Glob + knowledge_query,
// no Bash, no Web*) so the pre-existing capability warn fires cleanly on a
// Bash mention while nothing about the brief triggers test-authoring.
const TEST_WRITER_TOOLS =
  'Read, Write, Edit, MultiEdit, Grep, Glob, mcp__sterling__knowledge_query, mcp__plugin_sterling_sterling__knowledge_query';

function writeAgentDef(dir, type, { tools = PIPELINE_TOOLS, body = 'Body prose for the agent definition.' } = {}) {
  const toolsLine = tools === undefined ? '' : `tools: ${tools}\n`;
  const content = `---\nname: ${type}\n${toolsLine}---\n${body}\n`;
  writeFileSync(join(dir, '.claude', 'agents', `${type}.md`), content);
}

function taskInput(cwd, { subagent_type, prompt, tool_name = 'Task' } = {}) {
  const tool_input = prompt === undefined && subagent_type === undefined
    ? {}
    : { ...(subagent_type !== undefined ? { subagent_type } : {}), ...(prompt !== undefined ? { prompt } : {}) };
  return { hook_event_name: 'PreToolUse', tool_name, tool_input, cwd };
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

// Tolerates empty stdout (today: possibly empty on a crash) without
// throwing; a present-but-garbled stdout is its own explicit failure, never
// a test-runner crash.
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

// Same loose, wording-free detector as the base suite: role name + hook
// name together, so the pre-existing capability warn can never be mistaken
// for this advisory.
function hasTestAuthoringAdvisory(ctx) {
  return /test-writer/i.test(ctx) && /\bH5\b/i.test(ctx);
}

function tokenRe(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i');
}

function assertNeverDenies(r, label) {
  assert.notEqual(r.code, 2, `H25 must never deny (exit 2) for ${label}; got exit ${r.code}, stderr: ${oneLine(r.stderr)}`);
}

function assertTestAuthoringWarn(r, label) {
  assertNeverDenies(r, label);
  assert.equal(
    r.code,
    0,
    `expected exit 0 (advisory only) for ${label}, got ${r.code}; stderr: ${oneLine(r.stderr)}`
  );
  const ctx = parseAdditionalContext(r);
  assert.ok(
    ctx.length > 0,
    `expected a non-empty test-authoring advisory in additionalContext for ${label}; got empty`
  );
  assert.match(ctx, /test-writer/i, `advisory for ${label} must name the test-writer role`);
  assert.match(ctx, /\bH5\b/i, `advisory for ${label} must name H5`);
}

function assertNoTestAuthoringAdvisory(r, label) {
  assertNeverDenies(r, label);
  const ctx = parseAdditionalContext(r);
  assert.equal(
    hasTestAuthoringAdvisory(ctx),
    false,
    `expected no test-authoring advisory for ${label}; got additionalContext: ${JSON.stringify(ctx)}`
  );
}

// ---------------------------------------------------------------------------
// Case 1 — clause-scoped negation: a prohibition about EXISTING tests must
// not silence a SEPARATE authoring clause for NEW tests in the same brief.
//
// EXPECTED FAILURE SHAPE against the current (unhardened) implementation: a
// whole-string negation guard that sees "don't" anywhere and suppresses the
// entire brief will produce an EMPTY additionalContext here (no advisory at
// all, since this fixture's broad PIPELINE_TOOLS grant keeps the capability
// warn silent too) — so `assert.ok(ctx.length > 0, ...)` inside
// assertTestAuthoringWarn is the assertion that fires RED. A clause-scoped
// guard (only suppresses the trigger inside the same clause as the
// negation) passes.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (1): "Don\'t touch the existing tests; write new tests for the new module." still warns — prohibition clause must not silence the separate authoring clause', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: "Don't touch the existing tests; write new tests for the new module.",
      }),
      dir
    );
    assertTestAuthoringWarn(r, 'clause-separated prohibition + authoring (case 1)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 2 — curly-apostrophe-free baseline control, paired with case 5. No
// negation at all, straightforward verb trigger: this must warn under BOTH
// the current implementation and the hardened one — it is the control that
// proves case 5's silence is due to the negation, not to the fixture being
// broken.
//
// EXPECTED SHAPE: GREEN already today — plain verb-trigger warn, no
// negation-handling nuance involved. Included here (rather than only in the
// base suite) to sit beside case 5 as its explicit pair.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (2): "Write new tests for the parser." warns — baseline control paired with case 5', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'Write new tests for the parser.' }),
      dir
    );
    assertTestAuthoringWarn(r, 'baseline control, no negation (case 2)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 3 — bare/singular "test" used as a manual-testing verb, decoupled
// from any "tests" (plural, artifact-noun) authoring phrasing.
//
// EXPECTED FAILURE SHAPE against the current implementation: if the verb
// trigger matches "write" anywhere in the brief regardless of its object,
// or treats singular "test" as equivalent to the plural authoring noun, it
// will wrongly warn — `hasTestAuthoringAdvisory(ctx)` will be true, so
// `assert.equal(hasTestAuthoringAdvisory(ctx), false, ...)` inside
// assertNoTestAuthoringAdvisory is the assertion that fires RED. A trigger
// scoped to "write/author/add/create" + the plural "tests" object (or a
// concrete test-glob path) passes silently.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (3): "Write the handler, then test the endpoint manually." never warns — bare singular "test" is manual-testing prose, not authoring', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Write the handler, then test the endpoint manually.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'bare singular "test", manual-testing phrasing (case 3)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 4 — same shape as case 3 with a different authoring-looking verb
// ("add") whose object is not tests at all.
//
// EXPECTED FAILURE SHAPE: identical to case 3 — a naive implementation that
// fires on "add" anywhere combined with the bare word "test" occurring
// later in the sentence (rather than "add ... tests") wrongly warns, and
// the same `assert.equal(hasTestAuthoringAdvisory(ctx), false, ...)`
// assertion fires RED.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (4): "Add the export column and test it against staging." never warns — neither trigger\'s object is "tests"', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Add the export column and test it against staging.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'bare "test" verb, unrelated "add" object (case 4)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 5 — curly-apostrophe negation control. Same prohibition as the base
// suite's straight-apostrophe negation cases, but spelled with the CURLY
// apostrophe (’, U+2019) that a real editor/LLM output commonly produces.
//
// EXPECTED FAILURE SHAPE (marked "possibly RED" — depends on whether the
// current negation guard already normalizes quote variants): if the
// negation regex matches only the literal straight apostrophe ("don't"),
// the curly-apostrophe "Don’t" will not be recognized as a negation, the
// verb trigger ("write tests") fires unguarded, and
// `assert.equal(hasTestAuthoringAdvisory(ctx), false, ...)` inside
// assertNoTestAuthoringAdvisory fires RED. A guard that normalizes both
// apostrophe forms (or matches on the bare stem "don" + "t") passes
// silently, matching case 2's paired warn behavior in the opposite
// (negated) direction.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (5): "Don’t write tests for this; implement the feature only." never warns — curly apostrophe negation must still be recognized', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Don’t write tests for this; implement the feature only.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'curly-apostrophe negation (case 5)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 6 — "TDD" mentioned where the brief explicitly says tests already
// exist (frozen). Must not trigger the TDD-first phrasing heuristic.
//
// EXPECTED FAILURE SHAPE: if the trigger fires on any brief containing the
// bare token "TDD" (as the base suite's own positive case, "TDD: start with
// the tests", suggests it does), it ignores the "already froze the suite"
// clause that negates the authoring intent, and
// `assert.equal(hasTestAuthoringAdvisory(ctx), false, ...)` fires RED. A
// trigger that requires TDD phrasing to co-occur with a forward-looking
// authoring verb (not "already exist(s)/froze/frozen") passes silently.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (6): "TDD: the test-writer already froze the suite — implement until green." never warns — tests already exist, nothing to author', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'TDD: the test-writer already froze the suite — implement until green.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'TDD mention, suite already frozen (case 6)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 7 — same "tests already exist" exemption as case 6, phrased without
// the colon-delimited "TDD:" form the base suite's positive case uses
// ("Per the TDD contract, ..." instead of "TDD: ...").
//
// EXPECTED FAILURE SHAPE: identical rationale to case 6 — a bare-token "TDD"
// match (with or without a following colon) wrongly warns, and the same
// `assert.equal(hasTestAuthoringAdvisory(ctx), false, ...)` assertion fires
// RED.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (7): "Per the TDD contract, the tests already exist — implement to green." never warns — non-colon TDD phrasing, same already-exist exemption', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Per the TDD contract, the tests already exist — implement to green.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'non-colon TDD phrasing, tests already exist (case 7)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 8 — combination with the pre-existing H25 capability advisory: a
// narrow-grant dispatch (mirrors h25-dispatch-capability.test.mjs's
// narrow-grant fixture convention) whose brief BOTH names an ungranted tool
// (Bash) AND instructs test authoring must emit BOTH advisories, joined in
// one emit.
//
// EXPECTED SHAPE: this exercises composition of two INDEPENDENTLY-specified
// advisories on the same hook entry. If either advisory is implemented
// standalone but the emit path only ever returns the FIRST match (an
// early-return bug) rather than concatenating every applicable advisory,
// one of the two `assert.match` calls below fires RED. Listed as a
// combination case rather than a guaranteed-red case because its outcome
// depends on how the (already-existing) capability advisory and the (newer)
// test-authoring advisory are wired together, not on either heuristic
// alone.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (8): narrow grant lacking Bash + brief naming Bash and instructing test authoring → BOTH advisories in one emit', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder', { tools: CODER_TOOLS_NO_BASH });
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Use Bash to run the suite, and write new tests for the module.',
      }),
      dir
    );
    assertNeverDenies(r, 'combined capability + test-authoring advisory (case 8)');
    assert.equal(
      r.code,
      0,
      `expected exit 0 (both advisories are warn-only) for case 8, got ${r.code}; stderr: ${oneLine(r.stderr)}`
    );
    const ctx = parseAdditionalContext(r);
    assert.ok(ctx.length > 0, 'expected a non-empty combined advisory for case 8; got empty');
    assert.match(ctx, tokenRe('Bash'), 'combined advisory must name the missing tool Bash (capability piece)');
    assert.match(ctx, /test-writer/i, 'combined advisory must name the test-writer role (test-authoring piece)');
    assert.match(ctx, /\bH5\b/i, 'combined advisory must name H5 (test-authoring piece)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 9 — robustness: a PRESENT but malformed .sterling/config.json must
// not swallow or crash away the (unrelated) capability advisory. This
// dispatch carries no test-authoring content at all — only the pre-existing
// missing-tool capability warn should fire, on a narrow grant lacking Bash.
//
// EXPECTED FAILURE SHAPE against the current implementation: if the hook
// reads and JSON.parse()s .sterling/config.json unconditionally (e.g. to
// resolve toolchain test_globs for the path trigger) without a try/catch
// around a malformed file, the uncaught exception crashes the process
// before any hookSpecificOutput JSON is printed to stdout. `r.code` becomes
// Node's default uncaught-exception exit status (commonly 1, never Node's
// own "2") so `assert.notEqual(r.code, 2, ...)` and the "0 or 1" check may
// both still pass, but stdout is empty — so
// `assert.ok(ctx.length > 0, ...)` is the assertion that fires RED, because
// the capability advisory that should still fire on the (unrelated,
// config-independent) missing-Bash grant never reaches stdout. A hook that
// guards its config read (try/catch, falls back to defaults on malformed
// JSON — same soft-degrade posture as H1's config read per hook-session-guards)
// passes: exit 0, capability advisory present, naming Bash.
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (9): malformed .sterling/config.json must not suppress or crash away an unrelated capability advisory', () => {
  const { dir, cleanup } = makeProjectBadConfig();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'run node --test via Bash and report counts',
      }),
      dir
    );
    assertNeverDenies(r, 'malformed config, capability-only dispatch (case 9)');
    assert.ok(
      r.code === 0 || r.code === 1,
      `expected exit 0 or 1 (never a crash exit outside that range, never 2) for case 9, got ${r.code}; stderr: ${oneLine(r.stderr)}`
    );
    const ctx = parseAdditionalContext(r);
    assert.ok(
      ctx.length > 0,
      'expected the capability advisory to still fire despite the malformed config; got empty additionalContext'
    );
    assert.match(ctx, tokenRe('Bash'), 'capability advisory must still name the missing tool Bash despite the malformed config');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Case 10 — dash/newline-split prohibition (board 07deffab EXTENDS,
// 2026-08-29 dome-farmer feedback: fired on briefs mentioning tests while
// explicitly FORBIDDING test writes).
// ---------------------------------------------------------------------------
test('H25-TAL-hardening (10): "Please do not —\\nwrite new tests for this change; just fix the parser bug." never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Please do not —\nwrite new tests for this change; just fix the parser bug.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'dash/newline-split prohibition (case 10)');
  } finally {
    cleanup();
  }
});

test('H25-TAL-hardening (11) CONTROL: an unrelated authoring clause after the same dash-split prohibition still warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Please do not touch the build config; write new tests for the parser module.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, 'genuinely separate authoring clause after unrelated prohibition (case 11)');
  } finally {
    cleanup();
  }
});
