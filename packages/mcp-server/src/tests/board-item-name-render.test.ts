// ---------------------------------------------------------------------------
// S2 of the human-readable-ids objective — TOOL-SURFACE HALF (board_query's
// `headline` and `digest` projections, the two surfaces the ruling names).
// Ruling [human-readable-ids-for-board-items] (knowledge_get 2e8c30e4);
// AC23 of [mcp-tool-surface] (knowledge_get 7e24629b) for the handle contract.
//
// WRITTEN SPEC-ONLY AND BLIND to records.ts / tools.ts / index.ts. Every
// assertion is derived from those two records and the slice brief.
//
// CORRECTED 2026-08-29 — THE ARMS WERE AIMED ONE LAYER TOO LOW, AND THE SEAM
// MOVED. `SterlingTools.boardQuery()` is `boardFiltered(...).slice(...)`: it
// NEVER READS `projection`, so every arm below was silently asserting against a
// FULL RECORD. A full record already carries `slug`, which made H1 and J1 GREEN
// AT HEAD while pinning nothing, and made H3/H5 say nothing whatever about
// headlineRecord(). `boardQueryResult()` is the method that applies a
// projection, and it is what the MCP tool surface calls. EVERY ARM IN THIS FILE
// NOW GOES THROUGH `boardQueryResult`. DO NOT RE-AIM THEM BACK: an arm pointed
// at `boardQuery` cannot observe a projection at all, and it fails GREEN.
//
// THE RULING, quoted with the justification clause that makes it binding:
//   "Every human-facing surface prints `name (id8)` — name first, id retained:
//    board_query digest and headline projections, the H1 SessionStart banner,
//    TUI board rows, dispatch briefs and session reports. Names clip, ids never
//    do, BECAUSE A TRUNCATED ID IS UNRESOLVABLE WHILE A TRUNCATED NAME IS STILL
//    RECOGNISABLE."
//
// THE MEASURED GAP: headlineRecord() builds {id, priority, objective?,
// system_reason?, text} — no name at all. A headline board read is therefore
// still bare hex plus prose, which is the literal thing the user could not
// identify ("board 17204d1e ... no way of knowing what that refers to").
//
// THE HEADLINE FULL-ID QUESTION, DECIDED AND PINNED HERE (the brief asked for
// an explicit reading): THE HEADLINE KEEPS ITS FULL `id` FIELD **AND** GAINS
// THE DISPLAY FORM. A headline that shows only `name (id8)` and drops the full
// uuid is WRONG, and H3 pins it wrong — not on aesthetics, but because
// board_remove and maintenance_remove REFUSE every address form except the
// exact full uuid (AC23, anti-pattern no-bounded-trail-guard-for-destructive-
// addressing, severity BLOCK). A headline listing that carried only an 8-char
// id would leave every item in it UNDELETABLE from what the reader was shown.
// The id8 inside the parentheses is a DISPLAY abbreviation for a human eye; the
// `id` field is the machine address, and they are not the same thing.
//
// EXPECTED STATE: the S2 implementation has LANDED and was verified through
// this seam, so EVERY arm in this file is GREEN. From here they are REGRESSION
// pins, and each one names the single-line sabotage that must turn it red.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SterlingStore } from '@sterling/store';
import { SterlingTools, type BoardGetResult } from '../tools.js';

const NOW = '2026-08-29T12:00:00.000Z';

type Loose = Record<string, unknown>;

// A structurally-typed view of the tool surface, exactly as the S1 sibling pin
// board-item-slug-mint.test.ts declares it, so every failure below is a
// behavioural assertion rather than a TS2339/TS2353 compile crash (a crash-red
// proves nothing).
interface ToolsView {
  boardAdd(fields: Loose): { record: Loose };
  boardGet(id: string): Loose;
  boardUpdate(id: string, patch: Loose): Loose;
  boardRemove(id: string): Loose;
  /** THE PROJECTION-APPLYING READ — the one the MCP tool surface calls, and the
   *  only board read that honours `projection`. Same shape the frozen
   *  read-surface-wave.test.ts arms use: {matched_filter, returned, records}. */
  boardQueryResult(filter: Loose): { records: Loose[]; matched_filter: number; returned: number };
  maintenanceEnqueue(fields: Loose): { record: Loose };
  maintenanceQuery(filter: Loose): Loose[];
  /** THE PROJECTION-APPLYING READ for the queue side, same seam as
   *  boardQueryResult — maintenanceQuery ignores `projection` entirely
   *  (it forwards to the non-enveloping boardQuery), so K2/K3 below must
   *  route through this one or they measure the wrong seam (board 081508d0
   *  review round 2: the ORIGINAL K2 did exactly that and passed for the
   *  wrong reason — a full record trivially has no `name` key either). */
  maintenanceQueryResult(filter: Loose): { records: Loose[]; matched_filter: number; returned: number };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-board-item-name-render-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const real = new SterlingTools({ store, now: () => NOW });
  const tools = real as unknown as ToolsView;
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  // `real` is kept CONCRETELY typed (not narrowed through ToolsView's `Loose`
  // escape hatch) so a test can read board_get's `.label` through its actual
  // declared type, BoardGetResult (board 081508d0, review round 2, MEDIUM
  // finding) — see K1 below.
  return { store, tools, real, cleanup };
}

