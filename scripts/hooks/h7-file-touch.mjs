// H7 — file-touch reconcile register (spec §6 H7). PostToolUse
// Edit|Write|MultiEdit, non-blocking. Look up owning articles (file-key join);
// mark reconcile_needed on the run (pipeline) or the maintenance queue
// (direct). Direct mode also registers the touch for H10's capture check.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readStdin, allow, warnNonBlocking, openStore, repoRel } from './lib/common.mjs';

const input = readStdin();
const rel = repoRel(input.tool_input?.file_path, input.cwd);
if (!rel) allow();

const store = openStore(input.cwd);
if (!store) allow();

try {
  // §3.2.5: repo-located reference docs (kind: doc) join the reconcile economy —
  // their location doubles as a file_key, so the same join finds them here.
  const owners = store.query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 });
  const run = store.getRun();

  if (run) {
    for (const article of owners) store.appendRunReconcileNeeded(run.id, article.id);
  } else {
    // direct mode: maintenance queue (deduped per record) + transient touch register for H10
    const now = new Date().toISOString();
    for (const article of owners) {
      const open = store
        .query({ types: ['todo'], cap: 1000 })
        .some((t) => t.source === 'system' && t.system_reason === 'reconcile_needed' && t.feature_link === article.id);
      if (!open) {
        store.create({
          id: randomUUID(),
          type: 'todo',
          created_at: now,
          updated_at: now,
          author: 'system',
          status: 'active',
          superseded_by: null,
          links: [],
          scope: 'project',
          stack_tags: [],
          text:
            article.type === 'reference_material'
              ? `reconcile reference '${article.title}' — its document was touched in direct mode; refresh summary + source_date (§3.2.5)`
              : `reconcile article '${article.slug}' — files it owns were touched in direct mode`,
          source: 'system',
          system_reason: 'reconcile_needed',
          file_keys: [rel],
          feature_link: article.id,
        });
      }
    }
    const touchesPath = join(input.cwd, '.sterling', 'transient', 'touches.json');
    mkdirSync(dirname(touchesPath), { recursive: true });
    const touches = existsSync(touchesPath) ? JSON.parse(readFileSync(touchesPath, 'utf8')) : [];
    touches.push({ path: rel, at: now });
    writeFileSync(touchesPath, JSON.stringify(touches));
  }
  allow();
} catch (e) {
  warnNonBlocking(`H7: file-touch registration failed for '${rel}': ${e.message}`);
} finally {
  store.close();
}
