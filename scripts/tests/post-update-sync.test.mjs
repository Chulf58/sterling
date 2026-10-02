// POST-UPDATE SYNC under the newest-copy-wins rule (decision
// dual-host-post-update-sync-newest-copy-wins), shared by H1 and the Sterling
// OpenCode server plugin through scripts/lib/post-update-sync.mjs.
//
// The GOLDEN H1 outputs below were captured from the pre-extraction H1
// (scripts/hooks/h1-session-start.mjs at f71167b, built fresh through the seam
// harness) for the same fixtures, with the temp project and plugin paths
// replaced by <PROJECT> and <PLUGIN>. Every case except the new older-copy
// refusal is pinned byte for byte: systemMessage, additionalContext, the steps
// spawned and the marker left behind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';
import { compareVersions, parseVersion, postUpdateSync, runStepAsync } from '../lib/post-update-sync.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = '9.9.9-fixture';

let SterlingStore;
let seam;
let sync;
let notices;
const scratch = [];
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href));
  sync = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'sync.mjs')).href);
  notices = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'notices.mjs')).href);
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

// A script that appends its argv to $FIXTURE_LOG, prints `stdout` and exits with the named env code.
const LOGGING_SCRIPT = (name, stdout, exitEnv) =>
  `import { appendFileSync } from 'node:fs';\n` +
  `appendFileSync(process.env.FIXTURE_LOG, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n` +
  `process.stdout.write(${JSON.stringify(stdout)});\n` +
  `process.exit(Number(process.env.${exitEnv} ?? 0));\n`;

const RESTART_OUT = 'refreshed: implementor\n\nRESTART REQUIRED — project subagents load at session start.\n';

function makePluginRoot({ clone = false, bin = false, noVersion = false, version = VERSION, syncOut = RESTART_OUT, contractOut = 'stamp-contract: 1 already in sync — 1 project(s) processed\n' } = {}) {
  const dir = tmp('sterling-pus-plugin-');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(noVersion ? { name: 'sterling' } : { name: 'sterling', version }));
  if (clone) mkdirSync(join(dir, '.git'));
  const scriptDir = join(dir, bin ? 'bin' : 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'sync-agents.mjs'), LOGGING_SCRIPT('sync-agents', syncOut, 'FIXTURE_SYNC_EXIT'));
  writeFileSync(join(scriptDir, 'stamp-contract.mjs'), LOGGING_SCRIPT('stamp-contract', contractOut, 'FIXTURE_CONTRACT_EXIT'));
  return dir;
}

function makeProject({ marker = null, store = true } = {}) {
  const dir = tmp('sterling-pus-project-');
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  if (store) new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  if (marker === 'DIR') mkdirSync(join(dir, '.sterling', 'synced-version'));
  else if (marker !== null) writeFileSync(join(dir, '.sterling', 'synced-version'), `${marker}\n`);
  return dir;
}

function markerOf(project) {
  try {
    return readFileSync(join(project, '.sterling', 'synced-version'), 'utf8');
  } catch (e) {
    return e.code;
  }
}

function runH1(project, plugin, env = {}) {
  const log = join(tmp('sterling-pus-log-'), 'calls.log');
  const r = spawnSync(process.execPath, [seam.hookPath], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(project, 't.jsonl'), cwd: project, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    cwd: project,
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_CURRENCY_DISABLE: '1', STERLING_PLUGIN_ROOT: plugin, FIXTURE_LOG: log, ...env, HOME: tmp('sterling-pus-home-') },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const norm = (s) => s.split(project).join('<PROJECT>').split(plugin).join('<PLUGIN>');
  return {
    code: r.status,
    sys: norm(out.systemMessage ?? ''),
    ctx: norm(out.hookSpecificOutput?.additionalContext ?? ''),
    calls: existsSync(log) ? norm(readFileSync(log, 'utf8')).trim().split('\n') : [],
    marker: markerOf(project),
  };
}

const CASES = {
  'synced-restart': { marker: '0.0.1' },
  'synced-no-restart': { marker: '0.0.1', syncOut: 'up_to_date: implementor\n' },
  'first-run-bin': { marker: null, bin: true },
  'drift-tolerated': { marker: '0.0.1', env: { FIXTURE_CONTRACT_EXIT: '2' }, contractOut: 'DRIFT: CLAUDE.md differs\n' },
  'sync-fails': { marker: '0.0.1', env: { FIXTURE_SYNC_EXIT: '1' } },
  'sync-refused': { marker: '0.0.1', env: { FIXTURE_SYNC_EXIT: '2' } },
  'contract-fails-after-restart': { marker: '0.0.1', env: { FIXTURE_CONTRACT_EXIT: '1' }, contractOut: 'boom\n' },
  'contract-zero-projects': { marker: '0.0.1', contractOut: 'stamp-contract: — 0 project(s) processed\n' },
  'marker-unwritable': { marker: 'DIR' },
  'version-unreadable': { marker: '0.0.1', noVersion: true },
  'same-version': { marker: VERSION },
  'clone': { marker: '0.0.1', clone: true },
};

