// ---------------------------------------------------------------------------
// S1 of the human-readable-ids objective (board f85c9ec5, parent 0165350e,
// ruling [human-readable-ids-for-board-items] / 2e8c30e4): `todo` gains an
// auto-minted human-readable SLUG, built by extending the machinery decision
// [de1a7329] already shipped for decision / anti_pattern / research_finding.
//
// WRITTEN SPEC-ONLY AND BLIND to records.ts / index.ts / tools.ts. Every
// assertion below is derived from the two decision records and the board
// slice, never from the implementation.
//
// THE FOUR THINGS THIS FILE PINS, and why each one is here:
//
//   (1) MINT — a board item's ALL-CAPS opening headline derives a kebab-case
//       slug, <=60 chars, punctuation and noise dropped, body prose excluded.
//       (de1a7329: "minted from the headline ... kebab-case, <=60 chars".)
//   (2) DETERMINISTIC CLASH SUFFIX — the same headline twice yields
//       <slug> then <slug>-2, and the sequence is reproducible in a second
//       independent store, i.e. derived from the headline alone and never
//       from a random/temporal source.
//   (3) EXPLICIT COLLISION IS REFUSED LOUDLY, CROSS-TYPE, NOTHING WRITTEN —
//       de1a7329's load-bearing rule, and the reason it exists: knowledge_get
//       resolves ONE namespace, so a slug colliding with ANY slug-bearing
//       record (feature_article, decision, another todo) must refuse rather
//       than silently suffix. Both directions are pinned: a todo may not take
//       a live knowledge slug, and a knowledge record may not take a live
//       todo slug — the todo has JOINED the one namespace, or it has not.
//   (4) THE ADDRESSING SPLIT, which is NEW relative to the precedent and is
//       the most important thing in this file. A slug is a FORGIVING address
//       form. It belongs on the RECOVERABLE surface (board_get, board_update)
//       and MUST BE REFUSED by every DESTROYING call — board_remove and
//       maintenance_remove keep demanding the exact full uuid. This is
//       anti-pattern [no-bounded-trail-guard-for-destructive-addressing]
//       (severity BLOCK): an earlier design that made a forgiving form "safe"
//       for a hard delete by consulting a bounded trail was RETRACTED THE
//       SAME DAY IT SHIPPED, after two independent reviews proved the guard
//       is frequently just absent and that an absent trail reads as
//       permission to delete. A slug rung on board_remove would re-open that
//       closed block-severity finding, and these tests are what stands in
//       front of it. See the sibling pin board-maintenance-id-resolution.test.ts,
//       whose refusal-shape constants this file deliberately reuses.
//
// CONTROL ARMS ARE MANDATORY HERE AND ARE PLACED FIRST IN EACH SECTION.
// Several verdicts in this file have more than one possible cause — "the
// refusal happened" is equally satisfied by "board_add refuses every explicit
// slug" or "board_remove refuses everything". Each section therefore opens
// with an arm that must PASS for the OPPOSITE reason, so a green in that
// section always carries its own evidence.
//
// EXPECTED STATE AT HEAD: RED. `todo` carries no slug (knowledge_schema
// confirms: text, source, file_keys, feature_link, priority, system_reason,
// objective, measured_at_head — no slug). All calls are routed through a
// structurally-typed view of SterlingTools so the FILE COMPILES at HEAD and
// the failures are behavioural assertion failures rather than TS2339/TS2353
// compile crashes, which would prove nothing.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-29T12:00:00.000Z';

type Loose = Record<string, unknown>;

