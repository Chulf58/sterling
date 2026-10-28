// Serialized launch admission for the multi-session window launcher (slice 6 of the multi-session toolkit, decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session; the draft invariant is finding 0ded033d).
//
// multi_session.max_sessions limits TOOLKIT launches only: sessions opened by hand are counted but never blocked
// (user-ruled 2026-10-28, 'Toolkit launches only'). A launch is admitted only while the number of occupied checkouts of
// the project, the new one included, stays at or below the ceiling.
//
// WHERE THE STATE LIVES. One file per project, in the MAIN checkout (every session worktree of the project shares it):
// <main>/.sterling/transient/launch-reservations.json, guarded by the ticket lock of file-lock.mjs at <that file>.lock
// (never renamed or displaced, anti-pattern 5fc3e084). It holds two lists: the launch RESERVATIONS and the SOCKET
// REGISTRY. Nothing here touches .sterling/sterling.db.
//
// THE SOCKET REGISTRY is every tmux socket a launch of this project used or an observation found sessions on, with the
// server first seen there: its pid, its #{start_time} and its /proc start time. A socket file is not its server: a
// removed socket leaves the server and its windows running, and tmux recreates the socket on SIGUSR1 (anti-pattern
// aa3c5f4c). So a socket leaves the registry only when its recorded server is PROVEN ended (its pid is dead, or the pid
// now has another /proc start time) and no counted reservation names it. A registered socket that cannot be read, or
// that is answered by another server or by none, while its recorded server still runs, refuses every launch
// (`tmux_unreadable`, naming the socket); `forgetSocket` (open-session-window --forget-socket) is the only way to drop it.
//
// THE INVARIANT. Count, compare and reserve run in ONE locked section, and EVERY piece of evidence the count uses is read
// inside that section, under one deadline (OBSERVE_MS; past it the launch is refused and nothing is written):
// `observe({ reservations, sockets })` is the caller's fresh OpenCode API inventory and its fresh read of every socket
// that matters (the default one, the one this launch creates on, every registered one, every one a reservation names).
// So two launchers can never both see room for one more, and a session that started while a launcher waited is seen.
// A checkout counts as occupied when it has an observed window or live conductor, or a counted reservation:
//   reserved  - made at admission; counts while its launcher runs, then until RESERVED_TTL_MS after it was made;
//   released  - nothing was created (a definite tmux rejection before any output): removed at once;
//   started   - the window was created and verified: counted until its window is seen gone on ITS socket (no session
//               with that id on a server with that pid and start time) or its server is proven ended;
//   uncertain - the creation may have started OpenCode: counted for UNCERTAIN_TTL_MS. When a window is observed in its
//               checkout once its launcher has ended, it is PROMOTED to a started record of that window, so the window
//               stays counted, on the socket it was seen on, until it is gone.
//
// NOT GUARANTEED: a session opened by hand after the observation is not seen (hand-opened sessions are never blocked,
// so nothing could stop it anyway); an idle conductor in a plain terminal outside tmux, or a window on a tmux server that
// is neither the default one nor registered, is not observable; locks across machines are not supported (file-lock.mjs).
import { mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic-write.mjs';
import { pidIsAlive, procStartTime, withFileLock } from './file-lock.mjs';

export const RESERVATIONS_REL = '.sterling/transient/launch-reservations.json';
export const RESERVED_TTL_MS = 15 * 60_000;
export const UNCERTAIN_TTL_MS = 15 * 60_000;
// The whole locked observation: the API inventory (finding 0ded033d measured about 28 s on a busy server), every tmux
// read and every path resolution.
export const OBSERVE_MS = 60_000;
// A waiter allows for a few holders, each bounded by OBSERVE_MS, before it gives up loudly.
export const ADMISSION_LOCK_WAIT_MS = 180_000;

export const reservationsPath = (mainRoot) => join(mainRoot, RESERVATIONS_REL);

const isStr = (v) => typeof v === 'string';
const shapedServer = (s) => s === null || (isStr(s?.pid) && isStr(s.start) && (s.proc_start === null || isStr(s.proc_start)));
const shapedReservation = (r) => isStr(r?.id) && isStr(r.checkout) && (r.socket === null || isStr(r.socket))
  && (r.state === 'started' ? r.expires_at === null && isStr(r.socket) && isStr(r.detail?.windowId) && isStr(r.detail?.serverPid) && isStr(r.detail?.serverStart)
    : ['reserved', 'uncertain'].includes(r.state) && Number.isFinite(r.expires_at));
const shapedSocket = (e) => isStr(e?.socket) && shapedServer(e.server);

/** The state file: { version: 1, reservations, sockets }; an absent file is empty, a malformed one throws. */
export function readReservations(mainRoot) {
  const path = reservationsPath(mainRoot);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { version: 1, reservations: [], sockets: [] };
    throw e;
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON; it is not known which launches are in flight, so no launch is admitted. Inspect it, and delete it only once no launch is running`);
  }
  const sockets = v?.sockets ?? [];
  if (v?.version !== 1 || !Array.isArray(v.reservations) || !v.reservations.every(shapedReservation) || !Array.isArray(sockets) || !sockets.every(shapedSocket)) {
    throw new Error(`${path} does not have the reservation shape; it is not known which launches are in flight, so no launch is admitted. Inspect it, and delete it only once no launch is running`);
  }
  return { version: 1, reservations: v.reservations, sockets };
}

function writeState(mainRoot, state) {
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

/**
 * Whether the tmux server `server` ({ pid, proc_start }) is PROVEN ended: its pid is dead, or the pid now belongs to a
 * process with another /proc start time. A server whose start time was never read (proc_start null) is ended only
 * when its pid is dead.
 */
export function serverEnded(server, { isAlive = pidIsAlive, startTimeOf = procStartTime } = {}) {
  const pid = Number(server.pid);
  if (!isAlive(pid)) return true;
  if (server.proc_start === null || server.proc_start === undefined) return false;
  const cur = startTimeOf(pid);
  return cur !== null && cur !== server.proc_start;
}

const sameServer = (a, b) => a.pid === b.pid && a.start === b.start;

const withLock = (mainRoot, fn, waitMs) => withFileLock(`${reservationsPath(mainRoot)}.lock`, fn, { waitMs });

class ObserveTimeout extends Error {}

async function within(ms, read) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new ObserveTimeout()), ms); });
  try {
    return await Promise.race([read(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Admit one toolkit launch of `checkout` (a canonical folder) against `maxSessions`, to be created on the tmux server
 * at `socket`. `alsoRead` names sockets to read besides the registered ones (the default socket).
 * `observe({ reservations, sockets })` is called inside the locked section and answers
 *   { conductors: [{ checkout, detail }],
 *     readings: { [socket]: { state: 'running', server: { pid, start } | null, windows: [{ checkout, id, detail }], sessionIds }
 *                           | { state: 'absent' | 'unreadable', why } } }
 * with one reading for every socket asked for: 'absent' only when nothing answers at that path. It may throw to refuse
 * (a live conductor of the target); nothing is written then. Returns { admitted: true, id, counted } or
 * { admitted: false, reason, why, counted, socket? }. reasons: admission_timeout, tmux_unreadable, window_exists,
 * conductor_live, launch_in_progress, ceiling_reached. A refusal still records what it learned about the sockets and
 * promotions (never on a timeout, a throw or a dry run). dryRun evaluates the same and writes nothing.
 * serverAlive and serverStartTimeOf judge tmux servers; isAlive and startTimeOf judge launchers (tests' seams).
 */
export async function admitLaunch(mainRoot, { checkout, socket = null, alsoRead = [], maxSessions, observe, dryRun = false, now = Date.now, holder = currentHolder(), isAlive = pidIsAlive, startTimeOf = procStartTime, serverAlive = isAlive, serverStartTimeOf = startTimeOf, waitMs = ADMISSION_LOCK_WAIT_MS, observeMs = OBSERVE_MS }) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error(`max_sessions must be a whole number of at least 1, got ${JSON.stringify(maxSessions)}`);
  return withLock(mainRoot, async () => {
    const state = readReservations(mainRoot);
    const before = JSON.stringify(state);
    const registry = new Map(state.sockets.map((e) => [e.socket, { ...e }]));
    const toRead = [...new Set([...alsoRead, socket, ...registry.keys(), ...state.reservations.map((r) => r.socket)].filter(isStr))];
    let seen;
    try {
      seen = await within(observeMs, () => observe({ reservations: state.reservations, sockets: toRead }));
    } catch (e) {
      if (!(e instanceof ObserveTimeout)) throw e;
      return { admitted: false, reason: 'admission_timeout', why: `reading the OpenCode sessions and the tmux servers (${toRead.join(', ') || 'none'}) took longer than ${observeMs / 1000} s inside the admission lock; nothing was admitted or written, and the lock is released`, counted: [] };
    }
    const t = now();
    const launchers = { isAlive, startTimeOf };
    const servers = { isAlive: serverAlive, startTimeOf: serverStartTimeOf };
    const ended = (server) => serverEnded(server, servers);
    const unreadable = (at, why) => ({ admitted: false, reason: 'tmux_unreadable', socket: at, why: `${why}; it is not known how many sessions run there, so no launch is admitted. If that server has ended for good, or the socket can never be read again, drop it with --forget-socket ${at}`, counted: [] });

    // Judge every socket against the registry. A registered server is never taken for gone unless it is proven ended.
    const windows = [];
    for (const at of toRead) {
      const rd = seen.readings?.[at];
      if (!rd) throw new Error(`the observation gave no reading for the tmux socket ${at}`);
      const entry = registry.get(at);
      const recorded = entry?.server ?? null;
      if (rd.state === 'running') {
        if (recorded && !(rd.server && sameServer(recorded, rd.server))) {
          if (!ended(recorded)) {
            return unreadable(at, rd.server
              ? `the socket ${at} is answered by tmux server pid ${rd.server.pid}, but its recorded server pid ${recorded.pid} still runs and can no longer be reached there`
              : `the socket ${at} answers with no sessions, so its server cannot be identified, while its recorded server pid ${recorded.pid} still runs`);
          }
          entry.server = null;
        }
        if (rd.server && !registry.get(at)?.server) {
          registry.set(at, { ...(registry.get(at) ?? { socket: at, first_seen: t }), socket: at, server: { pid: rd.server.pid, start: rd.server.start, proc_start: serverStartTimeOf(Number(rd.server.pid)) } });
        }
        for (const w of rd.windows) windows.push({ ...w, socket: at, server: rd.server });
      } else if (rd.state === 'absent') {
        if (recorded && !ended(recorded)) {
          return unreadable(at, `the socket ${at} cannot be reached (${rd.why}), but its recorded tmux server pid ${recorded.pid} still runs: a removed socket does not end a server or its windows, and kill -USR1 ${recorded.pid} makes tmux recreate it`);
        }
        if (entry) entry.server = null;
      } else {
        return unreadable(at, `the tmux server at ${at} could not be read (${rd.why})`);
      }
    }

    // A started reservation is gone when its window is not on its server, or that server is proven ended.
    const gone = (r) => {
      const rd = seen.readings[r.socket];
      const own = { pid: r.detail.serverPid, start: r.detail.serverStart };
      if (rd.state === 'running' && rd.server && sameServer(rd.server, own)) return !rd.sessionIds.includes(r.detail.windowId);
      const known = registry.get(r.socket)?.server;
      return ended(known && sameServer(known, own) ? known : { ...own, proc_start: null });
    };
    // An unsettled launch whose launcher has ended, with a window now observed in its checkout: that window is what it made
    // (or stands in its place); it becomes a started record of it, so its socket and window stay counted until it is gone.
    const promote = (r) => {
      if (r.state === 'started' || holderAlive(r.holder, launchers)) return r;
      const w = windows.find((x) => x.checkout === r.checkout && x.server);
      if (!w) return r;
      return { ...r, socket: w.socket, state: 'started', expires_at: null, holder: null, promoted_at: t, promoted_from: r.state, detail: { ...(r.detail ?? {}), windowId: w.id, serverPid: w.server.pid, serverStart: w.server.start } };
    };
    const kept = state.reservations.map(promote).filter((r) => {
      if (holderAlive(r.holder, launchers)) return true;
      return r.state === 'started' ? !gone(r) : t < r.expires_at;
    });
    const named = new Set(kept.map((r) => r.socket).filter(isStr));
    for (const [at, e] of registry) if (e.server === null && !named.has(at)) registry.delete(at);

    const counted = new Map();
    const note = (dir, why) => counted.set(dir, [...(counted.get(dir) ?? []), why]);
    for (const w of windows) note(w.checkout, `tmux window ${w.detail}`);
    for (const c of seen.conductors) note(c.checkout, `live conductor ${c.detail}`);
    const until = (r) => (holderAlive(r.holder, launchers) ? ` (launcher pid ${r.holder.pid} running)` : r.state === 'started' ? ` (until its window ${r.detail.windowId} on ${r.socket} is gone)` : ` (counted until ${new Date(r.expires_at).toISOString()})`);
    for (const r of kept) note(r.checkout, `${r.state} launch reservation ${r.id}${until(r)}`);
    const list = [...counted].map(([dir, why]) => ({ checkout: dir, why }));
    const next = () => ({ version: 1, reservations: kept, sockets: [...registry.values()] });
    const record = () => {
      const after = next();
      if (!dryRun && JSON.stringify(after) !== before) writeState(mainRoot, after);
    };
    const refuse = (reason, why) => {
      record();
      return { admitted: false, reason, why, counted: list };
    };
    const mineW = windows.filter((w) => w.checkout === checkout);
    if (mineW.length > 0) return refuse('window_exists', `${checkout} already has an OpenCode window: ${mineW.map((w) => w.detail).join(', ')}`);
    const mineC = seen.conductors.filter((c) => c.checkout === checkout);
    if (mineC.length > 0) return refuse('conductor_live', `${checkout} already has a live conductor: ${mineC.map((c) => c.detail).join(', ')}`);
    const inFlight = kept.filter((r) => r.checkout === checkout);
    if (inFlight.length > 0) return refuse('launch_in_progress', `another launch of ${checkout} holds reservation ${inFlight.map((r) => `${r.id} (${r.state})`).join(', ')}; an uncertain one counts until it is seen or expires`);
    if (counted.size + 1 > maxSessions) {
      return refuse('ceiling_reached', `multi_session.max_sessions is ${maxSessions} and ${counted.size} checkout${counted.size === 1 ? ' is' : 's are'} occupied (${list.map((c) => `${c.checkout}: ${c.why.join('; ')}`).join(' | ')}); close a session or raise max_sessions`);
    }
    if (dryRun) return { admitted: true, id: null, counted: list };
    const id = `lr_${randomUUID()}`;
    kept.push({ id, checkout, socket, state: 'reserved', created_at: t, expires_at: t + RESERVED_TTL_MS, holder });
    // Every launch records its socket before anything is created there.
    if (isStr(socket) && !registry.has(socket)) registry.set(socket, { socket, server: null, first_seen: t });
    writeState(mainRoot, next());
    return { admitted: true, id, counted: list };
  }, waitMs);
}

/**
 * Settle reservation `id`: 'released' removes it; 'started' keeps it counted until its window is seen gone, needs
 * `detail` { windowId, serverPid, serverStart }, and records that server in the socket registry; 'uncertain' keeps it for
 * UNCERTAIN_TTL_MS from now. A reservation that is gone is written again (with `checkout` and `socket`).
 */
export async function settleLaunch(mainRoot, id, outcome, { checkout, socket, detail = {}, now = Date.now, holder = currentHolder(), serverStartTimeOf = procStartTime, waitMs = ADMISSION_LOCK_WAIT_MS } = {}) {
  if (!['released', 'started', 'uncertain'].includes(outcome)) throw new Error(`unknown launch outcome ${JSON.stringify(outcome)}`);
  return withLock(mainRoot, async () => {
    const state = readReservations(mainRoot);
    const t = now();
    const rest = state.reservations.filter((r) => r.id !== id);
    const sockets = state.sockets.map((e) => ({ ...e }));
    if (outcome !== 'released') {
      const prior = state.reservations.find((r) => r.id === id);
      const at = prior?.checkout ?? checkout;
      const on = prior?.socket ?? socket ?? null;
      if (!isStr(at)) throw new Error(`launch reservation ${id} is gone and no checkout was given to record it again`);
      if (outcome === 'started' && (!isStr(on) || !['windowId', 'serverPid', 'serverStart'].every((k) => isStr(detail[k])))) {
        throw new Error(`launch reservation ${id} cannot be settled started without its socket, window id, server pid and server start time`);
      }
      // The launcher hands the reservation over: the holder is cleared so its liveness no longer extends it.
      rest.push({ ...(prior ?? { id, created_at: t }), checkout: at, socket: on, state: outcome, expires_at: outcome === 'started' ? null : t + UNCERTAIN_TTL_MS, holder: null, settled_at: t, detail, settled_by: holder });
      if (isStr(on)) {
        let entry = sockets.find((e) => e.socket === on);
        if (!entry) sockets.push((entry = { socket: on, server: null, first_seen: t }));
        if (outcome === 'started' && entry.server === null) entry.server = { pid: detail.serverPid, start: detail.serverStart, proc_start: serverStartTimeOf(Number(detail.serverPid)) };
      }
    }
    writeState(mainRoot, { version: 1, reservations: rest, sockets });
  }, waitMs);
}

/**
 * The operator escape for a socket that can never be read again: drops it from the registry together with every
 * reservation that names it, under the lock. Returns { socket, entry, reservations } (what was forgotten).
 */
export async function forgetSocket(mainRoot, socket, { waitMs = ADMISSION_LOCK_WAIT_MS } = {}) {
  return withLock(mainRoot, async () => {
    const state = readReservations(mainRoot);
    const entry = state.sockets.find((e) => e.socket === socket) ?? null;
    const dropped = state.reservations.filter((r) => r.socket === socket);
    if (entry || dropped.length > 0) {
      writeState(mainRoot, { version: 1, reservations: state.reservations.filter((r) => r.socket !== socket), sockets: state.sockets.filter((e) => e.socket !== socket) });
    }
    return { socket, entry, reservations: dropped };
  }, waitMs);
}
