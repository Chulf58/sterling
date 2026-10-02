// The public npm package @chulf58/sterling (decision
// sterling-on-opencode-distributes-as-npm-package-via-opencode-plugin-add) is
// what `opencode plugin add` installs: a registry tarball, no lifecycle
// scripts, the server entry resolved through exports ./server (finding
// 3b0d9ea0), running from OpenCode's npm cache dir (finding f3adf829).
// There is no ./tui export and no peers: the dashboard gets the host's solid
// only from a bundle outside node_modules, and solid copies beside it freeze
// it (finding 789147ca). The TUI bundle still ships, for the installer to copy
// out of node_modules.
//
// This packs the TRACKED files (working-tree content, nothing untracked), as
// the publish step does from `git archive`, installs the tarball into a temp
// dir far from the repo's node_modules, and loads ./server from there
// (anti-pattern 437e47d5: prove the shipped entry loads with no node_modules
// and no dist).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultExec } from '../lib/update.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = mkdtempSync(join(tmpdir(), 'sterling-npm-package-'));
after(() => rmSync(work, { recursive: true, force: true }));

function trackedCopy() {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' });
  assert.equal(ls.status, 0, ls.stderr);
  const root = join(work, 'tree');
  for (const rel of ls.stdout.split('\0').filter(Boolean)) {
    if (!existsSync(join(repo, rel))) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(repo, rel), join(root, rel));
  }
  return root;
}

let packed;
function pack() {
  if (packed) return packed;
  const tree = trackedCopy();
  const r = defaultExec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: tree });
  assert.equal(r.status, 0, r.stderr);
  const [info] = JSON.parse(r.stdout);
  packed = { info, tarball: join(work, info.filename), paths: info.files.map((f) => f.path) };
  return packed;
}

test('the package is the public @chulf58/sterling with only the ./server export and no dependencies or peers', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@chulf58/sterling');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.deepEqual(pkg.exports, { './server': './opencode/sterling-server.mjs' }, 'no ./tui export: a TUI loaded from the cache path gets no host solid (finding 789147ca)');
  assert.equal(pkg.peerDependencies, undefined, 'solid peers beside the bundle freeze the dashboard (finding 789147ca)');
  assert.equal(pkg.dependencies, undefined, 'the package installs with no dependencies of its own');
});

test('the tarball carries the runtime tree and none of the sources, tests or machine state', () => {
  const { paths } = pack();
  for (const need of [
    'package.json',
    'opencode/sterling-server.mjs',
    'opencode/sterling-tui/sterling-tui.bundle.tsx',
    'agent-templates/registry.json',
    'templates/target-claude-md.md',
    'templates/maintenance-worker-prompt.md',
    '.claude-plugin/plugin.json',
    '.claude-plugin/sterling-mcp.json',
    'mcp/sterling-mcp.mjs',
    'hooks/hooks.json',
    'tui/sterling-tui.mjs',
    'commands/merge.md',
    'scripts/maintenance-worker-run.mjs',
  ]) {
    assert.ok(paths.includes(need), `missing from the tarball: ${need}`);
  }
  const forbidden = paths.filter((p) => /^(packages|docs|\.sterling|\.claude|node_modules|scripts\/tests|opencode\/sterling-tui\/tests)\//.test(p) || /(^|\/)node_modules\//.test(p));
  assert.deepEqual(forbidden, []);
  for (const src of ['opencode/sterling-tui/tui.tsx', 'opencode/sterling-tui/view.ts', 'package-lock.json', '.npmrc']) {
    assert.ok(!paths.includes(src), `source shipped: ${src}`);
  }
});

test('installed from the tarball with no repo node_modules, ./server loads and finds its root inside the installed package', () => {
  const { tarball } = pack();
  const inst = join(work, 'install');
  mkdirSync(inst);
  writeFileSync(join(inst, 'package.json'), JSON.stringify({ name: 'probe', private: true }));
  // --offline: a package with no dependencies and no peers installs from the tarball alone.
  const install = defaultExec('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball], { cwd: inst });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const pkgRoot = realpathSync(join(inst, 'node_modules', '@chulf58', 'sterling'));
  assert.equal(existsSync(join(pkgRoot, 'node_modules')), false, 'the package brought no dependencies');

  const project = join(work, 'project');
  mkdirSync(project);
  const probe = [
    "const m = await import('@chulf58/sterling/server');",
    "const layer = m.renderSterlingLayer(process.argv[1]);",
    "let tui; try { tui = import.meta.resolve('@chulf58/sterling/tui'); } catch (e) { tui = e.code; }",
    "console.log(JSON.stringify({ plugin: typeof m.default, root: m.sterlingRoot(), tui, layerHasCommands: layer.includes('commands') }));",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', probe, project], { cwd: inst, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.notEqual(out.plugin, 'undefined', 'the server module has a default export');
  assert.equal(realpathSync(out.root), pkgRoot, 'sterlingRootFrom resolves to the installed package, not the repo');
  assert.equal(out.tui, 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'the TUI is not loadable from the cache path');
  assert.ok(existsSync(join(pkgRoot, 'opencode', 'sterling-tui', 'sterling-tui.bundle.tsx')), 'the TUI bundle ships for the installer to copy out of node_modules');
  assert.equal(out.layerHasCommands, true, 'the Sterling layer renders from the shipped templates/ and commands/');
});
