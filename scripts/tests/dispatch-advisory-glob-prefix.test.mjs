// GLOB LITERAL-PREFIX EXTRACTION + WIRING — board a63b226d ("GLOB BLIND
// SPOT"), research_finding 289cd172's "a SEPARATE blind spot, in both
// directions". AUTHORED BY coder, for a test-writer to land verbatim.
// Suggested target: scripts/tests/dispatch-advisory-glob-prefix.test.mjs
//
// THREE FILES TOUCHED BY THIS CHANGE, THREE TEST GROUPS:
//   A. scripts/hooks/lib/dispatch-advisory.mjs — extractGlobPrefixCandidates(),
//      the extractor + its MINIMUM-TWO-SEGMENT bound (conductor-directed,
//      flood-risk mitigation).
//   B. scripts/hooks/h22-dispatch-register.mjs — globPrefixesFromBlocks(),
//      writing the negation-checked prefix claims into `claimed_glob_prefixes`
//      (its OWN field, `claimed_files` stays byte-identical).
//   C. scripts/hooks/h26-dispatch-overlap.mjs — prefix-aware (startsWith)
//      overlap comparison, applied ONLY to `claimed_glob_prefixes`; exact
//      equality on `claimed_files`/`files` is completely unchanged.
//
// Each group's CONTROL is placed first and passes for a DIFFERENT, simpler
// reason than the positive cases that follow it — per group, not just once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractGlobPrefixCandidates,
  hasUnsuppressedMatch,
  escapeRe,
} from '../hooks/lib/dispatch-advisory.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');
const H26_PATH = join(HOOKS, 'h26-dispatch-overlap.mjs');

// ===========================================================================
// GROUP A — pure-function tests, scripts/hooks/lib/dispatch-advisory.mjs
// ===========================================================================

// ---------------------------------------------------------------------------
// (A0) CONTROL, PLACED FIRST: an ordinary literal file-path mention with no
// glob marker extracts nothing — passes for the structural absence of '**',
// unrelated to the segment-count bound every positive case below depends on.
// SABOTAGE: drop the trailing `\*\*` requirement from GLOB_PREFIX_RE — an
// ordinary file path's directory prefix then matches too.
// ---------------------------------------------------------------------------
test('(A0) CONTROL: a plain literal file-path mention (no glob marker) extracts nothing', () => {
  assert.deepEqual(extractGlobPrefixCandidates('edit scripts/hooks/h22-dispatch-register.mjs today'), []);
});

// ---------------------------------------------------------------------------
// (A1) the board's own concrete example — two-segment literal-prefix glob.
// ---------------------------------------------------------------------------
test('(A1) "YOUR FILES: scripts/hooks/**" extracts the literal prefix "scripts/hooks/"', () => {
  assert.deepEqual(extractGlobPrefixCandidates('YOUR FILES: scripts/hooks/** — own this directory.'), ['scripts/hooks/']);
});

// ---------------------------------------------------------------------------
// (A2) THE BOUND: a single-segment glob ("scripts/**") must NOT extract —
// this is the flood-risk mitigation the conductor directed (a one-segment
// prefix like "scripts/**" or "packages/**" would make nearly every lane in
// this repo overlap nearly every other one).
// SABOTAGE: change `(?:[\w-]+\/){2,}` back to `(?:[\w-]+\/)+` (drop the
// lower bound) — flips this to ["scripts/"]. (A1) is UNAFFECTED (it already
// has two segments), proving the sabotage targets exactly the bound.
// ---------------------------------------------------------------------------
test('(A2) BOUND: single-segment glob "scripts/**" extracts NOTHING (flood-risk mitigation)', () => {
  assert.deepEqual(extractGlobPrefixCandidates('own scripts/** for this lane'), []);
});

// ---------------------------------------------------------------------------
// (A3) hyphenated directory segment — real, common shape (mcp-server, …).
// SABOTAGE: change `[\w-]+` to `[\w]+` (drop the hyphen) — "mcp-server/"
// can no longer match as one segment, so the regex instead finds the
// SHORTER match "server/**", and extraction silently returns the WRONG
// partial prefix ["server/"] rather than going empty — the dangerous
// failure mode.
// ---------------------------------------------------------------------------
test('(A3) hyphenated segment "packages/mcp-server/**" extracts the full literal prefix, not a partial match', () => {
  assert.deepEqual(extractGlobPrefixCandidates('territory: packages/mcp-server/**'), ['packages/mcp-server/']);
});

// ---------------------------------------------------------------------------
// (A4) dedup — the same glob token mentioned twice yields one entry.
// SABOTAGE: drop `new Set(...)` — length becomes 2.
// ---------------------------------------------------------------------------
test('(A4) the same glob mentioned twice extracts exactly one deduped entry', () => {
  assert.deepEqual(extractGlobPrefixCandidates('own scripts/hooks/**, really, scripts/hooks/** is all yours'), ['scripts/hooks/']);
});

