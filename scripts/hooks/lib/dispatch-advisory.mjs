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
// The ONE path/glob extractor (board a63b226d's constraint, and c56862a9's
// original defect was exactly a second divergent heuristic): the trailing-
// prohibition reach below needs to know whether a candidate prohibition clause
// names any path of its OWN, and it asks the shared regexes rather than
// re-deriving a path shape here. dispatch-prompt.mjs imports nothing from this
// module, so there is no cycle.
import { PATH_CANDIDATE_RE, extractPathCandidates } from './dispatch-prompt.mjs';

// A period is a clause boundary only when SENTENCE-ENDING (followed by
// whitespace or end-of-string) — a bare '.' can never split mid-path, because
// nearly every candidate mention here (a file path, an extension) contains
// one ("util.mjs", "h26-dispatch-overlap.mjs"); splitting on it unconditionally
// would sever the very mention this module exists to evaluate.
const HARD_BOUNDARY_RE = /(\r?\n[ \t]*\r?\n)|([!?;])|(\.(?=\s|$))|([–—]|\r?\n)/g;

// TRAILING PROHIBITION MARKERS (board 59c30a7f) — the complement of the
// write-side negation fix (board c56862a9, commit 5eea229), which deliberately
// did NOT close this half. Everything above reaches BACKWARD from a mention to
// a marker that precedes it, so a prohibition arriving AFTER the paths —
// "Other live lanes own A, B, C — do not edit those." — never reaches them and
// they stay CLAIMED. Reproduced live 2026-08-27 at HEAD, with the write-side
// fix already shipped: H26 warned a lane about a file its own brief had
// explicitly forbidden it to touch. Two boundary behaviours make it concrete:
// an em-dash is a SOFT boundary absorbed only when a prohibition is ALREADY in
// `soFar` (see splitClauses), so the paths land in a clause carrying no marker
// yet; and ';' is a HARD split with the same result.
//
// WHY THE REACH IS NARROW, AND WHY THAT IS THE WHOLE DESIGN. Reaching backward
// is dangerous in a way reaching forward is not: over-suppression drops
// genuinely-claimed territory from claimed_files and SILENTLY REMOVES REAL
// overlap warnings, which is strictly worse than the cosmetic false positive
// being fixed (board 59c30a7f: "a naive fix is worse than the bug"). So the
// backward reach fires ONLY for an ANAPHORIC TERRITORY PROHIBITION — a clause
// that (a) carries a PROHIBITION marker (bare negators never reach backward:
// "never"/"no"/"without" are the idiomatic class, and idioms are exactly what
// a backward reach would over-collect), (b) names a TERRITORY verb
// (touch/edit/modify/change/write/alter — NOT "do not break it", which
// prohibits a KIND OF CHANGE to a file the lane genuinely owns), (c) ends in a
// BACK-REFERRING pronoun (those/these/them/it/that) with no room for an object
// of its own between verb and pronoun, and (d) contains NO path candidate and
// NO glob token of its own — a clause naming its own paths is a FRESH
// prohibition governing THOSE, already handled by the forward reach, not a
// back-reference. It then reaches back exactly ONE clause, and never across a
// PARAGRAPH break (a blank line ends the passage an anaphor can plausibly
// refer to; without that bound a prohibition at the bottom of a long brief
// could erase the territory section at its top).
//
// TWO FURTHER GATES ON WHAT THE REACH MAY SUPPRESS (outside-model review of
// the first cut, 2026-08-27, both defects reproduced by executing the
// matcher). The bounds above answer HOW FAR the reach travels; these answer
// WHICH MENTIONS INSIDE THAT REACH it is allowed to touch — the first cut
// applied it to every match indiscriminately, and hasUnsuppressedMatch is NOT
// a path-only surface:
//
//   (i) PATH-SHAPED MENTIONS ONLY. h25-dispatch-capability.mjs:119 asks this
//   same function about TOOL CAPABILITIES (wholeTokenRe('Bash')) and
//   lib/dispatch-residue.mjs:118 about CONFIGURED RESOURCE NAMES. "Use Bash to
//   inspect scripts/a.mjs; do not edit it." prohibits the FILE, yet the first
//   cut reported Bash as suppressed too — H25 then silently drops a
//   missing-capability warning for a tool the brief explicitly requires. An
//   anaphoric TERRITORY prohibition can only be disclaiming TERRITORY, so the
//   reach now fires only when the matched text is itself path- or glob-shaped
//   (isPathShapedMention, asking the SAME shared regexes — never a second path
//   heuristic). A capability or resource mention is never suppressed by it.
//
//   (ii) A SINGULAR PRONOUN CANNOT REFER TO SEVERAL PATHS. "Claim src/a.mjs
//   and src/b.mjs; do not edit it." unclaimed BOTH paths on the first cut.
//   "it"/"that" can refer to at most one referent, so the reach fires for a
//   SINGULAR anaphor only when the clause it reaches back into names exactly
//   ONE distinct path/glob candidate; with two or more the referent is
//   ambiguous and ambiguity resolves toward NOT suppressing (over-claiming is
//   a loud, correctable warning; under-claiming is silent). PLURAL anaphors
//   (those/these/them) are unchanged and stay count-independent — "Other lanes
//   own A, B — do not edit those" is board 59c30a7f's whole motivating shape,
//   and a plural pronoun standing for a single path is ordinary prose.
//
// ACCEPTED RESIDUAL OVER-SUPPRESSION, NOT SOLVED (same review, case 3): when
// the clause names exactly one path AND some other singular noun, a singular
// anaphor is genuinely ambiguous between them and this module has no way to
// tell — "Fix src/a.mjs while preserving the public API; do not change it."
// suppresses src/a.mjs although "it" may mean the API. Resolving that needs
// pronoun-referent semantics, which nothing here implements and this comment
// does not claim (anti-pattern 586bccdc: a guard's comment must never assert a
// protection the code does not carry). The bound is narrow — it requires a
// prohibition marker AND a territory verb (touch/edit/modify/change/write/
// alter) AND a trailing pronoun AND no path of the prohibition's own — and
// within that shape the path reading is the dominant one, so it is accepted
// rather than papered over.
//
// EVERY DIRECTION THIS DOES NOT COVER IS DELIBERATE UNDER-SUPPRESSION, the
// direction this advisory family already accepts (P1, parallel-lanes "bounded
// under-warning"): "do not go near those" (verb not in the set), "do not touch
// any of the files listed above" (no pronoun), a prohibition two clauses back,
// a SINGULAR pronoun over a multi-path clause (gate (ii) above), a capability
// or resource mention (gate (i) above), and a path MENTIONED TWICE where only
// one occurrence is covered (any unsuppressed occurrence still claims —
// hasUnsuppressedMatch's existing any-occurrence semantics are unchanged).
//
// ONE SHARED DETECTOR, as the board requires: this lands in
// hasUnsuppressedMatch, so h22's write side (claimed_files,
// claimed_glob_prefixes), h26's read side and h25 all inherit it at once — a
// second divergent heuristic on the read and write sides WAS the original
// c56862a9 defect. h22's `files` is untouched (it is computed with the BARE
// extractor and means territory EXAMINED — receipts, residue probes, H10
// deferral — see research_finding 289cd172).
const TERRITORY_VERB_RE = String.raw`(?:touch(?:es|ed|ing)?|edit(?:s|ed|ing)?|modif(?:y|ies|ied|ying)|change(?:s|d|ing)?|writ(?:e|es|ing|ten)|alter(?:s|ed|ing)?)`;
const ANAPHOR_RE = String.raw`(?:those|these|them|it|that)`;
// Which of those pronouns can stand for MORE THAN ONE referent — gate (ii).
const PLURAL_ANAPHOR_TEST = /^(?:those|these|them)$/i;

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
// marker → (≤2 filler words) → territory verb → (≤2 filler words) → anaphor.
// The two tight windows are what makes "do not edit any of those" reach while
// "do not edit tests/x.test.mjs or anything like it" does not: the second
// clause has its own object between the verb and the pronoun.
// The anaphor is CAPTURED (group 1) so the reach can tell a singular pronoun
// from a plural one — see gate (ii) in the comment block above.
const TRAILING_PROHIBITION_TEST = new RegExp(
  `${PROHIBITION_RE}\\s*(?:[\\w'’-]+\\s+){0,2}\\b${TERRITORY_VERB_RE}\\b\\s*(?:[\\w'’-]+\\s+){0,2}\\b(${ANAPHOR_RE})\\b`,
  'i'
);
const SUBJECT_VERB_WINDOW = 40; // chars — pragmatic, narrower than the prohibition marker's whole-clause reach
const BARE_NEGATOR_WINDOW = 5; // tokens after the negator — pragmatic, see the repro table above

