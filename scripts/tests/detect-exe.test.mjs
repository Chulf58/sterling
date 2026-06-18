import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRunnable } from '../lib/detect-exe.mjs';

test('pickRunnable: a real .exe wins over an extensionless shim listed first (the claude-shim BAD_EXE_FORMAT bug)', () => {
  // node distributions ship `claude`, `claude.cmd`, `claude.ps1` side by side;
  // with that dir leading PATH, `where claude` lists the bare shim FIRST.
  const out = [
    'C:\\Users\\cuj\\node\\claude',
    'C:\\Users\\cuj\\node\\claude.cmd',
    'C:\\Users\\cuj\\node\\claude.ps1',
    'C:\\Users\\cuj\\.local\\bin\\claude.exe',
  ].join('\r\n');
  assert.equal(pickRunnable(out), 'C:\\Users\\cuj\\.local\\bin\\claude.exe', 'the .exe wins over shim/.cmd/.ps1');
});

test('pickRunnable: falls to .cmd/.bat when there is no .exe — never the shim or .ps1', () => {
  assert.equal(pickRunnable('C:\\x\\tool\r\nC:\\x\\tool.ps1\r\nC:\\x\\tool.cmd'), 'C:\\x\\tool.cmd', '.cmd chosen; shim + .ps1 skipped');
  assert.equal(pickRunnable('C:\\x\\tool.bat'), 'C:\\x\\tool.bat');
});

test('pickRunnable: only shim/.ps1 (or empty) → undefined, so the caller falls back to the canonical path', () => {
  assert.equal(pickRunnable('C:\\x\\claude\r\nC:\\x\\claude.ps1'), undefined, 'extensionless + .ps1 only → undefined');
  assert.equal(pickRunnable(''), undefined);
  assert.equal(pickRunnable(undefined), undefined);
});

test('pickRunnable: PATH order is honoured within the .exe tier (first .exe wins)', () => {
  assert.equal(pickRunnable('C:\\a\\wt.exe\r\nC:\\b\\wt.exe'), 'C:\\a\\wt.exe');
});