const GOLDEN = {
  "synced-restart": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling 0.0.1→9.9.9-fixture: agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "synced-no-restart": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling 0.0.1→9.9.9-fixture: agents synced, none changed. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced, none changed.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "first-run-bin": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/bin/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling (never synced)→9.9.9-fixture: agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/bin/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling (never synced)→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "drift-tolerated": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling 0.0.1→9.9.9-fixture: agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent. Contract drift in this project (stamp-contract dry run, tolerated): DRIFT: CLAUDE.md differs\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "sync-fails": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — sync-agents exited 1: refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — sync-agents exited 1: refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. No marker was written, so it retries at the next session start; tell the user and fix the cause.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "sync-refused": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — sync-agents REFUSED (exit 2 — a locally modified agent, an unsafe path, or a foreign or malformed .claude/settings.json): refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — sync-agents REFUSED (exit 2 — a locally modified agent, an unsafe path, or a foreign or malformed .claude/settings.json): refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. No marker was written, so it retries at the next session start; tell the user and fix the cause.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "contract-fails-after-restart": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — stamp-contract exited 1: boom. agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — stamp-contract exited 1: boom. No marker was written, so it retries at the next session start; tell the user and fix the cause. sync-agents DID refresh agents before the failure: RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --project <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "contract-zero-projects": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — stamp-contract checked NOTHING for <PROJECT> (0 project(s) processed) — the project is not reachable through the project registry; run /sterling:init here to register it. agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — stamp-contract checked NOTHING for <PROJECT> (0 project(s) processed) — the project is not reachable through the project registry; run /sterling:init here to register it. No marker was written, so it retries at the next session start; tell the user and fix the cause. sync-agents DID refresh agents before the failure: RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --project <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "marker-unwritable": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling (never synced)→9.9.9-fixture: agents synced, but <PROJECT>/.sterling/synced-version could not be written (EISDIR) — the sync re-runs every session until it can. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling (never synced)→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --project <PROJECT>"
    ],
    "marker": "EISDIR"
  },
  "version-unreadable": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling post-update sync SKIPPED — the installed plugin's version is unreadable (<PLUGIN>/.claude-plugin/plugin.json). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): SKIPPED — <PLUGIN>/.claude-plugin/plugin.json carries no readable version, so this project's agents cannot be known current.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [],
    "marker": "0.0.1\n"
  },
  "same-version": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [],
    "marker": "9.9.9-fixture\n"
  },
  "clone": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [],
    "marker": "0.0.1\n"
  }
};

for (const [name, c] of Object.entries(CASES)) {
  test(`H1 golden (pre-extraction bytes): ${name}`, () => {
    const plugin = makePluginRoot(c);
    const project = makeProject({ marker: c.marker });
    assert.deepEqual(runH1(project, plugin, c.env), GOLDEN[name]);
  });
}

test('H1, older copy: refuses with one loud line, spawns nothing and leaves the marker', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '10.0.0' });
  const r = runH1(project, plugin);
  assert.deepEqual(r.calls, []);
  assert.equal(r.marker, '10.0.0\n', 'the newer marker is never downgraded');
  assert.ok(
    r.sys.includes(`✗ Sterling ${VERSION} is OLDER than this project's sync marker 10.0.0: post-update sync REFUSED, nothing downgraded — update it through /plugin (Installed tab → Update). `),
    r.sys
  );
  assert.match(r.ctx, /POST-UPDATE SYNC REFUSED \(H1\): this Sterling copy is 9\.9\.9-fixture, older than this project's sync marker 10\.0\.0/);
  assert.equal(r.sys.split('\n').length, 1, 'the banner stays one line');
});

test('H1, equal by version order (build metadata differs): nothing runs, nothing is said', () => {
  const plugin = makePluginRoot({ version: '1.2.3+b1' });
  const project = makeProject({ marker: '1.2.3' });
  const r = runH1(project, plugin);
  assert.deepEqual(r.calls, []);
  assert.doesNotMatch(r.sys, /post-update|agents synced|REFUSED/);
});

test('H1, a marker that is not a version reads as never synced: it syncs and rewrites the marker', () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: 'garbage' });
  const r = runH1(project, plugin);
  assert.equal(r.calls.length, 2);
  assert.equal(r.marker, `${VERSION}\n`);
  assert.match(r.sys, /⚠ Sterling garbage→9\.9\.9-fixture: agents synced — RESTART/);
});

