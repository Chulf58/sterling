// The legacy-to-canonical config transform and the strict canonical write check (decision
// settings-redesign-build-shape-one-legacy-to-canonical-config, board 9a426293).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCanonicalConfig, parseCanonicalConfig, parseCanonicalModels, canonicalConfigSchema, LegacyConfigError, ProjectModeError, modeOfConfig } from '../index.js';

const canonical = (raw: unknown) => toCanonicalConfig(raw).config as Record<string, any>;
const accepts = (doc: unknown) => assert.equal(canonicalConfigSchema.safeParse(doc).success, true, JSON.stringify(canonicalConfigSchema.safeParse(doc).error?.issues));
const refuses = (doc: unknown, path: string) => {
  const r = canonicalConfigSchema.safeParse(doc);
  assert.equal(r.success, false, `expected ${JSON.stringify(doc)} to be refused`);
  assert.ok(r.error!.issues.some((i) => i.path.join('.') === path), `no issue at ${path}: ${JSON.stringify(r.error!.issues)}`);
};

test('{} becomes the hobby workflow, no conflicts, and parses to the shipped one-model defaults', () => {
  const r = toCanonicalConfig({});
  assert.deepEqual(r.config, { workflow: { merge: 'direct', reviewers: 1, copilot_loop: false, auto_merge_on_clean: true } });
  assert.deepEqual(r.conflicts, []);
  accepts(r.config);
  const parsed = parseCanonicalConfig({});
  assert.deepEqual(parsed.workflow, { merge: 'direct', reviewers: 1, copilot_loop: false, auto_merge_on_clean: true });
  assert.deepEqual(parsed.overpass, { provider: 'overpass' });
  assert.deepEqual(parsed.models.reviewer, { model: 'anthropic/claude-opus-5-5', effort: 'high' });
  assert.deepEqual(parsed.models.implementor, { model: 'anthropic/claude-sonnet-5-5', effort: 'medium' });
  assert.equal('mode' in parsed, false);
  assert.equal('sparring_partner' in parsed, false);
});

test('a hobby legacy config: direct merge, auto-merge kept, models one per agent, Codex settings dropped', () => {
  const legacy = {
    mode: 'hobby',
    pr_review: { copilot_logins: ['copilot-pull-request-reviewer[bot]'], auto_merge_on_clean: false },
    sparring_partner: { enabled: true, vendor: 'openai', model: 'gpt-5.6-sol' },
    models: {
      implementor: { model: 'claude-sonnet-5-5', effort: 'medium', agy_model: 'flash' },
      scout: { model: 'claude-sonnet-5-5', effort: 'low', hard_task: { model: 'claude-opus-5-5' } },
      'custom-team-helper': { opencode_model: 'openai/gpt-5.6-terra' },
      'custom-bare': {},
    },
  };
  const before = structuredClone(legacy);
  const r = toCanonicalConfig(legacy);
  assert.deepEqual(legacy, before, 'the caller object is never mutated');
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.config, {
    pr_review: { copilot_logins: ['copilot-pull-request-reviewer[bot]'] },
    workflow: { merge: 'direct', reviewers: 1, copilot_loop: false, auto_merge_on_clean: false },
    models: {
      implementor: { model: 'anthropic/claude-sonnet-5-5', effort: 'medium' },
      scout: { model: 'anthropic/claude-sonnet-5-5', effort: 'low' },
      'custom-team-helper': { model: 'openai/gpt-5.6-terra' },
      'custom-bare': {},
    },
  });
  const paths = r.changes.map((c) => c.path);
  for (const p of ['mode', 'pr_review.auto_merge_on_clean', 'sparring_partner', 'models.implementor.agy_model', 'models.scout.hard_task']) assert.ok(paths.includes(p), `change ${p} reported`);
  accepts(r.config);
});

test('a work legacy config: pull request, Copilot loop on, 3 reviewers; absent auto-merge stays on', () => {
  const doc = canonical({ mode: 'work' });
  assert.deepEqual(doc.workflow, { merge: 'pr', reviewers: 3, copilot_loop: true, auto_merge_on_clean: true });
  assert.equal(modeOfConfig(doc, 'test'), 'work', 'readProjectMode callers still read work from a canonical document');
  assert.equal(modeOfConfig(canonical({}), 'test'), 'hobby');
  accepts(doc);
});

test('effective Overpass carries each role\'s resolved tier, effort and bypass under the overpass/ namespace', () => {
  const legacy = {
    mode: 'work',
    overpass: { enabled: true, provider: 'gw', conductor_bypass: false, roles: { reviewer: { tier: 'agentic-premium', effort: 'max' }, scout: { effort: 'low' } } },
    models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } },
  };
  const r = toCanonicalConfig(legacy);
  assert.deepEqual(r.conflicts, [], 'an Overpass role ran on its tier, so its two legacy models are no conflict');
  const doc = r.config as Record<string, any>;
  assert.deepEqual(doc.overpass, { provider: 'gw' });
  assert.deepEqual(doc.models.reviewer, { model: 'overpass/agentic-premium', effort: 'max' }, 'explicit tier and max effort kept');
  assert.deepEqual(doc.models.scout, { model: 'overpass/agentic-auto', effort: 'low' }, 'explicit effort on the default tier');
  assert.deepEqual(doc.models.implementor, { model: 'overpass/agentic-auto', effort: 'medium' });
  assert.deepEqual(doc.models['implementor-hard'], { model: 'overpass/agentic-premium', effort: 'xhigh' });
  assert.deepEqual(doc.models.researcher, { model: 'overpass/agentic-high' }, 'no default effort stays unset');
  assert.deepEqual(doc.models['maintenance-worker'], { model: 'overpass/agentic-auto', effort: 'high' });
  assert.deepEqual(doc.models.plan, { model: 'overpass/agentic-high' });
  assert.deepEqual(doc.models.conductor, { model: 'overpass/agentic-conductor' }, 'bypass off: the conductor was routed');
  accepts(doc);

  const bypassed = canonical({ mode: 'work', overpass: { enabled: true, conductor_bypass: true } });
  assert.equal(bypassed.models.conductor, undefined, 'bypass on: the conductor keeps its own model');
  assert.deepEqual(bypassed.models.plan, { model: 'overpass/agentic-high' });
});

