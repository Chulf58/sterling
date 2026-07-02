import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderInstalledAgent,
  parseInstalledHeader,
  isLocallyModified,
  installAgents,
  syncAgents,
  checkAgentsVisible,
  checkRegistryConsistency,
  findDeadTerms,
  findBackslashHookCommands,
  sha256,
  RESTART_INSTRUCTION,
} from '../lib/agent-distribution.mjs';

const TEMPLATE = `---
name: probe-agent
description: Fixture agent for distribution tests.
tools: Read
hooks:
  PreToolUse:
    - matcher: "Read"
      hooks:
        - type: command
          command: '"C:/tools/node.exe" "C:/proj/hooks/h.mjs"'
---

Fixture body line one.
`;

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const OPTS = { pluginVersion: '0.1.0', now: T0 };

function scratch() {
  return mkdtempSync(join(tmpdir(), 'sterling-dist-test-'));
}

function makePluginSide(dir, templates) {
  const templatesDir = join(dir, 'agent-templates');
  mkdirSync(templatesDir, { recursive: true });
  const agents = [];
  for (const [file, content] of Object.entries(templates)) {
    writeFileSync(join(templatesDir, file), content);
    const name = content.match(/^name:\s*(\S+)/m)[1];
    agents.push({ name, file });
  }
  const registryPath = join(templatesDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, agents }, null, 2));
  return { templatesDir, registryPath };
}

test('renderInstalledAgent produces a parseable header and intact content hash', () => {
  const { name, installedContent } = renderInstalledAgent(TEMPLATE, 'probe-agent.md', OPTS);
  assert.equal(name, 'probe-agent');
  const header = parseInstalledHeader(installedContent);
  assert.ok(header, 'header must parse');
  assert.equal(header.pluginVersion, '0.1.0');
  assert.equal(header.template, 'probe-agent');
  assert.equal(header.templateHash, sha256(TEMPLATE));
  assert.equal(header.installedAt, T0);
  assert.equal(isLocallyModified(installedContent, header), false);
  assert.match(installedContent, /^---\n/, 'frontmatter must stay first for the platform');
  assert.ok(installedContent.includes('Fixture body line one.'));
});

test('renderInstalledAgent refuses backslash hook commands (spec §6 emission rule)', () => {
  const bad = TEMPLATE.replace('"C:/proj/hooks/h.mjs"', '"C:\\\\proj\\\\hooks\\\\h.mjs"');
  assert.ok(findBackslashHookCommands(bad.match(/^---\n([\s\S]*?)\n---/)[1]).length > 0);
  assert.throws(() => renderInstalledAgent(bad, 'bad.md', OPTS), /backslash check failed/);
});

test('renderInstalledAgent refuses dead terms in template content', () => {
  const bad = TEMPLATE.replace('Fixture body line one.', 'Inherited from Forge waves.');
  assert.ok(findDeadTerms(bad).length >= 2);
  assert.throws(() => renderInstalledAgent(bad, 'bad.md', OPTS), /dead-term check failed/);
});

test('isLocallyModified detects edits and tolerates CRLF churn', () => {
  const { installedContent } = renderInstalledAgent(TEMPLATE, 'probe-agent.md', OPTS);
  const header = parseInstalledHeader(installedContent);
  assert.equal(isLocallyModified(installedContent.replace(/\n/g, '\r\n'), parseInstalledHeader(installedContent.replace(/\n/g, '\r\n'))), false, 'CRLF conversion is not a modification');
  const edited = installedContent.replace('Fixture body line one.', 'Locally tweaked.');
  assert.equal(isLocallyModified(edited, header), true);
});

