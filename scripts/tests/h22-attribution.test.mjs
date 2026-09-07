// H22/H26 PER-BLOCK ATTRIBUTION (Start-side) AND REVIEWER TERRITORY BINDING
// AT SubagentStop (decision edbaa38d).
//
// R1 PIN RE-CUT (contract sheet §2.1 + amendments A1/A4/A6): the attribution
// contracts in this file are KEPT — the rebuild keeps decision edbaa38d's
// Stop-bind and today's positional rules at Start, including the
// unattributable partition. What changed:
//   - A1: SubagentStop MARKS the register entry ended; it does not delete it.
//     RETIRED: `assert.deepEqual(readRegister(dir), [])` in STOP-BIND
//     NON-REVIEWER — replaced by the `ended.event === 'subagent-stop'` pin.
//   - A4 (MEASURED 2026-09-07): resuming a reviewer FIRES SubagentStart again
//     with the same agent_id, so every round has its OWN Start and its OWN
//     receipt, and a Stop with no UNENDED register entry mints nothing.
//     RETIRED: 'PIN B CONTROL (exactly ONE string-content user record binds)',
//     'PIN B (resumed reviewer, no existing receipt)' and 'PIN B (truncated
//     child read)' — all three inferred a resumed round from the COUNT of
//     string-content user records in the child transcript, on the premise that
//     a resumed round produces a Stop with no Start. A4 measured that premise
//     false; under it, that count-based refusal would make every legitimately
//     resumed round's receipt unspendable, defeating the decision's own named
//     remedy for a broken byte binding ("the remedy is a fresh review round").
//     The danger those pins guarded — a Stop re-binding an old brief onto
//     today's bytes with no Start of its own — is now closed by the register
//     rule and pinned in scripts/tests/h22-review-ledger.test.mjs (R1-B10/B11).
//     The CONTINUATION pin below is re-cut onto that rule and keeps
//     edbaa38d item 5 (only the FIRST child record is authoritative) alive.
//   - A6: every advisory carries a [snake_code] token, so the disclosures are
//     pinned by CODE, never by the word 'unattributable' in a sentence. The
//     substantive verdict stays pinned as a FIELD (files_source /
//     territory.source), which is what actually carries these tests.
//     RETIRED: every `assert.match(..., /unattributable/i)` prose match.
//
// (board 8662956c-ea05-4f2c-8577-84396a119f95 — CROSS-ATTRIBUTION fix)
//
// Spec under test (given by the launching agent, NOT inferred from any
// implementation — I have not read scripts/hooks/h22-dispatch-register.mjs,
// scripts/hooks/h26-dispatch-overlap.mjs, or scripts/hooks/lib/dispatch-prompt.mjs):
//
// scripts/hooks/lib/dispatch-prompt.mjs gains lastDispatchBlocks() returning
// per-block {subagent_type, prompt} (lastDispatchPrompts stays byte-identical
// — H19 depends on it). scripts/hooks/h22-dispatch-register.mjs SubagentStart
// attributes files per block:
//   - exactly ONE block in the last dispatching message with
//     block.subagent_type === stdin.agent_type -> that block's extracted path
//     candidates ONLY, entry gains attribution:'block'.
//   - SEVERAL same-type blocks in the last dispatching message -> union of
//     the SAME-TYPE blocks only, attribution:'union'.
//   - ZERO type matches in the last dispatching message -> walk BACKWARD
//     through recent dispatching assistant messages (bounded) for a
//     type-match, else union of the last message's all blocks,
//     attribution:'union'.
//
// scripts/hooks/h26-dispatch-overlap.mjs IGNORES overlaps sourced from
// attribution:'union' entries entirely (precise 'block' entries still warn as
// today), and its explanatory sentence becomes a claim like "compares only
// dispatches already present in the live register when this PreToolUse
// fires" — no longer the false "parallel dispatches fired in one message
// never see each other here".
//
// TODAY (pre-fix), h22-dispatch-register.mjs extracts path-like tokens from
// the UNION of every block in the LAST dispatching message, regardless of
// subagent_type, and writes no `attribution` field at all (confirmed by the
// existing pin in scripts/tests/h22-dispatch-register.test.mjs, whose fixture
// unions a 'Task' block and an 'Agent' block with no type filtering). h26
// warns on any live same-session, non-stale, path-overlapping entry
// regardless of any `attribution` field (which does not exist yet). Every RED
// pin below is red against that today-behavior; every GREEN pin is a
// regression net that already holds today and must keep holding after the
// fix.
//
// Harness mirrors scripts/tests/h22-dispatch-register.test.mjs (transcript
// fixtures, runHook/hookInput-style helpers, register file readers) and
// scripts/tests/h26-dispatch-overlap.test.mjs (bare Sterling marker project,
// taskInput/liveEntry/parseAdditionalContext/assertSilent/assertOverlapWarning),
// reused without modifying either file.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');
const H26_PATH = join(HOOKS, 'h26-dispatch-overlap.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// --------------------------------------------------------------------------
// Shared low-level runner
// --------------------------------------------------------------------------

function runHookAt(scriptPath, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const runH22 = (input, cwd) => runHookAt(H22_PATH, input, cwd);
const runH26 = (input, cwd) => runHookAt(H26_PATH, input, cwd);

// A6: refusals and disclosures are asserted by their [code] token, never by a
// sentence. `ANY_CODE` is used where the sheet's closed CODES set does not yet
// name the code for a Start-side advisory — the contract pinned there is that
// the line is RENDERED through the shared errors module at all.
const token = (c) => new RegExp('\\[' + c + '\\]');
const ANY_CODE = /\[[a-z][a-z0-9_]*\]/;
const outputOf = (r) => `${r.stdout}\n${r.stderr}`;

// --------------------------------------------------------------------------
// H22-side fixtures (mirrors scripts/tests/h22-dispatch-register.test.mjs)
// --------------------------------------------------------------------------

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeH22Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22attr-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

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
// NOTE: real Task/Agent tool_use blocks carry `subagent_type` in `input`
// alongside `prompt` — this is the field lastDispatchBlocks() must surface
// per-block (the settled design's whole point).
const taskBlock = (name, subagent_type, prompt) => ({ type: 'tool_use', name, input: { subagent_type, prompt } });

// --------------------------------------------------------------------------
// H26-side fixtures (mirrors scripts/tests/h26-dispatch-overlap.test.mjs)
// --------------------------------------------------------------------------

function makeH26Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22attr-h26-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function taskInput(dir, { subagent_type = 'coder', prompt, session_id = 's1', tool_name = 'Task', tool_input } = {}) {
  const base = { hook_event_name: 'PreToolUse', tool_name, session_id, cwd: dir };
  if (tool_input !== undefined) return { ...base, tool_input };
  return { ...base, tool_input: { subagent_type, prompt } };
}

function parseAdditionalContext(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout was not valid JSON: ${JSON.stringify(r.stdout)}`);
  }
  return parsed?.hookSpecificOutput?.additionalContext ?? '';
}

function tokenRe(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc.replace(/\//g, '\\/'), 'i');
}

function assertSilent(r) {
  assert.equal(r.code, 0, `expected exit 0 (silent case), got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.equal(ctx, '', `expected no overlap advisory; got: ${JSON.stringify(ctx)}`);
}

function assertOverlapWarning(r, { paths, entries }) {
  assert.equal(r.code, 0, `expected exit 0 (advisory only, never a denial), got ${r.code}; stderr: ${r.stderr}`);
  const ctx = parseAdditionalContext(r);
  assert.ok(ctx.length > 0, 'expected a non-empty overlap advisory in additionalContext');
  for (const p of paths) {
    assert.match(ctx, tokenRe(p), `advisory must name the overlapping path '${p}'`);
  }
  for (const [agentType, agentId] of entries) {
    assert.ok(ctx.includes(`${agentType}:${agentId}`), `advisory must name the overlapping dispatch as '${agentType}:${agentId}'; got: ${ctx}`);
  }
}

function agoISO(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function liveEntry(agentId, agentType, files, { sessionId = 's1', minutesAgo = 0, attribution } = {}) {
  const e = { agent_id: agentId, agent_type: agentType, session_id: sessionId, files, at: agoISO(minutesAgo) };
  if (attribution !== undefined) e.attribution = attribution;
  return e;
}

// ===========================================================================
// PIN 1 — mixed-type batch: exactly one block matches stdin.agent_type ->
// that block's files ONLY, attribution 'block'.
// EXPECTED RED today: h22 currently unions ALL blocks in the last dispatching
// message regardless of type, so 'src/fileB.mjs' (the test-writer block's
// file) WOULD be included and `attribution` is undefined. Fails at
// `assert.ok(!entry.files.includes('src/fileB.mjs'))` and at
// `assert.equal(entry.attribution, 'block')`.
// ===========================================================================

test('H22 attribution PIN1: mixed-type batch — one coder block + one test-writer block, SubagentStart agent_type=coder attributes only the coder block\'s files, attribution:block', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([
        taskBlock('Task', 'coder', 'Please modify src/fileA.mjs for the coder half of this batch'),
        taskBlock('Task', 'test-writer', 'Please write tests touching src/fileB.mjs for the test-writer half of this batch'),
      ]),
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-mixed', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-mixed');
    assert.ok(entry, 'entry was appended');
    assert.deepEqual([...entry.files].sort(), ['src/fileA.mjs'], 'files come from the coder block only');
    assert.ok(!entry.files.includes('src/fileB.mjs'), 'the test-writer sibling block never contributes files to a coder attribution');
    assert.equal(entry.attribution, 'block', 'exactly one type-matching block -> precise block attribution');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 2 — same-type twins: two test-writer blocks + one coder block,
// SubagentStart agent_type=test-writer -> union of the two test-writer
// blocks only, attribution 'union'.
// EXPECTED RED today: current union-of-last-message-regardless-of-type
// behavior WOULD include 'src/fileC.mjs' (the coder block's file) too. Fails
// at `assert.ok(!entry.files.includes('src/fileC.mjs'))`.
// ===========================================================================

test('H22 attribution PIN2: same-type twins — two test-writer blocks + one coder block, SubagentStart agent_type=test-writer attributes the UNION of the two test-writer blocks only, attribution:union', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([
        taskBlock('Task', 'test-writer', 'write tests for src/fileA.mjs'),
        taskBlock('Task', 'test-writer', 'also write tests for src/fileB.mjs'),
        taskBlock('Task', 'coder', 'implement src/fileC.mjs'),
      ]),
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-twin', agent_type: 'test-writer' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-twin');
    assert.ok(entry, 'entry was appended');
    assert.deepEqual([...entry.files].sort(), ['src/fileA.mjs', 'src/fileB.mjs'], 'files are the union of the two same-type blocks');
    assert.ok(!entry.files.includes('src/fileC.mjs'), 'the coder sibling block never contributes files to a test-writer attribution');
    assert.equal(entry.attribution, 'union', 'several same-type blocks -> union attribution');
    // board c9f92090 slice 2: the reviewer-class 'unattributable' override
    // (REVIEWER-R1/R2/R3 below) must never leak onto a non-reviewer type —
    // this SAME shape (several same-type siblings) is exactly REVIEWER-R1's
    // unsafe case, but agent_type here is 'test-writer', not 'reviewer-*'.
    // SABOTAGE: key the unattributable override on the SHAPE alone (siblings
    // count / walk-back / terminal union) instead of also requiring
    // agent_type.startsWith('reviewer-') — this assertion goes red
    // (files_source would read 'unattributable' instead of
    // 'free-prose-fallback').
    assert.equal(entry.files_source, 'free-prose-fallback', "a non-reviewer type never gets the reviewer-only 'unattributable' override, even under the identical unsafe (several-siblings) shape");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 3 — cross-batch walk-back: M1 has a coder block (fileA), a later M2 has
// only a test-writer block (fileB). SubagentStart agent_type=coder (M1's
// agent starting late, after M2 was already dispatched) must walk backward
// past M2 (zero type matches there) to M1's coder block: files = fileA only,
// attribution 'block'.
// EXPECTED RED today: h22 currently only ever looks at the LAST dispatching
// message (M2), so it would produce files=['src/fileB.mjs'] (wrong file) and
// no attribution field at all. Fails at the files deepEqual and at the
// attribution equality.
// ===========================================================================

test('H22 attribution PIN3: cross-batch walk-back — a late-starting agent whose type only matches an EARLIER dispatching message is attributed that earlier message\'s block, not the later message\'s', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([taskBlock('Task', 'coder', 'M1: fix up src/fileA.mjs')]), // M1
      textLine('conductor narrates between dispatches'),
      taskLine([taskBlock('Task', 'test-writer', 'M2: write tests for src/fileB.mjs')]), // M2 (last dispatching message)
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-late', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-late');
    assert.ok(entry, 'entry was appended');
    assert.deepEqual([...entry.files].sort(), ['src/fileA.mjs'], 'walk-back finds M1\'s coder block, not M2\'s test-writer block');
    assert.ok(!entry.files.includes('src/fileB.mjs'), 'M2 (the last message, zero type matches) never contributes files here');
    assert.equal(entry.attribution, 'block', 'a single type-matching block found by walk-back is still a precise block attribution');
    // board c9f92090 slice 2: this SAME walk-back shape is exactly
    // REVIEWER-R2's unsafe case (the c91b351d off-by-one) when agent_type is
    // reviewer-class — here agent_type is 'coder', so the reviewer-only
    // override must never fire.
    // SABOTAGE: key the unattributable override on the SHAPE alone (a
    // walk-back match) instead of also requiring
    // agent_type.startsWith('reviewer-') — this assertion goes red
    // (files_source would read 'unattributable' instead of
    // 'free-prose-fallback').
    assert.equal(entry.files_source, 'free-prose-fallback', "a non-reviewer type never gets the reviewer-only 'unattributable' override, even under the identical unsafe (walk-back) shape");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// REVIEWER-CLASS TERRITORY-BY-POSITION (board c9f92090, slice 2, spec item
// (a)) — SPEC ONLY, red-first, authored from the board record (opened via
// board_get), not from scripts/hooks/h22-dispatch-register.mjs's internals
// (H4 read wall honored — that hook was never opened by this file's author).
//
// SPEC UNDER TEST (board c9f92090, verbatim):
//   "attributeBlocks is SAFE only when exactly one same-type Agent block sits
//    in the CURRENT dispatching message. For reviewer-class dispatches
//    (agent_type starts with 'reviewer-') the three unsafe cases — more than
//    one same-type sibling in the message, ANY walk-back match (including a
//    single one, the c91b351d off-by-one), and the terminal union — record
//    territory.source:'unattributable' with a loud stderr line naming the
//    case; the safe single-block case and every NON-reviewer class keep
//    today's behaviour byte-identical (non-reviewer unsafe = 'union')."
// The register-level home of "territory.source" (per the pre-existing
// decision 8f137474/h22-review-territory.test.mjs contract, where every
// register entry already carries files_source: 'review-territory' |
// 'free-prose-fallback', later nested as ledger territory.source at
// SubagentStop promotion) is files_source; the new value this slice adds is
// a third literal, 'unattributable'.
//
// REVIEWER-R0 is the CONTROL, placed FIRST (per this role's own multi-cause
// discipline): without it, a green REVIEWER-R1/R2/R3 is indistinguishable
// from "every reviewer-class dispatch is unconditionally flagged
// unattributable regardless of safety" — a far more aggressive, wrong
// implementation that would ALSO pass R1-R3 for the wrong reason.
//
// SABOTAGE (all four tests below): revert the unsafe-case classification
// back to plain 'union'/'block' — i.e. treat a reviewer-class dispatch
// exactly like a non-reviewer one, dropping the files_source:'unattributable'
// override entirely ("unattributable branch flipped back to union"). Under
// that sabotage, REVIEWER-R1/R2/R3 each go red (files_source stays
// 'free-prose-fallback' instead of 'unattributable', and the stderr
// disclosure never fires); REVIEWER-R0 stays green either way, which is
// exactly why it cannot substitute for the other three.
// ===========================================================================

test('H22 attribution REVIEWER-R0 (CONTROL, placed FIRST): the SAFE case — exactly one reviewer-correctness block in the current message — is UNCHANGED: attribution:block, files_source stays free-prose-fallback, never unattributable', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([taskBlock('Task', 'reviewer-correctness', 'please review src/rSafe.mjs for correctness')]),
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-rev-safe', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-rev-safe');
    assert.ok(entry, 'entry was appended');
    assert.equal(entry.attribution, 'block', 'exactly one type-matching block is still a precise block attribution for a reviewer too');
    assert.equal(entry.files_source, 'free-prose-fallback', 'the SAFE case is untouched by the new unattributable override — this is the control that R1/R2/R3 depend on to mean anything');
  } finally {
    cleanup();
  }
});

