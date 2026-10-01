// rotation-note.mjs + H1 restore — per-lane hand-off and pre-clear session id.
// Source: finding warm-subagent-resume-across-clear-october-2026 (measured 2026-10-01):
// after /clear, SendMessage to a pre-clear subagent id fails with "No transcript found
// for agent ID" (agent lookup is scoped to the current session). The note therefore
// carries a short hand-off per live lane plus the pre-clear session id, and H1 tells the
// fresh conductor to re-dispatch each lane fresh with that hand-off in the brief.
//
// Harness idioms copied (not imported) from scripts/tests/rotation-note-plan-path.test.mjs.
// Every pin names its SABOTAGE; none is executed here.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROTATION_SCRIPT = join(root, 'scripts', 'rotation-note.mjs');
const H1_SCRIPT = join(root, 'scripts', 'hooks', 'h1-session-start.mjs');

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-rotlane-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

// The ambient CLAUDE_CODE_SESSION_ID of whoever runs this suite must not leak in.
function runRotationNote(dir, args, envOver = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [ROTATION_SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...env, ...envOver } });
}

function notePath(dir) {
  return join(dir, '.sterling', 'transient', 'rotation-note.json');
}

function readRotationNote(dir) {
  return existsSync(notePath(dir)) ? JSON.parse(readFileSync(notePath(dir), 'utf8')) : null;
}

function h1(dir, over = {}) {
  const r = spawnSync(process.execPath, [H1_SCRIPT], {
    input: JSON.stringify({ session_id: 's-new', transcript_path: join(dir, 't', 's.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'clear', ...over }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root },
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  const ctx = (out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
  return { code: r.status, stderr: r.stderr ?? '', ctx };
}

function writeNote(dir, over = {}) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(notePath(dir), JSON.stringify({ plan_path: null, next_slice: 'NEXT-SLICE-MARK', at: '2026-10-01T10:00:00.000Z', ...over }));
}

// ---------------------------------------------------------------- writer

// SABOTAGE: ignore --lane in rotation-note.mjs -> note.lanes is undefined.
test('writer: repeatable --lane flags are stored in order as note.lanes', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 's', '--lane', 'implementor: scripts/a.mjs; wrote tests, hook left', '--lane=reviewer: scripts/b.mjs; found nothing']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readRotationNote(dir).lanes, ['implementor: scripts/a.mjs; wrote tests, hook left', 'reviewer: scripts/b.mjs; found nothing']);
  } finally {
    cleanup();
  }
});

// SABOTAGE: omit the default -> lanes undefined instead of [].
test('writer: zero lanes is fine and is written as an explicit empty array', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 's']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readRotationNote(dir).lanes, []);
  } finally {
    cleanup();
  }
});

// SABOTAGE: filter empties silently (as argAll does) -> exit 0 and the lane is dropped.
for (const [label, args] of [
  ['empty string value', ['--lane', '']],
  ['whitespace-only value', ['--lane', '   ']],
  ['equals form with no value', ['--lane=']],
  ['trailing flag with no value', ['--lane']],
  ['value that looks like another flag', ['--lane', '--other-flag']],
]) {
  test(`writer: ${label} for --lane is refused loudly and writes no note`, () => {
    const { dir, cleanup } = makeProject();
    try {
      const r = runRotationNote(dir, ['--next-slice', 's', ...args]);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /--lane/);
      assert.equal(existsSync(notePath(dir)), false);
    } finally {
      cleanup();
    }
  });
}

// SABOTAGE: never read the env var or the marker -> session_id is undefined.
test('writer: session_id comes from CLAUDE_CODE_SESSION_ID when set', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 's'], { CLAUDE_CODE_SESSION_ID: 'sess-from-env' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readRotationNote(dir).session_id, 'sess-from-env');
  } finally {
    cleanup();
  }
});

test('writer: without the env var, session_id falls back to the marker H1 wrote at SessionStart', () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'transient', 'session.json'), JSON.stringify({ session_id: 'sess-from-marker', source: 'startup', at: '2026-10-01T09:00:00.000Z' }));
    const r = runRotationNote(dir, ['--next-slice', 's']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readRotationNote(dir).session_id, 'sess-from-marker');
  } finally {
    cleanup();
  }
});

