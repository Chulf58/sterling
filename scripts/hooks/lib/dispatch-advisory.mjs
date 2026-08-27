// SHARED PROHIBITION/NEGATION DETECTION (board a6b76e8c) for the dispatch-time
// advisories: H25 (capability + test-authoring) and H26 (overlap). A
// tool/file mention that appears inside a PROHIBITION, or that names the
// SUBJECT of an implement/fix/review task, must not count as a requirement
// or territory claim — one shared, pragmatic, clause-scoped detector, not two
// independently-drifting heuristics (board a6b76e8c: "a single fix in shared
// extraction logic, not two independent heuristics").
//
// SHAPE (pragmatic, not exhaustive — the largest measured classes are the
// target, not perfection): the prompt is split into CLAUSES on sentence-ish
// boundaries (a comma is deliberately NOT a boundary — "do not touch X, just
// fix Y" is one prohibition spanning a comma; mirrors the pre-existing H25
// test-authoring clause split). Within the clause holding a mention, TWO
// negator classes suppress it, with DIFFERENT reach (round-2 fixer split,
// see the repro table below): a PROHIBITION MARKER (do not / don't /
// forbid(den) / denies / denied / ⛔) ANYWHERE earlier in the same clause —
// unbounded, because a prohibition list can be long ("DO NOT TOUCH:
// scripts/hooks/, scripts/enforcement-stamp.mjs (another lane owns
// those)"); or a BARE NEGATOR (never / no / without) within a short bounded
// token window immediately before the mention, with no comma in between —
// bounded, because these are used idiomatically ("never mind", "without
// delay") with an unrelated instruction following in the same clause. A
// SUBJECT-OF-CHANGE VERB (implement/fix/review) suppresses a mention within
// a narrower trailing window immediately before it ("implement board_remove
// in TypeScript" — the tool is the SUBJECT of the code change, not a
// capability need), kept tight so an unrelated earlier verb in a long
// clause does not over-suppress.
//
// Measured shapes this catches (board a6b76e8c addendum): "DO NOT create or
// edit any test file", "do NOT run X", "You hold no Bash by design", "never
// board_add", "⛔-forbidden lists", "DO NOT TOUCH: <paths> (another lane owns
// those)", quoted denial text ("H14 denies..."), and implement/fix/review-
// subject mentions.
//
// FOLLOW-UP ROUND 2 (board a6b76e8c, outside-model review) — two more
// measured repro shapes, kept here as a code-comment table since the pin
// file is frozen to the test-writer:
//
//   | # | prompt (to a tool-less/no-Bash agent)                | before | after |
//   |---|-------------------------------------------------------|--------|-------|
//   | 1 | "Never mind the old plan, use Bash to validate"        | silent (wrong) | warns |
//   | 2 | "Proceed without delay, use Bash to validate"          | silent (wrong) | warns |
//   | 3 | "never board_add" (control — must stay silent)         | silent | silent |
//   | 4 | "You hold no Bash by design" (control — must stay silent) | silent | silent |
//   | 5 | "DO NOT TOUCH — src/shared/util.mjs" (em/en dash header) | warns (wrong, false overlap) | silent |
//   | 6 | "DO NOT TOUCH:\r\nsrc/shared/util.mjs" (CRLF list form)  | warns (wrong, false overlap) | silent |
//
// (1)/(2): PROHIBITION MARKERS (do not/don't/forbid*/denies/denied/⛔) keep
// UNBOUNDED same-clause reach — they head long path lists ("DO NOT TOUCH:
// <list>") and must still catch a mention anywhere in that list. BARE
// NEGATORS (never/no/without) are much more often used idiomatically
// ("never mind", "without delay") with an unrelated instruction following in
// the same clause, so they get a BOUNDED reach instead: only a mention
// within BARE_NEGATOR_WINDOW tokens of the negator, with NO comma in
// between (a comma ends the negator's local phrase — "without delay, use
// Bash" has the comma right after the idiom, so 'Bash' escapes; "never
// board_add" and "no Bash" have no comma and are within the token window, so
// they still suppress).
//
// (5)/(6): a bare '.' is already the only period treated as sentence-ending
// (never inside a path), but a prohibition MARKER'S clause was still cut off
// from its payload by an em/en dash or a bare newline immediately following
// it — the marker and the mention landed in different clauses and the
// suppression never saw them together. splitClauses now treats a dash or a
// single newline as a SOFT boundary: it only splits there when the
// accumulated text since the last hard boundary does NOT already carry a
// prohibition marker; once a marker is present, the soft boundary is
// absorbed and the clause keeps extending — across further dashes/newlines
// — until a genuinely HARD boundary (a blank line, or a sentence-ending
// !?;/period) ends the list.
//
// A period is a clause boundary only when SENTENCE-ENDING (followed by
// whitespace or end-of-string) — a bare '.' can never split mid-path, because
// nearly every candidate mention here (a file path, an extension) contains
// one ("util.mjs", "h26-dispatch-overlap.mjs"); splitting on it unconditionally
// would sever the very mention this module exists to evaluate.
const HARD_BOUNDARY_RE = /(\r?\n[ \t]*\r?\n)|([!?;])|(\.(?=\s|$))|([–—]|\r?\n)/g;

