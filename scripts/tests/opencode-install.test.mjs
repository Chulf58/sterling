// Sterling on OpenCode 2 setup (scripts/lib/opencode-install.mjs): global shims, the
// per-project untracked config, the exclude handling and the Sterling-full roster.
// Every test runs against a temp HOME and temp git projects, with OpenCode stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, copyFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  setupOpenCode, formatOpenCodeRows, opencodeConfigDir, mcpLauncherPath, STERLING_AGENTS_SUBDIR, CONDUCTOR_AGENT,
  swapFullAgentModel, opencodeModelRef, opencodeModelFor, writeFullAgentFiles, stageFullAgentModel, sterlingRootFrom, storeWriteTools, materializeTui,
} from '../lib/opencode-install.mjs';
import { renderPortableText } from '../lib/agent-fences.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OC2 = () => ({ installed: true, version: '2.0.21', major: 2 });

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// `handoff` (config.handoff.enabled) is left out of the config when undefined.
function project(mode, parent = tmpdir(), handoff) {
  const dir = mkdtempSync(join(parent, 'oc-proj-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode, ...(handoff === undefined ? {} : { handoff: { enabled: handoff } }) }));
  writeFileSync(join(dir, 'README.md'), 'x\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', 'README.md', '.gitignore']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

function run(dir, home, extra = {}) {
  return setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: false, probe: OC2, ...extra });
}

const fwdPath = (p) => p.replaceAll('\\', '/');
const statusOf = (result, suffix) => result.rows.find((r) => r.item.endsWith(suffix))?.status;
const untracked = (dir) => git(dir, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean);

test('OpenCode missing or 1.x: one loud skip line, nothing written', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const missing = setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: false, probe: () => ({ installed: false, reason: 'no `opencode` on PATH' }) });
  assert.match(formatOpenCodeRows(missing)[0], /^OpenCode: OpenCode not installed .*SKIPPED/);
  const old = setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: false, probe: () => ({ installed: true, version: '1.18.31', major: 1 }) });
  assert.match(formatOpenCodeRows(old)[0], /OpenCode 1\.18\.31 found, but Sterling on OpenCode needs 2\.x — SKIPPED/);
  assert.equal(existsSync(join(home, '.config')), false);
  assert.equal(existsSync(join(dir, '.opencode')), false);
});

test('STERLING_OPENCODE_SETUP_DISABLE=1 skips loudly without probing', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const r = setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home, STERLING_OPENCODE_SETUP_DISABLE: '1' }, home, installed: false, probe: () => assert.fail('probed') });
  assert.match(r.skipped, /STERLING_OPENCODE_SETUP_DISABLE=1/);
});

test('global install writes both shims and the MCP launcher, idempotently, honouring XDG_CONFIG_HOME', () => {
  const home = tmp('oc-home-');
  const xdg = tmp('oc-xdg-');
  const dir = project('hobby');
  const env = { HOME: home, XDG_CONFIG_HOME: xdg };
  const first = setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env, home, installed: false, probe: OC2 });
  const plugins = join(xdg, 'opencode', 'plugins');
  assert.equal(opencodeConfigDir({ env, home }), join(xdg, 'opencode'));
  for (const suffix of ['/sterling.js', '/sterling-tui/package.json', '/sterling-tui/tui.tsx', '/sterling-mcp.mjs']) assert.equal(statusOf(first, suffix), 'created', suffix);
  const pkg = JSON.parse(readFileSync(join(plugins, 'sterling-tui', 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./tui'], './tui.tsx');
  const shim = readFileSync(join(plugins, 'sterling.js'), 'utf8');
  assert.ok(shim.includes(JSON.stringify(repoRoot.replace(/\\/g, '/'))), 'authoring clone: the clone path is baked');
  const second = setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env, home, installed: false, probe: OC2 });
  // The codex row skips here (no Codex in the temp HOME); opencode-codex-mcp.test.mjs covers it.
  const codex = second.rows.filter((r) => r.item.endsWith('mcp.servers.codex'));
  assert.deepEqual(codex.map((r) => r.status), ['skipped']);
  assert.deepEqual([...new Set(second.rows.filter((r) => !codex.includes(r)).map((r) => r.status))], ['matches']);
});

test('installed copy: no versioned cache path is written; the shims resolve the newest at run time', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home, { installed: true });
  for (const f of [join(opencodeConfigDir({ env: {}, home }), 'plugins', 'sterling.js'), join(opencodeConfigDir({ env: {}, home }), 'plugins', 'sterling-tui', 'tui.tsx'), mcpLauncherPath({ home })]) {
    const text = readFileSync(f, 'utf8');
    assert.match(text, /newestInstalledSterling\(\)/);
    assert.equal(text.includes(repoRoot.replace(/\\/g, '/')), false, `${f} names the plugin root`);
    assert.equal(/plugins\/cache\/[^'"]*\/\d+\.\d+\.\d+/.test(text), false, `${f} names a versioned cache dir`);
  }
});

test('a same-named file Sterling did not write, or edited after, is refused and left byte-identical', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const plugins = join(opencodeConfigDir({ env: {}, home }), 'plugins');
  mkdirSync(join(plugins, 'sterling-tui'), { recursive: true });
  writeFileSync(join(plugins, 'sterling.js'), 'export default { id: "mine" };\n');
  writeFileSync(join(plugins, 'sterling-tui', 'package.json'), '{"name":"mine"}\n');
  const r = run(dir, home);
  assert.equal(statusOf(r, '/sterling.js'), 'refused');
  assert.equal(statusOf(r, '/sterling-tui/package.json'), 'refused');
  assert.equal(readFileSync(join(plugins, 'sterling.js'), 'utf8'), 'export default { id: "mine" };\n');
  assert.equal(readFileSync(join(plugins, 'sterling-tui', 'package.json'), 'utf8'), '{"name":"mine"}\n');
  assert.equal(existsSync(join(plugins, 'sterling-tui', 'tui.tsx')), false);
  assert.match(r.rows.find((x) => x.status === 'refused').instruction, /^REFUSED: .*Remedy: /);

  const home2 = tmp('oc-home-');
  run(dir, home2);
  const shim = join(opencodeConfigDir({ env: {}, home: home2 }), 'plugins', 'sterling.js');
  writeFileSync(shim, readFileSync(shim, 'utf8') + '// my tweak\n');
  assert.equal(statusOf(run(dir, home2), '/sterling.js'), 'refused');
});

test('project config: merged into an existing .opencode/opencode.json without clobbering other keys', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode'));
  const cfg = join(dir, '.opencode', 'opencode.json');
  writeFileSync(cfg, JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'] } }, permission: { bash: 'ask', edit: 'ask' }, default_agent: 'build' }));
  const r = run(dir, home);
  assert.equal(statusOf(r, 'opencode.json'), 'refreshed');
  const got = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(got.theme, 'dark');
  assert.deepEqual(got.mcp.other, { type: 'local', command: ['x'] });
  assert.equal(got.mcp.sterling, undefined, 'no per-project sterling MCP entry: the plugin injects it (decision sterling-opencode-plugin-injects-its-own-mcp-entry)');
  assert.equal(got.permission.bash, 'ask', 'a bash value is left as written: the config carries no shell guard');
  assert.deepEqual(got.permission.edit, { '*': 'ask', '**/.sterling/sterling.db*': 'deny', '.sterling/sterling.db*': 'deny' });
  assert.equal(got.default_agent, 'build', "the user's default_agent is kept");
  assert.match(r.rows.find((x) => x.item.endsWith('opencode.json')).detail, /default_agent kept as "build"/);
  assert.equal(statusOf(run(dir, home), 'opencode.json'), 'matches');
});

test('project config: a fresh file gets guard-only blocks (no "*" rule, so no verdict but the store changes) and the conductor as default_agent', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const got = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(got.permission, { edit: { '**/.sterling/sterling.db*': 'deny', '.sterling/sterling.db*': 'deny' } });
  assert.equal(got.default_agent, CONDUCTOR_AGENT);
});

// Until decision opencode-store-guard-allows-read-only-shell-commands-like-h15 (2026-10-03)
// three tests here pinned a shell deny on *sterling.db* written into shell, bash and "*"
// blocks. That deny refused reads too, so it is no longer written and an earlier one is
// removed; the server plugin's evaluate hook is the one shell guard.
test('project config: a fresh project gets no shell store pattern, idempotently', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const cfg = join(dir, '.opencode', 'opencode.json');
  const text = readFileSync(cfg, 'utf8');
  const got = JSON.parse(text);
  assert.equal(got.permission.shell, undefined);
  assert.equal(got.permission.bash, undefined);
  assert.ok(!text.includes('*sterling.db*'), 'no shell store pattern anywhere, the per-agent entries included');
  for (const [name, entry] of Object.entries(got.agent ?? {})) assert.deepEqual(Object.keys(entry.permission), ['edit'], name);
  assert.equal(statusOf(run(dir, home), 'opencode.json'), 'matches', 'idempotent');
  assert.equal(readFileSync(cfg, 'utf8'), text);
});

