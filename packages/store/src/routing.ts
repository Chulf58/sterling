// Store routing (issue Chulf58/sterling#26 item 5): the one place that decides
// which backend a project's stores live on. config.storage decides it (decision
// storage-backend-is-its-own-config-key-written-only-by-store-move): absent or
// 'sqlite' is today's SQLite files, 'postgres' is the project's schema in the
// Served database. config.mode stays the PR-flow toggle; the router reads it
// only to refuse 'postgres' outside a work-mode project. Only
// scripts/move-store.mjs writes storage, after the stores have moved.
//
// resolveStoreRoute(root) is pure: it reads the project's own files and the
// credentials file, and opens no database. openRoutedStores(root, opts) opens
// what the route names. On Postgres nothing falls back to SQLite (decision
// postgres-store-backend-design-sync-bridge-schema-per-store, point 6): a
// missing identity, missing or invalid credentials, an unreachable server, a
// missing project store or a missing domain store is a named error, and no
// SQLite file or directory is created on the way.
//
// One connection per process (design point 2). Every Postgres store a process
// opens shares one PgBridge per credentials file. The bridge is leased: each
// store's driver holds one lease and returns it on close, and the bridge
// closes when the last lease is returned. A bridge that died is replaced on
// the next open; handles still holding the dead one fail loud on their next
// statement (PgBridgeClosedError).
//
// Fanned reads on one connection. The bridge refuses a second handle's BEGIN
// while one transaction is open (decision
// postgres-operation-id-minted-by-caller-refused-on-repeat-no-schema-bump,
// point 6). A fan over project and domains is sequential and synchronous, so
// each store's read transaction (REPEATABLE READ, SterlingStore.readTx) opens
// and ends before the next store's begins: each store reads its own snapshot,
// the same guarantee separate SQLite files give today. The one overlap is a
// read on store B while store A holds a transaction open on the shared
// connection: MountedStores reads every mount inside a project write (slug
// uniqueness, storeHolding's id lookup). RoutedPgDriver lets such a READ join
// the open transaction instead of refusing it (recorded in the storage decision
// above). It sees A's transaction (READ COMMITTED for a write), not a snapshot
// of its own. A WRITE on B is still refused by the bridge (begin() is not
// wrapped), and MountedStores refuses a cross-mount write before it gets that far.
//
// Test namespace. STERLING_TEST_PG_NAMESPACE=sterling_test_<a-z0-9> replaces
// the production names (sterling_meta, sterling_p_<id>, sterling_d_<name>)
// with <ns>_meta, <ns>_p_<id>, <ns>_d_<name>. Anything else in that variable
// is refused, so it can only ever point a process at test schemas.

import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig, readProjectIdentity, readProjectMode, ProjectIdentityError, type SterlingConfig } from '@sterling/schemas';
import { SterlingStore } from './index.js';
import { MountedStores, resolveDomainMounts, type DomainMount } from './mounted.js';
import type { StoreDriver } from './driver.js';
import { PgBridge, PgBridgeTimeoutError, PgConfigError, PgWorkerDiedError, readPgCredentials, type PgConnectionConfig } from './pg-bridge.js';
import { PG_META_SCHEMA, PgDriver, PgStoreMissingError, assertSterlingSchemaName, pgDomainSchemaName, pgProjectSchemaName } from './pg-driver.js';

export { ProjectModeError, ProjectIdentityError } from '@sterling/schemas';
export { DomainUnavailableError, type MountedStoresOptions, type WorkStoreOpeners } from './mounted.js';
export { PgStoreMissingError } from './pg-driver.js';
// The hook store broker's runtime files (decision hook-store-broker-whole-method-rpc-over-local-socket).
export * from './broker-runtime.js';

/** The connect timeout every routed Postgres open uses at most (design point 6). A lower value in the credentials file is kept. */
export const ROUTED_CONNECT_TIMEOUT_MS = 2000;

/** The environment variable that points a process at a sterling_test_ namespace instead of the production schemas. */
export const PG_TEST_NAMESPACE_ENV = 'STERLING_TEST_PG_NAMESPACE';

/** The values config.storage may hold. Absent means 'sqlite'. */
export const STORAGE_BACKENDS = ['sqlite', 'postgres'] as const;
export type StorageBackend = (typeof STORAGE_BACKENDS)[number];

