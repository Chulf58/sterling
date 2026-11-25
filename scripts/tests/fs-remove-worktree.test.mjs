// fs-remove FROM A LINKED GIT WORKTREE (GitHub issue #331). .sterling/ is
// gitignored, so a linked worktree never has it; --target <worktree> used to die
// in openProject. The store now comes from the MAIN checkout (resolveStoreRoot)
// while the file is deleted under the worktree.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { article } from './lib-article-fixture.mjs';
import { itemProvenance } from '../hooks/lib/reconcile-origins.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
}

test('fs-remove --target <linked worktree without .sterling>: removes the file under the worktree and registers the reconcile item in the main checkout store', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-fsrm-wt-')));
  const dir = join(base, 'repo');
  const wt = join(base, 'wt');
  try {
    mkdirSync(dir);
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@sterling.local']);
    git(dir, ['config', 'user.name', 'Sterling Test']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'gone.mjs'), 'export const x = 1;\n');
    writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const owner = store.create(article('feat-wt', 'src/gone.mjs'));
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);
    assert.equal(existsSync(join(wt, '.sterling')), false, 'fixture: the worktree has no .sterling');

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'fs-remove.mjs'), 'src/gone.mjs', '--target', wt], { encoding: 'utf8', cwd: wt, timeout: 60_000 });
    assert.equal(r.status, 0, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.deepEqual(JSON.parse(r.stdout).removed, ['src/gone.mjs']);
    assert.equal(existsSync(join(wt, 'src', 'gone.mjs')), false, 'the file is gone from the worktree');
    assert.equal(existsSync(join(dir, 'src', 'gone.mjs')), true, 'the main checkout copy is untouched');
    assert.equal(existsSync(join(wt, '.sterling')), false, 'nothing is written under the worktree');
    const reconcile = store.query({ types: ['todo'], cap: 100 })
      .filter((t) => t.system_reason === 'reconcile_needed' && t.feature_link === owner.id);
    assert.equal(reconcile.length, 1, 'the owner gets its reconcile item in the main store');

    // Checkout evidence: the absence observed in the worktree, bound to its HEAD.
    const [item] = reconcile;
    const wtHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).stdout.trim();
    assert.equal(item.observations.length, 1);
    assert.equal(item.observations[0].path, 'src/gone.mjs');
    assert.equal(item.observations[0].commit, wtHead);
    assert.deepEqual(item.observations[0].state, { kind: 'absent' });
    assert.equal(item.observations[0].checkout.kind, 'checkout');
    // Not payable while main still holds the file: held, never silently paid.
    const mainHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const before = itemProvenance(item, dir, mainHead);
    assert.equal(before.payable, false, 'main still has the file');
    assert.ok(before.holds.every((h) => !/no checkout evidence/.test(h.why)), 'held for the deletion, not for missing evidence');
    // Payable once main's committed tree also lacks the file.
    git(dir, ['rm', '-q', 'src/gone.mjs']);
    git(dir, ['commit', '-q', '-m', 'remove gone']);
    const newHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    assert.equal(itemProvenance(item, dir, newHead).payable, true, 'payable once main lacks the file');
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-remove: a path under a symlinked directory refuses the whole batch; both checkouts stay untouched', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-fsrm-sym-')));
  const dir = join(base, 'repo');
  const wt = join(base, 'wt');
  try {
    mkdirSync(dir);
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@sterling.local']);
    git(dir, ['config', 'user.name', 'Sterling Test']);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'keep.mjs'), 'export const k = 1;\n');
    writeFileSync(join(dir, 'src', 'plain.mjs'), 'export const p = 1;\n');
    writeFileSync(join(dir, '.gitignore'), '.sterling/\nlinked\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
    new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);
    symlinkSync(join(dir, 'src'), join(wt, 'linked'));

    const r = spawnSync(process.execPath, [join(root, 'scripts', 'fs-remove.mjs'), 'src/plain.mjs', 'linked/keep.mjs', '--target', wt], { encoding: 'utf8', cwd: wt, timeout: 60_000 });
    assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /symlink/);
    assert.equal(existsSync(join(dir, 'src', 'keep.mjs')), true, 'the main checkout file survives');
    assert.equal(existsSync(join(wt, 'src', 'plain.mjs')), true, 'the valid path in the batch is not removed either');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-remove: a --target below the checkout root is refused; nothing is deleted or recorded', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-fsrm-sub-')));
  const dir = join(base, 'repo');
  const wt = join(base, 'wt');
  try {
    mkdirSync(dir);
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@sterling.local']);
    git(dir, ['config', 'user.name', 'Sterling Test']);
    mkdirSync(join(dir, 'pkg'));
    writeFileSync(join(dir, 'package.json'), '{}\n');
    writeFileSync(join(dir, 'pkg', 'package.json'), '{}\n');
    writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    store.create(article('feat-root-pkg', 'package.json'));
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);
    for (const sub of [join(dir, 'pkg'), join(wt, 'pkg')]) {
      const r = spawnSync(process.execPath, [join(root, 'scripts', 'fs-remove.mjs'), 'package.json', '--target', sub], { encoding: 'utf8', cwd: sub, timeout: 60_000 });
      assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
      assert.match(r.stderr, /inside the checkout/);
    }
    assert.equal(existsSync(join(dir, 'pkg', 'package.json')), true);
    assert.equal(existsSync(join(wt, 'pkg', 'package.json')), true);
    assert.equal(store.query({ types: ['todo'], cap: 100 }).length, 0, 'nothing recorded');
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-remove: a nested initialized project subdirectory and a marker-only subdirectory are both refused', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-fsrm-nest-')));
  const dir = join(base, 'repo');
  const wt = join(base, 'wt');
  try {
    mkdirSync(dir);
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@sterling.local']);
    git(dir, ['config', 'user.name', 'Sterling Test']);
    for (const d of ['marker', 'nested']) {
      mkdirSync(join(dir, d));
      writeFileSync(join(dir, d, 'package.json'), '{}\n');
    }
    writeFileSync(join(dir, 'package.json'), '{}\n');
    writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'config.json'), '{}');
    const parent = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    parent.create(article('feat-parent-pkg', 'package.json'));
    mkdirSync(join(dir, 'marker', '.sterling'));
    mkdirSync(join(dir, 'nested', '.sterling'));
    writeFileSync(join(dir, 'nested', '.sterling', 'config.json'), '{}');
    const nested = new SterlingStore(join(dir, 'nested', '.sterling', 'sterling.db'));
    nested.create(article('feat-nested-pkg', 'package.json'));
    git(dir, ['worktree', 'add', '-b', 'feat/x', wt]);
    mkdirSync(join(wt, 'marker', '.sterling'), { recursive: true });
    const run = (target) => spawnSync(process.execPath, [join(root, 'scripts', 'fs-remove.mjs'), 'package.json', '--target', target], { encoding: 'utf8', cwd: target, timeout: 60_000 });

    for (const target of [join(dir, 'marker'), join(wt, 'marker')]) {
      const r = run(target);
      assert.equal(r.status, 2, `${target}: stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
      assert.match(r.stderr, /inside the checkout/);
      assert.equal(existsSync(join(target, 'package.json')), true, 'nothing deleted');
    }
    assert.equal(existsSync(join(wt, 'package.json')), true);
    assert.equal(parent.query({ types: ['todo'], cap: 100 }).length, 0, 'nothing recorded in the parent store');

    const r = run(join(dir, 'nested'));
    assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /inside the checkout/);
    assert.equal(existsSync(join(dir, 'nested', 'package.json')), true, 'the nested file is not deleted');
    assert.equal(nested.query({ types: ['todo'], cap: 100 }).length, 0, 'nothing recorded in the nested store');
    assert.equal(parent.query({ types: ['todo'], cap: 100 }).length, 0, 'the parent store is untouched');
    parent.close();
    nested.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-remove: git discovery failure on an initialized subdirectory refuses; a real non-git directory is still accepted', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-fsrm-nogit-')));
  const dir = join(base, 'repo');
  const plain = join(base, 'plain');
  try {
    mkdirSync(dir);
    git(dir, ['init', '-b', 'main']);
    mkdirSync(join(dir, 'sub', '.sterling'), { recursive: true });
    writeFileSync(join(dir, 'sub', '.sterling', 'config.json'), '{}');
    const sub = new SterlingStore(join(dir, 'sub', '.sterling', 'sterling.db'));
    sub.create(article('feat-sub', 'a.txt'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'a\n');
    const bin = join(base, 'emptybin');
    mkdirSync(bin);
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'fs-remove.mjs'), 'a.txt', '--target', join(dir, 'sub')], { encoding: 'utf8', cwd: base, timeout: 60_000, env: { ...process.env, PATH: bin } });
    assert.equal(r.status, 2, `stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /cannot establish the git checkout root/);
    assert.equal(existsSync(join(dir, 'sub', 'a.txt')), true, 'file untouched');
    assert.equal(sub.query({ types: ['todo'], cap: 100 }).length, 0, 'no store writes');
    sub.close();

    mkdirSync(join(plain, '.sterling'), { recursive: true });
    writeFileSync(join(plain, '.sterling', 'config.json'), '{}');
    new SterlingStore(join(plain, '.sterling', 'sterling.db')).close();
    writeFileSync(join(plain, 'b.txt'), 'b\n');
    const ok = spawnSync(process.execPath, [join(root, 'scripts', 'fs-remove.mjs'), 'b.txt', '--target', plain], { encoding: 'utf8', cwd: plain, timeout: 60_000 });
    assert.equal(ok.status, 0, `stdout=${oneLine(ok.stdout)} stderr=${oneLine(ok.stderr)}`);
    assert.equal(existsSync(join(plain, 'b.txt')), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fs-remove: inherited GIT_DIR or GIT_CEILING_DIRECTORIES on an initialized subdirectory refuses; file untouched, no store writes', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-fsrm-env-')));
  const dir = join(base, 'repo');
  try {
    mkdirSync(dir);
    git(dir, ['init', '-b', 'main']);
    mkdirSync(join(dir, 'sub', '.sterling'), { recursive: true });
    writeFileSync(join(dir, 'sub', '.sterling', 'config.json'), '{}');
    const sub = new SterlingStore(join(dir, 'sub', '.sterling', 'sterling.db'));
    sub.create(article('feat-env', 'a.txt'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'a\n');
    const target = join(dir, 'sub');
    for (const [k, v] of [['GIT_DIR', '.git'], ['GIT_CEILING_DIRECTORIES', dir]]) {
      const r = spawnSync(process.execPath, [join(root, 'scripts', 'fs-remove.mjs'), 'a.txt', '--target', target], { encoding: 'utf8', cwd: target, timeout: 60_000, env: { ...process.env, [k]: v } });
      assert.equal(r.status, 2, `${k}: stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
      assert.match(r.stderr, new RegExp(k));
      assert.equal(existsSync(join(target, 'a.txt')), true, `${k}: file untouched`);
    }
    assert.equal(sub.query({ types: ['todo'], cap: 100 }).length, 0, 'no store writes');
    sub.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