test('project config: the shell deny an earlier Sterling wrote is removed, and the user\'s own shell rules stay', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode'));
  const cfg = join(dir, '.opencode', 'opencode.json');
  const guardOnly = { permission: { edit: { '**/.sterling/sterling.db*': 'deny', '.sterling/sterling.db*': 'deny' }, shell: { '*sterling.db*': 'deny' }, bash: { '*sterling.db*': 'deny' } } };
  // As an earlier Sterling left it: its deny last in the user's shell block, guard-only bash, a "*" block with the path form, and per-agent entries.
  writeFileSync(cfg, JSON.stringify({
    permission: {
      '*': { '*': 'ask', '**/.sterling/sterling.db*': 'deny', '.sterling/sterling.db*': 'deny', '*.sterling/sterling.db*': 'deny' },
      shell: { '*': 'ask', 'git push*': 'deny', 'rm *sterling.db*': 'deny', '*sterling.db*': 'deny' },
      bash: { '*sterling.db*': 'deny' },
      edit: { '**/.sterling/sterling.db*': 'deny', '.sterling/sterling.db*': 'deny' },
    },
    agent: { gone: guardOnly, mine: { model: 'openai/x', permission: { ...guardOnly.permission, bash: { 'ls *': 'allow', '*sterling.db*': 'deny' } } } },
  }));
  const r = run(dir, home);
  assert.equal(statusOf(r, 'opencode.json'), 'refreshed');
  assert.match(r.rows.find((x) => x.item.endsWith('opencode.json')).detail, /removed the shell deny on \*sterling\.db\* an earlier init wrote/);
  const got = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.deepEqual(Object.entries(got.permission.shell), [['*', 'ask'], ['git push*', 'deny'], ['rm *sterling.db*', 'deny']], "the user's rules stay, one that denies something else about the store included");
  assert.equal(got.permission.bash, undefined, 'a bash block that held only the Sterling deny is dropped');
  assert.deepEqual(got.permission['*'], { '*': 'ask', '**/.sterling/sterling.db*': 'deny', '.sterling/sterling.db*': 'deny' }, 'the "*" block loses the shell path pattern and keeps the edit guard');
  assert.deepEqual(got.permission.edit, guardOnly.permission.edit, 'the edit deny is still written');
  assert.equal(got.agent.gone, undefined, 'an old guard-only entry for an agent that is gone is still recognised and dropped');
  assert.deepEqual(got.agent.mine, { model: 'openai/x', permission: { edit: guardOnly.permission.edit, bash: { 'ls *': 'allow' } } });
  const second = run(dir, home);
  assert.equal(statusOf(second, 'opencode.json'), 'matches', 'idempotent on a second run');
  assert.doesNotMatch(second.rows.find((x) => x.item.endsWith('opencode.json')).detail, /removed the shell deny/);
});

test('project config: a user shell rule on *sterling.db* with another effect, a string shell value and an empty block are left as written; a malformed one is refused', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode'));
  const cfg = join(dir, '.opencode', 'opencode.json');
  const shellAfter = (permission) => {
    writeFileSync(cfg, JSON.stringify({ permission }));
    run(dir, home);
    return JSON.parse(readFileSync(cfg, 'utf8')).permission;
  };
  assert.deepEqual(shellAfter({ shell: { '*': 'ask', '*sterling.db*': 'allow' } }).shell, { '*': 'ask', '*sterling.db*': 'allow' });
  assert.deepEqual(shellAfter({ bash: { '*sterling.db*': 'ask' } }).bash, { '*sterling.db*': 'ask' });
  let got = shellAfter({ bash: 'ask' });
  assert.equal(got.bash, 'ask');
  assert.equal(got.shell, undefined, 'no shell block is added');
  got = shellAfter({ bash: { '*': 'deny', 'ls*': 'allow' }, shell: {} });
  assert.deepEqual(got.bash, { '*': 'deny', 'ls*': 'allow' });
  assert.deepEqual(got.shell, {}, 'an empty block the user wrote stays');
  for (const bad of [{ shell: ['x'] }, { bash: 7 }]) {
    writeFileSync(cfg, JSON.stringify({ permission: bad }));
    assert.equal(statusOf(run(dir, home), 'opencode.json'), 'refused', JSON.stringify(bad));
  }
});

// OpenCode 2.0.22 flattens the permission object into one rule list in key order,
// mapping bash to shell and write and patch to edit, and the last matching rule wins
// (measured with `opencode debug config` and `opencode debug agents`, finding
// opencode-only-machine-live-acceptance-p7-october-2026). This is that evaluation; glob
// is the 2.0.22 binary's matcher: * is any run of characters (slashes included), ? is
// one character, a trailing " *" also matches the bare command, backslashes are slashes.
// A shell command reaches it split into its simple commands (`cd .sterling && sqlite3
// sterling.db` is checked as `cd .sterling` and `sqlite3 sterling.db`); read and edit
// get the path relative to the session directory, or absolute outside the project.
const STORE_PATHS = ['.sterling/sterling.db', '.sterling/sterling.db-wal', '.sterling/sterling.db-shm', '.sterling/sterling.db-journal', 'sub/.sterling/sterling.db-wal', '../.sterling/sterling.db', '/home/u/p/.sterling/sterling.db-shm', 'C:\\p\\.sterling\\sterling.db'];
const ACTION_ALIAS = { bash: 'shell', write: 'edit', patch: 'edit' };
function effectOf(permission, action, resource) {
  const glob = (p) => {
    let re = p.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    if (re.endsWith(' .*')) re = `${re.slice(0, -3)}( .*)?`;
    return { test: (r) => new RegExp(`^${re}$`, 's').test(r.replaceAll('\\', '/')) };
  };
  let effect;
  for (const [key, value] of Object.entries(permission)) {
    const act = ACTION_ALIAS[key] ?? key;
    if (act !== action && act !== '*') continue;
    const rules = typeof value === 'string' ? { '*': value } : value;
    for (const [pattern, e] of Object.entries(rules)) if (glob(pattern).test(resource)) effect = e;
  }
  return effect;
}

test('project config: the edit guard holds in every block layout, and every shell verdict is the user\'s own (bash maps to shell, last match wins)', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode'));
  const cfg = join(dir, '.opencode', 'opencode.json');
  const after = (permission) => {
    writeFileSync(cfg, JSON.stringify({ permission }));
    run(dir, home);
    return JSON.parse(readFileSync(cfg, 'utf8')).permission;
  };
  const cases = [
    // The measured P7 failure: the bash block allowed *sterling.db* and came after shell.
    { shell: { '*': 'allow', '*sterling.db*': 'deny' }, bash: { '*': 'allow', '*sterling.db*': 'allow' } },
    { bash: { '*': 'allow' } },
    { bash: 'allow' },
    { bash: { '*': 'ask', 'ls *': 'allow' } },
    { '*': 'allow' },
    { edit: 'allow', write: { '*': 'allow', '*sterling.db*': 'allow' }, patch: 'allow' },
    {},
    // The review cases: a reorder changed these users' verdicts.
    { write: { '*': 'allow' }, edit: { '*': 'deny' } },
    { edit: 'allow', '*': 'ask' },
    { bash: 'allow', '*': 'ask' },
    { bash: { '*': 'deny' }, shell: { 'git *': 'allow' } },
    { shell: { '*': 'allow' }, bash: { 'rm *': 'deny' } },
    // A "*" key after every family block: its rules apply to edit and shell too.
    { edit: { '*': 'allow' }, shell: { '*': 'allow' }, bash: { '*': 'allow' }, '*': { '*': 'allow', '*sterling.db*': 'allow' } },
  ];
  // Every verdict that is not about the store is the user's own, before and after.
  const probes = [['edit', 'src/a.ts'], ['edit', 'docs/x.md'], ['shell', 'ls'], ['shell', 'git status'], ['shell', 'rm x'], ['shell', 'npm test'], ['read', 'src/a.ts']];
  for (const c of cases) {
    const got = after(c);
    const label = JSON.stringify(c);
    // No shell rule comes from this config (decision opencode-store-guard-allows-read-only-shell-commands-like-h15). A user "*" block is the exception: its store path patterns also match a shell command that names the store behind a directory prefix.
    if (!('*' in c)) {
      for (const cmd of ['ls -la .sterling/sterling.db', 'sqlite3 -readonly .sterling/sterling.db .tables', 'cat .sterling/sterling.db-wal', 'sqlite3 sterling.db', 'cat /p/.sterling/sterling.db-shm']) {
        assert.equal(effectOf(got, 'shell', cmd), effectOf(c, 'shell', cmd), `${label}: ${cmd} keeps the user's verdict`);
      }
    }
    for (const path of STORE_PATHS) for (const action of ['edit', ...('*' in c ? ['read'] : [])]) assert.equal(effectOf(got, action, path), 'deny', `${label}: ${action} ${path}`);
    for (const [action, resource] of probes) assert.equal(effectOf(got, action, resource), effectOf(c, action, resource), `${label}: ${action} ${resource} keeps the user's verdict`);
    for (const key of ['shell', 'bash', '*']) assert.notEqual(got[key]?.['*sterling.db*'], 'deny', `${label}: ${key} holds no Sterling shell deny`);
    assert.deepEqual(Object.keys(got).slice(0, Object.keys(c).length), Object.keys(c), `${label}: the user's keys keep their order`);
    assert.equal(statusOf(run(dir, home), 'opencode.json'), 'matches', `${label}: idempotent`);
  }
  // The user's own verdicts for other commands and paths are kept.
  let got = after({ bash: { '*': 'ask', 'ls *': 'allow', 'npm publish*': 'deny' } });
  assert.equal(effectOf(got, 'shell', 'ls src'), 'allow', 'a user bash allow still applies');
  assert.equal(effectOf(got, 'shell', 'npm publish --tag x'), 'deny', 'a user bash deny still applies');
  assert.equal(effectOf(got, 'shell', 'rm x'), 'ask', 'the user bash "*" still applies');
  got = after({ shell: { '*': 'ask', 'npm publish*': 'deny' } });
  assert.equal(effectOf(got, 'shell', 'npm publish --tag x'), 'deny', 'a user shell rule is not overridden by the bash guard block');
  assert.equal(got.bash, undefined, 'with no user bash block, none is added');
  got = after({ edit: { '*': 'ask' }, write: { 'docs/*': 'allow' } });
  assert.equal(effectOf(got, 'edit', 'docs/a.md'), 'allow', 'a user write rule still applies');
  assert.deepEqual(Object.entries(got.write).at(-1), ['.sterling/sterling.db*', 'deny'], 'a user write block ends with the edit guard');
});

