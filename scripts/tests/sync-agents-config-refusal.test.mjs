// sync-agents on a project whose .sterling/config.json does not validate: the
// config is refused with exit 2 and one actionable line, before anything is
// written, so /sterling:update reports the project as refused instead of a crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function project(config) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sync-config-'));
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  return dir;
}

function sync(dir) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'sync-agents.mjs'), '--target', dir], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, STERLING_CLAUDE_PROBE: 'ok', STERLING_OPENCODE_SETUP_DISABLE: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

for (const [label, models, why] of [
  ['a model with a newline', { scout: { model: 'claude-sonnet-5-5\nhooks: x', effort: 'low' } }, /Claude model id/],
  ['an unknown effort', { scout: { model: 'claude-sonnet-5-5', effort: 'extreme' } }, /effort/],
]) {
  test(`a config.json that fails the schema (${label}) is refused with exit 2 and nothing is written`, () => {
    const dir = project({ mode: 'hobby', models });
    try {
      const r = sync(dir);
      assert.equal(r.code, 2, r.out);
      const lines = r.out.split('\n').filter((l) => l.startsWith('refused_config: '));
      assert.equal(lines.length, 1, r.out);
      assert.match(lines[0], /\.sterling\/config\.json does not validate/);
      assert.match(lines[0], why);
      assert.match(lines[0], /then rerun \/sterling:update; nothing synced$/);
      assert.equal(existsSync(join(dir, '.claude')), false, 'no Claude agent written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a valid config.json still syncs with exit 0', () => {
  const dir = project({ mode: 'hobby', models: { scout: { model: 'claude-sonnet-5-5', effort: 'low' } } });
  try {
    const r = sync(dir);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /refused_config/);
    assert.ok(existsSync(join(dir, '.claude', 'agents', 'scout.md')), r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
