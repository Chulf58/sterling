// The store move (issue Chulf58/sterling#26, items 6 and 8): one project store
// or domain store moved SQLite -> Postgres (importStore) or Postgres -> SQLite
// (exportStore), one direction at a time. Decisions
// postgres-importer-write-fence-batched-copy-shared-domains-fork and
// store-move-skill-two-way-one-direction-at-a-time-no-live-sync.
//
// Sequence, both directions: preflight, fence the source (a durable store_meta
// row, written under the source's write lock), take a consistent snapshot, then
// in ONE target transaction: classify the target, copy in batches, rebuild the
// search text, verify the target against the source manifest, write the
// receipt, and clear any fence the target carried. The caller (move-store.mjs)
// switches config.storage only after that transaction commits. A crash anywhere
// leaves the source fenced, so the side being left never silently reopens for
// writes; a re-run with a matching receipt skips the copy.
//
// The fence is a row in the store's own store_meta table on BOTH backends
// (key 'move_fence'), so one check in SterlingStore.tx(), after begin(),
// enforces it everywhere (StoreMovedError).
//
// What this does NOT guarantee: a writer on an older release, one without the
// tx() check, can still write into a fenced store; writes
// that land after the snapshot are not copied. Only the store's own SQL
// writers see the fence; nothing stops a process from editing the file.
//
// Bulk path: bounded multi-row INSERTs through the caller's PgBridge, inside
// the one Postgres transaction that also holds the receipt. One connection,
// the driver's advisory locks, and named timeout errors, at about 24 ms per
// round trip: a 5,000-record store is a few dozen statements.

import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RECORD_TYPES, parseConfig, readProjectIdentity, readProjectMode, type ProjectMode } from '@sterling/schemas';
import { SterlingStore, SUPPORTED_SCHEMA_VERSION } from './index.js';
import { resolveDomainMounts } from './mounted.js';
import { SqliteDriver, sqliteDialect } from './sqlite-driver.js';
import { PgConfigError, PgQueryError, readPgCredentials, type PgBridge } from './pg-bridge.js';
import {
  LOCK_NS_GLOBAL,
  LOCK_NS_STORE,
  PG_META_SCHEMA,
  PgDriver,
  PgLockTimeoutError,
  PgStatementTimeoutError,
  assertSterlingSchemaName,
  createPgStore,
  lockHash,
  pgDialect,
} from './pg-driver.js';
import { PG_TEST_NAMESPACE_ENV, pgStoreNames } from './routing.js';

/** store_meta key holding the write fence on the side a move left. */
export const MOVE_FENCE_KEY = 'move_fence';
/** store_meta key holding the receipt on a SQLite target (Postgres targets use <meta>.move_receipts). */
export const MOVE_RECEIPT_KEY = 'move_receipt';
const MOVE_CONTROL_KEYS = [MOVE_FENCE_KEY, MOVE_RECEIPT_KEY];

/** Version of the manifest's canonical form. A change to it changes every digest. */
export const MOVE_MANIFEST_VERSION = 1;

/** Statement timeout inside a move's Postgres transactions. Must be below the bridge's wait. */
export const DEFAULT_MOVE_STATEMENT_TIMEOUT_MS = 60_000;
/** Lock timeout for the source fence and the target transaction. */
export const DEFAULT_MOVE_LOCK_TIMEOUT_MS = 10_000;
/** The bridge wait the CLI opens its connection with. */
export const MOVE_BRIDGE_WAIT_MS = 120_000;

// ---------------------------------------------------------------------------
// Named errors
// ---------------------------------------------------------------------------

export class MoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** The project has no .sterling/config.json. */
export class MoveConfigMissingError extends MoveError {}
/** The project's .sterling/config.json does not parse or fails the config schema. */
export class MoveConfigInvalidError extends MoveError {}
/** The project's mode does not allow this direction (a hobby project never moves to Postgres). */
export class MoveModeError extends MoveError {}
/** The project has no .sterling/project.json identity. */
export class MoveIdentityMissingError extends MoveError {}
/** The Postgres credentials file is missing or invalid. */
export class MoveCredentialsError extends MoveError {}
/** A registered project's mounts cannot be read, so whether it shares a domain is unknown. */
export class MoveRegistryProjectError extends MoveError {}
/** The source or target is not at the supported schema version, or lacks a column. */
export class MoveSchemaError extends MoveError {}
/** The source is fenced toward a different counterpart: it was already moved elsewhere. */
export class MoveSourceFencedError extends MoveError {}
/** The target holds data and no receipt or untouched fence makes it this move's own. */
export class MoveTargetNotEmptyError extends MoveError {}
/** An id would mean two things: in records and record_aliases, or in source and target. */
export class MoveIdCollisionError extends MoveError {}
/** A text value holds U+0000, which Postgres text cannot store. */
export class MoveNulCharacterError extends MoveError {}
/** The copied target does not match the source manifest. Nothing was committed. */
export class MoveVerificationError extends MoveError {}
/** config.storage holds a value other than 'sqlite' or 'postgres'. */
export class MoveStorageSettingError extends MoveError {}
/** A shared domain's SQLite copy was left live for hobby projects (the fork) and has diverged; a move back would have to merge. */
export class MoveForkDivergedError extends MoveError {}

/** The CLI flag that lets a move go ahead past an existing fork without the records only the SQLite copy holds. */
export const FORK_CONFIRM_FLAG = '--confirm-fork';

/** A record whose rows differ between the two copies of a forked domain. */
export interface ForkLossEntry {
  id: string;
  title: string;
  /**
   * only_in_source: the source copy holds the record and the target does not;
   * only_in_target: the reverse (removed or retired in the source, or added to the target);
   * differs: both hold it, and its row or any row tied to it (versions, aliases,
   * relations, tags, file keys, log or selection rows) differs.
   */
  kind: 'only_in_source' | 'only_in_target' | 'differs';
}

/** Row counts of one table that differ between the copies. */
export interface ForkLossTable {
  only_in_source: number;
  only_in_target: number;
  changed: number;
}

/**
 * Every difference between the two copies of a forked domain, over every
 * table a move copies (anti-pattern 44d4f74f: a check over records alone
 * misses versions and aliases): complete counts per record kind and per
 * table, and the first FORK_LOSS_LIST_CAP records.
 */
export interface ForkLoss {
  only_in_source: number;
  only_in_target: number;
  differs: number;
  /** Only the tables with a difference. */
  tables: Record<string, ForkLossTable>;
  /** Differing rows tied to no record (store_meta, runs, handoffs, check_skipped, or a log row with no record id). */
  unattributed_rows: number;
  listed: ForkLossEntry[];
}

export const FORK_LOSS_LIST_CAP = 20;

/**
 * A move met a shared domain that an earlier move already copied while its
 * source stayed writable (fork_already_copied), and was not confirmed
 * (decision shared-domains-stay-forked-and-loud-while-projects-move-one-at-a-time).
 */
export class MoveForkUnconfirmedError extends MoveError {
  readonly loss: ForkLoss;
  constructor(message: string, loss: ForkLoss) {
    super(message);
    this.loss = loss;
  }
}

// ---------------------------------------------------------------------------
// Tables and the canonical row form
// ---------------------------------------------------------------------------

interface Col {
  name: string;
  int: boolean;
}

interface TableSpec {
  name: string;
  cols: Col[];
  /** Key columns; null for a table with no key (handoffs), keyed by row hash and occurrence. */
  key: string[] | null;
  sqliteOrder: string;
  pgOrder: string;
}

function spec(name: string, cols: string, key: string[] | null, sqliteOrder?: string, pgOrder?: string): TableSpec {
  const parsed = cols.split(' ').map((c) => ({ name: c.replace(/:int$/, ''), int: c.endsWith(':int') }));
  const order = (key ?? parsed.map((c) => c.name)).join(', ');
  return { name, cols: parsed, key, sqliteOrder: sqliteOrder ?? order, pgOrder: pgOrder ?? order };
}

/**
 * Every table a move copies, in insert order. records_fts is not here: it is
 * derived and rebuilt from records. The first eight are the id-carrying tables
 * of the decision's manifest; the rest are copied and hashed the same way.
 * records, record_aliases and record_relations go in insertion order, so
 * SQLite's rowid and Postgres's _seq keep the order the store reads them in.
 */
export const MOVE_TABLES: readonly TableSpec[] = [
  spec('records', 'id type status superseded_by lifecycle freshness version:int scope created_at updated_at author derived_unconfirmed:int body operation_id', ['id'], 'rowid', '_seq'),
  spec('record_versions', 'record_id version:int archived_at body', ['record_id', 'version']),
  spec('record_aliases', 'historical_id canonical_id archived_version:int created_at', ['historical_id'], 'rowid', '_seq'),
  spec('record_relations', 'source_id rel target_id created_at', ['source_id', 'rel', 'target_id'], 'rowid', '_seq'),
  spec('record_stack_tags', 'record_id tag', ['record_id', 'tag']),
  spec('record_file_keys', 'record_id path', ['record_id', 'path']),
  spec('activity_log', 'seq:int at verb type record_id title', ['seq']),
  spec('queue_drain_log', 'seq:int drained_at system_reason text file_keys record_id', ['seq']),
  spec('store_meta', 'key value updated_at', ['key']),
  spec('runs', 'id machine_state pending_exit body updated_at', ['id']),
  spec('handoffs', 'run_id phase_id agent_role body created_at', null, 'rowid'),
  spec('check_skipped', 'seq:int run_id check_name reason at', ['seq']),
  spec('selection', 'slot:int type record_id at', ['slot']),
];

/** Postgres identity columns that a copy fills explicitly; their sequences are moved past the copied maximum. */
const PG_IDENTITY_SEQ_TABLES = ['activity_log', 'queue_drain_log', 'check_skipped'];

/** A value in canonical form: integers as bigint, text as string. */
type Val = string | bigint | null;
type Row = Val[];
/** All copied rows of one store, per table, in MOVE_TABLES column order. */
export type StoreSnapshot = Map<string, Row[]>;

function whereClause(t: TableSpec): string {
  return t.name === 'store_meta' ? ` WHERE key NOT IN (${MOVE_CONTROL_KEYS.map((k) => `'${k}'`).join(', ')})` : '';
}

function canonicalValue(t: TableSpec, c: Col, v: unknown, where: () => string): Val {
  if (v === null || v === undefined) return null;
  if (c.int) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
    throw new MoveSchemaError(`${t.name}.${c.name} holds a non-integer value (${typeof v}) at ${where()}`);
  }
  if (typeof v !== 'string') throw new MoveSchemaError(`${t.name}.${c.name} holds a ${typeof v} where text belongs, at ${where()}`);
  return v;
}