/** The one command that moves a project's stores and writes config.storage. */
export const MOVE_STORE_COMMAND = 'node scripts/move-store.mjs --to pg|sqlite';

const CONFIG_REL = '.sterling/config.json';

/** A project's store settings cannot be used: a malformed config, an invalid storage value, storage 'postgres' outside work mode, missing or invalid credentials, a bad test namespace, or two domains that map to one schema. */
export class StoreSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreSettingsError';
  }
}

/** The Postgres database did not answer. Nothing was written and nothing fell back to SQLite. */
export class StoreUnreachableError extends Error {
  constructor(
    readonly target: string,
    detail: string,
  ) {
    super(`storage 'postgres': the Postgres store database at ${target} is unreachable (${detail}). Postgres storage never falls back to SQLite; nothing was written.`);
    this.name = 'StoreUnreachableError';
  }
}

/**
 * The route says 'postgres' but the store's schema or registry row is missing.
 * A PgStoreMissingError (so every existing check still matches) whose message
 * names the move that creates the stores. Nothing is created on open.
 */
export class PostgresStoreNotMovedError extends PgStoreMissingError {
  constructor(cause: PgStoreMissingError) {
    super(cause.schema, 'see the message');
    this.message = `${cause.message} config.storage is 'postgres', so this store should exist: move the project's stores with \`node scripts/move-store.mjs --to pg\`. Nothing was created.`;
    this.name = 'PostgresStoreNotMovedError';
  }
}

export interface SqliteStoreRoute {
  storage: 'sqlite';
  root: string;
  config: SterlingConfig;
  projectDbPath: string;
  domains: DomainMount[];
}

export interface PostgresStoreRoute {
  storage: 'postgres';
  root: string;
  config: SterlingConfig;
  projectId: string;
  /** The credentials file this route reads; validated by resolveStoreRoute. */
  credentialsPath: string;
  metaSchema: string;
  projectSchema: string;
  /** Mounted domains in manifest order. `dbPath` is a `postgres:<schema>` label for messages, never a file. */
  domains: (DomainMount & { schema: string })[];
  /** Set when STERLING_TEST_PG_NAMESPACE redirected the names. */
  testNamespace?: string;
}

export type StoreRoute = SqliteStoreRoute | PostgresStoreRoute;

/** The credentials file a Postgres route reads: ~/.sterling/credentials/served.json, resolved at call time. */
export function routedCredentialsPath(): string {
  return join(homedir(), '.sterling', 'credentials', 'served.json');
}

