// Plan-lock primitives — the ONE implementation, shared by every surface that
// reads or writes .sterling/plan-lock.json: h31-plan-lock.mjs (the writer),
// h1-session-start.mjs (the PLAN LOCK section), h19-dispatch-staging.mjs (the
// ACTIVE PLAN line) and scripts/plan-lock.mjs (the manual CLI).
// Spec: decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`.
//
// WHY A MODULE AND NOT FOUR COPIES: sanitisation, the bounded hash, title
// extraction, status computation, project detection and the atomic write were
// duplicated across four files. Four copies of a security-relevant predicate is
// four places to fix and three places to overlook — and the fix rounds on this
// slice were already landing on some copies and not others.
//
// RAW VS RENDERED, the distinction the whole module turns on: `plan_path` is
// stored RAW AND VERBATIM as the harness gave it (never trimmed, sanitised or
// truncated) because it must still resolve on disk — truncating a path to 512
// characters produces a path to a DIFFERENT file, and a lock whose recorded
// path cannot be opened is worse than no lock. Sanitisation and length bounds
// apply ONLY where a value is RENDERED into agent-visible context.
//
// ACCEPTED BEHAVIOUR, disclosed because it is a refusal a user can actually
// hit: a plan file or a lock reached through a SYMLINK at the final path
// component is REFUSED, never followed — the plan then reads UNREADABLE and the
// lock reads MALFORMED, both naming the reason. O_NOFOLLOW cannot tell a
// convenience symlink from one aimed at a FIFO or at another project's file, so
// the safe answer is the only answer. RECORD THE REAL PATH: H31 stores exactly
// what the harness hands it, so this only bites a hand-symlinked setup, and the
// remedy is to lock the resolved path (plan-lock.mjs --plan <real path>).
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants as FS, existsSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A plan path is attacker-influenceable input and is never read blind: a FIFO
// would hang the reader (SessionStart, in H1's case), a directory or device
// read is meaningless, and an oversize file would be hashed for nothing. 4 MiB
// is orders of magnitude above any real plan.
export const PLAN_MAX_BYTES = 4 * 1024 * 1024;
// THE FIXED .sterling PATHS ARE NOT SAFER THAN THE PLAN PATH. A lock or a
// marker path can be replaced with a FIFO (or a symlink to one) by anything
// that can write .sterling/, and a blocking read there stalls SessionStart
// itself — the worst place in the system to hang. Both are read through the
// same stat-first reader. 64 KiB is orders of magnitude above either record.
export const LOCK_MAX_BYTES = 64 * 1024;
export const MARKER_MAX_BYTES = 64 * 1024;
export const TITLE_MAX = 200;
export const PATH_MAX = 512;
export const REASON_MAX = 400;
export const LOCK_FILE = 'plan-lock.json';

const HEX64 = /^[0-9a-f]{64}$/i;

/** POSIX or Windows-drive absolute, as the harness gave it. */
export function isAbsolutePlanPath(p) {
  return typeof p === 'string' && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p));
}

/**
 * A Sterling project is one holding .sterling/sterling.db — the SAME predicate
 * scripts/lib/project.mjs's resolveProject() and the hooks' own
 * lib/common.mjs projectRoot() use. A bare .sterling DIRECTORY is NOT a
 * project: ~/.sterling exists on every machine and holds the domain stores.
 * The predicate is reimplemented here rather than imported so this module stays
 * bundleable into every hook with no workspace dependency (invariant 4) —
 * project.mjs would drag @sterling/schemas and @sterling/store into the bundle,
 * and openProject() opens a write-locking store connection just to answer an
 * existence question.
 */
export function isSterlingProject(cwd) {
  return typeof cwd === 'string' && existsSync(join(cwd, '.sterling', 'sterling.db'));
}

export function sterlingDirOf(cwd) {
  return join(cwd, '.sterling');
}

/**
 * The one sanitiser for anything RENDERED into additionalContext or stdout.
 * Strips C0 controls, DEL, and the C1 block U+0080-U+009F — the last of which
 * includes U+0085 NEL, treated as a LINE BREAK by many terminals and log
 * parsers, so a title carrying it could otherwise fabricate a new line in an H1 or
 * H19 payload while surviving a JSON round-trip invisibly.
 */
