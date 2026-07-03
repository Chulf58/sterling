// Runtime visibility check (spec §12): blocks the first pipeline run until the
// installed agent set is confirmed visible — every registered agent installed
// and the current session started after the newest install (project subagents
// load at session start).
//   node scripts/check-agents-visible.mjs --target <projectDir> --session-started <ISO>
// Exit codes: 0 = visible; 2 = not visible (reasons listed, loud).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { checkAgentsVisible } from './lib/agent-distribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const targetDir = flag('--target') ? resolve(flag('--target')) : process.cwd();
const sessionStartedAt = flag('--session-started');
if (!sessionStartedAt) {
  console.error('usage: check-agents-visible.mjs --target <projectDir> --session-started <ISO timestamp>');
  process.exit(2);
}

const { visible, problems } = checkAgentsVisible({
  registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
  targetAgentsDir: join(targetDir, '.claude', 'agents'),
  sessionStartedAt,
  // Executability probe (anti_pattern 60e8463d): a machine-context flip leaves
  // baked hook node paths unresolvable while visibility alone still passes —
  // the gate must block on dead enforcement, not just an absent roster.
  probeExecutability: true,
});

if (visible) {
  console.log('agent set visible: ok');
  process.exit(0);
}
console.error('agent set NOT visible — pipeline runs are blocked:');
for (const p of problems) console.error(`  ${p.name}: ${p.reason}${p.detail ? ` (${p.detail})` : ''}`);
console.error('If reasons include restart_required, restart Claude Code in this project.');
if (problems.some((p) => p.reason === 'hook_node_unresolvable')) {
  console.error(
    'If reasons include hook_node_unresolvable, the installed agents were baked by the OTHER\n' +
      'machine context (WSL vs native Windows) and every hook of those agents fails non-blocking:\n' +
      'run /sterling:sync-agents FROM THIS context (re-bakes as machine_rebaked), then restart\n' +
      'Claude Code in this project.'
  );
}
process.exit(2);
