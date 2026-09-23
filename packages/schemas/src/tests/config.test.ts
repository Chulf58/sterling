import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('shipped default config parses and carries the spec defaults (§12, §7.2)', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')));
  // Exact pinned IDs, never bare tier aliases (a127e6e1's mechanism, still
  // binding). The VALUES track the newest generation per the stay-current posture
  // (738253b2) — bumped 4.x -> 5 on 2026-07-26, so this pair is expected to change
  // on each generational bump; the assertion exists to catch an accidental drift to
  // an alias or a stale pin, not to freeze a version.
  // implementor -> claude-opus-5-5 per decision implementor-default-model-opus-5-5;
  // researcher, scout and librarian stay on claude-sonnet-5.
  assert.equal(shipped.models.implementor.model, 'claude-opus-5-5');
  // medium: Anthropic's Opus 5.5 launch default effort (finding 6a9b16a1).
  assert.equal(shipped.models.implementor.effort, 'medium');
  // The schema's per-key defaults are the effective default for every project
  // whose config omits a models key; they must match the shipped file, or a bump
  // to one silently misses projects that inherit from the other.
  assert.deepEqual(parseConfig({}).models, shipped.models, 'schema models defaults match templates/default-config.json');
  for (const [role, v] of Object.entries(shipped.models)) {
    assert.match(v.model, /^claude-(opus|sonnet|haiku)-[0-9]/, `${role}: exact pinned id, never a bare tier alias (a127e6e1)`);
  }
  for (const role of Object.values(shipped.models)) {
    assert.notEqual(role.effort, 'max', 'max effort is never used for subagents (§7.2 hard rule)');
  }
  assert.equal(shipped.staleness.research_days.fast, 30);
});

test('empty config gets full defaults; malformed config fails loud', () => {
  const empty = parseConfig({});
  assert.equal(empty.context_watch.conductor.soft_pct, 35);
  assert.throws(() => parseConfig({ context_watch: { conductor: { soft_pct: 'thirty' } } }));
  assert.throws(() => parseConfig({ models: { implementor: { model: 'sonnet', effort: 'max' } } }), /invalid/i);
});

// ------------------- session_events config (run r-0501, AC7 / interface slice 3) -------------------

// session_events is a new config block; access it through a cast so referencing it here
// does not require the field to exist at compile time — the assertions below fail cleanly
// (not the package build) until parseConfig grows the default.
type CfgWithEvents = { session_events?: { research_agents?: string[] } };

test('session_events.research_agents: default [researcher, claude-code-guide] from an empty config', () => {
  const empty = parseConfig({}) as unknown as CfgWithEvents;
  assert.ok(empty.session_events, 'parseConfig defaults must add session_events');
  assert.deepEqual(empty.session_events?.research_agents, ['researcher', 'claude-code-guide']);
});

test('session_events.research_agents: explicit list overrides the default; a non-array is rejected loud', () => {
  const overridden = parseConfig({ session_events: { research_agents: ['claude-code-guide'] } }) as unknown as CfgWithEvents;
  assert.ok(overridden.session_events, 'supplied session_events survives parsing');
  assert.deepEqual(overridden.session_events?.research_agents, ['claude-code-guide']);
  assert.throws(() => parseConfig({ session_events: { research_agents: 'researcher' } }), /invalid/i, 'research_agents must be a string array');
});

test('templates/default-config.json carries the shipped session_events default and still parses', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'))) as unknown as CfgWithEvents;
  assert.ok(shipped.session_events, 'the shipped default-config carries session_events');
  assert.deepEqual(shipped.session_events?.research_agents, ['researcher', 'claude-code-guide']);
});

// ------------------- models_catalog config (run r-ea9e, AC7 / TUI System tab) -------------------

// models_catalog is a NEW top-level config block (distinct from the existing `staleness` block).
// Accessed through a cast so referencing it here does not require the field at compile time —
// assertions fail cleanly (not the package build) until parseConfig grows the default.
type CfgWithCatalog = { models_catalog?: { staleness_days?: number } };

