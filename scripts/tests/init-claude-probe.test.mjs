// /sterling:init on a machine without Claude Code (decision
// init-without-claude-code-probes-and-skips-claude-artifacts-loudly, P7 slice S4):
// init probes for `claude` the way it probes for `opencode`; when it is absent the
// Claude-only project files are not written, ONE loud line names them, and the
// OpenCode side is still written. Claude present is unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeClaude } from '../lib/claude-probe.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRESH_FLAGS = ['--project-name', 'claude-probe', '--stack-tags', 'node', '--domain-description', 'node=test domain node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups', '--mode', 'work'];
const CLAUDE_FILES = ['sterling-launch.sh', 'sterling.bat', 'tui.bat', '.claude'];
const SKIP_LINE = /^.*Claude Code not found.*$/gm;

const scratch = new Set();
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.add(d);
  return d;
}
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// A spawn of init fully isolated from the machine: scratch HOME, registry, plugin-root
// match and Claude config dir (the same containment init-ensure.test.mjs applies).
const homes = new Map(); // one scratch HOME per target dir, so a re-run sees the domain stores the first run created
function init(dir, extraEnv = {}) {
  if (!homes.has(dir)) homes.set(dir, tmp('sterling-cp-home-'));
  const env = {
    ...process.env,
    HOME: homes.get(dir),
    STERLING_REGISTRY_DB: join(dir, 'registry.db'),
    STERLING_PLUGIN_ROOT_MATCH: tmp('sterling-cp-root-'),
    CLAUDE_CONFIG_DIR: tmp('sterling-cp-cfg-'),
    STERLING_CODEX_PROBE: 'absent',
    STERLING_OPENCODE_SETUP_DISABLE: '1',
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'init.mjs'), '--target', dir, ...FRESH_FLAGS], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    env,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------- probeClaude (mirrors probeOpenCode) ----------

function fakeBin(script) {
  const dir = tmp('sterling-cp-bin-');
  if (script !== null) {
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'claude'), 0o755);
  }
  return dir;
}

test('probeClaude reports installed with the version when `claude --version` prints one', () => {
  const p = probeClaude({ env: { PATH: fakeBin('echo "2.1.7 (Claude Code)"') } });
  assert.deepEqual(p, { installed: true, version: '2.1.7', major: 2 });
});

test('probeClaude reports not installed with a reason when claude is not on PATH', () => {
  const p = probeClaude({ env: { PATH: fakeBin(null) } });
  assert.equal(p.installed, false);
  assert.match(p.reason, /no `claude` on PATH/);
});

test('probeClaude reports not installed when claude exits non-zero or prints no version', () => {
  const failing = probeClaude({ env: { PATH: fakeBin('echo boom >&2; exit 3') } });
  assert.equal(failing.installed, false);
  assert.match(failing.reason, /exited 3/);
  const mute = probeClaude({ env: { PATH: fakeBin('echo hello') } });
  assert.equal(mute.installed, false);
  assert.match(mute.reason, /without a version/);
});

// ---------- init ----------

test('(a) claude absent: no Claude-only file is written, ONE loud line names them, the OpenCode side is written', () => {
  const dir = tmp('sterling-cp-a-');
  const r = init(dir, { STERLING_CLAUDE_PROBE: 'absent' });
  assert.equal(r.code, 0, r.stderr);
  for (const f of CLAUDE_FILES) assert.ok(!existsSync(join(dir, f)), `${f} must not be written without Claude Code`);
  assert.ok(!existsSync(join(dir, '.sterling', 'synced-version')), 'no agent sync happened, so no synced-version marker');
  const lines = r.stdout.match(SKIP_LINE) ?? [];
  assert.equal(lines.length, 1, `exactly one skip line, got: ${JSON.stringify(lines)}`);
  for (const name of ['sterling-launch.sh', 'sterling.bat', 'tui.bat', '.claude/agents', '.claude/settings.json']) {
    assert.ok(lines[0].includes(name), `the line names ${name}`);
  }
  assert.ok(!/codex/i.test(r.stdout.replace(lines[0], '')), 'the ~/.claude.json Codex probe did not run');
  assert.ok(!/RESTART REQUIRED/.test(r.stdout), 'no agent was installed, so no restart is owed');
  // the host-independent and OpenCode side is intact
  for (const f of ['.sterling/config.json', 'AGENTS.md', 'sterling-update.bat', '.opencode/agents/scout.md']) {
    assert.ok(existsSync(join(dir, f)), `${f} is still written`);
  }
  assert.match(r.stdout, /^\.opencode\/agents\/scout\.md\s+created\b/m);
});

test('(b) claude present: every Claude file is written and no skip line is printed', () => {
  const dir = tmp('sterling-cp-b-');
  const r = init(dir, { STERLING_CLAUDE_PROBE: 'ok' });
  assert.equal(r.code, 0, r.stderr);
  for (const f of [...CLAUDE_FILES, '.claude/agents/librarian.md', '.claude/settings.json', '.sterling/synced-version', '.opencode/agents/scout.md']) {
    assert.ok(existsSync(join(dir, f)), `${f} is written with Claude Code present`);
  }
  assert.equal((r.stdout.match(SKIP_LINE) ?? []).length, 0, 'no skip line');
  assert.match(r.stdout, /^sterling-launch\.sh\s+created\b/m);
  assert.match(r.stdout, /^\.claude\/agents\/librarian\.md\s+created\b/m);
  assert.match(r.stdout, /^\.claude\/settings\.json \(conductor activation\)\s+created\b/m);
  assert.match(r.stdout, /RESTART REQUIRED/);
  assert.match(r.stdout, /codex/i, 'the codex user-scope check ran');
});

test('(b) a later init with claude present adds the Claude files a claude-less init skipped', () => {
  const dir = tmp('sterling-cp-b2-');
  assert.equal(init(dir, { STERLING_CLAUDE_PROBE: 'absent' }).code, 0);
  assert.ok(!existsSync(join(dir, 'sterling-launch.sh')));
  const r = init(dir, { STERLING_CLAUDE_PROBE: 'ok' });
  assert.equal(r.code, 0, r.stderr);
  for (const f of ['sterling-launch.sh', 'sterling.bat', 'tui.bat', '.claude/agents/librarian.md', '.claude/settings.json']) {
    assert.ok(existsSync(join(dir, f)), `${f} added by the later init`);
  }
});

test('(c) neither host present (real probes, empty PATH): init completes, skips both hosts, prints the claude line once', () => {
  const dir = tmp('sterling-cp-c-');
  const r = init(dir, { PATH: tmp('sterling-cp-empty-'), STERLING_OPENCODE_SETUP_DISABLE: undefined });
  assert.equal(r.code, 0, r.stderr);
  for (const f of CLAUDE_FILES) assert.ok(!existsSync(join(dir, f)), `${f} not written`);
  assert.equal((r.stdout.match(SKIP_LINE) ?? []).length, 1);
  assert.match(r.stdout, /no `claude` on PATH/, 'the real probe supplied the reason');
  assert.match(r.stdout, /^Sterling on OpenCode 2\s+skipped\s+OpenCode not installed/m, 'OpenCode setup is skipped exactly as before');
  assert.ok(existsSync(join(dir, '.sterling', 'config.json')) && existsSync(join(dir, 'AGENTS.md')));
});

test('an unrecognized STERLING_CLAUDE_PROBE value fails init loud', () => {
  const dir = tmp('sterling-cp-bad-');
  const r = init(dir, { STERLING_CLAUDE_PROBE: 'garbage' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /STERLING_CLAUDE_PROBE must be/);
});
