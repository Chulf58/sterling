// ---------------------------------------------------------------------------
// Spec for the WINDOWED/FIELD READ extension to the existing MCP tool
// `knowledge_get` (decision compaction-tooling-windowed-read-plus-split,
// knowledge_get d452e085-0a12-4166-8cff-39ba3ced88af; board
// 136091d2-0f2a-44d3-801c-bbcb33a592ad).
//
// SterlingTools.knowledgeGet(id) EXISTS TODAY and takes exactly one
// argument. This file specs an extension: knowledgeGet(id, opts?) where
// opts is { field?: string; offset?: number; length?: number }. Written
// blind to tools.ts — `tools.test.ts`, `knowledge-supersede.test.ts` and
// `schema-nested-enums.test.ts` were read for harness conventions, fixture
// shapes, and the repo's cast-through-`unknown` precedent for calling a
// not-yet-existing (or not-yet-extended) method signature while still
// compiling under strict TS. No implementation source (tools.ts,
// server.ts, packages/schemas) was read.
//
// EXPECTED FAILURE SHAPE — IMPORTANT, and DIFFERENT from a wholly-new-tool
// spec: knowledgeGet(id, opts) does NOT throw a TypeError today, because
// JavaScript does not enforce arity — the real one-argument function simply
// ignores the second argument and returns the FULL, un-windowed record.
// So every test below is RED FOR AN ASSERTION REASON, not a crash reason:
// the returned object carries no `kind`, `field`, `total_chars`,
// `total_entries`, `value`, or `entries` key, so equality assertions on
// those fail (`undefined !== 'string'` etc.), and `assert.throws` calls
// fail with "missing expected exception" wherever the spec calls for a
// refusal (today: no refusal fires at all, because opts is inert). This is
// annotated per-test below; once knowledgeGet honours opts, each assertion
// discriminates on its own terms.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-21T12:00:00.000Z';
const WHAT_IT_DOES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 36 known chars, for exact slicing

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-get-window-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

// The extended signature does not exist on SterlingTools's declared type
// yet — cast through `unknown` so this file compiles under any TS
// strictness the runner applies (same precedent as
// knowledge-supersede.test.ts's `supersede()` helper), while the RUNTIME
// call still hits the real (currently one-argument, opts-ignoring) method.
interface WindowCapable {
  knowledgeGet(id: string, opts?: { field?: string; offset?: number; length?: number }): unknown;
}
function windowGet(tools: SterlingTools, id: string, opts?: { field?: string; offset?: number; length?: number }): Loose {
  return (tools as unknown as WindowCapable).knowledgeGet(id, opts) as Loose;
}

function mkArticle(tools: SterlingTools, slug: string): Loose {
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: WHAT_IT_DOES,
    intended_behavior: 'b',
    files: [{ path: `src/${slug}.ts`, role: 'impl' }],
    current_ac: [
      { ac_id: 'AC1', text: 'first ac', verifiable_at: 'final' },
      { ac_id: 'AC2', text: 'second ac', verifiable_at: 'final' },
      { ac_id: 'AC3', text: 'third ac', verifiable_at: 'final' },
    ],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record as unknown as Loose;
}

