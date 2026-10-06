// The hook store broker (decision hook-store-broker-whole-method-rpc-over-local-socket):
// the MCP server on a Postgres-storage project serves whole store operations to
// hooks over a local Unix socket. Pinned here: the runtime directory and socket
// permissions, the handshake identity, a wrong instance refused, frame bounds on
// both sides, the loud fallback before dispatch, and "outcome unknown, never
// replayed" when the server dies mid-operation. Every server runs on its own
// XDG_RUNTIME_DIR under the OS temp dir and its own sterling_test_<random>
// namespace, dropped after. The live arms need STERLING_TEST_PG=1.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROKER_MAX_REQUEST_BYTES, BROKER_PROTOCOL } from '@sterling/schemas';
import { PgBridge, createPgStore, ensurePgLayout, readPgCredentials } from '@sterling/store';
import { BrokerRuntimeDirError, brokerDir, brokerSocketPath, brokerStorageIdentity, resolveStoreRoute } from '@sterling/store/routing';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MCP_MAIN = join(repo, 'packages', 'mcp-server', 'dist', 'main.js');
const PG = process.env.STERLING_TEST_PG === '1';
const PG_SKIP = PG ? false : 'set STERLING_TEST_PG=1 to run against Served';

const dirs = [];
const servers = new Set();
const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `sterling-broker-${label}-`));
  dirs.push(d);
  return d;
};

// ---------------------------------------------------------------------------
// Fixture: one Postgres-storage project in its own namespace, a HOME holding a
// copy of the credentials, and a private runtime directory per test.
// ---------------------------------------------------------------------------
let fx;
before(() => {
  if (!PG) return;
  const ns = `sterling_test_${randomBytes(6).toString('hex')}`;
  const id = randomUUID();
  const bridge = new PgBridge(readPgCredentials());
  try {
    ensurePgLayout(bridge, `${ns}_meta`);
    createPgStore(bridge, { kind: 'test', name: id, schema: `${ns}_p_${id.replace(/-/g, '')}`, metaSchema: `${ns}_meta` });
    createPgStore(bridge, { kind: 'test', name: 'alpha', schema: `${ns}_d_alpha`, metaSchema: `${ns}_meta` });
  } finally {
    bridge.close();
  }
  const home = tempDir('home');
  mkdirSync(join(home, '.sterling', 'credentials'), { recursive: true });
  const creds = join(home, '.sterling', 'credentials', 'served.json');
  copyFileSync(join(homedir(), '.sterling', 'credentials', 'served.json'), creds);
  chmodSync(creds, 0o600);
  const root = tempDir('project');
  mkdirSync(join(root, '.sterling'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ mode: 'work', storage: 'postgres', stack_tags: ['alpha'] }));
  writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify({ project_id: id }));
  fx = { ns, id, home, root };
});

