// Retired config.models keys are DROPPED (never carried) from a project's
// .sterling/config.json (board c45a4507, user-ruled 2026-10-23): the prepare/commit
// wrapper over migrateRetiredModelKeys, and the sync-agents call path. Temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitConfigMigration, migrateProjectConfig, prepareConfigMigration } from '../lib/config-migration.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function project(text) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-config-migration-'));
  mkdirSync(join(dir, '.sterling'));
  if (text !== undefined) writeFileSync(join(dir, '.sterling', 'config.json'), text);
  return dir;
}
const cfgPath = (dir) => join(dir, '.sterling', 'config.json');
const read = (dir) => readFileSync(cfgPath(dir), 'utf8');
const retiredConfig = () => ({
  mode: 'hobby',
  models: {
    coder: { model: 'claude-opus-5', effort: 'high' },
    explorer: { model: 'claude-haiku-5-5', effort: 'low' },
    reviewers: { model: 'claude-opus-5', effort: 'high' },
    scout: { model: 'claude-sonnet-5-5', effort: 'medium' },
  },
});
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test('drops every retired key with its value in the report and carries nothing; no temp file is left', () => {
  const dir = project(JSON.stringify(retiredConfig(), null, 2) + '\n');
  try {
    const r = migrateProjectConfig(dir);
    assert.equal(r.status, 'migrated');
    assert.deepEqual(r.lines, [
      'config migration: models.coder dropped (ignored since the roster rename to models.implementor); value was {"model":"claude-opus-5","effort":"high"}; set models.implementor in the System tab if you want it',
      'config migration: models.explorer dropped (ignored since the roster rename to models.scout); value was {"model":"claude-haiku-5-5","effort":"low"}; set models.scout in the System tab if you want it',
      'config migration: models.reviewers dropped (a retired key, ignored since the roster rename); value was {"model":"claude-opus-5","effort":"high"}; set models.<role> in the System tab for the role you want it on',
    ]);
    assert.deepEqual(JSON.parse(read(dir)), { mode: 'hobby', models: { scout: { model: 'claude-sonnet-5-5', effort: 'medium' } } }, 'no implementor key appears: nothing is carried');
    assert.ok(read(dir).endsWith('\n'), 'the trailing newline is kept');
    assert.deepEqual(readdirSync(join(dir, '.sterling')), ['config.json']);
  } finally {
    cleanup(dir);
  }
});

test('is idempotent: the second run changes nothing and prints nothing', () => {
  const dir = project(JSON.stringify(retiredConfig()));
  try {
    assert.equal(migrateProjectConfig(dir).status, 'migrated');
    const once = read(dir);
    const r = migrateProjectConfig(dir);
    assert.equal(r.status, 'unchanged');
    assert.deepEqual(r.lines, []);
    assert.equal(read(dir), once);
  } finally {
    cleanup(dir);
  }
});

test('a project without a config is absent, never created', () => {
  const dir = project();
  try {
    assert.equal(migrateProjectConfig(dir).status, 'absent');
    assert.equal(existsSync(cfgPath(dir)), false);
  } finally {
    cleanup(dir);
  }
});

for (const [label, text] of [
  ['invalid JSON', '{ "models": { "coder": '],
  ['a config that fails the schema', JSON.stringify({ mode: 'hobby', models: { coder: { model: 'm' }, scout: { model: 'claude-sonnet-5-5', effort: 'extreme' } } })],
]) {
  test(`an unparseable config (${label}) is refused and left byte-for-byte`, () => {
    const dir = project(text);
    try {
      const r = prepareConfigMigration(dir);
      assert.equal(r.status, 'refused');
      assert.match(r.lines[0], /^config migration refused: .*config\.json does not parse or validate .*; left untouched$/);
      assert.equal(read(dir), text);
    } finally {
      cleanup(dir);
    }
  });
}

test('prepare writes nothing; commit writes the plan', () => {
  const text = JSON.stringify(retiredConfig());
  const dir = project(text);
  try {
    const plan = prepareConfigMigration(dir);
    assert.equal(plan.status, 'ready');
    assert.equal(read(dir), text, 'prepare leaves the file byte-identical');
    assert.equal(commitConfigMigration(plan).status, 'migrated');
    assert.notEqual(read(dir), text);
  } finally {
    cleanup(dir);
  }
});

test('a change between prepare and commit is refused as a concurrent change and the other writer wins', () => {
  const dir = project(JSON.stringify(retiredConfig()));
  try {
    const plan = prepareConfigMigration(dir);
    const theirs = JSON.stringify({ ...retiredConfig(), mode: 'work' });
    writeFileSync(cfgPath(dir), theirs);
    const r = commitConfigMigration(plan);
    assert.equal(r.status, 'refused');
    assert.match(r.lines[0], /changed on disk while the migration was in flight \(a concurrent change\); left untouched$/);
    assert.equal(read(dir), theirs, "the concurrent writer's file is untouched");
    assert.deepEqual(readdirSync(join(dir, '.sterling')), ['config.json']);
  } finally {
    cleanup(dir);
  }
});

test('a change inside the commit window (after the temp write, before the rename) is refused and the temp file removed', () => {
  const dir = project(JSON.stringify(retiredConfig()));
  try {
    const theirs = JSON.stringify({ ...retiredConfig(), mode: 'work' });
    const r = migrateProjectConfig(dir, { beforeRename: () => writeFileSync(cfgPath(dir), theirs) });
    assert.equal(r.status, 'refused');
    assert.match(r.lines[0], /concurrent change/);
    assert.equal(read(dir), theirs);
    assert.deepEqual(readdirSync(join(dir, '.sterling')), ['config.json'], 'the temp file is cleaned up');
  } finally {
    cleanup(dir);
  }
});