// A structurally-typed view of the tool surface. `slug` is not on todoSchema
// at HEAD, so a literal `{ text, source, slug }` would be a COMPILE error
// (TS2353) and would take the whole file down with a crash instead of a red
// assertion. Routing through this view keeps every failure behavioural.
interface ToolsView {
  boardAdd(fields: Loose): { record: Loose };
  boardGet(id: string): Loose;
  boardUpdate(id: string, patch: Loose): Loose;
  boardRemove(id: string): Loose;
  boardQuery(filter: Loose): Loose[];
  maintenanceEnqueue(fields: Loose): { record: Loose };
  maintenanceRemove(id: string): Loose;
  maintenanceQuery(filter: Loose): Loose[];
  knowledgeCreate(type: string, fields: Loose): { record: Loose };
  knowledgeGet(id: string): Loose;
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-item-slug-mint-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const real = new SterlingTools({ store, now: () => NOW });
  const tools = real as unknown as ToolsView;
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// STRICT kebab-case: lowercase alphanumerics in hyphen-separated words, no
// leading/trailing hyphen, no doubled hyphen, no uppercase, no non-ASCII, no
// punctuation. This is what "kebab-case" MEANS — it is not an extra rule
// invented here. It is also the single assertion that catches the classic
// naive implementations: a raw `.slice(0, 60)` (trailing hyphen), a
// space->hyphen replace without collapsing (doubled hyphen), and a derive
// that leaves punctuation or non-ASCII in the handle.
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Refusal-shape constants, reused VERBATIM from the sibling pin
// board-maintenance-id-resolution.test.ts so the two files specify one
// contract rather than two dialects of it. Flexible alternation, not an exact
// string match — the wording is the implementer's; the SUBSTANCE is the pin.
const FULL_UUID_REQUIRED = /full uuid|full id/i;
const HARD_DELETE_REASON = /hard.?delet|permanent(ly)? delet|irreversib|retarget/i;
const COLLISION_REFUSAL = /already exists|already in use|collide/i;

function boardAdd(tools: ToolsView, fields: Loose): Loose {
  return tools.boardAdd(fields).record;
}

// Reads the minted handle. Prefers the board_add echo (S2 renders names from
// receipts) and falls back to a board_get read, so a missing-from-the-echo
// defect fails ONE named assertion in section A rather than silently taking
// out every other arm in the file.
function slugOf(tools: ToolsView, record: Loose): string | undefined {
  const fromEcho = record.slug;
  if (typeof fromEcho === 'string' && fromEcho.length > 0) return fromEcho;
  const read = tools.boardGet(record.id as string);
  const fromRead = read.slug;
  return typeof fromRead === 'string' && fromRead.length > 0 ? fromRead : undefined;
}

function requireSlug(tools: ToolsView, record: Loose, why: string): string {
  const slug = slugOf(tools, record);
  assert.ok(
    slug,
    `${why} — EXPECTED FAILURE AT HEAD: \`todo\` has no slug field at all (knowledge_schema('todo') lists none), so nothing is minted and this reads undefined`
  );
  return slug as string;
}

function mkArticle(tools: ToolsView, slug: string): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does the thing.',
    intended_behavior: 'behaves as described.',
    files: [{ path: `src/${slug}.ts`, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record;
}

function mkDecision(tools: ToolsView, fields: Loose): Loose {
  return tools.knowledgeCreate('decision', {
    title: 'a ruling',
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
    ...fields,
  }).record;
}

// A slugless LEGACY board row: an item that predates the mint. Built by
// cloning a real item, stripping any slug and re-minting the id — the same
// raw-row convention id-resolution.test.ts and the dead-slug suites use, since
// ids and server-owned fields cannot be forced through the public tool.
function seedLegacySluglessItem(store: SterlingStore, tools: ToolsView, text: string): string {
  const modern = boardAdd(tools, { text, source: 'user', priority: 'high' });
  const legacy = JSON.parse(JSON.stringify(modern)) as Loose;
  delete legacy.slug;
  legacy.id = randomUUID();
  store.create(legacy as unknown as Parameters<SterlingStore['create']>[0]);
  tools.boardRemove(modern.id as string); // full uuid — the permitted address form
  return legacy.id as string;
}

// ---------------------------------------------------------------------------
// SECTION A — MINTING: the headline derives the handle.
// ---------------------------------------------------------------------------

test('A0 CONTROL (must pass for the OPPOSITE reason, and passes at HEAD): board_add with no slug still creates a normal item that board_get resolves by uuid — so every slug failure below is a MISSING MINT, never a broken board surface', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'EXPORT THE BOARD AS CSV.\n\nbody', source: 'user', priority: 'high' });
    assert.ok(typeof item.id === 'string' && (item.id as string).length > 0, 'the item was created and carries an id');
    assert.equal(tools.boardGet(item.id as string).id, item.id, 'and board_get resolves it by its full uuid');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'exactly one item exists — creating never mints a second row');
  } finally {
    cleanup();
  }
});

test('A1 MINT: a known ALL-CAPS headline produces a KNOWN slug — kebab-case, punctuation dropped, body prose excluded — and the board_add ECHO carries it (S2 renders names from receipts)', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, {
      text: 'EXPORT THE BOARD AS CSV.\n\nBody prose mentioning zebra and quartz that must never reach the handle.',
      source: 'user',
    });

    assert.equal(
      item.slug,
      'export-the-board-as-csv',
      'EXPECTED FAILURE AT HEAD: undefined !== "export-the-board-as-csv" — the board_add receipt carries no slug because `todo` has no slug field'
    );

    const slug = requireSlug(tools, item, 'the minted handle must be readable back off the item');
    assert.match(slug, KEBAB, 'the handle is strict kebab-case');
    assert.ok(!/zebra|quartz/.test(slug), 'the derive reads the HEADLINE only — body prose never reaches the handle');
  } finally {
    cleanup();
  }
});

