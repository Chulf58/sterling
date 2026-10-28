// Serialized launch admission for the multi-session window launcher (slice 6 of the multi-session toolkit, decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session; the draft invariant is finding 0ded033d).
//
// multi_session.max_sessions limits TOOLKIT launches only: sessions opened by hand are counted but never blocked
// (user-ruled 2026-10-28, 'Toolkit launches only'). A launch is admitted only while the number of occupied checkouts of
// the project, the new one included, stays at or below the ceiling.
//
// WHERE THE STATE LIVES. One reservation file per project, in the MAIN checkout (every session worktree of the project
// shares it): <main>/.sterling/transient/launch-reservations.json, guarded by the ticket lock of file-lock.mjs at
// <that file>.lock (never renamed or displaced, anti-pattern 5fc3e084). Nothing here touches .sterling/sterling.db.
//
// THE INVARIANT. Count, compare and reserve run in ONE locked section, and EVERY piece of evidence the count uses is read
// inside that section: `observe(reservations)` is the caller's fresh OpenCode API inventory and its fresh read of every
// tmux server that matters (the default one, the one this launch creates on, and every socket a reservation records).
// Nothing read before the lock is counted, so two launchers can never both see room for one more, and a session that
// started while a launcher waited for the lock is seen. A checkout counts as occupied when it is observed occupied (an
// OpenCode window on any of those servers, or a live conductor) or holds a counted reservation. Each reservation
// records the socket of the server its launch creates on. A launcher settles its reservation:
//   released  - nothing was created (a definite tmux rejection before any output): removed at once;
//   started   - the window was created and verified: counted until `observe` reports its window gone on ITS socket (no
//               session with that id on a server with that pid and start time), never merely because time passed;
//   uncertain - the creation may have started OpenCode (start_uncertain, started_unverified): counted for
//               UNCERTAIN_TTL_MS, or until the checkout is observed occupied, whichever comes first.
// A reservation counts in any state while the launcher that made it is alive (pid plus process start time on this
// host). One whose launcher died before it settled may have created a window: it counts until RESERVED_TTL_MS after it
// was made. Every locked section drops the reservations that no longer count.
//
// NOT GUARANTEED: a session opened by hand after the observation is not seen (hand-opened sessions are never blocked,
// so nothing could stop it anyway); an idle conductor in a plain terminal outside tmux, or a window on a tmux server no
// reservation names and that is not the default one, is not observable; locks across machines are not supported
// (file-lock.mjs). A reservation file that cannot be read, and an observation that fails, refuse the launch.
import { mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic-write.mjs';
import { pidIsAlive, procStartTime, withFileLock } from './file-lock.mjs';

export const RESERVATIONS_REL = '.sterling/transient/launch-reservations.json';
export const RESERVED_TTL_MS = 15 * 60_000;
export const UNCERTAIN_TTL_MS = 15 * 60_000;
// The locked section holds a fresh API inventory, which can take tens of seconds on a busy server (finding 0ded033d
// measured about 28 s); a waiter allows for a few holders before it gives up loudly.
export const ADMISSION_LOCK_WAIT_MS = 180_000;

export const reservationsPath = (mainRoot) => join(mainRoot, RESERVATIONS_REL);

/** The reservation file: { version: 1, reservations: [...] }; an absent file is empty, a malformed one throws. */
export function readReservations(mainRoot) {
  const path = reservationsPath(mainRoot);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { version: 1, reservations: [] };
    throw e;
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON; it is not known which launches are in flight, so no launch is admitted. Inspect it, and delete it only once no launch is running`);
  }
  const shaped = (r) => typeof r?.id === 'string' && typeof r.checkout === 'string' && (r.socket === null || typeof r.socket === 'string')
    && (r.state === 'started' ? r.expires_at === null && typeof r.socket === 'string' && typeof r.detail?.windowId === 'string' && typeof r.detail?.serverPid === 'string' && typeof r.detail?.serverStart === 'string'
      : ['reserved', 'uncertain'].includes(r.state) && Number.isFinite(r.expires_at));
  if (v?.version !== 1 || !Array.isArray(v.reservations) || !v.reservations.every(shaped)) {
    throw new Error(`${path} does not have the reservation shape; it is not known which launches are in flight, so no launch is admitted. Inspect it, and delete it only once no launch is running`);
  }
  return v;
}

function writeReservations(mainRoot, state) {
  const path = reservationsPath(mainRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** This process as a reservation holder. */
export function currentHolder({ pid = process.pid, startTimeOf = procStartTime } = {}) {
  return { pid, proc_start: startTimeOf(pid), hostname: hostname() };
}

function holderAlive(holder, { isAlive, startTimeOf }) {
  if (!holder || holder.hostname !== hostname() || !isAlive(holder.pid)) return false;
  if (holder.proc_start === null || holder.proc_start === undefined) return true;
  const cur = startTimeOf(holder.pid);
  return cur === null || cur === holder.proc_start;
}

const withLock = (mainRoot, fn, waitMs) => withFileLock(`${reservationsPath(mainRoot)}.lock`, fn, { waitMs });

/**
 * Admit one toolkit launch of `checkout` (a canonical folder) against `maxSessions`, to be created on the tmux server
 * at `socket`. `observe(reservations)` is called inside the locked section with the reservations on file and answers
 * { occupied: [{ checkout, kind: 'window' | 'conductor', detail }], gone: [reservation id] }: every checkout of the
 * project observed occupied right now, and the started reservations whose window it saw gone. It may throw to refuse
 * (an unreadable server, a live conductor of the target); nothing is written then. Returns { admitted: true, id, counted } or
 * { admitted: false, reason, why, counted }, where `counted` lists every occupied checkout with why it counts.
 * reasons: window_exists, conductor_live (the target is observed occupied), launch_in_progress (another launch holds a
 * reservation for it), ceiling_reached. dryRun evaluates the same and writes nothing.
 */
export async function admitLaunch(mainRoot, { checkout, socket = null, maxSessions, observe, dryRun = false, now = Date.now, holder = currentHolder(), isAlive = pidIsAlive, startTimeOf = procStartTime, waitMs = ADMISSION_LOCK_WAIT_MS }) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error(`max_sessions must be a whole number of at least 1, got ${JSON.stringify(maxSessions)}`);
  return withLock(mainRoot, async () => {
    const state = readReservations(mainRoot);
    const { occupied: observed, gone } = await observe(state.reservations);
    const t = now();
    const probe = { isAlive, startTimeOf };
    const occupiedNow = new Set(observed.map((o) => o.checkout));
    const goneNow = new Set(gone);
    const kept = state.reservations.filter((r) => {
      if (holderAlive(r.holder, probe)) return true;
      if (r.state === 'started') return !goneNow.has(r.id);
      return t < r.expires_at && !occupiedNow.has(r.checkout);
    });
    const counted = new Map();
    const note = (dir, why) => counted.set(dir, [...(counted.get(dir) ?? []), why]);
    for (const o of observed) note(o.checkout, o.kind === 'window' ? `tmux window ${o.detail}` : `live conductor ${o.detail}`);
    const until = (r) => (holderAlive(r.holder, probe) ? ` (launcher pid ${r.holder.pid} running)` : r.state === 'started' ? ` (until its window ${r.detail.windowId} on ${r.socket} is gone)` : ` (counted until ${new Date(r.expires_at).toISOString()})`);
    for (const r of kept) note(r.checkout, `${r.state} launch reservation ${r.id}${until(r)}`);
    const list = [...counted].map(([dir, why]) => ({ checkout: dir, why }));
    const refuse = (reason, why) => ({ admitted: false, reason, why, counted: list });
    const mine = observed.filter((o) => o.checkout === checkout);
    if (mine.some((o) => o.kind === 'window')) return refuse('window_exists', `${checkout} already has an OpenCode window: ${mine.map((o) => o.detail).join(', ')}`);
    if (mine.length > 0) return refuse('conductor_live', `${checkout} already has a live conductor: ${mine.map((o) => o.detail).join(', ')}`);
    const inFlight = kept.filter((r) => r.checkout === checkout);
    if (inFlight.length > 0) return refuse('launch_in_progress', `another launch of ${checkout} holds reservation ${inFlight.map((r) => `${r.id} (${r.state})`).join(', ')}; an uncertain one counts until it is seen or expires`);
    if (counted.size + 1 > maxSessions) {
      return refuse('ceiling_reached', `multi_session.max_sessions is ${maxSessions} and ${counted.size} checkout${counted.size === 1 ? ' is' : 's are'} occupied (${list.map((c) => `${c.checkout}: ${c.why.join('; ')}`).join(' | ')}); close a session or raise max_sessions`);
    }
    if (dryRun) return { admitted: true, id: null, counted: list };
    const id = `lr_${randomUUID()}`;
    kept.push({ id, checkout, socket, state: 'reserved', created_at: t, expires_at: t + RESERVED_TTL_MS, holder });
    writeReservations(mainRoot, { version: 1, reservations: kept });
    return { admitted: true, id, counted: list };
  }, waitMs);
}

/**
 * Settle reservation `id`: 'released' removes it; 'started' keeps it counted until its window is seen gone, and needs
 * `detail` { windowId, serverPid, serverStart }; 'uncertain' keeps it for UNCERTAIN_TTL_MS from now. A reservation that
 * is gone is written again (with `checkout` and `socket`), so a start is never lost to an early expiry.
 */
export async function settleLaunch(mainRoot, id, outcome, { checkout, socket, detail = {}, now = Date.now, holder = currentHolder(), waitMs = ADMISSION_LOCK_WAIT_MS } = {}) {
  if (!['released', 'started', 'uncertain'].includes(outcome)) throw new Error(`unknown launch outcome ${JSON.stringify(outcome)}`);
  return withLock(mainRoot, async () => {
    const state = readReservations(mainRoot);
    const t = now();
    const rest = state.reservations.filter((r) => r.id !== id);
    if (outcome !== 'released') {
      const prior = state.reservations.find((r) => r.id === id);
      const at = prior?.checkout ?? checkout;
      const on = prior?.socket ?? socket ?? null;
      if (typeof at !== 'string') throw new Error(`launch reservation ${id} is gone and no checkout was given to record it again`);
      if (outcome === 'started' && (typeof on !== 'string' || !['windowId', 'serverPid', 'serverStart'].every((k) => typeof detail[k] === 'string'))) {
        throw new Error(`launch reservation ${id} cannot be settled started without its socket, window id, server pid and server start time`);
      }
      // The launcher hands the reservation over: the holder is cleared so its liveness no longer extends it.
      rest.push({ ...(prior ?? { id, created_at: t }), checkout: at, socket: on, state: outcome, expires_at: outcome === 'started' ? null : t + UNCERTAIN_TTL_MS, holder: null, settled_at: t, detail, settled_by: holder });
    }
    writeReservations(mainRoot, { version: 1, reservations: rest });
  }, waitMs);
}
