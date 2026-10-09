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
import { gitTouches } from '../hooks/lib/settlement.mjs';

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

test('H1 startup seeds a missing git-settled snapshot without absorbing work written after session start; clear does the same and never overwrites an existing snapshot', () => {
  const { dir, cleanup } = gitProject();
  try {
    const snapshot = join(dir, '.sterling', 'transient', 'git-settled.json');
    assert.ok(!existsSync(snapshot), 'fixture starts without a settled snapshot');
    assert.equal(h1(dir, 'startup').code, 0, 'startup remains soft');
    const seeded = JSON.parse(readFileSync(snapshot, 'utf8'));
    assert.equal(typeof seeded.sha, 'string');
    assert.deepEqual(seeded.dirty, {}, 'the clean startup tree is the baseline');
    writeFileSync(join(dir, 'after-start.mjs'), 'export const afterStart = true;\n');
    assert.deepEqual(gitTouches(dir, NOW).candidates.map((c) => c.path), ['after-start.mjs'], 'post-start shell work is visible to the first Stop');
    assert.equal(h1(dir, 'clear').code, 0, 'clear remains soft');
    assert.deepEqual(JSON.parse(readFileSync(snapshot, 'utf8')), seeded, 'an existing startup snapshot is never overwritten by clear');
  } finally {
    cleanup();
  }
});

test('H1 startup injection remains below 14,600 UTF-8 bytes for this repository fixture', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const bytes = Buffer.byteLength(additionalContext(r), 'utf8');
    assert.ok(bytes < 14_600, `startup injection is ${bytes}B; must stay below 14,600B`);
  } finally {
    cleanup();
  }
});

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

// --------------------------- SPEC 1 (board eeb8ee53; RETIRED 2026-09-19, INVERTED then RETIRED AGAIN 2026-09-22) ---------------------------
//
// SPEC1 ORIGINALLY pinned: source=clear trims H1's hardcoded conventions block.
// It was then INVERTED (slice 3, conductor context diet, board d0f3647a) to pin
// that H1 injects docs/conductor-contract.md's bytes verbatim on every source,
// clear included. Decision conductor-instructions-via-main-session-agent-route-a
// (2026-09-22) retires that mechanism too: the conductor's posture now lives in
// agent-templates/conductor.md, installed to .claude/agents/conductor.md and
// activated as the MAIN-SESSION AGENT (the "agent" key in .claude/settings.json)
// — it is the system prompt, never a SessionStart hook injection. H1 carries no
// contract text of any kind any more, on any source. The two tests below are
// REWRITTEN a second time to pin THAT invariant, plus the migration diagnostic
// (CONDUCTOR NOT ACTIVE) that replaces it: H1 disclosing loudly, never silently,
// when a project has not yet run install-agents/sync-agents since the move.

test('H1 startup no longer injects any conductor-contract text ("# Conductor contract" / "You are the delegator" both absent)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);
    assert.doesNotMatch(ctx, /# Conductor contract/, 'the retired contract heading never appears');
    assert.doesNotMatch(ctx, /You are the delegator, not the worker/, 'the retired contract body never appears — it now lives in agent-templates/conductor.md, the main-session agent file, not a hook injection');
  } finally {
    cleanup();
  }
});
// NAMED SABOTAGE: reintroduce conductorContractBlock() (or any read of
// docs/conductor-contract.md) into additionalContext — this test goes RED
// because one of the two markers reappears.

test('H1 clear consuming a staged rotation note carries the note payload but no conductor-contract text', () => {
  const { dir, cleanup } = gitProject();
  try {
    const staged = runRotationNote(dir, ['--next-slice', 'Finish Goblin animations', '--risks', 'shader cache flaky']);
    assert.equal(staged.status, 0, `fixture guard: rotation-note.mjs must stage the note: ${staged.stderr}`);
    assert.ok(rotationNoteExists(dir), 'fixture guard: the note file exists before H1 runs');

    const r = h1(dir, 'clear');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);

    // the note payload is still there — H1 still injects and consumes the rotation note
    assert.match(ctx, /ROTATION RESTORE/, 'the rotation-restore section still fires');
    assert.match(ctx, /Finish Goblin animations/, 'the staged next_slice text is still injected');

    // but the retired contract text is gone, on clear exactly as on startup
    assert.doesNotMatch(ctx, /# Conductor contract/, 'the retired contract heading never appears on clear either');
    assert.doesNotMatch(ctx, /You are the delegator, not the worker/, 'the retired contract body never appears on clear either');
  } finally {
    cleanup();
  }
});
// NAMED SABOTAGE: reintroduce conductorContractBlock() into the clear-path
// additionalContext — this test goes RED because one of the two markers reappears.