test('A2 MINT BOUNDARY: a headline carrying punctuation, non-ASCII and leading/trailing noise still yields a strict kebab handle (no stray punctuation, no doubled or edge hyphens, <=60) that board_get resolves', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, {
      text: '   ***  MINT A HUMAN-READABLE SLUG — “naïve” CAFÉ RÉSUMÉ, ROUND ONE!  ***\n\nbody prose.',
      source: 'user',
    });
    const slug = requireSlug(tools, item, 'a noisy headline must still mint a handle');

    // Deliberately NOT pinned: whether a non-ASCII letter transliterates
    // (café -> cafe) or is stripped (café -> caf). Neither decision record
    // settles it, so inventing one here would be a fabricated spec. What IS
    // pinned is that whatever comes out is a usable ASCII kebab handle.
    assert.match(slug, KEBAB, 'strict kebab: lowercase ASCII words, single hyphens, no leading/trailing hyphen');
    assert.ok(slug.length <= 60, `the <=60 clamp holds for a noisy headline too — got ${slug.length}`);
    assert.ok(!slug.includes('--'), 'runs of dropped punctuation collapse to ONE hyphen, never a doubled one');
    for (const word of ['mint', 'human', 'readable', 'slug']) {
      assert.ok(slug.includes(word), `the handle stays recognisable — it keeps the headline word "${word}"`);
    }
    assert.equal(tools.boardGet(slug).id, item.id, 'and the noisy-headline handle is a real address: board_get resolves it');
  } finally {
    cleanup();
  }
});

test('A3 MINT BOUNDARY: an over-long headline is clamped to <=60 chars WITHOUT leaving a trailing hyphen (the naive `.slice(0, 60)` defect) and the leading words survive', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, {
      text: 'IMPLEMENT THE EXTREMELY LONG AND UNREASONABLY VERBOSE HEADLINE THAT CONTINUES WELL BEYOND SIXTY CHARACTERS OF KEBAB TEXT.\n\nbody.',
      source: 'user',
    });
    const slug = requireSlug(tools, item, 'a long headline must still mint a handle');

    assert.ok(slug.length <= 60, `the <=60 clamp is the spec (de1a7329) — got ${slug.length}`);
    assert.match(slug, KEBAB, 'the clamped handle is STILL strict kebab — a raw 60-char slice can end mid-hyphen and this catches it');
    assert.ok(
      slug.startsWith('implement-the-extremely-long'),
      `the clamp keeps the LEADING words so the handle stays recognisable — got "${slug}"`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECTION B — DETERMINISTIC CLASH SUFFIX on an AUTO-DERIVE (de1a7329's rule).
// ---------------------------------------------------------------------------

const CLASH_TEXT = 'ADD A DETERMINISTIC CLASH SUFFIX.\n\nbody.';

test('B1 CLASH: the SAME headline three times yields <slug>, <slug>-2, <slug>-3 in that order — an auto-derive clash suffixes, it never collides and never refuses', () => {
  const { tools, cleanup } = harness();
  try {
    const first = requireSlug(tools, boardAdd(tools, { text: CLASH_TEXT, source: 'user' }), 'first item mints');
    const second = requireSlug(tools, boardAdd(tools, { text: CLASH_TEXT, source: 'user' }), 'second item mints');
    const third = requireSlug(tools, boardAdd(tools, { text: CLASH_TEXT, source: 'user' }), 'third item mints');

    assert.equal(second, `${first}-2`, 'the second auto-derive suffixes -2 onto the SAME base, not a fresh base');
    assert.equal(third, `${first}-3`, 'the third suffixes -3 — the counter walks, it does not re-suffix (-2-2)');
    assert.ok(!third.includes('-2-2'), 'never a suffix stacked on a suffix');
    assert.equal(new Set([first, second, third]).size, 3, 'three distinct handles — one handle resolves to one record');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 3, 'and all three items were actually created — the clash never blocks an auto-derive');
  } finally {
    cleanup();
  }
});

test('B2 DETERMINISM CONTROL: the identical create sequence in a SECOND, independent store yields the IDENTICAL handles — the suffix is derived from the headline, never from a random or temporal source', () => {
  const run = () => {
    const { tools, cleanup } = harness();
    try {
      return [
        requireSlug(tools, boardAdd(tools, { text: CLASH_TEXT, source: 'user' }), 'run item 1'),
        requireSlug(tools, boardAdd(tools, { text: CLASH_TEXT, source: 'user' }), 'run item 2'),
      ];
    } finally {
      cleanup();
    }
  };

  const runA = run();
  const runB = run();
  assert.deepEqual(runB, runA, 'same headlines in, same handles out — deterministic across independent stores');
  for (const slug of runA) {
    assert.ok(!/[0-9a-f]{8}/.test(slug), `a handle must carry no id/hash fragment — got "${slug}"`);
  }
});

// ---------------------------------------------------------------------------
// SECTION C — EXPLICIT SLUG: accepted when free, REFUSED LOUDLY when taken,
// cross-type, in BOTH directions, with nothing written.
// ---------------------------------------------------------------------------

test('C0 CONTROL (must pass for the OPPOSITE reason): an EXPLICIT, non-colliding slug is ACCEPTED verbatim and becomes a real address — so the refusals below are collision-specific, not "board_add rejects every explicit slug"', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'A CHOSEN HANDLE.\n\nbody.', source: 'user', slug: 'my-chosen-handle' });
    assert.equal(
      slugOf(tools, item),
      'my-chosen-handle',
      'EXPECTED FAILURE AT HEAD: `slug` is not on todoSchema, so board_add either refuses the unknown field or drops it — either way this is undefined'
    );
    assert.equal(tools.boardGet('my-chosen-handle').id, item.id, 'the explicit handle resolves through board_get');
  } finally {
    cleanup();
  }
});

