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
import { SterlingStore, resolveSentHandoffs } from '../index.js';

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
