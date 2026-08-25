// DEAD-DISPATCH RESIDUE + EXCLUSIVE NON-FILE RESOURCE CLAIM — SPEC ONLY,
// red-first. Authored BLIND to scripts/hooks/h22-dispatch-register.mjs,
// scripts/hooks/h10-direct-capture.mjs, scripts/hooks/h1-session-start.mjs,
// scripts/hooks/h26-dispatch-overlap.mjs, scripts/hooks/lib/*.mjs — no hook
// or lib source was read to write these pins (H4). Harness conventions
// (runHook idiom, makeProject, register fixtures, out()/parseAdditionalContext,
// agoISO, git() setup helper) are learned from
// scripts/tests/h22-dispatch-register.test.mjs, scripts/tests/h1-session-residue.test.mjs,
// scripts/tests/h26-dispatch-overlap.test.mjs, scripts/tests/h22-attribution.test.mjs,
// scripts/tests/h25-h26-advisory-precision.test.mjs and scripts/tests/h17-stamp-honor.test.mjs
// (all TESTS, never their subjects' source), reused/duplicated locally without
// editing any of those files.
//
// SPEC (given by the launching agent, from board 03ed9d35-32fb-433e-b714-
// f7ab9e8b68e7 + board 31565253-cc6e-44fa-bb32-06f7b69fef8d, design pass
// approved 2026-08-24 — see also reference_material a2a17efa §13.4/§13.6 for
// the incidents that motivated both):
//
// SPEC A — DEAD-DISPATCH RESIDUE. The H22 register is the sole observable.
// An entry outliving config.dispatch_register.stale_minutes (default 60,
// per decision ec9eacaa) whose SubagentStop never fired is an ORPHAN. When
// an orphan's declared files are git-dirty, ONE conductor-facing residue
// line fires — at H10's Stop surface, again at H1's SessionStart if it
// survives to the register wipe — shaped like: "dispatch <type>:<id>
// stopped holding uncommitted edits to <paths>; its gates did not
// complete." Separately, a KILL is detectable immediately at H22's own
// SubagentStop firing (no TTL wait needed) via the real stdin field
// `last_assistant_message` (confirmed live by research_finding 20b44518):
// empty/absent + dirty declared files -> residue; a normal non-empty final
// message -> no residue (agents always produce one). A git-probe failure
// must never silently drop the residue; it prints, marked
// tree-state-unverified.
//
// ASSUMPTIONS DISCLOSED (the spec does not name the exact seam, so these
// are pinned at the hook-invocation level per the launching agent's
// instruction, not inferred from source):
//   (a) "print-once" (residue_reported_at) is pinned from the READ side
//       only: a register entry that already carries a truthy
//       residue_reported_at is never re-reported, at EITHER H10 or H1. One
//       test also pins that H10, having just reported an orphan for the
//       first time, leaves the on-disk entry carrying a truthy
//       residue_reported_at afterward — this is the minimal write behavior
//       the print-once guarantee requires to survive across Stops within
//       one session (the register is not wiped between Stops, only at
//       SubagentStop-match or SessionStart).
//   (b) the residue line's exact punctuation is not pinned char-for-char;
//       assertions check for the dispatch identity `type:id`, the
//       overlapping path(s), the word "uncommitted", and a "gates ...
//       (did not complete|incomplete)" style phrase, mirroring the
//       token-level (not string-level) assertion style already used by
//       scripts/tests/h26-dispatch-overlap.test.mjs's assertOverlapWarning.
//   (c) the fail-loud git-probe-failure behavior (item 7) is pinned only at
//       H10's Stop surface; the same posture is expected to generalize to
//       H1/H22 but is not separately re-pinned here (avoiding 3x redundant
//       coverage of one posture).
//   (d) output channel is unspecified for H10/H22 (stdout vs stderr), so
//       assertions search the UNION (the same `out()` idiom
//       h22-dispatch-register.test.mjs already uses for H10), never
//       anchoring to one stream.
//
// SPEC B — EXCLUSIVE NON-FILE RESOURCE CLAIM. .sterling/config.json gains a
// top-level `exclusive_resources: string[]` (e.g. ["windowed-godot"]). A
// dispatch brief whose prompt claims a configured resource name (and is not
// negated, using the existing negation/attribution module semantics probed
// in scripts/tests/h25-h26-advisory-precision.test.mjs — bare negators get a
// bounded, comma-terminated reach) writes `exclusive_resources` onto the
// H22 register entry at SubagentStart; a negated mention writes no such
// field at all. H26 warns, beside file territory, when an outgoing brief
// claims a resource a LIVE register entry already holds — and this check
// runs BEFORE H26's read-only-class early return, so it fires even for a
// read-only dispatch type whose FILE overlaps are suppressed. An
// unparseable/oddly-charactered configured resource name is still printed
// plainly (uncaveated) when claimed, never dropped. A SubagentStart
// injection tells a newly spawned agent "you do not hold <resource>" when
// another live entry holds it; the entry being written for THIS spawn is
// excluded from that check against itself (control: an empty register plus
// a self-claim never self-warns).
//
// EXPECTED FAILURE SHAPE (today): none of this exists. h22-dispatch-
// register.mjs writes no residue, no exclusive_resources, no SubagentStart
// injection; h10-direct-capture.mjs and h1-session-start.mjs know nothing
// of git-dirty orphan detection; h26-dispatch-overlap.mjs has no resource
// concept at all. Every SILENT-shaped assertion below (assertNoResidue /
// assertH26Silent-style) is already satisfiable trivially today (nothing
// exists to fire), so those are the CONTROL/regression-net half; every
// WARN/residue-shaped assertion is RED today because the advisory text it
// searches for does not exist yet — named per test below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

