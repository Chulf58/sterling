// H22 STRUCTURED REVIEW TERRITORY — the declared-territory parser.
// Governing decision: knowledge_get foreign_8f137474
// (slug review-territory-structured-receipt-files, board 0770ca72).
//
// R1 PIN RE-CUT: this file's Start-time declaration-parsing contracts are
// KEPT WHOLE — lib/dispatch-prompt.mjs stays the declaration parser and every
// Start-side outcome pinned here still holds (marker wins over prose, explicit
// [] is a declaration, malformed falls back loudly, no existence filtering,
// path-shape validation). The only change is A6: the loud warning is now
// RENDERED through the shared errors module, so every arm below additionally
// requires a [snake_code] token on the emitted line.
//   A11 NAMES THE CODE: a declaration that is PRESENT but unparseable /
//   non-POSIX / non-array is `territory_declaration_malformed` (facts.line),
//   distinct from `territory_declaration_missing` (no line at all, pinned in
//   scripts/tests/h22-observed-territory.test.mjs). Both arms below assert the
//   exact token alongside the required FACT — the rejected declaration's own
//   text, echoed verbatim.
//   RETIRED (decision `sterling-claude-code-scale-down-boundary`, 2ad87dd1):
//   the SubagentStop reviewer-class ledger-promotion contracts (T5, T5b, T6a,
//   T6b) and their helpers (registerEntry/writeRegisterRaw/ledgerPath/
//   ledgerExists/readLedger) — the review-ledger receipt mechanism they pinned
//   is deleted. T5c (register-layer files_source, no ledger involved) and T7/
//   T7b (Start-side sibling isolation) are unaffected and survive.
//
// Spec under test (pinned from the decision record + the launching agent's
// contract, NOT inferred from scripts/hooks/h22-dispatch-register.mjs — that
// file was not read beyond what was already necessary to locate the existing
// H22 test harness pattern in scripts/tests/h22-dispatch-register.test.mjs
// and scripts/tests/h22-review-ledger.test.mjs, which this file's helpers
// mirror without modifying either):
//
//   1. A dispatch block prompt may carry a line
//      `REVIEW-TERRITORY: ["path/a.mjs", "path/b.mjs"]` (JSON array of
//      repo-relative POSIX paths; anchored at line start, case-sensitive).
//   2. When H22 attributes a block (any attribution mode) and that block's
//      prompt contains a REVIEW-TERRITORY line, the entry's files[] comes
//      ONLY from the parsed array — free-prose extraction over the same
//      prompt is NOT used. The entry gains files_source: "review-territory".
//   3. REVIEW-TERRITORY: [] is an explicit, valid empty declaration:
//      files: [] and files_source: "review-territory" (never conflated
//      with "no marker at all").
//   4. No marker: behaves exactly as today (free-prose extraction) and the
//      entry gains files_source: "free-prose-fallback".
//   5. A malformed declaration (unparseable JSON / non-array / non-string
//      elements) is NOT silently ignored: falls back to free-prose
//      extraction, files_source: "free-prose-fallback", PLUS a loud stderr
//      line naming the malformed declaration (H22 never denies).
//   6. No filesystem-existence filtering of declared paths.
//
// TODAY (pre-fix): h22-dispatch-register.mjs has no notion of
// REVIEW-TERRITORY at all. It extracts path-like tokens from the raw prompt
// text via a context-free regex (confirmed by scripts/tests/
// h22-dispatch-register.test.mjs's own fixtures) and writes no `files_source`
// field on any entry (confirmed by scripts/tests/h22-review-ledger.test.mjs's
// six-key ledger-entry pin, which does not include files_source). Because the
// regex scans the WHOLE prompt string with no awareness of the marker, it
// also matches path-like substrings sitting INSIDE a REVIEW-TERRITORY JSON
// array today — that is part of why several RED assertions below fail on the
// file LIST, not only on the new `files_source` field.
//
// CONTROL-FIRST DISCIPLINE: the CONTROL test is placed first and is the only
// test in this file expected to be GREEN against today's code — it proves
// the free-prose extraction pipeline itself is untouched, which is the
// necessary premise for every RED pin that follows (a pin that failed only
// because the base extraction broke would prove nothing about the new
// marker logic). It deliberately asserts nothing about `files_source` (that
// field does not exist today at all, so no assertion mentioning it could be
// green pre-fix); the fallback case's `files_source` labeling is pinned
// separately, RED, immediately after it.

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

