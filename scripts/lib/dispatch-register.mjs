// scripts/lib/dispatch-register.mjs — THE dispatch register owner.
//
// INVARIANT: this module is the ONE authority for the transient dispatch
// register's persisted shape (RegisterEntry), its parser, its TRI-STATE
// liveness classifier, and the owner-mkdir lock primitive shared with the
// review ledger. A dispatch's liveness is never a binary live/dead verdict —
// the platform emits no death signal for a killed subagent, so an expired
// lease is UNKNOWN, never confirmed dead; only an explicit terminal event
// (`ended`) yields inactive-confirmed. Stop MARKS an entry ended; it is never
// deleted, because inactive-confirmed is only a real classifier output
// because the evidence for it survives on disk.
// DOES NOT GUARANTEE: that an `unknown` dispatch is still running (it may be
// dead with no signal ever emitted for it); that a `presumed-active` dispatch
// is still running (it may have died within the lease window); a TaskStop
// terminal transition (not built in R1); correctness under concurrent live
// sessions in one worktree (one live session per worktree is the contract —
// H1's SessionStart wipe is global and transient/session.json is single);
// that the owner-mkdir lock protects against anything but this module's own
// cooperating writers.

import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, existsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { refusal } from './review-errors.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function registerPath(root) {
  return join(root, '.sterling', 'transient', 'dispatch-register.json');
}

export function registerLockDir(root) {
  return join(root, '.sterling', 'transient', 'dispatch-register.lock');
}

function ledgerLockDir(root) {
  return join(root, '.sterling', 'review-ledger.lock');
}

function sessionPath(root) {
  return join(root, '.sterling', 'transient', 'session.json');
}

function configPath(root) {
  return join(root, '.sterling', 'config.json');
}

// H1's latest-value cell, {session_id, source, at}. null when absent or
// unreadable — every same-session comparison then correctly falls to
// 'unknown/other-session' rather than fabricating a local identity.
export function readSessionId(root) {
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(root), 'utf8'));
    return typeof parsed?.session_id === 'string' && parsed.session_id ? parsed.session_id : null;
  } catch {
    return null;
  }
}

// resolveSessionIdentity — THE ONE session-identity resolver shared by every
// CLI that reads STERLING_SESSION_ID (commit-reviewed.mjs, review-ledger.mjs).
// A19/A20: STERLING_SESSION_ID WINS when set — it is always the effective
// identity (a hook-launched process, or an explicit escape hatch, both need
// this) — but the OVERRIDE DISCLOSURE fires on a narrower, laundering-shaped
// condition: the env var is set AND a session marker (H1's
// .sterling/transient/session.json) exists AND the two DISAGREE. Env-only
// identity with NO marker file present is the ordinary test-fixture / no-hook
// shape and is never disclosed — there is nothing to override when nothing
// else claims an identity (frozen pin R1-D20: a clean run's disclosures stay
// present-as-empty).
export function resolveSessionIdentity(root, env = process.env) {
  const envSessionId = env.STERLING_SESSION_ID;
  const markerSessionId = readSessionId(root);
  const override = envSessionId !== undefined && markerSessionId !== null && markerSessionId !== envSessionId;
  const session_id = envSessionId !== undefined ? envSessionId : markerSessionId;
  const source = envSessionId !== undefined ? 'env' : markerSessionId !== null ? 'marker' : 'none';
  return { session_id, source, override };
}

function readStaleMinutesDefault(root) {
  try {
    const cfg = JSON.parse(readFileSync(configPath(root), 'utf8'));
    const v = cfg?.dispatch_register?.stale_minutes;
    return typeof v === 'number' && v > 0 ? v : 60;
  } catch {
    return 60;
  }
}

// ---------------------------------------------------------------------------
// parseRegisterEntry — ONE parser authority. A legacy on-disk shape (no
// files_source / claimed_* / attribution) must parse: these default rather
// than fail, per A11's "minimal shape" ruling.
// ---------------------------------------------------------------------------

export function parseRegisterEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'register_entry_malformed', facts: { reason: 'not-an-object' } };
  }
  if (typeof raw.agent_id !== 'string' || !raw.agent_id) {
    return { ok: false, code: 'register_entry_malformed', facts: { reason: 'agent_id' } };
  }
  if (typeof raw.session_id !== 'string' || !raw.session_id) {
    return { ok: false, code: 'register_entry_malformed', facts: { reason: 'session_id' } };
  }
  if (!Array.isArray(raw.files)) {
    return { ok: false, code: 'register_entry_malformed', facts: { reason: 'files' } };
  }
  if (typeof raw.at !== 'string' || !raw.at) {
    return { ok: false, code: 'register_entry_malformed', facts: { reason: 'at' } };
  }
  // NO FABRICATION, NO DROPPING: this parser VALIDATES only the four
  // required fields above (refusing when one is missing or wrong-typed).
  // Every other field — agent_type, files_source, claimed_*, attribution,
  // round, exclusive_resources, configured_model, ended,
  // residue_reported_at, or any future consumer-stamped field this parser
  // has no opinion about — is copied through EXACTLY as the raw entry
  // carries it. H10/H1 read a field like residue_reported_at through this
  // ONE parser instead of a second raw JSON read precisely because a lossy
  // parse would force them back to one.
  return { ok: true, entry: { ...raw, files: raw.files.slice() } };
}

