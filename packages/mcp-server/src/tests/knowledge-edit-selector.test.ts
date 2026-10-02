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

// ===========================================================================
// LITERAL REPLACEMENT + exactly-once COUNTING (board-less side finding, fixed
// by the tools.ts lane; extends this file rather than a new file per that
// lane's recommendation — this is the file that already owns the
// arr[key=value].sub selector path, and the plain-field arms below share the
// SAME knowledgeEdit(id, field, find, replace) call shape).
//
// knowledge_edit no longer runs `current.replace(find, replace)` (native JS
// String.replace, which treats `$&`, `$$`, `$1`... specially in the
// REPLACEMENT string even for a plain string search pattern) — replacement
// text is now spliced in LITERALLY. And the exactly-once occurrence count is
// no longer `current.split(find).length - 1` (which UNDERCOUNTS OVERLAPPING
// matches: 'aaa'.split('aa') = ['', 'a'], length-1 = 1, missing the second
// occurrence at offset 1) — it is now a char-by-char-advancing scan that
// finds both offsets 0 and 1 in 'aaa' against find 'aa'.
//
// Two call shapes exercised, both going through knowledgeEdit: the PLAIN
// FIELD path (tools.ts ~:3355) and the files[path=...].role ARRAY-SELECTOR
// path (tools.ts ~:3311) — independent guards, per their own named sabotage
// below.
// ===========================================================================

function mkDecisionWithStatement(tools: SterlingTools, statement: string, slugSuffix: string): Loose {
  return tools.knowledgeCreate('decision', {
    title: `literal-replace fixture ${slugSuffix}`,
    statement,
    alternatives_rejected: [],
    rationale: 'fixture for the literal-replace / occurrence-counting pins',
    file_keys: [],
  }).record as unknown as Loose;
}

// --- PLAIN FIELD (tools.ts ~:3355) -----------------------------------------

// CONTROL, PLACED FIRST: a NON-overlapping single match ('aa' inside 'aab')
// still edits normally on the plain-field path. Without this, the AMBIGUITY
// pin right after it could be satisfied by an implementation that refuses
// every find/replace outright.
// No dedicated sabotage — this is the control the ambiguity pin needs to mean
// anything, not a claim of its own.
test('CONTROL (plain field, first): find "aa" in "aab" (one match, no overlap) still edits successfully', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecisionWithStatement(tools, 'aab', 'control-plain');
    const id = d.id as string;
    const edited = tools.knowledgeEdit(id, 'statement', 'aa', 'Z');
    assert.equal((edited.record as unknown as { statement: string }).statement, 'Zb', 'the one non-overlapping match is replaced');
    const after = tools.knowledgeGet(id) as unknown as Loose;
    assert.equal(after.statement, 'Zb', 'persisted, not merely echoed');
  } finally {
    cleanup();
  }
});

// THE PIN: 'aaa' against find 'aa' has TWO overlapping matches (offset 0 and
// offset 1) — a char-by-char scan finds both; a split-based count
// ('aaa'.split('aa') = ['', 'a'], length-1 = 1) sees only one and would
// wrongly let this succeed.
// Sabotage: restore `current.split(find).length - 1` as the occurrence count
// at the plain-field site (tools.ts ~:3355) — this pin's `assert.throws`
// goes red ("Missing expected exception"), while the CONTROL above and the
// array-selector arms below stay green (each site is an independent guard;
// all four reddening together would mean the harness itself is wrong, not
// this one site).
test('AMBIGUITY (plain field): find "aa" in "aaa" (overlapping matches at offset 0 and 1) is refused, naming the count; record unchanged', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecisionWithStatement(tools, 'aaa', 'ambiguous-plain');
    const id = d.id as string;
    const before = tools.knowledgeGet(id) as unknown as Loose;
    assert.throws(
      () => tools.knowledgeEdit(id, 'statement', 'aa', 'Z'),
      /appears 2 times/,
      'the overlapping-match count (2) is named, not silently 1'
    );
    const after = tools.knowledgeGet(id) as unknown as Loose;
    assert.deepEqual(after, before, 'nothing was written by the refused call');
  } finally {
    cleanup();
  }
});

// CONTROL: an ordinary replacement carrying no `$`-patterns behaves exactly
// as it always has — proves the literal-splice pins below are not merely
// passing because the field happened to be untouched.
test('CONTROL (plain field, dollar-free): an ordinary replacement with no $-patterns behaves as before', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecisionWithStatement(tools, 'the widget was old', 'control-dollar-free');
    const id = d.id as string;
    const edited = tools.knowledgeEdit(id, 'statement', 'old', 'new');
    assert.equal((edited.record as unknown as { statement: string }).statement, 'the widget was new');
  } finally {
    cleanup();
  }
});

