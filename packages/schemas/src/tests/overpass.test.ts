import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, resolveOverpass, DEFAULT_OVERPASS_ROLE_TIERS, OVERPASS_TIERS, OVERPASS_TIER_RE, judgeProjectMode, ProjectModeError } from '../index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shippedRaw = (): Record<string, unknown> => JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'));

const on = (extra: Record<string, unknown> = {}) => ({ mode: 'work', overpass: { enabled: true, ...extra } });

test('overpass: the schema default and templates/default-config.json agree, and both are off', () => {
  const expected = { enabled: false, provider: 'overpass', conductor_bypass: false };
  assert.deepEqual((parseConfig({}) as unknown as { overpass: unknown }).overpass, expected);
  assert.deepEqual(shippedRaw().overpass, expected);
});

test('overpass: a missing key or missing fields resolve to the defaults, off', () => {
  for (const cfg of [{}, { overpass: {} }, { overpass: { provider: 'acme' } }]) {
    const r = resolveOverpass(cfg, { host: 'opencode' });
    assert.equal(r.configured, false);
    assert.equal(r.effective, false);
  }
  const d = resolveOverpass({}, { host: 'opencode' });
  assert.equal(d.provider, 'overpass');
  assert.equal(d.conductorModel, 'overpass/agentic-conductor');
  assert.equal(d.laneModel, 'overpass/agentic-high');
  assert.equal(d.conductorRouted, false);
  assert.equal(d.reason, undefined);
});

test('overpass: the shipped default resolves off', () => {
  const r = resolveOverpass(parseConfig(shippedRaw()), { host: 'opencode' });
  assert.equal(r.configured, false);
  assert.equal(r.effective, false);
});

test('overpass: effective only when enabled, work mode and the opencode host', () => {
  const r = resolveOverpass(on(), { host: 'opencode' });
  assert.deepEqual(r, {
    configured: true,
    effective: true,
    conductorRouted: true,
    provider: 'overpass',
    conductorModel: 'overpass/agentic-conductor',
    laneModel: 'overpass/agentic-high',
    roles: {
      implementor: { model: 'overpass/agentic-auto' },
      'implementor-hard': { model: 'overpass/agentic-premium' },
      researcher: { model: 'overpass/agentic-high' },
      scout: { model: 'overpass/agentic-high' },
      reviewer: { model: 'overpass/agentic-high' },
      librarian: { model: 'overpass/agentic-high' },
      sparring: { model: 'overpass/agentic-premium-max' },
    },
  });
});

test('overpass: enabled in hobby mode (or with no mode) is configured but not effective, with a reason', () => {
  for (const cfg of [{ mode: 'hobby', overpass: { enabled: true } }, { overpass: { enabled: true } }]) {
    const r = resolveOverpass(cfg, { host: 'opencode' });
    assert.equal(r.configured, true);
    assert.equal(r.effective, false);
    assert.match(r.reason ?? '', /work mode only/);
  }
});

test('overpass: enabled in work mode on the claude host (or any other) is not effective, with a reason', () => {
  for (const host of ['claude', 'codex', '']) {
    const r = resolveOverpass(on(), { host });
    assert.equal(r.configured, true);
    assert.equal(r.effective, false);
    assert.match(r.reason ?? '', /OpenCode only/);
  }
});

test('overpass: the provider is interpolated into both model ids', () => {
  const r = resolveOverpass(on({ provider: 'acme_ai-2.x' }), { host: 'opencode' });
  assert.equal(r.provider, 'acme_ai-2.x');
  assert.equal(r.conductorModel, 'acme_ai-2.x/agentic-conductor');
  assert.equal(r.laneModel, 'acme_ai-2.x/agentic-high');
});

test('overpass: an invalid enabled throws, naming the key and the value, whatever the mode or host', () => {
  for (const enabled of ['true', 1, null, [], {}]) {
    for (const [mode, host] of [['work', 'opencode'], ['hobby', 'claude']]) {
      assert.throws(
        () => resolveOverpass({ mode, overpass: { enabled } }, { host }),
        (err: Error) => err.message.includes('config.overpass.enabled') && err.message.includes(JSON.stringify(enabled)),
      );
    }
  }
});

test('overpass: an invalid provider throws, naming the key and the value', () => {
  for (const provider of ['', 'a/b', 'a#high', 'a b', '/x', 5, null, true, {}]) {
    assert.throws(
      () => resolveOverpass(on({ provider }), { host: 'opencode' }),
      (err: Error) => err.message.includes('config.overpass.provider') && err.message.includes(JSON.stringify(provider)),
    );
  }
});

test('overpass: a present overpass that is not an object throws', () => {
  for (const overpass of ['on', true, null, [], 3]) {
    assert.throws(
      () => resolveOverpass({ mode: 'work', overpass }, { host: 'opencode' }),
      (err: Error) => err.message.includes('config.overpass') && err.message.includes(JSON.stringify(overpass)),
    );
  }
});

