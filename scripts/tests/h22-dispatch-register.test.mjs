// H22 IN-FLIGHT DISPATCH REGISTER + H10 FAN-OUT-AWARE DUTY DEFERRAL
// (decision foreign_ec9eacaa)
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
//
// ===========================================================================
// R1 PIN RE-CUT (contract sheet §1.1/§2.1, §6 A1/A2/A4/A6). Sections (A) and
// (B) of the spec above are superseded where they conflict with this ledger:
//   RETIRED: 'H22: two SubagentStart calls (same session) produce two distinct entries;
//            SubagentStop removes exactly the matching one'
//     — A1: Stop MARKS `ended {at, event}`; the entry is NOT deleted, because
//       inactive-confirmed is only a real classifier output if its evidence
//       survives on disk. Re-cut as R1-A90 (same two-Start setup, new verdict).
//   RETIRED: 'H22: entries from a foreign session_id are pruned on every fire
//            (start and stop alike)'
//     — A2: concurrent live sessions in one worktree are OUT OF CONTRACT and H22
//       no longer prunes on write; foreign entries die at the next SessionStart
//       wipe and classify unknown/other-session until then. Re-cut as R1-A91.
//   CONVERTED: 'H10 deferral: a STALE entry never defers ... staleness disclosed
//     loudly' — the VERDICT is unchanged (an out-of-lease entry never defers), the
//     DISCLOSURE becomes [dispatch_status_unknown] per §4. Kept here as R1-A92; the
//     full H10 status policy lives in scripts/tests/h10-dispatch-status-policy.test.mjs.
//   RE-CUT: corrupt register is preserved and disclosed, never reset (A24)
//     — the old 'degrades to empty' pin required Start to overwrite the corrupt
//       bytes with a fresh array, destroying both the availability signal
//       R1-A49/A85/A86/A66 read and any unended round the file held. R1-A99.
//   ADDED: R1-A93/A94 — registerStart's duplicate rule is UNENDED-scoped (A4,
//     measured 2026-09-07: a resumed agent fires SubagentStart again with the
//     SAME agent_id, so a blanket duplicate refusal would silently cost that
//     round its receipt).
// ===========================================================================

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
// STATE-MACHINE RE-CUT (board 5445066b, decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution`,
// knowledge_get 7c515e52 — opened, not paraphrased). SubagentStart no longer
// reads the PARENT TRANSCRIPT: it resolves ONE prompt from the per-dispatch
// state record (PreToolUse slot -> PostToolUse binding -> locked Start
// resolution). So a dispatch is declared by firing its real PreToolUse event,
// and every re-cut Start below points transcript_path at a file that does NOT
// exist — the correct fixture, and a pin that no transcript is read.
// ===========================================================================

let toolUseSeq = 0;
// `omitType: true` stages a record whose tool_input has NO subagent_type KEY
// AT ALL. It exists because `subagent_type = 'coder'` is a destructuring
// DEFAULT and JS applies a default to an explicitly-passed `undefined` — so
// `stagePre(dir, { subagent_type: undefined })` staged a 'coder' record and
// silently tested the opposite of what its caller claimed (caught by the
// coordinator 2026-09-08 against the landed hook: the typed Start derived it
// and wrote attribution 'block'). An absent KEY and a present-but-undefined
// VALUE are different facts about the platform's stdin, and only the explicit
// flag can express the first one.
function stagePre(dir, { prompt, subagent_type = 'coder', omitType = false, tool_use_id, session_id = 's1', tool_name = 'Task' } = {}) {
  const id = tool_use_id ?? `toolu_dr_${(toolUseSeq += 1)}`;
  const tool_input = omitType ? { prompt, description: 'a lane' } : { subagent_type, prompt, description: 'a lane' };
  if (omitType) {
    assert.ok(!('subagent_type' in tool_input), 'harness: omitType must leave the KEY absent, not set it to undefined');
  }
  const r = runHook(
    'h22-dispatch-register.mjs',
    {
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_use_id: id,
      tool_input,
      session_id,
      cwd: dir,
      transcript_path: join(dir, 't', 'parent.jsonl'),
      prompt_id: 'pr-1',
    },
    dir
  );
  assert.notEqual(r.code, 2, `PreToolUse must never deny a dispatch: ${r.stderr}`);
  return id;
}
function noTranscript(dir) {
  return join(dir, 't', 'no-such-parent-transcript.jsonl');
}
const startInput = (dir, over = {}) => h22Input(dir, { transcript_path: noTranscript(dir), ...over });

