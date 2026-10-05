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
// 2026-10-03: the Project mode line in every golden was re-cut and a Handoff files
// line added after it (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting): the
// mode line no longer says the OpenCode and handoff files follow the mode.
// 2026-10-03, review round 2: the Handoff files line in every golden was re-cut
// again. The fixture config has no handoff key and its project is not a git work
// tree, so the line now reads OFF (not set), which an explicit false does not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';
import { compareVersions, parseVersion, postUpdateSync, runStepAsync } from '../lib/post-update-sync.mjs';
import { sterlingRootLine } from '../hooks/lib/operating-state.mjs';
import { renderClaudeText } from '../lib/agent-fences.mjs';

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
  // Every Sterling copy ships domains.mjs, and H1 runs it before the sync when one is due
  // (scripts/hooks/lib/domain-notice.mjs). This one reports a map with no proposal and logs
  // nothing, so the goldens keep pinning the post-update sync's own bytes and calls; the
  // domain notice is pinned in scripts/tests/domain-map-after-update.test.mjs.
  writeFileSync(join(scriptDir, 'domains.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify({ proposal: { add: [], sibling_steps: [] } }))});\n`);
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

// The goldens pin the post-update part of H1's output from before the extraction, so the one line
// H1 later gained, STERLING ROOT, is taken out of ctx before comparing: exactly one occurrence of
// its exact text, or the case fails. The harness runs a seam-built bundle in a marker-free temp
// dir, so the walk-up finds no plugin root and the line is the constant UNRESOLVED text (the seam
// value is never printed). Every other byte still has to match. Its presence and content are
// asserted by the exactly-one check below in every case, and its content by scripts/tests/h1-sterling-root-line.test.mjs.
const ROOT_LINE_BLOCK = `\n\n${sterlingRootLine(null)}`;
function withoutRootLine(ctx) {
  const parts = ctx.split(ROOT_LINE_BLOCK);
  assert.equal(parts.length, 2, 'H1 prints exactly one STERLING ROOT line');
  return parts.join('');
}

// The goldens pin bytes from before H1 gained its Codex registration line. The fixture's user-level
// Claude config registers a `codex` server, so that line stays out of ctx and the pinned bytes are
// unchanged. CLAUDE_CONFIG_DIR is pinned to the same dir so a developer's own value cannot leak in.
function runH1(project, plugin, env = {}) {
  const log = join(tmp('sterling-pus-log-'), 'calls.log');
  const home = tmp('sterling-pus-home-');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { codex: { command: 'codex', args: ['mcp-server'] } } }));
  const r = spawnSync(process.execPath, [seam.hookPath], {
    input: JSON.stringify({ session_id: 's1', transcript_path: join(project, 't.jsonl'), cwd: project, hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    cwd: project,
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_CURRENCY_DISABLE: '1', STERLING_PLUGIN_ROOT: plugin, FIXTURE_LOG: log, ...env, HOME: home, CLAUDE_CONFIG_DIR: home },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const norm = (s) => s.split(project).join('<PROJECT>').split(plugin).join('<PLUGIN>');
  return {
    code: r.status,
    sys: norm(out.systemMessage ?? ''),
    ctx: withoutRootLine(norm(out.hookSpecificOutput?.additionalContext ?? '')),
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
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "synced-no-restart": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling 0.0.1→9.9.9-fixture: agents synced, none changed. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced, none changed.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "first-run-bin": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/bin/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling (never synced)→9.9.9-fixture: agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/bin/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling (never synced)→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "drift-tolerated": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling 0.0.1→9.9.9-fixture: agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent. Contract drift in this project (stamp-contract, tolerated): DRIFT: CLAUDE.md differs\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "sync-fails": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — sync-agents exited 1: refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — sync-agents exited 1: refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. No marker was written, so it retries at the next session start; tell the user and fix the cause.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "sync-refused": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — sync-agents REFUSED (exit 2 — a locally modified agent, an unsafe path, a foreign or malformed .claude/settings.json, or a project mode or handoff setting it could not read): refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — sync-agents REFUSED (exit 2 — a locally modified agent, an unsafe path, a foreign or malformed .claude/settings.json, or a project mode or handoff setting it could not read): refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. No marker was written, so it retries at the next session start; tell the user and fix the cause.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "contract-fails-after-restart": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — stamp-contract exited 1: boom. agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — stamp-contract exited 1: boom. No marker was written, so it retries at the next session start; tell the user and fix the cause. sync-agents DID refresh agents before the failure: RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "contract-zero-projects": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — stamp-contract checked NOTHING for <PROJECT> (0 project(s) processed) — the project is not reachable through the project registry; run /sterling:init here to register it. agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — stamp-contract checked NOTHING for <PROJECT> (0 project(s) processed) — the project is not reachable through the project registry; run /sterling:init here to register it. No marker was written, so it retries at the next session start; tell the user and fix the cause. sync-agents DID refresh agents before the failure: RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "marker-unwritable": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling (never synced)→9.9.9-fixture: agents synced, but <PROJECT>/.sterling/synced-version could not be written (EISDIR) — the sync re-runs every session until it can. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling (never synced)→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "EISDIR"
  },
  "version-unreadable": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling post-update sync SKIPPED — the installed plugin's version is unreadable (<PLUGIN>/.claude-plugin/plugin.json). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): SKIPPED — <PLUGIN>/.claude-plugin/plugin.json carries no readable version, so this project's agents cannot be known current.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [],
    "marker": "0.0.1\n"
  },
  "same-version": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [],
    "marker": "9.9.9-fixture\n"
  },
  "clone": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nProject mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
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

test('postUpdateSync: stamp-contract exit 2 with 0 projects processed and a refusal is a failed step naming the refusal, and the marker is not advanced', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const refusal = `✗ ${project}: not_migrated (no AGENTS.md)`;
  const contractOut = `${refusal}\n\nDRY-RUN (no writes; pass --apply) — 0 project(s) processed, 0 already in sync, 1 refusal(s).\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs'
      ? { status: 0, error: null, out: 'up_to_date: implementor', tail: 'up_to_date: implementor' }
      : { status: 2, error: null, out: contractOut, tail: contractOut.trim().split('\n').slice(-8).join(' | ') };
  const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep });
  assert.equal(r.outcome, 'failed');
  assert.match(r.warning, /checked NOTHING/);
  assert.ok(r.warning.includes('not_migrated (no AGENTS.md)'), r.warning);
  assert.ok(r.context.includes('No marker was written'), r.context);
  assert.equal(markerOf(project), '0.0.1\n');
});

test('postUpdateSync: stamp-contract exit 2 with some projects processed is still tolerated drift and the marker advances', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const out = `✗ ${project}: HAND_TUNED_REFUSED\n\nDRY-RUN (no writes; pass --apply) — 1 project(s) processed, 0 already in sync, 1 refusal(s).\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs' ? { status: 0, error: null, out: '', tail: '' } : { status: 2, error: null, out, tail: out.trim() };
  const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep });
  assert.equal(r.outcome, 'synced');
  assert.equal(markerOf(project), `${VERSION}\n`);
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
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`sync-agents --target ${project}`, `stamp-contract --apply-inserts --project ${project}`]);
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

