// Version-only proof — ONE implementation shared by direct-merge (a proven
// version-only manifest never blocks or mints a merge refusal, article
// direct-merge-and-branch-sweep AC5) and H10's capture duty (a release bump is
// release mechanics, not knowledge work). Decision gap-hunt-2026-09-28-rulings,
// items (4+5).
//
// A path is version-only between two contents ONLY if ALL of these hold; any
// failure is `false` (fail closed, never a carve-out):
//   (a) the path is one of VERSION_ONLY_CANDIDATES, and both endpoints are
//       regular files (committed endpoints: blob mode 100644/100755 and the
//       SAME mode on both sides — a bundled chmod is not version-only);
//   (b) both contents decode as STRICT UTF-8 (a lossy decode could fold two
//       different invalid bytes into the same U+FFFD) and parse as JSON;
//   (c) both top-level `.version` values are strings and they differ;
//   (d) split on '\n' (a '\r' stays attached to its line; no other
//       normalization), both contents have the same line count, and every
//       differing line is a standalone `"version": "<v>"` line (optional
//       trailing comma) that turns into the tip's line by replacing the quoted
//       base version with the quoted tip version and nothing else;
//   (e) at most `maxLines` lines differ: 1 for package.json and plugin.json,
//       2 for package-lock.json (its top-level version and packages[""]);
//   (f) resetting exactly the allowed version fields on the tip's parsed JSON
//       to the base's values yields the base's parsed JSON — so a dependency
//       whose own version line happened to equal the root version can never
//       ride along as a "version line".
// A whole-file CRLF conversion, a reformat, a key reorder, an added script or
// a dependency edit therefore fails closed and still counts as a change.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCKFILE = 'package-lock.json';
// Each candidate names the version fields a release bump may move, as paths
// into the parsed JSON.
const ALLOWED_FIELDS = new Map([
  ['.claude-plugin/plugin.json', [['version']]],
  ['package.json', [['version']]],
  [LOCKFILE, [['version'], ['packages', '', 'version']]],
]);
export const VERSION_ONLY_CANDIDATES = [...ALLOWED_FIELDS.keys()];

const VERSION_LINE_RE = /^"version"\s*:\s*"[^"]*"\s*,?$/;

function strictUtf8(bytes) {
  if (bytes === null || bytes === undefined) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function getAt(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return { present: false };
    cur = cur[key];
  }
  return { present: true, value: cur };
}

function setAt(obj, path, value) {
  let cur = obj;
  for (const key of path.slice(0, -1)) cur = cur[key];
  cur[path.at(-1)] = value;
}

/**
 * The content-level proof, (b)-(f) above, over two already-decoded texts.
 * Pure: no git, no filesystem.
 */
export function isVersionOnlyText(path, baseContent, tipContent) {
  const fields = ALLOWED_FIELDS.get(path);
  if (!fields || typeof baseContent !== 'string' || typeof tipContent !== 'string') return false;
  let base;
  let tip;
  try {
    base = JSON.parse(baseContent);
    tip = JSON.parse(tipContent);
  } catch {
    return false; // (b)
  }
  const baseVersion = base?.version;
  const tipVersion = tip?.version;
  // String versions only: a duplicate "version" key can make `.version` an
  // object, and two distinct objects always differ by identity.
  if (typeof baseVersion !== 'string' || typeof tipVersion !== 'string' || baseVersion === tipVersion) return false; // (c)

  const baseLines = baseContent.split('\n');
  const tipLines = tipContent.split('\n');
  if (baseLines.length !== tipLines.length) return false; // (d)
  const from = JSON.stringify(baseVersion);
  const to = JSON.stringify(tipVersion);
  let differing = 0;
  for (let i = 0; i < baseLines.length; i++) {
    const b = baseLines[i];
    const t = tipLines[i];
    if (b === t) continue;
    differing += 1;
    if (!VERSION_LINE_RE.test(b.trim()) || !VERSION_LINE_RE.test(t.trim())) return false; // (d)
    const at = b.indexOf(from);
    if (at === -1 || b.indexOf(from, at + 1) !== -1) return false;
    if (b.slice(0, at) + to + b.slice(at + from.length) !== t) return false; // (d)
  }
  if (differing === 0 || differing > fields.length) return false; // (e)

  for (const field of fields) {
    const b = getAt(base, field);
    const t = getAt(tip, field);
    if (b.present !== t.present) return false;
    if (b.present) setAt(tip, field, b.value);
  }
  return JSON.stringify(tip) === JSON.stringify(base); // (f)
}

function lsTreeEntry(root, sha, path) {
  const r = spawnSync('git', ['ls-tree', sha, '--', path], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  const line = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (!line) return null;
  const m = line.match(/^(\d+)\s+(\S+)\s+([0-9a-f]+)\t(.+)$/);
  return m ? { mode: m[1], type: m[2], hash: m[3] } : null;
}

const isRegularBlob = (e) => !!e && e.type === 'blob' && (e.mode === '100644' || e.mode === '100755');

function showBlobText(root, sha, path) {
  const r = spawnSync('git', ['show', `${sha}:${path}`], { cwd: root, encoding: 'buffer', timeout: 30_000 });
  return r.status === 0 ? strictUtf8(r.stdout) : null;
}

/** The top-level `.version` of a JSON file at a commit, or null (for reports). */
export function readVersionAtCommit(root, sha, path) {
  const content = showBlobText(root, sha, path);
  if (content === null) return null;
  try {
    return JSON.parse(content)?.version ?? null;
  } catch {
    return null;
  }
}

/** Version-only between two COMMITS (direct-merge: merge base vs branch tip). */
export function isVersionOnlyBetweenCommits(root, baseSha, tipSha, path) {
  if (!ALLOWED_FIELDS.has(path) || !baseSha || !tipSha) return false;
  const baseEntry = lsTreeEntry(root, baseSha, path);
  const tipEntry = lsTreeEntry(root, tipSha, path);
  if (!isRegularBlob(baseEntry) || !isRegularBlob(tipEntry) || baseEntry.mode !== tipEntry.mode) return false; // (a)
  return isVersionOnlyText(path, showBlobText(root, baseSha, path), showBlobText(root, tipSha, path));
}

/**
 * Version-only between a COMMIT and the WORKING TREE (H10: the settled
 * snapshot's commit vs the file as it stands at Stop). The working-tree side
 * must be a regular file (never a symlink); its mode is not compared, because
 * a mode flip carries no knowledge and git may not even track it
 * (core.fileMode false).
 */
export function isVersionOnlyInWorkingTree(root, baseSha, path) {
  if (!ALLOWED_FIELDS.has(path) || !baseSha) return false;
  if (!isRegularBlob(lsTreeEntry(root, baseSha, path))) return false; // (a)
  let current;
  try {
    if (!lstatSync(join(root, path)).isFile()) return false; // (a)
    current = strictUtf8(readFileSync(join(root, path)));
  } catch {
    return false;
  }
  return isVersionOnlyText(path, showBlobText(root, baseSha, path), current);
}
