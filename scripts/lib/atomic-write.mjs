// Atomic file replacement, shared by every writer of an installed agent file
// (.claude/agents/**, .opencode/agents/**) and the other files Sterling replaces whole.
//
// Why agent files need it: OpenCode reloads its agent registry within 100 ms of a change
// under {agent,agents}/ and silently drops a file it cannot read or parse, so a file
// caught half-written by writeFileSync is missing from the registry until the next reload,
// and every dispatch or turn of that agent fails with 'Agent not found' (GitHub #189). The
// temp file sits in the target's own directory (so the rename stays on one file system)
// and never ends in .md, so OpenCode's `{agent,agents}/**/*.md` glob never loads it and
// Claude Code's agent scan never sees it: an agent write (writeFileAtomicIfChanged) names
// it `.<name>.tmp-<pid>-<id>`, and writeFileAtomic's other callers keep `<path>.tmp-<uuid>`,
// the name their failure-injection seams match on.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The temp path a write of `path` goes through: same directory, dot-prefixed, never ending in .md. */
export function atomicTempPath(path) {
  return join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
}

/** Replace one file atomically: write a temp file beside it, then rename it
 *  over the target, so a failed write never leaves the target half-written.
 *  The temp file is removed when the write or the rename fails. */
export function writeFileAtomic(path, content, fs = {}) {
  replaceVia(`${path}.tmp-${randomUUID()}`, path, content, fs);
}

function replaceVia(tmp, path, content, { writeFile = writeFileSync, rename = renameSync } = {}) {
  try {
    writeFile(tmp, content);
    rename(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** writeFileAtomic, skipped when `path` already holds exactly `content`
 *  (so an unchanged agent file keeps its mtime and triggers no registry reload).
 *  Returns whether it wrote. */
export function writeFileAtomicIfChanged(path, content, fs) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  replaceVia(atomicTempPath(path), path, content, fs);
  return true;
}
