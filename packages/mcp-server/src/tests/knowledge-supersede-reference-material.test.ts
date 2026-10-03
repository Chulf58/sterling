// Board 3b5c6877 — "An obsolete reference_material record has no exit".
// Decision record-audit-dead-records-superseded-stale-findings-by-age-report-arm-plus-sampled-audit
// (b032fd9f): a record whose subject is gone (a deleted draft) is superseded by
// a short record saying what happened, so delivery stops and history stays
// readable.
//
// What this file pins:
//   (1) knowledge_supersede accepts a reference_material as the OLD record when
//       the caller names the closing record's type (`type`: decision or
//       research_finding). The reference is retired and forwards to the note.
//   (2) A superseded kind:doc reference is no longer read, so the deletion arm
//       of the refresh_reference mint cannot fire for it again.
//   (3) `resolves` on knowledge_supersede closes open items keyed to the old
//       record's chain in the same transaction; without it the item stays open
//       (no implicit drain), and a claim that does not validate writes nothing.
//   (4) Every earlier refusal stands: no `type` on a reference, a successor type
//       outside the allowed pair, a feature_article, and a cross-type
//       replacement of a ruling record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;
type SupersedeOpts = { type?: string; resolves?: string[] };
type SupersedeResult = { superseded: string; id: string; type: string; resolved_items?: { id: string }[] };

const NOW = '2026-10-03T12:00:00.000Z';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-supersede-reference-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, cleanup };
}

interface SupersedeCapable {
  knowledgeSupersede(old_id: string, fields: Loose, orphans_acknowledged?: boolean, opts?: SupersedeOpts): SupersedeResult;
}
const supersede = (tools: SterlingTools, oldId: string, fields: Loose, opts?: SupersedeOpts): SupersedeResult =>
  (tools as unknown as SupersedeCapable).knowledgeSupersede(oldId, fields, undefined, opts);

const create = (tools: SterlingTools, type: string, fields: Loose): Loose =>
  (tools.knowledgeCreate(type, fields as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }).record;

const mkDocRef = (tools: SterlingTools, location: string): Loose =>
  create(tools, 'reference_material', {
    title: `draft at ${location}`,
    kind: 'doc',
    location,
    summary: 'x',
    source_date: '2026-09-06',
    capture_date: '2026-09-06',
  });

const closingDecision = (title: string): Loose => ({
  title,
  statement: 'CLOSED 2026-10-03. The draft this reference pointed at was deleted; nothing here governs current code.',
  alternatives_rejected: [],
  rationale: 'The file is gone, so the reference would keep raising refresh_reference.',
});

const closingFinding = (question: string): Loose => ({
  question,
  answer: 'The draft was deleted on 2026-10-03.',
  source_urls: [],
  source_date: '2026-10-03',
  capture_date: '2026-10-03',
});

const get = (tools: SterlingTools, id: string): Loose => tools.knowledgeGet(id) as unknown as Loose;
const readRefs = (tools: SterlingTools): Loose[] => tools.knowledgeQuery({ types: ['reference_material'] }) as unknown as Loose[];
const count = (tools: SterlingTools, type: string): number => tools.knowledgeQuery({ types: [type] }).length;
const openItems = (tools: SterlingTools, reason: string): Loose[] => tools.maintenanceQuery({ system_reason: reason }) as unknown as Loose[];

/** A kind:doc reference whose file was written and then deleted, read once so the deletion item is open. */
function deadRefWithOpenItem(dir: string, tools: SterlingTools, name: string): { ref: Loose; item: Loose } {
  mkdirSync(join(dir, 'docs', 'drafts'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'drafts', name), 'x');
  const ref = mkDocRef(tools, `docs/drafts/${name}`);
  rmSync(join(dir, 'docs', 'drafts', name));
  readRefs(tools);
  const items = openItems(tools, 'refresh_reference').filter((i) => i.feature_link === ref.id);
  assert.equal(items.length, 1, 'precondition: the deleted location minted one refresh_reference item');
  return { ref, item: items[0] };
}

// ---------------------------------------------------------------------------
// (1) a reference_material is superseded by a closing record of a named type
// ---------------------------------------------------------------------------

test('(1) a reference_material is superseded by a closing decision: the reference is retired and forwards to it, the decision is live', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkDocRef(tools, 'docs/drafts/contract.md');
    const res = supersede(tools, ref.id as string, closingDecision('CLOSED: the conductor contract draft was deleted'), { type: 'decision' });

    assert.equal(res.superseded, ref.id);
    assert.equal(res.type, 'decision');
    assert.notEqual(res.id, ref.id);

    const old = get(tools, ref.id as string);
    assert.equal(old.type, 'reference_material', 'the old record keeps its own type');
    assert.equal(old.status, 'superseded');
    assert.equal(old.superseded_by, res.id);

    const note = get(tools, res.id);
    assert.equal(note.type, 'decision');
    assert.equal(note.status, 'active');
    assert.ok(
      (note.links as { rel: string; target_id: string }[]).some((l) => l.rel === 'supersedes' && l.target_id === ref.id),
      'the closing record carries the supersedes edge to the reference'
    );

    assert.equal(count(tools, 'reference_material'), 0, 'the reference is no longer served');
    assert.equal(count(tools, 'decision'), 1, 'exactly one closing record was written');
  } finally {
    cleanup();
  }
});

