// H22 TERRITORY-EVIDENCE UPGRADE — SPEC ONLY, red-first.
// Governing decision: knowledge_get 9500cce1-f54b-450b-ae63-dd78ee53dbab
// (slug review-territory-observed-evidence) — confirmed LIVE as of the
// amendment below (it did not exist at this file's first draft).
//
// SPEC CORRECTION (post-first-draft amendment, verified against
// research_finding 20b44518-39d0-4dd4-81b7-59a403ad09e1, a byte-exact live
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
// already-shipped decision 8f137474 semantics: parsed, path-shape-valid,
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
//       marker-present-but-malformed case (decision 8f137474's own
//       free-prose-fallback outcome) — both are "no valid declaration".
//   (d) The stderr warning's exact wording is free (per the brief); the
//       assertion helper below requires the literal substring
//       'REVIEW-TERRITORY' PLUS a nearby absence word ("no"/"missing"/
//       "without"), designed to avoid false-matching decision 8f137474's
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
// entry or the v2 nested envelope (decision 57984926) depending on what has
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
function singleDispatch(dir, prompt, name = 'parent.jsonl') {
  writeParentTranscript(dir, [taskLine([taskBlock('Task', prompt)])], name);
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

function assertNoDeclarationWarning(stderr) {
  assert.match(stderr, /REVIEW-TERRITORY/, 'stderr names REVIEW-TERRITORY');
  assert.match(
    stderr,
    ABSENCE_INDICATOR_RE,
    'stderr carries a standalone absence indicator ("no"/"missing"/"without") near the REVIEW-TERRITORY marker'
  );
}
function assertNoWarningAtAll(stderr) {
  assert.doesNotMatch(stderr, ABSENCE_INDICATOR_RE, 'no absence-declaration warning fires');
}

// ===========================================================================
// PART 1 — scripts/hooks/lib/observed-territory.mjs :: observedToolPaths()
// ===========================================================================

let observedToolPaths;
let importError = null;
before(async () => {
  try {
    ({ observedToolPaths } = await import(pathToFileURL(LIB_PATH).href));
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
    singleDispatch(dir, 'REVIEW-TERRITORY: ["packages/mcp-server/src/auth.ts"]\nplease review');
    const r = runHook(h22Input(dir, { agent_id: 'rev-ok', agent_type: 'reviewer-correctness' }), dir);
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
    singleDispatch(dir, 'Please review the recent diff for correctness, no declaration given.');
    const r = runHook(h22Input(dir, { agent_id: 'rev-no-marker', agent_type: 'reviewer-correctness' }), dir);
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
// would stay GREEN even if decision 8f137474's PRE-EXISTING malformed-
// declaration warning ("malformed REVIEW-TERRITORY declaration ignored...")
// were deleted entirely, since assertNoDeclarationWarning never checks for
// it. The new assertion below closes that gap by requiring BOTH warnings to
// co-occur on a malformed-marker dispatch.
// EXPECTED (regression net, stated per the coordinator's brief — NOT
// executed by me; I hold no Bash, so this is a claim about what the gate
// should observe, not a measured result): GREEN against the current
// implementation — decision 8f137474 already ships the malformed-content
// warning today, so `/malformed REVIEW-TERRITORY declaration/` should
// already match; only the co-occurrence with the absence warning is new.
// SABOTAGE: delete/rename the pre-existing malformed-declaration stderr line
// (decision 8f137474) while leaving the new absence-warning logic intact —
// the two assertions above stay green (they never look for the malformed
// line), but this new assertion goes red, which is the whole reason it
// exists as a SEPARATE, additional check rather than folded into
// assertNoDeclarationWarning.
test('(P2-malformed-marker) a reviewer-* dispatch whose marker is malformed (falls back to free-prose) still gets the absence warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'REVIEW-TERRITORY: [not-json\nscripts/decoy.mjs is the actual file.');
    const r = runHook(h22Input(dir, { agent_id: 'rev-malformed', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoDeclarationWarning(r.stderr);
    assert.match(
      r.stderr,
      /malformed REVIEW-TERRITORY declaration/,
      'the PRE-EXISTING malformed-declaration warning (decision 8f137474) still fires alongside the NEW absence warning — a malformed marker must never surface only one of the two'
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
// conflation decision 8f137474 item 3 already warns against for the files[]
// field) and warn anyway — flips this red while P2-CONTROL (a non-empty
// declaration) stays green, proving the empty-array case is independently
// exercised.
test('(P2-empty-array-is-valid) REVIEW-TERRITORY: [] is an explicit, valid declaration — no absence warning', () => {
  const { dir, cleanup } = makeProject();
  try {
    singleDispatch(dir, 'This is audit-only.\nREVIEW-TERRITORY: []');
    const r = runHook(h22Input(dir, { agent_id: 'rev-empty', agent_type: 'reviewer-correctness' }), dir);
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
    singleDispatch(dir, 'Implement the feature, no declaration here.');
    const r = runHook(h22Input(dir, { agent_id: 'coder-1', agent_type: 'coder' }), dir);
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
    singleDispatch(dir, 'Look at this, no declaration here.');
    const r = runHook(h22Input(dir, { agent_id: 'bare-reviewer', agent_type: 'reviewer' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assertNoWarningAtAll(r.stderr);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PART 3 — H22 SubagentStop observed evidence on reviewer-class promotion
// ===========================================================================

// Generic tool_use-block-flavored transcript writer (per Part 1's fixture
// shape), reused here to exercise the SAME lib function end-to-end through
// the hook rather than directly. Used for BOTH the real (agent) transcript
// and the decoy parent transcript below — the two are the same JSONL shape,
// only which stdin field points at them differs.
function writeToolBlockTranscript(dir, name, blocks) {
  const p = join(dir, 't', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, blocks.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// A PARENT-shaped transcript carrying a DECOY tool_use path — stands in for
// stdin.transcript_path at Stop (the CONDUCTOR's transcript, per the SPEC
// CORRECTION). Every P3 test below asserts this decoy path never surfaces in
// observed_files, which is exactly how a "reads the wrong stdin field" bug
// gets caught by construction rather than by inspection.
function writeDecoyParentTranscript(dir, name, decoyPath) {
  return writeToolBlockTranscript(dir, name, [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, decoyPath) } }] } }]);
}

// ---------------------------------------------------------------------------
// (P3-null-vs-empty) the distinguishing control pair for the whole section,
// placed FIRST: a departing (agent_transcript_path) transcript with ZERO
// tool_use blocks promotes observed_files: [] (present, empty), while an
// ABSENT agent_transcript_path promotes with the field ABSENT entirely and
// NEVER falls back to the parent (transcript_path) transcript's content —
// Half B's parent transcript deliberately carries a decoy path, so a
// fallback bug would surface it. A stub that can't tell the two apart fails
// one half of this pair no matter which way it collapses.
// EXPECTED RED today: if PART 3 wiring does not exist at all yet,
// `entry.observed_files` is undefined in both halves — fails
// `assert.ok('observed_files' in entry)` in Half A. If a landed
// implementation instead reads the WRONG field (stdin.transcript_path, the
// exact bug this amendment corrects) — Half A's own transcript_path fixture
// also carries a decoy ('decoy/half-a.mjs'), so that bug would surface as an
// unexpectedly NON-EMPTY observed_files in Half A (failing the `deepEqual(
// entry.observed_files, [])` assertion); Half B's transcript_path decoy
// ('decoy/half-b.mjs') would then surface as a wrongly-PRESENT
// observed_files (failing the `!('observed_files' in entry)` assertion).
// SABOTAGE: always omit observed_files when the union is empty (conflate
// "found nothing" with "couldn't observe") — the zero-blocks half goes red
// while the missing-transcript half (which correctly wants absence) stays
// green, proving the two are independently pinned.
// ===========================================================================

test('(P3-null-vs-empty) zero-tool-use AGENT transcript -> observed_files:[] present; ABSENT agent_transcript_path -> observed_files absent (no parent fallback)', () => {
  const { dir, cleanup } = makeProject();
  try {
    // Half A: agent_transcript_path readable, zero tool_use blocks; a decoy
    // parent transcript sits at transcript_path and must never contribute.
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-zero', agent_type: 'reviewer-correctness', files: ['src/declared.mjs'], files_source: 'review-territory' })]);
    const agentZero = writeToolBlockTranscript(dir, 'agent-zero.jsonl', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'no tools used' }] } }]);
    const parentDecoyA = writeDecoyParentTranscript(dir, 'parent-decoy-a.jsonl', 'decoy/half-a.mjs');
    let r = runHook(h22Input(dir, { agent_id: 'rev-zero', hook_event_name: 'SubagentStop', transcript_path: parentDecoyA, agent_transcript_path: agentZero }), dir);
    assert.equal(r.code, 0, r.stderr);
    let ledger = readLedger(dir);
    let entry = findEntryByDeclaredFile(ledger, 'src/declared.mjs');
    assert.ok(entry, 'the zero-blocks promotion is present');
    assert.ok('observed_files' in entry, 'observed_files is present (even if empty) when agent_transcript_path was genuinely readable');
    assert.deepEqual(entry.observed_files, [], 'the parent decoy at transcript_path never contributes — only agent_transcript_path is read');
    assert.equal(entry.observed_source, 'subagent-transcript');

    // Half B: agent_transcript_path field is entirely ABSENT from stdin; a
    // real, non-empty decoy parent transcript sits at transcript_path — a
    // fallback bug would pick up 'decoy/half-b.mjs' here.
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-missing', agent_type: 'reviewer-security', files: ['src/declared2.mjs'], files_source: 'review-territory' })]);
    const parentDecoyB = writeDecoyParentTranscript(dir, 'parent-decoy-b.jsonl', 'decoy/half-b.mjs');
    r = runHook(h22Input(dir, { agent_id: 'rev-missing', hook_event_name: 'SubagentStop', transcript_path: parentDecoyB }), dir); // no agent_transcript_path key at all
    assert.equal(r.code, 0, r.stderr);
    ledger = readLedger(dir);
    entry = findEntryByDeclaredFile(ledger, 'src/declared2.mjs');
    assert.ok(entry, 'promotion still succeeds despite a missing agent_transcript_path');
    assert.ok(!('observed_files' in entry), 'observed_files is ABSENT (not []) when agent_transcript_path is missing — never falls back to the parent transcript');
    assert.ok(!('observed_source' in entry), 'observed_source is likewise absent when nothing was observed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P3-agent-transcript-file-missing) companion to Half B above, covering the
// OTHER "missing" shape named by the spec: the field is PRESENT on stdin but
// points at a file that does not exist (as opposed to the key being entirely
// absent). Same no-parent-fallback guarantee.
// EXPECTED RED today: same root cause as P3-null-vs-empty Half B.
// SABOTAGE: fall back to reading transcript_path whenever
// observedToolPaths(agent_transcript_path, cwd) returns null — this test's
// parent decoy would then surface in observed_files, and the field would be
// wrongly PRESENT instead of absent.
// ===========================================================================

test('(P3-agent-transcript-file-missing) agent_transcript_path present but pointing at a nonexistent file behaves identically to absence — no parent fallback', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-nofile', agent_type: 'reviewer-skeptic', files: ['src/declared3.mjs'], files_source: 'review-territory' })]);
    const parentDecoy = writeDecoyParentTranscript(dir, 'parent-decoy-nofile.jsonl', 'decoy/nofile.mjs');
    const r = runHook(
      h22Input(dir, {
        agent_id: 'rev-nofile',
        hook_event_name: 'SubagentStop',
        transcript_path: parentDecoy,
        agent_transcript_path: join(dir, 't', 'does-not-exist-agent.jsonl'),
      }),
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const entry = findEntryByDeclaredFile(readLedger(dir), 'src/declared3.mjs');
    assert.ok(entry, 'promotion still succeeds despite an unreadable agent_transcript_path');
    assert.ok(!('observed_files' in entry), 'observed_files is absent — a nonexistent agent_transcript_path never falls back to the parent');
    assert.ok(!('observed_source' in entry), 'observed_source is likewise absent');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P3-decoy-isolation) the NEW discriminating pin requested by the
// amendment: with BOTH fields present, observed_files reflects ONLY the
// agent_transcript_path content — the parent's decoy path never leaks in
// even when both transcripts are simultaneously real and non-empty. This is
// the single most direct test of the field-correction itself.
// EXPECTED RED today: if PART 3 wiring does not exist yet,
// `entry.observed_files` is undefined — fails the first assertion. If a
// landed implementation reads the WRONG field (the exact bug this amendment
// targets), observed_files would equal ['decoy/should-not-appear.mjs']
// instead of ['real/should-appear.mjs'] — fails the deepEqual with the
// decoy path present where the real one should be.
// SABOTAGE: read stdin.transcript_path instead of stdin.agent_transcript_path
// in the SubagentStop handler — flips this test's result to the decoy path.
// ===========================================================================

test('(P3-decoy-isolation) with both transcripts present, observed_files reflects ONLY agent_transcript_path — the parent decoy never appears', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-iso', agent_type: 'reviewer-correctness', files: ['src/declared.mjs'], files_source: 'review-territory' })]);
    const parentDecoy = writeDecoyParentTranscript(dir, 'parent-decoy-iso.jsonl', 'decoy/should-not-appear.mjs');
    const agentReal = writeToolBlockTranscript(dir, 'agent-real-iso.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'real/should-appear.mjs') } }] } },
    ]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-iso', hook_event_name: 'SubagentStop', transcript_path: parentDecoy, agent_transcript_path: agentReal }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = findEntryByDeclaredFile(readLedger(dir), 'src/declared.mjs');
    assert.ok(entry, 'the promoted receipt is found by its declared file');
    assert.deepEqual(entry.observed_files, ['real/should-appear.mjs'], 'observed_files reflects only agent_transcript_path');
    assert.ok(!entry.observed_files.includes('decoy/should-not-appear.mjs'), 'the parent conductor transcript never contributes a path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P3-main) the main end-to-end pin: a realistic mixed departing
// (agent_transcript_path) transcript yields the exact expected observed_files
// union, a co-present decoy PARENT (transcript_path) transcript never
// contributes, the DECLARED territory (files/files_source, Start-time) is
// left completely unchanged, and observed_truncated is never fabricated for
// a normal-sized transcript.
// EXPECTED RED today: `entry.observed_files` is undefined — fails the first
// assertion. If a landed implementation reads stdin.transcript_path instead
// (the corrected bug), the union would contain 'decoy/parent-only.mjs'
// instead of/alongside the real set — fails the deepEqual.
// SABOTAGE: merge observed paths into the declared territory.files/files
// array instead of writing them to a separate observed_files field — the
// declared-files assertion (still exactly ['src/declared.mjs']) goes red
// while observed_files could coincidentally look plausible.
// ===========================================================================

test('(P3-main) a mixed departing transcript promotes the exact observed_files union; a co-present parent decoy never contributes; declared files/files_source and observed_truncated are untouched', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [
      registerEntry({ agent_id: 'rev-main', agent_type: 'reviewer-performance', files: ['src/declared.mjs'], files_source: 'review-territory' }),
    ]);
    const parentDecoy = writeDecoyParentTranscript(dir, 'parent-decoy-main.jsonl', 'decoy/parent-only.mjs');
    const agentMain = writeToolBlockTranscript(dir, 'agent-main.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'src/read-me.mjs') } }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'noise' }, { type: 'tool_use', name: 'Grep', input: { pattern: 'foo', path: join(dir, 'src/grep-file.mjs') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'foo', path: join(dir, 'src') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob', input: { path: join(dir, 'src') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(dir, 'src/edit-me.mjs') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: join(dir, 'src/write-me.mjs') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: join(dir, 'notebooks/nb.ipynb') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'src/read-me.mjs') } }] } }, // dup
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, '.git/HEAD') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, '.sterling/config.json') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/etc/hostname' } }] } },
      'not valid json at all {',
    ]);

    const r = runHook(h22Input(dir, { agent_id: 'rev-main', hook_event_name: 'SubagentStop', transcript_path: parentDecoy, agent_transcript_path: agentMain }), dir);
    assert.equal(r.code, 0, r.stderr);
    const ledger = readLedger(dir);
    const entry = findEntryByDeclaredFile(ledger, 'src/declared.mjs');
    assert.ok(entry, 'the promoted receipt is found by its declared file');

    assert.deepEqual(
      [...entry.observed_files].sort(),
      ['notebooks/nb.ipynb', 'src', 'src/edit-me.mjs', 'src/grep-file.mjs', 'src/read-me.mjs', 'src/write-me.mjs'],
      'observed_files is the exact normalized, deduped, .git/.sterling-filtered, outside-cwd-dropped union of reads+writes from agent_transcript_path ONLY'
    );
    assert.ok(!entry.observed_files.includes('decoy/parent-only.mjs'), 'the co-present parent decoy never contributes');
    assert.equal(entry.observed_source, 'subagent-transcript');
    assert.ok(!('observed_truncated' in entry), 'a normal-sized transcript never fabricates observed_truncated');

    assert.deepEqual(declaredFiles(entry), ['src/declared.mjs'], 'the Start-time declared territory is untouched by observed evidence');
    assert.equal(declaredSource(entry), 'review-territory', 'files_source is untouched by observed evidence');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (P3-union-dedup) a path that is BOTH read and written by the departing
// subagent appears exactly once in observed_files — the union step itself
// must dedup across the two categories, not just within each.
// SABOTAGE: concatenate reads and writes without deduping
// (`[...reads, ...writes]`) — this test alone catches the duplicate; P1's
// within-category dedup test is unaffected either way.
// ===========================================================================

test('(P3-union-dedup) a path both read and edited by the departing subagent appears once in observed_files', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-union', agent_type: 'reviewer-correctness', files: ['src/declared.mjs'], files_source: 'review-territory' })]);
    const parentDecoy = writeDecoyParentTranscript(dir, 'parent-decoy-union.jsonl', 'decoy/union.mjs');
    const agentUnion = writeToolBlockTranscript(dir, 'agent-union.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'src/both.mjs') } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(dir, 'src/both.mjs') } }] } },
    ]);
    const r = runHook(h22Input(dir, { agent_id: 'rev-union', hook_event_name: 'SubagentStop', transcript_path: parentDecoy, agent_transcript_path: agentUnion }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = findEntryByDeclaredFile(readLedger(dir), 'src/declared.mjs');
    assert.deepEqual(entry.observed_files, ['src/both.mjs'], 'the read+write union dedups a path appearing in both categories');
    assert.ok(!entry.observed_files.includes('decoy/union.mjs'), 'the co-present parent decoy never contributes');
  } finally {
    cleanup();
  }
});

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

// ===========================================================================
// (P3-truncated) the H22 write-side pin, item 4 of the amendment: a departing
// transcript larger than the 1MB tail window promotes observed_truncated:true
// on the ledger entry, top-level, sibling of observed_files. Paired against
// P3-main's `!('observed_truncated' in entry)` assertion on a normal-sized
// transcript.
// EXPECTED RED today: `entry.observed_truncated` is undefined — the wiring
// does not exist yet regardless of the lib's own truncation return (which
// P1-truncated pins independently).
// SABOTAGE: read the lib's `truncated` property but never copy it onto the
// promoted ledger entry (or hardcode `observed_truncated: false`) — this
// test alone goes red while P3-main's negative assertion is unaffected.
// ===========================================================================

test('(P3-truncated) a departing transcript larger than the 1MB tail window promotes observed_truncated:true (sibling of observed_files)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegisterRaw(dir, [registerEntry({ agent_id: 'rev-trunc', agent_type: 'reviewer-correctness', files: ['src/declared.mjs'], files_source: 'review-territory' })]);
    const parentDecoy = writeDecoyParentTranscript(dir, 'parent-decoy-trunc.jsonl', 'decoy/trunc.mjs');
    const bigChild = join(dir, 't', 'agent-big.jsonl');
    mkdirSync(dirname(bigChild), { recursive: true });
    const bigLine = JSON.stringify(toolLine([textBlock('x'.repeat(1_100_000))]));
    const readLine = JSON.stringify(toolLine([toolUse('Read', { file_path: join(dir, 'src/after-big.mjs') })]));
    writeFileSync(bigChild, bigLine + '\n' + readLine + '\n');

    const r = runHook(h22Input(dir, { agent_id: 'rev-trunc', hook_event_name: 'SubagentStop', transcript_path: parentDecoy, agent_transcript_path: bigChild }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = findEntryByDeclaredFile(readLedger(dir), 'src/declared.mjs');
    assert.ok(entry, 'the promoted receipt is found by its declared file');
    assert.equal(entry.observed_truncated, true, 'a departing transcript exceeding the 1MB tail window promotes observed_truncated:true');
  } finally {
    cleanup();
  }
});
