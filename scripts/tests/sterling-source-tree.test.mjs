// The shared Sterling source-tree probe (scripts/lib/sterling-source-tree.mjs): what isSterlingClone
// (handoff-projection) and the post-update sync both use to recognize a Sterling clone by its
// manifest. The manifest and the sentinel script must be regular files that resolve inside the
// directory: a consumer project cannot be classified as a clone by planting a symlink or a
// directory at either path.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainmentError } from '../lib/contained-fs.mjs';
import { isSterlingSourceTree, looksLikeSterlingSourceTree } from '../lib/sterling-source-tree.mjs';
import { isSterlingClone } from '../lib/handoff-projection.mjs';
import { runPostUpdateSteps } from '../lib/post-update-sync.mjs';

const scratch = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

// A dir with the manifest and sentinel as regular files; each can be replaced by `overrides`.
function makeTree({ manifest = JSON.stringify({ name: 'sterling' }), sentinel = true } = {}) {
  const dir = tmp('sterling-source-tree-');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  if (manifest !== null) writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), manifest);
  if (sentinel) writeFileSync(join(dir, 'scripts', 'architecture-projection.mjs'), '');
  return dir;
}

function withSymlinkedManifest() {
  const dir = makeTree({ manifest: null });
  const elsewhere = tmp('sterling-source-tree-target-');
  writeFileSync(join(elsewhere, 'plugin.json'), JSON.stringify({ name: 'sterling' }));
  symlinkSync(join(elsewhere, 'plugin.json'), join(dir, '.claude-plugin', 'plugin.json'));
  return dir;
}

function withDirectorySentinel() {
  const dir = makeTree({ sentinel: false });
  mkdirSync(join(dir, 'scripts', 'architecture-projection.mjs'));
  return dir;
}

test('a manifest named sterling plus the sentinel file is a source tree; a manifest of another name is not; either one missing is not', () => {
  assert.equal(isSterlingSourceTree(makeTree()), true);
  assert.equal(isSterlingSourceTree(makeTree({ manifest: JSON.stringify({ name: 'other' }) })), false);
  assert.equal(isSterlingSourceTree(makeTree({ sentinel: false })), false);
  assert.equal(isSterlingSourceTree(makeTree({ manifest: null })), false);
});

test('a symlinked manifest is refused by the strict probe and reads as not a clone for the lenient one', () => {
  const dir = withSymlinkedManifest();
  assert.throws(() => isSterlingSourceTree(dir), ContainmentError);
  assert.equal(looksLikeSterlingSourceTree(dir), false);
});

test('a sentinel that is a directory is refused by the strict probe and reads as not a clone for the lenient one', () => {
  const dir = withDirectorySentinel();
  assert.throws(() => isSterlingSourceTree(dir), ContainmentError);
  assert.equal(looksLikeSterlingSourceTree(dir), false);
});

test('a malformed or non-object manifest reads as not a clone without throwing; the strict probe keeps throwing the parse error', () => {
  for (const manifest of ['{not json', 'null', '']) {
    const dir = makeTree({ manifest });
    assert.equal(looksLikeSterlingSourceTree(dir), false, `manifest ${JSON.stringify(manifest)}`);
    assert.throws(() => isSterlingSourceTree(dir), (e) => e instanceof SyntaxError || e instanceof TypeError, `strict probe, manifest ${JSON.stringify(manifest)}`);
  }
});

test('isSterlingClone delegates to the probe unchanged: a tree is a clone, a refused path still throws ContainmentError, the running root needs no manifest', () => {
  const other = tmp('sterling-source-tree-root-');
  assert.equal(isSterlingClone(makeTree(), other), true);
  assert.equal(isSterlingClone(makeTree({ sentinel: false }), other), false);
  assert.throws(() => isSterlingClone(withSymlinkedManifest(), other), ContainmentError);
  assert.throws(() => isSterlingClone(withDirectorySentinel(), other), ContainmentError);
  assert.equal(isSterlingClone(other, other), true);
});

test('runPostUpdateSteps: a consumer with a symlinked manifest, a directory sentinel or a malformed manifest still runs stamp-contract and never throws; a real source tree skips it', async () => {
  const root = makeTree();
  const calls = [];
  const runStep = async (r, name, args) => {
    calls.push(`${name} ${args.join(' ')}`);
    return name === 'sync-agents.mjs'
      ? { status: 0, error: null, out: 'up_to_date', tail: '' }
      : { status: 0, error: null, out: 'stamp-contract: 1 already in sync — 1 project(s) processed', tail: '' };
  };
  for (const project of [withSymlinkedManifest(), withDirectorySentinel(), makeTree({ manifest: '{not json' })]) {
    calls.length = 0;
    assert.equal((await runPostUpdateSteps(root, project, runStep)).ok, true, project);
    assert.deepEqual(calls, [`sync-agents.mjs --target ${project}`, `stamp-contract.mjs --apply-inserts --project ${project}`], project);
  }
  const clone = makeTree();
  calls.length = 0;
  assert.equal((await runPostUpdateSteps(root, clone, runStep)).ok, true);
  assert.deepEqual(calls, [`sync-agents.mjs --target ${clone}`]);
});
