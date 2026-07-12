// fs-move (spec §7.1): contract-checked rename that additionally updates
// file_keys on every owning record AS PART OF THE MOVE — renames inside the
// machinery never orphan knowledge. H14 admits exactly this invocation shape.
//   node scripts/fs-move.mjs <from> <to> [--target <dir>]
import { renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRepoPath } from '@sterling/schemas';
import { arg, fail, openProject } from './lib/project.mjs';
import { scopeCheck, readDebugScope } from './hooks/lib/contract.mjs';

const target = arg('--target') ?? process.cwd();
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== target);
if (positional.length !== 2) fail('usage: fs-move.mjs <from> <to> [--target <dir>]');
const from = normalizeRepoPath(positional[0]);
const to = normalizeRepoPath(positional[1]);

const { store } = openProject(target);
try {
  const run = store.getRun();
  const brief = run ? store.get(run.brief_ref) : undefined;
  // Fail CLOSED when a run is active but its brief is unresolvable: without a
  // brief AND with debugScope forced undefined during a run, scopeCheck returns
  // allow — the least-guarded state at the exact moment run state is broken (P5
  // inversion; audit finding 20/43). Refuse before any move.
  if (run && (!brief || brief.type !== 'brief')) {
    fail(`fs-move REFUSED (nothing moved): run '${run.id}' active but brief '${run.brief_ref}' not found or not a brief — cannot evaluate scope; failing closed (P5)`, 2);
  }
  const debugScope = run ? undefined : readDebugScope(target);
  const amendments = (run?.scope_amendments ?? []).map((a) => a.path);
  for (const rel of [from, to]) {
    const scope = scopeCheck({ brief: brief?.type === 'brief' ? brief : undefined, debugScope, rel, amendments });
    if (scope.deny) fail(`fs-move REFUSED (nothing moved): ${scope.deny}`, 2);
  }
  if (!existsSync(join(target, from))) fail(`fs-move REFUSED: '${from}' does not exist`, 2);
  if (existsSync(join(target, to))) fail(`fs-move REFUSED: '${to}' already exists`, 2);

  mkdirSync(dirname(join(target, to)), { recursive: true });
  renameSync(join(target, from), join(target, to));
  const rewritten = store.renameFileKey(from, to);
  // Reconcile obligation for the owning article(s), matching fs-remove's H7
  // semantics in BOTH modes (audit finding 36/43): a rename rewrites file_keys
  // but leaves the article's prose/history naming the old path. Query on the
  // post-rename key `to` — file_keys were just rewritten.
  const now = new Date().toISOString();
  for (const article of store.query({ types: ['feature_article'], file_keys: [to], cap: 100 })) {
    if (run) store.appendRunReconcileNeeded(run.id, article.id);
    else {
      const open = store
        .query({ types: ['todo'], cap: 1000 })
        .some((t) => t.source === 'system' && t.system_reason === 'reconcile_needed' && t.feature_link === article.id);
      if (!open) {
        store.create({
          id: randomUUID(), type: 'todo', created_at: now, updated_at: now, author: 'system', status: 'active',
          superseded_by: null, links: [], scope: 'project', stack_tags: [],
          text: `reconcile article '${article.slug}' — '${from}' was renamed to '${to}'`,
          source: 'system', system_reason: 'reconcile_needed', file_keys: [to], feature_link: article.id,
        });
      }
    }
  }
  console.log(JSON.stringify({ moved: { from, to }, records_rewritten: rewritten }));
} finally {
  store.close();
}
