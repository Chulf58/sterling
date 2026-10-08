// Change detection for the dashboard's state cache: PRAGMA data_version on a
// separate read-only connection per SQLite file the dashboard reads (the
// project store plus each mounted domain store). SQLite changes the value
// whenever ANOTHER connection commits, and the store's own connection counts
// as another one here, so the dashboard's own writes are seen as well as the
// MCP server's and the hooks'. Reading it takes no lock.
//
// The connections are read-only on purpose: a writable handle on a WAL
// database checkpoints into the main file when it closes (anti-pattern
// a-writable-sqlite-open-on-a-wal-database-mutates-the-main-fi).
import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface DataVersionProbe {
  /** one token covering every probed file; it changes after any commit to any of them.
   *  undefined when a read failed: the caller must then treat the data as changed. */
  read(): string | undefined;
  close(): void;
}

/** Open the probe over the given store files. A file that does not exist is
 *  skipped (the dashboard skips a missing domain the same way). An open
 *  failure throws: the caller decides how to degrade. */
export function openDataVersionProbe(paths: string[]): DataVersionProbe {
  const conns: { db: DatabaseSync; stmt: StatementSync }[] = [];
  try {
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const db = new DatabaseSync(path, { readOnly: true });
      conns.push({ db, stmt: db.prepare('PRAGMA data_version') });
    }
  } catch (err) {
    for (const c of conns) c.db.close();
    throw err;
  }
  return {
    read() {
      try {
        return conns.map((c) => String((c.stmt.get() as { data_version: number }).data_version)).join(':');
      } catch {
        // a failed read is never "unchanged": the caller rebuilds from the store
        return undefined;
      }
    },
    close() {
      for (const c of conns) c.db.close();
    },
  };
}
