import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, MountedStores } from '@sterling/store';
import { SterlingTools } from '../tools.js';
import { harnessMounted as harnessMountedShared } from './test-helpers/mounted-harness.js';

// APPEND-JOIN ADMISSION for `article_missing` — a new resolvable lane on top
// of the resolves-claim contract already pinned in resolves-claim.test.ts /
// resolves-claim-update-lanes.test.ts (decision
// 68988832-2ef5-4ff3-b693-4f0f0ea8dae1). Subject: `validateResolveClaim` /
// `APPEND_JOIN_RESOLVABLE_LANE` in packages/mcp-server/src/tools.ts
// (~5084-5215).
//
// SPEC (as briefed, authoritative over the implementation — a red pin here
// means the code has a defect, not that the test is wrong): an
// `article_missing` maintenance item is keyed to a feature_article by
// file_keys, not by feature_link identity the way reconcile_needed items are.
// It closes when a `knowledge_append` call targets that article's `files[]`
// field AND at least one of the NEWLY appended entries' normalized path
// equals one of the item's `file_keys` — i.e. the append itself is the
// evidence the article now owns the file the item complained was unowned.
// This is deliberately narrower than the existing resolves-claim core:
//   - only `files[]` appends qualify (not `history`/`current_ac` appends,
//     and not `knowledge_update` at all — those lanes have no append-join
//     evidence to check against)
//   - only a path NOT already present before the call counts — an append
//     that merely repeats an already-owned path proves nothing new
//
// This file does NOT edit resolves-claim.test.ts or
// resolves-claim-update-lanes.test.ts — new, separate suite, same harness
// idiom (widen() cast, openIds() via maintenanceQuery, mkArticle()).
//
// EXECUTION DISCLOSURE: this agent has no Bash and cannot run these tests;
// the conductor's red/mutation gate executes them. Per-test expected failure
// shape and named sabotage are stated in the comment above each test.
//
// REBUILD (2026-09-05/06): the append-join discharge is being rewritten as
// ONE ATOMIC STATE TRANSITION per decision
// `append-join-discharge-rebuilt-as-one-atomic-transition` (knowledge_get
// 26e8f8ac-e0c7-4206-b0ee-640583eb9e87) — the frozen attack set from that
// decision's four fix rounds is the spec arms 7/11/11b/13-17 below answer to.
// That decision is authoritative over this comment where the two differ.

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-append-join-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

const mkArticle = (tools: SterlingTools, slug: string, paths: string[]) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: paths.map((path) => ({ path, role: 'impl' })),
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record;

type Resolving = {
  knowledgeUpdate(id: string, patch: Record<string, unknown>, resolves?: string[]): unknown;
  knowledgeAppend(
    id: string,
    field: string,
    values: unknown[],
    resolves?: string[]
  ): { record: Record<string, unknown>; warnings: string[] };
};
const widen = (tools: SterlingTools) => tools as unknown as Resolving;

function openIds(tools: SterlingTools): string[] {
  return (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);
}

function idOf(result: unknown): string | undefined {
  const r = result as { removed?: string; id?: string };
  return r.removed ?? r.id;
}

type OpenItem = { id: string; file_keys?: string[]; text: string; system_reason?: string };

function openItemsFull(tools: SterlingTools): OpenItem[] {
  return tools.maintenanceQuery({ cap: 1000 }) as unknown as OpenItem[];
}

function findItem(tools: SterlingTools, id: string): OpenItem | undefined {
  return openItemsFull(tools).find((i) => i.id === id);
}

/** Same as mkArticle, plus an optional `working_tree` declaration. */
const mkArticleWT = (tools: SterlingTools, slug: string, paths: string[], workingTree: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: paths.map((path) => ({ path, role: 'impl' })),
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    working_tree: workingTree,
  }).record;

/** A reference_material record naming `location` as the sole owned path. */
const mkReference = (tools: SterlingTools, title: string, location: string) =>
  tools.knowledgeCreate('reference_material', {
    title,
    kind: 'doc',
    location,
    summary: 'ref',
    source_date: '2026-01-01',
    capture_date: '2026-01-01',
  }).record;

/** Same as mkArticle, but sets an explicit `scope` — used to pin the
 *  target-scope refusal (project-only append-join admission) and the
 *  project-local owner-lookup boundary. */
const mkArticleScoped = (tools: SterlingTools, slug: string, paths: string[], scope: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: paths.map((path) => ({ path, role: 'impl' })),
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    scope,
  }).record;

/**
 * Extracts every "N file(s)" occurrence from a maintenance item's text, in
 * order, as the bare integers found. This is the SEMANTIC probe the rebuild
 * arms use to check a REGENERATED text for internal consistency (no stale
 * total, an unrelated historical count left untouched, the true current
 * count stated) without assuming any more specific wording, suffix shape, or
 * patch mechanism than the literal digits-adjacent-to-"file(s)" substring —
 * deliberately the loosest check that can still catch a stale/contradictory
 * count.
 */
function fileCountTokens(text: string): number[] {
  return [...text.matchAll(/(\d+)\s*file\(s\)/gi)].map((m) => Number(m[1]));
}

/**
 * The REAL production `article_missing` text shape (copied verbatim off a
 * live maintenance queue): "article missing: N file(s) ..." with the file
 * count leading, NO path enumeration in the prose (paths live only in
 * file_keys), and a trailing pointer to the H10/accretion section. Used as a
 * fixture baseline across the multi-key arms below.
 *
 * NOTE ON THE REBUILD: this suite pins what a partial close's REGENERATED
 * text must MEAN (no stale total survives, an unrelated historical count is
 * left untouched, the current remaining count is stated), never HOW the
 * rebuild produces it — no assertion here assumes a specific regex anchor, a
 * patched-in-place count, or any particular suffix wording. The
 * 'text-shape fallback' arm below deliberately uses a DIFFERENT,
 * non-canonical text shape for exactly this reason: canonical-shape
 * recognition must not be a precondition for correctness.
 */
const productionArticleMissingText = (n: number) =>
  `article missing: ${n} file(s) nothing owns (feature_article or repo-located reference doc) (${n} newly created) — create the owning article(s) (§6 H10 / §12 accretion)`;

// --------------------------------------------------------------------------
// CONTROL (placed first): proves the append-join admission actually
// discriminates on path membership rather than draining any article_missing
// item whenever ANY files[] append happens on the linked article. Must PASS
// for the OPPOSITE reason from the closure pins below: an append that does
// NOT touch the item's missing path leaves it open.
// --------------------------------------------------------------------------

test('CONTROL: knowledge_append to files[] with resolves, where the appended path does NOT match the item file_keys, refuses — proves the join checks path membership, not "an append happened"', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not own src/thing-owner.ts`,
      file_keys: ['src/thing-owner.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/unrelated.ts', role: 'impl' }], [item.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        assert.match(err.message, /article_missing/, 'names the article_missing lane');
        return true;
      },
      'an append whose new path does not match the item\'s file_keys must not silently drain it'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the article_missing admission drain the item on ANY
// files[]-targeted append to the linked article, regardless of whether the
// appended path matches file_keys (drop the path-membership check) — this
// control goes red (the throw no longer fires; the item drains on an
// unrelated append).

// --------------------------------------------------------------------------
// 1. CLOSURE: an appended path matching a file_keys entry drains the item.
// --------------------------------------------------------------------------

test('AC1: knowledge_append to files[] with resolves CLOSES an article_missing item when an appended path equals one of its file_keys', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/thing-helper.ts`,
      file_keys: ['src/thing-helper.ts'],
      feature_link: article.id,
    });
    assert.equal(openIds(tools).length, 1, 'precondition: one open item');

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/thing-helper.ts', role: 'impl' }], [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'the named article_missing item is gone from the open queue');
    const proof = tools.maintenanceRemove(item.id) as { removed?: string; id?: string; already_drained?: boolean };
    assert.equal(proof.already_drained, true, 'the append-join closure left the same drain-log trace maintenance_remove would have');
    assert.equal(idOf(proof), item.id, 'and the trace names the same id');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the path-equality check entirely and just require "some
