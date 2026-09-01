// ---------------------------------------------------------------------------
// SPEC-ONLY pins for three read-surface changes to the MCP tool layer
// (packages/mcp-server/src/tools.ts), written BLIND to the in-flight coder
// diff — H4 forbids reading tools.ts while it is being edited in parallel.
// Every method name / envelope shape used below is drawn from sibling test
// files, the only legitimate source for a spec-only oracle under this role's
// contract: id-resolution.test.ts, board-remove-prefix-collision-guard.test.ts,
// board-maintenance-id-resolution.test.ts, tools.test.ts, count-projection.test.ts,
// board-api-gaps.test.ts. Board items opened this session (all objective
// 'feedback-aug-2026'):
//
// SPEC 1 (board 2e71d464 — links ladder): knowledge_link's `to` (and `from`)
// address resolves through the SAME id ladder as knowledge_get (full uuid,
// exact slug, unambiguous 8-char prefix) before links[].target_id is
// written. Ambiguous prefixes are refused, never picked. The destructive
// board_remove/maintenance_remove path is UNCHANGED — decision 6d5a6719
// (id-ladder-extends-to-board-tools-with-collision-guard) stands: exact id
// only, no guard, no prefix rung, for anything that hard-deletes.
//
// SPEC 2 (board a577a69d — absence query): knowledge_query gains optional
// min_score; passing it adds `above_threshold: N` to the envelope, counted
// over the FULL match set (never the capped window) — the "is anything
// ruled about X, at all" signal a capped result cannot serve.
// ASSUMPTION FLAGGED: the sign convention of the underlying score is not
// declared anywhere reachable without reading tools.ts — only that
// min_score is a floor and higher-scoring records are the ones that
// qualify. Pins below use astronomically extreme thresholds (±1e9) on
// purpose so the assertions hold regardless of the real score's scale,
// as long as "higher score is more relevant" holds (the only reading
// consistent with the board item's "nothing ruled here" framing).
//
// SPEC 3 (board b786a84f — board at scale): board_query/maintenance_query
// gain projection:'headline' (id, priority, objective on a user item /
// system_reason on a system item, ~80-char text clip) and offset
// (deterministic pagination). ASSUMPTION FLAGGED: the exact field name
// carrying the grouping label on a user item (`objective`) is taken from
// board_add's existing, already-shipped parameter of the same name
// (decision a8d2ce6c) — not from the in-flight diff.
//
// New params/literals not yet in the declared types (min_score, offset,
// projection:'headline') are passed through an `as unknown as
// Record<string, unknown>` cast at the call site — the SAME convention
// board-api-gaps.test.ts already uses for a not-yet-declared field
// (`feature_slug`), so a still-closed param type fails at compile time
// (TS2353/TS2345) rather than being silently accepted; either that or the
// runtime assertion is the correct red shape for a field that does not
// exist yet.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-24T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-read-surface-wave-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function mkDecision(tools: SterlingTools, title: string, extra: Loose = {}): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
    ...extra,
  }).record as unknown as Loose;
}

function linksOf(record: Loose): { rel: string; target_id: string }[] {
  return (record.links as { rel: string; target_id: string }[] | undefined) ?? [];
}

function widen(p: Loose): Record<string, unknown> {
  return p as unknown as Record<string, unknown>;
}

// Forces a second record sharing `primaryId`'s 8-char prefix — the standing
// convention (id-resolution.test.ts, tools.test.ts, board-maintenance-id-
// resolution.test.ts) for constructing a genuine ambiguity: ids are
// server-minted, so a collision cannot be reached through the public create
// tool alone.
function seedPrefixTwin(store: SterlingStore, tools: SterlingTools, primaryId: string): string {
  const prefix = primaryId.slice(0, 8);
  const seed = mkDecision(tools, 'ambiguity twin seed');
  store.create({
    ...(JSON.parse(JSON.stringify(seed)) as Loose),
    id: `${prefix}-0000-4000-8000-000000000000`,
  });
  return prefix;
}

// The standing refusal-content contract for destructive board/maintenance
// paths (decision 6d5a6719, already pinned by board-maintenance-id-
// resolution.test.ts): flexible on exact wording, pinned on the substance.
const FULL_UUID_REQUIRED = /full uuid|full id/i;

