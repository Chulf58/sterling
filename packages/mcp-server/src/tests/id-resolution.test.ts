// ---------------------------------------------------------------------------
// Shared id resolution across the knowledge WRITE tools (board slice
// 85ecfe43-1e9b-47f2-a528-264d5987497b).
//
// knowledge_get already resolves three address forms for an existing record:
// full uuid, exact slug, and a unique 8-char id prefix — and refuses loudly
// (never picks) when a prefix is ambiguous. This slice extends the SAME
// contract to five write tools: knowledge_append, knowledge_edit,
// knowledge_update, knowledge_retire, and knowledge_link (both its `from`
// and `to` arguments).
//
// Written RED-FIRST, blind to tools.ts. Every "accepts" test resolves the
// SAME form through knowledge_get first (the parity baseline the spec
// names), then asserts the write tool's own resolution evidence (a
// `supersedes` link for append/edit/update, `.retired.id` for retire, the
// returned record's own id or its stored `target_id` for link) lands on the
// identical record. On current code, before this slice ships, the write
// tools do a plain exact-id lookup: the uuid-form case already passes
// (regression control), and the slug/prefix-form cases fail because the tool
// throws a "no record '<slug-or-prefix>'"-style refusal before any
// supersede/retire/link evidence can be produced — so the assertion is never
// reached and the test fails on that thrown error (or, if some accidental
// literal match occurred, on the resolved-id inequality). Each refusal test
// fails on current code because the current message says "no record ..."
// rather than naming ambiguity/multiple matches.
//
// Ambiguity construction: forced via store.create() writing a raw record
// whose id is built from a real record's 8-char prefix plus a fixed
// well-formed suffix — the exact convention tools.test.ts already uses for
// knowledge_get's own prefix-collision test (ids are server-minted, so a
// collision cannot be produced through the public create tool alone). No
// alternative ambiguity construction was needed.
//
// Scope note (resolved ambiguity): knowledge_retire takes two id arguments
// (the record to retire, and `in_favor_of`, the survivor). The spec singles
// out knowledge_link as needing BOTH its arguments covered, but lists
// knowledge_retire as a single item — so only the id-to-retire argument is
// exercised here; `in_favor_of` is left to whatever coverage the
// implementer's own tests give it, since inventing extra required behavior
// beyond what the work order names would be speculative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-11T12:00:00.000Z';

type Loose = Record<string, unknown>;
type AddressForm = 'uuid' | 'slug' | 'prefix';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-id-resolution-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mkArticle(tools: SterlingTools, slug: string, overrides: Loose = {}): Loose {
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
    ...overrides,
  }).record as unknown as Loose;
}

function mkDecision(tools: SterlingTools, title: string): Loose {
  return tools.knowledgeCreate('decision', {
    title,
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
  }).record as unknown as Loose;
}

function addressOf(record: Loose, form: AddressForm): string {
  if (form === 'uuid') return record.id as string;
  if (form === 'slug') return record.slug as string;
  return (record.id as string).slice(0, 8);
}

function linksOf(record: Loose): { rel: string; target_id: string }[] {
  return (record.links as { rel: string; target_id: string }[] | undefined) ?? [];
}

function supersedesTargetOf(record: Loose): string | undefined {
  return linksOf(record).find((l) => l.rel === 'supersedes')?.target_id;
}

// Forces a second record whose id shares `primaryId`'s first 8 chars — the
// same convention tools.test.ts uses for knowledge_get's own ambiguity test.
function seedPrefixTwin(store: SterlingStore, tools: SterlingTools, primaryId: string): string {
  const prefix = primaryId.slice(0, 8);
  const seed = mkDecision(tools, 'ambiguity twin seed');
  store.create({
    ...(JSON.parse(JSON.stringify(seed)) as Loose),
    id: `${prefix}-0000-4000-8000-000000000000`,
  });
  return prefix;
}

const UNRESOLVABLE = 'zzz-totally-unresolvable-identifier-ffff';

// ---------------------------------------------------------------------------
// SLOT 1: knowledge_append (array field: feature_article.history)
// ---------------------------------------------------------------------------

