// H7 — file-touch reconcile register (spec §6 H7). PostToolUse
// Edit|Write|MultiEdit, non-blocking. Look up owning articles (file-key join);
// mark reconcile_needed on the run (pipeline) or the maintenance queue
// (direct). Direct mode also registers the touch for H10's capture check.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readStdin, allow, warnNonBlocking, openStore, repoRel, changedLineRanges, formatLineRanges } from './lib/common.mjs';

const input = readStdin();
const rel = repoRel(input.tool_input?.file_path, input.cwd);
if (!rel) allow();
// machinery internals are never governed work: a commit-message temp file
// under .git/ tripped the register live (2026-06-12) and fed H10 a junk
// article demand — the tree is excluded, not pattern-matched per file
if (rel === '.git' || rel.startsWith('.git/')) allow();

const store = openStore(input.cwd);
if (!store) allow();

try {
  // §3.2.5: repo-located reference docs (kind: doc) join the reconcile economy —
  // their location doubles as a file_key, so the same join finds them here.
  // Records declaring a working_tree describe a DIFFERENT tree (comsoft-juiced
  // 2026-07-17): a same-named path in this session's root is not their file —
  // they never receive a touch-driven reconcile from here.
  const owners = store
    .query({ types: ['feature_article', 'reference_material'], file_keys: [rel], cap: 100 })
    .filter((r) => !r.working_tree);
  const run = store.getRun();

  if (run) {
    for (const article of owners) store.appendRunReconcileNeeded(run.id, article.id);
  } else {
    // direct mode: maintenance queue (deduped per record) + transient touch register for H10
    const now = new Date().toISOString();
    // WHERE the file changed, so a co-owner can dismiss an irrelevant item without
    // re-auditing its article (board b7269100). Best-effort by design: a failed
    // read or a Write with no new_string yields no hint, never an error and never
    // a guess — this is triage help, not a claim.
    let where = '';
    try {
      const ranges = changedLineRanges(input.tool_input, readFileSync(join(input.cwd, rel), 'utf8'));
      if (ranges.length) where = `, near line${ranges.length > 1 || ranges[0][0] !== ranges[0][1] ? 's' : ''} ${formatLineRanges(ranges)}`;
    } catch {
      where = '';
    }
    for (const article of owners) {
      // ONE dedup definition, in the store, ATOMIC (board 2ded3b4b). This used to
      // be a hand-rolled query-then-insert keyed on the ARTICLE — one of four
      // such copies, all racing each other (two concurrent producers each read
      // "no open item" before either insert committed, which is how a consuming
      // project measured seven byte-identical pairs 2-3ms apart) and all omitting
      // the FILE from the key, which silently suppressed a second drifting file's
      // item. enqueueSystemTodo does the check inside the insert transaction and
      // keys on (reason, feature_link, file), so this hook just states the fact.
      store.enqueueSystemTodo({
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
            : `reconcile article '${article.slug}' — owned file ${rel} was touched in direct mode${where}`,
        source: 'system',
        system_reason: 'reconcile_needed',
        file_keys: [rel],
        feature_link: article.id,
      });
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
}
// no close: every path above exits the process, which releases the handle (board f81b1987)
