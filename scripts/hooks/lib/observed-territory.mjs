// OBSERVED TOOL-USE TERRITORY (decision review-territory-observed-evidence,
// 9500cce1) — scans a subagent's OWN transcript for tool_use blocks and
// classifies them into reads/writes, repo-relative POSIX against a given
// cwd. This is CORROBORATION ONLY (H22 SubagentStop): declared
// REVIEW-TERRITORY stays the receipt's authoritative files/files_source, and
// this module never gates anything — it only extracts and normalizes.
//
// Reuses lib/transcript.mjs's readTail (same 1MB tail window H6/H22 already
// use) rather than a whole-file read, and lib/common.mjs's repoRel (the same
// normalizeRepoPath/toRepoRelative primitive every other hook path uses) —
// one path-normalization mechanism, never a second divergent one.
//
// DEGRADATION (unobservable -> null, vs. observed-and-empty -> {reads:[],
// writes:[]}): a missing/empty transcriptPath, a nonexistent file, or a
// read that fails/returns empty all mean "could not observe" and must not
// be confused with "observed and found nothing" — the latter is a
// perfectly readable transcript that simply dispatched zero tool_use
// blocks. Malformed JSONL lines are skipped individually, never fatal to
// the whole scan.
import { existsSync, statSync } from 'node:fs';
import { readTail } from './transcript.mjs';
import { repoRel } from './common.mjs';

const WRITE_TOOLS_FILE_PATH = new Set(['Edit', 'Write']);

// Mirrors scripts/hooks/lib/transcript.mjs's own TAIL_BYTES (1MB) — kept as a
// literal here rather than importing a constant that file does not export
// (transcript.mjs sits outside this fix's REVIEW-TERRITORY). Used only to
// detect truncation (file size exceeds the tail window readTail actually
// read), never to change the read itself.
const TAIL_BYTES = 1024 * 1024;

// A directory-shaped Grep `path` (no file extension) is excluded — Grep
// only contributes FILE paths, unlike Glob, which carries no such
// qualifier. "Extension" is read as: the path's final '/'-delimited
// segment contains a '.' at all (matches the spec's worked examples:
// 'src/grep-file.mjs' qualifies, 'src' does not).
function hasFileExtension(p) {
  const idx = p.lastIndexOf('/');
  const base = idx === -1 ? p : p.slice(idx + 1);
  return base.includes('.');
}

export function observedToolPaths(transcriptPath, cwd) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  if (!existsSync(transcriptPath)) return null;

  let tail;
  try {
    tail = readTail(transcriptPath);
  } catch {
    return null; // permission-denied or any other read failure
  }
  if (tail === null || tail === '') return null; // unreadable or zero-byte

  // TRUNCATION HONESTY (review MEDIUM) — a transcript larger than the tail
  // window read only its LAST TAIL_BYTES: the window may start mid-line,
  // which the malformed-line skip above already tolerates silently, but
  // silence here would misrepresent a partial scan as a complete one. A stat
  // failure after a successful read (file removed mid-scan) is exotic and
  // must never be treated as proof of truncation it cannot demonstrate.
  let truncated = false;
  try {
    truncated = statSync(transcriptPath).size > TAIL_BYTES;
  } catch {
    // leave truncated:false — an unprovable claim is not reported as true
  }

  const reads = new Set();
  const writes = new Set();

  const add = (set, rawPath) => {
    if (typeof rawPath !== 'string' || rawPath === '') return;
    const rel = repoRel(rawPath, cwd);
    if (!rel) return; // outside cwd, or unresolvable
    // Case-insensitive (Codex LOW): a Windows checkout can produce '.GIT/…'
    // or '.Sterling/…' — the case-sensitive startsWith let those survive.
    const lower = rel.toLowerCase();
    if (lower === '.git' || lower.startsWith('.git/') || lower === '.sterling' || lower.startsWith('.sterling/')) return;
    set.add(rel);
  };

  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skipped, not fatal
    }
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      const name = block.name;
      const input = block.input;
      if (WRITE_TOOLS_FILE_PATH.has(name)) {
        add(writes, input?.file_path);
      } else if (name === 'NotebookEdit') {
        add(writes, input?.notebook_path);
      } else if (name === 'Read') {
        add(reads, input?.file_path);
      } else if (name === 'Grep') {
        const p = input?.path;
        if (typeof p === 'string' && p !== '' && hasFileExtension(p)) add(reads, p);
      } else if (name === 'Glob') {
        add(reads, input?.path);
      }
    }
  }

  // TRUNCATION REPRESENTATION CHOICE (per the amendment): a third property,
  // present (true) ONLY when truncated — absent for a fully-covered
  // transcript so every pre-existing exact-shape assertion on {reads,writes}
  // stays valid unmodified.
  const result = { reads: [...reads], writes: [...writes] };
  if (truncated) result.truncated = true;
  return result;
}