// files[] append happened" — this test would still pass (false positive) but
// the CONTROL above goes red instead, which is why the two are paired; as a
// test-local sabotage, normalize-and-compare the WRONG field (e.g. compare
// against `role` instead of `path`) — this test goes red (the throw fires
// instead of the drain, since no path is ever recognized as matching).

// --------------------------------------------------------------------------
// 2. REFUSAL: no appended path matches any file_keys entry at all.
// --------------------------------------------------------------------------

test('refusal: knowledge_append to files[] with resolves, where NONE of the appended paths match any file_keys entry, refuses', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/thing-helper.ts`,
      file_keys: ['src/thing-helper.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () =>
        widen(tools).knowledgeAppend(
          article.id,
          'files',
          [
            { path: 'src/other-a.ts', role: 'impl' },
            { path: 'src/other-b.ts', role: 'impl' },
          ],
          [item.id]
        ),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        return true;
      }
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// SABOTAGE: fall back to draining the item whenever the append call names ANY
// resolves id at all, even with zero matching paths (skip the "at least one
// match" requirement) — this test goes red (the throw no longer fires; the
// item drains despite two non-matching new paths).

// --------------------------------------------------------------------------
// 3. REFUSAL: the matching path was already present before the call.
// --------------------------------------------------------------------------

test('refusal: knowledge_append to files[] with resolves, where the matching path was ALREADY present before the call, refuses — only NEW entries count', () => {
  // REWRITTEN (was HOLLOW): the original version of this test appended a
  // DIFFERENT, unrelated path after seeding the article with the target path
  // already present, so it passed for the NO-MATCH reason (arm 2 above)
  // instead of the NOT-NEW reason this test is named for. Measured: with the
  // "new path" diff logic deliberately reverted to "match against POST-append
  // files[]", the whole file still reported 8/8 PASS, this test included —
  // the sabotage below could not turn it red because the assertion it made
  // was never exercising the code path it claimed to. Fixed by re-appending
  // the EXACT SAME already-owned path the item is keyed to, so the only way
  // this call could be refused is the NOT-NEW rule, not the NO-MATCH rule.
  const { tools, cleanup } = harness();
  try {
    // The article ALREADY owns src/thing-helper.ts at creation time — the
    // article_missing item is stale/wrong, or was enqueued before an earlier
    // append already closed the gap without claiming it.
    const article = mkArticle(tools, 'thing', ['src/thing.ts', 'src/thing-helper.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/thing-helper.ts`,
      file_keys: ['src/thing-helper.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as {
      version: number;
      files: { path: string }[];
    };

    assert.throws(
      // Re-append the SAME path the article already owns — the only path
      // named in this call is one that was already present BEFORE the call,
      // so the new-path set (appended MINUS pre-append files[]) is empty.
      () => widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/thing-helper.ts', role: 'impl' }], [item.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        return true;
      },
      'a path present before the call is not NEW evidence, even when it is re-appended verbatim and matches file_keys'
    );
    const after = tools.knowledgeGet(article.id) as unknown as {
      version: number;
      files: { path: string }[];
    };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.equal(
      after.files.filter((f) => f.path === 'src/thing-helper.ts').length,
      1,
      'the refused call must not have inserted a second, duplicate files[] row for the re-appended path'
    );
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// SABOTAGE: check membership against the POST-append files[] (which always
// contains every pre-existing path regardless of what was actually appended)
// instead of diffing against the PRE-append files[] — this test goes red
// (the throw no longer fires; the re-appended already-owned path is wrongly
// accepted as new evidence, a duplicate files[] row is inserted, and the item
// drains). This is the exact sabotage that the ORIGINAL (hollow) version of
// this test failed to catch, because it exercised the NO-MATCH rule instead.

// --------------------------------------------------------------------------
// 4. REFUSAL: a knowledge_update (not append) naming the same item.
// --------------------------------------------------------------------------

test('refusal: knowledge_update naming an article_missing item refuses — that lane closes only via a files[] append, never a plain update', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/thing-helper.ts`,
      file_keys: ['src/thing-helper.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'x' }, [item.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        assert.match(err.message, /article_missing/, 'names the wrong-lane reason');
        return true;
      },
      'article_missing cannot be claimed through a plain knowledge_update, even naming the right article'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// SABOTAGE: widen validateResolveClaim to treat article_missing like an
// ordinary feature_link-keyed lane (drainable by any knowledge_update naming
// the right article, same as reconcile_needed) — this test goes red (the
// throw no longer fires; the plain update drains the item).

// --------------------------------------------------------------------------
// 5. REFUSAL: the append targets history/current_ac, not files.
// --------------------------------------------------------------------------

test('refusal: knowledge_append to `history` (not `files`) naming an article_missing item refuses — the join is scoped to the files[] field specifically', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/thing-helper.ts`,
      file_keys: ['src/thing-helper.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeAppend(article.id, 'history', [{ date: NOW, event: 'unrelated append' }], [item.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        assert.match(err.message, /files/, 'names the append-to-files shape the lane actually requires');
        return true;
      },
      'an article_missing item is not closable by an append to a field other than files[]'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});

test('refusal: knowledge_append to `current_ac` (not `files`) naming an article_missing item refuses', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/thing-helper.ts`,
      file_keys: ['src/thing-helper.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () =>
        widen(tools).knowledgeAppend(
          article.id,
          'current_ac',
          [{ ac_id: 'AC1', text: 'unrelated ac' }],
          [item.id]
        ),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        assert.match(err.message, /files/, 'names the append-to-files shape the lane actually requires');
        return true;
      },
      'an article_missing item is not closable by an append to current_ac either'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// SABOTAGE (both above): widen the append-join check to fire on ANY field
// name, not just `files`, as long as the resolves id names an article_missing
// item linked to the target record (drop the field === 'files' guard) — both
// tests go red (the throw no longer fires; the history/current_ac append
// wrongly drains the item).

// --------------------------------------------------------------------------
// 6. REFUSAL TEXT SHAPE: names article_missing and the append-to-files shape.
// --------------------------------------------------------------------------

test('refusal text: every article_missing refusal above names both the "article_missing" reason and the append-to-files requirement, not a generic message', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/thing-helper.ts`,
      file_keys: ['src/thing-helper.ts'],
      feature_link: article.id,
    });

    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'x' }, [item.id]),
      (err: Error) => {
        assert.match(err.message, /article_missing/, 'the refusal names the article_missing lane by name');
        assert.match(err.message, /files/i, 'the refusal names the files[] append shape the lane actually requires, not a bare "refused"');
        return true;
      }
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: replace the refusal message with a generic
// "cannot resolve this item" string that drops both the lane name and the
// required-shape explanation — this test goes red on both regex assertions
// even though the call would still (correctly) throw.

// ==========================================================================
// PART A2 — arms added per the brief (decision
// oracle-bearing-fixtures-are-spec-inline-by-default, ruled 2026-09-05).
//
// The first "new path" bullet from the brief (article owns src/x.ts; item
// keyed to src/x.ts; append src/x.ts again -> REFUSED) is exactly test 3
// above (A1, rewritten). The second bullet (article owns a DIFFERENT path;
// item keyed to src/x.ts; append src/x.ts -> DRAINS) is exactly test "AC1"
// above (the article owns 'src/thing.ts', the item is keyed to
// 'src/thing-helper.ts', appending 'src/thing-helper.ts' drains it) — no new
// test needed for either; this comment records that they were checked against
// the existing suite rather than silently skipped.
//
// What follows is genuinely new: multi-key item rewrite-down behaviour, and
// the working_tree exclusion from root-scoped debt.
// ==========================================================================

// --------------------------------------------------------------------------
// 7. MULTI-KEY: partial coverage REWRITES the item down (survives, same id,
// fewer file_keys, corrected leading count, a "partially closed" suffix, and
// a discharge warning) — it does not drain and does not refuse.
// --------------------------------------------------------------------------