// ---------------------------------------------------------------------------
// (A5) INTEGRATION (documents, does not newly pin pre-existing logic): a
// leading prohibition suppresses a glob mention exactly as it would a
// literal path — no new suppression code was written for this.
// ---------------------------------------------------------------------------
test('(A5) INTEGRATION: a leading prohibition suppresses a glob mention exactly as it would a literal path', () => {
  const prompt = 'Do not touch scripts/hooks/** (another lane owns those).';
  const [prefix] = extractGlobPrefixCandidates(prompt);
  assert.equal(prefix, 'scripts/hooks/');
  const suppressed = !hasUnsuppressedMatch(prompt, new RegExp(escapeRe(`${prefix}**`)), { checkSubjectVerb: false });
  assert.equal(suppressed, true);
});

// ---------------------------------------------------------------------------
// (A6) DISCLOSED, NOT FIXED HERE: the pre-existing trailing-marker defect
// (isNegatedContext only inspects text BEFORE the mention) applies to glob
// mentions exactly as it already does to literal paths. Expected TRUE
// (not suppressed) both before and after this change.
// ---------------------------------------------------------------------------
test('(A6) DISCLOSED GAP (unchanged by this addition): a TRAILING prohibition after a glob mention does not suppress it', () => {
  const prompt = 'Other agents own scripts/hooks/** — do not touch those.';
  const [prefix] = extractGlobPrefixCandidates(prompt);
  const stillUnsuppressed = hasUnsuppressedMatch(prompt, new RegExp(escapeRe(`${prefix}**`)), { checkSubjectVerb: false });
  assert.equal(stillUnsuppressed, true);
});

// ===========================================================================
// Shared hook-harness plumbing (mirrors scripts/tests/h22-claimed-territory.test.mjs)
// ===========================================================================

function runHook(hookPath, input, cwd) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-globprefix-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [] }));
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeTranscript(dir, blocks) {
  const p = join(dir, 't', 'parent.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  const line = {
    type: 'assistant',
    message: { content: blocks.map(([subagent_type, prompt]) => ({ type: 'tool_use', name: 'Task', input: { subagent_type, prompt } })) },
  };
  writeFileSync(p, JSON.stringify(line) + '\n');
}

function subagentStart(dir, { agent_id = 'a1', agent_type = 'coder', session_id = 's1' } = {}) {
  return runHook(
    H22_PATH,
    { hook_event_name: 'SubagentStart', session_id, transcript_path: join(dir, 't', 'parent.jsonl'), cwd: dir, agent_id, agent_type },
    dir
  );
}

function readRegister(dir) {
  return JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), 'utf8'));
}

function writeRegister(dir, entries) {
  writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), JSON.stringify(entries));
}

function h26Task(dir, { subagent_type = 'coder', prompt, session_id = 's1' }) {
  return runHook(H26_PATH, { hook_event_name: 'PreToolUse', tool_name: 'Task', session_id, cwd: dir, tool_input: { subagent_type, prompt } }, dir);
}