for (const form of ['uuid', 'slug', 'prefix'] as const) {
  test(`knowledge_append: accepts a ${form} address for id, resolving to the SAME record knowledge_get would (parity)`, () => {
    const { tools, cleanup } = harness();
    try {
      const seed = mkArticle(tools, `append-${form}-target`);
      const addr = addressOf(seed, form);

      const got = tools.knowledgeGet(addr) as unknown as Loose;
      assert.equal(got.id, seed.id, `sanity: knowledge_get already resolves the ${form} form to the seeded record`);

      const res = tools.knowledgeAppend(addr, 'history', [{ date: NOW, event: `via ${form}` }]) as unknown as {
        record: Loose;
      };
      const resolved = supersedesTargetOf(res.record);
      assert.equal(
        resolved,
        seed.id,
        form === 'uuid'
          ? 'regression control: the uuid form already resolves and supersedes correctly today'
          : `EXPECTED FAILURE on current code: knowledge_append has no ${form} resolution yet — it throws "no record '${addr}'" before this line, or (if it somehow matched) the supersedes link is missing/wrong so resolved !== seed.id`
      );
    } finally {
      cleanup();
    }
  });
}

test('knowledge_append: refuses an AMBIGUOUS 8-char prefix (parity with knowledge_get) and a genuinely unresolvable identifier naming it verbatim; writes nothing either way', () => {
  const { store, tools, cleanup } = harness();
  try {
    const seed = mkArticle(tools, 'append-ambiguity-target');
    const prefix = seedPrefixTwin(store, tools, seed.id as string);

    assert.throws(
      () => tools.knowledgeGet(prefix),
      /ambiguous/i,
      'sanity: knowledge_get itself refuses this prefix as ambiguous'
    );

    assert.throws(
      () => tools.knowledgeAppend(prefix, 'history', [{ date: NOW, event: 'should never land' }]),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: knowledge_append does no prefix resolution — it throws "no record '${prefix}'" instead, so this /ambiguous|multiple matches/i match fails`
    );
    assert.equal(
      (tools.knowledgeGet(seed.id as string) as unknown as Loose).version,
      1,
      'the ambiguous-prefix call must have written NOTHING — the seeded record is still version 1'
    );

    assert.throws(
      () => tools.knowledgeAppend(UNRESOLVABLE, 'history', [{ date: NOW, event: 'x' }]),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal must state the identifier AS GIVEN — likely already true today, since the current "no record" refusal already echoes the raw id, but this must keep holding after the change'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SLOT 2: knowledge_edit (long-string field: feature_article.what_it_does)
// ---------------------------------------------------------------------------

for (const form of ['uuid', 'slug', 'prefix'] as const) {
  test(`knowledge_edit: accepts a ${form} address for id, resolving to the SAME record knowledge_get would (parity)`, () => {
    const { tools, cleanup } = harness();
    try {
      const seed = mkArticle(tools, `edit-${form}-target`, { what_it_does: 'MARKER_TO_EDIT lives right here.' });
      const addr = addressOf(seed, form);

      const got = tools.knowledgeGet(addr) as unknown as Loose;
      assert.equal(got.id, seed.id, `sanity: knowledge_get already resolves the ${form} form to the seeded record`);

      const res = tools.knowledgeEdit(addr, 'what_it_does', 'MARKER_TO_EDIT', 'EDITED_MARKER') as unknown as {
        record: Loose;
      };
      const resolved = supersedesTargetOf(res.record);
      assert.equal(
        resolved,
        seed.id,
        form === 'uuid'
          ? 'regression control: the uuid form already resolves and supersedes correctly today'
          : `EXPECTED FAILURE on current code: knowledge_edit has no ${form} resolution yet — it throws "no record '${addr}'" before this line, or the supersedes link is missing/wrong`
      );
    } finally {
      cleanup();
    }
  });
}

test('knowledge_edit: refuses an AMBIGUOUS 8-char prefix (parity with knowledge_get) and a genuinely unresolvable identifier naming it verbatim; writes nothing either way', () => {
  const { store, tools, cleanup } = harness();
  try {
    const seed = mkArticle(tools, 'edit-ambiguity-target', { what_it_does: 'MARKER_TO_EDIT lives right here.' });
    const prefix = seedPrefixTwin(store, tools, seed.id as string);

    assert.throws(
      () => tools.knowledgeGet(prefix),
      /ambiguous/i,
      'sanity: knowledge_get itself refuses this prefix as ambiguous'
    );

    assert.throws(
      () => tools.knowledgeEdit(prefix, 'what_it_does', 'MARKER_TO_EDIT', 'EDITED_MARKER'),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: knowledge_edit does no prefix resolution — it throws "no record '${prefix}'" (or "does not appear") instead, so this match fails`
    );
    assert.equal(
      (tools.knowledgeGet(seed.id as string) as unknown as Loose).version,
      1,
      'the ambiguous-prefix call must have written NOTHING'
    );

    assert.throws(
      () => tools.knowledgeEdit(UNRESOLVABLE, 'what_it_does', 'MARKER_TO_EDIT', 'EDITED_MARKER'),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal must state the identifier AS GIVEN'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SLOT 3: knowledge_update (any updatable field: decision.rationale)
// ---------------------------------------------------------------------------

for (const form of ['uuid', 'slug', 'prefix'] as const) {
  test(`knowledge_update: accepts a ${form} address for id, resolving to the SAME record knowledge_get would (parity)`, () => {
    const { tools, cleanup } = harness();
    try {
      const seed = mkDecision(tools, `update ${form} target`);
      const addr = addressOf(seed, form);

      const got = tools.knowledgeGet(addr) as unknown as Loose;
      assert.equal(got.id, seed.id, `sanity: knowledge_get already resolves the ${form} form to the seeded record`);

      // knowledge_update returns the new version BARE (not wrapped in {record}) —
      // matches tools.test.ts's own usage (`const v2 = tools.knowledgeUpdate(...)`).
      const res = tools.knowledgeUpdate(addr, { rationale: `updated via ${form}` }) as unknown as Loose;
      const resolved = supersedesTargetOf(res);
      assert.equal(
        resolved,
        seed.id,
        form === 'uuid'
          ? 'regression control: the uuid form already resolves and supersedes correctly today'
          : `EXPECTED FAILURE on current code: knowledge_update has no ${form} resolution yet — it throws "no record '${addr}'" before this line, or the supersedes link is missing/wrong`
      );
    } finally {
      cleanup();
    }
  });
}

test('knowledge_update: refuses an AMBIGUOUS 8-char prefix (parity with knowledge_get) and a genuinely unresolvable identifier naming it verbatim; writes nothing either way', () => {
  const { store, tools, cleanup } = harness();
  try {
    const seed = mkDecision(tools, 'update ambiguity target');
    const prefix = seedPrefixTwin(store, tools, seed.id as string);

    assert.throws(
      () => tools.knowledgeGet(prefix),
      /ambiguous/i,
      'sanity: knowledge_get itself refuses this prefix as ambiguous'
    );

    assert.throws(
      () => tools.knowledgeUpdate(prefix, { rationale: 'should never land' }),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: knowledge_update does no prefix resolution — it throws "no record '${prefix}'" instead, so this match fails`
    );
    // Conductor-adjudicated oracle fix 2026-08-11 (coder exited tests-invalid):
    // decision records carry no `version` field (only feature_article does), so
    // the original `.version === 1` check was unsatisfiable by construction.
    // knowledge_update SUPERSEDES its target, so "wrote nothing" is observable
    // as the seed still resolving active — the same oracle the retire slot uses.
    const untouched = tools.knowledgeGet(seed.id as string) as unknown as Loose;
    assert.equal(untouched.status, 'active', 'the ambiguous-prefix call must have written NOTHING');
    assert.notEqual(untouched.rationale, 'should never land', 'the refused update payload never landed');

    assert.throws(
      () => tools.knowledgeUpdate(UNRESOLVABLE, { rationale: 'x' }),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal must state the identifier AS GIVEN'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SLOT 4: knowledge_retire (id to retire; survivor fixed by uuid — see the
// scope note at the top of the file for why in_favor_of is not exercised here)
// ---------------------------------------------------------------------------

for (const form of ['uuid', 'slug', 'prefix'] as const) {
  test(`knowledge_retire: accepts a ${form} address for id, resolving to the SAME record knowledge_get would (parity)`, () => {
    const { tools, cleanup } = harness();
    try {
      const dupe = mkDecision(tools, `retire ${form} dupe`);
      const survivor = mkDecision(tools, `retire ${form} survivor`);
      const addr = addressOf(dupe, form);

      const got = tools.knowledgeGet(addr) as unknown as Loose;
      assert.equal(got.id, dupe.id, `sanity: knowledge_get already resolves the ${form} form to the seeded record`);

      const res = tools.knowledgeRetire(addr, survivor.id as string) as unknown as { retired: Loose };
      assert.equal(
        res.retired.id,
        dupe.id,
        form === 'uuid'
          ? 'regression control: the uuid form already resolves and retires correctly today'
          : `EXPECTED FAILURE on current code: knowledge_retire has no ${form} resolution yet — it throws "no record ..." before this line, or retires the wrong record`
      );
      assert.equal(res.retired.superseded_by, survivor.id, 'the retired record forwards to the survivor');
    } finally {
      cleanup();
    }
  });
}

test('knowledge_retire: refuses an AMBIGUOUS 8-char prefix (parity with knowledge_get) and a genuinely unresolvable identifier naming it verbatim; writes nothing either way', () => {
  const { store, tools, cleanup } = harness();
  try {
    const dupe = mkDecision(tools, 'retire ambiguity dupe');
    const survivor = mkDecision(tools, 'retire ambiguity survivor');
    const prefix = seedPrefixTwin(store, tools, dupe.id as string);

    assert.throws(
      () => tools.knowledgeGet(prefix),
      /ambiguous/i,
      'sanity: knowledge_get itself refuses this prefix as ambiguous'
    );

    assert.throws(
      () => tools.knowledgeRetire(prefix, survivor.id as string),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: knowledge_retire does no prefix resolution — it throws "no record ..." instead, so this match fails`
    );
    assert.equal(
      (tools.knowledgeGet(dupe.id as string) as unknown as Loose).status,
      'active',
      'the ambiguous-prefix retire call must have written NOTHING — the dupe stays active'
    );

    assert.throws(
      () => tools.knowledgeRetire(UNRESOLVABLE, survivor.id as string),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal must state the identifier AS GIVEN'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SLOT 5: knowledge_link — the `from` argument
// ---------------------------------------------------------------------------

for (const form of ['uuid', 'slug', 'prefix'] as const) {
  test(`knowledge_link (from): accepts a ${form} address, resolving to the SAME record knowledge_get would (parity)`, () => {
    const { tools, cleanup } = harness();
    try {
      const from = mkDecision(tools, `link-from ${form} source`);
      const to = mkDecision(tools, `link-from ${form} target`);
      const addr = addressOf(from, form);

      const got = tools.knowledgeGet(addr) as unknown as Loose;
      assert.equal(got.id, from.id, `sanity: knowledge_get already resolves the ${form} form to the seeded record`);

      // knowledge_link returns the FROM record bare, links mutated in place
      // (no version bump — matches tools.test.ts: `linked.links.some(...)`).
      const res = tools.knowledgeLink(addr, 'informed_by', to.id as string) as unknown as Loose;
      assert.equal(
        res.id,
        from.id,
        form === 'uuid'
          ? 'regression control: the uuid form already resolves correctly today'
          : `EXPECTED FAILURE on current code: knowledge_link has no ${form} resolution for \`from\` yet — it throws "no record ..." before this line, or returns/links the wrong record`
      );
      assert.ok(
        linksOf(res).some((l) => l.rel === 'informed_by' && l.target_id === to.id),
        'the link landed on the resolved from-record, pointing at the real target id'
      );
    } finally {
      cleanup();
    }
  });
}

test('knowledge_link (from): refuses an AMBIGUOUS 8-char prefix (parity with knowledge_get) and a genuinely unresolvable identifier naming it verbatim; writes nothing either way', () => {
  const { store, tools, cleanup } = harness();
  try {
    const from = mkDecision(tools, 'link-from ambiguity source');
    const to = mkDecision(tools, 'link-from ambiguity target');
    const prefix = seedPrefixTwin(store, tools, from.id as string);

    assert.throws(
      () => tools.knowledgeGet(prefix),
      /ambiguous/i,
      'sanity: knowledge_get itself refuses this prefix as ambiguous'
    );

    assert.throws(
      () => tools.knowledgeLink(prefix, 'informed_by', to.id as string),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: knowledge_link does no prefix resolution for \`from\` — it throws "no record ..." instead, so this match fails`
    );
    assert.deepEqual(
      linksOf(tools.knowledgeGet(from.id as string) as unknown as Loose),
      [],
      'the ambiguous-prefix link call must have written NOTHING — the from-record has no links'
    );

    assert.throws(
      () => tools.knowledgeLink(UNRESOLVABLE, 'informed_by', to.id as string),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal must state the identifier AS GIVEN'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SLOT 6: knowledge_link — the `to` argument
// ---------------------------------------------------------------------------

for (const form of ['uuid', 'slug', 'prefix'] as const) {
  test(`knowledge_link (to): accepts a ${form} address, resolving to the SAME record knowledge_get would (parity)`, () => {
    const { tools, cleanup } = harness();
    try {
      const from = mkDecision(tools, `link-to ${form} source`);
      const to = mkDecision(tools, `link-to ${form} target`);
      const addr = addressOf(to, form);

      const got = tools.knowledgeGet(addr) as unknown as Loose;
      assert.equal(got.id, to.id, `sanity: knowledge_get already resolves the ${form} form to the seeded record`);

      const res = tools.knowledgeLink(from.id as string, 'informed_by', addr) as unknown as Loose;
      const stored = linksOf(res).find((l) => l.rel === 'informed_by');
      assert.equal(
        stored?.target_id,
        to.id,
        form === 'uuid'
          ? 'regression control: the uuid form already resolves correctly today'
          : `EXPECTED FAILURE on current code: knowledge_link has no ${form} resolution for \`to\` yet — it throws "no target record ..." before this line, or stores the raw ${form} literal instead of the resolved uuid`
      );
    } finally {
      cleanup();
    }
  });
}

test('knowledge_link (to): refuses an AMBIGUOUS 8-char prefix (parity with knowledge_get) and a genuinely unresolvable identifier naming it verbatim; writes nothing either way', () => {
  const { store, tools, cleanup } = harness();
  try {
    const from = mkDecision(tools, 'link-to ambiguity source');
    const to = mkDecision(tools, 'link-to ambiguity target');
    const prefix = seedPrefixTwin(store, tools, to.id as string);

    assert.throws(
      () => tools.knowledgeGet(prefix),
      /ambiguous/i,
      'sanity: knowledge_get itself refuses this prefix as ambiguous'
    );

    assert.throws(
      () => tools.knowledgeLink(from.id as string, 'informed_by', prefix),
      /ambiguous|multiple matches/i,
      `EXPECTED FAILURE on current code: knowledge_link does no prefix resolution for \`to\` — it throws "no target record ..." instead, so this match fails`
    );
    assert.deepEqual(
      linksOf(tools.knowledgeGet(from.id as string) as unknown as Loose),
      [],
      'the ambiguous-prefix link call must have written NOTHING — the from-record has no links'
    );

    assert.throws(
      () => tools.knowledgeLink(from.id as string, 'informed_by', UNRESOLVABLE),
      new RegExp(escapeRegex(UNRESOLVABLE)),
      'the refusal must state the identifier AS GIVEN'
    );
  } finally {
    cleanup();
  }
});
