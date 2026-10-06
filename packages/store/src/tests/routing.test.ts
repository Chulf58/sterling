// Store routing (routing.ts, issue Chulf58/sterling#26 item 5): config.storage
// picks SQLite (absent or 'sqlite') or Postgres ('postgres', work mode only),
// and Postgres storage never falls back (decision
// storage-backend-is-its-own-config-key-written-only-by-store-move).
//
// The settings tests (mode, identity, credentials, unreachable server, test
// namespace) need no database and run on every run. The reachable-server
// tests need STERLING_TEST_PG=1: they create a project and a domain store
// under this process's own sterling_test_<random> namespace, open them
// through openRoutedStores, and drop every schema under the namespace after.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomain } from '../index.js';
import { createPgStore, ensurePgLayout, PgTransactionOpenError } from '../pg-driver.js';
import type { PgBridge } from '../pg-bridge.js';
import {
  DomainUnavailableError,
  PG_TEST_NAMESPACE_ENV,
  PgStoreMissingError,
  PostgresStoreNotMovedError,
  ProjectIdentityError,
  ProjectModeError,
  StoreSettingsError,
  StoreUnreachableError,
  openRoutedBridgeCount,
  openRoutedStores,
  pgStoreNames,
  resolveStoreRoute,
} from '../routing.js';
import { PG_SKIP, dropTestSchemas, newTestPrefix, openTestBridge, schemasWithPrefix, sqliteOnly } from './pg-test-support.js';

const NOW = '2026-10-06T12:00:00.000Z';
const ref = (scope: string) => ({
  id: randomUUID(),
  type: 'reference_material',
  created_at: NOW,
  updated_at: NOW,
  author: 'conductor',
  status: 'active',
  superseded_by: null,
  links: [],
  scope,
  stack_tags: [],
  title: 't',
  kind: 'doc',
  location: 'docs/x.md',
  summary: 's',
  source_date: '2026-10-06',
  capture_date: '2026-10-06',
  basis: 'platform',
});

const dirs: string[] = [];
function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `sterling-routing-${label}-`));
  dirs.push(d);
  return d;
}

function project(config: Record<string, unknown> | null, identity?: string): string {
  const root = tempDir('project');
  mkdirSync(join(root, '.sterling'));
  if (config !== null) writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify(config));
  if (identity !== undefined) writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify({ project_id: identity }));
  return root;
}

/** Runs `fn` with HOME pointing at a fresh directory holding `creds` as ~/.sterling/credentials/served.json (mode 600), or no file. */
function withHome<T>(creds: Record<string, unknown> | null, fn: () => T): T {
  const home = tempDir('home');
  if (creds !== null) {
    mkdirSync(join(home, '.sterling', 'credentials'), { recursive: true });
    const path = join(home, '.sterling', 'credentials', 'served.json');
    writeFileSync(path, JSON.stringify(creds));
    chmodSync(path, 0o600);
  }
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    process.env.HOME = saved;
  }
}

const UNREACHABLE = { host: '127.0.0.1', port: 1, database: 'app', user: 'app', password: 'not-a-secret', connect_timeout_ms: 2000 };

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Settings: no database needed
// ---------------------------------------------------------------------------

test('no .sterling/config.json: resolveStoreRoute returns null', () => {
  assert.equal(resolveStoreRoute(project(null)), null);
});

test('storage absent: the SQLite route, whatever the mode says; an invalid mode is not the router\'s business', () => {
  for (const mode of ['work', 'hobby', 'served', undefined]) {
    const route = resolveStoreRoute(project(mode === undefined ? {} : { mode }));
    assert.equal(route?.storage, 'sqlite', `mode ${String(mode)}`);
  }
  assert.equal(resolveStoreRoute(project({ mode: 'work', storage: 'sqlite' }))?.storage, 'sqlite');
});

test('an invalid storage value is a StoreSettingsError naming it', () => {
  assert.throws(() => resolveStoreRoute(project({ mode: 'work', storage: 'pg' })), (e: unknown) => e instanceof StoreSettingsError && /config\.storage is "pg"/.test((e as Error).message));
});

