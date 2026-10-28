import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lib from '../lib/opencode-api.mjs';

const { opencodeApi } = lib;

let stateDir;
let savedStateHome;
const serviceUrl = 'http://127.0.0.1:12345';
const fixturePassword = 'not-a-real-password';
const serviceFile = () => join(stateDir, 'opencode', 'service.json');
const registerService = (url = serviceUrl) => writeFileSync(serviceFile(), JSON.stringify({ url, password: fixturePassword }));

beforeEach(() => {
  savedStateHome = process.env.XDG_STATE_HOME;
  stateDir = mkdtempSync(join(tmpdir(), 'opencode-api-state-'));
  mkdirSync(join(stateDir, 'opencode'));
  process.env.XDG_STATE_HOME = stateDir;
  registerService();
});

afterEach(() => {
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  rmSync(stateDir, { recursive: true, force: true });
});

test('every call uses the registered explicit server and its password, never managed-service recovery', async () => {
  const fake = fakeOpencode('{}', { before: `
if [ "$4" != --server ] || [ "$5" != '${serviceUrl}' ] || [ "$OPENCODE_PASSWORD" != '${fixturePassword}' ]; then exit 9; fi
` });
  const previous = process.env.OPENCODE_PASSWORD;
  process.env.OPENCODE_PASSWORD = 'unrelated-fixture-password';
  try {
    const r = await opencodeApi(fake.bin, 'GET', '/api/session/active', undefined, 10_000);
    assert.equal(r.code, 0, 'explicit URL and registration password must reach the CLI');
    assert.equal(r.stdout, '{}');
    assert.equal(process.env.OPENCODE_PASSWORD, 'unrelated-fixture-password', 'parent environment is unchanged');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PASSWORD;
    else process.env.OPENCODE_PASSWORD = previous;
    fake.cleanup();
  }
});

test('a NUL in the registration password fails safely before starting the binary', async () => {
  const marker = join(stateDir, 'started');
  const fake = fakeOpencode('{}', { before: `touch '${marker}'` });
  const password = 'SYNTHETIC-ONLY-abcdefghijklmNOPQRSTUVWXYZ0123456789'.repeat(4);
  try {
    writeFileSync(serviceFile(), JSON.stringify({ url: serviceUrl, password: `${password}\0${password}` }));
    let result;
    let thrown;
    try {
      result = await opencodeApi(fake.bin, 'GET', '/api/session/active', undefined, 10_000);
    } catch (err) {
      thrown = err;
    }
    const output = JSON.stringify(result) + String(thrown ?? '');
    for (let i = 0; i <= password.length - 8; i++) {
      assert.ok(!output.includes(password.slice(i, i + 8)), 'a password fragment escaped');
    }
    assert.equal(thrown, undefined, 'invalid credentials must return a failure, not throw');
    assert.deepEqual(result, { code: 1, stdout: '', stderr: 'OpenCode service password cannot be used in the child environment' });
    assert.equal(existsSync(marker), false, 'the CLI must not start with invalid credentials');
  } finally {
    fake.cleanup();
  }
});

test('a synchronous spawn failure returns only a fixed sanitized error', async () => {
  let result;
  let threw = false;
  try {
    result = await opencodeApi('invalid-binary\0private-argument-bytes', 'GET', '/api/session/active', undefined, 10_000);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'spawn validation errors must not escape');
  assert.deepEqual(result, { code: 1, stdout: '', stderr: 'OpenCode API process could not start' });
});

