// H1 on a /plugin-INSTALLED Sterling (decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone, slices S3 and S5):
//   - the POST-UPDATE branch (design point B): plugin.json's version against
//     <project>/.sterling/synced-version; on a difference, sync-agents and a
//     stamp-contract dry run for THIS project, the marker, a RESTART banner; on a
//     failure, a loud banner and NO marker so the next session retries;
//   - the STORE-VERSION PROBE (ruling point 1): a user_version mismatch prints the
//     paste-ready migrate command and never migrates;
//   - the MACHINE ROLE text for an installed copy;
//   - the stale-server guard reading mcp/.build-id beside the bundled server.
//
// The hook is a FRESH seam bundle (scripts/tests/lib/seam-hook.mjs), so the
// STERLING_PLUGIN_ROOT seam names a fixture plugin root: one WITHOUT .git is an
// installed copy, one with .git is a clone. The fixture's sync-agents,
// stamp-contract and migrate-stores scripts only log their argv.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildSeamHook } from './lib/seam-hook.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = '9.9.9-fixture';

let SterlingStore;
let seam;
const scratch = [];
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  seam = await buildSeamHook('h1-session-start.mjs');
});
after(() => {
  seam?.cleanup();
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

// A script that appends its argv to $FIXTURE_LOG and exits with the named env code.
const LOGGING_SCRIPT = (name, stdout, exitEnv) =>
  `import { appendFileSync } from 'node:fs';\n` +
  `appendFileSync(process.env.FIXTURE_LOG, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n` +
  `process.stdout.write(${JSON.stringify(stdout)});\n` +
  `process.exit(Number(process.env.${exitEnv} ?? 0));\n`;

function makePluginRoot({ clone = false, bin = false } = {}) {
  const dir = tmp('sterling-h1pu-plugin-');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: VERSION }));
  if (clone) mkdirSync(join(dir, '.git'));
  const scriptDir = join(dir, bin ? 'bin' : 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'sync-agents.mjs'), LOGGING_SCRIPT(bin ? 'bin/sync-agents' : 'sync-agents', 'refreshed: implementor\n\nRESTART REQUIRED — project subagents load at session start.\n', 'FIXTURE_SYNC_EXIT'));
  writeFileSync(join(scriptDir, 'stamp-contract.mjs'), LOGGING_SCRIPT(bin ? 'bin/stamp-contract' : 'stamp-contract', 'stamp-contract: 1 already in sync — 1 project(s) processed\n', 'FIXTURE_CONTRACT_EXIT'));
  writeFileSync(join(scriptDir, 'migrate-stores.mjs'), LOGGING_SCRIPT('migrate-stores', '', 'FIXTURE_MIGRATE_EXIT'));
  return dir;
}

function makeProject({ syncedVersion = null } = {}) {
  const dir = tmp('sterling-h1pu-project-');
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  if (syncedVersion !== null) writeFileSync(join(dir, '.sterling', 'synced-version'), `${syncedVersion}\n`);
  return dir;
}

