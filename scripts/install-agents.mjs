// Install concrete agents from plugin templates into a target project's
// .claude/agents/ (spec §2.2, §12). Invoked by /sterling:init (later step) and
// usable standalone:  node scripts/install-agents.mjs --target <projectDir>
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { installAgents } from './lib/agent-distribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetDir = targetIdx !== -1 ? resolve(args[targetIdx + 1]) : process.cwd();

const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;

const { report, restartInstruction } = installAgents({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(targetDir, '.claude', 'agents'),
  pluginVersion,
  now: new Date().toISOString(),
});

for (const r of report) console.log(`${r.status}: ${r.name}`);
if (report.length === 0) console.log('no agents registered — nothing installed');
else console.log('\n' + restartInstruction);