test('the child receives only allowlisted environment variables and the registration password', async () => {
  const values = {
    SOME_SERVICE_SECRET: 'unrelated-synthetic-sentinel',
    OPENCODE_PASSWORD: 'unrelated-fixture-password',
    OPENCODE_TEST_ALLOWLIST: 'cli-config-fixture',
    XDG_TEST_ALLOWLIST: 'state-config-fixture',
    LC_TEST_ALLOWLIST: 'locale-fixture',
    LANGUAGE: 'en',
    SSL_CERT_DIR: '/synthetic-cert-dir',
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const fake = fakeOpencode('{}', { before: `
if [ "\${SOME_SERVICE_SECRET+x}" = x ]; then exit 8; fi
if [ "$OPENCODE_PASSWORD" != '${fixturePassword}' ]; then exit 9; fi
if [ "$OPENCODE_TEST_ALLOWLIST" != cli-config-fixture ] || [ "$XDG_TEST_ALLOWLIST" != state-config-fixture ] || [ "$LC_TEST_ALLOWLIST" != locale-fixture ] || [ "$LANGUAGE" != en ] || [ "$SSL_CERT_DIR" != /synthetic-cert-dir ] || [ -z "$PATH" ]; then exit 10; fi
` });
  try {
    Object.assign(process.env, values);
    const r = await opencodeApi(fake.bin, 'GET', '/api/session/active', undefined, 10_000);
    assert.equal(r.code, 0, 'the child environment must omit unrelated secrets and keep CLI settings');
    assert.equal(r.stdout, '{}');
    assert.equal(process.env.SOME_SERVICE_SECRET, values.SOME_SERVICE_SECRET);
    assert.equal(process.env.OPENCODE_PASSWORD, values.OPENCODE_PASSWORD);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fake.cleanup();
  }
});

test('missing or invalid registration fails loud without starting the binary or leaking registration bytes', async () => {
  const marker = join(stateDir, 'started');
  const fake = fakeOpencode('{}', { before: `touch '${marker}'` });
  const sensitive = 'registration-content-must-not-appear';
  try {
    for (const text of [null, sensitive, JSON.stringify({ url: sensitive, password: sensitive }), JSON.stringify({ url: serviceUrl })]) {
      if (text === null) rmSync(serviceFile());
      else writeFileSync(serviceFile(), text);
      const r = await opencodeApi(fake.bin, 'GET', '/api/session/active', undefined, 10_000);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /OpenCode service file/);
      assert.ok(!r.stderr.includes(sensitive));
      assert.equal(existsSync(marker), false, 'no fallback to the managed service');
    }
  } finally {
    fake.cleanup();
  }
});

test('each call rereads the registration so a replaced server is picked up', async () => {
  const fake = fakeOpencode('{}', { before: 'echo "$*" >&2' });
  try {
    const first = await opencodeApi(fake.bin, 'GET', '/api/session/active', undefined, 10_000);
    assert.match(first.stderr, /--server http:\/\/127\.0\.0\.1:12345/);
    registerService('http://127.0.0.1:23456');
    const next = await opencodeApi(fake.bin, 'GET', '/api/session/active', undefined, 10_000);
    assert.match(next.stderr, /--server http:\/\/127\.0\.0\.1:23456/);
  } finally {
    fake.cleanup();
  }
});

