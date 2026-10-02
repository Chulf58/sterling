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

test('AC1: deleted on the current (feature) branch but still present on base (main) is file_parked — deletion has not reached base', () => {
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
      queue.filter((t) => t.system_reason === 'reconcile_needed').length,
      0,
      'the deletion has not reached base — this must not read as an out-of-band deletion'
    );
    const parked = queue.filter((t) => t.system_reason === 'file_parked');
    assert.equal(parked.length, 1, 'base still holds the file, so it parks');
    assert.match(parked[0].text, /main/, 'names the branch that still holds it (base)');
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