test('(1) a research_finding is accepted as the closing type too', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkDocRef(tools, 'docs/drafts/map.md');
    const res = supersede(tools, ref.id as string, closingFinding('What happened to the slice 2 removal map draft?'), { type: 'research_finding' });
    assert.equal(res.type, 'research_finding');
    assert.equal(get(tools, ref.id as string).superseded_by, res.id);
    assert.equal(get(tools, res.id).status, 'active');
    assert.equal(count(tools, 'reference_material'), 0);
  } finally {
    cleanup();
  }
});

test('(1) a closing body that is invalid for the named type is refused and nothing is written', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkDocRef(tools, 'docs/drafts/invalid.md');
    assert.throws(() => supersede(tools, ref.id as string, { title: 'CLOSED: no statement' }, { type: 'decision' }), /knowledge_supersede/);
    assert.equal(get(tools, ref.id as string).status, 'active');
    assert.equal(count(tools, 'decision'), 0);
  } finally {
    cleanup();
  }
});

test('(1) an already superseded reference is refused', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkDocRef(tools, 'docs/drafts/twice.md');
    supersede(tools, ref.id as string, closingDecision('CLOSED: first'), { type: 'decision' });
    assert.throws(() => supersede(tools, ref.id as string, closingDecision('CLOSED: second'), { type: 'decision' }), /already superseded/);
    assert.equal(count(tools, 'decision'), 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (4) the refusals that stand
// ---------------------------------------------------------------------------

test('(4) a reference_material with no closing type is refused naming the allowed types, knowledge_update and knowledge_retire', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkDocRef(tools, 'docs/drafts/untyped.md');
    assert.throws(
      () => supersede(tools, ref.id as string, closingDecision('CLOSED: untyped')),
      (err: Error) => {
        assert.match(err.message, /type/);
        assert.match(err.message, /decision/);
        assert.match(err.message, /research_finding/);
        assert.match(err.message, /knowledge_update/);
        assert.match(err.message, /knowledge_retire/);
        return true;
      }
    );
    assert.equal(get(tools, ref.id as string).status, 'active');
    assert.equal(count(tools, 'decision'), 0);
  } finally {
    cleanup();
  }
});

for (const bad of ['anti_pattern', 'reference_material', 'feature_article', 'todo', 'nonsense']) {
  test(`(4) a reference_material cannot be closed by type '${bad}': refused naming decision and research_finding, nothing written`, () => {
    const { tools, cleanup } = fixture();
    try {
      const ref = mkDocRef(tools, 'docs/drafts/badtype.md');
      assert.throws(
        () => supersede(tools, ref.id as string, closingDecision('CLOSED: bad type'), { type: bad }),
        (err: Error) => {
          assert.match(err.message, /decision/);
          assert.match(err.message, /research_finding/);
          return true;
        }
      );
      assert.equal(get(tools, ref.id as string).status, 'active');
      assert.equal(count(tools, 'reference_material'), 1);
      assert.equal(count(tools, 'decision'), 0);
    } finally {
      cleanup();
    }
  });
}

test('(4) a ruling record is still replaced by its own type only: a different `type` is refused, the same `type` is accepted', () => {
  const { tools, cleanup } = fixture();
  try {
    const old = create(tools, 'decision', { title: 'a ruling', statement: 'one ruling.', alternatives_rejected: [], rationale: 'r' });
    assert.throws(
      () => supersede(tools, old.id as string, closingFinding('can a finding replace a decision?'), { type: 'research_finding' }),
      /knowledge_supersede.*decision/s
    );
    assert.equal(get(tools, old.id as string).status, 'active');
    assert.equal(count(tools, 'research_finding'), 0);

    const res = supersede(tools, old.id as string, { title: 'a ruling, restated', statement: 'one ruling, restated.', alternatives_rejected: [], rationale: 'r' }, { type: 'decision' });
    assert.equal(res.type, 'decision');
    assert.equal(get(tools, old.id as string).superseded_by, res.id);
  } finally {
    cleanup();
  }
});

