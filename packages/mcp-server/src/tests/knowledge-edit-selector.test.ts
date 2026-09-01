// knowledge_edit's array-element selector `arr[key=value].sub` — OWNERSHIP
// semantics of the `key=value` match (board c61c9a3a).
//
// SPEC (written from the board, NOT from tools.ts — do not read the
// implementation): a selector element only counts as a candidate for
// `key=value` if it OWNS `key` (hasOwnProperty AND the value is not
// `undefined`) — ownership is checked BEFORE the stringified-value
// comparison. The historical bug being fixed:
// `String(el[key]) === value` compares the STRINGIFIED value with no
// ownership guard at all, so `String(undefined) === 'undefined'` is TRUE for
// every element that simply lacks the key — a selector meant to find nothing
// (`key` doesn't exist here) silently matched every non-owning sibling
// instead.
//
// Four consequences pinned below, CONTROL first per convention:
//   (2) a selector on a key every candidate element OWNS still edits
//       normally — the ownership guard must not become a blanket refusal.
//   (1) `arr[key=undefined].sub` against elements that LACK `key` entirely
//       matches ZERO elements, refused naming "0" — never "matches every
//       key-lacking element".
//   (3) an OPTIONAL key that exactly one element owns is matched by its
//       OWN value alone — neither elements lacking the key, nor elements
//       that own the key with a DIFFERENT value, inflate the match count.
//   (4) the exactly-once contract is unchanged by this fix: two elements
//       that genuinely OWN the key with the same value are still refused,
//       naming "2".
//
// Two DIFFERENT one-line mutations are named across these pins, because they
// sabotage two different halves of the same match predicate
// (`hasOwnProperty(el,key) && el[key] !== undefined && String(el[key]) ===
// value`): pin (1)'s sabotage drops the OWNERSHIP half (reverting to the
// historical bug); pin (3)'s sabotage drops the VALUE-EQUALITY half instead
// (matching by ownership alone). Both are legitimately "the shared ownership
// predicate" the board names — a conductor running ONE combined mutation
// that guts the whole predicate turns both red; a conductor isolating each
// half turns exactly the test that half's removal breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-09-01T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-edit-selector-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type Loose = Record<string, unknown>;
type FileEntry = { path: string; role: string; unverified?: boolean };

function mkArticle(tools: SterlingTools, slug: string, files: FileEntry[]): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does things',
    intended_behavior: 'intends things',
    files,
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as Loose;
}

function getArticle(tools: SterlingTools, id: string): { files: FileEntry[]; version: number } {
  return tools.knowledgeGet(id) as unknown as { files: FileEntry[]; version: number };
}

function hasKey(el: Loose, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(el, key);
}

