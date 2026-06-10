import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('TUI bundle: single file, no workspace resolution, exits politely on non-TTY stdout (§11)', () => {
  const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-tui.mjs')], { encoding: 'utf8', cwd: root, timeout: 180_000 });
  assert.equal(build.status, 0, build.stderr);
  const bundle = join(root, 'packages', 'tui', 'bundle', 'sterling-tui.mjs');
  assert.ok(existsSync(bundle));
  const content = readFileSync(bundle, 'utf8');
  assert.ok(!content.includes("from '@sterling/"), 'zero runtime node_modules resolution');

  const run = spawnSync(process.execPath, [bundle], { encoding: 'utf8', cwd: root, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /exiting politely/);
});
