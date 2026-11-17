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

test('headers inside multiline strings and comments are not servers', () => {
  const dir = project();
  const toml = [
    'developer_instructions = """',
    '[mcp_servers.inbasic]',
    '"""',
    "other = '''",
    '[mcp_servers.inliteral]',
    "'''",
    'one = """one-line""" # [mcp_servers.x]',
    '# [mcp_servers.commented]',
    '  # [mcp_servers.commented2]',
    '[mcp_servers.real]',
    'command = "node"',
  ].join('\n');
  const home = codexHome(toml);
  try {
    const { ui } = run(dir, home, { prompt: 'p' });
    assert.deepEqual(ui.config.mcp_servers, { real: { enabled: false } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a triple quote in a comment or inside a one-line string does not hide a later server', () => {
  const dir = project();
  const toml = ['# Instructions may use """', "note = '\"\"\"'", 'x = "it\'\'\'s"', '[mcp_servers.real]', 'command = "node"'].join('\n');
  const home = codexHome(toml);
  try {
    const { ui } = run(dir, home, { prompt: 'p' });
    assert.deepEqual(ui.config.mcp_servers, { real: { enabled: false } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a config.toml that is not valid TOML is disclosed and injects no config', () => {
  const dir = project();
  const home = codexHome('a = """never closed\n[mcp_servers.real]\ncommand = "node"\n');
  try {
    const { ui, text } = run(dir, home, { prompt: 'p' });
    assert.equal(ui.model, 'gpt-5.6-sol');
    assert.equal(Object.hasOwn(ui, 'config'), false);
    assert.match(text, /could not be read/);
    assert.match(text, /not valid TOML/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// Each fixture is valid TOML; `names` is what tomllib reports as the keys of the
// root mcp_servers table. The cross-check below confirms that against Python.
const FIXTURES = {
  'triple quote in a comment': { toml: '# Instructions may use """\n[mcp_servers.real]\ncommand = "node"\n', names: ['real'] },
  'triple quote in a one-line literal': { toml: "note = '\"\"\"'\n[mcp_servers.real]\ncommand = \"node\"\n", names: ['real'] },
  'triple single quote in a one-line basic string': { toml: 'x = "it\'\'\'s"\n[mcp_servers.real]\n', names: ['real'] },
  'escaped quotes in basic strings': {
    toml: 'a = "\\" # not a comment [mcp_servers.fake]"\nb = "\\\\" # comment with """\nc = "\\"\\"\\""\n[mcp_servers.real]\n',
    names: ['real'],
  },
  'escaped triple quote inside a multiline basic string': { toml: 's = """a \\""" [mcp_servers.fake]\n"""\n[mcp_servers.real]\n', names: ['real'] },
  'multiline basic string ending in four and five quotes': {
    toml: 's = """\nends here""""\nt = """x"""""\n[mcp_servers.real]\nu = \'\'\'lit\'\'\'\'\'\n[mcp_servers.two]\n',
    names: ['real', 'two'],
  },
  'headers inside multiline strings and arrays': {
    toml: 'd = """\n[mcp_servers.inbasic]\n"""\no = \'\'\'\n[mcp_servers.inliteral]\n\'\'\'\nargs = [\n  "[mcp_servers.inarray]", # """ comment\n  \'x\',\n]\n[mcp_servers.real]\n',
    names: ['real'],
  },
  'quoted keys': {
    toml: '[mcp_servers."my server"]\ncommand = "a"\n[mcp_servers.\'lit.key\']\ncommand = "b"\n[ mcp_servers . "esc\\"aped" ]\ncommand = "c"\n[mcp_servers."\\u0041b"]\ncommand = "d"\n',
    names: ['my server', 'lit.key', 'esc"aped', 'Ab'],
  },
  'sub-tables map to the server': { toml: '[mcp_servers.x.env]\nA = "1"\n[mcp_servers.y]\ncommand = "a"\n[mcp_servers.y.env]\nB = "2"\n', names: ['x', 'y'] },
  'dotted keys at the root': { toml: 'mcp_servers.dot.command = "a"\nmcp_servers . "q d" . url = "u"\n[other]\n', names: ['dot', 'q d'] },
  'dotted and inline keys under [mcp_servers]': {
    toml: '[mcp_servers]\nunder.command = "b"\nunder2 = { command = "c" }\n[mcp_servers.t]\ncommand = "d"\n',
    names: ['under', 'under2', 't'],
  },
  'inline table at the root': {
    toml: 'mcp_servers = { inl = { command = "a", args = ["[x]", "}"] }, "q k" = { url = "u" }, d.command = "z" }\n',
    names: ['inl', 'q k', 'd'],
  },
  'mcp_servers under another table is not the root table': {
    toml: '[profiles.p]\nmcp_servers.y = { command = "a" }\n[profiles.p.mcp_servers.z]\ncommand = "b"\n',
    names: [],
  },
  'trailing comments, CRLF, dates and other values': {
    toml: 'd = 1979-05-27 07:32:00Z\r\nt = 07:32:00\r\nn = -1_000.5e+3\r\nb = true\r\narr = [ [1, 2], [ "a", { k = "v" } ] ]\r\n[mcp_servers.c] # a comment\r\ncommand = "a" # [mcp_servers.fake]\r\n',
    names: ['c'],
  },
  'array of tables under a server': { toml: '[[mcp_servers.arr]]\ncommand = "a"\n', names: ['arr'] },
  'no mcp_servers at all': { toml: 'model = "x"\n[other]\nk = 1\n', names: [] },
};

for (const [name, { toml, names }] of Object.entries(FIXTURES)) {
  test(`codexUserMcpServers: ${name}`, async () => {
    const { codexUserMcpServers } = await import('../hooks/lib/axis-compose.mjs');
    const home = codexHome(toml);
    try {
      const r = codexUserMcpServers({ CODEX_HOME: home });
      assert.equal(r.error, undefined);
      assert.deepEqual([...r.names].sort(), [...names].sort());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

const PY_CHECK = [
  'import json, sys, tomllib',
  'out = {}',
  'for p in sys.argv[1:]:',
  '    try:',
  '        with open(p, "rb") as f:',
  '            d = tomllib.load(f)',
  '    except Exception as e:',
  '        out[p] = "tomllib refused it: " + str(e)',
  '        continue',
  '    m = d.get("mcp_servers", {})',
  '    out[p] = sorted(m.keys()) if isinstance(m, dict) else None',
  'print(json.dumps(out))',
].join('\n');
const py = spawnSync('python3', ['-c', 'import tomllib'], { encoding: 'utf8' });
const pyMissing = py.error ? `python3 not found (${py.error.code})` : py.status !== 0 ? `python3 has no tomllib: ${py.stderr.trim().split('\n').pop()}` : null;

test(
  'the fixtures parse as TOML and their expected names match Python tomllib',
  pyMissing ? { skip: `cross-check not run: ${pyMissing}` } : {},
  () => {
    const home = mkdtempSync(join(tmpdir(), 'sterling-toml-xcheck-'));
    try {
      const files = Object.entries(FIXTURES).map(([name, { toml, names }], i) => {
        const p = join(home, `f${i}.toml`);
        writeFileSync(p, toml);
        return { p, name, names };
      });
      const r = spawnSync('python3', ['-c', PY_CHECK, ...files.map((f) => f.p)], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const got = JSON.parse(r.stdout);
      for (const f of files) assert.deepEqual(got[f.p], [...f.names].sort(), f.name);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
