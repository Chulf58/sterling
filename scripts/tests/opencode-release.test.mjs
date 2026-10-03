// The /sterling:merge OpenCode release step (scripts/lib/opencode-release.mjs),
// decision sterling-on-opencode-installs-from-a-git-release-branch-v2: after a
// hobby merge that moved the version and pushed, write the merged tree with a
// Git-installable package.json as a commit on `opencode-release`, tag it
// v<version>, and push both. Refuse loudly, without failing the merge, when the
// tag already names other content. Every origin here is a local bare repo.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_BRANCH, RELEASE_PACKAGE, defaultRemoteGit, releaseAfterMerge, releasePackageJson, rerunRelease } from '../lib/opencode-release.mjs';

const work = mkdtempSync(join(tmpdir(), 'sterling-opencode-release-'));
after(() => rmSync(work, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('../opencode-release.mjs', import.meta.url));
const LIB = fileURLToPath(new URL('../lib/opencode-release.mjs', import.meta.url));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const gitOk = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).status === 0;

const PKG = (name, version) => ({
  name,
  type: 'module',
  version,
  exports: { './server': './opencode/sterling-server.mjs' },
  files: ['scripts/', '!scripts/tests/'],
  workspaces: ['packages/*'],
  scripts: { prepare: 'npm run build', build: 'tsc', preinstall: 'x', install: 'x', postinstall: 'x', prepack: 'x', test: 'node --test', 'build:hooks': 'node b.mjs' },
  devDependencies: { esbuild: '^0.28.0' },
});

let n = 0;
function identity(repo) {
  git(repo, 'config', 'user.email', 't@example.invalid');
  git(repo, 'config', 'user.name', 't');
}
/** A repo with a bare origin and two commits on main, both pushed; core.filemode=false like the /mnt/c clone. */
function fixture({ name = RELEASE_PACKAGE, from = '1.0.0', to = '1.0.1' } = {}) {
  const dir = join(work, `fx-${n++}`);
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'init', '-q', '-b', 'main');
  identity(repo);
  git(repo, 'config', 'core.filemode', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'remote', 'add', 'origin', origin);
  const write = (v) => writeFileSync(join(repo, 'package.json'), JSON.stringify(PKG(name, v), null, 2) + '\n');
  write(from);
  writeFileSync(join(repo, 'shipped.txt'), 'tracked\n');
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(join(repo, 'run.sh'), 0o755);
  git(repo, 'add', '-A');
  git(repo, 'update-index', '--chmod=+x', 'run.sh');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(to);
  writeFileSync(join(repo, 'shipped.txt'), 'tracked, changed\n');
  git(repo, 'commit', '-q', '-am', 'change');
  git(repo, 'push', '-q', 'origin', 'main');
  return { dir, origin, repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

/** Commit a version bump on main and push it; returns {base, head}. */
function bump(repo, version) {
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'package.json'), JSON.stringify(PKG(RELEASE_PACKAGE, version), null, 2) + '\n');
  git(repo, 'commit', '-q', '-am', `bump ${version}`);
  git(repo, 'push', '-q', 'origin', 'main');
  return { base, head: git(repo, 'rev-parse', 'HEAD') };
}

function run(fx, extra = {}) {
  const lines = [];
  const result = releaseAfterMerge({ target: fx.repo, into: 'main', baseSha: fx.base, headSha: fx.head, pushed: true, log: (m) => lines.push(m), ...extra });
  return { result, out: lines.join('\n') };
}

const ref = (cwd, name) => spawnSync('git', ['rev-parse', '-q', '--verify', name], { cwd, encoding: 'utf8' }).stdout.trim() || null;

test('the shipped package.json drops workspaces and every build-class script and keeps everything else', () => {
  const out = JSON.parse(releasePackageJson(JSON.stringify(PKG(RELEASE_PACKAGE, '1.2.3'))));
  assert.equal(out.workspaces, undefined);
  assert.deepEqual(out.scripts, { test: 'node --test', 'build:hooks': 'node b.mjs' }, 'only postinstall, build, preinstall, install, prepack and prepare make a Git install fail');
  assert.equal(out.name, RELEASE_PACKAGE);
  assert.equal(out.version, '1.2.3');
  assert.deepEqual(out.files, ['scripts/', '!scripts/tests/']);
  assert.deepEqual(out.exports, { './server': './opencode/sterling-server.mjs' });
  assert.deepEqual(out.devDependencies, { esbuild: '^0.28.0' });
  const bare = JSON.parse(releasePackageJson(JSON.stringify({ name: 'x', version: '1.0.0', scripts: { build: 'tsc' } })));
  assert.equal('scripts' in bare, false, 'a scripts object left empty is dropped');
});

