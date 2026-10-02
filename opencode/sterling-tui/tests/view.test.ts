import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { initialUi } from '@sterling/tui/dist/state.js';
import { SIDEBAR_WIDTH, disabledEffectsFor, escapeLeavesView, findStorePath, guarded, keyToUiEvent, readFlags, readSidebarSummary, sidebarLines, type SidebarSummary } from '../view.ts';

const ID = '0123abcd-0000-4000-8000-000000000000';

function summary(over: Partial<SidebarSummary> = {}): SidebarSummary {
  return { open: 3, high: 1, blocked: 1, top: [{ label: 'Port the dashboard to OpenCode 2', id: ID }], queue: 4, notices: [], ...over };
}

test('sidebar: counts, top tasks as label (id8), queue depth, all within the column budget', () => {
  const lines = sidebarLines(summary(), SIDEBAR_WIDTH);
  assert.ok(lines.some((l) => /3 open/.test(l) && /1 high/.test(l) && /1 blocked/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /queue 4 waiting/i.test(l)), lines.join('\n'));
  assert.ok(lines.every((l) => l.length <= SIDEBAR_WIDTH), `a line exceeds ${SIDEBAR_WIDTH} columns`);
});

test('sidebar: a long label clips but the id8 never does', () => {
  const long = 'A very long board item headline that cannot possibly fit in the sidebar column';
  const lines = sidebarLines(summary({ top: [{ label: long, id: ID }] }), SIDEBAR_WIDTH);
  const row = lines.find((l) => l.includes('(0123abcd)'));
  assert.ok(row, 'the id8 is shown whole');
  assert.ok(row.length <= SIDEBAR_WIDTH);
  assert.match(row, /…/, 'the label is visibly clipped');
});

test('sidebar: notices render as warning lines; an empty board says so', () => {
  const lines = sidebarLines(summary({ open: 0, high: 0, blocked: 0, top: [], queue: 0, notices: ['store unreadable — boom'] }), SIDEBAR_WIDTH);
  assert.ok(lines.some((l) => /no open tasks/i.test(l)));
  assert.ok(lines.some((l) => l.startsWith('! ') && /store unreadable/.test(l)));
});

test('readSidebarSummary: counts user tasks, high priority, open blockers and the system queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-sidebar-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const now = new Date().toISOString();
    const base = { created_at: now, updated_at: now, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
    const mk = (over: Record<string, unknown>) => store.create({ ...base, id: randomUUID(), type: 'todo', ...over } as never);
    mk({ source: 'user', text: 'First thing', slug: 'first-thing' });
    mk({ source: 'user', text: 'Urgent thing', priority: 'high' });
    mk({ source: 'user', text: 'Waits on the first', blocked_by: ['first-thing'] });
    mk({ source: 'system', text: 'reconcile_needed: x', system_reason: 'reconcile_needed' });
    const s = readSidebarSummary(store);
    assert.equal(s.open, 3);
    assert.equal(s.high, 1);
    assert.equal(s.blocked, 1);
    assert.equal(s.queue, 1);
    assert.equal(s.top[0].label, 'Urgent thing', 'high priority sorts first');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guarded: a throwing read becomes an error value, never a throw', () => {
  const r = guarded('board', () => { throw new Error('disk gone'); });
  assert.deepEqual(r, { ok: false, error: 'board unavailable — disk gone' });
  assert.deepEqual(guarded('board', () => 5), { ok: true, value: 5 });
});

test('keyToUiEvent: navigation keys, printable characters, shift+tab, ctrl chords ignored', () => {
  assert.deepEqual(keyToUiEvent({ name: 'up' }), { kind: 'key', name: 'UP' });
  assert.deepEqual(keyToUiEvent({ name: 'down' }), { kind: 'key', name: 'DOWN' });
  assert.deepEqual(keyToUiEvent({ name: 'left' }), { kind: 'key', name: 'LEFT' });
  assert.deepEqual(keyToUiEvent({ name: 'right' }), { kind: 'key', name: 'RIGHT' });
  assert.deepEqual(keyToUiEvent({ name: 'tab' }), { kind: 'key', name: 'TAB' });
  assert.deepEqual(keyToUiEvent({ name: 'tab', shift: true }), { kind: 'key', name: 'LEFT' });
  assert.deepEqual(keyToUiEvent({ name: 'return' }), { kind: 'key', name: 'ENTER' });
  assert.deepEqual(keyToUiEvent({ name: 'enter' }), { kind: 'key', name: 'ENTER' });
  assert.deepEqual(keyToUiEvent({ name: 'escape' }), { kind: 'key', name: 'ESCAPE' });
  assert.deepEqual(keyToUiEvent({ name: 'backspace' }), { kind: 'key', name: 'BACKSPACE' });
  assert.deepEqual(keyToUiEvent({ name: 'space', sequence: ' ' }), { kind: 'char', ch: ' ' });
  assert.deepEqual(keyToUiEvent({ name: 'a', sequence: 'A', shift: true }), { kind: 'char', ch: 'A' });
  assert.deepEqual(keyToUiEvent({ name: '3', sequence: '3' }), { kind: 'char', ch: '3' });
  assert.equal(keyToUiEvent({ name: 'g', ctrl: true, sequence: '\x07' }), undefined);
  assert.equal(keyToUiEvent({ name: 'x', meta: true, sequence: 'x' }), undefined);
});

test('escapeLeavesView: Esc leaves only when no edit, picker or search is open', () => {
  assert.equal(escapeLeavesView(initialUi), true);
  assert.equal(escapeLeavesView({ ...initialUi, tab: 1, searchQuery: 'x' }), false);
  assert.equal(escapeLeavesView({ ...initialUi, boardEdit: { id: 'i', text: '', version: 1 } }), false);
  assert.equal(escapeLeavesView({ ...initialUi, tab: 3, sparringModelEdit: '' }), false);
  assert.equal(escapeLeavesView({ ...initialUi, tab: 3, selector: { key: 'k', stage: 'model', highlight: 0 } }), false);
});

test('flags: both pending-ruling functions default OFF and map to disabled effects', () => {
  const off = readFlags({});
  assert.deepEqual(off, { modelSwap: false, recordHandoff: false });
  const d = disabledEffectsFor(off);
  assert.equal(d.select, null, 'the record handoff drops silently (the view labels it instead)');
  assert.match(d.model_swap ?? '', /pending a ruling/);
  assert.deepEqual(readFlags({ STERLING_OC_MODEL_SWAP: '1', STERLING_OC_RECORD_HANDOFF: '1' }), { modelSwap: true, recordHandoff: true });
  assert.deepEqual(disabledEffectsFor({ modelSwap: true, recordHandoff: true }), {});
  assert.deepEqual(readFlags({ STERLING_OC_MODEL_SWAP: 'yes' }), { modelSwap: false, recordHandoff: false }, 'only 1 turns a flag on');
});

test('findStorePath: STERLING_STORE wins; otherwise the nearest .sterling/sterling.db walking up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oc-find-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    assert.equal(findStorePath(join(dir, 'a', 'b'), {}), join(dir, '.sterling', 'sterling.db'));
    assert.equal(findStorePath(join(dir, 'a'), { STERLING_STORE: '/x/y.db' }), '/x/y.db');
    assert.equal(findStorePath(tmpdir(), {}), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
