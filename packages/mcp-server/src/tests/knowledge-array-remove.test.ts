// A selector-based removal of ONE element from a feature_article's files[]
// (board 39673f6a-9c00-4642-b870-ba93015c2dd3).
//
// WHY: knowledge_append only ADDS to files[]; knowledge_edit's `arr[key=
// value].sub` selector edits one string field inside one element but has no
// delete verb. Removing a single entry today means retransmitting the whole
// array — exactly the shape that produced anti-pattern d25f5a9e (a silent
// truncation on a whole-array retransmit). The asymmetry is the smell:
// append and edit are both protected from retransmission; the one operation
// that DESTROYS content is the one that demands you re-send everything.
//
// PROPOSED NAME (the spec does not fix one — rename in this ONE place if the
// implementer picks differently): `knowledgeArrayRemove` on SterlingTools,
// registered as an MCP tool (`knowledge_array_remove` or a files[]-specific
// `knowledge_files_remove`). Reuses knowledge_edit's `arr[key=value]`
// selector grammar with NO trailing `.sub` — the whole matched element is
// removed, not one of its string sub-fields. Proposed call shape:
//   knowledgeArrayRemove(id: string, selector: string, expectedVersion: number)
//     -> { record: <the updated record> }
// This is a DESTROYING call (AC9) — full ids only, no ladder resolution.
//
// SPEC pinned here:
//   AC6  — exact-match selector removes exactly that element; siblings
//          byte-identical, order preserved.
//   AC7  — a ZERO-match selector is refused naming the count; unchanged.
//   AC8  — a >1-match selector is refused naming the count; unchanged.
//   AC9  — destroying call: an unambiguous 8-char prefix (which resolves
//          fine on read/update) is refused here; exact full id only
//          (anti-pattern no-bounded-trail-guard-for-destructive-addressing).
//   AC10 — a stale expected_version is refused naming BOTH versions;
//          unchanged.
//   AC11 — removing the LAST files[] entry is refused (an empty files[] is
//          not a valid feature_article) — mirrors knowledge-split.test.ts's
//          established "a split donating ALL of the parent's files is
//          refused — the parent must retain at least one owned file" rule.
//
// APPENDED 2026-08-30 — two defects found by an independent correctness
// review of the shipped implementation (A1-A4, B1-B3 below). THIS FILE FIXES
// THE INTERFACE THE SPEC LEFT UNDECIDED — the exact refusal wording/shape for
// both defects is decided in ONE clearly-marked place: the
// "THE ONE PLACE THIS FILE FIXES THE UNDECIDED INTERFACE" block beneath AC11.
// An implementer who prefers different wording changes the three regexes
// there, not the tests.
//
// Written RED-FIRST against a SterlingTools with no such method at all
// today (verified absent, board 39673f6a — Codex's read-only sweep found no
// knowledge_files_add/remove, files_add/remove, or array-element deletion
// anywhere in packages/mcp-server/src). Every refusal case asserts the
// record is UNCHANGED afterward, not merely that the call threw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SterlingStore } from '@sterling/store';
import { createSterlingServer } from '../server.js';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-30T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-array-remove-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

type Loose = Record<string, unknown>;

type ArrayRemoveResult = { record: Loose };
type ArrayRemover = {
  knowledgeArrayRemove(id: string, selector: string, expectedVersion: number): ArrayRemoveResult;
};
// the cast-through-unknown seam: `knowledgeArrayRemove` is not on
// SterlingTools's declared type until this slice ships — cast rather than
// reference, so a missing implementation fails on an AssertionError/TypeError
// at the call site, never on a package build error.
function remover(tools: SterlingTools): ArrayRemover {
  return tools as unknown as ArrayRemover;
}

