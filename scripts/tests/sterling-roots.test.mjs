// The one installed-Sterling resolver (scripts/lib/sterling-roots.mjs): every install
// root of both hosts (Claude Code's plugin cache, OpenCode's npm cache), the highest
// version wins, a version tie prefers the Claude Code copy, and a missing install gets
// the remedy of the host that asked. Fake cache trees under a temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  installRoots,
  scanInstalledSterling,
  newestInstalledSterling,
  compareSterlingVersions,
  sterlingInstallRemedy,
  sterlingUpdateRemedy,
  sterlingNotFoundMessage,
  installHostOf,
  RESOLVER_SOURCE,
  RESOLVER_IMPORTS,
} from '../lib/sterling-roots.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const rm = (...ds) => ds.forEach((d) => rmSync(d, { recursive: true, force: true }));
const touch = (p, body = '') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };

const claudeCache = (home) => join(home, '.claude', 'plugins', 'cache');
const npmCache = (home) => join(home, '.cache', 'opencode', 'npm');

/** A Claude Code cache copy: <cache>/<mkt>/sterling/<dir>/.claude-plugin/plugin.json. */
function claudeCopy(home, mkt, dirName, version = dirName) {
  const root = join(claudeCache(home), mkt, 'sterling', dirName);
  touch(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version }));
  return root;
}

/** An OpenCode npm-cache copy: <npm>/@chulf58/sterling@latest/<ts>/node_modules/@chulf58/sterling/package.json. */
function opencodeCopy(home, ts, version, key = ['@chulf58', 'sterling@latest']) {
  const root = join(npmCache(home), ...key, ts, 'node_modules', '@chulf58', 'sterling');
  touch(join(root, 'package.json'), JSON.stringify({ name: '@chulf58/sterling', version }));
  return root;
}

test('installRoots: both hosts, honouring CLAUDE_CONFIG_DIR and XDG_CACHE_HOME', () => {
  assert.deepEqual(installRoots({}, '/h'), [
    { host: 'claude-code', dir: join('/h', '.claude', 'plugins', 'cache') },
    { host: 'opencode', dir: join('/h', '.cache', 'opencode', 'npm') },
  ]);
  assert.deepEqual(installRoots({ CLAUDE_CONFIG_DIR: '/c', XDG_CACHE_HOME: '/x' }, '/h').map((r) => r.dir), [
    join('/c', 'plugins', 'cache'),
    join('/x', 'opencode', 'npm'),
  ]);
});

test('compareSterlingVersions: numeric semver, a pre-release sorts below its release', () => {
  assert.ok(compareSterlingVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareSterlingVersions('1.0.0-rc1', '1.0.0') < 0);
  assert.ok(compareSterlingVersions('1.0.0-rc2', '1.0.0-rc1') > 0);
  assert.equal(compareSterlingVersions('0.18.51', '0.18.51'), 0);
});

test('newest wins across hosts: an OpenCode 0.19.0 beats Claude Code 0.18.51 and an older OpenCode timestamp', () => {
  const home = tmp('sr-home-');
  try {
    claudeCopy(home, 'sterling', '0.18.51');
    claudeCopy(home, 'other-mkt', '0.9.0');
    opencodeCopy(home, '1759400000000', '0.18.0');
    const newest = opencodeCopy(home, '1759500000000', '0.19.0');
    assert.deepEqual(newestInstalledSterling({}, home), { root: newest, version: '0.19.0', host: 'opencode' });
  } finally {
    rm(home);
  }
});

test('newest wins across hosts: Claude Code 1.10.0 beats OpenCode 1.9.0 (numeric, not string order)', () => {
  const home = tmp('sr-home-');
  try {
    const newest = claudeCopy(home, 'sterling', '1.10.0');
    opencodeCopy(home, '1', '1.9.0');
    assert.deepEqual(newestInstalledSterling({}, home), { root: newest, version: '1.10.0', host: 'claude-code' });
  } finally {
    rm(home);
  }
});

test('version tie: the Claude Code copy wins over the OpenCode copy; within one host the lexically greater root wins (the later OpenCode timestamp)', () => {
  const home = tmp('sr-home-');
  try {
    opencodeCopy(home, '1759500000000', '2.0.0');
    const claude = claudeCopy(home, 'sterling', '2.0.0');
    assert.equal(newestInstalledSterling({}, home).root, claude, 'cross-host tie: Claude Code');
    rm(join(claudeCache(home)));
    opencodeCopy(home, '1759400000000', '2.0.0');
    const later = join(npmCache(home), '@chulf58', 'sterling@latest', '1759500000000', 'node_modules', '@chulf58', 'sterling');
    assert.equal(newestInstalledSterling({}, home).root, later, 'same-host tie: the later timestamp');
  } finally {
    rm(home);
  }
});

test('the version comes from the copy manifest, not the directory name', () => {
  const home = tmp('sr-home-');
  try {
    const root = claudeCopy(home, 'sterling', 'abc123', '3.1.4');
    assert.deepEqual(newestInstalledSterling({}, home), { root, version: '3.1.4', host: 'claude-code' });
  } finally {
    rm(home);
  }
});

