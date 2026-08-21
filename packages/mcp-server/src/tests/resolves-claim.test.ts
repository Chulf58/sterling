import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// reconcile_needed closes on an EXPLICIT resolves claim, never on "a write
// happened" (decision 68988832-2ef5-4ff3-b693-4f0f0ea8dae1; board 68fe8373).
//
// Background this file pins: knowledgeUpdate (and the append/edit paths that
// share its versioned-update core) used to IMPLICITLY auto-drain every open
// reconcile_needed/refresh_reference item whose feature_link was in the
// updated record's supersede chain (decision 8ecd435f — pinned, until now, by
// two tools.test.ts assertions amended alongside this file). That implicit
// drain is REMOVED. knowledge_update / knowledge_append / knowledge_edit gain
// an optional trailing `resolves: string[]` naming maintenance-queue item ids
// the write discharges. Validation runs BEFORE the write; the whole call
// REFUSES (no version minted, no item removed) when a named id does not
// exist, is not open, is a non-drainable lane (promotion_review — closes only
// via knowledge_promote), or does not key to the written record's id or one
// of its supersedes-chain ancestor ids. On success exactly the named items
// drain, reaching the same drain log maintenance_remove writes to. A write
// that claims nothing (or only some open items) leaves the rest OPEN and its
// receipt's `warnings` names them (id + one-line) so unclaimed debt is
// visible at the write, never silent.
//
// INTERFACE NOTE: `resolves` does not exist on SterlingTools yet — that gap is
// exactly what this suite specifies. `Resolving` below states the exact
// shape the implementation must grow into; it is not invented behavior, it is
// the brief's "each gain an optional resolves: string[] parameter" turned
// into a type. Because the current methods ignore any argument past their
// declared arity, calling through this widened view fails on the ASSERTIONS
// below (the resolves argument is silently dropped, so claims don't happen
// and refusals don't fire) rather than crashing — the red this suite expects
// pre-implementation.

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-resolves-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

const mkArticle = (tools: SterlingTools, slug: string, path: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: [{ path, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record;

type Resolving = {
  knowledgeUpdate(id: string, patch: Record<string, unknown>, resolves?: string[]): unknown;
  knowledgeUpdateResult(id: string, patch: Record<string, unknown>, resolves?: string[]): { record: Record<string, unknown>; warnings: string[] };
  knowledgeAppend(
    id: string,
    field: string,
    values: unknown[],
    resolves?: string[]
  ): { record: Record<string, unknown>; warnings: string[] };
  knowledgeEdit(
    id: string,
    field: string,
    find: string,
    replace: string,
    resolves?: string[]
  ): { record: Record<string, unknown>; warnings: string[]; replaced: { field: string } };
};
const widen = (tools: SterlingTools) => tools as unknown as Resolving;

// Tolerant of the exact field name the removal-receipt shape carries the id
// on (idempotent-remove.test.ts established this same tolerance for
// maintenance_remove's own receipt: `removed` on a live close, `id` as a
// fallback).
function idOf(result: unknown): string | undefined {
  const r = result as { removed?: string; id?: string };
  return r.removed ?? r.id;
}

function openIds(tools: SterlingTools): string[] {
  return (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);
}

test('AC1: knowledge_update with a valid resolves id removes exactly that item, and the removal reaches the drain log (not a silent deletion)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing'`,
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });
    assert.equal(openIds(tools).length, 1, 'precondition: one open item');

    widen(tools).knowledgeUpdate(article.id, { what_it_does: 'reconciled' }, [item.id]);

    assert.ok(!openIds(tools).includes(item.id), 'the named item is gone from the open queue');

    // "reaches the drain log" proven the same way idempotent-remove.test.ts
    // pins maintenance_remove's own drain-log trace (board 83478fc6 / decision
    // 4c09401d's record_id column): a second close on the same id SUCCEEDS
    // with already_drained:true, not "no trace of it in the drain log".
    const proof = tools.maintenanceRemove(item.id) as { removed?: string; id?: string; already_drained?: boolean };
    assert.equal(proof.already_drained, true, 'the resolves-claim removal left the same trace maintenance_remove would have');
    assert.equal(idOf(proof), item.id, 'and the trace names the same id');
  } finally {
    cleanup();
  }
});

test('AC2 (central regression pin): knowledge_update with NO resolves leaves a chain-linked open reconcile_needed item OPEN — the old implicit drain is dead — and the receipt warns naming it', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing'`,
      file_keys: ['src/thing.ts'],
      feature_link: v1.id,
    });

    // OLD CONTRACT (decision 8ecd435f): this write alone used to drain the
    // item with zero claim. NEW CONTRACT: a write is not a claim.
    const result = widen(tools).knowledgeUpdateResult(v1.id, { what_it_does: 'reconciled, unclaimed' });

    assert.ok(openIds(tools).includes(item.id), 'the item is still open — no implicit drain happened');
    assert.ok(
      result.warnings.some((w) => w.includes(item.id)),
      'the receipt warns, naming the still-open item id'
    );
    assert.ok(
      result.warnings.some((w) => /reconcile/i.test(w) && w.includes(item.id)),
      'the warning identifies it as reconcile-lane debt in one line, not a re-send of the whole item'
    );
  } finally {
    cleanup();
  }
});