function mkArticle(tools: SterlingTools, slug: string, files: { path: string; role: string }[]): Loose {
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

function getArticle(tools: SterlingTools, id: string): { files: Loose[]; version: number } {
  return tools.knowledgeGet(id) as unknown as { files: Loose[]; version: number };
}

// Flexible alternation, not an exact string — same convention as
// board-remove-prefix-collision-guard.test.ts's FULL_UUID_REQUIRED.
const FULL_UUID_REQUIRED = /full uuid|full id/i;

// ---------------------------------------------------------------------------
// AC6 — the core positive case.
// Sabotage: an off-by-one in the match/splice index (e.g. removing the
// element AFTER the matched one instead of the matched one itself) — this
// test's siblings-and-order assertion must catch it.
// ---------------------------------------------------------------------------
test('AC6: removing an existing entry by an exactly-matching selector succeeds — files[] is the original minus exactly that element, siblings byte-identical, order preserved (board 39673f6a)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { path: 'src/a.ts', role: 'the seam' },
      { path: 'src/b.ts', role: 'the sibling seam' },
      { path: 'src/c.ts', role: 'the third seam' },
    ];
    const article = mkArticle(tools, 'multi-remove', original);

    let result: ArrayRemoveResult | undefined;
    assert.doesNotThrow(() => {
      result = remover(tools).knowledgeArrayRemove(article.id as string, 'files[path=src/b.ts]', article.version as number);
    }, 'removing one existing entry by an exact-match selector must succeed');

    const files = (result!.record as unknown as { files: Loose[] }).files;
    assert.deepEqual(
      files,
      [original[0], original[2]],
      'the result is the original minus exactly the matched element, siblings byte-identical, order preserved'
    );

    const reread = getArticle(tools, article.id as string);
    assert.deepEqual(reread.files, [original[0], original[2]], 'the removal is PERSISTED, not merely echoed');
    assert.equal(reread.version, (article.version as number) + 1, 'a normal versioned write, not a back door');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC7 — zero-match refusal, record unchanged.
// Sabotage: delete the zero-match guard (the call silently no-ops or
// version-bumps with nothing removed instead of throwing).
// ---------------------------------------------------------------------------
test('AC7: a selector matching ZERO elements is REFUSED naming the count (0); the record is UNCHANGED (board 39673f6a)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { path: 'src/a.ts', role: 'the seam' },
      { path: 'src/b.ts', role: 'the sibling seam' },
    ];
    const article = mkArticle(tools, 'zero-match', original);
    const before = getArticle(tools, article.id as string);

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(article.id as string, 'files[path=src/zzz.ts]', article.version as number),
      /matches 0 element/i,
      "an unmatched selector is refused, naming the count — mirrors knowledge_edit's own zero-match refusal shape"
    );

    const after = getArticle(tools, article.id as string);
    assert.deepEqual(after.files, before.files, 'the record is UNCHANGED — no element was dropped by the refused call');
    assert.equal(after.version, before.version, 'no version was minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC8 — ambiguous-match refusal, record unchanged.
// Sabotage: loosen the ambiguity guard to silently remove the FIRST match
// instead of refusing.
// ---------------------------------------------------------------------------
test('AC8: a selector matching MORE THAN ONE element is REFUSED naming the count; the record is UNCHANGED (board 39673f6a)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { path: 'src/dup.ts', role: 'first duplicate' },
      { path: 'src/dup.ts', role: 'second duplicate' },
      { path: 'src/c.ts', role: 'unrelated' },
    ];
    const article = mkArticle(tools, 'ambiguous-match', original);
    const before = getArticle(tools, article.id as string);

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(article.id as string, 'files[path=src/dup.ts]', article.version as number),
      /matches 2 element/i,
      'an ambiguous selector is refused naming the count — a blind delete inside an array too large to read is exactly the unreviewable write this grammar exists to prevent'
    );

    const after = getArticle(tools, article.id as string);
    assert.deepEqual(after.files, before.files, 'the record is UNCHANGED — neither duplicate was dropped');
    assert.equal(after.version, before.version, 'no version was minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC9 — destroying call demands the exact full id; a prefix that is
// otherwise unambiguous (and resolves fine on the read surface) is refused.
// Sabotage: route this call through the same permissive id-ladder used by
// knowledgeGet/knowledgeUpdate instead of an exact-id-only resolver.
// ---------------------------------------------------------------------------
test('AC9: this is a DESTROYING call — an unambiguous 8-char prefix that resolves fine on the read surface is REFUSED here, demanding the exact full id (anti-pattern no-bounded-trail-guard-for-destructive-addressing) (board 39673f6a)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { path: 'src/a.ts', role: 'the seam' },
      { path: 'src/b.ts', role: 'sibling' },
    ];
    const article = mkArticle(tools, 'prefix-refused', original);
    const prefix = (article.id as string).slice(0, 8);

    // precondition: the prefix is NOT ambiguous — it resolves fine on the
    // read surface, proving the refusal below is about the DESTROYING
    // nature of this call, not a bad/colliding prefix.
    assert.doesNotThrow(() => tools.knowledgeGet(prefix), 'precondition: the prefix resolves unambiguously on the read surface');

    const before = getArticle(tools, article.id as string);

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(prefix, 'files[path=src/b.ts]', article.version as number),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `refusal must name the full-uuid requirement — got: "${err.message}"`);
        return true;
      },
      'a prefix must be refused on this destroying call even though it resolves fine elsewhere'
    );

    const after = getArticle(tools, article.id as string);
    assert.deepEqual(after.files, before.files, 'the record is UNCHANGED — the prefix-addressed call never landed');
    assert.equal(after.version, before.version, 'no version was minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC10 — a stale expected_version refuses naming BOTH versions.
// Sabotage: drop the expected_version comparison entirely (the parameter is
// accepted but never checked against the current version).
// ---------------------------------------------------------------------------
test('AC10: a stale expected_version is REFUSED naming BOTH the stale and the current version — no silent overwrite; record UNCHANGED (board 39673f6a)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { path: 'src/a.ts', role: 'the seam' },
      { path: 'src/b.ts', role: 'sibling' },
    ];
    const article = mkArticle(tools, 'stale-version', original);
    // bump the version twice via ordinary unrelated writes, so the caller's
    // held reference (version 1) is stale by the time it calls remove
    tools.knowledgeUpdate(article.id as string, { what_it_does: 'does things, v2' });
    tools.knowledgeUpdate(article.id as string, { what_it_does: 'does things, v3' });
    const current = getArticle(tools, article.id as string);
    assert.equal(current.version, 3, 'precondition: the record has moved on since the stale reference was taken');

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(article.id as string, 'files[path=src/b.ts]', 1),
      (err: Error) => {
        assert.match(err.message, /version conflict/i, 'the refusal is named as a version conflict, matching the existing stale-write convention');
        assert.ok(err.message.includes('1'), 'the STALE version the caller held (1) is named');
        assert.ok(err.message.includes('3'), 'the CURRENT version (3) is named');
        return true;
      },
      'a stale expected_version must refuse rather than silently overwrite'
    );

    const after = getArticle(tools, article.id as string);
    assert.deepEqual(after.files, current.files, 'the record is UNCHANGED — no element dropped by the refused call');
    assert.equal(after.version, current.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC11 — removing the last remaining files[] entry is refused.
// Sabotage: omit the last-file guard (allow files[] to become empty).
// ---------------------------------------------------------------------------
test("AC11: removing the LAST remaining files[] entry is REFUSED — a feature_article must retain at least one owned file, mirroring knowledge-split.test.ts's established \"parent must retain at least one file\" rule; record UNCHANGED (board 39673f6a)", () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'last-file', [{ path: 'src/only.ts', role: 'sole owner' }]);
    const before = getArticle(tools, article.id as string);

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(article.id as string, 'files[path=src/only.ts]', article.version as number),
      /retain|at least one/i,
      "removing the only remaining file must be refused — an empty files[] is not a valid feature_article (mirrors knowledge-split.test.ts's own \"full donation refused\" rule)"
    );

    const after = getArticle(tools, article.id as string);
    assert.deepEqual(after.files, before.files, 'the record is UNCHANGED — the sole file survives the refused call');
    assert.equal(after.version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// THE ONE PLACE THIS FILE FIXES THE UNDECIDED INTERFACE
// ===========================================================================
// The two defects below were found by an independent correctness review of
// the SHIPPED implementation. The review named the holes; it did not name the
// refusal wording or error shape. These three regexes ARE that decision — an
// implementer who prefers different prose changes them HERE and nowhere else.
// They are deliberately forgiving alternations (same convention as
// FULL_UUID_REQUIRED above): they pin WHAT THE REFUSAL MUST TEACH, not its
// exact prose.
//
// DECISION 1 — a record carrying NO stored `version` REFUSES a destroying
// removal outright. `expected_version` is REQUIRED on this call (unlike
// knowledge_update, where it is optional) on the stated rationale that "a
// destroy states what it read". A record with no version cannot satisfy that
// contract at all: there is nothing for the stated token to be checked
// against, so ANY token — right, wrong, or invented — is accepted. Skipping
// the check is therefore the one outcome the requirement exists to forbid;
// the honest reading is that an unversionable record cannot be destroyed
// through this call, not that it can be destroyed unchecked.
const UNVERSIONED_DESTROY_REFUSED =
  /unversioned|no stored version|no version|without a version|carries no version|cannot be version[- ]checked|not versioned/i;

// DECISION 2 — a non-positive / non-integer `expected_version` is an INVALID
// ARGUMENT, refused at the METHOD layer, and NOT reported as a version
// conflict. Two reasons it must not be a conflict: (a) no record is ever at
// version 0 or -1, so "conflict" teaches the caller to retry with the current
// version when the real fix is to pass a real token; (b) on a version-less
// record the CAS comparison is skipped entirely, so "conflict" is not even
// reachable — the argument check is the only thing standing between a garbage
// token and a destroy.
const INVALID_VERSION_TOKEN =
  /positive integer|must be positive|must be a positive|must be an integer|greater than (0|zero)|invalid (expected_)?version/i;

// DECISION 3 — a selector value is compared against an element's OWN value
// only where the key is PRESENT. A missing key never matches ANY value,
// including the literal string `undefined`. The outcome is therefore ZERO
// matches, which routes into the refusal AC7 already pins — so this decision
// adds no new refusal vocabulary, it just stops `String(el[key]) === value`
// from turning absence into a match.
const ZERO_MATCH_REFUSED = /matches 0 element/i;

// DECISION 4 — WHICH ARRAYS MAY BE EMPTIED BY A REMOVAL (the adjacent
// question the defect reports did not ask). AC11 already floors
// `feature_article.files`. `history`, `current_ac` and `live_test_refs` have
// no floor, and they should NOT all get one. The rule pinned here:
//
//   * `current_ac` and `live_test_refs` MAY be emptied. This is not an
//     assumption — it is PROVEN by this file's own harness: mkArticle()
//     creates every article in AC6-AC11 with `current_ac: []` and
//     `live_test_refs: []`, and those creates succeed (the suite is green).
//     An article with both arrays empty is therefore a state an article can
//     be BORN in. Refusing a removal that returns it to a birth-legal state
//     would make that state reachable by creation but not by removal, which
//     is incoherent — and it would be a floor invented by a bug fix rather
//     than by the schema.
//   * `history` MAY NOT be emptied. It is not a birth-legal empty: every
//     article here is born WITH a history entry, and history is the record's
//     audit trail. The anti-pattern governing this territory
//     (no-bounded-trail-guard-for-destructive-addressing) is about destroying
//     operations whose safety rests on an audit trail surviving; an operation
//     that can delete the audit trail ITSELF is that anti-pattern's root
//     case, not an exception to it. So the last history entry is floored, for
//     the same reason AC11 floors the last file: the empty state is not a
//     valid article, it is an article that has forgotten what happened to it.
const LAST_ELEMENT_FLOOR_REFUSED = /retain|at least one|cannot be emptied|last (remaining )?(entry|element)/i;

// ---------------------------------------------------------------------------
// Shared helpers for the appended pins. mkArticle() above is left untouched
// (it is load-bearing for AC6-AC11); this is a superset that lets a pin shape
// any of the article's object arrays.
// ---------------------------------------------------------------------------
type FileEntry = { path: string; role: string; unverified?: boolean };

function mkArticleRaw(tools: SterlingTools, slug: string, overrides: Record<string, unknown>): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does things',
    intended_behavior: 'intends things',
    // two files by default, so the AC11 last-file floor can never be the
    // cause of a refusal in a pin that is about some OTHER array
    files: [
      { path: 'src/a.ts', role: 'the seam' },
      { path: 'src/b.ts', role: 'sibling' },
    ] as FileEntry[],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    ...overrides,
  }).record as unknown as Loose;
}

function getRecord(tools: SterlingTools, id: string): Record<string, unknown> {
  return tools.knowledgeGet(id) as unknown as Record<string, unknown>;
}

function arrayField(tools: SterlingTools, id: string, field: string): Loose[] {
  return (getRecord(tools, id)[field] ?? []) as Loose[];
}

function hasKey(el: Loose, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(el, key);
}

// ===========================================================================
// DEFECT A — the REQUIRED token is not actually required in the case that
// matters. server.ts:436 declares expected_version as `.int().positive()`;
// the method at tools.ts:2279 accepts any integer, and tools.ts:2286 skips
// the version check entirely when the stored record carries no `version`.
// ===========================================================================

