// R1 PIN RE-CUT — the rotation note's dispatch set, under the TRI-STATE status.
//
// CONTRACT SOURCE: decision `review-receipt-rebuild-invariant-three-owner-modules-tri-state-liveness-receipt-bound-supersession`
// + contract sheet §1.1 (rotation-note policy) / §6 A1, A2, A6, A9. The board
// item this file was born from (a coder kept running invisibly across a /clear,
// and the fresh session dispatched a second one at the same slice) is unchanged
// in substance: what changed is that "live" is now a THREE-valued judgement.
//
// THE POLICY:
//   presumed-active   -> listed as a LIVE dispatch (note.live_dispatches).
//   unknown           -> carried, but as UNCERTAIN — never inside live_dispatches
//                        and never inside the "N dispatch(es) were live" count.
//   inactive-confirmed-> ignored (the round ended; nothing to check).
//   availability != ok-> "register unavailable": the live set is not knowable, so
//                        no count is ever fabricated for it.
//
// SESSION JOIN, RESOLVED AMBIGUITY (stated, not silently taken): rotation-note is
// a session-less CLI, so it has no stdin session_id to join on. It therefore
// applies the LEASE HALF of dispatchStatus alone and never classifies an entry
// unknown/other-session — the same reading this file has always documented
// ("H10 fires session_id AND TTL; a session-less CLI can only apply the TTL
// half"). Every fixture below carries session_id 's-live', which matches nothing
// in the environment, precisely so that a session join wrongly applied here
// would turn every entry unknown and fail R1-A71/A72 loudly instead of quietly.
//
// RETIRED: 'no dispatch register at all -> note.live_dispatches is a confirmed empty array, not unknown'
//   — the decision classes ABSENT with CORRUPT as 'registry unavailable' (readRegister
//     returns availability 'absent'), and H1 deletes the register at SessionStart, so a
//     missing file cannot be distinguished from a never-written one. The
//     confirmed-zero CONTROL it provided is preserved, and strengthened, by
//     R1-A70 (an EMPTY ARRAY on disk = availability ok = confirmed zero).
// RETIRED: 'a stale register entry (hours old) is excluded when a fresh entry is also present'
//   — an out-of-lease entry is now UNKNOWN, not dead: dropping it entirely is the
//     silent-loss failure this whole re-cut exists to close. Re-cut as R1-A73/A74.
// CONVERTED: the /unknown/i disclosure assertion -> token('register_unavailable').

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

const token = (c) => new RegExp('\\[' + c + '\\]');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ----- harness idioms copied (not imported) from scripts/tests/hooks-full.test.mjs -----

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-rotation-live-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function gitProject() {
  const { dir, store, cleanup } = makeProject();
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

function readRotationNote(dir) {
  const p = join(dir, '.sterling', 'transient', 'rotation-note.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function h1(dir, over = {}) {
  const r = spawnSync(process.execPath, [H1_SCRIPT], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over }),
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
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out };
}

// ----- register fixtures -----

function registerEntry(agentId, agentType, files, agoMs = 0, over = {}) {
  return {
    agent_id: agentId,
    agent_type: agentType,
    session_id: 's-live',
    files,
    attribution: 'block',
    at: new Date(Date.now() - agoMs).toISOString(),
    ...over,
  };
}

function writeRegister(dir, entries) {
  const p = join(dir, '.sterling', 'transient');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'dispatch-register.json'), typeof entries === 'string' ? entries : JSON.stringify(entries));
}

