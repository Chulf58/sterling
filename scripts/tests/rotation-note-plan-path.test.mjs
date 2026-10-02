// rotation-note.mjs + H1 restore — plan_path field pins (spec-only, red-first).
// Spec: decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`
// (knowledge_get 96125184-9797-471b-bb18-31194851c3b3): "the note gains
// exactly ONE field, plan_path (string|null), copied from the lock at write
// time with no flag; the restore prints `- plan: <path>` first and discloses
// when it differs from the current lock's." Both scripts/rotation-note.mjs
// and scripts/hooks/h1-session-start.mjs already exist — pins below fail
// (today) with an ordinary field/regex mismatch, never a named-not-found
// guard.
//
// Harness idioms copied (not imported) from
// scripts/tests/rotation-note-live-dispatches.test.mjs: makeProject(),
// gitProject(), runRotationNote(), readRotationNote(), h1().
//
// ASSUMPTIONS disclosed (see the authoring report):
//   - the mismatch disclosure's exact wording is unspecified beyond
//     "discloses when it differs" — PIN 20b matches loosely
//     (/differ|changed|mismatch/i) against text that also contains both the
//     note's captured path and the live lock's current path, rather than
//     assuming one specific sentence.
//   - the note-field ordering claim ("- plan: <path> first") is checked by
//     comparing the index of the literal `- plan: <path>` substring against
//     the index of the unique --next-slice marker text this suite supplies —
//     the exact rendering of the next_slice field itself is not asserted.
//
// MUTATION DISCIPLINE: every pin names its SABOTAGE. None is executed here.
// ---------------------------------------------------------------------------

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-rotplan-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

function gitProject() {
  const { dir, cleanup } = makeProject();
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  writeFileSync(join(dir, 'base.mjs'), '// base\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { dir, cleanup };
}

function runRotationNote(dir, args) {
  return spawnSync(process.execPath, [ROTATION_SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

function readRotationNote(dir) {
  const p = join(dir, '.sterling', 'transient', 'rotation-note.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function h1(dir, over = {}) {
  const r = spawnSync(process.execPath, [H1_SCRIPT], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup', ...over }),
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
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out, ctx };
}

function lockPath(dir) {
  return join(dir, '.sterling', 'plan-lock.json');
}

function baseLock(over = {}) {
  return {
    schema_version: 1,
    plan_path: over.plan_path ?? join(tmpdir(), 'nonexistent-default.md'),
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

// =============================================================================
// PIN (19a): a lock present at note-write time is captured into
// note.plan_path verbatim.
// SABOTAGE: never read .sterling/plan-lock.json inside rotation-note.mjs,
// leaving plan_path undefined -> the assert.equal below goes red
// (undefined !== the lock's path under strict equality).
// =============================================================================
test('PIN 19a: rotation-note.mjs with a lock present captures note.plan_path === the lock\'s plan_path', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pin19a-plan.md');
    writeFileSync(planPath, 'x');
    writeLockFile(dir, { plan_path: planPath });
    const r = runRotationNote(dir, ['--next-slice', 'do the next thing']);
    assert.equal(r.status, 0, r.stderr);
    const note = readRotationNote(dir);
    assert.equal(note.plan_path, planPath);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (19b): no lock at write time -> note.plan_path is explicitly null.
// SABOTAGE: omit the plan_path key entirely when no lock exists instead of
// explicitly writing null -> the assert.equal below goes red (undefined is
// not strictly equal to null under node:assert/strict).
// =============================================================================
test('PIN 19b: rotation-note.mjs with NO lock present captures note.plan_path === null (not undefined, not omitted)', () => {
  const { dir, cleanup } = gitProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 'do the next thing']);
    assert.equal(r.status, 0, r.stderr);
    const note = readRotationNote(dir);
    assert.equal(note.plan_path, null);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (20a): H1's ROTATION RESTORE block prints `- plan: <path>` FIRST among
// the note's fields.
// SABOTAGE: append the plan line after next_slice/other note fields instead
// of first -> the index-ordering assertion below goes red.
// =============================================================================
test('PIN 20a: H1 restore prints "- plan: <path>" as the FIRST field of the ROTATION RESTORE block', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pin20a-plan.md');
    writeFileSync(planPath, 'x');
    writeLockFile(dir, { plan_path: planPath });
    assert.equal(runRotationNote(dir, ['--next-slice', 'unique-marker-XYZ-next-slice-text']).status, 0);

    const { ctx } = h1(dir, { source: 'clear' });
    assert.match(ctx, /ROTATION RESTORE/);
    const planIdx = ctx.indexOf(`- plan: ${planPath}`);
    assert.ok(planIdx !== -1, `expected the literal "- plan: ${planPath}" line; ctx=${ctx.slice(0, 400)}`);
    const sliceIdx = ctx.indexOf('unique-marker-XYZ-next-slice-text');
    assert.ok(sliceIdx !== -1, 'sanity: the next_slice text is present somewhere');
    assert.ok(planIdx < sliceIdx, 'the plan line precedes the next_slice field — first among note fields');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (20b): a mismatch between the note's captured plan_path and the LIVE
// lock's current plan_path (a new plan approved after the note was written,
// before the rotation actually happened) is disclosed.
// SABOTAGE: never compare the note's captured plan_path against the live
// lock's current plan_path — just print the note's value with no comparison
// -> the mismatch-disclosure assertion below goes red (no such phrase near
// both paths).
// =============================================================================
test('PIN 20b: H1 restore discloses when the note\'s captured plan_path differs from the CURRENT lock\'s plan_path', () => {
  const { dir, cleanup } = gitProject();
  try {
    const oldPath = join(dir, 'pin20b-old-plan.md');
    const newPath = join(dir, 'pin20b-new-plan.md');
    writeFileSync(oldPath, 'old');
    writeFileSync(newPath, 'new');

    writeLockFile(dir, { plan_path: oldPath });
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    // the lock changes AFTER the note was written, before the clear happens.
    writeLockFile(dir, { plan_path: newPath });

    const { ctx } = h1(dir, { source: 'clear' });
    assert.ok(ctx.includes(oldPath), 'the note\'s captured (stale) path is present');
    assert.ok(ctx.includes(newPath), 'the current lock\'s (new) path is present');
    assert.match(ctx, /differ|changed|mismatch/i, 'the divergence itself is disclosed, not silently substituted');
  } finally {
    cleanup();
  }
});
