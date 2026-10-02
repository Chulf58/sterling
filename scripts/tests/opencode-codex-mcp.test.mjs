// The user-scope codex MCP entry Sterling writes for OpenCode 2 (board item
// parity-p4-codex-mcp-lanes-on-opencode-2-decision-7f83f57e-au; finding
// codex-mcp-server-runs-under-opencode-2-0-21-servers-shape-october-2026). The entry
// goes under mcp.servers.codex (the legacy mcp.codex with a timeout is dropped
// silently by 2.0.21) and is written only for a Codex whose `mcp-server --help`
// prints that subcommand's own help (anti_pattern codex-mcp-probe-by-exit-status).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureCodexServer, PINNED_CODEX_REL, opencodeConfigDir, setupOpenCode } from '../lib/opencode-install.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NODE_BIN = dirname(process.execPath);
const SPECIFIC_HELP = 'Start Codex as an MCP server (stdio)\n\nUsage: codex mcp-server [OPTIONS]\n';
const GENERIC_HELP = 'Codex CLI\n\nIf no subcommand is specified, options will be forwarded to the interactive CLI.\n\nUsage: codex [OPTIONS] [PROMPT]\n';

// A stub `codex` that prints `help` for `mcp-server --help` and fails anything else.
function stubCodex(path, help) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "mcp-server" ] && [ "$2" = "--help" ]; then\ncat <<'EOF'\n${help}EOF\nexit 0\nfi\nexit 2\n`);
  chmodSync(path, 0o755);
  return path;
}

const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const configPath = (env, home) => join(opencodeConfigDir({ env, home }), 'opencode.json');
const readConfig = (env, home) => JSON.parse(readFileSync(configPath(env, home), 'utf8'));
const ENV = (home, extra = {}) => ({ HOME: home, PATH: '/usr/bin:/bin', ...extra });

test('a pinned Codex with mcp-server help gets the measured mcp.servers.codex entry, idempotently', () => {
  const home = tmp('oc-codex-home-');
  const env = ENV(home);
  const pinned = stubCodex(join(home, PINNED_CODEX_REL), SPECIFIC_HELP);
  const row = ensureCodexServer({ env, home, nodeBinDir: NODE_BIN });
  assert.equal(row.status, 'created', JSON.stringify(row));
  const config = readConfig(env, home);
  assert.deepEqual(config.mcp.servers.codex, {
    type: 'local',
    command: [pinned, 'mcp-server'],
    environment: { PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin` },
    timeout: { startup: 30000, execution: 900000 },
  });
  assert.equal(config.mcp.codex, undefined, 'never the legacy mcp.codex shape');
  assert.equal(ensureCodexServer({ env, home, nodeBinDir: NODE_BIN }).status, 'matches');
});

test('the Codex already registered for Claude Code at user scope is preferred over the pinned path', () => {
  const home = tmp('oc-codex-home-');
  const env = ENV(home);
  stubCodex(join(home, PINNED_CODEX_REL), SPECIFIC_HELP);
  const claudeCodex = stubCodex(join(home, 'elsewhere', 'bin', 'codex'), SPECIFIC_HELP);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { codex: { type: 'stdio', command: claudeCodex, args: ['mcp-server'] } } }));
  assert.equal(ensureCodexServer({ env, home, nodeBinDir: NODE_BIN }).status, 'created');
  assert.deepEqual(readConfig(env, home).mcp.servers.codex.command, [claudeCodex, 'mcp-server']);
});

test('a Codex that prints only the generic help (0.154+, exit 0) is refused by the help check: loud skip, nothing written', () => {
  const home = tmp('oc-codex-home-');
  const bin = join(home, 'pathbin');
  stubCodex(join(bin, 'codex'), GENERIC_HELP);
  const env = ENV(home, { PATH: `${bin}:/usr/bin:/bin` });
  const row = ensureCodexServer({ env, home, nodeBinDir: NODE_BIN });
  assert.equal(row.status, 'skipped');
  assert.match(row.detail, /mcp-server/);
  assert.match(row.detail, /0\.153\.4/, 'names the pinned install route');
  assert.ok(row.detail.includes(join(bin, 'codex')), 'names what was tried');
  assert.equal(existsSync(configPath(env, home)), false);
});

