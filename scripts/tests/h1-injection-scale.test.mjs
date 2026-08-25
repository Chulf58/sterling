// H1 SessionStart — injection SCALE pins (two board-item specs, 2026-08-24 feedback wave).
//
// Spec under test (given by the launching agent via board items, not inferred from
// the implementation — h1-session-start.mjs is being changed in parallel and was
// NOT read to write this file; every marker phrase below is mined verbatim from an
// EXISTING H1 test's own assertions, or is a literal quote embedded in the cited
// board item's text).
//
// SPEC 1 (board eeb8ee53): the rotation-restore injection (SessionStart source=clear
// consuming a staged rotation note) currently repeats the Sterling-conventions block
// (~70% duplicate of CLAUDE.md) alongside the note. That block must be TRIMMED from
// this specific injection — the note is the part only H1 can supply. On source=startup
// the conventions block is untouched.
//
// SPEC 2 (board 91fc3d6f): H1's deep-queue banner says "...before taking new work"
// (quoted verbatim in the board item) — a single unconditional instruction that is
// actionable at a modest overage but not at a queue of hundreds (5 closed against 210
// "is not a drain, it is evaporation"). At a modest overage the current bounded ask
// (naming lane counts, ending in the whole-queue-before-new-work instruction) must be
// unchanged. At a queue far over the threshold (hundreds), the message must instead
// name the top lane(s) with counts and offer a bounded ask (e.g. "board a drain
// slice" per the board item's own suggested wording) — and must NOT carry the
// unconditional "before taking new work" instruction, which cannot honestly be
// followed at that size.
//
// Harness mined from scripts/tests/h1-accuracy.test.mjs (runHook/hookInput/envelope/
// makeProject(configOverride) merge pattern, h1()/additionalContext() wrappers) and
// scripts/tests/hooks-full.test.mjs (gitProject()/runRotationNote()/readRotationNote()
// for the rotation-note fixtures, and the deep-queue lane-seeding pattern — system
// todos with system_reason set directly via store.create). Every test below is
// expected to FAIL against the current (unpatched) H1 — the coder's change is what
// should turn each red assertion green.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const ROTATION_SCRIPT = join(root, 'scripts', 'rotation-note.mjs');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

// Mirrors h1-accuracy.test.mjs's BASE_CONFIG so H1's other guarded reads
// (context_watch, caps) don't warn or misbehave and pollute these assertions.
const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
};