// A stand-in for opencode 2.0.23's `api` command: it writes the whole reply when stdout is a
// file, but only its first 64 KB otherwise (a pipe or socket), as the real binary did with a
// 2.5 MB message page of a busy session (exit code 0 both ways).
function fakeOpencode(reply, { before = '', after = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-opencode-'));
  const payload = join(dir, 'reply.json');
  writeFileSync(payload, reply);
  const bin = join(dir, 'opencode');
  writeFileSync(bin, `#!/bin/bash\n${before}\nif [ -f /dev/stdout ]; then cat '${payload}'; else head -c 65536 '${payload}'; fi\n${after}\n`);
  chmodSync(bin, 0o755);
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const bigPage = () => JSON.stringify({ data: [{ id: 'msg_1', time: { created: 1 }, text: '[watch] x', files: [{ url: `data:image/png;base64,${'A'.repeat(1_000_000)}` }] }], cursor: { next: 'c' } });

test('regression: a large reply reaches the reader whole (the watcher stopped on a cut 2.5 MB message page)', async () => {
  const reply = bigPage();
  const fake = fakeOpencode(reply);
  try {
    const r = await opencodeApi(fake.bin, 'GET', '/api/session/ses_x/message?limit=50&type=user&order=desc', undefined, 10_000);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.length, reply.length, 'the whole reply, not the part a pipe held when the process exited');
    assert.deepEqual(JSON.parse(r.stdout), JSON.parse(reply));
  } finally {
    fake.cleanup();
  }
});

test('opencodeApi passes method, path and body, keeps stderr and the exit code, and leaves no temp file', async () => {
  const fake = fakeOpencode('{"data":[]}', { before: 'echo "$*" >&2', after: 'if [ "$2" = post ]; then exit 3; fi' });
  // os.tmpdir() reads TMPDIR on each call, so the wrapper's temp folder goes under a directory only
  // this test uses; other processes' sterling-api-* files elsewhere cannot change the count.
  const priv = mkdtempSync(join(tmpdir(), 'opencode-api-tmpcount-'));
  const leftovers = () => readdirSync(priv).length;
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = priv;
  try {
    const r = await opencodeApi(fake.bin, 'POST', '/api/session/ses_x/prompt', '{"text":"t"}', 10_000);
    assert.equal(r.code, 3);
    assert.equal(r.stdout, '{"data":[]}');
    assert.equal(r.stderr.trim(), `api post /api/session/ses_x/prompt -d {"text":"t"} --server ${serviceUrl}`);
    assert.equal(leftovers(), 0, 'the wrapper left a file or folder in its temp directory');
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    rmSync(priv, { recursive: true, force: true });
    fake.cleanup();
  }
});

test('opencodeApi kills a call that outlasts timeoutMs and answers code 124', async () => {
  const fake = fakeOpencode('{}', { before: 'exec sleep 5' });
  try {
    const r = await opencodeApi(fake.bin, 'GET', '/api/session', undefined, 200);
    assert.equal(r.code, 124);
    const budget = Number(r.stderr.match(/timed out after (\d+) ms/)[1]);
    assert.ok(budget > 0 && budget <= 200, `remaining timeout budget was ${budget} ms`);
  } finally {
    fake.cleanup();
  }
});

test('regression: a timeout settles on time even when a subprocess of the binary still holds stderr open', async () => {
  // A wrapper that runs its work without exec: killing the wrapper leaves `sleep` holding stderr.
  const fake = fakeOpencode('{}', { before: 'sleep 3' });
  const started = Date.now();
  try {
    const r = await opencodeApi(fake.bin, 'GET', '/api/session', undefined, 100);
    const elapsed = Date.now() - started;
    assert.equal(r.code, 124);
    const budget = Number(r.stderr.match(/timed out after (\d+) ms/)[1]);
    assert.ok(budget > 0 && budget <= 100, `remaining timeout budget was ${budget} ms`);
    assert.ok(elapsed < 1500, `settled after ${elapsed} ms, not at the 100 ms timeout`);
  } finally {
    fake.cleanup();
  }
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('regression: Ctrl-C to the caller also stops the opencode api child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-api-sigint-'));
  const pidFile = join(dir, 'child.pid');
  const fake = fakeOpencode('{}', { before: `echo $$ > '${pidFile}'; exec sleep 30` });
  const caller = join(dir, 'caller.mjs');
  const libUrl = new URL('../lib/opencode-api.mjs', import.meta.url).href;
  writeFileSync(caller, `import { opencodeApi } from '${libUrl}';\nawait opencodeApi('${fake.bin}', 'GET', '/api/session', undefined, 60_000);\n`);
  // The caller gets its own process group, standing in for a terminal's foreground group,
  // so the SIGINT below does not reach the test runner. Its temp files go under `dir`, where
  // the test can see what an interrupted call leaves (a signal runs no finally).
  const proc = spawn(process.execPath, [caller], { detached: true, stdio: 'ignore', env: { ...process.env, TMPDIR: dir } });
  let childPid = null;
  try {
    for (let i = 0; i < 100 && childPid === null; i++) {
      await sleepMs(50);
      if (existsSync(pidFile)) childPid = Number(readFileSync(pidFile, 'utf8').trim()) || null;
    }
    assert.ok(childPid, 'the fake opencode started');
    process.kill(-proc.pid, 'SIGINT');
    for (let i = 0; i < 20 && alive(childPid); i++) await sleepMs(50);
    assert.equal(alive(childPid), false, `opencode api child ${childPid} still runs 1 s after Ctrl-C to its caller`);
    // The reply file is unlinked before the child starts, so an interrupted call leaves no reply on disk.
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('sterling-api-')), [], 'an interrupted call left its reply directory behind');
  } finally {
    for (const pid of [childPid, -proc.pid]) {
      try {
        if (pid) process.kill(pid, 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencodeApi keeps only the tail of an oversized stderr and says it was cut', async () => {
  const MAX_STDERR = lib.MAX_STDERR;
  assert.equal(typeof MAX_STDERR, 'number', 'the module states its stderr cap');
  const fake = fakeOpencode('{}', { before: `head -c ${MAX_STDERR * 2} /dev/zero | tr '\\0' x >&2; echo END >&2` });
  try {
    const r = await opencodeApi(fake.bin, 'GET', '/api/session', undefined, 10_000);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.length <= MAX_STDERR + 200, `stderr is ${r.stderr.length} chars`);
    assert.match(r.stderr, /^\[stderr cut to its last \d+ characters\]\n/);
    assert.match(r.stderr, /END\n$/);
  } finally {
    fake.cleanup();
  }
});

test('a reply over the stdout limit is a failed call naming the size and the limit, never read into memory', async () => {
  const fake = fakeOpencode('x'.repeat(2000));
  try {
    const r = await opencodeApi(fake.bin, 'GET', '/api/session', undefined, 10_000, { maxStdout: 1000 });
    assert.notEqual(r.code, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /reply is 2000 bytes, over the 1000-byte limit/);
    const fits = await opencodeApi(fake.bin, 'GET', '/api/session', undefined, 10_000, { maxStdout: 2000 });
    assert.equal(fits.code, 0);
    assert.equal(fits.stdout.length, 2000);
    assert.equal(lib.MAX_STDOUT, 64 * 1024 * 1024, 'the default limit is the old runner\'s 64 MiB maxBuffer');
  } finally {
    fake.cleanup();
  }
});

test('opencodeApi reports a binary that cannot start as a failed call', async () => {
  const r = await opencodeApi('/nonexistent/opencode', 'GET', '/api/session', undefined, 1000);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ENOENT/);
});

