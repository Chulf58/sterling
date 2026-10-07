// /sterling:sync-agents (spec §13): refresh init-installed agents when plugin
// templates change. Hash compare via generated headers; refuses to overwrite a
// locally modified generated agent (three-way review stubbed to
// refuse-and-instruct per spec §16.1 Slice 1).
//   node scripts/sync-agents.mjs --target <projectDir>
// Exit codes: 0 = synced/up-to-date (config_drift is reported, never a refusal —
// decision 256d1059); 2 = at least one refusal (loud), including a
// refused conductor activation (route A). /sterling:update reports a refusal as
// a per-project failure: it exits non-zero, its core completion marker stays
// valid, and it revisits the project on every later update until the refusal
// clears.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { parseConfig } from '@sterling/schemas';
import { syncAgents, agentChangesRequireRestart, ensureConductorActivation, describeConfigDrift } from './lib/agent-distribution.mjs';
import { syncOpenCodeAgents, OPENCODE_AGENTS_DIR } from './lib/opencode-agents.mjs';
import { setupOpenCode, formatOpenCodeRows } from './lib/opencode-install.mjs';
import { isSterlingClone, readProjectMode, ProjectModeError, readHandoffSetting, handoffUnmaintainedNotice, HandoffSettingError, HANDOFF_OFF_DETAIL } from './lib/handoff-projection.mjs';
import { ContainmentError } from './lib/contained-fs.mjs';
import { workIdentityRefusal } from './lib/project-identity.mjs';
import { probeClaudeWithOverride } from './lib/claude-probe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetDir = targetIdx !== -1 ? resolve(args[targetIdx + 1]) : process.cwd();

const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;

// Project mode (decision project-mode-hobby-work-toggle-decides-flow), read
// from the TARGET's own config. Nothing below depends on which mode it is (the
// mode decides only how work ships); an INVALID value is still a refusal
// (exit 2) naming the value, and nothing is synced until it is fixed.
let projectMode;
try {
  projectMode = readProjectMode(targetDir);
} catch (err) {
  if (!(err instanceof ProjectModeError) && !(err instanceof ContainmentError)) throw err;
  console.log(`refused_project_mode: ${err.message}; nothing synced`);
  process.exit(2);
}
// A WORK project must carry its identity (decision
// work-project-identity-file-sterling-project-json); a project is checked when it is in work mode or its config.storage is postgres.
const identityRefusal = workIdentityRefusal(targetDir, projectMode);
if (identityRefusal) {
  console.log(`refused_project_identity: ${identityRefusal}; nothing synced`);
  process.exit(2);
}
// The handoff setting (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting)
// gates the portable copies below. A value that is not true or false, or an
// absent key with a git that could not say what is tracked, is refused the same
// way, before anything is written.
let handoffEnabled;
let handoffUnmaintained;
try {
  ({ enabled: handoffEnabled, unmaintained: handoffUnmaintained } = readHandoffSetting(targetDir));
} catch (err) {
  if (!(err instanceof HandoffSettingError) && !(err instanceof ContainmentError)) throw err;
  console.log(`refused_handoff_setting: ${err.message}; nothing synced`);
  process.exit(2);
}

// Claude Code probe (decision init-without-claude-code-probes-and-skips-claude-artifacts-loudly):
// .claude/agents/ and .claude/settings.json are Claude-only, so on a machine without
// `claude` (the npm copy's post-update sync on an OpenCode-only machine) they are not
// written; one loud line names them. Checked before any write.
let claudeProbe;
try {
  claudeProbe = probeClaudeWithOverride();
} catch (err) {
  console.log(`refused_claude_probe: ${err.message}; nothing synced`);
  process.exit(2);
}
const claudeHost = claudeProbe.installed;

// config.models is the authoritative model/effort source (98064d77): read the
// target project's config when present, else the shipped default config, so a
// refresh resolves {{MODEL}}/{{EFFORT}} to pinned ids (never a leftover token).
const configPath = join(targetDir, '.sterling', 'config.json');
const config = parseConfig(
  JSON.parse(readFileSync(existsSync(configPath) ? configPath : join(pluginRoot, 'templates', 'default-config.json'), 'utf8'))
);

const { report, restartInstruction } = !claudeHost ? { report: [], restartInstruction: '' } : syncAgents({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(targetDir, '.claude', 'agents'),
  pluginVersion,
  now: new Date().toISOString(),
  config,
});

let refused = 0;
for (const r of report) {
  if (r.status === 'config_drift') {
    // Decisions 256d1059 / 587472e3: loud, one line, never a refusal (exit stays 0);
    // nothing written. Names model/effort and/or the tools difference.
    console.log(
      `config_drift: ${r.name} — ${describeConfigDrift(r)}; ` +
        `NOT rewritten by sync — realize it with ${r.fix}, then restart the session`
    );
  } else {
    console.log(`${r.status}: ${r.name}`);
  }
  if (r.instruction) {
    if (r.refused) refused += 1;
    console.error('\n' + r.instruction + '\n');
  }
  if (r.status === 'machine_rebaked') {
    console.error(
      `machine_rebaked: '${r.name}' carried hook commands baked for another machine context — re-baked for THIS machine.`
    );
  }
}
if (!claudeHost) {
  console.log(`⚠ Claude Code not found (${claudeProbe.reason}) — skipped the Claude-only files: .claude/agents/ and .claude/settings.json. Synced the OpenCode side only; install Claude Code and re-run /sterling:init to add them.`);
} else if (report.length === 0) console.log('no agents registered — nothing to sync');

