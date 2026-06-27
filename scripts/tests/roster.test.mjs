import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInstalledAgent, loadRegistry } from '../lib/agent-distribution.mjs';
import { lintAgentPrompt, checkSpawnContract, collectAgentTemplates, lintSkill, collectSkills } from '../lib/checks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TPL = join(root, 'agent-templates');
const VARS = { NODE: '"C:/tools with space/node.exe"', HOOKS_DIR: 'C:/plugin/hooks' };
const OPTS = { pluginVersion: '0.1.0', now: '2026-06-10T12:00:00.000Z', vars: VARS };

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

test('templates render with install-time vars: hook commands baked forward-slash, quoted (§6)', () => {
  const content = readFileSync(join(TPL, 'coder.md'), 'utf8');
  const { installedContent } = renderInstalledAgent(content, 'coder.md', OPTS);
  assert.ok(installedContent.includes('"C:/tools with space/node.exe" "C:/plugin/hooks/h3-contract-gate.mjs"'));
  assert.ok(!installedContent.includes('{{'), 'no tokens survive install');
  assert.ok(!/command:.*\\\\/.test(installedContent), 'no backslashes in any emitted command');
});

test('install refuses half-baked substitution and backslash vars (P5/§6)', () => {
  const content = readFileSync(join(TPL, 'test-writer.md'), 'utf8');
  assert.throws(() => renderInstalledAgent(content, 't.md', { ...OPTS, vars: { NODE: '"C:/n.exe"' } }), /substitution incomplete.*HOOKS_DIR/s);
  assert.throws(
    () => renderInstalledAgent(content, 't.md', { ...OPTS, vars: { NODE: '"C:\\\\n.exe"', HOOKS_DIR: 'C:/h' } }),
    /backslash check failed/
  );
});

test('full roster installs end-to-end through the CLI with detected vars', () => {
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
