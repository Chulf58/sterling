// H25 test-authoring dispatch-time lint (board 2f57ec84-d8f3-4ce4-96ad-1bc516ea6034)
// — SPEC ONLY, red-first, written before the implementation exists.
//
// H25 (scripts/hooks/h25-dispatch-capability.mjs, PreToolUse on Task|Agent)
// already ships ONE advisory (missing-tool capability warn — see
// scripts/tests/h25-dispatch-capability.test.mjs, which this file does NOT
// modify). This suite specifies a SECOND, independent WARN-ONLY advisory on
// the SAME hook entry: when the dispatched subagent_type is pipeline-class
// (PIPELINE_AGENT_TYPES in @sterling/schemas: test-writer, coder,
// reviewer-correctness, reviewer-security, reviewer-skeptic,
// reviewer-performance, implementation-architect, researcher, explorer) but
// NOT 'test-writer', AND the brief (tool_input.prompt) instructs test
// authoring — either a VERB TRIGGER (write/author/add/create tests, or
// TDD-first phrasing) or a PATH TRIGGER (a concrete path matching a
// declared toolchain test_glob) — the hook emits a loud advisory naming
// (a) that test authoring belongs to the test-writer role (doer/checker
// separation), (b) that H5 will deny test-path edits mid-work, (c) that
// this is a warning, not a denial. A negation ("do not write tests", "leave
// the tests alone") must NOT fire the verb trigger. Non-pipeline types
// (librarian, debugger, unknown/absent subagent_type) never trigger this
// lint. The hook NEVER denies for this advisory either: exit code is never
// 2, every triggering case still allows the dispatch.
//
// Today scripts/hooks/h25-dispatch-capability.mjs implements ONLY the
// missing-tool capability warn — this second advisory does not exist yet.
// Fixtures below deliberately grant broad tool sets (PIPELINE_TOOLS,
// including Write/Edit/Bash) to the dispatched agent so the PRE-EXISTING
// capability warn stays silent and does not confound these assertions; the
// new advisory is detected by a loose, wording-free heuristic (mentions
// both "test-writer" and "H5" in the same additionalContext string) so the
// implementation keeps its prose free while the trigger/no-trigger boundary
// stays pinned exactly.
//
// EXPECTED FAILURE SHAPE (today, for every WARN case below): the hook runs
// without crashing (r.code === 0, so that assertion passes) but emits NO
// additionalContext at all for these tool-token-free prompts, since the
// pre-existing capability warn has nothing to complain about and the new
// lint does not exist — so `assert.ok(ctx.length > 0, ...)` is the
// assertion that fails, called out per test below.
//
// EXPECTED SHAPE for every EXEMPT / NEGATION-GUARD / SILENT case: passes
// vacuously today (no advisory exists yet, so the "no advisory present"
// assertion is trivially true) — these tests go red only once a
// naive/over-eager implementation is built and are what pin the boundary.
//
// Harness mirrors scripts/tests/h25-dispatch-capability.test.mjs's
// spawnSync runHook idiom and scripts/tests/hooks-full.test.mjs's
// .sterling/config.json fixture convention (toolchains[].test_globs).

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

// Same node-toolchain test_globs convention used by
// scripts/tests/hooks-full.test.mjs and scripts/tests/enforcement.test.mjs
// fixtures: a dedicated tests/ directory tree plus a **/*.test.mjs pattern
// reaching test files colocated with source.
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h25-tal-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Broad grant covering every platform-tool token that might incidentally
// appear inside a test-authoring brief ("write", "edit tests", ...) so the
// PRE-EXISTING H25 missing-tool capability warn never fires and confounds
// the new-advisory assertions below.
const PIPELINE_TOOLS =
  'Read, Write, Edit, MultiEdit, Grep, Glob, Bash, WebSearch, WebFetch, Task, TodoWrite, mcp__plugin_sterling_sterling__knowledge_query';

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

// Loose, wording-free detector for the NEW advisory: both the role name and
// the enforcing hook must be named together in the same additionalContext
// string. Deliberately does not pin exact phrasing (rubric: assert warn
// content loosely) but is specific enough that the PRE-EXISTING capability
// warn (which never mentions H5 or the test-writer role by these tokens in
// these fixtures) cannot be mistaken for it.
function hasTestAuthoringAdvisory(ctx) {
  return /test-writer/i.test(ctx) && /\bH5\b/i.test(ctx);
}