// ===========================================================================
// SPEC 1 — links[].target_id resolves through the id ladder (board 2e71d464)
// ===========================================================================

test('SPEC1(a) CONTROL: knowledge_link stores links[].target_id from a full-uuid `to` address, read back on the resolved record', () => {
  const { tools, cleanup } = harness();
  try {
    const from = mkDecision(tools, 'link ctrl source');
    const to = mkDecision(tools, 'link ctrl target');

    tools.knowledgeLink(from.id as string, 'informed_by', to.id as string);

    const got = tools.knowledgeGet(from.id as string) as unknown as Loose;
    assert.ok(
      linksOf(got).some((l) => l.rel === 'informed_by' && l.target_id === to.id),
      'a full-uuid `to` address is stored and reads back as the resolved (here: identical) full id — baseline, does not exercise the ladder'
    );
  } finally {
    cleanup();
  }
});

test('SPEC1(b): an unambiguous 8-char prefix `to` address creates the edge to the RIGHT record — read back shows the RESOLVED full id, never the raw prefix', () => {
  const { tools, cleanup } = harness();
  try {
    const from = mkDecision(tools, 'link prefix source');
    const to = mkDecision(tools, 'link prefix target');
    const prefix = (to.id as string).slice(0, 8);

    tools.knowledgeLink(from.id as string, 'informed_by', prefix);

    const got = tools.knowledgeGet(from.id as string) as unknown as Loose;
    const stored = linksOf(got).find((l) => l.rel === 'informed_by');
    assert.ok(stored, 'the link landed on the from-record');
    assert.equal(
      stored!.target_id,
      to.id,
      'target_id is the RESOLVED full id of the record the prefix names — not the raw 8-char string'
    );
    assert.notEqual(stored!.target_id, prefix, 'sanity: the resolved id is strictly longer than the raw prefix it was given');
  } finally {
    cleanup();
  }
});

test('SPEC1(c): an AMBIGUOUS 8-char prefix `to` address is refused naming the candidate count — no edge is created', () => {
  const { store, tools, cleanup } = harness();
  try {
    const from = mkDecision(tools, 'link ambiguity source');
    const to = mkDecision(tools, 'link ambiguity target');
    const prefix = seedPrefixTwin(store, tools, to.id as string);

    assert.throws(
      () => tools.knowledgeLink(from.id as string, 'informed_by', prefix),
      (err: Error) => {
        assert.match(err.message, /ambiguous/i, 'refused as ambiguous, matching knowledge_get\'s own refusal shape');
        assert.match(err.message, /2/, 'names the candidate count — 2 records share this prefix');
        return true;
      },
      'a `to` address that resolves to more than one record must never be silently picked'
    );

    const got = tools.knowledgeGet(from.id as string) as unknown as Loose;
    assert.deepEqual(linksOf(got), [], 'the ambiguous-prefix call wrote NOTHING — the from-record has no links at all');
  } finally {
    cleanup();
  }
});

test('SPEC1(d): destroying paths are UNCHANGED by the links-ladder fix — board_remove still refuses an 8-char prefix, even an unambiguous one, and the item survives (decision 6d5a6719: exact id only stands)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: item } = tools.boardAdd({ text: 'links-ladder must not loosen board_remove', source: 'user' }) as unknown as {
      record: Loose;
    };
    const prefix = (item.id as string).slice(0, 8);

    assert.throws(
      () => tools.boardRemove(prefix),
      (err: Error) => {
        assert.match(err.message, FULL_UUID_REQUIRED, `board_remove must still demand the full uuid — got: "${err.message}"`);
        return true;
      },
      'the exact-id-only rule for destroying paths is untouched by the links ladder extension'
    );

    const remaining = tools.boardQuery({ source: 'user' }) as unknown as Loose[];
    assert.equal(remaining.length, 1, 'the item was NOT removed by the refused prefix call');
    assert.equal(remaining[0].id, item.id);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPEC 1 (STRENGTHENED, roster-review follow-up) — the NEW resolveLinksTargets
