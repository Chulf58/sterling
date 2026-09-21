// H22 TERRITORY-EVIDENCE — observed tool paths as CORROBORATION.
// Governing decision: knowledge_get foreign_9500cce1
// (slug review-territory-observed-evidence) — confirmed LIVE as of the
// amendment below (it did not exist at this file's first draft).
//
// R1 PIN RE-CUT: this file is KEPT WHOLE. The contract sheet carries
// observed_files / observed_reads / observed_source / observed_truncated
// forward unchanged (§1.2, "as today"), including the null-vs-empty tri-state
// this file IS the test base for, and it does not rebuild
// scripts/hooks/lib/observed-territory.mjs. The round-scoped
// observedToolPathsSince pins (PART 4) are likewise KEPT: the refresh path
// they were first written for is retired by A4, but round-scoping becomes MORE
// load-bearing under it, not less — round n+1 has its own receipt derived from
// the SAME child transcript, so a round-2 receipt that counted round 1's reads
// as its own would be exactly the false corroboration this file guards.
//   RETIRED: nothing in this file.
//   A11 NAMES THE CODE: PART 2's missing-declaration warning is
//   `territory_declaration_missing` (H22 Start advisory), now a CODES member,
//   so the positive arms assert that exact token. The negative arms keep the
//   content discriminator alone, because "no warning fired" cannot be
//   distinguished from "some other coded advisory fired" by a token alone.
//
// SPEC CORRECTION (post-first-draft amendment, verified against
// research_finding foreign_20b44518, a byte-exact live
// stdin probe): at SubagentStop, stdin.transcript_path is the PARENT
// (conductor) transcript, NOT the departing subagent's own transcript as
// this file's first draft assumed. The departing subagent's OWN transcript
// arrives at stdin.agent_transcript_path instead. The decision's contract
// sentence ("the departing subagent's OWN transcript") is unchanged — only
// the STDIN FIELD carrying it was wrong in the original brief. PART 3 below
// is corrected accordingly: every SubagentStop fixture now supplies the real
// (agent) transcript via agent_transcript_path and a separate, DECOY-bearing
// transcript via transcript_path, so a test that reads the wrong field is
// caught by construction (the decoy's paths must never surface).
//
// H4 BLINDNESS HONORED: scripts/hooks/h22-dispatch-register.mjs and
// scripts/hooks/lib/* (including the not-yet-created
// scripts/hooks/lib/observed-territory.mjs) were never opened. This file's
// harness idioms (spawnSync + JSON stdin, register/ledger path+read+write
// helpers, the taskLine/taskBlock/writeParentTranscript fixtures, the
// makeProject SterlingStore convention) are adapted, without importing or
// modifying, from scripts/tests/h22-review-territory.test.mjs and
// scripts/tests/h22-ledger-v2-entry.test.mjs (both confirmed to exist via
// Read before writing this file).
//
// ===========================================================================
// SPEC UNDER TEST (three parts, given by the launching agent):
//
// PART 1 — new lib module scripts/hooks/lib/observed-territory.mjs exporting
// observedToolPaths(transcriptPath, cwd) -> {reads:string[], writes:string[]}
// or null. Reads tool_use blocks from a JSONL transcript's assistant lines;
// writes come from Edit/Write/NotebookEdit (input.file_path or
// input.notebook_path); reads come from Read (input.file_path), Grep
// (input.path, only when it is a FILE path), Glob (input.path, unconditional
// — no file-vs-directory qualifier). Paths are normalized repo-relative POSIX
// against cwd, deduped, and paths under .git/ or .sterling/ dropped. Degrades
// to null on missing/empty transcriptPath, nonexistent file, or
// unreadable/empty file. Malformed JSONL lines are skipped, not fatal. Zero
// tool_use blocks -> {reads:[],writes:[]} (observed-nothing, NOT null).
//
// PART 2 — H22 SubagentStart: agent_type starting with 'reviewer-' and no
// attributed block carrying a VALID REVIEW-TERRITORY line (per the
// already-shipped decision foreign_8f137474 semantics: parsed, path-shape-valid,
// including the explicit-empty-array case) gets a loud stderr warning naming
// REVIEW-TERRITORY plus an absence indicator. Exit stays 0. A valid
// declaration, or a non-reviewer agent_type, produces no such warning.
//
// PART 3 — H22 SubagentStop: a reviewer-class ledger promotion additionally
// carries observed_files (union of reads+writes from
// observedToolPaths(stdin.agent_transcript_path, cwd) — CORRECTED field,
// see SPEC CORRECTION above; stdin.transcript_path at Stop is the PARENT
// transcript and must never be read for this purpose) and
// observed_source:'subagent-transcript'. An unreadable/missing/absent
// agent_transcript_path leaves the field ABSENT (not []) — NEVER a fallback
// to the parent transcript's content, which would be false corroboration by
// definition. Promotion still succeeds either way. Observed evidence never
// alters files/files_source. A departing transcript larger than the lib's
// 1MB tail window additionally promotes observed_truncated:true (top-level,
// sibling of observed_files); an untruncated transcript carries no such key.
//
// ===========================================================================
// AMBIGUITY DISCLOSED, RESOLVED BY A STATED READING (not silently invented):
//
//   (a) "Grep (input.path when it is a file path)" — read as: input.path
//       contains a file extension (a '.' segment after the final '/'). A
//       path with no such segment (directory-shaped, e.g. "src") is NOT a
//       file path and contributes nothing from Grep specifically — but the
//       SAME directory-shaped string DOES count when it is Glob's
//       input.path, since Glob carries no such qualifier in the brief. This
//       is the one deliberate behavioral difference pinned between the two
//       tools (P1-grep-dir-excluded vs P1-glob-dir-included below).
//   (b) observed_files / observed_source are read as TOP-LEVEL fields on the
//       promoted ledger entry — the brief says "the ledger entry
//       additionally carries observed_files", not "territory.observed_files"
//       — even though the shipped v2 shape nests the sibling declared-files
//       fields under `territory`. Flagged as the most likely point of
//       divergence: if a landed implementation nests these under `territory`
//       instead, that is a genuine reportable divergence from this reading,
//       not a reason to weaken the assertions below.
//   (c) "no attributed dispatch block carries a valid REVIEW-TERRITORY line"
//       is read to include BOTH the no-marker-at-all case AND the
//       marker-present-but-malformed case (decision foreign_8f137474's own
//       free-prose-fallback outcome) — both are "no valid declaration".
//   (d) The stderr warning's exact wording is free (per the brief); the
//       assertion helper below requires the literal substring
//       'REVIEW-TERRITORY' PLUS a nearby absence word ("no"/"missing"/
//       "without"), designed to avoid false-matching decision foreign_8f137474's
//       PRE-EXISTING malformed-declaration warning (which names the bad
//       content, not an absence). CORRECTED (review finding, hollow pin):
//       the absence-word alternation is now WORD-BOUNDARY ANCHORED
//       (\b(no|missing|without)\b) — the unanchored form matched the
//       substring "no" inside "ignored" (as in "...decoy path is IGNORed
//       once a marker is present"-style wording that a malformed-only
//       warning could legitimately use), which let (P2-malformed-marker)
//       survive its own sabotage. \b closes that false match.
//   (e) TRUNCATION REPRESENTATION CHOICE (new, per this amendment): the lib
//       return shape extends the existing null-vs-{reads,writes} contract by
//       ADDING A THIRD PROPERTY ONLY WHEN TRUE — {reads,writes} unchanged
//       for an untruncated transcript (no third key at all, so every
//       pre-existing PART 1 assertion that does `assert.deepEqual(result,
//       {reads:[...],writes:[...]})` or reads only `.reads`/`.writes` stays
//       valid unmodified), and {reads,writes,truncated:true} when the 1MB
//       tail window was exhausted. This mirrors the SAME
//       absent-unless-true convention the brief already specifies for the
//       ledger entry's observed_truncated field, so the lib and the H22
//       write side agree on one convention rather than two. Chosen over a
//       always-present `truncated:false/true` because that would force every
//       existing exact-shape PART 1 assertion above to be rewritten to
//       tolerate the new key — a needless widening of this amendment's
//       blast radius.
// ===========================================================================

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');
const LIB_PATH = join(HOOKS, 'lib', 'observed-territory.mjs');

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ---------------------------------------------------------------------------
// Shared harness — mirrors scripts/tests/h22-review-territory.test.mjs /
// scripts/tests/h22-ledger-v2-entry.test.mjs; reused, not modified.
// ---------------------------------------------------------------------------

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-observed-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