test('project config: the guard in a user "*" block denies the store by path, so other names keep the user\'s verdict for every tool', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode'));
  const cfg = join(dir, '.opencode', 'opencode.json');
  const after = (permission) => {
    writeFileSync(cfg, JSON.stringify({ permission }));
    run(dir, home);
    return JSON.parse(readFileSync(cfg, 'utf8')).permission;
  };
  const others = [['read', 'docs/sterling.db-layout.md'], ['edit', 'docs/sterling.db-layout.md'], ['grep', 'sterling.db'], ['webfetch', 'https://example.com/sterling.db-layout'], ['read', '.sterling/config.json']];
  for (const c of [{ '*': 'allow' }, { '*': { '*': 'allow', '*sterling.db*': 'allow' } }, { edit: 'allow', '*': 'ask' }, { shell: 'allow', '*': 'allow' }, { '*': 'allow', shell: 'allow', bash: 'allow' }]) {
    const got = after(c);
    const label = JSON.stringify(c);
    for (const [action, resource] of others) assert.equal(effectOf(got, action, resource), effectOf(c, action, resource), `${label}: ${action} ${resource} keeps the user's verdict`);
    for (const path of STORE_PATHS) for (const action of ['read', 'edit']) assert.equal(effectOf(got, action, path), 'deny', `${label}: ${action} ${path}`);
    for (const cmd of ['sqlite3 sterling.db', 'cat .sterling/sterling.db-journal']) assert.equal(effectOf(got, 'shell', cmd), effectOf(c, 'shell', cmd), `${label}: shell ${cmd} keeps the user's verdict`);
  }
  // shell and bash both before "*": this layout used to keep the broad *sterling.db* shell
  // pattern in "*", which also denied reading files that only share the name. It is gone (decision opencode-store-guard-allows-read-only-shell-commands-like-h15).
  const got = after({ shell: 'allow', bash: 'allow', '*': 'allow' });
  assert.equal(effectOf(got, 'shell', 'sqlite3 sterling.db'), 'allow');
  assert.equal(effectOf(got, 'read', 'docs/sterling.db-layout.md'), 'allow', 'no over-block in this layout any more');
});

// An agent's own rules come after the top-level block, and the project config's
// agent.<name>.permission comes after the agent file's rules (measured on 2.0.22 with
// `opencode debug agents`, and live: `ls -la .sterling/sterling.db` ran as a user agent
// whose file allows bash under a top-level-only guard, and was denied once the
// per-agent guard was written).
function agentEffect(config, name, fileRules, action, resource) {
  const layers = [config.permission, fileRules, config.agent?.[name]?.permission].filter(Boolean);
  let effect;
  for (const layer of layers) effect = effectOf(layer, action, resource) ?? effect;
  return effect;
}

test('project config: every agent OpenCode can see gets a per-agent store guard, placed last, keeping the user\'s per-agent rules', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const globalDir = join(home, '.config', 'opencode');
  mkdirSync(join(globalDir, 'agents', 'team'), { recursive: true });
  writeFileSync(join(globalDir, 'agents', 'helper.md'), '---\ndescription: h\nmode: primary\npermission:\n  bash:\n    "*": allow\n---\n\nbody\n');
  writeFileSync(join(globalDir, 'agents', 'team', 'lead.md'), '---\ndescription: l\nmode: subagent\n---\n\nbody\n');
  writeFileSync(join(globalDir, 'opencode.jsonc'), '{\n  // my agents\n  "agent": { "planner2": { "permission": { "bash": "allow" } }, },\n}\n');
  mkdirSync(join(dir, '.opencode'));
  const cfg = join(dir, '.opencode', 'opencode.json');
  writeFileSync(cfg, JSON.stringify({ agent: { mine: { model: 'openai/x', permission: { bash: { '*': 'allow', 'ls *': 'allow' }, webfetch: 'deny' } } } }));
  const r = run(dir, home);
  const got = JSON.parse(readFileSync(cfg, 'utf8'));
  const names = Object.keys(got.agent).sort();
  for (const want of ['helper', 'team/lead', 'planner2', 'mine', CONDUCTOR_AGENT, 'sterling/implementor', 'sterling/scout']) assert.ok(names.includes(want), `${want} is guarded (got ${names.join(', ')})`);
  for (const name of names) {
    const perm = got.agent[name].permission;
    assert.deepEqual(Object.entries(perm.edit).at(-1), ['.sterling/sterling.db*', 'deny'], name);
    assert.equal(perm.edit['*'], undefined, `${name}: no "*" rule is added at agent level, so the agent's own verdicts stand`);
    assert.equal(perm.shell, undefined, `${name}: no shell block is added (decision opencode-store-guard-allows-read-only-shell-commands-like-h15)`);
    assert.notEqual(perm.bash?.['*sterling.db*'], 'deny', name);
  }
  // The P7 shape: an agent file that allows bash after the top-level guard.
  const fileAllow = { bash: { '*': 'allow' } };
  assert.equal(agentEffect(got, 'helper', fileAllow, 'shell', 'ls -la .sterling/sterling.db'), 'allow', 'a shell read of the store is the agent\'s own verdict; the plugin evaluate hook guards the write shapes');
  assert.equal(agentEffect(got, 'helper', fileAllow, 'shell', 'ls src'), 'allow', "the agent's own allow still applies to other commands");
  assert.equal(agentEffect(got, 'helper', { edit: 'allow' }, 'edit', '.sterling/sterling.db'), 'deny');
  // The user's own per-agent entry keeps its keys and rules, the guard after them.
  assert.equal(got.agent.mine.model, 'openai/x');
  assert.equal(got.agent.mine.permission.webfetch, 'deny');
  assert.deepEqual(Object.entries(got.agent.mine.permission.bash), [['*', 'allow'], ['ls *', 'allow']]);
  assert.match(r.rows.find((x) => x.item.endsWith('opencode.json')).detail, /per-agent store guard on \d+ agents.*an agent added later is covered on the next \/sterling:update/);
  assert.equal(statusOf(run(dir, home), 'opencode.json'), 'matches', 'idempotent');
  // An agent that is gone loses its guard-only entry; a user entry stays.
  rmSync(join(globalDir, 'agents', 'helper.md'));
  run(dir, home);
  const after = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(after.agent.helper, undefined, "the guard-only entry Sterling wrote for a removed agent is dropped");
  assert.ok(after.agent.mine, 'a user entry is kept');
});

test('project config: an unreadable global opencode.jsonc is reported, the visible agents are still guarded, and earlier guard entries are kept', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const globalDir = join(home, '.config', 'opencode');
  mkdirSync(join(globalDir, 'agents'), { recursive: true });
  writeFileSync(join(globalDir, 'agents', 'helper.md'), '---\ndescription: h\n---\n\nbody\n');
  writeFileSync(join(globalDir, 'opencode.jsonc'), '{ "agent": { "planner2": {} } }');
  run(dir, home);
  const cfg = join(dir, '.opencode', 'opencode.json');
  assert.ok(JSON.parse(readFileSync(cfg, 'utf8')).agent.planner2, 'guarded while the config reads');
  writeFileSync(join(globalDir, 'opencode.jsonc'), '{ "agent": { oops } }');
  const r = run(dir, home);
  const got = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.ok(got.agent.helper, 'the agent file is still guarded');
  assert.ok(got.agent.planner2, "the guard entry for the unreadable config's agent is kept, not dropped");
  const row = r.rows.find((x) => x.item.endsWith('opencode.jsonc'));
  assert.equal(row?.status, 'skipped');
  assert.match(row.detail, /not valid JSONC.*NOT checked.*earlier per-agent guard entries are kept/);
});

