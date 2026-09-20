// ---------------------------------------------------------------------------
// Attestation evidence — the proof that a worktree path's bytes ARE the bytes
// git has for that path in a named commit (R9, board 8c8b6d78).
//
// THE INVARIANT. For each attested path P: the baseline this module returns is
// sha256(B), where B is a byte buffer THIS PROCESS READ from the worktree at P
// through ONE file descriptor, and the proof that B is HEAD's content is made
// ABOUT B ITSELF — `git hash-object --path=P --stdin` fed B must print exactly
// the blob id of P's regular-file entry in the tree of commit C. Membership,
// name and mode come from `git ls-tree` against C, and the NAME git returns
// must equal P byte-for-byte, so the tree is the name authority: trailing-dot,
// 8.3 and case aliases can never match an entry, because git's tree does not
// contain them. Because the proof and the returned baseline are made about the
// SAME buffer, no race between a filesystem check and the read can make the
// attestation lie: whatever else happens on disk, the bytes we hashed are the
// bytes we proved.
//
// EXPLICITLY NOT GUARANTEED:
//   - that the worktree stays clean AFTERWARDS. Drift detection owns that; an
//     attestation is a statement about one instant, not a lease.
//   - anything about non-regular paths. They are refused, never guessed at.
//   - whether a path PROVEN absent from this commit remains absent afterwards.
//     An absence attestation is a historical tree fact, not a lease.
//   - on Windows, where O_NOFOLLOW does not exist, the no-follow read is
//     BEST-EFFORT: we lstat before opening and refuse a link, but the open
//     itself cannot be told not to follow. No proxy for it is built here — a
//     dev/ino or realpath proxy is a second, weaker identity check that invites
//     exactly the aliasing bugs this rewrite removed. The residual window is
//     disclosed rather than papered over, and it cannot forge a passing
//     attestation on its own: a swapped-in target's bytes still have to hash to
//     HEAD's blob id for P.
//
// Everything else this module deliberately does NOT do: no realpath, no
// dev/ino identity proxy, no parent-chain containment walk, no second
// re-hash pass. Each of those was a guard around a hand-resolved path; the
// path is not hand-resolved any more.
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

/** A refusal from the evidence collector. Always names the path (when one is implicated) and the reason. */
export class AttestationRefusal extends Error {
  readonly path?: string;
  readonly reason: string;
  constructor(reason: string, path?: string) {
    super(path ? `attestation refused for '${path}': ${reason}` : `attestation refused: ${reason}`);
    this.name = 'AttestationRefusal';
    this.reason = reason;
    if (path !== undefined) this.path = path;
  }
}

export interface PresentPathEvidence {
  kind: 'present';
  /** sha256 of the exact buffer this process read from the worktree. */
  sha256: string;
  /** The git blob id of P in commit C — equal to `git hash-object --path=P` of that same buffer. */
  blob: string;
}

/** A tree-only result. No file was opened and no bytes or blob id exist. */
export interface AbsencePathEvidence {
  kind: 'absence';
}

export type PathEvidence = PresentPathEvidence | AbsencePathEvidence;

export interface AttestationEvidence {
  head_commit: string;
  perPath: Record<string, PathEvidence>;
}

export interface CollectOptions {
  /** Absolute path to the worktree root the paths are relative to. */
  root: string;
  /** Repo-relative POSIX paths to attest. */
  keys: string[];
  /** Total byte budget across all paths; a path is refused BEFORE its bytes are allocated. */
  maxTotalBytes: number;
}

// Git subprocess bounds. Filter programs (`--path=` runs the configured clean
// filter) are arbitrary configured executables, so every call is bounded.
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

const HEX_COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

interface GitResult {
  stdout: Buffer;
  stderr: string;
}

function git(root: string, args: string[], input?: Buffer): GitResult {
  const res = spawnSync('git', ['-C', root, ...args], {
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    ...(input === undefined ? {} : { input }),
  });
  const stderr = res.stderr ? Buffer.from(res.stderr).toString('utf8').trim() : '';
  if (res.error) throw new AttestationRefusal(`git ${args[0]} failed to run: ${res.error.message}`);
  if (res.signal) throw new AttestationRefusal(`git ${args[0]} was killed by signal ${res.signal} (timeout ${GIT_TIMEOUT_MS}ms)`);
  if (res.status !== 0) throw new AttestationRefusal(`git ${args[0]} exited ${res.status}${stderr ? `: ${stderr}` : ''}`);
  return { stdout: res.stdout ? Buffer.from(res.stdout) : Buffer.alloc(0), stderr };
}

/** Step 1 — the commit every later step is judged against, captured ONCE. */
function headCommit(root: string): string {
  const out = git(root, ['rev-parse', 'HEAD']).stdout.toString('utf8').trim();
  if (!out) throw new AttestationRefusal('HEAD is unavailable (git rev-parse HEAD printed nothing)');
  // A sha256-object-format repo has a 64-char HEAD and is perfectly attestable.
  if (!HEX_COMMIT.test(out)) throw new AttestationRefusal(`HEAD is not a commit id: '${out}'`);
  return out;
}

