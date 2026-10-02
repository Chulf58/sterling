import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBaseline, compareBaseline, gitTestIntegrity } from '../lib/test-integrity.mjs';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-git-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('test-integrity: frozen baseline detects modification and deletion; clean baseline passes (§9.2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-ti-'));
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), 'test-a-v1');
    writeFileSync(join(dir, 'tests', 'b.test.mjs'), 'test-b-v1');
    const runDir = join(dir, '.sterling', 'runs', 'r-1');
    assert.equal(writeBaseline({ cwd: dir, runDir, phaseId: 'p1', testFiles: ['tests/a.test.mjs', 'tests/b.test.mjs'] }), 2);

    assert.deepEqual(compareBaseline({ cwd: dir, runDir, phaseId: 'p1' }), { baseline_missing: false, modified: [], deleted: [] });
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), 'test-a-WEAKENED');
    rmSync(join(dir, 'tests', 'b.test.mjs'));
    const r = compareBaseline({ cwd: dir, runDir, phaseId: 'p1' });
    assert.deepEqual(r.modified, ['tests/a.test.mjs']);
    assert.deepEqual(r.deleted, ['tests/b.test.mjs']);
    assert.equal(compareBaseline({ cwd: dir, runDir, phaseId: 'p9' }).baseline_missing, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('test-integrity [direct]: vs git HEAD — modified/deleted test files flagged, additions fine, no-git degrades', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'x.test.mjs'), 'v1');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'tests']);

    writeFileSync(join(dir, 'tests', 'x.test.mjs'), 'v2-weakened');
    writeFileSync(join(dir, 'tests', 'new.test.mjs'), 'brand new');
    const ti = gitTestIntegrity({ cwd: dir, testGlobs: ['tests/**'] });
    assert.equal(ti.no_git, false);
    assert.deepEqual(ti.modified, ['tests/x.test.mjs']);
    assert.deepEqual(ti.deleted, []);
  } finally {
    cleanup();
  }
});

test('test-integrity [direct]: a git RENAME of a test file is caught, not slipped (audit finding 21/43)', () => {
  const { dir, cleanup } = makeGitProject();
  try {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    // a test with enough content that a rename+edit stays above git's rename threshold
    writeFileSync(join(dir, 'tests', 'orig.test.mjs'), 'export const cases = [1,2,3,4,5,6,7,8,9,10];\n// assertions below\n'.repeat(3));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'tests']);

    // rename WITH a weakening edit — git reports `R<score>\told\tnew`
    git(dir, ['mv', 'tests/orig.test.mjs', 'tests/renamed.test.mjs']);
    writeFileSync(join(dir, 'tests', 'renamed.test.mjs'), 'export const cases = [1,2,3,4,5,6,7,8,9,10];\n// assertions below\n'.repeat(3) + '// WEAKENED\n');
    git(dir, ['add', '-A']);
    const ti = gitTestIntegrity({ cwd: dir, testGlobs: ['tests/**'] });
    assert.equal(ti.no_git, false);
    assert.deepEqual(ti.modified, ['tests/renamed.test.mjs'], 'the renamed test surfaces as modified (was silently skipped before)');
    assert.deepEqual(ti.deleted, [], 'the old path is not double-counted as a deletion when the new path is a test');
  } finally {
    cleanup();
  }
  const bare = mkdtempSync(join(tmpdir(), 'sterling-nogit-'));
  try {
    assert.equal(gitTestIntegrity({ cwd: bare, testGlobs: ['tests/**'] }).no_git, true);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