/** The config file's raw JSON object and its parsed config, or null when the file is absent. */
function readConfig(root: string): { raw: Record<string, unknown>; config: SterlingConfig } | null {
  const path = join(root, CONFIG_REL);
  try {
    lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new StoreSettingsError(`${path} cannot be read: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new StoreSettingsError(`malformed ${path}: ${(e as Error).message}. Nothing was opened.`);
  }
  const storage = (raw as { storage?: unknown } | null)?.storage;
  if (storage !== undefined && !(STORAGE_BACKENDS as readonly unknown[]).includes(storage)) {
    throw new StoreSettingsError(
      `config.storage is ${JSON.stringify(storage)} in ${path} — it must be 'sqlite' or 'postgres' (absent means 'sqlite'). Only ${MOVE_STORE_COMMAND} sets it. Nothing was opened.`,
    );
  }
  try {
    return { raw: raw as Record<string, unknown>, config: parseConfig(raw) };
  } catch (e) {
    throw new StoreSettingsError(`malformed ${path}: ${(e as Error).message}. Nothing was opened.`);
  }
}

function testNamespace(): string | undefined {
  const ns = process.env[PG_TEST_NAMESPACE_ENV];
  if (ns === undefined || ns === '') return undefined;
  if (!/^sterling_test_[a-z0-9]+$/.test(ns)) {
    throw new StoreSettingsError(`${PG_TEST_NAMESPACE_ENV}='${ns}' is refused: it must be sterling_test_<lowercase letters and digits>`);
  }
  return ns;
}

/**
 * The Postgres schema names for a project and its mounted domains: sterling_meta,
 * sterling_p_<project id hex>, sterling_d_<name> (decision
 * postgres-schema-names-sterling-p-uuid-sterling-d-domain), or the
 * STERLING_TEST_PG_NAMESPACE equivalents. Two domains that map to one schema,
 * or a refused namespace, throw StoreSettingsError.
 */
export function pgStoreNames(projectId: string, stackTags: readonly string[]): { metaSchema: string; projectSchema: string; domains: { name: string; schema: string }[] } {
  const ns = testNamespace();
  const metaSchema = ns ? `${ns}_meta` : PG_META_SCHEMA;
  const projectSchema = ns ? pgProjectSchemaName(projectId).replace(/^sterling_p_/, `${ns}_p_`) : pgProjectSchemaName(projectId);
  assertSterlingSchemaName(metaSchema);
  assertSterlingSchemaName(projectSchema);
  const bySchema = new Map<string, string>();
  const domains = stackTags.map((name) => {
    const schema = ns ? pgDomainSchemaName(name).replace(/^sterling_d_/, `${ns}_d_`) : pgDomainSchemaName(name);
    assertSterlingSchemaName(schema);
    const other = bySchema.get(schema);
    if (other !== undefined) {
      throw new StoreSettingsError(`domains '${other}' and '${name}' both map to the Postgres schema '${schema}'; rename one in stack_tags. Nothing was opened.`);
    }
    bySchema.set(schema, name);
    return { name, schema };
  });
  return { metaSchema, projectSchema, domains };
}

/**
 * Which backend `root`'s stores live on, and where. Opens no database. Returns
 * null only when `root` has no .sterling/config.json.
 *
 * storage absent or 'sqlite': the SQLite route; config.mode is not read.
 * storage 'postgres': requires mode 'work' (readProjectMode), a valid
 * .sterling/project.json and a valid credentials file.
 *
 * Throws StoreSettingsError (a malformed config, an invalid storage value,
 * 'postgres' outside work mode, missing or invalid credentials, a refused test
 * namespace, two domains on one schema), ProjectModeError (an invalid mode
 * beside storage 'postgres') or ProjectIdentityError (no valid identity file).
 */
export function resolveStoreRoute(root: string): StoreRoute | null {
  const absRoot = resolve(root);
  const read = readConfig(absRoot);
  if (read === null) return null;
  const { config } = read;
  if (read.raw.storage !== 'postgres') {
    return { storage: 'sqlite', root: absRoot, config, projectDbPath: join(absRoot, '.sterling', 'sterling.db'), domains: resolveDomainMounts(config) };
  }

  const shown = absRoot.replace(/\\/g, '/');
  const mode = readProjectMode(absRoot);
  if (mode !== 'work') {
    throw new StoreSettingsError(
      `config.storage is 'postgres' but config.mode is '${mode}' in ${shown}/${CONFIG_REL}: Postgres storage is valid only in a work-mode project. ` +
        `Move the stores back with \`node scripts/move-store.mjs --to sqlite\`, or set mode to 'work'. Nothing was opened.`,
    );
  }
  const identity = readProjectIdentity(absRoot);
  if (identity === null) {
    throw new ProjectIdentityError(
      `storage 'postgres' needs the project identity file ${shown}/.sterling/project.json ({"project_id": "<uuid v4>"}); it is missing. ` +
        `Restore it from git, or let init write it. Nothing was opened.`,
    );
  }
  const credentialsPath = routedCredentialsPath();
  try {
    readPgCredentials(credentialsPath);
  } catch (e) {
    if (e instanceof PgConfigError) throw new StoreSettingsError(`storage 'postgres': ${e.message}. Nothing was opened; Postgres storage never falls back to SQLite.`);
    throw e;
  }

  const names = pgStoreNames(identity.project_id, config.stack_tags);
  return {
    storage: 'postgres',
    root: absRoot,
    config,
    projectId: identity.project_id,
    credentialsPath,
    metaSchema: names.metaSchema,
    projectSchema: names.projectSchema,
    domains: names.domains.map((d) => ({ ...d, dbPath: `postgres:${d.schema}` })),
    ...(testNamespace() ? { testNamespace: testNamespace() } : {}),
  };
}

// ---------------------------------------------------------------------------
// The shared bridge
// ---------------------------------------------------------------------------

interface BridgeEntry {
  bridge: PgBridge;
  leases: number;
}

const bridges = new Map<string, BridgeEntry>();

function connectionLabel(config: PgConnectionConfig): string {
  return `${config.host}:${config.port}/${config.database}`;
}