// call sites: knowledgeCreate's own `links` field (tools.ts:907),
// knowledgeUpdate's `overrides.links` (tools.ts:2917-2919), and
// knowledgeSupersede's `fields.links` (tools.ts:4373). SPEC1(a)-(d) above
// exercised ONLY knowledge_link, which the brief itself said was already
// resolved — deleting these three call sites left that block green. These
// four pins bind to READ-BACK STATE (the persisted record's own links[]),
// never to error text alone, and (3)'s no-partial-write assertion is the
// load-bearing half per the follow-up's own framing.
//
// Confirmed accepted shape: `links` IS a legitimate field in knowledgeCreate's
// create body (knowledge-stats.test.ts already calls
// `tools.knowledgeCreate('decision', { ..., links: [] })` with an empty
// array, unrefused) and decisions accept an explicit `slug` override
// (knowledge-supersede.test.ts AC9). knowledgeSupersede's `fields` is
// documented there as "a COMPLETE new-record body of the SAME type" — since
// `links` is a real field on the type, it rides the same body.
// ---------------------------------------------------------------------------

test('SPEC1-CREATE(1): knowledgeCreate accepts links[].target_id as an exact SLUG — the stored edge on the newly-created record carries the RESOLVED full uuid, not the slug string', () => {
  const { tools, cleanup } = harness();
  try {
    const target = mkDecision(tools, 'create-links-slug-target', { slug: 'create-links-slug-target-slug' });

    const created = tools.knowledgeCreate('decision', {
      title: 'create-links-slug-source',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'informed_by', target_id: 'create-links-slug-target-slug' }],
    }).record as unknown as Loose;

    // read-back on the PERSISTED record, not just the create echo — the echo
    // and the stored row must agree.
    const got = tools.knowledgeGet(created.id as string) as unknown as Loose;
    const stored = linksOf(got).find((l) => l.rel === 'informed_by');
    assert.ok(stored, 'the link was written at create time');
    assert.equal(stored!.target_id, target.id, 'target_id is the RESOLVED full uuid the slug names, not the raw slug string');
    assert.notEqual(stored!.target_id, 'create-links-slug-target-slug', 'sanity: the resolved id is not literally the slug that was given');
  } finally {
    cleanup();
  }
});

test('SPEC1-UPDATE(2): knowledgeUpdate\'s overrides.links resolves an unambiguous 8-char prefix — the STORED record (read back fresh) carries the resolved full uuid', () => {
  const { tools, cleanup } = harness();
  try {
    const from = mkDecision(tools, 'update-links-prefix-source');
    const to = mkDecision(tools, 'update-links-prefix-target');
    const prefix = (to.id as string).slice(0, 8);

    tools.knowledgeUpdate(from.id as string, { links: [{ rel: 'informed_by', target_id: prefix }] });

    const got = tools.knowledgeGet(from.id as string) as unknown as Loose;
    const stored = linksOf(got).find((l) => l.rel === 'informed_by');
    assert.ok(stored, 'the link landed via overrides.links');
    assert.equal(stored!.target_id, to.id, 'the prefix in overrides.links resolved to the RESOLVED full id, read back from the stored record');
    assert.notEqual(stored!.target_id, prefix, 'sanity: strictly longer than the raw prefix supplied');
  } finally {
    cleanup();
  }
});

