// GitHub #288: a project that tracks .opencode/opencode.json in git still gets its untracked
// Sterling agent files refreshed. Only the config write is skipped, with a loud non-refusal
// row, so sync-agents exits 0 and the post-update marker is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupOpenCode, formatOpenCodeRows } from '../lib/opencode-install.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OC = () => ({ installed: true, version: '2.0.23', major: 2 });
const CONFIG_REL = '.opencode/opencode.json';
const CONDUCTOR_REL = '.opencode/agents/sterling/conductor.md';

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

test('a tracked .opencode/opencode.json: agent files written, config untouched, row is skipped not refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const parent = mkdtempSync(join(tmpdir(), 'oc-tracked-'));
  const dir = join(parent, 'p');
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    mkdirSync(join(dir, '.opencode'), { recursive: true });
    git(dir, ['init', '-q']);
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
    const own = '{"team": "harness"}\n';
    writeFileSync(join(dir, CONFIG_REL), own);
    git(dir, ['add', '-f', CONFIG_REL]);
    const r = setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: false, probe: OC });
    assert.ok(!r.rows.some((x) => x.refused), 'no row is a refusal, so sync-agents exits 0');
    assert.equal(r.rows.find((x) => x.item === CONDUCTOR_REL)?.status, 'created');
    assert.ok(existsSync(join(dir, CONDUCTOR_REL)), 'agent files are written');
    assert.equal(readFileSync(join(dir, CONFIG_REL), 'utf8'), own, 'the tracked config is not written');
    const row = r.rows.find((x) => x.item === CONFIG_REL);
    assert.equal(row.status, 'skipped');
    assert.match(formatOpenCodeRows(r).find((l) => l.startsWith(`OpenCode skipped: ${CONFIG_REL}`)), /^OpenCode skipped: .*NOT written: .*tracked by git/);
  } finally {
    for (const d of [parent, home]) rmSync(d, { recursive: true, force: true });
  }
});
