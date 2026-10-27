// The board removal journal and the read-only board snapshot (decisions
// board-remove-records-outcome-and-evidence-in-a-removal-journal and
// board-issue-mirror-design-required-outcome-snapshot-read-single-writer).
// remove() writes the journal row in the delete's own transaction, so a failed
// delete leaves no row and a failed row leaves the task; readBoardSnapshot
// reads the board and the journal from one read-only snapshot and writes
// nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore, SqliteDriver, readBoardSnapshot, BoardSnapshotError } from '../index.js';
import { sqliteOnly } from './pg-test-support.js';

const NOW = '2026-10-27T12:00:00.000Z';
const LATER = '2026-10-27T13:00:00.000Z';
const SQLITE = { skip: sqliteOnly('reads or alters the SQLite file directly') };

function envelope() {
  return { id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}

function project() {
  const root = mkdtempSync(join(tmpdir(), 'sterling-removal-journal-'));
  mkdirSync(join(root, '.sterling'), { recursive: true });
  const dbPath = join(root, '.sterling', 'sterling.db');
  const o = {
    root,
    dbPath,
    store: new SterlingStore(dbPath),
    cleanup: () => {
      o.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return o;
}

function mk(store: SterlingStore, over: Record<string, unknown>): { id: string; slug?: string } {
  return store.create({ ...envelope(), source: 'user', ...over } as unknown as Parameters<SterlingStore['create']>[0]) as { id: string; slug?: string };
}

/** The raw handle the store runs its SQL through, for fault injection. */
function raw(store: SterlingStore): { exec: (sql: string) => void } {
  return (store as unknown as { db: { exec: (sql: string) => void } }).db;
}

test('remove with a removal journals a user task as it was, with outcome, evidence and note, in insertion order', SQLITE, () => {
  const p = project();
  try {
    const a = mk(p.store, { text: 'Ship export', slug: 'ship-export', objective: 'exports', priority: 'high' });
    const b = mk(p.store, { text: 'Old idea' });
    p.store.remove(a.id, NOW, { outcome: 'done', evidence: { commit: '1a2b3c' }, note: 'shipped' });
    p.store.remove(b.id, LATER, { outcome: 'duplicate' });
    assert.deepEqual(p.store.boardRemovalJournal(), [
      { seq: 1, item_id: a.id, slug: 'ship-export', text: 'Ship export', source: 'user', objective: 'exports', priority: 'high', outcome: 'done', evidence: { commit: '1a2b3c' }, note: 'shipped', removed_at: NOW, handoff_role: 'none' },
      { seq: 2, item_id: b.id, text: 'Old idea', source: 'user', outcome: 'duplicate', removed_at: LATER, handoff_role: 'none' },
    ]);
    assert.equal(p.store.get(a.id), undefined);
  } finally {
    p.cleanup();
  }
});

test('remove refuses a removal for a system todo, a non-todo or a missing id, and an invalid removal; nothing is removed or journaled', SQLITE, () => {
  const p = project();
  try {
    const sys = mk(p.store, { source: 'system', system_reason: 'capture_owed', text: 'capture owed', file_keys: ['src/a.ts'] });
    const user = mk(p.store, { text: 'A task' });
    assert.throws(() => p.store.remove(sys.id, NOW, { outcome: 'done' }), /is a system todo; a removal outcome is journaled for user board tasks only\. Nothing was removed\./);
    assert.throws(() => p.store.remove(randomUUID(), NOW, { outcome: 'done' }), /is not in this store; a removal outcome is journaled for user board tasks only/);
    assert.throws(() => p.store.remove(user.id, NOW, { outcome: 'finished' } as never), /the removal record for '.*' is refused \(outcome:/);
    assert.throws(() => p.store.remove(user.id, NOW, { outcome: 'done', evidence: {} } as never), /evidence needs at least one non-blank value/);
    assert.throws(() => p.store.remove(user.id, NOW, { outcome: 'done', note: ' ' }), /note must not be blank/);
    assert.ok(p.store.get(sys.id));
    assert.ok(p.store.get(user.id));
    assert.deepEqual(p.store.boardRemovalJournal(), []);
    // A system removal without a removal is unchanged: drained, logged, not journaled.
    p.store.remove(sys.id, NOW);
    assert.equal(p.store.drainLogEntry(sys.id)?.system_reason, 'capture_owed');
    assert.deepEqual(p.store.boardRemovalJournal(), []);
  } finally {
    p.cleanup();
  }
});

test('atomic: a delete that fails after the journal insert leaves no journal row, and the task stays', SQLITE, () => {
  const p = project();
  try {
    const t = mk(p.store, { text: 'A task' });
    raw(p.store).exec(`CREATE TRIGGER refuse_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`);
    assert.throws(() => p.store.remove(t.id, NOW, { outcome: 'done' }), /injected delete failure/);
    assert.deepEqual(p.store.boardRemovalJournal(), [], 'the journal row rolled back with the delete');
    assert.ok(p.store.get(t.id), 'the task is still there');
  } finally {
    p.cleanup();
  }
});

test('atomic: a journal insert that fails leaves the task on the board', SQLITE, () => {
  const p = project();
  try {
    const t = mk(p.store, { text: 'A task' });
    raw(p.store).exec(`CREATE TRIGGER refuse_journal BEFORE INSERT ON board_removal_journal BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`);
    assert.throws(() => p.store.remove(t.id, NOW, { outcome: 'dropped' }), /injected journal failure/);
    assert.ok(p.store.get(t.id), 'the task was not deleted');
    raw(p.store).exec('DROP TRIGGER refuse_journal');
    assert.deepEqual(p.store.boardRemovalJournal(), []);
  } finally {
    p.cleanup();
  }
});

test('additive: an existing v2 store without the journal table gains it on the next writable open, with no user_version bump', SQLITE, () => {
  const p = project();
  try {
    p.store.close();
    const db = new DatabaseSync(p.dbPath);
    db.exec('DROP TABLE board_removal_journal');
    const before = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    db.close();
    p.store = new SterlingStore(p.dbPath);
    const t = mk(p.store, { text: 'A task' });
    p.store.remove(t.id, NOW, { outcome: 'done' });
    assert.equal(p.store.boardRemovalJournal().length, 1);
    const after = new DatabaseSync(p.dbPath, { readOnly: true });
    try {
      assert.equal((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, before);
    } finally {
      after.close();
    }
  } finally {
    p.cleanup();
  }
});

test('snapshot: board items carry the store readiness and claim view, and the journal comes from the same read', SQLITE, () => {
  const p = project();
  try {
    const blocker = mk(p.store, { text: 'First this', slug: 'first-this' });
    const waiter = mk(p.store, { text: 'Then this', slug: 'then-this', blocked_by: ['first-this'] });
    const claimed = mk(p.store, { text: 'Being done', slug: 'being-done' });
    p.store.claimTodo(claimed.id, { session: 'ses_a', checkout: '/repo', now: NOW });
    mk(p.store, { source: 'system', system_reason: 'capture_owed', text: 'queue item', file_keys: ['src/a.ts'] });
    const gone = mk(p.store, { text: 'Finished', slug: 'finished' });
    p.store.remove(gone.id, NOW, { outcome: 'done', evidence: { pr: '#3' } });

    const snap = readBoardSnapshot(p.root, { now: Date.parse(NOW) });
    assert.equal(snap.schema_version, 2);
    assert.deepEqual(snap.unreadable, []);
    const byId = new Map(snap.items.map((i) => [i.record.id, i]));
    assert.deepEqual([...byId.keys()].sort(), [blocker.id, waiter.id, claimed.id].sort(), 'user items only; the queue item and the removed task are not on the board');
    assert.equal(byId.get(waiter.id)?.readiness.state, 'blocked');
    assert.equal(byId.get(blocker.id)?.readiness.state, 'ready');
    assert.equal(byId.get(claimed.id)?.readiness.claim?.holder_session, 'ses_a');
    assert.deepEqual(snap.journal.map((j) => [j.item_id, j.outcome, j.evidence]), [[gone.id, 'done', { pr: '#3' }]]);
  } finally {
    p.cleanup();
  }
});

/** Bytes of a file, hashed; undefined when absent. */
function hash(path: string): string | undefined {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined;
}

test('snapshot is read-only on a HOT WAL: the main file and -wal are byte-identical afterwards and a writer is never blocked', SQLITE, () => {
  const p = project();
  try {
    // The writer stays open, so its commits sit in -wal, not yet checkpointed.
    const t = mk(p.store, { text: 'Live task' });
    const done = mk(p.store, { text: 'Done task' });
    p.store.remove(done.id, NOW, { outcome: 'done' });
    assert.ok(existsSync(`${p.dbPath}-wal`), 'precondition: the WAL is hot');
    const mainBefore = hash(p.dbPath);
    const walBefore = hash(`${p.dbPath}-wal`);
    const mtimeBefore = statSync(p.dbPath).mtimeMs;
    const snap = readBoardSnapshot(p.root);
    assert.deepEqual(snap.items.map((i) => i.record.id), [t.id], 'the snapshot sees the uncheckpointed commits');
    assert.deepEqual(snap.journal.map((j) => j.item_id), [done.id]);
    assert.equal(hash(p.dbPath), mainBefore, 'the main file is unchanged');
    assert.equal(hash(`${p.dbPath}-wal`), walBefore, 'the -wal is unchanged');
    assert.equal(statSync(p.dbPath).mtimeMs, mtimeBefore);
    assert.ok(existsSync(`${p.dbPath}-shm`), 'the -shm is left in place');
    // the writer takes its write lock straight after: the reader held none
    p.store.remove(t.id, LATER, { outcome: 'dropped' });
    assert.equal(p.store.boardRemovalJournal().length, 2);
  } finally {
    p.cleanup();
  }
});

test('snapshot is read-only on a cold store: no -wal or -shm is created and the file is byte-identical', SQLITE, () => {
  const p = project();
  try {
    mk(p.store, { text: 'A task' });
    p.store.close();
    assert.equal(existsSync(`${p.dbPath}-wal`), false, 'precondition: no -wal after a clean close');
    const before = hash(p.dbPath);
    const snap = readBoardSnapshot(p.root);
    assert.equal(snap.items.length, 1);
    assert.equal(hash(p.dbPath), before);
    assert.equal(existsSync(`${p.dbPath}-wal`), false);
    assert.equal(existsSync(`${p.dbPath}-shm`), false);
    p.store = new SterlingStore(p.dbPath);
  } finally {
    p.cleanup();
  }
});

test('snapshot reads a store left with a -wal and no -shm: committed frames are seen and the main file and -wal are unchanged', SQLITE, () => {
  const p = project();
  try {
    const keep = mk(p.store, { text: 'Kept task' });
    const done = mk(p.store, { text: 'Done task' });
    p.store.remove(done.id, NOW, { outcome: 'done' });
    // A copy of the hot store with its -wal but without its -shm, as a crashed writer can leave it.
    const copy = mkdtempSync(join(tmpdir(), 'sterling-removal-journal-noshm-'));
    try {
      mkdirSync(join(copy, '.sterling'));
      const db = join(copy, '.sterling', 'sterling.db');
      writeFileSync(db, readFileSync(p.dbPath));
      writeFileSync(`${db}-wal`, readFileSync(`${p.dbPath}-wal`));
      assert.equal(existsSync(`${db}-shm`), false, 'precondition: no -shm');
      const mainBefore = hash(db);
      const walBefore = hash(`${db}-wal`);
      const snap = readBoardSnapshot(copy);
      assert.deepEqual(snap.items.map((i) => i.record.id), [keep.id]);
      assert.deepEqual(snap.journal.map((j) => j.item_id), [done.id]);
      assert.equal(hash(db), mainBefore, 'the main file is unchanged');
      assert.equal(hash(`${db}-wal`), walBefore, 'the -wal is unchanged');
      // Measured: the read-only open creates the -shm (the WAL index) and cannot remove it; it is left, never deleted, as openForeignDbReadOnly documents.
      assert.equal(existsSync(`${db}-shm`), true, 'the WAL index the read created is left in place');
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  } finally {
    p.cleanup();
  }
});

test('snapshot refusals name why: Postgres storage, no database, wrong schema version, no journal table, a bad journal row', SQLITE, () => {
  const p = project();
  try {
    const kind = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        assert.ok(e instanceof BoardSnapshotError, String(e));
        return e.kind;
      }
      assert.fail('expected a BoardSnapshotError');
    };
    writeFileSync(join(p.root, '.sterling', 'config.json'), JSON.stringify({ storage: 'postgres' }));
    assert.equal(kind(() => readBoardSnapshot(p.root)), 'not_sqlite');
    for (const bad of ['null', '[]', '"sqlite"', '7', '{"storage": 5}', '{ not json']) {
      writeFileSync(join(p.root, '.sterling', 'config.json'), bad);
      assert.equal(kind(() => readBoardSnapshot(p.root)), 'unreadable', `config ${bad}`);
    }
    writeFileSync(join(p.root, '.sterling', 'config.json'), '{}');

    const empty = mkdtempSync(join(tmpdir(), 'sterling-removal-journal-empty-'));
    try {
      assert.equal(kind(() => readBoardSnapshot(empty)), 'no_database');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    const t = mk(p.store, { text: 'A task' });
    p.store.remove(t.id, NOW, { outcome: 'done' });
    p.store.close();
    const db = new DatabaseSync(p.dbPath);
    db.exec(`UPDATE board_removal_journal SET outcome = 'finished'`);
    db.close();
    assert.equal(kind(() => readBoardSnapshot(p.root)), 'bad_journal_row');

    const db2 = new DatabaseSync(p.dbPath);
    db2.exec('DROP TABLE board_removal_journal');
    db2.close();
    assert.equal(kind(() => readBoardSnapshot(p.root)), 'journal_missing');

    const db3 = new DatabaseSync(p.dbPath);
    db3.exec('PRAGMA user_version = 3');
    db3.close();
    assert.equal(kind(() => readBoardSnapshot(p.root)), 'schema_mismatch');
    const db4 = new DatabaseSync(p.dbPath);
    db4.exec('PRAGMA user_version = 2');
    db4.close();
    p.store = new SterlingStore(p.dbPath);
  } finally {
    p.cleanup();
  }
});

const RECEIVED = { role: 'received', transfer_id: randomUUID(), from_root: '/elsewhere/CH.Hub', from_name: 'CH.Hub', from_item_id: randomUUID() };
const SENT = { role: 'sent', transfer_id: randomUUID(), to_root: '/elsewhere/Other', to_name: 'Other', to_item_id: null };

/** The journal table exactly as 0.19.130 created it, before the hand-off columns. */
const JOURNAL_0_19_130 = `CREATE TABLE board_removal_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, slug TEXT, text TEXT NOT NULL, source TEXT NOT NULL,
  objective TEXT, priority TEXT, outcome TEXT NOT NULL, evidence TEXT, note TEXT, removed_at TEXT NOT NULL
)`;

test('the journal row records the removed todo\'s hand-off role (none for a plain task), and the sending project for a received item', SQLITE, () => {
  const p = project();
  try {
    const recv = mk(p.store, { text: 'From CH.Hub: a task', handoff: RECEIVED });
    const tracker = mk(p.store, { text: "Handed to project 'Other': a task", handoff: SENT });
    const plain = mk(p.store, { text: 'A task' });
    for (const t of [recv, tracker, plain]) p.store.remove(t.id, NOW, { outcome: 'done' });
    const byId = new Map(p.store.boardRemovalJournal().map((e) => [e.item_id, e]));
    assert.equal(byId.get(recv.id)?.handoff_role, 'received');
    assert.equal(byId.get(recv.id)?.handoff_from_name, 'CH.Hub');
    assert.equal(byId.get(tracker.id)?.handoff_role, 'sent');
    assert.equal(byId.get(tracker.id)?.handoff_from_name, undefined, 'a tracker names no sending project');
    assert.equal(byId.get(plain.id)?.handoff_role, 'none', 'a plain task is told apart from a row written before the column');
    assert.equal('handoff_from_name' in byId.get(plain.id)!, false);
    const snap = new Map(readBoardSnapshot(p.root).journal.map((e) => [e.item_id, e]));
    assert.deepEqual(snap.get(recv.id), byId.get(recv.id));
    assert.deepEqual(snap.get(tracker.id), byId.get(tracker.id));
    assert.deepEqual(snap.get(plain.id), byId.get(plain.id));
  } finally {
    p.cleanup();
  }
});

test('additive: a 0.19.130 journal table gains the hand-off columns on the next writable open, keeping its rows; the snapshot reads it before that', SQLITE, () => {
  const p = project();
  try {
    p.store.close();
    const db = new DatabaseSync(p.dbPath);
    db.exec('DROP TABLE board_removal_journal');
    db.exec(JOURNAL_0_19_130);
    db.exec(`INSERT INTO board_removal_journal (item_id, text, source, outcome, removed_at) VALUES ('${randomUUID()}', 'Old task', 'user', 'dropped', '${NOW}')`);
    const before = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    db.close();
    const old = readBoardSnapshot(p.root).journal;
    assert.equal(old.length, 1);
    assert.equal(old[0].text, 'Old task');
    assert.equal('handoff_role' in old[0], false, 'a read-only snapshot of the old table reads the missing columns as absent');

    p.store = new SterlingStore(p.dbPath);
    const cols = new DatabaseSync(p.dbPath, { readOnly: true });
    try {
      const names = (cols.prepare('PRAGMA table_info(board_removal_journal)').all() as { name: string }[]).map((c) => c.name);
      assert.ok(names.includes('handoff_role') && names.includes('handoff_from_name'), names.join(', '));
      assert.equal((cols.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, before);
    } finally {
      cols.close();
    }
    const recv = mk(p.store, { text: 'Received', handoff: RECEIVED });
    p.store.remove(recv.id, NOW, { outcome: 'done' });
    const journal = p.store.boardRemovalJournal();
    assert.equal(journal.length, 2);
    assert.equal(journal[0].text, 'Old task');
    assert.equal('handoff_role' in journal[0], false);
    assert.equal(journal[1].handoff_role, 'received');
    assert.equal(journal[1].handoff_from_name, 'CH.Hub');
    p.store.close();
    p.store = new SterlingStore(p.dbPath);
    assert.equal(p.store.boardRemovalJournal().length, 2, 'a second open finds the columns already there');
  } finally {
    p.cleanup();
  }
});

test('additive: a failure adding the hand-off columns is not swallowed', SQLITE, () => {
  const p = project();
  try {
    p.store.close();
    const db = new DatabaseSync(p.dbPath);
    db.exec('DROP TABLE board_removal_journal');
    db.exec(JOURNAL_0_19_130);
    db.close();
    const driver = new SqliteDriver(p.dbPath);
    try {
      // An ALTER that fails for a reason other than an existing column (here an injected I/O error) must reach the caller.
      const handle = (driver as unknown as { db: { exec: (sql: string) => void } }).db;
      const exec = handle.exec.bind(handle);
      handle.exec = (sql: string) => {
        if (/ALTER TABLE board_removal_journal ADD COLUMN/.test(sql)) throw new Error('injected disk I/O error');
        exec(sql);
      };
      assert.throws(() => driver.prepareWritable(false), /injected disk I\/O error/);
    } finally {
      driver.close();
    }
    p.store = new SterlingStore(p.dbPath);
    assert.deepEqual(p.store.boardRemovalJournal(), [], 'a normal open afterwards adds the columns');
  } finally {
    p.cleanup();
  }
});

test('additive: a column another opener adds between the check and the ALTER is not an error', SQLITE, () => {
  const p = project();
  try {
    p.store.close();
    const db = new DatabaseSync(p.dbPath);
    db.exec('DROP TABLE board_removal_journal');
    db.exec(JOURNAL_0_19_130);
    db.close();
    const driver = new SqliteDriver(p.dbPath);
    try {
      // The interleaving: the column lands (as another opener's ALTER would) after table_info was read and
      // before this opener's ALTER runs, so that ALTER fails with 'duplicate column name'.
      const handle = (driver as unknown as { db: { exec: (sql: string) => void } }).db;
      const exec = handle.exec.bind(handle);
      let raced = 0;
      handle.exec = (sql: string) => {
        if (/ALTER TABLE board_removal_journal ADD COLUMN handoff_role/.test(sql)) {
          raced++;
          exec(sql);
        }
        exec(sql);
      };
      driver.prepareWritable(false);
      assert.equal(raced, 1, 'the injected interleaving ran');
    } finally {
      driver.close();
    }
    p.store = new SterlingStore(p.dbPath);
    const t = mk(p.store, { text: 'Received', handoff: { role: 'received', transfer_id: randomUUID(), from_root: '/x', from_name: 'CH.Hub', from_item_id: randomUUID() } });
    p.store.remove(t.id, NOW, { outcome: 'done' });
    assert.equal(p.store.boardRemovalJournal()[0].handoff_from_name, 'CH.Hub', 'both columns exist after the raced open');
  } finally {
    p.cleanup();
  }
});
