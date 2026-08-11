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
  type DurableRecord,
  type Handoff,
  type MachineState,
  type RunRecord,
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
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  author TEXT NOT NULL,
  derived_unconfirmed INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_type_status ON records(type, status);
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
CREATE TABLE IF NOT EXISTS record_links (
  source_id TEXT NOT NULL,
  rel TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (source_id, rel, target_id)
);
CREATE INDEX IF NOT EXISTS idx_links_target ON record_links(target_id);
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

export interface QueryOptions {
  types?: string[];
  stack_tags?: string[];
  file_keys?: string[];
  rank_terms?: string[];
  include_unconfirmed?: boolean;
  cap?: number;
  match_all?: boolean;
  /** Filter by todo body source ('user' | 'system') BEFORE the cap (finding 38/43). */
  source?: string;
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
  | 'supersede'
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
>;

export class SterlingStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
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
  }

  journalMode(): string {
    return (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  }

  /** The one validated write path. Unregistered type or malformed record throws; nothing is written. */
  create(input: unknown): DurableRecord {
    const record = validateRecord(input);
    this.tx(() => {
      this.insertRecord(record);
      this.logActivity('created', record, record.created_at);
    });
    return record;
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
   * urgent fact. Todos carry no version chain (P4: done = removed), so the text is
   * replaced in place and updated_at moved; file_keys are identical by
   * construction, so no index maintenance is needed.
   */
  enqueueSystemTodo(input: unknown): { record: DurableRecord; deduped: boolean; text_updated: boolean } {
    const candidate = validateRecord(input) as DurableRecord & { source?: string; system_reason?: string; file_keys?: string[]; text?: string };
    if (candidate.type !== 'todo' || candidate.source !== 'system') {
      throw new Error(`enqueueSystemTodo: expects a system-source todo, got ${candidate.type}/${candidate.source ?? 'no source'}`);
    }
    // AN ITEM WITH NEITHER A feature_link NOR file_keys HAS NO IDENTITY BEYOND
    // ITS TEXT, so the text joins the key for exactly those. Without this, two
    // unrelated obligations in a file-less lane (capture_owed, research_owed)
    // would collapse into one on their reason alone — trading the duplicate bug
    // for a worse one. With it, an exact duplicate still collapses while distinct
    // items stay distinct. A consequence worth naming: for those lanes the
    // text-differs-so-update branch can never fire, because a different text is
    // by definition a different item.
    const keyOf = (t: { system_reason?: string; feature_link?: string; file_keys?: string[]; text?: string }) => {
      const files = [...(t.file_keys ?? [])].sort();
      const identified = !!t.feature_link || files.length > 0;
      return JSON.stringify([t.system_reason ?? '', t.feature_link ?? '', files, identified ? '' : (t.text ?? '')]);
    };
    const wantKey = keyOf(candidate as unknown as { system_reason?: string; feature_link?: string; file_keys?: string[]; text?: string });

    let existing: (DurableRecord & { text?: string }) | undefined;
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
      if ((existing.text ?? '') !== (candidate.text ?? '')) {
        const merged = { ...existing, text: candidate.text, updated_at: candidate.updated_at };
        this.db.prepare('UPDATE records SET body = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), candidate.updated_at, existing.id);
        existing = merged as DurableRecord & { text?: string };
        textUpdated = true;
      }
    });
    return existing ? { record: existing, deduped: true, text_updated: textUpdated } : { record: candidate, deduped: false, text_updated: false };
  }

  get(id: string): DurableRecord | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE id = ?').get(id) as { body: string } | undefined;
    if (!row) return undefined;
    return this.withDerivedReliedBy(JSON.parse(row.body) as DurableRecord);
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
    const records = rows.map((r) => JSON.parse(r.body) as DurableRecord);
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
   * The §3.4 base filter (status + derived_unconfirmed + type + stack-tag +
   * file-key join) shared by query() and count() — everything EXCEPT the rank
   * (FTS), ordering, and cap. One definition so count() can never drift from
   * what query() would actually return.
   */
  private baseFilter(opts: QueryOptions): { where: string[]; params: (string | number)[]; fileKeys: string[] } {
    const params: (string | number)[] = [];
    // != superseded, not = active: flagged_stale research findings are still
    // served — only as "stale — re-verify" (§3.2.4); the tool layer attaches the flag.
    const where: string[] = ["r.status != 'superseded'"];
    if (!opts.include_unconfirmed) where.push('r.derived_unconfirmed = 0');
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

  /** Retrieval discipline (§3.4): filter → file-key join → rank (bm25 or mechanical fallback) → cap. */
  query(opts: QueryOptions = {}): DurableRecord[] {
    const cap = opts.cap ?? DEFAULT_QUERY_CAP;
    const { where, params, fileKeys } = this.baseFilter(opts);

    if (opts.rank_terms !== undefined) {
      const terms = rankTerms.parse(opts.rank_terms);
      if (terms.length) {
        // a trailing '*' marks an FTS5 prefix query ("stor*" matches "store") —
        // the star must sit OUTSIDE the quoted token to act as the prefix operator
        const joiner = opts.match_all ? ' AND ' : ' OR ';
        const match = terms
          .map((t) => (t.endsWith('*') && t.length > 1 ? `"${t.slice(0, -1).replace(/"/g, '""')}"*` : `"${t.replace(/"/g, '""')}"`))
          .join(joiner);
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
  private withDerivedReliedByAll(records: DurableRecord[]): DurableRecord[] {
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
    const oldRecord = this.get(oldId);
    if (!oldRecord) throw new Error(`supersede: no record '${oldId}'`);
    // A flagged_stale research finding is superseded by re-verification — that is
    // the ADVERTISED remedy (retrieval tells the reader "re-verification supersedes
    // this finding"); only a terminal (already-superseded) record is refused
    // (audit finding 13/43). The in-tx guard below closes the check-then-act race.
    if (oldRecord.status === 'superseded') throw new Error(`supersede: record '${oldId}' is already superseded`);
    const candidate = { ...(newInput as Record<string, unknown>) };
    const links = Array.isArray(candidate.links) ? [...(candidate.links as { rel: string; target_id: string }[])] : [];
    if (!links.some((l) => l.rel === 'supersedes' && l.target_id === oldId)) {
      links.push({ rel: 'supersedes', target_id: oldId });
    }
    candidate.links = links;
    const newRecord = validateRecord(candidate);
    if (newRecord.type !== oldRecord.type) {
      throw new Error(`supersede: type mismatch ('${newRecord.type}' cannot supersede '${oldRecord.type}')`);
    }
    if (newRecord.type === 'feature_article' && oldRecord.type === 'feature_article' && newRecord.version <= oldRecord.version) {
      throw new Error(
        `supersede: feature_article version must increase (old v${oldRecord.version}, new v${newRecord.version})`
      );
    }
    this.tx(() => {
      this.insertRecord(newRecord);
      const updatedOld = { ...oldRecord, status: 'superseded', superseded_by: newRecord.id, updated_at: newRecord.updated_at };
      // Guard the UPDATE on the observed status INSIDE the BEGIN IMMEDIATE tx
      // (audit finding 29/43): the pre-tx status read is check-then-act, so a
      // concurrent supersede (server + note worker / TUI on the shared WAL file)
      // could otherwise leave two active successors. changes===0 → the row moved
      // out from under us → roll back loud (the inserted newRecord is undone).
      const res = this.db
        .prepare("UPDATE records SET status = ?, superseded_by = ?, updated_at = ?, body = ? WHERE id = ? AND status != 'superseded'")
        .run('superseded', newRecord.id, newRecord.updated_at, JSON.stringify(updatedOld), oldId);
      if (res.changes === 0) {
        throw new Error(`supersede: record '${oldId}' was concurrently superseded — retry against the current version`);
      }
      this.logActivity('updated', newRecord, newRecord.updated_at);
    });
    return newRecord;
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
  updateTodo(id: string, newInput: unknown): DurableRecord {
    const old = this.get(id);
    if (!old) throw new Error(`updateTodo: no record '${id}'`);
    if (old.type !== 'todo') throw new Error(`updateTodo: '${id}' is a ${old.type}, not a todo — board_update only mutates todos`);
    if (old.status === 'superseded') throw new Error(`updateTodo: record '${id}' is already superseded`);
    const candidate = { ...(newInput as Record<string, unknown>) };
    const updated = validateRecord(candidate) as DurableRecord;
    if (updated.type !== 'todo') throw new Error(`updateTodo: type mismatch ('${updated.type}' is not 'todo')`);
    const entry = RECORD_TYPES.todo;
    this.tx(() => {
      const res = this.db
        .prepare("UPDATE records SET updated_at = ?, body = ? WHERE id = ? AND status != 'superseded'")
        .run(updated.updated_at, JSON.stringify(updated), id);
      if (res.changes === 0) {
        throw new Error(`updateTodo: record '${id}' was concurrently removed or superseded — retry against the current version`);
      }
      // file_keys may have changed — rebuild the join index rather than diffing it.
      this.db.prepare('DELETE FROM record_file_keys WHERE record_id = ?').run(id);
      for (const path of new Set(entry.fileKeys(updated as unknown as Record<string, unknown>))) {
        this.db.prepare('INSERT INTO record_file_keys (record_id, path) VALUES (?, ?)').run(id, path);
      }
      // text may have changed — refresh the FTS row in place (this table is not
      // an external-content fts5 table, so a plain UPDATE is well-formed).
      this.db.prepare('UPDATE records_fts SET text = ? WHERE record_id = ?').run(entry.fts(updated as unknown as Record<string, unknown>), id);
    });
    return updated;
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
    const record = this.get(id);
    if (!record) throw new Error(`retireInFavorOf: no record '${id}'`);
    // Same relaxation + in-tx guard as supersede (audit findings 13/43 + 29/43):
    // only a terminal (already-superseded) record is refused; the status guard on
    // the UPDATE closes the check-then-act race.
    if (record.status === 'superseded') throw new Error(`retireInFavorOf: record '${id}' is already superseded`);
    const retired = { ...record, status: 'superseded' as const, superseded_by: replacementId, updated_at: at };
    this.tx(() => {
      const res = this.db
        .prepare("UPDATE records SET status = ?, superseded_by = ?, updated_at = ?, body = ? WHERE id = ? AND status != 'superseded'")
        .run('superseded', replacementId, at, JSON.stringify(retired), id);
      if (res.changes === 0) {
        throw new Error(`retireInFavorOf: record '${id}' was concurrently superseded — retry`);
      }
      this.logActivity(verb, retired as DurableRecord, at);
    });
    return retired;
  }

  /**
   * Hard removal — the P4 path for todos (done = removed by the artifact-write
   * event) . Policy for everything else (gated cleanup, §8.4) lives above the store.
   * Removing a SYSTEM-source todo appends to the capped queue drain log
   * (§3.2.7 audit projection — "was X handled?"); user todos are never logged.
   */
  remove(id: string, drainedAt?: string): void {
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
      this.db.prepare('DELETE FROM record_links WHERE source_id = ?').run(id);
      // ALSO delete inbound edges (audit finding 31/43): a record that linked TO
      // the removed one kept a record_links row pointing at a nonexistent id, so
      // the idx_links_target reverse-traversal surface accrued dangling edges.
      this.db.prepare('DELETE FROM record_links WHERE target_id = ?').run(id);
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
    return this.db
      .prepare('SELECT drained_at, system_reason FROM queue_drain_log WHERE record_id = ? ORDER BY seq DESC LIMIT 1')
      .get(id) as { drained_at: string; system_reason: string } | undefined;
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
    for (let i = 0; i < attempts; i++) {
      const row = this.db.prepare('SELECT body, machine_state, pending_exit FROM runs WHERE id = ?').get(runId) as
        | { body: string; machine_state: string; pending_exit: string | null }
        | undefined;
      if (!row) throw new Error(`casTransitionMerge: no run '${runId}'`);
      if (row.machine_state !== observed) {
        throw new Error(
          `CAS rejected: run '${runId}' is not in observed state '${observed}' — stale caller; re-read run_state, never re-apply (§5.2)`
        );
      }
      const current = runRecordSchema.parse(JSON.parse(row.body)) as RunRecord;
      const next = runRecordSchema.parse(mutate(current)) as RunRecord;
      const tail = SterlingStore.serializePendingQueue(SterlingStore.parsePendingQueue(row.pending_exit).slice(1));
      const res = this.db
        .prepare(
          'UPDATE runs SET machine_state = ?, pending_exit = ?, body = ?, updated_at = ? WHERE id = ? AND body = ? AND machine_state = ? AND pending_exit IS ?'
        )
        .run(next.machine_state, tail, JSON.stringify(next), new Date().toISOString(), runId, row.body, observed, row.pending_exit);
      if (res.changes === 1) return next;
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
    const handoff = handoffSchema.parse(input);
    if (!this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId)) {
      throw new Error(`writeHandoff: no run '${runId}'`);
    }
    this.db
      .prepare('INSERT INTO handoffs (run_id, phase_id, agent_role, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, handoff.phase_id, handoff.agent_role, JSON.stringify(handoff), at);
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
    for (let i = 0; i < attempts; i++) {
      const row = this.db.prepare('SELECT body FROM runs WHERE id = ?').get(runId) as { body: string } | undefined;
      if (!row) throw new Error(`updateRunOptimistic: no run '${runId}'`);
      const current = JSON.parse(row.body) as RunRecord;
      const next = runRecordSchema.parse(mutate(current));
      if (next.machine_state !== current.machine_state) {
        throw new Error('updateRunOptimistic: machine_state changes go through casTransition only (§5.2)');
      }
      const res = this.db
        .prepare('UPDATE runs SET body = ?, updated_at = ? WHERE id = ? AND body = ?')
        .run(JSON.stringify(next), new Date().toISOString(), runId, row.body);
      if (res.changes === 1) return next;
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
    this.db
      .prepare('INSERT INTO selection (slot, type, record_id, at) VALUES (1, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET type = excluded.type, record_id = excluded.record_id, at = excluded.at')
      .run(type, recordId, at);
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
   */
  renameFileKey(oldPath: string, newPath: string): number {
    const from = normalizeRepoPath(oldPath);
    const to = normalizeRepoPath(newPath);
    const rows = this.db.prepare('SELECT record_id FROM record_file_keys WHERE path = ?').all(from) as { record_id: string }[];
    this.tx(() => {
      for (const { record_id } of rows) {
        const record = this.get(record_id);
        if (!record) continue;
        const rewritten = validateRecord(deepReplaceString(record as unknown, from, to));
        this.db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify(rewritten), record_id);
        this.db.prepare('UPDATE record_file_keys SET path = ? WHERE record_id = ? AND path = ?').run(to, record_id, from);
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
    const source = this.get(sourceId);
    if (!source) throw new Error(`addLink: no record '${sourceId}'`);
    if (!targetValidated && !this.get(targetId)) throw new Error(`addLink: no target record '${targetId}'`);
    const parsedRel = linkSchema.shape.rel.parse(rel);
    if (source.links.some((l) => l.rel === parsedRel && l.target_id === targetId)) return source;
    const updated = { ...source, links: [...source.links, { rel: parsedRel, target_id: targetId }] } as DurableRecord;
    this.tx(() => {
      this.db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify(updated), sourceId);
      this.db.prepare('INSERT OR IGNORE INTO record_links (source_id, rel, target_id) VALUES (?, ?, ?)').run(sourceId, parsedRel, targetId);
      // addLink does not bump updated_at (the edge is metadata, not content) —
      // the activity row still needs a real timestamp, so it stamps "now".
      this.logActivity('linked', updated, new Date().toISOString());
    });
    return updated;
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

  private insertRecord(record: DurableRecord): void {
    const entry = RECORD_TYPES[record.type];
    this.db
      .prepare(
        `INSERT INTO records (id, type, status, superseded_by, scope, created_at, updated_at, author, derived_unconfirmed, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.type,
        record.status,
        record.superseded_by,
        record.scope,
        record.created_at,
        record.updated_at,
        record.author,
        record.derived_unconfirmed ? 1 : 0,
        JSON.stringify(record)
      );
    for (const tag of new Set(record.stack_tags)) {
      this.db.prepare('INSERT INTO record_stack_tags (record_id, tag) VALUES (?, ?)').run(record.id, tag);
    }
    for (const path of new Set(entry.fileKeys(record as unknown as Record<string, unknown>))) {
      this.db.prepare('INSERT INTO record_file_keys (record_id, path) VALUES (?, ?)').run(record.id, path);
    }
    for (const link of record.links) {
      this.db
        .prepare('INSERT OR IGNORE INTO record_links (source_id, rel, target_id) VALUES (?, ?, ?)')
        .run(record.id, link.rel, link.target_id);
    }
    this.db.prepare('INSERT INTO records_fts (record_id, text) VALUES (?, ?)').run(
      record.id,
      entry.fts(record as unknown as Record<string, unknown>)
    );
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
