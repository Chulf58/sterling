// The project store handle for the OpenCode plugin: the short in-process busy
// timeout on SQLite, and one held routed store per project on Postgres.
import { basename, dirname } from 'node:path';
import { PgBridgeClosedError, PgBridgeTimeoutError, PgWorkerDiedError, SterlingStore } from '@sterling/store';
import { openRoutedStores } from '@sterling/store/routing';
import { storeBackend } from '../../../scripts/hooks/lib/store-backend.mjs';

// node:sqlite is synchronous, so a write that waits on another process's lock
// freezes OpenCode's whole event loop for the wait (measured 2026-10-02 in
// OpenCode 2.0.21's Bun 1.4.2: 5056 ms at the store's default 5000, zero timer
// ticks). A store write measured 37-73 ms, so 1000 ms still waits out an
// ordinary concurrent commit; a write that loses the race throws, and
// settlement retries the same range at the next execution.
export const BUSY_TIMEOUT_MS = 1000;

/** The project root when `dbPath` is a project's <root>/.sterling/sterling.db, else null. */
function projectRootOf(dbPath) {
  const sterlingDir = dirname(dbPath);
  if (basename(dbPath) === 'sterling.db' && basename(sterlingDir) === '.sterling') return dirname(sterlingDir);
  return null;
}

/**
 * Open the store at `dbPath` with the short busy timeout. Every caller passes a
 * project's <root>/.sterling/sterling.db or a domain store's file. When
 * `dbPath` is a project's store path and that project's config says storage
 * 'postgres' (scripts/hooks/lib/store-backend.mjs), the project store opens
 * through @sterling/store/routing instead: never the SQLite file, and every
 * failure (an unreachable server, missing credentials or identity) is a named
 * error thrown to the caller's fence. The busy timeout does not apply there;
 * the router's 2 s connect timeout does. The caller closes what it gets. The
 * plugin itself opens through createProjectStores(), which holds the routed
 * store instead.
 */
export function openProjectStore(dbPath) {
  const root = projectRootOf(dbPath);
  if (root !== null && storeBackend(root) === 'routed') return openRoutedStores(root).store;
  // The store passes busyTimeoutMs to its SQLite driver, which sets it when the
  // connection opens, so the whole open runs under the short timeout too.
  return new SterlingStore(dbPath, { busyTimeoutMs: BUSY_TIMEOUT_MS });
}

/** The bridge under a routed store is gone (its worker died, a wait timed out, or it was closed), so the store cannot run another statement. */
function bridgeGone(e) {
  return e instanceof PgWorkerDiedError || e instanceof PgBridgeTimeoutError || e instanceof PgBridgeClosedError;
}

/**
 * The plugin's project stores. `open(dbPath)` is the plugin's openStore; its
 * callers close what they get in a finally.
 *
 * SQLite storage, and every domain store file: a new store per call with the
 * short busy timeout, which the caller's close() closes, as before.
 *
 * Postgres storage: one routed store per project root, opened on first use and
 * held until release(root) or until its bridge is gone. Each routed open spawns
 * a Postgres worker, connects and takes the store's setup locks while OpenCode's
 * main thread waits; the held store keeps the process's one shared bridge
 * (routing.ts leases) alive, so later operations reuse the connection. Callers
 * get a view of it whose close() does nothing. The held store keeps no
 * transaction open between operations: SterlingStore begins and ends each one
 * inside the call that needs it. An open that fails throws the router's named
 * error to the caller's fence and holds nothing, so the next operation tries
 * again; nothing falls back to SQLite. A call that throws because the bridge
 * is gone (PgWorkerDiedError, PgBridgeTimeoutError, PgBridgeClosedError) fails
 * loud, and the held store is closed and dropped, so the next operation opens a
 * new connection.
 *
 * `openRouted(root)` and `backend(root)` are test seams.
 */
export function createProjectStores({ openRouted = (root) => openRoutedStores(root).store, backend = storeBackend } = {}) {
  const held = new Map();

  function drop(root, store) {
    if (held.get(root)?.store !== store) return;
    held.delete(root);
    store.close();
  }

  /** The caller's view of a held store: close() does nothing, and a call that finds the bridge gone drops the held store, then rethrows. */
  function view(root, store) {
    return new Proxy(store, {
      get(target, prop) {
        if (prop === 'close') return () => {};
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        return (...args) => {
          try {
            return value.apply(target, args);
          } catch (e) {
            if (bridgeGone(e)) drop(root, target);
            throw e;
          }
        };
      },
    });
  }

  function open(dbPath) {
    const root = projectRootOf(dbPath);
    if (root === null || backend(root) !== 'routed') return new SterlingStore(dbPath, { busyTimeoutMs: BUSY_TIMEOUT_MS });
    let entry = held.get(root);
    if (!entry) {
      const store = openRouted(root);
      entry = { store, view: view(root, store) };
      held.set(root, entry);
    }
    return entry.view;
  }

  /** Closes the store held for `root`, if any. The next operation there opens a new one. */
  function release(root) {
    const entry = held.get(root);
    if (entry) drop(root, entry.store);
  }

  return { open, release };
}
