// The Postgres driver: a StoreDriver over a PgBridge (decision
// postgres-store-backend-design-sync-bridge-schema-per-store, points 1, 2 and 6).
//
// Layout (point 2; names per decision
// postgres-schema-names-sterling-p-uuid-sterling-d-domain): one Postgres schema
// per store, plus a meta schema (sterling_meta in production) holding the
// stores registry, the layout version and the migration-lock row. A store
// exists only when both its schema and its registry row exist; opening a
// missing store throws PgStoreMissingError and creates nothing. createPgStore
// is the one way to make one. No function here accepts a schema name outside
// the sterling_ prefix.
//
// Statement text. SterlingStore writes SQLite-flavoured SQL; prepare()
// translates it rather than moving statements behind the dialect, because the
// differences are lexical and few: `?` becomes $n, each store table name is
// qualified with the store's schema (one connection serves several stores, so
// a session search_path would be shared state), and instr() becomes strpos().
// The two ON CONFLICT upserts are valid Postgres as written. The constructs
// that are not lexical already sit behind StoreDialect.
//
// Not here yet: locking, timeouts and REPEATABLE READ (slice 3B), tsvector
// search (item 4). records_fts is a plain two-column table until item 4
// replaces it; ranked search throws PgSearchNotImplementedError.
//
// NUL policy. Record bodies are JSON.stringify output, which writes U+0000 as
// the six characters \u0000, so they are stored losslessly in TEXT. The text
// written to records_fts is derived and has U+0000 removed. Any other string
// parameter holding U+0000 is refused before it is sent (Postgres TEXT cannot
// hold it), and a JSON extraction that meets \u0000 (SQLSTATE 22P05) is
// rethrown as PgNulCharacterError. Measured on Served 2026-10-06: Postgres 18
// fails the extraction of ANY key from a json value that holds \u0000
// anywhere, so one such record fails every jsonText() scan that reads it.

import type { SqlParam, StoreDialect, StoreDriver, StoreRunResult, StoreStatement } from './driver.js';
import { PgQueryError, type PgBridge } from './pg-bridge.js';

/** The meta schema production uses. Tests pass their own sterling_test_<random>_meta. */
export const PG_META_SCHEMA = 'sterling_meta';
/** The version of the meta schema's own layout, in its `layout` row. */
export const PG_LAYOUT_VERSION = 1;

const SCHEMA_NAME = /^sterling_[a-z0-9_]*[a-z0-9]$/;
const MAX_IDENTIFIER_BYTES = 63;

export class PgSchemaNameRefusedError extends Error {
  constructor(name: string, why: string) {
    super(`Postgres schema name '${name}' refused: ${why}. Sterling only touches schemas named sterling_<lowercase letters, digits, _>.`);
    this.name = 'PgSchemaNameRefusedError';
  }
}

export class PgStoreMissingError extends Error {
  constructor(
    readonly schema: string,
    missing: string,
  ) {
    super(`Postgres store '${schema}' does not exist: ${missing}. A store is created only by an explicit createPgStore call, never on open.`);
    this.name = 'PgStoreMissingError';
  }
}

export class PgStoreExistsError extends Error {
  constructor(
    readonly schema: string,
    detail: string,
  ) {
    super(`Postgres store '${schema}' cannot be created: ${detail}.`);
    this.name = 'PgStoreExistsError';
  }
}

export class PgNulCharacterError extends Error {
  constructor(detail: string) {
    super(`NUL character (U+0000) refused on Postgres: ${detail}. Postgres text cannot hold U+0000, and its JSON functions refuse the \\u0000 escape.`);
    this.name = 'PgNulCharacterError';
  }
}

export class PgSearchNotImplementedError extends Error {
  constructor() {
    super('Ranked search (rank_terms, min_score) is not built on Postgres yet; it arrives with tsvector search (issue 26 item 4).');
    this.name = 'PgSearchNotImplementedError';
  }
}

