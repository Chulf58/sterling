// Launch admission for the multi-session window launcher (scripts/lib/launch-admission.mjs, slice 6 of the
// multi-session toolkit): count + compare + reserve in one locked section, reservations and uncertain starts counted.
// Every test owns a temp main checkout; nothing reads or writes a real project's .sterling/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitLaunch, settleLaunch, readReservations, reservationsPath, RESERVED_TTL_MS, STARTED_TTL_MS, UNCERTAIN_TTL_MS } from '../lib/launch-admission.mjs';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'launch-admission.mjs');

function fixture(t) {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-admission-')));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  return main;
}

// An observation that yields to the event loop before answering, so parallel admissions interleave inside it.
const yielding = (occupied = []) => async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 2));
  return occupied;
};

const seed = (main, reservations) => {
  mkdirSync(dirname(reservationsPath(main)), { recursive: true });
  writeFileSync(reservationsPath(main), JSON.stringify({ version: 1, reservations }));
};

const deadHolder = { pid: 2 ** 22 + 12345, proc_start: '1', hostname: hostname() };

test('N parallel admissions against max_sessions=k admit exactly k; the rest are ceiling_reached', async (t) => {
  const main = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => admitLaunch(main, { checkout: `/w/s${i}`, maxSessions: 3, observe: yielding() })));
  const admitted = results.filter((r) => r.admitted);
  assert.equal(admitted.length, 3, JSON.stringify(results));
  assert.deepEqual(results.filter((r) => !r.admitted).map((r) => r.reason), Array(5).fill('ceiling_reached'));
  assert.equal(readReservations(main).reservations.length, 3);
});

