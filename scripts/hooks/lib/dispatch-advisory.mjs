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
// test-authoring clause split). Within the clause holding a mention, a
// NEGATOR (do not / don't / never / no / without / forbid(den) / denies /
// denied / ⛔) ANYWHERE earlier in the same clause suppresses it — this
// window is deliberately unbounded within the clause because a prohibition
// list can be long ("DO NOT TOUCH: scripts/hooks/, scripts/enforcement-
// stamp.mjs (another lane owns those)"). A SUBJECT-OF-CHANGE VERB
// (implement/fix/review) suppresses a mention within a narrower trailing
// window immediately before it ("implement board_remove in TypeScript" — the
// tool is the SUBJECT of the code change, not a capability need), kept tight
// so an unrelated earlier verb in a long clause does not over-suppress.
//
// Measured shapes this catches (board a6b76e8c addendum): "DO NOT create or
// edit any test file", "do NOT run X", "You hold no Bash by design", "never
// board_add", "⛔-forbidden lists", "DO NOT TOUCH: <paths> (another lane owns
// those)", quoted denial text ("H14 denies..."), and implement/fix/review-
// subject mentions.
// A period is a clause boundary only when SENTENCE-ENDING (followed by
// whitespace or end-of-string) — a bare '.' can never split mid-path, because
// nearly every candidate mention here (a file path, an extension) contains
// one ("util.mjs", "h26-dispatch-overlap.mjs"); splitting on it unconditionally
// would sever the very mention this module exists to evaluate.
export const CLAUSE_SPLIT_RE = /[!?;\n–—]|\.(?=\s|$)/;

export function splitClauses(text) {
  return String(text ?? '').split(CLAUSE_SPLIT_RE);
}

// KNOWN IMPRECISION (disclosed, missed-warning direction, accepted): \bno\b's
// reach is the whole clause, same as every other negator here, so "we have
// no config, use Bash to probe" suppresses 'Bash' even though the clause is
// reporting an absence, not forbidding the tool — a genuine capability need
// goes unwarned. Pragmatic tradeoff (board a6b76e8c): the alternative is a
// narrower window that would miss the long prohibition lists this negator
// exists to catch ("DO NOT TOUCH: <long list>").
const NEGATOR_RE = String.raw`(?:\bdo\s*not\b|\bdon['’]?t\b|\bnever\b|\bno\b|\bwithout\b|\bforbid(?:s|den)?\b|\bdenies\b|\bdenied\b|⛔)`;
const SUBJECT_VERB_RE = String.raw`(?:\bimplement(?:ing|ed|s)?\b|\bfix(?:ing|ed|es)?\b|\breview(?:ing|ed|s)?\b)`;

const NEGATOR_TEST = new RegExp(NEGATOR_RE, 'i');
const SUBJECT_VERB_TEST = new RegExp(SUBJECT_VERB_RE, 'i');
const SUBJECT_VERB_WINDOW = 40; // chars — pragmatic, narrower than the negator's whole-clause reach

/** True when a negator appears anywhere earlier in `clause` than `index`. */
export function isNegatedContext(clause, index) {
  const text = String(clause ?? '');
  return NEGATOR_TEST.test(text.slice(0, Math.max(0, index)));
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
