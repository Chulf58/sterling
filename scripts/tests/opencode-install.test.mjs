// Sterling on OpenCode 2 setup (scripts/lib/opencode-install.mjs): global shims, the
// per-project untracked config, the exclude handling and the Sterling-full roster.
// Every test runs against a temp HOME and temp git projects, with OpenCode stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  setupOpenCode, formatOpenCodeRows, opencodeConfigDir, mcpLauncherPath, STERLING_AGENTS_SUBDIR, CONDUCTOR_AGENT,
  swapFullAgentModel, opencodeModelRef, sterlingRootFrom,
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

function project(mode) {
  const dir = tmp('oc-proj-');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode }));
  writeFileSync(join(dir, 'README.md'), 'x\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', 'README.md', '.gitignore']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

function run(dir, home, extra = {}) {
  return setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: false, probe: OC2, ...extra });
}

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
  assert.deepEqual([...new Set(second.rows.map((r) => r.status))], ['matches']);
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
  assert.deepEqual(got.mcp.sterling, { type: 'local', command: ['node', '--disable-warning=ExperimentalWarning', mcpLauncherPath({ home }).replace(/\\/g, '/'), '--store', '.sterling/sterling.db'] });
  assert.equal(got.permission.bash, 'ask');
  assert.deepEqual(got.permission.edit, { '*': 'ask', '**/.sterling/sterling.db*': 'deny', '.sterling/sterling.db*': 'deny' });
  assert.equal(got.default_agent, 'build', "the user's default_agent is kept");
  assert.match(r.rows.find((x) => x.item.endsWith('opencode.json')).detail, /default_agent kept as "build"/);
  assert.equal(statusOf(run(dir, home), 'opencode.json'), 'matches');
});

test('project config: a fresh file gets the measured guard shape and the conductor as default_agent', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  const got = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(Object.entries(got.permission.edit), [['*', 'allow'], ['**/.sterling/sterling.db*', 'deny'], ['.sterling/sterling.db*', 'deny']]);
  assert.equal(got.default_agent, CONDUCTOR_AGENT);
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

test('hobby project: the whole .opencode/ is excluded through .git/info/exclude; .gitignore is never written', () => {
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

test('work project with COMMITTED portable agents: only Sterling paths are excluded, the committed copies are untouched', () => {
  const home = tmp('oc-home-');
  const dir = project('work');
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

test('fresh work project (portable copies not yet committed): never hides them; a hobby→work switch rewrites the block', () => {
  const home = tmp('oc-home-');
  const dir = project('hobby');
  run(dir, home);
  assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.opencode\/$/m);
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'work' }));
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
  for (const n of ['conductor', 'implementor', 'researcher', 'scout']) assert.equal(statusOf(r, `${STERLING_AGENTS_SUBDIR}/${n}.md`), 'created', n);
  const read = (n) => readFileSync(join(dir, STERLING_AGENTS_SUBDIR, `${n}.md`), 'utf8');
  assert.match(read('conductor'), /^---\ndescription: .+\nmode: primary\n---\n<!-- sterling-full /);
  assert.match(read('conductor'), /dispatch those names/);
  assert.match(read('implementor'), /^---\ndescription: .+\nmode: subagent\n---\n/);
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

test('installed-copy shims pick the highest installed version at run time', () => {
  const home = tmp('oc-home-');
  const cache = join(home, '.claude', 'plugins', 'cache', 'sterling');
  stubSterlingRoot(join(cache, 'sterling', '0.9.0'), 'v0.9.0');
  stubSterlingRoot(join(cache, 'sterling', '0.10.0'), 'v0.10.0');
  const dir = project('hobby');
  setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: true, probe: OC2 });
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  const mcp = spawnSync(process.execPath, [mcpLauncherPath({ home }), '--store', 's.db'], { encoding: 'utf8', env });
  assert.equal(mcp.stdout.trim(), 'v0.10.0 ["--store","s.db"]');
  rmSync(join(cache, 'sterling'), { recursive: true });
  const none = spawnSync(process.execPath, [mcpLauncherPath({ home }), '--store', 's.db'], { encoding: 'utf8', env });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no installed Sterling plugin under .*claude plugin install sterling@sterling/);
});
