// fs-move gets the fs-remove safety fixes (GitHub issue #331): the store comes from the
// main checkout when --target is a linked worktree, every path is containment-checked,
// the reconcile todo carries checkout observations, and GIT_* location variables refuse.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
  return r.stdout.trim();
}

function article(slug, path) {
  return {
    id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug, title: slug, what_it_does: 'x', intended_behavior: 'x',
    files: [{ path, role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
    history: [{ date: NOW, event: 'originating brief' }], live_test_refs: [],
  };
}

function fixture(prefix) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const dir = join(base, 'repo');
  mkdirSync(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'old.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'src', 'other.mjs'), 'export const y = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nlinked\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { base, dir, wt: join(base, 'wt'), store };
}

const run = (args, cwd, env = process.env) => spawnSync(process.execPath, [join(root, 'scripts', 'fs-move.mjs'), ...args], { encoding: 'utf8', cwd, timeout: 60_000, env });

test('fs-move --target <linked worktree without .sterling>: moves under the worktree, rewrites the main store, todo carries observations', () => {
  const { base, dir, wt, store } = fixture('sterling-fsmv-wt-');
  try {
    const owner = store.create(article('feat-mv', 'src/old.mjs'));
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);
    assert.equal(existsSync(join(wt, '.sterling')), false, 'fixture: the worktree has no .sterling');

    const r = run(['src/old.mjs', 'deep/new.mjs', '--target', wt], wt);
    assert.equal(r.status, 0, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.equal(existsSync(join(wt, 'deep', 'new.mjs')), true);
    assert.equal(existsSync(join(wt, 'src', 'old.mjs')), false);
    assert.equal(existsSync(join(dir, 'src', 'old.mjs')), true, 'the main checkout copy is untouched');
    assert.equal(existsSync(join(wt, '.sterling')), false, 'nothing is written under the worktree');

    const items = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed' && t.feature_link === owner.id);
    assert.equal(items.length, 1, 'the owner gets its reconcile item in the main store');
    const obs = Object.fromEntries(items[0].observations.map((o) => [o.path, o]));
    assert.deepEqual(Object.keys(obs).sort(), ['deep/new.mjs', 'src/old.mjs']);
    assert.deepEqual(obs['src/old.mjs'].state, { kind: 'absent' });
    assert.equal(obs['deep/new.mjs'].state.kind, 'file');
    assert.equal(obs['src/old.mjs'].commit, git(wt, ['rev-parse', 'HEAD']));
    assert.equal(obs['src/old.mjs'].checkout.kind, 'checkout');
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-move: a destination under a symlinked directory is refused; nothing moved, no records changed', () => {
  const { base, dir, wt, store } = fixture('sterling-fsmv-sym-');
  try {
    store.create(article('feat-sym', 'src/old.mjs'));
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);
    symlinkSync(join(dir, 'src'), join(wt, 'linked'));

    const r = run(['src/old.mjs', 'linked/new.mjs', '--target', wt], wt);
    assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /symlink/);
    assert.equal(existsSync(join(wt, 'src', 'old.mjs')), true, 'source not moved');
    assert.equal(existsSync(join(dir, 'src', 'new.mjs')), false, 'nothing landed through the link');
    assert.equal(store.query({ types: ['feature_article'], file_keys: ['src/old.mjs'], cap: 10 }).length, 1, 'file_keys not rewritten');

    const r2 = run(['linked/other.mjs', 'src/moved.mjs', '--target', wt], wt);
    assert.equal(r2.status, 2, `stdout=${oneLine(r2.stdout)} stderr=${oneLine(r2.stderr)}`);
    assert.match(r2.stderr, /symlink/);
    assert.equal(existsSync(join(dir, 'src', 'other.mjs')), true, 'source behind a symlinked parent survives');
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-move: inherited GIT_DIR or GIT_CEILING_DIRECTORIES refuses; file untouched, no store writes', () => {
  const { base, dir, store } = fixture('sterling-fsmv-env-');
  try {
    store.create(article('feat-env', 'src/old.mjs'));
    for (const [k, v] of [['GIT_DIR', '.git'], ['GIT_CEILING_DIRECTORIES', dir]]) {
      const r = run(['src/old.mjs', 'src/new.mjs', '--target', dir], dir, { ...process.env, [k]: v });
      assert.equal(r.status, 2, `${k}: stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
      assert.match(r.stderr, new RegExp(k));
      assert.equal(existsSync(join(dir, 'src', 'old.mjs')), true, `${k}: file untouched`);
    }
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 0, 'no store writes');
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-move: a --target below the checkout root is refused', () => {
  const { base, dir, store } = fixture('sterling-fsmv-sub-');
  try {
    const r = run(['old.mjs', 'new.mjs', '--target', join(dir, 'src')], join(dir, 'src'));
    assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /inside the checkout/);
    assert.equal(existsSync(join(dir, 'src', 'old.mjs')), true);
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
