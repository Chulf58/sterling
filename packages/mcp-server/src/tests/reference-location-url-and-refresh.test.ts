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