test('OpenCode sync: a project init left with no synced-version marker (0.18.59, OpenCode-only machine) reads as never synced: the first root session syncs it and writes the marker', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: null, store: false });
  const session = sessionStub({ ses_root: {} });
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    assert.equal(markerOf(project), 'ENOENT', 'precondition: no marker');
    const syncOnce = ocSync(plugin, session);
    await syncOnce(project, 'ses_root');
    await syncOnce.idle();
    assert.equal(markerOf(project), `${VERSION}\n`, 'the marker is written once both steps succeed');
    const texts = noticeTexts(project);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Sterling \(never synced\)→9\.9\.9-fixture — agents synced/);
  } finally {
    delete process.env.FIXTURE_LOG;
  }
});

test('OpenCode sync: the latch is per project, so one process syncs each project it serves once', async () => {
  const plugin = makePluginRoot();
  const first = makeProject({ marker: '0.0.1', store: false });
  const second = makeProject({ marker: '0.0.1', store: false });
  const session = sessionStub({ ses_1: {}, ses_2: {}, ses_3: {} });
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    const started = new Set();
    // Two locations of one process: each builds its own sync, both share the per-project latch.
    const syncA = ocSync(plugin, session, { started });
    const syncB = ocSync(plugin, session, { started });
    await syncA(first, 'ses_1');
    await syncB(second, 'ses_2');
    await syncB(first, 'ses_3');
    await syncA.idle();
    await syncB.idle();
    assert.equal(markerOf(first), `${VERSION}\n`, 'the first project synced');
    assert.equal(markerOf(second), `${VERSION}\n`, 'the second project synced too, not latched out by the first');
    assert.equal(noticeTexts(first).length, 1, 'the first project synced once, though two locations reached it');
    assert.equal(readFileSync(process.env.FIXTURE_LOG, 'utf8').trim().split('\n').length, 4, 'the steps ran once per project');
  } finally {
    delete process.env.FIXTURE_LOG;
  }
});

