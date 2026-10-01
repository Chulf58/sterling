// H10 settlement base when the checkout moves to a sibling branch (board
// 54b775be, KS dashboards gap 9).
//
// A settled SHA that still exists but is not an ancestor of HEAD used to be
// reported as rewritten history: a loud "SETTLEMENT HISTORY REWRITTEN" line, a
// capture_owed recovery item for work already paid, and no trusted base for
// the release-mechanics proof. gitTouches now diffs from `git merge-base` in
// that case and keeps only the paths whose content also differs from the
// settled snapshot. A SHA git cannot find, or one with no merge-base (unrelated
// histories), is still a rewrite and stays loud.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { gitTouches, writeGitSettled, GIT_SETTLED_REL } from '../hooks/lib/settlement.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-10-01T08:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sibling-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ toolchains: [], context_watch: { windows: { default: 200_000 } } }));
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\nt/\n');
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (msg) => {
    g(['add', '-A']);
    g(['commit', '-qm', msg]);
    return g(['rev-parse', 'HEAD']);
  };
  /** Records the tree as it stands, exactly as a successful H10 settlement does. */
  const settle = () => {
    const t = gitTouches(dir, NOW);
    assert.equal(t.ok, true, t.reason);
    writeGitSettled(dir, t.next);
    return t.next.sha;
  };
  return { dir, g, write, commit, settle, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const candidatePaths = (t) => t.candidates.map((c) => c.path).sort();

test('sibling checkout: the base falls back to the merge-base, a path left as settled is not a candidate, and genuine new work still is', () => {
  const r = makeRepo();
  try {
    r.write('src/shared.mjs', 'export const s = 1;\n');
    const fork = r.commit('fork point');
    r.g(['checkout', '-qb', 'feat']);
    r.write('src/feat.mjs', 'export const f = 1;\n');
    r.commit('feat work');
    const settled = r.settle();

    // The checkout moves to the sibling: feat's change is absent from main, so
    // src/feat.mjs no longer matches the settled snapshot, but nobody did work.
    r.g(['checkout', '-q', 'main']);
    const moved = gitTouches(r.dir, NOW);
    assert.equal(moved.ok, true, moved.reason);
    assert.equal(moved.base_lost, false, 'a settled SHA on a sibling branch is not a rewrite');
    assert.equal(moved.merge_base, fork, 'the effective base is the merge-base of the settled SHA and HEAD');
    assert.equal(moved.settled.sha, settled);
    assert.deepEqual(candidatePaths(moved), [], 'switching branches is not work: no candidate for the path feat changed');

    // Paid work arriving by another commit (a cherry-pick: same content, new
    // SHA) owes nothing; a real edit made on main does.
    r.g(['cherry-pick', 'feat']);
    r.write('src/shared.mjs', 'export const s = 2;\n');
    r.write('src/new.mjs', 'export const n = 1;\n');
    const after = gitTouches(r.dir, NOW);
    assert.equal(after.base_lost, false);
    assert.deepEqual(
      candidatePaths(after),
      ['src/new.mjs', 'src/shared.mjs'],
      'src/feat.mjs matches the settled snapshot and is excluded; the shared edit and the new file are this session\'s work'
    );
  } finally {
    r.cleanup();
  }
});

test('missing SHA: a settled SHA git cannot find is a rewrite (base_lost), with no merge-base fallback', () => {
  const r = makeRepo();
  try {
    r.write('src/a.mjs', 'export const a = 1;\n');
    r.commit('one');
    r.settle();
    writeFileSync(join(r.dir, GIT_SETTLED_REL),JSON.stringify({ sha: '0123456789abcdef0123456789abcdef01234567', dirty: {}, at: NOW }));
    const t = gitTouches(r.dir, NOW);
    assert.equal(t.ok, true, t.reason);
    assert.equal(t.base_lost, true);
    assert.equal(t.merge_base, null);
  } finally {
    r.cleanup();
  }
});

test('unrelated history: a settled SHA with no merge-base with HEAD is a rewrite (base_lost)', () => {
  const r = makeRepo();
  try {
    r.write('src/a.mjs', 'export const a = 1;\n');
    r.commit('one');
    r.settle();
    r.g(['checkout', '-q', '--orphan', 'other']);
    r.g(['rm', '-rqf', '.']);
    r.write('src/b.mjs', 'export const b = 1;\n');
    r.commit('unrelated root');
    const t = gitTouches(r.dir, NOW);
    assert.equal(t.ok, true, t.reason);
    assert.equal(t.base_lost, true, 'no common ancestor means no trustworthy base');
    assert.equal(t.merge_base, null);
  } finally {
    r.cleanup();
  }
});

test('H10 Stop after a sibling checkout: no rewrite message and no recovery capture_owed item', () => {
  const r = makeRepo();
  const store = new SterlingStore(join(r.dir, '.sterling', 'sterling.db'));
  try {
    r.write('src/shared.mjs', 'export const s = 1;\n');
    r.commit('fork point');
    r.g(['checkout', '-qb', 'feat']);
    r.write('src/feat.mjs', 'export const f = 1;\n');
    r.commit('feat work');
    r.settle();
    r.g(['checkout', '-q', 'main']);

    const res = spawnSync(process.execPath, [join(HOOKS, 'h10-direct-capture.mjs')], {
      input: JSON.stringify({ session_id: 's1', transcript_path: join(r.dir, 't', 's1.jsonl'), cwd: r.dir, permission_mode: 'default', hook_event_name: 'Stop' }),
      encoding: 'utf8',
      cwd: r.dir,
      timeout: 60_000,
      env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /SETTLEMENT HISTORY REWRITTEN/);
    const recovery = store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === 'capture_owed');
    assert.deepEqual(recovery.map((t) => t.text), [], 'no capture_owed item is minted for a branch switch');
    assert.equal(JSON.parse(readFileSync(join(r.dir, GIT_SETTLED_REL), 'utf8')).sha, r.g(['rev-parse', 'HEAD']), 'the snapshot advances to the new HEAD');
  } finally {
    store.close();
    r.cleanup();
  }
});

// The two tests below PIN ACCEPTED BEHAVIOUR, not desired behaviour. The
// merge-base fallback cannot tell an amend or a rebase from a sibling checkout:
// all three leave a settled SHA that git can still read but HEAD does not
// descend from. They record what gitTouches measurably does today, so a change
// to it is a deliberate decision rather than a silent drift.

test('pin (accepted behaviour, non-guarantee): an amend while the old commit is still readable is not a rewrite, and the amended delta is a candidate', () => {
  const r = makeRepo();
  try {
    r.write('src/base.mjs', 'export const b = 1;\n');
    const parent = r.commit('base');
    r.write('src/a.mjs', 'export const a = 1;\n');
    const settled = r.commit('one');
    r.settle();

    r.write('src/a.mjs', 'export const a = 2;\n');
    r.g(['add', '-A']);
    r.g(['commit', '-q', '--amend', '-m', 'one (amended)']);
    assert.equal(spawnSync('git', ['cat-file', '-e', `${settled}^{commit}`], { cwd: r.dir }).status, 0, 'fixture: the pre-amend commit is still readable');

    const t = gitTouches(r.dir, NOW);
    assert.equal(t.ok, true, t.reason);
    assert.equal(t.base_lost, false, 'accepted: a readable pre-amend SHA takes the merge-base fallback, not the rewrite path');
    assert.equal(t.merge_base, parent, "accepted: the effective base is the amended commit's parent");
    assert.deepEqual(candidatePaths(t), ['src/a.mjs'], 'accepted: the amended delta is a candidate');
  } finally {
    r.cleanup();
  }
});

test('pin (accepted behaviour, non-guarantee 3): a rebase onto one upstream commit is not a rewrite, and the upstream path is a candidate', () => {
  const r = makeRepo();
  try {
    r.write('src/shared.mjs', 'export const s = 1;\n');
    const fork = r.commit('fork point');
    r.g(['checkout', '-qb', 'feat']);
    r.write('src/feat.mjs', 'export const f = 1;\n');
    const settled = r.commit('feat work');
    r.settle();

    r.g(['checkout', '-q', 'main']);
    r.write('src/upstream.mjs', 'export const u = 1;\n');
    r.commit('upstream work');
    r.g(['checkout', '-q', 'feat']);
    r.g(['rebase', '-q', 'main']);
    assert.equal(spawnSync('git', ['cat-file', '-e', `${settled}^{commit}`], { cwd: r.dir }).status, 0, 'fixture: the pre-rebase commit is still readable');

    const t = gitTouches(r.dir, NOW);
    assert.equal(t.ok, true, t.reason);
    assert.equal(t.base_lost, false, 'accepted: a readable pre-rebase SHA takes the merge-base fallback, not the rewrite path');
    assert.equal(t.merge_base, fork, 'accepted: the effective base is the original fork point');
    assert.deepEqual(
      candidatePaths(t),
      ['src/upstream.mjs'],
      'accepted (non-guarantee 3): the path the upstream commit brought in is a candidate although this session did not write it'
    );
  } finally {
    r.cleanup();
  }
});
