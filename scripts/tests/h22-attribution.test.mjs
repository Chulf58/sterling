// H22/H26 PER-BLOCK ATTRIBUTION (Start-side) AND REVIEWER TERRITORY BINDING
// AT SubagentStop (decision foreign_edbaa38d).
//
// ===========================================================================
// STATE-MACHINE RE-CUT (board 5445066b, decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution`,
// knowledge_get 7c515e52 — opened, not paraphrased).
//
// WHAT CHANGED, and why the Start-side pins below are re-cut rather than
// merely re-pointed: attribution at SubagentStart no longer reads the PARENT
// TRANSCRIPT at all. The transcript tail is the MEASURED defect (finding
// 51506eec: 3.4-5.5 s of lag, 4 of 6 spawns saw an older unrelated block), so
// the readers it was built on — lastDispatchPrompts / lastDispatchBlocks /
// attributeBlocks — are DELETED. A Start now resolves its own dispatch from a
// per-dispatch STATE RECORD written at PreToolUse and bound by PostToolUse's
// tool_response.agentId, or it learns that it cannot and says so.
//
// CONSEQUENCES FOR THIS FILE:
//   - Every Start-side fixture plants its dispatch through a REAL PreToolUse
//     (and, where the case needs an authoritative binding, PostToolUse) event
//     run through h22 — see stagePre()/stagePost() below. transcript_path on
//     those Starts points at a file that does not exist, which is now the
//     correct fixture and doubles as a pin that no transcript is read.
//   - RETIRED (mechanism REMOVED, not merely re-pinned): 'PIN3' (cross-batch
//     walk-back), 'REVIEWER-R2' (single walk-back match) and 'REVIEWER-R3'
//     (terminal union). The bounded backward walk and the union fallback are
//     gone; a Start with no candidate slot is an honest 'no-slot'
//     (unattributable), pinned in scripts/tests/dispatch-state-hooks.test.mjs
//     (DSH-4).
//   - RE-CUT: 'PIN1' (mixed-type -> own slot by derivation), 'PIN2' (same-type
//     twins -> UNATTRIBUTABLE after the bounded wait, where it used to be a
//     union), 'REVIEWER-R0'/'REVIEWER-R1'. The reviewer-class-only
//     'unattributable' override of board c9f92090 is SUBSUMED: ambiguity is
//     now unattributable for EVERY class, so PIN2's old "a non-reviewer never
//     gets the reviewer-only override" assertion is inverted by the ruling and
//     re-cut, not deleted.
//   - UNCHANGED (and deliberately so): every SubagentStop pin from
//     'STOP-BIND BYTE-IDENTICAL BRIEFS' onward. §7(b) keeps H22's Stop-time
//     PARENT-transcript lookup (findParentToolUseBlock — an exact known-id
//     search, not the laggy tail heuristic); those fixtures keep planting a
//     parent transcript because that mechanism still reads one.
// ===========================================================================
//
// R1 PIN RE-CUT (contract sheet §2.1 + amendments A1/A4/A6): the attribution
// contracts in this file are KEPT — the rebuild keeps decision foreign_edbaa38d's
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
// HISTORICAL SPEC — SUPERSEDED by the STATE-MACHINE RE-CUT above (decision
// 7c515e52 deletes lastDispatchBlocks/lastDispatchPrompts/attributeBlocks
// outright). Kept for provenance of the Stop-bind sections only; do NOT
// implement against the three paragraphs that follow.
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

// --------------------------------------------------------------------------
// STATE-MACHINE FIXTURES (decision foreign_7c515e52 §1-§2; stdin shapes from
// research_finding foreign_2bad782a). A dispatch is declared by its REAL PreToolUse
// event, exactly as the platform fires it — never by planting a transcript.
// --------------------------------------------------------------------------

const preInput = (dir, { tool_use_id, subagent_type, prompt, description = 'a lane', session_id = 's1', tool_name = 'Task' }) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_use_id,
  tool_input: { subagent_type, prompt, description },
  session_id,
  cwd: dir,
  transcript_path: join(dir, 't', 'parent.jsonl'),
  prompt_id: 'pr-1',
});

