// Launchers must not bake a path into a versioned plugin cache (decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone, ruling
// point 3). On an INSTALLED copy (no .git at the plugin root): no --plugin-dir, the TUI
// bundle resolved at RUN time as the highest-version installed Sterling, no
// sterling-update.bat. On the AUTHORING clone (.git present): unchanged shape,
// --plugin-dir <clone> and <clone>/tui/sterling-tui.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTmuxLauncher } from '../lib/launcher-tmux.mjs';
import { ensureUpdateLauncher, UPDATE_LAUNCHER_NAME } from '../lib/update-launcher.mjs';
import { renderConsumerCheckLauncher } from '../lib/consumer-checks.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const rm = (...ds) => ds.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const touch = (p, body = '') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };

/** A plugin root carrying the real tmux template; `git` decides authoring vs installed. */
function pluginRoot({ git }) {
  const root = tmp('sterling-lic-root-');
  mkdirSync(join(root, 'templates'));
  copyFileSync(join(REPO, 'templates', 'launcher-tmux.sh'), join(root, 'templates', 'launcher-tmux.sh'));
  if (git) mkdirSync(join(root, '.git'));
  return root;
}

const OPTS = { session: 'sterling-demo', splitPercent: 40 };

/** A Claude Code cache copy with its manifest (the resolver reads the version there) and a TUI bundle. */
function claudeCacheCopy(cache, mkt, version) {
  const dir = join(cache, mkt, 'sterling', version);
  touch(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version }));
  touch(join(dir, 'tui', 'sterling-tui.mjs'));
  return dir;
}

test('authoring clone: the tmux launcher keeps --plugin-dir <clone> and the clone TUI bundle', () => {
  const root = pluginRoot({ git: true });
  try {
    const out = renderTmuxLauncher(root, OPTS);
    assert.ok(out.includes(`PLUGIN_DIR="${root}"`), 'PLUGIN_DIR is the clone');
    assert.ok(out.includes(`TUI_BUNDLE="${root}/tui/sterling-tui.mjs"`), 'the TUI bundle is <clone>/tui/sterling-tui.mjs');
    assert.ok(out.includes('"$CLAUDE_BIN" --plugin-dir "$PLUGIN_DIR"'), 'claude still starts with --plugin-dir');
    assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}/, 'no placeholder left unresolved');
    assert.doesNotMatch(out, /plugins\/cache/, 'the authoring shape carries no cache resolution');
  } finally {
    rm(root);
  }
});

test('installed copy: the tmux launcher has no --plugin-dir and resolves the TUI from the plugin cache at run time', () => {
  const root = pluginRoot({ git: false });
  try {
    const out = renderTmuxLauncher(root, OPTS);
    assert.doesNotMatch(out, /--plugin-dir/, 'an installed plugin is already active: no --plugin-dir');
    assert.ok(!out.includes(root), 'nothing names the plugin root, which on an installed copy is a versioned cache directory');
    assert.match(out, /newestInstalledSterling\(\)/, 'the shared resolver picks the copy at run time');
    assert.match(out, /'tui', 'sterling-tui\.mjs'/, 'the TUI bundle is taken from the resolved copy');
    assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}/, 'no placeholder left unresolved');
  } finally {
    rm(root);
  }
});

// END TO END: run the rendered script with a fake tmux/claude/node on PATH and a fake
// home, recording what tmux was asked to run.
function runLauncher(script, mode, { home, extraEnv = {} }) {
  const work = tmp('sterling-lic-work-');
  const bin = tmp('sterling-lic-bin-');
  touch(join(work, '.sterling', 'sterling.db'));
  const log = join(work, 'tmux.log');
  const fakeTmux = join(bin, 'tmux');
  writeFileSync(fakeTmux, `#!/bin/sh\necho "$@" >> "${log}"\n[ "$1" = "has-session" ] && exit ${mode === 'tui' ? 0 : 1}\nexit 0\n`);
  chmodSync(fakeTmux, 0o755);
  const launcher = join(work, 'sterling-launch.sh');
  writeFileSync(launcher, script);
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CLAUDE_BIN: '/bin/true', ...extraEnv };
  const r = spawnSync('bash', [launcher, mode], { cwd: work, env, encoding: 'utf8', timeout: 30_000 });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return { r, calls, cleanup: () => rm(work, bin) };
}

