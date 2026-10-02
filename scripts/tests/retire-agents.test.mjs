import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInstalledAgent, installAgents, syncAgents, agentChangesRequireRestart } from '../lib/agent-distribution.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T0 = '2026-01-01T00:00:00.000Z';
const opts = { pluginVersion: '0.1.0', now: T0 };
const TEMPLATE = `---
name: probe-agent
description: Fixture agent.
tools: Read
---

Probe body.
`;
const RETIRED = `---
name: old-agent
description: Retired fixture agent.
tools: Read
---

Old body.
`;

function scratch() { return mkdtempSync(join(tmpdir(), 'sterling-retire-test-')); }
function setup(dir) {
  const templatesDir = join(dir, 'agent-templates');
  const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE);
  const registryPath = join(templatesDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'probe-agent', file: 'probe-agent.md' }] }));
  return { templatesDir, targetAgentsDir, registryPath };
}
function generated(template = RETIRED) { return renderInstalledAgent(template, 'fixture.md', opts).installedContent; }
function sync(side, extra = {}) { return syncAgents({ ...side, ...opts, ...extra }); }

test('retirement: foreign files are untouched; clean generated retired files are deleted and a second run is idempotent', () => {
  const dir = scratch();
  try {
    const side = setup(dir);
    mkdirSync(side.targetAgentsDir, { recursive: true });
    const foreign = join(side.targetAgentsDir, 'notes.md');
    const retired = join(side.targetAgentsDir, 'old-agent.md');
    writeFileSync(foreign, 'my custom agent\n');
    writeFileSync(retired, generated());
    const first = sync(side);
    assert.deepEqual(first.report.map(({ name, status }) => ({ name, status })), [
      { name: 'probe-agent', status: 'installed' }, { name: 'old-agent', status: 'retired' },
    ]);
    assert.equal(readFileSync(foreign, 'utf8'), 'my custom agent\n');
    assert.equal(existsSync(retired), false);
    const second = sync(side);
    assert.deepEqual(second.report.map(({ name, status }) => ({ name, status })), [{ name: 'probe-agent', status: 'up_to_date' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retirement preserves modified, identity-mismatched, and malformed Sterling files as exit-2 refusals', () => {
  const dir = scratch();
  try {
    const side = setup(dir);
    mkdirSync(side.targetAgentsDir, { recursive: true });
    const modified = join(side.targetAgentsDir, 'old-agent.md');
    const copied = join(side.targetAgentsDir, 'my-probe-agent.md');
    const malformed = join(side.targetAgentsDir, 'broken.md');
    writeFileSync(modified, generated().replace('Old body.', 'local edit.'));
    writeFileSync(copied, renderInstalledAgent(TEMPLATE, 'probe-agent.md', opts).installedContent);
    writeFileSync(malformed, '---\nname: broken\n---\n<!-- sterling-generated v=broken -->\nbody\n');
    const { report } = sync(side);
    assert.deepEqual(report.filter((r) => r.refused).map((r) => r.status).sort(), [
      'retired_but_modified', 'retired_identity_mismatch', 'retired_unrecognized',
    ]);
    for (const path of [modified, copied, malformed]) assert.equal(existsSync(path), true, `${path} is preserved`);
    for (const r of report.filter((r) => r.refused)) {
      assert.match(r.instruction, /archive the file outside \.claude\/agents\//);
      assert.match(r.instruction, /removing the Sterling header/);
      assert.match(r.instruction, /delete it/);
      assert.doesNotMatch(r.instruction, /new template/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retirement never follows a symlink and reports a delete failure', () => {
  const dir = scratch();
  try {
    const side = setup(dir);
    mkdirSync(side.targetAgentsDir, { recursive: true });
    const outside = join(dir, 'outside.md');
    const link = join(side.targetAgentsDir, 'old-agent.md');
    writeFileSync(outside, generated());
    symlinkSync(outside, link);
    assert.deepEqual(sync(side).report.map((r) => r.status), ['installed'], 'symlink is ignored rather than followed');
    assert.equal(existsSync(link), true);

    rmSync(link);
    writeFileSync(link, generated());
    const failure = sync(side, { retirementFs: { unlinkSync: () => { const err = new Error('denied'); err.code = 'EACCES'; throw err; } } });
    const r = failure.report.find((x) => x.name === 'old-agent');
    assert.equal(r.status, 'retired_delete_failed');
    assert.equal(r.refused, true);
    assert.match(r.instruction, /EACCES/);
    assert.equal(existsSync(link), true, 'failed deletion never silently removes the file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retirement quarantines before delete: a replacement between verification and delete is never unlinked', () => {
  const dir = scratch();
  try {
    const side = setup(dir);
    mkdirSync(side.targetAgentsDir, { recursive: true });
    const retired = join(side.targetAgentsDir, 'old-agent.md');
    writeFileSync(retired, generated());
    let held;
    const result = sync(side, { retirementFs: {
      afterQuarantineVerify: ({ path, quarantine }) => {
        held = quarantine;
        writeFileSync(path, 'user authored replacement\n');
        writeFileSync(quarantine, 'different regular file\n');
      },
    } });
    const row = result.report.find((x) => x.name === 'old-agent');
    assert.equal(row.status, 'retired_delete_failed');
    assert.equal(row.refused, true);
    assert.equal(readFileSync(retired, 'utf8'), 'user authored replacement\n', 'the replacement at the original path survives');
    assert.match(row.instruction, /remains quarantined/, 'unverified quarantine is retained for inspection');
    assert.equal(readFileSync(held, 'utf8'), 'different regular file\n', 'unverified quarantine survives too');
    // Also exercise successful retirement when only the ORIGINAL pathname is
    // replaced during the seam: deletion must still target the quarantine.
    writeFileSync(retired, generated());
    const valid = sync(side, { retirementFs: {
      afterQuarantineVerify: ({ path }) => writeFileSync(path, 'second user replacement\n'),
    } });
    assert.equal(valid.report.find((x) => x.name === 'old-agent').status, 'retired');
    assert.equal(readFileSync(retired, 'utf8'), 'second user replacement\n', 'successful retirement cannot unlink the new original-path file');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid registry and an unrenderable replacement leave retired files intact', () => {
  const dir = scratch();
  try {
    const side = setup(dir);
    mkdirSync(side.targetAgentsDir, { recursive: true });
    const retired = join(side.targetAgentsDir, 'old-agent.md');
    writeFileSync(retired, generated());
    writeFileSync(side.registryPath, JSON.stringify({ version: 1, agents: [
      { name: 'probe-agent', file: 'probe-agent.md' }, { name: 'probe-agent', file: 'second.md' },
    ] }));
    writeFileSync(join(side.templatesDir, 'second.md'), TEMPLATE);
    assert.throws(() => sync(side), /duplicate agent name/);
    assert.equal(existsSync(retired), true, 'invalid registry performs no retirement');
    writeFileSync(side.registryPath, JSON.stringify({ version: 1, agents: [{ name: 'probe-agent', file: 'missing.md' }] }));
    assert.throws(() => sync(side), /ENOENT/);
    assert.equal(existsSync(retired), true, 'failed replacement render performs no retirement');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installAgents refuses a locally modified registered agent', () => {
  const dir = scratch();
  try {
    const side = setup(dir);
    installAgents({ ...side, ...opts });
    const installed = join(side.targetAgentsDir, 'probe-agent.md');
    writeFileSync(installed, readFileSync(installed, 'utf8').replace('Probe body.', 'local body.'));
    writeFileSync(join(side.templatesDir, 'probe-agent.md'), TEMPLATE.replace('Probe body.', 'new template body.'));
    const result = installAgents({ ...side, ...opts });
    assert.equal(result.report[0].status, 'refused_local_modification');
    assert.equal(result.report[0].refused, true);
    assert.match(readFileSync(installed, 'utf8'), /local body\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retirement alone requires restart, and init recognizes every retirement status', () => {
  assert.equal(agentChangesRequireRestart([{ name: 'old-agent', status: 'retired' }]), true);
  assert.equal(agentChangesRequireRestart([{ name: 'old-agent', status: 'retired_but_modified' }]), false);
  const initSource = readFileSync(join(root, 'scripts', 'init-impl.mjs'), 'utf8');
  for (const status of ['retired', 'retired_unrecognized', 'retired_but_modified', 'retired_identity_mismatch', 'retired_read_failed', 'retired_delete_failed', 'retired_scan_failed']) {
    assert.match(initSource, new RegExp(`${status}:`), `init status map handles ${status}`);
  }
});
