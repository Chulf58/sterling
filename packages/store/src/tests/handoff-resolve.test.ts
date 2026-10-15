// ------------------- cross-project handoff: the sender's read side -------------------
// GitHub issue #105 (user-ruled 2026-10-15). A tracker (todo handoff.role
// 'sent') is 'delegated' in the one readiness function, and its status is
// resolved at read time from the receiving project's store, opened read-only,
// plus the closure file the receiver's board_remove writes:
//   open        — the receiver's item is present with matching metadata
//   done        — absent, closure file present
//   gone        — absent, no closure file
//   unknown     — the receiver's database is missing, unreadable, or its row's
//                 handoff metadata is missing or different
//   unconfirmed — to_item_id is null
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, readForeignBoard, resolveSentHandoffs } from '../index.js';

const NOW = '2026-10-15T12:00:00.000Z';

function envelope() {
  return { id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}

function mk(store: SterlingStore, over: Record<string, unknown>): { id: string } {
  return store.create({ ...envelope(), source: 'user', ...over } as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };
}

/** A receiving project root with a store; closed unless `keepOpen`. */
function receiver() {
  const root = mkdtempSync(join(tmpdir(), 'sterling-handoff-b-'));
  mkdirSync(join(root, '.sterling'), { recursive: true });
  writeFileSync(join(root, '.sterling', 'config.json'), '{}');
  const store = new SterlingStore(join(root, '.sterling', 'sterling.db'));
  return { root, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function sent(root: string, transfer_id: string, to_item_id: string | null) {
  return { role: 'sent', transfer_id, to_root: root, to_name: 'beta', to_item_id };
}

test('boardReadiness: a sent tracker is delegated whatever its needs or blockers, and carries its handoff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-handoff-a-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    mk(store, { text: 'Open blocker', slug: 'open-blocker' });
    const h = sent('/x/beta', randomUUID(), null);
    const t = mk(store, { text: "Handed to project 'beta': do it", needs: 'user', blocked_by: ['open-blocker'], handoff: h });
    const plain = mk(store, { text: 'Plain', needs: 'user' });
    const byId = new Map(store.boardReadiness().map((r) => [r.id, r]));
    assert.equal(byId.get(t.id)?.state, 'delegated');
    assert.deepEqual(byId.get(t.id)?.handoff, h);
    assert.equal(byId.get(plain.id)?.state, 'waiting');
    assert.equal('handoff' in (byId.get(plain.id) ?? {}), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSentHandoffs: all five states, one receiver database opened per call', () => {
  const b = receiver();
  try {
    const trackerOpen = randomUUID();
    const tOpen = randomUUID();
    const bOpen = mk(b.store, { text: 'Open there', handoff: { role: 'received', transfer_id: tOpen, from_root: '/x/alpha', from_name: 'alpha', from_item_id: trackerOpen } });
    const tDone = randomUUID();
    const doneItem = randomUUID();
    mkdirSync(join(b.root, '.sterling', 'handoffs'), { recursive: true });
    writeFileSync(join(b.root, '.sterling', 'handoffs', `${tDone}.json`), JSON.stringify({ transfer_id: tDone, item_id: doneItem, closed_at: NOW, note: 'shipped in abc123' }));
    const tGone = randomUUID();
    b.store.close();
    const missing = mkdtempSync(join(tmpdir(), 'sterling-handoff-missing-'));
    const ids = { open: randomUUID(), done: randomUUID(), gone: randomUUID(), unknown: randomUUID(), unconfirmed: randomUUID() };
    const out = resolveSentHandoffs([
      { id: trackerOpen, handoff: sent(b.root, tOpen, bOpen.id) },
      { id: ids.done, handoff: sent(b.root, tDone, doneItem) },
      { id: ids.gone, handoff: sent(b.root, tGone, randomUUID()) },
      { id: ids.unknown, handoff: { ...sent(missing, randomUUID(), randomUUID()), to_name: 'gamma' } },
      { id: ids.unconfirmed, handoff: sent(b.root, randomUUID(), null) },
      { id: randomUUID() },
    ]);
    rmSync(missing, { recursive: true, force: true });
    assert.deepEqual(out.get(trackerOpen), { state: 'open', text: 'open in beta' });
    assert.deepEqual(out.get(ids.done), { state: 'done', text: `DONE in beta ${NOW}: shipped in abc123`, closed_at: NOW, note: 'shipped in abc123' });
    assert.deepEqual(out.get(ids.gone), { state: 'gone', text: "gone from beta's board, completion unverified" });
    assert.equal(out.get(ids.unknown)?.state, 'unknown');
    assert.match(out.get(ids.unknown)?.text ?? '', /^status unknown: no database at .*sterling\.db$/);
    assert.deepEqual(out.get(ids.unconfirmed), { state: 'unconfirmed', text: 'delivery unconfirmed' });
    assert.equal(out.size, 5, 'an item with no handoff gets no status');
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: a row with missing or different handoff metadata is unknown, never open and never gone', () => {
  const b = receiver();
  try {
    const tracker = randomUUID();
    const transfer = randomUUID();
    const bare = mk(b.store, { text: 'Stripped by an older server' });
    const other = mk(b.store, { text: 'Other transfer', handoff: { role: 'received', transfer_id: randomUUID(), from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
    b.store.close();
    const out = resolveSentHandoffs([
      { id: tracker, handoff: sent(b.root, transfer, bare.id) },
      { id: randomUUID(), handoff: sent(b.root, transfer, other.id) },
    ]);
    const [first, second] = [...out.values()];
    assert.equal(first.state, 'unknown');
    assert.match(first.text, /carries no handoff record/);
    assert.equal(second.state, 'unknown');
    assert.match(second.text, /different transfer/);
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: an unreadable database or closure file reads unknown with the reason', () => {
  const b = receiver();
  try {
    b.store.close();
    const transfer = randomUUID();
    const item = randomUUID();
    mkdirSync(join(b.root, '.sterling', 'handoffs'), { recursive: true });
    writeFileSync(join(b.root, '.sterling', 'handoffs', `${transfer}.json`), '{ not json');
    const bad = resolveSentHandoffs([{ id: randomUUID(), handoff: sent(b.root, transfer, item) }]);
    assert.match([...bad.values()][0].text, /^status unknown: the closure file .* is unreadable/);

    const junk = mkdtempSync(join(tmpdir(), 'sterling-handoff-junk-'));
    mkdirSync(join(junk, '.sterling'), { recursive: true });
    writeFileSync(join(junk, '.sterling', 'sterling.db'), 'this is not sqlite');
    const unreadable = resolveSentHandoffs([{ id: randomUUID(), handoff: sent(junk, randomUUID(), randomUUID()) }]);
    rmSync(junk, { recursive: true, force: true });
    assert.equal([...unreadable.values()][0].state, 'unknown');

    writeFileSync(join(b.root, '.sterling', 'config.json'), JSON.stringify({ storage: 'postgres' }));
    const pg = resolveSentHandoffs([{ id: randomUUID(), handoff: sent(b.root, randomUUID(), randomUUID()) }]);
    assert.match([...pg.values()][0].text, /uses postgres storage/);
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: receivers past the time budget read unknown and are not opened', () => {
  let t = 0;
  const out = resolveSentHandoffs([{ id: randomUUID(), handoff: sent('/nonexistent/beta', randomUUID(), randomUUID()) }], { budgetMs: 10, clock: () => (t += 100) });
  assert.match([...out.values()][0].text, /^status unknown: time budget exhausted \(10 ms\) before \/nonexistent\/beta was read$/);
});

test('resolveSentHandoffs: the read-only reader leaves no -wal or -shm beside a closed database', () => {
  const b = receiver();
  try {
    const tracker = randomUUID();
    const transfer = randomUUID();
    const item = mk(b.store, { text: 'Open there', handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
    b.store.close();
    const dir = join(b.root, '.sterling');
    assert.equal(existsSync(join(dir, 'sterling.db-wal')), false, 'precondition: the closed store has no -wal');
    const before = readdirSync(dir).sort();
    const out = resolveSentHandoffs([{ id: tracker, handoff: sent(b.root, transfer, item.id) }]);
    assert.equal(out.get(tracker)?.state, 'open');
    assert.deepEqual(readdirSync(dir).sort(), before);
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: against a running receiver (hot -wal) it sees the committed row and leaves the main file and -wal unchanged', () => {
  const b = receiver();
  try {
    const tracker = randomUUID();
    const transfer = randomUUID();
    const item = mk(b.store, { text: 'Open there', handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
    const db = join(b.root, '.sterling', 'sterling.db');
    assert.equal(existsSync(`${db}-wal`), true, 'precondition: the receiver is open, so its -wal exists');
    const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    const [mainBefore, walBefore] = [hash(db), hash(`${db}-wal`)];
    const out = resolveSentHandoffs([{ id: tracker, handoff: sent(b.root, transfer, item.id) }]);
    assert.equal(out.get(tracker)?.state, 'open');
    assert.equal(hash(db), mainBefore);
    assert.equal(hash(`${db}-wal`), walBefore);
  } finally {
    b.store.close();
    b.cleanup();
  }
});

test('resolveSentHandoffs: the time budget is checked before every lookup, also between trackers on one receiver', () => {
  const b = receiver();
  try {
    const trackers = Array.from({ length: 5 }, () => {
      const id = randomUUID();
      const transfer = randomUUID();
      const item = mk(b.store, { text: 'Open there', handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: id } });
      return { id, handoff: sent(b.root, transfer, item.id) };
    });
    b.store.close();
    let t = 0;
    const out = resolveSentHandoffs(trackers, { budgetMs: 250, clock: () => (t += 100) });
    const states = trackers.map((tr) => out.get(tr.id)?.state);
    assert.equal(states[0], 'open', 'the first lookup runs inside the budget');
    assert.equal(states.at(-1), 'unknown', `the last lookups are not run once the budget is spent: ${states.join(', ')}`);
    assert.match(out.get(trackers.at(-1)!.id)?.text ?? '', /^status unknown: time budget exhausted/);
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: a rollback-journal (DELETE mode) receiver mid-transaction is never read as gone', () => {
  const b = receiver();
  const db = join(b.root, '.sterling', 'sterling.db');
  try {
    const tracker = randomUUID();
    const transfer = randomUUID();
    const item = mk(b.store, { text: 'Open there', handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
    b.store.close();
    const writer = new DatabaseSync(db);
    try {
      writer.exec('PRAGMA journal_mode=DELETE; CREATE TABLE pad(id INTEGER PRIMARY KEY, v TEXT);');
      const ins = writer.prepare('INSERT INTO pad(v) VALUES (?)');
      writer.exec('BEGIN');
      for (let i = 0; i < 2000; i++) ins.run('y'.repeat(500));
      writer.exec('COMMIT');
      // A tiny page cache makes the open transaction spill its uncommitted
      // delete into the main file, with the original pages in the -journal.
      writer.exec('PRAGMA cache_size=1; BEGIN;');
      writer.prepare('DELETE FROM records WHERE id = ?').run(item.id);
      writer.exec(`UPDATE pad SET v = '${'z'.repeat(500)}'`);
      assert.equal(existsSync(`${db}-journal`), true, 'precondition: the writer holds a rollback journal');
      const out = resolveSentHandoffs([{ id: tracker, handoff: sent(b.root, transfer, item.id) }], { busyTimeoutMs: 50 });
      const state = out.get(tracker)?.state;
      assert.ok(state === 'open' || state === 'unknown', `an uncommitted delete must not read as gone or done, got ${state}: ${out.get(tracker)?.text}`);
      writer.exec('ROLLBACK');
    } finally {
      writer.close();
    }
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: an unreadable handoffs directory reads unknown, never gone (skipped when running as root)', { skip: process.getuid?.() === 0 }, () => {
  const b = receiver();
  const dir = join(b.root, '.sterling', 'handoffs');
  try {
    b.store.close();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o000);
    const out = resolveSentHandoffs([{ id: randomUUID(), handoff: sent(b.root, randomUUID(), randomUUID()) }]);
    const s = [...out.values()][0];
    assert.equal(s.state, 'unknown', s.text);
    assert.match(s.text, /EACCES/);
  } finally {
    chmodSync(dir, 0o755);
    b.cleanup();
  }
});

test('resolveSentHandoffs: a config.json behind an inaccessible directory reads unknown with EACCES, never as no config (skipped when running as root)', { skip: process.getuid?.() === 0 }, () => {
  const b = receiver();
  // config.json is a symlink into a chmod 000 directory: stat through it fails
  // with EACCES (so an existsSync probe would say "absent" and the receiver
  // would be read as a default SQLite project), while the database itself
  // stays readable, so only the config read can make the status unknown.
  const locked = join(b.root, 'locked');
  const config = join(b.root, '.sterling', 'config.json');
  try {
    b.store.close();
    mkdirSync(locked);
    writeFileSync(join(locked, 'config.json'), '{}');
    rmSync(config);
    symlinkSync(join(locked, 'config.json'), config);
    chmodSync(locked, 0o000);
    const out = resolveSentHandoffs([{ id: randomUUID(), handoff: sent(b.root, randomUUID(), randomUUID()) }]);
    const s = [...out.values()][0];
    assert.equal(s.state, 'unknown', s.text);
    assert.match(s.text, /config\.json is unreadable \(.*EACCES/);
  } finally {
    if (existsSync(locked)) chmodSync(locked, 0o755);
    b.cleanup();
  }
});

// GitHub issue #107: the receiver row's needs, needs_reason and blocked_by.
// Precedence: needs user/grill, then a blocker still live there, then open.
test('resolveSentHandoffs: needs user or grill, then a live blocker, then open; investigation and a removed blocker read open', () => {
  const b = receiver();
  try {
    mk(b.store, { text: 'Live blocker', slug: 'live-blocker' });
    const removed = mk(b.store, { text: 'Removed blocker', slug: 'removed-blocker' });
    const cases: Record<string, Record<string, unknown>> = {
      userReason: { needs: 'user', needs_reason: 'pick a colour', blocked_by: ['live-blocker'] },
      grill: { needs: 'grill' },
      blocked: { needs: 'investigation', blocked_by: ['removed-blocker', 'live-blocker'] },
      stale: { blocked_by: ['removed-blocker'] },
      investigation: { needs: 'investigation' },
    };
    const trackers: { id: string; handoff: unknown }[] = [];
    const idOf: Record<string, string> = {};
    for (const [name, over] of Object.entries(cases)) {
      const tracker = randomUUID();
      const transfer = randomUUID();
      const item = mk(b.store, { text: name, ...over, handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
      trackers.push({ id: tracker, handoff: sent(b.root, transfer, item.id) });
      idOf[name] = tracker;
    }
    b.store.remove(removed.id, NOW);
    b.store.close();
    const out = resolveSentHandoffs(trackers);
    assert.deepEqual(out.get(idOf.userReason), { state: 'needs_user', text: 'needs user in beta: pick a colour' });
    assert.deepEqual(out.get(idOf.grill), { state: 'needs_user', text: 'needs user in beta' });
    assert.deepEqual(out.get(idOf.blocked), { state: 'blocked', text: 'blocked in beta' });
    assert.deepEqual(out.get(idOf.stale), { state: 'open', text: 'open in beta' }, 'a removed blocker is closed');
    assert.deepEqual(out.get(idOf.investigation), { state: 'open', text: 'open in beta' });
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: the time budget running out during the blocker lookup reads unknown, never open', () => {
  const b = receiver();
  try {
    mk(b.store, { text: 'Live blocker', slug: 'live-blocker' });
    const tracker = randomUUID();
    const transfer = randomUUID();
    const item = mk(b.store, { text: 'Blocked there', blocked_by: ['live-blocker'], handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
    b.store.close();
    // clock calls: start, the receiver check, the lookup check, the blocker check (past the budget)
    let t = 0;
    const out = resolveSentHandoffs([{ id: tracker, handoff: sent(b.root, transfer, item.id) }], { budgetMs: 250, clock: () => (t += 100) });
    assert.equal(out.get(tracker)?.state, 'unknown');
    assert.match(out.get(tracker)?.text ?? '', /^status unknown: time budget exhausted \(250 ms\) before beta's blocker live-blocker was read$/);
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: unknown keys on the receiver row and its handoff are tolerated; an invalid known field reads unknown', () => {
  const b = receiver();
  try {
    const tracker = randomUUID();
    const transfer = randomUUID();
    const item = mk(b.store, { text: 'There', handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
    b.store.close();
    const db = new DatabaseSync(join(b.root, '.sterling', 'sterling.db'));
    const patchBody = (over: Record<string, unknown>, handoffOver: Record<string, unknown> = {}) => {
      const row = db.prepare('SELECT body FROM records WHERE id = ?').get(item.id) as { body: string };
      const body = JSON.parse(row.body);
      db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify({ ...body, ...over, handoff: { ...body.handoff, ...handoffOver } }), item.id);
    };
    const read = () => resolveSentHandoffs([{ id: tracker, handoff: sent(b.root, transfer, item.id) }]).get(tracker);
    patchBody({ future_field: 1 }, { future_key: 'x' });
    assert.deepEqual(read(), { state: 'open', text: 'open in beta' });
    patchBody({ needs: 'someday' });
    assert.match(read()?.text ?? '', /^status unknown: beta's item .* cannot be read: needs: Invalid enum value/);
    patchBody({ needs: 'user', blocked_by: 'not-a-list' });
    assert.match(read()?.text ?? '', /cannot be read: blocked_by: Expected array/);
    patchBody({ blocked_by: [] }, { transfer_id: randomUUID() });
    assert.match(read()?.text ?? '', /different transfer/);
    db.close();
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: a deadline crossed DURING the last blocker query reads unknown, never open', () => {
  const b = receiver();
  try {
    const tracker = randomUUID();
    const transfer = randomUUID();
    const item = mk(b.store, { text: 'Blocked by a removed item', blocked_by: ['gone-blocker'], handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
    b.store.close();
    // clock calls: start, the receiver check, the lookup check, the check before
    // the blocker query (which also caps its busy timeout); the query then
    // "takes" 300 ms, so the check after it is past the 250 ms budget.
    let calls = 0;
    const out = resolveSentHandoffs([{ id: tracker, handoff: sent(b.root, transfer, item.id) }], { budgetMs: 250, clock: () => (++calls <= 4 ? 0 : 300) });
    assert.equal(calls, 5, 'the budget is read once more after the query');
    assert.equal(out.get(tracker)?.state, 'unknown');
    assert.match(out.get(tracker)?.text ?? '', /^status unknown: time budget exhausted \(250 ms\) before the result for beta's blocker gone-blocker was read$/);
  } finally {
    b.cleanup();
  }
});

test('resolveSentHandoffs: a receiver row carrying needs_reason without needs user or grill reads unknown', () => {
  const b = receiver();
  try {
    const tracker = randomUUID();
    const transfer = randomUUID();
    const item = mk(b.store, { text: 'There', needs: 'investigation', handoff: { role: 'received', transfer_id: transfer, from_root: '/x/alpha', from_name: 'alpha', from_item_id: tracker } });
    b.store.close();
    const db = new DatabaseSync(join(b.root, '.sterling', 'sterling.db'));
    const row = db.prepare('SELECT body FROM records WHERE id = ?').get(item.id) as { body: string };
    db.prepare('UPDATE records SET body = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.body), needs_reason: 'x' }), item.id);
    db.close();
    const out = resolveSentHandoffs([{ id: tracker, handoff: sent(b.root, transfer, item.id) }]);
    assert.equal(out.get(tracker)?.state, 'unknown');
    assert.match(out.get(tracker)?.text ?? '', /cannot be read: needs_reason: needs_reason goes only with needs 'user' or 'grill'/);
  } finally {
    b.cleanup();
  }
});

// ------------------- readForeignBoard: another project's user board, read-only -------------------
// Decision read-another-projects-board-board-query-target-project-read-only:
// raw SQL on openForeignDbReadOnly, tolerant parse, a total time budget, and
// nothing written beside or into the other store.

/** Insert a raw todo row, bypassing the store's validation, as an older or newer Sterling might have written it. */
function rawTodo(db: string, id: string, body: string, updated_at = NOW): void {
  const w = new DatabaseSync(db);
  try {
    w.prepare(`INSERT INTO records (id, type, status, scope, created_at, updated_at, author, body) VALUES (?, 'todo', 'active', 'project', ?, ?, 'conductor', ?)`).run(id, NOW, updated_at, body);
  } finally {
    w.close();
  }
}

test('readForeignBoard: user items only, in board order, with live slugs of either source; system items are never returned', () => {
  const b = receiver();
  try {
    const one = mk(b.store, { text: 'One', slug: 'one', updated_at: '2026-10-15T12:00:01.000Z' });
    const two = mk(b.store, { text: 'Two', slug: 'two', updated_at: '2026-10-15T12:00:02.000Z' });
    mk(b.store, { text: 'Queue item', slug: 'queue-item', source: 'system', system_reason: 'reconcile_needed' });
    b.store.close();
    const read = readForeignBoard(join(b.root, '.sterling', 'sterling.db'));
    assert.deepEqual(read.items.map((i) => i.id), [two.id, one.id]);
    assert.deepEqual([...read.slugHolders.keys()].sort(), ['one', 'queue-item', 'two']);
    assert.equal(read.truncated, undefined);
    assert.equal(read.scanTruncated, false);
    assert.deepEqual(read.unreadable, []);
    assert.equal(read.schemaVersion, 2);
  } finally {
    b.cleanup();
  }
});

test('readForeignBoard: a body that fails the tolerant parse is listed as unreadable by id, never dropped; unknown keys pass through', () => {
  const b = receiver();
  try {
    const good = mk(b.store, { text: 'Readable' });
    b.store.close();
    const db = join(b.root, '.sterling', 'sterling.db');
    const notJson = randomUUID();
    const badWait = randomUUID();
    const newer = randomUUID();
    rawTodo(db, notJson, '{not json');
    rawTodo(db, badWait, JSON.stringify({ ...envelope(), id: badWait, source: 'user', text: 'x', needs_reason: 'why' }));
    rawTodo(db, newer, JSON.stringify({ ...envelope(), id: newer, source: 'user', text: 'From a newer Sterling', future_field: { a: 1 } }));
    const read = readForeignBoard(db);
    assert.deepEqual(read.items.map((i) => i.id).sort(), [good.id, newer].sort());
    assert.deepEqual((read.items.find((i) => i.id === newer) as Record<string, unknown>).future_field, { a: 1 });
    const unreadable = new Map(read.unreadable.map((u) => [u.id, u.reason]));
    assert.deepEqual([...unreadable.keys()].sort(), [badWait, notJson].sort());
    assert.match(unreadable.get(notJson) ?? '', /not valid JSON/);
    assert.match(unreadable.get(badWait) ?? '', /needs_reason/);
  } finally {
    b.cleanup();
  }
});

test('readForeignBoard: the time budget is checked per N rows; running out is disclosed as truncation with the rows read so far', () => {
  const b = receiver();
  try {
    for (let i = 0; i < 6; i++) mk(b.store, { text: `Item ${i}` });
    b.store.close();
    const db = join(b.root, '.sterling', 'sterling.db');
    let t = 0;
    const read = readForeignBoard(db, { budgetMs: 650, checkEvery: 1, clock: () => (t += 100) });
    assert.ok(read.truncated, 'the read says it was cut short');
    assert.match(read.truncated ?? '', /^time budget exhausted \(650 ms\) after \d+ board rows were read$/);
    assert.ok(read.items.length > 0 && read.items.length < 6, `a partial read, got ${read.items.length}`);
    const none = readForeignBoard(db, { budgetMs: 0 });
    assert.equal(none.items.length, 0);
    assert.match(none.truncated ?? '', /after 0 board rows/);
  } finally {
    b.cleanup();
  }
});

test('readForeignBoard: the PRAGMA user_version is reported as read', () => {
  const b = receiver();
  try {
    mk(b.store, { text: 'One' });
    b.store.close();
    const db = join(b.root, '.sterling', 'sterling.db');
    const w = new DatabaseSync(db);
    w.exec('PRAGMA user_version=7');
    w.close();
    assert.equal(readForeignBoard(db).schemaVersion, 7);
  } finally {
    b.cleanup();
  }
});

test('readForeignBoard: leaves no litter — a WAL store with no -wal and a rollback-journal store keep their files and bytes', () => {
  const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  for (const mode of ['wal', 'delete'] as const) {
    const b = receiver();
    try {
      mk(b.store, { text: 'One' });
      b.store.close();
      const dir = join(b.root, '.sterling');
      const db = join(dir, 'sterling.db');
      if (mode === 'delete') {
        const w = new DatabaseSync(db);
        w.exec('PRAGMA journal_mode=DELETE');
        w.close();
      }
      assert.equal(existsSync(`${db}-wal`), false, `precondition (${mode}): no -wal`);
      const before = readdirSync(dir).sort();
      const main = hash(db);
      const read = readForeignBoard(db);
      assert.equal(read.items.length, 1, mode);
      assert.deepEqual(readdirSync(dir).sort(), before, `${mode}: no -wal, -shm or -journal was left beside the store`);
      assert.equal(hash(db), main, `${mode}: the main file is byte-identical`);
    } finally {
      b.cleanup();
    }
  }
});