test('project config: the per-agent guard reads every agent source OpenCode 2.0.22 loads, and names a source whose rules can come after it', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const md = '---\ndescription: d\nmode: subagent\n---\n\nbody\n';
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put('.opencode/agent/singular.md', md);
  put('.opencode/modes/m1.md', md);
  put('.opencode/modes/nested/not-a-mode.md', md);
  put('agents/rootdir.md', md);
  put('opencode.json', JSON.stringify({ agent: { rootjson: { description: 'd' } } }));
  put('opencode.jsonc', '// c\n{ "agent": { "rootjsonc": { "description": "d" } } }');
  put('.opencode/opencode.jsonc', '{ "agent": { "dotjsonc": { "permission": { "bash": "allow" } } } }');
  const envDir = tmp('oc-envdir-');
  mkdirSync(join(envDir, 'agents'));
  writeFileSync(join(envDir, 'agents', 'fromenvdir.md'), md);
  const envFile = join(tmp('oc-envfile-'), 'cfg.json');
  writeFileSync(envFile, JSON.stringify({ agent: { fromenvfile: { description: 'd' } } }));
  mkdirSync(join(home, '.config', 'opencode', 'agents'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'agents', 'replaced.md'), md);
  const r = run(dir, home, { env: { HOME: home, OPENCODE_CONFIG_DIR: envDir, OPENCODE_CONFIG: envFile, OPENCODE_CONFIG_CONTENT: '{"agent":{"fromcontent":{}}}' } });
  const names = Object.keys(JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')).agent);
  for (const want of ['singular', 'm1', 'rootjson', 'rootjsonc', 'dotjsonc', 'fromenvdir', 'fromenvfile', 'fromcontent']) assert.ok(names.includes(want), `${want} is guarded (got ${names.join(', ')})`);
  for (const not of ['rootdir', 'nested/not-a-mode', 'replaced']) assert.ok(!names.includes(not), `${not}: OpenCode does not load it, and an entry would create the agent`);
  const late = r.rows.find((x) => x.item.endsWith('.opencode/opencode.jsonc'));
  assert.equal(late?.status, 'skipped');
  assert.match(late.detail, /read after .*can override the store guard/);
  const main = r.rows.find((x) => x.item === '.opencode/opencode.json');
  assert.match(main.detail, /seen only through this run's OPENCODE_CONFIG_DIR, OPENCODE_CONFIG or OPENCODE_CONFIG_CONTENT: fromcontent, fromenvdir, fromenvfile;/, 'the env-only guard entries are named in the row');
  assert.doesNotMatch(main.detail.match(/seen only through[^;]*/)[0], /singular|rootjson/, 'agents from files OpenCode always reads are not named');
  run(dir, home);
  const rerun = Object.keys(JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')).agent);
  for (const gone of ['fromenvdir', 'fromenvfile', 'fromcontent']) assert.ok(!rerun.includes(gone), `${gone}: a rerun without the environment drops its guard-only entry`);
});

test('project config: agents in an ancestor directory\'s .opencode and opencode.json get the per-agent guard (2.0.22 reads every ancestor up to /)', () => {
  const home = tmp('oc-home-');
  const parent = tmp('oc-anc-');
  const dir = project('hobby', parent);
  mkdirSync(join(parent, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(parent, '.opencode', 'agents', 'ancfile.md'), '---\ndescription: d\nmode: subagent\n---\n\nbody\n');
  writeFileSync(join(parent, '.opencode', 'opencode.json'), JSON.stringify({ agent: { ancdot: { permission: { bash: 'allow' } } } }));
  writeFileSync(join(parent, 'opencode.jsonc'), '{ "agent": { "ancroot": {} } }');
  const r = run(dir, home);
  const agents = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')).agent;
  for (const want of ['ancfile', 'ancdot', 'ancroot']) assert.ok(agents[want], `${want} is guarded (got ${Object.keys(agents).join(', ')})`);
  assert.ok(!r.rows.some((x) => x.item.startsWith(parent.replaceAll('\\', '/')) && x.status === 'skipped'), 'ancestor sources are read before the project config, so their rules raise no row');
});

test('project config: an ancestor source that cannot be read is a skipped row and keeps earlier guard entries, never a crash', () => {
  const home = tmp('oc-home-');
  const parent = tmp('oc-anc-');
  const dir = project('hobby', parent);
  mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.opencode', 'agents', 'mine.md'), '---\ndescription: d\n---\n\nbody\n');
  writeFileSync(join(parent, 'opencode.jsonc'), '{ "agent": { "ancold": {} } }');
  run(dir, home);
  rmSync(join(parent, 'opencode.jsonc'));
  mkdirSync(join(parent, 'opencode.json'));
  mkdirSync(join(parent, 'opencode.jsonc'));
  const r = run(dir, home);
  const rows = r.rows.filter((x) => x.item.startsWith(fwdPath(parent)) && x.status === 'skipped');
  assert.deepEqual(rows.map((x) => x.item).sort(), [`${fwdPath(parent)}/opencode.json`, `${fwdPath(parent)}/opencode.jsonc`]);
  assert.match(rows[0].detail, /cannot be read \(EISDIR\).*NOT checked.*earlier per-agent guard entries are kept/);
  const agents = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')).agent;
  assert.ok(agents.mine && agents.ancold, 'the guard entries stay while a source is unreadable');
});

test('project config: symlinked agent files and directories count as agents, and a symlink loop ends', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const elsewhere = tmp('oc-agents-src-');
  const md = '---\ndescription: d\n---\n\nbody\n';
  writeFileSync(join(elsewhere, 'linkedfile.md'), md);
  mkdirSync(join(elsewhere, 'team'));
  writeFileSync(join(elsewhere, 'team', 'member.md'), md);
  const agentsDir = join(dir, '.opencode', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  symlinkSync(join(elsewhere, 'linkedfile.md'), join(agentsDir, 'linkedfile.md'));
  symlinkSync(join(elsewhere, 'team'), join(agentsDir, 'team'));
  symlinkSync(agentsDir, join(agentsDir, 'team', 'loop'));
  symlinkSync(join(elsewhere, 'missing.md'), join(agentsDir, 'dangling.md'));
  run(dir, home);
  const names = Object.keys(JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')).agent);
  for (const want of ['linkedfile', 'team/member']) assert.ok(names.includes(want), `${want} is guarded (got ${names.join(', ')})`);
  assert.ok(!names.includes('dangling'), 'a dangling link is not an agent');
  assert.ok(!names.some((n) => n.includes('loop/')), 'the loop is walked once');
});

/** Project agent files whose own rules allow edit or shell, in both forms, plus a global one. */
function looseAgentsProject() {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put('.opencode/agents/loose.md', '---\ndescription: d\nmode: primary\npermission:\n  bash:\n    "*": allow\n---\n\nbody\n');
  put('.opencode/agents/star.md', '---\ndescription: d\npermission:\n  "*": ask\n---\n\nbody\n');
  put('.opencode/agents/scalar.md', '---\ndescription: d\npermission: allow\n---\n\nbody\n');
  put('.opencode/agents/denies.md', '---\ndescription: d\npermission:\n  edit: deny\n  bash: deny\n  webfetch: allow\n  sterling_board_add: deny\n---\n\nbody\n');
  put('.opencode/agents/plain.md', '---\ndescription: d\n---\n\npermission: allow in the body is not frontmatter\n');
  put('.opencode/agents/toolsform.md', '---\ndescription: d\nmode: primary\ntools:\n  bash: true\n---\n\nbody\n');
  mkdirSync(join(home, '.config', 'opencode', 'agents'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'agents', 'globalloose.md'), '---\ndescription: d\npermission:\n  bash: allow\n---\n\nbody\n');
  return { dir, home };
}
const agentRows = (r) => r.rows.filter((x) => x.status === 'skipped' && /\.opencode\/agents\//.test(x.item));

test('project config below OpenCode 2.0.22: a project agent file whose rules can allow edit gets a row, because its rules come after the per-agent guard and there is no evaluate hook', () => {
  const { dir, home } = looseAgentsProject();
  const r = run(dir, home, { probe: () => ({ installed: true, version: '2.0.21', major: 2 }) });
  const flagged = agentRows(r).filter((x) => /store guard does NOT hold/.test(x.detail)).map((x) => x.item.split('/').pop()).sort();
  // loose.md (bash allow only) was flagged while the config carried a shell deny; a bash rule overrides no config guard now (decision opencode-store-guard-allows-read-only-shell-commands-like-h15).
  assert.deepEqual(flagged, ['scalar.md', 'star.md'], 'only project agent files that can allow edit; a global agent file comes before the guard');
  assert.match(r.rows.find((x) => x.item.endsWith('star.md')).detail, /needs 2\.0\.22 or later.*move its .* rules into agent\."star"\.permission in \.opencode\/opencode\.json/);
});

// From 2.0.22 the server plugin's evaluate hook (packages/opencode-plugin/src/store-guard.mjs)
// denies the store after every agent rule, measured live for the permission and tools: forms.
test('project config on OpenCode 2.0.22 and later: no row for such agent files, and each keeps its config guard entry', () => {
  for (const version of ['2.0.22', '2.1.0', '3.0.0']) {
    const { dir, home } = looseAgentsProject();
    const r = run(dir, home, { probe: () => ({ installed: true, version, major: Number(version[0]) }) });
    assert.deepEqual(agentRows(r), [], `no skipped row names a project agent file on ${version}`);
    const agents = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')).agent;
    for (const name of ['loose', 'star', 'scalar', 'denies', 'plain', 'toolsform', 'globalloose']) {
      assert.deepEqual(agents[name]?.permission, { edit: { '**/.sterling/sterling.db*': 'deny', '.sterling/sterling.db*': 'deny' } }, `${name} keeps its config guard entry on ${version}`);
    }
  }
});

test('hasEvaluateHook: 2.0.22 and later only; an unreadable version counts as without', async () => {
  const { hasEvaluateHook } = await import('../lib/opencode-install.mjs');
  for (const v of ['2.0.22', '2.0.23', '2.1.0', '10.0.0']) assert.equal(hasEvaluateHook(v), true, v);
  for (const v of ['2.0.21', '2.0.3', '1.18.31', undefined, '', 'v?']) assert.equal(hasEvaluateHook(v), false, String(v));
});

test('parseJsonc: comments and trailing commas go only outside strings', async () => {
  const { parseJsonc } = await import('../lib/opencode-install.mjs');
  assert.deepEqual(parseJsonc('{"a": "x,}", "b": "// not", "c": "/* no */", "d": [1, 2, /* c */ ], // t\n}'), { a: 'x,}', b: '// not', c: '/* no */', d: [1, 2] });
  assert.throws(() => parseJsonc('{ oops }'));
});

test('project config: invalid JSON or a tracked opencode.json is refused and not touched', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode'));
  writeFileSync(join(dir, '.opencode', 'opencode.json'), '{ nope');
  assert.equal(statusOf(run(dir, home), 'opencode.json'), 'refused');
  assert.equal(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8'), '{ nope');

  const dir2 = project('work');
  mkdirSync(join(dir2, '.opencode'));
  writeFileSync(join(dir2, '.opencode', 'opencode.json'), '{}\n');
  git(dir2, ['add', '.opencode/opencode.json']);
  git(dir2, ['commit', '-qm', 'cfg']);
  const r = run(dir2, home);
  assert.equal(statusOf(r, 'opencode.json'), 'refused');
  assert.match(r.rows.find((x) => x.item.endsWith('opencode.json')).instruction, /git rm --cached \.opencode\/opencode\.json/);
  assert.equal(readFileSync(join(dir2, '.opencode', 'opencode.json'), 'utf8'), '{}\n');
});

// CHANGED (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting): the
// exclude block followed the mode (hobby: whole directory; work: narrow). It
// follows config.handoff.enabled now, so the fixtures below state the key, and
// the work-mode project with handoff off shows the mode no longer narrows it.
for (const mode of ['hobby', 'work']) {
  test(`${mode} project with handoff off: the whole .opencode/ is excluded, whatever the mode`, () => {
    const home = tmp('oc-home-');
    const dir = project(mode, tmpdir(), false);
    const r = run(dir, home);
    assert.equal(statusOf(r, '.git/info/exclude'), 'created');
    assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.opencode\/$/m);
    assert.deepEqual(untracked(dir), [], 'nothing Sterling wrote shows up in git status');
  });
}

test('an unreadable handoff setting: a skipped row says so and only Sterling paths are excluded', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby', handoff: { enabled: 'yes' } }));
  const r = run(dir, home);
  const row = r.rows.find((x) => x.item === '.sterling/config.json handoff');
  assert.equal(row?.status, 'skipped');
  assert.match(row.detail, /config\.handoff\.enabled is "yes".*excluding only Sterling's own \.opencode paths/);
  assert.doesNotMatch(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.opencode\/$/m);
});

test('handoff-off project: the whole .opencode/ is excluded through .git/info/exclude; .gitignore is never written', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const r = run(dir, home);
  assert.equal(statusOf(r, '.git/info/exclude'), 'created');
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/\.opencode\/$/m);
  assert.deepEqual(untracked(dir), [], 'nothing Sterling wrote shows up in git status');
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '.sterling/\n', 'the committed .gitignore is unchanged');
  assert.equal(statusOf(run(dir, home), '.git/info/exclude'), 'matches');
  assert.equal(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), exclude);
});

test('a project that already ignores .opencode/ gets no exclude block', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n.opencode/\n');
  git(dir, ['add', '.gitignore']);
  git(dir, ['commit', '-qm', 'ignore']);
  const r = run(dir, home);
  assert.equal(statusOf(r, '.git/info/exclude'), 'matches');
  assert.doesNotMatch(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /sterling opencode/);
});

