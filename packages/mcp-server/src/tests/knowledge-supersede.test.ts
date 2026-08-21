// ---------------------------------------------------------------------------
// Spec for the NEW MCP tool `knowledge_supersede` (board task
// 0b33c27b-f36c-4d66-b92d-83885dbb1725; ADDENDUM 08-14-2045 + whole-system
// review 08-17-1820).
//
// Purpose: atomically replace one ruling record (decision / anti_pattern /
// research_finding) with a NEW record — create the replacement and mark the
// old record superseded in ONE transaction, with orphan detection over the
// old record's enumerated rulings so a whole-record supersession cannot
// silently drop co-rulings a multi-ruling record was carrying.
//
// knowledge_supersede(old_id, fields, orphans_acknowledged?) DOES NOT EXIST
// YET on SterlingTools — this file is written blind to tools.ts, from the
// dispatched spec only. `packages/mcp-server/src/tests/tools.test.ts`,
// `id-resolution.test.ts`, and `terminus-disclosure.test.ts` were read for
// harness conventions, fixture shapes (decision / anti_pattern /
// research_finding / feature_article / reference_material / todo required
// fields), and the id-ladder + promotion_review-repoint idioms — no
// implementation source (tools.ts, store/src/index.ts, schemas/records.ts)
// was read.
//
// EXPECTED FAILURE SHAPE ON CURRENT CODE (every test below, uniformly):
// SterlingTools has no `knowledgeSupersede` method at all today, so every
// call through the `supersede()` helper below throws
// `TypeError: tools.knowledgeSupersede is not a function` (or, if the
// runner type-checks the cast, a `TypeError` on the equivalent runtime
// call) — NOT a thrown Error with a refusal message, and NOT an assertion
// failure. That is the correct RED for a wholly new tool: the surface does
// not exist yet. Once `knowledgeSupersede` is implemented, each test then
// discriminates on its own assertions, which are annotated per-test below.
// The one exception is the server.test.ts SERVED_TOOLS edit (see that
// file): it fails on a plain `assert.deepEqual` mismatch (the roster is one
// tool short), not on a thrown error.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-20T12:00:00.000Z';

type Loose = Record<string, unknown>;
type AddressForm = 'uuid' | 'slug' | 'prefix';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-supersede-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

// The tool is not declared on SterlingTools yet — cast through `unknown` so
// this file compiles under any TS strictness the runner applies, while the
// RUNTIME call still hits the real (currently absent) method and throws
// honestly. This is the ONLY place the not-yet-existing surface is named.
interface SupersedeCapable {
  knowledgeSupersede(old_id: string, fields: Loose, orphans_acknowledged?: boolean): unknown;
}
function supersede(tools: SterlingTools, old_id: string, fields: Loose, orphans_acknowledged?: boolean): unknown {
  return (tools as unknown as SupersedeCapable).knowledgeSupersede(old_id, fields, orphans_acknowledged);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addressOf(record: Loose, form: AddressForm): string {
  if (form === 'uuid') return record.id as string;
  if (form === 'slug') return record.slug as string;
  return (record.id as string).slice(0, 8);
}

function decisionCount(tools: SterlingTools): number {
  return tools.knowledgeQuery({ types: ['decision'] }).length;
}

function get(tools: SterlingTools, id: string): Loose {
  return tools.knowledgeGet(id) as unknown as Loose;
}

// ---------------------------------------------------------------------------
// Fixture builders — valid, minimal bodies for the types the interface
// slice covers, mirroring tools.test.ts's own fixtures exactly (read, not
// guessed): decision {title, statement, alternatives_rejected, rationale},
// anti_pattern {title, trigger, guidance, wrong_way, right_way,
// source_evidence}, research_finding {question, answer, source_urls,
// source_date, capture_date}, feature_article {slug, title, what_it_does,
// intended_behavior, files, current_ac, dependencies, state, version,
// history, live_test_refs}, reference_material {title, kind, location,
// summary, source_date, capture_date}, todo via boardAdd({text, source}).
// ---------------------------------------------------------------------------

function mkDecision(tools: SterlingTools, title: string, statement: string, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement,
    alternatives_rejected: [],
    rationale: 'r',
    ...overrides,
  }).record as unknown as Loose;
}

