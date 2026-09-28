import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { initialUi, reduce, runEffects, TASKS_TAB, KNOWLEDGE_TAB, type UiState } from '../state.js';

// ===========================================================================
// TUI board-item edit (user-ruled 2026-09-28, board f25e5547 lane J): the
// Tasks tab gains an in-place edit action on the selected item, saving
// through the same store write path board_update uses (SterlingStore.
// updateTodo — same id, same slug, version bumped). Written TDD-first
// against the brief before touching state.ts.
//
// Fix round (Opus review of the first cut, feat/gap-hunt-round-1 71c1f41):
// 4 findings, added here TDD-first before the corresponding state.ts fix —
//   1. measured_at_head restamp on a text change (decision
//      board-provenance-measured-at-head), mirroring board_update
//      (packages/mcp-server/src/tools.ts:9684-9690): resolved via an
//      injectable `resolveHeadSha` 7th param on `reduce` (default: `git
//      rev-parse HEAD` in process.cwd() — state.ts has no repoRoot to thread
//      through without touching main.ts, which this round's scope excludes;
//      cwd is what a user's own git commands would resolve against too,
//      since sterling-tui is launched from the project directory). A
//      resolve failure surfaces a notice rather than silently keeping the
//      stale stamp — the text edit still saves (matches board_update's own
//      degrade-when-git-is-unavailable behaviour), it just isn't restamped.
//   2. lost-update guard: `boardEdit` now carries the `version` read when
//      'e' was pressed; ENTER re-reads the live record and refuses (visible
//      notice, buffer KEPT) if the version has moved.
//   3. vanished/non-live item at commit: a notice, never an uncaught throw
//      to main.ts's fatal handler.
//   4. test 7's "same slug" assertion was vacuous (store.create mints no
//      slug for a todo — only the mcp-server board_add tool layer does, via
//      mintHeadlineOf) — the fixture now sets one explicitly so the
//      assertion actually exercises updateTodo's "never touches slug" claim.
//
// CONTRACT this file OWNS:
//   • key 'e' on the Tasks tab, cursor on a (non-objective-header) todo card,
//     opens ui.boardEdit = { id, text, version } prefilled with the card's
//     full text and the record's CURRENT version (read fresh via store.get,
//     not from the projected Card, which carries no version field).
//   • while editing: every printable char (letters/digits/space/'q') feeds
//     the buffer (never triggers quit or a tab switch); BACKSPACE deletes;
//     ESCAPE cancels with no effect.
//   • ENTER on a non-empty, unmoved, still-live buffer commits a
//     { type: 'board_edit', id, text, version, measuredAtHead? } effect
//     (trimmed text) and closes the editor.
//   • ENTER on a buffer trimmed to empty commits NO effect and closes the
//     editor (never writes an empty board item).
//   • ENTER when the record's version has moved since 'e' was pressed
//     commits NO effect, sets a visible ui.notice, and KEEPS ui.boardEdit
//     (buffer and all) open — never a silent overwrite.
//   • ENTER when the record no longer exists, or is no longer live
//     (status 'superseded'), commits NO effect, sets a visible ui.notice,
//     and closes the editor.
//   • switching tabs mid-edit discards the in-progress edit, same rule as
//     the System tab's sparringModelEdit.
//   • runEffects executes 'board_edit' by writing through
//     SterlingStore.updateTodo — same id, same slug, version bumped by one;
//     a present `measuredAtHead` is written to `measured_at_head`, an
//     absent one leaves the field untouched (mirrors board_update).
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
  resolveHeadSha?: () => string | undefined,
): { ui: UiState; effects: { type: string }[] } {
  let cur = ui;
  const all: { type: string }[] = [];
  for (const ev of events) {
    const r = reduce(store, cur, ev as never, undefined, undefined, undefined, resolveHeadSha as never);
    cur = r.ui;
    for (const e of r.effects) all.push(e);
  }
  return { ui: cur, effects: all };
}

interface BoardEditEffectLike {
  type: string;
  id?: string;
  text?: string;
  version?: number;
  measuredAtHead?: string;
}
function findBoardEdit(effects: { type: string }[]): BoardEditEffectLike | undefined {
  return effects.find((e) => e.type === 'board_edit') as BoardEditEffectLike | undefined;
}

