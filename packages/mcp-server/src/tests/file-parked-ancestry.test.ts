import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// ---------------------------------------------------------------------------
// ANCESTRY-AWARE file_parked (feedback: measured wrong 4/12 times — a blob
// surviving only on a branch already merged into base is HISTORY, not a park;
// the deletion is real and belongs on the reconcile/deletion lane instead).
//
// New predicate (spec, not yet implemented — every test below is written
// against this target, not against today's "blob on ANY local branch" scan):
//   a missing file is PARKED iff
//     (a) it still exists on the BASE branch (repo default branch — the
//         deletion hasn't reached base), OR
//     (b) it exists on a branch that is NOT YET merged into base.
//   A blob found ONLY on branches that are fully-merged ancestors of base
//   does NOT park — the deletion reading applies instead.
//
// Harness idiom copied from packages/mcp-server/src/tests/tools.test.ts
// (gitRepo / systemQueue / mkArticle, ~lines 1997-2127) since those helpers
// are module-private to that file.
// ---------------------------------------------------------------------------

const NOW = '2026-06-10T12:00:00.000Z';

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-parked-anc-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  return { dir, store, tools, git, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const systemQueue = (tools: SterlingTools) =>
  tools.boardQuery({ source: 'system' }) as unknown as { id: string; system_reason: string; text: string; file_keys?: string[]; feature_link?: string }[];

const mkArticle = (tools: SterlingTools, slug: string, path: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: [{ path, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record;

// GitHub #121 reversed AC1's original verdict. It used to park against main
// ("the deletion has not reached base"), but main is the merge TARGET: it never
// merges into the work branch, and when the work branch lands the deletion
// lands with it. The park therefore never closed and forbade the right fix.
// Sabotage: drop the inherited-copy check in parkedOnRef and this goes red.
test('AC1 (#121): deleted on the current (feature) branch but still present on base (main) is NOT parked — the deletion lands on main with the branch, so the drop signal fires', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'thing.ts'), 'export const t = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'seed on main');

    // Delete + commit the removal on a feature branch checked out from main.
    // Base (main) still has the file — the deletion is in-flight, not merged.
    git('checkout', '-q', '-b', 'feat/gone');
    git('rm', '-q', 'src/thing.ts');
    git('commit', '-qm', 'remove on feature');

    mkArticle(tools, 'ac1-thing', 'src/thing.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(
      queue.filter((t) => t.system_reason === 'file_parked').length,
      0,
      'main only holds the copy this branch deleted — no DO NOT DROP park'
    );
    const reconciles = queue.filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(reconciles.length, 1, 'the normal drop signal fires instead');
    assert.match(reconciles[0].text, /src\/thing\.ts no longer exists/);
  } finally {
    cleanup();
  }
});

test('AC2 (core defect): a blob surviving ONLY on a branch already merged into base does NOT park — the deletion on base stands', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');

    // Add the file on a side branch, merge it into base, then delete it on
    // base itself. The side branch ref is left in place — its tip is now a
    // fully-merged ANCESTOR of base's current tip, not unmerged work.
    git('checkout', '-q', '-b', 'feat/merged');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'thing.ts'), 'export const t = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'add thing');
    git('checkout', '-q', 'main');
    git('merge', '-q', 'feat/merged'); // fast-forward: main now has the file
    git('rm', '-q', 'src/thing.ts');
    git('commit', '-qm', 'remove on base'); // main's tip now sits ahead of feat/merged

    mkArticle(tools, 'ac2-thing', 'src/thing.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(
      queue.filter((t) => t.system_reason === 'file_parked').length,
      0,
      'the only surviving blob is on a branch that is an ancestor of base — merged history, not a park'
    );
    const reconciles = queue.filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(reconciles.length, 1, 'the deletion reading applies instead');
    assert.match(reconciles[0].text, /no longer exists \(out-of-band deletion\)/);
  } finally {
    cleanup();
  }
});