function boardAdd(tools: ToolsView, fields: Loose): Loose {
  return tools.boardAdd(fields).record;
}

// ---------------------------------------------------------------------------
// THE PINNED CLIP CONTRACT — stated here once, in full, as the slice's spec.
//
//   NAME_CLIP = 48 characters, ELLIPSIS INCLUDED.
//   clipName(n) = n.length <= 48 ? n : n.slice(0, 47) + '…'
//   displayForm(name, id) = `${clipName(name)} (${id.slice(0, 8)})`
//
// DERIVATION, so this is a reading of the ruling rather than a number picked
// from the air: the mint already clamps a slug at 60 characters (decision
// de1a7329, and frozen in S1's A2/A3 arms). The composed display form is
// `name (id8)`, whose id half costs exactly 11 characters — one space, two
// parentheses and eight hex. Reserving those 11 out of the SAME 60-character
// budget the mint already uses leaves 49, ROUNDED DOWN TO 48 so the constant
// stays stable if the id form ever gains a character and so the composed handle
// lands at 59 — inside the one length constant this codebase already has. What
// the reservation protects is precisely the part the ruling says must never
// clip. A 60-character minted slug therefore renders as 47 characters plus an
// ellipsis, and the id8 is untouched.
//
// WHERE IT APPLIES: the composed display form — the headline projection here,
// and TUI card titles in the sibling pin board-item-name-cards.test.ts.
// WHERE IT DOES NOT: the `slug` FIELD in the digest projection, which stays
// verbatim (board-item-name-digest.test.ts S2-D3) because a clipped address
// does not resolve.
// ---------------------------------------------------------------------------
const NAME_CLIP = 48;
const ELLIPSIS = '…';
const clipName = (n: string): string => (n.length <= NAME_CLIP ? n : n.slice(0, NAME_CLIP - 1) + ELLIPSIS);
const id8 = (id: string): string => id.slice(0, 8);
const displayForm = (name: string, id: string): string => `${clipName(name)} (${id8(id)})`;

/** Exactly 48 characters — sits ON the clip boundary and must NOT be clipped. */
const SLUG_48 = 'board-items-render-their-readable-name-beside-id';
/** Exactly 49 characters — one past the boundary, must clip to 47 + ellipsis. */
const SLUG_49 = 'board-items-render-their-readable-name-beside-ids';

/** Every string value in a projected record, so the pins can assert that SOME
 *  field carries the display form without inventing a field NAME the brief's
 *  interface slice never declared. */
const stringValues = (obj: Loose): string[] => Object.values(obj).filter((v): v is string => typeof v === 'string');
const carries = (obj: Loose, needle: string): boolean => stringValues(obj).some((v) => v.includes(needle));

function headlineOf(tools: ToolsView, filter: Loose = { source: 'user' }): Loose {
  const rows = tools.boardQueryResult({ ...filter, projection: 'headline' }).records;
  assert.equal(rows.length, 1, 'setup: exactly one item matches this headline query');
  return rows[0];
}

/** An unprojected board read — the full records. Stated WITHOUT a `projection`
 *  key, which is the idiom the frozen read-surface-wave.test.ts arms already use
 *  for the full baseline, so this helper cannot depend on whether 'full' is a
 *  spelled projection value. */
function fullRecords(tools: ToolsView, filter: Loose = { source: 'user' }): Loose[] {
  return tools.boardQueryResult({ ...filter }).records;
}

// A slugless LEGACY board row: an item that predates the mint. Cloned from a
// real item with the slug stripped and the id re-minted — the same raw-row
// convention the S1 sibling pin and the id-resolution suites use, since
// server-owned fields cannot be forced through the public tool.
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
// SECTION H — THE HEADLINE PROJECTION.
// ---------------------------------------------------------------------------