const postInput = (dir, { tool_use_id, subagent_type, prompt, agentId, description = 'a lane', session_id = 's1', tool_name = 'Task' }) => ({
  hook_event_name: 'PostToolUse',
  tool_name,
  tool_use_id,
  tool_input: { subagent_type, prompt, description },
  tool_response: {
    isAsync: true, status: 'async_launched', agentId, description,
    resolvedModel: 'claude-x', prompt, outputFile: join(dir, 'out.txt'), canReadOutputFile: true,
  },
  session_id,
  cwd: dir,
  transcript_path: join(dir, 't', 'parent.jsonl'),
  prompt_id: 'pr-1',
});

function stagePre(dir, args) {
  const r = runH22(preInput(dir, args), dir);
  assert.equal(r.code, 0, `PreToolUse must never deny a dispatch: ${r.stderr}`);
  return r;
}
function stagePost(dir, args) {
  const r = runH22(postInput(dir, args), dir);
  assert.equal(r.code, 0, `PostToolUse must never deny: ${r.stderr}`);
  return r;
}
// A Start whose transcript_path CANNOT be read: under 7c515e52 the parent
// transcript is never consulted at Start, so any surviving reader fails loudly
// here instead of passing by accident.
const startInput = (dir, over = {}) =>
  h22Input(dir, { transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'), ...over });

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

// H26-side fixtures (makeH26Project/taskInput/parseAdditionalContext/tokenRe/
// assertSilent/assertOverlapWarning/agoISO/liveEntry) REMOVED — they existed
// solely to serve the PIN4a/4b/PIN5/PIN6b tests, which invoked the now-deleted
// h26-dispatch-overlap.mjs; see the removal note above PIN 6a.

// ===========================================================================
// PIN 1 (RE-CUT, 7c515e52 §5(iii)) — mixed-type batch: exactly ONE PENDING
// state record carries my agent_type, so derivation is exact BY CONSTRUCTION
// -> that dispatch's files ONLY, attribution 'block' with attribution_case
// 'derived-type-unique'.
// EXPECTED RED today: no Pre branch exists, so no state record is written and
// the Start falls back to the (deliberately absent) parent transcript — the
// entry gets files:[] and no attribution field. Fails at the files deepEqual
// and at `assert.equal(entry.attribution, 'block')`.
// ===========================================================================

test('H22 attribution PIN1: mixed-type batch — one coder dispatch + one test-writer dispatch pending, SubagentStart agent_type=coder is attributed only the coder dispatch, attribution:block', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    stagePre(dir, { tool_use_id: 'toolu_p1_coder', subagent_type: 'coder', prompt: 'Please modify src/fileA.mjs for the coder half of this batch' });
    stagePre(dir, { tool_use_id: 'toolu_p1_tw', subagent_type: 'test-writer', prompt: 'Please write tests touching src/fileB.mjs for the test-writer half of this batch' });

    const r = runH22(startInput(dir, { agent_id: 'agent-mixed', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-mixed');
    assert.ok(entry, 'entry was appended');
    assert.deepEqual([...entry.files].sort(), ['src/fileA.mjs'], 'files come from the coder dispatch only');
    assert.ok(!entry.files.includes('src/fileB.mjs'), 'the test-writer sibling dispatch never contributes files to a coder attribution');
    assert.equal(entry.attribution, 'block', 'exactly one type-unique pending slot -> precise attribution');
    assert.equal(entry.attribution_case, 'derived-type-unique', 'the entry records HOW it was attributed — a derivation is an inference, a Post binding is proof');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the `subagent_type === agent_type` filter from derivation —
// two candidates appear, the Start goes unattributable, and the files/
// attribution assertions go red. Second sabotage: keep any parent-transcript
// fallback — transcript_path here does not exist, so files:[] reddens the
// deepEqual.

// ===========================================================================
// PIN 2 (RE-CUT — THE RULING IS INVERTED HERE, state it plainly) — same-type
// twins are UNATTRIBUTABLE, for EVERY class, once the bounded 150 ms wait for
// a Post binding expires. The old expectation (a union of the same-type
// blocks, attribution 'union', and a non-reviewer keeping
// 'free-prose-fallback' under this exact shape) described the DELETED
// mechanism: a union is a confident wrong answer whenever the two siblings
// have different territory, which is the defect board 5445066b measured. The
// reviewer-only override of board c9f92090 is therefore SUBSUMED, not leaked:
// ambiguity fails closed for a test-writer exactly as for a reviewer.
// EXPECTED RED today: h22 unions the last message's blocks and writes no
// attribution field; with no transcript present it writes files:[] and no
// attribution. Fails at `assert.equal(entry.attribution, 'none')` and at the
// files_source equality.
// ===========================================================================

test('H22 attribution PIN2: same-type twins — two pending test-writer dispatches and no Post binding, SubagentStart agent_type=test-writer is UNATTRIBUTABLE (files [], attribution none) for a NON-reviewer class too', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    stagePre(dir, { tool_use_id: 'toolu_p2_a', subagent_type: 'test-writer', prompt: 'write tests for src/fileA.mjs' });
    stagePre(dir, { tool_use_id: 'toolu_p2_b', subagent_type: 'test-writer', prompt: 'also write tests for src/fileB.mjs' });
    stagePre(dir, { tool_use_id: 'toolu_p2_c', subagent_type: 'coder', prompt: 'implement src/fileC.mjs' });

    const r = runH22(startInput(dir, { agent_id: 'agent-twin', agent_type: 'test-writer' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-twin');
    assert.ok(entry, 'an unattributable Start STILL appends its round — it just declares no territory');
    assert.deepEqual(entry.files, [], 'no union: two same-type candidates means this Start cannot know which prompt is its own');
    assert.ok(!entry.files.includes('src/fileC.mjs'), 'the other-type sibling was never a candidate in the first place');
    assert.equal(entry.attribution, 'none', "H26 skips anything but exact 'block' — 'none' is the fail-closed value, never a missing field");
    assert.equal(entry.files_source, 'unattributable', 'ambiguity is unattributable for EVERY class (the reviewer-only override is subsumed by 7c515e52 §3)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: restore the union fallback for several same-type candidates — the
// files/attribution/files_source assertions all go red. Second sabotage:
// pick the first candidate ("close enough") — same three go red. Which guard
// carries the verdict: ONE — the candidate-count check in §5(iii).

// ===========================================================================
// RETIRED HERE — 'PIN3: cross-batch walk-back'.
// The bounded BACKWARD WALK through earlier dispatching assistant messages
// does not exist under decision foreign_7c515e52: SubagentStart never reads the parent
// transcript, so there is no message list to walk. A late-starting agent whose
// slot is still pending resolves through §5(i)/(iii) with no notion of message
// recency at all (pinned by PIN1 above and by
// scripts/tests/dispatch-state-hooks.test.mjs DSH-1, where a dispatch's own
// Start fires up to two Pre events later — the MEASURED shape); a Start with
// no candidate at all is an honest 'no-slot' (DSH-4). Keeping a walk-back pin
// would pin a mechanism whose deletion is the point of the decision.
// ===========================================================================

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
// decision foreign_8f137474/h22-review-territory.test.mjs contract, where every
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

test('H22 attribution REVIEWER-R0 (CONTROL, placed FIRST): the SAFE case — exactly one pending reviewer-correctness dispatch — is attributed normally: attribution:block, files_source stays free-prose-fallback, never unattributable', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    stagePre(dir, { tool_use_id: 'toolu_r0', subagent_type: 'reviewer-correctness', prompt: 'please review src/rSafe.mjs for correctness' });

    const r = runH22(startInput(dir, { agent_id: 'agent-rev-safe', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-rev-safe');
    assert.ok(entry, 'entry was appended');
    assert.equal(entry.attribution, 'block', 'a type-unique pending slot is exact by construction for a reviewer too');
    assert.equal(entry.files_source, 'free-prose-fallback', 'no REVIEW-TERRITORY marker in this prompt, so the territory is free-prose — and the SAFE case is never downgraded to unattributable. This is the control R1 depends on to mean anything');
  } finally {
    cleanup();
  }
});

test('H22 attribution REVIEWER-R1: UNSAFE case — two pending same-type reviewer dispatches and no Post binding — files_source becomes unattributable, disclosed loudly', () => {
  const { dir, cleanup } = makeH22Project();
  try {
    stagePre(dir, { tool_use_id: 'toolu_r1a', subagent_type: 'reviewer-correctness', prompt: 'review src/r1a.mjs' });
    stagePre(dir, { tool_use_id: 'toolu_r1b', subagent_type: 'reviewer-correctness', prompt: 'also review src/r1b.mjs' });
    stagePre(dir, { tool_use_id: 'toolu_r1c', subagent_type: 'coder', prompt: 'implement src/r1c.mjs' });

    const r = runH22(startInput(dir, { agent_id: 'agent-rev-sibling', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);

    const reg = readRegister(dir);
    const entry = reg.find((e) => e.agent_id === 'agent-rev-sibling');
    assert.ok(entry, 'entry was appended');
    assert.equal(entry.files_source, 'unattributable', 'two same-type pending dispatches means this Start (whose stdin carries no tool_use_id — finding 51506eec) cannot tell which physical dispatch is its own'); // not-a-citation: fixture id
    assert.match(outputOf(r), ANY_CODE, 'the case is disclosed through the shared errors module, code first (A6) — never a silent downgrade');
  } finally {
    cleanup();
  }
});
// SABOTAGE (R0/R1 as a pair): pick the first same-type candidate — R1's
// files_source assertion goes red while R0 stays green. Inverse sabotage:
// flag every reviewer-class Start unattributable (the retired c9f92090
// override) — R0 goes red while R1 stays green. Neither sabotage can be
// hidden, which is why the two arms are kept together.

// ===========================================================================
// RETIRED HERE — 'REVIEWER-R2' (a SINGLE walk-back match) and 'REVIEWER-R3'
// (the terminal union), both by decision foreign_7c515e52.
// Both pinned SHAPES of the deleted transcript-tail reader: R2 pinned the
// bounded backward walk (there is no message list to walk), R3 pinned the
// union of the last message's blocks (there is no union). Their substance —
// "a reviewer-class Start that cannot be tied to ONE dispatch declares no
// territory" — survives in REVIEWER-R1 above (ambiguous candidates) and in
// scripts/tests/dispatch-state-hooks.test.mjs DSH-4/DSH-7 (no slot at all, and
// the reviewer control/ambiguous pair).
// ===========================================================================

// ===========================================================================
// PIN 4a/4b/PIN 5 (H26 overlap-suppression pins) REMOVED — H26
// (scripts/hooks/h26-dispatch-overlap.mjs) is deleted under decision
// `sterling-claude-code-scale-down-boundary` (2ad87dd1); these pins invoked
// it as a subprocess (runH26) and asserted its overlap-advisory text, both
// of which no longer exist. The H26-only harness helpers they alone used
// (makeH26Project/taskInput/parseAdditionalContext/tokenRe/assertSilent/
// assertOverlapWarning/agoISO/liveEntry) were removed with them — grep
// confirms zero remaining callers in this file.
// ===========================================================================

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
    stagePre(dir, { tool_use_id: 'toolu_p6a', subagent_type: 'coder', prompt: 'touch src/fileR.mjs' });
    const r = runH22(startInput(dir, { agent_id: 'agent-r', agent_type: 'coder' }), dir);
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

// PIN 6b (H26 legacy-entry suppression) REMOVED — invoked the now-deleted
// h26-dispatch-overlap.mjs as a subprocess; see the PIN 4a/4b/PIN 5 removal
// note above.

// ===========================================================================
// STOP-BIND / receipt-promotion suite REMOVED (decision
// `sterling-claude-code-scale-down-boundary`, 2ad87dd1). These tests pinned
// h22-dispatch-register.mjs's reviewer-territory-binding-at-Stop mechanism
// (promoteAtStop / sidecarForChildTranscript / findParentToolUseBlock /
// bindReviewerTerritoryAtStop) and the .sterling/review-ledger.json write it
// produced — that whole mechanism, and its owner module
// scripts/hooks/lib/review-ledger-entry.mjs, were deleted under that
// decision. The fixture helpers that existed only to serve those tests
// (registerEntry/ledgerPath/readLedger/writeChildTranscript/sidecarPathFor/
// writeSidecar/firstUserRecord/continuationRecord/taskBlockId/
// assertUnattributableStop) were deleted with them — grep confirms zero
// remaining callers in this file.
// ===========================================================================