const FAKE_HEAD = 'a'.repeat(40);

test('board-edit 1: "e" on the Tasks tab opens the editor prefilled with the selected card text', () => {
  const { store, cleanup } = storeFixture();
  try {
    const created = store.create({ ...envelope('todo'), text: 'fix the facing', source: 'user' }) as { id: string; version: number };
    const r = reduce(store, st({ tab: TASKS_TAB, cursor: 0 }), charEv('e'));
    assert.ok(r.ui.boardEdit, '"e" opens boardEdit');
    assert.equal(r.ui.boardEdit!.text, 'fix the facing', 'prefilled with the card\'s full text');
    assert.equal(r.ui.boardEdit!.version, created.version, 'prefilled with the record\'s CURRENT version, read fresh via store.get');
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
    const res = drive(store, st({ tab: TASKS_TAB, cursor: 0 }), events, () => FAKE_HEAD);
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
    const res = drive(store, st({ tab: TASKS_TAB, cursor: 0 }), events, () => FAKE_HEAD);
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

test('board-edit 7: runEffects writes the new text through SterlingStore.updateTodo — same id, real slug preserved, version bumped (fix 4: the fixture now carries a REAL slug, since store.create mints none on its own)', () => {
  const { store, cleanup } = storeFixture();
  try {
    // fix 4: store.create mints no slug for a todo (only the mcp-server board_add
    // tool layer does, via mintHeadlineOf) — set one explicitly, the way
    // board_add would, so the "same slug" assertion below actually compares
    // two real strings instead of two `undefined`s.
    const created = store.create({ ...envelope('todo'), text: 'v1 text', source: 'user', slug: 'v1-text-item' }) as {
      id: string;
      slug?: string;
      version: number;
    };
    const before = store.get(created.id) as unknown as { id: string; slug?: string; version: number; text: string };
    assert.equal(before.slug, 'v1-text-item', 'fixture sanity: the seeded record really carries a slug');
    const ok = runEffects(store, [{ type: 'board_edit', id: created.id, text: 'v2 text', version: before.version }]);
    assert.equal(ok, false, 'board_edit is not a quit effect');
    const after = store.get(created.id) as unknown as { id: string; slug?: string; version: number; text: string };
    assert.equal(after.id, before.id, 'same id');
    assert.equal(after.slug, 'v1-text-item', 'same slug — updateTodo never mints, clears, or otherwise touches it');
    assert.equal(after.text, 'v2 text', 'text is updated');
    assert.equal(after.version, before.version + 1, 'version bumped by the in-place write path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Fix 1 — measured_at_head restamp on a text change, mirroring board_update
// ===========================================================================

test('board-edit 8 (fix 1): ENTER resolves HEAD via the injectable resolver; the committed effect carries it as measuredAtHead', () => {
  const { store, cleanup } = storeFixture();
  try {
    store.create({ ...envelope('todo'), text: 'stamp me', source: 'user' });
    const res = drive(store, st({ tab: TASKS_TAB, cursor: 0 }), [charEv('e'), charEv('!'), key('ENTER')], () => FAKE_HEAD);
    const commit = findBoardEdit(res.effects);
    assert.ok(commit, 'ENTER commits a board_edit effect');
    assert.equal(commit!.measuredAtHead, FAKE_HEAD, "the resolved HEAD sha rides the effect, mirroring board_update's restamp-on-text-change");
  } finally {
    cleanup();
  }
});

test('board-edit 8 (fix 1): runEffects writes the resolved measuredAtHead to measured_at_head', () => {
  const { store, cleanup } = storeFixture();
  try {
    const created = store.create({ ...envelope('todo'), text: 'v1', source: 'user' }) as { id: string; version: number };
    runEffects(store, [{ type: 'board_edit', id: created.id, text: 'v2', version: created.version, measuredAtHead: FAKE_HEAD }]);
    const after = store.get(created.id) as unknown as { measured_at_head?: string };
    assert.equal(after.measured_at_head, FAKE_HEAD, 'measured_at_head is restamped to the resolved sha');
  } finally {
    cleanup();
  }
});

test('board-edit 8 (fix 1): a resolver failure (git unavailable) still commits the text edit with NO measuredAtHead, and surfaces a visible notice rather than silently keeping the stale stamp', () => {
  const { store, cleanup } = storeFixture();
  try {
    store.create({ ...envelope('todo'), text: 'no git here', source: 'user' });
    const failing = () => {
      throw new Error('git: command not found');
    };
    const res = drive(store, st({ tab: TASKS_TAB, cursor: 0 }), [charEv('e'), charEv('!'), key('ENTER')], failing);
    const commit = findBoardEdit(res.effects);
    assert.ok(commit, 'the text edit still commits — a git failure degrades the restamp, it does not block the save (matches board_update)');
    assert.equal(commit!.measuredAtHead, undefined, 'no measuredAtHead is carried when the resolver fails');
    assert.match(res.ui.notice ?? '', /head/i, 'a visible notice names the failed HEAD resolution — never a silently-kept stale stamp');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Fix 2 — lost-update guard: a version that moved since 'e' was pressed
// ===========================================================================

test("board-edit 9 (fix 2): a version that moved since 'e' was pressed refuses the commit with a visible notice and KEEPS the buffer open", () => {
  const { store, cleanup } = storeFixture();
  try {
    const created = store.create({ ...envelope('todo'), text: 'original', source: 'user' }) as { id: string; version: number };
    const opened = reduce(store, st({ tab: TASKS_TAB, cursor: 0 }), charEv('e'));
    assert.ok(opened.ui.boardEdit, 'editor opened');
    // a concurrent write (another session/process sharing this store) moves
    // the version out from under this in-progress edit
    store.updateTodo(created.id, { ...(store.get(created.id) as Record<string, unknown>), text: 'changed elsewhere' });
    const typed = reduce(store, opened.ui, charEv('!'));
    const committed = reduce(store, typed.ui, key('ENTER'), undefined, undefined, undefined, () => FAKE_HEAD);
    assert.equal(findBoardEdit(committed.effects), undefined, 'no board_edit effect — the write is refused, never silently overwritten');
    assert.ok(committed.ui.boardEdit, 'the editor stays open — the buffer is kept, never discarded');
    assert.equal(committed.ui.boardEdit!.text, 'original!', 'the in-progress buffer survives the refusal untouched');
    assert.match(committed.ui.notice ?? '', /version|changed/i, 'a visible notice explains the refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// MEDIUM-1 (second Opus re-check round, on top of commit 22e20f9): after a
// version-conflict refusal, boardEdit.version was left pointing at the STALE
// (pre-conflict) version forever, so the notice's "press ENTER to try again"
// was false — every subsequent ENTER re-read the same stale version, saw the
// same mismatch, and refused again in an infinite loop with no way out but
// ESCAPE. Fixed: on refusal, boardEdit.version now moves to the CURRENT
// version, so the very next ENTER (version now matching) writes.
// ===========================================================================

test("board-edit 11 (MEDIUM-1): after a version-conflict refusal, the SECOND ENTER writes — boardEdit.version was adopted to the current version, not left stale", () => {
  const { store, cleanup } = storeFixture();
  try {
    const created = store.create({ ...envelope('todo'), text: 'original', source: 'user' }) as { id: string; version: number };
    const opened = reduce(store, st({ tab: TASKS_TAB, cursor: 0 }), charEv('e'));
    const conflicting = store.updateTodo(created.id, {
      ...(store.get(created.id) as Record<string, unknown>),
      text: 'changed elsewhere',
    }) as { version: number };
    const typed = reduce(store, opened.ui, charEv('!'));

    // FIRST ENTER: refused (version moved) — but the refusal must ADOPT the
    // current version into the kept buffer, not leave the stale one behind.
    const firstAttempt = reduce(store, typed.ui, key('ENTER'), undefined, undefined, undefined, () => FAKE_HEAD);
    assert.equal(findBoardEdit(firstAttempt.effects), undefined, 'first ENTER is still refused — the buffer has not been re-synced yet');
    assert.ok(firstAttempt.ui.boardEdit, 'the editor stays open after the first refusal');
    assert.equal(
      firstAttempt.ui.boardEdit!.version,
      conflicting.version,
      'boardEdit.version is moved to the CURRENT version on refusal — this is the bug fix: without it, every future ENTER refuses again forever'
    );
    assert.match(
      firstAttempt.ui.notice ?? '',
      /changed since it was opened/i,
      "the notice says the item changed since it was opened (not the old 'press ENTER to try again' wording, which was false — the OLD ENTER kept refusing)"
    );
    assert.match(firstAttempt.ui.notice ?? '', /enter again/i, 'the notice says ENTER again overwrites it');
    assert.match(firstAttempt.ui.notice ?? '', /esc/i, 'the notice says ESC cancels');

    // SECOND ENTER: version now matches (adopted above) — this MUST write.
    const secondAttempt = reduce(store, firstAttempt.ui, key('ENTER'), undefined, undefined, undefined, () => FAKE_HEAD);
    const commit = findBoardEdit(secondAttempt.effects);
    assert.ok(commit, 'the second ENTER commits a board_edit effect — the false "press ENTER to try again" promise is now true');
    assert.equal(commit!.text, 'original!', 'the committed text is the buffer that survived both refusals');
    assert.equal(commit!.version, conflicting.version, 'the effect carries the ADOPTED version, matching what is actually live in the store');
    assert.equal(secondAttempt.ui.boardEdit, undefined, 'the editor closes on the successful second commit');

    // integration: runEffects can actually apply this effect without a
    // version-conflict throw, proving the adopted version really matches
    // what applyInPlace's own expected_version guard sees.
    assert.doesNotThrow(() => runEffects(store, secondAttempt.effects), 'the store write succeeds — the adopted version is genuinely current');
    const after = store.get(created.id) as unknown as { text: string; version: number };
    assert.equal(after.text, 'original!', 'the store now holds the overwritten text');
    assert.equal(after.version, conflicting.version + 1, 'version bumped once more by this second, now-successful write');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Fix 3 — the item vanishing (or going non-live) before commit
// ===========================================================================

test('board-edit 10 (fix 3): the item vanishing before commit (e.g. board_remove elsewhere) surfaces a notice instead of throwing', () => {
  const { store, cleanup } = storeFixture();
  try {
    const created = store.create({ ...envelope('todo'), text: 'about to vanish', source: 'user' }) as { id: string };
    const opened = reduce(store, st({ tab: TASKS_TAB, cursor: 0 }), charEv('e'));
    assert.ok(opened.ui.boardEdit, 'editor opened');
    store.remove(created.id);
    assert.doesNotThrow(() => {
      const committed = reduce(store, opened.ui, key('ENTER'), undefined, undefined, undefined, () => FAKE_HEAD);
      assert.equal(findBoardEdit(committed.effects), undefined, 'no board_edit effect for a vanished item');
      assert.equal(committed.ui.boardEdit, undefined, 'the editor closes — nothing left to edit');
      assert.match(committed.ui.notice ?? '', /no longer exists|vanished|gone/i, 'a visible notice explains what happened');
    }, 'a vanished item at commit time never throws to the fatal handler');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// LOW-2 (second Opus re-check round): main.ts now roots the HEAD resolver at
// dirname(dirname(storePath)) — the project owning the store (main.ts's own
// agentsDir already used this exact expression) — rather than state.ts's
// default resolver's process.cwd() fallback, which is only correct when
// sterling-tui happens to be launched from the project directory.
//
// main.ts itself CANNOT be unit-tested by importing it here: it runs
// side-effecting startup code at MODULE EVALUATION time (argv parsing that
// calls process.exit(2) when --store is missing, the non-TTY guard, a
// dynamic terminal-kit import) — importing it would kill this test process
// before a single assertion ran. Its only existing coverage is the built-
// bundle smoke test (scripts/tests/tui-bundle.test.mjs, STERLING_TUI_SMOKE=1).
// This pins the one genuinely testable, side-effect-free piece of the fix:
// the path arithmetic main.ts's resolver is rooted on.
// ===========================================================================

test('LOW-2: the project root main.ts roots its HEAD resolver at is dirname(dirname(storePath)) — climbing <project>/.sterling/sterling.db back to <project>, the same expression main.ts already used for agentsDir', () => {
  const storePath = '/mnt/c/Users/chulf/some-project/.sterling/sterling.db';
  assert.equal(dirname(dirname(storePath)), '/mnt/c/Users/chulf/some-project', 'two dirname() calls climb .sterling/sterling.db back to the project root');
});
