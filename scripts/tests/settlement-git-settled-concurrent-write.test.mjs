// writeGitSettled must survive two processes settling at once. H10 and the
// OpenCode server plugin can both settle the same project; with one fixed
// temp name (`git-settled.json.tmp`) the second writer's rename finds the
// temp already renamed away (ENOENT) or publishes the other writer's bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GIT_SETTLED_REL, readGitSettled, writeGitSettled } from '../hooks/lib/settlement.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const settlementUrl = pathToFileURL(join(here, '..', 'hooks', 'lib', 'settlement.mjs')).href;

function writer(root, tag, rounds) {
  const code = `
    const { writeGitSettled } = await import(${JSON.stringify(settlementUrl)});
    let errors = 0; let first = '';
    for (let i = 0; i < ${rounds}; i++) {
      try { writeGitSettled(${JSON.stringify(root)}, { sha: '${tag}' + i, dirty: { ['f${tag}']: String(i) }, at: new Date().toISOString() }); }
      catch (e) { errors++; if (!first) first = e.code + ' ' + e.message; }
    }
    process.stdout.write(JSON.stringify({ errors, first }));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve(JSON.parse(out)) : reject(new Error(`writer ${tag} exited ${status}`))));
  });
}

test('concurrent writeGitSettled from four processes never fails and always publishes a whole snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sterling-git-settled-race-'));
  try {
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((tag) => writer(root, tag, 250)));
    for (const r of results) assert.equal(r.errors, 0, `a writer failed: ${r.first}`);
    const snap = readGitSettled(root);
    assert.ok(snap, 'the published snapshot parses');
    assert.match(snap.sha, /^[abcd]\d+$/);
    const leftovers = readdirSync(join(root, dirname(GIT_SETTLED_REL))).filter((f) => f !== 'git-settled.json');
    assert.deepEqual(leftovers, [], 'no temp file is left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeGitSettled publishes the snapshot and leaves no temp file', () => {
  const root = mkdtempSync(join(tmpdir(), 'sterling-git-settled-tmp-'));
  try {
    writeGitSettled(root, { sha: 'x', dirty: {}, at: 'now' });
    assert.deepEqual(JSON.parse(readFileSync(join(root, GIT_SETTLED_REL), 'utf8')), { sha: 'x', dirty: {}, at: 'now' });
    assert.deepEqual(readdirSync(join(root, dirname(GIT_SETTLED_REL))), ['git-settled.json'], 'the temp file was renamed, not left beside it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
