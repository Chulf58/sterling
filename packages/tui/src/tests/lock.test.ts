import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTuiLock, releaseTuiLock, pidIsAlive } from '../lock.js';

test('tui lock: fresh acquire, live-owner refusal, stale takeover, garbage takeover, scoped release (§11 single instance)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-lock-'));
  const lock = join(dir, 'transient', 'tui.lock');
  try {
    const alive = (pid: number) => pid === 100; // injected liveness: only pid 100 lives
    assert.equal(acquireTuiLock(lock, 100, alive), null, 'fresh lock acquired (creates the transient dir)');
    assert.equal(readFileSync(lock, 'utf8'), '100');

    assert.equal(acquireTuiLock(lock, 200, alive), 100, 'live owner turns the second instance away');
    assert.equal(readFileSync(lock, 'utf8'), '100', 'lock untouched by the refused instance');

    assert.equal(acquireTuiLock(lock, 100, alive), null, 're-entrant acquire by the owner is fine');

    const dead = () => false;
    assert.equal(acquireTuiLock(lock, 300, dead), null, 'dead owner: stale lock taken over');
    assert.equal(readFileSync(lock, 'utf8'), '300');

    writeFileSync(lock, 'not-a-pid');
    assert.equal(acquireTuiLock(lock, 400, alive), null, 'garbage lock content is taken over, not fatal');
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