// ---------------------------------------------------------------------------
// Shared harness (mirrors scripts/tests/h22-dispatch-register.test.mjs and
// scripts/tests/h22-review-ledger.test.mjs; reused, not modified).
// ---------------------------------------------------------------------------

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-territory-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [H22_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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

function writeParentTranscript(dir, lines, name = 'parent.jsonl') {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// ===========================================================================
// STATE-MACHINE RE-CUT (board 5445066b, decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution`,
// knowledge_get 7c515e52 — opened, not paraphrased).
//
// H22's SubagentStart no longer reads the parent transcript: it resolves ONE
// prompt from the per-dispatch state record (PreToolUse slot -> PostToolUse
// binding -> locked Start resolution) and parses that prompt alone with the
// SAME parseReviewTerritory (§3 keeps the parser authority in
// scripts/hooks/lib/dispatch-prompt.mjs — pinned in
// scripts/tests/dispatch-state-hooks.test.mjs DSH-10). EVERY marker-parsing
// assertion in this file is therefore UNCHANGED; only how the prompt arrives
// changed, so `singleDispatch(dir, prompt)` keeps its exact signature and
// every call site is byte-identical.
//
// The MULTI-BLOCK arms (T7/T7b) are re-cut, because "several blocks in one
// message" is no longer a thing a Start can see: each dispatch is its own
// record, and a Start either owns exactly one of them or is unattributable.
// ===========================================================================

let toolUseSeq = 0;
function preInput(dir, { prompt, subagent_type = 'coder', tool_use_id, session_id = 's1' }) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Task',
    tool_use_id: tool_use_id ?? `toolu_rt_${(toolUseSeq += 1)}`,
    tool_input: { subagent_type, prompt, description: 'a lane' },
    session_id,
    cwd: dir,
    transcript_path: join(dir, 't', 'parent.jsonl'),
    prompt_id: 'pr-1',
  };
}
function postInput(dir, { prompt, subagent_type = 'coder', tool_use_id, agentId, session_id = 's1' }) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Task',
    tool_use_id,
    tool_input: { subagent_type, prompt, description: 'a lane' },
    tool_response: {
      isAsync: true, status: 'async_launched', agentId, description: 'a lane',
      resolvedModel: 'claude-x', prompt, outputFile: join(dir, 'out.txt'), canReadOutputFile: true,
    },
    session_id,
    cwd: dir,
    transcript_path: join(dir, 't', 'parent.jsonl'),
    prompt_id: 'pr-1',
  };
}
/** Declare a dispatch by firing its real PreToolUse event. Returns the
 *  tool_use_id so a caller can bind it authoritatively with a Post. */
function stagePre(dir, args) {
  const input = preInput(dir, args);
  const r = runHook(input, dir);
  assert.notEqual(r.code, 2, `PreToolUse must never deny a dispatch: ${r.stderr}`);
  return input.tool_use_id;
}
function stagePost(dir, args) {
  const r = runHook(postInput(dir, args), dir);
  assert.notEqual(r.code, 2, `PostToolUse must never deny: ${r.stderr}`);
  return r;
}

// Signature preserved from the transcript era (see the RE-CUT note above):
// declares ONE pending dispatch of the type the following SubagentStart will
// carry (h22Input's default agent_type is 'coder'), so §5(iii) derivation is
// type-unique. A second call in the same project is safe because the first
// slot is consumed by its own Start.
function singleDispatch(dir, prompt, subagent_type = 'coder') {
  return stagePre(dir, { prompt, subagent_type });
}

function entryFor(dir, agentId) {
  const reg = readRegister(dir);
  const entry = reg.find((e) => e.agent_id === agentId);
  assert.ok(entry, `entry for ${agentId} was appended to the register`);
  return entry;
}

// ===========================================================================
// (T-CONTROL) CONTROL, PLACED FIRST: no marker at all — free-prose extraction
// over the whole prompt is completely unaffected by the new marker-parsing
// logic. Passes today for a DIFFERENT, simpler reason than every test below
// it: nothing here exercises REVIEW-TERRITORY parsing at all.
//
// EXPECTED STATE: GREEN today and after the fix.
// SABOTAGE THAT MUST NOT FLIP THIS RED: none — this is the regression net.
// But it DOES catch one dangerous class of bug on its own: an
// implementation that treats "no REVIEW-TERRITORY line found" as though it
// were "an empty declaration was found" (conflating absence with `[]`, the
// exact conflation item 3 warns against) would empty this entry's files to
// [] instead of leaving free-prose extraction alone — that single-line
// mistake (short-circuiting to files: [] whenever the marker regex fails to
// match, instead of falling through to the pre-existing extractor) is what
// this control would catch if introduced.
// ===========================================================================

