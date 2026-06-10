// H10 — direct-path capture check + review (spec §6 H10). Stop, soft.
// Direct mode only: artifact-produced-but-no-capture → first Stop prompts the
// conductor to capture inline (exit 2, soft block); still missing on the next
// Stop → maintenance queue (capture_owed) and the session may end. Code-
// touching work also gets the deterministic reviewer-selection result;
// test-touching work records check_skipped {test-integrity} (script lands at
// step 8 with the pipeline baseline machinery).
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, deny, allow, openStore, loadConfig } from './lib/common.mjs';
import { selectReviewers } from '../reviewer-selection.mjs';
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

  const earliest = touches.map((t) => t.at).sort()[0];
  const captured = store
    .query({ types: ['decision', 'anti_pattern', 'note', 'feature_article'], cap: 1000, include_unconfirmed: true })
    .some((r) => r.created_at >= earliest || r.updated_at >= earliest);
  if (captured) {
    rmSync(touchesPath, { force: true });
    rmSync(nagMarker, { force: true });
    allow();
  }

  const config = parseConfig(loadConfig(input.cwd) ?? {}); // schema defaults apply (reviewer_selection sets etc.)
  const now = new Date().toISOString();

  // test-touching → test-integrity vs git HEAD (§8.2); non-git degrades loud
  const testGlobs = (config.toolchains ?? []).flatMap((tc) => tc.test_globs ?? []);
  let integrityNote = '';
  if (touches.some((t) => testGlobs.some((g) => matchesGlob(t.path, g)))) {
    const ti = gitTestIntegrity({ cwd: input.cwd, testGlobs });
    if (ti.no_git) store.recordCheckSkipped('test-integrity', 'no_git', undefined, now);
    else if (ti.modified.length || ti.deleted.length) {
      integrityNote = `\nTest-integrity vs git HEAD: modified ${JSON.stringify(ti.modified)}, deleted ${JSON.stringify(ti.deleted)} — review these before capture.`;
    }
  }

  // code-touching → deterministic reviewer selection (paths only at this surface)
  const diff = [...new Set(touches.map((t) => t.path))].map((path) => ({ path, added_lines: [] }));
  const selection = selectReviewers({ config, diff });

  if (!input.stop_hook_active && !existsSync(nagMarker)) {
    writeFileSync(nagMarker, JSON.stringify({ at: now }));
    deny(
      `H10: direct-mode work touched ${touches.length} file(s) but nothing was captured (no decision/note/article since ${earliest}).\n` +
        `Capture what was learned inline (knowledge_create), or state explicitly that nothing durable was learned.\n` +
        `Reviewer selection for this diff: dispatch ${JSON.stringify(selection.dispatch)}; skipped ${JSON.stringify(selection.skipped)}.` +
        integrityNote
    );
  }

  // second pass: still uncaptured — queue it and let the session end (P1: don't trap the human)
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
      text: `capture owed: direct-mode session touched ${touches.length} file(s) and ended without capture`,
      source: 'system',
      system_reason: 'capture_owed',
      file_keys: [...new Set(touches.map((t) => t.path))].slice(0, 20),
    });
  }
  rmSync(touchesPath, { force: true });
  rmSync(nagMarker, { force: true });
  allow();
} finally {
  store.close();
}
