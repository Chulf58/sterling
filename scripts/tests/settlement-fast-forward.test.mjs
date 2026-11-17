// GitHub #279: files that reach HEAD through a fast-forward (git merge --ff-only,
// git pull) are other sessions' work, so settlement does not count them as the
// session's own edits. Session edits in the same turn still count, including a
// file that was both pulled and edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gitTouches, writeGitSettled } from '../hooks/lib/settlement.mjs';

const NOW = '2026-11-17T08:00:00.000Z';

/** A repo on `main` plus a `feat` branch checked out; `main` then gains a commit touching `main-only.mjs` and `shared.mjs`. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ff-'));
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (msg) => {
    g(['add', '-A']);
    g(['commit', '-qm', msg]);
  };
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  write('.gitignore', '.sterling/\n');
  write('a.mjs', 'a0\n');
  write('shared.mjs', 's0\n');
  commit('base');
  g(['checkout', '-qb', 'feat']);
  const t = gitTouches(dir, NOW);
  assert.equal(t.ok, true, t.reason);
  writeGitSettled(dir, t.next);
  g(['checkout', '-q', 'main']);
  write('main-only.mjs', 'm1\n');
  write('shared.mjs', 's1\n');
  commit('merged elsewhere');
  g(['checkout', '-q', 'feat']);
  return { dir, g, write, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const paths = (t) => t.candidates.map((c) => c.path).sort();

test('an edit plus a fast-forward merge: only the edit is a candidate', () => {
  const r = makeRepo();
  try {
    r.write('a.mjs', 'a1\n');
    r.g(['merge', '--ff-only', '-q', 'main']);
    const t = gitTouches(r.dir, NOW);
    assert.equal(t.ok, true, t.reason);
    assert.deepEqual(paths(t), ['a.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a file both pulled and edited uncommitted is counted; the pulled-only file is not', () => {
  const r = makeRepo();
  try {
    r.g(['merge', '--ff-only', '-q', 'main']);
    r.write('shared.mjs', 's2\n');
    const t = gitTouches(r.dir, NOW);
    assert.deepEqual(paths(t), ['shared.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a file pulled and then changed in a session commit is counted', () => {
  const r = makeRepo();
  try {
    r.g(['merge', '--ff-only', '-q', 'main']);
    r.write('shared.mjs', 's2\n');
    r.write('own.mjs', 'o\n');
    r.commit('session work');
    const t = gitTouches(r.dir, NOW);
    assert.deepEqual(paths(t), ['own.mjs', 'shared.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a session commit made before the fast-forward still counts', () => {
  const r = makeRepo();
  try {
    r.write('own.mjs', 'o\n');
    r.commit('session work');
    r.g(['rebase', '-q', 'main']);
    const t = gitTouches(r.dir, NOW);
    assert.deepEqual(paths(t).includes('own.mjs'), true);
  } finally {
    r.cleanup();
  }
});

test('without a fast-forward nothing is excluded', () => {
  const r = makeRepo();
  try {
    r.g(['merge', '--no-ff', '-q', '-m', 'merge main', 'main']);
    const t = gitTouches(r.dir, NOW);
    assert.deepEqual(paths(t), ['main-only.mjs', 'shared.mjs']);
  } finally {
    r.cleanup();
  }
});
