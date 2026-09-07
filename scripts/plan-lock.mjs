// plan-lock.mjs — the MANUAL writer for .sterling/plan-lock.json, beside H31
// (which is the only thing that can stamp APPROVAL provenance).
// Spec: decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`.
// Every primitive is imported from the shared hooks/lib/plan-lock.mjs module —
// this CLI and the hook must never disagree about what a lock is.
//
//   node scripts/plan-lock.mjs --plan <path> [--force]
//   node scripts/plan-lock.mjs --observe
//   node scripts/plan-lock.mjs --release --reason "<why>"
//   node scripts/plan-lock.mjs --show
//
// FOUR VERBS, ONE REFUSAL CODE (exit 2). A refusal never writes.
//   --plan     binds a plan by hand: source 'manual', approved_sha256 = the
//              FILE's hash, provenance NULL. Replacing a lock that an
//              ExitPlanMode approval wrote requires --force regardless of age —
//              age never weakens approval provenance.
//   --observe  records observed_* ONLY. There is deliberately no --restamp:
//              re-stamping approval by hand would launder an unapproved edit
//              into approval, so a modified plan is RECORDED, never re-approved.
//   --release  deletes the lock (the only manual clear) and leaves a one-shot
//              plan-lock-released.json carrying the reason, which H1 discloses
//              once and consumes.
//   --show     prints the lock plus the live status of its plan file.
//
// COMPARE-AND-SWAP ON EVERY MUTATION. Each mutating verb reads the lock bytes
// at start and RE-READS them immediately before it writes or deletes; if they
// differ, it refuses. Between those two moments a plan can be approved (H31
// fires on the user's own ExitPlanMode, concurrently with this process), and
// silently overwriting that approval is exactly the loss this guards — most
// sharply for `--plan --force`, whose whole purpose is to overwrite, and which
// must still never overwrite a lock that appeared after the operator looked.
//
// LIVE STATUS IS COMPUTED AGAINST file_sha256_at_approval, NEVER
// approved_sha256: the two differ legitimately whenever the approved text and
// the on-disk bytes diverged at approval, and comparing against the approved
// text would then read as permanently MODIFIED.
//
// WHAT THIS DOES NOT GUARANTEE: that a manual lock reflects anything a user
// approved (source 'manual' is disclosed by H1 as the operator's word); that
// the plan file still says what it said at approval (that is exactly what
// MODIFIED discloses).
import { existsSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  LOCK_FILE,
  PATH_MAX,
  REASON_MAX,
  TITLE_MAX,
  computeStatus,
  extractTitle,
  isSterlingProject,
  readLock,
  readLockBytes,
  readPlanFileBounded,
  sanitizeForContext,
  sha256Of,
  sterlingDirOf,
  writeLock,
  writeMarker,
} from './hooks/lib/plan-lock.mjs';

const argv = process.argv.slice(2);

// Same shape as scripts/rotation-note.mjs / scripts/lib/project.mjs: a flag's
// value is the next argv entry, absent is null. No new parser.
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null;
}

function has(name) {
  return argv.includes(`--${name}`);
}

function refuse(message) {
  process.stderr.write(`plan-lock: ${message}\n`);
  process.exit(2);
}

const cwd = process.cwd();
// A bare .sterling directory is not a project — the sterling.db predicate
// scripts/lib/project.mjs uses for every other sanctioned script.
if (!isSterlingProject(cwd)) {
  refuse(`${cwd} is not an initialized Sterling project (no .sterling/sterling.db) — run from the project root`);
}
const sterlingDir = sterlingDirOf(cwd);
const lockPath = join(sterlingDir, LOCK_FILE);

/**
 * Current lock bytes as a comparable token — null when ABSENT — refusing when
 * the file exists but cannot be read. UNREADABLE must never collapse into
 * ABSENT: two unreadable reads would compare equal and the change check would
 * pass vacuously on precisely the lock this command could not see.
 */
function lockTokenOrRefuse(what) {
  const read = readLockBytes(sterlingDir);
  if (read.unreadable) {
    refuse(`the plan lock at ${lockPath} ${read.unreadable} — lock unreadable, refusing ${what} rather than acting on a lock this command cannot see. Nothing was changed`);
  }
  return read.absent ? null : read.text;
}

