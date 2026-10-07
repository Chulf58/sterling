// The DEGRADED notice a hook prints when no broker handshake succeeds
// (decision hook-store-broker-whole-method-rpc-over-local-socket). A server
// that accepted the connection and then sent no welcome is BUSY (the broker
// shares the MCP server's event loop), not absent; the notice must say which.
// No Postgres needed: the fixtures are a listener that never answers (silent)
// and a socket file whose listener is gone (dead), under a private runtime dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROKER_BOUNDS, BROKER_PROTOCOL } from '@sterling/schemas';
import { brokerDir, brokerRegistrationPath, brokerSocketPath, brokerStorageIdentity } from '@sterling/store/routing';
import { brokerFallbackLine, connectBroker } from '../hooks/lib/broker-client.mjs';

const dirs = [];
const servers = [];
const children = [];
const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `sterling-notice-${label}-`));
  dirs.push(d);
  return d;
};
after(() => {
  for (const s of servers) s.close();
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const xdg = tempDir('xdg');
  const env = { ...process.env, XDG_RUNTIME_DIR: xdg };
  const dir = brokerDir({ create: true, env });
  const home = tempDir('home');
  const credentialsPath = join(home, 'served.json');
  writeFileSync(credentialsPath, JSON.stringify({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p', connect_timeout_ms: 1000 }), { mode: 0o600 });
  const root = realpathSync(tempDir('project'));
  const route = { root, projectId: randomBytes(8).toString('hex'), credentialsPath, metaSchema: 'm_meta', projectSchema: 'm_p' };
  return { env, dir, root, route };
}

function register(fx, instance, socket) {
  const reg = {
    instance_id: instance,
    protocol: BROKER_PROTOCOL,
    build_id: 'test',
    project_id: fx.route.projectId,
    root: fx.root,
    storage: brokerStorageIdentity(fx.route),
    pid: process.pid,
    socket,
  };
  writeFileSync(brokerRegistrationPath(fx.dir, fx.root, instance), JSON.stringify(reg), { mode: 0o600 });
}

/** A broker that accepts the connection and never replies: connect succeeds, the hello gets no answer. */
async function silentInstance(fx) {
  const id = randomBytes(16).toString('hex');
  const sock = brokerSocketPath(fx.dir, id);
  const server = createServer(() => {});
  servers.push(server);
  await new Promise((resolve) => server.listen(sock, resolve));
  chmodSync(sock, 0o600);
  register(fx, id, sock);
  return id;
}

/** A registered socket file whose listener is gone: connecting is refused. */
async function deadInstance(fx) {
  const id = randomBytes(16).toString('hex');
  const sock = brokerSocketPath(fx.dir, id);
  const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.once('data', resolve);
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  chmodSync(sock, 0o600);
  register(fx, id, sock);
  return id;
}

const COST = 'this hook opens its own Postgres connection, which costs a login per hook.';

test('every instance connected but silent: the notice says the broker is busy, not absent', async () => {
  const fx = fixture();
  const a = await silentInstance(fx);
  const b = await silentInstance(fx);
  const got = connectBroker(fx.route, { env: fx.env });
  assert.equal(got.client, null);
  assert.equal(got.busy, true);
  const line = brokerFallbackLine(got.reason, got.busy);
  assert.match(line, /^Sterling hook: DEGRADED — the hook store broker for this project is busy \(/);
  assert.match(line, new RegExp(`instance ${a}: connected, no handshake reply within ${BROKER_BOUNDS.handshakeMs} ms`));
  assert.match(line, new RegExp(`instance ${b}: connected, no handshake reply within ${BROKER_BOUNDS.handshakeMs} ms`));
  assert.match(line, /the MCP server is likely running a long tool call\)/);
  assert.doesNotMatch(line, /no hook store broker answered/);
  assert.ok(line.includes(COST), 'the cost sentence stays');
});

test('every instance failed to connect: the notice keeps the no-broker headline', async () => {
  const fx = fixture();
  const a = await deadInstance(fx);
  const got = connectBroker(fx.route, { env: fx.env });
  assert.equal(got.client, null);
  assert.equal(got.busy, false);
  const line = brokerFallbackLine(got.reason, got.busy);
  assert.match(line, /^Sterling hook: DEGRADED — no hook store broker answered for this project \(/);
  assert.match(line, new RegExp(`instance ${a}: connect failed \\(`));
  assert.doesNotMatch(line, /busy/);
  assert.ok(line.includes(COST), 'the cost sentence stays');
});

test('mixed failures list each instance\'s own reason under the no-broker headline', async () => {
  const fx = fixture();
  const dead = await deadInstance(fx);
  const silent = await silentInstance(fx);
  const got = connectBroker(fx.route, { env: fx.env });
  assert.equal(got.client, null);
  assert.equal(got.busy, false);
  const line = brokerFallbackLine(got.reason, got.busy);
  assert.match(line, /^Sterling hook: DEGRADED — no hook store broker answered for this project \(/);
  assert.match(line, new RegExp(`instance ${dead}: connect failed \\(`));
  assert.match(line, new RegExp(`instance ${silent}: connected, no handshake reply within ${BROKER_BOUNDS.handshakeMs} ms`));
  assert.ok(line.includes(COST), 'the cost sentence stays');
});

test('no registration at all is the no-broker headline, never busy', () => {
  const fx = fixture();
  const got = connectBroker(fx.route, { env: fx.env });
  assert.equal(got.client, null);
  assert.equal(got.busy, false);
  assert.match(brokerFallbackLine(got.reason, got.busy), /^Sterling hook: DEGRADED — no hook store broker answered for this project \(no MCP server has published a broker/);
});
