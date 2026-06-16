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
  linkSchema,
  handoffSchema,
  runRecordSchema,
  type DurableRecord,
  type Handoff,
  type MachineState,
  type RunRecord,
} from '@sterling/schemas';

export { MountedStores, type DomainMount } from './mounted.js';

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

function deepReplaceString(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) return value.map((v) => deepReplaceString(v, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepReplaceString(v, from, to)]));
  }
  return value;
}

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

// The store surface the §10 tool layer drives — exactly the methods SterlingTools
// calls, no more. Both SterlingStore (single project store) and MountedStores
// (project + mounted domains) satisfy it, so the tools are agnostic to whether
// domain stores are mounted. Derived via Pick so the signatures never drift.
export type ToolStore = Pick<
  SterlingStore,
  | 'create'
  | 'query'
  | 'get'
  | 'supersede'
  | 'retireInFavorOf'
  | 'remove'
  | 'addLink'
  | 'getRun'
  | 'casTransition'
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

    if (opts.rank_terms !== undefined) {
      const terms = rankTerms.parse(opts.rank_terms);
      if (terms.length) {
        // a trailing '*' marks an FTS5 prefix query ("stor*" matches "store") —
        // the star must sit OUTSIDE the quoted token to act as the prefix operator
        const match = terms
          .map((t) => (t.endsWith('*') && t.length > 1 ? `"${t.slice(0, -1).replace(/"/g, '""')}"*` : `"${t.replace(/"/g, '""')}"`))
          .join(' OR ');
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
   * Promotion tombstone (§3.3 project→domain): retire a record IN FAVOR OF a
   * replacement that lives in ANOTHER store (the promoted copy in a domain
   * store). supersede can't cross stores and always inserts a same-store
   * replacement; this sets the existing record to superseded + superseded_by =
   * the cross-store id with NO new row. Provenance and inbound links survive;
   * default queries already hide superseded records, so it never double-serves.
   */
  retireInFavorOf(id: string, replacementId: string, at: string): DurableRecord {
    const record = this.get(id);
    if (!record) throw new Error(`retireInFavorOf: no record '${id}'`);
    if (record.status !== 'active') throw new Error(`retireInFavorOf: record '${id}' is not active`);
    const retired = { ...record, status: 'superseded' as const, superseded_by: replacementId, updated_at: at };
    this.tx(() => {
      this.db
        .prepare('UPDATE records SET status = ?, superseded_by = ?, updated_at = ?, body = ? WHERE id = ?')
        .run('superseded', replacementId, at, JSON.stringify(retired), id);
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
      if (record && record.type === 'todo' && record.source === 'system') {
        this.db
          .prepare('INSERT INTO queue_drain_log (drained_at, system_reason, text, file_keys) VALUES (?, ?, ?, ?)')
          .run(drainedAt ?? new Date().toISOString(), record.system_reason ?? '', record.text ?? '', JSON.stringify(record.file_keys ?? []));
        // cap: completed items must never build up (adjudicated 2026-06-12)
        this.db
          .prepare('DELETE FROM queue_drain_log WHERE seq NOT IN (SELECT seq FROM queue_drain_log ORDER BY seq DESC LIMIT 50)')
          .run();
      }
      this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM record_stack_tags WHERE record_id = ?').run(id);
      this.db.prepare('DELETE FROM record_file_keys WHERE record_id = ?').run(id);
      this.db.prepare('DELETE FROM record_links WHERE source_id = ?').run(id);
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

  /** H8 (§6): per-agent-type dispatch counter; returns the new count. Respawns count too. */
  incrementDispatchCount(runId: string, agentType: string): number {
    const next = this.updateRunOptimistic(runId, (run) => ({
      ...run,
      dispatch_counts: { ...run.dispatch_counts, [agentType]: (run.dispatch_counts[agentType] ?? 0) + 1 },
    }));
    return next.dispatch_counts[agentType];
  }

  /** H11 (§3.2.6): append extraction ids to a note's derived[] — raw_text is never touched. */
  appendNoteDerived(noteId: string, derivedIds: string[]): void {
    const note = this.get(noteId);
    if (!note || note.type !== 'note') throw new Error(`appendNoteDerived: '${noteId}' is not a note`);
    const updated = validateRecord({ ...note, derived: [...new Set([...(note as { derived: string[] }).derived, ...derivedIds])] });
    this.db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify(updated), noteId);
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

  /** knowledge_link (§10): typed graph edge, traversable both directions (§3.1 c4). */
  addLink(sourceId: string, rel: string, targetId: string): DurableRecord {
    const source = this.get(sourceId);
    if (!source) throw new Error(`addLink: no record '${sourceId}'`);
    if (!this.get(targetId)) throw new Error(`addLink: no target record '${targetId}'`);
    const parsedRel = linkSchema.shape.rel.parse(rel);
    if (source.links.some((l) => l.rel === parsedRel && l.target_id === targetId)) return source;
    const updated = { ...source, links: [...source.links, { rel: parsedRel, target_id: targetId }] };
    this.tx(() => {
      this.db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify(updated), sourceId);
      this.db.prepare('INSERT OR IGNORE INTO record_links (source_id, rel, target_id) VALUES (?, ?, ?)').run(sourceId, parsedRel, targetId);
    });
    return updated as DurableRecord;
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
