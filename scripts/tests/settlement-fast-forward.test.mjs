// GitHub #279: files that reach HEAD through a fast-forward (git merge --ff-only,
// git pull) are other sessions' work, so settlement does not count them as the
// session's own edits. Session edits in the same turn still count, including a
// file that was both pulled and edited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { gitTouches, writeGitSettled, readGitSettled } from '../hooks/lib/settlement.mjs';

const NOW = '2026-11-17T08:00:00.000Z';

/**
 * A repo on `main`, settled at its base commit. `upstream()` makes a commit on branch
 * `up` from a SEPARATE worktree, so this checkout's HEAD and reflog never see it
 * (that is what another session's merged work looks like).
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ff-'));
  const other = mkdtempSync(join(tmpdir(), 'sterling-ff-other-'));
  const run = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const g = (args) => run(dir, args);
  const put = (cwd, path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const write = (path, content) => put(dir, path, content);
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
  const settle = () => {
    const t = gitTouches(dir, NOW);
    assert.equal(t.ok, true, t.reason);
    writeGitSettled(dir, t.next);
  };
  settle();
  rmSync(other, { recursive: true, force: true });
  g(['worktree', 'add', '-q', '-b', 'up', other, 'main']);
  const upstream = (onto) => {
    if (onto) run(other, ['reset', '-q', '--hard', onto]);
    put(other, 'main-only.mjs', 'm1\n');
    put(other, 'shared.mjs', 's1\n');
    run(other, ['add', '-A']);
    run(other, ['commit', '-qm', 'merged elsewhere']);
  };
  const reflog = () => {
    const p = g(['rev-parse', '--git-path', 'logs/HEAD']);
    return isAbsolute(p) ? p : join(dir, p);
  };
  /** Rewrites the HEAD reflog's lines (oldest first), e.g. to keep what `git reflog expire` leaves after a time cutoff. */
  const rewriteReflog = (fn) => {
    const lines = readFileSync(reflog(), 'utf8').split('\n').filter(Boolean);
    writeFileSync(reflog(), `${fn(lines).join('\n')}\n`);
  };
  return { dir, g, write, commit, settle, upstream, reflog, rewriteReflog, cleanup: () => (rmSync(dir, { recursive: true, force: true }), rmSync(other, { recursive: true, force: true })) };
}

const paths = (t) => t.candidates.map((c) => c.path).sort();

