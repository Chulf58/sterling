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
// TWO TEST GROUPS SURVIVE, EACH WITH ITS CONTROL PLACED FIRST (a suppression
// pin is especially prone to passing for the wrong reason — an assertion
// that "nothing was claimed" is satisfied just as well by an extractor that
// found nothing at all, so every group opens with an arm that must pass for
// the OPPOSITE reason):
//   A. the shared detector — the positive reach.
//   B. the shared detector — the BOUNDS on that reach (over-suppression).
//
// GROUP C (h26-dispatch-overlap.mjs end-to-end) and GROUP D
// (h22-dispatch-register.mjs `claimed_files` WRITE side) are DELETED WHOLE:
// h26-dispatch-overlap.mjs is already deleted under the scale-down decision
// (sterling-claude-code-scale-down-boundary, 2ad87dd1), and `claimed_files`
// had no non-test reader (research_finding h22-dispatch-register-consumer-
// map-which-parts-have-a-reader-september-2026) — h22's SubagentStart no
// longer computes or writes it. hasUnsuppressedMatch/escapeRe (GROUPS A/B
// below) remain live via scripts/hooks/lib/dispatch-residue.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasUnsuppressedMatch, escapeRe } from '../hooks/lib/dispatch-advisory.mjs';

/** The one call every path-side consumer makes (dispatch-residue's claimedResources). */
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