// Lighter, storeless temp dir — used by PART 1 (direct lib import, no hook
// spawn), which needs only a filesystem to hold transcript/target files.
function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h22-observed-lib-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}
function ledgerPath(dir) {
  return join(dir, '.sterling', 'review-ledger.json');
}
function readLedger(dir) {
  return JSON.parse(readFileSync(ledgerPath(dir), 'utf8'));
}

// Dual-shape lookup: the shipped ledger shape may be the v1 flat six-key
// entry or the v2 nested envelope (decision foreign_57984926) depending on what has
// landed ahead of this slice — mirrors the same dual-shape convention used by
// scripts/tests/h22-review-territory.test.mjs (T5/T5b) and
// scripts/tests/h22-ledger-v2-entry.test.mjs (findEntryByFile) for exactly
// this reason.
function declaredFiles(entry) {
  return entry.territory?.files ?? entry.files;
}
function declaredSource(entry) {
  return entry.territory?.source ?? entry.files_source;
}
function findEntryByDeclaredFile(ledger, file) {
  return ledger.find((e) => {
    const files = declaredFiles(e);
    return Array.isArray(files) && files.includes(file);
  });
}

const taskLine = (blocks) => ({ type: 'assistant', message: { content: blocks } });
const taskBlock = (name, prompt) => ({ type: 'tool_use', name, input: { prompt } });
function writeParentTranscript(dir, lines, name = 'parent.jsonl') {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
// ===========================================================================
// STATE-MACHINE RE-CUT (board 5445066b, decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution`,
// knowledge_get 7c515e52 — opened, not paraphrased): at SubagentStart H22
// resolves ONE prompt from the per-dispatch state record written at
// PreToolUse, and never reads the parent transcript. PART 2's declaration
// warning is computed from THAT prompt, so every PART 2 assertion below is
// UNCHANGED and only the fixture changed: singleDispatch() now fires the real
// PreToolUse event, and its `subagent_type` must match the Start's agent_type
// (§5(iii) derivation is exact by construction over the type).
// PART 3 (SubagentStop / observed evidence) is untouched by the decision — it
// reads stdin.agent_transcript_path, seeds the register directly, and keeps
// planting transcripts.
// ===========================================================================
let toolUseSeq = 0;
function singleDispatch(dir, prompt, subagent_type = 'coder') {
  const tool_use_id = `toolu_obs_${(toolUseSeq += 1)}`;
  const r = runHook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id,
      tool_input: { subagent_type, prompt, description: 'a lane' },
      session_id: 's1',
      cwd: dir,
      transcript_path: join(dir, 't', 'parent.jsonl'),
      prompt_id: 'pr-1',
    },
    dir
  );
  assert.notEqual(r.code, 2, `PreToolUse must never deny a dispatch: ${r.stderr}`);
  return tool_use_id;
}
// The Start's transcript_path deliberately points at a file that does not
// exist: correct under the new contract, and a pin that no transcript is read.
function startInput(dir, over = {}) {
  return h22Input(dir, { transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'), ...over });
}

const registerEntry = (over = {}) => ({
  agent_id: 'rev-1',
  agent_type: 'reviewer-correctness',
  session_id: 's1',
  files: [],
  at: new Date().toISOString(),
  ...over,
});

// Absence indicator required alongside the literal 'REVIEW-TERRITORY'
// substring — designed per ambiguity (d) above to avoid matching decision
// 8f137474's pre-existing malformed-content warning.
// CORRECTED (review finding, hollow pin — see ambiguity (d) above): anchored
// with \b so the alternation matches only a genuine standalone "no"/
// "missing"/"without" word, never a substring occurrence inside an unrelated
// word (the unanchored form matched "no" inside "ignored", letting
// (P2-malformed-marker) pass even with no real absence warning present).
const ABSENCE_INDICATOR_RE = /\b(no|missing|without)\b[^\n]{0,80}REVIEW-TERRITORY|REVIEW-TERRITORY[^\n]{0,80}\b(no|missing|without)\b/is;

// A6 + A11: this advisory is rendered through the shared errors module and
// carries exactly the code A11 names for it.
// SABOTAGE: emit this warning as a bare console.error string, or render it
// with `territory_declaration_malformed` (the sibling code for a line that IS
// present but unparseable) — the token assertion goes red while the content
// discriminator stays green, which is the confusion the two codes exist to
// keep apart: nothing declared vs something declared badly.
const token = (c) => new RegExp('\\[' + c + '\\]');

function assertNoDeclarationWarning(stderr) {
  assert.match(stderr, /REVIEW-TERRITORY/, 'stderr names REVIEW-TERRITORY');
  assert.match(
    stderr,
    ABSENCE_INDICATOR_RE,
    'stderr carries a standalone absence indicator ("no"/"missing"/"without") near the REVIEW-TERRITORY marker'
  );
  assert.match(stderr, token('territory_declaration_missing'), 'A11: the missing-declaration advisory carries its own code — not the malformed-declaration one');
}
function assertNoWarningAtAll(stderr) {
  assert.doesNotMatch(stderr, ABSENCE_INDICATOR_RE, 'no absence-declaration warning fires');
}

// ===========================================================================
// PART 1 — scripts/hooks/lib/observed-territory.mjs :: observedToolPaths()
// ===========================================================================

let observedToolPaths;
let observedToolPathsSince;
let importError = null;
before(async () => {
  try {
    ({ observedToolPaths, observedToolPathsSince } = await import(pathToFileURL(LIB_PATH).href));
  } catch (e) {
    importError = e;
  }
});

function requireLib() {
  if (importError || typeof observedToolPaths !== 'function') {
    assert.fail(
      `scripts/hooks/lib/observed-territory.mjs must export observedToolPaths(); import failed or the export is missing: ${importError?.message ?? 'observedToolPaths is not a function'}`
    );
  }
}

// (board 181d11e7 / brief item (a)) observedToolPathsSince is a NEW,
// separate export added alongside the pre-existing observedToolPaths — its
// own missing-export check, kept distinct from requireLib() so a PART 4
// failure never masquerades as a PART 1 failure or vice versa.
function requireSinceLib() {
  if (importError || typeof observedToolPathsSince !== 'function') {
    assert.fail(
      `scripts/hooks/lib/observed-territory.mjs must export observedToolPathsSince(); import failed or the export is missing: ${importError?.message ?? 'observedToolPathsSince is not a function'}`
    );
  }
}

function writeToolTranscript(dir, lines, name = 'transcript.jsonl') {
  const p = join(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  writeFileSync(p, body);
  return p;
}

const toolLine = (blocks) => ({ type: 'assistant', message: { content: blocks } });
const toolUse = (name, input) => ({ type: 'tool_use', name, input });
const textBlock = (text) => ({ type: 'text', text });

// ---------------------------------------------------------------------------
// (P1-CONTROL) A rich, realistic mixed transcript is genuinely extracted and
// classified — the load-bearing base case every other PART-1 test assumes.
// Placed FIRST as the control arm: distinguishes "genuinely computed from the
// transcript" from a stub that always returns the same fixed shape, which the
// later null/{[],[]}/dedup pins alone could not rule out.
//
// EXPECTED RED today: the import in `before()` throws (module does not
// exist), so `requireLib()` fails every test in this section with the same
// root cause — that IS today's correct failure shape for a not-yet-created
// module.
// SABOTAGE (once landed): hardcode the returned {reads,writes} arrays instead
// of deriving them from the transcript (e.g. always return the fixture's
// expected shape) — undetectable by THIS test alone, but the P1-zero-blocks
// and P1-degrade-* tests below use DIFFERENT input and would immediately
// diverge from a hardcoded stub, which is why they exist as a set.
// ===========================================================================

test('(P1-CONTROL) a mixed transcript classifies Read/Grep(file)/Glob into reads and Edit/Write/NotebookEdit into writes, ignoring noise', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [
      toolLine([toolUse('Read', { file_path: join(dir, 'src/read-me.mjs') })]),
      toolLine([textBlock('noise'), toolUse('Grep', { pattern: 'foo', path: join(dir, 'src/grep-file.mjs') })]),
      toolLine([toolUse('Glob', { path: join(dir, 'src') })]),
      toolLine([toolUse('Edit', { file_path: join(dir, 'src/edit-me.mjs') })]),
      toolLine([toolUse('Write', { file_path: join(dir, 'src/write-me.mjs') })]),
      toolLine([toolUse('NotebookEdit', { notebook_path: join(dir, 'notebooks/nb.ipynb') })]),
      toolLine([toolUse('Bash', { command: 'ls' })]),
    ]);
    const result = observedToolPaths(t, dir);
    assert.ok(result, 'a well-formed transcript with real tool_use blocks never degrades to null');
    assert.deepEqual([...result.reads].sort(), ['src', 'src/grep-file.mjs', 'src/read-me.mjs']);
    assert.deepEqual([...result.writes].sort(), ['notebooks/nb.ipynb', 'src/edit-me.mjs', 'src/write-me.mjs']);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P1-degrade-*) null-degradation set. Paired deliberately against
// P1-zero-blocks below: these prove "could not observe" while
// P1-zero-blocks proves "observed and found nothing" — a stub collapsing
// the two states to the same value fails whichever half it didn't hardcode.
// EXPECTED RED today: same import failure as P1-CONTROL.
// ===========================================================================

test('(P1-degrade-missing) an undefined transcriptPath returns null', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    assert.equal(observedToolPaths(undefined, dir), null);
  } finally {
    cleanup();
  }
});

