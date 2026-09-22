// KERNEL-HELD register lock — scripts/lib/dispatch-register.mjs withRegisterLock.
//
// CONTRACT SOURCE: decision
// `dispatch-register-lock-reclaims-an-ownerless-lock-and-releases-only-its-own`
// (REVISED block): the register lock is a SQLite `BEGIN IMMEDIATE` transaction
// on a never-unlinked lock database at /tmp/sterling-locks/<hash of the
// resolved project root>.db, held for the whole critical section. The kernel
// drops the lock when the holder dies, so there is no reclaim, no rename, no
// owner file and no tombstone.
//
// These pins are the scenarios the retired mkdir-reclaim protocol could not
// rule out, and which the kernel lock must make impossible by construction:
//   (a) a holder that dies mid-section (process.exit, SIGKILL) leaves nothing
//       behind — the next acquirer gets the lock on its first attempt;
//   (b) N processes contending never interleave inside the section;
//   (c) a PAUSED live holder is never displaced — a contender waits up to its
//       bound, refuses with register_lock_held and never enters.
// Every holder here is a REAL separate process, because cross-process
// exclusion is the property the primitive exists for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as REG from '../lib/dispatch-register.mjs';

const LIB_URL = pathToFileURL(join(dirname(new URL(import.meta.url).pathname), '..', 'lib', 'dispatch-register.mjs')).href;

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-kernel-lock-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  return {
    dir,
    cleanup: () => {
      rmSync(REG.registerLockPath(dir), { force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function refusalOf(fn) {
  try {
    return { value: await fn() };
  } catch (err) {
    return { code: err?.code, facts: err?.facts, err };
  }
}

async function captureStderr(fn) {
  const orig = process.stderr.write;
  let text = '';
  process.stderr.write = (chunk, ...rest) => {
    text += String(chunk);
    const cb = rest.find((r) => typeof r === 'function');
    if (cb) cb();
    return true;
  };
  try {
    return { value: await fn(), text };
  } finally {
    process.stderr.write = orig;
  }
}

// A child process that takes the register lock for `root` and then runs
// `body` (JS source, an async function body with `out` = a line writer)
// INSIDE the critical section. It prints IN once the lock is held.
function lockChild(root, body, { timeoutMs = 10_000, retryMs = 5 } = {}) {
  const src = `
    import { withRegisterLock } from ${JSON.stringify(LIB_URL)};
    import { appendFileSync } from 'node:fs';
    const out = (s) => process.stdout.write(s + '\\n');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await withRegisterLock(${JSON.stringify(root)}, async () => { out('IN'); ${body} }, { timeoutMs: ${timeoutMs}, retryMs: ${retryMs} });
      out('RELEASED');
    } catch (e) {
      out('REFUSED ' + (e?.code ?? e?.message ?? String(e)));
      process.exitCode = 3;
    }
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })));
  const entered = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (/^IN$/m.test(stdout)) resolve(); });
    exited.then((r) => reject(new Error(`child exited before entering the lock: ${JSON.stringify(r)}`)));
  });
  return { child, entered, exited };
}

// Residue check: the lock database is the ONLY file the lock leaves (no
// -journal / -wal / -shm, no owner file), and nothing lock-shaped is created
// under the project's .sterling/transient/.
function assertNoResidue(dir) {
  const db = REG.registerLockPath(dir);
  const siblings = readdirSync(dirname(db)).filter((f) => f.startsWith(basename(db)));
  assert.deepEqual(siblings, [basename(db)], `only the lock database itself remains beside it: ${JSON.stringify(siblings)}`);
  const transient = readdirSync(join(dir, '.sterling', 'transient'));
  assert.deepEqual(transient.filter((f) => f.includes('lock')), [], `no lock residue under .sterling/transient: ${JSON.stringify(transient)}`);
}

// ===========================================================================
// Location — native ext4 under /tmp, never the project tree (drvfs on /mnt/c).
// ===========================================================================

test('KL-0: the lock database lives at /tmp/sterling-locks/<hash>.db — stable per resolved root, distinct across roots, never inside the project', async () => {
  const a = project();
  const b = project();
  const alias = `${a.dir}-alias`;
  try {
    symlinkSync(a.dir, alias);
    const p = REG.registerLockPath(a.dir);
    assert.match(p, /^\/tmp\/sterling-locks\/[0-9a-f]{32,}\.db$/, `lock path shape: ${p}`);
    assert.equal(REG.registerLockPath(a.dir), p, 'stable for the same root');
    assert.equal(REG.registerLockPath(alias), p, 'the RESOLVED root is hashed — a symlinked path to the same project shares its lock');
    assert.notEqual(REG.registerLockPath(b.dir), p, 'a different project gets a different lock');
    assert.ok(!p.startsWith(a.dir), 'the lock is never inside the project tree');

    await REG.withRegisterLock(a.dir, () => 'ok', { timeoutMs: 200 });
    const mode = statSync('/tmp/sterling-locks').mode & 0o777;
    assert.equal(mode, 0o700, `the lock directory is private (0700), got ${mode.toString(8)}`);
  } finally {
    rmSync(alias, { force: true });
    a.cleanup();
    b.cleanup();
  }
});

// ===========================================================================
// (a) a holder that dies mid-section leaves no stale lock.
// ===========================================================================

for (const [label, how] of [
  ['process.exit inside the section', 'process.exit(1);'],
  ['SIGKILL while inside the section', 'await new Promise(() => setInterval(() => {}, 1000));'],
]) {
  test(`KL-a: a holder that dies mid-critical-section (${label}) frees the lock at once — the next acquirer enters on its FIRST attempt, no residue`, async () => {
    const { dir, cleanup } = project();
    try {
      const holder = lockChild(dir, how);
      await holder.entered;
      if (how.startsWith('await')) holder.child.kill('SIGKILL');
      const died = await holder.exited;
      assert.ok(died.code === 1 || died.signal === 'SIGKILL', `harness: the holder died inside the section: ${JSON.stringify(died)}`);
      assert.doesNotMatch(died.stdout, /RELEASED/, 'harness: the holder never released cooperatively');

      const t0 = Date.now();
      let ran = false;
      const v = await REG.withRegisterLock(dir, () => { ran = true; return 'next'; }, { timeoutMs: 0, retryMs: 10 });
      assert.equal(v, 'next');
      assert.equal(ran, true, 'a dead holder holds nothing — no reclaim step, no age wait');
      assert.ok(Date.now() - t0 < 500, `acquired without waiting: ${Date.now() - t0}ms`);
      assertNoResidue(dir);
    } finally {
      cleanup();
    }
  });
}

// ===========================================================================
// (b) mutual exclusion across N real processes.
// ===========================================================================

test('KL-b: N concurrent processes never both inside the critical section — every start/end pair in the shared log is adjacent', async () => {
  const { dir, cleanup } = project();
  const N = 6;
  const log = join(dir, 'section.log');
  try {
    const kids = Array.from({ length: N }, (_, i) =>
      lockChild(
        dir,
        `appendFileSync(${JSON.stringify(log)}, 'start ${i}\\n'); await sleep(25); appendFileSync(${JSON.stringify(log)}, 'end ${i}\\n');`,
        { timeoutMs: 20_000, retryMs: 5 }
      )
    );
    const results = await Promise.all(kids.map((k) => k.exited));
    for (const r of results) assert.equal(r.code, 0, `every contender eventually got in: ${JSON.stringify(r)}`);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2 * N, `every section ran exactly once: ${JSON.stringify(lines)}`);
    for (let k = 0; k < lines.length; k += 2) {
      const [s, i] = lines[k].split(' ');
      assert.equal(s, 'start', `line ${k} opens a section: ${JSON.stringify(lines)}`);
      assert.equal(lines[k + 1], `end ${i}`, `section ${i} closed before any other opened — no interleaving: ${JSON.stringify(lines)}`);
    }
    assertNoResidue(dir);
  } finally {
    cleanup();
  }
});

// In-process contenders use separate connections to the same database and
// exclude each other too (SQLite tracks locks per inode within one process).
test('KL-b2: two in-process contenders never overlap their critical sections, and the lock is free again afterwards', async () => {
  const { dir, cleanup } = project();
  try {
    let inside = 0;
    let maxInside = 0;
    const body = async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((res) => setTimeout(res, 40));
      inside -= 1;
      return 'ok';
    };
    const results = await Promise.all([
      refusalOf(() => REG.withRegisterLock(dir, body, { retryMs: 10, timeoutMs: 3000 })),
      refusalOf(() => REG.withRegisterLock(dir, body, { retryMs: 10, timeoutMs: 3000 })),
    ]);
    assert.equal(maxInside, 1, 'the two critical sections must never be inside the lock at once');
    for (const r of results) assert.equal(r.value, 'ok', `both got in within the bound: ${JSON.stringify(r)}`);
    assert.equal(await REG.withRegisterLock(dir, () => 'again', { timeoutMs: 0 }), 'again', 'released: the next single attempt succeeds');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (c) a paused live holder is never displaced.
// ===========================================================================

// The holder pauses on a promise NOTHING references. That is deliberate and
// load-bearing: measured 2026-09-22, such a holder's suspended frame was
// garbage-collected with its connection, and the finalizer's close released
// the lock mid-section (this test went red within 60ms) until withRegisterLock
// pinned every held connection. SABOTAGE: drop heldConnections -> red.
test('KL-c: a PAUSED holder (sleeping inside the section) makes a contender wait up to its bound, then refuse with register_lock_held — it never enters, and the holder keeps the lock', async () => {
  const { dir, cleanup } = project();
  const holder = lockChild(dir, 'await new Promise(() => setInterval(() => {}, 1000));');
  try {
    await holder.entered;
    let ran = false;
    const t0 = Date.now();
    const r = await refusalOf(() => REG.withRegisterLock(dir, () => { ran = true; }, { timeoutMs: 300, retryMs: 20 }));
    const waited = Date.now() - t0;
    assert.equal(r.code, 'register_lock_held', `expected register_lock_held, got ${JSON.stringify(r)}`);
    assert.equal(ran, false, 'the contender never entered the section');
    assert.ok(waited >= 280, `it waited out its bound before refusing: ${waited}ms`);
    assert.ok(waited < 1500, `and not much longer: ${waited}ms`);
    assert.equal(r.facts?.lock_path, REG.registerLockPath(dir), 'the refusal names the lock database');

    const again = await refusalOf(() => REG.withRegisterLock(dir, () => { ran = true; }, { timeoutMs: 0 }));
    assert.equal(again.code, 'register_lock_held', 'the paused holder STILL holds the lock — nothing displaced it');
    assert.equal(holder.child.exitCode, null, 'harness: the holder is still alive');
  } finally {
    holder.child.kill('SIGKILL');
    await holder.exited;
    cleanup();
  }
});

test('KL-c2: an error thrown inside the section propagates unchanged AND releases the lock', async () => {
  const { dir, cleanup } = project();
  try {
    const boom = new Error('boom');
    const r = await refusalOf(() => REG.withRegisterLock(dir, () => { throw boom; }, { timeoutMs: 200 }));
    assert.equal(r.err, boom, 'fn\'s own error, not a lock error');
    assert.equal(await REG.withRegisterLock(dir, () => 'free', { timeoutMs: 0 }), 'free');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Legacy mkdir lock directory — ignored for locking; an EMPTY one is residue.
// ===========================================================================

test('KL-L1: a leftover EMPTY legacy dispatch-register.lock dir never blocks — it is removed as residue and said once on stderr', async () => {
  const { dir, cleanup } = project();
  try {
    const legacy = REG.legacyRegisterLockDir(dir);
    assert.equal(legacy, join(dir, '.sterling', 'transient', 'dispatch-register.lock'));
    mkdirSync(legacy);
    const { value, text } = await captureStderr(() => REG.withRegisterLock(dir, () => 'entered', { timeoutMs: 0 }));
    assert.equal(value, 'entered', 'the legacy dir is not a lock any more');
    assert.equal(existsSync(legacy), false, 'the empty legacy dir is removed');
    const mentions = text.split('\n').filter((l) => l.includes(legacy));
    assert.equal(mentions.length, 1, `said exactly once: ${JSON.stringify(text)}`);
    assert.match(mentions[0], /residue/i);

    const second = await captureStderr(() => REG.withRegisterLock(dir, () => 'again', { timeoutMs: 0 }));
    assert.equal(second.text, '', 'nothing more to say once it is gone');
  } finally {
    cleanup();
  }
});

test('KL-L2: a NON-empty legacy lock dir (an old owner.json) never blocks either — it is LEFT in place and warned about', async () => {
  const { dir, cleanup } = project();
  try {
    const legacy = REG.legacyRegisterLockDir(dir);
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'owner.json'), JSON.stringify({ pid: process.pid, host: 'h', at: new Date().toISOString(), nonce: 'old' }));
    let ran = false;
    const { text } = await captureStderr(() => REG.withRegisterLock(dir, () => { ran = true; }, { timeoutMs: 0 }));
    assert.equal(ran, true, 'a live-looking legacy owner is not a holder of the kernel lock');
    assert.equal(existsSync(join(legacy, 'owner.json')), true, 'a non-empty legacy dir is never deleted');
    assert.ok(text.includes(legacy), `the leftover is warned about by path: ${JSON.stringify(text)}`);
  } finally {
    cleanup();
  }
});