// ===========================================================================
// (1) RE-CUT — SubagentStart extraction comes from THIS spawn's OWN resolved
//     prompt; a co-pending dispatch of another type never contributes.
//     The two substantive assertions are preserved verbatim (the three-path
//     set, and src/decoy.mjs never appearing); what changed is that the decoy
//     is now a SEPARATE PENDING DISPATCH rather than an earlier message, which
//     is the shape that actually exists under the state machine.
// ===========================================================================

test('H22 SubagentStart: appends a correct entry, extracting repo-relative files from THIS spawn\'s own resolved dispatch prompt (a co-pending decoy dispatch of another type is ignored)', () => {
  const { dir, cleanup } = makeProject();
  try {
    stagePre(dir, { subagent_type: 'explorer', prompt: 'stub dispatch touching src/decoy.mjs only' });
    stagePre(dir, {
      subagent_type: 'coder',
      prompt: 'Please modify scripts/hooks/h22-dispatch-register.mjs and scripts/tests/h22-dispatch-register.test.mjs. Also check packages/schemas/src/config.ts for the config shape.',
    });

    const r = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'agent-1', agent_type: 'coder' }), dir);
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
      'files is the path set of THIS dispatch\'s own prompt'
    );
    assert.ok(!entry.files.includes('src/decoy.mjs'), 'the co-pending decoy dispatch never contributes files');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the subagent_type filter from derivation — two candidates
// exist, the Start goes unattributable, and the three-path deepEqual goes red.
// SABOTAGE: union every pending record's prompt (the retired behaviour) —
// src/decoy.mjs appears and the !includes goes red.

// ===========================================================================
// (2) Two parallel starts, same session -> two entries; a matching Stop
//     removes exactly one.
// ===========================================================================

test('R1-A90: two SubagentStart calls (same session) produce two distinct entries; SubagentStop MARKS exactly the matching one ended and deletes nothing', () => {
  const { dir, cleanup } = makeProject();
  try {
    stagePre(dir, { subagent_type: 'coder', prompt: 'work on src/one.mjs' });
    stagePre(dir, { subagent_type: 'reviewer', prompt: 'work on src/two.mjs', tool_name: 'Agent' });

    const start1 = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'a1', agent_type: 'coder' }), dir);
    assert.equal(start1.code, 0, start1.stderr);
    const start2 = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'b1', agent_type: 'reviewer' }), dir);
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
    assert.equal(reg.length, 2, 'A1: Stop MARKS the entry ended — it never deletes it');
    const stopped = reg.find((e) => e.agent_id === 'a1');
    const other = reg.find((e) => e.agent_id === 'b1');
    assert.equal(stopped.ended.event, 'subagent-stop', 'exactly the matching entry gains the terminal marker');
    assert.ok(!Number.isNaN(Date.parse(stopped.ended.at)), 'ended.at is a parseable instant');
    assert.equal(other.ended, undefined, 'the non-matching entry survives untouched and unmarked');
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
// (4) RE-CUT (A2): H22 no longer prunes foreign-session entries on write.
// Pruning on write destroys evidence a classifier could have disclosed, and
// H1's SessionStart wipe already removes the whole file — so the entry is left
// alone and classified unknown/other-session by every consumer.
// SABOTAGE: restore the prune pass on either fire -> the survival assertions go
// red while every same-session pin in this file stays green.
// ===========================================================================

