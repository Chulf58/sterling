// H25/H26 ADVISORY-PRECISION FIX — SPEC ONLY. Written from board a6b76e8c
// (todo, "H25/H26 advisory precision") and research_finding dff23647 (the
// 2026-08-24 audit of that item, section "[a6b76e8c] H25/H26 advisory
// precision") — BOTH are knowledge-base records (spec), never implementation
// files. This file does NOT read scripts/hooks/h25-dispatch-capability.mjs or
// scripts/hooks/h26-dispatch-overlap.mjs; harness idiom and existing
// trigger/exemption semantics are learned from
// scripts/tests/h25-dispatch-capability.test.mjs,
// scripts/tests/h25-test-authoring-lint.test.mjs,
// scripts/tests/h25-test-authoring-lint-hardening.test.mjs, and
// scripts/tests/h26-dispatch-overlap.test.mjs (all tests, never their
// subjects' source).
//
// research_finding dff23647 gives the PRECISE current-behavior baseline
// (measured against the live bundle, not inferred): the capability advisory
// (findMentionedTools) is a bare whole-token scan with ZERO prohibition or
// hedge awareness; the test-authoring VERB/TDD trigger already has a
// clause-scoped negation guard (NEGATION_RE + CLAUSE_SPLIT_RE), but the
// PATH trigger has NONE; H26 has neither a negation guard nor any
// read-only-class check at all (grep count 0). Each test below states
// whether it is expected GREEN today (an already-correct behavior this fix
// must not regress — a CONTROL) or RED today (the measured, still-open
// false positive this fix must close), citing that baseline rather than
// guessing. Every test also names the one-line SABOTAGE that must flip it.
//
// Agent-grant fixtures are copied VERBATIM from the currently installed
// .claude/agents/*.md frontmatter `tools:` lines (Read-permitted; frontmatter
// config, not hook implementation) so each capability gap is a REAL,
// presently-live grant shape, not invented: reviewer-correctness has no
// board_get/board_query/maintenance_*/Write/Edit/Bash; coder has no
// board_remove/board_update/board_add/maintenance_remove; test-writer has no
// Bash/WebSearch/WebFetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H25_PATH = join(HOOKS, 'h25-dispatch-capability.mjs');
const H26_PATH = join(HOOKS, 'h26-dispatch-overlap.mjs');

// ===========================================================================
// Shared run/parse plumbing (mirrors both base suites' spawnSync idiom)
// ===========================================================================