test('(P1-degrade-empty-string) an empty-string transcriptPath returns null', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    assert.equal(observedToolPaths('', dir), null);
  } finally {
    cleanup();
  }
});

test('(P1-degrade-nonexistent) a transcriptPath pointing at a nonexistent file returns null', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    assert.equal(observedToolPaths(join(dir, 'does-not-exist.jsonl'), dir), null);
  } finally {
    cleanup();
  }
});

test('(P1-degrade-empty-file) a zero-byte transcript file returns null', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const p = join(dir, 'empty.jsonl');
    writeFileSync(p, '');
    assert.equal(observedToolPaths(p, dir), null);
  } finally {
    cleanup();
  }
});

test(
  '(P1-degrade-unreadable) a permission-denied transcript file returns null',
  { skip: IS_ROOT ? 'running as root — chmod 0o000 does not block root reads' : false },
  () => {
    requireLib();
    const { dir, cleanup } = makeScratch();
    const p = join(dir, 'unreadable.jsonl');
    try {
      writeFileSync(p, JSON.stringify(toolLine([toolUse('Read', { file_path: join(dir, 'x.mjs') })])) + '\n');
      chmodSync(p, 0o000);
      assert.equal(observedToolPaths(p, dir), null);
    } finally {
      try {
        chmodSync(p, 0o644);
      } catch {
        // already gone or already writable
      }
      cleanup();
    }
  }
);

// ===========================================================================
// (P1-zero-blocks) the distinguishing companion to P1-degrade-*: a
// perfectly READABLE transcript containing assistant content but zero
// tool_use blocks is "observed nothing", never "could not observe".
// SABOTAGE: treat "no tool_use blocks found" as though parsing failed and
// return null instead of {reads:[],writes:[]} — this test alone catches
// that conflation, while every P1-degrade-* test above stays green (a real
// null there is still correct).
// ===========================================================================

