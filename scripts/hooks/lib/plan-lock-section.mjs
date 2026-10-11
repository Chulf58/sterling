// The PLAN LOCK section: the approved plan's line, its authority boundary, the
// plan-file status and the three one-shot marker disclosures. Extracted from
// h1-session-start.mjs so the OpenCode context hook
// (packages/opencode-plugin/src/context.mjs) renders the SAME text from the SAME
// code (board 6766ec3e, GitHub #76 part 1); H1's output is unchanged. Builtins and
// sibling libs only: hooks bundle this module.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  PATH_MAX as PLAN_LOCK_PATH_MAX,
  REASON_MAX as PLAN_LOCK_REASON_MAX,
  TITLE_MAX as PLAN_LOCK_TITLE_MAX,
  claimMarker as claimPlanLockMarker,
  computeStatus as computePlanStatus,
  readLock as readPlanLock,
  sanitizeForContext as planLockClean,
} from './plan-lock.mjs';

// PLAN LOCK (decision `plan-lock-approved-plan-bound-at-exit-plan-mode-delivered-at-every-reentry`).
// ONE SELF-CONTAINED FUNCTION, deliberately: H1 is scheduled for a from-blank
// registry rebuild, which lifts this unchanged. It takes only {cwd, source} and
// touches nothing else in this file.
//
// WHY IT IS FIRST, AND WHY IT IS NOT A GATE: measured 2026-09-06 — after a
// /clear the conductor re-entered through the rotation note and the board, never
// re-read the approved plan, and dispatched three lanes that patched mechanisms
// the plan had homed in from-blank rebuild slices. The plan is the only surface
// carrying ORDER and the user's written rulings. This puts it back in front of
// the conductor at every re-entry; whether the plan is FOLLOWED stays the
// conductor's judgement, and nothing here denies anything.
//
// The lock is parsed ONCE, here, and the parsed snapshot is handed to the
// ROTATION RESTORE block below, which never re-reads it.
//
// Every primitive it uses — the sanitiser, the validated lock read, the bounded
// status computation, the marker claim — is imported from lib/plan-lock.mjs and
// shared with H31, H19 and the CLI. The ROTATION RESTORE block renders a plan
// path too (the note's own captured value) and passes it through the SAME
// imported sanitiser: two sanitisers on one payload is how one ends up weaker.
export function planLockSection(ctx) {
  const TITLE_MAX = PLAN_LOCK_TITLE_MAX;
  const PATH_MAX = PLAN_LOCK_PATH_MAX;
  const REASON_MAX = PLAN_LOCK_REASON_MAX;
  const STALE_DAYS = 14;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Everything below reaches additionalContext and originates in an approved
  // plan's own text, so it is control-stripped and bounded at the read too —
  // H31 bounds at the write, this bounds a lock written by anything else.
  const clean = planLockClean;

  const sterlingDir = join(ctx.cwd, '.sterling');
  const transientDir = join(sterlingDir, 'transient');
  const blocks = [];

  // ONE-SHOT MARKERS, on EVERY source. claimPlanLockMarker RENAMES the file out
  // of its published name before reading it, so deletion-before-parse holds AND
  // a marker rewritten mid-consume is not silently swallowed.
  const MARKERS = [
    {
      file: 'plan-lock-unresolved.json',
      render: (body) =>
        `PLAN LOCK NOT BOUND (one-shot): an ExitPlanMode approval could not be bound to a plan file — ${clean(body?.reason, REASON_MAX) || 'no reason recorded'}. ` +
        `Any earlier lock was preserved unchanged. Re-bind by hand with plan-lock.mjs --plan <absolute path> if this objective still has an approved plan.`,
    },
    {
      file: 'plan-lock-released.json',
      render: (body) =>
        `PLAN LOCK RELEASED (one-shot): the plan lock was released — ${clean(body?.reason, REASON_MAX) || 'no reason recorded'}. ` +
        `No plan governs this objective's scope and ordering until a new plan is approved.`,
    },
    {
      file: 'plan-lock-previous.json',
      render: (body) =>
        `PLAN LOCK SUPERSEDED (one-shot): the previous plan was "${clean(body?.title, TITLE_MAX) || 'untitled'}" (${clean(body?.plan_path, PATH_MAX) || 'no path recorded'}). ` +
        `The lock above replaced it — work planned under the old plan is no longer governed by it.`,
    },
  ];
  const markerLines = [];
  for (const marker of MARKERS) {
    let raw = null;
    try {
      raw = claimPlanLockMarker(join(transientDir, marker.file));
    } catch {
      raw = null; // fail-open: a failed claim costs one disclosure, never this hook
    }
    if (raw === null) continue;
    // Three claim outcomes: null (nothing there), a string (its text), or an
    // {unreadable} sentinel for a marker that was consumed but could not be
    // read (a FIFO or oversize file planted at its path). The last two both
    // render the body-less disclosure — the marker is spent either way, and
    // saying nothing about a consumed marker is the one thing that must not
    // happen.
    let body = null;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    markerLines.push(marker.render(body && typeof body === 'object' ? body : null));
  }

  // THE LOCK ITSELF, read through the shared VALIDATING reader: a record that
  // is JSON but not a lock is MALFORMED, never half-trusted. MALFORMED is
  // reserved for the lock RECORD (never for the plan file, whose four states
  // are below) and suppresses no other section.
  let read = { absent: true };
  try {
    read = readPlanLock(sterlingDir);
  } catch (e) {
    read = { malformed: `could not be read (${(e && e.message) || e})` };
  }
  const lock = read.lock ?? null;
  const malformed = Boolean(read.malformed);

  if (malformed) {
    blocks.push(
      `PLAN LOCK MALFORMED: .sterling/plan-lock.json exists but ${clean(read.malformed, REASON_MAX)}, so it is not a usable lock record. ` +
        `Inspect it with \`plan-lock.mjs --show\`, or clear it with \`plan-lock.mjs --release --reason "<why>"\`. ` +
        `Nothing else in this session start is affected.`
    );
  } else if (lock) {
    // RENDERED copy: sanitised and bounded. The lock's own plan_path stays raw,
    // and it is the raw one computeStatus reads from disk.
    const planPath = clean(lock.plan_path, PATH_MAX);
    // FOUR STATES for the plan FILE, compared against file_sha256_at_approval —
    // NEVER approved_sha256, or a lock whose approved text legitimately differed
    // from the file at approval would read as permanently MODIFIED. A non-regular
    // file, an oversize one, or one this process cannot read is UNREADABLE.
    // WHY A PLANTED FIFO CANNOT STALL SESSIONSTART (the mechanism is the OPEN,
    // not a stat): computePlanStatus opens the recorded path ONCE with
    // O_RDONLY|O_NOFOLLOW|O_NONBLOCK, so a direct FIFO returns immediately
    // instead of blocking inside the open, and fstat on that descriptor then
    // rejects it as non-regular. On Windows neither flag exists — accepted,
    // because a Win32 named pipe is a \\.\pipe\ object openSync does not reach
    // through these paths; the fstat classification still applies there.
    let status = 'MISSING';
    try {
      const live = computePlanStatus(lock);
      status = live.status === 'MODIFIED' ? 'MODIFIED since approval' : live.status;
    } catch {
      status = 'UNREADABLE';
    }
    let branchNow = 'unknown';
    try {
      const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd, encoding: 'utf8', timeout: 5_000 });
      const current = r.status === 0 ? (r.stdout ?? '').trim() : '';
      const approved = clean(lock.approved_branch, 120);
      if (current && approved) branchNow = current === approved ? 'same' : `DIFFERENT (now ${current}, approved on ${approved})`;
    } catch {
      branchNow = 'unknown';
    }
    const source = lock.source === 'manual' ? 'manual' : 'exit_plan_mode';
    blocks.push(
      `PLAN LOCK: ${clean(lock.title, TITLE_MAX) || '(untitled plan)'} — ${planPath || '(no path recorded)'} ` +
        `(approved ${clean(lock.approved_at, 40).slice(0, 10) || 'unknown date'} on ${clean(lock.approved_branch, 120) || 'no branch recorded'}, ${source}) ` +
        `· plan file ${status} · branch now ${branchNow}`
    );
    // THE AUTHORITY BOUNDARY, with its own justification attached: a ruling
    // delivered without its reason gets re-litigated at the delivery surface.
    blocks.push(
      `THE APPROVED PLAN GOVERNS THIS OBJECTIVE'S SCOPE, ORDERING AND SLICES; STANDING STORE DECISIONS STILL GOVERN MECHANISMS ` +
        `UNLESS THE PLAN RECORDS A LATER USER RULING; THE BOARD IS INVENTORY; READ THE PLAN BEFORE THE FIRST DISPATCH. ` +
        `(The plan is the only surface carrying ORDER and the user's written rulings — the board holds inventory, the store holds design.)`
    );
    if (source === 'manual') {
      blocks.push(`This lock was written by hand (plan-lock.mjs --plan) — approval provenance is the operator's word, not an ExitPlanMode approval.`);
    }
    if (lock.text_file_mismatch === true) {
      blocks.push(
        `At approval the approved text and the file on disk already differed (text_file_mismatch) — the live status above is judged against the FILE's bytes at that moment, which is the only honest baseline.`
      );
    }
    if (status === 'MODIFIED since approval') {
      blocks.push(
        `The plan file has changed since it was approved. Approval provenance is never re-stamped: record the change with plan-lock.mjs --observe, or have the user approve a new plan.`
      );
    }
    const ageMs = Date.now() - Date.parse(clean(lock.approved_at, 40));
    if (Number.isFinite(ageMs) && ageMs > STALE_DAYS * DAY_MS) {
      blocks.push(
        `STALE: approved ~${Math.round(ageMs / DAY_MS)} days ago. Staleness is a DISCLOSURE, never a clear — only a later approval or plan-lock.mjs --release clears a lock.`
      );
    }
  }

  blocks.push(...markerLines);
  // `malformed` rides the snapshot: a lock that EXISTS but cannot be parsed is
  // not the same fact as no lock at all, and a consumer told only `lock: null`
  // would report "no plan lock is live" for a lock sitting right there.
  return { context: blocks.length ? blocks.join('\n') + '\n\n' : '', lock: malformed ? null : lock, malformed };
}
