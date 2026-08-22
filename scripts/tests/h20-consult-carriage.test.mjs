// H20 consult carriage — sparring-partner (codex) consults get the same
// mechanism-axis delivery as agent dispatches (board a63e75d8-d7d9-4294-aa60-
// 83b56e7d3a47; decision 2d19ac0c-ca5c-44d6-a3cd-7adbcd5c342f, slug
// 'consult-carriage-h20-codex-seam').
//
// SETTLED DESIGN (verbatim from the decision statement — this is the oracle):
//   - hooks/hooks.json gains a NEW PreToolUse matcher entry, matcher string
//     "mcp__codex__codex|mcp__codex__codex-reply" (bare names — codex is an
//     external MCP server, not plugin-prefixed on this machine), registering
//     h20-mechanism-axis.mjs with the SAME command shape (incl. the
//     --disable-warning flag) as the existing Task|Agent entry.
//   - NO extraction change: outgoingProposalText() already keys off
//     tool_input.prompt generically, and the codex tool's input field is
//     `prompt` — so delivery CONTENT (which record, whether it fires at all)
//     is unaffected by this change and is exercised here only as a floor.
//   - The ONE code change: when tool_name starts with 'mcp__codex__', the
//     header names a sparring-partner CONSULT instead of the literal existing
//     phrase "you are about to dispatch 'an agent'" (that exact string is
//     quoted in the decision — it is NOT parameterized with subagent_type,
//     so the regression pin below anchors to that literal phrase rather than
//     to any interpolated agent name).
//
// Mirrors the harness in scripts/tests/h20-mechanism-axis.test.mjs (spawnSync
// the hook with JSON stdin; fixture project dir + SterlingStore; same
// antiPattern/decisionRecord/envelope fixture recipe) and the hooks.json
// registration-pin idiom from scripts/tests/hooks-full.test.mjs (H16 pin,
// ~line 1405: parse hooks/hooks.json, find the entry by command.includes(...),
// test the matcher against the expected tool names).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-03T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h20-mechanism-axis.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function antiPattern(title, trigger, paths = []) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: paths,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-consult-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Same PreToolUse shape as a codex consult — tool_input carries `prompt` only, no subagent_type. */
function consult(dir, prompt, tool_name = 'mcp__codex__codex') {
  return { hook_event_name: 'PreToolUse', tool_name, tool_input: { prompt }, cwd: dir };
}

/** The existing Task dispatch shape, copied verbatim from h20-mechanism-axis.test.mjs's helper. */
function dispatch(dir, prompt, subagent_type = 'coder') {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type, prompt }, cwd: dir };
}

// The motivating fixture, copied verbatim from h20-mechanism-axis.test.mjs's
// "the case no file-key join can reach" test — reused here so the consult
// path is proven against the SAME record/prompt pair already known to fire.
function fileMotivatingRecord(store) {
  store.create(
    antiPattern(
      'Signal connected at boot but emitter initialises later',
      'whenever a node connects a signal in _ready() but finishes initialising LATER',
      ['game/run/worker_crew.gd']
    )
  );
}
const MOTIVATING_PROMPT =
  'Wire the harvester so it connects its ready signal in _ready(), then finishes initialising the crew later in the boot sequence.';

// --- 1. REGISTRATION ---------------------------------------------------------

