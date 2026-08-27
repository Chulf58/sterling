// TRAILING PROHIBITION MARKERS — board 59c30a7f, the complement of board
// c56862a9 (write-side negation, shipped in 5eea229). `isNegatedContext`
// inspects only the text BEFORE a mention, so a prohibition that arrives
// AFTER the paths ("Other lanes own A, B, C — do not edit those") never
// reaches back to them and the paths stay CLAIMED. Reproduced live
// 2026-08-27 at HEAD with the write-side fix already in place.
//
// AUTHORED BY coder (H5 denied the direct write), for a test-writer to land
// verbatim at scripts/tests/dispatch-advisory-trailing-prohibition.test.mjs.
//
// THE FIX IS IN THE ONE SHARED DETECTOR (scripts/hooks/lib/dispatch-advisory.mjs)
// — never a second heuristic (that divergence WAS the c56862a9 defect) — so
// every consumer (h22 write side, h26 read side, h25) inherits it at once.
// The reach is DELIBERATELY NARROW because over-suppression silently DELETES
// real overlap warnings, which is worse than the false positive being fixed:
// it reaches back exactly ONE clause, only when the trailing clause is an
// ANAPHORIC TERRITORY PROHIBITION (prohibition marker + territory verb +
// back-referring pronoun, naming NO path of its own) and the two clauses are
// not separated by a paragraph break.
//
// FOUR TEST GROUPS, EACH WITH ITS CONTROL PLACED FIRST (a suppression pin is
// especially prone to passing for the wrong reason — an assertion that
// "nothing was claimed" is satisfied just as well by an extractor that found
// nothing at all, so every group opens with an arm that must pass for the
// OPPOSITE reason):
//   A. the shared detector — the positive reach.
//   B. the shared detector — the BOUNDS on that reach (over-suppression).
//   C. h26-dispatch-overlap.mjs end-to-end, VERDICT CARRIER = the READ side
//      (the live register entry is a hand-written fixture, so only h26's own
//      extraction can change the verdict).
//   D. h22-dispatch-register.mjs, VERDICT CARRIER = the WRITE side
//      (`claimed_files`), with `files` pinned UNCHANGED beside it — the
//      receipt/residue/H10 breadth must survive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasUnsuppressedMatch, escapeRe } from '../hooks/lib/dispatch-advisory.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');
const H26_PATH = join(HOOKS, 'h26-dispatch-overlap.mjs');

/** The one call every path-side consumer makes (h22 claimedFromBlocks, h26). */
const claimed = (prompt, path) =>
  hasUnsuppressedMatch(prompt, new RegExp(escapeRe(path)), { checkSubjectVerb: false });

// ===========================================================================
// GROUP A — the shared detector: the backward reach itself
// ===========================================================================

// ---------------------------------------------------------------------------
// (A0) CONTROL, PLACED FIRST, PASSES FOR THE OPPOSITE REASON: an ordinary
// positive territory declaration with NO trailing prohibition anywhere stays
// CLAIMED. If this ever goes red, the fixture's path is simply not being
// extracted/matched and every "not claimed" assertion below would pass
// vacuously.
// SABOTAGE: make the trailing check unconditional (`trailingSuppresses = true`)
// in hasUnsuppressedMatch — this control flips red while the positives stay
// green, which is exactly the over-suppression the bound exists to prevent.
// ---------------------------------------------------------------------------
test('(A0) CONTROL: a plain positive claim with no trailing prohibition stays CLAIMED', () => {
  assert.equal(claimed('YOUR TERRITORY: scripts/hooks/lib/dispatch-advisory.mjs — own this file.', 'scripts/hooks/lib/dispatch-advisory.mjs'), true);
});