test('H0 CONTROL (placed FIRST, must pass for the OPPOSITE reason, and passes at HEAD): projection:"headline" is genuinely HONOURED at this seam — it returns a STRICTLY SMALLER object than projection:"full" for the SAME item, with the same full id; so a missing name below is a missing NAME, not a projection that never ran', () => {
  // SABOTAGE that must turn this arm RED: in packages/mcp-server/src/tools.ts
  // make boardQueryResult ignore its `projection` argument and always return the
  // full record.
  //
  // WHY THIS ARM EXISTS AND WHY IT IS FIRST: every verdict in this section has
  // more than one possible cause. "The headline carries no name" is equally
  // well explained by "the headline projection is not applied at THIS seam at
  // all, so these arms are aimed at the wrong layer" — and that reads exactly
  // like the defect. This arm must pass for the opposite reason: the projection
  // demonstrably RAN and demonstrably dropped fields.
  //
  // AND IT IS NOT HYPOTHETICAL — IT IS THE DEFECT THAT WAS MEASURED. This file
  // originally called `boardQuery`, which ignores `projection` outright, so the
  // arms below were reading full records and H1/J1 passed while pinning nothing.
  // This control is the arm that would have caught it, and it is the reason
  // every read in this file now goes through `boardQueryResult`.
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'EXPORT THE BOARD AS CSV.\n\nbody prose.', source: 'user', priority: 'high' });

    const full = fullRecords(tools);
    const headline = tools.boardQueryResult({ source: 'user', projection: 'headline' }).records;
    assert.equal(full.length, 1, 'one item, read whole');
    assert.equal(headline.length, 1, 'the same one item, read as a headline');
    assert.equal(full[0].id, item.id, 'the full read names the item');
    assert.equal(headline[0].id, item.id, 'and so does the headline — SAME item, two projections');
    assert.ok(
      Object.keys(headline[0]).length < Object.keys(full[0]).length,
      `the headline is STRICTLY smaller than the full record — that is what makes it a projection. headline keys=${JSON.stringify(Object.keys(headline[0]))} full keys=${JSON.stringify(Object.keys(full[0]))}`
    );
  } finally {
    cleanup();
  }
});

test('H1 THE NAME REACHES THE HEADLINE UNDER A STABLE KEY: the composed handle arrives on the headline\'s `name` field — the key every downstream renderer (H1 banner, TUI, dispatch briefs) reads', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // rename headlineRecord()'s `name` key to anything else (`display_name`,
  // `handle`, …). Deleting the line entirely also reddens it.
  //
  // WHICH GUARD CARRIES WHICH VERDICT — said explicitly, because H1 and H2 look
  // alike and are not. H2 is FIELD-AGNOSTIC: it scans every string value for the
  // composed form, so it survives a key rename and would leave every consumer of
  // the projection broken while staying green. H1 is the KEY pin and is the ONLY
  // arm here that catches that. The reverse also holds: under H2's sabotage
  // (drop the id half) H1 stays green, because the key is still there carrying
  // the name. Two sabotages, two arms, neither redundant.
  //
  // RE-AIMED 2026-08-29. As originally written this arm read `boardQuery`, which
  // returns a FULL RECORD; a full record already carries `slug`, so the old
  // assertion (`some string field mentions the name`) was GREEN AT HEAD before
  // headlineRecord composed anything at all. It pinned nothing. The key
  // assertion below is the smallest thing that could not be satisfied that way.
  //
  // CHANGED 2026-09-21 (board 081508d0, [display-name-derives-from-current-
  // text-not-slug]): the assertion used to require `h.name` to contain
  // `item.slug` ('export-the-board-as-csv'). THAT ENCODED THE DEFECT ITSELF —
  // a slug is minted once and never re-derived (updateTodo), so a name sourced
  // from it goes stale the moment the item's text is renamed or renumbered
  // ("Slice 7" still reading "slice-6-..."). The `name` key is unchanged and
  // still pinned by H1; only WHAT populates it moves, from the immutable slug
  // to the item's CURRENT text headline (boardDisplayLabel). The slug itself
  // is still minted (PREMISE below is unchanged) — it just no longer feeds
  // display.
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'EXPORT THE BOARD AS CSV.\n\nbody prose.', source: 'user', priority: 'high' });
    const slug = item.slug;
    assert.ok(
      typeof slug === 'string' && slug.length > 0,
      'PREMISE (S1, already shipped): board_add mints a handle. If THIS fails, S1 regressed and every arm in this file is measuring the wrong thing'
    );
    const label = 'EXPORT THE BOARD AS CSV.';

    const h = headlineOf(tools);
    assert.equal(
      typeof h.name,
      'string',
      `the headline exposes the composed handle under the key \`name\` — a headline board listing is read by machines that key off it, not only by eyes scanning a blob. Got: ${JSON.stringify(h)}`
    );
    assert.ok(
      (h.name as string).includes(label),
      `and that field carries THIS item's CURRENT TEXT headline "${label}" — never the slug, which is an immutable address (board 081508d0) — got "${String(h.name)}"`
    );
  } finally {
    cleanup();
  }
});

