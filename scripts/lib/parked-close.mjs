// PARKED-ITEM DELETION-SHAPED CLOSURE (board 1ab3c2bf, Codex thread 01a05b7e).
//
// direct-merge's parked-file sweep closed a system file_parked todo only when
// every path it named RETURNED at the merge target (existsSync). A merged
// branch that instead DELETED the parked file left its item open forever —
// the file is gone, so it can never "return", and no artifact-write binds to
// closing it (measured: S7 fold-away, items lingered as permanent noise).
//
// This module supplies the two primitives direct-merge wires together:
//   - deletedBetween: git-backed evidence of what was deleted, as an ENDPOINT
//     DIFF between two commits — never a history walk. A path deleted and
//     re-added somewhere between the two endpoints, or added and deleted
//     entirely between them, does not count: only what is missing at `toSha`
//     but present at `fromSha` counts as deleted.
//   - parkedItemResolved: the pure predicate combining presence-on-disk with
//     deletion evidence to decide whether an item's paths are all resolved.
import { spawnSync } from 'node:child_process';

/**
 * Repo-relative POSIX paths deleted between two commits, computed via the
 * endpoint diff `git diff --name-only --diff-filter=D --no-renames -z
 * <fromSha> <toSha>` — deletions that happened somewhere in history between
 * the two shas but are absent at BOTH endpoints do not count (this is an
 * endpoint diff, never a history walk). `--no-renames` is deliberate: a
 * rename's original path is exactly the parked-item shape we need to catch
 * (the owned file is gone from its recorded location), so a rename must
 * still report its source path as deleted rather than collapsing into an
 * R-status line `--diff-filter=D` never matches.
 *
 * On ANY failure (spawn error, non-zero exit) returns `null`, never an empty
 * Set — "could not measure" must stay distinguishable from "nothing deleted"
 * (fail-loud, P5).
 *
 * @param {string} cwd
 * @param {string} fromSha
 * @param {string} toSha
 * @returns {Set<string> | null}
 */
export function deletedBetween(cwd, fromSha, toSha) {
  const r = spawnSync('git', ['diff', '--name-only', '--diff-filter=D', '--no-renames', '-z', fromSha, toSha], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) return null;
  const out = r.stdout ?? '';
  // -z terminates every entry (including the last) with a NUL, so a trailing
  // split segment is always the empty string produced after the final NUL —
  // drop it rather than keep it as a spurious entry. Splitting on NUL (not
  // generic whitespace) preserves paths containing spaces exactly.
  const segments = out.split('\0');
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  return new Set(segments.filter((s) => s.length > 0));
}

/**
 * Pure: is a parked item's `paths` fully resolved? A path resolves if it
 * exists on disk (`existsFn`) OR — only when deletion evidence is available
 * (`deletedSet !== null`) — it appears in `deletedSet`. When `deletedSet` is
 * null (deletion evidence unavailable), a path resolves ONLY via `existsFn`:
 * deletion evidence unavailable must never close a deletion-shaped item. The
 * item is resolved iff `paths` is a non-empty array and EVERY path resolves.
 *
 * @param {unknown} paths
 * @param {Set<string> | null} deletedSet
 * @param {(path: string) => boolean} existsFn
 * @returns {boolean}
 */
export function parkedItemResolved(paths, deletedSet, existsFn) {
  if (!Array.isArray(paths) || paths.length === 0) return false;
  return paths.every((p) => existsFn(p) || (deletedSet !== null && deletedSet.has(p)));
}