test('no handoff key and UNTRACKED portable agents on disk: the block stays narrow, so git status still shows them', () => {
  const home = tmp('oc-home-');
  const dir = project('work');
  mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.opencode', 'agents', 'scout.md'), 'portable\n');
  run(dir, home);
  assert.doesNotMatch(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.opencode\/$/m);
  assert.deepEqual(untracked(dir), ['?? .opencode/agents/scout.md'], 'the file Sterling stopped maintaining is not hidden');
});

test('no handoff key and git cannot say what is tracked: a skipped row names the git error and only Sterling paths are excluded', () => {
  const home = tmp('oc-home-');
  const dir = project('work');
  writeFileSync(join(dir, '.git', 'index'), 'not an index');
  const r = run(dir, home);
  const row = r.rows.find((x) => x.item === '.sterling/config.json handoff');
  assert.equal(row?.status, 'skipped');
  assert.match(row.detail, /git ls-files exited 128.*excluding only Sterling's own \.opencode paths/);
  assert.doesNotMatch(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.opencode\/$/m);
});

test('project with COMMITTED portable agents and no handoff key: only Sterling paths are excluded, the committed copies are untouched', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
  const portable = '---\ndescription: portable\nmode: subagent\n---\nportable body\n';
  for (const n of ['implementor', 'researcher', 'scout']) writeFileSync(join(dir, '.opencode', 'agents', `${n}.md`), portable);
  git(dir, ['add', '.opencode']);
  git(dir, ['commit', '-qm', 'portable']);
  const r = run(dir, home);
  assert.deepEqual(r.rows.filter((x) => x.refused), []);
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/\.opencode\/opencode\.json$/m);
  assert.match(exclude, /^\/\.opencode\/agents\/sterling\/$/m);
  assert.doesNotMatch(exclude, /^\/\.opencode\/$/m);
  for (const n of ['implementor', 'researcher', 'scout']) assert.equal(readFileSync(join(dir, '.opencode', 'agents', `${n}.md`), 'utf8'), portable);
  assert.deepEqual(untracked(dir), []);
  assert.equal(git(dir, ['ls-files', '.opencode']).trim().split('\n').length, 3, 'the committed copies stay tracked');
  // a new portable agent written later is still visible to git (not hidden by the exclude)
  writeFileSync(join(dir, '.opencode', 'agents', 'new.md'), portable);
  assert.deepEqual(untracked(dir), ['?? .opencode/agents/new.md']);
});

test('handoff just turned on (portable copies not yet committed): never hides them; the off→on switch rewrites the block, a hobby→work switch alone does not', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.opencode\/$/m);
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'work' }));
  assert.equal(statusOf(run(dir, home), '.git/info/exclude'), 'matches', 'switching the mode leaves the block alone');
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.opencode\/$/m);
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby', handoff: { enabled: true } }));
  const r = run(dir, home);
  assert.equal(statusOf(r, '.git/info/exclude'), 'refreshed');
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.doesNotMatch(exclude, /^\/\.opencode\/$/m);
  assert.equal(exclude.match(/sterling opencode \(managed/g).length, 1, 'one managed block, rewritten in place');
  mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.opencode', 'agents', 'implementor.md'), 'x\n');
  assert.deepEqual(untracked(dir), ['?? .opencode/agents/implementor.md']);
});

test('Sterling-full roster: conductor primary, Sterling lines kept, permissions translated, under agents/sterling/', () => {
  const home = tmp('oc-home-');
  const dir = project('work');
  const r = run(dir, home);
  for (const n of ['conductor', 'implementor', 'researcher', 'scout', 'reviewer', 'librarian']) assert.equal(statusOf(r, `${STERLING_AGENTS_SUBDIR}/${n}.md`), 'created', n);
  const read = (n) => readFileSync(join(dir, STERLING_AGENTS_SUBDIR, `${n}.md`), 'utf8');
  assert.match(read('conductor'), /^---\ndescription: .+\nmode: primary\n---\n<!-- sterling-full /);
  assert.match(read('conductor'), /dispatch those names/);
  // The implementor's only permissions are the store-write denies its Claude disallowedTools carry.
  assert.match(read('implementor'), /^---\ndescription: .+\nmode: subagent\npermission:\n( {2}sterling_\w+: deny\n)+---\n/);
  assert.match(read('researcher'), /\npermission:\n {2}edit: deny\n/);
  assert.match(read('scout'), /\n {2}bash: deny\n/);
  // Sterling-only lines survive: the full body is longer than the portable render of the same template.
  const tpl = readFileSync(join(repoRoot, 'agent-templates', 'implementor.md'), 'utf8');
  const portableBody = renderPortableText(tpl.replace(/^---\n[\s\S]*?\n---\n/, ''), 'implementor.md');
  assert.ok(read('implementor').length > portableBody.length + 200, 'Sterling lines kept');
  assert.match(read('implementor'), /knowledge/);
  assert.equal(statusOf(run(dir, home), `${STERLING_AGENTS_SUBDIR}/conductor.md`), 'matches');
});

test('Sterling-full roster: a local edit or a foreign file is refused, never overwritten', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const cond = join(dir, STERLING_AGENTS_SUBDIR, 'conductor.md');
  writeFileSync(cond, readFileSync(cond, 'utf8') + '\nmine\n');
  writeFileSync(join(dir, STERLING_AGENTS_SUBDIR, 'scout.md'), 'my scout\n');
  const r = run(dir, home);
  assert.equal(statusOf(r, '/conductor.md'), 'refused');
  assert.equal(statusOf(r, '/scout.md'), 'refused');
  assert.equal(readFileSync(join(dir, STERLING_AGENTS_SUBDIR, 'scout.md'), 'utf8'), 'my scout\n');
});

test('model swap: the swapped roster agent is re-rendered with the matching OpenCode model; the rest carry none', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const read = (n) => readFileSync(join(dir, STERLING_AGENTS_SUBDIR, `${n}.md`), 'utf8');
  assert.doesNotMatch(read('implementor'), /^model:/m, 'a fresh install pins no model');
  const r = swapFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['implementor', 'librarian'], model: 'claude-opus-5-5' });
  assert.equal(statusOf(r, '/implementor.md'), 'refreshed');
  assert.equal(statusOf(r, '/conductor.md'), 'matches');
  assert.match(read('implementor'), /^---\ndescription: .+\nmode: subagent\nmodel: anthropic\/claude-opus-5-5\n/);
  for (const n of ['conductor', 'researcher', 'scout']) assert.doesNotMatch(read(n), /^model:/m, n);
  // A later sync keeps the pin: the installed file is valid Sterling output, so it is matched, not reverted.
  assert.equal(statusOf(run(dir, home), '/implementor.md'), 'matches');
  assert.match(read('implementor'), /^model: anthropic\/claude-opus-5-5$/m);
  // Swapping again replaces the pin rather than adding a second line.
  swapFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['implementor'], model: 'claude-sonnet-5-5' });
  assert.deepEqual(read('implementor').match(/^model: .*$/gm), ['model: anthropic/claude-sonnet-5-5']);
});

test('model swap: a role with an OpenCode override pins openai/<id>; a role without one pins anthropic/<id>', () => {
  // decision opencode-only-model-override-per-role-for-openai-picks
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const read = (n) => readFileSync(join(dir, STERLING_AGENTS_SUBDIR, `${n}.md`), 'utf8');
  const swapped = swapFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['implementor'], model: 'claude-sonnet-5-5', opencodeModel: 'openai/gpt-5.6-terra' });
  // the rows are the public shape only: the staged path/content/previous stay internal
  for (const row of swapped.rows) assert.deepEqual(Object.keys(row).filter((k) => ['path', 'content', 'previous'].includes(k)), [], row.item);
  swapFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['reviewer'], model: 'claude-opus-5-5' });
  assert.deepEqual(read('implementor').match(/^model: .*$/gm), ['model: openai/gpt-5.6-terra']);
  assert.deepEqual(read('reviewer').match(/^model: .*$/gm), ['model: anthropic/claude-opus-5-5']);
  // A later sync keeps the override pin.
  assert.equal(statusOf(run(dir, home), '/implementor.md'), 'matches');
  // Clearing the override (no opencodeModel) goes back to the role's Claude model.
  swapFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['implementor'], model: 'claude-sonnet-5-5' });
  assert.deepEqual(read('implementor').match(/^model: .*$/gm), ['model: anthropic/claude-sonnet-5-5']);
  // A malformed override is refused before any file is written.
  const before = read('implementor');
  assert.throws(() => swapFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['implementor'], model: 'claude-sonnet-5-5', opencodeModel: 'gpt-5.6-terra\nhooks: x' }), /opencode_model/);
  assert.equal(read('implementor'), before);
});

test('writeFullAgentFiles: a write that fails part-way leaves the target intact and restores the files already written', () => {
  const dir = tmp('oc-atomic-');
  const a = join(dir, 'a.md');
  const b = join(dir, 'b.md');
  writeFileSync(a, 'old a\n');
  writeFileSync(b, 'old b\n');
  const writes = [
    { path: a, content: 'new a\n', previous: 'old a\n' },
    { path: b, content: 'new b, long enough to be cut short\n', previous: 'old b\n' },
    { path: join(dir, 'c.md'), content: 'new c\n', previous: null },
  ];
  // the write of b stops after a few bytes, as a full disk would
  let calls = 0;
  const writeFile = (p, c) => {
    calls += 1;
    if (calls === 2) { writeFileSync(p, c.slice(0, 5)); throw new Error('ENOSPC: no space left'); }
    writeFileSync(p, c);
  };
  assert.throws(() => writeFullAgentFiles(writes, { writeFile }), /ENOSPC/);
  assert.equal(readFileSync(b, 'utf8'), 'old b\n', 'the file whose write failed is untouched');
  assert.equal(readFileSync(a, 'utf8'), 'old a\n', 'the file already written is restored');
  assert.deepEqual(readdirSync(dir).sort(), ['a.md', 'b.md'], 'no temp file left and c.md never created');
  // a clean run replaces each file whole and creates the new one
  writeFullAgentFiles(writes);
  assert.deepEqual(readdirSync(dir).sort().map((n) => readFileSync(join(dir, n), 'utf8')), ['new a\n', 'new b, long enough to be cut short\n', 'new c\n']);
});

