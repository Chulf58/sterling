// ---------------------------------------------------------------------------
// Spec for the NEW MCP tool `knowledge_split` (decision
// compaction-tooling-windowed-read-plus-split, knowledge_get
// d452e085-0a12-4166-8cff-39ba3ced88af; board
// 136091d2-0f2a-44d3-801c-bbcb33a592ad), which mechanically enforces the
// split invariants decision 8b87efcb-1fe9-498d-92bf-2e002a338d56 established
// by hand for the hooks-suite split: prose moved VERBATIM, ac_ids inherited
// not renumbered, live_test_refs re-pointed, parent slug survives, file
// coverage total.
//
// knowledgeSplit(input) DOES NOT EXIST YET on SterlingTools — this file is
// written blind to tools.ts, from the dispatched spec only.
// `packages/mcp-server/src/tests/tools.test.ts`,
// `knowledge-supersede.test.ts` and `schema-nested-enums.test.ts` were read
// for harness conventions, fixture shapes (feature_article's
// slug/title/what_it_does/intended_behavior/files/current_ac/dependencies/
// state/version/history/live_test_refs, maintenance item seeding via
// maintenanceEnqueue/maintenanceQuery, and the cast-through-`unknown`
// precedent for a wholly-new tool method). No implementation source
// (tools.ts, server.ts, packages/schemas) was read.
//
// live_test_refs' EXACT element shape is not given by any read fixture (every
// existing example passes an empty array). Decision 8b87efcb's own prose
// states the mapping is "ac_id -> test paths", and every other list-like
// feature_article field (files[], current_ac[], alternatives_rejected[])
// follows the house convention of an array of small objects, never a keyed
// map — so this file ASSUMES `live_test_refs` is likewise an array of
// `{ac_id, <paths-field>}` objects and DISCOVERS the exact key names at
// RUNTIME via `knowledge_schema('feature_article')` (the existing, already
// real tool) rather than guessing them, per CLAUDE.md's own "ask the schema
// instead of guessing it" rule. This keeps fixture setup accurate without
// reading any implementation file. If this assumption is wrong (e.g. a keyed
// map instead of an array), fixture construction itself will throw at setup
// time rather than silently mis-testing — see the report for this caveat.
//
// EXPECTED FAILURE SHAPE ON CURRENT CODE (every test below, uniformly):
// SterlingTools has no `knowledgeSplit` method at all today, so every call
// through the `split()` helper below throws
// `TypeError: tools.knowledgeSplit is not a function` — the correct RED for
// a wholly new tool (same shape as knowledge-supersede.test.ts's own
// documented precedent). Once knowledgeSplit is implemented, each test then
// discriminates on its own assertions, annotated per-test below.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-08-21T12:00:00.000Z';

type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-knowledge-split-'));
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
// honestly. This is the ONLY place the not-yet-existing surface is named
// (same precedent as knowledge-supersede.test.ts's `supersede()` helper).
interface SplitCapable {
  knowledgeSplit(input: Loose): unknown;
}
function split(tools: SterlingTools, input: Loose): Loose {
  return (tools as unknown as SplitCapable).knowledgeSplit(input) as Loose;
}

// test-repair 2026-08-22: under stable-identity-design-v2 a write mutates in
// place (id stable) — the pre-write snapshot is archived in record_versions
// and read back via knowledge_get(id, { version }). [stable-identity-design-v2]
function knowledgeGetAtVersion(tools: SterlingTools, id: string, version: number): Loose {
  return (
    tools as unknown as { knowledgeGet: (id: string, opts?: { version: number }) => Loose }
  ).knowledgeGet(id, { version });
}

function articleCount(tools: SterlingTools): number {
  return tools.knowledgeQuery({ types: ['feature_article'] }).length;
}

function assertParentUntouched(tools: SterlingTools, parent: Loose) {
  const pinned = tools.knowledgeGet(parent.id as string) as unknown as Loose;
  assert.equal(pinned.status, 'active', 'the parent is untouched by the refused split');
  assert.equal(pinned.version, 1, 'the parent version did not bump on a refused split');
}

function assertNoSlug(tools: SterlingTools, slug: string) {
  assert.throws(() => tools.knowledgeGet(slug), /no record|not found|unresolvable/i, `no record exists under slug '${slug}' after the refused split`);
}