test('overpass: an invalid mode throws when overpass is enabled (the strict mode judge), never reads as hobby', () => {
  assert.throws(
    () => resolveOverpass({ mode: 'wrok', overpass: { enabled: true } }, { host: 'opencode' }),
    ProjectModeError,
  );
});

test('judgeProjectMode: the pure judge behind readProjectMode', () => {
  assert.equal(judgeProjectMode(undefined, 'x'), 'hobby');
  assert.equal(judgeProjectMode('hobby', 'x'), 'hobby');
  assert.equal(judgeProjectMode('work', 'x'), 'work');
  assert.throws(() => judgeProjectMode('Work', 'somewhere'), /config\.mode is "Work" in somewhere/);
  assert.throws(() => judgeProjectMode(null, 'x'), ProjectModeError);
});

test('overpass: conductor_bypass true keeps effective but turns conductorRouted off', () => {
  const r = resolveOverpass(on({ conductor_bypass: true }), { host: 'opencode' });
  assert.equal(r.effective, true);
  assert.equal(r.conductorRouted, false);
  assert.equal(resolveOverpass(on({ conductor_bypass: false }), { host: 'opencode' }).conductorRouted, true);
});

test('overpass: conductorRouted is false whenever overpass is not effective, bypass or not', () => {
  for (const conductor_bypass of [true, false]) {
    assert.equal(resolveOverpass({ mode: 'hobby', overpass: { enabled: true, conductor_bypass } }, { host: 'opencode' }).conductorRouted, false);
    assert.equal(resolveOverpass(on({ conductor_bypass }), { host: 'claude' }).conductorRouted, false);
    assert.equal(resolveOverpass({ mode: 'work', overpass: { enabled: false, conductor_bypass } }, { host: 'opencode' }).conductorRouted, false);
  }
});

test('overpass: a non-boolean conductor_bypass throws, naming the key and the value, even when not effective', () => {
  for (const conductor_bypass of ['true', 1, null, [], {}]) {
    for (const [mode, host] of [['work', 'opencode'], ['hobby', 'claude']]) {
      assert.throws(
        () => resolveOverpass({ mode, overpass: { enabled: true, conductor_bypass } }, { host }),
        (err: Error) => err.message.includes('config.overpass.conductor_bypass') && err.message.includes(JSON.stringify(conductor_bypass)),
      );
    }
  }
});

// ── per-role tier and effort (config.overpass.roles) ─────────────────────────

// The implementor default moved from agentic-premium to agentic-auto (user-ruled 2026-10-23, "the regular
// implementer should run angentic-auto"); implementor-hard took agentic-premium.
test('overpass roles: unset gives the per-role default tier and no effort (implementor auto, implementor-hard premium, sparring premium-max, the rest high)', () => {
  const expected = {
    implementor: { model: 'overpass/agentic-auto' },
    'implementor-hard': { model: 'overpass/agentic-premium' },
    researcher: { model: 'overpass/agentic-high' },
    scout: { model: 'overpass/agentic-high' },
    reviewer: { model: 'overpass/agentic-high' },
    librarian: { model: 'overpass/agentic-high' },
    sparring: { model: 'overpass/agentic-premium-max' },
  };
  for (const cfg of [on(), on({ roles: {} }), on({ roles: { reviewer: {} } }), on({ roles: { implementor: {} } }), on({ roles: { sparring: {} } })]) {
    const r = resolveOverpass(cfg, { host: 'opencode' });
    assert.equal(r.laneModel, 'overpass/agentic-high', 'Plan and the worker stay on agentic-high');
    assert.deepEqual(r.roles, expected, JSON.stringify(cfg));
  }
});

test('overpass roles: the premium tiers are accepted as an explicit tier and an explicit tier replaces the role default', () => {
  const r = resolveOverpass(on({ roles: { scout: { tier: 'agentic-premium-max' }, researcher: { tier: 'agentic-premium' }, reviewer: { tier: 'agentic-premium-max' }, sparring: { tier: 'agentic-high', effort: 'high' }, implementor: { tier: 'agentic-premium-max', effort: 'max' } } }), { host: 'opencode' });
  assert.deepEqual(r.roles.scout, { model: 'overpass/agentic-premium-max' });
  assert.deepEqual(r.roles.researcher, { model: 'overpass/agentic-premium' });
  assert.deepEqual(r.roles.reviewer, { model: 'overpass/agentic-premium-max' });
  assert.deepEqual(r.roles.sparring, { model: 'overpass/agentic-high', effort: 'high' });
  assert.deepEqual(r.roles.implementor, { model: 'overpass/agentic-premium-max', effort: 'max' });
});

