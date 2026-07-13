import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintAgentPrompt, checkSpawnContract, lintSkill, PROMPT_CONTRACT_SECTIONS } from '../lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const GOOD_PROMPT = `---
name: reviewer-skeptic
required_inputs:
  - brief
  - diff
---
# Role & owned judgment
x
# Inputs it will receive
x
# Rubric / priorities
x
# Worked example
x
# Output contract
x
# Scope boundaries (negatives)
x
# Exit signals it may emit
x
`;

test('prompt linter: all seven §7.3 sections required, in order', () => {
  assert.deepEqual(lintAgentPrompt(GOOD_PROMPT, 'good.md'), []);
  assert.equal(PROMPT_CONTRACT_SECTIONS.length, 7);
  const missing = lintAgentPrompt(GOOD_PROMPT.replace('# Worked example\nx\n', ''), 'bad.md');
  assert.deepEqual(missing.map((v) => v.kind), ['missing_section']);
  assert.match(missing[0].detail, /worked_example/);
  const reordered = GOOD_PROMPT.replace('# Role & owned judgment\nx\n', '') + '# Role & owned judgment\nx\n';
  assert.ok(lintAgentPrompt(reordered, 'reordered.md').some((v) => v.kind === 'section_out_of_order'));
});

test('spawn-contract check: required-inputs manifest must be in frontmatter (§7.4)', () => {
  assert.deepEqual(checkSpawnContract(GOOD_PROMPT, 'good.md'), []);
  const noManifest = GOOD_PROMPT.replace(/required_inputs:[\s\S]*?- diff\n/, '');
  assert.deepEqual(checkSpawnContract(noManifest, 'bad.md').map((v) => v.kind), ['missing_required_inputs']);
});

test('skill linter: flags stale file references, accepts live ones', () => {
  assert.deepEqual(lintSkill('Run scripts/dispose-run.mjs then check templates/default-config.json.', 's', root), []);
  const stale = lintSkill('See scripts/does-not-exist.mjs for details.', 'debug/SKILL.md', root);
  assert.deepEqual(stale.map((v) => v.kind), ['stale_file_reference']);
  // R2 72807b1f: the grammar covers skills/ + commands/ prefixes (cross-skill
  // references were previously unlinted) and sh/bat extensions
  assert.deepEqual(lintSkill('See skills/drain/SKILL.md and commands/merge.md.', 's', root), []);
  const staleSkill = lintSkill('See skills/gone/SKILL.md and templates/gone.sh.', 's', root);
  assert.equal(staleSkill.length, 2, 'skills/ and .sh references are existence-checked');
});

test('all day-one check scripts pass on the current repo (empty sets pass — invariant 3)', () => {
  // check-bundles-fresh joined the list with R2 7cde1448 (bundle freshness is a
  // tree invariant). check-projection-fresh stays gate-bound only (direct-merge
  // runs the full battery, R2 2e443375): the projection legitimately lags the
  // store mid-work, so it is a pre-merge duty, not a test invariant.
  for (const script of ['check-agent-registry.mjs', 'check-totality.mjs', 'check-spawn-contracts.mjs', 'check-agent-prompts.mjs', 'check-skills.mjs', 'check-bundles-fresh.mjs']) {
    const r = spawnSync(process.execPath, [join(root, 'scripts', script)], { encoding: 'utf8', cwd: root, timeout: 120_000 });
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
  }
});
