// DISPATCH-PROMPT RECOVERY — the one mechanism for reading the conductor's
// dispatch prompt off the PARENT transcript and pulling path candidates out of
// it. Extracted verbatim from h19-dispatch-staging.mjs (2026-08-20) when the H22
// dispatch register became a second consumer: one mechanism, imported never
// reimplemented (decision f5638a84 constraint). Behavior is unchanged — h19's
// delivery logic still calls exactly these functions.
//
// Why the transcript at all: SubagentStart/SubagentStop stdin carries
// session_id, transcript_path, cwd, prompt_id, agent_id, agent_type,
// hook_event_name — THERE IS NO PROMPT FIELD (live-probed: research_finding
// 35a89a0f for Start, 20b44518 for Stop). The dispatch prompt is therefore
// recovered from the parent transcript (H6 precedent, ./transcript.mjs).
import { existsSync } from 'node:fs';
import { readTail } from './transcript.mjs';
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
function isRepoRelativePosixShape(p) {
  if (typeof p !== 'string' || p === '') return false;
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

/** The union of every Task/Agent tool_use block's `prompt` in the LAST
 *  assistant message (scanned from the tail) that carries at least one such
 *  block. Returns [] on anything short of a clean read: missing transcript,
 *  no assistant entries, malformed JSON — recovery degrades to silence rather
 *  than a throw a caller must special-case. */
export function lastDispatchPrompts(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const tail = readTail(transcriptPath);
  if (tail === null) return [];
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // first line of the tail window may be truncated
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const blocks = content.filter((b) => b?.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent'));
    if (!blocks.length) continue; // this assistant turn dispatched nothing — keep scanning backward
    return blocks.map((b) => b.input?.prompt).filter((p) => typeof p === 'string');
  }
  return [];
}

/** Per-block {subagent_type, prompt} for every Task/Agent tool_use block in a
 *  DISPATCHING assistant message read from the transcript tail — the
 *  per-block sibling of lastDispatchPrompts() above, which stays
 *  byte-identical because h19-dispatch-staging consumes it (decision
 *  5d3747c1, slug h22-per-block-attribution). `skip` (default 0) skips that
 *  many dispatching messages, most-recent-first, before returning the next
 *  match's blocks — the mechanism a caller uses to walk BACKWARD through
 *  recent dispatching messages (H22's cross-batch race: batch B's message
 *  can land in the transcript before batch A's SubagentStarts fire). Returns
 *  [] on anything short of a clean read, or once `skip` runs past the number
 *  of dispatching messages present in the tail window — recovery degrades to
 *  silence rather than a throw a caller must special-case, same posture as
 *  lastDispatchPrompts(). */
export function lastDispatchBlocks(transcriptPath, skip = 0) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const tail = readTail(transcriptPath);
  if (tail === null) return [];
  const lines = tail.split('\n');
  let remaining = skip;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // first line of the tail window may be truncated
    }
    if (entry.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const blocks = content.filter((b) => b?.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent'));
    if (!blocks.length) continue; // this assistant turn dispatched nothing — keep scanning backward
    if (remaining > 0) {
      remaining--;
      continue; // this dispatching message is being skipped over for the walk-back
    }
    return blocks
      .map((b) => ({ subagent_type: b.input?.subagent_type, prompt: b.input?.prompt }))
      .filter((b) => typeof b.prompt === 'string');
  }
  return [];
}
