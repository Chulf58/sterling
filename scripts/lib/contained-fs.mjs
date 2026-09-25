// Contained filesystem access for generated files committed into a TARGET project
// (the handoff projection and the portable OpenCode agents). /sterling:update runs
// these against every registered project on the machine, so a symlinked
// docs/sterling/, type directory, .opencode/agents/ or leaf file must never let a
// read, write, listing or delete land outside the project (Sol review HIGH).
//
// One guard, every operation: `containedPath` lstat-walks each EXISTING component
// of root/rel, refusing a symlink anywhere on the path, then applies
// resolveStoreWritePath (no '..' or absolute segment, no realpath escape); it
// refuses an existing non-directory where a directory is required, and checks the
// leaf's kind. Nothing here swallows an error: a refusal throws ContainmentError,
// anything else propagates.
//
// THE INVARIANT, exactly: a symlink that ALREADY EXISTS anywhere on the path —
// root excluded, every intermediate directory, the leaf — when containedPath runs
// is refused, so no read, write, listing or delete follows it. What is NOT
// defended: a concurrent swap by another process between the check and the use.
// Every operation below re-opens the path by name after the walk, and Node has no
// openat2/RESOLVE_BENEATH (or a directory-fd-relative open) to pin the walked
// directories. O_NOFOLLOW on leaf writes (Linux, macOS; absent on Windows) covers
// only the LEAF: a parent directory swapped for a symlink after the walk is still
// followed, on every platform. The risk was accepted by user ruling ("Accept race,
// fix 2", 2026-09-25): the threat is a local process racing the update, which
// already runs with that user's rights.

import { lstatSync, readFileSync, readdirSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveStoreWritePath, StorePathContainmentError } from './store-path.mjs';

export class ContainmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContainmentError';
  }
}

const lstatOrNull = (p) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
};

// leaf: 'file' | 'dir'. Returns the absolute path; throws ContainmentError.
export function containedPath(root, rel, leaf) {
  const segments = rel.split('/').filter(Boolean);
  if (!segments.length || segments.some((s) => s === '..' || s === '.')) throw new ContainmentError(`'${rel}' is not a plain repo-relative path`);
  // Our own walk first, so a refusal names the component and the reason.
  let cursor = resolve(root);
  for (const [index, part] of segments.entries()) {
    cursor = join(cursor, part);
    const st = lstatOrNull(cursor);
    if (!st) break;
    const isLeaf = index === segments.length - 1;
    const wantDir = !isLeaf || leaf === 'dir';
    if (st.isSymbolicLink()) throw new ContainmentError(`${segments.slice(0, index + 1).join('/')} is a symlink — refusing to follow it out of the project`);
    if (wantDir && !st.isDirectory()) throw new ContainmentError(`${segments.slice(0, index + 1).join('/')} exists but is not a directory`);
    if (!wantDir && !st.isFile()) throw new ContainmentError(`${rel} exists but is not a regular file`);
  }
  // Then the shared store-path guard: realpath containment of the deepest
  // existing ancestor (the project root itself may legitimately be a symlink).
  try {
    return resolveStoreWritePath(root, ...segments);
  } catch (e) {
    if (e instanceof StorePathContainmentError) throw new ContainmentError(`${rel}: ${e.message.replace(/^resolveStoreWritePath: /, '')}`);
    throw e;
  }
}

export function existsContained(root, rel, leaf) {
  return lstatOrNull(containedPath(root, rel, leaf)) !== null;
}

export function readContained(root, rel) {
  return readFileSync(containedPath(root, rel, 'file'), 'utf8');
}

export function readdirContained(root, rel) {
  const abs = containedPath(root, rel, 'dir');
  return lstatOrNull(abs) ? readdirSync(abs) : [];
}

export function mkdirContained(root, rel) {
  const segments = rel.split('/').filter(Boolean);
  for (let i = 1; i <= segments.length; i++) {
    const partial = segments.slice(0, i).join('/');
    const abs = containedPath(root, partial, 'dir');
    if (!lstatOrNull(abs)) mkdirSync(abs);
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function writeContained(root, rel, content) {
  const parent = rel.split('/').slice(0, -1).join('/');
  if (parent) mkdirContained(root, parent);
  const abs = containedPath(root, rel, 'file');
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

// unlink never follows a symlink leaf, and containedPath has refused one anyway.
export function unlinkContained(root, rel) {
  unlinkSync(containedPath(root, rel, 'file'));
}
