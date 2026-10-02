// architecture-projection.mjs and rulings-projection.mjs register their own
// output in config.generated_projections, the way handoff-projection.mjs does
// (decision gap-hunt-2026-09-28-rulings, item 1: "Fix it for good" — the key
// went missing in this clone and every merge stopped on architecture.md and
// rulings.md reconcile items). Settlement, H10 and direct-merge all read that
// one list, so a regenerate is enough to put it right again.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function makeProject(configText) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-proj-register-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), configText);
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(script, dir) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', script)], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
  assert.equal(r.status, 0, `${script} exits 0: ${r.stderr}`);
  return r;
}

const readConfig = (dir) => readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');

for (const [script, file] of [
  ['architecture-projection.mjs', 'architecture.md'],
  ['rulings-projection.mjs', 'rulings.md'],
]) {
  test(`${script}: registers ${file} in config.generated_projections, keeps every other key and entry, and is idempotent`, () => {
    const { dir, cleanup } = makeProject(JSON.stringify({ mode: 'hobby', generated_projections: ['docs/other.md'] }, null, 2) + '\n');
    try {
      run(script, dir);
      const first = readConfig(dir);
      const parsed = JSON.parse(first);
      assert.deepEqual(parsed.generated_projections, ['docs/other.md', file], 'appended once, existing entry kept in place');
      assert.equal(parsed.mode, 'hobby', 'unrelated keys survive');
      assert.ok(first.endsWith('\n'), 'the trailing newline is kept');
      run(script, dir);
      assert.equal(readConfig(dir), first, 'a second run changes nothing');
    } finally {
      cleanup();
    }
  });

  test(`${script}: a config with no generated_projections key gets one`, () => {
    const { dir, cleanup } = makeProject('{}');
    try {
      run(script, dir);
      assert.deepEqual(JSON.parse(readConfig(dir)).generated_projections, [file]);
    } finally {
      cleanup();
    }
  });
}

for (const script of ['architecture-projection.mjs', 'rulings-projection.mjs']) {
  // Guard, not a red-first pin: openProject's resolveStoreWritePath already
  // refuses a config symlinked outside the project before registration runs.
  // This keeps that true now that registration writes through writeContained
  // (Opus review LOW-5), which refuses a symlink leaf on its own as well.
  test(`${script}: a symlinked .sterling/config.json fails loudly and its target outside the project is left untouched`, (t) => {
    const { dir, cleanup } = makeProject('{}');
    const outside = mkdtempSync(join(tmpdir(), 'sterling-proj-register-outside-'));
    try {
      const target = join(outside, 'config.json');
      writeFileSync(target, '{}');
      rmSync(join(dir, '.sterling', 'config.json'));
      try {
        symlinkSync(target, join(dir, '.sterling', 'config.json'));
      } catch {
        t.skip('symlinks unavailable on this filesystem');
        return;
      }
      const r = spawnSync(process.execPath, [join(root, 'scripts', script)], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
      assert.notEqual(r.status, 0, 'a symlinked config must fail loudly, not be written through');
      assert.match(r.stderr, /symlink/i, 'the refusal names the symlink');
      assert.equal(readFileSync(target, 'utf8'), '{}', 'the file outside the project is never written');
    } finally {
      cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

test('both scripts together leave exactly the two root projections registered', () => {
  const { dir, cleanup } = makeProject('{}');
  try {
    run('architecture-projection.mjs', dir);
    run('rulings-projection.mjs', dir);
    assert.deepEqual(JSON.parse(readConfig(dir)).generated_projections, ['architecture.md', 'rulings.md']);
  } finally {
    cleanup();
  }
});
