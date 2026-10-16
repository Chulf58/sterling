// The machine-level knowledge_move lock (move-lock.ts): busy refusal, takeover of a dead or
// recycled owner, one winner among concurrent takers of a stale lock, token-bound release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MoveLockBusyError, UNPARSEABLE_GRACE_MS, acquireMoveLock, releaseMoveLock } from '../move-lock.js';

function dir(): { path: string; lock: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'sterling-move-lock-'));
  return { path, lock: join(path, 'domains', '.move.lock'), cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const owner = (pid: number, proc_start: string | null, token = 'old-owner') =>
  JSON.stringify({ pid, proc_start, hostname: hostname(), started_at: '2026-10-16T12:00:00.000Z', token });

const tokenIn = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { token: string }).token;

test('a live owner keeps the lock: a second acquire waits, then refuses with MoveLockBusyError', () => {
  const d = dir();
  try {
    const first = acquireMoveLock(d.lock);
    const started = Date.now();
    assert.throws(() => acquireMoveLock(d.lock, { timeoutMs: 80, pollMs: 10 }), (e: unknown) => e instanceof MoveLockBusyError && e.owner?.token === first.token);
    assert.ok(Date.now() - started >= 80, 'it waited for the timeout');
    assert.equal(tokenIn(d.lock), first.token, 'the owner still holds it');
    assert.equal(releaseMoveLock(first), true);
    assert.equal(existsSync(d.lock), false);
  } finally {
    d.cleanup();
  }
});

test('a dead owner (kill(pid,0) fails) is taken over', () => {
  const d = dir();
  try {
    acquireMoveLock(d.lock); // creates the directory
    writeFileSync(d.lock, owner(424242, '100'));
    const h = acquireMoveLock(d.lock, { timeoutMs: 0, isAlive: () => false });
    assert.equal(tokenIn(d.lock), h.token);
  } finally {
    d.cleanup();
  }
});

test('a recycled pid (alive, but with a different start time) is taken over', () => {
  const d = dir();
  try {
    acquireMoveLock(d.lock);
    writeFileSync(d.lock, owner(4242, '100'));
    const startTimeOf = (pid: number) => (pid === 4242 ? '200' : '1');
    const h = acquireMoveLock(d.lock, { timeoutMs: 0, isAlive: () => true, startTimeOf });
    assert.equal(tokenIn(d.lock), h.token);
    // the same pid with its stored start time is a live owner and is honoured
    writeFileSync(d.lock, owner(4242, '200'));
    assert.throws(() => acquireMoveLock(d.lock, { timeoutMs: 0, isAlive: () => true, startTimeOf }), MoveLockBusyError);
  } finally {
    d.cleanup();
  }
});

test('without a process start time (no /proc) liveness alone decides, and the acquisition says so', () => {
  const d = dir();
  try {
    const h = acquireMoveLock(d.lock, { startTimeOf: () => null });
    assert.match(h.warning ?? '', /no process start time/);
    assert.throws(() => acquireMoveLock(d.lock, { timeoutMs: 0, startTimeOf: () => null }), MoveLockBusyError);
    releaseMoveLock(h);
  } finally {
    d.cleanup();
  }
});

test('release never deletes a lock another owner holds now', () => {
  const d = dir();
  try {
    const mine = acquireMoveLock(d.lock);
    writeFileSync(d.lock, owner(process.pid, null, 'someone-else'));
    assert.equal(releaseMoveLock(mine), false);
    assert.equal(tokenIn(d.lock), 'someone-else');
  } finally {
    d.cleanup();
  }
});

