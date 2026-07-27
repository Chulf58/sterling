// /sterling:update [S] — bring THIS machine's Sterling clone to origin's default
// branch (decision e6240afe-e94b-4c1f-8eed-bafe32fb4d89).
//
// Every machine but the authoring one is a pure consumer: the update is a
// fast-forward or a loud refusal, never a hand reconciliation against GitHub.
// The logic (refusal matrix + step order) lives in lib/update.mjs so it is
// testable without a network; this file is the CLI — target resolution, the
// active-run guard, and the project fan-out list.
//
// BOOTSTRAP INDEPENDENCE, learned the hard way: this script must run on a clone
// where NOTHING is built. packages/*/dist is gitignored and building it is one of
// the steps below, so a STATIC `@sterling/store` import crashes the updater with
// ERR_MODULE_NOT_FOUND before it can do the very build that would fix it (caught
// 2026-07-27 by running this against a fresh clone). Therefore: at load time this
// file imports only node builtins and the dependency-free lib/update.mjs; the
// store is imported DYNAMICALLY and its absence degrades loudly. The argv reader
// is inlined for the same reason — lib/project.mjs pulls in the workspace
// packages, which is exactly what a fresh clone does not have.
//
//   node scripts/update.mjs [--check] [--force] [--no-fetch] [--no-test]
//                           [--no-projects] [--target <sterling clone>]
//
// Exit codes: 0 = updated or already current · 1 = a step failed · 2 = refused
// (nothing mutated) or an agent-sync refusal in a consuming project.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUpdate } from './lib/update.mjs';

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

// DEFAULT TARGET IS THE PLUGIN ROOT, not cwd: this command is invoked from
// consuming projects as ${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs, and the thing
// being updated is the Sterling clone this script lives in — never the project
// it was invoked from.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(argOf('--target') ?? pluginRoot);

const opts = {
  check: process.argv.includes('--check'),
  force: process.argv.includes('--force'),
  fetch: !process.argv.includes('--no-fetch'),
  test: !process.argv.includes('--no-test'),
  projects: !process.argv.includes('--no-projects'),
};

/** The store, or null when the packages are not built yet (a fresh clone). */
async function loadStoreModule() {
  try {
    return await import('@sterling/store');
  } catch {
    return null;
  }
}

// A run owns the whole working tree (§8.1) — fast-forwarding and rebuilding
// under it would pull the ground out from the phase in flight.
const dbPath = join(target, '.sterling', 'sterling.db');
if (!opts.check && existsSync(dbPath)) {
  const store = await loadStoreModule();
  if (!store) {
    console.error(
      'update: the workspace packages are not built, so the active-run guard could not run — proceeding, because an unbuilt clone cannot be mid-run. If this machine DID have a run in flight, stop now and finish or reject it first.'
    );
  } else {
    const db = new store.SterlingStore(dbPath);
    const active = db.getRun();
    db.close();
    if (active) {
      console.error(
        `update: run '${active.id}' is active (${active.machine_state}) — a run owns the working tree. Finish or reject it before updating.`
      );
      process.exit(2);
    }
  }
}

// The fan-out list: every live registered project EXCEPT the Sterling clone
// itself (the init ensure pass inside runUpdate already syncs that one). Loaded
// LAZILY, at the fan-out step — by then the build has run, so the store resolves
// even on a clone that had nothing built when the command started.
const norm = (p) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
async function loadProjects() {
  const store = await loadStoreModule();
  if (!store) {
    console.error('update: could not load the project registry (packages still unbuilt) — the per-project agent sync is SKIPPED. Run /sterling:sync-agents in each project, or rerun this command.');
    return [];
  }
  const registry = new store.ProjectRegistry(store.registryPath());
  try {
    return registry
      .list()
      .filter((p) => existsSync(p.repo_path) && norm(p.repo_path) !== norm(target))
      .map((p) => ({ name: p.name, repo_path: p.repo_path }));
  } finally {
    registry.close();
  }
}

const report = await runUpdate({ cwd: target, projects: loadProjects, opts });
process.exit(report.exit);
