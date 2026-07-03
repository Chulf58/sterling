// Install concrete agents from plugin templates into a target project's
// .claude/agents/ (spec §2.2, §12). Invoked by /sterling:init (later step) and
// usable standalone:  node scripts/install-agents.mjs --target <projectDir>
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { parseConfig } from '@sterling/schemas';
import { installAgents } from './lib/agent-distribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const targetDir = targetIdx !== -1 ? resolve(args[targetIdx + 1]) : process.cwd();

const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;

// config.models is the authoritative model/effort source (98064d77): read the
// target project's config when present, else fall back to the shipped default
// config, so a standalone install still resolves {{MODEL}}/{{EFFORT}} to pinned ids.
const configPath = join(targetDir, '.sterling', 'config.json');
const config = parseConfig(
  JSON.parse(readFileSync(existsSync(configPath) ? configPath : join(pluginRoot, 'templates', 'default-config.json'), 'utf8'))
);

// machine-detected, forward-slash, quoted (§6 emission rule)
const vars = {
  NODE: `"${process.execPath.replace(/\\/g, '/')}"`,
  HOOKS_DIR: join(pluginRoot, 'hooks').replace(/\\/g, '/'),
};

const { report, restartInstruction } = installAgents({
  templatesDir: join(pluginRoot, 'agent-templates'),
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(targetDir, '.claude', 'agents'),
  pluginVersion,
  now: new Date().toISOString(),
  vars,
  config,
});

for (const r of report) console.log(`${r.status}: ${r.name}`);
if (report.length === 0) console.log('no agents registered — nothing installed');
else console.log('\n' + restartInstruction);
