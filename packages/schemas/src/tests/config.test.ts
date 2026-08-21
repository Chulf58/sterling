import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('shipped default config parses and carries the spec defaults (§12, §5.1, §7.2)', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8')));
  assert.equal(shipped.caps.inner_loop_n, 3, 'inner loop N default 3 (§5.1)');
  assert.equal(shipped.caps.outer_loop_m, 2, 'outer loop M default 2');
  assert.equal(shipped.caps.dispatch_per_agent_type, 25);
  assert.equal(shipped.caps.phase_death_cap, 1);
  assert.equal(shipped.context_watch.warn_pct, 60);
  assert.equal(shipped.context_watch.block_pct, 95);
  assert.equal(shipped.context_watch.mode, 'observe', 'MVP-spine default is observe (§6 H6)');
  assert.equal(shipped.models.reviewers.effort, 'low', 'reviewers run low effort flat (§7.2)');
  // Exact pinned IDs, never bare tier aliases (a127e6e1's mechanism, still
  // binding). The VALUES track the newest generation per the stay-current posture
  // (738253b2) — bumped 4.x -> 5 on 2026-07-26, so this pair is expected to change
  // on each generational bump; the assertion exists to catch an accidental drift to
  // an alias or a stale pin, not to freeze a version.
  assert.equal(shipped.models.coder.model, 'claude-sonnet-5');
  assert.equal(shipped.models.coder_hard.model, 'claude-opus-5');
  for (const [role, v] of Object.entries(shipped.models)) {
    assert.match(v.model, /^claude-(opus|sonnet|haiku)-[0-9]/, `${role}: exact pinned id, never a bare tier alias (a127e6e1)`);
  }
  for (const role of Object.values(shipped.models)) {
    assert.notEqual(role.effort, 'max', 'max effort is never used for subagents (§7.2 hard rule)');
  }
  assert.ok(shipped.reviewer_selection.security_path_patterns.length >= 3, 'signal sets start over-inclusive (§7.1)');
  assert.equal(shipped.staleness.research_days.fast, 30);
});