// ---------------------------------------------------------------------------
// A3 — CONTROL, PLACED FIRST. Without this, A1/A2/A4 are all satisfied by an
// implementation that simply refuses every removal. This arm must pass for
// the OPPOSITE reason: the happy path still works.
// Sabotage: make knowledgeArrayRemove throw unconditionally (or refuse any
// expected_version) — A1/A2/A4 would still be green, and only THIS goes red.
// ---------------------------------------------------------------------------
test('A3 (CONTROL, first): a CORRECT expected_version on a normally-versioned record still SUCCEEDS — proves A1/A2/A4 pin a guard, not a broken feature (defect A)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { path: 'src/a.ts', role: 'the seam' },
      { path: 'src/b.ts', role: 'the sibling seam' },
      { path: 'src/c.ts', role: 'the third seam' },
    ];
    const article = mkArticle(tools, 'correct-token-still-works', original);
    const before = getArticle(tools, article.id as string);

    let result: ArrayRemoveResult | undefined;
    assert.doesNotThrow(() => {
      result = remover(tools).knowledgeArrayRemove(
        article.id as string,
        'files[path=src/b.ts]',
        before.version
      );
    }, 'a correct expected_version on a versioned record must still succeed — the defect-A fix must not become a blanket refusal');

    assert.deepEqual(
      (result!.record as unknown as { files: Loose[] }).files,
      [original[0], original[2]],
      'the correct-token path still removes exactly the matched element'
    );
    const after = getArticle(tools, article.id as string);
    assert.deepEqual(after.files, [original[0], original[2]], 'persisted');
    assert.equal(after.version, before.version + 1, 'the successful path DOES mint a version — the counterpart to every refusal arm asserting it does not');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// A4 — the ONE version guarantee that works today must survive the fix.
