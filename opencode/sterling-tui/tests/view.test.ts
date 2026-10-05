import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { initialUi } from '@sterling/tui/dist/state.js';
import { mulberry32, POOL_SIZE, SEQUENCE, TILE_BG, DONE_FADE, fadeToTile } from '@sterling/tui/dist/avatars/index.js';
import * as view from '../view.ts';
import { SIDEBAR_WIDTH, escapeLeavesView, findStorePath, guarded, keyToUiEvent, readSidebarSummary, readSubagents, sidebarLines, bodyLinesFor, emptyAvatars, portraitLines, stepAvatars, subagentRowLines, subagentSpanLines, PORTRAIT_HEIGHT, PORTRAIT_WIDTH, type SpanLine, type SubagentRow, type SidebarSummary, type SubagentSource } from '../view.ts';

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

test('both dashboard functions are on in OpenCode: no flag gate is left (decision 48903a6f, DASHBOARD FUNCTIONS)', () => {
  assert.equal('readFlags' in view, false);
  assert.equal('disabledEffectsFor' in view, false);
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

// ---- running sub-agents (board running-subagents-in-sterling-s-opencode-2-panel) ----

const ROOT = 'ses_root0000000000000000';
const kid = (n: number) => `ses_00000000000000${n}abcdef`;
const tokens = (input: number, output = 0) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } });

function source(over: Partial<SubagentSource> = {}): SubagentSource {
  return {
    sessions: [
      { id: ROOT, title: 'main work' },
      { id: kid(1), parentID: ROOT, title: 'explore the repo' },
      { id: kid(2), parentID: ROOT, title: 'review the diff' },
      { id: 'ses_other', title: 'unrelated root' },
      { id: 'ses_otherkid', parentID: 'ses_other', title: 'belongs elsewhere' },
    ],
    rootID: ROOT,
    isRunning: (id) => id === kid(2),
    lastTurn: (id) => (id === kid(2) ? { tokens: tokens(40_000, 10_000), model: { id: 'big-pickle', providerID: 'opencode' } } : undefined),
    contextLimit: () => 200_000,
    ...over,
  };
}

test('subagents: only descendants of the root, active first, with status, context % and model', () => {
  const rows = readSubagents(source());
  assert.deepEqual(rows.map((r) => r.id), [kid(2), kid(1)], "the running child sorts first; another root's children are excluded");
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].context, '25%');
  assert.equal(rows[0].model, 'big-pickle');
  assert.equal(rows[1].status, 'idle');
  assert.equal(rows[1].context, '?', 'no turn yet: unknown');
  assert.equal(rows[1].model, '-');
});

test('subagents: nested children count, and a parent cycle cannot loop', () => {
  const nested = readSubagents(source({ sessions: [{ id: ROOT }, { id: kid(1), parentID: ROOT }, { id: kid(3), parentID: kid(1), title: 'grandchild' }] }));
  assert.deepEqual(nested.map((r) => r.id).sort(), [kid(1), kid(3)].sort());
  const cyclic = readSubagents(source({ sessions: [{ id: ROOT }, { id: kid(1), parentID: kid(2) }, { id: kid(2), parentID: kid(1) }] }));
  assert.deepEqual(cyclic, [], 'a cycle detached from the root is not reachable');
});

test('subagents: context % is unknown without a limit, and counts every token class', () => {
  const noLimit = readSubagents(source({ contextLimit: () => undefined }));
  assert.equal(noLimit[0].context, '?');
  const all = readSubagents(source({ lastTurn: () => ({ tokens: { input: 1000, output: 1000, reasoning: 1000, cache: { read: 500, write: 500 } }, model: { id: 'm', providerID: 'p' } }), contextLimit: () => 8000 }));
  assert.equal(all[0].context, '50%');
  const zero = readSubagents(source({ contextLimit: () => 0 }));
  assert.equal(zero[0].context, '?', 'a zero limit is no limit');
});

test('subagents: the session model is used when no turn has a model yet; a blank title falls back to the id', () => {
  const rows = readSubagents(source({ sessions: [{ id: ROOT }, { id: kid(1), parentID: ROOT, title: '  ', model: { id: 'gpt-x', providerID: 'p' } }], lastTurn: () => undefined }));
  assert.equal(rows[0].title, kid(1).slice(-8));
  assert.equal(rows[0].model, 'gpt-x');
});

// ---- animated portraits (board animated-avatars-for-each-subagent-in-sterling-s-opencode-2) ----

const plain = (line: SpanLine) => line.map((sp) => sp.text).join('');
const widthOf = (line: SpanLine) => [...plain(line)].length;
const row = (over: Partial<SubagentRow> = {}): SubagentRow => ({ id: kid(2), title: 'review the diff', status: 'active', context: '25%', model: 'big-pickle', ...over });