// ---------------------------------------------------------------------------
// Discover live_test_refs' actual element-key names via the EXISTING
// knowledge_schema tool, rather than guessing — see file header.
// ---------------------------------------------------------------------------
type FieldDescriptor = {
  name: string;
  type: string;
  enum_values?: string[];
  element_fields?: { name: string; type: string; enum_values?: string[] }[];
};

function liveTestRefsFieldNames(tools: SterlingTools): { acKey: string; pathsKey: string } {
  const schema = tools.knowledgeSchema('feature_article');
  const field = schema.fields.find((f) => f.name === 'live_test_refs') as FieldDescriptor | undefined;
  assert.ok(field, "feature_article declares a 'live_test_refs' field (every fixture in tools.test.ts carries one)");
  const fromElements = (field!.element_fields ?? []).map((ef) => ef.name);
  const fromTypeString = /\{([^}]*)\}/.exec(field!.type)?.[1]?.split(',').map((s) => s.trim()) ?? [];
  const names = fromElements.length > 0 ? fromElements : fromTypeString;
  assert.ok(names.length >= 2, "live_test_refs' element shape must name at least an ac_id-like key and a test-path key");
  const acKey = names.find((n) => n === 'ac_id') ?? names[0];
  const pathsKey = names.find((n) => n !== acKey) ?? names[1];
  return { acKey, pathsKey };
}

function mkParentArticle(tools: SterlingTools, slug = 'compaction-parent'): Loose {
  const { acKey, pathsKey } = liveTestRefsFieldNames(tools);
  return tools.knowledgeCreate('feature_article', {
    slug,
    title: 'Compaction parent',
    what_it_does: 'Does the whole compacted thing across three files.',
    intended_behavior: 'Behaves as the whole subsystem, before any split.',
    files: [
      { path: 'src/parent/a.ts', role: 'core' },
      { path: 'src/parent/b.ts', role: 'helper' },
      { path: 'src/parent/c.ts', role: 'serializer (uncommitted at writing)' },
    ],
    current_ac: [
      { ac_id: 'AC1', text: 'AC1: the core path works', verifiable_at: 'final' },
      { ac_id: 'AC2', text: 'AC2: the helper path works', verifiable_at: 'final' },
      { ac_id: 'AC3', text: 'AC3: the serializer path works', verifiable_at: 'final' },
    ],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [
      { date: NOW, event: 'seed' },
      { date: NOW, event: 'reconcile 1' },
      { date: NOW, event: 'reconcile 2' },
    ],
    live_test_refs: [
      { [acKey]: 'AC1', [pathsKey]: ['tests/ac1.test.ts'] },
      { [acKey]: 'AC2', [pathsKey]: ['tests/ac2.test.ts'] },
      { [acKey]: 'AC3', [pathsKey]: ['tests/ac3.test.ts'] },
    ],
  }).record as unknown as Loose;
}

// ===========================================================================
// Success path — one comprehensive fixture, per the spec's own grouping.
// ===========================================================================

