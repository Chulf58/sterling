// scripts/lib/dispatch-register.mjs — THE dispatch register AND dispatch
// state-machine owner (decision `dispatch-state-machine-pre-slot-post-binding-
// locked-start-resolution-replaces-transcript-attribution`).
//
// INVARIANT (register): this module is the ONE authority for the transient
// dispatch register's persisted shape (RegisterEntry), its parser, its
// TRI-STATE liveness classifier, and the kernel-held register lock. A dispatch's liveness is never a binary live/dead
// verdict — the platform emits no death signal for a killed subagent, so an
// expired lease is UNKNOWN, never confirmed dead; only an explicit terminal
// event (`ended`) yields inactive-confirmed. Stop MARKS an entry ended; it is
// never deleted, because inactive-confirmed is only a real classifier output
// because the evidence for it survives on disk.
//
// INVARIANT (dispatch state): every Task|Agent dispatch has ONE state record,
// keyed by its tool_use_id, written at PreToolUse (zero lag, carries the
// prompt), bound to an agent_id by PostToolUse (the platform's own
// tool_response.agentId — authoritative) or, failing that, by a DERIVATION
// exact by construction (the single pending same-type record of this
// session), resolved at SubagentStart under one lock, and closed at
// SubagentStop into a tombstone. A SubagentStart consumer either learns
// exactly which prompt is its own or learns that it cannot, and says so — it
// never guesses from the parent transcript, whose lag is the defect this
// state machine replaces.
//
// DOES NOT GUARANTEE: that an `unknown` register dispatch is still running (it
// may be dead with no signal ever emitted for it); that a `presumed-active`
// dispatch is still running (it may have died within the lease window) —
// a TaskStop kill IS observed (H22's PostToolUse "TaskStop" matcher ends the
// round with event 'task-stop'), but a kill through the task UI or any other
// path that emits no hook still is not; correctness under
// concurrent live sessions in one worktree (one live session per worktree is
// the contract — H1's SessionStart wipe is global and transient/session.json
// is single); that the register lock protects against anything but this
// module's own cooperating writers; staging for a spawn whose Post is late
// AND whose type has another pending or orphaned sibling (unattributable
// after a bounded wait); recovery of knowledge already staged into the wrong
// child before a later Post contradicts a derivation (recorded as
// derived_post_mismatch, never repaired); attribution across a lock another
// live writer holds past the bound (fails closed 'lock-held'); transactional
// atomicity across the register file and a state file (two writes under one
// lock — the ORDER is chosen so a crash between them leaves the harmless
// half); a cancelled (Pre-denied) dispatch's pending orphan ever clearing
// itself before the session boundary; meaningful confidentiality from the
// 0o600 record-file mode on Windows, where POSIX permission bits are not
// enforced by the filesystem — parity with the POSIX guarantee is NOT
// delivered there (C5, correctness review).

import { mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, renameSync, existsSync, lstatSync, readdirSync, realpathSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { refusal, disclosure, render } from './review-errors.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function registerPath(root) {
  return join(root, '.sterling', 'transient', 'dispatch-register.json');
}

// The RETIRED mkdir lock directory — no longer a lock; named only so a
// leftover can be recognised and cleared (see withRegisterLock).
export function legacyRegisterLockDir(root) {
  return join(root, '.sterling', 'transient', 'dispatch-register.lock');
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

// resolveSessionIdentity (a session-identity resolver over STERLING_SESSION_ID
// vs H1's session.json marker) is DELETED — no caller anywhere, test or
// production (grepped scripts/ packages/ hooks/, excluding this module and
// bundles). readSessionId above (the marker-only half) survives: it is what
// inFlightAdvisory uses to fill in ctx.sessionId.

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
// withRegisterLock — the ONE register lock, KERNEL-HELD (decision
// `dispatch-register-lock-reclaims-an-ownerless-lock-and-releases-only-its-own`,
// REVISED block). The lock is a SQLite `BEGIN IMMEDIATE` transaction on a
// small lock database that is never unlinked, at
// /tmp/sterling-locks/<sha256 of the resolved project root>.db — native ext4,
// never the project tree, because the tree may sit on /mnt/c drvfs, whose
// byte-range locking is unvalidated. The register DATA stays in
// .sterling/transient/. The transaction is held for the whole of fn; COMMIT in
// the finally releases it, closing the connection releases it too, and the
// kernel releases it when the holding process dies. Nothing is ever written
// to the lock database, so no journal is ever created.
//
// INVARIANT: at most one cooperating writer per resolved project root is
// inside fn at a time, and a lock is only ever released by its own holder's
// COMMIT/close or by the kernel on that holder's death — there is no
// reclaim, rename, owner file or tombstone, so no process can displace
// another's lock and no crash can leave a stale one. A contender retries a
// busy lock every retryMs up to timeoutMs (at least one attempt; sleeping
// OUTSIDE the lock, never blocking the event loop), then REJECTS with the
// register_lock_held refusal — fn never runs unlocked (P5).
//
// A leftover mkdir lock dir from the retired protocol
// (.sterling/transient/dispatch-register.lock) is ignored for locking. Under
// the lock, an EMPTY one is removed as residue and said once on stderr; a
// non-empty one is left in place and warned about.
//
// NOT GUARANTEED: exclusion against a writer still running a PRE-rebuild
// bundle (it takes the mkdir lock, not this one) — hook processes are
// short-lived, so this ends when every session has relaunched onto the new
// bundles; exclusion across two WSL distros or machines sharing one /mnt/c
// tree (each has its own /tmp); one lock for two spellings of one drvfs path
// that differ only in case (realpath does not fold case); fairness or FIFO
// order among contenders; that a holder paused longer than a contender's
// bound finishes before that contender gives up (the contender refuses, it
// never proceeds). Not reentrant: calling it again from inside fn waits on
// itself and refuses at the bound.
//
// ASYNC ONLY: always returns a promise — a held lock REJECTS with the refusal
// object rather than throwing synchronously. fn may be sync or async.
// ---------------------------------------------------------------------------

const LOCK_ROOT = '/tmp/sterling-locks';
const SQLITE_BUSY = 5;

export function registerLockPath(root) {
  const hash = createHash('sha256').update(realpathSync(resolve(root))).digest('hex');
  return join(LOCK_ROOT, `${hash}.db`);
}

// The lock directory is shared /tmp territory: it must be a real directory
// (never a symlink) owned by this user, and private. Anything else refuses
// loudly rather than locking through a path another user controls.
function ensureLockRoot() {
  mkdirSync(LOCK_ROOT, { recursive: true, mode: 0o700 });
  const st = lstatSync(LOCK_ROOT);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`dispatch-register: ${LOCK_ROOT} is not a real directory — refusing to take the register lock through it`);
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`dispatch-register: ${LOCK_ROOT} is owned by uid ${st.uid}, not this user (${process.getuid()}) — refusing to take the register lock through it`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(LOCK_ROOT, 0o700);
}

