// ---------------------------------------------------------------------------
// S2 of the human-readable-ids objective — SCHEMAS HALF (the digest projection).
// Ruling [human-readable-ids-for-board-items] (knowledge_get 2e8c30e4), and
// AC23 of [mcp-tool-surface] (knowledge_get 7e24629b) for the handle contract.
//
// S1 already shipped: a board `todo` carries a minted human-readable `slug`.
// S2 is the RENDER half — EVERY HUMAN-FACING SURFACE PRINTS `name (id8)`, name
// first, id retained. The ruling's justification travels with it: "Names clip,
// ids never do, because a truncated id is unresolvable while a truncated name
// is still recognisable."
//
// WRITTEN SPEC-ONLY AND BLIND to records.ts. Every assertion below is derived
// from the two records above and the slice brief, never from the implementation.
//
// THE MEASURED GAP THIS FILE PINS: `RECORD_TYPES.todo.digest` is
// `{text:'clip', source, priority, system_reason, objective}` — `slug` is
// ABSENT, so `digestRecord()` never emits it for a todo even when the record
// carries one. Contrast `feature_article`'s digest map, which LEADS with slug.
// A board item therefore still digests as bare hex plus prose, which is the
// exact defect the ruling exists to close.
//
// TWO CONTRACTS ARE DELIBERATELY SPLIT HERE, and the split is the point:
//
//   * THE DIGEST CARRIES THE HANDLE VERBATIM, NEVER CLIPPED. A digest is a
//     receipt/lookup line, and its `slug` is a FIELD, not a composed display
//     string. This follows the precedent already frozen one file over in
//     board-objective.test.ts: "the objective survives into the digest
//     projection whole (a grouping key is a headline, never clipped away)".
//     A handle is the same kind of thing — a clipped handle does not resolve.
//   * THE 48-CHARACTER CLIP IS A PROPERTY OF THE COMPOSED `name (id8)` DISPLAY
//     STRING, and is pinned in the sibling files that own those surfaces
//     (board-item-name-render.test.ts, board-item-name-cards.test.ts). It is
//     asserted ABSENT here on purpose: see S3.
//
// EXPECTED STATE AT HEAD: RED on S1/S2/S3, GREEN on S0 (the control).
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RECORD_TYPES, digestRecord } from '../index.js';

const NOW = '2026-08-29T12:00:00.000Z';

// envelope is duplicated from schemas.test.ts / board-objective.test.ts
// deliberately: importing it from those modules would re-execute every test
// they declare.
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
    stack_tags: ['node'],
  };
}

function userTodo(extra: Record<string, unknown> = {}) {
  return { ...envelope('todo'), text: 'EXPORT THE BOARD AS CSV.\n\nbody prose.', source: 'user', ...extra };
}

// A minted handle at the mint's own <=60 clamp (decision de1a7329). Used to
// prove the digest does NOT clip the handle — the clip belongs to the composed
// display form, not to the field.
const SLUG_60 = 'render-every-human-facing-surface-with-the-readable-name-now';

test('S2-D0 CONTROL (placed FIRST, must pass for the OPPOSITE reason, and passes at HEAD): digestRecord already projects a todo — full id, its text, priority and objective — and invents NO slug key for a todo that has none; so every slug failure below is a MISSING FIELD-MAP ENTRY, never a broken projector', () => {
  // SABOTAGE that must turn this arm RED: delete the `todo` entry from
  // RECORD_TYPES in packages/schemas/src/records.ts.
  //
  // WHY THIS ARM IS THE POINT OF THE FILE: "the digest carries no slug" has
  // more than one possible cause. An implementation whose digestRecord is
  // broken outright, or whose todo map was deleted, satisfies "no slug"
  // perfectly while telling you nothing. This arm must pass for the opposite
  // reason — the projector works, the map is present, and the ONLY thing
  // missing is the slug entry.
  const id = randomUUID();
  const plain = digestRecord({ ...envelope('todo'), id, text: 'A ONE-OFF CHORE.\n\nbody.', source: 'user', priority: 'high', objective: 'Animation pass' });

  assert.equal(plain.id, id, 'the digest carries the FULL id — this is the id half of `name (id8)` and it never clips');
  assert.equal(plain.priority, 'high', 'the existing headline fields survive the projection');
  assert.equal(plain.objective, 'Animation pass', 'and the objective still survives WHOLE (board-objective.test.ts precedent)');
  assert.ok(typeof plain.text === 'string' && (plain.text as string).length > 0, 'the clipped text field is present');
  assert.ok(
    !('slug' in plain),
    'a todo with NO minted handle costs nothing in the digest — no null placeholder, exactly as an ungrouped item mints no `objective` key'
  );
});