test('AC3 (regression): absent from base, alive on an UNMERGED branch, still mints file_parked naming that branch', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');

    // Base (main) never has the file at all — it exists only on a side
    // branch that was never merged.
    git('checkout', '-q', '-b', 'feat/parked');
    mkdirSync(join(dir, 'game'), { recursive: true });
    writeFileSync(join(dir, 'game', 'terrain.gd'), 'extends Node\n');
    git('add', '-A');
    git('commit', '-qm', 'terrain on a branch');
    git('checkout', '-q', 'main');

    mkArticle(tools, 'ac3-terrain', 'game/terrain.gd');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'reconcile_needed').length, 0, 'unmerged work still holds the file — not a deletion');
    const parked = queue.filter((t) => t.system_reason === 'file_parked');
    assert.equal(parked.length, 1, "today's correct case stays correct");
    assert.match(parked[0].text, /feat\/parked/, 'names the unmerged branch that holds it');
  } finally {
    cleanup();
  }
});

test('AC4 (regression): outside a git repo entirely, the deletion reading applies — never throws, never parks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-parked-anc-nogit-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW, repoRoot: dir });
  try {
    mkArticle(tools, 'ac4-nogit', 'src/absent.ts');
    assert.doesNotThrow(() => tools.knowledgeQuery({ types: ['feature_article'] }), 'no git at all must fail open, not throw');

    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'reconcile_needed').length, 1, 'the deletion finding is preserved with no git available');
    assert.equal(queue.filter((t) => t.system_reason === 'file_parked').length, 0, 'no ancestry to consult, so nothing parks');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC5 (regression): file present in the working tree — no park, no deletion item, hot path untouched', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'present.ts'), 'export const p = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');

    mkArticle(tools, 'ac5-present', 'src/present.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'file_parked').length, 0, 'the file is right there — nothing to park');
    assert.equal(queue.filter((t) => t.system_reason === 'reconcile_needed').length, 0, 'and nothing missing to reconcile');
  } finally {
    cleanup();
  }
});

// GitHub #121, stale backup: a backup branch cut before the deletion carries
// its own commit, so it is not an ancestor of base and the old ancestry filter
// let it park the path forever (a backup never merges). The path was in the
// merge base of HEAD and the backup, so the backup only kept an inherited copy.
// Sabotage: drop the inherited-copy check in parkedOnRef and this goes red.
test('AC6 (#121): alive only on a stale non-ancestor backup branch does NOT park — the backup kept an inherited copy and never merges', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'old.ts'), 'export const o = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'seed with old.ts');

    git('checkout', '-q', '-b', 'backup/before-cleanup');
    writeFileSync(join(dir, 'notes.txt'), 'backup only\n');
    git('add', '-A');
    git('commit', '-qm', 'backup commit, never merged');
    git('checkout', '-q', 'main');
    git('rm', '-q', 'src/old.ts');
    git('commit', '-qm', 'delete old.ts on purpose');

    mkArticle(tools, 'ac6-old', 'src/old.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'file_parked').length, 0, 'a backup holding an inherited copy must not park the path');
    const reconciles = queue.filter((t) => t.system_reason === 'reconcile_needed');
    assert.equal(reconciles.length, 1, 'the normal drop signal fires instead');
    assert.match(reconciles[0].text, /src\/old\.ts no longer exists/);
  } finally {
    cleanup();
  }
});

// Control for the fail-safe direction: when base ADDED the path after this
// branch diverged, the copy on base is new work that reaches this branch only
// when base is merged in. That is a real park and must stay one.
test('AC7: added on base after this branch diverged still parks against base — only an inherited copy is released', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    git('checkout', '-q', '-b', 'feat/behind');
    git('checkout', '-q', 'main');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'new.ts'), 'export const n = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'add new.ts on main');
    git('checkout', '-q', 'feat/behind');

    mkArticle(tools, 'ac7-new', 'src/new.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'reconcile_needed').length, 0, 'never tell a reader to drop a path main just added');
    const parked = queue.filter((t) => t.system_reason === 'file_parked');
    assert.equal(parked.length, 1);
    assert.match(parked[0].text, /ALIVE on 'main'/);
  } finally {
    cleanup();
  }
});