test('C1 COLLISION (CROSS-TYPE, the load-bearing rule): an explicit slug already held by a live feature_article is REFUSED loudly — the refusal names the colliding handle, the incumbent still owns it, and NO board item is created (verified by querying, never inferred from the throw)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'shared-handle');

    assert.throws(
      () => tools.boardAdd({ text: 'A COLLIDING ITEM.\n\nbody.', source: 'user', slug: 'shared-handle' }),
      (err: Error) => {
        assert.ok(err.message.includes('shared-handle'), `the refusal must NAME the colliding handle — got: "${err.message}"`);
        assert.match(err.message, COLLISION_REFUSAL, `the refusal must say the handle is taken — got: "${err.message}"`);
        return true;
      },
      'EXPECTED FAILURE AT HEAD: board_add knows nothing about slugs — either it throws an unknown-field validation error (whose message names the FIELD, not the colliding handle, so the includes() assertion fails) or it creates the item and assert.throws reports "Missing expected exception"'
    );

    assert.equal(
      tools.knowledgeGet('shared-handle').id,
      article.id,
      'the named handle identifies the INCUMBENT — one accidental write must not brick slug addressing'
    );
    assert.equal(
      tools.boardQuery({ source: 'user' }).length,
      0,
      'NOTHING WAS WRITTEN — the board is empty, checked directly rather than inferred from the refusal'
    );
    assert.throws(
      () => tools.boardGet('shared-handle-2'),
      'an EXPLICIT collision REFUSES — it must never be silently suffixed into shared-handle-2 (that rule is for auto-derives only)'
    );
  } finally {
    cleanup();
  }
});

test('C2 COLLISION (CROSS-TYPE into the ruling namespace): an explicit slug already held by a live decision is refused the same way, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const decision = mkDecision(tools, { slug: 'one-handle-one-record' });

    assert.throws(
      () => tools.boardAdd({ text: 'ANOTHER COLLIDING ITEM.\n\nbody.', source: 'user', slug: 'one-handle-one-record' }),
      (err: Error) => {
        assert.ok(err.message.includes('one-handle-one-record'), `names the colliding handle — got: "${err.message}"`);
        assert.match(err.message, COLLISION_REFUSAL, `says the handle is taken — got: "${err.message}"`);
        return true;
      },
      'EXPECTED FAILURE AT HEAD: board_add performs no slug-collision check at all'
    );

    assert.equal(tools.knowledgeGet('one-handle-one-record').id, decision.id, 'the decision still owns the handle');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'nothing was written');
  } finally {
    cleanup();
  }
});

test('C3 COLLISION (WITHIN TYPE): an explicit slug already MINTED by another board item is refused — the mint and the explicit path share one uniqueness rule', () => {
  const { tools, cleanup } = harness();
  try {
    const incumbent = boardAdd(tools, { text: 'HOLD THIS HANDLE.\n\nbody.', source: 'user' });
    const taken = requireSlug(tools, incumbent, 'the incumbent mints a handle to collide with');

    assert.throws(
      () => tools.boardAdd({ text: 'A DIFFERENT HEADLINE ENTIRELY.\n\nbody.', source: 'user', slug: taken }),
      (err: Error) => {
        assert.ok(err.message.includes(taken), `names the colliding handle — got: "${err.message}"`);
        assert.match(err.message, COLLISION_REFUSAL, `says the handle is taken — got: "${err.message}"`);
        return true;
      },
      'EXPECTED FAILURE AT HEAD: no slug exists, so requireSlug above already failed; after the mint lands, this fails if board_add checks only knowledge records and not other todos'
    );

    assert.equal(tools.boardGet(taken).id, incumbent.id, 'the incumbent still owns its handle');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'still exactly one item — the colliding create wrote nothing');
  } finally {
    cleanup();
  }
});

