import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfigKey } from '../config-writeback.js';

// ===========================================================================
// writeConfigKey serves every System tab config write. It writes a temp file
// with the original's mode, compares the file's bytes with what it read right
// before the rename, and renames; so a concurrent change is refused and a
// failed write leaves the original whole.
// ===========================================================================

function fixture(content = JSON.stringify({ mode: 'work', tdd: { enabled: true } }, null, 2) + '\n') {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-writeback-atomic-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, content);
  return { dir, path, content, files: () => readdirSync(dir).sort() };
}

test('writeConfigKey: a write replaces one key, keeps the rest, and leaves no temp file', () => {
  const f = fixture();
  try {
    writeConfigKey(f.path, 'mode', () => 'hobby');
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), { mode: 'hobby', tdd: { enabled: true } });
    assert.deepEqual(f.files(), ['config.json']);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('writeConfigKey: a concurrent change between the read and the rename is refused, the other writer\'s file stays, and no temp file is left', () => {
  const f = fixture();
  try {
    const concurrent = JSON.stringify({ mode: 'work', tdd: { enabled: true }, overpass: { enabled: true } }, null, 2) + '\n';
    assert.throws(
      () => writeConfigKey(f.path, 'mode', () => 'hobby', { beforeRename: () => writeFileSync(f.path, concurrent) }),
      /config\.json changed on disk while this write was in flight .* nothing was written/,
    );
    assert.equal(readFileSync(f.path, 'utf8'), concurrent, "the concurrent writer's change is not lost");
    assert.deepEqual(f.files(), ['config.json']);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('writeConfigKey: a file removed in the window is refused too', () => {
  const f = fixture();
  try {
    assert.throws(() => writeConfigKey(f.path, 'mode', () => 'hobby', { beforeRename: () => rmSync(f.path) }), /changed on disk/);
    assert.deepEqual(f.files(), []);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('writeConfigKey: a write that fails partway leaves the original file byte-identical and no temp file', () => {
  const f = fixture();
  try {
    assert.throws(
      () => writeConfigKey(f.path, 'mode', () => 'hobby', { writeFile: (p, c) => { writeFileSync(p, c.slice(0, 7)); throw new Error('ENOSPC: no space left'); } }),
      /ENOSPC/,
    );
    assert.equal(readFileSync(f.path, 'utf8'), f.content);
    assert.deepEqual(f.files(), ['config.json']);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('writeConfigKey: the original file mode is kept', () => {
  const f = fixture();
  try {
    chmodSync(f.path, 0o640);
    writeConfigKey(f.path, 'mode', () => 'hobby');
    assert.equal(statSync(f.path).mode & 0o777, 0o640);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('writeConfigKey: an update that throws writes nothing', () => {
  const f = fixture();
  try {
    assert.throws(() => writeConfigKey(f.path, 'mode', () => { throw new Error('nope'); }), /nope/);
    assert.equal(readFileSync(f.path, 'utf8'), f.content);
    assert.deepEqual(f.files(), ['config.json']);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('writeConfigKey: a symlinked config.json is refused; the link and its target are unchanged and no temp file is left', () => {
  const f = fixture();
  try {
    const link = join(f.dir, 'link.json');
    symlinkSync(f.path, link);
    assert.throws(() => writeConfigKey(link, 'mode', () => 'hobby'), /config\.json is a symlink — refusing to write through a link.* Nothing was written/);
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the link is still a link');
    assert.equal(readlinkSync(link), f.path);
    assert.equal(readFileSync(f.path, 'utf8'), f.content, 'the target is unchanged');
    assert.deepEqual(f.files(), ['config.json', 'link.json']);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
