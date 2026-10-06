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
// Locking (decision postgres-operation-id-minted-by-caller-refused-on-repeat-no-schema-bump,
// points 4 to 7): begin() takes the global migration lock SHARED, then the
// store lock, under SET LOCAL lock_timeout and statement_timeout; beginRead()
// opens REPEATABLE READ READ ONLY. Migrations (ensurePgLayout, createPgStore)
// take the global lock EXCLUSIVELY. Lock order is fixed: global, then store.
// 55P03 and 57014 are thrown as PgLockTimeoutError and PgStatementTimeoutError
// and never retried. One bridge (connection) holds one transaction at a time.
//
// Search (decision postgres-search-ranking-per-query-idf-no-stats-triggers):
// records_fts holds the folded text (search-fold.ts) plus a stored
// to_tsvector('simple', text) under a GIN index and a stored token count dl.
// Ranking is one statement per query; see pgDialectFor().
//
// NUL policy. Record bodies are JSON.stringify output, which writes U+0000 as
// the six characters \u0000, so they are stored losslessly in TEXT. The text
// written to records_fts is derived: the fold makes U+0000 a word separator,
// and a records_fts write has any U+0000 left removed. Any other string
// parameter holding U+0000 is refused before it is sent (Postgres TEXT cannot
// hold it). Measured on Served 2026-10-06: Postgres 18 fails the extraction of
// ANY key from a json value that holds \u0000 anywhere (22P05), so one such
// record would fail every jsonText() scan that reads it. Ruled 2026-10-06
// (slice 3B): jsonText removes the real \u0000 escapes before parsing and
// keeps an escaped backslash followed by u0000 intact, so an extracted value
// loses only its NUL characters. A 22P05 or 22021 that still occurs is
// rethrown as PgNulCharacterError.

import type { SqlParam, StoreDialect, StoreDriver, StoreRunResult, StoreStatement } from './driver.js';
import { PgQueryError, type PgBridge, type PgQueryResult } from './pg-bridge.js';
import { foldSearchText } from './search-fold.js';
export { PgTransactionOpenError } from './pg-bridge.js';

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

/** lock_timeout ran out (SQLSTATE 55P03). Never retried: the caller decides. */
export class PgLockTimeoutError extends Error {
  readonly code = '55P03';
  constructor(detail: string) {
    super(`Postgres lock timeout (55P03): ${detail}. Another writer or a migration holds the lock; nothing was written and the write is not retried.`);
    this.name = 'PgLockTimeoutError';
  }
}