function isBusy(e) {
  return e?.errcode === SQLITE_BUSY;
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const warnedLegacyDirs = new Set();

// Every connection currently holding the lock, kept strongly reachable for
// the whole hold. Measured 2026-09-22: a holder whose fn awaited a promise
// nothing referenced had its suspended frame — and with it the connection —
// garbage-collected, and the finalizer's close RELEASED the lock mid-section
// while the process lived on. Pinned here, only the holder's own finally or
// its process death ends a hold.
const heldConnections = new Set();

// Runs INSIDE the lock hold, so two writers never race the rmdir.
function clearLegacyLockDir(root) {
  const legacy = legacyRegisterLockDir(root);
  let entries;
  try {
    entries = readdirSync(legacy);
  } catch (e) {
    if (e?.code === 'ENOENT') return;
    if (!warnedLegacyDirs.has(legacy)) {
      warnedLegacyDirs.add(legacy);
      process.stderr.write(`dispatch-register: legacy lock path ${legacy} exists but could not be listed (${e?.code ?? e}) — it no longer locks anything; left in place\n`);
    }
    return;
  }
  if (entries.length === 0) {
    rmdirSync(legacy);
    process.stderr.write(`dispatch-register: removed the EMPTY legacy lock dir ${legacy} — residue of the retired mkdir lock; the register lock is now kernel-held at ${registerLockPath(root)}\n`);
    return;
  }
  if (!warnedLegacyDirs.has(legacy)) {
    warnedLegacyDirs.add(legacy);
    process.stderr.write(`dispatch-register: legacy lock dir ${legacy} is NOT empty (${entries.join(', ')}) — it no longer locks anything and was left in place; remove it by hand once no pre-rebuild session is running\n`);
  }
}

export async function withRegisterLock(root, fn, opts = {}) {
  const retryMs = opts.retryMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 1000;
  ensureLockRoot();
  const lockPath = registerLockPath(root);
  const db = new DatabaseSync(lockPath);
  try {
    db.exec('PRAGMA busy_timeout=0');
    const start = Date.now();
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        break;
      } catch (e) {
        if (!isBusy(e)) throw e;
        const waited = Date.now() - start;
        if (waited >= timeoutMs) {
          throw refusal(
            'register_lock_held',
            { lock_path: lockPath, waited_ms: waited },
            `register lock at ${lockPath} is held by another live writer (kernel-held: it is released when that writer finishes or dies) — gave up after ${waited}ms`
          );
        }
        await sleepAsync(retryMs);
      }
    }
    heldConnections.add(db);
    try {
      clearLegacyLockDir(root);
      return await fn();
    } finally {
      heldConnections.delete(db);
      try {
        db.exec('COMMIT');
      } catch (e) {
        // Never thrown: a throw here would replace fn's own result or error.
        // Closing the connection below releases the lock regardless.
        process.stderr.write(`dispatch-register: COMMIT of the register lock at ${lockPath} failed (${e?.message ?? e}) — the lock is released by closing the connection\n`);
      }
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// registerStart / registerEnd — A1 (Stop MARKS, never deletes) + A4 (resuming
// a reviewer fires SubagentStart again with the SAME agent_id: the duplicate
// refusal is scoped to an UNENDED entry only, so round n+1 is admitted).
// ---------------------------------------------------------------------------

// registerStartLocked / registerEndLocked — the LOCK-FREE cores (C3,
// correctness review): the CALLER already holds withRegisterLock. Factored
// out so a composite (resolveAndRegisterStart, finishDispatchAndRegisterEnd)
// can combine this work with other locked steps under ONE acquisition —
// withRegisterLock is NOT reentrant, so calling the public, self-locking
// registerStart/registerEnd from inside another lock hold would deadlock.
function registerStartLocked(root, entry) {
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
}

export function registerStart(root, entry) {
  return withRegisterLock(root, () => registerStartLocked(root, entry));
}

// registerEndLocked(root, agent_id, event, {sessionId}?) — when sessionId is
// given, selects the single UNENDED entry by the PAIR (session_id, agent_id):
// the same agent_id can legitimately be unended in two sessions at once (A2),
// and selecting by agent_id alone would end whichever entry happens to be
// first, leaving the real one open forever. Omitting sessionId keeps the
// prior agent_id-only selection (additive — existing 3-arg callers are
// unaffected).
function registerEndLocked(root, agentId, event, { sessionId } = {}) {
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
}

export function registerEnd(root, agentId, event, opts = {}) {
  return withRegisterLock(root, () => {
    return registerEndLocked(root, agentId, event, opts);
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

// ===========================================================================
// DISPATCH STATE MACHINE — Pre slot -> Post binding -> locked Start
// resolution -> Stop tombstone. See the module header and decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-
// replaces-transcript-attribution` (sections 1-7) for the full contract this
// section implements.
// ===========================================================================

const MAX_PROMPT_BYTES = 512 * 1024;
const TOOL_USE_ID_SHAPE_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AGENT_ID_SHAPE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ORIGINS = new Set(['pre', 'post-only', 'failure-only']);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DERIVE_RETRY_INTERVAL_MS = 10;
const DERIVE_PER_ATTEMPT_LOCK_MS = 30;
const DERIVE_TOTAL_BUDGET_MS = 150;

export function dispatchStateDir(root) {
  return join(root, '.sterling', 'transient', 'dispatch-state');
}

function dispatchStateFile(root, key) {
  return join(dispatchStateDir(root), `${key}.json`);
}

export function dispatchStateKey(toolUseId) {
  if (typeof toolUseId === 'string' && TOOL_USE_ID_SHAPE_RE.test(toolUseId)) return `raw-${toolUseId}`;
  return `sha256-${createHash('sha256').update(String(toolUseId ?? '')).digest('hex')}`;
}

// dispatchState(record) — DERIVED, never stored: the record's own fields are
// the only truth: terminal beats started beats a binding beats pending.
export function dispatchState(record) {
  if (record?.terminal) return 'terminal';
  if (record?.started) return 'started';
  if (record?.post_binding || record?.derived_binding) return 'bound';
  return 'pending';
}

function promptFacts(rawPrompt) {
  const isString = typeof rawPrompt === 'string';
  const source = isString ? rawPrompt : '';
  const prompt_bytes = Buffer.byteLength(source, 'utf8');
  const prompt_sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  const oversize = prompt_bytes > MAX_PROMPT_BYTES;
  return { prompt: isString && !oversize ? rawPrompt : null, prompt_bytes, prompt_sha256, ...(oversize ? { oversize: true } : {}) };
}

function stringField(v) {
  return typeof v === 'string' ? v : null;
}

// SHAPE VALIDATORS for the four sub-objects a record may carry (Codex review
// X2): a PRESENT-but-malformed one is POISON, never silently accepted as
// though it were a genuine binding/started/terminal marker — a forged or
// truncated field must never be read back as "bound" by dispatchState().
function isNonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function validatePostBinding(v) {
  return v === undefined || (isPlainObject(v) && isNonEmptyString(v.agent_id) && isNonEmptyString(v.at));
}
function validateDerivedBinding(v) {
  return v === undefined || (isPlainObject(v) && isNonEmptyString(v.agent_id) && isNonEmptyString(v.at) && isNonEmptyString(v.by));
}
function validateStarted(v) {
  return (
    v === undefined ||
    (isPlainObject(v) && isNonEmptyString(v.agent_id) && isNonEmptyString(v.at) && Array.isArray(v.by) && v.by.every((x) => typeof x === 'string'))
  );
}
function validateTerminal(v) {
  return v === undefined || (isPlainObject(v) && isNonEmptyString(v.at) && isNonEmptyString(v.reason));
}

function validateRecordShape(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, reason: 'not-an-object' };
  if (r.schema !== 1) return { ok: false, reason: 'unknown-schema-version' };
  if (typeof r.tool_use_id !== 'string' || !r.tool_use_id) return { ok: false, reason: 'tool_use_id' };
  if (typeof r.session_id !== 'string' && r.session_id !== null) return { ok: false, reason: 'session_id' };
  if (!ORIGINS.has(r.origin)) return { ok: false, reason: 'origin' };
  if (typeof r.prompt_bytes !== 'number') return { ok: false, reason: 'prompt_bytes' };
  if (typeof r.prompt_sha256 !== 'string') return { ok: false, reason: 'prompt_sha256' };
  if (typeof r.prompt === 'string') {
    const bytes = Buffer.byteLength(r.prompt, 'utf8');
    const sha = createHash('sha256').update(r.prompt, 'utf8').digest('hex');
    if (bytes !== r.prompt_bytes || sha !== r.prompt_sha256) return { ok: false, reason: 'prompt-hash-mismatch' };
  } else if (r.prompt !== null) {
    return { ok: false, reason: 'prompt-type' };
  }
  if (!validatePostBinding(r.post_binding)) return { ok: false, reason: 'post_binding-shape' };
  if (!validateDerivedBinding(r.derived_binding)) return { ok: false, reason: 'derived_binding-shape' };
  if (!validateStarted(r.started)) return { ok: false, reason: 'started-shape' };
  if (!validateTerminal(r.terminal)) return { ok: false, reason: 'terminal-shape' };
  return { ok: true };
}

// classifyRecordFile — ONE classifier for a single on-disk candidate, shared
// by the directory-wide reader and every single-key lookup below. lstat
// (never stat) so a symlink is caught before it is ever opened.
function classifyRecordFile(file) {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return { exists: false };
  }
  if (st.isSymbolicLink()) return { exists: true, poisoned: true, reason: 'symlink' };
  if (!st.isFile()) return { exists: true, poisoned: true, reason: 'non-regular-file' };
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return { exists: true, poisoned: true, reason: 'unreadable' };
  }
  const text = buf.toString('utf8');
  // Invalid-UTF-8 detection: Buffer#toString silently substitutes U+FFFD for
  // bad sequences rather than throwing, so a round-trip re-encode is the only
  // way to catch it — a byte-identical round-trip proves the bytes WERE valid
  // UTF-8 in the first place.
  if (!Buffer.from(text, 'utf8').equals(buf)) return { exists: true, poisoned: true, reason: 'invalid-utf8' };
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { exists: true, poisoned: true, reason: 'unparseable-json' };
  }
  const v = validateRecordShape(record);
  if (!v.ok) return { exists: true, poisoned: true, reason: v.reason };
  return { exists: true, poisoned: false, record };
}

// SHARED CONTAINMENT CHECK (S2/X1, security + Codex review): a planted
// SYMLINK at dispatch-state/ would let writeRecordAtomic's mkdirSync+write
// escape .sterling/transient entirely while a reader lstat-ing the SAME path
// independently reaches a different conclusion — ONE function, used by
// writeRecordAtomic, readDispatchState AND the sweep, so all three agree.
// `create` distinguishes the WRITE path (absent -> create the directory) from
// the READ paths (absent must stay a legitimate, non-mutating 'absent' state
// — a reader must never conjure the directory into existence by looking at
// it, per the frozen 'absent' pins).
function checkDispatchStateContainment(root, { create }) {
  const dir = dispatchStateDir(root);
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if (e?.code !== 'ENOENT') return { ok: false, availability: 'unavailable' };
    if (!create) return { ok: true, availability: 'absent' };
    mkdirSync(dir, { recursive: true });
    return { ok: true, availability: 'ok' };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { ok: false, availability: 'poisoned', reason: st.isSymbolicLink() ? 'symlink' : 'non-regular-file' };
  }
  return { ok: true, availability: 'ok' };
}