function acquireBridge(credentialsPath: string): BridgeEntry {
  const existing = bridges.get(credentialsPath);
  if (existing && !existing.bridge.closed) return existing;
  bridges.delete(credentialsPath);
  let config: PgConnectionConfig;
  try {
    config = readPgCredentials(credentialsPath);
  } catch (e) {
    if (e instanceof PgConfigError) throw new StoreSettingsError(`storage 'postgres': ${e.message}. Nothing was opened; Postgres storage never falls back to SQLite.`);
    throw e;
  }
  config = { ...config, connectionTimeoutMillis: Math.min(config.connectionTimeoutMillis, ROUTED_CONNECT_TIMEOUT_MS) };
  let bridge: PgBridge;
  try {
    bridge = new PgBridge(config);
  } catch (e) {
    if (e instanceof PgWorkerDiedError || e instanceof PgBridgeTimeoutError) throw new StoreUnreachableError(connectionLabel(config), e.message);
    throw e;
  }
  const entry = { bridge, leases: 0 };
  bridges.set(credentialsPath, entry);
  return entry;
}

function releaseLease(credentialsPath: string, entry: BridgeEntry): void {
  entry.leases -= 1;
  if (entry.leases > 0) return;
  if (bridges.get(credentialsPath) === entry) bridges.delete(credentialsPath);
  entry.bridge.close();
}

/** Open routed bridges in this process, for tests and diagnostics: the number of distinct connections. */
export function openRoutedBridgeCount(): number {
  return [...bridges.values()].filter((e) => !e.bridge.closed).length;
}

/**
 * A PgDriver whose read transaction joins one already open on the shared
 * connection (see the header), and whose close returns its bridge lease.
 * Everything else is the PgDriver's own behaviour.
 */
class RoutedPgDriver implements StoreDriver {
  readonly dialect;
  private joinedReads = 0;
  private released = false;
  private pinned = false;

  constructor(
    private readonly inner: PgDriver,
    private readonly release: () => void,
  ) {
    this.dialect = inner.dialect;
  }

  prepare(sql: string) {
    return this.inner.prepare(sql);
  }
  exec(sql: string): void {
    this.inner.exec(sql);
  }
  begin(): void {
    this.inner.begin();
  }
  commit(): void {
    this.inner.commit();
  }
  rollback(): void {
    this.inner.rollback();
  }
  beginRead(): void {
    if (this.inner.bridge.transactionOwner !== undefined) {
      this.joinedReads += 1;
      return;
    }
    this.inner.beginRead();
  }
  /** beginRead() with PgDriver's deferred BEGIN. A deferred BEGIN is pending only inside one
   *  SterlingStore.readTx, whose statements all run on that store's own handle, so no other
   *  handle runs a statement between the claim and the BEGIN. */
  beginReadDeferred(): void {
    if (this.inner.bridge.transactionOwner !== undefined) {
      this.joinedReads += 1;
      return;
    }
    this.inner.beginReadDeferred();
  }
  endRead(): void {
    if (this.joinedReads > 0) {
      this.joinedReads -= 1;
      return;
    }
    this.inner.endRead();
  }
  /** Holds one REPEATABLE READ READ ONLY transaction until close: every read sees one snapshot and every write is refused (the bridge refuses the write's BEGIN). */
  pinReadOnlySnapshot(): void {
    this.inner.beginRead();
    this.pinned = true;
  }
  schemaVersion(): number {
    return this.inner.schemaVersion();
  }
  setSchemaVersion(version: number): void {
    this.inner.setSchemaVersion(version);
  }
  hasSchema(): boolean {
    return this.inner.hasSchema();
  }
  prepareReadOnly(): void {
    this.inner.prepareReadOnly();
  }
  prepareWritable(isFresh: boolean): void {
    this.inner.prepareWritable(isFresh);
  }
  publishFresh(supported: number): number {
    return this.inner.publishFresh(supported);
  }
  journalMode(): string {
    return this.inner.journalMode();
  }
  snapshot(targetPath: string): void {
    this.inner.snapshot(targetPath);
  }
  close(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (this.pinned) {
        this.pinned = false;
        this.inner.endRead();
      }
    } finally {
      try {
        this.inner.close();
      } finally {
        this.release();
      }
    }
  }
}

