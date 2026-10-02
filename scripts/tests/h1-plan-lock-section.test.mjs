// H1 SessionStart — PLAN LOCK section pins (spec-only, red-first).
// Spec: decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`
// (knowledge_get 96125184-9797-471b-bb18-31194851c3b3). H1
// (scripts/hooks/h1-session-start.mjs) already exists — this file's pins
// assert on behavior the coder ADDS to it (planLockSection(ctx)), never on a
// missing binary, so an unmet pin fails with an ordinary substring/regex
// mismatch, not a named-not-found guard.
//
// Fixtures write .sterling/plan-lock.json DIRECTLY, matching the v1 shape
// from the decision's own prose — this decouples H1's pins from H31/the CLI
// (scripts/tests/h31-plan-lock.test.mjs), so a defect in the WRITER never
// masks a defect in the READER (or vice versa).
//
// Harness idioms copied (not imported):
//   - makeProject()/h1() spawn convention (real SterlingStore before spawning
//     H1; STERLING_CURRENCY_DISABLE/STERLING_NO_BANNER env; JSON stdin with
//     hook_event_name/source): scripts/tests/rotation-note-live-dispatches.test.mjs.
//   - gitProject() (git init -q -b main, user.email/user.name, base commit):
//     same file, and scripts/tests/h1-plugin-root-sites.test.mjs's git
//     fixture pattern.
//   - "TDD posture:" as H1's own ordinary-banner liveness marker (present on
//     every plain SessionStart regardless of fixture content, computed
//     unconditionally by an unrelated H1 section — see
//     h1-plugin-root-sites.test.mjs's LIVENESS CONTROL docstring). The old
//     marker, "reading files by hand", was a phrase inside H1's hardcoded
//     conventions block, deleted 2026-09-19 (slice 3, conductor context diet).
//     "TDD posture:" survives both that deletion and the later route-A move
//     (2026-09-22, decision conductor-instructions-via-main-session-agent-route-a)
//     that stopped H1 injecting any conductor posture text at all.
//
// ASSUMPTIONS disclosed (see the authoring report for the same list):
//   - the decision's own line template is quoted essentially verbatim:
//     `PLAN LOCK: <title> — <path> (approved <date> on <branch>, <source>) ·
//     plan file <STATUS> · branch now <same|DIFFERENT>` — pins below assert
//     on the STATUS tokens and the literal phrases "branch now DIFFERENT" /
//     "branch now same" quoted in the decision statement, not on em-dash/
//     middle-dot punctuation choices.
//   - the one-shot marker JSON shapes ({reason} for unresolved/released,
//     {title, plan_path} for previous) are the SAME assumption stated in
//     scripts/tests/h31-plan-lock.test.mjs's header — duplicated here since
//     these markers are consumed (not produced) by this file's pins.
//   - "governs THIS OBJECTIVE" is matched case-insensitively: the decision
//     quotes the sentence in full caps ("GOVERNS THIS OBJECTIVE'S SCOPE...")
//     but this brief's own pin list asks for that literal substring.
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
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H1_HOOK = join(root, 'scripts', 'hooks', 'h1-session-start.mjs');
const ROTATION_SCRIPT = join(root, 'scripts', 'rotation-note.mjs');

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1plan-'));
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
  return { dir, cleanup, git: g };
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
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

function transientPath(dir, name) {
  return join(dir, '.sterling', 'transient', name);
}

function writeTransient(dir, name, body) {
  const p = transientPath(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body));
}

