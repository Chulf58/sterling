import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, resolveOverpass, resetOverpassDefaults, OVERPASS_DEFAULTS_MIGRATION_ID, migrateRetiredModelKeys, unreadConfigKeys, MAINTENANCE_WORKER_ROLE, DEFAULT_OVERPASS_ROLE_TIERS, DEFAULT_OVERPASS_ROLE_EFFORTS, OVERPASS_EFFORTS, OVERPASS_ROLES, OVERPASS_TIERS, OVERPASS_TIER_RE, judgeProjectMode, ProjectModeError } from '../index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shippedRaw = (): Record<string, unknown> => JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'));

const on = (extra: Record<string, unknown> = {}) => ({ mode: 'work', overpass: { enabled: true, ...extra } });

// Deliberate default change (user-ruled 2026-10-23, 'Defaults + reset + bypass ON'): conductor_bypass is true by default.
test('overpass: the schema default and templates/default-config.json agree, and both are off with the conductor bypassed', () => {
  const expected = { enabled: false, provider: 'overpass', conductor_bypass: true };
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
    conductorRouted: false,
    provider: 'overpass',
    conductorModel: 'overpass/agentic-conductor',
    laneModel: 'overpass/agentic-high',
    // Changed 2026-10-24 (decision overpass-default-effort-per-role-high-for-agentic-auto-roles): the
    // roles with a default effort now carry it; reviewer and researcher carry none.
    roles: {
      implementor: { model: 'overpass/agentic-auto', effort: 'high' },
      'implementor-hard': { model: 'overpass/agentic-premium', effort: 'xhigh' },
      researcher: { model: 'overpass/agentic-high' },
      scout: { model: 'overpass/agentic-auto', effort: 'high' },
      reviewer: { model: 'overpass/agentic-high' },
      librarian: { model: 'overpass/agentic-auto', effort: 'high' },
      sparring: { model: 'overpass/agentic-premium-max', effort: 'xhigh' },
      preflight: { model: 'overpass/agentic-auto', effort: 'high' },
      // the maintenance worker's own role (board c97ddc97), not a subagent
      'maintenance-worker': { model: 'overpass/agentic-auto', effort: 'high' },
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
  // an overpass block that omits the key reads as bypassed (user-ruled 2026-10-23, 'Defaults + reset + bypass ON')
  assert.equal(resolveOverpass(on(), { host: 'opencode' }).conductorRouted, false);
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
// scout, librarian, preflight and maintenance-worker moved to agentic-auto (user-ruled 2026-10-23, 'Defaults + reset + bypass ON').
// Changed 2026-10-24 (decision overpass-default-effort-per-role-high-for-agentic-auto-roles): unset now
// gives each role's default effort too (title and expectations), not "no effort".
test('overpass roles: unset gives the per-role default tier and default effort (implementor, scout, librarian, preflight and maintenance-worker auto, implementor-hard premium, sparring premium-max, researcher and reviewer high)', () => {
  const expected = {
    implementor: { model: 'overpass/agentic-auto', effort: 'high' },
    'implementor-hard': { model: 'overpass/agentic-premium', effort: 'xhigh' },
    researcher: { model: 'overpass/agentic-high' },
    scout: { model: 'overpass/agentic-auto', effort: 'high' },
    reviewer: { model: 'overpass/agentic-high' },
    librarian: { model: 'overpass/agentic-auto', effort: 'high' },
    sparring: { model: 'overpass/agentic-premium-max', effort: 'xhigh' },
    preflight: { model: 'overpass/agentic-auto', effort: 'high' },
    'maintenance-worker': { model: 'overpass/agentic-auto', effort: 'high' },
  };
  for (const cfg of [on(), on({ roles: {} }), on({ roles: { reviewer: {} } }), on({ roles: { implementor: {} } }), on({ roles: { sparring: {} } })]) {
    const r = resolveOverpass(cfg, { host: 'opencode' });
    assert.equal(r.laneModel, 'overpass/agentic-high', 'Plan stays on agentic-high');
    assert.deepEqual(r.roles, expected, JSON.stringify(cfg));
  }
});

test('overpass roles: the premium tiers are accepted as an explicit tier and an explicit tier replaces the role default', () => {
  const r = resolveOverpass(on({ roles: { scout: { tier: 'agentic-premium-max' }, researcher: { tier: 'agentic-premium' }, reviewer: { tier: 'agentic-premium-max' }, sparring: { tier: 'agentic-high', effort: 'high' }, implementor: { tier: 'agentic-premium-max', effort: 'max' } } }), { host: 'opencode' });
  // Changed 2026-10-24: an explicit tier keeps the role's default effort (scout: high).
  assert.deepEqual(r.roles.scout, { model: 'overpass/agentic-premium-max', effort: 'high' });
  assert.deepEqual(r.roles.researcher, { model: 'overpass/agentic-premium' });
  assert.deepEqual(r.roles.reviewer, { model: 'overpass/agentic-premium-max' });
  assert.deepEqual(r.roles.sparring, { model: 'overpass/agentic-high', effort: 'high' });
  assert.deepEqual(r.roles.implementor, { model: 'overpass/agentic-premium-max', effort: 'max' });
});

test('overpass roles: a tier and an effort apply to that role only, under the configured provider', () => {
  const r = resolveOverpass(on({ provider: 'overpass-agentic', roles: { reviewer: { tier: 'agentic-max', effort: 'xhigh' }, scout: { effort: 'low' } } }), { host: 'opencode' });
  assert.deepEqual(r.roles.reviewer, { model: 'overpass-agentic/agentic-max', effort: 'xhigh' });
  assert.deepEqual(r.roles.scout, { model: 'overpass-agentic/agentic-auto', effort: 'low' });
  // Changed 2026-10-24 (decision overpass-default-effort-per-role-high-for-agentic-auto-roles): a role
  // with no effort set now takes its default effort, high for the implementor.
  assert.deepEqual(r.roles.implementor, { model: 'overpass-agentic/agentic-auto', effort: 'high' });
  assert.equal(r.laneModel, 'overpass-agentic/agentic-high', 'Plan keeps the default lane model');
});

// Decision knowledge-pre-flight-agent-sterling-preflight-a-read-only-la: preflight is its own
// Overpass role, on agentic-auto by default (agentic-high until 2026-10-23), and takes its own tier and effort.
test('overpass roles: preflight is a role that defaults to agentic-auto and takes its own tier and effort', () => {
  assert.ok((OVERPASS_ROLES as readonly string[]).includes('preflight'));
  assert.equal(DEFAULT_OVERPASS_ROLE_TIERS.preflight, 'agentic-auto');
  const r = resolveOverpass(on({ roles: { preflight: { tier: 'agentic-low', effort: 'low' } } }), { host: 'opencode' });
  assert.deepEqual(r.roles.preflight, { model: 'overpass/agentic-low', effort: 'low' });
  // Changed 2026-10-24: the scout's default effort (high) now rides with its own tier.
  assert.deepEqual(r.roles.scout, { model: 'overpass/agentic-auto', effort: 'high' }, 'the scout keeps its own tier and default effort');
});

// Decision hard-implementor-is-its-own-agent-sterling-implementor-hard: implementor-hard is its
// own role, on the implementor's tier by default, so the two can run on different tiers.
test('overpass roles: implementor-hard defaults to agentic-premium, the implementor to agentic-auto, and each takes its own tier and effort', () => {
  assert.equal(DEFAULT_OVERPASS_ROLE_TIERS['implementor-hard'], 'agentic-premium');
  assert.equal(DEFAULT_OVERPASS_ROLE_TIERS.implementor, 'agentic-auto');
  const r = resolveOverpass(on({ roles: { 'implementor-hard': { tier: 'agentic-premium-max', effort: 'xhigh' } } }), { host: 'opencode' });
  assert.deepEqual(r.roles['implementor-hard'], { model: 'overpass/agentic-premium-max', effort: 'xhigh' });
  // Changed 2026-10-24: the implementor's default effort (high) now rides with its own tier.
  assert.deepEqual(r.roles.implementor, { model: 'overpass/agentic-auto', effort: 'high' }, 'the implementor keeps its own tier and default effort');
  const s = resolveOverpass(on({ roles: { implementor: { tier: 'agentic-high' } } }), { host: 'opencode' });
  // Changed 2026-10-24: implementor-hard's default effort (xhigh) now rides with its own tier.
  assert.deepEqual(s.roles['implementor-hard'], { model: 'overpass/agentic-premium', effort: 'xhigh' }, 'an implementor tier does not move implementor-hard');
  assert.throws(() => resolveOverpass(on({ roles: { implementor_hard: {} } }), { host: 'opencode' }), /unknown role "implementor_hard"/);
});

// Decision overpass-default-effort-per-role-high-for-agentic-auto-roles (user-ruled 2026-10-24, GitHub #203).
test('overpass roles: a role with no effort set takes its default effort; reviewer and researcher send none', () => {
  const r = resolveOverpass(on({}), { host: 'opencode' });
  const efforts = Object.fromEntries(OVERPASS_ROLES.map((role) => [role, r.roles[role].effort]));
  assert.deepEqual(efforts, {
    implementor: 'high',
    'implementor-hard': 'xhigh',
    researcher: undefined,
    scout: 'high',
    reviewer: undefined,
    librarian: 'high',
    sparring: 'xhigh',
    preflight: 'high',
    'maintenance-worker': 'high',
  });
  assert.ok(!Object.hasOwn(r.roles.reviewer, 'effort'), 'no effort key at all for a role with no default');
  assert.ok(!Object.hasOwn(r.roles.researcher, 'effort'));
});

test('overpass roles: no default effort is ever max, and each is a known effort', () => {
  for (const role of OVERPASS_ROLES) {
    const effort = DEFAULT_OVERPASS_ROLE_EFFORTS[role];
    if (effort === undefined) continue;
    assert.notEqual(effort, 'max', role);
    assert.ok((OVERPASS_EFFORTS as readonly string[]).includes(effort), role);
    assert.notEqual(resolveOverpass(on({}), { host: 'opencode' }).roles[role].effort, 'max', role);
  }
  assert.deepEqual(Object.keys(DEFAULT_OVERPASS_ROLE_EFFORTS).filter((k) => !(OVERPASS_ROLES as readonly string[]).includes(k)), [], 'every key is a role');
});

test('overpass roles: an explicit effort overrides the role default, and a role with no default takes one too', () => {
  const r = resolveOverpass(on({ roles: { implementor: { effort: 'low' }, 'implementor-hard': { effort: 'medium' }, sparring: { effort: 'max' }, reviewer: { effort: 'xhigh' } } }), { host: 'opencode' });
  assert.equal(r.roles.implementor.effort, 'low', 'an explicit effort below the default wins');
  assert.equal(r.roles['implementor-hard'].effort, 'medium');
  assert.equal(r.roles.sparring.effort, 'max', 'an explicit max is the project\'s choice and still allowed');
  assert.equal(r.roles.reviewer.effort, 'xhigh', 'a role with no default takes an explicit effort');
  assert.equal(r.roles.scout.effort, 'high', 'untouched roles keep their default');
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

// Board c97ddc97 (user-ruled 2026-10-23, "Row + its own Overpass tier"): the background maintenance
// worker is an Overpass role of its own, default agentic-auto (agentic-high until 2026-10-23), that no installed agent carries.
test('overpass roles: maintenance-worker is a role that defaults to agentic-auto and takes its own tier and effort', () => {
  assert.ok((OVERPASS_ROLES as readonly string[]).includes(MAINTENANCE_WORKER_ROLE));
  assert.equal(DEFAULT_OVERPASS_ROLE_TIERS[MAINTENANCE_WORKER_ROLE], 'agentic-auto');
  const set = resolveOverpass(on({ roles: { 'maintenance-worker': { tier: 'agentic-premium', effort: 'xhigh' } } }), { host: 'opencode' });
  assert.deepEqual(set.roles['maintenance-worker'], { model: 'overpass/agentic-premium', effort: 'xhigh' });
  assert.deepEqual(set.roles.reviewer, { model: 'overpass/agentic-high' }, 'no other role moves');
});

test('config: models.classifiers is a retired key — dropped by parse, reported by the migration, never defaulted', () => {
  const raw = { models: { classifiers: { model: 'claude-haiku-5-5', effort: 'low' }, implementor: { model: 'claude-sonnet-5-5', effort: 'high' } } };
  const parsed = parseConfig(raw);
  assert.ok(!('classifiers' in parsed.models), 'a live classifiers entry is dropped before the parse');
  assert.ok(!('classifiers' in parseConfig({}).models), 'the schema carries no classifiers default');
  const m = migrateRetiredModelKeys(raw);
  assert.equal(m.changed, true);
  assert.deepEqual(m.dropped, [{ key: 'classifiers', value: { model: 'claude-haiku-5-5', effort: 'low' } }]);
  assert.deepEqual(Object.keys((m.config as { models: object }).models), ['implementor']);
  assert.deepEqual(unreadConfigKeys(raw), [{ path: 'models.classifiers' }]);
});

// ── the one-time reset of every project's Overpass overrides (user-ruled 2026-10-23, 'Defaults + reset + bypass ON') ──

test('resetOverpassDefaults: removes overpass.roles, sets conductor_bypass true, records its id and touches nothing else', () => {
  const raw = { mode: 'work', models: { reviewer: { model: 'claude-opus-5-5' } }, overpass: { enabled: true, provider: 'acme', conductor_bypass: false, roles: { reviewer: { tier: 'agentic-max', effort: 'high' } } }, applied_config_migrations: ['model-defaults-2026-10-23'] };
  const r = resetOverpassDefaults(raw);
  assert.equal(r.changed, true);
  assert.deepEqual(r.rolesRemoved, { value: { reviewer: { tier: 'agentic-max', effort: 'high' } } });
  assert.deepEqual(r.bypassSet, { was: false });
  assert.deepEqual(r.config, { mode: 'work', models: { reviewer: { model: 'claude-opus-5-5' } }, overpass: { enabled: true, provider: 'acme', conductor_bypass: true }, applied_config_migrations: ['model-defaults-2026-10-23', OVERPASS_DEFAULTS_MIGRATION_ID] });
  assert.deepEqual(raw.overpass.roles, { reviewer: { tier: 'agentic-max', effort: 'high' } }, 'the input is not mutated');
});

test('resetOverpassDefaults: an absent overpass block or an unset bypass is filled in; nothing to remove or set still records the id', () => {
  const none = resetOverpassDefaults({ mode: 'hobby' });
  assert.deepEqual(none.config, { mode: 'hobby', overpass: { conductor_bypass: true }, applied_config_migrations: [OVERPASS_DEFAULTS_MIGRATION_ID] });
  assert.equal(none.rolesRemoved, undefined);
  assert.deepEqual(none.bypassSet, { was: undefined });
  const already = resetOverpassDefaults({ overpass: { enabled: false, conductor_bypass: true } });
  assert.equal(already.changed, true);
  assert.equal(already.rolesRemoved, undefined);
  assert.equal(already.bypassSet, undefined);
  assert.deepEqual(already.config, { overpass: { enabled: false, conductor_bypass: true }, applied_config_migrations: [OVERPASS_DEFAULTS_MIGRATION_ID] });
});

test('resetOverpassDefaults: runs once per file, so a roles override or a bypass switched off afterwards stays', () => {
  const after = { overpass: { enabled: true, conductor_bypass: false, roles: { scout: { tier: 'agentic-low' } } }, applied_config_migrations: [OVERPASS_DEFAULTS_MIGRATION_ID] };
  const r = resetOverpassDefaults(after);
  assert.equal(r.changed, false);
  assert.equal(r.config, after);
  const once = resetOverpassDefaults({ overpass: { roles: { scout: {} } } });
  assert.equal(resetOverpassDefaults(once.config).changed, false, 'idempotent');
});

test('resetOverpassDefaults: refuses an overpass that is not an object, and leaves a non-object or malformed-applied config alone', () => {
  for (const overpass of ['on', true, null, [], 3]) {
    const r = resetOverpassDefaults({ overpass });
    assert.equal(r.changed, false);
    assert.match(r.refusal ?? '', /config\.overpass is .*not an object/, JSON.stringify(overpass));
  }
  for (const raw of [null, [], 'x', { applied_config_migrations: 'x' }, { applied_config_migrations: [1] }]) {
    const r = resetOverpassDefaults(raw);
    assert.equal(r.changed, false);
    assert.equal(r.refusal, undefined);
  }
});
