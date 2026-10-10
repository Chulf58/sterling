// The session-event register writer, shared by H16 (Claude Code) and the OpenCode plugin's
// research recorder. Golden tests pin the bytes H16 wrote before the writer was extracted:
// a compact JSON array, one object per event, keys in kind/detail/at/agent_id order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SESSION_EVENTS_LOCK_HELD, SESSION_EVENTS_REL, appendSessionEvent, researchToolEvent, withSessionEventsLock } from '../hooks/lib/session-events.mjs';

const AT = '2026-10-02T12:00:00.000Z';

test('researchToolEvent: the research_tool shape H16 records, agent_id only for a non-empty id', () => {
  assert.equal(JSON.stringify(researchToolEvent('rate limits', { at: AT })), '{"kind":"research_tool","detail":"rate limits","at":"2026-10-02T12:00:00.000Z"}');
  assert.equal(JSON.stringify(researchToolEvent('https://x.dev/a', { at: AT, agentId: 'a1' })), '{"kind":"research_tool","detail":"https://x.dev/a","at":"2026-10-02T12:00:00.000Z","agent_id":"a1"}');
  assert.equal(JSON.stringify(researchToolEvent(undefined, { at: AT, agentId: '' })), '{"kind":"research_tool","detail":"","at":"2026-10-02T12:00:00.000Z"}');
});

