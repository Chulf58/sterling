// Background maintenance worker RUNNER (decision
// maintenance-worker-drains-every-lane-and-writes-factual-refresh-on-sonnet).
// Started detached by scripts/hooks/lib/maintenance-worker.mjs's launcher from
// H10 (Stop), H19's Bash surface (after a git commit) or a previous run that made
// progress (trigger 'chain'); stdout/stderr go to .sterling/maintenance-worker.log.
// It holds the lock (checked by --token) while the headless child runs, journals
// every close, knowledge write and verdict to .sterling/maintenance-worker.jsonl,
// records the outcome in .sterling/transient/maintenance-worker.state.json for the
// launcher and H1, and re-enters the launcher when work is left.
//   node scripts/maintenance-worker-run.mjs --project <dir> --token <lock token> [--trigger commit|stop|chain] [--budget-usd <n>]
//   node scripts/maintenance-worker-run.mjs --project <dir> --dry-run [--token <lock token>]
// A real run needs the launcher's token: the token binds the batch policy its
// Sterling server enforces, and a run without one is recorded as failed.
// --dry-run prints the exact argv and exits without spawning anything.
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
  // Passed through raw: runWorker records a malformed or zero budget as a
  // failed run (state written, back-off armed) instead of exiting silently.
  else if (a === '--budget-usd' && i + 1 < args.length) budgetUsd = args[++i];
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
