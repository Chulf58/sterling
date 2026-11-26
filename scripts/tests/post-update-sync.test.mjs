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
// 2026-11-19 (settings redesign item C): the Project mode line became the Workflow line.
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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative as relativePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';
import { cloneAgentSync, compareVersions, parseVersion, postUpdateSync, runPostUpdateSteps, runStepAsync } from '../lib/post-update-sync.mjs';
import { toCanonicalConfig } from '@sterling/schemas';
import { describeCanonicalChanges } from '../lib/config-migration.mjs';
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

// A clone fixture has a main branch and is checked out on it unless `head` says
// otherwise: the clone agent sync reads .git/HEAD and runs on the base branch only.
// head: null leaves the HEAD file out; mainBranch: false is a clone with no main.
const HEAD_MAIN = 'ref: refs/heads/main\n';

function makePluginRoot({ clone = false, head = HEAD_MAIN, mainBranch = true, bin = false, noVersion = false, version = VERSION, syncOut = RESTART_OUT, contractOut = 'stamp-contract: 1 already in sync — 1 project(s) processed\n' } = {}) {
  const dir = tmp('sterling-pus-plugin-');
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(noVersion ? { name: 'sterling' } : { name: 'sterling', version }));
  if (clone) {
    mkdirSync(join(dir, '.git'));
    if (head !== null) writeFileSync(join(dir, '.git', 'HEAD'), head);
    if (mainBranch) {
      mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
      writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), `${'0'.repeat(40)}\n`);
    }
  }
  mkdirSync(join(dir, 'templates'), { recursive: true });
  writeFileSync(join(dir, 'templates', 'claude-session-block.md'), `${CLAUDE_BLOCK_FIXTURE}\n`);
  const scriptDir = join(dir, bin ? 'bin' : 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'sync-agents.mjs'), LOGGING_SCRIPT('sync-agents', syncOut, 'FIXTURE_SYNC_EXIT'));
  writeFileSync(join(scriptDir, 'stamp-contract.mjs'), LOGGING_SCRIPT('stamp-contract', contractOut, 'FIXTURE_CONTRACT_EXIT'));
  // Every Sterling copy ships domains.mjs, and H1 runs it before the sync when one is due
  // (scripts/hooks/lib/domain-notice.mjs). This one reports a map with no proposal and logs
  // nothing, so the goldens keep pinning the post-update sync's own bytes and calls; the
  // domain notice is pinned in scripts/tests/domain-map-after-update.test.mjs.
  writeFileSync(join(scriptDir, 'domains.mjs'), `process.stdout.write(${JSON.stringify(JSON.stringify({ proposal: { add: [], sibling_steps: [] } }))});\n`);
  // Every Sterling copy ships retire-host-files.mjs, the sync's last step (GitHub #329). This one
  // removes nothing and logs nothing, so the goldens keep pinning the sync's own calls; the step
  // itself is pinned by the runPostUpdateSteps tests below.
  writeFileSync(join(scriptDir, 'retire-host-files.mjs'), 'process.exit(Number(process.env.FIXTURE_RETIRE_EXIT ?? 0));\n');
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
// H1 appends the Claude Code layer block (templates/claude-session-block.md) to every Claude Code
// session. The goldens pin the post-update sync's own bytes, so the fixture block is cut out of the
// context here, and a test below pins that it was delivered.
const CLAUDE_BLOCK_FIXTURE = 'FIXTURE CLAUDE CODE LAYER BLOCK';
function withoutClaudeBlock(ctx) {
  const parts = ctx.split(`\n\n${CLAUDE_BLOCK_FIXTURE}`);
  assert.equal(parts.length, 2, 'H1 delivers the Claude Code layer block exactly once');
  return parts.join('');
}
function withoutRootLine(ctx) {
  const parts = ctx.split(ROOT_LINE_BLOCK);
  assert.equal(parts.length, 2, 'H1 prints exactly one STERLING ROOT line');
  return parts.join('');
}

// The goldens pin bytes from before H1 gained its Codex registration line. The fixture's user-level
// Claude config registers a `codex` server, so that line stays out of ctx and the pinned bytes are
// unchanged. CLAUDE_CONFIG_DIR is pinned to the same dir so a developer's own value cannot leak in.
function runH1(project, plugin, env = {}, { rawContext = false } = {}) {
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
    ctx: rawContext ? norm(out.hookSpecificOutput?.additionalContext ?? '') : withoutClaudeBlock(withoutRootLine(norm(out.hookSpecificOutput?.additionalContext ?? ''))),
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
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "synced-no-restart": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling 0.0.1→9.9.9-fixture: agents synced, none changed. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced, none changed.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "first-run-bin": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/bin/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling (never synced)→9.9.9-fixture: agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/bin/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling (never synced)→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "drift-tolerated": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling 0.0.1→9.9.9-fixture: agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling 0.0.1→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent. Contract drift in this project (stamp-contract, tolerated): DRIFT: CLAUDE.md differs\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "9.9.9-fixture\n"
  },
  "sync-fails": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — sync-agents exited 1: refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — sync-agents exited 1: refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. No marker was written, so it retries at the next session start; tell the user and fix the cause.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "sync-refused": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — sync-agents REFUSED (exit 2 — a locally modified agent, an unsafe path, a foreign or malformed .claude/settings.json, or a project mode or handoff setting it could not read): refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — sync-agents REFUSED (exit 2 — a locally modified agent, an unsafe path, a foreign or malformed .claude/settings.json, or a project mode or handoff setting it could not read): refreshed: implementor |  | RESTART REQUIRED — project subagents load at session start.. No marker was written, so it retries at the next session start; tell the user and fix the cause. sync-agents DID refresh agents before the failure: RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "contract-fails-after-restart": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — stamp-contract exited 1: boom. agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — stamp-contract exited 1: boom. No marker was written, so it retries at the next session start; tell the user and fix the cause. sync-agents DID refresh agents before the failure: RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "contract-zero-projects": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling 0.0.1→9.9.9-fixture: post-update sync FAILED — stamp-contract checked NOTHING for <PROJECT> (0 project(s) processed) — the project is not reachable through the project registry; run /sterling:init here to register it. agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC FAILED (H1): Sterling 0.0.1→9.9.9-fixture — stamp-contract checked NOTHING for <PROJECT> (0 project(s) processed) — the project is not reachable through the project registry; run /sterling:init here to register it. No marker was written, so it retries at the next session start; tell the user and fix the cause. sync-agents DID refresh agents before the failure: RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "0.0.1\n"
  },
  "marker-unwritable": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ✗ Sterling (never synced)→9.9.9-fixture: agents synced, but <PROJECT>/.sterling/synced-version could not be written (EISDIR) — the sync re-runs every session until it can. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): Sterling (never synced)→9.9.9-fixture — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). RESTART REQUIRED — project subagents load at session start: EXIT AND RELAUNCH the Claude Code CLI before dispatching any agent.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [
      "sync-agents --target <PROJECT>",
      "stamp-contract --apply-inserts --project <PROJECT>"
    ],
    "marker": "EISDIR"
  },
  "version-unreadable": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. ⚠ Sterling post-update sync SKIPPED — the installed plugin's version is unreadable (<PLUGIN>/.claude-plugin/plugin.json). 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nPOST-UPDATE SYNC (H1): SKIPPED — <PLUGIN>/.claude-plugin/plugin.json carries no readable version, so this project's agents cannot be known current.\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [],
    "marker": "0.0.1\n"
  },
  "same-version": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nMACHINE ROLE: INSTALLED PLUGIN (consumer) — updates via /plugin (Installed tab → Update); /sterling:update refuses on an installed copy. Never edit the installed plugin files; Sterling work lands on the authoring machine.\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
    "calls": [],
    "marker": "9.9.9-fixture\n"
  },
  "clone": {
    "code": 0,
    "sys": "⚠ CONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH. 0 tasks · 0 maintenance items pending",
    "ctx": "\n\nCONDUCTOR NOT ACTIVE: settings key missing — run `node '<PLUGIN>'/scripts/sync-agents.mjs --target '<PROJECT>'` then EXIT AND RELAUNCH\n\nTDD posture: tests-first ON (config.tdd.enabled — TUI System tab; explicit asks still work)\n\nWorkflow: merge path DIRECT · Reviewers: 1 · Copilot loop: OFF (config.workflow — TUI System tab) — work ships by direct merge through /sterling:merge. Run 1 task-end reviewer, then one fix round and one re-check.\n\nHandoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.\n\nStorage: SQLITE (config.storage not set, so SQLite — TUI System tab; switch with the move-store skill)\n\nUNDECLARED SOURCE CHECK UNAVAILABLE: git ls-files exited 128",
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

test('H1 delivers the Claude Code layer block on Claude Code, and says so loudly when the block cannot be read', () => {
  const project = makeProject({ marker: '0.0.1' });
  const plugin = makePluginRoot();
  assert.equal(runH1(project, plugin, {}, { rawContext: true }).ctx.split(CLAUDE_BLOCK_FIXTURE).length, 2);
  unlinkSync(join(plugin, 'templates', 'claude-session-block.md'));
  const missing = runH1(project, plugin, {}, { rawContext: true }).ctx;
  assert.match(missing, /STERLING LAYER \(Claude Code\): the Claude Code rules block could not be read/);
});

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

// Review loop 7 of #329: stamp-contract prints a skipped project (a stale registry path) on a `– `
// line, not a ✗ refusal; for the session's own project that is still a run that checked nothing,
// and the failure names the skip line.
test('postUpdateSync: stamp-contract exit 0 with 0 projects processed and a skip line is a failed step naming the skip, and the marker is not advanced', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const skip = `– p (${project}/AGENTS.md): skipped — the registered path does not exist (a stale registry entry); nothing stamped`;
  const contractOut = `${skip}\n\nINSERTS APPLIED — 0 project(s) processed, 0 already in sync, 0 refusal(s).\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs'
      ? { status: 0, error: null, out: 'up_to_date: implementor', tail: 'up_to_date: implementor' }
      : { status: 0, error: null, out: contractOut, tail: contractOut.trim().split('\n').slice(-8).join(' | ') };
  const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep });
  assert.equal(r.outcome, 'failed');
  assert.match(r.warning, /checked NOTHING/);
  assert.ok(r.warning.includes('skipped — the registered path does not exist'), r.warning);
  assert.equal(markerOf(project), '0.0.1\n');
});

test('postUpdateSync: stamp-contract exit 2 with some projects processed is still tolerated drift and the marker advances', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const out = `✗ ${project}: HAND_TUNED_REFUSED\n\nDRY-RUN (no writes; pass --apply) — 1 project(s) processed, 0 already in sync, 1 refusal(s).\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs' ? { status: 0, error: null, out: '', tail: '' } : name === 'retire-host-files.mjs' ? { status: 0, error: null, out: '', tail: '' } : { status: 2, error: null, out, tail: out.trim() };
  const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep });
  assert.equal(r.outcome, 'synced');
  assert.equal(markerOf(project), `${VERSION}\n`);
});

