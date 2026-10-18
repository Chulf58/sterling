// The OpenCode post-update sync runs sync-agents in a child of the OpenCode server.
// OpenCode's own installer puts the binary in ~/.opencode/bin, and Sterling's launchers
// start it by that absolute path, so that directory is often not on PATH. sync-agents'
// OpenCode probe used to look on PATH only: it reported "OpenCode not installed",
// skipped the Sterling-full agents, and a stale .opencode/agents/sterling/conductor.md
// stayed stale while the notice said "agents synced, none changed".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../lib/agent-distribution.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEADER_RE = /^<!-- sterling-full renderer=opencode-full\/1 template=(\S+) template_hash=([0-9a-f]{64}) content_hash=([0-9a-f]{64}) -->$/m;
const scratch = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

// PATH with every directory that holds an `opencode` removed, so only ~/.opencode/bin can find it.
const pathWithoutOpenCode = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((dir) => dir && spawnSync('test', ['-x', join(dir, 'opencode')]).status !== 0)
  .join(delimiter);

function syncAgents(project, home, path) {
  const env = { ...process.env, HOME: home, PATH: path, STERLING_CLAUDE_PROBE: 'absent' };
  for (const k of ['STERLING_OPENCODE_SETUP_DISABLE', 'OPENCODE', 'OPENCODE_SESSION_ID', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR']) delete env[k];
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'sync-agents.mjs'), '--target', project], { encoding: 'utf8', timeout: 120_000, env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('sync-agents finds OpenCode in ~/.opencode/bin when it is not on PATH and refreshes a stale Sterling-full conductor', { skip: process.platform === 'win32' }, () => {
  const home = tmp('sterling-oc-home-');
  const bin = join(home, '.opencode', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'opencode'), '#!/bin/sh\necho 2.0.30\n');
  chmodSync(join(bin, 'opencode'), 0o755);
  const project = tmp('sterling-oc-project-');
  mkdirSync(join(project, '.sterling'));
  writeFileSync(join(project, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  const conductor = join(project, '.opencode', 'agents', 'sterling', 'conductor.md');

  // A first sync with OpenCode on PATH writes the current conductor.
  const first = syncAgents(project, home, [bin, pathWithoutOpenCode].join(delimiter));
  assert.equal(first.code, 0, first.out);
  const current = readFileSync(conductor, 'utf8');
  const header = current.match(HEADER_RE)[0];

  // Make it a stale copy Sterling wrote and nobody edited: an older body, and a header
  // whose hashes match that body and an older template.
  const line = current.split('\n').find((l) => l.trim().length > 40 && !l.startsWith('<!--') && !l.startsWith('---'));
  const staleBody = current.replace(`${header}\n`, '').replace(`${line}\n`, '');
  const staleHeader = header
    .replace(/template_hash=[0-9a-f]{64}/, `template_hash=${sha256('an older conductor template')}`)
    .replace(/content_hash=[0-9a-f]{64}/, `content_hash=${sha256(staleBody)}`);
  writeFileSync(conductor, current.replace(`${line}\n`, '').replace(header, staleHeader));
  assert.notEqual(readFileSync(conductor, 'utf8'), current);

  // The post-update sync's child: OpenCode is only in ~/.opencode/bin.
  const second = syncAgents(project, home, pathWithoutOpenCode);
  assert.equal(second.code, 0, second.out);
  assert.doesNotMatch(second.out, /OpenCode not installed/);
  assert.match(second.out, /OpenCode refreshed: \.opencode\/agents\/sterling\/conductor\.md/);
  assert.equal(readFileSync(conductor, 'utf8'), current, 'the stale conductor is rewritten to the current template');
});