test('stageFullAgentModel keeps the raw bytes as previous: a CRLF agent is restored byte-identical after a failed write', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const impl = join(dir, STERLING_AGENTS_SUBDIR, 'implementor.md');
  const crlf = readFileSync(impl, 'utf8').replace(/\n/g, '\r\n');
  writeFileSync(impl, crlf);
  const staged = stageFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['implementor', 'reviewer'], model: 'claude-sonnet-5-5', opencodeModel: 'openai/gpt-5.6-terra' });
  assert.equal(statusOf(staged, '/implementor.md'), 'refreshed', 'a CRLF Sterling file is not mistaken for a hand edit');
  assert.equal(staged.writes.find((w) => w.path === impl).previous, crlf);
  let calls = 0;
  const writeFile = (p, c) => { calls += 1; if (calls === 2) throw new Error('ENOSPC: no space left'); writeFileSync(p, c); };
  assert.throws(() => writeFullAgentFiles(staged.writes, { writeFile }), /ENOSPC/);
  assert.equal(readFileSync(impl, 'utf8'), crlf, 'the CRLF file is back byte for byte');
});

test('opencodeModelFor: the override when set, else anthropic/<Claude model>', () => {
  assert.equal(opencodeModelFor({ model: 'claude-sonnet-5-5' }), 'anthropic/claude-sonnet-5-5');
  assert.equal(opencodeModelFor({ model: 'claude-sonnet-5-5', opencodeModel: 'openai/gpt-6.1-sol' }), 'openai/gpt-6.1-sol');
  assert.equal(opencodeModelFor({ model: 'claude-sonnet-5-5', opencodeModel: 'openai/gpt-6-astra' }), 'openai/gpt-6-astra');
  for (const bad of ['gpt-6-astra', 'openai/', '', 'openai/gpt 6', 42]) {
    assert.throws(() => opencodeModelFor({ model: 'claude-sonnet-5-5', opencodeModel: bad }), /opencode_model/, JSON.stringify(bad));
  }
  assert.throws(() => opencodeModelFor({}), /model/);
});

test('model swap: a hand-edited Sterling-full file is refused and left byte-identical', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const p = join(dir, STERLING_AGENTS_SUBDIR, 'implementor.md');
  writeFileSync(p, readFileSync(p, 'utf8') + '\nmine\n');
  const before = readFileSync(p, 'utf8');
  const r = swapFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['implementor'], model: 'claude-opus-5-5' });
  assert.equal(statusOf(r, '/implementor.md'), 'refused');
  assert.equal(readFileSync(p, 'utf8'), before);
});

test('model swap: a project without the Sterling-full OpenCode set is skipped and nothing is created', () => {
  const dir = project('hobby');
  const r = swapFullAgentModel({ projectDir: dir, pluginRoot: repoRoot, agents: ['implementor'], model: 'claude-opus-5-5' });
  assert.match(r.skipped, /no Sterling-full OpenCode agents/);
  assert.equal(existsSync(join(dir, '.opencode')), false);
});

test('opencodeModelRef maps a Claude model id to the anthropic provider; sterlingRootFrom finds the plugin root', () => {
  assert.equal(opencodeModelRef('claude-sonnet-5-5'), 'anthropic/claude-sonnet-5-5');
  assert.throws(() => opencodeModelRef(''), /model/);
  assert.equal(sterlingRootFrom(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'opencode-install.mjs')).href), repoRoot);
  assert.equal(sterlingRootFrom(pathToFileURL(join(repoRoot, 'tui', 'x.mjs')).href), repoRoot);
});

// ---------- the generated shims, run for real against stub Sterling roots -----------

function stubSterlingRoot(dir, tag) {
  mkdirSync(join(dir, 'opencode', 'sterling-tui'), { recursive: true });
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'opencode', 'sterling-server.mjs'), `export default { id: 'sterling.server', async setup(ctx) { return '${tag}:' + ctx.location.directory; } };\n`);
  writeFileSync(join(dir, 'opencode', 'sterling-tui', 'package.json'), JSON.stringify({ type: 'module', exports: { './tui': './tui.js' } }));
  writeFileSync(join(dir, 'opencode', 'sterling-tui', 'tui.js'), `export default { id: 'sterling.tui.${tag}', setup(api) { return '${tag}:' + api.location.directory; } };\n`);
  writeFileSync(join(dir, 'mcp', 'sterling-mcp.mjs'), `console.log('${tag} ' + JSON.stringify(process.argv.slice(2)));\n`);
  return dir;
}

test('server and TUI shims delegate to the resolved Sterling; non-Sterling projects load nothing', async () => {
  const home = tmp('oc-home-');
  const root = stubSterlingRoot(tmp('oc-root-'), 'clone');
  cpSync(join(repoRoot, 'agent-templates'), join(root, 'agent-templates'), { recursive: true });
  const dir = project('hobby');
  setupOpenCode({ projectDir: dir, pluginRoot: root, env: { HOME: home }, home, installed: false, probe: OC2 });
  const plugins = join(opencodeConfigDir({ env: {}, home }), 'plugins');
  const server = (await import(pathToFileURL(join(plugins, 'sterling.js')).href)).default;
  assert.equal(server.id, 'sterling');
  assert.equal(await server.setup({ location: { directory: tmp('oc-plain-') } }), undefined);
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  assert.equal(await server.setup({ location: { directory: dir } }), `clone:${dir}`);
  const tuiCopy = join(tmp('oc-tui-'), 'tui.mjs');
  copyFileSync(join(plugins, 'sterling-tui', 'tui.tsx'), tuiCopy);
  const tui = (await import(pathToFileURL(tuiCopy).href)).default;
  assert.equal(tui.id, 'sterling.tui.clone');
  // A non-Sterling project gets a no-op: the Sterling plugin's setup never runs.
  const plain = tui.setup({ location: { directory: tmp('oc-plain-') } });
  assert.equal(typeof plain, 'function', 'a no-op disposer');
  assert.equal(tui.setup({ location: { directory: dir } }), `clone:${dir}`);
  const mcp = spawnSync(process.execPath, [mcpLauncherPath({ home }), '--store', '.sterling/sterling.db'], { encoding: 'utf8' });
  assert.equal(mcp.stdout.trim(), 'clone ["--store",".sterling/sterling.db"]');
});