export class PgUnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} is not supported by the Postgres driver.`);
    this.name = 'PgUnsupportedError';
  }
}

// ---------------------------------------------------------------------------
// Schema names
// ---------------------------------------------------------------------------

/** Refuses any name outside the sterling_ prefix or over Postgres's 63-byte identifier limit. */
export function assertSterlingSchemaName(name: string): void {
  if (typeof name !== 'string' || !SCHEMA_NAME.test(name)) throw new PgSchemaNameRefusedError(String(name), 'not of the form sterling_<a-z0-9_>');
  if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) throw new PgSchemaNameRefusedError(name, `longer than ${MAX_IDENTIFIER_BYTES} bytes`);
}

/** sterling_p_<project UUID as 32 lowercase hex>. */
export function pgProjectSchemaName(projectUuid: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(projectUuid)) {
    throw new PgSchemaNameRefusedError(`sterling_p_${projectUuid}`, 'the project id is not a UUID');
  }
  const name = `sterling_p_${projectUuid.replace(/-/g, '').toLowerCase()}`;
  assertSterlingSchemaName(name);
  return name;
}

/** sterling_d_<domain name, lowercased, every character outside [a-z0-9] mapped to _>. */
export function pgDomainSchemaName(domain: string): string {
  if (typeof domain !== 'string' || domain.length === 0) throw new PgSchemaNameRefusedError('sterling_d_', 'the domain name is empty');
  const name = `sterling_d_${domain.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  assertSterlingSchemaName(name);
  return name;
}

function ident(schema: string): string {
  assertSterlingSchemaName(schema);
  return `"${schema}"`;
}

// ---------------------------------------------------------------------------
// The meta layout and explicit store creation
// ---------------------------------------------------------------------------

export type PgStoreKind = 'project' | 'domain' | 'test';

/** Creates the meta schema and its three tables when missing. Explicit: nothing calls it on open. */
export function ensurePgLayout(bridge: PgBridge, metaSchema: string = PG_META_SCHEMA): void {
  const m = ident(metaSchema);
  const now = new Date().toISOString();
  bridge.query(`
CREATE SCHEMA IF NOT EXISTS ${m};
CREATE TABLE IF NOT EXISTS ${m}.layout (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  layout_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${m}.stores (
  schema_name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'domain', 'test')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS stores_kind_name ON ${m}.stores (kind, name);
CREATE TABLE IF NOT EXISTS ${m}.migration_lock (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  held_by TEXT,
  acquired_at TEXT
);
INSERT INTO ${m}.layout (singleton, layout_version, updated_at) VALUES (1, ${PG_LAYOUT_VERSION}, '${now}') ON CONFLICT (singleton) DO NOTHING;
INSERT INTO ${m}.migration_lock (singleton) VALUES (1) ON CONFLICT (singleton) DO NOTHING;
`);
}

export interface CreatePgStoreInput {
  kind: PgStoreKind;
  /** The registry name: the project's display name, the domain name, or a test label. */
  name: string;
  /** From pgProjectSchemaName / pgDomainSchemaName, or a sterling_test_ name. */
  schema: string;
  metaSchema?: string;
}

/**
 * Creates an empty store: its schema and its registry row, in one transaction.
 * SterlingStore builds the tables on its first open, as it does for a new
 * SQLite file. Refuses when either part already exists, including a second
 * name that maps to an existing schema (genesys-cloud vs genesys_cloud).
 */
