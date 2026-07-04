import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInstalledAgent, loadRegistry } from '../lib/agent-distribution.mjs';
import { lintAgentPrompt, checkSpawnContract, collectAgentTemplates, lintSkill, collectSkills } from '../lib/checks.mjs';
import { AGENT_MODEL_KEY, REVIEWER_ROLES } from '@sterling/schemas';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TPL = join(root, 'agent-templates');
const VARS = { NODE: '"C:/tools with space/node.exe"', HOOKS_DIR: 'C:/plugin/hooks' };
const OPTS = { pluginVersion: '0.1.0', now: '2026-06-10T12:00:00.000Z', vars: VARS };

// Phase 2 (r-ea9e): model:/effort: in the 9 templates are {{MODEL}}/{{EFFORT}}
// tokens, resolved at render time from config.models via AGENT_MODEL_KEY. Build a
// config covering every distinct config key so any agent renders. The interface
// slice does not fix the opts KEY the parsed config arrives on, so supply it under
// both plausible carriers (opts.config.models AND opts.models) — the behavior is
// the contract, not the wire-name.
const MODELS = Object.fromEntries(
  [...new Set(Object.values(AGENT_MODEL_KEY))].map((k) => [k, { model: 'claude-opus-4-8', effort: 'low' }])
);
const CFG = { config: { models: MODELS }, models: MODELS };

const ROSTER = [
  'test-writer',
  'coder',
  'reviewer-correctness',
  'reviewer-security',
  'reviewer-skeptic',
  'reviewer-performance',
  'implementation-architect',
  'researcher',
  'explorer',
];

test('the §7.1 roster is registered, linter-complete, and spawn-contracted', () => {
  const registry = loadRegistry(join(TPL, 'registry.json'));
  assert.deepEqual(registry.agents.map((a) => a.name).sort(), [...ROSTER].sort());
  for (const t of collectAgentTemplates(TPL)) {
    assert.deepEqual(lintAgentPrompt(t.content, t.file), [], `${t.file} passes the §7.3 linter`);
    assert.deepEqual(checkSpawnContract(t.content, t.file), [], `${t.file} declares required_inputs`);
  }
});

test('AGENT_MODEL_KEY covers every registered agent (totality) and folds the reviewers to one key', () => {
  // Every roster agent must have an AGENT_MODEL_KEY entry, or its {{MODEL}} token
  // cannot resolve at install (P5: fail loud, never silent).
  for (const name of ROSTER) {
    assert.ok(AGENT_MODEL_KEY[name], `AGENT_MODEL_KEY maps '${name}' to a config.models key`);
  }
  const reviewerKeys = new Set(ROSTER.filter((n) => n.startsWith('reviewer-')).map((n) => AGENT_MODEL_KEY[n]));
  assert.equal(reviewerKeys.size, 1, 'all reviewer agents fold to a single config.models key (one key governs four agents)');
});

test('templates render with install-time vars: hook commands baked forward-slash, quoted (§6); model/effort resolved from config.models', () => {
  const content = readFileSync(join(TPL, 'coder.md'), 'utf8');
  const { installedContent } = renderInstalledAgent(content, 'coder.md', { ...OPTS, ...CFG });
  assert.ok(installedContent.includes('"C:/tools with space/node.exe" "C:/plugin/hooks/h3-contract-gate.mjs"'));
  assert.ok(!installedContent.includes('{{'), 'no tokens survive install (vars AND model/effort resolved)');
  assert.ok(!/command:.*\\\\/.test(installedContent), 'no backslashes in any emitted command');
  // model/effort resolved from config.models[AGENT_MODEL_KEY['coder']]
  const fm = installedContent.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.match(fm, /^model: claude-opus-4-8$/m, 'MODEL token resolved from config.models');
  assert.match(fm, /^effort: low$/m, 'EFFORT token resolved from config.models');
});

test('install refuses half-baked substitution and backslash vars (P5/§6)', () => {
  const content = readFileSync(join(TPL, 'test-writer.md'), 'utf8');
  // config supplied so MODEL/EFFORT resolve — the ONLY missing substitution is
  // HOOKS_DIR, so the incomplete-substitution error names it specifically.
  assert.throws(
    () => renderInstalledAgent(content, 'test-writer.md', { ...OPTS, ...CFG, vars: { NODE: '"C:/n.exe"' } }),
    /substitution incomplete.*HOOKS_DIR/s
  );
  assert.throws(
    () => renderInstalledAgent(content, 'test-writer.md', { ...OPTS, ...CFG, vars: { NODE: '"C:\\\\n.exe"', HOOKS_DIR: 'C:/h' } }),
    /backslash check failed/
  );
});

