// sync-agents on a machine without Claude Code (decision
// init-without-claude-code-probes-and-skips-claude-artifacts-loudly): the npm copy's
// post-update sync runs sync-agents, which used to write .claude/agents/ and
// .claude/settings.json unconditionally. Without `claude` those Claude-only files are
// skipped with one loud line; the OpenCode side still runs. STERLING_CLAUDE_PROBE is the
// same test seam init honors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-sync-probe-'));
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  return dir;
}

function sync(dir, probe) {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'sync-agents.mjs'), '--target', dir], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, STERLING_CLAUDE_PROBE: probe, STERLING_OPENCODE_SETUP_DISABLE: '1' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('without Claude Code, sync-agents writes no .claude/ file and says so in one loud line', () => {
  const dir = project();
  try {
    const r = sync(dir, 'absent');
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(join(dir, '.claude')), false, 'no .claude/agents and no .claude/settings.json');
    const loud = r.out.split('\n').filter((l) => /Claude Code not found/.test(l));
    assert.equal(loud.length, 1, r.out);
    assert.match(loud[0], /STERLING_CLAUDE_PROBE=absent.*skipped the Claude-only files: \.claude\/agents\/ and \.claude\/settings\.json/);
    assert.match(r.out, /OpenCode: /, 'the OpenCode side still runs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with Claude Code, sync-agents writes the Claude agents and the conductor activation as before', () => {
  const dir = project();
  try {
    const r = sync(dir, 'ok');
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(dir, '.claude', 'agents', 'conductor.md')), r.out);
    assert.ok(existsSync(join(dir, '.claude', 'settings.json')), r.out);
    assert.doesNotMatch(r.out, /Claude Code not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognized STERLING_CLAUDE_PROBE value fails sync-agents loud before any write', () => {
  const dir = project();
  try {
    const r = sync(dir, 'garbage');
    assert.equal(r.code, 2);
    assert.match(r.out, /STERLING_CLAUDE_PROBE must be 'ok' or 'absent' \(got 'garbage'\)/);
    assert.equal(existsSync(join(dir, '.claude')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
