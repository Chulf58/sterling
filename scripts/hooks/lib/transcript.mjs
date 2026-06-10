// H6 transcript machinery (spec §6 H6, resolved by Layer 0 probe):
// in-subagent transcript_path is the PARENT session's; the agent's own
// transcript is derived as <session>/subagents/agent-<agent_id>.jsonl.
// Usage is tail-read (last ~64KB) from the most recent assistant entry —
// the API's own accounting; no tokenizer, no cumulative state.
import { openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';

const TAIL_BYTES = 64 * 1024;

export function deriveAgentTranscript(parentTranscriptPath, agentId) {
  return parentTranscriptPath.replace(/\.jsonl$/, '') + `/subagents/agent-${agentId}.jsonl`;
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
  return { usage: null, reason: sawAssistant ? 'format_unparseable' : 'no_assistant_entries' };
}

/** fill = (input + cache_creation + cache_read) / window — §6 H6 formula. */
export function fillPct(usage, windowSize) {
  const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return (100 * used) / windowSize;
}
