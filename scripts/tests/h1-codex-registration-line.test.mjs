// H1 SessionStart — CODEX REGISTRATION LINE (decision codex-route-stays-the-pinned-0-153-4-mcp-server,
// GitHub issue #18). The pinned Codex 0.153.4 MCP server is the one supported Codex route, so a
// session whose user-level Claude config registers no `codex` server states that and names the
// install command. The line checks REGISTRATION only: it reads <CLAUDE_CONFIG_DIR or home>/.claude.json
// and never spawns codex (anti_pattern codex-mcp-probe-by-exit-status). A registered server means
// no line; a config that cannot be read is still one line, with the reason appended.
// Harness copied from scripts/tests/h1-pending-issue-reports-line.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-codex-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(BASE_CONFIG));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return dir;
}

// claudeJson: undefined = no file, string = the file's exact content.
function context(dir, claudeJson, extraEnv = {}) {
  const cfg = mkdtempSync(join(tmpdir(), 'sterling-h1-codex-cfg-'));
  if (claudeJson !== undefined) writeFileSync(join(cfg, '.claude.json'), claudeJson);
  const input = { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' };
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
      input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root, ...extraEnv },
    });
    assert.equal(r.status, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
}

const codexLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('Codex MCP:'));

test('H1: no user-level config file means exactly one Codex line, naming the pinned install and add commands', () => {
  const dir = project();
  try {
    const lines = codexLines(context(dir, undefined));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /no `codex` MCP server is registered at user scope/);
    assert.match(lines[0], /npm i -g --prefix ~\/\.local\/codex-mcp-0\.153\.4 @openai\/codex@0\.153\.4/);
    assert.match(lines[0], /claude mcp add --scope user -e PATH=\S+ codex -- ~\/\.local\/codex-mcp-0\.153\.4\/bin\/codex mcp-server/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1: a config with other servers but no codex gets the one line', () => {
  const dir = project();
  try {
    const lines = codexLines(context(dir, JSON.stringify({ mcpServers: { other: { command: 'x' } } })));
    assert.equal(lines.length, 1, lines.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1: a registered codex server at user scope gets no Codex line', () => {
  const dir = project();
  try {
    const ctx = context(dir, JSON.stringify({ mcpServers: { codex: { command: 'codex', args: ['mcp-server'] } } }));
    assert.deepEqual(codexLines(ctx), []);
    assert.ok(!/codex-mcp-0\.153\.4/.test(ctx), 'no remedy text leaks into the context when codex is registered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1: an unparseable user-level config is one line that says it could not be read, never silence and never "registered"', () => {
  const dir = project();
  try {
    const lines = codexLines(context(dir, '{ nope'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /could not be read/);
    assert.match(lines[0], /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1: the check reads registration only and never runs a codex binary', () => {
  const dir = project();
  const bin = mkdtempSync(join(tmpdir(), 'sterling-h1-codex-bin-'));
  const marker = join(bin, 'codex-ran');
  try {
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    chmodSync(join(bin, 'codex'), 0o755);
    const PATH = `${bin}:${process.env.PATH}`;
    assert.equal(codexLines(context(dir, undefined, { PATH })).length, 1);
    assert.equal(codexLines(context(dir, JSON.stringify({ mcpServers: { codex: {} } }), { PATH })).length, 0);
    assert.ok(!existsSync(marker), 'a codex on PATH must not be spawned at session start');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

// The Claude Code Codex bullet names the one supported route and says what to do when the tool
// is absent, in the repo's own CLAUDE.md and in the template that init and stamp-contract ship.
const claudeCodexBullet = (file) => {
  const text = readFileSync(join(root, file), 'utf8');
  const block = text.match(/<!-- claude-only -->\n((?:(?!<!-- \/claude-only -->)[\s\S])*?)<!-- \/claude-only -->/g)
    .find((b) => b.includes('- **Codex runs through the MCP tool, never the shell.**'));
  return block.split('\n').find((l) => l.startsWith('- **Codex runs through the MCP tool, never the shell.**'));
};

for (const file of ['CLAUDE.md', 'templates/target-claude-md.md']) {
  test(`${file}: the Claude Code Codex bullet names the pinned 0.153.4 MCP server as the one supported route and says to skip the lane when the tool is absent`, () => {
    const bullet = claudeCodexBullet(file);
    assert.match(bullet, /the pinned Codex 0\.153\.4 MCP server is the one supported route/);
    assert.match(bullet, /if the tool is absent, say so and skip the Codex lane/);
    assert.match(bullet, /Add that to all instruction files, that we use the codex mcp over whatever you were doing/, 'the verbatim user quote stays');
  });
}