test('models_catalog.staleness_days: default 45 from an empty config', () => {
  const empty = parseConfig({}) as unknown as CfgWithCatalog;
  assert.ok(empty.models_catalog, 'parseConfig defaults must add a models_catalog block');
  assert.equal(empty.models_catalog?.staleness_days, 45, 'models_catalog.staleness_days defaults to 45');
});

test('models_catalog.staleness_days: an explicit override parses; a non-number is rejected loud', () => {
  const overridden = parseConfig({ models_catalog: { staleness_days: 14 } }) as unknown as CfgWithCatalog;
  assert.ok(overridden.models_catalog, 'supplied models_catalog survives parsing');
  assert.equal(overridden.models_catalog?.staleness_days, 14, 'an explicit staleness_days overrides the 45 default');
  assert.throws(
    () => parseConfig({ models_catalog: { staleness_days: 'soon' } }),
    /invalid/i,
    'staleness_days must be a number — a non-number fails loud'
  );
});

test('templates/default-config.json carries the shipped models_catalog block and still parses', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'))) as unknown as CfgWithCatalog;
  assert.ok(shipped.models_catalog, 'the shipped default-config carries a models_catalog block');
  assert.equal(shipped.models_catalog?.staleness_days, 45, 'the shipped models_catalog.staleness_days is 45');
});

test('conductor pressure thresholds (recalibrated 2026-08-11, user-decided): defaults 35/50, tunable, shipped in the default config', () => {
  const empty = parseConfig({});
  assert.equal(empty.context_watch.conductor.soft_pct, 35, 'soft default 35');
  assert.equal(empty.context_watch.conductor.hard_pct, 50, 'hard default 50');
  const custom = parseConfig({ context_watch: { conductor: { soft_pct: 50, hard_pct: 70 } } });
  assert.equal(custom.context_watch.conductor.soft_pct, 50);
  assert.equal(custom.context_watch.conductor.hard_pct, 70);
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')));
  assert.equal(shipped.context_watch.conductor.soft_pct, 35, 'shipped default carries the conductor block');
  assert.equal(shipped.context_watch.conductor.hard_pct, 50);
});

test('conductor pressure: shipped windows map carries verified per-model context windows (live probe 2026-08-09 — 200k default misclassified a 1M-window session)', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')));
  assert.equal(shipped.context_watch.windows['claude-fable-5'], 1_000_000);
  assert.equal(shipped.context_watch.windows['claude-opus-5'], 1_000_000);
  assert.equal(shipped.context_watch.windows['claude-sonnet-5'], 1_000_000);
  assert.equal(shipped.context_watch.windows['claude-haiku-4-5'], 200_000);
  // Reversed by decision context-window-default-is-a-real-fallback (user-ruled
  // 2026-09-22, "Make it real: fall back to 1M"): a model with no per-model
  // entry now falls back to this window rather than reporting the fill as
  // unreliable — a per-model entry still always wins when one is present.
  assert.equal(shipped.context_watch.windows.default, 1_000_000, 'an unmapped model falls back to this real window');
});

test('parseConfig: an empty config seeds context_watch.windows.default at 1,000,000 (decision context-window-default-is-a-real-fallback)', () => {
  const empty = parseConfig({});
  assert.equal(empty.context_watch.windows.default, 1_000_000);
});

// ------------------- delivery.total_cap_bytes (H19 delivery per-delivery cap) -------------------

// delegation_watch (H10's hand-work-vs-dispatch advisory) was deleted along
// with H10's delegation-watch Stop seam in Slice 4 (decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1) — its config block and
// this section's former tests went with it. total_cap_bytes is a NEW field
// nested inside the existing delivery block (see the injection_rung/
// payload_char_cap tests elsewhere in this file for that block's other
// fields). scripts/hooks/lib/delivery.mjs's DELIVERY_TOTAL_CAP_DEFAULT (3000)
// mirrors this schema default; an absent/invalid value falls back there.
type CfgWithDelivery = { delivery?: { total_cap_bytes?: number; injection_rung?: string } };