test('postUpdateSync: a SIMILAR_BULLET_KEPT line from stamp-contract is named in the context as kept, and is never reported as an insert', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const kept = "- **Finish what you start.**… — kept the project's own bullet in AGENTS.md, nothing inserted: - **Never stop with work half done.** Our own wording.";
  const out = `• ${project} (AGENTS.md + CLAUDE.md)\n    SIMILAR_BULLET_KEPT  ${kept}\n\nINSERTS APPLIED (new text only; existing wording is never replaced without --apply) — 1 project(s) processed, 0 already in sync, 0 refusal(s).\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs' ? { status: 0, error: null, out: '', tail: '' } : { status: 0, error: null, out, tail: '' };
  const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep });
  assert.equal(r.outcome, 'synced', r.context);
  assert.ok(r.context.includes(`stamp-contract kept the project's own bullets where they already state a Sterling rule, inserting nothing: ${kept}.`), r.context);
  assert.doesNotMatch(r.context, /stamp-contract inserted/);
  assert.doesNotMatch(r.warning, /gained new Sterling text/);
});

// The retired-models-key drops (board c45a4507) reach the user through the banner and the
// model-facing context, and are never agent changes (no restart owed for them alone).
const DROP_LINE = 'config migration: models.coder dropped (ignored since the roster rename to models.implementor); value was {"model":"claude-opus-5","effort":"high"}; set models.implementor in the System tab if you want it';

test('postUpdateSync: dropped retired models keys are named in the banner and the context with their values, and owe no restart', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const out = `up_to_date: implementor\n${DROP_LINE}\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs' ? { status: 0, error: null, out, tail: out } : { status: 0, error: null, out: 'stamp-contract: 1 already in sync — 1 project(s) processed', tail: '' };
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'synced', r.context);
  assert.match(r.warning, /agents synced, none changed\. \.sterling\/config\.json lost 1 retired models key \(/, r.warning);
  assert.doesNotMatch(r.warning, /RESTART/, 'a dropped key alone owes no restart');
  assert.ok(r.context.includes('models.coder dropped (ignored since the roster rename to models.implementor); value was {"model":"claude-opus-5","effort":"high"}'), r.context);
  assert.doesNotMatch(r.context, /RESTART REQUIRED/);
});

test('cloneAgentSync: dropped retired models keys are named in the banner and the context', async () => {
  const plugin = makePluginRoot({ clone: true });
  const project = makeProject({ marker: null, store: false });
  const out = `up_to_date: implementor\n${DROP_LINE}\n`;
  const { runStep } = recordingSteps({ 'sync-agents.mjs': { status: 0, error: null, out, tail: out } });
  const r = await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep });
  assert.equal(r.outcome, 'synced', r.context);
  assert.match(r.warning, /lost 1 retired models key \(/, r.warning);
  assert.ok(r.context.includes('value was {"model":"claude-opus-5","effort":"high"}'), r.context);
});

// The canonical conversion of the legacy Overpass keys (config-migration.mjs) is built here from the real
// toCanonicalConfig output, never hand-written receipt lines (GitHub #322). Active Overpass: a custom tier,
// effort and conductor bypass move into config.models and routing is kept. Inactive: the legacy keys are
// only removed and no models entry is written.
const receipts = (legacy) => describeCanonicalChanges(toCanonicalConfig(legacy).changes);
const ACTIVE_LINES = receipts({ mode: 'work', overpass: { enabled: true, conductor_bypass: true, roles: { reviewer: { tier: 'agentic-premium', effort: 'max' } } }, models: { scout: { model: 'claude-sonnet-5-5', effort: 'low' } } });
const HOBBY_LINES = receipts({ mode: 'hobby', overpass: { enabled: true } });
const SHAPE_ONLY_LINES = receipts({ mode: 'work' });
const INACTIVE_LINES = receipts({ mode: 'work', overpass: { enabled: false, roles: { reviewer: { tier: 'agentic-premium' } } } });
const HARD_MOVE_LINE = 'config migration: models.implementor.hard_task {"model":"claude-opus-5-5"} moved to models.implementor-hard as {"model":"claude-opus-5-5","effort":"high"}, the sterling/implementor-hard agent\'s model; change it in the System tab';
const overpassLines = (lines) => lines.filter((l) => /^config migration: (overpass\.|models\.[^\s.]+ set to \{"model":"overpass\/)/.test(l));
const RETIRED_OK = /retired models key|no model changed|reset|changes model routing/;

async function syncWith(lines, host = 'claude') {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const out = `up_to_date: implementor\n${lines.join('\n')}\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs' ? { status: 0, error: null, out, tail: out } : { status: 0, error: null, out: 'stamp-contract: 1 already in sync — 1 project(s) processed', tail: '' };
  const r = await postUpdateSync({ root: plugin, project, host, runStep });
  assert.equal(r.outcome, 'synced', r.context);
  return r;
}

test('postUpdateSync: an active Overpass conversion is one grouped, routing-preserving message that includes its models entries', async () => {
  const conversion = overpassLines(ACTIVE_LINES);
  assert.ok(conversion.some((l) => /models\.reviewer set to \{"model":"overpass\/agentic-premium","effort":"max"\}/.test(l)), 'real receipts carry the custom tier and effort');
  assert.ok(conversion.some((l) => /overpass\.conductor_bypass removed \(value was true\)/.test(l)));
  const r = await syncWith(ACTIVE_LINES);
  assert.match(r.warning, new RegExp(`legacy Overpass settings converted to per-agent models entries \\(${conversion.length} steps\\); the tiers, efforts and conductor bypass in use are kept, so routing is unchanged\\.`), r.warning);
  assert.doesNotMatch(r.warning, RETIRED_OK, r.warning);
  assert.match(r.context, /converted the legacy Overpass settings in \.sterling\/config\.json .* routing did not change and nothing needs restoring/);
  for (const l of conversion) assert.ok(r.context.includes(l.replace(/^config migration: /, '')), l);
  assert.match(r.warning, /had 1 other config migration step applied/, 'only the unrelated scout normalisation is an other step; the conversion entries are not counted a second time');
  assert.ok(!r.context.match(/other config migration step[^]*models\.reviewer set to/), 'the conversion entries are not in the other-steps list');
});

