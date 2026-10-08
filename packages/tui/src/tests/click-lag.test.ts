import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
      todo(ctl.store, 'locked item');
      ctl.state(VP);
      ctl.store.writeSelection = () => {
        throw new Error('database is locked');
      };
      await ctl.handle({ kind: 'click', x: 5, y: lineOf(0) }, VP); // rejects on regression
      if (deferWrites) assert.equal(ctl.flush(), true, 'flush reports the failure so the host redraws');
      assert.match(ctl.ui().notice ?? '', /^selection not handed to the next prompt — database is locked$/);
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
    ctl.store.updateTodo = () => {
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
