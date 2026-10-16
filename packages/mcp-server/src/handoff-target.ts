// Cross-project handoff target resolution (GitHub issue #105, user-ruled
// 2026-10-15): board_add's target_project names a project from this machine's
// project registry. Every refusal here happens before anything is written.
import { existsSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ProjectRegistry, registryPath, resolveReceiverLocation, type LocatorRow, type ReceiverRef } from '@sterling/store';
import { resolveStoreRoute } from '@sterling/store/routing';

export interface HandoffTarget {
  name: string;
  root: string;
  dbPath: string;
  /** this session's own project: its registry name, or its folder name when it is not registered */
  selfName: string;
}

function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // A path that does not exist has no real path; the absolute form is compared as given.
    return abs;
  }
}

/** Which tool resolves the target: board_add writes there, board_query and board_get only read. */
export type HandoffTargetUse = 'board_add' | 'board_query' | 'board_get';

const WRITE_WORDING = {
  nothing: 'Nothing was written.',
  noRoot: 'this server has no project root, so it cannot say which project the task comes from',
  self: "it is this session's own project; add the item without target_project",
  sqliteOnly: 'a handoff writes SQLite stores only',
  neverCreates: 'a handoff never creates one',
};

const READ_WORDING = {
  nothing: 'Nothing was read.',
  noRoot: 'this server has no project root, so it cannot tell its own project from another',
  self: "it is this session's own project; read it without target_project",
  sqliteOnly: 'another project\'s board is read from SQLite stores only',
  neverCreates: 'a read never creates one',
};

/** A hand-off tracker on this board: the receiver it names and when the tracker was created. */
export interface TrackerReceiverRef extends ReceiverRef {
  created_at?: string;
}

/**
 * The registered project `name` names, refused when: this server has no
 * project root; there is no registry; no project or more than one project
 * root carries the name; it is this session's own project; its root is gone;
 * it has no Sterling config or no SQLite store file (a handoff never creates
 * a store, because opening a missing SQLite store creates a fresh one); or its
 * storage is not SQLite.
 *
 * A read (board_query, board_get) may pass this board's hand-off trackers:
 * when no registered project has the name, a name a tracker was handed to is
 * followed to the project that tracker's receiver is now (resolveReceiverLocation
 * in @sterling/store, the same locator the tracker status uses), so a receiver
 * renamed or moved in the registry stays readable under its old name (GitHub
 * issues #117 and #119). board_add never follows a tracker: a write names a
 * current registry name.
 */
export function resolveHandoffTarget(
  name: string,
  selfRoot: string | undefined,
  regPath: string = registryPath(),
  use: HandoffTargetUse = 'board_add',
  trackers?: () => readonly TrackerReceiverRef[]
): HandoffTarget {
  const w = use === 'board_add' ? WRITE_WORDING : READ_WORDING;
  const refuse = (why: string) => new Error(`${use}: target_project '${name}' is refused: ${why}. ${w.nothing}`);
  if (!selfRoot) throw refuse(w.noRoot);
  if (!existsSync(regPath)) throw refuse(`there is no project registry at ${regPath} (projects are registered by /sterling:init)`);
  const registry = new ProjectRegistry(regPath);
  let snapshot;
  try {
    snapshot = registry.snapshot();
  } finally {
    registry.close();
  }
  const rows = snapshot.rows;
  const self = canonical(selfRoot);
  const selfRow = rows.find((r) => canonical(r.repo_path) === self);
  const selfName = selfRow?.name ?? basename(self);
  const roots = [...new Set(rows.filter((r) => r.name === name).map((r) => r.repo_path))];
  if (roots.length > 1) throw refuse(`the name is ambiguous, ${roots.length} registered roots carry it: ${roots.join(', ')}`);
  let root = roots[0];
  let resolvedName = name;
  if (root === undefined) {
    const unknownName = `no registered project has that name; registered: ${rows.length ? [...new Set(rows.map((r) => r.name))].join(', ') : '(none)'}`;
    const named = use === 'board_add' || !trackers ? [] : trackers().filter((t) => t.to_name === name);
    if (named.length === 0) throw refuse(unknownName);
    const found = new Map<string, LocatorRow>();
    const reasons = new Set<string>();
    for (const t of named) {
      const r = resolveReceiverLocation(t, t.created_at, snapshot);
      if ('row' in r) found.set(r.row.repo_path, r.row);
      else reasons.add(r.reason);
    }
    if (found.size === 0) throw refuse(`${unknownName}; this board's hand-off trackers to '${name}' resolve to no registered project: ${[...reasons].join('; ')}`);
    if (found.size > 1) throw refuse(`${unknownName}; this board's hand-off trackers to '${name}' point at ${found.size} registered projects: ${[...found.values()].map((r) => `'${r.name}' (${r.repo_path})`).join(', ')}`);
    const row = [...found.values()][0];
    root = row.repo_path;
    resolvedName = row.name;
  }
  if (canonical(root) === self) throw refuse(w.self);
  if (!existsSync(root)) throw refuse(`its registered root ${root} does not exist`);
  let route;
  try {
    route = resolveStoreRoute(root);
  } catch (e) {
    throw refuse(`its store settings could not be read (${(e as Error)?.message ?? String(e)})`);
  }
  if (route === null) throw refuse(`${root} has no .sterling/config.json, so it is not an initialized Sterling project`);
  if (route.storage !== 'sqlite') throw refuse(`its storage is ${route.storage}; ${w.sqliteOnly}`);
  const dbPath = join(root, '.sterling', 'sterling.db');
  if (!existsSync(dbPath)) throw refuse(`it has no store at ${dbPath}, and ${w.neverCreates}`);
  return { name: resolvedName, root, dbPath, selfName };
}
