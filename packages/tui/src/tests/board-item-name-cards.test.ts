// ---------------------------------------------------------------------------
// S2 of the human-readable-ids objective — TUI HALF (board rows and queue rows).
// Ruling [human-readable-ids-for-board-items] (knowledge_get 2e8c30e4);
// AC23 of [mcp-tool-surface] (knowledge_get 7e24629b) for the handle contract.
//
// WRITTEN SPEC-ONLY AND BLIND to viewmodel.ts / state.ts. Every assertion is
// derived from the ruling and the slice brief, never from the implementation.
//
// THE RULING, with the justification clause that makes it binding:
//   "Every human-facing surface prints `name (id8)` — name first, id retained:
//    ... TUI board rows ... Names clip, ids never do, BECAUSE A TRUNCATED ID IS
//    UNRESOLVABLE WHILE A TRUNCATED NAME IS STILL RECOGNISABLE."
//
// THE MEASURED GAP: todoCards builds `{id: todo.id, title: todo.text.split('\n')[0], ...}`
// and queueCards does the same — neither reads `slug`, so a TUI row can only
// ever show prose, and the id a reader would have to cite is nowhere on the row
// at all. That is the surface the user was looking at when they reported having
// "no way of knowing what that refers to".
//
// THE CLIP CONTRACT, identical to the sibling pins and stated once more here so
// this file is readable alone:
//   NAME_CLIP = 48 characters, ellipsis INCLUDED — clipName(n) = n.length <= 48
//   ? n : n.slice(0, 47) + '…'; the composed title is `${clipName(name)} (${id8})`.
//   Derivation: the mint clamps a slug at 60 (de1a7329); the ` (id8)` half costs
//   11 characters; 60 - 11 = 49, rounded DOWN to 48 so the constant survives the
//   id form gaining a character. The composed title is then 59 characters, inside
//   the 60-character budget the codebase already uses.
//
// A CONSTRAINT THIS FILE DID NOT CHOOSE, AND THE CONDUCTOR SHOULD SEE IT:
// state.test.ts already freezes `todoCards(store).map(c => c.title)` as
// `['first todo', 'second todo']` for todos created WITHOUT a slug. That arm is
// frozen, so the legacy/slugless rendering is FORCED: a card with no minted name
// keeps its bare first-text-line title and gains nothing — no id8, no derived
// name. T0 pins exactly that, and it is the graceful-degradation answer for this
// surface whether or not it is the one an unconstrained design would have picked.
//
// EXPECTED STATE: the S2 implementation has LANDED and was verified, so EVERY
// arm here is GREEN. From here they are REGRESSION pins, each naming the
// one-line sabotage that must turn it red. T0 is PROVEN load-bearing, not
// merely claimed: an unconditional ` (id8)` append on nameless cards turns T0
// RED while T1 and T2 stay GREEN — exactly the hollow shape it exists to catch.
//
// CORRECTED 2026-08-29: T5 was UNSATISFIABLE as authored — it compared the
// rendered row text against the bare composed title, but state.ts prepends a
// 2-char selection marker to every row. The implementation was correct; the
// oracle was off by the marker. See `rowTitle` below and T5's own note.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { todoCards } from '../viewmodel.js';
import * as viewmodel from '../viewmodel.js';
import { buildDashboardState, initialUi, QUEUE_TAB } from '../state.js';

const NOW = '2026-08-29T12:00:00.000Z';

const NAME_CLIP = 48;
const ELLIPSIS = '…';
const clipName = (n: string): string => (n.length <= NAME_CLIP ? n : n.slice(0, NAME_CLIP - 1) + ELLIPSIS);
const id8 = (id: string): string => id.slice(0, 8);
const displayForm = (name: string, id: string): string => `${clipName(name)} (${id8(id)})`;

/** Exactly 48 characters — ON the boundary, must render whole. */
const SLUG_48 = 'board-items-render-their-readable-name-beside-id';
/** Exactly 49 characters — one past it, must clip to 47 + ellipsis. */
const SLUG_49 = 'board-items-render-their-readable-name-beside-ids';

