// The one "is this directory a Sterling source tree" probe: a clone, a linked worktree or a
// second checkout of Sterling, recognized by its manifest. Callers: isSterlingClone
// (handoff-projection.mjs, the skip sync-agents and init apply) and the post-update sync
// (post-update-sync.mjs, which skips stamp-contract for such a project).
//
// Builtins only, transitively: contained-fs.mjs and store-path.mjs import nothing else, so
// the hook and OpenCode server bundles can vendor this module.
//
// The probe reads TARGET paths, so it goes through contained-fs: the manifest and the
// sentinel script must each be a regular file, with no symlink on the way and the path
// resolving inside `dir`. A symlinked or non-file entry throws ContainmentError rather than
// spoofing a silent "clone, skipped". Callers turn that into an actionable refusal, or, for
// a caller that must never throw, use looksLikeSterlingSourceTree.
import { ContainmentError, existsContained, readContained } from './contained-fs.mjs';

const MANIFEST = '.claude-plugin/plugin.json';
const SENTINEL = 'scripts/architecture-projection.mjs';

/**
 * True when `dir` holds a Sterling manifest (name 'sterling') and the sentinel script.
 * False when either is absent. Throws ContainmentError for a symlink or non-file at either
 * path, and the JSON.parse or read error for a manifest that cannot be read.
 */
export function isSterlingSourceTree(dir) {
  if (!existsContained(dir, MANIFEST, 'file') || !existsContained(dir, SENTINEL, 'file')) return false;
  return JSON.parse(readContained(dir, MANIFEST)).name === 'sterling';
}

/**
 * isSterlingSourceTree for a caller that must not throw: a refused path (symlink, directory),
 * a manifest that is unreadable or not a JSON object, all read as "not a source tree". Any
 * other error is a bug and propagates.
 */
export function looksLikeSterlingSourceTree(dir) {
  try {
    return isSterlingSourceTree(dir);
  } catch (err) {
    if (err instanceof ContainmentError || err instanceof SyntaxError || err instanceof TypeError || typeof err?.code === 'string') return false;
    throw err;
  }
}
