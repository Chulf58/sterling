import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SterlingStore } from '@sterling/store';
import { openDashboard, type DashboardController, type DashboardOptions } from '../controller.js';
import { buildDashboardState, TASKS_TAB } from '../state.js';

// GitHub #35 (board 7b1e2e9d): a click built the dashboard three times, wrote
// the selection on the input path through SQLite's busy timeout, and the 1 Hz
// tick rebuilt everything from the store. These tests pin the fix through the
// controller, the way main.ts drives it: draw a frame (state), handle the
// event against it, draw again, then run the held writes (flush).

const VP = { width: 100, maxBodyLines: 40, showBanner: false };
// showBanner false: the body starts on screen line bodyTop + 1 = 4, so row i is on line 4 + i
const lineOf = (row: number) => 4 + row;

function fixture(options: DashboardOptions = { deferWrites: true, profile: true }): { dir: string; storePath: string; ctl: DashboardController } {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-click-lag-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  const storePath = join(dir, '.sterling', 'sterling.db');
  return { dir, storePath, ctl: openDashboard(storePath, options) };
}

function todo(store: SterlingStore, text: string): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  store.create({
    id, type: 'todo', created_at: now, updated_at: now, author: 'conductor', status: 'active', superseded_by: null,
    links: [], scope: 'project', stack_tags: [], source: 'user', text,
  } as never);
  return id;
}

