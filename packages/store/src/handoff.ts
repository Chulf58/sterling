// Cross-project handoff, the SENDER's read side (GitHub issue #105, user-ruled
// 2026-10-15). A tracker item (todo body handoff.role 'sent') stands on the
// sending project's board for a task written into a sibling project's store.
// Its status is resolved at READ time and nothing is written: the receiver's
// item is looked up by its full uuid in the receiver's database, opened
// read-only, and a closure file the receiver's board_remove writes tells
// "done" apart from "gone". The receiver never writes the sender's database,
// and this reader never writes the receiver's.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HANDOFFS_DIR_REL, handoffClosureReadSchema, handoffEvidenceFileReadSchema, todoBoardItemReadSchema, todoHandoffReadSchema, todoWaitFieldsReadSchema, type HandoffEvidence, type TodoHandoff } from '@sterling/schemas';

export type SentHandoff = Extract<TodoHandoff, { role: 'sent' }>;

/** open: the item is on the receiver's board. needs_user: it is there and
 *  marked needs 'user' or 'grill'. blocked: it is there and at least one of its
 *  blockers is still a live board item in the receiver's store. done: it was
 *  removed and its closure file says so. gone: removed with no closure file (an older
 *  receiver, or a hand delete), so completion is unverified. unknown: the
 *  receiver could not be read or its row does not match. unconfirmed: the
 *  receiver's item id was never recorded (delivery did not finish). */
export type HandoffStatusState = 'open' | 'needs_user' | 'blocked' | 'done' | 'gone' | 'unknown' | 'unconfirmed';

export interface HandoffStatus {
  state: HandoffStatusState;
  /** the one line a board shows for the tracker */
  text: string;
  closed_at?: string;
  note?: string;
  /** the milestone the hand-off named (GitHub issue #108), on every state */
  milestone?: string;
  /** what the receiver said it did when it closed the item; only on done, and only from a valid sidecar for this hand-off */
  evidence?: HandoffEvidence;
}

/** The sent-handoff metadata of a tracker body, or undefined when the item is not a valid tracker. */
export function sentHandoffOf(rec: { handoff?: unknown }): SentHandoff | undefined {
  if (rec.handoff === undefined) return undefined;
  const parsed = todoHandoffReadSchema.safeParse(rec.handoff);
  return parsed.success && parsed.data.role === 'sent' ? parsed.data : undefined;
}

