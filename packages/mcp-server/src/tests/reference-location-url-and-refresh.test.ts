// GitHub issues #14 and #13 on Chulf58/sterling.
//   #14: a reference_material location that is a URL was path-normalized on
//        write ('https://' collapsed to 'https:/'), and the knowledge_edit
//        receipt reported the submitted length, not the stored one.
//   #13: the read-time refresh_reference check called every kind:doc location
//        a local file, so URLs and prose read "no longer exists on disk".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';
import { SterlingTools } from '../tools.js';

type Loose = Record<string, unknown>;

const URL = 'https://example.com/docs/spec';
const COLLAPSED = 'https:/example.com/docs/spec';

function fixture(workingTrees?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ref-location-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({
    store,
    now: () => '2026-10-04T12:00:00.000Z',
    repoRoot: dir,
    ...(workingTrees ? { config: parseConfig({ working_trees: workingTrees }) } : {}),
  });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, cleanup };
}

const mkRef = (tools: SterlingTools, location: string, over: Loose = {}): Loose =>
  (
    tools.knowledgeCreate('reference_material', {
      title: `ref ${location}`,
      kind: 'doc',
      location,
      summary: 'a summary',
      source_date: '2026-09-06',
      capture_date: '2026-09-06',
      ...over,
    } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
  ).record;

const stored = (store: SterlingStore, id: unknown): Loose => store.get(String(id)) as unknown as Loose;

const readRefs = (tools: SterlingTools): Loose[] =>
  (tools.knowledgeQueryResult({ types: ['reference_material'] } as unknown as Parameters<SterlingTools['knowledgeQueryResult']>[0]) as unknown as { records: Loose[] })
    .records;

const refreshItems = (tools: SterlingTools): Loose[] => tools.maintenanceQuery({ system_reason: 'refresh_reference' }) as unknown as Loose[];

test('#14 create: a URL location is stored verbatim', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, URL);
    assert.equal(ref.location, URL);
    assert.equal(stored(store, ref.id).location, URL);
  } finally {
    cleanup();
  }
});

test('#14 update: a URL location is stored verbatim, with no normalization warning', () => {
  const { dir, store, tools, cleanup } = fixture();
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'a.md'), 'x');
    const ref = mkRef(tools, 'docs/a.md');
    const res = tools.knowledgeUpdateResult(String(ref.id), { location: URL });
    assert.equal(stored(store, ref.id).location, URL);
    assert.equal(res.warnings.filter((w) => /normalized/.test(w)).length, 0);
  } finally {
    cleanup();
  }
});

test('#14 edit: a collapsed URL is repaired by knowledge_edit and the receipt reports the stored length', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, COLLAPSED);
    assert.equal(stored(store, ref.id).location, COLLAPSED, 'the damaged value is kept as given, not re-normalized');
    const res = tools.knowledgeEdit(String(ref.id), 'location', 'https:/example.com', 'https://example.com');
    const after = String(stored(store, ref.id).location);
    assert.equal(after, URL);
    assert.equal(res.replaced.chars_before, COLLAPSED.length);
    assert.equal(res.replaced.chars_after, after.length);
  } finally {
    cleanup();
  }
});

test('#14 a path location is still normalized through create, update and edit', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, '.\\docs\\a.md');
    assert.equal(stored(store, ref.id).location, 'docs/a.md');
    tools.knowledgeUpdateResult(String(ref.id), { location: './docs//b.md' });
    assert.equal(stored(store, ref.id).location, 'docs/b.md');
    tools.knowledgeEdit(String(ref.id), 'location', 'docs/b.md', './docs//c.md');
    assert.equal(stored(store, ref.id).location, 'docs/c.md');
  } finally {
    cleanup();
  }
});