// --------------------------- CONDUCTOR ACTIVATION MIGRATION DIAGNOSTIC ---------------------------
// Route A (decision conductor-instructions-via-main-session-agent-route-a): a
// project that has not yet run install-agents/sync-agents since the migration
// has neither .claude/settings.json's "agent" key nor .claude/agents/conductor.md
// — H1 must say so loudly (P5), never leave the conductor silently running the
// default harness prompt with no Sterling posture. Both present -> silence.

function writeSettings(dir, obj) {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function writeConductorAgentFile(dir) {
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'conductor.md'), '---\nname: conductor\ndescription: probe\n---\n\n# Conductor\n');
}

test('CONDUCTOR NOT ACTIVE: no .claude/settings.json at all', () => {
  const { dir, cleanup } = makeProject();
  try {
    const ctx = additionalContext(h1(dir, 'startup'));
    assert.match(ctx, /CONDUCTOR NOT ACTIVE: settings key missing/);
    assert.match(ctx, /sync-agents\.mjs --target/);
    assert.match(ctx, /EXIT AND RELAUNCH/);
  } finally {
    cleanup();
  }
});

test('CONDUCTOR NOT ACTIVE: settings.json present but no "agent" key', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSettings(dir, {});
    writeConductorAgentFile(dir);
    const ctx = additionalContext(h1(dir, 'startup'));
    assert.match(ctx, /CONDUCTOR NOT ACTIVE: settings key missing/);
  } finally {
    cleanup();
  }
});

test('CONDUCTOR NOT ACTIVE: "agent" set to a different value', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSettings(dir, { agent: 'someone-else' });
    writeConductorAgentFile(dir);
    const ctx = additionalContext(h1(dir, 'startup'));
    assert.match(ctx, /CONDUCTOR NOT ACTIVE: settings key is "someone-else"/);
  } finally {
    cleanup();
  }
});

test('CONDUCTOR NOT ACTIVE: "agent": "conductor" set but .claude/agents/conductor.md missing', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSettings(dir, { agent: 'conductor' });
    const ctx = additionalContext(h1(dir, 'startup'));
    assert.match(ctx, /CONDUCTOR NOT ACTIVE: \.claude\/agents\/conductor\.md missing/);
  } finally {
    cleanup();
  }
});

test('CONDUCTOR ACTIVE: settings "agent": "conductor" AND the installed file both present -> no CONDUCTOR NOT ACTIVE line', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSettings(dir, { agent: 'conductor', other_key: 'preserved elsewhere, not H1\'s concern' });
    writeConductorAgentFile(dir);
    const r = h1(dir, 'startup');
    assert.doesNotMatch(additionalContext(r), /CONDUCTOR NOT ACTIVE/);
    assert.doesNotMatch(r.out?.systemMessage ?? '', /CONDUCTOR NOT ACTIVE/, 'nor in the user-visible banner');
  } finally {
    cleanup();
  }
});

// Decision gap-hunt-2026-09-28-rulings item (3): the diagnostic reached only the
// model's additionalContext, so the HUMAN never saw that the session was running
// without the conductor. It now leads the user-visible systemMessage as well,
// carrying the same reason and remedy.
test('CONDUCTOR NOT ACTIVE is shown to the user in systemMessage as well, with the reason and the remedy', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeSettings(dir, { agent: 'conductor' });
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const msg = r.out?.systemMessage ?? '';
    assert.match(msg, /CONDUCTOR NOT ACTIVE: \.claude\/agents\/conductor\.md missing/);
    assert.match(msg, /sync-agents\.mjs --target/);
    assert.match(msg, /EXIT AND RELAUNCH/);
    assert.match(msg, /maintenance items? pending$/, 'the board counts still close the banner');
    assert.match(additionalContext(r), /CONDUCTOR NOT ACTIVE/, 'and the model still sees it');
  } finally {
    cleanup();
  }
});