test('(T-control) CONTROL: a block prompt with no REVIEW-TERRITORY marker still yields free-prose extraction, completely unaffected', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = 'Please review scripts/foo-review.mjs and note scripts/decoy-analysis.mjs was discussed earlier.';
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-control' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-control');
    assert.deepEqual(
      [...entry.files].sort(),
      ['scripts/decoy-analysis.mjs', 'scripts/foo-review.mjs'],
      'free-prose extraction over the whole prompt is unaffected when no marker is present'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T-control-fallback-source) contract item 4's other half: the no-marker
// case gains files_source: "free-prose-fallback" — a brand-new field, so
// this one CANNOT be green today (the field does not exist at all), unlike
// the control above which asserts only pre-existing behavior.
//
// EXPECTED RED today: `files_source` is undefined on today's entry. Fails at
// `assert.equal(entry.files_source, 'free-prose-fallback')`.
// SABOTAGE: after landing the fix, delete the `files_source: 'free-prose-fallback'`
// assignment on the no-marker branch (leave the field unset for that branch
// only) — flips this back to RED without touching the marker-present branches.
// ===========================================================================

test('(contract item 4) a no-marker prompt records files_source: "free-prose-fallback" (new field)', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'Please review scripts/foo-review.mjs, no special declaration here.');
    const r = runHook(h22Input(dir, { agent_id: 'agent-nomarker' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-nomarker');
    assert.equal(entry.files_source, 'free-prose-fallback');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T1) marker with two declared paths: files[] comes ONLY from the array; a
// decoy path present in the surrounding prose is ignored entirely.
//
// EXPECTED RED today: today's context-free regex scans the WHOLE prompt, so
// it matches the two declared paths (they are valid path-like substrings
// even inside JSON syntax) AND the decoy path in the trailing sentence,
// producing a THREE-element files list. Fails first at the `deepEqual`
// against the two-element expected list (three != two), and again at
// `entry.files_source` (undefined today).
// SABOTAGE: remove the "prefer REVIEW-TERRITORY over free-prose when a
// marker line is present" precedence check (always run free-prose
// extraction regardless of a marker) — the decoy path leaks back in and
// `!entry.files.includes('scripts/decoy-analysis.mjs')` goes false.
// ===========================================================================

test('(T1) marker with two declared paths: files[] is exactly those two; a decoy path in the surrounding prose is ignored', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = [
      'Please review the recent diff for correctness.',
      'REVIEW-TERRITORY: ["packages/mcp-server/src/auth.ts", "packages/schemas/src/auth.ts"]',
      'FYI scripts/decoy-analysis.mjs was mentioned in an earlier, unrelated message.',
    ].join('\n');
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-t1' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-t1');
    assert.deepEqual(
      [...entry.files].sort(),
      ['packages/mcp-server/src/auth.ts', 'packages/schemas/src/auth.ts'],
      'files[] comes only from the parsed REVIEW-TERRITORY array'
    );
    assert.ok(!entry.files.includes('scripts/decoy-analysis.mjs'), 'a decoy path in the surrounding prose is never included once a marker is present');
    assert.equal(entry.files_source, 'review-territory');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T2) marker with an explicit empty array: files: [] and
// files_source: "review-territory" — NOT conflated with "no marker at all"
// (which would fall back to free-prose and pick up the decoy path).
//
// EXPECTED RED today: today's regex still matches the decoy path in the
// trailing sentence, producing files: ['scripts/decoy-analysis.mjs'] instead
// of []. Fails at `assert.deepEqual(entry.files, [])`.
// SABOTAGE: treat `REVIEW-TERRITORY: []` as though the marker were
// absent/malformed and fall through to free-prose extraction instead of
// honoring the explicit empty declaration — this is exactly the test this
// pin exists to catch.
// ===========================================================================

test('(T2) marker with an explicit empty array is a valid declaration: files: [], files_source: "review-territory"', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = [
      'This is an audit-only pass; no specific files are pre-declared.',
      'REVIEW-TERRITORY: []',
      'scripts/decoy-analysis.mjs is referenced here for context only.',
    ].join('\n');
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-t2' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-t2');
    assert.deepEqual(entry.files, [], 'an explicit REVIEW-TERRITORY: [] is a deliberate empty declaration, not "no declaration"');
    assert.equal(entry.files_source, 'review-territory', 'the empty declaration still records provenance as review-territory, never free-prose-fallback');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T3) malformed declarations: unparseable JSON, valid-but-non-array JSON,