test('REGISTRATION: hooks.json registers h20-mechanism-axis.mjs on a PreToolUse matcher covering mcp__codex__codex and mcp__codex__codex-reply, same command shape as the Task|Agent entry', () => {
  const hooksJson = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const preEntries = hooksJson.hooks?.PreToolUse ?? [];

  const findByCommand = (e) => (e.hooks ?? []).find((h) => typeof h.command === 'string' && h.command.includes('h20-mechanism-axis.mjs'));

  // The pre-existing dispatch registration (Task|Agent) — sanity-checked here
  // so a failure below can tell "no such entry" apart from "matcher regex
  // reads oddly on this machine".
  const dispatchEntry = preEntries.find((e) => findByCommand(e) && new RegExp(e.matcher).test('Task') && new RegExp(e.matcher).test('Agent'));
  assert.ok(dispatchEntry, 'the existing Task|Agent registration for h20-mechanism-axis.mjs must still be present (regression floor)');
  const dispatchCommand = findByCommand(dispatchEntry).command;
  assert.match(dispatchCommand, /--disable-warning/, 'sanity: the existing entry carries the flag this pin expects on the new one too');

  // The NEW registration this pin is actually about.
  const consultEntry = preEntries.find(
    (e) => findByCommand(e) && new RegExp(e.matcher).test('mcp__codex__codex') && new RegExp(e.matcher).test('mcp__codex__codex-reply')
  );
  assert.ok(
    consultEntry,
    'hooks.json must register h20-mechanism-axis.mjs on a PreToolUse matcher covering mcp__codex__codex and mcp__codex__codex-reply'
  );
  assert.ok(!new RegExp(consultEntry.matcher).test('Bash'), 'the new matcher is scoped to the codex tools, not a blanket match');
  assert.ok(!new RegExp(consultEntry.matcher).test('mcp__other__tool'), 'the new matcher does not swallow an unrelated MCP tool name');

  const consultCommand = findByCommand(consultEntry).command;
  assert.match(consultCommand, /--disable-warning/, 'the new entry carries the same --disable-warning flag as the existing dispatch entry');
  assert.equal(consultCommand, dispatchCommand, 'same command shape as the Task|Agent entry — same hook script, same flags, only the matcher differs');
});

// --- 2. CONSULT DELIVERY (content floor — extraction is already generic) ----

test('CONSULT DELIVERY: a codex consult carrying a matching prompt gets the same axis-matched delivery as a dispatch', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    fileMotivatingRecord(store);
    const r = runHook(consult(dir, MOTIVATING_PROMPT), dir);
    assert.equal(r.code, 0, 'never blocks (AC7 floor)');
    assert.notEqual(r.stdout, '', 'the fixture record must be delivered — extraction already reads tool_input.prompt generically per decision 2d19ac0c');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /MECHANISM-AXIS DELIVERY \(H20\)/);
    assert.match(ctx, /Signal connected at boot but emitter initialises later/, 'the fixture record reaches the consult, named by its title');
  } finally {
    cleanup();
  }
});

test('CONSULT DELIVERY: codex-reply carries the same delivery as codex (both matcher branches, same extraction)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    fileMotivatingRecord(store);
    const r = runHook(consult(dir, MOTIVATING_PROMPT, 'mcp__codex__codex-reply'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Signal connected at boot but emitter initialises later/, 'codex-reply delivers exactly like codex — same extraction path');
  } finally {
    cleanup();
  }
});

// --- 3. HEADER: consult naming, not dispatch phrasing ------------------------

test('HEADER: a codex consult\'s header names a sparring-partner CONSULT, and drops the dispatch phrasing entirely', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    fileMotivatingRecord(store);
    const r = runHook(consult(dir, MOTIVATING_PROMPT), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /about to dispatch 'an agent'/, 'the literal existing dispatch phrase (decision 2d19ac0c) must not appear for a codex tool_name');
    assert.match(ctx, /consult|sparring/i, 'the header must name the consult/sparring-partner framing instead');
  } finally {
    cleanup();
  }
});

test('HEADER: codex-reply gets the same consult framing as codex (the matcher-name-prefix branch, not a literal-string special case)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    fileMotivatingRecord(store);
    const r = runHook(consult(dir, MOTIVATING_PROMPT, 'mcp__codex__codex-reply'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /about to dispatch 'an agent'/);
    assert.match(ctx, /consult|sparring/i);
  } finally {
    cleanup();
  }
});

// --- 4. GREEN regression: Task dispatch header is untouched ------------------

test('REGRESSION: a Task dispatch still renders the unchanged literal dispatch phrase, never the consult/sparring framing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    fileMotivatingRecord(store);
    const r = runHook(dispatch(dir, MOTIVATING_PROMPT, 'coder'), dir);
    assert.equal(r.code, 0);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /you are about to dispatch 'coder'/, 'Task dispatch keeps the exact literal existing phrase — h20-mechanism-axis.mjs:201 interpolates subagent_type (\'coder\' per this fixture); decision 2d19ac0c quoted a paraphrase, not the real output — untouched by this change');
    assert.doesNotMatch(ctx, /consult|sparring/i, 'the new consult framing must not leak onto the dispatch path');
  } finally {
    cleanup();
  }
});

// --- 5. INERT: no prompt field at all ----------------------------------------

test('INERT: a codex tool_name with no prompt field at all is ignored — exit 0, no crash, no context', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__codex__codex', tool_input: {}, cwd: dir }, dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally {
    cleanup();
  }
});
