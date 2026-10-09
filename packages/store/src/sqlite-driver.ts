// The SQLite driver: the one StoreDriver implementation, and the only file in
// @sterling/store's record store that names node:sqlite.
//
// Substrate (verified at build against §3.1 criteria): SQLite via node:sqlite
// (Node ≥24, bundled SQLite 3.51.x — WAL, FTS5/bm25, VACUUM INTO; zero native
// dependencies). node:sqlite is API-experimental, so all contact with it stays
// in this file. It holds the connection, the DDL, the open-time PRAGMAs, the
// journal-mode policy, user_version, BEGIN IMMEDIATE and the SQLite spelling of
// each StoreDialect hook.

import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { dirname, basename, join, resolve as resolvePath } from 'node:path';
import type { StoreDialect, StoreDriver, StoreStatement } from './driver.js';

const DDL = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  superseded_by TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'live',
  freshness TEXT NOT NULL DEFAULT 'fresh',
  version INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  author TEXT NOT NULL,
  derived_unconfirmed INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_type_status ON records(type, status);
-- Schema v2 identity tables [stable-identity-design-v2].
-- record_versions: FULL-RECORD JSON snapshots, one per (record_id, version).
-- Append-only and permanent — NEVER indexed into records_fts, so an archived
-- version's text can never rank in query() (the whole point of contract 1).
CREATE TABLE IF NOT EXISTS record_versions (
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (record_id, version)
);
-- record_aliases: dead-id lookup (historical_id -> canonical_id + the version
-- archived under that historical id). NOTHING writes it in S2 — the S4
-- migration runner populates it once; it is an index, not a namespace.
CREATE TABLE IF NOT EXISTS record_aliases (
  historical_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  archived_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
-- remove() deletes aliases by canonical_id.
CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON record_aliases(canonical_id);
-- record_relations: the AUTHORITATIVE home of typed edges (supersedes,
-- cites, ...). Replaces record_links: served links[] materializes from here,
-- and supersession is a relation rather than a column value a caller sets.
CREATE TABLE IF NOT EXISTS record_relations (
  source_id TEXT NOT NULL,
  rel TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, rel, target_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_target ON record_relations(target_id);
CREATE INDEX IF NOT EXISTS idx_relations_rel_target ON record_relations(rel, target_id);
CREATE TABLE IF NOT EXISTS record_stack_tags (
  record_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (record_id, tag)
);
CREATE TABLE IF NOT EXISTS record_file_keys (
  record_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (record_id, path)
);
CREATE INDEX IF NOT EXISTS idx_file_keys_path ON record_file_keys(path);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(record_id UNINDEXED, text);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  machine_state TEXT NOT NULL,
  pending_exit TEXT,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_run_phase ON handoffs(run_id, phase_id);
CREATE TABLE IF NOT EXISTS check_skipped (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  check_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS selection (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_drain_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  drained_at TEXT NOT NULL,
  system_reason TEXT NOT NULL,
  text TEXT NOT NULL,
  file_keys TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  verb TEXT NOT NULL,
  type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  title TEXT NOT NULL
);
-- Store-level key/value metadata (board 675daf9d, decision
-- projects-mount-domains-and-sibling-projects): a domain store's description is
-- its 'description' key. Additive: CREATE IF NOT EXISTS on every v2 open, so no
-- user_version bump; a pre-v2 store opens read-only before this DDL runs.
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Journal-mode policy (decision store-journal-policy-delete-on-9p): SQLite WAL
 * needs coherent shared memory (-shm) across every process that opens the
 * database, and the 9p/drvfs mount WSL uses for Windows drives does not
 * provide it — measured twice on that topology as intermittent
 * SQLITE_IOERR_SHORT_READ / 'database is locked' incident families. A store
 * reached over such a mount is demoted to journal_mode=DELETE (no -shm at
 * all), and the demotion is STICKY: a non-9p open of an EXISTING store
 * already in DELETE leaves it alone rather than flipping it back, so a
 * native-Windows open never fights a WSL demotion. Fresh stores are
 * classified explicitly because a brand-new SQLite file is born in DELETE
 * mode — without the freshness arm a fresh single-context store would never
 * enter WAL at all.
 */
export function journalDemotionRequired(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'linux') return false;
  return /^\/mnt\/[a-zA-Z]\//.test(absPath.replace(/\\/g, '/'));
}

/**
 * A required 9p demotion did not land — refusing the open (P5): proceeding in
 * WAL would keep the exact unsafe topology the policy exists to remove.
 *
 * fixer-mode F1: `options.cause` carries the original thrown error when the
 * refusal came from a PRAGMA that threw (e.g. SQLITE_BUSY under a live
 * holder) rather than one that merely returned an unexpected mode; readers
 * needing the raw driver error read `.cause`. `options.message` lets a caller
 * override the default 9p-demotion wording entirely for a refusal that is NOT
 * a demotion-under-contention case (fixer-mode F2's legacy-schema arm has its
 * own remedy — migrate the store — and must not tell the reader to close
 * connections and retry, which would not help there).
 */
export class JournalDemotionRefusedError extends Error {
  constructor(
    readonly dbPath: string,
    readonly returnedMode: string,
    options?: { cause?: unknown; message?: string },
  ) {
    super(
      options?.message ??
        `journal_mode=DELETE demotion refused for '${dbPath}' (PRAGMA returned '${returnedMode}') — ` +
          `this store is reached over a 9p mount where WAL is unsupported (decision ` +
          `store-journal-policy-delete-on-9p); close every other connection (MCP server, TUI, hooks) and retry.`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = 'JournalDemotionRefusedError';
  }
}

/** The busy timeout a SqliteDriver sets when its opener passes none. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface SqliteDriverOptions {
  /** PRAGMA busy_timeout for this connection, in milliseconds: how long a statement waits on another connection's lock before it throws. Default 5000. */
  busyTimeoutMs?: number;
}

/** SQLite's spelling of each dialect hook: the SQL SterlingStore sent before the seam, unchanged. */
export const sqliteDialect: StoreDialect = {
  searchJoin: 'JOIN records_fts f ON f.record_id = r.id',
  searchJoinBinds: 0,
  searchMatch: 'records_fts MATCH ?',
  // FTS5's bm25() is LOWER for a better match, so the score is its negation.
  searchScore: '(-bm25(records_fts))',
  searchOrder: 'bm25(records_fts) ASC',
  scoreScale: 'fts5_bm25',
  // FTS5's unicode61 tokenizer does its own folding; the text goes in as built.
  searchText: (text) => text,
  /**
   * The FTS5 MATCH expression rank_terms compiles to. A trailing '*' marks an
   * FTS5 prefix query ("stor*" matches "store") — the star must sit OUTSIDE the
   * quoted token to act as the prefix operator.
   */
  searchQuery(terms, matchAll) {
    const joiner = matchAll ? ' AND ' : ' OR ';
    return terms.map((t) => (t.endsWith('*') && t.length > 1 ? `"${t.slice(0, -1).replace(/"/g, '""')}"*` : `"${t.replace(/"/g, '""')}"`)).join(joiner);
  },
  jsonText: (column, key) => `json_extract(${column}, '$.${key}')`,
  insertionOrder: (alias) => (alias ? `${alias}.rowid` : 'rowid'),
  insertIgnore: (table, columns) =>
    `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
};

export class SqliteDriver implements StoreDriver {
  readonly dialect = sqliteDialect;

  private readonly db: DatabaseSync;

  /** The absolute path of the database file, for the refusal messages. */
  private readonly dbPath: string;

  /** PRAGMA busy_timeout of this connection, which switchFreshFileToWal also waits by. */
  readonly busyTimeoutMs: number;

  /** The path the journal-mode policy classifies: dbPath with its directory's symlinks resolved. */
  private readonly classifiedPath: string;

  constructor(path: string, options: SqliteDriverOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    // Checked before the file is opened: the value is written into a PRAGMA.
    if (typeof busyTimeoutMs !== 'number' || !Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error(`SqliteDriver: busyTimeoutMs must be a non-negative integer, got ${String(busyTimeoutMs)}`);
    }
    this.busyTimeoutMs = busyTimeoutMs;
    this.dbPath = resolvePath(path);
    this.db = new DatabaseSync(path);

    // fixer-mode F4 (Codex MEDIUM): classify the REAL path, not the lexical
    // one — a symlinked project dir (e.g. /home/x/proj -> /mnt/c/...) dodges
    // journalDemotionRequired's lexical /mnt/<drive>/ match on this.dbPath.
    // realpathSync resolves the CONTAINING DIRECTORY (the db file itself may
    // not exist yet on a fresh store, so resolving dirname alone survives
    // that case) and the file's basename is rejoined onto it. Any realpath
    // error (permission, exotic FS, race) falls back to the lexical dbPath —
    // that is this code's pre-existing behavior, not a new gap. The exported
    // journalDemotionRequired itself stays lexical-only and keeps its
    // existing unit pins; only the CALL SITES below are fed the resolved path.
    let classifiedPath = this.dbPath;
    try {
      classifiedPath = join(realpathSync(dirname(this.dbPath)), basename(this.dbPath));
    } catch {
      /* fall back to the lexical path */
    }
    this.classifiedPath = classifiedPath;

    // `busy_timeout` is connection-local and writes nothing to the db file, so
    // it is safe to set before SterlingStore's schema-version guard reads
    // user_version: it gives that read contention safety without weakening
    // the guard's "a too-new store is refused with NOTHING touched".
    this.db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
  }

  prepare(sql: string): StoreStatement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * A second close is a no-op, as on PgDriver: a refusal inside publishFresh
   * closes the connection itself, and SterlingStore then closes the driver
   * again before rethrowing, which must not replace the refusal with
   * 'database is not open'.
   */
  close(): void {
    if (!this.db.isOpen) return;
    this.db.close();
  }

  /** BEGIN IMMEDIATE: takes the write lock now, or throws once busy_timeout runs out. */
  begin(): void {
    this.db.exec('BEGIN IMMEDIATE');
  }

  commit(): void {
    this.db.exec('COMMIT');
  }

  rollback(): void {
    this.db.exec('ROLLBACK');
  }

  /** PRAGMA user_version — the application-owned integer, NEVER SQLite's own PRAGMA schema_version. */
  schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  setSchemaVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`SqliteDriver: schema version must be a non-negative integer, got ${String(version)}`);
    }
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  /** sqlite_master is empty only before the DDL has ever run on this file. A read, so a refusal after it has still written nothing. */
  hasSchema(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number }).n > 0;
  }

  prepareReadOnly(): void {
    // fixer-mode F2 (Codex HIGH): a legacy store reached over 9p must not
    // stay in WAL — the read-only open never reaches prepareWritable's
    // journal-mode PRAGMA, so without this check a pre-migration store
    // opened from WSL would keep an -shm-coordinated WAL handle open on
    // the exact 9p topology [store-journal-policy-delete-on-9p] exists to
    // remove. This is a REFUSAL, not a demotion: PRAGMA journal_mode=DELETE
    // WRITES to the file even when it "succeeds", and a legacy connection
    // is read-only by contract (SterlingStore's assertV2Surface/assertWritable
    // refuse every write), so it can never legitimately perform the demotion
    // itself — the remedy is migrating the store, never "close other
    // connections and retry" (there is no live holder here for that
    // remedy to help with). Already-DELETE (or any non-WAL) legacy stores
    // are untouched, matching the sticky behavior in prepareWritable.
    if (!journalDemotionRequired(this.classifiedPath)) return;
    let legacyMode: string;
    try {
      legacyMode = this.journalMode();
    } catch (e) {
      // The mode probe itself failing must not leak the open handle — close,
      // then propagate the driver error unchanged (this is a probe failure,
      // not a refused demotion).
      this.db.close();
      throw e;
    }
    if (legacyMode === 'wal') {
      this.db.close();
      throw new JournalDemotionRefusedError(this.dbPath, legacyMode, {
        message:
          `journal_mode=DELETE demotion refused for '${this.dbPath}' (legacy schema store, ` +
          `PRAGMA journal_mode='${legacyMode}') — this store is reached over a 9p mount where WAL is ` +
          `unsupported (decision store-journal-policy-delete-on-9p), but it predates the supported schema ` +
          `version and opens READ-ONLY; demotion WRITES to the file, so a legacy open can never perform it. ` +
          `Migrate the store first (\`node "<Sterling root>/bin/migrate-stores.mjs"\`) or open it from a non-9p context — ` +
          `closing other connections will not help here.`,
      });
    }
  }

  prepareWritable(isFresh: boolean): void {
    this.prepareConnection(isFresh);
    this.createSchema();
  }

  /**
   * StoreDriver.publishFresh (board 404228d7). prepareWritable() commits the DDL
   * statement by statement and SterlingStore stamps user_version in a later
   * transaction, so a concurrent opener that had read user_version 0 could see
   * the tables without the stamp and open the store as a legacy, read-only one.
   * Here an empty file gets its schema and its stamp in one BEGIN IMMEDIATE
   * transaction, with user_version re-read under that lock, so the tables and
   * the stamp become visible together.
   *
   * The classification read comes first and takes no write lock (decision
   * store-constructor-stops-write-locking-to-read-user-version-closing-a-concurrency-reachable-fail-open):
   * user_version and sqlite_master are read in one deferred read transaction,
   * so they come from one snapshot. A store with a schema and a version below
   * `supported` in that snapshot is an older store, returned untouched; a
   * newer version is returned untouched too, for SterlingStore to refuse. A
   * store another opener has already published at `supported` gets only this
   * connection's settings, as an already-current store does. Only a file
   * without a schema reaches the write lock.
   */
  publishFresh(supported: number): number {
    if (!Number.isInteger(supported) || supported < 1) {
      throw new Error(`SqliteDriver: the supported schema version must be a positive integer, got ${String(supported)}`);
    }
    this.db.exec('BEGIN');
    let version: number;
    let schemaExists: boolean;
    try {
      version = this.schemaVersion();
      schemaExists = this.hasSchema();
    } finally {
      this.db.exec('COMMIT');
    }
    if (version > supported || (version < supported && schemaExists)) return version;
    if (version === supported && schemaExists) {
      // Published since SterlingStore's version read: nothing is owed, so no
      // write lock (decision 81bdfc53), only the connection-local settings.
      this.prepareConnection(false);
      return version;
    }

    // PRAGMA journal_mode and foreign_keys have no effect inside a transaction,
    // so the connection settings come before BEGIN IMMEDIATE.
    this.prepareConnection(!schemaExists);
    this.begin();
    try {
      version = this.schemaVersion();
      // Another opener built and stamped the store since the read above:
      // classify on this locked read. An older version here with a schema
      // means the store was built by a driver without publishFresh.
      if (version > supported || (version < supported && this.hasSchema())) {
        this.rollback();
        return version;
      }
      this.createSchema();
      if (version < supported) this.setSchemaVersion(supported);
      this.commit();
    } catch (e) {
      if (this.db.isTransaction) this.rollback();
      throw e;
    }
    return supported;
  }

  /** The journal-mode policy and foreign_keys: connection settings that must run outside a transaction. */
  private prepareConnection(isFresh: boolean): void {
    // Journal-mode policy [store-journal-policy-delete-on-9p]: over 9p, demote
    // to DELETE and REFUSE the open when the demotion does not land; elsewhere
    // assert WAL — except on an existing store already demoted to DELETE,
    // which stays demoted (sticky; see journalDemotionRequired's doc block).
    if (journalDemotionRequired(this.classifiedPath)) {
      let returnedMode: string;
      try {
        returnedMode = (
          this.db.prepare('PRAGMA journal_mode=DELETE').get() as { journal_mode: string }
        ).journal_mode;
      } catch (e) {
        // fixer-mode F1 (joint finding): a PRAGMA that THROWS (SQLITE_BUSY
        // under a live holder) used to close and rethrow the raw driver
        // error, so callers got a generic SQLite error instead of the typed
        // refusal every other demotion-failure path promises. Wrap it the
        // same way the returned-mode arm below does, carrying the original
        // error as `cause` so nothing about the underlying failure is lost.
        this.db.close();
        const detail = e instanceof Error ? e.message : String(e);
        throw new JournalDemotionRefusedError(this.dbPath, detail, {
          cause: e,
          message:
            `journal_mode=DELETE demotion refused for '${this.dbPath}' (PRAGMA threw: ${detail}) — ` +
            `this store is reached over a 9p mount where WAL is unsupported (decision ` +
            `store-journal-policy-delete-on-9p); close every other connection (MCP server, TUI, hooks) and retry.`,
        });
      }
      if (returnedMode !== 'delete') {
        this.db.close();
        throw new JournalDemotionRefusedError(this.dbPath, returnedMode);
      }
    } else {
      const currentMode = this.journalMode();
      if (currentMode !== 'delete') {
        this.db.exec('PRAGMA journal_mode=WAL');
      } else if (isFresh) {
        // fixer-mode F3 (Codex HIGH): `isFresh` was captured from the
        // pre-DDL hasSchema() probe, before any of this open's own
        // work ran. A concurrent opener of the SAME file can initialize
        // (and even 9p-demote) the store in the gap between that probe and
        // this decision, leaving `isFresh` stale — execing WAL here on the
        // stale flag would flip a store the other opener just observed and
        // left in `delete` back to WAL. Re-probe AT DECISION TIME instead of
        // trusting the flag: only treat the store as still-fresh if
        // sqlite_master is STILL empty right now. This closes the
        // cross-context fresh-open race described above; it does NOT close
        // the (much smaller) window still remaining between THIS COUNT(*)
        // read and the WAL exec immediately below — that residual race is
        // accepted, not closed. sqlite-open-race.test.ts opens one fresh
        // file from four processes at once and requires it to end in WAL; it
        // does not pin the flip-back this re-probe guards against.
        const stillFresh = !this.hasSchema();
        if (stillFresh) {
          this.switchFreshFileToWal();
        }
      }
    }
    this.db.exec('PRAGMA foreign_keys=ON');
  }

  /** The DDL and its additive migrations. Idempotent, so it also runs on every open of a current store. */
  private createSchema(): void {
    this.db.exec(DDL);
    // Additive migration (board 97d773ef): queue_drain_log gains record_id so a
    // remove on an already-drained id can answer "already removed <when>"
    // instead of a bare "no record". CREATE IF NOT EXISTS never alters an
    // existing table, so the column is added here; the duplicate-column throw
    // on an already-migrated store is the expected no-op path.
    try {
      this.db.exec('ALTER TABLE queue_drain_log ADD COLUMN record_id TEXT');
    } catch {
      /* column already exists */
    }
    // Additive, no user_version bump (decision
    // postgres-operation-id-minted-by-caller-refused-on-repeat-no-schema-bump,
    // point 3): records gains a nullable operation_id with a unique index, so a
    // repeated create or enqueue can be found and refused. NULLs never collide.
    try {
      this.db.exec('ALTER TABLE records ADD COLUMN operation_id TEXT');
    } catch {
      /* column already exists */
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_records_operation_id ON records(operation_id)');
  }

  /**
   * PRAGMA journal_mode=WAL on a fresh file, which several openers may try at
   * once (board 404228d7). Measured: the switch fails at once with 'database is
   * locked', without the busy handler, while another connection holds the
   * write lock, and two openers switching together can both fail that way.
   * So this waits as busy_timeout would: after a failed switch it reads the
   * file's mode (hasSchema() takes the read lock that makes this connection
   * pick it up), stops when another opener's switch has landed, and stops too
   * when another opener has built the store in DELETE: that is a 9p opener's
   * demotion, which is sticky [store-journal-policy-delete-on-9p] and must not
   * be flipped back. It tries again only while the file is still without a
   * schema, until busy_timeout has run out, then throws the last error.
   */
  private switchFreshFileToWal(): void {
    const deadline = Date.now() + this.busyTimeoutMs;
    for (;;) {
      try {
        this.db.exec('PRAGMA journal_mode=WAL');
        return;
      } catch (e) {
        if (!(e instanceof Error) || !/database is locked/.test(e.message)) throw e;
        const built = this.hasSchema();
        if (this.journalMode() === 'wal' || built) return;
        if (Date.now() >= deadline) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }

  journalMode(): string {
    return (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  }

  /** VACUUM INTO: a consistent copy taken without stopping other connections. */
  snapshot(targetPath: string): void {
    this.db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }
}