test('R1-A91: a foreign-session entry SURVIVES both a Start and a Stop — H22 never prunes on write (A2); the wipe is H1\'s job', () => {
  // (a) a Start for session s1 appends its own entry and leaves the foreign (s2) one alone
  const started = makeProject();
  try {
    writeRegisterRaw(started.dir, [
      { agent_id: 'own1', agent_type: 'coder', session_id: 's1', files: ['src/own.mjs'], at: new Date().toISOString() },
      { agent_id: 'foreign1', agent_type: 'coder', session_id: 's2', files: ['src/foreign.mjs'], at: new Date().toISOString() },
    ]);
    // No Pre event is staged for this spawn: the §5 'no-slot' shape, which is
    // what "nothing to extract territory from" now means.
    const r = runHook('h22-dispatch-register.mjs', startInput(started.dir, { agent_id: 'new1', agent_type: 'coder', session_id: 's1' }), started.dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(started.dir);
    assert.equal(reg.length, 3, 'own1 + foreign1 preserved, new1 appended');
    assert.ok(reg.some((e) => e.agent_id === 'foreign1'), 'the foreign-session entry is left for the classifier, not destroyed');
    assert.ok(reg.some((e) => e.agent_id === 'own1'));
    const fresh = reg.find((e) => e.agent_id === 'new1');
    assert.ok(fresh, 'the new entry was appended');
    assert.deepEqual(fresh.files, [], 'no dispatch state for this spawn (no-slot) — files is an empty array, not a crash');
  } finally {
    started.cleanup();
  }

  // (b) a Stop with a non-matching agent_id mutates nothing at all
  const stopped = makeProject();
  try {
    writeRegisterRaw(stopped.dir, [
      { agent_id: 'other-agent', agent_type: 'coder', session_id: 's1', files: ['src/other.mjs'], at: new Date().toISOString() },
      { agent_id: 'foreign1', agent_type: 'coder', session_id: 's2', files: ['src/foreign.mjs'], at: new Date().toISOString() },
    ]);
    const before = readFileSync(registerPath(stopped.dir), 'utf8');
    const r = runHook(
      'h22-dispatch-register.mjs',
      h22Input(stopped.dir, { agent_id: 'nonexistent', session_id: 's1', hook_event_name: 'SubagentStop' }),
      stopped.dir
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(registerPath(stopped.dir), 'utf8'), before, 'an unmatched Stop is byte-identical: no prune, no marker, no rewrite');
  } finally {
    stopped.cleanup();
  }
});

// ===========================================================================
// R1-A93/A94 (A4): the duplicate-agent_id rule is UNENDED-scoped. Measured
// 2026-09-07: resuming an agent fires SubagentStart again with the SAME
// agent_id, so a blanket refusal would leave round n+1 unregistered and cost it
// its receipt; a refusal scoped to unended entries still stops a genuine
// double-registration. The two arms are each other's controls — same agent_id,
// same session, differing ONLY in whether the predecessor is ended.
// ===========================================================================

test('R1-A93: a Start whose agent_id matches an UNENDED same-session entry is refused with [register_agent_id_duplicate] — nothing is appended, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [{ agent_id: 'dup-1', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], at: new Date().toISOString(), attribution: 'block' }]);
    stagePre(dir, { subagent_type: 'coder', prompt: 'work on src/y.mjs' });
    const r = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'dup-1', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, 'a register refusal never denies the spawn');
    assert.match(out(r), /\[register_agent_id_duplicate\]/, `the refusal carries its code — out=${out(r)}`);
    const reg = readRegister(dir);
    assert.equal(reg.length, 1, 'the duplicate is not appended');
    assert.deepEqual(reg[0].files, ['src/x.mjs'], 'and the incumbent entry is not overwritten');
  } finally {
    cleanup();
  }
});

test('R1-A94 CONTROL: the SAME agent_id after an ENDED round is ADMITTED as a new round — a resume is not a duplicate', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [{
      agent_id: 'dup-1', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'],
      at: new Date().toISOString(), attribution: 'block', round: 1,
      ended: { at: new Date().toISOString(), event: 'subagent-stop' },
    }]);
    stagePre(dir, { subagent_type: 'coder', prompt: 'work on src/y.mjs' });
    const r = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'dup-1', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(out(r), /\[register_agent_id_duplicate\]/, 'an ended predecessor is not a duplicate');
    const reg = readRegister(dir);
    assert.equal(reg.length, 2, 'the new round is appended beside the ended one');
    const unended = reg.filter((e) => !e.ended);
    assert.equal(unended.length, 1, 'exactly one live round at a time');
    assert.equal(unended[0].round, 2, 'round n+1, 1-based');
    // RE-CUT, AND THE RULING IS INVERTED HERE — stated plainly rather than
    // quietly dropped. The old assertion was
    // `assert.ok(unended[0].files.includes('src/y.mjs'))`: round n+1 derived
    // its own territory from "the brief" found in the parent transcript.
    // Decision foreign_7c515e52 §5(ii) makes THIS EXACT SHAPE a RESUME — an existing
    // register round for (session_id, agent_id) is resume evidence — and §5
    // rules that a resume "stages nothing", consumes no slot, and appends its
    // round with files:[] files_source:'unattributable' attribution:'none'.
    // The reason is the round-2 FATAL case Codex found: if a resumed agent
    // could claim a fresh same-type pending slot, it would be handed a
    // STRANGER's territory, and H19's delivery guard would make that
    // misattribution permanent. The pending slot below proves it was left for
    // its real owner.
    // SECOND RE-CUT, decision h22-dispatch-files-from-review-territory-and-
    // resume-inherits-prior-round (e841facd): the resumed round still stages
    // nothing and never claims the fresh slot, but it now INHERITS round 1's
    // territory (was files:[] files_source:'unattributable').
    assert.deepEqual(unended[0].files, ['src/x.mjs'], "a RESUMED round inherits its own round 1's territory (§5(ii) still holds) — it must never claim the fresh pending slot's src/y.mjs");
    assert.equal(unended[0].attribution, 'none');
    assert.equal(unended[0].files_source, 'resume-inherited');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (5) Non-Sterling cwd: exit 0, nothing written.