test('SPEC1-CREATE(3): an AMBIGUOUS 8-char prefix in knowledgeCreate\'s links[].target_id is refused naming the candidate count, AND — the load-bearing half — NO record is written at all, not even the source record itself (no partial write)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const to = mkDecision(tools, 'create-ambiguity-target');
    const prefix = seedPrefixTwin(store, tools, to.id as string);

    // Captured AFTER all setup, so it isolates exactly what the refused call
    // below must add: nothing.
    const before = tools.knowledgeQuery({ types: ['decision'] }).length;

    assert.throws(
      () =>
        tools.knowledgeCreate('decision', {
          title: 'create-ambiguity-source',
          statement: 's',
          alternatives_rejected: [],
          rationale: 'r',
          links: [{ rel: 'informed_by', target_id: prefix }],
        }),
      (err: Error) => {
        assert.match(err.message, /ambiguous/i, 'refused as ambiguous');
        assert.match(err.message, /2/, 'names the candidate count — 2 records share this prefix');
        return true;
      },
      'a create whose links[].target_id is ambiguous must be refused, never silently pick one candidate'
    );

    // LOAD-BEARING: the source record must not exist EITHER — a partial write
    // (source created, then the link discovered ambiguous) is exactly the
    // hazard a deleted resolveLinksTargets call site at knowledgeCreate would
    // reopen, and a bare error-text check cannot see it.
    assert.equal(
      tools.knowledgeQuery({ types: ['decision'] }).length,
      before,
      'no partial write: the ambiguous link target must abort creation of the source record too, not just omit the link'
    );
    assert.ok(
      !tools.knowledgeQuery({ types: ['decision'] }).some((r) => (r as unknown as Loose).title === 'create-ambiguity-source'),
      'the source record by its distinctive title is nowhere in the store'
    );
  } finally {
    cleanup();
  }
});

test('SPEC1-SUPERSEDE(4): knowledgeSupersede\'s fields.links resolves an 8-char prefix — the NEW record it mints (read back fresh) carries the resolved full uuid', () => {
  const { tools, cleanup } = harness();
  try {
    const linkTarget = mkDecision(tools, 'supersede-links-target');
    const oldSource = mkDecision(tools, 'supersede-links-source');
    const prefix = (linkTarget.id as string).slice(0, 8);

    tools.knowledgeSupersede(oldSource.id as string, {
      title: 'supersede-links-source-v2',
      statement: 's2',
      alternatives_rejected: [],
      rationale: 'r2',
      links: [{ rel: 'informed_by', target_id: prefix }],
    });

    const pinnedOld = tools.knowledgeGet(oldSource.id as string) as unknown as Loose;
    assert.equal(pinnedOld.status, 'superseded', 'precondition: the supersede landed');
    const newId = pinnedOld.superseded_by as string;

    const newRec = tools.knowledgeGet(newId) as unknown as Loose;
    const stored = linksOf(newRec).find((l) => l.rel === 'informed_by');
    assert.ok(stored, 'the new record minted by supersede carries the link');
    assert.equal(stored!.target_id, linkTarget.id, 'fields.links resolved the 8-char prefix to the RESOLVED full id on the new record, read back fresh');
    assert.notEqual(stored!.target_id, prefix, 'sanity: strictly longer than the raw prefix supplied');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC 2 — knowledge_query min_score / above_threshold (board a577a69d)
// ===========================================================================

test('SPEC2(a) CONTROL: omitting min_score leaves the envelope byte-compatible — no above_threshold key, the existing {matched_filter, returned, cap, capped} shape unchanged', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 3; i++) mkDecision(tools, `plain decision ${i}`);

    const result = tools.knowledgeQueryResult({ types: ['decision'] }) as unknown as Loose;

    assert.ok(!('above_threshold' in result), 'above_threshold must be ABSENT when min_score is never passed');
    assert.equal(result.matched_filter, 3);
    assert.equal(typeof result.returned, 'number');
    assert.equal(typeof result.cap, 'number');
    assert.equal(typeof result.capped, 'boolean');
    assert.ok(Array.isArray(result.records));
  } finally {
    cleanup();
  }
});

test('SPEC2(b): min_score above every real score yields above_threshold: 0 (the nothing-ruled-here signal), with a CONTROL ARM FIRST proving above_threshold tracks the threshold rather than being hardcoded', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 5; i++) {
      mkDecision(tools, `chassis interchange ruling ${i}`, {
        statement: `The chassis chassis chassis interchange holds for build ${i}.`,
      });
    }

    // CONTROL ARM (placed FIRST): an absurdly LOW threshold must qualify
    // every scored record. This rules out an implementation that always
    // reports above_threshold: 0 (or always some fixed number) regardless
    // of the threshold actually passed — the verdict below only means
    // something once this control has passed for the OPPOSITE reason.
    const low = tools.knowledgeQueryResult(
      widen({ types: ['decision'], rank_terms: ['chassis'], min_score: -1e9 })
    ) as unknown as { matched_filter: number; above_threshold?: number };
    assert.equal(low.matched_filter, 5);
    assert.equal(
      low.above_threshold,
      5,
      'CONTROL: an absurdly low threshold qualifies every matched record — above_threshold is not hardcoded to 0'
    );

    // PINNED VERDICT: an absurdly HIGH threshold qualifies none.
    const high = tools.knowledgeQueryResult(
      widen({ types: ['decision'], rank_terms: ['chassis'], min_score: 1e9 })
    ) as unknown as { matched_filter: number; above_threshold?: number };
    assert.equal(high.matched_filter, 5, 'matched_filter is untouched by min_score — it counts the FILTER, not the threshold');
    assert.equal(
      high.above_threshold,
      0,
      'above_threshold: 0 is the usable "nothing ruled here" signal, distinct from matched_filter > 0'
    );
  } finally {
    cleanup();
  }
});

