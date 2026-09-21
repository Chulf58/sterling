// H6 transcript machinery (spec §6 H6, resolved by Layer 0 probe):
// in-subagent transcript_path is the PARENT session's; the agent's own
// transcript is derived as <session>/subagents/agent-<agent_id>.jsonl.
// Usage is tail-read (last ~1MB) from the most recent assistant entry —
// the API's own accounting; no tokenizer, no cumulative state.
import { openSync, readSync, closeSync, fstatSync, existsSync, statSync, readdirSync } from 'node:fs';

// FORWARD READ FOR A KNOWN-ID LOOKUP — the sibling of readTail below, added
// for H22's Stop-time reviewer binding (decision foreign_edbaa38d, slug
// reviewer-attribution-binds-at-stop-from-child-transcript-and-meta-sidecar).
// readTail is deliberately UNCHANGED: its 1MB window is the right shape for
// "the most recent entry of interest", which is what every other caller wants,
// and widening it there would change the cost of every H6/H19/H22 fire. This
// reads FORWARD from byte 0 instead, because the two things H22 needs are at
// the OPPOSITE end of the file from readTail's window: the FIRST record of a
// child transcript, and a tool_use block sitting at an UNKNOWN position in the
// parent. The parent lookup is a search for an id the caller already holds, so
// scanning the whole file cannot false-match (the decision says so explicitly)
// — the only risk of a wide window here is cost, not correctness.
//
// `complete` is what makes a fail-closed caller possible: it says whether the
// window covered the whole file, so a caller can tell "not present" apart from
// "not present IN WHAT I READ" and refuse rather than conclude. A caller that
// ignores it would silently treat a truncated read as an exhaustive one, which
// on a receipt surface is the false attestation this whole decision exists to
// prevent.
//
// BOUNDED BY THE CALLER'S `bytes`, never unbounded: the largest parent
// transcript measured on this machine is ~12MB (2026-09-06), so a caller's cap
// is there to stop a pathological file from turning a non-blocking hook into an
// allocation failure, not to trim ordinary reads. Returns null when the file
// does not exist, is not a regular file (a directory or similar — refused via
// fstatSync before any read is attempted), or any step throws (EACCES, EIO,
// etc.) — the same degrade-to-null discipline readTail's callers already lean
// on (see the comment at h22-dispatch-register.mjs's observedModelFromTranscript).
// A throw here is strictly worse than a refusal: every caller treats null as a
// named refusal (`child-transcript-missing` / `parent-transcript-missing`) and
// recovers, while an uncaught throw would escape to the hook's outer catch and
// skip the receipt entirely. Every other outcome is a { text, complete } a
// caller can judge.
//
// `readSync` is looped rather than called once: a single short read (common on
// some filesystems/mounts) would zero-pad the buffer while still reporting
// `complete: true` from the requested length, which is exactly the false
// attestation this function's contract exists to prevent. `complete` is
// computed from bytes actually read, never the request.
export function readFromStart(path, bytes) {
  if (!existsSync(path)) return null;
  try {
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      // Non-regular file (directory, FIFO, device, socket): refuse rather than
      // read. This closes the directory/EISDIR case outright (fstatSync alone
      // never throws on a directory fd). It does NOT stop a true named pipe
      // from blocking at the `openSync` call above — that happens before this
      // check ever runs and would need O_NONBLOCK + ENXIO handling, which is a
      // bigger change than this fix; disclosed, not silently left.
      if (!stat.isFile()) return null;
      const size = stat.size;
      const want = Math.min(size, bytes);
      const buf = Buffer.alloc(want);
      let readTotal = 0;
      while (readTotal < want) {
        const n = readSync(fd, buf, readTotal, want - readTotal, readTotal);
        if (n === 0) break; // no more bytes available — stop, don't spin
        readTotal += n;
      }
      return { text: buf.toString('utf8', 0, readTotal), complete: readTotal === size };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

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