test('delivery.injection_rung: defaults to read, and the shipped template says read', () => {
  const empty = parseConfig({}) as unknown as CfgWithDelivery;
  assert.equal(empty.delivery?.injection_rung, 'read', 'new projects inject before action by default');
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'))) as unknown as CfgWithDelivery;
  assert.equal(shipped.delivery?.injection_rung, 'read', 'the template must not override the schema default with prompt');
});

test('delivery.total_cap_bytes: defaults to 3000 from an empty config; 0 is a valid explicit "off"', () => {
  const empty = parseConfig({}) as unknown as CfgWithDelivery;
  assert.equal(empty.delivery?.total_cap_bytes, 3000, 'total_cap_bytes defaults to 3000');
  const off = parseConfig({ delivery: { total_cap_bytes: 0 } }) as unknown as CfgWithDelivery;
  assert.equal(off.delivery?.total_cap_bytes, 0, '0 (disabled) is a valid explicit nonnegative value');
});

test('delivery.total_cap_bytes: an explicit value is honored; negative and non-number fail loud', () => {
  const tuned = parseConfig({ delivery: { total_cap_bytes: 5000 } }) as unknown as CfgWithDelivery;
  assert.equal(tuned.delivery?.total_cap_bytes, 5000, 'an explicit value overrides the default');
  assert.throws(() => parseConfig({ delivery: { total_cap_bytes: -1 } }), 'negative is rejected — the field is nonnegative, not positive');
  assert.throws(() => parseConfig({ delivery: { total_cap_bytes: 'lots' } }), 'a non-number fails loud');
});

// ------------------- sparring_partner config (decision foreign_cd019e0b, sparring-partner-partnership-shape) -------------------

// sparring_partner is a NEW top-level config block, additive-optional: an
// absent block still parses with defaults ({enabled: true}). Accessed through
// a cast so referencing it here does not require the field to exist at
// compile time — the assertions below fail cleanly (not the package build)
// until parseConfig grows the block.
type CfgWithSparringPartner = { sparring_partner?: { enabled?: boolean } };

test('sparring_partner: absent block defaults to {enabled: true}', () => {
  const empty = parseConfig({}) as unknown as CfgWithSparringPartner;
  assert.ok(empty.sparring_partner, 'parseConfig defaults must add a sparring_partner block even when absent from input');
  assert.equal(empty.sparring_partner?.enabled, true, 'sparring_partner.enabled defaults to true when the block is absent');
});

test('sparring_partner: an explicit {enabled: false} round-trips', () => {
  const off = parseConfig({ sparring_partner: { enabled: false } }) as unknown as CfgWithSparringPartner;
  assert.equal(off.sparring_partner?.enabled, false, 'an explicit enabled:false overrides the true default and survives parsing');
});

test('sparring_partner: a junk (non-boolean) enabled value is refused loud', () => {
  assert.throws(
    () => parseConfig({ sparring_partner: { enabled: 'yes' } }),
    /invalid/i,
    'sparring_partner.enabled must be a boolean — a non-boolean value fails loud'
  );
});

test('templates/default-config.json still parses and carries sparring_partner enabled true', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'))) as unknown as CfgWithSparringPartner;
  assert.ok(shipped.sparring_partner, 'parseConfig always supplies a sparring_partner block, shipped config or not');
  assert.equal(shipped.sparring_partner?.enabled, true, 'the shipped/defaulted sparring_partner.enabled is true');
});

// ------------------- sparring_partner.model (slice 2, article 'sparring-partner' interaction i /
// decision foreign_cd019e0b point 8: the System-tab model selector; optional, empty/absent = CLI default) -------------------

