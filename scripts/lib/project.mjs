// Shared plumbing for conductor-invoked [S] scripts (prep, checks, dispose-run,
// merge-gate): target-project resolution, config, store, args.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';

export function arg(name, argv = process.argv.slice(2)) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

export function argAll(name, argv = process.argv.slice(2)) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[++i]);
  return out;
}

export function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

export function openProject(cwd = process.cwd()) {
  const dbPath = join(cwd, '.sterling', 'sterling.db');
  if (!existsSync(dbPath)) fail(`no Sterling store at ${dbPath} — not an initialized project`);
  const configPath = join(cwd, '.sterling', 'config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  return { cwd, store: new SterlingStore(dbPath), config };
}

export function requireRun(store, runId) {
  const run = store.getRun(runId);
  if (!run) fail(runId ? `no run '${runId}'` : 'no active run');
  return run;
}

export function requireBrief(store, run) {
  const brief = store.get(run.brief_ref);
  if (!brief || brief.type !== 'brief') fail(`brief '${run.brief_ref}' not found for run '${run.id}'`);
  return brief;
}

export function runDir(cwd, runId) {
  return join(cwd, '.sterling', 'runs', runId);
}
