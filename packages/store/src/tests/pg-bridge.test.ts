// The synchronous Postgres bridge (pg-bridge.ts + pg-worker.ts): handshake,
// worker death, wait timeout and close. Network tests run only with
// STERLING_TEST_PG=1 against the database in ~/.sterling/credentials/served.json;
// the config and redaction tests run everywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PgBridge,
  PgBridgeClosedError,
  PgBridgeTimeoutError,
  PgConfigError,
  PgQueryError,
  PgWorkerDiedError,
  buildPgConnectionConfig,
  readPgCredentials,
  redactSecrets,
} from '../pg-bridge.js';
import { PG_SKIP, openTestBridge, sleepSync } from './pg-test-support.js';

const fixtureWorker = new URL('./pg-fixture-worker.js', import.meta.url);

function validCredentials(over: Record<string, unknown> = {}) {
  return {
    host: 'db.example.invalid',
    port: 5432,
    database: 'app',
    user: 'app',
    password: 'not-a-real-password',
    ssl: { mode: 'require', negotiation: 'direct', servername: 'db.example.invalid', rejectUnauthorized: false },
    gssencmode: 'disable',
    connect_timeout_ms: 2000,
    ...over,
  };
}

function backendAlive(observer: PgBridge, pid: number): boolean {
  return observer.query('SELECT 1 AS x FROM pg_stat_activity WHERE pid = $1', [pid]).rows.length === 1;
}

/** Polls until the backend is gone or `withinMs` runs out; returns whether it went. */
function waitBackendGone(observer: PgBridge, pid: number, withinMs: number): boolean {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!backendAlive(observer, pid)) return true;
    sleepSync(200);
  }
  return !backendAlive(observer, pid);
}

// ---------------------------------------------------------------------------
// Config (no network)
// ---------------------------------------------------------------------------

test('buildPgConnectionConfig maps the credentials file to an explicit client config', () => {
  const cfg = buildPgConnectionConfig(validCredentials());
  assert.equal(cfg.host, 'db.example.invalid');
  assert.equal(cfg.sslnegotiation, 'direct');
  assert.equal(cfg.connectionTimeoutMillis, 2000);
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: false, servername: 'db.example.invalid' });
});

test('buildPgConnectionConfig refuses unknown keys, unsupported TLS modes and GSS encryption', () => {
  assert.throws(() => buildPgConnectionConfig(validCredentials({ sslmode: 'require' })), PgConfigError);
  assert.throws(() => buildPgConnectionConfig(validCredentials({ ssl: { mode: 'prefer', negotiation: 'direct', rejectUnauthorized: false } })), PgConfigError);
  assert.throws(() => buildPgConnectionConfig(validCredentials({ ssl: { mode: 'verify-full', negotiation: 'direct', rejectUnauthorized: false } })), /verify-full/);
  assert.throws(() => buildPgConnectionConfig(validCredentials({ gssencmode: 'prefer' })), /gssencmode/);
  assert.throws(() => buildPgConnectionConfig(validCredentials({ port: '5432' })), /port/);
  assert.throws(() => buildPgConnectionConfig(validCredentials({ password: undefined })), /password/);
});

test('a PgConfigError never carries the password', () => {
  try {
    buildPgConnectionConfig(validCredentials({ password: 'hunter2-secret', port: 0 }));
    assert.fail('expected a refusal');
  } catch (e) {
    assert.ok(e instanceof PgConfigError);
    assert.ok(!String((e as Error).message).includes('hunter2-secret'));
  }
});

test('readPgCredentials refuses a credentials file that group or other can read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-pg-creds-'));
  try {
    const file = join(dir, 'served.json');
    writeFileSync(file, JSON.stringify(validCredentials()));
    chmodSync(file, 0o644);
    assert.throws(() => readPgCredentials(file), /mode 600/);
    chmodSync(file, 0o600);
    assert.equal(readPgCredentials(file).database, 'app');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPgCredentials names a missing file', () => {
  assert.throws(() => readPgCredentials(join(tmpdir(), 'sterling-no-such-dir', 'served.json')), (e: Error) => e instanceof PgConfigError && /served\.json/.test(e.message));
});

test('redactSecrets removes a secret in raw and URI-encoded form', () => {
  assert.equal(redactSecrets('pw=a b&c and a%20b%26c', ['a b&c']), 'pw=[redacted] and [redacted]');
});

// ---------------------------------------------------------------------------
// Against Served
// ---------------------------------------------------------------------------

test('handshake: the bridge connects and a query round-trips synchronously', { skip: PG_SKIP }, () => {
  const t0 = Date.now();
  const bridge = openTestBridge();
  const handshakeMs = Date.now() - t0;
  try {
    const r = bridge.query('SELECT 1 AS x, $1::text AS echo, count(*) AS n FROM (VALUES (1), (2)) v(a)', ['hi']);
    assert.deepEqual(r.rows, [{ x: 1, echo: 'hi', n: 2 }]);
    assert.equal(typeof r.rows[0].n, 'number', 'int8 comes back as a number');
    assert.ok(handshakeMs < 5000, `handshake took ${handshakeMs} ms`);
  } finally {
    bridge.close();
  }
});