test('(P1-zero-blocks) a readable transcript with only text content (no tool_use blocks) returns {reads:[],writes:[]}, never null', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [toolLine([textBlock('just talking, no tools')]), toolLine([textBlock('still no tools')])]);
    const result = observedToolPaths(t, dir);
    assert.notEqual(result, null, 'a readable transcript with zero tool_use blocks is "observed nothing", not "could not observe"');
    assert.deepEqual(result, { reads: [], writes: [] });
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P1-malformed-line) one corrupt JSONL line among otherwise well-formed
// lines is skipped, not fatal — the well-formed lines are still processed.
// SABOTAGE: let a single JSON.parse throw abort the whole read (return null
// on the first bad line) instead of skipping just that line — this test
// alone catches it; P1-CONTROL (no malformed lines) stays green regardless.
// ===========================================================================

test('(P1-malformed-line) a corrupt JSONL line is skipped without aborting extraction of the surrounding valid lines', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const p = join(dir, 'transcript.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    const lines = [
      JSON.stringify(toolLine([toolUse('Read', { file_path: join(dir, 'before-bad.mjs') })])),
      '{this is not valid json at all',
      JSON.stringify(toolLine([toolUse('Edit', { file_path: join(dir, 'after-bad.mjs') })])),
    ];
    writeFileSync(p, lines.join('\n') + '\n');
    const result = observedToolPaths(p, dir);
    assert.notEqual(result, null, 'a malformed line does not degrade the whole read to null');
    assert.deepEqual(result.reads, ['before-bad.mjs']);
    assert.deepEqual(result.writes, ['after-bad.mjs']);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P1-normalize-*) POSIX repo-relative normalization against cwd.
// ===========================================================================

test('(P1-normalize-absolute-under-cwd) an absolute path under cwd becomes repo-relative POSIX', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [toolLine([toolUse('Read', { file_path: join(dir, 'sub', 'nested', 'file.mjs') })])]);
    const result = observedToolPaths(t, dir);
    assert.deepEqual(result.reads, ['sub/nested/file.mjs']);
  } finally {
    cleanup();
  }
});

test('(P1-normalize-outside-cwd-dropped) an absolute path outside cwd is dropped entirely', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [
      toolLine([toolUse('Read', { file_path: '/etc/hostname' })]),
      toolLine([toolUse('Read', { file_path: join(dir, 'inside.mjs') })]),
    ]);
    const result = observedToolPaths(t, dir);
    assert.deepEqual(result.reads, ['inside.mjs'], 'the outside-cwd path contributes nothing; the inside-cwd sibling still does');
  } finally {
    cleanup();
  }
});

test('(P1-normalize-relative-passthrough) an already-relative path is used as-is (normalization against cwd is a no-op)', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [toolLine([toolUse('Grep', { pattern: 'x', path: 'src/relative-grep.mjs' })])]);
    const result = observedToolPaths(t, dir);
    assert.deepEqual(result.reads, ['src/relative-grep.mjs']);
  } finally {
    cleanup();
  }
});

test('(P1-dedup) the same path observed twice within one category appears once', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [
      toolLine([toolUse('Read', { file_path: join(dir, 'dup.mjs') })]),
      toolLine([toolUse('Read', { file_path: join(dir, 'dup.mjs') })]),
    ]);
    const result = observedToolPaths(t, dir);
    assert.deepEqual(result.reads, ['dup.mjs']);
  } finally {
    cleanup();
  }
});

test('(P1-drop-git-sterling) paths under .git/ or .sterling/ are dropped', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [
      toolLine([toolUse('Read', { file_path: join(dir, '.git', 'HEAD') })]),
      toolLine([toolUse('Read', { file_path: join(dir, '.sterling', 'config.json') })]),
      toolLine([toolUse('Read', { file_path: join(dir, 'kept.mjs') })]),
    ]);
    const result = observedToolPaths(t, dir);
    assert.deepEqual(result.reads, ['kept.mjs'], 'only the non-.git/.sterling path survives');
  } finally {
    cleanup();
  }
});

test('(P1-missing-path-field) a missing or non-string path/file_path field on a matched tool contributes nothing', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [
      toolLine([toolUse('Read', {})]),
      toolLine([toolUse('Grep', { pattern: 'x', path: 123 })]),
      toolLine([toolUse('Edit', { file_path: null })]),
      toolLine([toolUse('Read', { file_path: join(dir, 'the-only-one.mjs') })]),
    ]);
    const result = observedToolPaths(t, dir);
    assert.deepEqual(result.reads, ['the-only-one.mjs']);
    assert.deepEqual(result.writes, []);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P1-grep-dir-excluded / P1-glob-dir-included) the one deliberate asymmetry
// between Grep and Glob per ambiguity (a): a directory-shaped path (no file
// extension) is excluded from Grep but included from Glob.
// SABOTAGE (P1-grep-dir-excluded): drop the file-path qualifier on Grep and
// treat every Grep `path` like Glob's — this test alone goes red while
// P1-CONTROL's Grep(file) case stays green (it already has an extension).
// ===========================================================================

test('(P1-grep-dir-excluded) a directory-shaped Grep `path` (no file extension) is excluded — Grep only contributes FILE paths', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [toolLine([toolUse('Grep', { pattern: 'x', path: join(dir, 'src') })])]);
    const result = observedToolPaths(t, dir);
    assert.deepEqual(result.reads, [], 'a directory-shaped Grep path is not a file path and contributes nothing');
  } finally {
    cleanup();
  }
});

test('(P1-glob-dir-included) a directory-shaped Glob `path` IS included — Glob carries no file-path qualifier', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [toolLine([toolUse('Glob', { path: join(dir, 'src') })])]);
    const result = observedToolPaths(t, dir);
    assert.deepEqual(result.reads, ['src'], 'Glob\'s path is taken unconditionally, unlike Grep\'s');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PART 2 — H22 SubagentStart reviewer warning
// ===========================================================================

// ---------------------------------------------------------------------------
// (P2-CONTROL) placed FIRST: a reviewer-* dispatch WITH a valid declaration
// produces NO absence warning. This is the control arm for every "warning
// fires" test below — without it, a hook that ALWAYS warns on every
// reviewer-* SubagentStart (regardless of declaration) would pass every RED
// pin in this section for the wrong reason.
// EXPECTED RED today: N/A as a red-today pin — H22 has no REVIEW-TERRITORY
// awareness of this NEW warning at all yet, so stderr never carries an
// absence indicator regardless of input; this assertion (no warning) is
// trivially true today. It exists to remain true AFTER the fix lands too.
// SABOTAGE: after landing, warn unconditionally for every reviewer-*
// dispatch — flips this control red while leaving nothing else to prove it.
// ===========================================================================