function writeRecordAtomic(root, key, record) {
  const dir = dispatchStateDir(root);
  const containment = checkDispatchStateContainment(root, { create: true });
  if (!containment.ok) {
    throw refusal(
      'dispatch_state_poisoned',
      { dir, reason: containment.reason ?? containment.availability },
      `dispatch-state write refused — ${dir} is ${containment.reason === 'symlink' ? 'a SYMLINK' : 'not a real directory'}, never mkdir'd or written through`
    );
  }
  const file = dispatchStateFile(root, key);
  // S3 (security review): the tmp write is EXCLUSIVE ('wx') — a default 'w'
  // would follow a pre-planted symlink at the tmp name and apply the mode to
  // whatever it points at rather than a fresh file this process owns.
  const tmp = join(dir, `${key}.json.tmp-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, file);
}

// readDispatchState(root) — never throws. 'absent' only for ENOENT on the
// directory itself; any other listing failure, OR the directory itself being
// a symlink/non-directory (S2/X1), is 'unavailable'. Every individually
// poisoned entry is reported, never silently skipped and never condemning the
// readable remainder (mirrors readRegister's own posture).
export function readDispatchState(root) {
  const dir = dispatchStateDir(root);
  const containment = checkDispatchStateContainment(root, { create: false });
  if (!containment.ok) return { availability: 'unavailable', records: [], poisoned: [] };
  if (containment.availability === 'absent') return { availability: 'absent', records: [], poisoned: [] };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { availability: 'unavailable', records: [], poisoned: [] };
  }
  const records = [];
  const poisoned = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      if (name.includes('.json.tmp-')) poisoned.push({ file: name, reason: 'orphan-tmp-file' });
      continue;
    }
    const key = name.slice(0, -'.json'.length);
    const classified = classifyRecordFile(join(dir, name));
    if (!classified.exists) continue; // vanished between readdir and lstat — not poison, just gone
    if (classified.poisoned) {
      poisoned.push({ file: name, reason: classified.reason });
      continue;
    }
    // READER KEY CORRESPONDENCE (X5, Codex review): a record whose OWN
    // tool_use_id does not derive the filename it is stored under is not live
    // state — it is a planted/misfiled record (e.g. a raw-victim.json body
    // carrying a different tool_use_id) and must never be read back as though
    // the filesystem name and the content agree.
    if (dispatchStateKey(classified.record.tool_use_id) !== key) {
      poisoned.push({ file: name, reason: 'key-mismatch' });
      continue;
    }
    records.push({ key, file: name, record: classified.record });
  }
  return { availability: 'ok', records, poisoned };
}

function hasRegisterRound(root, sessionId, agentId) {
  const { availability, entries } = readRegister(root);
  if (availability !== 'ok') return false;
  return entries.some((e) => e && e.agent_id === agentId && e.session_id === sessionId);
}

function appendStartedBy(record, consumer) {
  const prior = record.started;
  const by = Array.isArray(prior?.by) ? [...prior.by] : [];
  if (consumer && !by.includes(consumer)) by.push(consumer);
  return { ...record, started: { agent_id: prior?.agent_id ?? record.post_binding?.agent_id ?? record.derived_binding?.agent_id, at: prior?.at ?? new Date().toISOString(), by } };
}

function buildResolution(source, caseName, record) {
  return {
    source,
    case: caseName,
    prompt: typeof record?.prompt === 'string' ? record.prompt : null,
    subagent_type: record?.subagent_type ?? null,
    tool_use_id: record?.tool_use_id ?? null,
    record: record ?? null,
  };
}

function unattributable(caseName, agentType, extra = {}) {
  return { source: 'unattributable', case: caseName, prompt: null, subagent_type: agentType ?? null, tool_use_id: null, record: null, ...extra };
}

// ---------------------------------------------------------------------------
// recordDispatchPre / recordDispatchPost / recordDispatchFailure — §2. Every
// disclosure is rendered through review-errors so the `[code]` token a hook
// prints on stderr is always drawn from the closed CODES set.
// ---------------------------------------------------------------------------

// catchContainmentRefusal — the SAME wrapper for recordDispatchPre/Post/
// Failure: writeRecordAtomic THROWS a 'dispatch_state_poisoned' refusal when
// the shared containment check refuses (S2/X1) — these three exported
// functions are a return-a-result API, not a throw-on-refusal one, so the
// throw is caught here and converted to the SAME {ok:false, disclosures}
// shape every other refusal in this module already returns.
function catchContainmentRefusal(fn) {
  try {
    return fn();
  } catch (e) {
    if (e?.code === 'dispatch_state_poisoned') {
      return { ok: false, action: 'poisoned-dir', disclosures: [render(e)] };
    }
    throw e;
  }
}

export function recordDispatchPre(root, stdin) {
  return withRegisterLock(root, () => catchContainmentRefusal(() => {
    const toolUseId = stdin?.tool_use_id;
    if (typeof toolUseId !== 'string' || toolUseId === '') {
      return {
        ok: true,
        action: 'skipped-no-tool-use-id',
        disclosures: [render(disclosure('dispatch_unattributable', { tool_use_id: toolUseId }, `Pre carried no usable tool_use_id ${JSON.stringify(toolUseId)} — nothing was written`))],
      };
    }
    const key = dispatchStateKey(toolUseId);
    const existing = classifyRecordFile(dispatchStateFile(root, key));
    if (existing.exists && existing.poisoned) {
      return {
        ok: false,
        action: 'poisoned',
        disclosures: [render(disclosure('dispatch_state_poisoned', { tool_use_id: toolUseId, reason: existing.reason }, `Pre for tool_use_id '${toolUseId}' found a poisoned dispatch-state record (${existing.reason}) — left untouched`))],
      };
    }

    const { prompt, prompt_bytes, prompt_sha256, oversize } = promptFacts(stdin?.tool_input?.prompt);
    const subagent_type = stringField(stdin?.tool_input?.subagent_type);
    const description = stringField(stdin?.tool_input?.description);
    const session_id = stringField(stdin?.session_id);
    const prompt_id = stringField(stdin?.prompt_id);

    if (!existing.exists) {
      const record = {
        schema: 1,
        tool_use_id: toolUseId,
        session_id,
        prompt_id,
        subagent_type,
        description,
        prompt,
        prompt_bytes,
        prompt_sha256,
        ...(oversize ? { oversize: true } : {}),
        origin: 'pre',
        pre_at: new Date().toISOString(),
      };
      writeRecordAtomic(root, key, record);
      return { ok: true, action: 'created-pending', disclosures: [], record };
    }

    const r = existing.record;
    if (r.terminal) {
      // ABSORBING: fill MISSING Pre fields only, never overwrite what is there.
      const filled = { ...r };
      let changed = false;
      for (const [field, value] of [
        ['pre_at', new Date().toISOString()],
        ['session_id', session_id],
        ['prompt_id', prompt_id],
        ['subagent_type', subagent_type],
        ['description', description],
      ]) {
        if (filled[field] === undefined || filled[field] === null) {
          filled[field] = value;
          changed = true;
        }
      }
      if (changed) writeRecordAtomic(root, key, filled);
      return { ok: true, action: 'terminal-absorbed', disclosures: [], record: filled };
    }

    const identical = r.session_id === session_id && r.prompt_sha256 === prompt_sha256 && r.subagent_type === subagent_type && r.description === description;
    if (identical) {
      return { ok: true, action: 'idempotent', disclosures: [], record: r };
    }
    return {
      ok: false,
      action: 'collision',
      disclosures: [render(disclosure('dispatch_state_collision', { tool_use_id: toolUseId }, `Pre for tool_use_id '${toolUseId}' disagrees with the existing dispatch-state record — never overwritten`))],
      record: r,
    };
  }));
}

export function recordDispatchPost(root, stdin) {
  return withRegisterLock(root, () => catchContainmentRefusal(() => {
    const toolUseId = stdin?.tool_use_id;
    const tr = stdin?.tool_response;
    if (!tr || typeof tr !== 'object' || Array.isArray(tr) || typeof tr.agentId !== 'string' || tr.agentId === '') {
      return { ok: true, action: 'skipped-no-agent-id', disclosures: [] };
    }
    const agentId = tr.agentId;
    if (typeof toolUseId !== 'string' || toolUseId === '' || !AGENT_ID_SHAPE_RE.test(agentId)) {
      return {
        ok: false,
        action: 'refused-shape',
        disclosures: [render(disclosure('dispatch_post_refused', { tool_use_id: toolUseId, agent_id: agentId }, `Post for tool_use_id ${JSON.stringify(toolUseId)} / agentId ${JSON.stringify(agentId)} has an unusable shape — not bound`))],
      };
    }

    // POST FAIL-CLOSED ON THE PROMPT (X4, Codex review): binding requires
    // tool_response.prompt to be a STRING equal to tool_input.prompt — a bare
    // `===` over two `undefined`s is TRUE, which would read a MISSING
    // tool_response.prompt as agreement and bind on a comparison that
    // verified nothing. A genuine disagreement (both present, unequal) and an
    // unverifiable one (either side absent/non-string) both refuse; derivation
    // can still resolve this dispatch either way.
    const inputPrompt = stdin?.tool_input?.prompt;
    const responsePrompt = tr.prompt;
    if (typeof responsePrompt !== 'string' || typeof inputPrompt !== 'string' || responsePrompt !== inputPrompt) {
      return {
        ok: false,
        action: 'refused-prompt-mismatch',
        disclosures: [render(disclosure('dispatch_post_refused', { tool_use_id: toolUseId, agent_id: agentId }, `Post for tool_use_id '${toolUseId}' does not carry a tool_response.prompt verified equal to tool_input.prompt — refusing to bind agentId '${agentId}'; derivation may still resolve this dispatch`))],
      };
    }

    const key = dispatchStateKey(toolUseId);
    const existing = classifyRecordFile(dispatchStateFile(root, key));
    if (existing.exists && existing.poisoned) {
      return {
        ok: false,
        action: 'poisoned',
        disclosures: [render(disclosure('dispatch_state_poisoned', { tool_use_id: toolUseId, reason: existing.reason }, `Post for tool_use_id '${toolUseId}' found a poisoned dispatch-state record (${existing.reason}) — not bound`))],
      };
    }

    // POST FAIL-CLOSED ON THE SESSION (X4): a binding that cannot be
    // session-scoped is not a binding — a missing stdin.session_id refuses
    // exactly like a mismatched one (DS-PO07) rather than reading "absent" as
    // "no conflict found".
    const sessionId = stringField(stdin?.session_id);
    if (typeof sessionId !== 'string' || sessionId === '') {
      return {
        ok: false,
        action: 'refused-no-session-id',
        disclosures: [render(disclosure('dispatch_post_refused', { tool_use_id: toolUseId, agent_id: agentId }, `Post for tool_use_id '${toolUseId}' carries no usable session_id — refusing to bind agentId '${agentId}'`))],
      };
    }

    // ONE-TO-ONE (C1/X4): an agentId already bound elsewhere refuses a second
    // binding — but scoped to LIVE, SAME-SESSION records only (a 7-day
    // tombstone or a foreign-session record sharing the agent id is not a
    // real conflict — an agent id is legitimately reused across rounds, A4).
    // An unreadable directory OR any poisoned entry fails the WHOLE check
    // CLOSED: an unvalidatable record may itself be the real conflict.
    // 'absent' is the ORDINARY empty-directory shape (nothing written yet —
    // trivially no conflict) and must NOT fail closed; only a genuinely
    // UNREADABLE directory ('unavailable') or an 'ok' scan carrying poisoned
    // entries makes the one-to-one check untrustworthy.
    const scan = readDispatchState(root);
    if (scan.availability === 'unavailable' || (scan.availability === 'ok' && scan.poisoned.length > 0)) {
      return {
        ok: false,
        action: 'refused-poisoned-scan',
        disclosures: [render(disclosure('dispatch_state_poisoned', { tool_use_id: toolUseId, availability: scan.availability, poisoned: scan.poisoned.length }, `Post for tool_use_id '${toolUseId}' refused to bind — the dispatch-state scan is ${scan.availability !== 'ok' ? scan.availability : `carrying ${scan.poisoned.length} poisoned entr${scan.poisoned.length === 1 ? 'y' : 'ies'}`}, so the one-to-one check cannot be trusted`))],
      };
    }
    for (const { key: otherKey, record: other } of scan.records) {
      if (otherKey === key) continue;
      if (other.terminal) continue; // a finished round never holds an agent id hostage
      if (other.session_id !== sessionId) continue; // a foreign session is a different world
      const boundAgent = other.post_binding?.agent_id ?? other.derived_binding?.agent_id ?? other.started?.agent_id;
      if (boundAgent === agentId) {
        return {
          ok: false,
          action: 'refused-one-to-one',
          disclosures: [render(disclosure('dispatch_post_refused', { tool_use_id: toolUseId, agent_id: agentId, other_key: otherKey }, `Post agentId '${agentId}' is already bound on another LIVE, same-session dispatch-state record (${otherKey}) — refusing a second binding`))],
        };
      }
    }

    if (!existing.exists) {
      const { prompt, prompt_bytes, prompt_sha256, oversize } = promptFacts(typeof responsePrompt === 'string' ? responsePrompt : inputPrompt);
      const subagent_type = stringField(stdin?.tool_input?.subagent_type);
      const description = stringField(stdin?.tool_input?.description) ?? stringField(tr.description);
      const record = {
        schema: 1,
        tool_use_id: toolUseId,
        session_id: sessionId,
        prompt_id: stringField(stdin?.prompt_id),
        subagent_type,
        description,
        prompt,
        prompt_bytes,
        prompt_sha256,
        ...(oversize ? { oversize: true } : {}),
        origin: 'post-only',
        post_binding: { agent_id: agentId, at: new Date().toISOString() },
      };
      writeRecordAtomic(root, key, record);
      return {
        ok: true,
        action: 'created-post-only',
        disclosures: [
          render(
            disclosure(
              'dispatch_post_only',
              { tool_use_id: toolUseId, agent_id: agentId },
              `Post for tool_use_id '${toolUseId}' created a NEW dispatch-state record (origin 'post-only') — no Pre had been recorded for it; stronger evidence is never refused for weaker evidence's absence`
            )
          ),
        ],
        record,
      };
    }

    const r = existing.record;
    if (r.terminal) {
      return {
        ok: true,
        action: 'late-post-noop',
        disclosures: [render(disclosure('dispatch_post_late', { tool_use_id: toolUseId, agent_id: agentId }, `Post for tool_use_id '${toolUseId}' arrived after this record went terminal (${r.terminal.reason}) — no-op`))],
      };
    }
    if (r.session_id !== null && sessionId !== null && r.session_id !== sessionId) {
      // S1 (security review): a terminal write ALWAYS nulls prompt — a
      // post-collision tombstone is still a terminal record, and a 5-20 KB
      // prompt otherwise sits on disk for up to 7 days across sessions.
      const updated = { ...r, prompt: null, terminal: { at: new Date().toISOString(), reason: 'post-collision' } };
      writeRecordAtomic(root, key, updated);
      return {
        ok: false,
        action: 'post-collision-terminal',
        disclosures: [render(disclosure('dispatch_post_mismatch', { tool_use_id: toolUseId, pre_session_id: r.session_id, post_session_id: sessionId }, `Post for tool_use_id '${toolUseId}' carries session_id '${sessionId}', disagreeing with the Pre record's '${r.session_id}' — recorded terminal (post-collision), no binding`))],
        record: updated,
      };
    }

    const at = new Date().toISOString();
    if (!r.started) {
      const updated = { ...r, post_binding: { agent_id: agentId, at } };
      writeRecordAtomic(root, key, updated);
      return { ok: true, action: 'post-bound', disclosures: [], record: updated };
    }
    if (r.started.agent_id === agentId) {
      const updated = { ...r, post_binding: { agent_id: agentId, at, confirmed_derived: true } };
      writeRecordAtomic(root, key, updated);
      return { ok: true, action: 'post-confirmed-derived', disclosures: [], record: updated };
    }
    const updated = {
      ...r,
      post_binding: { agent_id: agentId, at },
      derived_post_mismatch: { derived_agent_id: r.started.agent_id, post_agent_id: agentId, at },
    };
    writeRecordAtomic(root, key, updated);
    return {
      ok: true,
      action: 'post-mismatch-recorded',
      disclosures: [
        render(
          disclosure(
            'dispatch_post_mismatch',
            { tool_use_id: toolUseId, derived_agent_id: r.started.agent_id, post_agent_id: agentId },
            `Post for tool_use_id '${toolUseId}' binds agentId '${agentId}', but this dispatch was already derived-started as '${r.started.agent_id}' — the derived starter may have staged the wrong knowledge; post_binding is now authoritative for later consumers, started is left untouched`
          )
        ),
      ],
      record: updated,
    };
  }));
}