test('postUpdateSync: an inactive Overpass (enabled false, saved override) is a removal of unused settings, with no models entries claimed', async () => {
  assert.ok(!INACTIVE_LINES.some((l) => /models\./.test(l)), 'real receipts write no models entries when Overpass was off');
  const r = await syncWith(INACTIVE_LINES);
  assert.match(r.warning, /had legacy Overpass settings removed \(2 steps\); no Overpass models entries were written, so routing is unchanged\./, r.warning);
  assert.doesNotMatch(r.warning, /converted|per-agent models entries|other config migration step/, r.warning);
  assert.match(r.warning, /1 settings-shape step applied|2 settings-shape steps applied/, 'workflow and mode get their own clause');
  assert.match(r.context, /removed legacy Overpass settings .*without writing any Overpass models entries.*routing is unchanged/);
  assert.doesNotMatch(r.context, /converted the legacy|nothing needs restoring|other config migration step/, r.context);
  assert.ok(r.context.includes('overpass.roles removed (value was {"reviewer":{"tier":"agentic-premium"}})'), r.context);
});

test('postUpdateSync: enabled:true in hobby mode writes no Overpass entries, so it is a removal, never a conversion', async () => {
  assert.ok(!HOBBY_LINES.some((l) => /^config migration: models\./.test(l)), 'real receipts write no models entries in hobby mode');
  assert.ok(HOBBY_LINES.some((l) => /overpass\.enabled removed \(value was true\)/.test(l)));
  const r = await syncWith(HOBBY_LINES);
  assert.match(r.warning, /had legacy Overpass settings removed \(1 step\); no Overpass models entries were written, so routing is unchanged\./, r.warning);
  assert.doesNotMatch(r.warning, /converted|per-agent models entries|other config migration step/, r.warning);
  assert.doesNotMatch(r.context, /converted the legacy|nothing needs restoring/, r.context);
});

test('postUpdateSync: a workflow/mode-only migration is reported on its own line and claims no model change', async () => {
  assert.ok(SHAPE_ONLY_LINES.length > 0 && SHAPE_ONLY_LINES.every((l) => !/^config migration: (models|overpass)\./.test(l)), 'real receipts for {mode:"work"} are workflow and mode only');
  const r = await syncWith(SHAPE_ONLY_LINES);
  assert.match(r.warning, /had 2 settings-shape steps applied \(workflow and mode only, not model settings\)\./, r.warning);
  assert.doesNotMatch(r.warning, /pin|Overpass|retired/, r.warning);
  for (const l of SHAPE_ONLY_LINES) assert.ok(r.context.includes(l.replace(/^config migration: /, '')), l);
  assert.doesNotMatch(r.context, /can change model pins/, r.context);
});

test('postUpdateSync: an unrelated models change next to the conversion keeps the pin-change note and a retired-key drop keeps its own text', async () => {
  const unrelated = ACTIVE_LINES.filter((l) => /models\.scout\.model set to/.test(l));
  assert.equal(unrelated.length, 1, 'real receipts include the unrelated provider-prefix normalisation');
  const r = await syncWith([DROP_LINE, HARD_MOVE_LINE, ...ACTIVE_LINES]);
  assert.match(r.warning, /\.sterling\/config\.json lost 1 retired models key \(ignored before, so no model changed\)\. /, 'the retired-key clause counts only the drop');
  assert.match(r.warning, /legacy Overpass settings converted/);
  assert.match(r.warning, /had 2 other config migration steps applied \(model entries or the implementor-hard move\), which can change model pins\./, 'the hard_task move and the unrelated models change');
  assert.ok(r.context.includes('sync-agents removed 1 retired models key from .sterling/config.json (they were already ignored, so no model changed); tell the user, because the values are no longer in the file: models.coder dropped'), r.context);
  assert.ok(r.context.includes(`which can change model pins; tell the user: ${[HARD_MOVE_LINE, ...unrelated].map((l) => l.replace(/^config migration: /, '')).join('; ')}.`), r.context);
});

test('cloneAgentSync: the Overpass conversion is described as routing-preserving', async () => {
  const plugin = makePluginRoot({ clone: true });
  const project = makeProject({ marker: null, store: false });
  const out = `up_to_date: implementor\n${ACTIVE_LINES.join('\n')}\n`;
  const { runStep } = recordingSteps({ 'sync-agents.mjs': { status: 0, error: null, out, tail: out } });
  const r = await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep });
  assert.equal(r.outcome, 'synced', r.context);
  assert.match(r.warning, /legacy Overpass settings converted/, r.warning);
  assert.doesNotMatch(r.warning, /retired models key|no model changed|reset/, r.warning);
});

// A failure after the drop must still carry the receipts: the values are gone from the file and the
// refusal's last-eight-lines `tail` does not hold them.
const DROP_OUT = `up_to_date: implementor\n${DROP_LINE}\n`;
const failureSteps = {
  'a sync-agents refusal after the drop': (runStepFor) => runStepFor({
    'sync-agents.mjs': { status: 2, error: null, out: `${DROP_OUT}locally_modified: scout\n`, tail: 'locally_modified: scout' },
  }),
  'a stamp-contract failure after the drop': (runStepFor) => runStepFor({
    'sync-agents.mjs': { status: 0, error: null, out: DROP_OUT, tail: DROP_OUT },
    'stamp-contract.mjs': { status: 1, error: null, out: 'boom', tail: 'boom' },
  }),
};
for (const [label, make] of Object.entries(failureSteps)) {
  const stepsFor = (results) => async (root, name) => results[name] ?? { status: 0, error: null, out: '', tail: '' };
  test(`postUpdateSync: ${label} still names the dropped retired models keys with their values, and writes no marker`, async () => {
    const plugin = makePluginRoot();
    const project = makeProject({ marker: '0.0.1', store: false });
    const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep: make(stepsFor) });
    assert.equal(r.outcome, 'failed', r.context);
    assert.equal(markerOf(project), '0.0.1\n', 'no marker advance on failure');
    assert.match(r.warning, /\.sterling\/config\.json lost 1 retired models key \(/, r.warning);
    assert.ok(r.context.includes('value was {"model":"claude-opus-5","effort":"high"}'), r.context);
  });

  test(`cloneAgentSync: ${label} still names the dropped retired models keys with their values`, async () => {
    const plugin = makePluginRoot({ clone: true });
    const project = makeProject({ marker: null, store: false });
    const r = await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep: make(stepsFor) });
    assert.equal(r.outcome, 'failed', r.context);
    assert.match(r.warning, /\.sterling\/config\.json lost 1 retired models key \(/, r.warning);
    assert.ok(r.context.includes('value was {"model":"claude-opus-5","effort":"high"}'), r.context);
  });
}

// CLONE AGENT SYNC (user-ruled 2026-10-06, "Sync at session start (Recommended)"): the
// same two steps on a git clone, triggered by H1's agent-currency hash compare and
// never recorded in the version marker. The H1 end of it, with the real syncAgents, is
// pinned in scripts/tests/agent-currency-h1.test.mjs.
function recordingSteps(results = {}) {
  const calls = [];
  const runStep = async (root, name, args) => {
    calls.push(`${name} ${args.join(' ')}`);
    return results[name] ?? (name === 'sync-agents.mjs'
      ? { status: 0, error: null, out: 'refreshed: implementor\n\nRESTART REQUIRED — project subagents load at session start.', tail: 'refreshed: implementor' }
      : { status: 0, error: null, out: 'stamp-contract: 1 already in sync — 1 project(s) processed', tail: '' });
  };
  return { calls, runStep };
}

test('cloneAgentSync: an installed copy is not a clone, so nothing runs and nothing is said', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const { calls, runStep } = recordingSteps();
  assert.equal(await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep }), null);
  assert.deepEqual(calls, []);
});

