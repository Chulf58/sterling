import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, normalizeRawConfig, configSchema, unreadConfigKeys, DEFAULT_UNDECLARED_SOURCE_EXCLUDE_GLOBS } from '../config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('shipped default config parses and carries the spec defaults (§12, §7.2)', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')));
  // Exact pinned IDs, never bare tier aliases (a127e6e1's mechanism, still
  // binding). The VALUES track the newest generation per the stay-current posture
  // (738253b2) — bumped 4.x -> 5 on 2026-07-26, so this pair is expected to change
  // on each generational bump; the assertion exists to catch an accidental drift to
  // an alias or a stale pin, not to freeze a version.
  // all four roles -> claude-sonnet-5-5 per decision subagent-defaults-sonnet-5-5-opus-5-5-as-pin
  // (user-ruled 2026-09-28, replacing implementor-default-model-opus-5-5); Opus 5.5
  // stays available as a per-dispatch pin.
  assert.equal(shipped.models.implementor.model, 'claude-sonnet-5-5');
  // high: user-ruled 2026-09-28 (decision implementor-default-effort-high) — Sonnet 5.5 is cheap to run.
  assert.equal(shipped.models.implementor.effort, 'high');
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

// Decision agent-roster-is-classless-four-agents rejected a debugger role, so
// neither the schema nor the shipped file may carry a models.debugger key.
test('models carries no retired debugger key, in the schema defaults or the shipped config', () => {
  const shippedRaw = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'));
  assert.ok(!('debugger' in shippedRaw.models), 'templates/default-config.json models has no debugger key');
  assert.ok(!('debugger' in parseConfig({}).models), 'the schema models defaults have no debugger key');
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

test('conductor pressure: the shared context-window table carries verified per-model windows (live probe 2026-08-09 — 200k default misclassified a 1M-window session)', () => {
  // The per-model windows moved from the per-project seed (templates/default-config.json)
  // to the one shared table H10 reads (templates/context-windows.json); the seed keeps only
  // the default below.
  const sharedWindows = JSON.parse(readFileSync(join(root, 'templates', 'context-windows.json'), 'utf8')).windows;
  assert.equal(sharedWindows['claude-fable-5'], 1_000_000);
  assert.equal(sharedWindows['claude-opus-5'], 1_000_000);
  assert.equal(sharedWindows['claude-sonnet-5'], 1_000_000);
  assert.equal(sharedWindows['claude-haiku-4-5'], 200_000);
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')));
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

// CHANGED by vendor-pins step 2 (decision system-tab-sets-vendor-policy-and-models-for-reviewer-sparring-and-hard-tasks):
// the old key no longer survives parsing; it is converted to sparring_partner.models.openai.
// The verbatim-string and untouched-enabled expectations are kept; only where the value lands moved.
test('sparring_partner.model: an explicit string is converted to models.openai verbatim, alongside the untouched enabled default', () => {
  const withModel = parseConfig({ sparring_partner: { model: 'gpt-5.6' } }) as unknown as CfgWithSparringPartnerModel & { sparring_partner: { models: { openai?: { model: string } } } };
  assert.equal(withModel.sparring_partner.models.openai?.model, 'gpt-5.6', 'an explicit model string survives parsing verbatim, under models.openai');
  assert.equal(withModel.sparring_partner?.model, undefined, 'the old key itself is gone');
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

// ------------------- project mode (decision project-mode-hobby-work-toggle-decides-flow, slice S1) -------------------

// The default lives TWICE (anti_pattern 85d15143): the zod default and
// templates/default-config.json. A missing key means hobby; the two copies must agree.
type CfgWithMode = { mode?: string };

test('mode: an empty config defaults to hobby, and the shipped template carries the same default', () => {
  const empty = parseConfig({}) as unknown as CfgWithMode;
  assert.equal(empty.mode, 'hobby', 'a missing mode key means hobby');
  const rawTemplate = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')) as CfgWithMode;
  assert.equal(rawTemplate.mode, 'hobby', 'templates/default-config.json declares mode explicitly');
  const shipped = parseConfig(rawTemplate) as unknown as CfgWithMode;
  assert.equal(shipped.mode, empty.mode, 'schema default and shipped template agree');
});

test('mode: parseConfig is PERMISSIVE — hobby/work pass, any other value is preserved raw, never coerced and never thrown on', () => {
  // A typo in config.mode must not brick every parseConfig reader (the MCP
  // server boots through it). readProjectMode (scripts/lib/handoff-projection.mjs)
  // is the strict judge wherever the mode is ACTED on; its refusal tests live in
  // scripts/tests/project-mode-gating.test.mjs.
  assert.equal((parseConfig({ mode: 'work' }) as unknown as CfgWithMode).mode, 'work');
  assert.equal((parseConfig({ mode: 'hobby' }) as unknown as CfgWithMode).mode, 'hobby');
  for (const raw of ['Work', 'hobbyist', '', 1, true, null, ['work'], { mode: 'work' }]) {
    const parsed = parseConfig({ mode: raw }) as unknown as { mode?: unknown };
    assert.deepEqual(parsed.mode, raw, `mode ${JSON.stringify(raw)} is preserved verbatim, never coerced to hobby`);
  }
});

// The handoff setting (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// off by default, in both copies of the default (anti_pattern 85d15143).
test('handoff: an empty config defaults to { enabled: false }, and the shipped template carries the same default', () => {
  const empty = parseConfig({}) as unknown as { handoff?: unknown };
  assert.deepEqual(empty.handoff, { enabled: false }, 'a missing handoff key means off');
  const rawTemplate = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')) as { handoff?: unknown };
  assert.deepEqual(rawTemplate.handoff, { enabled: false }, 'templates/default-config.json declares handoff explicitly');
  assert.deepEqual((parseConfig(rawTemplate) as unknown as { handoff?: unknown }).handoff, empty.handoff, 'schema default and shipped template agree');
});

test('handoff: parseConfig is PERMISSIVE — any value is preserved raw, never coerced and never thrown on; the mode does not change it', () => {
  // Like mode: a typo must not brick every parseConfig reader. readHandoffEnabled
  // (scripts/lib/handoff-projection.mjs) is the strict judge; its refusal tests
  // live in scripts/tests/handoff-setting.test.mjs.
  for (const raw of [{ enabled: true }, { enabled: false }, { enabled: 'yes' }, 'on', 1, null, [true]]) {
    for (const mode of ['hobby', 'work']) {
      const parsed = parseConfig({ mode, handoff: raw }) as unknown as { handoff?: unknown };
      assert.deepEqual(parsed.handoff, raw, `handoff ${JSON.stringify(raw)} is preserved verbatim in ${mode} mode`);
    }
  }
  assert.deepEqual((parseConfig({ mode: 'work' }) as unknown as { handoff?: unknown }).handoff, { enabled: false }, 'work mode does not turn handoff on');
  assert.deepEqual(unreadConfigKeys({ handoff: { enabled: true } }), [], 'handoff is a key the schema reads');
});

test('pr_review (PR review loop identity pin): permissive, defaults to copilot_logins [], and the template carries the same default', () => {
  assert.deepEqual(parseConfig({}).pr_review, { copilot_logins: [] });
  const rawTemplate = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'));
  assert.deepEqual(rawTemplate.pr_review, { copilot_logins: [] }, 'templates/default-config.json declares pr_review explicitly');
  assert.deepEqual(parseConfig(rawTemplate).pr_review, parseConfig({}).pr_review);
  // PERMISSIVE like mode: a malformed value is preserved raw, never thrown on;
  // pr-review-wait.mjs is the strict judge.
  assert.doesNotThrow(() => parseConfig({ pr_review: { copilot_logins: 'x' } }));
  assert.deepEqual(parseConfig({ pr_review: { copilot_logins: ['a[bot]'] } }).pr_review, { copilot_logins: ['a[bot]'] });
});

// Undeclared-source default (decision gap-hunt-2026-09-28-rulings item 6): shell
// scripts are excluded by default. The default lives in BOTH the zod schema and
// the shipped template, and the two must agree (anti-pattern 85d15143).
test('undeclared_source_exclude_globs defaults to ["**/*.sh"] in the schema AND the shipped template', () => {
  const shippedRaw = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'));
  assert.deepEqual(DEFAULT_UNDECLARED_SOURCE_EXCLUDE_GLOBS, ['**/*.sh']);
  assert.deepEqual(parseConfig({}).undeclared_source_exclude_globs, ['**/*.sh'], 'schema default');
  assert.deepEqual(shippedRaw.undeclared_source_exclude_globs, ['**/*.sh'], 'template default');
  assert.deepEqual(parseConfig({ undeclared_source_exclude_globs: [] }).undeclared_source_exclude_globs, [], 'an explicit [] still opts back in to scanning .sh');
});

// Unread config keys (decision gap-hunt-2026-09-28-rulings item 12): a key the
// schema does not define is stripped silently on parse, so Sterling never reads
// it. Disclosure only — the helper reports, it never edits the config.
test('unreadConfigKeys: top-level and NESTED keys the schema strips are named by dotted path, in config order', () => {
  assert.deepEqual(unreadConfigKeys({ mode: 'hobby', models: {}, toolchains: [] }), [], 'a clean config has none');
  assert.deepEqual(
    unreadConfigKeys({ caps: { inner_loop_n: 3 }, context_watch: { warn_pct: 40, windows: { default: 1 }, conductor: { soft_pct: 35, junk: 1 } }, reviewer_selection: {} }).map((k) => k.path),
    ['caps', 'context_watch.warn_pct', 'context_watch.conductor.junk', 'reviewer_selection'],
  );
  // records, passthrough objects and unknown-typed values are open by design: their keys are data
  assert.deepEqual(unreadConfigKeys({ domain_paths: { anything: '/x' }, agents: { implementor: { extra_tools: [], typo: 1 } }, pr_review: { whatever: 1 } }), []);
  assert.deepEqual(unreadConfigKeys(null), [], 'a non-object config is some other check\'s refusal, not this one');
  assert.deepEqual(unreadConfigKeys([1, 2]), []);
});

test('unreadConfigKeys: maintenance_worker.opencode_model is read (the OpenCode worker refuses to start without it) and survives parseConfig', () => {
  assert.deepEqual(unreadConfigKeys({ maintenance_worker: { enabled: true, opencode_model: 'opencode/some-model' } }), []);
  assert.deepEqual(
    unreadConfigKeys({ maintenance_worker: { opencode_model: 'x', daily_budget_usd: 5 } }).map((k) => k.path),
    ['maintenance_worker.daily_budget_usd'],
    'a key nothing reads still warns',
  );
  assert.equal(parseConfig({ maintenance_worker: { opencode_model: 'opencode/some-model' } }).maintenance_worker.opencode_model, 'opencode/some-model', 'a parsed config keeps the key the worker reads');
  assert.equal(parseConfig({ maintenance_worker: { opencode_model: 7 } }).maintenance_worker.opencode_model, 7, 'a malformed value is preserved raw, so the worker (not the MCP boot) refuses it loudly');
});

test('unreadConfigKeys: the Dome Farmer pre-rename models keys are each named, with the known renames', () => {
  const me = { model: 'm', effort: 'low' };
  const keys = unreadConfigKeys({ models: { implementor: me, coder: me, coder_hard: me, explorer: me, test_writer: me, reviewers: me, implementation_architect: me, debugger: me } });
  assert.deepEqual(keys, [
    { path: 'models.coder', renamed_to: 'models.implementor' },
    { path: 'models.coder_hard' },
    { path: 'models.explorer', renamed_to: 'models.scout' },
    { path: 'models.test_writer' },
    { path: 'models.reviewers' },
    { path: 'models.implementation_architect' },
    { path: 'models.debugger' },
  ]);
});

// ------------------- maintenance_worker (decision maintenance-queue-background-haiku-worker-simple-redesign) -------------------
// The kill switch for the hook-started background worker. Its default lives in
// TWO places (anti_pattern 85d15143: a template-only default is ignored by
// install/sync, which fill omitted keys from the zod default), so both are pinned.

test('maintenance_worker.enabled: an absent block parses to enabled true, and the shipped template agrees', () => {
  assert.equal(parseConfig({}).maintenance_worker.enabled, true, 'the zod default turns the worker on');
  const shippedRaw = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'));
  assert.equal(shippedRaw.maintenance_worker?.enabled, true, 'templates/default-config.json ships maintenance_worker.enabled true');
  assert.deepEqual(parseConfig(shippedRaw).maintenance_worker, parseConfig({}).maintenance_worker, 'template and zod default agree');
});

test('maintenance_worker has no daily budget: the schema and the shipped template omit daily_budget_usd, and one left in an existing config is stripped, not refused', () => {
  assert.equal('daily_budget_usd' in parseConfig({}).maintenance_worker, false, 'the zod default carries no daily cap');
  const shippedRaw = JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'));
  assert.equal('daily_budget_usd' in shippedRaw.maintenance_worker, false, 'templates/default-config.json ships no daily_budget_usd');
  const legacy = parseConfig({ maintenance_worker: { enabled: false, daily_budget_usd: 1.5 } }).maintenance_worker;
  assert.deepEqual(legacy, { enabled: false }, 'a legacy key is dropped and the rest survives');
});

test('maintenance_worker.enabled: false round-trips, and a non-boolean is refused loud', () => {
  assert.equal(parseConfig({ maintenance_worker: { enabled: false } }).maintenance_worker.enabled, false);
  assert.throws(() => parseConfig({ maintenance_worker: { enabled: 'no' } }), /invalid/i);
});

// ------------------- vendor pins (decision system-tab-sets-vendor-policy-and-models-for-reviewer-sparring-and-hard-tasks, step 2) -------------------
// Every pin is {model, effort?}. models.<agent> adds an optional hard_task pin and
// accepts any agent's name as a key. sparring_partner and the new review block carry
// one pin per vendor. The old sparring_partner.model is converted to
// sparring_partner.models.openai when config is read, before the schema strips it.

const shippedRaw = () => JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'));

type Pin = { model: string; effort?: string };
type VendorPins = { openai?: Pin; anthropic?: Pin };
type PinCfg = {
  models: Record<string, Pin & { hard_task?: Pin }>;
  sparring_partner: { enabled: boolean; vendor: string; models: VendorPins };
  review: { policy: string; models: VendorPins };
};
const pins = (raw: unknown) => parseConfig(raw) as unknown as PinCfg;

test('models.<agent>.hard_task: absent by default, a {model, effort?} pin round-trips, and a junk pin is refused loud', () => {
  assert.equal(pins({}).models.implementor.hard_task, undefined, 'no hard_task is invented for the shipped defaults');
  const withHard = pins({ models: { implementor: { model: 'claude-sonnet-5-5', effort: 'high', hard_task: { model: 'claude-opus-5-5', effort: 'high' } } } });
  assert.deepEqual(withHard.models.implementor.hard_task, { model: 'claude-opus-5-5', effort: 'high' });
  const noEffort = pins({ models: { implementor: { model: 'claude-sonnet-5-5', hard_task: { model: 'claude-opus-5-5' } } } });
  assert.deepEqual(noEffort.models.implementor.hard_task, { model: 'claude-opus-5-5' }, 'hard_task effort is optional and not invented');
  assert.throws(() => parseConfig({ models: { implementor: { model: 'm', hard_task: { effort: 'high' } } } }), /invalid|required/i, 'hard_task needs a model');
  assert.throws(() => parseConfig({ models: { implementor: { model: 'm', hard_task: { model: 'm', effort: 'max' } } } }), /invalid/i, 'hard_task effort is the same enum');
  assert.throws(() => parseConfig({ models: { implementor: { model: 'm', hard_task: { model: 'm', junk: 1 } } } }), /unrecognized/i, 'a pin is strict');
});

test('models.<agent>.effort is optional: omitted means the host default and nothing is invented', () => {
  const p = pins({ models: { implementor: { model: 'claude-sonnet-5-5' } } });
  assert.deepEqual(p.models.implementor, { model: 'claude-sonnet-5-5' });
});

test('models accepts any installed agent name as a key, validates its pin, and keeps the shipped defaults', () => {
  const p = pins({ models: { 'my-custom-agent': { model: 'claude-haiku-4-5', effort: 'low', hard_task: { model: 'claude-opus-5-5' } } } });
  assert.deepEqual(p.models['my-custom-agent'], { model: 'claude-haiku-4-5', effort: 'low', hard_task: { model: 'claude-opus-5-5' } });
  assert.equal(p.models.implementor.model, 'claude-sonnet-5-5', 'the shipped per-key defaults still fill in');
  assert.throws(() => parseConfig({ models: { 'my-custom-agent': { model: 'm', effort: 'max' } } }), /invalid/i, 'an agent key with a bad pin is refused loud');
  assert.throws(() => parseConfig({ models: { 'my-custom-agent': 'claude-haiku-4-5' } }), /invalid/i, 'an agent key must hold a pin object');
});

test('models: retired pre-rename keys stay disclosed as unread and are never parsed as agent keys', () => {
  const parsed = pins({ models: { coder: { model: 'm', effort: 'max' }, explorer: 'junk', debugger: 7 } });
  for (const k of ['coder', 'coder_hard', 'explorer', 'test_writer', 'reviewers', 'implementation_architect', 'debugger']) {
    assert.ok(!(k in parsed.models), `models.${k} is stripped, so even a malformed legacy value cannot brick the parse`);
  }
  assert.deepEqual(unreadConfigKeys({ models: { 'my-custom-agent': { model: 'm' } } }), [], 'an agent-name key under models is read, not unread');
});

test('sparring_partner: defaults to {enabled: true, vendor: openai, models: {}} and the template agrees', () => {
  assert.deepEqual(pins({}).sparring_partner, { enabled: true, vendor: 'openai', models: {} });
  assert.deepEqual(pins({}).sparring_partner, pins(shippedRaw()).sparring_partner, 'schema default equals templates/default-config.json');
  assert.deepEqual(shippedRaw().sparring_partner, { enabled: true, vendor: 'openai', models: {} }, 'the template carries the block in full');
});

test('sparring_partner.vendor: openai and anthropic round-trip, anything else is refused loud', () => {
  assert.equal(pins({ sparring_partner: { vendor: 'anthropic' } }).sparring_partner.vendor, 'anthropic');
  assert.equal(pins({ sparring_partner: { vendor: 'openai' } }).sparring_partner.vendor, 'openai');
  assert.throws(() => parseConfig({ sparring_partner: { vendor: 'google' } }), /invalid/i);
});

test('sparring_partner.models: a pin per vendor round-trips with effort optional; a junk pin is refused loud', () => {
  const p = pins({ sparring_partner: { models: { openai: { model: 'gpt-6-astra', effort: 'high' }, anthropic: { model: 'claude-opus-5-5' } } } });
  assert.deepEqual(p.sparring_partner.models, { openai: { model: 'gpt-6-astra', effort: 'high' }, anthropic: { model: 'claude-opus-5-5' } });
  assert.throws(() => parseConfig({ sparring_partner: { models: { openai: { effort: 'high' } } } }), /invalid|required/i, 'a pin needs a model');
  assert.throws(() => parseConfig({ sparring_partner: { models: { openai: 'gpt-6-astra' } } }), /invalid/i, 'a pin is an object, not a string');
});

test('review: defaults to {policy: cross_vendor, models: {}} and the template agrees', () => {
  assert.deepEqual(pins({}).review, { policy: 'cross_vendor', models: {} });
  assert.deepEqual(pins({}).review, pins(shippedRaw()).review, 'schema default equals templates/default-config.json');
  assert.deepEqual(shippedRaw().review, { policy: 'cross_vendor', models: {} }, 'the template carries the block in full');
});

test('review.policy: cross_vendor, openai and anthropic round-trip, anything else is refused loud', () => {
  for (const policy of ['cross_vendor', 'openai', 'anthropic']) {
    assert.equal(pins({ review: { policy } }).review.policy, policy);
  }
  assert.throws(() => parseConfig({ review: { policy: 'same_vendor' } }), /invalid/i);
});

test('review.models: a pin per vendor round-trips with effort optional; a junk pin is refused loud', () => {
  const p = pins({ review: { models: { openai: { model: 'gpt-5.6-sol', effort: 'high' }, anthropic: { model: 'claude-opus-5-5', effort: 'high' } } } });
  assert.deepEqual(p.review.models, { openai: { model: 'gpt-5.6-sol', effort: 'high' }, anthropic: { model: 'claude-opus-5-5', effort: 'high' } });
  assert.deepEqual(pins({ review: { models: { openai: { model: 'gpt-5.6-sol' } } } }).review.models, { openai: { model: 'gpt-5.6-sol' } });
  assert.throws(() => parseConfig({ review: { models: { anthropic: { model: 'm', effort: 'max' } } } }), /invalid/i);
  assert.throws(() => parseConfig({ review: { models: { openai: { model: 42 } } } }), /invalid/i);
});

test('parseConfig({}) agrees with templates/default-config.json on every block the vendor pins touch', () => {
  const empty = pins({});
  const shipped = pins(shippedRaw());
  assert.deepEqual(empty.models, shipped.models);
  assert.deepEqual(empty.sparring_partner, shipped.sparring_partner);
  assert.deepEqual(empty.review, shipped.review);
});

// The old sparring_partner.model is converted to sparring_partner.models.openai
// when config is read, before the schema strips unknown keys; the new key wins.
test('old sparring_partner.model conversion: old key only becomes models.openai and the old key is gone', () => {
  const p = pins({ sparring_partner: { enabled: true, model: 'gpt-5.6-sol' } });
  assert.deepEqual(p.sparring_partner.models.openai, { model: 'gpt-5.6-sol' });
  assert.ok(!('model' in p.sparring_partner), 'the old key does not survive parsing');
  assert.equal(p.sparring_partner.models.anthropic, undefined, 'only the openai pin is created');
});

test('old sparring_partner.model conversion: new key only is read as is', () => {
  const p = pins({ sparring_partner: { models: { openai: { model: 'gpt-6-astra', effort: 'high' } } } });
  assert.deepEqual(p.sparring_partner.models.openai, { model: 'gpt-6-astra', effort: 'high' });
});

test('old sparring_partner.model conversion: when both exist the new key wins, effort included', () => {
  const p = pins({ sparring_partner: { model: 'gpt-5.6-sol', models: { openai: { model: 'gpt-6-astra', effort: 'high' }, anthropic: { model: 'claude-opus-5-5' } } } });
  assert.deepEqual(p.sparring_partner.models.openai, { model: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual(p.sparring_partner.models.anthropic, { model: 'claude-opus-5-5' }, 'sibling vendor pins are kept');
});

test('old sparring_partner.model conversion: the old key joins an existing models block that has no openai pin', () => {
  const p = pins({ sparring_partner: { model: 'gpt-5.6-sol', models: { anthropic: { model: 'claude-opus-5-5' } } } });
  assert.deepEqual(p.sparring_partner.models, { anthropic: { model: 'claude-opus-5-5' }, openai: { model: 'gpt-5.6-sol' } });
});

test("old sparring_partner.model conversion: '' (the clear-to-unset signal) creates no pin, and a non-string is still refused loud", () => {
  assert.deepEqual(pins({ sparring_partner: { enabled: true, model: '' } }).sparring_partner.models, {});
  assert.throws(() => parseConfig({ sparring_partner: { model: 42 } }), /invalid/i);
});

test('unreadConfigKeys: the old sparring_partner.model is read (converted), not reported as unread', () => {
  assert.deepEqual(unreadConfigKeys({ sparring_partner: { enabled: true, model: 'gpt-5.6-sol', models: { openai: { model: 'm' } } } }), []);
});

test('normalizeRawConfig: converts without mutating its input, and passes non-objects through for the schema to refuse', () => {
  const raw = { sparring_partner: { model: 'gpt-5.6-sol' }, models: { coder: { model: 'm' } } };
  const before = JSON.stringify(raw);
  const out = normalizeRawConfig(raw) as { sparring_partner: Record<string, unknown>; models: Record<string, unknown> };
  assert.equal(JSON.stringify(raw), before, "the caller's raw config is never mutated (config_set round-trips the raw document)");
  assert.deepEqual(out.sparring_partner, { models: { openai: { model: 'gpt-5.6-sol' } } });
  assert.ok(!('coder' in out.models));
  assert.equal(normalizeRawConfig(null), null);
  assert.deepEqual(normalizeRawConfig([1]), [1]);
  assert.equal(configSchema.safeParse(normalizeRawConfig({ sparring_partner: { model: 42 } })).success, false, 'the validator path (config_set) refuses it too');
});