// Sol review MEDIUM finding: a settings value or a path containing a space (or
// worse, a quote/newline) must never split the diagnostic across lines or break
// the recovery command's shell quoting. A project directory with a space in its
// name is the realistic trigger (Windows/WSL project folders routinely have one).
test('CONDUCTOR NOT ACTIVE: a project path containing a space renders as ONE line with both paths single-quoted (shell-safe, copy-paste-able)', () => {
  const base = mkdtempSync(join(tmpdir(), 'sterling-h1scale-'));
  const dir = join(base, 'my project');
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(BASE_CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    const ctx = additionalContext(r);
    const lines = ctx.split('\n').filter((l) => l.includes('CONDUCTOR NOT ACTIVE'));
    assert.equal(lines.length, 1, 'exactly one line carries the diagnostic');
    const line = lines[0];
    assert.doesNotMatch(line, /\n/, 'the line itself carries no embedded newline');
    assert.match(
      line,
      // CHANGED (plugin-marketplace integration): H1 names the bundled bin/sync-agents.mjs
      // when the plugin ships it (pluginScript, decision
      // sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone), and this
      // repo commits bin/, so the recovery command here is exactly the bin/ form.
      new RegExp(`^CONDUCTOR NOT ACTIVE: settings key missing — run \`node '.*'/bin/sync-agents\\.mjs --target '${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\` then EXIT AND RELAUNCH$`),
      'the exact single-line, single-quoted recovery command'
    );
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});

// --------------------------- SPEC 2 (board 91fc3d6f) ---------------------------

test('SPEC2 control: queue modestly over the deep threshold keeps the CURRENT bounded ask — lane counts named, ending in the whole-queue "before taking new work" instruction', () => {
  const { dir, store, cleanup } = makeProject({ maintenance_queue: { deep_threshold: 15 } });
  try {
    // Lane mix changed with board 27c87783: reconcile_needed is the background
    // worker's lane and no longer counts toward the conductor's depth, so the
    // conductor's lanes carry the 20. CHANGED (GitHub #56): stale_research and article_missing became worker
    // lanes, so capture_owed 12 + research_owed 8 stand in for them.
    maintenanceLane(store, 'capture_owed', 12, 's');
    maintenanceLane(store, 'research_owed', 8, 'a');
    maintenanceLane(store, 'reconcile_needed', 5, 'r');
    // conductor total 20 — modestly over the threshold of 15, the scale SPEC2 says
    // must keep today's shape unchanged.

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);

    assert.match(ctx, /MAINTENANCE QUEUE IS DEEP — 20 drainable items/, 'the conductor\'s total is still reported');
    assert.ok(pairedNear(ctx, 12, 'capture_owed'), 'the capture_owed lane is named with its count');
    assert.ok(pairedNear(ctx, 8, 'research_owed'), 'the research_owed lane is named with its count');
    assert.match(ctx, /5 items in lane reconcile_needed are drained by the background worker/, 'the worker\'s lane is named as the worker\'s');
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
    // CHANGED (GitHub #56): stale_research and article_missing became worker lanes; capture_owed and
    // research_owed keep the conductor's share at 150.
    maintenanceLane(store, 'capture_owed', 100, 's');
    maintenanceLane(store, 'research_owed', 50, 'a');
    // total 300 — far over the threshold of 15, the scale the board item says makes
    // the current unconditional instruction unfollowable ("5 closed against 210").

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    assert.ok(r.out, 'H1 must emit parseable JSON');
    const ctx = additionalContext(r);

    assert.match(ctx, /MAINTENANCE QUEUE IS (VERY )?DEEP/, 'the deep-queue signal still fires at scale (banner wording may legitimately escalate to "VERY DEEP")');
    // reconcile_needed is the largest lane but a worker lane, so the top lane the conductor is asked to drain is capture_owed.
    assert.ok(pairedNear(ctx, 100, 'capture_owed'), 'the top conductor lane is named together with its count');
    assert.match(ctx, /Drain the biggest lane now \(100 items in lane capture_owed\)/, 'the drain ask names the top conductor lane');
    assert.match(ctx, /150 items in lane reconcile_needed are drained by the background worker, not by you/, 'the worker lane is named as the worker\'s');
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
    // Lane changed with board 27c87783: only the conductor's lanes count, and
    // reconcile_needed is the worker's. CHANGED (GitHub #56): so is stale_research now, so capture_owed carries it.
    maintenanceLane(store, 'capture_owed', 150, 'r'); // deep_threshold(15) * 10 exactly
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