test('cloneAgentSync: a clone runs both steps for the project and never writes or moves the version marker', async () => {
  const plugin = makePluginRoot({ clone: true });
  for (const marker of [null, VERSION, '0.0.1']) {
    const project = makeProject({ marker, store: false });
    const before = markerOf(project);
    const { calls, runStep } = recordingSteps();
    const r = await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep });
    assert.equal(r.outcome, 'synced');
    assert.deepEqual(calls, [`sync-agents.mjs --target ${project}`, `stamp-contract.mjs --apply-inserts --project ${project}`, `retire-host-files.mjs --target ${project}`]);
    assert.equal(markerOf(project), before, `marker ${marker} is left as it was: an installed copy newer than it still runs its own sync`);
    assert.equal(r.warning, '⚠ Sterling clone: installed agents were behind its templates (implementor.md) — agents synced — RESTART to load them (EXIT AND RELAUNCH; a /clear is NOT enough). ');
    assert.ok(r.context.startsWith("\n\nCLONE AGENT SYNC (H1): this project's installed agents were behind the clone's templates (implementor.md) — agents synced — RESTART to load them"), r.context);
    assert.ok(r.context.includes('sync-agents reported: refreshed: implementor.'), r.context);
  }
});

test('cloneAgentSync: the clone as its own project gets sync-agents only, since stamp-contract never stamps the clone running it (the project is the plugin root)', async () => {
  const plugin = makePluginRoot({ clone: true });
  mkdirSync(join(plugin, '.sterling'), { recursive: true });
  writeFileSync(join(plugin, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  const { calls, runStep } = recordingSteps();
  const r = await cloneAgentSync({ root: plugin, project: plugin, behind: [], runStep });
  assert.equal(r.outcome, 'synced');
  assert.deepEqual(calls, [`sync-agents.mjs --target ${plugin}`]);
  assert.equal(markerOf(plugin), 'ENOENT');
});

test('runPostUpdateSteps: a project that is the plugin root, directly or through a symlink, skips stamp-contract and succeeds instead of reporting an unregistered project', async () => {
  const plugin = makePluginRoot({ clone: true });
  const link = join(tmp('sterling-pus-link-'), 'clone-link');
  symlinkSync(plugin, link, 'dir');
  for (const [project, root] of [[plugin, plugin], [link, plugin], [plugin, link]]) {
    const { calls, runStep } = recordingSteps();
    const r = await runPostUpdateSteps(root, project, runStep);
    assert.deepEqual(r, { ok: true, restart: true, drift: false, driftOut: '', inserted: [], migrated: [], layer: [] }, `project ${project}, root ${root}`);
    assert.deepEqual(calls, [`sync-agents.mjs --target ${project}`], 'stamp-contract is never invoked');
  }
  // A different directory still goes through stamp-contract.
  const other = makeProject({ store: false });
  const { calls, runStep } = recordingSteps();
  assert.equal((await runPostUpdateSteps(plugin, other, runStep)).ok, true);
  assert.deepEqual(calls, [`sync-agents.mjs --target ${other}`, `stamp-contract.mjs --apply-inserts --project ${other}`, `retire-host-files.mjs --target ${other}`]);
});

test('postUpdateSync, host opencode: a Sterling source clone as the project skips stamp-contract even when the running root is a different installed copy; sync-agents runs and the marker advances', async () => {
  const installed = makePluginRoot();
  const sourceClone = makePluginRoot({ clone: true });
  mkdirSync(join(sourceClone, 'scripts'), { recursive: true });
  writeFileSync(join(sourceClone, 'scripts', 'architecture-projection.mjs'), '');
  mkdirSync(join(sourceClone, '.sterling'), { recursive: true });
  writeFileSync(join(sourceClone, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  const { calls, runStep } = recordingSteps();
  const r = await postUpdateSync({ root: installed, project: sourceClone, host: 'opencode', runStep });
  assert.equal(r.outcome, 'synced');
  assert.deepEqual(calls, [`sync-agents.mjs --target ${sourceClone}`], 'stamp-contract is never invoked on a Sterling source tree');
  assert.equal(markerOf(sourceClone).trim(), VERSION);
  // An ordinary consumer project, even one whose manifest also says "sterling" but is no source tree, still gets stamp-contract.
  const consumer = makeProject({ store: true });
  mkdirSync(join(consumer, '.claude-plugin'), { recursive: true });
  writeFileSync(join(consumer, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: VERSION }));
  for (const project of [makeProject({ store: true }), consumer]) {
    const steps = recordingSteps();
    const res = await postUpdateSync({ root: installed, project, host: 'opencode', runStep: steps.runStep });
    assert.equal(res.outcome, 'synced');
    assert.deepEqual(steps.calls, [`sync-agents.mjs --target ${project}`, `stamp-contract.mjs --apply-inserts --project ${project}`, `retire-host-files.mjs --target ${project}`]);
  }
});

test('cloneAgentSync: a clone older than the marker refuses and runs nothing; a clone version that cannot be ordered against a marker is a loud SKIP', async () => {
  const older = makePluginRoot({ clone: true });
  const project = makeProject({ marker: '10.0.0', store: false });
  const a = recordingSteps();
  const refused = await cloneAgentSync({ root: older, project, behind: ['implementor.md'], runStep: a.runStep });
  assert.equal(refused.outcome, 'refused-older');
  assert.deepEqual(a.calls, []);
  assert.equal(refused.warning, `✗ Sterling clone ${VERSION} is OLDER than this project's sync marker 10.0.0: agent sync REFUSED, nothing downgraded — pull this clone. `);
  assert.equal(markerOf(project), '10.0.0\n');

  const b = recordingSteps();
  const skipped = await cloneAgentSync({ root: makePluginRoot({ clone: true, version: 'dev' }), project, behind: [], runStep: b.runStep });
  assert.equal(skipped.outcome, 'skipped');
  assert.deepEqual(b.calls, []);
  assert.match(skipped.warning, /^⚠ Sterling clone agent sync SKIPPED — /);

  const c = recordingSteps();
  const unmarked = await cloneAgentSync({ root: makePluginRoot({ clone: true, version: 'dev' }), project: makeProject({ store: false }), behind: [], runStep: c.runStep });
  assert.equal(unmarked.outcome, 'synced', 'with no marker there is nothing to order against, so nothing can be downgraded');
});

test('cloneAgentSync: a refusal is a failed sync that says what was refused, and owes the restart when sync-agents changed another agent first', async () => {
  const plugin = makePluginRoot({ clone: true });
  const project = makeProject({ store: false });
  const out = 'refreshed: implementor\nrefused_local_modification: reviewer\nrefreshed: .opencode/agents/scout.md';
  const a = recordingSteps({ 'sync-agents.mjs': { status: 2, error: null, out, tail: out.split('\n').join(' | ') } });
  const r = await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep: a.runStep });
  assert.equal(r.outcome, 'failed');
  // stamp-contract does not run after the refusal; retire-host-files, with its own on-disk checks, always runs last.
  assert.deepEqual(a.calls, [`sync-agents.mjs --target ${project}`, `retire-host-files.mjs --target ${project}`]);
  assert.match(r.warning, /^✗ Sterling clone: agent sync FAILED — sync-agents REFUSED \(exit 2\): refused_local_modification: reviewer\. agents synced — RESTART to load them/);
  assert.ok(r.context.includes('sync-agents DID change agents before the failure (refreshed: implementor): RESTART REQUIRED'), r.context);

  const portableOnly = 'refused_local_modification: reviewer\nrefreshed: .opencode/agents/scout.md';
  const b = recordingSteps({ 'sync-agents.mjs': { status: 2, error: null, out: portableOnly, tail: portableOnly } });
  const quiet = await cloneAgentSync({ root: plugin, project, behind: [], runStep: b.runStep });
  assert.doesNotMatch(quiet.warning + quiet.context, /RESTART/, 'a portable OpenCode copy needs no restart, and nothing else changed');
});

// BASE BRANCH ONLY (user-ruled 2026-10-06 through the question form, "Sync only on the
// base branch (Recommended)"): a clone on a feature branch holds templates that are not
// merged yet, so nothing is synced from it. The branch comes from the HEAD file, never
// from a git process.
async function offBase(plugin) {
  const project = makeProject({ store: false });
  const { calls, runStep } = recordingSteps();
  const r = await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep });
  assert.deepEqual(calls, [], 'nothing is spawned');
  assert.equal(r.outcome, 'off-base');
  assert.equal(r.warning, '');
  assert.equal(r.context, '');
  assert.equal(markerOf(project), 'ENOENT');
  assert.doesNotMatch(r.clause, /\n/, 'the clause is one line');
  return r.clause;
}