interface TreeEntry {
  mode: string;
  type: string;
  object: string;
}

/**
 * Step 2 — ONE batched `ls-tree` is the membership, name and mode authority.
 * `--literal-pathspecs` disables pathspec magic; the returned NAME must equal
 * the requested key byte-for-byte, which is what makes every filesystem-level
 * name alias unrepresentable here.
 */
function parseTreeEntries(stdout: Buffer): Map<string, TreeEntry> {
  const byName = new Map<string, TreeEntry>();
  const duplicates = new Set<string>();
  let start = 0;
  while (start < stdout.length) {
    let end = stdout.indexOf(0, start);
    if (end === -1) end = stdout.length;
    const record = stdout.subarray(start, end);
    start = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(0x09);
    if (tab === -1) throw new AttestationRefusal(`git ls-tree produced an unparseable entry: '${record.toString('utf8')}'`);
    const fields = record.subarray(0, tab).toString('utf8').split(' ');
    if (fields.length !== 3) throw new AttestationRefusal(`git ls-tree produced an unparseable entry: '${record.toString('utf8')}'`);
    // The name is compared as BYTES against the requested key — never normalized.
    const name = record.subarray(tab + 1).toString('utf8');
    const [mode, type, object] = fields as [string, string, string];
    if (byName.has(name)) duplicates.add(name);
    byName.set(name, { mode, type, object });
  }
  for (const dup of duplicates) throw new AttestationRefusal('git ls-tree returned more than one entry for this path', dup);
  return byName;
}

function headTreeEntries(root: string, commit: string, keys: string[]): Map<string, TreeEntry> {
  const { stdout } = git(root, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...keys]);
  return parseTreeEntries(stdout);
}

/** The alias guard needs every tree name, including recursive tree entries.
 * It runs only after the unchanged exact-name lookup missed. */
function allHeadTreeEntries(root: string, commit: string): Map<string, TreeEntry> {
  const { stdout } = git(root, ['ls-tree', '-r', '-t', '-z', '--full-tree', commit]);
  return parseTreeEntries(stdout);
}

/** The filesystem aliases R9 has to reject: case-folding and trailing-dot
 * stripping on every component. The original literal lookup stays authoritative
 * for a real match; this normalization is refusal-only, never resolution. */
function aliasForm(path: string): string {
  return path
    .split('/')
    .map((component) => component.replace(/\.+$/u, '').toLowerCase())
    .join('/');
}

function isAliasOfTreeEntry(allEntries: Map<string, TreeEntry>, key: string): boolean {
  const wanted = aliasForm(key);
  for (const name of allEntries.keys()) {
    if (name !== key && aliasForm(name) === wanted) return true;
  }
  return false;
}

function blobIdFor(entry: TreeEntry, key: string): string {
  if (entry.mode === '120000') throw new AttestationRefusal(`the tree entry is a symlink (mode 120000), not a regular file`, key);
  if (entry.mode === '160000') throw new AttestationRefusal(`the tree entry is a git submodule / gitlink (mode 160000), not a regular file`, key);
  if (entry.mode === '040000' || entry.mode === '40000' || entry.type === 'tree') throw new AttestationRefusal(`the tree entry is a directory (mode ${entry.mode}), not a regular file`, key);
  if (!REGULAR_FILE_MODES.has(entry.mode) || entry.type !== 'blob') {
    throw new AttestationRefusal(`the tree entry is not a regular file (mode ${entry.mode}, type ${entry.type})`, key);
  }
  return entry.object;
}

/**
 * Every filesystem call on the attestation path goes through here, so a raw
 * errno can never escape this module (review finding 3). `lstat`, `open`,
 * `fstat` and `read` all throw plain `Error`s carrying a `code` AND an ABSOLUTE
 * path in their message ("EACCES: permission denied, open '/abs/…'"), which the
 * caller then rethrew verbatim — outside the refusal voice, and leaking a
 * machine path into a durable-looking message. The refusal names the
 * REPO-RELATIVE key and the errno CODE only: the code is the actionable half,
 * and the message text is deliberately not forwarded because that is where the
 * absolute path lives.
 */
function fsStep<T>(key: string, what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AttestationRefusal) throw err;
    const code = (err as { code?: unknown }).code;
    throw new AttestationRefusal(`${what} failed (${typeof code === 'string' ? code : 'unknown filesystem error'})`, key);
  }
}

