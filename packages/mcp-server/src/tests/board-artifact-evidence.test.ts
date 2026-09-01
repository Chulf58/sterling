// board_query / maintenance_query gain derived per-item `artifact_evidence`
// (board 00fa8adb Part 1 — "SURFACE `artifact_evidence` AT QUERY TIME").
//
// SPEC (from the dispatch brief, board 00fa8adb — Part 1 only):
//   1. Every returned item carries
//        artifact_evidence: { count: number, records?: [...], file_key_check: "checked" | "skipped:no_file_keys" }
//      `records` present only when count>0, max 3 entries, each a compact
//      `{ id8, type, name }`. `count` is the FULL matched count (may exceed 3).
//   2. Evidence = durable records of types decision / anti_pattern /
//      feature_article / research_finding / disconfirmed_hypothesis /
//      open_question / reference_material that EITHER (a) touch the item's
//      file_keys OR (b) cite the item's full id / 8-char prefix anywhere in
//      their body — in BOTH arms only records with
//      created_at >= item.created_at OR updated_at >= item.created_at count.
//      Deduped across arms.
//   3. No file_keys => file_key_check: "skipped:no_file_keys"; the citation
//      arm still runs.
//   4. Envelope: artifact_evidence_provenance: "checked" on success (the
//      fail-open "unavailable:store_query_failed" shape is NOT pinned here —
//      see the ambiguity note at the bottom of this file).
//   5. Page-scoped: evidence computed only for RETURNED items.
//   6. Read-only: a query must never write to the store.
//   7. maintenance_query (system-source items) carries the same per-item field.
//   8. A record pre-dating the item (both created_at AND updated_at before
//      item.created_at) never counts, even on file_key overlap.
//   9. artifact_evidence_note on the envelope matches /verify/i and never
//      /\bdone\b|closed/i.
//
// BLIND: written from the spec text only. Per §H4 the implementation
// (tools.ts board_query region) was never read. knowledgeCreate/boardAdd/
// maintenanceEnqueue/knowledgeUpdate signatures and the envelope shape
// {matched_filter, returned, cap, capped, offset, provenance, records} are
// taken from (a) the live board_query MCP tool schema (a declared contract
// surface, not implementation) and (b) sibling test files in this directory
// (board-evidence-notice.test.ts, tools.test.ts) per the harness-pattern
// exception explicitly granted for this dispatch.
//
// ALL new-field access is cast through `Loose` (Record<string, unknown>) —
// the feature is unbuilt, so the real TS types do not declare these fields
// yet; this mirrors board-evidence-notice.test.ts's `addRaw` cast pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

// A harness with a HAND-CONTROLLED clock (not auto-ticking) so ordering
// (pre-item / at-item / post-item / post-update) is explicit and legible per
// test rather than incidental to call order.
function clockHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-artifact-evidence-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  let clock = '2026-01-01T00:00:00.000Z';
  const tools = new SterlingTools({ store, now: () => clock });
  const setClock = (iso: string) => {
    clock = iso;
  };
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { tools, store, setClock, cleanup };
}

const id8 = (id: string): string => id.slice(0, 8);

function boardAddRaw(tools: SterlingTools, args: Loose): Loose {
  return tools.boardAdd(args as unknown as Parameters<SterlingTools['boardAdd']>[0]) as unknown as Loose;
}

function itemOf(res: Loose): Loose {
  return (res.record ?? res) as Loose;
}

function knowledgeCreateRaw(tools: SterlingTools, type: string, fields: Loose): Loose {
  return (tools as unknown as { knowledgeCreate: (t: string, f: Loose) => Loose }).knowledgeCreate(type, fields);
}

function boardQueryResultRaw(tools: SterlingTools, args: Loose = {}): Loose {
  return (tools as unknown as { boardQueryResult: (a: Loose) => Loose }).boardQueryResult(args);
}

function maintenanceQueryResultRaw(tools: SterlingTools, args: Loose = {}): Loose {
  return (tools as unknown as { maintenanceQueryResult: (a: Loose) => Loose }).maintenanceQueryResult(args);
}

function maintenanceEnqueueRaw(tools: SterlingTools, args: Loose): Loose {
  return (tools as unknown as { maintenanceEnqueue: (a: Loose) => Loose }).maintenanceEnqueue(args);
}

function recordsOf(envelope: Loose): Loose[] {
  return (envelope.records ?? []) as Loose[];
}

function findItem(envelope: Loose, id: string): Loose {
  const found = recordsOf(envelope).find((r) => r.id === id);
  assert.ok(found, `precondition: item ${id} is present in the returned page`);
  return found as Loose;
}

