// The /sterling:merge publish step (scripts/lib/npm-publish.mjs), decision
// sterling-on-opencode-distributes-as-npm-package-via-opencode-plugin-add:
// after a hobby merge that bumped the version and pushed, publish
// @chulf58/sterling; refuse loudly, without failing the merge, when npm has no
// login or the version is already on the registry. Every npm call goes through
// an injected fake, so this file never touches the network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLISH_PACKAGE, publishAfterMerge } from '../lib/npm-publish.mjs';

const work = mkdtempSync(join(tmpdir(), 'sterling-npm-publish-'));
after(() => rmSync(work, { recursive: true, force: true }));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let n = 0;
/** A repo with two commits; returns {repo, base, head}. */
function fixture({ name = PUBLISH_PACKAGE, from = '1.0.0', to = '1.0.1' } = {}) {
  const repo = join(work, `repo-${n++}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.invalid');
  git(repo, 'config', 'user.name', 't');
  const write = (v) => writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: v }, null, 2) + '\n');
  write(from);
  writeFileSync(join(repo, 'shipped.txt'), 'tracked\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(to);
  writeFileSync(join(repo, 'shipped.txt'), 'tracked, changed\n');
  git(repo, 'commit', '-q', '-am', 'change');
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

/** A scripted npm: answers per subcommand and records every call. */
function fakeNpm({ whoami = { status: 0, stdout: 'chulf58\n' }, view = { status: 0, stdout: '' }, publish = { status: 0, stdout: '+ pkg' } } = {}) {
  const calls = [];
  const npm = (args, opts = {}) => {
    calls.push({ args, cwd: opts.cwd, shipped: opts.cwd ? existsSync(join(opts.cwd, 'shipped.txt')) : null, pkg: opts.cwd && existsSync(join(opts.cwd, 'package.json')) ? readFileSync(join(opts.cwd, 'package.json'), 'utf8') : null });
    const r = { whoami, view, publish }[args[0]];
    if (!r) throw new Error(`unexpected npm call: ${args.join(' ')}`);
    return { stderr: '', stdout: '', ...r };
  };
  return { npm, calls };
}

function run(fx, npm, extra = {}) {
  const lines = [];
  const result = publishAfterMerge({ target: fx.repo, baseSha: fx.base, headSha: fx.head, pushed: true, npm, log: (m) => lines.push(m), ...extra });
  return { result, out: lines.join('\n') };
}

test('a pushed version bump of @chulf58/sterling publishes the committed tree of the merge head', () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, 'untracked-leak.txt'), 'must not ship\n');
  const { npm, calls } = fakeNpm();
  const { result, out } = run(fx, npm);
  assert.deepEqual(result, { status: 'published', version: '1.0.1', reason: null });
  assert.deepEqual(calls.map((c) => c.args), [['whoami'], ['view', `${PUBLISH_PACKAGE}@1.0.1`, 'version'], ['publish', '--ignore-scripts']]);
  const pub = calls[2];
  assert.notEqual(pub.cwd, fx.repo, 'publish runs in a staged copy, never the working tree');
  assert.equal(pub.shipped, true, 'the staged copy holds the tracked files');
  assert.match(pub.pkg, /"version": "1.0.1"/);
  assert.equal(existsSync(pub.cwd), false, 'the staged copy is removed afterwards');
  assert.match(out, /published @chulf58\/sterling@1\.0\.1/);
});

test('the staged copy holds tracked files only, so an untracked file never ships', () => {
  const fx = fixture();
  writeFileSync(join(fx.repo, 'untracked-leak.txt'), 'must not ship\n');
  let leaked = null;
  const { npm } = fakeNpm();
  const spy = (args, opts) => {
    if (args[0] === 'publish') leaked = existsSync(join(opts.cwd, 'untracked-leak.txt'));
    return npm(args, opts);
  };
  run(fx, spy);
  assert.equal(leaked, false);
});

test('no npm login refuses loudly, names npm login, and never publishes', () => {
  const fx = fixture();
  const { npm, calls } = fakeNpm({ whoami: { status: 1, stderr: 'npm error code ENEEDAUTH' } });
  const { result, out } = run(fx, npm);
  assert.equal(result.status, 'refused');
  assert.match(out, /npm login/);
  assert.match(out, /THE MERGE STANDS/);
  assert.equal(result.reason, 'npm whoami failed (no login, npm missing, or network)', 'the headline names every cause, not only a missing login');
  assert.deepEqual(calls.map((c) => c.args[0]), ['whoami']);
});

test('a version already on the registry refuses loudly and never publishes', () => {
  const fx = fixture();
  const { npm, calls } = fakeNpm({ view: { status: 0, stdout: '1.0.1\n' } });
  const { result, out } = run(fx, npm);
  assert.equal(result.status, 'refused');
  assert.match(out, /1\.0\.1 is already published/);
  assert.deepEqual(calls.map((c) => c.args[0]), ['whoami', 'view']);
});

test('a first publish (E404 for the package) proceeds', () => {
  const fx = fixture();
  const { npm } = fakeNpm({ view: { status: 1, stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@chulf58%2fsterling' } });
  assert.equal(run(fx, npm).result.status, 'published');
});

test('a registry check that fails for another reason refuses: an unverified version is never published', () => {
  const fx = fixture();
  const { npm, calls } = fakeNpm({ view: { status: 1, stderr: 'npm error code ETIMEDOUT' } });
  const { result, out } = run(fx, npm);
  assert.equal(result.status, 'refused');
  assert.match(out, /ETIMEDOUT/);
  assert.deepEqual(calls.map((c) => c.args[0]), ['whoami', 'view']);
});

test('a failed npm publish reports failed with npm output', () => {
  const fx = fixture();
  const { npm } = fakeNpm({ publish: { status: 1, stderr: 'npm error 403 Forbidden' } });
  const { result, out } = run(fx, npm);
  assert.equal(result.status, 'failed');
  assert.match(out, /403 Forbidden/);
});

for (const [label, fx, extra, why] of [
  ['an unchanged version', () => fixture({ to: '1.0.0' }), {}, /version did not change \(1\.0\.0\)/],
  ['another package name', () => fixture({ name: 'some-consumer' }), {}, /names some-consumer, not @chulf58\/sterling/],
  ['an unpushed base', () => fixture(), { pushed: false }, /was not pushed/],
]) {
  test(`${label} is a loud no-op that runs no npm command`, () => {
    const { npm, calls } = fakeNpm();
    const { result, out } = run(fx(), npm, extra);
    assert.equal(result.status, 'skipped');
    assert.match(out, /npm publish SKIPPED/);
    assert.match(out, why);
    assert.equal(calls.length, 0);
  });
}