test('a STRING field window returns a windowed projection, not the full record — id/type/status/field/total_chars/offset/value/slug/version', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-string-target');

    // SANITY (not the red assertion): the plain, unwindowed call is untouched
    // by this feature — this is the "no field param: behavior unchanged"
    // half of the spec. It is folded in here rather than made a standalone
    // test because, on its own, it already passes today (opts is inert) and
    // would carry no red signal (rubric #3).
    const full = tools.knowledgeGet(article.id as string) as unknown as Loose;
    assert.equal(full.what_it_does, WHAT_IT_DOES, 'sanity: the plain unwindowed call is untouched by this feature');

    const windowed = windowGet(tools, article.id as string, { field: 'what_it_does', offset: 5, length: 10 });
    assert.equal(
      windowed.kind,
      'string',
      "EXPECTED FAILURE (red): knowledgeGet(id, opts) exists today but silently ignores the second argument (no TypeError) — this returns the FULL record, which carries no `kind` key, so `undefined !== 'string'`. Once built, a string field window reports kind:'string'"
    );
    assert.equal(windowed.id, article.id, 'full uuid of the resolved record');
    assert.equal(windowed.type, 'feature_article');
    assert.equal(windowed.status, 'active');
    assert.equal(windowed.field, 'what_it_does');
    assert.equal(windowed.total_chars, WHAT_IT_DOES.length, 'total_chars is the FULL field length, not the window length');
    assert.equal(windowed.offset, 5, 'the effective offset passed through');
    assert.equal(windowed.value, WHAT_IT_DOES.slice(5, 15), 'value === fullString.slice(offset, offset+length)');
    assert.equal(windowed.slug, 'window-string-target', 'slug carried alongside the windowed projection');
    assert.equal(windowed.version, 1, 'version carried alongside the windowed projection');
  } finally {
    cleanup();
  }
});

test('a STRING field window with no offset/length returns the WHOLE field, total_chars === value.length, offset defaults to 0', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-string-whole');
    const windowed = windowGet(tools, article.id as string, { field: 'what_it_does' });
    assert.equal(
      windowed.kind,
      'string',
      "EXPECTED FAILURE (red): no TypeError — the second argument is silently ignored today, so this is the full record with no `kind` key. Once built, kind:'string' with the whole value"
    );
    assert.equal(windowed.value, WHAT_IT_DOES);
    assert.equal(windowed.total_chars, (windowed.value as string).length);
    assert.equal(windowed.offset, 0, 'effective offset defaults to 0 when omitted');
  } finally {
    cleanup();
  }
});

test('an ARRAY field window (current_ac) returns entries + total_entries, offset/length counting ELEMENTS not characters', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-array-target');
    const windowed = windowGet(tools, article.id as string, { field: 'current_ac', offset: 1, length: 1 });
    assert.equal(
      windowed.kind,
      'array',
      "EXPECTED FAILURE (red): no TypeError — opts silently ignored today, full record returned with no `kind` key. Once built, an array field reports kind:'array'"
    );
    assert.equal(windowed.total_entries, 3, 'the full element count, not the window size');
    assert.equal(windowed.offset, 1);
    assert.deepEqual(
      (windowed.entries as { ac_id: string }[]).map((e) => e.ac_id),
      ['AC2'],
      'exactly the sliced elements — offset/length address ELEMENTS on an array field'
    );
  } finally {
    cleanup();
  }
});

test('a SCALAR field (version) returns kind:"value" whole; passing offset or length alongside a scalar field is REFUSED as not windowable', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-scalar-target');
    const windowed = windowGet(tools, article.id as string, { field: 'version' });
    assert.equal(
      windowed.kind,
      'value',
      "EXPECTED FAILURE (red): no TypeError — opts silently ignored today, full record returned with no `kind` key. Once built, a scalar field reports kind:'value'"
    );
    assert.equal(windowed.value, 1);

    assert.throws(
      () => windowGet(tools, article.id as string, { field: 'version', offset: 0 }),
      /not windowable/i,
      'EXPECTED FAILURE (red): today opts are silently ignored and NO throw occurs at all — assert.throws fails on "missing expected exception". Once built, offset alongside a scalar field must be refused as not windowable'
    );
    assert.throws(
      () => windowGet(tools, article.id as string, { field: 'version', length: 1 }),
      /not windowable/i,
      'same refusal shape for length alongside a scalar field'
    );
  } finally {
    cleanup();
  }
});