test('success: splitting off one child preserves parent lineage, moves files/AC/live_test_refs VERBATIM to the child, and file coverage totals exactly', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const { acKey } = liveTestRefsFieldNames(tools);

    const raw = split(tools, {
      id: parent.id,
      children: [
        {
          slug: 'compaction-child-b',
          title: 'Compaction child B',
          what_it_does: 'Handles the b/c half of the parent.',
          intended_behavior: 'Behaves per AC2/AC3.',
          move_files: ['src/parent/b.ts', 'src/parent/c.ts'],
          move_ac_ids: ['AC2', 'AC3'],
        },
      ],
      parent_what_it_does: 'Does the a.ts half only, after the split.',
      reason: 'oversize split test',
    });
    const result = raw as unknown as { parent: { id: string; slug: string; version: number }; children: { id: string; slug: string }[] };

    // response shape
    assert.equal(
      result.parent?.slug,
      'compaction-parent',
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeSplit does not exist yet. Once built, the parent keeps its ORIGINAL slug'
    );
    assert.equal(result.parent.version, 2, 'parent version bumped exactly once by the split');
    assert.equal(result.children.length, 1, 'exactly one child minted');
    const childRef = result.children[0];
    assert.equal(childRef.slug, 'compaction-child-b');

    // parent survives under its ORIGINAL slug at version+1 — trimmed IN PLACE
    // under stable-identity-design-v2 (id stable, version bumped): that IS
    // the design's parent-survives rule. The pre-split state is archived and
    // readable at its old version, not under a separately-minted superseded
    // id. [stable-identity-design-v2]
    assert.equal(result.parent.id, parent.id, 'the parent id stays stable across the split — no re-mint');
    const oldParentSnapshot = knowledgeGetAtVersion(tools, parent.id as string, 1);
    assert.equal(
      (oldParentSnapshot.files as { path: string }[]).length,
      3,
      'the pre-split parent state is archived in full (all three files) and readable by version'
    );
    const newParent = tools.knowledgeGet(result.parent.id) as unknown as Loose;
    assert.equal(newParent.status, 'active');
    assert.equal(newParent.slug, 'compaction-parent', 'the surviving parent keeps its original slug');
    assert.equal(newParent.what_it_does, 'Does the a.ts half only, after the split.', 'parent what_it_does replaced by parent_what_it_does');

    // files/current_ac reduced by exactly the moved entries
    const parentFiles = (newParent.files as { path: string; role: string }[]).map((f) => f.path);
    assert.deepEqual([...parentFiles].sort(), ['src/parent/a.ts'], 'parent retains only the un-moved file');
    const parentAcIds = (newParent.current_ac as { ac_id: string }[]).map((a) => a.ac_id);
    assert.deepEqual(parentAcIds, ['AC1'], 'parent retains only the un-moved AC');

    // history PRESERVED plus one appended split entry naming the child slug
    const parentHistory = newParent.history as { event: string }[];
    assert.equal(parentHistory.length, 4, 'the three original history entries survive plus exactly one appended split entry');
    assert.deepEqual(
      parentHistory.slice(0, 3).map((h) => h.event),
      ['seed', 'reconcile 1', 'reconcile 2'],
      'original history preserved verbatim, in order'
    );
    assert.match(parentHistory[3].event, /compaction-child-b/, 'the appended split entry names the child slug');

    // child is a new active feature_article, version 1
    const child = tools.knowledgeGet(childRef.id) as unknown as Loose;
    assert.equal(child.status, 'active');
    assert.equal(child.version, 1);
    assert.equal(child.type, 'feature_article');

    // files moved VERBATIM — identical entries, same role strings (including
    // the deliberately odd role text, to prove nothing got reworded)
    const originalBFile = (parent.files as { path: string; role: string }[]).find((f) => f.path === 'src/parent/b.ts');
    const originalCFile = (parent.files as { path: string; role: string }[]).find((f) => f.path === 'src/parent/c.ts');
    const childFiles = child.files as { path: string; role: string }[];
    assert.deepEqual(childFiles.find((f) => f.path === 'src/parent/b.ts'), originalBFile, 'file b moved verbatim, same role string');
    assert.deepEqual(childFiles.find((f) => f.path === 'src/parent/c.ts'), originalCFile, 'file c moved verbatim, same role string (including its odd wording)');

    // current_ac moved VERBATIM with ORIGINAL ac_ids — never renumbered
    const originalAC2 = (parent.current_ac as { ac_id: string }[]).find((a) => a.ac_id === 'AC2');
    const originalAC3 = (parent.current_ac as { ac_id: string }[]).find((a) => a.ac_id === 'AC3');
    const childAC = child.current_ac as { ac_id: string }[];
    assert.deepEqual(childAC.find((a) => a.ac_id === 'AC2'), originalAC2, 'AC2 moved verbatim, ac_id never renumbered');
    assert.deepEqual(childAC.find((a) => a.ac_id === 'AC3'), originalAC3, 'AC3 moved verbatim, ac_id never renumbered');

    // live_test_refs: entries whose ac_id moved now live on the child and are
    // ABSENT from the parent — no orphaned mapping on either side
    const parentRefs = newParent.live_test_refs as Loose[];
    const childRefs = child.live_test_refs as Loose[];
    assert.ok(!parentRefs.some((r) => r[acKey] === 'AC2'), 'AC2 live_test_refs mapping no longer on the parent');
    assert.ok(!parentRefs.some((r) => r[acKey] === 'AC3'), 'AC3 live_test_refs mapping no longer on the parent');
    assert.ok(childRefs.some((r) => r[acKey] === 'AC2'), 'AC2 live_test_refs mapping now on the child');
    assert.ok(childRefs.some((r) => r[acKey] === 'AC3'), 'AC3 live_test_refs mapping now on the child');
    assert.ok(parentRefs.some((r) => r[acKey] === 'AC1'), 'AC1 mapping (unmoved) stays on the parent');
    assert.equal(parentRefs.length, 1, 'no orphaned mapping left on the parent for a moved ac_id');
    assert.equal(childRefs.length, 2, 'no orphaned mapping missing on the child for a moved ac_id');

    // one originating history entry naming the parent slug
    const childHistory = child.history as { event: string }[];
    assert.equal(childHistory.length, 1, 'the child gets exactly one originating history entry');
    assert.match(childHistory[0].event, /compaction-parent/, 'the originating entry names the parent slug');

    // dependencies default to {relies_on: [parent slug], relied_by: []}
    const childDeps = child.dependencies as { relies_on: string[]; relied_by: string[] };
    assert.deepEqual(childDeps.relies_on, ['compaction-parent'], 'default dependency on the parent slug');
    assert.deepEqual(childDeps.relied_by, []);

    // state inherited from the parent
    assert.equal(child.state, 'active');

    // NO concept_family set
    assert.equal(child.concept_family, undefined, 'a split child carries no concept_family marker');

    // FILE COVERAGE TOTAL: union of parent-retained + all children's paths
    // === the original path set exactly
    const allChildPaths = childFiles.map((f) => f.path);
    const coverage = [...parentFiles, ...allChildPaths].sort();
    const originalPaths = (parent.files as { path: string }[]).map((f) => f.path).sort();
    assert.deepEqual(coverage, originalPaths, 'every originally-owned path lands on exactly the parent or one child — no drop, no duplicate');
  } finally {
    cleanup();
  }
});