test('installed copy, run time: the launcher picks the HIGHEST version (1.10.0 over 1.9.0 and over another marketplace\'s 0.2.0), by semver not by string', () => {
  const home = tmp('sterling-lic-home-');
  const root = pluginRoot({ git: false });
  let run;
  try {
    const cache = join(home, '.claude', 'plugins', 'cache');
    for (const [mkt, ver] of [['mkt-a', '1.9.0'], ['mkt-b', '1.10.0'], ['mkt-z', '0.2.0']]) claudeCacheCopy(cache, mkt, ver);
    run = runLauncher(renderTmuxLauncher(root, OPTS), 'tui', { home });
    assert.equal(run.r.status, 0, run.r.stderr);
    const split = run.calls.split('\n').find((l) => l.startsWith('split-window')) ?? '';
    assert.ok(split.includes(join(cache, 'mkt-b', 'sterling', '1.10.0', 'tui', 'sterling-tui.mjs')), `the newest version's bundle runs — got: ${split}`);
    assert.ok(!split.includes('1.9.0') && !split.includes('0.2.0'), 'no older version is used');
  } finally {
    run?.cleanup();
    rm(home, root);
  }
});

test('installed copy, run time: a newer copy in OpenCode\'s npm cache wins over the Claude Code cache', () => {
  const home = tmp('sterling-lic-home-');
  const root = pluginRoot({ git: false });
  let run;
  try {
    claudeCacheCopy(join(home, '.claude', 'plugins', 'cache'), 'mkt', '1.10.0');
    const npmCopy = join(home, '.cache', 'opencode', 'npm', '@chulf58', 'sterling@latest', '1759500000000', 'node_modules', '@chulf58', 'sterling');
    touch(join(npmCopy, 'package.json'), JSON.stringify({ name: '@chulf58/sterling', version: '1.11.0' }));
    touch(join(npmCopy, 'tui', 'sterling-tui.mjs'));
    run = runLauncher(renderTmuxLauncher(root, OPTS), 'tui', { home });
    assert.equal(run.r.status, 0, run.r.stderr);
    const split = run.calls.split('\n').find((l) => l.startsWith('split-window')) ?? '';
    assert.ok(split.includes(join(npmCopy, 'tui', 'sterling-tui.mjs')), `the OpenCode copy's bundle runs — got: ${split}`);
  } finally {
    run?.cleanup();
    rm(home, root);
  }
});

test('installed copy, run time: no installed Sterling version is a loud refusal naming the missing bundle, never a silent empty path', () => {
  const home = tmp('sterling-lic-home-');
  const root = pluginRoot({ git: false });
  let run;
  try {
    run = runLauncher(renderTmuxLauncher(root, OPTS), 'tui', { home });
    assert.notEqual(run.r.status, 0);
    assert.match(run.r.stderr, /no installed Sterling found under .*plugins.cache .*opencode.npm.* claude plugin install sterling@sterling/);
    assert.match(run.r.stderr, /TUI bundle missing/);
    assert.equal(run.calls, '', 'tmux was never asked to do anything');
  } finally {
    run?.cleanup();
    rm(home, root);
  }
});

test('installed copy, run time: a fresh session starts claude with no --plugin-dir; the authoring clone starts it with --plugin-dir <clone>', () => {
  const home = tmp('sterling-lic-home-');
  const installedRoot = pluginRoot({ git: false });
  const cloneRoot = pluginRoot({ git: true });
  const runs = [];
  try {
    claudeCacheCopy(join(home, '.claude', 'plugins', 'cache'), 'm', '2.0.0');
    touch(join(cloneRoot, 'tui', 'sterling-tui.mjs'));
    const installed = runLauncher(renderTmuxLauncher(installedRoot, OPTS), 'up', { home });
    runs.push(installed);
    assert.equal(installed.r.status, 0, installed.r.stderr);
    const newSession = (calls) => calls.split('\n').find((l) => l.startsWith('new-session')) ?? '';
    assert.doesNotMatch(newSession(installed.calls), /--plugin-dir/, 'installed: claude starts without --plugin-dir');

    const authoring = runLauncher(renderTmuxLauncher(cloneRoot, OPTS), 'up', { home });
    runs.push(authoring);
    assert.equal(authoring.r.status, 0, authoring.r.stderr);
    assert.ok(newSession(authoring.calls).includes(`--plugin-dir ${cloneRoot}`), `authoring: claude starts with --plugin-dir <clone> — got: ${newSession(authoring.calls)}`);
    assert.ok(authoring.calls.includes(`${cloneRoot}/tui/sterling-tui.mjs`), 'authoring: the TUI is the clone bundle');
  } finally {
    runs.forEach((x) => x.cleanup());
    rm(home, installedRoot, cloneRoot);
  }
});

