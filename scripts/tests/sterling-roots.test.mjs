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
  STERLING_GIT_SPEC,
  openCodeCacheKey,
  openCodeLoadedSterling,
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

// One comparator for both hosts' code: post-update-sync's compareVersions delegates here, so
// the resolver, the shims and the sync order versions the same way (SemVer 2.0.0 precedence).
test('compareSterlingVersions: SemVer 2.0.0 precedence for prerelease identifiers, build metadata ignored, non-semver throws', () => {
  const cases = [
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0-beta.11', 1],
    ['1.0.0+abc', '1.0.0', 0],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(Math.sign(compareSterlingVersions(a, b)), want, `${a} vs ${b}`);
    assert.equal(Math.sign(compareSterlingVersions(b, a)), -want || 0, `${b} vs ${a}`);
  }
  for (const bad of ['01.0.0', 'v1.0.0', '1.0', 'dev', ' 1.0.0']) {
    assert.throws(() => compareSterlingVersions(bad, '1.0.0'), /not a semver version/, bad);
  }
});

test('post-update-sync orders versions with the resolver comparator', async () => {
  const sync = await import('../lib/post-update-sync.mjs');
  for (const [a, b] of [['1.0.0-beta.2', '1.0.0-beta.11'], ['0.18.9', '0.18.10'], ['1.0.0-rc.1', '1.0.0']]) {
    assert.equal(sync.compareVersions(a, b), Math.sign(compareSterlingVersions(a, b)), `${a} vs ${b}`);
  }
  assert.equal(sync.compareVersions('v1.0.0', '1.0.0'), null, 'the stricter grammar: no v prefix');
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
    assert.ok(oc.includes(`opencode plugin add "${STERLING_GIT_SPEC}"`), oc);
    assert.doesNotMatch(oc, /claude plugin install/);
    assert.match(sterlingNotFoundMessage('claude-code', {}, home), /claude plugin install sterling@sterling/);
  } finally {
    rm(home);
  }
});

test('a Git-spec install (cache key git-<slug>-<sha12>, measured on OpenCode 2.0.21) is found, newest timestamp first', () => {
  const home = tmp('sr-home-');
  try {
    opencodeCopy(home, '1790954287307', '0.18.53', ['git-sterling-85dff39ff2ae']);
    const later = opencodeCopy(home, '1790954332021', '0.18.54', ['git-sterling-85dff39ff2ae']);
    assert.deepEqual(newestInstalledSterling({}, home), { root: later, version: '0.18.54', host: 'opencode' });
  } finally {
    rm(home);
  }
});

