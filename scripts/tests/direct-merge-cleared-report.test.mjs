// DIRECT-MERGE CLEARED-ITEM REPORT (board 92f7e826's shim).
//
// SPEC UNDER TEST (dispatch brief, NOT read from implementation): scripts/direct-merge.mjs
// + scripts/hooks/lib/settlement.mjs's new explainReconcileDebtLiveness partition open
// reconcile_needed items covering the branch's changed files into CLEARED (content now
// matches the owning article's baseline — a board_remove-only close would silently drop
// debt, since board_remove never re-stamps the article's file_baselines) vs still-LIVE
// (genuinely drifted) before deciding whether to refuse the merge. Both partitions are
// reported to stderr; stdout stays pure JSON on success. This file authors tests from
// THAT SPEC, not from scripts/direct-merge.mjs or scripts/hooks/lib/settlement.mjs, which
// were not read.
//
// Reuses the fixture idiom (makeGitProjectNoRun / runDirectMerge / sha256hex / envelope /
// articleWithBaseline) from scripts/tests/h7-settlement-minting.test.mjs, duplicated here
// rather than imported (that file exports nothing; test files are not designed as modules).
//
// CAUTION (anti-pattern ee89c3fd): raw child-process stderr is NEVER interpolated directly
// into an assertion message expected to fail — always flattened via oneLine() first, so a
// multi-line diagnostic cannot start a YAML line and misdirect the TAP crash classifier.
//
// NINE BEHAVIORS, each test names its SABOTAGE in the test title (documented intent —
// sabotages are never applied in this file):
//   1. CONTROL (placed first) — a LIVE item still refuses; proves the cleared-report
//      cannot be satisfied by declaring everything cleared.
//   2. TARGET — a baseline-matching item is named on stderr while the merge proceeds.
//   3. stdout purity — the cleared report never lands on stdout.
//   4. The report appears on the REFUSAL path too (mixed live + cleared).
//   5. all_exempt wording — a generated-projection-only item cites the exemption + e1275166.
//   6. baseline_absent is reported UNVERIFIED, never conflated with a clean/cleared match.
//   7. FAIL-CLOSED — a dangling feature_link is treated as live, never cleared.
//   8. FAIL-CLOSED — a deleted governed file is treated as drift, never cleared.
//   9. Scoping — liveness is computed over file_keys ∩ changed-on-this-branch only.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-08-24T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function sha256hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Flatten any child-process stream before it goes into an assertion message
 * that might fail — anti-pattern ee89c3fd. */
function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function envelope(type, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function articleWithBaseline(store, slug, files, at = NOW) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((f) => ({ path: f.path, role: 'impl' })),
    file_baselines: Object.fromEntries(
      files.filter((f) => f.baseline !== null).map((f) => [f.path, f.baseline !== undefined ? f.baseline : sha256hex(f.content)])
    ),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'originating brief' }],
    live_test_refs: [],
  });
}

function reconcileItem(store, { article, path, paths, feature_link } = {}) {
  const file_keys = paths ?? [path];
  return store.create({
    ...envelope('todo'),
    text: `reconcile — ${file_keys.join(', ')}`,
    source: 'system',
    system_reason: 'reconcile_needed',
    file_keys,
    feature_link: feature_link !== undefined ? feature_link : article.id,
  });
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
  return (r.stdout ?? '').trim();
}