// ---------------------------------------------------------------------------
// (A1) THE MEASURED SHAPE (board 59c30a7f, verbatim class): an em-dash SOFT
// boundary splits the paths off from the prohibition that follows them, so
// the marker lands in the NEXT clause. Every path in the list must be
// suppressed, not merely the last one.
// SABOTAGE: drop the `|| trailingSuppresses` term in hasUnsuppressedMatch —
// both assertions flip to claimed (the pre-fix behavior).
// ---------------------------------------------------------------------------
test('(A1) em-dash: "Other live lanes own A, B — do not edit those." suppresses EVERY path in the list', () => {
  const prompt =
    'Other live lanes own scripts/hooks/h3-contract-gate.mjs, scripts/hooks/lib/dispatch-advisory.mjs — do not edit those.';
  assert.equal(claimed(prompt, 'scripts/hooks/h3-contract-gate.mjs'), false);
  assert.equal(claimed(prompt, 'scripts/hooks/lib/dispatch-advisory.mjs'), false);
});

// ---------------------------------------------------------------------------
// (A2) SEMICOLON, the second boundary shape the board names: ';' is a HARD
// split, so the paths and the marker land in different clauses for the same
// reason. The reach must cross a hard boundary too — it is bounded by the
// PARAGRAPH break (see B3), not by hardness.
// SABOTAGE: restrict the reach to soft boundaries only (skip when the clause
// ended on a hard boundary) — this goes red while (A1) stays green.
// ---------------------------------------------------------------------------
test('(A2) semicolon: "…own scripts/domain-doctor.mjs; do not touch it." suppresses the path', () => {
  assert.equal(claimed('Another lane owns scripts/domain-doctor.mjs; do not touch it.', 'scripts/domain-doctor.mjs'), false);
});

// ---------------------------------------------------------------------------
// (A3) SENTENCE PERIOD: the same shape written as two sentences.
// SABOTAGE: same as (A1).
// ---------------------------------------------------------------------------
test('(A3) sentence boundary: "…owns packages/store/src/db.ts. Do NOT modify those." suppresses the path', () => {
  assert.equal(claimed('A parallel lane owns packages/store/src/db.ts. Do NOT modify those.', 'packages/store/src/db.ts'), false);
});

// ---------------------------------------------------------------------------
// (A4) THE GLOB INTERACTION the board demands be re-verified (board a63b226d
// landed the glob-prefix extractor in this same file): a glob claim followed
// by a trailing prohibition must suppress exactly as a literal path does —
// suppression is plain clause-scoped text analysis and never depends on the
// mention being file-shaped.
// SABOTAGE: same as (A1).
// ---------------------------------------------------------------------------
test('(A4) GLOB + trailing prohibition: "Other agents own scripts/hooks/** — do not touch those." suppresses the glob token', () => {
  assert.equal(claimed('Other agents own scripts/hooks/** — do not touch those.', 'scripts/hooks/**'), false);
});

// ---------------------------------------------------------------------------
// (A5) REGRESSION CONTROL: the pre-existing LEADING prohibition reach is
// untouched — the new backward reach is additive, never a replacement.
// SABOTAGE: replace the leading `isSuppressedContext` call with `false` —
// this goes red while (A1)-(A4) stay green, proving the two reaches are
// independent carriers.
// ---------------------------------------------------------------------------
test('(A5) REGRESSION: a LEADING prohibition still suppresses (the old reach is unchanged)', () => {
  assert.equal(claimed('DO NOT TOUCH: scripts/hooks/h15-store-guard.mjs (another lane owns it).', 'scripts/hooks/h15-store-guard.mjs'), false);
});

// ===========================================================================
// GROUP B — the BOUNDS: shapes that must NOT be suppressed
//
// Every test here is a control in its own right: it must pass for the
// OPPOSITE reason to Group A (the path IS claimed). Over-suppression is the
// expensive direction — it silently removes real overlap warnings — so these
// are the tests that make the reach safe rather than merely present.
// ===========================================================================

// ---------------------------------------------------------------------------
// (B0) NON-TERRITORY VERB: "do not break it" is a prohibition about the
// CHANGE, not a disclaimer of territory. The lane genuinely owns the file.
// SABOTAGE: drop the territory-verb requirement from
// TRAILING_PROHIBITION_RE (accept any prohibition marker) — this flips to a
// silently unclaimed lane.
// ---------------------------------------------------------------------------
test('(B0) BOUND: "Fix packages/store/src/db.ts — do not break it." stays CLAIMED (non-territory verb)', () => {
  assert.equal(claimed('Fix packages/store/src/db.ts — do not break it.', 'packages/store/src/db.ts'), true);
});

