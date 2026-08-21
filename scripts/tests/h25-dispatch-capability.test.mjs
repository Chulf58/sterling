// H25 dispatch-time tool-capability advisory (board f42e5313) — SPEC ONLY,
// red-first.
//
// Governing decision: knowledge_get dc6c1afb-2fdf-4fa1-a303-f9bc476d086e
// (slug dispatch-capability-advisory-h25) is the authority on semantics.
// Summary pinned here for the reader, not a re-derivation: a new hook,
// scripts/hooks/h25-dispatch-capability.mjs, joins the existing PreToolUse
// Task|Agent entry. It resolves the dispatch's subagent_type to the
// INSTALLED agent definition (<project>/.claude/agents/<subagent_type>.md
// frontmatter `tools:` line — the live per-machine truth, not the shipped
// template), scans the outgoing prompt for KNOWN TOOL-NAME TOKENS (platform
// tools plus Sterling MCP short names, matched as WHOLE TOKENS, both bare
// and mcp-prefixed forms — a short name is granted when the frontmatter
// holds ANY mcp-prefixed form of it, e.g. mcp__sterling__X or
// mcp__plugin_sterling_sterling__X), and when the brief names tools the
// agent does not hold, emits a LOUD WARNING via
// hookSpecificOutput.additionalContext to the DISPATCHER — naming each
// missing tool, the agent type, the agent's actual grant (or that the tool
// is absent from it), and the remedy (re-target / re-scope / state why the
// mention is not a requirement). This hook NEVER denies: every case below
// exits 0, warn-only, because a brief may mention a tool in a prohibition or
// as context rather than a requirement (false-block risk). An unknown
// subagent_type (no installed file) emits a DIFFERENT, distinct notice —
// capability cannot be checked at all — rather than the missing-tool
// warning shape. A missing `tools:` line means all-tools (the platform
// default) and stays silent. Malformed input allows silently, no crash.
//
// scripts/hooks/h25-dispatch-capability.mjs DOES NOT EXIST YET (confirmed
// via Glob before writing this file: zero matches). Every test below is RED
// against today's tree: spawnSync launches `node <missing-path>`, node exits
// nonzero with a "Cannot find module" stderr, so the FIRST assertion in
// every helper — `assert.equal(r.code, 0, ...)` — fails as a plain,
// catchable AssertionError before any stdout JSON is ever parsed. That
// failure shape is the correct and expected one for this spec-only phase
// and is called out per-test below and in the handoff.
//
// Harness idiom mirrors scripts/tests/h24-gate-exit-lint.test.mjs's
// spawnSync runHook idiom (process.execPath + hook path, JSON stdin,
// {code,stdout,stderr} return), pointed at
// scripts/hooks/h25-dispatch-capability.mjs. This hook reads INSTALLED
// agent definitions from <project>/.claude/agents/<subagent_type>.md, so
// each fixture writes that file (YAML frontmatter + body prose) inside a
// temp project dir rather than a store — no SterlingStore import/before()
// hook is needed.

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

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h25-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Writes <dir>/.claude/agents/<type>.md. `tools` is the raw value of the
// frontmatter `tools:` line (a comma-separated string), or `undefined` to
// omit the `tools:` line entirely (case 9 — all-tools default).
function writeAgentDef(dir, type, { tools, body = 'Body prose for the agent definition.' } = {}) {
  const toolsLine = tools === undefined ? '' : `tools: ${tools}\n`;
  const content = `---\nname: ${type}\n${toolsLine}---\n${body}\n`;
  writeFileSync(join(dir, '.claude', 'agents', `${type}.md`), content);
}

// Input shape per the task: {hook_event_name:'PreToolUse', tool_name:'Task',
// tool_input:{subagent_type, prompt}, cwd}.
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