test('multi-key partial: knowledge_append covering ONE of a multi-key item\'s file_keys REWRITES it down — same id, fewer file_keys, corrected leading count, a discharge warning', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(3),
      file_keys: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      feature_link: article.id,
    });

    const { warnings } = widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(openIds(tools).includes(item.id), 'a partial discharge SURVIVES on the queue — it must not drain');
    const after = findItem(tools, item.id);
    assert.ok(after, 'the surviving item is still readable back off the queue');
    assert.deepEqual(after!.file_keys, ['src/b.ts', 'src/c.ts'], 'the discharged key is dropped, the other two remain');
    assert.equal(after!.system_reason, 'article_missing', 'the lane is unchanged by a partial discharge');
    // TEXT IS REGENERATED, NOT PATCHED (rebuild invariant) — pin what the
    // text must MEAN, never any specific wording/suffix a prior
    // implementation used. The fixture's OWN "(3 newly created)" clause is a
    // distinct historical fact (files known-missing at enqueue time, not a
    // "still unowned" count) and must survive untouched — it does not read
    // as "N file(s)" so fileCountTokens never sees it.
    const tokensAfter = fileCountTokens(after!.text);
    assert.ok(!tokensAfter.includes(3), 'the stale original total ("3 file(s)") must not survive a close that dropped one of three keys');
    assert.ok(tokensAfter.includes(2), 'the regenerated text must state the TRUE current remaining count (2)');
    // SABOTAGE (count-only): regenerate file_keys down to two entries but
    // leave the text's count untouched (skip text regeneration entirely, or
    // regenerate it from a STALE pre-close snapshot) — tokensAfter still
    // contains 3 and never contains 2; both assertions above go red while
    // the file_keys assertion below stays green, proving this pin catches a
    // defect the structural file_keys check alone would miss.

    assert.ok(Array.isArray(warnings) && warnings.length > 0, 'a partial discharge is reported back to the caller as a warning, not silence');
    const w = warnings.find((line) => line.includes(item.id));
    assert.ok(w, 'the warning names the surviving item by id');
    assert.match(w!, /src\/b\.ts/, 'the warning names a path still unowned');
    assert.match(w!, /src\/c\.ts/, 'the warning names the other path still unowned');
    assert.match(w!, /\b2\b/, 'the warning states the remaining unowned count');
  } finally {
    cleanup();
  }
});
// SABOTAGE: on a partial-coverage append, drain the item outright instead of
// rewriting it down (treat "at least one key discharged" as "fully closed")
// — this test goes red on `openIds(tools).includes(item.id)` (the item is
// gone) and on every assertion that depends on `after` (findItem returns
// undefined).

// --------------------------------------------------------------------------
// 8. MULTI-KEY: full coverage in one call DRAINS (not a partial rewrite).
// --------------------------------------------------------------------------

test('multi-key full: knowledge_append covering EVERY one of a multi-key item\'s file_keys in one call DRAINS it', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(3),
      file_keys: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(
      article.id,
      'files',
      [
        { path: 'src/a.ts', role: 'impl' },
        { path: 'src/b.ts', role: 'impl' },
        { path: 'src/c.ts', role: 'impl' },
      ],
      [item.id]
    );

    assert.ok(!openIds(tools).includes(item.id), 'covering every file_key drains the item outright');
    const proof = tools.maintenanceRemove(item.id) as { removed?: string; id?: string; already_drained?: boolean };
    assert.equal(proof.already_drained, true, 'the drain left the same trace a maintenance_remove would have');
  } finally {
    cleanup();
  }
});
// SABOTAGE: cap the discharge check at "at least one key discharged" and
// always take the partial-rewrite branch, never the full-drain branch — this
// test goes red on `!openIds(tools).includes(item.id)` (the item is still
// open, rewritten down to an empty file_keys list instead of drained).

// --------------------------------------------------------------------------
// 9. MULTI-KEY: a stale key already owned by ANOTHER root-scoped
// feature_article counts as discharged even though this append never touches
// it — otherwise a consolidated item can never fully drain.
// --------------------------------------------------------------------------

test('multi-key stale-elsewhere (feature_article): a file_key already owned by another root-scoped article counts as discharged, letting the item fully drain', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    mkArticle(tools, 'other-thing', ['src/b.ts']); // already owns src/b.ts, no working_tree
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(2),
      file_keys: ['src/a.ts', 'src/b.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'a stale key already owned elsewhere must count as discharged, or a consolidated item can never fully drain');
    const proof = tools.maintenanceRemove(item.id) as { removed?: string; id?: string; already_drained?: boolean };
    assert.equal(proof.already_drained, true);
  } finally {
    cleanup();
  }
});
// SABOTAGE: only ever check THIS append's new-path set for discharge and
// never cross-reference other records' current ownership — this test goes
// red (the item stays open forever at file_keys:['src/b.ts'], since nothing
// in this append ever names src/b.ts).

// --------------------------------------------------------------------------
// 9b. Same rule, via a reference_material owner instead of a feature_article
// — the spec names both record types as capable of discharging a stale key.
// --------------------------------------------------------------------------

test('multi-key stale-elsewhere (reference_material): a file_key already named by a reference_material\'s location (no working_tree) also counts as discharged', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    mkReference(tools, 'other doc', 'src/b.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(2),
      file_keys: ['src/a.ts', 'src/b.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'reference_material ownership discharges a stale key exactly like feature_article ownership does');
  } finally {
    cleanup();
  }
});
// SABOTAGE: restrict the "already owned elsewhere" lookup to feature_article
// records only, ignoring reference_material — this test goes red (the item
// survives, retaining src/b.ts, because reference_material ownership is
// never consulted).

// --------------------------------------------------------------------------
// 10. MULTI-KEY: a key named ONLY by a working_tree article is NOT
// discharged — it is RETAINED, producing a partial close instead of a drain.
// --------------------------------------------------------------------------

test('multi-key working_tree-only owner: a file_key named ONLY by a working_tree article is RETAINED, not discharged', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    mkArticleWT(tools, 'wt-owner', ['src/b.ts'], 'juiced'); // only names src/b.ts, inside a working_tree
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(2),
      file_keys: ['src/a.ts', 'src/b.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(openIds(tools).includes(item.id), 'a working_tree-only owner does not own the ROOT path — the item must survive, not drain');
    const after = findItem(tools, item.id);
    assert.deepEqual(after!.file_keys, ['src/b.ts'], 'src/b.ts is RETAINED — its only claimed owner is a working_tree article, which does not count as root ownership');
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat ANY article naming the path as ownership, working_tree
// declaration or not — this test goes red (the item drains outright instead
// of retaining src/b.ts, since the working_tree article would wrongly count
// as a root owner).

// --------------------------------------------------------------------------
// 11. MULTI-KEY: a repeat partial close is idempotent on the text suffix —
// closing partially twice must not stack duplicate "partially closed"
// clauses.
// --------------------------------------------------------------------------

test('multi-key repeat partial close: closing partially twice does not stack duplicate "partially closed" clauses', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(3),
      file_keys: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);
    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/b.ts', role: 'impl' }], [item.id]);

    const after = findItem(tools, item.id);
    assert.ok(after, 'still on the queue after two partial closes (one key remains)');
    assert.deepEqual(after!.file_keys, ['src/c.ts']);
    const tokens = fileCountTokens(after!.text);
    assert.ok(tokens.includes(1), 'after TWO discharges of three, the regenerated text states the TRUE final remainder (1)');
    assert.ok(!tokens.includes(3), 'the ORIGINAL total must not survive two rewrites');
    assert.ok(!tokens.includes(2), 'the INTERMEDIATE (post-first-close) count must not survive the second rewrite either — text is regenerated fresh from current state every time, never accumulated on top of the last rewrite');
  } finally {
    cleanup();
  }
});
// SABOTAGE: regenerate the text from the PREVIOUS rewrite's text instead of
// from the article/item's freshly-read current state (i.e. patch on top of
// the last rewrite rather than rebuild from scratch each time) — this test
// goes red on the `!tokens.includes(2)` assertion (the intermediate count
// survives alongside the final one).