// SABOTAGE: invent a value (e.g. 'unknown') -> not null.
test('writer: no env var and no marker -> session_id is null, never guessed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 's']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readRotationNote(dir).session_id, null);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- H1 render

// SABOTAGE: do not render note.lanes in H1 -> no bullets, no statement.
test('H1: lanes render one bullet each under a no-SendMessage / re-dispatch / resume-only-via-session statement', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeNote(dir, { session_id: 'old-sess-1234', lanes: ['implementor: scripts/a.mjs; tests written, hook left', 'reviewer: scripts/b.mjs; clean'] });
    const { ctx } = h1(dir);
    assert.match(ctx, /ROTATION RESTORE/);
    const statement = ctx.search(/cannot be resumed with SendMessage/);
    assert.ok(statement >= 0, 'states pre-clear subagents cannot be resumed with SendMessage');
    assert.match(ctx, /re-dispatch[^\n]*fresh/i);
    assert.match(ctx, /claude --resume old-sess-1234/);
    assert.match(ctx, /rewind menu/);
    const b1 = ctx.indexOf('- implementor: scripts/a.mjs; tests written, hook left');
    const b2 = ctx.indexOf('- reviewer: scripts/b.mjs; clean');
    assert.ok(b1 > statement && b2 > b1, `bullets follow the statement, in order (statement=${statement} b1=${b1} b2=${b2})`);
  } finally {
    cleanup();
  }
});

// SABOTAGE: print the lanes block unconditionally -> the statement shows with no lanes.
test('H1: a note with zero lanes (or no lanes field, a legacy note) prints no lane block', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeNote(dir, { lanes: [] });
    assert.doesNotMatch(h1(dir).ctx, /cannot be resumed with SendMessage/);
    writeNote(dir);
    assert.doesNotMatch(h1(dir).ctx, /cannot be resumed with SendMessage/);
  } finally {
    cleanup();
  }
});

// SABOTAGE: drop the session id from the render.
test('H1: the pre-clear session id is printed when present, absent otherwise', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeNote(dir, { session_id: 'old-sess-9999', lanes: [] });
    assert.match(h1(dir).ctx, /old-sess-9999/);
    writeNote(dir, { session_id: null, lanes: ['implementor: x; y'] });
    const { ctx } = h1(dir);
    assert.match(ctx, /- implementor: x; y/);
    assert.doesNotMatch(ctx, /claude --resume/);
  } finally {
    cleanup();
  }
});

// SABOTAGE: no per-lane or count bound -> a hostile note dominates the injection.
test('H1: lane text is bounded and the array is bounded; the lane count stays exact', () => {
  const { dir, cleanup } = makeProject();
  try {
    const lanes = Array.from({ length: 30 }, (_, i) => `lane-${i}`);
    lanes[0] = 'A'.repeat(5000);
    writeNote(dir, { lanes });
    const { ctx } = h1(dir);
    assert.match(ctx, /30 subagent lane/);
    assert.ok(!ctx.includes('A'.repeat(2500)), 'a single lane is clipped');
    assert.match(ctx, /\+10 more/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- CLI output

// SABOTAGE: restore "check ListAgents" / "settle with ListAgents" in the CLI text.
test('writer: CLI output for unreadable, live and uncertain dispatches says re-dispatch fresh, never ListAgents', () => {
  const { dir, cleanup } = makeProject();
  try {
    const regPath = join(dir, '.sterling', 'transient', 'dispatch-register.json');
    mkdirSync(dirname(regPath), { recursive: true });
    const entry = (id, agoMs) => ({ agent_id: id, agent_type: 'coder', session_id: 's-live', files: ['scripts/x.mjs'], attribution: 'block', at: new Date(Date.now() - agoMs).toISOString() });
    writeFileSync(regPath, '{not valid json,,,\n');
    const unreadable = runRotationNote(dir, ['--next-slice', 's']);
    assert.equal(unreadable.status, 0, unreadable.stderr);
    assert.match(unreadable.stdout, /live_dispatches: UNKNOWN[^\n]*re-dispatch fresh/);
    writeFileSync(regPath, JSON.stringify([entry('agent-live', 1_000), entry('agent-stale', 5 * 60 * 60 * 1000)]));
    const both = runRotationNote(dir, ['--next-slice', 's']);
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /live_dispatches: 1[^\n]*cannot be resumed[^\n]*re-dispatch fresh/);
    assert.match(both.stdout, /uncertain_dispatches: 1[^\n]*cannot be resumed[^\n]*re-dispatch fresh/);
    assert.doesNotMatch(unreadable.stdout + both.stdout, /ListAgents/);
  } finally {
    cleanup();
  }
});