test('overpass roles: a tier and an effort apply to that role only, under the configured provider', () => {
  const r = resolveOverpass(on({ provider: 'overpass-agentic', roles: { reviewer: { tier: 'agentic-max', effort: 'xhigh' }, scout: { effort: 'low' } } }), { host: 'opencode' });
  assert.deepEqual(r.roles.reviewer, { model: 'overpass-agentic/agentic-max', effort: 'xhigh' });
  assert.deepEqual(r.roles.scout, { model: 'overpass-agentic/agentic-high', effort: 'low' });
  assert.deepEqual(r.roles.implementor, { model: 'overpass-agentic/agentic-auto' });
  assert.equal(r.laneModel, 'overpass-agentic/agentic-high', 'Plan and the worker keep the default lane model');
});

// Decision hard-implementor-is-its-own-agent-sterling-implementor-hard: implementor-hard is its
// own role, on the implementor's tier by default, so the two can run on different tiers.
test('overpass roles: implementor-hard defaults to agentic-premium, the implementor to agentic-auto, and each takes its own tier and effort', () => {
  assert.equal(DEFAULT_OVERPASS_ROLE_TIERS['implementor-hard'], 'agentic-premium');
  assert.equal(DEFAULT_OVERPASS_ROLE_TIERS.implementor, 'agentic-auto');
  const r = resolveOverpass(on({ roles: { 'implementor-hard': { tier: 'agentic-premium-max', effort: 'xhigh' } } }), { host: 'opencode' });
  assert.deepEqual(r.roles['implementor-hard'], { model: 'overpass/agentic-premium-max', effort: 'xhigh' });
  assert.deepEqual(r.roles.implementor, { model: 'overpass/agentic-auto' }, 'the implementor keeps its own tier');
  const s = resolveOverpass(on({ roles: { implementor: { tier: 'agentic-high' } } }), { host: 'opencode' });
  assert.deepEqual(s.roles['implementor-hard'], { model: 'overpass/agentic-premium' }, 'an implementor tier does not move implementor-hard');
  assert.throws(() => resolveOverpass(on({ roles: { implementor_hard: {} } }), { host: 'opencode' }), /unknown role "implementor_hard"/);
});

test('overpass roles: every effort level is accepted', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(resolveOverpass(on({ roles: { implementor: { effort } } }), { host: 'opencode' }).roles.implementor.effort, effort);
  }
});

test('overpass roles: an unknown role, an unknown field or a bad value throws, even while off', () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /config\.overpass\.roles is \[\]/],
    [{ conductor: { effort: 'high' } }, /unknown role "conductor"/],
    [{ plan: {} }, /unknown role "plan"/],
    [{ 'sterling/reviewer': {} }, /unknown role "sterling\/reviewer"/],
    [{ reviewer: 'high' }, /roles\.reviewer is "high"/],
    [{ reviewer: { model: 'openai/gpt-6.1-sol' } }, /roles\.reviewer has the unknown field "model"/],
    [{ reviewer: { tier: 'high' } }, /roles\.reviewer\.tier is "high"/],
    [{ reviewer: { tier: 'agentic-High' } }, /roles\.reviewer\.tier/],
    [{ reviewer: { tier: 'agentic-high#x' } }, /roles\.reviewer\.tier/],
    [{ reviewer: { effort: 'extreme' } }, /roles\.reviewer\.effort is "extreme"/],
    [{ reviewer: { effort: 3 } }, /roles\.reviewer\.effort is 3/],
  ];
  for (const [roles, why] of cases) {
    assert.throws(() => resolveOverpass(on({ roles }), { host: 'opencode' }), why, JSON.stringify(roles));
    assert.throws(() => resolveOverpass({ overpass: { enabled: false, roles } }, { host: 'opencode' }), why, `off: ${JSON.stringify(roles)}`);
  }
});

test('overpass roles: parseConfig keeps an invalid roles value raw instead of throwing', () => {
  const raw = { overpass: { enabled: true, roles: { conductor: { effort: 'nope' } } } };
  assert.deepEqual((parseConfig(raw) as unknown as { overpass: unknown }).overpass, raw.overpass);
});

// The tiers the user listed (user-stated 2026-10-23), in that order; the System tab tier picker offers them.
test('OVERPASS_TIERS: the six listed tiers in order, each a valid tier name, covering every role default', () => {
  assert.deepEqual([...OVERPASS_TIERS], ['agentic-low', 'agentic-high', 'agentic-conductor', 'agentic-auto', 'agentic-premium', 'agentic-premium-max']);
  for (const tier of OVERPASS_TIERS) assert.match(tier, OVERPASS_TIER_RE);
  for (const tier of Object.values(DEFAULT_OVERPASS_ROLE_TIERS)) assert.ok((OVERPASS_TIERS as readonly string[]).includes(tier), tier);
});