test('click lag (a): a click builds the dashboard once and the hit-test reads nothing from the store', async () => {
  const { dir, ctl } = fixture();
  try {
    for (let i = 0; i < 20; i++) todo(ctl.store, `item ${i}`);
    const drawn = ctl.state(VP);
    const target = drawn.rows[2]!.id;
    const s0 = ctl.stats();
    await ctl.handle({ kind: 'click', x: 5, y: lineOf(2) }, VP);
    const s1 = ctl.stats();
    assert.equal(s1.storeCalls - s0.storeCalls, 0, 'the reducer hit-tests the drawn frame; the store is not read on the input path');
    assert.equal(ctl.store.takeSelection(), undefined, 'the selection write is held until flush()');
    const after = ctl.state(VP);
    assert.equal(ctl.stats().builds - s0.builds, 1, 'one dashboard build for the click: the redraw');
    assert.equal(after.rows.find((r) => r.selected)?.id, target);
    assert.equal(after.rows.find((r) => r.id === target)?.expanded, true, 'the click expanded the card it hit');
    assert.equal(ctl.flush(), false, 'the held write succeeded');
    assert.equal(ctl.store.takeSelection()?.record_id, target);
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('click lag (b): the tick reuses the frame while data_version is unchanged, and rebuilds after a commit from any connection', async () => {
  const { dir, storePath, ctl } = fixture();
  const other = new SterlingStore(storePath); // a second connection, as the MCP server holds
  try {
    todo(ctl.store, 'first');
    const first = ctl.state(VP);
    const s0 = ctl.stats();
    for (let i = 0; i < 5; i++) assert.equal(ctl.state(VP), first, 'an unchanged store hands back the same frame');
    assert.equal(ctl.stats().builds - s0.builds, 0, 'no rebuild while data_version is unchanged');
    assert.equal(ctl.stats().storeCalls - s0.storeCalls, 0, 'the tick reads nothing from the store');
    assert.equal(ctl.stats().changeDetection, 'data_version');

    const fromOther = todo(other, 'from another process');
    const second = ctl.state(VP);
    assert.equal(ctl.stats().builds - s0.builds, 1, 'a commit on another connection rebuilds once');
    assert.ok(second.rows.some((r) => r.id === fromOther), 'the new record is drawn');

    const fromSelf = todo(ctl.store, 'from the dashboard store connection');
    assert.ok(ctl.state(VP).rows.some((r) => r.id === fromSelf), "the dashboard's own store connection is seen as well");
    assert.notEqual(ctl.state({ ...VP, width: 60 }), ctl.state(VP), 'a viewport change rebuilds');
  } finally {
    other.close();
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('click lag (c): a failed store write becomes a notice; handle() and flush() never reject or throw', async () => {
  for (const deferWrites of [true, false]) {
    const { dir, ctl } = fixture({ deferWrites });
    try {
      todo(ctl.store, 'item');
      ctl.state(VP);
      ctl.writeStore.writeSelection = () => {
        throw new Error('disk I/O error');
      };
      await ctl.handle({ kind: 'click', x: 5, y: lineOf(0) }, VP); // rejects on regression
      if (deferWrites) assert.equal(ctl.flush(), true, 'flush reports the failure so the host redraws');
      assert.match(ctl.ui().notice ?? '', /^selection not handed to the next prompt — disk I\/O error$/);
      assert.match(ctl.state(VP).footer, /^⚠ selection not handed to the next prompt/, 'the notice is drawn');
    } finally {
      ctl.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // a board edit refused by the store (the expected_version backstop) used to reach the fatal handler
  const { dir, ctl } = fixture();
  try {
    todo(ctl.store, 'edit me');
    ctl.state(VP);
    await ctl.handle({ kind: 'char', ch: 'e' }, VP);
    await ctl.handle({ kind: 'char', ch: '!' }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    ctl.writeStore.updateTodo = () => {
      throw new Error('version moved');
    };
    assert.equal(ctl.flush(), true);
    assert.match(ctl.ui().notice ?? '', /^board edit not saved — version moved$/);
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('click lag (d): a click on a frame whose data changed since it was drawn selects the drawn record, and the selection stays on it', async () => {
  const { dir, storePath, ctl } = fixture();
  const other = new SterlingStore(storePath);
  try {
    for (let i = 0; i < 5; i++) todo(ctl.store, `item ${i}`);
    const drawn = ctl.state(VP);
    const target = drawn.rows[2]!.id;
    other.remove(drawn.rows[0]!.id); // another process removes a record above the click
    const fresh = buildDashboardState(ctl.store, ctl.ui(), VP.width, VP.maxBodyLines, '', false);
    assert.notEqual(fresh.rows[2]?.id, target, 'precondition: the store moved row 2 to another record');

    await ctl.handle({ kind: 'click', x: 5, y: lineOf(2) }, VP);
    assert.equal(ctl.ui().selectedId, target, 'the click selects the record that was drawn on that line');
    ctl.flush();
    assert.equal(ctl.store.takeSelection()?.record_id, target, 'the selection handed to the next prompt is the drawn record');
    const redrawn = ctl.state(VP);
    assert.equal(redrawn.rows.find((r) => r.selected)?.id, target, 'held by id: the redraw keeps the selection on the record, at its new row');

    todo(other, 'added later');
    await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
    await ctl.handle({ kind: 'key', name: 'UP' }, VP);
    assert.equal(ctl.state(VP).rows.find((r) => r.selected)?.id, target, 'arrow keys move from the held record');
    assert.equal(ctl.ui().tab, TASKS_TAB);
  } finally {
    other.close();
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix round (Sol task-end review of 96abdce8).

function editText(store: SterlingStore, id: string, text: string): void {
  const rec = store.get(id) as unknown as Record<string, unknown>;
  store.updateTodo(id, { ...rec, text, updated_at: new Date().toISOString() });
}

test('board edit: e opens the LIVE text with its version, not the drawn body; a save over a newer change is refused', async () => {
  const { dir, storePath, ctl } = fixture();
  const other = new SterlingStore(storePath);
  try {
    const id = todo(ctl.store, 'old');
    ctl.state(VP); // drawn with "old"
    editText(other, id, 'new');
    await ctl.handle({ kind: 'char', ch: 'e' }, VP);
    assert.equal(ctl.ui().boardEdit?.text, 'new', 'the editor holds the text the store has now');
    assert.equal(ctl.ui().boardEdit?.version, (other.get(id) as unknown as { version: number }).version, 'text and version come from one read');

    editText(other, id, 'newer'); // another change while the editor is open
    await ctl.handle({ kind: 'char', ch: '!' }, VP);
    await ctl.handle({ kind: 'key', name: 'ENTER' }, VP);
    ctl.flush();
    assert.equal((ctl.store.get(id) as unknown as { text: string }).text, 'newer', 'the stale buffer did not overwrite the newer text');
    assert.ok(ctl.ui().notice, 'the refusal is said');
  } finally {
    other.close();
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quit: a held write that fails or cannot get the lock stops the quit once; q again quits and discards', async () => {
  const { dir, ctl } = fixture();
  try {
    todo(ctl.store, 'item');
    ctl.state(VP);
    const real = ctl.writeStore.writeSelection.bind(ctl.writeStore);
    ctl.writeStore.writeSelection = () => {
      throw Object.assign(new Error('database is locked'), { errcode: 5 });
    };
    await ctl.handle({ kind: 'click', x: 5, y: lineOf(0) }, VP);
    assert.equal(ctl.requestQuit(), false, 'the first quit is held while a write is unsaved');
    assert.equal(ctl.pending(), 1, 'a busy write stays queued for a retry');
    assert.match(ctl.ui().notice ?? '', /press q again to quit and discard/);
    assert.equal(ctl.requestQuit(), true, 'q again quits, discarding explicitly');

    // any other event disarms the discard; a later retry that succeeds saves the write and clears the notice
    await ctl.handle({ kind: 'key', name: 'DOWN' }, VP);
    assert.equal(ctl.requestQuit(), false, 'disarmed by the next event');
    ctl.writeStore.writeSelection = real;
    assert.equal(ctl.flush(), false);
    assert.equal(ctl.pending(), 0);
    assert.ok(ctl.store.takeSelection(), 'the retried selection reached the store');
    assert.equal(ctl.ui().notice, undefined, 'the busy notice is cleared once the write is saved');
    assert.equal(ctl.requestQuit(), true, 'nothing unsaved: quit at once');

    // a write that fails for good is dropped with a notice, and the quit is still held once
    ctl.writeStore.writeSelection = () => {
      throw new Error('disk I/O error');
    };
    await ctl.handle({ kind: 'click', x: 5, y: lineOf(0) }, VP);
    assert.equal(ctl.requestQuit(), false);
    assert.equal(ctl.pending(), 0, 'a failure that is not a busy lock is not retried');
    assert.match(ctl.ui().notice ?? '', /disk I\/O error.*press q again to quit and discard/);
    assert.equal(ctl.requestQuit(), true);
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('busy store: the dashboard waits 250 ms, not 5000, for a held write lock; the write stays queued and lands on the next flush', async () => {
  const { dir, storePath, ctl } = fixture();
  const locker = new DatabaseSync(storePath);
  try {
    todo(ctl.store, 'item');
    ctl.state(VP);
    await ctl.handle({ kind: 'click', x: 5, y: lineOf(0) }, VP);
    locker.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    assert.equal(ctl.flush(), true, 'the timeout is reported');
    const waited = Date.now() - t0;
    assert.ok(waited >= 200 && waited < 1500, `waited ${waited} ms`);
    assert.equal(ctl.pending(), 1);
    assert.match(ctl.ui().notice ?? '', /store is busy/);
    locker.exec('ROLLBACK');
    assert.equal(ctl.flush(), false);
    assert.equal(ctl.pending(), 0);
    assert.ok(ctl.store.takeSelection());
  } finally {
    locker.close();
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('change detection: a failed data_version read marks it degraded, says so once, and keeps rebuilding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-click-lag-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  const ctl = openDashboard(join(dir, '.sterling', 'sterling.db'), {
    dataVersionProbe: () => ({
      read() {
        throw new Error('disk gone');
      },
      close() {},
    }),
  });
  try {
    const b0 = ctl.stats().builds;
    ctl.state(VP);
    ctl.state(VP);
    assert.equal(ctl.stats().builds - b0, 2, 'without a version every call rebuilds');
    assert.match(ctl.stats().changeDetection, /^degraded: data_version read failed — disk gone/);
    assert.match(ctl.ui().notice ?? '', /data_version read failed — disk gone/);
    assert.match(ctl.state(VP).footer, /^⚠ .*data_version read failed/);
    await ctl.handle({ kind: 'tab', index: 1 }, VP); // a tab switch clears the notice
    ctl.state(VP);
    assert.equal(ctl.ui().notice, undefined, 'the notice is shown once, not on every rebuild');
  } finally {
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Re-check round (Sol): only the deferred writes use the short timeout.

/** Hold the store's write lock from another process for `ms`; resolves once the lock is held. */
async function holdLock(dbPath: string, ms: number): Promise<{ released: Promise<void> }> {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `const { DatabaseSync } = await import('node:sqlite');
     const db = new DatabaseSync(${JSON.stringify(dbPath)});
     db.exec('BEGIN IMMEDIATE');
     process.stdout.write('locked\\n');
     setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, ${ms});`,
  ]);
  const released = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => d.toString().includes('locked') && resolve());
    child.on('error', reject);
  });
  return { released };
}

test('busy timeout: a 600 ms lock does not fail opening the dashboard or a decision write; a deferred select still gives up fast and stays queued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-click-lag-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  const storePath = join(dir, '.sterling', 'sterling.db');
  const seed = new SterlingStore(storePath);
  todo(seed, 'item');
  seed.close();
  let ctl: DashboardController | undefined;
  try {
    let lock = await holdLock(storePath, 600);
    const t0 = Date.now();
    ctl = openDashboard(storePath, { deferWrites: true });
    const now = new Date().toISOString();
    ctl.store.create({
      id: randomUUID(), type: 'decision', created_at: now, updated_at: now, author: 'conductor', status: 'active', superseded_by: null,
      links: [], scope: 'project', stack_tags: [], title: 'swap decision under a held lock', statement: 's', rationale: 'r', alternatives_rejected: [],
    } as never);
    assert.ok(Date.now() - t0 >= 300, 'the open and the decision write waited for the lock instead of failing');
    await lock.released;

    ctl.state(VP);
    await ctl.handle({ kind: 'click', x: 5, y: lineOf(0) }, VP);
    lock = await holdLock(storePath, 1500);
    const t1 = Date.now();
    assert.equal(ctl.flush(), true);
    assert.ok(Date.now() - t1 < 1000, `the deferred select gave up after ${Date.now() - t1} ms`);
    assert.equal(ctl.pending(), 1, 'and stays queued');
    await lock.released;
    assert.equal(ctl.flush(), false);
    assert.ok(ctl.store.takeSelection(), 'the retry saved it');
  } finally {
    ctl?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('busy timeout without deferWrites (the OpenCode host, which never flushes again): a busy write is dropped with a notice, not queued', async () => {
  const { dir, storePath, ctl } = fixture({});
  const locker = new DatabaseSync(storePath);
  try {
    todo(ctl.store, 'item');
    ctl.state(VP);
    locker.exec('BEGIN IMMEDIATE');
    await ctl.handle({ kind: 'click', x: 5, y: lineOf(0) }, VP);
    assert.equal(ctl.pending(), 0, 'nothing is left queued that no one would retry');
    assert.match(ctl.ui().notice ?? '', /^selection not handed to the next prompt — database is locked/);
  } finally {
    locker.exec('ROLLBACK');
    locker.close();
    ctl.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