/**
 * The clause walk, with the one extra fact the TRAILING-prohibition reach
 * needs that a bare string list cannot carry: whether each clause was ended by
 * a PARAGRAPH break (a blank line). Returns `{text, endedByParagraphBreak}[]`.
 * `splitClauses` below is the unchanged string-list projection of this — every
 * existing caller and pin keeps its exact shape.
 */
export function scanClauses(text) {
  const s = String(text ?? '');
  const clauses = [];
  let clauseStart = 0;
  HARD_BOUNDARY_RE.lastIndex = 0;
  let m;
  while ((m = HARD_BOUNDARY_RE.exec(s))) {
    const boundaryStart = m.index;
    const boundaryEnd = boundaryStart + m[0].length;
    const isParagraph = m[1] !== undefined;
    const isHard = isParagraph || m[2] !== undefined || m[3] !== undefined;
    if (isHard) {
      clauses.push({ text: s.slice(clauseStart, boundaryStart), endedByParagraphBreak: isParagraph });
      clauseStart = boundaryEnd;
      continue;
    }
    // Soft boundary (dash or a single, non-blank newline): split normally,
    // UNLESS the text since the last hard boundary already carries a
    // prohibition marker — then absorb it and keep the clause extending.
    const soFar = s.slice(clauseStart, boundaryStart);
    if (PROHIBITION_TEST.test(soFar)) continue;
    clauses.push({ text: soFar, endedByParagraphBreak: false });
    clauseStart = boundaryEnd;
  }
  clauses.push({ text: s.slice(clauseStart), endedByParagraphBreak: false });
  return clauses;
}