// KNOWN IMPRECISION (disclosed, missed-warning direction, accepted): \bno\b's
// reach still spans the whole clause (bounded only by BARE_NEGATOR_WINDOW
// tokens / a comma, see above), so "we have no config, use Bash to probe" can
// still suppress 'Bash' when both fall inside that bound — the clause is
// reporting an absence, not forbidding the tool, and a genuine capability
// need can go unwarned. Pragmatic tradeoff (board a6b76e8c): a narrower
// bound would also start missing "no Bash" said one word apart, the
// measured shape this negator exists to catch.
const PROHIBITION_RE = String.raw`(?:\bdo\s*not\b|\bdon['’]?t\b|\bforbid(?:s|den)?\b|\bdenies\b|\bdenied\b|⛔)`;
const BARE_NEGATOR_RE = String.raw`\b(?:never|no|without)\b`;
const SUBJECT_VERB_RE = String.raw`(?:\bimplement(?:ing|ed|s)?\b|\bfix(?:ing|ed|es)?\b|\breview(?:ing|ed|s)?\b)`;

const PROHIBITION_TEST = new RegExp(PROHIBITION_RE, 'i');
const BARE_NEGATOR_TEST = new RegExp(BARE_NEGATOR_RE, 'gi');
const SUBJECT_VERB_TEST = new RegExp(SUBJECT_VERB_RE, 'i');
const SUBJECT_VERB_WINDOW = 40; // chars — pragmatic, narrower than the prohibition marker's whole-clause reach
const BARE_NEGATOR_WINDOW = 5; // tokens after the negator — pragmatic, see the repro table above

export function splitClauses(text) {
  const s = String(text ?? '');
  const clauses = [];
  let clauseStart = 0;
  HARD_BOUNDARY_RE.lastIndex = 0;
  let m;
  while ((m = HARD_BOUNDARY_RE.exec(s))) {
    const boundaryStart = m.index;
    const boundaryEnd = boundaryStart + m[0].length;
    const isHard = m[1] !== undefined || m[2] !== undefined || m[3] !== undefined;
    if (isHard) {
      clauses.push(s.slice(clauseStart, boundaryStart));
      clauseStart = boundaryEnd;
      continue;
    }
    // Soft boundary (dash or a single, non-blank newline): split normally,
    // UNLESS the text since the last hard boundary already carries a
    // prohibition marker — then absorb it and keep the clause extending.
    const soFar = s.slice(clauseStart, boundaryStart);
    if (PROHIBITION_TEST.test(soFar)) continue;
    clauses.push(soFar);
    clauseStart = boundaryEnd;
  }
  clauses.push(s.slice(clauseStart));
  return clauses;
}

/**
 * True when a prohibition marker appears anywhere earlier in `clause` than
 * `index` (unbounded reach), OR a bare negator (never/no/without) appears
 * within BARE_NEGATOR_WINDOW tokens before it with no comma in between
 * (bounded reach — see the repro table above).
 */
export function isNegatedContext(clause, index) {
  const text = String(clause ?? '');
  const before = text.slice(0, Math.max(0, index));
  if (PROHIBITION_TEST.test(before)) return true;
  BARE_NEGATOR_TEST.lastIndex = 0;
  let m;
  while ((m = BARE_NEGATOR_TEST.exec(before))) {
    const gap = before.slice(m.index + m[0].length);
    if (gap.includes(',')) continue; // a comma ends the bare negator's local phrase
    const tokenCount = (gap.match(/\S+/g) || []).length;
    if (tokenCount <= BARE_NEGATOR_WINDOW) return true;
  }
  return false;
}

