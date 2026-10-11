// touches.json's lock (withFileLock, scripts/hooks/lib/settlement.mjs) is the
// kernel-held lock from session-events.mjs (board 86faf740, user-ruled
// 2026-10-11 "Wait 5 s, then warn"): a contender waits up to 5 s, then skips
// its write and warns, naming the lost touch. It never writes unlocked and
// never takes a live holder's lock because the lock is old.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TOUCHES_LOCK_HELD, withFileLock } from '../hooks/lib/settlement.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETTLEMENT = pathToFileURL(join(root, 'scripts', 'hooks', 'lib', 'settlement.mjs')).href;
const H7 = join(root, 'scripts', 'hooks', 'h7-file-touch.mjs');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-touches-lock-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  return { dir, touchesPath: join(dir, '.sterling', 'transient', 'touches.json') };
}

// A child process that takes the touches lock, appends 'enter <ms>' to logPath, holds the
// lock for holdMs, appends 'exit <ms>', and releases. It writes nothing to touches.json.
function spawnHolder(touchesPath, logPath, holdMs) {
  const src = `
import { appendFileSync } from 'node:fs';
const { withFileLock } = await import(${JSON.stringify(SETTLEMENT)});
withFileLock(${JSON.stringify(touchesPath)}, () => {
  appendFileSync(${JSON.stringify(logPath)}, 'holder enter ' + Date.now() + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
  appendFileSync(${JSON.stringify(logPath)}, 'holder exit ' + Date.now() + '\\n');
});
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })));
  return { child, done };
}

async function waitForHolder(logPath) {
  for (let i = 0; i < 200; i++) {
    if (existsSync(logPath) && readFileSync(logPath, 'utf8').includes('holder enter')) return;
    await delay(25);
  }
  throw new Error('holder never took the lock');
}

function runH7(dir, rel) {
  return spawnSync(process.execPath, [H7], {
    input: JSON.stringify({
      session_id: 's1',
      transcript_path: join(dir, 't', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(dir, rel) },
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
}

async function makeStoreProject() {
  const p = makeProject();
  const { SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href);
  new SterlingStore(join(p.dir, '.sterling', 'sterling.db')).close();
  return p;
}

test('withFileLock: a held lock past the timeout runs nothing, calls onTimeout and throws touches_lock_held', async () => {
  const { dir, touchesPath } = makeProject();
  const logPath = join(dir, 'log');
  try {
    writeFileSync(touchesPath, JSON.stringify([{ path: 'seed.txt', at: 'x' }]));
    const holder = spawnHolder(touchesPath, logPath, 2500);
    await waitForHolder(logPath);
    let ran = false;
    let timedOut = 0;
    const started = Date.now();
    assert.throws(
      () => withFileLock(touchesPath, () => { ran = true; writeFileSync(touchesPath, '[]'); }, { onTimeout: () => timedOut++, timeoutMs: 400 }),
      (e) => e.code === TOUCHES_LOCK_HELD && /skipped this write and wrote nothing/.test(e.message)
    );
    assert.ok(Date.now() - started >= 350, 'the contender waited for the lock before giving up');
    assert.equal(ran, false, 'fn never ran without the lock');
    assert.equal(timedOut, 1, 'onTimeout ran once');
    assert.deepEqual(JSON.parse(readFileSync(touchesPath, 'utf8')), [{ path: 'seed.txt', at: 'x' }], 'touches.json is unchanged');
    assert.equal((await holder.done).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H7: with the touches lock held past 5 s, the touch is skipped, nothing is written unlocked, and the warning names the lost touch', async () => {
  const { dir, touchesPath } = await makeStoreProject();
  const logPath = join(dir, 'log');
  try {
    writeFileSync(touchesPath, JSON.stringify([{ path: 'seed.txt', at: 'x' }]));
    const holder = spawnHolder(touchesPath, logPath, 8000);
    await waitForHolder(logPath);
    const started = Date.now();
    const r = runH7(dir, 'src/lost.ts');
    const waited = Date.now() - started;
    assert.equal(r.status, 1, `H7 warns non-blocking (exit 1); stderr: ${r.stderr}`);
    assert.match(r.stderr, /src\/lost\.ts/, 'the warning names the lost touch');
    assert.match(r.stderr, /skipped this write and wrote nothing/);
    assert.ok(waited >= 4800, `H7 waited about 5 s for the lock (waited ${waited} ms)`);
    assert.deepEqual(JSON.parse(readFileSync(touchesPath, 'utf8')), [{ path: 'seed.txt', at: 'x' }], 'no unlocked write landed');
    holder.child.kill('SIGKILL');
    await holder.done;
    // The OS released the killed holder's lock: the next touch lands at once.
    const after = runH7(dir, 'src/next.ts');
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(JSON.parse(readFileSync(touchesPath, 'utf8')).map((t) => t.path), ['seed.txt', 'src/next.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withFileLock: a live holder inside fn past the old 3 s stale age keeps the lock; the contender enters only after it exits', async () => {
  const { dir, touchesPath } = makeProject();
  const logPath = join(dir, 'log');
  try {
    const holder = spawnHolder(touchesPath, logPath, 3800);
    await waitForHolder(logPath);
    withFileLock(touchesPath, () => writeFileSync(logPath, readFileSync(logPath, 'utf8') + `contender enter ${Date.now()}\n`));
    assert.equal((await holder.done).code, 0);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((l) => l.split(' ').slice(0, 2).join(' ')), ['holder enter', 'holder exit', 'contender enter']);
    const at = (name) => Number(lines.find((l) => l.startsWith(name)).split(' ').pop());
    assert.ok(at('contender enter') >= at('holder exit'), 'the contender never entered while the holder was inside fn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withFileLock: 10 processes doing a slow read-modify-write of touches.json lose no touch', async () => {
  const { dir, touchesPath } = makeProject();
  try {
    const src = (i) => `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const { withFileLock, parseTouchesContent } = await import(${JSON.stringify(SETTLEMENT)});
const p = ${JSON.stringify(touchesPath)};
withFileLock(p, () => {
  const touches = existsSync(p) ? parseTouchesContent(readFileSync(p, 'utf8')) : [];
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  touches.push({ path: 'f${i}.ts', at: 'x' });
  writeFileSync(p, JSON.stringify(touches));
});
`;
    const runs = Array.from({ length: 10 }, (_, i) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', src(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })));
    });
    for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.stderr);
    const paths = JSON.parse(readFileSync(touchesPath, 'utf8')).map((t) => t.path).sort();
    assert.deepEqual(paths, Array.from({ length: 10 }, (_, i) => `f${i}.ts`).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H7: 8 concurrent hook runs each register their touch', async () => {
  const { dir, touchesPath } = await makeStoreProject();
  try {
    const runs = Array.from({ length: 8 }, (_, i) => {
      const child = spawn(process.execPath, [H7], { cwd: dir, env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' }, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.stdin.end(
        JSON.stringify({ session_id: 's1', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, `c${i}.ts`) } })
      );
      return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })));
    });
    for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.stderr);
    const paths = JSON.parse(readFileSync(touchesPath, 'utf8')).map((t) => t.path).sort();
    assert.deepEqual(paths, Array.from({ length: 8 }, (_, i) => `c${i}.ts`).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
