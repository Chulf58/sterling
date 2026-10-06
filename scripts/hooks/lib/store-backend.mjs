// Which opener a project's store takes, decided from the project's own files
// and nothing else (issue Chulf58/sterling#26 item 5c; decision
// storage-backend-is-its-own-config-key-written-only-by-store-move).
//
// Dependency-free (node builtins only) so every hook bundle, plan-lock.mjs, the
// OpenCode plugin and the TUI can share it without pulling in a workspace
// package. It opens no database and never throws.
//
// 'sqlite' means today's SQLite open, byte for byte: the project file at
// .sterling/sterling.db, or no store when the file is absent. 'routed' means
// the project must be opened through @sterling/store/routing, which names
// every failure (an unreachable server, missing credentials, a missing
// identity, a malformed config) and never falls back to SQLite.
//
// What decides it is config.storage as written on disk:
// - no .sterling/config.json, or storage absent or 'sqlite': 'sqlite';
// - storage 'postgres', or any other value: 'routed' (the router refuses an
//   invalid value by name);
// - a config.json that cannot be read or does not parse: the backend is
//   unknown. When .sterling/sterling.db exists this stays 'sqlite', which is
//   today's behaviour (the hooks that read config report the bad config
//   themselves, and a store that was moved to Postgres keeps its SQLite file
//   only behind the move's write fence). With no SQLite file it is 'routed',
//   so the router's named StoreSettingsError surfaces instead of the hook
//   reading a Sterling project as "no store".
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_REL = join('.sterling', 'config.json');
export const STORE_DB_REL = join('.sterling', 'sterling.db');

/**
 * True when `dir` is a Sterling project root: it holds .sterling/config.json
 * (every project, whatever its storage) or .sterling/sterling.db (a SQLite
 * store with no config). A bare .sterling DIRECTORY is not enough: ~/.sterling
 * exists on every machine and holds the domain stores and the registry, never
 * a config.json.
 */
export function isSterlingRoot(dir) {
  return typeof dir === 'string' && (existsSync(join(dir, CONFIG_REL)) || existsSync(join(dir, STORE_DB_REL)));
}

/** 'sqlite' or 'routed' for the project at `root`; see the header. Never throws. */
export function storeBackend(root) {
  const dbExists = () => existsSync(join(root, STORE_DB_REL));
  let text;
  try {
    text = readFileSync(join(root, CONFIG_REL), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return 'sqlite';
    return dbExists() ? 'sqlite' : 'routed';
  }
  let storage;
  try {
    storage = JSON.parse(text)?.storage;
  } catch {
    return dbExists() ? 'sqlite' : 'routed';
  }
  return storage === undefined || storage === 'sqlite' ? 'sqlite' : 'routed';
}