// Placed second, before the two failing pins, because it is the other half of
// the control: A2 says a garbage token is NOT a version conflict, A4 says a
// genuinely stale token IS one. Together the two refusals cannot be confused
// for each other, so neither can pass for the other's reason.
// Sabotage: drop the expected_version comparison (or report the stale token
// without naming the current version).
// ---------------------------------------------------------------------------
test('A4: a STALE expected_version is still REFUSED naming BOTH versions — existing behavior, pinned so the defect-A fix cannot regress it; record UNCHANGED (defect A)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'stale-token-survives', [
      { path: 'src/a.ts', role: 'the seam' },
      { path: 'src/b.ts', role: 'sibling' },
    ]);
    // three ordinary unrelated writes → current version 4, distinct enough
    // from the stale 1 that the digit assertions below cannot match by luck
    tools.knowledgeUpdate(article.id as string, { what_it_does: 'v2' });
    tools.knowledgeUpdate(article.id as string, { what_it_does: 'v3' });
    tools.knowledgeUpdate(article.id as string, { what_it_does: 'v4' });
    const current = getArticle(tools, article.id as string);
    assert.equal(current.version, 4, 'precondition: the record moved on since the stale reference was taken');

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(article.id as string, 'files[path=src/b.ts]', 1),
      (err: Error) => {
        assert.match(err.message, /version conflict/i, `a genuinely stale token IS a CAS conflict (the opposite arm of A2) — got: "${err.message}"`);
        assert.match(err.message, /\b1\b/, 'the STALE version the caller held (1) is named');
        assert.match(err.message, /\b4\b/, 'the CURRENT version (4) is named — a conflict that hides the current version cannot be acted on');
        return true;
      },
      'a stale expected_version must still refuse rather than silently overwrite'
    );

    const after = getArticle(tools, article.id as string);
    assert.deepEqual(after.files, current.files, 'the record is UNCHANGED');
    assert.equal(after.version, current.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// A1 — THE IMPORTANT ONE. tools.ts:2286 skips the version check entirely when
// the stored record carries no `version`, so a version-less record accepts a
// destroying removal with an ARBITRARY token, silently.
//
// REACHING THE STATE: `version` is server-owned (knowledge_schema:
// server_owned:true), so a version-less record is not reachable through the
// ordinary create surface. This harness therefore wraps the DECLARED `store`
// constructor parameter the existing harness() already passes, in a Proxy
// that strips `version` from the target slug's record on the way out of the
// store. It invents no store interface: it names no store method, binds every
// call back to the real store (so private class fields still resolve), and
// leaves non-plain objects untouched. It is armed only for the duration of
// the destroying call.
//
// The precondition assertion below is load-bearing: if the strip does not
// take (e.g. the store hands the tools layer a serialized payload this proxy
// does not reach), the test fails on the PRECONDITION with an explicit
// harness message rather than silently pinning nothing. A failure on the
// precondition means "fix the harness"; a failure on the throws() means "the
// defect is live". The two are deliberately distinguishable.
//
// Sabotage: restore the `if (!stored.version) skip the check` branch — this
// test goes red while every other test in the file stays green.
// ---------------------------------------------------------------------------
function versionlessHarness(slug: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-array-remove-vl-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  let stripping = false;

  const strip = (value: unknown, depth = 0): unknown => {
    if (depth > 8 || value === null || value === undefined) return value;
    if (typeof value === 'string') {
      // the store may hand the tools layer a serialized payload rather than a
      // parsed object; handle that narrowly, scoped to OUR slug only
      if (value.includes(`"slug":"${slug}"`) && value.includes('"version"')) {
        try {
          return JSON.stringify(strip(JSON.parse(value), depth + 1));
        } catch {
          return value;
        }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => strip(v, depth + 1));
    if (typeof value !== 'object') return value;
    // never re-shape a class instance (Date, prepared statement, ...) — only
    // plain records, so the proxy cannot break the call it is observing
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = strip(v, depth + 1);
    if (out.slug === slug) delete out.version;
    return out;
  };

  const proxied = new Proxy(store, {
    get(target, prop) {
      const value = (target as unknown as Record<string | symbol, unknown>)[prop as string];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return stripping ? strip(out) : out;
      };
    },
  });

  const tools = new SterlingTools({ store: proxied, now: () => NOW });
  return {
    tools,
    setStripping: (v: boolean) => {
      stripping = v;
    },
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('A1: a destroying removal against a record with NO stored `version` is REFUSED — an unversionable record cannot satisfy the CAS contract `expected_version` exists to provide, so ANY token must not silently destroy; record UNCHANGED (defect A, tools.ts:2286)', () => {
  const SLUG = 'no-stored-version';
  const h = versionlessHarness(SLUG);
  try {
    const article = h.tools.knowledgeCreate('feature_article', {
      slug: SLUG,
      title: SLUG,
      what_it_does: 'does things',
      intended_behavior: 'intends things',
      files: [
        { path: 'src/a.ts', role: 'the seam' },
        { path: 'src/b.ts', role: 'sibling' },
      ],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    }).record as unknown as Loose;
    const id = article.id as string;
    const before = getRecord(h.tools, id);

    h.setStripping(true);
    const asSeen = getRecord(h.tools, id);
    assert.equal(
      asSeen.version,
      undefined,
      'PRECONDITION (harness, not the pin): the tools layer must see a record carrying NO `version`. A failure HERE means the version-stripping proxy did not reach the value the tools layer reads — fix the harness; it does not mean the defect is absent.'
    );
    assert.deepEqual(
      (asSeen.files as Loose[]).map((f) => f.path),
      ['src/a.ts', 'src/b.ts'],
      'PRECONDITION: the version-less view is otherwise intact, so the refusal below can only be about the missing version'
    );

    // an ARBITRARY token — positive, so the A2 argument check cannot be what
    // refuses; the ONLY possible cause of a refusal here is the missing version
    assert.throws(
      () => remover(h.tools).knowledgeArrayRemove(id, 'files[path=src/b.ts]', 12345),
      (err: Error) => {
        assert.match(err.message, UNVERSIONED_DESTROY_REFUSED, `the refusal must name the missing version — got: "${err.message}"`);
        return true;
      },
      'an arbitrary expected_version against a version-less record must NOT silently destroy — that is exactly the guarantee the required token exists to provide'
    );

    // and a PLAUSIBLE token fares no better: the point is that no token can
    // be checked, not that this particular number was wrong
    assert.throws(
      () => remover(h.tools).knowledgeArrayRemove(id, 'files[path=src/b.ts]', 1),
      UNVERSIONED_DESTROY_REFUSED,
      'a plausible-looking token is refused for the same reason — there is nothing to check it against'
    );

    h.setStripping(false);
    const after = getRecord(h.tools, id);
    assert.deepEqual(after.files, before.files, 'the record is UNCHANGED — no element was dropped by either refused call');
    assert.equal(after.version, before.version, 'no version minted by the refused calls');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A2 — the zod layer (server.ts:436, `.int().positive()`) and the method
// layer (tools.ts:2279, any integer) disagree. The method is directly
// callable, so the guarantee must exist at the method layer too.
// Sabotage: delete the argument check from the method and rely on zod — this
// test goes red while the MCP-surface behavior is unchanged, which is exactly
// the divergence being pinned.
// ---------------------------------------------------------------------------
test('A2: a NON-POSITIVE or non-integer expected_version is REFUSED AT THE METHOD layer as an INVALID ARGUMENT (not as a version conflict) — the directly-callable method must not diverge from server.ts:436 `.int().positive()`; record UNCHANGED (defect A, tools.ts:2279)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'non-positive-token', [
      { path: 'src/a.ts', role: 'the seam' },
      { path: 'src/b.ts', role: 'sibling' },
    ]);
    const id = article.id as string;
    const before = getArticle(tools, id);

    for (const bad of [0, -1, -1000, 1.5]) {
      assert.throws(
        () => remover(tools).knowledgeArrayRemove(id, 'files[path=src/b.ts]', bad),
        (err: Error) => {
          assert.match(err.message, INVALID_VERSION_TOKEN, `expected_version ${bad} must be refused with a message that TEACHES the constraint — got: "${err.message}"`);
          assert.doesNotMatch(
            err.message,
            /version conflict/i,
            `expected_version ${bad} is a garbage token, not a stale one: no record is ever at version 0, -1 or 1.5, so reporting a CAS conflict teaches the caller to retry with the current version when the real fix is to pass a real token (and on a version-less record the conflict path is not even reachable — see A1)`
          );
          return true;
        },
        `expected_version ${bad} must be refused at the METHOD layer, not only by zod at the MCP surface`
      );

      const after = getArticle(tools, id);
      assert.deepEqual(after.files, before.files, `the record is UNCHANGED after the refused call with expected_version ${bad}`);
      assert.equal(after.version, before.version, `no version minted by the refused call with expected_version ${bad}`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DEFECT B — key-absent elements are SELECTABLE. tools.ts:2310 compares
// `String(el[key]) === value`, so `[anykey=undefined]` matches every element
// that LACKS that key. Inherited from knowledge_edit, but there the outcome
// is an edit and here it is DESTRUCTION.
//
// BLAST RADIUS (escalated LOW -> HIGH by outside-family review): the selector
// accepts feature_article object arrays OTHER than files[], and the
// last-element floor at tools.ts:2326 protects ONLY files[]. `history`,
// `current_ac` and `live_test_refs` have no floor
// (packages/schemas/src/records.ts:73, :125, :126), so where one of them holds
// exactly one element, `[bogus=undefined]` destroys that element — addressed
// by a property that does not exist on it — and empties the array.
// ===========================================================================

// ---------------------------------------------------------------------------
// B2 — CONTROL, PLACED FIRST. The fix must not become a blanket ban on the
// token `undefined`: a genuine string value "undefined" is still selectable.
// `role` is REQUIRED on every files[] element (knowledge_schema), so no
// element here can LACK it — which is what gives this arm exactly one
// possible cause: the selector can only mean the literal string.
// This must pass TODAY and keep passing.
// Sabotage: fix defect B by rejecting the literal token `undefined` outright
// — this control goes red immediately.
// ---------------------------------------------------------------------------
test('B2 (CONTROL, first): an element whose `role` is GENUINELY the string "undefined" IS still selectable and removable — the defect-B fix must not be a blanket ban on the token (defect B)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { path: 'src/literal.ts', role: 'undefined' },
      { path: 'src/keep.ts', role: 'sibling' },
    ];
    const article = mkArticle(tools, 'literal-undefined-role', original);
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.ok(
      before.files.every((f) => hasKey(f, 'role')),
      'PRECONDITION: `role` is required by the schema, so EVERY element carries it — the selector below can therefore only mean the literal string "undefined", never an absent key'
    );

    let result: ArrayRemoveResult | undefined;
    assert.doesNotThrow(() => {
      result = remover(tools).knowledgeArrayRemove(id, 'files[role=undefined]', before.version);
    }, 'a genuine "undefined" string value must remain selectable');

    assert.deepEqual(
      (result!.record as unknown as { files: Loose[] }).files,
      [original[1]],
      'exactly the element whose role IS "undefined" was removed'
    );
    const after = getArticle(tools, id);
    assert.deepEqual(after.files, [original[1]], 'persisted');
    assert.equal(after.version, before.version + 1, 'the successful path mints a version');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// B2b — CONTROL, also first. The other way a defect-B fix could over-reach:
// ignoring OPTIONAL keys altogether. `unverified` is optional
// (knowledge_schema), and matching on it by its real value must keep working.
// Sabotage: fix defect B by excluding optional/absent-capable keys from
// selector matching — this control goes red.
// ---------------------------------------------------------------------------
test('B2b (CONTROL, first): an OPTIONAL key that IS present still matches by its stringified value — the defect-B fix must not stop optional keys being selectable (defect B)', () => {
  const { tools, cleanup } = harness();
  try {
    const original: FileEntry[] = [
      { path: 'src/flagged.ts', role: 'the seam', unverified: true },
      { path: 'src/plain.ts', role: 'sibling' },
    ];
    const article = mkArticleRaw(tools, 'optional-key-present', { files: original });
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.equal(
      before.files.filter((f) => f.unverified === true).length,
      1,
      'PRECONDITION: exactly ONE element carries `unverified: true`, so the selector below is unambiguous and the AC8 ambiguity guard cannot be what decides this test'
    );

    let result: ArrayRemoveResult | undefined;
    assert.doesNotThrow(() => {
      result = remover(tools).knowledgeArrayRemove(id, 'files[unverified=true]', before.version);
    }, 'a present optional key must remain selectable by its real value');

    assert.deepEqual(
      (result!.record as unknown as { files: Loose[] }).files.map((f) => f.path),
      ['src/plain.ts'],
      'exactly the element carrying `unverified: true` was removed'
    );
    const after = getArticle(tools, id);
    assert.equal(after.version, before.version + 1, 'the successful path mints a version');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// B1 — the pin. `unverified` is optional, so an element LACKING it is
// reachable through the ordinary create surface with no implementation
// knowledge at all. EXACTLY ONE element lacks it, which is the single-cause
// guard: with two or more, the AC8 ambiguity refusal would satisfy this test
// for the WRONG reason, and the pin would be hollow.
// Sabotage: restore `String(el[key]) === value` — this test goes red.
// ---------------------------------------------------------------------------
test('B1: a selector whose value is the literal string `undefined` does NOT match elements that merely LACK the key — refused as ZERO matches, not a destruction; record UNCHANGED (defect B, tools.ts:2310)', () => {
  const { tools, cleanup } = harness();
  try {
    const original: FileEntry[] = [
      { path: 'src/a.ts', role: 'the seam', unverified: true },
      { path: 'src/b.ts', role: 'sibling', unverified: true },
      { path: 'src/c.ts', role: 'the third seam' }, // the ONLY element lacking `unverified`
    ];
    const article = mkArticleRaw(tools, 'key-absent-not-selectable', { files: original });
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.equal(
      before.files.filter((f) => !hasKey(f, 'unverified')).length,
      1,
      'PRECONDITION: EXACTLY ONE element lacks `unverified`. With two or more, the AC8 >1-match refusal would satisfy this test for the WRONG reason; a failure here means the store normalized the optional key and the fixture needs rebuilding, not that the defect is absent.'
    );
    assert.equal(
      before.files.filter((f) => f.unverified === true).length,
      2,
      'PRECONDITION: the other two genuinely carry the key, so `undefined` cannot be their stringified value'
    );

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(id, 'files[unverified=undefined]', before.version),
      (err: Error) => {
        assert.match(err.message, ZERO_MATCH_REFUSED, `an absent key matches NOTHING, so this is a zero-match refusal — got: "${err.message}"`);
        return true;
      },
      'a key-absent element must not be selectable by the literal string `undefined` — on a DESTROYING call that turns "the property does not exist" into "delete this element"'
    );

    const after = getArticle(tools, id);
    assert.deepEqual(after.files, before.files, 'the record is UNCHANGED — the key-absent element was not destroyed');
    assert.equal(after.version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// B3 — the destruction itself, stated separately from the refusal shape. Two
// elements only: removing one leaves one, so the AC11 last-file floor CANNOT
// be what refuses. That is this test's single-cause guard.
// Sabotage: restore `String(el[key]) === value` — src/vulnerable.ts vanishes.
// ---------------------------------------------------------------------------
test('B3: the single key-absent element SURVIVES — today `files[unverified=undefined]` silently destroys it; the whole files[] must come through byte-identical (defect B, tools.ts:2310)', () => {
  const { tools, cleanup } = harness();
  try {
    const original: FileEntry[] = [
      { path: 'src/kept.ts', role: 'carries the key', unverified: true },
      { path: 'src/vulnerable.ts', role: 'lacks the key' },
    ];
    const article = mkArticleRaw(tools, 'key-absent-not-destroyed', { files: original });
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.equal(before.files.length, 2, 'PRECONDITION: TWO files, so removing one would leave one and the AC11 last-file floor cannot be the cause of the refusal below');
    assert.equal(
      before.files.filter((f) => !hasKey(f, 'unverified')).length,
      1,
      'PRECONDITION: exactly one element lacks the key, so the AC8 ambiguity guard cannot be the cause either'
    );

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(id, 'files[unverified=undefined]', before.version),
      ZERO_MATCH_REFUSED,
      'the key-absent element must not be destroyed by a selector naming a property it does not have'
    );

    const after = getArticle(tools, id);
    assert.deepEqual(after.files, before.files, 'the whole files[] survives byte-identical');
    assert.ok(
      after.files.some((f) => f.path === 'src/vulnerable.ts'),
      'the key-absent element SURVIVES — this is the exact element the defect destroys today'
    );
    assert.equal(after.version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// B4/B5/B6 — CONTROLS, PLACED FIRST for the unfloored arrays. Each proves the
// array is removable AT ALL by a legitimate selector, so the B7/B8/B9
// refusals below cannot be satisfied by an implementation that simply refuses
// every non-files[] array. Each uses TWO elements, so no emptying question
// arises here (that is DECISION 4, pinned in B10/B11).
// Sabotage (all three): restrict knowledgeArrayRemove to `files` only — these
// go red while B7/B8/B9 stay green, which is precisely the wrong-reason pass
// they exist to expose.
// ---------------------------------------------------------------------------
test('B4 (CONTROL, first): a LEGITIMATE selector against a real key on `history` still removes exactly that entry — the defect-B fix must not become a ban on non-files[] arrays (defect B, widened scope)', () => {
  const { tools, cleanup } = harness();
  try {
    const history = [
      { date: NOW, event: 'seed' },
      { date: NOW, event: 'reconciled' },
    ];
    const article = mkArticleRaw(tools, 'history-legit-removal', { history });
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.doesNotThrow(() => {
      remover(tools).knowledgeArrayRemove(id, 'history[event=reconciled]', before.version);
    }, 'a real key with a real value must still select on `history`');

    assert.deepEqual(
      arrayField(tools, id, 'history').map((h) => h.event),
      ['seed'],
      'exactly the named history entry was removed, the sibling preserved'
    );
    assert.equal(getArticle(tools, id).version, before.version + 1, 'the successful path mints a version');
  } finally {
    cleanup();
  }
});

test('B5 (CONTROL, first): a LEGITIMATE selector against a real key on `current_ac` still removes exactly that entry (defect B, widened scope)', () => {
  const { tools, cleanup } = harness();
  try {
    const current_ac = [
      { ac_id: 'AC1', text: 'first criterion', verifiable_at: 'final' },
      { ac_id: 'AC2', text: 'second criterion', verifiable_at: 'final' },
    ];
    const article = mkArticleRaw(tools, 'current-ac-legit-removal', { current_ac });
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.doesNotThrow(() => {
      remover(tools).knowledgeArrayRemove(id, 'current_ac[ac_id=AC2]', before.version);
    }, 'a real key with a real value must still select on `current_ac`');

    assert.deepEqual(
      arrayField(tools, id, 'current_ac').map((a) => a.ac_id),
      ['AC1'],
      'exactly the named AC was removed, the sibling preserved'
    );
    assert.equal(getArticle(tools, id).version, before.version + 1, 'the successful path mints a version');
  } finally {
    cleanup();
  }
});

test('B6 (CONTROL, first): a LEGITIMATE selector against a real key on `live_test_refs` still removes exactly that entry (defect B, widened scope)', () => {
  const { tools, cleanup } = harness();
  try {
    const live_test_refs = [
      { ac_id: 'AC1', test_paths: ['src/tests/one.test.ts'] },
      { ac_id: 'AC2', test_paths: ['src/tests/two.test.ts'] },
    ];
    const article = mkArticleRaw(tools, 'live-test-refs-legit-removal', { live_test_refs });
    const id = article.id as string;
    const before = getArticle(tools, id);

    assert.doesNotThrow(() => {
      remover(tools).knowledgeArrayRemove(id, 'live_test_refs[ac_id=AC2]', before.version);
    }, 'a real key with a real value must still select on `live_test_refs`');

    assert.deepEqual(
      arrayField(tools, id, 'live_test_refs').map((r) => r.ac_id),
      ['AC1'],
      'exactly the named ref was removed, the sibling preserved'
    );
    assert.equal(getArticle(tools, id).version, before.version + 1, 'the successful path mints a version');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// B7/B8/B9 — THE HIGH-SEVERITY PINS. A single-element unfloored array, a
// selector naming a property NO element has. Today each of these destroys the
// element and empties the array; nothing stops it, because the last-element
// floor at tools.ts:2326 covers files[] only.
// Single-cause guards in every one: exactly ONE element (so the AC8 ambiguity
// guard cannot refuse), NO element carries `bogus` (so a real match cannot
// occur), files[] left at its 2-element default (so the AC11 floor is not
// involved), and the B4/B5/B6 controls above prove the array is removable at
// all (so a blanket non-files refusal cannot be what passes these).
// Sabotage (all three): restore `String(el[key]) === value` — each single
// element is destroyed and its array goes empty.
// ---------------------------------------------------------------------------
for (const { field, seedKey, seed } of [
  {
    field: 'history',
    seedKey: 'event',
    seed: [{ date: NOW, event: 'seed' }],
  },
  {
    field: 'current_ac',
    seedKey: 'ac_id',
    seed: [{ ac_id: 'AC1', text: 'the only criterion', verifiable_at: 'final' }],
  },
  {
    field: 'live_test_refs',
    seedKey: 'ac_id',
    seed: [{ ac_id: 'AC1', test_paths: ['src/tests/only.test.ts'] }],
  },
] as const) {
  test(`B7-B9 (${field}): a single-element UNFLOORED array is NOT destroyed by \`${field}[bogus=undefined]\` — a property NO element has must match NOTHING, refused as zero matches; record UNCHANGED (defect B, widened scope: tools.ts:2310 + the files[]-only floor at tools.ts:2326)`, () => {
    const { tools, cleanup } = harness();
    try {
      const article = mkArticleRaw(tools, `unfloored-${field.replace(/_/g, '-')}`, { [field]: seed });
      const id = article.id as string;
      const before = getArticle(tools, id);
      const beforeArray = arrayField(tools, id, field);

      assert.equal(beforeArray.length, 1, `PRECONDITION: \`${field}\` holds EXACTLY ONE element — with two, the AC8 ambiguity refusal would satisfy this test for the WRONG reason`);
      assert.equal(
        beforeArray.filter((el) => hasKey(el, 'bogus')).length,
        0,
        `PRECONDITION: NO element carries \`bogus\`, so a legitimate match is impossible and the only way the call can succeed is the absent-key defect`
      );
      assert.equal(before.files.length, 2, 'PRECONDITION: files[] is untouched at two entries, so the AC11 last-file floor is not involved in this refusal');

      assert.throws(
        () => remover(tools).knowledgeArrayRemove(id, `${field}[bogus=undefined]`, before.version),
        (err: Error) => {
          assert.match(err.message, ZERO_MATCH_REFUSED, `a property no element has matches nothing — got: "${err.message}"`);
          return true;
        },
        `\`${field}[bogus=undefined]\` must refuse: addressing an element by a property it does not have is not a selection, and on a DESTROYING call with no floor beneath it, it empties the array`
      );

      const afterArray = arrayField(tools, id, field);
      assert.deepEqual(afterArray, beforeArray, `\`${field}\` is UNCHANGED — its sole element survives`);
      assert.equal(afterArray.length, 1, `\`${field}\` was not emptied by a selector naming a nonexistent property`);
      assert.equal(
        String(afterArray[0][seedKey]),
        String((seed[0] as Record<string, unknown>)[seedKey]),
        `the surviving element is the original one, identified by its \`${seedKey}\``
      );
      assert.equal(getArticle(tools, id).version, before.version, 'no version minted by the refused call');
    } finally {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// B10 / B11 — DECISION 4 (see the decisions block above): which arrays may be
// EMPTIED by a legitimate removal. This is the adjacent question the defect
// reports did not ask, decided here rather than discovered later.
//
// B10 pins the REFUSAL for `history` (an article that has forgotten what
// happened to it is not a valid article — and an audit trail that a
// destroying call can delete is the root case of the anti-pattern governing
// this territory). RED today: there is no floor on history.
//
// B11 pins the OPPOSITE for `current_ac` / `live_test_refs`, and it is the
// control that stops B10 from being generalized into a floor on every array:
// both are PROVEN birth-legal-empty by this file's own mkArticle(), which
// creates every AC6-AC11 article with them empty. GREEN today, and it must
// stay green — a fix that floors all four arrays breaks it.
// Sabotage for B10: omit the history floor — the sole entry is destroyed.
// Sabotage for B11: extend the files[] floor to every object array — B11 goes
// red while B10 stays green.
// ---------------------------------------------------------------------------
test('B10 (DECISION 4): removing the LAST `history` entry is REFUSED even by a fully legitimate selector — history is the record\'s audit trail, it is not birth-legal-empty, and a destroying call that can delete the audit trail is the root case of no-bounded-trail-guard-for-destructive-addressing; record UNCHANGED (defect B, adjacent question)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticleRaw(tools, 'history-floor', { history: [{ date: NOW, event: 'seed' }] });
    const id = article.id as string;
    const before = getArticle(tools, id);
    const beforeHistory = arrayField(tools, id, 'history');

    assert.equal(beforeHistory.length, 1, 'PRECONDITION: `history` holds exactly one entry, so this removal would empty it');

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(id, 'history[event=seed]', before.version),
      (err: Error) => {
        assert.match(err.message, LAST_ELEMENT_FLOOR_REFUSED, `the refusal must name the floor, the way AC11 does for files[] — got: "${err.message}"`);
        assert.doesNotMatch(
          err.message,
          ZERO_MATCH_REFUSED,
          'this selector MATCHES — it is refused by the floor, not by a failure to select; a zero-match message here would mean the fix broke legitimate history selection instead of flooring it'
        );
        return true;
      },
      'emptying the audit trail through a destroying call must be refused'
    );

    assert.deepEqual(arrayField(tools, id, 'history'), beforeHistory, '`history` is UNCHANGED — the sole entry survives');
    assert.equal(getArticle(tools, id).version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

test('B11 (DECISION 4, CONTROL): removing the LAST `current_ac` / `live_test_refs` entry is ALLOWED — both are PROVEN birth-legal-empty by this file\'s own mkArticle(), so a removal returning the article to a state it could have been created in must not be floored; the B10 floor must not generalize (defect B, adjacent question)', () => {
  for (const { field, selector } of [
    { field: 'current_ac', selector: 'current_ac[ac_id=AC1]' },
    { field: 'live_test_refs', selector: 'live_test_refs[ac_id=AC1]' },
  ]) {
    const { tools, cleanup } = harness();
    try {
      const seed =
        field === 'current_ac'
          ? [{ ac_id: 'AC1', text: 'the only criterion', verifiable_at: 'final' }]
          : [{ ac_id: 'AC1', test_paths: ['src/tests/only.test.ts'] }];
      const article = mkArticleRaw(tools, `empty-legal-${field.replace(/_/g, '-')}`, { [field]: seed });
      const id = article.id as string;
      const before = getArticle(tools, id);

      assert.equal(arrayField(tools, id, field).length, 1, `PRECONDITION: \`${field}\` holds exactly one element, so this removal empties it`);

      assert.doesNotThrow(() => {
        remover(tools).knowledgeArrayRemove(id, selector, before.version);
      }, `emptying \`${field}\` must be ALLOWED — mkArticle() creates every article in this file with it empty, so the empty state is one an article can be born in; making it reachable by creation but not by removal would be a floor invented by a bug fix rather than by the schema`);

      assert.deepEqual(arrayField(tools, id, field), [], `\`${field}\` is now empty, which is a valid article state`);
      assert.equal(getArticle(tools, id).version, before.version + 1, 'the successful path mints a version');
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// SCALAR-DISCRIMINATOR RULE (user-approved hardening, NOT YET BUILT) — SD1-SD5
// ===========================================================================
// SPEC (given, not derived from the code under test): the selector key in
// `field[key=value]` must be a SCALAR discriminator (string/number/boolean)
// across the WHOLE named array — not merely at the matched element. If ANY
// element of the named array OWNS the key with a defined non-scalar value (an
// object or an array), the call is REFUSED loudly, regardless of whether that
// element or any other would have matched the selector's value — because
// non-scalar values compare lossily as strings ("[object Object]", a
// comma-joined array), which must never be allowed to address a destroy.
// Elements that do not own the key at all (or own it as `undefined`) remain
// simple non-matches, exactly as today; the existing zero/multi-match
// refusals (AC7/AC8) are unchanged.
//
// THE ONE PLACE THIS FILE FIXES THE UNDECIDED WORDING: the SPEC dictates WHAT
// the refusal must teach (the key, the count of non-scalar-carrying elements,
// and that addressing is scalar-only, naming string/number/boolean) but not
// its exact prose. assertScalarDiscriminatorMessage() below is that decision,
// as a forgiving multi-assertion (same convention as FULL_UUID_REQUIRED and
// the DECISION 1-4 regexes above) — an implementer who prefers different
// wording changes the message so it still says "scalar", still names
// string/number/boolean, still names the key, still names the count.
//
// Every SD test asserts the record is UNCHANGED (body deep-equal, version
// unchanged) — a refusal that writes nothing is the feature, not the happy
// path.
// ---------------------------------------------------------------------------
function assertScalarDiscriminatorMessage(message: string, key: string, count: number): void {
  assert.match(message, /scalar/i, `refusal must characterize the rule as scalar-based — got: "${message}"`);
  assert.match(message, /string/i, `refusal must name string as an accepted scalar type — got: "${message}"`);
  assert.match(message, /number/i, `refusal must name number as an accepted scalar type — got: "${message}"`);
  assert.match(message, /boolean/i, `refusal must name boolean as an accepted scalar type — got: "${message}"`);
  assert.match(
    message,
    new RegExp(`\\b${key}\\b`),
    `refusal must name the offending key ("${key}") — got: "${message}"`
  );
  assert.match(
    message,
    new RegExp(`\\b${count}\\b`),
    `refusal must name the count of non-scalar-carrying elements (${count}) — got: "${message}"`
  );
}

// ---------------------------------------------------------------------------
// SD4 (CONTROL, PLACED FIRST). Without this, SD1/SD2/SD3 are all satisfied by
// an implementation that simply refuses every removal, or refuses whenever
// the selector key is anything other than a hardcoded name. This uses the
// EXACT SAME field/key as SD3 below (current_ac / ac_id) — a clean minimal
// pair differing only in whether one sibling element is non-scalar — so a
// green SD4 alongside a red-today SD3 can only be explained by the value's
// TYPE, never by the key's NAME.
// Sabotage: make knowledgeArrayRemove refuse unconditionally (or refuse
// whenever any optional/typed field is present) — SD1/SD2/SD3 would stay
// (correctly) refused, and only SD4 goes red, which is exactly the
// wrong-reason pass this control exists to catch.
// ---------------------------------------------------------------------------
test('SD4 (CONTROL, first): an array where every element carries a purely SCALAR value under the selector key still removes exactly the matched element — the scalar-discriminator guard is additive, not a blanket refusal (same field/key as SD3: current_ac/ac_id)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { ac_id: 'AC1', text: 'first criterion', verifiable_at: 'final' },
      { ac_id: 'AC2', text: 'second criterion', verifiable_at: 'final' },
      { ac_id: 'AC3', text: 'third criterion', verifiable_at: 'final' },
    ];
    const article = mkArticleRaw(tools, 'sd4-all-scalar-control', { current_ac: original });
    const id = article.id as string;
    const before = getRecord(tools, id);

    assert.ok(
      (before.current_ac as Loose[]).every((e) => typeof e.ac_id === 'string'),
      'PRECONDITION: every element carries ac_id as a plain string — no non-scalar owner anywhere in this array'
    );

    let result: ArrayRemoveResult | undefined;
    assert.doesNotThrow(() => {
      result = remover(tools).knowledgeArrayRemove(id, 'current_ac[ac_id=AC2]', before.version as number);
    }, 'an all-scalar array must still permit removal — the new guard must not become a blanket refusal');

    assert.deepEqual(
      ((result!.record as unknown as { current_ac: Loose[] }).current_ac).map((e) => e.ac_id),
      ['AC1', 'AC3'],
      'exactly the matched element was removed, siblings byte-preserved and in order'
    );
    const after = getRecord(tools, id);
    assert.deepEqual(after.current_ac, [original[0], original[2]], 'persisted, byte-identical siblings');
    assert.equal(after.version, (before.version as number) + 1, 'the successful path mints a version');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SD1 — the direct case: one element OWNS the selector key with an OBJECT
// value. `current_ac[].untestable_because` is a genuinely schema-typed object
// field ({reason, blocking_record_id}), so no store-proxy patching is needed
// — the object survives the ordinary, schema-validated create surface as-is.
// Sabotage: keep today's `String(el[key]) === value` comparison with no
// non-scalar ownership pre-check — this test goes red (the call succeeds and
// deletes AC1).
// ---------------------------------------------------------------------------
test('SD1: a selector key that is an OBJECT on at least one element is REFUSED, naming the key and the count — regardless of whether the naive stringified value would have matched (RED today: "[object Object]" string-compares as a clean single match and deletes it)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      {
        ac_id: 'AC1',
        text: 'first criterion',
        verifiable_at: 'final',
        untestable_because: { reason: 'blocked upstream', blocking_record_id: '00000000-0000-0000-0000-000000000000' },
      },
      { ac_id: 'AC2', text: 'second criterion', verifiable_at: 'final' },
    ];
    const article = mkArticleRaw(tools, 'sd1-object-valued-key', { current_ac: original });
    const id = article.id as string;
    const before = getRecord(tools, id);
    const beforeAc = before.current_ac as Loose[];

    assert.deepEqual(
      beforeAc[0].untestable_because,
      original[0].untestable_because,
      'PRECONDITION: the object survives creation untouched — this is a genuinely schema-typed field, no patching needed'
    );
    assert.ok(
      !hasKey(beforeAc[1], 'untestable_because'),
      'PRECONDITION: the sibling does not own the key at all — it must remain a simple non-match, never counted'
    );

    assert.throws(
      () => remover(tools).knowledgeArrayRemove(id, 'current_ac[untestable_because=[object Object]]', before.version as number),
      (err: Error) => {
        assertScalarDiscriminatorMessage(err.message, 'untestable_because', 1);
        return true;
      },
      'an object-valued key must refuse the destroy outright, even though naive stringification makes AC1 look like a clean single match'
    );

    const after = getRecord(tools, id);
    assert.deepEqual(after.current_ac, before.current_ac, 'record UNCHANGED — the refusal writes nothing');
    assert.equal(after.version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SD2 — the same refusal shape for an ARRAY-valued key. `test_paths` is
// REQUIRED on every `live_test_refs` element, so BOTH elements here own it as
// an array — a count of 2, distinct from SD1's count of 1.
// Sabotage: same as SD1 — this test goes red (the call succeeds and deletes
// the first entry via comma-joined string comparison).
// ---------------------------------------------------------------------------
test('SD2: a selector key that is an ARRAY on multiple elements is REFUSED the same way as an object-valued key, naming the count across BOTH owners (RED today: comma-joined string-compares as a clean single match and deletes it)', () => {
  const { tools, cleanup } = harness();
  try {
    const original = [
      { ac_id: 'AC1', test_paths: ['src/tests/one.test.ts', 'src/tests/two.test.ts'] },
      { ac_id: 'AC2', test_paths: ['src/tests/three.test.ts'] },
    ];
    const article = mkArticleRaw(tools, 'sd2-array-valued-key', { live_test_refs: original });
    const id = article.id as string;
    const before = getRecord(tools, id);
    const beforeRefs = before.live_test_refs as Loose[];

    assert.ok(Array.isArray(beforeRefs[0].test_paths), 'PRECONDITION: test_paths is genuinely an array field, no patching needed');
    assert.ok(Array.isArray(beforeRefs[1].test_paths), 'PRECONDITION: the sibling ALSO owns it as an array — both elements are non-scalar owners');

    assert.throws(
      () =>
        remover(tools).knowledgeArrayRemove(
          id,
          'live_test_refs[test_paths=src/tests/one.test.ts,src/tests/two.test.ts]',
          before.version as number
        ),
      (err: Error) => {
        assertScalarDiscriminatorMessage(err.message, 'test_paths', 2);
        return true;
      },
      'an array-valued key must refuse the destroy outright, even though naive stringification makes AC1 look like a clean single match'
    );

    const after = getRecord(tools, id);
    assert.deepEqual(after.live_test_refs, before.live_test_refs, 'record UNCHANGED — the refusal writes nothing');
    assert.equal(after.version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SD3 — the subtle case: the selector EXACTLY string-matches a SCALAR
// element's unique value, but a DIFFERENT element in the SAME array owns the
// SAME key with a non-scalar value. The key is unsound for the array as a
// whole, so the refusal must fire even though the matched element itself is
// perfectly scalar.
//
// REACHING THE STATE: `current_ac[].ac_id` is always `string` by schema, so
// "one element's ac_id is an object" is not reachable through the ordinary,
// schema-validated create surface — exactly the situation A1's
// versionlessHarness above solves for `version`. elementPatchHarness()
// generalizes that same technique (a Proxy around the declared store
// constructor parameter, reshaping only the target slug's record on the way
// out, binding every call back to the real store, touching no other slug and
// no class instance) to patch ONE named field of ONE element, identified by a
// second, untouched key.
//
// The PRECONDITION assertions are load-bearing exactly as in A1: a failure
// there means "fix the harness", a failure on the throws() means "the rule is
// not enforced".
//
// Sabotage: keep today's `String(el[key]) === value` comparison scoped to
// only the MATCHED element (i.e., check only the element the value equals,
// never scan the array's OTHER elements for non-scalar ownership) — this test
// goes red while SD1/SD2/SD4 stay green, which is exactly the
// under-inclusive bug this test exists to catch.
// ---------------------------------------------------------------------------
function elementPatchHarness(slug: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-array-remove-ep-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  let patch: { field: string; anchorKey: string; anchorValue: string; patchKey: string; patchValue: unknown } | null = null;

  const apply = (value: unknown, depth = 0): unknown => {
    if (depth > 8 || value === null || value === undefined || !patch) return value;
    if (typeof value === 'string') {
      if (value.includes(`"slug":"${slug}"`) && value.includes(`"${patch.field}"`)) {
        try {
          return JSON.stringify(apply(JSON.parse(value), depth + 1));
        } catch {
          return value;
        }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => apply(v, depth + 1));
    if (typeof value !== 'object') return value;
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = apply(v, depth + 1);
    const field = patch.field;
    if (out.slug === slug && Array.isArray(out[field])) {
      out[field] = (out[field] as Loose[]).map((el) =>
        el && typeof el === 'object' && (el as Loose)[patch!.anchorKey] === patch!.anchorValue
          ? { ...el, [patch!.patchKey]: patch!.patchValue }
          : el
      );
    }
    return out;
  };

  const proxied = new Proxy(store, {
    get(target, prop) {
      const value = (target as unknown as Record<string | symbol, unknown>)[prop as string];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => apply((value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });

  const tools = new SterlingTools({ store: proxied, now: () => NOW });
  return {
    tools,
    setPatch: (p: { field: string; anchorKey: string; anchorValue: string; patchKey: string; patchValue: unknown }) => {
      patch = p;
    },
    clearPatch: () => {
      patch = null;
    },
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('SD3: a selector that EXACTLY string-matches a SCALAR element is still REFUSED when a DIFFERENT element in the same array owns the SAME key with a non-scalar value — the discriminator is unsound for the array as a whole, not merely for the matched element (RED today: current behavior removes the scalar match)', () => {
  const SLUG = 'sd3-mixed-soundness';
  const h = elementPatchHarness(SLUG);
  try {
    const article = h.tools.knowledgeCreate('feature_article', {
      slug: SLUG,
      title: SLUG,
      what_it_does: 'does things',
      intended_behavior: 'intends things',
      files: [
        { path: 'src/a.ts', role: 'the seam' },
        { path: 'src/b.ts', role: 'sibling' },
      ],
      current_ac: [
        { ac_id: 'AC1', text: 'first criterion', verifiable_at: 'final' },
        { ac_id: 'AC2', text: 'second criterion', verifiable_at: 'final' },
        { ac_id: 'AC3-TO-CORRUPT', text: 'third criterion, patched post-create', verifiable_at: 'final' },
      ],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    }).record as unknown as Loose;
    const id = article.id as string;
    const trueBefore = getRecord(h.tools, id);

    h.setPatch({
      field: 'current_ac',
      anchorKey: 'text',
      anchorValue: 'third criterion, patched post-create',
      patchKey: 'ac_id',
      patchValue: { corrupted: true },
    });

    const seen = getRecord(h.tools, id);
    const seenAc = seen.current_ac as Loose[];
    assert.equal(seenAc.length, 3, 'PRECONDITION (harness): all three elements survive the patch');
    assert.deepEqual(
      seenAc[2].ac_id,
      { corrupted: true },
      'PRECONDITION (harness, not the pin): the third element must be SEEN carrying a non-scalar ac_id. A failure HERE means the patch proxy did not reach the value the tools layer reads — fix the harness; it does not mean the rule is unenforced.'
    );
    assert.equal(seenAc[0].ac_id, 'AC1', 'PRECONDITION: the sibling ac_id is untouched by the patch');
    assert.equal(seenAc[1].ac_id, 'AC2', 'PRECONDITION: the selector will exactly string-match this element by itself');

    assert.throws(
      () => remover(h.tools).knowledgeArrayRemove(id, 'current_ac[ac_id=AC2]', trueBefore.version as number),
      (err: Error) => {
        assertScalarDiscriminatorMessage(err.message, 'ac_id', 1);
        return true;
      },
      'AC2 alone is a clean scalar match, but AC3 owns the SAME key as a non-scalar — the array-wide soundness check must still refuse'
    );

    h.clearPatch();
    const trueAfter = getRecord(h.tools, id);
    assert.deepEqual(
      trueAfter.current_ac,
      trueBefore.current_ac,
      'record UNCHANGED (compared against the TRUE stored data, not the patched read-time view) — the refusal writes nothing'
    );
    assert.equal(trueAfter.version, trueBefore.version, 'no version minted by the refused call');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SD5 — the MCP-SURFACE required-token pin. Through the REGISTERED server
// schema/handler (a client → server round trip, not a direct method cast on
// SterlingTools), an omitted expected_version must be rejected by the zod
// layer BEFORE the handler/method runs at all — the same wire-only
// discrimination server.test.ts's own "unknown parameter" pins rely on (a
// stripped/skipped parameter at the SDK's own parse step is invisible to any
// unit test that calls the method directly).
//
// This is a REGRESSION pin, not a red-today pin: server.ts already declares
// expected_version as `.int().positive()` per the existing DECISION 1/A1/A2
// commentary above, so an omitted token is expected to be refused ALREADY.
// Report its color rather than assuming — it exists so that someone loosening
// that declaration to optional sees THIS go red.
// Sabotage: change `expected_version: z.number().int().positive()` to
// `.optional()` in server.ts's knowledge_array_remove schema — this test goes
// red (the call is no longer refused at the wire).
// ---------------------------------------------------------------------------
async function mcpHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-array-remove-mcp-'));
  const { server, store } = createSterlingServer(join(dir, 'sterling.db'));
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const cleanup = async () => {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { client, cleanup };
}

function mcpPayload(result: unknown): Loose {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

test('SD5: through the REGISTERED MCP surface, an OMITTED expected_version on knowledge_array_remove is REJECTED by the zod schema before the handler runs (regression pin — may be GREEN today; report its color)', async () => {
  const { client, cleanup } = await mcpHarness();
  try {
    const created = mcpPayload(
      await client.callTool({
        name: 'knowledge_create',
        arguments: {
          type: 'feature_article',
          fields: {
            type: 'feature_article',
            slug: 'sd5-mcp-required-token',
            title: 'sd5-mcp-required-token',
            what_it_does: 'does things',
            intended_behavior: 'intends things',
            files: [
              { path: 'src/a.ts', role: 'the seam' },
              { path: 'src/b.ts', role: 'sibling' },
            ],
            current_ac: [],
            dependencies: { relies_on: [], relied_by: [] },
            state: 'active',
            history: [{ date: NOW, event: 'seed' }],
            live_test_refs: [],
          },
          projection: 'full',
        },
      })
    ) as unknown as { record: { id: string } };
    const id = created.record.id;

    const omitted = await client.callTool({
      name: 'knowledge_array_remove',
      arguments: { id, selector: 'files[path=src/b.ts]' }, // expected_version deliberately OMITTED
    });
    assert.equal(
      omitted.isError,
      true,
      'an omitted expected_version must be rejected in-band — a destroying call with no stated token must never reach the handler'
    );
    const text = (omitted.content as { text: string }[])[0].text;
    assert.match(text, /expected_version/, `the refusal must name the missing parameter — got: "${text}"`);
    assert.match(
      text,
      /required|invalid_type/i,
      `the refusal is a zod validation error (required/invalid_type), not a tool-logic error — got: "${text}"`
    );

    const reread = mcpPayload(await client.callTool({ name: 'knowledge_get', arguments: { id } }));
    assert.deepEqual(
      reread.files,
      [
        { path: 'src/a.ts', role: 'the seam' },
        { path: 'src/b.ts', role: 'sibling' },
      ],
      'the record is UNCHANGED — the omitted-token call never landed'
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// SD6 — the NULL-valued discriminator case. `typeof null === 'object'`, so a
// naive "is it an object" ownership check already catches it — but the
// tempting SHORTCUT is a predicate that reads `typeof rec[key] === 'object'
// && rec[key] !== null`, on the reasoning that "null isn't REALLY an object".
// That shortcut is wrong here: `String(null)` is the literal string `'null'`,
// which COLLIDES with a genuine string element whose value happens to be the
// literal text "null" — exactly the same lossy-stringification hazard SD1/SD2
// exist to close for objects/arrays. So the spec's disposition is: an OWNED
// null value is NON-scalar, full stop, and it is INCLUDED in the named count
// exactly like an object or array owner.
//
// REACHING THE STATE: `current_ac[].ac_id` is `string` by schema, so a null
// value there is not reachable through the ordinary, schema-validated create
// surface — the same reason SD3 needed elementPatchHarness() rather than a
// plain create. This reuses that exact harness, patching ONE element's ac_id
// to `null` post-create (anchored on an untouched sibling key), with the same
// load-bearing PRECONDITION assert SD3 uses: a failure there means "fix the
// harness", a failure on the throws() means "the rule is not enforced".
//
// Sabotage (named in the dispatch brief): change the ownership predicate from
// `typeof rec[key] === 'object'` to `rec[key] !== null && typeof rec[key] ===
// 'object'` — this test goes red (the null-owning element's string collision
// makes the call look like a clean single match and it is destroyed).
// ---------------------------------------------------------------------------
test('SD6: a selector key that is NULL on one element is REFUSED the same way as an object/array-valued key, the null owner INCLUDED in the named count — null is non-scalar (typeof null === "object"; String(null) === "null" collides with the literal string value) (RED under a `!== null` carve-out: the null owner would then string-compare as a clean match and be destroyed)', () => {
  const SLUG = 'sd6-null-valued-key';
  const h = elementPatchHarness(SLUG);
  try {
    const article = h.tools.knowledgeCreate('feature_article', {
      slug: SLUG,
      title: SLUG,
      what_it_does: 'does things',
      intended_behavior: 'intends things',
      files: [
        { path: 'src/a.ts', role: 'the seam' },
        { path: 'src/b.ts', role: 'sibling' },
      ],
      current_ac: [
        { ac_id: 'AC1', text: 'first criterion', verifiable_at: 'final' },
        { ac_id: 'AC2', text: 'second criterion', verifiable_at: 'final' },
        { ac_id: 'AC3-TO-NULL', text: 'third criterion, patched post-create', verifiable_at: 'final' },
      ],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    }).record as unknown as Loose;
    const id = article.id as string;
    const trueBefore = getRecord(h.tools, id);

    h.setPatch({
      field: 'current_ac',
      anchorKey: 'text',
      anchorValue: 'third criterion, patched post-create',
      patchKey: 'ac_id',
      patchValue: null,
    });

    const seen = getRecord(h.tools, id);
    const seenAc = seen.current_ac as Loose[];
    assert.equal(seenAc.length, 3, 'PRECONDITION (harness): all three elements survive the patch');
    assert.ok(
      hasKey(seenAc[2], 'ac_id') && seenAc[2].ac_id === null,
      'PRECONDITION (harness, not the pin): the third element must be SEEN OWNING ac_id with value null (not merely absent). A failure HERE means the patch proxy did not reach the value the tools layer reads — fix the harness; it does not mean the rule is unenforced.'
    );
    assert.equal(seenAc[0].ac_id, 'AC1', 'PRECONDITION: the sibling ac_id is untouched by the patch');
    assert.equal(seenAc[1].ac_id, 'AC2', 'PRECONDITION: the selector will exactly string-match this element by itself');

    assert.throws(
      () => remover(h.tools).knowledgeArrayRemove(id, 'current_ac[ac_id=AC2]', trueBefore.version as number),
      (err: Error) => {
        assertScalarDiscriminatorMessage(err.message, 'ac_id', 1);
        return true;
      },
      'AC2 alone is a clean scalar match, but AC3 owns the SAME key as null — a non-scalar owner regardless of the `!== null` shortcut — so the array-wide soundness check must still refuse'
    );

    h.clearPatch();
    const trueAfter = getRecord(h.tools, id);
    assert.deepEqual(
      trueAfter.current_ac,
      trueBefore.current_ac,
      'record UNCHANGED (compared against the TRUE stored data, not the patched read-time view) — the refusal writes nothing'
    );
    assert.equal(trueAfter.version, trueBefore.version, 'no version minted by the refused call');
  } finally {
    h.cleanup();
  }
});