test('portrait: a 6x3 quadrant-block sprite on an 8x3 tinted tile, no drawn frame, explicit bg on every span', () => {
  const lines = portraitLines(5, 0);
  assert.equal(PORTRAIT_WIDTH, 8);
  assert.equal(PORTRAIT_HEIGHT, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => widthOf(l) === PORTRAIT_WIDTH), lines.map(plain).join('\n'));
  const spans = lines.flat();
  assert.ok(spans.every((sp) => /^[ ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█]+$/.test(sp.text)), 'quadrant blocks and spaces only: no box-drawing frame');
  assert.ok(spans.every((sp) => /^#[0-9a-f]{6}$/.test(sp.bg ?? '')), 'a bg on every span, so no colour is left unset');
  assert.ok(spans.some((sp) => sp.fg && sp.bg && sp.bg !== TILE_BG), 'a pixel pair carries both halves');
  for (const l of lines) {
    assert.equal(l[0]!.bg, TILE_BG);
    assert.ok(l[0]!.text.startsWith(' ') && l.at(-1)!.text.endsWith(' '), 'one padding column each side');
  }
});

test('portrait: idle fades every portrait colour with the shared fadeToTile, the tile stays TILE_BG; active is unchanged', () => {
  const active = portraitLines(5, 0, 'active');
  const idle = portraitLines(5, 0, 'idle');
  assert.deepEqual(active, portraitLines(5, 0), 'active (and the default) draws the sprite as before');
  assert.deepEqual(idle.map(plain), active.map(plain), 'same glyphs, only the colours change');
  // one entry per character, so run merging cannot hide a difference
  const perChar = (lines: SpanLine[]) => lines.map((l) => l.flatMap((sp) => [...sp.text].map(() => ({ fg: sp.fg, bg: sp.bg }))));
  const faded = (c: string | undefined) => (c === undefined ? undefined : fadeToTile(c, DONE_FADE));
  assert.deepEqual(perChar(idle), perChar(active).map((l) => l.map((c) => ({ fg: faded(c.fg), bg: faded(c.bg) }))), 'the Claude dashboard fade, cell for cell');
  assert.ok(perChar(active).flat().some((c) => c.fg !== undefined && faded(c.fg) !== c.fg), 'the fade changes at least one portrait colour');
  for (const l of idle) {
    assert.equal(l[0]!.bg, TILE_BG, 'the tile padding keeps TILE_BG');
    assert.equal(l.at(-1)!.bg, TILE_BG);
  }
});

test('subagent row: an idle row draws its portrait faded and an active row in full colour', () => {
  const active = subagentRowLines(row({ status: 'active' }), 7, 0, 60);
  const idle = subagentRowLines(row({ status: 'idle' }), 7, 0, 60);
  const tile = (lines: SpanLine[], status: 'active' | 'idle') => {
    const portrait = portraitLines(7, 0, status);
    return lines.map((l, i) => l.slice(0, portrait[i]!.length));
  };
  assert.deepEqual(tile(active, 'active'), portraitLines(7, 0, 'active'));
  assert.deepEqual(tile(idle, 'idle'), portraitLines(7, 0, 'idle'));
  assert.notDeepEqual(portraitLines(7, 0, 'idle'), portraitLines(7, 0, 'active'));
});

test('subagent row: tile left with title, `status · ctx · model` and description on its right, and no avatar number', () => {
  const lines = subagentRowLines(row({ description: 'check the new tile layout' }), 7, 0, 60);
  assert.equal(lines.length, PORTRAIT_HEIGHT);
  assert.ok(lines.every((l) => widthOf(l) <= 60), lines.map(plain).join('\n'));
  const side = lines.map((l) => plain(l).slice(PORTRAIT_WIDTH + 1));
  assert.deepEqual(side, ['review the diff', 'active · 25% ctx · big-pickle', 'check the new tile layout']);
  assert.ok(lines.every((l) => widthOf(l) > PORTRAIT_WIDTH), 'three text lines beside the portrait');
  assert.ok(!/#\d|avatar|\b7\b/.test(lines.map(plain).join('\n')), 'no avatar number anywhere');
  // without a description the third line is empty rather than missing
  assert.equal(plain(subagentRowLines(row(), 7, 0, 60)[2]!).slice(PORTRAIT_WIDTH + 1), '');
  // the ~34-col sidebar leaves 25 columns for text: the status line clips, the title and portrait stay whole
  const narrow = subagentRowLines(row({ model: 'claude-opus-5-5' }), 7, 0, SIDEBAR_WIDTH).map(plain);
  assert.ok(narrow.every((l) => [...l].length <= SIDEBAR_WIDTH));
  assert.equal(narrow[1]!.slice(PORTRAIT_WIDTH + 1), 'active · 25% ctx · claud…');
});

test('subagent row: a long title and model clip to the text column', () => {
  const lines = subagentRowLines(row({ title: 'A very long sub-agent title that cannot possibly fit', model: 'a-very-long-model-name-indeed' }), 7, 0, SIDEBAR_WIDTH);
  assert.ok(lines.every((l) => widthOf(l) <= SIDEBAR_WIDTH), lines.map(plain).join('\n'));
  assert.match(lines.map(plain).join('\n'), /…/);
});

test('subagent row: too narrow for portrait plus text puts the text under the portrait', () => {
  const lines = subagentRowLines(row(), 7, 0, PORTRAIT_WIDTH + 4);
  assert.equal(lines.length, PORTRAIT_HEIGHT + 3);
  assert.ok(lines.slice(0, PORTRAIT_HEIGHT).every((l) => widthOf(l) === PORTRAIT_WIDTH));
  assert.deepEqual(lines.slice(PORTRAIT_HEIGHT).map(plain).map((t) => t.length <= PORTRAIT_WIDTH + 4), [true, true, true]);
  assert.match(lines.slice(PORTRAIT_HEIGHT).map(plain).join('\n'), /review/);
});

test('subagent row: animates only while active, idle is always frame 0', () => {
  const frames = (status: SubagentRow['status']) => new Set(Array.from({ length: SEQUENCE.length }, (_, t) => subagentRowLines(row({ status }), 7, t, SIDEBAR_WIDTH).slice(0, PORTRAIT_HEIGHT).map(plain).join('\n')));
  assert.equal(frames('idle').size, 1);
  assert.ok(frames('active').size > 1, 'a running portrait changes frame over time');
  const rest = subagentRowLines(row({ status: 'idle' }), 7, 0, SIDEBAR_WIDTH).map(plain).join('\n');
  assert.equal(subagentRowLines(row({ status: 'idle' }), 7, 5, SIDEBAR_WIDTH).map(plain).join('\n'), rest);
});

test('subagent block: heading counts active ones, one portrait row each, none says so', () => {
  const rows = readSubagents(source());
  const lines = subagentSpanLines(rows, new Map(rows.map((r, i) => [r.id, i])), 0, SIDEBAR_WIDTH);
  assert.equal(plain(lines[0]!), 'Sub-agents (1 active)');
  assert.equal(lines.length, 1 + rows.length * PORTRAIT_HEIGHT + (rows.length - 1), 'one blank line between rows');
  assert.ok(lines.every((l) => widthOf(l) <= SIDEBAR_WIDTH));
  assert.deepEqual(subagentSpanLines([], new Map(), 0).map(plain), ['Sub-agents (0 active)', 'no sub-agents']);
  // the full view draws the same rows at its wider width: portrait and text side by side
  assert.equal(subagentSpanLines(rows, new Map(), 0, 100).length, lines.length);
});

test('avatars: a sub-agent keeps its portrait across refreshes, warm or idle, and distinct live ones differ', () => {
  const rng = mulberry32(42);
  let st = stepAvatars(emptyAvatars(), [kid(1), kid(2)], rng);
  const first = new Map(st.current);
  assert.notEqual(first.get(kid(1)), first.get(kid(2)));
  for (let i = 0; i < 20; i++) st = stepAvatars(st, [kid(1), kid(2)], rng);
  assert.deepEqual(st.current, first);
  st = stepAvatars(st, [kid(1), kid(2), kid(3)], rng);
  assert.equal(st.current.get(kid(1)), first.get(kid(1)));
  assert.equal(st.current.get(kid(2)), first.get(kid(2)));
  assert.ok(st.current.get(kid(3))! < POOL_SIZE);
});

test('avatars: leaving the family frees the portrait for the next arrival', () => {
  const rng = mulberry32(7);
  let st = stepAvatars(emptyAvatars(), Array.from({ length: POOL_SIZE }, (_, i) => `ses_${i}`), rng);
  const gone = st.current.get('ses_0')!;
  const keep = new Map(st.current);
  keep.delete('ses_0');
  st = stepAvatars(st, Array.from({ length: POOL_SIZE - 1 }, (_, i) => `ses_${i + 1}`), rng);
  assert.deepEqual(st.current, keep, 'the others keep theirs');
  assert.deepEqual(st.freed, [gone]);
  st = stepAvatars(st, [...keep.keys(), 'ses_new'], rng);
  assert.equal(st.current.get('ses_new'), gone, 'with the pool full, a newcomer takes the freed portrait');
});

test('full view: the controller body window shrinks by the sub-agent block so the cursor stays visible', () => {
  assert.equal(bodyLinesFor(40, 0), 32);
  assert.equal(bodyLinesFor(40, 1 + 1 + 2 * PORTRAIT_HEIGHT + 1), 32 - 9);
  assert.equal(bodyLinesFor(20, 50), 3, 'never below three rows');
});
