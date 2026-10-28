// Launch admission for the multi-session window launcher (scripts/lib/launch-admission.mjs, slice 6 of the
// multi-session toolkit): count + compare + reserve in one locked section under one deadline, reservations, uncertain
// starts and the socket registry. Every test owns a temp main checkout; nothing reads or writes a real project's
// .sterling/. tmux servers are fakes: their liveness goes through the serverAlive / serverStartTimeOf seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitLaunch, settleLaunch, forgetSocket, readReservations, reservationsPath, serverEnded, RESERVED_TTL_MS, UNCERTAIN_TTL_MS } from '../lib/launch-admission.mjs';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'launch-admission.mjs');
const DEF = '/tmp/tmux-1000/default';
const WORK = '/tmp/tmux-1000/work';

function fixture(t) {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-admission-')));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  return main;
}

// A fake machine: tmux servers by pid ({ alive, proc }) and readings by socket. A socket with no reading answers
// 'absent'. The observation yields to the event loop first, so parallel admissions interleave inside it.
function machine() {
  const m = { procs: new Map(), readings: {}, conductors: [] };
  m.server = (pid, start = '1700000000') => { m.procs.set(pid, { alive: true, proc: `p${pid}` }); return { pid, start }; };
  m.running = (socket, server, windows = []) => { m.readings[socket] = { state: 'running', server, windows, sessionIds: windows.map((w) => w.id) }; };
  m.observe = async ({ sockets }) => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 2));
    return { conductors: m.conductors, readings: Object.fromEntries(sockets.map((s) => [s, m.readings[s] ?? { state: 'absent', why: `error connecting to ${s} (No such file or directory)` }])) };
  };
  m.opts = (over = {}) => ({ observe: m.observe, serverAlive: (pid) => m.procs.get(String(pid))?.alive ?? false, serverStartTimeOf: (pid) => m.procs.get(String(pid))?.proc ?? null, ...over });
  return m;
}
const win = (checkout, id, detail = `w ${id}`) => ({ checkout, id, detail });

const seed = (main, reservations, sockets = []) => {
  mkdirSync(dirname(reservationsPath(main)), { recursive: true });
  writeFileSync(reservationsPath(main), JSON.stringify({ version: 1, reservations, sockets }));
};

const deadHolder = { pid: 2 ** 22 + 12345, proc_start: '1', hostname: hostname() };

test('N parallel admissions against max_sessions=k admit exactly k; the rest are ceiling_reached', async (t) => {
  const main = fixture(t);
  const m = machine();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => admitLaunch(main, { checkout: `/w/s${i}`, maxSessions: 3, ...m.opts() })));
  assert.equal(results.filter((r) => r.admitted).length, 3, JSON.stringify(results));
  assert.deepEqual(results.filter((r) => !r.admitted).map((r) => r.reason), Array(5).fill('ceiling_reached'));
  assert.equal(readReservations(main).reservations.length, 3);
});