export function splitClauses(text) {
  return scanClauses(text).map((c) => c.text);
}

/**
 * True when `clause` is an ANAPHORIC TERRITORY PROHIBITION — a trailing
 * "— do not edit those." / "; do not touch it." that disclaims the territory
 * named in the clause BEFORE it, rather than prohibiting something of its own.
 * See the TRAILING PROHIBITION MARKERS comment above for why each condition is
 * load-bearing; the two path guards are the ones that keep this from reaching
 * back over a clause that names its own object.
 */
export function isAnaphoricProhibitionClause(clause) {
  return anaphoricProhibitionNumber(clause) !== null;
}

/**
 * The same verdict as isAnaphoricProhibitionClause, but carrying the ONE extra
 * fact gate (ii) needs: whether the back-referring pronoun is `'plural'`
 * (those/these/them — may stand for a whole list) or `'singular'` (it/that —
 * can refer to at most one thing). `null` when the clause is not an anaphoric
 * territory prohibition at all.
 */
export function anaphoricProhibitionNumber(clause) {
  const text = String(clause ?? '');
  const m = text.match(TRAILING_PROHIBITION_TEST);
  if (!m) return null;
  // ONE SHARED EXTRACTOR, never a second path heuristic (board a63b226d /
  // c56862a9): a clause naming any path or glob of its own is a fresh
  // prohibition governing THOSE, already covered by the forward reach.
  // String.match with a /g regex ignores and does not leave lastIndex behind,
  // so the shared PATH_CANDIDATE_RE/GLOB_PREFIX_RE constants stay untouched.
  if (text.match(PATH_CANDIDATE_RE)) return null;
  if (text.match(GLOB_PREFIX_RE)) return null;
  return PLURAL_ANAPHOR_TEST.test(m[1]) ? 'plural' : 'singular';
}

/**
 * How many DISTINCT territory referents a clause names — literal path
 * candidates plus literal glob-prefix tokens, deduped. Gate (ii)'s input: a
 * SINGULAR anaphor can only be reached back from when this is exactly 1.
 * Both counts come from the shared extractors, never a local path shape.
 */