test('a pushed version bump writes the merged tree to opencode-release, tags it v<version> and pushes both', () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, 'untracked-leak.txt'), 'must not ship\n');
  const statusBefore = git(fx.repo, 'status', '--porcelain');
  const { result, out } = run(fx);
  assert.equal(result.status, 'published', out);
  assert.equal(result.version, '1.0.1');
  const commit = result.commit;
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), commit, 'origin has the release branch');
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), commit, 'origin has the tag on the same commit');
  assert.equal(ref(fx.repo, `refs/heads/${RELEASE_BRANCH}`), commit);
  assert.equal(ref(fx.repo, 'refs/tags/v1.0.1'), commit);
  // The release tree is the merged tree, byte for byte, except package.json.
  assert.equal(git(fx.repo, 'diff-tree', '-r', '--name-only', `${fx.head}^{tree}`, `${commit}^{tree}`), 'package.json');
  assert.match(git(fx.repo, 'ls-tree', commit, 'run.sh'), /^100755 /, 'the executable bit survives core.filemode=false');
  assert.equal(gitOk(fx.repo, 'cat-file', '-e', `${commit}:untracked-leak.txt`), false, 'an untracked file never ships');
  const shipped = JSON.parse(git(fx.repo, 'show', `${commit}:package.json`));
  assert.equal(shipped.workspaces, undefined);
  assert.equal(shipped.scripts.prepare, undefined);
  assert.equal(shipped.version, '1.0.1');
  assert.equal(git(fx.repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').length, 1, 'the first release has no parent');
  assert.match(git(fx.repo, 'log', '-1', '--format=%B', commit), new RegExp(fx.head));
  // The authoring tree was never touched: same branch, same HEAD, same status.
  assert.equal(git(fx.repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(git(fx.repo, 'rev-parse', 'HEAD'), fx.head);
  assert.equal(git(fx.repo, 'status', '--porcelain'), statusBefore);
  assert.match(out, /released @chulf58\/sterling v1\.0\.1 on opencode-release/);
});

test('the next release is a child of the current opencode-release tip', () => {
  const fx = fixture();
  const first = run(fx).result.commit;
  const { base, head } = bump(fx.repo, '1.0.2');
  const { result } = run({ ...fx, base, head });
  assert.equal(result.status, 'published');
  assert.equal(git(fx.repo, 'rev-parse', `${result.commit}^`), first);
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), result.commit);
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), first, 'the old tag stays where it was');
});

test('a clone with no local opencode-release parents onto the branch origin has', () => {
  const fx = fixture();
  const first = run(fx).result.commit;
  const clone = join(fx.dir, 'clone');
  git(fx.dir, 'clone', '-q', '--no-tags', '--single-branch', '-b', 'main', fx.origin, clone);
  identity(clone);
  assert.equal(ref(clone, `refs/heads/${RELEASE_BRANCH}`), null);
  const { base, head } = bump(clone, '1.0.2');
  const { result, out } = run({ ...fx, repo: clone, base, head });
  assert.equal(result.status, 'published', out);
  assert.equal(git(clone, 'rev-parse', `${result.commit}^`), first, 'a fast-forward of origin, never a second root');
});

test('a tag already on origin with other content refuses, pushes nothing, and keeps the merge', () => {
  const fx = fixture();
  git(fx.repo, 'push', '-q', 'origin', `${fx.base}:refs/tags/v1.0.1`);
  const { result, out } = run(fx);
  assert.equal(result.status, 'refused');
  assert.match(out, /opencode release REFUSED/);
  assert.match(out, /v1\.0\.1 already exists/);
  assert.match(out, /THE MERGE STANDS/);
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), null);
  assert.equal(ref(fx.repo, `refs/heads/${RELEASE_BRANCH}`), null, 'no local ref is written on a refusal');
});

test('a local tag with other content refuses', () => {
  const fx = fixture();
  git(fx.repo, 'tag', 'v1.0.1', fx.base);
  const { result, out } = run(fx);
  assert.equal(result.status, 'refused');
  assert.match(out, /v1\.0\.1 already exists/);
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), null);
});

