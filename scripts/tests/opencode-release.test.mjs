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
import { RELEASE_BRANCH, RELEASE_PACKAGE, releaseAfterMerge, releasePackageJson } from '../lib/opencode-release.mjs';

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