// ---------------------------------------------------------------------------
// Raw array IO — used internally by registerStart/registerEnd, which must
// preserve every on-disk field (including ones parseRegisterEntry does not
// surface) when rewriting.
// ---------------------------------------------------------------------------

function readRawArray(root) {
  const p = registerPath(root);
  if (!existsSync(p)) return { availability: 'absent', arr: [] };
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return { availability: 'corrupt', arr: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { availability: 'corrupt', arr: [] };
  }
  if (!Array.isArray(parsed)) return { availability: 'corrupt', arr: [] };
  return { availability: 'ok', arr: parsed };
}

function writeRawArrayAtomic(root, arr) {
  const dir = join(root, '.sterling', 'transient');
  mkdirSync(dir, { recursive: true });
  const p = registerPath(root);
  const tmp = `${p}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(arr));
  renameSync(tmp, p);
}

// readRegister — the public availability + classified-entries read. Never
// throws; individually malformed entries are dropped and counted rather than
// condemning the whole file.
export function readRegister(root) {
  const { availability, arr } = readRawArray(root);
  if (availability !== 'ok') return { availability, entries: [], dropped: 0 };
  let dropped = 0;
  const entries = [];
  for (const raw of arr) {
    const r = parseRegisterEntry(raw);
    if (r.ok) entries.push(r.entry);
    else dropped += 1;
  }
  return { availability: 'ok', entries, dropped };
}

// ---------------------------------------------------------------------------
// withOwnerMkdirLock — the ONE lock primitive, shared by the register and the
// review ledger. mkdir-exclusivity + an owner.json {pid, host, at, nonce}.
// Takeover ONLY when owner.host === this host AND owner.pid is verified not
// running (process.kill(pid, 0) -> ESRCH). NEVER by age. A lock whose owner
// cannot be verified dead on this host refuses (coordination, not evidence);
// the operator removes it by hand only after confirming no writer runs.
//
// ASYNC ONLY: withOwnerMkdirLock always returns a promise — a held lock
// REJECTS with the refusal object rather than throwing synchronously. Every
// caller (register and ledger alike) awaits it.
// ---------------------------------------------------------------------------

const LOCK_CODE_BY_BASENAME = {
  'dispatch-register.lock': 'register_lock_held',
  'review-ledger.lock': 'ledger_lock_held',
};

function lockCodeFor(lockDir) {
  return LOCK_CODE_BY_BASENAME[basename(lockDir)] ?? 'register_lock_held';
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== 'ESRCH'; // ESRCH = provably not running; anything else is unverifiable, treat as alive
  }
}

function readOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function looksDeadOwner(o) {
  return !!o && o.host === hostname() && !isPidAlive(o.pid);
}

function statIno(p) {
  try {
    return statSync(p).ino;
  } catch {
    return null;
  }
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withOwnerMkdirLock(lockDir, fn, opts = {}) {
  const retryMs = opts.retryMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 1000;
  const start = Date.now();
  for (;;) {
    try {
      // The lock dir's PARENT must exist (an absent .sterling/transient/ etc.
      // must not throw ENOENT before either contender ever contends); the
      // lock mkdir itself stays NON-RECURSIVE — that exclusivity is the mutex.
      mkdirSync(dirname(lockDir), { recursive: true });
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      const owner = readOwner(lockDir);
      if (looksDeadOwner(owner)) {
        // ATOMIC TAKEOVER: rename the stale dir away under a private name —
        // rename is atomic, so exactly ONE contender wins the rename. That
        // alone does not prove we moved the INCARNATION we examined: A and B
        // can both read dead owner X, B renames X away and a fresh contender
        // C then acquires a LIVE lock at lockDir, and A's rename would move
        // C's live lock instead. So after the rename, verify the tombstone
        // is the SAME incarnation (inode + owner.nonce) we examined AND is
        // still dead — only then is it removed. A mismatch (or a now-live
        // owner) is restored to lockDir immediately and treated as a lost
        // race. If the restore itself loses to a fourth contender (EEXIST —
        // someone acquired lockDir in the gap since our rename-out), we
        // cannot silently drop the displaced dir (it may be live): disclose
        // on stderr and REFUSE this call outright rather than proceed on
        // unverified state. NOT GUARANTEED: three contenders racing inside
        // this one syscall gap (rename-out, stat, rename-back) is a residual
        // window this closes down to, not fully closes.
        const examinedIno = statIno(lockDir);
        const tombstone = `${lockDir}.stale-${randomBytes(8).toString('hex')}`;
        let renamed = false;
        try {
          renameSync(lockDir, tombstone);
          renamed = true;
        } catch {
          // lost the rename race (or it is already gone) — fall through
        }
        if (renamed) {
          const tombstoneOwner = readOwner(tombstone);
          const sameIncarnation = examinedIno !== null && statIno(tombstone) === examinedIno && tombstoneOwner?.nonce === owner.nonce;
          if (sameIncarnation && looksDeadOwner(tombstoneOwner)) {
            try {
              rmSync(tombstone, { recursive: true, force: true });
            } catch {
              // best-effort cleanup of OUR OWN tombstone; harmless if it lingers
            }
          } else {
            try {
              renameSync(tombstone, lockDir);
            } catch (restoreErr) {
              if (restoreErr?.code === 'EEXIST') {
                process.stderr.write(
                  `dispatch-register: lock takeover at ${lockDir} displaced a live incarnation and could not restore it (already reoccupied) — left as a tombstone at ${tombstone}; verify and remove by hand\n`
                );
                throw refusal(
                  lockCodeFor(lockDir),
                  { lock_dir: lockDir, owner: tombstoneOwner ? { pid: tombstoneOwner.pid, host: tombstoneOwner.host, at: tombstoneOwner.at } : null },
                  `lock takeover at ${lockDir} raced a third contender — refusing this call rather than proceeding on unverified state`
                );
              }
              // any other restore failure — fall through as a lost race too
            }
          }
        }
      }
      if (Date.now() - start >= timeoutMs) {
        throw refusal(
          lockCodeFor(lockDir),
          { lock_dir: lockDir, owner: owner ? { pid: owner.pid, host: owner.host, at: owner.at } : null },
          `lock held at ${lockDir} — coordination, not evidence; remove by hand only after confirming no writer runs`
        );
      }
      await sleepAsync(retryMs);
    }
  }

  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce: randomBytes(8).toString('hex') })
  );

  try {
    return await fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // best-effort; a failed release leaves a diagnosable lock, never a crash
    }
  }
}

export function withRegisterLock(root, fn, opts = {}) {
  return withOwnerMkdirLock(registerLockDir(root), fn, opts);
}

export function withLedgerLock(root, fn, opts = {}) {
  return withOwnerMkdirLock(ledgerLockDir(root), fn, opts);
}

// ---------------------------------------------------------------------------
// registerStart / registerEnd — A1 (Stop MARKS, never deletes) + A4 (resuming
// a reviewer fires SubagentStart again with the SAME agent_id: the duplicate
// refusal is scoped to an UNENDED entry only, so round n+1 is admitted).
// ---------------------------------------------------------------------------

export function registerStart(root, entry) {
  return withRegisterLock(root, () => {
    const { availability, arr } = readRawArray(root);
    // A24: a CORRUPT register is a signal, not an invitation to reset —
    // silently starting from [] would destroy the corruption evidence AND
    // any unended rounds it still held. Only 'absent' (the normal
    // post-SessionStart state) proceeds from an empty list; 'corrupt'
    // refuses and writes nothing.
    if (availability === 'corrupt') {
      throw refusal('register_unavailable', { path: registerPath(root), reason: 'corrupt' });
    }
    const list = availability === 'ok' ? arr : [];
    const hasUnendedDup = list.some((e) => e && e.agent_id === entry.agent_id && e.session_id === entry.session_id && !e.ended);
    if (hasUnendedDup) {
      throw refusal('register_agent_id_duplicate', { agent_id: entry.agent_id, session_id: entry.session_id });
    }
    const priorRounds = list.filter((e) => e && e.agent_id === entry.agent_id && e.session_id === entry.session_id);
    const round = priorRounds.length > 0 ? Math.max(...priorRounds.map((e) => (typeof e.round === 'number' ? e.round : 1))) + 1 : 1;
    const toWrite = { ...entry, round };
    list.push(toWrite);
    writeRawArrayAtomic(root, list);
    return toWrite;
  });
}

// registerEnd(root, agent_id, event, {sessionId}?) — when sessionId is given,
// selects the single UNENDED entry by the PAIR (session_id, agent_id): the
// same agent_id can legitimately be unended in two sessions at once (A2), and
// selecting by agent_id alone would end whichever entry happens to be first,
// leaving the real one open forever. Omitting sessionId keeps the prior
// agent_id-only selection (additive — existing 3-arg callers are unaffected).
export function registerEnd(root, agentId, event, { sessionId } = {}) {
  return withRegisterLock(root, () => {
    const { availability, arr } = readRawArray(root);
    // A24: 'absent' is the normal post-SessionStart state — nothing to end,
    // no throw. 'corrupt' refuses instead of silently no-oping: a caller
    // must not read "found:false" as "there was nothing here" when the
    // truth is "the register could not be read".
    if (availability === 'corrupt') {
      throw refusal('register_unavailable', { path: registerPath(root), reason: 'corrupt' });
    }
    if (availability !== 'ok') return { found: false };
    const idx = arr.findIndex((e) => e && e.agent_id === agentId && !e.ended && (sessionId === undefined || e.session_id === sessionId));
    if (idx === -1) return { found: false };
    const updated = { ...arr[idx], ended: { at: new Date().toISOString(), event } };
    arr[idx] = updated;
    writeRawArrayAtomic(root, arr);
    // Select AND mark under the SAME lock hold, and return the ended entry
    // (through the one parser) so a caller (H22's promotion) can act on
    // exactly the entry it ended — never re-select outside the lock.
    const parsed = parseRegisterEntry(updated);
    return { found: true, entry: parsed.ok ? parsed.entry : updated };
  });
}

// ---------------------------------------------------------------------------
// dispatchStatus — the TRI-STATE classifier. Age NEVER yields
// inactive-confirmed; only an explicit `ended` terminal event does.
// ---------------------------------------------------------------------------

export function statusReason(entry, ctx) {
  if (!entry) return 'clock-unreadable';
  const t = Date.parse(entry.at);
  if (Number.isNaN(t)) return 'clock-unreadable';
  // ctx.sessionId === null is the NO-SESSION-JOIN mode (a session-less CLI
  // like rotation-note): the session check is skipped entirely and only the
  // lease half applies — an entry is never 'other-session' in this mode.
  if (ctx.sessionId !== null && entry.session_id !== ctx.sessionId) return 'other-session';
  const age = ctx.now - t;
  const lease = ctx.staleMinutes * 60_000;
  if (age >= 0 && age < lease) return null; // inside the presumed-active window
  return 'lease-expired';
}

export function dispatchStatus(entry, ctx) {
  if (entry?.ended) return 'inactive-confirmed';
  return statusReason(entry, ctx) === null ? 'presumed-active' : 'unknown';
}

// ---------------------------------------------------------------------------
// classifyRegister / formatDispatchRef / inFlightAdvisory
// ---------------------------------------------------------------------------

export function classifyRegister(root, ctx) {
  const { availability, entries } = readRegister(root);
  if (availability !== 'ok') return { availability, entries: [] };
  const rows = entries.map((entry) => {
    const status = dispatchStatus(entry, ctx);
    const reason = statusReason(entry, ctx);
    const t = Date.parse(entry.at);
    const ageMs = Number.isNaN(t) ? null : ctx.now - t;
    return { entry, status, reason, ageMs };
  });
  return { availability: 'ok', entries: rows };
}

function formatAge(ageMs) {
  if (ageMs === null || ageMs === undefined || Number.isNaN(ageMs)) return 'age unreadable';
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h${m}m`;
}