test('appendSessionEvent: creates the register, appends in order, never dedups, writes compact JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-'));
  try {
    assert.equal(SESSION_EVENTS_REL, join('.sterling', 'transient', 'session-events.json'));
    const e = researchToolEvent('q', { at: AT });
    appendSessionEvent(dir, e);
    appendSessionEvent(dir, e);
    appendSessionEvent(dir, { kind: 'agent_dispatch', detail: 'researcher', at: AT, tool_use_id: 't1' });
    assert.equal(
      readFileSync(join(dir, SESSION_EVENTS_REL), 'utf8'),
      '[{"kind":"research_tool","detail":"q","at":"2026-10-02T12:00:00.000Z"},{"kind":"research_tool","detail":"q","at":"2026-10-02T12:00:00.000Z"},{"kind":"agent_dispatch","detail":"researcher","at":"2026-10-02T12:00:00.000Z","tool_use_id":"t1"}]',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendSessionEvent: an unparsable register throws instead of being overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-'));
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, SESSION_EVENTS_REL), '{ broken');
    assert.throws(() => appendSessionEvent(dir, researchToolEvent('q', { at: AT })), SyntaxError);
    assert.equal(readFileSync(join(dir, SESSION_EVENTS_REL), 'utf8'), '{ broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #64: parallel H16 runs threw "Unexpected end of JSON input" and lost events, because
// the writer was an unlocked read-modify-write whose writeFileSync truncates before it writes.
// Each child below is a separate process calling the real appendSessionEvent; they wait for a
// shared start instant so their read-modify-writes overlap.
const LIB_URL = new URL('../hooks/lib/session-events.mjs', import.meta.url).href;

function runChild(source, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

const APPENDER = `
const { appendSessionEvent } = await import(process.argv[1]);
const [dir, id, startAt, count] = [process.argv[2], process.argv[3], Number(process.argv[4]), Number(process.argv[5])];
while (Date.now() < startAt);
for (let i = 0; i < count; i++) appendSessionEvent(dir, { kind: 'agent_dispatch', detail: id + ':' + i, at: '${AT}' });
`;

test('appendSessionEvent: 9 concurrent processes never throw and every event is kept (issue #64)', async () => {
  for (let round = 0; round < 5; round++) {
    const dir = mkdtempSync(join(tmpdir(), 'sterling-events-race-'));
    try {
      const startAt = String(Date.now() + 400);
      const ids = Array.from({ length: 9 }, (_, i) => `lane${i}`);
      const results = await Promise.all(ids.map((id) => runChild(APPENDER, [LIB_URL, dir, id, startAt, '1'])));
      for (const r of results) {
        assert.doesNotMatch(r.stderr, /SyntaxError|Unexpected end of JSON input/, `round ${round}: a child failed to parse the register`);
        assert.equal(r.code, 0, `round ${round}: a child exited ${r.code}: ${JSON.stringify(r.stderr.slice(0, 300))}`);
      }
      const events = JSON.parse(readFileSync(join(dir, SESSION_EVENTS_REL), 'utf8'));
      assert.deepEqual(events.map((e) => e.detail).sort(), ids.map((id) => `${id}:0`).sort(), `round ${round}: lost events`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const READER = `
const { readFileSync, existsSync } = await import('node:fs');
const [path, want] = [process.argv[1], Number(process.argv[2])];
const deadline = Date.now() + 20000;
let reads = 0;
while (Date.now() < deadline) {
  if (!existsSync(path)) continue;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
  reads++;
  let events;
  try { events = JSON.parse(text); } catch (e) { console.error('BAD READ ' + JSON.stringify(text.slice(0, 80)) + ': ' + e.message); process.exit(3); }
  if (events.length >= want) { console.error('reads ' + reads); process.exit(0); }
}
console.error('reader timed out after ' + reads + ' reads');
process.exit(4);
`;

test('appendSessionEvent: a reader looping during 50 appends never sees an empty or partial register', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-reader-'));
  try {
    const startAt = String(Date.now() + 400);
    const reader = runChild(READER, [join(dir, SESSION_EVENTS_REL), '50']);
    const writers = ['w0', 'w1', 'w2', 'w3', 'w4'].map((id) => runChild(APPENDER, [LIB_URL, dir, id, startAt, '10']));
    const [r, ...ws] = await Promise.all([reader, ...writers]);
    for (const w of ws) assert.equal(w.code, 0, `a writer exited ${w.code}: ${JSON.stringify(w.stderr.slice(0, 300))}`);
    assert.equal(r.code, 0, `the reader saw a bad register: ${JSON.stringify(r.stderr.slice(0, 300))}`);
    assert.equal(JSON.parse(readFileSync(join(dir, SESSION_EVENTS_REL), 'utf8')).length, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function registerWithLock(lockBody) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-lock-'));
  const eventsPath = join(dir, SESSION_EVENTS_REL);
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(eventsPath, '[{"kind":"research_tool","detail":"before","at":"x"}]');
  writeFileSync(`${eventsPath}.lock`, lockBody);
  return { dir, eventsPath };
}

test('withSessionEventsLock: a lock held by a live process times out with session_events_lock_held and the register is unchanged', () => {
  const { dir, eventsPath } = registerWithLock(`${process.pid} held-by-test`);
  try {
    assert.throws(
      () => appendSessionEvent(dir, researchToolEvent('q', { at: AT }), { timeoutMs: 150 }),
      (e) => e.code === SESSION_EVENTS_LOCK_HELD && /nothing was written/.test(e.message),
    );
    assert.equal(readFileSync(eventsPath, 'utf8'), '[{"kind":"research_tool","detail":"before","at":"x"}]');
    assert.equal(readFileSync(`${eventsPath}.lock`, 'utf8'), `${process.pid} held-by-test`, 'a live holder\'s lock is never removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withSessionEventsLock: a lock whose pid is dead is reclaimed, and the append lands', () => {
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const { dir, eventsPath } = registerWithLock(`${deadPid} crashed-holder`);
  try {
    appendSessionEvent(dir, researchToolEvent('after', { at: AT }), { timeoutMs: 150 });
    assert.deepEqual(JSON.parse(readFileSync(eventsPath, 'utf8')).map((e) => e.detail), ['before', 'after']);
    assert.equal(existsSync(`${eventsPath}.lock`), false, 'the lock is released after the append');
    assert.equal(existsSync(`${eventsPath}.lock.reclaim`), false, 'the reclaim gate is released');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withSessionEventsLock: an old lock whose pid is alive is NOT reclaimed, whatever its age; the refusal names the lock and its pid', () => {
  const { dir, eventsPath } = registerWithLock(`${process.pid} overran`);
  try {
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(`${eventsPath}.lock`, old, old);
    assert.throws(
      () => appendSessionEvent(dir, researchToolEvent('after', { at: AT }), { timeoutMs: 150, staleMs: 100 }),
      (e) => e.code === SESSION_EVENTS_LOCK_HELD && e.message.includes(`${eventsPath}.lock`) && e.message.includes(`pid ${process.pid}`),
    );
    assert.equal(readFileSync(eventsPath, 'utf8'), '[{"kind":"research_tool","detail":"before","at":"x"}]');
    assert.equal(readFileSync(`${eventsPath}.lock`, 'utf8'), `${process.pid} overran`, 'a live holder\'s lock is never removed, however old');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Sol review of 07452638: a holder that stays inside fn past the old 30 s staleness bound had its
// lock removed by age, and a contender entered beside it. Holder A sleeps inside fn for 600 ms;
// contender B starts 150 ms later and passes staleMs: 100 (the bound the old code reclaimed on).
// B must not enter before A has left.
const HOLDER = `
const { withSessionEventsLock } = await import(process.argv[1]);
const { appendFileSync } = await import('node:fs');
const [path, log, name, startAt, holdMs] = [process.argv[2], process.argv[3], process.argv[4], Number(process.argv[5]), Number(process.argv[6])];
while (Date.now() < startAt);
withSessionEventsLock(path, () => {
  appendFileSync(log, name + ' enter ' + Date.now() + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  appendFileSync(log, name + ' exit ' + Date.now() + '\\n');
}, { staleMs: 100, timeoutMs: 5000 });
`;

test('withSessionEventsLock: a contender never enters while a live holder is still inside fn, even past staleMs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-mutex-'));
  try {
    const path = join(dir, 'register.json');
    const log = join(dir, 'log');
    const t0 = Date.now() + 400;
    const [a, b] = await Promise.all([
      runChild(HOLDER, [LIB_URL, path, log, 'A', String(t0), '600']),
      runChild(HOLDER, [LIB_URL, path, log, 'B', String(t0 + 150), '0']),
    ]);
    assert.equal(a.code, 0, `holder A exited ${a.code}: ${JSON.stringify(a.stderr.slice(0, 300))}`);
    assert.equal(b.code, 0, `contender B exited ${b.code}: ${JSON.stringify(b.stderr.slice(0, 300))}`);
    const at = Object.fromEntries(readFileSync(log, 'utf8').trim().split('\n').map((l) => { const [n, what, ms] = l.split(' '); return [`${n} ${what}`, Number(ms)]; }));
    assert.ok(at['A enter'] < at['B enter'], 'A entered first');
    assert.ok(at['B enter'] >= at['A exit'], `B entered at +${at['B enter'] - at['A enter']}ms while A held until +${at['A exit'] - at['A enter']}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withSessionEventsLock: releases only its own lock, and releases it when fn throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-lock-'));
  const path = join(dir, 'register.json');
  try {
    assert.throws(() => withSessionEventsLock(path, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(`${path}.lock`), false, 'the lock is released when fn throws');
    withSessionEventsLock(path, () => writeFileSync(`${path}.lock`, `${process.pid} someone-else`));
    assert.equal(readFileSync(`${path}.lock`, 'utf8'), `${process.pid} someone-else`, 'a lock that no longer holds this holder\'s token is left alone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendSessionEvent: an empty register is unparsable, throws, and is left as it is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-events-'));
  try {
    mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(dir, SESSION_EVENTS_REL), '');
    assert.throws(() => appendSessionEvent(dir, researchToolEvent('q', { at: AT })), SyntaxError);
    assert.equal(readFileSync(join(dir, SESSION_EVENTS_REL), 'utf8'), '');
    assert.equal(existsSync(join(dir, `${SESSION_EVENTS_REL}.lock`)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H16: a held register lock skips the event with one named non-blocking line, and the register is unchanged', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const { SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href);
  const { dir, eventsPath } = registerWithLock(`${process.pid} held-by-test`);
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    const input = { session_id: 's1', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'researcher' }, tool_use_id: 'tu1', tool_response: { agentId: 'ag1' } };
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h16-event-register.mjs')], { input: JSON.stringify(input), encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 1, 'the same non-blocking exit H16 uses for every registration failure');
    assert.match(r.stderr, /H16: session event NOT registered \(session_events_lock_held\): agent_dispatch 'researcher' agent_id ag1;/);
    assert.doesNotMatch(r.stderr, /registration failed/, 'one line, not two');
    assert.equal(readFileSync(eventsPath, 'utf8'), '[{"kind":"research_tool","detail":"before","at":"x"}]');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
