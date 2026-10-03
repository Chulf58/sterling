// Board bdd80e1a — "Let knowledge_supersede close a dead open_question and a dead
// disconfirmed_hypothesis with a closing note". User-ruled 2026-10-03 through the
// question form: "Supersede for the two small types, articles stay as today".
// Built the way reference_material was (decision
// a-dead-reference-material-is-superseded-by-a-closing-note-of-another-type).
//
// What this file pins:
//   (1) knowledge_supersede accepts an open_question or a disconfirmed_hypothesis
//       as the OLD record when the caller names the closing record's type
//       (`type`: decision or research_finding). The old record is retired and
//       forwards to the note.
//   (2) The closing note of an open_question inherits its slug, so the handle
//       resolves to the note; a disconfirmed_hypothesis has no slug and the note
//       mints its own.
//   (3) `resolves` closes an open item keyed to the old record in the same
//       transaction; a claim that does not validate writes nothing.
//   (4) The refusals that stay: no `type`, a `type` outside the allowed pair, a
//       feature_article and a todo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;
type SupersedeOpts = { type?: string; resolves?: string[] };
type SupersedeResult = { superseded: string; id: string; type: string; slug?: string; resolved_items?: { id: string }[] };

const NOW = '2026-10-03T12:00:00.000Z';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-supersede-small-types-'));
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

const OLD_BODIES: Record<string, Loose> = {
  open_question: {
    question: 'Why does the removed staged pipeline stall at the plan gate?',
    hypotheses: ['the plan lock is never released'],
    evidence: 'Measured twice on the staged pipeline before it was removed.',
  },
  disconfirmed_hypothesis: {
    question: 'Does the removed read wall block the plan gate?',
    rejected_answer: 'The read wall blocks it.',
    evidence: 'The gate stalled with the read wall off.',
  },
};
const SMALL_TYPES = Object.keys(OLD_BODIES);
const a = (type: string): string => (type === 'open_question' ? 'an' : 'a');
const mkOld =(tools: SterlingTools, type: string): Loose => create(tools, type, OLD_BODIES[type]);

const closingDecision = (title: string): Loose => ({
  title,
  statement: 'CLOSED 2026-10-03. The staged pipeline this record asked about was removed; nothing here governs current code.',
  alternatives_rejected: [],
  rationale: 'The subject is gone, so the record would keep being served for code that does not exist.',
});

const closingFinding = (question: string): Loose => ({
  question,
  answer: 'The staged pipeline was removed on 2026-09-19, so the question has no subject.',
  source_urls: [],
  source_date: '2026-10-03',
  capture_date: '2026-10-03',
});

const CLOSERS: Record<string, (label: string) => Loose> = {
  decision: (label) => closingDecision(`CLOSED: ${label}`),
  research_finding: (label) => closingFinding(`What happened to ${label}?`),
};
const CLOSING_TYPES = Object.keys(CLOSERS);

const get = (tools: SterlingTools, id: string): Loose => tools.knowledgeGet(id) as unknown as Loose;
const count = (tools: SterlingTools, type: string): number => tools.knowledgeQuery({ types: [type] }).length;
const openItems = (tools: SterlingTools, reason: string): Loose[] => tools.maintenanceQuery({ system_reason: reason }) as unknown as Loose[];
const enqueueFor = (tools: SterlingTools, recordId: string): Loose =>
  tools.maintenanceEnqueue({ reason: 'state_review', text: `review ${recordId}`, feature_link: recordId }).record as unknown as Loose;

// ---------------------------------------------------------------------------
// (1) each small type is superseded by a closing record of each named type
// ---------------------------------------------------------------------------

