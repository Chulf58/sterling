import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// ---------------------------------------------------------------------------
// MIDDLE-OUT history rotation (board ab87fe24-5a39-4e51-9b36-b165d96a628d).
//
// NEW SPEC (replacing the old "keep newest max, drop oldest" behavior pinned
// elsewhere in tools.test.ts around board 0697c6bd):
//   - config.article_history_genesis_entries (default 2) sits beside
//     config.article_history_max_entries.
//   - On rotation (history length > max after an append/update), the live
//     record keeps the FIRST genesis_entries entries (founding/genesis, by
//     array position) PLUS the NEWEST (max - genesis_entries) entries. The
//     entries strictly between those two windows are evicted. Total stays
//     exactly max.
//   - genesis_entries >= max is degenerate: effective genesis keep clamps to
//     max - 1, so at least one recent entry always survives.
//   - Evicted entries are never lost: the pre-rotation version that held them
//     is retained (superseded) and still readable via knowledge_get.
//
// Entries are named e1, e2, e3... in strict creation order throughout, so
// "kept vs evicted" is assertable purely by which event strings survive —
// deliberately NOT baking "genesis/mid/new" into the text, since which
// entries land in which bucket is exactly the thing under test.
// ---------------------------------------------------------------------------

const NOW = '2026-06-10T12:00:00.000Z';

function harnessWithConfig(configOverrides: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-history-rotation-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, config: parseConfig(configOverrides) });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

const ev = (event: string) => ({ date: NOW, event });

function mkArticleWithHistory(tools: SterlingTools, slug: string, historyEvents: string[]) {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: [{ path: `src/${slug}.ts`, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: historyEvents.map(ev),
    live_test_refs: [],
  }).record;
}

const eventsOf = (record: unknown) => (record as { history: { event: string }[] }).history.map((h) => h.event);

// ---------------------------------------------------------------------------
// AC1 — config.article_history_genesis_entries, default 2, sibling of
// article_history_max_entries.
// ---------------------------------------------------------------------------

test('AC1: config.article_history_genesis_entries defaults to 2, sibling of article_history_max_entries', () => {
  const defaults = parseConfig({}) as unknown as {
    article_history_genesis_entries?: number;
    article_history_max_entries?: number;
  };
  assert.equal(defaults.article_history_genesis_entries, 2, 'new sibling config key must default to 2');
  assert.equal(typeof defaults.article_history_max_entries, 'number', 'sanity: the existing sibling key is unaffected');
});

test('AC1: config.article_history_genesis_entries can be overridden independently via parseConfig', () => {
  const cfg = parseConfig({ article_history_genesis_entries: 5, article_history_max_entries: 20 }) as unknown as {
    article_history_genesis_entries?: number;
    article_history_max_entries?: number;
  };
  assert.equal(cfg.article_history_genesis_entries, 5, 'the override must round-trip');
  assert.equal(cfg.article_history_max_entries, 20, 'and does not interfere with the sibling override');
});

// ---------------------------------------------------------------------------
// AC2 — rotation keeps GENESIS + RECENT, evicting the MIDDLE.
// ---------------------------------------------------------------------------