export function recordDispatchFailure(root, stdin) {
  return withRegisterLock(root, () => catchContainmentRefusal(() => {
    const toolUseId = stdin?.tool_use_id;
    if (typeof toolUseId !== 'string' || toolUseId === '') {
      return { ok: true, action: 'skipped-no-tool-use-id', disclosures: [] };
    }
    const key = dispatchStateKey(toolUseId);
    const existing = classifyRecordFile(dispatchStateFile(root, key));
    const at = new Date().toISOString();
    if (existing.exists && existing.poisoned) {
      return {
        ok: false,
        action: 'poisoned',
        disclosures: [render(disclosure('dispatch_state_poisoned', { tool_use_id: toolUseId, reason: existing.reason }, `Failure for tool_use_id '${toolUseId}' found a poisoned dispatch-state record (${existing.reason}) — left untouched`))],
      };
    }
    if (!existing.exists) {
      // S1: a Failure record is BORN terminal — prompt is never carried on it
      // at all, even though prompt_bytes/prompt_sha256 (computed against the
      // real prompt) are kept, same as the oversize shape.
      const { prompt_bytes, prompt_sha256, oversize } = promptFacts(stdin?.tool_input?.prompt);
      const record = {
        schema: 1,
        tool_use_id: toolUseId,
        session_id: stringField(stdin?.session_id),
        prompt_id: stringField(stdin?.prompt_id),
        subagent_type: stringField(stdin?.tool_input?.subagent_type),
        description: stringField(stdin?.tool_input?.description),
        prompt: null,
        prompt_bytes,
        prompt_sha256,
        ...(oversize ? { oversize: true } : {}),
        origin: 'failure-only',
        terminal: { at, reason: 'tool-failure' },
      };
      writeRecordAtomic(root, key, record);
      return { ok: true, action: 'created-terminal', disclosures: [], record };
    }
    const r = existing.record;
    if (r.terminal) {
      return { ok: true, action: 'already-terminal', disclosures: [], record: r };
    }
    // S1: terminalizing an existing record ALSO nulls its prompt.
    const updated = { ...r, prompt: null, terminal: { at, reason: 'tool-failure' } };
    writeRecordAtomic(root, key, updated);
    return { ok: true, action: 'terminated', disclosures: [], record: updated };
  }));
}

