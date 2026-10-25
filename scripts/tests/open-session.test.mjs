// /sterling:session (scripts/open-session.mjs): a parallel session gets its own git
// worktree and branch, OpenCode is set up there, and --remove retires only a clean one.
// Every test runs in a temp git repo with a temp HOME and OpenCode stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupOpenCode } from '../lib/opencode-install.mjs';
import { openSession, removeSession, worktreePathFor, SessionRefusal } from '../open-session.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repoRoot, 'scripts', 'open-session.mjs');
const OC2 = () => ({ installed: true, version: '2.0.21', major: 2 });

// OPENCODE and OPENCODE_SESSION_ID are cleared in every spawned env: a run inside an
// OpenCode session must not leak into what the script or git sees.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.OPENCODE;
  delete env.OPENCODE_SESSION_ID;
  return env;
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A temp workspace: <base>/proj (a main checkout on branch main) and a temp HOME. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'open-session-')));
  const home = join(base, 'home');
  mkdirSync(home);
  const main = join(base, 'proj');
  mkdirSync(main);
  git(main, ['init', '-q', '-b', 'main']);
  git(main, ['config', 'user.email', 't@example.com']);
  git(main, ['config', 'user.name', 't']);
  git(main, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(main, '.sterling'));
  writeFileSync(join(main, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  writeFileSync(join(main, '.sterling', 'project.json'), '{}\n');
  writeFileSync(join(main, '.gitignore'), '.sterling/*\n!.sterling/project.json\n');
  writeFileSync(join(main, 'README.md'), 'x\n');
  git(main, ['add', 'README.md', '.gitignore', '.sterling/project.json']);
  git(main, ['commit', '-qm', 'init']);
  const setup = ({ projectDir, pluginRoot }) => setupOpenCode({ projectDir, pluginRoot, env: { HOME: home }, home, installed: false, probe: OC2 });
  return { base, home, main, setup };
}

test('opens a worktree on session/<label> beside the main checkout and sets OpenCode up in it', () => {
  const f = fixture();
  try {
    const r = openSession({ target: f.main, name: 'alpha', setup: f.setup });
    const expected = join(f.base, 'proj.worktrees', 'alpha');
    assert.equal(r.path, expected);
    assert.equal(r.path, worktreePathFor(f.main, 'alpha'));
    assert.ok(!r.path.startsWith(f.main + '/'), 'the worktree is not nested in the main checkout');
    assert.equal(r.branch, 'session/alpha');
    assert.equal(git(r.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'session/alpha');
    assert.equal(git(r.path, ['rev-parse', 'HEAD']), git(f.main, ['rev-parse', 'main']), 'cut from the default branch');
    // OpenCode setup landed in the worktree: config and the Sterling agent roster
    const cfg = JSON.parse(readFileSync(join(r.path, '.opencode', 'opencode.json'), 'utf8'));
    assert.equal(cfg.default_agent, 'sterling/conductor');
    assert.ok(existsSync(join(r.path, '.opencode', 'agents', 'sterling', 'conductor.md')));
    assert.equal(r.setup.rows.filter((row) => row.refused).length, 0, JSON.stringify(r.setup.rows.filter((row) => row.refused)));
    // the config copy lived only for the setup call: the main checkout's config stays the only one
    assert.ok(!existsSync(join(r.path, '.sterling', 'config.json')), 'the worktree holds no .sterling/config.json');
    assert.ok(existsSync(join(f.main, '.sterling', 'config.json')));
    assert.deepEqual(readdirSync(join(r.path, '.sterling')), ['project.json'], 'only the tracked project.json is under the worktree .sterling/');
    // none of it shows up as untracked content in the worktree or the main checkout
    assert.equal(git(r.path, ['status', '--porcelain']), '');
    assert.equal(git(f.main, ['status', '--porcelain']), '');
    // no node_modules was linked or installed
    assert.ok(!existsSync(join(r.path, 'node_modules')));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('the config copy is removed even when the setup throws', () => {
  const f = fixture();
  try {
    let seen = false;
    const boom = ({ projectDir }) => {
      seen = existsSync(join(projectDir, '.sterling', 'config.json'));
      throw new Error('setup exploded');
    };
    assert.throws(() => openSession({ target: f.main, name: 'boom', setup: boom }), /setup exploded/);
    assert.ok(seen, 'the copy was present during setup');
    assert.ok(!existsSync(join(worktreePathFor(f.main, 'boom'), '.sterling', 'config.json')));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('with no --name the label is the first free session-N from 2, and a worktree target resolves to the main checkout', () => {
  const f = fixture();
  try {
    const first = openSession({ target: f.main, setup: f.setup });
    assert.equal(first.label, 'session-2');
    const second = openSession({ target: first.path, setup: f.setup });
    assert.equal(second.label, 'session-3');
    assert.equal(second.path, join(f.base, 'proj.worktrees', 'session-3'));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('refuses an existing worktree, an existing branch and a bad label, and creates nothing', () => {
  const f = fixture();
  try {
    openSession({ target: f.main, name: 'dup', setup: f.setup });
    assert.throws(() => openSession({ target: f.main, name: 'dup', setup: f.setup }), (e) => e instanceof SessionRefusal && e.exit === 2 && /worktree .* already exists/.test(e.message));
    git(f.main, ['branch', 'session/taken']);
    assert.throws(() => openSession({ target: f.main, name: 'taken', setup: f.setup }), (e) => e instanceof SessionRefusal && /branch session\/taken already exists/.test(e.message));
    assert.ok(!existsSync(worktreePathFor(f.main, 'taken')), 'no worktree was left behind by the branch refusal');
    for (const bad of ['a/b', '..', '-x', 'a b']) {
      assert.throws(() => openSession({ target: f.main, name: bad, setup: f.setup }), (e) => e instanceof SessionRefusal && /not a usable label/.test(e.message), bad);
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('refuses a directory that is not a git repository', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'open-session-nogit-')));
  try {
    assert.throws(() => openSession({ target: dir, name: 'x', setup: () => assert.fail('set up') }), (e) => e instanceof SessionRefusal && /not inside a git repository/.test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--remove refuses a dirty worktree and removes a clean one with its merged branch', () => {
  const f = fixture();
  try {
    const { path } = openSession({ target: f.main, name: 'gone', setup: f.setup });
    writeFileSync(join(path, 'scratch.txt'), 'uncommitted\n');
    assert.throws(() => removeSession({ target: f.main, name: 'gone' }), (e) => e instanceof SessionRefusal && e.exit === 2 && /uncommitted changes/.test(e.message) && e.message.includes('scratch.txt'));
    assert.ok(existsSync(path), 'a dirty worktree is left in place');
    rmSync(join(path, 'scratch.txt'));
    const r = removeSession({ target: f.main, name: 'gone' });
    assert.equal(r.branchKept, null);
    assert.ok(!existsSync(path));
    assert.ok(!git(f.main, ['branch', '--list', 'session/gone']));
    assert.ok(!git(f.main, ['worktree', 'list']).includes('gone'));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('--remove keeps a branch with unmerged commits and refuses a path that is not a worktree', () => {
  const f = fixture();
  try {
    const { path } = openSession({ target: f.main, name: 'work', setup: f.setup });
    writeFileSync(join(path, 'feature.txt'), 'f\n');
    git(path, ['add', 'feature.txt']);
    git(path, ['commit', '-qm', 'feature']);
    const r = removeSession({ target: f.main, name: 'work' });
    assert.ok(r.branchKept, 'the unmerged branch is reported as kept');
    assert.ok(git(f.main, ['branch', '--list', 'session/work']), 'and still exists');
    assert.ok(!existsSync(path));
    assert.throws(() => removeSession({ target: f.main, name: 'never-made' }), (e) => e instanceof SessionRefusal && /not a worktree of/.test(e.message));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('CLI: refuses with exit 2 and a message on an existing worktree, rejects bad arguments with exit 1', () => {
  const f = fixture();
  try {
    mkdirSync(worktreePathFor(f.main, 'busy'), { recursive: true });
    const env = cleanEnv({ HOME: f.home, STERLING_OPENCODE_SETUP_DISABLE: '1' });
    const busy = spawnSync(process.execPath, [script, '--target', f.main, '--name', 'busy'], { encoding: 'utf8', env });
    assert.equal(busy.status, 2, busy.stderr);
    assert.match(busy.stderr, /already exists/);
    const bad = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8', env, cwd: f.main });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unrecognized argument '--bogus'/);
    const both = spawnSync(process.execPath, [script, '--name', 'a', '--remove', 'a'], { encoding: 'utf8', env, cwd: f.main });
    assert.equal(both.status, 1);
    assert.match(both.stderr, /cannot be combined/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('CLI: an OpenCode setup that did not run leaves the worktree, exits 2 and says so; --remove retires it', () => {
  const f = fixture();
  try {
    const env = cleanEnv({ HOME: f.home, STERLING_OPENCODE_SETUP_DISABLE: '1' });
    const made = spawnSync(process.execPath, [script, '--target', f.main, '--name', 'nooc'], { encoding: 'utf8', env });
    assert.equal(made.status, 2, made.stderr);
    assert.match(made.stdout, /created worktree: /);
    assert.match(made.stderr, /OpenCode is NOT ready/);
    assert.ok(existsSync(worktreePathFor(f.main, 'nooc')));
    const gone = spawnSync(process.execPath, [script, '--target', f.main, '--remove', 'nooc'], { encoding: 'utf8', env });
    assert.equal(gone.status, 0, gone.stderr);
    assert.match(gone.stdout, /removed worktree: /);
    assert.equal(basename(worktreePathFor(f.main, 'nooc')), 'nooc');
    assert.ok(!existsSync(worktreePathFor(f.main, 'nooc')));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