function makeGitProjectNoRun() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dm-cleared-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runDirectMerge(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

function openStore(dir) {
  return new SterlingStore(join(dir, '.sterling', 'sterling.db'));
}

// =========================================================================
// 1. CONTROL — a LIVE item still refuses; the cleared-report cannot be
//    satisfied by declaring everything cleared.
// =========================================================================

test('1 [control]: a live item (article baseline != committed content) still refuses, and the cleared-report marker is absent — sabotage: pushing every covering item into the cleared partition regardless of the predicate, which must flip this red (exit 0 and/or a cleared marker present)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const original = 'export const t = 1;\n';
    const changed = 'export const t = 2;\n';
    const store = openStore(dir);
    const article = articleWithBaseline(store, 'feat-live', [{ path: 'src/touched.mjs', content: original }]);
    reconcileItem(store, { article, path: 'src/touched.mjs' });
    store.close();

    git(dir, ['checkout', '-b', 'feat/live']);
    writeFileSync(join(dir, 'src', 'touched.mjs'), changed);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change touched file']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a genuinely-drifted article must still refuse the merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /reconcile_needed/);
    assert.doesNotMatch(r.stderr, /content now MATCHES/, 'a still-live item must never be reported through the cleared-report marker');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 2. TARGET — a baseline-matching item is named on stderr, merge proceeds.
// =========================================================================

test('2 [target]: a baseline-matching item is named on the cleared report while the merge proceeds — sabotage: deleting the cleared-report console.error block entirely, which must flip this red (none of the cleared-report phrases present)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const changed = 'export const t = 2;\n';
    const store = openStore(dir);
    const article = articleWithBaseline(store, 'feat-cleared', [{ path: 'src/touched.mjs', content: changed }]);
    const item = reconcileItem(store, { article, path: 'src/touched.mjs' });
    store.close();

    git(dir, ['checkout', '-b', 'feat/cleared']);
    writeFileSync(join(dir, 'src', 'touched.mjs'), changed);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change touched file to what the baseline already reflects']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `a stale, baseline-matching item must not block the merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/cleared');
    assert.ok(r.stderr.includes(item.id), 'cleared report names the item id');
    assert.ok(r.stderr.includes('src/touched.mjs'), 'cleared report names the item file_keys');
    assert.match(r.stderr, /content now MATCHES/, 'cleared report states the content now matches the baseline');
    assert.match(r.stderr, /not with board_remove alone/i, 'cleared report instructs closing via an article write, not board_remove alone');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 3. stdout purity — the cleared report never lands on stdout.
// =========================================================================

test('3 [stdout purity]: same fixture as (2) — stdout stays valid, pure JSON despite a cleared item being reported — sabotage: emitting the cleared report via console.log instead of console.error, which must flip this red (JSON.parse(stdout) throws)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const changed = 'export const t = 2;\n';
    const store = openStore(dir);
    const article = articleWithBaseline(store, 'feat-cleared-2', [{ path: 'src/touched.mjs', content: changed }]);
    reconcileItem(store, { article, path: 'src/touched.mjs' });
    store.close();

    git(dir, ['checkout', '-b', 'feat/cleared-2']);
    writeFileSync(join(dir, 'src', 'touched.mjs'), changed);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change touched file to what the baseline already reflects']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `expected a clean merge — stderr=${oneLine(r.stderr)}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'stdout must remain pure, parseable JSON even when a cleared item is reported on stderr');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 4. Report appears on the REFUSAL path too — mixed live + cleared.
// =========================================================================

test('4 [refusal path]: one live item and one cleared item, both covering branch-changed files — stderr reports BOTH, exit refuses on the live one — sabotage: moving the cleared-report emission inside an `else` of `if (debt.length > 0)` so it never runs on the refusal path, which must flip this red (cleared line absent on refusal)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const originalA = 'export const a = 1;\n';
    const changedA = 'export const a = 2;\n';
    const originalB = 'export const b = 1;\n';
    const changedB = 'export const b = 2;\n';
    const store = openStore(dir);
    const articleA = articleWithBaseline(store, 'feat-mixed-live', [{ path: 'src/a.mjs', content: originalA }]);
    // Article B's baseline is stamped to the NEW bytes the branch is about to
    // commit (changedB) — simulating a reconcile that already landed for B —
    // so the predicate reads "matches" only once the branch's real commit
    // lands, not because the file never changed at all.
    const articleB = articleWithBaseline(store, 'feat-mixed-cleared', [{ path: 'src/b.mjs', content: changedB }]);
    const itemB = reconcileItem(store, { article: articleB, path: 'src/b.mjs' });
    reconcileItem(store, { article: articleA, path: 'src/a.mjs' });
    store.close();

    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.mjs'), originalA);
    writeFileSync(join(dir, 'src', 'b.mjs'), originalB);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed a and b']);

    git(dir, ['checkout', '-b', 'feat/mixed']);
    writeFileSync(join(dir, 'src', 'a.mjs'), changedA);
    writeFileSync(join(dir, 'src', 'b.mjs'), changedB); // genuinely different bytes than main (originalB) — a real branch change, matching B's stamped baseline
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change a (drift); change b to what its baseline was already stamped to (no drift)']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `article A is genuinely still drifted and must refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /reconcile_needed/);
    assert.ok(r.stderr.includes('src/a.mjs'), 'refusal names the still-live path');
    assert.ok(r.stderr.includes(itemB.id) || r.stderr.includes('src/b.mjs'), 'the cleared item is still reported on the refusal path');
    assert.match(r.stderr, /content now MATCHES/, 'the cleared report fires even though the overall merge refuses');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 5. all_exempt wording — generated-projection-only item.
// =========================================================================

test('5 [all_exempt]: an item whose only file_key is a configured generated projection, genuinely drifted, is reported via the exemption wording and cites e1275166 — sabotage: collapsing every non-live reason (baseline_match, all_exempt, baseline_absent) into one generic "cleared" string, which must flip this red (no "generated projection" text, no e1275166 citation)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const original = '# generated overview\n';
    const changed = '# generated overview v2\n';
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ generated_projections: ['docs/generated/overview.md'] }));
    mkdirSync(join(dir, 'docs', 'generated'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'generated', 'overview.md'), original);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed generated projection']);

    const store = openStore(dir);
    const article = articleWithBaseline(store, 'feat-exempt', [{ path: 'docs/generated/overview.md', content: original }]);
    reconcileItem(store, { article, path: 'docs/generated/overview.md' });
    store.close();

    git(dir, ['checkout', '-b', 'feat/exempt']);
    writeFileSync(join(dir, 'docs', 'generated', 'overview.md'), changed);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'regenerate projection (genuine drift, but exempt)']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `an all-exempt item must not block the merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /generated projection/i, 'the exempt reason is worded distinctly, not folded into a generic cleared string');
    assert.match(r.stderr, /e1275166/, 'the exemption cites the governing ruling');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 6. baseline_absent — reported UNVERIFIED, never conflated with clean.
// =========================================================================

test('6 [baseline_absent]: an article with no recorded baseline for the item\'s path is reported UNVERIFIED, distinct from a clean/baseline-match close — sabotage: folding the baseline_absent branch into the baseline_match branch (treating "no baseline" as "matches"), which must flip this red (report says matched/clean instead of UNVERIFIED)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'q.mjs'), 'export const q = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed q']);

    const store = openStore(dir);
    // file_baselines deliberately carries NO entry for src/q.mjs.
    const article = articleWithBaseline(store, 'feat-no-baseline', [{ path: 'src/q.mjs', content: null, baseline: null }]);
    reconcileItem(store, { article, path: 'src/q.mjs' });
    store.close();

    git(dir, ['checkout', '-b', 'feat/no-baseline']);
    writeFileSync(join(dir, 'src', 'q.mjs'), 'export const q = 2;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change q; no baseline exists to compare against']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `baseline_absent stays exit 0 per spec — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /UNVERIFIED, not clean/, 'baseline_absent is reported unverified, never described as a clean/matching close');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 7. FAIL-CLOSED — dangling feature_link.