for (const oldType of SMALL_TYPES) {
  for (const closingType of CLOSING_TYPES) {
    test(`(1) ${a(oldType)} ${oldType} is superseded by a closing ${closingType}: the old record is retired and forwards to it, the note is live`, () => {
      const { tools, cleanup } = fixture();
      try {
        const old = mkOld(tools, oldType);
        const res = supersede(tools, old.id as string, CLOSERS[closingType](`the ${oldType} about the staged pipeline`), { type: closingType });

        assert.equal(res.superseded, old.id);
        assert.equal(res.type, closingType);
        assert.notEqual(res.id, old.id);

        const after = get(tools, old.id as string);
        assert.equal(after.type, oldType, 'the old record keeps its own type');
        assert.equal(after.status, 'superseded');
        assert.equal(after.superseded_by, res.id);

        const note = get(tools, res.id);
        assert.equal(note.type, closingType);
        assert.equal(note.status, 'active');
        assert.ok(
          (note.links as { rel: string; target_id: string }[]).some((l) => l.rel === 'supersedes' && l.target_id === old.id),
          'the closing record carries the supersedes edge to the old record'
        );

        assert.equal(count(tools, oldType), 0, 'the old record is no longer served');
        assert.equal(count(tools, closingType), 1, 'exactly one closing record was written');
      } finally {
        cleanup();
      }
    });
  }

  test(`(1) a closing body that is invalid for the named type is refused for ${a(oldType)} ${oldType} and nothing is written`, () => {
    const { tools, cleanup } = fixture();
    try {
      const old = mkOld(tools, oldType);
      assert.throws(() => supersede(tools, old.id as string, { title: 'CLOSED: no statement' }, { type: 'decision' }), /knowledge_supersede/);
      assert.equal(get(tools, old.id as string).status, 'active');
      assert.equal(count(tools, 'decision'), 0);
    } finally {
      cleanup();
    }
  });

  test(`(1) ${a(oldType)} ${oldType} that is already superseded is refused`, () => {
    const { tools, cleanup } = fixture();
    try {
      const old = mkOld(tools, oldType);
      supersede(tools, old.id as string, closingDecision('CLOSED: first'), { type: 'decision' });
      assert.throws(() => supersede(tools, old.id as string, closingDecision('CLOSED: second'), { type: 'decision' }), /already superseded/);
      assert.equal(count(tools, 'decision'), 1);
    } finally {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// (2) the slug across types
// ---------------------------------------------------------------------------

test('(2) the closing note of an open_question inherits its slug, and the slug then resolves to the note', () => {
  const { tools, cleanup } = fixture();
  try {
    const old = mkOld(tools, 'open_question');
    assert.equal(typeof old.slug, 'string', 'precondition: an open_question mints a slug from its question');
    const res = supersede(tools, old.id as string, closingDecision('CLOSED: the plan gate question'), { type: 'decision' });
    assert.equal(res.slug, old.slug);
    assert.equal(get(tools, old.slug as string).id, res.id, 'the handle names the live closing note');
  } finally {
    cleanup();
  }
});

test('(2) a disconfirmed_hypothesis has no slug, so its closing note mints one from its own headline', () => {
  const { tools, cleanup } = fixture();
  try {
    const old = mkOld(tools, 'disconfirmed_hypothesis');
    assert.equal(old.slug, undefined, 'precondition: the type carries no slug');
    const res = supersede(tools, old.id as string, closingDecision('CLOSED: the read wall hypothesis'), { type: 'decision' });
    assert.equal(res.slug, 'closed-the-read-wall-hypothesis');
    assert.equal(get(tools, res.slug as string).id, res.id);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// (3) resolves
// ---------------------------------------------------------------------------

for (const oldType of SMALL_TYPES) {
  test(`(3) resolves closes the named item keyed to ${a(oldType)} ${oldType} with the supersede and reports it on the receipt`, () => {
    const { tools, cleanup } = fixture();
    try {
      const old = mkOld(tools, oldType);
      const item = enqueueFor(tools, old.id as string);
      const res = supersede(tools, old.id as string, closingDecision('CLOSED: with its item'), { type: 'decision', resolves: [item.id as string] });
      assert.deepEqual(res.resolved_items?.map((i) => i.id), [item.id]);
      assert.equal(openItems(tools, 'state_review').length, 0);
    } finally {
      cleanup();
    }
  });

  test(`(3) a supersede of ${a(oldType)} ${oldType} without resolves leaves the open item for an explicit close`, () => {
    const { tools, cleanup } = fixture();
    try {
      const old = mkOld(tools, oldType);
      const item = enqueueFor(tools, old.id as string);
      const res = supersede(tools, old.id as string, closingDecision('CLOSED: item left open'), { type: 'decision' });
      assert.equal(res.resolved_items, undefined);
      assert.deepEqual(openItems(tools, 'state_review').map((i) => i.id), [item.id], 'no implicit drain');
    } finally {
      cleanup();
    }
  });

  test(`(3) resolves naming an item keyed to a DIFFERENT record is refused for ${a(oldType)} ${oldType} and nothing is written`, () => {
    const { tools, cleanup } = fixture();
    try {
      const other = create(tools, 'decision', { title: 'another ruling', statement: 'one ruling.', alternatives_rejected: [], rationale: 'r' });
      const otherItem = enqueueFor(tools, other.id as string);
      const old = mkOld(tools, oldType);
      assert.throws(
        () => supersede(tools, old.id as string, closingFinding('What happened to the question?'), { type: 'research_finding', resolves: [otherItem.id as string] }),
        /resolves/
      );
      assert.equal(get(tools, old.id as string).status, 'active', 'the old record is untouched');
      assert.equal(count(tools, 'research_finding'), 0, 'no closing record was written');
      assert.equal(openItems(tools, 'state_review').length, 1, 'the item is still open');
    } finally {
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// (4) the refusals that stay
// ---------------------------------------------------------------------------

for (const oldType of SMALL_TYPES) {
  test(`(4) ${a(oldType)} ${oldType}with no closing type is refused naming the allowed types, knowledge_update and knowledge_retire`, () => {
    const { tools, cleanup } = fixture();
    try {
      const old = mkOld(tools, oldType);
      assert.throws(
        () => supersede(tools, old.id as string, closingDecision('CLOSED: untyped')),
        (err: Error) => {
          assert.match(err.message, new RegExp(`is an? ${oldType}`));
          assert.match(err.message, /type/);
          assert.match(err.message, /decision/);
          assert.match(err.message, /research_finding/);
          assert.match(err.message, /knowledge_update/);
          assert.match(err.message, /knowledge_retire/);
          assert.match(err.message, /no type was given/);
          return true;
        }
      );
      assert.equal(get(tools, old.id as string).status, 'active');
      assert.equal(count(tools, 'decision'), 0);
    } finally {
      cleanup();
    }
  });

  for (const bad of ['anti_pattern', 'open_question', 'disconfirmed_hypothesis', 'reference_material', 'feature_article', 'todo', 'nonsense']) {
    test(`(4) ${a(oldType)} ${oldType}cannot be closed by type '${bad}': refused naming decision and research_finding, nothing written`, () => {
      const { tools, cleanup } = fixture();
      try {
        const old = mkOld(tools, oldType);
        assert.throws(
          () => supersede(tools, old.id as string, { ...OLD_BODIES[oldType], ...closingDecision('CLOSED: bad type') }, { type: bad }),
          (err: Error) => {
            assert.match(err.message, /decision/);
            assert.match(err.message, /research_finding/);
            assert.match(err.message, new RegExp(`type '${bad}' is not one of them`));
            return true;
          }
        );
        assert.equal(get(tools, old.id as string).status, 'active');
        assert.equal(count(tools, oldType), 1);
        assert.equal(count(tools, 'decision'), 0);
        assert.equal(count(tools, 'anti_pattern'), 0);
      } finally {
        cleanup();
      }
    });
  }
}

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
    for (const opts of [undefined, { type: 'decision' }, { type: 'research_finding' }]) {
      assert.throws(
        () => supersede(tools, article.id as string, closingDecision('CLOSED: an article'), opts),
        (err: Error) => {
          assert.match(err.message, /feature_article/);
          assert.match(err.message, /knowledge_update/);
          assert.match(err.message, /knowledge_retire/);
          return true;
        }
      );
    }
    assert.equal(get(tools, article.id as string).status, 'active');
    assert.equal(count(tools, 'decision'), 0);
  } finally {
    cleanup();
  }
});

test('(4) a todo is still refused, with or without a closing type', () => {
  const { tools, cleanup } = fixture();
  try {
    const item = tools.boardAdd({ text: 'a board item that is not a knowledge record', source: 'user' }).record as unknown as Loose;
    for (const opts of [undefined, { type: 'decision' }, { type: 'research_finding' }]) {
      assert.throws(() => supersede(tools, item.id as string, closingDecision('CLOSED: a todo'), opts), /is a todo.*board_remove/s);
    }
    assert.equal(openItemsOnBoard(tools), 1, 'the board item is untouched');
    assert.equal(count(tools, 'decision'), 0);
  } finally {
    cleanup();
  }
});

function openItemsOnBoard(tools: SterlingTools): number {
  return tools.knowledgeQuery({ types: ['todo'] }).length;
}

test('(4) a ruling record is still replaced by its own type only, and the refusal names every type a closing note may close', () => {
  const { tools, cleanup } = fixture();
  try {
    const old = create(tools, 'decision', { title: 'a ruling', statement: 'one ruling.', alternatives_rejected: [], rationale: 'r' });
    assert.throws(
      () => supersede(tools, old.id as string, closingFinding('can a finding replace a decision?'), { type: 'research_finding' }),
      (err: Error) => {
        assert.match(err.message, /replaced by a decision only/);
        assert.match(err.message, /reference_material/);
        assert.match(err.message, /open_question/);
        assert.match(err.message, /disconfirmed_hypothesis/);
        return true;
      }
    );
    assert.equal(get(tools, old.id as string).status, 'active');
    assert.equal(count(tools, 'research_finding'), 0);
  } finally {
    cleanup();
  }
});