/** A card as the two builders expose it. Narrowed to the two fields this oracle
 *  reads, and reached through a cast so the file compiles however Card is
 *  declared; every read existence-asserts FIRST, so a missing builder fails on
 *  an assertion rather than a TypeError. */
interface CardLike {
  id: string;
  title: string;
}

/** queueCards is exported from viewmodel.ts but has no test coverage at HEAD, so
 *  it is reached through the module-namespace cast the frozen P2 oracle in
 *  state.test.ts already uses for not-yet-pinned viewmodel members. */
interface QueueViewmodel {
  queueCards?: (store: SterlingStore) => CardLike[];
}
const vm = viewmodel as unknown as QueueViewmodel;

function envelope(type: string) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-item-name-cards-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, cleanup };
}

/** Seeds a board item straight through the store, so a `slug` can be present or
 *  absent by construction — the tool layer's mint would always supply one. */
function seedTodo(store: SterlingStore, extra: Record<string, unknown>): string {
  const rec = store.create({ ...envelope('todo'), source: 'user', ...extra } as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };
  return rec.id;
}

const cards = (store: SterlingStore): CardLike[] => todoCards(store) as unknown as CardLike[];

/**
 * A RENDERED row's title, with the row CHROME removed and nothing else.
 *
 * state.ts prepends a 2-character selection marker to EVERY row — `'› '` on the
 * cursor row, `'  '` otherwise — followed by depth padding. That is not this
 * slice's behaviour and it is FROZEN elsewhere: state.test.ts:415 strips exactly
 * `/^› /` before comparing a joined body, and :1812/:1840 pin the unselected
 * two-space form plus the 6-space and 8-space depth pads. This helper is those
 * frozen facts and nothing more — it does NOT invent a third convention.
 *
 * It asserts the prefix IS a marker before removing it, so no non-whitespace
 * junk can hide inside the strip: everything after the marker is then compared
 * byte-for-byte by the caller, which is what keeps T5 an EQUALITY pin rather
 * than a substring one.
 */
function rowTitle(text: string): string {
  assert.match(
    text,
    /^(› | {2})/,
    `every rendered row leads with the 2-char selection marker ('› ' when the cursor is on it, '  ' when it is not) — got ${JSON.stringify(text)}`
  );
  return text.slice(2).trimStart();
}

// ---------------------------------------------------------------------------
// SECTION T — BOARD CARDS.
// ---------------------------------------------------------------------------

test('T0 CONTROL (placed FIRST, must pass for the OPPOSITE reason, and passes at HEAD): a SLUGLESS board item still renders its bare first-text-line title and gains NOTHING — no id8, no derived name — so every composed-handle failure below is a MISSING COMPOSITION, never a broken card builder', () => {
  // SABOTAGE that must turn this arm RED: in packages/tui/src/viewmodel.ts make
  // todoCards fall back to `${todo.id.slice(0,8)} (${todo.id.slice(0,8)})` — or
  // to any unconditional `title + ' (' + id8 + ')'` — when a todo has no slug.
  //
  // WHY IT IS FIRST AND WHY IT IS THE POINT: "the card shows a composed handle"
  // has more than one possible cause. An implementation that appends ` (id8)`
  // to EVERY card title passes T1 and T3 perfectly while breaking the frozen
  // state.test.ts arm and, worse, handing the reader a bare hex fragment dressed
  // as a name for exactly the items that have no name — the failure AC23's
  // display-name suppression exists to prevent (absent name over wrong name,
  // df361a0f). This arm must pass for the opposite reason: nothing is composed
  // where there is nothing to compose from.
  const { store, cleanup } = fixture();
  try {
    seedTodo(store, { text: 'first todo', priority: 'high' });
    seedTodo(store, { text: 'second todo' });

    const titles = cards(store).map((c) => c.title);
    assert.deepEqual(
      titles,
      ['first todo', 'second todo'],
      'a slugless card is byte-identical to what state.test.ts already freezes — S2 adds a name where one EXISTS, it never invents one'
    );
    for (const c of cards(store)) {
      assert.ok(!c.title.includes(`(${id8(c.id)})`), `no id8 is appended to a nameless card — got "${c.title}"`);
      assert.ok(!/\([0-9a-f]{8}\)/.test(c.title), `and nothing hex-shaped is appended either — got "${c.title}"`);
    }
  } finally {
    cleanup();
  }
});