/**
 * Step 3 — ONE read through ONE descriptor. lstat first (the only no-follow
 * lever available before the open), open with O_NOFOLLOW where the platform
 * defines it, then fstat THAT handle and read from THAT handle. The size is
 * checked against the remaining budget BEFORE any buffer is allocated.
 *
 * EXACTLY `st.size` BYTES ARE READ, never "to EOF" (review finding 2). The
 * budget is checked against the size fstat reported, so a `readFileSync(fd)`
 * that keeps reading until EOF would allocate PAST that budget for a file
 * growing between the fstat and the read — the check would have been made about
 * a size the read no longer honours. Reading into a pre-sized buffer makes the
 * allocation exactly what was authorized; a file that grew simply fails the
 * proof afterwards (its first `st.size` bytes do not hash to HEAD's blob), and a
 * file that SHRANK is refused here, because a short buffer would otherwise be
 * hashed with uninitialized tail bytes.
 */
function readOwnedFile(root: string, key: string, remainingBytes: number, maxTotalBytes: number): Buffer {
  const abs = resolve(root, ...key.split('/'));
  const pre = fsStep(key, 'lstat', () => lstatSync(abs, { throwIfNoEntry: false }));
  if (!pre) throw new AttestationRefusal('the path does not exist in the worktree', key);
  if (pre.isSymbolicLink()) throw new AttestationRefusal('the worktree path is a symlink, not a regular file', key);
  if (!pre.isFile()) throw new AttestationRefusal('the worktree path is not a regular file', key);

  const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = fsStep(key, 'open', () => openSync(abs, fsConstants.O_RDONLY | noFollow));
  try {
    const st = fsStep(key, 'fstat', () => fstatSync(fd));
    if (!st.isFile()) throw new AttestationRefusal('the opened handle is not a regular file', key);
    if (st.size > remainingBytes) {
      throw new AttestationRefusal(
        `file size ${st.size} bytes exceeds the remaining attestation byte budget (${remainingBytes} of a ${maxTotalBytes} byte limit) — refused before reading`,
        key
      );
    }
    const bytes = Buffer.allocUnsafe(st.size);
    let filled = 0;
    while (filled < st.size) {
      const read = fsStep(key, 'read', () => readSync(fd, bytes, filled, st.size - filled, filled));
      if (read === 0) {
        throw new AttestationRefusal(
          `the file is shorter than the ${st.size} bytes fstat reported (only ${filled} could be read) — it changed size while it was being read, so no buffer here can be attested`,
          key
        );
      }
      filled += read;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Step 4 — the proof is made about the buffer we just read, not about the path.
 * `--path=` makes git apply the same clean filter it applied when the blob was
 * written, so an equal blob id means equal committed content.
 */
function hashObjectOf(root: string, key: string, bytes: Buffer): string {
  const out = git(root, ['hash-object', `--path=${key}`, '--stdin'], bytes).stdout.toString('utf8').trim();
  if (!out) throw new AttestationRefusal('git hash-object printed nothing for the bytes read from the worktree', key);
  return out;
}

/**
 * Collect the evidence for every key, refusing loudly on every abnormal shape.
 * NOTHING here writes to the store, and this must run BEFORE the store
 * transaction opens: git filter programs are arbitrary configured executables
 * and must never run under the SQLite writer lock.
 */
export function collectAttestationEvidence(opts: CollectOptions): AttestationEvidence {
  const { root, keys, maxTotalBytes } = opts;
  if (!root) throw new AttestationRefusal('no worktree root was supplied');
  if (keys.length === 0) throw new AttestationRefusal('no paths to attest');

  const head = headCommit(root);
  const entries = headTreeEntries(root, head, keys);
  // A literal miss is absence only after the tree proves no entry exists under
  // an alias spelling. Do not consult the filesystem: an on-disk alias is
  // exactly the shape this guard must refuse rather than resolve.
  const allEntries = keys.some((key) => !entries.has(key)) ? allHeadTreeEntries(root, head) : undefined;

  const perPath: Record<string, PathEvidence> = {};
  let remaining = maxTotalBytes;
  for (const key of keys) {
    const entry = entries.get(key);
    // The literal ls-tree query is the absence proof. Do not inspect the
    // worktree here: an untracked file may exist on disk and cannot alter what
    // HEAD's tree says about this exact byte-for-byte name.
    if (!entry) {
      if (allEntries && isAliasOfTreeEntry(allEntries, key)) {
        throw new AttestationRefusal(
          `no entry with this exact name in the tree of commit ${head} (untracked, absent, or a name that only differs by an alias)`,
          key
        );
      }
      perPath[key] = { kind: 'absence' };
      continue;
    }
    const blob = blobIdFor(entry, key);
    const bytes = readOwnedFile(root, key, remaining, maxTotalBytes);
    remaining -= bytes.length;
    const actual = hashObjectOf(root, key, bytes);
    if (actual !== blob) {
      throw new AttestationRefusal(
        `the worktree bytes are not the content committed in ${head} (git hash-object of the bytes read is ${actual}, the tree entry is ${blob}) — an uncommitted or modified file cannot be attested`,
        key
      );
    }
    perPath[key] = { kind: 'present', sha256: createHash('sha256').update(bytes).digest('hex'), blob };
  }
  return { head_commit: head, perPath };
}
