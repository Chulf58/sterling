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
import { BOARD_NEEDS, HANDOFFS_DIR_REL, handoffClosureSchema, todoHandoffReadSchema, type TodoHandoff } from '@sterling/schemas';

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

const statusText = {
  open: (to: string) => `open in ${to}`,
  needs_user: (to: string, reason?: string) => `needs user in ${to}${reason ? `: ${reason}` : ''}`,
  blocked: (to: string) => `blocked in ${to}`,
  done: (to: string, closedAt: string, note?: string) => `DONE in ${to} ${closedAt}${note ? `: ${note}` : ''}`,
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
    parsed = handoffClosureSchema.safeParse(JSON.parse(text));
  } catch (e) {
    return unknown(`the closure file ${p} is unreadable (${errText(e)})`);
  }
  if (!parsed.success) return unknown(`the closure file ${p} is not a closure record (${parsed.error.issues.map((i) => i.message).join('; ')})`);
  const c = parsed.data;
  if (c.transfer_id !== h.transfer_id || c.item_id !== h.to_item_id) {
    return unknown(`the closure file ${p} names transfer ${c.transfer_id} item ${c.item_id}, not transfer ${h.transfer_id} item ${h.to_item_id}`);
  }
  return { state: 'done', text: statusText.done(h.to_name, c.closed_at, c.note), closed_at: c.closed_at, ...(c.note ? { note: c.note } : {}) };
}

/** The receiver row's needs, needs_reason and blocked_by, or a reason they cannot be read. Unknown keys are ignored; a known field of the wrong shape is refused. */
function readWaitFields(body: Record<string, unknown>): { needs?: string; needs_reason?: string; blocked_by: string[] } | string {
  const { needs, needs_reason, blocked_by } = body;
  if (needs !== undefined && !(typeof needs === 'string' && (BOARD_NEEDS as readonly string[]).includes(needs))) return `its needs value ${JSON.stringify(needs)} is not one this Sterling knows`;
  if (needs_reason !== undefined && !(typeof needs_reason === 'string' && needs_reason.trim().length > 0)) return 'its needs_reason is not a non-blank string';
  if (blocked_by !== undefined && !(Array.isArray(blocked_by) && blocked_by.every((s) => typeof s === 'string' && s.length > 0))) return 'its blocked_by is not a list of slugs';
  return {
    ...(needs !== undefined ? { needs: needs as string } : {}),
    ...(needs_reason !== undefined ? { needs_reason: (needs_reason as string).trim() } : {}),
    blocked_by: (blocked_by as string[] | undefined) ?? [],
  };
}

/**
 * One tracker's status against an already-open receiver database. Precedence
 * (decision handoff-needs-user-blocked-milestone-evidence-pull-only-skew-safe):
 * needs 'user' or 'grill' first, then a blocker that is still a live board
 * item there (blocked_by keeps the slugs of removed blockers, so a slug no live
 * todo carries is closed, the rule board readiness uses), then open. needs
 * 'investigation' reads open. Each blocker lookup is checked against the time
 * budget first (`remaining`); running out reads unknown, never open.
 */
function rowStatus(db: DatabaseSync, trackerId: string, h: SentHandoff & { to_item_id: string }, remaining: () => number, exhausted: (where: string) => string): HandoffStatus {
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
  const wait = readWaitFields(body);
  if (typeof wait === 'string') return unknown(`${h.to_name}'s item ${h.to_item_id.slice(0, 8)} cannot be read: ${wait}`);
  if (wait.needs === 'user' || wait.needs === 'grill') return { state: 'needs_user', text: statusText.needs_user(h.to_name, wait.needs_reason) };
  if (wait.blocked_by.length) {
    const live = db.prepare(`SELECT 1 FROM records WHERE type = 'todo' AND status != 'superseded' AND json_extract(body, '$.slug') = ? LIMIT 1`);
    for (const slug of new Set(wait.blocked_by)) {
      if (remaining() <= 0) return unknown(exhausted(`${h.to_name}'s blocker ${slug}`));
      if (live.get(slug)) return { state: 'blocked', text: statusText.blocked(h.to_name) };
    }
  }
  return { state: 'open', text: statusText.open(h.to_name) };
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
          out.set(id, rowStatus(db, id, h, remaining, exhausted));
        } catch (e) {
          out.set(id, unknown(`${h.to_name}'s database could not be read (${errText(e)})`));
        }
      }
    } finally {
      db.close();
    }
  }
  return out;
}