test('no Codex anywhere: loud skip and no config file', () => {
  const home = tmp('oc-codex-home-');
  const env = ENV(home);
  const row = ensureCodexServer({ env, home, nodeBinDir: NODE_BIN });
  assert.equal(row.status, 'skipped');
  assert.match(row.detail, /no Codex/i);
  assert.equal(existsSync(configPath(env, home)), false);
});

test('an existing config keeps its other keys; a differing codex entry is kept, never overwritten', () => {
  const home = tmp('oc-codex-home-');
  const env = ENV(home);
  stubCodex(join(home, PINNED_CODEX_REL), SPECIFIC_HELP);
  mkdirSync(dirname(configPath(env, home)), { recursive: true });
  writeFileSync(configPath(env, home), JSON.stringify({ theme: 'x', mcp: { servers: { other: { type: 'local', command: ['o'] } } } }));
  assert.equal(ensureCodexServer({ env, home, nodeBinDir: NODE_BIN }).status, 'refreshed');
  const merged = readConfig(env, home);
  assert.equal(merged.theme, 'x');
  assert.deepEqual(merged.mcp.servers.other, { type: 'local', command: ['o'] });

  const mine = { type: 'local', command: ['/my/codex', 'mcp-server'] };
  writeFileSync(configPath(env, home), JSON.stringify({ mcp: { servers: { codex: mine } } }));
  const before = readFileSync(configPath(env, home), 'utf8');
  const row = ensureCodexServer({ env, home, nodeBinDir: NODE_BIN });
  assert.equal(row.status, 'skipped');
  assert.match(row.detail, /kept/);
  assert.equal(readFileSync(configPath(env, home), 'utf8'), before);
});

test('invalid JSON in the user config is refused and left byte-identical', () => {
  const home = tmp('oc-codex-home-');
  const env = ENV(home);
  stubCodex(join(home, PINNED_CODEX_REL), SPECIFIC_HELP);
  mkdirSync(dirname(configPath(env, home)), { recursive: true });
  writeFileSync(configPath(env, home), '{ not json');
  const row = ensureCodexServer({ env, home, nodeBinDir: NODE_BIN });
  assert.equal(row.status, 'refused');
  assert.equal(readFileSync(configPath(env, home), 'utf8'), '{ not json');
});

test('an unreadable ~/.claude.json is named in the skip line, never swallowed', () => {
  const home = tmp('oc-codex-home-');
  const env = ENV(home);
  writeFileSync(join(home, '.claude.json'), '{ broken');
  const row = ensureCodexServer({ env, home, nodeBinDir: NODE_BIN });
  assert.equal(row.status, 'skipped');
  assert.match(row.detail, /\.claude\.json not read/);
});

test('setupOpenCode writes the codex entry with the global files, and says so when it skips', () => {
  const home = tmp('oc-codex-home-');
  const dir = tmp('oc-codex-proj-');
  for (const args of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']]) {
    assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  }
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  const setup = () => setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: ENV(home), home, installed: false, probe: () => ({ installed: true, version: '2.0.21', major: 2 }) });
  const codexRow = (result) => result.rows.find((r) => r.item.endsWith('opencode.json mcp.servers.codex'));
  assert.equal(codexRow(setup()).status, 'skipped');
  stubCodex(join(home, PINNED_CODEX_REL), SPECIFIC_HELP);
  assert.equal(codexRow(setup()).status, 'created');
  assert.equal(readConfig(ENV(home), home).mcp.servers.codex.command[0], join(home, PINNED_CODEX_REL));
});
