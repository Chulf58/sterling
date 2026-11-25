// fs-move: conductor-invoked rename that additionally updates
// file_keys on every owning record AS PART OF THE MOVE — renames inside the
// machinery never orphan knowledge. A registered debug scope is metadata only
// and never refuses a path (decision debug-scope-is-metadata-fs-helpers-stop-refusing).
//   node scripts/fs-move.mjs <from> <to> [--target <dir>]
import { renameSync } from 'node:fs';
import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRepoPath } from '@sterling/schemas';
import { arg, fail, openProject } from './lib/project.mjs';
import { requireCheckoutRoot } from './lib/checkout-root-guard.mjs';
import { resolveStoreRoot } from './lib/worktree-root.mjs';
import { ContainmentError, containedPath, existsContained, mkdirContained } from './lib/contained-fs.mjs';
import { observePaths } from './hooks/lib/reconcile-origins.mjs';

const target = arg('--target') ?? process.cwd();
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== target);
if (positional.length !== 2) fail('usage: fs-move.mjs <from> <to> [--target <dir>]');
const from = normalizeRepoPath(positional[0]);
const to = normalizeRepoPath(positional[1]);

// Paths are checkout-relative; the store is the main checkout's when --target is a
// linked worktree (GitHub issue #331, as in fs-remove).
requireCheckoutRoot(target, 'fs-move', 'moved');
const storeRoot = resolveStoreRoot(target);
const { store } = openProject(storeRoot);
try {
  try {
    containedPath(target, from, 'file');
    containedPath(target, to, 'file');
    if (!existsContained(target, from, 'file')) fail(`fs-move REFUSED: '${from}' does not exist`, 2);
    if (existsContained(target, to, 'file')) fail(`fs-move REFUSED: '${to}' already exists`, 2);
    const toDir = posix.dirname(to);
    if (toDir !== '.') mkdirContained(target, toDir);
  } catch (e) {
    if (e instanceof ContainmentError) fail(`fs-move REFUSED: ${e.message}; nothing was moved`, 2);
    throw e;
  }
  renameSync(containedPath(target, from, 'file'), containedPath(target, to, 'file'));
  const rewritten = store.renameFileKey(from, to);
  // Reconcile obligation for the owning article(s), matching fs-remove's H7
  // semantics (audit finding 36/43): a rename rewrites file_keys but leaves
  // the article's prose/history naming the old path. Query on the post-rename
  // key `to` — file_keys were just rewritten.
  const now = new Date().toISOString();
  // Checkout evidence, as in fs-remove (decision maintenance-reconciliation-retains-checkout-evidence-and-use).
  const seen = observePaths(target, [from, to], storeRoot);
  for (const article of store.query({ types: ['feature_article'], file_keys: [to], cap: 100 })) {
    // Atomic, (reason, feature_link, file)-keyed dedup in the store — one
    // definition instead of the four hand-rolled copies that raced each other
    // and dropped a second file's finding (board 2ded3b4b).
    store.enqueueSystemTodo({
      id: randomUUID(), type: 'todo', created_at: now, updated_at: now, author: 'system', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [],
      text: `reconcile article '${article.slug}' — '${from}' was renamed to '${to}'`,
      source: 'system', system_reason: 'reconcile_needed', file_keys: [to], feature_link: article.id,
      ...(seen ? { observations: seen.observations } : {}),
    }, { operation_id: randomUUID() });
  }
  console.log(JSON.stringify({ moved: { from, to }, records_rewritten: rewritten }));
} finally {
  store.close();
}