test('SPEC2(c): above_threshold counts over the FULL match set, beyond the capped window — N can exceed returned', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 10; i++) {
      mkDecision(tools, `socket clip ruling ${i}`, {
        statement: `The socket socket socket clip clip fits build ${i}.`,
      });
    }

    const result = tools.knowledgeQueryResult(
      widen({ types: ['decision'], rank_terms: ['socket'], cap: 3, min_score: -1e9 })
    ) as unknown as { matched_filter: number; returned: number; capped: boolean; above_threshold?: number };

    assert.equal(result.matched_filter, 10);
    assert.equal(result.returned, 3, 'the WINDOW is still capped at 3');
    assert.equal(result.capped, true);
    assert.equal(
      result.above_threshold,
      10,
      'above_threshold is counted over the FULL 10-record match set, not the 3-record returned window'
    );
    assert.ok(result.above_threshold! > result.returned, 'the whole point of the fix: N can exceed returned');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC 3 — board_query/maintenance_query projection:'headline' + offset
// (board b786a84f)
// ===========================================================================

test("SPEC3(a): projection:'headline' returns id, priority, objective (user item) / system_reason (system item), and a ~80-char text clip — not the full body", () => {
  const { tools, cleanup } = harness();
  try {
    const longText = `HEADLINE-MARKER-${'Q'.repeat(60)}-TAIL-${'z'.repeat(200)}`;
    const maintText = `MAINT-MARKER-${'Q'.repeat(60)}-TAIL-${'z'.repeat(200)}`;
    tools.boardAdd({ text: longText, source: 'user', priority: 'high', objective: 'headline-wave-objective' });
    tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: maintText,
      file_keys: ['src/headline-wave.ts'],
    });

    const userHeadline = tools.boardQueryResult(
      widen({ source: 'user', projection: 'headline' })
    ) as unknown as { records: Loose[] };
    const [u] = userHeadline.records;
    assert.ok(u.id, 'headline carries the id');
    assert.equal(u.priority, 'high', 'headline carries priority');
    assert.equal(u.objective, 'headline-wave-objective', 'headline carries objective for a user item');
    assert.ok(!('system_reason' in u), 'a user item never carries system_reason');
    const uText = u.text as string;
    assert.ok(uText.length < longText.length, 'the text is CLIPPED, not the full 280+ char body');
    assert.ok(uText.length <= 100, `clip is ~80 chars, got ${uText.length}`);
    assert.ok(longText.startsWith(uText.slice(0, 40)), 'the clip is a genuine PREFIX of the original text, not a summary');

    const maintHeadline = tools.maintenanceQueryResult(
      widen({ projection: 'headline' })
    ) as unknown as { records: Loose[] };
    const [m] = maintHeadline.records;
    assert.ok(m.id, 'headline carries the id');
    assert.ok('priority' in m, 'headline still carries priority on a system item');
    assert.equal(m.system_reason, 'reconcile_needed', 'headline carries system_reason for a system item');
    assert.ok(!('objective' in m) || m.objective === undefined, 'a system item never carries a user objective');
    const mText = m.text as string;
    assert.ok(mText.length < maintText.length, 'the maintenance text is CLIPPED too');
    assert.ok(mText.length <= 100, `clip is ~80 chars, got ${mText.length}`);
  } finally {
    cleanup();
  }
});

