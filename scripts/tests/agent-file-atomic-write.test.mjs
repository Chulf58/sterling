// Installed agent files are replaced atomically (scripts/lib/atomic-write.mjs): a temp file
// in the same directory, named so it never ends in .md, then a rename over the target. An
// unchanged file is not touched. OpenCode reloads its agent registry within 100 ms of a
// change under {agent,agents}/ and silently drops a file it cannot parse, so a file caught
// half-written by an in-place writeFileSync made dispatches fail with 'Agent not found'
// (GitHub #189). The in-place write keeps the target's inode; a rename gives it a new one,
// so the inode tells the two apart without a seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicTempPath, writeFileAtomic, writeFileAtomicIfChanged } from '../lib/atomic-write.mjs';
import { installAgents, syncAgents } from '../lib/agent-distribution.mjs';
import { writeFullAgentFiles } from '../lib/opencode-install.mjs';

const TEMPLATE = `---
name: probe-agent
description: Fixture agent for the atomic-write test.
tools: Read
---

Fixture body line one.
`;
const OPTS = { pluginVersion: '0.1.0', now: '2026-01-01T00:00:00.000Z' };
const OLD = new Date('2020-01-01T00:00:00Z');

function pluginSide(dir, template = TEMPLATE) {
  const templatesDir = join(dir, 'agent-templates');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, 'probe-agent.md'), template);
  const registryPath = join(templatesDir, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ version: 1, agents: [{ name: 'probe-agent', file: 'probe-agent.md' }] }));
  return { templatesDir, registryPath };
}
/** Backdates `path` so a rewrite within the same clock tick still shows as a new mtime. */
function backdate(path) {
  utimesSync(path, OLD, OLD);
  return statSync(path);
}

test('atomicTempPath is in the same directory, dot-prefixed, and never ends in .md', () => {
  const tmp = atomicTempPath('/p/.opencode/agents/sterling/implementor.md');
  assert.match(tmp, new RegExp(`^/p/\\.opencode/agents/sterling/\\.implementor\\.md\\.tmp-${process.pid}-[0-9a-f]{8}$`));
  assert.doesNotMatch(tmp, /\.md$/);
});

test('both writers write only a non-.md temp file in the same directory and rename it over the target', () => {
  for (const [write, tmpRe] of [
    [writeFileAtomic, /^\/d\/agents\/x\.md\.tmp-[0-9a-f-]{36}$/],
    [writeFileAtomicIfChanged, /^\/d\/agents\/\.x\.md\.tmp-\d+-[0-9a-f]{8}$/],
  ]) {
    const calls = [];
    const fs = { writeFile: (p, c) => calls.push(['write', p, c]), rename: (a, b) => calls.push(['rename', a, b]) };
    write('/d/agents/x.md', 'body', fs);
    assert.equal(calls.length, 2, write.name);
    assert.equal(calls[0][0], 'write');
    assert.notEqual(calls[0][1], '/d/agents/x.md', 'the target is never written in place');
    assert.match(calls[0][1], tmpRe, write.name);
    assert.deepEqual(calls[1], ['rename', calls[0][1], '/d/agents/x.md']);
  }
});

test('writeFileAtomicIfChanged leaves a file that already holds the content alone (same mtime and inode)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-atomic-'));
  try {
    const p = join(dir, 'x.md');
    writeFileSync(p, 'same');
    const before = backdate(p);
    assert.equal(writeFileAtomicIfChanged(p, 'same'), false);
    const after = statSync(p);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ino, before.ino);
    assert.equal(writeFileAtomicIfChanged(p, 'new'), true);
    assert.notEqual(statSync(p).ino, before.ino, 'a changed file is replaced by rename');
    assert.deepEqual(readdirSync(dir), ['x.md'], 'no temp file is left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncAgents replaces a stale agent file by rename, and an up-to-date one is not touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-atomic-'));
  try {
    const { templatesDir, registryPath } = pluginSide(dir);
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    const target = join(targetAgentsDir, 'probe-agent.md');
    assert.deepEqual(syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS }).report.map((r) => r.status), ['installed']);

    const installed = backdate(target);
    assert.deepEqual(syncAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS }).report.map((r) => r.status), ['up_to_date']);
    assert.equal(statSync(target).mtimeMs, installed.mtimeMs, 'an up-to-date agent file keeps its mtime');

    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE.replace('line one', 'line one v2'));
    assert.deepEqual(syncAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: OPTS.now }).report.map((r) => r.status), ['refreshed']);
    assert.notEqual(statSync(target).ino, installed.ino, 'the refresh renamed a new file over the target instead of writing it in place');
    assert.deepEqual(readdirSync(targetAgentsDir), ['probe-agent.md'], 'no temp file is left in the agents directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installAgents re-run on an unchanged agent file leaves it alone, and a change goes through rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-atomic-'));
  try {
    const { templatesDir, registryPath } = pluginSide(dir);
    const targetAgentsDir = join(dir, 'project', '.claude', 'agents');
    const target = join(targetAgentsDir, 'probe-agent.md');
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    const first = backdate(target);
    installAgents({ templatesDir, registryPath, targetAgentsDir, ...OPTS });
    assert.equal(statSync(target).mtimeMs, first.mtimeMs, 'an unchanged reinstall keeps the mtime');
    assert.equal(statSync(target).ino, first.ino);
    writeFileSync(join(templatesDir, 'probe-agent.md'), TEMPLATE.replace('line one', 'line one v2'));
    installAgents({ templatesDir, registryPath, targetAgentsDir, pluginVersion: '0.2.0', now: OPTS.now });
    assert.notEqual(statSync(target).ino, first.ino, 'the reinstall renamed a new file over the target');
    assert.deepEqual(readdirSync(targetAgentsDir), ['probe-agent.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFullAgentFiles (the OpenCode agent set) writes through a non-.md temp file and skips an unchanged file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-atomic-'));
  try {
    const same = join(dir, '.opencode', 'agents', 'sterling', 'scout.md');
    const changed = join(dir, '.opencode', 'agents', 'sterling', 'implementor.md');
    mkdirSync(join(dir, '.opencode', 'agents', 'sterling'), { recursive: true });
    writeFileSync(same, 'scout body');
    writeFileSync(changed, 'old body');
    const calls = [];
    const fs = {
      writeFile: (p, c) => {
        calls.push(['write', p]);
        writeFileSync(p, c);
      },
      rename: (a, b) => {
        calls.push(['rename', a, b]);
        renameSync(a, b);
      },
    };
    writeFullAgentFiles([{ path: same, content: 'scout body', previous: 'scout body' }, { path: changed, content: 'new body', previous: 'old body' }], fs);
    assert.equal(calls.length, 2, 'only the changed file is written');
    assert.equal(calls[0][0], 'write');
    assert.match(calls[0][1], /\/\.implementor\.md\.tmp-\d+-[0-9a-f]{8}$/);
    assert.deepEqual(calls[1], ['rename', calls[0][1], changed]);
    assert.ok(!calls.some(([, p]) => p === same), 'the unchanged file is never written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