test('(4) a feature_article is still refused, with or without a closing type', () => {
  const { tools, cleanup } = fixture();
  try {
    const article = create(tools, 'feature_article', {
      slug: 'still-refused-article',
      title: 'Still refused',
      what_it_does: 'w',
      intended_behavior: 'w',
      files: [],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    });
    for (const opts of [undefined, { type: 'decision' }]) {
      assert.throws(() => supersede(tools, article.id as string, closingDecision('CLOSED: an article'), opts), /knowledge_update/);
    }
    assert.equal(get(tools, article.id as string).status, 'active');
    assert.equal(count(tools, 'decision'), 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (2) a superseded reference stops minting refresh_reference
// ---------------------------------------------------------------------------

test('(2) a superseded doc reference is no longer read, so the deletion mint cannot fire for it again once its item is gone', () => {
  const { dir, tools, cleanup } = fixture();
  try {
    const { ref, item } = deadRefWithOpenItem(dir, tools, 'gone.md');
    supersede(tools, ref.id as string, closingDecision('CLOSED: gone.md was deleted'), { type: 'decision', resolves: [item.id as string] });

    assert.equal(openItems(tools, 'refresh_reference').length, 0, 'the supersede closed the open item');
    assert.deepEqual(readRefs(tools), [], 'the superseded reference is not served');
    readRefs(tools);
    assert.equal(openItems(tools, 'refresh_reference').length, 0, 'no item is minted for the superseded reference on later reads');
  } finally {
    cleanup();
  }
});

test('(2) a supersede without resolves mints no new item on later reads and leaves the open one for an explicit close', () => {
  const { dir, tools, cleanup } = fixture();
  try {
    const { ref } = deadRefWithOpenItem(dir, tools, 'stuck.md');
    supersede(tools, ref.id as string, closingDecision('CLOSED: stuck.md was deleted'), { type: 'decision' });
    const before = openItems(tools, 'refresh_reference').map((i) => i.id);
    readRefs(tools);
    readRefs(tools);
    assert.deepEqual(
      openItems(tools, 'refresh_reference').map((i) => i.id),
      before,
      'no new item after the supersede; the one not named in resolves stays open until it is removed'
    );
    assert.equal(before.length, 1, 'no implicit drain: an unnamed item is left for an explicit close');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (3) resolves on knowledge_supersede
// ---------------------------------------------------------------------------

test('(3) resolves closes the named refresh_reference item with the supersede and reports it on the receipt', () => {
  const { dir, tools, cleanup } = fixture();
  try {
    const { ref, item } = deadRefWithOpenItem(dir, tools, 'receipt.md');
    const res = supersede(tools, ref.id as string, closingDecision('CLOSED: receipt.md was deleted'), { type: 'decision', resolves: [item.id as string] });
    assert.deepEqual(res.resolved_items?.map((i) => i.id), [item.id]);
    assert.equal(openItems(tools, 'refresh_reference').length, 0);
  } finally {
    cleanup();
  }
});

test('(3) resolves naming an item keyed to a DIFFERENT record is refused and nothing is written', () => {
  const { dir, tools, cleanup } = fixture();
  try {
    const { item: otherItem } = deadRefWithOpenItem(dir, tools, 'other.md');
    const { ref } = deadRefWithOpenItem(dir, tools, 'mine.md');
    assert.throws(
      () => supersede(tools, ref.id as string, closingDecision('CLOSED: mine.md was deleted'), { type: 'decision', resolves: [otherItem.id as string] }),
      /resolves/
    );
    assert.equal(get(tools, ref.id as string).status, 'active', 'the reference is untouched');
    assert.equal(count(tools, 'decision'), 0, 'no closing record was written');
    assert.equal(openItems(tools, 'refresh_reference').length, 2, 'both items are still open');
  } finally {
    cleanup();
  }
});

test('(3) resolves naming an unknown id, or one id twice, is refused and nothing is written', () => {
  const { dir, tools, cleanup } = fixture();
  try {
    const { ref, item } = deadRefWithOpenItem(dir, tools, 'dup.md');
    // A well-formed id that names no queue item. Kept off the `type: 'decision'` line so
    // check-record-citations does not read it as a cited record id.
    const unknownItemId = ['00000000', '0000', '4000', '8000', '000000000000'].join('-');
    assert.throws(
      () => supersede(tools, ref.id as string, closingDecision('CLOSED: dup.md'), { type: 'decision', resolves: [unknownItemId] }),
      /resolves/
    );
    assert.throws(
      () => supersede(tools, ref.id as string, closingDecision('CLOSED: dup.md'), { type: 'decision', resolves: [item.id as string, item.id as string] }),
      /more than once/
    );
    assert.equal(get(tools, ref.id as string).status, 'active');
    assert.equal(count(tools, 'decision'), 0);
    assert.equal(openItems(tools, 'refresh_reference').length, 1);
  } finally {
    cleanup();
  }
});

test('(3) resolves works for a ruling type as well: a stale finding is superseded and its stale_research item closed in one call', () => {
  const { tools, cleanup } = fixture();
  try {
    const old = create(tools, 'research_finding', {
      question: 'an overdue finding',
      answer: 'a',
      source_urls: [],
      source_date: '2026-01-01',
      capture_date: '2026-01-01',
    });
    tools.knowledgeQuery({ types: ['research_finding'] });
    const items = openItems(tools, 'stale_research');
    assert.equal(items.length, 1, 'precondition: the overdue finding minted one stale_research item');

    const res = supersede(tools, old.id as string, closingFinding('an overdue finding'), { resolves: [items[0].id as string] });
    assert.equal(res.type, 'research_finding');
    assert.deepEqual(res.resolved_items?.map((i) => i.id), [items[0].id]);
    assert.equal(openItems(tools, 'stale_research').length, 0);
    assert.equal(get(tools, old.id as string).superseded_by, res.id);
  } finally {
    cleanup();
  }
});