// ===========================================================================

test('H22: a non-Sterling cwd (no .sterling/) exits 0 and writes nothing at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-bare-'));
  try {
    // A Pre event here must not create .sterling/ either — the dispatch-state
    // directory is as project-scoped as the register (7c515e52 §1).
    stagePre(dir, { subagent_type: 'coder', prompt: 'work on src/anything.mjs' });
    const r = runHook('h22-dispatch-register.mjs', startInput(dir, {}), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(join(dir, '.sterling')), false, 'no .sterling/ is ever created outside a Sterling project');
    assert.equal(registerExists(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// RE-CUT: corrupt register is preserved and disclosed, never reset (A24)
//
// The previous pin required Start to overwrite a corrupt register with a fresh
// array containing only its own entry. That DESTROYS the corrupt signal every
// availability pin depends on (R1-A49/A85/A86/A66 all read 'corrupt' from the
// bytes on disk) and, worse, silently discards whatever unended rounds the file
// held — the exact lost-append harm board 673ca3f6 is about, performed
// deliberately. The ruled contract is: read-only on an unreadable register.
// SABOTAGE: restore the degrade-to-empty recovery (write a fresh array on a
// parse failure) -> the byte-identical assertion goes red while the CONTROL
// below stays green, which is what separates "corrupt is preserved" from
// "Start never writes at all".
// ===========================================================================

test('R1-A99: a CORRUPT dispatch-register.json is left byte-identical — the Start writes NOTHING, discloses [register_unavailable] once, exits 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    const corrupt = '{ this is not valid json at all';
    writeRegisterRaw(dir, corrupt);
    stagePre(dir, { subagent_type: 'coder', prompt: 'fix up src/z.mjs please' });
    const r = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'c1', agent_type: 'coder' }), dir);
    assert.notEqual(r.code, 2, 'the hook never denies a spawn, corruption included');
    assert.equal(r.code, 0, r.stderr);

    assert.equal(
      readFileSync(registerPath(dir), 'utf8'),
      corrupt,
      'the corrupt bytes survive — resetting them destroys both the signal every availability pin reads and any unended round the file held'
    );
    const lines = out(r).split('\n').filter((l) => /\[register_unavailable\]/.test(l));
    assert.equal(lines.length, 1, `exactly one unavailability disclosure, found ${lines.length}: ${out(r)}`);
    assert.match(lines[0], /corrupt/, 'the line names WHICH unavailability it is');
  } finally {
    cleanup();
  }
});

test('R1-A99 CONTROL: a VALID register still gets the entry appended, with its territory extracted as normal', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, []);
    stagePre(dir, { subagent_type: 'coder', prompt: 'fix up src/z.mjs please' });
    const r = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'c1', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'c1');
    assert.ok(entry, 'a readable register is appended to as normal');
    assert.ok(entry.files.includes('src/z.mjs'), 'extraction is unaffected');
    assert.doesNotMatch(out(r), /\[register_unavailable\]/, 'and nothing is disclosed when there is nothing wrong');
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

// --------------------------- (10) out-of-lease entries never defer ---------------------------
// CONVERTED (§4): the VERDICT is unchanged — an out-of-lease entry never defers
// a duty — and the DISCLOSURE becomes its code. The full H10 status policy is
// pinned in scripts/tests/h10-dispatch-status-policy.test.mjs.
// SABOTAGE: let an out-of-lease entry defer (drop the status test and exclude on
// mere ownership) -> the exit-2 assertion goes red while case (7)'s
// presumed-active deferral stays green.