// GitHub #121 (c): a park that remains must say how to release it, naming the
// branch so the reader can act without reading the code.
test('AC8 (#121): a legitimate park (added on another branch, absent here) still parks and its text says how to release it', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    writeFileSync(join(dir, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    git('checkout', '-q', '-b', 'feat/active');
    mkdirSync(join(dir, 'game'), { recursive: true });
    writeFileSync(join(dir, 'game', 'terrain.gd'), 'extends Node\n');
    git('add', '-A');
    git('commit', '-qm', 'terrain on a branch');
    git('checkout', '-q', 'main');

    mkArticle(tools, 'ac8-terrain', 'game/terrain.gd');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const parked = systemQueue(tools).filter((t) => t.system_reason === 'file_parked');
    assert.equal(parked.length, 1, 'a path added on another branch still parks');
    assert.match(parked[0].text, /ALIVE on 'feat\/active'/);
    assert.match(parked[0].text, /DO NOT DROP game\/terrain\.gd/);
    assert.match(parked[0].text, /TO RELEASE IT/, 'says how to release the park');
    assert.match(parked[0].text, /git branch -D feat\/active/, 'names the branch to delete when it will never merge');
    assert.match(parked[0].text, /maintenance_remove/, 'and how the item itself is closed');
  } finally {
    cleanup();
  }
});

// Sol review fix round (#121): presence at the merge base does not make a
// branch's copy inherited. A copy CHANGED after the split is live work that
// conflicts with this branch's deletion, so it must keep the park. Sabotage:
// compare only presence at the merge base (not the tree entry) and both of
// the tests below go red.
test('AC9 (#121): HEAD deleted the path but another branch MODIFIED it after the split — still parks against that branch', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'live.ts'), 'export const v = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'seed with live.ts');

    git('checkout', '-q', '-b', 'feat/edits');
    writeFileSync(join(dir, 'src', 'live.ts'), 'export const v = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'modify live.ts on a branch');
    git('checkout', '-q', 'main');
    git('rm', '-q', 'src/live.ts');
    git('commit', '-qm', 'delete live.ts on main');

    mkArticle(tools, 'ac9-live', 'src/live.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'reconcile_needed').length, 0, 'never tell a reader to drop a path another branch is still changing');
    const parked = queue.filter((t) => t.system_reason === 'file_parked');
    assert.equal(parked.length, 1);
    assert.match(parked[0].text, /ALIVE on 'feat\/edits'/);
  } finally {
    cleanup();
  }
});

test('AC10 (#121): HEAD deleted the path but another branch deleted and RE-ADDED it with other content — still parks against that branch', () => {
  const { dir, tools, git, cleanup } = gitRepo();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'readd.ts'), 'export const r = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'seed with readd.ts');

    git('checkout', '-q', '-b', 'feat/readd');
    git('rm', '-q', 'src/readd.ts');
    git('commit', '-qm', 'drop readd.ts');
    mkdirSync(join(dir, 'src'), { recursive: true }); // git rm removed the emptied directory
    writeFileSync(join(dir, 'src', 'readd.ts'), 'export const r = 99;\n');
    git('add', '-A');
    git('commit', '-qm', 're-add readd.ts with new content');
    git('checkout', '-q', 'main');
    git('rm', '-q', 'src/readd.ts');
    git('commit', '-qm', 'delete readd.ts on main');

    mkArticle(tools, 'ac10-readd', 'src/readd.ts');
    tools.knowledgeQuery({ types: ['feature_article'] });

    const queue = systemQueue(tools);
    assert.equal(queue.filter((t) => t.system_reason === 'reconcile_needed').length, 0);
    const parked = queue.filter((t) => t.system_reason === 'file_parked');
    assert.equal(parked.length, 1);
    assert.match(parked[0].text, /ALIVE on 'feat\/readd'/);
  } finally {
    cleanup();
  }
});