// --------------------------------------------------------------------------
// 11b. TEXT-SHAPE FALLBACK: an item whose text does NOT use the canonical
// "article missing: N file(s)" lead-in must still be REGENERATED
// consistently on a partial close — current true count stated, stale total
// gone — regardless of the ORIGINAL text's shape. Canonical-shape
// recognition must never be a precondition for correctness; a non-canonical
// text is exactly as entitled to a correct regeneration as the production
// shape is.
// --------------------------------------------------------------------------

test('multi-key text-shape fallback: an item whose text does not use the canonical "article missing: N file(s)" lead-in is still regenerated correctly on a partial close', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    // Deliberately NOT the production shape (see productionArticleMissingText
    // above) — a hand-edited/non-canonical text, chosen specifically because
    // it is not the shape the rebuild's own fixtures elsewhere use, so this
    // arm cannot pass merely by recognising one hardcoded prefix.
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `3 file(s) unowned by 'thing': src/a.ts, src/b.ts, src/c.ts`,
      file_keys: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(openIds(tools).includes(item.id), 'a partial discharge on an unrecognised-shape item still SURVIVES, not drains');
    const after = findItem(tools, item.id);
    assert.ok(after, 'the surviving item is still readable back off the queue');
    assert.deepEqual(
      after!.file_keys,
      ['src/b.ts', 'src/c.ts'],
      'file_keys is corrected structurally regardless of whether the text prefix was recognised'
    );

    // THE CONSISTENCY CHECK — left UNWEAKENED: whatever "N file(s)" tokens
    // the regenerated text carries, none may be the stale original total (3)
    // and the true current remainder (2) must appear.
    const tokens = fileCountTokens(after!.text);
    assert.ok(!tokens.includes(3), 'the stale original total must not survive regardless of the original text\'s exact wording');
    assert.ok(tokens.includes(2), 'the regenerated text must state the TRUE remaining count (2) even for a non-canonical original shape');
  } finally {
    cleanup();
  }
});
// SABOTAGE: only regenerate/correct the count when the original text matches
// one specific, hardcoded canonical prefix, leaving any other wording's
// count untouched (a silent no-op on unrecognised text) — this test goes red
// (tokens still includes 3, and never includes 2 — the stale original count
// survives verbatim on this non-canonical fixture).

// --------------------------------------------------------------------------
// 12. WORKING_TREE EXCLUSION: an article declaring a working_tree cannot
// discharge ROOT-SCOPED debt via a files[] append, even when the appended
// path matches file_keys exactly.
// --------------------------------------------------------------------------

test('CONTROL: an article WITHOUT a working_tree declaration drains a root-scoped article_missing item — the baseline the working_tree refusal below must differ from', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/x.ts`,
      file_keys: ['src/x.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/x.ts', role: 'impl' }], [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'an ordinary (non-working_tree) article drains the item on an exact new-path match');
  } finally {
    cleanup();
  }
});
// SABOTAGE: this control has no independent sabotage of its own — it is the
// baseline the two tests below are compared against; if the working_tree
// exclusion sabotage below is applied and this control also goes red, the
// exclusion was implemented as "refuse everything" rather than "refuse only
// working_tree articles".

test('working_tree refusal: an article DECLARING a working_tree cannot discharge a root-scoped article_missing item via files[] append — refused, and the refusal NAMES working_tree', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticleWT(tools, 'juiced-thing', ['src/thing.ts'], 'juiced');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'juiced-thing' does not yet own src/x.ts`,
      file_keys: ['src/x.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/x.ts', role: 'impl' }], [item.id]),
      (err: Error) => {
        assert.match(err.message, /working_tree/, 'the refusal names working_tree specifically, not a generic refusal');
        return true;
      },
      'a working_tree article cannot satisfy ROOT-scoped file_keys debt, even when the path otherwise matches exactly'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the working_tree exclusion from the append-join admission
// entirely (treat a working_tree article's files[] identically to a root
// article's) — this test goes red (the throw never fires; the call drains
// the item instead, same as the CONTROL above — which is exactly why the
// control is required: without it, "drains" would look correct here too).

test('working_tree distinguishability: a working_tree article appending an UNRELATED path still gets the ORDINARY no-match refusal, not the working_tree-specific one', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticleWT(tools, 'juiced-thing', ['src/thing.ts'], 'juiced');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'juiced-thing' does not yet own src/x.ts`,
      file_keys: ['src/x.ts'],
      feature_link: article.id,
    });

    assert.throws(
      () => widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/unrelated.ts', role: 'impl' }], [item.id]),
      (err: Error) => {
        assert.doesNotMatch(err.message, /working_tree/, 'an unrelated-path refusal is the ORDINARY no-match refusal, not the working_tree-specific one');
        assert.match(err.message, new RegExp(item.id), 'still names the offending item, same as every other refusal in this lane');
        return true;
      }
    );
    assert.ok(openIds(tools).includes(item.id));
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the append-join refuse EVERY call against a working_tree
// article with the SAME working_tree-specific message regardless of whether
// the appended path even matches file_keys — this test goes red on the
// doesNotMatch assertion (the unrelated-path refusal wrongly carries the
// working_tree wording too).

// ==========================================================================
// PART B — REBUILD ARMS (decision
// append-join-discharge-rebuilt-as-one-atomic-transition, knowledge_get
// 26e8f8ac-e0c7-4206-b0ee-640583eb9e87). These pin the six frozen findings
// from that decision's attack set that were not already covered by the
// rewritten arms above (7 / 11 / 11b): regenerated text under two more
// hostile fixture shapes, the target-scope refusal, the project-local owner
// lookup, atomicity (no partial outcome), and the documented gitignore/
// disk-absence non-guarantee. Finding (1) LOST DEBT (an owner retired
// between classification and the drain) is addressed in the report, not
// here — see the handoff/final-message report for why it is not forceable
// from this synchronous, single-process public surface.
// ==========================================================================

// --------------------------------------------------------------------------
// 13. TEXT IS REGENERATED, NOT PATCHED — two fixtures whose ORIGINAL text is
// deliberately unlike anything a leading-count regex patch could reach: (a)
// no digit at all, (b) TWO unrelated "N file(s)" counts in one string. Both
// pin the same invariant as arm 7/11/11b above from a different angle: the
// rebuild REGENERATES the text from current state, it does not locate-and-
// patch a substring (decision finding (3): PROSE CORRUPTION — "audited 20
// file(s); article missing: 3 file(s)…" became "audited 2 file(s); …" under
// the old non-anchored regex).
// --------------------------------------------------------------------------

test('regenerated text (no count token): an item whose original text carries NO "N file(s)" token at all is still regenerated to state the current remaining count', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    // No digit anywhere in this text — a pure list of paths, nothing a
    // count-patching regex could even find, let alone correct.
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `article missing for src/a.ts, src/b.ts, src/c.ts`,
      file_keys: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(openIds(tools).includes(item.id), 'a partial discharge survives');
    const after = findItem(tools, item.id);
    assert.ok(after, 'readable back off the queue');
    assert.deepEqual(after!.file_keys, ['src/b.ts', 'src/c.ts']);
    assert.doesNotMatch(after!.text, /\b3\b/, 'no stale total ("3") of any kind may appear — the original never had one to begin with, so any "3" appearing now would be a NEW, wrong count freshly minted by regeneration');
    assert.match(after!.text, /\b2\b/, 'the regenerated text must state the current remaining count (2) even though the original text carried no count at all');
  } finally {
    cleanup();
  }
});
// SABOTAGE: only regenerate the count clause when an existing one is found
// to replace (i.e. skip text regeneration entirely when no recognisable
// count substring exists in the original) — this test goes red on the
// `/\b2\b/` assertion (the text is left exactly as originally written,
// never stating the new count at all).

test('regenerated text (several counts): a text carrying an UNRELATED historical count alongside the article-missing count corrects only the latter, leaving the former untouched', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    // "audited 20 file(s)" is an unrelated historical fact (a bulk scan
    // total from some other point in time) sitting beside the actual
    // article-missing count (3) in the same string — exactly the shape that
    // corrupted an anchor-first-match regex in the old implementation
    // (decision finding (3): PROSE CORRUPTION).
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `audited 20 file(s); article missing: 3 file(s) nothing owns`,
      file_keys: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(openIds(tools).includes(item.id), 'a partial discharge survives');
    const after = findItem(tools, item.id);
    assert.ok(after, 'readable back off the queue');
    assert.deepEqual(after!.file_keys, ['src/b.ts', 'src/c.ts']);

    const tokens = fileCountTokens(after!.text);
    assert.ok(tokens.includes(20), 'the UNRELATED historical count ("audited 20 file(s)") must survive completely untouched — it is not what this close is about');
    assert.ok(!tokens.includes(3), 'the stale article-missing total (3) must not survive');
    assert.ok(tokens.includes(2), 'the true current remaining count (2) must be stated');
  } finally {
    cleanup();
  }
});
// SABOTAGE: regenerate the count using the FIRST "N file(s)" match found in
// the text regardless of which count it actually describes (i.e. treat
// "audited 20 file(s)" as the article-missing count to correct) — this test
// goes red on the `tokens.includes(20)` assertion (the unrelated historical
// count is corrupted into the new remaining count instead, and 20
// disappears) — reproducing decision finding (3) verbatim.

// --------------------------------------------------------------------------
// 14. TARGET SCOPE REFUSAL (decision requirement (A)) — maintenance items
// are project-local; an append-join against an article scoped outside the
// project store cannot be transactionally atomic with the item's
// project-store rewrite/drain (`runScopedTransaction` refuses cross-mount
// transactions). Article scope is caller-supplied at creation and NOT
// enforced there, so the admission itself must refuse a non-project target.
// --------------------------------------------------------------------------

test('CONTROL: an append-join against an article explicitly scoped "project" drains its article_missing item normally — the baseline the domain-scope refusal below must differ from', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticleScoped(tools, 'thing-project', ['src/thing.ts'], 'project');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing-project' does not yet own src/x.ts`,
      file_keys: ['src/x.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/x.ts', role: 'impl' }], [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'an explicitly project-scoped article drains the item exactly like an unscoped (default) one');
  } finally {
    cleanup();
  }
});
// SABOTAGE: this control has no independent sabotage — it is the baseline
// the refusal test below is compared against; if the scope-refusal
// sabotage below is applied and this control also goes red, the refusal was
// implemented as "refuse every append-join" rather than "refuse only
// non-project scopes".