test('R1-A92: an OUT-OF-LEASE entry never defers — the nag fires despite it, and the uncertainty is disclosed as [dispatch_status_unknown]', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeConfig(dir, { dispatch_register: { stale_minutes: 5 } });
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [{ agent_id: 'sub-stale', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], at: agoISO(10) }]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    assert.equal(r.code, 2, 'an expired lease never defers — the capture duty fires normally');
    assert.match(r.stderr, /nothing was captured/);
    assert.match(out(r), /\[dispatch_status_unknown\]/, 'the uncertainty is disclosed with its code, not silently ignored');
    assert.match(out(r), /sub-stale/, 'the disclosure names which dispatch is uncertain');
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

// ===========================================================================
// PER-BLOCK ATTRIBUTION — adopted review-finding pins (decision
// h22-per-block-attribution 5d3747c1). These tests are authored BLIND to
// scripts/hooks/h22-dispatch-register.mjs from the spec alone, while a fixer
// implements per-block attribution in parallel. TODAY (pre-fix) h22 writes no
// `attribution` field at all and only ever looks at the LAST dispatch-bearing
// message — every RED assertion below is red against that today-behavior;
// every test is expected to go green once the fix lands.
//
// Real Task/Agent tool_use blocks carry `subagent_type` in `input` alongside
// `prompt` (mirrors scripts/tests/h22-attribution.test.mjs's taskBlock, kept
// local here since the file's own `taskBlock` helper above has no
// subagent_type field and is left untouched).
// ===========================================================================

const taskBlockTyped = (name, subagent_type, prompt) => ({ type: 'tool_use', name, input: { subagent_type, prompt } });

// --------------------------- PIN A (RE-CUT): a type-less Start never derives ---------------------------
// PIN A, re-cut onto 7c515e52 §6: "agent_type missing on Start -> no
// derivation ('no-agent-type'); a post_binding still resolves." The ORIGINAL
// property is preserved exactly — an absent/null/non-string stdin.agent_type
// must NEVER produce a precise attribution by matching a type-less dispatch
// (undefined must not match undefined) — but the fail-closed VALUE is now
// 'none' with files:[], because the union fallback the old pin expected is
// deleted. PIN A-CONTROL below is the opposite-reason arm the original set
// lacked: without it, all four arms would also pass an implementation that
// simply never attributes anything.
//
// WHICH GUARD CARRIES THE VERDICT (stated, not assumed — verified against the
// landed hook by the coder, 2026-09-08): these three arms strip BOTH guards at
// once — the Start has no usable agent_type AND the pending record has no
// subagent_type key — so the verdict is carried by whichever fires first, and
// in the landed implementation that is §5's 'no-agent-type' SHORT-CIRCUIT,
// before derivation is ever attempted. They therefore do NOT isolate the
// type-less-RECORD rule; PIN B below is the arm that does, with a real
// stdin.agent_type. Defense in depth, deliberately: the pair is what makes
// each guard independently sabotage-detectable.
//
// EXPECTED RED today: h22 writes no `attribution` field at all, so
// `entry.attribution` is `undefined` in every arm — fails
// `assert.equal(entry.attribution, 'none', ...)`.

for (const [label, agentType] of [['absent', undefined], ['null', null], ['non-string', 42]]) {
  test(`H22 PIN A (no derivation without a type, agent_type ${label}): a pending dispatch whose subagent_type KEY is absent is never matched — attribution 'none', files []`, () => {
    const { dir, cleanup } = makeProject();
    try {
      stagePre(dir, { omitType: true, prompt: `touch src/pinA-${label}.mjs` });
      const r = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: `agent-pinA-${label}`, agent_type: agentType }), dir);
      assert.equal(r.code, 0, r.stderr);
      const reg = readRegister(dir);
      const entry = reg.find((e) => e.agent_id === `agent-pinA-${label}`);
      assert.ok(entry, 'the round is still appended');
      assert.equal(entry.attribution, 'none', `a ${label} stdin.agent_type must never mint a precise attribution — undefined does not match undefined`);
      assert.deepEqual(entry.files, [], 'and no territory is recovered by any fallback: the union is deleted');
    } finally {
      cleanup();
    }
  });
}
// SABOTAGE: compare types with a loose equality that lets undefined match
// undefined (or treat a missing agent_type as a wildcard) — the attribution
// and files assertions go red in all three arms while PIN A-CONTROL below
// stays green.

