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
import { ownershipJoin, foreignTreeOwnersText } from '../hooks/lib/session-duties.mjs';

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

// config.working_trees (GitHub issues #112, #115): a name mapped to the root —
// absolute, or relative joined onto the root as the MCP server's treeRootFor
// does — owns root paths at every hook site; an unmapped name, or one mapped to
// another tree, stays foreign.
test('isForeignTree: a working_tree name mapped in config.working_trees resolves through the map first', () => {
  const ROOT = '/home/u/proj';
  const trees = { main: ROOT, here: '.', winRoot: 'C:/Users/u/proj', copy: '/home/u/proj-copy', sub: 'sub' };
  assert.equal(isForeignTree({ working_tree: 'main' }, ROOT, trees), false, 'mapped to the absolute root');
  assert.equal(isForeignTree({ working_tree: 'here' }, ROOT, trees), false, 'mapped relative, joined onto the root');
  assert.equal(isForeignTree({ working_tree: 'copy' }, ROOT, trees), true, 'mapped to another tree');
  assert.equal(isForeignTree({ working_tree: 'sub' }, ROOT, trees), true, 'relative mapping below the root is another tree');
  assert.equal(isForeignTree({ working_tree: 'winRoot' }, '/mnt/c/Users/u/proj', trees), false, 'mapped Windows spelling of a WSL root');
  assert.equal(isForeignTree({ working_tree: 'unmapped' }, ROOT, trees), true, 'an unmapped name stays foreign');
  assert.equal(isForeignTree({ working_tree: 'main' }, ROOT), true, 'no map passed: the name is compared as itself, as before');
});

function withWorkingTrees(dir, working_trees) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ working_trees }));
}

test('settlement: a drifted path owned by an article whose working_tree name is MAPPED to the root mints its reconcile item', async () => {
  const { dir, store, cleanup } = await project();
  try {
    withWorkingTrees(dir, { main: '.' });
    const a = drifted(store, dir, 'mapped-root', 'src/m.mjs', 'main');
    mintSettlementReconcile(store, dir, ['src/m.mjs'], NOW);
    const items = reconcileItems(store);
    assert.equal(items.length, 1);
    assert.equal(items[0].feature_link, a.id);
  } finally {
    cleanup();
  }
});

test('settlement: an UNMAPPED working_tree name still mints nothing when config.working_trees maps other names', async () => {
  const { dir, store, cleanup } = await project();
  try {
    withWorkingTrees(dir, { main: '.' });
    drifted(store, dir, 'unmapped', 'src/u.mjs', 'main (merged 035f27c, 2026-10-15)');
    mintSettlementReconcile(store, dir, ['src/u.mjs'], NOW);
    assert.equal(reconcileItems(store).length, 0);
  } finally {
    cleanup();
  }
});

test('ownershipJoin: a mapped-to-root owner owns; a foreign-only owner is unowned and is named by foreignTreeOwnersText', async () => {
  const { dir, store, cleanup } = await project();
  try {
    withWorkingTrees(dir, { main: dir });
    drifted(store, dir, 'mapped-owner', 'src/m.mjs', 'main');
    const stale = drifted(store, dir, 'stale-owner', 'src/s.mjs', 'main (merged 035f27c, 2026-10-15)');
    const { isUnowned, foreignOnlyOwners } = ownershipJoin(store, dir);
    assert.equal(isUnowned('src/m.mjs'), false, 'config.working_trees is read from the root when not passed');
    assert.equal(isUnowned('src/s.mjs'), true);
    assert.deepEqual(foreignOnlyOwners('src/m.mjs'), []);
    const text = foreignTreeOwnersText(['src/s.mjs', 'src/none.mjs'], foreignOnlyOwners);
    assert.match(text, /^1 of these file\(s\) are listed only by an article on another working tree/);
    assert.ok(text.includes(`'stale-owner' (${stale.id.slice(0, 8)}, working_tree 'main (merged 035f27c, 2026-10-15)') lists src/s.mjs`), text);
    assert.match(text, /clear working_tree on the article \(knowledge_update with working_tree: null\).*map the name in config\.working_trees/);
    assert.equal(foreignTreeOwnersText(['src/none.mjs'], foreignOnlyOwners), '', 'nothing lists the path: no line');
  } finally {
    cleanup();
  }
});

// The MCP server's treeRootFor treats a falsy mapping as no mapping (`if
// (!mapped)`), so an empty value never resolves to the root: the name is
// compared as itself. The hook side follows the same rule, and a non-string
// value (a raw, unparsed config) is treated the same way.
test('isForeignTree: an empty, whitespace-only or non-string mapping never grants root ownership', () => {
  const ROOT = '/home/u/proj';
  const trees = { empty: '', blank: '   ', num: 0, obj: {}, nul: null, [ROOT]: '' };
  for (const name of ['empty', 'blank', 'num', 'obj', 'nul']) {
    assert.equal(isForeignTree({ working_tree: name }, ROOT, trees), true, name);
  }
  assert.equal(isForeignTree({ working_tree: ROOT }, ROOT, trees), false, 'an empty mapping falls back to the name itself, which here is the root (as treeRootFor does)');
});