// ---------------------------------------------------------------------------
// resolveDispatchStart — §5. Locked in-order resolution: own binding, resume
// guard, then bounded derivation. Never holds the lock while sleeping.
// ---------------------------------------------------------------------------

function attemptDetermine(root, { session_id, agent_id, agent_type, consumer }) {
  // AN UNUSABLE agent_id IS ITS OWN FAIL-CLOSED CASE (X2, Codex review),
  // checked FIRST and BEFORE any read: a derivation committed for a
  // non-string/empty agent_id would mint a binding nobody can ever match,
  // permanently burning a real dispatch's slot. Mutates nothing.
  if (typeof agent_id !== 'string' || agent_id === '') {
    return { verdict: 'resolved', value: unattributable('no-agent-id', agent_type) };
  }

  const scan = readDispatchState(root);

  if (scan.availability === 'ok') {
    for (const { key, record } of scan.records) {
      const boundId = record.post_binding?.agent_id ?? record.derived_binding?.agent_id;
      // SESSION-SCOPED (X3, Codex review): a non-terminal record's binding is
      // MY OWN only within MY OWN session — a foreign-session record naming my
      // agent_id (a session that crashed before its own sweep) is resume
      // evidence, never a hit, or a dead session's brief becomes permanent via
      // H19's delivery guard.
      if (boundId === agent_id && record.session_id === session_id && !record.terminal) {
        const updated = appendStartedBy(record, consumer);
        writeRecordAtomic(root, key, updated);
        const source = record.post_binding ? 'post' : 'derived-type-unique';
        return { verdict: 'resolved', value: buildResolution(source, source, updated) };
      }
    }
  }

  const resumeHit =
    scan.availability === 'ok' &&
    scan.records.some(
      ({ record }) => record.started?.agent_id === agent_id || record.post_binding?.agent_id === agent_id || record.derived_binding?.agent_id === agent_id
    );
  if (resumeHit || hasRegisterRound(root, session_id, agent_id)) {
    return { verdict: 'resolved', value: { source: 'resume', case: 'resume', prompt: null, subagent_type: agent_type ?? null, tool_use_id: null, record: null } };
  }

  // agent_type MISSING on Start -> no derivation is even attempted (§6):
  // checked before availability/poisoned, since the absence of a type makes
  // derivation moot regardless of whether the state directory can be read. A
  // post_binding/derived_binding/resume match above still resolves first.
  if (typeof agent_type !== 'string' || agent_type === '') {
    return { verdict: 'resolved', value: unattributable('no-agent-type', agent_type) };
  }

  // Directory PRESENT BUT UNLISTABLE is 'state-unavailable' (§6); a genuinely
  // ABSENT directory is the ORDINARY empty-candidate-set shape and falls
  // through to the candidate count below, which correctly yields 'no-slot'
  // for an empty (or absent) record set.
  if (scan.availability === 'unavailable') {
    return { verdict: 'resolved', value: unattributable('state-unavailable', agent_type) };
  }
  if (scan.poisoned.length > 0) {
    return { verdict: 'resolved', value: unattributable('state-poisoned', agent_type) };
  }

  // STRICT STRING EQUALITY ON BOTH SIDES: a pending record whose subagent_type
  // is missing/non-string is NEVER a derivation candidate for any agent_type —
  // requiring typeof 'string' on the RECORD side (agent_type is already proven
  // a non-empty string by the check above) closes the case where two non-
  // string values would otherwise compare equal under a bare `===`.
  const candidates = scan.records.filter(
    ({ record }) =>
      dispatchState(record) === 'pending' &&
      record.session_id === session_id &&
      typeof record.subagent_type === 'string' &&
      record.subagent_type === agent_type
  );
  if (candidates.length === 0) {
    return { verdict: 'resolved', value: unattributable('no-slot', agent_type) };
  }
  if (candidates.length === 1) {
    const { key, record } = candidates[0];
    if (record.post_binding) {
      // Became bound within this same scan snapshot — never overwrite it.
      return { verdict: 'resolved', value: buildResolution('post', 'post', record) };
    }
    const at = new Date().toISOString();
    const updated = { ...record, derived_binding: { agent_id, at, by: consumer }, started: { agent_id, at, by: consumer ? [consumer] : [] } };
    writeRecordAtomic(root, key, updated);
    return { verdict: 'resolved', value: buildResolution('derived-type-unique', 'derived-type-unique', updated) };
  }
  return { verdict: 'siblings-retry', count: candidates.length };
}

