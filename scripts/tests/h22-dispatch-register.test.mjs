// H22 IN-FLIGHT DISPATCH REGISTER + H10 FAN-OUT-AWARE DUTY DEFERRAL
// (decision ec9eacaa-674a-4dca-b782-cb1141237279)
//
// Spec under test (given by the launching agent, not inferred from any
// implementation — hooks/h22-dispatch-register.mjs / scripts/hooks/h22-dispatch-register.mjs
// DOES NOT EXIST YET; every h22-hook test below is expected to fail red against
// a missing script. The H10/H1 deferral assertions are expected to fail red
// against TODAY's h10-direct-capture.mjs / h1-session-start.mjs, which do not
// yet know about the register):
//
// A) ONE new hook file, registered on BOTH SubagentStart and SubagentStop,
//    switching on stdin.hook_event_name.
//      SubagentStart: appends {agent_id, agent_type, session_id, files, at} to
//      .sterling/transient/dispatch-register.json (a JSON array). `files` is
//      recovered from the PARENT transcript at transcript_path: find the LAST
//      assistant message carrying one or more Task/Agent tool_use blocks, and
//      extract path-like tokens from the union of those blocks' input.prompt
//      strings.
//      SubagentStop: removes the entry whose agent_id matches; no match is a
//      clean no-op.
//      EVERY fire (start or stop) prunes entries whose session_id differs from
//      stdin's session_id.
//      Non-Sterling cwd (no .sterling/): exit 0, writes nothing.
//      NEVER exits 2. A corrupt register on disk degrades to empty (proceeds,
//      leaves a valid register behind).
//
// B) H10 (hooks/h10-direct-capture.mjs) gains fan-out-aware deferral: a
//    register entry is LIVE iff its session_id matches AND its age (now - at)
//    is under config.dispatch_register.stale_minutes (default 60). Touched
//    files owned by a LIVE entry are excluded from BOTH the capture-duty
//    trigger set and the article-demand unowned set. When something was
//    deferred, H10's output discloses the deferred count + owning agent_id(s)
//    and does NOT clear touches.json/session-events.json (non-terminal
//    release) — so removing the entry re-arms the duty on the next Stop. A
//    STALE entry never defers, and its staleness is disclosed loudly. A
//    partially-owned trigger set still fires for the non-deferred remainder.
//
// C) H1 (hooks/h1-session-start.mjs) additionally deletes
//    .sterling/transient/dispatch-register.json at session start (every
//    dispatch is dead once its owning process is gone — unlike H10's other
//    three registers, this is not gated to source startup|clear only, per the
//    given justification "every entry is dead at session start": a register
//    entry can never legitimately survive to any later SessionStart, resume
//    included, because a resumed session's spawned children do not survive
//    the process boundary either).
//
// Harness follows scripts/tests/h10-delegation-watch.test.mjs and
// scripts/tests/h1-session-residue.test.mjs (temp project + store fixtures,
// runHook/hookInput/envelope/makeProject), reused without modifying either
// file.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z'; // fixed historical instant used ONLY for
// comparisons between fixture timestamps (touch-vs-capture ordering) — never
// compared against the real wall clock.

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

// Combined output text — the brief pins WHAT must be disclosed (deferred
// count, owning agent_id, staleness) but not which stream carries it; checking
// the union avoids anchoring the oracle to an unstated delivery channel.
function out(r) {
  return `${r.stdout}\n${r.stderr}`;
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

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function writeConfig(dir, overrides) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG, ...overrides }));
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

// --------------------------- h22-specific fixtures ---------------------------

