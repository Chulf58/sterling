// @sterling/store — ProjectRegistry (decision foreign_8f9e6db2): the machine-global
// registry of /sterling:init'd projects, so projects are aware the others exist.
// SEPARATE from the project + domain knowledge stores and NOT in the
// knowledge_query fan — this is project METADATA, not domain knowledge. A single
// MUTABLE table (one row per project, upsert by repo_path): last_seen_at is
// touched every session, so the immutable+versioned record store would explode
// into version chains — a plain upsert table is the right model.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { projectRegistrationSchema, type ProjectRegistration } from '@sterling/schemas';

const REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  repo_path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stack_tags TEXT NOT NULL,
  toolchains TEXT NOT NULL,
  sterling_version TEXT,
  first_init_at TEXT NOT NULL,
  last_init_at TEXT NOT NULL,
  last_seen_at TEXT
);`;

// Project identity across folder moves (GitHub issue #119, decision
// moving-a-project-folder-repoints-the-registry-and-keeps-old-paths-as-aliases).
// Each row carries a project_key, a uuid assigned at first registration, kept
// across moves and renames and never reused. project_occupancy records which
// key held which path when: register opens an interval, a move closes the old
// path's interval and opens one at the new path, remove closes the interval
// and leaves it as the key's tombstone. A project that later registers at a
// reused path gets its own key and interval. Rows from before this table get
// a key and an open interval from MIGRATED_FROM, the earliest possible time.
const OCCUPANCY_DDL = `
CREATE TABLE IF NOT EXISTS project_occupancy (
  path TEXT NOT NULL,
  project_key TEXT NOT NULL,
  from_at TEXT NOT NULL,
  to_at TEXT
);
CREATE INDEX IF NOT EXISTS project_occupancy_path ON project_occupancy (path);
CREATE INDEX IF NOT EXISTS project_occupancy_key ON project_occupancy (project_key);`;

/** from_at of an interval opened by the migration: sorts before every ISO timestamp. */
export const MIGRATED_FROM = '';

/** One interval of a project (by key) at a path; to_at null while it is still there. */
export interface RegistryOccupancy {
  path: string;
  project_key: string;
  from_at: string;
  to_at: string | null;
}

/** What moveProject did. 'missing' = no row at the old path; 'conflict' = another row is at the new path; 'unchanged' = same path. */
export type MoveResult = { status: 'moved' | 'missing' | 'unchanged' } | { status: 'conflict'; conflict_path: string };

/** A registry row as the locator reads it. project_key is null only in a registry no writer has migrated yet. */
export interface LocatorRow {
  repo_path: string;
  name: string;
  project_key: string | null;
}

/** The registry as one read: its rows (with their keys) and the occupancy history. */
export interface RegistrySnapshot<R extends LocatorRow = LocatorRow> {
  rows: readonly R[];
  occupancy: readonly RegistryOccupancy[];
}

/** The receiver a hand-off tracker names: the root and the name it was handed to then. */
export interface ReceiverRef {
  to_root: string;
  to_name: string;
}

function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // A path that does not exist (a moved-away folder) has no real path; its absolute form is compared.
    return abs;
  }
}

/**
 * The registry row a hand-off tracker's receiver is now, or why there is none
 * (GitHub issues #117 and #119). With the tracker's own created_at: the
 * occupancy interval on to_root that contains it names the project key that
 * was there then, and that key's current row (wherever it is now, under
 * whatever name) is the receiver; a key with no row is a removed project,
 * reported as such and never handed to whoever holds the path now. With no
 * created_at, or no interval containing it: the row at to_root now, then the
 * one row named to_name (a label that can go stale). Paths compare canonical.
 */
export function resolveReceiverLocation<R extends LocatorRow>(
  ref: ReceiverRef,
  createdAt: string | undefined,
  snapshot: RegistrySnapshot<R>
): { row: R; via: 'history' | 'root' | 'name' } | { reason: string } {
  const root = canonicalPath(ref.to_root);
  if (createdAt !== undefined) {
    const then = snapshot.occupancy.find((o) => o.from_at <= createdAt && (o.to_at === null || createdAt < o.to_at) && canonicalPath(o.path) === root);
    if (then) {
      const row = snapshot.rows.find((r) => r.project_key === then.project_key);
      if (row) return { row, via: 'history' };
      const last = snapshot.occupancy.filter((o) => o.project_key === then.project_key).sort((a, b) => (a.from_at < b.from_at ? 1 : -1))[0];
      return {
        reason: `the project at ${ref.to_root} when this tracker was created is no longer registered (it was last registered at ${last.path}${last.to_at ? ` until ${last.to_at}` : ''})`,
      };
    }
  }
  const byRoot = snapshot.rows.find((r) => canonicalPath(r.repo_path) === root);
  if (byRoot) return { row: byRoot, via: 'root' };
  const byName = snapshot.rows.filter((r) => r.name === ref.to_name);
  const roots = new Set(byName.map((r) => r.repo_path));
  if (roots.size === 1) return { row: byName[0], via: 'name' };
  if (roots.size > 1) return { reason: `no registered project has its root ${ref.to_root}, and its name '${ref.to_name}' is ambiguous (${roots.size} registered roots carry it)` };
  return { reason: `no registered project has its root ${ref.to_root} or its name '${ref.to_name}'` };
}

/** The shared registry lives beside the domain stores under the per-user root
 *  (~/.sterling/registry.db) — never a synced folder (§2.3). */
export function registryPath(): string {
  // STERLING_REGISTRY_DB relocates the machine-global registry — primarily so
  // tests that spawn real init processes isolate from the user's actual registry.
  return process.env.STERLING_REGISTRY_DB ?? join(homedir(), '.sterling', 'registry.db');
}

/** What init knows about a project at registration time. */
export interface RegisterInput {
  repo_path: string; // absolute POSIX
  name: string;
  stack_tags: string[];
  toolchains: string[];
  sterling_version: string | null;
  at: string; // ISO timestamp
}

/** What renameIfUnique did: wrote the name, found it already set, found another
 *  project holding it (conflict_path), or found no row at the path. */
export type RenameResult =
  | { status: 'renamed' | 'unchanged' | 'missing' }
  | { status: 'conflict'; conflict_path: string };

export class ProjectRegistry {
  private db: DatabaseSync;

  constructor(path: string = registryPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(REGISTRY_DDL);
      this.migrateIdentity();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw e;
    }
  }

  /** Idempotent, inside the constructor's transaction: the project_key
   *  column, the occupancy table, a key and an open MIGRATED_FROM interval for
   *  every row without a key. The path-alias table an unreleased build of
   *  this branch wrote is dropped (it never shipped). */
  private migrateIdentity(): void {
    const cols = this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'project_key')) this.db.exec('ALTER TABLE projects ADD COLUMN project_key TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS projects_project_key ON projects (project_key)');
    this.db.exec(OCCUPANCY_DDL);
    this.db.exec('DROP TABLE IF EXISTS project_path_aliases');
    const unkeyed = this.db.prepare('SELECT repo_path FROM projects WHERE project_key IS NULL').all() as { repo_path: string }[];
    for (const { repo_path } of unkeyed) {
      const key = randomUUID();
      this.db.prepare('UPDATE projects SET project_key = ? WHERE repo_path = ?').run(key, repo_path);
      this.db.prepare('INSERT INTO project_occupancy (path, project_key, from_at, to_at) VALUES (?, ?, ?, NULL)').run(repo_path, key, MIGRATED_FROM);
    }
  }

  /** Run `fn` in one BEGIN IMMEDIATE transaction. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Upsert by repo_path (init event, P4): create on first init
   *  (first_init_at = last_init_at = at, a new project_key, an occupancy
   *  interval opened at `at`), refresh the mutable fields + last_init_at on
   *  re-init while preserving first_init_at and the key. */
  register(input: RegisterInput): void {
    this.tx(() => {
      const own = this.db.prepare('SELECT project_key FROM projects WHERE repo_path = ?').get(input.repo_path) as { project_key: string } | undefined;
      if (own) {
        this.db
          .prepare('UPDATE projects SET name = ?, stack_tags = ?, toolchains = ?, sterling_version = ?, last_init_at = ? WHERE repo_path = ?')
          .run(input.name, JSON.stringify(input.stack_tags), JSON.stringify(input.toolchains), input.sterling_version, input.at, input.repo_path);
        const open = this.db.prepare('SELECT 1 FROM project_occupancy WHERE path = ? AND project_key = ? AND to_at IS NULL').get(input.repo_path, own.project_key);
        if (!open) this.db.prepare('INSERT INTO project_occupancy (path, project_key, from_at, to_at) VALUES (?, ?, ?, NULL)').run(input.repo_path, own.project_key, input.at);
        return;
      }
      const key = randomUUID();
      this.db
        .prepare(
          `INSERT INTO projects (repo_path, name, stack_tags, toolchains, sterling_version, first_init_at, last_init_at, last_seen_at, project_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(input.repo_path, input.name, JSON.stringify(input.stack_tags), JSON.stringify(input.toolchains), input.sterling_version, input.at, input.at, key);
      this.db.prepare('INSERT INTO project_occupancy (path, project_key, from_at, to_at) VALUES (?, ?, ?, NULL)').run(input.repo_path, key, input.at);
    });
  }

  /** Session-activity touch (H1 SessionStart): update last_seen_at for an
   *  EXISTING row only — never create (registration is init's job). Returns
   *  whether a row was updated. */
  touchLastSeen(repoPath: string, at: string): boolean {
    return this.db.prepare('UPDATE projects SET last_seen_at = ? WHERE repo_path = ?').run(at, repoPath).changes > 0;
  }

  /** Mount-change refresh (/sterling:domains --apply): replace stack_tags of an
   *  EXISTING row and nothing else, so the row's init dates and version still
   *  say when and by which Sterling the project was last initialized. Never
   *  creates a row. Returns whether a row was updated. */
  updateStackTags(repoPath: string, stackTags: string[]): boolean {
    return this.db.prepare('UPDATE projects SET stack_tags = ? WHERE repo_path = ?').run(JSON.stringify(stackTags), repoPath).changes > 0;
  }

  /** Rename (config.json project_name changed, or /sterling:projects --rename):
   *  replace the name of an EXISTING row and nothing else, only when no other row
   *  carries the name. The check and the UPDATE run in one BEGIN IMMEDIATE
   *  transaction, so two projects renaming to the same name at once cannot both
   *  win: the second sees the first's row and gets 'conflict'. `selfPaths` are
   *  the repo_paths that count as this project (rows that spell one folder
   *  differently); a row there never conflicts. Never creates a row.
   *  'unchanged' = the row already has the name; 'missing' = no row at repoPath. */
  renameIfUnique(repoPath: string, name: string, selfPaths: string[] = [repoPath]): RenameResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const own = this.db.prepare('SELECT name FROM projects WHERE repo_path = ?').get(repoPath) as { name: string } | undefined;
      let result: RenameResult;
      if (!own) result = { status: 'missing' };
      else if (own.name === name) result = { status: 'unchanged' };
      else {
        const taken = (this.db.prepare('SELECT repo_path FROM projects WHERE name = ?').all(name) as { repo_path: string }[]).find((r) => !selfPaths.includes(r.repo_path));
        if (taken) result = { status: 'conflict', conflict_path: taken.repo_path };
        else {
          this.db.prepare('UPDATE projects SET name = ? WHERE repo_path = ?').run(name, repoPath);
          result = { status: 'renamed' };
        }
      }
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** All registered projects, name-ordered. Stale-at-read (existence of
   *  repo_path) is the caller's lazy check — the registry stores no liveness. */
  list(): ProjectRegistration[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY name')
      .all()
      .map((r) =>
        projectRegistrationSchema.parse({
          ...r,
          stack_tags: JSON.parse((r as { stack_tags: string }).stack_tags),
          toolchains: JSON.parse((r as { toolchains: string }).toolchains),
        })
      );
  }

  /** The whole occupancy history, oldest interval first. */
  occupancy(): RegistryOccupancy[] {
    return (this.db.prepare('SELECT path, project_key, from_at, to_at FROM project_occupancy ORDER BY from_at, path').all() as unknown as RegistryOccupancy[]).map((o) => ({
      path: o.path,
      project_key: o.project_key,
      from_at: o.from_at,
      to_at: o.to_at,
    }));
  }

  /** The project_key of the row at repoPath, or undefined. */
  keyOf(repoPath: string): string | undefined {
    return (this.db.prepare('SELECT project_key FROM projects WHERE repo_path = ?').get(repoPath) as { project_key: string } | undefined)?.project_key;
  }

  /** Rows (repo_path, name, project_key) and the occupancy history in one read transaction. */
  snapshot(): RegistrySnapshot {
    this.db.exec('BEGIN');
    try {
      const rows = (this.db.prepare('SELECT repo_path, name, project_key FROM projects ORDER BY name').all() as unknown as LocatorRow[]).map((r) => ({
        repo_path: r.repo_path,
        name: r.name,
        project_key: r.project_key,
      }));
      const snap = { rows, occupancy: this.occupancy() };
      this.db.exec('COMMIT');
      return snap;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Folder move (/sterling:projects --move, GitHub issue #119): repoint the
   *  row at `fromPath` to `toPath`, keeping its project_key; the key's interval
   *  at `fromPath` closes at `at` and one at `toPath` opens. The conflict check
   *  (another row at `toPath`), the row update and the interval writes run in
   *  one BEGIN IMMEDIATE transaction. Touches nothing on disk. */
  moveProject(fromPath: string, toPath: string, at: string): MoveResult {
    if (fromPath === toPath) return { status: 'unchanged' };
    return this.tx((): MoveResult => {
      const key = this.keyOf(fromPath);
      if (key === undefined) return { status: 'missing' };
      const taken = this.db.prepare('SELECT repo_path FROM projects WHERE repo_path = ?').get(toPath) as { repo_path: string } | undefined;
      if (taken) return { status: 'conflict', conflict_path: taken.repo_path };
      this.db.prepare('UPDATE projects SET repo_path = ? WHERE repo_path = ?').run(toPath, fromPath);
      this.db.prepare('UPDATE project_occupancy SET to_at = ? WHERE project_key = ? AND to_at IS NULL').run(at, key);
      this.db.prepare('INSERT INTO project_occupancy (path, project_key, from_at, to_at) VALUES (?, ?, ?, NULL)').run(toPath, key, at);
      return { status: 'moved' };
    });
  }

  /** Human-gated removal (the /sterling:projects prune of a missing project) —
   *  never automatic. Returns whether a row was removed. The key's open
   *  interval closes at `at` and stays as its tombstone, so a tracker created
   *  while the project was registered reads "no longer registered" and never
   *  resolves to a project that registers at the path later. */
  remove(repoPath: string, at: string = new Date().toISOString()): boolean {
    return this.tx(() => {
      const key = this.keyOf(repoPath);
      if (key === undefined) return false;
      this.db.prepare('DELETE FROM projects WHERE repo_path = ?').run(repoPath);
      this.db.prepare('UPDATE project_occupancy SET to_at = ? WHERE project_key = ? AND to_at IS NULL').run(at, key);
      return true;
    });
  }

  close(): void {
    this.db.close();
  }
}
