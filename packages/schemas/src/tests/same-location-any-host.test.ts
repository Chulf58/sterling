// sameLocationAnyHost — one location, two host spellings (Dome Farmer issue
// entry 454; user ruling 2026-09-28 "Code: self-root = own"). A record whose
// working_tree names THIS project's own root must count as the project itself,
// whether the root is spelled in Windows drive form ('C:/Users/x') or in its
// WSL DrvFs form ('/mnt/c/Users/x'). A genuinely foreign tree — another
// absolute path, or a symbolic name such as a branch — must never match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameLocationAnyHost } from '../index.js';

const ROOT = '/mnt/c/Users/chulf/Dome Farmer';

test('a drive-form spelling of a /mnt/<d> root is the same location', () => {
  assert.equal(sameLocationAnyHost('C:/Users/chulf/Dome Farmer', ROOT), true);
  assert.equal(sameLocationAnyHost('C:\\Users\\chulf\\Dome Farmer', ROOT), true);
  assert.equal(sameLocationAnyHost(ROOT, 'C:/Users/chulf/Dome Farmer'), true, 'symmetric');
});

test('trailing slashes and DrvFs letter case do not distinguish the location', () => {
  assert.equal(sameLocationAnyHost('C:/Users/chulf/Dome Farmer/', ROOT), true);
  assert.equal(sameLocationAnyHost(`${ROOT}/`, ROOT), true);
  assert.equal(sameLocationAnyHost('c:/users/CHULF/dome farmer', ROOT), true, 'NTFS/DrvFs is case-insensitive');
  assert.equal(sameLocationAnyHost('/mnt/C/Users/chulf/dome farmer', ROOT), true);
  assert.equal(sameLocationAnyHost('C:/', '/mnt/c'), true, 'drive root');
});

test('case stays significant off DrvFs (ext4 is case-sensitive)', () => {
  assert.equal(sameLocationAnyHost('/home/u/Repo', '/home/u/Repo/'), true);
  assert.equal(sameLocationAnyHost('/home/u/Repo', '/home/u/repo'), false);
});

test('a foreign tree never matches', () => {
  assert.equal(sameLocationAnyHost('C:/Users/chulf/Comsoft', ROOT), false, 'different directory');
  assert.equal(sameLocationAnyHost('D:/Users/chulf/Dome Farmer', ROOT), false, 'different drive');
  assert.equal(sameLocationAnyHost('C:/Users/chulf/Dome Farmer/sub', ROOT), false, 'a subdirectory is not the root');
  assert.equal(sameLocationAnyHost('chore/retire-knowledge-skills', ROOT), false, 'branch-name working_tree');
  assert.equal(sameLocationAnyHost('juiced', ROOT), false, 'symbolic tree name');
  assert.equal(sameLocationAnyHost('', ROOT), false, 'empty is not a location');
  assert.equal(sameLocationAnyHost('Dome Farmer', 'Dome Farmer'), false, 'relative names are never locations');
});

test('near-miss spellings stay foreign: a name-prefix sibling, an unresolved `..`, and surrounding whitespace', () => {
  assert.equal(sameLocationAnyHost('/mnt/c/Users/chulf/Dome Farmer2', ROOT), false, 'prefix sibling is a different directory');
  assert.equal(sameLocationAnyHost('C:/Users/chulf/Dome Farmer2', ROOT), false, 'prefix sibling, drive form');
  assert.equal(sameLocationAnyHost('/mnt/c/Users/chulf/x/../Dome Farmer', ROOT), false, '`..` is never resolved (pure string question)');
  assert.equal(sameLocationAnyHost(' /mnt/c/Users/chulf/Dome Farmer', ROOT), false, 'leading whitespace');
  assert.equal(sameLocationAnyHost('C:/Users/chulf/Dome Farmer ', ROOT), false, 'trailing whitespace');
});
