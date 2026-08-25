import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-06-10T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Spec under test: decision 881baf13-f9e1-4344-b088-5fd16ad206b0
// [article-oversize-exemption-cites-live-decision], superseding d547d3b0
// [mcp-tool-surface's article_oversize item is ACCEPTED STANDING DEBT].
// Rides the per-slug dedup-at-minting-site fix, decision 19b506ce
// [article-oversize-dedups-on-the-slug-at-its-minting-site-the], and the
// base mechanism, decision 6c79a617 (board 8390f8fa).
//
// Authored BLIND to the concurrent implementation, from the decision
// records' text alone — never from packages/mcp-server/src/tools.ts.
//
// Pinned:
//   1. CONTROL — no exemption entry: mints exactly as the pre-existing
//      mechanism does today.
//   2. An exemption entry citing a LIVE decision suppresses the mint,
//      scoped to its own slug only — a sibling non-exempted article in the
//      SAME config still mints (the sibling is the required control arm).
//   3. An exemption registered AFTER an item is already open does not
//      delete or refresh that item — only NEW minting is suppressed.
//      SPEC AMBIGUITY (flagged in the handoff): the decision record does
//      not explicitly say what happens to a pre-existing open item; this
//      test pins the most literal reading of "the exemption suppresses the
//      mint" (mint = create-or-refresh, per 19b506ce's own site).
//   4. A MISSING (unresolvable) cited decision voids the exemption: mints,
//      naming the slug, the cited id, and the void reason. Per-slug dedup
//      still holds across repeated void-exemption writes.
//   5. A SUPERSEDED cited decision voids the exemption likewise, with
//      distinct void-reason language from a merely-missing citation.
// ---------------------------------------------------------------------------

function harness(configOverrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oversize-exempt-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({
    store,
    now: () => NOW,
    config: parseConfig({ article_oversize_chars: 200, ...configOverrides }),
  });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

// Two SterlingTools instances sharing ONE store, so the second can be built
// with a config the first didn't have — models "the exemption entry was
// registered after the article was already oversize and already minted."
function twoStageHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oversize-exempt-2stage-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, cleanup };
}

function toolsFor(store: SterlingStore, configOverrides: Record<string, unknown> = {}) {
  return new SterlingTools({
    store,
    now: () => NOW,
    config: parseConfig({ article_oversize_chars: 200, ...configOverrides }),
  });
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
  }).record as unknown as { id: string };

const mkDecision = (tools: SterlingTools, title: string) =>
  tools.knowledgeCreate('decision', {
    title,
    statement: 'a settled ruling',
    alternatives_rejected: [],
    rationale: 'because',
  }).record as unknown as { id: string };

function items(tools: SterlingTools) {
  return tools.maintenanceQuery({ system_reason: 'article_oversize', cap: 1000 }) as unknown as Array<{
    id: string;
    text: string;
    file_keys?: string[];
  }>;
}

test('article_oversize exemption CONTROL: an over-threshold article with NO exemption entry mints exactly as today (board 8390f8fa baseline, unaffected by 881baf13)', () => {
  const { tools, cleanup } = harness(); // no article_oversize_exempt key at all
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    tools.knowledgeUpdateResult(article.id, { state: 'active' });

    const mintedItems = items(tools);
    assert.equal(
      mintedItems.length,
      1,
      'over threshold, no exemption in play — mints exactly one item, as the pre-existing mechanism does'
    );
    assert.match(mintedItems[0].text, /article_oversize_chars threshold/);
    assert.match(mintedItems[0].text, /'thing'/, 'names the article');

    // Baseline shape the void-path tests (below) must diverge from: a plain
    // mint carries no decision-citation / void-reason vocabulary.
    assert.doesNotMatch(
      mintedItems[0].text,
      /void|missing decision|superseded decision|dead citation/i,
      'a plain (non-exemption-adjacent) mint carries no void-reason language'
    );
  } finally {
    cleanup();
  }
});