// ---------------------------------------------------------------------------
// (B1) NO ANAPHOR: a trailing prohibition that governs something else
// entirely must not reach back. Without the back-referring pronoun there is
// nothing tying the prohibition to the preceding paths.
// SABOTAGE: drop the anaphor requirement from TRAILING_PROHIBITION_RE —
// flips to unclaimed.
// ---------------------------------------------------------------------------
test('(B1) BOUND: "YOUR FILES: src/auth.mjs — do not edit anything without asking." stays CLAIMED (no anaphor)', () => {
  assert.equal(claimed('YOUR FILES: src/auth.mjs — do not edit anything without asking.', 'src/auth.mjs'), true);
});

// ---------------------------------------------------------------------------
// (B2) THE TRAILING CLAUSE NAMES A PATH OF ITS OWN: ambiguous between a
// back-reference and a fresh prohibition, so the reach declines (the
// conservative direction). This fixture is chosen so the PATH GUARD is the
// actual verdict carrier — the anaphor/verb windows both match here, so only
// the guard can produce the verdict.
// SABOTAGE: drop the path-candidate guard in isAnaphoricProhibitionClause —
// src/auth.mjs flips to unclaimed (a real lane silently loses its territory).
// ---------------------------------------------------------------------------
test('(B2) BOUND: a trailing prohibition naming a path of its OWN does not reach back', () => {
  const prompt = 'YOUR FILES: src/auth.mjs — do not touch those, and never open packages/store/src/db.ts.';
  assert.equal(claimed(prompt, 'src/auth.mjs'), true);
  assert.equal(claimed(prompt, 'packages/store/src/db.ts'), false);
});

// ---------------------------------------------------------------------------
// (B3) PARAGRAPH BREAK stops the reach: a blank line ends the passage the
// anaphor could plausibly refer to. This is the bound that keeps a
// prohibition at the bottom of a long brief from silently erasing the
// territory section at the top.
// SABOTAGE: force `endedByParagraphBreak` to false in scanClauses — flips to
// unclaimed.
// ---------------------------------------------------------------------------
test('(B3) BOUND: a PARAGRAPH BREAK between the claim and the prohibition stops the reach', () => {
  assert.equal(claimed('YOUR FILES: src/auth.mjs\n\nDo not touch those.', 'src/auth.mjs'), true);
});

// ---------------------------------------------------------------------------
// (B4) ONE CLAUSE ONLY: an intervening clause ends the reach.
// SABOTAGE: scan all following clauses instead of just the next one — flips
// to unclaimed.
// ---------------------------------------------------------------------------
test('(B4) BOUND: the reach is ONE clause — an intervening clause ends it', () => {
  assert.equal(claimed('YOUR FILES: src/auth.mjs — this is the whole lane — do not touch those.', 'src/auth.mjs'), true);
});

// ===========================================================================
// Shared hook-harness plumbing
// (mirrors scripts/tests/dispatch-advisory-glob-prefix.test.mjs)
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-trailingproh-'));
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

// The live neighbour lane, written DIRECTLY as a fixture: nothing about this
// entry is produced by the code under test, so the ONLY thing that can change
// the verdict in Group C is h26's own extraction of the OUTGOING prompt —
// that is what NAMES THE READ SIDE as the verdict carrier for these two.
const LIVE_NEIGHBOUR = [
  {
    agent_id: 'sub-1',
    agent_type: 'coder',
    session_id: 's1',
    files: ['scripts/hooks/lib/dispatch-advisory.mjs'],
    claimed_files: ['scripts/hooks/lib/dispatch-advisory.mjs'],
    claimed_glob_prefixes: [],
    attribution: 'block',
    at: new Date().toISOString(),
  },
];

// ===========================================================================
// GROUP C — h26 end-to-end; VERDICT CARRIER: the READ side
// ===========================================================================

