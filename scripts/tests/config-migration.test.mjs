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
// The legacy planner (prepareConfigMigration, migrateProjectConfig) was removed with the cutover (item G): nothing
// called it once sync-agents and init moved to the canonical planner, and its validation gate (parseConfig) is
// canonical now. These tests run the SAME machinery (retired keys, hard_task move, Overpass reset, stale agy,
// compare-and-swap commit, file mode, symlink refusals) through the canonical planner.
import { commitConfigMigration, migrateProjectConfigCanonical as migrateProjectConfig, prepareCanonicalConfigMigration as prepareConfigMigration } from '../lib/config-migration.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function project(text) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-config-migration-'));
  mkdirSync(join(dir, '.sterling'));
  if (text !== undefined) writeFileSync(join(dir, '.sterling', 'config.json'), text);
  return dir;
}
const cfgPath = (dir) => join(dir, '.sterling', 'config.json');
const read = (dir) => readFileSync(cfgPath(dir), 'utf8');
// The fixtures below are about the retired keys, so they record the model-defaults add and
// the implementor-hard move as already applied (added with those steps, user-ruled 2026-10-23,
// and decision hard-implementor-is-its-own-agent-sterling-implementor-hard) and the Overpass defaults reset
// (decision overpass-per-role-default-tiers-implementor-premium-sparring-premium-max, 'Defaults + reset + bypass ON');
// their own tests are at the end.
const DEFAULTS_DONE = { applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23', 'overpass-defaults-2026-10-23'] };
const retiredConfig = () => ({
  ...DEFAULTS_DONE,
  mode: 'hobby',
  models: {
    coder: { model: 'claude-opus-5', effort: 'high' },
    explorer: { model: 'claude-haiku-5-5', effort: 'low' },
    reviewers: { model: 'claude-opus-5', effort: 'high' },
    scout: { model: 'claude-sonnet-5-5', effort: 'medium' },
  },
});
// A config the canonical planner has nothing left to do for (it records the migration id).
const CANONICAL_DONE = { applied_config_migrations: [...DEFAULTS_DONE.applied_config_migrations, 'canonical-config-2026-11-19'], workflow: { merge: 'direct', reviewers: 1, copilot_loop: false, auto_merge_on_clean: true } };
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });


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
      // Changed with the cutover: the canonical planner reads the file through the transform, so an unreadable JSON or a value the
      // strict canonical check refuses is named by that path rather than by the legacy 'does not parse or validate' wording.
      assert.match(r.lines[0], /^config migration refused: .*config\.json (is not valid JSON|would not validate after the migration|cannot be carried).*; left untouched$/);
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
    writeFileSync(target, JSON.stringify(CANONICAL_DONE));
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
    writeFileSync(join(real, 'config.json'), JSON.stringify(CANONICAL_DONE));
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

// ── the model-defaults add (user-ruled 2026-10-23, "Write it into each config") ──





// ── the implementor-hard move (decision hard-implementor-is-its-own-agent-sterling-implementor-hard) ──
// models.implementor.hard_task moves into models.implementor-hard, once per file; other roles keep theirs.
const MOVE_PRE = { applied_config_migrations: ['model-defaults-2026-10-23', 'overpass-defaults-2026-10-23'] };







