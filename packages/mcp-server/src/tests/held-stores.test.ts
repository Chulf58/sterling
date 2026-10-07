// The MCP server's held Postgres stores (held-stores.ts, board 2b966da0): when
// the bridge worker dies, the call that finds it fails with its own error and
// is not retried, and the next call opens a new connection and succeeds.
//
// The first tests use fake RoutedMounted values (no database): they pin the
// rule itself. The last test needs STERLING_TEST_PG=1: it boots
// createSterlingServer on a sterling_test_ project, terminates the server's
// real Postgres backend, and calls through SterlingTools.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountedStores, PgBridge, PgBridgeClosedError, PgQueryError, PgWorkerDiedError, createPgStore, ensurePgLayout, readPgCredentials } from '@sterling/store';
import { openRoutedBridgeCount, type RoutedMounted } from '@sterling/store/routing';
import { holdRoutedStores } from '../held-stores.js';
import { createSterlingServer } from '../server.js';

// ---------------------------------------------------------------------------
// The rule, on fakes
// ---------------------------------------------------------------------------

/** One fake connection: its stores answer until `die(reason)`, then throw the way a dead PgBridge does. */
class FakeConnection {
  lost: string | undefined;
  closedStores = false;
  readonly calls: string[] = [];
  constructor(readonly generation: number) {}

  die(reason: string): PgWorkerDiedError {
    this.lost = `the worker died: ${reason}`;
    return new PgWorkerDiedError(reason);
  }

  routed(): RoutedMounted {
    const conn = this;
    const check = () => {
      if (conn.lost !== undefined) throw new PgBridgeClosedError(conn.lost);
    };
    const stores = Object.create(MountedStores.prototype) as MountedStores;
    Object.assign(stores, {
      missingDomains: [],
      get(id: string) {
        check();
        conn.calls.push(`get ${id}`);
        return { id, generation: conn.generation };
      },
      dieDuring(reason: string) {
        throw conn.die(reason);
      },
      withTransaction<T>(fn: () => T): T {
        check();
        return fn();
      },
      close() {
        conn.closedStores = true;
      },
    });
    return { route: { storage: 'postgres' } as RoutedMounted['route'], config: {} as RoutedMounted['config'], stores, connectionLost: () => conn.lost };
  }
}

function fakeHolder(opts: { failReopens?: number } = {}) {
  const connections = [new FakeConnection(1)];
  const lines: string[] = [];
  let failReopens = opts.failReopens ?? 0;
  const reopen = (): RoutedMounted => {
    if (failReopens > 0) {
      failReopens -= 1;
      throw new Error('StoreUnreachableError: the reopen failed');
    }
    const c = new FakeConnection(connections.length + 1);
    connections.push(c);
    return c.routed();
  };
  const stores = holdRoutedStores(connections[0].routed(), reopen, (line) => lines.push(line)) as MountedStores & { dieDuring(reason: string): never };
  /** Which fake connection answered a get. */
  const gen = (id: string) => (stores.get(id) as unknown as { generation: number }).generation;
  return { stores, gen, connections, lines };
}

test('the call running when the worker dies fails with that PgWorkerDiedError; the next call succeeds on a new connection', () => {
  const { stores, gen, connections, lines } = fakeHolder();
  assert.equal(gen('a'), 1);
  let thrown: unknown;
  assert.throws(
    () => stores.dieDuring('read ECONNRESET'),
    (e: unknown) => {
      thrown = e;
      return e instanceof PgWorkerDiedError && /read ECONNRESET/.test((e as Error).message);
    },
  );
  assert.ok(thrown instanceof PgWorkerDiedError, 'the original error reaches the caller, not a wrapper');
  assert.equal(connections.length, 1, 'the failed call was not retried and nothing reopened yet');
  assert.deepEqual(connections[0].calls, ['get a'], 'nothing ran again on the dead connection');

  assert.equal(gen('b'), 2, 'the next call runs on a new connection');
  assert.equal(connections[0].closedStores, true, 'the dead stores were closed, returning their leases');
  assert.equal(gen('c'), 2, 'later calls stay on the new connection');
  assert.equal(lines.length, 1, 'the reconnect is announced once');
  assert.match(lines[0], /Postgres connection closed \(the worker died: read ECONNRESET\)/);
  assert.match(lines[0], /not retried/);
});

test('a reopen that fails throws its own error and holds nothing; the call after it opens again', () => {
  const { stores, gen, connections, lines } = fakeHolder({ failReopens: 1 });
  assert.throws(() => stores.dieDuring('read ECONNRESET'), PgWorkerDiedError);
  assert.throws(() => stores.get('x'), /StoreUnreachableError: the reopen failed/);
  assert.equal(connections.length, 1);
  assert.equal(gen('y'), 2);
  assert.equal(lines.length, 1, 'one announcement per lost connection, not one per reopen attempt');
});