function setUserVersion(dbPath, v) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${v}`);
  db.close();
}

function runH1(project, pluginRoot, env = {}) {
  const home = env.HOME ?? tmp('sterling-h1pu-home-');
  const log = join(tmp('sterling-h1pu-log-'), 'calls.log');
  const r = spawnSync(process.execPath, [seam.hookPath], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(project, 't.jsonl'), cwd: project, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    cwd: project,
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_CURRENCY_DISABLE: '1', STERLING_PLUGIN_ROOT: pluginRoot, FIXTURE_LOG: log, ...env, HOME: home },
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // callers assert on the parsed output
  }
  return {
    code: r.status,
    stderr: r.stderr,
    sys: out?.systemMessage ?? '',
    ctx: out?.hookSpecificOutput?.additionalContext ?? '',
    calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
  };
}

const markerOf = (project) => {
  const p = join(project, '.sterling', 'synced-version');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
};

test('version change on an installed copy: syncs THIS project only, writes the marker, prints the RESTART banner', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ syncedVersion: '0.0.1' });
  const r = runH1(project, plugin);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [`sync-agents --target ${project}`, `stamp-contract --project ${project}`], 'sync-agents for this project, then a stamp-contract DRY run (no --apply) for this project');
  assert.equal(markerOf(project), VERSION);
  assert.match(r.sys, new RegExp(`Sterling 0\\.0\\.1→${VERSION.replace(/\./g, '\\.')}: agents synced — RESTART`));
  assert.match(r.ctx, /EXIT AND RELAUNCH/);
});

test('first run (no marker) syncs; the bundled bin/ scripts win over scripts/ when present', () => {
  const plugin = makePluginRoot({ bin: true });
  const project = makeProject();
  const r = runH1(project, plugin);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [`bin/sync-agents --target ${project}`, `bin/stamp-contract --project ${project}`]);
  assert.equal(markerOf(project), VERSION);
  assert.ok(r.ctx.includes(`node '${plugin}'/bin/sync-agents.mjs --target '${project}'`), `the CONDUCTOR NOT ACTIVE remedy names the bundled script: ${r.ctx}`);
});

test('same version: nothing is spawned and nothing is said', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ syncedVersion: VERSION });
  const r = runH1(project, plugin);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.doesNotMatch(r.sys, /agents synced|post-update sync/i);
});

test('sync failure: NO marker (the next session retries) and a loud banner', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ syncedVersion: '0.0.1' });
  const r = runH1(project, plugin, { FIXTURE_SYNC_EXIT: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(markerOf(project), '0.0.1', 'the marker is untouched');
  assert.match(r.sys, /✗ Sterling 0\.0\.1→.*post-update sync FAILED/);
  assert.match(r.ctx, /sync-agents exited 1/);
  assert.match(r.ctx, /retries at the next session start/);
});

test('stamp-contract that checked nothing (0 projects) is a failure too: no marker', () => {
  const plugin = makePluginRoot();
  writeFileSync(join(plugin, 'scripts', 'stamp-contract.mjs'), LOGGING_SCRIPT('stamp-contract', 'stamp-contract: — 0 project(s) processed\n', 'FIXTURE_CONTRACT_EXIT'));
  const project = makeProject({ syncedVersion: '0.0.1' });
  const r = runH1(project, plugin);
  assert.equal(markerOf(project), '0.0.1');
  assert.match(r.sys, /post-update sync FAILED/);
  assert.match(r.ctx, /checked NOTHING/);
});

test('a git clone (authoring or consumer) never runs the post-update branch — /sterling:update owns it there', () => {
  const plugin = makePluginRoot({ clone: true });
  const project = makeProject({ syncedVersion: '0.0.1' });
  const r = runH1(project, plugin);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.equal(markerOf(project), '0.0.1');
});

test('installed copy: the MACHINE ROLE line says INSTALLED PLUGIN, updates via /plugin — never /sterling:update', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ syncedVersion: VERSION });
  const r = runH1(project, plugin);
  assert.match(r.ctx, /MACHINE ROLE: INSTALLED PLUGIN \(consumer\) — updates via \/plugin/);
  assert.doesNotMatch(r.ctx, /consumes via \/sterling:update/);
  const clone = runH1(project, makePluginRoot({ clone: true }));
  assert.doesNotMatch(clone.ctx, /INSTALLED PLUGIN/, 'a clone keeps its existing role text');
});

test('store user_version mismatch: a domain store behind prints the paste-ready migrate command and never migrates', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ syncedVersion: VERSION });
  const home = tmp('sterling-h1pu-home-');
  const domainDb = join(home, '.sterling', 'domains', 'node', 'sterling.db');
  mkdirSync(dirname(domainDb), { recursive: true });
  new SterlingStore(domainDb).close();
  setUserVersion(domainDb, 1);
  const r = runH1(project, plugin, { HOME: home });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [], 'the probe never spawns migrate-stores');
  assert.match(r.sys, /store schema/i);
  assert.ok(r.sys.includes(`node '${join(plugin, 'scripts', 'migrate-stores.mjs')}' --db '${domainDb}'`), r.sys);
  const db = new DatabaseSync(domainDb);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1, 'nothing migrated');
  db.close();
});

test('store user_version mismatch on the PROJECT store: the migrate line prints and H1 carries on (an older store opens read-only)', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ syncedVersion: VERSION });
  const projectDb = join(project, '.sterling', 'sterling.db');
  setUserVersion(projectDb, 1);
  const r = runH1(project, plugin);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.ok(r.sys.includes(`--db '${projectDb}'`), r.sys);
  assert.match(r.sys, /maintenance item/, 'the normal banner still follows');
  const db = new DatabaseSync(projectDb);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1, 'nothing migrated');
  db.close();
});

test('a NEWER project store: H1 exits cleanly with the line instead of crashing on the refused open', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ syncedVersion: VERSION });
  const projectDb = join(project, '.sterling', 'sterling.db');
  setUserVersion(projectDb, 99);
  const r = runH1(project, plugin);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.sys, /v99, NEWER than this Sterling's v2 — update the plugin/);
});

test('a store held open in WAL mode (the MCP server, concurrently) is read from its WAL: no false mismatch', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ syncedVersion: VERSION });
  const fresh = join(project, '.sterling', 'sterling.db');
  rmSync(fresh);
  const held = new SterlingStore(fresh); // stays open: user_version 2 lives in the WAL, the main header still reads 0
  try {
    const r = runH1(project, plugin);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.sys, /store schema/i, r.sys);
  } finally {
    held.close();
  }
});

test('stale-server guard reads mcp/.build-id beside the bundled server when mcp/ exists', async () => {
  const plugin = makePluginRoot();
  mkdirSync(join(plugin, 'mcp'));
  writeFileSync(join(plugin, 'mcp', 'sterling-mcp.mjs'), '// fixture\n');
  writeFileSync(join(plugin, 'mcp', '.build-id'), 'BUNDLED-MCP-BUILD-ID\n');
  const project = makeProject({ syncedVersion: VERSION });
  const decoyScript = join(project, 'fixture-mcp-server-decoy.mjs');
  writeFileSync(decoyScript, 'setInterval(() => {}, 60_000);\n');
  const decoy = spawn(process.execPath, [decoyScript], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    mkdirSync(join(project, '.sterling', 'transient'), { recursive: true });
    writeFileSync(join(project, '.sterling', 'transient', 'mcp-runtime.json'), JSON.stringify({ build_id: 'OLD-RUNNING-ID', pid: decoy.pid, booted_at: new Date().toISOString() }));
    const r = runH1(project, plugin);
    assert.match(r.sys, /STALE — running build OLD-RUNNING-ID, current BUNDLED-MCP-BUILD-ID/);
  } finally {
    decoy.kill();
  }
});
