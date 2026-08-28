// EXTRACTED COOPERATING LOCK for the dispatch-register's writers — decision
// register-writers-cooperating-lock (1e0ba0d0), closing board 673ca3f6 (a
// lost unlocked read-modify-write silently destroyed review evidence).
//
// EVERY register writer takes this same lock: H22's SubagentStart append,
// SubagentStop remove/promote and prune pass; H10's residue_reported_at
// stamp; H1's SessionStart register deletion. mkdir is the atomic primitive
// (two processes racing to create the same directory: exactly one wins,
// the other gets EEXIST) — same convention as h22-dispatch-register.mjs's
// own withLedgerLock, extracted here so every writer shares ONE
// implementation instead of a second divergent copy.
//
// registerLockDir() is exported so ALL FOUR writers derive the lock path
// from ONE spelling (review-fix round, HIGH): the literal path was
// previously respelled independently per hook, and a typo in any one of
// them would silently unlock that writer with no test able to catch it
// short of a full concurrency replay.
//
// OWNER NONCE (decision point 2): a lock dir alone cannot tell a late
// release from a stale-steal victim apart from the current legitimate
// holder. A random nonce is written INSIDE the lock dir at acquire time;
// release() only removes the lock if it still holds that same nonce, so a
// stale-steal victim's late release() is a no-op against the successor's
// lock rather than an accidental rmdir of it.
//
// LOCK-HARDENING (review-fix round, HIGH — the original mkdir+rmSync steal
// lost mutual exclusion under an interleaving where two racers each thought
// they alone had recovered the same stale lock). THE OWNER FILE'S
// CREATE-EXCLUSIVE WRITE IS THE SOLE EXCLUSIVITY PRIMITIVE — mkdirSync(lockDir,
// {recursive:true}) is now IDEMPOTENT scaffolding only (ensures the directory
// and its parents exist; it is never itself treated as a contention signal,
// and legitimately does not throw EEXIST for an already-existing directory).
// Three changes, each closing one interleaving:
//   (a) OWNER WRITE IS CREATE-EXCLUSIVE ('wx'): the ONLY way to become the
//       holder is to be the one caller whose `writeFileSync(ownerPath, nonce,
//       {flag:'wx'})` succeeds against an EMPTY (no owner file) lock
//       directory. If the owner file already exists the moment we go to
//       write it, someone else already holds this directory — we must NEVER
//       overwrite their claim, so the acquisition is treated as LOST and the
//       loop backs off and re-evaluates (staleness/retry) from the top. This
//       is deliberately NOT "mkdirSync as the gate, owner-write as defense in
//       depth": a lock directory can legitimately pre-exist EMPTY (e.g. after
//       a steal recreates it, or on first-ever use where the parent
//       .sterling/transient/ already exists) with no owner inside it, and
//       that must be immediately, uncontendedly claimable — a mkdirSync-based
//       gate would wrongly treat a pre-existing empty directory as full
//       contention and stale-gate it for no reason.
//   (b) STEAL IS SINGLE-WINNER: stealing a stale lock renames the WHOLE
//       stale directory (owner file and all) to a unique tomb path
//       (renameSync is atomic — exactly one racer's rename can succeed
//       against a given source path; every other racer's rename throws
//       ENOENT and it simply re-enters the retry loop, recreating the
//       directory fresh on its next pass) and only THEN removes the tomb.
//       This replaces a bare rmSync(lockDir) steal, which had no way to tell
//       "I renamed away the stale dir" from "a sibling already replaced it
//       with their own fresh lock" — the old code could rmSync a BRAND NEW,
//       live lock a concurrent stealer had just (re)created in the same
//       instant.
//   (c) RELEASE MIRRORS THE STEAL: release() re-reads the nonce (unchanged),
//       and once ownership is confirmed it renames the lock dir to a tomb
//       and removes the tomb, rather than rmSync-ing it directly. An
//       already-stolen directory (nonce mismatch) never reaches the rename
//       at all; if a rename is attempted anyway and the path is already gone
//       it throws and is treated as a no-op.
//       DISCLOSED RESIDUAL MICROWINDOW: between release()'s nonce read and
//       its renameSync call there is a small window in which the SAME lock
//       could go stale and be stolen by a NEW holder (mint a new nonce, a
//       fresh owner-file write at the identical path) before our rename runs
//       — our rename would then legitimately succeed against the *new*
//       holder's directory (rename only cares about the path, not who owns
//       it), tombing a lock we no longer actually own. This requires our OWN
//       release to be delayed past the full staleMs window (>10s by
//       default) while a concurrent acquirer is actively retrying — a
//       specific, narrow, timing-dependent case, and strictly NARROWER than
//       the pre-hardening code (which had no ownership check on this path at
//       all). Not eliminated because eliminating it needs a second
//       compare-and-swap primitive (e.g. a version-numbered rename) the
//       plain filesystem mutex this module deliberately stays does not have.
//
// STALENESS is measured off the OWNER FILE's mtime, not the directory's —
// the directory's own mtime is meaningless once mkdirSync is idempotent
// scaffolding rather than a fresh-creation signal.
//
// TIMEOUT POSTURE IS THE CALLER'S TO ENFORCE, not this module's: acquireLock
// resolves null on a bounded contention timeout (never throws for that
// case) and every caller in this decision's scope treats null as
// SKIP-THE-MUTATION-LOUD, never an unlocked write.
import { mkdirSync, rmSync, renameSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_RETRY_MS = 1000; // ~1s bounded retry, per the decision
const DEFAULT_STALE_MS = 10_000; // 10s stale steal, per the decision
const POLL_MS = 20;
const OWNER_FILE = 'owner';

/**
 * registerLockDir(projectRoot) -> the ONE path every register writer (H22,
 * H10, H1) must lock against. Exported so no writer respells the literal
 * '.sterling/transient/dispatch-register.lock' independently.
 */
export function registerLockDir(projectRoot) {
  return join(projectRoot, '.sterling', 'transient', 'dispatch-register.lock');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOwnerNonce(lockDir) {
  try {
    return readFileSync(join(lockDir, OWNER_FILE), 'utf8');
  } catch {
    return null; // vanished, unreadable, or never written — treated as "not ours"
  }
}

// Rename lockDir to a fresh, per-caller-unique tomb path and remove it —
// the shared primitive behind both the steal (b) and the release (c) paths.
// renameSync is the single-winner gate: exactly one concurrent caller's
// rename can succeed against a given source path, every other throws and
// must NOT touch the filesystem further (its target never existed, so there
// is nothing for it to have half-created).
function tombAndRemove(lockDir) {
  const tomb = `${lockDir}.tomb-${process.pid}-${randomUUID()}`;
  renameSync(lockDir, tomb); // throws (ENOENT) if we lost the race — caller handles it
  try {
    rmSync(tomb, { recursive: true, force: true });
  } catch {
    // best-effort — an orphaned tomb directory costs disk, never correctness
    // (nothing ever looks up a lock by its tomb name)
  }
}

function makeLock(lockDir, nonce) {
  return {
    nonce,
    release() {
      // Verify ownership before removing — a stale-steal victim's late
      // release() must never touch the successor's lock (D1b). See the
      // DISCLOSED RESIDUAL MICROWINDOW note above the module header for the
      // one narrow interleaving this check does not fully close.
      try {
        if (readOwnerNonce(lockDir) !== nonce) return; // no longer ours — no-op
        tombAndRemove(lockDir);
      } catch {
        // ENOENT (already stolen/removed between our nonce check and the
        // rename) or any other removal race — a clean no-op either way.
      }
    },
  };
}

/**
 * acquireLock(lockDir, {retryMs, staleMs}) -> Promise<{nonce, release()} | null>
 *
 * Blocks (via a bounded async retry loop, never a synchronous busy-wait)
 * until the lock is acquired, the held lock goes stale and is stolen, or
 * the retry budget is exhausted. Resolves null on a normal contention
 * timeout — never throws for that case, matching the hook posture that
 * consumes this: a lock timeout is disclosed and the mutation skipped,
 * never denies a spawn or a session start (warn-only, P1/P5).
 */
export async function acquireLock(lockDir, opts = {}) {
  const retryMs = Number.isFinite(opts.retryMs) ? opts.retryMs : DEFAULT_RETRY_MS;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
  const nonce = randomUUID();
  const deadline = Date.now() + retryMs;
  const ownerPath = join(lockDir, OWNER_FILE);

  for (;;) {
    // Idempotent scaffolding ONLY — never the exclusivity gate (see header).
    // recursive:true does not throw for an already-existing directory, so
    // any throw here is a genuine filesystem error and propagates.
    mkdirSync(lockDir, { recursive: true });

    // THE exclusivity primitive (hardening (a)): create-exclusive write. The
    // ONLY caller who can ever succeed here is the one racing against a
    // lock directory with no owner file in it yet.
    try {
      writeFileSync(ownerPath, nonce, { flag: 'wx' });
      return makeLock(lockDir, nonce);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // the directory vanished between our mkdirSync and this write — a concurrent RELEASE (not necessarily a steal) can legitimately do this at any moment, nothing to do with staleness; loop back and recreate it fresh, no wait needed
      if (e.code !== 'EEXIST') throw e;
      // someone else already holds this directory — fall through to the
      // staleness/retry logic below rather than overwriting their claim.
    }

    // Held by someone else — decide whether it is stale enough to steal,
    // measured off the OWNER FILE's mtime (the directory's own mtime is not
    // a creation signal now that mkdirSync above is idempotent scaffolding).
    let ageMs = null;
    try {
      ageMs = Date.now() - statSync(ownerPath).mtimeMs;
    } catch {
      continue; // the owner file vanished under us (released/stolen concurrently) — retry immediately, no wait
    }

    if (ageMs >= staleMs) {
      // SINGLE-WINNER STEAL (hardening (b)): rename the stale directory away
      // atomically. Exactly one racer's rename can succeed; every other
      // racer's throws and falls through to retry — it never touches
      // whatever now occupies lockDir, which may already be a fresh,
      // legitimately-held lock a sibling stealer just recreated.
      try {
        tombAndRemove(lockDir);
      } catch {
        // lost the steal race to a concurrent stealer (or it is already
        // gone) — fall through and retry from the top
      }
      continue; // immediately retry, no wait — steals are not bound by the poll interval
    }

    if (Date.now() >= deadline) return null; // bounded contention timeout — the caller skips the mutation, never writes unlocked
    await sleep(POLL_MS);
  }
}