test('full roster installs end-to-end through the CLI with detected vars; model/effort tokens resolve to concrete pinned ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-roster-'));
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'install-agents.mjs'), '--target', dir], {
      encoding: 'utf8',
      cwd: root,
      timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const installed = readdirSync(join(dir, '.claude', 'agents')).sort();
    assert.deepEqual(installed, ROSTER.map((n) => `${n}.md`).sort());
    assert.match(r.stdout, /RESTART REQUIRED/);
    const coder = readFileSync(join(dir, '.claude', 'agents', 'coder.md'), 'utf8');
    assert.match(coder, /sterling-generated v=/);
    assert.ok(coder.includes(`${root.replace(/\\/g, '/')}/hooks/h14-bash-allowlist.mjs`), 'HOOKS_DIR baked to the plugin hooks dir');
    assert.ok(coder.includes(process.execPath.replace(/\\/g, '/')), 'NODE baked to the running node');
    // Phase 2: no {{MODEL}}/{{EFFORT}} token survives a real CLI install — the CLI
    // resolves them from config.models (falling back to the shipped default config)
    // to a concrete pinned model id, never a bare alias or a leftover token.
    assert.ok(!coder.includes('{{'), 'no substitution token survives the CLI install');
    const fm = coder.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(fm, /^model: claude-[a-z0-9.\-]+$/m, 'model resolved to a concrete pinned claude- id');
    assert.match(fm, /^effort: [a-z]+$/m, 'effort resolved to a concrete value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skills ship with live file references and pass the skill linter', () => {
  const skills = collectSkills(join(root, 'skills'));
  assert.deepEqual(skills.map((s) => s.file).sort(), [
    'cleanup/SKILL.md',
    'debug/SKILL.md',
    'drain/SKILL.md',
    'grill-intent/SKILL.md',
    'grill-plan/SKILL.md',
    'planning/SKILL.md',
  ]);
  for (const s of skills) assert.deepEqual(lintSkill(s.content, s.file, root), []);
  assert.ok(existsSync(join(root, 'skills', 'debug', 'SKILL.md')));
});

// ---------------------------------------------------------------------------
// AC6 (run r-d630 phase 3) — every reviewer template carries a worked handoff
// example with the exact required arrays plus a dispositions example (both verbs).
// Templates are read at TEST RUNTIME (never copied into a fixture) so the assertion
// tracks the shipped file. The existing linter test above keeps dead-term + prompt
// -section linters green across all templates.
// ---------------------------------------------------------------------------

test('AC6: all four reviewer templates carry a worked handoff example (required arrays, empty [] permitted) plus a dispositions example with both verbs', () => {
  // derive the four reviewer names from the registry-backed predicate — a template
  // rename or a fifth reviewer fails loudly here, not silently.
  const reviewers = [...REVIEWER_ROLES].sort();
  assert.deepEqual(
    reviewers,
    ['reviewer-correctness', 'reviewer-performance', 'reviewer-security', 'reviewer-skeptic'],
    'REVIEWER_ROLES resolves exactly the four reviewer templates the handoff example must reach'
  );

  for (const role of reviewers) {
    const content = readFileSync(join(TPL, `${role}.md`), 'utf8');
    // the worked handoff example shows the exact required arrays
    for (const key of ['what_changed', 'wired', 'deferred']) {
      assert.ok(content.includes(key), `${role}.md worked handoff example must show the '${key}' array`);
    }
    // and a dispositions example exercising BOTH disposition verbs (+ the reason the
    // not_applicable_because verb requires) — the recurring first-write schema failure
    // this example kills.
    assert.ok(content.includes('dispositions'), `${role}.md must show a dispositions example block`);
    assert.ok(content.includes('addressed'), `${role}.md dispositions example must show the 'addressed' verb`);
    assert.ok(
      content.includes('not_applicable_because'),
      `${role}.md dispositions example must show the 'not_applicable_because' verb`
    );
    assert.ok(content.includes('reason'), `${role}.md dispositions example must show the reason field the not_applicable_because verb requires`);
  }
});