test('local and origin tags on different commits refuse', () => {
  const fx = fixture();
  const first = run(fx).result.commit;
  git(fx.repo, 'tag', '-f', 'v1.0.1', fx.base);
  const { result, out } = run(fx);
  assert.equal(result.status, 'refused');
  assert.match(out, /local v1\.0\.1 .* differs from origin's/);
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), first);
});

test('a failed push reports failed with the re-run command; the re-run reuses the same release commit', () => {
  const fx = fixture();
  const failing = (args, opts) => (args[0] === 'push' ? { status: 1, stdout: '', stderr: 'remote: denied' } : spawnSync('git', args, { ...opts, encoding: 'utf8' }));
  const { result, out } = run(fx, { remoteGit: failing });
  assert.equal(result.status, 'failed');
  assert.match(out, /opencode release FAILED/);
  assert.match(out, /THE MERGE STANDS/);
  assert.match(out, /remote: denied/);
  assert.ok(out.includes(`node ${join(fx.repo, 'scripts', 'opencode-release.mjs')} --target ${fx.repo} --ref main`), "the re-run is the target checkout's own entry point, never the module path, which inside bin/direct-merge.mjs is the merge");
  const local = ref(fx.repo, 'refs/tags/v1.0.1');
  assert.ok(local, 'the local refs are kept for the re-run');
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), null);

  const again = run(fx);
  assert.equal(again.result.status, 'published', again.out);
  assert.equal(again.result.commit, local, 'the re-run pushes the release it already built');
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), local);
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), local);

  const third = run(fx);
  assert.equal(third.result.status, 'published');
  assert.match(third.out, /already on origin/);
});

test('a release kept after a failed push is rebuilt onto origin\'s newer tip, never force-pushed', () => {
  // Clone C bumps to 1.0.4 and its release push fails; clone D then releases 1.0.5.
  // C's kept v1.0.4 is no longer a descendant of origin's opencode-release, so the
  // re-run rebuilds it (same tree) as a child of origin's tip and publishes it.
  const fx = fixture();
  const first = run(fx).result.commit;
  const c = bump(fx.repo, '1.0.4');
  const failing = (args, opts) => (args[0] === 'push' ? { status: 1, stdout: '', stderr: 'remote: denied' } : spawnSync('git', args, { ...opts, encoding: 'utf8' }));
  assert.equal(run({ ...fx, ...c }, { remoteGit: failing }).result.status, 'failed');
  const kept = ref(fx.repo, 'refs/tags/v1.0.4');
  assert.equal(git(fx.repo, 'rev-parse', `${kept}^`), first);

  const d = join(fx.dir, 'clone-d');
  git(fx.dir, 'clone', '-q', '--no-tags', '--single-branch', '-b', 'main', fx.origin, d);
  identity(d);
  const dBump = bump(d, '1.0.5');
  const v105 = run({ ...fx, repo: d, ...dBump });
  assert.equal(v105.result.status, 'published', v105.out);

  const again = run({ ...fx, ...c });
  assert.equal(again.result.status, 'published', again.out);
  const rebuilt = again.result.commit;
  assert.notEqual(rebuilt, kept, 'the kept commit is replaced');
  assert.equal(git(fx.repo, 'rev-parse', `${rebuilt}^`), v105.result.commit, "the rebuilt release is a child of origin's tip");
  assert.equal(git(fx.repo, 'rev-parse', `${rebuilt}^{tree}`), git(fx.repo, 'rev-parse', `${kept}^{tree}`), 'same tree');
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.4'), rebuilt);
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), rebuilt);
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.5'), v105.result.commit, 'the newer tag is untouched');
  assert.equal(ref(fx.repo, 'refs/tags/v1.0.4'), rebuilt, 'the local tag moved');
  assert.equal(ref(fx.repo, `refs/heads/${RELEASE_BRANCH}`), rebuilt, 'the local branch moved');
  assert.match(again.out, /rebuil/i);
});

