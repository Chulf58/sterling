// isInstalledCopy (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// design point D): a plugin root without `.git` is a /plugin-installed snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInstalledCopy } from '../lib/installed-copy.mjs';

test('no .git at the root: an installed copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-installed-'));
  try {
    assert.equal(isInstalledCopy(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a .git directory (clone) or a .git file (worktree): not an installed copy', () => {
  const clone = mkdtempSync(join(tmpdir(), 'sterling-clone-'));
  const worktree = mkdtempSync(join(tmpdir(), 'sterling-worktree-'));
  try {
    mkdirSync(join(clone, '.git'));
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    assert.equal(isInstalledCopy(clone), false);
    assert.equal(isInstalledCopy(worktree), false);
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test('a missing or empty root is a loud TypeError, never a silent "installed"', () => {
  assert.throws(() => isInstalledCopy(null), TypeError);
  assert.throws(() => isInstalledCopy(''), TypeError);
});

test('a root under <CLAUDE_CONFIG_DIR>/plugins/cache/ is an installed copy EVEN WITH a .git (second, independent signal)', () => {
  // The no-.git premise is unmeasured for a real /plugin install, so the cache
  // location is checked too: either signal alone says "installed".
  const config = mkdtempSync(join(tmpdir(), 'sterling-config-'));
  try {
    const cached = join(config, 'plugins', 'cache', 'mkt', 'sterling', '1.0.0');
    mkdirSync(join(cached, '.git'), { recursive: true });
    assert.equal(isInstalledCopy(cached, { env: { CLAUDE_CONFIG_DIR: config } }), true);
    // CONTROL: the same .git-bearing shape outside the cache is a clone
    const outside = join(config, 'elsewhere', 'sterling');
    mkdirSync(join(outside, '.git'), { recursive: true });
    assert.equal(isInstalledCopy(outside, { env: { CLAUDE_CONFIG_DIR: config } }), false);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test('without CLAUDE_CONFIG_DIR the cache is <home>/.claude/plugins/cache, and a SYMLINK into it resolves by realpath', () => {
  const home = mkdtempSync(join(tmpdir(), 'sterling-home-'));
  try {
    const cached = join(home, '.claude', 'plugins', 'cache', 'mkt', 'sterling', '2.0.0');
    mkdirSync(join(cached, '.git'), { recursive: true });
    assert.equal(isInstalledCopy(cached, { env: {}, home }), true);
    const link = join(home, 'link-to-install');
    symlinkSync(cached, link, 'dir');
    assert.equal(isInstalledCopy(link, { env: {}, home }), true, 'a path reaching the cache through a symlink is still under it');
    assert.equal(isInstalledCopy(cached, { env: { CLAUDE_CONFIG_DIR: join(home, 'other') }, home }), false, 'CLAUDE_CONFIG_DIR replaces ~/.claude, it does not add to it');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a sibling directory whose name merely STARTS with "cache" is not under the cache', () => {
  const config = mkdtempSync(join(tmpdir(), 'sterling-config-'));
  try {
    const lookalike = join(config, 'plugins', 'cache-old', 'sterling');
    mkdirSync(join(lookalike, '.git'), { recursive: true });
    assert.equal(isInstalledCopy(lookalike, { env: { CLAUDE_CONFIG_DIR: config } }), false);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

test('a root under OpenCode\'s npm cache (<XDG_CACHE_HOME or ~/.cache>/opencode/npm) is an installed copy EVEN WITH a .git', () => {
  const home = mkdtempSync(join(tmpdir(), 'sterling-home-'));
  try {
    const pkg = join('@chulf58', 'sterling@latest', '1759500000000', 'node_modules', '@chulf58', 'sterling');
    const cached = join(home, '.cache', 'opencode', 'npm', pkg);
    mkdirSync(join(cached, '.git'), { recursive: true });
    assert.equal(isInstalledCopy(cached, { env: {}, home }), true);
    const xdg = join(home, 'xdg-cache');
    const underXdg = join(xdg, 'opencode', 'npm', pkg);
    mkdirSync(join(underXdg, '.git'), { recursive: true });
    assert.equal(isInstalledCopy(underXdg, { env: { XDG_CACHE_HOME: xdg }, home }), true, 'XDG_CACHE_HOME moves the root');
    assert.equal(isInstalledCopy(cached, { env: { XDG_CACHE_HOME: xdg }, home }), false, 'XDG_CACHE_HOME replaces ~/.cache, it does not add to it');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
