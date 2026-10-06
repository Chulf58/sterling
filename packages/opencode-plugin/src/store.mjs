// The project store handle for the OpenCode plugin: the short in-process busy timeout.
import { basename, dirname } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { openRoutedStores } from '@sterling/store/routing';
import { storeBackend } from '../../../scripts/hooks/lib/store-backend.mjs';

// node:sqlite is synchronous, so a write that waits on another process's lock
// freezes OpenCode's whole event loop for the wait (measured 2026-10-02 in
// OpenCode 2.0.21's Bun 1.4.2: 5056 ms at the store's default 5000, zero timer
// ticks). A store write measured 37-73 ms, so 1000 ms still waits out an
// ordinary concurrent commit; a write that loses the race throws, and
// settlement retries the same range at the next execution.
export const BUSY_TIMEOUT_MS = 1000;

/**
 * Open the store at `dbPath` with the short in-process busy timeout. Every
 * caller passes a project's <root>/.sterling/sterling.db or a domain store's
 * file. When `dbPath` is a project's store path and that project's config says
 * storage 'postgres' (scripts/hooks/lib/store-backend.mjs), the project store
 * opens through @sterling/store/routing instead: never the SQLite file, and
 * every failure (an unreachable server, missing credentials or identity) is a
 * named error thrown to the caller's fence. The busy timeout does not apply
 * there; the router's 2 s connect timeout does.
 */
export function openProjectStore(dbPath) {
  const sterlingDir = dirname(dbPath);
  if (basename(dbPath) === 'sterling.db' && basename(sterlingDir) === '.sterling') {
    const root = dirname(sterlingDir);
    if (storeBackend(root) === 'routed') return openRoutedStores(root).store;
  }
  // The store passes busyTimeoutMs to its SQLite driver, which sets it when the
  // connection opens, so the whole open runs under the short timeout too.
  return new SterlingStore(dbPath, { busyTimeoutMs: BUSY_TIMEOUT_MS });
}