test('T1 THE COMPOSED CARD TITLE: a board item carrying a minted handle renders `name (id8)` as its card title — name FIRST, id retained (ruling 2e8c30e4)', () => {
  // SABOTAGE that must turn this test RED: in packages/tui/src/viewmodel.ts
  // revert todoCards' title to `todo.text.split('\n')[0]`.
  const { store, cleanup } = fixture();
  try {
    const id = seedTodo(store, { text: 'EXPORT THE BOARD AS CSV.\n\nbody prose.', slug: 'export-the-board-as-csv', priority: 'high' });

    const card = cards(store).find((c) => c.id === id);
    assert.ok(card, 'the seeded item produced a card');
    assert.equal(
      card!.title,
      `export-the-board-as-csv (${id8(id)})`,
      `THE DEFECT THIS CATCHES: the title falling back to the first line of text ("EXPORT THE BOARD AS CSV.") — a todoCards that builds {id, title: todo.text.split('\\n')[0]} and never reads slug, so a TUI board row shows prose with no citable handle anywhere on it`
    );
    // Name FIRST is load-bearing: the rejected alternative "drop the id and show
    // only the name" was rejected because the id keeps the reference ACTIONABLE,
    // and the accepted shape leads with the half a human recognises.
    assert.ok(card!.title.startsWith('export-the-board-as-csv'), 'the NAME leads — a row a reader scans is scanned by its name');
    assert.ok(card!.title.endsWith(`(${id8(id)})`), 'and the id follows it in parentheses');
  } finally {
    cleanup();
  }
});

test('T2 QUEUE CARDS TOO: a maintenance item carrying a handle renders `name (id8)` on the queue row, and a handle-less queue item degrades exactly as a handle-less board item does', () => {
  // SABOTAGE that must turn this test RED: in packages/tui/src/viewmodel.ts
  // revert queueCards' title to `todo.text.split('\n')[0]`.
  //
  // WHICH ARM CARRIES THE VERDICT: the first assertion. The second (the
  // handle-less queue item) is an IN-ARM CONTROL that must pass for the opposite
  // reason — without it, "queue rows show a composed handle" is equally well
  // satisfied by an unconditional append, which is the same hollow shape T0
  // guards against on the board side. Whether maintenance items mint handles of
  // their own is deliberately NOT settled here (S1's E3 left it open); this arm
  // seeds one directly so the rendering contract is pinned either way.
  const { store, cleanup } = fixture();
  try {
    assert.strictEqual(typeof vm.queueCards, 'function', 'viewmodel.queueCards must exist — it is the builder behind the TUI queue tab');

    const namedId = store.create({
      ...envelope('todo'),
      text: "reconcile article 'tui-dashboard' — files it owns were touched in direct mode",
      source: 'system',
      system_reason: 'reconcile_needed',
      slug: 'reconcile-the-tui-dashboard-article',
    } as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };
    const bareId = store.create({
      ...envelope('todo'),
      text: 'capture something',
      source: 'system',
      system_reason: 'capture_owed',
    } as unknown as Parameters<SterlingStore['create']>[0]) as { id: string };

    const rows = vm.queueCards!(store);
    const named = rows.find((c) => c.id === namedId.id);
    const bare = rows.find((c) => c.id === bareId.id);
    assert.ok(named && bare, 'both maintenance items produced queue cards');

    assert.equal(
      named!.title,
      `reconcile-the-tui-dashboard-article (${id8(namedId.id)})`,
      `THE DEFECT THIS CATCHES: a queueCards that builds {id, title: todo.text.split('\\n')[0]} and never reads slug — got "${named!.title}"`
    );
    assert.equal(
      bare!.title,
      'capture something',
      'IN-ARM CONTROL: a queue item with no handle keeps its bare text line and gains no hex fragment — nothing composed where there is nothing to compose from'
    );
  } finally {
    cleanup();
  }
});

