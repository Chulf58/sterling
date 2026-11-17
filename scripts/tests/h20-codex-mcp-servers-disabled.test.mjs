// GitHub #262: H20 disables the user's own Codex MCP servers ([mcp_servers.<name>]
// in $CODEX_HOME/config.toml) on every codex opener call, so a Sol review or Astra
// consult starts none of them. The model pin and the caller's config are kept and a
// caller-set mcp_servers entry wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(root, 'scripts', 'hooks', 'h20-mechanism-axis.mjs');

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-mcp-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ sparring_partner: { enabled: true, model: 'gpt-5.6-sol' } }));
  return dir;
}

function codexHome(toml) {
  const home = mkdtempSync(join(tmpdir(), 'sterling-codex-home-'));
  if (toml !== null) writeFileSync(join(home, 'config.toml'), toml);
  return home;
}

function run(dir, home, tool_input, tool_name = 'mcp__codex__codex') {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's1', cwd: dir }),
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, CODEX_HOME: home },
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const env = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { env, ui: env?.hookSpecificOutput?.updatedInput, text: r.stdout };
}

const TOML = `model = "x"\n[mcp_servers.godot]\ncommand = "node"\n[mcp_servers.godot.env]\nA = "1"\n[mcp_servers."blender"]\ncommand = "uv"\n[other]\n`;

test('two user MCP servers are disabled, model pin and caller config kept', () => {
  const dir = project();
  const home = codexHome(TOML);
  try {
    const { ui } = run(dir, home, { prompt: 'review', config: { sandbox_mode: 'read-only' } });
    assert.equal(ui.model, 'gpt-5.6-sol');
    assert.equal(ui.prompt, 'review');
    assert.equal(ui.config.sandbox_mode, 'read-only');
    assert.deepEqual(ui.config.mcp_servers, { godot: { enabled: false }, blender: { enabled: false } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a caller-set mcp_servers entry wins', () => {
  const dir = project();
  const home = codexHome(TOML);
  try {
    const { ui } = run(dir, home, { prompt: 'p', config: { mcp_servers: { godot: { enabled: true } } } });
    assert.deepEqual(ui.config.mcp_servers, { godot: { enabled: true }, blender: { enabled: false } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('absent config.toml injects no config and does not fail the call', () => {
  const dir = project();
  const home = codexHome(null);
  try {
    const { ui } = run(dir, home, { prompt: 'p' });
    assert.equal(ui.model, 'gpt-5.6-sol');
    assert.equal(Object.hasOwn(ui, 'config'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('unreadable config.toml discloses and injects no config', () => {
  const dir = project();
  const home = codexHome(null);
  mkdirSync(join(home, 'config.toml')); // a directory: read fails with EISDIR
  try {
    const { ui, text } = run(dir, home, { prompt: 'p' });
    assert.equal(Object.hasOwn(ui, 'config'), false);
    assert.match(text, /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex-reply is never given a config', () => {
  const dir = project();
  const home = codexHome(TOML);
  try {
    const { ui } = run(dir, home, { prompt: 'p', threadId: 't' }, 'mcp__codex__codex-reply');
    assert.equal(ui, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