test('id resolution ladder: the parent addressed by SLUG resolves and splits the same as by uuid', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools, 'compaction-parent-via-slug');
    const raw = split(tools, {
      id: parent.slug,
      children: [
        {
          slug: 'compaction-child-via-slug',
          title: 'child',
          what_it_does: 'child body',
          intended_behavior: 'child behavior',
          move_files: ['src/parent/c.ts'],
          move_ac_ids: ['AC3'],
        },
      ],
      parent_what_it_does: 'parent body after split via slug address',
    });
    const result = raw as unknown as { parent: { id: string } };
    const newParent = tools.knowledgeGet(result.parent.id) as unknown as Loose;
    assert.equal(
      newParent.status,
      'active',
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeSplit does not exist yet. Once built, a slug-addressed parent id must resolve and split exactly as a uuid does'
    );
    assert.equal(newParent.slug, 'compaction-parent-via-slug');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// Refusal cases — each names its offense; the store is unchanged after ANY
// refusal (parent still at its old version, no child record exists).
// ===========================================================================

test('refusal: parent id resolving to a NON-feature_article (e.g. a decision) is refused, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const dec = tools.knowledgeCreate('decision', { title: 'not an article', statement: 's', alternatives_rejected: [], rationale: 'r' }).record as unknown as Loose;
    assert.throws(
      () =>
        split(tools, {
          id: dec.id,
          children: [{ slug: 'child-x', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: [], move_ac_ids: [] }],
          parent_what_it_does: 'x',
        }),
      /feature_article/i,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, a non-feature_article old_id must be refused naming the type mismatch'
    );
    assert.equal(tools.knowledgeGet(dec.id as string).status, 'active', 'the decision is untouched');
    assertNoSlug(tools, 'child-x');
  } finally {
    cleanup();
  }
});

test('refusal: a child move_files path NOT present in the parent\'s files is refused, naming the path', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [{ slug: 'child-x', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: ['src/parent/does-not-exist.ts'], move_ac_ids: [] }],
          parent_what_it_does: 'x',
        }),
      /does-not-exist\.ts/,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, a path not owned by the parent must be refused by name'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'child-x');
  } finally {
    cleanup();
  }
});

