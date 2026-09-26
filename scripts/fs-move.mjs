// fs-move: conductor-invoked rename that additionally updates
// file_keys on every owning record AS PART OF THE MOVE — renames inside the
// machinery never orphan knowledge. A registered debug scope is metadata only
// and never refuses a path (decision debug-scope-is-metadata-fs-helpers-stop-refusing).
//   node scripts/fs-move.mjs <from> <to> [--target <dir>]
import { renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRepoPath } from '@sterling/schemas';
import { arg, fail, openProject } from './lib/project.mjs';

const target = arg('--target') ?? process.cwd();
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== target);
if (positional.length !== 2) fail('usage: fs-move.mjs <from> <to> [--target <dir>]');
const from = normalizeRepoPath(positional[0]);
const to = normalizeRepoPath(positional[1]);

const { store } = openProject(target);
try {
  if (!existsSync(join(target, from))) fail(`fs-move REFUSED: '${from}' does not exist`, 2);
  if (existsSync(join(target, to))) fail(`fs-move REFUSED: '${to}' already exists`, 2);

  mkdirSync(dirname(join(target, to)), { recursive: true });
  renameSync(join(target, from), join(target, to));
  const rewritten = store.renameFileKey(from, to);
  // Reconcile obligation for the owning article(s), matching fs-remove's H7
  // semantics (audit finding 36/43): a rename rewrites file_keys but leaves
  // the article's prose/history naming the old path. Query on the post-rename
  // key `to` — file_keys were just rewritten.
  const now = new Date().toISOString();
  for (const article of store.query({ types: ['feature_article'], file_keys: [to], cap: 100 })) {
    // Atomic, (reason, feature_link, file)-keyed dedup in the store — one
    // definition instead of the four hand-rolled copies that raced each other
    // and dropped a second file's finding (board 2ded3b4b).
    store.enqueueSystemTodo({
      id: randomUUID(), type: 'todo', created_at: now, updated_at: now, author: 'system', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [],
      text: `reconcile article '${article.slug}' — '${from}' was renamed to '${to}'`,
      source: 'system', system_reason: 'reconcile_needed', file_keys: [to], feature_link: article.id,
    });
  }
  console.log(JSON.stringify({ moved: { from, to }, records_rewritten: rewritten }));
} finally {
  store.close();
}