async function onBase(plugin) {
  const project = makeProject({ store: false });
  const { calls, runStep } = recordingSteps();
  const r = await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep });
  assert.equal(r.outcome, 'synced');
  assert.deepEqual(calls, [`sync-agents.mjs --target ${project}`, `stamp-contract.mjs --apply-inserts --project ${project}`, `retire-host-files.mjs --target ${project}`]);
}

test('cloneAgentSync: a clone on another branch syncs nothing and names the branch', async () => {
  const clause = await offBase(makePluginRoot({ clone: true, head: 'ref: refs/heads/integrate/0.18.88\n' }));
  assert.equal(clause, 'the Sterling clone is on branch integrate/0.18.88, not its base branch main, so agents sync at session start after the merge');
});

test('cloneAgentSync: a detached HEAD syncs nothing and says so', async () => {
  const clause = await offBase(makePluginRoot({ clone: true, head: `${'a1b2c3d4'.repeat(5)}\n` }));
  assert.equal(clause, 'the Sterling clone is on a detached HEAD, not its base branch main, so agents sync at session start once main is checked out');
});

test('cloneAgentSync: a HEAD that is missing or is not a branch or a commit syncs nothing and says it could not be read, with no file content', async () => {
  assert.equal(
    await offBase(makePluginRoot({ clone: true, head: null })),
    "the Sterling clone's checked-out branch could not be read (HEAD: ENOENT), so no agents were synced",
  );
  const junk = await offBase(makePluginRoot({ clone: true, head: 'ref: refs/heads/has space\nSECOND-LINE-MARKER\n' }));
  assert.equal(junk, "the Sterling clone's checked-out branch could not be read (HEAD: not a branch or a commit), so no agents were synced");
});

