// H6 transcript machinery (spec §6 H6, resolved by Layer 0 probe):
// in-subagent transcript_path is the PARENT session's; the agent's own
// transcript is derived as <session>/subagents/agent-<agent_id>.jsonl.
// Usage is tail-read (last ~1MB) from the most recent assistant entry —
// the API's own accounting; no tokenizer, no cumulative state.
import { openSync, readSync, closeSync, fstatSync, existsSync, statSync, readdirSync } from 'node:fs';

// 1MB tail: real transcripts routinely carry single JSONL lines past the old
// 64KB (563KB observed live; 163 subagent lines >64KB measured 2026-07-12), so
// the window was blind at exactly the context-heavy calls (R2 board d9754b59).
const TAIL_BYTES = 1024 * 1024;

export function deriveAgentTranscript(parentTranscriptPath, agentId) {
  const sessionDir = parentTranscriptPath.replace(/\.jsonl$/, '');
  const flat = `${sessionDir}/subagents/agent-${agentId}.jsonl`;
  if (existsSync(flat)) return flat;
  // Workflow-spawned subagents live one level deeper (observed 2026-07-12:
  // <session>/subagents/workflows/wf_<id>/agent-<id>.jsonl) — scan-fallback so
  // a platform migration of Task agents to that layout degrades gracefully
  // instead of reporting transcript_missing forever (R2 board 774d86c6).
  const wfRoot = `${sessionDir}/subagents/workflows`;
  try {
    for (const d of readdirSync(wfRoot)) {
      const candidate = `${wfRoot}/${d}/agent-${agentId}.jsonl`;
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // no workflows dir — fall through to the flat path (caller reports missing)
  }
  return flat;
}

export function readTail(path, bytes = TAIL_BYTES) {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Most recent assistant entry's {usage, model} from a transcript tail, or null with a reason. */
export function latestUsage(path) {
  const tail = readTail(path);
  if (tail === null) return { usage: null, reason: 'transcript_missing' };
  const lines = tail.split('\n');
  let sawAssistant = false;
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
    sawAssistant = true;
    const usage = entry.message?.usage;
    if (usage && typeof usage.input_tokens === 'number') {
      return { usage, model: entry.message?.model, reason: null };
    }
  }
  if (sawAssistant) return { usage: null, reason: 'format_unparseable' };
  // Distinguish a window that did not reach any assistant entry (older bytes
  // exist beyond the tail) from a transcript that genuinely has none — the
  // former is a coverage gap, not a fresh file (R2 board d9754b59).
  const exhausted = statSync(path).size > TAIL_BYTES;
  return { usage: null, reason: exhausted ? 'window_exhausted' : 'no_assistant_entries' };
}

/** fill = (input + cache_creation + cache_read) / window — §6 H6 formula. */
export function fillPct(usage, windowSize) {
  const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return (100 * used) / windowSize;
}