test('SPEC3(b): offset pages board_query deterministically — offset:0 and offset:3 partition the FULL 6-item set with no duplicates and no gaps, under a stable order', () => {
  const { tools, cleanup } = harness();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { record } = tools.boardAdd({ text: `offset-item-${i}`, source: 'user' }) as unknown as { record: Loose };
      ids.push(record.id as string);
    }

    const baseline = tools.boardQueryResult({ source: 'user', cap: 100 }) as unknown as { records: Loose[] };
    assert.equal(baseline.records.length, 6, 'sanity: all 6 items visible unpaged');
    const baselineIds = baseline.records.map((r) => r.id as string);

    const page1 = tools.boardQueryResult(widen({ source: 'user', cap: 3, offset: 0 })) as unknown as { records: Loose[] };
    const page2 = tools.boardQueryResult(widen({ source: 'user', cap: 3, offset: 3 })) as unknown as { records: Loose[] };

    assert.deepEqual(
      page1.records.map((r) => r.id),
      baselineIds.slice(0, 3),
      'offset:0 is exactly the FIRST 3 of the SAME stable order the unpaged query uses'
    );
    assert.deepEqual(
      page2.records.map((r) => r.id),
      baselineIds.slice(3, 6),
      'offset:3 is exactly the NEXT 3 of that same order — no gap, no re-shuffle'
    );

    const seen = new Set([...page1.records.map((r) => r.id), ...page2.records.map((r) => r.id)]);
    assert.equal(seen.size, 6, 'no duplicates across the two pages');
    for (const id of ids) assert.ok(seen.has(id), 'every seeded item is covered exactly once across both pages');
  } finally {
    cleanup();
  }
});

test('SPEC3(c): offset at/past the end of the match set returns EMPTY records with the TRUE total still disclosed — never an error', () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 4; i++) tools.boardAdd({ text: `end-item-${i}`, source: 'user' });

    const atEnd = tools.boardQueryResult(widen({ source: 'user', cap: 10, offset: 4 })) as unknown as {
      records: Loose[];
      matched_filter: number;
    };
    assert.deepEqual(atEnd.records, [], 'offset exactly at the end yields no records');
    assert.equal(atEnd.matched_filter, 4, 'the TRUE total is still disclosed, not zeroed out by the empty page');

    const pastEnd = tools.boardQueryResult(widen({ source: 'user', cap: 10, offset: 999 })) as unknown as {
      records: Loose[];
      matched_filter: number;
    };
    assert.deepEqual(pastEnd.records, [], 'offset far past the end also yields no records, not an error');
    assert.equal(pastEnd.matched_filter, 4, 'the true total is disclosed here too');
  } finally {
    cleanup();
  }
});

test("SPEC3(d) CONTROL: existing projection:'digest' output is UNCHANGED by adding 'headline' and offset — clipped text with an ellipsis, priority preserved, same returned count", () => {
  const { tools, cleanup } = harness();
  try {
    for (let i = 0; i < 5; i++) {
      tools.boardAdd({ text: `digest-item-${i}: ${'y'.repeat(2000)}`, source: 'user', priority: 'high' });
    }

    const full = tools.boardQueryResult({ source: 'user' }) as unknown as { records: Loose[]; returned: number };
    const digest = tools.boardQueryResult({ source: 'user', projection: 'digest' }) as unknown as {
      records: Loose[];
      returned: number;
    };

    assert.equal(digest.returned, full.returned, 'digest still returns the SAME COUNT of items as full — unaffected by the headline addition');
    const [item] = digest.records;
    // /^digest-item-\d/ not -0: all five fixtures share one updated_at under
    // the fixed clock, so which tied item leads belongs to the (updated_at
    // DESC, id DESC) total order (board abafbd48); this pin's subject is the
    // clip shape only.
    assert.match(item.text as string, /^digest-item-\d/, 'digest still clips FROM THE START, not dropping the item');
    assert.match(item.text as string, /…$/, 'digest still ends in the clip ellipsis — unchanged shape');
    assert.equal(item.priority, 'high', 'the triage field still survives on digest, unchanged');
  } finally {
    cleanup();
  }
});