// ---------------------------------------------------------------------------
// Shared low-level runner (mirrors every sibling suite's spawnSync idiom)
// ---------------------------------------------------------------------------

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

function out(r) {
  return `${r.stdout}\n${r.stderr}`;
}

function parseAdditionalContext(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return ''; // some of these hooks may not emit JSON at all — caller uses out() when unsure
  }
  return parsed?.hookSpecificOutput?.additionalContext ?? '';
}

function tokenRe(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc.replace(/\//g, '\\/'), 'i');
}

// ---------------------------------------------------------------------------
// git setup helper (mirrors scripts/tests/h17-stamp-honor.test.mjs)
// ---------------------------------------------------------------------------

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
  dispatch_register: { stale_minutes: 5 },
  exclusive_resources: ['windowed-godot'],
};

function writeConfig(dir, overrides) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG, ...overrides }));
}

// A git-backed Sterling project: tracked files src/a.mjs + src/b.mjs
// committed at init, so tests can dirty either (or neither) afterward.
function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-residue-'));
  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'residue@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'Residue Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });

  writeFileSync(join(dir, '.gitignore'), ['.sterling/', ''].join('\n'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src', 'b.mjs'), 'export const b = 1;\n');
  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A Sterling project with NO .git at all — forces any git probe to fail.
function makeNonGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-residue-nogit-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function dirty(dir, relPath) {
  writeFileSync(join(dir, relPath), '// dirtied\nexport const changed = true;\n');
}

function agoISO(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// register fixtures (mirrors scripts/tests/h22-dispatch-register.test.mjs)
// ---------------------------------------------------------------------------

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}
function registerExists(dir) {
  return existsSync(registerPath(dir));
}
function readRegister(dir) {
  return JSON.parse(readFileSync(registerPath(dir), 'utf8'));
}
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

function h1(dir, source, envOverride = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
    ...envOverride,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // caller asserts as needed
  }
  return { ...r, additionalContext: json?.hookSpecificOutput?.additionalContext ?? '' };
}

function h22StartInput(dir, over = {}) {
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

function h22StopInput(dir, over = {}) {
  return {
    session_id: 's1',
    transcript_path: join(dir, 't', 'parent.jsonl'),
    cwd: dir,
    prompt_id: 'pr-1',
    agent_id: 'agent-1',
    agent_type: 'coder',
    hook_event_name: 'SubagentStop',
    agent_transcript_path: join(dir, 't', 'sub.jsonl'),
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [],
    last_assistant_message: 'Done. All tests pass.',
    ...over,
  };
}

function writeParentTranscript(dir, lines, name = 'parent.jsonl') {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const textLine = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const taskLine = (blocks) => ({ type: 'assistant', message: { content: blocks } });
const taskBlock = (name, subagent_type, prompt) => ({ type: 'tool_use', name, input: { subagent_type, prompt } });

function h26TaskInput(dir, { subagent_type = 'coder', prompt, session_id = 's1', tool_name = 'Task' } = {}) {
  return { hook_event_name: 'PreToolUse', tool_name, session_id, cwd: dir, tool_input: { subagent_type, prompt } };
}

// A live register entry with a full base shape (attribution:'block' so it
// is eligible to participate in H26 comparisons at all, per decision
// h22-per-block-attribution — irrelevant to H10/H1/H22-Stop residue, which
// key on session_id/age/files only, but harmless to include everywhere).
function liveEntry(agentId, agentType, files, { sessionId = 's1', minutesAgo = 0, extra = {} } = {}) {
  return { agent_id: agentId, agent_type: agentType, session_id: sessionId, files, at: agoISO(minutesAgo), attribution: 'block', ...extra };
}

function assertResidue(text, { agentType, agentId, paths }) {
  assert.ok(text.includes(`${agentType}:${agentId}`), `residue must name the dispatch as '${agentType}:${agentId}'; got: ${text}`);
  for (const p of paths) assert.match(text, tokenRe(p), `residue must name path '${p}'`);
  assert.match(text, /uncommitted/i, 'residue must call out uncommitted edits');
  assert.match(text, /gates?[^.]*(did not|didn.t|never) complete|incomplete/i, 'residue must say the gates did not complete');
}

function assertNoResidue(text, { agentId }) {
  assert.doesNotMatch(text, new RegExp(agentId, 'i'), `must not name '${agentId}' in a residue line; got: ${text}`);
}

// ===========================================================================
// SPEC A — DEAD DISPATCH RESIDUE
// ===========================================================================

// --- (1) H10 Stop: orphan (stale) + dirty declared files -> residue -------
// EXPECTED RED: h10-direct-capture.mjs has no register-orphan/git-dirty
// concept at all today; `out(r)` will not contain 'coder:orphan-1' framed as
// residue, failing assertResidue's identity assertion.
// SABOTAGE: once built, comment out the git-dirty check (treat every
// declared file as clean) — this test goes red while test (4)'s clean
// control stays green (proving the sabotage targets dirtiness, not orphan
// detection itself).
test('SPEC A (1): H10 Stop reports residue for an orphaned (TTL-expired) entry whose declared files are git-dirty', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    dirty(dir, 'src/a.mjs');
    writeRegisterRaw(dir, [liveEntry('orphan-1', 'coder', ['src/a.mjs'], { minutesAgo: 10 })]); // stale_minutes=5
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assertResidue(out(r), { agentType: 'coder', agentId: 'orphan-1', paths: ['src/a.mjs'] });
  } finally {
    cleanup();
  }
});

// --- (4) CONTROL: orphan but CLEAN files -> no residue --------------------
// EXPECTED GREEN today (nothing exists) and after the fix (clean files never
// trigger the residue line).
// SABOTAGE: drop the dirty-check entirely (report residue for every orphan
// regardless of git state) — flips this test red while (1) stays green.
test('SPEC A (4) CONTROL: an orphaned entry whose declared files are NOT git-dirty produces no residue line', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeRegisterRaw(dir, [liveEntry('orphan-clean', 'coder', ['src/a.mjs'], { minutesAgo: 10 })]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assertNoResidue(out(r), { agentId: 'orphan-clean' });
  } finally {
    cleanup();
  }
});