test('AC3: knowledge_append and knowledge_edit accept resolves exactly like knowledge_update — the same validate-before-write core', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: appendItem } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing' (append)`,
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });

    const appended = widen(tools).knowledgeAppend(
      article.id,
      'history',
      [{ date: NOW, event: 'reconciled via append' }],
      [appendItem.id]
    );
    assert.ok(!openIds(tools).includes(appendItem.id), 'knowledge_append with resolves drains the named item');

    const head = (appended.record as { id: string }).id;
    const { record: editItem } = tools.maintenanceEnqueue({
      reason: 'refresh_reference',
      text: `refresh 'thing' (edit)`,
      file_keys: ['src/thing.ts'],
      feature_link: head,
    });

    const edited = widen(tools).knowledgeEdit(head, 'what_it_does', 'does', 'does, edited', [editItem.id]);
    assert.ok(!openIds(tools).includes(editItem.id), 'knowledge_edit with resolves drains the named item too');
    assert.equal(edited.replaced.field, 'what_it_does', 'the edit itself still landed normally alongside the claim');
  } finally {
    cleanup();
  }
});

test('refusal: resolves naming an id that does not exist at all refuses before writing — no version minted, nothing touched', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const before = tools.knowledgeGet(article.id) as unknown as { version: number; status: string };
    const bogus = randomUUID();

    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'x' }, [bogus]),
      (err: Error) => {
        assert.match(err.message, new RegExp(bogus), 'names the offending id');
        return true;
      },
      'an id with no maintenance record at all is refused, not silently ignored'
    );

    const after = tools.knowledgeGet(article.id) as unknown as { version: number; status: string };
    assert.equal(after.version, before.version, 'no new version minted by the refused call');
    assert.equal(after.status, 'active', 'the record was never superseded by the refused call');
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 1, 'still exactly one head — the refused write produced nothing');
  } finally {
    cleanup();
  }
});

test('refusal: resolves naming an already-removed id refuses — it is not open, so it cannot be re-claimed', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing'`,
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });
    tools.maintenanceRemove(item.id); // closed a moment earlier — e.g. a concurrent librarian

    const before = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'x' }, [item.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(item.id), 'names the offending id');
        assert.match(err.message, /open/i, 'and says why: it is not open');
        return true;
      }
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted by the refused call');
  } finally {
    cleanup();
  }
});

test('refusal: resolves naming a promotion_review item refuses — that lane closes ONLY through knowledge_promote (rule 5)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: review } = tools.maintenanceEnqueue({ reason: 'promotion_review', text: `promote 'thing'`, feature_link: article.id });
    const before = tools.knowledgeGet(article.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeUpdate(article.id, { what_it_does: 'x' }, [review.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(review.id), 'names the offending id');
        assert.match(err.message, /promotion_review/, 'and names the wrong-lane reason');
        return true;
      }
    );
    const after = tools.knowledgeGet(article.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted');
    assert.ok(openIds(tools).includes(review.id), 'the promotion_review item is untouched — still open');
  } finally {
    cleanup();
  }
});