test("storage 'postgres' outside a work-mode project is a StoreSettingsError; with an invalid mode a ProjectModeError", () => {
  withHome(UNREACHABLE, () => {
    for (const config of [{ storage: 'postgres' }, { mode: 'hobby', storage: 'postgres' }]) {
      assert.throws(() => resolveStoreRoute(project(config, randomUUID())), (e: unknown) => e instanceof StoreSettingsError && /valid only in a work-mode project/.test((e as Error).message));
    }
    assert.throws(() => resolveStoreRoute(project({ mode: 'served', storage: 'postgres' }, randomUUID())), ProjectModeError);
  });
});

test('SQLite: the route names the SQLite files today\'s openers use', () => {
  const root = project({ stack_tags: ['alpha'] });
  const route = resolveStoreRoute(root);
  assert.ok(route && route.storage === 'sqlite');
  assert.equal(route.projectDbPath, join(root, '.sterling', 'sterling.db'));
  assert.equal(route.domains.length, 1);
  assert.equal(route.domains[0].name, 'alpha');
});

test('SQLite: openRoutedStores opens the SQLite project store and honours skipMissing', { skip: sqliteOnly('asserts SQLite files') }, () => {
  const root = project({ stack_tags: ['present', 'absent'], domain_paths: {} });
  const home = tempDir('domains');
  writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify({ stack_tags: ['present', 'absent'], domain_paths: { present: join(home, 'present.db'), absent: join(home, 'absent.db') } }));
  createDomain('present', 'a test domain', join(home, 'present.db'));

  const { store, route } = openRoutedStores(root);
  try {
    assert.equal(route.storage, 'sqlite');
    assert.ok(existsSync(join(root, '.sterling', 'sterling.db')), 'the project store is a SQLite file, created when absent as before');
  } finally {
    store.close();
  }

  const { stores } = openRoutedStores(root, { mount: true, skipMissing: true });
  try {
    assert.deepEqual(stores.domainNames(), ['present']);
    assert.deepEqual(stores.missingDomains.map((m) => m.name), ['absent']);
    assert.equal(existsSync(join(home, 'absent.db')), false, 'a missing hobby domain is still never created');
  } finally {
    stores.close();
  }
  assert.throws(() => openRoutedStores(root, { mount: true }), /domain 'absent' has no store/);
});

test('work: a missing identity file is a ProjectIdentityError and nothing is created', () => {
  const root = project({ mode: 'work', storage: 'postgres' });
  withHome(UNREACHABLE, () => {
    assert.throws(() => resolveStoreRoute(root), (e: unknown) => e instanceof ProjectIdentityError && /project\.json/.test((e as Error).message));
    assert.throws(() => openRoutedStores(root), ProjectIdentityError);
  });
  assert.deepEqual(readdirSync(join(root, '.sterling')), ['config.json']);
});

test('work: a missing credentials file is a StoreSettingsError and nothing is created', () => {
  const root = project({ mode: 'work', storage: 'postgres' }, randomUUID());
  withHome(null, () => {
    assert.throws(() => resolveStoreRoute(root), (e: unknown) => e instanceof StoreSettingsError && /served\.json/.test((e as Error).message));
    assert.throws(() => openRoutedStores(root, { mount: true }), StoreSettingsError);
  });
  assert.deepEqual(readdirSync(join(root, '.sterling')).sort(), ['config.json', 'project.json']);
});

test('work: an invalid credentials file is a StoreSettingsError naming the field, never its value', () => {
  const root = project({ mode: 'work', storage: 'postgres' }, randomUUID());
  withHome({ ...UNREACHABLE, port: 'five' }, () => {
    assert.throws(
      () => resolveStoreRoute(root),
      (e: unknown) => e instanceof StoreSettingsError && /credentials\.port/.test((e as Error).message) && !/not-a-secret/.test((e as Error).message),
    );
  });
});

