// DIRECT-MERGE COMMAND LINE: help and invalid flags are validated before any
// config, git or gh side effect, and an unborn default base is a clean refusal.
//
// Harness: the real scripts/direct-merge.mjs run as a child process. For the
// flag tests PATH holds a HOSTILE fake `git` and `gh` that log every call to a
// file and exit 99, so any call at all (a mutation, a read, anything) shows up
// in the log and fails the "nothing ran" assertion. The unborn-base test uses a
// real git repository.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'direct-merge.mjs');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function hostileEnv(base) {
  const bin = join(base, 'hostilebin');
  const log = join(base, 'calls.log');
  mkdirSync(bin, { recursive: true });
  for (const tool of ['git', 'gh']) {
    const shim = join(bin, tool);
    writeFileSync(shim, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 99\n`);
    chmodSync(shim, 0o755);
  }
  return { log, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, GIT_TERMINAL_PROMPT: '0' } };
}

// A target directory that is NOT a repo and has no .sterling: if the script got
// past argument validation it would call (fake) git, which the log records.
function runHostile(args) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-dm-cli-'));
  try {
    const target = join(base, 'target');
    mkdirSync(target);
    const { log, env } = hostileEnv(base);
    const r = spawnSync(process.execPath, [script, ...args.map((a) => a.replace('<target>', target))], { encoding: 'utf8', cwd: target, timeout: 30_000, env });
    return { r, calls: existsSync(log) ? readFileSync(log, 'utf8') : '', targetEntries: readdirSync(target), stderr: oneLine(r.stderr), stdout: oneLine(r.stdout) };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

for (const flag of ['--help', '-h']) {
  test(`${flag} prints usage, exits 0 and touches neither git nor gh`, () => {
    const o = runHostile(['--target', '<target>', flag]);
    assert.equal(o.r.status, 0, `exit: ${o.stderr}`);
    assert.equal(o.calls, '', 'no git/gh call before help');
    assert.deepEqual(o.targetEntries, [], 'no file written in the target');
    for (const f of ['--target', '--into', '--branch', '--no-push', '--allow-same-version']) assert.ok(o.stdout.includes(f), `usage names ${f}: ${o.stdout}`);
  });
}

for (const args of [['--no-push=true'], ['--allow-same-version=x']]) {
  test(`${args[0]}: a switch carrying a value is refused with no side effect`, () => {
    const o = runHostile(args);
    assert.equal(o.r.status, 2, `exit: ${o.stderr}`);
    assert.equal(o.calls, '', 'no git/gh call before validation');
    assert.deepEqual(o.targetEntries, [], 'no file written in the target');
    assert.ok(o.stderr.includes(args[0]), `stderr names the flag: ${o.stderr}`);
  });
}

test('supported flag forms pass the flag check and reach the first side-effect step', () => {
  const o = runHostile(['--target=<target>', '--into=main', '--branch', 'feat/x', '--no-push', '--allow-same-version']);
  assert.equal(o.r.status, 1, o.stderr);
  assert.ok(o.stderr.includes('not a git repository'), `flag check did not block: ${o.stderr}`);
  assert.ok(!o.stderr.includes('unknown flag'), o.stderr);
});

test('an unknown flag exits 2 naming it, with no git/gh call and no file written', () => {
  const o = runHostile(['--bogus', '--target', '<target>']);
  assert.equal(o.r.status, 2, `exit: ${o.stderr}`);
  assert.equal(o.calls, '', 'no git/gh call before validation');
  assert.deepEqual(o.targetEntries, [], 'no file written in the target');
  assert.ok(o.stderr.includes('--bogus'), `stderr names the flag: ${o.stderr}`);
});

test('an unborn default base is a clean refusal naming --into, and never creates or moves a base', () => {
  const base = mkdtempSync(join(tmpdir(), 'sterling-dm-unborn-'));
  try {
    const g = (args) => {
      const r = spawnSync('git', args, { cwd: base, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
      return r.stdout.trim();
    };
    // Hobby repo whose only branch is the feature branch: no origin/HEAD, no main, no master.
    g(['init', '-b', 'feat/first']);
    g(['config', 'user.email', 'test@sterling.local']);
    g(['config', 'user.name', 'Sterling Test']);
    writeFileSync(join(base, '.gitignore'), '.sterling/\n');
    mkdirSync(join(base, '.sterling'));
    writeFileSync(join(base, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
    new SterlingStore(join(base, '.sterling', 'sterling.db')).close();
    g(['add', '-A']);
    g(['commit', '-m', 'first commit']);
    const headBefore = g(['rev-parse', 'HEAD']);
    const branchesBefore = g(['branch', '--list']);

    const r = spawnSync(process.execPath, [script, '--target', base], { encoding: 'utf8', cwd: base, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    assert.equal(r.status, 2, `exit: ${oneLine(r.stderr)}`);
    const err = String(r.stderr);
    assert.ok(err.includes('--into'), `names --into: ${oneLine(err)}`);
    assert.match(err, /no main|base branch/i, `names the missing base: ${oneLine(err)}`);
    assert.ok(!/\n\s+at /.test(err) && !err.includes('node:internal'), `no stack trace: ${oneLine(err)}`);
    assert.equal(g(['rev-parse', 'HEAD']), headBefore, 'HEAD unmoved');
    assert.equal(g(['branch', '--list']), branchesBefore, 'no branch created or deleted');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
