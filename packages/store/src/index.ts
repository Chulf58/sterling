// @sterling/store — the SQLite access layer (spec §3.1, §16.1 Slice 2): the one
// write code path, imported by mcp-server AND tui; zod validation (shared
// @sterling/schemas) guards every write including the TUI's.
//
// Substrate (verified at build against §3.1 criteria): SQLite via node:sqlite
// (Node ≥24, bundled SQLite 3.51.x — WAL, FTS5/bm25, VACUUM INTO; zero native
// dependencies). node:sqlite is API-experimental, so all driver contact stays
// inside this module; swapping drivers is a one-file change.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  RECORD_TYPES,
  validateRecord,
  normalizeRepoPath,
  linkSchema,
  handoffSchema,
  runRecordSchema,
  LIFECYCLE_VALUES,
  FRESHNESS_VALUES,
  type DurableRecord,
  type Handoff,
  type MachineState,
  type RunRecord,
  type Lifecycle,
  type Freshness,
} from '@sterling/schemas';

export { MountedStores, type DomainMount, resolveDomainMounts } from './mounted.js';
export { ProjectRegistry, registryPath, type RegisterInput } from './registry.js';
export * from './axis.js';

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
`;

// ---------------------------------------------------------------------------
// Schema-version guard (stable-identity S1, extended by S2; decision
// [stable-identity-design-v2] / 2176748e): refuse-until-migrated. PRAGMA
// user_version (research_finding 5555895c: a 32-bit application-owned integer
// at header offset 60 — NEVER SQLite's own PRAGMA schema_version) is checked at
// the very top of open, before the DDL or any other write lands, so a store
// from a NEWER, unsupported schema is refused with nothing touched.
//
// S2 SEMANTICS (the S1 blanket auto-stamp-forward is GONE):
//   * a FRESH store file (sqlite_master empty at open, before DDL) is built as
//     v2 and stamped user_version = 2;
//   * an EXISTING, non-empty store below the supported version is NOT stamped
//     forward — stamping it would claim a data migration that never ran. It
//     opens READ-ONLY: reads work, every write refuses loudly naming the
//     stable-identity migration;
//   * a too-new store still refuses via UnsupportedSchemaVersionError with
//     nothing written (the user_version read stays BEFORE journal_mode/DDL).
// ---------------------------------------------------------------------------
export const SUPPORTED_SCHEMA_VERSION = 2;

export class UnsupportedSchemaVersionError extends Error {
  readonly found: number;
  readonly supported: number;
  constructor(found: number, supported: number) {
    super(
      `Unsupported schema version: this store's user_version (${found}) is newer than the schema version this build supports (${supported}). ` +
        `This store was likely migrated by a newer build of Sterling. Do not open it with an older/downgraded build — writing with a downgraded ` +
        `build over a newer schema risks corrupting the store. Upgrade this build (or restore from a backup taken before the migration) before continuing.`
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.found = found;
    this.supported = supported;
  }
}

/**
 * Every WRITE against a store that predates the stable-identity schema
 * ([stable-identity-design-v2]). The store opened fine — reads are deliberately
 * allowed pre-migration (AC3) — but no write may land: v2 shapes written into a
 * v1 schema would corrupt it, and stamping the marker forward without moving
 * the data would silently claim a migration that never ran (exactly what the S1
 * 0→1 auto-stamp did, which is why it was removed here).
 */
export class SchemaMigrationRequiredError extends Error {
  readonly found: number;
  readonly supported: number;
  constructor(found: number, supported: number, operation: string) {
    super(
      `Schema migration required: this store is at schema version ${found}, but this build requires version ${supported}. ` +
        `The store is open READ-ONLY — '${operation}' and every other write refuses until the stable-identity migration has run. ` +
        `Run the stable-identity store migration (decision stable-identity-design-v2) against this store file; the migration runner ` +
        `reports the exact command, takes a VACUUM INTO backup first, and bumps user_version last. Nothing was written.`
    );
    this.name = 'SchemaMigrationRequiredError';
    this.found = found;
    this.supported = supported;
  }
}

/** Run-protocol exit as recorded by agent_exit / consumed by run_signal (§5.2). */
export interface RecordedExit {
  signal: string;
  payload?: Record<string, unknown>;
  phase_id?: string;
  agent_role?: string;
  at: string;
}

const ACTIVE_STATES = ['running', 'completing', 'awaiting_merge_gate', 'halted'];

// ---------------------------------------------------------------------------
// AC8: catalog status + bootstrap + dedup enqueue (run r-ea9e, phase 3)
// ---------------------------------------------------------------------------

const CATALOG_DAY_MS = 86_400_000;

/**
 * Pure function: reports whether a models-catalog reference_material record is
 * present and/or stale against the tunable threshold.
 *
 * Staleness is STRICT GREATER (age > threshold), mirroring the existing
 * §3.2.5 refresh_reference lane convention in tools.ts (sourceAge > threshold).
 * At EXACTLY thresholdDays elapsed the catalog is FRESH; one day past → STALE.
 *
 * @param record  the catalog reference_material record, or null when absent.
 * @param nowISO  ISO timestamp for "now" (injectable for testing).
 * @param thresholdDays  models_catalog.staleness_days from config.
 */
export function catalogStatus(
  record: unknown,
  nowISO: string,
  thresholdDays: number
): { present: boolean; stale: boolean; staleDate: string | null } {
  if (!record) return { present: false, stale: false, staleDate: null };
  const anchor = (record as { updated_at: string }).updated_at;
  const age = Math.floor((Date.parse(nowISO) - Date.parse(anchor)) / CATALOG_DAY_MS);
  const staleDate = new Date(Date.parse(anchor) + thresholdDays * CATALOG_DAY_MS).toISOString();
  return { present: true, stale: age > thresholdDays, staleDate };
}

/**
 * Board 39d6462d activity feed: the "title-or-slug clipped" the record is
 * shown under on the Queue tab's activity section. Most types carry `title`;
 * feature_article also carries `slug` but title wins when both exist; todo
 * carries neither and falls back to its first text line. Clipped to 80
 * chars — the same clip the card titles use (viewmodel.ts).
 */
function activityTitleOf(record: DurableRecord): string {
  const r = record as unknown as { title?: string; slug?: string; text?: string; id: string };
  const raw = r.title ?? r.slug ?? r.text?.split('\n')[0] ?? r.id;
  return raw.slice(0, 80);
}

function deepReplaceString(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) return value.map((v) => deepReplaceString(v, from, to));
  if (value && typeof value === 'object') {
    // Remap object KEYS as well as values (audit finding 11/43): path-keyed maps
    // like feature_article.file_baselines are keyed by repo-relative path, so a
    // rename that only rewrote values left the baseline keyed by the OLD path —
    // the read-time drift check then abstained forever. Exact-match, mirroring
    // the string-value branch.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k === from ? to : k, deepReplaceString(v, from, to)])
    );
  }
  return value;
}

// §3.4: rank_terms are plain keywords — an array of single terms with a
// per-term length cap; a keyword array cannot smuggle in a freeform question.
// One definition of the rank-terms cap (invariant 1): the query schema enforces
// it, and callers building rank_terms (the TUI search) clamp to it so they never
// hand the store an over-long list that throws at parse (audit finding 9/43).
export const MAX_RANK_TERMS = 16;
export const rankTerms = z
  .array(z.string().regex(/^\S{1,64}$/, 'rank_terms must be single keywords (no whitespace, ≤64 chars)'))
  .max(MAX_RANK_TERMS);

// One definition of the §3.4 default cap (invariant 1), for the same reason as
// MAX_RANK_TERMS: it was written literally in BOTH query() here and
// MountedStores.query, and the tool layer now has to report the cap it actually
// applied (knowledgeQueryResult) — a third literal would have been a third place
// to drift. A caller that omits cap gets this many records and, at the tool
// boundary, is TOLD so.
export const DEFAULT_QUERY_CAP = 20;

/**
 * Options every in-place write shares ([stable-identity-design-v2]).
 *
 * `expected_version` is the CAS token that replaces the accidental
 * UUID-as-token of the supersede era: UPDATE ... WHERE id = ? AND version = ?.
 * It provides NO accidental idempotency — a replay on an already-consumed
 * version is a stale caller and is refused.
 *
 * `resolves` names the maintenance items this write CLAIMS to close; they are
 * drained inside the write's own transaction, and a refused claim rolls the
 * whole write back.
 */
export interface RecordWriteOptions {
  expected_version?: number;
  resolves?: string[];
}

export interface QueryOptions {
  types?: string[];
  stack_tags?: string[];
  file_keys?: string[];
  rank_terms?: string[];
  cap?: number;
  match_all?: boolean;
  /** Filter by todo body source ('user' | 'system') BEFORE the cap (finding 38/43). */
  source?: string;
  /** ABSENCE QUERY floor (board a577a69d) — see SterlingStore.countAboveScore for the scale (`-bm25`, higher is more relevant). Not itself a query() filter: query()'s returned window is unaffected by it. */
  min_score?: number;
}

// The store surface the §10 tool layer drives — exactly the methods SterlingTools
// calls, no more. Both SterlingStore (single project store) and MountedStores
// (project + mounted domains) satisfy it, so the tools are agnostic to whether
// domain stores are mounted. Derived via Pick so the signatures never drift.
export type ToolStore = Pick<
  SterlingStore,
  | 'create'
  // The atomic, single-definition dedup path every maintenance item now takes
  // (board 2ded3b4b). boardAdd routes system-source todos through it.
  | 'enqueueSystemTodo'
  | 'query'
  | 'count'
  // knowledge_query's min_score ABSENCE QUERY (board a577a69d) — the
  // uncapped, full-match-set threshold count beside query()'s own window.
  | 'countAboveScore'
  | 'get'
  // knowledge_get resolves 8-char id PREFIXES through this index (decision
  // 27f148c2) — the citation format the whole repo writes, which get() alone
  // cannot serve because it matches a full id only.
  | 'recordIdIndex'
  // knowledge_create resolves an exact slug through this to REFUSE a second
  // feature_article under a slug that already exists (decision 3db7095f built it
  // for H19's one-hop pointers and noted "a second consumer does not exist yet"
  // — this is that second consumer). Deterministic, so the refusal can never be
  // a ranking artefact.
  | 'articlesBySlug'
  // knowledge_create's cross-type slug uniqueness + knowledge_get's slug
  // resolution (board 1e639f32) — the type-agnostic sibling of articlesBySlug.
  | 'recordsBySlug'
  // knowledge_get's dead-slug fallthrough ONLY (decision df361a0f) — the
  // superseded-only counterpart of recordsBySlug, consulted after both
  // live-slug and id-prefix resolution fail.
  | 'supersededRecordsBySlug'
  // knowledge_get's terminus disclosure (decision de1a7329) — the pinned
  // record stays version-pinned; this is the only way the tool layer learns
  // where a superseded record's chain currently ends.
  | 'resolveTerminus'
  | 'supersede'
  // The generalized in-place write triad + its version reader (stable-identity
  // S3, the call sites promised by S2's note): knowledge_update/edit/append all
  // land through updateRecord, and knowledge_get's `version` parameter reads
  // archived snapshots through getRecordVersion.
  | 'updateRecord'
  | 'editRecordField'
  | 'appendRecordField'
  | 'getRecordVersion'
  // knowledge_get's legacy_resolution + the write tools' historical-id refusal
  // (stable-identity S3) resolve dead ids through this index.
  | 'recordAliases'
  | 'updateTodo'
  | 'retireInFavorOf'
  | 'remove'
  // board_remove/maintenance_remove distinguish 'already removed' from 'never
  // existed' through the drain-log trace (board 97d773ef).
  | 'drainLogEntry'
  | 'addLink'
  | 'getRun'
  | 'casTransition'
  | 'casTransitionMerge'
  | 'recordPendingExit'
  | 'getPendingExit'
  | 'recordCheckSkipped'
  | 'appendRunEscalation'
  | 'writeHandoff'
  | 'readHandoffs'
  // knowledge_split's multi-record write (children + parent supersession)
  // needs one atomic boundary spanning several store calls (decision
  // compaction-tooling-windowed-read-plus-split) — see withTransaction above.
  | 'withTransaction'
>;

export class SterlingStore {
  private db: DatabaseSync;

  /**
   * Set ONLY when an existing, non-empty store below SUPPORTED_SCHEMA_VERSION
   * was opened ([stable-identity-design-v2]): the connection is read-only and
   * assertWritable() refuses every write naming the required migration.
   * undefined = a normal, writable store at the supported version.
   */
  private legacySchemaVersion: number | undefined;

  /**
   * PRAGMA user_version as of the moment this handle finished opening (board
   * d5942fa0 gap (b) — the LIVE write guard, extending the open-time guard
   * above to a store that stays open across a migration). undefined ONLY
   * during the brief window inside the constructor itself: assertLiveSchemaVersion
   * no-ops then, because the open-time guard already owns that window and the
   * fresh-store stamp-forward transaction below would otherwise be comparing
   * against a baseline it hasn't captured yet. Every public write re-reads
   * PRAGMA user_version against this captured baseline immediately before
   * mutating; a mismatch means a SECOND process (MCP server or TUI) migrated
   * the file while this handle stayed open, and the write is refused with
   * nothing written — matching the open-time guard's loud-failure style.
   */
  private openedSchemaVersion: number | undefined;

  constructor(path: string) {
    this.db = new DatabaseSync(path);

    // Schema-version guard — checked BEFORE journal_mode/foreign_keys/DDL land
    // (stable-identity design-v2 / 2176748e; fixer-mode F1): this ordering
    // guarantees that a too-new store is refused with NOTHING touched — not
    // even a WAL journal-mode header rewrite or the -wal/-shm sidecar files a
    // refusal AFTER `PRAGMA journal_mode=WAL` would have persistently
    // materialized on a non-WAL too-new db. `busy_timeout` is connection-local
    // and writes nothing to the db file, so it is safe to set first for
    // contention safety on the read below without weakening that guarantee.
    this.db.exec('PRAGMA busy_timeout=5000');
    const foundSchemaVersion = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (foundSchemaVersion > SUPPORTED_SCHEMA_VERSION) {
      this.db.close();
      throw new UnsupportedSchemaVersionError(foundSchemaVersion, SUPPORTED_SCHEMA_VERSION);
    }

    // S2 [stable-identity-design-v2]: distinguish a FRESH file (build it as v2)
    // from an EXISTING pre-v2 store (open READ-ONLY, refuse every write). The
    // probe is sqlite_master BEFORE the DDL runs — the only moment at which
    // "this file has no schema yet" is still observable — and it is a read, so
    // the refusal path still writes nothing.
    if (foundSchemaVersion < SUPPORTED_SCHEMA_VERSION) {
      const objects = (
        this.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number }
      ).n;
      if (objects > 0) {
        this.legacySchemaVersion = foundSchemaVersion;
        this.openedSchemaVersion = foundSchemaVersion;
        return; // read-only: no journal_mode, no DDL, no stamp — nothing written
      }
    }

    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
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