test('C4 COLLISION (THE REVERSE DIRECTION — the arm that proves `todo` actually JOINED the one namespace): a knowledge_create carrying a slug a board item already holds is refused, with a free-handle create passing first as the control', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'ONE NAMESPACE FOR EVERY HANDLE.\n\nbody.', source: 'user' });
    const taken = requireSlug(tools, item, 'the board item mints the handle the decision will try to steal');

    // CONTROL FIRST: a decision with a FREE handle is created normally, so the
    // refusal below cannot be "knowledge_create refuses every explicit slug".
    const free = mkDecision(tools, { title: 'a free handle', slug: 'a-genuinely-free-handle' });
    assert.equal(tools.knowledgeGet('a-genuinely-free-handle').id, free.id, 'control: a free explicit handle is accepted');

    assert.throws(
      () => tools.knowledgeCreate('decision', { title: 'a thief', statement: 's', alternatives_rejected: [], rationale: 'r', slug: taken }),
      (err: Error) => {
        assert.ok(err.message.includes(taken), `names the colliding handle — got: "${err.message}"`);
        assert.match(err.message, COLLISION_REFUSAL, `says the handle is taken — got: "${err.message}"`);
        return true;
      },
      'EXPECTED FAILURE AT HEAD (and the exact defect to watch for after S1 lands): the knowledge-side collision check scans slug-bearing KNOWLEDGE records; if `todo` is not added to that scan, a decision silently steals a board item\'s handle and knowledge_get/board_get disagree about what it means'
    );

    assert.equal(tools.boardGet(taken).id, item.id, 'the board item still owns its handle — one handle resolves to one record');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECTION D — RESOLUTION on the RECOVERABLE surface (board_get, board_update).
// ---------------------------------------------------------------------------

test('D0 CONTROL (passes at HEAD): board_get already resolves a full uuid and an unambiguous 8-char prefix — the existing ladder is intact, so a slug failure below is a missing RUNG, not a broken resolver', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'RESOLVE ME BY EVERY FORGIVING FORM.\n\nbody.', source: 'user' });
    const id = item.id as string;
    assert.equal(tools.boardGet(id).id, id, 'full uuid resolves');
    assert.equal(tools.boardGet(id.slice(0, 8)).id, id, 'an unambiguous 8-char prefix resolves');
  } finally {
    cleanup();
  }
});

test('D1 RESOLUTION: board_get accepts the minted slug exactly as it accepts a uuid, returning the SAME item with its FULL untruncated text', () => {
  const { tools, cleanup } = harness();
  try {
    const text = 'RESOLVE ME BY MY NAME.\n\n' + 'x'.repeat(3000);
    const item = boardAdd(tools, { text, source: 'user' });
    const slug = requireSlug(tools, item, 'the item must mint a handle to be addressed by');

    const got = tools.boardGet(slug);
    assert.equal(got.id, item.id, 'the slug resolves to the same item the uuid does (ladder parity)');
    assert.equal(got.text, text, 'and board_get by slug is still the full-fidelity read — byte for byte, unclipped');
  } finally {
    cleanup();
  }
});

test('D2 RESOLUTION: board_update accepts the minted slug — the write lands on the resolved item, its id stays stable, untouched fields persist, and no second row appears', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'UPDATE ME BY MY NAME.\n\noriginal body.', source: 'user', priority: 'low' });
    const slug = requireSlug(tools, item, 'the item must mint a handle to be updated by');

    const updated = tools.boardUpdate(slug, { text: 'UPDATE ME BY MY NAME.\n\nrevised body.' });
    assert.equal(updated.id, item.id, 'the slug resolved to the SAME item — no re-mint');
    assert.equal(updated.text, 'UPDATE ME BY MY NAME.\n\nrevised body.', 'the write landed');
    assert.equal(updated.priority, 'low', 'untouched fields persist through a slug-addressed update');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'still exactly one item — resolution never mints a second record');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECTION E — THE DESTROYING CALLS REFUSE THE FORGIVING FORM.
//
// This is the section that guards a closed BLOCK-severity anti-pattern
// ([no-bounded-trail-guard-for-destructive-addressing]). board_remove and
// maintenance_remove HARD-DELETE their rows. A slug rung on either of them
// would re-open the exact finding that was retracted the same day it shipped.
// ---------------------------------------------------------------------------

test('E0 CONTROL (must pass for the OPPOSITE reason, and passes at HEAD): board_remove and maintenance_remove BOTH still succeed on the exact full uuid — so the refusals below are address-form-specific, not "the destroying calls refuse everything"', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'REMOVE ME BY MY FULL UUID.\n\nbody.', source: 'user' });
    const removed = tools.boardRemove(item.id as string) as { removed?: string; id?: string };
    assert.equal(removed.removed ?? removed.id, item.id, 'the full uuid removes the board item directly');
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'it is gone');

    const { record: queued } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/e0.ts',
      file_keys: ['src/e0.ts'],
    });
    const drained = tools.maintenanceRemove(queued.id as string) as { removed?: string; id?: string };
    assert.equal(drained.removed ?? drained.id, queued.id, 'the full uuid removes the maintenance item directly');
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 0, 'the queue is empty');
  } finally {
    cleanup();
  }
});