export function sanitizeForContext(value, max) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += ch;
  }
  out = out.trim();
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * THE ONE READER. Every read in this module goes through it — the plan file,
 * the lock, and a claimed marker — and no path-based readFileSync remains.
 *
 * FD-BASED, because a stat-then-read pair is a race: whatever passed the stat
 * can be swapped for a FIFO, a directory, or a 5 GB file before the read opens
 * it again, and the guard would have vouched for a file that is no longer
 * there. Here the path is resolved ONCE, at openSync, and every later question
 * — is it a regular file, how big is it, what are its bytes — is asked of THAT
 * DESCRIPTOR, which cannot be re-pointed.
 *
 * THREE OPEN FLAGS, each closing a different hole, each `?? 0` because a
 * platform that does not define one must not be handed NaN:
 *
 *   O_NOFOLLOW refuses a SYMLINK at the final component, so a symlink aimed at
 *   a FIFO cannot even be opened. It guards ONLY the last component — an
 *   intermediate directory swap is still possible and is NOT claimed to be
 *   closed here (anti_pattern `descriptor-pin-defeated-at-acquisition-when-the-
 *   directory-fd-is-opened-by-absolute-path`).
 *
 *   O_NONBLOCK is what makes the fstat check below REACHABLE against a DIRECT
 *   FIFO. Without it, opening a FIFO with no writer blocks forever INSIDE
 *   openSync — before any classification can run — which on the H1 path means
 *   SessionStart itself never returns. O_NOFOLLOW does not help here: the FIFO
 *   is the path, not a symlink to one. With it the open returns immediately and
 *   fstat rejects the non-regular shape. Once fstat has confirmed a REGULAR
 *   file the flag is inert: regular-file reads never return EAGAIN, and on the
 *   theoretical platform where one did, the catch below reports it as
 *   unreadable rather than spinning in the read loop.
 *
 * WINDOWS ARM: neither O_NOFOLLOW nor O_NONBLOCK exists there, so both fold to
 * 0 and this reduces to a plain O_RDONLY open. That is not a silent gap — a
 * Win32 named pipe is a different object living in \\.\pipe\, not something
 * openSync reaches through a filesystem path, so the blocking-FIFO hazard this
 * closes has no Windows analogue at these paths. Symlink following on Windows
 * is NOT covered; the fstat classification still is, and it is what catches
 * every non-regular shape on both platforms.
 *
 * Returns {bytes} or {unreadable: reason, code} — `code` is the errno, so a
 * caller can tell ENOENT (absent) from EACCES/ELOOP/ENOTDIR (present but
 * unusable), which are different facts and must never be collapsed.
 */
function readBounded(path, maxBytes, noun) {
  if (typeof path !== 'string' || !path) return { unreadable: `no ${noun} path recorded`, code: 'ENOENT' };
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0));
  } catch (e) {
    return { unreadable: `could not be opened (${(e && e.message) || e})`, code: (e && e.code) || null };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { unreadable: 'is not a regular file (a directory, FIFO, socket or device cannot hold it)', code: 'ENOTFILE' };
    if (st.size > maxBytes) return { unreadable: `is ${st.size} bytes, past the ${maxBytes}-byte bound`, code: 'EFBIG' };
    const buf = Buffer.allocUnsafe(st.size);
    let read = 0;
    while (read < st.size) {
      // An EAGAIN here (O_NONBLOCK on a platform where a regular-file read can
      // return it) THROWS and is reported as unreadable by the catch below —
      // deliberately never retried, because a loop is exactly the hang the
      // non-blocking open exists to prevent.
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n <= 0) break; // shrank under us — refused just below, never returned short
      read += n;
    }
    // A SHORT READ IS A REFUSAL, NOT A RESULT — symmetric with the growth probe
    // below. Returning the truncated prefix would be actively dangerous: the
    // CLI compares lock BYTES to detect a concurrent write, and two truncated
    // reads of a file being rewritten can compare EQUAL, so the change check
    // would pass on a lock that did change. A hash of a prefix is wrong in the
    // same way. Neither caller can tell a short buffer from a whole one.
    if (read < st.size) return { unreadable: `shrank from ${st.size} to ${read} bytes during the read`, code: 'EIO' };
    // A file that GREW past the bound between fstat and the last read would
    // otherwise be reported as its truncated prefix — a silently wrong hash.
    // One byte past the recorded size answers it definitively.
    const probe = Buffer.allocUnsafe(1);
    let extra = 0;
    try {
      extra = readSync(fd, probe, 0, 1, st.size);
    } catch {
      extra = 0; // an unreadable tail is not evidence of growth
    }
    if (extra > 0) return { unreadable: `grew past its ${st.size}-byte size during the read`, code: 'EFBIG' };
    return { bytes: buf }; // exactly st.size bytes — the short-read guard above proved it
  } catch (e) {
    return { unreadable: `could not be read (${(e && e.message) || e})`, code: (e && e.code) || null };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* a failed close cannot change what was already read */
    }
  }
}