test('empty config gets full defaults; malformed config fails loud', () => {
  const empty = parseConfig({});
  assert.equal(empty.caps.inner_loop_n, 3);
  assert.equal(empty.context_watch.mode, 'observe');
  assert.equal(empty.prep_cap, 20);
  assert.throws(() => parseConfig({ caps: { inner_loop_n: 'three' } }));
  assert.throws(() => parseConfig({ context_watch: { mode: 'silent' } }));
  assert.throws(() => parseConfig({ models: { coder: { model: 'sonnet', effort: 'max' } } }), /invalid/i);
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

// ------------------- difficulty.split_interface_threshold (run r-68eb, brief afd9b684, AC4 — p1 config half) -------------------

// split_interface_threshold is the gate-confirmed RENAME of the dead blast_radius_hard_threshold:
// the old key is GONE from the schema and a legacy config still carrying it must still parse
// (configSchema objects are non-strict — unknown keys strip). Accessed through a cast so referencing
// the not-yet-existing field does not require it at compile time — the assertions below fail cleanly
// (not the package build) until parseConfig grows the field. The old key is intentionally typed here
// so the "legacy key stripped from the parsed output" assertion compiles.
type CfgWithSplit = {
  difficulty?: {
    split_interface_threshold?: number;
    thin_knowledge_retrieval_threshold?: number;
    blast_radius_hard_threshold?: number;
  };
};

test('difficulty.split_interface_threshold: default 3 from an empty config', () => {
  const empty = parseConfig({}) as unknown as CfgWithSplit;
  assert.ok(empty.difficulty, 'parseConfig defaults must add a difficulty block');
  assert.equal(empty.difficulty?.split_interface_threshold, 3, 'split_interface_threshold defaults to 3 (user-confirmed "more than 3")');
});

test('difficulty.split_interface_threshold: an explicit value is tunable; non-int / non-positive fail loud', () => {
  const tuned = parseConfig({ difficulty: { split_interface_threshold: 5 } }) as unknown as CfgWithSplit;
  assert.equal(tuned.difficulty?.split_interface_threshold, 5, 'an explicit split_interface_threshold overrides the default 3');
  assert.throws(
    () => parseConfig({ difficulty: { split_interface_threshold: 'many' } }),
    /invalid/i,
    'split_interface_threshold must be a number — a non-number fails loud'
  );
  assert.throws(
    () => parseConfig({ difficulty: { split_interface_threshold: 0 } }),
    'split_interface_threshold is zod-positive — 0 is rejected'
  );
  assert.throws(
    () => parseConfig({ difficulty: { split_interface_threshold: -3 } }),
    'split_interface_threshold is zod-positive — a negative is rejected'
  );
  assert.throws(
    () => parseConfig({ difficulty: { split_interface_threshold: 2.5 } }),
    'split_interface_threshold is a zod int — a fractional value is rejected'
  );
});

test('difficulty: a legacy config carrying the dead blast_radius_hard_threshold still parses; the old key is stripped and split_interface_threshold defaults', () => {
  const legacy = parseConfig({ difficulty: { blast_radius_hard_threshold: 7 } }) as unknown as CfgWithSplit;
  assert.ok(legacy.difficulty, 'a legacy difficulty block survives parsing (non-strict object)');
  assert.equal(legacy.difficulty?.split_interface_threshold, 3, 'the new field is present and defaulted even when only the legacy key was supplied');
  assert.equal(
    legacy.difficulty?.blast_radius_hard_threshold,
    undefined,
    'the renamed-away blast_radius_hard_threshold is stripped — it is gone from the parsed output'
  );
});

test('difficulty.thin_knowledge_retrieval_threshold is untouched by the rename (stays default 2)', () => {
  const empty = parseConfig({}) as unknown as CfgWithSplit;
  assert.equal(empty.difficulty?.thin_knowledge_retrieval_threshold, 2, 'thin_knowledge_retrieval_threshold is untouched — default 2');
});

test('templates/default-config.json ships difficulty.split_interface_threshold (3) and still parses', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'))) as unknown as CfgWithSplit;
  assert.ok(shipped.difficulty, 'the shipped default-config carries a difficulty block');
  assert.equal(shipped.difficulty?.split_interface_threshold, 3, 'the shipped split_interface_threshold is 3');
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
  assert.equal(shipped.context_watch.windows.default, 200_000, 'unknown models stay conservative — mismatch degrades loud, never false-blocks');
});

// ------------------- delegation_watch config (H10 delegation-watch advisory, decision 677f1639) -------------------

// delegation_watch is a NEW top-level config block (a sibling of context_watch,
// not nested under it — mirrors the context_watch.conductor precedent in shape
// only). Accessed through a cast so referencing it here does not require the
// field to exist at compile time — the assertions below fail cleanly (not the
// package build) until parseConfig grows the block.
type CfgWithDelegationWatch = {
  delegation_watch?: { min_hand_work?: number; max_dispatches?: number };
};

test('delegation_watch: defaults {min_hand_work:15, max_dispatches:0} from an empty config', () => {
  const empty = parseConfig({}) as unknown as CfgWithDelegationWatch;
  assert.ok(empty.delegation_watch, 'parseConfig defaults must add a delegation_watch block');
  assert.equal(empty.delegation_watch?.min_hand_work, 15, 'min_hand_work defaults to 15');
  assert.equal(empty.delegation_watch?.max_dispatches, 0, 'max_dispatches defaults to 0');
});

test('delegation_watch: explicit values are honored; a non-number fails loud', () => {
  const tuned = parseConfig({ delegation_watch: { min_hand_work: 20, max_dispatches: 2 } }) as unknown as CfgWithDelegationWatch;
  assert.equal(tuned.delegation_watch?.min_hand_work, 20, 'an explicit min_hand_work overrides the default 15');
  assert.equal(tuned.delegation_watch?.max_dispatches, 2, 'an explicit max_dispatches overrides the default 0');
  assert.throws(
    () => parseConfig({ delegation_watch: { min_hand_work: 'many' } }),
    /invalid/i,
    'min_hand_work must be a number — a non-number fails loud'
  );
  assert.throws(
    () => parseConfig({ delegation_watch: { max_dispatches: 'none' } }),
    /invalid/i,
    'max_dispatches must be a number — a non-number fails loud'
  );
});

test('delegation_watch: min_hand_work is zod-positive (0 and negative rejected); max_dispatches is nonnegative (negative rejected, 0 allowed)', () => {
  assert.throws(() => parseConfig({ delegation_watch: { min_hand_work: 0 } }), 'min_hand_work must be positive — 0 is rejected');
  assert.throws(() => parseConfig({ delegation_watch: { min_hand_work: -5 } }), 'min_hand_work must be positive — a negative is rejected');
  assert.throws(() => parseConfig({ delegation_watch: { max_dispatches: -1 } }), 'max_dispatches must be nonnegative — a negative is rejected');
  const zeroOk = parseConfig({ delegation_watch: { max_dispatches: 0 } }) as unknown as CfgWithDelegationWatch;
  assert.equal(zeroOk.delegation_watch?.max_dispatches, 0, 'max_dispatches: 0 is a valid, explicit, nonnegative value');
});

// ------------------- delegation_watch.streak_threshold (H21 hand-work-streak advisory, decision 677f1639) -------------------

// streak_threshold is a NEW field on the EXISTING delegation_watch block — a
// sibling of min_hand_work/max_dispatches, which this addition must leave
// untouched. Accessed through a cast for the same reason as the block above:
// the assertions fail cleanly (not the package build) until parseConfig grows
// the field.
type CfgWithStreakThreshold = {
  delegation_watch?: { min_hand_work?: number; max_dispatches?: number; streak_threshold?: number };
};

test('delegation_watch.streak_threshold: defaults to 10 from an empty config; existing min_hand_work/max_dispatches untouched', () => {
  const empty = parseConfig({}) as unknown as CfgWithStreakThreshold;
  assert.ok(empty.delegation_watch, 'parseConfig defaults must add a delegation_watch block');
  assert.equal(empty.delegation_watch?.streak_threshold, 10, 'streak_threshold defaults to 10');
  assert.equal(empty.delegation_watch?.min_hand_work, 15, 'min_hand_work default is unchanged by the new sibling field');
  assert.equal(empty.delegation_watch?.max_dispatches, 0, 'max_dispatches default is unchanged by the new sibling field');
});

test('delegation_watch.streak_threshold: an explicit value is tunable alongside the other two fields', () => {
  const tuned = parseConfig({
    delegation_watch: { min_hand_work: 20, max_dispatches: 2, streak_threshold: 5 },
  }) as unknown as CfgWithStreakThreshold;
  assert.equal(tuned.delegation_watch?.streak_threshold, 5, 'an explicit streak_threshold overrides the default 10');
  assert.equal(tuned.delegation_watch?.min_hand_work, 20, 'sibling field min_hand_work still honored alongside the new field');
  assert.equal(tuned.delegation_watch?.max_dispatches, 2, 'sibling field max_dispatches still honored alongside the new field');
});

test('delegation_watch.streak_threshold: positive int only — 0, negative, fractional, and non-number all rejected loud', () => {
  assert.throws(
    () => parseConfig({ delegation_watch: { streak_threshold: 'many' } }),
    /invalid/i,
    'streak_threshold must be a number — a non-number fails loud'
  );
  assert.throws(() => parseConfig({ delegation_watch: { streak_threshold: 0 } }), 'streak_threshold is zod-positive — 0 is rejected');
  assert.throws(() => parseConfig({ delegation_watch: { streak_threshold: -3 } }), 'streak_threshold is zod-positive — a negative is rejected');
  assert.throws(() => parseConfig({ delegation_watch: { streak_threshold: 2.5 } }), 'streak_threshold is a zod int — a fractional value is rejected');
});

test('templates/default-config.json still parses and carries a delegation_watch.streak_threshold of 10', () => {
  const shipped = parseConfig(JSON.parse(readFileSync(join(root, 'templates', 'default-config.json'), 'utf8'))) as unknown as CfgWithStreakThreshold;
  assert.ok(shipped.delegation_watch, 'parseConfig always supplies a delegation_watch block, shipped config or not');
  assert.equal(shipped.delegation_watch?.streak_threshold, 10, 'the shipped/defaulted streak_threshold is 10');
});

// ------------------- sparring_partner config (decision cd019e0b, sparring-partner-partnership-shape) -------------------

// sparring_partner is a NEW top-level config block, additive-optional like
// delegation_watch above: an absent block still parses with defaults
// ({enabled: true}). Accessed through a cast so referencing it here does not
// require the field to exist at compile time — the assertions below fail
// cleanly (not the package build) until parseConfig grows the block.
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
// decision cd019e0b point 8: the System-tab model selector; optional, empty/absent = CLI default) -------------------

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
