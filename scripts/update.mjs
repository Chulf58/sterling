// /sterling:update [S] — bring THIS machine's Sterling clone to origin's default
// branch (decision foreign_e6240afe).
//
// Every machine but the authoring one is a pure consumer: the update is a
// fast-forward or a loud refusal, never a hand reconciliation against GitHub.
// The logic (refusal matrix + step order) lives in lib/update.mjs so it is
// testable without a network; this file is the CLI — target resolution and
// the project fan-out list.
//
// BOOTSTRAP INDEPENDENCE, learned the hard way: this script must run on a clone
// where NOTHING is built. packages/*/dist is gitignored and building it is one of
// the steps below, so a STATIC `@sterling/store` import crashes the updater with
// ERR_MODULE_NOT_FOUND before it can do the very build that would fix it (caught
// 2026-07-27 by running this against a fresh clone). Therefore: at load time this
// file imports only node builtins and the dependency-free lib/update.mjs; the
// store is imported DYNAMICALLY, after the build, and its absence then is a loud
// per-project failure (exit 2), never an empty registry. The argv reader
// is inlined for the same reason — lib/project.mjs pulls in the workspace
// packages, which is exactly what a fresh clone does not have.
//
//   node scripts/update.mjs [--check] [--force] [--no-fetch] [--no-test]
//                           [--no-projects] [--target <sterling clone>]
//
// AUTHORING machine (machine_role:"authoring" in the clone's config): no fetch,
// no build/check/test, no migration — only the project this was run FROM (cwd)
// has its agents and contract synced; see the AUTHORING branch in runUpdate.
//
// Exit codes: 0 = updated or already current · 1 = a step failed · 2 = refused
// (nothing mutated), a per-project refusal, or an unreadable project registry.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUpdate, reexecArgs, UPDATE_REEXEC_ENV, UPDATE_REEXEC_FROM_ENV } from './lib/update.mjs';

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

/** The store. Imported lazily (see BOOTSTRAP INDEPENDENCE) — by the time the
 *  fan-out asks for it the build has run, so a failure here is a real defect
 *  (unbuilt or broken dist), never an empty registry: it THROWS, and runUpdate
 *  reports it as a per-project refresh failure (exit 2). */
async function loadStoreModule() {
  try {
    return await import('@sterling/store');
  } catch (err) {
    throw new Error(`could not load @sterling/store (packages unbuilt or broken — run npm run build in ${pluginRoot}): ${err?.message ?? err}`);
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

// RE-EXEC GUARD (decision gap-hunt-2026-09-28-rulings item 9; see
// UPDATE_REEXEC_ENV in lib/update.mjs): the first run hands off to the NEW
// updater after a fast-forward; the child carries the env flag, so it builds no
// hook and can never hand off again. Direct node spawn with inherited stdio:
// process.execPath needs no shell or PATH lookup, and the child's output is the
// user's output. runUpdate turns a spawn error or a signal into a loud exit 1.
// The parent also hands over its PRE-merge head (UPDATE_REEXEC_FROM_ENV, review
// HIGH-1) so the child still sees what the pull changed (npm ci), and the
// resolved absolute --target (review LOW-1), since the child's cwd is the target.
const isReexecChild = process.env[UPDATE_REEXEC_ENV] === '1';
if (isReexecChild && process.env[UPDATE_REEXEC_FROM_ENV]) opts.from = process.env[UPDATE_REEXEC_FROM_ENV];
const reexec = isReexecChild
  ? null
  : (script, { from }) => spawnSync(process.execPath, [script, ...reexecArgs(process.argv.slice(2), { target })], {
      cwd: target,
      stdio: 'inherit',
      env: { ...process.env, [UPDATE_REEXEC_ENV]: '1', [UPDATE_REEXEC_FROM_ENV]: from },
    });

// invokingProject: the authoring machine syncs ONLY the project this was run from
// (cwd), never the clone it lives in — see the AUTHORING branch in runUpdate.
const report = await runUpdate({ cwd: target, projects: loadProjects, opts, reexec, invokingProject: process.cwd() });
process.exit(report.exit);
