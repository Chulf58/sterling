// The board and its removal journal read together, read-only (decision
// board-issue-mirror-design-required-outcome-snapshot-read-single-writer), for
// the one-way GitHub issue mirror. The project's SQLite file is opened through
// openForeignDbReadOnly, never through SterlingStore (which opens writable and
// runs DDL), and every read happens inside one read transaction, so the board
// and the journal come from the same snapshot: a task is either still on the
// board or already in the journal, never neither and never both.
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardRemovalJournalEntrySchema, type BoardRemovalJournalEntry } from '@sterling/schemas';
import { openForeignDbReadOnly, parseForeignItem } from './handoff.js';
import { boardReadinessOf, SUPPORTED_SCHEMA_VERSION, type BoardItemReadiness, type BoardReadinessInput } from './index.js';

export type BoardSnapshotErrorKind = 'not_sqlite' | 'no_database' | 'unreadable' | 'schema_mismatch' | 'journal_missing' | 'bad_journal_row';

/** The snapshot could not be read; `kind` says why, the message says what to do. Nothing was written. */
export class BoardSnapshotError extends Error {
  override name = 'BoardSnapshotError';
  constructor(
    readonly kind: BoardSnapshotErrorKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

export interface ReadBoardSnapshotOptions {
  /** how long a read waits on a writer's lock (rollback-journal stores), in ms; default 5000 */
  busyTimeoutMs?: number;
  /** epoch ms that claim leases are judged against; default Date.now() */
  now?: number;
  /** the claim lease in minutes; default the store's */
  leaseMinutes?: number;
}

export interface BoardSnapshotItem {
  /** the live user todo as stored, unknown keys kept */
  record: Record<string, unknown>;
  /** the store's own readiness derivation: state (ready, blocked, ...), open blockers and the claim view */
  readiness: BoardItemReadiness;
}

export interface BoardSnapshot {
  /** the store's PRAGMA user_version */
  schema_version: number;
  /** every live user board item, in board order (updated_at DESC, id DESC) */
  items: BoardSnapshotItem[];
  /** live todo rows this build cannot parse, by id; never dropped silently */
  unreadable: { id: string; reason: string }[];
  /** every board removal journal row, oldest first */
  journal: BoardRemovalJournalEntry[];
}

interface JournalRow {
  seq: number | bigint;
  item_id: string;
  slug: string | null;
  text: string;
  source: string;
  objective: string | null;
  priority: string | null;
  outcome: string;
  evidence: string | null;
  note: string | null;
  removed_at: string;
}

/** One board_removal_journal row as a checked entry, or the reason it is not one. Shared with SterlingStore.boardRemovalJournal. */
export function journalRowToEntry(row: JournalRow): BoardRemovalJournalEntry | string {
  let evidence: unknown;
  if (row.evidence !== null) {
    try {
      evidence = JSON.parse(row.evidence);
    } catch {
      return 'its evidence is not valid JSON';
    }
  }
  const parsed = boardRemovalJournalEntrySchema.safeParse({
    seq: Number(row.seq),
    item_id: row.item_id,
    ...(row.slug !== null ? { slug: row.slug } : {}),
    text: row.text,
    source: row.source,
    ...(row.objective !== null ? { objective: row.objective } : {}),
    ...(row.priority !== null ? { priority: row.priority } : {}),
    outcome: row.outcome,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
    removed_at: row.removed_at,
  });
  return parsed.success ? parsed.data : parsed.error.issues.map((i) => `${i.path.join('.') || '(row)'}: ${i.message}`).join('; ');
}

export const JOURNAL_SELECT = 'SELECT seq, item_id, slug, text, source, objective, priority, outcome, evidence, note, removed_at FROM board_removal_journal ORDER BY seq ASC';

/** config.storage of the project, read without writing; absent means SQLite. */
function storageOf(projectRoot: string): string | undefined {
  const p = join(projectRoot, '.sterling', 'config.json');
  let text: string;
  try {
    text = readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw new BoardSnapshotError('unreadable', `board snapshot: ${p} could not be read (${(e as Error)?.message ?? String(e)}).`, { cause: e });
  }
  let raw: { storage?: unknown };
  try {
    raw = JSON.parse(text) as { storage?: unknown };
  } catch (e) {
    throw new BoardSnapshotError('unreadable', `board snapshot: ${p} is not valid JSON, so the storage backend is unknown.`, { cause: e });
  }
  if (raw.storage === undefined) return undefined;
  return typeof raw.storage === 'string' ? raw.storage : String(raw.storage);
}

/**
 * The project's live user board, each item with the store's readiness
 * derivation (boardReadinessOf, the rule board_query uses) and claim view,
 * plus every board removal journal row, read in ONE read transaction on the
 * project's `.sterling/sterling.db`, opened read-only. Nothing is written:
 * no DDL, no pragma write, no checkpoint, and no file beside the database is
 * created or removed.
 *
 * Refused with a BoardSnapshotError, naming why: a project whose
 * config.storage is not SQLite (Postgres is switched off; this reader only
 * opens SQLite), a missing or unreadable database, a schema version other than
 * the one this build supports, a store no Sterling with the journal has opened
 * yet (open any Sterling session there once, which creates the table), and a
 * journal row that fails its schema.
 */
export function readBoardSnapshot(projectRoot: string, opts: ReadBoardSnapshotOptions = {}): BoardSnapshot {
  const storage = storageOf(projectRoot);
  if (storage !== undefined && storage !== 'sqlite') {
    throw new BoardSnapshotError('not_sqlite', `board snapshot: ${projectRoot} stores its knowledge in '${storage}', and the board snapshot reads SQLite only. Nothing was read.`);
  }
  const dbPath = join(projectRoot, '.sterling', 'sterling.db');
  let db: DatabaseSync;
  try {
    db = openForeignDbReadOnly(dbPath, opts.busyTimeoutMs ?? 5000);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.startsWith('no database at')) throw new BoardSnapshotError('no_database', `board snapshot: ${msg}.`, { cause: e });
    throw new BoardSnapshotError('unreadable', `board snapshot: ${dbPath} could not be opened read-only (${msg}).`, { cause: e });
  }
  try {
    db.exec('BEGIN');
    try {
      return readInside(db, dbPath, opts);
    } finally {
      db.exec('ROLLBACK');
    }
  } catch (e) {
    if (e instanceof BoardSnapshotError) throw e;
    throw new BoardSnapshotError('unreadable', `board snapshot: reading ${dbPath} failed (${(e as Error)?.message ?? String(e)}). Nothing was written.`, { cause: e });
  } finally {
    db.close();
  }
}

function readInside(db: DatabaseSync, dbPath: string, opts: ReadBoardSnapshotOptions): BoardSnapshot {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number | bigint }).user_version);
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    throw new BoardSnapshotError(
      'schema_mismatch',
      `board snapshot: ${dbPath} is at schema version ${version} and this Sterling reads version ${SUPPORTED_SCHEMA_VERSION}; ${version < SUPPORTED_SCHEMA_VERSION ? 'migrate the store first' : 'update Sterling'}. Nothing was read.`
    );
  }
  const hasJournal = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_removal_journal'`).get() !== undefined;
  if (!hasJournal) {
    throw new BoardSnapshotError(
      'journal_missing',
      `board snapshot: ${dbPath} has no board_removal_journal table yet; open a Sterling session in that project once (it creates the table), then read again. Nothing was read.`
    );
  }
  type ScanRow = { id: string; body: string; ok: number; source: unknown; slug: unknown; text: unknown };
  const rows = db
    .prepare(
      `SELECT id, body, json_valid(body) AS ok,
         CASE WHEN json_valid(body) THEN json_extract(body, '$.source') END AS source,
         CASE WHEN json_valid(body) THEN json_extract(body, '$.slug') END AS slug,
         CASE WHEN json_valid(body) THEN json_extract(body, '$.text') END AS text
       FROM records WHERE type = 'todo' AND status != 'superseded' ORDER BY updated_at DESC, id DESC`
    )
    .all() as ScanRow[];
  const items: Record<string, unknown>[] = [];
  const unreadable: { id: string; reason: string }[] = [];
  const slugHolders = new Map<string, { id: string; text?: string; slug: string }>();
  for (const row of rows) {
    if (!row.ok) {
      unreadable.push({ id: row.id, reason: 'the stored body is not valid JSON' });
      continue;
    }
    if (typeof row.slug === 'string' && row.slug.length > 0) {
      slugHolders.set(row.slug, { id: row.id, slug: row.slug, ...(typeof row.text === 'string' ? { text: row.text } : {}) });
    }
    if (row.source === 'system') continue;
    const parsed = parseForeignItem(row.id, row.body);
    if (typeof parsed === 'string') unreadable.push({ id: row.id, reason: parsed });
    else items.push(parsed);
  }
  const inputs = items as unknown as BoardReadinessInput[];
  const readiness = new Map(
    boardReadinessOf(inputs, inputs, (slug) => slugHolders.get(slug), {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.leaseMinutes !== undefined ? { leaseMinutes: opts.leaseMinutes } : {}),
    }).map((r) => [r.id, r])
  );
  const journal: BoardRemovalJournalEntry[] = [];
  for (const row of db.prepare(JOURNAL_SELECT).all() as unknown as JournalRow[]) {
    const entry = journalRowToEntry(row);
    if (typeof entry === 'string') {
      throw new BoardSnapshotError('bad_journal_row', `board snapshot: board_removal_journal row ${String(row.seq)} (item ${row.item_id}) is not a journal entry: ${entry}. Nothing was returned.`);
    }
    journal.push(entry);
  }
  const out: BoardSnapshotItem[] = [];
  for (const record of items) {
    const r = readiness.get(String(record.id));
    if (r) out.push({ record, readiness: r });
    else unreadable.push({ id: String(record.id), reason: `the readiness rule does not read it (source ${String(record.source)})` });
  }
  return { schema_version: version, items: out, unreadable, journal };
}