after(() => {
  for (const s of servers) s.kill('SIGKILL');
  if (fx) {
    const bridge = new PgBridge(readPgCredentials());
    try {
      const rows = bridge.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)', [`${fx.ns}_`]).rows;
      for (const r of rows) bridge.query(`DROP SCHEMA "${String(r.nspname)}" CASCADE`);
    } finally {
      bridge.close();
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const envFor = (xdg, extra = {}) => ({ ...process.env, HOME: fx.home, STERLING_TEST_PG_NAMESPACE: fx.ns, XDG_RUNTIME_DIR: xdg, STERLING_CURRENCY_DISABLE: '1', ...extra });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start an MCP server on the fixture project and resolve once its registry file is published. */
async function startServer(xdg, extraEnv = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MCP_MAIN, '--project', fx.root], { env: envFor(xdg, extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
  servers.add(child);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.on('exit', () => servers.delete(child));
  const dir = join(xdg, 'sterling');
  const deadline = Date.now() + 30_000;
  for (;;) {
    const regs = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
    const mine = regs.map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8'))).find((r) => r.pid === child.pid);
    if (mine) return { child, reg: mine, dir, stderr: () => stderr };
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the MCP server did not publish a broker (exit ${child.exitCode}): ${stderr}`);
    await sleep(100);
  }
}

/** A probe file run as a child: argv[2] is a JSON job; it prints one JSON line. Async spawn, so an in-process fake server can answer it. */
function runProbe(job, env) {
  const dir = tempDir('probe');
  const file = join(dir, 'probe.mjs');
  writeFileSync(
    file,
    `import { connectBroker, openRoutedForHook } from ${JSON.stringify(join(repo, 'scripts', 'hooks', 'lib', 'broker-client.mjs'))};\n` +
      `import { resolveStoreRoute } from '@sterling/store/routing';\n` +
      `const job = JSON.parse(process.argv[2]);\n` +
      `const out = {};\n` +
      `try {\n` +
      `  if (job.kind === 'connect') {\n` +
      `    const got = connectBroker(resolveStoreRoute(job.root));\n` +
      `    out.identity = got.client ? got.client.identity : null; out.reason = got.reason ?? null;\n` +
      `    if (got.client) out.count = got.client.project.count({});\n` +
      `  } else if (job.kind === 'create') {\n` +
      `    const { store } = openRoutedForHook(job.root);\n` +
      `    try { store.create(job.record, { operation_id: job.operation_id }); out.created = true; } catch (e) { out.error = e.name; out.message = e.message; }\n` +
      `    try { store.get(job.record.id); out.second = 'sent'; } catch (e) { out.second = e.name; }\n` +
      `  } else if (job.kind === 'get') {\n` +
      `    const { store } = openRoutedForHook(job.root); out.found = store.get(job.id) !== undefined;\n` +
      `  }\n` +
      `} catch (e) { out.thrown = e.name; out.message = e.message; }\n` +
      `process.stdout.write(JSON.stringify(out));\n` +
      `process.exit(0);\n`,
  );
  // The probe imports @sterling/* through the repo's node_modules.
  const linked = join(dir, 'node_modules');
  spawnSync('ln', ['-s', join(repo, 'node_modules'), linked]);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file, JSON.stringify(job)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr, out: stdout ? JSON.parse(stdout) : null }));
  });
}

function runHook(script, input, env) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'scripts', 'hooks', script)], { input: JSON.stringify(input), encoding: 'utf8', cwd: fx.root, env, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const referenceRecord = (id) => {
  const now = new Date().toISOString();
  return { id, type: 'reference_material', created_at: now, updated_at: now, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], title: 'broker probe', kind: 'doc', location: 'x', summary: 's', source_date: '2026-10-06', capture_date: '2026-10-06', basis: 'platform' };
};

// ---------------------------------------------------------------------------
// Runtime directory (no database)
// ---------------------------------------------------------------------------

test('brokerDir: creates $XDG_RUNTIME_DIR/sterling 0700, refuses a directory with group or other bits, refuses a symlink, and never uses a Windows drive mount', () => {
  const xdg = tempDir('xdg');
  const dir = brokerDir({ create: true, env: { XDG_RUNTIME_DIR: xdg } });
  assert.equal(dir, join(xdg, 'sterling'));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  chmodSync(dir, 0o750);
  assert.throws(() => brokerDir({ create: false, env: { XDG_RUNTIME_DIR: xdg } }), (e) => e instanceof BrokerRuntimeDirError && /mode 750/.test(e.message));
  const xdg2 = tempDir('xdg2');
  const target = tempDir('target');
  chmodSync(target, 0o700);
  spawnSync('ln', ['-s', target, join(xdg2, 'sterling')]);
  assert.throws(() => brokerDir({ create: false, env: { XDG_RUNTIME_DIR: xdg2 } }), /is a symlink; refused/);
  assert.equal(brokerDir({ create: false, env: { XDG_RUNTIME_DIR: '/mnt/c/Users/x' } }), brokerDir({ create: false, env: {} }), 'a /mnt/<drive> runtime dir is ignored for the Linux fallback');
});

// ---------------------------------------------------------------------------
// Live arms
// ---------------------------------------------------------------------------

test('a live broker: the socket is 0600 in a 0700 directory, the registry file is 0600, and a clean shutdown removes both', { skip: PG_SKIP }, async () => {
  const xdg = tempDir('xdg');
  const { child, reg, dir } = await startServer(xdg);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(reg.socket).mode & 0o777, 0o600);
  const regFile = readdirSync(dir).find((n) => n.endsWith(`.${reg.instance_id}.json`));
  assert.equal(statSync(join(dir, regFile)).mode & 0o777, 0o600);
  child.stdin.end();
  await new Promise((r) => child.once('exit', r));
  assert.deepEqual(readdirSync(dir), [], 'the server removed its own socket and registry file');
});

test('handshake: the client gets the server\'s own identity (instance, protocol, project, canonical root, storage) and a registered operation runs', { skip: PG_SKIP }, async () => {
  const xdg = tempDir('xdg');
  const { child, reg } = await startServer(xdg);
  try {
    const r = await runProbe({ kind: 'connect', root: fx.root }, envFor(xdg));
    assert.equal(r.code, 0, r.stderr);
    const id = r.out.identity;
    assert.ok(id, `connected: ${r.out.reason}`);
    assert.equal(id.instance_id, reg.instance_id);
    assert.equal(id.protocol, BROKER_PROTOCOL);
    assert.equal(id.project_id, fx.id);
    assert.equal(id.root, realpathSync(fx.root));
    assert.equal(id.pid, child.pid);
    const prev = { HOME: process.env.HOME, NS: process.env.STERLING_TEST_PG_NAMESPACE };
    process.env.HOME = fx.home;
    process.env.STERLING_TEST_PG_NAMESPACE = fx.ns;
    try {
      assert.deepEqual(id.storage, brokerStorageIdentity(resolveStoreRoute(fx.root)));
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.NS === undefined) delete process.env.STERLING_TEST_PG_NAMESPACE;
      else process.env.STERLING_TEST_PG_NAMESPACE = prev.NS;
    }
    assert.equal(r.out.count, 0);
  } finally {
    child.kill('SIGTERM');
  }
});

test('a hook on a live broker delivers through it with no DEGRADED line', { skip: PG_SKIP }, async () => {
  const xdg = tempDir('xdg');
  const { child } = await startServer(xdg);
  try {
    const h = runHook('h19-knowledge-delivery.mjs', { hook_event_name: 'PostToolUse', cwd: fx.root, tool_name: 'Read', tool_input: { file_path: join(fx.root, 'src', 'a.mjs') } }, envFor(xdg));
    assert.equal(h.code, 0, h.stderr);
    assert.doesNotMatch(h.stderr, /DEGRADED/);
    const h1 = runHook('h1-session-start.mjs', { hook_event_name: 'SessionStart', cwd: fx.root, session_id: 's-b', source: 'startup' }, envFor(xdg, { STERLING_NO_BANNER: '1' }));
    assert.equal(h1.code, 0, h1.stderr);
    assert.doesNotMatch(h1.stderr + h1.stdout, /DEGRADED/);
    assert.match(JSON.parse(h1.stdout).hookSpecificOutput.additionalContext, /Mounted domain 'alpha' has NO description/, 'the domain read went through the broker');
  } finally {
    child.kill('SIGTERM');
  }
});

test('a registration whose socket answers as another instance is refused by the server\'s identity check, and the client falls back loudly', { skip: PG_SKIP }, async () => {
  const xdg = tempDir('xdg');
  const { child, reg, dir } = await startServer(xdg);
  try {
    // Forge a registration for instance F whose socket is a hard link to the real server's socket.
    const fake = randomBytes(16).toString('hex');
    const fakeSock = brokerSocketPath(dir, fake);
    linkSync(reg.socket, fakeSock);
    const realFile = readdirSync(dir).find((n) => n.endsWith(`.${reg.instance_id}.json`));
    const fakeFile = realFile.replace(reg.instance_id, fake);
    writeFileSync(join(dir, fakeFile), JSON.stringify({ ...reg, instance_id: fake, socket: fakeSock }), { mode: 0o600 });
    renameSync(join(dir, realFile), join(dir, `${realFile}.aside`));
    const r = await runProbe({ kind: 'connect', root: fx.root }, envFor(xdg));
    assert.equal(r.out.identity, null);
    assert.match(r.out.reason, new RegExp(`instance ${fake}: refused the hello \\(BrokerIdentityMismatchError: the hello names instance ${fake}; this server is ${reg.instance_id}\\)`));
    const h = runHook('h7-file-touch.mjs', { hook_event_name: 'PostToolUse', cwd: fx.root, tool_name: 'Edit', tool_input: { file_path: join(fx.root, 'src', 'a.mjs'), new_string: 'x' } }, envFor(xdg));
    assert.equal(h.code, 0, h.stderr);
    assert.match(h.stderr, /^Sterling hook: DEGRADED — no hook store broker answered for this project \(.*BrokerIdentityMismatchError/m, 'fallback before dispatch is loud');
    renameSync(join(dir, `${realFile}.aside`), join(dir, realFile));
  } finally {
    child.kill('SIGTERM');
  }
});

test('no broker running: the hook falls back to its own connection before dispatch with one DEGRADED line, and still works', { skip: PG_SKIP }, () => {
  const xdg = tempDir('xdg');
  const h = runHook('h19-knowledge-delivery.mjs', { hook_event_name: 'PostToolUse', cwd: fx.root, tool_name: 'Read', tool_input: { file_path: join(fx.root, 'src', 'a.mjs') } }, envFor(xdg));
  assert.equal(h.code, 0, h.stderr);
  assert.equal(h.stderr.match(/DEGRADED/g)?.length, 1, h.stderr);
  assert.match(h.stderr, /no broker runtime directory exists/);
});

test('a socket with group bits is refused before connecting', { skip: PG_SKIP }, async () => {
  const xdg = tempDir('xdg');
  const { child, reg } = await startServer(xdg);
  try {
    chmodSync(reg.socket, 0o660);
    const r = await runProbe({ kind: 'connect', root: fx.root }, envFor(xdg));
    assert.equal(r.out.identity, null);
    assert.match(r.out.reason, /has mode 660; group and other bits must be clear; refused/);
  } finally {
    child.kill('SIGTERM');
  }
});

test('frame bounds: the server closes on a request frame over BROKER_MAX_REQUEST_BYTES, naming BrokerFrameTooLargeError', { skip: PG_SKIP }, async () => {
  const xdg = tempDir('xdg');
  const { child, reg } = await startServer(xdg);
  try {
    const { createConnection } = await import('node:net');
    const reply = await new Promise((resolve, reject) => {
      const sock = createConnection(reg.socket);
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => (buf = Buffer.concat([buf, d])));
      sock.on('close', () => resolve(buf));
      sock.on('error', reject);
      sock.on('connect', () => {
        const head = Buffer.alloc(4);
        head.writeUInt32BE(BROKER_MAX_REQUEST_BYTES + 1, 0);
        sock.write(head);
      });
    });
    const body = JSON.parse(reply.subarray(4, 4 + reply.readUInt32BE(0)).toString('utf8'));
    assert.equal(body.ok, false);
    assert.equal(body.executed, false);
    assert.equal(body.error.name, 'BrokerFrameTooLargeError');
  } finally {
    child.kill('SIGTERM');
  }
});

test('frame bounds: the client refuses a response frame over BROKER_MAX_RESPONSE_BYTES during the handshake and falls back', { skip: PG_SKIP }, async () => {
  const xdg = tempDir('xdg');
  const dir = brokerDir({ create: true, env: { XDG_RUNTIME_DIR: xdg } });
  const instance = randomBytes(16).toString('hex');
  const sockPath = brokerSocketPath(dir, instance);
  const fake = createServer((c) => {
    c.on('data', () => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(0xffffffff, 0);
      c.write(head);
    });
    c.on('error', () => {});
  });
  await new Promise((r) => fake.listen(sockPath, r));
  chmodSync(sockPath, 0o600);
  try {
    const prev = { HOME: process.env.HOME, NS: process.env.STERLING_TEST_PG_NAMESPACE };
    process.env.HOME = fx.home;
    process.env.STERLING_TEST_PG_NAMESPACE = fx.ns;
    let storage;
    try {
      storage = brokerStorageIdentity(resolveStoreRoute(fx.root));
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.NS === undefined) delete process.env.STERLING_TEST_PG_NAMESPACE;
      else process.env.STERLING_TEST_PG_NAMESPACE = prev.NS;
    }
    const { publishBrokerRegistration } = await import('@sterling/store/routing');
    publishBrokerRegistration(dir, fx.root, { instance_id: instance, protocol: BROKER_PROTOCOL, build_id: 'fake', project_id: fx.id, root: realpathSync(fx.root), storage, pid: process.pid, socket: sockPath });
    const r = await runProbe({ kind: 'connect', root: fx.root }, envFor(xdg));
    assert.equal(r.out.identity, null);
    assert.match(r.out.reason, /handshake failed \(a 4294967295-byte response frame is over the 33554432-byte bound\)/);
  } finally {
    fake.close();
  }
});

test('the server is killed mid-operation: the hook gets BrokerOutcomeUnknownError, the write is not replayed (directly or through another broker), and later calls are refused', { skip: PG_SKIP }, async () => {
  const xdg = tempDir('xdg');
  const { child } = await startServer(xdg, { STERLING_BROKER_TEST_HOLD_MS: '4000' });
  const id = randomUUID();
  const probe = runProbe({ kind: 'create', root: fx.root, record: referenceRecord(id), operation_id: randomUUID() }, envFor(xdg));
  await sleep(2000);
  child.kill('SIGKILL');
  const r = await probe;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.error, 'BrokerOutcomeUnknownError', JSON.stringify(r.out));
  assert.match(r.out.message, /the outcome of 'project\.create' .* is unknown .*it was not replayed/);
  assert.equal(r.out.second, 'BrokerClosedError', 'no further broker call after an unknown outcome');
  assert.doesNotMatch(r.stderr, /DEGRADED/, 'no fallback after dispatch');
  // The server died during its hold, before the create ran; nothing replayed it.
  const check = await runProbe({ kind: 'get', root: fx.root, id }, envFor(xdg));
  assert.equal(check.out.found, false, JSON.stringify(check.out));
  assert.match(check.stderr, /DEGRADED .*connect failed/, 'the dead server\'s stale registration is skipped, never swept');
});

test('H10 on a broker that dies after the store opened: fails closed with exit 2 naming the broker error, and releases with exit 1 on the re-entered Stop', { skip: PG_SKIP }, async () => {
  // Each Stop gets its own server. With one server the hold below blocks its
  // event loop on the first hook's call, so a second hook whose hello arrived
  // after that timed out its handshake and fell back to a direct connection:
  // about half the runs tested the fallback instead of a broker dying after
  // the store opened. Here each hook's handshake has nothing to wait behind.
  // The servers start one after the other: two MCP servers opening one
  // Postgres project at the same moment can collide in their schema setup.
  const xdgs = [tempDir('xdg'), tempDir('xdg')];
  const held = [];
  for (const xdg of xdgs) held.push((await startServer(xdg, { STERLING_BROKER_TEST_HOLD_MS: '4000' })).child);
  const stop = (active, xdg) =>
    new Promise((resolve) => {
      const h = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'scripts', 'hooks', 'h10-direct-capture.mjs')], { cwd: fx.root, env: envFor(xdg), stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      h.stderr.on('data', (d) => (stderr += d));
      h.on('exit', (code) => resolve({ code, stderr }));
      h.stdin.end(JSON.stringify({ hook_event_name: 'Stop', cwd: fx.root, session_id: 's-h10', stop_hook_active: active }));
    });
  const blocking = stop(false, xdgs[0]);
  const releasing = stop(true, xdgs[1]);
  await sleep(2500);
  for (const child of held) child.kill('SIGKILL');
  const [b, r] = await Promise.all([blocking, releasing]);
  assert.equal(b.code, 2, b.stderr);
  assert.match(b.stderr, /H10: the project store failed during the session-end duties \(BrokerOutcomeUnknownError: /);
  assert.match(b.stderr, /Failing closed/);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /Released because this Stop was already blocked once/);
});