export function createPgStore(bridge: PgBridge, input: CreatePgStoreInput): void {
  const s = ident(input.schema);
  const m = ident(input.metaSchema ?? PG_META_SCHEMA);
  if (input.kind === 'test' && !input.schema.startsWith('sterling_test_')) throw new PgSchemaNameRefusedError(input.schema, "a 'test' store must be named sterling_test_*");
  if (input.kind !== 'test' && input.schema.startsWith('sterling_test_')) throw new PgSchemaNameRefusedError(input.schema, `a '${input.kind}' store cannot use the sterling_test_ prefix`);
  bridge.query('BEGIN');
  try {
    const row = bridge.query(`SELECT kind, name FROM ${m}.stores WHERE schema_name = $1`, [input.schema]).rows[0];
    if (row) {
      throw new PgStoreExistsError(
        input.schema,
        row.name === input.name && row.kind === input.kind
          ? 'it is already registered'
          : `the schema is already registered to ${String(row.kind)} '${String(row.name)}', so '${input.name}' maps to a schema another store owns`,
      );
    }
    if (bridge.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [input.schema]).rows.length) {
      throw new PgStoreExistsError(input.schema, 'the schema exists without a registry row');
    }
    bridge.query(`CREATE SCHEMA ${s}`);
    bridge.query(`INSERT INTO ${m}.stores (schema_name, kind, name, created_at) VALUES ($1, $2, $3, $4)`, [input.schema, input.kind, input.name, new Date().toISOString()]);
    bridge.query('COMMIT');
  } catch (e) {
    // A dead bridge has no transaction left to roll back; the original error is the one to report.
    if (!bridge.closed) bridge.query('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Statement translation
// ---------------------------------------------------------------------------

/** Every table SterlingStore names; each is qualified with the store's schema. */
const STORE_TABLES = new Set([
  'records',
  'record_versions',
  'record_aliases',
  'record_relations',
  'record_stack_tags',
  'record_file_keys',
  'records_fts',
  'runs',
  'handoffs',
  'check_skipped',
  'selection',
  'queue_drain_log',
  'activity_log',
  'store_meta',
]);

export interface TranslatedStatement {
  text: string;
  /** How many placeholders the statement has. */
  params: number;
  /** True for a write to records_fts, whose text parameter is derived and has U+0000 removed. */
  derivedText: boolean;
}

/**
 * SQLite-flavoured statement text to Postgres: `?` to $n, store tables
 * qualified with `schema`, instr( to strpos(. Quoted strings and quoted
 * identifiers pass through untouched.
 */
export function translateStatement(sql: string, schema: string): TranslatedStatement {
  let out = '';
  let n = 0;
  let i = 0;
  let prevSignificant = '';
  let firstWords: string[] = [];
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      prevSignificant = c;
      i = j + 1;
      continue;
    }
    if (c === '?') {
      out += `$${++n}`;
      prevSignificant = '?';
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const lower = word.toLowerCase();
      if (firstWords.length < 3) firstWords.push(lower);
      let k = j;
      while (k < sql.length && /\s/.test(sql[k])) k++;
      if (STORE_TABLES.has(lower) && prevSignificant !== '.' && sql[j] !== '.') {
        out += `"${schema}".${word}`;
      } else if (lower === 'instr' && sql[k] === '(') {
        out += 'strpos';
      } else {
        out += word;
      }
      prevSignificant = word;
      i = j;
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    out += c;
    i++;
  }
  const derivedText =
    (firstWords[0] === 'insert' && firstWords[1] === 'into' && firstWords[2] === 'records_fts') ||
    (firstWords[0] === 'update' && firstWords[1] === 'records_fts');
  return { text: out, params: n, derivedText };
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

// The SQLite DDL (sqlite-driver.ts) in Postgres types. _seq stands in for
// SQLite's rowid where SterlingStore orders by insertion (dialect.insertionOrder).
// The Served database's collation is C, so text sorts bytewise as SQLite's
// BINARY does (measured 2026-10-06: datcollate = C).
function storeDdl(s: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${s}.records (
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
  body TEXT NOT NULL,
  _seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS idx_records_type_status ON ${s}.records (type, status);
CREATE TABLE IF NOT EXISTS ${s}.record_versions (
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (record_id, version)
);
CREATE TABLE IF NOT EXISTS ${s}.record_aliases (
  historical_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  archived_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  _seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON ${s}.record_aliases (canonical_id);
CREATE TABLE IF NOT EXISTS ${s}.record_relations (
  source_id TEXT NOT NULL,
  rel TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  _seq BIGINT GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (source_id, rel, target_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_target ON ${s}.record_relations (target_id);
CREATE INDEX IF NOT EXISTS idx_relations_rel_target ON ${s}.record_relations (rel, target_id);
CREATE TABLE IF NOT EXISTS ${s}.record_stack_tags (
  record_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (record_id, tag)
);
CREATE TABLE IF NOT EXISTS ${s}.record_file_keys (
  record_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (record_id, path)
);
CREATE INDEX IF NOT EXISTS idx_file_keys_path ON ${s}.record_file_keys (path);
-- Placeholder until item 4 replaces it with a tsvector column and a GIN index.
CREATE TABLE IF NOT EXISTS ${s}.records_fts (
  record_id TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_fts_record ON ${s}.records_fts (record_id);
CREATE TABLE IF NOT EXISTS ${s}.runs (
  id TEXT PRIMARY KEY,
  machine_state TEXT NOT NULL,
  pending_exit TEXT,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.handoffs (
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_run_phase ON ${s}.handoffs (run_id, phase_id);
CREATE TABLE IF NOT EXISTS ${s}.check_skipped (
  seq BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  run_id TEXT,
  check_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.selection (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.queue_drain_log (
  seq BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  drained_at TEXT NOT NULL,
  system_reason TEXT NOT NULL,
  text TEXT NOT NULL,
  file_keys TEXT NOT NULL,
  record_id TEXT
);
CREATE TABLE IF NOT EXISTS ${s}.activity_log (
  seq BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  at TEXT NOT NULL,
  verb TEXT NOT NULL,
  type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
}

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

export const pgDialect: StoreDialect = {
  // Search is item 4. searchQuery() runs before any search statement is built
  // (query(), countAboveScore()), so it is the one place that refuses; the
  // strings below are never sent.
  searchJoin: 'JOIN records_fts f ON f.record_id = r.id',
  searchMatch: 'FALSE AND ? IS NULL',
  searchScore: '0',
  searchOrder: 'r.id',
  searchQuery() {
    throw new PgSearchNotImplementedError();
  },
  // ->> on json (not jsonb) parses the stored text; a \u0000 anywhere in it
  // fails with 22P05, which PgStatement rethrows as PgNulCharacterError.
  jsonText: (column, key) => {
    if (!/^[a-z_]+$/.test(key)) throw new Error(`pgDialect.jsonText: key '${key}' is not a plain identifier`);
    return `((${column})::json ->> '${key}')`;
  },
  insertionOrder: (alias) => (alias ? `${alias}._seq` : '_seq'),
  insertIgnore: (table, columns) => `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`,
};

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

function toPgParam(v: SqlParam, i: number, sql: string, stripNul: boolean): unknown {
  if (v === undefined) throw new TypeError(`PgDriver: parameter ${i + 1} is undefined in: ${sql}`);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' && v.includes('\u0000')) {
    if (stripNul) return v.replace(/\u0000/g, '');
    throw new PgNulCharacterError(`parameter ${i + 1} of '${sql}'`);
  }
  return v;
}

function rethrow(e: unknown, sql: string): never {
  if (e instanceof PgQueryError && (e.code === '22P05' || e.code === '22021')) {
    throw new PgNulCharacterError(`${e.message} (SQLSTATE ${e.code}) in '${sql}'`);
  }
  throw e;
}

class PgStatement implements StoreStatement {
  private readonly translated: TranslatedStatement;

  constructor(
    private readonly driver: PgDriver,
    private readonly sql: string,
    schema: string,
  ) {
    this.translated = translateStatement(sql, schema);
  }

  private execute(params: SqlParam[]) {
    this.driver.assertOpen();
    if (params.length !== this.translated.params) {
      throw new RangeError(`PgDriver: statement takes ${this.translated.params} parameter(s), got ${params.length}: ${this.sql}`);
    }
    const values = params.map((p, i) => toPgParam(p, i, this.sql, this.translated.derivedText));
    try {
      return this.driver.bridge.query(this.translated.text, values);
    } catch (e) {
      return rethrow(e, this.sql);
    }
  }

  get(...params: SqlParam[]): Record<string, unknown> | undefined {
    return this.execute(params).rows[0];
  }

  all(...params: SqlParam[]): Record<string, unknown>[] {
    return this.execute(params).rows;
  }

  run(...params: SqlParam[]): StoreRunResult {
    const { rowCount } = this.execute(params);
    return {
      changes: rowCount,
      get lastInsertRowid(): number {
        throw new PgUnsupportedError('lastInsertRowid (Postgres has no rowid)');
      },
    };
  }
}

export interface PgDriverOptions {
  /** The store's schema; it must already exist with its registry row. */
  schema: string;
  /** Default sterling_meta. */
  metaSchema?: string;
  /** When true, close() also closes the bridge. Default false: one bridge serves every store in a process. */
  ownsBridge?: boolean;
}

export class PgDriver implements StoreDriver {
  readonly dialect = pgDialect;
  readonly schema: string;
  private readonly metaSchema: string;
  private readonly s: string;
  private readonly m: string;
  private readonly ownsBridge: boolean;
  private closed = false;

  constructor(
    readonly bridge: PgBridge,
    options: PgDriverOptions,
  ) {
    this.schema = options.schema;
    this.metaSchema = options.metaSchema ?? PG_META_SCHEMA;
    this.s = ident(this.schema);
    this.m = ident(this.metaSchema);
    this.ownsBridge = options.ownsBridge ?? false;
    const found = bridge.query(
      'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS has_schema, EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = $2 AND tablename = $3) AS has_registry',
      [this.schema, this.metaSchema, 'stores'],
    ).rows[0];
    if (!found.has_registry) throw new PgStoreMissingError(this.schema, `the meta schema '${this.metaSchema}' has no stores registry`);
    const registered = bridge.query(`SELECT 1 FROM ${this.m}.stores WHERE schema_name = $1`, [this.schema]).rows.length === 1;
    if (!registered && !found.has_schema) throw new PgStoreMissingError(this.schema, 'neither its schema nor its registry row exists');
    if (!registered) throw new PgStoreMissingError(this.schema, `its schema exists but '${this.metaSchema}.stores' has no registry row for it`);
    if (!found.has_schema) throw new PgStoreMissingError(this.schema, `it has a registry row in '${this.metaSchema}.stores' but no schema`);
  }

  /** @internal PgStatement's guard. */
  assertOpen(): void {
    if (this.closed) throw new Error(`PgDriver: store '${this.schema}' is closed`);
  }

  prepare(sql: string): StoreStatement {
    this.assertOpen();
    return new PgStatement(this, sql, this.schema);
  }

  exec(sql: string): void {
    this.assertOpen();
    const t = translateStatement(sql, this.schema);
    if (t.params) throw new RangeError(`PgDriver.exec takes no parameters: ${sql}`);
    try {
      this.bridge.query(t.text);
    } catch (e) {
      rethrow(e, sql);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsBridge) this.bridge.close();
  }

  // Plain BEGIN for now: the store advisory lock that reproduces BEGIN
  // IMMEDIATE, the timeouts and the version re-read are slice 3B.
  begin(): void {
    this.assertOpen();
    this.bridge.query('BEGIN');
  }

  commit(): void {
    this.bridge.query('COMMIT');
  }

  rollback(): void {
    this.bridge.query('ROLLBACK');
  }

  /** The store's version lives in its registry row, the counterpart of SQLite's PRAGMA user_version. */
  schemaVersion(): number {
    this.assertOpen();
    const row = this.bridge.query(`SELECT schema_version FROM ${this.m}.stores WHERE schema_name = $1`, [this.schema]).rows[0];
    if (!row) throw new PgStoreMissingError(this.schema, `its registry row in '${this.metaSchema}.stores' is gone`);
    return Number(row.schema_version);
  }

  setSchemaVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) throw new Error(`PgDriver: schema version must be a non-negative integer, got ${String(version)}`);
    const { rowCount } = this.bridge.query(`UPDATE ${this.m}.stores SET schema_version = $1 WHERE schema_name = $2`, [version, this.schema]);
    if (rowCount !== 1) throw new PgStoreMissingError(this.schema, `its registry row in '${this.metaSchema}.stores' is gone`);
  }

  /** False only before the store's tables were ever created. */
  hasSchema(): boolean {
    return Boolean(this.bridge.query('SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = $1) AS has', [this.schema]).rows[0].has);
  }

  /** Nothing to prepare: SterlingStore refuses every write on an older store itself, and opening writes nothing here. */
  prepareReadOnly(): void {}

  prepareWritable(_isFresh: boolean): void {
    this.assertOpen();
    this.bridge.query(storeDdl(this.s));
  }

  /**
   * 'postgres'. SQLite's answer names its rollback-journal mode, which the
   * 9p policy and the -wal/-shm handling branch on. Postgres has its own WAL
   * that no Sterling code manages, so 'wal' would send those branches down the
   * SQLite path. 'postgres' is no SQLite journal mode, so every such branch
   * falls through.
   */
  journalMode(): string {
    return 'postgres';
  }

  snapshot(_targetPath: string): void {
    throw new PgUnsupportedError('snapshot() (backup in work mode is issue 26 item 7: it refuses and points at the platform point-in-time restore)');
  }
}