test('a SQL error comes back as PgQueryError with its SQLSTATE and the bridge stays usable', { skip: PG_SKIP }, () => {
  const bridge = openTestBridge();
  try {
    assert.throws(() => bridge.query('SELEC 1'), (e: Error) => e instanceof PgQueryError && e.code === '42601');
    assert.deepEqual(bridge.query('SELECT 2 AS y').rows, [{ y: 2 }]);
  } finally {
    bridge.close();
  }
});

test('a worker that dies at load is reported by the handshake within its finite wait', () => {
  process.env.STERLING_PG_FIXTURE_MODE = 'load-throw';
  const t0 = Date.now();
  try {
    assert.throws(
      () => new PgBridge(buildPgConnectionConfig(validCredentials()), { workerUrl: fixtureWorker, handshakeTimeoutMs: 800 }),
      (e: Error) => e instanceof PgBridgeTimeoutError && e.phase === 'handshake' && /died at load/.test(e.message),
    );
  } finally {
    delete process.env.STERLING_PG_FIXTURE_MODE;
  }
  assert.ok(Date.now() - t0 < 3000);
});

for (const mode of ['crash', 'exit'] as const) {
  test(`a worker that dies after the handshake (${mode}) is reported as PgWorkerDiedError before the wait runs out`, { skip: PG_SKIP }, () => {
    process.env.STERLING_PG_FIXTURE_MODE = mode;
    const t0 = Date.now();
    let bridge: PgBridge | undefined;
    try {
      assert.throws(() => {
        bridge = new PgBridge(readPgCredentials(), { workerUrl: fixtureWorker, waitTimeoutMs: 20_000 });
        bridge.query('SELECT pg_sleep(8)');
      }, PgWorkerDiedError);
    } finally {
      delete process.env.STERLING_PG_FIXTURE_MODE;
    }
    assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
    assert.ok(bridge, 'the handshake completed before the fixture died');
    assert.throws(() => bridge!.query('SELECT 1'), PgBridgeClosedError);
  });
}

test('a wait timeout terminates the worker and the server drops the connection', { skip: PG_SKIP }, () => {
  const observer = openTestBridge();
  const bridge = openTestBridge({ waitTimeoutMs: 300 });
  try {
    const pid = Number(bridge.query('SELECT pg_backend_pid() AS pid').rows[0].pid);
    const t0 = Date.now();
    assert.throws(() => bridge.query('SELECT pg_sleep(2)'), (e: Error) => e instanceof PgBridgeTimeoutError && e.phase === 'query');
    assert.ok(Date.now() - t0 < 1500, `timeout took ${Date.now() - t0} ms`);
    assert.throws(() => bridge.query('SELECT 1'), PgBridgeClosedError);
    assert.ok(waitBackendGone(observer, pid, 10_000), `backend ${pid} still connected after the timeout`);
  } finally {
    bridge.close();
    observer.close();
  }
});

test('the server ending the connection is a named error and closes the bridge', { skip: PG_SKIP }, () => {
  const bridge = openTestBridge();
  try {
    // The statement itself fails with 57P01; the worker then reports the lost
    // connection, which the next call finds queued and throws by name.
    assert.throws(() => bridge.query('SELECT pg_terminate_backend(pg_backend_pid())'), (e: Error) => e instanceof PgQueryError && e.code === '57P01');
    assert.throws(() => bridge.query('SELECT 1'), (e: Error) => e instanceof PgWorkerDiedError && /terminated/i.test(e.message));
    assert.throws(() => bridge.query('SELECT 1'), PgBridgeClosedError);
  } finally {
    bridge.close();
  }
});

test('close() ends the connection, is idempotent, and later calls are refused', { skip: PG_SKIP }, () => {
  const observer = openTestBridge();
  const bridge = openTestBridge();
  try {
    const pid = Number(bridge.query('SELECT pg_backend_pid() AS pid').rows[0].pid);
    bridge.close();
    bridge.close();
    assert.equal(bridge.closed, true);
    assert.throws(() => bridge.query('SELECT 1'), PgBridgeClosedError);
    assert.ok(waitBackendGone(observer, pid, 5000), `backend ${pid} still connected after close()`);
  } finally {
    observer.close();
  }
});

test('an unclosed bridge does not keep its process alive', { skip: PG_SKIP }, () => {
  // A file entry, as a hook is: from a `node -e` or stdin entry the worker
  // never completes its handshake (measured 2026-10-06, Node 24.14), and the
  // handshake timeout reports that.
  const bridgeModule = new URL('../pg-bridge.js', import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(), 'sterling-pg-unclosed-'));
  try {
    const script = join(dir, 'unclosed.mjs');
    writeFileSync(
      script,
      `import { PgBridge, readPgCredentials } from ${JSON.stringify(bridgeModule)};
const b = new PgBridge(readPgCredentials());
b.query('SELECT 1');
console.log('queried');
`,
    );
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /queried/);
    assert.ok(Date.now() - t0 < 10_000, `process took ${Date.now() - t0} ms to exit`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