// model is a NEW field on the EXISTING sparring_partner block — additive-optional,
// a sibling of `enabled` above which this addition must leave untouched. Accessed
// through a cast for the same reason as the block itself: the assertions below fail
// cleanly (not the package build) until parseConfig grows the field.
type CfgWithSparringPartnerModel = { sparring_partner?: { enabled?: boolean; model?: string } };

test('sparring_partner.model: absent from input parses to undefined — no CLI-default value is invented at parse time', () => {
  const empty = parseConfig({}) as unknown as CfgWithSparringPartnerModel;
  assert.ok(empty.sparring_partner, 'parseConfig defaults must add a sparring_partner block');
  assert.equal(empty.sparring_partner?.model, undefined, 'model is undefined when absent — "use the CLI default" is a display convention, never a stored value');
  assert.equal(empty.sparring_partner?.enabled, true, 'the existing enabled default is untouched by the new sibling field');
});

test('sparring_partner.model: an explicit string round-trips verbatim, alongside the untouched enabled default', () => {
  const withModel = parseConfig({ sparring_partner: { model: 'gpt-5.6' } }) as unknown as CfgWithSparringPartnerModel;
  assert.equal(withModel.sparring_partner?.model, 'gpt-5.6', 'an explicit model string survives parsing verbatim');
  assert.equal(withModel.sparring_partner?.enabled, true, 'enabled still defaults to true when only model is supplied');
});

test('sparring_partner.model: a non-string value is refused loud', () => {
  assert.throws(
    () => parseConfig({ sparring_partner: { model: 42 } }),
    /invalid/i,
    'sparring_partner.model must be a string — a non-string value fails loud'
  );
});

test('templates/default-config.json still parses with sparring_partner.model omitted (ships no pinned model — the CLI default applies until set via the System tab)', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'))) as unknown as CfgWithSparringPartnerModel;
  assert.ok(shipped.sparring_partner, 'the shipped default-config carries a sparring_partner block');
  assert.equal(shipped.sparring_partner?.model, undefined, 'the shipped config ships no model value');
  assert.equal(shipped.sparring_partner?.enabled, true, 'the shipped enabled default is untouched by the new sibling field');
});

// ------------------- tdd config toggle (decision foreign_752caf98,
// tdd-and-mutation-toggles-in-system-tab; mutation_verification removed by
// decision cleanup-run-deletes-dead-scripts-and-removes-mutation-verification-key,
// 2026-09-22 — no live mechanism performed the check the posture promised) -------------------
//
// tdd is a top-level config block — additive-optional exactly like
// sparring_partner above: an absent block still parses with defaults
// ({enabled: true}), preserving the standing TDD-by-default (user-affirmed
// 2026-08-09) posture until a user explicitly turns it off. Like
// `sparring_partner`/`difficulty` above, the block is a NON-STRICT
// configSchema object. Unknown keys inside the block are silently STRIPPED on
// parse, the same forward-compat posture the `difficulty` section above
// documents (an older clone must tolerate a newer clone's config without
// throwing). Accessed through a cast so referencing it here does not require
// the field to exist at compile time — the assertions below fail cleanly
// (not the package build) until parseConfig grows the block.
type CfgWithTddMutation = {
  tdd?: { enabled?: boolean };
};

test('tdd: absent block defaults to {enabled: true} (TDD-by-default stays the standing posture, decision foreign_752caf98)', () => {
  const empty = parseConfig({}) as unknown as CfgWithTddMutation;
  assert.ok(empty.tdd, 'parseConfig defaults must add a tdd block even when absent from input');
  assert.equal(empty.tdd?.enabled, true, 'tdd.enabled defaults to true when the block is absent');
});

test('tdd: an explicit {enabled: false} round-trips', () => {
  const off = parseConfig({ tdd: { enabled: false } }) as unknown as CfgWithTddMutation;
  assert.equal(off.tdd?.enabled, false, 'an explicit tdd.enabled:false overrides the true default and survives parsing');
});

