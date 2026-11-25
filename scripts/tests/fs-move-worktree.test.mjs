// fs-move gets the fs-remove safety fixes (GitHub issue #331): the store comes from the
// main checkout when --target is a linked worktree, every path is containment-checked,
// the reconcile todo carries checkout observations, and GIT_* location variables refuse.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { article } from './lib-article-fixture.mjs';
import { itemProvenance } from '../hooks/lib/reconcile-origins.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-move: a source under a symlinked directory is refused; the file behind the link survives', () => {
  const { base, dir, wt, store } = fixture('sterling-fsmv-srcsym-');
  try {
    store.create(article('feat-srcsym', 'linked/other.mjs'));
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);
    symlinkSync(join(dir, 'src'), join(wt, 'linked'));

    const r = run(['linked/other.mjs', 'src/moved.mjs', '--target', wt], wt);
    assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /symlink/);
    assert.equal(existsSync(join(dir, 'src', 'other.mjs')), true, 'source behind a symlinked parent survives');
    assert.equal(existsSync(join(wt, 'src', 'moved.mjs')), false);
    assert.equal(store.query({ types: ['feature_article'], file_keys: ['linked/other.mjs'], cap: 10 }).length, 1, 'the owner key is still linked/other.mjs');
    assert.equal(store.query({ types: ['feature_article'], file_keys: ['src/moved.mjs'], cap: 10 }).length, 0, 'the key was not rewritten to the destination');
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

const reconcileTodos = (store, owner) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'reconcile_needed' && t.feature_link === owner.id);

test('fs-move: moving a file whose path equals an observation state kind ("file") keeps the evidence intact and the second move succeeds', () => {
  const { base, dir, wt, store } = fixture('sterling-fsmv-kind-');
  try {
    writeFileSync(join(dir, 'file'), 'plain\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'add file']);
    const owner = store.create(article('feat-kind', 'src/old.mjs'));
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);

    for (const [a, b] of [['src/old.mjs', 'file2'], ['file2', 'file'], ['file', 'new.mjs']]) {
      if (b === 'file') rmSync(join(wt, 'file'));
      const r = run([a, b, '--target', wt], wt);
      assert.equal(r.status, 0, `${a} -> ${b}: stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    }
    assert.equal(store.query({ types: ['feature_article'], file_keys: ['new.mjs'], cap: 10 }).length, 1, 'owner followed every move');
    const [item] = reconcileTodos(store, owner);
    for (const o of item.observations) assert.ok(['file', 'absent', 'unknown'].includes(o.state.kind), `state.kind intact: ${o.state.kind}`);
    assert.ok(item.observations.some((o) => o.path === 'src/old.mjs' && o.state.kind === 'absent'), 'historical observation path never rewritten');
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-move: a round trip old -> new -> old keeps both moves as evidence; itemProvenance holds it for the conductor, never pays it from a stale half', () => {
  const { base, dir, wt, store } = fixture('sterling-fsmv-trip-');
  try {
    const owner = store.create(article('feat-trip', 'src/old.mjs'));
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);
    for (const [a, b] of [['src/old.mjs', 'src/new.mjs'], ['src/new.mjs', 'src/old.mjs']]) {
      const r = run([a, b, '--target', wt], wt);
      assert.equal(r.status, 0, `${a} -> ${b}: stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    }
    const [item] = reconcileTodos(store, owner);
    const pairs = item.observations.map((o) => `${o.path}:${o.state.kind}`).sort();
    assert.deepEqual(pairs, ['src/new.mjs:absent', 'src/new.mjs:file', 'src/old.mjs:absent', 'src/old.mjs:file'], 'both moves kept both paths, each in both states; none was rewritten');
    const head = git(dir, ['rev-parse', 'HEAD']);
    const p = itemProvenance(item, dir, head);
    // Evidence is stored without order, so two states of one path at one commit cannot be
    // sequenced: the item is the conductor's rather than paid from the wrong half.
    assert.equal(p.payable, false);
    assert.equal(p.conductor, true);
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
