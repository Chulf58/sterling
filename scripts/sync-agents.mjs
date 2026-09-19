// /sterling:sync-agents (spec §13): refresh init-installed agents when plugin
// templates change. Hash compare via generated headers; refuses to overwrite a
// locally modified generated agent (three-way review stubbed to
// refuse-and-instruct per spec §16.1 Slice 1).
//   node scripts/sync-agents.mjs --target <projectDir>
// Exit codes: 0 = synced/up-to-date; 2 = at least one refusal (loud).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { parseConfig } from '@sterling/schemas';
import { syncAgents, agentChangesRequireRestart } from './lib/agent-distribution.mjs';

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
  console.log(`${r.status}: ${r.name}`);
  if (r.instruction) {
    if (r.refused) refused += 1;
    console.error('\n' + r.instruction + '\n');
  }
  if (r.status === 'machine_rebaked') {
    console.error(
      `machine_rebaked: '${r.name}' carried hook commands baked for another machine context — re-baked for THIS machine (anti_pattern 60e8463d).`
    );
  }
}
if (report.length === 0) console.log('no agents registered — nothing to sync');
// Was: "run enforcement_reconcile {adopt:true}… (H17 latch)" — H17's
// config-write taint latch and enforcement_reconcile were both removed per
// decision sterling-claude-code-scale-down-boundary (2ad87dd1); there is no
// latch left to clear. restartInstruction above is the only follow-up needed.
if (agentChangesRequireRestart(report)) console.log('\n' + restartInstruction);
process.exit(refused > 0 ? 2 : 0);