test("refusal: resolves naming an item keyed to a DIFFERENT article refuses — feature_link must match this record or one of its ancestors", () => {
  const { tools, cleanup } = harness();
  try {
    const articleA = mkArticle(tools, 'thing-a', 'src/a.ts');
    const articleB = mkArticle(tools, 'thing-b', 'src/b.ts');
    const { record: itemForB } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing-b'`,
      file_keys: ['src/b.ts'],
      feature_link: articleB.id,
    });
    const before = tools.knowledgeGet(articleA.id) as unknown as { version: number };

    assert.throws(
      () => widen(tools).knowledgeUpdate(articleA.id, { what_it_does: 'x' }, [itemForB.id]),
      (err: Error) => {
        assert.match(err.message, new RegExp(itemForB.id), 'names the offending id');
        return true;
      },
      "an item keyed to a different article's chain cannot be claimed by this write"
    );
    const after = tools.knowledgeGet(articleA.id) as unknown as { version: number };
    assert.equal(after.version, before.version, 'no version minted on article A');
    assert.ok(openIds(tools).includes(itemForB.id), "thing-b's item is untouched — still open");
  } finally {
    cleanup();
  }
});

test('AC5 (ancestor-chain keying): an item whose feature_link is a SUPERSEDED ANCESTOR of the written record IS claimable via resolves', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing'`,
      file_keys: ['src/thing.ts'],
      feature_link: v1.id, // enqueued against v1
    });

    // v1 -> v2, unclaimed: the item must survive (pinned by AC2 above) still
    // linked to the now-superseded v1.
    const v2 = widen(tools).knowledgeUpdate(v1.id, { what_it_does: 'v2' }) as { id: string };
    assert.ok(openIds(tools).includes(item.id), 'still open after the unclaimed v1->v2 reconcile');

    // v2 -> v3, NAMED via resolves: v1 is an ancestor in v3's supersede chain,
    // so the old link is still claimable — chain membership, not exact-id match.
    widen(tools).knowledgeUpdate(v2.id, { what_it_does: 'v3' }, [item.id]);
    assert.ok(!openIds(tools).includes(item.id), 'claimed via the ancestor chain — drained');
  } finally {
    cleanup();
  }
});

test('AC6 (partial claim): two open items, resolves names one — that one drains, the other stays open and is named in the warning', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const { record: claimed } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'thing' — description drift`,
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });
    const { record: unclaimed } = tools.maintenanceEnqueue({
      reason: 'refresh_reference',
      text: `refresh 'thing' — stale reference`,
      file_keys: ['src/thing.ts'],
      feature_link: article.id,
    });

    const result = widen(tools).knowledgeUpdateResult(article.id, { what_it_does: 'partially reconciled' }, [claimed.id]);

    assert.ok(!openIds(tools).includes(claimed.id), 'the named item drained');
    assert.ok(openIds(tools).includes(unclaimed.id), 'the unnamed item stays open');

    assert.ok(
      result.warnings.some((w) => w.includes(unclaimed.id)),
      'the receipt warns naming the still-open item'
    );
    assert.ok(
      !result.warnings.some((w) => w.includes(claimed.id)),
      'and does not warn about the one it just closed'
    );
  } finally {
    cleanup();
  }
});

// CONDUCTOR-AUTHORED PIN 2026-08-21 (reviewer HIGH finding on the first cut):
// knowledgeUpdateResult read its pre-state via raw store.get (exact uuid only),
// so a SLUG-addressed update skipped the open-debt disclosure entirely — the
// exact silent-closure hole this contract exists to close, on the addressing
// form CLAUDE.md mandates for durable citation. The disclosure must fire on
// every addressing form knowledge_update itself accepts.
test('slug addressing: an unclaimed write addressed by SLUG still warns about the open reconcile item', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'slug-addressed', 'src/slug-addressed.ts');
    const { record: item } = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `reconcile 'slug-addressed'`,
      file_keys: ['src/slug-addressed.ts'],
      feature_link: article.id,
    });
    const result = widen(tools).knowledgeUpdateResult('slug-addressed', { state: 'active' });
    assert.equal(openIds(tools).includes(item.id), true, 'the unclaimed item stays open');
    assert.equal(
      result.warnings.some((w) => w.includes(item.id)),
      true,
      'the receipt names the open item even when the write was addressed by slug'
    );
  } finally {
    cleanup();
  }
});

test('boundary: no open reconcile-lane debt on the article means no resolves warning — a clean write stays clean (P1)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    // CONDUCTOR HARNESS REPAIR 2026-08-21: a what_it_does-only body trips the
    // pre-existing coherence warning (paired fields not passed — its own pin in
    // tools.test.ts), so asserting [] was unsatisfiable. A state-only write is
    // warning-neutral and keeps the oracle strict: clean article, empty warnings.
    const result = widen(tools).knowledgeUpdateResult(article.id, { state: 'active' });
    assert.deepEqual(result.warnings, [], 'nothing owed, nothing warned');
  } finally {
    cleanup();
  }
});