test('inside a running call nothing reopens: a transaction never continues on a second connection', () => {
  const { stores, gen, connections } = fakeHolder();
  assert.throws(
    () =>
      stores.withTransaction(() => {
        assert.throws(() => stores.dieDuring('read ECONNRESET'), PgWorkerDiedError);
        // The callback goes on calling after the death: it reaches the dead
        // stores and fails loud instead of opening a connection mid-transaction.
        return stores.get('inside');
      }),
    PgBridgeClosedError,
  );
  assert.equal(connections.length, 1, 'no connection was opened inside the transaction');
  assert.equal(gen('after'), 2, 'the next top-level call reopens');
});

test('close() closes the held stores and nothing reopens after it', () => {
  const { stores, connections } = fakeHolder();
  connections[0].die('read ECONNRESET');
  stores.close();
  assert.equal(connections[0].closedStores, true);
  assert.throws(() => stores.get('z'), PgBridgeClosedError);
  assert.equal(connections.length, 1);
});

test('the held stores still pass instanceof MountedStores', () => {
  const { stores } = fakeHolder();
  assert.ok(stores instanceof MountedStores);
});

// ---------------------------------------------------------------------------
// The server against Served (STERLING_TEST_PG=1)
// ---------------------------------------------------------------------------

const PG = process.env.STERLING_TEST_PG === '1';
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The PgBridge under a routed SterlingStore: SterlingStore.db is a RoutedPgDriver, whose inner PgDriver holds the bridge. */
function bridgeOf(store: unknown): PgBridge {
  const bridge = (store as { db: { inner: { bridge: PgBridge } } }).db.inner.bridge;
  assert.ok(bridge instanceof PgBridge, 'reached the routed store\'s bridge');
  return bridge;
}

test("createSterlingServer on storage 'postgres': after the backend is terminated, one tool call fails with PgWorkerDiedError and the next succeeds on a new bridge", { skip: PG ? false : 'set STERLING_TEST_PG=1 to run against Served' }, () => {
  const ns = `sterling_test_${randomBytes(6).toString('hex')}`;
  const id = randomUUID();
  const admin = new PgBridge(readPgCredentials());
  const savedNs = process.env.STERLING_TEST_PG_NAMESPACE;
  const writes: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  try {
    ensurePgLayout(admin, `${ns}_meta`);
    createPgStore(admin, { kind: 'test', name: 'reconnect project', schema: `${ns}_p_${id.replace(/-/g, '')}`, metaSchema: `${ns}_meta` });
    const root = mkdtempSync(join(tmpdir(), 'sterling-held-stores-'));
    dirs.push(root);
    mkdirSync(join(root, '.sterling'));
    writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ mode: 'work', storage: 'postgres', stack_tags: [] }));
    writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify({ project_id: id }));
    process.env.STERLING_TEST_PG_NAMESPACE = ns;

    const { store, tools } = createSterlingServer({ projectRoot: root });
    try {
      assert.notEqual(tools.knowledgeQueryResult({}), undefined);
      const first = bridgeOf(store.project);
      assert.equal(openRoutedBridgeCount(), 1);

      // The server ends this connection (what an ECONNRESET does from the
      // other side). The statement that asked gets the server's own error.
      assert.throws(() => first.query('SELECT pg_terminate_backend(pg_backend_pid())'), (e: unknown) => e instanceof PgQueryError && e.code === '57P01');

      process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        writes.push(String(chunk));
        return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;

      // (1) The tool call that runs into the dead worker fails with
      // PgWorkerDiedError, by name, and is not retried.
      assert.throws(() => tools.knowledgeQueryResult({}), (e: unknown) => e instanceof PgWorkerDiedError);
      assert.equal(first.closed, true);

      // (2) The next tool call opens a new bridge and succeeds.
      const result = tools.knowledgeQueryResult({}) as { returned?: number };
      assert.equal(result.returned, 0);
      const second = bridgeOf(store.project);
      assert.notEqual(second, first, 'a new bridge');
      assert.equal(second.closed, false);
      assert.equal(openRoutedBridgeCount(), 1, 'the dead bridge was released; one connection is open');
      assert.equal(writes.filter((w) => /Postgres connection closed/.test(w)).length, 1, 'announced once on stderr');
    } finally {
      process.stderr.write = realWrite;
      store.close();
    }
    assert.equal(openRoutedBridgeCount(), 0);
  } finally {
    if (savedNs === undefined) delete process.env.STERLING_TEST_PG_NAMESPACE;
    else process.env.STERLING_TEST_PG_NAMESPACE = savedNs;
    try {
      const rows = admin.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)', [`${ns}_`]).rows;
      for (const row of rows) admin.query(`DROP SCHEMA "${String(row.nspname)}" CASCADE`);
    } finally {
      admin.close();
    }
  }
});