test('H22 attribution REVIEWER-R1: UNSAFE case 1 — more than one same-type reviewer sibling in the current message — files_source becomes unattributable, disclosed loudly', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([
        taskBlock('Task', 'reviewer-correctness', 'review src/r1a.mjs'),
        taskBlock('Task', 'reviewer-correctness', 'also review src/r1b.mjs'),
        taskBlock('Task', 'coder', 'implement src/r1c.mjs'),
      ]),
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-rev-sibling', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-rev-sibling');
    assert.ok(entry, 'entry was appended');
    assert.equal(entry.files_source, 'unattributable', 'two same-type reviewer siblings in one message means SubagentStart (which carries no tool_use_id) cannot tell which physical dispatch this Start belongs to');
    assert.match(outputOf(r), ANY_CODE, 'the case is disclosed through the shared errors module, code first (A6) — never a silent downgrade');
  } finally {
    cleanup();
  }
});

test('H22 attribution REVIEWER-R2: UNSAFE case 2 — a SINGLE walk-back match (the c91b351d off-by-one) — files_source becomes unattributable even though only one block matched', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([taskBlock('Task', 'reviewer-correctness', 'M1: review src/r2a.mjs')]), // M1
      textLine('conductor narrates between dispatches'),
      taskLine([taskBlock('Task', 'coder', 'M2: implement src/r2b.mjs')]), // M2 (last dispatching message, zero type matches)
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-rev-walkback', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-rev-walkback');
    assert.ok(entry, 'entry was appended');
    assert.equal(
      entry.files_source,
      'unattributable',
      'a reviewer-class walk-back match is unsafe even at exactly ONE match — for a NON-reviewer type this exact shape is attribution:block (see PIN3 above), but a reviewer dispatch cannot be bound to a specific earlier block by position alone'
    );
    assert.match(outputOf(r), ANY_CODE, 'disclosed through the shared errors module (A6)');
  } finally {
    cleanup();
  }
});

