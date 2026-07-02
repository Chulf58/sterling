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
  assert.equal(shipped.models.coder.model, 'claude-sonnet-4-6');
  assert.equal(shipped.models.coder_hard.model, 'claude-opus-4-8');
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
