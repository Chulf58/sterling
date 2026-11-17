// Board dd6d118a (found-2026-11-13-in-the-hook-roots-re-check-declaresforeignt):
// the server's declaresForeignTree must agree with the hooks' isForeignTree
// (scripts/hooks/lib/working-tree.mjs). In a linked worktree session, an article
// whose working_tree names the active checkout (directly, or through a name mapped
// in config.working_trees) owns the project's paths, so a knowledge_append with
// resolves joining a demanded path to it is admitted. A tree that is neither the
// project root nor the checkout stays foreign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

const NOW = '2026-06-10T12:00:00.000Z';

function fixture(mapName?: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-checkout-aware-')));
  const main = join(base, 'main');
  mkdirSync(join(main, '.sterling'), { recursive: true });
  writeFileSync(join(main, 'a.txt'), 'a\n');
  const wt = join(base, 'wt');
  mkdirSync(wt);
  const store = new SterlingStore(join(main, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({
    store,
    now: () => NOW,
    repoRoot: main,
    checkoutRoot: wt,
    config: parseConfig({ working_trees: mapName ? { [mapName]: wt } : {} }),
  });
  return { base, main, wt, tools, cleanup: () => (store.close(), rmSync(base, { recursive: true, force: true })) };
}

const mkArticle = (tools: SterlingTools, slug: string, workingTree: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: [{ path: 'src/thing.ts', role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    working_tree: workingTree,
  }).record;

type Appending = { knowledgeAppend(id: string, field: string, values: unknown[], resolves?: string[]): unknown };
const openIds = (tools: SterlingTools) => (tools.maintenanceQuery({ cap: 1000 }) as unknown as { id: string }[]).map((t) => t.id);

function attempt(f: ReturnType<typeof fixture>, workingTree: string) {
  const article = mkArticle(f.tools, 'wt-article', workingTree);
  const { record: item } = f.tools.maintenanceEnqueue({
    reason: 'article_missing',
    text: `'wt-article' does not yet own src/x.ts`,
    file_keys: ['src/x.ts'],
    feature_link: article.id,
  });
  const run = () => (f.tools as unknown as Appending).knowledgeAppend(article.id, 'files', [{ path: 'src/x.ts', role: 'impl' }], [item.id]);
  return { run, item };
}

test('an article whose working_tree names the active checkout admits a resolves append', () => {
  const f = fixture();
  try {
    const { run, item } = attempt(f, f.wt);
    run();
    assert.ok(!openIds(f.tools).includes(item.id), 'the item is discharged');
  } finally {
    f.cleanup();
  }
});

test('an article whose working_tree is a name mapped to the active checkout admits a resolves append', () => {
  const f = fixture('my-wt');
  try {
    const { run, item } = attempt(f, 'my-wt');
    run();
    assert.ok(!openIds(f.tools).includes(item.id), 'the item is discharged');
  } finally {
    f.cleanup();
  }
});

test('an article whose working_tree is neither the project root nor the checkout stays refused', () => {
  const f = fixture();
  try {
    const { run, item } = attempt(f, join(f.base, 'elsewhere'));
    assert.throws(run, /working_tree/);
    assert.ok(openIds(f.tools).includes(item.id), 'the item stays open');
  } finally {
    f.cleanup();
  }
});
