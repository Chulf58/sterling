// The driver seam under SterlingStore (decision
// postgres-store-design-sync-driver-seam-schema-per-store-advisory-locks,
// design point 1). SterlingStore talks to a StoreDriver and never to a database
// library; sqlite-driver.ts is the one implementation. Every method is
// synchronous, so the store's callers stay synchronous whatever the backend.
//
// What the seam does NOT cover: the statement text itself. SterlingStore still
// writes its SQL with `?` placeholders and SQLite-flavoured DML; only the
// constructs listed in StoreDialect are routed through the driver. A second
// driver has to accept the remaining SQL as written or translate it in
// prepare().

/** A value bound to a statement placeholder. */
export type SqlParam = null | number | bigint | string | NodeJS.ArrayBufferView;

export interface StoreRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/** A prepared statement: the three calls SterlingStore makes on one. */
export interface StoreStatement {
  /** The first row, or undefined when there is none. */
  get(...params: SqlParam[]): Record<string, unknown> | undefined;
  all(...params: SqlParam[]): Record<string, unknown>[];
  run(...params: SqlParam[]): StoreRunResult;
}

/**
 * The backend-specific SQL in SterlingStore's shared statements. Each member
 * covers the sites named beside it and nothing else.
 */
export interface StoreDialect {
  /** Joins the search index to `records r`. Sites: query(), countAboveScore(). */
  readonly searchJoin: string;
  /**
   * How many placeholders searchJoin has. Each binds searchQuery()'s value and
   * comes before the statement's filter parameters, so a backend whose score
   * needs the query (Postgres: per-query IDF) can read it there. 0 on SQLite.
   */
  readonly searchJoinBinds: number;
  /** WHERE predicate with ONE placeholder, bound to searchQuery()'s value. Sites: query(), countAboveScore(). */
  readonly searchMatch: string;
  /** Relevance expression where HIGHER is more relevant; min_score is a floor on it. Site: countAboveScore(). */
  readonly searchScore: string;
  /** ORDER BY term that puts the most relevant row first. Site: query(). */
  readonly searchOrder: string;
  /**
   * Names the scale searchScore is on, versioned: a min_score is only
   * meaningful against the scale it was chosen on, and scores are never
   * compared across scales. Site: SterlingStore.scoreScale().
   */
  readonly scoreScale: string;
  /** The value bound to searchMatch's placeholder; a trailing '*' on a term asks for a prefix match. Sites: query(), countAboveScore(). */
  searchQuery(terms: string[], matchAll: boolean | undefined): string;
  /** The text written to the search index for a record's search text. Sites: the records_fts insert and update. */
  searchText(text: string): string;
  /** A top-level key of a JSON text column, as text. Sites: articlesBySlug(), the live and retired slug lookups, the board `source` filter. */
  jsonText(column: string, key: string): string;
  /** ORDER BY term for insertion order; `alias` qualifies it when the statement names its table. Sites: the relation reads, the alias list, the retired-slug tiebreak, the supersedes-source read. */
  insertionOrder(alias?: string): string;
  /** An INSERT with one placeholder per column that does nothing on a uniqueness conflict. Site: the relation insert. */
  insertIgnore(table: string, columns: string[]): string;
}

/** One open connection to one store. */
export interface StoreDriver {
  readonly dialect: StoreDialect;

  // The statement API.
  prepare(sql: string): StoreStatement;
  exec(sql: string): void;
  close(): void;

  // The write transaction. SterlingStore's private tx() is the only caller and
  // owns nesting; begin() takes the store's write lock or throws.
  begin(): void;
  commit(): void;
  rollback(): void;

  // The read transaction (decision
  // postgres-operation-id-minted-by-caller-refused-on-repeat-no-schema-bump,
  // point 5): SterlingStore's private readTx() wraps a multi-statement read in
  // beginRead()/endRead() so it sees one snapshot. A driver whose reads are
  // already consistent enough, or that keeps today's autocommit reads (SQLite),
  // omits both. endRead() also ends a read whose statement failed.
  beginRead?(): void;
  endRead?(): void;
  /** readTx() prefers this to beginRead() when the driver has it: the same
   *  read transaction, except the driver may send its BEGIN together with the
   *  read's first statement (PgDriver; board f6c4bc5d). endRead() ends it. */
  beginReadDeferred?(): void;

  // Opening. SterlingStore's constructor drives these in a fixed order:
  // schemaVersion() (too new: close and refuse), hasSchema() (an older store
  // that has one opens read-only), prepareReadOnly() or prepareWritable(), then
  // a tx() that stamps setSchemaVersion() on a fresh store.
  /** The store's schema version; 0 when it was never stamped. */
  schemaVersion(): number;
  setSchemaVersion(version: number): void;
  /** False only for a store with no schema objects yet. */
  hasSchema(): boolean;
  /** Called for an existing store below the supported version. Writes nothing. A driver that cannot serve it read-only closes itself and throws. */
  prepareReadOnly(): void;
  /** Connection settings plus the schema, created when missing. `isFresh` is true when hasSchema() was false at open. A driver that refuses closes itself and throws. */
  prepareWritable(isFresh: boolean): void;
  /**
   * Optional, for a backend that several processes open at once (PgDriver and SqliteDriver).
   * When schemaVersion() read below `supported`, SterlingStore calls this in
   * place of hasSchema(), prepareReadOnly()/prepareWritable() and the stamp. In
   * ONE transaction under the write lock it re-reads the version; when that is
   * below `supported` and the store has no schema objects yet, it creates them
   * and stamps `supported`. Returns the version the store holds when that
   * transaction ends. A concurrent opener therefore never sees a store with
   * its schema but without its stamp, and never classifies a store another
   * opener just published as an older one.
   */
  publishFresh?(supported: number): number;

  /** The backend's journaling mode, as SterlingStore.journalMode() reports it. */
  journalMode(): string;
  /** Write a consistent copy of the store to `targetPath`, which does not exist yet. */
  snapshot(targetPath: string): void;
}
