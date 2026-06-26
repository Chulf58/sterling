import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWslPath, backupPathForRuntime } from '../lib/wsl-path.mjs';

test('toWslPath: Windows drive paths -> /mnt form (the r-dd88 backup_path bug)', () => {
  assert.equal(toWslPath('C:/Users/cuj/.sterling-backups/sterling'), '/mnt/c/Users/cuj/.sterling-backups/sterling');
  assert.equal(toWslPath('C:\\Users\\cuj\\.sterling-backups\\sterling'), '/mnt/c/Users/cuj/.sterling-backups/sterling');
  assert.equal(toWslPath('D:\\a/b\\c'), '/mnt/d/a/b/c'); // mixed separators
  assert.equal(toWslPath('E:/X'), '/mnt/e/X'); // drive letter lowercased, rest preserved
  assert.equal(toWslPath('C:/'), '/mnt/c/'); // bare drive root
  assert.equal(toWslPath('C:\\'), '/mnt/c/');
});

test('toWslPath: non-drive paths pass through unchanged', () => {
  assert.equal(toWslPath('/mnt/c/Users/cuj/x'), '/mnt/c/Users/cuj/x'); // already POSIX /mnt form
  assert.equal(toWslPath('/home/cuj/.sterling-backups'), '/home/cuj/.sterling-backups');
  assert.equal(toWslPath('backups'), 'backups'); // relative
  assert.equal(toWslPath('./rel/path'), './rel/path');
  assert.equal(toWslPath(''), '');
  assert.equal(toWslPath(undefined), undefined); // non-string guard
  assert.equal(toWslPath(null), null);
});

test('toWslPath: a drive letter without a path separator is left alone (not a usable drive path)', () => {
  assert.equal(toWslPath('C:foo'), 'C:foo'); // drive-relative, malformed for our purposes
});

test('backupPathForRuntime: translates under WSL/Linux, leaves drive paths on native Windows', () => {
  if (process.platform === 'win32') {
    assert.equal(backupPathForRuntime('C:/Users/cuj/x'), 'C:/Users/cuj/x', 'native Windows leaves the drive path');
  } else {
    // the WSL/Linux case — where dispose-run realistically runs
    assert.equal(backupPathForRuntime('C:/Users/cuj/x'), '/mnt/c/Users/cuj/x', 'WSL rewrites the drive path');
    assert.equal(backupPathForRuntime('/mnt/c/Users/cuj/x'), '/mnt/c/Users/cuj/x', 'already-POSIX passes through');
    assert.equal(backupPathForRuntime('backups'), 'backups', 'relative passes through (resolved against the project)');
  }
});
