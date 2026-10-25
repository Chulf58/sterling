// Shared plumbing for conductor-invoked [S] scripts: target-project resolution,
// config, store, args.
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, missingDomainWarning } from '@sterling/store';
import { openRoutedStores, resolveStoreRoute } from '@sterling/store/routing';
import { resolveStoreWritePath } from './store-path.mjs';

// The flag parser (arg, hasFlag) lives in the dependency-free ./cli-args.mjs and is re-exported here.
import { arg, hasFlag } from './cli-args.mjs';
export { arg, hasFlag };

export function argAll(name, argv = process.argv.slice(2)) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[++i]);
  return out;
}

export function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

// resolveLinkedWorktree / resolveStoreRoot live in ./worktree-root.mjs (no store
// imports, so a small bin bundle can use them); re-exported here for callers.
export { resolveLinkedWorktree, resolveStoreRoot } from './worktree-root.mjs';

// Resolve the store route + config once; every opener shares the existence
// guard, the single config parse, and the one P5 failure path. config.storage
// picks the backend (resolveStoreRoute, @sterling/store/routing; decision
// storage-backend-is-its-own-config-key-written-only-by-store-move): absent or
// 'sqlite' is the SQLite file below, 'postgres' is Postgres, where a missing
// identity, missing credentials or an unreachable server fails by name and
// never falls back.
//
// CONTAINMENT
// (decision sanctioned-script-store-writes-one-containment-helper-one-arg-parser, R5): dbPath is what openProject/openMounted hand to
// `new SterlingStore(dbPath)`, opened WRITABLE — a symlinked `.sterling` here
// would redirect every store write this shared opener makes, for every
// caller of openProject/openMounted. Routed through the helper so a
// symlinked component refuses before the store is ever opened.
function resolveProject(cwd) {
  let dbPath, configPath;
  try {
    dbPath = resolveStoreWritePath(cwd, '.sterling', 'sterling.db');
    configPath = resolveStoreWritePath(cwd, '.sterling', 'config.json');
  } catch (e) {
    fail(e.message);
  }
  let route;
  try {
    route = resolveStoreRoute(cwd);
  } catch (e) {
    if (e?.name === 'StoreSettingsError' && /^malformed /.test(e.message)) {
      fail(`malformed .sterling/config.json — failing loud, never half-applying (P5): ${e.message}`);
    }
    fail(named(e));
  }
  // Postgres storage has no SQLite file: its stores are checked when they open.
  if (route?.storage === 'postgres') return { storage: 'postgres', dbPath, config: route.config };
  if (!existsSync(dbPath)) fail(`no Sterling store at ${dbPath} — not an initialized project`);
  let config;
  try {
    config = route ? route.config : parseConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {});
  } catch (e) {
    fail(`malformed .sterling/config.json — failing loud, never half-applying (P5): ${e.message}`);
  }
  return { storage: 'sqlite', dbPath, config };
}

// The error's class name and message, for a refusal that names what failed.
// ProjectModeError and ProjectIdentityError keep name 'Error', so the
// constructor's name is preferred.
function named(e) {
  return `${e?.constructor?.name ?? e?.name ?? 'Error'}: ${e?.message ?? String(e)}`;
}

// Opens through the router, failing by name (P5) when a Postgres store is
// missing or unreachable.
function openRouted(cwd, opts) {
  try {
    return openRoutedStores(cwd, opts);
  } catch (e) {
    fail(named(e));
  }
}

// Bare project store — for project-local work: run/board/transient state and
// owner-lookup by repo file_key (a repo path only ever matches project-scoped
// records, so domain mounts buy that path nothing — §3.3).
export function openProject(cwd = process.cwd()) {
  const { config } = resolveProject(cwd);
  return { cwd, store: openRouted(cwd).store, config };
}

// Domain-aware store (§3.4/P6): the project store fanned across the mounted
// domain stores (the config.stack_tags manifest, resolveDomainMounts — the same
// resolver the MCP server uses). For retrieval that must see
// shared knowledge — prep's knowledge_pack. Run/board/transient writes still
// land in the project store (MountedStores forwards them). Same return shape as
// openProject, so callers swap one for the other. A configured domain whose
// store is missing is skipped and announced on stderr, never a failure (board
// 675daf9d (c) ruling); store.missingDomains lists the skipped ones. With
// storage 'postgres' a missing or unreadable domain fails by name instead.
export function openMounted(cwd = process.cwd()) {
  const { config } = resolveProject(cwd);
  const store = openRouted(cwd, { mount: true, skipMissing: true }).stores;
  for (const m of store.missingDomains) process.stderr.write(missingDomainWarning(m) + '\n');
  return { cwd, store, config };
}

// Read-only project store, for scripts that must never write (cleanup-plan).
// openProject is NOT read-only: the SterlingStore constructor sets the journal
// mode and runs its DDL and additive migrations, which write to a store whose
// schema lags the code. This copies the live store through a readOnly SQLite
// connection (VACUUM INTO a temp file) and opens SterlingStore on the copy, so
// every store read works and the live file is never opened for writing. A
// readOnly open of a WAL store may still create the -shm index file; it never
// changes the database. close() closes the copy and deletes it.
//
// Postgres storage copies nothing: the store is opened with one REPEATABLE
// READ READ ONLY transaction held until close(), so every read sees one
// snapshot and every write is refused (PgTransactionOpenError, nothing sent).
export function openProjectReadOnly(cwd = process.cwd()) {
  const { storage, dbPath, config } = resolveProject(cwd);
  if (storage === 'postgres') {
    const store = openRouted(cwd, { readOnlySnapshot: true }).store;
    return { cwd, store, config, close: () => store.close() };
  }
  const dir = mkdtempSync(join(tmpdir(), 'sterling-readonly-'));
  const snapshot = join(dir, 'sterling.db');
  let store;
  try {
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      ro.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    } finally {
      ro.close();
    }
    store = new SterlingStore(snapshot);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    fail(`read-only snapshot of ${dbPath} failed — ${e.message}`);
  }
  const close = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { cwd, store, config, close };
}

// CONTAINMENT
// (decision sanctioned-script-store-writes-one-containment-helper-one-arg-parser, R5): the shared run-directory path builder for
// §10-adjacent scripts that read/write run-scoped files. cwd is
// always an opened project root by the time callers reach here (openProject/
// openMounted already ran), so this only throws on a genuinely malformed or
// attacked runId/tree — a caller that does not wrap the call gets a loud
// crash, which is still P5-compliant, just less polished than a clean fail().
export function runDir(cwd, runId) {
  return resolveStoreWritePath(cwd, '.sterling', 'runs', runId);
}