function h22Input(dir, over = {}) {
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

function writeParentTranscript(dir, lines, name = 'parent.jsonl') {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const textLine = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const taskLine = (blocks) => ({ type: 'assistant', message: { content: blocks } });
const taskBlock = (name, prompt) => ({ type: 'tool_use', name, input: { prompt } });

// ===========================================================================
// (1) SubagentStart extraction: LAST Task/Agent-bearing assistant message only,
//     union of that message's blocks' input.prompt path-like tokens.
// ===========================================================================

test('H22 SubagentStart: appends a correct entry, extracting repo-relative files from the LAST Task/Agent-bearing assistant message only (an earlier decoy dispatch is ignored)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeParentTranscript(dir, [
      textLine('conductor opens the turn'),
      taskLine([taskBlock('Task', 'stub dispatch touching src/decoy.mjs only')]),
      textLine('conductor narrates between dispatches'),
      taskLine([
        taskBlock('Task', 'Please modify scripts/hooks/h22-dispatch-register.mjs and scripts/tests/h22-dispatch-register.test.mjs'),
        taskBlock('Agent', 'Also check packages/schemas/src/config.ts for the config shape.'),
      ]),
    ]);

    const r = runHook('h22-dispatch-register.mjs', h22Input(dir, { agent_id: 'agent-1', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(registerExists(dir), 'dispatch-register.json created');

    const reg = readRegister(dir);
    assert.equal(reg.length, 1);
    const entry = reg[0];
    assert.equal(entry.agent_id, 'agent-1');
    assert.equal(entry.agent_type, 'coder');
    assert.equal(entry.session_id, 's1');
    assert.ok(entry.at && !Number.isNaN(Date.parse(entry.at)), 'at is a parseable timestamp');
    assert.deepEqual(
      [...entry.files].sort(),
      ['packages/schemas/src/config.ts', 'scripts/hooks/h22-dispatch-register.mjs', 'scripts/tests/h22-dispatch-register.test.mjs'],
      'files is the union of the LAST dispatch-bearing message only'
    );
    assert.ok(!entry.files.includes('src/decoy.mjs'), 'the earlier decoy dispatch never contributes files');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (2) Two parallel starts, same session -> two entries; a matching Stop
//     removes exactly one.
// ===========================================================================

test('H22: two SubagentStart calls (same session) produce two distinct entries; SubagentStop removes exactly the matching one', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'work on src/one.mjs')])], 'p1.jsonl');
    writeParentTranscript(dir, [taskLine([taskBlock('Agent', 'work on src/two.mjs')])], 'p2.jsonl');

    const start1 = runHook(
      'h22-dispatch-register.mjs',
      h22Input(dir, { agent_id: 'a1', agent_type: 'coder', transcript_path: join(dir, 't', 'p1.jsonl') }),
      dir
    );
    assert.equal(start1.code, 0, start1.stderr);
    const start2 = runHook(
      'h22-dispatch-register.mjs',
      h22Input(dir, { agent_id: 'b1', agent_type: 'reviewer', transcript_path: join(dir, 't', 'p2.jsonl') }),
      dir
    );
    assert.equal(start2.code, 0, start2.stderr);

    let reg = readRegister(dir);
    assert.equal(reg.length, 2, 'two parallel dispatches produce two entries');
    const a = reg.find((e) => e.agent_id === 'a1');
    const b = reg.find((e) => e.agent_id === 'b1');
    assert.ok(a && a.agent_type === 'coder');
    assert.ok(b && b.agent_type === 'reviewer');

    const stop = runHook('h22-dispatch-register.mjs', h22Input(dir, { agent_id: 'a1', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(stop.code, 0, stop.stderr);
    reg = readRegister(dir);
    assert.equal(reg.length, 1, 'exactly the matching entry was removed');
    assert.equal(reg[0].agent_id, 'b1', 'the non-matching entry survives untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (3) SubagentStop with an unmatched agent_id is a clean no-op.
// ===========================================================================

test('H22 SubagentStop: an unmatched agent_id is a clean no-op — exit 0, register unchanged', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [{ agent_id: 'x1', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], at: new Date().toISOString() }]);
    const r = runHook('h22-dispatch-register.mjs', h22Input(dir, { agent_id: 'nonexistent-agent', hook_event_name: 'SubagentStop' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(dir);
    assert.equal(reg.length, 1, 'register unchanged');
    assert.equal(reg[0].agent_id, 'x1');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (4) Foreign-session entries are pruned on EVERY fire, start or stop.
// ===========================================================================

test('H22: entries from a foreign session_id are pruned on every fire (start and stop alike)', () => {
  // (a) a Start for session s1 prunes a foreign (s2) entry while appending its own
  const started = makeProject();
  try {
    writeRegisterRaw(started.dir, [
      { agent_id: 'own1', agent_type: 'coder', session_id: 's1', files: ['src/own.mjs'], at: new Date().toISOString() },
      { agent_id: 'foreign1', agent_type: 'coder', session_id: 's2', files: ['src/foreign.mjs'], at: new Date().toISOString() },
    ]);
    writeParentTranscript(started.dir, [textLine('no dispatch blocks in this transcript')]);
    const r = runHook('h22-dispatch-register.mjs', h22Input(started.dir, { agent_id: 'new1', agent_type: 'coder', session_id: 's1' }), started.dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(started.dir);
    assert.equal(reg.length, 2, 'own1 preserved + new1 appended; foreign1 pruned');
    assert.ok(!reg.some((e) => e.session_id === 's2'), 'no s2 entry survives');
    assert.ok(reg.some((e) => e.agent_id === 'own1'));
    const fresh = reg.find((e) => e.agent_id === 'new1');
    assert.ok(fresh, 'the new entry was appended');
    assert.deepEqual(fresh.files, [], 'no dispatch-bearing message in this transcript — files is an empty array, not a crash');
  } finally {
    started.cleanup();
  }

  // (b) a Stop for session s1 with a non-matching agent_id still prunes the
  // foreign (s2) entry — pruning is independent of whether a match occurred
  const stopped = makeProject();
  try {
    writeRegisterRaw(stopped.dir, [
      { agent_id: 'other-agent', agent_type: 'coder', session_id: 's1', files: ['src/other.mjs'], at: new Date().toISOString() },
      { agent_id: 'foreign1', agent_type: 'coder', session_id: 's2', files: ['src/foreign.mjs'], at: new Date().toISOString() },
    ]);
    const r = runHook(
      'h22-dispatch-register.mjs',
      h22Input(stopped.dir, { agent_id: 'nonexistent', session_id: 's1', hook_event_name: 'SubagentStop' }),
      stopped.dir
    );
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(stopped.dir);
    assert.equal(reg.length, 1, 'foreign1 pruned; other-agent survives (no agent_id match, but same session)');
    assert.equal(reg[0].agent_id, 'other-agent');
  } finally {
    stopped.cleanup();
  }
});

// ===========================================================================
// (5) Non-Sterling cwd: exit 0, nothing written.
// ===========================================================================

test('H22: a non-Sterling cwd (no .sterling/) exits 0 and writes nothing at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-bare-'));
  try {
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'work on src/anything.mjs')])]);
    const r = runHook('h22-dispatch-register.mjs', h22Input(dir), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(join(dir, '.sterling')), false, 'no .sterling/ is ever created outside a Sterling project');
    assert.equal(registerExists(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// (6) Corrupt register JSON degrades to empty; hook never exits 2 and leaves
//     a valid register behind.
// ===========================================================================

test('H22: a corrupt dispatch-register.json degrades to empty — the hook never exits 2 and leaves a valid, parseable register behind', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, '{ this is not valid json at all');
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'fix up src/z.mjs please')])]);
    const r = runHook('h22-dispatch-register.mjs', h22Input(dir, { agent_id: 'c1', agent_type: 'coder' }), dir);
    assert.notEqual(r.code, 2, 'the hook never denies a spawn, even recovering from corruption');
    assert.equal(r.code, 0, r.stderr);

    const raw = readFileSync(registerPath(dir), 'utf8');
    let reg;
    assert.doesNotThrow(() => {
      reg = JSON.parse(raw);
    }, 'the register left behind must itself be valid JSON');
    assert.ok(Array.isArray(reg), 'the recovered register is an array');
    const entry = reg.find((e) => e.agent_id === 'c1');
    assert.ok(entry, 'the hook proceeded past the corruption and appended its own entry');
    assert.ok(entry.files.includes('src/z.mjs'), 'extraction still worked normally after recovering from corruption');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// H10 fan-out-aware duty deferral
