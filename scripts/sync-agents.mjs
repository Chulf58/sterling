// /sterling:sync-agents (spec §13): refresh init-installed agents when plugin
// templates change. Hash compare via generated headers; refuses to overwrite a
// locally modified generated agent (three-way review stubbed to
// refuse-and-instruct per spec §16.1 Slice 1).
//   node scripts/sync-agents.mjs --target <projectDir>
// Exit codes: 0 = synced/up-to-date; 2 = at least one refusal (loud).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { syncAgents } from './lib/agent-distribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetDir = targetIdx !== -1 ? resolve(args[targetIdx + 1]) : process.cwd();

const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;

const { report, restartInstruction } = syncAgents({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(targetDir, '.claude', 'agents'),
  pluginVersion,
  now: new Date().toISOString(),
  vars: {
    NODE: `"${process.execPath.replace(/\\/g, '/')}"`,
    HOOKS_DIR: join(pluginRoot, 'hooks').replace(/\\/g, '/'),
  },
});

let refused = 0;
let changed = 0;
for (const r of report) {
  console.log(`${r.status}: ${r.name}`);
  if (r.instruction) {
    refused += 1;
    console.error('\n' + r.instruction + '\n');
  }
  if (r.status === 'installed' || r.status === 'refreshed' || r.status === 'header_repaired') changed += 1;
}
if (report.length === 0) console.log('no agents registered — nothing to sync');
if (changed > 0) console.log('\n' + restartInstruction);
process.exit(refused > 0 ? 2 : 0);