test('AC2: rotation keeps the first genesis_entries plus the newest (max - genesis_entries), evicting the middle', () => {
  const { tools, cleanup } = harnessWithConfig({ article_history_max_entries: 5, article_history_genesis_entries: 2 });
  try {
    const v1 = mkArticleWithHistory(tools, 'thing', ['e1']); // 1 entry so far
    // grow past the cap in one shot: total becomes 7 (e1..e7), cap is 5
    const appended = tools.knowledgeAppend(v1.id, 'history', ['e2', 'e3', 'e4', 'e5', 'e6', 'e7'].map(ev));

    // NEW SPEC: keep first 2 (e1, e2) + newest 3 (e5, e6, e7); e3 and e4 (the
    // middle) are evicted. The OLD spec would instead keep the newest 5
    // ([e3,e4,e5,e6,e7]) dropping e1 and e2 — this assertion fails loudly
    // against that old behavior (e1/e2 missing from the front).
    assert.deepEqual(
      eventsOf(appended.record),
      ['e1', 'e2', 'e5', 'e6', 'e7'],
      'genesis (e1,e2) survive at the front, newest 3 (e5,e6,e7) survive at the back, e3/e4 evicted from the middle'
    );
    assert.equal(eventsOf(appended.record).length, 5, 'total stays exactly at max');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC3 — repeated rotations are stable: genesis entries stay fixed, the
// recent window slides.
// ---------------------------------------------------------------------------

test('AC3: repeated rotations keep the same genesis entries fixed while the newest window slides', () => {
  const { tools, cleanup } = harnessWithConfig({ article_history_max_entries: 4, article_history_genesis_entries: 1 });
  try {
    let article = mkArticleWithHistory(tools, 'thing', ['e1']); // 1 entry

    // grow to exactly the cap (4): e1,e2,e3,e4 — no rotation yet.
    let appended = tools.knowledgeAppend(article.id, 'history', ['e2', 'e3', 'e4'].map(ev));
    assert.deepEqual(eventsOf(appended.record), ['e1', 'e2', 'e3', 'e4'], 'exactly at cap — untouched, no rotation yet');
    assert.deepEqual(appended.warnings, [], 'no rotation at exactly the cap');

    // append e5: total 5 > 4. genesis keep = 1 (e1). newest keep = 3 -> e3,e4,e5.
    // e2 is evicted this round.
    article = appended.record;
    appended = tools.knowledgeAppend(article.id, 'history', [ev('e5')]);
    assert.deepEqual(
      eventsOf(appended.record),
      ['e1', 'e3', 'e4', 'e5'],
      'first rotation: genesis e1 fixed at front, newest 3 (e3,e4,e5) at back, e2 evicted'
    );

    // append e6: total 5 > 4 again. genesis STILL e1 (unchanged, stable across
    // rotations). newest keep = 3 -> e4,e5,e6. e3 — kept in the FIRST rotation
    // — is now evicted as the recent window slides forward.
    article = appended.record;
    appended = tools.knowledgeAppend(article.id, 'history', [ev('e6')]);
    assert.deepEqual(
      eventsOf(appended.record),
      ['e1', 'e4', 'e5', 'e6'],
      'second rotation: e1 still fixed at front (stability), window slid so e3 (kept last time) is now evicted'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — degenerate config: genesis_entries >= max clamps to max - 1, so at
// least one recent entry always survives.
// ---------------------------------------------------------------------------

test('AC4: genesis_entries >= max clamps to max - 1 (max=2, genesis=2 -> first 1 + newest 1)', () => {
  const { tools, cleanup } = harnessWithConfig({ article_history_max_entries: 2, article_history_genesis_entries: 2 });
  try {
    const v1 = mkArticleWithHistory(tools, 'thing', ['e1']);
    const appended = tools.knowledgeAppend(v1.id, 'history', ['e2', 'e3'].map(ev));
    assert.deepEqual(
      eventsOf(appended.record),
      ['e1', 'e3'],
      'genesis clamps to max-1=1 (keep e1), newest keep is max-clamped=1 (keep e3); e2 evicted; at least one recent entry survives'
    );
  } finally {
    cleanup();
  }
});

test('AC4: genesis_entries far exceeding max clamps the same way (max=2, genesis=10 -> first 1 + newest 1)', () => {
  const { tools, cleanup } = harnessWithConfig({ article_history_max_entries: 2, article_history_genesis_entries: 10 });
  try {
    const v1 = mkArticleWithHistory(tools, 'thing', ['e1']);
    const appended = tools.knowledgeAppend(v1.id, 'history', ['e2', 'e3'].map(ev));
    assert.deepEqual(
      eventsOf(appended.record),
      ['e1', 'e3'],
      'a wildly over-large genesis_entries never suppresses the recent entry entirely'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC5 — no rotation under the threshold (regression control: unaffected by
// the spec change).
// ---------------------------------------------------------------------------

test('AC5: history length <= max is untouched, no warning (regression control)', () => {
  const { tools, cleanup } = harnessWithConfig({ article_history_max_entries: 5, article_history_genesis_entries: 2 });
  try {
    const v1 = mkArticleWithHistory(tools, 'thing', ['e1']);
    const appended = tools.knowledgeAppend(v1.id, 'history', ['e2', 'e3', 'e4'].map(ev));
    assert.deepEqual(eventsOf(appended.record), ['e1', 'e2', 'e3', 'e4'], 'under cap — nothing rotated');
    assert.deepEqual(appended.warnings, [], 'no rotation, no warning');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC6 — the rotation warning discloses the NEW shape: genesis/founding kept,
// middle evicted, evicted entries readable in the retained prior version.
// ---------------------------------------------------------------------------

test('AC6: the rotation warning names genesis/founding entries kept, the middle evicted, and the retained prior version', () => {
  const { tools, cleanup } = harnessWithConfig({ article_history_max_entries: 5, article_history_genesis_entries: 2 });
  try {
    const v1 = mkArticleWithHistory(tools, 'thing', ['e1']);
    const appended = tools.knowledgeAppend(v1.id, 'history', ['e2', 'e3', 'e4', 'e5', 'e6', 'e7'].map(ev));

    assert.equal(appended.warnings.length, 1, 'rotation is disclosed, never silent');
    const warning = appended.warnings[0];
    assert.match(warning, /genesis|founding/i, 'names that genesis/founding entries were kept');
    assert.match(warning, /middle/i, 'names that the evicted entries came from the middle');
    assert.match(warning, /superseded|prior version/i, 'points the reader at the retained prior version for the evicted entries');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC7 — evicted-but-retrievable: knowledge_get on the prior (superseded)
// version still shows the full pre-rotation history, including the entries
// evicted from the live head's middle window (regression control: this must
// hold regardless of which entries the head evicts).
// ---------------------------------------------------------------------------

test('AC7: knowledge_get on the prior superseded version still shows the full pre-rotation history, including the evicted middle entry', () => {
  const { tools, cleanup } = harnessWithConfig({ article_history_max_entries: 4, article_history_genesis_entries: 1 });
  try {
    let article = mkArticleWithHistory(tools, 'thing', ['e1']);
    // grow to exactly the cap (4) — no rotation, each write's record stays the
    // "prior version" candidate for the NEXT (rotating) write.
    let appended = tools.knowledgeAppend(article.id, 'history', ['e2'].map(ev));
    article = appended.record;
    appended = tools.knowledgeAppend(article.id, 'history', ['e3'].map(ev));
    article = appended.record;
    appended = tools.knowledgeAppend(article.id, 'history', ['e4'].map(ev));
    const priorId = appended.record.id; // full history [e1,e2,e3,e4], exactly at cap, untouched

    // one more append pushes past the cap and rotates the HEAD: genesis keep
    // = 1 (e1), newest keep = 3 (e3,e4,e5) — e2 is evicted from the live head.
    const rotated = tools.knowledgeAppend(priorId, 'history', [ev('e5')]);
    assert.deepEqual(eventsOf(rotated.record), ['e1', 'e3', 'e4', 'e5'], 'precondition: e2 was evicted from the live head');

    // the version that got superseded by that rotating write is `priorId` —
    // its own history was never itself rotated, so it still shows e2 in full.
    const prior = tools.knowledgeGet(priorId) as unknown as { history: { event: string }[] };
    assert.deepEqual(
      prior.history.map((h) => h.event),
      ['e1', 'e2', 'e3', 'e4'],
      'the prior version retains its full pre-rotation history, including e2 (evicted from the live head)'
    );
  } finally {
    cleanup();
  }
});