test('H1, a plugin version that is not semver: loud SKIP, nothing runs', () => {
  const plugin = makePluginRoot({ version: 'dev' });
  const project = makeProject({ marker: '0.0.1' });
  const r = runH1(project, plugin);
  assert.deepEqual(r.calls, []);
  assert.equal(r.marker, '0.0.1\n');
  assert.match(r.sys, /post-update sync SKIPPED — the installed plugin's version 'dev' is not a semver version/);
});

test('compareVersions: semver precedence, prerelease below release, build metadata ignored, null for non-versions', () => {
  const cases = [
    ['0.18.51', '0.18.50', 1],
    ['0.18.9', '0.18.10', -1],
    ['1.0.0', '0.99.99', 1],
    ['1.0.0', '1.0.0', 0],
    ['1.0.0+abc', '1.0.0', 0],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0-beta.11', 1],
    ['9.9.9-fixture', '0.0.1', 1],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(compareVersions(a, b), want, `${a} vs ${b}`);
    assert.equal(compareVersions(b, a), -want || 0, `${b} vs ${a}`);
  }
  assert.equal(compareVersions('dev', '1.0.0'), null);
  assert.equal(compareVersions('1.0', '1.0.0'), null);
  assert.equal(parseVersion('01.0.0'), null, 'leading zeros are not semver');
});

test('postUpdateSync, host opencode: the async runner syncs and the text names OpenCode, not the Claude Code CLI', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const log = join(tmp('sterling-pus-log-'), 'calls.log');
  process.env.FIXTURE_LOG = log;
  try {
    const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep: (root, name, args) => runStepAsync(root, name, args, { nodeBin: process.execPath }) });
    assert.equal(r.outcome, 'synced');
    assert.equal(markerOf(project), `${VERSION}\n`);
    assert.match(r.context, /^\n\nPOST-UPDATE SYNC \(OpenCode plugin\): Sterling 0\.0\.1→9\.9\.9-fixture — agents synced — RESTART to load them \(EXIT AND RELAUNCH OpenCode; a \/new is NOT enough\)\. RESTART REQUIRED — agents load when OpenCode starts/);
    assert.doesNotMatch(r.context, /Claude Code/);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`sync-agents --target ${project}`, `stamp-contract --project ${project}`]);
  } finally {
    delete process.env.FIXTURE_LOG;
  }
});

test('runStepAsync: a step past its exit code reports the status and the tail; a missing node binary is an error, not a hang', async () => {
  const plugin = makePluginRoot();
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  process.env.FIXTURE_SYNC_EXIT = '3';
  try {
    const r = await runStepAsync(plugin, 'sync-agents.mjs', ['--target', 'x']);
    assert.equal(r.status, 3);
    assert.equal(r.error, null);
    assert.match(r.tail, /RESTART REQUIRED/);
    const missing = await runStepAsync(plugin, 'sync-agents.mjs', [], { nodeBin: join(plugin, 'no-such-node') });
    assert.equal(missing.status, null);
    assert.match(missing.error, /ENOENT/);
  } finally {
    delete process.env.FIXTURE_LOG;
    delete process.env.FIXTURE_SYNC_EXIT;
  }
});

// ---- OpenCode: packages/opencode-plugin/src/sync.mjs ----

function sessionStub(sessions) {
  const calls = [];
  return {
    calls,
    get: async ({ sessionID }) => {
      calls.push(sessionID);
      const s = sessions[sessionID];
      if (s instanceof Error) throw s;
      if (!s) throw new Error(`no session ${sessionID}`);
      return { id: sessionID, ...s };
    },
  };
}

function ocSync(plugin, session, extra = {}) {
  return sync.createSessionSync({ sterlingRoot: plugin, getSession: () => session, now: () => '2026-10-02T12:00:00.000Z', nodeBin: process.execPath, ...extra });
}

const noticeTexts = (project) => {
  const p = join(project, notices.NOTICES_REL);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).map((n) => n.text) : [];
};