// --------------------------------------------------------------------------
// R1-A70 (CONTROL, and the replacement for the retired absent-is-empty pin):
// a register that is READABLE and EMPTY is a confirmed zero — the note carries
// an empty array and H1 says nothing at all (P1: no ceremony).
// SABOTAGE: make the note writer report `null` whenever it cannot find any live
// entry (collapsing confirmed-zero into unknown) -> the deepEqual([]) goes red
// here while R1-A75 (genuinely unreadable) stays green.
// --------------------------------------------------------------------------
test('R1-A70 CONTROL: an EMPTY register on disk is a CONFIRMED zero — note.live_dispatches is [] and H1 prints no dispatch line', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, []);
    const r = runRotationNote(dir, ['--next-slice', 'next thing']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readRotationNote(dir).live_dispatches, [], 'readable-and-empty is the one legitimate all-clear');

    const h = h1(dir, { source: 'clear' });
    assert.equal(h.code, 0, h.stderr);
    const ctx = h.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.doesNotMatch(ctx, /dispatch\(es\) were live at rotation/i, 'no line at all when nothing was live');
    assert.doesNotMatch(ctx, token('register_unavailable'), 'an empty register is not an unavailable one');
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// R1-A71: a PRESUMED-ACTIVE entry is captured as {agent_type, agent_id, territory}.
// SABOTAGE: rename the mapped key from `territory` to `files` -> the deepEqual
// goes red on the key name.
// --------------------------------------------------------------------------
test('R1-A71: a presumed-active register entry is captured as {agent_type, agent_id, territory}', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [registerEntry('agent-c7', 'coder', ['scripts/foo.mjs', 'scripts/bar.mjs'], 1_000)]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    assert.deepEqual(readRotationNote(dir).live_dispatches, [
      { agent_type: 'coder', agent_id: 'agent-c7', territory: ['scripts/foo.mjs', 'scripts/bar.mjs'] },
    ]);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// R1-A72: H1 restore re-prints the live set with count, identity and territory.
// SABOTAGE: H1 reads the note but never renders the live_dispatches block ->
// every match() below goes red.
// --------------------------------------------------------------------------
test('R1-A72: H1 rotation restore re-prints a presumed-active dispatch with count, agent_type, agent_id and territory', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [registerEntry('agent-c7', 'coder', ['scripts/foo.mjs', 'scripts/bar.mjs'], 1_000)]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const ctx = h1(dir, { source: 'clear' }).out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.match(ctx, /1 dispatch\(es\) were live at rotation/i, 'names the count');
    assert.match(ctx, /ListAgents/, 'names the remedy tool');
    assert.match(ctx, /coder/);
    assert.match(ctx, /agent-c7/);
    assert.match(ctx, /scripts\/foo\.mjs/);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// R1-A73 (replaces the retired stale-is-dropped pin): an out-of-lease entry is
// UNKNOWN. It must survive into the note — dropping it is the invisible-agent
// failure this file exists to prevent — but it must never be counted as live.
// SABOTAGE: filter out-of-lease entries out of the captured set entirely (the
// pre-rebuild TTL filter) -> the "carried somewhere" assertion goes red while
// R1-A71 stays green.
// --------------------------------------------------------------------------
test('R1-A73: an out-of-lease (unknown) entry is CARRIED by the note but is never listed as live', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [
      registerEntry('agent-fresh', 'coder', ['scripts/fresh.mjs'], 10_000),
      registerEntry('agent-uncertain', 'coder', ['scripts/uncertain.mjs'], 5 * 60 * 60 * 1000),
    ]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const note = readRotationNote(dir);
    assert.equal(note.live_dispatches.length, 1, 'only the presumed-active entry is LIVE');
    assert.equal(note.live_dispatches[0].agent_id, 'agent-fresh');
    assert.ok(
      JSON.stringify(note).includes('agent-uncertain'),
      'the uncertain dispatch is carried by the note — an entry we cannot confirm dead is never silently dropped'
    );
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// R1-A74: H1 re-prints the uncertain dispatch as UNCERTAIN, with its code, and
// keeps it out of the live COUNT. The count and the uncertainty are asserted
// together because a correct count with no disclosure, and a disclosure with a
// wrong count, are both failures with the same shape in the text.
// SABOTAGE: fold unknown entries into the live count -> the "1 dispatch(es)
// were live" assertion goes red (it would read 2).
// --------------------------------------------------------------------------
test('R1-A74: H1 restore reports the unknown dispatch with [dispatch_status_unknown] and excludes it from the live count', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [
      registerEntry('agent-fresh', 'coder', ['scripts/fresh.mjs'], 10_000),
      registerEntry('agent-uncertain', 'test-writer', ['scripts/uncertain.mjs'], 5 * 60 * 60 * 1000),
    ]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const ctx = h1(dir, { source: 'clear' }).out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /1 dispatch\(es\) were live at rotation/i, 'exactly the presumed-active one is counted as live');
    assert.match(ctx, /agent-uncertain/, 'the uncertain dispatch is still surfaced to the operator');
    assert.match(ctx, token('dispatch_status_unknown'), 'and it is surfaced as UNCERTAIN, carrying its code');
    assert.doesNotMatch(ctx, /NaN/);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// R1-A75: an ENDED entry is inactive-confirmed and is ignored — not live, and
// not uncertain either. This is the arm that keeps A73's "carry everything"
// from degenerating into "print the whole register forever".
// SABOTAGE: treat `ended` as ordinary metadata (classify by age alone) -> the
// entry reappears as live or uncertain and both assertions go red.
// --------------------------------------------------------------------------
test('R1-A75: an ENDED (inactive-confirmed) entry is ignored entirely — neither live nor uncertain', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [
      registerEntry('agent-fresh', 'coder', ['scripts/fresh.mjs'], 10_000),
      registerEntry('agent-done', 'coder', ['scripts/done.mjs'], 10_000, { ended: { at: new Date().toISOString(), event: 'subagent-stop' } }),
    ]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const note = readRotationNote(dir);
    assert.deepEqual(note.live_dispatches.map((e) => e.agent_id), ['agent-fresh'], 'a stopped round is not live');

    const ctx = h1(dir, { source: 'clear' }).out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /1 dispatch\(es\) were live at rotation/i);
    assert.ok(!ctx.includes('agent-done'), `a confirmed-inactive dispatch is not worth the operator's attention — ctx=${ctx}`);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// R1-A76: an UNAVAILABLE register (present but unreadable) never becomes a
// silent empty set. R1-A70 is this test's control: only the readable-empty case
// may report [].
// SABOTAGE: degrade a JSON parse failure to [] (treat corrupt exactly like
// empty) -> `live_dispatches === null` goes red.
// --------------------------------------------------------------------------
test('R1-A76: a CORRUPT register yields the unknown marker in the note, never a silent empty array', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, '{not valid json,,,\n');
    const r = runRotationNote(dir, ['--next-slice', 'next thing']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readRotationNote(dir).live_dispatches, null, 'an unreadable register is unknown, not confirmed-empty');
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// R1-A77: an ABSENT register is availability 'absent' — also unavailable, per
// the decision ("a corrupt or ABSENT register is 'registry unavailable'").
// H1 wipes the register at SessionStart, so a missing file cannot be
// distinguished from a never-written one; only an on-disk [] proves zero.
// SABOTAGE: special-case a missing file to [] -> this goes red while R1-A70
// (the genuine confirmed-zero) stays green, which is what separates the two.
// --------------------------------------------------------------------------
test('R1-A77: an ABSENT register is unavailable too — the note carries the unknown marker, not a confirmed zero', () => {
  const { dir, cleanup } = gitProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 'next thing']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readRotationNote(dir).live_dispatches, null, 'no register file is not proof that nothing was dispatched');
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// R1-A78: H1 discloses the unavailability with [register_unavailable] and never
// fabricates a count for a set it could not read.
// SABOTAGE: H1 treats `live_dispatches === null` identically to [] (prints
// nothing) -> the token assertion goes red (no disclosure at all).
// --------------------------------------------------------------------------
test('R1-A78: H1 restore discloses an unreadable register with [register_unavailable] and fabricates no count', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, '{not valid json,,,\n');
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const ctx = h1(dir, { source: 'clear' }).out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.doesNotMatch(ctx, /\d+ dispatch\(es\) were live at rotation/i, 'never a fabricated count for an unverifiable set');
    assert.match(ctx, token('register_unavailable'), 'the unavailability carries its code');
    assert.match(ctx, /ListAgents/, 'and still points at the same remedy');
  } finally {
    cleanup();
  }
});