// ---------------------------------------------------------------------------
// (C0) CONTROL, PLACED FIRST: the identical fixture with a POSITIVE claim in
// the outgoing brief DOES warn. Without this arm, (C1)'s silence could just
// as well mean the fixture never had a live neighbour to collide with.
// SABOTAGE: make the trailing check unconditional in hasUnsuppressedMatch —
// this control flips silent.
// ---------------------------------------------------------------------------
test('(C0) CONTROL: a POSITIVE claim on the neighbour\'s file still warns (the fixture can collide)', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, LIVE_NEIGHBOUR);
    const r = h26Task(dir, { prompt: 'YOUR TERRITORY: scripts/hooks/lib/dispatch-advisory.mjs — add the backward reach.' });
    const ctx = advisoryText(r);
    assert.match(ctx, /scripts\/hooks\/lib\/dispatch-advisory\.mjs/);
    assert.ok(ctx.includes('coder:sub-1'));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (C1) THE REPRODUCED FALSE POSITIVE (board 59c30a7f, measured 2026-08-27):
// the outgoing brief is FORBIDDEN to touch the neighbour's file by a TRAILING
// clause, and was warned about it anyway. Must be silent.
// SABOTAGE: drop the `|| trailingSuppresses` term in hasUnsuppressedMatch —
// the warning comes back, reproducing the measured defect.
// ---------------------------------------------------------------------------
test('(C1) READ SIDE: a trailing-prohibition brief no longer warns on the forbidden path', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeRegister(dir, LIVE_NEIGHBOUR);
    const r = h26Task(dir, {
      prompt:
        'YOUR TERRITORY: scripts/domain-doctor.mjs. Other live lanes own scripts/hooks/h3-contract-gate.mjs, scripts/hooks/lib/dispatch-advisory.mjs — do not edit those.',
    });
    assert.equal(advisoryText(r), '');
    assert.notEqual(r.code, 2);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP D — h22 register; VERDICT CARRIER: the WRITE side (`claimed_files`)
// ===========================================================================

// ---------------------------------------------------------------------------
// (D0) CONTROL, PLACED FIRST: a positive claim registers in BOTH fields —
// so (D1)'s absence from claimed_files cannot be read as "h22 registered
// nothing at all".
// SABOTAGE: make the trailing check unconditional in hasUnsuppressedMatch —
// claimed_files empties and this control flips red.
// ---------------------------------------------------------------------------
test('(D0) CONTROL: a positive claim lands in BOTH files and claimed_files', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [['coder', 'YOUR TERRITORY: scripts/hooks/lib/dispatch-advisory.mjs — own this file.']]);
    assert.equal(subagentStart(dir).code, 0);
    const [entry] = readRegister(dir);
    assert.deepEqual(entry.files, ['scripts/hooks/lib/dispatch-advisory.mjs']);
    assert.deepEqual(entry.claimed_files, ['scripts/hooks/lib/dispatch-advisory.mjs']);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (D1) WRITE SIDE: a trailing-prohibition brief keeps the path OUT of
// claimed_files (write territory) while `files` still records it — the
// receipt/residue/H10 breadth that research_finding 289cd172 protects must
// not narrow. Two assertions, two different carriers, deliberately in one
// test: the pin is precisely that the two fields DIVERGE here.
// SABOTAGE: drop the `|| trailingSuppresses` term in hasUnsuppressedMatch —
// claimed_files regains the forbidden path (first assertion red, second
// still green, so the failure names the write side).
// ---------------------------------------------------------------------------
test('(D1) WRITE SIDE: a trailing prohibition drops the path from claimed_files but NOT from files', () => {
  const { dir, cleanup } = makeProject();
  try {
    writeTranscript(dir, [
      [
        'coder',
        'YOUR TERRITORY: scripts/domain-doctor.mjs. Other live lanes own scripts/hooks/lib/dispatch-advisory.mjs — do not edit those.',
      ],
    ]);
    assert.equal(subagentStart(dir).code, 0);
    const [entry] = readRegister(dir);
    assert.deepEqual(entry.claimed_files, ['scripts/domain-doctor.mjs']);
    assert.ok(entry.files.includes('scripts/hooks/lib/dispatch-advisory.mjs'), 'files must keep the full MENTIONED breadth for receipts/residue/H10');
  } finally {
    cleanup();
  }
});