/** statement_timeout ran out (SQLSTATE 57014). Never retried. */
export class PgStatementTimeoutError extends Error {
  readonly code = '57014';
  constructor(detail: string) {
    super(`Postgres statement timeout (57014): ${detail}. The transaction was rolled back and is not retried.`);
    this.name = 'PgStatementTimeoutError';
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

/** Default SET LOCAL lock_timeout for a write transaction or a migration. */
export const DEFAULT_PG_LOCK_TIMEOUT_MS = 3000;
/** Default SET LOCAL statement_timeout. Both must stay below the bridge's wait, so the named server error arrives first. */
export const DEFAULT_PG_STATEMENT_TIMEOUT_MS = 5000;

// Advisory-lock keys, two int4 halves: a namespace and a 32-bit FNV-1a hash of
// the schema name. The global lock is keyed by the META schema, so separate
// test layouts never block each other. A hash collision only serializes more.
// Exported for store-move.ts, whose move transaction takes the same locks.
export const LOCK_NS_GLOBAL = 0x53544d47; // 'STMG'
export const LOCK_NS_STORE = 0x53545354; // 'STST'

export function lockHash(name: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(name, 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function timeoutMs(name: string, value: number | undefined, fallback: number, bridge: PgBridge): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v <= 0) throw new Error(`Postgres ${name} must be a positive integer, got ${String(v)}`);
  if (v >= bridge.waitTimeoutMs) {
    throw new Error(`Postgres ${name} (${v} ms) must be below the bridge's wait (${bridge.waitTimeoutMs} ms), so the server's named timeout arrives before the bridge gives up`);
  }
  return v;
}

/** Rethrows a server error by name: 55P03, 57014, and the two NUL codes. */
function mapPgError(e: unknown, where: string): never {
  if (e instanceof PgQueryError) {
    if (e.code === '55P03') throw new PgLockTimeoutError(`${e.message} in ${where}`);
    if (e.code === '57014') throw new PgStatementTimeoutError(`${e.message} in ${where}`);
    if (e.code === '22P05' || e.code === '22021') throw new PgNulCharacterError(`${e.message} (SQLSTATE ${e.code}) in '${where}'`);
  }
  throw e;
}

/** Ends a transaction that failed: ROLLBACK unless the connection is gone, then releases the claim. The caller rethrows its own error. */
function abandon(bridge: PgBridge, owner: object): void {
  try {
    if (!bridge.closed) bridge.query('ROLLBACK');
  } finally {
    bridge.releaseTransaction(owner);
  }
}

/** Runs `fn` in a transaction that holds the global migration lock EXCLUSIVELY (design point 3; decision point 7). */
function inMigrationTransaction(bridge: PgBridge, metaSchema: string, lockTimeout: number | undefined, fn: () => void): void {
  assertSterlingSchemaName(metaSchema);
  const lock = timeoutMs('lockTimeoutMs', lockTimeout, DEFAULT_PG_LOCK_TIMEOUT_MS, bridge);
  const statement = timeoutMs('statementTimeoutMs', undefined, DEFAULT_PG_STATEMENT_TIMEOUT_MS, bridge);
  const owner = {};
  bridge.claimTransaction(owner, `a migration on '${metaSchema}'`);
  try {
    bridge.query(
      `BEGIN; SET LOCAL lock_timeout = ${lock}; SET LOCAL statement_timeout = ${statement}; SELECT pg_advisory_xact_lock(${LOCK_NS_GLOBAL}, ${lockHash(metaSchema)})`,
    );
    fn();
    bridge.query('COMMIT');
    bridge.releaseTransaction(owner);
  } catch (e) {
    abandon(bridge, owner);
    mapPgError(e, `a migration on '${metaSchema}'`);
  }
}

/** Creates the meta schema and its three tables when missing. Explicit: nothing calls it on open. */
export function ensurePgLayout(bridge: PgBridge, metaSchema: string = PG_META_SCHEMA, options: { lockTimeoutMs?: number } = {}): void {
  const m = ident(metaSchema);
  const now = new Date().toISOString();
  inMigrationTransaction(bridge, metaSchema, options.lockTimeoutMs, () => bridge.query(`
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
`));
}

export interface CreatePgStoreInput {
  kind: PgStoreKind;
  /** The registry name: the project's display name, the domain name, or a test label. */
  name: string;
  /** From pgProjectSchemaName / pgDomainSchemaName, or a sterling_test_ name. */
  schema: string;
  metaSchema?: string;
  /** lock_timeout for the exclusive global lock. Default 3000 ms. */
  lockTimeoutMs?: number;
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
  // Under the exclusive global lock, so two first creators cannot race on
  // CREATE SCHEMA: the second finds the first one's registry row.
  inMigrationTransaction(bridge, input.metaSchema ?? PG_META_SCHEMA, input.lockTimeoutMs, () => {
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
  });
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
  _seq BIGINT GENERATED ALWAYS AS IDENTITY,
  operation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_type_status ON ${s}.records (type, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_operation_id ON ${s}.records (operation_id);
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
-- text is the folded search text (pgDialect.searchText at every write site).
-- The default parser splits folded text on its spaces only: the fold leaves
-- letters, digits and private-use characters, and in a C-ctype database every
-- non-ASCII character is a letter to it. So tsv has one position per word and
-- dl, the word count, is the document length bm25 normalizes by.
CREATE TABLE IF NOT EXISTS ${s}.records_fts (
  record_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
  dl INTEGER GENERATED ALWAYS AS (CASE WHEN text = '' THEN 0 ELSE cardinality(string_to_array(text, ' ')) END) STORED
);
CREATE INDEX IF NOT EXISTS idx_records_fts_tsv ON ${s}.records_fts USING gin (tsv);
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

/**
 * The ranking candidates of decision
 * postgres-search-ranking-per-query-idf-no-stats-triggers, point 2. Each is a
 * score where HIGHER is more relevant, on its own versioned scale:
 *   bm25        FTS5's bm25 (k1 1.2, b 0.75, IDF clamped to 1e-6), with N,
 *               avgdl and each clause's document frequency read per query and
 *               tf counted from the candidate row's tsvector positions;
 *   idf_tsrank  sum over clauses of IDF(clause) x ts_rank(tsv, clause);
 *   tsrank_cd   plain ts_rank_cd over the whole query: the control, no IDF.
 */
export type PgRanking = 'bm25' | 'idf_tsrank' | 'tsrank_cd';
export const PG_RANKINGS: readonly PgRanking[] = ['bm25', 'idf_tsrank', 'tsrank_cd'];
/** The ranking a PgDriver uses when its opener names none: the one the findability replay chose. */
export const DEFAULT_PG_RANKING: PgRanking = 'bm25';
const PG_SCORE_SCALES: Record<PgRanking, string> = { bm25: 'pg_bm25_v1', idf_tsrank: 'pg_idf_tsrank_v1', tsrank_cd: 'pg_tsrank_cd_v1' };

/** One rank term after the fold: its words in order, and whether the last one is a prefix. */
interface PgSearchClause {
  /** The clause as tsquery text: quoted words joined with <->, :* on the last for a prefix. */
  q: string;
  w: string[];
  p: boolean;
}

/**
 * The value searchJoin and searchMatch bind: JSON with `match` (the whole
 * query as tsquery text, or null when it can match nothing), the clauses, and
 * the words and prefixes the tf count looks for. Each term is folded the way
 * record text is; a trailing star is read BEFORE the fold, which drops it.
 * A term that folds to nothing is a phrase with no words. As in FTS5, it
 * matches nothing: an OR leaves it out, an AND then matches nothing.
 */
export function pgSearchQuery(terms: string[], matchAll: boolean | undefined): string {
  const clauses: PgSearchClause[] = [];
  let empty = false;
  for (const term of terms) {
    const prefix = term.length > 1 && term.endsWith('*');
    const folded = foldSearchText(term);
    if (folded === '') {
      empty = true;
      continue;
    }
    // The fold leaves no quote, backslash or operator character, so a quoted word is a literal lexeme.
    const w = folded.split(' ');
    clauses.push({ q: w.map((x) => `'${x}'`).join(' <-> ') + (prefix ? ':*' : ''), w, p: prefix });
  }
  const none = clauses.length === 0 || (matchAll === true && empty);
  const prefixes = [...new Set(clauses.filter((c) => c.p).map((c) => c.w[c.w.length - 1]))];
  const out = JSON.stringify({
    match: none ? null : clauses.map((c) => `(${c.q})`).join(matchAll ? ' & ' : ' | '),
    clauses,
    words: [...new Set(clauses.flatMap((c) => c.w))],
    prefixes,
    // The documents any prefix matches, so the statement can list the lexemes each prefix stands for once per query.
    prefixq: prefixes.length ? prefixes.map((x) => `'${x}':*`).join(' | ') : null,
  });
  return out;
}

// The per-query statistics, computed once per statement from the bound JSON:
// N and avgdl over the store's whole records_fts (as FTS5 takes them), and for
// each clause df = the number of documents matching the WHOLE clause, so a
// prefix counts documents, never a sum of lexeme dfs.
const PG_SEARCH_STATS = `CROSS JOIN (SELECT q.j->>'match' AS m,
    (SELECT count(*) FROM records_fts)::float8 AS n,
    (SELECT coalesce(avg(dl), 0) FROM records_fts)::float8 AS avgdl,
    ARRAY(SELECT json_array_elements_text(q.j->'words'))
      || ARRAY(SELECT DISTINCT u.lexeme FROM records_fts x, unnest(x.tsv) u
        WHERE x.tsv @@ (q.j->>'prefixq')::tsquery AND EXISTS (SELECT 1 FROM json_array_elements_text(q.j->'prefixes') pf WHERE starts_with(u.lexeme, pf))) AS lexemes,
    (SELECT coalesce(json_agg(json_build_object('q', c.value->>'q', 'w', c.value->'w', 'p', c.value->'p',
        'df', (SELECT count(*) FROM records_fts x WHERE x.tsv @@ (c.value->>'q')::tsquery)) ORDER BY c.ordinality), '[]'::json)
      FROM json_array_elements(q.j->'clauses') WITH ORDINALITY c) AS cl
  FROM (SELECT ?::json AS j) q) st`;

// FTS5's IDF: ln((N - df + 0.5) / (df + 0.5)), and 1e-6 where that is not positive.
const PG_IDF = 'greatest(ln((st.n - c.df + 0.5) / (c.df + 0.5)), 1e-6)';

// bm25's tf for one clause in one row: how many start positions carry the
// clause's words at consecutive positions (the last word may be a prefix). It
// reads only the row's positions of the query's own words. Limits, from the
// tsvector type: to_tsvector keeps at most 255 positions of a word (measured
// on PostgreSQL 18; the documented cap is 256), so tf counts at most 255;
// every position past 16,383 is stored as 16,383, so a phrase whose words all
// sit past it is not found there, while a single word still is. The row's
// tsvector is cut to the query's lexemes (its words, and every lexeme a prefix
// stands for) in C, by setweight and ts_filter, before any position is unnested.
const PG_BM25_SCORE = `CROSS JOIN LATERAL (SELECT array_agg(u.lexeme) AS lx, array_agg(p) AS ps
    FROM unnest(ts_filter(setweight(f.tsv, 'A', st.lexemes), '{a}')) u, unnest(u.positions) p) lp
  CROSS JOIN LATERAL (SELECT coalesce(sum(${PG_IDF} * (t.tf * 2.2) / (t.tf + 1.2 * (0.25 + 0.75 * f.dl / st.avgdl))), 0)::float8 AS score
    FROM json_to_recordset(st.cl) AS c(w text[], p boolean, df bigint)
    CROSS JOIN LATERAL (SELECT count(*)::float8 AS tf FROM unnest(lp.lx, lp.ps) AS a(lex, pos)
      WHERE (a.lex = c.w[1] OR (c.p AND cardinality(c.w) = 1 AND starts_with(a.lex, c.w[1])))
        AND NOT EXISTS (SELECT 1 FROM generate_series(2, cardinality(c.w)) AS i
          WHERE NOT EXISTS (SELECT 1 FROM unnest(lp.lx, lp.ps) AS b(lex, pos)
            WHERE b.pos = a.pos + i - 1 AND (b.lex = c.w[i] OR (c.p AND i = cardinality(c.w) AND starts_with(b.lex, c.w[i])))))) t) sc`;

const PG_IDF_TSRANK_SCORE = `CROSS JOIN LATERAL (SELECT coalesce(sum(${PG_IDF} * ts_rank(f.tsv, c.q::tsquery)), 0)::float8 AS score
    FROM json_to_recordset(st.cl) AS c(q text, df bigint) WHERE f.tsv @@ c.q::tsquery) sc`;

const PG_TSRANK_CD_SCORE = 'CROSS JOIN LATERAL (SELECT ts_rank_cd(f.tsv, st.m::tsquery)::float8 AS score) sc';

const PG_SCORES: Record<PgRanking, string> = { bm25: PG_BM25_SCORE, idf_tsrank: PG_IDF_TSRANK_SCORE, tsrank_cd: PG_TSRANK_CD_SCORE };

/** The Postgres dialect with one of the ranking candidates. */
export function pgDialectFor(ranking: PgRanking): StoreDialect {
  if (!PG_RANKINGS.includes(ranking)) throw new Error(`Postgres ranking must be one of ${PG_RANKINGS.join(', ')}, got ${String(ranking)}`);
  return {
    // One statement per query (a round trip costs about 25 ms): the join binds
    // the query once for the statistics, the match binds it again so the GIN
    // index sees a constant tsquery.
    searchJoin: `JOIN records_fts f ON f.record_id = r.id ${PG_SEARCH_STATS} ${PG_SCORES[ranking]}`,
    searchJoinBinds: 1,
    searchMatch: "f.tsv @@ (?::json->>'match')::tsquery",
    searchScore: 'sc.score',
    searchOrder: 'sc.score DESC',
    scoreScale: PG_SCORE_SCALES[ranking],
    searchQuery: pgSearchQuery,
    searchText: foldSearchText,
    // Postgres refuses \u0000 anywhere in a json value it parses (22P05), so the
    // real \u0000 escapes are removed first. The pattern consumes an escaped
    // backslash pair (\\) as a unit and puts it back, so \u0000 only matches
    // where its backslash starts an escape: the literal text \\u0000 survives.
    // strpos skips the regex for the bodies that hold no \u0000 at all.
    jsonText: (column, key) => {
      if (!/^[a-z_]+$/.test(key)) throw new Error(`pgDialect.jsonText: key '${key}' is not a plain identifier`);
      if (!/^[a-z_]+(\.[a-z_]+)?$/.test(column)) throw new Error(`pgDialect.jsonText: column '${column}' is not a plain column reference`);
      return String.raw`((CASE WHEN strpos(${column}, '\u0000') > 0 THEN regexp_replace(${column}, '(\\\\)|\\u0000', '\1', 'g') ELSE ${column} END)::json ->> '${key}')`;
    },
    insertionOrder: (alias) => (alias ? `${alias}._seq` : '_seq'),
    insertIgnore: (table, columns) => `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`,
  };
}

export const pgDialect: StoreDialect = pgDialectFor(DEFAULT_PG_RANKING);

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
    return this.driver.run(this.translated.text, values, this.sql);
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
  /** SET LOCAL lock_timeout in each write transaction. Default 3000 ms; must be below the bridge's wait. */
  lockTimeoutMs?: number;
  /** SET LOCAL statement_timeout in each transaction. Default 5000 ms; must be below the bridge's wait. */
  statementTimeoutMs?: number;
  /** The search ranking (pgDialectFor). Default DEFAULT_PG_RANKING; the others exist for the findability replay. */
  ranking?: PgRanking;
}

export class PgDriver implements StoreDriver {
  readonly dialect: StoreDialect;
  readonly schema: string;
  private readonly metaSchema: string;
  private readonly s: string;
  private readonly m: string;
  private readonly ownsBridge: boolean;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private closed = false;
  /**
   * The transaction this handle claimed. After beginReadDeferred() the BEGIN
   * waits in `pendingBegin` and goes out in the same round trip as the read's
   * first statement (run()), so the read costs one round trip less; a read
   * that runs no statement sends nothing.
   */
  private txState: 'none' | 'pending' | 'open' = 'none';
  private pendingBegin: { text: string; where: string } | undefined;

  constructor(
    readonly bridge: PgBridge,
    options: PgDriverOptions,
  ) {
    this.schema = options.schema;
    this.dialect = options.ranking === undefined ? pgDialect : pgDialectFor(options.ranking);
    this.metaSchema = options.metaSchema ?? PG_META_SCHEMA;
    this.s = ident(this.schema);
    this.m = ident(this.metaSchema);
    this.ownsBridge = options.ownsBridge ?? false;
    this.lockTimeoutMs = timeoutMs('lockTimeoutMs', options.lockTimeoutMs, DEFAULT_PG_LOCK_TIMEOUT_MS, bridge);
    this.statementTimeoutMs = timeoutMs('statementTimeoutMs', options.statementTimeoutMs, DEFAULT_PG_STATEMENT_TIMEOUT_MS, bridge);
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
    this.run(t.text, undefined, sql);
  }

  /**
   * @internal Every statement this handle runs. A pending BEGIN goes out ahead
   * of it in the same round trip when the statement is a SELECT. Anything else
   * waits for the BEGIN's own reply first: the bridge sends both before either
   * answers, so a statement after a BEGIN that failed outright would run
   * outside the transaction, and only a read may.
   */
  run(text: string, values: unknown[] | undefined, where: string): PgQueryResult {
    const pending = this.pendingBegin;
    if (pending !== undefined) {
      this.pendingBegin = undefined;
      this.txState = 'open';
      if (/^\s*SELECT\b/i.test(text)) {
        try {
          return this.bridge.query(text, values, pending.text);
        } catch (e) {
          if (e instanceof PgQueryError && e.inPrefix) this.failBegin(e, pending.where);
          return mapPgError(e, where);
        }
      }
      try {
        this.bridge.query(pending.text);
      } catch (e) {
        this.failBegin(e, pending.where);
      }
    }
    try {
      return this.bridge.query(text, values);
    } catch (e) {
      return mapPgError(e, where);
    }
  }

  /** Claims the connection and sends BEGIN now. */
  private beginNow(text: string, label: string, where: string): void {
    this.assertOpen();
    this.bridge.claimTransaction(this, label);
    this.txState = 'open';
    try {
      this.bridge.query(text);
    } catch (e) {
      this.failBegin(e, where);
    }
  }

  /** Claims the connection for a read whose BEGIN goes out with its first statement (beginReadDeferred). */
  private deferBegin(text: string, label: string, where: string): void {
    this.assertOpen();
    this.bridge.claimTransaction(this, label);
    this.txState = 'pending';
    this.pendingBegin = { text, where };
  }

  /** A BEGIN that failed: roll back, release the claim and throw by name, as an eager BEGIN would. */
  private failBegin(e: unknown, where: string): never {
    this.txState = 'none';
    abandon(this.bridge, this);
    return mapPgError(e, where);
  }

  /** Ends this handle's transaction with `statement` when its BEGIN was sent; a transaction that ran nothing (or was abandoned) sends nothing. */
  private endTx(statement: 'COMMIT' | 'ROLLBACK', where: string | undefined): void {
    const sent = this.txState === 'open';
    this.txState = 'none';
    this.pendingBegin = undefined;
    try {
      if (sent && !this.bridge.closed) this.bridge.query(statement);
    } catch (e) {
      if (where === undefined) throw e;
      mapPgError(e, where);
    } finally {
      this.bridge.releaseTransaction(this);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsBridge) this.bridge.close();
  }

  /**
   * The write transaction, in one round trip: BEGIN, the two timeouts, the
   * global migration lock SHARED, then this store's lock, which reproduces
   * SQLite's BEGIN IMMEDIATE. SterlingStore.tx() re-reads the schema version
   * after this returns, under the locks. A failure rolls back and throws by
   * name; it is never retried.
   */
  begin(): void {
    this.beginNow(
      `BEGIN; SET LOCAL lock_timeout = ${this.lockTimeoutMs}; SET LOCAL statement_timeout = ${this.statementTimeoutMs}; ` +
        `SELECT pg_advisory_xact_lock_shared(${LOCK_NS_GLOBAL}, ${lockHash(this.metaSchema)}); ` +
        `SELECT pg_advisory_xact_lock(${LOCK_NS_STORE}, ${lockHash(this.schema)})`,
      `store '${this.schema}'`,
      `begin on store '${this.schema}'`,
    );
  }

  commit(): void {
    this.endTx('COMMIT', `commit on store '${this.schema}'`);
  }

  rollback(): void {
    this.endTx('ROLLBACK', undefined);
  }

  /** A multi-statement read: one snapshot (REPEATABLE READ), read-only, under statement_timeout. Takes no lock. */
  beginRead(): void {
    this.beginNow(this.readBeginText(), `a read on store '${this.schema}'`, `a read on store '${this.schema}'`);
  }

  /**
   * beginRead(), except the BEGIN goes out in the same round trip as the
   * read's first statement, and a read that runs no statement sends nothing.
   * The snapshot is the same: REPEATABLE READ takes it at the first statement.
   */
  beginReadDeferred(): void {
    this.deferBegin(this.readBeginText(), `a read on store '${this.schema}'`, `a read on store '${this.schema}'`);
  }

  private readBeginText(): string {
    return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout = ${this.statementTimeoutMs}`;
  }

  /** Ends the read transaction. COMMIT also ends one a failed statement aborted. */
  endRead(): void {
    this.endTx('COMMIT', undefined);
  }

  /** The store's version lives in its registry row, the counterpart of SQLite's PRAGMA user_version. */
  schemaVersion(): number {
    this.assertOpen();
    const row = this.run(`SELECT schema_version FROM ${this.m}.stores WHERE schema_name = $1`, [this.schema], `the schema version of store '${this.schema}'`).rows[0];
    if (!row) throw new PgStoreMissingError(this.schema, `its registry row in '${this.metaSchema}.stores' is gone`);
    return Number(row.schema_version);
  }

  setSchemaVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) throw new Error(`PgDriver: schema version must be a non-negative integer, got ${String(version)}`);
    const { rowCount } = this.run(`UPDATE ${this.m}.stores SET schema_version = $1 WHERE schema_name = $2`, [version, this.schema], `stamping the schema version of store '${this.schema}'`);
    if (rowCount !== 1) throw new PgStoreMissingError(this.schema, `its registry row in '${this.metaSchema}.stores' is gone`);
  }

  /** False only before the store's tables were ever created. */
  hasSchema(): boolean {
    return Boolean(this.run('SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = $1) AS has', [this.schema], `the tables of store '${this.schema}'`).rows[0].has);
  }

  /** Nothing to prepare: SterlingStore refuses every write on an older store itself, and opening writes nothing here. */
  prepareReadOnly(): void {}

  /**
   * Creates the store's tables when missing. Postgres does not make concurrent
   * CREATE ... IF NOT EXISTS safe: two processes opening one fresh store at once
   * failed with 23505 on pg_type_typname_nsp_index (board e05f5127). So the DDL
   * runs in one transaction under the same locks a write takes (the global lock
   * shared, then this store's lock): concurrent opens take turns, and the later
   * ones find every object already there. A lock that cannot be had within
   * lock_timeout throws PgLockTimeoutError, as a write would.
   */
  prepareWritable(_isFresh: boolean): void {
    this.assertOpen();
    const where = `creating the tables of store '${this.schema}'`;
    this.bridge.claimTransaction(this, `table setup on store '${this.schema}'`);
    try {
      this.bridge.query(`${this.setupBeginText()}; ${storeDdl(this.s)};\nCOMMIT`);
    } catch (e) {
      abandon(this.bridge, this);
      mapPgError(e, where);
    }
    this.bridge.releaseTransaction(this);
  }

  /**
   * StoreDriver.publishFresh. prepareWritable() followed by the store's own
   * stamp transaction left a window between the two commits: a concurrent
   * opener that had read version 0 saw the tables and opened the store as a
   * legacy, read-only one (Codex review of be2b7f7a, board e05f5127). Here the
   * version and table probe, the DDL and the stamp are one transaction under
   * the write locks, so the tables and the stamp become visible together, and
   * an opener that read 0 before someone else published re-reads the stamped
   * version under the lock. An older store that already has its tables is
   * left untouched: nothing is written and its version is returned.
   */
  publishFresh(supported: number): number {
    this.assertOpen();
    if (!Number.isInteger(supported) || supported < 1) throw new Error(`PgDriver: the supported schema version must be a positive integer, got ${String(supported)}`);
    const where = `publishing store '${this.schema}'`;
    this.bridge.claimTransaction(this, `table setup on store '${this.schema}'`);
    let version: number;
    try {
      const row = this.bridge.query(
        `SELECT (SELECT schema_version FROM ${this.m}.stores WHERE schema_name = $1) AS version, ` +
          'EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = $1) AS has_tables',
        [this.schema],
        this.setupBeginText(),
      ).rows[0];
      if (row.version === null) throw new PgStoreMissingError(this.schema, `its registry row in '${this.metaSchema}.stores' is gone`);
      version = Number(row.version);
      if (version < supported && !row.has_tables) {
        this.bridge.query(storeDdl(this.s));
        this.bridge.query(`UPDATE ${this.m}.stores SET schema_version = $1 WHERE schema_name = $2`, [supported, this.schema]);
        version = supported;
      }
      this.bridge.query('COMMIT');
    } catch (e) {
      abandon(this.bridge, this);
      mapPgError(e, where);
    }
    this.bridge.releaseTransaction(this);
    return version;
  }

  /** BEGIN for table setup: lock_timeout, then the write locks in begin()'s order (the global lock shared, then this store's). */
  private setupBeginText(): string {
    return (
      `BEGIN; SET LOCAL lock_timeout = ${this.lockTimeoutMs}; ` +
      `SELECT pg_advisory_xact_lock_shared(${LOCK_NS_GLOBAL}, ${lockHash(this.metaSchema)}); ` +
      `SELECT pg_advisory_xact_lock(${LOCK_NS_STORE}, ${lockHash(this.schema)})`
    );
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