// and a valid array with a non-string element. All three must fall back to
// free-prose extraction (files_source: "free-prose-fallback") AND cause a
// loud stderr line naming the malformed declaration — H22 never denies, but
// it must never silently swallow a broken declaration either.
//
// EXPECTED RED today for all three variants: today's hook has no
// REVIEW-TERRITORY awareness at all, so `entry.files_source` is undefined
// (fails the equality assertion) and stderr is empty (fails both stderr
// `match` assertions). The `files.includes(decoy)` assertion is expected to
// already hold today (the decoy is picked up by the pre-existing regex
// regardless), so it is NOT the RED trigger — noted per-test below.
// SABOTAGE (shared): swallow the JSON.parse failure / skip the
// Array.isArray-and-every-element-is-a-string validation and silently treat
// the result as an empty review-territory declaration (files: [],
// files_source: 'review-territory') instead of falling back to free-prose
// with a warning — flips `files_source` back to 'review-territory' and
// removes the stderr warning, without changing the files LIST enough to be
// caught by casual inspection.
// ===========================================================================

// A6 + A11: the advisory is rendered through the shared errors module and
// carries the code A11 names for a PRESENT-but-unusable declaration.
// SABOTAGE: render this with `territory_declaration_missing` instead — both
// arms below go red, and the distinction between "nothing declared" and "a
// declaration this dispatch could not use" (which the operator must fix) is
// lost at the only surface that reports it.
const token = (c) => new RegExp('\\[' + c + '\\]');
const MALFORMED_CODE = token('territory_declaration_malformed');

function assertMalformedFallback(dir, agentId, prompt, decoyPath) {
  const r = runHook(h22Input(dir, { agent_id: agentId }), dir);
  assert.equal(r.code, 0, r.stderr, 'H22 never denies a spawn, even on a malformed declaration');
  const entry = entryFor(dir, agentId);
  assert.ok(entry.files.includes(decoyPath), 'fallback recovers the free-prose path when the declaration is unusable (expected to already hold today)');
  assert.equal(entry.files_source, 'free-prose-fallback', 'a malformed declaration is never silently treated as a valid review-territory declaration');
  assert.match(r.stderr, /REVIEW-TERRITORY/, 'the malformed declaration is named loudly on stderr, not silently swallowed');
  assert.match(r.stderr, MALFORMED_CODE, 'A11: a present-but-unusable declaration carries territory_declaration_malformed');
  return r;
}

test('(T3a) malformed: unparseable JSON falls back to free-prose extraction and warns loudly, naming the bad line', () => {
  const { dir, cleanup } = makeProject();
  try {
    const badLine = 'REVIEW-TERRITORY: [not-json';
    const prompt = ['Please review the changes below.', badLine, 'scripts/decoy-analysis.mjs is the actual file to review.'].join('\n');
    singleDispatch(dir, prompt);
    const r = assertMalformedFallback(dir, 'agent-t3a', prompt, 'scripts/decoy-analysis.mjs');
    assert.match(r.stderr, /\[not-json/, 'the warning names the actual malformed content, not a generic message');
  } finally {
    cleanup();
  }
});

test('(T3b) malformed: valid JSON that is not an array falls back to free-prose extraction and warns loudly', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = ['Please review the changes below.', 'REVIEW-TERRITORY: {"a": 1}', 'scripts/decoy-analysis.mjs is the actual file to review.'].join('\n');
    singleDispatch(dir, prompt);
    assertMalformedFallback(dir, 'agent-t3b', prompt, 'scripts/decoy-analysis.mjs');
  } finally {
    cleanup();
  }
});

test('(T3c) malformed: an array containing a non-string element falls back to free-prose extraction and warns loudly', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = ['Please review the changes below.', 'REVIEW-TERRITORY: ["scripts/ok.mjs", 42]', 'scripts/decoy-analysis.mjs is the actual file to review.'].join(
      '\n'
    );
    singleDispatch(dir, prompt);
    assertMalformedFallback(dir, 'agent-t3c', prompt, 'scripts/decoy-analysis.mjs');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T4) a declared REVIEW-TERRITORY path that does not exist anywhere on disk