// --- (5) CONTROL: LIVE (in-TTL) entry, even with dirty files -> no residue -
// EXPECTED GREEN today; must stay green after the fix — a live dispatch
// legitimately holds uncommitted edits mid-flight.
// SABOTAGE: drop the liveness/TTL check (report residue for ANY dirty
// declared-file entry regardless of age) — flips this test red while (1)
// stays green (proving staleness, not dirtiness alone, gates the report).
test('SPEC A (5) CONTROL: a LIVE (in-TTL) entry with dirty declared files produces no residue — still in flight', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    dirty(dir, 'src/a.mjs');
    writeRegisterRaw(dir, [liveEntry('live-1', 'coder', ['src/a.mjs'], { minutesAgo: 1 })]); // well under stale_minutes=5
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assertNoResidue(out(r), { agentId: 'live-1' });
  } finally {
    cleanup();
  }
});

// --- (2) H1 SessionStart: same residue for an entry surviving to the wipe -
// EXPECTED RED: h1-session-start.mjs has no such concept today.
// SABOTAGE: gate the H1-side residue report on source==='startup' only,
// forgetting 'clear' (today's register-wipe is unconditional for both) —
// this specific test (source='startup') stays green under that sabotage;
// paired here only for 'startup' deliberately, matching AC1a's existing
// startup/clear split convention rather than re-asserting it.
test('SPEC A (2): H1 SessionStart (startup) reports residue for an orphaned dirty entry before wiping the register', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    dirty(dir, 'src/b.mjs');
    writeRegisterRaw(dir, [liveEntry('orphan-2', 'reviewer', ['src/b.mjs'], { minutesAgo: 90 })]);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assertResidue(r.additionalContext || out(r), { agentType: 'reviewer', agentId: 'orphan-2', paths: ['src/b.mjs'] });
  } finally {
    cleanup();
  }
});