test('OpenCode sync: a child session does nothing; the first ROOT session syncs once and leaves a notice; session.get runs once per session', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const session = sessionStub({ ses_child: { parentID: 'ses_root' }, ses_root: {}, ses_next: {} });
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    const syncOnce = ocSync(plugin, session);
    await syncOnce(project, 'ses_child');
    await syncOnce(project, 'ses_child');
    await syncOnce.idle();
    assert.equal(markerOf(project), '0.0.1\n', 'a child session never syncs');
    assert.deepEqual(session.calls, ['ses_child'], 'the verdict is cached per session id');
    await syncOnce(project, 'ses_root');
    await syncOnce.idle();
    assert.equal(markerOf(project), `${VERSION}\n`);
    const texts = noticeTexts(project);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /^POST-UPDATE SYNC \(OpenCode plugin\): Sterling 0\.0\.1→9\.9\.9-fixture — agents synced — RESTART/);
    await syncOnce(project, 'ses_root');
    await syncOnce(project, 'ses_next');
    await syncOnce.idle();
    assert.deepEqual(session.calls, ['ses_child', 'ses_root'], 'latched after the first root session: no further lookups');
    assert.equal(readFileSync(process.env.FIXTURE_LOG, 'utf8').trim().split('\n').length, 2, 'the steps ran once');
  } finally {
    delete process.env.FIXTURE_LOG;
  }
});

test('OpenCode sync: the sync runs in the background, so the context request does not wait for it', async () => {
  const plugin = makePluginRoot();
  writeFileSync(join(plugin, 'scripts', 'sync-agents.mjs'), `setTimeout(() => process.exit(0), 1500);\n`);
  const project = makeProject({ marker: '0.0.1', store: false });
  const syncOnce = ocSync(plugin, sessionStub({ ses_root: {} }));
  const started = Date.now();
  await syncOnce(project, 'ses_root');
  assert.ok(Date.now() - started < 1000, `syncOnce returned after ${Date.now() - started} ms`);
  await syncOnce.idle();
});

test('OpenCode sync: an older copy leaves the refusal notice naming /sterling:update and writes nothing', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '10.0.0', store: false });
  const syncOnce = ocSync(plugin, sessionStub({ ses_root: {} }));
  await syncOnce(project, 'ses_root');
  await syncOnce.idle();
  assert.equal(markerOf(project), '10.0.0\n');
  const texts = noticeTexts(project);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^POST-UPDATE SYNC REFUSED \(OpenCode plugin\): this Sterling copy is 9\.9\.9-fixture, older than this project's sync marker 10\.0\.0/);
  assert.match(texts[0], /run \/sterling:update in OpenCode/);
});

test('OpenCode sync: equal versions add no notice and touch nothing', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: VERSION, store: false });
  const syncOnce = ocSync(plugin, sessionStub({ ses_root: {} }));
  await syncOnce(project, 'ses_root');
  await syncOnce.idle();
  assert.deepEqual(noticeTexts(project), []);
  assert.equal(existsSync(join(project, '.sterling', 'transient', 'opencode-plugin.log')), false);
});

test('OpenCode sync: a failed step is a notice, and no marker is written', async () => {
  const plugin = makePluginRoot();
  writeFileSync(join(plugin, 'scripts', 'sync-agents.mjs'), `process.stderr.write('kaput\\n'); process.exit(1);\n`);
  const project = makeProject({ marker: '0.0.1', store: false });
  const syncOnce = ocSync(plugin, sessionStub({ ses_root: {} }));
  await syncOnce(project, 'ses_root');
  await syncOnce.idle();
  assert.equal(markerOf(project), '0.0.1\n');
  const texts = noticeTexts(project);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^POST-UPDATE SYNC FAILED \(OpenCode plugin\): Sterling 0\.0\.1→9\.9\.9-fixture — sync-agents exited 1: kaput\. No marker was written, so it retries the next time OpenCode starts/);
});

test('OpenCode sync: a git clone never looks the session up and does nothing', async () => {
  const plugin = makePluginRoot({ clone: true });
  const project = makeProject({ marker: '0.0.1', store: false });
  const session = sessionStub({ ses_root: {} });
  const syncOnce = ocSync(plugin, session);
  await syncOnce(project, 'ses_root');
  await syncOnce.idle();
  assert.deepEqual(session.calls, []);
  assert.deepEqual(noticeTexts(project), []);
  assert.equal(markerOf(project), '0.0.1\n');
});

test('OpenCode sync: a failed session lookup is logged and noticed once for that session, and a later root session still syncs', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const session = sessionStub({ ses_bad: new Error('server gone'), ses_root: {} });
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    const syncOnce = ocSync(plugin, session);
    await syncOnce(project, 'ses_bad');
    await syncOnce(project, 'ses_bad');
    await syncOnce.idle();
    assert.deepEqual(session.calls, ['ses_bad']);
    const first = noticeTexts(project);
    assert.equal(first.length, 1);
    assert.match(first[0], /post-update sync could not check whether session ses_bad is a root session \(server gone\)/);
    assert.match(readFileSync(join(project, '.sterling', 'transient', 'opencode-plugin.log'), 'utf8'), /server gone/);
    await syncOnce(project, 'ses_root');
    await syncOnce.idle();
    assert.equal(markerOf(project), `${VERSION}\n`);
  } finally {
    delete process.env.FIXTURE_LOG;
  }
});
