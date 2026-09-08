// DISPATCH-PROMPT PARSING — path-candidate extraction and the REVIEW-TERRITORY
// structured declaration parser, both operating on a dispatch prompt's TEXT.
//
// THE PARENT-TRANSCRIPT PROMPT READER FUNCTIONS THAT USED TO LIVE HERE ARE
// DELETED (decision `dispatch-state-machine-pre-slot-post-binding-locked-
// start-resolution-replaces-transcript-attribution`): the parent transcript is LAGGED at
// SubagentStart (measured, not assumed) and cannot attribute a prompt to a
// spawn safely by any ordering trick. Every consumer now recovers its own
// prompt (if any) from scripts/lib/dispatch-register.mjs's resolveDispatchStart,
// which resolves a per-dispatch state record instead of reading the transcript
// tail. This file keeps only the TEXT-shaped parsers those consumers still
// call once they have a prompt string in hand.
import { normalizeRepoPath } from '@sterling/schemas';

// Path-candidate extraction from free-form prompt prose. No shared extractor
// exists yet in this codebase for this shape (grepped: absent) — the nearest
// analog, a bash-command path extractor, does not exist either; this is a
// standalone extractor for prompt TEXT rather than a single shell command.
// Deliberately permissive: a false positive costs one extra store lookup that
// finds nothing; a false negative costs the staging this hook exists to
// provide. Directory segments exclude '.' (so URLs and prose like
// "claude.com/docs" rarely qualify); the filename segment allows '.' for
// multi-dot names (e.g. 'h19-delivery.test.mjs'); the trailing extension group
// is what stops the match before sentence punctuation ('…delivery.mjs.' keeps
// only 'delivery.mjs').
export const PATH_CANDIDATE_RE = /(?:[\w-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10}/g;

export function extractPathCandidates(text) {
  const found = String(text ?? '').match(PATH_CANDIDATE_RE) ?? [];
  return [...new Set(found)];
}

// REVIEW-TERRITORY structured declaration (decision 8f137474, slug
// review-territory-structured-receipt-files) — a dispatch block's prompt may
// carry a line `REVIEW-TERRITORY: [...]` (a JSON array of repo-relative
// POSIX path strings) that takes precedence over the free-prose extractor
// above for that block. Anchored at line start ('m' flag), case-sensitive.
// Only the first such line in a prompt is honored — none of the governing
// spec's pins exercise more than one per block, and a second marker line is
// exotic enough not to need its own union rule here.
//
// HORIZONTAL WHITESPACE ONLY after the colon ([ \t]*, never \s*) and a
// REQUIRED non-space character starting the capture (\S): \s* would let the
// colon's trailing whitespace swallow a newline, letting the JSON array sit
// on the NEXT line and still "match" — that is not one line, so it must not
// be a declaration at all (P-newline-marker pin). Requiring \S also means a
// bare "REVIEW-TERRITORY:" with nothing else on its line (or only trailing
// spaces) never matches — it is silently not-present, never malformed.
export const REVIEW_TERRITORY_RE = /^REVIEW-TERRITORY:[ \t]*(\S.*)$/m;

// Repo-relative POSIX PATH SHAPE (review-fix round, decision 8f137474): a
// declared string is a legitimate path only when it is already in canonical
// repo-relative POSIX form — no '..' segment, no leading '/', no drive
// letter, no backslash, non-empty. Reuses H22's own normalization primitive
// (normalizeRepoPath, the same one lib/common.mjs's repoRel() wraps) rather
// than a parallel regex: normalizeRepoPath THROWS on drive-prefixed,
// absolute, and parent-escaping input, which covers three of the four
// rejections directly. It does NOT throw on a backslash-separated path —
// its job elsewhere is to CONVERT '\\' to '/' for a tool path that may
// legitimately arrive either way — so a declared path with a backslash
// would silently normalize into something DIFFERENT from what was typed,
// which is exactly what a "shape" declaration must not tolerate (the
// declarer wrote something that was not already canonical). Checking
// `normalizeRepoPath(p) === p` catches that case too: any input requiring
// change to reach canonical form (backslash conversion, a stray './',
// trailing '/', etc.) fails the shape test, so this stays ONE predicate
// rather than a normalizer plus a second divergent backslash regex.
// GLOB METACHARACTERS ARE REJECTED, NOT NORMALIZED AWAY (Codex review MEDIUM,
// thread 01a05b8c, board 7632586d). The governing decision
// (review-territory-structured-receipt-files) is explicit: "a JSON array of
// repo-relative POSIX PATH strings" naming EXACTLY the files — paths, never
// patterns. normalizeRepoPath has no reason to reject '*'/'?'/'[' (they are
// ordinary path-invariant-legal characters elsewhere), so "src/**" and
// "src/*.mjs" previously passed this shape check unchanged and parsed as
// VALID declared elements. That let a live H22 register entry declare
// files:["src/**"] under files_source:'review-territory' while also writing
// claimed_glob_prefixes:["src"] from its own separate prose glob-prefix scan
// (globPrefixesFromBlocks, h22-dispatch-register.mjs) — h26's declared-
// territory branch reads `files` LITERALLY, never as a pattern, and clears
// claimed_glob_prefixes for a declared entry, so a genuine prefix claim
// written that way would silently stop being compared. A path-shaped
// declaration cannot carry a glob, so this check now runs before/alongside
// the canonical-form check.
const GLOB_METACHAR_RE = /[*?[\]]/;

function isRepoRelativePosixShape(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (GLOB_METACHAR_RE.test(p)) return false;
  try {
    return normalizeRepoPath(p) === p;
  } catch {
    return false;
  }
}

/**
 * Parses a block prompt's REVIEW-TERRITORY declaration, if any. Returns
 * exactly one of:
 *   { present: false }                              — no marker line at all
 *   { present: true, valid: true, files: string[] }  — well-formed (possibly [])
 *   { present: true, valid: false, raw: string }     — malformed: unparseable
 *     JSON, valid JSON that is not an array, an array with a non-string
 *     element, or an array with a string that is not already canonical
 *     repo-relative POSIX path shape. `raw` is the full matched line (marker
 *     + declaration text), for a caller to name the bad declaration in a
 *     loud warning — this hook family never denies, so the caller decides
 *     how to fall back.
 */
export function parseReviewTerritory(text) {
  const match = REVIEW_TERRITORY_RE.exec(String(text ?? ''));
  if (!match) return { present: false };
  const raw = match[0];
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { present: true, valid: false, raw };
  }
  if (!Array.isArray(parsed) || !parsed.every(isRepoRelativePosixShape)) {
    return { present: true, valid: false, raw };
  }
  return { present: true, valid: true, files: parsed };
}
