// @sterling/store — ProjectRegistry (decision 8f9e6db2): the machine-global
// registry of /sterling:init'd projects, so projects are aware the others exist.
// SEPARATE from the project + domain knowledge stores and NOT in the
// knowledge_query fan — this is project METADATA, not domain knowledge. A single
// MUTABLE table (one row per project, upsert by repo_path): last_seen_at is
// touched every session, so the immutable+versioned record store would explode
// into version chains — a plain upsert table is the right model.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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

export class ProjectRegistry {
  private db: DatabaseSync;

  constructor(path: string = registryPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec(REGISTRY_DDL);
  }

  /** Upsert by repo_path (init event, P4): create on first init
   *  (first_init_at = last_init_at = at), refresh the mutable fields + last_init_at
   *  on re-init while preserving first_init_at. */
  register(input: RegisterInput): void {
    this.db
      .prepare(
        `INSERT INTO projects (repo_path, name, stack_tags, toolchains, sterling_version, first_init_at, last_init_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(repo_path) DO UPDATE SET
           name = excluded.name,
           stack_tags = excluded.stack_tags,
           toolchains = excluded.toolchains,
           sterling_version = excluded.sterling_version,
           last_init_at = excluded.last_init_at`
      )
      .run(
        input.repo_path,
        input.name,
        JSON.stringify(input.stack_tags),
        JSON.stringify(input.toolchains),
        input.sterling_version,
        input.at,
        input.at
      );
  }

  /** Session-activity touch (H1 SessionStart): update last_seen_at for an
   *  EXISTING row only — never create (registration is init's job). Returns
   *  whether a row was updated. */
  touchLastSeen(repoPath: string, at: string): boolean {
    return this.db.prepare('UPDATE projects SET last_seen_at = ? WHERE repo_path = ?').run(at, repoPath).changes > 0;
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

  /** Human-gated removal (the /sterling:projects prune of a missing project) —
   *  never automatic. Returns whether a row was removed. */
  remove(repoPath: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE repo_path = ?').run(repoPath).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