/**
 * True when a subject-of-change verb (implement/fix/review) appears within
 * SUBJECT_VERB_WINDOW characters immediately before `index` in `clause`.
 * Deliberately narrower/positional (unlike the negator's whole-clause reach)
 * — this check names the SUBJECT of a code-change instruction ("implement
 * board_remove in TypeScript"), which only applies to a TOOL/CAPABILITY
 * mention; it must NOT suppress a genuine file-territory declaration
 * ("implement the new feature in packages/mcp-server/src/server.ts" is a
 * normal, legitimate territory claim, not a tool mention) — see the
 * `checkSubjectVerb` option on hasUnsuppressedMatch below.
 *
 * KNOWN IMPRECISION (disclosed, missed-warning direction, accepted): this
 * heuristic cannot distinguish the tool as OBJECT of the change from the
 * tool as INSTRUMENT of the change — "fix the bug using board_get" is
 * suppressed identically to "implement board_remove", even though the first
 * names a genuine capability need (board_get) and the second names the
 * subject being coded. Board a6b76e8c's measured classes are all
 * object-shaped ("implement board_remove in TypeScript"), so the tradeoff is
 * accepted rather than built out into verb-object parsing.
 */
export function isSubjectOfChangeContext(clause, index) {
  const text = String(clause ?? '');
  const before = text.slice(0, Math.max(0, index));
  const near = before.slice(Math.max(0, before.length - SUBJECT_VERB_WINDOW));
  return SUBJECT_VERB_TEST.test(near);
}

/**
 * True when the text BEFORE a mention at `index` in `clause` carries a
 * negator anywhere earlier in the same clause, or (when `checkSubjectVerb`)
 * a subject-of-change verb within SUBJECT_VERB_WINDOW characters immediately
 * before it.
 */
export function isSuppressedContext(clause, index, checkSubjectVerb = true) {
  if (isNegatedContext(clause, index)) return true;
  return checkSubjectVerb && isSubjectOfChangeContext(clause, index);
}

/**
 * True when `pattern` matches somewhere in `text` at an occurrence that is
 * NOT suppressed (see isSuppressedContext) — clause-scoped, so a negator
 * never reaches across a clause boundary, and every occurrence within a
 * clause is checked in turn (not just the first). A mention that occurs only
 * inside prohibition (or, when checked, subject-of-change) context returns
 * false: it never counted as a requirement or territory claim. `pattern` may
 * carry any flags (including none) — a global copy is used internally so the
 * caller's regex is never mutated.
 *
 * `checkSubjectVerb` (default true) governs whether the subject-of-change
 * verb window applies at all: TOOL/CAPABILITY mentions (H25) want it — "the
 * SUBJECT of the code change" applies to a tool name — but FILE/PATH
 * candidates (H26) must NOT get it, since "implement the new feature in
 * <path>" is exactly a legitimate territory declaration, not a subject-of-
 * change mention to discount. Callers pass `{ checkSubjectVerb: false }` for
 * path/territory matching.
 */