export async function resolveDispatchStart(root, { session_id, agent_id, agent_type }, opts = {}) {
  const consumer = opts.consumer;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepAsync;

  async function tryLocked(timeoutMs, retryMs) {
    try {
      return await withRegisterLock(root, () => attemptDetermine(root, { session_id, agent_id, agent_type, consumer }), { retryMs, timeoutMs });
    } catch (e) {
      if (e?.code === 'register_lock_held') return { verdict: 'lock-held' };
      throw e;
    }
  }

  // Initial determination: the module's ordinary lock posture, OVERRIDABLE
  // (C4, correctness review) via opts.lockTimeoutMs/opts.retryMs — defaulting
  // to today's values so every existing caller is unaffected. Most calls
  // resolve here (own binding / resume / unambiguous derivation / no-slot).
  const initialTimeoutMs = typeof opts.lockTimeoutMs === 'number' ? opts.lockTimeoutMs : 1000;
  const initialRetryMs = typeof opts.retryMs === 'number' ? opts.retryMs : 50;
  let result = await tryLocked(initialTimeoutMs, initialRetryMs);
  if (result.verdict === 'lock-held') {
    return unattributable('lock-held', agent_type);
  }
  if (result.verdict === 'resolved') return result.value;

  // AMBIGUOUS (two-or-more same-type pending): bounded retry with a SHORT
  // per-attempt lock budget, sleeping only OUTSIDE the lock.
  const retryStart = now();
  for (;;) {
    if (now() - retryStart >= DERIVE_TOTAL_BUDGET_MS) {
      return unattributable('same-type-siblings-in-flight', agent_type, { count: result.count });
    }
    await sleep(DERIVE_RETRY_INTERVAL_MS);
    result = await tryLocked(DERIVE_PER_ATTEMPT_LOCK_MS, 5);
    if (result.verdict === 'resolved') return result.value;
    // 'lock-held' or still 'siblings-retry' — keep trying within the total budget.
  }
}

