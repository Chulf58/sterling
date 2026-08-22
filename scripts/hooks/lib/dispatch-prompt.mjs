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