test('replyFiles: a failed unlink of the reply folder closes both descriptors before it rejects', async () => {
  const { mkdtemp: realMkdtemp, open: realOpen, rm: realRm } = await import('node:fs/promises');
  let dir;
  const opened = [];
  const fs = {
    mkdtemp: async (prefix) => (dir = await realMkdtemp(prefix)),
    open: async (...a) => {
      const h = await realOpen(...a);
      opened.push(h);
      return h;
    },
    rm: async () => { throw Object.assign(new Error('EACCES: permission denied, rmdir'), { code: 'EACCES' }); },
  };
  try {
    await assert.rejects(() => lib.replyFiles(fs), /EACCES/);
    assert.equal(opened.length, 2);
    // A closed FileHandle reports fd -1.
    assert.deepEqual(opened.map((h) => h.fd), [-1, -1], 'both descriptors are closed');
  } finally {
    await Promise.all(opened.map((h) => (h.fd === -1 ? null : h.close())));
    if (dir) await realRm(dir, { recursive: true, force: true });
  }
});

test('replyFiles: a failed second open closes the first descriptor and removes the folder', async () => {
  const { mkdtemp: realMkdtemp, open: realOpen } = await import('node:fs/promises');
  let dir;
  const opened = [];
  const fs = {
    mkdtemp: async (prefix) => (dir = await realMkdtemp(prefix)),
    open: async (...a) => {
      if (opened.length === 1) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      const h = await realOpen(...a);
      opened.push(h);
      return h;
    },
  };
  await assert.rejects(() => lib.replyFiles(fs), /EMFILE/);
  assert.equal(opened[0].fd, -1);
  assert.equal(existsSync(dir), false);
});
