// H22/H26 PER-BLOCK ATTRIBUTION — SPEC ONLY, red-first.
// (board 8662956c-ea05-4f2c-8577-84396a119f95 — CROSS-ATTRIBUTION fix)
//
// Spec under test (given by the launching agent, NOT inferred from any
// implementation — I have not read scripts/hooks/h22-dispatch-register.mjs,
// scripts/hooks/h26-dispatch-overlap.mjs, or scripts/hooks/lib/dispatch-prompt.mjs):
//
// scripts/hooks/lib/dispatch-prompt.mjs gains lastDispatchBlocks() returning
// per-block {subagent_type, prompt} (lastDispatchPrompts stays byte-identical
// — H19 depends on it). scripts/hooks/h22-dispatch-register.mjs SubagentStart
// attributes files per block:
//   - exactly ONE block in the last dispatching message with
//     block.subagent_type === stdin.agent_type -> that block's extracted path
//     candidates ONLY, entry gains attribution:'block'.
//   - SEVERAL same-type blocks in the last dispatching message -> union of
//     the SAME-TYPE blocks only, attribution:'union'.
//   - ZERO type matches in the last dispatching message -> walk BACKWARD
//     through recent dispatching assistant messages (bounded) for a
//     type-match, else union of the last message's all blocks,
//     attribution:'union'.
//
// scripts/hooks/h26-dispatch-overlap.mjs IGNORES overlaps sourced from
// attribution:'union' entries entirely (precise 'block' entries still warn as
// today), and its explanatory sentence becomes a claim like "compares only
// dispatches already present in the live register when this PreToolUse
// fires" — no longer the false "parallel dispatches fired in one message
// never see each other here".
//
// TODAY (pre-fix), h22-dispatch-register.mjs extracts path-like tokens from
// the UNION of every block in the LAST dispatching message, regardless of
// subagent_type, and writes no `attribution` field at all (confirmed by the
// existing pin in scripts/tests/h22-dispatch-register.test.mjs, whose fixture
// unions a 'Task' block and an 'Agent' block with no type filtering). h26
// warns on any live same-session, non-stale, path-overlapping entry
// regardless of any `attribution` field (which does not exist yet). Every RED
// pin below is red against that today-behavior; every GREEN pin is a
// regression net that already holds today and must keep holding after the
// fix.
//
// Harness mirrors scripts/tests/h22-dispatch-register.test.mjs (transcript
// fixtures, runHook/hookInput-style helpers, register file readers) and
// scripts/tests/h26-dispatch-overlap.test.mjs (bare Sterling marker project,
// taskInput/liveEntry/parseAdditionalContext/assertSilent/assertOverlapWarning),
// reused without modifying either file.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');
const H26_PATH = join(HOOKS, 'h26-dispatch-overlap.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// --------------------------------------------------------------------------
// Shared low-level runner
// --------------------------------------------------------------------------

function runHookAt(scriptPath, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const runH22 = (input, cwd) => runHookAt(H22_PATH, input, cwd);
const runH26 = (input, cwd) => runHookAt(H26_PATH, input, cwd);

// --------------------------------------------------------------------------
// H22-side fixtures (mirrors scripts/tests/h22-dispatch-register.test.mjs)
// --------------------------------------------------------------------------

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeH22Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22attr-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function h22Input(dir, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(dir, 't', 'parent.jsonl'),
    cwd: dir,
    prompt_id: 'pr-1',
    agent_id: 'agent-1',
    agent_type: 'coder',
    hook_event_name: 'SubagentStart',
    ...over,
  };
}

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}
function readRegister(dir) {
  return JSON.parse(readFileSync(registerPath(dir), 'utf8'));
}
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

