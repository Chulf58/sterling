// GLOB LITERAL-PREFIX EXTRACTION + WIRING — board a63b226d ("GLOB BLIND
// SPOT"), research_finding foreign_289cd172's "a SEPARATE blind spot, in both
// directions". AUTHORED BY coder, for a test-writer to land verbatim.
// Suggested target: scripts/tests/dispatch-advisory-glob-prefix.test.mjs
//
// GROUP B (h22-dispatch-register.mjs `claimed_glob_prefixes`, the register
// write side) and GROUP C (h26-dispatch-overlap.mjs prefix-aware overlap
// comparison) are DELETED WHOLE: `claimed_glob_prefixes` had no non-test
// reader (research_finding h22-dispatch-register-consumer-map-which-parts-
// have-a-reader-september-2026) and h26-dispatch-overlap.mjs is already
// deleted under the scale-down decision (sterling-claude-code-scale-down-
// boundary, 2ad87dd1). Only GROUP A survives — the pure-function extractor
// (extractGlobPrefixCandidates) and its detector integration remain exported
// from scripts/hooks/lib/dispatch-advisory.mjs (hasUnsuppressedMatch is still
// live via scripts/hooks/lib/dispatch-residue.mjs), even though H22 no longer
// calls extractGlobPrefixCandidates itself.
//
// The surviving GROUP A's CONTROL is placed first and passes for a
// DIFFERENT, simpler reason than the positive cases that follow it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractGlobPrefixCandidates,
  hasUnsuppressedMatch,
  escapeRe,
} from '../hooks/lib/dispatch-advisory.mjs';

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
// (A6) RE-CUT (board 59c30a7f, 2026-08-27): this arm used to pin a
// DELIBERATELY DISCLOSED gap — isNegatedContext only inspected text BEFORE a
// mention, so a trailing prohibition after a glob mention did NOT suppress
// it, and the assertion below read `assert.equal(stillUnsuppressed, true)`.
// That premise is no longer true: board 59c30a7f added a backward reach
// (scripts/hooks/lib/dispatch-advisory.mjs, the shared detector) that
// suppresses a trailing anaphoric territory prohibition for ANY mention
// shape, literal or glob — the glob interaction was never a second
// heuristic, so it inherits the fix automatically (see
// dispatch-advisory-trailing-prohibition.test.mjs (A4) for the same shape
// pinned directly on the shared detector). Leaving this assertion as `true`
// would now assert something FALSE at HEAD, so it is inverted, not bent.
// SABOTAGE: drop the `|| trailingSuppresses` term in hasUnsuppressedMatch —
// this flips back to unsuppressed (the pre-59c30a7f behavior), reproducing
// the gap this arm now asserts is closed.
// ---------------------------------------------------------------------------
test('(A6) a TRAILING prohibition after a glob mention now suppresses it (board 59c30a7f)', () => {
  const prompt = 'Other agents own scripts/hooks/** — do not touch those.';
  const [prefix] = extractGlobPrefixCandidates(prompt);
  const suppressed = !hasUnsuppressedMatch(prompt, new RegExp(escapeRe(`${prefix}**`)), { checkSubjectVerb: false });
  assert.equal(suppressed, true);
});
