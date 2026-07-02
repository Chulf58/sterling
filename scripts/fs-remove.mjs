// fs-remove (spec §7.1): contract-checked deletion — shares H3's scope logic,
// registers the file-touch so owning articles get reconciled. The H14
// allowlist admits exactly this invocation shape for coder/fixer agents.
//   node scripts/fs-remove.mjs <path>... [--target <dir>]
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRepoPath } from '@sterling/schemas';
import { arg, fail, openProject } from './lib/project.mjs';
import { scopeCheck, readDebugScope } from './hooks/lib/contract.mjs';

const target = arg('--target') ?? process.cwd();
const paths = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== target);
if (!paths.length) fail('usage: fs-remove.mjs <repo-relative path>... [--target <dir>]');

const { store } = openProject(target);
const run = store.getRun();
const brief = run ? store.get(run.brief_ref) : undefined;
const debugScope = run ? undefined : readDebugScope(target);
const now = new Date().toISOString();

const removed = [];
try {
  const amendments = (run?.scope_amendments ?? []).map((a) => a.path);
  for (const p of paths) {
    const rel = normalizeRepoPath(p);
    const scope = scopeCheck({ brief: brief?.type === 'brief' ? brief : undefined, debugScope, rel, amendments });
    if (scope.deny) fail(`fs-remove REFUSED (nothing deleted): ${scope.deny}`, 2);
    if (!existsSync(join(target, rel))) fail(`fs-remove REFUSED: '${rel}' does not exist`, 2);
  }
  for (const p of paths) {
    const rel = normalizeRepoPath(p);
    rmSync(join(target, rel));
    removed.push(rel);
    // file-touch registration (H7 semantics): owners need reconciliation
    for (const article of store.query({ types: ['feature_article'], file_keys: [rel], cap: 100 })) {
      if (run) store.appendRunReconcileNeeded(run.id, article.id);
      else {
        const open = store
          .query({ types: ['todo'], cap: 1000 })
          .some((t) => t.source === 'system' && t.system_reason === 'reconcile_needed' && t.feature_link === article.id);
        if (!open) {
          store.create({
            id: randomUUID(), type: 'todo', created_at: now, updated_at: now, author: 'system', status: 'active',
            superseded_by: null, links: [], scope: 'project', stack_tags: [],
            text: `reconcile article '${article.slug}' — '${rel}' was removed`,
            source: 'system', system_reason: 'reconcile_needed', file_keys: [rel], feature_link: article.id,
          });
        }
      }
    }
  }
} finally {
  store.close();
}
console.log(JSON.stringify({ removed }));