test('target scope refusal: an append-join whose target article has scope other than "project" (e.g. domain:node) is REFUSED, naming scope', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticleScoped(tools, 'thing-domain', ['src/thing.ts'], 'domain:node');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing-domain' does not yet own src/x.ts`,
      file_keys: ['src/x.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/x.ts', role: 'impl' }], [item.id]),
      (err: Error) => {
        assert.match(err.message, /scope/i, 'the refusal names scope specifically — a domain-scoped article is a different physical store and cannot be transactionally joined with a project-store item rewrite');
        return true;
      },
      'a domain-scoped article cannot discharge a project-local maintenance item via append-join'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the target-scope check from the append-join admission
// entirely (treat a domain-scoped article's files[] identically to a
// project-scoped one) — this test goes red (the throw never fires; the call
// drains the item instead, same outcome as the CONTROL above — which is
// exactly why the control is required: without it, "drains" would look
// correct here too).
//
// FIELD-LEVEL ARM, NOT A MOUNT-BOUNDARY PIN: this test and its CONTROL run
// on the plain single-store harness() — there is only ever one physical
// store in this environment, so it can only prove the code reads the
// `scope` STRING on the target article; it cannot distinguish that from a
// genuine "which physical store holds this row" check, because there is no
// second store here to physically disagree with the label. The real
// mount-boundary version of this refusal (built on a REAL MountedStores) is
// PART D's "target scope refusal (label contradicts holder)" (renamed and
// re-based 2026-09-06, was "(legacy/undefined)") and "a DOMAIN-scoped target
// cannot enter a resolves transaction AT ALL" tests, further down this file —
// read those for the physical-location-decides pin.

// ==========================================================================
// PART C — MOUNT-BOUNDARY REBUILD (two independent reviews, 2026-09-06): the
// "project-local owner" lookup must be judged by PHYSICAL STORE, never by
// the JSON `scope` FIELD — `scope` is caller-writable and unverified by the
// store itself; only which physical database a record's row lives in is
// ground truth. The FORMER version of this arm ("owner lookup is
// project-local") built a single plain SterlingStore and wrote a
// `scope:'domain:node'` row INTO THAT SAME project database — that pinned
// only that the code filters on the `scope` STRING, never that it resolves
// an actual cross-mount boundary, and it would have stayed green even if
// the routing key diverged from `scope` entirely. Rebuilt here on a REAL
// MountedStores (a genuine project store + one mounted 'node' domain
// store), with records seeded via the DIRECT-STORE SEEDING TECHNIQUE (a raw
// envelope written straight through a bare store.create()/SterlingStore
// handle, bypassing knowledge_create entirely) — exactly as
// dead-slug-hardening.test.ts and mounted.test.ts already do — so scope and
// physical location can be made to DISAGREE on purpose. That disagreement
// is the only way to prove which one the code actually trusts; a
// correctly-labelled record can never distinguish the two.
// ==========================================================================

/** A REAL MountedStores harness: a genuine project store plus one mounted
 *  domain store, reached through the same SterlingTools surface as every
 *  other arm in this file. Used ONLY where the pin is about the PHYSICAL
 *  project/domain store boundary — the plain harness() above stays the
 *  right tool everywhere that boundary is not the point. */
// CONSOLIDATED 2026-09-06 (board R4; decision scope-drift-closed-by-column-
// authoritative-reads-not-format-change): this body moved VERBATIM into
// ./test-helpers/mounted-harness.ts, now shared with knowledge-extract.test.ts
// and domain-routing.test.ts, so mount-boundary pins land on ONE real
// two-store fixture instead of three copies that had already drifted apart.
// BEHAVIOUR-NEUTRAL: same mkdtemp prefix, same NOW clock, same randomUUID,
// same mount layout, same return shape. This file's call sites already pass
// ['node'] explicitly, so nothing inherits a default from anywhere.
// Conductor hand-edit: H5 freezes test paths against pipeline agents, and a
// behaviour-neutral harness re-point matches neither evidence contract of
// scripts/test-repair.mjs (anti_pattern 985e1266, whose right_way is exactly
// this route) — counts verified independently after the change.
function harnessMounted(domains: string[] = ['node']) {
  return harnessMountedShared(domains, { now: NOW, prefix: 'sterling-append-join-mounted-' });
}

/** A raw feature_article ENVELOPE for the direct-store seeding technique —
 *  bypasses knowledge_create/schema validation entirely. The tool surface
 *  itself will never produce a scope/physical-location mismatch, or a
 *  record with no scope field at all — those shapes can only be forged
 *  directly, the same way dead-slug-hardening.test.ts forges a raw
 *  legacy-shaped tombstone (`store.create(x as never)`). The caller supplies
 *  `id` itself (rather than reading it back off the write) — the same
 *  idiom dead-slug-hardening.test.ts uses for its forged carriers — so
 *  nothing here depends on what shape `.create()` happens to return.
 *  `scope === undefined` omits the key entirely (a true legacy/pre-scope-
 *  field shape), not merely an undefined VALUE. */
function rawArticleEnvelope(id: string, paths: string[], scope: string | undefined) {
  const env: Record<string, unknown> = {
    id,
    type: 'feature_article',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    stack_tags: [],
    slug: `raw-${id.slice(0, 8)}`,
    title: 'raw article',
    what_it_does: 'does',
    intended_behavior: 'b',
    files: paths.map((path) => ({ path, role: 'impl' })),
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  };
  if (scope !== undefined) env.scope = scope;
  return env;
}

