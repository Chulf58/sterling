// Postgres write safety (decision postgres-operation-id-minted-by-caller-refused-on-repeat-no-schema-bump,
// points 4 to 7): begin() takes the shared global lock then the store lock
// under lock_timeout and statement_timeout; 55P03 and 57014 are named errors;
// one connection holds one transaction; migrations take the global lock
// exclusively. Needs STERLING_TEST_PG=1.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';
import {
  PgDriver,
  PgLockTimeoutError,
  PgStatementTimeoutError,
  PgTransactionOpenError,
  createPgStore,
  ensurePgLayout,
} from '../pg-driver.js';
import type { PgBridge } from '../pg-bridge.js';
import { PG_SKIP, dropTestSchemas, newTestPrefix, openTestBridge, schemasWithPrefix } from './pg-test-support.js';

const prefix = newTestPrefix();
const meta = `${prefix}_meta`;
let counter = 0;
const bridges: PgBridge[] = [];

function bridge(): PgBridge {
  const b = openTestBridge();
  bridges.push(b);
  return b;
}

let admin: PgBridge | undefined;
function adminBridge(): PgBridge {
  admin ??= bridge();
  return admin;
}

function freshSchema(): string {
  const schema = `${prefix}_${++counter}`;
  ensurePgLayout(adminBridge(), meta);
  createPgStore(adminBridge(), { kind: 'test', name: schema, schema, metaSchema: meta });
  // Build the tables once, so the tests below start from a ready store.
  new SterlingStore(join(tmpdir(), `${schema}.pg`), { driver: new PgDriver(adminBridge(), { schema, metaSchema: meta }) }).close();
  return schema;
}

after(() => {
  try {
    if (admin && !admin.closed) {
      dropTestSchemas(admin, prefix);
      assert.deepEqual(schemasWithPrefix(admin, prefix), []);
    }
  } finally {
    for (const b of bridges) if (!b.closed) b.close();
  }
});

test('two writers in two processes serialize on the same store: no read-modify-write is lost', { skip: PG_SKIP }, async () => {
  const schema = freshSchema();
  const dir = mkdtempSync(join(tmpdir(), 'sterling-pg-writers-'));
  try {
    const script = join(dir, 'writer.mjs');
    const index = new URL('../index.js', import.meta.url).href;
    writeFileSync(
      script,
      `import { SterlingStore, PgBridge, PgDriver, readPgCredentials } from ${JSON.stringify(index)};
const [schema, meta, n] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const bridge = new PgBridge(readPgCredentials());
const store = new SterlingStore('/tmp/writer.pg', { driver: new PgDriver(bridge, { schema, metaSchema: meta, lockTimeoutMs: 8000, statementTimeoutMs: 8000 }) });
for (let i = 0; i < Number(n); i++) {
  store.withTransaction(() => {
    const v = Number(store.getMeta('counter') ?? '0');
    sleep(40);
    store.setMeta('counter', String(v + 1));
  });
}
store.close();
bridge.close();
console.log('done');
`,
    );
    const runWriter = () =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [script, schema, meta, '10'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('exit', (code) => resolve({ code, out }));
      });
    const [a, b] = await Promise.all([runWriter(), runWriter()]);
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    const value = adminBridge().query(`SELECT value FROM "${schema}".store_meta WHERE key = 'counter'`).rows[0]?.value;
    assert.equal(value, '20', 'every increment of both writers landed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a held store lock times out with PgLockTimeoutError (55P03), and the waiter is left with no transaction', { skip: PG_SKIP }, () => {
  const schema = freshSchema();
  const holder = new PgDriver(bridge(), { schema, metaSchema: meta });
  const waiterBridge = bridge();
  const waiter = new PgDriver(waiterBridge, { schema, metaSchema: meta, lockTimeoutMs: 300 });
  holder.begin();
  try {
    const t0 = Date.now();
    assert.throws(() => waiter.begin(), (e: Error) => e instanceof PgLockTimeoutError && e.code === '55P03');
    assert.ok(Date.now() - t0 < 3000, `lock wait took ${Date.now() - t0} ms`);
    assert.equal(waiterBridge.query('SELECT 1 AS x').rows[0].x, 1, 'the failed begin rolled itself back');
  } finally {
    holder.rollback();
  }
  waiter.begin();
  waiter.rollback();
});

test('a statement past statement_timeout fails with PgStatementTimeoutError (57014)', { skip: PG_SKIP }, () => {
  const schema = freshSchema();
  const driver = new PgDriver(bridge(), { schema, metaSchema: meta, statementTimeoutMs: 200 });
  driver.begin();
  try {
    assert.throws(() => driver.prepare('SELECT pg_sleep(?)').get(2), (e: Error) => e instanceof PgStatementTimeoutError && e.code === '57014');
  } finally {
    driver.rollback();
  }
});

test('a second store handle cannot BEGIN on a connection whose transaction another handle holds', { skip: PG_SKIP }, () => {
  const shared = bridge();
  const a = new PgDriver(shared, { schema: freshSchema(), metaSchema: meta });
  const b = new PgDriver(shared, { schema: freshSchema(), metaSchema: meta });
  a.begin();
  try {
    assert.throws(() => b.begin(), PgTransactionOpenError);
    assert.throws(() => b.beginRead(), PgTransactionOpenError);
  } finally {
    a.rollback();
  }
  b.begin();
  b.commit();
});

test('a read transaction is REPEATABLE READ and READ ONLY', { skip: PG_SKIP }, () => {
  const b = bridge();
  const driver = new PgDriver(b, { schema: freshSchema(), metaSchema: meta });
  driver.beginRead();
  try {
    const row = b.query("SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro").rows[0];
    assert.deepEqual(row, { iso: 'repeatable read', ro: 'on' });
  } finally {
    driver.endRead();
  }
});

test('createPgStore waits for the global lock a writer holds shared, and times out by name', { skip: PG_SKIP }, () => {
  const writer = new PgDriver(bridge(), { schema: freshSchema(), metaSchema: meta });
  writer.begin();
  try {
    const schema = `${prefix}_${++counter}`;
    assert.throws(() => createPgStore(bridge(), { kind: 'test', name: schema, schema, metaSchema: meta, lockTimeoutMs: 300 }), PgLockTimeoutError);
    assert.equal(adminBridge().query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]).rows.length, 0, 'nothing was created');
  } finally {
    writer.rollback();
  }
});

test('two first creators of the same store: one creates it, the other is refused by name, never a raw unique violation', { skip: PG_SKIP }, async () => {
  ensurePgLayout(adminBridge(), meta);
  const schema = `${prefix}_${++counter}`;
  const dir = mkdtempSync(join(tmpdir(), 'sterling-pg-creators-'));
  try {
    const script = join(dir, 'creator.mjs');
    const index = new URL('../index.js', import.meta.url).href;
    writeFileSync(
      script,
      `import { PgBridge, readPgCredentials, createPgStore, ensurePgLayout } from ${JSON.stringify(index)};
const [schema, meta] = process.argv.slice(2);
const bridge = new PgBridge(readPgCredentials());
try {
  ensurePgLayout(bridge, meta);
  createPgStore(bridge, { kind: 'test', name: schema, schema, metaSchema: meta });
  console.log('created');
} catch (e) {
  console.log(e.name);
} finally {
  bridge.close();
}
`,
    );
    const run = () =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [script, schema, meta], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('exit', () => resolve(out.trim()));
      });
    const outcomes = (await Promise.all([run(), run()])).sort();
    assert.deepEqual(outcomes, ['PgStoreExistsError', 'created']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
