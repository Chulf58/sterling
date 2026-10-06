// The TUI selection slot for a Postgres-storage project (decision
// postgres-store-backend-design-sync-bridge-schema-per-store, point 9: the
// selection slot stays local). With SQLite storage the slot is the store's
// `selection` row, as before. With Postgres storage the project store is
// shared by every machine that works on the project, so a selection made in
// this checkout's TUI must not be consumed by a prompt on another machine: it
// lives in a file under this checkout's .sterling/transient/, named for this
// host.
//
// The same one-shot contract as the row: the TUI overwrites the slot, and the
// next prompt takes it (read and remove). The take claims the file by renaming
// it to a name unique to this process first, so two prompts racing for one
// selection cannot both get it. A claimed file that does not hold a selection
// is removed and the take throws, naming the file: a bad slot is reported,
// never read as "nothing selected".
//
// What it does not do: scope the slot to one Claude Code or OpenCode session.
// The TUI is started without a session id, so every session in this checkout
// on this host shares the slot, exactly as every session shares the SQLite row.
//
// Dependency-free (node builtins only): hooks, the OpenCode plugin and the TUI
// all import it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** The slot file for `root` on this host: .sterling/transient/selection.<host>.json. */
export function selectionFilePath(root, host = hostname()) {
  const safeHost = String(host).replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown-host';
  return join(root, '.sterling', 'transient', `selection.${safeHost}.json`);
}

/** Write (or overwrite) the slot. Written to a temp file and renamed, so a reader never sees half a selection. */
export function writeSelectionFile(root, type, recordId, at) {
  const path = selectionFilePath(root);
  mkdirSync(join(root, '.sterling', 'transient'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify({ type, record_id: recordId, at }));
  renameSync(tmp, path);
}

/** Take the slot one-shot: {type, record_id, at}, or undefined when nothing is selected. Throws on a slot that is not a selection. */
export function takeSelectionFile(root) {
  const path = selectionFilePath(root);
  const claimed = `${path}.taken-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, claimed);
  } catch (e) {
    if (e?.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const raw = JSON.parse(readFileSync(claimed, 'utf8'));
    if (typeof raw?.type !== 'string' || typeof raw?.record_id !== 'string' || typeof raw?.at !== 'string') {
      throw new Error('it is not {type, record_id, at}');
    }
    return { type: raw.type, record_id: raw.record_id, at: raw.at };
  } catch (e) {
    throw new Error(`the TUI selection slot ${path} could not be read (${(e && e.message) || e}); it was removed, so select the record again`);
  } finally {
    rmSync(claimed, { force: true });
  }
}
