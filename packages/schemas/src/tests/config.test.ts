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
