// Rotation restore: the reader, consumer and renderer of the rotation note
// (.sterling/transient/rotation-note.json, written by scripts/rotation-note.mjs).
// One implementation for both hosts: H1 (scripts/hooks/h1-session-start.mjs)
// restores it on Claude Code's /clear or startup, and the Sterling OpenCode
// server plugin restores it into the first new root session. `host` picks only
// the host's own words (the boundary named in the header and closing paragraph,
// the lane line); host 'claude' renders exactly what H1 printed before this
// module existed (scripts/tests/rotation-restore.test.mjs pins the bytes).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATH_MAX as PLAN_LOCK_PATH_MAX, sanitizeForContext as planLockClean } from './plan-lock.mjs';
import { disclosure, render } from '../../lib/review-errors.mjs';

// ROTATION RESTORE (context-rotation slice 3; startup consumption added
// 2026-09-22, Dome Farmer's issue log 2026-09-08 "code-reload rotation note
// only consumed on /clear, not startup"): a rotation note written by
// scripts/rotation-note.mjs before a /clear OR before an EXIT AND RELAUNCH is
// injected into the FRESH session and CONSUMED by that injection —
// source=startup OR source=clear (resume/compact have their own truths and
// must not eat a note prepared for a rotation that hasn't happened: a resume
// continues the SAME logical session, and a compact is not a re-entry at
// all). rotation-note.mjs's own printed guidance tells the user to EXIT AND
// RELAUNCH when hook/MCP code changed; a relaunch fires SessionStart with
// source=startup, so consuming only on clear meant that path silently failed
// to deliver the note until the user ALSO ran /clear. Single-shot by
// deletion-before-build (P4): even a later failure in this block cannot leave
// a note that re-injects forever. Disclosures over refusals: a moved HEAD, an
// old note, or a note left by a session that never relaunched still injects,
// loudly qualified (the `at`-based age caution below covers a stale note the
// same way regardless of source — deliberately no separate startup-only age
// bound: the store/board stay the authorities and a note too old to trust is
// still disclosed, never silently dropped) — the store/board stay the
// authorities; the note is only the non-reconstructable residue. Fail-open
// like every H1 read.
// Per-field render bounds for the note: prose fields carry the substance the
// note exists for, path/sha-shaped ones can never legitimately be longer than a
// path. Every one of them is rendered through planLockClean (the shared
// sanitizer) below — see the note comment in the block.
const NOTE_PROSE_MAX = 2000;
// Enumeration bounds for the note's live_dispatches block. Per-element
// sanitisation bounds each string; these bound the ARRAY, which is the other
// half of "a note cannot dominate the injection".
const LIVE_DISPATCH_MAX = 20;
const LIVE_TERRITORY_MAX = 40;
const LIVE_TERRITORY_LINE_MAX = PLAN_LOCK_PATH_MAX * 4;
const NOTE_FIELD_MAX = {
  objective: NOTE_PROSE_MAX,
  next_slice: NOTE_PROSE_MAX,
  risks: NOTE_PROSE_MAX,
  pointers: NOTE_PROSE_MAX,
  branch: PLAN_LOCK_PATH_MAX,
  head_sha: PLAN_LOCK_PATH_MAX,
  session_id: PLAN_LOCK_PATH_MAX,
  at: PLAN_LOCK_PATH_MAX,
};
// One lane's hand-off is a few sentences; a note cannot spend more of the
// injection than that per lane (the lane COUNT stays exact, see below).
const LANE_HANDOFF_MAX = 1000;

export function rotationNotePath(cwd) {
  return join(cwd, '.sterling', 'transient', 'rotation-note.json');
}

/** The parsed note, or null when there is none. Does not consume it. A malformed note throws. */
export function readRotationNote(cwd) {
  const notePath = rotationNotePath(cwd);
  if (!existsSync(notePath)) return null;
  return JSON.parse(readFileSync(notePath, 'utf8'));
}

/** Read and CONSUME the note: deleted before anything is built from it, so a note serves exactly one restore. */
export function consumeRotationNote(cwd) {
  const note = readRotationNote(cwd);
  if (note) rmSync(rotationNotePath(cwd), { force: true }); // consume FIRST — a note serves exactly one restore
  return note;
}

/**
 * The ROTATION RESTORE text for a consumed note, starting with a blank line.
 * `source` is H1's SessionStart source ('clear' | 'startup') on Claude Code;
 * on OpenCode it is ignored. `planLock`/`planLockMalformed` are the live plan
 * lock as the caller read it.
 */