test('cloneAgentSync: master is the base only when the clone has no main branch, loose or packed', async () => {
  const head = 'ref: refs/heads/master\n';
  await onBase(makePluginRoot({ clone: true, head, mainBranch: false }));
  assert.match(await offBase(makePluginRoot({ clone: true, head })), /is on branch master, not its base branch main,/, 'a loose refs/heads/main');
  assert.match(
    await offBase(makePluginRoot({ clone: true, head: 'ref: refs/heads/feature\n', mainBranch: false })),
    /is on branch feature, not its base branch master,/,
    'with no main the base is master, and a feature branch is still not it',
  );

  const packed = makePluginRoot({ clone: true, head, mainBranch: false });
  writeFileSync(join(packed, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${'0'.repeat(40)} refs/heads/main\n${'1'.repeat(40)} refs/heads/master\n`);
  assert.match(await offBase(packed), /is on branch master, not its base branch main,/);

  const packedOther = makePluginRoot({ clone: true, head, mainBranch: false });
  writeFileSync(join(packedOther, '.git', 'packed-refs'), `${'0'.repeat(40)} refs/heads/maintenance\n${'1'.repeat(40)} refs/remotes/origin/main\n`);
  await onBase(packedOther);
});

const UNREADABLE_BRANCH = "the Sterling clone's checked-out branch could not be read (HEAD: not a branch or a commit), so no agents were synced";

test('cloneAgentSync: a branch name is accepted only as plain ref-name characters and a bounded length; anything else is an unreadable HEAD, never a cleaned-up name', async () => {
  // An ordinary name still reaches the clause whole.
  assert.match(await offBase(makePluginRoot({ clone: true, head: 'ref: refs/heads/integrate/0.18.89\n' })), /is on branch integrate\/0\.18\.89, not its base branch main,/);
  assert.match(await offBase(makePluginRoot({ clone: true, head: `ref: refs/heads/${'a'.repeat(200)}\n` })), /is on branch a{200}, not/, 'the cap is not tripped by a long but ordinary name');
  for (const [what, head] of [
    ['an ESC byte', 'ref: refs/heads/feat\u001b[31mred\n'],
    ['a BEL byte', 'ref: refs/heads/feat\u0007\n'],
    ['an over-length name', `ref: refs/heads/${'a'.repeat(3000)}\n`],
    ['an ESC byte and 3000 characters', `ref: refs/heads/\u001b${'a'.repeat(3000)}\n`],
    ['a name just over the cap', `ref: refs/heads/${'a'.repeat(201)}\n`],
    ['a ref-forbidden character', 'ref: refs/heads/feat~1\n'],
    ['a non-ASCII character', 'ref: refs/heads/f\u00e9e\n'],
  ]) {
    const clause = await offBase(makePluginRoot({ clone: true, head }));
    assert.equal(clause, UNREADABLE_BRANCH, `${what} reads as unreadable`);
  }
});

test('cloneAgentSync: an off-base result says whether the branch was read, so the caller can word an unreadable HEAD differently from another branch', async () => {
  const project = makeProject({ store: false });
  const { runStep } = recordingSteps();
  const read = (head) => cloneAgentSync({ root: makePluginRoot({ clone: true, head }), project, behind: ['implementor.md'], runStep });
  assert.equal((await read('ref: refs/heads/feat\n')).unreadable, false);
  assert.equal((await read(`${'a1b2c3d4'.repeat(5)}\n`)).unreadable, false, 'a detached HEAD was read');
  const garbled = await read('garbage\n');
  assert.equal(garbled.outcome, 'off-base');
  assert.equal(garbled.unreadable, true);
});

// A linked worktree's .git is a FILE pointing at <main>/.git/worktrees/<name>, which holds
// that worktree's own HEAD and a commondir file pointing back at the shared refs.
function makeWorktreeRoot(head, { relative = false } = {}) {
  const main = makePluginRoot({ clone: true });
  const admin = join(main, '.git', 'worktrees', 'wt');
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, 'HEAD'), head);
  writeFileSync(join(admin, 'commondir'), '../..\n');
  const wt = makePluginRoot();
  writeFileSync(join(wt, '.git'), `gitdir: ${relative ? relativePath(wt, admin) : admin}\n`);
  return { wt, admin };
}

test('cloneAgentSync: a linked worktree (.git is a file) is read through its gitdir, absolute or relative', async () => {
  await onBase(makeWorktreeRoot('ref: refs/heads/main\n').wt);
  await onBase(makeWorktreeRoot('ref: refs/heads/main\n', { relative: true }).wt);
  assert.match(await offBase(makeWorktreeRoot('ref: refs/heads/worktree-agent-1\n').wt), /is on branch worktree-agent-1, not its base branch main,/);

  // master in a worktree whose shared refs hold a main: the commondir is where main is found.
  assert.match(await offBase(makeWorktreeRoot('ref: refs/heads/master\n').wt), /is on branch master, not its base branch main,/);

  // A commondir that names a directory which is not there says nothing about main, so it cannot make master the base.
  const gone = makeWorktreeRoot('ref: refs/heads/master\n');
  writeFileSync(join(gone.admin, 'commondir'), '../../no-such-common\n');
  assert.equal(await offBase(gone.wt), "the Sterling clone's checked-out branch could not be read (commondir: ENOENT), so no agents were synced");
  // On main too: the shared refs cannot be consulted, so nothing is known about the base.
  const goneMain = makeWorktreeRoot('ref: refs/heads/main\n');
  writeFileSync(join(goneMain.admin, 'commondir'), '../../no-such-common\n');
  assert.equal(await offBase(goneMain.wt), "the Sterling clone's checked-out branch could not be read (commondir: ENOENT), so no agents were synced");

  // An empty commondir would resolve to the gitdir itself, which holds no refs: master must not become the base through it.
  for (const content of ['', '\n', '  \n']) {
    const empty = makeWorktreeRoot('ref: refs/heads/master\n');
    writeFileSync(join(empty.admin, 'commondir'), content);
    assert.equal(await offBase(empty.wt), "the Sterling clone's checked-out branch could not be read (commondir: empty), so no agents were synced");
  }

  const broken = makePluginRoot();
  writeFileSync(join(broken, '.git'), 'not a pointer\nSECOND-LINE-MARKER\n');
  assert.equal(await offBase(broken), "the Sterling clone's checked-out branch could not be read (.git: no gitdir line), so no agents were synced");
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
    assert.match(r.context, /^\n\nPOST-UPDATE SYNC \(OpenCode plugin\): Sterling 0\.0\.1→9\.9\.9-fixture — agents synced — RELOAD to load them \(run `opencode reload`; a \/new is NOT enough\)\. RELOAD REQUIRED — agents load when the shared OpenCode server loads them/);
    assert.match(r.context, /`opencode service restart`, which interrupts every project open on that server/);
    assert.doesNotMatch(r.context, /Claude Code/);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`sync-agents --target ${project}`, `stamp-contract --apply-inserts --project ${project}`]);
  } finally {
    delete process.env.FIXTURE_LOG;
  }
});

test('postUpdateSync, host opencode: a refreshed Sterling-full agent is a change that owes the relaunch, never "none changed"', async () => {
  const plugin = makePluginRoot({ syncOut: 'OpenCode matches: .opencode/opencode.json\nOpenCode refreshed: .opencode/agents/sterling/conductor.md\n' });
  const project = makeProject({ marker: '0.0.1', store: false });
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep: (root, name, args) => runStepAsync(root, name, args, { nodeBin: process.execPath }) });
    assert.equal(r.outcome, 'synced');
    assert.match(r.context, /RELOAD REQUIRED — agents load when the shared OpenCode server loads them/);
    assert.doesNotMatch(r.context, /none changed/);
  } finally {
    delete process.env.FIXTURE_LOG;
  }
});

test('postUpdateSync, host opencode: sync-agents skipping the OpenCode setup fails the sync and writes no marker; on Claude Code the same output still syncs', async () => {
  const skip = 'OpenCode: OpenCode not installed (no `opencode` on PATH or in ~/.opencode/bin) — Sterling on OpenCode SKIPPED; install OpenCode 2, then run /sterling:update\n';
  process.env.FIXTURE_LOG = join(tmp('sterling-pus-log-'), 'calls.log');
  try {
    const plugin = makePluginRoot({ syncOut: skip });
    const project = makeProject({ marker: '0.0.1', store: false });
    const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep: (root, name, args) => runStepAsync(root, name, args, { nodeBin: process.execPath }) });
    assert.equal(r.outcome, 'failed');
    assert.match(r.context, /did not refresh the OpenCode agents \(OpenCode: OpenCode not installed/);
    assert.equal(markerOf(project), '0.0.1\n');
    const claudeProject = makeProject({ marker: '0.0.1', store: false });
    const c = await postUpdateSync({ root: plugin, project: claudeProject, host: 'claude', runStep: (root, name, args) => runStepAsync(root, name, args, { nodeBin: process.execPath }) });
    assert.equal(c.outcome, 'synced');
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

const inertUpdater = {
  due: () => false,
  check: async () => {
    throw new Error('the inert test updater was asked to check');
  },
};

function ocSync(plugin, session, extra = {}) {
  // An inert updater: these fixtures test the sync, and must never read the machine's real update receipt or config.
  return sync.createSessionSync({ sterlingRoot: plugin, getSession: () => session, now: () => '2026-10-02T12:00:00.000Z', nodeBin: process.execPath, updater: inertUpdater, ...extra });
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
    assert.match(texts[0], /^POST-UPDATE SYNC \(OpenCode plugin\): Sterling 0\.0\.1→9\.9\.9-fixture — agents synced — RELOAD to load them \(run `opencode reload`; a \/new is NOT enough\)/);
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
  // installed copy: the npm copy's route is `opencode plugin update` (the former ruling 'the npm-copy update route is opencode plugin update' (not in the current store)).
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
  writeFileSync(join(plugin, 'scripts', 'retire-host-files.mjs'), `process.exit(0);\n`);
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

// ---- the Sterling layer in AGENTS.md (GitHub #329, review findings 6 and 8) ----
// sync-agents prints one prefixed line per layer outcome; both callers carry them to what the user
// sees, and a layer refusal is a failed sync that never advances the marker.
const LAYER_KEPT = "⚠ Sterling layer: CLAUDE.md holds text that is not Sterling's generated layer, so it was kept. Claude Code ignores AGENTS.md (including the Sterling layer) while a CLAUDE.md exists. Move your rules into AGENTS.md outside the sterling:begin/sterling:end markers, then delete CLAUDE.md.";
const LAYER_REMOVED = "Sterling layer: GEMINI.md removed — held only Sterling's generated text; the layer now lives in AGENTS.md";
const LAYER_REFUSED = "✗ Sterling layer REFUSED: AGENTS.md would be 27,738 bytes with the Sterling layer, over agy's 24,000-byte cap, so nothing was written and no CLAUDE.md or GEMINI.md was removed.";

test('postUpdateSync: a kept CLAUDE.md and a removed GEMINI.md from the retire step are named in the banner and the context, and the marker advances', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const out = 'up_to_date: implementor\nSterling layer: AGENTS.md up to date\n';
  const calls = [];
  const runStep = async (root, name) => {
    calls.push(name);
    if (name === 'sync-agents.mjs') return { status: 0, error: null, out, tail: out };
    if (name === 'retire-host-files.mjs') return { status: 0, error: null, out: `${LAYER_KEPT}\n${LAYER_REMOVED}\n`, tail: '' };
    return { status: 0, error: null, out: 'stamp-contract: 1 already in sync — 1 project(s) processed', tail: '' };
  };
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'synced');
  assert.deepEqual(calls, ['sync-agents.mjs', 'stamp-contract.mjs', 'retire-host-files.mjs'], 'the receipts come from the retire step');
  for (const line of [LAYER_KEPT, LAYER_REMOVED]) {
    assert.ok(r.warning.includes(line), `banner names: ${line}\n${r.warning}`);
    assert.ok(r.context.includes(line), `context names: ${line}\n${r.context}`);
  }
  assert.ok(!r.context.includes('AGENTS.md up to date'), 'a routine line is not relayed');
  assert.equal(markerOf(project), `${VERSION}\n`);
});

test('postUpdateSync: a layer refusal (sync-agents exit 2) is a failed sync naming the reason, and the marker is not advanced', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const out = `up_to_date: implementor\n${LAYER_REFUSED}\n${LAYER_KEPT.replace("holds text that is not Sterling's generated layer", 'was not checked for removal because the Sterling layer is not verified in AGENTS.md')}\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs' ? { status: 2, error: null, out, tail: 'refused' } : name === 'retire-host-files.mjs' ? { status: 0, error: null, out: '', tail: '' } : assert.fail('stamp-contract must not run after a refused sync');
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'failed');
  assert.match(r.warning, /REFUSED the Sterling layer in AGENTS\.md/);
  assert.ok(r.warning.includes(LAYER_REFUSED), r.warning);
  assert.ok(r.context.includes(LAYER_REFUSED), r.context);
  assert.equal(markerOf(project), '0.0.1\n', 'marker not advanced past an unresolved refusal');
});

test('cloneAgentSync: layer lines from sync-agents are named in the banner and the context', async () => {
  const plugin = makePluginRoot({ clone: true });
  const project = makeProject({ marker: '0.0.1', store: false });
  const out = `refreshed: implementor\n${LAYER_KEPT}\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs' ? { status: 0, error: null, out, tail: out } : { status: 0, error: null, out: 'stamp-contract: 1 already in sync — 1 project(s) processed', tail: '' };
  const r = await cloneAgentSync({ root: plugin, project, behind: ['implementor.md'], runStep });
  assert.equal(r.outcome, 'synced');
  assert.ok(r.warning.includes(LAYER_KEPT), r.warning);
  assert.ok(r.context.includes(LAYER_KEPT), r.context);
});

test('H1 delivers the Claude Code layer block on the no-store exit of a Sterling project too', () => {
  const project = makeProject({ marker: VERSION, store: false });
  const plugin = makePluginRoot();
  const ctx = runH1(project, plugin, {}, { rawContext: true }).ctx;
  assert.equal(ctx.split(CLAUDE_BLOCK_FIXTURE).length, 2, ctx);
});

test('H1 on agy never delivers the Claude Code layer block, with or without a store', () => {
  const plugin = makePluginRoot();
  for (const store of [true, false]) {
    const project = makeProject({ marker: VERSION, store });
    const r = spawnSync(process.execPath, [seam.hookPath], {
      input: JSON.stringify({ hookEventName: 'SessionStart', conversationId: 'c1', cwd: project, lastUserInput: 'hello' }),
      encoding: 'utf8',
      cwd: project,
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_CURRENCY_DISABLE: '1', STERLING_PLUGIN_ROOT: plugin, HOME: tmp('sterling-pus-home-') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length > 0, `store ${store}: H1 printed its context`);
    assert.ok(!r.stdout.includes(CLAUDE_BLOCK_FIXTURE), `store ${store}: no Claude Code block on agy:\n${r.stdout}`);
  }
});

// Review loop 2 of #329, finding 5: sync-agents may refresh agents before it exits 2 for the layer
// (or for another agent), so the failed result still owes the restart and names every refusal.
test('postUpdateSync: a partial agent refresh plus a layer refusal and an agent refusal fails the sync, owes the restart and names both refusals', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const agentRefusal = 'refused_local_modification: reviewer';
  const out = `refreshed: implementor\n${agentRefusal}\n${LAYER_REFUSED}\n\nRESTART REQUIRED — project subagents load at session start.\n`;
  const runStep = async (root, name) =>
    name === 'sync-agents.mjs' ? { status: 2, error: null, out, tail: out.trim().split('\n').slice(-4).join(' | ') } : name === 'retire-host-files.mjs' ? { status: 0, error: null, out: '', tail: '' } : assert.fail('stamp-contract must not run after a refused sync');
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'failed');
  assert.match(r.warning, /RESTART|restart/, `the restart is owed:\n${r.warning}`);
  assert.match(r.context, /DID refresh agents before the failure/, r.context);
  assert.ok(r.warning.includes(agentRefusal), `the agent refusal is named:\n${r.warning}`);
  assert.ok(r.warning.includes(LAYER_REFUSED), r.warning);
  assert.equal(markerOf(project), '0.0.1\n');
});

// Review loop 3 of #329. D: refusal reasons are read from the whole sync-agents output, never only
// its truncated tail. C: a stamp-contract refusal to update AGENTS.md itself fails the sync, and
// host files are retired only as the last step, after stamp-contract succeeded.
test('postUpdateSync: refusal reasons that sit far above the tail are still named, and the marker is not advanced', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const agentRefusal = 'refused_local_modification: reviewer';
  const noise = Array.from({ length: 20 }, (_, i) => `OpenCode up to date: .opencode/agents/role-${i}.md`);
  const out = `${agentRefusal}\n${LAYER_REFUSED}\n${noise.join('\n')}\n`;
  const tail = out.trim().split('\n').slice(-8).join(' | ');
  assert.ok(!tail.includes('refused_local_modification') && !tail.includes('Sterling layer REFUSED'), 'fixture: both refusals are outside the tail');
  const runStep = async (root, name) => (name === 'sync-agents.mjs' ? { status: 2, error: null, out, tail } : name === 'retire-host-files.mjs' ? { status: 0, error: null, out: '', tail: '' } : assert.fail(`${name} must not run after a refused sync`));
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'failed');
  assert.ok(r.warning.includes(agentRefusal), r.warning);
  assert.match(r.warning, /REFUSED the Sterling layer in AGENTS\.md \(exit 2\):.*over agy's 24,000-byte cap/);
  assert.ok(!r.warning.includes('role-19'), 'the classified reasons replace the tail');
  assert.equal(markerOf(project), '0.0.1\n');
});

test('postUpdateSync: a stamp-contract refusal to update AGENTS.md (planned file over the cap) fails the sync, names the reason and leaves the marker; the retire step still runs last', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const contractOut = `✗ p (${project}/AGENTS.md)\n    inserted  - **Lint and tests before done.**…\n    PLANNED_AGENTS_MD_REFUSED  AGENTS.md (write)…\n      AGENTS.md would be 24,310 bytes with the Sterling layer, over agy's 24,000-byte cap. Nothing in AGENTS.md was changed.\n\nINSERTS APPLIED — 1 project(s) processed, 0 already in sync, 1 refusal(s).\n`;
  const calls = [];
  const runStep = async (root, name) => {
    calls.push(name);
    if (name === 'sync-agents.mjs') return { status: 0, error: null, out: 'up_to_date: implementor\n', tail: '' };
    if (name === 'stamp-contract.mjs') return { status: 2, error: null, out: contractOut, tail: contractOut.trim().split('\n').slice(-2).join(' | ') };
    return { status: 0, error: null, out: '', tail: '' };
  };
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'failed');
  assert.match(r.warning, /stamp-contract could not update AGENTS\.md \(PLANNED_AGENTS_MD_REFUSED .*24,310 bytes/);
  assert.deepEqual(calls, ['sync-agents.mjs', 'stamp-contract.mjs', 'retire-host-files.mjs']);
  assert.equal(markerOf(project), '0.0.1\n');
});

test('runPostUpdateSteps: retire-host-files runs last, after stamp-contract, and its lines reach the result; tolerated wording drift does not stop it', async () => {
  const removed = "Sterling layer: CLAUDE.md removed — held only Sterling's generated text; the layer now lives in AGENTS.md";
  for (const contract of [{ status: 0, out: 'stamp-contract: 1 already in sync — 1 project(s) processed' }, { status: 2, out: '✗ p (/x/AGENTS.md)\n    HAND_TUNED_REFUSED  - **Anti-speculation:**…\n\n— 1 project(s) processed, 0 already in sync, 1 refusal(s).' }]) {
    const calls = [];
    const runStep = async (root, name, args) => {
      calls.push(`${name} ${args.join(' ')}`);
      if (name === 'sync-agents.mjs') return { status: 0, error: null, out: 'up_to_date: implementor\n', tail: '' };
      if (name === 'stamp-contract.mjs') return { status: contract.status, error: null, out: contract.out, tail: '' };
      return { status: 0, error: null, out: `${removed}\n`, tail: removed };
    };
    const project = makeProject({ store: false });
    const r = await runPostUpdateSteps(tmp('sterling-pus-root-'), project, runStep);
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(calls, [`sync-agents.mjs --target ${project}`, `stamp-contract.mjs --apply-inserts --project ${project}`, `retire-host-files.mjs --target ${project}`]);
    assert.deepEqual(r.layer, [removed]);
  }
});

// Review loop 4 of #329. R1: the retire step runs after the writers whatever their outcome. R2:
// write and safety refusals from stamp-contract (one classifier, scripts/lib/stamp-outcome.mjs),
// a crash and a zero-project run fail the sync. R4: OpenCode and agy refusal rows are reasons. R5: a
// Sterling source tree removes nothing and names a retained host file. R8: receipts of a retire step
// that exits non-zero are still relayed.
const stepsWith = (results) => {
  const calls = [];
  const runStep = async (root, name) => {
    calls.push(name);
    return results[name] ?? { status: 0, error: null, out: name === 'stamp-contract.mjs' ? 'stamp-contract: 1 already in sync — 1 project(s) processed' : '', tail: '' };
  };
  return { calls, runStep };
};

test('postUpdateSync: a WRITE_FAILED_REFUSED from stamp-contract fails the sync and is named; the marker is not advanced', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const contractOut = `✗ p (${project}/AGENTS.md)\n    WRITE_FAILED_REFUSED  AGENTS.md (write)…\n      ${project}/AGENTS.md could not be written (EACCES: permission denied). Nothing in it was changed; make the file writable and re-run.\n\nINSERTS APPLIED — 1 project(s) processed, 0 already in sync, 1 refusal(s).\n`;
  const { calls, runStep } = stepsWith({ 'stamp-contract.mjs': { status: 2, error: null, out: contractOut, tail: '' } });
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'failed');
  assert.match(r.warning, /stamp-contract could not update AGENTS\.md \(WRITE_FAILED_REFUSED .*EACCES/);
  assert.deepEqual(calls, ['sync-agents.mjs', 'stamp-contract.mjs', 'retire-host-files.mjs']);
  assert.equal(markerOf(project), '0.0.1\n');
});