test('T3 CLIPPING, BOTH SIDES OF THE BOUNDARY: a 48-character name renders WHOLE on the card; a 49-character name clips to 47 chars + "…"; and the id8 is INTACT after the clip', () => {
  // SABOTAGE that must turn this test RED: in packages/tui/src/viewmodel.ts
  // remove the clip from the composed title (render the whole name).
  //
  // WHICH ARM CARRIES WHICH VERDICT — said explicitly, because either arm alone
  // would be hollow: the 48-char arm alone is satisfied by an implementation
  // that never clips; the 49-char arm alone is satisfied by one that clips every
  // name aggressively, destroying the recognisability the ruling clips names to
  // PRESERVE. Only the pair pins the boundary. The id8 assertion under the
  // clipped arm is what makes "names clip, ids never do" one statement rather
  // than two unrelated ones.
  const { store, cleanup } = fixture();
  try {
    assert.equal(SLUG_48.length, 48, 'premise: exactly on the boundary');
    assert.equal(SLUG_49.length, 49, 'premise: exactly one past it');

    const onId = seedTodo(store, { text: 'A HANDLE EXACTLY ON THE BOUNDARY.\n\nbody.', slug: SLUG_48 });
    const overId = seedTodo(store, { text: 'A HANDLE ONE PAST THE BOUNDARY.\n\nbody.', slug: SLUG_49 });

    const byId = new Map(cards(store).map((c) => [c.id, c] as const));
    const on = byId.get(onId);
    const over = byId.get(overId);
    assert.ok(on && over, 'both seeded items produced cards');

    // --- ON the boundary: whole ---------------------------------------------
    assert.equal(
      on!.title,
      `${SLUG_48} (${id8(onId)})`,
      `a name of exactly ${NAME_CLIP} characters renders WHOLE — clipping starts PAST the budget, not at it. Got "${on!.title}"`
    );
    assert.ok(!on!.title.includes(ELLIPSIS), 'no ellipsis at the boundary');
    assert.equal(on!.title.length, 59, 'self-check on the stated derivation: 48 name chars + 11 for " (id8)" = 59, inside the 60 budget');

    // --- ONE PAST the boundary: clipped, id intact ---------------------------
    const expected = `${SLUG_49.slice(0, 47)}${ELLIPSIS} (${id8(overId)})`;
    assert.equal(expected, displayForm(SLUG_49, overId), 'self-check: expectation and stated contract agree');
    assert.equal(
      over!.title,
      expected,
      `47 name characters, an ellipsis, then the UNTOUCHED id8. Got "${over!.title}"`
    );
    assert.ok(!over!.title.includes(SLUG_49), 'the over-long name does NOT render in full — the name is the half allowed to lose information');
    assert.ok(
      over!.title.endsWith(`(${id8(overId)})`),
      'AND THE ID IS INTACT AFTER THE CLIP — the load-bearing half: a truncated id is unresolvable, a truncated name is still recognisable'
    );
    assert.ok(over!.title.startsWith(SLUG_49.slice(0, 20)), 'the clip keeps the LEADING characters — a tail-clip would leave the row unrecognisable');
    assert.equal(over!.title.length, 59, 'the clipped title lands on the same 59 characters — the clip is what makes the budget hold');
  } finally {
    cleanup();
  }
});