test('ensureUpdateLauncher: an installed copy is skipped — no sterling-update.bat, no .gitignore entry; the authoring clone still gets one', () => {
  const installedRoot = pluginRoot({ git: false });
  const cloneRoot = pluginRoot({ git: true });
  const target = tmp('sterling-lic-target-');
  try {
    copyFileSync(join(REPO, 'templates', 'update-win.bat'), join(installedRoot, 'templates', 'update-win.bat'));
    copyFileSync(join(REPO, 'templates', 'update-win.bat'), join(cloneRoot, 'templates', 'update-win.bat'));
    const skipped = ensureUpdateLauncher(target, installedRoot);
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.detail, /installed plugin copy/);
    assert.ok(!existsSync(join(target, UPDATE_LAUNCHER_NAME)), 'the updater launcher is not generated');
    assert.ok(!existsSync(join(target, '.gitignore')), 'and its .gitignore entry is not appended either');
    assert.equal(ensureUpdateLauncher(target, cloneRoot).status, 'created', 'CONTROL: the same template on an authoring clone is generated');
  } finally {
    rm(installedRoot, cloneRoot, target);
  }
});

test('sterling-check.mjs: authoring bakes the clone path; installed bakes NO path and resolves the highest installed version at run time', () => {
  const baked = renderConsumerCheckLauncher(REPO, { installed: false });
  assert.ok(baked.includes(`const RAW_PLUGIN_DIR = ${JSON.stringify(REPO.replace(/\\/g, '/'))};`), 'authoring: the clone path is baked as before');

  const installed = renderConsumerCheckLauncher(REPO, { installed: true });
  assert.ok(installed.includes('const RAW_PLUGIN_DIR = newestInstalledPluginDir();'), 'installed: resolved at run time');
  assert.ok(!installed.includes(REPO.replace(/\\/g, '/')), 'installed: the plugin root is not baked anywhere');

  const home = tmp('sterling-lic-home-');
  const project = tmp('sterling-lic-project-');
  try {
    const cache = join(home, '.claude', 'plugins', 'cache', 'mkt', 'sterling');
    for (const v of ['1.9.0', '1.10.0']) {
      touch(join(cache, v, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: v }));
      for (const s of ['check-record-citations.mjs', 'check-stale-claims.mjs']) touch(join(cache, v, 'scripts', s), `console.log('STUB ' + import.meta.url);\n`);
    }
    writeFileSync(join(project, 'sterling-check.mjs'), installed);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CACHE_HOME: join(home, 'xdg') };
    const r = spawnSync(process.execPath, [join(project, 'sterling-check.mjs'), '--base', 'HEAD'], { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /STUB file:.*\/1\.10\.0\/scripts\/check-record-citations\.mjs/, 'the highest version ran the citation check');
    assert.doesNotMatch(r.stdout, /1\.9\.0/, 'the older version did not run');

    const empty = spawnSync(process.execPath, [join(project, 'sterling-check.mjs'), '--base', 'HEAD'], { cwd: project, env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'nothing-here'), XDG_CACHE_HOME: join(home, 'nothing-here') }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(empty.status, 3, 'no installed version: exit 3 (the check never ran)');
    assert.match(empty.stderr, /no installed Sterling found under .*plugins.cache .*opencode.npm/);
    assert.match(empty.stderr, /claude plugin install sterling@sterling .*opencode plugin add "github:Chulf58\/sterling#semver:>=0\.18\.0"/, 'generated from a copy under neither root: both remedies');

    // A newer copy in OpenCode's npm cache wins over the Claude Code cache's 1.10.0.
    const npmCopy = join(home, 'xdg', 'opencode', 'npm', '@chulf58', 'sterling@latest', '1759500000000', 'node_modules', '@chulf58', 'sterling');
    touch(join(npmCopy, 'package.json'), JSON.stringify({ name: '@chulf58/sterling', version: '1.11.0' }));
    for (const s of ['check-record-citations.mjs', 'check-stale-claims.mjs']) touch(join(npmCopy, 'scripts', s), `console.log('STUB ' + import.meta.url);\n`);
    const oc = spawnSync(process.execPath, [join(project, 'sterling-check.mjs'), '--base', 'HEAD'], { cwd: project, env: env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(oc.status, 0, oc.stdout + oc.stderr);
    assert.match(oc.stdout, /STUB file:.*\/node_modules\/@chulf58\/sterling\/scripts\/check-record-citations\.mjs/, 'the OpenCode copy ran');
  } finally {
    rm(home, project);
  }
});

test('sterling-check.mjs prefers <plugin>/bin/<check>.mjs over the scripts/ source when the plugin ships it', () => {
  const installed = renderConsumerCheckLauncher(REPO, { installed: true });
  const home = tmp('sterling-lic-home-');
  const project = tmp('sterling-lic-project-');
  try {
    const v = join(home, '.claude', 'plugins', 'cache', 'mkt', 'sterling', '3.0.0');
    touch(join(v, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '3.0.0' }));
    for (const s of ['check-record-citations.mjs', 'check-stale-claims.mjs']) {
      touch(join(v, 'bin', s), `console.log('BIN ' + import.meta.url);\n`);
      touch(join(v, 'scripts', s), `console.log('SOURCE ' + import.meta.url); process.exit(1);\n`);
    }
    writeFileSync(join(project, 'sterling-check.mjs'), installed);
    const r = spawnSync(process.execPath, [join(project, 'sterling-check.mjs'), '--base', 'HEAD'], { cwd: project, env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CACHE_HOME: join(home, 'xdg') }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /BIN file:.*\/bin\/check-record-citations\.mjs/);
    assert.match(r.stdout, /BIN file:.*\/bin\/check-stale-claims\.mjs/);
    assert.doesNotMatch(r.stdout, /SOURCE /, 'the scripts/ source never runs when a bundle exists');
  } finally {
    rm(home, project);
  }
});