test('an edit plus a fast-forward merge: only the edit is a candidate', () => {
  const r = makeRepo();
  try {
    r.upstream();
    r.write('a.mjs', 'a1\n');
    r.g(['merge', '--ff-only', '-q', 'up']);
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
    r.upstream();
    r.g(['merge', '--ff-only', '-q', 'up']);
    r.write('shared.mjs', 's2\n');
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['shared.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a file pulled and then changed in a session commit is counted', () => {
  const r = makeRepo();
  try {
    r.upstream();
    r.g(['merge', '--ff-only', '-q', 'up']);
    r.write('shared.mjs', 's2\n');
    r.write('own.mjs', 'o\n');
    r.commit('session work');
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['own.mjs', 'shared.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a session commit on a branch, a return to the settled sha, then a fast-forward onto that branch is still counted', () => {
  const r = makeRepo();
  try {
    r.g(['checkout', '-qb', 'feat']);
    r.write('own.mjs', 'o\n');
    r.commit('session work');
    r.g(['checkout', '-q', 'main']);
    r.g(['merge', '--ff-only', '-q', 'feat']);
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['own.mjs']);
  } finally {
    r.cleanup();
  }
});

test('the same return to the settled sha through a new branch, with upstream work also fast-forwarded earlier, counts the session commit only', () => {
  const r = makeRepo();
  try {
    r.upstream();
    r.g(['merge', '--ff-only', '-q', 'up']);
    r.settle();
    r.g(['checkout', '-qb', 'feat']);
    r.write('own.mjs', 'o\n');
    r.commit('session work');
    r.g(['checkout', '-q', 'main']);
    r.g(['merge', '--ff-only', '-q', 'feat']);
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['own.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a rebase is not a fast-forward: its paths are not excluded', () => {
  const r = makeRepo();
  try {
    r.g(['checkout', '-qb', 'feat']);
    r.write('own.mjs', 'o\n');
    r.commit('session work');
    r.upstream();
    r.g(['branch', '-f', 'main', 'up']);
    r.g(['rebase', '-q', 'main']);
    const got = paths(gitTouches(r.dir, NOW));
    assert.equal(got.includes('own.mjs'), true);
    assert.equal(got.includes('main-only.mjs'), true);
  } finally {
    r.cleanup();
  }
});

test('without a fast-forward nothing is excluded', () => {
  const r = makeRepo();
  try {
    r.upstream();
    r.write('a.mjs', 'a1\n');
    r.commit('own');
    r.g(['merge', '--no-ff', '-q', '-m', 'merge up', 'up']);
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['a.mjs', 'main-only.mjs', 'shared.mjs']);
  } finally {
    r.cleanup();
  }
});

// The exclusion needs proof that the HEAD reflog still reaches the settlement boundary. Finding the
// settled sha somewhere in the surviving reflog is not that proof: a return to it after the boundary
// entry expired looks the same.
test('reflog expired up to a return to the settled sha: a later fast-forward onto session work is still counted', () => {
  const r = makeRepo();
  try {
    r.g(['checkout', '-qb', 'feat']);
    r.write('own.mjs', 'o\n');
    r.commit('session work');
    r.g(['checkout', '-q', 'main']);
    r.rewriteReflog((lines) => lines.slice(-1));
    r.g(['merge', '--ff-only', '-q', 'feat']);
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['own.mjs']);
  } finally {
    r.cleanup();
  }
});

test('the same expiry on a detached HEAD: the session commit is still counted', () => {
  const r = makeRepo();
  try {
    const base = r.g(['rev-parse', 'HEAD']);
    r.g(['checkout', '-q', '--detach']);
    r.settle();
    r.write('own.mjs', 'o\n');
    r.commit('session work');
    const own = r.g(['rev-parse', 'HEAD']);
    r.g(['checkout', '-q', '--detach', base]);
    r.rewriteReflog((lines) => lines.slice(-1));
    r.g(['merge', '--ff-only', '-q', own]);
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['own.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a fast-forward on a detached HEAD is excluded when the reflog reaches the boundary', () => {
  const r = makeRepo();
  try {
    r.g(['checkout', '-q', '--detach']);
    r.settle();
    r.upstream();
    r.write('a.mjs', 'a1\n');
    r.g(['merge', '--ff-only', '-q', 'up']);
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['a.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a gap in the reflog after the boundary (amended commits expired as unreachable) excludes nothing', () => {
  const r = makeRepo();
  try {
    r.g(['checkout', '-qb', 'feat']);
    r.write('own.mjs', 'o\n');
    r.write('shared.mjs', 'own\n');
    r.commit('session work');
    r.write('own.mjs', 'o2\n');
    r.g(['commit', '-qa', '--amend', '-m', 'session work']);
    // Drops "commit" and "commit (amend)": the first commit is unreachable after the amend.
    r.g(['reflog', 'expire', '--expire=never', '--expire-unreachable=now', 'HEAD']);
    r.upstream('feat');
    r.g(['merge', '--ff-only', '-q', 'up']);
    // The fast-forward also rewrote shared.mjs, which a session commit changed; with the commit's
    // reflog entry gone, nothing proves which paths were the session's, so nothing is excluded.
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['main-only.mjs', 'own.mjs', 'shared.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a HEAD move the reflog did not record after a fast-forward excludes nothing', () => {
  const r = makeRepo();
  try {
    r.upstream();
    r.g(['merge', '--ff-only', '-q', 'up']);
    r.write('shared.mjs', 'own\n');
    r.commit('session work');
    r.rewriteReflog((lines) => lines.slice(0, -1));
    assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['main-only.mjs', 'shared.mjs']);
  } finally {
    r.cleanup();
  }
});

test('a settled snapshot without the reflog anchor (written before it existed, or without at) excludes nothing', () => {
  for (const drop of [['reflog'], ['reflog', 'at']]) {
    const r = makeRepo();
    try {
      const file = join(r.dir, '.sterling', 'transient', 'git-settled.json');
      const s = readGitSettled(r.dir);
      for (const k of drop) delete s[k];
      writeFileSync(file, JSON.stringify(s));
      r.upstream();
      r.g(['merge', '--ff-only', '-q', 'up']);
      assert.deepEqual(paths(gitTouches(r.dir, NOW)), ['main-only.mjs', 'shared.mjs'], `without ${drop.join(', ')}`);
    } finally {
      r.cleanup();
    }
  }
});
