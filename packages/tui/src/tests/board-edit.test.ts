import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { initialUi, reduce, runEffects, TASKS_TAB, KNOWLEDGE_TAB, type UiState } from '../state.js';

// ===========================================================================
// TUI board-item edit (user-ruled 2026-09-28, board f25e5547 lane J): the
// Tasks tab gains an in-place edit action on the selected item, saving
// through the same store write path board_update uses (SterlingStore.
// updateTodo — same id, same slug, version bumped). Written TDD-first
// against the brief before touching state.ts.
//
// CONTRACT this file OWNS:
//   • key 'e' on the Tasks tab, cursor on a (non-objective-header) todo card,
//     opens ui.boardEdit = { id, text } prefilled with the card's full text.
//   • while editing: every printable char (letters/digits/space/'q') feeds
//     the buffer (never triggers quit or a tab switch); BACKSPACE deletes;
//     ENTER commits a { type: 'board_edit', id, text } effect with the
//     trimmed buffer and closes the editor; ESCAPE cancels with no effect.
//   • an edit that trims to empty commits NO effect (never writes an empty
//     board item) and simply closes the editor.
//   • switching tabs mid-edit discards the in-progress edit, same rule as
//     the System tab's sparringModelEdit.
//   • runEffects executes 'board_edit' by writing through
//     SterlingStore.updateTodo — same id, same slug, version bumped by one.
// ===========================================================================

const st = (over: Partial<UiState> = {}): UiState => ({ ...initialUi, ...over });
const key = (name: string) => ({ kind: 'key' as const, name: name as never });
const charEv = (ch: string) => ({ kind: 'char' as const, ch });

function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-edit-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function envelope(type: string) {
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function drive(
  store: SterlingStore,
  ui: UiState,
  events: unknown[],
): { ui: UiState; effects: { type: string }[] } {
  let cur = ui;
  const all: { type: string }[] = [];
  for (const ev of events) {
    const r = reduce(store, cur, ev as never);
    cur = r.ui;
    for (const e of r.effects) all.push(e);
  }
  return { ui: cur, effects: all };
}

function findBoardEdit(effects: { type: string }[]): { type: string; id?: string; text?: string } | undefined {
  return effects.find((e) => e.type === 'board_edit') as { type: string; id?: string; text?: string } | undefined;
}

test('board-edit 1: "e" on the Tasks tab opens the editor prefilled with the selected card text', () => {
  const { store, cleanup } = storeFixture();
  try {
    store.create({ ...envelope('todo'), text: 'fix the facing', source: 'user' });
    const r = reduce(store, st({ tab: TASKS_TAB, cursor: 0 }), charEv('e'));
    assert.ok(r.ui.boardEdit, '"e" opens boardEdit');
    assert.equal(r.ui.boardEdit!.text, 'fix the facing', 'prefilled with the card\'s full text');
  } finally {
    cleanup();
  }
});

test('board-edit 2: typed chars (incl. digits, space, "q") accumulate; BACKSPACE deletes; ENTER commits trimmed', () => {
  const { store, cleanup } = storeFixture();
  try {
    store.create({ ...envelope('todo'), text: 'old', source: 'user' });
    const events = [
      charEv('e'),
      charEv(' '), charEv('5'), charEv('q'),
      key('BACKSPACE'),
      key('ENTER'),
    ];
    const res = drive(store, st({ tab: TASKS_TAB, cursor: 0 }), events);
    assert.ok(!res.effects.some((e) => e.type === 'quit'), '"q" while editing never triggers quit');
    const commit = findBoardEdit(res.effects);
    assert.ok(commit, 'ENTER commits a board_edit effect');
    assert.equal(commit!.text, 'old 5', 'buffer reflects the prefilled text plus the typed chars minus the backspaced trailing "q"');
    assert.equal(res.ui.boardEdit, undefined, 'editor closes on commit');
  } finally {
    cleanup();
  }
});

test('board-edit 3: ESCAPE cancels with no effect and closes the editor', () => {
  const { store, cleanup } = storeFixture();
  try {
    store.create({ ...envelope('todo'), text: 'keep me', source: 'user' });
    const res = drive(store, st({ tab: TASKS_TAB, cursor: 0 }), [charEv('e'), charEv('z'), key('ESCAPE')]);
    assert.equal(findBoardEdit(res.effects), undefined, 'ESCAPE emits no board_edit effect');
    assert.equal(res.ui.boardEdit, undefined, 'editor closes on cancel');
  } finally {
    cleanup();
  }
});

test('board-edit 4: committing an edit trimmed to empty emits no effect and closes the editor', () => {
  const { store, cleanup } = storeFixture();
  try {
    store.create({ ...envelope('todo'), text: 'ab', source: 'user' });
    const events = [charEv('e'), key('BACKSPACE'), key('BACKSPACE'), key('ENTER')];
    const res = drive(store, st({ tab: TASKS_TAB, cursor: 0 }), events);
    assert.equal(findBoardEdit(res.effects), undefined, 'an empty commit writes nothing');
    assert.equal(res.ui.boardEdit, undefined, 'editor closes even on an empty commit');
  } finally {
    cleanup();
  }
});

test('board-edit 5: switching tabs mid-edit discards the in-progress edit', () => {
  const { store, cleanup } = storeFixture();
  try {
    store.create({ ...envelope('todo'), text: 'abc', source: 'user' });
    const editing = drive(store, st({ tab: TASKS_TAB, cursor: 0 }), [charEv('e'), charEv('z'), charEv('z')]);
    assert.ok(editing.ui.boardEdit, 'editor is open before the tab switch');
    const awayThenBack = drive(store, editing.ui, [{ kind: 'tab', index: KNOWLEDGE_TAB }, { kind: 'tab', index: TASKS_TAB }]);
    assert.equal(awayThenBack.ui.boardEdit, undefined, 'boardEdit is discarded on tab switch');
  } finally {
    cleanup();
  }
});

test('board-edit 6: "e" on the Knowledge tab feeds the search field instead (no boardEdit)', () => {
  const { store, cleanup } = storeFixture();
  try {
    const r = reduce(store, st({ tab: KNOWLEDGE_TAB }), charEv('e'));
    assert.equal(r.ui.boardEdit, undefined, 'Knowledge tab never opens boardEdit');
    assert.equal(r.ui.searchQuery, 'e', '"e" feeds the always-visible search field there instead');
  } finally {
    cleanup();
  }
});

test('board-edit 7: runEffects writes the new text through SterlingStore.updateTodo — same id, same slug, version bumped', () => {
  const { store, cleanup } = storeFixture();
  try {
    const created = store.create({ ...envelope('todo'), text: 'v1 text', source: 'user' }) as { id: string; slug?: string; version: number };
    const before = store.get(created.id) as unknown as { id: string; slug?: string; version: number; text: string };
    const ok = runEffects(store, [{ type: 'board_edit', id: created.id, text: 'v2 text' }]);
    assert.equal(ok, false, 'board_edit is not a quit effect');
    const after = store.get(created.id) as unknown as { id: string; slug?: string; version: number; text: string };
    assert.equal(after.id, before.id, 'same id');
    assert.equal(after.slug, before.slug, 'same slug — updateTodo never mints or clears one');
    assert.equal(after.text, 'v2 text', 'text is updated');
    assert.equal(after.version, before.version + 1, 'version bumped by the in-place write path');
  } finally {
    cleanup();
  }
});