test('OpenCode sync: inside the maintenance worker child (STERLING_MAINTENANCE_WORKER=1) the sync never runs and looks nothing up', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const session = sessionStub({ ses_worker: {} });
  const syncOnce = ocSync(plugin, session, { env: { ...process.env, STERLING_MAINTENANCE_WORKER: '1' } });
  await syncOnce(project, 'ses_worker');
  await syncOnce.idle();
  assert.equal(markerOf(project), '0.0.1\n', 'the worker child leaves the sync to the parent process');
  assert.deepEqual(session.calls, [], 'no session lookup');
  assert.deepEqual(noticeTexts(project), []);
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

test('OpenCode sync: an older copy leaves the refusal notice naming the update route and writes nothing', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '10.0.0', store: false });
  const syncOnce = ocSync(plugin, sessionStub({ ses_root: {} }), { env: {}, home: tmp('sterling-pus-home-') });
  await syncOnce(project, 'ses_root');
  await syncOnce.idle();
  assert.equal(markerOf(project), '10.0.0\n');
  const texts = noticeTexts(project);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^POST-UPDATE SYNC REFUSED \(OpenCode plugin\): this Sterling copy is 9\.9\.9-fixture, older than this project's sync marker 10\.0\.0/);
  // The old expectation pinned "run /sterling:update in OpenCode", which cannot update an
  // installed copy: the npm copy's route is `opencode plugin update` (decision 66d04413).
  assert.match(texts[0], /update it with `opencode plugin update "github:Chulf58\/sterling#semver:>=0\.18\.0"`/);
  assert.doesNotMatch(texts[0], /\/sterling:update/);
});