test('a local tag on a commit origin\'s branch already contains, with origin missing only the tag, pushes just the tag', () => {
  // v1.0.1 is released, v1.0.2 moves origin's branch past it, then v1.0.1's tag is
  // deleted on origin. The re-run re-tags the existing commit: no second commit with
  // the same tree, and origin's branch tip does not move.
  const fx = fixture();
  const first = run(fx).result.commit;
  const next = bump(fx.repo, '1.0.2');
  const second = run({ ...fx, ...next }).result.commit;
  git(fx.origin, 'tag', '-d', 'v1.0.1');
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), null, 'precondition: origin lacks the tag');
  const commitsBefore = git(fx.origin, 'rev-list', '--count', `refs/heads/${RELEASE_BRANCH}`);

  const again = run(fx);
  assert.equal(again.result.status, 'published', again.out);
  assert.equal(again.result.commit, first, 'the existing commit is re-tagged, not rebuilt');
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), first);
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), second, "origin's branch tip is unchanged");
  assert.equal(git(fx.origin, 'rev-list', '--count', `refs/heads/${RELEASE_BRANCH}`), commitsBefore, 'no new commit on the branch');
  assert.equal(ref(fx.repo, 'refs/tags/v1.0.1'), first, 'the local tag stays');
  assert.equal(ref(fx.repo, `refs/heads/${RELEASE_BRANCH}`), second, 'the local branch stays');
  assert.match(again.out, /only the tag/i);
});

test('a failed tag-only push reports failed with the existing commit, keeps the local tag, and the re-run publishes', () => {
  const fx = fixture();
  const first = run(fx).result.commit;
  const next = bump(fx.repo, '1.0.2');
  const second = run({ ...fx, ...next }).result.commit;
  git(fx.origin, 'tag', '-d', 'v1.0.1');
  const pushes = [];
  const failing = (args, opts) => {
    if (args[0] !== 'push') return spawnSync('git', args, { ...opts, encoding: 'utf8' });
    pushes.push(args);
    return { status: 1, stdout: '', stderr: 'remote: denied' };
  };
  const { result, out } = run(fx, { remoteGit: failing });
  assert.equal(result.status, 'failed', out);
  assert.equal(result.commit, first, 'the existing commit is reported, not a rebuilt one');
  assert.match(out, /remote: denied/);
  assert.match(out, /opencode release FAILED/);
  assert.deepEqual(pushes, [['push', 'origin', 'refs/tags/v1.0.1:refs/tags/v1.0.1']], 'exactly one push, the tag alone');
  assert.equal(ref(fx.repo, 'refs/tags/v1.0.1'), first, 'the local tag stays');
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), null, 'origin has no tag');
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), second, "origin's branch is unchanged");

  const again = run(fx);
  assert.equal(again.result.status, 'published', again.out);
  assert.equal(again.result.commit, first);
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), first);
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), second);
});

test('a local tag at origin\'s branch tip with origin missing only the tag pushes the tag and leaves the branch', () => {
  const fx = fixture();
  const first = run(fx).result.commit;
  git(fx.origin, 'tag', '-d', 'v1.0.1');
  const again = run(fx);
  assert.equal(again.result.status, 'published', again.out);
  assert.equal(again.result.commit, first);
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), first);
  assert.equal(ref(fx.origin, `refs/heads/${RELEASE_BRANCH}`), first);
  assert.equal(git(fx.origin, 'rev-list', '--count', `refs/heads/${RELEASE_BRANCH}`), '1');
  assert.match(again.out, /only the tag/i);
});

test('an annotated tag on origin and a lightweight local tag on the same commit is the same release', () => {
  const fx = fixture();
  const first = run(fx).result.commit;
  git(fx.origin, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'tag', '-f', '-a', '-m', 'annotated', 'v1.0.1', first);
  assert.notEqual(ref(fx.origin, 'refs/tags/v1.0.1'), first, 'precondition: origin\'s tag is a tag object');
  const { result, out } = run(fx);
  assert.equal(result.status, 'published', out);
  assert.equal(result.commit, first);
  assert.match(out, /already on origin/);
});

