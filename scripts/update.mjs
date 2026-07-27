// /sterling:update [S] — bring THIS machine's Sterling clone to origin's default
// branch (decision e6240afe-e94b-4c1f-8eed-bafe32fb4d89).
//
// Every machine but the authoring one is a pure consumer: the update is a
// fast-forward or a loud refusal, never a hand reconciliation against GitHub.
// The logic (refusal matrix + step order) lives in lib/update.mjs so it is
// testable without a network; this file is the CLI — target resolution, the
// active-run guard, and the project fan-out list.
//
//   node scripts/update.mjs [--check] [--force] [--no-fetch] [--no-test]
//                           [--no-projects] [--target <sterling clone>]
//
// Exit codes: 0 = updated or already current · 1 = a step failed · 2 = refused
// (nothing mutated) or an agent-sync refusal in a consuming project.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectRegistry, registryPath, SterlingStore } from '@sterling/store';
import { arg } from './lib/project.mjs';
import { runUpdate } from './lib/update.mjs';

// DEFAULT TARGET IS THE PLUGIN ROOT, not cwd: this command is invoked from
// consuming projects as ${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs, and the thing
// being updated is the Sterling clone this script lives in — never the project
// it was invoked from.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(arg('--target') ?? pluginRoot);

const opts = {
  check: process.argv.includes('--check'),
  force: process.argv.includes('--force'),
  fetch: !process.argv.includes('--no-fetch'),
  test: !process.argv.includes('--no-test'),
  projects: !process.argv.includes('--no-projects'),
};

// A run owns the whole working tree (§8.1) — fast-forwarding and rebuilding
// under it would pull the ground out from the phase in flight.
const dbPath = resolve(target, '.sterling', 'sterling.db');
if (existsSync(dbPath)) {
  const store = new SterlingStore(dbPath);
  const active = store.getRun();
  store.close();
  if (active && !opts.check) {
    console.error(
      `update: run '${active.id}' is active (${active.machine_state}) — a run owns the working tree. Finish or reject it before updating.`
    );
    process.exit(2);
  }
}

// The fan-out list: every live registered project EXCEPT the Sterling clone
// itself (the init ensure pass inside runUpdate already syncs that one). Read
// before the update so a mid-update npm ci can never race the registry import.
const norm = (p) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
let projects = [];
if (opts.projects && !opts.check) {
  const registry = new ProjectRegistry(registryPath());
  try {
    projects = registry
      .list()
      .filter((p) => existsSync(p.repo_path) && norm(p.repo_path) !== norm(target))
      .map((p) => ({ name: p.name, repo_path: p.repo_path }));
  } finally {
    registry.close();
  }
}

const report = runUpdate({ cwd: target, projects, opts });
process.exit(report.exit);
