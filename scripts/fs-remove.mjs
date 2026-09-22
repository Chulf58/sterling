// fs-remove (spec §7.1): scope-checked deletion (scripts/lib/debug-scope.mjs's
// scopeCheck), registers the file-touch so owning articles get reconciled.
// This is a conductor-invoked, scope-checked operation.
//   node scripts/fs-remove.mjs <path>... [--target <dir>]
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRepoPath } from '@sterling/schemas';
import { arg, fail, openProject } from './lib/project.mjs';
import { scopeCheck, readDebugScope } from './lib/debug-scope.mjs';

const target = arg('--target') ?? process.cwd();
const paths = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== target);
if (!paths.length) fail('usage: fs-remove.mjs <repo-relative path>... [--target <dir>]');

const { store } = openProject(target);
const debugScope = readDebugScope(target);
const now = new Date().toISOString();

const removed = [];
try {
  for (const p of paths) {
    const rel = normalizeRepoPath(p);
    const scope = scopeCheck({ debugScope, rel });
    if (scope.deny) fail(`fs-remove REFUSED (nothing deleted): ${scope.deny}`, 2);
    if (!existsSync(join(target, rel))) fail(`fs-remove REFUSED: '${rel}' does not exist`, 2);
  }
  for (const p of paths) {
    const rel = normalizeRepoPath(p);
    rmSync(join(target, rel));
    removed.push(rel);
    // file-touch registration (H7 semantics): owners need reconciliation
    for (const article of store.query({ types: ['feature_article'], file_keys: [rel], cap: 100 })) {
      // Atomic, (reason, feature_link, file)-keyed dedup in the store — one
      // definition instead of the four hand-rolled copies that raced each other
      // and dropped a second file's finding (board 2ded3b4b).
      store.enqueueSystemTodo({
        id: randomUUID(), type: 'todo', created_at: now, updated_at: now, author: 'system', status: 'active',
        superseded_by: null, links: [], scope: 'project', stack_tags: [],
        text: `reconcile article '${article.slug}' — '${rel}' was removed`,
        source: 'system', system_reason: 'reconcile_needed', file_keys: [rel], feature_link: article.id,
      });
    }
  }
} finally {
  store.close();
}
console.log(JSON.stringify({ removed }));