// The refusal names the route of the host that INSTALLED the copy, not the host asking:
// on a dual-host machine OpenCode can run a Claude-cache copy and H1 an npm copy.
test('older copy: the refusal names the installing host\'s update route, whichever host asks', async () => {
  const home = tmp('sterling-pus-home-');
  const place = (rel) => {
    const src = makePluginRoot();
    const dest = join(home, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    return dest;
  };
  const claudeCopy = place(join('.claude', 'plugins', 'cache', 'sterling', 'sterling', VERSION));
  const npmCopy = place(join('.cache', 'opencode', 'npm', '@chulf58', 'sterling@latest', '1759500000000', 'node_modules', '@chulf58', 'sterling'));
  const refusal = async (root, host) => (await postUpdateSync({ root, project: makeProject({ marker: '10.0.0', store: false }), host, env: {}, home })).context;
  assert.match(await refusal(claudeCopy, 'opencode'), /update this host's Sterling: update it through \/plugin \(Installed tab → Update\)\./);
  assert.match(await refusal(npmCopy, 'claude'), /update this host's Sterling: update it with `opencode plugin update "github:Chulf58\/sterling#semver:>=0\.18\.0"`\./);
  assert.match(await refusal(npmCopy, 'opencode'), /`opencode plugin update "github:Chulf58\/sterling#semver:>=0\.18\.0"`/);
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

// An installed copy laid out where OpenCode's npm cache keeps `opencode plugin add`'s package.
function makeNpmCopy(home, version) {
  const plugin = join(home, '.cache', 'opencode', 'npm', '@chulf58', 'sterling@latest', 'node_modules', '@chulf58', 'sterling');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version }));
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@chulf58/sterling', version }));
  mkdirSync(join(plugin, 'scripts'), { recursive: true });
  writeFileSync(join(plugin, 'scripts', 'sync-agents.mjs'), `process.exit(0);\n`);
  writeFileSync(join(plugin, 'scripts', 'stamp-contract.mjs'), `process.exit(0);\n`);
  mkdirSync(join(plugin, 'opencode', 'sterling-tui'), { recursive: true });
  writeFileSync(join(plugin, 'opencode', 'sterling-tui', 'package.json'), JSON.stringify({ name: 'sterling-tui', type: 'module' }));
  writeFileSync(join(plugin, 'opencode', 'sterling-tui', 'sterling-tui.bundle.tsx'), `export default { id: "dash-${version}" };\n`);
  return plugin;
}

test('OpenCode sync, npm copy: the sync re-materializes the dashboard and its rows are in the notice', async () => {
  const home = tmp('sterling-pus-home-');
  const plugin = makeNpmCopy(home, '2.0.0');
  const project = makeProject({ marker: '1.0.0', store: false });
  const syncOnce = ocSync(plugin, sessionStub({ ses_root: {} }), { env: {}, home });
  await syncOnce(project, 'ses_root');
  await syncOnce.idle();
  assert.equal(markerOf(project), '2.0.0\n');
  const dest = join(home, '.sterling', 'opencode', 'tui', '2.0.0');
  assert.equal(readFileSync(join(dest, 'sterling-tui.bundle.tsx'), 'utf8'), 'export default { id: "dash-2.0.0" };\n');
  const texts = noticeTexts(project);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^POST-UPDATE SYNC \(OpenCode plugin\): Sterling 1\.0\.0→2\.0\.0 — agents synced, none changed\./);
  assert.ok(texts[0].includes(`OpenCode created: ${dest.replace(/\\/g, '/')}/`), texts[0]);
});

test('OpenCode sync, npm copy: a refused dashboard copy is a REFUSED row in the notice, and the sync still lands', async () => {
  const home = tmp('sterling-pus-home-');
  const plugin = makeNpmCopy(home, '2.0.0');
  const dest = join(home, '.sterling', 'opencode', 'tui', '2.0.0');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'mine.txt'), 'not Sterling\n');
  const project = makeProject({ marker: '1.0.0', store: false });
  const syncOnce = ocSync(plugin, sessionStub({ ses_root: {} }), { env: {}, home });
  await syncOnce(project, 'ses_root');
  await syncOnce.idle();
  assert.equal(markerOf(project), '2.0.0\n');
  assert.equal(readFileSync(join(dest, 'mine.txt'), 'utf8'), 'not Sterling\n');
  const texts = noticeTexts(project);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /OpenCode refused: .*\/tui\/2\.0\.0\/ — .*Sterling did not write it/);
});