// ---------------------------------------------------------------------------
// (2) CONTROL, PLACED FIRST. A selector on a key every candidate element
// OWNS (`path` — required by the schema, so no element can lack it) still
// edits normally: exactly one match, the find/replace applies, the sibling
// is byte-untouched, the version bumps and persists. Without this control,
// pins (1)/(3)/(4) below could all be satisfied by an implementation that
// simply refuses every selector-based edit outright.
// Sabotage: an off-by-one that applies the find/replace to the element
// AFTER the matched one instead of the matched one itself — the
// sibling-untouched assertion catches it; this is unrelated to the
// ownership predicate, which is exactly the point of a control.
// ---------------------------------------------------------------------------
test('CONTROL (first): files[path=x].role edits the ONE matching element on a key every element OWNS — sibling byte-untouched, version bumps and persists (board c61c9a3a)', () => {
  const { tools, cleanup } = harness();
  try {
    const original: FileEntry[] = [
      { path: 'src/a.ts', role: 'the seam role' },
      { path: 'src/b.ts', role: 'the sibling role' },
    ];
    const article = mkArticle(tools, 'control-owned-key', original);
    const id = article.id as string;
    const before = getArticle(tools, id);

    const edited = tools.knowledgeEdit(id, 'files[path=src/a.ts].role', 'seam', 'updated seam');
    const files = (edited.record as unknown as { files: FileEntry[] }).files;
    assert.equal(files.find((f) => f.path === 'src/a.ts')?.role, 'the updated seam role', 'the matched element is edited');
    assert.equal(files.find((f) => f.path === 'src/b.ts')?.role, 'the sibling role', 'the sibling is byte-untouched');

    const after = getArticle(tools, id);
    assert.deepEqual(after.files, files, 'the edit is PERSISTED, not merely echoed');
    assert.equal(after.version, before.version + 1, 'a normal versioned write');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (1) THE PIN. Neither element owns `unverified` at all. The selector
// `files[unverified=undefined].role` must match ZERO elements — the
// stringified-`undefined` collision with a genuinely absent key is exactly
// the historical bug.
// Sabotage: drop the OWNERSHIP guard and revert to the historical
// `String(el[key]) === value` comparison with no ownership check —
// `String(undefined) === 'undefined'` then matches EVERY key-lacking
// element, so this call would succeed (or refuse naming a count other than
// "0") instead of refusing naming "0", and the `/matches 0 element/i`
// assertion goes red.
// ---------------------------------------------------------------------------
test('(1): files[unverified=undefined].role against elements that LACK `unverified` entirely matches ZERO elements — refused naming "0", record UNCHANGED (board c61c9a3a) — sabotage: drop the ownership guard, reverting to `String(el[key]) === value` with no hasOwnProperty check', () => {
  const { tools, cleanup } = harness();
  try {
    const original: FileEntry[] = [
      { path: 'src/a.ts', role: 'a role' },
      { path: 'src/b.ts', role: 'b role' },
    ];
    const article = mkArticle(tools, 'zero-match-key-absent', original);
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.ok(
      before.files.every((f) => !hasKey(f, 'unverified')),
      'PRECONDITION: NEITHER element owns `unverified` — the refusal below can only be about absence, not about a real "undefined" value'
    );

    assert.throws(
      () => tools.knowledgeEdit(id, 'files[unverified=undefined].role', 'a', 'A'),
      /matches 0 element/i,
      'an absent key must never match the literal string "undefined" — the refusal must name the count as 0'
    );

    const after = getArticle(tools, id);
    assert.deepEqual(after.files, before.files, 'the record is UNCHANGED — the refused call wrote nothing');
    assert.equal(after.version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (3) THE PIN. `unverified` is OPTIONAL. Exactly one element owns it with
// the target value (`true`); a sibling owns the SAME key with a DIFFERENT
// value (`false`); a third element lacks the key entirely. Both kinds of
// non-matching sibling must fail to inflate the match count — the selector
// resolves to exactly the one element that both owns the key AND carries
// the matching value, and the edit applies normally.
// Sabotage: drop the VALUE-EQUALITY half of the predicate, matching by
// ownership of the key ALONE (`hasOwnProperty(el, 'unverified')`, ignoring
// what it's set to). The sibling that owns `unverified` with the value
// `false` would then ALSO count as a match — 2 elements instead of 1 — and
// this call, which must succeed, is instead wrongly refused as ambiguous.
// ---------------------------------------------------------------------------
test('(3): files[unverified=true].role matches ONLY the one element that OWNS the key with a matching value — a sibling that owns the key with a DIFFERENT value, and a sibling that lacks the key entirely, do not inflate the match count (board c61c9a3a) — sabotage: match by key ownership alone, dropping the value-equality check', () => {
  const { tools, cleanup } = harness();
  try {
    const original: FileEntry[] = [
      { path: 'src/a.ts', role: 'the seam role', unverified: true },
      { path: 'src/b.ts', role: 'the other-value sibling', unverified: false },
      { path: 'src/c.ts', role: 'the key-lacking sibling' },
    ];
    const article = mkArticle(tools, 'optional-key-single-owner', original);
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.equal(
      before.files.filter((f) => f.unverified === true).length,
      1,
      'PRECONDITION: exactly ONE element owns `unverified` with the matching value `true`'
    );
    assert.equal(
      before.files.filter((f) => hasKey(f, 'unverified') && f.unverified === false).length,
      1,
      'PRECONDITION: exactly ONE sibling owns `unverified` with a DIFFERENT value (`false`) — proves value-equality, not mere ownership, decides the match'
    );
    assert.equal(
      before.files.filter((f) => !hasKey(f, 'unverified')).length,
      1,
      'PRECONDITION: exactly ONE sibling lacks `unverified` entirely — proves absence does not inflate the count either'
    );

    let result: { record: Loose } | undefined;
    assert.doesNotThrow(() => {
      result = tools.knowledgeEdit(id, 'files[unverified=true].role', 'seam', 'flagged seam');
    }, 'a selector on an optional key owned by exactly one element must succeed, not be refused as ambiguous');

    const files = (result!.record as unknown as { files: FileEntry[] }).files;
    assert.equal(files.find((f) => f.path === 'src/a.ts')?.role, 'the flagged seam role', 'the owning-with-matching-value element is edited');
    assert.equal(files.find((f) => f.path === 'src/b.ts')?.role, 'the other-value sibling', 'the owning-with-DIFFERENT-value sibling is untouched');
    assert.equal(files.find((f) => f.path === 'src/c.ts')?.role, 'the key-lacking sibling', 'the key-lacking sibling is untouched');

    const after = getArticle(tools, id);
    assert.deepEqual(after.files, files, 'the edit is PERSISTED');
    assert.equal(after.version, before.version + 1, 'a normal versioned write');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (4) The exactly-once contract is UNCHANGED by the ownership fix: two
// elements that genuinely OWN the key with the SAME value are still an
// ambiguous, refused selector — the ownership guard narrows what counts as
// a candidate, it does not loosen the >1-match refusal once two genuine
// candidates exist. A third element lacking the key is included specifically
// to prove it is NOT what pushes the count to 2 (the pin (1)/(3) sabotage,
// if it accidentally counted lacking elements, would inflate this to 3, not
// change the fact that it should refuse at all — so this test is a
// genuine, independent guard).
// Sabotage: drop the ambiguity/multi-match refusal so the edit silently
// applies to the first matching element instead of throwing.
// ---------------------------------------------------------------------------
test('(4): the exactly-once contract is UNCHANGED — two elements that genuinely OWN the key with the SAME value are still refused naming "2", record UNCHANGED (board c61c9a3a) — sabotage: drop the multi-match ambiguity guard, silently editing the first match', () => {
  const { tools, cleanup } = harness();
  try {
    const original: FileEntry[] = [
      { path: 'src/a.ts', role: 'first flagged role', unverified: true },
      { path: 'src/b.ts', role: 'second flagged role', unverified: true },
      { path: 'src/c.ts', role: 'plain sibling' },
    ];
    const article = mkArticle(tools, 'exactly-once-unchanged', original);
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.equal(
      before.files.filter((f) => f.unverified === true).length,
      2,
      'PRECONDITION: exactly TWO elements genuinely own `unverified` with the matching value `true`'
    );

    assert.throws(
      () => tools.knowledgeEdit(id, 'files[unverified=true].role', 'flagged', 'FLAGGED'),
      /matches 2 element/i,
      'two genuine owners of the same value must still be refused as ambiguous, naming the count as 2'
    );

    const after = getArticle(tools, id);
    assert.deepEqual(after.files, before.files, 'the record is UNCHANGED — neither owning element was edited by the refused call');
    assert.equal(after.version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});
