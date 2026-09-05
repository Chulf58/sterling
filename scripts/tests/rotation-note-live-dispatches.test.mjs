// FROZEN SPEC — board efbddf09 (objective dome-farmer-issues-2026-09-05, slice 4):
// "rotation note carries live dispatches". scripts/rotation-note.mjs today has
// zero references to live subagents and H1's restore injection enumerates
// none, so a coder dispatched before /clear kept running invisibly and the
// fresh session dispatched a second coder at the same slice (~330k tokens
// wasted, issues log 2026-09-04).
//
// FIX PINNED HERE (literal spec text from board efbddf09):
//   (1) rotation-note.mjs writes the live dispatch set -- entries of
//       {agent_type, agent_id, territory} -- into the rotation note at write
//       time, taken from the H22 register (.sterling/transient/dispatch-register.json).
//   (2) H1 on restore (source=clear) re-prints it as
//       'N dispatch(es) were live at rotation -- check ListAgents before
//       re-dispatching', listing each agent_type + agent_id + territory.
//   (3) zero live dispatches -> the note carries an empty set and H1 prints
//       NO such line (no ceremony, P1).
//   (4) a register that cannot be read -> the note DISCLOSES that the live
//       set is unknown rather than silently writing an empty one, and H1
//       re-prints the disclosure.
//
// DESIGN CALLS THIS TEST FILE OWNS (not literally spelled out in the board
// item, recorded here so the conductor can see the judgment made):
//   - the note's field is named `live_dispatches` ("the live dispatch set" in
//     the board text) -- a snake_case sibling of the note's other fields
//     (next_slice, commits_ahead, base_branch, ...).
//   - CONFIRMED-ZERO is `[]`; UNKNOWN (register present but unparseable) is
//     `null` -- the same null-vs-empty-object convention this codebase
//     already uses for observed-territory ("null=could-not-observe vs
//     {reads:[],writes:[]}=observed-nothing", h22-dispatch-register article).
//     A MISSING register file (nothing ever dispatched this session) is
//     CONFIRMED-ZERO, not unknown -- only a PRESENT-BUT-UNPARSEABLE register
//     is unknown.
//   - "live" reuses the staleness concept the board item cites H10 as
//     already computing from the same register (H10 fires session_id AND
//     TTL; a session-less CLI can only apply the TTL half) -- an entry hours
//     old is excluded, never printed as still running.
//   - territory is the register entry's `files` array, carried through
//     unchanged.
//
// Every behavioral pin below carries a SABOTAGE comment naming the one-line
// change that must turn it red. All pins are RED at HEAD (grep confirms zero
// references to ListAgents/subagent/"live dispatch" in scripts/rotation-note.mjs
// today per the board item's own evidence).

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
    // mirrors runHook's default env in hooks-full.test.mjs: never let H1's
    // clone-currency probe attempt a real network fetch during this suite.
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

// ----- H22 register fixture helpers (shape per scripts/tests/h22-register-concurrency.test.mjs / h22-attribution.test.mjs) -----

function registerEntry(agentId, agentType, files, agoMs = 0) {
  return {
    agent_id: agentId,
    agent_type: agentType,
    session_id: 's-live',
    files,
    attribution: 'block',
    at: new Date(Date.now() - agoMs).toISOString(),
  };
}

function writeRegister(dir, entries) {
  const p = join(dir, '.sterling', 'transient');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'dispatch-register.json'), JSON.stringify(entries));
}

function writeCorruptRegister(dir) {
  const p = join(dir, '.sterling', 'transient');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'dispatch-register.json'), '{not valid json,,,\n');
}