test('article_oversize exemption: an entry citing a LIVE decision suppresses the mint, scoped to its own slug — a sibling non-exempted article in the SAME config still mints (881baf13)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-oversize-exempt-scope-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const seed = new SterlingTools({ store, now: () => NOW, config: parseConfig({ article_oversize_chars: 200 }) });
  try {
    const liveDecision = mkDecision(seed, 'settled: exemption citation target');

    const tools = new SterlingTools({
      store,
      now: () => NOW,
      config: parseConfig({
        article_oversize_chars: 200,
        article_oversize_exempt: { exempted: liveDecision.id },
      }),
    });

    const exempted = mkArticle(tools, 'exempted', 'src/exempted.ts');
    tools.knowledgeUpdateResult(exempted.id, { state: 'active' });
    assert.equal(
      items(tools).length,
      0,
      'the exempted slug, citing a live decision, must not mint — this is the treatment arm'
    );

    const plain = mkArticle(tools, 'plain', 'src/plain.ts');
    tools.knowledgeUpdateResult(plain.id, { state: 'active' });
    const after = items(tools);
    assert.equal(
      after.length,
      1,
      'CONTROL ARM (same config, same run): a sibling article NOT named in the exemption register still mints — proves the zero above is the exemption doing work, not a broken detector'
    );
    assert.match(after[0].text, /'plain'/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('article_oversize exemption: registering the exemption AFTER an item is already open does not delete or refresh that item — only NEW minting is suppressed (881baf13; spec silent on existing items — see report)', () => {
  const { store, cleanup } = twoStageHarness();
  try {
    const stage1 = toolsFor(store); // no exemption yet
    const article = mkArticle(stage1, 'thing', 'src/thing.ts');
    stage1.knowledgeUpdateResult(article.id, { state: 'active' });
    const before = items(stage1);
    assert.equal(before.length, 1, 'one item minted before any exemption exists');
    const beforeItem = before[0];

    const liveDecision = mkDecision(stage1, 'settled: exemption citation target');

    // A second tools instance, same store, NOW carrying the exemption —
    // models config being edited after the item already opened.
    const stage2 = toolsFor(store, { article_oversize_exempt: { thing: liveDecision.id } });
    const head = (stage2.knowledgeQuery({ types: ['feature_article'] })[0] as unknown as { id: string }).id;
    // A files[] growth write — under the OLD (pre-exemption-aware) mechanism
    // this is exactly the shape that refreshes the open item in place
    // (19b506ce, and tools.test.ts's board-3acb0126 test).
    stage2.knowledgeUpdateResult(head, {
      files: [
        { path: 'src/thing.ts', role: 'impl' },
        { path: 'src/thing.test.ts', role: 'tests' },
      ],
    });

    const after = items(stage2);
    assert.equal(after.length, 1, 'still exactly one item — the exemption must not delete the pre-existing item');
    assert.equal(after[0].id, beforeItem.id, 'same item, same id — not replaced');
    assert.ok(
      !(after[0].file_keys ?? []).includes('src/thing.test.ts'),
      'the exemption suppresses the MINT entirely, including the refresh-in-place step — the item is left exactly as it was, not updated to track the new file'
    );
  } finally {
    cleanup();
  }
});

test('article_oversize exemption: a MISSING (unresolvable) cited decision voids the exemption — mints, naming the slug, the cited id, and the void reason (881baf13 P5 fail-loud)', () => {
  const missingId = randomUUID();
  const { tools, cleanup } = harness({ article_oversize_exempt: { thing: missingId } });
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    tools.knowledgeUpdateResult(article.id, { state: 'active' });

    const mintedItems = items(tools);
    assert.equal(mintedItems.length, 1, 'a dead citation voids the exemption — the mint proceeds');
    assert.match(mintedItems[0].text, /'thing'/, 'names the article slug');
    assert.match(mintedItems[0].text, new RegExp(missingId), 'names the cited (unresolvable) decision id');
    assert.match(
      mintedItems[0].text,
      /missing|not found|no record|unresolvable|unresolved/i,
      'states WHY the exemption is void — never a silent fallback to the plain mint (P5)'
    );

    // Dedup (19b506ce) still holds on the void path: a second oversize
    // write refreshes the SAME item, never a second one.
    const head2 = (tools.knowledgeQuery({ types: ['feature_article'] })[0] as unknown as { id: string }).id;
    tools.knowledgeUpdateResult(head2, { state: 'active' });
    assert.equal(items(tools).length, 1, 'the void path still dedups per-slug — no duplicate item');
  } finally {
    cleanup();
  }
});

test('article_oversize exemption: a SUPERSEDED cited decision voids the exemption — mints, naming the slug, the (dead) cited id, and a void reason distinct from a missing citation (881baf13)', () => {
  const seedDir = mkdtempSync(join(tmpdir(), 'sterling-oversize-exempt-superseded-'));
  const store = new SterlingStore(join(seedDir, 'sterling.db'));
  const seed = new SterlingTools({ store, now: () => NOW, config: parseConfig({ article_oversize_chars: 200 }) });
  try {
    const original = mkDecision(seed, 'a ruling that will be superseded');
    seed.knowledgeSupersede(original.id, {
      title: 'a ruling that will be superseded v2',
      statement: 'the replacement ruling',
      alternatives_rejected: [],
      rationale: 'because, again',
    });
    // original.id now resolves to a status:'superseded' tombstone (see the
    // knowledge_get-by-prefix test in tools.test.ts) — a DEAD citation.

    const tools = new SterlingTools({
      store,
      now: () => NOW,
      config: parseConfig({
        article_oversize_chars: 200,
        article_oversize_exempt: { thing: original.id },
      }),
    });
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    tools.knowledgeUpdateResult(article.id, { state: 'active' });

    const mintedItems = items(tools);
    assert.equal(mintedItems.length, 1, 'a superseded citation voids the exemption — the mint proceeds');
    assert.match(mintedItems[0].text, /'thing'/, 'names the article slug');
    assert.match(mintedItems[0].text, new RegExp(original.id), 'names the cited (dead) decision id');
    assert.match(
      mintedItems[0].text,
      /superseded|retired|no longer live|dead/i,
      'states WHY the exemption is void — distinct wording territory from a merely-missing citation'
    );
  } finally {
    store.close();
    rmSync(seedDir, { recursive: true, force: true });
  }
});
