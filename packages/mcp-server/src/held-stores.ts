// The MCP server's stores on Postgres storage: one routed MountedStores held for
// the process, dropped when its connection closes, opened again on the next call.
//
// Before this, a bridge whose worker died (2026-10-06: "read ECONNRESET") left
// the server holding stores on a dead connection, so every later tool call, and
// every hook served through the broker, failed with PgBridgeClosedError until
// the session restarted (board 2b966da0).
//
// The rule, from the OpenCode plugin's lease (branch opencode-plugin-pg-lease):
// - A call that is running when the connection dies fails with its own error
//   (PgWorkerDiedError, PgBridgeTimeoutError, a PgQueryError). Nothing is
//   retried: a retried write could apply twice.
// - The NEXT call, at top level, finds connectionLost() set: it prints one line
//   on stderr, closes the dead stores (returning their leases) and opens new
//   ones through `reopen`, then runs on them.
// - A reopen that fails throws its own error to that call and holds nothing; the
//   call after it tries again. Nothing falls back to SQLite.
// - Inside a running call (a withTransaction callback calling back into the
//   stores) nothing is swapped: those calls stay on the stores the outer call
//   started on, so a transaction never continues on a second connection.
// - After close() nothing reopens; calls reach the closed stores as before.

import type { MountedStores } from '@sterling/store';
import type { RoutedMounted } from '@sterling/store/routing';

export function holdRoutedStores(opened: RoutedMounted, reopen: () => RoutedMounted, announce: (line: string) => void): MountedStores {
  let current: RoutedMounted | undefined = opened;
  let last: MountedStores = opened.stores;
  let depth = 0;
  let closed = false;

  function live(): MountedStores {
    if (closed) return last;
    if (current !== undefined) {
      // Inside a call nothing is swapped, even on a lost connection: the call
      // that found it fails, and so does anything it runs after that.
      if (depth > 0) return current.stores;
      const lost = current.connectionLost();
      if (lost === undefined) return current.stores;
      announce(`sterling-mcp: the Postgres connection closed (${lost}); the call that found it failed and was not retried. Opening a new connection for this call.`);
      const dead = current;
      current = undefined;
      dead.stores.close();
    }
    current = reopen();
    last = current.stores;
    return current.stores;
  }

  return new Proxy(opened.stores, {
    get(_target, prop) {
      if (prop === 'close') {
        return () => {
          closed = true;
          last.close();
        };
      }
      const stores = live();
      const value: unknown = Reflect.get(stores, prop, stores);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        depth += 1;
        try {
          return (value as (...a: unknown[]) => unknown).apply(stores, args);
        } finally {
          depth -= 1;
        }
      };
    },
  });
}