function runHookRaw(rawStdin, cwd) {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: rawStdin,
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Parses stdout as the hookSpecificOutput envelope, tolerating empty stdout
// (today: always empty, since the hook does not exist). Never throws on
// invalid JSON from a present-but-garbled stdout — that is a distinct,
// explicit assertion failure, not a test-runner crash.
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

function tokenRe(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i');
}

// Asserts the advisory-warning shape: exit 0 (never a denial), non-empty
// additionalContext naming every missing tool, the agent type, the agent's
// actual grant, and a remedy.
function assertCapabilityWarn(r, { missingTools, agentType, grantSubstring }) {
  assert.equal(
    r.code,
    0,
    `expected exit 0 (advisory only, never a denial), got ${r.code}; stderr: ${r.stderr}`
  );
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, 'expected a non-empty capability warning in additionalContext');
  for (const tool of missingTools) {
    assert.match(ctx, tokenRe(tool), `warning must name the missing tool '${tool}'`);
  }
  assert.match(
    ctx,
    tokenRe(agentType),
    `warning must name the agent type '${agentType}'`
  );
  assert.ok(
    ctx.includes(grantSubstring),
    `warning must state the agent's actual grant (expected to include ${JSON.stringify(grantSubstring)}); got: ${ctx}`
  );
  assert.match(
    ctx,
    /re-target|re-scope|not a requirement/i,
    'warning must state a remedy: re-target, re-scope, or why the mention is not a requirement'
  );
}

// Asserts the DIFFERENT "capability cannot be checked" shape for an unknown
// installed agent (no definition file) — distinct wording from the
// missing-tool warning; still exit 0.
function assertUnknownAgentNotice(r, { agentType }) {
  assert.equal(
    r.code,
    0,
    `expected exit 0 (advisory only, never a denial), got ${r.code}; stderr: ${r.stderr}`
  );
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, 'expected a non-empty notice in additionalContext');
  assert.match(
    ctx,
    /cannot be checked/i,
    'unknown-agent notice must say capability cannot be checked'
  );
  assert.match(ctx, tokenRe(agentType), 'unknown-agent notice must name the subagent_type');
  assert.doesNotMatch(
    ctx,
    /is missing|does not hold|lacks/i,
    'unknown-agent notice must be a DISTINCT shape from the missing-tool warning, not a claim about a specific grant it cannot know'
  );
}

// Asserts silence: exit 0, and no capability-warning content landed in
// additionalContext at all.
function assertSilent(r) {
  assert.equal(
    r.code,
    0,
    `expected exit 0 (silent case), got ${r.code}; stderr: ${r.stderr}`
  );
  const ctx = parseAdditionalContext(r);
  assert.equal(
    ctx,
    '',
    `expected no capability-warning additionalContext for a silent case; got: ${JSON.stringify(ctx)}`
  );
}

// ---------------------------------------------------------------------------
// Fixture: the exact agent shape given by the task — a 'test-writer' grant
// with Read/Write/Edit/MultiEdit/Grep/Glob plus both an mcp__sterling__ and
// an mcp__plugin_sterling_sterling__ prefixed knowledge_query — but NO Bash
// and NO WebSearch/WebFetch.
// ---------------------------------------------------------------------------
const TEST_WRITER_TOOLS =
  'Read, Write, Edit, MultiEdit, Grep, Glob, mcp__sterling__knowledge_query, mcp__plugin_sterling_sterling__knowledge_query';

// ---------------------------------------------------------------------------
// WARN cases
// ---------------------------------------------------------------------------

test('H25 WARN (1): brief says "run node --test via Bash and report counts", agent lacks Bash → warning names Bash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    // EXPECTED FAILURE SHAPE (today, hook missing): assert.equal(r.code, 0)
    // fails first — r.code is node's "Cannot find module" nonzero exit, not 0.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'run node --test via Bash and report counts',
      }),
      dir
    );
    assertCapabilityWarn(r, {
      missingTools: ['Bash'],
      agentType: 'test-writer',
      grantSubstring: TEST_WRITER_TOOLS,
    });
  } finally {
    cleanup();
  }
});