// Sterling on OpenCode 2 (decision
// sterling-on-opencode-installs-global-plugins-plus-untracked-project-config): global
// shims, this project's untracked .opencode/opencode.json and the Sterling-full roster.
// Before the portable copies, so turning the handoff files on narrows the exclude block first.
// Lines start "OpenCode", which /sterling:update's agent-status parser does not count.
const opencodeSetup = setupOpenCode({ projectDir: targetDir, pluginRoot });
for (const line of formatOpenCodeRows(opencodeSetup)) console.log(line);
for (const r of opencodeSetup.rows ?? []) {
  if (r.refused) {
    refused += 1;
    console.error('\n' + r.instruction + '\n');
  }
}

// Portable OpenCode copies (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections): the same
// ownership rules, printed as `<status>: .opencode/agents/<name>.md` so the
// /sterling:update fan-out counts them like any other agent line. A refusal is a
// refusal (exit 2). They need no restart: OpenCode reads them in the other
// engineer's session, not this one. The Sterling clone itself is not a handoff
// target and gets none (said, not silent).
// A containment failure in that probe (a symlinked plugin.json) is a refusal,
// never a guessed answer either way.
// The handoff setting: the portable copies follow config.handoff.enabled
// (handoffEnabled, read above from the TARGET's own config), in hobby and work
// mode alike. Off is a loud skip that deletes nothing. Every run provisions a
// target that has it on, so turning it on is realized by the next sync whatever
// the plugin HEAD is.
let cloneTarget;
try {
  cloneTarget = isSterlingClone(targetDir, pluginRoot);
} catch (err) {
  if (!(err instanceof ContainmentError)) throw err;
  console.log(`refused_unsafe_path: ${OPENCODE_AGENTS_DIR}/ — ${err.message}; portable agents not synced`);
  refused += 1;
  cloneTarget = null;
}
if (cloneTarget) console.log(`portable agents (${OPENCODE_AGENTS_DIR}/) SKIPPED — the target is a Sterling clone, not a handoff target`);
const handoffTarget = cloneTarget === false && handoffEnabled;
if (cloneTarget === false && !handoffTarget) console.log(`portable agents (${OPENCODE_AGENTS_DIR}/) SKIPPED — ${HANDOFF_OFF_DETAIL}`);
// An absent key with handoff files on disk that git does not track: a project
// from before the setting existed stops being maintained, so say which files.
if (cloneTarget === false && handoffUnmaintained.length) console.log(handoffUnmaintainedNotice(handoffUnmaintained));
const { report: opencodeReport } = !handoffTarget
  ? { report: [] }
  : syncOpenCodeAgents({
      templatesDir: join(pluginRoot, 'agent-templates'),
      registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
      targetDir,
    });
for (const r of opencodeReport) {
  console.log(`${r.status}: ${OPENCODE_AGENTS_DIR}/${r.name}.md`);
  if (r.instruction) {
    if (r.refused) refused += 1;
    console.error('\n' + r.instruction + '\n');
  }
}
// Was: "run enforcement_reconcile {adopt:true}… (H17 latch)" — H17's
// config-write taint latch and enforcement_reconcile were both removed per
// decision sterling-claude-code-scale-down-boundary (2ad87dd1); there is no
// latch left to clear. restartInstruction above is the only follow-up needed.
if (agentChangesRequireRestart(report)) console.log('\n' + restartInstruction);

// Route A (decision conductor-instructions-via-main-session-agent-route-a): so
// /sterling:update's sync-agents fan-out also activates the conductor on every sibling.
// Without Claude Code there is no .claude/settings.json to activate (said above).
if (claudeHost) {
  const activationResult = ensureConductorActivation(targetDir, report);
  console.log(`conductor activation: ${activationResult.activation}${activationResult.reason ? ` (${activationResult.reason})` : ''}`);
  console.log(`auto-memory off: ${activationResult.autoMemory}${activationResult.autoMemoryNotice ? ` (${activationResult.autoMemoryNotice})` : ''}`);
  if (activationResult.activation === 'written') {
    console.log(`EXIT AND RELAUNCH: conductor activation newly written in ${activationResult.path}`);
  } else if (activationResult.autoMemory === 'written') {
    console.log(`EXIT AND RELAUNCH: "autoMemoryEnabled": false newly written in ${activationResult.path}`);
  }
  // A refused activation means the conductor is installed but NOT the main-session
  // agent — /sterling:update must not stamp this complete (Sol review HIGH finding).
  if (activationResult.activation === 'refused') refused += 1;
}
// An explicit non-false autoMemoryEnabled is a NOTICE (printed above), never a refusal:
// counting it would fail every /sterling:update on the machine for one project's choice.
process.exit(refused > 0 ? 2 : 0);