    // Stamp the supported version onto a FRESH file (S2 [stable-identity-
    // design-v2]: an existing pre-v2 store returned read-only above and never
    // reaches here), RE-READING user_version inside the same BEGIN IMMEDIATE
    // transaction that writes it (fixer-mode F2 —
    // closes a TOCTOU: the fast check above only skips work for a store
    // already known too new at open time; without a re-read here, a
    // concurrent migrator committing a newer version between that check and
    // this write would be silently overwritten back down to 1, turning the
    // guard's loud refusal into silent corruption). A re-read that is now
    // too-new throws from inside the transaction (rolling back any stamp
    // in progress); the catch below closes the connection before propagating,
    // matching the fast-path refusal's write-nothing/close-cleanly contract.
    try {
      this.tx(() => {
        const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        if (current > SUPPORTED_SCHEMA_VERSION) {
          throw new UnsupportedSchemaVersionError(current, SUPPORTED_SCHEMA_VERSION);
        }
        if (current < SUPPORTED_SCHEMA_VERSION) {
          this.db.exec(`PRAGMA user_version = ${SUPPORTED_SCHEMA_VERSION}`);
        }
      });
    } catch (e) {
      this.db.close();
      throw e;
    }

    // Capture the LIVE write guard's baseline now that the stamp-forward (if
    // any) has committed — reading fresh rather than assuming
    // SUPPORTED_SCHEMA_VERSION so this stays correct even if a future change
    // stamps something else.
    this.openedSchemaVersion = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  journalMode(): string {
    return (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  }

  // -------------------------------------------------------------------------
  // Schema v2 identity core [stable-identity-design-v2]
  // -------------------------------------------------------------------------

  /**
   * The ONE refusal for anything a pre-migration store cannot answer — one
   * definition, two callers below (writes, and the v2-only read surfaces).
   */
  private assertV2Surface(operation: string): void {
    if (this.legacySchemaVersion !== undefined) {
      throw new SchemaMigrationRequiredError(this.legacySchemaVersion, SUPPORTED_SCHEMA_VERSION, operation);
    }
  }

  /**
   * The LIVE write guard (board d5942fa0 gap (b), pin group B): re-reads
   * PRAGMA user_version fresh and compares it against the baseline captured
   * at open. A process that ALREADY HOLDS the store open when another process
   * (MCP server or TUI) migrates the file underneath it would otherwise keep
   * serving writes on a stale in-memory handle with no re-check until a full
   * restart — this closes that gap. Reads are deliberately NOT re-checked
   * (spec: read exemption) — only assertWritable's write callers reach this.
   *
   * No-ops while `openedSchemaVersion` is still undefined (mid-constructor):
   * the open-time guard above already owns that narrow window, and the
   * fresh-store stamp-forward transaction is itself a write that runs before
   * the baseline can be captured.
   */
  private assertLiveSchemaVersion(operation: string): void {
    if (this.openedSchemaVersion === undefined) return;
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current !== this.openedSchemaVersion) {
      throw new Error(
        `Live schema version drift: this store was opened at schema version ${this.openedSchemaVersion}, but the file is now at version ` +
          `${current} — another process (MCP server or TUI) migrated it while this session's handle stayed open. '${operation}' and every ` +
          `other write are refused until this session is closed. EXIT AND RELAUNCH this session to reopen against the current schema. Nothing was written.`
      );
    }
  }

  /**
   * The refusal seam for a pre-migration store, extended to the live write
   * guard above. Called at the top of every public write and, as a backstop,
   * from tx() — reads stay allowed on purpose (AC3: read-only pre-migration;
   * live re-check exemption: pin group B).
   */
  private assertWritable(operation: string): void {
    this.assertV2Surface(operation);
    this.assertLiveSchemaVersion(operation);
  }

  /**
   * The DERIVED served status: the whole API-compatibility hinge of the v2
   * model. Nothing stores this — it is computed from (lifecycle, freshness) on
   * every read, so a caller that has always read `status` keeps working while
   * the store stops holding two versions of the same truth.
   */
  private static derivedStatus(lifecycle: Lifecycle, freshness: Freshness): string {
    if (lifecycle === 'retired') return 'superseded';
    return freshness === 'flagged_stale' ? 'flagged_stale' : 'active';
  }