test('two or more concurrent takers of one stale lock: exactly one wins', async () => {
  const d = dir();
  try {
    acquireMoveLock(d.lock);
    // A pid that is certainly dead: a child that has already exited.
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(d.lock, owner(Number(gone.stdout), '1'));
    const modulePath = fileURLToPath(new URL('../move-lock.js', import.meta.url));
    const startAt = Date.now() + 400;
    const script = `
      const { acquireMoveLock, MoveLockBusyError } = await import(${JSON.stringify(modulePath)});
      while (Date.now() < ${startAt}) {}
      try {
        acquireMoveLock(${JSON.stringify(d.lock)}, { timeoutMs: 0 });
        process.stdout.write('won');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      } catch (e) {
        process.stdout.write(e instanceof MoveLockBusyError ? 'busy' : 'error:' + e.message);
      }`;
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise<string>((resolve) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
          let out = '';
          child.stdout.on('data', (c: Buffer) => (out += c.toString()));
          child.on('close', () => resolve(out));
        })
      )
    );
    assert.equal(runs.filter((r) => r === 'won').length, 1, `exactly one taker wins (got ${runs.join(', ')})`);
    assert.equal(runs.filter((r) => r === 'busy').length, 3, `the others are refused (got ${runs.join(', ')})`);
  } finally {
    d.cleanup();
  }
});

test('an empty lock file (opened but not yet written) is not taken over at once; only after the grace', () => {
  const d = dir();
  try {
    releaseMoveLock(acquireMoveLock(d.lock)); // creates the directory
    closeSync(openSync(d.lock, 'wx'));
    assert.throws(() => acquireMoveLock(d.lock, { timeoutMs: 0 }), MoveLockBusyError, 'a fresh empty file is honoured');
    assert.equal(readFileSync(d.lock, 'utf8'), '');
    const old = (Date.now() - UNPARSEABLE_GRACE_MS - 1000) / 1000;
    utimesSync(d.lock, old, old);
    const h = acquireMoveLock(d.lock, { timeoutMs: 0 });
    assert.equal(tokenIn(d.lock), h.token, 'an empty file past the grace is stale');
  } finally {
    d.cleanup();
  }
});

test('a lock never appears without its content, and a temp file left by a dead writer blocks no one', () => {
  const d = dir();
  try {
    releaseMoveLock(acquireMoveLock(d.lock));
    writeFileSync(`${d.lock}.tmp-left-by-a-crash`, '');
    const h = acquireMoveLock(d.lock, { timeoutMs: 0 });
    assert.equal(tokenIn(d.lock), h.token);
    const names = readdirSync(join(d.path, 'domains'));
    assert.deepEqual(names.filter((n) => n.startsWith('.move.lock.tmp-') && n !== '.move.lock.tmp-left-by-a-crash'), [], 'our own temp file is gone');
  } finally {
    d.cleanup();
  }
});

test('while another live process takes over a stale lock, the refusal says so instead of naming the dead owner', () => {
  const d = dir();
  try {
    releaseMoveLock(acquireMoveLock(d.lock));
    writeFileSync(d.lock, owner(424242, '100', 'dead-owner'));
    const ticket = `${d.lock}.takeover-${createHash('sha256').update(readFileSync(d.lock, 'utf8')).digest('hex').slice(0, 32)}`;
    writeFileSync(ticket, owner(process.pid, null, 'live-taker'));
    assert.throws(
      () => acquireMoveLock(d.lock, { timeoutMs: 0, isAlive: (pid) => pid !== 424242 }),
      (e: unknown) => e instanceof MoveLockBusyError && e.takeover && /another process is taking it over/.test(e.message) && !/424242/.test(e.message)
    );
  } finally {
    d.cleanup();
  }
});

test('a ticket left by a taker that died mid-takeover is not deleted; the next taker uses the next ticket and wins', () => {
  const d = dir();
  try {
    releaseMoveLock(acquireMoveLock(d.lock));
    writeFileSync(d.lock, owner(424242, '100', 'dead-owner'));
    const ticket = `${d.lock}.takeover-${createHash('sha256').update(readFileSync(d.lock, 'utf8')).digest('hex').slice(0, 32)}`;
    writeFileSync(ticket, owner(434343, '100', 'dead-taker'));
    const h = acquireMoveLock(d.lock, { timeoutMs: 0, isAlive: (pid) => pid !== 424242 && pid !== 434343 });
    assert.equal(tokenIn(d.lock), h.token);
    assert.deepEqual(readdirSync(join(d.path, 'domains')).filter((n) => n.includes('.takeover-')), [], 'the winner cleaned up every ticket');
  } finally {
    d.cleanup();
  }
});
