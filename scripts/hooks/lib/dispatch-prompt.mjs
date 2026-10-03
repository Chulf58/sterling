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
import { posix } from 'node:path';
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

// The same candidates, classified by the WHOLE token each one sits in, so a
// path suffix inside a larger token is never read as a repo path (decision
// h22-dispatch-files-from-review-territory-and-resume-inherits-prior-round,
// probe 2026-10-03; Codex Sol review). The token is the run of characters
// around the match up to whitespace, a quote or backtick, a bracket, or one
// of , ; * | =. A match followed by '/' stopped at a dotted directory
// ('foo.bar' in 'foo.bar/src/a.ts') and is skipped; the later match that
// reaches the end of the path carries the whole token. The candidate is the
// token text from its start through the match:
//   '/...'                  an absolute POSIX path, '..' resolved; the caller
//                           makes it repo-relative or drops it when it is
//                           outside the project
//   path characters only    a relative path ('src/a.mjs', './a/b.mjs',
//                           'foo.bar/c.ts'), '..' resolved; one that escapes
//                           upward keeps its leading '..' and the caller's
//                           normalisation refuses it
//   anything else           dropped: a URL ('scheme://'), a drive-letter
//                           path, a '~/' path, or a suffix of some other token.
const TOKEN_DELIMITER_RE = /[\s'"`()[\]{}<>,;*|=]/;
const RELATIVE_PATH_CHARS_RE = /^[\w./-]+$/;

export function extractPathCandidatesRooted(text) {
  const s = String(text ?? '');
  const found = new Set();
  for (const m of s.matchAll(PATH_CANDIDATE_RE)) {
    if (s[m.index + m[0].length] === '/') continue;
    let start = m.index;
    while (start > 0 && !TOKEN_DELIMITER_RE.test(s[start - 1])) start -= 1;
    const candidate = s.slice(start, m.index) + m[0];
    if (candidate.startsWith('/') || RELATIVE_PATH_CHARS_RE.test(candidate)) found.add(posix.normalize(candidate));
  }
  return [...found];
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

// A declared entry must be in canonical repo-relative POSIX form, except that
// ONE trailing '/' on a directory entry is stripped (user ruling 2026-09-29,
// option "Accept, strip one '/'"): `game/ui/farm_hud/` IS `game/ui/farm_hud`.
// After that strip, normalizeRepoPath throws on absolute, drive-prefixed and
// parent-escaping input, and `normalizeRepoPath(p) === p` rejects anything it
// would still have to change (backslashes, './', a second trailing '/'). Globs
// are rejected rather than read literally: the declaration names paths, never
// patterns. Returns the canonical entry, or the reason it is refused.
const GLOB_METACHAR_RE = /[*?[\]]/;

function canonicalTerritoryEntry(p) {
  if (typeof p !== 'string') return { reason: 'not a string' };
  if (p === '') return { reason: 'empty string' };
  if (GLOB_METACHAR_RE.test(p)) return { reason: 'glob pattern; the declaration names files or directories, never patterns' };
  const stripped = p.endsWith('/') ? p.slice(0, -1) : p;
  let normalized;
  try {
    normalized = normalizeRepoPath(stripped);
  } catch (e) {
    return { reason: String(e?.message ?? e).replace(/^path invariant violation: /, '') };
  }
  if (normalized !== stripped) return { reason: `not canonical repo-relative POSIX form (canonical: '${normalized}')` };
  return { path: normalized };
}

/**
 * Parses a prompt's REVIEW-TERRITORY declaration, if any. Returns exactly one of:
 *   { present: false }                              — no marker line
 *   { present: true, valid: true, files: string[] }  — well-formed (possibly [])
 *   { present: true, valid: false, raw: string, reason: string }  — malformed:
 *     unparseable JSON, JSON that is not an array, or any element that is not
 *     a canonical repo-relative path (one trailing '/' allowed). `raw` is the
 *     matched line and `reason` names the first failing entry by index plus why
 *     it was refused, for the caller's loud disclosure. One bad element makes
 *     the whole declaration malformed; it is never partially honoured.
 */
export function parseReviewTerritory(text) {
  const match = REVIEW_TERRITORY_RE.exec(String(text ?? ''));
  if (!match) return { present: false };
  const raw = match[0];
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (e) {
    return { present: true, valid: false, raw, reason: `not valid JSON (${e.message})` };
  }
  if (!Array.isArray(parsed)) return { present: true, valid: false, raw, reason: 'not a JSON array' };
  const files = [];
  for (const [i, entry] of parsed.entries()) {
    const c = canonicalTerritoryEntry(entry);
    if (c.reason) return { present: true, valid: false, raw, reason: `entry ${i} (${JSON.stringify(entry)}): ${c.reason}` };
    files.push(c.path);
  }
  return { present: true, valid: true, files: [...new Set(files)] };
}