// --- (3a) print-once, read side, at H10 ------------------------------------
// EXPECTED RED today for the WRONG reason (nothing exists, so the entry
// simply never gets reported at all) — but this test's job is to hold once
// the feature exists: an entry ALREADY stamped must not be reported.
// SABOTAGE: report residue unconditionally whenever orphan+dirty, ignoring
// any pre-existing residue_reported_at — flips this test red while (1)
// (unstamped) stays green.
test('SPEC A (3a): an entry already carrying residue_reported_at is never re-reported at H10 Stop', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    dirty(dir, 'src/a.mjs');
    writeRegisterRaw(dir, [liveEntry('orphan-3', 'coder', ['src/a.mjs'], { minutesAgo: 10, extra: { residue_reported_at: agoISO(9) } })]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assertNoResidue(out(r), { agentId: 'orphan-3' });
  } finally {
    cleanup();
  }
});

// --- (3b) print-once, read side, at H1 -------------------------------------
// Same shape as (3a) but at the H1 surface — pins that the suppression
// applies cross-surface (an H10-stamped entry does not re-fire at H1 either).
// SABOTAGE: scope the residue_reported_at check to H10 only (H1 ignores the
// field and reports unconditionally) — flips this test red while (2)
// (unstamped) stays green.
test('SPEC A (3b): an entry already carrying residue_reported_at is never re-reported at H1 SessionStart either', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    dirty(dir, 'src/b.mjs');
    writeRegisterRaw(dir, [liveEntry('orphan-4', 'coder', ['src/b.mjs'], { minutesAgo: 90, extra: { residue_reported_at: agoISO(80) } })]);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assertNoResidue(r.additionalContext || out(r), { agentId: 'orphan-4' });
  } finally {
    cleanup();
  }
});

// --- (3c) print-once, WRITE side: H10 stamps after its first report -------
// Pins the minimal write behavior the print-once guarantee needs to survive
// across Stops within one session (register is not wiped between Stops).
// EXPECTED RED today: h10-direct-capture.mjs writes nothing to the register
// (an existing pinned invariant for a DIFFERENT duty — case 7 of
// h22-dispatch-register.test.mjs, "H10 never mutates the dispatch register
// itself" — this test pins the NEW, additive residue-stamp write, not a
// contradiction of that older invariant).
// SABOTAGE: report residue but never persist the stamp — flips this test
// red (the second read shows no residue_reported_at) while (1) stays green
// (the report itself still fires the first time).
test('SPEC A (3c): after H10 reports an orphan once, the on-disk entry gains a truthy residue_reported_at', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    dirty(dir, 'src/a.mjs');
    writeRegisterRaw(dir, [liveEntry('orphan-5', 'coder', ['src/a.mjs'], { minutesAgo: 10 })]);
    const first = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assertResidue(out(first), { agentType: 'coder', agentId: 'orphan-5', paths: ['src/a.mjs'] });

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'orphan-5');
    assert.ok(entry, 'entry survives the first Stop (not removed by H10 — only SubagentStop/H1 remove entries)');
    assert.ok(entry.residue_reported_at, 'the entry now carries a truthy residue_reported_at stamp');

    const second = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assertNoResidue(out(second), { agentId: 'orphan-5' });
  } finally {
    cleanup();
  }
});

