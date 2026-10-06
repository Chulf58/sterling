import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_MODES,
  PROJECT_IDENTITY_REL,
  ProjectModeError,
  ProjectIdentityError,
  readProjectMode,
  readProjectIdentity,
  isProjectId,
} from '../index.js';

const ID = '3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-project-'));
  mkdirSync(join(dir, '.sterling'));
  return dir;
}
const withDir = (fn: (dir: string) => void) => {
  const dir = fixture();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const config = (dir: string, text: string) => writeFileSync(join(dir, '.sterling', 'config.json'), text);
const identity = (dir: string, text: string) => writeFileSync(join(dir, '.sterling', 'project.json'), text);

test('readProjectMode: no config, no .sterling and a config without the key are hobby', () => {
  const empty = mkdtempSync(join(tmpdir(), 'sterling-project-empty-'));
  try {
    assert.equal(readProjectMode(empty), 'hobby');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  withDir((dir) => {
    assert.equal(readProjectMode(dir), 'hobby');
    config(dir, JSON.stringify({ project_name: 'x' }));
    assert.equal(readProjectMode(dir), 'hobby');
  });
});

test('readProjectMode: hobby and work are returned as declared; the mode list is the two', () => {
  assert.deepEqual([...PROJECT_MODES], ['hobby', 'work']);
  withDir((dir) => {
    config(dir, JSON.stringify({ mode: 'work' }));
    assert.equal(readProjectMode(dir), 'work');
    config(dir, JSON.stringify({ mode: 'hobby' }));
    assert.equal(readProjectMode(dir), 'hobby');
  });
});

test('readProjectMode: an invalid value names the value; unparseable and non-object configs are refused', () => {
  withDir((dir) => {
    for (const raw of ['Work', '', 'hobbyist', 1, true, null, ['work'], { mode: 'work' }]) {
      config(dir, JSON.stringify({ mode: raw }));
      assert.throws(
        () => readProjectMode(dir),
        (e: unknown) => e instanceof ProjectModeError && e.message.includes(JSON.stringify(raw)) && /'hobby' or 'work'/.test(e.message),
        `mode ${JSON.stringify(raw)} refused`
      );
    }
    config(dir, '{ not json');
    assert.throws(() => readProjectMode(dir), (e: unknown) => e instanceof ProjectModeError && /not valid JSON/.test((e as Error).message));
    for (const text of ['[]', 'null', '"work"']) {
      config(dir, text);
      assert.throws(() => readProjectMode(dir), (e: unknown) => e instanceof ProjectModeError && /not a JSON object/.test((e as Error).message), text);
    }
  });
});

test('readProjectMode: a symlinked config.json or .sterling is refused, never followed', () => {
  withDir((dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'sterling-project-outside-'));
    try {
      writeFileSync(join(outside, 'config.json'), JSON.stringify({ mode: 'work' }));
      symlinkSync(join(outside, 'config.json'), join(dir, '.sterling', 'config.json'));
      assert.throws(() => readProjectMode(dir), (e: unknown) => e instanceof ProjectModeError && /config\.json is a symlink/.test((e as Error).message));
      const other = mkdtempSync(join(tmpdir(), 'sterling-project-linkdir-'));
      try {
        symlinkSync(outside, join(other, '.sterling'));
        assert.throws(() => readProjectMode(other), (e: unknown) => e instanceof ProjectModeError && /\.sterling is a symlink/.test((e as Error).message));
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('readProjectIdentity: absent is null, whatever else is in .sterling', () => {
  const empty = mkdtempSync(join(tmpdir(), 'sterling-project-empty-'));
  try {
    assert.equal(readProjectIdentity(empty), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  withDir((dir) => {
    config(dir, JSON.stringify({ mode: 'work' }));
    assert.equal(readProjectIdentity(dir), null);
  });
});

test('readProjectIdentity: a valid file returns only project_id, extra keys ignored, uppercase accepted', () => {
  withDir((dir) => {
    identity(dir, JSON.stringify({ project_id: ID }));
    assert.deepEqual(readProjectIdentity(dir), { project_id: ID });
    identity(dir, JSON.stringify({ project_id: ID.toUpperCase(), note: 'kept by hand' }));
    assert.deepEqual(readProjectIdentity(dir), { project_id: ID.toUpperCase() });
  });
});

test('readProjectIdentity: an invalid file throws ProjectIdentityError naming the file and the problem', () => {
  withDir((dir) => {
    const cases: [string, RegExp][] = [
      ['{ not json', /not valid JSON/],
      ['[]', /not a JSON object/],
      ['null', /not a JSON object/],
      ['{}', /project_id is undefined/],
      [JSON.stringify({ project_id: '' }), /project_id is ""/],
      [JSON.stringify({ project_id: 7 }), /project_id is 7/],
      [JSON.stringify({ project_id: 'not-a-uuid' }), /"not-a-uuid".*UUID v4/],
      // a UUID that is not version 4, and one with a bad variant nibble
      [JSON.stringify({ project_id: '3f2b8c1e-5a4d-1e6f-9a7b-0c1d2e3f4a5b' }), /UUID v4/],
      [JSON.stringify({ project_id: '3f2b8c1e-5a4d-4e6f-fa7b-0c1d2e3f4a5b' }), /UUID v4/],
      [JSON.stringify({ project_id: ID.replace(/-/g, '') }), /UUID v4/],
    ];
    for (const [text, pattern] of cases) {
      identity(dir, text);
      assert.throws(
        () => readProjectIdentity(dir),
        (e: unknown) => e instanceof ProjectIdentityError && !(e instanceof ProjectModeError) && pattern.test((e as Error).message) && (e as Error).message.includes(PROJECT_IDENTITY_REL),
        text
      );
    }
  });
});

test('readProjectIdentity: a symlinked project.json is refused, never followed', () => {
  withDir((dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'sterling-project-outside-'));
    try {
      writeFileSync(join(outside, 'project.json'), JSON.stringify({ project_id: ID }));
      symlinkSync(join(outside, 'project.json'), join(dir, '.sterling', 'project.json'));
      assert.throws(() => readProjectIdentity(dir), (e: unknown) => e instanceof ProjectIdentityError && /project\.json is a symlink/.test((e as Error).message));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('isProjectId: accepts a UUID v4 and nothing else', () => {
  assert.equal(isProjectId(ID), true);
  for (const bad of [undefined, null, 4, '', 'x', ID + '0', ' ' + ID]) assert.equal(isProjectId(bad), false);
});