test('E1 THE LOAD-BEARING PIN: board_remove REFUSES a minted slug — naming the full-uuid requirement AND why (hard delete / silent retarget), never the drain-log wording — and BOTH board items survive, verified by query', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'DO NOT DELETE ME BY NAME.\n\nbody.', source: 'user' });
    const decoy = boardAdd(tools, { text: 'AN UNRELATED BYSTANDER ITEM.\n\nbody.', source: 'user' });
    const slug = requireSlug(tools, item, 'the item must mint a handle for the destroying call to refuse');

    assert.throws(
      () => tools.boardRemove(slug),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `the refusal must name the full-uuid requirement — got: "${err.message}"`);
        assert.match(
          err.message,
          HARD_DELETE_REASON,
          `the refusal must name WHY: board rows are hard-deleted and a forgiving address could silently retarget — got: "${err.message}"`
        );
        assert.ok(!/aged out|drain log/i.test(err.message), `must not be the drain-log/aged-out misdiagnosis wording — got: "${err.message}"`);
        return true;
      },
      'EXPECTED FAILURE AT HEAD: requireSlug already failed (no mint). THE FAILURE TO FEAR AFTER S1 LANDS: board_remove gained the slug rung with the resolution ladder, silently removed the item, and assert.throws reports "Missing expected exception" — that is anti-pattern no-bounded-trail-guard-for-destructive-addressing re-opened'
    );

    const remaining = tools.boardQuery({ source: 'user' });
    assert.equal(remaining.length, 2, 'NOTHING WAS DELETED — both items survive, checked by query rather than inferred from the throw');
    assert.deepEqual(
      remaining.map((r) => r.id).sort(),
      [item.id as string, decoy.id as string].sort(),
      'and they are exactly the two originals — nothing was retargeted'
    );
    assert.equal(tools.boardGet(slug).id, item.id, 'the slug still ADDRESSES the item on the recoverable surface — the refusal is scoped to destruction, not to the handle');
  } finally {
    cleanup();
  }
});

test('E2 REGRESSION PIN: board_remove still refuses an unambiguous 8-char prefix — widening the READ surface for slugs must not quietly re-open the prefix rung on the destroying call (decision 6d5a6719)', () => {
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'PREFIXES STAY REFUSED ON DESTRUCTION.\n\nbody.', source: 'user' });
    const prefix = (item.id as string).slice(0, 8);

    assert.throws(
      () => tools.boardRemove(prefix),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `names the full-uuid requirement — got: "${err.message}"`);
        assert.match(err.message, HARD_DELETE_REASON, `names the hard-delete reason — got: "${err.message}"`);
        return true;
      },
      'this arm is GREEN at HEAD and must STAY green — it is the regression detector for an implementer who reuses one shared resolver across the read and destroy surfaces'
    );

    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'the item survives');
    tools.boardRemove(item.id as string);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'and the full uuid still removes it');
  } finally {
    cleanup();
  }
});

test('E3 maintenance_remove keeps demanding the exact full id: a live SLUG address is refused naming the full-uuid requirement, the queue is untouched, and the record that owns the slug is not collaterally destroyed', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: queued } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'no article owns src/e3.ts',
      file_keys: ['src/e3.ts'],
    });
    // A genuinely LIVE slug in the one namespace — the exact forgiving form
    // the ladder resolves on the reading surface.
    const decision = mkDecision(tools, { title: 'a live handle', slug: 'a-live-handle-in-the-namespace' });

    assert.throws(
      () => tools.maintenanceRemove('a-live-handle-in-the-namespace'),
      (err: Error) => {
        assert.match(
          err.message,
          FULL_UUID_REQUIRED,
          `a slug-shaped address on a DESTROYING call must be refused by the exact-id rule, naming it — got: "${err.message}"`
        );
        assert.ok(!/aged out|drain log/i.test(err.message), `never the drain-log misdiagnosis — got: "${err.message}"`);
        return true;
      },
      'EXPECTED FAILURE AT HEAD: today an unknown non-uuid identifier is refused with a plain "no such record" message that does not name the full-uuid requirement'
    );

    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 1, 'the queued item is untouched');
    assert.equal(tools.knowledgeGet('a-live-handle-in-the-namespace').id, decision.id, 'and the slug-owning record was not destroyed either');

    // EITHER-WAY CLAUSE: whether maintenance items mint handles of their own is
    // not settled by the slice. Both outcomes are acceptable; being DELETABLE by
    // one is not.
    const ownSlug = queued.slug;
    if (typeof ownSlug === 'string' && ownSlug.length > 0) {
      assert.throws(
        () => tools.maintenanceRemove(ownSlug),
        FULL_UUID_REQUIRED,
        'if a maintenance item mints its own handle, that handle is still refused by the destroying call'
      );
      assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 1, 'and the item survives its own handle');
    } else {
      assert.equal(ownSlug, undefined, 'maintenance items mint no handle — acceptable: there is nothing forgiving to delete by');
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECTION F — LEGACY ROUND-TRIP, and the BACKFILL-AGNOSTIC property.
// ---------------------------------------------------------------------------

const LEGACY_TEXT = 'A LEGACY ITEM PREDATING THE MINT.\n\nbody prose.';

test('F1 LEGACY (green before AND after — the migration-free pin de1a7329 set): a slugless legacy board row still reads, updates and removes by its full uuid, exactly as it did before the mint existed', () => {
  const { store, tools, cleanup } = harness();
  try {
    const legacyId = seedLegacySluglessItem(store, tools, LEGACY_TEXT);

    const read = tools.boardGet(legacyId);
    assert.equal(read.id, legacyId, 'a slugless legacy row still reads by uuid');
    assert.equal(read.text, LEGACY_TEXT, 'with its full text intact');

    const updated = tools.boardUpdate(legacyId, { priority: 'low' });
    assert.equal(updated.id, legacyId, 'and still updates in place, id stable');
    assert.equal(updated.priority, 'low', 'the update landed');

    tools.boardRemove(legacyId);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'and still removes by its exact full uuid — no migration required');
  } finally {
    cleanup();
  }
});