function advisoryText(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout was not valid JSON: ${JSON.stringify(r.stdout)}`);
  }
  return parsed?.hookSpecificOutput?.additionalContext ?? '';
}

// ===========================================================================
// GROUP B — h22-dispatch-register.mjs: `claimed_glob_prefixes`
// ===========================================================================

// ---------------------------------------------------------------------------
// (B0) CONTROL, PLACED FIRST: a single-segment glob claim registers an EMPTY
// claimed_glob_prefixes — the bound holding at the register-write boundary,
// not "the wiring is broken". Reuses (A2)'s sabotage for consistency.
// SABOTAGE: revert the bound (`{2,}` -> `+`) in dispatch-advisory.mjs —
// flips to a non-empty claimed_glob_prefixes.
// ---------------------------------------------------------------------------
test('(B0) CONTROL: SubagentStart with "YOUR FILES: scripts/**" (single segment) registers claimed_glob_prefixes: []', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'YOUR FILES: scripts/** — own this for the lane.']]);
    const r = subagentStart(dir);
    assert.equal(r.code, 0);
    const [entry] = readRegister(dir);
    assert.deepEqual(entry.claimed_glob_prefixes, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (B1) two-segment glob claim registers the literal prefix.
// SABOTAGE: remove the `claimed_glob_prefixes` key from newEntry in h22 —
// the field disappears from the register entirely (undefined, not []).
// ---------------------------------------------------------------------------
test('(B1) SubagentStart with "YOUR FILES: scripts/hooks/**" registers claimed_glob_prefixes: ["scripts/hooks"]', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'YOUR FILES: scripts/hooks/** — own this directory.']]);
    const r = subagentStart(dir);
    assert.equal(r.code, 0);
    const [entry] = readRegister(dir);
    assert.deepEqual(entry.claimed_glob_prefixes, ['scripts/hooks']);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (B2) a PROHIBITED glob never registers as claimed (shared suppression,
// board a63b226d point 3 — one detector, not a second heuristic).
// SABOTAGE: drop the `hasUnsuppressedMatch` filter from
// globPrefixesFromBlocks in h22 — the prohibited prefix leaks into
// claimed_glob_prefixes despite "DO NOT TOUCH".
// ---------------------------------------------------------------------------
test('(B2) "DO NOT TOUCH: scripts/hooks/** (another lane owns it)" registers claimed_glob_prefixes: []', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'DO NOT TOUCH: scripts/hooks/** (another lane owns it). Fix the parser instead.']]);
    const r = subagentStart(dir);
    assert.equal(r.code, 0);
    const [entry] = readRegister(dir);
    assert.deepEqual(entry.claimed_glob_prefixes, []);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP C — h26-dispatch-overlap.mjs: prefix-aware comparison, end-to-end
// ===========================================================================

// ---------------------------------------------------------------------------
// (C0) CONTROL, PLACED FIRST, END-TO-END: a live dispatch claims a
// single-segment "scripts/**" through the REAL extraction pipeline; a later
// dispatch naming a file under scripts/ (but in a DIFFERENT subsystem,
// scripts/domain-doctor.mjs, not scripts/hooks/) never warns — the bound
// holding through the full write-then-read path is the actual protection
// against the flood scenario.
// SABOTAGE: revert the bound in dispatch-advisory.mjs (`{2,}` -> `+`) —
// flips to a warning.
// ---------------------------------------------------------------------------
test('(C0) CONTROL END-TO-END: a live single-segment "scripts/**" claim never overlaps a later dispatch under scripts/ (bound holds)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'YOUR FILES: scripts/** — own this lane.']]);
    subagentStart(dir, { agent_id: 'a1' });
    const r = h26Task(dir, { prompt: 'fix a bug in scripts/domain-doctor.mjs' });
    assert.equal(advisoryText(r), '');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (C1) THE CONCRETE REPRODUCTION requested: a live dispatch claims
// "packages/mcp-server/**"; a later dispatch naming a specific file under it
// warns, prefix-aware.
// SABOTAGE: in h26, force `matchedPrefix = []` (remove prefix-aware
// comparison) — flips silent.
// ---------------------------------------------------------------------------
test('(C1) a live "packages/mcp-server/**" claim overlaps a later dispatch naming a file under it', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'YOUR FILES: packages/mcp-server/** — own this package for the refactor.']]);
    subagentStart(dir, { agent_id: 'a1' });
    const r = h26Task(dir, { prompt: 'implement the fix in packages/mcp-server/src/server.ts' });
    const ctx = advisoryText(r);
    assert.match(ctx, /packages\/mcp-server\/src\/server\.ts/);
    assert.ok(ctx.includes('coder:a1'));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (C2) BOUNDARY DISCIPLINE: "packages/mcp-server-utils/x.ts" merely SHARES A
// STRING PREFIX with a claimed "packages/mcp-server/**" but is a sibling
// directory, not a descendant — must NOT warn.
// SABOTAGE: change `f.startsWith(`${p}/`)` to `f.startsWith(p)` in h26
// (drop the '/' boundary) — flips to a false warning.
// ---------------------------------------------------------------------------
test('(C2) BOUNDARY: "packages/mcp-server-utils/x.ts" does not overlap a claimed "packages/mcp-server/**" (sibling, not descendant)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'YOUR FILES: packages/mcp-server/** — own this package.']]);
    subagentStart(dir, { agent_id: 'a1' });
    const r = h26Task(dir, { prompt: 'edit packages/mcp-server-utils/x.ts for an unrelated helper package' });
    assert.equal(advisoryText(r), '');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (C3) LEGACY register entry with NO claimed_glob_prefixes field at all
// never crashes and never prefix-warns (falls back to exact-only, exactly
// today's pre-migration behavior).
// SABOTAGE: drop the `Array.isArray(e.claimed_glob_prefixes)` guard in h26
// (assume the field is always an array) — throws on this fixture.
// ---------------------------------------------------------------------------
test('(C3) LEGACY: a register entry with no claimed_glob_prefixes field never crashes and never prefix-warns', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, [{ agent_id: 'sub-1', agent_type: 'coder', session_id: 's1', files: ['src/shared/util.mjs'], claimed_files: ['src/shared/util.mjs'], at: new Date().toISOString(), attribution: 'block' }]);
    const r = h26Task(dir, { prompt: 'edit packages/mcp-server/src/server.ts today' });
    assert.notEqual(r.code, 2);
    assert.equal(advisoryText(r), '');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (C4) END-TO-END SUPPRESSION: a PROHIBITED glob claim never overlaps a
// later dispatch naming a file under it — the read-path proof that (B2)'s
// write-path suppression actually closes the loop.
// SABOTAGE: same as (B2) — drop the suppression filter in
// globPrefixesFromBlocks — flips to a false warning.
// ---------------------------------------------------------------------------
test('(C4) a PROHIBITED "packages/mcp-server/**" claim never overlaps a later dispatch naming a file under it', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'DO NOT TOUCH: packages/mcp-server/** (another lane owns it). Fix the CLI instead.']]);
    subagentStart(dir, { agent_id: 'a1' });
    const r = h26Task(dir, { prompt: 'implement the fix in packages/mcp-server/src/server.ts' });
    assert.equal(advisoryText(r), '');
  } finally {
    cleanup();
  }
});