// ---------------------------------------------------------------------------
// resolveAndRegisterStart / finishDispatchAndRegisterEnd — the composite H22
// operations. §5/§4(a).
// ---------------------------------------------------------------------------

export async function resolveAndRegisterStart(root, startStdin, entryBuilder) {
  const { session_id, agent_id, agent_type } = startStdin;
  const consumer = 'h22';

  // ONE LOCK HOLD per attempt (C3, correctness review): resolve AND (when
  // resolved) register, fused into the SAME withRegisterLock callback — the
  // decision's "resolve -> write bind/started FIRST -> registerStart second"
  // ordering survives inside that one hold. withRegisterLock is NOT
  // reentrant, so the prior shape (resolveDispatchStart's own hold, released,
  // then a SEPARATE registerStart hold) was two acquisitions where the header
  // promised one.
  async function attemptAndRegister(timeoutMs, retryMs) {
    try {
      return await withRegisterLock(
        root,
        () => {
          const determined = attemptDetermine(root, { session_id, agent_id, agent_type, consumer });
          if (determined.verdict !== 'resolved') return determined;
          try {
            const entry = registerStartLocked(root, entryBuilder(determined.value));
            return { verdict: 'resolved', resolution: determined.value, entry };
          } catch (e) {
            if (e?.kind === 'refusal') return { verdict: 'resolved', resolution: determined.value, entry: null, refusal: e };
            throw e;
          }
        },
        { retryMs, timeoutMs }
      );
    } catch (e) {
      if (e?.code === 'register_lock_held') return { verdict: 'lock-held' };
      throw e;
    }
  }

  // A resolution that never got to register INSIDE its own determining hold
  // (the lock was never obtained, or the retry budget expired unresolved)
  // still needs its register entry written — one MORE hold is unavoidable
  // here, since no successful determination hold exists to piggyback on.
  async function finalizeUnattributable(resolution) {
    try {
      const entry = await registerStart(root, entryBuilder(resolution));
      return { resolution, entry };
    } catch (e) {
      if (e?.kind === 'refusal') return { resolution, entry: null, refusal: e };
      throw e;
    }
  }

  const asResult = (result) => ({ resolution: result.resolution, entry: result.entry ?? null, ...(result.refusal ? { refusal: result.refusal } : {}) });

  let result = await attemptAndRegister(1000, 50);
  if (result.verdict === 'resolved') return asResult(result);
  if (result.verdict === 'lock-held') {
    return finalizeUnattributable(unattributable('lock-held', agent_type));
  }

  const retryStart = Date.now();
  for (;;) {
    if (Date.now() - retryStart >= DERIVE_TOTAL_BUDGET_MS) {
      return finalizeUnattributable(unattributable('same-type-siblings-in-flight', agent_type, { count: result.count }));
    }
    await sleepAsync(DERIVE_RETRY_INTERVAL_MS);
    result = await attemptAndRegister(DERIVE_PER_ATTEMPT_LOCK_MS, 5);
    if (result.verdict === 'resolved') return asResult(result);
    // 'lock-held' or still 'siblings-retry' — keep trying within the total budget.
  }
}

