// scripts/lib/version-only.mjs — the ONE version-only proof shared by
// direct-merge and H10 (decision gap-hunt-2026-09-28-rulings, items 4+5).
// Lockfile-aware: package-lock.json may move its 2 version lines (top-level
// and packages[""]); a real dependency edit still counts as a change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVersionOnlyText, isVersionOnlyBetweenCommits, isVersionOnlyInWorkingTree, VERSION_ONLY_CANDIDATES } from '../lib/version-only.mjs';

const pkg = (v, extra = {}) => JSON.stringify({ name: 'fixture', version: v, ...extra }, null, 2) + '\n';
function lock(v, { depVersion = '1.0.0', depIntegrity = 'sha512-aaa', workspaceVersion = '0.0.1' } = {}) {
  return (
    JSON.stringify(
      {
        name: 'fixture',
        version: v,
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'fixture', version: v, workspaces: ['packages/*'] },
          'node_modules/dep': { version: depVersion, resolved: 'https://registry.example/dep.tgz', integrity: depIntegrity },
          'packages/ws': { name: '@fixture/ws', version: workspaceVersion },
        },
      },
      null,
      2
    ) + '\n'
  );
}

test('candidates: package.json, plugin.json and package-lock.json', () => {
  assert.deepEqual([...VERSION_ONLY_CANDIDATES].sort(), ['.claude-plugin/plugin.json', 'package-lock.json', 'package.json']);
});

test('manifest: a lone version-line bump qualifies; an added field, a CRLF conversion or an unchanged version does not', () => {
  assert.equal(isVersionOnlyText('package.json', pkg('0.1.0'), pkg('0.1.1')), true);
  assert.equal(isVersionOnlyText('.claude-plugin/plugin.json', pkg('0.1.0'), pkg('0.1.1')), true);
  assert.equal(isVersionOnlyText('package.json', pkg('0.1.0'), pkg('0.1.1', { private: true })), false, 'an added field is a real change');
  assert.equal(isVersionOnlyText('package.json', pkg('0.1.0'), pkg('0.1.1').replace(/\n/g, '\r\n')), false, 'a CRLF conversion is exact-byte different');
  assert.equal(isVersionOnlyText('package.json', pkg('0.1.0'), pkg('0.1.0')), false, 'no version move, nothing to prove');
  assert.equal(isVersionOnlyText('src/other.json', pkg('0.1.0'), pkg('0.1.1')), false, 'only the named candidates qualify');
});

test('lockfile: the 2 version lines (top-level and packages[""]) moving together qualify', () => {
  assert.equal(isVersionOnlyText('package-lock.json', lock('0.1.0'), lock('0.1.1')), true);
});

test('lockfile: a real dependency edit alongside the bump still counts as a change', () => {
  assert.equal(isVersionOnlyText('package-lock.json', lock('0.1.0'), lock('0.1.1', { depVersion: '1.0.1', depIntegrity: 'sha512-bbb' })), false);
});

test('lockfile: a dependency or workspace version line that happens to equal the root version cannot ride along as a version line', () => {
  // Only the dependency/workspace version line moves 0.1.0 -> 0.1.1 besides the
  // root — 2 differing lines, all version-shaped, but not the ALLOWED two.
  const base = lock('0.1.0', { workspaceVersion: '0.1.0' });
  const tip = lock('0.1.0', { workspaceVersion: '0.1.1' }).replace('"version": "0.1.0",\n  "lockfileVersion"', '"version": "0.1.1",\n  "lockfileVersion"');
  assert.equal(isVersionOnlyText('package-lock.json', base, tip), false);
  // three moved version lines exceed the lockfile's two
  assert.equal(isVersionOnlyText('package-lock.json', lock('0.1.0', { workspaceVersion: '0.1.0' }), lock('0.1.1', { workspaceVersion: '0.1.1' })), false);
});

test('lockfile: the manifests still allow only ONE moved line', () => {
  const base = JSON.stringify({ name: 'f', version: '0.1.0', nested: { version: '0.1.0' } }, null, 2);
  const tip = JSON.stringify({ name: 'f', version: '0.1.1', nested: { version: '0.1.1' } }, null, 2);
  assert.equal(isVersionOnlyText('package.json', base, tip), false);
});

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-version-only-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('between commits: a lockfile + manifest bump qualifies; a dependency edit and an absent base do not', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'package.json'), pkg('0.1.0'));
    writeFileSync(join(dir, 'package-lock.json'), lock('0.1.0'));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'package.json'), pkg('0.1.1'));
    writeFileSync(join(dir, 'package-lock.json'), lock('0.1.1'));
    writeFileSync(join(dir, 'new.json'), pkg('0.1.1'));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump']);
    const bump = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(isVersionOnlyBetweenCommits(dir, base, bump, 'package.json'), true);
    assert.equal(isVersionOnlyBetweenCommits(dir, base, bump, 'package-lock.json'), true);
    writeFileSync(join(dir, 'package-lock.json'), lock('0.1.2', { depVersion: '2.0.0', depIntegrity: 'sha512-ccc' }));
    writeFileSync(join(dir, 'package.json'), pkg('0.1.2'));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'bump + dep']);
    const dep = git(dir, ['rev-parse', 'HEAD']);
    assert.equal(isVersionOnlyBetweenCommits(dir, bump, dep, 'package-lock.json'), false, 'a dependency edit counts');
    assert.equal(isVersionOnlyBetweenCommits(dir, bump, dep, 'package.json'), true);
    assert.equal(isVersionOnlyBetweenCommits(dir, base, bump, 'new.json'), false);
  } finally {
    cleanup();
  }
});

test('working tree: a bump vs the base commit qualifies; a dependency edit, a missing file or a symlink does not', () => {
  const { dir, cleanup } = makeRepo();
  try {
    writeFileSync(join(dir, 'package.json'), pkg('0.1.0'));
    writeFileSync(join(dir, 'package-lock.json'), lock('0.1.0'));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'package.json'), pkg('0.1.1'));
    writeFileSync(join(dir, 'package-lock.json'), lock('0.1.1'));
    assert.equal(isVersionOnlyInWorkingTree(dir, base, 'package.json'), true);
    assert.equal(isVersionOnlyInWorkingTree(dir, base, 'package-lock.json'), true);
    assert.equal(isVersionOnlyInWorkingTree(dir, null, 'package.json'), false, 'no base, no proof');
    writeFileSync(join(dir, 'package-lock.json'), lock('0.1.1', { depVersion: '1.0.1', depIntegrity: 'sha512-bbb' }));
    assert.equal(isVersionOnlyInWorkingTree(dir, base, 'package-lock.json'), false);
    rmSync(join(dir, 'package-lock.json'));
    assert.equal(isVersionOnlyInWorkingTree(dir, base, 'package-lock.json'), false);
    mkdirSync(join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'elsewhere', 'p.json'), pkg('0.1.1'));
    rmSync(join(dir, 'package.json'));
    let linked = true;
    try {
      symlinkSync(join(dir, 'elsewhere', 'p.json'), join(dir, 'package.json'));
    } catch {
      linked = false; // symlinks unavailable on this filesystem: nothing to prove here
    }
    if (linked) assert.equal(isVersionOnlyInWorkingTree(dir, base, 'package.json'), false);
  } finally {
    cleanup();
  }
});