test('#14 edit receipt: chars_after is the STORED length and a normalizing write says so', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, 'docs/a.md');
    const res = tools.knowledgeEdit(String(ref.id), 'location', 'docs/a.md', './docs//b.md');
    const after = String(stored(store, ref.id).location);
    assert.equal(after, 'docs/b.md');
    assert.equal(res.replaced.chars_after, after.length, 'the receipt reports what knowledge_get returns, not what was submitted');
    assert.equal(res.warnings.filter((w) => /location/.test(w) && /normalized/.test(w)).length, 1);
  } finally {
    cleanup();
  }
});

test('#14 edit receipt: an un-normalized field reports its stored length and no normalization warning', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, URL);
    const res = tools.knowledgeEdit(String(ref.id), 'summary', 'a summary', 'a much longer summary');
    assert.equal(res.replaced.chars_after, String(stored(store, ref.id).summary).length);
    assert.equal(res.warnings.filter((w) => /normalized/.test(w)).length, 0);
  } finally {
    cleanup();
  }
});

test('#14 edit receipt: an array-element edit reports the stored element length', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const article = (
      tools.knowledgeCreate('feature_article', {
        slug: 'receipt-length-article',
        title: 'receipt-length-article',
        what_it_does: 'x',
        intended_behavior: 'x',
        files: [{ path: 'src/a.ts', role: 'impl' }],
        current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
        dependencies: { relies_on: [], relied_by: [] },
        state: 'active',
        history: [{ date: '2026-06-01T00:00:00.000Z', event: 'originating brief' }],
        live_test_refs: [],
      } as unknown as Parameters<SterlingTools['knowledgeCreate']>[1]) as unknown as { record: Loose }
    ).record;
    const res = tools.knowledgeEdit(String(article.id), 'files[path=src/a.ts].path', 'src/a.ts', './src//b.ts');
    const files = stored(store, article.id).files as { path: string }[];
    assert.equal(files[0].path, 'src/b.ts');
    assert.equal(res.replaced.chars_after, files[0].path.length);
    assert.equal(res.warnings.filter((w) => /normalized/.test(w)).length, 1);
  } finally {
    cleanup();
  }
});

test('#14 update receipt: a write whose value is changed by normalization says so', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, 'docs/a.md');
    const res = tools.knowledgeUpdateResult(String(ref.id), { location: './docs//b.md' });
    const hits = res.warnings.filter((w) => /location/.test(w) && /normalized/.test(w));
    assert.equal(hits.length, 1);
    assert.match(hits[0], /12/);
    assert.match(hits[0], /9/);
  } finally {
    cleanup();
  }
});

test('#13 a URL location mints no refresh_reference item and is not flagged', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, URL);
    const damaged = mkRef(tools, COLLAPSED);
    const read = readRefs(tools);
    assert.equal(read.find((r) => r.id === ref.id)?.verify_before_use, undefined);
    assert.equal(read.find((r) => r.id === damaged.id)?.verify_before_use, undefined);
    assert.equal(refreshItems(tools).length, 0);
  } finally {
    cleanup();
  }
});

test('#13 a prose location mints no refresh_reference item and is not flagged', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, 'the vendor portal, section 3');
    assert.equal(readRefs(tools).find((r) => r.id === ref.id)?.verify_before_use, undefined);
    assert.equal(refreshItems(tools).length, 0);
  } finally {
    cleanup();
  }
});

test('#13 a path is resolved against the record working_tree: present only in the sibling tree mints nothing', () => {
  const sibling = mkdtempSync(join(tmpdir(), 'sterling-ref-sibling-'));
  const { tools, cleanup } = fixture({ sib: sibling });
  try {
    mkdirSync(join(sibling, 'docs'), { recursive: true });
    writeFileSync(join(sibling, 'docs', 'spec.md'), 'x');
    const ref = mkRef(tools, 'docs/spec.md', { working_tree: 'sib' });
    assert.equal(readRefs(tools).find((r) => r.id === ref.id)?.verify_before_use, undefined);
    assert.equal(refreshItems(tools).length, 0);
  } finally {
    cleanup();
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('#13 a path missing from its working_tree mints the item even when the project root holds a same-named file', () => {
  const sibling = mkdtempSync(join(tmpdir(), 'sterling-ref-sibling-'));
  const { dir, tools, cleanup } = fixture({ sib: sibling });
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'spec.md'), 'x');
    const ref = mkRef(tools, 'docs/spec.md', { working_tree: 'sib' });
    assert.equal(readRefs(tools).find((r) => r.id === ref.id)?.verify_before_use, true);
    const items = refreshItems(tools);
    assert.equal(items.length, 1);
    assert.equal(items[0].feature_link, ref.id);
  } finally {
    cleanup();
    rmSync(sibling, { recursive: true, force: true });
  }
});

