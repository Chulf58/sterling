// Init's per-agent store guard on native V2 agents (scripts/lib/opencode-install.mjs
// ensureProjectConfig). Sol review of sterling/agent-discovery-v2-agents, finding (c): an
// agent defined under `agents` in the project's own .opencode/opencode.json got no guard
// ("per-agent store guard on 0 agents"). Within one document the native entry wins over a
// legacy `agent` entry (opencode.ai/v2/docs/migrate-v1), so the guard goes into the native
// entry's own `permissions` list, last (the last matching rule wins,
// opencode.ai/v2/docs/agents "Permissions"), and every other field stays as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureProjectConfig, STORE_GUARD_PATTERNS } from '../lib/opencode-install.mjs';

const GUARD = STORE_GUARD_PATTERNS.map((resource) => ({ action: 'edit', resource, effect: 'deny' }));

function project(config) {
  const base = mkdtempSync(join(tmpdir(), 'sterling-native-guard-'));
  const dir = join(base, 'project');
  mkdirSync(join(dir, '.opencode'), { recursive: true });
  writeFileSync(join(dir, '.opencode', 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`);
  const run = () => ensureProjectConfig({ projectDir: dir, env: { XDG_CONFIG_HOME: join(base, 'xdg') }, home: base, tracked: [], opencodeVersion: '2.1.2', systemDir: join(base, 'system') });
  const read = () => JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8'));
  return { run, read, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('native agents in the project opencode.json are guarded through their own permissions, user rules and disabled kept', () => {
  const userRule = { action: 'edit', resource: '*', effect: 'allow' };
  const p = project({ agents: { 'team/writer': { mode: 'subagent', system: 'Write.', permissions: [userRule] }, 'team/off': { disabled: true } } });
  try {
    const rows = p.run();
    const row = rows.find((r) => r.item === '.opencode/opencode.json');
    assert.match(row.detail, /per-agent store guard on 2 agents/);
    const out = p.read();
    assert.deepEqual(out.agents['team/writer'], { mode: 'subagent', system: 'Write.', permissions: [userRule, ...GUARD] });
    assert.deepEqual(out.agents['team/off'], { disabled: true, permissions: GUARD });
    assert.equal(out.agent?.['team/writer'], undefined, 'no legacy entry is written for a native agent');
  } finally {
    p.cleanup();
  }
});

test('a second run leaves the guarded native entries as they are, with the guard still last', () => {
  const p = project({ agents: { 'team/writer': { mode: 'subagent', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] } } });
  try {
    p.run();
    const first = JSON.stringify(p.read());
    const rows = p.run();
    assert.equal(rows.find((r) => r.item === '.opencode/opencode.json').status, 'matches');
    assert.equal(JSON.stringify(p.read()), first);
  } finally {
    p.cleanup();
  }
});

test('a native entry whose permissions is not a list is refused, not rewritten', () => {
  const p = project({ agents: { x: { permissions: { edit: 'allow' } } } });
  try {
    const rows = p.run();
    assert.equal(rows[0].status, 'refused');
    assert.match(rows[0].detail, /"agents\.x\.permissions" is not a list of rules/);
  } finally {
    p.cleanup();
  }
});