test('H2 THE COMPOSED FORM: the headline carries the literal `name (id8)` string — name FIRST, id in parentheses after it; not the name alone and not the id alone', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // change the composed display string in headlineRecord() from
  // `${name} (${id.slice(0,8)})` to `${name}` (drop the id half).
  //
  // WHICH GUARD CARRIES THE VERDICT: this arm, and it is deliberately distinct
  // from H1. H1 pins the KEY and is satisfied by a `name` field carrying the
  // bare handle with no id beside it. The ruling is a COMPOSED form — one string
  // a person reads as a unit, name first — and H2 is the only arm that can tell
  // the two apart. It is deliberately field-AGNOSTIC (it scans every string
  // value) so that the composition verdict and the key verdict fail separately.
  //
  // CHANGED 2026-09-21 (board 081508d0): `name` used to be `item.slug`; it is
  // now the item's CURRENT TEXT headline (boardDisplayLabel) — see H1's note
  // for why the old slug-sourced expectation encoded the defect. The slug is
  // still minted (kept below only as the PREMISE that S1 is intact); it is no
  // longer the string composed into the display form.
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'RENDER THE BOARD IN THE TUI.\n\nbody prose.', source: 'user' });
    assert.ok(typeof item.slug === 'string' && (item.slug as string).length > 0, 'PREMISE: S1 minted a handle');
    const name = 'RENDER THE BOARD IN THE TUI.';

    const expected = displayForm(name, item.id as string);
    const h = headlineOf(tools);
    assert.ok(
      carries(h, expected),
      `no field of the headline contains "${expected}". THE FAILURE THIS ARM EXISTS TO CATCH: an implementation that emits the name and the id as two separate fields and never composes them — the ruling is one handle a person reads as a unit, name first. Got: ${JSON.stringify(h)}`
    );
    // Name FIRST is load-bearing: the rejected alternative "drop the id and
    // show only the name" was rejected because the id keeps the reference
    // ACTIONABLE, and the accepted shape puts the recognisable half first.
    const carrier = stringValues(h).find((v) => v.includes(expected))!;
    assert.ok(
      carrier.indexOf(name) < carrier.indexOf(`(${id8(item.id as string)})`),
      `the NAME comes before the id in the composed handle — "${carrier}"`
    );
  } finally {
    cleanup();
  }
});

test('H3 IDS NEVER CLIP — THE REGRESSION PIN: the headline keeps its FULL uuid `id` field alongside the display form, and that id is still a working address for the DESTROYING call, which refuses every other form (AC23)', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // change headlineRecord()'s `id` field to `rec.id.slice(0, 8)` (i.e. let the
  // display abbreviation replace the machine address).
  //
  // RE-AIMED 2026-08-29, AND ONLY NOW DOES IT MEAN ANYTHING. As written it read
  // `boardQuery`, which ignores `projection` and hands back the full record —
  // so it asserted that a FULL RECORD keeps its full id, which nobody doubted,
  // and said nothing whatever about headlineRecord(). Pointed at
  // `boardQueryResult`, it pins the projection.
  //
  // GREEN AND MUST STAY GREEN. This is the arm that answers the brief's
  // headline full-id question, and it answers it with a CONSEQUENCE rather than
  // a preference: board_remove and maintenance_remove demand the exact full
  // uuid and refuse an 8-char prefix (S1 arm E2, decision foreign_6d5a6719, anti-pattern
  // no-bounded-trail-guard-for-destructive-addressing at severity BLOCK). If a
  // headline listing carried only id8, every item a reader could SEE would be
  // one they could not remove. So: the display form ADDS, it never REPLACES.
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'KEEP THE FULL ID ON THE HEADLINE.\n\nbody prose.', source: 'user' });
    const h = headlineOf(tools);

    assert.equal(typeof h.id, 'string', 'the headline still carries an id field');
    assert.equal((h.id as string).length, 36, `the headline id is the FULL uuid, never the 8-char display form — got "${String(h.id)}" (${String(h.id).length} chars)`);
    assert.equal(h.id, item.id, 'and it is this item\'s id, byte for byte');

    // The consequence, exercised rather than asserted about: the id a reader
    // takes off a headline listing must satisfy the destroying call's exact-id
    // rule. An 8-char form is refused, which is exactly why the full one must
    // survive the projection.
    assert.throws(
      () => tools.boardRemove(id8(h.id as string)),
      'precondition (S1 E2): the destroying call refuses the 8-char form — so a headline that only showed id8 would be undeletable'
    );
    tools.boardRemove(h.id as string);
    assert.equal(fullRecords(tools).length, 0, 'the full id read off the headline IS a working address — the reference the reader was shown stays actionable');
  } finally {
    cleanup();
  }
});