export function formatDispatchRef(row) {
  const { entry, status, ageMs } = row;
  return `${entry.agent_type}:${entry.agent_id} (registered ${formatAge(ageMs)}; ${status})`;
}

// inFlightAdvisory(root, consequence, ctx?) — the single line a script-side
// consumer (check-projection-fresh, build-hooks) prints. `ctx` is optional:
// these consumers have no natural session_id of their own, so an omitted ctx
// is filled in from readSessionId/config here rather than forcing every
// caller to assemble one.
export function inFlightAdvisory(root, consequence, ctx = {}) {
  const resolvedCtx = {
    now: ctx.now ?? Date.now(),
    sessionId: ctx.sessionId ?? readSessionId(root),
    staleMinutes: ctx.staleMinutes ?? readStaleMinutesDefault(root),
  };
  const classified = classifyRegister(root, resolvedCtx);
  if (classified.availability !== 'ok') {
    return `dispatch register unavailable (${classified.availability}) [register_unavailable] — ${consequence}`;
  }
  const live = classified.entries.filter((r) => r.status !== 'inactive-confirmed');
  if (live.length === 0) return null;
  const parts = live.map((r) => formatDispatchRef(r));
  return `[dispatch_status_unknown] in-flight dispatches: ${parts.join(', ')} — ${consequence}`;
}