/** Bytes of a proven ordinary, bounded plan file, or a reason. */
export function readPlanFileBounded(absPath) {
  return readBounded(absPath, PLAN_MAX_BYTES, 'plan');
}

/** Text of a fixed .sterling record, through the same one reader. */
function readStoreFileBounded(path, maxBytes) {
  const read = readBounded(path, maxBytes, 'record');
  if (read.unreadable) return read;
  return { text: read.bytes.toString('utf8') };
}

/** {sha256} or {unreadable: reason} — never an unbounded read. */
export function hashPlanFile(absPath) {
  const read = readPlanFileBounded(absPath);
  if (read.unreadable) return { unreadable: read.unreadable };
  return { sha256: createHash('sha256').update(read.bytes).digest('hex') };
}

export function sha256Of(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The plan's own first heading, matched on the LITERAL two characters '# '.
 * Deliberately not /^#\s+/: that also matches '#\t', and a tab-led heading is
 * not what markdown renders as an H1 here. Falls back to the file's basename.
 */
export function extractTitle(text, fallbackBasename) {
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('# ')) continue;
    const title = sanitizeForContext(line.slice(2), TITLE_MAX);
    if (title) return title;
  }
  return sanitizeForContext(fallbackBasename ?? '', TITLE_MAX);
}

/**
 * VALIDATES, never merely parses. A lock record drives what the conductor
 * believes governs the objective, so a record that is JSON but not a lock is
 * MALFORMED — it is never half-trusted for the fields that happen to be
 * present. Returns the reason, or null when the record is sound.
 */
function invalidReason(l) {
  if (l.schema_version !== 1) return `schema_version is ${JSON.stringify(l.schema_version)}, not 1`;
  if (!isAbsolutePlanPath(l.plan_path)) return 'plan_path is not an absolute path string';
  if (typeof l.approved_sha256 !== 'string' || !HEX64.test(l.approved_sha256)) return 'approved_sha256 is not a 64-character hex digest';
  if (l.file_sha256_at_approval !== null && (typeof l.file_sha256_at_approval !== 'string' || !HEX64.test(l.file_sha256_at_approval))) {
    return 'file_sha256_at_approval is neither null nor a 64-character hex digest';
  }
  if (typeof l.approved_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(l.approved_at) || !Number.isFinite(Date.parse(l.approved_at))) {
    return 'approved_at is not an ISO-8601 timestamp';
  }
  if (l.source !== 'exit_plan_mode' && l.source !== 'manual') return `source is ${JSON.stringify(l.source)}, not 'exit_plan_mode' or 'manual'`;
  // THE OPTIONAL FIELDS ARE TYPE-CHECKED TOO. Every one of them is either
  // RENDERED into agent-visible context (title, branch, session) or drives a
  // disclosure branch (text_file_mismatch, observed_*), so a field of the wrong
  // type is a record that cannot be trusted — not a field to quietly ignore.
  // The name is always in the reason, so a repair does not need a bisect.
  if (typeof l.title !== 'string') return 'title is not a string';
  for (const key of ['approved_session_id', 'approved_branch', 'approved_head']) {
    if (l[key] !== null && typeof l[key] !== 'string') return `${key} is neither null nor a string`;
  }
  if (l.text_file_mismatch !== undefined && typeof l.text_file_mismatch !== 'boolean') return 'text_file_mismatch is neither absent nor a boolean';
  if (l.observed_at !== undefined && typeof l.observed_at !== 'string') return 'observed_at is neither absent nor a string';
  if (l.observed_sha256 !== undefined && l.observed_sha256 !== null && typeof l.observed_sha256 !== 'string') return 'observed_sha256 is neither absent, null, nor a string';
  if (l.observed_status !== undefined && !['present', 'missing', 'unreadable'].includes(l.observed_status)) {
    return `observed_status is ${JSON.stringify(l.observed_status)}, not one of 'present' | 'missing' | 'unreadable'`;
  }
  return null;
}

/**
 * {lock, raw} | {malformed: reason, raw?} | {absent: true}.
 * THREE STATES, never two: a lock that exists but cannot be trusted is not the
 * same fact as no lock, and collapsing them makes a reader report "no plan"
 * for a lock sitting on disk. `raw` is the exact bytes read — the CLI's
 * compare-and-swap token.
 */
export function readLock(sterlingDir) {
  // ABSENT is decided by the OPEN's errno, not by a prior existsSync: that pair
  // is its own race, and ENOENT is the authoritative answer. A non-file,
  // oversize or unreadable lock is MALFORMED — present but unusable — carrying
  // the shape reason, never a blocking read.
  const read = readStoreFileBounded(join(sterlingDir, LOCK_FILE), LOCK_MAX_BYTES);
  if (read.unreadable) return read.code === 'ENOENT' ? { absent: true } : { malformed: read.unreadable };
  const raw = read.text;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { malformed: `is not valid JSON (${(e && e.message) || e})`, raw };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { malformed: 'is not a JSON object', raw };
  const reason = invalidReason(parsed);
  if (reason) return { malformed: reason, raw };
  return { lock: parsed, raw };
}

