// Background maintenance worker RUNNER (decision
// maintenance-queue-background-haiku-worker-simple-redesign). Started detached
// by scripts/hooks/lib/maintenance-worker.mjs's launcher from H10 (Stop) or
// H19's Bash surface (after a git commit); stdout/stderr go to
// .sterling/maintenance-worker.log. It holds the lock (checked by --token) while
// the headless `claude -p` child runs, journals every maintenance_remove call and
// verdict to .sterling/maintenance-worker.jsonl, and records spend and the outcome
// in .sterling/transient/maintenance-worker.state.json for the launcher and H1.
//   node scripts/maintenance-worker-run.mjs --project <dir> [--trigger commit|stop] [--token <lock token>] [--budget-usd <n>] [--dry-run]
// --dry-run prints the exact claude argv and exits without spawning anything.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pluginRootFrom, runWorker } from './hooks/lib/maintenance-worker.mjs';

const args = process.argv.slice(2);
let project = null;
let trigger = 'manual';
let dryRun = false;
let token;
let budgetUsd;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--project' && args[i + 1]) project = resolve(args[++i]);
  else if (a === '--trigger' && args[i + 1]) trigger = args[++i];
  else if (a === '--token' && args[i + 1]) token = args[++i];
  else if (a === '--budget-usd' && Number(args[i + 1]) > 0) budgetUsd = Number(args[++i]);
  else {
    console.error(`maintenance-worker-run: unrecognized argument '${a}' — usage: maintenance-worker-run.mjs --project <dir> [--trigger <t>] [--token <t>] [--budget-usd <n>] [--dry-run]`);
    process.exit(2);
  }
}
if (!project) {
  console.error('maintenance-worker-run: --project <dir> is required');
  process.exit(2);
}
const pluginRoot = pluginRootFrom(import.meta.url);
if (!pluginRoot) {
  console.error('maintenance-worker-run: plugin root (.claude-plugin/plugin.json) not found above this script');
  process.exit(1);
}
console.error(`maintenance-worker-run: ${new Date().toISOString()} start (trigger ${trigger}, project ${project})`);
try {
  const code = await runWorker({ root: project, pluginRoot, spawn, trigger, dryRun, token, budgetUsd });
  console.error(`maintenance-worker-run: ${new Date().toISOString()} end (exit ${code})`);
  process.exit(code);
} catch (e) {
  console.error(`maintenance-worker-run: FAILED — ${e?.stack ?? e}`);
  process.exit(1);
}