test('OpenCode sync, a copy outside the npm cache: no dashboard is materialized', async () => {
  const home = tmp('sterling-pus-home-');
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    const syncOnce = ocSync(plugin, sessionStub({ ses_root: {} }), { env: {}, home });
    await syncOnce(project, 'ses_root');
    await syncOnce.idle();
    assert.equal(markerOf(project), `${VERSION}\n`);
    assert.equal(existsSync(join(home, '.sterling')), false);
    assert.doesNotMatch(noticeTexts(project)[0], /OpenCode (created|matches|refreshed|refused)/);
  } finally {
    delete process.env.FIXTURE_LOG;
  }
});

// ---- OpenCode: the domain map notice (scripts/hooks/lib/domain-notice.mjs), same rule as H1 ----

const PENDING_REL = join('.sterling', 'domain-map-pending');
// Replaces the fixture root's no-proposal domains.mjs with one that proposes 'salesforce'.
function proposeSalesforce(plugin) {
  const map = { proposal: { add: [{ domain: 'salesforce', reason: 'its own subject' }], sibling_steps: [] } };
  writeFileSync(join(plugin, 'scripts', 'domains.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify(map))});\n`);
}
const DOMAIN_NOTICE = /^DOMAIN MAP \(OpenCode plugin, once after the Sterling update\): the map proposes adding 'salesforce'[^\n]*\/sterling:domains/m;

test('OpenCode sync: the session whose sync succeeds carries the domain map line, once; a failed sync holds it back', async () => {
  const plugin = makePluginRoot();
  proposeSalesforce(plugin);
  const project = makeProject({ marker: '0.0.1', store: false });
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    process.env.FIXTURE_SYNC_EXIT = '1';
    const failing = ocSync(plugin, sessionStub({ ses_root: {} }));
    await failing(project, 'ses_root');
    await failing.idle();
    assert.equal(noticeTexts(project).length, 1);
    assert.match(noticeTexts(project)[0], /^POST-UPDATE SYNC FAILED/);
    assert.doesNotMatch(noticeTexts(project)[0], /DOMAIN MAP/, 'no domain line until the sync succeeds');
    delete process.env.FIXTURE_SYNC_EXIT;

    // A new plugin process: the sync is still due, and now succeeds.
    const synced = ocSync(plugin, sessionStub({ ses_root: {} }));
    await synced(project, 'ses_root');
    await synced.idle();
    const texts = noticeTexts(project);
    assert.equal(texts.length, 2, 'the sync notice and the domain line are one notice');
    assert.match(texts[1], /^POST-UPDATE SYNC \(OpenCode plugin\)/);
    assert.match(texts[1], DOMAIN_NOTICE);
    assert.match(texts[1], /Nothing was applied/);

    // The next process: versions are equal, so nothing is due and nothing is said.
    const later = ocSync(plugin, sessionStub({ ses_root: {} }));
    await later(project, 'ses_root');
    await later.idle();
    assert.equal(noticeTexts(project).length, 2);
  } finally {
    delete process.env.FIXTURE_SYNC_EXIT;
    delete process.env.FIXTURE_LOG;
  }
});

test('OpenCode sync: on a clone, the pending file /sterling:update left is read by the first ROOT session, which prints the line and removes the file', async () => {
  const plugin = makePluginRoot({ clone: true });
  proposeSalesforce(plugin);
  const project = makeProject({ marker: '0.0.1', store: false });
  writeFileSync(join(project, PENDING_REL), '2026-10-04T00:00:00.000Z\n');
  const session = sessionStub({ ses_child: { parentID: 'ses_root' }, ses_root: {} });
  const syncOnce = ocSync(plugin, session);
  await syncOnce(project, 'ses_child');
  await syncOnce.idle();
  assert.ok(existsSync(join(project, PENDING_REL)), 'a child session leaves the file');
  assert.deepEqual(noticeTexts(project), []);

  await syncOnce(project, 'ses_root');
  await syncOnce.idle();
  assert.ok(!existsSync(join(project, PENDING_REL)), 'the root session that prints the line removes the file');
  const texts = noticeTexts(project);
  assert.equal(texts.length, 1);
  assert.match(texts[0], DOMAIN_NOTICE);
  assert.equal(markerOf(project), '0.0.1\n', 'a clone still runs no post-update sync');

  const next = ocSync(plugin, sessionStub({ ses_root: {} }));
  await next(project, 'ses_root');
  await next.idle();
  assert.equal(noticeTexts(project).length, 1, 'once');
});

test('OpenCode sync: the maintenance worker child never reads the pending file or runs the map', async () => {
  const plugin = makePluginRoot({ clone: true });
  proposeSalesforce(plugin);
  const project = makeProject({ marker: '0.0.1', store: false });
  writeFileSync(join(project, PENDING_REL), '2026-10-04T00:00:00.000Z\n');
  const session = sessionStub({ ses_worker: {} });
  const syncOnce = ocSync(plugin, session, { env: { ...process.env, STERLING_MAINTENANCE_WORKER: '1' } });
  await syncOnce(project, 'ses_worker');
  await syncOnce.idle();
  assert.ok(existsSync(join(project, PENDING_REL)), 'the file is left for the user\'s own session');
  assert.deepEqual(session.calls, []);
  assert.deepEqual(noticeTexts(project), []);
});

// An existing project's instruction files: the current templates rendered, minus the Domains
// section, with one tracked bullet (Anti-speculation) in an older template wording.
const STALE_ANTI_SPEC = '- **Anti-speculation:** never invent an API, field, flag, or behavior. Verify in docs or code first. If you cannot verify, say so and ask.';
function writeOldContractFiles(dir) {
  const render = (rel) =>
    renderClaudeText(readFileSync(join(repo, rel), 'utf8'), rel)
      .replaceAll('{{PROJECT_NAME}}', 'fixture')
      .replaceAll('{{STACK_TAGS}}', 'sterling')
      .replaceAll('{{TOOLCHAINS}}', 'node (**/*.mjs)')
      .replaceAll('{{LINT_COMMAND}}', 'not recorded yet; add it here')
      .replaceAll('{{DOMAINS}}', '~/.sterling/domains/sterling/')
      .replaceAll('{{BACKUP_PATH}}', '(opted out — recorded)')
      .replaceAll('{{CONVENTIONS_SECTION}}', '(nothing yet)');
  const agents = render('templates/target-agents-md.md')
    .replace(/## Domains\n[\s\S]*?(?=## Conventions)/, '')
    .replace(/^- \*\*Anti-speculation:\*\*.*$/m, STALE_ANTI_SPEC);
  writeFileSync(join(dir, 'AGENTS.md'), agents);
  writeFileSync(join(dir, 'CLAUDE.md'), render('templates/target-claude-md.md'));
  return agents;
}

test('post-update sync: an existing project gains the Domains section with no --apply, old wording stays, the insert is surfaced, and a second sync writes nothing', async () => {
  const { ProjectRegistry } = await import(pathToFileURL(join(repo, 'packages', 'store', 'dist', 'index.js')).href);
  const plugin = makePluginRoot({ syncOut: 'up_to_date: implementor\n' });
  // The fixture root's stamp-contract is the real one, run from the repo it belongs to.
  writeFileSync(join(plugin, 'scripts', 'stamp-contract.mjs'), `await import(${JSON.stringify(pathToFileURL(join(repo, 'scripts', 'stamp-contract.mjs')).href)});\n`);
  const project = makeProject({ marker: '0.0.1' });
  const before = writeOldContractFiles(project);
  const savedRegistry = process.env.STERLING_REGISTRY_DB;
  process.env.STERLING_REGISTRY_DB = join(tmp('sterling-pus-registry-'), 'registry.db');
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    const registry = new ProjectRegistry(process.env.STERLING_REGISTRY_DB);
    try {
      registry.register({ repo_path: project, name: 'fixture', stack_tags: [], toolchains: [], sterling_version: null, at: '2026-10-01T00:00:00.000Z' });
    } finally {
      registry.close();
    }
    assert.ok(!before.includes('## Domains'));
    const first = await postUpdateSync({ root: plugin, project, host: 'claude' });
    assert.equal(first.outcome, 'synced', first.context);
    const after = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    assert.match(after, /## Domains\n\n- \*\*A domain is a shared knowledge store for one subject\.\*\*/);
    assert.ok(after.includes(STALE_ANTI_SPEC), 'the old-wording bullet is not rewritten');
    assert.match(first.context, /stamp-contract inserted new text[^\n]*section_inserted ## Domains/);
    assert.match(first.warning, /1 insert/);

    writeFileSync(join(project, '.sterling', 'synced-version'), '0.0.1\n');
    const second = await postUpdateSync({ root: plugin, project, host: 'claude' });
    assert.equal(second.outcome, 'synced', second.context);
    assert.doesNotMatch(second.context, /inserted/);
    assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), after, 'a second sync writes nothing');
  } finally {
    delete process.env.FIXTURE_LOG;
    if (savedRegistry === undefined) delete process.env.STERLING_REGISTRY_DB;
    else process.env.STERLING_REGISTRY_DB = savedRegistry;
  }
});

test('OpenCode sync: on a clone, a pending file written while OpenCode runs is read by the next root session', async () => {
  const plugin = makePluginRoot({ clone: true });
  proposeSalesforce(plugin);
  const project = makeProject({ marker: '0.0.1', store: false });
  const syncOnce = ocSync(plugin, sessionStub({ ses_1: {}, ses_2: {} }));
  await syncOnce(project, 'ses_1');
  await syncOnce.idle();
  assert.deepEqual(noticeTexts(project), []);

  writeFileSync(join(project, PENDING_REL), '2026-10-04T00:00:00.000Z\n');
  await syncOnce(project, 'ses_2');
  await syncOnce.idle();
  assert.equal(noticeTexts(project).length, 1, 'the clone branch did not latch');
  assert.match(noticeTexts(project)[0], DOMAIN_NOTICE);
  assert.ok(!existsSync(join(project, PENDING_REL)));
});

test('OpenCode sync: a pending file that cannot be removed is said once; the root is latched so the map and the notice do not repeat', async () => {
  const plugin = makePluginRoot({ clone: true });
  // A map script that counts its runs (the notice store drops a repeated text, so the notice count alone proves nothing).
  const runsLog = join(tmp('sterling-pus-log-'), 'map-runs.log');
  const map = { proposal: { add: [{ domain: 'salesforce', reason: 'its own subject' }], sibling_steps: [] } };
  writeFileSync(join(plugin, 'scripts', 'domains.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(runsLog)}, 'run\\n');\nprocess.stdout.write(${JSON.stringify(JSON.stringify(map))});\n`);
  const mapRuns = () => readFileSync(runsLog, 'utf8').trim().split('\n').length;
  const project = makeProject({ marker: '0.0.1', store: false });
  // A non-empty directory where the file would be: rmSync without recursive refuses it.
  mkdirSync(join(project, PENDING_REL));
  writeFileSync(join(project, PENDING_REL, 'x'), '');
  const syncOnce = ocSync(plugin, sessionStub({ ses_1: {}, ses_2: {} }));
  await syncOnce(project, 'ses_1');
  await syncOnce.idle();
  assert.equal(noticeTexts(project).length, 1);
  assert.match(noticeTexts(project)[0], /domain-map-pending could not be removed/);
  assert.equal(mapRuns(), 1);
  await syncOnce(project, 'ses_2');
  await syncOnce.idle();
  assert.equal(mapRuns(), 1, 'the map is not run again for the next session in this process');
  assert.equal(noticeTexts(project).length, 1);
});
