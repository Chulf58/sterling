// The folder naming rule (user-ruled 2026-10-12, "Refuse with a rename hint"): init
// refuses a project path that is not shell-safe before it writes anything, and names
// the safe folder ("New Project" -> "New-Project": a space becomes a hyphen, case is
// kept) and the mv command. The update ensure pass on an existing project is exempt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isShellSafePath, unsafeChars, safeFolderName, shellUnsafePathFix, describeShellUnsafePath } from '../lib/shell-safe-path.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRESH_FLAGS = ['--project-name', 'naming-test', '--stack-tags', 'node', '--toolchain', 'node:**/*.mjs', '--backup-opt-out', '--domain-description', 'node=Node facts'];

const scratch = new Set();
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.add(d);
  return d;
}
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// init isolated from the machine: scratch HOME, registry, plugin-root match and Claude
// config dir, all OUTSIDE the project folder so a refused run can be seen to write nothing.
function init(dir, iso, args = []) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...args], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    env: {
      ...process.env,
      HOME: iso.home,
      STERLING_REGISTRY_DB: iso.registry,
      STERLING_PLUGIN_ROOT_MATCH: iso.pluginRootMatch,
      CLAUDE_CONFIG_DIR: iso.claudeConfig,
      STERLING_CODEX_PROBE: 'absent',
      STERLING_CLAUDE_PROBE: 'ok',
      STERLING_OPENCODE_SETUP_DISABLE: '1',
    },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function isolation() {
  const base = tmp('sterling-naming-iso-');
  return { home: join(base, 'home'), registry: join(base, 'registry.db'), pluginRootMatch: join(base, 'root-match'), claudeConfig: join(base, 'claude') };
}