function writeParentTranscript(dir, lines, name = 'parent.jsonl') {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const textLine = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const taskLine = (blocks) => ({ type: 'assistant', message: { content: blocks } });
// NOTE: real Task/Agent tool_use blocks carry `subagent_type` in `input`
// alongside `prompt` — this is the field lastDispatchBlocks() must surface
// per-block (the settled design's whole point).
const taskBlock = (name, subagent_type, prompt) => ({ type: 'tool_use', name, input: { subagent_type, prompt } });

// --------------------------------------------------------------------------
// H26-side fixtures (mirrors scripts/tests/h26-dispatch-overlap.test.mjs)
// --------------------------------------------------------------------------

function makeH26Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22attr-h26-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function taskInput(dir, { subagent_type = 'coder', prompt, session_id = 's1', tool_name = 'Task', tool_input } = {}) {
  const base = { hook_event_name: 'PreToolUse', tool_name, session_id, cwd: dir };
  if (tool_input !== undefined) return { ...base, tool_input };
  return { ...base, tool_input: { subagent_type, prompt } };
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
  return new RegExp(esc.replace(/\//g, '\\/'), 'i');
}

function assertSilent(r) {
  assert.equal(r.code, 0, `expected exit 0 (silent case), got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.equal(ctx, '', `expected no overlap advisory; got: ${JSON.stringify(ctx)}`);
}

function assertOverlapWarning(r, { paths, entries }) {
  assert.equal(r.code, 0, `expected exit 0 (advisory only, never a denial), got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, 'expected a non-empty overlap advisory in additionalContext');
  for (const p of paths) {
    assert.match(ctx, tokenRe(p), `advisory must name the overlapping path '${p}'`);
  }
  for (const [agentType, agentId] of entries) {
    assert.ok(ctx.includes(`${agentType}:${agentId}`), `advisory must name the overlapping dispatch as '${agentType}:${agentId}'; got: ${ctx}`);
  }
}

function agoISO(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function liveEntry(agentId, agentType, files, { sessionId = 's1', minutesAgo = 0, attribution } = {}) {
  const e = { agent_id: agentId, agent_type: agentType, session_id: sessionId, files, at: agoISO(minutesAgo) };
  if (attribution !== undefined) e.attribution = attribution;
  return e;
}

// ===========================================================================
// PIN 1 — mixed-type batch: exactly one block matches stdin.agent_type ->
// that block's files ONLY, attribution 'block'.
// EXPECTED RED today: h22 currently unions ALL blocks in the last dispatching
// message regardless of type, so 'src/fileB.mjs' (the test-writer block's
// file) WOULD be included and `attribution` is undefined. Fails at
// `assert.ok(!entry.files.includes('src/fileB.mjs'))` and at
// `assert.equal(entry.attribution, 'block')`.
// ===========================================================================

test('H22 attribution PIN1: mixed-type batch — one coder block + one test-writer block, SubagentStart agent_type=coder attributes only the coder block\'s files, attribution:block', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([
        taskBlock('Task', 'coder', 'Please modify src/fileA.mjs for the coder half of this batch'),
        taskBlock('Task', 'test-writer', 'Please write tests touching src/fileB.mjs for the test-writer half of this batch'),
      ]),
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-mixed', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-mixed');
    assert.ok(entry, 'entry was appended');
    assert.deepEqual([...entry.files].sort(), ['src/fileA.mjs'], 'files come from the coder block only');
    assert.ok(!entry.files.includes('src/fileB.mjs'), 'the test-writer sibling block never contributes files to a coder attribution');
    assert.equal(entry.attribution, 'block', 'exactly one type-matching block -> precise block attribution');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 2 — same-type twins: two test-writer blocks + one coder block,
// SubagentStart agent_type=test-writer -> union of the two test-writer
// blocks only, attribution 'union'.
// EXPECTED RED today: current union-of-last-message-regardless-of-type
// behavior WOULD include 'src/fileC.mjs' (the coder block's file) too. Fails
// at `assert.ok(!entry.files.includes('src/fileC.mjs'))`.
// ===========================================================================

test('H22 attribution PIN2: same-type twins — two test-writer blocks + one coder block, SubagentStart agent_type=test-writer attributes the UNION of the two test-writer blocks only, attribution:union', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([
        taskBlock('Task', 'test-writer', 'write tests for src/fileA.mjs'),
        taskBlock('Task', 'test-writer', 'also write tests for src/fileB.mjs'),
        taskBlock('Task', 'coder', 'implement src/fileC.mjs'),
      ]),
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-twin', agent_type: 'test-writer' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-twin');
    assert.ok(entry, 'entry was appended');
    assert.deepEqual([...entry.files].sort(), ['src/fileA.mjs', 'src/fileB.mjs'], 'files are the union of the two same-type blocks');
    assert.ok(!entry.files.includes('src/fileC.mjs'), 'the coder sibling block never contributes files to a test-writer attribution');
    assert.equal(entry.attribution, 'union', 'several same-type blocks -> union attribution');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 3 — cross-batch walk-back: M1 has a coder block (fileA), a later M2 has
// only a test-writer block (fileB). SubagentStart agent_type=coder (M1's
// agent starting late, after M2 was already dispatched) must walk backward
// past M2 (zero type matches there) to M1's coder block: files = fileA only,
// attribution 'block'.
// EXPECTED RED today: h22 currently only ever looks at the LAST dispatching
// message (M2), so it would produce files=['src/fileB.mjs'] (wrong file) and
// no attribution field at all. Fails at the files deepEqual and at the
// attribution equality.
// ===========================================================================

test('H22 attribution PIN3: cross-batch walk-back — a late-starting agent whose type only matches an EARLIER dispatching message is attributed that earlier message\'s block, not the later message\'s', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([taskBlock('Task', 'coder', 'M1: fix up src/fileA.mjs')]), // M1
      textLine('conductor narrates between dispatches'),
      taskLine([taskBlock('Task', 'test-writer', 'M2: write tests for src/fileB.mjs')]), // M2 (last dispatching message)
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-late', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-late');
    assert.ok(entry, 'entry was appended');
    assert.deepEqual([...entry.files].sort(), ['src/fileA.mjs'], 'walk-back finds M1\'s coder block, not M2\'s test-writer block');
    assert.ok(!entry.files.includes('src/fileB.mjs'), 'M2 (the last message, zero type matches) never contributes files here');
    assert.equal(entry.attribution, 'block', 'a single type-matching block found by walk-back is still a precise block attribution');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 4a — H26 suppression of attribution:'union' entries.
// EXPECTED RED today: h26 has no concept of `attribution` yet and warns on
// any live overlapping entry. Fails inside assertSilent at
// `assert.equal(ctx, '', ...)` — ctx will be non-empty (a warning fired).
// ===========================================================================

test('H26 attribution PIN4a: a live entry with attribution:union whose files include the overlap path is NEVER a source of warning', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'test-writer', ['src/fileX.mjs'], { attribution: 'union' })]);
    const r = runH26(taskInput(dir, { prompt: 'please modify src/fileX.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 4b — H26 still warns on attribution:'block' entries (regression net).
// EXPECTED GREEN both today and after the fix: today's h26 ignores the
// (nonexistent) `attribution` field entirely and warns on any live
// overlapping entry, which already satisfies this assertion; after the fix,
// 'block' entries are the precise case that must keep warning.
// ===========================================================================

test('H26 attribution PIN4b: a live entry with attribution:block still warns exactly as today', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-2', 'coder', ['src/fileY.mjs'], { attribution: 'block' })]);
    const r = runH26(taskInput(dir, { prompt: 'please modify src/fileY.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/fileY.mjs'], entries: [['coder', 'sub-2']] });
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 5 — H26 explanatory text: when a warning DOES fire, it states the new
// register-presence claim and drops the old false "never see each other"
// framing.
// EXPECTED RED today: the exact new phrase "already present in the live
// register" is not part of today's advisory text (it does not exist prior to
// this fix). Fails at
// `assert.match(ctx, /already present in the live register/i)`.
// ===========================================================================

test('H26 attribution PIN5: a fired warning states the register-presence claim, not the old "never see each other" framing', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-3', 'coder', ['src/fileZ.mjs'], { attribution: 'block' })]);
    const r = runH26(taskInput(dir, { prompt: 'please modify src/fileZ.mjs today' }), dir);
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, /already present in the live register/i, 'advisory states the new register-presence claim');
    assert.doesNotMatch(ctx, /never see each other/i, 'the old false "never see each other" framing must be gone');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 6a — GREEN regression: register entries keep the base shape
// {agent_id, agent_type, session_id, files, at} as attribution is added.
// EXPECTED GREEN both today and after the fix: these five fields are already
// written by today's h22 (per scripts/tests/h22-dispatch-register.test.mjs)
// and the settled design only ADDS `attribution`, never removes a base
// field.
// ===========================================================================

test('H22 attribution PIN6a: a new entry keeps the base shape {agent_id, agent_type, session_id, files, at}', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'coder', 'touch src/fileR.mjs')])]);
    const r = runH22(h22Input(dir, { agent_id: 'agent-r', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-r');
    assert.ok(entry, 'entry was appended');
    for (const key of ['agent_id', 'agent_type', 'session_id', 'files', 'at']) {
      assert.ok(key in entry, `entry retains base field '${key}'`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 6b — GREEN-after-fix regression: a legacy register entry with NO
// attribution field at all is treated as imprecise (union) by H26 — no
// crash, no warning sourced from it.
// EXPECTED RED today: h26 has no attribution concept yet, so it warns on any
// live overlapping entry regardless of a missing field. Fails inside
// assertSilent at `assert.equal(ctx, '', ...)`.
// ===========================================================================

test('H26 attribution PIN6b: a legacy entry with no attribution field at all is treated as imprecise/union — suppressed, no crash, no warning', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegisterRaw(dir, [{ agent_id: 'legacy-1', agent_type: 'coder', session_id: 's1', files: ['src/fileL.mjs'], at: agoISO(0) }]);
    const r = runH26(taskInput(dir, { prompt: 'please modify src/fileL.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});