test('H25 WARN (1b, case-insensitivity): lowercase "bash" in the brief still warns naming Bash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'run node --test via bash and report counts',
      }),
      dir
    );
    assertCapabilityWarn(r, {
      missingTools: ['Bash'],
      agentType: 'test-writer',
      grantSubstring: TEST_WRITER_TOOLS,
    });
  } finally {
    cleanup();
  }
});

test('H25 WARN (2): brief mentions bare "maintenance_query"/"maintenance_remove", grant holds neither in any form', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'librarian', {
      tools: 'mcp__plugin_sterling_sterling__knowledge_query',
    });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'librarian',
        prompt: 'then call maintenance_query and close items with maintenance_remove',
      }),
      dir
    );
    assertCapabilityWarn(r, {
      missingTools: ['maintenance_query', 'maintenance_remove'],
      agentType: 'librarian',
      grantSubstring: 'mcp__plugin_sterling_sterling__knowledge_query',
    });
  } finally {
    cleanup();
  }
});

test('H25 WARN (3): tool_name "Agent" (not "Task") behaves identically to case 1', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first. Pins that
    // H25 rides the SAME entry for tool_name 'Task' and 'Agent'.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'run node --test via Bash and report counts',
        tool_name: 'Agent',
      }),
      dir
    );
    assertCapabilityWarn(r, {
      missingTools: ['Bash'],
      agentType: 'test-writer',
      grantSubstring: TEST_WRITER_TOOLS,
    });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SILENT cases (exit 0, no capability warning at all)
// ---------------------------------------------------------------------------

test('H25 SILENT (4): every mentioned tool is granted (brief mentions Read and Grep; grant has them)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first (nonzero
    // module-not-found exit) — the pre-implementation stdout is empty, so a
    // naive "no warning present" check would wrongly pass; the r.code
    // assertion is what keeps this test honestly red today.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'use Read to open the file, then Grep for the pattern',
      }),
      dir
    );
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H25 SILENT (5): brief mentions bare "knowledge_query"; grant holds mcp__plugin_sterling_sterling__knowledge_query → granted, silent', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first. Pins the
    // converse of case 2: a bare short-name mention IS satisfied by ANY
    // mcp-prefixed grant of that same short name.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'call knowledge_query to retrieve the relevant articles first',
      }),
      dir
    );
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H25 SILENT (6): no tool tokens at all in the brief', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'summarize the architecture of the store',
      }),
      dir
    );
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('H25 SILENT (7): a tool name as a substring of a longer word ("Bashful", "website") must NOT match — whole-token matching only', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first. This
    // fixture's grant deliberately lacks Bash and WebSearch/WebFetch, so if
    // the implementation ever regresses to substring matching, it would
    // wrongly warn about Bash/Web* here — the silence assertion pins the
    // correct, whole-token behavior.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'test-writer',
        prompt: "don't be Bashful about checking the website for the changelog",
      }),
      dir
    );
    assertSilent(r);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unknown installed agent — a DIFFERENT, distinct notice
// ---------------------------------------------------------------------------

test('H25 (8): unknown subagent_type (no installed .claude/agents/<type>.md) warns capability cannot be checked', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Deliberately no writeAgentDef call — 'ghost-agent' has no definition
    // file anywhere under <dir>/.claude/agents/.
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'ghost-agent',
        prompt: 'run node --test via Bash and report counts',
      }),
      dir
    );
    assertUnknownAgentNotice(r, { agentType: 'ghost-agent' });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Missing `tools:` line — all-tools default
// ---------------------------------------------------------------------------

test('H25 SILENT (9): frontmatter has no "tools:" line at all → all-tools default, silent even when the brief says Bash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'all-tools-agent', { tools: undefined });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first.
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'all-tools-agent',
        prompt: 'run node --test via Bash and report counts',
      }),
      dir
    );
    assertSilent(r);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Fail posture — malformed stdin / missing fields