export async function finishDispatchAndRegisterEnd(root, { session_id, agent_id, sidecarToolUseId, event }) {
  // ONE LOCK HOLD (C3): registerEnd (write 1) then the state-file terminalize
  // (write 2) inside the SAME withRegisterLock callback — the write ORDER is
  // unchanged (a crash between them leaves an ended round and a still-live
  // state record, which is harmless; the reverse would defer duties for a
  // dead agent).
  return withRegisterLock(root, () => {
    const ended = registerEndLocked(root, agent_id, event ?? 'subagent-stop', { sessionId: session_id });
    const scan = readDispatchState(root);
    let record = null;
    if (scan.availability === 'ok') {
      // C2, correctness review: prefer a NON-terminal record carrying the
      // agent_id (bound/started) over any terminal tombstone naming it — a
      // find() over readdir order would otherwise happily return a 7-day-old
      // tombstone as "the hit" while a live started record sits beside it.
      // The PAIR (session_id, agent_id), the same key registerEndLocked
      // selects the round by: an agent_id match alone could terminalize
      // another session's live record.
      let hit = scan.records.find(({ record: r }) => {
        const boundId = r.post_binding?.agent_id ?? r.derived_binding?.agent_id ?? r.started?.agent_id;
        return boundId === agent_id && !r.terminal && (session_id === undefined || r.session_id === session_id);
      });
      if (!hit && typeof sidecarToolUseId === 'string' && sidecarToolUseId !== '') {
        const key = dispatchStateKey(sidecarToolUseId);
        hit = scan.records.find((x) => x.key === key);
      }
      if (hit) {
        if (hit.record.terminal) {
          record = hit.record;
        } else {
          const updated = { ...hit.record, prompt: null, terminal: { at: new Date().toISOString(), reason: event === 'task-stop' ? 'task-stop' : 'stop' } };
          writeRecordAtomic(root, hit.key, updated);
          record = updated;
        }
      }
    }
    return { found: ended.found, entry: ended.found ? ended.entry : null, record };
  });
}

// ---------------------------------------------------------------------------
// sessionBoundarySweep — §4(b). Called by H1 INSIDE its existing register
// lock hold; this function does NOT acquire a lock itself.
// ---------------------------------------------------------------------------

export function sessionBoundarySweep(root, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const dir = dispatchStateDir(root);
  // S2: the SAME shared containment check writeRecordAtomic/readDispatchState
  // use — a symlinked/non-directory dispatch-state/ refuses here exactly as
  // it does everywhere else, so the three consumers can never disagree.
  const containment = checkDispatchStateContainment(root, { create: false });
  if (!containment.ok) {
    return {
      terminated: 0,
      pruned: 0,
      refused: render(disclosure('dispatch_state_poisoned', { dir, reason: containment.reason }, `sessionBoundarySweep: ${dir} is ${containment.reason === 'symlink' ? 'a SYMLINK' : 'not a real directory'} — refusing to touch it, never following a symlink`)),
    };
  }
  if (containment.availability === 'absent') return { terminated: 0, pruned: 0 };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { terminated: 0, pruned: 0, refused: render(disclosure('dispatch_state_poisoned', { dir }, `sessionBoundarySweep: could not list ${dir} — left untouched`)) };
  }
  let terminated = 0;
  let pruned = 0;
  let refused;
  for (const name of names) {
    if (!name.endsWith('.json')) {
      // S4 (security review): an orphan `*.json.tmp-*` from a crashed write is
      // POISON to derivation forever (§6) until removed — REGULAR FILES only,
      // verified by lstat immediately before unlink, never through a symlink
      // (a symlink-named-like-a-tmp-orphan is a delete-anything primitive
      // otherwise). A symlink found under that name is NEVER removed — it is
      // REPORTED, so the condition is never a silent skip.
      if (name.includes('.json.tmp-')) {
        const tmpFile = join(dir, name);
        try {
          const ts = lstatSync(tmpFile);
          if (ts.isFile() && !ts.isSymbolicLink()) {
            rmSync(tmpFile, { force: true });
            pruned++;
          } else if (ts.isSymbolicLink()) {
            if (!refused) {
              refused = render(
                disclosure('dispatch_state_poisoned', { file: name }, `sessionBoundarySweep: '${name}' looks like an orphan tmp file but is a SYMLINK — left in place for an operator to see, never removed through`)
              );
            }
          }
        } catch {
          // best-effort — a failed removal costs only disk, never correctness
        }
      }
      continue;
    }
    const file = join(dir, name);
    const classified = classifyRecordFile(file);
    if (!classified.exists || classified.poisoned) continue; // a poisoned entry stays poisoned until a human looks
    const record = classified.record;
    const key = name.slice(0, -'.json'.length);
    if (!record.terminal) {
      const updated = { ...record, prompt: null, terminal: { at: new Date(now).toISOString(), reason: 'session-boundary' } };
      writeRecordAtomic(root, key, updated);
      terminated++;
      continue;
    }
    // S1: the boundary is the LAST CHANCE to drop a brief a terminal path
    // failed to null — an already-terminal record still carrying a prompt
    // (an older build, or a terminal path that forgot) is corrected in place,
    // WITHOUT re-stamping its terminal instant or reason.
    if (record.prompt !== null) {
      writeRecordAtomic(root, key, { ...record, prompt: null });
    }
    const terminalAt = Date.parse(record.terminal.at);
    if (!Number.isNaN(terminalAt) && now - terminalAt > SEVEN_DAYS_MS) {
      try {
        const s2 = lstatSync(file);
        if (s2.isFile() && !s2.isSymbolicLink()) {
          rmSync(file, { force: true });
          pruned++;
        }
      } catch {
        // best-effort prune — a failed removal costs only disk, never correctness
      }
    }
  }
  return { terminated, pruned, ...(refused ? { refused } : {}) };
}
