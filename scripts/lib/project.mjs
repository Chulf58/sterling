// Shared plumbing for conductor-invoked [S] scripts (prep, checks, dispose-run,
// merge-gate): target-project resolution, config, store, args.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, MountedStores, resolveDomainMounts } from '@sterling/store';

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

// Resolve the store path + config once; both openers share the existsSync guard,
// the single config parse, and the one P5 failure path.
function resolveProject(cwd) {
  const dbPath = join(cwd, '.sterling', 'sterling.db');
  if (!existsSync(dbPath)) fail(`no Sterling store at ${dbPath} — not an initialized project`);
  const configPath = join(cwd, '.sterling', 'config.json');
  let config;
  try {
    config = parseConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {});
  } catch (e) {
    fail(`malformed .sterling/config.json — failing loud, never half-applying (P5): ${e.message}`);
  }
  return { dbPath, config };
}

// Bare project store — for project-local work: run/board/transient state and
// owner-lookup by repo file_key (a repo path only ever matches project-scoped
// records, so domain mounts buy that path nothing — §3.3).
export function openProject(cwd = process.cwd()) {
  const { dbPath, config } = resolveProject(cwd);
  return { cwd, store: new SterlingStore(dbPath), config };
}

// Domain-aware store (§3.4/P6): the project store fanned across the mounted
// domain stores (the config.stack_tags manifest, resolveDomainMounts — the same
// resolver the MCP server and dispose-run use). For retrieval that must see
// shared knowledge — prep's knowledge_pack. Run/board/transient writes still
// land in the project store (MountedStores forwards them). Same return shape as
// openProject, so callers swap one for the other.
export function openMounted(cwd = process.cwd()) {
  const { dbPath, config } = resolveProject(cwd);
  return { cwd, store: new MountedStores(dbPath, resolveDomainMounts(config)), config };
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