test('work: an unreachable server is a StoreUnreachableError; nothing is written and no SQLite file appears', () => {
  const root = project({ mode: 'work', storage: 'postgres', stack_tags: ['alpha'] }, randomUUID());
  withHome(UNREACHABLE, () => {
    const route = resolveStoreRoute(root);
    assert.ok(route && route.storage === 'postgres');
    for (const open of [() => openRoutedStores(root), () => openRoutedStores(root, { mount: true, skipMissing: true })]) {
      assert.throws(open, (e: unknown) => e instanceof StoreUnreachableError && /never falls back to SQLite/.test((e as Error).message) && !/not-a-secret/.test((e as Error).message));
    }
  });
  assert.deepEqual(readdirSync(join(root, '.sterling')).sort(), ['config.json', 'project.json']);
  assert.equal(openRoutedBridgeCount(), 0, 'a failed connect leaves no bridge behind');
});

test('work: two domains that map to one schema are refused by name', () => {
  const root = project({ mode: 'work', storage: 'postgres', stack_tags: ['genesys-cloud', 'genesys_cloud'] }, randomUUID());
  withHome(UNREACHABLE, () => {
    assert.throws(() => resolveStoreRoute(root), (e: unknown) => e instanceof StoreSettingsError && /genesys-cloud/.test((e as Error).message));
  });
});

test('work: a test namespace outside sterling_test_ is refused', () => {
  const root = project({ mode: 'work', storage: 'postgres' }, randomUUID());
  const saved = process.env[PG_TEST_NAMESPACE_ENV];
  process.env[PG_TEST_NAMESPACE_ENV] = 'sterling';
  try {
    withHome(UNREACHABLE, () => assert.throws(() => resolveStoreRoute(root), StoreSettingsError));
  } finally {
    if (saved === undefined) delete process.env[PG_TEST_NAMESPACE_ENV];
    else process.env[PG_TEST_NAMESPACE_ENV] = saved;
  }
});

test('work: the route names sterling_p_<id hex> and sterling_d_<name> in sterling_meta', () => {
  const id = randomUUID();
  const root = project({ mode: 'work', storage: 'postgres', stack_tags: ['Node.js'] }, id);
  const saved = process.env[PG_TEST_NAMESPACE_ENV];
  delete process.env[PG_TEST_NAMESPACE_ENV];
  try {
    withHome(UNREACHABLE, () => {
      const route = resolveStoreRoute(root);
      assert.ok(route && route.storage === 'postgres');
      assert.equal(route.metaSchema, 'sterling_meta');
      assert.equal(route.projectSchema, `sterling_p_${id.replace(/-/g, '')}`);
      assert.deepEqual(route.domains.map((d) => d.schema), ['sterling_d_node_js']);
      assert.deepEqual(pgStoreNames(id, ['Node.js']), { metaSchema: 'sterling_meta', projectSchema: route.projectSchema, domains: [{ name: 'Node.js', schema: 'sterling_d_node_js' }] });
    });
  } finally {
    if (saved !== undefined) process.env[PG_TEST_NAMESPACE_ENV] = saved;
  }
});

// ---------------------------------------------------------------------------
// Work mode against Served (STERLING_TEST_PG=1)
// ---------------------------------------------------------------------------

const ns = newTestPrefix();
let bridge: PgBridge | undefined;
const admin = (): PgBridge => {
  if (bridge === undefined) {
    bridge = openTestBridge();
    ensurePgLayout(bridge, `${ns}_meta`);
  }
  return bridge;
};

after(() => {
  if (!bridge) return;
  try {
    dropTestSchemas(bridge, ns);
    assert.deepEqual(schemasWithPrefix(bridge, ns), []);
  } finally {
    bridge.close();
  }
});

/** A work project whose route resolves into this file's namespace, with the named stores created. */
function workProject(opts: { domains: string[]; createProject?: boolean; createDomains?: string[] }): { root: string; projectSchema: string } {
  const id = randomUUID();
  const root = project({ mode: 'work', storage: 'postgres', stack_tags: opts.domains }, id);
  const projectSchema = `${ns}_p_${id.replace(/-/g, '')}`;
  const b = admin();
  if (opts.createProject ?? true) createPgStore(b, { kind: 'test', name: root, schema: projectSchema, metaSchema: `${ns}_meta` });
  for (const d of opts.createDomains ?? opts.domains) {
    const schema = `${ns}_d_${d}`;
    if (schemasWithPrefix(b, ns).includes(schema)) continue;
    createPgStore(b, { kind: 'test', name: d, schema, metaSchema: `${ns}_meta` });
  }
  return { root, projectSchema };
}