// ===========================================================================

function touchRegister(dir, paths, at = NOW) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function readTouches(dir) {
  const p = join(dir, '.sterling', 'transient', 'touches.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function captureDecision(store, at = '2026-06-10T13:00:00.000Z') {
  store.create({ ...envelope('decision', at), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
}

function agoISO(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function liveEntry(agentId, files, sessionId = 's1') {
  return { agent_id: agentId, agent_type: 'coder', session_id: sessionId, files, at: agoISO(0) };
}

function captureOwedItems(store) {
  return store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'capture_owed');
}
function articleMissingItems(store) {
  return store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'article_missing');
}

// --------------------------- (7) full deferral, capture duty ---------------------------

test('H10 deferral: a single touched file wholly owned by a LIVE entry — nothing captured, still exit 0, no capture nag; disclosure names the agent; touches.json PRESERVED', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    // CONDUCTOR HARNESS REPAIR 2026-08-20 (frozen-test defect, adjudicated with evidence):
    // liveEntry() stamps `at` at call time, so regenerating it inside the final
    // deepEqual compared against a timestamp ~spawn-duration NEWER than the fixture —
    // unsatisfiable by any implementation. The oracle's intent (H10 never mutates the
    // register) is preserved by pinning the fixture entry once.
    const sub1Entry = liveEntry('sub-1', ['src/x.mjs']);
    writeRegisterRaw(dir, [sub1Entry]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(r.code, 0, 'the sole trigger file is fully deferred — nothing left to nag about');
    assert.doesNotMatch(r.stderr, /nothing was captured/, 'the capture duty itself never fires for a deferred file');
    assert.match(out(r), /defer/i, 'the release discloses the deferral');
    assert.match(out(r), /sub-1/, 'the disclosure names the owning agent_id');
    assert.match(out(r), /\b1\b/, 'the disclosure names the deferred count');

    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), true, 'a non-terminal release never clears touches.json');
    assert.deepEqual(readTouches(dir), [{ path: 'src/x.mjs', at: NOW }], 'touches.json content is untouched by the deferred release');
    assert.deepEqual(readRegister(dir), [sub1Entry], 'H10 never mutates the dispatch register itself — that is H22 territory');
  } finally {
    cleanup();
  }
});

