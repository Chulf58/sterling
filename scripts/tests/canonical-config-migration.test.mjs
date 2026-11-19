// The canonical config migration through the existing planner (prepareCanonicalConfigMigration
// + commitConfigMigration), decision settings-redesign-build-shape-one-legacy-to-canonical-config.
// Temp dirs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectMode } from '@sterling/schemas';
import { CANONICAL_CONFIG_MIGRATION_ID, commitConfigMigration, prepareCanonicalConfigMigration, prepareConfigMigration } from '../lib/config-migration.mjs';

function project(doc) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-canonical-migration-'));
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n');
  return dir;
}
const read = (dir) => readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');

test('a work legacy config is rewritten canonical, reported, and reads as work afterwards; a second run is unchanged', (t) => {
  const dir = project({
    mode: 'work',
    pr_review: { copilot_logins: [], auto_merge_on_clean: false },
    models: { scout: { model: 'claude-sonnet-5-5', effort: 'low' } },
    applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23', 'overpass-defaults-2026-10-23'],
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = prepareCanonicalConfigMigration(dir);
  assert.equal(plan.status, 'ready', plan.lines.join('\n'));
  assert.ok(plan.lines.some((l) => l.includes('mode removed')), plan.lines.join('\n'));
  assert.equal(commitConfigMigration(plan).status, 'migrated');
  const doc = JSON.parse(read(dir));
  assert.equal(doc.mode, undefined);
  assert.deepEqual(doc.workflow, { merge: 'pr', reviewers: 3, copilot_loop: true, auto_merge_on_clean: false });
  assert.deepEqual(doc.models.scout, { model: 'anthropic/claude-sonnet-5-5', effort: 'low' });
  assert.ok(doc.applied_config_migrations.includes(CANONICAL_CONFIG_MIGRATION_ID));
  assert.equal(readProjectMode(dir), 'work');
  assert.equal(prepareCanonicalConfigMigration(dir).status, 'unchanged');
});

test('a document the legacy planner would refuse before migrating is carried, not rejected', (t) => {
  // A canonical model reference failed the legacy schema's Claude-id check; the canonical planner never runs it.
  // Changed with the cutover: parseConfig, which the legacy planner gates on, is canonical now and accepts it,
  // so the 'legacy planner refuses it' assertion below is gone; only the canonical planner's result is pinned.
  const dir = project({ mode: 'hobby', models: { 'custom-x': { model: 'openai/gpt-5.6-terra' } }, applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23', 'overpass-defaults-2026-10-23'] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = prepareCanonicalConfigMigration(dir);
  assert.equal(plan.status, 'ready', plan.lines.join('\n'));
});

test('a two-model role stops the plan until the caller answers it; nothing is written meanwhile', (t) => {
  const legacy = { models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } }, applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23', 'overpass-defaults-2026-10-23'] };
  const dir = project(legacy);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = read(dir);
  const plan = prepareCanonicalConfigMigration(dir);
  assert.equal(plan.status, 'conflicts');
  assert.deepEqual(plan.conflicts.map((c) => [c.role, c.claude.model, c.opencode.model, c.proposal]), [['reviewer', 'anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol', 'opencode']]);
  assert.match(plan.lines[0], /models\.reviewer has two models/);
  assert.equal(commitConfigMigration(plan).status, 'conflicts', 'a conflicts plan cannot be committed');
  assert.equal(read(dir), before);
  const answered = prepareCanonicalConfigMigration(dir, { resolutions: { reviewer: 'claude' } });
  assert.equal(answered.status, 'ready', answered.lines.join('\n'));
  commitConfigMigration(answered);
  assert.deepEqual(JSON.parse(read(dir)).models.reviewer, { model: 'anthropic/claude-opus-5-5', effort: 'high' });
});

// Changed with the cutover: the planner no longer runs addModelDefaults, which wrote the per-host
// opencode_model defaults of reviewer and sparring. A {} config has chosen no second model, so it migrates
// with no conflict to ask about, and the reviewer and sparring keep their one shipped model.
test('a {} config migrates with no model conflict and no per-host model fields', (t) => {
  const dir = project({});
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = prepareCanonicalConfigMigration(dir);
  assert.equal(plan.status, 'ready', plan.lines.join('\n'));
  assert.deepEqual(plan.conflicts ?? [], []);
  assert.ok(!JSON.stringify(plan.config).includes('opencode_model'));
  assert.deepEqual(plan.config.workflow, { merge: 'direct', reviewers: 1, copilot_loop: false, auto_merge_on_clean: true });
});

test('a canonical file with no migration id is not sent through the legacy steps', (t) => {
  const dir = project({ workflow: { merge: 'direct', reviewers: 1, copilot_loop: false, auto_merge_on_clean: true }, models: { reviewer: { model: 'anthropic/claude-opus-5-5', effort: 'high' } } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = prepareCanonicalConfigMigration(dir);
  assert.equal(plan.status, 'ready', plan.lines.join('\n'));
  assert.deepEqual(plan.config.models, { reviewer: { model: 'anthropic/claude-opus-5-5', effort: 'high' } }, 'no opencode_model or hard_task added back');
  assert.deepEqual(plan.config.applied_config_migrations, [CANONICAL_CONFIG_MIGRATION_ID]);
});

test('a legacy value that cannot be carried, or an invalid result, is refused and the file left as it is', (t) => {
  for (const doc of [{ mode: 'weekend' }, { pr_review: { auto_merge_on_clean: 'yes' } }, { models: { reviewer: { model: 'claude opus', effort: 'high' } }, applied_config_migrations: ['model-defaults-2026-10-23', 'implementor-hard-2026-10-23', 'overpass-defaults-2026-10-23'] }, '{not json']) {
    const dir = project(doc);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const before = read(dir);
    const plan = prepareCanonicalConfigMigration(dir);
    assert.equal(plan.status, 'refused', JSON.stringify(doc));
    assert.match(plan.lines[0], /left untouched/);
    assert.equal(read(dir), before);
  }
});