test('the ceiling holds across processes: parallel launcher processes admit exactly k, and their reservations outlive them', async (t) => {
  const main = fixture(t);
  const code = `import { admitLaunch } from ${JSON.stringify(LIB)};
    const r = await admitLaunch(process.argv[1], { checkout: process.argv[2], maxSessions: 2, observe: async () => { await new Promise((ok) => setTimeout(ok, 5)); return { conductors: [], readings: {} }; } });
    process.stdout.write(JSON.stringify(r));`;
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.OPENCODE;
  delete env.OPENCODE_SESSION_ID;
  const run = (i) => new Promise((ok, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, main, `/w/p${i}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', fail);
    child.on('close', (status) => (status === 0 ? ok(JSON.parse(out)) : fail(new Error(`child ${i} exited ${status}: ${err}`))));
  });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => run(i)));
  assert.equal(results.filter((r) => r.admitted).length, 2, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.admitted).every((r) => r.reason === 'ceiling_reached'));
  // The launchers are gone, but a launcher that dies before it settles may have created a window: its reservation counts.
  const later = await admitLaunch(main, { checkout: '/w/late', maxSessions: 2, ...machine().opts() });
  assert.equal(later.reason, 'ceiling_reached');
});

test('uncertain starts and reservations of dead launchers stay counted until they expire', async (t) => {
  const main = fixture(t);
  const m = machine();
  const now = 1_800_000_000_000;
  seed(main, [
    { id: 'lr_unc', checkout: '/w/a', socket: null, state: 'uncertain', created_at: now - 1000, expires_at: now + UNCERTAIN_TTL_MS, holder: null },
    { id: 'lr_dead', checkout: '/w/b', socket: '/tmp/s', state: 'reserved', created_at: now - 1000, expires_at: now + RESERVED_TTL_MS, holder: deadHolder },
  ]);
  const results = await Promise.all(['/w/c', '/w/d', '/w/e'].map((checkout) => admitLaunch(main, { checkout, maxSessions: 3, now: () => now, ...m.opts() })));
  assert.equal(results.filter((r) => r.admitted).length, 1, JSON.stringify(results));
  const refused = results.find((r) => !r.admitted);
  assert.equal(refused.reason, 'ceiling_reached');
  assert.deepEqual(refused.counted.map((c) => c.checkout).slice(0, 2), ['/w/a', '/w/b']);
  const after = now + RESERVED_TTL_MS + 1;
  const r = await admitLaunch(main, { checkout: '/w/f', maxSessions: 3, now: () => after, ...m.opts() });
  assert.equal(r.admitted, true);
  assert.deepEqual(readReservations(main).reservations.map((x) => x.id).sort(), [results.find((x) => x.admitted).id, r.id].sort());
});

test('hand-opened sessions are counted: observed windows and live conductors fill the ceiling', async (t) => {
  const main = fixture(t);
  const m = machine();
  m.running(DEF, m.server('50'), [win(main, '$0', 'sterling-proj-ab12-opencode ($0)')]);
  m.conductors = [{ checkout: '/w/x', detail: 'ses_a (busy)' }];
  const r = await admitLaunch(main, { checkout: '/w/y', alsoRead: [DEF], maxSessions: 2, dryRun: true, ...m.opts() });
  assert.equal(r.reason, 'ceiling_reached');
  assert.match(r.why, /max_sessions is 2 and 2 checkouts are occupied/);
  assert.equal(existsSync(reservationsPath(main)), false, 'a dry run writes nothing');
});

test('the target checkout observed occupied or reserved is refused by name, whatever the ceiling', async (t) => {
  const main = fixture(t);
  const m = machine();
  m.running(DEF, m.server('50'), [win('/w/a', '$3')]);
  assert.equal((await admitLaunch(main, { checkout: '/w/a', alsoRead: [DEF], maxSessions: 9, ...m.opts() })).reason, 'window_exists');
  // That refusal registered the default server; once it has ended, its missing socket is no obstacle.
  delete m.readings[DEF];
  m.procs.get('50').alive = false;
  m.conductors = [{ checkout: '/w/a', detail: 'ses_x (busy)' }];
  assert.equal((await admitLaunch(main, { checkout: '/w/a', maxSessions: 9, ...m.opts() })).reason, 'conductor_live');
  m.conductors = [];
  assert.equal((await admitLaunch(main, { checkout: '/w/a', maxSessions: 9, ...m.opts() })).admitted, true);
  assert.equal((await admitLaunch(main, { checkout: '/w/a', maxSessions: 9, ...m.opts() })).reason, 'launch_in_progress');
});

test('settling: released removes the reservation, uncertain keeps it for its TTL, started until its window is gone and registers its server', async (t) => {
  const main = fixture(t);
  const m = machine();
  const now = 1_800_000_000_000;
  const a = await admitLaunch(main, { checkout: '/w/a', socket: WORK, maxSessions: 5, now: () => now, ...m.opts() });
  const b = await admitLaunch(main, { checkout: '/w/b', socket: WORK, maxSessions: 5, now: () => now, ...m.opts() });
  const c = await admitLaunch(main, { checkout: '/w/c', socket: WORK, maxSessions: 5, now: () => now, ...m.opts() });
  assert.deepEqual(readReservations(main).sockets.map((e) => [e.socket, e.server]), [[WORK, null]], 'every launch records its socket');
  await settleLaunch(main, a.id, 'released', { now: () => now });
  await assert.rejects(settleLaunch(main, b.id, 'started', { detail: { windowId: '$4', serverPid: '9' }, now: () => now }), /server start time/);
  await settleLaunch(main, b.id, 'started', { detail: { windowId: '$4', serverPid: '9', serverStart: '1700000000' }, now: () => now, serverStartTimeOf: () => 'p9' });
  await settleLaunch(main, c.id, 'uncertain', { now: () => now });
  const state = readReservations(main);
  const rows = Object.fromEntries(state.reservations.map((r) => [r.checkout, r]));
  assert.deepEqual(Object.keys(rows).sort(), ['/w/b', '/w/c']);
  assert.deepEqual([rows['/w/b'].state, rows['/w/b'].expires_at, rows['/w/b'].holder, rows['/w/b'].detail.windowId, rows['/w/b'].socket], ['started', null, null, '$4', WORK]);
  assert.deepEqual([rows['/w/c'].state, rows['/w/c'].expires_at], ['uncertain', now + UNCERTAIN_TTL_MS]);
  assert.deepEqual(state.sockets, [{ socket: WORK, server: { pid: '9', start: '1700000000', proc_start: 'p9' }, first_seen: now }]);
});

test('a started reservation counts until its window is seen gone on its own server, however much time passes', async (t) => {
  const main = fixture(t);
  const m = machine();
  const now = 1_800_000_000_000;
  const srv = m.server('9');
  seed(main, [{ id: 'lr_run', checkout: '/w/a', socket: WORK, state: 'started', created_at: now, expires_at: null, holder: null, detail: { windowId: '$3', serverPid: '9', serverStart: srv.start } }], [{ socket: WORK, server: { ...srv, proc_start: 'p9' } }]);
  const later = now + 30 * 24 * 3600_000;
  m.running(WORK, srv, [win('/w/a', '$3')]);
  let r = await admitLaunch(main, { checkout: '/w/b', maxSessions: 1, now: () => later, ...m.opts() });
  assert.equal(r.reason, 'ceiling_reached');
  // The window closed, another session keeps the server up: the reservation is gone, the server stays registered.
  m.readings[WORK] = { state: 'running', server: srv, windows: [], sessionIds: ['$7'] };
  r = await admitLaunch(main, { checkout: '/w/b', maxSessions: 1, now: () => later, ...m.opts() });
  assert.equal(r.admitted, true, r.why);
  assert.deepEqual(readReservations(main).reservations.map((x) => x.id), [r.id]);
});

// --- the socket registry: a missing or unreadable socket is never taken for an ended server ---

test('an uncertain launch whose window is observed is promoted to a started record on that socket: a later read keeps it counted (max_sessions=2)', async (t) => {
  const main = fixture(t);
  const m = machine();
  const now = 1_800_000_000_000;
  const srv = m.server('9');
  seed(main, [{ id: 'lr_unc', checkout: '/w/a', socket: WORK, state: 'uncertain', created_at: now, expires_at: now + UNCERTAIN_TTL_MS, holder: null }]);
  m.running(WORK, srv, [win('/w/a', '$2')]);
  const b = await admitLaunch(main, { checkout: '/w/b', socket: DEF, alsoRead: [DEF], maxSessions: 2, now: () => now, ...m.opts() });
  assert.equal(b.admitted, true);
  const unc = readReservations(main).reservations.find((x) => x.id === 'lr_unc');
  assert.deepEqual([unc.state, unc.socket, unc.detail.windowId, unc.detail.serverPid, unc.promoted_from], ['started', WORK, '$2', '9', 'uncertain']);
  // Long past the uncertain TTL, a launch from the default server still reads WORK and meets the ceiling.
  const later = now + 7 * 24 * 3600_000;
  const c = await admitLaunch(main, { checkout: '/w/c', socket: DEF, alsoRead: [DEF], maxSessions: 2, now: () => later, ...m.opts() });
  assert.equal(c.reason, 'ceiling_reached', c.why);
  assert.ok(c.counted.some((x) => x.checkout === '/w/a'));
});

test('a registered socket that is missing while its recorded server still runs is tmux_unreadable, never gone', async (t) => {
  const main = fixture(t);
  const m = machine();
  const now = 1_800_000_000_000;
  const srv = m.server('9');
  seed(main, [{ id: 'lr_run', checkout: '/w/a', socket: WORK, state: 'started', created_at: now, expires_at: null, holder: null, detail: { windowId: '$3', serverPid: '9', serverStart: srv.start } }], [{ socket: WORK, server: { ...srv, proc_start: 'p9' }, first_seen: now }]);
  // The socket file was unlinked: nothing answers at the path, the server and its window still run.
  const r = await admitLaunch(main, { checkout: '/w/b', maxSessions: 1, now: () => now, ...m.opts() });
  assert.deepEqual([r.admitted, r.reason, r.socket], [false, 'tmux_unreadable', WORK]);
  assert.match(r.why, /recorded tmux server pid 9 still runs.*kill -USR1 9/);
  assert.deepEqual(readReservations(main).reservations.map((x) => x.id), ['lr_run'], 'nothing is dropped');
  // The server ends (pid dead): only now does the socket leave the registry and its reservation stop counting.
  m.procs.get('9').alive = false;
  const ok = await admitLaunch(main, { checkout: '/w/b', maxSessions: 1, now: () => now, ...m.opts() });
  assert.equal(ok.admitted, true, ok.why);
  assert.deepEqual(readReservations(main).sockets.map((e) => e.socket), []);
});

test('a reused pid with another /proc start time proves the recorded server ended; another server answering while it runs refuses', async (t) => {
  const main = fixture(t);
  const m = machine();
  const now = 1_800_000_000_000;
  const old = { pid: '9', start: '1700000000' };
  seed(main, [], [{ socket: WORK, server: { ...old, proc_start: 'p9' }, first_seen: now }]);
  m.procs.set('9', { alive: true, proc: 'p9' });
  const fresh = m.server('11', '1700009999');
  m.running(WORK, fresh, []);
  m.readings[WORK].sessionIds = ['$0'];
  let r = await admitLaunch(main, { checkout: '/w/b', maxSessions: 3, ...m.opts() });
  assert.deepEqual([r.reason, r.socket], ['tmux_unreadable', WORK]);
  assert.match(r.why, /answered by tmux server pid 11, but its recorded server pid 9 still runs/);
  m.procs.set('9', { alive: true, proc: 'p-other' });
  r = await admitLaunch(main, { checkout: '/w/b', maxSessions: 3, ...m.opts() });
  assert.equal(r.admitted, true, r.why);
  assert.deepEqual(readReservations(main).sockets.find((e) => e.socket === WORK).server, { ...fresh, proc_start: 'p11' });
  assert.equal(serverEnded({ pid: '9', proc_start: null }, { isAlive: () => true, startTimeOf: () => 'x' }), false, 'no start time read: only a dead pid proves the end');
});

test('a permission-denied socket refuses until --forget-socket drops it with the reservations naming it', async (t) => {
  const main = fixture(t);
  const m = machine();
  const now = 1_800_000_000_000;
  const srv = m.server('9');
  seed(main, [{ id: 'lr_run', checkout: '/w/a', socket: WORK, state: 'started', created_at: now, expires_at: null, holder: null, detail: { windowId: '$3', serverPid: '9', serverStart: srv.start } }], [{ socket: WORK, server: { ...srv, proc_start: 'p9' }, first_seen: now }]);
  m.readings[WORK] = { state: 'unreadable', why: `error connecting to ${WORK} (Permission denied)` };
  let r = await admitLaunch(main, { checkout: '/w/b', maxSessions: 3, ...m.opts() });
  assert.deepEqual([r.reason, r.socket], ['tmux_unreadable', WORK]);
  assert.match(r.why, /Permission denied.*--forget-socket \/tmp\/tmux-1000\/work/);
  const forgotten = await forgetSocket(main, WORK);
  assert.deepEqual([forgotten.entry.server.pid, forgotten.reservations.map((x) => x.id)], ['9', ['lr_run']]);
  assert.deepEqual(readReservations(main), { version: 1, reservations: [], sockets: [] });
  r = await admitLaunch(main, { checkout: '/w/b', maxSessions: 3, ...m.opts() });
  assert.equal(r.admitted, true, r.why);
  assert.deepEqual(await forgetSocket(main, '/tmp/none'), { socket: '/tmp/none', entry: null, reservations: [] });
});

test('the whole locked observation has one deadline: a stalled read refuses, writes nothing and releases the lock', async (t) => {
  const main = fixture(t);
  const m = machine();
  const stalled = () => new Promise(() => {});
  const r = await admitLaunch(main, { checkout: '/w/a', socket: WORK, maxSessions: 3, ...m.opts({ observe: stalled }), observeMs: 50 });
  assert.equal(r.reason, 'admission_timeout');
  assert.match(r.why, /longer than 0.05 s.*lock is released/);
  assert.equal(existsSync(reservationsPath(main)), false);
  const next = await admitLaunch(main, { checkout: '/w/a', maxSessions: 3, ...m.opts(), waitMs: 500 });
  assert.equal(next.admitted, true);
});

test('the observation gets every socket that matters, and its refusal writes nothing', async (t) => {
  const main = fixture(t);
  const m = machine();
  const first = await admitLaunch(main, { checkout: '/w/a', socket: WORK, maxSessions: 5, ...m.opts() });
  let seen;
  await assert.rejects(admitLaunch(main, { checkout: '/w/b', socket: '/tmp/s3', alsoRead: [DEF], maxSessions: 5, ...m.opts({ observe: async (o) => { seen = o; throw new Error('conductor_live'); } }) }), /conductor_live/);
  assert.deepEqual(seen.sockets.sort(), [DEF, WORK, '/tmp/s3'].sort());
  assert.deepEqual(readReservations(main).reservations.map((r) => r.id), [first.id]);
});

test('a reservation file that is not the reservation shape refuses every admission loudly', async (t) => {
  const main = fixture(t);
  const m = machine();
  mkdirSync(dirname(reservationsPath(main)), { recursive: true });
  writeFileSync(reservationsPath(main), '{"version":1,"reservations":[],"sockets":[{"socket":1}]}');
  await assert.rejects(admitLaunch(main, { checkout: '/w/a', maxSessions: 3, ...m.opts() }), /does not have the reservation shape/);
  writeFileSync(reservationsPath(main), 'not json');
  await assert.rejects(admitLaunch(main, { checkout: '/w/a', maxSessions: 3, ...m.opts() }), /is not JSON/);
  assert.equal(readFileSync(reservationsPath(main), 'utf8'), 'not json');
});

test('max_sessions must be a whole number of at least 1', async (t) => {
  const main = fixture(t);
  await assert.rejects(admitLaunch(main, { checkout: '/w/a', maxSessions: 0, ...machine().opts() }), /at least 1/);
});
