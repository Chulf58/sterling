// ---------------------------------------------------------------------------
// board 081508d0: a board item's slug is minted from its text ONCE and never
// re-minted (updateTodo's own comment says so); every DISPLAY surface that
// rendered the slug as the item's "name" therefore froze the headline at
// mint time. When slices were renumbered, an item whose text began "Slice
// 7 — ..." still displayed as "slice-6-..." because the slug predated the
// renumbering. THE DECISION (sparred externally, not re-litigated here): the
// slug stays an immutable ADDRESS; the fix is a DISPLAY LABEL derived from
// the item's CURRENT text, never re-deriving or mutating the slug itself.
//
// `boardDisplayLabel(text, slug)` is that shared derivation, defined ONCE
// here (invariant 1) so every display site (headlineRecord, board_get's
// label, TUI cards, lane-collision names) reads one function.
//
// DELIBERATELY NOT `todoHeadline` (tools.ts): that extractor MINTS a slug
// base and therefore DROPS parenthetical asides (`text.replace(/\([^)]*\)/g,
// ' ')`) so the aside never eats the 60-char kebab budget. A DISPLAY label
// has no such budget-collision problem and dropping a parenthetical would
// throw away meaningful text a reader is shown — so this helper keeps it.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardDisplayLabel, clipName, NAME_CLIP } from '../index.js';

test('LABEL1: the first NON-BLANK line of text is the label, leading blank lines skipped', () => {
  assert.equal(
    boardDisplayLabel('\n\n  \nSlice 7 — Dome Farmer defects.\n\nbody prose.', 'slice-6-dome-farmer'),
    'Slice 7 — Dome Farmer defects.',
    'leading blank/whitespace-only lines are skipped to reach the first real line'
  );
});

test('LABEL2: internal whitespace RUNS collapse to a single space, and the line is trimmed', () => {
  assert.equal(
    boardDisplayLabel('  Slice   7   —    foo   \n\nbody.', 'slice-6-foo'),
    'Slice 7 — foo',
    'runs of whitespace inside the headline collapse to one space each, and the leading/trailing whitespace is trimmed'
  );
});

test('LABEL3: a parenthetical aside is KEPT — this is the trap the brief names: todoHeadline (the slug-MINTING extractor) deletes asides, this display helper must not', () => {
  const text = 'S1 (FIRST — S2 AND S3 BOTH CONSUME IT) — MINT A SLUG ON `todo`.\n\nbody.';
  const label = boardDisplayLabel(text, 'mint-a-slug-on-todo');
  assert.ok(label.includes('(FIRST — S2 AND S3 BOTH CONSUME IT)'), `the parenthetical must survive verbatim — got "${label}"`);
  assert.equal(label, 'S1 (FIRST — S2 AND S3 BOTH CONSUME IT) — MINT A SLUG ON `todo`.', 'and the label is otherwise the untouched, whitespace-normalized first line');
});

test('LABEL4: text wins over slug whenever text yields a non-blank headline — the whole point of the fix (derive from CURRENT text, not the immutable slug)', () => {
  // The regression scenario itself, at the helper layer: the slug still
  // reads 'slice-6-...' (never re-minted) but the text now opens "Slice 7".
  assert.equal(
    boardDisplayLabel('Slice 7 — Dome Farmer MCP-tool and queue defects.\n\nbody.', 'slice-6-maintenance-queue-mint-and-mcp-tool-def'),
    'Slice 7 — Dome Farmer MCP-tool and queue defects.',
    'the label reads the CURRENT text headline, ignoring the stale slug entirely'
  );
});

test('LABEL5: empty text falls back to the slug — never an empty name when a real handle exists', () => {
  assert.equal(boardDisplayLabel('', 'a-real-slug'), 'a-real-slug', 'blank text falls back to the slug');
  assert.equal(boardDisplayLabel('   \n\t\n   ', 'a-real-slug'), 'a-real-slug', 'whitespace-only text falls back to the slug the same way');
});

test('LABEL6: both text and slug empty/absent yields the empty string — never a fabricated placeholder inside the helper itself (callers own their own marker, e.g. "(unnamed board item)")', () => {
  assert.equal(boardDisplayLabel('', ''), '', 'nothing to derive from either input');
  assert.equal(boardDisplayLabel('   \n  ', undefined), '', 'a missing slug degrades the same way as an empty one');
});

test('LABEL7: a long label clips exactly the way the existing display renderer already clips a name — NAME_CLIP=48, ellipsis included, leading characters kept (this is clipName, applied by the caller; the helper itself returns the label WHOLE, unclipped, matching the digest field precedent: a clipped field is not the point, a clipped DISPLAY string is)', () => {
  const longHeadline = 'A HANDLE ONE PAST THE FORTY-EIGHT CHARACTER DISPLAY BOUNDARY, KEPT WHOLE.';
  const label = boardDisplayLabel(`${longHeadline}\n\nbody.`, 'short-slug');
  assert.equal(label, longHeadline, 'the helper itself returns the label WHOLE — clipping is the renderer\'s job, same split as the digest/display-form precedent');
  assert.ok(label.length > NAME_CLIP, 'premise: this fixture is longer than the clip boundary');
  const clipped = clipName(label);
  assert.equal(clipped, `${label.slice(0, NAME_CLIP - 1)}…`, 'clipName applied to the label clips it exactly as it already clips any other name — 47 chars + ellipsis');
  assert.equal(clipped.length, NAME_CLIP, 'the clipped form lands exactly on the 48-char budget');
});