// ---------------------------------------------------------------------------

test('H25 fail posture (10a): malformed (non-JSON) stdin — exit 0, no crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE (today): the module-not-found exit is very
    // unlikely to equal 0, so assert.equal(r.code, 0) fails.
    const r = runHookRaw('this is not { json at all', dir);
    assert.equal(r.code, 0, `expected exit 0 on malformed stdin, got ${r.code}; stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H25 fail posture (10b): missing tool_input.prompt — exit 0, no crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'test-writer', { tools: TEST_WRITER_TOOLS });
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first.
    const r = runHook(
      { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'test-writer' }, cwd: dir },
      dir
    );
    assert.equal(r.code, 0, `expected exit 0 with missing prompt, got ${r.code}; stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('H25 fail posture (10c): missing tool_input.subagent_type — exit 0, no crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    // EXPECTED FAILURE SHAPE: assert.equal(r.code, 0) fails first.
    const r = runHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: { prompt: 'run node --test via Bash and report counts' },
        cwd: dir,
      },
      dir
    );
    assert.equal(r.code, 0, `expected exit 0 with missing subagent_type, got ${r.code}; stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Review-mandated additions (2026-08-21 correctness review): D1 grant-form
// robustness, D2 prefix-aware scan, D3 English-homograph exclusion, D4 the
// never-blocks failure path.
// ---------------------------------------------------------------------------

test('review D2: a brief naming only the mcp-prefixed form of an ungranted tool still warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'librarian', { tools: 'Read, mcp__plugin_sterling_sterling__knowledge_query' });
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'librarian',
        prompt: 'Close each item with mcp__plugin_sterling_sterling__maintenance_remove when its check passes.',
      }),
      dir
    );
    assertCapabilityWarn(r, {
      missingTools: ['maintenance_remove'],
      agentType: 'librarian',
      grantSubstring: 'mcp__plugin_sterling_sterling__knowledge_query',
    });
  } finally {
    cleanup();
  }
});

test('review D1: a flow-style tools: [A, B] grant is parsed — granted mentions stay silent', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'coder', { tools: '[Bash, Grep]' });
    const r = runHook(
      taskInput(dir, { subagent_type: 'coder', prompt: 'run node --test via Bash and Grep the counts' }),
      dir
    );
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('review D1: a tools: value parsing to zero tokens (YAML block list) is UNEVALUABLE — silent, never an empty grant', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Block-list form: the line-scoped parser sees an empty value; asserting
    // "missing" from a grant it could not read would be a false claim.
    const content = `---\nname: blocky\ntools:\n  - Read\n  - Bash\n---\nBody.\n`;
    writeFileSync(join(dir, '.claude', 'agents', 'blocky.md'), content);
    const r = runHook(
      taskInput(dir, { subagent_type: 'blocky', prompt: 'run node --test via Bash and report counts' }),
      dir
    );
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('review D3: English-homograph prose (task/read/Write your findings) never warns — those tokens are deliberately unscanned', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeAgentDef(dir, 'reviewer-correctness', { tools: 'Read, Grep, Glob' });
    const r = runHook(
      taskInput(dir, {
        subagent_type: 'reviewer-correctness',
        prompt:
          'Your task is to review the diff. Never edit or write files — read-only. Write your findings as your final message; the agent must not fix anything.',
      }),
      dir
    );
    assertSilent(r);
  } finally {
    cleanup();
  }
});

test('review D4: an unreadable agent definition (directory at the path) is loud but NEVER a block — exit code is not 2', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.claude', 'agents', 'dirtype.md'), { recursive: true });
    const r = runHook(
      taskInput(dir, { subagent_type: 'dirtype', prompt: 'run node --test via Bash and report counts' }),
      dir
    );
    assert.notEqual(r.code, 2, `advisory must never block; got exit 2 with stderr: ${r.stderr}`);
  } finally {
    cleanup();
  }
});