// survives into files[] unchanged — no filesystem-existence filtering.
//
// EXPECTED RED today: the free-prose regex would ALSO happen to match this
// exact path-like substring inside the JSON array text, so `entry.files`
// today may coincidentally already equal the expected one-element array —
// that assertion is NOT what makes this test RED. The RED trigger is
// `entry.files_source`, which is undefined today (files_source does not
// exist as a field at all pre-fix).
// SABOTAGE: add an `fs.existsSync` filter after parsing the declared array
// that drops any path not present on disk — flips `entry.files` from
// `['scripts/this-file-does-not-exist-anywhere.mjs']` to `[]`.
// ===========================================================================

test('(T4) a declared path that does not exist on disk survives into files[] unchanged — no filesystem-existence filtering', () => {
  const { dir, cleanup } = makeProject();
  try {
    const declaredPath = 'scripts/this-file-does-not-exist-anywhere.mjs';
    assert.equal(existsSync(join(dir, declaredPath)), false, 'precondition: the declared path genuinely does not exist in this fixture project');
    const prompt = ['Please review the deleted/renamed file below.', `REVIEW-TERRITORY: ["${declaredPath}"]`].join('\n');
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-t4' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-t4');
    assert.deepEqual(entry.files, [declaredPath], 'a declared path with no existence check keeps a legitimately-reviewed deleted/renamed file reviewable');
    assert.equal(entry.files_source, 'review-territory');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// ===========================================================================
// (T5c) COMPANION ARM, re-homed from T5b (see T5b's comment above for why):
// T5b's proof that a promoted receipt's source value is COPIED from
// computed evidence rather than HARDCODED to a fixed literal is no longer
// constructible at the LEDGER PROMOTION layer for a non-reviewer type (that
// code path never runs for one). This arm re-homes the same proof to the
// SubagentStart REGISTER WRITE for a non-reviewer agent_type ('coder') — a
// layer the Stop-only, reviewer-only edbaa38d mechanism never touches at
// all. Two sibling dispatches, same agent_type, one with a valid
// REVIEW-TERRITORY marker and one with none: a hardcoded single-literal
// files_source would make BOTH entries read the same value; a genuine
// parse-and-record implementation makes them differ, each tracking its own
// input, exactly as T5/T5b's original pair intended one layer up.
//
// EXPECTED RED today: files_source does not exist as a field at all pre-fix
// (per this file's header TODAY note), so both entries' `files_source` read
// undefined — fails both equality assertions below.
// SABOTAGE: hardcode `files_source: 'review-territory'` (or any single fixed
// literal) in the SubagentStart entry-building code for every dispatch,
// regardless of whether a REVIEW-TERRITORY marker was actually parsed — the
// no-marker entry's assertion (`files_source === 'free-prose-fallback'`)
// goes red while the marker entry's assertion could coincidentally stay
// green, and the final `notEqual` also goes red.
// ===========================================================================

test('(T5c) companion to T5/T5b, re-homed to the register layer: a non-reviewer agent_type\'s files_source is genuinely computed, not hardcoded — a marker-declared dispatch and a marker-less sibling dispatch produce DIFFERING values that each track their own input', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'REVIEW-TERRITORY: ["packages/mcp-server/src/t5c-decl.ts"]\nFocus on the declared scope only.');
    const withMarker = runHook(h22Input(dir, { agent_id: 'agent-t5c-marker', agent_type: 'coder' }), dir);
    assert.equal(withMarker.code, 0, withMarker.stderr);
    const markerEntry = entryFor(dir, 'agent-t5c-marker');
    assert.equal(markerEntry.files_source, 'review-territory', 'a genuine marker parse yields review-territory');

    singleDispatch(dir, 'Please look at packages/mcp-server/src/t5c-prose.ts, no declaration here.');
    const withoutMarker = runHook(h22Input(dir, { agent_id: 'agent-t5c-noMarker', agent_type: 'coder' }), dir);
    assert.equal(withoutMarker.code, 0, withoutMarker.stderr);
    const noMarkerEntry = entryFor(dir, 'agent-t5c-noMarker');
    assert.equal(noMarkerEntry.files_source, 'free-prose-fallback', 'the absence of a marker yields free-prose-fallback');

    assert.notEqual(markerEntry.files_source, noMarkerEntry.files_source, 'the two sibling dispatches must differ — a hardcoded single literal could not produce this');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T7) RE-CUT — SIBLING ISOLATION. Two same-type dispatches are in flight; MY
// dispatch declares a valid REVIEW-TERRITORY, the SIBLING's prompt is plain
// prose naming another path. My Start is bound authoritatively by my own
// PostToolUse (tool_response.agentId — the measured seam, finding foreign_2bad782a),
// so §5(i) resolves my prompt and my prompt ONLY.
// The ASSERTIONS ARE PRESERVED from the multi-block original (files[] is
// exactly the declared array; the sibling's prose path never appears;
// files_source 'review-territory') — what changed is that the sibling's prose
// is now unreachable BY CONSTRUCTION rather than by a per-block override
// inside a union.
//
// EXPECTED RED today: no Pre/Post branches exist, so no state record is
// written; today's Start reads the parent transcript, which this fixture never
// plants. `entry.files` comes out [] and `entry.files_source` undefined —
// fails the deepEqual and the files_source equality.
// SABOTAGE: union the same-type candidates instead of resolving the bound one
// (the retired attribution:'union' path) — the sibling's prose path leaks back
// into entry.files and both the deepEqual and the !includes go red.
// SABOTAGE: ignore the Post binding and derive over the pending set — two
// candidates make the Start unattributable, so files:[] reddens the deepEqual
// instead. The two sabotages fail differently, so they are distinguishable.
// ===========================================================================

test('(T7) sibling isolation: my own dispatch declares REVIEW-TERRITORY while a same-type sibling is plain prose — files[] is exactly my declared array, sibling prose dropped', () => {
  const { dir, cleanup } = makeProject();
  try {
    const minePrompt = 'REVIEW-TERRITORY: ["packages/mcp-server/src/decl.ts"]\nPlease focus review on the declared scope only.';
    const mine = stagePre(dir, { prompt: minePrompt, subagent_type: 'coder' });
    stagePre(dir, { prompt: 'Also see scripts/sibling-prose.mjs for background context, no declaration here.', subagent_type: 'coder' });
    stagePost(dir, { tool_use_id: mine, prompt: minePrompt, subagent_type: 'coder', agentId: 'agent-t7' });

    const r = runHook(h22Input(dir, { agent_id: 'agent-t7', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-t7');
    assert.deepEqual(entry.files, ['packages/mcp-server/src/decl.ts'], 'files[] is exactly the declared array; the sibling dispatch\'s free-prose path is dropped entirely');
    assert.ok(!entry.files.includes('scripts/sibling-prose.mjs'), 'the marker-less sibling dispatch never contributes a free-prose path — its prompt is not mine and is never parsed');
    assert.equal(entry.files_source, 'review-territory');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (T7b) RE-CUT — A SIBLING'S MALFORMED DECLARATION IS NOT MY WARNING. The old
// pin required EXACTLY ONE stderr warning for a malformed SIBLING block,
// because a union parsed every same-type block in the message. Under
// 7c515e52 §3 a consumer parses THE RESOLVED PROMPT ALONE, so a sibling's
// malformed marker is not merely deduplicated — it is NEVER SEEN. The pin is
// therefore inverted deliberately, and stated as such rather than deleted:
// ZERO occurrences of the sibling's malformed content, and my own valid
// declaration still wins.
// Its counter-arm — a malformed declaration in MY OWN prompt still warns
// exactly as today — is (T3a) above, unchanged; without that arm this zero
// assertion would be satisfiable by deleting the malformed warning entirely.
//
// EXPECTED RED today: today's Start reads the (absent) transcript, so
// `entry.files` is [] and `entry.files_source` undefined — fails the
// deepEqual and the files_source equality. The zero-occurrence assertion
// happens to hold today for the wrong reason (nothing is parsed at all),
// which is exactly why (T3a) is named as its counter-arm.
// SABOTAGE: parse any prompt other than the resolved one (a union, or a scan
// of every pending record) — the occurrences assertion goes red at 1 while
// (T3a) stays green.
// ===========================================================================

test('(T7b) sibling isolation: a same-type sibling\'s MALFORMED declaration produces no warning on my Start — only the resolved prompt is parsed, and my valid declaration wins', () => {
  const { dir, cleanup } = makeProject();
  try {
    const minePrompt = 'REVIEW-TERRITORY: ["packages/mcp-server/src/decl.ts"]\nFocus on the declared scope.';
    const mine = stagePre(dir, { prompt: minePrompt, subagent_type: 'coder' });
    stagePre(dir, { prompt: 'REVIEW-TERRITORY: [not-json\nAlso scripts/sibling-malformed.mjs is unrelated context.', subagent_type: 'coder' });
    stagePost(dir, { tool_use_id: mine, prompt: minePrompt, subagent_type: 'coder', agentId: 'agent-t7b' });

    const r = runHook(h22Input(dir, { agent_id: 'agent-t7b', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr, 'H22 never denies a spawn, even with a malformed sibling declaration');
    const entry = entryFor(dir, 'agent-t7b');
    assert.deepEqual(entry.files, ['packages/mcp-server/src/decl.ts'], 'my valid declared array is what lands');
    assert.ok(!entry.files.includes('scripts/sibling-malformed.mjs'), 'the malformed sibling never contributes a free-prose fallback path');
    assert.equal(entry.files_source, 'review-territory');
    const occurrences = (r.stderr.match(/\[not-json/g) || []).length;
    assert.equal(occurrences, 0, "a SIBLING's malformed declaration is not my warning — a consumer parses the resolved prompt alone (§3); its counter-arm is (T3a), where MY OWN malformed marker still warns");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P-path-shape) a declared path that is NOT repo-relative POSIX shape
// (parent traversal, absolute, backslash-separated — or, since round 4 of
// board 7632586d, a glob element: variant d below carries its own comment
// and its own sabotage, distinct from the shared one described here) is
// MALFORMED, not a
// valid declaration: falls back to free-prose extraction, files_source:
// "free-prose-fallback", plus a loud stderr warning — NEVER an authoritative
// files[] rewrite with files_source: "review-territory". This targets a
// specific implementation gap: JSON.parse succeeding + every element being a
// string is NOT sufficient validation — each string must also be checked for
// path shape.
//
// EXPECTED RED today (all three variants): `files_source` does not exist as
// a field at all pre-fix, so `entry.files_source` is undefined — fails the
// `assert.equal(entry.files_source, 'free-prose-fallback')` assertion. The
// decoy-inclusion assertion is expected to already hold today (the decoy
// sentence is picked up by the pre-existing regex regardless), so it is NOT
// the RED trigger. The stderr `match` assertion also fails today (nothing is
// emitted).
// SABOTAGE (shared across all three): after JSON.parse succeeds and every
// element is confirmed a string, skip validating each string's PATH SHAPE
// (no '..' traversal segment, no leading '/', no backslash) — the malformed
// path is accepted as a legitimate declaration, producing
// files_source: 'review-territory' with the bad path echoed into files[]
// instead of falling back with a warning.
// ===========================================================================

function assertPathShapeRejected(dir, agentId, badPath) {
  const prompt = ['Please review the diff below.', `REVIEW-TERRITORY: ["${badPath}"]`, 'scripts/decoy-analysis.mjs is the actual file to review.'].join('\n');
  singleDispatch(dir, prompt);
  const r = runHook(h22Input(dir, { agent_id: agentId }), dir);
  assert.equal(r.code, 0, r.stderr, 'H22 never denies a spawn, even on a path-shape-invalid declaration');
  const entry = entryFor(dir, agentId);
  assert.ok(entry.files.includes('scripts/decoy-analysis.mjs'), 'fallback recovers the free-prose path when the declared path shape is invalid');
  assert.equal(entry.files_source, 'free-prose-fallback', 'a path-shape-invalid declaration is never treated as authoritative review-territory');
  assert.match(r.stderr, /REVIEW-TERRITORY/, 'the rejected declaration is named loudly on stderr, not silently accepted');
  assert.match(r.stderr, MALFORMED_CODE, 'A11: a present-but-unusable declaration carries territory_declaration_malformed');
  return r;
}

test('(P-path-shape-a) REVIEW-TERRITORY with a parent-traversal path ("../outside.mjs") is malformed — free-prose fallback, loud warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = assertPathShapeRejected(dir, 'agent-path-a', '../outside.mjs');
    assert.match(r.stderr, /\.\.\/outside\.mjs/, 'the warning names the actual rejected path');
  } finally {
    cleanup();
  }
});

test('(P-path-shape-b) REVIEW-TERRITORY with an absolute path ("/absolute/outside.mjs") is malformed — free-prose fallback, loud warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertPathShapeRejected(dir, 'agent-path-b', '/absolute/outside.mjs');
  } finally {
    cleanup();
  }
});

test('(P-path-shape-c) REVIEW-TERRITORY with a backslash-separated path ("scripts\\\\hooks\\\\outside.mjs") is malformed — free-prose fallback, loud warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertPathShapeRejected(dir, 'agent-path-c', 'scripts\\\\hooks\\\\outside.mjs');
  } finally {
    cleanup();
  }
});

// (P-path-shape-d) A glob token is a PATTERN, not a path — the convention
// (decision review-territory-structured-receipt-files) says "paths naming
// exactly the files". A glob element accepted as declared territory would let
// H26 clear a live entry's claimed_glob_prefixes while its files[] silently
// carries the un-expandable pattern (Codex re-review Medium, board 7632586d,
// thread 01a05b8c). SABOTAGE: remove the GLOB_METACHAR_RE rejection from
// isRepoRelativePosixShape — the glob is accepted as review-territory and
// this pin's files_source assertion goes red.
test('(P-path-shape-d) REVIEW-TERRITORY with a glob element ("src/**") is malformed — free-prose fallback, loud warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    assertPathShapeRejected(dir, 'agent-path-d', 'src/**');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P-newline-marker) the marker is anchored at line start AND requires the
// JSON array on the SAME line (per contract item 1: `REVIEW-TERRITORY: [...]`
// is one line). "REVIEW-TERRITORY:" followed by a newline and the array on
// the NEXT line is therefore NOT a declaration at all — it behaves as
// no-marker: free-prose extraction, files_source: "free-prose-fallback".
// Per the current contract reading, this should ALSO never be treated as
// "malformed" (no warning) — it simply never matched the marker shape in the
// first place, unlike (P-path-shape) or (T3) where a marker line WAS
// recognized and then rejected. Pinned as written; if a landed
// implementation instead warns here, that is a genuine reportable divergence
// from this reading, not a reason to weaken this assertion.
//
// EXPECTED RED today: `entry.files_source` is undefined (the field does not
// exist pre-fix) — fails `assert.equal(entry.files_source, 'free-prose-fallback')`.
// The files-list assertion is expected to already hold BOTH today and after
// the fix (free-prose extraction is unaffected either way, since no
// same-line marker exists to intercept it) — it is a regression net nested
// inside a RED pin, not itself the RED trigger. The no-warning assertion is
// expected to hold after a correct fix; if it fails, that failure IS the
// signal to report the divergence.
// SABOTAGE: loosen the marker-matching regex to span across a newline (e.g.
// match "REVIEW-TERRITORY:" followed by optional whitespace/newlines then
// the array on a LATER line) instead of requiring the array on the same
// line — flips `entry.files` to the single declared path and
// `entry.files_source` to 'review-territory', failing both assertions that
// currently expect the unaffected free-prose union.
// ===========================================================================

test('(P-newline-marker) "REVIEW-TERRITORY:" with the array on the NEXT line is not a declaration — behaves as no-marker (free-prose fallback, ideally no warning)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = [
      'Please review the diff below.',
      'REVIEW-TERRITORY:',
      '["packages/mcp-server/src/newline.ts"]',
      'scripts/decoy-analysis.mjs is mentioned here for context.',
    ].join('\n');
    singleDispatch(dir, prompt);
    const r = runHook(h22Input(dir, { agent_id: 'agent-newline' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-newline');
    assert.deepEqual(
      [...entry.files].sort(),
      ['packages/mcp-server/src/newline.ts', 'scripts/decoy-analysis.mjs'],
      'free-prose extraction over the whole prompt is unaffected — the split-line marker never intercepts it'
    );
    assert.equal(entry.files_source, 'free-prose-fallback', 'a marker split across lines is not a declaration at all — it is the ordinary no-marker case');
    assert.doesNotMatch(r.stderr, /REVIEW-TERRITORY/, 'per the current contract reading this is not a recognized-then-rejected marker, so no warning should fire — a failure here is a reportable divergence, not a reason to weaken this assertion');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DISCLOSED AS UNPINNED — multiple REVIEW-TERRITORY lines within a SINGLE
// block's prompt (e.g. two separate `REVIEW-TERRITORY: [...]` lines in one
// dispatch prompt). Requested precedence to pin: "first marker wins".
// NOT PINNED: the governing contract (decision foreign_8f137474, items 1-7, and the
// launching brief's 7-item list) never specifies a precedence rule for two
// marker lines in one prompt — it describes exactly one marker per block
// throughout. Pinning "first wins" (or "last wins") here would fabricate a
// behavior the spec never authorized, which this role's anti-invention
// constraint forbids. This is left for a follow-up decision record naming
// the intended precedence before it is pinned.
// ===========================================================================
