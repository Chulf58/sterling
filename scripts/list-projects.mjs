// /sterling:projects — list the machine-global project registry (decision foreign_8f9e6db2).
// Read-only by default; stale-at-read: a project whose repo_path no longer exists
// is flagged MISSING (the registry stores no liveness). `--prune-missing` removes
// ONLY entries whose path is gone (human-gated; never live projects).
// `--remove <path>` previews deleting <path>/.sterling and unregistering the
// project; `--remove <path> --apply` does it, backup first, refusing while the
// store is open (decision remove-a-project-store-list-projects-remove-backup-first-refuse-if-open,
// GitHub #109). The script never prompts; the caller asks the user between the two.
//   node scripts/list-projects.mjs [--prune-missing]
//   node scripts/list-projects.mjs --remove <path> [--apply]
import { existsSync } from 'node:fs';
import { ProjectRegistry, registryPath } from '@sterling/store';
import { removeProject } from './lib/project-remove.mjs';

function usage(msg) {
  console.error(`list-projects REFUSED: ${msg}\nusage: list-projects.mjs [--prune-missing] | --remove <path> [--apply]`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { prune: false, remove: undefined, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prune-missing') out.prune = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--remove') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage('--remove needs a path');
      if (out.remove !== undefined) usage('--remove given more than once');
      out.remove = v;
    } else usage(`unknown argument '${a}'`);
  }
  if (out.apply && out.remove === undefined) usage('--apply needs --remove <path>');
  if (out.prune && out.remove !== undefined) usage('--prune-missing and --remove cannot be combined');
  return out;
}

function listProjects(prune) {
  if (prune) {
    let removed = 0;
    for (const p of registry.list()) {
      if (!existsSync(p.repo_path)) {
        registry.remove(p.repo_path);
        removed++;
      }
    }
    console.log(`Pruned ${removed} missing project${removed === 1 ? '' : 's'}.\n`);
  }

  const rows = registry.list();
  if (!rows.length) {
    console.log('No projects registered yet — run /sterling:init in a project to register it.');
    return;
  }

  console.log(`${rows.length} registered Sterling project${rows.length === 1 ? '' : 's'}:\n`);
  for (const p of rows) {
    const live = existsSync(p.repo_path);
    const tags = p.stack_tags.length ? p.stack_tags.join(', ') : '—';
    const tools = p.toolchains.length ? p.toolchains.join(', ') : '—';
    const seen = p.last_seen_at ? p.last_seen_at.slice(0, 10) : 'never';
    console.log(`${live ? '•' : '✗'} ${p.name}  (${p.repo_path})${live ? '' : '  — MISSING'}`);
    console.log(`    domains/tags: [${tags}]   toolchains: [${tools}]   sterling: ${p.sterling_version ?? '?'}`);
    console.log(`    first init: ${p.first_init_at.slice(0, 10)}   last init: ${p.last_init_at.slice(0, 10)}   last seen: ${seen}`);
  }
  const missing = rows.filter((p) => !existsSync(p.repo_path)).length;
  if (missing && !prune) {
    console.log(`\n${missing} project${missing === 1 ? '' : 's'} MISSING (path gone). Prune with: node "<Sterling root>/bin/list-projects.mjs" --prune-missing`);
  }
}

// Runs last, after every module-level constant is initialized.
const args = parseArgs(process.argv.slice(2));
const registry = new ProjectRegistry(registryPath());
try {
  // The real /proc and no callback: no environment variable changes the safety checks.
  if (args.remove !== undefined) process.exitCode = removeProject(registry, args.remove, { apply: args.apply });
  else listProjects(args.prune);
} finally {
  registry.close();
}