// Copied (not imported) from scripts/tests/rotation-note-plan-path.test.mjs's
// runRotationNote()/readRotationNote() convention, needed here for the B4/B6
// pins below that exercise the ROTATION RESTORE block alongside plan-lock
// state (rather than the plan-lock section alone).
function runRotationNote(dir, args) {
  return spawnSync(process.execPath, [ROTATION_SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

function rotationNotePath(dir) {
  return transientPath(dir, 'rotation-note.json');
}

function h1(dir, over = {}) {
  const r = spawnSync(process.execPath, [H1_HOOK], {
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

// =============================================================================
// PIN (13): PLAN LOCK is the FIRST Sterling section, on every SessionStart
// source, naming title/path/status/authority.
// SABOTAGE: emit the PLAN LOCK block AFTER the ordinary conventions/banner
// section instead of prepending it first -> ctx.startsWith('PLAN LOCK:')
// goes red for every source below.
// =============================================================================
test('PIN 13: PLAN LOCK is the first Sterling section on every re-entry source (startup/resume/clear/compact), naming title/path/status/authority', () => {
  const { dir, cleanup } = gitProject();
  try {
    const content = 'plan body for pin13';
    const planPath = join(dir, 'pin13-plan.md');
    writeFileSync(planPath, content);
    writeLockFile(dir, { plan_path: planPath, title: 'Pin13 Plan', approved_sha256: sha256(content), file_sha256_at_approval: sha256(content), approved_branch: 'main' });

    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      const { ctx, out } = h1(dir, { source });
      assert.ok(out, `source=${source}: H1 must emit parseable JSON`);
      assert.ok(ctx.startsWith('PLAN LOCK:'), `source=${source}: PLAN LOCK must be the FIRST Sterling section; ctx starts with: ${ctx.slice(0, 120)}`);
      assert.ok(ctx.includes('Pin13 Plan'), `source=${source}: title named`);
      assert.ok(ctx.includes(planPath), `source=${source}: path named verbatim`);
      assert.match(ctx, /UNCHANGED|MODIFIED since approval|MISSING|UNREADABLE/, `source=${source}: a live status token present`);
      assert.match(ctx, /governs THIS OBJECTIVE/i, `source=${source}: the authority sentence is present`);
    }
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (14a): MODIFIED arm — the file has changed since file_sha256_at_approval.
// SABOTAGE: never re-hash the live file — always report UNCHANGED regardless
// of edits -> the /MODIFIED since approval/ match below goes red.
// =============================================================================
test('PIN 14a: a plan file edited since approval reads "MODIFIED since approval"', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pin14a-plan.md');
    writeFileSync(planPath, 'v1');
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('v1'), file_sha256_at_approval: sha256('v1') });
    writeFileSync(planPath, 'v2'); // edited after the lock was written
    const { ctx } = h1(dir, { source: 'startup' });
    assert.match(ctx, /MODIFIED since approval/);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (14b): MISSING arm — the plan file no longer exists, and it is NOT
// conflated with MODIFIED.
// SABOTAGE: treat a missing file identically to an edited one (reuse the
// "MODIFIED since approval" string for both) -> the /MISSING/ match below
// goes red.
// =============================================================================
test('PIN 14b: a plan file that no longer exists reads MISSING, distinct from MODIFIED', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pin14b-ghost.md'); // never created
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x') });
    const { ctx } = h1(dir, { source: 'startup' });
    assert.match(ctx, /MISSING/);
    assert.doesNotMatch(ctx, /MODIFIED since approval/, 'MISSING is a distinct status, never conflated with MODIFIED');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (14c), THE KEY INVARIANT: a text/file-mismatch lock reads UNCHANGED
// when the file itself is unedited — comparison uses file_sha256_at_approval,
// never approved_sha256.
// SABOTAGE: compare the live file's hash against approved_sha256 instead of
// file_sha256_at_approval -> this test's UNCHANGED assertion goes red (it
// would read MODIFIED, since approved_sha256 deliberately differs from the
// file's real bytes here).
// =============================================================================
test('PIN 14c: a text/file-mismatch lock reads UNCHANGED when the file itself is unedited — never compares against approved_sha256', () => {
  const { dir, cleanup } = gitProject();
  try {
    const fileBytes = 'the actual file bytes, never edited';
    const planPath = join(dir, 'pin14c-mismatch.md');
    writeFileSync(planPath, fileBytes);
    writeLockFile(dir, {
      plan_path: planPath,
      approved_sha256: sha256('a DIFFERENT approved text — from ExitPlanMode tool_input.plan'),
      file_sha256_at_approval: sha256(fileBytes),
      text_file_mismatch: true,
    });
    const { ctx } = h1(dir, { source: 'startup' });
    assert.match(ctx, /UNCHANGED/, 'the file itself was never edited — must read UNCHANGED');
    assert.doesNotMatch(ctx, /MODIFIED since approval/);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (15): a malformed lock file -> "PLAN LOCK MALFORMED" naming
// plan-lock.mjs --show; every OTHER H1 section still prints.
// SABOTAGE: let a JSON.parse exception on the malformed lock propagate
// uncaught, crashing before any other section renders -> the
// "TDD posture:" liveness match below goes red (or H1 crashes and out is
// null entirely).
// =============================================================================
test('PIN 15: a malformed (invalid JSON) plan-lock.json renders PLAN LOCK MALFORMED naming --show, and every other H1 section still prints', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeFileSync(lockPath(dir), '{ this is not valid json');
    const { ctx, out } = h1(dir, { source: 'startup' });
    assert.ok(out, 'H1 must not crash on a malformed lock');
    assert.match(ctx, /PLAN LOCK MALFORMED/);
    assert.match(ctx, /plan-lock\.mjs --show/);
    assert.match(ctx, /TDD posture:/, 'the ordinary banner section still renders alongside the malformed disclosure');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (16): one-shot markers (unresolved/released/previous) are each
// disclosed once and DELETED after the run, on EVERY SessionStart source.
// SABOTAGE (shared across the three markers below): read the marker but
// never delete it (or only delete it when source==='clear') -> the
// existsSync(p)===false assertion goes red for one or more non-clear
// sources.
// =============================================================================
const ONE_SHOT_MARKERS = [
  { file: 'plan-lock-unresolved.json', body: { reason: 'planFilePath missing on ExitPlanMode approval' }, expectSubstr: 'planFilePath missing on ExitPlanMode approval' },
  { file: 'plan-lock-released.json', body: { reason: 'operator released the lock manually' }, expectSubstr: 'operator released the lock manually' },
  { file: 'plan-lock-previous.json', body: { title: 'The Previous Plan', plan_path: '/tmp/prev-plan.md' }, expectSubstr: 'The Previous Plan' },
];

for (const marker of ONE_SHOT_MARKERS) {
  test(`PIN 16: one-shot marker ${marker.file} is disclosed once and deleted after the run, on every SessionStart source`, () => {
    const { dir, cleanup } = gitProject();
    try {
      for (const source of ['startup', 'resume', 'clear', 'compact']) {
        writeTransient(dir, marker.file, marker.body);
        const { ctx } = h1(dir, { source });
        assert.ok(ctx.includes(marker.expectSubstr), `source=${source}: expected the one-shot disclosure for ${marker.file}; ctx=${ctx.slice(0, 400)}`);
        assert.equal(existsSync(transientPath(dir, marker.file)), false, `source=${source}: ${marker.file} must be deleted after H1 consumes it`);
      }
    } finally {
      cleanup();
    }
  });
}

// =============================================================================
// PIN (17): no lock -> no PLAN LOCK line at all (no ceremony, P1).
// SABOTAGE: emit a PLAN LOCK line with placeholder/empty values even when no
// lock file is present -> the doesNotMatch assertion below goes red.
// =============================================================================
test('PIN 17: with no plan-lock.json at all, no PLAN LOCK line appears; the ordinary banner is otherwise intact', () => {
  const { dir, cleanup } = gitProject();
  try {
    const { ctx } = h1(dir, { source: 'startup' });
    assert.doesNotMatch(ctx, /PLAN LOCK/);
    assert.match(ctx, /TDD posture:/, 'ordinary banner still present');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (18): branch mismatch is disclosed as "branch now DIFFERENT"; a
// same-branch control reads "branch now same" (rules out an
// always-DIFFERENT vacuous implementation).
// SABOTAGE: never compare approved_branch against the live current branch —
// hardcode the descriptor to always print DIFFERENT -> the CONTROL test's
// "branch now same" assertion below goes red, even though the mismatch test
// alone would stay green under this exact sabotage.
// =============================================================================
test('PIN 18: a lock approved on a DIFFERENT branch than the current one discloses "branch now DIFFERENT"', () => {
  const { dir, cleanup, git } = gitProject();
  try {
    const planPath = join(dir, 'pin18-plan.md');
    writeFileSync(planPath, 'x');
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x'), approved_branch: 'main' });
    git(['checkout', '-b', 'feature-x']);
    const { ctx } = h1(dir, { source: 'startup' });
    assert.match(ctx, /branch now DIFFERENT/);
  } finally {
    cleanup();
  }
});

test('PIN 18-control: a lock approved on the SAME (current) branch discloses "branch now same" — rules out an always-DIFFERENT implementation', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pin18ctrl-plan.md');
    writeFileSync(planPath, 'x');
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x'), approved_branch: 'main' });
    // no checkout — stays on 'main', matching approved_branch
    const { ctx } = h1(dir, { source: 'startup' });
    assert.match(ctx, /branch now same/);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (B4): a MALFORMED current lock alongside a ROTATION NOTE that captured
// a valid plan_path before the lock became malformed. The top-of-session PLAN
// LOCK section (PIN 15) already covers the bare malformed-lock case; this pin
// covers the interaction the review flagged as unpinned — the ROTATION
// RESTORE block's OWN "- plan:" line must not paper over a malformed current
// lock by claiming "no plan lock is live" (the phrasing that fits an ABSENT
// lock, not a present-but-unparseable one). It must instead point at the
// malformed status or the --show remedy, same as the top section does.
// SABOTAGE: have the restore block's plan-line renderer catch a
// JSON.parse failure on the current lock and fall back to the same "no plan
// lock is live" text used for the truly-absent case -> the
// doesNotMatch(/no plan lock is live/i) assertion below goes red.
// =============================================================================
test('PIN B4: a MALFORMED current lock + a rotation note carrying plan_path — restore\'s plan line names MALFORMED/--show, never "no plan lock is live"', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pinb4-plan.md');
    writeFileSync(planPath, 'x');
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x') });
    assert.equal(runRotationNote(dir, ['--next-slice', 'continue the work']).status, 0);
    // the lock becomes malformed AFTER the note captured a valid plan_path,
    // before the /clear actually happens.
    writeFileSync(lockPath(dir), '{ not valid json');

    const { ctx } = h1(dir, { source: 'clear' });
    assert.match(ctx, /PLAN LOCK MALFORMED/, 'the top-of-session PLAN LOCK section still discloses the malformed lock (PIN 15)');
    const restoreIdx = ctx.indexOf('ROTATION RESTORE');
    assert.ok(restoreIdx !== -1, 'the rotation restore block renders alongside the malformed disclosure');
    const restoreBlock = ctx.slice(restoreIdx);
    assert.ok(!/no plan lock is live/i.test(restoreBlock), 'the restore\'s plan line must not claim no lock is live — the lock is malformed, not absent');
    assert.match(restoreBlock, /MALFORMED|--show/i, 'the restore\'s plan line instead points at the malformed status or the --show remedy');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (B5): an UNPARSEABLE plan-lock-unresolved.json one-shot marker is still
// DELETED after the run (P4 lifecycle-bound state — a marker H1 cannot even
// parse must not become a permanent leftover), with a one-line disclosure
// that a malformed marker was found (distinct from PIN 16's happy-path
// disclosure, which assumes valid JSON).
// SABOTAGE: guard the marker read with a try/catch that, on JSON.parse
// failure, silently `return`s without deleting the file (leaving it for the
// next SessionStart to trip over again) -> the existsSync(...)===false
// assertion below goes red.
// =============================================================================
test('PIN B5: an unparseable plan-lock-unresolved.json marker is still DELETED after the run, with a one-line disclosure that it was malformed', () => {
  const { dir, cleanup } = gitProject();
  try {
    const markerPath = transientPath(dir, 'plan-lock-unresolved.json');
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, '{ this is not valid json at all');
    const { ctx, out } = h1(dir, { source: 'startup' });
    assert.ok(out, 'H1 must not crash on an unparseable one-shot marker');
    assert.equal(existsSync(markerPath), false, 'the unparseable marker is deleted after the run regardless of parse failure (P4 — lifecycle-bound transient state)');
    assert.match(ctx, /unresolved|plan.lock/i, 'a disclosure that a (malformed) plan-lock marker was found appears somewhere in context');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (B6): NOTE plan_path SANITIZATION — a rotation note whose captured
// plan_path carries a raw ESC control byte and an embedded newline must not
// let either reach additionalContext through the restore's "- plan:" line
// (the same injection-hygiene guarantee the decision states for title/paths/
// reasons generally, applied here to the ROTATION RESTORE reader rather than
// the writer — defense at the point untrusted bytes are RENDERED, regardless
// of whether the writer already sanitizes).
// SABOTAGE: render the note's plan_path with a plain template-string
// interpolation and no sanitization pass -> the raw ESC byte and the embedded
// newline both survive into ctx, so the no-ESC assertion and/or the
// no-free-floating-injected-line assertion below go red.
// =============================================================================
test('PIN B6: a rotation-note plan_path carrying an ESC byte and a newline is sanitized in the restore\'s "- plan:" line', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pinb6-plan.md');
    writeFileSync(planPath, 'x');
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x') });
    assert.equal(runRotationNote(dir, ['--next-slice', 'continue the work']).status, 0);

    const notePath = rotationNotePath(dir);
    const note = JSON.parse(readFileSync(notePath, 'utf8'));
    note.plan_path = '/tmp/evil\x1b[31m\nINJECTED-LINE-B6.md';
    writeFileSync(notePath, JSON.stringify(note));

    const { ctx } = h1(dir, { source: 'clear' });
    assert.ok(!ctx.includes('\x1b'), 'no raw ESC control byte reaches additionalContext');
    const injectedAsOwnLine = ctx.split('\n').some((line) => line.trim() === 'INJECTED-LINE-B6.md');
    assert.ok(!injectedAsOwnLine, 'the embedded newline never produces a free-floating injected line of its own — the hostile path is collapsed/escaped onto its single "- plan:" line');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (B6b): NOTE plan_path length bound — a 5000-character plan_path is
// bounded to at most 600 rendered characters, so an oversize (or maliciously
// padded) path cannot balloon the injected context payload.
// (ASSUMPTION, disclosed in the report: the 600-char ceiling is this brief's
// own explicit number, not one stated in the decision text itself — pinned
// as given.)
// SABOTAGE: interpolate the note's plan_path into the "- plan:" line with no
// length bound -> the <=600 assertion below goes red (the rendered length
// would be ~5005).
// =============================================================================
test('PIN B6b: a rotation-note plan_path of 5000 characters is bounded to at most 600 characters in the restore output', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pinb6b-plan.md');
    writeFileSync(planPath, 'x');
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x') });
    assert.equal(runRotationNote(dir, ['--next-slice', 'continue the work']).status, 0);

    const notePath = rotationNotePath(dir);
    const note = JSON.parse(readFileSync(notePath, 'utf8'));
    note.plan_path = '/tmp/' + 'x'.repeat(5000) + '.md';
    writeFileSync(notePath, JSON.stringify(note));

    const { ctx } = h1(dir, { source: 'clear' });
    const planLineMatch = ctx.match(/^- plan: (.*)$/m);
    assert.ok(planLineMatch, 'a "- plan:" line is present in the restore block');
    assert.ok(planLineMatch[1].length <= 600, `the rendered plan path is bounded — got ${planLineMatch[1].length} characters`);
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (B7): STALE disclosure — a lock approved 20 days ago is disclosed as
// STALE (the decision names >14 days, advisory). CONTROL placed FIRST: a
// lock approved only 2 days ago is NOT disclosed as stale, ruling out an
// always-STALE vacuous implementation before the positive arm is read as
// evidence.
// SABOTAGE: hardcode the staleness disclosure to always print regardless of
// approved_at (or never compute an age at all) -> the control's
// doesNotMatch(/STALE/) below goes red.
// =============================================================================
test('PIN B7-control: a lock approved 2 days ago is NOT disclosed as STALE — rules out an always-STALE implementation', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pinb7ctrl-plan.md');
    writeFileSync(planPath, 'x');
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x'), approved_at: recentDate });
    const { ctx } = h1(dir, { source: 'startup' });
    assert.doesNotMatch(ctx, /STALE/, 'a lock only 2 days old is not disclosed as stale');
  } finally {
    cleanup();
  }
});

test('PIN B7: a lock approved 20 days ago IS disclosed as STALE', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pinb7-plan.md');
    writeFileSync(planPath, 'x');
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x'), approved_at: oldDate });
    const { ctx } = h1(dir, { source: 'startup' });
    assert.match(ctx, /STALE/, 'a lock older than 14 days is disclosed as STALE (the decision\'s named advisory threshold)');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (B8): MANUAL SOURCE provenance disclosure. CONTROL placed FIRST: an
// exit_plan_mode-sourced lock's PLAN LOCK line does not claim manual
// provenance, ruling out a vacuous "always says manual" (or "always mentions
// the word manual somewhere for unrelated reasons") implementation before the
// positive arm is read as evidence.
// SABOTAGE: never branch on lock.source at all when rendering the PLAN LOCK
// line (always print the exit_plan_mode phrasing, or never mention source at
// all) -> the positive arm's /manual/i match on the PLAN LOCK line below goes
// red.
// =============================================================================
test('PIN B8-control: an exit_plan_mode-sourced lock\'s PLAN LOCK line does not claim manual provenance', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pinb8-control-plan.md');
    writeFileSync(planPath, 'x');
    writeLockFile(dir, { plan_path: planPath, approved_sha256: sha256('x'), file_sha256_at_approval: sha256('x'), source: 'exit_plan_mode' });
    const { ctx } = h1(dir, { source: 'startup' });
    const line = ctx.split('\n')[0];
    assert.ok(line.startsWith('PLAN LOCK:'), 'sanity: first line is the PLAN LOCK line');
    assert.ok(!/manual/i.test(line), 'an exit_plan_mode-sourced lock does not claim manual provenance on its PLAN LOCK line');
  } finally {
    cleanup();
  }
});

test('PIN B8: a lock with source:manual discloses manual provenance on its PLAN LOCK line', () => {
  const { dir, cleanup } = gitProject();
  try {
    const planPath = join(dir, 'pinb8-plan.md');
    writeFileSync(planPath, 'y');
    writeLockFile(dir, {
      plan_path: planPath,
      approved_sha256: sha256('y'),
      file_sha256_at_approval: sha256('y'),
      source: 'manual',
      approved_session_id: null,
      approved_branch: null,
      approved_head: null,
    });
    const { ctx } = h1(dir, { source: 'startup' });
    const line = ctx.split('\n')[0];
    assert.match(line, /manual/i, 'manual provenance is disclosed on the PLAN LOCK line');
  } finally {
    cleanup();
  }
});

// =============================================================================
// PIN (B9): TEXT/FILE MISMATCH disclosure. A lock recorded with
// text_file_mismatch:true, whose on-disk file has never been edited since
// approval, must (a) read UNCHANGED (PIN 14c already covers this exact
// invariant against the approved_sha256-instead-of-file_sha256_at_approval
// bug) AND (b) separately disclose the mismatch fact itself — that the
// APPROVED TEXT differed from the FILE at approval time — since UNCHANGED
// alone does not tell the reader that what was approved was never quite what
// was on disk.
// (ASSUMPTION, disclosed in the report: the exact disclosure wording is
// unspecified beyond the decision's own field name text_file_mismatch;
// pinned loosely against /mismatch/i rather than a specific sentence.)
// SABOTAGE: render only the live UNCHANGED/MODIFIED/MISSING/UNREADABLE status
// token and never separately surface lock.text_file_mismatch -> the
// /mismatch/i assertion below goes red while the UNCHANGED assertion stays
// green (this is exactly the gap the review flagged as unpinned).
// =============================================================================
test('PIN B9: text_file_mismatch:true with an unedited file reads UNCHANGED, and separately discloses the mismatch', () => {
  const { dir, cleanup } = gitProject();
  try {
    const fileBytes = 'the actual file bytes for B9, never edited since approval';
    const planPath = join(dir, 'pinb9-plan.md');
    writeFileSync(planPath, fileBytes);
    writeLockFile(dir, {
      plan_path: planPath,
      approved_sha256: sha256('a DIFFERENT approved text than the file, from tool_input.plan, for B9'),
      file_sha256_at_approval: sha256(fileBytes),
      text_file_mismatch: true,
    });
    const { ctx } = h1(dir, { source: 'startup' });
    assert.match(ctx, /UNCHANGED/, 'the file itself was never edited since approval — live status reads UNCHANGED (PIN 14c)');
    assert.match(ctx, /mismatch/i, 'the approved-text-vs-file mismatch AT APPROVAL TIME is also disclosed, distinct from the live-file status');
  } finally {
    cleanup();
  }
});
