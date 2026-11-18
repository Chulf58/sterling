import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MODEL_KEY,
  AGENT_HOST_CAPABILITIES,
  AGY_MODEL_IDS,
  OVERPASS_ROLES,
  addModelDefaults,
  configSchema,
  customAgentKey,
  customAgentSlug,
  discoveredAgentId,
  isCustomAgentKey,
  parseConfig,
  parseDiscoveredAgentId,
  resolveHostSettings,
} from '../index.js';

// ── identity ──
test('discovered identity is host plus full relative path; same name on two hosts stays distinct', () => {
  assert.equal(discoveredAgentId('opencode', 'team/scout'), 'opencode:team/scout');
  assert.notEqual(discoveredAgentId('claude', 'scout'), discoveredAgentId('opencode', 'scout'));
  assert.deepEqual(parseDiscoveredAgentId('agy:team/scout'), { host: 'agy', name: 'team/scout' });
  assert.equal(parseDiscoveredAgentId('nohost'), null);
  assert.equal(parseDiscoveredAgentId('vim:scout'), null);
});

test('adopted key: custom- plus the path slug; the namespace holds no governed role', () => {
  assert.equal(customAgentKey('team/scout'), 'custom-team-scout');
  assert.equal(customAgentKey('Team/Scout_2'), 'custom-team-scout-2');
  assert.equal(customAgentSlug('///'), null);
  assert.equal(customAgentSlug('a'.repeat(65)), null);
  // team/scout and team-scout share a slug: planAdoption refuses the second explicitly.
  assert.equal(customAgentKey('team/scout'), customAgentKey('team-scout'));
  for (const governed of [...Object.keys(AGENT_MODEL_KEY), ...OVERPASS_ROLES, 'conductor', 'plan']) {
    assert.equal(isCustomAgentKey(governed), false, governed);
    assert.equal(customAgentKey(governed)?.startsWith('custom-'), true);
  }
});

// ── config ──
test('governed roles keep their defaults byte for byte and still need model and effort', () => {
  assert.deepEqual(parseConfig({}).models.implementor, { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.throws(() => parseConfig({ models: { implementor: { model: 'claude-sonnet-5-5' } } }), /effort/);
  assert.throws(() => parseConfig({ models: { 'my-agent': { model: 'claude-sonnet-5-5' } } }), /effort/, 'a non-custom catchall key keeps both required');
  assert.throws(() => parseConfig({ models: { 'my-agent': { effort: 'low' } } }), /model/);
  assert.doesNotThrow(() => parseConfig({ models: { 'my-agent': { model: 'claude-sonnet-5-5', effort: 'low' } } }));
});

test('a custom-<slug> entry may omit model and effort; what it holds is validated strictly', () => {
  const m = parseConfig({ models: { 'custom-team-scout': {} } }).models['custom-team-scout'];
  assert.deepEqual(m, {});
  assert.deepEqual(parseConfig({ models: { 'custom-x': { effort: 'high' } } }).models['custom-x'], { effort: 'high' });
  assert.deepEqual(parseConfig({ models: { 'custom-x': { agy_model: 'flash' } } }).models['custom-x'], { agy_model: 'flash' });
  for (const bad of [{ model: 'has space' }, { effort: 'max' }, { junk: 1 }, { opencode_model: 'nope' }, { agy_model: 'claude-opus-5-5-high' }]) {
    const raw = { models: { 'custom-x': bad } };
    // a stale agy_model is dropped on load (the existing tolerance); every other bad value fails the parse
    if ('agy_model' in bad) assert.doesNotThrow(() => parseConfig(raw));
    else assert.throws(() => configSchema.parse(raw), /./, JSON.stringify(bad));
  }
});

test('custom entries reach the partial-schema reader of the dispatch resolver unchanged', () => {
  const raw = { 'custom-x': { opencode_model: 'openai/gpt-5.6-terra' } };
  const parsed = configSchema.shape.models.safeParse(raw);
  assert.equal(parsed.success, true);
});

test('addModelDefaults leaves a custom entry alone', () => {
  const raw = { models: { 'custom-x': {} } };
  const out = addModelDefaults(raw) as { config: { models: Record<string, unknown> } };
  assert.deepEqual(out.config.models['custom-x'], {});
});

// ── capabilities ──
test('capability table: Claude catalog model + low/medium/high, OpenCode model without effort, agy four values without effort', () => {
  assert.equal(AGENT_HOST_CAPABILITIES.claude.model.kind, 'claude_catalog');
  assert.deepEqual([...AGENT_HOST_CAPABILITIES.claude.effortLevels], ['low', 'medium', 'high']);
  assert.equal(AGENT_HOST_CAPABILITIES.opencode.model.kind, 'opencode_ref');
  assert.deepEqual([...AGENT_HOST_CAPABILITIES.opencode.effortLevels], []);
  assert.deepEqual([...(AGENT_HOST_CAPABILITIES.agy.model.values ?? [])], [...AGY_MODEL_IDS]);
  assert.deepEqual([...AGENT_HOST_CAPABILITIES.agy.effortLevels], []);
});

test('resolver: effective model and effort per host, inherit for an empty entry', () => {
  const full = { model: 'claude-opus-5-5', effort: 'high', opencode_model: 'openai/gpt-6.1-sol', agy_model: 'pro' };
  assert.deepEqual(resolveHostSettings(full, 'claude'), { host: 'claude', model: 'claude-opus-5-5', modelFrom: 'model', effort: 'high', modelSupported: true, effortSupported: true });
  assert.deepEqual(resolveHostSettings(full, 'opencode'), { host: 'opencode', model: 'openai/gpt-6.1-sol', modelFrom: 'override', modelSupported: true, effortSupported: false, effortIgnored: 'high' });
  assert.deepEqual(resolveHostSettings(full, 'agy'), { host: 'agy', model: 'pro', modelFrom: 'override', modelSupported: true, effortSupported: false, effortIgnored: 'high' });
  assert.equal(resolveHostSettings({ model: 'claude-sonnet-5-5' }, 'opencode').model, 'anthropic/claude-sonnet-5-5');
  assert.equal(resolveHostSettings({ model: 'claude-sonnet-5-5' }, 'agy').model, 'inherit');
  for (const host of ['claude', 'opencode', 'agy'] as const) {
    const r = resolveHostSettings(undefined, host);
    assert.equal(r.model, 'inherit');
    assert.equal(r.modelFrom, 'inherit');
    assert.equal(r.effort, undefined);
  }
  assert.equal(resolveHostSettings({ effort: 'xhigh' }, 'claude').effortIgnored, 'xhigh');
});