test('the re-run refuses a --ref that is not a branch, naming the remedy', () => {
  const fx = fixture();
  git(fx.repo, 'tag', 'some-tag', 'main');
  for (const r of ['some-tag', fx.head]) {
    const lines = [];
    const result = rerunRelease({ target: fx.repo, ref: r, log: (m) => lines.push(m) });
    const out = lines.join('\n');
    assert.equal(result.status, 'refused', out);
    assert.match(out, /--ref must be the branch that was merged into/);
    assert.doesNotMatch(out, /not on origin's/);
  }
  assert.equal(ref(fx.repo, `refs/heads/${RELEASE_BRANCH}`), null);
});

test('defaultRemoteGit keeps the first failure when the git.exe retry also fails, and logs the retry', () => {
  const results = {
    git: { status: 1, stdout: '', stderr: ' ! [rejected] opencode-release -> opencode-release (non-fast-forward)' },
    'git.exe': { status: 128, stdout: '', stderr: "fatal: detected dubious ownership in repository" },
  };
  const calls = [];
  const lines = [];
  const runner = (cmd, args) => (calls.push([cmd, args]), results[cmd]);
  const r = defaultRemoteGit(['push', 'origin', 'x'], { cwd: work, run: runner, log: (m) => lines.push(m), platform: 'linux' });
  assert.equal(r.status, 1, 'the first status is kept');
  assert.match(r.stderr, /non-fast-forward/, 'the first error is kept');
  assert.match(r.stderr, /git\.exe.*\n.*dubious ownership/s, "git.exe's error is appended, labelled");
  assert.deepEqual(calls.map(([cmd]) => cmd), ['git', 'git.exe']);
  assert.deepEqual(calls[1][1], ['push', 'origin', 'x']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /`git push` failed.*retrying through git\.exe/);

  results['git.exe'] = { status: 0, stdout: 'ok', stderr: '' };
  assert.equal(defaultRemoteGit(['push'], { cwd: work, run: runner, log: () => {}, platform: 'linux' }), results['git.exe'], 'a git.exe success is adopted');

  results['git.exe'] = { status: null, stdout: '', stderr: '', error: new Error('spawnSync git.exe ENOENT') };
  assert.equal(defaultRemoteGit(['push'], { cwd: work, run: runner, log: () => {}, platform: 'linux' }), results.git, 'a git.exe that cannot spawn keeps the original failure');

  calls.length = 0;
  defaultRemoteGit(['push'], { cwd: work, run: runner, log: () => {}, platform: 'win32' });
  assert.deepEqual(calls.map(([cmd]) => cmd), ['git'], 'no retry on native Windows');
});

test('an unreachable origin refuses before writing anything', () => {
  const fx = fixture();
  git(fx.repo, 'remote', 'set-url', 'origin', join(fx.dir, 'missing.git'));
  const { result, out } = run(fx);
  assert.equal(result.status, 'refused');
  assert.match(out, /could not read origin/);
  assert.equal(ref(fx.repo, `refs/heads/${RELEASE_BRANCH}`), null);
});

for (const [label, fx, extra, why] of [
  ['an unchanged version', () => fixture({ to: '1.0.0' }), {}, /version did not change \(1\.0\.0\)/],
  ['another package name', () => fixture({ name: 'some-consumer' }), {}, /names some-consumer, not @chulf58\/sterling/],
  ['an unpushed base', () => fixture(), { pushed: false }, /was not pushed/],
]) {
  test(`${label} is a loud no-op that writes no ref`, () => {
    const f = fx();
    const { result, out } = run(f, extra);
    assert.equal(result.status, 'skipped');
    assert.match(out, /opencode release SKIPPED/);
    assert.match(out, why);
    assert.equal(ref(f.repo, `refs/heads/${RELEASE_BRANCH}`), null);
    assert.equal(ref(f.origin, `refs/heads/${RELEASE_BRANCH}`), null);
  });
}

test('the CLI re-runs the release for the version at --ref and prints opencode_release', () => {
  const fx = fixture();
  const r = spawnSync(process.execPath, [CLI, '--target', fx.repo, '--ref', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.opencode_release, 'published');
  assert.equal(json.version, '1.0.1');
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), json.commit);
});

test('running the library file itself does nothing, so the bin/direct-merge.mjs bundle that inlines it never starts a release on load', () => {
  const fx = fixture();
  const r = spawnSync(process.execPath, [LIB, '--target', fx.repo, '--ref', 'main'], { cwd: fx.repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(ref(fx.repo, `refs/heads/${RELEASE_BRANCH}`), null);
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), null);
});

test('the CLI refuses an unknown argument with exit 2', () => {
  const r = spawnSync(process.execPath, [CLI, '--into', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unrecognized or incomplete argument '--into'/);
});

test('the CLI refuses a ref origin does not have and exits 1', () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, 'shipped.txt'), 'local only\n');
  git(fx.repo, 'commit', '-q', '-am', 'unpushed');
  const r = spawnSync(process.execPath, [CLI, '--target', fx.repo, '--ref', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).opencode_release, 'skipped');
  assert.match(r.stderr, /not on origin's main/);
  assert.equal(ref(fx.origin, 'refs/tags/v1.0.1'), null);
});