test('H22 attribution REVIEWER-R3: UNSAFE case 3 — terminal union (zero reviewer-correctness matches anywhere in the bounded walk) — files_source becomes unattributable', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [
      taskLine([taskBlock('Task', 'coder', 'M1: touch src/r3a.mjs')]),
      taskLine([
        taskBlock('Task', 'coder', 'M2: touch src/r3b.mjs'),
        taskBlock('Task', 'test-writer', 'M2: touch src/r3c.mjs'),
      ]),
    ]);

    const r = runH22(h22Input(dir, { agent_id: 'agent-rev-terminal', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-rev-terminal');
    assert.ok(entry, 'entry was appended');
    assert.equal(entry.files_source, 'unattributable', 'zero type matches anywhere in the bounded walk falls to the terminal union of the last message\'s blocks, which is unsafe for a reviewer-class dispatch');
    assert.match(outputOf(r), ANY_CODE, 'disclosed through the shared errors module (A6)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 4a — H26 suppression of attribution:'union' entries.
// EXPECTED RED today: h26 has no concept of `attribution` yet and warns on
// any live overlapping entry. Fails inside assertSilent at
// `assert.equal(ctx, '', ...)` — ctx will be non-empty (a warning fired).
// ===========================================================================

test('H26 attribution PIN4a: a live entry with attribution:union whose files include the overlap path is NEVER a source of warning', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-1', 'test-writer', ['src/fileX.mjs'], { attribution: 'union' })]);
    const r = runH26(taskInput(dir, { prompt: 'please modify src/fileX.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 4b — H26 still warns on attribution:'block' entries (regression net).
// EXPECTED GREEN both today and after the fix: today's h26 ignores the
// (nonexistent) `attribution` field entirely and warns on any live
// overlapping entry, which already satisfies this assertion; after the fix,
// 'block' entries are the precise case that must keep warning.
// ===========================================================================

test('H26 attribution PIN4b: a live entry with attribution:block still warns exactly as today', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-2', 'coder', ['src/fileY.mjs'], { attribution: 'block' })]);
    const r = runH26(taskInput(dir, { prompt: 'please modify src/fileY.mjs today' }), dir);
    assertOverlapWarning(r, { paths: ['src/fileY.mjs'], entries: [['coder', 'sub-2']] });
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 5 — H26 explanatory text: when a warning DOES fire, it states the new
// register-presence claim and drops the old false "never see each other"
// framing.
// EXPECTED RED today: the exact new phrase "already present in the live
// register" is not part of today's advisory text (it does not exist prior to
// this fix). Fails at
// `assert.match(ctx, /already present in the live register/i)`.
// ===========================================================================

test('H26 attribution PIN5: a fired warning states the register-presence claim, not the old "never see each other" framing', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegisterRaw(dir, [liveEntry('sub-3', 'coder', ['src/fileZ.mjs'], { attribution: 'block' })]);
    const r = runH26(taskInput(dir, { prompt: 'please modify src/fileZ.mjs today' }), dir);
    const ctx = parseAdditionalContext(r);
    assert.match(ctx, /already present in the live register/i, 'advisory states the new register-presence claim');
    assert.doesNotMatch(ctx, /never see each other/i, 'the old false "never see each other" framing must be gone');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 6a — GREEN regression: register entries keep the base shape
// {agent_id, agent_type, session_id, files, at} as attribution is added.
// EXPECTED GREEN both today and after the fix: these five fields are already
// written by today's h22 (per scripts/tests/h22-dispatch-register.test.mjs)
// and the settled design only ADDS `attribution`, never removes a base
// field.
// ===========================================================================

test('H22 attribution PIN6a: a new entry keeps the base shape {agent_id, agent_type, session_id, files, at}', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    writeParentTranscript(dir, [taskLine([taskBlock('Task', 'coder', 'touch src/fileR.mjs')])]);
    const r = runH22(h22Input(dir, { agent_id: 'agent-r', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-r');
    assert.ok(entry, 'entry was appended');
    for (const key of ['agent_id', 'agent_type', 'session_id', 'files', 'at']) {
      assert.ok(key in entry, `entry retains base field '${key}'`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 6b — GREEN-after-fix regression: a legacy register entry with NO
// attribution field at all is treated as imprecise (union) by H26 — no
// crash, no warning sourced from it.
// EXPECTED RED today: h26 has no attribution concept yet, so it warns on any
// live overlapping entry regardless of a missing field. Fails inside
// assertSilent at `assert.equal(ctx, '', ...)`.
// ===========================================================================

test('H26 attribution PIN6b: a legacy entry with no attribution field at all is treated as imprecise/union — suppressed, no crash, no warning', () => {
  const { dir, cleanup } = makeH26Project();
  try {
    writeRegisterRaw(dir, [{ agent_id: 'legacy-1', agent_type: 'coder', session_id: 's1', files: ['src/fileL.mjs'], at: agoISO(0) }]);
    const r = runH26(taskInput(dir, { prompt: 'please modify src/fileL.mjs today' }), dir);
    assertSilent(r);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// STOP-BIND — REVIEWER RECEIPT TERRITORY BINDS AT SubagentStop FROM THE CHILD
// TRANSCRIPT + .meta.json SIDECAR (slice 4A of objective
// dome-farmer-issues-2026-09-05, board 491bb54b) — SPEC ONLY, red-first,
// authored from the GOVERNING DECISION (opened via knowledge_get, not from
// scripts/hooks/h22-dispatch-register.mjs's internals — H4 read wall honored):
//
// knowledge_get edbaa38d-a632-45c2-88f3-840c01690010 (slug
// reviewer-attribution-binds-at-stop-from-child-transcript-and-meta-sidecar,
// user-decided 2026-09-06). VERBATIM MECHANISM PINNED HERE:
//   At SubagentStop, for REVIEWER-CLASS agents only (agent_type starting
//   'reviewer-'): (1) PRIMARY — the FIRST record of the child transcript at
//   stdin.agent_transcript_path is {parentUuid:null, isSidechain:true,
//   type:'user', message:{role:'user', content:<string>}}, and that content
//   is the delivered brief VERBATIM; territory is parsed from it with the
//   existing parseReviewTerritory (REVIEW-TERRITORY: [...] marker line, per
//   decision 8f137474/scripts/tests/h22-review-territory.test.mjs). (2)
//   CORROBORATION — the sidecar at
//   `<agent_transcript_path with .jsonl replaced>.meta.json` carries
//   {agentType, description, toolUseId, spawnDepth, model}; that toolUseId
//   locates the tool_use block in the PARENT transcript (stdin.transcript_path);
//   binding requires block.input.prompt === child-first-record content
//   BYTE-IDENTICAL, AND meta.agentType === stdin.agent_type. (3) FAIL CLOSED
//   to territory.source:'unattributable' on every abnormal shape: missing
//   child transcript; first record not a type:'user' record with string
//   content; missing or malformed sidecar; toolUseId absent from the parent;
//   prompt mismatch; agentType mismatch; spawnDepth !== 1. (4) non-reviewer
//   classes are completely UNTOUCHED (today's delete-only SubagentStop path).
//   (5) a second-and-later SubagentStop (a SendMessage continuation round,
//   which appends a coordinator-message record to the SAME child transcript)
//   must NEVER re-derive territory — only the FIRST record is authoritative.
//
// Also read: knowledge_get 9500cce1 (declared REVIEW-TERRITORY is
// authoritative, observed paths corroborate/never gate — (D) still reads
// territory from the declared line, merely from the copy of the brief that
// provably reached THIS agent) and knowledge_get 5d3747c1 (this decision
// RETIRES 5d3747c1's named residual "same-type twins remain
// union-ambiguous" — the Start-time positional REGISTER pins above
// (REVIEWER-R0/R1/R2/R3, PIN1-PIN3) are left completely UNTOUCHED by this
// section: they describe SubagentStart's `files_source` on the transient
// REGISTER entry, which this decision explicitly keeps as a mere PROVISIONAL
// hint ("the register at Start is a hint, and the receipt must bind at
// Stop"); nothing in edbaa38d specifies the Start-side algorithm itself
// changes shape, so those pins were neither weakened nor deleted here).
//
// TWO ASSUMPTIONS DISCLOSED (the decision does not name either explicitly —
// stated here rather than guessed silently, per this role's anti-invention
// constraint):
//   (a) SUCCESS-CASE territory.source VALUE: edbaa38d names the FAILURE
//       literal ('unattributable') explicitly but never names what a
//       genuine bind records. Decision 8f137474 already establishes exactly
//       two literals for this field ('review-territory' when a
//       REVIEW-TERRITORY marker parses, 'free-prose-fallback' otherwise),
//       and edbaa38d states the SAME parseReviewTerritory parser is reused,
//       merely reading from a different location (the child transcript
//       instead of the parent block). Every pin below therefore asserts
//       territory.source === 'review-territory' on a genuine bind (every
//       fixture's child-transcript content below carries a valid marker
//       line) — this is the most parsimonious reading, not an invented
//       field. If the landed implementation instead mints a distinct new
//       literal for a Stop-derived bind, that is a reportable divergence
//       from this stated reading, not a reason to weaken these assertions.
//   (b) PROMOTION-ON-FAILURE: edbaa38d says territory "fails closed to
//       unattributable" but does not say whether the ledger PROMOTION itself
//       still occurs on a fail-closed shape (vs. being skipped entirely).
//       Every FAIL-CLOSED pin below asserts a ledger entry IS still promoted
//       (with territory.source:'unattributable') — mirroring the pre-existing
//       REGISTER-level convention (REVIEWER-R1/R2/R3 above, which likewise
//       still append a register entry, merely flagged 'unattributable') and
//       the fact that ledger promotion is gated purely on the
//       agent_type-prefix check today, independent of territory derivation.
//       If the real implementation instead skips promotion outright on these
//       shapes, that is a reportable divergence, not a reason to weaken this.
//
// HARNESS NOTE: neither scripts/tests/h22-review-ledger.test.mjs nor any
// other suite in this repo constructs a `.meta.json` sidecar or a
// `{parentUuid:null, isSidechain:true, type:'user', ...}` first-record child
// transcript today (confirmed via a files_with_matches-only grep for
// "meta.json"/"toolUseId"/"spawnDepth" across scripts/ — H4 honored, no
// content read of any implementation file) — the fixture helpers below
// (writeChildTranscript/writeSidecar/firstUserRecord/continuationRecord) are
// therefore modeled directly on the shapes edbaa38d itself specifies, not
// copied from an existing harness idiom. The parent-transcript /
// tool_use-block idiom (taskLine/taskBlockId), the register seeding
// idiom (registerEntry/writeRegisterRaw), and the ledger reader
// (ledgerPath/readLedger) ARE copied from this file's own makeH22Project /
// writeParentTranscript helpers above and from
// scripts/tests/h22-review-ledger.test.mjs's registerEntry/ledgerPath/
// readLedger idiom (reproduced standalone, without importing that file, per
// this repo's established no-cross-import convention between sibling
// H22 suites).
// ===========================================================================

function registerEntry(agentId, agentType, files, at = new Date().toISOString()) {
  return { agent_id: agentId, agent_type: agentType, session_id: 's1', files, at };
}
function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function readLedger(dir) {
  return existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : [];
}
function writeChildTranscript(dir, name, records) {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
function sidecarPathFor(childPath) {
  return childPath.replace(/\.jsonl$/, '.meta.json');
}
function writeSidecar(childPath, meta) {
  writeFileSync(sidecarPathFor(childPath), JSON.stringify(meta));
}
// agentId is the SECOND, optional param (per decision edbaa38d's measured
// fact: the child transcript's first record carries a TOP-LEVEL `agentId`
// equal to the agent id). Omitted entirely -> the key is absent from the
// record, for the ABSENT-arm below; every OTHER call site in this file passes
// the correct matching agent id so those arms continue to bind successfully
// once the new PIN-A check lands (fixture realism, not a weakened assertion).
const firstUserRecord = (content, agentId) => ({
  parentUuid: null,
  isSidechain: true,
  type: 'user',
  ...(agentId !== undefined ? { agentId } : {}),
  message: { role: 'user', content },
});
const continuationRecord = (content) => ({ parentUuid: 'parent-uuid-of-first-record', isSidechain: true, type: 'user', message: { role: 'user', content } });
// Carries an `id` (real tool_use blocks do) so the sidecar's toolUseId can
// name it uniquely — the pre-existing local `taskBlock` above never needed
// an id for the positional-attribution pins, so this is additive, not a
// modification of it.
const taskBlockId = (id, subagent_type, prompt) => ({ type: 'tool_use', id, name: 'Task', input: { subagent_type, prompt } });

function assertUnattributableStop(dir, agentId) {
  const ledger = readLedger(dir);
  const entry = ledger.find((e) => e.identity?.agent_id === agentId);
  assert.ok(entry, 'a reviewer-class Stop still promotes a ledger entry — fail-closed is a VALUE recorded on the entry, not a refusal to promote (assumption (b) above)');
  assert.equal(entry.territory.source, 'unattributable', 'an abnormal Stop-bind shape fails closed to unattributable, never a guessed or silently-wrong territory');
  return entry;
}

// ===========================================================================
// STOP-BIND CONTROL (placed FIRST, per this role's own multi-cause
// discipline): proves the derivation genuinely BINDS from real artifacts —
// without this, a green run on every FAIL-CLOSED arm below would be
// indistinguishable from "every reviewer-class Stop is unconditionally
// unattributable", a far more aggressive, wrong implementation that would
// ALSO pass every FAIL-CLOSED arm for the wrong reason. Also proves the
// ledger's territory comes from the CHILD transcript, never from the
// register's own (stale, Start-time-positional) files — the register here
// is deliberately seeded with a WRONG file.
// SABOTAGE: read territory straight from the register entry's
// files/files_source (today's pre-(D) ledger-promotion path) instead of
// deriving it from the child transcript at Stop — this test goes red
// (territory.files would read ['src/WRONG.mjs'] instead of
// ['scripts/target-a.mjs']).
// ===========================================================================

test('H22 STOP-BIND CONTROL (placed FIRST): reviewer-class territory binds at SubagentStop from the child transcript\'s delivered brief, corroborated by the sidecar\'s toolUseId — the register\'s own (wrong) files are never used', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review the recent diff for correctness.\nREVIEW-TERRITORY: ["scripts/target-a.mjs"]\nFocus only on the declared scope.';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_stopbind_1', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-stopbind', 'reviewer-correctness', ['src/WRONG.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-stopbind.jsonl', [firstUserRecord(brief, 'agent-stopbind')]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'review pass', toolUseId: 'toolu_stopbind_1', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-stopbind', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);

    const ledger = readLedger(dir);
    const entry = ledger.find((e) => e.identity?.agent_id === 'agent-stopbind');
    assert.ok(entry, 'the reviewer-class Stop promotes a ledger entry');
    assert.deepEqual(entry.territory.files, ['scripts/target-a.mjs'], "territory.files comes from the CHILD transcript's delivered brief, never the register's src/WRONG.mjs");
    assert.equal(entry.territory.source, 'review-territory', 'a genuinely bound derivation records the ordinary review-territory provenance, never unattributable');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// STOP-BIND BYTE-IDENTICAL BRIEFS — the highest-value arm in this suite: the
// exact case every rejected alternative (FIFO, content-uniqueness matching)
// fails on. Two dispatch blocks in ONE parent message carry byte-identical
// prompt text; two agents each spawn with their OWN child transcript + own
// sidecar naming their OWN distinct toolUseId. Neither must be rejected as
// ambiguous.
// SABOTAGE: disambiguate the parent tool_use block by searching for a UNIQUE
// content match instead of looking it up by the sidecar's toolUseId first —
// with two byte-identical prompts this becomes a 2-way ambiguous match, so a
// "must find exactly one content match" implementation fails closed for
// BOTH agents — reddening entryA.territory.source AND
// entryB.territory.source (both would read 'unattributable' instead of
// 'review-territory').
// ===========================================================================

test('H22 STOP-BIND BYTE-IDENTICAL BRIEFS: two dispatch blocks with identical prompt text still attribute correctly via the sidecar\'s unique toolUseId, never rejected as ambiguous', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const sharedBrief = 'Please review the shared scope.\nREVIEW-TERRITORY: ["scripts/shared-target.mjs"]\nBoth reviewers received this exact text.';
    writeParentTranscript(dir, [
      taskLine([taskBlockId('toolu_byteid_A', 'reviewer-correctness', sharedBrief), taskBlockId('toolu_byteid_B', 'reviewer-correctness', sharedBrief)]),
    ]);
    writeRegisterRaw(dir, [
      registerEntry('agent-byteid-a', 'reviewer-correctness', ['src/WRONG-A.mjs'], '2026-09-06T00:00:00.000Z'),
      registerEntry('agent-byteid-b', 'reviewer-correctness', ['src/WRONG-B.mjs'], '2026-09-06T00:00:01.000Z'),
    ]);

    const childA = writeChildTranscript(dir, 'agent-byteid-a.jsonl', [firstUserRecord(sharedBrief, 'agent-byteid-a')]);
    writeSidecar(childA, { agentType: 'reviewer-correctness', description: 'A', toolUseId: 'toolu_byteid_A', spawnDepth: 1, model: 'claude-x' });
    const childB = writeChildTranscript(dir, 'agent-byteid-b.jsonl', [firstUserRecord(sharedBrief, 'agent-byteid-b')]);
    writeSidecar(childB, { agentType: 'reviewer-correctness', description: 'B', toolUseId: 'toolu_byteid_B', spawnDepth: 1, model: 'claude-x' });

    let r = runH22(h22Input(dir, { agent_id: 'agent-byteid-a', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childA }), dir);
    assert.equal(r.code, 0, r.stderr);
    r = runH22(h22Input(dir, { agent_id: 'agent-byteid-b', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childB }), dir);
    assert.equal(r.code, 0, r.stderr);

    const ledger = readLedger(dir);
    const entryA = ledger.find((e) => e.identity?.agent_id === 'agent-byteid-a');
    const entryB = ledger.find((e) => e.identity?.agent_id === 'agent-byteid-b');
    assert.ok(entryA && entryB, 'BOTH byte-identical-brief dispatches promote their own ledger entry');
    assert.equal(entryA.territory.source, 'review-territory', 'A binds correctly despite an identical-content sibling — never rejected as ambiguous');
    assert.equal(entryB.territory.source, 'review-territory', 'B binds correctly despite an identical-content sibling — never rejected as ambiguous');
    assert.deepEqual(entryA.territory.files, ['scripts/shared-target.mjs']);
    assert.deepEqual(entryB.territory.files, ['scripts/shared-target.mjs']);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// STOP-BIND CONTINUATION — a second SubagentStop (a SendMessage continuation
// round) must NEVER re-derive territory from a record appended after the
// first. The sidecar is rewritten on delivery (per edbaa38d: "rewritten on
// every SendMessage delivery but toolUseId keeps the original spawn's
// value") — simulated here too, so this arm cannot be satisfied merely by an
// implementation that happens to ignore sidecar rewrites.
// R1 RE-CUT (A1/A4): the second Stop below has NO Start of its own — the
// first Stop marked the register entry ended — so under the rebuild it mints
// nothing and touches nothing, and the assertion is strengthened from "the
// territory did not change" to "the ledger is byte-identical". Round 2 WITH
// its own Start is the separate arm R1-B18.
// SABOTAGE: re-parse the child transcript's LAST record (or union every
// record) on every Stop instead of freezing on the first — reddens the
// territory.files deepEqual (would include or become
// ['scripts/should-never-be-used.mjs']).
// SABOTAGE: promote again on the second Stop without checking for an UNENDED
// register entry — reddens the byte-identical assertion (a second receipt is
// appended, or the first is re-dated).
// ===========================================================================

test('H22 STOP-BIND CONTINUATION: a second SubagentStop never re-derives territory from an appended coordinator-continuation record — only the FIRST record is authoritative', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review the assigned scope.\nREVIEW-TERRITORY: ["scripts/first-round.mjs"]\nThis is the original dispatch.';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_cont_1', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-cont', 'reviewer-correctness', ['src/irrelevant.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-cont.jsonl', [firstUserRecord(brief, 'agent-cont')]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'round 1', toolUseId: 'toolu_cont_1', spawnDepth: 1, model: 'claude-x' });

    let r = runH22(
      h22Input(dir, { agent_id: 'agent-cont', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const entry1 = readLedger(dir).find((e) => e.identity?.agent_id === 'agent-cont');
    assert.ok(entry1, 'first Stop promotes the receipt');
    assert.deepEqual(entry1.territory.files, ['scripts/first-round.mjs']);
    const ledgerAfterFirst = readFileSync(ledgerPath(dir), 'utf8');

    const decoy = 'Thanks, one more thing to check.\nREVIEW-TERRITORY: ["scripts/should-never-be-used.mjs"]';
    writeFileSync(childPath, readFileSync(childPath, 'utf8') + JSON.stringify(continuationRecord(decoy)) + '\n');
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'round 2 (continuation)', toolUseId: 'toolu_cont_1', spawnDepth: 1, model: 'claude-x' });

    r = runH22(
      h22Input(dir, { agent_id: 'agent-cont', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(ledgerPath(dir), 'utf8'), ledgerAfterFirst, 'A4: the second Stop has no unended register entry of its own — the ledger is byte-identical');
    const ledgerAfter = readLedger(dir);
    const entry2 = ledgerAfter.find((e) => e.entry_id === entry1.entry_id) ?? ledgerAfter.find((e) => e.identity?.agent_id === 'agent-cont');
    assert.ok(entry2, 'the same receipt is still present after the second Stop');
    assert.deepEqual(entry2.territory.files, ['scripts/first-round.mjs'], 'the second Stop never re-derives territory from the appended continuation record');
    assert.ok(!entry2.territory.files.includes('scripts/should-never-be-used.mjs'), 'the decoy REVIEW-TERRITORY in the continuation record never leaks into territory.files');
    assert.equal(entry2.territory.source, 'review-territory', 'the source stays the original genuine binding, never flipped to unattributable by a confusing multi-record shape');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// STOP-BIND NON-REVIEWER — non-reviewer classes are completely untouched by
// this mechanism, even when fully valid Stop-bind artifacts (child
// transcript + sidecar) are present. This is the arm proving the new
// derivation is gated strictly on the 'reviewer-' agent_type prefix, not on
// artifact availability.
// SABOTAGE: broaden the new Stop-bind derivation to run (and promote a
// ledger entry) whenever a valid child transcript + sidecar are present,
// regardless of agent_type — this test goes red (a ledger file would be
// created for a 'coder' Stop).
// ===========================================================================

test('H22 STOP-BIND NON-REVIEWER: a non-reviewer agent_type ("coder") is completely unaffected — delete-only, no ledger entry, even with fully valid child-transcript+sidecar artifacts present', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please implement the change.\nREVIEW-TERRITORY: ["scripts/coder-target.mjs"]\n';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_nonrev_1', 'coder', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-nonrev', 'coder', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-nonrev.jsonl', [firstUserRecord(brief, 'agent-nonrev')]);
    writeSidecar(childPath, { agentType: 'coder', description: 'implement', toolUseId: 'toolu_nonrev_1', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-nonrev', agent_type: 'coder', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);

    assert.equal(existsSync(ledgerPath(dir)), false, 'a non-reviewer Stop never creates a ledger entry, no matter how complete the Stop-bind artifacts are');
    // A1 RE-CUT: Stop MARKS the entry ended; it does not delete it, so
    // 'inactive-confirmed' is a real classifier output rather than an absence.
    // SABOTAGE: delete the entry at Stop (today's behaviour) — this goes red.
    const reg = readRegister(dir);
    assert.equal(reg.length, 1, 'the register entry survives its Stop');
    assert.equal(reg[0].agent_id, 'agent-nonrev');
    assert.equal(reg[0].ended?.event, 'subagent-stop', 'the terminal event that was actually observed is recorded');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// STOP-BIND FAIL-CLOSED ARMS — each of edbaa38d's seven enumerated abnormal
// shapes gets its OWN arm, each constructed so a naive/partial implementation
// that is missing THAT ONE specific check would produce a real (wrong,
// non-unattributable) bind instead — a blanket "always unattributable"
// implementation cannot satisfy these ARMS either (it would fail the
// CONTROL/BYTE-IDENTICAL/CONTINUATION arms above), and a blanket "never
// unattributable" implementation cannot satisfy ANY of the arms below.
// ===========================================================================

// SABOTAGE: skip the child-transcript-existence check and fall through to a
// silent default (e.g. the register's own files/files_source) instead of
// failing closed — this test goes red (territory.source would read
// 'free-prose-fallback' or similar instead of 'unattributable').
test('H22 STOP-BIND FAIL-CLOSED (missing child transcript): agent_transcript_path names a file that does not exist on disk — unattributable, disclosed', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/target.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_f1', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-f1', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);
    const missingChildPath = join(dir, 't', 'agent-f1-DOES-NOT-EXIST.jsonl');

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-f1', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: missingChildPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-f1');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// SABOTAGE: reach for record.message.content and coerce it (e.g.
// String(content) or content[0]?.text) instead of requiring type:'user' with
// a plain string — this test goes red (it would recover the brief text
// anyway and derive real territory instead of unattributable).
test('H22 STOP-BIND FAIL-CLOSED (malformed first record): the child transcript\'s first record is assistant-shaped with array content, not {type:"user", message:{content:<string>}} — unattributable, disclosed', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/target.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_f2', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-f2', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-f2.jsonl', [{ type: 'assistant', message: { content: [{ type: 'text', text: brief }] } }]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'x', toolUseId: 'toolu_f2', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-f2', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-f2');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// SABOTAGE: treat a missing sidecar as "corroboration not required" and
// trust the child-transcript-parsed territory unconditionally — reddens the
// source assertion (would read 'review-territory' instead of
// 'unattributable').
test('H22 STOP-BIND FAIL-CLOSED (missing sidecar): the child transcript is well-formed but its .meta.json sidecar does not exist at all — unattributable, disclosed', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/target.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_f3', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-f3', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-f3.jsonl', [firstUserRecord(brief, 'agent-f3')]);
    // Deliberately no writeSidecar call at all — the sidecar file never exists.

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-f3', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-f3');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// SABOTAGE: swallow the JSON.parse failure on the sidecar and fall through
// to trusting the child-transcript-parsed territory unconditionally (as if
// no corroboration were required) — reddens the source assertion.
test('H22 STOP-BIND FAIL-CLOSED (malformed sidecar): the .meta.json sidecar exists but is corrupt (unparseable) JSON — unattributable, disclosed', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/target.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_f4', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-f4', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-f4.jsonl', [firstUserRecord(brief, 'agent-f4')]);
    writeFileSync(sidecarPathFor(childPath), '{ this is not valid json at all');

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-f4', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-f4');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// SABOTAGE: fall back to searching the parent transcript for a tool_use
// block whose input.prompt equals the child's first-record content when the
// sidecar's toolUseId isn't found in the parent — the sabotaged version
// would wrongly find/bind to 'toolu_f5_real' (matching CONTENT, wrong id),
// reddening the source assertion (would read 'review-territory' instead of
// 'unattributable').
test('H22 STOP-BIND FAIL-CLOSED (toolUseId not in parent): the sidecar\'s toolUseId matches no tool_use block in the parent transcript — unattributable even though a DIFFERENT block with matching prompt CONTENT exists', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/target.mjs"]';
    // A real block exists with matching CONTENT but a DIFFERENT id — a
    // content-based fallback would wrongly succeed here; the id-first lookup
    // must not.
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_f5_real', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-f5', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-f5.jsonl', [firstUserRecord(brief, 'agent-f5')]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'x', toolUseId: 'toolu_DOES_NOT_EXIST', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-f5', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-f5');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// SABOTAGE: skip the byte-equality check between the resolved parent block's
// input.prompt and the child's first-record content (trust the toolUseId
// lookup alone) — the sabotaged version derives territory from either side's
// content instead of failing closed, reddening the source assertion.
test('H22 STOP-BIND FAIL-CLOSED (prompt mismatch): the sidecar\'s toolUseId resolves to a real parent block, but that block\'s input.prompt differs from the child\'s first-record content — unattributable, disclosed', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const childContent = 'Please review.\nREVIEW-TERRITORY: ["scripts/target.mjs"]';
    const parentPrompt = 'Please review.\nREVIEW-TERRITORY: ["scripts/DIFFERENT.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_f6', 'reviewer-correctness', parentPrompt)])]);
    writeRegisterRaw(dir, [registerEntry('agent-f6', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-f6.jsonl', [firstUserRecord(childContent, 'agent-f6')]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'x', toolUseId: 'toolu_f6', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-f6', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-f6');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// SABOTAGE: drop the meta.agentType === stdin.agent_type equality check from
// the binding condition (require only a successful toolUseId+prompt match) —
// this test goes red (territory binds successfully despite the mismatch).
test('H22 STOP-BIND FAIL-CLOSED (agentType mismatch): the sidecar\'s agentType differs from stdin.agent_type (both valid reviewer-* values) — unattributable, disclosed', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/target.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_f7', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-f7', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-f7.jsonl', [firstUserRecord(brief, 'agent-f7')]);
    writeSidecar(childPath, { agentType: 'reviewer-security', description: 'x', toolUseId: 'toolu_f7', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-f7', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-f7');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// SABOTAGE: drop the spawnDepth === 1 gate from the binding condition — this
// test goes red (territory binds successfully despite the nested-agent
// shape).
test('H22 STOP-BIND FAIL-CLOSED (spawnDepth !== 1): a nested agent (sidecar spawnDepth: 2) is refused for reviewer receipt binding — unattributable, disclosed', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/target.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_f8', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-f8', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-f8.jsonl', [firstUserRecord(brief, 'agent-f8')]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'x', toolUseId: 'toolu_f8', spawnDepth: 2, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-f8', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-f8');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN A — THE BIND MUST BE TIED TO THIS AGENT (fail-closed on cross-agent
// substitution). SPEC PER THE LAUNCHING AGENT (external review of edbaa38d's
// mechanism, not read from any implementation file): the Stop-bind mechanism
// as specified proves the child transcript agrees with its own sidecar, the
// sidecar agrees with stdin.agent_type, and the resolved parent block agrees
// with the child's first-record content — but NEVER that the transcript
// BELONGS TO stdin.agent_id. Two sibling reviewer dispatches of the SAME
// class therefore have interchangeable, self-consistent artifact triples, so
// a wrong agent_transcript_path could bind a FOREIGN territory with a fully
// spendable source.
//
// MEASURED FACT (per the launching agent, verified on real transcripts this
// session): the child transcript's FIRST record carries a TOP-LEVEL
// `agentId` field equal to the agent id, alongside parentUuid:null,
// isSidechain:true, type:'user'.
//
// firstUserRecord() above now takes an optional second `agentId` param
// (added this slice) — every PRE-EXISTING call site elsewhere in this file
// was updated to pass its own test's correct, matching agent id, so those
// arms keep proving exactly what they always proved once this new check
// lands; only the three arms below deliberately vary agentId.
// ===========================================================================

// CONTROL (placed FIRST): the otherwise-identical fixture WITH a matching
// agentId must bind successfully — without this, a green DIFFERS/ABSENT arm
// below is indistinguishable from "Stop-bind broke and now always refuses",
// a regression that would ALSO pass those two arms for the wrong reason.
// SABOTAGE: wire the new agentId check backwards (require agentId !==
// stdin.agent_id, or compare it to the wrong field) — this CONTROL goes red
// (territory.source would read 'unattributable' instead of
// 'review-territory').
test('H22 STOP-BIND PIN A CONTROL (placed FIRST): a child transcript whose first record\'s agentId matches stdin.agent_id binds successfully', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/pinA-ctrl.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_pinA_ctrl', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-pinA-ctrl', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    const childPath = writeChildTranscript(dir, 'agent-pinA-ctrl.jsonl', [firstUserRecord(brief, 'agent-pinA-ctrl')]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'x', toolUseId: 'toolu_pinA_ctrl', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-pinA-ctrl', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const entry = readLedger(dir).find((e) => e.identity?.agent_id === 'agent-pinA-ctrl');
    assert.ok(entry, 'a matching agentId still promotes a ledger entry');
    assert.equal(entry.territory.source, 'review-territory', 'a matching agentId binds normally — the control PIN A\'s other two arms depend on');
    assert.deepEqual(entry.territory.files, ['scripts/pinA-ctrl.mjs']);
  } finally {
    cleanup();
  }
});

// SABOTAGE: never compare the first record's agentId to stdin.agent_id at
// all (bind purely on toolUseId + prompt + agentType, exactly as before this
// pin) — this test goes red (territory.source would read 'review-territory'
// instead of 'unattributable', and territory.files would wrongly read
// ['scripts/pinA-diff.mjs'] — a foreign agent's territory bound as this
// agent's own).
test('H22 STOP-BIND PIN A (agentId differs): a child transcript whose first record\'s agentId DIFFERS from stdin.agent_id — sidecar, prompt and parent block all otherwise valid and self-consistent — is unattributable, never bound to a foreign sibling\'s territory', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/pinA-diff.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_pinA_diff', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-pinA-diff', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    // The child transcript's own first-record agentId names a DIFFERENT
    // sibling agent — everything else (sidecar toolUseId, agentType, prompt
    // byte-equality) is fully valid and self-consistent.
    const childPath = writeChildTranscript(dir, 'agent-pinA-diff.jsonl', [firstUserRecord(brief, 'agent-pinA-OTHER-SIBLING')]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'x', toolUseId: 'toolu_pinA_diff', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-pinA-diff', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-pinA-diff');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// SABOTAGE: treat a missing agentId as "no check possible, fall through to
// trusting the toolUseId+prompt+agentType match" instead of failing closed —
// this test goes red (territory.source would read 'review-territory' instead
// of 'unattributable').
test('H22 STOP-BIND PIN A (agentId absent): a child transcript whose first record has NO agentId field at all is unattributable — an absent field proves nothing about which agent the transcript belongs to', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review.\nREVIEW-TERRITORY: ["scripts/pinA-absent.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_pinA_absent', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [registerEntry('agent-pinA-absent', 'reviewer-correctness', ['src/whatever.mjs'], '2026-09-06T00:00:00.000Z')]);

    // No second arg to firstUserRecord -> the agentId key is absent entirely.
    const childPath = writeChildTranscript(dir, 'agent-pinA-absent.jsonl', [firstUserRecord(brief)]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'x', toolUseId: 'toolu_pinA_absent', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-pinA-absent', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assertUnattributableStop(dir, 'agent-pinA-absent');
    assert.match(outputOf(r), token('receipt_unattributable'), 'the fail-closed bind is disclosed by its code (A6), never by a sentence');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// RETIRED HERE — the PIN B family (A4, MEASURED 2026-09-07).
//
// RETIRED: 'PIN B CONTROL (exactly ONE string-content user record binds)'
// RETIRED: 'PIN B (resumed reviewer, no existing receipt) -> unattributable'
// RETIRED: 'PIN B (truncated child read) -> refuse rather than conclude
//           "first Stop" from the lines that parsed'
//
// All three inferred "this is a resumed round" from the COUNT of
// string-content user records in the child transcript, on the premise that a
// resumed round produces a Stop with NO Start of its own. A4 measured that
// premise FALSE: resuming with SendMessage fires SubagentStart again with the
// same agent_id, so round n+1 has its own register entry and legitimately
// mints its own receipt. Kept as written, this family would make every
// resumed round's receipt unspendable — defeating the rebuild's own named
// remedy for a broken byte binding ("the remedy is a fresh review round").
//
// The danger the family guarded — a Stop with no Start of its own re-binding
// an old brief onto today's bytes — is closed by the register rule instead,
// and is pinned in scripts/tests/h22-review-ledger.test.mjs as R1-B10 (a Stop
// whose only matching entry is already ENDED mints nothing and touches
// nothing) with R1-B11 as its counter-arm (a genuine round 2, with its own
// Start, mints its own second receipt). The truncated-read concern survives
// as a general fail-closed property of the child read, exercised by the
// FAIL-CLOSED (malformed first record) arm above.
// ===========================================================================

// R1-B18 (REPLACES the retired PIN B resumed arm, A4): a genuine round 2 has
// its OWN unended register entry, and its receipt binds from the child
// transcript's FIRST record — the original brief — exactly as round 1 did.
// This is the case A4 measured live ("territory derived from the original
// brief"), and the continuation record appended for round 2 must not change
// what the receipt says it reviewed.
// SABOTAGE: derive territory from the LAST string-content user record (or the
// union of them) once more than one exists — this goes red (territory.files
// would read ['scripts/should-never-be-used.mjs']).
test('R1-B18 (A4): round 2 — its own unended register entry, a child transcript carrying the appended continuation — still binds territory from the FIRST record', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review the assigned scope.\nREVIEW-TERRITORY: ["scripts/pinB-original.mjs"]\nThis is the original dispatch.';
    const continuation = 'Thanks for the first pass.\nREVIEW-TERRITORY: ["scripts/should-never-be-used.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_pinB_resumed', 'reviewer-correctness', brief)])]);
    // A4's register shape: round 1's entry is ENDED and stays; round 2's Start
    // appended a fresh UNENDED entry for the same agent_id.
    writeRegisterRaw(dir, [
      { ...registerEntry('agent-pinB-resumed', 'reviewer-correctness', ['src/irrelevant.mjs'], '2026-09-06T00:00:00.000Z'), ended: { at: '2026-09-06T00:05:00.000Z', event: 'subagent-stop' } },
      { ...registerEntry('agent-pinB-resumed', 'reviewer-correctness', ['src/irrelevant.mjs'], '2026-09-06T00:10:00.000Z'), round: 2 },
    ]);

    const childPath = writeChildTranscript(dir, 'agent-pinB-resumed.jsonl', [
      firstUserRecord(brief, 'agent-pinB-resumed'),
      continuationRecord(continuation),
    ]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'resumed round', toolUseId: 'toolu_pinB_resumed', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-pinB-resumed', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const entry = readLedger(dir).find((e) => e.identity?.agent_id === 'agent-pinB-resumed');
    assert.ok(entry, "round 2's Stop mints its own receipt — it has its own Start (A4)");
    assert.equal(entry.territory.source, 'review-territory', 'a resumed round binds normally; it is not unattributable merely for being round 2');
    assert.deepEqual(entry.territory.files, ['scripts/pinB-original.mjs'], 'only the FIRST child record is authoritative (edbaa38d item 5)');
    assert.ok(!entry.territory.files.includes('scripts/should-never-be-used.mjs'), 'the appended continuation never re-declares territory');
  } finally {
    cleanup();
  }
});

// R1-B19 (A4, the surviving half of the retired truncated-read arm): a Stop
// whose agent_id has NO UNENDED register entry mints NOTHING, whatever the
// child transcript says. This is the fail-closed rule that replaces the
// count-based resumed-round inference: a Stop that never had a Start of its
// own cannot mint evidence, so there is no partial-read conclusion left to
// draw. Its counter-arm is R1-B18 above (a genuine round 2 DOES mint).
// SABOTAGE: promote on the presence of a valid child transcript + sidecar
// without requiring an unended register entry — this goes red (a receipt
// appears for a round that never started).
test('R1-B19 (A4): a reviewer Stop whose only register entry is already ENDED mints no receipt at all, however complete its Stop-bind artifacts are', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    const brief = 'Please review the assigned scope.\nREVIEW-TERRITORY: ["scripts/no-start.mjs"]';
    writeParentTranscript(dir, [taskLine([taskBlockId('toolu_nostart', 'reviewer-correctness', brief)])]);
    writeRegisterRaw(dir, [
      { ...registerEntry('agent-no-start', 'reviewer-correctness', ['src/irrelevant.mjs'], '2026-09-06T00:00:00.000Z'), ended: { at: '2026-09-06T00:05:00.000Z', event: 'subagent-stop' } },
    ]);

    const childPath = writeChildTranscript(dir, 'agent-no-start.jsonl', [firstUserRecord(brief, 'agent-no-start')]);
    writeSidecar(childPath, { agentType: 'reviewer-correctness', description: 'no start of its own', toolUseId: 'toolu_nostart', spawnDepth: 1, model: 'claude-x' });

    const r = runH22(
      h22Input(dir, { agent_id: 'agent-no-start', agent_type: 'reviewer-correctness', hook_event_name: 'SubagentStop', agent_transcript_path: childPath }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(ledgerPath(dir)), false, 'no unended register entry — no receipt, and no ledger file conjured for one');
  } finally {
    cleanup();
  }
});