// --------------------------------------------------------------------------
// PIN 1 (CONTROL for PIN 7): nothing has ever dispatched this session --
// no register file at all. This is CONFIRMED-ZERO, not unknown.
// SABOTAGE: change the note writer to omit `live_dispatches` entirely when
// the register file does not exist (an early return before the field is
// ever set) -> `note.live_dispatches` is `undefined`, and the deepEqual([])
// assertion below goes red. This test is also the CONTROL that an
// always-null "can't tell" implementation (PIN 7's sabotage target) would
// itself fail here, since it would report null in this confirmed-empty case
// too.
// --------------------------------------------------------------------------
test('rotation-note.mjs: no dispatch register at all -> note.live_dispatches is a confirmed empty array, not unknown', () => {
  const { dir, cleanup } = gitProject();
  try {
    const r = runRotationNote(dir, ['--next-slice', 'next thing']);
    assert.equal(r.status, 0, r.stderr);
    const note = readRotationNote(dir);
    assert.deepEqual(note.live_dispatches, [], 'nothing was ever dispatched -- confirmed empty, not unknown');
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// PIN 2: zero live dispatches -> H1 prints the ordinary ROTATION RESTORE
// block with NO live-dispatch line at all (not even a "0 dispatch(es)..."
// line) -- no ceremony (P1).
// SABOTAGE: make H1 always print the live-dispatch line, e.g. hardcode
// `${note.live_dispatches.length} dispatch(es) were live at rotation --
// check ListAgents before re-dispatching` unconditionally (no `.length > 0`
// guard) -> the doesNotMatch assertions below go red.
// --------------------------------------------------------------------------
test('H1 rotation restore: zero live dispatches -> no live-dispatch line at all, ROTATION RESTORE otherwise intact', () => {
  const { dir, cleanup } = gitProject();
  try {
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const r = h1(dir, { source: 'clear' });
    assert.equal(r.code, 0, r.stderr);
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.doesNotMatch(ctx, /dispatch\(es\) were live at rotation/i, 'no line at all when nothing was live');
    assert.doesNotMatch(ctx, /ListAgents/i, 'the ListAgents remedy is not printed when there is nothing to check');
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// PIN 3 (positive control establishing the read pipeline works): a single
// live register entry is captured into the note as {agent_type, agent_id,
// territory}.
// SABOTAGE: rename the mapped key from `territory` to `files` (i.e. carry
// the register's own field name through unchanged instead of the note's
// `territory` key) -> the deepEqual below goes red on the key name.
// --------------------------------------------------------------------------
test('rotation-note.mjs: a single live register entry is captured as {agent_type, agent_id, territory}', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [registerEntry('agent-c7', 'coder', ['scripts/foo.mjs', 'scripts/bar.mjs'], 1_000)]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const note = readRotationNote(dir);
    assert.deepEqual(note.live_dispatches, [
      { agent_type: 'coder', agent_id: 'agent-c7', territory: ['scripts/foo.mjs', 'scripts/bar.mjs'] },
    ]);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// PIN 4: H1 restore re-prints exactly one live dispatch, naming the count,
// agent_type, agent_id and territory.
// SABOTAGE: H1 reads the note but never renders the live_dispatches block at
// all (treats the field as unknown metadata) -> every match() below goes
// red.
// --------------------------------------------------------------------------
test('H1 rotation restore: a single live dispatch is re-printed with count, agent_type, agent_id, territory', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [registerEntry('agent-c7', 'coder', ['scripts/foo.mjs', 'scripts/bar.mjs'], 1_000)]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const r = h1(dir, { source: 'clear' });
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.match(ctx, /1 dispatch\(es\) were live at rotation/i, 'names the count');
    assert.match(ctx, /check ListAgents before re-dispatching/i, 'names the remedy verbatim');
    assert.match(ctx, /coder/, 'names the agent_type');
    assert.match(ctx, /agent-c7/, 'names the agent_id');
    assert.match(ctx, /scripts\/foo\.mjs/, 'names the territory');
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// PIN 5: two live dispatches are BOTH captured and BOTH printed, with the
// correct count of 2 (guards against a hardcoded "1" or a `.slice(0,1)`
// truncation).
// SABOTAGE: cap the mapped array at the first entry only
// (`liveEntries.slice(0, 1)`) -> `note.live_dispatches.length === 2` goes
// red, and the second agent's id/territory never appear in H1's output.
// --------------------------------------------------------------------------
test('rotation-note.mjs + H1: two live dispatches are both captured and both printed, count is accurate', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [
      registerEntry('agent-c1', 'coder', ['scripts/one.mjs'], 1_000),
      registerEntry('agent-tw2', 'test-writer', ['scripts/two.mjs'], 2_000),
    ]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const note = readRotationNote(dir);
    assert.equal(note.live_dispatches.length, 2, 'both entries captured, not truncated');
    assert.ok(note.live_dispatches.some((e) => e.agent_id === 'agent-c1' && e.agent_type === 'coder'));
    assert.ok(note.live_dispatches.some((e) => e.agent_id === 'agent-tw2' && e.agent_type === 'test-writer'));

    const r = h1(dir, { source: 'clear' });
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /2 dispatch\(es\) were live at rotation/i, 'accurate count, not hardcoded to 1');
    assert.match(ctx, /agent-c1/);
    assert.match(ctx, /agent-tw2/);
    assert.match(ctx, /scripts\/one\.mjs/);
    assert.match(ctx, /scripts\/two\.mjs/);
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// PIN 6: a stale/orphaned register entry is excluded from the live set when
// a genuinely fresh one is also present (an entry hours old is not still
// "live" -- printing it would be exactly the false-alarm noise P1 forbids).
// PIN 3 above is this test's control: an implementation that always returns
// an empty set (never reads the register at all) would already fail PIN 3,
// so a green PIN 3 plus this test together rule out that confound.
// SABOTAGE: remove the age filter (map every register entry through
// regardless of `at`) -> `note.live_dispatches.length === 1` goes red (it
// would be 2), and the JSON would still contain 'agent-stale'.
// --------------------------------------------------------------------------
test('rotation-note.mjs: a stale register entry (hours old) is excluded when a fresh entry is also present', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeRegister(dir, [
      registerEntry('agent-fresh', 'coder', ['scripts/fresh.mjs'], 10_000), // 10s ago
      registerEntry('agent-stale', 'coder', ['scripts/stale.mjs'], 5 * 60 * 60 * 1000), // 5h ago
    ]);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const note = readRotationNote(dir);
    assert.equal(note.live_dispatches.length, 1, 'only the fresh entry is live');
    assert.equal(note.live_dispatches[0].agent_id, 'agent-fresh');
    assert.ok(!JSON.stringify(note.live_dispatches).includes('agent-stale'), 'the stale entry never appears anywhere in the captured set');
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// PIN 7: a register file that EXISTS but cannot be parsed (malformed JSON)
// must never be silently treated as confirmed-empty. PIN 1 is this test's
// control: an always-null "can't tell" implementation would fail PIN 1,
// which expects `[]` for the genuinely-nothing-dispatched case; only this
// test's present-but-corrupt case should yield `null`.
// SABOTAGE: reuse the existing shared liveDispatches() degrade-to-[] path
// unchanged for a JSON parse failure (i.e. treat corrupt exactly like
// missing) -> `assert.equal(note.live_dispatches, null)` goes red (it would
// be `[]`).
// --------------------------------------------------------------------------
test('rotation-note.mjs: a register file that exists but is not valid JSON yields an UNKNOWN marker, never a silent empty array', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeCorruptRegister(dir);
    const r = runRotationNote(dir, ['--next-slice', 'next thing']);
    assert.equal(r.status, 0, r.stderr);
    const note = readRotationNote(dir);
    assert.equal(note.live_dispatches, null, 'unreadable register is disclosed as unknown, not confirmed-empty');
  } finally {
    cleanup();
  }
});

// --------------------------------------------------------------------------
// PIN 8: H1 restore for the unknown case discloses the uncertainty
// distinctly from the ordinary counted line -- it must never fabricate a
// count (e.g. "0 dispatch(es)...") for a set it could not verify, but it
// still points the operator at the remedy (ListAgents).
// SABOTAGE: H1 treats `live_dispatches === null` identically to an empty
// array (prints nothing) -> the /unknown/i match below goes red (no
// disclosure at all is produced).
// --------------------------------------------------------------------------
test('H1 rotation restore: an UNKNOWN live-dispatch set is disclosed distinctly, never fabricated as a count', () => {
  const { dir, cleanup } = gitProject();
  try {
    writeCorruptRegister(dir);
    assert.equal(runRotationNote(dir, ['--next-slice', 'next thing']).status, 0);
    const r = h1(dir, { source: 'clear' });
    const ctx = r.out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /ROTATION RESTORE/);
    assert.doesNotMatch(ctx, /\d+ dispatch\(es\) were live at rotation/i, 'never a fabricated count for an unverifiable set');
    assert.match(ctx, /unknown/i, 'the uncertainty itself is disclosed');
    assert.match(ctx, /ListAgents/i, 'still points at the same remedy');
  } finally {
    cleanup();
  }
});