/** The SQLite file-format write version (header byte 18): 1 = rollback journal, 2 = WAL. */
function journalTopology(path: string): 'wal' | 'rollback' {
  const header = Buffer.alloc(100);
  const fd = openSync(path, 'r');
  let read: number;
  try {
    read = readSync(fd, header, 0, 100, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 100 || header.toString('latin1', 0, 16) !== 'SQLite format 3\u0000') throw new Error(`${path} is not a SQLite database`);
  return header[18] === 2 ? 'wal' : 'rollback';
}

/**
 * Open another project's SQLite database without writing to it or beside it.
 * The journal topology decides how:
 *   - WAL mode with a -wal (the receiver's server is running): a plain
 *     read-only open, which is WAL-aware and sees every committed frame.
 *   - WAL mode with no -wal: every committed frame is in the main file and a
 *     plain read-only open would need to create -wal/-shm, so an immutable
 *     open reads it whole and creates nothing. The gap: a commit between the
 *     -wal check and the read is missed until the next read.
 *   - rollback journal (DELETE mode, decision store-journal-policy-delete-on-9p):
 *     a plain read-only open, never immutable. An immutable reader ignores the
 *     locks and the -journal, so it would read a writer's uncommitted, spilled
 *     pages; a normal reader waits on the lock (busy timeout) instead.
 * Nothing beside the database is ever removed (anti-pattern
 * a-writable-sqlite-open-on-a-wal-database-mutates-the-main-fi). A missing
 * file is "no database at <path>"; any other open failure is thrown with its
 * own reason.
 */
export function openForeignDbReadOnly(path: string, busyTimeoutMs: number): DatabaseSync {
  let topology: 'wal' | 'rollback';
  try {
    topology = journalTopology(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error(`no database at ${path}`);
    throw e;
  }
  let db: DatabaseSync;
  if (topology === 'rollback' || existsSync(`${path}-wal`)) {
    db = new DatabaseSync(path, { readOnly: true });
  } else {
    const url = pathToFileURL(path);
    url.searchParams.set('immutable', '1');
    db = new DatabaseSync(url, { readOnly: true });
  }
  setBusyTimeout(db, busyTimeoutMs);
  return db;
}

function setBusyTimeout(db: DatabaseSync, ms: number): void {
  db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(ms))}`);
}

/** A file's text, or undefined when it does not exist; any other read error (EACCES, EISDIR, …) is thrown. */
function readIfPresent(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw e;
  }
}

const EVIDENCE_LABELS: [keyof HandoffEvidence, string][] = [['commit', 'commit'], ['pr', 'PR'], ['deploy', 'deploy'], ['url', 'url']];

function evidenceText(e: HandoffEvidence): string {
  return EVIDENCE_LABELS.filter(([k]) => e[k] !== undefined).map(([k, label]) => `${label} ${e[k]}`).join(', ');
}

/**
 * The evidence sidecar `<transfer_id>.evidence.json` beside the closure file
 * (GitHub issue #108), or undefined. Read tolerantly: a missing, unreadable,
 * malformed or other hand-off's sidecar is no evidence, never proof and never
 * a reason to doubt the closure. Blank values are dropped.
 */
function readEvidence(h: SentHandoff & { to_item_id: string }): HandoffEvidence | undefined {
  let parsed;
  try {
    const text = readIfPresent(join(h.to_root, HANDOFFS_DIR_REL, `${h.transfer_id}.evidence.json`));
    if (text === undefined) return undefined;
    parsed = handoffEvidenceFileReadSchema.safeParse(JSON.parse(text));
  } catch {
    // An unreadable or unparsable sidecar is no evidence; the closure file alone decides done.
    return undefined;
  }
  if (!parsed.success || parsed.data.transfer_id !== h.transfer_id || parsed.data.item_id !== h.to_item_id) return undefined;
  const out: HandoffEvidence = {};
  for (const [k] of EVIDENCE_LABELS) {
    const v = parsed.data.evidence[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

const statusText = {
  open: (to: string) => `open in ${to}`,
  needs_user: (to: string, reason?: string) => `needs user in ${to}${reason ? `: ${reason}` : ''}`,
  blocked: (to: string) => `blocked in ${to}`,
  done: (to: string, closedAt: string, note?: string, milestone?: string, evidence?: HandoffEvidence) => {
    const head = milestone === undefined ? `DONE in ${to} ${closedAt}` : evidence ? `DONE in ${to} ${closedAt} (${milestone})` : `DONE in ${to} ${closedAt}, unverified (${milestone})`;
    const parts = [evidence ? evidenceText(evidence) : undefined, note].filter((p): p is string => p !== undefined && p.length > 0);
    return parts.length ? `${head}: ${parts.join('; ')}` : head;
  },
  gone: (to: string) => `gone from ${to}'s board, completion unverified`,
  unknown: (reason: string) => `status unknown: ${reason}`,
  unconfirmed: () => 'delivery unconfirmed',
};

function unknown(reason: string): HandoffStatus {
  return { state: 'unknown', text: statusText.unknown(reason) };
}

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

/** The receiver's storage from its config.json; a non-SQLite receiver has no file to read. Only a missing file means "no setting". */
function receiverStorage(root: string): string | undefined {
  const text = readIfPresent(join(root, '.sterling', 'config.json'));
  if (text === undefined) return undefined;
  const raw = JSON.parse(text) as { storage?: unknown };
  return typeof raw.storage === 'string' ? raw.storage : undefined;
}

