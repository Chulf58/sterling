// The shared hooks-side ownership predicate isForeignTree (Dome Farmer issue
// entry 454; user ruling 2026-09-28 "Code: self-root = own"): a working_tree
// that resolves to THIS project's own root names the project itself, so every
// hook site (H10, H19, H23, delivery pointers, settlement) treats that record as
// a root owner. A foreign tree — a branch name, another absolute path — does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isForeignTree } from '../hooks/lib/working-tree.mjs';
import { mintSettlementReconcile } from '../hooks/lib/settlement.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-09-28T12:00:00.000Z';

test('isForeignTree: no working_tree and the project root in any host spelling are NOT foreign; anything else is', () => {
  const ROOT = '/mnt/c/Users/chulf/Dome Farmer';
  assert.equal(isForeignTree({}, ROOT), false);
  for (const wt of ['C:/Users/chulf/Dome Farmer', 'C:\\Users\\chulf\\Dome Farmer\\', 'c:/users/chulf/dome farmer', ROOT, `${ROOT}/`]) {
    assert.equal(isForeignTree({ working_tree: wt }, ROOT), false, wt);
  }
  for (const wt of ['chore/retire-knowledge-skills', 'juiced', 'C:/Users/chulf/Comsoft', `${ROOT}/sub`]) {
    assert.equal(isForeignTree({ working_tree: wt }, ROOT), true, wt);
  }
  assert.equal(isForeignTree({ working_tree: ROOT }, undefined), true, 'no root to compare against: fail toward foreign, as before');
});

async function project() {
  const { SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'sterling-self-root-settle-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
  mkdirSync(join(dir, 'src'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function drifted(store, dir, slug, path, working_tree) {
  const original = `// ${slug} v1\n`;
  const rec = store.create({
    id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug, title: slug, what_it_does: 'x', intended_behavior: 'x', working_tree,
    files: [{ path, role: 'impl' }],
    file_baselines: { [path]: createHash('sha256').update(original, 'utf8').digest('hex') },
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
    history: [{ date: NOW, event: 'seed' }], live_test_refs: [],
  });
  writeFileSync(join(dir, path), `// ${slug} v2\n`);
  return rec;
}

const reconcileItems = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed');

test('settlement: a drifted path owned by a SELF-ROOTED article mints its reconcile item', async () => {
  const { dir, store, cleanup } = await project();
  try {
    const a = drifted(store, dir, 'self-rooted', 'src/a.mjs', `${dir}/`);
    mintSettlementReconcile(store, dir, ['src/a.mjs'], NOW);
    const items = reconcileItems(store);
    assert.equal(items.length, 1);
    assert.equal(items[0].feature_link, a.id);
  } finally {
    cleanup();
  }
});

test('settlement: a drifted path owned only by a FOREIGN branch-name tree article mints nothing (unchanged)', async () => {
  const { dir, store, cleanup } = await project();
  try {
    drifted(store, dir, 'foreign', 'src/f.mjs', 'chore/retire-knowledge-skills');
    mintSettlementReconcile(store, dir, ['src/f.mjs'], NOW);
    assert.equal(reconcileItems(store).length, 0);
  } finally {
    cleanup();
  }
});