test('refusal: a child move_ac_ids id NOT present in parent.current_ac is refused, naming the ac_id', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [{ slug: 'child-ac', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: [], move_ac_ids: ['AC99'] }],
          parent_what_it_does: 'x',
        }),
      /AC99/,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, an ac_id not owned by the parent must be refused by name'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'child-ac');
  } finally {
    cleanup();
  }
});

test('refusal: the SAME path claimed by two children is refused, naming the path', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [
            { slug: 'child-p', title: 'p', what_it_does: 'p', intended_behavior: 'p', move_files: ['src/parent/b.ts'], move_ac_ids: [] },
            { slug: 'child-q', title: 'q', what_it_does: 'q', intended_behavior: 'q', move_files: ['src/parent/b.ts'], move_ac_ids: [] },
          ],
          parent_what_it_does: 'x',
        }),
      /src\/parent\/b\.ts/,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, a path claimed by two children must be refused by name'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'child-p');
    assertNoSlug(tools, 'child-q');
  } finally {
    cleanup();
  }
});

test('refusal: the SAME ac_id claimed by two children is refused, naming the ac_id', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [
            { slug: 'child-ac-p', title: 'p', what_it_does: 'p', intended_behavior: 'p', move_files: [], move_ac_ids: ['AC2'] },
            { slug: 'child-ac-q', title: 'q', what_it_does: 'q', intended_behavior: 'q', move_files: [], move_ac_ids: ['AC2'] },
          ],
          parent_what_it_does: 'x',
        }),
      /AC2/,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, an ac_id claimed by two children must be refused by name'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'child-ac-p');
    assertNoSlug(tools, 'child-ac-q');
  } finally {
    cleanup();
  }
});

test('refusal: a child slug colliding with an EXISTING feature_article slug is refused, naming the slug', () => {
  const { tools, cleanup } = harness();
  try {
    tools.knowledgeCreate('feature_article', {
      slug: 'taken-slug',
      title: 'taken',
      what_it_does: 'x',
      intended_behavior: 'y',
      files: [{ path: 'src/taken.ts', role: 'impl' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    });
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [{ slug: 'taken-slug', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: ['src/parent/b.ts'], move_ac_ids: [] }],
          parent_what_it_does: 'x',
        }),
      /taken-slug/,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, a child slug colliding with an existing feature_article must be refused'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
  } finally {
    cleanup();
  }
});

test('refusal: two children in ONE call sharing a slug is refused, naming the collision', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [
            { slug: 'dup-child-slug', title: 'a', what_it_does: 'a', intended_behavior: 'a', move_files: ['src/parent/b.ts'], move_ac_ids: [] },
            { slug: 'dup-child-slug', title: 'b', what_it_does: 'b', intended_behavior: 'b', move_files: ['src/parent/c.ts'], move_ac_ids: [] },
          ],
          parent_what_it_does: 'x',
        }),
      /dup-child-slug/,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, two children sharing one slug in a single call must be refused'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
  } finally {
    cleanup();
  }
});

test('refusal: a split moving ALL of the parent\'s files is refused — the parent must retain at least one owned file (full donation refused)', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [
            {
              slug: 'child-all',
              title: 'x',
              what_it_does: 'x',
              intended_behavior: 'x',
              move_files: ['src/parent/a.ts', 'src/parent/b.ts', 'src/parent/c.ts'],
              move_ac_ids: [],
            },
          ],
          parent_what_it_does: 'x',
        }),
      /retain|at least one/i,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, donating every owned file must be refused — the parent must keep at least one'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'child-all');
  } finally {
    cleanup();
  }
});

test('refusal: an empty children array is refused at the schema level', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [],
          parent_what_it_does: 'x',
        }),
      /children|non-empty|min|at least/i,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, an empty children array must be refused at the schema level'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
  } finally {
    cleanup();
  }
});