test('S2-D1 THE FIELD-MAP PIN: RECORD_TYPES.todo.digest NAMES `slug`, so a digest board read shows the item\'s NAME without a full-body read — the same way feature_article\'s digest map leads with its slug', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // remove `slug` from the `todo` digest field map.
  //
  // WHICH GUARD CARRIES THE VERDICT: this arm alone. It reads the MAP, not the
  // projection, so it is the one assertion in this file that cannot be
  // satisfied by a special-cased `if (rec.type === 'todo')` branch inside
  // digestRecord. D2 below asserts the observable behaviour; together they are
  // deliberate defence in depth, and THIS is the structural one.
  assert.ok(
    'slug' in RECORD_TYPES.todo.digest,
    'EXPECTED FAILURE AT HEAD: the todo digest map is {text, source, priority, system_reason, objective} — `slug` is absent, so digestRecord drops the minted handle on the floor and a digest board read still shows a person bare hex'
  );
  // The handle is a HEADLINE field, never a clipped one: a clipped handle does
  // not resolve, and the whole point of minting it was that it can be cited.
  assert.notEqual(
    (RECORD_TYPES.todo.digest as unknown as Record<string, unknown>).slug,
    'clip',
    'the handle is projected WHOLE, not clipped — `text` is the clipped field; a truncated handle is unresolvable, which is the precise reason the ruling clips names only in the composed display form and never the addressable field'
  );
});

test('S2-D2 THE BEHAVIOUR PIN: a todo carrying a minted slug digests WITH that name beside its FULL id — name first, id retained (ruling 2e8c30e4)', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // remove `slug` from the `todo` digest field map (same one-liner as D1 — the
  // two arms are two independent detectors of one change, by design).
  const id = randomUUID();
  const digest = digestRecord(userTodo({ id, slug: 'export-the-board-as-csv', priority: 'high' }));

  assert.equal(
    digest.slug,
    'export-the-board-as-csv',
    'EXPECTED FAILURE AT HEAD: undefined !== "export-the-board-as-csv" — digestRecord walks RECORD_TYPES.todo.digest, and slug is not on it'
  );
  assert.equal(digest.id, id, 'AND THE ID IS RETAINED IN FULL — the ruling is `name (id8)`, name FIRST, id KEPT; a rendering that swaps the id out for the name is the rejected alternative "drop the id and show only the name"');
  assert.equal((digest.id as string).length, 36, 'the digest id is the full uuid, never the 8-char display form — ids never clip because a truncated id is unresolvable');
});

