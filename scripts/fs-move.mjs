// fs-move (spec §7.1): contract-checked rename that additionally updates
// file_keys on every owning record AS PART OF THE MOVE — renames inside the
// machinery never orphan knowledge. H14 admits exactly this invocation shape.
//   node scripts/fs-move.mjs <from> <to> [--target <dir>]
import { renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  if (run) {
    for (const article of store.query({ types: ['feature_article'], file_keys: [to], cap: 100 })) {
      store.appendRunReconcileNeeded(run.id, article.id);
    }
  }
  console.log(JSON.stringify({ moved: { from, to }, records_rewritten: rewritten }));
} finally {
  store.close();
}