test('F2 THE LABEL PROPERTY (REVISED 2026-09-21, board 081508d0, [display-name-derives-from-current-text-not-slug]): every board item yields a human-readable display LABEL — a slugless legacy row read through board_get comes back with a non-empty `label` derived from its own CURRENT text, while its real `slug` field stays genuinely absent, never synthesized', () => {
  // SUPERSEDES the pre-fix arm, which required `read.slug` itself to carry a
  // derived kebab handle (EITHER a one-shot backfill mint OR a derive-on-read
  // fallback into `slug`). THAT WAS THE DEFECT'S OWN SHAPE: a value written
  // into the ADDRESSABLE `slug` field, indistinguishable from a real minted
  // handle — see the superseded SECTION G below for the shadowing failure it
  // caused. The fix moves the derived value to its own field, `label`, and
  // leaves `slug` untouched for every item, legacy or not.
  const { store, tools, cleanup } = harness();
  try {
    const legacyId = seedLegacySluglessItem(store, tools, LEGACY_TEXT);
    const read = tools.boardGet(legacyId);

    assert.equal(read.slug, undefined, 'the real `slug` field stays genuinely absent for a legacy row — nothing is ever written into it, so there is nothing left to mistake for a real handle');
    assert.equal(
      read.label,
      'A LEGACY ITEM PREDATING THE MINT.',
      'the label is the item\'s own CURRENT text headline, verbatim prose — not kebab-cased, because a label is a display string, not an address'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECTION G — REVISED 2026-09-21 (board 081508d0): THE SHADOW RISK THIS
// SECTION GUARDED AGAINST IS NOW STRUCTURALLY CLOSED, NOT SUPPRESSED.
//
// THE ORIGINAL DEFECT (found in review, fixed, then found to be COMPLETELY
// UNPINNED — the fixer stripped its own guard line, rebuilt, and ran eleven
// suites: 199/199 stayed green while the defect reproduced): board_get used
// to WRITE a derived value INTO THE `slug` FIELD for a legacy row with no
// stored slug — shaped exactly like a real minted handle. If another item
// later minted that exact handle for real, a reader citing the legacy row's
// displayed `slug` landed on resolveRecordId -> recordsBySlug -> THE WRONG
// RECORD, silently.
//
// THE FIX does not check-then-suppress a shadow; it removes the field the
// shadow lived in. `board_get` never writes to `slug` for ANY item, legacy
// or not — `slug` is returned exactly as stored (possibly absent), full
// stop. The derived name moves to a separate field, `label`, which
// resolveRecordId never reads (it resolves on `id` and `slug` only). There is
// therefore no field left for a live handle to shadow FROM THE LEGACY ROW'S
// SIDE, whether or not some other item's real slug happens to read the same
// words.
//
// G0 restates the label property under load (a store that also holds real
// minted handles) — unaffected by the fix, since `label` was never gated on
// collision. G1/G2 are REPLACED, not deleted (an anti-pattern names deleting
// coverage of surviving behaviour without auditing what still needs pinning —
// [test-deletion-without-coverage-audit]): the NEW arms re-run the exact old
// shadow SETUP and pin the new invariant it must now satisfy — `slug` never
// becomes a fabricated address, regardless of what any other item mints.
// ---------------------------------------------------------------------------

// The headline of the legacy row that gets shadowed, and of the modern item
// that legitimately mints the same handle from the same words.
const SHADOW_HEADLINE = 'EXPORT THE BOARD AS CSV.';
const LEGACY_SHADOW_TEXT = `${SHADOW_HEADLINE}\n\nthe original ask, boarded before the mint existed.`;
const REBOARD_TEXT = `${SHADOW_HEADLINE}\n\nthe same task, re-boarded after the mint existed.`;
const FREE_SIBLING_TEXT = 'A LEGACY SIBLING WHOSE NAME NOBODY TOOK.\n\nbody prose.';

test('G0 CONTROL (placed FIRST — must pass for the OPPOSITE reason): a NON-COLLIDING legacy row STILL displays its label even in a store that already holds real minted handles, and its `slug` stays absent throughout', () => {
  const { store, tools, cleanup } = harness();
  try {
    const modern = boardAdd(tools, { text: 'RENDER THE BOARD IN THE TUI.\n\nbody.', source: 'user' });
    const modernSlug = requireSlug(tools, modern, 'the modern item mints a real handle, so this store is not slug-empty');

    const legacyId = seedLegacySluglessItem(store, tools, FREE_SIBLING_TEXT);
    const read = tools.boardGet(legacyId);

    assert.equal(read.slug, undefined, 'a legacy row\'s `slug` stays genuinely absent — nothing is ever written into it, even in a store that holds other real handles');
    assert.equal(
      read.label,
      'A LEGACY SIBLING WHOSE NAME NOBODY TOOK.',
      'and its LABEL is derived from its own text headline regardless of what else the store holds'
    );
    assert.equal(tools.boardGet(modernSlug).id, modern.id, 'the store\'s real handle still resolves to its real owner — nothing about labelling disturbed it');
  } finally {
    cleanup();
  }
});

test("G1' THE SHADOW SCENARIO, RE-RUN AGAINST THE FIX: a legacy row whose text headline is IDENTICAL to a handle another item later mints for real still reads back with `slug` genuinely ABSENT — never a fabricated value shaped like that live handle", () => {
  const { store, tools, cleanup } = harness();
  try {
    const reboarded = boardAdd(tools, { text: REBOARD_TEXT, source: 'user' });
    const mintedSlug = requireSlug(tools, reboarded, 'the re-boarded item mints a real handle from the same headline the legacy row below will also carry');
    assert.equal(tools.boardGet(mintedSlug).id, reboarded.id, 'SETUP CHECK: the minted handle is live and resolves to the re-boarded item');

    const legacyShadow = seedLegacySluglessItem(store, tools, LEGACY_SHADOW_TEXT);
    const read = tools.boardGet(legacyShadow);

    assert.equal(
      read.slug,
      undefined,
      'THE OLD DEFECT, RE-RUN: this used to come back "export-the-board-as-csv" — a fabricated value shaped exactly like reboarded\'s REAL slug. It must now be genuinely absent, full stop, regardless of what any other item minted'
    );
    assert.equal(
      read.label,
      SHADOW_HEADLINE,
      'the legacy row still displays a LABEL (its own headline) — the fix withholds nothing; it simply never writes that value into the addressable `slug` field'
    );
    assert.equal(tools.boardGet(mintedSlug).id, reboarded.id, 'and the real handle still resolves only to the item that minted it — no ambiguity was ever introduced');
    assert.equal(tools.boardGet(legacyShadow).id, legacyShadow, 'the legacy row itself still reads by its full uuid');
  } finally {
    cleanup();
  }
});

test("G2' BOARD_GET NEVER FABRICATES A SLUG (renamed, review round 2, LOW finding — the structural guarantee this arm actually proves, not the broader address-safety claim its old title implied): after a legacy row has already displayed a label, another item minting that EXACT headline as a real slug elsewhere never causes board_get to write anything into the legacy row's own (still-absent) `slug` field", () => {
  // RENAMED FROM: "A DISPLAYED LABEL IS NEVER TREATED AS AN ADDRESS". That
  // title overclaimed — this arm verifies `slug` stays absent and `label`
  // keeps displaying; it says nothing about whether resolution ever reads
  // `label` (it doesn't: resolveRecordId's rungs are id and slug only, and no
  // code path here feeds a label into it). What this arm DOES prove,
  // precisely: board_get is now a pure read for `slug` — no derive-then-
  // write, no shadow-suppression state machine, regardless of what any other
  // item mints in the meantime.
  const { store, tools, cleanup } = harness();
  try {
    const legacyId = seedLegacySluglessItem(store, tools, LEGACY_SHADOW_TEXT);
    const before = tools.boardGet(legacyId);
    assert.equal(before.label, SHADOW_HEADLINE, 'PREMISE: the legacy row displays its own headline as a label');
    assert.equal(before.slug, undefined, 'PREMISE: and its slug is genuinely absent');

    // A new item auto-mints the exact same headline as a real slug — the
    // everyday version of the old shadow scenario, no contrived explicit slug
    // required.
    const claimant = boardAdd(tools, { text: REBOARD_TEXT, source: 'user' });
    const claimantSlug = requireSlug(tools, claimant, 'the claimant mints its own real handle from the shared headline');

    const after = tools.boardGet(legacyId);
    assert.equal(after.slug, undefined, 'the legacy row\'s slug is UNCHANGED by another item minting a handle elsewhere — there is no derive-then-suppress step left to get this wrong');
    assert.equal(after.label, SHADOW_HEADLINE, 'and it still displays its own label — board_get never withholds one, because it never derives-then-writes an address in the first place');
    assert.equal(tools.boardGet(claimantSlug).id, claimant.id, 'the claimant\'s real handle resolves only to the claimant');
    assert.equal(tools.boardGet(legacyId).id, legacyId, 'the legacy row survives throughout, addressed by its uuid exactly as before');
  } finally {
    cleanup();
  }
});