test('S2-D3 THE CLIP BOUNDARY, STATED AS THE PINNED CONTRACT: the digest field is the ADDRESSABLE handle and is NEVER clipped — even a 60-character minted slug (the mint\'s own clamp) survives byte-for-byte; the 48-character clip is a property of the composed `name (id8)` display string only', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // project the todo digest's `slug` through the 48-character DISPLAY clip
  // (`name.slice(0,47) + '…'`, the composed-handle rule) instead of verbatim.
  // D3 goes red on the 60-character fixture; D1 stays GREEN (the map entry is
  // still not the literal string 'clip') and D2 stays GREEN (its fixture handle
  // is 23 characters, well under 48). That is D3's own verdict, and nothing else
  // in this file carries it: it catches the display clip leaking onto the
  // ADDRESSABLE field, which is the precise confusion this arm exists to prevent.
  //
  // ATTRIBUTION CORRECTED 2026-08-29, MEASURED, AND THE CORRECTION MATTERS. This
  // arm previously named `slug: 'clip'` as its sabotage. Applied, that reddens
  // ONLY D1 — D3 stays GREEN, because DIGEST_CLIP is 160 characters and a
  // <=60-character handle is never truncated by it. So the verdict on that
  // mutation is carried by D1's `notEqual('clip')`, the STRUCTURAL arm, not by
  // this one. THIS IS DEFENCE IN DEPTH HOLDING, NOT A HOLLOW TEST: D1 reads the
  // MAP and D3 reads the OUTPUT, they catch different mutations, and both stay.
  // The comment was wrong, the arm was not — do not "fix" D3 by deleting it.
  //
  // THE PINNED CLIP CONTRACT, stated once for the whole slice:
  //   NAME_CLIP = 48 characters, ellipsis INCLUDED (name.slice(0, 47) + '…').
  //   DERIVATION, so it is a reading of the ruling and not a number picked from
  //   the air: the mint already clamps a slug at 60 characters (de1a7329). The
  //   composed display form is `name (id8)`, whose id half costs exactly 11
  //   characters — one space, two parentheses, eight hex. Reserving those 11 out
  //   of that SAME 60-character budget leaves 49, rounded DOWN to 48 so the
  //   constant survives the id form gaining a character; the composed handle
  //   then lands at 59, inside the one length constant this codebase already
  //   has, and the id — which must never clip — is what the reservation
  //   protects.
  //   THE CLIP APPLIES TO: the composed display form (headline projection, TUI
  //   card titles). THE CLIP DOES NOT APPLY TO: the digest `slug` FIELD, this
  //   test, because a clipped field is an unresolvable address.
  assert.equal(SLUG_60.length, 60, 'premise: this fixture handle sits exactly on the mint\'s <=60 clamp');
  const digest = digestRecord(userTodo({ slug: SLUG_60 }));

  assert.equal(
    digest.slug,
    SLUG_60,
    'the digest carries the 60-character handle byte-for-byte — THE DEFECT THIS CATCHES is a handle that arrives clipped, or not at all'
  );
  assert.ok(!String(digest.slug).includes('…'), 'the digest handle carries no ellipsis — clipping the ADDRESS is what makes it stop resolving');
  assert.equal(String(digest.slug).length, 60, 'the handle field is byte-for-byte the minted slug, not the 48-char display clip');
});

test('S2-D4 SYSTEM ITEMS AND LEGACY ITEMS DEGRADE THE SAME WAY: a maintenance item and a legacy slugless board item both still digest with their full id and no fabricated name — an absent name is safer than an invented one (df361a0f)', () => {
  // SABOTAGE that must turn this test RED: in packages/schemas/src/records.ts
  // make digestRecord fall back to `slug: rec.id.slice(0, 8)` (or to the raw
  // headline text) when a todo has no slug.
  //
  // GREEN AT HEAD AND MUST STAY GREEN — this is a REGRESSION detector, not a
  // red-first pin, and it is here because the obvious way to make D2 pass is a
  // fallback that fabricates a name for every item. AC23 is explicit that a
  // derived display name is DISPLAY-ONLY and must never become addressable;
  // the field a reader would cite must therefore stay absent when nothing was
  // minted, rather than being filled with a hex fragment wearing a costume.
  const queuedId = randomUUID();
  const queued = digestRecord({
    ...envelope('todo'),
    id: queuedId,
    text: 'reconcile article \'tui-dashboard\' — files it owns were touched',
    source: 'system',
    system_reason: 'reconcile_needed',
  });
  assert.equal(queued.id, queuedId, 'the maintenance item keeps its full id');
  assert.equal(queued.system_reason, 'reconcile_needed', 'and its lane');
  assert.ok(!('slug' in queued), 'no handle was minted for it, so the digest names none — never a hex fragment presented as a name');

  const legacyId = randomUUID();
  const legacy = digestRecord({ ...envelope('todo'), id: legacyId, text: 'A LEGACY ITEM PREDATING THE MINT.\n\nbody.', source: 'user' });
  assert.equal(legacy.id, legacyId, 'the legacy item keeps its full id — the citation stays actionable even with no name');
  assert.ok(!('slug' in legacy), 'and the digest fabricates no name for it — display-only derivation belongs to board_get (AC23), never to the field projection a reader cites');
  assert.ok(
    !JSON.stringify(legacy).includes(legacyId.slice(0, 8) + ')'),
    'and nothing in the digest composes a `something (id8)` display string — the digest projects FIELDS; composing the human display form is the headline/TUI surfaces\' job'
  );
});