test('atomicity: one valid child plus one invalid child (unknown path) refuses the WHOLE call and creates NO child record — not even the valid one', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);
    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [
            { slug: 'valid-child', title: 'v', what_it_does: 'v', intended_behavior: 'v', move_files: ['src/parent/b.ts'], move_ac_ids: ['AC2'] },
            { slug: 'invalid-child', title: 'i', what_it_does: 'i', intended_behavior: 'i', move_files: ['src/parent/zzz-missing.ts'], move_ac_ids: [] },
          ],
          parent_what_it_does: 'x',
        }),
      /zzz-missing\.ts/,
      'EXPECTED FAILURE (red): TypeError before this line. Once built, a call mixing a valid and an invalid child must refuse atomically'
    );
    assert.equal(articleCount(tools), before, 'nothing written — not even the valid child was created');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'valid-child');
    assertNoSlug(tools, 'invalid-child');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// resolves semantics — mirrors the existing knowledge_update explicit-claim
// convention (decision 68988832): an item named in `resolves` is closed by
// the discharging write; an unnamed sibling item stays open. No dedicated
// resolves-claim fixture helper was found in the three files read for this
// spec (tools.test.ts's comments reference a separate
// `resolves-claim.test.ts`, not among the files this dispatch named to
// read) — this test is built directly on tools.test.ts's own
// maintenanceEnqueue/maintenanceQuery conventions, per the dispatch's
// fallback instruction.
// ===========================================================================

test('resolves: an item named in resolves is closed by the split; an unnamed sibling item stays open', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const namedItem = tools.maintenanceEnqueue({
      reason: 'article_oversize',
      text: `article 'compaction-parent' is a split candidate`,
      file_keys: ['src/parent/b.ts'],
    });
    const otherItem = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: 'unrelated reconcile debt, untouched by this split',
      file_keys: ['src/other.ts'],
    });

    split(tools, {
      id: parent.id,
      children: [{ slug: 'compaction-child-resolves', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: ['src/parent/b.ts'], move_ac_ids: ['AC2'] }],
      parent_what_it_does: 'x still active after the split',
      resolves: [namedItem.record.id],
    });

    const open = tools.maintenanceQuery({ cap: 1000 });
    assert.ok(
      !open.some((t) => (t as unknown as { id: string }).id === namedItem.record.id),
      'EXPECTED FAILURE (red): TypeError before this line — knowledgeSplit does not exist yet. Once built, the item named in resolves is closed by the split'
    );
    assert.ok(open.some((t) => (t as unknown as { id: string }).id === otherItem.record.id), 'the unnamed sibling item stays open');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// STRENGTHENING — appended post-implementation. knowledgeSplit now exists;
// these pin review-adjudicated `resolves` gating and the two-wrapper
// (knowledgeSplit / knowledgeSplitResult) oversize re-measure, plus two
// pre-write validation edges (default dependency back-linking, empty
// move_files). Every refusal here reuses the file's own
// assertParentUntouched/assertNoSlug/articleCount store-unchanged idiom
// verbatim. No implementation file (tools.ts, server.ts, packages/schemas)
// was read for this addendum — the 60000-char oversize default and the
// `resolves`/`maintenanceEnqueue{reason,text,file_keys}`/`maintenanceQuery
// {system_reason,cap}` shapes are taken from this file's own frozen fixture
// (lines 583-614 above) and from packages/mcp-server/src/tests/tools.test.ts
// (a sibling TEST file, not implementation), per the dispatch's own
// instruction to mirror the frozen resolves test's article_oversize seeding.
//
// EXPECTED FAILURE SHAPE if a pinned behavior does NOT hold (green is
// expected on current code since knowledgeSplit/knowledgeSplitResult are
// implemented; per-test failure shape noted above each test):
//   1) assert.throws would report "Missing expected exception" (the split
//      succeeded when a promotion_review-named resolves should refuse it).
//   2) assert.throws would report "Missing expected exception" (the split
//      succeeded when an unrelated resolves target should refuse it).
//   3) the split call itself would throw (success path breaks) OR the
//      `!open.some(...)` assertion would fail because the marker-matched
//      item was left open instead of closed.
//   4) either `Array.isArray(result.warnings)` fails (wrapper does not
//      expose a warnings array) or the `.some(/article_oversize_chars
//      threshold/)` assertion fails (a still-huge parent is not re-flagged
//      immediately after the split), or no open article_oversize item names
//      the parent afterward.
//   5) either `parentDeps.relied_by.includes(childSlug)` fails (parent's own
//      surviving version was not back-linked to its new child) or
//      `childDeps.relies_on.includes(parentSlug)` fails.
//   6) assert.throws would report "Missing expected exception" (a child
//      with move_files: [] was accepted) — or the message-shape asserts
//      fail if it refuses for the wrong reason without naming the slug/file
//      requirement.
// ===========================================================================