function mkAntiPattern(tools: SterlingTools, title: string, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('anti_pattern', {
    title,
    trigger: 'trigger text',
    guidance: 'guidance text',
    wrong_way: 'wrong way text',
    right_way: 'right way text',
    source_evidence: 'evidence text',
    ...overrides,
  }).record as unknown as Loose;
}

function mkResearchFinding(tools: SterlingTools, question: string, overrides: Loose = {}): Loose {
  return tools.knowledgeCreate('research_finding', {
    question,
    answer: 'a',
    source_urls: [],
    source_date: '2026-05-20',
    capture_date: '2026-06-01',
    ...overrides,
  }).record as unknown as Loose;
}

function mkArticle(tools: SterlingTools, slug: string): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does the thing.',
    intended_behavior: 'behaves as described.',
    files: [{ path: `src/${slug}.ts`, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as Loose;
}

function mkReference(tools: SterlingTools, title: string): Loose {
  return tools.knowledgeCreate('reference_material', {
    title,
    kind: 'doc',
    location: `docs/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    summary: 's',
    source_date: '2026-06-01',
    capture_date: '2026-06-01',
  }).record as unknown as Loose;
}

// Forces a second record whose id shares `primaryId`'s first 8 chars — the
// exact convention id-resolution.test.ts and tools.test.ts use for
// knowledge_get's own prefix-collision test (ids are server-minted, so a
// collision cannot be produced through the public create tool alone).
function seedPrefixTwin(store: SterlingStore, tools: SterlingTools, primaryId: string): string {
  const prefix = primaryId.slice(0, 8);
  const seed = mkDecision(tools, 'ambiguity twin seed', 'seed statement.');
  store.create({
    ...(JSON.parse(JSON.stringify(seed)) as Loose),
    id: `${prefix}-0000-4000-8000-000000000000`,
  });
  return prefix;
}

const UNRESOLVABLE = 'zzz-totally-unresolvable-identifier-ffff';

// ---------------------------------------------------------------------------
// ADDENDUM 08-14-2045 fixture: a decision whose statement enumerates THREE
// rulings with distinct vocabularies. UNCOVERED restates only ruling 1;
// COVERED restates all three subjects (Flak / projectile category /
// prototype stabilizer / BigRocket heavy mount).
// ---------------------------------------------------------------------------

const RULING_STATEMENT =
  '1. Ten BigRocket parts attach to the heavy mount. ' +
  '2. Fifteen Flak parts are assigned by projectile category. ' +
  '3. The prototype stabilizer part stays unassigned pending review.';

function mkRulingDecision(tools: SterlingTools): Loose {
  return mkDecision(tools, 'Parts assignment rulings', RULING_STATEMENT);
}

const UNCOVERED_FIELDS: Loose = {
  title: 'Parts assignment rulings (revised)',
  statement: 'The ten BigRocket parts attach to the heavy mount, confirmed and unchanged.',
  alternatives_rejected: [],
  rationale: 'r2',
};

const COVERED_FIELDS: Loose = {
  title: 'Parts assignment rulings (revised)',
  statement:
    'The BigRocket parts attach to the heavy mount. Flak parts are assigned by projectile category. ' +
    'The prototype stabilizer part stays unassigned pending review.',
  alternatives_rejected: [],
  rationale: 'r2',
};

// ===========================================================================
// AC1 — shared id ladder (uuid / slug / 8-char prefix), same as knowledge_get
// ===========================================================================

for (const form of ['uuid', 'slug', 'prefix'] as const) {
  test(`AC1: old_id resolves via a ${form} address, the same ladder knowledge_get uses`, () => {
    const { tools, cleanup } = harness();
    try {
      const old = mkDecision(tools, `ac1-${form}-target`, 'plain single-ruling prose statement.');
      const addr = addressOf(old, form);
      assert.equal(get(tools, addr).id, old.id, `sanity: knowledge_get already resolves the ${form} form`);

      const newFields = { title: `ac1-${form}-new`, statement: 'replacement statement.', alternatives_rejected: [], rationale: 'r2' };
      supersede(tools, addr, newFields);

      const pinned = get(tools, old.id as string);
      assert.equal(pinned.status, 'superseded', `EXPECTED FAILURE (red): TypeError before this line — knowledgeSupersede does not exist. Once built, the ${form} address must resolve to this exact old record and supersede it`);
      const newId = pinned.superseded_by as string;
      assert.ok(newId, 'old record forwards to a new record id');
      const newRec = get(tools, newId);
      assert.equal(newRec.statement, 'replacement statement.');
    } finally {
      cleanup();
    }
  });
}

test('AC1: an AMBIGUOUS 8-char prefix is refused (parity with knowledge_get) and a genuinely unresolvable identifier is named verbatim; nothing written either way', () => {
  const { store, tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'ac1-ambiguity-target', 'plain single-ruling prose statement.');
    const prefix = seedPrefixTwin(store, tools, old.id as string);
    assert.throws(() => get(tools, prefix), /ambiguous/i, 'sanity: knowledge_get itself refuses this prefix as ambiguous');

    const before = decisionCount(tools);
    assert.throws(
      () => supersede(tools, prefix, { title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' }),
      /ambiguous|multiple matches/i,
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeSupersede does not exist. Once built, an ambiguous prefix must refuse the same way knowledge_get does'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the ambiguous-prefix refusal');
    assert.equal(get(tools, old.id as string).status, 'active', 'the seeded record is untouched');

    assert.throws(
      () => supersede(tools, UNRESOLVABLE, { title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' }),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal must state the identifier AS GIVEN'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the unresolvable-id refusal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC2 — fields is a COMPLETE new-record body of the SAME type
// ===========================================================================

test('AC2: fields missing a required field for the type is REFUSED and nothing is written', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'ac2-missing-required', 'plain single-ruling prose statement.');
    const before = decisionCount(tools);
    assert.throws(
      () => supersede(tools, old.id as string, { title: 'no rationale here', statement: 's2', alternatives_rejected: [] }),
      /rationale|required/i,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, a missing required field (rationale) must be refused, naming it'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the missing-required-field refusal');
    assert.equal(get(tools, old.id as string).status, 'active', 'old record untouched');
  } finally {
    cleanup();
  }
});

test('AC2: fields carrying a field the type does not define is REFUSED naming the offending field and the valid field set — never silently dropped', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'ac2-unknown-field', 'plain single-ruling prose statement.');
    const before = decisionCount(tools);
    assert.throws(
      () =>
        supersede(tools, old.id as string, {
          title: 't2',
          statement: 's2',
          alternatives_rejected: [],
          rationale: 'r2',
          bogus_extra_field: 'x',
        }),
      (err: Error) => {
        assert.match(err.message, /bogus_extra_field/, 'the refusal names the offending field');
        assert.match(err.message, /statement|rationale|title|alternatives_rejected/i, 'and lists the valid field set for the type');
        return true;
      },
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeSupersede does not exist yet'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the unknown-field refusal');
    assert.equal(get(tools, old.id as string).status, 'active', 'old record untouched');
  } finally {
    cleanup();
  }
});

for (const serverOwned of ['id', 'created_at', 'updated_at', 'status', 'superseded_by', 'type']) {
  test(`AC2: fields carrying the SERVER-OWNED field '${serverOwned}' is REFUSED loudly, nothing written`, () => {
    const { tools, cleanup } = harness();
    try {
      const old = mkDecision(tools, `ac2-server-owned-${serverOwned}`, 'plain single-ruling prose statement.');
      const before = decisionCount(tools);
      const badFields: Loose = {
        title: 't2',
        statement: 's2',
        alternatives_rejected: [],
        rationale: 'r2',
        [serverOwned]: 'attempted-forgery',
      };
      assert.throws(
        () => supersede(tools, old.id as string, badFields),
        /SERVER-OWNED/i,
        `EXPECTED FAILURE (red): TypeError before this line. Once built, '${serverOwned}' in fields must be refused as server-owned`
      );
      assert.equal(decisionCount(tools), before, `nothing written when '${serverOwned}' is forged in fields`);
      assert.equal(get(tools, old.id as string).status, 'active', 'old record untouched');
    } finally {
      cleanup();
    }
  });
}

// ===========================================================================
// AC3 — allowed old-record types: decision, anti_pattern, research_finding
// ONLY. todo / feature_article / reference_material are refused, naming
// their real exit paths.
// ===========================================================================

test('AC3: anti_pattern is an allowed old-record type — supersede succeeds atomically', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkAntiPattern(tools, 'ac3-anti-pattern-old');
    const newFields = {
      title: 'ac3-anti-pattern-new',
      trigger: 'a completely different trigger condition',
      guidance: 'a completely different guidance body',
      wrong_way: 'do the other bad thing',
      right_way: 'do the other good thing',
      source_evidence: 'fresh evidence, unrelated wording',
    };
    supersede(tools, old.id as string, newFields);
    const pinned = get(tools, old.id as string);
    assert.equal(pinned.status, 'superseded', 'EXPECTED FAILURE (red): TypeError before this line');
    const newRec = get(tools, pinned.superseded_by as string);
    assert.equal(newRec.type, 'anti_pattern');
    assert.equal(newRec.trigger, newFields.trigger);
  } finally {
    cleanup();
  }
});

test('AC3: research_finding is an allowed old-record type — supersede succeeds atomically', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkResearchFinding(tools, 'ac3-research-old?');
    const newFields = {
      question: 'ac3-research-new?',
      answer: 'a fresh answer',
      source_urls: [],
      source_date: '2026-08-01',
      capture_date: '2026-08-20',
    };
    supersede(tools, old.id as string, newFields);
    const pinned = get(tools, old.id as string);
    assert.equal(pinned.status, 'superseded', 'EXPECTED FAILURE (red): TypeError before this line');
    const newRec = get(tools, pinned.superseded_by as string);
    assert.equal(newRec.type, 'research_finding');
    assert.equal(newRec.answer, 'a fresh answer');
  } finally {
    cleanup();
  }
});

test('AC3: old_id of type todo is REFUSED — todos exit only via board_remove/maintenance_remove, never supersede', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: todo } = tools.boardAdd({ text: 'a todo item', source: 'user' });
    assert.throws(
      () => supersede(tools, todo.id as string, { text: 'irrelevant replacement' }),
      /board_remove|maintenance_remove/i,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, a todo old_id must be refused naming its own exit path'
    );
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'the todo is untouched');
  } finally {
    cleanup();
  }
});

test('AC3: old_id of type feature_article is REFUSED, naming knowledge_update (evolve) and knowledge_retire (duplicate) as the paths', () => {
  const { tools, cleanup } = harness();
  try {
    const art = mkArticle(tools, 'ac3-feature-article');
    const newFields = {
      slug: 'ac3-feature-article',
      title: 'ac3-feature-article',
      what_it_does: 'does something else now.',
      intended_behavior: 'behaves differently.',
      files: [{ path: 'src/ac3-feature-article.ts', role: 'impl' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    };
    assert.throws(
      () => supersede(tools, art.id as string, newFields),
      (err: Error) => {
        assert.match(err.message, /knowledge_update/, 'names the evolve-in-place path');
        assert.match(err.message, /knowledge_retire/, 'names the duplicate-tombstone path');
        return true;
      },
      'EXPECTED FAILURE (red): TypeError before this line'
    );
    assert.equal(get(tools, art.id as string).status, 'active', 'the article is untouched');
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 1, 'nothing written');
  } finally {
    cleanup();
  }
});

test('AC3: old_id of type reference_material is REFUSED likewise, naming knowledge_update and knowledge_retire', () => {
  const { tools, cleanup } = harness();
  try {
    const ref = mkReference(tools, 'AC3 Reference Doc');
    const newFields = {
      title: 'AC3 Reference Doc v2',
      kind: 'doc',
      location: 'docs/ac3-reference-doc-v2.md',
      summary: 's2',
      source_date: '2026-08-01',
      capture_date: '2026-08-20',
    };
    assert.throws(
      () => supersede(tools, ref.id as string, newFields),
      (err: Error) => {
        assert.match(err.message, /knowledge_update/);
        assert.match(err.message, /knowledge_retire/);
        return true;
      },
      'EXPECTED FAILURE (red): TypeError before this line'
    );
    assert.equal(get(tools, ref.id as string).status, 'active', 'the reference is untouched');
    assert.equal(tools.knowledgeQuery({ types: ['reference_material'] }).length, 1, 'nothing written');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC4 — an already-superseded old record is refused
// ===========================================================================

test('AC4: an old record that is already superseded is REFUSED — nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkDecision(tools, 'ac4-already-superseded', 'plain single-ruling prose statement.');
    tools.knowledgeUpdate(v1.id as string, { rationale: 'v2 via an ordinary knowledge_update' });
    assert.equal(get(tools, v1.id as string).status, 'superseded', 'precondition: v1 is already superseded');

    const before = decisionCount(tools);
    assert.throws(
      () => supersede(tools, v1.id as string, { title: 't2', statement: 's2', alternatives_rejected: [], rationale: 'r2' }),
      /superseded/i,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, an already-superseded old_id must be refused'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the already-superseded refusal');
    assert.equal(get(tools, v1.id as string).status, 'superseded', 'v1 state is unaffected by the refused call');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC5 — atomic happy path
// ===========================================================================

test('AC5: atomic happy path — exactly one new active record carries fields; old is superseded pointing at it; query serves only the new record; knowledge_get(old) stays pinned with a terminus disclosure at the new record', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'ac5-old', 'old statement, single ruling, prose only.');
    const before = decisionCount(tools);
    const newFields = { title: 'ac5-new', statement: 'ac5 replacement statement.', alternatives_rejected: [], rationale: 'r2' };

    supersede(tools, old.id as string, newFields);

    const pinned = get(tools, old.id as string);
    assert.equal(pinned.status, 'superseded', 'EXPECTED FAILURE (red): TypeError before this line');
    assert.equal(pinned.statement, 'old statement, single ruling, prose only.', "the pinned old record's own fields are unchanged");
    const newId = pinned.superseded_by as string;
    assert.ok(newId, 'old record forwards to a new record id');

    const newRec = get(tools, newId);
    assert.equal(newRec.status, 'active');
    assert.equal(newRec.statement, newFields.statement);
    assert.equal(newRec.title, newFields.title);
    assert.equal(newRec.type, 'decision');

    const servedActive = tools.knowledgeQuery({ types: ['decision'] }) as unknown as Loose[];
    assert.equal(servedActive.length, before, 'the active count is unchanged: old dropped out, new took its place');
    assert.ok(servedActive.every((r) => r.id !== old.id), 'the old id is no longer served by knowledge_query');
    assert.ok(servedActive.some((r) => r.id === newId), 'the new id is served by knowledge_query');

    const terminus = pinned.terminus as { id: string; status: string } | undefined;
    assert.ok(terminus, 'a superseded record carries a terminus field (the existing terminus-disclosure feature)');
    assert.equal(terminus!.id, newId, 'the terminus points at the new record');
    assert.equal(terminus!.status, 'active');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC6 — orphan detection: 2+ enumerated rulings, one left uncovered → refused
// ===========================================================================

test('AC6: 2+ enumerated rulings with at least one left uncovered by the new fields is REFUSED — orphan excerpts named, both remedies named, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkRulingDecision(tools);
    const before = decisionCount(tools);
    assert.throws(
      () => supersede(tools, old.id as string, UNCOVERED_FIELDS),
      (err: Error) => {
        assert.match(err.message, /Flak/, 'the orphaned Flak ruling is named/excerpted');
        assert.match(err.message, /prototype stabilizer|unassigned pending review/i, 'the orphaned stabilizer ruling is named/excerpted');
        assert.match(err.message, /orphans_acknowledged/, 'names the re-call-with-acknowledgement remedy');
        assert.match(err.message, /extend|carry.*forward|surviving/i, 'names the extend-fields remedy');
        return true;
      },
      'EXPECTED FAILURE (red): TypeError before this line. Once built, an uncovered multi-ruling supersede must refuse'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the orphan refusal');
    assert.equal(get(tools, old.id as string).status, 'active', 'old record untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC7 — orphans_acknowledged:true
// ===========================================================================

test('AC7: orphans_acknowledged:true proceeds atomically past the same orphan condition, and the response discloses the accepted orphan candidates', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkRulingDecision(tools);
    const result = supersede(tools, old.id as string, UNCOVERED_FIELDS, true);

    const pinned = get(tools, old.id as string);
    assert.equal(pinned.status, 'superseded', 'EXPECTED FAILURE (red): TypeError before this line. Once built, an acknowledged orphan write must still proceed atomically');
    const newId = pinned.superseded_by as string;
    const newRec = get(tools, newId);
    assert.equal(newRec.statement, UNCOVERED_FIELDS.statement);

    const disclosed = JSON.stringify(result);
    assert.match(disclosed, /Flak/, 'the response discloses the orphan candidate it accepted (Flak ruling)');
    assert.match(disclosed, /prototype stabilizer|unassigned pending review/i, 'and the stabilizer ruling');
  } finally {
    cleanup();
  }
});

test('AC7: orphans_acknowledged:true with a COVERED new statement (zero orphan candidates) proceeds normally with no error', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkRulingDecision(tools);
    assert.doesNotThrow(
      () => supersede(tools, old.id as string, COVERED_FIELDS, true),
      'EXPECTED FAILURE (red) today for the wrong reason: this currently throws TypeError (method absent), which doesNotThrow will report — that failure IS the red. Once built, zero orphan candidates + orphans_acknowledged:true must not error'
    );
    assert.equal(get(tools, old.id as string).status, 'superseded');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC8 — fewer than 2 enumerated units never triggers the orphan refusal
// ===========================================================================

test('AC8: plain prose with no numbering/bullets never triggers the orphan refusal, even with a wholly different replacement', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'ac8-plain-prose', 'Plain prose statement with no numbering or bullets at all, just one ruling in free text.');
    assert.doesNotThrow(
      () =>
        supersede(tools, old.id as string, {
          title: 'ac8-new',
          statement: 'Totally unrelated replacement text about something else entirely.',
          alternatives_rejected: [],
          rationale: 'r2',
        }),
      'EXPECTED FAILURE (red) today for the wrong reason: TypeError (method absent). Once built, zero enumerated units must never trigger the orphan refusal'
    );
    assert.equal(get(tools, old.id as string).status, 'superseded');
  } finally {
    cleanup();
  }
});

test('AC8 boundary: exactly ONE enumerated unit (not two) never triggers the orphan refusal either', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'ac8-single-numbered', '1. The only ruling here is this one, about widgets.');
    assert.doesNotThrow(
      () =>
        supersede(tools, old.id as string, {
          title: 'ac8-new',
          statement: 'Completely different subject: gadgets, and nothing about widgets at all.',
          alternatives_rejected: [],
          rationale: 'r2',
        }),
      'EXPECTED FAILURE (red) today for the wrong reason: TypeError (method absent). Once built, exactly ONE enumerated unit is the normal single-ruling case, not a multi-ruling record — never orphan-refused'
    );
    assert.equal(get(tools, old.id as string).status, 'superseded');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC9 — slug continuity
// ===========================================================================

test('AC9: fields with no slug inherits the old record\'s auto-minted slug, and the slug resolves to the NEW record after supersede', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'Slug continuity origin decision', 'plain single-ruling prose statement.');
    const oldSlug = old.slug as string;
    assert.ok(oldSlug, 'precondition: the old decision auto-minted a slug from its title');

    supersede(tools, old.id as string, {
      title: 'Slug continuity replacement decision',
      statement: 'replacement statement.',
      alternatives_rejected: [],
      rationale: 'r2',
    });

    const pinnedOld = get(tools, old.id as string);
    assert.equal(pinnedOld.status, 'superseded', 'EXPECTED FAILURE (red): TypeError before this line');
    const newId = pinnedOld.superseded_by as string;
    const resolved = get(tools, oldSlug);
    assert.equal(resolved.id, newId, 'the inherited slug now resolves to the NEW record, not the old one');
    assert.notEqual(resolved.id, old.id, 'the slug moved off the old id');
  } finally {
    cleanup();
  }
});

test('AC9: fields carrying an EXPLICIT different slug gets that slug on the new record', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'Explicit slug origin decision', 'plain single-ruling prose statement.');
    supersede(tools, old.id as string, {
      title: 'x',
      statement: 'y',
      alternatives_rejected: [],
      rationale: 'r',
      slug: 'ac9-explicit-new-slug',
    });
    const pinnedOld = get(tools, old.id as string);
    assert.equal(pinnedOld.status, 'superseded', 'EXPECTED FAILURE (red): TypeError before this line');
    const newId = pinnedOld.superseded_by as string;
    const resolved = get(tools, 'ac9-explicit-new-slug');
    assert.equal(resolved.id, newId, 'the explicit slug resolves to the new record');
  } finally {
    cleanup();
  }
});

test('AC9: an explicit slug that collides with an existing slug-bearing record is REFUSED — nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    mkDecision(tools, 'Taken slug holder', 'holder statement.', { slug: 'ac9-already-taken' });
    const old = mkDecision(tools, 'Collision origin decision', 'plain single-ruling prose statement.');
    const before = decisionCount(tools);
    assert.throws(
      () =>
        supersede(tools, old.id as string, {
          title: 'x',
          statement: 'y',
          alternatives_rejected: [],
          rationale: 'r',
          slug: 'ac9-already-taken',
        }),
      /ac9-already-taken|already exists/i,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, an explicit colliding slug must refuse'
    );
    assert.equal(decisionCount(tools), before, 'nothing written on the slug-collision refusal');
    assert.equal(get(tools, old.id as string).status, 'active', 'old record untouched');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC10 — promotion_review re-point
// ===========================================================================

test('AC10: an OPEN promotion_review pointing at the old record is re-pointed IN PLACE to the new record — same item id, still open', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'ac10-target', 'plain single-ruling prose statement.');
    const review = tools.maintenanceEnqueue({ reason: 'promotion_review', text: `promote 'ac10-target'`, feature_link: old.id as string });

    supersede(tools, old.id as string, { title: 'ac10-new', statement: 'new statement.', alternatives_rejected: [], rationale: 'r2' });

    const pinnedOld = get(tools, old.id as string);
    assert.equal(pinnedOld.status, 'superseded', 'EXPECTED FAILURE (red): TypeError before this line');
    const newId = pinnedOld.superseded_by as string;

    const items = tools.maintenanceQuery({ system_reason: 'promotion_review', cap: 1000 }) as unknown as { id: string; feature_link?: string }[];
    const item = items.find((t) => t.id === review.record.id);
    assert.ok(item, 'the review item still exists — never drained by the supersede');
    assert.equal(item?.feature_link, newId, 're-pointed to the new record, same item id, still open');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC11 — response shape (loose)
// ===========================================================================

test('AC11: the response names both the superseded old id and the new record\'s id (loose shape check)', () => {
  const { tools, cleanup } = harness();
  try {
    const old = mkDecision(tools, 'ac11-target', 'plain single-ruling prose statement.');
    const result = supersede(tools, old.id as string, { title: 'ac11-new', statement: 'new statement.', alternatives_rejected: [], rationale: 'r2' });

    const pinnedOld = get(tools, old.id as string);
    assert.equal(pinnedOld.status, 'superseded', 'EXPECTED FAILURE (red): TypeError before this line');
    const newId = pinnedOld.superseded_by as string;

    const text = JSON.stringify(result);
    assert.match(text, new RegExp(escapeRegex(old.id as string)), 'the response names the superseded old id');
    assert.match(text, new RegExp(escapeRegex(newId)), "the response names the new record's id");
  } finally {
    cleanup();
  }
});