function canonicalRows(t: TableSpec, raw: Record<string, unknown>[]): Row[] {
  return raw.map((r, i) => t.cols.map((c) => canonicalValue(t, c, r[c.name], () => `row ${i + 1}`)));
}

function encodeRow(row: Row): string {
  return JSON.stringify(row.map((v) => (typeof v === 'bigint' ? `i:${v.toString()}` : v === null ? null : `s:${v}`)));
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

export interface TableManifest {
  rows: number;
  digest: string;
}

/** What a receipt records: per-table row counts and digests, and one digest over them. */
export interface StoreManifest {
  version: number;
  digest: string;
  tables: Record<string, TableManifest>;
}

/** A manifest plus every row's key and canonical hash, for diffs and id-set checks. */
export interface ManifestDetail {
  manifest: StoreManifest;
  /** table -> key -> row hash. */
  entries: Map<string, Map<string, string>>;
}

/** One table's rows by the manifest key (the full composite key, or row hash and occurrence for a keyless table), each with its row hash. */
function keyedRows(t: TableSpec, rows: Row[]): Map<string, { hash: string; row: Row }> {
  const map = new Map<string, { hash: string; row: Row }>();
  const seen = new Map<string, number>();
  for (const row of rows) {
    const h = sha256(encodeRow(row));
    let key: string;
    if (t.key === null) {
      const n = (seen.get(h) ?? 0) + 1;
      seen.set(h, n);
      key = `${h}#${n}`;
    } else {
      key = encodeRow(t.key.map((k) => row[t.cols.findIndex((c) => c.name === k)]));
    }
    if (map.has(key)) throw new MoveSchemaError(`${t.name} holds two rows with the key ${key}`);
    map.set(key, { hash: h, row });
  }
  return map;
}

/**
 * The manifest of a snapshot. Computed in JS from canonical rows, so SQLite
 * and Postgres reads of the same content give the same digests: integers as
 * decimal text, text as itself, NULL as null; keys are the full composite
 * primary key; a table digest is sha256 over its sorted "key<TAB>row hash"
 * lines.
 */
export function buildManifest(snapshot: StoreSnapshot): ManifestDetail {
  const tables: Record<string, TableManifest> = {};
  const entries = new Map<string, Map<string, string>>();
  const top: string[] = [];
  for (const t of MOVE_TABLES) {
    const map = new Map([...keyedRows(t, snapshot.get(t.name) ?? []).entries()].map(([k, v]) => [k, v.hash]));
    const lines = [...map.entries()].map(([k, h]) => `${k}\t${h}`).sort();
    const digest = sha256(lines.join('\n'));
    tables[t.name] = { rows: map.size, digest };
    entries.set(t.name, map);
    top.push(`${t.name}:${map.size}:${digest}`);
  }
  return { manifest: { version: MOVE_MANIFEST_VERSION, digest: sha256(`v${MOVE_MANIFEST_VERSION}\n${top.join('\n')}`), tables }, entries };
}

export interface TableDiff {
  table: string;
  /** Keys in `expected` and not in `actual`. */
  missing: string[];
  /** Keys in `actual` and not in `expected`. */
  extra: string[];
  /** Keys in both whose row content differs. */
  changed: string[];
}

/** Per-table differences between two manifests, empty when they match. */
export function diffManifests(expected: ManifestDetail, actual: ManifestDetail): TableDiff[] {
  const out: TableDiff[] = [];
  for (const t of MOVE_TABLES) {
    const a = expected.entries.get(t.name) ?? new Map<string, string>();
    const b = actual.entries.get(t.name) ?? new Map<string, string>();
    const missing = [...a.keys()].filter((k) => !b.has(k));
    const extra = [...b.keys()].filter((k) => !a.has(k));
    const changed = [...a.keys()].filter((k) => b.has(k) && b.get(k) !== a.get(k));
    if (missing.length || extra.length || changed.length) out.push({ table: t.name, missing, extra, changed });
  }
  return out;
}

function describeDiff(diffs: TableDiff[]): string {
  const sample = (xs: string[]) => xs.slice(0, 5).join(', ') + (xs.length > 5 ? `, and ${xs.length - 5} more` : '');
  return diffs
    .map((d) => `${d.table}: ${[d.missing.length ? `missing ${sample(d.missing)}` : '', d.extra.length ? `extra ${sample(d.extra)}` : '', d.changed.length ? `changed ${sample(d.changed)}` : ''].filter(Boolean).join('; ')}`)
    .join(' | ');
}

/** records.id plus record_aliases.historical_id: every id the store resolves. */
function resolvableIds(snapshot: StoreSnapshot): { records: Set<string>; aliases: Set<string> } {
  return {
    records: new Set((snapshot.get('records') ?? []).map((r) => r[0] as string)),
    aliases: new Set((snapshot.get('record_aliases') ?? []).map((r) => r[0] as string)),
  };
}

/** Refuses a snapshot in which one id is both a live record and a historical alias. */
export function assertNoInternalCollision(snapshot: StoreSnapshot, label: string): void {
  const { records, aliases } = resolvableIds(snapshot);
  const both = [...records].filter((id) => aliases.has(id));
  if (both.length) {
    throw new MoveIdCollisionError(`${label}: ${both.length} id(s) are both a record id and a record_aliases.historical_id (${both.slice(0, 5).join(', ')}); one id would mean two records. Nothing was moved.`);
  }
}

function crossCollisions(source: StoreSnapshot, target: StoreSnapshot): string[] {
  const s = resolvableIds(source);
  const t = resolvableIds(target);
  const sourceIds = new Set([...s.records, ...s.aliases]);
  return [...new Set([...t.records, ...t.aliases])].filter((id) => sourceIds.has(id)).sort();
}

function nonEmptyTables(snapshot: StoreSnapshot): string[] {
  return MOVE_TABLES.filter((t) => (snapshot.get(t.name)?.length ?? 0) > 0).map((t) => `${t.name} (${snapshot.get(t.name)!.length})`);
}

// ---------------------------------------------------------------------------
// Fence and receipt shapes
// ---------------------------------------------------------------------------

export interface MoveFence {
  move_id: string;
  /** The counterpart the store moved to: 'postgres:<schema>' or 'sqlite:<absolute path>'. */
  to: string;
  fenced_at: string;
  /** The manifest digest of the content at fencing; null until the snapshot is taken. */
  manifest_digest: string | null;
}

export type MoveDirection = 'to_postgres' | 'to_sqlite';

export interface StoreIdentity {
  kind: 'project' | 'domain';
  /** The project id for a project store, the domain name for a domain store. */
  name: string;
}

export interface MoveReceipt {
  move_id: string;
  direction: MoveDirection;
  source: string;
  source_kind: StoreIdentity['kind'];
  source_name: string;
  target: string;
  source_digest: string;
  tables: Record<string, TableManifest>;
  committed_at: string;
}

function parseFence(value: string | undefined, where: string): MoveFence | null {
  if (value === undefined) return null;
  try {
    const f = JSON.parse(value) as MoveFence;
    if (typeof f.move_id === 'string' && typeof f.to === 'string') return f;
  } catch {
    /* refused below */
  }
  throw new MoveSchemaError(`${where}: store_meta '${MOVE_FENCE_KEY}' is not a move fence (${value.slice(0, 80)}); refusing to guess`);
}

function parseReceipt(value: string, where: string): MoveReceipt {
  try {
    const r = JSON.parse(value) as MoveReceipt;
    if (typeof r.move_id === 'string' && typeof r.source_digest === 'string') return r;
  } catch {
    /* refused below */
  }
  throw new MoveSchemaError(`${where}: a move receipt is not readable (${value.slice(0, 80)}); refusing to guess`);
}

export const sqliteLabel = (path: string): string => `sqlite:${resolve(path).replace(/\\/g, '/')}`;
export const pgLabel = (schema: string): string => `postgres:${schema}`;

/** The search text the store writes for a records row: its type's fts builder over the stored body, through the dialect. */
function searchTextFor(type: string, body: string, fold: (s: string) => string, where: string): string {
  const entry = RECORD_TYPES[type];
  if (!entry) throw new MoveSchemaError(`${where}: record type '${type}' is not registered, so its search text cannot be built`);
  return fold(entry.fts(JSON.parse(body) as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Target classification (shared by both directions)
// ---------------------------------------------------------------------------

export type MoveOutcome = 'copied' | 'replaced' | 'replayed' | 'fork_already_copied' | 'dry_run';

type TargetPlan = { kind: 'empty' } | { kind: 'replace'; fence: MoveFence } | { kind: 'replay'; receipt: MoveReceipt } | { kind: 'fork_already_copied'; receipt: MoveReceipt };

/**
 * What the move may do with the target, decided under its lock:
 * - fenced, and unchanged since the fence (manifest digest equal): it is the
 *   copy a previous move left behind, and is replaced;
 * - its latest receipt is from this source, and source and target both still
 *   hold that receipt's manifest: a replay, no copy;
 * - its latest receipt is from this source and the source is a fork (left
 *   unfenced now, or not fenced by the move that wrote that receipt): the
 *   fork was already copied, the copies diverge, no copy; so is a target
 *   that changed since the receipt while the source did not;
 * - empty: copied;
 * - anything else is refused by name, colliding ids first.
 */
function classifyTarget(args: {
  label: string;
  target: StoreSnapshot;
  targetDigest: string;
  fence: MoveFence | null;
  receipt: MoveReceipt | null;
  identity: StoreIdentity;
  source: StoreSnapshot;
  sourceDigest: string;
  sourceForked: boolean;
  /**
   * The move id of the fence the source carried before this run, null for
   * none. A receipt written by another move than the one that fenced the
   * source means the source stayed writable after that copy: the last
   * project to leave a forked domain fences it, and still meets the fork.
   * Left undefined where this does not apply.
   */
  sourceFenceMoveId?: string | null;
}): TargetPlan {
  const { label, fence, receipt, identity } = args;
  if (fence) {
    if (fence.manifest_digest !== null && fence.manifest_digest === args.targetDigest) return { kind: 'replace', fence };
    throw new MoveTargetNotEmptyError(
      `${label} is fenced by move ${fence.move_id} (to ${fence.to}) but its content ${fence.manifest_digest === null ? 'was never recorded at fencing' : 'changed after the fence'}, ` +
        `so it cannot be proven to be an untouched abandoned copy. Nothing was moved.`,
    );
  }
  const sameSource = receipt !== null && receipt.source_kind === identity.kind && receipt.source_name === identity.name;
  // A replay needs both copies still as the receipt left them; a target that changed since is a fork, even when the source did not.
  const sourceAsCopied = sameSource && receipt.source_digest === args.sourceDigest;
  if (sourceAsCopied && args.targetDigest === receipt.source_digest) return { kind: 'replay', receipt };
  const copiedUnfenced = args.sourceFenceMoveId !== undefined && args.sourceFenceMoveId !== receipt?.move_id;
  if (sameSource && (args.sourceForked || copiedUnfenced || sourceAsCopied)) return { kind: 'fork_already_copied', receipt };
  const occupied = nonEmptyTables(args.target);
  if (occupied.length === 0) return { kind: 'empty' };
  const collisions = crossCollisions(args.source, args.target);
  if (collisions.length) {
    throw new MoveIdCollisionError(
      `${label} already holds ${collisions.length} id(s) the source also resolves, in records or record_aliases (${collisions.slice(0, 5).join(', ')}); ` +
        `copying would give one id two meanings. Nothing was moved.`,
    );
  }
  throw new MoveTargetNotEmptyError(
    `${label} is not empty (${occupied.join(', ')}) and holds no receipt for this source and no untouched move fence; ` +
      `a move only fills an empty target, replays its own receipt, or replaces the copy a previous move left. Nothing was moved.`,
  );
}

// ---------------------------------------------------------------------------
// SQLite side
// ---------------------------------------------------------------------------

/**
 * A read-only open that removes only the -wal/-shm sidecars the open itself
 * created (anti-pattern 8616e72d): a sidecar that existed before is left as found.
 */
function withReadOnlySqlite<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const hadWal = existsSync(`${path}-wal`);
  const hadShm = existsSync(`${path}-shm`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
    if (!hadWal) rmSync(`${path}-wal`, { force: true });
    if (!hadShm) rmSync(`${path}-shm`, { force: true });
  }
}

type SqliteReader = { prepare(sql: string): { all(...p: never[]): unknown[]; get(...p: never[]): unknown } };

function assertSqliteColumns(db: SqliteReader, label: string): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    throw new MoveSchemaError(`${label} is at schema version ${version}; a move needs version ${SUPPORTED_SCHEMA_VERSION}. Migrate it first (bin/migrate-stores.mjs). Nothing was moved.`);
  }
  for (const t of MOVE_TABLES) {
    const have = new Set((db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name));
    const missing = t.cols.filter((c) => !have.has(c.name)).map((c) => c.name);
    if (missing.length) {
      throw new MoveSchemaError(`${label}: table ${t.name} lacks ${missing.join(', ')}. Open the store once with this Sterling build so its additive migrations run. Nothing was moved.`);
    }
  }
}

/**
 * node:sqlite returns a TEXT value cut short at its first U+0000 (measured
 * 2026-10-06: 'bad\u0000value' reads back as 'bad'), so a read would lose the
 * rest silently and the manifest, built from the same read, could not see it.
 * SQL still sees the whole value, so any text column holding U+0000 is refused
 * by name before it is read. Bodies are JSON and hold the escape, never the
 * character, so they pass.
 */
function refuseSqliteNul(db: SqliteReader, label: string): void {
  for (const t of MOVE_TABLES) {
    for (const c of t.cols.filter((x) => !x.int)) {
      const hit = db.prepare(`SELECT rowid AS r FROM ${t.name} WHERE instr(${c.name}, char(0)) > 0 LIMIT 1`).get() as { r: number } | undefined;
      if (hit) {
        throw new MoveNulCharacterError(
          `${label}: ${t.name}.${c.name} of rowid ${hit.r} holds U+0000. node:sqlite reads such a value cut short at that character and Postgres text cannot hold it, so it cannot be moved intact; remove the character in the SQLite store first. Nothing was moved.`,
        );
      }
    }
  }
}

function readSqliteTables(db: SqliteReader, label: string): StoreSnapshot {
  refuseSqliteNul(db, label);
  const snap: StoreSnapshot = new Map();
  for (const t of MOVE_TABLES) {
    const raw = db.prepare(`SELECT ${t.cols.map((c) => c.name).join(', ')} FROM ${t.name}${whereClause(t)} ORDER BY ${t.sqliteOrder}`).all() as Record<string, unknown>[];
    snap.set(t.name, canonicalRows(t, raw));
  }
  return snap;
}

function readSqliteMeta(db: SqliteReader, key: string): string | undefined {
  return (db.prepare(`SELECT value FROM store_meta WHERE key = '${key}'`).get() as { value: string } | undefined)?.value;
}

/** The fence on a SQLite store, read through a read-only connection. */
export function readSqliteFence(path: string): MoveFence | null {
  if (!existsSync(path)) return null;
  return withReadOnlySqlite(path, (db) => parseFence(readSqliteMeta(db as unknown as SqliteReader, MOVE_FENCE_KEY), sqliteLabel(path)));
}

/** The receipt on a SQLite store (the target of an export), read through a read-only connection. */
export function readSqliteReceipt(path: string): MoveReceipt | null {
  if (!existsSync(path)) return null;
  return withReadOnlySqlite(path, (db) => {
    const v = readSqliteMeta(db as unknown as SqliteReader, MOVE_RECEIPT_KEY);
    return v === undefined ? null : parseReceipt(v, sqliteLabel(path));
  });
}

function upsertMetaSql(): string {
  return 'INSERT INTO store_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
}

/** Writes the fence row under BEGIN IMMEDIATE (the store's write lock). */
export function writeSqliteFence(path: string, fence: MoveFence): void {
  const driver = new SqliteDriver(path);
  try {
    driver.begin();
    try {
      driver.prepare(upsertMetaSql()).run(MOVE_FENCE_KEY, JSON.stringify(fence), new Date().toISOString());
      driver.commit();
    } catch (e) {
      driver.rollback();
      throw e;
    }
  } finally {
    driver.close();
  }
}

/** A consistent snapshot of a live SQLite store's copied tables (see snapshotSqlite). */
export function snapshotSqliteStore(path: string): StoreSnapshot {
  return snapshotSqlite(path, sqliteLabel(path));
}

/**
 * A consistent snapshot of a live SQLite store: VACUUM INTO a temp file
 * through a separate read-only connection, then read from that copy. The live
 * file is never opened for writing here.
 */
function snapshotSqlite(path: string, label: string): StoreSnapshot {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-move-'));
  try {
    const copy = join(dir, 'snapshot.db');
    withReadOnlySqlite(path, (db) => db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`));
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      assertSqliteColumns(db as unknown as SqliteReader, label);
      return readSqliteTables(db as unknown as SqliteReader, label);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Creates a fresh v2 store file when absent, and runs the additive migrations on an existing one. */
function prepareSqliteTarget(path: string, label: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // SterlingStore with an injected driver: never the process-wide driver factory.
  new SterlingStore(path, { driver: new SqliteDriver(path) }).close();
  withReadOnlySqlite(path, (db) => assertSqliteColumns(db as unknown as SqliteReader, label));
}

function insertSqliteRows(driver: SqliteDriver, t: TableSpec, rows: Row[]): void {
  if (!rows.length) return;
  const stmt = driver.prepare(`INSERT INTO ${t.name} (${t.cols.map((c) => c.name).join(', ')}) VALUES (${t.cols.map(() => '?').join(', ')})`);
  for (const row of rows) stmt.run(...row);
}

// ---------------------------------------------------------------------------
// Postgres side
// ---------------------------------------------------------------------------

// The advisory-lock keys are PgDriver.begin()'s own (LOCK_NS_GLOBAL,
// LOCK_NS_STORE, lockHash from pg-driver.ts). store-move.test.ts pins that a
// move transaction blocks a PgDriver write on the same store.

const q = (schema: string): string => {
  assertSterlingSchemaName(schema);
  return `"${schema}"`;
};

export interface PgTimeouts {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

function timeouts(bridge: PgBridge, t: PgTimeouts): { statement: number; lock: number } {
  const statement = t.statementTimeoutMs ?? DEFAULT_MOVE_STATEMENT_TIMEOUT_MS;
  const lock = t.lockTimeoutMs ?? DEFAULT_MOVE_LOCK_TIMEOUT_MS;
  for (const [n, v] of [['statementTimeoutMs', statement], ['lockTimeoutMs', lock]] as const) {
    if (!Number.isInteger(v) || v <= 0 || v >= bridge.waitTimeoutMs) {
      throw new MoveError(`store move: ${n} (${v} ms) must be a positive integer below the bridge's wait (${bridge.waitTimeoutMs} ms); open the bridge with waitTimeoutMs ${MOVE_BRIDGE_WAIT_MS}`);
    }
  }
  return { statement, lock };
}

function mapPg(e: unknown, where: string): unknown {
  if (e instanceof PgQueryError && e.code === '55P03') return new PgLockTimeoutError(`${e.message} in ${where}`);
  if (e instanceof PgQueryError && e.code === '57014') return new PgStatementTimeoutError(`${e.message} in ${where}`);
  return e;
}

/**
 * Runs `fn` in one Postgres transaction holding the same locks as a store
 * writer: the global lock SHARED (or EXCLUSIVE for a meta migration), then
 * the store's lock. A failure rolls back and is thrown by name.
 */
export function inPgMoveTransaction<T>(bridge: PgBridge, metaSchema: string, schema: string | null, t: PgTimeouts, fn: () => T, exclusiveGlobal = false): T {
  assertSterlingSchemaName(metaSchema);
  if (schema !== null) assertSterlingSchemaName(schema);
  const { statement, lock } = timeouts(bridge, t);
  const owner = {};
  const where = `a store move on '${schema ?? metaSchema}'`;
  bridge.claimTransaction(owner, where);
  try {
    bridge.query(
      `BEGIN; SET LOCAL lock_timeout = ${lock}; SET LOCAL statement_timeout = ${statement}; ` +
        `SELECT ${exclusiveGlobal ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(${LOCK_NS_GLOBAL}, ${lockHash(metaSchema)})` +
        (schema === null ? '' : `; SELECT pg_advisory_xact_lock(${LOCK_NS_STORE}, ${lockHash(schema)})`),
    );
    const result = fn();
    bridge.query('COMMIT');
    return result;
  } catch (e) {
    try {
      if (!bridge.closed) bridge.query('ROLLBACK');
    } catch {
      /* the original failure below is the one reported */
    }
    throw mapPg(e, where);
  } finally {
    bridge.releaseTransaction(owner);
  }
}

/** Creates <meta>.move_receipts under the exclusive global lock when it is absent. */
export function ensureMoveReceipts(bridge: PgBridge, metaSchema: string = PG_META_SCHEMA, t: PgTimeouts = {}): void {
  const m = q(metaSchema);
  if (bridge.query('SELECT to_regclass($1) AS r', [`${m}.move_receipts`]).rows[0].r !== null) return;
  inPgMoveTransaction(bridge, metaSchema, null, t, () => {
    bridge.query(`CREATE TABLE IF NOT EXISTS ${m}.move_receipts (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  move_id TEXT PRIMARY KEY,
  target_schema TEXT NOT NULL,
  source TEXT NOT NULL,
  receipt TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS move_receipts_target ON ${m}.move_receipts (target_schema, seq)`);
  }, true);
}

function pgStoreRegistered(bridge: PgBridge, metaSchema: string, schema: string): boolean {
  if (bridge.query('SELECT to_regclass($1) AS r', [`${q(metaSchema)}.stores`]).rows[0].r === null) return false;
  return bridge.query(`SELECT 1 FROM ${q(metaSchema)}.stores WHERE schema_name = $1`, [schema]).rows.length === 1;
}

function readPgTables(bridge: PgBridge, schema: string): StoreSnapshot {
  const snap: StoreSnapshot = new Map();
  for (const t of MOVE_TABLES) {
    const raw = bridge.query(`SELECT ${t.cols.map((c) => c.name).join(', ')} FROM ${q(schema)}.${t.name}${whereClause(t)} ORDER BY ${t.pgOrder}`).rows;
    snap.set(t.name, canonicalRows(t, raw));
  }
  return snap;
}

function readPgMeta(bridge: PgBridge, schema: string, key: string): string | undefined {
  const row = bridge.query(`SELECT value FROM ${q(schema)}.store_meta WHERE key = $1`, [key]).rows[0];
  return row === undefined ? undefined : String(row.value);
}

/** The fence on a Postgres store (its own store_meta row). */
export function readPgFence(bridge: PgBridge, schema: string): MoveFence | null {
  return parseFence(readPgMeta(bridge, schema, MOVE_FENCE_KEY), pgLabel(schema));
}

/** Writes the fence row in a transaction holding the store's write lock. */
export function writePgFence(bridge: PgBridge, metaSchema: string, schema: string, fence: MoveFence, t: PgTimeouts = {}): void {
  inPgMoveTransaction(bridge, metaSchema, schema, t, () => {
    bridge.query(
      `INSERT INTO ${q(schema)}.store_meta (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [MOVE_FENCE_KEY, JSON.stringify(fence), new Date().toISOString()],
    );
  });
}

/** The latest receipt committed for a Postgres target, or null. */
export function latestPgReceipt(bridge: PgBridge, metaSchema: string, schema: string): MoveReceipt | null {
  const m = q(metaSchema);
  if (bridge.query('SELECT to_regclass($1) AS r', [`${m}.move_receipts`]).rows[0].r === null) return null;
  const row = bridge.query(`SELECT receipt FROM ${m}.move_receipts WHERE target_schema = $1 ORDER BY seq DESC LIMIT 1`, [schema]).rows[0];
  return row === undefined ? null : parseReceipt(String(row.receipt), pgLabel(schema));
}

/** A consistent snapshot of a Postgres store's copied tables. */
export function snapshotPgStore(bridge: PgBridge, schema: string, t: PgTimeouts = {}): StoreSnapshot {
  return snapshotPg(bridge, schema, t);
}

/** A consistent snapshot of a Postgres store: one REPEATABLE READ READ ONLY transaction. */
function snapshotPg(bridge: PgBridge, schema: string, t: PgTimeouts): StoreSnapshot {
  const { statement } = timeouts(bridge, t);
  const owner = {};
  bridge.claimTransaction(owner, `a store move snapshot of '${schema}'`);
  try {
    bridge.query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout = ${statement}`);
    const snap = readPgTables(bridge, schema);
    bridge.query('COMMIT');
    return snap;
  } catch (e) {
    try {
      if (!bridge.closed) bridge.query('ROLLBACK');
    } catch {
      /* the original failure below is the one reported */
    }
    throw mapPg(e, `a snapshot of '${schema}'`);
  } finally {
    bridge.releaseTransaction(owner);
  }
}

/** Rows per INSERT: under Postgres's 65,535 parameters and about 4 MB of values per statement. */
const MAX_BATCH_ROWS = 1000;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

function insertPgRows(bridge: PgBridge, schema: string, table: string, cols: string[], rows: unknown[][]): number {
  let statements = 0;
  const perRow = Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(30000 / cols.length)));
  let batch: unknown[][] = [];
  let bytes = 0;
  const flush = () => {
    if (!batch.length) return;
    let n = 0;
    const values = batch.map(() => `(${cols.map(() => `$${++n}`).join(', ')})`).join(', ');
    bridge.query(`INSERT INTO ${q(schema)}.${table} (${cols.join(', ')}) VALUES ${values}`, batch.flat());
    statements++;
    batch = [];
    bytes = 0;
  };
  for (const row of rows) {
    const size = row.reduce<number>((s, v) => s + (typeof v === 'string' ? v.length * 2 : 8), 0);
    if (batch.length && (batch.length >= perRow || bytes + size > MAX_BATCH_BYTES)) flush();
    batch.push(row);
    bytes += size;
  }
  flush();
  return statements;
}