test('H22 PIN A-CONTROL (placed after the set it controls, and required by it): a Start with NO agent_type STILL resolves through its authoritative Post binding — the type check is not a way of never attributing', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = 'work on src/pinA-control.mjs';
    const id = stagePre(dir, { subagent_type: 'coder', prompt });
    const post = runHook(
      'h22-dispatch-register.mjs',
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_use_id: id,
        tool_input: { subagent_type: 'coder', prompt, description: 'a lane' },
        tool_response: {
          isAsync: true, status: 'async_launched', agentId: 'agent-pinA-ctrl', description: 'a lane',
          resolvedModel: 'claude-x', prompt, outputFile: join(dir, 'out.txt'), canReadOutputFile: true,
        },
        session_id: 's1',
        cwd: dir,
        transcript_path: join(dir, 't', 'parent.jsonl'),
        prompt_id: 'pr-1',
      },
      dir
    );
    assert.equal(post.code, 0, post.stderr);

    const r = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'agent-pinA-ctrl', agent_type: undefined }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = readRegister(dir).find((e) => e.agent_id === 'agent-pinA-ctrl');
    assert.ok(entry, 'the round is appended');
    assert.deepEqual(entry.files, ['src/pinA-control.mjs'], 'an authoritative binding needs no agent_type at all (§6)');
    assert.equal(entry.attribution, 'block');
    assert.equal(entry.attribution_case, 'post');
  } finally {
    cleanup();
  }
});
// SABOTAGE: return early on a missing agent_type BEFORE the my-binding branch
// (§5(i)) — this control goes red while every PIN A arm above stays green,
// which is the whole reason it exists.

// --------------------------- PIN B (RE-CUT): a type-less DISPATCH is never a candidate ---------------------------
// PIN B, re-cut: the mirror of PIN A, and THE ARM THAT ISOLATES THE RECORD-SIDE
// GUARD. stdin.agent_type is a real string here, so §5's 'no-agent-type'
// short-circuit cannot fire and the verdict can only come from the candidate
// filter refusing a record whose subagent_type key is absent — which is
// exactly the guard PIN A's three arms cannot distinguish.
//
// FIXTURE CORRECTION (coordinator, 2026-09-08): this arm previously passed
// `subagent_type: undefined`, which a destructuring DEFAULT turns back into
// 'coder' — so it staged a TYPED record, the typed Start derived it correctly,
// and the pin was red for a fixture reason while asserting the opposite of
// what it staged. It now uses `omitType: true`, which leaves the KEY absent.
//
// EXPECTED RED today: `entry.attribution` is undefined — fails the
// attribution assertion.

test("H22 PIN B (a pending dispatch without subagent_type is never a candidate): a real stdin.agent_type finds no slot — attribution 'none', files []", () => {
  const { dir, cleanup } = makeProject();
  try {
    stagePre(dir, { omitType: true, prompt: 'touch src/pinB.mjs' });
    const r = runHook('h22-dispatch-register.mjs', startInput(dir, { agent_id: 'agent-pinB', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-pinB');
    assert.ok(entry, 'the round is still appended');
    assert.equal(entry.attribution, 'none', 'a record lacking subagent_type can never be derived onto any agent');
    assert.deepEqual(entry.files, [], 'no union fallback recovers it');
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat a record with no subagent_type as matching every type — the
// two assertions go red while PIN A-CONTROL (a genuine Post binding) stays
// green.

// ===========================================================================
// RETIRED HERE — 'PIN C (prompt-less intermediate message does not truncate
// the backward walk)', by decision foreign_7c515e52.
// PIN C pinned the BOUNDED BACKWARD WALK through earlier dispatching assistant
// messages. There is no walk and no message list: SubagentStart never reads the
// parent transcript (its 3.4-5.5 s lag is the measured defect, finding
// 51506eec), and a dispatch is located by its tool_use_id-keyed record. The
// concern PIN C actually protected — a dispatch record with no usable prompt
// must not silently attribute something else — survives as PIN B above (a
// record missing its type is no candidate) and, for a missing/oversize prompt,
// as scripts/tests/dispatch-state-owner.test.mjs DS-P05/DS-P06.
// ===========================================================================