test('no Sterling installed: the TUI shim imports cleanly and its setup logs ONE line and is a no-op; the server shim does the same inside a Sterling project', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: true, probe: OC2 });
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  const plugins = join(opencodeConfigDir({ env: {}, home }), 'plugins');
  const tuiCopy = join(tmp('oc-tui-'), 'tui.mjs');
  copyFileSync(join(plugins, 'sterling-tui', 'tui.tsx'), tuiCopy);
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  const probe = (shim, label) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    const p = (await import(${JSON.stringify(pathToFileURL(shim).href)})).default;
    const r = await p.setup({ location: { directory: ${JSON.stringify(dir)} } });
    console.log('${label}', typeof r);`], { encoding: 'utf8', env });
  const t = probe(tuiCopy, 'tui');
  assert.equal(t.status, 0, t.stderr);
  assert.equal(t.stdout.trim(), 'tui function');
  const tLines = t.stderr.trim().split('\n');
  assert.equal(tLines.length, 1, t.stderr);
  assert.match(tLines[0], /^Sterling not found; the dashboard is off\. Remove .*plugins\/sterling-tui or reinstall Sterling/);
  const s = probe(join(plugins, 'sterling.js'), 'server');
  assert.equal(s.status, 0, s.stderr);
  assert.equal(s.stdout.trim(), 'server undefined');
  const sLines = s.stderr.trim().split('\n');
  assert.equal(sLines.length, 1, s.stderr);
  assert.match(sLines[0], /^Sterling not found; the knowledge loop is off\. Remove .*plugins\/sterling\.js or reinstall Sterling/);
});

test('default_agent is set only when the conductor file is Sterling\'s; a refused conductor leaves it unset', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, STERLING_AGENTS_SUBDIR), { recursive: true });
  writeFileSync(join(dir, STERLING_AGENTS_SUBDIR, 'conductor.md'), 'my own conductor\n');
  const r = run(dir, home);
  assert.equal(statusOf(r, '/conductor.md'), 'refused');
  const cfg = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8'));
  assert.equal(cfg.default_agent, undefined);
  assert.match(r.rows.find((x) => x.item === '.opencode/opencode.json').detail, /default_agent not set/);
  rmSync(join(dir, STERLING_AGENTS_SUBDIR, 'conductor.md'));
  run(dir, home);
  assert.equal(JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')).default_agent, CONDUCTOR_AGENT);
});

test('the TUI shim package.json is stamped: an edited one is refused and left byte-identical', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const pkgPath = join(opencodeConfigDir({ env: {}, home }), 'plugins', 'sterling-tui', 'package.json');
  assert.match(readFileSync(pkgPath, 'utf8'), /content_hash=[0-9a-f]{64}/);
  assert.equal(statusOf(run(dir, home), 'sterling-tui/package.json'), 'matches');
  const edited = readFileSync(pkgPath, 'utf8').replace('"./tui.tsx"', '"./mine.tsx"');
  writeFileSync(pkgPath, edited);
  assert.equal(statusOf(run(dir, home), 'sterling-tui/package.json'), 'refused');
  assert.equal(readFileSync(pkgPath, 'utf8'), edited);
});

/** A stub copy carrying the manifest the shared resolver reads its version from. */
function stubInstalledCopy(dir, version, manifest = join('.claude-plugin', 'plugin.json')) {
  stubSterlingRoot(dir, `v${version}`);
  mkdirSync(dirname(join(dir, manifest)), { recursive: true });
  writeFileSync(join(dir, manifest), JSON.stringify({ name: 'sterling', version }));
  return dir;
}

test('installed-copy shims pick the highest installed version at run time, across the Claude Code and OpenCode caches', () => {
  const home = tmp('oc-home-');
  const cache = join(home, '.claude', 'plugins', 'cache', 'sterling');
  const npm = join(home, '.cache', 'opencode', 'npm', '@chulf58', 'sterling@latest');
  stubInstalledCopy(join(cache, 'sterling', '0.9.0'), '0.9.0');
  stubInstalledCopy(join(cache, 'sterling', '0.10.0'), '0.10.0');
  const dir = project('hobby');
  setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: true, probe: OC2 });
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.XDG_CACHE_HOME;
  const runMcp = () => spawnSync(process.execPath, [mcpLauncherPath({ home }), '--store', 's.db'], { encoding: 'utf8', env });
  assert.equal(runMcp().stdout.trim(), 'v0.10.0 ["--store","s.db"]');
  stubInstalledCopy(join(npm, '1759500000000', 'node_modules', '@chulf58', 'sterling'), '0.11.0', 'package.json');
  assert.equal(runMcp().stdout.trim(), 'v0.11.0 ["--store","s.db"]', 'a newer OpenCode npm-cache copy wins');
  rmSync(join(cache, 'sterling'), { recursive: true });
  rmSync(join(home, '.cache'), { recursive: true });
  const none = runMcp();
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no installed Sterling found under .*plugins.cache .*opencode.npm .*opencode plugin add "github:Chulf58\/sterling#semver:>=0\.18\.0"/);
  assert.doesNotMatch(none.stderr, /claude plugin install/, 'the OpenCode shims name the OpenCode remedy');
});

test('storeWriteTools throws, naming the template, when disallowedTools has no mcp__sterling__* entry', () => {
  const root = tmp('oc-roster-');
  try {
    mkdirSync(join(root, 'agent-templates'));
    writeFileSync(join(root, 'agent-templates', 'implementor.md'), '---\nname: implementor\ndisallowedTools: Agent, WebFetch\n---\nbody\n');
    assert.throws(() => storeWriteTools(root), /no mcp__sterling__\* entries in .*implementor\.md disallowedTools/);
    writeFileSync(join(root, 'agent-templates', 'implementor.md'), '---\nname: implementor\n---\nbody\n');
    assert.throws(() => storeWriteTools(root), /no mcp__sterling__\* entries/, 'a template with no disallowedTools line at all');
    writeFileSync(join(root, 'agent-templates', 'implementor.md'), '---\nname: implementor\ndisallowedTools: Agent, mcp__sterling__knowledge_create, mcp__sterling__board_add\n---\nbody\n');
    assert.deepEqual(storeWriteTools(root), ['sterling_knowledge_create', 'sterling_board_add']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Decision sterling-opencode-plugin-injects-its-own-mcp-entry: init no longer writes
// mcp.sterling per project. An entry an earlier init wrote goes only when it is exactly
// Sterling's; anything else is kept, with a loud row.
const earlierSterlingEntry = (home) => ({ type: 'local', command: ['node', '--disable-warning=ExperimentalWarning', mcpLauncherPath({ home }).replace(/\\/g, '/'), '--store', '.sterling/sterling.db'] });

test('project config: an mcp.sterling entry exactly as an earlier init wrote it is removed; other mcp entries stay', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode'));
  const cfg = join(dir, '.opencode', 'opencode.json');
  writeFileSync(cfg, JSON.stringify({ mcp: { other: { type: 'local', command: ['x'] }, sterling: earlierSterlingEntry(home) } }, null, 2));
  const r = run(dir, home);
  assert.equal(statusOf(r, 'opencode.json'), 'refreshed');
  assert.match(r.rows.find((x) => x.item.endsWith('opencode.json')).detail, /removed the sterling MCP entry an earlier init wrote/);
  const got = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(got.mcp.sterling, undefined);
  assert.deepEqual(got.mcp.other, { type: 'local', command: ['x'] });

  const dir2 = project('hobby');
  mkdirSync(join(dir2, '.opencode'));
  writeFileSync(join(dir2, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { sterling: earlierSterlingEntry(home) } }));
  run(dir2, home);
  assert.equal('mcp' in JSON.parse(readFileSync(join(dir2, '.opencode', 'opencode.json'), 'utf8')), false, 'an mcp object left empty by the removal goes too');
});

test('project config: an mcp.sterling entry that differs from what Sterling wrote is kept, with a loud row', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  mkdirSync(join(dir, '.opencode'));
  const cfg = join(dir, '.opencode', 'opencode.json');
  const mine = { type: 'local', command: ['node', '/my/own/sterling-mcp.mjs'] };
  writeFileSync(cfg, JSON.stringify({ mcp: { sterling: mine } }));
  const r = run(dir, home);
  const loud = r.rows.find((x) => x.item.endsWith('opencode.json mcp.sterling'));
  assert.ok(loud, 'a row of its own for the kept entry');
  assert.equal(loud.status, 'skipped');
  assert.match(loud.detail, /^KEPT: .*differs from the entry Sterling wrote.*the Sterling plugin now adds its own sterling MCP entry/);
  assert.ok(formatOpenCodeRows(r).some((l) => /mcp\.sterling — KEPT/.test(l)), 'the kept entry is printed');
  assert.deepEqual(JSON.parse(readFileSync(cfg, 'utf8')).mcp.sterling, mine);
});

// Finding 789147ca: OpenCode gives a TUI bundle its own solid-js only when the bundle
// lives outside any node_modules path, so for the npm-installed copy the dashboard is
// copied ("materialized") to ~/.sterling/opencode/tui/<version>/ and the normal TUI
// shim loads the newest copy there. No cli.json entry is needed.
function npmCopyRoot(home, version = '1.0.0', bundle = 'export default { id: "sterling.dashboard" };\n') {
  const root = join(home, '.cache', 'opencode', 'npm', '@chulf58', 'sterling@latest', `ts-${version}`, 'node_modules', '@chulf58', 'sterling');
  stubSterlingRoot(root, 'npm');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@chulf58/sterling', version }));
  writeFileSync(join(root, 'opencode', 'sterling-tui', 'package.json'), JSON.stringify({ name: 'sterling-tui', type: 'module', exports: { './tui': './sterling-tui.bundle.tsx' } }));
  writeFileSync(join(root, 'opencode', 'sterling-tui', 'sterling-tui.bundle.tsx'), bundle);
  cpSync(join(repoRoot, 'agent-templates'), join(root, 'agent-templates'), { recursive: true });
  return root;
}
const runNpm = (dir, home, env = { HOME: home }) => setupOpenCode({ projectDir: dir, pluginRoot: npmCopyRoot(home), env, home, probe: OC2 });
const tuiBase = (home) => join(home, '.sterling', 'opencode', 'tui');
const rowOf = (rows, suffix) => rows.find((r) => r.item.endsWith(suffix));

test('materializeTui: copies the TUI bundle out of the npm cache into ~/.sterling/opencode/tui/<version>/, idempotently', () => {
  const home = tmp('oc-home-');
  const root = npmCopyRoot(home, '1.0.0');
  const first = materializeTui({ pluginRoot: root, home, env: {} });
  assert.equal(rowOf(first, '/tui/1.0.0/').status, 'created');
  for (const f of ['package.json', 'sterling-tui.bundle.tsx']) {
    assert.equal(readFileSync(join(tuiBase(home), '1.0.0', f), 'utf8'), readFileSync(join(root, 'opencode', 'sterling-tui', f), 'utf8'), f);
  }
  assert.equal(join(tuiBase(home), '1.0.0').includes('node_modules'), false);
  assert.equal(rowOf(materializeTui({ pluginRoot: root, home, env: {} }), '/tui/1.0.0/').status, 'matches');
  writeFileSync(join(root, 'opencode', 'sterling-tui', 'sterling-tui.bundle.tsx'), 'export default { id: "rebuilt" };\n');
  assert.equal(rowOf(materializeTui({ pluginRoot: root, home, env: {} }), '/tui/1.0.0/').status, 'refreshed');
  assert.match(readFileSync(join(tuiBase(home), '1.0.0', 'sterling-tui.bundle.tsx'), 'utf8'), /rebuilt/);
});

test('materializeTui: keeps the newest two versions, removes older ones Sterling wrote, keeps anything else loudly', () => {
  const home = tmp('oc-home-');
  for (const v of ['0.9.0', '0.10.0']) materializeTui({ pluginRoot: npmCopyRoot(home, v), home, env: {} });
  mkdirSync(join(tuiBase(home), '0.1.0'));
  writeFileSync(join(tuiBase(home), '0.1.0', 'mine.txt'), 'x\n');
  writeFileSync(join(tuiBase(home), '0.9.0', 'sterling-tui.bundle.tsx'), '// edited\n');
  materializeTui({ pluginRoot: npmCopyRoot(home, '0.11.0'), home, env: {} });
  assert.ok(existsSync(join(tuiBase(home), '0.10.0')), 'with 0.11.0 newest, 0.10.0 is still one of the newest two');
  const rows = materializeTui({ pluginRoot: npmCopyRoot(home, '1.0.0'), home, env: {} });
  assert.deepEqual(['1.0.0', '0.11.0'].map((v) => existsSync(join(tuiBase(home), v))), [true, true], 'the newest two stay');
  assert.equal(existsSync(join(tuiBase(home), '0.10.0')), false, 'an older unedited copy Sterling wrote is removed');
  assert.equal(rowOf(rows, '/tui/0.10.0/').status, 'removed');
  for (const v of ['0.9.0', '0.1.0']) {
    assert.ok(existsSync(join(tuiBase(home), v)), `${v} stays`);
    assert.match(rowOf(rows, `/tui/${v}/`).detail, /^KEPT: /, v);
  }
});

test('materializeTui: a copy without a version or without the TUI bundle is refused, nothing written', () => {
  const home = tmp('oc-home-');
  const root = npmCopyRoot(home, '1.0.0');
  rmSync(join(root, 'opencode', 'sterling-tui', 'sterling-tui.bundle.tsx'));
  const missing = materializeTui({ pluginRoot: root, home, env: {} });
  assert.equal(missing[0].status, 'refused');
  assert.match(missing[0].detail, /sterling-tui\.bundle\.tsx/);
  writeFileSync(join(root, 'package.json'), '{}');
  assert.match(materializeTui({ pluginRoot: root, home, env: {} })[0].detail, /no semver version/);
  assert.equal(existsSync(tuiBase(home)), false);
});

test('npm-installed copy: no server shim, the TUI is materialized and the TUI shim points at the materialized dir; no cli.json', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const first = runNpm(dir, home);
  const plugins = join(opencodeConfigDir({ env: {}, home }), 'plugins');
  assert.equal(existsSync(join(plugins, 'sterling.js')), false, 'plugin add registers the server, a shim would load it twice');
  assert.equal(statusOf(first, '/sterling.js'), 'skipped');
  assert.match(rowOf(first.rows, '/sterling.js').detail, /opencode plugin add registers .*server/);
  assert.equal(statusOf(first, '/tui/1.0.0/'), 'created');
  assert.equal(statusOf(first, 'sterling-tui/tui.tsx'), 'created');
  const shim = readFileSync(join(plugins, 'sterling-tui', 'tui.tsx'), 'utf8');
  assert.ok(shim.includes(JSON.stringify(tuiBase(home).replace(/\\/g, '/'))), 'the shim names the unversioned materialized root');
  assert.equal(shim.includes('sterling@latest'), false, 'the shim never names the npm cache copy');
  assert.equal(existsSync(join(opencodeConfigDir({ env: {}, home }), 'cli.json')), false);
  const again = runNpm(dir, home);
  assert.equal(statusOf(again, 'sterling-tui/tui.tsx'), 'matches');
});

test('materialized TUI shim: loads the NEWEST materialized version at load time', async () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  runNpm(dir, home);
  for (const v of ['1.9.0', '1.10.0']) {
    const d = join(tuiBase(home), v);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ type: 'module', exports: { './tui': './t.mjs' } }));
    writeFileSync(join(d, 't.mjs'), `export default { id: 'tui-${v}', setup(api) { return '${v}:' + api.location.directory; } };\n`);
  }
  const shimCopy = join(tmp('oc-tui-'), 'tui.mjs');
  copyFileSync(join(opencodeConfigDir({ env: {}, home }), 'plugins', 'sterling-tui', 'tui.tsx'), shimCopy);
  const tui = (await import(pathToFileURL(shimCopy).href)).default;
  assert.equal(tui.id, 'tui-1.10.0');
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  assert.equal(tui.setup({ location: { directory: dir } }), `1.10.0:${dir}`);
});

test('materialized TUI shim: an import failure is LOUD in a Sterling project, naming the file and the cause', async () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  setupOpenCode({ projectDir: dir, pluginRoot: npmCopyRoot(home, '1.0.0', "import '@opentui/solid-not-here';\nexport default {};\n"), env: { HOME: home }, home, probe: OC2 });
  const d = join(tuiBase(home), '1.0.0');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ type: 'module', exports: { './tui': './broken.mjs' } }));
  writeFileSync(join(d, 'broken.mjs'), "import '@opentui/solid-not-here';\nexport default {};\n");
  const shimCopy = join(tmp('oc-tui-'), 'tui.mjs');
  copyFileSync(join(opencodeConfigDir({ env: {}, home }), 'plugins', 'sterling-tui', 'tui.tsx'), shimCopy);
  const tui = (await import(pathToFileURL(shimCopy).href)).default;
  assert.equal(typeof tui.setup({ location: { directory: tmp('oc-plain-') } }), 'function', 'a non-Sterling project is not disturbed');
  writeFileSync(join(dir, '.sterling', 'sterling.db'), '');
  assert.throws(() => tui.setup({ location: { directory: dir } }), (err) => {
    assert.match(err.message, /importing the dashboard .*\/tui\/1\.0\.0\/broken\.mjs failed: .*@opentui\/solid-not-here/);
    assert.match(err.message, /dashboard is off/);
    return true;
  });
});

test('npm-installed copy: an unedited server shim an earlier init wrote is removed, and the TUI shim is rewritten to the materialized dir', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home, { installed: true });
  const plugins = join(opencodeConfigDir({ env: {}, home }), 'plugins');
  writeFileSync(join(plugins, 'neighbour.js'), 'export default {};\n');
  const r = runNpm(dir, home);
  assert.equal(statusOf(r, '/sterling.js'), 'removed');
  assert.equal(existsSync(join(plugins, 'sterling.js')), false);
  assert.equal(statusOf(r, 'sterling-tui/tui.tsx'), 'refreshed');
  assert.match(readFileSync(join(plugins, 'sterling-tui', 'tui.tsx'), 'utf8'), /newestMaterializedTui\(\)/);
  assert.equal(readFileSync(join(plugins, 'neighbour.js'), 'utf8'), 'export default {};\n', 'nothing else in plugins/ is touched');
  assert.equal(statusOf(runNpm(dir, home), '/sterling.js'), 'skipped', 'a second run has nothing left to remove');
});

test('npm-installed copy: an edited or foreign server shim is KEPT with a loud row and left untouched', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home, { installed: true });
  const server = join(opencodeConfigDir({ env: {}, home }), 'plugins', 'sterling.js');
  const edited = readFileSync(server, 'utf8') + '// my tweak\n';
  writeFileSync(server, edited);
  assert.match(rowOf(runNpm(dir, home).rows, '/sterling.js').detail, /^KEPT: .*edited after Sterling wrote it.*load twice/);
  assert.equal(readFileSync(server, 'utf8'), edited);

  const home2 = tmp('oc-home-');
  const plugins2 = join(opencodeConfigDir({ env: {}, home: home2 }), 'plugins');
  mkdirSync(plugins2, { recursive: true });
  writeFileSync(join(plugins2, 'sterling.js'), 'export default { id: "mine" };\n');
  assert.match(rowOf(runNpm(project('hobby'), home2).rows, '/sterling.js').detail, /^KEPT: .*Sterling did not write it/);
  assert.equal(readFileSync(join(plugins2, 'sterling.js'), 'utf8'), 'export default { id: "mine" };\n');
});

// Dual-host machine: the server shim's suppression and the TUI shim's target come from
// MACHINE STATE (an npm copy in OpenCode's cache, or the global opencode.json plugins list),
// not from which copy runs init. Otherwise Claude's init writes a server shim next to the
// registered npm package and OpenCode loads Sterling twice.
test('dual-host machine, Claude runs init: the npm copy in the cache retires the server shim and the TUI shim points at the materialized dir', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home, { installed: true });
  const plugins = join(opencodeConfigDir({ env: {}, home }), 'plugins');
  assert.ok(existsSync(join(plugins, 'sterling.js')), 'precondition: before the npm copy exists, Claude init writes the server shim');
  npmCopyRoot(home, '1.0.0');
  const r = run(dir, home, { installed: true });
  assert.equal(statusOf(r, '/sterling.js'), 'removed', 'the unedited shim is retired: the npm package registers the server');
  assert.equal(existsSync(join(plugins, 'sterling.js')), false);
  assert.equal(statusOf(r, '/tui/1.0.0/'), 'created', "the npm copy's dashboard is materialized from the npm copy, not from the Claude copy");
  assert.match(readFileSync(join(plugins, 'sterling-tui', 'tui.tsx'), 'utf8'), /newestMaterializedTui\(\)/);
  const again = run(dir, home, { installed: true });
  assert.equal(statusOf(again, '/sterling.js'), 'skipped', 'a second Claude init does not write the shim back');
  assert.equal(existsSync(join(plugins, 'sterling.js')), false);
  assert.equal(statusOf(again, 'sterling-tui/tui.tsx'), 'matches');
});

test('dual-host machine: the global opencode.json naming Sterling (the Git spec or the package name) in plugins suppresses the server shim before the cache holds a copy', () => {
  for (const entry of ['github:Chulf58/sterling#semver:>=0.18.0', 'Chulf58/sterling#opencode-release', 'git+https://github.com/Chulf58/sterling.git#semver:>=0.18.0', 'git+ssh://git@github.com/chulf58/sterling.git', 'ssh://git@github.com/Chulf58/sterling.git', 'https://www.github.com/Chulf58/sterling', 'git+https://www.github.com/Chulf58/sterling.git#opencode-release', { package: 'github:Chulf58/sterling#semver:>=0.18.0' }, '@chulf58/sterling', '@chulf58/sterling@latest', { package: '@chulf58/sterling' }]) {
    const home = tmp('oc-home-');
    const cfgDir = opencodeConfigDir({ env: {}, home });
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify({ plugins: ['other-plugin', entry] }));
    const r = run(project('hobby'), home, { installed: true });
    assert.equal(statusOf(r, '/sterling.js'), 'skipped', JSON.stringify(entry));
    assert.equal(existsSync(join(cfgDir, 'plugins', 'sterling.js')), false, JSON.stringify(entry));
    assert.doesNotMatch(readFileSync(join(cfgDir, 'plugins', 'sterling-tui', 'tui.tsx'), 'utf8'), /newestMaterializedTui/, 'no npm copy to materialize yet, so the TUI shim keeps the running copy');
  }
  const home = tmp('oc-home-');
  const cfgDir = opencodeConfigDir({ env: {}, home });
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'opencode.json'), JSON.stringify({ plugins: ['@chulf58/sterling-other', 'github:Chulf58/sterling-other#semver:>=1.0.0', 'github:someone/sterling'] }));
  assert.equal(statusOf(run(project('hobby'), home, { installed: true }), '/sterling.js'), 'created', 'a different package name or repo does not count');
});

test('dual-host machine: an unreadable global opencode.json is said out loud and does not suppress the server shim', () => {
  const home = tmp('oc-home-');
  const cfgDir = opencodeConfigDir({ env: {}, home });
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'opencode.json'), '{ not json');
  const r = run(project('hobby'), home, { installed: true });
  assert.equal(statusOf(r, '/sterling.js'), 'created');
  const row = r.rows.find((x) => /plugins$/.test(x.item) && x.item.includes('opencode.json'));
  assert.ok(row, 'a row names the global config it could not read');
  assert.match(row.detail, /not valid JSON/);
});

test('a clone or Claude-cache copy keeps today\'s shims and materializes nothing', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  const r = run(dir, home, { installed: true });
  assert.equal(statusOf(r, '/sterling.js'), 'created');
  assert.equal(statusOf(r, 'sterling-tui/tui.tsx'), 'created');
  assert.equal(existsSync(tuiBase(home)), false);
  assert.doesNotMatch(readFileSync(join(opencodeConfigDir({ env: {}, home }), 'plugins', 'sterling-tui', 'tui.tsx'), 'utf8'), /newestMaterializedTui/);
});