// --------------------------- (8) re-arm after the entry is removed ---------------------------

test('H10 deferral: once the live entry is gone (register empty — dispatch completed), the SAME touched file re-arms the capture nag exactly as if no deferral had ever existed', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, []); // the entry that used to own src/x.mjs is gone
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(r.code, 2, 'no live owner remains — the capture duty fires normally');
    assert.match(r.stderr, /nothing was captured/);
    assert.doesNotMatch(out(r), /defer/i, 'nothing is being deferred this time — no stale deferral language leaks in');
  } finally {
    cleanup();
  }
});

// --------------------------- (9) partial deferral never suppresses the remainder ---------------------------

test('H10 deferral: touches = [A, B], a live entry owns only A — B alone still triggers the capture nag (deferral never suppresses a duty another file legitimately owes)', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/a.mjs', 'src/b.mjs']);
    writeRegisterRaw(dir, [liveEntry('sub-2', ['src/a.mjs'])]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(r.code, 2, 'B is not deferred and nothing was captured — the duty still fires');
    assert.match(r.stderr, /nothing was captured/);
    assert.match(out(r), /sub-2/, 'the partial deferral of A is still disclosed alongside the B nag');
  } finally {
    cleanup();
  }
});

// --------------------------- (10) stale entries never defer ---------------------------

test('H10 deferral: a STALE entry (age >= configured stale_minutes) never defers — the nag fires despite it, and the staleness is disclosed loudly', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConfig(dir, { dispatch_register: { stale_minutes: 5 } });
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [{ agent_id: 'sub-stale', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], at: agoISO(10) }]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(r.code, 2, 'a stale entry never defers — the capture duty fires normally');
    assert.match(r.stderr, /nothing was captured/);
    assert.match(out(r), /stale/i, 'the staleness is disclosed, not silently ignored');
    assert.match(out(r), /sub-stale/, 'the disclosure names which entry was stale');
  } finally {
    cleanup();
  }
});