test('sterlingUpdateRemedy(opencode) names the spec the global opencode.json configures; a pinned tag or commit is flagged as never updating; no entry keeps the shipped spec', () => {
  const home = tmp('sterling-roots-spec-');
  try {
    const conf = join(home, '.config', 'opencode', 'opencode.json');
    const remedy = () => sterlingUpdateRemedy('opencode', { env: {}, home });
    assert.equal(remedy(), `\`opencode plugin update "${STERLING_GIT_SPEC}"\``, 'no opencode.json: the shipped spec');
    touch(conf, JSON.stringify({ plugins: ['other-plugin'] }));
    assert.equal(remedy(), `\`opencode plugin update "${STERLING_GIT_SPEC}"\``, 'no Sterling entry: the shipped spec');
    touch(conf, JSON.stringify({ plugins: ['x', '@chulf58/sterling@latest'] }));
    assert.equal(remedy(), '`opencode plugin update "@chulf58/sterling@latest"`', 'a registry spec is named as typed');
    touch(conf, JSON.stringify({ plugins: [['github:Chulf58/sterling#semver:>=0.18.0', { some: 'option' }]] }));
    assert.equal(remedy(), `\`opencode plugin update "${STERLING_GIT_SPEC}"\``, 'a tuple entry names its spec');
    touch(conf, JSON.stringify({ plugins: ['github:Chulf58/sterling#v0.18.58'] }));
    assert.match(remedy(), /^`opencode plugin update "github:Chulf58\/sterling#v0\.18\.58"`/);
    assert.match(remedy(), new RegExp(`pinned to #v0\\.18\\.58 and never updates.*${STERLING_GIT_SPEC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    touch(conf, '{\n  // global plugins\n  "plugins": [\n    "other", // trailing comment\n    "github:Chulf58/sterling#v0.18.58",\n  ],\n}\n');
    assert.match(remedy(), /^`opencode plugin update "github:Chulf58\/sterling#v0\.18\.58"`/, 'a JSONC config (comments, trailing commas) is read, not skipped');
    assert.match(remedy(), /pinned to #v0\.18\.58 and never updates/);
    touch(conf, '{ not json');
    const unreadable = remedy();
    assert.ok(unreadable.includes(`could not read ${conf}: `), unreadable);
    assert.ok(unreadable.includes(`the shipped spec`) && unreadable.includes(`"${STERLING_GIT_SPEC}"`), 'the shipped spec is named as the fallback');
  } finally {
    rm(home);
  }
});

test('sterlingUpdateRemedy(opencode): an object entry is read only through its package field; with both an npm and a Git entry the one matching the refused copy\'s cache wins', () => {
  const home = tmp('sterling-roots-kind-');
  try {
    const conf = join(home, '.config', 'opencode', 'opencode.json');
    const remedy = (root) => sterlingUpdateRemedy('opencode', { env: {}, home, root });
    const SHIPPED = `\`opencode plugin update "${STERLING_GIT_SPEC}"\``;
    touch(conf, JSON.stringify({ plugins: [{ path: 'github:Chulf58/sterling#v0.18.58', name: '@chulf58/sterling' }] }));
    assert.equal(remedy(), SHIPPED, 'a path or name field is not the spec');
    touch(conf, JSON.stringify({ plugins: [{ package: '@chulf58/sterling@1.2.3' }] }));
    assert.equal(remedy(), '`opencode plugin update "@chulf58/sterling@1.2.3"`', 'the package field is');
    touch(conf, JSON.stringify({ plugins: ['github:Chulf58/sterling-other', 'x/chulf58/sterling-fork'] }));
    assert.equal(remedy(), SHIPPED, 'a different repo that merely contains the name is not Sterling');

    touch(conf, JSON.stringify({ plugins: ['@chulf58/sterling@latest', 'github:Chulf58/sterling#semver:>=0.19.0'] }));
    const npmRoot = opencodeCopy(home, '1', '1.0.0');
    const gitRoot = opencodeCopy(home, '2', '1.0.0', ['git-github-chulf58-sterling-0123456789ab']);
    assert.equal(remedy(npmRoot), '`opencode plugin update "@chulf58/sterling@latest"`', 'the npm copy takes the npm entry');
    assert.equal(remedy(gitRoot), '`opencode plugin update "github:Chulf58/sterling#semver:>=0.19.0"`', 'the Git copy takes the Git entry');
    assert.equal(remedy(), '`opencode plugin update "@chulf58/sterling@latest"`', 'no refused copy: list order');
    touch(conf, JSON.stringify({ plugins: ['github:Chulf58/sterling#semver:>=0.19.0'] }));
    assert.equal(remedy(npmRoot), '`opencode plugin update "github:Chulf58/sterling#semver:>=0.19.0"`', 'only one kind configured: that one');
  } finally {
    rm(home);
  }
});

test('sterlingUpdateRemedy(opencode): only a tag or a commit is flagged as never updating; a branch ref is not; a spec with shell-special characters is not echoed', () => {
  const home = tmp('sterling-roots-pin-');
  try {
    const conf = join(home, '.config', 'opencode', 'opencode.json');
    const remedy = () => sterlingUpdateRemedy('opencode', { env: {}, home });
    for (const ref of ['v0.18.58', '0.18.58', 'abc1234', '0123456789abcdef0123456789abcdef01234567']) {
      touch(conf, JSON.stringify({ plugins: [`github:Chulf58/sterling#${ref}`] }));
      assert.match(remedy(), new RegExp(`pinned to #${ref} and never updates`), ref);
    }
    for (const ref of ['main', 'opencode-release', 'semver:>=0.18.0']) {
      touch(conf, JSON.stringify({ plugins: [`github:Chulf58/sterling#${ref}`] }));
      assert.match(remedy(), new RegExp(`^\`opencode plugin update "github:Chulf58/sterling#${ref}"\``), ref);
      assert.doesNotMatch(remedy(), /never updates/, `#${ref} is not a measured pin`);
    }
    for (const bad of ['github:Chulf58/sterling#v1"; echo hi; "', 'github:Chulf58/sterling#$(id)', 'github:Chulf58/sterling#`id`']) {
      touch(conf, JSON.stringify({ plugins: [bad] }));
      const out = remedy();
      assert.ok(out.includes(`"${STERLING_GIT_SPEC}"`), 'the shipped spec is printed');
      assert.match(out, /not echoed/);
      assert.ok(!out.includes('echo hi') && !out.includes('$(id)') && !out.includes('`id`'), out);
    }
  } finally {
    rm(home);
  }
});

test('remedies per host; an unknown host names both; a misspelt host is a loud error', () => {
  assert.equal(sterlingInstallRemedy('claude-code'), 'claude plugin install sterling@sterling');
  assert.equal(STERLING_GIT_SPEC, 'github:Chulf58/sterling#semver:>=0.18.0', 'a range with no upper bound, so 0.19 and 1.0 are found too');
  assert.equal(sterlingInstallRemedy('opencode'), `opencode plugin add "${STERLING_GIT_SPEC}"`, 'the inlined RESOLVER_SOURCE literal matches the exported spec, quoted for the shell');
  assert.ok(sterlingInstallRemedy(null).includes(`opencode plugin add "${STERLING_GIT_SPEC}" for OpenCode`));
  assert.match(sterlingInstallRemedy(null), /^claude plugin install sterling@sterling for Claude Code, or /);
  const home = tmp('sterling-roots-remedy-');
  try {
    const hermetic = { env: {}, home };
    assert.match(sterlingUpdateRemedy('claude-code', hermetic), /\/plugin .*claude plugin update sterling@/);
    assert.equal(sterlingUpdateRemedy('opencode', hermetic), `\`opencode plugin update "${STERLING_GIT_SPEC}"\``, 'plugin update takes the target as configured in opencode.json');
    assert.match(sterlingUpdateRemedy(null, hermetic), /claude plugin update.*opencode plugin update/);
    assert.throws(() => sterlingUpdateRemedy('vscode', hermetic), /unknown host/);
  } finally {
    rm(home);
  }
  assert.throws(() => sterlingInstallRemedy('claude'), /unknown host/);
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

// Sol review of GitHub #202 (CRITICAL): the copy OpenCode loads is the newest install
// GENERATION (numeric timestamp directory) of the spec its global config lists, mirroring
// OpenCode v2.1.2 packages/util/src/npm.ts key()/current(); not the highest version in the cache.
const ocConfig = (home, plugins) => touch(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ plugins }));
const gitCopy = (home, ts, version, key = 'git-sterling-8c334bb56af9') => {
  const root = join(npmCache(home), key, ts, 'node_modules', '@chulf58', 'sterling');
  touch(join(root, 'package.json'), JSON.stringify({ name: '@chulf58/sterling', version }));
  return root;
};

test('openCodeCacheKey reproduces OpenCode\'s cache key: the shipped Git spec is git-sterling-8c334bb56af9 (the directory measured on this machine); a bare registry name is @latest', () => {
  assert.equal(openCodeCacheKey(STERLING_GIT_SPEC, 'git'), 'git-sterling-8c334bb56af9');
  assert.match(openCodeCacheKey('git+https://github.com/Chulf58/sterling.git#v1', 'git'), /^git-sterling-[0-9a-f]{12}$/);
  assert.equal(openCodeCacheKey('@chulf58/sterling', 'npm'), '@chulf58/sterling@latest');
  assert.equal(openCodeCacheKey('@chulf58/sterling@^0.19', 'npm'), '@chulf58/sterling@^0.19');
});

// Sol re-check (MEDIUM): OpenCode keys a registry spec by npm-package-arg's rawSpec, which
// turns an empty suffix into '*' and keeps everything else as typed (probed with
// npm-package-arg 13.0.2 and 4.28.0); an alias or Git spec after '@' is keyed as the spec.
test('openCodeCacheKey mirrors npm-package-arg for registry specs: "@chulf58/sterling@" is @*, whitespace and other suffixes stay as typed', () => {
  for (const [spec, key] of [
    ['@chulf58/sterling@', '@chulf58/sterling@*'],
    ['@chulf58/sterling@*', '@chulf58/sterling@*'],
    ['@chulf58/sterling@latest', '@chulf58/sterling@latest'],
    ['@chulf58/sterling@ ^0.19 ', '@chulf58/sterling@ ^0.19 '],
    ['@chulf58/sterling@>=0.18.0 <1', '@chulf58/sterling@>=0.18.0 <1'],
    ['@chulf58/sterling@v0.19.1', '@chulf58/sterling@v0.19.1'],
    ['@chulf58/sterling@npm:foo@1', '@chulf58/sterling@npm:foo@1'],
  ]) assert.equal(openCodeCacheKey(spec, 'npm'), key, spec);
  const home = tmp('sterling-roots-oc-');
  try {
    const root = opencodeCopy(home, '1792750000000', '0.19.113', ['@chulf58', 'sterling@*']);
    ocConfig(home, ['@chulf58/sterling@']);
    assert.equal(openCodeLoadedSterling({}, home).copies[0].root, root, 'the installed copy is found, not reported missing');
  } finally {
    rm(home);
  }
});

test('openCodeLoadedSterling, one spec: the newest generation wins when it holds the OLDER version (a rollback); a staging directory is never it', () => {
  const home = tmp('sterling-roots-oc-');
  try {
    ocConfig(home, [STERLING_GIT_SPEC]);
    gitCopy(home, '1792747812087', '0.19.116');
    const rolledBack = gitCopy(home, '1792750000000', '0.19.113');
    touch(join(npmCache(home), 'git-sterling-8c334bb56af9', '.staging-1792760000000-abc', 'node_modules', '@chulf58', 'sterling', 'package.json'), JSON.stringify({ version: '0.19.120' }));
    const loaded = openCodeLoadedSterling({}, home);
    assert.equal(loaded.copies.length, 1);
    assert.equal(loaded.copies[0].root, rolledBack);
    assert.equal(loaded.copies[0].version, '0.19.113');
    assert.notEqual(newestInstalledSterling({}, home).version, '0.19.113', 'CONTROL: the highest-version rule picks another copy');
  } finally {
    rm(home);
  }
});

// Board 1199c770: OpenCode unpacks an install into <spec dir>/.staging-<ts>-<uuid>/ first. The depth-4
// walk found a copy there, so the newest-version rule could pick one that is half-finished or already moved.
test('scanInstalledSterling skips OpenCode .staging-* folders: a higher version inside one is never counted, whatever the folder order', () => {
  const home = tmp('sterling-roots-oc-');
  try {
    const real = gitCopy(home, '1792750000000', '0.19.113');
    touch(join(npmCache(home), 'git-sterling-8c334bb56af9', '.staging-1792760000000-abc', 'node_modules', '@chulf58', 'sterling', 'package.json'), JSON.stringify({ version: '0.19.120' }));
    touch(join(npmCache(home), 'git-sterling-8c334bb56af9', '.staging-1792760000001-def', 'node_modules', '@chulf58', 'sterling', 'package.json'), JSON.stringify({ version: '0.19.121' }));
    const scan = scanInstalledSterling({}, home);
    assert.deepEqual(scan.copies, [{ root: real, version: '0.19.113', host: 'opencode' }]);
    assert.equal(scan.skipped.length, 0, 'a staging folder is not a skipped copy either');
    assert.deepEqual(newestInstalledSterling({}, home), { root: real, version: '0.19.113', host: 'opencode' });
  } finally {
    rm(home);
  }
});

test('openCodeLoadedSterling, across specs: the configured spec\'s copy wins over a newer version under a spec the config no longer lists; no config is no copies; a broken config is an error', () => {
  const home = tmp('sterling-roots-oc-');
  try {
    assert.deepEqual(openCodeLoadedSterling({}, home).copies, [], 'no opencode.json');
    const configured = gitCopy(home, '1792750000000', '0.19.113');
    opencodeCopy(home, '1792760000000', '0.19.116');
    ocConfig(home, ['@nemlig/overpass-gateway@1.14.3', [STERLING_GIT_SPEC, {}]]);
    const loaded = openCodeLoadedSterling({}, home);
    assert.deepEqual(loaded.copies.map((c) => [c.spec, c.root, c.version]), [[STERLING_GIT_SPEC, configured, '0.19.113']]);
    ocConfig(home, ['@chulf58/sterling', STERLING_GIT_SPEC]);
    assert.deepEqual(openCodeLoadedSterling({}, home).copies.map((c) => c.version), ['0.19.116', '0.19.113'], 'each listed spec, in list order');
    ocConfig(home, ['git+https://github.com/Chulf58/sterling.git#v1']);
    const missing = openCodeLoadedSterling({}, home).copies[0];
    assert.equal(missing.root, null, 'a listed spec with nothing installed has no root');
    touch(join(home, '.config', 'opencode', 'opencode.json'), '{ "plugins": [ ');
    assert.ok(openCodeLoadedSterling({}, home).error, 'an unparseable config is an error, never no copies');
  } finally {
    rm(home);
  }
});