// ── the Overpass defaults reset (decision overpass-per-role-default-tiers-implementor-premium-sparring-premium-max, user-ruled 2026-10-23, 'Defaults + reset + bypass ON') ──
// config.overpass.roles is removed and overpass.conductor_bypass set true, once per file; nothing else moves.
const OVERPASS_PRE = { applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23'] };







// ── the steps that run before the canonical transform, through the canonical planner ──
// (They replace the legacy-planner tests removed with the planner; the report lines are the ones the planner now prints.)
const migrated = (doc) => {
  const dir = project(JSON.stringify(doc));
  try {
    const r = migrateProjectConfig(dir);
    return { r, after: r.status === 'migrated' ? JSON.parse(read(dir)) : null, dir, again: r.status === 'migrated' ? prepareConfigMigration(dir) : null };
  } finally {
    cleanup(dir);
  }
};

test('a retired models key is dropped with its value and an accurate reason; the rest of models is kept and carried to the canonical shape', () => {
  const { r, after } = migrated({ mode: 'hobby', models: { classifiers: { model: 'claude-haiku-5-5', effort: 'low' }, implementor: { model: 'claude-sonnet-5-5', effort: 'high' } } });
  assert.equal(r.status, 'migrated');
  assert.ok(r.lines.includes('config migration: models.classifiers dropped (a retired key: it belonged to the retired Haiku noise-gate and nothing read it); value was {"model":"claude-haiku-5-5","effort":"low"}'));
  assert.ok(!('classifiers' in after.models));
  assert.deepEqual(after.models.implementor, { model: 'anthropic/claude-sonnet-5-5', effort: 'high' });
});

test('implementor-hard move: a Claude hard_task becomes the entry at the implementor\'s effort; another role\'s hard_task is dropped and reported; it runs once', () => {
  const { r, after, again } = migrated({ ...MOVE_PRE, mode: 'hobby', models: {
    implementor: { model: 'claude-sonnet-5-5', effort: 'medium', hard_task: { model: 'claude-opus-4-8' } },
    researcher: { model: 'claude-sonnet-5-5', effort: 'medium', hard_task: { model: 'claude-opus-5-5' } },
  } });
  assert.equal(r.status, 'migrated');
  assert.deepEqual(after.models.implementor, { model: 'anthropic/claude-sonnet-5-5', effort: 'medium' }, 'hard_task leaves the implementor entry');
  assert.deepEqual(after.models['implementor-hard'], { model: 'anthropic/claude-opus-4-8', effort: 'medium' }, 'no hard_task effort: the implementor effort a hard dispatch was sent with');
  // Changed with the cutover: one model per agent has no per-role hard_task, so another role's hard_task is removed (and reported), not kept.
  assert.ok(!('hard_task' in after.models.researcher));
  assert.ok(r.lines.some((l) => l.startsWith('config migration: models.researcher.hard_task removed (value was {"model":"claude-opus-5-5"})')));
  assert.deepEqual(after.applied_config_migrations, ['model-defaults-2026-10-23', 'overpass-defaults-2026-10-23', 'implementor-hard-2026-10-23', 'canonical-config-2026-11-19']);
  assert.ok(r.lines.includes('config migration: models.implementor.hard_task {"model":"claude-opus-4-8"} moved to models.implementor-hard as {"model":"claude-opus-4-8","effort":"medium"}, the sterling/implementor-hard agent\'s model; change it in the System tab'));
  assert.equal(again.status, 'unchanged', 'runs once');
});

test('implementor-hard move: a <provider>/<model> hard_task is a two-model conflict on implementor-hard, asked rather than decided; a cleared hard_task copying an OpenCode-pinned implementor conflicts on both', () => {
  // Changed with the cutover: the legacy planner wrote opencode_model beside the Claude model; one model per agent turns that pair into a question.
  const oc = migrated({ ...MOVE_PRE, models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', hard_task: { model: 'openai/gpt-6.1-sol', effort: 'xhigh' } } } });
  assert.equal(oc.r.status, 'conflicts');
  assert.deepEqual(oc.r.conflicts.map((c) => c.role), ['implementor-hard']);
  const copy = migrated({ ...MOVE_PRE, models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', opencode_model: 'openai/gpt-5.6-terra' } } });
  assert.equal(copy.r.status, 'conflicts');
  assert.deepEqual(copy.r.conflicts.map((c) => c.role).sort(), ['implementor', 'implementor-hard']);
});

test('implementor-hard move: an existing implementor-hard entry wins and the hard_task is dropped with its value reported', () => {
  const { r, after } = migrated({ ...MOVE_PRE, models: {
    implementor: { model: 'claude-sonnet-5-5', effort: 'high', hard_task: { model: 'claude-opus-5-5' } },
    'implementor-hard': { model: 'claude-sonnet-5-5', effort: 'low' },
  } });
  assert.deepEqual(after.models['implementor-hard'], { model: 'anthropic/claude-sonnet-5-5', effort: 'low' });
  assert.deepEqual(after.models.implementor, { model: 'anthropic/claude-sonnet-5-5', effort: 'high' });
  assert.ok(r.lines.includes('config migration: models.implementor.hard_task dropped (value was {"model":"claude-opus-5-5"}); models.implementor-hard {"model":"claude-sonnet-5-5","effort":"low"} was already set and is kept'));
});

test('implementor-hard move: a hard_task model that is not a model is refused by the strict check, and the file is left untouched', () => {
  const text = JSON.stringify({ ...MOVE_PRE, models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', hard_task: { model: 'not a model' } } } });
  const dir = project(text);
  try {
    const r = migrateProjectConfig(dir);
    assert.equal(r.status, 'refused');
    assert.match(r.lines[0], /would not validate after the migration/);
    assert.equal(read(dir), text);
  } finally {
    cleanup(dir);
  }
});

test('overpass reset: removes roles, resets the bypass, reports both, runs once; a config with no block or one on the defaults is reported; a block that is not an object is refused whole', () => {
  const set = migrated({ applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23'], mode: 'hobby', overpass: { enabled: false, provider: 'gw', roles: { reviewer: { tier: 'agentic-low' } }, conductor_bypass: false } });
  assert.ok(set.r.lines.includes('config migration: overpass.roles removed (value was {"reviewer":{"tier":"agentic-low"}}); every role now runs on its default tier'));
  assert.ok(set.r.lines.includes('config migration: overpass.conductor_bypass set to true (was false); the conductor keeps its direct model pin'));
  assert.deepEqual(set.after.overpass, { provider: 'gw' }, 'only the provider stays: the canonical overpass block has no enabled, roles or bypass');
  assert.equal(set.again.status, 'unchanged');
  const none = migrated({ applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23'], mode: 'hobby' });
  assert.ok(none.r.lines.includes('config migration: overpass.conductor_bypass set to true (was unset); the conductor keeps its direct model pin'));
  const same = migrated({ applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23'], mode: 'hobby', overpass: { enabled: false, conductor_bypass: true } });
  assert.ok(same.r.lines.includes('config migration: overpass defaults already in place; recorded overpass-defaults-2026-10-23 in applied_config_migrations so they are never reset again'));
  const text = JSON.stringify({ applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23'], mode: 'hobby', overpass: 'x' });
  const dir = project(text);
  try {
    const r = prepareConfigMigration(dir);
    assert.equal(r.status, 'refused');
    assert.match(r.lines[0], /config\.overpass is "x", not an object/);
    assert.equal(read(dir), text);
  } finally {
    cleanup(dir);
  }
});

test('stale agy_model: an exact id from v0.19.155 is dropped and reported, and every agy_model leaves the canonical models; a second run is a no-op (GitHub #310)', () => {
  const { r, after, again } = migrated({ mode: 'hobby', models: { scout: { model: 'claude-sonnet-5-5', effort: 'low', agy_model: 'claude-opus-5-5-high' }, reviewer: { model: 'claude-opus-5-5', effort: 'high', agy_model: 'flash' } } });
  assert.ok(r.lines.some((l) => l.startsWith('config migration: models.scout.agy_model dropped (agy accepts only inherit, flash_lite, flash or pro')));
  // Changed with the cutover: a valid agy_model was kept before; one model per agent removes the per-host field, so it is removed and reported too.
  assert.ok(r.lines.includes('config migration: models.reviewer.agy_model removed (value was "flash")'));
  assert.deepEqual(after.models, { scout: { model: 'anthropic/claude-sonnet-5-5', effort: 'low' }, reviewer: { model: 'anthropic/claude-opus-5-5', effort: 'high' } });
  assert.equal(again.status, 'unchanged');
});

test('sync-agents: after the implementor-hard move, the saved entry and the installed implementor-hard pin agree, and a second sync reports no drift', () => {
  // Sol review [HIGH]: sync rendered from the config it parsed BEFORE the migration, so a moved hard_task was saved under implementor-hard
  // while the installed agent pinned the schema default. The render must use the migrated document.
  const dir = project(JSON.stringify({ applied_config_migrations: ['model-defaults-2026-10-23'], mode: 'hobby', models: {
    implementor: { model: 'claude-sonnet-5-5', effort: 'high', hard_task: { model: 'claude-opus-4-8', effort: 'xhigh' } },
  } }));
  try {
    const r = sync(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /config migration: models\.implementor\.hard_task .* moved to models\.implementor-hard/);
    assert.deepEqual(JSON.parse(read(dir)).models['implementor-hard'], { model: 'anthropic/claude-opus-4-8', effort: 'xhigh' });
    assert.deepEqual(pinLines(dir, 'implementor-hard'), ['model: claude-opus-4-8', 'effort: xhigh'], 'the installed pin is the migrated entry');
    const again = sync(dir);
    assert.equal(again.code, 0, again.out);
    assert.doesNotMatch(again.out, /config_drift/);
  } finally {
    cleanup(dir);
  }
});

test('sync-agents prints the Overpass reset report and writes it into the live config; a model conflict exits 2 naming the role and the --model-choice flag, then the answer resolves it', () => {
  const dir = project(JSON.stringify({ applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23'], mode: 'hobby', overpass: { enabled: false, roles: { reviewer: { tier: 'agentic-low' } } } }));
  const conflict = project(JSON.stringify({ mode: 'hobby', models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } } }));
  try {
    const r = sync(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /config migration: overpass\.roles removed/);
    assert.equal(JSON.parse(read(dir)).overpass.roles, undefined);
    const before = read(conflict);
    const refused = sync(conflict);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /refused_model_conflicts: reviewer .*--model-choice reviewer=claude\|opencode/);
    assert.equal(read(conflict), before, 'nothing is written while a conflict is open');
    const answered = spawnSync(process.execPath, [join(repo, 'scripts', 'sync-agents.mjs'), '--target', conflict, '--model-choice', 'reviewer=claude'], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, STERLING_CLAUDE_PROBE: 'ok', STERLING_OPENCODE_SETUP_DISABLE: '1' },
    });
    assert.equal(answered.status, 0, `${answered.stdout}${answered.stderr}`);
    assert.deepEqual(JSON.parse(read(conflict)).models.reviewer, { model: 'anthropic/claude-opus-5-5', effort: 'high' });
  } finally {
    cleanup(dir);
    cleanup(conflict);
  }
});