// --- (6) H22 SubagentStop kill-detection: dirty + EMPTY last_assistant_message
// EXPECTED RED: h22-dispatch-register.mjs has no kill-detection concept;
// today's SubagentStop path only removes the matching entry.
// SABOTAGE: read last_assistant_message but treat only `undefined` (never
// an empty string '') as "absent" — this exact test uses an empty string,
// so that narrower sabotage flips it red while a companion using an absent
// field (omitted key) would stay green, proving both forms must be covered.
test('SPEC A (6): H22 SubagentStop records residue when the departing entry holds dirty files AND last_assistant_message is empty (kill signature)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    dirty(dir, 'src/a.mjs');
    dirty(dir, 'src/b.mjs');
    writeRegisterRaw(dir, [liveEntry('killed-1', 'coder', ['src/a.mjs', 'src/b.mjs'], { minutesAgo: 0 })]);
    const r = runHook('h22-dispatch-register.mjs', h22StopInput(dir, { agent_id: 'killed-1', last_assistant_message: '' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertResidue(out(r), { agentType: 'coder', agentId: 'killed-1', paths: ['src/a.mjs', 'src/b.mjs'] });
  } finally {
    cleanup();
  }
});

// --- (6) CONTROL: same dirty files, but a NORMAL non-empty final message --
// EXPECTED GREEN today (nothing fires) and after the fix (a normal agent
// completion is not a kill).
// SABOTAGE: drop the last_assistant_message check entirely (report residue
// for any dirty departing entry regardless of its final message) — flips
// this control red while (6) stays green.
test('SPEC A (6) CONTROL: a departing entry with dirty files but a NON-EMPTY last_assistant_message records no residue', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    dirty(dir, 'src/a.mjs');
    writeRegisterRaw(dir, [liveEntry('finished-1', 'coder', ['src/a.mjs'], { minutesAgo: 0 })]);
    const r = runHook('h22-dispatch-register.mjs', h22StopInput(dir, { agent_id: 'finished-1', last_assistant_message: 'All done, gates green.' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoResidue(out(r), { agentId: 'finished-1' });
  } finally {
    cleanup();
  }
});

// --- (7) fail-loud: git probe failure never silently drops the residue ----
// EXPECTED RED: no fail-loud posture exists yet (and today's hook doesn't
// even attempt a git probe).
// SABOTAGE: on a git-probe error, swallow it and treat the entry as clean
// (silently skip reporting) — flips this test red while (1) (a working git
// probe on the same orphan shape) stays green.
test('SPEC A (7): a git-probe failure still prints the residue line, marked tree-state-unverified, never silently dropped', () => {
  const { dir, cleanup } = makeNonGitProject(); // no .git/ at all — any git command here fails
  try {
    writeRegisterRaw(dir, [liveEntry('orphan-nogit', 'coder', ['src/a.mjs'], { minutesAgo: 10 })]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    const text = out(r);
    assert.ok(text.includes('coder:orphan-nogit'), `must still name the dispatch; got: ${text}`);
    assert.match(text, /tree-state-unverified/i, 'an unverifiable tree state is disclosed, not silently dropped');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC B — EXCLUSIVE NON-FILE RESOURCE CLAIM
// ===========================================================================

// --- (B1) SubagentStart: a claim writes exclusive_resources on the entry --
// EXPECTED RED: h22-dispatch-register.mjs writes no such field today.
// SABOTAGE: never write the field even when claimed (silently drop it) —
// flips this test red while (B2)'s negation test stays green (both would
// show no field, but for opposite legitimate reasons only if this sabotage
// existed; distinguished here by this test's positive assertion failing).
test('SPEC B (1): a dispatch brief claiming a configured resource writes exclusive_resources on the H22 register entry', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'coder', 'This dispatch will hold the windowed-godot slot for its run; do not start a second one.')])]);
    const r = runHook('h22-dispatch-register.mjs', h22StartInput(dir, { agent_id: 'holder-1', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'holder-1');
    assert.ok(entry, 'entry was appended');
    assert.deepEqual(entry.exclusive_resources, ['windowed-godot'], 'the claimed configured resource is written onto the entry');
  } finally {
    cleanup();
  }
});

// --- (B2) negated mention is NOT a claim -----------------------------------
// EXPECTED RED: without a negation guard, "No windowed-godot run" would
// still be scanned as a bare mention and the field would wrongly appear.
// SABOTAGE: remove the negation guard from the resource-claim scan (one
// line) — flips this test red while (B1) (a genuine, unnegated claim)
// stays green.
test('SPEC B (2): a negated mention of a configured resource writes NO exclusive_resources field at all', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'coder', 'No windowed-godot run for this dispatch — another lane holds that slot. Proceed with the file changes only.')])]);
    const r = runHook('h22-dispatch-register.mjs', h22StartInput(dir, { agent_id: 'nonholder-1', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'nonholder-1');
    assert.ok(entry, 'entry was appended');
    assert.ok(!('exclusive_resources' in entry), 'a negated mention never mints the field, not even as an empty array');
  } finally {
    cleanup();
  }
});