// ROUND-SCOPED OBSERVATION (board 181d11e7 — the residual h22-dispatch-register
// disclosed at its rebaseline guard). Same extraction as observedToolPaths
// above, restricted to entries this agent recorded STRICTLY AFTER `sinceIso`.
//
// WHY IT EXISTS: "this agent read P at some point in its own transcript" is not
// the claim a RESUMED reviewer's rebaseline needs. A read recorded in round ONE
// says nothing about bytes edited AFTER round one finished, and the
// whole-transcript read set cannot tell the two apart — so a no-op follow-up
// Stop ("thanks, done") could rebind a path to bytes no round reviewed. The
// caller passes the receipt's PRIOR finished_at as the round boundary.
//
// observedToolPaths is DELIBERATELY LEFT UNTOUCHED rather than refactored into
// a shared core: it is the corroboration extractor whose exact shape existing
// pins and callers assert, and this fix's blast radius is the round-scoped read
// set alone. The classification below is therefore a deliberate second copy of
// the same rules (same tools, same repo-relative normalization, same
// .git/.sterling exclusion) — a change to one belongs in both.
//
// THE ROUND BOUNDARY IS THE ENTRY'S OWN TOP-LEVEL `timestamp` — an ISO-8601
// string Claude Code writes as a sibling of `type`/`uuid`/`requestId` on every
// transcript entry (verified against a live transcript on CC 2.1.263 before
// this was built).
//
// FAIL CLOSED IN BOTH DIRECTIONS THE BOUNDARY CAN BE UNUSABLE:
//   - an unusable `sinceIso` (absent, non-string, unparseable) means there is
//     no boundary to measure against, so NOTHING can be shown to belong to this
//     round -> null, the same "could not observe" value an unreadable
//     transcript yields;
//   - an entry whose own `timestamp` is missing or unparseable counts as NOT
//     THIS ROUND and is skipped — never as "probably recent".
// Both leave the caller with no positive evidence, which on the rebaseline path
// means the receipt keeps the bytes it actually reviewed. `truncated` is
// reported exactly as above, and matters MORE here: a tail window that dropped
// the start of this round cannot be distinguished from a round that read
// nothing.
export function observedToolPathsSince(transcriptPath, cwd, sinceIso) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  if (!existsSync(transcriptPath)) return null;
  if (typeof sinceIso !== 'string' || sinceIso === '') return null;
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return null;

  let tail;
  try {
    tail = readTail(transcriptPath);
  } catch {
    return null; // permission-denied or any other read failure
  }
  if (tail === null || tail === '') return null; // unreadable or zero-byte

  let truncated = false;
  try {
    truncated = statSync(transcriptPath).size > TAIL_BYTES;
  } catch {
    // leave truncated:false — an unprovable claim is not reported as true
  }

  const reads = new Set();
  const writes = new Set();

  const add = (set, rawPath) => {
    if (typeof rawPath !== 'string' || rawPath === '') return;
    const rel = repoRel(rawPath, cwd);
    if (!rel) return; // outside cwd, or unresolvable
    const lower = rel.toLowerCase();
    if (lower === '.git' || lower.startsWith('.git/') || lower === '.sterling' || lower.startsWith('.sterling/')) return;
    set.add(rel);
  };

  for (const line of tail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skipped, not fatal
    }
    if (entry?.type !== 'assistant') continue;
    // THE ROUND FILTER, STRICTLY AFTER (`>`, board 181d11e7's own wording).
    // `sinceIso` is the PRIOR round's finished_at — the instant that round
    // ENDED — so a read carrying exactly that timestamp belongs to the round
    // that just finished, not to this one. Crediting it here would be the
    // PERMISSIVE direction on the one check that exists to stop a resumed
    // reviewer claiming credit for reads it did not perform this round, so the
    // boundary instant itself is excluded (P5, fail closed).
    const stamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isFinite(stamp) || stamp <= sinceMs) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use') continue;
      const name = block.name;
      const input = block.input;
      if (WRITE_TOOLS_FILE_PATH.has(name)) {
        add(writes, input?.file_path);
      } else if (name === 'NotebookEdit') {
        add(writes, input?.notebook_path);
      } else if (name === 'Read') {
        add(reads, input?.file_path);
      } else if (name === 'Grep') {
        const p = input?.path;
        if (typeof p === 'string' && p !== '' && hasFileExtension(p)) add(reads, p);
      } else if (name === 'Glob') {
        add(reads, input?.path);
      }
    }
  }

  const result = { reads: [...reads], writes: [...writes] };
  if (truncated) result.truncated = true;
  return result;
}