function runHook(hookPath, input, cwd) {
  const r = spawnSync(process.execPath, [hookPath], {
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

function tokenRe(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i');
}

function pathRe(p) {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc.replace(/\//g, '\\/'), 'i');
}

function assertNeverDenies(r, label) {
  assert.notEqual(r.code, 2, `must never deny (exit 2) for ${label}; got ${r.code}, stderr: ${r.stderr}`);
}

// ===========================================================================
// H25 fixtures
// ===========================================================================

function makeH25Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h25h26-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeH25ProjectWithTestGlobs() {
  const { dir, cleanup } = makeH25Project();
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({
      toolchains: [
        { adapter: 'node', path_globs: ['**/*.mjs', '**/*.ts'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } },
      ],
    })
  );
  return { dir, cleanup };
}

function writeAgentDef(dir, type, tools) {
  const content = `---\nname: ${type}\ntools: ${tools}\n---\nBody prose for the agent definition.\n`;
  writeFileSync(join(dir, '.claude', 'agents', `${type}.md`), content);
}

function h25TaskInput(dir, { subagent_type, prompt, tool_name = 'Task' }) {
  return { hook_event_name: 'PreToolUse', tool_name, tool_input: { subagent_type, prompt }, cwd: dir };
}

// Verbatim from the currently installed frontmatter (Read-permitted; config,
// not hook implementation) — real, live grant shapes, not invented ones.
const REVIEWER_CORRECTNESS_TOOLS =
  'Read, Grep, Glob, ToolSearch, mcp__sterling__knowledge_query, mcp__plugin_sterling_sterling__knowledge_query, mcp__sterling__knowledge_get, mcp__plugin_sterling_sterling__knowledge_get, mcp__sterling__handoff_read, mcp__plugin_sterling_sterling__handoff_read, mcp__sterling__handoff_write, mcp__plugin_sterling_sterling__handoff_write, mcp__sterling__agent_exit, mcp__plugin_sterling_sterling__agent_exit';
const TEST_WRITER_TOOLS =
  'Read, Write, Edit, MultiEdit, Grep, Glob, ToolSearch, mcp__sterling__knowledge_query, mcp__plugin_sterling_sterling__knowledge_query, mcp__sterling__knowledge_get, mcp__plugin_sterling_sterling__knowledge_get, mcp__sterling__board_query, mcp__plugin_sterling_sterling__board_query, mcp__sterling__board_get, mcp__plugin_sterling_sterling__board_get, mcp__sterling__handoff_read, mcp__plugin_sterling_sterling__handoff_read, mcp__sterling__handoff_write, mcp__plugin_sterling_sterling__handoff_write, mcp__sterling__agent_exit, mcp__plugin_sterling_sterling__agent_exit';
const CODER_TOOLS =
  'Read, Edit, Write, Grep, Glob, Bash, ToolSearch, mcp__sterling__knowledge_query, mcp__plugin_sterling_sterling__knowledge_query, mcp__sterling__knowledge_get, mcp__plugin_sterling_sterling__knowledge_get, mcp__sterling__board_query, mcp__plugin_sterling_sterling__board_query, mcp__sterling__board_get, mcp__plugin_sterling_sterling__board_get, mcp__sterling__handoff_read, mcp__plugin_sterling_sterling__handoff_read, mcp__sterling__handoff_write, mcp__plugin_sterling_sterling__handoff_write, mcp__sterling__agent_exit, mcp__plugin_sterling_sterling__agent_exit';

function assertCapabilityWarn(r, { missingTools, agentType, grantSubstring }) {
  assert.equal(r.code, 0, `expected exit 0 (advisory only), got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, 'expected a non-empty capability warning');
  for (const tool of missingTools) assert.match(ctx, tokenRe(tool), `must name missing tool '${tool}'`);
  assert.match(ctx, tokenRe(agentType), `must name the agent type '${agentType}'`);
  assert.ok(ctx.includes(grantSubstring), `must state the agent's actual grant; got: ${ctx}`);
  assert.match(ctx, /re-target|re-scope|not a requirement/i, 'must state a remedy');
}

function assertNoCapabilityMention(r, tool, label) {
  assertNeverDenies(r, label);
  const ctx = parseAdditionalContext(r);
  // The tool must not appear framed as a missing-grant claim (is missing /
  // does not hold / lacks); a tool token could legitimately appear elsewhere
  // in an unrelated advisory, so this checks the FRAMING, not bare absence.
  const framed = new RegExp(`${tool}[^.]*(is missing|does not hold|lacks)|( is missing|does not hold|lacks)[^.]*${tool}`, 'i');
  assert.doesNotMatch(ctx, framed, `must not warn that '${tool}' is missing for ${label}; got: ${JSON.stringify(ctx)}`);
}

function assertSilent(r, label) {
  assertNeverDenies(r, label);
  assert.equal(r.code, 0, `expected exit 0 for ${label}, got ${r.code}; stderr: ${r.stderr}`);
  assert.equal(parseAdditionalContext(r), '', `expected no advisory for ${label}`);
}

function assertUnknownAgentNotice(r, agentType) {
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, 'expected a non-empty unknown-agent notice');
  assert.match(ctx, /cannot be checked/i, 'must say capability cannot be checked');
  assert.match(ctx, tokenRe(agentType), 'must name the subagent_type');
}

function hasTestAuthoringAdvisory(ctx) {
  return /test-writer/i.test(ctx) && /\bH5\b/i.test(ctx);
}

function assertTestAuthoringWarn(r, label) {
  assertNeverDenies(r, label);
  assert.equal(r.code, 0, `expected exit 0 for ${label}, got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.ok(hasTestAuthoringAdvisory(ctx), `expected test-authoring advisory for ${label}; got: ${JSON.stringify(ctx)}`);
}

function assertNoTestAuthoringAdvisory(r, label) {
  assertNeverDenies(r, label);
  const ctx = parseAdditionalContext(r);
  assert.equal(hasTestAuthoringAdvisory(ctx), false, `expected no test-authoring advisory for ${label}; got: ${JSON.stringify(ctx)}`);
}

// ---------------------------------------------------------------------------
// (a) TRUE-POSITIVE CONTROL FIRST — real grant gap (reviewer-correctness has
// no board_get, verbatim from .claude/agents/reviewer-correctness.md).
// TODAY: per research_finding dff23647, findMentionedTools is a bare
// whole-token scan with zero prohibition/hedge awareness — this ALREADY
// fires correctly today. GREEN now; pinned so the coming negation/hedge
// generalization cannot regress a genuine requirement into silence.
// SABOTAGE: apply the new read-only/reviewer-class exemption (built for H25
// pin f / H26 pin i) to the CAPABILITY advisory as well — one added early
// return `if (isReviewOnlyClass(subagentType)) return [];` before the
// missing-tool scan — swallows this genuine gap and flips the test red.
// ---------------------------------------------------------------------------
test('H25 (a) TRUE-POSITIVE CONTROL: reviewer-correctness told to read its spec via knowledge_get (granted) and board_get (NOT granted) — still warns', () => {
  const { dir, cleanup } = makeH25Project();
  try {
    writeAgentDef(dir, 'reviewer-correctness', REVIEWER_CORRECTNESS_TOOLS);
    const r = runHook(
      H25_PATH,
      h25TaskInput(dir, {
        subagent_type: 'reviewer-correctness',
        prompt: 'First read the decision via knowledge_get <id>, then read the board item via board_get <id> before reviewing.',
      }),
      dir
    );
    assertCapabilityWarn(r, { missingTools: ['board_get'], agentType: 'reviewer-correctness', grantSubstring: REVIEWER_CORRECTNESS_TOOLS });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) "You hold no Bash by design" → no Bash-capability advisory.
// Matches board a6b76e8c's measured example (b) verbatim.
// TODAY: RED — capability advisory has no hedge/self-disclosure awareness
// (dff23647), so "no Bash by design" is scanned as a bare mention and warns.
// SABOTAGE: remove the hedge-phrase exclusion (a one-line guard skipping a
// tool token that appears inside "no <tool>"/"without <tool>"/"by design"
// phrasing before adding it to the missing-tool list).
// ---------------------------------------------------------------------------
test('H25 (c): "You hold no Bash by design" to test-writer → no Bash-capability advisory', () => {
  const { dir, cleanup } = makeH25Project();
  try {
    writeAgentDef(dir, 'test-writer', TEST_WRITER_TOOLS);
    const r = runHook(
      H25_PATH,
      h25TaskInput(dir, {
        subagent_type: 'test-writer',
        prompt: 'You hold no Bash by design; use Read and Grep to gather evidence instead.',
      }),
      dir
    );
    assertSilent(r, 'no-Bash-by-design disclosure');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (d) implement-context: "implement the board_remove refusal in TypeScript"
// → no board_remove advisory. Matches board a6b76e8c's measured example (a).
// TODAY: RED — same bare-scan defect; "board_remove" is mentioned as an
// implementation TARGET, not a call requirement, but the scan cannot tell.
// SABOTAGE: remove the implement-context exclusion (a one-line guard
// skipping a tool token preceded by "implement"/"in TypeScript"/a .ts path
// within the same clause).
// ---------------------------------------------------------------------------
test('H25 (d): "implement the board_remove refusal in TypeScript" to coder → no board_remove advisory', () => {
  const { dir, cleanup } = makeH25Project();
  try {
    writeAgentDef(dir, 'coder', CODER_TOOLS);
    const r = runHook(
      H25_PATH,
      h25TaskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Implement the board_remove refusal path in TypeScript inside packages/mcp-server/src/tools.ts.',
      }),
      dir
    );
    assertSilent(r, 'implement-context board_remove mention');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (e) built-in subagent types never get the "cannot be checked" notice;
// a genuinely unknown custom type still does (control pair, control first).
// 'general-purpose' is CONFIRMED live in this repo's own KB (research_finding
// ffa6219c's SubagentStart probe captured agent_type:"general-purpose" on
// the platform's built-in fallback agent). The second built-in
// ('statusline-setup') is documented Claude Code platform behavior (the
// built-in agent backing the /statusline setup flow), not a Sterling
// artifact and not verifiable from this repo's KB — flagged here as an
// assumption for the conductor to confirm rather than silently asserted.
// TODAY: the control (genuinely unknown type) is GREEN (dff23647: 3 of 7
// firings were exactly the false-positive "general-purpose has no
// definition file" case, i.e. the unknown-agent notice already fires
// correctly for a truly unknown type — it is firing on built-ins too that
// it should not). The two built-in cases are RED today.
// SABOTAGE: remove the built-in allowlist check (one line: delete
// `if (BUILTIN_SUBAGENT_TYPES.has(subagentType)) return [];` before the
// existsSync/notice path) — flips both built-in tests red; the control is
// unaffected by this specific sabotage (proving the allowlist is scoped, not
// a blanket "never warn on missing file" regression).
// ---------------------------------------------------------------------------
test('H25 (e) CONTROL: a genuinely unknown custom subagent_type still gets the cannot-be-checked notice', () => {
  const { dir, cleanup } = makeH25Project();
  try {
    const r = runHook(
      H25_PATH,
      h25TaskInput(dir, { subagent_type: 'totally-unknown-widget-agent-zzz', prompt: 'run node --test via Bash' }),
      dir
    );
    assertUnknownAgentNotice(r, 'totally-unknown-widget-agent-zzz');
  } finally {
    cleanup();
  }
});

test('H25 (e): built-in subagent_type "general-purpose" (no installed def file) never gets the cannot-be-checked notice', () => {
  const { dir, cleanup } = makeH25Project();
  try {
    const r = runHook(H25_PATH, h25TaskInput(dir, { subagent_type: 'general-purpose', prompt: 'run node --test via Bash' }), dir);
    assertSilent(r, 'built-in general-purpose');
  } finally {
    cleanup();
  }
});

test('H25 (e): built-in subagent_type "statusline-setup" (no installed def file) never gets the cannot-be-checked notice', () => {
  const { dir, cleanup } = makeH25Project();
  try {
    const r = runHook(H25_PATH, h25TaskInput(dir, { subagent_type: 'statusline-setup', prompt: 'run node --test via Bash' }), dir);
    assertSilent(r, 'built-in statusline-setup');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b1) literal-wording regression control: prohibition around the VERB
// trigger. TODAY: GREEN — dff23647 confirms NEGATION_RE is already wired to
// the verb/TDD trigger. Pinned so the coming path-trigger negation fix (b2)
// does not accidentally narrow or remove the working verb-trigger guard.
// SABOTAGE: unbind NEGATION_RE from the verb/TDD trigger (one line removing
// the `if (negated) return false;` inside the verb-trigger check).
// ---------------------------------------------------------------------------
test('H25 (b1) CONTROL: "DO NOT create or edit any test files" to coder never warns (verb-trigger negation, already correct)', () => {
  const { dir, cleanup } = makeH25ProjectWithTestGlobs();
  try {
    writeAgentDef(dir, 'coder', CODER_TOOLS);
    const r = runHook(
      H25_PATH,
      h25TaskInput(dir, { subagent_type: 'coder', prompt: 'Fix the bug in the parser. DO NOT create or edit any test files.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'prohibition around create/edit test files (verb trigger)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b2) the measured still-open gap: prohibition around the PATH trigger.
// TODAY: RED — dff23647: "hasPathTrigger... has no negation guard, so a
// brief naming a frozen test file IN ORDER TO FORBID IT always fires."
// SABOTAGE: remove the (to-be-added) negation guard from the path-trigger
// check (one line) — reverts to today's always-fires behavior.
// ---------------------------------------------------------------------------
test('H25 (b2): "DO NOT EDIT tests/export.test.mjs — it is frozen" to coder never warns (path-trigger negation, currently missing)', () => {
  const { dir, cleanup } = makeH25ProjectWithTestGlobs();
  try {
    writeAgentDef(dir, 'coder', CODER_TOOLS);
    const r = runHook(
      H25_PATH,
      h25TaskInput(dir, { subagent_type: 'coder', prompt: 'DO NOT EDIT tests/export.test.mjs — it is frozen for this phase. Fix the parser only.' }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'prohibition naming a frozen test path (path trigger)');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (f) reviewer-class review-not-author variant (board a6b76e8c's 2026-08-24
// addendum, "review-not-author variant") vs. a coder-class dispatch WITH a
// genuine authoring instruction (control, placed first). NOTE for the
// conductor: this shape is the SAME shape the base suite's cases 6-7
// (scripts/tests/h25-test-authoring-lint.test.mjs) currently pin as WARN for
// reviewer-security/reviewer-performance — those tests and this fix pull in
// opposite directions and the tension is real, not an oversight; flagging
// rather than silently resolving it.
// TODAY: the control is GREEN (verb trigger already fires). The suppression
// is RED (path trigger fires regardless of class or verb — dff23647).
// SABOTAGE: remove the (to-be-added) review-only-context guard on the path
// trigger for reviewer-class dispatches (one line) — flips the suppression
// test red; the control, being coder-class, is unaffected.
// ---------------------------------------------------------------------------
test('H25 (f) CONTROL: coder told to review then "write new tests" for a gap still warns', () => {
  const { dir, cleanup } = makeH25ProjectWithTestGlobs();
  try {
    writeAgentDef(dir, 'coder', CODER_TOOLS);
    const r = runHook(
      H25_PATH,
      h25TaskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Review tests/export.test.mjs for context, then write new tests covering the missing null-input case.',
      }),
      dir
    );
    assertTestAuthoringWarn(r, 'review context + genuine authoring instruction (coder)');
  } finally {
    cleanup();
  }
});

test('H25 (f): reviewer-correctness told to "review the tests" (tests/export.test.mjs) never warns — review-only, no authoring', () => {
  const { dir, cleanup } = makeH25ProjectWithTestGlobs();
  try {
    writeAgentDef(dir, 'reviewer-correctness', REVIEWER_CORRECTNESS_TOOLS);
    const r = runHook(
      H25_PATH,
      h25TaskInput(dir, {
        subagent_type: 'reviewer-correctness',
        prompt: 'Review tests/export.test.mjs and report any coverage gaps you find — do not modify anything.',
      }),
      dir
    );
    assertNoTestAuthoringAdvisory(r, 'review-only reviewer-class dispatch naming a test path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// H26 fixtures
// ===========================================================================

function makeH26Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h25h26-h26-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function agoISO(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function liveEntry(agentId, agentType, files, { sessionId = 's1', minutesAgo = 0 } = {}) {
  return { agent_id: agentId, agent_type: agentType, session_id: sessionId, files, at: agoISO(minutesAgo), attribution: 'block' };
}

function writeRegister(dir, entries) {
  writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), JSON.stringify(entries));
}

function h26TaskInput(dir, { subagent_type = 'coder', prompt, session_id = 's1' }) {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', session_id, cwd: dir, tool_input: { subagent_type, prompt } };
}

function assertOverlapWarning(r, { paths, entries }) {
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, 'expected a non-empty overlap advisory');
  for (const p of paths) assert.match(ctx, pathRe(p), `must name overlapping path '${p}'`);
  for (const [agentType, agentId] of entries) assert.ok(ctx.includes(`${agentType}:${agentId}`), `must name '${agentType}:${agentId}'; got: ${ctx}`);
}

function assertH26Silent(r, label) {
  assertNeverDenies(r, label);
  assert.equal(r.code, 0, `expected exit 0 for ${label}, got ${r.code}; stderr: ${r.stderr}`);
  assert.equal(parseAdditionalContext(r), '', `expected no overlap advisory for ${label}`);
}

// ---------------------------------------------------------------------------
// (g) TRUE-POSITIVE CONTROL FIRST: two coder dispatches naming the same file
// → overlap fires. Also serves as the paired control for (i) below (same
// file, same live entry shape; only subagent_type differs).
// TODAY: GREEN — plain overlap detection is pre-existing shipped behavior
// (dff23647 confirms only the negation guard and read-only-class check are
// absent, not overlap detection itself).
// SABOTAGE: comment out the file-intersection comparison itself (one line;
// e.g. force the intersection result to `[]` before the warn branch).
// ---------------------------------------------------------------------------
test('H26 (g) TRUE-POSITIVE CONTROL: two coder dispatches naming the same file → overlap fires', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegister(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(H26_PATH, h26TaskInput(dir, { subagent_type: 'coder', prompt: 'please modify src/shared/util.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/shared/util.mjs'], entries: [['coder', 'sub-1']] });
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (h) a NEGATIVE declaration in the OUTGOING dispatch's own brief must not
// register as POSITIVE candidate territory. Self-controlling: the SAME
// invocation also names a genuinely-intended overlapping file (server.ts,
// live under a different entry) so a green result cannot be "nothing
// matched" — the advisory must name the genuine overlap and must NOT name
// the negated path, in one hookSpecificOutput emission.
// TODAY: RED for the negated half — dff23647: H26 has no negation guard at
// all (grep count 0), so the naive extractor treats "DO NOT TOUCH:
// scripts/enforcement-stamp.mjs" as a candidate outgoing file and both
// entries would warn.
// SABOTAGE: remove the (to-be-added) negation-clause exclusion from the
// outgoing-candidate extraction (one line) — the enforcement-stamp.mjs
// assertion flips red while the server.ts assertion stays green (proving the
// extractor still finds real candidates; only the negated one leaks).
// ---------------------------------------------------------------------------
test('H26 (h): "DO NOT TOUCH: scripts/enforcement-stamp.mjs" in the outgoing brief never registers as that dispatch\'s territory', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegister(dir, [
      liveEntry('sub-8', 'coder', ['packages/mcp-server/src/server.ts']),
      liveEntry('sub-9', 'coder', ['scripts/enforcement-stamp.mjs']),
    ]);
    const r = runHook(
      H26_PATH,
      h26TaskInput(dir, {
        subagent_type: 'coder',
        prompt: 'Implement the new feature in packages/mcp-server/src/server.ts. DO NOT TOUCH: scripts/enforcement-stamp.mjs (another lane owns those).',
      }),
      dir
    );
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, pathRe('packages/mcp-server/src/server.ts'), 'must still warn on the genuinely intended overlap (control half)');
    assert.ok(ctx.includes('coder:sub-8'), 'must name the genuine overlap entry coder:sub-8');
    assert.doesNotMatch(ctx, pathRe('scripts/enforcement-stamp.mjs'), 'must NOT warn on the negated path (suppression half)');
    assert.ok(!ctx.includes('coder:sub-9'), 'must NOT name the negated-path entry coder:sub-9');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (i) an incoming reviewer-class (read-only) dispatch overlapping a live
// coder's real territory → no overlap warning. Same file/live-entry shape
// as (g) — (g) is this test's paired control (coder-class, same file, DOES
// warn).
// TODAY: RED — dff23647: H26 has no read-only-class check at all.
// SABOTAGE: remove the (to-be-added) read-only-class exemption (one line:
// delete `if (READ_ONLY_CLASSES.has(subagentType)) return [];` before the
// overlap comparison) — flips this test red; (g), being coder-class, is
// unaffected.
// ---------------------------------------------------------------------------
test('H26 (i): reviewer-correctness (read-only) dispatch overlapping a live coder\'s territory never warns', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegister(dir, [liveEntry('sub-1', 'coder', ['src/shared/util.mjs'])]);
    const r = runHook(
      H26_PATH,
      h26TaskInput(dir, { subagent_type: 'reviewer-correctness', prompt: 'please review src/shared/util.mjs for correctness issues' }),
      dir
    );
    assertH26Silent(r, 'reviewer-correctness overlapping a live coder territory');
  } finally {
    cleanup();
  }
});