test('offset at/beyond the end of a STRING field is NOT an error — empty value, true total still reported (paging termination)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-string-end');
    const atEnd = windowGet(tools, article.id as string, { field: 'what_it_does', offset: WHAT_IT_DOES.length });
    assert.equal(
      atEnd.kind,
      'string',
      'EXPECTED FAILURE (red): no TypeError — opts silently ignored today, full record returned with no `kind` key'
    );
    assert.equal(atEnd.value, '', 'offset exactly at the end: empty value, not an error');
    assert.equal(atEnd.total_chars, WHAT_IT_DOES.length, 'the true total is still reported');

    const pastEnd = windowGet(tools, article.id as string, { field: 'what_it_does', offset: 1000 });
    assert.equal(pastEnd.value, '', 'offset far past the end: likewise empty, not an error');
    assert.equal(pastEnd.total_chars, WHAT_IT_DOES.length);
  } finally {
    cleanup();
  }
});

test('offset at/beyond the end of an ARRAY field is NOT an error — empty entries, true total still reported (paging termination)', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-array-end');
    const atEnd = windowGet(tools, article.id as string, { field: 'current_ac', offset: 3 });
    assert.equal(
      atEnd.kind,
      'array',
      'EXPECTED FAILURE (red): no TypeError — opts silently ignored today, full record returned with no `kind` key'
    );
    assert.deepEqual(atEnd.entries, [], 'offset exactly at the end: empty entries, not an error');
    assert.equal(atEnd.total_entries, 3, 'the true total is still reported');

    const pastEnd = windowGet(tools, article.id as string, { field: 'current_ac', offset: 999 });
    assert.deepEqual(pastEnd.entries, [], 'offset far past the end: likewise empty, not an error');
    assert.equal(pastEnd.total_entries, 3);
  } finally {
    cleanup();
  }
});

test('an unknown field name is REFUSED, naming the offending field AND listing the valid field set for the record\'s type', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-unknown-field');
    assert.throws(
      () => windowGet(tools, article.id as string, { field: 'not_a_real_field' }),
      (err: Error) => {
        assert.match(err.message, /not_a_real_field/, 'the refusal names the offending field');
        assert.match(err.message, /what_it_does|current_ac|files|slug|version|intended_behavior/, 'and lists at least one valid field name for feature_article (derived from knownFieldsFor)');
        return true;
      },
      'EXPECTED FAILURE (red): today opts are silently ignored and NO throw occurs — assert.throws fails on "missing expected exception". Once built, an unknown field name must be refused naming it plus the valid set'
    );
  } finally {
    cleanup();
  }
});

test('offset or length WITHOUT a field is REFUSED', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-no-field');
    assert.throws(
      () => windowGet(tools, article.id as string, { offset: 5 }),
      /field/i,
      'EXPECTED FAILURE (red): no throw occurs today (opts is inert). Once built, offset without a field name must be refused'
    );
    assert.throws(
      () => windowGet(tools, article.id as string, { length: 5 }),
      /field/i,
      'same refusal shape for length without a field name'
    );
  } finally {
    cleanup();
  }
});

test('id resolution ladder: a windowed read via the record\'s SLUG resolves and windows identically to the same read via uuid', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'window-via-slug');

    // sanity: the existing ladder already resolves this slug today (unchanged
    // by this feature) — not the red assertion.
    assert.equal((tools.knowledgeGet('window-via-slug') as unknown as Loose).id, article.id, 'sanity: slug resolution already works for the plain read');

    const bySlug = windowGet(tools, 'window-via-slug', { field: 'what_it_does', offset: 0, length: 3 });
    assert.equal(
      bySlug.kind,
      'string',
      'EXPECTED FAILURE (red): no TypeError — opts silently ignored today, full record returned with no `kind` key. Once built, slug resolution must window identically to uuid resolution'
    );
    assert.equal(bySlug.id, article.id, 'the windowed projection carries the full resolved uuid, not the slug used to address it');
    assert.equal(bySlug.value, WHAT_IT_DOES.slice(0, 3));

    const byUuid = windowGet(tools, article.id as string, { field: 'what_it_does', offset: 0, length: 3 });
    assert.deepEqual(bySlug, byUuid, 'identical projection regardless of address form');
  } finally {
    cleanup();
  }
});