function assertTestAuthoringWarn(r, { agentType }) {
  assert.equal(
    r.code,
    0,
    `expected exit 0 (advisory only, never a denial) for ${agentType}, got ${r.code}; stderr: ${r.stderr}`
  );
  const ctx = parseAdditionalContext(r);
  assert.ok(
    ctx.length > 0,
    `expected a non-empty test-authoring advisory in additionalContext for ${agentType}; today's hook has no such advisory so this is empty`
  );
  assert.match(ctx, /test-writer/i, 'advisory must name the test-writer role (doer/checker separation)');
  assert.match(ctx, /\bH5\b/i, 'advisory must name H5 as the hook that will deny test-path edits mid-work');
  assert.match(ctx, /warn(ing)?\b/i, 'advisory must state this is a warning, not a denial');
}

function assertNoTestAuthoringAdvisory(r, label) {
  assert.notEqual(r.code, 2, `H25 must never deny for ${label}; got exit 2, stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.equal(
    hasTestAuthoringAdvisory(ctx),
    false,
    `expected no test-authoring advisory for ${label}; got additionalContext: ${JSON.stringify(ctx)}`
  );
}

// ---------------------------------------------------------------------------
// VERB TRIGGER — pipeline-class, non-test-writer → WARN
// ---------------------------------------------------------------------------

test('H25-TAL WARN verb (1): coder told to "write failing tests first, then implement" → advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'Write failing tests first, then implement the parser.' }),
      dir
    );
    assertTestAuthoringWarn(r, { agentType: 'coder' });
  } finally {
    cleanup();
  }
});

test('H25-TAL WARN verb (2): reviewer-correctness told to "author tests for" the export function → advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'reviewer-correctness');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'reviewer-correctness',
        prompt: 'Author tests for the export function before reviewing the rest of the diff.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, { agentType: 'reviewer-correctness' });
  } finally {
    cleanup();
  }
});

test('H25-TAL WARN verb (3): researcher told to "add tests for" the new endpoint → advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'researcher');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'researcher',
        prompt: 'Add tests for the new endpoint and note any edge cases you find.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, { agentType: 'researcher' });
  } finally {
    cleanup();
  }
});

test('H25-TAL WARN verb (4): explorer given TDD-first phrasing ("TDD: start with the tests") → advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'explorer');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'explorer',
        prompt: 'TDD: start with the tests, then explore the rest of the module.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, { agentType: 'explorer' });
  } finally {
    cleanup();
  }
});

test('H25-TAL WARN verb (5): implementation-architect told to "create tests before" drafting the design → advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'implementation-architect');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'implementation-architect',
        prompt: 'Create tests before drafting the design document.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, { agentType: 'implementation-architect' });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PATH TRIGGER — concrete path matching a declared test_glob, with and
// without an authoring verb accompanying it.
// ---------------------------------------------------------------------------

test('H25-TAL WARN path, no verb (6): reviewer-security brief names tests/export.test.mjs (tests/** glob) → advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'reviewer-security');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'reviewer-security',
        prompt: 'Review the coverage described in tests/export.test.mjs and summarize the gaps you find.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, { agentType: 'reviewer-security' });
  } finally {
    cleanup();
  }
});

test('H25-TAL WARN path, no verb (7): reviewer-performance brief names packages/store/src/foo.test.mjs (**/*.test.mjs glob) → advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'reviewer-performance');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'reviewer-performance',
        prompt: 'The relevant fixture data lives in packages/store/src/foo.test.mjs; benchmark against it.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, { agentType: 'reviewer-performance' });
  } finally {
    cleanup();
  }
});

test('H25-TAL WARN path + verb (8): coder told to "add a new assertion to" tests/export.test.mjs → advisory', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Add a new assertion to tests/export.test.mjs for the edge case we discussed.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, { agentType: 'coder' });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// test-writer EXEMPTION — pipeline-class, but IS test-writer → never this
// lint's advisory, regardless of trigger.
// ---------------------------------------------------------------------------

test('H25-TAL EXEMPT (9): dispatching test-writer itself with a verb-trigger brief never warns this lint', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer');
    const r = runHook(
      taskInput(dir, { subagent_type: 'test-writer', prompt: 'Write failing tests first, then hand off.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'test-writer + verb trigger');
  } finally {
    cleanup();
  }
});

test('H25-TAL EXEMPT (10): dispatching test-writer itself with a path-trigger brief never warns this lint', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'The new cases belong in tests/export.test.mjs.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'test-writer + path trigger');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// NON-PIPELINE EXEMPTION — librarian, debugger, unknown, absent
// subagent_type never trigger this lint, even with a triggering brief.
// ---------------------------------------------------------------------------

test('H25-TAL EXEMPT (11): librarian (non-pipeline) with a verb-trigger brief never warns this lint', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'librarian');
    const r = runHook(
      taskInput(dir, { subagent_type: 'librarian', prompt: 'Write failing tests first, then apply the draft.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'librarian (non-pipeline)');
  } finally {
    cleanup();
  }
});

test('H25-TAL EXEMPT (12): debugger (non-pipeline) with a verb-trigger brief never warns this lint', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'debugger');
    const r = runHook(
      taskInput(dir, { subagent_type: 'debugger', prompt: 'Add tests for the bug repro before you root-cause it.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'debugger (non-pipeline)');
  } finally {
    cleanup();
  }
});

test('H25-TAL EXEMPT (13): unknown subagent_type (no installed definition) with a verb-trigger brief never warns this lint', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Deliberately no writeAgentDef call — 'ghost-agent' has no definition.
    const r = runHook(
      taskInput(dir, { subagent_type: 'ghost-agent', prompt: 'Author tests for the export function.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'unknown subagent_type');
  } finally {
    cleanup();
  }
});

test('H25-TAL EXEMPT (14): absent subagent_type entirely, with a verb-trigger brief, never warns this lint', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(taskInput(dir, { prompt: 'Write failing tests first, then implement.' }), dir);
    assertNoTestAuthoringAdvisory(r, 'absent subagent_type');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// NEGATION GUARD — prohibition phrasing must NOT fire the verb trigger.
// ---------------------------------------------------------------------------

test('H25-TAL NEGATION (15): "do not write tests; implement the feature only" never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'Do not write tests; implement the feature only.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'negation: do not write tests');
  } finally {
    cleanup();
  }
});

test('H25-TAL NEGATION (16): "don\'t touch the tests, just fix the bug" never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: "Don't touch the tests, just fix the bug." }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, "negation: don't touch the tests");
  } finally {
    cleanup();
  }
});

test('H25-TAL NEGATION (17): "never edit the tests — H5 will deny you" never warns (even though it names H5 itself)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'Never edit the tests — H5 will deny you.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'negation: never edit the tests — H5 will deny you');
  } finally {
    cleanup();
  }
});

test('H25-TAL NEGATION (18): "leave the tests alone and update the implementation" never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Leave the tests alone and update the implementation to match the new signature.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'negation: leave the tests alone');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// NO-TRIGGER SILENCE — neither trigger present, including boundary cases
// that a naive keyword-only implementation would wrongly fire on.
// ---------------------------------------------------------------------------

test('H25-TAL SILENT (19): coder brief with neither trigger ("implement the parser per the spec") never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'Implement the parser per the spec.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'no trigger');
  } finally {
    cleanup();
  }
});

test('H25-TAL SILENT (20): a named path that is NOT a test path (does not match any test_glob) never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Update packages/store/src/index.mjs to match the new signature.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'named path outside every test_glob');
  } finally {
    cleanup();
  }
});

test('H25-TAL SILENT (21): bare mention of "tests" as a noun, with no authoring verb, never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'The tests currently pass; move on to the documentation.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'bare "tests" noun, no verb');
  } finally {
    cleanup();
  }
});

test('H25-TAL SILENT (22): "testing" as a substring/homograph of "test" must not match — whole-word guard', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: "Let's test the waters on the new design before committing to it.",
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'homograph: "test the waters"');
  } finally {
    cleanup();
  }
});

test('H25-TAL SILENT (23): mentioning the "tests" directory generically (no concrete path, no verb) never warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder');
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Check the tests directory for existing coverage before you start.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'generic "tests directory" mention, no concrete path');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// POSTURE INVARIANT — never a denial (exit code is never 2) on every
// triggering case, verb or path, across every eligible pipeline type.
// ---------------------------------------------------------------------------

test('H25-TAL posture (24): exit code is never 2 across every triggering case (verb and path, several pipeline types)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const cases = [
      { subagent_type: 'coder', prompt: 'Write failing tests first, then implement the parser.' },
      { subagent_type: 'reviewer-security', prompt: 'Review the coverage in tests/export.test.mjs.' },
      { subagent_type: 'reviewer-skeptic', prompt: 'Add tests for the boundary cases you find suspicious.' },
      { subagent_type: 'explorer', prompt: 'TDD: start with the tests, then explore the module.' },
    ];
    for (const c of cases) {
      writeAgentDef(dir, c.subagent_type);
      const r = runHook(taskInput(dir, c), dir);
      assert.notEqual(
        r.code,
        2,
        `expected this hook to never deny (exit 2) for a triggering brief on ${c.subagent_type}; stderr: ${r.stderr}`
      );
    }
  } finally {
    cleanup();
  }
});
