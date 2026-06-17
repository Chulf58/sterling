// /sterling:projects — list the machine-global project registry (decision 8f9e6db2).
// Read-only by default; stale-at-read: a project whose repo_path no longer exists
// is flagged MISSING (the registry stores no liveness). `--prune-missing` removes
// ONLY entries whose path is gone (human-gated; never live projects).
//   node scripts/list-projects.mjs [--prune-missing]
import { existsSync } from 'node:fs';
import { ProjectRegistry, registryPath } from '@sterling/store';

const prune = process.argv.includes('--prune-missing');
const registry = new ProjectRegistry(registryPath());
try {
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
    process.exit(0);
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
    console.log(`\n${missing} project${missing === 1 ? '' : 's'} MISSING (path gone). Prune with: node scripts/list-projects.mjs --prune-missing`);
  }
} finally {
  registry.close();
}