test('the predicate allows letters, digits and _@%+=:,./- and nothing else', () => {
  assert.equal(isShellSafePath('/home/u@x/code/New-Project_1.2'), true);
  for (const bad of ['/p/New Project', "/p/it's", '/p/a"b', '/p/a*b', '/p/a?b', '/p/a[b]', '/p/Priser-æ', '/p/a\tb', '']) {
    assert.equal(isShellSafePath(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(unsafeChars('/p/a b*c d?'), [' ', '*', '?']);
  assert.deepEqual(unsafeChars('/p/Priser-æ'), ['æ']);
});

test('the safe name: whitespace runs become one hyphen, case is kept, other unsafe characters are dropped', () => {
  assert.equal(safeFolderName('New Project'), 'New-Project');
  assert.equal(safeFolderName('New   \t Project'), 'New-Project');
  assert.equal(safeFolderName('New - Project'), 'New-Project');
  assert.equal(safeFolderName("Bob's Project"), 'Bobs-Project');
  assert.equal(safeFolderName('a"b'), 'ab');
  assert.equal(safeFolderName('glob*?[x]'), 'globx');
  assert.equal(safeFolderName('Café Menu'), 'Cafe-Menu', 'an accented letter loses its accent');
  assert.equal(safeFolderName('Priser-æ'), 'Priser', 'æ has no ASCII decomposition, so it is dropped and the dangling hyphen trimmed');
  assert.equal(safeFolderName(' Lead '), 'Lead');
  assert.equal(safeFolderName('ææ'), null, 'nothing safe is left');
  assert.equal(safeFolderName('* *'), null);
});

test('the fix renames only the folder, and gives an mv only when that makes the whole path safe', () => {
  assert.equal(shellUnsafePathFix('/home/u/New-Project'), null);
  const name = shellUnsafePathFix('/home/u/New Project');
  assert.equal(name.folder, '/home/u/New-Project');
  assert.equal(name.unsafeParent, null);
  assert.equal(name.mv, 'mv "/home/u/New Project" "/home/u/New-Project"');
  const quoted = shellUnsafePathFix('/home/u/My "Proj" $x');
  assert.equal(quoted.mv, 'mv "/home/u/My \\"Proj\\" \\$x" "/home/u/My-Proj-x"', 'the old path is quoted so the shell reads it literally');
  const parent = shellUnsafePathFix('/home/u/my dir/proj');
  assert.equal(parent.nameUnsafe, false);
  assert.equal(parent.folder, null);
  assert.equal(parent.mv, null, 'a parent directory is never renamed');
  assert.equal(parent.unsafeParent, '/home/u/my dir');
  const both = shellUnsafePathFix('/home/a b/c d/New Project');
  assert.equal(both.folder, '/home/a b/c d/New-Project');
  assert.equal(both.unsafeParent, '/home/a b/c d', 'the deepest unsafe parent is named');
  assert.equal(both.mv, null, 'renaming the folder alone would not make the path safe');
});

test('the message names the path, the characters, the safe folder and the mv line; a parent case says so plainly', () => {
  const msg = describeShellUnsafePath('/home/u/New Project', { label: 'the project path', rerun: 're-run /sterling:init' });
  assert.match(msg, /the project path '\/home\/u\/New Project' has a character that is not shell-safe: " "/);
  assert.match(msg, /Use the folder name 'New-Project'/);
  assert.match(msg, /^ {2}mv "\/home\/u\/New Project" "\/home\/u\/New-Project"$/m);
  assert.match(msg, /then re-run \/sterling:init from \/home\/u\/New-Project\./);
  const parent = describeShellUnsafePath('/home/my dir/proj', { label: 'the project path', rerun: 're-run /sterling:init' });
  assert.match(parent, /The parent directory '\/home\/my dir' breaks the rule; Sterling does not rename parent directories/);
  assert.doesNotMatch(parent, /\bmv\b|Use the folder name/);
  const none = describeShellUnsafePath('/home/u/ææ', { label: 'the project path', rerun: 're-run /sterling:init' });
  assert.match(none, /No safe name can be made from 'ææ'/);
  assert.equal(describeShellUnsafePath('/home/u/ok', { label: 'x', rerun: 'y' }), null);
});

test('init on a folder named "New Project" refuses with the hint and writes nothing: no .sterling, no AGENTS.md, no registry row', () => {
  const dir = join(tmp('sterling-naming-proj-'), 'New Project');
  mkdirSync(dir);
  const iso = isolation();
  const r = init(dir, iso, FRESH_FLAGS);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /init REFUSED: the project path '.*\/New Project' has a character that is not shell-safe/);
  assert.match(r.out, /Use the folder name 'New-Project'/);
  assert.match(r.out, /mv ".*\/New Project" ".*\/New-Project"/);
  assert.match(r.out, /Nothing was written\./);
  assert.deepEqual(readdirSync(dir), [], 'the project folder is left empty');
  assert.equal(existsSync(iso.registry), false, 'no registry database is created');
  assert.equal(existsSync(iso.home), false, 'no domain store is created');
});

test('the rule holds on a re-init, and the update ensure pass on an existing project is exempt', () => {
  const parent = tmp('sterling-naming-proj-');
  const safe = join(parent, 'Safe-Project');
  mkdirSync(safe);
  const iso = isolation();
  assert.equal(init(safe, iso, FRESH_FLAGS).code, 0, 'a safe folder initializes as before');
  const unsafe = join(parent, 'Safe Project');
  renameSync(safe, unsafe);
  const reinit = init(unsafe, iso);
  assert.equal(reinit.code, 2, reinit.out);
  assert.match(reinit.out, /init REFUSED: the project path '.*\/Safe Project'/);
  const ensure = init(unsafe, iso, ['--update-ensure']);
  assert.doesNotMatch(ensure.out, /not shell-safe/, 'the update ensure pass is not refused for the folder name');
  assert.equal(ensure.code, 0, ensure.out);
});

test('--update-ensure does not exempt a folder that has no Sterling config yet', () => {
  const dir = join(tmp('sterling-naming-proj-'), 'New Project');
  mkdirSync(dir);
  const r = init(dir, isolation(), [...FRESH_FLAGS, '--update-ensure']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /not shell-safe/);
  assert.deepEqual(readdirSync(dir), []);
});