// Review round.

test('#13 a repo path containing whitespace is still drift-checked: present mints nothing, missing mints', () => {
  const { dir, store, tools, cleanup } = fixture();
  try {
    mkdirSync(join(dir, 'docs', 'Design Notes'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'Design Notes', 'spec.md'), 'x');
    const ref = mkRef(tools, './docs/Design Notes/spec.md');
    assert.equal(stored(store, ref.id).location, 'docs/Design Notes/spec.md');
    assert.deepEqual(Object.keys((stored(store, ref.id).file_baselines ?? {}) as Loose), ['docs/Design Notes/spec.md']);
    readRefs(tools);
    assert.equal(refreshItems(tools).length, 0);
    rmSync(join(dir, 'docs', 'Design Notes', 'spec.md'));
    readRefs(tools);
    assert.deepEqual(
      refreshItems(tools).map((i) => i.file_keys),
      [['docs/Design Notes/spec.md']]
    );
  } finally {
    cleanup();
  }
});

test('#13 a slash-less scheme location (mailto:, urn:, jira:) is stored verbatim and mints nothing', () => {
  const { store, tools, cleanup } = fixture();
  try {
    for (const location of ['mailto:a@b.com', 'urn:isbn:1', 'jira:ABC-12', 'arxiv:2401.1', 's3:/bucket/key', 'file:/tmp/x']) {
      const ref = mkRef(tools, location);
      assert.equal(stored(store, ref.id).location, location);
      assert.equal(readRefs(tools).find((r) => r.id === ref.id)?.verify_before_use, undefined, location);
    }
    assert.equal(refreshItems(tools).length, 0);
  } finally {
    cleanup();
  }
});

// No read-time close exists for a maintenance item, by decision (auto-closure
// and auto-drain are rejected; an item closes only when a write names it in
// `resolves` or through maintenance_remove). So an already-open false item on a
// record whose location is not a file stays open on a read, and the write
// receipt names its full id and how to close it.
const enqueueFalseItem = (tools: SterlingTools, ref: Loose, key: string): string =>
  String(
    (
      tools.maintenanceEnqueue({
        reason: 'refresh_reference',
        text: `refresh reference '${String(ref.title)}' — ${key} no longer exists on disk; repoint location`,
        file_keys: [key],
        feature_link: String(ref.id),
      }).record as unknown as Loose
    ).id
  );

test('#13 a pre-existing false item on a URL record: a read leaves it open, a write names its full id and resolves', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, URL);
    const itemId = enqueueFalseItem(tools, ref, COLLAPSED);
    readRefs(tools);
    assert.deepEqual(
      refreshItems(tools).map((i) => i.id),
      [itemId],
      'a read closes nothing'
    );
    const res = tools.knowledgeEdit(String(ref.id), 'summary', 'a summary', 'another summary');
    const hits = res.warnings.filter((w) => /not a file/.test(w));
    assert.equal(hits.length, 1);
    assert.ok(hits[0].includes(itemId), 'the warning carries the full item id');
    assert.match(hits[0], /resolves/);
    const viaUpdate = tools.knowledgeUpdateResult(String(ref.id), { summary: 'a third summary' });
    assert.equal(viaUpdate.warnings.filter((w) => /not a file/.test(w) && w.includes(itemId)).length, 1);
    assert.equal(refreshItems(tools).length, 1, 'a write that does not name the item leaves it open');
  } finally {
    cleanup();
  }
});