test('sterling-check.mjs on an installed copy runs the REAL bundled checks with no node_modules anywhere', () => {
  // The stub fixtures above cannot see an import failure. Here the plugin cache holds
  // the committed bin/ bundles and the scripts/ tree (no node_modules, no packages/*/dist),
  // exactly what a /plugin install carries, and the checks must load and run.
  const installed = renderConsumerCheckLauncher(REPO, { installed: true });
  const home = tmp('sterling-lic-home-');
  const project = tmp('sterling-lic-project-');
  try {
    const v = join(home, '.claude', 'plugins', 'cache', 'mkt', 'sterling', '3.0.0');
    for (const s of ['check-record-citations.mjs', 'check-stale-claims.mjs']) touch(join(v, 'bin', s), readFileSync(join(REPO, 'bin', s)));
    cpSync(join(REPO, 'scripts'), join(v, 'scripts'), { recursive: true, filter: (src) => !src.includes(`${join(REPO, 'scripts', 'tests')}`) });
    cpSync(join(REPO, '.claude-plugin'), join(v, '.claude-plugin'), { recursive: true });
    const git = (...a) => spawnSync('git', a, { cwd: project, encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    writeFileSync(join(project, 'sterling-check.mjs'), installed);
    const r = spawnSync(process.execPath, [join(project, 'sterling-check.mjs'), '--base', 'HEAD'], { cwd: project, env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CACHE_HOME: join(home, 'xdg') }, encoding: 'utf8', timeout: 60_000 });
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/, `every check loaded: ${out}`);
    assert.notEqual(r.status, 3, `no check failed to run: ${out}`);
    // Both REAL checks ran their own logic on this bare project (no store, no declared
    // toolchain): citations skip for want of a store, and the stale-claim scan skips
    // loudly as capability_absent, which the launcher reports as exit 2, never 3.
    assert.match(out, /record citations: skipped \(no store\)/);
    assert.match(out, /check-stale-claims: SKIPPED LOUDLY — capability_absent/);
    assert.equal(r.status, 2, out);
  } finally {
    rm(home, project);
  }
});
