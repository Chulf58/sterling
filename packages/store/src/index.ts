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
import { z } from 'zod';
import {
  RECORD_TYPES,
  validateRecord,
  normalizeRepoPath,
  handoffSchema,
  runRecordSchema,
  type DurableRecord,
  type Handoff,
  type MachineState,
  type RunRecord,
} from '@sterling/schemas';

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

// §3.4: rank_terms are plain keywords — an array of single terms with a
// per-term length cap; a keyword array cannot smuggle in a freeform question.
export const rankTerms = z.array(z.string().regex(/^\S{1,64}$/, 'rank_terms must be single keywords (no whitespace, ≤64 chars)')).max(16);

export interface QueryOptions {
  types?: string[];
  stack_tags?: string[];
  file_keys?: string[];
  rank_terms?: string[];
  include_unconfirmed?: boolean;
  cap?: number;
}

export class SterlingStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(DDL);
  }

  journalMode(): string {
    return (this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  }

  /** The one validated write path. Unregistered type or malformed record throws; nothing is written. */
  create(input: unknown): DurableRecord {
    const record = validateRecord(input);
    this.tx(() => this.insertRecord(record));
    return record;
  }

  get(id: string): DurableRecord | undefined {
    const row = this.db.prepare('SELECT body FROM records WHERE id = ?').get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as DurableRecord) : undefined;
  }

  /** Retrieval discipline (§3.4): filter → file-key join → rank (bm25 or mechanical fallback) → cap. */
  query(opts: QueryOptions = {}): DurableRecord[] {
    const cap = opts.cap ?? 20;
    const params: (string | number)[] = [];
    const where: string[] = ["r.status = 'active'"];
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

    if (opts.rank_terms !== undefined) {
      const terms = rankTerms.parse(opts.rank_terms);
      if (terms.length) {
        const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
        const sql = `SELECT r.body FROM records r JOIN records_fts f ON f.record_id = r.id
          WHERE ${where.join(' AND ')} AND records_fts MATCH ?
          ORDER BY bm25(records_fts) ASC, r.updated_at DESC LIMIT ?`;
        const rows = this.db.prepare(sql).all(...params, match, cap) as { body: string }[];
        return rows.map((x) => JSON.parse(x.body) as DurableRecord);
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
    return rows.map((x) => JSON.parse(x.body) as DurableRecord);
  }

  /**
   * Versioned change (§3.2.3, §3.1 criterion 3): the new record supersedes the
   * old; the old is retained with status 'superseded' + superseded_by set.
   * This is the ONLY change path for immutable types (decision, §3.2.1).
   */
  supersede(oldId: string, newInput: unknown): DurableRecord {
    const oldRecord = this.get(oldId);
    if (!oldRecord) throw new Error(`supersede: no record '${oldId}'`);
    if (oldRecord.status !== 'active') throw new Error(`supersede: record '${oldId}' is not active`);
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
      this.db
        .prepare('UPDATE records SET status = ?, superseded_by = ?, updated_at = ?, body = ? WHERE id = ?')
        .run('superseded', newRecord.id, newRecord.updated_at, JSON.stringify(updatedOld), oldId);
    });
    return newRecord;
  }

  /**
   * Hard removal — the P4 path for todos (done = removed by the artifact-write
   * event) . Policy for everything else (gated cleanup, §8.4) lives above the store.
   */
  remove(id: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM record_stack_tags WHERE record_id = ?').run(id);
      this.db.prepare('DELETE FROM record_file_keys WHERE record_id = ?').run(id);
      this.db.prepare('DELETE FROM record_links WHERE source_id = ?').run(id);
      this.db.prepare('DELETE FROM records_fts WHERE record_id = ?').run(id);
    });
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
    const active = this.getRun();
    if (active) {
      throw new Error(`createRun: run '${active.id}' is still active (${active.machine_state}) — one active run at a time`);
    }
    this.db
      .prepare('INSERT INTO runs (id, machine_state, pending_exit, body, updated_at) VALUES (?, ?, NULL, ?, ?)')
      .run(run.id, run.machine_state, JSON.stringify(run), run.started_at);
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
   * §5.2 brain transition: atomic compare-and-swap on machine_state
   * (UPDATE … WHERE machine_state = <observed>). Zero rows updated means the
   * caller carried stale state — rejected loudly, never re-applied. Clears any
   * pending exit (it is consumed by the transition).
   */
  casTransition(observed: MachineState, next: unknown): RunRecord {
    const run = runRecordSchema.parse(next);
    const res = this.db
      .prepare('UPDATE runs SET machine_state = ?, pending_exit = NULL, body = ?, updated_at = ? WHERE id = ? AND machine_state = ?')
      .run(run.machine_state, JSON.stringify(run), new Date().toISOString(), run.id, observed);
    if (res.changes === 0) {
      throw new Error(
        `CAS rejected: run '${run.id}' is not in observed state '${observed}' — stale caller; re-read run_state, never re-apply (§5.2)`
      );
    }
    return run;
  }

  /** agent_exit lands here; run_signal consumes it. An unconsumed exit is never silently overwritten (P5). */
  recordPendingExit(runId: string, exit: RecordedExit): void {
    const existing = this.getPendingExit(runId);
    if (existing) {
      throw new Error(
        `recordPendingExit: run '${runId}' already has an unconsumed exit ('${existing.signal}' from ${existing.agent_role ?? 'unknown'}) — call run_signal first`
      );
    }
    const res = this.db.prepare('UPDATE runs SET pending_exit = ? WHERE id = ?').run(JSON.stringify(exit), runId);
    if (res.changes === 0) throw new Error(`recordPendingExit: no run '${runId}'`);
  }

  getPendingExit(runId: string): RecordedExit | undefined {
    const row = this.db.prepare('SELECT pending_exit FROM runs WHERE id = ?').get(runId) as
      | { pending_exit: string | null }
      | undefined;
    if (!row) throw new Error(`getPendingExit: no run '${runId}'`);
    return row.pending_exit ? (JSON.parse(row.pending_exit) as RecordedExit) : undefined;
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
   * Append an escalation/warn entry to the run record (H6 context warns land
   * here, §6). Optimistic concurrency: hooks write concurrently with the
   * brain, so the append retries on body change and fails loudly if it keeps
   * losing the race — never a silent drop (P5).
   */
  appendRunEscalation(runId: string, entry: unknown, attempts = 5): void {
    for (let i = 0; i < attempts; i++) {
      const row = this.db.prepare('SELECT body FROM runs WHERE id = ?').get(runId) as { body: string } | undefined;
      if (!row) throw new Error(`appendRunEscalation: no run '${runId}'`);
      const run = JSON.parse(row.body) as RunRecord;
      run.escalations.push(entry);
      const res = this.db
        .prepare('UPDATE runs SET body = ?, updated_at = ? WHERE id = ? AND body = ?')
        .run(JSON.stringify(run), new Date().toISOString(), runId, row.body);
      if (res.changes === 1) return;
    }
    throw new Error(`appendRunEscalation: lost the optimistic race ${attempts}x for run '${runId}' (P5: failing loudly)`);
  }

  /** §16.1.9: every unimplemented full-spec check emits check_skipped where it would have run — never silent success. */
  recordCheckSkipped(check: string, reason: string, runId: string | undefined, at: string): void {
    this.db
      .prepare('INSERT INTO check_skipped (run_id, check_name, reason, at) VALUES (?, ?, ?, ?)')
      .run(runId ?? null, check, reason, at);
  }

  listCheckSkipped(runId?: string): { run_id: string | null; check_name: string; reason: string; at: string }[] {
    return (
      runId
        ? this.db.prepare('SELECT run_id, check_name, reason, at FROM check_skipped WHERE run_id = ? ORDER BY seq').all(runId)
        : this.db.prepare('SELECT run_id, check_name, reason, at FROM check_skipped ORDER BY seq').all()
    ) as { run_id: string | null; check_name: string; reason: string; at: string }[];
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
