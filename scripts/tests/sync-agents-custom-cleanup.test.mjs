// sync-agents removes the generated copies of the last adopted custom agent once its config.models key is gone:
// the custom-agent reconciliation runs whenever stamped custom outputs exist, not only while a custom-* key remains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncCustomAgents } from '../lib/custom-agent-render.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the last custom agent removed from config.models: sync-agents deletes its unedited generated copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sync-custom-'));
  try {
    mkdirSync(join(dir, '.sterling'));
    mkdirSync(join(dir, 'agent-sources'));
    writeFileSync(join(dir, 'agent-sources', 'custom-team-scout.md'), '---\nname: team-scout\ndescription: Scouts\n---\nFind.\n');
    const first = syncCustomAgents(dir, { models: { 'custom-team-scout': {} } }, { hosts: ['claude'] });
    assert.equal(first.written.length, 1);
    const copy = join(dir, '.claude', 'agents', 'team-scout.md');
    assert.ok(existsSync(copy));
    // the key is dropped: no custom-* key is left in config.models
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby', models: { scout: { model: 'claude-sonnet-5-5', effort: 'low' } } }));
    const env = { ...process.env, STERLING_CLAUDE_PROBE: 'ok', STERLING_OPENCODE_SETUP_DISABLE: '1' };
    for (const k of ['CLAUDE_CODE_SESSION_ID', 'OPENCODE', 'OPENCODE_SESSION_ID']) delete env[k];
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'sync-agents.mjs'), '--target', dir], { encoding: 'utf8', timeout: 60_000, env });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /removed: \.claude\/agents\/team-scout\.md \(custom agent custom-team-scout is gone\)/);
    assert.equal(existsSync(copy), false, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