function toPgValues(row: Row): unknown[] {
  return row.map((v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Creates the Postgres store when it is not registered, and builds or checks its tables through SterlingStore. */
function preparePgTarget(bridge: PgBridge, metaSchema: string, schema: string, identity: StoreIdentity, label: string): void {
  if (!pgStoreRegistered(bridge, metaSchema, schema)) {
    const test = schema.startsWith('sterling_test_');
    createPgStore(bridge, { kind: test ? 'test' : identity.kind, name: test ? schema : identity.name, schema, metaSchema });
  }
  new SterlingStore(label, { driver: new PgDriver(bridge, { schema, metaSchema }) }).close();
  assertPgVersion(bridge, metaSchema, schema, label);
}

/** Refuses a Postgres store that is missing (PgStoreMissingError, from PgDriver) or not at the supported version. */
function assertPgVersion(bridge: PgBridge, metaSchema: string, schema: string, label: string): void {
  const driver = new PgDriver(bridge, { schema, metaSchema });
  try {
    const version = driver.schemaVersion();
    if (version !== SUPPORTED_SCHEMA_VERSION) {
      throw new MoveSchemaError(`${label} is at schema version ${version}; a move needs version ${SUPPORTED_SCHEMA_VERSION}. Nothing was moved.`);
    }
  } finally {
    driver.close();
  }
}

// ---------------------------------------------------------------------------
// The two moves
// ---------------------------------------------------------------------------

export interface MoveStoreResult {
  direction: MoveDirection;
  identity: StoreIdentity;
  source: string;
  target: string;
  outcome: MoveOutcome;
  move_id: string;
  /** Rows and digest per table, from the source snapshot. */
  tables: Record<string, TableManifest>;
  manifest_digest: string;
  /** True when the target, read back inside the copy transaction, matched the source manifest (or a replay's receipt did). */
  hash_match: boolean;
  /** Whether the source now carries the fence. */
  source_fenced: boolean;
  /** Postgres statements the copy sent (0 for SQLite targets and for a replay). */
  pg_statements: number;
  /** Dry run only: what the move would do with the target, or why it would refuse. */
  dry_run_plan?: string;
  /** Dry run only: the named refusal the real move would throw for this store. */
  dry_run_refusal?: { name: string; message: string };
  /** fork_already_copied only: the records the source holds that this move leaves behind. */
  fork_loss?: ForkLoss;
}

export interface MoveHooks {
  /** Test seam: runs inside the target transaction after the copy and before verification, with the target's write handle. */
  beforeVerify?: (target: { bridge?: PgBridge; schema?: string; sqlite?: SqliteDriver }) => void;
}

export interface ImportStoreInput extends PgTimeouts {
  sqlitePath: string;
  bridge: PgBridge;
  metaSchema: string;
  schema: string;
  identity: StoreIdentity;
  /** False for a shared domain a project still on SQLite mounts: the fork (decision c0ba4e93 point 6). */
  fenceSource: boolean;
  /**
   * Go ahead when the target already holds this source's fork
   * (fork_already_copied), leaving behind what the source gained since.
   * Without it that case is refused with MoveForkUnconfirmedError
   * (decision shared-domains-stay-forked-and-loud-while-projects-move-one-at-a-time).
   */
  confirmFork?: boolean;
  dryRun?: boolean;
  hooks?: MoveHooks;
}

function sourceFenceCheck(fence: MoveFence | null, label: string, targetLabel: string): void {
  if (fence && fence.to !== targetLabel) {
    throw new MoveSourceFencedError(`${label} is fenced by move ${fence.move_id}: it moved to ${fence.to} on ${fence.fenced_at}, not to ${targetLabel}. Nothing was moved.`);
  }
}

/** SQLite -> Postgres. */
export function importStore(input: ImportStoreInput): MoveStoreResult {
  const { bridge, metaSchema, schema, identity } = input;
  const sourceLabel = sqliteLabel(input.sqlitePath);
  const targetLabel = pgLabel(schema);
  if (!existsSync(input.sqlitePath)) throw new MoveSchemaError(`${sourceLabel} does not exist; nothing to move`);
  timeouts(bridge, input);

  // Preflight on the live file, read-only.
  const existingFence = readSqliteFence(input.sqlitePath);
  sourceFenceCheck(existingFence, sourceLabel, targetLabel);
  withReadOnlySqlite(input.sqlitePath, (db) => assertSqliteColumns(db as unknown as SqliteReader, sourceLabel));

  const moveId = existingFence?.move_id ?? randomUUID();
  // The target is classified BEFORE the fence too, so a refusal fences nothing;
  // the classification that decides is the one under the target's lock below.
  const preSnap = snapshotSqlite(input.sqlitePath, sourceLabel);
  assertNoInternalCollision(preSnap, sourceLabel);
  const preDetail = buildManifest(preSnap);
  let preLoss: ForkLoss | undefined;
  // A fork already copied is refused here, before anything is fenced, unless confirmed.
  const forkGate = (plan: TargetPlan, source: StoreSnapshot, target: StoreSnapshot): ForkLoss | undefined => {
    if (plan.kind !== 'fork_already_copied') return undefined;
    const loss = forkLoss(source, target);
    if (!input.confirmFork) throw forkUnconfirmed(identity, sourceLabel, targetLabel, plan.receipt, loss);
    return loss;
  };
  const preClassify = (): string => {
    if (!pgStoreRegistered(bridge, metaSchema, schema)) return 'copy into a new store';
    const current = snapshotPg(bridge, schema, input);
    const plan = classifyTarget({
      label: targetLabel,
      target: current,
      targetDigest: buildManifest(current).manifest.digest,
      fence: readPgFence(bridge, schema),
      receipt: latestPgReceipt(bridge, metaSchema, schema),
      identity,
      source: preSnap,
      sourceDigest: preDetail.manifest.digest,
      sourceForked: !input.fenceSource,
      sourceFenceMoveId: existingFence?.move_id ?? null,
    });
    preLoss = forkGate(plan, preSnap, current);
    return preLoss ? `${describePlan(plan)}; confirmed (${FORK_CONFIRM_FLAG}), leaving behind ${describeForkLoss(preLoss)}` : describePlan(plan);
  };
  if (input.dryRun) {
    const planned = dryRunPlan(preClassify);
    return { ...result('to_postgres', identity, sourceLabel, targetLabel, 'dry_run', moveId, preDetail.manifest, false, existingFence !== null, 0), ...planned, ...(preLoss ? { fork_loss: preLoss } : {}) };
  }
  preClassify();

  // Fence, then snapshot.
  const fence: MoveFence = existingFence ?? { move_id: moveId, to: targetLabel, fenced_at: new Date().toISOString(), manifest_digest: null };
  if (input.fenceSource && !existingFence) writeSqliteFence(input.sqlitePath, fence);
  const snap = snapshotSqlite(input.sqlitePath, sourceLabel);
  assertNoInternalCollision(snap, sourceLabel);
  const source = buildManifest(snap);
  if (input.fenceSource && fence.manifest_digest !== source.manifest.digest) {
    writeSqliteFence(input.sqlitePath, { ...fence, manifest_digest: source.manifest.digest });
  }

  ensureMoveReceipts(bridge, metaSchema, input);
  preparePgTarget(bridge, metaSchema, schema, identity, targetLabel);

  let statements = 0;
  let loss: ForkLoss | undefined;
  const outcome = inPgMoveTransaction(bridge, metaSchema, schema, input, (): MoveOutcome => {
    const current = readPgTables(bridge, schema);
    const plan = classifyTarget({
      label: targetLabel,
      target: current,
      targetDigest: buildManifest(current).manifest.digest,
      fence: readPgFence(bridge, schema),
      receipt: latestPgReceipt(bridge, metaSchema, schema),
      identity,
      source: snap,
      sourceDigest: source.manifest.digest,
      sourceForked: !input.fenceSource,
      sourceFenceMoveId: existingFence?.move_id ?? null,
    });
    loss = forkGate(plan, snap, current);
    if (plan.kind === 'replay' || plan.kind === 'fork_already_copied') return plan.kind === 'replay' ? 'replayed' : 'fork_already_copied';

    const s = q(schema);
    if (plan.kind === 'replace') {
      for (const t of [...MOVE_TABLES].reverse()) bridge.query(`DELETE FROM ${s}.${t.name}`);
      bridge.query(`DELETE FROM ${s}.records_fts`);
      statements += MOVE_TABLES.length + 1;
    }
    for (const t of MOVE_TABLES) {
      statements += insertPgRows(bridge, schema, t.name, t.cols.map((c) => c.name), (snap.get(t.name) ?? []).map(toPgValues));
    }
    // Search text: the type's fts builder over the stored body, folded as pgDialect.searchText does at every write site.
    const fts = (snap.get('records') ?? []).map((r) => [r[0], searchTextFor(r[1] as string, r[12] as string, pgDialect.searchText, `${sourceLabel} record ${String(r[0])}`).replace(/\u0000/g, '')]);
    statements += insertPgRows(bridge, schema, 'records_fts', ['record_id', 'text'], fts);
    for (const table of PG_IDENTITY_SEQ_TABLES) {
      bridge.query(`SELECT setval(pg_get_serial_sequence('${s}.${table}', 'seq'), coalesce(max(seq), 0) + 1, false) FROM ${s}.${table}`);
      statements++;
    }
    input.hooks?.beforeVerify?.({ bridge, schema });

    const copied = buildManifest(readPgTables(bridge, schema));
    verify(source, copied, targetLabel);
    verifyFts(
      bridge.query(`SELECT record_id FROM ${s}.records_fts`).rows.map((r) => String(r.record_id)),
      snap,
      targetLabel,
    );
    const receipt: MoveReceipt = {
      move_id: moveId,
      direction: 'to_postgres',
      source: sourceLabel,
      source_kind: identity.kind,
      source_name: identity.name,
      target: targetLabel,
      source_digest: source.manifest.digest,
      tables: source.manifest.tables,
      committed_at: new Date().toISOString(),
    };
    bridge.query(`INSERT INTO ${q(metaSchema)}.move_receipts (move_id, target_schema, source, receipt, committed_at) VALUES ($1, $2, $3, $4, $5)`, [
      moveId,
      schema,
      sourceLabel,
      JSON.stringify(receipt),
      receipt.committed_at,
    ]);
    bridge.query(`DELETE FROM ${s}.store_meta WHERE key = $1`, [MOVE_FENCE_KEY]);
    statements += 3;
    return plan.kind === 'replace' ? 'replaced' : 'copied';
  });
  const done = result('to_postgres', identity, sourceLabel, targetLabel, outcome, moveId, source.manifest, outcome !== 'fork_already_copied', input.fenceSource, statements);
  return loss ? { ...done, fork_loss: loss } : done;
}

export interface ExportStoreInput extends PgTimeouts {
  bridge: PgBridge;
  metaSchema: string;
  schema: string;
  sqlitePath: string;
  identity: StoreIdentity;
  /** False for a domain another work project still mounts in Postgres. */
  fenceSource: boolean;
  /** Hobby projects that mount the SQLite target: a refusal there is the diverged fork, and says so. */
  forkedWith?: string[];
  dryRun?: boolean;
  hooks?: MoveHooks;
}

/** Postgres -> SQLite. */
export function exportStore(input: ExportStoreInput): MoveStoreResult {
  const { bridge, metaSchema, schema, identity } = input;
  const sourceLabel = pgLabel(schema);
  const targetLabel = sqliteLabel(input.sqlitePath);
  timeouts(bridge, input);
  assertPgVersion(bridge, metaSchema, schema, sourceLabel);

  const existingFence = readPgFence(bridge, schema);
  sourceFenceCheck(existingFence, sourceLabel, targetLabel);
  const moveId = existingFence?.move_id ?? randomUUID();
  // Classified before the fence as well, so a refusal fences nothing.
  const preSnap = snapshotPg(bridge, schema, input);
  assertNoInternalCollision(preSnap, sourceLabel);
  const preDetail = buildManifest(preSnap);
  const preClassify = (): string => {
    if (!existsSync(input.sqlitePath)) return 'copy into a new file';
    try {
      return classifySqliteTarget();
    } catch (e) {
      const holders = input.forkedWith ?? [];
      if (holders.length && identity.kind === 'domain' && (e instanceof MoveTargetNotEmptyError || e instanceof MoveIdCollisionError) && readSqliteFence(input.sqlitePath) === null) {
        throw new MoveForkDivergedError(
          `domain '${identity.name}': its SQLite copy ${targetLabel} stayed writable for hobby project(s) ${holders.join(', ')} when it moved to Postgres (the fork), ` +
            `and the hobby copy has diverged from ${sourceLabel} since. A move back would have to merge the two copies, which a store move never does. Nothing was moved.`,
        );
      }
      throw e;
    }
  };
  const classifySqliteTarget = (): string => {
    return withReadOnlySqlite(input.sqlitePath, (raw) => {
      const db = raw as unknown as SqliteReader;
      assertSqliteColumns(db, targetLabel);
      const current = readSqliteTables(db, targetLabel);
      const receiptValue = readSqliteMeta(db, MOVE_RECEIPT_KEY);
      return describePlan(
        classifyTarget({
          label: targetLabel,
          target: current,
          targetDigest: buildManifest(current).manifest.digest,
          fence: parseFence(readSqliteMeta(db, MOVE_FENCE_KEY), targetLabel),
          receipt: receiptValue === undefined ? null : parseReceipt(receiptValue, targetLabel),
          identity,
          source: preSnap,
          sourceDigest: preDetail.manifest.digest,
          sourceForked: !input.fenceSource,
        }),
      );
    });
  };
  if (input.dryRun) {
    return { ...result('to_sqlite', identity, sourceLabel, targetLabel, 'dry_run', moveId, preDetail.manifest, false, existingFence !== null, 0), ...dryRunPlan(preClassify) };
  }
  preClassify();

  const fence: MoveFence = existingFence ?? { move_id: moveId, to: targetLabel, fenced_at: new Date().toISOString(), manifest_digest: null };
  if (input.fenceSource && !existingFence) writePgFence(bridge, metaSchema, schema, fence, input);
  const snap = snapshotPg(bridge, schema, input);
  assertNoInternalCollision(snap, sourceLabel);
  const source = buildManifest(snap);
  if (input.fenceSource && fence.manifest_digest !== source.manifest.digest) {
    writePgFence(bridge, metaSchema, schema, { ...fence, manifest_digest: source.manifest.digest }, input);
  }

  prepareSqliteTarget(input.sqlitePath, targetLabel);
  const driver = new SqliteDriver(input.sqlitePath);
  let outcome: MoveOutcome;
  try {
    driver.begin();
    try {
      const current = readSqliteTables(driver as unknown as SqliteReader, targetLabel);
      const receiptValue = readSqliteMeta(driver as unknown as SqliteReader, MOVE_RECEIPT_KEY);
      const plan = classifyTarget({
        label: targetLabel,
        target: current,
        targetDigest: buildManifest(current).manifest.digest,
        fence: parseFence(readSqliteMeta(driver as unknown as SqliteReader, MOVE_FENCE_KEY), targetLabel),
        receipt: receiptValue === undefined ? null : parseReceipt(receiptValue, targetLabel),
        identity,
        source: snap,
        sourceDigest: source.manifest.digest,
        sourceForked: !input.fenceSource,
      });
      if (plan.kind === 'replay' || plan.kind === 'fork_already_copied') {
        outcome = plan.kind === 'replay' ? 'replayed' : 'fork_already_copied';
      } else {
        if (plan.kind === 'replace') {
          for (const t of [...MOVE_TABLES].reverse()) driver.exec(`DELETE FROM ${t.name}${whereClause(t)}`);
          driver.exec('DELETE FROM records_fts');
        }
        for (const t of MOVE_TABLES) insertSqliteRows(driver, t, snap.get(t.name) ?? []);
        const ftsInsert = driver.prepare('INSERT INTO records_fts (record_id, text) VALUES (?, ?)');
        for (const r of snap.get('records') ?? []) {
          ftsInsert.run(r[0] as string, searchTextFor(r[1] as string, r[12] as string, sqliteDialect.searchText, `${sourceLabel} record ${String(r[0])}`));
        }
        input.hooks?.beforeVerify?.({ sqlite: driver });
        verify(source, buildManifest(readSqliteTables(driver as unknown as SqliteReader, targetLabel)), targetLabel);
        verifyFts(
          (driver.prepare('SELECT record_id FROM records_fts').all() as { record_id: string }[]).map((r) => r.record_id),
          snap,
          targetLabel,
        );
        const receipt: MoveReceipt = {
          move_id: moveId,
          direction: 'to_sqlite',
          source: sourceLabel,
          source_kind: identity.kind,
          source_name: identity.name,
          target: targetLabel,
          source_digest: source.manifest.digest,
          tables: source.manifest.tables,
          committed_at: new Date().toISOString(),
        };
        driver.prepare(upsertMetaSql()).run(MOVE_RECEIPT_KEY, JSON.stringify(receipt), receipt.committed_at);
        driver.prepare('DELETE FROM store_meta WHERE key = ?').run(MOVE_FENCE_KEY);
        outcome = plan.kind === 'replace' ? 'replaced' : 'copied';
      }
      driver.commit();
    } catch (e) {
      try {
        driver.rollback();
      } catch {
        /* the original failure below is the one reported */
      }
      throw e;
    }
  } finally {
    driver.close();
  }
  return result('to_sqlite', identity, sourceLabel, targetLabel, outcome, moveId, source.manifest, outcome !== 'fork_already_copied', input.fenceSource, 0);
}

function verify(source: ManifestDetail, copied: ManifestDetail, label: string): void {
  if (copied.manifest.digest === source.manifest.digest) return;
  const diffs = diffManifests(source, copied);
  throw new MoveVerificationError(`${label}: the copy does not match the source manifest (${describeDiff(diffs) || 'digest differs'}); the transaction was rolled back and nothing was committed.`);
}

function verifyFts(ftsIds: string[], snap: StoreSnapshot, label: string): void {
  const ids = (snap.get('records') ?? []).map((r) => r[0] as string);
  const have = new Set(ftsIds);
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length || ftsIds.length !== ids.length) {
    throw new MoveVerificationError(`${label}: records_fts has ${ftsIds.length} row(s) for ${ids.length} record(s) (missing ${missing.slice(0, 5).join(', ') || 'none'}); the transaction was rolled back.`);
  }
}

function describePlan(plan: TargetPlan): string {
  switch (plan.kind) {
    case 'empty':
      return 'copy into the empty target';
    case 'replace':
      return `replace the copy move ${plan.fence.move_id} left behind`;
    case 'replay':
      return `replay: receipt ${plan.receipt.move_id} already matches, no copy`;
    case 'fork_already_copied':
      return `none: this shared domain was copied by move ${plan.receipt.move_id}; the copies diverge from then on`;
  }
}

function recordTitle(body: Val): string {
  try {
    const b = JSON.parse(String(body)) as Record<string, unknown>;
    const t = [b.title, b.headline, b.text].find((v) => typeof v === 'string' && v.trim() !== '') as string | undefined;
    if (t === undefined) return '(no title)';
    return t.length > 80 ? `${t.slice(0, 79)}…` : t;
  } catch {
    return '(body is not JSON)';
  }
}

/** The column naming the record a row belongs to, for the tables that have one. */
const RECORD_ID_COLUMN: Record<string, string> = {
  records: 'id',
  record_versions: 'record_id',
  record_aliases: 'canonical_id',
  record_relations: 'source_id',
  record_stack_tags: 'record_id',
  record_file_keys: 'record_id',
  activity_log: 'record_id',
  queue_drain_log: 'record_id',
  selection: 'record_id',
};

/**
 * What a move past a fork leaves behind: the full-manifest difference between
 * the source and target copies (buildManifest and diffManifests), every
 * differing row mapped to the record it belongs to where it has one.
 */
export function forkLoss(source: StoreSnapshot, target: StoreSnapshot): ForkLoss {
  const diffs = diffManifests(buildManifest(source), buildManifest(target));
  const tables: Record<string, ForkLossTable> = {};
  const kindOf = new Map<string, ForkLossEntry['kind']>();
  let unattributed = 0;
  for (const d of diffs) {
    tables[d.table] = { only_in_source: d.missing.length, only_in_target: d.extra.length, changed: d.changed.length };
    const t = MOVE_TABLES.find((x) => x.name === d.table)!;
    const col = RECORD_ID_COLUMN[t.name];
    const idx = col === undefined ? -1 : t.cols.findIndex((c) => c.name === col);
    const src = keyedRows(t, source.get(t.name) ?? []);
    const tgt = keyedRows(t, target.get(t.name) ?? []);
    const touch = (key: string, side: Map<string, { row: Row }>, recordKind: ForkLossEntry['kind']): void => {
      const id = idx < 0 ? null : side.get(key)!.row[idx];
      if (typeof id !== 'string') {
        unattributed++;
        return;
      }
      if (t.name === 'records') kindOf.set(id, recordKind);
      else if (!kindOf.has(id)) kindOf.set(id, 'differs');
    };
    for (const k of d.missing) touch(k, src, 'only_in_source');
    for (const k of d.extra) touch(k, tgt, 'only_in_target');
    for (const k of d.changed) touch(k, src, 'differs');
  }
  const titleOf = new Map<string, string>();
  for (const r of [...(target.get('records') ?? []), ...(source.get('records') ?? [])]) titleOf.set(r[0] as string, recordTitle(r[12]));
  const order: ForkLossEntry['kind'][] = ['only_in_source', 'only_in_target', 'differs'];
  const entries = [...kindOf.entries()]
    .map(([id, kind]) => ({ id, title: titleOf.get(id) ?? '(no record row in either copy)', kind }))
    .sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || x.id.localeCompare(y.id));
  const count = (k: ForkLossEntry['kind']) => entries.filter((e) => e.kind === k).length;
  return {
    only_in_source: count('only_in_source'),
    only_in_target: count('only_in_target'),
    differs: count('differs'),
    tables,
    unattributed_rows: unattributed,
    listed: entries.slice(0, FORK_LOSS_LIST_CAP),
  };
}

const FORK_KIND_NOTE: Record<ForkLossEntry['kind'], string> = {
  only_in_source: 'only in the SQLite copy',
  only_in_target: 'only in Postgres',
  differs: 'differs between the copies',
};

export function describeForkLoss(loss: ForkLoss): string {
  const tableNames = Object.keys(loss.tables);
  if (tableNames.length === 0) return 'no row differs between the copies';
  const total = loss.only_in_source + loss.only_in_target + loss.differs;
  const perTable = tableNames
    .map((n) => {
      const t = loss.tables[n];
      return `${n} ${t.only_in_source} only in SQLite, ${t.only_in_target} only in Postgres, ${t.changed} changed`;
    })
    .join('; ');
  const lines = loss.listed.map((e) => `${e.id} "${e.title}" (${FORK_KIND_NOTE[e.kind]})`);
  const more = total > loss.listed.length ? `; and ${total - loss.listed.length} more` : '';
  return (
    `${loss.only_in_source} record(s) only in the SQLite copy, ${loss.only_in_target} only in Postgres, ${loss.differs} that differ (the record or its versions, aliases, relations, tags, file keys or log rows)` +
    `${loss.unattributed_rows ? `, and ${loss.unattributed_rows} differing row(s) tied to no record` : ''}. Rows per table: ${perTable}. Records: ${lines.join('; ') || 'none'}${more}`
  );
}

function forkUnconfirmed(identity: StoreIdentity, sourceLabel: string, targetLabel: string, receipt: MoveReceipt, loss: ForkLoss): MoveForkUnconfirmedError {
  return new MoveForkUnconfirmedError(
    `${identity.kind} '${identity.name}': ${targetLabel} was copied from ${sourceLabel} by move ${receipt.move_id} on ${receipt.committed_at}, and the SQLite copy stayed writable for other projects (the fork). ` +
      `This move does not copy it again and never merges the two copies, so no difference between them carries over: ${describeForkLoss(loss)}. ` +
      `The two copies stay different: neither is merged into the other, and each copy keeps its own rows. Re-run with ${FORK_CONFIRM_FLAG} to move on that basis. Nothing was moved.`,
    loss,
  );
}

/** A dry run reports a refusal instead of throwing it; any error that is not a MoveError still throws. */
function dryRunPlan(fn: () => string): Pick<MoveStoreResult, 'dry_run_plan' | 'dry_run_refusal'> {
  try {
    return { dry_run_plan: fn() };
  } catch (e) {
    if (e instanceof MoveError) return { dry_run_plan: `refused: ${e.name}: ${e.message}`, dry_run_refusal: { name: e.name, message: e.message } };
    throw e;
  }
}

function result(
  direction: MoveDirection,
  identity: StoreIdentity,
  source: string,
  target: string,
  outcome: MoveOutcome,
  moveId: string,
  manifest: StoreManifest,
  hashMatch: boolean,
  sourceFenced: boolean,
  statements: number,
): MoveStoreResult {
  return { direction, identity, source, target, outcome, move_id: moveId, tables: manifest.tables, manifest_digest: manifest.digest, hash_match: hashMatch, source_fenced: sourceFenced, pg_statements: statements };
}

// ---------------------------------------------------------------------------
// Preflight: which stores one project's move covers
// ---------------------------------------------------------------------------

export interface PlannedStore {
  identity: StoreIdentity;
  sqlitePath: string;
  schema: string;
  /** False for a shared domain left live for other projects (sharedWith names them). */
  fenceSource: boolean;
  /** The other projects that keep using the source side of this domain. */
  sharedWith: SharingProject[];
  /** Moving back only: hobby projects that mount this domain's SQLite file, so a live SQLite copy there is a fork. */
  forkedWith: SharingProject[];
}

/**
 * Another registered project that keeps using one side of a domain. Its mode
 * and storage are null when its config cannot be read; moving to Postgres
 * counts such a project as still on SQLite and mounting every domain.
 */
export interface SharingProject {
  root: string;
  mode: ProjectMode | null;
  storage: ProjectStorage | null;
}

export interface MovePlan {
  direction: MoveDirection;
  root: string;
  projectId: string;
  mode: ProjectMode;
  metaSchema: string;
  testNamespace?: string;
  /** config.storage as the move found it ('sqlite' when absent). */
  storage: ProjectStorage;
  stores: PlannedStore[];
  /** Registered projects skipped in the shared-domain check because their directory or config is gone. */
  skippedProjects: string[];
  /**
   * Moving to Postgres only: registered projects whose config exists but
   * cannot be read, each with the reason. They count as still on SQLite and
   * as mounting every domain, so no domain this move covers is fenced for them.
   */
  unreadableProjects: { root: string; reason: string }[];
}

export interface PlanMoveInput {
  root: string;
  direction: MoveDirection;
  /** repo_path of every project in the machine registry, for the shared-domain check. */
  registeredProjects: string[];
  credentialsPath: string;
}

const CONFIG_REL = '.sterling/config.json';

function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function readConfigOf(root: string): ReturnType<typeof parseConfig> | null {
  const path = join(root, CONFIG_REL);
  if (!existsSync(path)) return null;
  try {
    return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    throw new MoveConfigInvalidError(`${path} is not a valid Sterling config (${(e as Error).message}). Nothing was moved.`);
  }
}

/**
 * Preflight for one project (decision
 * store-move-skill-two-way-one-direction-at-a-time-no-live-sync, narrowed
 * 2026-10-06 to the invoking project only): the project store plus its
 * mounted domains, the Postgres names the routing uses, and the shared-domain
 * fork. Reads files only; opens no database.
 */
export function planMove(input: PlanMoveInput): MovePlan {
  const root = resolve(input.root);
  const config = readConfigOf(root);
  if (config === null) throw new MoveConfigMissingError(`${root}/${CONFIG_REL} does not exist; run the move inside a Sterling project. Nothing was moved.`);
  const mode = readProjectMode(root);
  const storage = readProjectStorage(root);
  // Decision storage-backend-is-its-own-config-key-written-only-by-store-move:
  // storage postgres is valid only in work mode. Moving back to SQLite needs no
  // mode, since it is also the way out for a postgres store in a hobby project.
  if (input.direction === 'to_postgres' && mode === 'hobby') {
    throw new MoveModeError(
      `${root} is a hobby project (config.mode is hobby); a store move never moves a hobby project to Postgres, which is valid only in work mode. Set the project to work mode first (TUI System tab), then move it. Nothing was moved.`,
    );
  }
  const identity = readProjectIdentity(root);
  if (identity === null) throw new MoveIdentityMissingError(`${root}/.sterling/project.json is missing; a work project's Postgres store is named by its project_id. Restore it from git, or let init write it. Nothing was moved.`);
  try {
    readPgCredentials(input.credentialsPath);
  } catch (e) {
    if (e instanceof PgConfigError) throw new MoveCredentialsError(`${e.message}. Nothing was moved.`);
    throw e;
  }

  // The routing's own names (production or STERLING_TEST_PG_NAMESPACE), so the move fills the schemas the router opens.
  const names = pgStoreNames(identity.project_id, config.stack_tags);
  const { metaSchema, projectSchema } = names;
  const ns = process.env[PG_TEST_NAMESPACE_ENV] || undefined;
  const schemaOf = new Map(names.domains.map((d) => [d.name, d.schema]));

  // Who else mounts what: a project on SQLite storage writes the domains' SQLite files, a project on Postgres storage the schemas.
  const others: { root: string; mode: ProjectMode; storage: ProjectStorage; paths: Set<string>; schemas: Set<string> }[] = [];
  const skipped: string[] = [];
  const unreadable: { root: string; reason: string }[] = [];
  for (const repo of input.registeredProjects) {
    const other = resolve(repo);
    if (canonicalPath(other) === canonicalPath(root)) continue;
    if (!existsSync(join(other, CONFIG_REL))) {
      skipped.push(other);
      continue;
    }
    try {
      const cfg = readConfigOf(other)!;
      const otherMode = readProjectMode(other);
      const mounts = resolveDomainMounts(cfg);
      // Only the domain schemas are used here; the project id argument names no store of the other project.
      const otherSchemas = pgStoreNames(identity.project_id, cfg.stack_tags).domains.map((d) => d.schema);
      const otherStorage = readProjectStorage(other);
      others.push({ root: other, mode: otherMode, storage: otherStorage, paths: new Set(mounts.map((m) => canonicalPath(m.dbPath))), schemas: new Set(otherSchemas) });
    } catch (e) {
      // Fencing a SQLite domain needs proof that every project mounting it is on Postgres; an unreadable config proves
      // nothing, so moving to Postgres counts it as on SQLite and mounting every domain (decision
      // shared-domains-stay-forked-and-loud-while-projects-move-one-at-a-time). Moving back still refuses it.
      if (input.direction === 'to_postgres') {
        unreadable.push({ root: other, reason: (e as Error).message });
        continue;
      }
      throw new MoveRegistryProjectError(
        `registered project ${other} has a config that cannot be read (${(e as Error).message}), so whether it shares a domain with this project is unknown. Fix or unregister it first. Nothing was moved.`,
      );
    }
  }

  const stores: PlannedStore[] = [
    { identity: { kind: 'project', name: identity.project_id }, sqlitePath: join(root, '.sterling', 'sterling.db'), schema: projectSchema, fenceSource: true, sharedWith: [], forkedWith: [] },
  ];
  for (const mount of resolveDomainMounts(config)) {
    const schema = schemaOf.get(mount.name)!;
    const path = canonicalPath(mount.dbPath);
    // Importing: every other project still on SQLite storage keeps writing the SQLite domain (the fork), whatever its
    // mode; the SQLite copy is fenced only when every project mounting it is on Postgres. Exporting: another work
    // project keeps reading the Postgres domain.
    const sharedWith: SharingProject[] =
      input.direction === 'to_postgres'
        ? [
            ...others.filter((o) => o.storage === 'sqlite' && o.paths.has(path)).map((o) => ({ root: o.root, mode: o.mode, storage: o.storage })),
            ...unreadable.map((u) => ({ root: u.root, mode: null, storage: null })),
          ]
        : others.filter((o) => o.mode === 'work' && o.schemas.has(schema)).map((o) => ({ root: o.root, mode: o.mode, storage: o.storage }));
    const forkedWith: SharingProject[] =
      input.direction === 'to_sqlite' ? others.filter((o) => o.mode === 'hobby' && o.paths.has(path)).map((o) => ({ root: o.root, mode: o.mode, storage: o.storage })) : [];
    stores.push({ identity: { kind: 'domain', name: mount.name }, sqlitePath: mount.dbPath, schema, fenceSource: sharedWith.length === 0, sharedWith, forkedWith });
  }
  for (const s of stores) assertSterlingSchemaName(s.schema);
  return { direction: input.direction, root, projectId: identity.project_id, mode, storage, metaSchema, ...(ns ? { testNamespace: ns } : {}), stores, skippedProjects: skipped, unreadableProjects: unreadable };
}

/** The repo paths in a registry.db, read through a read-only connection; [] when the file does not exist. */
export function readRegisteredProjects(registryDbPath: string): string[] {
  if (!existsSync(registryDbPath)) return [];
  return withReadOnlySqlite(registryDbPath, (db) => (db.prepare('SELECT repo_path FROM projects ORDER BY repo_path').all() as { repo_path: string }[]).map((r) => r.repo_path));
}

export type ProjectStorage = 'sqlite' | 'postgres';
export const PROJECT_STORAGES: readonly ProjectStorage[] = ['sqlite', 'postgres'];

function readConfigObject(root: string): { path: string; parsed: Record<string, unknown> } {
  readProjectMode(root); // refuses a symlinked or malformed config by name before it is read here
  const path = join(resolve(root), CONFIG_REL);
  return { path, parsed: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> };
}

/** config.storage: 'sqlite' when absent; any other value is refused by name, never guessed. */
export function readProjectStorage(root: string): ProjectStorage {
  const { path, parsed } = readConfigObject(root);
  if (parsed.storage === undefined) return 'sqlite';
  if (!(PROJECT_STORAGES as readonly unknown[]).includes(parsed.storage)) {
    throw new MoveStorageSettingError(`config.storage is ${JSON.stringify(parsed.storage)} in ${path}; it must be 'sqlite' or 'postgres'. Nothing was moved.`);
  }
  return parsed.storage as ProjectStorage;
}

/**
 * The explicit storage transition (decision
 * storage-backend-is-its-own-config-key-written-only-by-store-move):
 * config.storage written into the project's own .sterling/config.json (temp
 * file plus rename), every other key, config.mode included, kept as is. Only
 * the store move calls it, after every store's receipt has committed. Returns
 * false when storage already had that value ('sqlite' when absent).
 */
export function writeProjectStorage(root: string, storage: ProjectStorage): boolean {
  if (!PROJECT_STORAGES.includes(storage)) throw new MoveStorageSettingError(`storage must be 'sqlite' or 'postgres', got ${JSON.stringify(storage)}`);
  if (readProjectStorage(root) === storage) return false;
  const { path, parsed } = readConfigObject(root);
  parsed.storage = storage;
  const tmp = `${path}.move-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n');
  renameSync(tmp, path);
  return true;
}

// ---------------------------------------------------------------------------
// Attach: a second machine joins a project already on Postgres
// ---------------------------------------------------------------------------
//
// Decision second-machine-attaches-to-a-postgres-project-through-move-store-attach.
// A fresh clone has the committed project.json but no config.storage, and its
// SQLite digest can never match the receipt the first machine wrote, so the move
// itself refuses there. The attach copies no data: it runs planMove's file
// checks, then requires that the project schema and every mounted domain schema
// is registered, carries a move receipt from that same store and is not fenced
// on the Postgres side. A receipt counts only when it is a complete to_postgres
// receipt for that schema whose table manifest adds up to its digest. The
// config's mounts are compared with the plan again before anything is written.
// Only then does it write config.storage = 'postgres', so the move module stays
// the only writer of the key.
//
// This machine's own project SQLite file, when there is one, is fenced toward
// the project schema before the switch, so an older release cannot keep writing
// into it and a later move back to SQLite from this machine replaces it as the
// untouched copy a move left. A file that holds anything in a table a move
// copies is refused unless the caller passes fenceLocal, because after the
// switch that content is no longer reachable from this project. A same-target
// fence left without its digest (a crash between the two fence writes) gets
// the digest recorded before the switch. Domain SQLite files are never touched:
// other projects on this machine may still use them.
//
// What this does NOT guarantee: a move back to SQLite run elsewhere between the
// checks and the switch is not seen here (the router then refuses writes on the
// fenced schema with StoreMovedError); the Postgres checks are reads, not locks.

/** The attach check that refused. */
export type AttachCheck = 'storage' | 'registered' | 'receipt' | 'fence' | 'local_store' | 'mounts';

/** move-store --attach refused. `check` names the failed check; `schema` the Postgres store it failed on, or null for a check on this machine. */
export class MoveAttachError extends MoveError {
  readonly check: AttachCheck;
  readonly schema: string | null;
  constructor(check: AttachCheck, schema: string | null, message: string) {
    super(`attach check '${check}' failed: ${message}`);
    this.check = check;
    this.schema = schema;
  }
}

export interface AttachPlan {
  root: string;
  projectId: string;
  mode: ProjectMode;
  metaSchema: string;
  testNamespace?: string;
  /** The project store first, then every mounted domain, with the schema the router opens. */
  stores: { identity: StoreIdentity; schema: string }[];
  /** This machine's project SQLite file (it may not exist). */
  localSqlitePath: string;
  /** The caller chose to fence a local SQLite file that holds records. */
  fenceLocal: boolean;
}

export interface PlanAttachInput {
  root: string;
  credentialsPath: string;
  fenceLocal?: boolean;
}

/**
 * The file checks for an attach. Reuses planMove (config, work mode, identity,
 * credentials, schema names) with no registered projects: an attach copies and
 * fences no domain, so who else mounts one does not matter. Opens no database.
 */
export function planAttach(input: PlanAttachInput): AttachPlan {
  const plan = planMove({ root: input.root, direction: 'to_postgres', registeredProjects: [], credentialsPath: input.credentialsPath });
  if (plan.storage === 'postgres') {
    throw new MoveAttachError('storage', null, `${plan.root}: config.storage is already postgres, so this machine is already attached. Nothing was changed.`);
  }
  return {
    root: plan.root,
    projectId: plan.projectId,
    mode: plan.mode,
    metaSchema: plan.metaSchema,
    ...(plan.testNamespace ? { testNamespace: plan.testNamespace } : {}),
    stores: plan.stores.map((s) => ({ identity: s.identity, schema: s.schema })),
    localSqlitePath: plan.stores[0].sqlitePath,
    fenceLocal: input.fenceLocal ?? false,
  };
}

export interface AttachedStore {
  identity: StoreIdentity;
  schema: string;
  receipt: { move_id: string; source: string; committed_at: string };
}

export interface AttachResult {
  root: string;
  metaSchema: string;
  mode: ProjectMode;
  dryRun: boolean;
  stores: AttachedStore[];
  /** This machine's project SQLite file and what the attach did with it. */
  local: { path: string; records: number; occupied: string[]; action: 'absent' | 'fenced' | 'already_fenced' | 'would_fence' };
  storageSwitched: boolean;
}

function attachLabel(s: { identity: StoreIdentity; schema: string }): string {
  return `${s.identity.kind} ${s.identity.name} (${pgLabel(s.schema)})`;
}

/**
 * Why a receipt is not a complete to_postgres receipt for this store, or null.
 * latestPgReceipt only checks move_id and source_digest; a receipt importStore
 * wrote has every field below, and its table manifest gives its source_digest
 * (the top-level digest buildManifest computes).
 */
function attachReceiptProblem(receipt: MoveReceipt, s: { identity: StoreIdentity; schema: string }): string | null {
  const r = receipt as unknown as Record<string, unknown>;
  if (r.direction !== 'to_postgres') return `its direction is ${JSON.stringify(r.direction)}, not "to_postgres"`;
  if (r.target !== pgLabel(s.schema)) return `its target is ${JSON.stringify(r.target)}, not "${pgLabel(s.schema)}"`;
  if (r.source_kind !== s.identity.kind || r.source_name !== s.identity.name) return `it is from ${String(r.source_kind)} ${String(r.source_name)}, not from this store`;
  if (typeof r.source !== 'string' || r.source === '') return 'it names no source';
  if (typeof r.committed_at !== 'string' || Number.isNaN(Date.parse(r.committed_at))) return `its committed_at ${JSON.stringify(r.committed_at)} is not a time`;
  const tables = r.tables;
  if (typeof tables !== 'object' || tables === null) return 'it has no table manifest';
  const top: string[] = [];
  const bad: string[] = [];
  for (const t of MOVE_TABLES) {
    const m = (tables as Record<string, { rows?: unknown; digest?: unknown } | undefined>)[t.name];
    if (!m || !Number.isInteger(m.rows) || (m.rows as number) < 0 || typeof m.digest !== 'string') bad.push(t.name);
    else top.push(`${t.name}:${m.rows as number}:${m.digest}`);
  }
  if (bad.length) return `its table manifest lacks or misstates ${bad.join(', ')}`;
  if (sha256(`v${MOVE_MANIFEST_VERSION}\n${top.join('\n')}`) !== r.source_digest) return 'its table manifest does not add up to its source_digest';
  return null;
}

/**
 * Refuses when the config's stores no longer match the plan: a domain mounted
 * or unmounted while the attach ran would otherwise reach config.storage
 * = postgres unchecked.
 */
function assertAttachMountsUnchanged(plan: AttachPlan, written: string): void {
  const config = readConfigOf(plan.root);
  const identity = readProjectIdentity(plan.root);
  const names = config === null || identity === null ? null : pgStoreNames(identity.project_id, config.stack_tags);
  const planned = plan.stores.map((s) => s.schema);
  const current = names === null ? [] : [names.projectSchema, ...names.domains.map((d) => d.schema)];
  const key = (xs: string[]) => [...xs].sort().join('\n');
  if (key(planned) !== key(current)) {
    throw new MoveAttachError(
      'mounts',
      null,
      `${plan.root}: the project's stores changed while the attach ran (checked: ${planned.join(', ')}; now: ${current.join(', ') || 'no readable config or project.json'}). ` +
        `Re-run the attach so every store is checked. ${written}`,
    );
  }
}