test('installAgents installs every registered agent and returns the restart instruction', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    const { report, restartInstruction } = installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    assert.deepEqual(report, [{ name: 'probe-agent', status: 'installed' }]);
    assert.equal(restartInstruction, RESTART_INSTRUCTION);
    assert.match(restartInstruction, /RESTART REQUIRED/);
    const installed = readFileSync(join(targetAgentsDir, 'probe-agent.md'), 'utf8');
    assert.ok(parseInstalledHeader(installed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installAgents throws on registry/template name mismatch', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'other-name', file: 'probe-agent.md' }] }));
    assert.throws(
      () => installAgents({ templatesDir, registryPath, targetAgentsDir: join(dir, 'p', '.claude', 'agents'), ...OPTS }),
      /name mismatch/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents covers every status path', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');

    // missing -> installed
    let r = syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    assert.deepEqual(r.report.map((x) => x.status), ['installed']);

    // unchanged -> up_to_date
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    assert.deepEqual(r.report.map((x) => x.status), ['up_to_date']);

    // template changed, install clean -> refreshed (header re-rendered)
    const v2 = TEMPLATE.replace('line one', 'line one v2');
    writeFileSync(join(templatesDir, 'probe-agent.md'), v2);
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(r.report.map((x) => x.status), ['refreshed']);
    const refreshed = readFileSync(join(targetAgentsDir, 'probe-agent.md'), 'utf8');
    assert.ok(refreshed.includes('line one v2'));
    assert.equal(parseInstalledHeader(refreshed).pluginVersion, '0.2.0');

    // locally modified + template unchanged -> noted, untouched
    const installedPath = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(installedPath, refreshed.replace('line one v2', 'local tweak'));
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(r.report.map((x) => x.status), ['locally_modified_up_to_date']);

    // locally modified + template changed -> refused, file untouched, instruction present
    const v3 = v2.replace('line one v2', 'line one v3');
    writeFileSync(join(templatesDir, 'probe-agent.md'), v3);
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.3.0', now: T1 });
    assert.equal(r.report[0].status, 'refused_local_modification');
    assert.match(r.report[0].instruction, /will not overwrite local changes/);
    assert.ok(readFileSync(installedPath, 'utf8').includes('local tweak'), 'refused file must be untouched');

    // file without a sterling header -> foreign_file, untouched
    writeFileSync(installedPath, '---\nname: probe-agent\n---\nhand-written\n');
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.3.0', now: T1 });
    assert.equal(r.report[0].status, 'foreign_file');
    assert.ok(readFileSync(installedPath, 'utf8').includes('hand-written'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents repairs header-only drift (in-place edit mirrored in the template) instead of refusing', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });

    // The pinning incident: the same edit lands in the template AND in the
    // installed copy, but the installed header keeps the old hashes.
    const pinned = TEMPLATE.replace('tools: Read', 'tools: Read\nmodel: claude-sonnet-4-6');
    writeFileSync(join(templatesDir, 'probe-agent.md'), pinned);
    const installedPath = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(installedPath, readFileSync(installedPath, 'utf8').replace('tools: Read', 'tools: Read\nmodel: claude-sonnet-4-6'));

    let r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(r.report, [{ name: 'probe-agent', status: 'header_repaired' }]);
    const repaired = readFileSync(installedPath, 'utf8');
    assert.ok(repaired.includes('model: claude-sonnet-4-6'), 'edited content survives the repair');
    const header = parseInstalledHeader(repaired);
    assert.equal(header.templateHash, sha256(pinned), 'header now records the current template');
    assert.equal(isLocallyModified(repaired, header), false, 'content hash is consistent again');
    assert.equal(header.installedAt, T1, 'repair re-stamps installed_at (restart semantics)');

    // converged: the next sync is a no-op
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1 });
    assert.deepEqual(r.report.map((x) => x.status), ['up_to_date']);

    // genuine divergence on a changed template still refuses, file untouched
    writeFileSync(installedPath, repaired.replace('Fixture body line one.', 'a real local edit'));
    writeFileSync(join(templatesDir, 'probe-agent.md'), pinned.replace('line one', 'line one v2'));
    r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.3.0', now: T1 });
    assert.equal(r.report[0].status, 'refused_local_modification');
    assert.ok(readFileSync(installedPath, 'utf8').includes('a real local edit'), 'refused file must be untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents never repairs across a machine-var difference (frontmatter divergence refuses)', () => {
  const dir = scratch();
  try {
    const VAR_TEMPLATE = TEMPLATE.replace('"C:/tools/node.exe"', '{{NODE}}');
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': VAR_TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS, vars: { NODE: '"/usr/bin/node"' } });

    // Header-only drift is forged exactly as in the repair test — but the
    // machine changed: the fresh render bakes a different NODE into the
    // frontmatter, so the bodies differ and repair must NOT fire.
    const v2 = VAR_TEMPLATE.replace('line one', 'line one v2');
    writeFileSync(join(templatesDir, 'probe-agent.md'), v2);
    const installedPath = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(installedPath, readFileSync(installedPath, 'utf8').replace('line one', 'line one v2'));

    const r = syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: T1, vars: { NODE: '"C:/other/node.exe"' } });
    assert.equal(r.report[0].status, 'refused_local_modification');
    assert.ok(readFileSync(installedPath, 'utf8').includes('/usr/bin/node'), 'file untouched — the other machine’s baked paths preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAgentsVisible: ok / missing_agent / restart_required / missing_generated_header', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');

    // not installed yet
    let v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: T1 });
    assert.equal(v.visible, false);
    assert.deepEqual(v.problems, [{ name: 'probe-agent', reason: 'missing_agent' }]);

    // installed at T0, session started T1 (after) -> visible
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: T1 });
    assert.deepEqual(v, { visible: true, problems: [] });

    // session started before install -> restart_required
    v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: '2025-12-31T00:00:00.000Z' });
    assert.equal(v.visible, false);
    assert.deepEqual(v.problems, [{ name: 'probe-agent', reason: 'restart_required' }]);

    // header stripped -> missing_generated_header
    const p = join(targetAgentsDir, 'probe-agent.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/<!-- sterling-generated [^\n]*-->\n/, ''));
    v = checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: T1 });
    assert.deepEqual(v.problems, [{ name: 'probe-agent', reason: 'missing_generated_header' }]);

    assert.throws(() => checkAgentsVisible({ registryPath, targetAgentsDir, sessionStartedAt: 'not-a-date' }), /unparseable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkRegistryConsistency: pass and each violation kind', () => {
  const dir = scratch();
  try {
    const { templatesDir, registryPath } = makePluginSide(dir, { 'probe-agent.md': TEMPLATE });
    assert.deepEqual(checkRegistryConsistency({ templatesDir, registryPath }), []);

    // unregistered template
    writeFileSync(join(templatesDir, 'stray.md'), TEMPLATE.replace('probe-agent', 'stray'));
    let v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['unregistered_template']);
    rmSync(join(templatesDir, 'stray.md'));

    // missing template file
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'probe-agent', file: 'probe-agent.md' }, { name: 'ghost', file: 'ghost.md' }] }));
    v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['missing_template_file']);

    // name mismatch
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'wrong-name', file: 'probe-agent.md' }] }));
    v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['name_mismatch']);

    // backslash hook command in a template
    writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'probe-agent', file: 'probe-agent.md' }] }));
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE.replace('"C:/proj/hooks/h.mjs"', '"C:\\\\proj\\\\hooks\\\\h.mjs"'));
    v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['backslash_hook_command']);
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE);

    // dead term in template body and in a scanned dir
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE.replace('Fixture body', 'Forge fixture body'));
    v = checkRegistryConsistency({ templatesDir, registryPath });
    assert.deepEqual(v.map((x) => x.kind), ['dead_term']);
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE);

    const scanDir = join(dir, 'scaffolds');
    mkdirSync(scanDir);
    writeFileSync(join(scanDir, 'note.md'), 'leftover brainstormer text');
    v = checkRegistryConsistency({ templatesDir, registryPath, scanDirs: [scanDir] });
    assert.deepEqual(v.map((x) => x.kind), ['dead_term']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dead-term patterns match the canonical kill list and nothing legitimate', () => {
  assert.equal(findDeadTerms('Quartermaine called a wave of brainstormers from the forge').length, 4);
  assert.equal(findDeadTerms('Sterling phase execution; intake; steps; wavelength; forget').length, 0);
});