export function renderRotationRestore(note, { cwd, source, host = 'claude', planLock = null, planLockMalformed = false }) {
  if (host !== 'claude' && host !== 'opencode') throw new Error(`renderRotationRestore: unknown host '${host}'`);
  const head = (() => {
    try {
      const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cwd, encoding: 'utf8', timeout: 5_000 });
      return r.status === 0 ? (r.stdout ?? '').trim() : null;
    } catch {
      return null;
    }
  })();
  const cautions = [];
  if (note.head_sha && head && head !== note.head_sha) {
    cautions.push(`HEAD has MOVED since the note (${planLockClean(String(note.head_sha), PLAN_LOCK_PATH_MAX).slice(0, 8)} → ${head.slice(0, 8)}) — re-verify repository state before acting on it`);
  }
  // COMMITS-AHEAD DRIFT (N15, docs/feedback/sterling-plugin-*2026-08-24*):
  // the note's commits_ahead is a number the writer computed, not prose —
  // recompute it the same way at restore time and disclose any mismatch
  // exactly like the head_sha check above, rather than trusting a stamp
  // that may already be stale (a note written, then more commits landed
  // before the /clear actually happened). UNVERIFIABLE IS ITS OWN STATE
  // (Codex P2-B), distinct from both "matches" and "drifted": when the
  // base is missing or the recount itself fails (e.g. a --base ref that
  // no longer resolves), the stamped count is printed with an explicit
  // "(unverified — base unavailable)" marker rather than silently
  // presented as though it had been confirmed — and, just as important,
  // never asserted as DRIFT either, since a failed recount is not
  // evidence the number is wrong.
  // THE NOTE IS AN ON-DISK FILE WRITTEN FROM A PREVIOUS SESSION'S CLI
  // ARGUMENTS, so every field of it that reaches additionalContext is
  // control-stripped and bounded by the SAME sanitizer the PLAN LOCK
  // section uses — prose fields generously (they are the point of the
  // note), path- and sha-shaped ones at the path bound. Only plan_path was
  // covered before; a control character in `objective` could fabricate a line.
  const noteBaseBranch = planLockClean(note.base_branch, PLAN_LOCK_PATH_MAX);
  let commitsAheadUnverified = false;
  if (typeof note.commits_ahead === 'number') {
    if (!note.base_branch) {
      commitsAheadUnverified = true;
    } else {
      try {
        const countR = spawnSync('git', ['rev-list', '--count', `${note.base_branch}..HEAD`], { cwd: cwd, encoding: 'utf8', timeout: 5_000 });
        const actual = countR.status === 0 ? Number((countR.stdout ?? '').trim()) : null;
        if (Number.isFinite(actual)) {
          if (actual !== note.commits_ahead) {
            cautions.push(`commits_ahead drift — note says ${note.commits_ahead}, actual is ${actual} (vs ${noteBaseBranch || 'unknown base'})`);
          }
        } else {
          commitsAheadUnverified = true;
        }
      } catch {
        commitsAheadUnverified = true; // fail-open — a failed recount costs only the verification, never the restore
      }
    }
  }
  const ageMs = Date.now() - Date.parse(note.at ?? '');
  if (Number.isFinite(ageMs) && ageMs > 60 * 60 * 1000) {
    cautions.push(`the note is ~${Math.round(ageMs / 3_600_000)}h old`);
  }
  // PLAN DRIFT (decision plan-lock-...): note.plan_path is a SNAPSHOT taken
  // at write time, and a new plan can be approved between the note and the
  // /clear that consumes it. Disclose the divergence — never silently
  // substitute either value — using the lock this hook already parsed once.
  // Both paths reach additionalContext, so both go through the SAME
  // sanitizer the PLAN LOCK section uses — the note is an on-disk file a
  // previous session wrote, not a trusted in-memory value.
  // COMPARE THE RAW STRINGS, DISPLAY THE SANITIZED ONES. Sanitizing before
  // comparing would make two genuinely different paths compare EQUAL once
  // their differences are stripped or truncated away — the mismatch this
  // exists to disclose would then be silently suppressed. Presence is
  // judged on the raw value too, so a path made entirely of stripped
  // characters is still a path the note names.
  const notePlanRaw = typeof note.plan_path === 'string' && note.plan_path ? note.plan_path : null;
  const livePlanRaw = typeof planLock?.plan_path === 'string' && planLock.plan_path ? planLock.plan_path : null;
  const notePlan = notePlanRaw ? planLockClean(notePlanRaw, PLAN_LOCK_PATH_MAX) : null;
  const livePlan = livePlanRaw ? planLockClean(livePlanRaw, PLAN_LOCK_PATH_MAX) : null;
  // THREE ARMS, and the third is the one a two-arm version gets wrong: a
  // MALFORMED lock is not an absent one, and saying "no plan lock is live"
  // for a lock sitting on disk would send the reader looking for the wrong
  // repair.
  if (notePlanRaw && planLockMalformed) {
    cautions.push(`the note names a plan (${notePlan}) but the live plan lock is MALFORMED and could not be compared against it — inspect it with \`plan-lock.mjs --show\``);
  } else if (notePlanRaw && livePlanRaw && notePlanRaw !== livePlanRaw) {
    cautions.push(`the note's plan_path DIFFERS from the current plan lock (note: ${notePlan}; lock now: ${livePlan}) — a new plan was approved after the note was written, and the PLAN LOCK section above is the authority`);
  } else if (notePlanRaw && !livePlanRaw) {
    cautions.push(`the note names a plan (${notePlan}) but no plan lock is live now — it was released, or .sterling/ was recreated`);
  }
  // The plan leads the note's fields: it names the AUTHORITY over the next
  // slice, where every other field describes the residue.
  const planField = notePlanRaw ? [`- plan: ${notePlan}`] : [];
  // The session id is printed inside a runnable `claude --resume <id>`
  // command, so a hand-edited note must not smuggle shell text into it: only
  // an id-shaped value (the same shape the writer accepts) is rendered;
  // anything else is treated as absent.
  const noteSessionId = typeof note.session_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(note.session_id) ? note.session_id : null;
  const fields = planField
    .concat(
      ['objective', 'next_slice', 'risks', 'pointers', 'branch', 'head_sha', 'session_id', 'at']
        .map((k) => [k, k === 'session_id' ? noteSessionId : note[k]])
        .filter(([, v]) => v)
        .map(([k, v]) => `- ${k}: ${planLockClean(String(v), NOTE_FIELD_MAX[k])}`)
    )
    .concat(
      typeof note.commits_ahead === 'number'
        ? [`- commits_ahead: ${note.commits_ahead} (vs ${noteBaseBranch || 'unknown base'})${commitsAheadUnverified ? ' (unverified — base unavailable)' : ''}`]
        : []
    )
    .join('\n');
  // LIVE DISPATCHES AT ROTATION (board efbddf09): the note's live_dispatches
  // is the only trace a fresh session has of a subagent that kept running
  // across the /clear — re-print it so the conductor knows the territory
  // may still be written to instead of dispatching a second agent at the
  // same slice unawares (measured 2026-09-04). Those agents cannot be
  // resumed or listed from the new session (finding
  // warm-subagent-resume-across-clear-october-2026), so the remedy is a
  // fresh re-dispatch, not ListAgents. THREE STATES, deliberately
  // distinct: a non-empty array is counted and enumerated; a CONFIRMED-EMPTY array prints NOTHING at all,
  // not even a "0 dispatch(es)" line (P1 — no ceremony for a checked-clear);
  // null is UNKNOWN (the writer found a register it could not read) and is
  // disclosed as uncertainty, never as a fabricated count. An ABSENT field
  // (a note from a writer predating this) is treated as the silent case —
  // it is not evidence of uncertainty, and manufacturing a warning from it
  // would fire on every legacy note.
  const liveDispatches = note.live_dispatches;
  let liveLine = '';
  if (Array.isArray(liveDispatches) && liveDispatches.length) {
    // BOUNDED RENDER. Per-element sanitisation bounds each STRING but not
    // the ARRAY, so a note carrying thousands of dispatches (or one
    // dispatch with thousands of territory entries) could still dominate
    // the whole injection. The COUNT stays exact and unclipped — it is the
    // number the conductor acts on; only the enumeration is clipped, and
    // every clip says how much it dropped rather than trailing off.
    const rendered = liveDispatches
      .slice(0, LIVE_DISPATCH_MAX)
      .map((d) => {
        // Same treatment as the note's scalar fields above — these strings
        // come from the same on-disk file and reach the same payload.
        const entries = Array.isArray(d?.territory) ? d.territory : [];
        let territory = 'no declared territory';
        if (entries.length) {
          const shown = entries.slice(0, LIVE_TERRITORY_MAX).map((t) => planLockClean(String(t), PLAN_LOCK_PATH_MAX));
          const dropped = entries.length - shown.length;
          let joined = shown.join(', ');
          if (joined.length > LIVE_TERRITORY_LINE_MAX) joined = `${joined.slice(0, LIVE_TERRITORY_LINE_MAX)}…`;
          territory = dropped > 0 ? `${joined}… (+${dropped} more)` : joined;
        }
        return `- ${planLockClean(String(d?.agent_type ?? 'agent'), PLAN_LOCK_PATH_MAX) || 'agent'} (${planLockClean(String(d?.agent_id ?? 'unknown id'), PLAN_LOCK_PATH_MAX) || 'unknown id'}) — ${territory}`;
      })
      .join('\n');
    const omitted = liveDispatches.length - Math.min(liveDispatches.length, LIVE_DISPATCH_MAX);
    liveLine =
      `\n${liveDispatches.length} dispatch(es) were live at rotation. They belong to the previous session and cannot be resumed from this one (agent lookup is scoped to the current session); re-dispatch fresh if the work is still needed, and mind the territory below, which they may still be writing:\n${rendered}` +
      (omitted > 0 ? `\n… (+${omitted} more)` : '');
  } else if (liveDispatches === null) {
    liveLine = `\n${render(
      disclosure(
        'register_unavailable',
        {},
        'dispatch register unavailable — the register existed but could not be read when the note was written, so whether any subagent was still running cannot be stated here. Any such subagent belongs to the previous session and cannot be resumed from this one: re-dispatch fresh if the work is still needed, and check git status for files it may still be writing.'
      )
    )}`;
  }
  // UNCERTAIN DISPATCHES (tri-state, R1): an out-of-lease entry is carried
  // by the note (rotation-note.mjs's uncertain_dispatches) but is NEVER
  // folded into the live count above — an expired lease is not a death
  // certificate, so it is surfaced separately with its own code rather
  // than silently dropped or counted as live.
  const uncertainDispatches = Array.isArray(note.uncertain_dispatches) ? note.uncertain_dispatches : [];
  let uncertainLine = '';
  if (uncertainDispatches.length) {
    const renderedUncertain = uncertainDispatches
      .slice(0, LIVE_DISPATCH_MAX)
      .map((d) => {
        const type = planLockClean(String(d?.agent_type ?? 'agent'), PLAN_LOCK_PATH_MAX) || 'agent';
        const id = planLockClean(String(d?.agent_id ?? 'unknown id'), PLAN_LOCK_PATH_MAX) || 'unknown id';
        const reason = planLockClean(String(d?.reason ?? 'unknown'), PLAN_LOCK_PATH_MAX) || 'unknown';
        return render(
          disclosure('dispatch_status_unknown', {}, `${type}:${id} — ownership uncertain (${reason}); belongs to the previous session and cannot be resumed from this one — re-dispatch fresh if still needed`)
        );
      })
      .join('\n');
    const omittedUncertain = uncertainDispatches.length - Math.min(uncertainDispatches.length, LIVE_DISPATCH_MAX);
    uncertainLine =
      `\n${uncertainDispatches.length} dispatch(es) UNCERTAIN at rotation (lease expired, not confirmed dead — never counted as live):\n${renderedUncertain}` +
      (omittedUncertain > 0 ? `\n… (+${omittedUncertain} more)` : '');
  }
  // LANE HAND-OFFS (finding warm-subagent-resume-across-clear-october-2026):
  // measured 2026-10-01, SendMessage to a pre-clear agent id fails with "No
  // transcript found for agent ID" — agent lookup is scoped to the current
  // session. The note's lanes are therefore the only continuity a lane has,
  // and the statement above them says so, so the conductor re-dispatches
  // fresh instead of trying to resume. Zero lanes or an absent field (a
  // legacy note) prints nothing (P1). Per-lane text is sanitised and
  // clipped, the array is clipped, the COUNT stays exact. Whitespace runs
  // (newlines included) collapse to one space BEFORE the control-character
  // sanitiser, so a lane is always exactly one bullet line and cannot open
  // a line that reads like a block header; a lane that sanitises to nothing
  // is dropped and not counted.
  const noteLanes = (Array.isArray(note.lanes) ? note.lanes : [])
    .filter((l) => typeof l === 'string')
    .map((l) => planLockClean(l.replace(/\s+/g, ' '), LANE_HANDOFF_MAX))
    .filter(Boolean);
  let lanesLine = '';
  if (noteLanes.length) {
    const noteSession = noteSessionId;
    const renderedLanes = noteLanes
      .slice(0, LIVE_DISPATCH_MAX)
      .map((l) => `- ${l}`)
      .join('\n');
    const omittedLanes = noteLanes.length - Math.min(noteLanes.length, LIVE_DISPATCH_MAX);
    // THE WAY BACK follows the host that WROTE the note (session_host; absent
    // means Claude Code, the only writer before OpenCode support), not the host
    // restoring it: an OpenCode session id is resumed with `opencode --session`.
    const wayBack = note.session_host === 'opencode'
      ? (noteSession
          ? `The old agents are reachable only by returning to the old session: \`opencode --session ${noteSession}\`.`
          : `The old agents are reachable only by returning to the old session; the note recorded no session id.`)
      : (noteSession
          ? `The old agents are reachable only by returning to the old session: \`claude --resume ${noteSession}\`, or the rewind menu's previous-session entry.`
          : `The old agents are reachable only by returning to the old session (the rewind menu's previous-session entry); the note recorded no session id.`);
    lanesLine =
      (host === 'claude'
        ? `\n${noteLanes.length} lane hand-off(s) carried across the rotation. Pre-clear subagents cannot be resumed with SendMessage after a /clear or restart ("No transcript found for agent ID"): re-dispatch each lane worth continuing fresh, with its hand-off below in the brief. `
        : `\n${noteLanes.length} lane hand-off(s) carried across the rotation. Subagents of the previous session are not continued from this one: re-dispatch each lane worth continuing fresh, with its hand-off below in the brief. `) +
      wayBack +
      `\n${renderedLanes}` +
      (omittedLanes > 0 ? `\n… (+${omittedLanes} more)` : '');
  }
  const body = `\n${fields}${liveLine}${uncertainLine}${lanesLine}\nResume from next_slice. The board and knowledge store remain the authorities for remaining work and decisions — the note carries only the residue they cannot hold. `;
  const caution = cautions.length ? ` CAUTION: ${cautions.join('; ')}.` : '';
  if (host === 'opencode') {
    // OpenCode: the user started a new session (/new) in a running OpenCode,
    // and a new session does not reload plugin or MCP-server code; only a
    // relaunch of OpenCode does.
    return (
      `\n\nROTATION RESTORE (Sterling OpenCode plugin): a rotation note was prepared before this new session; this injection CONSUMES it (single-shot).` +
      caution +
      body +
      (note.reason === 'code-reload'
        ? `CODE RELOAD WAS REQUIRED (note reason: code-reload) — the correct sequence was: 1. exit and relaunch OpenCode, 2. THEN start this new session. If step 1 was skipped, the Sterling plugin and MCP server may still be stale: exit and relaunch OpenCode now.`
        : `If next_slice depends on a plugin or MCP-server code change (migration, update, rebuild), that requires having EXITED AND RELAUNCHED OpenCode before this new session — a new session alone never reloads code, so relaunch now if that didn't happen yet.`)
    );
  }
  // SOURCE-AWARE CLOSING PARAGRAPH: the `clear` wording below is UNCHANGED
  // from before startup consumption was added (scripts/tests/rotation-
  // code-reload.test.mjs PIN 1/2/4/4-CONTROL pin it verbatim) — only the
  // `startup` arm is new. On a genuine startup the CLI process (and any
  // MCP server it spawns) just (re)started, so the exit-and-relaunch a
  // code-reload note asks for has, by construction, already happened;
  // there is nothing to caution the reader to still go do.
  const isClear = source === 'clear';
  return (
    `\n\nROTATION RESTORE (H1, source=${source}): a rotation note was prepared before this ${isClear ? '/clear' : 'restart'}; this injection CONSUMES it (single-shot).` +
    caution +
    body +
    (note.reason === 'code-reload'
      ? (isClear
          ? `CODE RELOAD WAS REQUIRED (note reason: code-reload) — the correct sequence was: 1. exit and relaunch the Claude Code CLI, 2. THEN this /clear. If step 1 was skipped, this session's MCP server/hooks may still be stale: exit and relaunch the CLI now, then /clear again.`
          : `CODE RELOAD WAS REQUIRED (note reason: code-reload) — this restore is happening at session STARTUP, which already implies the exit-and-relaunch that reloads server/hook code.`)
      : (isClear
          ? `If next_slice depends on a server/hook code change (migration, update, rebuild), that requires having EXITED AND RELAUNCHED the Claude Code CLI BEFORE this /clear — a /clear alone never reloads code, so relaunch now if that didn't happen yet.`
          : `If next_slice depends on a server/hook code change (migration, update, rebuild), this STARTUP already reloaded it.`))
  );
}