function distinctTerritoryMentions(clause) {
  const text = String(clause ?? '');
  return new Set([...extractPathCandidates(text), ...extractGlobPrefixCandidates(text)]).size;
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
  const clauses = scanClauses(text);
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i].text;
    // TRAILING PROHIBITION (board 59c30a7f): the reach is ONE clause forward
    // and never crosses a paragraph break — see the comment block above.
    // GATE (ii): a singular pronoun reaches back only into a clause naming
    // exactly ONE territory referent; a plural one is count-independent.
    const number = clauses[i].endedByParagraphBreak
      ? null
      : anaphoricProhibitionNumber(clauses[i + 1]?.text);
    const trailingSuppresses =
      number === 'plural' || (number === 'singular' && distinctTerritoryMentions(clause) === 1);
    global.lastIndex = 0;
    let m;
    while ((m = global.exec(clause))) {
      // GATE (i): a TERRITORY prohibition can only disclaim TERRITORY, so it
      // never suppresses a capability (H25) or resource (dispatch-residue)
      // mention — only a path- or glob-shaped one.
      const suppressedByTrailing = trailingSuppresses && isPathShapedMention(m[0]);
      if (!suppressedByTrailing && !isSuppressedContext(clause, m.index, checkSubjectVerb)) return true;
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

// GATE (i)'s test — see the TRAILING PROHIBITION comment block above. Built
// from the SAME two shared regexes rather than a third path shape: a mention
// is territory-shaped when the WHOLE matched text is a literal path candidate
// or a literal glob-prefix token. Declared here, below GLOB_PREFIX_RE, because
// it is composed at module-init time and a `const` cannot be read before its
// own declaration; every reader of it is a function body, so ordering in the
// file does not constrain the call sites.
//
// The two sources are /g regexes: `.source` is read, never their lastIndex, so
// composing them here cannot perturb the extractors.
const PATH_SHAPED_TEST = new RegExp(`^(?:${PATH_CANDIDATE_RE.source}|${GLOB_PREFIX_RE.source})$`);

/**
 * True when `token` is ENTIRELY a repo-path or glob-prefix token. Callers pass
 * the raw matched text; H25's capability pattern legitimately captures a
 * leading non-word character (wholeTokenRe's `(?:^|[^\w])`), so the token is
 * trimmed before testing — a tool or resource NAME can never satisfy either
 * shape either way, since both require a directory separator.
 */
export function isPathShapedMention(token) {
  return PATH_SHAPED_TEST.test(String(token ?? '').trim());
}

export function extractGlobPrefixCandidates(text) {
  const found = String(text ?? '').match(GLOB_PREFIX_RE) ?? [];
  return [...new Set(found.map((m) => m.slice(0, -2)))]; // strip the trailing '**', keep the '/'
}

/** Any 'reviewer-*' agent type (reviewer-correctness, reviewer-security, …). */
export function isReviewerClass(type) {
  return !!type && type.startsWith('reviewer-');
}

/**
 * Read-only dispatch classes (board a6b76e8c item 3; librarian added board
 * 7632586d item 1): an agent of one of these types has a structurally EMPTY
 * write-set — explorer, reviewer-* (any role), Explore, and Plan never touch
 * repo files at all, and librarian's own grant is knowledge-store-update-only (never
 * knowledge_create, never a repo write — decision
 * conductor-creates-records-directly-librarian-stays-update-only) — so H26
 * never warns overlap on an INCOMING dispatch of this type, and (per H26's
 * own file-overlap loop) such a dispatch's live register entry can never
 * CONTRIBUTE an overlap warning against a sibling either, since it never
 * declares write territory in the first place.
 */
export function isReadOnlyDispatchType(type) {
  if (!type) return false;
  if (isReviewerClass(type)) return true;
  // Case-insensitive for the hardcoded names only — reviewer-* prefix
  // matching above is unchanged (review finding, board a6b76e8c fixer pass).
  const lower = type.toLowerCase();
  return lower === 'explorer' || lower === 'explore' || lower === 'plan' || lower === 'librarian';
}