function openWorkStore(route: PostgresStoreRoute, entry: BridgeEntry, schema: string, options: { readOnlySnapshot?: boolean } = {}): SterlingStore {
  // The PgDriver constructor throws PgStoreMissingError for a missing store and
  // creates nothing; the message gains the move that would create it.
  let inner: PgDriver;
  try {
    inner = new PgDriver(entry.bridge, { schema, metaSchema: route.metaSchema });
  } catch (e) {
    if (e instanceof PgStoreMissingError) throw new PostgresStoreNotMovedError(e);
    throw e;
  }
  entry.leases += 1;
  const driver = new RoutedPgDriver(inner, () => releaseLease(route.credentialsPath, entry));
  try {
    const store = new SterlingStore(`postgres:${schema}`, { driver });
    if (options.readOnlySnapshot) driver.pinReadOnlySnapshot();
    return store;
  } catch (e) {
    driver.close();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export interface OpenRoutedProjectOptions {
  mount?: false;
  /** Postgres storage: hold one REPEATABLE READ READ ONLY transaction for the handle's life; every write is refused. The SQLite route refuses this option (scripts/lib/project.mjs keeps its VACUUM INTO copy). */
  readOnlySnapshot?: boolean;
}

export interface OpenRoutedMountedOptions {
  mount: true;
  /** SQLite only: skip a configured domain whose store file is missing. Postgres storage ignores it: a missing domain is a named error. */
  skipMissing?: boolean;
}

export interface RoutedProject {
  route: StoreRoute;
  config: SterlingConfig;
  store: SterlingStore;
}

export interface RoutedMounted {
  route: StoreRoute;
  config: SterlingConfig;
  stores: MountedStores;
}

function routeOrDefault(root: string): StoreRoute {
  const route = resolveStoreRoute(root);
  if (route !== null) return route;
  // No config: today's behaviour, a SQLite project with the default config.
  const config = parseConfig({});
  const absRoot = resolve(root);
  return { storage: 'sqlite', root: absRoot, config, projectDbPath: join(absRoot, '.sterling', 'sterling.db'), domains: resolveDomainMounts(config) };
}

/**
 * Opens `root`'s project store alone (`mount` absent or false) or the project
 * store fanned across its mounted domains (`mount: true`). The SQLite route is
 * today's behaviour exactly: the project file is created when absent, and
 * skipMissing is honoured. The Postgres route opens <meta>.stores-registered
 * schemas on the shared bridge and creates nothing. A project without
 * .sterling/config.json opens on SQLite with the default config, as the MCP
 * server always has.
 */
export function openRoutedStores(root: string, opts: OpenRoutedMountedOptions): RoutedMounted;
export function openRoutedStores(root: string, opts?: OpenRoutedProjectOptions): RoutedProject;
export function openRoutedStores(root: string, opts: OpenRoutedProjectOptions | OpenRoutedMountedOptions = {}): RoutedProject | RoutedMounted {
  const route = routeOrDefault(root);
  if (route.storage === 'sqlite') {
    if (opts.mount) {
      return { route, config: route.config, stores: new MountedStores(route.projectDbPath, route.domains, { skipMissing: opts.skipMissing }) };
    }
    if (opts.readOnlySnapshot) throw new StoreSettingsError("readOnlySnapshot is a Postgres-storage option; a SQLite read-only open copies the file instead");
    return { route, config: route.config, store: new SterlingStore(route.projectDbPath) };
  }

  const entry = acquireBridge(route.credentialsPath);
  // The bridge closes with its last lease. If no store opens, nothing holds one.
  const closeIfUnused = () => {
    if (entry.leases === 0) {
      if (bridges.get(route.credentialsPath) === entry) bridges.delete(route.credentialsPath);
      entry.bridge.close();
    }
  };
  try {
    if (opts.mount) {
      const stores = new MountedStores(`postgres:${route.projectSchema}`, route.domains, {
        work: {
          openProject: () => openWorkStore(route, entry, route.projectSchema),
          openDomain: (m) => openWorkStore(route, entry, schemaOf(route, m.name)),
        },
      });
      return { route, config: route.config, stores };
    }
    return { route, config: route.config, store: openWorkStore(route, entry, route.projectSchema, { readOnlySnapshot: opts.readOnlySnapshot }) };
  } catch (e) {
    closeIfUnused();
    throw e;
  }
}

function schemaOf(route: PostgresStoreRoute, name: string): string {
  const d = route.domains.find((x) => x.name === name);
  if (!d) throw new Error(`routing: domain '${name}' is not in the route's stack_tags`);
  return d.schema;
}