test('a flat OpenCode registry key (no scope directory) is found too', () => {
  const home = tmp('sr-home-');
  try {
    const root = opencodeCopy(home, '7', '1.2.3', ['@chulf58+sterling@latest']);
    assert.equal(newestInstalledSterling({}, home).root, root);
  } finally {
    rm(home);
  }
});

test('a copy without a readable version is skipped with its reason, never picked', () => {
  const home = tmp('sr-home-');
  try {
    mkdirSync(join(claudeCache(home), 'sterling', 'sterling', '9.9.9'), { recursive: true });
    const broken = join(claudeCache(home), 'sterling', 'sterling', '8.8.8');
    touch(join(broken, '.claude-plugin', 'plugin.json'), '{not json');
    const good = claudeCopy(home, 'sterling', '1.0.0');
    const scan = scanInstalledSterling({}, home);
    assert.deepEqual(scan.copies, [{ root: good, version: '1.0.0', host: 'claude-code' }]);
    assert.equal(scan.skipped.length, 2);
    assert.match(scan.skipped.find((s) => s.root.endsWith('9.9.9')).reason, /no \.claude-plugin\/plugin\.json or package\.json/);
    assert.match(scan.skipped.find((s) => s.root.endsWith('8.8.8')).reason, /not valid JSON/);
    assert.equal(newestInstalledSterling({}, home).root, good);
  } finally {
    rm(home);
  }
});

test('nothing installed: null, and the not-found message names both roots, the skip reasons and the asking host remedy', () => {
  const home = tmp('sr-home-');
  try {
    assert.equal(newestInstalledSterling({}, home), null);
    mkdirSync(join(claudeCache(home), 'm', 'sterling', '1.0.0'), { recursive: true });
    const oc = sterlingNotFoundMessage('opencode', {}, home);
    assert.ok(oc.includes(claudeCache(home)) && oc.includes(npmCache(home)), oc);
    assert.match(oc, /skipped .*1\.0\.0: no \.claude-plugin\/plugin\.json or package\.json/);
    assert.match(oc, /opencode plugin add @chulf58\/sterling/);
    assert.doesNotMatch(oc, /claude plugin install/);
    assert.match(sterlingNotFoundMessage('claude-code', {}, home), /claude plugin install sterling@sterling/);
  } finally {
    rm(home);
  }
});

test('remedies per host; an unknown host names both; a misspelt host is a loud error', () => {
  assert.equal(sterlingInstallRemedy('claude-code'), 'claude plugin install sterling@sterling');
  assert.equal(sterlingInstallRemedy('opencode'), 'opencode plugin add @chulf58/sterling');
  assert.match(sterlingInstallRemedy(null), /claude plugin install sterling@sterling.*opencode plugin add @chulf58\/sterling/);
  assert.match(sterlingUpdateRemedy('claude-code'), /\/plugin .*claude plugin update sterling@/);
  assert.equal(sterlingUpdateRemedy('opencode'), '`opencode plugin update @chulf58/sterling`');
  assert.match(sterlingUpdateRemedy(null), /claude plugin update.*opencode plugin update/);
  assert.throws(() => sterlingInstallRemedy('claude'), /unknown host/);
  assert.throws(() => sterlingUpdateRemedy('vscode'), /unknown host/);
});

test('installHostOf: which install root a path lies under, by realpath; null outside both', () => {
  const home = tmp('sr-home-');
  const outside = tmp('sr-out-');
  try {
    const c = claudeCopy(home, 'sterling', '1.0.0');
    const o = opencodeCopy(home, '1', '1.0.0');
    assert.equal(installHostOf(c, { env: {}, home }), 'claude-code');
    assert.equal(installHostOf(o, { env: {}, home }), 'opencode');
    assert.equal(installHostOf(outside, { env: {}, home }), null);
    const link = join(outside, 'link');
    symlinkSync(o, link);
    assert.equal(installHostOf(link, { env: {}, home }), 'opencode', 'a symlink resolves to its target');
    assert.equal(installHostOf(npmCache(home), { env: {}, home }), null, 'the root itself is not under itself');
  } finally {
    rm(home, outside);
  }
});

test('RESOLVER_SOURCE inlined into a standalone module resolves exactly as the library does', () => {
  const home = tmp('sr-home-');
  const dir = tmp('sr-gen-');
  try {
    claudeCopy(home, 'sterling', '0.18.51');
    const newest = opencodeCopy(home, '5', '0.18.52');
    const file = join(dir, 'gen.mjs');
    writeFileSync(file, `${RESOLVER_IMPORTS}\n${RESOLVER_SOURCE}\nconst f = newestInstalledSterling();\nprocess.stdout.write(JSON.stringify(f));\n`);
    const env = { PATH: process.env.PATH, HOME: home };
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { root: newest, version: '0.18.52', host: 'opencode' });
    assert.deepEqual(JSON.parse(r.stdout), newestInstalledSterling({}, home));
  } finally {
    rm(home, dir);
  }
});