test('CONTROL: a stale key owned by an article physically AND labelled in the PROJECT store counts as discharged — physical location and label agree here; the baseline the mount-boundary pins below diverge from', () => {
  const { tools, cleanup } = harnessMounted(['node']);
  try {
    const article = mkArticleScoped(tools, 'thing', ['src/thing.ts'], 'project');
    mkArticleScoped(tools, 'other-owner', ['src/b.ts'], 'project'); // physically AND labelled project
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(2),
      file_keys: ['src/a.ts', 'src/b.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'a stale key owned by a project-physical, project-labelled article discharges the item fully');
  } finally {
    cleanup();
  }
});
// SABOTAGE: this control has no independent sabotage — it is the baseline
// the two mount-boundary pins below are compared against.

test("mount-boundary: a stale key owned ONLY by an article physically in the DOMAIN store — even though its body claims scope:'project' — does NOT count as a project-local owner", () => {
  const { tools, domainDbPath, cleanup } = harnessMounted(['node']);
  try {
    const article = mkArticleScoped(tools, 'thing', ['src/thing.ts'], 'project');

    // Seed the mislabelled owner DIRECTLY into the domain store's PHYSICAL
    // file (bypassing knowledge_create/MountedStores routing, which would
    // never let scope and physical location disagree) — a raw SterlingStore
    // handle opened on the SAME domain db path this harness already mounts,
    // exactly as mounted.test.ts's "two readers, one file" pattern proves
    // cross-store sharing works.
    const mislabelledId = randomUUID();
    const domainHandle = new SterlingStore(domainDbPath('node'));
    try {
      domainHandle.create(rawArticleEnvelope(mislabelledId, ['src/b.ts'], 'project') as never);
    } finally {
      domainHandle.close();
    }
    assert.equal(
      (tools.knowledgeGet(mislabelledId) as unknown as { scope?: string }).scope,
      'project',
      "precondition: the seeded record's BODY claims scope:'project' even though it physically lives in the domain store"
    );

    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(2),
      file_keys: ['src/a.ts', 'src/b.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(openIds(tools).includes(item.id), 'a domain-store-physical owner must NOT discharge the item, even though its scope field says project — the item survives');
    const after = findItem(tools, item.id);
    assert.deepEqual(after!.file_keys, ['src/b.ts'], "src/b.ts is RETAINED — its only claimed owner physically lives in the domain store, regardless of what its scope field says");
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the "already owned elsewhere" owner lookup trust the JSON
// `scope` field on the candidate owner (treat scope==='project' as
// sufficient) instead of checking which physical store actually holds the
// row — this test goes red (the item drains outright instead of retaining
// src/b.ts, since the mislabelled-but-domain-physical article would wrongly
// count as a project-local owner).

test("mount-boundary (converse): a stale key owned by an article physically in the PROJECT store — even though its body claims scope:'domain:node' — DOES count as a project-local owner", () => {
  const { tools, store, cleanup } = harnessMounted(['node']);
  try {
    const article = mkArticleScoped(tools, 'thing', ['src/thing.ts'], 'project');

    // Seed directly into the PROJECT store's physical file (store.project is
    // a bare SterlingStore — the same direct accessor domain-routing.test.ts
    // and mounted.test.ts already use for store.project.get()), so the body
    // can claim a scope the physical location contradicts.
    const mislabelledId = randomUUID();
    store.project.create(rawArticleEnvelope(mislabelledId, ['src/b.ts'], 'domain:node') as never);
    assert.equal(
      (tools.knowledgeGet(mislabelledId) as unknown as { scope?: string }).scope,
      'domain:node',
      "precondition: the seeded record's BODY claims scope:'domain:node' even though it physically lives in the project store"
    );

    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(2),
      file_keys: ['src/a.ts', 'src/b.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'a project-store-physical owner DOES discharge the item, even though its scope field says domain:node — H10 opens the project database and does not filter on the field');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the "already owned elsewhere" owner lookup trust the JSON
// `scope` field (require scope==='project' or unscoped) instead of checking
// physical location — this test goes red (the item survives, retaining
// src/b.ts, since the project-physical-but-domain-labelled article would be
// wrongly excluded).

// --------------------------------------------------------------------------
// 16. ATOMICITY — NO PARTIAL OUTCOME. The article write and the item
// rewrite/drain are one transaction: if the item side of a resolves claim
// cannot be completed, the article side must not have landed either, even
// when the article-side write would otherwise have succeeded on its own
// (decision finding (2): a post-commit throw once reported as a failed
// write when the article version had already bumped).
// --------------------------------------------------------------------------

test('atomicity: resolves naming a non-existent maintenance item id refuses the WHOLE call — the article append must not land either', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const before = tools.knowledgeGet(article.id) as unknown as { version: number; files: { path: string }[] };
    const bogusItemId = randomUUID();

    assert.throws(
      () => widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/brand-new.ts', role: 'impl' }], [bogusItemId]),
      (err: Error) => {
        assert.match(err.message, new RegExp(bogusItemId), 'the refusal names the unresolvable id');
        return true;
      },
      'a resolves claim naming an id that does not exist must refuse the whole call, not silently drop the claim and append anyway'
    );

    const after = tools.knowledgeGet(article.id) as unknown as { version: number; files: { path: string }[] };
    assert.equal(after.version, before.version, 'the article write must not have landed — no partial commit');
    assert.ok(!after.files.some((f) => f.path === 'src/brand-new.ts'), 'the appended path must not appear anywhere in files[] — no partial commit');
  } finally {
    cleanup();
  }
});
// SABOTAGE: validate/apply the article-side files[] append BEFORE checking
// that every claimed resolves id actually exists (reorder so the write
// commits first, resolves-claim validation second) — this test goes red
// (the article's version is bumped and src/brand-new.ts appears in files[]
// despite the bogus id, even though the call still throws).
// (Implicit control: arm "AC1" earlier in this file already establishes that
// the identical shape of call with a VALID resolves id succeeds and drains —
// this arm changes only the id's validity.)

test('atomicity: resolves naming a mix of one VALID item (for this article) and one item linked to a DIFFERENT article refuses the WHOLE call — the otherwise-valid item must not partially drain either', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const otherArticle = mkArticle(tools, 'other-thing', ['src/other.ts']);
    const { record: goodItem } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'thing' does not yet own src/brand-new.ts`,
      file_keys: ['src/brand-new.ts'],
      feature_link: article.id,
    });
    const { record: badItem } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: `'other-thing' does not yet own src/other-missing.ts`,
      file_keys: ['src/other-missing.ts'],
      feature_link: otherArticle.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number; files: { path: string }[] };

    assert.throws(
      () =>
        widen(tools).knowledgeAppend(
          article.id,
          'files',
          [{ path: 'src/brand-new.ts', role: 'impl' }],
          [goodItem.id, badItem.id]
        ),
      (err: Error) => {
        assert.match(err.message, new RegExp(badItem.id), 'the refusal names the offending (mismatched) id');
        return true;
      },
      'one invalid id in a multi-id resolves claim refuses the WHOLE set, all-or-nothing'
    );

    const after = tools.knowledgeGet(article.id) as unknown as { version: number; files: { path: string }[] };
    assert.equal(after.version, before.version, 'the article write must not have landed at all');
    assert.ok(!after.files.some((f) => f.path === 'src/brand-new.ts'), 'the appended path must not appear — no partial commit');
    assert.ok(openIds(tools).includes(goodItem.id), 'the otherwise-valid item must not have been drained either — all or nothing across the resolves set');
    assert.ok(openIds(tools).includes(badItem.id), 'the mismatched item is untouched too');
  } finally {
    cleanup();
  }
});
// SABOTAGE: process each id in the resolves array independently and
// best-effort — drain/rewrite whichever claims validate, refuse only the
// ones that don't, instead of treating the whole call as one all-or-nothing
// unit — this test goes red (goodItem drains and the article write lands
// despite badItem's claim being invalid).

// --------------------------------------------------------------------------
// 17. DOCUMENTED DIVERGENCE (not a defect, decision EXPLICIT NON-GUARANTEE):
// H10's own `stillOwed` retention predicate prunes a file_key that has
// become gitignored or deleted from disk. This append-join mechanism's
// server-side retention does NOT — a partial close can retain a key that can
// never gain an owning article. This is a KNOWN, ACCEPTED gap, recorded here
// so a future attempt to make the two agree finds this arm and knows the
// divergence was deliberate, not missed. Do not "fix" this arm to expect
// pruning without reading H10's stillOwed predicate first and updating BOTH
// sides together.
// --------------------------------------------------------------------------

test('documented divergence: a retained key that is absent from disk stays retained across a partial close (this mechanism does not prune gitignored/deleted keys the way H10 stillOwed does)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: productionArticleMissingText(2),
      file_keys: ['src/a.ts', 'src/this-path-does-not-exist-anywhere-abcxyz-999.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/a.ts', role: 'impl' }], [item.id]);

    assert.ok(openIds(tools).includes(item.id), 'the item survives the partial close');
    const after = findItem(tools, item.id);
    assert.deepEqual(
      after!.file_keys,
      ['src/this-path-does-not-exist-anywhere-abcxyz-999.ts'],
      'a key absent from disk is RETAINED, not pruned — a deliberate, accepted divergence from H10\'s stillOwed (which DOES prune gitignored/deleted keys), not an oversight'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: add disk-existence/gitignore pruning to this mechanism's
// retention predicate (mirroring H10's stillOwed) without also updating this
// arm — this test goes red (file_keys no longer retains the absent path; it
// is pruned to [] and the item drains outright instead of surviving).

// ==========================================================================
// PART D — MOUNT-BOUNDARY REBUILD, CONTINUED: target-scope fails closed for a
// target whose LABEL disagrees with its PHYSICAL HOLDER — a project-labelled row
// that the project database does not hold (RE-BASED 2026-09-06 off the
// scope-less/legacy shape, which no read can reach any more; the arm below
// carries the full note) — and the domain-scoped-target
// refusal generalised to ANY resolves lane (not just article_missing),
// proven on a REAL MountedStores with a real second physical connection —
// arm 14 above ("target scope refusal") runs on the plain single-store
// harness() and can only pin that the code reads the `scope` STRING; it
// cannot distinguish that from a genuine physical-store check, because a
// plain SterlingStore has no second store to physically disagree with. The
// two arms below close that gap. Mixed-lane atomicity (item 5 of the brief)
// needs no second physical store at all — it is a same-store, same-
// transaction concern — so it is built on the plain harness(), matching its
// sibling atomicity arms (16) above.
// ==========================================================================

/* TOMBSTONE — `stripScopeFromStoredRow` lived here until 2026-09-06 and has been
 * DELETED deliberately. It rewrote a row's JSON BODY column to remove the `scope`
 * key while leaving the NOT NULL `scope` COLUMN intact, which used to make a
 * record READ BACK with no scope at all — the "legacy/undefined scope" shape the
 * arm below was originally built on.
 *
 * WHY IT IS GONE. Its whole premise was the asymmetry "column-authoritative on
 * disk, body-authoritative on read". Part 4 of decision
 * `scope-drift-closed-by-column-authoritative-reads-not-format-change`
 * (knowledge_get 74b67d0f-be6e-4bbb-8d4a-95f67f842190) has since SHIPPED: one
 * central live-record decoder overwrites the parsed body's `scope` with the row's
 * `scope` COLUMN on every live materializing read. The strip still succeeds on
 * disk and NO READ WILL EVER SHOW YOU THE RESULT, so the precondition
 * `assert.ok(!knowledgeGet(id).scope)` is permanently false. That is the decoder
 * working as designed — body-vs-column disagreement is unrepresentable on read.
 *
 * DO NOT RESURRECT IT. The one drift class still reachable is COLUMN CONTRADICTS
 * MOUNT: a row PHYSICALLY held by one store whose `scope` column names another.
 * Forge it with `rawArticleEnvelope` + a raw `.create()` on the store you want to
 * hold it (the idiom the two mount-boundary arms above already use), which is
 * exactly what the re-based arm below now does.
 */

test("CONTROL (forgery baseline, placed first): the SAME raw-forged, scope:'project' article seeded into the PROJECT store is admitted and drains its item normally", () => {
  const { tools, store, cleanup } = harnessMounted(['node']);
  try {
    // REQUIRED CONTROL, added 2026-09-06 with the re-base below. That arm's
    // verdict is "the call was refused", and a refusal has MORE THAN ONE
    // possible cause: the target being raw-forged rather than tool-created is
    // itself a candidate (a forged envelope skips knowledge_create entirely).
    // This arm forges the IDENTICAL envelope and changes exactly ONE thing —
    // which physical database holds it — and must PASS FOR THE OPPOSITE REASON.
    // Without it a green below could be a green about forgery, not about
    // holders.
    const forgedId = randomUUID();
    store.project.create(rawArticleEnvelope(forgedId, ['src/thing.ts'], 'project') as never);
    assert.equal(
      (tools.knowledgeGet(forgedId) as unknown as { scope?: string }).scope,
      'project',
      "precondition: the forged record reads as scope:'project'"
    );
    assert.ok(store.project.get(forgedId), 'precondition: AND the PROJECT database physically holds it — label and holder agree');

    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'forged article does not yet own src/x.ts',
      file_keys: ['src/x.ts'],
      feature_link: forgedId,
    });

    widen(tools).knowledgeAppend(forgedId, 'files', [{ path: 'src/x.ts', role: 'impl' }], [item.id]);

    assert.ok(
      !openIds(tools).includes(item.id),
      'a raw-forged but PROJECT-HELD target is admitted and its item drains — so the refusal below is about the HOLDER, not about the forgery'
    );
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE: GREEN. SABOTAGE: refuse any append-join whose target was not
// created through knowledge_create (e.g. gate on a create-time marker) -> this
// control goes red while the re-based arm below stays green, which is exactly
// the discrimination it exists to provide.

test("target scope refusal (label contradicts holder): an append-join whose target article is physically held by the DOMAIN store while its scope says 'project' is REFUSED, naming scope — a project LABEL is not project MEMBERSHIP (control: the forgery baseline directly above, plus arm 14's CONTROL)", () => {
  const { tools, store, domainDbPath, cleanup } = harnessMounted(['node']);
  try {
    // RE-BASED 2026-09-06 — READ BEFORE "SIMPLIFYING" THIS FIXTURE. This arm was
    // originally "target article carries NO scope field at all", built by
    // creating the article validly and then stripping `scope` out of the stored
    // JSON body. THAT SHAPE IS ABOLISHED: part 4 of decision
    // `scope-drift-closed-by-column-authoritative-reads-not-format-change` has
    // shipped a column-authoritative decoder that refills the parsed body's scope
    // from the NOT NULL `scope` COLUMN on every live read, so a scope-less READ is
    // unreachable and the old precondition was permanently false. (The arm was
    // already RED at HEAD for exactly this reason.) Do NOT restore the body-level
    // strip — it produces a permanently-red precondition that reads like a code
    // defect and is not one.
    //
    // WHAT THE PIN IS FOR IS UNCHANGED: a target whose scope LABEL disagrees with
    // the store that PHYSICALLY holds it must be refused, not admitted on the
    // strength of the label. That is re-based onto the one surviving drift class,
    // COLUMN CONTRADICTS MOUNT (governing decision: the five label-only gates must
    // require physical membership via projectStoreHolds, "not the label alone"),
    // using the same raw-seed idiom as the two mount-boundary arms above.
    const mislabelledId = randomUUID();
    const domainHandle = new SterlingStore(domainDbPath('node'));
    try {
      domainHandle.create(rawArticleEnvelope(mislabelledId, ['src/thing.ts'], 'project') as never);
    } finally {
      domainHandle.close();
    }
    assert.equal(
      (tools.knowledgeGet(mislabelledId) as unknown as { scope?: string }).scope,
      'project',
      "precondition: the target READS as scope:'project' — the label a label-only gate would admit on"
    );
    assert.equal(
      store.project.get(mislabelledId),
      undefined,
      'precondition: while the PROJECT database does not hold it at all — it physically lives in the mounted node store'
    );

    const { record: item } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: 'mislabelled article does not yet own src/x.ts',
      file_keys: ['src/x.ts'],
      feature_link: mislabelledId,
    });
    const before = tools.knowledgeGet(mislabelledId) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeAppend(mislabelledId, 'files', [{ path: 'src/x.ts', role: 'impl' }], [item.id]),
      (err: Error) => {
        assert.match(
          err.message,
          /scope/i,
          "the refusal names scope — a project LABEL over a domain-held row is not project membership, and the caller must be able to tell which of the two disagreeing values decided it"
        );
        return true;
      },
      'a target the project database does not physically hold must be refused, however plainly its label says project'
    );
    const after = tools.knowledgeGet(mislabelledId) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the item is untouched — still open');
  } finally {
    cleanup();
  }
});
// EXPECTED SHAPE: GREEN if the admission gate requires physical project
// membership (the governing decision's evidence_basis records the append-join
// path's four label-class gates as ALREADY FIXED). RED-BECAUSE-WRONG if the gate
// still admits on the label alone: the throw never fires, the append lands, the
// item drains, and the failure is "Missing expected exception".
//
// ONE WORDING RISK, DISCLOSED RATHER THAN PRE-LOOSENED: the `/scope/i` regex is
// carried over UNCHANGED from the arm this replaces, and it is the one assertion
// here that pins message text. If the physical-membership branch refuses with a
// message that names only the holder ("not held by the project store") and never
// the word scope, this goes red on the regex while the throw itself is correct.
// That is an ADJUDICATION for the conductor — either the message should name the
// scope it rejected (the actionability the original pin bought) or this regex
// should widen — NOT something to silently loosen, and not evidence the guard is
// missing. Verify which by reading the thrown message before touching either side.
//
// SABOTAGE: make the target-scope admission guard accept any target whose scope
// FIELD reads 'project' without checking that the project database actually holds
// the row (the label-only shape the governing decision names) — this test goes
// red (the throw never fires; the domain-held target is admitted and the item
// drains, the same outcome as the forgery-baseline CONTROL above, which is
// exactly why that control is required: without it, "drains" would look correct
// here too).
// LOAD-BEARING NOTE, HONEST: this arm and the "mount-boundary" owner-lookup arm
// earlier in this file both die under a "trust the scope field instead of the
// physical holder" mutation — but at DIFFERENT call sites (this one at TARGET
// admission, that one at OWNER lookup). If the implementation shares one
// predicate, a single mutation reddens both and neither is redundant defence in
// depth; if it does not, only one reddens, and that difference is itself the
// finding.

test('CONTROL: a resolves claim naming a reconcile_needed item, targeting a PROJECT-scoped article via knowledge_update, succeeds and drains it — the baseline the domain-scoped refusal below must differ from', () => {
  const { tools, cleanup } = harnessMounted(['node']);
  try {
    const article = mkArticleScoped(tools, 'thing', ['src/thing.ts'], 'project');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: "'thing' needs reconciling",
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });

    widen(tools).knowledgeUpdate(article.id, { what_it_does: 'reconciled' }, [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'the reconcile_needed item drains via an ordinary project-scoped update');
  } finally {
    cleanup();
  }
});
// SABOTAGE: this control has no independent sabotage — it is the baseline
// the domain-scoped refusal below is compared against.

test('mount-boundary: a DOMAIN-scoped target cannot enter a resolves transaction AT ALL, even for a pass-through (non-article_missing) claim — the whole call is refused', () => {
  const { tools, cleanup } = harnessMounted(['node']);
  try {
    const article = mkArticleScoped(tools, 'thing-domain', ['src/thing.ts'], 'domain:node');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: "'thing-domain' needs reconciling",
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'reconciled' }, [item.id]),
      (err: Error) => {
        assert.match(err.message, /scope/i, 'the refusal names scope — a domain-scoped target is a different physical connection and cannot join this transaction, regardless of claim type');
        return true;
      },
      'a domain-scoped target refuses a resolves claim of ANY lane, not just article_missing — the cross-store write would commit on a second connection independently of the open project transaction'
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
    assert.ok(openIds(tools).includes(item.id), 'the reconcile_needed item is untouched — still open');
  } finally {
    cleanup();
  }
});
// SABOTAGE: restrict the domain-scope target refusal to the article_missing
// lane only (e.g. gate it inside the article_missing-specific append-join
// admission path, never checked for an ordinary knowledge_update/
// reconcile_needed claim) — this test goes red (the throw never fires; the
// domain-scoped article's write proceeds and the reconcile_needed item
// drains, same outcome as the CONTROL above — which is exactly why the
// control is required: without it, "drains" would look correct here too).

// --------------------------------------------------------------------------
// MIXED-LANE ATOMICITY (brief item 5): one article_missing claim and one
// reconcile_needed claim in a SINGLE call. Neither reviewer found a defect
// here, but neither could find an arm covering it either. Same-store,
// same-transaction concern — no second physical store needed, so this uses
// the plain harness() (matching sibling atomicity arms 16 above), not
// harnessMounted.
// --------------------------------------------------------------------------

test('mixed claims: one article_missing claim and one reconcile_needed claim discharge TOGETHER in a single append-join call', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const { record: missingItem } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: "'thing' does not yet own src/new.ts",
      file_keys: ['src/new.ts'],
      feature_link: article.id,
    });
    const { record: reconcileItem } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: "'thing' needs reconciling",
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });
    assert.equal(openIds(tools).length, 2, 'precondition: two open items');

    widen(tools).knowledgeAppend(article.id, 'files', [{ path: 'src/new.ts', role: 'impl' }], [missingItem.id, reconcileItem.id]);

    assert.ok(!openIds(tools).includes(missingItem.id), 'the article_missing claim discharged');
    assert.ok(!openIds(tools).includes(reconcileItem.id), 'the reconcile_needed claim discharged in the SAME call');
  } finally {
    cleanup();
  }
});
// SABOTAGE: process only ONE resolves-lane type per call and silently skip
// the rest (e.g. only ever check article_missing-shaped claims, ignoring a
// reconcile_needed id sitting in the same resolves array) — this test goes
// red (reconcileItem stays open even though the call succeeds).

test('mixed claims atomicity: a valid article_missing claim mixed with an INVALID reconcile_needed claim (wrong feature_link) refuses the WHOLE call — neither drains', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', ['src/thing.ts']);
    const otherArticle = mkArticle(tools, 'other-thing', ['src/other.ts']);
    const { record: missingItem } = tools.maintenanceEnqueue({
      reason: 'article_missing',
      text: "'thing' does not yet own src/new.ts",
      file_keys: ['src/new.ts'],
      feature_link: article.id,
    });
    const { record: mismatchedReconcile } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: "'other-thing' needs reconciling",
      file_keys: ['src/other.ts'],
      feature_link: otherArticle.id,
    });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number; files: { path: string }[] };

    assert.throws(
      () =>
        widen(tools).knowledgeAppend(
          article.id,
          'files',
          [{ path: 'src/new.ts', role: 'impl' }],
          [missingItem.id, mismatchedReconcile.id]
        ),
      (err: Error) => {
        assert.match(err.message, new RegExp(mismatchedReconcile.id), 'the refusal names the offending (mismatched) id');
        return true;
      },
      'one invalid claim in a mixed-lane resolves set refuses the WHOLE call, all-or-nothing'
    );

    const after = tools.knowledgeGet(article.id) as unknown as { version: number; files: { path: string }[] };
    assert.equal(after.version, before.version, 'the article write must not have landed at all');
    assert.ok(!after.files.some((f) => f.path === 'src/new.ts'), 'the appended path must not appear — no partial commit');
    assert.ok(openIds(tools).includes(missingItem.id), 'the otherwise-valid article_missing claim must not have discharged either');
    assert.ok(openIds(tools).includes(mismatchedReconcile.id), 'the mismatched reconcile_needed item is untouched too');
  } finally {
    cleanup();
  }
});
// SABOTAGE: validate/discharge each resolves id independently per-lane
// instead of treating the whole resolves array as one all-or-nothing unit
// across BOTH lane types — this test goes red (missingItem drains and the
// article write lands despite mismatchedReconcile's claim being invalid).