// --- (B3) H26 warns on a live resource-holder overlap ----------------------
// EXPECTED RED: h26-dispatch-overlap.mjs has no resource concept at all
// (grep count 0 per research_finding dff23647's baseline for the sibling
// file-overlap advisory; the resource check does not exist).
// SABOTAGE: compare only `files`, never `exclusive_resources` — flips this
// test red while its own no-overlap control (different resource name)
// stays green.
test('SPEC B (3): H26 warns when an outgoing brief claims a resource a LIVE register entry already holds', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeRegisterRaw(dir, [liveEntry('holder-2', 'coder', [], { extra: { exclusive_resources: ['windowed-godot'] } })]);
    const r = runHook(
      'h26-dispatch-overlap.mjs',
      h26TaskInput(dir, { subagent_type: 'coder', prompt: 'Run the windowed-godot session to verify the render, then report back.' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = parseAdditionalContext(r) || out(r);
    assert.match(ctx, /windowed-godot/i, 'advisory names the contested resource');
    assert.ok(ctx.includes('coder:holder-2'), `advisory names the holding dispatch; got: ${ctx}`);
  } finally {
    cleanup();
  }
});

// --- (B3) CONTROL: no resource overlap -> silent ---------------------------
test('SPEC B (3) CONTROL: a live entry holding a DIFFERENT resource than the outgoing claim never warns on resources', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeConfig(dir, { exclusive_resources: ['windowed-godot', 'shared-db-migration'] });
    writeRegisterRaw(dir, [liveEntry('holder-3', 'coder', [], { extra: { exclusive_resources: ['shared-db-migration'] } })]);
    const r = runHook(
      'h26-dispatch-overlap.mjs',
      h26TaskInput(dir, { subagent_type: 'coder', prompt: 'Run the windowed-godot session to verify the render.' }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = parseAdditionalContext(r) || out(r);
    assert.doesNotMatch(ctx, /shared-db-migration/i, 'the non-overlapping resource is never named');
    assert.ok(!ctx.includes('coder:holder-3'), 'the non-overlapping holder is never named');
  } finally {
    cleanup();
  }
});

// --- (B4) resource check fires for a read-only dispatch type, self-controlled
// Self-controlling in one call: the SAME outgoing dispatch also names a file
// that overlaps a live entry's FILE territory — per the existing read-only-
// class exemption (H26 (i) in h25-h26-advisory-precision.test.mjs), a
// reviewer-class dispatch's FILE overlap must stay silent, while its
// RESOURCE overlap must still fire — proving the resource check runs BEFORE
// the read-only early return, not after it.
// EXPECTED RED: no resource check exists yet at all.
// SABOTAGE: place the resource check AFTER the read-only-class early return
// (one line moved) — flips this test's resource assertion red while leaving
// the file-silence half green (proving the ordering, not the existence, of
// the resource check is what's under test).
test('SPEC B (4): the resource check fires for a read-only (reviewer-class) dispatch even though its FILE overlap is suppressed', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeRegisterRaw(dir, [
      liveEntry('sub-file', 'coder', ['src/shared/util.mjs']),
      liveEntry('sub-res', 'coder', [], { extra: { exclusive_resources: ['windowed-godot'] } }),
    ]);
    const r = runHook(
      'h26-dispatch-overlap.mjs',
      h26TaskInput(dir, {
        subagent_type: 'reviewer-correctness',
        prompt: 'Review src/shared/util.mjs and also run the windowed-godot session to check the render.',
      }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = parseAdditionalContext(r) || out(r);
    assert.doesNotMatch(ctx, tokenRe('src/shared/util.mjs'), 'read-only class: file overlap stays suppressed, as today');
    assert.match(ctx, /windowed-godot/i, 'read-only class: resource overlap still fires — the resource check precedes the early return');
  } finally {
    cleanup();
  }
});

// --- (B5) unparseable configured name printed uncaveated, never dropped ---
// EXPECTED RED: no resource check exists yet; once built, a naive
// implementation might silently drop a name containing regex-special
// characters rather than escape it.
// SABOTAGE: build the resource match via an unescaped RegExp from the
// configured name (special characters throw or fail to match) with the
// error swallowed and the claim dropped — flips this test red while (B3)
// (a plain alphanumeric-ish name) stays green.
test('SPEC B (5): a claimed resource with regex-special characters in its configured name is printed plainly, never dropped', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const oddName = 'godot (v2.x)';
    writeConfig(dir, { exclusive_resources: [oddName] });
    writeRegisterRaw(dir, [liveEntry('holder-odd', 'coder', [], { extra: { exclusive_resources: [oddName] } })]);
    const r = runHook(
      'h26-dispatch-overlap.mjs',
      h26TaskInput(dir, { subagent_type: 'coder', prompt: `Run the ${oddName} session to verify the render.` }),
      dir
    );
    assert.notEqual(r.code, 2, `must never deny; stderr: ${r.stderr}`);
    const ctx = parseAdditionalContext(r) || out(r);
    assert.ok(ctx.includes(oddName), `the oddly-named resource is named plainly, uncaveated; got: ${ctx}`);
    assert.doesNotMatch(ctx, /possibl|maybe|uncertain|might be/i, 'the claim is stated, not hedged');
  } finally {
    cleanup();
  }
});