export function hasUnsuppressedMatch(text, pattern, { checkSubjectVerb = true } = {}) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  for (const clause of splitClauses(text)) {
    global.lastIndex = 0;
    let m;
    while ((m = global.exec(clause))) {
      if (!isSuppressedContext(clause, m.index, checkSubjectVerb)) return true;
      if (m.index === global.lastIndex) global.lastIndex++; // guard a zero-width match
    }
  }
  return false;
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GLOB LITERAL-PREFIX EXTRACTION (board a63b226d, research_finding 289cd172
// "a SEPARATE blind spot, in both directions"). PATH_CANDIDATE_RE
// (dispatch-prompt.mjs:27) hard-requires a literal '.' immediately after a
// directory prefix (the extension group) — a glob token like
// "scripts/hooks/**" contains no '.' at all, so extractPathCandidates()
// yields NOTHING for it: written as a positive claim it registers no
// territory, written as a prohibition it suppresses nothing, and both fail
// silently (proven by regex trace, not inferred — there is no starting
// index at which the extension atom can be satisfied when the string
// carries no '.'; pinned by the mutation-armed tests below, added under
// board a63b226d).
//
// SCOPE, DELIBERATELY NARROW (P1 — bounded under-warning beats a flood):
// this catches exactly ONE idiom, the measured one — a literal, non-glob
// directory prefix terminated by a bare '**' ("scripts/hooks/**",
// "packages/mcp-server/**"). It does NOT attempt general glob matching (no
// brace/char-class/single-star-without-directory support, e.g.
// "scripts/hooks/*.mjs" or "**/*.mjs" stay unhandled) and imports no
// globbing dependency (hooks stay dependency-light, decision f5638a84's
// constraint). A caller wanting the raw literal glob token back (e.g. to
// build a suppression-check pattern against the original prompt text, the
// same way h22/h26 already do for extractPathCandidates output) can always
// recover it as `prefix + '**'` — GLOB_PREFIX_RE's match always ends in the
// literal '**' it was matched on, so no second export is needed for that.
//
// MINIMUM TWO SEGMENTS (conductor-directed bound, board a63b226d follow-up
// — the flood risk a prefix-aware overlap comparison introduces). A
// directory-prefix claim is inherently BROADER than an exact-file claim, so
// the depth of the prefix is the only lever that keeps the overlap
// comparison (h26-dispatch-overlap.mjs) from crying wolf on every lane that
// merely mentions a file somewhere under a shallow, near-universal
// directory. A ONE-segment prefix — "scripts/**", "packages/**" — would
// make nearly every lane in this repo overlap nearly every other one (both
// directories hold dozens of unrelated files across unrelated
// subsystems); the conductor named exactly this pair as the line to draw.
// A TWO-segment prefix — "scripts/hooks/**", "packages/mcp-server/**" —
// names one coherent subsystem/package, which is the board's own
// motivating example and the shape a real "own this directory" claim takes
// in practice. `{2,}` on the segment-repetition group draws that line:
// "scripts/**" and "packages/**" are never extracted at all (silently
// under-warned, the accepted direction — P1), while "scripts/hooks/**" and
// "packages/mcp-server/**" still are.
//
// WIRING: h22-dispatch-register.mjs's claimedFromBlocks-sibling
// globPrefixesFromBlocks() writes the negation-checked output into its OWN
// register field, `claimed_glob_prefixes` — deliberately NOT folded into
// `claimed_files` (a flat FILE-path list every existing reader compares by
// exact string equality; repoRel/normalizeRepoPath legitimately STRIPS a
// trailing '/', so a trailing-slash marker could not even survive the same
// toRegisterPaths() normalization every candidate already goes through).
// h26-dispatch-overlap.mjs compares the OUTGOING dispatch's own literal
// candidate files against a live entry's `claimed_glob_prefixes` via
// startsWith — prefix-aware ONLY for that field, exact-string equality is
// completely unchanged for `claimed_files`/`files`. Suppression falls out
// for free either way: hasUnsuppressedMatch/isNegatedContext are plain
// clause-scoped text analysis with no dependency on the mention being
// file-shaped, so a prohibition marker ahead of a glob token suppresses it
// exactly as it would a literal path. The SAME pre-existing gap applies
// unchanged either way: isNegatedContext only inspects text BEFORE the
// mention (see above), so a TRAILING marker after a glob mention leaks
// precisely as it does for a literal path today — this addition neither
// narrows nor widens that separate, already-known defect.
const GLOB_PREFIX_RE = /(?:[\w-]+\/){2,}\*\*/g;

export function extractGlobPrefixCandidates(text) {
  const found = String(text ?? '').match(GLOB_PREFIX_RE) ?? [];
  return [...new Set(found.map((m) => m.slice(0, -2)))]; // strip the trailing '**', keep the '/'
}

/** Any 'reviewer-*' agent type (reviewer-correctness, reviewer-security, …). */
export function isReviewerClass(type) {
  return !!type && type.startsWith('reviewer-');
}

/**
 * Read-only dispatch classes (board a6b76e8c item 3): an agent of one of
 * these types cannot write, so H26 never warns overlap on an INCOMING
 * dispatch of this type.
 */
export function isReadOnlyDispatchType(type) {
  if (!type) return false;
  if (isReviewerClass(type)) return true;
  // Case-insensitive for the hardcoded names only — reviewer-* prefix
  // matching above is unchanged (review finding, board a6b76e8c fixer pass).
  const lower = type.toLowerCase();
  return lower === 'explorer' || lower === 'explore' || lower === 'plan';
}