function evidenceOf(item: Loose): Loose {
  return item.artifact_evidence as Loose;
}

const T0 = '2026-01-01T00:00:00.000Z'; // before the item exists
const T1 = '2026-01-02T00:00:00.000Z'; // item's created_at
const T2 = '2026-01-03T00:00:00.000Z'; // after the item — evidence should count
const T3 = '2026-01-04T00:00:00.000Z'; // later still — for updated_at-only cases

// ---------------------------------------------------------------------------
// 1. Basic envelope shape: an item with file_keys and NO matching evidence.
// SABOTAGE: stop attaching `artifact_evidence` to returned items at all.
// EXPECTED RED SHAPE (pre-implementation): `evidence` is `undefined`, so
// `evidence.count` throws a TypeError — right-reason crash, not a harness bug.
// ---------------------------------------------------------------------------
test('AC1 shape: an item with file_keys and no matching records gets {count:0, file_key_check:"checked"} and OMITS `records`', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    const item = itemOf(boardAddRaw(tools, { text: 'lonely item', source: 'user', objective: 'standalone', file_keys: ['src/lonely.ts'] }));

    const page = boardQueryResultRaw(tools, { source: 'user' });
    const seen = findItem(page, item.id as string);
    const evidence = evidenceOf(seen);
    assert.equal(evidence.count, 0, 'nothing has been written since — count is zero');
    assert.equal(evidence.file_key_check, 'checked', 'file_keys were present, so the file-key arm ran');
    assert.equal('records' in evidence, false, 'records is OMITTED (not an empty array) when count is 0, per spec point 1');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Adversarial case: id8-citation-only match on a KEYLESS item (spec point 3).
// SABOTAGE: disable the citation arm (only run the file-key overlap query).
// EXPECTED RED SHAPE: evidence.count stays 0 instead of becoming 1 —
// assert.equal(evidence.count, 1, ...) fails with actual 0.
// ---------------------------------------------------------------------------
test('citation-only match on a keyless item: an id8 citation alone is sufficient evidence, and file_key_check reports "skipped:no_file_keys"', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    const item = itemOf(boardAddRaw(tools, { text: 'free-floating idea, no file_keys', source: 'user', objective: 'standalone' }));

    setClock(T2);
    const decision = itemOf(
      knowledgeCreateRaw(tools, 'decision', {
        title: `references item ${id8(item.id as string)}`,
        statement: `cites ${id8(item.id as string)} as the origin of this ruling`,
        alternatives_rejected: [],
        rationale: 'R',
      })
    );

    const page = boardQueryResultRaw(tools, { source: 'user' });
    const seen = findItem(page, item.id as string);
    const evidence = evidenceOf(seen);
    assert.equal(evidence.file_key_check, 'skipped:no_file_keys', 'no file_keys on the item — the file-key arm cannot run');
    assert.equal(evidence.count, 1, 'the citation arm still runs for a keyless item and finds the decision');
    const rec = recordsOf(evidence)[0] as Loose;
    assert.equal(rec.id8, id8(decision.id as string));
    assert.equal(rec.type, 'decision');
    assert.equal(rec.name, `references item ${id8(item.id as string)}`, 'name falls back to title for a decision');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Adversarial case: file-keys-only match (no citation at all) (spec point 2a).
// SABOTAGE: disable the file-key overlap arm (only run the citation scan).
// EXPECTED RED SHAPE: evidence.count stays 0 instead of 1.
// ---------------------------------------------------------------------------
test('file-keys-only match: a record overlapping file_keys but never citing the item is sufficient evidence', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    const item = itemOf(boardAddRaw(tools, { text: 'fix the widget', source: 'user', objective: 'standalone', file_keys: ['src/widget.ts'] }));

    setClock(T2);
    const decision = itemOf(
      knowledgeCreateRaw(tools, 'decision', {
        title: 'widget fixed thus',
        statement: 'no mention of any item id here at all',
        alternatives_rejected: [],
        rationale: 'R',
        file_keys: ['src/widget.ts'],
      })
    );

    const page = boardQueryResultRaw(tools, { source: 'user' });
    const evidence = evidenceOf(findItem(page, item.id as string));
    assert.equal(evidence.file_key_check, 'checked');
    assert.equal(evidence.count, 1, 'file_key overlap alone is sufficient — no citation needed');
    const rec = recordsOf(evidence)[0] as Loose;
    assert.equal(rec.id8, id8(decision.id as string));
    assert.equal(rec.type, 'decision');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Dedup: a SINGLE record satisfying BOTH arms counts ONCE, not twice.
// This test's verdict (count===1) has two possible causes if read alone:
// real dedup, OR one of the two arms simply never firing. Tests #2 and #3
// above are this test's CONTROL, run first: each independently proves BOTH
// arms are functional in isolation (citation-only -> 1, file-key-only -> 1).
// Only given that pairing does "count===1 when both arms fire" mean dedup.
// SABOTAGE: sum the two arms' matches without de-duplicating by record id.
// EXPECTED RED SHAPE: evidence.count is 2 instead of 1.
// ---------------------------------------------------------------------------
test('dedup: a record matching BOTH the file-key arm AND the citation arm counts once (control: tests above prove each arm works alone)', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    const item = itemOf(boardAddRaw(tools, { text: 'double-hit widget', source: 'user', objective: 'standalone', file_keys: ['src/double.ts'] }));

    setClock(T2);
    knowledgeCreateRaw(tools, 'decision', {
      title: `widget fix references ${id8(item.id as string)}`,
      statement: `cites ${id8(item.id as string)} AND overlaps file_keys`,
      alternatives_rejected: [],
      rationale: 'R',
      file_keys: ['src/double.ts'],
    });

    const page = boardQueryResultRaw(tools, { source: 'user' });
    const evidence = evidenceOf(findItem(page, item.id as string));
    assert.equal(evidence.count, 1, 'one record, both arms fire, deduped to a single count');
    assert.equal(recordsOf(evidence).length, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Pre-dating exclusion (spec point 8), WITH a control placed first: a
// twin record created AFTER the item counts (control — passes for the
// "evidence exists" reason); a record created BEFORE the item, with the
// SAME file_key overlap, does NOT count, isolating the date-filter semantics
// specifically rather than "the file-key arm is broken".
// SABOTAGE: drop the `created_at/updated_at >= item.created_at` filter
// entirely (count any overlapping record regardless of age).
// EXPECTED RED SHAPE: the second item's evidence.count is 1 instead of 0.
// ---------------------------------------------------------------------------
test('pre-dating record excluded (case 8): control shows a post-dated twin counts; the pre-dated original does not', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    // CONTROL — item created first, matching record created after: counts.
    setClock(T1);
    const laterItem = itemOf(boardAddRaw(tools, { text: 'post-dated control', source: 'user', objective: 'standalone', file_keys: ['src/predate.ts'] }));
    setClock(T2);
    knowledgeCreateRaw(tools, 'decision', {
      title: 'predate control decision',
      statement: 'overlaps file_keys, created after the item',
      alternatives_rejected: [],
      rationale: 'R',
      file_keys: ['src/predate.ts'],
    });
    const controlPage = boardQueryResultRaw(tools, { source: 'user' });
    const controlEvidence = evidenceOf(findItem(controlPage, laterItem.id as string));
    assert.equal(controlEvidence.count, 1, 'CONTROL: a post-dated matching record counts — proves the file-key arm is live');

    // ACTUAL CASE — the matching record predates the item entirely.
    setClock(T0); // both created_at and updated_at of this record are T0
    knowledgeCreateRaw(tools, 'decision', {
      title: 'stale pre-existing decision',
      statement: 'overlaps file_keys, but predates the item that will cite it',
      alternatives_rejected: [],
      rationale: 'R',
      file_keys: ['src/preexisting.ts'],
    });
    setClock(T1);
    const item = itemOf(boardAddRaw(tools, { text: 'item created after a pre-existing record', source: 'user', objective: 'standalone', file_keys: ['src/preexisting.ts'] }));

    const page = boardQueryResultRaw(tools, { source: 'user' });
    const evidence = evidenceOf(findItem(page, item.id as string));
    assert.equal(evidence.count, 0, 'the record predates the item on BOTH clocks — it must not count, even though it overlaps file_keys');
    assert.equal('records' in evidence, false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. OR semantics: created_at may predate the item as long as updated_at
// does not (spec point 2's "created_at >= item.created_at OR updated_at >=
// item.created_at").
// SABOTAGE: check only created_at (AND-style / created_at-only filter).
// EXPECTED RED SHAPE: evidence.count is 0 instead of 1.
// ---------------------------------------------------------------------------
test('OR semantics: a record created BEFORE the item but UPDATED after it still counts', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T0);
    const decision = itemOf(
      knowledgeCreateRaw(tools, 'decision', {
        title: 'created early',
        statement: 'will be updated later, overlaps file_keys throughout',
        alternatives_rejected: [],
        rationale: 'R',
        file_keys: ['src/or-semantics.ts'],
      })
    );

    setClock(T1);
    const item = itemOf(boardAddRaw(tools, { text: 'item created between the decision\'s create and update', source: 'user', objective: 'standalone', file_keys: ['src/or-semantics.ts'] }));

    setClock(T3);
    (tools as unknown as { knowledgeUpdate: (id: string, f: Loose) => unknown }).knowledgeUpdate(decision.id as string, {
      rationale: 'touched again, well after the item was created',
    });

    const page = boardQueryResultRaw(tools, { source: 'user' });
    const evidence = evidenceOf(findItem(page, item.id as string));
    assert.equal(evidence.count, 1, 'created_at predates the item, but updated_at postdates it — OR means this still counts');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. Type union + cap-clipping combined (adversarial case: count>3 clips
// records to 3 but count stays full). Six qualifying records across SIX of
// the seven evidence types (decision, anti_pattern, research_finding via the
// file-key arm; feature_article, disconfirmed_hypothesis, reference_material
// via the citation arm — using BOTH the id8 prefix form and the full-id
// form). open_question is NOT exercised here — see the ambiguity note at the
// bottom of this file (the live schema surface does not yet register it in
// this session; it is exercised nowhere in this suite as a result).
// SABOTAGE (count): clip `count` itself to min(realCount, 3) instead of
//   reporting the full match total.
//   EXPECTED RED SHAPE: assert.equal(evidence.count, 6, ...) sees 3.
// SABOTAGE (records): return all matches in `records` instead of capping at 3.
//   EXPECTED RED SHAPE: assert.equal(records.length, 3, ...) sees 6.
// ---------------------------------------------------------------------------
test('type union + cap-clipping: six qualifying records across six evidence types — count stays full (6), records clips to 3', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    const item = itemOf(boardAddRaw(tools, { text: 'widely evidenced item', source: 'user', objective: 'standalone', file_keys: ['src/multi-evidence.ts'] }));
    const idFull = item.id as string;
    const id8Val = id8(idFull);

    setClock(T2);
    // file-key arm (3 types)
    knowledgeCreateRaw(tools, 'decision', {
      title: 'd', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: ['src/multi-evidence.ts'],
    });
    knowledgeCreateRaw(tools, 'anti_pattern', {
      title: 'a', trigger: 't', guidance: 'g', wrong_way: 'w', right_way: 'r', source_evidence: 'e', file_keys: ['src/multi-evidence.ts'],
    });
    knowledgeCreateRaw(tools, 'research_finding', {
      question: 'q', answer: 'ans', source_date: '2026-01-01', capture_date: '2026-01-01', file_keys: ['src/multi-evidence.ts'],
    });
    // citation arm (3 types) — id8 prefix form for two, full-id form for one
    knowledgeCreateRaw(tools, 'feature_article', {
      slug: 'multi-evidence-article',
      title: 'Multi Evidence Article',
      what_it_does: `cites ${id8Val}`,
      intended_behavior: 'n/a',
      files: [{ path: 'src/unrelated.ts', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'n/a', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'built',
      history: [{ date: T2, event: 'created for test' }],
      live_test_refs: [{ ac_id: 'AC1', test_paths: ['n/a'] }],
    });
    knowledgeCreateRaw(tools, 'disconfirmed_hypothesis', {
      question: `does ${id8Val} hold?`,
      rejected_answer: 'yes',
      evidence: `cites ${id8Val} directly`,
    });
    knowledgeCreateRaw(tools, 'reference_material', {
      title: 'ext doc',
      kind: 'doc',
      location: 'https://example.com/doc',
      summary: `cites the full id ${idFull}`, // full-id citation form
      source_date: '2026-01-01',
      capture_date: '2026-01-01',
    });

    const page = boardQueryResultRaw(tools, { source: 'user' });
    const evidence = evidenceOf(findItem(page, idFull));
    assert.equal(evidence.count, 6, 'the full matched count is reported, not the clipped window');
    const recs = recordsOf(evidence);
    assert.equal(recs.length, 3, 'records clips to a MAXIMUM of 3 entries');
    for (const rec of recs) {
      assert.ok(typeof rec.id8 === 'string' && (rec.id8 as string).length === 8);
      assert.ok(
        ['decision', 'anti_pattern', 'research_finding', 'feature_article', 'disconfirmed_hypothesis', 'reference_material'].includes(rec.type as string),
        `unexpected type in records: ${rec.type}`
      );
      assert.ok(typeof rec.name === 'string' && (rec.name as string).length > 0);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. Name fallback across record types (spec point 1: "name falls back
// across slug/title/question/location depending on record type").
// SABOTAGE: hardcode `name` to the record's `title` field regardless of type
// (breaks the disconfirmed_hypothesis case, which has no title field at all).
// EXPECTED RED SHAPE: the disconfirmed_hypothesis assertion sees `undefined`
// (or a thrown TypeError reading a nonexistent title) instead of the question text.
// ---------------------------------------------------------------------------
test('name fallback: decision -> title, feature_article -> slug, disconfirmed_hypothesis -> question', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    const item = itemOf(boardAddRaw(tools, { text: 'name fallback probe', source: 'user', objective: 'standalone' }));
    const id8Val = id8(item.id as string);

    setClock(T2);
    knowledgeCreateRaw(tools, 'decision', {
      title: `decision naming ${id8Val}`,
      statement: `cites ${id8Val}`,
      alternatives_rejected: [],
      rationale: 'R',
    });
    knowledgeCreateRaw(tools, 'feature_article', {
      slug: 'name-fallback-article',
      title: 'A Title That Should NOT Win Over slug',
      what_it_does: `cites ${id8Val}`,
      intended_behavior: 'n/a',
      files: [{ path: 'src/unrelated2.ts', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'n/a', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'built',
      history: [{ date: T2, event: 'created for test' }],
      live_test_refs: [{ ac_id: 'AC1', test_paths: ['n/a'] }],
    });
    knowledgeCreateRaw(tools, 'disconfirmed_hypothesis', {
      question: `is ${id8Val} disproven?`,
      rejected_answer: 'yes',
      evidence: `cites ${id8Val}`,
    });

    const page = boardQueryResultRaw(tools, { source: 'user' });
    const evidence = evidenceOf(findItem(page, item.id as string));
    assert.equal(evidence.count, 3);
    const recs = recordsOf(evidence);
    const byType = (t: string) => recs.find((r) => r.type === t) as Loose;

    assert.equal(byType('decision').name, `decision naming ${id8Val}`, 'decision has no slug — name falls back to title');
    assert.equal(byType('feature_article').name, 'name-fallback-article', 'feature_article has a slug — slug wins over title');
    assert.equal(byType('disconfirmed_hypothesis').name, `is ${id8Val} disproven?`, 'disconfirmed_hypothesis has neither slug nor title — falls back to question');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. Envelope: artifact_evidence_provenance === "checked" on success, on
// BOTH board_query and maintenance_query.
// SABOTAGE: never set artifact_evidence_provenance on the envelope.
// EXPECTED RED SHAPE: assert.equal(..., 'checked') sees `undefined`.
// ---------------------------------------------------------------------------
test('envelope: artifact_evidence_provenance is "checked" on a successful board_query AND maintenance_query', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    boardAddRaw(tools, { text: 'anything', source: 'user', objective: 'standalone' });
    maintenanceEnqueueRaw(tools, { reason: 'reconcile_needed', text: 'system item' });

    const boardPage = boardQueryResultRaw(tools, { source: 'user' });
    assert.equal(boardPage.artifact_evidence_provenance, 'checked');

    const maintPage = maintenanceQueryResultRaw(tools, {});
    assert.equal(maintPage.artifact_evidence_provenance, 'checked');
  } finally {
    cleanup();
  }
});
// GAP DISCLOSED (spec point 4's failure path): "unavailable:store_query_failed"
// is not pinned — this harness has no fault-injection seam to induce a store
// query failure cleanly (constructing one would mean reaching into the store
// internals, which risks anchoring the oracle to implementation details this
// role must not read). Left as an explicit gap rather than fabricated.

// ---------------------------------------------------------------------------
// 10. Envelope wording (spec point 9): artifact_evidence_note matches
// /verify/i and never claims completion.
// Tested on BOTH an evidence-bearing query and an evidence-free query, since
// the spec states "the envelope carries A [...] note" with no stated
// condition — read here as an unconditional envelope-level advisory (see
// ambiguity note at the bottom of this file).
// SABOTAGE: drop the note field entirely, OR word it "N items done".
// EXPECTED RED SHAPE: assert.match(..., /verify/i) fails (undefined does not
// match), or assert.doesNotMatch(..., /\bdone\b|closed/i) fails instead.
// ---------------------------------------------------------------------------
test('envelope: artifact_evidence_note mentions "verify" and never claims items are done/closed — with and without evidence present', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    boardAddRaw(tools, { text: 'evidence-free item', source: 'user', objective: 'standalone' });
    const noEvidencePage = boardQueryResultRaw(tools, { source: 'user' });
    assert.match(String(noEvidencePage.artifact_evidence_note ?? ''), /verify/i);
    assert.doesNotMatch(String(noEvidencePage.artifact_evidence_note ?? ''), /\bdone\b|closed/i);

    setClock(T2);
    const item2 = itemOf(boardAddRaw(tools, { text: 'evidenced item', source: 'user', objective: 'standalone', file_keys: ['src/note-probe.ts'] }));
    knowledgeCreateRaw(tools, 'decision', {
      title: 'note probe decision', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: ['src/note-probe.ts'],
    });
    const withEvidencePage = boardQueryResultRaw(tools, { source: 'user' });
    findItem(withEvidencePage, item2.id as string); // precondition: item is on this page
    assert.match(String(withEvidencePage.artifact_evidence_note ?? ''), /verify/i);
    assert.doesNotMatch(String(withEvidencePage.artifact_evidence_note ?? ''), /\bdone\b|closed/i);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11. Page-scoped computation (spec point 5): with 5 candidate items and
// cap:2, only the 2 RETURNED items are asserted to carry a well-formed
// artifact_evidence field. No claim is made about the other 3.
// SABOTAGE: throw/omit artifact_evidence on the returned page (a full
// implementation collapsing to "no evidence field at all" trivially fails
// this — the pin is deliberately about the returned items only).
// EXPECTED RED SHAPE: evidence is undefined on a returned item — the shape
// assertion (typeof evidence.count === 'number') throws.
// ---------------------------------------------------------------------------
test('page-scoped: with cap:2 of 5 candidate items, both RETURNED items carry a well-formed artifact_evidence field', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    for (let i = 0; i < 5; i++) {
      boardAddRaw(tools, { text: `paging item ${i}`, source: 'user', objective: 'standalone' });
    }

    const page = boardQueryResultRaw(tools, { source: 'user', cap: 2 });
    const recs = recordsOf(page);
    assert.equal(recs.length, 2, 'precondition: exactly 2 returned per cap');
    assert.equal(page.matched_filter, 5, 'precondition: 5 total candidates exist — page-scoping is meaningful here');
    for (const rec of recs) {
      const evidence = evidenceOf(rec);
      assert.ok(evidence, 'every RETURNED item carries the field');
      assert.equal(typeof evidence.count, 'number');
      assert.ok(['checked', 'skipped:no_file_keys'].includes(evidence.file_key_check as string));
    }
    // deliberately NO assertion about the 3 items beyond the cap.
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 12. Read-only (spec point 6): a query must never write to the store.
// Checked two ways: (a) the maintenance queue does not grow from querying a
// keyless item (no audit/check_skipped side record minted), and (b) the
// item's own snapshot (version/updated_at) is byte-identical across repeated
// query calls.
// SABOTAGE: on a keyless item, enqueue a maintenance-queue audit/check_skipped
// record (mirroring board_remove's check_skipped disclosure, but as a WRITE
// instead of a same-call return value).
// EXPECTED RED SHAPE: the maintenance queue length grows from 0 to >0 across
// the two boardQueryResult calls — assert.equal(after, before) fails.
// ---------------------------------------------------------------------------
test('read-only: repeated board_query calls (including on a keyless item) never write to the store', () => {
  const { tools, store, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    const keyless = itemOf(boardAddRaw(tools, { text: 'keyless, queried repeatedly', source: 'user', objective: 'standalone' }));
    const keyed = itemOf(boardAddRaw(tools, { text: 'keyed, queried repeatedly', source: 'user', objective: 'standalone', file_keys: ['src/readonly-probe.ts'] }));

    const queueLenBefore = (tools as unknown as { maintenanceQuery: (a: Loose) => unknown[] }).maintenanceQuery({ cap: 1000 }).length;
    // REPAIR (review MEDIUM-1, 2026-09-01): the named sabotage — copying the
    // removal path's `recordCheckSkipped` call into the query path — writes to
    // the check_skipped TABLE, which never touches the maintenance queue and
    // never bumps an item's version. The queue/version arms below were hollow
    // against it; this arm observes the table itself.
    const checkSkippedBefore = store.listCheckSkipped().length;

    const firstPage = boardQueryResultRaw(tools, { source: 'user' });
    const firstKeyless = findItem(firstPage, keyless.id as string);
    const firstKeyed = findItem(firstPage, keyed.id as string);

    // query again — nothing about the stored items should have moved
    const secondPage = boardQueryResultRaw(tools, { source: 'user' });
    const secondKeyless = findItem(secondPage, keyless.id as string);
    const secondKeyed = findItem(secondPage, keyed.id as string);

    const queueLenAfter = (tools as unknown as { maintenanceQuery: (a: Loose) => unknown[] }).maintenanceQuery({ cap: 1000 }).length;

    assert.equal(queueLenAfter, queueLenBefore, 'no maintenance-queue side-record was minted by querying (including the keyless item)');
    assert.equal(store.listCheckSkipped().length, checkSkippedBefore, 'no check_skipped audit row was recorded by querying (the keyless skip is disclosed in the return value only)');
    assert.equal(secondKeyless.updated_at, firstKeyless.updated_at, 'the keyless item was not touched by being queried');
    assert.equal(secondKeyless.version, firstKeyless.version);
    assert.equal(secondKeyed.updated_at, firstKeyed.updated_at, 'the keyed item was not touched by being queried');
    assert.equal(secondKeyed.version, firstKeyed.version);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 13. maintenance_query surface parity (spec point 7 + adversarial "both
// surfaces"): a system-source item gets the same per-item field, computed
// with the same semantics as board_query.
// SABOTAGE: wire the evidence computation into boardQueryResult only, never
// into maintenanceQueryResult (the two envelopes are built by different
// code paths per tools.test.ts's own comment on the shared `boardFiltered`
// filter — the evidence attach step could easily be added to only one).
// EXPECTED RED SHAPE: `evidence` is undefined on the maintenance item, or its
// count stays 0 instead of 1.
// ---------------------------------------------------------------------------
test('maintenance_query: a system-source (queue) item gets the same artifact_evidence field, same semantics', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    const qi = itemOf(maintenanceEnqueueRaw(tools, { reason: 'reconcile_needed', text: 'reconcile the widget area', file_keys: ['src/queue-widget.ts'] }));

    setClock(T2);
    const decision = itemOf(
      knowledgeCreateRaw(tools, 'decision', {
        title: 'queue widget reconciled', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: ['src/queue-widget.ts'],
      })
    );

    const page = maintenanceQueryResultRaw(tools, {});
    const seen = findItem(page, qi.id as string);
    const evidence = evidenceOf(seen);
    assert.equal(evidence.file_key_check, 'checked');
    assert.equal(evidence.count, 1);
    const rec = recordsOf(evidence)[0] as Loose;
    assert.equal(rec.id8, id8(decision.id as string));
    assert.equal(rec.type, 'decision');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AMBIGUITIES RESOLVED WHILE WRITING THIS SUITE (reported per the test-writer
// contract; none of these widen the spec beyond what board 00fa8adb states):
//
// (a) open_question is named in the spec's evidence-type list, but the
//     LIVE knowledge_schema surface available to this session does not
//     register it ("Registered: anti_pattern, attestation, brief, decision,
//     disconfirmed_hypothesis, feature_article, reference_material,
//     research_finding, todo") — most likely a lagging MCP server session
//     per CLAUDE.md's own documented gotcha ("a server lagging the code
//     means restart the session"), since the git log shows open_question
//     landing in an already-merged commit. Rather than guess its required
//     fields blind, this suite exercises the other SIX evidence types and
//     leaves open_question untested. This is a coverage gap, not a spec
//     narrowing — flagging for the conductor to add one open_question case
//     once the field shapes are confirmed (or re-derive via knowledge_schema
//     once the session is current).
// (b) Which field(s) the citation-arm body-scan reads is unstated. Tests
//     that rely on citation put the id8/full-id into what looks like the
//     record's PRIMARY narrative field per type (statement/evidence/
//     what_it_does/summary) AND, in most cases, additionally into the title/
//     trigger/question field, specifically so a scan limited to either title
//     alone or body alone still finds the citation — this hedges against an
//     implementation detail this role is walled off from reading, without
//     weakening what is asserted (the record still, transparently, "cites
//     the item's id").
// (c) Whether artifact_evidence_note is unconditional (every envelope) or
//     conditional on at least one item having evidence>0 is unstated by the
//     spec ("the envelope carries a one-time advisory note" — no stated
//     condition). Test 10 resolves this as UNCONDITIONAL and asserts its
//     presence on both an evidence-free and an evidence-bearing query. If
//     the real design is conditional-on-evidence, the evidence-free half of
//     that test needs revisiting — flagged rather than silently assumed.
// (d) The name-fallback "location" tier (spec point 1) is never reached by
//     any of the seven evidence types as currently schema'd — every type
//     that could appear either has a title or a slug already ahead of
//     location in the stated fallback order, or (disconfirmed_hypothesis)
//     falls to `question` first. No test exercises the location tier as a
//     result; this is a structural consequence of the schemas, not an
//     oversight.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 14. BUDGET (appended by the conductor 2026-09-01, closing the coder-disclosed
// gap: fix 3 of the review round shipped ARTIFACT_EVIDENCE_KEY_SET_QUERY_CAP=60
// with no frozen pin). One page carrying MORE distinct file-key sets than the
// budget: exactly 60 items get their file-key arm ('checked'), the overflow
// items degrade to 'unavailable:budget' (their citation arm still ran — the
// shared scan is already paid), and the envelope discloses
// 'checked:budget_truncated'. CONTROL: a small page reports plain 'checked'.
// SABOTAGE: drop the budget check -> the 'unavailable:budget' count reads 0 and
// the envelope reads 'checked'; charge memo HITS against the budget -> the
// control arm truncates too.
// ---------------------------------------------------------------------------
test('budget: a page with more distinct file-key sets than the per-call cap degrades the overflow items to unavailable:budget and discloses checked:budget_truncated on the envelope', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    for (let i = 0; i < 62; i++) {
      boardAddRaw(tools, { text: `budget item ${i}`, source: 'user', objective: 'standalone', file_keys: [`src/budget-${i}.ts`] });
    }
    const page = boardQueryResultRaw(tools, { source: 'user', cap: 100 }) as Loose;
    const items = page.records as Loose[];
    assert.equal(items.length, 62, 'fixture guard: the whole set is on one page');
    const checks = items.map((r) => (r.artifact_evidence as Loose).file_key_check as string);
    assert.equal(checks.filter((c) => c === 'checked').length, 60, 'exactly the budget-many distinct key sets get their file-key arm');
    assert.equal(checks.filter((c) => c === 'unavailable:budget').length, 2, 'the overflow items degrade loudly, never silently');
    assert.equal(page.artifact_evidence_provenance, 'checked:budget_truncated', 'the envelope discloses the truncation');
    for (const r of items) {
      assert.ok(r.artifact_evidence, 'no item loses the field to the budget');
    }
  } finally {
    cleanup();
  }
});

test('budget control: a small page of distinct key sets is fully checked with plain "checked" provenance', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    for (let i = 0; i < 5; i++) {
      boardAddRaw(tools, { text: `small item ${i}`, source: 'user', objective: 'standalone', file_keys: [`src/small-${i}.ts`] });
    }
    const page = boardQueryResultRaw(tools, { source: 'user', cap: 10 }) as Loose;
    const items = page.records as Loose[];
    assert.equal(items.length, 5);
    for (const r of items) {
      assert.equal((r.artifact_evidence as Loose).file_key_check, 'checked');
    }
    assert.equal(page.artifact_evidence_provenance, 'checked', 'no truncation is claimed where none happened');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 16. MEMO-HIT BUDGET DISCRIMINATION (appended by the conductor 2026-09-01,
// closing the delta-review LOW: pins 14/15 use all-distinct key sets, so a
// regression charging the budget PER ITEM instead of per distinct key set —
// moving the check outside the memo-miss branch — left both green). 70 items
// SHARING one key set: one store query, 69 memo hits, zero budget pressure —
// every item 'checked', envelope plain 'checked'. Also pins the empty-result
// memo-hit case: the shared key set matches nothing, and [] must memoize as a
// HIT (arrays are truthy), not a repeated miss.
// SABOTAGE: charge memo hits against the budget (or move the size check outside
// `if (!scan)`) -> items past 60 read 'unavailable:budget' and the envelope
// reads 'checked:budget_truncated'.
// ---------------------------------------------------------------------------
test('budget memo-hit discrimination: 70 items SHARING one key set stay fully checked — memo hits never consume budget, and an empty scan result memoizes as a hit', () => {
  const { tools, setClock, cleanup } = clockHarness();
  try {
    setClock(T1);
    for (let i = 0; i < 70; i++) {
      boardAddRaw(tools, { text: `shared-key item ${i}`, source: 'user', objective: 'standalone', file_keys: ['src/shared-territory.ts'] });
    }
    const page = boardQueryResultRaw(tools, { source: 'user', cap: 100 }) as Loose;
    const items = page.records as Loose[];
    assert.equal(items.length, 70, 'fixture guard: the whole set is on one page');
    for (const r of items) {
      assert.equal((r.artifact_evidence as Loose).file_key_check, 'checked', 'a memo hit is free — sharing a key set can never exhaust the budget');
    }
    assert.equal(page.artifact_evidence_provenance, 'checked', 'no truncation is claimed for a single-query page');
  } finally {
    cleanup();
  }
});