// =========================================================================

test('7 [fail-closed, dangling link]: an item whose feature_link resolves to no article, covering a changed file, is treated as live (refuses), never cleared — sabotage: treating article-unresolvable as live:false (cleared) instead of fail-closed live:true, which must flip this red (exit 0 and/or a cleared line for this item)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'r.mjs'), 'export const rr = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed r']);

    const store = openStore(dir);
    const danglingId = randomUUID(); // never created as a record
    const item = reconcileItem(store, { path: 'src/r.mjs', feature_link: danglingId });
    store.close();

    git(dir, ['checkout', '-b', 'feat/dangling']);
    writeFileSync(join(dir, 'src', 'r.mjs'), 'export const rr = 2;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change r under a dangling reconcile item']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `an unresolvable article must fail closed and refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /content now MATCHES/, 'a fail-closed dangling-link item is never reported through the cleared marker');
    void item;
  } finally {
    cleanup();
  }
});

// =========================================================================
// 8. FAIL-CLOSED — deleted governed file.
// =========================================================================

test('8 [fail-closed, deleted file]: a governed file with a recorded baseline that is DELETED on the branch is treated as drift (refuses) — sabotage: making contentChangedAgainstBaseline return false when the file is unreadable/missing instead of true, which must flip this red (exit 0, deletion silently treated as no drift)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const original = 'export const p = 1;\n';
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'p.mjs'), original);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed p']);

    const store = openStore(dir);
    const article = articleWithBaseline(store, 'feat-deleted', [{ path: 'src/p.mjs', content: original }]);
    reconcileItem(store, { article, path: 'src/p.mjs' });
    store.close();

    git(dir, ['checkout', '-b', 'feat/deleted']);
    git(dir, ['rm', 'src/p.mjs']);
    git(dir, ['commit', '-m', 'delete governed file p']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `deletion of a governed, baselined file must be treated as drift and refuse — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /reconcile_needed/);
  } finally {
    cleanup();
  }
});

// =========================================================================
// 9. Scoping — liveness computed over file_keys ∩ changed-on-this-branch.
// =========================================================================

test('9 [scoping]: an item grouping a changed, baseline-matching path with an UNCHANGED, drifted path is reported cleared — liveness is scoped to file_keys intersected with paths actually changed on this branch — sabotage: passing the full item\'s file_keys (including the untouched, drifted path) into the liveness check instead of the branch-scoped intersection, which must flip this red (exit != 0, item not reported cleared)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const xOriginal = 'export const x = 1;\n';
    const xNew = 'export const x = 2;\n';
    const yContent = 'export const y = 1;\n'; // never touched on the branch

    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.mjs'), xOriginal);
    writeFileSync(join(dir, 'src', 'y.mjs'), yContent);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed x and y']);

    const store = openStore(dir);
    // x's baseline matches what the branch will commit; y's baseline is
    // deliberately wrong (drifted) but y is never touched on this branch.
    const article = articleWithBaseline(store, 'feat-scoped', [
      { path: 'src/x.mjs', content: xNew },
      { path: 'src/y.mjs', content: 'export const y = 999;\n' }, // baseline != yContent
    ]);
    const item = reconcileItem(store, { article, paths: ['src/x.mjs', 'src/y.mjs'] });
    store.close();

    git(dir, ['checkout', '-b', 'feat/scoped']);
    writeFileSync(join(dir, 'src', 'x.mjs'), xNew);
    // src/y.mjs deliberately left untouched on this branch.
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change x only; y is pre-existing drift outside this branch']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `only x is in scope for this branch and x matches baseline — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.ok(r.stderr.includes(item.id) || r.stderr.includes('src/x.mjs'), 'the item is reported cleared, scoped to the changed path');
    assert.match(r.stderr, /content now MATCHES/);
  } finally {
    cleanup();
  }
});