  /**
   * Resolves the v2 identity trio from a caller's input, accepting BOTH
   * envelope shapes (write-side compatibility, pin S2-5b):
   *   * lifecycle/freshness given directly → used as given;
   *   * only the legacy `status` given → 'active' → live+fresh,
   *     'superseded' → retired+fresh, 'flagged_stale' → live+flagged_stale.
   * An out-of-enum lifecycle/freshness is refused loudly rather than coerced.
   *
   * It then writes the DERIVED status/superseded_by back onto the candidate,
   * because the schemas registry still declares those two envelope fields (see
   * envelope.ts) — a new-shape record must satisfy the same validator every
   * legacy caller does, and the stored body drops them again afterwards.
   */
  private static resolveIdentity(
    raw: Record<string, unknown>,
    defaults: { lifecycle: Lifecycle; freshness: Freshness; version: number }
  ): { input: Record<string, unknown>; lifecycle: Lifecycle; freshness: Freshness; version: number } {
    const input = { ...raw };
    const readEnum = <T extends string>(field: string, allowed: readonly T[]): T | undefined => {
      const value = input[field];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
        throw new Error(`invalid ${field} '${String(value)}' — expected one of ${allowed.join(' | ')} (stable-identity-design-v2)`);
      }
      return value as T;
    };
    let lifecycle = readEnum<Lifecycle>('lifecycle', LIFECYCLE_VALUES);
    let freshness = readEnum<Freshness>('freshness', FRESHNESS_VALUES);
    if (lifecycle === undefined || freshness === undefined) {
      const status = typeof input.status === 'string' ? input.status : undefined;
      if (status === 'superseded') {
        lifecycle ??= 'retired';
        freshness ??= 'fresh';
      } else if (status === 'flagged_stale') {
        lifecycle ??= 'live';
        freshness ??= 'flagged_stale';
      } else if (status === 'active') {
        lifecycle ??= 'live';
        freshness ??= 'fresh';
      } else {
        lifecycle ??= defaults.lifecycle;
        freshness ??= defaults.freshness;
      }
    }
    const rawVersion = input.version;
    let version = defaults.version;
    if (typeof rawVersion === 'number') {
      if (!Number.isInteger(rawVersion) || rawVersion < 1) {
        throw new Error(`invalid version ${rawVersion} — version is a positive integer (stable-identity-design-v2)`);
      }
      version = rawVersion;
    }
    input.lifecycle = lifecycle;
    input.freshness = freshness;
    input.version = version;
    input.status = SterlingStore.derivedStatus(lifecycle, freshness);
    if (input.superseded_by === undefined) input.superseded_by = null;
    return { input, lifecycle, freshness, version };
  }

  /**
   * The identity normalization every write-side caller shares, exposed for the
   * ONE consumer that validates BEFORE it reaches a store: MountedStores, which
   * routes on the validated record's `scope` and so must run validateRecord
   * itself (invariant 1 — this is the single definition, never a second copy of
   * the lifecycle→status derivation). Without it a lifecycle-only envelope that
   * SterlingStore.create accepts was rejected through the mounted surface,
   * because the schemas registry still declares status/superseded_by.
   * Idempotent: normalizing an already-normalized envelope changes nothing, so
   * the store's own resolveIdentity re-run downstream is a no-op.
   */
  static normalizeIdentityEnvelope(raw: unknown): Record<string, unknown> {
    return SterlingStore.resolveIdentity(raw as Record<string, unknown>, {
      lifecycle: 'live',
      freshness: 'fresh',
      version: 1,
    }).input;
  }

  /**
   * The body actually persisted: lifecycle/freshness/version are the stored
   * truth, status/superseded_by are dropped because they are derived at read.
   * A pre-v2 body (no lifecycle) passes through untouched, so a legacy store
   * read through this code path is never rewritten in shape.
   */
  private static storableBody(record: Record<string, unknown>): Record<string, unknown> {
    if (typeof record.lifecycle !== 'string') return record;
    const body: Record<string, unknown> = { ...record };
    delete body.status;
    delete body.superseded_by;
    return body;
  }

  /**
   * Re-attaches everything derived at read: the SERVED status/superseded_by,
   * and links[] MATERIALIZED from record_relations (the authoritative edge
   * home). Batched — one relations query for a whole result set, plus one more
   * for the successor of any retired record in it — so a capped query() costs
   * two extra reads rather than 2N.
   *
   * A pre-v2 body carries no `lifecycle` and is passed through verbatim: that
   * is what keeps a pre-migration store READABLE (AC3) with no branch at every
   * call site.
   */
  private hydrateAll(records: DurableRecord[]): DurableRecord[] {
    const v2 = records.filter((r) => typeof (r as unknown as { lifecycle?: unknown }).lifecycle === 'string');
    if (!v2.length) return records;

    const ids = [...new Set(v2.map((r) => r.id))];
    const linkRows = this.db
      .prepare(
        `SELECT source_id, rel, target_id FROM record_relations WHERE source_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`
      )
      .all(...ids) as { source_id: string; rel: string; target_id: string }[];
    const bySource = new Map<string, { rel: string; target_id: string }[]>();
    for (const row of linkRows) {
      const list = bySource.get(row.source_id) ?? [];
      list.push({ rel: row.rel, target_id: row.target_id });
      bySource.set(row.source_id, list);
    }

    const retiredIds = v2
      .filter((r) => (r as unknown as { lifecycle?: string }).lifecycle === 'retired')
      .map((r) => r.id);
    const successor = new Map<string, string>();
    if (retiredIds.length) {
      const rows = this.db
        .prepare(
          `SELECT source_id, target_id FROM record_relations
            WHERE rel = 'supersedes' AND target_id IN (${retiredIds.map(() => '?').join(',')}) ORDER BY rowid`
        )
        .all(...retiredIds) as { source_id: string; target_id: string }[];
      for (const row of rows) {
        if (!successor.has(row.target_id)) successor.set(row.target_id, row.source_id);
      }
    }

    return records.map((record) => {
      const meta = record as unknown as { lifecycle?: string; freshness?: string };
      if (typeof meta.lifecycle !== 'string') return record;
      const lifecycle = meta.lifecycle as Lifecycle;
      const freshness = (meta.freshness === 'flagged_stale' ? 'flagged_stale' : 'fresh') as Freshness;
      return {
        ...record,
        links: bySource.get(record.id) ?? [],
        status: SterlingStore.derivedStatus(lifecycle, freshness),
        superseded_by: lifecycle === 'retired' ? successor.get(record.id) ?? null : null,
      } as DurableRecord;
    });
  }

  /** The server-owned identity columns of a live row — the CAS + lifecycle source. */
  private identityOf(id: string): { version: number; lifecycle: Lifecycle; freshness: Freshness; body: string } | undefined {
    const row = this.db.prepare('SELECT version, lifecycle, freshness, body FROM records WHERE id = ?').get(id) as
      | { version: number; lifecycle: string; freshness: string; body: string }
      | undefined;
    if (!row) return undefined;
    return {
      version: row.version,
      lifecycle: row.lifecycle === 'retired' ? 'retired' : 'live',
      freshness: row.freshness === 'flagged_stale' ? 'flagged_stale' : 'fresh',
      body: row.body,
    };
  }

  /** Typed edge write — record_relations is the authoritative home (contract 6). */
  private insertRelation(sourceId: string, rel: string, targetId: string, at: string): void {
    if (sourceId === targetId) {
      throw new Error(
        `relation '${rel}' from '${sourceId}' to itself is a self-cycle in the relation graph — refused (stable-identity-design-v2)`
      );
    }
    this.db
      .prepare('INSERT OR IGNORE INTO record_relations (source_id, rel, target_id, created_at) VALUES (?, ?, ?, ?)')
      .run(sourceId, rel, targetId, at);
  }

  /** The one validated write path. Unregistered type or malformed record throws; nothing is written.
   *
   *  NOTE (S3 boundary): a caller-supplied `version` is still honored here (the
   *  legacy feature_article field, and the pin fixtures that pass version: 1).
   *  S3 STRIPS it — version becomes server-owned at every surface — so nothing
   *  new should start relying on setting it. */
  create(input: unknown): DurableRecord {
    this.assertWritable('create');
    const prepared = SterlingStore.resolveIdentity(input as Record<string, unknown>, {
      lifecycle: 'live',
      freshness: 'fresh',
      version: 1,
    });
    // A record cannot be BORN RETIRED. lifecycle 'retired' with no successor is
    // a record that default queries hide, in-place writes refuse ("goes to the
    // live successor"), and supersede/retire refuse ("one successor maximum") —
    // unreachable by every path that could revive it. Retirement is a lifecycle
    // TRANSITION, owned by supersede/retireInFavorOf (contract 5).
    // The legacy insert shape stays open: a pre-v2 body carrying
    // status:'superseded' + superseded_by (fixtures, imports, and the S4
    // migration's re-inserts) names its successor, so it is retired WITH a
    // forward pointer and insertRecord materializes the supersedes relation.
    if (prepared.lifecycle === 'retired' && !prepared.input.superseded_by) {
      throw new Error(
        `create: lifecycle 'retired' cannot be requested at creation without a successor — such a record is born dead ` +
          `(hidden from queries, refused by in-place writes, and unsupersedable: one successor maximum is already spent). ` +
          `Retirement happens ONLY through supersede/retireInFavorOf. Nothing was written.`
      );
    }
    const record = validateRecord(prepared.input);
    this.tx(() => {
      this.insertRecord(record);
      this.logActivity('created', record, record.created_at);
    });
    // The echo goes through the SAME derivation get() serves (hydrate +
    // derived relied_by), so a caller can never see a write echo that differs
    // from the record it is about to read back.
    return this.withDerivedReliedBy(
      this.hydrateAll([SterlingStore.storableBody(record as unknown as Record<string, unknown>) as DurableRecord])[0]
    );
  }

  /**
   * The full record archived at (id, version) — a permanent, append-only
   * snapshot from record_versions, returned exactly as it was stored (no
   * derivation), so repeated reads of one version are byte-identical forever
   * (pin S2-2c). A version that was never archived resolves to undefined —
   * never fabricated.
   *
   * A V2-ONLY SURFACE: record_versions does not exist on a pre-migration store,
   * so this refuses loudly naming the migration (P5) instead of letting a raw
   * SQLite "no such table: record_versions" escape. Reads that a pre-v2 store
   * CAN answer stay allowed (AC3) — version history simply is not one of them.
   */
  getRecordVersion(id: string, version: number): Record<string, unknown> | undefined {
    this.assertV2Surface('getRecordVersion');
    const row = this.db
      .prepare('SELECT body FROM record_versions WHERE record_id = ? AND version = ?')
      .get(id, version) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Record<string, unknown>) : undefined;
  }

  /**
   * The dead-id INDEX, whole ([stable-identity-design-v2] contract 3): every
   * record_aliases row as (historical_id, canonical_id, archived_version). The
   * shape mirrors recordIdIndex — no body fetch, the full set, so the id
   * resolution ladder above the store can match an exact historical id AND a
   * citation PREFIX of one in the same pass it already makes over live ids.
   *
   * READ-ONLY and empty-tolerant by design: nothing writes to this table after
   * the migration, and a PRE-MIGRATION store (where the table does not exist)
   * returns [] rather than refusing — a legacy store is readable (AC3), and it
   * has no historical ids to resolve because nothing has been collapsed yet.
   */
  recordAliases(): { historical_id: string; canonical_id: string; archived_version: number }[] {
    if (this.legacySchemaVersion !== undefined) return [];
    return this.db
      .prepare('SELECT historical_id, canonical_id, archived_version FROM record_aliases ORDER BY rowid')
      .all() as { historical_id: string; canonical_id: string; archived_version: number }[];
  }

  /**
   * knowledge_update-shaped IN-PLACE write, generalized from updateTodo to
   * EVERY record type (contract 2). `patch` is the FULL merged candidate (old
   * record + the caller's changes), mirroring supersede/updateTodo's existing
   * convention: this method validates and persists, the layer above decides
   * which fields may change.
   *
   * The id, type and created_at are pinned to the stored record — an in-place
   * write can never re-mint identity, which is the entire point of stable
   * identity. lifecycle is likewise preserved: retirement happens ONLY through
   * supersede/retireInFavorOf.
   */
  updateRecord(id: string, patch: unknown, opts: RecordWriteOptions = {}): DurableRecord {
    return this.applyInPlace('updateRecord', id, () => ({ ...(patch as Record<string, unknown>) }), opts);
  }

  /**
   * knowledge_edit-shaped write: replace ONE passage inside a long string
   * field without retransmitting it. `find` must match EXACTLY ONCE — zero and
   * multiple matches are both refused NAMING THE COUNT, with nothing written,
   * because a blind replace inside a field too large to read is an
   * unreviewable write.
   */
  editRecordField(id: string, field: string, find: string, replace: string, opts: RecordWriteOptions = {}): DurableRecord {
    if (find === '') throw new Error(`editRecordField: 'find' is empty — an empty find matches everywhere and nowhere; nothing was written`);
    return this.applyInPlace('editRecordField', id, (current) => {
      const value = (current as unknown as Record<string, unknown>)[field];
      if (typeof value !== 'string') {
        throw new Error(
          `editRecordField: field '${field}' on ${current.type} '${id}' is ${value === undefined ? 'not set' : `a ${Array.isArray(value) ? 'array' : typeof value}`}, not a string — ` +
            `an in-place passage replace applies to string fields only (use appendRecordField for arrays). Nothing was written.`
        );
      }
      const matches = value.split(find).length - 1;
      if (matches !== 1) {
        throw new Error(
          `editRecordField: 'find' matched ${matches} time(s) in field '${field}' of record '${id}' — exactly one match is required ` +
            `(${matches === 0 ? 'no match: check whitespace and the exact passage' : `${matches} matches: extend 'find' until it is unique`}). Nothing was written.`
        );
      }
      return { ...(current as unknown as Record<string, unknown>), [field]: value.split(find).join(replace) };
    }, opts);
  }

  /**
   * knowledge_append-shaped write: grow an ARRAY field in place (history,
   * files, current_ac, …) without retransmitting the existing entries. One
   * transaction, one version bump, prior array archived.
   */
  appendRecordField(id: string, field: string, entry: unknown, opts: RecordWriteOptions = {}): DurableRecord {
    return this.applyInPlace('appendRecordField', id, (current) => {
      const value = (current as unknown as Record<string, unknown>)[field];
      if (value !== undefined && value !== null && !Array.isArray(value)) {
        throw new Error(
          `appendRecordField: field '${field}' on ${current.type} '${id}' is a ${typeof value}, not an array — ` +
            `append grows array fields only (use editRecordField for a string passage). Nothing was written.`
        );
      }
      const existing = Array.isArray(value) ? value : [];
      return { ...(current as unknown as Record<string, unknown>), [field]: [...existing, entry] };
    }, opts);
  }

  /**
   * THE in-place write core shared by updateRecord / editRecordField /
   * appendRecordField / updateTodo / renameFileKey / the enqueueSystemTodo
   * text-update branch (contracts 2-4, 7):
   *
   *  1. resolve the live record + its server-owned identity columns;
   *  2. CAS on expected_version when supplied — a stale token refuses naming
   *     BOTH versions and writes nothing, not even a snapshot row;
   *  3. archive the FULL prior body into record_versions (append-only);
   *  4. UPDATE ... WHERE id = ? AND version = ? — the real CAS, kept as a
   *     backstop now that step 1 reads under the write lock;
   *  5. rebuild the join indexes and REPLACE the single records_fts row, so an
   *     archived version's text can never rank (contract 1/7);
   *  6. drain any claimed `resolves` items INSIDE the same transaction — a
   *     refused claim rolls the whole write back (contract 4).
   *
   * EVERY step, step 1 included, runs inside ONE transaction. BEGIN IMMEDIATE
   * takes the write lock before the identity read, so no committed concurrent
   * write can land between the CAS check and the snapshot INSERT. Reading
   * outside the transaction cost two things: a CAS loser died on the
   * record_versions (record_id, version) primary key with a raw constraint
   * error instead of the pinned refusal naming both versions, and the body it
   * archived could be a stale generation of the record.
   *
   * `internal.allowRetired` is for the ONE path that legitimately rewrites a
   * tombstone: renameFileKey, whose contract is that a move orphans no owning
   * record's paths, retired ones included. It is deliberately not reachable
   * from the public triad — a content write still goes to the live successor.
   */
  private applyInPlace(
    op: string,
    id: string,
    buildPatch: (current: DurableRecord) => Record<string, unknown>,
    opts: RecordWriteOptions,
    internal: { allowRetired?: boolean } = {}
  ): DurableRecord {
    this.assertWritable(op);
    let served!: DurableRecord;
    this.tx(() => {
      const current = this.get(id);
      if (!current) throw new Error(`${op}: no record '${id}'`);
      const identity = this.identityOf(id);
      if (!identity) throw new Error(`${op}: no record '${id}'`);
      if (identity.lifecycle === 'retired' && !internal.allowRetired) {
        throw new Error(
          `${op}: record '${id}' is retired (served status 'superseded') — an in-place write goes to the live successor, never to a retired record`
        );
      }
      if (opts.expected_version !== undefined && opts.expected_version !== identity.version) {
        throw new Error(
          `${op}: stale expected_version — the caller supplied expected_version ${opts.expected_version} but record '${id}' is at version ` +
            `${identity.version}. Nothing was written; re-read the record and retry against version ${identity.version}.`
        );
      }

      const candidate = buildPatch(current);
      // Identity is server-owned: pin it to the stored record rather than
      // trusting a caller's (possibly stale) copy.
      candidate.id = id;
      candidate.type = current.type;
      candidate.created_at = current.created_at;
      // lifecycle never moves through this path. freshness may: an explicit
      // freshness wins, a legacy status:'flagged_stale' is honored, and anything
      // else PRESERVES the stored value — so a routine content update carrying a
      // legacy status:'active' can never silently un-flag a stale record.
      const freshness: Freshness =
        candidate.freshness === 'fresh' || candidate.freshness === 'flagged_stale'
          ? candidate.freshness
          : candidate.status === 'flagged_stale'
            ? 'flagged_stale'
            : identity.freshness;
      // A live record has no successor. A retired one (allowRetired path) KEEPS
      // the one it has: the served superseded_by is derived from the inbound
      // supersedes relation, and the schema refines status 'superseded' to
      // require it, so nulling it here would both lie and fail validation.
      const supersededBy = identity.lifecycle === 'retired' ? current.superseded_by ?? null : null;
      const nextVersion = identity.version + 1;
      const prepared = SterlingStore.resolveIdentity(candidate, {
        lifecycle: identity.lifecycle,
        freshness,
        version: nextVersion,
      });
      prepared.input.lifecycle = identity.lifecycle;
      prepared.input.freshness = freshness;
      prepared.input.version = nextVersion;
      prepared.input.status = SterlingStore.derivedStatus(identity.lifecycle, freshness);
      prepared.input.superseded_by = supersededBy;

      const validated = validateRecord(prepared.input) as DurableRecord;
      if (validated.type !== current.type) {
        throw new Error(`${op}: type mismatch ('${validated.type}' cannot replace '${current.type}' in place)`);
      }
      const entry = RECORD_TYPES[validated.type];
      const stored = SterlingStore.storableBody(validated as unknown as Record<string, unknown>);
      const now = new Date().toISOString();

      // The archived snapshot is the CURRENT stored body, verbatim — a full
      // record, never a diff. The (record_id, version) primary key makes a
      // double-archive of one version a loud constraint failure.
      this.db
        .prepare('INSERT INTO record_versions (record_id, version, archived_at, body) VALUES (?, ?, ?, ?)')
        .run(id, identity.version, now, identity.body);
      const res = this.db
        .prepare(
          `UPDATE records SET version = ?, status = ?, lifecycle = ?, freshness = ?, superseded_by = ?,
             updated_at = ?, body = ? WHERE id = ? AND version = ?`
        )
        .run(
          nextVersion,
          SterlingStore.derivedStatus(identity.lifecycle, freshness),
          identity.lifecycle,
          freshness,
          supersededBy,
          (stored.updated_at as string) ?? now,
          JSON.stringify(stored),
          id,
          identity.version
        );
      if (res.changes === 0) {
        throw new Error(
          `${op}: record '${id}' was concurrently written (it is no longer at version ${identity.version}) — re-read and retry`
        );
      }
      // stack_tags / file_keys may have changed: rebuild rather than diff.
      this.db.prepare('DELETE FROM record_stack_tags WHERE record_id = ?').run(id);
      for (const tag of new Set(validated.stack_tags)) {
        this.db.prepare('INSERT INTO record_stack_tags (record_id, tag) VALUES (?, ?)').run(id, tag);
      }
      this.db.prepare('DELETE FROM record_file_keys WHERE record_id = ?').run(id);
      for (const path of new Set(entry.fileKeys(stored))) {
        this.db.prepare('INSERT INTO record_file_keys (record_id, path) VALUES (?, ?)').run(id, path);
      }
      // Additive on relations: an edge named in the patch is ensured, never
      // silently dropped — removing an edge is knowledge_unlink's business, not
      // a side effect of a content update.
      for (const link of validated.links) this.insertRelation(id, link.rel, link.target_id, now);
      // EXACTLY ONE records_fts row per id, current version only (contract 7):
      // the row is replaced, so the prior generation's text stops ranking.
      this.db.prepare('UPDATE records_fts SET text = ? WHERE record_id = ?').run(entry.fts(stored), id);
      this.logActivity('updated', validated, (stored.updated_at as string) ?? now);
      if (opts.resolves?.length) this.drainResolves(op, opts.resolves, now);
      // The echo goes through the SAME derivation get() serves, so a write
      // echo can never disagree with the next read of the same record.
      served = this.withDerivedReliedBy(this.hydrateAll([stored as DurableRecord])[0]);
    });
    return served;
  }

  /**
   * The `resolves` drain (contract 4): the maintenance items a write CLAIMS to
   * close, closed inside the write's own transaction. An unresolvable or
   * already-closed claim throws, which rolls the ENTIRE write back — an
   * unclaimed write must never appear to succeed against a dead reference, and
   * a partial drain is worse than none.
   */
  private drainResolves(op: string, ids: string[], at: string): void {
    for (const claimed of new Set(ids)) {
      const item = this.get(claimed);
      if (!item) {
        throw new Error(
          `${op}: resolves claim '${claimed}' names no open item — it was never created, or it is already closed. ` +
            `The whole write rolled back (no version bump, no snapshot, no other item drained); re-read the queue and claim only open ids.`
        );
      }
      if (item.type !== 'todo') {
        throw new Error(
          `${op}: resolves claim '${claimed}' is a ${item.type}, not a maintenance item (todo) — the whole write rolled back`
        );
      }
      this.remove(claimed, at);
    }
  }

  /**
   * ATOMIC check-and-insert for a SYSTEM maintenance item — the ONE dedup
   * definition, replacing four hand-rolled copies (board 2ded3b4b).
   *
   * THE BUG THIS CLOSES IS TWO BUGS. Four producers minted maintenance items
   * (h7-file-touch, the read-time drift check in tools.ts, fs-remove, fs-move),
   * each with its own copy-pasted "does an open item already exist?" query
   * followed by a separate insert, and no uniqueness constraint anywhere:
   *
   *  (1) DUPLICATES. Two producers both read "no open item" before either insert
   *      committed, and both inserted — classic TOCTOU. A consuming project
   *      measured SEVEN byte-identical pairs created 2-3 MILLISECONDS apart, 52%
   *      of a 27-item queue. The cost was judgement rather than writes: the
   *      deep-queue threshold trips early, and anyone sizing a drain from the raw
   *      count sees double the work that exists.
   *  (2) SILENT LOSS — the worse half, and not in the report. All four checks
   *      keyed on (feature_link, system_reason) and OMITTED the file, so a second
   *      drifting file on the same article was suppressed. And because
   *      knowledge_update re-baselines EVERY owned file, reconciling the first
   *      file absorbed the second file's drift into a fresh baseline: the finding
   *      neither queued nor survived.
   *
   * The key is therefore (system_reason, feature_link, file_keys SET), and the
   * check runs inside the same BEGIN IMMEDIATE transaction as the insert, so a
   * concurrent caller blocks on the write lock and then SEES the committed row
   * instead of racing it.
   *
   * A MATCH WHOSE TEXT DIFFERS IS UPDATED, NOT DISCARDED. Same file, escalating
   * severity — edited today, deleted tomorrow, both reconcile_needed, the first
   * not yet drained — would otherwise be swallowed as a duplicate, losing the more
   * urgent fact. Since S2 that update goes through the versioned in-place core
   * like every other write ([stable-identity-design-v2]): todos DO carry the
   * universal version counter now, so the escalation bumps the version and
   * archives the prior text instead of overwriting the body invisibly (a bare
   * body UPDATE was invisible to expected_version, so a concurrent in-place
   * write could silently revert it, and the FTS row kept the old text).
   */
  enqueueSystemTodo(input: unknown): { record: DurableRecord; deduped: boolean; text_updated: boolean } {
    this.assertWritable('enqueueSystemTodo');
    const prepared = SterlingStore.resolveIdentity(input as Record<string, unknown>, {
      lifecycle: 'live',
      freshness: 'fresh',
      version: 1,
    });
    const candidate = validateRecord(prepared.input) as DurableRecord & {
      source?: string;
      system_reason?: string;
      file_keys?: string[];
      text?: string;
      feature_link?: string;
    };
    if (candidate.type !== 'todo' || candidate.source !== 'system') {
      throw new Error(`enqueueSystemTodo: expects a system-source todo, got ${candidate.type}/${candidate.source ?? 'no source'}`);
    }
    // A LINKLESS state_review HAS NO IDENTITY (board e939fd21, fixer round 2,
    // finding 6): the lane exception below keys it on {system_reason,
    // feature_link} ALONE — file_keys is deliberately excluded — so without a
    // feature_link the key degenerates to system_reason alone (files is always
    // []), and two DIFFERENT linkless mints sharing boilerplate text would
    // silently collapse, the second one's file_keys lost. Every real caller
    // (the feature-article state-honesty check) always supplies feature_link —
    // it IS the article being reviewed — so refusing here costs nothing today
    // and fails loud rather than silently merging two unrelated obligations.
    if (candidate.system_reason === 'state_review' && !candidate.feature_link) {
      throw new Error(
        `enqueueSystemTodo: a state_review item requires feature_link — this lane's identity IS the article, and without one two unrelated state_review mints could silently collapse. Pass feature_link: <article id>.`
      );
    }
    // AN ITEM WITH NEITHER A feature_link NOR file_keys HAS NO IDENTITY BEYOND
    // ITS TEXT, so the text joins the key for exactly those. Without this, two
    // unrelated obligations in a file-less lane (capture_owed, research_owed)
    // would collapse into one on their reason alone — trading the duplicate bug
    // for a worse one. With it, an exact duplicate still collapses while distinct
    // items stay distinct. A consequence worth naming: for those lanes the
    // text-differs-so-update branch can never fire, because a different text is
    // by definition a different item.
    // STATE_REVIEW LANE EXCEPTION (board e939fd21, per-file refinement 194f43e4
    // still stands for every OTHER lane): the call site chooses this lane's
    // file_keys as unverifiedPaths-else-first-3-owned, which SHIFTS from read to
    // read as the unverified set or the owned-files order changes, while the
    // semantic cause — "review this article's state honesty" — has not. Keying
    // on the moving file set re-mints a duplicate on every shift (four minted in
    // one measured session). state_review's identity is the article itself, so
    // this lane is keyed on {system_reason, feature_link} alone; it is a
    // lane-specific exception at this one choke point, not a universal key
    // change.
    const keyOf = (t: { system_reason?: string; feature_link?: string; file_keys?: string[]; text?: string }) => {
      const files = t.system_reason === 'state_review' ? [] : [...(t.file_keys ?? [])].sort();
      const identified = !!t.feature_link || files.length > 0;
      return JSON.stringify([t.system_reason ?? '', t.feature_link ?? '', files, identified ? '' : (t.text ?? '')]);
    };
    const wantKey = keyOf(candidate as unknown as { system_reason?: string; feature_link?: string; file_keys?: string[]; text?: string });

    // TEXT EQUIVALENCE FOR THE ESCALATION CHECK, state_review NORMALIZED (board
    // e939fd21, fixer round 3, finding 3): this lane's text embeds the exact
    // live-byte count ("... hold NNN bytes of code on disk"), a number that
    // shifts on every read whenever ANY file the article owns changes size for
    // a reason unrelated to the state-honesty verdict itself (an unrelated
    // sibling file mid-edit, say) — under plain string equality that re-fires
    // the escalation branch below on nearly every read, an unbounded
    // version-bump/snapshot/FTS-refresh churn (the same no-op-remint pathology
    // the stable-key fix above closed, moved from item COUNT to item VERSION).
    // NORMALIZE ONLY THAT ONE VOLATILE TOKEN, never every digit run (round-3
    // correction: a blanket \d+ strip also normalized digits INSIDE PATHS —
    // scripts/hooks/h10-*.mjs and h19-*.mjs collapsed to the same string, so a
    // genuine unverified-file-set move from h10 to h19 was wrongly read as "no
    // change" and silently swallowed). A GENUINE change — the state is fixed, a
    // different file's role goes unverified, the wording itself changes — still
    // differs after normalizing this one token and still escalates exactly as
    // before. Every OTHER lane keeps EXACT text equality (decision 194f43e4's
    // escalating-severity behavior, e.g. edited→deleted, is unaffected).
    const textsEquivalent = (a: string, b: string): boolean => {
      if (candidate.system_reason !== 'state_review') return a === b;
      const strip = (s: string) => s.replace(/\d+(?= bytes of code on disk)/g, '#');
      return strip(a) === strip(b);
    };

    let existing: (DurableRecord & { text?: string; file_keys?: string[] }) | undefined;
    let textUpdated = false;
    this.tx(() => {
      // The read happens INSIDE the write transaction — that is the whole point.
      // Scanning open todos is cheap: the queue is small by design, and a queue
      // large enough for this scan to matter is itself the finding.
      const rows = this.db.prepare("SELECT body FROM records WHERE type = 'todo' AND status != 'superseded'").all() as { body: string }[];
      for (const r of rows) {
        const t = JSON.parse(r.body) as DurableRecord & { source?: string; system_reason?: string; file_keys?: string[]; text?: string };
        if (t.source !== 'system') continue;
        if (keyOf(t as unknown as { system_reason?: string; feature_link?: string; file_keys?: string[]; text?: string }) !== wantKey) continue;
        existing = t;
        break;
      }
      if (!existing) {
        this.insertRecord(candidate);
        return;
      }
      // FILE_KEYS REFRESH IS INDEPENDENT OF THE TEXT-EQUALITY BRANCH (board
      // e939fd21, fixer round 3, finding 3b — hoisted OUT of the
      // textsEquivalent branch it used to live inside): a file_keys-only change
      // — the unverified set moves from one path to another while the rest of
      // the wording is untouched — must still refresh file_keys even when text
      // is (correctly) read as unchanged; gating the refresh on textChanged
      // meant a text-suppressed escalation ALSO suppressed the file_keys
      // refresh, so the surviving item could name a path forever after the
      // real debt had moved elsewhere. Compared as a SET: every other lane's
      // file_keys is already part of the match key, so a match there always
      // already carries the same set and this is a no-op — never a spurious
      // extra reindex.
      const priorFiles = [...((existing as unknown as { file_keys?: string[] }).file_keys ?? [])].sort();
      const nextFiles = [...(candidate.file_keys ?? [])].sort();
      const filesChanged = JSON.stringify(priorFiles) !== JSON.stringify(nextFiles);
      const textChanged = !textsEquivalent(existing.text ?? '', candidate.text ?? '');
      if (textChanged || filesChanged) {
        // The versioned core, joining THIS transaction (tx is reentrant): version
        // bump + prior snapshot + FTS refresh, none of which a bare body UPDATE did.
        existing = this.applyInPlace(
          'enqueueSystemTodo',
          existing.id,
          (cur) => ({
            ...(cur as unknown as Record<string, unknown>),
            updated_at: candidate.updated_at,
            ...(textChanged ? { text: candidate.text } : {}),
            ...(filesChanged ? { file_keys: candidate.file_keys } : {}),
          }),
          {}
        ) as DurableRecord & { text?: string; file_keys?: string[] };
        textUpdated = textChanged;
      }
    });
    // The stored bodies scanned above carry no status/superseded_by (they are
    // derived), so both return paths go through hydration before the caller
    // sees them ([stable-identity-design-v2]).
    return existing
      ? { record: this.hydrateAll([existing as DurableRecord])[0], deduped: true, text_updated: textUpdated }
      : {
          record: this.hydrateAll([SterlingStore.storableBody(candidate as unknown as Record<string, unknown>) as DurableRecord])[0],
          deduped: false,
          text_updated: false,
        };
  }

  get(id: string): DurableRecord | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE id = ?').get(id) as { body: string } | undefined;
    if (!row) return undefined;
    // hydrateAll re-attaches the DERIVED status/superseded_by and materializes
    // links[] from record_relations ([stable-identity-design-v2]).
    return this.withDerivedReliedBy(this.hydrateAll([JSON.parse(row.body) as DurableRecord])[0]);
  }

  /**
   * feature_article.dependencies.relied_by is DERIVED AT READ TIME (board
   * 9641e01b, the conductor's option (b)) from the union of every OTHER active
   * feature_article's relies_on naming this article's slug — not the stored
   * field. relies_on stays author-written; relied_by cannot drift because it is
   * no longer authored at all past this read. PROJECT-STORE SCOPE ONLY:
   * domain-mounted articles are out of scope for this derivation (each mounted
   * store derives its own; MountedStores does not cross-join relies_on across
   * stores) — the same store-locality choice articlesBySlug/knowledge_create's
   * slug-collision check already make.
   *
   * Never a hidden lie (constraint 2 of the board item): when the stored
   * relied_by differs from the derived set (as a sorted-deduped set — order and
   * duplicates in the stored array don't count as drift), the returned record
   * carries dependencies.relied_by_stored_stale: true alongside the derived
   * value actually served. The stored field is left untouched in the DB — this
   * derivation never writes.
   */
  private withDerivedReliedBy(record: DurableRecord, relations?: { slug: string; reliesOn: string[] }[]): DurableRecord {
    if (record.type !== 'feature_article') return record;
    const article = record as DurableRecord & {
      slug: string;
      dependencies: { relies_on: string[]; relied_by: string[] };
    };
    const derived = this.deriveReliedBy(article.slug, relations);
    const storedSorted = [...new Set(article.dependencies?.relied_by ?? [])].sort();
    const stale = JSON.stringify(storedSorted) !== JSON.stringify(derived);
    return {
      ...record,
      dependencies: {
        relies_on: article.dependencies?.relies_on ?? [],
        relied_by: derived,
        ...(stale ? { relied_by_stored_stale: true } : {}),
      },
    } as DurableRecord;
  }

  /**
   * Every active feature_article's slug + relies_on, in ONE scan — shared by
   * withDerivedReliedBy across a whole query() result so a capped list of N
   * articles costs one table scan, not N.
   */
  private activeArticleRelations(): { slug: string; reliesOn: string[] }[] {
    const rows = this.db
      .prepare(`SELECT body FROM records WHERE type = 'feature_article' AND status != 'superseded'`)
      .all() as { body: string }[];
    return rows.map((r) => {
      const rec = JSON.parse(r.body) as { slug?: string; dependencies?: { relies_on?: string[] } };
      return { slug: rec.slug ?? '', reliesOn: rec.dependencies?.relies_on ?? [] };
    });
  }

  /** Sorted, deduped slugs of every active article whose relies_on names `slug`. */
  private deriveReliedBy(slug: string, relations?: { slug: string; reliesOn: string[] }[]): string[] {
    const rels = relations ?? this.activeArticleRelations();
    const set = new Set<string>();
    for (const r of rels) {
      if (r.slug === slug) continue;
      if (r.reliesOn.includes(slug)) set.add(r.slug);
    }
    return [...set].sort();
  }

  /**
   * Every record id in this store at ANY status, tombstones included, with its
   * type — the resolution surface for id CITATIONS in tracked source
   * (check-record-citations). It exists because neither existing read serves
   * that need: query() deliberately excludes superseded records (AC4), yet
   * citing a superseded record is legitimate and common — a comment names the
   * decision that ORIGINALLY justified a design, and history is exactly what it
   * should cite — while get() resolves any status but only from a FULL id, and
   * citations in prose are 8-char prefixes. No body fetch, no JSON.parse: ids
   * and types only, so scanning the whole tree stays cheap.
   */
  recordIdIndex(): { id: string; type: string; status: string }[] {
    return this.db.prepare('SELECT id, type, status FROM records').all() as {
      id: string;
      type: string;
      status: string;
    }[];
  }

  /**
   * Every non-superseded feature_article carrying this EXACT slug, newest first.
   * A deterministic identity lookup, deliberately NOT a search (decision
   * 3db7095f). H19's one-hop pointerLine used to resolve sibling slugs through
   * query({rank_terms:[slug], cap:5}) and then look for an exact match among
   * those five, which reported LIVE articles as '(not in store)': bm25 ranks by
   * term frequency over the FTS blob, so a popular slug is cited more often in
   * OTHER articles' prose than in the article that owns it, and the owner falls
   * outside its own top-5 — measured against 'hooks-suite' at v46. Raising the
   * cap was rejected because the cause is the RANKING, not the number 5, and the
   * miss gets likelier as the store grows.
   *
   * Returns an ARRAY so the caller keeps applying its own working_tree exclusion.
   * More than one active record per slug is a store-integrity fault rather than a
   * normal state; it resolves newest-first here instead of arbitrarily, and is
   * not raised on this path because delivery must never fail (AC7) — an opaque
   * '(lookup failed)' would trade one false payload for another.
   */
  articlesBySlug(slug: string): DurableRecord[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM records
          WHERE type = 'feature_article' AND status != 'superseded' AND json_extract(body, '$.slug') = ?
          ORDER BY updated_at DESC`
      )
      .all(slug) as { body: string }[];
    const records = this.hydrateAll(rows.map((r) => JSON.parse(r.body) as DurableRecord));
    if (!records.length) return records;
    const relations = this.activeArticleRelations();
    return records.map((r) => this.withDerivedReliedBy(r, relations));
  }

  /**
   * Every non-superseded record of ANY type carrying this exact slug, newest
   * first (board 1e639f32 — decision/anti_pattern/research_finding gained the
   * stable handle feature_article and brief already had). The type-agnostic
   * sibling of articlesBySlug: it backs knowledge_create's cross-type slug
   * uniqueness and knowledge_get's slug resolution, both of which must see
   * EVERY slug-bearing record or a clash slips through. Excluding superseded
   * rows is the point — a slug names the CONCEPT, so resolving it serves the
   * live head while a version-pinned citation keeps using the id.
   */
  recordsBySlug(slug: string): DurableRecord[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM records
          WHERE status != 'superseded' AND json_extract(body, '$.slug') = ?
          ORDER BY updated_at DESC`
      )
      .all(slug) as { body: string }[];
    return this.withDerivedReliedByAll(rows.map((r) => JSON.parse(r.body) as DurableRecord));
  }

  /**
   * Every SUPERSEDED record carrying this exact slug, newest first — the
   * dead-slug counterpart of recordsBySlug (decision df361a0f, board 2b9f2f1a
   * part 3, 'supersede + disclose'). knowledge_get's dead-slug fallthrough
   * uses this ONLY after live-slug and id-prefix resolution both fail, so it
   * can never shadow a live record: a slug still carried by a non-superseded
   * row belongs to recordsBySlug, not here. The write surface never calls
   * this — a dead slug addresses no write handle, fix-forward goes to the
   * live head via recordsBySlug's own resolution.
   */
  supersededRecordsBySlug(slug: string): DurableRecord[] {
    // rowid DESC breaks ties within one supersede lineage: a chain built under a
    // fixed test clock (or any updates landing in the same instant) shares one
    // updated_at across every carrier, so updated_at alone cannot tell the
    // newest tombstone from the oldest — insertion order (rowid, monotonic and
    // never reused) can.
    const rows = this.db
      .prepare(
        `SELECT body FROM records
          WHERE status = 'superseded' AND json_extract(body, '$.slug') = ?
          ORDER BY updated_at DESC, rowid DESC`
      )
      .all(slug) as { body: string }[];
    return this.withDerivedReliedByAll(rows.map((r) => JSON.parse(r.body) as DurableRecord));
  }

  /**
   * Follows superseded_by from `id` to the chain end (decision de1a7329: ids
   * stay version-pinned — this DISCLOSES where the chain currently ends, it
   * never redirects the pinned record itself). A live (non-superseded)
   * record resolves to itself at hops:0. Unknown id -> null. Never throws
   * and never hangs on a malformed chain: a cycle or a chain deeper than the
   * 32-hop cap stops traversal and reports the LAST record reached (before
   * the revisit, or at the cap) with truncated:true — it never claims to be
   * the true, unreached terminus.
   */
  resolveTerminus(id: string): { id: string; status: string; hops: number; truncated?: boolean } | null {
    const MAX_HOPS = 32;
    const stmt = this.db.prepare('SELECT id, status, superseded_by FROM records WHERE id = ?');
    const row = stmt.get(id) as { id: string; status: string; superseded_by: string | null } | undefined;
    if (!row) return null;

    const visited = new Set<string>([row.id]);
    let current = row;
    let hops = 0;
    while (current.status === 'superseded' && current.superseded_by) {
      const next = stmt.get(current.superseded_by) as
        | { id: string; status: string; superseded_by: string | null }
        | undefined;
      if (!next || visited.has(next.id) || hops + 1 > MAX_HOPS) {
        return { id: current.id, status: current.status, hops, truncated: true };
      }
      visited.add(next.id);
      current = next;
      hops += 1;
    }
    return { id: current.id, status: current.status, hops };
  }

  /**
   * The §3.4 base filter (status + type + stack-tag + file-key join) shared
   * by query() and count() — everything EXCEPT the rank (FTS), ordering, and
   * cap. One definition so count() can never drift from what query() would
   * actually return.
   */
  private baseFilter(opts: QueryOptions): { where: string[]; params: (string | number)[]; fileKeys: string[] } {
    const params: (string | number)[] = [];
    // != superseded, not = active: flagged_stale research findings are still
    // served — only as "stale — re-verify" (§3.2.4); the tool layer attaches the flag.
    const where: string[] = ["r.status != 'superseded'"];
    if (opts.types?.length) {
      where.push(`r.type IN (${opts.types.map(() => '?').join(',')})`);
      params.push(...opts.types);
    }
    if (opts.stack_tags?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM record_stack_tags t WHERE t.record_id = r.id AND t.tag IN (${opts.stack_tags.map(() => '?').join(',')}))`
      );
      params.push(...opts.stack_tags);
    }
    const fileKeys = (opts.file_keys ?? []).map(normalizeRepoPath);
    if (fileKeys.length) {
      where.push(
        `EXISTS (SELECT 1 FROM record_file_keys k WHERE k.record_id = r.id AND k.path IN (${fileKeys.map(() => '?').join(',')}))`
      );
      params.push(...fileKeys);
    }
    // Source filter applied in the base filter (before cap/order) so a capped
    // query never drops matching items of the wanted source (audit finding 38/43).
    if (opts.source) {
      where.push("json_extract(r.body, '$.source') = ?");
      params.push(opts.source);
    }
    return { where, params, fileKeys };
  }

  /**
   * COUNT(*) over the §3.4 base filter — the number of records query() WOULD
   * return ignoring rank/cap (rank_terms is a no-op here). No body fetch, no
   * JSON.parse: the TUI Knowledge tree's collapsed category/source badges call
   * this every 1 Hz frame instead of fetching + parsing hundreds of bodies.
   */
  count(opts: QueryOptions = {}): number {
    const { where, params } = this.baseFilter(opts);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM records r WHERE ${where.join(' AND ')}`).get(...params) as { n: number };
    return row.n;
  }

  /**
   * ABSENCE QUERY (board a577a69d): "is anything ruled about X" needs a
   * usable "nothing", and a capped/ranked window can never establish one —
   * this counts over the FULL rank_terms match set (uncapped, never the
   * window query() returns) how many score at least `minScore`, using the
   * SAME base filter and match expression query() ranks by, so this can never
   * disagree with what a caller would see if it raised cap far enough.
   *
   * SCALE: SQLite FTS5's bm25() returns a value where LOWER (more negative) is
   * MORE relevant, and it is otherwise unbounded — the opposite of what a
   * caller reading "min_score" would expect. The score this thresholds is
   * `-bm25(records_fts)`: HIGHER is more relevant, a bare keyword match sits
   * near 0, and there is no fixed upper bound (a longer/rarer/more-repeated
   * match scores higher). `min_score` is a floor on `-bm25`, never on bm25
   * itself — knowledge_query's tool description names this scale so a caller
   * never has to reverse-engineer bm25's own sign convention.
   *
   * Requires rank_terms — a threshold on a filter with no ranking has nothing
   * to threshold, so this refuses loudly rather than silently answering 0
   * (P5): a caller reading above_threshold:0 must be able to trust it means
   * "nothing scored that high", not "nothing was rankable in the first place".
   */
  countAboveScore(opts: QueryOptions, minScore: number): number {
    const terms = rankTerms.parse(opts.rank_terms ?? []);
    if (!terms.length) {
      throw new Error('min_score requires rank_terms — there is no ranked score to threshold without them.');
    }
    const { where, params } = this.baseFilter(opts);
    const match = this.ftsMatchExpr(terms, opts.match_all);
    const sql = `SELECT COUNT(*) AS n FROM records r JOIN records_fts f ON f.record_id = r.id
      WHERE ${where.join(' AND ')} AND records_fts MATCH ? AND (-bm25(records_fts)) >= ?`;
    const row = this.db.prepare(sql).get(...params, match, minScore) as { n: number };
    return row.n;
  }

  /**
   * The FTS5 MATCH expression rank_terms compiles to — shared by query() and
   * countAboveScore() so the two can never rank two different match sets. A
   * trailing '*' marks an FTS5 prefix query ("stor*" matches "store") — the
   * star must sit OUTSIDE the quoted token to act as the prefix operator.
   */
  private ftsMatchExpr(terms: string[], matchAll: boolean | undefined): string {
    const joiner = matchAll ? ' AND ' : ' OR ';
    return terms.map((t) => (t.endsWith('*') && t.length > 1 ? `"${t.slice(0, -1).replace(/"/g, '""')}"*` : `"${t.replace(/"/g, '""')}"`)).join(joiner);
  }

  /** Retrieval discipline (§3.4): filter → file-key join → rank (bm25 or mechanical fallback) → cap. */
  query(opts: QueryOptions = {}): DurableRecord[] {
    const cap = opts.cap ?? DEFAULT_QUERY_CAP;
    const { where, params, fileKeys } = this.baseFilter(opts);

    if (opts.rank_terms !== undefined) {
      const terms = rankTerms.parse(opts.rank_terms);
      if (terms.length) {
        const match = this.ftsMatchExpr(terms, opts.match_all);
        const sql = `SELECT r.body FROM records r JOIN records_fts f ON f.record_id = r.id
          WHERE ${where.join(' AND ')} AND records_fts MATCH ?
          ORDER BY bm25(records_fts) ASC, r.updated_at DESC LIMIT ?`;
        const rows = this.db.prepare(sql).all(...params, match, cap) as { body: string }[];
        return this.withDerivedReliedByAll(rows.map((x) => JSON.parse(x.body) as DurableRecord));
      }
    }
    // Mechanical fallback rank (§3.4): file-key overlap count, then updated_at desc.
    const orderBy: string[] = [];
    const overlapParams: string[] = [];
    if (fileKeys.length) {
      orderBy.push(
        `(SELECT COUNT(*) FROM record_file_keys k2 WHERE k2.record_id = r.id AND k2.path IN (${fileKeys.map(() => '?').join(',')})) DESC`
      );
      overlapParams.push(...fileKeys);
    }
    orderBy.push('r.updated_at DESC');
    const sql = `SELECT r.body FROM records r WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy.join(', ')} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, ...overlapParams, cap) as { body: string }[];
    return this.withDerivedReliedByAll(rows.map((x) => JSON.parse(x.body) as DurableRecord));
  }

  /** query()'s two return paths share this: one relations scan for the whole
   *  result set (not one per feature_article row) before applying the derived
   *  relied_by to each. */
  private withDerivedReliedByAll(input: DurableRecord[]): DurableRecord[] {
    // v2 hydration first (derived status/superseded_by + materialized links) —
    // it applies to every type, where relied_by derivation is article-only.
    const records = this.hydrateAll(input);
    if (!records.some((r) => r.type === 'feature_article')) return records;
    const relations = this.activeArticleRelations();
    return records.map((r) => this.withDerivedReliedBy(r, relations));
  }

  /**
   * Versioned change (§3.2.3, §3.1 criterion 3): the new record supersedes the
   * old; the old is retained with status 'superseded' + superseded_by set.
   * This is the ONLY change path for immutable types (decision, §3.2.1).
   */
  supersede(oldId: string, newInput: unknown): DurableRecord {
    this.assertWritable('supersede');
    const oldRecord = this.get(oldId);
    if (!oldRecord) throw new Error(`supersede: no record '${oldId}'`);
    const oldIdentity = this.identityOf(oldId);
    // A flagged_stale research finding is superseded by re-verification — that is
    // the ADVERTISED remedy (retrieval tells the reader "re-verification supersedes
    // this finding"); only a terminal (already-retired) record is refused
    // (audit finding 13/43). The in-tx guard below closes the check-then-act race.
    // ONE SUCCESSOR MAX, across both paths ([stable-identity-design-v2]): the
    // lifecycle IS the single source of that constraint, so retireInFavorOf and
    // supersede can no longer each add a successor to the same record.
    if (oldIdentity?.lifecycle === 'retired' || oldRecord.status === 'superseded') {
      throw new Error(`supersede: record '${oldId}' is already superseded (retired) — one successor maximum`);
    }
    const candidate = { ...(newInput as Record<string, unknown>) };
    // A "new" record carrying the OLD id would be an edge from a node to
    // itself — a self-cycle in the relation graph, and (worse) an in-place
    // overwrite masquerading as supersession. Refused before anything is
    // validated or written ([stable-identity-design-v2] contract 5).
    if (candidate.id === oldId) {
      throw new Error(
        `supersede: the replacement carries the SAME id as '${oldId}' — that is a self-cycle in the relation graph, not a supersession. ` +
          `Use updateRecord for an in-place change, or mint a genuinely new id for a concept replacement.`
      );
    }
    const links = Array.isArray(candidate.links) ? [...(candidate.links as { rel: string; target_id: string }[])] : [];
    if (!links.some((l) => l.rel === 'supersedes' && l.target_id === oldId)) {
      links.push({ rel: 'supersedes', target_id: oldId });
    }
    candidate.links = links;
    const prepared = SterlingStore.resolveIdentity(candidate, { lifecycle: 'live', freshness: 'fresh', version: 1 });
    const newRecord = validateRecord(prepared.input);
    if (newRecord.type !== oldRecord.type) {
      throw new Error(`supersede: type mismatch ('${newRecord.type}' cannot supersede '${oldRecord.type}')`);
    }
    if (newRecord.type === 'feature_article' && oldRecord.type === 'feature_article' && newRecord.version <= oldRecord.version) {
      throw new Error(
        `supersede: feature_article version must increase (old v${oldRecord.version}, new v${newRecord.version})`
      );
    }
    const storedOld = SterlingStore.storableBody({
      ...(oldRecord as unknown as Record<string, unknown>),
      lifecycle: 'retired',
      updated_at: newRecord.updated_at,
    });
    this.tx(() => {
      // insertRecord writes the candidate's links into record_relations, so the
      // authoritative (new -> supersedes -> old) edge lands here (contract 6);
      // the served superseded_by on the old record materializes from it.
      this.insertRecord(newRecord);
      // Guard the UPDATE on the observed lifecycle INSIDE the BEGIN IMMEDIATE tx
      // (audit finding 29/43): the pre-tx read is check-then-act, so a
      // concurrent supersede (server + TUI on the shared WAL file) could
      // otherwise leave two successors. changes===0 → the row moved out from
      // under us → roll back loud (the inserted newRecord is undone).
      const res = this.db
        .prepare(
          `UPDATE records SET status = ?, superseded_by = ?, lifecycle = 'retired', updated_at = ?, body = ?
             WHERE id = ? AND lifecycle != 'retired'`
        )
        .run('superseded', newRecord.id, newRecord.updated_at, JSON.stringify(storedOld), oldId);
      if (res.changes === 0) {
        throw new Error(`supersede: record '${oldId}' was concurrently superseded — retry against the current version`);
      }
      this.logActivity('updated', newRecord, newRecord.updated_at);
    });
    return this.hydrateAll([SterlingStore.storableBody(newRecord as unknown as Record<string, unknown>) as DurableRecord])[0];
  }

  /**
   * IN-PLACE todo mutation (§3.2.7 board_update, work order 9a06b6aa) — the one
   * exception to "every change is a supersession". todo is deliberately NOT in
   * the immutable set (only decision is), and every board item is a DURABLE
   * record in the same store as knowledge, so the established change primitive
   * (supersede: mint a new id, retain the old) would rot every reference keyed
   * on the item's id (feature_link, H7/H10 maintenance items) on every edit. The
   * id, created_at, status and superseded_by stay exactly as they were; only the
   * caller's patched fields and updated_at change — same row, same identity.
   *
   * `newInput` is the FULL merged candidate (old record + patch), mirroring
   * supersede's own calling convention: this method validates and persists, the
   * tool layer decides which fields may be patched and builds the merge. A
   * terminal (superseded) record is refused, same as supersede/retireInFavorOf,
   * and the UPDATE is guarded on that status inside the transaction to close the
   * same concurrent-supersede race.
   */
  updateTodo(id: string, newInput: unknown, opts: RecordWriteOptions = {}): DurableRecord {
    const old = this.get(id);
    if (!old) throw new Error(`updateTodo: no record '${id}'`);
    if (old.type !== 'todo') throw new Error(`updateTodo: '${id}' is a ${old.type}, not a todo — board_update only mutates todos`);
    const candidate = { ...(newInput as Record<string, unknown>) };
    if (typeof candidate.type === 'string' && candidate.type !== 'todo') {
      throw new Error(`updateTodo: type mismatch ('${candidate.type}' is not 'todo')`);
    }
    // Since S2 this is the generalized in-place triad's todo entry point
    // ([stable-identity-design-v2]): same id, same lifecycle, but the universal
    // server-owned version counter now bumps and the prior body is archived,
    // exactly as it is for every other type. Todos still get no slug.
    return this.applyInPlace('updateTodo', id, () => candidate, opts);
  }

  /**
   * Promotion tombstone (§3.3 project→domain): retire a record IN FAVOR OF a
   * replacement that lives in ANOTHER store (the promoted copy in a domain
   * store). supersede can't cross stores and always inserts a same-store
   * replacement; this sets the existing record to superseded + superseded_by =
   * the cross-store id with NO new row. Provenance and inbound links survive;
   * default queries already hide superseded records, so it never double-serves.
   */
  /**
   * `verb` names what this retirement IS for the activity feed (board
   * 39d6462d): 'retired' for the genuine-duplicate path (knowledge_retire) and
   * 'promoted' for the project→domain copy's tombstone (knowledgePromote) — the
   * two existing callers, distinguished so a promotion reads as "promoted",
   * not as an unrelated-looking "retired". Defaults to 'retired' so the
   * pre-promotion caller (and any future one) keeps that meaning without
   * having to know the parameter exists.
   */
  retireInFavorOf(id: string, replacementId: string, at: string, verb: string = 'retired'): DurableRecord {
    this.assertWritable('retireInFavorOf');
    const record = this.get(id);
    if (!record) throw new Error(`retireInFavorOf: no record '${id}'`);
    const identity = this.identityOf(id);
    // Same relaxation + in-tx guard as supersede (audit findings 13/43 + 29/43):
    // only a terminal (already-retired) record is refused; the lifecycle guard
    // on the UPDATE closes the check-then-act race. ONE SUCCESSOR MAX holds
    // ACROSS BOTH PATHS — a record already superseded cannot also be retired in
    // favour of a second survivor ([stable-identity-design-v2]).
    if (identity?.lifecycle === 'retired' || record.status === 'superseded') {
      throw new Error(`retireInFavorOf: record '${id}' is already superseded (retired) — one successor maximum`);
    }
    // THE REPLACEMENT MUST BE ALIVE. Retiring A in favour of B and then B in
    // favour of A left both records retired, each forwarding to a dead one — a
    // supersession cycle where the reader is sent nowhere, which is exactly
    // what `in_favor_of` is required for in the first place (decision 9948475b).
    // A replacement this store cannot see is the PROMOTION shape (the survivor
    // is the copy in a domain store) and stays allowed: relations carry no
    // foreign key by design, and MountedStores has already resolved it.
    const replacement = this.identityOf(replacementId);
    if (replacement?.lifecycle === 'retired') {
      throw new Error(
        `retireInFavorOf: replacement '${replacementId}' is itself retired — retiring '${id}' in favour of it would leave both records ` +
          `dead and forward the reader to a tombstone (a supersession cycle). Name the LIVE survivor. Nothing was written.`
      );
    }
    const retired = { ...record, status: 'superseded' as const, superseded_by: replacementId, lifecycle: 'retired', updated_at: at };
    const stored = SterlingStore.storableBody(retired as unknown as Record<string, unknown>);
    this.tx(() => {
      const res = this.db
        .prepare(
          `UPDATE records SET status = ?, superseded_by = ?, lifecycle = 'retired', updated_at = ?, body = ?
             WHERE id = ? AND lifecycle != 'retired'`
        )
        .run('superseded', replacementId, at, JSON.stringify(stored), id);
      if (res.changes === 0) {
        throw new Error(`retireInFavorOf: record '${id}' was concurrently superseded — retry`);
      }
      // The relation is what makes the served superseded_by derivable, and it
      // is written by BOTH retirement paths — that is why retirement can only
      // happen here or in supersede (contract 5/6). The survivor may live in
      // another store (promotion), so no local existence check: relations carry
      // no foreign key by design.
      this.insertRelation(replacementId, 'supersedes', id, at);
      this.logActivity(verb, retired as unknown as DurableRecord, at);
    });
    return this.hydrateAll([stored as DurableRecord])[0];
  }

  /**
   * Hard removal — the P4 path for todos (done = removed by the artifact-write
   * event) . Policy for everything else (gated cleanup, §8.4) lives above the store.
   * Removing a SYSTEM-source todo appends to the capped queue drain log
   * (§3.2.7 audit projection — "was X handled?"); user todos are never logged.
   */
  remove(id: string, drainedAt?: string): void {
    this.assertWritable('remove');
    this.tx(() => {
      const record = this.get(id) as (DurableRecord & { source?: string; system_reason?: string; text?: string; file_keys?: string[] }) | undefined;
      const isSystemDrain = record && record.type === 'todo' && record.source === 'system';
      if (isSystemDrain && record) {
        this.db
          .prepare('INSERT INTO queue_drain_log (drained_at, system_reason, text, file_keys, record_id) VALUES (?, ?, ?, ?, ?)')
          .run(drainedAt ?? new Date().toISOString(), record.system_reason ?? '', record.text ?? '', JSON.stringify(record.file_keys ?? []), record.id);
        // cap: completed items must never build up (adjudicated 2026-06-12)
        this.db
          .prepare('DELETE FROM queue_drain_log WHERE seq NOT IN (SELECT seq FROM queue_drain_log ORDER BY seq DESC LIMIT 50)')
          .run();
      }
      // A system-todo removal is already visible via queue_drain_log above — the
      // activity log covers what THAT log does not (board 39d6462d), so it is
      // deliberately skipped here to avoid double-logging the same removal.
      if (record && !isSystemDrain) {
        this.logActivity('removed', record, drainedAt ?? new Date().toISOString());
      }
      this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM record_stack_tags WHERE record_id = ?').run(id);
      this.db.prepare('DELETE FROM record_file_keys WHERE record_id = ?').run(id);
      this.db.prepare('DELETE FROM record_relations WHERE source_id = ?').run(id);
      // ALSO delete inbound edges (audit finding 31/43): a record that linked TO
      // the removed one kept a relation row pointing at a nonexistent id, so
      // the reverse-traversal surface accrued dangling edges.
      this.db.prepare('DELETE FROM record_relations WHERE target_id = ?').run(id);
      // Version snapshots are permanent for a LIVING record; a hard removal is
      // that record's death (P4 — the artifact-write event ends its life), so
      // its history goes with it rather than becoming orphan rows keyed on an
      // id nothing resolves ([stable-identity-design-v2]).
      this.db.prepare('DELETE FROM record_versions WHERE record_id = ?').run(id);
      // The alias index follows its canonical record for the same reason: an
      // alias whose canonical_id no longer exists resolves a dead citation to
      // NOTHING AT ALL, which is worse than an unresolved id — an unresolved id
      // says so, a dangling alias just fails. Todos leave the store by removal
      // (P4), and nothing else is hard-removed outside gated cleanup, so the
      // rows deleted here are the aliases of a record that is genuinely gone.
      this.db.prepare('DELETE FROM record_aliases WHERE canonical_id = ?').run(id);
      this.db.prepare('DELETE FROM records_fts WHERE record_id = ?').run(id);
    });
  }

  /** Newest-first drained queue items (§3.2.7 drain log) — the TUI's completed section. */
  listQueueDrain(limit = 15): { drained_at: string; system_reason: string; text: string; file_keys: string[] }[] {
    const rows = this.db
      .prepare('SELECT drained_at, system_reason, text, file_keys FROM queue_drain_log ORDER BY seq DESC LIMIT ?')
      .all(limit) as { drained_at: string; system_reason: string; text: string; file_keys: string }[];
    return rows.map((r) => ({ ...r, file_keys: JSON.parse(r.file_keys) as string[] }));
  }

  /**
   * The drain-log trace for ONE removed item id, newest first (board 97d773ef):
   * lets a remove on a gone id say "already removed <when>" instead of a bare
   * "no record". Returns undefined when no trace remains — which, because the
   * log keeps only the newest 50 rows, means "no RECENT trace", never proof the
   * id never existed.
   */
  drainLogEntry(id: string): { drained_at: string; system_reason: string } | undefined {
    try {
      return this.db
        .prepare('SELECT drained_at, system_reason FROM queue_drain_log WHERE record_id = ? ORDER BY seq DESC LIMIT 1')
        .get(id) as { drained_at: string; system_reason: string } | undefined;
    } catch (e) {
      // A pre-v2 store may predate the additive record_id column, and the ALTER
      // that adds it now runs only on the writable path — so on a legacy store
      // the column can be absent. "No recent trace" is the honest answer here
      // (this is a read, and reads stay allowed pre-migration, AC3); anything
      // else — including the same failure on a v2 store, which would be a real
      // defect — still propagates.
      if (this.legacySchemaVersion !== undefined && /record_id/.test(String((e as Error).message))) return undefined;
      throw e;
    }
  }

  /**
   * Board 39d6462d activity feed — the ONE seam every knowledge write lands
   * through, so the Queue tab's activity section shows "what has been done"
   * without a second, separate write path (§3.1 invariant: one write path).
   * Called directly by create/supersede/addLink/remove/retireInFavorOf with the
   * verb that primitive actually performed; NOT called from insertRecord
   * itself, because supersede/enqueueSystemTodo also insert rows and each needs
   * its own verb (or, for enqueueSystemTodo, no activity-log entry at all — see
   * remove()'s system-todo branch, which already has a completed-section home
   * in queue_drain_log and would otherwise double-log). Same capped-at-50,
   * pruned-in-tx retention policy as queue_drain_log (§3.2.7), so completed
   * items never build up here either.
   */
  private logActivity(verb: string, record: DurableRecord, at: string): void {
    this.db
      .prepare('INSERT INTO activity_log (at, verb, type, record_id, title) VALUES (?, ?, ?, ?, ?)')
      .run(at, verb, record.type, record.id, activityTitleOf(record));
    this.db.prepare('DELETE FROM activity_log WHERE seq NOT IN (SELECT seq FROM activity_log ORDER BY seq DESC LIMIT 50)').run();
  }

  /** Newest-first activity rows (board 39d6462d) — the TUI Queue tab's activity section. */
  listActivityLog(limit = 15): { at: string; verb: string; type: string; id: string; title: string }[] {
    return this.db
      .prepare('SELECT at, verb, type, record_id AS id, title FROM activity_log ORDER BY seq DESC LIMIT ?')
      .all(limit) as { at: string; verb: string; type: string; id: string; title: string }[];
  }

  /** Backup snapshot (§2.3): VACUUM INTO the configured backup path. Refuses to overwrite. */
  snapshot(targetPath: string): void {
    const target = targetPath.replace(/\\/g, '/');
    if (existsSync(target)) {
      throw new Error(`snapshot: target already exists, refusing to overwrite: '${target}'`);
    }
    mkdirSync(dirname(target), { recursive: true });
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Run protocol (spec §3.2.9, §5.2) — run records are run-scoped transient
  // state, but they live in SQLite, not in a shared mutable file (P4), because
  // brain transitions need atomic compare-and-swap and the TUI reads them live.
  // They are NOT knowledge records: knowledge_query never sees them.
  // -------------------------------------------------------------------------

  /** Run begins at gate approval. One active run at a time (§7.5). */
  createRun(input: unknown): RunRecord {
    const run = runRecordSchema.parse(input);
    // The active-run check and the INSERT run inside one BEGIN IMMEDIATE tx
    // (audit finding 29/43): otherwise two concurrent createRuns both see no
    // active run and both insert, breaking the one-active-run invariant. The
    // write lock serializes them; the loser sees the winner's run and throws.
    this.tx(() => {
      const active = this.getRun();
      if (active) {
        throw new Error(`createRun: run '${active.id}' is still active (${active.machine_state}) — one active run at a time`);
      }
      this.db
        .prepare('INSERT INTO runs (id, machine_state, pending_exit, body, updated_at) VALUES (?, ?, NULL, ?, ?)')
        .run(run.id, run.machine_state, JSON.stringify(run), run.started_at);
    });
    return run;
  }

  /** By id, or the single active run when no id is given. */
  getRun(id?: string): RunRecord | undefined {
    const row = (
      id
        ? this.db.prepare('SELECT body FROM runs WHERE id = ?').get(id)
        : this.db
            .prepare(
              `SELECT body FROM runs WHERE machine_state IN (${ACTIVE_STATES.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`
            )
            .get(...ACTIVE_STATES)
    ) as { body: string } | undefined;
    return row ? (runRecordSchema.parse(JSON.parse(row.body)) as RunRecord) : undefined;
  }

  /**
   * The pending-exit column holds a FIFO QUEUE since board 81bc3409 (a JSON
   * array; a LEGACY single-object value reads as a one-element queue), so
   * parallel agent exits append instead of refusing on a sibling's unconsumed
   * exit — on 2026-07-03 three separate reviewer exits were refused on one
   * sibling's slot and each needed a conductor resume round-trip. Consumers
   * (run_signal / consume-exit) read the HEAD via getPendingExit; the brain
   * transition that consumes it POPS the head and preserves the tail.
   */
  private static parsePendingQueue(raw: string | null): RecordedExit[] {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecordedExit | RecordedExit[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  private static serializePendingQueue(queue: RecordedExit[]): string | null {
    return queue.length ? JSON.stringify(queue) : null;
  }

  /**
   * §5.2 brain transition: atomic compare-and-swap on machine_state
   * (UPDATE … WHERE machine_state = <observed>). Zero rows updated means the
   * caller carried stale state — rejected loudly, never re-applied. POPS the
   * HEAD pending exit (the one this transition consumes) and PRESERVES the
   * queued tail (board 81bc3409); the read-pop pair runs inside BEGIN
   * IMMEDIATE, so a concurrent recordPendingExit append cannot be lost
   * between the read and the write.
   */
  casTransition(observed: MachineState, next: unknown): RunRecord {
    const run = runRecordSchema.parse(next);
    this.tx(() => {
      const row = this.db.prepare('SELECT pending_exit FROM runs WHERE id = ?').get(run.id) as
        | { pending_exit: string | null }
        | undefined;
      const tail = SterlingStore.serializePendingQueue(SterlingStore.parsePendingQueue(row?.pending_exit ?? null).slice(1));
      const res = this.db
        .prepare('UPDATE runs SET machine_state = ?, pending_exit = ?, body = ?, updated_at = ? WHERE id = ? AND machine_state = ?')
        .run(run.machine_state, tail, JSON.stringify(run), new Date().toISOString(), run.id, observed);
      if (res.changes === 0) {
        throw new Error(
          `CAS rejected: run '${run.id}' is not in observed state '${observed}' — stale caller; re-read run_state, never re-apply (§5.2)`
        );
      }
    });
    return run;
  }

  /**
   * §5.2 brain transition, MERGE-SAFE (audit findings 1/43, 18/43). Like
   * casTransition it CAS-guards machine_state, but instead of overwriting the
   * whole body from a caller's stale snapshot it re-reads the FRESH body inside a
   * retry loop and applies `mutate` to it — so a concurrent hook write (H7
   * appendRunReconcileNeeded, H6/H8 appendRunEscalation, all via
   * updateRunOptimistic) landing between the caller's read and this transition is
   * PRESERVED, not clobbered. The UPDATE guards on body, machine_state AND
   * pending_exit: a body OR queue change under us retries against the fresh row
   * (so a concurrent recordPendingExit append is never overwritten by a stale
   * tail); a machine_state change is a stale caller and throws (casTransition's
   * CAS-rejected semantics). POPS the HEAD pending exit and preserves the tail
   * (board 81bc3409). State moves through this path or casTransition, never
   * updateRunOptimistic.
   */
  casTransitionMerge(observed: MachineState, runId: string, mutate: (fresh: RunRecord) => RunRecord, attempts = 5): RunRecord {
    this.assertWritable('casTransitionMerge');
    for (let i = 0; i < attempts; i++) {
      // Re-read the live schema version at the TOP of every retry iteration
      // (board 4c3a0c37, HIGH): the optimistic CAS loop re-reads the fresh row
      // each attempt, so a migration by another process landing mid-retry could
      // otherwise let this stale-schema handle read a newer body, parse it
      // through the OLD schema, and rewrite it dropping newly-added fields. The
      // pre-loop assertWritable is only a fast fail; this closes the TOCTOU
      // window spanning the whole loop by throwing the SAME live-drift error.
      this.assertLiveSchemaVersion('casTransitionMerge');
      const row = this.db.prepare('SELECT body, machine_state, pending_exit FROM runs WHERE id = ?').get(runId) as
        | { body: string; machine_state: string; pending_exit: string | null }
        | undefined;
      if (!row) throw new Error(`casTransitionMerge: no run '${runId}'`);
      // Re-check the live schema version AFTER the SELECT and BEFORE parsing the
      // body (board 4c3a0c37): the top-of-loop guard closes the retry-spanning
      // gap but not the intra-iteration race where a migration commits between
      // that guard's PRAGMA and this SELECT — the row just read would then be a
      // NEW-schema body parsed through the OLD schema. This second check catches
      // a migration before/during the read (and is what pin group D exercises,
      // where the injector lands a migration on THIS read while no write lock is
      // held, so it commits and is caught here). The narrower window this guard
      // did NOT cover — a SCHEMA-ONLY migration landing AFTER this check and
      // before the UPDATE, which the body-CAS cannot see because it leaves this
      // row's body unchanged — is now closed by the tx() wrapper on the UPDATE
      // below (board 4c3a0c37, Codex outside-family review).
      this.assertLiveSchemaVersion('casTransitionMerge');
      if (row.machine_state !== observed) {
        throw new Error(
          `CAS rejected: run '${runId}' is not in observed state '${observed}' — stale caller; re-read run_state, never re-apply (§5.2)`
        );
      }
      const current = runRecordSchema.parse(JSON.parse(row.body)) as RunRecord;
      const next = runRecordSchema.parse(mutate(current)) as RunRecord;
      const tail = SterlingStore.serializePendingQueue(SterlingStore.parsePendingQueue(row.pending_exit).slice(1));
      // Atomic version-check + UPDATE (board 4c3a0c37, Codex outside-family
      // review). tx() takes BEGIN IMMEDIATE — serializing against any concurrent
      // migration — and RE-ASSERTS the live schema version INSIDE that write lock
      // before the UPDATE runs, so no migration can commit between the check and
      // the write. This closes the schema-only-migration window a body-CAS alone
      // cannot: a migration that bumps user_version WITHOUT rewriting this row
      // would otherwise pass `body = row.body` and land a stale-schema write that
      // drops newly-added run-schema fields. A drift throws /Live schema version
      // drift/ from inside tx() and nothing is written; the machine_state
      // precondition still fires inside the lock via the UPDATE's
      // `AND machine_state = ?` predicate (a miss retries, and the fresh read on
      // the next pass throws CAS rejected); a concurrent BODY change still misses
      // `AND body = ?` and retries. The runs-body SELECT stays OUTSIDE this lock
      // deliberately — moving it inside would make pin group D's cross-connection
      // migration injector busy-fail against BEGIN IMMEDIATE instead of drifting.
      let changes = 0;
      this.tx(() => {
        changes = Number(
          this.db
            .prepare(
              'UPDATE runs SET machine_state = ?, pending_exit = ?, body = ?, updated_at = ? WHERE id = ? AND body = ? AND machine_state = ? AND pending_exit IS ?'
            )
            .run(next.machine_state, tail, JSON.stringify(next), new Date().toISOString(), runId, row.body, observed, row.pending_exit).changes
        );
      });
      if (changes === 1) return next;
      // body or queue changed under us (a concurrent hook write / agent exit) —
      // retry against the fresh row; a machine_state change is caught above.
    }
    throw new Error(`casTransitionMerge: lost the optimistic race ${attempts}x for run '${runId}' (P5: failing loudly)`);
  }

  /**
   * agent_exit lands here; run_signal/consume-exit consume the HEAD. Parallel
   * exits QUEUE (FIFO, board 81bc3409) instead of refusing on a sibling's
   * unconsumed exit. One pending exit per (phase, agent_role) still holds: the
   * same agent re-exiting before its first exit is consumed is a protocol
   * violation and is refused loudly with nothing recorded (P5) — a duplicate
   * would drive the brain twice from one dispatch.
   */
  recordPendingExit(runId: string, exit: RecordedExit): void {
    this.tx(() => {
      const row = this.db.prepare('SELECT pending_exit FROM runs WHERE id = ?').get(runId) as
        | { pending_exit: string | null }
        | undefined;
      if (!row) throw new Error(`recordPendingExit: no run '${runId}'`);
      const queue = SterlingStore.parsePendingQueue(row.pending_exit);
      const dup = queue.find((e) => (e.phase_id ?? null) === (exit.phase_id ?? null) && (e.agent_role ?? null) === (exit.agent_role ?? null));
      if (dup) {
        throw new Error(
          `recordPendingExit: run '${runId}' already has an unconsumed exit from ${dup.agent_role ?? 'unknown'} on phase '${dup.phase_id ?? '?'}' ` +
            `('${dup.signal}') — one exit per dispatched agent; call run_signal (or consume-exit) first`
        );
      }
      this.db
        .prepare('UPDATE runs SET pending_exit = ? WHERE id = ?')
        .run(SterlingStore.serializePendingQueue([...queue, exit]), runId);
    });
  }

  /** The HEAD of the pending-exit queue — the exit the next run_signal/consume-exit will consume. */
  getPendingExit(runId: string): RecordedExit | undefined {
    const row = this.db.prepare('SELECT pending_exit FROM runs WHERE id = ?').get(runId) as
      | { pending_exit: string | null }
      | undefined;
    if (!row) throw new Error(`getPendingExit: no run '${runId}'`);
    return SterlingStore.parsePendingQueue(row.pending_exit)[0];
  }

  /** Transient pair (§10): run-scoped, never enters the durable knowledge tables. */
  writeHandoff(runId: string, input: unknown, at: string): Handoff {
    this.assertWritable('writeHandoff');
    const handoff = handoffSchema.parse(input);
    if (!this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) {
      throw new Error(`writeHandoff: no run '${runId}'`);
    }
    // Wrapped in tx() (board d5942fa0 pin group B / TOCTOU fix) so the write
    // inherits the live schema-version recheck INSIDE the lock — the pre-lock
    // assertWritable() above stays as a fast fail, tx() is the guarantee.
    this.tx(() => {
      this.db
        .prepare('INSERT INTO handoffs (run_id, phase_id, agent_role, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(runId, handoff.phase_id, handoff.agent_role, JSON.stringify(handoff), at);
    });
    return handoff;
  }

  readHandoffs(runId: string, filter: { phase_id?: string; files?: string[] } = {}): Handoff[] {
    const rows = (
      filter.phase_id
        ? this.db.prepare('SELECT body FROM handoffs WHERE run_id = ? AND phase_id = ? ORDER BY created_at').all(runId, filter.phase_id)
        : this.db.prepare('SELECT body FROM handoffs WHERE run_id = ? ORDER BY created_at').all(runId)
    ) as { body: string }[];
    let handoffs = rows.map((r) => handoffSchema.parse(JSON.parse(r.body)));
    if (filter.files?.length) {
      const wanted = new Set(filter.files.map(normalizeRepoPath));
      handoffs = handoffs.filter((h) => h.what_changed.some((c) => wanted.has(c.path)));
    }
    return handoffs;
  }

  /**
   * Optimistic non-state mutation of the run record (hooks write concurrently
   * with the brain): retries on body change, fails loudly if it keeps losing
   * the race — never a silent drop (P5). machine_state is CAS-only and must
   * not change through this path.
   */
  updateRunOptimistic(runId: string, mutate: (run: RunRecord) => RunRecord, attempts = 5): RunRecord {
    this.assertWritable('updateRunOptimistic');
    for (let i = 0; i < attempts; i++) {
      // Re-read the live schema version at the TOP of every retry iteration
      // (board 4c3a0c37, HIGH): the optimistic CAS loop re-reads the fresh row
      // each attempt, so a migration by another process landing mid-retry could
      // otherwise let this stale-schema handle read a newer body, parse it
      // through the OLD schema, and rewrite it dropping newly-added fields. The
      // pre-loop assertWritable is only a fast fail; this closes the TOCTOU
      // window spanning the whole loop by throwing the SAME live-drift error.
      this.assertLiveSchemaVersion('updateRunOptimistic');
      const row = this.db.prepare('SELECT body FROM runs WHERE id = ?').get(runId) as { body: string } | undefined;
      if (!row) throw new Error(`updateRunOptimistic: no run '${runId}'`);
      // Re-check the live schema version AFTER the SELECT and BEFORE parsing the
      // body (board 4c3a0c37): catches a migration landing before/during this
      // read (pin group D's injector fires here, while no write lock is held).
      // The narrower window this guard did NOT cover — a SCHEMA-ONLY migration
      // landing AFTER this check and before the UPDATE, invisible to the body-CAS
      // because it leaves this row's body unchanged — is now closed by the tx()
      // wrapper on the UPDATE below (board 4c3a0c37, Codex outside-family review).
      this.assertLiveSchemaVersion('updateRunOptimistic');
      const current = JSON.parse(row.body) as RunRecord;
      const next = runRecordSchema.parse(mutate(current));
      if (next.machine_state !== current.machine_state) {
        throw new Error('updateRunOptimistic: machine_state changes go through casTransition only (§5.2)');
      }
      // Atomic version-check + UPDATE (board 4c3a0c37, Codex outside-family
      // review). tx()'s BEGIN IMMEDIATE serializes against any concurrent
      // migration and re-asserts the live schema version INSIDE the write lock
      // before the UPDATE, so a schema-only migration cannot slip between the
      // check and the write and land a field-dropping stale write past the
      // body-CAS. A drift throws /Live schema version drift/ and nothing is
      // written; a concurrent BODY change still misses `AND body = ?` and
      // retries. The runs-body SELECT stays OUTSIDE this lock deliberately —
      // moving it inside would make pin group D's cross-connection migration
      // injector busy-fail against BEGIN IMMEDIATE instead of drifting.
      let changes = 0;
      this.tx(() => {
        changes = Number(
          this.db
            .prepare('UPDATE runs SET body = ?, updated_at = ? WHERE id = ? AND body = ?')
            .run(JSON.stringify(next), new Date().toISOString(), runId, row.body).changes
        );
      });
      if (changes === 1) return next;
    }
    throw new Error(`updateRunOptimistic: lost the optimistic race ${attempts}x for run '${runId}' (P5: failing loudly)`);
  }

  /** H6 context warns + run_escalate land here (§6). */
  appendRunEscalation(runId: string, entry: unknown): void {
    this.updateRunOptimistic(runId, (run) => ({ ...run, escalations: [...run.escalations, entry] }));
  }

  /** H7 pipeline mark (§6): article reconciliation due at completion; idempotent. */
  appendRunReconcileNeeded(runId: string, articleId: string): void {
    this.updateRunOptimistic(runId, (run) =>
      (run.reconcile_needed ?? []).includes(articleId)
        ? run
        : { ...run, reconcile_needed: [...(run.reconcile_needed ?? []), articleId] }
    );
  }

  /**
   * Mid-run scope amendment (brief mid-run-scope-amendment, decision 8e6f9491):
   * the conductor's human-gated append of an exact repo-relative path to the run
   * record. Idempotent-on-path — a duplicate path is skipped and the first
   * {reason, at} stands. Never changes machine_state (updateRunOptimistic
   * enforces that). Deliberately NOT on the ToolStore Pick — agent-invisible.
   */
  appendRunScopeAmendment(runId: string, amendment: { path: string; reason: string; at: string }): void {
    this.updateRunOptimistic(runId, (run) =>
      (run.scope_amendments ?? []).some((a) => a.path === amendment.path)
        ? run
        : { ...run, scope_amendments: [...(run.scope_amendments ?? []), amendment] }
    );
  }

  /**
   * Per-phase reviewer mandatory set (decision 628c4b7f, run r-d630, phase 1 — AC1):
   * REPLACES all review_mandatory entries for phaseId with new items, each stamped
   * with phase_id from the phaseId param. Other phases are untouched (replace-by-
   * phase, not global). An empty items list clears that phase only. Uses
   * updateRunOptimistic (CAS, never machine_state). Deliberately NOT on ToolStore
   * Pick — agent-invisible (decision 628c4b7f).
   */
  setRunReviewMandatory(runId: string, phaseId: string, items: { record_id: string; reason: string }[]): void {
    this.updateRunOptimistic(runId, (run) => {
      const kept = (run.review_mandatory ?? []).filter((m) => m.phase_id !== phaseId);
      const added = items.map((item) => ({ phase_id: phaseId, record_id: item.record_id, reason: item.reason }));
      return { ...run, review_mandatory: [...kept, ...added] };
    });
  }

  /** H8 (§6): per-agent-type dispatch counter; returns the new count. Respawns count too. */
  incrementDispatchCount(runId: string, agentType: string): number {
    const next = this.updateRunOptimistic(runId, (run) => ({
      ...run,
      dispatch_counts: { ...run.dispatch_counts, [agentType]: (run.dispatch_counts[agentType] ?? 0) + 1 },
    }));
    return next.dispatch_counts[agentType];
  }

  /**
   * H2 selection row (§6, §11): the TUI writes it; H2 consumes it one-shot,
   * transactionally — read + delete in one transaction, never a signal file (P4).
   */
  writeSelection(type: string, recordId: string, at: string): void {
    this.assertWritable('writeSelection');
    // Wrapped in tx() (board d5942fa0 pin group B / TOCTOU fix) so the write
    // inherits the live schema-version recheck INSIDE the lock — the pre-lock
    // assertWritable() above stays as a fast fail, tx() is the guarantee.
    this.tx(() => {
      this.db
        .prepare('INSERT INTO selection (slot, type, record_id, at) VALUES (1, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET type = excluded.type, record_id = excluded.record_id, at = excluded.at')
        .run(type, recordId, at);
    });
  }

  takeSelection(): { type: string; record_id: string; at: string } | undefined {
    let row: { type: string; record_id: string; at: string } | undefined;
    this.tx(() => {
      row = this.db.prepare('SELECT type, record_id, at FROM selection WHERE slot = 1').get() as typeof row;
      if (row) this.db.prepare('DELETE FROM selection WHERE slot = 1').run();
    });
    return row;
  }

  /**
   * fs-move support (§7.1): renames inside the machinery never orphan
   * knowledge — every owning record's stored paths are rewritten as part of
   * the move (exact normalized-path matches only), revalidated, and the
   * file-key index updated, in one transaction.
   *
   * It goes through the VERSIONED in-place core ([stable-identity-design-v2]):
   * a rename is a real change to the record's content, so it bumps the version,
   * archives the prior body, rebuilds record_file_keys and refreshes the FTS
   * row like every other write. As a bare body UPDATE it was invisible to
   * expected_version — a concurrent updateRecord holding a pre-rename read
   * silently reverted the rename with no CAS conflict — and left the old path
   * ranking in records_fts. allowRetired keeps the contract intact for
   * tombstones: a move must orphan NO owning record's paths.
   */
  renameFileKey(oldPath: string, newPath: string): number {
    this.assertWritable('renameFileKey');
    const from = normalizeRepoPath(oldPath);
    const to = normalizeRepoPath(newPath);
    const rows = this.db.prepare('SELECT record_id FROM record_file_keys WHERE path = ?').all(from) as { record_id: string }[];
    this.tx(() => {
      for (const { record_id } of rows) {
        if (!this.get(record_id)) continue;
        this.applyInPlace(
          'renameFileKey',
          record_id,
          (current) => deepReplaceString(current as unknown, from, to) as Record<string, unknown>,
          {},
          { allowRetired: true }
        );
      }
    });
    return rows.length;
  }

  /** knowledge_link (§10): typed graph edge, traversable both directions (§3.1 c4).
   *  targetValidated is set ONLY by MountedStores.addLink, which has already resolved
   *  the target across every mounted store — cross-store edges are a legitimate shape
   *  (promotion itself writes them: supersedes / informed_by across project↔domain)
   *  that a store-local get cannot see. Standalone usage keeps the local check. */
  addLink(sourceId: string, rel: string, targetId: string, targetValidated = false): DurableRecord {
    this.assertWritable('addLink');
    const source = this.get(sourceId);
    if (!source) throw new Error(`addLink: no record '${sourceId}'`);
    if (!targetValidated && !this.get(targetId)) throw new Error(`addLink: no target record '${targetId}'`);
    const parsedRel = linkSchema.shape.rel.parse(rel);
    // 'supersedes' is NOT a plain edge: it is the authoritative carrier of a
    // LIFECYCLE change (the target must become retired, the served status /
    // superseded_by of both records derive from it, and at most one may exist).
    // Written raw here it would desync the records.lifecycle/superseded_by
    // cache columns from the relation graph and slip past the one-successor
    // invariant, so the two sanctioned paths own it exclusively.
    if (parsedRel === 'supersedes') {
      throw new Error(
        `addLink: rel 'supersedes' cannot be written as a raw edge — supersession is a lifecycle transition, not a link. ` +
          `Use supersede(oldId, newRecord) for concept replacement, or retireInFavorOf(id, survivor) for duplicate consolidation. Nothing was written.`
      );
    }
    if (source.links.some((l) => l.rel === parsedRel && l.target_id === targetId)) return source;
    const updated = { ...source, links: [...source.links, { rel: parsedRel, target_id: targetId }] } as DurableRecord;
    const at = new Date().toISOString();
    const stored = SterlingStore.storableBody(updated as unknown as Record<string, unknown>);
    this.tx(() => {
      this.db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify(stored), sourceId);
      // record_relations is the authoritative edge home (contract 6); the body
      // copy is a convenience the read materialization overwrites anyway.
      this.insertRelation(sourceId, parsedRel, targetId, at);
      // addLink does not bump updated_at (the edge is metadata, not content) —
      // the activity row still needs a real timestamp, so it stamps "now".
      this.logActivity('linked', updated, at);
    });
    return this.hydrateAll([stored as DurableRecord])[0];
  }

  /**
   * Disposal of run-scoped SQLite rows (§16.1 Slice 5; H9): folds the
   * summaries onto the run record (the only facts that survive — §3.7),
   * advances completing → awaiting_merge_gate via CAS, and deletes the
   * run-scoped handoff + check_skipped rows — one transaction, lifecycle
   * binding follows the data (P4). The run record itself persists: the merge
   * gate still needs it. Callers (dispose-run) verify promotion conditions
   * and snapshot BEFORE calling this.
   */
  disposeRunRows(runId: string, summaries: NonNullable<RunRecord['summaries']>): RunRecord {
    const run = this.getRun(runId);
    if (!run) throw new Error(`disposeRunRows: no run '${runId}'`);
    if (run.machine_state !== 'completing') {
      throw new Error(`disposeRunRows: run '${runId}' is '${run.machine_state}', not 'completing' — disposal is the completion sequence only`);
    }
    const next = runRecordSchema.parse({ ...run, machine_state: 'awaiting_merge_gate', summaries });
    this.tx(() => {
      const res = this.db
        .prepare('UPDATE runs SET machine_state = ?, pending_exit = NULL, body = ?, updated_at = ? WHERE id = ? AND machine_state = ?')
        .run(next.machine_state, JSON.stringify(next), new Date().toISOString(), runId, 'completing');
      if (res.changes === 0) throw new Error(`disposeRunRows: CAS rejected for run '${runId}' (stale caller)`);
      this.db.prepare('DELETE FROM handoffs WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM check_skipped WHERE run_id = ?').run(runId);
    });
    return next;
  }

  /**
   * Terminal-run row purge (P4): deletes the run-scoped handoff + check_skipped
   * rows of a run that has already reached a TERMINAL state ('rejected' via
   * --abort, 'merged'/'rejected' via the merge gate). disposeRunRows is the
   * completion sequence (folds summaries, CAS-advances); this is the lifecycle
   * sweep for the paths that end a run WITHOUT that sequence — an aborted run's
   * rows previously had no disposal event and accreted forever, and the merge
   * gate's own post-disposal skip rows outlived the run (R2 board 82f04007).
   * Refuses on a non-terminal run — never a back door around disposal.
   */
  purgeRunRows(runId: string): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`purgeRunRows: no run '${runId}'`);
    if (run.machine_state !== 'rejected' && run.machine_state !== 'merged') {
      throw new Error(`purgeRunRows: run '${runId}' is '${run.machine_state}', not terminal — rows of a live run are disposed only by disposeRunRows`);
    }
    this.tx(() => {
      this.db.prepare('DELETE FROM handoffs WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM check_skipped WHERE run_id = ?').run(runId);
    });
  }

  /** §16.1.9: every unimplemented full-spec check emits check_skipped where it would have run — never silent success. */
  recordCheckSkipped(check: string, reason: string, runId: string | undefined, at: string): void {
    this.assertWritable('recordCheckSkipped');
    // Wrapped in tx() (board d5942fa0 pin group B / TOCTOU fix) so the write
    // inherits the live schema-version recheck INSIDE the lock — the pre-lock
    // assertWritable() above stays as a fast fail, tx() is the guarantee. This
    // also makes the insert + audit-cap prune below atomic, which they were not
    // before (a small incidental improvement, not the reason for the change).
    this.tx(() => {
      this.db
        .prepare('INSERT INTO check_skipped (run_id, check_name, reason, at) VALUES (?, ?, ?, ?)')
        .run(runId ?? null, check, reason, at);
      // Run-scoped rows are disposed with the run (disposeRunRows). NULL-run rows
      // (direct-mode knowledge_create/board_remove) have no disposal event, so cap
      // them like queue_drain_log — else they accrete unbounded (audit finding
      // 30/43, P4). Keep the 50 newest NULL-run rows as the audit tail.
      if (!runId) {
        this.db
          .prepare(
            'DELETE FROM check_skipped WHERE run_id IS NULL AND seq NOT IN (SELECT seq FROM check_skipped WHERE run_id IS NULL ORDER BY seq DESC LIMIT 50)'
          )
          .run();
      }
    });
  }

  listCheckSkipped(runId?: string): { run_id: string | null; check_name: string; reason: string; at: string }[] {
    return (
      runId
        ? this.db.prepare('SELECT run_id, check_name, reason, at FROM check_skipped WHERE run_id = ? ORDER BY seq').all(runId)
        : this.db.prepare('SELECT run_id, check_name, reason, at FROM check_skipped ORDER BY seq').all()
    ) as { run_id: string | null; check_name: string; reason: string; at: string }[];
  }

  // -------------------------------------------------------------------------
  // AC8: catalog bootstrap + maintenance enqueue (run r-ea9e, phase 3)
  // -------------------------------------------------------------------------

  /**
   * Idempotent bootstrap: if no project-scoped reference_material carrying a
   * `catalog` payload exists, create one seeded from config.models' DISTINCT
   * pinned model IDs. No network; no fabrication — day-one entries are the IDs
   * already in use by the installed agents.
   */
  bootstrapCatalogIfAbsent(config: unknown, nowISO: string): void {
    const existing = this.query({ types: ['reference_material'], cap: 200 }).filter(
      (r) => (r as Record<string, unknown>).catalog
    );
    if (existing.length > 0) return; // catalog already present — idempotent

    const cfg = config as { models?: Record<string, { model?: string } | null | undefined> };
    const models = cfg.models ?? {};
    const ids = new Set<string>();
    for (const v of Object.values(models)) {
      if (v?.model) ids.add(v.model);
    }

    const dateStr = nowISO.slice(0, 10); // YYYY-MM-DD for source_date / capture_date
    this.create({
      id: randomUUID(),
      type: 'reference_material',
      created_at: nowISO,
      updated_at: nowISO,
      author: 'system',
      status: 'active',
      superseded_by: null,
      links: [],
      scope: 'project',
      stack_tags: [],
      title: 'Models catalog',
      kind: 'doc',
      location: '.sterling/models-catalog',
      summary: 'KB-maintained model catalog for the TUI System tab.',
      source_date: dateStr,
      capture_date: dateStr,
      catalog: {
        entries: [...ids].map((id) => ({ id, label: id, tier: 'unknown', status: 'active' })),
      },
    });
  }

  /**
   * Enqueue exactly ONE refresh_reference maintenance item for the models catalog.
   * Dedup: if a pending item with system_reason='refresh_reference' already exists,
   * this is a no-op. Dedup is lane-scoped — an unrelated reconcile_needed item
   * must NOT suppress the enqueue (§3.2.5, decision 98064d77).
   */
  enqueueRefreshReferenceOnce(nowISO: string): void {
    const pending = this.query({ types: ['todo'], cap: 200 }).filter(
      (r) => (r as Record<string, unknown>).system_reason === 'refresh_reference'
    );
    if (pending.length > 0) return; // already pending — no duplicate

    const catalogs = this.query({ types: ['reference_material'], cap: 200 }).filter(
      (r) => (r as Record<string, unknown>).catalog
    );

    const todo: Record<string, unknown> = {
      id: randomUUID(),
      type: 'todo',
      created_at: nowISO,
      updated_at: nowISO,
      author: 'system',
      status: 'active',
      superseded_by: null,
      links: [],
      scope: 'project',
      stack_tags: [],
      text: 'Refresh the KB models catalog',
      source: 'system',
      system_reason: 'refresh_reference',
    };

    if (catalogs.length > 0) {
      todo.feature_link = (catalogs[0] as Record<string, unknown>).id;
    }

    this.create(todo);
  }

  /**
   * The one row-insert. Since S2 ([stable-identity-design-v2]) the stored BODY
   * carries lifecycle/freshness/version and NOT status/superseded_by — those two
   * are derived at read. They survive as records COLUMNS because they are the
   * §3.4 filter surface every read SQL already joins on (and the shape a
   * pre-migration store still has): written here from the derived values in the
   * same statement, never read back as the served truth.
   */
  private insertRecord(record: DurableRecord): void {
    const entry = RECORD_TYPES[record.type];
    const meta = record as unknown as { lifecycle?: string; freshness?: string; version?: number; superseded_by?: string | null };
    const lifecycle: Lifecycle = meta.lifecycle === 'retired' ? 'retired' : 'live';
    const freshness: Freshness = meta.freshness === 'flagged_stale' ? 'flagged_stale' : 'fresh';
    const version = typeof meta.version === 'number' ? meta.version : 1;
    const stored = SterlingStore.storableBody(record as unknown as Record<string, unknown>);
    this.db
      .prepare(
        `INSERT INTO records (id, type, status, superseded_by, lifecycle, freshness, version, scope, created_at, updated_at, author, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.type,
        SterlingStore.derivedStatus(lifecycle, freshness),
        meta.superseded_by ?? null,
        lifecycle,
        freshness,
        version,
        record.scope,
        record.created_at,
        record.updated_at,
        record.author,
        JSON.stringify(stored)
      );
    for (const tag of new Set(record.stack_tags)) {
      this.db.prepare('INSERT INTO record_stack_tags (record_id, tag) VALUES (?, ?)').run(record.id, tag);
    }
    for (const path of new Set(entry.fileKeys(stored))) {
      this.db.prepare('INSERT INTO record_file_keys (record_id, path) VALUES (?, ?)').run(record.id, path);
    }
    for (const link of record.links) {
      // A links[] entry pointing at its OWN record is malformed data that
      // already exists in the wild (same shape as the self-referential
      // superseded_by handled below — resolveTerminus's self-loop boundary is
      // pinned against it). The relation GRAPH must not hold the self-edge, but
      // refusing the insert would make such a record UNSTORABLE, which would
      // abort S4's migration re-insert of exactly that legacy row. So the edge
      // is skipped while the row lands; the loud self-cycle refusal stays on
      // the paths that MINT an edge (addLink / supersede / retireInFavorOf),
      // where a caller is actually asking for it.
      if (link.target_id === record.id) continue;
      this.insertRelation(record.id, link.rel, link.target_id, record.updated_at);
    }
    // A record created in the legacy retired shape (status 'superseded' +
    // superseded_by, as pre-v2 fixtures and imports write it) gets the same
    // authoritative relation the supersede path writes, so its served
    // superseded_by materializes from the graph like everyone else's.
    //
    // A record pointing at ITSELF is malformed data that already exists in the
    // wild (resolveTerminus's self-loop boundary is pinned against exactly that
    // shape): the relation GRAPH must not hold the self-edge, but refusing the
    // insert would make such a record unstorable and unreadable. So the edge is
    // skipped while the row lands — the loud self-cycle refusal stays on the
    // paths that MINT supersession (supersede / retireInFavorOf / addLink),
    // where a caller is actually asking for it.
    if (lifecycle === 'retired' && meta.superseded_by && meta.superseded_by !== record.id) {
      this.insertRelation(meta.superseded_by, 'supersedes', record.id, record.updated_at);
    }
    this.db.prepare('INSERT INTO records_fts (record_id, text) VALUES (?, ?)').run(record.id, entry.fts(stored));
  }

  /**
   * REENTRANT — every other write primitive (create, supersede, …) already
   * calls this internally, so a multi-record tool-layer write (knowledge_split:
   * N child creates + one parent supersession, decision
   * compaction-tooling-windowed-read-plus-split) that must land atomically
   * cannot simply wrap several such calls in a second BEGIN — SQLite does not
   * nest transactions. `txDepth` makes a NESTED call join the already-open
   * transaction instead of attempting a second one: only the outermost call
   * issues BEGIN/COMMIT/ROLLBACK, so a failure anywhere inside unwinds the
   * whole thing exactly once.
   */
  private txDepth = 0;

  private tx(fn: () => void): void {
    // Backstop for the pre-migration read-only mode: every public write names
    // itself through assertWritable, and this catches anything that forgets to
    // ([stable-identity-design-v2]). Reads never open a transaction.
    //
    // Split deliberately (reviewer TOCTOU finding on the live schema-version
    // guard, board d5942fa0 pin group B): assertV2Surface is a property of the
    // OPEN handle (legacySchemaVersion is captured once at construction and
    // never changes for the life of a handle), so checking it here, before the
    // lock, changes nothing. assertLiveSchemaVersion is NOT safe to check only
    // here — re-reading PRAGMA user_version before BEGIN IMMEDIATE leaves a
    // window where a migration can commit between this read and lock
    // acquisition and be silently admitted. That check runs again inside the
    // lock below, following the same re-read-inside-BEGIN-IMMEDIATE pattern the
    // constructor's stamp-forward transaction already uses (~line 480) to close
    // the identical race at open time.
    this.assertV2Surface('transaction');
    if (this.txDepth > 0) {
      fn();
      return;
    }
    // BEGIN FIRST, then count. A failing BEGIN (SQLITE_BUSY on a contended
    // file) previously left txDepth stuck at 1 forever, because the increment
    // happened before the statement that threw and the `finally` was never
    // entered: every later tx() on that connection then took the "join the open
    // transaction" branch with NO transaction open, so each statement
    // autocommitted individually and atomicity silently disappeared for the
    // life of the connection.
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      // Live-version recheck INSIDE the write lock (closes the TOCTOU above):
      // a migration that committed between a public write method's pre-lock
      // assertWritable() call and this BEGIN IMMEDIATE would otherwise be
      // silently admitted. Re-reading here, while the write lock is held,
      // guarantees the version cannot move again before fn() writes.
      this.assertLiveSchemaVersion('transaction');
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      // A ROLLBACK that itself throws must never REPLACE the original failure —
      // the caller would be told about the cleanup and never about the cause.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the original error below is the one that matters */
      }
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  /**
   * PUBLIC transaction boundary for the tool layer (decision
   * compaction-tooling-windowed-read-plus-split): the store is the one write
   * path (invariant 3 / CLAUDE.md §"Store writes"), so a tool-layer operation
   * that must write several records atomically — knowledge_split's N children
   * plus one parent supersession — gets the transaction FROM the store rather
   * than reimplementing BEGIN/COMMIT/ROLLACK above it. Reentrant via `tx`:
   * every store write primitive called from `fn` joins this same transaction.
   */
  withTransaction<T>(fn: () => T): T {
    let result!: T;
    this.tx(() => {
      result = fn();
    });
    return result;
  }
}
