// DISPATCH-PROMPT PARSING — path-candidate extraction and the REVIEW-TERRITORY
// declaration parser, both over a dispatch prompt's TEXT.
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
//
// THE REVIEW-TERRITORY STRUCTURED DECLARATION PARSER (parseReviewTerritory)
// IS RESTORED (decision h22-dispatch-files-from-review-territory-and-resume-
// inherits-prior-round): it was deleted in e16e127 as reader-less, but it fed
// the register's `files`, which H10's deferral join reads. Without it every
// path in a brief's "NEVER write" list became that lane's ownership.
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

// REVIEW-TERRITORY structured declaration — a dispatch prompt may carry a line
// `REVIEW-TERRITORY: [...]`, a JSON array of repo-relative POSIX paths, file
// or directory, e.g. `REVIEW-TERRITORY: ["game/farm", "game/test/farm"]`. When
// valid it replaces free-prose extraction as the dispatch's `files`. Anchored
// at line start ('m' flag), case-sensitive; only the first such line counts.
// Horizontal whitespace only after the colon, and a required non-space start:
// the array must sit on the marker's own line, and a bare marker with nothing
// after it is not a declaration at all.
export const REVIEW_TERRITORY_RE = /^REVIEW-TERRITORY:[ \t]*(\S.*)$/m;

// A declared entry must already be in canonical repo-relative POSIX form:
// normalizeRepoPath throws on absolute, drive-prefixed and parent-escaping
// input, and `normalizeRepoPath(p) === p` rejects anything it would have to
// change (backslashes, './', a trailing '/'). Globs are rejected rather than
// read literally: the declaration names paths, never patterns.
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
 * Parses a prompt's REVIEW-TERRITORY declaration, if any. Returns exactly one of:
 *   { present: false }                              — no marker line
 *   { present: true, valid: true, files: string[] }  — well-formed (possibly [])
 *   { present: true, valid: false, raw: string }     — malformed: unparseable
 *     JSON, JSON that is not an array, or any element that is not a canonical
 *     repo-relative path. `raw` is the matched line, for the caller's loud
 *     disclosure. One bad element makes the whole declaration malformed; it is
 *     never partially honoured.
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
  return { present: true, valid: true, files: [...new Set(parsed)] };
}