test('(P2-CONTROL) a reviewer-* dispatch with a valid REVIEW-TERRITORY declaration produces no absence warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'REVIEW-TERRITORY: ["packages/mcp-server/src/auth.ts"]\nplease review', 'reviewer-correctness');
    const r = runHook(startInput(dir, { agent_id: 'rev-ok', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoWarningAtAll(r.stderr);
  } finally {
    cleanup();
  }
});

// EXPECTED RED today: H22 has no absence-warning logic at all, so stderr
// never carries the absence indicator regardless of input — fails
// `assertNoDeclarationWarning`'s second (absence-indicator) match.
// SABOTAGE: implement the warning but gate it on the wrong condition (e.g.
// only warn when the PROMPT is empty, never on "no marker present") — this
// no-marker case (a non-empty prompt lacking the marker) goes red while
// P2-CONTROL (which never expects a warning) stays green regardless.
test('(P2-no-marker) a reviewer-* dispatch with NO REVIEW-TERRITORY marker at all gets a loud absence warning; exit stays 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'Please review the recent diff for correctness, no declaration given.', 'reviewer-correctness');
    const r = runHook(startInput(dir, { agent_id: 'rev-no-marker', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoDeclarationWarning(r.stderr);
  } finally {
    cleanup();
  }
});

// EXPECTED RED today: same as P2-no-marker — no absence-warning logic
// exists yet; fails the absence-indicator match.
// SABOTAGE: treat "a marker line was found" (even malformed) as though it
// were "a valid declaration was found" and suppress the absence warning —
// this test goes red (no warning fires) while P2-no-marker (which has no
// marker at all) stays green, proving the malformed case is independently
// pinned from the wholly-absent case.
//
// PRESERVATION PIN ADDED (reviewer-found gap, coordinator amendment): the
// two assertions above prove only the NEW absence warning fires — that pair
// would stay GREEN even if decision foreign_8f137474's PRE-EXISTING malformed-
// declaration warning ("malformed REVIEW-TERRITORY declaration ignored...")
// were deleted entirely, since assertNoDeclarationWarning never checks for
// it. The new assertion below closes that gap by requiring BOTH warnings to
// co-occur on a malformed-marker dispatch.
// EXPECTED (regression net, stated per the coordinator's brief — NOT
// executed by me; I hold no Bash, so this is a claim about what the gate
// should observe, not a measured result): GREEN against the current
// implementation — decision foreign_8f137474 already ships the malformed-content
// warning today, so `/malformed REVIEW-TERRITORY declaration/` should
// already match; only the co-occurrence with the absence warning is new.
// SABOTAGE: delete/rename the pre-existing malformed-declaration stderr line
// (decision foreign_8f137474) while leaving the new absence-warning logic intact —
// the two assertions above stay green (they never look for the malformed
// line), but this new assertion goes red, which is the whole reason it
// exists as a SEPARATE, additional check rather than folded into
// assertNoDeclarationWarning.
test('(P2-malformed-marker) a reviewer-* dispatch whose marker is malformed (falls back to free-prose) still gets the absence warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'REVIEW-TERRITORY: [not-json\nscripts/decoy.mjs is the actual file.', 'reviewer-correctness');
    const r = runHook(startInput(dir, { agent_id: 'rev-malformed', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoDeclarationWarning(r.stderr);
    assert.match(
      r.stderr,
      /malformed REVIEW-TERRITORY declaration/,
      'the PRE-EXISTING malformed-declaration warning (decision 8f137474) still fires alongside the NEW absence warning — a malformed marker must never surface only one of the two' // not-a-citation: fixture id
    );
  } finally {
    cleanup();
  }
});

// EXPECTED RED today: N/A as red-today (no warning exists yet, so "no
// warning" trivially holds) — this is a regression-net control that must
// keep holding once the fix lands.
// SABOTAGE: treat an explicit empty array the same as "no marker at all"
// (conflating absence with the deliberate empty declaration, exactly the
// conflation decision foreign_8f137474 item 3 already warns against for the files[]
// field) and warn anyway — flips this red while P2-CONTROL (a non-empty
// declaration) stays green, proving the empty-array case is independently
// exercised.
test('(P2-empty-array-is-valid) REVIEW-TERRITORY: [] is an explicit, valid declaration — no absence warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'This is audit-only.\nREVIEW-TERRITORY: []', 'reviewer-correctness');
    const r = runHook(startInput(dir, { agent_id: 'rev-empty', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoWarningAtAll(r.stderr);
  } finally {
    cleanup();
  }
});

// EXPECTED RED today: N/A as red-today (trivially holds, no warning logic
// exists) — regression net that must keep holding.
// SABOTAGE: match the reviewer-class check with a substring/includes test
// instead of a startsWith('reviewer-') anchor (e.g. warn whenever the
// prompt looks review-shaped, regardless of agent_type) — a non-reviewer
// agent_type would then also warn, flipping this red while P2-CONTROL
// (which supplies a real reviewer-* type) stays green.
test('(P2-non-reviewer-silent) a non-reviewer agent_type ("coder") with no marker gets no warning at all', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'Implement the feature, no declaration here.', 'coder');
    const r = runHook(startInput(dir, { agent_id: 'coder-1', agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoWarningAtAll(r.stderr);
  } finally {
    cleanup();
  }
});

// EXPECTED RED today: N/A as red-today (trivially holds) — regression net
// against a loose prefix check.
// SABOTAGE: use `agent_type.startsWith('reviewer')` (missing the trailing
// hyphen) instead of the exact 'reviewer-' prefix — 'reviewer' alone would
// then also warn, flipping this red while P2-non-reviewer-silent ('coder',
// which shares no prefix at all) stays green, proving the hyphen boundary is
// independently exercised.
test('(P2-boundary-no-hyphen) agent_type "reviewer" (no trailing hyphen) is not reviewer-class for this warning — no warning fires', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'Look at this, no declaration here.', 'reviewer');
    const r = runHook(startInput(dir, { agent_id: 'bare-reviewer', agent_type: 'reviewer' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoWarningAtAll(r.stderr);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PART 3 — H22 SubagentStop observed-evidence-on-ledger-promotion REMOVED
// (P3-null-vs-empty, P3-agent-transcript-file-missing, P3-decoy-isolation,
// P3-main, P3-union-dedup, and P3-truncated further below). All six asserted
// that a reviewer-class SubagentStop promotes a .sterling/review-ledger.json
// receipt carrying observed_files/observed_source/observed_truncated. That
// whole promotion mechanism (promoteAtStop and its owner module
// scripts/hooks/lib/review-ledger-entry.mjs) was deleted under decision
// `sterling-claude-code-scale-down-boundary` (2ad87dd1) — SubagentStop no
// longer writes a ledger at all, so there is nothing left for these to
// assert. The fixture helpers that existed only to serve them
// (writeToolBlockTranscript/writeDecoyParentTranscript/registerEntry/
// writeRegisterRaw/readLedger/declaredFiles/declaredSource/
// findEntryByDeclaredFile) were removed with them — grep confirms zero
// remaining callers in this file. PART 1 (the surviving observedToolPaths lib
// primitive, including P1-truncated/P1-not-truncated immediately below) and
// PART 2/PART 4/PART 5 are untouched.
// ===========================================================================

// ===========================================================================
// (P1-truncated / P1-not-truncated) the lib-level truncation indicator, per
// ambiguity (e)'s representation choice: a third `truncated` property,
// present (true) only when the 1MB tail window was exhausted, absent for a
// normally-sized transcript. This control PAIR is placed together: a stub
// hardcoding either value alone fails the other half.
// EXPECTED RED today: import failure (module does not exist) — same root
// cause as every other PART 1 test.
// SABOTAGE (P1-truncated): hardcode `truncated: false` regardless of size
// (or never implement the tail window at all) — fails
// `assert.equal(result.truncated, true)`.
// SABOTAGE (P1-not-truncated): always attach a `truncated` key (e.g.
// `truncated: false`) regardless of size — fails the
// `!('truncated' in result)` check while P1-truncated (which wants
// `true`) is unaffected either way.
// ===========================================================================

test('(P1-truncated) a transcript larger than the 1MB tail window sets truncated:true on the returned shape', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const bigLine = JSON.stringify(toolLine([textBlock('x'.repeat(1_100_000))]));
    const readLine = JSON.stringify(toolLine([toolUse('Read', { file_path: join(dir, 'after-big.mjs') })]));
    const p = join(dir, 'big-transcript.jsonl');
    writeFileSync(p, bigLine + '\n' + readLine + '\n');
    const result = observedToolPaths(p, dir);
    assert.ok(result, 'a large-but-readable transcript never degrades to null');
    assert.equal(result.truncated, true, 'the tail window was exhausted by the oversized transcript');
  } finally {
    cleanup();
  }
});

test('(P1-not-truncated) a transcript well under the 1MB tail window carries no `truncated` key at all', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const t = writeToolTranscript(dir, [toolLine([toolUse('Read', { file_path: join(dir, 'small.mjs') })])]);
    const result = observedToolPaths(t, dir);
    assert.ok(!('truncated' in result), 'a small transcript never fabricates a truncated key');
  } finally {
    cleanup();
  }
});

// (P3-truncated) REMOVED with the rest of PART 3 above — see that removal
// note.

// ===========================================================================
// PART 4 — observedToolPathsSince(transcriptPath, cwd, sinceIso) : round-
// scoped read filtering (board 181d11e7, brief item (a) — the
// round-scoping fix for the resumed-reviewer rebaseline). This is a NEW,
// SEPARATE export added alongside the pre-existing observedToolPaths, which
// keeps its EXACT prior behavior unmodified for its other callers
// (P4-legacy-unchanged below is the regression guard for that half).
//
// INFERRED, NOT GIVEN (disclosed): the brief specifies filtering "to
// transcript entries whose `timestamp` is AFTER [or, per its sinceIso
// wording elsewhere, at/after] the receipt's prior finished_at" but does
// not name where a per-JSONL-line timestamp lives in this test file's own
// fixture shape (toolLine()/toolUse() carry no timestamp field at all
// today). Read here as a top-level `timestamp` ISO-string key on the JSONL
// line/entry object (`toolLineAt` below), mirroring the real Claude Code
// transcript convention of one timestamp per line. If a landed
// implementation reads the timestamp from a different location (e.g.
// nested under `message`), that is a genuine reportable divergence from
// this reading, not a reason to weaken the assertions below.
// ===========================================================================

const toolLineAt = (timestamp, blocks) => ({ type: 'assistant', timestamp, message: { content: blocks } });

// ---------------------------------------------------------------------------
// (P4-since-boundary) placed first as the load-bearing control+boundary pin:
// three entries straddle sinceIso — clearly BEFORE (must be excluded),
// exactly AT (pinned EXCLUDED — sinceIso is the PRIOR round's finished_at,
// the instant that round ENDED, so a read timestamped exactly then belongs
// to the round that just finished, not the new one; board 181d11e7's own
// wording is "AFTER the receipt's prior finished_at", strictly), and clearly
// AFTER (must be included). A stub unable to discriminate BEFORE from AFTER
// fails on those two paths outright; the AT case is the boundary itself,
// pinned in the same test so the boundary reading is asserted, not assumed.
// PINNED DIRECTION (corrected — coordinator, board 181d11e7 wording):
// AT-sinceIso is EXCLUDED. The comparison is strict `>`, not `>=`: crediting
// the exact prior finished_at to the new round is the PERMISSIVE direction
// on a check whose entire purpose is denying a resumed reviewer credit for
// reads it did not perform this round — the wrong direction to default to
// under fail-closed (P5).
// SABOTAGE: use `>=` instead of a strict `>` — the AT-boundary entry
// ('at-boundary.mjs') would then be wrongly INCLUDED, reddening the
// deepEqual below; it is the AT-boundary entry specifically that
// discriminates `>` from `>=` (the before/after entries pass under either
// operator).
// ===========================================================================

test('(P4-since-boundary) observedToolPathsSince excludes strictly-before sinceIso AND exactly-at sinceIso; includes only strictly-after', () => {
  requireSinceLib();
  const { dir, cleanup } = makeScratch();
  try {
    const sinceIso = '2026-09-01T00:00:00.000Z';
    const before = new Date(Date.parse(sinceIso) - 60_000).toISOString();
    const after = new Date(Date.parse(sinceIso) + 60_000).toISOString();
    const t = writeToolTranscript(dir, [
      toolLineAt(before, [toolUse('Read', { file_path: join(dir, 'before-excluded.mjs') })]),
      toolLineAt(sinceIso, [toolUse('Read', { file_path: join(dir, 'at-boundary.mjs') })]),
      toolLineAt(after, [toolUse('Read', { file_path: join(dir, 'after-included.mjs') })]),
    ]);
    const result = observedToolPathsSince(t, dir, sinceIso);
    assert.ok(result, 'a well-formed transcript never degrades to null');
    assert.deepEqual(
      [...result.reads].sort(),
      ['after-included.mjs'],
      'strictly-before sinceIso is excluded; the entry exactly AT sinceIso belongs to the round that just ended and is ALSO excluded; only strictly-after is included'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P4-since-no-timestamp) an entry with NO timestamp field at all is
// excluded — fail-closed: an entry whose time cannot be established is
// never treated as belonging to "this round".
// SABOTAGE: treat a missing timestamp as always-in-scope (or coerce it to a
// value that resolves to inclusion either way, e.g. Date.now()) — this test
// alone catches it; P4-since-boundary (every entry fully timestamped) stays
// green regardless.
// ===========================================================================

test('(P4-since-no-timestamp) an entry with no timestamp field at all is excluded — fail-closed, never counted as "this round"', () => {
  requireSinceLib();
  const { dir, cleanup } = makeScratch();
  try {
    const sinceIso = '2026-09-01T00:00:00.000Z';
    const t = writeToolTranscript(dir, [
      toolLine([toolUse('Read', { file_path: join(dir, 'no-timestamp.mjs') })]), // no top-level timestamp at all
      toolLineAt(new Date(Date.parse(sinceIso) + 60_000).toISOString(), [toolUse('Read', { file_path: join(dir, 'timestamped-after.mjs') })]),
    ]);
    const result = observedToolPathsSince(t, dir, sinceIso);
    assert.ok(result, 'a well-formed transcript never degrades to null');
    assert.deepEqual(
      result.reads,
      ['timestamped-after.mjs'],
      'the untimestamped entry contributes nothing at all; its properly-timestamped sibling still does'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P4-legacy-unchanged) the PRE-EXISTING observedToolPaths (no sinceIso
// parameter) must be completely unaffected by the new timestamp-based
// filtering added for observedToolPathsSince — the regression guard for
// every OTHER caller of the legacy function, which the brief requires to
// "keep its exact old behaviour".
// SABOTAGE: make observedToolPaths internally share the new since-filtering
// code path unconditionally (e.g. defaulting sinceIso to something that
// silently drops untimestamped or oddly-timestamped entries) — entries with
// no timestamp, or a far-past/far-future one, would then be dropped,
// reddening the deepEqual below.
// ===========================================================================

test('(P4-legacy-unchanged) observedToolPaths (no sinceIso) is unaffected by timestamps — present, absent, past or future, every entry still counts', () => {
  requireLib();
  const { dir, cleanup } = makeScratch();
  try {
    const farPast = '2000-01-01T00:00:00.000Z';
    const farFuture = '2099-01-01T00:00:00.000Z';
    const t = writeToolTranscript(dir, [
      toolLineAt(farPast, [toolUse('Read', { file_path: join(dir, 'past.mjs') })]),
      toolLineAt(farFuture, [toolUse('Read', { file_path: join(dir, 'future.mjs') })]),
      toolLine([toolUse('Read', { file_path: join(dir, 'no-timestamp-at-all.mjs') })]),
    ]);
    const result = observedToolPaths(t, dir);
    assert.ok(result, 'a well-formed transcript never degrades to null');
    assert.deepEqual(
      [...result.reads].sort(),
      ['future.mjs', 'no-timestamp-at-all.mjs', 'past.mjs'],
      'observedToolPaths ignores timestamps entirely — every entry counts regardless of when (or whether) it is timestamped, exactly as before this change'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PART 5 — scripts/hooks/lib/transcript.mjs :: readFromStart(path, bytes)
// throw-safety + completeness contract (slice 4A fix, two defects found by
// security review — see the launching brief's CONTEXT / TWO DEFECTS
// sections). H22 uses `complete` as a LOAD-BEARING signal: callers must
// distinguish "the id is absent" from "the id is absent from the portion I
// read" and refuse rather than conclude on an incomplete read, so a lying
// `complete` becomes a false attestation on a review receipt.
//
// H4 BLINDNESS HONORED: scripts/hooks/lib/transcript.mjs was never opened by
// me. The exported signature (`readFromStart(path, bytes) -> {text,
// complete} | null`) and the two named defects are taken verbatim from the
// launching brief, not read from source. A coder is fixing this file in
// parallel; these pins are written blind to that work.
//
// Harness idioms below (makeScratch tmpdir fixtures, the IS_ROOT chmod-000
// skip, requireX()-style guarded import) are copied from PART 1's
// requireLib()/IS_ROOT usage above (siblings in the same scripts/hooks/lib/
// directory) rather than invented fresh.
//
// readTail is explicitly OUT OF SCOPE per the brief (byte-unchanged) and is
// not imported or exercised here.
// ===========================================================================

let readFromStart;
let readFromStartImportError = null;
before(async () => {
  try {
    ({ readFromStart } = await import(pathToFileURL(join(HOOKS, 'lib', 'transcript.mjs')).href));
  } catch (e) {
    readFromStartImportError = e;
  }
});

function requireReadFromStart() {
  if (readFromStartImportError || typeof readFromStart !== 'function') {
    assert.fail(
      `scripts/hooks/lib/transcript.mjs must export readFromStart(); import failed or the export is missing: ${readFromStartImportError?.message ?? 'readFromStart is not a function'}`
    );
  }
}

// ---------------------------------------------------------------------------
// (P5-directory-no-throw) DEFECT #1: a path that EXISTS but is a directory
// must degrade to null, never throw. Today it guards only existsSync, then
// calls openSync/readSync unguarded, so a directory (which exists) reaches
// openSync and throws EISDIR — an unwrapped throw here aborts the whole
// SubagentStop handler upstream (no receipt minted). assert.doesNotThrow is
// used deliberately, not merely a null check, per the brief: "the throw is
// the defect."
// SABOTAGE: remove (or narrow to only existsSync-adjacent errors) the
// open/read error guard so a directory path throws EISDIR uncaught —
// assert.doesNotThrow fails immediately, loudly, on the thrown error.
// ---------------------------------------------------------------------------

test('(P5-directory-no-throw) readFromStart on a path that is a DIRECTORY returns null and does not throw', () => {
  requireReadFromStart();
  const { dir, cleanup } = makeScratch();
  try {
    const subdir = join(dir, 'a-directory');
    mkdirSync(subdir);
    let result;
    assert.doesNotThrow(() => {
      result = readFromStart(subdir, 4096);
    }, 'a directory path must degrade to null, never throw');
    assert.equal(result, null, 'a directory is not a readable transcript file');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (P5-unreadable-no-throw) DEFECT #1's other named shape: mode-000 file
// (EACCES on open). Skipped under root, matching the sibling
// P1-degrade-unreadable idiom copied verbatim (root ignores mode bits, so
// the arm would falsely fail, not falsely pass).
// SABOTAGE: same as above — drop the open/read error guard so EACCES
// propagates uncaught; assert.doesNotThrow fails on the thrown error.
// ---------------------------------------------------------------------------

test(
  '(P5-unreadable-no-throw) readFromStart on a permission-denied file returns null and does not throw',
  { skip: IS_ROOT ? 'running as root — chmod 0o000 does not block root reads' : false },
  () => {
    requireReadFromStart();
    const { dir, cleanup } = makeScratch();
    const p = join(dir, 'unreadable.txt');
    try {
      writeFileSync(p, 'content that would otherwise be perfectly readable');
      chmodSync(p, 0o000);
      let result;
      assert.doesNotThrow(() => {
        result = readFromStart(p, 4096);
      }, 'a permission-denied file must degrade to null, never throw');
      assert.equal(result, null, 'an unreadable file yields no read result');
    } finally {
      try {
        chmodSync(p, 0o644);
      } catch {
        // already gone or already writable
      }
      cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// (P5-nonexistent) pre-existing behaviour (per the brief, already correct
// today via the existsSync guard) — pinned so the throw-safety fix cannot
// regress it, e.g. by replacing the existsSync check with a bare try/catch
// that behaves differently on ENOENT.
// SABOTAGE: remove the existsSync short-circuit and let a bare open on a
// missing path propagate anything other than a clean null (e.g. rethrow, or
// return {text:'',complete:false} instead of null) — assert.equal(result,
// null) fails.
// ---------------------------------------------------------------------------

test('(P5-nonexistent) readFromStart on a nonexistent path returns null', () => {
  requireReadFromStart();
  const { dir, cleanup } = makeScratch();
  try {
    const result = readFromStart(join(dir, 'does-not-exist.txt'), 4096);
    assert.equal(result, null);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (P5-smaller-complete) DEFECT #2, first half: a file SMALLER than the
// requested byte count. A correct implementation reads fewer bytes than
// requested (hits EOF first) and must report complete:true with the full,
// exact text — no trailing padding.
// This is the arm that catches the "buffer sliced to the REQUESTED length
// instead of the actual bytesRead count" half of defect #2: Buffer.alloc
// zero-fills, so slicing/stringifying the full requested length instead of
// the actual read count would append trailing NUL bytes to `text`, breaking
// the exact-equality assertion below even though `complete` might
// (coincidentally) still read true.
// SABOTAGE: build the returned string as
// `buf.toString('utf8', 0, bytes)` (the requested length) instead of
// `buf.toString('utf8', 0, bytesRead)` (the actual short-read count) — the
// deepEqual/exact-text assertion goes red on the trailing '\x00' padding;
// P5-larger-incomplete below is unaffected by this specific sabotage (its
// read fills the buffer exactly, so no padding is introduced there).
// ---------------------------------------------------------------------------

test('(P5-smaller-complete) a file smaller than the requested byte count returns complete:true and the exact full text, no padding', () => {
  requireReadFromStart();
  const { dir, cleanup } = makeScratch();
  try {
    const p = join(dir, 'small.txt');
    const content = 'short content, well under the requested byte budget\n';
    writeFileSync(p, content);
    const result = readFromStart(p, content.length + 10_000);
    assert.ok(result, 'a readable, undersized file never degrades to null');
    assert.equal(result.complete, true, 'the entire file was read, so complete must be true');
    assert.equal(result.text, content, 'text is the exact file content — no trailing padding from an over-sized read buffer');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (P5-empty-file) EMPTY FILE — the boundary of P5-smaller-complete (0 bytes
// requested-vs-available, taken to the limit). CHOICE STATED: an empty file
// is fully read by definition (there is nothing left to read), so it is
// read as complete:true, text:'' — the same "smaller than requested" shape
// as above, not a degrade-to-null case (the file exists and is readable;
// zero length is not an error).
// SABOTAGE: same buffer-slicing defect as P5-smaller-complete — text would
// come back as a string of NUL bytes instead of '', which is trivially
// distinguishable from '' and fails the exact-equality assertion.
// ---------------------------------------------------------------------------

test('(P5-empty-file) an empty file returns complete:true and text:\'\' (an empty file is trivially fully read)', () => {
  requireReadFromStart();
  const { dir, cleanup } = makeScratch();
  try {
    const p = join(dir, 'empty.txt');
    writeFileSync(p, '');
    const result = readFromStart(p, 4096);
    assert.ok(result, 'a readable empty file never degrades to null');
    assert.equal(result.complete, true, 'zero bytes remaining is the definition of fully read');
    assert.equal(result.text, '', 'no content, no padding');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (P5-larger-incomplete) DEFECT #2, the load-bearing arm: "the flag reflects
// reality rather than intent." A file LARGER than the requested byte count,
// read on ordinary local disk, fills the read buffer completely in one
// readSync call (bytesRead === bytes requested) — there is no short read to
// construct here. A naive fix that derives `complete` from "did bytesRead
// equal the requested length" (i.e. from the REQUESTED length, exactly the
// defect named in the brief) would say complete:true, because the buffer
// was filled — even though the file plainly continues past the returned
// prefix. Correct behaviour must derive `complete` from whether the FILE
// (not just the buffer) was exhausted — e.g. comparing against the file's
// actual size — so this large-file case reports complete:false, and `text`
// is exactly the requested-length prefix (no more, no less).
// SABOTAGE: compute `complete` as `bytesRead === bytes` (or unconditionally
// true whenever the read call itself succeeds) instead of checking whether
// the read reached the end of the file — complete flips from false to true
// here while P5-smaller-complete (whose bytesRead is intrinsically less
// than the requested length) is unaffected by this specific sabotage,
// proving the two arms are independently exercised.
// ---------------------------------------------------------------------------

test('(P5-larger-incomplete) a file larger than the requested byte count returns complete:false and text equal to the exact requested prefix', () => {
  requireReadFromStart();
  const { dir, cleanup } = makeScratch();
  try {
    const p = join(dir, 'large.txt');
    const content = 'abcdefghij'.repeat(1000); // 10,000 bytes, well over the budget below
    writeFileSync(p, content);
    const budget = 100;
    const result = readFromStart(p, budget);
    assert.ok(result, 'a readable oversized file never degrades to null');
    assert.equal(result.complete, false, 'the file continues past the requested prefix, so complete must be false — this is NOT the whole file');
    assert.equal(result.text, content.slice(0, budget), 'text is exactly the requested-length prefix, nothing more');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// UNCONSTRUCTIBLE, DISCLOSED PER THE BRIEF'S INSTRUCTION: a genuine
// short-read on a REGULAR file — a single readSync() call returning FEWER
// bytes than requested despite the file having more data available past
// that point (as opposed to hitting real EOF, which P5-smaller-complete and
// P5-empty-file already cover) — is not deterministically constructible
// with plain fs fixtures. On Linux, a single-threaded readSync against a
// local regular file reliably fills the buffer up to EOF; producing an
// actual partial fill mid-file requires a FIFO/pipe (which can hang without
// a concurrent writer/reader pair and is not portable to how this suite
// runs) or a mocked/monkey-patched fd (which this suite's harness has no
// precedent for and which node:test's `mock` would tie to a specific
// implementation shape I'm not allowed to read). Per the brief's own
// guidance, this arm is deliberately NOT pinned rather than written flaky.
// P5-larger-incomplete above already exercises the "complete computed from
// requested length rather than reality" half of defect #2 deterministically
// (no short read needed, since a single-call read of a normal file fills
// the buffer completely); what remains uncovered is only the buffer
// zero-padding sub-detail in the true short-read case specifically, which a
// short-read loop would prevent by construction (each iteration reads only
// what's still missing) and which P5-smaller-complete's "no padding"
// assertion already exercises via the file-EOF-triggered short read, so
// the same code path is exercised, only not via a mid-file short read.
// ---------------------------------------------------------------------------