// THE PIN: replacement text containing `$&` and `$$` is spliced in LITERALLY
// — native String.prototype.replace treats `$&` as "the matched substring"
// and `$$` as a literal `$` even when the search pattern is a plain string,
// which is exactly the historical bug.
// Sabotage: restore `current.replace(find, replace)` at the plain-field site
// (tools.ts ~:3305/:3348) — MEASURED: the record reads back
// "KEEP cost $5 and ORIG and $ TAIL" instead of the literal replacement text
// (`$&` expands to the matched text 'ORIG', `$$` collapses to a single `$`),
// so this assertion goes red.
test('LITERAL REPLACE (plain field): replace text containing $& and $$ is stored LITERALLY, not native-String.replace-expanded', () => {
  const { tools, cleanup } = harness();
  try {
    const d = mkDecisionWithStatement(tools, 'KEEP ORIG TAIL', 'literal-plain');
    const id = d.id as string;
    const edited = tools.knowledgeEdit(id, 'statement', 'ORIG', 'cost $5 and $& and $$');
    assert.equal(
      (edited.record as unknown as { statement: string }).statement,
      'KEEP cost $5 and $& and $$ TAIL',
      'the replacement text is spliced in literally — $& is not expanded to the matched text, $$ is not collapsed to a single $'
    );
    const after = tools.knowledgeGet(id) as unknown as Loose;
    assert.equal(after.statement, 'KEEP cost $5 and $& and $$ TAIL', 'persisted literally, not merely echoed literally');
  } finally {
    cleanup();
  }
});

// Real newline vs the two literal characters backslash+n: knowledge_edit
// never escapes or unescapes replacement text — whatever character(s) the
// caller sends land verbatim.
test('NEWLINE (plain field): a REAL newline in replace stores a real newline; the two literal characters backslash+n store verbatim', () => {
  const { tools, cleanup } = harness();
  try {
    // ONE constant per replace text, and every expected value is BUILT from
    // it (never retyped as a separate literal) — so the base fixture and the
    // expectation cannot diverge the way a hand-retyped expected string did
    // (conductor-caught: 'line1 \nline2' silently dropped the space between
    // MARK and 'line2' that the base fixture actually carries).
    const BASE = 'line1 MARK line2';
    const REAL_NEWLINE = '\n'; // one actual newline CHARACTER (code 10)
    const LITERAL_BACKSLASH_N = '\\n'; // the TWO literal characters backslash, n

    const realNl = mkDecisionWithStatement(tools, BASE, 'newline-real');
    const realNlId = realNl.id as string;
    const editedReal = tools.knowledgeEdit(realNlId, 'statement', 'MARK', REAL_NEWLINE);
    const expectedReal = BASE.replace('MARK', REAL_NEWLINE);
    assert.equal((editedReal.record as unknown as { statement: string }).statement, expectedReal, 'a real newline character is stored as a real newline, byte-equal to the exact replace text');
    assert.equal(((editedReal.record as unknown as { statement: string }).statement.match(/\n/g) ?? []).length, 1, 'exactly one real newline character present');

    const literalBackslashN = mkDecisionWithStatement(tools, BASE, 'newline-literal');
    const literalId = literalBackslashN.id as string;
    // replace is the TWO literal characters backslash, n — never an escape
    // sequence that gets unescaped into a real newline
    const editedLiteral = tools.knowledgeEdit(literalId, 'statement', 'MARK', LITERAL_BACKSLASH_N);
    const literalStatement = (editedLiteral.record as unknown as { statement: string }).statement;
    const expectedLiteral = BASE.replace('MARK', LITERAL_BACKSLASH_N);
    assert.equal(literalStatement, expectedLiteral, 'the two literal characters backslash+n are stored verbatim, byte-equal to the exact replace text');
    assert.equal((literalStatement.match(/\n/g) ?? []).length, 0, 'no real newline character was introduced by unescaping');
  } finally {
    cleanup();
  }
});

// --- ARRAY SELECTOR files[path=...].role (tools.ts ~:3311) ------------------

function mkArticleWithRole(tools: SterlingTools, role: string, slugSuffix: string): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug: `literal-replace-selector-${slugSuffix}`,
    title: `literal-replace selector fixture ${slugSuffix}`,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: [
      { path: 'src/a.ts', role },
      { path: 'src/b.ts', role: 'the untouched sibling role' },
    ],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as Loose;
}

// CONTROL, PLACED FIRST: same non-overlapping-match shape as the plain-field
// control above, but through the array-selector path.
// No dedicated sabotage — this is the control the array-selector AMBIGUITY
// pin needs to mean anything.
test('CONTROL (array selector, first): find "aa" in files[path=src/a.ts].role = "aab" (one match, no overlap) still edits successfully, sibling untouched', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticleWithRole(tools, 'aab', 'control');
    const id = article.id as string;
    const edited = tools.knowledgeEdit(id, 'files[path=src/a.ts].role', 'aa', 'Z');
    const files = (edited.record as unknown as { files: FileEntry[] }).files;
    assert.equal(files.find((f) => f.path === 'src/a.ts')?.role, 'Zb', 'the one non-overlapping match is replaced');
    assert.equal(files.find((f) => f.path === 'src/b.ts')?.role, 'the untouched sibling role', 'sibling byte-untouched');
  } finally {
    cleanup();
  }
});