test('Overpass enabled but not effective (hobby project) gives no role a tier', () => {
  const r = toCanonicalConfig({ mode: 'hobby', overpass: { enabled: true, roles: { reviewer: { tier: 'agentic-premium' } } }, models: { scout: { model: 'claude-sonnet-5-5', effort: 'low' } } });
  const doc = r.config as Record<string, any>;
  assert.deepEqual(doc.overpass, {});
  assert.deepEqual(doc.models, { scout: { model: 'anthropic/claude-sonnet-5-5', effort: 'low' } });
  assert.ok(!JSON.stringify(doc).includes('overpass/'));
  assert.deepEqual(canonical({ overpass: { enabled: false, provider: 'gw' } }).overpass, { provider: 'gw' });
});

test('a reviewer with a Claude model and a different OpenCode model is a conflict, OpenCode proposed, never decided', () => {
  const legacy = { models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol' } } };
  const r = toCanonicalConfig(legacy);
  assert.deepEqual(r.conflicts, [{ role: 'reviewer', claude: { model: 'anthropic/claude-opus-5-5', effort: 'high' }, opencode: { model: 'openai/gpt-6.1-sol', effort: 'high' }, proposal: 'opencode' }]);
  assert.deepEqual((r.config as Record<string, any>).models.reviewer, { model: 'openai/gpt-6.1-sol', effort: 'high' });

  const claude = toCanonicalConfig(legacy, { resolutions: { reviewer: 'claude' } });
  assert.deepEqual(claude.conflicts, []);
  assert.deepEqual((claude.config as Record<string, any>).models.reviewer, { model: 'anthropic/claude-opus-5-5', effort: 'high' });
  assert.deepEqual(toCanonicalConfig(legacy, { resolutions: { reviewer: 'opencode' } }).conflicts, []);

  assert.throws(() => toCanonicalConfig(legacy, { resolutions: { scout: 'claude' } }), LegacyConfigError, 'a resolution for a role with no conflict is refused');
  const same = toCanonicalConfig({ models: { reviewer: { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'anthropic/claude-opus-5-5' } } });
  assert.deepEqual(same.conflicts, [], 'the same model twice is no conflict');
});

test('a canonical document comes back unchanged (the transform is idempotent)', () => {
  const once = canonical({ mode: 'work', pr_review: { auto_merge_on_clean: false }, overpass: { enabled: true }, models: { scout: { model: 'claude-sonnet-5-5', effort: 'low' } } });
  const twice = toCanonicalConfig(once);
  assert.deepEqual(twice.config, once);
  assert.deepEqual(twice.changes, []);
  assert.deepEqual(twice.conflicts, []);
});

test('a legacy value the transform cannot carry throws instead of guessing', () => {
  assert.throws(() => toCanonicalConfig({ mode: 'weekend' }), ProjectModeError);
  assert.throws(() => toCanonicalConfig({ pr_review: { auto_merge_on_clean: 'yes' } }), LegacyConfigError);
  assert.throws(() => toCanonicalConfig({ overpass: { enabled: 'yes' } }), /overpass\.enabled/);
});

test('max effort is valid only on an Overpass tier, and an overpass/ model must name a tier', () => {
  accepts({ models: { sparring: { model: 'overpass/agentic-premium-max', effort: 'max' } } });
  refuses({ models: { sparring: { model: 'anthropic/claude-opus-5-5', effort: 'max' } } }, 'models.sparring.effort');
  refuses({ models: { sparring: { model: 'overpass/premium' } } }, 'models.sparring.model');
});

test('an invalid new write is refused by the strict canonical schema, legacy keys included', () => {
  refuses({ mode: 'work' }, 'mode');
  refuses({ sparring_partner: { enabled: true } }, 'sparring_partner');
  refuses({ pr_review: { auto_merge_on_clean: true } }, 'pr_review.auto_merge_on_clean');
  refuses({ workflow: { reviewers: 6 } }, 'workflow.reviewers');
  refuses({ workflow: { reviewers: 0 } }, 'workflow.reviewers');
  refuses({ workflow: { merge: 'squash' } }, 'workflow.merge');
  refuses({ workflow: { copilot_loop: 'on' } }, 'workflow.copilot_loop');
  refuses({ overpass: { enabled: true } }, 'overpass');
  refuses({ models: { reviewer: { model: 'claude-opus-5-5', effort: 'high' } } }, 'models.reviewer.model');
  refuses({ models: { reviewer: { model: 'openai/gpt-6.1-sol', opencode_model: 'openai/gpt-6.1-sol' } } }, 'models.reviewer');
  refuses({ models: { researcher: { effort: 'low' } } }, 'models.researcher.model');
  accepts({ models: { 'custom-x': {} }, workflow: { merge: 'pr', reviewers: 5, copilot_loop: true } });
});

test('the partial models reader goes through the same transform', () => {
  const models = parseCanonicalModels({ models: { scout: { model: 'claude-sonnet-5-5', effort: 'low', agy_model: 'claude-opus-5-5-high' } } });
  assert.deepEqual(models.scout, { model: 'anthropic/claude-sonnet-5-5', effort: 'low' });
  assert.deepEqual(models.librarian, { model: 'anthropic/claude-haiku-5-5', effort: 'low' });
});