test('#13 the repairing knowledge_edit closes the pre-existing false item when it passes it in resolves', () => {
  const { store, tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, COLLAPSED);
    const itemId = enqueueFalseItem(tools, ref, COLLAPSED);
    const res = tools.knowledgeEdit(String(ref.id), 'location', 'https:/example.com', 'https://example.com', [itemId]);
    assert.equal(stored(store, ref.id).location, URL);
    assert.equal(refreshItems(tools).length, 0);
    assert.equal(res.warnings.filter((w) => /not a file/.test(w)).length, 0);
  } finally {
    cleanup();
  }
});

test('#13 a prose record with a pre-existing false item gets the same warning; a path record does not', () => {
  const { tools, cleanup } = fixture();
  try {
    const prose = mkRef(tools, 'the vendor portal, section 3');
    const itemId = enqueueFalseItem(tools, prose, 'the vendor portal, section 3');
    const res = tools.knowledgeEdit(String(prose.id), 'summary', 'a summary', 'another summary');
    assert.equal(res.warnings.filter((w) => /not a file/.test(w) && w.includes(itemId)).length, 1);
    const path = mkRef(tools, 'docs/gone.md');
    readRefs(tools);
    assert.equal(refreshItems(tools).filter((i) => i.feature_link === path.id).length, 1);
    const onPath = tools.knowledgeEdit(String(path.id), 'summary', 'a summary', 'another summary');
    assert.equal(onPath.warnings.filter((w) => /not a file/.test(w)).length, 0);
  } finally {
    cleanup();
  }
});

test('#13 a genuinely missing local file still mints ONE refresh_reference item', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, 'docs/gone.md');
    assert.equal(readRefs(tools).find((r) => r.id === ref.id)?.verify_before_use, true);
    readRefs(tools);
    const items = refreshItems(tools);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].file_keys, ['docs/gone.md']);
    assert.match(String(items[0].text), /no longer exists on disk/);
  } finally {
    cleanup();
  }
});

// GitHub issue #57: Sterling seeds the 'Models catalog' reference with the
// location '.sterling/models-catalog', a name for a catalog the record holds in
// its own `catalog` field. Nothing writes a file there, so the read-time check
// minted a false "no longer exists on disk" item.
test('#57 the seeded Models catalog mints no refresh_reference item, while a genuinely missing file still does', () => {
  const { store, tools, cleanup } = fixture();
  try {
    store.bootstrapCatalogIfAbsent({ models: { reviewer: { model: 'claude-opus-4-8' } } }, '2026-09-06T00:00:00.000Z');
    const seeded = readRefs(tools).find((r) => r.title === 'Models catalog');
    assert.ok(seeded, 'the catalog was seeded');
    assert.equal(seeded.location, '.sterling/models-catalog');
    const gone = mkRef(tools, 'docs/gone.md');
    readRefs(tools);
    readRefs(tools);
    const items = refreshItems(tools);
    assert.deepEqual(
      items.map((i) => i.feature_link),
      [gone.id],
      'only the genuinely missing file mints; the seeded catalog does not'
    );
    assert.equal(readRefs(tools).find((r) => r.title === 'Models catalog')?.verify_before_use, undefined);
  } finally {
    cleanup();
  }
});

test('#57 boundary: a reference with a catalog whose location is a missing repo file still mints', () => {
  const { tools, cleanup } = fixture();
  try {
    const ref = mkRef(tools, 'docs/gone-catalog.md', { catalog: { entries: [{ id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' }] } });
    assert.ok(ref.catalog, 'the record carries a catalog');
    readRefs(tools);
    const items = refreshItems(tools);
    assert.deepEqual(items.map((i) => i.feature_link), [ref.id]);
    assert.deepEqual(items[0].file_keys, ['docs/gone-catalog.md']);
  } finally {
    cleanup();
  }
});