function closureStatus(h: SentHandoff & { to_item_id: string }): HandoffStatus {
  const p = join(h.to_root, HANDOFFS_DIR_REL, `${h.transfer_id}.json`);
  // Read directly: only ENOENT means there is no closure file. A permission
  // error must not read as "gone", because the file may be there.
  let text: string | undefined;
  let parsed;
  try {
    text = readIfPresent(p);
    if (text === undefined) return { state: 'gone', text: statusText.gone(h.to_name) };
    parsed = handoffClosureReadSchema.safeParse(JSON.parse(text));
  } catch (e) {
    return unknown(`the closure file ${p} is unreadable (${errText(e)})`);
  }
  if (!parsed.success) return unknown(`the closure file ${p} is not a closure record (${parsed.error.issues.map((i) => i.message).join('; ')})`);
  const c = parsed.data;
  if (c.transfer_id !== h.transfer_id || c.item_id !== h.to_item_id) {
    return unknown(`the closure file ${p} names transfer ${c.transfer_id} item ${c.item_id}, not transfer ${h.transfer_id} item ${h.to_item_id}`);
  }
  const evidence = readEvidence(h);
  return {
    state: 'done',
    text: statusText.done(h.to_name, c.closed_at, c.note, h.milestone, evidence),
    closed_at: c.closed_at,
    ...(c.note ? { note: c.note } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

/**
 * One tracker's status against an already-open receiver database. Precedence
 * (decision handoff-needs-user-blocked-milestone-evidence-pull-only-skew-safe):
 * needs 'user' or 'grill' first, then a blocker that is still a live board
 * item there (blocked_by keeps the slugs of removed blockers, so a slug no live
 * todo carries is closed, the rule board readiness uses), then open. needs
 * 'investigation' reads open. The fields are read through the shared
 * todoWaitFieldsReadSchema, so its needs_reason rule holds here too. The time
 * budget is checked before each blocker lookup, caps that lookup's busy
 * timeout, and is checked again after it; running out reads unknown, never
 * open or blocked.
 */
function rowStatus(db: DatabaseSync, trackerId: string, h: SentHandoff & { to_item_id: string }, budget: LookupBudget): HandoffStatus {
  const row = db.prepare('SELECT body, status FROM records WHERE id = ?').get(h.to_item_id) as { body: string; status: string } | undefined;
  if (!row) return closureStatus(h);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(row.body) as Record<string, unknown>;
  } catch (e) {
    return unknown(`${h.to_name}'s row ${h.to_item_id} is not valid JSON (${errText(e)})`);
  }
  if (body.type !== 'todo') return unknown(`${h.to_name}'s record ${h.to_item_id} is a ${String(body.type)}, not a board item`);
  if (row.status === 'superseded') return unknown(`${h.to_name}'s item ${h.to_item_id} is superseded, which a board item never is`);
  // Matched on the uuid alone; the metadata is then checked, and a missing or
  // different one reads as unknown, never as absent or open.
  if (body.handoff === undefined) return unknown(`${h.to_name}'s item ${h.to_item_id.slice(0, 8)} carries no handoff record (an older Sterling there may have dropped it on an edit)`);
  const meta = todoHandoffReadSchema.safeParse(body.handoff);
  if (!meta.success || meta.data.role !== 'received' || meta.data.transfer_id !== h.transfer_id || meta.data.from_item_id !== trackerId) {
    return unknown(`${h.to_name}'s item ${h.to_item_id.slice(0, 8)} carries handoff metadata for a different transfer`);
  }
  const waitParsed = todoWaitFieldsReadSchema.safeParse(body);
  if (!waitParsed.success) {
    return unknown(`${h.to_name}'s item ${h.to_item_id.slice(0, 8)} cannot be read: ${waitParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const wait = waitParsed.data;
  if (wait.needs === 'user' || wait.needs === 'grill') return { state: 'needs_user', text: statusText.needs_user(h.to_name, wait.needs_reason?.trim()) };
  if (wait.blocked_by?.length) {
    const live = db.prepare(`SELECT 1 FROM records WHERE type = 'todo' AND status != 'superseded' AND json_extract(body, '$.slug') = ? LIMIT 1`);
    for (const slug of new Set(wait.blocked_by)) {
      const where = `${h.to_name}'s blocker ${slug}`;
      const before = budget.remaining();
      if (before <= 0) return unknown(budget.exhausted(where));
      setBusyTimeout(db, Math.min(budget.busy, before));
      const found = live.get(slug) !== undefined;
      if (budget.remaining() <= 0) return unknown(budget.exhausted(`the result for ${where}`));
      if (found) return { state: 'blocked', text: statusText.blocked(h.to_name) };
    }
  }
  return { state: 'open', text: statusText.open(h.to_name) };
}

interface LookupBudget {
  /** ms left in the budget; zero or less means no further lookup may start */
  remaining: () => number;
  exhausted: (where: string) => string;
  /** the per-lookup busy timeout before capping to what is left */
  busy: number;
}

export interface ResolveSentHandoffsOptions {
  /** SQLite busy timeout per receiver database (default 250 ms) */
  busyTimeoutMs?: number;
  /** total time for the whole call; receivers not reached in time read unknown (default 1500 ms) */
  budgetMs?: number;
  /** injectable clock for the budget, in ms */
  clock?: () => number;
}

/**
 * The status of each tracker, keyed by tracker id. Lookups are grouped by
 * receiver database, so each one is opened once per call; the call is bounded
 * by the total budget, checked before each receiver and each lookup, with every
 * busy timeout capped to what is left of it; lookups not started in time read
 * "status unknown: time budget exhausted ...". Never throws for one
 * receiver's failure: that receiver's trackers read "status unknown: <reason>".
 */
export function resolveSentHandoffs(
  trackers: readonly { id: string; handoff?: unknown }[],
  opts: ResolveSentHandoffsOptions = {}
): Map<string, HandoffStatus> {
  const busy = opts.busyTimeoutMs ?? 250;
  const budget = opts.budgetMs ?? 1500;
  const clock = opts.clock ?? Date.now;
  const started = clock();
  /** ms left in the budget; zero or less means no further lookup may start */
  const remaining = () => budget - (clock() - started);
  const exhausted = (where: string) => `time budget exhausted (${budget} ms) before ${where} was read`;
  const out = new Map<string, HandoffStatus>();
  const groups = new Map<string, { id: string; h: SentHandoff & { to_item_id: string } }[]>();
  for (const t of trackers) {
    if (t.handoff === undefined) continue;
    const h = sentHandoffOf(t);
    if (!h) {
      out.set(t.id, unknown('this tracker carries handoff metadata this Sterling cannot read'));
      continue;
    }
    if (h.to_item_id === null) {
      out.set(t.id, { state: 'unconfirmed', text: statusText.unconfirmed() });
      continue;
    }
    const list = groups.get(h.to_root) ?? [];
    list.push({ id: t.id, h: h as SentHandoff & { to_item_id: string } });
    groups.set(h.to_root, list);
  }
  for (const [root, list] of groups) {
    const fail = (reason: string) => {
      for (const { id } of list) out.set(id, unknown(reason));
    };
    const left = remaining();
    if (left <= 0) {
      fail(exhausted(root));
      continue;
    }
    let storage: string | undefined;
    try {
      storage = receiverStorage(root);
    } catch (e) {
      fail(`${root}/.sterling/config.json is unreadable (${errText(e)})`);
      continue;
    }
    if (storage !== undefined && storage !== 'sqlite') {
      fail(`${root} now uses ${storage} storage, which this reader does not open`);
      continue;
    }
    let db: DatabaseSync;
    try {
      db = openForeignDbReadOnly(join(root, '.sterling', 'sterling.db'), Math.min(busy, left));
    } catch (e) {
      fail(errText(e));
      continue;
    }
    try {
      for (const { id, h } of list) {
        // The deadline is checked before EVERY lookup, and no lookup may wait
        // on a lock longer than the budget has left.
        const now = remaining();
        if (now <= 0) {
          out.set(id, unknown(exhausted(`${h.to_name}'s item ${h.to_item_id.slice(0, 8)}`)));
          continue;
        }
        try {
          setBusyTimeout(db, Math.min(busy, now));
          out.set(id, rowStatus(db, id, h, { remaining, exhausted, busy }));
        } catch (e) {
          out.set(id, unknown(`${h.to_name}'s database could not be read (${errText(e)})`));
        }
      }
    } finally {
      db.close();
    }
  }
  // The milestone the tracker named rides every state (GitHub issue #108).
  for (const t of trackers) {
    const status = out.get(t.id);
    const milestone = status && sentHandoffOf(t)?.milestone;
    if (status && milestone) out.set(t.id, { ...status, milestone });
  }
  return out;
}

export interface ReadForeignBoardOptions {
  /** SQLite busy timeout, capped before every step to what is left of the budget (default 250 ms) */
  busyTimeoutMs?: number;
  /** total time for the call; running out is disclosed as truncation (default 1500 ms) */
  budgetMs?: number;
  /** injectable clock for the budget, in ms */
  clock?: () => number;
  /** rows per SQLite step of the scan (default 200) */
  batchSize?: number;
}

/** A position in the board order (updated_at DESC, id DESC): a cursor's tuple. */
export interface BoardOrderKey {
  updated_at: string;
  id: string;
}

export interface ForeignBoardRead {
  /** every live user board item read, unknown keys kept; not ordered */
  items: Record<string, unknown>[];
  /** live todo rows that failed the tolerant parse, by id; never dropped silently */
  unreadable: { id: string; reason: string }[];
  /** every live todo carrying a slug, either source: the open-blocker test */
  slugHolders: Map<string, { id: string; text?: string; slug: string }>;
  /** the store's PRAGMA user_version */
  schemaVersion: number;
  /**
   * set when the time budget ran out before the scan finished: the read is
   * partial. With `after`, the rows past that position are read first, so a
   * cursor page is reached before the rows ahead of it are counted.
   */
  truncated?: string;
}

/** The time budget of one cross-project read: checked before and after every SQLite step, with the busy timeout refreshed from what is left. */
class ReadBudget {
  private readonly started: number;
  private readonly busy: number;
  private readonly budget: number;
  private readonly clock: () => number;
  constructor(opts: ReadForeignBoardOptions) {
    this.busy = opts.busyTimeoutMs ?? 250;
    this.budget = opts.budgetMs ?? 1500;
    this.clock = opts.clock ?? Date.now;
    this.started = this.clock();
  }
  remaining(): number {
    return this.budget - (this.clock() - this.started);
  }
  busyTimeout(): number {
    return Math.min(this.busy, Math.max(0, this.remaining()));
  }
  exhausted(where: string): string {
    return `time budget exhausted (${this.budget} ms) ${where}`;
  }
  /** Runs one SQLite step inside the budget, or returns undefined when the budget ran out before or during it. */
  step<T>(db: DatabaseSync, run: () => T): T | undefined {
    const before = this.remaining();
    if (before <= 0) return undefined;
    setBusyTimeout(db, Math.min(this.busy, before));
    const out = run();
    return this.remaining() <= 0 ? undefined : out;
  }
}

const LIVE_TODO = `type = 'todo' AND status != 'superseded'`;
const SCAN_COLUMNS = `id, body, json_valid(body) AS ok,
  CASE WHEN json_valid(body) THEN json_extract(body, '$.source') END AS source,
  CASE WHEN json_valid(body) THEN json_extract(body, '$.slug') END AS slug,
  CASE WHEN json_valid(body) THEN json_extract(body, '$.text') END AS text,
  updated_at AS order_updated_at`;
/** rows strictly after a position in the board order */
const AFTER = `(updated_at < ? OR (updated_at = ? AND id < ?))`;
/** rows at or before a position in the board order */
const UP_TO = `(updated_at > ? OR (updated_at = ? AND id >= ?))`;

type ScanRow = { id: string; body: string; ok: number; source: unknown; slug: unknown; text: unknown; order_updated_at: string };

/** Open the other store, run `read` with the budget, close it. The budget is checked before the open. */
function withForeignDb<T>(dbPath: string, opts: ReadForeignBoardOptions, read: (db: DatabaseSync, budget: ReadBudget) => T, onExhausted: (why: string) => T): T {
  const budget = new ReadBudget(opts);
  if (budget.remaining() <= 0) return onExhausted(budget.exhausted('before the store was opened'));
  const db = openForeignDbReadOnly(dbPath, budget.busyTimeout());
  try {
    return read(db, budget);
  } finally {
    db.close();
  }
}

/**
 * Another project's user board, read-only (decision
 * read-another-projects-board-board-query-target-project-read-only): raw SQL on
 * openForeignDbReadOnly, so nothing is written there (no pragma write, no
 * DDL, no -wal/-shm), and no SterlingStore is opened on it. Every live todo is
 * scanned in batches keyed by the board order, with no row ceiling, so every
 * item can be reached. Each body is checked with the tolerant read schemas: a
 * newer Sterling's extra fields pass through and a body this build cannot
 * read is listed in `unreadable`. The time budget is checked before and after
 * every SQLite step and before returning, and the busy timeout is refreshed
 * from what is left; running out returns what was read with `truncated` set,
 * never a short board read as complete. With `after` (a cursor's position),
 * the rows past it are scanned first. An open or query failure is thrown.
 */
export function readForeignBoard(dbPath: string, opts: ReadForeignBoardOptions & { after?: BoardOrderKey } = {}): ForeignBoardRead {
  const empty = (): ForeignBoardRead => ({ items: [], unreadable: [], slugHolders: new Map(), schemaVersion: 0 });
  return withForeignDb(
    dbPath,
    opts,
    (db, budget) => {
      const out = empty();
      const version = budget.step(db, () => db.prepare('PRAGMA user_version').get() as { user_version: number });
      if (version === undefined) {
        out.truncated = budget.exhausted('before the schema version was read');
        return out;
      }
      out.schemaVersion = Number(version.user_version);
      const ranges: (readonly [string, (string | number)[]])[] = opts.after
        ? [
            [AFTER, [opts.after.updated_at, opts.after.updated_at, opts.after.id]],
            [UP_TO, [opts.after.updated_at, opts.after.updated_at, opts.after.id]],
          ]
        : [['1', []]];
      const truncated = scanRanges(db, budget, ranges, Math.max(1, opts.batchSize ?? 200), out);
      if (truncated) out.truncated = truncated;
      else if (budget.remaining() <= 0) out.truncated = budget.exhausted(`after ${out.items.length + out.unreadable.length} board rows were read`);
      return out;
    },
    (why) => ({ ...empty(), truncated: why })
  );
}

/** Scan each range in board order, batch by batch; the reason the budget ran out, or undefined when every range was read. */
function scanRanges(db: DatabaseSync, budget: ReadBudget, ranges: readonly (readonly [string, (string | number)[]])[], batch: number, out: ForeignBoardRead): string | undefined {
  let rows = 0;
  for (const [range, params] of ranges) {
    let last: { updated_at: string; id: string } | undefined;
    for (;;) {
      const sql = `SELECT ${SCAN_COLUMNS} FROM records WHERE ${LIVE_TODO} AND ${range}${last ? ` AND ${AFTER}` : ''} ORDER BY updated_at DESC, id DESC LIMIT ?`;
      const args = [...params, ...(last ? [last.updated_at, last.updated_at, last.id] : []), batch];
      const got = budget.step(db, () => db.prepare(sql).all(...args) as ScanRow[]);
      if (got === undefined) return budget.exhausted(`after ${rows} board rows were read`);
      for (const row of got) absorbRow(row, out);
      rows += got.length;
      if (got.length < batch) break;
      const tail = got[got.length - 1];
      last = { updated_at: tail.order_updated_at, id: tail.id };
    }
  }
  return undefined;
}

function absorbRow(row: ScanRow, out: ForeignBoardRead): void {
  if (!row.ok) {
    out.unreadable.push({ id: row.id, reason: 'the stored body is not valid JSON' });
    return;
  }
  if (typeof row.slug === 'string' && row.slug.length > 0) {
    out.slugHolders.set(row.slug, { id: row.id, slug: row.slug, ...(typeof row.text === 'string' ? { text: row.text } : {}) });
  }
  if (row.source === 'system') return;
  const parsed = parseForeignItem(row.id, row.body);
  if (typeof parsed === 'string') out.unreadable.push({ id: row.id, reason: parsed });
  else out.items.push(parsed);
}

export type ForeignBoardLookup =
  | { found: Record<string, unknown> }
  | { refused: string };

/**
 * One live user board item from another project's store, by indexed lookup,
 * never through the scan: a full uuid (`id = ?`), then an exact slug, then an
 * 8-char hex prefix matched against the id COLUMN (`id LIKE ? || '%'`), so an
 * unreadable row sharing the prefix still counts and more than one match is
 * refused. A maintenance-queue item, an unreadable body and a lookup the
 * budget cut short are refused with the reason; the scan for readiness
 * follows in the same budget.
 */
export function getForeignBoardItem(
  dbPath: string,
  ref: string,
  where: string,
  opts: ReadForeignBoardOptions = {}
): { lookup: ForeignBoardLookup; board: ForeignBoardRead } {
  const emptyBoard = (why: string): ForeignBoardRead => ({ items: [], unreadable: [], slugHolders: new Map(), schemaVersion: 0, truncated: why });
  return withForeignDb(
    dbPath,
    opts,
    (db, budget) => {
      const cut = (why: string) => ({ lookup: { refused: `was not found ${where}: the lookup was cut short (${why}), so this is NOT proof it is absent; retry` }, board: emptyBoard(why) });
      type Row = { id: string; body: string; ok: number; source: unknown };
      const cols = `id, body, json_valid(body) AS ok, CASE WHEN json_valid(body) THEN json_extract(body, '$.source') END AS source`;
      const steps: [string, string][] = [
        [`SELECT ${cols} FROM records WHERE id = ? AND ${LIVE_TODO} LIMIT 2`, ref],
        [`SELECT ${cols} FROM records WHERE ${LIVE_TODO} AND (CASE WHEN json_valid(body) THEN json_extract(body, '$.slug') END) = ? LIMIT 2`, ref],
      ];
      if (/^[0-9a-f]{8}$/i.test(ref)) steps.push([`SELECT ${cols} FROM records WHERE ${LIVE_TODO} AND id LIKE ? || '%' LIMIT 10`, ref.toLowerCase()]);
      let rows: Row[] = [];
      for (const [sql, arg] of steps) {
        const got = budget.step(db, () => db.prepare(sql).all(arg) as Row[]);
        if (got === undefined) return cut(budget.exhausted('during the lookup'));
        if (got.length) {
          rows = got;
          break;
        }
      }
      let lookup: ForeignBoardLookup;
      if (rows.length === 0) lookup = { refused: `names no user board item ${where}` };
      else if (rows.length > 1) lookup = { refused: `is ambiguous ${where}, ${rows.length} live todo rows match it: ${rows.map((r) => r.id).join(', ')}` };
      else if (!rows[0].ok) lookup = { refused: `${where} (${rows[0].id}) cannot be read by this Sterling: the stored body is not valid JSON` };
      else if (rows[0].source === 'system') lookup = { refused: `${where} (${rows[0].id}) is a maintenance-queue item; another project's maintenance queue is not read` };
      else {
        const parsed = parseForeignItem(rows[0].id, rows[0].body);
        lookup = typeof parsed === 'string' ? { refused: `${where} (${rows[0].id}) cannot be read by this Sterling: ${parsed}` } : { found: parsed };
      }
      if (!('found' in lookup)) return { lookup, board: emptyBoard('not read: the lookup found no readable item') };
      const board: ForeignBoardRead = { items: [], unreadable: [], slugHolders: new Map(), schemaVersion: 0 };
      const version = budget.step(db, () => db.prepare('PRAGMA user_version').get() as { user_version: number });
      if (version === undefined) return { lookup, board: { ...board, truncated: budget.exhausted('before the schema version was read') } };
      board.schemaVersion = Number(version.user_version);
      const truncated = scanRanges(db, budget, [['1', []]], Math.max(1, opts.batchSize ?? 200), board);
      if (truncated) board.truncated = truncated;
      else if (budget.remaining() <= 0) board.truncated = budget.exhausted(`after ${board.items.length + board.unreadable.length} board rows were read`);
      return { lookup, board };
    },
    (why) => ({ lookup: { refused: `was not found ${where}: the lookup was cut short (${why}), so this is NOT proof it is absent; retry` }, board: emptyBoard(why) })
  );
}

/** The parsed board item, or why this build cannot read it. */
function parseForeignItem(id: string, body: string): Record<string, unknown> | string {
  const raw = JSON.parse(body) as unknown;
  const item = todoBoardItemReadSchema.safeParse(raw);
  const issues = (e: { issues: { path: (string | number)[]; message: string }[] }) => e.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
  if (!item.success) return issues(item.error);
  if (item.data.id !== id) return `the body's id ${item.data.id} differs from the row id`;
  const wait = todoWaitFieldsReadSchema.safeParse(raw);
  if (!wait.success) return issues(wait.error);
  return item.data;
}