test('T4 IDS NEVER CLIP — THE REGRESSION PIN: the card still carries the FULL uuid in its `id` field; the 8-char form inside the parentheses is a DISPLAY abbreviation and must never replace the machine address', () => {
  // SABOTAGE that must turn this test RED: in packages/tui/src/viewmodel.ts
  // change todoCards' `id` to `todo.id.slice(0, 8)` (let the display
  // abbreviation become the card's identity).
  //
  // GREEN AT HEAD AND MUST STAY GREEN. This is not decoration: state.ts emits
  // `{type:'select', recordType:'todo', id}` effects off the card id, and every
  // destroying call downstream refuses anything but the exact full uuid (AC23,
  // anti-pattern no-bounded-trail-guard-for-destructive-addressing, severity
  // BLOCK). A card whose id had been shortened to match what it displays would
  // silently break selection and make its own row unremovable.
  const { store, cleanup } = fixture();
  try {
    const id = seedTodo(store, { text: 'KEEP THE FULL ID ON THE CARD.\n\nbody.', slug: 'keep-the-full-id-on-the-card' });
    const card = cards(store).find((c) => c.id === id);
    assert.ok(card, 'the seeded item produced a card');
    assert.equal(card!.id.length, 36, `the card id is the FULL uuid — got "${card!.id}" (${card!.id.length} chars)`);
    assert.equal(card!.id, id, 'byte for byte');
    assert.notEqual(card!.id, id8(id), 'the display abbreviation is NOT the card identity');
  } finally {
    cleanup();
  }
});

test('T5 END TO END THROUGH THE RENDERED ROW: the composed `name (id8)` handle reaches the TUI board row a person actually looks at — not just the card builder — and the queue tab does the same', () => {
  // SABOTAGE that must turn this test RED: in packages/tui/src/viewmodel.ts
  // revert todoCards' title to `todo.text.split('\n')[0]`.
  //
  // WHY THIS ARM EXISTS BESIDE T1: T1 pins the BUILDER. The ruling names "TUI
  // board rows" — the rendered surface. An implementation that composes a
  // handle in the viewmodel while state.ts rebuilds its row text from the raw
  // record would leave T1 green and the user's actual complaint untouched. The
  // width is left unbounded so the pane's own ellipsis clipping (a separate,
  // already-frozen behaviour) cannot mask or fake the result.
  //
  // CORRECTED 2026-08-29 — THIS ARM WAS UNSATISFIABLE AS WRITTEN, AND THE
  // IMPLEMENTATION WAS NEVER AT FAULT. It compared `row.lines[0].text` against
  // the bare composed title; the actual is `'› export-the-board-as-csv (id8)'`.
  // The 2-char selection marker is prepended by state.ts to EVERY row, is not
  // this slice's behaviour, and is frozen elsewhere (state.test.ts:415 strips
  // exactly `/^› /`; :1812/:1840 pin the unselected two-space form). The handle
  // DOES reach the rendered row — the oracle was simply off by the marker. It
  // now goes through `rowTitle`, which is those frozen facts in one place, and
  // stays a full EQUALITY pin on everything after the chrome.
  const { store, cleanup } = fixture();
  try {
    const boardId = seedTodo(store, { text: 'EXPORT THE BOARD AS CSV.\n\nbody prose.', slug: 'export-the-board-as-csv', priority: 'high' });
    store.create({
      ...envelope('todo'),
      text: 'reconcile the dashboard article',
      source: 'system',
      system_reason: 'reconcile_needed',
      slug: 'reconcile-the-dashboard-article',
    } as unknown as Parameters<SterlingStore['create']>[0]);

    const board = buildDashboardState(store, initialUi);
    const row = board.rows.find((r) => r.id === boardId);
    assert.ok(row, 'the board tab renders a row for the item');
    assert.equal(
      rowTitle(row!.lines[0].text),
      `export-the-board-as-csv (${id8(boardId)})`,
      `the rendered board row must read as the composed handle. THE DEFECT THIS CATCHES: a row that reads "EXPORT THE BOARD AS CSV." with no handle anywhere on it — the surface the user was looking at when they reported having no way to know what an item refers to. Got ${JSON.stringify(row!.lines[0].text)}`
    );

    const queue = buildDashboardState(store, { ...initialUi, tab: QUEUE_TAB });
    assert.equal(queue.rows.length, 1, 'the queue tab renders the one maintenance item');
    assert.equal(
      rowTitle(queue.rows[0].lines[0].text),
      `reconcile-the-dashboard-article (${id8(queue.rows[0].id)})`,
      `the queue row does the same — the defect it catches is a row that reads its raw text line. Got ${JSON.stringify(queue.rows[0].lines[0].text)}`
    );
  } finally {
    cleanup();
  }
});