// The server also registers a `knowledgeSplitResult` wrapper (the Result
// convention used throughout this codebase for knowledgeUpdateResult /
// knowledgeAppend / knowledgeEdit — each returns `{ ...record shape,
// warnings }`). It is not declared on SterlingTools' TS type either — same
// cast-through-`unknown` precedent as `SplitCapable`/`split()` above.
interface SplitResultCapable {
  knowledgeSplitResult(input: Loose): unknown;
}
function splitResult(tools: SterlingTools, input: Loose): Loose {
  return (tools as unknown as SplitResultCapable).knowledgeSplitResult(input) as Loose;
}

test('refusal: resolves naming a promotion_review item is refused — a human gate never drains through a split, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools, 'compaction-parent-promo');
    const before = articleCount(tools);
    const reviewItem = tools.maintenanceEnqueue({
      reason: 'promotion_review',
      text: `promotion review pending for 'compaction-parent-promo'`,
      file_keys: ['src/parent/b.ts'],
    });

    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [{ slug: 'child-promo', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: ['src/parent/b.ts'], move_ac_ids: [] }],
          parent_what_it_does: 'x',
          resolves: [reviewItem.record.id],
        }),
      /promotion_review/i,
      'a promotion_review item named in resolves must be refused by name — a human gate never drains through a split'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'child-promo');
    const open = tools.maintenanceQuery({ cap: 1000 });
    assert.ok(
      open.some((t) => (t as unknown as { id: string }).id === reviewItem.record.id),
      'the promotion_review item stays open, untouched by the refused split'
    );
  } finally {
    cleanup();
  }
});

test('refusal: resolves naming an unrelated system item (different record, no oversize marker for THIS parent) is refused, nothing written', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools, 'compaction-parent-unrelated');
    const otherArticle = tools.knowledgeCreate('feature_article', {
      slug: 'unrelated-other-article',
      title: 'other',
      what_it_does: 'x',
      intended_behavior: 'y',
      files: [{ path: 'src/other/z.ts', role: 'impl' }],
      current_ac: [],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'seed' }],
      live_test_refs: [],
    }).record as unknown as Loose;
    const unrelatedItem = tools.maintenanceEnqueue({
      reason: 'reconcile_needed',
      text: `record ${otherArticle.id as string} needs reconciliation, unrelated to compaction-parent-unrelated`,
      file_keys: ['src/other/z.ts'],
    });
    const before = articleCount(tools);

    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [{ slug: 'child-unrelated-resolves', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: ['src/parent/b.ts'], move_ac_ids: [] }],
          parent_what_it_does: 'x',
          resolves: [unrelatedItem.record.id],
        }),
      Error,
      'resolves naming an item unrelated to this parent (different feature_link, no oversize marker for this parent) must be refused'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'child-unrelated-resolves');
    const open = tools.maintenanceQuery({ cap: 1000 });
    assert.ok(
      open.some((t) => (t as unknown as { id: string }).id === unrelatedItem.record.id),
      'the unrelated item stays open, untouched by the refused split'
    );
    assert.equal((tools.knowledgeGet(otherArticle.id as string) as unknown as Loose).status, 'active', 'the unrelated article is untouched');
  } finally {
    cleanup();
  }
});

test('resolves: an article_oversize item whose text begins with the oversize marker for THIS parent closes on a successful split (the motivating case)', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools, 'compaction-parent-marker');
    const markerItem = tools.maintenanceEnqueue({
      reason: 'article_oversize',
      text: `article 'compaction-parent-marker' exceeds the article_oversize_chars threshold — split it or trim it`,
      file_keys: ['src/parent/b.ts'],
    });

    const raw = split(tools, {
      id: parent.id,
      children: [{ slug: 'compaction-child-marker', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: ['src/parent/b.ts'], move_ac_ids: ['AC2'] }],
      parent_what_it_does: 'parent body after the split, well under threshold',
      resolves: [markerItem.record.id],
    });
    assert.ok((raw as unknown as { parent: { id: string } }).parent.id, 'the split succeeded (the motivating oversize-split case)');

    const open = tools.maintenanceQuery({ cap: 1000 });
    assert.ok(
      !open.some((t) => (t as unknown as { id: string }).id === markerItem.record.id),
      'the article_oversize item naming this parent by its oversize marker is closed by the successful split'
    );
  } finally {
    cleanup();
  }
});

