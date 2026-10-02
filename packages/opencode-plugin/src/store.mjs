// The project store handle for the OpenCode plugin: the short in-process busy timeout.
import { SterlingStore } from '@sterling/store';

// node:sqlite is synchronous, so a write that waits on another process's lock
// freezes OpenCode's whole event loop for the wait (measured 2026-10-02 in
// OpenCode 2.0.21's Bun 1.4.2: 5056 ms at the store's default 5000, zero timer
// ticks). A store write measured 37-73 ms, so 1000 ms still waits out an
// ordinary concurrent commit; a write that loses the race throws, and
// settlement retries the same range at the next execution.
export const BUSY_TIMEOUT_MS = 1000;

/** Open the project store with the short in-process busy timeout. */
export function openProjectStore(dbPath) {
  const store = new SterlingStore(dbPath);
  // SterlingStore sets busy_timeout=5000 in its constructor and exposes no
  // option for it; `db` is TypeScript-private only. A missing handle is a
  // store change this plugin must hear about, so it throws.
  const db = store['db'];
  if (!db || typeof db.exec !== 'function') {
    store.close();
    throw new Error('SterlingStore no longer exposes its database handle; cannot set the in-process busy_timeout');
  }
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  return store;
}