// --- (B6) SubagentStart injection: "you do not hold <resource>" -----------
// EXPECTED RED: no such injection exists today.
// SABOTAGE: compute "who holds resource X" by scanning the register BEFORE
// pruning foreign/stale entries, or simply never emit the notice — flips
// this test red while its own control (B6-control below) stays green.
test('SPEC B (6): SubagentStart injects "you do not hold <resource>" naming the live holder, for a spawn that does not itself claim it', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeRegisterRaw(dir, [liveEntry('holder-4', 'coder', [], { extra: { exclusive_resources: ['windowed-godot'] } })]);
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'reviewer', 'Please review src/a.mjs for correctness; no windowed run needed here.')])]);
    const r = runHook('h22-dispatch-register.mjs', h22StartInput(dir, { agent_id: 'spawn-1', agent_type: 'reviewer' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const text = parseAdditionalContext(r) || out(r);
    assert.match(text, /do not hold/i, 'the notice states the spawn does not hold the resource');
    assert.match(text, /windowed-godot/i, 'the notice names the resource');
    assert.ok(text.includes('coder:holder-4'), `the notice names the live holder; got: ${text}`);
  } finally {
    cleanup();
  }
});

// --- (B6) CONTROL: empty register + a self-claim -> no self-referential notice
// EXPECTED GREEN today (nothing exists, nothing to say) and after the fix:
// with no OTHER live holder, a spawn claiming the resource for itself must
// never be told it does not hold what it is, in this very call, claiming.
// SABOTAGE: compute "who holds X" by scanning the register AFTER this
// spawn's own entry has already been appended, without excluding it — a new
// sole claimant would then see its own just-written entry and could wrongly
// receive a self-referential "you do not hold" notice — flips this control
// red while (B6) (a genuine OTHER holder) stays green.
test('SPEC B (6) CONTROL: an empty register plus a self-claim never produces a self-referential "you do not hold" notice', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'coder', 'This dispatch will hold the windowed-godot slot for its run.')])]);
    const r = runHook('h22-dispatch-register.mjs', h22StartInput(dir, { agent_id: 'sole-claimant', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const text = parseAdditionalContext(r) || out(r);
    assert.doesNotMatch(text, /do not hold/i, 'the sole/first claimant of a resource is never told it does not hold what it just claimed');
  } finally {
    cleanup();
  }
});