test('postUpdateSync: a stamp-contract crash and a zero-project run both fail the sync; the retire step still runs and its receipts are relayed', async () => {
  for (const contract of [{ status: 1, error: null, out: 'TypeError: boom', tail: 'TypeError: boom' }, { status: 0, error: null, out: 'stamp-contract: — 0 project(s) processed', tail: '' }]) {
    const plugin = makePluginRoot();
    const project = makeProject({ marker: '0.0.1', store: false });
    const { calls, runStep } = stepsWith({ 'stamp-contract.mjs': contract, 'retire-host-files.mjs': { status: 0, error: null, out: `${LAYER_REMOVED}\n`, tail: '' } });
    const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
    assert.equal(r.outcome, 'failed', contract.out);
    assert.deepEqual(calls, ['sync-agents.mjs', 'stamp-contract.mjs', 'retire-host-files.mjs']);
    assert.ok(r.warning.includes(LAYER_REMOVED), r.warning);
    assert.equal(markerOf(project), '0.0.1\n');
  }
});

test('postUpdateSync: OpenCode and agy refusal rows far above the tail are named next to agent and layer refusals', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const oc = 'OpenCode refused: .opencode/opencode.json — not valid JSON';
  const agy = 'Antigravity CLI (agy) refused: .agents/agents/, GEMINI.md, .git/info/exclude (agy) — git ls-files failed';
  const noise = Array.from({ length: 25 }, (_, i) => `OpenCode up to date: .opencode/agents/role-${i}.md`);
  const out = `${oc}\n${agy}\nrefused_local_modification: reviewer\n${noise.join('\n')}\nexit-1-looking line\n`;
  const tail = out.trim().split('\n').slice(-8).join(' | ');
  assert.ok(!tail.includes('refused'), 'fixture: every refusal is outside the tail');
  const { runStep } = stepsWith({ 'sync-agents.mjs': { status: 2, error: null, out, tail } });
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'failed');
  for (const line of [oc, agy, 'refused_local_modification: reviewer']) assert.ok(r.warning.includes(line), `${line}\n${r.warning}`);
});

