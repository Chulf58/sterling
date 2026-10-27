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
import { SterlingStore, readBoardSnapshot, BoardSnapshotError } from '../index.js';
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
      { seq: 1, item_id: a.id, slug: 'ship-export', text: 'Ship export', source: 'user', objective: 'exports', priority: 'high', outcome: 'done', evidence: { commit: '1a2b3c' }, note: 'shipped', removed_at: NOW },
      { seq: 2, item_id: b.id, text: 'Old idea', source: 'user', outcome: 'duplicate', removed_at: LATER },
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