test('the ceiling holds across processes: parallel launcher processes admit exactly k, and their reservations outlive them', async (t) => {
  const main = fixture(t);
  const code = `import { admitLaunch } from ${JSON.stringify(LIB)};
    const r = await admitLaunch(process.argv[1], { checkout: process.argv[2], maxSessions: 2, observe: async () => { await new Promise((ok) => setTimeout(ok, 5)); return []; } });
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
  const later = await admitLaunch(main, { checkout: '/w/late', maxSessions: 2, observe: yielding() });
  assert.equal(later.reason, 'ceiling_reached');
});

test('uncertain starts and reservations of dead launchers stay counted until they expire', async (t) => {
  const main = fixture(t);
  const now = 1_800_000_000_000;
  seed(main, [
    { id: 'lr_unc', checkout: '/w/a', state: 'uncertain', created_at: now - 1000, expires_at: now + UNCERTAIN_TTL_MS, holder: null },
    { id: 'lr_dead', checkout: '/w/b', state: 'reserved', created_at: now - 1000, expires_at: now + RESERVED_TTL_MS, holder: deadHolder },
  ]);
  const results = await Promise.all(['/w/c', '/w/d', '/w/e'].map((checkout) => admitLaunch(main, { checkout, maxSessions: 3, observe: yielding(), now: () => now })));
  assert.equal(results.filter((r) => r.admitted).length, 1, JSON.stringify(results));
  const refused = results.find((r) => !r.admitted);
  assert.equal(refused.reason, 'ceiling_reached');
  assert.deepEqual(refused.counted.map((c) => c.checkout).slice(0, 2), ['/w/a', '/w/b']);
  // Past their expiry both stop counting and are dropped.
  const after = now + RESERVED_TTL_MS + 1;
  const r = await admitLaunch(main, { checkout: '/w/f', maxSessions: 3, observe: yielding(), now: () => after });
  assert.equal(r.admitted, true);
  // The one admitted earlier is still held by this live process, so it stays; the two expired ones are gone.
  assert.deepEqual(readReservations(main).reservations.map((x) => x.id).sort(), [results.find((x) => x.admitted).id, r.id].sort());
});

test('an uncertain start whose checkout is now observed is carried by the observation and its reservation is dropped', async (t) => {
  const main = fixture(t);
  const now = 1_800_000_000_000;
  seed(main, [{ id: 'lr_unc', checkout: '/w/a', state: 'uncertain', created_at: now, expires_at: now + UNCERTAIN_TTL_MS, holder: null }]);
  const r = await admitLaunch(main, { checkout: '/w/b', maxSessions: 2, observe: yielding([{ checkout: '/w/a', kind: 'window', detail: 'x ($1)' }]), now: () => now });
  assert.equal(r.admitted, true);
  assert.deepEqual(r.counted, [{ checkout: '/w/a', why: ['tmux window x ($1)'] }]);
  assert.deepEqual(readReservations(main).reservations.map((x) => x.id), [r.id]);
});

test('hand-opened sessions are counted: observed windows and live conductors fill the ceiling', async (t) => {
  const main = fixture(t);
  const observe = yielding([{ checkout: main, kind: 'window', detail: 'sterling-proj-ab12-opencode ($0)' }, { checkout: '/w/x', kind: 'conductor', detail: 'ses_a (busy)' }]);
  const r = await admitLaunch(main, { checkout: '/w/y', maxSessions: 2, observe });
  assert.equal(r.reason, 'ceiling_reached');
  assert.match(r.why, /max_sessions is 2 and 2 checkouts are occupied/);
  assert.equal(existsSync(reservationsPath(main)), false, 'a refusal writes nothing');
});

test('the target checkout observed occupied or reserved is refused by name, whatever the ceiling', async (t) => {
  const main = fixture(t);
  const w = await admitLaunch(main, { checkout: '/w/a', maxSessions: 9, observe: yielding([{ checkout: '/w/a', kind: 'window', detail: 'n ($3)' }]) });
  assert.equal(w.reason, 'window_exists');
  const c = await admitLaunch(main, { checkout: '/w/a', maxSessions: 9, observe: yielding([{ checkout: '/w/a', kind: 'conductor', detail: 'ses_x (busy)' }]) });
  assert.equal(c.reason, 'conductor_live');
  const first = await admitLaunch(main, { checkout: '/w/a', maxSessions: 9, observe: yielding() });
  assert.equal(first.admitted, true);
  const second = await admitLaunch(main, { checkout: '/w/a', maxSessions: 9, observe: yielding() });
  assert.equal(second.reason, 'launch_in_progress');
});

test('a dry run evaluates the same and writes nothing', async (t) => {
  const main = fixture(t);
  const r = await admitLaunch(main, { checkout: '/w/a', maxSessions: 1, observe: yielding(), dryRun: true });
  assert.deepEqual([r.admitted, r.id], [true, null]);
  assert.equal(existsSync(reservationsPath(main)), false);
});

test('settling: released removes the reservation, started and uncertain keep it for their TTL with the holder cleared', async (t) => {
  const main = fixture(t);
  const now = 1_800_000_000_000;
  const a = await admitLaunch(main, { checkout: '/w/a', maxSessions: 5, observe: yielding(), now: () => now });
  const b = await admitLaunch(main, { checkout: '/w/b', maxSessions: 5, observe: yielding(), now: () => now });
  const c = await admitLaunch(main, { checkout: '/w/c', maxSessions: 5, observe: yielding(), now: () => now });
  await settleLaunch(main, a.id, 'released', { now: () => now });
  await settleLaunch(main, b.id, 'started', { detail: { windowId: '$4', serverPid: '9' }, now: () => now });
  await settleLaunch(main, c.id, 'uncertain', { now: () => now });
  const rows = Object.fromEntries(readReservations(main).reservations.map((r) => [r.checkout, r]));
  assert.deepEqual(Object.keys(rows).sort(), ['/w/b', '/w/c']);
  assert.deepEqual([rows['/w/b'].state, rows['/w/b'].expires_at, rows['/w/b'].holder, rows['/w/b'].detail.windowId], ['started', now + STARTED_TTL_MS, null, '$4']);
  assert.deepEqual([rows['/w/c'].state, rows['/w/c'].expires_at], ['uncertain', now + UNCERTAIN_TTL_MS]);
  // A reservation that is gone is written again on an uncertain settle, so the start is never lost.
  await settleLaunch(main, 'lr_gone', 'uncertain', { checkout: '/w/z', now: () => now });
  assert.ok(readReservations(main).reservations.some((r) => r.id === 'lr_gone' && r.checkout === '/w/z'));
});

test('a reservation file that is not the reservation shape refuses every admission loudly', async (t) => {
  const main = fixture(t);
  mkdirSync(dirname(reservationsPath(main)), { recursive: true });
  writeFileSync(reservationsPath(main), '{"version":1,"reservations":[{"id":1}]}');
  await assert.rejects(admitLaunch(main, { checkout: '/w/a', maxSessions: 3, observe: yielding() }), /does not have the reservation shape/);
  writeFileSync(reservationsPath(main), 'not json');
  await assert.rejects(admitLaunch(main, { checkout: '/w/a', maxSessions: 3, observe: yielding() }), /is not JSON/);
  assert.equal(readFileSync(reservationsPath(main), 'utf8'), 'not json');
});

test('max_sessions must be a whole number of at least 1', async (t) => {
  const main = fixture(t);
  await assert.rejects(admitLaunch(main, { checkout: '/w/a', maxSessions: 0, observe: yielding() }), /at least 1/);
});
