// isInstalledCopy (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone,
// design point D): a plugin root without `.git` is a /plugin-installed snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
