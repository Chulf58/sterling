import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('TUI bundle: single file, no workspace resolution, exits politely on non-TTY stdout (§11)', () => {
  // Build into a TEMP dir, never over the SHIPPED bundle — merely running the
  // suite must not regenerate a tracked artifact from whatever is in dist/
  // (same class as the hooks live-rebuild, board 3e569411). MTIME, not bytes:
  // an in-place rebuild of a clean tree emits identical output, so a content
  // comparison would pass while the artifact was in fact rewritten.
  const outDir = mkdtempSync(join(tmpdir(), 'sterling-tui-build-'));
  const bundle = join(outDir, 'sterling-tui.mjs');
  const shipped = join(root, 'packages', 'tui', 'bundle', 'sterling-tui.mjs');
  const shippedBefore = existsSync(shipped) ? statSync(shipped).mtimeMs : null;
  try {
    const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-tui.mjs'), '--out-file', bundle], { encoding: 'utf8', cwd: root, timeout: 180_000 });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(
      existsSync(shipped) ? statSync(shipped).mtimeMs : null,
      shippedBefore,
      'the suite must not rebuild the SHIPPED TUI bundle',
    );
    assert.ok(existsSync(bundle));
    const content = readFileSync(bundle, 'utf8');
    assert.ok(!content.includes("from '@sterling/"), 'zero runtime node_modules resolution');

    const run = spawnSync(process.execPath, [bundle], { encoding: 'utf8', cwd: root, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /exiting politely/);

    // smoke mode proves the bundled terminal-kit stack (termconfig glob, static
    // entry rewrite) resolves at runtime — the lazy-require trap regresses here
    const smoke = spawnSync(process.execPath, [bundle, '--store', join(outDir, 'smoke.db')], {
      encoding: 'utf8',
      cwd: root,
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STERLING_TUI_SMOKE: '1' },
    });
    assert.equal(smoke.status, 0, smoke.stderr);
    assert.match(smoke.stderr, /terminal stack loaded/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