function inNamespace<T>(fn: () => T): T {
  const saved = process.env[PG_TEST_NAMESPACE_ENV];
  process.env[PG_TEST_NAMESPACE_ENV] = ns;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[PG_TEST_NAMESPACE_ENV];
    else process.env[PG_TEST_NAMESPACE_ENV] = saved;
  }
}

test('work: project and domain stores open on Postgres through one shared connection', { skip: PG_SKIP }, () => {
  const { root } = workProject({ domains: ['alpha'] });
  inNamespace(() => {
    const { stores, route } = openRoutedStores(root, { mount: true });
    try {
      assert.equal(route.storage, 'postgres');
      assert.equal(openRoutedBridgeCount(), 1, 'one connection serves the project and every domain');
      const p = stores.create(ref('project'));
      const d = stores.create(ref('domain:alpha'));
      assert.deepEqual(stores.bySource().map((s) => [s.source, s.records.map((r) => r.id)]), [['project', [p.id]], ['alpha', [d.id]]]);
      // A fanned read inside a project write: the domain's read joins the
      // open transaction on the shared connection instead of being refused.
      const seen = stores.withTransaction(() => stores.get(d.id)?.id);
      assert.equal(seen, d.id);
    } finally {
      stores.close();
    }
    assert.equal(openRoutedBridgeCount(), 0, 'the bridge closes with its last store');
    assert.equal(existsSync(join(root, '.sterling', 'sterling.db')), false, 'work mode creates no SQLite file');
  });
});

test('work: a missing domain schema is a DomainUnavailableError; skipMissing is ignored and nothing is created', { skip: PG_SKIP }, () => {
  const { root } = workProject({ domains: ['present', 'gone'], createDomains: ['present'] });
  inNamespace(() => {
    assert.throws(
      () => openRoutedStores(root, { mount: true, skipMissing: true }),
      (e: unknown) => e instanceof DomainUnavailableError && e.domain === 'gone' && e.cause instanceof PostgresStoreNotMovedError && /move-store/.test((e as Error).message),
    );
  });
  assert.equal(schemasWithPrefix(admin(), ns).includes(`${ns}_d_gone`), false, 'the missing domain was not created');
  assert.equal(openRoutedBridgeCount(), 0, 'every handle opened before the failure was closed');
});

test('work: a missing project schema is a PostgresStoreNotMovedError naming move-store, and is never created', { skip: PG_SKIP }, () => {
  const { root, projectSchema } = workProject({ domains: [], createProject: false });
  inNamespace(() => {
    assert.throws(
      () => openRoutedStores(root),
      (e: unknown) => e instanceof PostgresStoreNotMovedError && e instanceof PgStoreMissingError && /node scripts\/move-store\.mjs --to pg/.test((e as Error).message),
    );
  });
  assert.equal(schemasWithPrefix(admin(), ns).includes(projectSchema), false);
  assert.equal(openRoutedBridgeCount(), 0);
});

test('work: a read-only open reads one snapshot and refuses every write', { skip: PG_SKIP }, () => {
  const { root } = workProject({ domains: [] });
  inNamespace(() => {
    const writer = openRoutedStores(root);
    const r = writer.store.create(ref('project'));
    writer.store.close();
    const { store } = openRoutedStores(root, { readOnlySnapshot: true });
    try {
      assert.equal(store.get(r.id)?.id, r.id);
      assert.throws(() => store.create(ref('project')), PgTransactionOpenError);
      assert.equal(store.query({}).length, 1, 'the refused write left nothing behind');
    } finally {
      store.close();
    }
    assert.equal(openRoutedBridgeCount(), 0);
  });
});