test('H4 CLIPPING, BOTH SIDES OF THE BOUNDARY: a 48-character name renders WHOLE; a 49-character name clips to 47 chars + "…"; and in BOTH cases the id8 is intact and the composed handle fits the 60-character budget', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // remove the clip from the composed display string (render the whole name).
  //
  // WHICH ARM CARRIES WHICH VERDICT — stated because a single-arm pin here
  // would be hollow in both directions:
  //   * the 48-char arm alone is satisfied by an implementation that clips
  //     NOTHING, ever;
  //   * the 49-char arm alone is satisfied by an implementation that clips
  //     EVERY name aggressively (say at 20), which would destroy the
  //     recognisability the ruling clips names to preserve.
  // Only the PAIR pins the boundary, and the id8 assertion under the clipped
  // arm is what pins "names clip, ids never do" as one statement rather than
  // two independent ones.
  //
  // RE-AIMED 2026-08-29, AND SCOPED TO THE `name` FIELD ON PURPOSE. Two changes:
  // the read is now `boardQueryResult` (the old `boardQuery` never applied a
  // projection, so this arm could not have gone green from records.ts at all);
  // and every clip assertion names `h.name` instead of scanning the whole
  // record. The headline's `text` field is ITSELF clipped (~80 chars) and ends
  // in an ellipsis whenever the body is long — a whole-record "contains no
  // ellipsis" check is a false positive waiting for its first long fixture.
  //
  // CHANGED 2026-09-21 (board 081508d0): the clip boundary is now exercised on
  // the item's TEXT headline, not its slug — `name` no longer reads the slug
  // at all (see H1's note). SLUG_48/SLUG_49 are reused here only as literal
  // 48/49-character STRINGS (their content, not their slug-ness, is what this
  // arm needs); each item also carries an explicit, unrelated `slug` purely to
  // satisfy headlineRecord's has-a-slug gate for whether `name` is composed at
  // all — the boundary itself is measured on the TEXT.
  const { tools, cleanup } = harness();
  try {
    assert.equal(SLUG_48.length, 48, 'premise: this fixture string sits exactly ON the clip boundary');
    assert.equal(SLUG_49.length, 49, 'premise: this fixture string sits exactly one character past it');

    // --- boundary, unclipped -------------------------------------------------
    const onBoundary = boardAdd(tools, { text: `${SLUG_48}\n\nbody.`, source: 'user', slug: 'h4-on-boundary' });
    assert.equal(onBoundary.slug, 'h4-on-boundary', 'PREMISE (S1 C0): an explicit non-colliding handle is accepted verbatim — unrelated to the text fixture below');
    const hOn = headlineOf(tools);
    const expectedOn = `${SLUG_48} (${id8(onBoundary.id as string)})`;
    assert.equal(
      hOn.name,
      expectedOn,
      `a TEXT headline of exactly ${NAME_CLIP} characters is rendered WHOLE — no ellipsis, nothing dropped. Expected "${expectedOn}", got ${JSON.stringify(hOn)}`
    );
    assert.ok(!String(hOn.name).includes(ELLIPSIS), 'a name at the boundary carries no ellipsis — clipping starts PAST the budget, not at it');
    assert.equal(expectedOn.length, 59, 'self-check on the stated derivation: 48 name chars + 11 for " (id8)" = 59');
    assert.ok(expectedOn.length <= 60, 'and the whole handle fits inside the 60-character budget the mint already uses');
    tools.boardRemove(onBoundary.id as string);

    // --- one past the boundary, clipped -------------------------------------
    const overBoundary = boardAdd(tools, { text: `${SLUG_49}\n\nbody.`, source: 'user', slug: 'h4-over-boundary' });
    assert.equal(overBoundary.slug, 'h4-over-boundary', 'PREMISE: the slug is an unrelated, untouched address — clipping is a TEXT-display act, never a storage one');
    const overId = overBoundary.id as string;
    const hOver = headlineOf(tools);
    const expectedOver = `${SLUG_49.slice(0, 47)}${ELLIPSIS} (${id8(overId)})`;
    assert.equal(expectedOver, displayForm(SLUG_49, overId), 'self-check: the expectation and the stated contract agree');

    assert.equal(
      hOver.name,
      expectedOver,
      `expected "${expectedOver}" — 47 name characters, an ellipsis, then the UNTOUCHED id8. Got ${JSON.stringify(hOver)}`
    );
    assert.ok(!String(hOver.name).includes(SLUG_49), 'the over-long name does NOT render in full — it clips, which is the half of the ruling that is allowed to lose information');
    assert.ok(
      String(hOver.name).endsWith(`(${id8(overId)})`),
      'AND THE ID IS INTACT AFTER THE CLIP — this is the load-bearing half: "a truncated id is unresolvable while a truncated name is still recognisable"'
    );
    assert.ok(String(hOver.name).startsWith(SLUG_49.slice(0, 20)), 'the clip keeps the LEADING characters, so the clipped name stays recognisable — a tail-clip would not');
    assert.equal(expectedOver.length, 59, 'the clipped handle lands on the same 59 characters as the unclipped boundary case — the clip is what makes the budget hold');

    // The STORED handle (the item's real slug, unrelated to the clipped text
    // fixture) is untouched by any of this, and still resolves.
    assert.equal(tools.boardGet('h4-over-boundary').id, overId, 'the stored slug is still a real address — display clipping of the TEXT-derived name never touches it');
  } finally {
    cleanup();
  }
});