test('oversize re-measure: a split whose parent_what_it_does remains huge re-flags article_oversize via knowledgeSplitResult — warns and leaves an open item naming the parent', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    // Fixture's store config is the default (harness() takes no config
    // override) — article_oversize_chars defaults to 60000 (per dispatch);
    // this prose stays well over that after trimming.
    const stillHugeProse = 'y'.repeat(61000);

    const raw = splitResult(tools, {
      id: parent.id,
      children: [
        {
          slug: 'compaction-child-oversize',
          title: 'child',
          what_it_does: 'child body',
          intended_behavior: 'child behavior',
          move_files: ['src/parent/b.ts'],
          move_ac_ids: ['AC2'],
        },
      ],
      parent_what_it_does: stillHugeProse,
    });
    const result = raw as unknown as { parent: { id: string }; children: { id: string; slug: string }[]; warnings: string[] };

    assert.ok(Array.isArray(result.warnings), 'knowledgeSplitResult returns a warnings array');
    assert.ok(
      result.warnings.some((w) => /article_oversize_chars threshold/.test(w)),
      'the still-huge parent re-flags oversize immediately after the split, on the same warnings channel as knowledge_update/append/edit'
    );

    const items = tools.maintenanceQuery({ cap: 1000, system_reason: 'article_oversize' });
    assert.ok(
      items.some((t) => (t as unknown as { text: string }).text.includes("'compaction-parent'")),
      'an open article_oversize item exists naming the parent after the split'
    );
  } finally {
    cleanup();
  }
});

test('symmetric dependencies: a default-dependencies split back-links the parent — the surviving parent version relied_by contains the child slug, and the child relies_on contains the parent slug', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools, 'compaction-parent-symdeps');

    const raw = split(tools, {
      id: parent.id,
      children: [
        {
          slug: 'compaction-child-symdeps',
          title: 'child',
          what_it_does: 'child body',
          intended_behavior: 'child behavior',
          move_files: ['src/parent/b.ts'],
          move_ac_ids: ['AC2'],
        },
      ],
      parent_what_it_does: 'parent body after split, symmetric-dependency check',
    });
    const result = raw as unknown as { parent: { id: string }; children: { id: string; slug: string }[] };

    const newParent = tools.knowledgeGet(result.parent.id) as unknown as Loose;
    const parentDeps = newParent.dependencies as { relies_on: string[]; relied_by: string[] };
    assert.ok(
      parentDeps.relied_by.includes('compaction-child-symdeps'),
      'the surviving parent version records the new child as a dependent (relied_by) — the default split back-links both directions, not just child-to-parent'
    );

    const child = tools.knowledgeGet(result.children[0].id) as unknown as Loose;
    const childDeps = child.dependencies as { relies_on: string[]; relied_by: string[] };
    assert.ok(
      childDeps.relies_on.includes('compaction-parent-symdeps'),
      'the child records relies_on the parent slug by default'
    );
  } finally {
    cleanup();
  }
});

test('refusal: a child with move_files: [] is refused pre-write, naming the child slug and requiring a child to own at least one file', () => {
  const { tools, cleanup } = harness();
  try {
    const parent = mkParentArticle(tools);
    const before = articleCount(tools);

    assert.throws(
      () =>
        split(tools, {
          id: parent.id,
          children: [{ slug: 'child-no-files', title: 'x', what_it_does: 'x', intended_behavior: 'x', move_files: [], move_ac_ids: ['AC2'] }],
          parent_what_it_does: 'x',
        }),
      /(?=.*child-no-files)(?=.*(?:at least one|must own|non-empty|own.*file))/is,
      'an empty-move_files child must be refused, naming the child slug and stating a child must own at least one file'
    );
    assert.equal(articleCount(tools), before, 'nothing written');
    assertParentUntouched(tools, parent);
    assertNoSlug(tools, 'child-no-files');
  } finally {
    cleanup();
  }
});
