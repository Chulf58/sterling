// /sterling:sync-agents (spec §13): refresh init-installed agents when plugin
// templates change. Hash compare via generated headers; refuses to overwrite a
// locally modified generated agent (three-way review stubbed to
// refuse-and-instruct per spec §16.1 Slice 1).
//   node scripts/sync-agents.mjs --target <projectDir>
// Exit codes: 0 = synced/up-to-date (config_drift is reported, never a refusal —
// decision 256d1059); 2 = at least one refusal (loud), including a
// refused conductor activation (route A) — /sterling:update must not stamp complete
// while the conductor is installed but not the project's main-session agent.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { parseConfig } from '@sterling/schemas';
import { syncAgents, agentChangesRequireRestart, ensureConductorActivation, describeConfigDrift } from './lib/agent-distribution.mjs';
import { syncOpenCodeAgents, OPENCODE_AGENTS_DIR } from './lib/opencode-agents.mjs';
import { isSterlingClone } from './lib/handoff-projection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetDir = targetIdx !== -1 ? resolve(args[targetIdx + 1]) : process.cwd();

const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;

// config.models is the authoritative model/effort source (98064d77): read the
// target project's config when present, else the shipped default config, so a
// refresh resolves {{MODEL}}/{{EFFORT}} to pinned ids (never a leftover token).
const configPath = join(targetDir, '.sterling', 'config.json');
const config = parseConfig(
  JSON.parse(readFileSync(existsSync(configPath) ? configPath : join(pluginRoot, 'templates', 'default-config.json'), 'utf8'))
);

const { report, restartInstruction } = syncAgents({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(targetDir, '.claude', 'agents'),
  pluginVersion,
  now: new Date().toISOString(),
  vars: {
    NODE: `"${process.execPath.replace(/\\/g, '/')}"`,
    HOOKS_DIR: join(pluginRoot, 'hooks').replace(/\\/g, '/'),
    // the plugin-owned read-only git wrapper; H14 grants only this exact file
    // identity, so templates must name it by absolute path
    GIT_RO: join(pluginRoot, 'scripts', 'git-ro.mjs').replace(/\\/g, '/'),
  },
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
if (report.length === 0) console.log('no agents registered — nothing to sync');

// Portable OpenCode copies (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections): the same
// ownership rules, printed as `<status>: .opencode/agents/<name>.md` so the
// /sterling:update fan-out counts them like any other agent line. A refusal is a
// refusal (exit 2). They need no restart: OpenCode reads them in the other
// engineer's session, not this one. The Sterling clone itself is not a handoff
// target and gets none (said, not silent).
const cloneTarget = isSterlingClone(targetDir, pluginRoot);
if (cloneTarget) console.log(`portable agents (${OPENCODE_AGENTS_DIR}/) SKIPPED — the target is a Sterling clone, not a handoff target`);
const { report: opencodeReport } = cloneTarget
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
const activationResult = ensureConductorActivation(targetDir, report);
console.log(`conductor activation: ${activationResult.activation}${activationResult.reason ? ` (${activationResult.reason})` : ''}`);
if (activationResult.activation === 'written') {
  console.log(`EXIT AND RELAUNCH: conductor activation newly written in ${activationResult.path}`);
}
// A refused activation means the conductor is installed but NOT the main-session
// agent — /sterling:update must not stamp this complete (Sol review HIGH finding).
if (activationResult.activation === 'refused') refused += 1;
process.exit(refused > 0 ? 2 : 0);