test('the replacement keeps the original file mode (0600)', { skip: process.platform === 'win32' }, () => {
  const dir = project(JSON.stringify(retiredConfig()));
  try {
    chmodSync(cfgPath(dir), 0o600);
    assert.equal(migrateProjectConfig(dir).status, 'migrated');
    assert.equal(statSync(cfgPath(dir)).mode & 0o777, 0o600);
  } finally {
    cleanup(dir);
  }
});

test('a symlinked config with retired keys is refused (the rename would replace the link); one with none is left alone', { skip: process.platform === 'win32' }, () => {
  const dir = project();
  const real = mkdtempSync(join(tmpdir(), 'sterling-config-real-'));
  try {
    const target = join(real, 'config.json');
    writeFileSync(target, JSON.stringify(retiredConfig()));
    symlinkSync(target, cfgPath(dir));
    const r = prepareConfigMigration(dir);
    assert.equal(r.status, 'refused');
    assert.match(r.lines[0], /is a symlink/);
    writeFileSync(target, JSON.stringify({ mode: 'hobby' }));
    assert.equal(prepareConfigMigration(dir).status, 'unchanged');
  } finally {
    cleanup(dir);
    cleanup(real);
  }
});

test('a symlinked .sterling directory is refused and the config it points at is left untouched', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-config-migration-'));
  const real = mkdtempSync(join(tmpdir(), 'sterling-config-realdir-'));
  try {
    const original = JSON.stringify(retiredConfig());
    writeFileSync(join(real, 'config.json'), original);
    symlinkSync(real, join(dir, '.sterling'), 'dir');
    const r = prepareConfigMigration(dir);
    assert.equal(r.status, 'refused');
    assert.match(r.lines[0], /\.sterling that is not a plain directory/);
    assert.equal(migrateProjectConfig(dir).status, 'refused');
    assert.equal(readFileSync(join(real, 'config.json'), 'utf8'), original);
    writeFileSync(join(real, 'config.json'), JSON.stringify({ mode: 'hobby' }));
    assert.equal(prepareConfigMigration(dir).status, 'unchanged');
  } finally {
    cleanup(dir);
    cleanup(real);
  }
});

function sync(dir) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'sync-agents.mjs'), '--target', dir], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, STERLING_CLAUDE_PROBE: 'ok', STERLING_OPENCODE_SETUP_DISABLE: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const pinLines = (dir, agent) => readFileSync(join(dir, '.claude', 'agents', `${agent}.md`), 'utf8').split('\n').filter((l) => /^(model|effort): /.test(l));

test('sync-agents drops the retired keys, prints the report, and renders every pin exactly as it did before the migration', () => {
  const retired = project(JSON.stringify(retiredConfig()));
  const control = project(JSON.stringify({ mode: 'hobby', models: { scout: { model: 'claude-sonnet-5-5', effort: 'medium' } } }));
  try {
    const r = sync(retired);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /config migration: models\.coder dropped/);
    assert.match(r.out, /config migration: models\.reviewers dropped/);
    assert.deepEqual(Object.keys(JSON.parse(read(retired)).models), ['scout']);
    assert.equal(sync(control).code, 0);
    for (const agent of ['implementor', 'scout', 'reviewer']) {
      const pins = pinLines(retired, agent);
      assert.ok(pins.length >= 1, `${agent} carries a model pin`);
      assert.deepEqual(pins, pinLines(control, agent), `${agent}: the same pin as a project that never had the retired keys`);
    }
    assert.doesNotMatch(pinLines(retired, 'implementor').join('\n'), /claude-opus-5$/m, 'the old coder pin is not carried to implementor');
  } finally {
    cleanup(retired);
    cleanup(control);
  }
});

// Skipped as root, which ignores directory permissions.
const canTestReadOnly = process.platform !== 'win32' && process.getuid?.() !== 0;

test('a write that fails is a refusal naming the cause, and the file is untouched', { skip: !canTestReadOnly }, () => {
  const text = JSON.stringify(retiredConfig());
  const dir = project(text);
  try {
    chmodSync(join(dir, '.sterling'), 0o500);
    const r = migrateProjectConfig(dir);
    assert.equal(r.status, 'refused');
    assert.match(r.lines[0], /could not be rewritten \(EACCES\); left untouched$/);
    assert.equal(read(dir), text);
  } finally {
    chmodSync(join(dir, '.sterling'), 0o700);
    cleanup(dir);
  }
});

test('sync-agents stops with exit 2 before rendering or setupOpenCode when the migration is refused', { skip: !canTestReadOnly }, () => {
  const text = JSON.stringify(retiredConfig());
  const dir = project(text);
  try {
    chmodSync(join(dir, '.sterling'), 0o500);
    const r = sync(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /config migration refused: .*could not be rewritten/);
    assert.match(r.out, /refused_config_migration: .*nothing synced/);
    assert.equal(existsSync(join(dir, '.claude')), false, 'no Claude agent rendered');
    assert.equal(existsSync(join(dir, '.opencode')), false, 'no OpenCode setup');
    assert.doesNotMatch(r.out, /^OpenCode/m, 'setupOpenCode never ran');
    assert.equal(read(dir), text, 'the file is untouched');
  } finally {
    chmodSync(join(dir, '.sterling'), 0o700);
    cleanup(dir);
  }
});