test('postUpdateSync: the retire step\'s receipts are relayed even when it exits non-zero, and the sync fails', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const failedLine = "⚠ Sterling layer: GEMINI.md holds only Sterling's generated text but could not be removed (EPERM), so it was kept.";
  const { runStep } = stepsWith({ 'retire-host-files.mjs': { status: 1, error: null, out: `${LAYER_REMOVED.replace('GEMINI', 'CLAUDE')}\n${failedLine}\n`, tail: failedLine } });
  const r = await postUpdateSync({ root: plugin, project, host: 'claude', runStep });
  assert.equal(r.outcome, 'failed');
  assert.ok(r.warning.includes(LAYER_REMOVED.replace('GEMINI', 'CLAUDE')), `the receipt of the removed file is kept:\n${r.warning}`);
  assert.ok(r.warning.includes(failedLine), r.warning);
  assert.match(r.warning, /retire-host-files exited 1/);
  assert.equal(markerOf(project), '0.0.1\n');
});

// Changed in the #329 re-check: the line used to name retire-host-files and /sterling:update as the
// follow-up. Ruling a-sterling-source-checkout-s-agents-md-is-hand-maintained-up exempts source trees
// from retirement, so both are no-ops there and the advice was wrong; the line now says the files
// are maintained by hand and names no removal command.
test('runPostUpdateSteps: a Sterling source tree runs no retire step and names a retained CLAUDE.md as maintained by hand, with no removal command', async () => {
  const plugin = makePluginRoot({ clone: true });
  writeFileSync(join(plugin, 'CLAUDE.md'), '# Sterling\n');
  const { calls, runStep } = stepsWith({});
  const r = await runPostUpdateSteps(plugin, plugin, runStep);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['sync-agents.mjs']);
  assert.equal(r.layer.length, 1);
  assert.equal(r.layer[0], '⚠ Sterling layer: CLAUDE.md kept — this project is a Sterling source tree, whose instruction files are maintained by hand, so Sterling removes no host file here.');
  assert.doesNotMatch(r.layer[0], /retire-host-files|sterling:update/, 'no removal command is offered');
});

// #329 fix round, finding 2: during an OpenCode auto-update the runtime already loaded (from
// before #329) runs the NEW scripts' sync-agents and stamp-contract, never retire-host-files, and
// writes the new version to the marker. After /reload the new runtime sees an equal marker. It
// must still run the steps, retirement included, while a CLAUDE.md or GEMINI.md is left and no
// layer receipt says this version's steps ran; then it writes the receipt and stays quiet.
test('postUpdateSync: an equal marker written by a pre-#329 runtime, with CLAUDE.md left and no layer receipt, runs the steps with retirement once; then it is quiet', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: VERSION, store: false });
  writeFileSync(join(project, 'CLAUDE.md'), '# held over from before #329\n');
  const { calls, runStep } = stepsWith({});
  const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep });
  assert.equal(r?.outcome, 'synced', JSON.stringify(r));
  assert.deepEqual(calls, ['sync-agents.mjs', 'stamp-contract.mjs', 'retire-host-files.mjs'], 'retirement runs after the writers');
  assert.equal(markerOf(project), `${VERSION}\n`);
  assert.equal(readFileSync(join(project, '.sterling', 'synced-layer-version'), 'utf8'), `${VERSION}\n`, 'the layer receipt is written');
  const again = stepsWith({});
  assert.equal(await postUpdateSync({ root: plugin, project, host: 'opencode', runStep: again.runStep }), null, 'with the receipt, an equal marker is a finished sync');
  assert.deepEqual(again.calls, []);
});

test('postUpdateSync: an equal marker without a layer receipt but with no CLAUDE.md or GEMINI.md left has nothing to retire and runs nothing', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: VERSION, store: false });
  const { calls, runStep } = stepsWith({});
  assert.equal(await postUpdateSync({ root: plugin, project, host: 'opencode', runStep }), null);
  assert.deepEqual(calls, []);
});

// #329 fix round, finding 5: whether retirement may run is settled before any writer outcome. A
// Sterling source tree never reaches retire-host-files, even when sync-agents refused or crashed.
for (const [label, sync] of [
  ['a sync-agents refusal', { status: 2, error: null, out: 'refused_x: y', tail: 'refused_x: y' }],
  ['a sync-agents crash', { status: 1, error: null, out: 'boom', tail: 'boom' }],
  ['a sync-agents spawn error', { status: null, error: 'ENOENT', out: '', tail: '' }],
]) {
  test(`runPostUpdateSteps: in a Sterling source tree, ${label} never reaches retire-host-files`, async () => {
    const plugin = makePluginRoot({ clone: true });
    const project = tmp('sterling-pus-source-tree-');
    mkdirSync(join(project, '.claude-plugin'), { recursive: true });
    writeFileSync(join(project, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling' }));
    mkdirSync(join(project, 'scripts'), { recursive: true });
    writeFileSync(join(project, 'scripts', 'architecture-projection.mjs'), '');
    const { calls, runStep } = stepsWith({ 'sync-agents.mjs': sync });
    const r = await runPostUpdateSteps(plugin, project, runStep);
    assert.equal(r.ok, false);
    assert.ok(!calls.includes('retire-host-files.mjs'), calls.join(', '));
  });
}

// #329 re-check, gap 3: the marker advanced but the layer receipt could not be written. The sync is
// failed, the banner and the context OpenCode relays both name the exact file, and the next start
// runs the steps again while a host file is left; the marker keeps newest-copy-wins.
test('postUpdateSync: a layer receipt that cannot be written fails the sync, naming the receipt file in banner and context', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: '0.0.1', store: false });
  const receipt = join(project, '.sterling', 'synced-layer-version');
  mkdirSync(receipt);
  const { runStep } = stepsWith({});
  const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep });
  assert.equal(r.outcome, 'failed');
  assert.ok(r.warning.includes(`${receipt} could not be written (EISDIR)`), r.warning);
  assert.ok(!r.warning.includes(`${join(project, '.sterling', 'synced-version')} could not be written`), 'the marker is not blamed');
  assert.ok(r.context.startsWith('\n\nPOST-UPDATE SYNC FAILED (OpenCode plugin): '), r.context);
  assert.ok(r.context.includes(`${receipt} could not be written (EISDIR)`), r.context);
  assert.match(r.context, /retries the next time OpenCode starts while a CLAUDE\.md or GEMINI\.md is left/);
  assert.equal(markerOf(project), `${VERSION}\n`, 'the version marker advanced');
});

// #329 re-check, gap 4: a dangling CLAUDE.md symlink is a directory entry retirement sees, so an
// equal marker without a layer receipt still runs the steps.
test('postUpdateSync: an equal marker without a layer receipt and a dangling CLAUDE.md symlink runs the steps', async () => {
  const plugin = makePluginRoot();
  const project = makeProject({ marker: VERSION, store: false });
  symlinkSync(join(project, 'no-such-file'), join(project, 'CLAUDE.md'));
  const { calls, runStep } = stepsWith({});
  const r = await postUpdateSync({ root: plugin, project, host: 'opencode', runStep });
  assert.equal(r?.outcome, 'synced', JSON.stringify(r));
  assert.ok(calls.includes('retire-host-files.mjs'), calls.join(', '));
});