// --------------------------- (11) no register file: today's behavior is unaffected ---------------------------

test('H10 deferral: with no dispatch-register.json at all, behavior is byte-identical to today — nag once, then release and clear', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/legacy.mjs']);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2);
    assert.match(nag.stderr, /nothing was captured/);

    const release = stop();
    assert.equal(release.code, 0, 'second stop releases the session as today');
    assert.equal(captureOwedItems(store).length, 1);
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), false, 'register cleared on the terminal release, as today');
  } finally {
    cleanup();
  }
});

// --------------------------- (12a) article demand: full deferral ---------------------------

test('H10 deferral (article demand): all 3 unowned touched files are owned by one live entry — capture already satisfied, no article demand fires, registers preserved', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/p.mjs', 'src/q.mjs', 'src/r.mjs']);
    captureDecision(store);
    // Same conductor harness repair as case 7 — fixture pinned once (see comment there).
    const sub3Entry = liveEntry('sub-3', ['src/p.mjs', 'src/q.mjs', 'src/r.mjs']);
    writeRegisterRaw(dir, [sub3Entry]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(r.code, 0, 'capture already satisfied and the 3 unowned files are wholly deferred — nothing demands');
    assert.doesNotMatch(out(r), /article demand/i);
    assert.match(out(r), /defer/i);
    assert.match(out(r), /sub-3/);
    assert.match(out(r), /\b3\b/, 'the disclosure names the deferred count (3)');
    assert.equal(articleMissingItems(store).length, 0, 'no article_missing minted while the territory is deferred');
    assert.equal(existsSync(join(dir, '.sterling', 'transient', 'touches.json')), true, 'non-terminal release — touches.json preserved');
    assert.deepEqual(readRegister(dir), [sub3Entry], 'H10 leaves the dispatch register untouched');
  } finally {
    cleanup();
  }
});

// --------------------------- (12b) article demand: re-arm after removal ---------------------------

test('H10 deferral (article demand): once the live entry is gone, the same 3 unowned files re-arm the article demand exactly as today', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/p.mjs', 'src/q.mjs', 'src/r.mjs']);
    captureDecision(store);
    writeRegisterRaw(dir, []); // the entry that used to own these files is gone
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'no live owner remains — the article demand fires normally');
    assert.match(nag.stderr, /article demand/i);
    assert.match(nag.stderr, /no owner \(feature_article or repo-located reference doc\)/);

    const release = stop();
    assert.equal(release.code, 0, 'second stop releases');
    const missing = articleMissingItems(store);
    assert.equal(missing.length, 1);
    assert.deepEqual([...missing[0].file_keys].sort(), ['src/p.mjs', 'src/q.mjs', 'src/r.mjs']);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// H1 session-start residue: dispatch-register.json is always dead weight
// ===========================================================================

function h1(dir, source, envOverride = {}) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
    ...envOverride,
  });
  return r;
}

test('H1 (source=startup): .sterling/transient/dispatch-register.json is deleted — every entry is dead at session start', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [{ agent_id: 'stale-1', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], at: NOW }]);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(registerExists(dir), false, 'the dispatch register is deleted at every session start, unconditionally');
  } finally {
    cleanup();
  }
});

test('H1 (source=resume): the dispatch register is STILL deleted — unlike the other three transient registers, a dispatch entry cannot legitimately survive to any SessionStart, resume included, because its child process cannot survive the boundary either', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [{ agent_id: 'stale-2', agent_type: 'coder', session_id: 's1', files: ['src/y.mjs'], at: NOW }]);
    const r = h1(dir, 'resume');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(registerExists(dir), false, 'unconditional deletion — not gated to startup|clear like the other three registers');
  } finally {
    cleanup();
  }
});

test('H1 (source=startup): no dispatch-register.json present is a silent no-op, no crash', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(registerExists(dir), false);
    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(registerExists(dir), false);
  } finally {
    cleanup();
  }
});
