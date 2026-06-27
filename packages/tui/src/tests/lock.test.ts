import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTuiLock, releaseTuiLock, pidIsAlive, procStartTime } from '../lock.js';

test('tui lock: fresh acquire, live-owner refusal, stale takeover, garbage takeover, scoped release (§11 single instance)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-lock-'));
  const lock = join(dir, 'transient', 'tui.lock');
  try {
    const alive = (pid: number) => pid === 100; // injected liveness: only pid 100 lives
    const noToken = () => null; // platform without /proc → bare-pid lock, liveness only
    assert.equal(acquireTuiLock(lock, 100, alive, noToken), null, 'fresh lock acquired (creates the transient dir)');
    assert.equal(readFileSync(lock, 'utf8'), '100', 'no identity token → bare pid');

    assert.equal(acquireTuiLock(lock, 200, alive, noToken), 100, 'live owner turns the second instance away');
    assert.equal(readFileSync(lock, 'utf8'), '100', 'lock untouched by the refused instance');

    assert.equal(acquireTuiLock(lock, 100, alive, noToken), null, 're-entrant acquire by the owner is fine');

    const dead = () => false;
    assert.equal(acquireTuiLock(lock, 300, dead, noToken), null, 'dead owner: stale lock taken over');
    assert.equal(readFileSync(lock, 'utf8'), '300');

    writeFileSync(lock, 'not-a-pid');
    assert.equal(acquireTuiLock(lock, 400, alive, noToken), null, 'garbage lock content is taken over, not fatal');
    assert.equal(readFileSync(lock, 'utf8'), '400');

    releaseTuiLock(lock, 999);
    assert.ok(existsSync(lock), 'release by a non-owner never clobbers the lock');
    releaseTuiLock(lock, 400);
    assert.ok(!existsSync(lock), 'owner release removes the lock');
    releaseTuiLock(lock, 400); // tolerates an already-missing lock

    assert.equal(pidIsAlive(process.pid), true, 'own pid reads alive');
    assert.equal(pidIsAlive(0), false, 'non-positive pids are never alive');
    assert.equal(pidIsAlive(-5), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tui lock: a recycled pid (alive but different start-time) is taken over, not honored (§11 pid-reuse)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-lock-'));
  const lock = join(dir, 'transient', 'tui.lock');
  try {
    const alive = () => true; // the pid NUMBER is always "alive" — the reuse trap a bare kill(pid,0) falls into

    // owner 500 acquires with start-time AAA, then dies; the OS hands pid 500 to
    // an unrelated, live process whose start-time is now BBB.
    assert.equal(acquireTuiLock(lock, 500, alive, () => 'AAA'), null, 'owner 500 acquires with token AAA');
    assert.equal(readFileSync(lock, 'utf8'), '500 AAA', 'lock stores pid + identity token');

    const reused = (pid: number) => (pid === 500 ? 'BBB' : 'CCC'); // 500 is now a DIFFERENT process
    assert.equal(acquireTuiLock(lock, 600, alive, reused), null, 'recycled pid is NOT honored — new TUI takes over');
    assert.equal(readFileSync(lock, 'utf8'), '600 CCC', 'the new owner rewrites the lock with its own token');

    // continuity: same pid, same token → a genuinely live owner still refuses a second instance
    assert.equal(acquireTuiLock(lock, 700, alive, (p) => (p === 600 ? 'CCC' : 'DDD')), 600, 'matching token → live owner refuses the second instance');

    // back-compat: a legacy bare-pid lock (no token) with a live owner is still honored
    writeFileSync(lock, '600');
    assert.equal(acquireTuiLock(lock, 800, alive, () => 'EEE'), 600, 'legacy bare-pid lock falls back to liveness');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tui lock: procStartTime reads a token for a live pid and null for a dead one', () => {
  assert.equal(procStartTime(2_147_483_646), null, 'no such pid → null token');
  if (process.platform === 'linux') {
    assert.equal(typeof procStartTime(process.pid), 'string', 'live self pid has a start-time token on Linux');
  }
});