test('H5 (REVISED, review round 2, board 081508d0) LEGACY ROW WITH REAL TEXT: a SLUG-LESS board item STILL gets a headline `name` — derived from its own CURRENT text, unconditionally; the id half is still intact beside it', () => {
  // SUPERSEDES the original H5, which required NO `name` key for ANY slugless
  // item. THAT WAS ITSELF THE HIGH-SEVERITY GAP a cross-family review caught:
  // gating composition on slug presence left every legacy pre-mint row — and,
  // worse, EVERY maintenance-queue item, which never mints a slug at all (S1
  // design call) — permanently nameless even though its text was perfectly
  // nameable. `id8` is a uuid-prefix address, valid regardless of whether a
  // slug was ever minted (it is not derived from the slug at all), so gating
  // composition on slug presence bought nothing but a needless omission.
  //
  // WHAT SURVIVES FROM THE OLD H5, now split into H5b below: the ONE case
  // that still gets no `name` at all is a record with NEITHER a slug NOR any
  // non-blank text line — and even then, never a fabricated "undefined/null/
  // id8 (id8)" costume (df361a0f). That is a narrower, still-real guarantee,
  // not the same one this arm used to make.
  //
  // SABOTAGE that must turn this test RED: reintroduce a `record.slug ? ... :
  // ''` gate ahead of the todo branch in headlineRecord (packages/schemas/src/
  // records.ts).
  const { store, tools, cleanup } = harness();
  try {
    const legacyId = seedLegacySluglessItem(store, tools, 'A LEGACY ITEM PREDATING THE MINT.\n\nbody prose.');
    const h = headlineOf(tools);

    assert.equal(h.id, legacyId, 'the legacy item is the one being projected');
    assert.equal((h.id as string).length, 36, 'and its FULL id survives, unclipped, beside the name');
    assert.equal(
      h.name,
      `A LEGACY ITEM PREDATING THE MINT. (${id8(legacyId)})`,
      `THE FIX: a slug-less item with real text still composes a name, derived from that text — got ${JSON.stringify(h)}`
    );
  } finally {
    cleanup();
  }
});