test('tdd: a junk (non-boolean) enabled value is refused loud', () => {
  assert.throws(
    () => parseConfig({ tdd: { enabled: 'yes' } }),
    /invalid/i,
    'tdd.enabled must be a boolean — a non-boolean value fails loud',
  );
});

test('tdd: an unknown field inside the block is silently stripped — the block is non-strict, mirroring sparring_partner/difficulty\'s forward-compat posture, not refused loud', () => {
  const stripped = parseConfig({ tdd: { enabled: false, bogus_field: 1 } }) as unknown as CfgWithTddMutation & {
    tdd?: { bogus_field?: number };
  };
  assert.equal(stripped.tdd?.enabled, false, 'enabled retains its explicit value alongside the unknown sibling key');
  assert.equal(stripped.tdd?.bogus_field, undefined, 'the unknown key is stripped from the parsed output, not thrown on');
});

test('templates/default-config.json still parses and carries tdd.enabled true', () => {
  const shipped = parseConfig(
    JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')),
  ) as unknown as CfgWithTddMutation;
  assert.ok(shipped.tdd, 'the shipped default-config carries a tdd block');
  assert.equal(shipped.tdd?.enabled, true, 'the shipped tdd.enabled is true');
});

// Per-project agent tool extension (decision
// per-project-agent-extra-tools-config-appended-at-render, 587472e3): the block
// MUST be in the schema — the top-level object strips unknown keys silently, so
// an unschema'd `agents` would vanish and the grant would never render.
test('agents: absent block defaults to {} (config stays optional)', () => {
  assert.deepEqual(parseConfig({}).agents, {});
});

test('agents: extra_tools round-trips, accepting a trailing * wildcard and the whole-server form', () => {
  const cfg = parseConfig({ agents: { implementor: { extra_tools: ['mcp__godot__*', 'mcp__godot', 'WebFetch', 'mcp__plugin_x_y__run.it-now'] } } });
  assert.deepEqual(cfg.agents.implementor.extra_tools, ['mcp__godot__*', 'mcp__godot', 'WebFetch', 'mcp__plugin_x_y__run.it-now']);
});

test('agents: an agent entry without extra_tools defaults it to []', () => {
  assert.deepEqual(parseConfig({ agents: { scout: {} } }).agents.scout.extra_tools, []);
});

// Review fix (MEDIUM): a hand-edit typo in config.json must NOT make every
// parseConfig throw — the MCP server and every hook parse this file (the same
// hazard the delivery block's comment records for .strict()). The schema is
// lenient; install/sync refuse malformed entries loudly at render
// (scripts/lib/agent-distribution.mjs), naming the problem.
test('agents: a malformed extra_tools entry still parses (validated at render, not here) — comma, space, newline, empty, mid-string *', () => {
  for (const bad of ['mcp__a, mcp__b', 'mcp__a mcp__b', 'mcp__a\nhooks:', '', 'mcp__*__x', '*', 'mcp__a**']) {
    assert.deepEqual(parseConfig({ agents: { implementor: { extra_tools: [bad] } } }).agents.implementor.extra_tools, [bad]);
  }
});

test('agents: an unknown key inside an agent entry survives parsing (passthrough) so render can refuse the typo by name, instead of it vanishing silently', () => {
  const cfg = parseConfig({ agents: { implementor: { extra_tool: ['mcp__godot__*'] } } });
  assert.deepEqual((cfg.agents.implementor as Record<string, unknown>).extra_tool, ['mcp__godot__*']);
  assert.deepEqual(cfg.agents.implementor.extra_tools, []);
});

test('agents: a non-array extra_tools (e.g. a string) still parses — refused at render as "not an array", never at parse', () => {
  for (const bad of ['a', 42, { x: 1 }, null]) {
    assert.deepEqual(parseConfig({ agents: { implementor: { extra_tools: bad } } }).agents.implementor.extra_tools, bad);
  }
});