/** Registered, a receipt from this same store, no Postgres-side fence; each refusal names the schema and the check. */
function checkAttachStore(bridge: PgBridge, metaSchema: string, s: { identity: StoreIdentity; schema: string }): AttachedStore {
  const label = attachLabel(s);
  if (!pgStoreRegistered(bridge, metaSchema, s.schema)) {
    throw new MoveAttachError(
      'registered',
      s.schema,
      `${label} is not registered in ${metaSchema}.stores, so it was never moved to Postgres. Run move-store --to pg on the machine that holds this store first. Nothing was changed.`,
    );
  }
  const receipt = latestPgReceipt(bridge, metaSchema, s.schema);
  if (receipt === null) {
    throw new MoveAttachError('receipt', s.schema, `${label} is registered but has no move receipt in ${metaSchema}.move_receipts, so no completed move filled it. Nothing was changed.`);
  }
  const problem = attachReceiptProblem(receipt, s);
  if (problem !== null) {
    throw new MoveAttachError(
      'receipt',
      s.schema,
      `${label}: its latest move receipt ${receipt.move_id} is not a complete to_postgres receipt for this store: ${problem}. Nothing was changed.`,
    );
  }
  const fence = readPgFence(bridge, s.schema);
  if (fence) {
    throw new MoveAttachError(
      'fence',
      s.schema,
      `${label} is fenced by move ${fence.move_id}: it moved to ${fence.to} on ${fence.fenced_at}, so it no longer takes writes. Nothing was changed.`,
    );
  }
  return { identity: s.identity, schema: s.schema, receipt: { move_id: receipt.move_id, source: receipt.source, committed_at: receipt.committed_at } };
}