test('H5b (NEW, review round 2): the ONE remaining case with NO `name` at all — NEITHER a slug NOR any non-blank text line — and even then never a fabricated "undefined (id8)" / "null (id8)" / "id8 (id8)" costume (df361a0f)', () => {
  // WHICH GUARD CARRIES WHICH VERDICT — two layers, deliberately, because they
  // fail apart. The `!('name' in h)` assertion carries "the key is OMITTED,
  // not filled with a placeholder". The blob assertions below carry something
  // it cannot see: a fabricated hex-costume name emitted under some OTHER
  // key. Neither implies the other.
  const { store, tools, cleanup } = harness();
  try {
    const legacyId = seedLegacySluglessItem(store, tools, '   \n\t\n   ');
    const h = headlineOf(tools);

    assert.equal(h.id, legacyId, 'the item is the one being projected');
    assert.equal((h.id as string).length, 36, 'and its FULL id survives — a nameless item needs its id MORE than a named one does, not less');

    assert.ok(
      !('name' in h),
      `with neither a slug nor any non-blank text, the headline composes NO name key at all — not an empty string, not a placeholder, not the id in a costume. Got ${JSON.stringify(h)}`
    );

    const blob = JSON.stringify(h);
    assert.ok(!blob.includes(`undefined (${id8(legacyId)})`), `a missing name must never compose into "undefined (id8)" — got ${blob}`);
    assert.ok(!blob.includes(`null (${id8(legacyId)})`), `nor into "null (id8)" — got ${blob}`);
    assert.ok(!blob.includes(`${id8(legacyId)} (${id8(legacyId)})`), `nor into "id8 (id8)" — the id is not a name, and printing it twice does not make one — got ${blob}`);

    // AND NO OTHER FIELD SMUGGLES ONE IN. `name` being absent does not by itself
    // rule out a composed `something (id8)` string appearing under a different
    // key — this is the second layer, and it is the one that catches that.
    assert.ok(
      !stringValues(h).some((v) => v.includes(`(${id8(legacyId)})`)),
      `no field of a nameless item's headline composes a "<something> (id8)" display string — composing one would hand the reader a citable-looking handle that is really the id in a costume. Got ${blob}`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECTION J — THE DIGEST PROJECTION, END TO END THROUGH THE TOOL.
// The schemas-layer field-map pin lives in the sibling
// packages/schemas/src/tests/board-item-name-digest.test.ts; this arm proves the
// contract survives the whole way out to the surface a reader actually calls.
// ---------------------------------------------------------------------------

test('J0 CONTROL (must pass for the OPPOSITE reason, and passes at HEAD): projection:"digest" is honoured at this seam too — smaller than full, same full id — so a missing name below is a missing FIELD, not a projection that never ran', () => {
  // SABOTAGE that must turn this arm RED: in packages/mcp-server/src/tools.ts
  // make boardQueryResult ignore projection:'digest' and return the full record.
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'DIGEST ME.\n\n' + 'x'.repeat(4000), source: 'user', priority: 'high' });
    const full = fullRecords(tools)[0];
    const digest = tools.boardQueryResult({ source: 'user', projection: 'digest' }).records[0];
    assert.equal(digest.id, item.id, 'the digest names the item by its full id');
    assert.equal((digest.id as string).length, 36, 'and that id is the full uuid');
    assert.ok(
      String(digest.text).length < String(full.text).length,
      'the digest genuinely CLIPPED the long body — proof the projection ran'
    );
  } finally {
    cleanup();
  }
});

test('J1 THE DIGEST CARRIES THE NAME: board_query projection:"digest" returns the item\'s minted handle VERBATIM beside its full id — a digest board read shows a person what the item IS without a full-body read', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // remove `slug` from the `todo` entry of the RECORD_TYPES digest field map.
  //
  // RE-AIMED 2026-08-29 — THIS ARM WAS GREEN AT HEAD AND PINNED NOTHING. It read
  // `boardQuery`, which ignores `projection` and returns the FULL record, and a
  // full record has carried `slug` since S1. It would have survived its own named
  // sabotage untouched. Through `boardQueryResult` it now reads the projection it
  // claims to be about.
  //
  // WHICH GUARD CARRIES WHICH VERDICT: the schemas-layer siblings D1 (the field
  // map) and D2 (digestRecord's output) already pin this one layer down. THIS arm
  // is the only one that proves the tool surface a caller actually reaches APPLIES
  // that projection — a digestRecord that is perfect and never called reddens
  // nothing in D1/D2 and reddens this.
  const { tools, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'EXPORT THE BOARD AS CSV.\n\n' + 'x'.repeat(4000), source: 'user', priority: 'high' });
    const name = item.slug as string;
    assert.ok(typeof name === 'string' && name.length > 0, 'PREMISE: S1 minted a handle');

    const digest = tools.boardQueryResult({ source: 'user', projection: 'digest' }).records[0];
    assert.equal(
      digest.slug,
      name,
      `the digest carries the minted handle VERBATIM — expected "${name}". A digest board read is the triage read; without the handle it shows a person bare hex plus prose. Got ${JSON.stringify(digest)}`
    );
    assert.equal(digest.id, item.id, 'AND the full id is retained beside it — name first, id kept');
    assert.ok(!String(digest.slug).includes(ELLIPSIS), 'the digest handle is the ADDRESS and is never clipped — clipping belongs to the composed display form only (H4)');
    assert.equal(tools.boardGet(digest.slug as string).id, item.id, 'the name a digest read hands back is a working address — that is the whole point of minting it');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SECTION K — THE MEASURED REGRESSION (board 081508d0): a renumbered/renamed
// item must never keep displaying the headline it was minted under.
// ---------------------------------------------------------------------------

test('K1 THE SLICE 6/7 REGRESSION, END TO END: board_add mints a slug from the ORIGINAL headline; board_update rewrites `text` to a NEW headline WITHOUT touching `slug` (updateTodo never re-mints); the headline projection now shows the NEW text, the slug stays the OLD one, and the OLD slug still resolves the item', () => {
  // SABOTAGE that must turn this test RED: revert headlineRecord (or
  // boardItemName) to read `record.slug` instead of the CURRENT `text` —
  // the exact defect board 081508d0 measured live: an item whose text opened
  // "Slice 7 — ..." still displayed as "slice-6-..." because the slug
  // predated the renumbering.
  const { tools, real, cleanup } = harness();
  try {
    const item = boardAdd(tools, { text: 'Slice 6 — foo.\n\nbody prose.', source: 'user', priority: 'high' });
    const slug = item.slug as string;
    assert.ok(typeof slug === 'string' && slug.startsWith('slice-6'), `PREMISE: the mint reads the ORIGINAL headline — got "${String(slug)}"`);

    const updated = tools.boardUpdate(item.id as string, { text: 'Slice 7 — foo.\n\nbody prose.' });
    assert.equal(updated.slug, slug, 'the slug is NEVER re-minted by board_update — updateTodo\'s own contract; it stays the stale "slice-6-..." address');

    const headline = tools.boardQueryResult({ source: 'user', projection: 'headline' }).records[0];
    assert.ok(
      typeof headline.name === 'string' && (headline.name as string).startsWith('Slice 7'),
      `THE FIX: the headline's name reads the item's CURRENT text, not its stale slug — expected a name starting "Slice 7", got "${String(headline.name)}"`
    );
    assert.ok(!(headline.name as string).toLowerCase().startsWith('slice-6'), 'and it no longer opens with the old, now-wrong slug-derived form');

    // The slug is still the OLD one, and it still resolves the item — an
    // ADDRESS, unlike the label, is never re-derived (out of scope: minting,
    // BOARD_UPDATABLE_FIELDS, resolveRecordId, aliases).
    assert.equal(tools.boardGet(slug).id, item.id, 'the OLD slug still resolves the item — it is an immutable address, never re-derived');
    const got = tools.boardGet(slug);
    assert.equal(got.slug, slug, 'board_get returns the real, unchanged slug');
    assert.equal(got.label, 'Slice 7 — foo.', 'and an explicit `label` field carrying the CURRENT text headline, beside it');

    // THE SAME READ, THROUGH board_get's ACTUAL DECLARED TYPE (review round 2,
    // MEDIUM finding) — `real` is the concretely-typed SterlingTools instance,
    // not narrowed through the ToolsView `Loose` escape hatch every other
    // assertion in this file uses. `typed.label` below is a compile-time
    // property access on `BoardGetResult`, not a stringly-typed lookup on an
    // object typed `Record<string, unknown>` — if boardGet's return type ever
    // regresses to a bare `DurableRecord`, THIS line fails to compile.
    const typed: BoardGetResult = real.boardGet(slug);
    assert.equal(typed.type, 'todo', 'board_get only ever resolves board/queue items — narrows the union for the two field reads below');
    if (typed.type === 'todo') {
      assert.equal(typed.label, 'Slice 7 — foo.', 'the declared type exposes `label` directly — no Loose cast required to read it');
      assert.equal(typed.slug, slug, 'and `slug` is still readable as the record field it always was');
    }
  } finally {
    cleanup();
  }
});

test('K2 (REVISED, review round 2, board 081508d0): maintenance_query SHARES THE SAME RENDERER, and a SLUG-LESS system item STILL gets a headline `name` — derived from its own text, UNCONDITIONALLY, because maintenance items never mint a slug at all (S1 design call) and "slug-less" is not a reason to omit the label', () => {
  // SUPERSEDES the original K2, which asserted the OPPOSITE — `!('name' in
  // headline)` — reasoning that headlineRecord's slug-GATE (no slug -> no
  // name) applied identically on both surfaces. That gate was itself a
  // remnant of the old slug-sourced design: maintenance items structurally
  // NEVER mint a slug (tools.ts mintHeadlineOf, S1), so under the old gate
  // every ordinary maintenance_query headline row was permanently nameless —
  // exactly the omission a cross-family review caught. The fix removes the
  // slug-gate for `todo` records: the label is derived from CURRENT TEXT
  // unconditionally, and rendered whenever it is non-empty.
  //
  // SABOTAGE that must turn this test RED: reintroduce a `record.slug ? ... :
  // ''` gate ahead of the todo branch in headlineRecord.
  //
  // READ THROUGH maintenanceQueryResult, NOT maintenanceQuery: the latter
  // forwards to the non-enveloping boardQuery and ignores `projection`
  // entirely, so it always returns the FULL record — the ORIGINAL K2 read it
  // and passed for the WRONG reason (a full record trivially lacks a `name`
  // key too, so "no name" proved nothing about the gate). Same class of bug
  // H0's control guards against on the board side; this file had no
  // equivalent control on the maintenance side until now.
  const { tools, cleanup } = harness();
  try {
    tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'reconcile article \'k2\' — owned file changed',
      file_keys: ['src/k2.ts'],
    });
    const headline = tools.maintenanceQueryResult({ projection: 'headline', cap: 10 }).records[0];
    assert.equal(
      typeof headline.name,
      'string',
      `a slug-less system item still gets a composed \`name\` — maintenance items never mint a slug at all, so gating on slug presence left every ordinary queue row permanently nameless. Got ${JSON.stringify(headline)}`
    );
    assert.ok(
      (headline.name as string).startsWith("reconcile article 'k2'"),
      `and the name is derived from the item's OWN text (there is no slug to fall back to) — got "${String(headline.name)}"`
    );
  } finally {
    cleanup();
  }
});

test('K3 (NEW, review round 2): a slug-less system item whose text opens with LEADING BLANK LINES is STILL named — the FIRST NON-BLANK line, never a blind `text.split(\'\\n\')[0]` that would yield a blank name', () => {
  // SABOTAGE that must turn this test RED: derive the todo label as
  // `record.text.split('\n')[0]` directly instead of routing through
  // boardDisplayLabel (which explicitly skips leading blank lines).
  const { tools, cleanup } = harness();
  try {
    tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: '\n\n  \nreconcile article \'k3\' — owned file changed',
      file_keys: ['src/k3.ts'],
    });
    const headline = tools.maintenanceQueryResult({ projection: 'headline', cap: 10 }).records[0];
    assert.ok(
      typeof headline.name === 'string' && (headline.name as string).startsWith("reconcile article 'k3' — owned file changed"),
      `the name skips the leading blank lines and reads the first NON-BLANK one — got ${JSON.stringify(headline.name)}`
    );
    assert.ok(!(headline.name as string).startsWith('('), 'and it never opens with a bare id/parenthesis — the leading blank lines never leak through as the name');
  } finally {
    cleanup();
  }
});
