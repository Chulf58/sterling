// H19 dispatch staging — ACTIVE PLAN line pins (spec-only, red-first).
// Spec: decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`
// (knowledge_get 96125184-9797-471b-bb18-31194851c3b3): "(c) H19 dispatch
// staging: one bounded line in implementor staging —
// `ACTIVE PLAN: <title> (<path>) — this lane belongs to one of its slices` —
// omitted with no lock." scripts/hooks/h19-dispatch-staging.mjs already
// exists — pins below fail (today) with an ordinary substring mismatch,
// never a named-not-found guard.
//
// Harness idioms copied (not imported) from
// scripts/tests/h19-dispatch-staging.test.mjs: makeProject(), writeTranscript
// /assistantLine/taskBlock, subagentStart(), runHook(). The "contract-only
// transcript" shape (a transcript with no Task/Agent tool_use block) is
// reused deliberately — per that suite's own TDD-posture-line pins, the
// ACTIVE PLAN line is keyed off the SPAWNED agent's own agent_type on stdin,
// not off anything found in the parent transcript, so a dispatch-less
// transcript isolates this line from the unrelated knowledge-staging half.
//
// ASSUMPTION disclosed (see the authoring report): the line's exact
// punctuation ("ACTIVE PLAN: <title> (<path>)") is quoted directly from the
// decision text; the trailing "— this lane belongs to one of its slices"
// clause is not asserted verbatim since the decision does not mark it as a
// fixed literal the way it does the title/path portion.
//
// MUTATION DISCIPLINE: every pin names its SABOTAGE. None is executed here.
// ---------------------------------------------------------------------------

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function assistantLine(blocks) {
  return JSON.stringify({ type: 'assistant', message: { content: blocks } });
}

function writeTranscript(dir, lines) {
  const p = join(dir, `transcript-${randomUUID()}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const subagentStart = (dir, transcriptPath, extra = {}) => ({
  hook_event_name: 'SubagentStart',
  session_id: 's1',
  transcript_path: transcriptPath,
  cwd: dir,
  prompt_id: 'p1',
  agent_id: 'agent-1',
  agent_type: 'general-purpose',
  ...extra,
});

function makeProject(configOverride = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19plan-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(configOverride));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function lockPath(dir) {
  return join(dir, '.sterling', 'plan-lock.json');
}

function baseLock(over = {}) {
  return {
    schema_version: 1,
    plan_path: over.plan_path ?? '/tmp/nonexistent-default.md',
    title: 'Existing Plan',
    approved_at: '2026-09-06T09:00:00.000Z',
    approved_sha256: 'a'.repeat(64),
    file_sha256_at_approval: 'a'.repeat(64),
    approved_session_id: 's0',
    approved_branch: 'main',
    approved_head: 'deadbeef',
    source: 'exit_plan_mode',
    ...over,
  };
}

function writeLockFile(dir, over = {}) {
  writeFileSync(lockPath(dir), JSON.stringify(baseLock(over)));
}

function noDispatchTranscript(dir) {
  return writeTranscript(dir, [assistantLine([{ type: 'text', text: 'no dispatch here' }])]);
}

// =============================================================================
// PIN (21-1): a lock present stages `ACTIVE PLAN: <title> (<path>)` into a
// CODER dispatch's context.
// SABOTAGE: never read .sterling/plan-lock.json from
// h19-dispatch-staging.mjs -> the substring assertion below goes red.
// =============================================================================
test('PIN 21-1: a lock present stages "ACTIVE PLAN: <title> (<path>)" into an implementor dispatch\'s context', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeLockFile(dir, { title: 'Pin21 Plan', plan_path: '/abs/path/to/pin21-plan.md' });
    const transcript = noDispatchTranscript(dir);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'implementor' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('ACTIVE PLAN: Pin21 Plan (/abs/path/to/pin21-plan.md)'), `expected the literal ACTIVE PLAN line; ctx=${ctx.slice(0, 400)}`);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (21-2): no lock -> the ACTIVE PLAN line is absent for a coder dispatch.
// SABOTAGE: print a placeholder ACTIVE PLAN line even with no lock present
// -> the doesNotMatch assertion below goes red.
// =============================================================================
test('PIN 21-2: with no lock present, no ACTIVE PLAN line is staged into an implementor dispatch\'s context', () => {
  const { dir, cleanup } = makeProject();
  try {
    const transcript = noDispatchTranscript(dir);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'implementor' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /ACTIVE PLAN:/);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (21-3): a 5000-char title is BOUNDED in the staged line, never
// interpolated raw.
// SABOTAGE: interpolate the raw title into the ACTIVE PLAN line with no
// length bound -> the full 5000-char run appears in ctx and the
// doesNotInclude assertion below goes red.
// =============================================================================
test('PIN 21-3: an oversize (5000-char) title is bounded in the staged ACTIVE PLAN line, not interpolated raw', () => {
  const { dir, cleanup } = makeProject();
  try {
    const hugeTitle = 'X'.repeat(5000);
    writeLockFile(dir, { title: hugeTitle, plan_path: '/abs/huge-plan.md' });
    const transcript = noDispatchTranscript(dir);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'implementor' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes(hugeTitle), 'the full 5000-char title must never appear verbatim in the staged context');
    const match = ctx.match(/ACTIVE PLAN:[^\n]*/);
    assert.ok(match, 'an ACTIVE PLAN line is present (bounded, not omitted)');
    assert.ok(match[0].length < 1000, `the ACTIVE PLAN line itself must be bounded, got length ${match[0].length}`);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (21-4), SCOPING CONTROL: a lock present but the dispatch class is
// OUTSIDE {coder, debugger, test-writer} (reviewer-correctness) -> no
// ACTIVE PLAN line, even though the hook plainly ran (contract still fires).
// SABOTAGE: widen the ACTIVE PLAN injection to fire for every non-exempt
// agent_type instead of scoping it to coder/debugger/test-writer -> the
// doesNotMatch assertion below goes red.
// =============================================================================
test('PIN 21-4 (scoping control): a lock present stages NO ACTIVE PLAN line for a researcher dispatch — scoped to implementor only', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeLockFile(dir, { title: 'Pin21 Plan', plan_path: '/abs/path/to/pin21-plan.md' });
    const transcript = noDispatchTranscript(dir);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: 'researcher' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'sanity: the hook ran and produced its ordinary contract output');
    assert.doesNotMatch(ctx, /ACTIVE PLAN:/, 'the line is scoped away from a researcher dispatch, even with a lock present');
  } finally {
    cleanup();
  }
});