/**
 * The compare half. `before` is the token the verb read when it started;
 * refuse if the lock has changed since.
 *
 * RESIDUAL, ACCEPTED AND NOT A TRUE COMPARE-AND-SWAP: two syscalls separate
 * this re-read from the rename/unlink that follows it, so a writer landing
 * inside that window still wins. It narrows the race from the whole command to
 * a few microseconds; it does not close it. A real CAS needs the filesystem to
 * offer one, which it does not here.
 */
function requireUnchanged(before) {
  if (lockTokenOrRefuse('the write') !== before) {
    refuse('the plan lock changed underneath this command (another approval or writer landed while it ran) — nothing was written; re-run and re-check the new lock first');
  }
}

const verbs = ['plan', 'observe', 'release', 'show'].filter(has);
if (verbs.length !== 1) {
  refuse(
    verbs.length
      ? `exactly one verb at a time — got: ${verbs.map((v) => `--${v}`).join(', ')}`
      : 'no verb given — one of --plan <path> | --observe | --release --reason "<why>" | --show'
  );
}
const verb = verbs[0];

if (verb === 'show') {
  const read = readLock(sterlingDir);
  if (read.malformed) {
    refuse(`${lockPath} ${read.malformed} — it is not a usable lock record; repair or --release it. Nothing was changed`);
  }
  if (read.absent) {
    process.stdout.write(JSON.stringify({ lock: null, note: 'no plan lock in this project' }, null, 2) + '\n');
    process.exit(0);
  }
  const live = computeStatus(read.lock);
  // plan_path is RENDERED here, so the displayed copy is sanitised and bounded;
  // the verbatim value that must resolve on disk rides alongside, unmodified.
  process.stdout.write(
    JSON.stringify(
      {
        ...read.lock,
        plan_path: sanitizeForContext(read.lock.plan_path, PATH_MAX),
        plan_path_verbatim: read.lock.plan_path,
        title: sanitizeForContext(read.lock.title, TITLE_MAX),
        status: live.status,
        status_sha256: live.sha256 ?? null,
        status_reason: live.reason ?? null,
      },
      null,
      2
    ) + '\n'
  );
  process.exit(0);
}

if (verb === 'release') {
  const reason = sanitizeForContext(arg('reason') ?? '', REASON_MAX);
  if (!reason) {
    refuse('--release requires --reason "<why>" — releasing the plan lock without a recorded reason leaves no trace of who dropped the authority');
  }
  const before = lockTokenOrRefuse('the release');
  if (before === null) refuse('there is no plan lock to release');
  const read = readLock(sterlingDir);
  requireUnchanged(before);
  // STATE CHANGE FIRST, DISCLOSURE SECOND — the same ordering rule the decision
  // states for supersession: a crash may lose the disclosure, but a released
  // marker must never claim a release that did not happen.
  // `force` swallows ENOENT only. A DIRECTORY at the lock path (or a permission
  // failure) still throws, and that is a refusal the operator must see — never
  // an uncaught stack, and never a released marker for a lock still on disk.
  try {
    rmSync(lockPath, { force: true });
  } catch (e) {
    refuse(`the plan lock at ${lockPath} could not be removed (${(e && e.message) || e}) — nothing was changed and no release was recorded`);
  }
  // THE REMOVAL ALREADY HAPPENED. A failure here cannot be reported as "nothing
  // was changed" — the refusal must state exactly what landed and what did not,
  // or the operator repairs the wrong half.
  try {
    writeMarker(sterlingDir, 'plan-lock-released.json', {
      reason,
      released_title: sanitizeForContext(read.lock?.title, TITLE_MAX) || null,
      released_plan_path: sanitizeForContext(read.lock?.plan_path, PATH_MAX) || null,
      at: new Date().toISOString(),
    });
  } catch (e) {
    refuse(
      `the lock WAS removed; the release disclosure could NOT be written: ${(e && e.message) || e}. ` +
        'The next SessionStart will therefore show no PLAN LOCK section and no release notice — say so out loud rather than assuming the release was recorded'
    );
  }
  process.stdout.write(JSON.stringify({ released: true, reason }, null, 2) + '\n');
  process.exit(0);
}

