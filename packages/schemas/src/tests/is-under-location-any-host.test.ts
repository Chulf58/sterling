// isUnderLocationAnyHost — is one absolute path strictly inside another, with the same
// slash, drive and DrvFs-case folding as sameLocationAnyHost. Init uses it to keep an
// old-clone hint from naming a directory that CONTAINS a live project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnderLocationAnyHost } from '../index.js';

test('a path below the parent is under it, in either host spelling', () => {
  assert.equal(isUnderLocationAnyHost('/home/u/clone/projects/app', '/home/u/clone'), true);
  assert.equal(isUnderLocationAnyHost('/home/u/clone/projects/app/', '/home/u/clone/'), true, 'trailing slashes');
  assert.equal(isUnderLocationAnyHost('C:\\Users\\u\\clone\\app', '/mnt/c/Users/u/clone'), true, 'drive form against DrvFs form');
  assert.equal(isUnderLocationAnyHost('/mnt/c/Users/u/clone/app', 'C:/Users/u/clone'), true);
  assert.equal(isUnderLocationAnyHost('c:/users/U/CLONE/app', '/mnt/c/Users/u/clone'), true, 'DrvFs is case-insensitive');
});

test('the parent itself, a name-prefix sibling and a case-differing non-DrvFs path are not under it', () => {
  assert.equal(isUnderLocationAnyHost('/home/u/clone', '/home/u/clone'), false, 'equal is not strictly under');
  assert.equal(isUnderLocationAnyHost('/home/u/clone/', '/home/u/clone'), false);
  assert.equal(isUnderLocationAnyHost('/a/clone2', '/a/clone'), false, 'only at a segment boundary');
  assert.equal(isUnderLocationAnyHost('/a/clone2/app', '/a/clone'), false);
  assert.equal(isUnderLocationAnyHost('/home/u/Clone/app', '/home/u/clone'), false, 'case is significant off DrvFs');
  assert.equal(isUnderLocationAnyHost('/a', '/a/clone'), false, 'the parent of a path is not under it');
});

test('a relative or empty value is never a location', () => {
  assert.equal(isUnderLocationAnyHost('clone/app', 'clone'), false);
  assert.equal(isUnderLocationAnyHost('', '/a'), false);
  assert.equal(isUnderLocationAnyHost('/a/b', ''), false);
});

test('the filesystem root contains every absolute path', () => {
  assert.equal(isUnderLocationAnyHost('/a/b', '/'), true);
  assert.equal(isUnderLocationAnyHost('/', '/'), false);
});