function makeProject(configOverride = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1scale-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const config = { ...BASE_CONFIG, ...configOverride };
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

// Git-anchored project, for the rotation-note fixtures — mirrors hooks-full.test.mjs's
// gitProject() (init, .gitignore covering .sterling/ + t/, one base commit).
function gitProject(configOverride = {}) {
  const { dir, store, cleanup } = makeProject(configOverride);
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  writeFileSync(join(dir, 'base.mjs'), '// base\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { dir, store, cleanup };
}

function runRotationNote(dir, args) {
  return spawnSync(process.execPath, [ROTATION_SCRIPT, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}
function rotationNotePath(dir) {
  return join(dir, '.sterling', 'transient', 'rotation-note.json');
}
function rotationNoteExists(dir) {
  return existsSync(rotationNotePath(dir));
}

// --------------------------- H1 invocation ---------------------------

function h1(dir, source = 'startup', envOverride = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
    ...envOverride,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { ...r, out };
}

function additionalContext(res) {
  return (res.out && res.out.hookSpecificOutput ? res.out.hookSpecificOutput.additionalContext : undefined) ?? '';
}

// --------------------------- maintenance-queue fixtures ---------------------------

function maintenanceLane(store, systemReason, count, prefix) {
  for (let i = 0; i < count; i++) {
    store.create({ ...envelope('todo'), text: `${prefix}${i}`, source: 'system', system_reason: systemReason, author: 'system' });
  }
}

// A lane name and a count are considered "paired" if both tokens appear within a
// bounded character window of each other, in either order — a structural proximity
// check rather than a pin on one exact template string (e.g. "N items in lane X" vs
// "drain the N-item X lane"), per this file's instruction to bind to structure where
// exact prose is unknowable ahead of the coder's change.
function pairedNear(text, count, lane, window = 60) {
  const countRe = new RegExp(`\\b${count}\\b`, 'g');
  const laneRe = new RegExp(lane, 'g');
  const countIdx = [...text.matchAll(countRe)].map((m) => m.index);
  const laneIdx = [...text.matchAll(laneRe)].map((m) => m.index);
  for (const ci of countIdx) {
    for (const li of laneIdx) {
      if (Math.abs(ci - li) <= window) return true;
    }
  }
  return false;
}

// The unconditional, un-scoped instruction quoted verbatim in board item 91fc3d6f:
// "...before taking new work". This is the phrase SPEC 2 requires present at modest
// overage and ABSENT once the queue is far over threshold.
const WHOLE_QUEUE_INSTRUCTION = /before taking new work/i;

// The bounded ask SPEC 2 requires at scale, per the board item's own suggested
// wording ("board a drain slice") — distinct from the existing, always-present
// /sterling:drain pointer, which names the remedy tool but is not itself the
// bounded ASK this spec is about.
const BOUNDED_DRAIN_ASK = /drain slice/i;

// --------------------------- SPEC 1 (board eeb8ee53) ---------------------------

test('SPEC1 control: source=startup still injects the Sterling-conventions block in full (Anti-speculation + "Sterling conventions" markers both present)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);
    // Both markers are mined from existing H1 tests' own assertions:
    // hooks-full.test.mjs asserts /Anti-speculation/ on ordinary SessionStart output;
    // hooks-full.test.mjs's rotation-restore tests assert /Sterling conventions/ for
    // source=startup/resume ("conventions intact").
    assert.match(ctx, /Anti-speculation/, 'the conventions block still appears on startup');
    assert.match(ctx, /Sterling conventions/, 'the conventions header still appears on startup');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE: none today — this is the CONTROL, pinning that startup
// keeps behaving as every existing H1 test already shows. It exists to prove that if
// the coder's fix over-applies (drops conventions injection universally instead of
// only for source=clear-with-consumed-note), THIS test is the one that goes red,
// distinguishing that bug from a correctly scoped fix.
// NAMED SABOTAGE: delete/comment out the line(s) that append the conventions block to
// additionalContext (unconditionally, for every source) — this test goes RED because
// neither marker regex matches an empty/absent conventions section.

test('SPEC1: source=clear consuming a staged rotation note OMITS the conventions block but still carries the note payload', () => {
  const { dir, cleanup } = gitProject();
  try {
    const staged = runRotationNote(dir, ['--next-slice', 'Finish Goblin animations', '--risks', 'shader cache flaky']);
    assert.equal(staged.status, 0, `fixture guard: rotation-note.mjs must stage the note: ${staged.stderr}`);
    assert.ok(rotationNoteExists(dir), 'fixture guard: the note file exists before H1 runs');

    const r = h1(dir, 'clear');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);

    // the note payload must still be there — SPEC1 trims conventions, not the note
    assert.match(ctx, /ROTATION RESTORE/, 'the rotation-restore section still fires');
    assert.match(ctx, /Finish Goblin animations/, 'the staged next_slice text is still injected');

    // the conventions block — the ~70%-duplicate-of-CLAUDE.md payload the board item
    // names — must be gone from THIS injection
    assert.doesNotMatch(ctx, /Anti-speculation/, 'the conventions block no longer appears when a rotation note is consumed on clear');
    assert.doesNotMatch(ctx, /Sterling conventions/, 'the conventions header no longer appears when a rotation note is consumed on clear');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red against the CURRENT, unpatched H1): H1 today injects
// the conventions block on every source per hooks-full.test.mjs's own "conventions
// intact" assertions; the two doesNotMatch calls above are the ones expected to fail
// (both markers currently present) until the trim ships.
// NAMED SABOTAGE: revert/omit the trim — i.e. do not special-case source=clear+note-
// consumed to skip the conventions append — this test goes RED because both
// doesNotMatch assertions then find their marker present.

// --------------------------- SPEC 2 (board 91fc3d6f) ---------------------------

test('SPEC2 control: queue modestly over the deep threshold keeps the CURRENT bounded ask — lane counts named, ending in the whole-queue "before taking new work" instruction', () => {
  const { dir, store, cleanup } = makeProject({ maintenance_queue: { deep_threshold: 15 } });
  try {
    maintenanceLane(store, 'reconcile_needed', 12, 'r');
    maintenanceLane(store, 'stale_research', 8, 's');
    // total 20 — modestly over the threshold of 15, the scale SPEC2 says must keep
    // today's shape unchanged.

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);

    assert.match(ctx, /MAINTENANCE QUEUE IS DEEP — 20 drainable items/, 'the true total is still reported');
    assert.ok(pairedNear(ctx, 12, 'reconcile_needed'), 'the reconcile_needed lane is named with its count');
    assert.ok(pairedNear(ctx, 8, 'stale_research'), 'the stale_research lane is named with its count');
    assert.match(ctx, WHOLE_QUEUE_INSTRUCTION, 'at a modest overage the current unconditional drain-before-new-work ask is unchanged');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE: none today — CONTROL, pinning today's shape at modest
// scale. If the coder's scale-awareness fix over-applies (drops the whole-queue
// instruction at EVERY depth instead of only far over threshold), THIS test is the
// one that goes red, distinguishing that over-broad bug from a correctly scaled fix.
// NAMED SABOTAGE: make the "at scale" branch unconditional (fire regardless of how
// far over the threshold the queue is) — this test goes RED because the
// WHOLE_QUEUE_INSTRUCTION match then fails (the old ask is dropped even at a modest
// depth of 20).

test('SPEC2: queue far over the threshold (hundreds) names the top lane with its count and a bounded drain-slice ask — NOT the whole-queue "before taking new work" instruction', () => {
  const { dir, store, cleanup } = makeProject({ maintenance_queue: { deep_threshold: 15 } });
  try {
    maintenanceLane(store, 'reconcile_needed', 150, 'r');
    maintenanceLane(store, 'stale_research', 100, 's');
    maintenanceLane(store, 'article_missing', 50, 'a');
    // total 300 — far over the threshold of 15, the scale the board item says makes
    // the current unconditional instruction unfollowable ("5 closed against 210").

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);

    assert.match(ctx, /MAINTENANCE QUEUE IS (VERY )?DEEP/, 'the deep-queue signal still fires at scale (banner wording may legitimately escalate to "VERY DEEP")');
    assert.ok(pairedNear(ctx, 150, 'reconcile_needed'), 'the top (largest) lane is named together with its count');
    assert.match(ctx, BOUNDED_DRAIN_ASK, 'a bounded ask (offering a drain slice) is present at scale');
    assert.doesNotMatch(ctx, WHOLE_QUEUE_INSTRUCTION, 'the unconditional whole-queue-before-new-work instruction — unfollowable at this size — is gone');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red against the CURRENT, unpatched H1): today's message
// carries the unconditional "...before taking new work" instruction at ANY depth
// above threshold (quoted verbatim in board item 91fc3d6f at 247 items) and offers no
// "drain slice" bounded ask — so both the BOUNDED_DRAIN_ASK match and the
// WHOLE_QUEUE_INSTRUCTION doesNotMatch are expected to fail today (the ask is absent;
// the old instruction is present).
// NAMED SABOTAGE: keep emitting the single fixed-format message at every depth (i.e.
// delete/skip the far-over-threshold branch entirely) — this test goes RED because
// the doesNotMatch(WHOLE_QUEUE_INSTRUCTION) assertion then finds the old instruction
// still present, and/or BOUNDED_DRAIN_ASK finds no "drain slice" offer.

test('SPEC2 boundary: queue at EXACTLY 10x the deep threshold (150) fires the VERY DEEP tier (>= boundary, not >)', () => {
  const { dir, store, cleanup } = makeProject({ maintenance_queue: { deep_threshold: 15 } });
  try {
    maintenanceLane(store, 'reconcile_needed', 150, 'r'); // deep_threshold(15) * 10 exactly
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);
    assert.match(ctx, /MAINTENANCE QUEUE IS VERY DEEP/, 'exactly threshold×10 items must land IN the VERY DEEP tier (>=), not just below it');
  } finally {
    cleanup();
  }
});
// EXPECTED FAILURE SHAPE (red against a >-instead-of->= boundary): if the tier check
// uses a strict > at the threshold×10 boundary, 150 items falls just short of tripping
// VERY DEEP (which would first fire at 151), so this assertion fails to match.
// NAMED SABOTAGE: change the tier boundary comparison from >= to > — this test goes
// RED because the banner at exactly 150 items reverts to the plain DEEP tier.
