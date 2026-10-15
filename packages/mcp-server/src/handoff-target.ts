// Cross-project handoff target resolution (GitHub issue #105, user-ruled
// 2026-10-15): board_add's target_project names a project from this machine's
// project registry. Every refusal here happens before anything is written.
import { existsSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ProjectRegistry, registryPath } from '@sterling/store';
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

/**
 * The registered project `name` names, refused when: this server has no
 * project root; there is no registry; no project or more than one project
 * root carries the name; it is this session's own project; its root is gone;
 * it has no Sterling config or no SQLite store file (a handoff never creates
 * a store, because opening a missing SQLite store creates a fresh one); or its
 * storage is not SQLite.
 */
export function resolveHandoffTarget(name: string, selfRoot: string | undefined, regPath: string = registryPath()): HandoffTarget {
  const refuse = (why: string) => new Error(`board_add: target_project '${name}' is refused: ${why}. Nothing was written.`);
  if (!selfRoot) throw refuse('this server has no project root, so it cannot say which project the task comes from');
  if (!existsSync(regPath)) throw refuse(`there is no project registry at ${regPath} (projects are registered by /sterling:init)`);
  const registry = new ProjectRegistry(regPath);
  let rows;
  try {
    rows = registry.list();
  } finally {
    registry.close();
  }
  const self = canonical(selfRoot);
  const selfRow = rows.find((r) => canonical(r.repo_path) === self);
  const selfName = selfRow?.name ?? basename(self);
  const roots = [...new Set(rows.filter((r) => r.name === name).map((r) => r.repo_path))];
  if (roots.length === 0) {
    throw refuse(`no registered project has that name; registered: ${rows.length ? [...new Set(rows.map((r) => r.name))].join(', ') : '(none)'}`);
  }
  if (roots.length > 1) throw refuse(`the name is ambiguous, ${roots.length} registered roots carry it: ${roots.join(', ')}`);
  const root = roots[0];
  if (canonical(root) === self) throw refuse('it is this session\'s own project; add the item without target_project');
  if (!existsSync(root)) throw refuse(`its registered root ${root} does not exist`);
  let route;
  try {
    route = resolveStoreRoute(root);
  } catch (e) {
    throw refuse(`its store settings could not be read (${(e as Error)?.message ?? String(e)})`);
  }
  if (route === null) throw refuse(`${root} has no .sterling/config.json, so it is not an initialized Sterling project`);
  if (route.storage !== 'sqlite') throw refuse(`its storage is ${route.storage}; a handoff writes SQLite stores only`);
  const dbPath = join(root, '.sterling', 'sterling.db');
  if (!existsSync(dbPath)) throw refuse(`it has no store at ${dbPath}, and a handoff never creates one`);
  return { name, root, dbPath, selfName };
}