/**
 * {text} | {absent: true} | {unreadable: reason} — the CLI's change-detection
 * token. THE THREE STATES MUST STAY DISTINCT: collapsing "unreadable" into
 * "absent" (a bare null) makes an unreadable lock compare EQUAL to itself on
 * both reads, so a change check would pass vacuously on exactly the lock it
 * could not see. Stat-checked like every other read here.
 */
export function readLockBytes(sterlingDir) {
  const read = readStoreFileBounded(join(sterlingDir, LOCK_FILE), LOCK_MAX_BYTES);
  if (read.unreadable) return read.code === 'ENOENT' ? { absent: true } : { unreadable: read.unreadable };
  return { text: read.text };
}

/**
 * {status, sha256, reason?} where status is UNCHANGED | MODIFIED | MISSING |
 * UNREADABLE. The comparison is against file_sha256_at_approval and NEVER
 * approved_sha256 — a lock whose approved text legitimately differed from the
 * file at approval would otherwise read as permanently MODIFIED. Reads the RAW
 * recorded path: the stored path must resolve on disk.
 */
export function computeStatus(lock) {
  // NO existsSync: the errno of the ONE open is the answer, and asking twice is
  // a race that can report MISSING for a file that exists. ENOENT is genuinely
  // gone; EACCES / ENOTDIR / ELOOP / a non-regular shape are all PRESENT BUT
  // UNUSABLE, which is a different fact the reader must not see as "missing".
  const read = readBounded(lock?.plan_path, PLAN_MAX_BYTES, 'plan');
  if (read.unreadable) {
    return { status: read.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE', sha256: null, reason: read.unreadable };
  }
  const sha = sha256Of(read.bytes);
  return { status: sha === lock.file_sha256_at_approval ? 'UNCHANGED' : 'MODIFIED', sha256: sha };
}

/**
 * Same-directory temp + renameSync, so a reader never observes a half-written
 * file. The temp name is a randomUUID (never pid+timestamp, which another party
 * can predict and pre-plant) and 'wx' makes the open FAIL if anything already
 * exists at that path — including a symlink aimed elsewhere, which a plain
 * write would have followed and clobbered. mode 0o600 keeps the staged bytes
 * private for the moment they exist. The temp name deliberately does not begin
 * with the final name, so a crashed write is never mistaken for the artifact.
 */
export function writeAtomicExclusive(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${name}-${randomUUID()}`);
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  renameSync(tmp, join(dir, name));
}

export function writeLock(sterlingDir, lock) {
  writeAtomicExclusive(sterlingDir, LOCK_FILE, JSON.stringify(lock, null, 2) + '\n');
}

export function writeMarker(sterlingDir, name, body) {
  writeAtomicExclusive(join(sterlingDir, 'transient'), name, JSON.stringify(body, null, 2) + '\n');
}

/**
 * Consume a one-shot marker: CLAIM IT BY RENAME FIRST, then read and unlink the
 * claimed copy. Returns its bytes, or null when there was nothing to claim.
 *
 * Why the rename leads: a read-then-remove sequence loses an update — a marker
 * REWRITTEN between the read and the rm is deleted without ever having been
 * disclosed, which for a one-shot disclosure means the fact is gone forever.
 * renameSync is atomic, so exactly one claimant wins and a marker written after
 * the claim survives for the next consumer. Deletion-before-parse is preserved
 * and strengthened: the marker leaves its published name BEFORE anything parses
 * it, so a malformed marker can never re-inject.
 */
// string (its text) | {unreadable: reason} | null (nothing to claim).
export function claimMarker(path) {
  const claimed = `${path}.claimed-${randomUUID()}`;
  try {
    renameSync(path, claimed);
  } catch {
    return null; // vanished, or another claimant won — either way it is not ours
  }
  // renameSync never OPENS the file, so a FIFO planted at a marker path is
  // safely claimed and only then classified — stat-first, exactly like the
  // lock. A non-file or oversize marker is still CONSUMED (unlinked below) and
  // reported as unreadable: spent regardless, so it can never re-inject.
  const read = readStoreFileBounded(claimed, MARKER_MAX_BYTES);
  try {
    unlinkSync(claimed);
  } catch {
    /* a leftover claimed copy is bounded litter, never a re-injection */
  }
  return read.unreadable ? { unreadable: read.unreadable } : read.text;
}
