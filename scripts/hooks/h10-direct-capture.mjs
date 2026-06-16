// H10 — direct-path capture check + review (spec §6 H10). Stop, soft.
// Direct mode only: artifact-produced-but-no-capture → first Stop prompts the
// conductor to capture inline (exit 2, soft block); still missing on the next
// Stop → maintenance queue (capture_owed) and the session may end. Code-
// touching work also gets the deterministic reviewer-selection result;
// test-touching work records check_skipped {test-integrity} (script lands at
// step 8 with the pipeline baseline machinery).
// Article demand (§6 H10, adjudicated 2026-06-11): touched files no
// feature_article owns, at threshold or any new unowned file (vs git HEAD;
// no-git degrades loud) → the nag demands the OWNING ARTICLE inline; still
// missing at session end → article_missing maintenance item. General capture
// does NOT satisfy the demand — only ownership does (the unowned set
// recomputes per Stop, so creating the article clears it mechanically).
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, deny, allow, openStore, loadConfig } from './lib/common.mjs';
import { selectReviewers } from '../lib/reviewer-selection.mjs';
import { gitTestIntegrity } from '../lib/test-integrity.mjs';
import { matchesGlob, parseConfig } from '@sterling/schemas';

const input = readStdin();
const store = openStore(input.cwd);
if (!store) allow();

const touchesPath = join(input.cwd, '.sterling', 'transient', 'touches.json');
const nagMarker = join(input.cwd, '.sterling', 'transient', 'capture-nagged.json');

try {
  if (store.getRun()) allow(); // pipeline runs are H9's territory
  if (!existsSync(touchesPath)) allow();
  const touches = JSON.parse(readFileSync(touchesPath, 'utf8'));
  if (!touches.length) allow();

  const config = parseConfig(loadConfig(input.cwd) ?? {}); // schema defaults apply (reviewer_selection sets etc.)
  const now = new Date().toISOString();
  // §6 H10: only files that STILL EXIST drive a demand — a file created and then
  // deleted within the session (e.g. a throwaway) leaves a stale H7 touch entry
  // but needs no owner and no capture. (raw rm doesn't update the register;
  // fs-remove does — that asymmetry is the gap this guards.)
  const paths = [...new Set(touches.map((t) => t.path))].filter((p) => existsSync(join(input.cwd, p)));
  if (!paths.length) {
    rmSync(touchesPath, { force: true });
    rmSync(nagMarker, { force: true });
    allow();
  }

  const earliest = touches.map((t) => t.at).sort()[0];
  const captured = store
    .query({ types: ['decision', 'anti_pattern', 'note', 'feature_article'], cap: 1000, include_unconfirmed: true })
    .some((r) => r.created_at >= earliest || r.updated_at >= earliest);

  // §6 H10 article demand: touched files nothing owns, at threshold or any new
  // unowned file (vs git HEAD; no-git degrades loud to threshold-only).
  // Ownership joins feature_article AND repo-located reference docs (§3.2.5) —
  // same join as H7; a governing document's owner is its reference_material
  // record, never a forced feature article (adjudicated 2026-06-12).
  const unowned = paths.filter(
    (p) => store.query({ types: ['feature_article', 'reference_material'], file_keys: [p], cap: 1 }).length === 0
  );
  let newUnowned = [];
  if (unowned.length) {
    const head = spawnSync('git', ['ls-tree', '-r', 'HEAD', '--name-only', '--', ...unowned], {
      cwd: input.cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (head.status === 0) {
      const inHead = new Set(head.stdout.split('\n').filter(Boolean));
      newUnowned = unowned.filter((p) => !inHead.has(p));
    } else {
      store.recordCheckSkipped('article-demand-newfile', 'no_git', undefined, now);
    }
  }
  const articleDemand = unowned.length >= config.article_demand.min_unowned_files || newUnowned.length > 0;

  if (captured && !articleDemand) {
    rmSync(touchesPath, { force: true });
    rmSync(nagMarker, { force: true });
    allow();
  }

  // test-touching → test-integrity vs git HEAD (§8.2); non-git degrades loud
  const testGlobs = (config.toolchains ?? []).flatMap((tc) => tc.test_globs ?? []);
  let integrityNote = '';
  if (!captured && paths.some((p) => testGlobs.some((g) => matchesGlob(p, g)))) {
    const ti = gitTestIntegrity({ cwd: input.cwd, testGlobs });
    if (ti.no_git) store.recordCheckSkipped('test-integrity', 'no_git', undefined, now);
    else if (ti.modified.length || ti.deleted.length) {
      integrityNote = `\nTest-integrity vs git HEAD: modified ${JSON.stringify(ti.modified)}, deleted ${JSON.stringify(ti.deleted)} — review these before capture.`;
    }
  }

  if (!input.stop_hook_active && !existsSync(nagMarker)) {
    writeFileSync(nagMarker, JSON.stringify({ at: now }));
    const parts = [];
    if (!captured) {
      // code-touching → deterministic reviewer selection (paths only at this surface)
      const diff = paths.map((path) => ({ path, added_lines: [] }));
      const selection = selectReviewers({ config, diff });
      parts.push(
        `H10: direct-mode work touched ${paths.length} file(s) but nothing was captured (no decision/note/article since ${earliest}).\n` +
          `Capture what was learned inline (knowledge_create), or state explicitly that nothing durable was learned.\n` +
          `Reviewer selection for this diff: dispatch ${JSON.stringify(selection.dispatch)}; skipped ${JSON.stringify(selection.skipped)}.` +
          integrityNote
      );
    }
    if (articleDemand) {
      parts.push(
        `H10 article demand (§6): ${unowned.length} touched file(s) have no owner (feature_article or repo-located reference doc)` +
          `${newUnowned.length ? ` (${newUnowned.length} newly created)` : ''}: ${JSON.stringify(unowned.slice(0, 20))}.\n` +
          `Create or extend the owning article(s) NOW (knowledge_create type feature_article; for a governing document, reference_material kind doc) — the knowledge is freshest before this session ends; general capture does not satisfy this.`
      );
    }
    deny(parts.join('\n\n'));
  }

  // second pass: still owed — queue it and let the session end (P1: don't trap the human)
  if (!captured) {
    const open = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'capture_owed');
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
        text: `capture owed: direct-mode session touched ${paths.length} file(s) and ended without capture`,
        source: 'system',
        system_reason: 'capture_owed',
        file_keys: paths.slice(0, 20),
      });
    }
  }
  if (articleDemand) {
    const openArticle = store
      .query({ types: ['todo'], cap: 1000 })
      .some((t) => t.source === 'system' && t.system_reason === 'article_missing' && (t.file_keys ?? []).some((k) => unowned.includes(k)));
    if (!openArticle) {
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
        text: `article missing: direct-mode work touched ${unowned.length} file(s) nothing owns (feature_article or repo-located reference doc)${newUnowned.length ? ` (${newUnowned.length} newly created)` : ''} — create the owning article(s) (§6 H10 / §12 accretion)`,
        source: 'system',
        system_reason: 'article_missing',
        file_keys: unowned.slice(0, 20),
      });
    }
  }
  rmSync(touchesPath, { force: true });
  rmSync(nagMarker, { force: true });
  allow();
} finally {
  store.close();
}