/**
 * Attaches this machine to the project's Postgres stores: every store is
 * checked first, then the local project SQLite file is fenced (see above),
 * then config.storage is written. A dry run runs every check and writes nothing.
 */
export function attachProject(plan: AttachPlan, bridge: PgBridge, opts: { dryRun?: boolean } = {}): AttachResult {
  const dryRun = opts.dryRun ?? false;
  const stores = plan.stores.map((s) => checkAttachStore(bridge, plan.metaSchema, s));
  assertAttachMountsUnchanged(plan, 'Nothing was changed.');
  const path = plan.localSqlitePath;
  let local: AttachResult['local'] = { path, records: 0, occupied: [], action: 'absent' };
  if (existsSync(path)) {
    const label = sqliteLabel(path);
    const target = pgLabel(plan.stores[0].schema);
    const existing = readSqliteFence(path);
    sourceFenceCheck(existing, label, target);
    const snap = snapshotSqlite(path, label);
    // Every table a move copies is content (store_meta without the fence and receipt rows), not only records.
    const occupied = nonEmptyTables(snap);
    const records = (snap.get('records') ?? []).length;
    if (existing) {
      // A crash between the two fence writes leaves the digest unrecorded; without it a move back refuses the file.
      if (existing.manifest_digest === null && !dryRun) writeSqliteFence(path, { ...existing, manifest_digest: buildManifest(snap).manifest.digest });
      local = { path, records, occupied, action: 'already_fenced' };
    } else {
      if (occupied.length > 0 && !plan.fenceLocal) {
        throw new MoveAttachError(
          'local_store',
          null,
          `${label} holds ${occupied.join(', ')}. After the attach this project reads only Postgres, so none of it would be reachable from it. ` +
            `Check what it is; to fence the file and attach anyway, pass --fence-local (the file is kept, and a later move back to SQLite from this machine replaces it). Nothing was changed.`,
        );
      }
      if (!dryRun) {
        // As in importStore: fence first, then record the digest of what the fence froze.
        const fence: MoveFence = { move_id: randomUUID(), to: target, fenced_at: new Date().toISOString(), manifest_digest: null };
        writeSqliteFence(path, fence);
        writeSqliteFence(path, { ...fence, manifest_digest: buildManifest(snapshotSqlite(path, label)).manifest.digest });
      }
      local = { path, records, occupied, action: dryRun ? 'would_fence' : 'fenced' };
    }
  }
  if (!dryRun) assertAttachMountsUnchanged(plan, local.action === 'fenced' ? `The local SQLite store ${path} was fenced toward ${pgLabel(plan.stores[0].schema)}; config.storage was not changed.` : 'Nothing was changed.');
  const storageSwitched = dryRun ? false : writeProjectStorage(plan.root, 'postgres');
  return { root: plan.root, metaSchema: plan.metaSchema, mode: plan.mode, dryRun, stores, local, storageSwitched };
}