if (verb === 'observe') {
  const before = lockTokenOrRefuse('the observation');
  const read = readLock(sterlingDir);
  if (read.malformed) refuse(`${lockPath} ${read.malformed} — it is not a usable lock record; repair or --release it. Nothing was changed`);
  if (read.absent) refuse('there is no plan lock to observe');
  const live = computeStatus(read.lock);
  // APPROVAL FIELDS ARE NOT TOUCHED. The spread preserves them byte-for-byte;
  // only the observed_* triple is written.
  const next = {
    ...read.lock,
    observed_at: new Date().toISOString(),
    observed_sha256: live.sha256 ?? null,
    observed_status: live.status === 'UNCHANGED' || live.status === 'MODIFIED' ? 'present' : live.status.toLowerCase(),
  };
  requireUnchanged(before);
  try {
    writeLock(sterlingDir, next);
  } catch (e) {
    refuse(`the observation could NOT be written: ${(e && e.message) || e}. The lock is UNCHANGED — its approval fields were never at risk, and observed_* was simply not recorded`);
  }
  process.stdout.write(JSON.stringify({ observed_status: next.observed_status, observed_sha256: next.observed_sha256, status: live.status }, null, 2) + '\n');
  process.exit(0);
}

// verb === 'plan'
const planArg = arg('plan');
if (!planArg) refuse('--plan requires a path to the plan file');
const planPath = resolve(cwd, planArg);
if (!existsSync(planPath)) refuse(`no plan file at ${planPath}`);
const planRead = readPlanFileBounded(planPath);
if (planRead.unreadable) refuse(`the plan file at ${planPath} ${planRead.unreadable} — nothing was changed`);
const planBytes = planRead.bytes;

const before = lockTokenOrRefuse('the replacement');
const existing = readLock(sterlingDir);
const force = has('force');
if (!force && existing.malformed) {
  refuse(`${lockPath} ${existing.malformed}, so it cannot be shown to be replaceable — pass --force to replace it anyway`);
}
if (!force && existing.lock && existing.lock.source === 'exit_plan_mode') {
  refuse(
    `the current lock came from an ExitPlanMode APPROVAL (${sanitizeForContext(existing.lock.title, TITLE_MAX) || 'untitled'}) — replacing it by hand requires --force. ` +
      'Age never weakens approval provenance, so there is no window in which this is waived.'
  );
}

const fileSha = sha256Of(planBytes);
const lock = {
  schema_version: 1,
  // RAW AND VERBATIM, like H31's: the recorded path must open on disk.
  plan_path: planPath,
  title: extractTitle(planBytes.toString('utf8'), basename(planPath)),
  approved_at: new Date().toISOString(),
  // A manual lock has no approved TEXT distinct from the file, so both hashes
  // are the file's — and text_file_mismatch is false by construction.
  approved_sha256: fileSha,
  file_sha256_at_approval: fileSha,
  text_file_mismatch: false,
  // NULLABLE BY DESIGN AND BY RULING: a hand-written lock carries no approval
  // provenance, and inventing session/branch/head here would dress the
  // operator's word up as an approval record.
  approved_session_id: null,
  approved_branch: null,
  approved_head: null,
  source: 'manual',
};
// The swap half: --force exists to overwrite what the operator SAW, never a
// lock that appeared after they looked.
requireUnchanged(before);
try {
  writeLock(sterlingDir, lock);
} catch (e) {
  refuse(`the new lock could NOT be written: ${(e && e.message) || e}. Nothing was changed — the write is atomic, so any prior lock is intact and still governs`);
}
// SUPERSESSION DISCLOSURE, lock first — the same order H31 uses, for the same
// reason. Fires for ANY replaced lock (forced approval, manual-over-manual, or
// an unusable record), because "what was I working under before this?" is the
// question the marker answers and it does not depend on how the old lock got there.
const replaced = Boolean(existing.lock || existing.malformed);
if (replaced) {
  try {
    writeMarker(sterlingDir, 'plan-lock-previous.json', {
      title: sanitizeForContext(existing.lock?.title, TITLE_MAX) || (existing.malformed ? '(unusable lock record)' : '(untitled)'),
      plan_path: sanitizeForContext(existing.lock?.plan_path, PATH_MAX) || null,
      approved_at: sanitizeForContext(existing.lock?.approved_at, 64) || null,
      superseded_at: new Date().toISOString(),
    });
  } catch (e) {
    refuse(
      `the new lock WAS written and now governs; the supersession disclosure could NOT be written: ${(e && e.message) || e}. ` +
        'The next SessionStart will show the new plan with no notice that it replaced an earlier one'
    );
  }
}
process.stdout.write(JSON.stringify({ ...lock, replaced }, null, 2) + '\n');
process.exit(0);