// THE PIN: same overlapping-match shape as the plain-field pin above,
// through the array-selector path — an INDEPENDENT guard at a different call
// site (tools.ts ~:3311), not the same code path as the plain-field pin.
// Sabotage: restore `current.split(find).length - 1` at the array-selector
// site specifically — THIS pin's `assert.throws` goes red while the
// plain-field AMBIGUITY pin above (a different site) stays green.
test('AMBIGUITY (array selector): find "aa" in files[path=src/a.ts].role = "aaa" (overlapping matches at offset 0 and 1) is refused, naming the count; record unchanged', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticleWithRole(tools, 'aaa', 'ambiguous');
    const id = article.id as string;
    const before = getArticle(tools, id);
    assert.throws(
      () => tools.knowledgeEdit(id, 'files[path=src/a.ts].role', 'aa', 'Z'),
      /appears 2 times/,
      'the overlapping-match count (2) is named, not silently 1'
    );
    const after = getArticle(tools, id);
    assert.deepEqual(after.files, before.files, 'nothing was written by the refused call');
  } finally {
    cleanup();
  }
});

// THE PIN: same $&/$$ literal-splice shape as the plain-field pin above,
// through the array-selector path.
// Sabotage: restore `current.replace(find, replace)` at the array-selector
// site (tools.ts ~:3311) — the role would read back
// "the cost $5 and ORIG and $ role" instead of the literal replacement text.
test('LITERAL REPLACE (array selector): replace text containing $& and $$ is stored LITERALLY in files[path=...].role', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticleWithRole(tools, 'the ORIG role', 'literal');
    const id = article.id as string;
    const edited = tools.knowledgeEdit(id, 'files[path=src/a.ts].role', 'ORIG', 'cost $5 and $& and $$');
    const files = (edited.record as unknown as { files: FileEntry[] }).files;
    assert.equal(
      files.find((f) => f.path === 'src/a.ts')?.role,
      'the cost $5 and $& and $$ role',
      'the replacement text is spliced in literally in the selected array element'
    );
    const after = getArticle(tools, id);
    assert.deepEqual(after.files, files, 'persisted literally, not merely echoed literally');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// BOOLEAN SUB-FIELD (Dome Farmer issue #48, 2026-09-23). A state_review item
// directs "clear the unverified flags" on files[] entries, but the selector
// edit refused every non-string sub-field, so the only route was a
// whole-array knowledge_update of files[] — the retransmission hazard the
// selector exists to avoid. For a BOOLEAN sub-field the exactly-once contract
// maps onto the value itself: `find` must be the element's CURRENT value
// spelled 'true' or 'false', and `replace` must be 'true' or 'false'.
// Sabotage: restore the blanket `typeof cur !== 'string'` refusal — the
// clear pin goes red with "is boolean, not a string".
// ---------------------------------------------------------------------------
test('BOOLEAN (array selector): files[path=x].unverified find "true" replace "false" clears the ONE flag — sibling byte-untouched, version bumps and persists', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'bool-clear', [
      { path: 'src/a.ts', role: 'the a role', unverified: true },
      { path: 'src/b.ts', role: 'the b role', unverified: true },
    ]);
    const id = article.id as string;
    const before = getArticle(tools, id);

    const edited = tools.knowledgeEdit(id, 'files[path=src/a.ts].unverified', 'true', 'false');
    const files = (edited.record as unknown as { files: FileEntry[] }).files;
    assert.deepEqual(files, [
      { path: 'src/a.ts', role: 'the a role', unverified: false },
      { path: 'src/b.ts', role: 'the b role', unverified: true },
    ]);
    const after = getArticle(tools, id);
    assert.deepEqual(after.files, files, 'the edit is PERSISTED, not merely echoed');
    assert.equal(after.version, before.version + 1, 'a normal versioned write');
  } finally {
    cleanup();
  }
});

test('BOOLEAN (array selector): a find that is not the CURRENT value, or a replace that is not true/false, is refused and writes nothing', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'bool-refuse', [{ path: 'src/a.ts', role: 'the a role', unverified: true }]);
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.throws(
      () => tools.knowledgeEdit(id, 'files[path=src/a.ts].unverified', 'false', 'true'),
      /'unverified' on the selected files element is true, not 'false'/
    );
    assert.throws(
      () => tools.knowledgeEdit(id, 'files[path=src/a.ts].unverified', 'true', 'no'),
      /boolean — 'replace' must be 'true' or 'false'/
    );
    assert.throws(
      () => tools.knowledgeEdit(id, 'files[path=src/a.ts].unverified', 'tru', 'false'),
      /'unverified' on the selected files element is true, not 'tru'/
    );
    const after = getArticle(tools, id);
    assert.deepEqual(after, before, 'nothing was written by any refused call');
  } finally {
    cleanup();
  }
});

test('BOOLEAN (array selector): an ABSENT sub-field is still refused — edit changes an existing value, it does not add a key', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'bool-absent', [{ path: 'src/a.ts', role: 'the a role' }]);
    const id = article.id as string;
    assert.throws(
      () => tools.knowledgeEdit(id, 'files[path=src/a.ts].unverified', 'true', 'false'),
      /'unverified' on the selected files element is absent/
    );
  } finally {
    cleanup();
  }
});
