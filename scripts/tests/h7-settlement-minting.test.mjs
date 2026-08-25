// H7 CANDIDATE-ONLY + SETTLEMENT-TIME MINTING (board c198866d).
//
// SPEC UNDER TEST (consult-approved design, NOT YET IMPLEMENTED — every test
// below is expected to be RED, or at minimum unproven, against today's code):
//
// H7's direct-mode Arm 1 stops minting reconcile_needed at touch time — it
// only registers candidate paths (the transient touch register it already
// writes for H10, .sterling/transient/touches.json, IS the candidate set).
// Minting moves to SETTLEMENT: (a) direct-session Stop after capture/reconcile
// writes, (b) pre-merge as hard backstop, (c) run completion — commit alone is
// deliberately NOT a settlement boundary. At settlement: hash only FINAL
// touched paths against the owning article's file_baselines (sha256 of the
// owned file's bytes, decision 57d9a52d) — no mint for edit-then-revert; no
// mint if an intervening knowledge write already rebaselined the article;
// group remaining paths per article (one item per article, not per path).
// ALSO: direct-merge re-evaluates the LIVE predicate (contentChanged against
// CURRENT baselines) before refusing on an open reconcile_needed queue item —
// a stale row must not block the merge on its own authority. H7's Arm 2
// (read-time drift detection) is UNCHANGED and is not exercised here.
//
// This file covers ONLY settlement-at-Stop (h10-direct-capture.mjs, since that
// is the hook already wired to consume touches.json at Stop) and the
// direct-merge live-predicate re-evaluation. Pre-merge-as-backstop and
// run-completion settlement (spec clauses b/c) are NOT covered here — no
// declared interface for either surface exists in scripts/tests/ today, and
// inventing one would violate the never-invent-an-interface boundary.
//
//   AC1 (H7, touch time) — a governed touch registers the candidate path in
//        touches.json but mints NO reconcile_needed item at touch time.
//   AC2 (settlement, positive control) — settlement at Stop mints exactly one
//        reconcile_needed item, grouped on the owning article, when the final
//        touched content differs from the article's file_baselines entry.
//        This is the CONTROL for AC3/AC4 below: it proves the mint mechanism
//        actually fires when warranted, so a "no mint" verdict elsewhere
//        cannot be explained by a settlement path that is simply dead.
//   AC3 (edit-then-revert) — final content equal to the baseline mints
//        nothing, even though the file was touched.
//   AC4 (intervening rebaseline) — a knowledge write that already moved the
//        article's file_baselines to match current content (simulating a
//        reconcile that landed between touch and settlement) suppresses the
//        mint, even though the file's content DID change since the ORIGINAL
//        baseline. This is a distinct failure mode from AC3: an
//        implementation that freezes the baseline it compares against at
//        touch time (rather than re-reading it live at settlement) would
//        pass AC3 but fail AC4.
//   AC5 (grouping) — two changed paths owned by the SAME article settle to
//        ONE item carrying both file_keys, not two items.
//   AC6a (direct-merge, control) — an open reconcile_needed item whose live
//        predicate is TRUE (current content really does differ from the
//        owning article's baseline) still refuses the merge — proving the
//        live re-check is not "never refuse anything now".
//   AC6b (direct-merge, target) — an open reconcile_needed item whose live
//        predicate is FALSE (the owning article's baseline already matches
//        current content — a stale row) does NOT block the merge, even
//        though the item itself is still open. Paired with AC6a: together
//        they pin content-sensitivity rather than "always refuse" (old
//        behavior, breaks AC6b) or "never refuse" (breaks AC6a).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-24T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function sha256hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const H10_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeH10Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-settlement-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(H10_CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
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

/** feature_article owning `files` (array of {path, content}); file_baselines
 * keyed per path = sha256 of the given ORIGINAL content, mirroring how a
 * real article's baseline is server-computed from content at create/reconcile
 * time (decision 57d9a52d). */
function articleWithBaseline(store, slug, files, at = NOW) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((f) => ({ path: f.path, role: 'impl' })),
    file_baselines: Object.fromEntries(files.map((f) => [f.path, sha256hex(f.content)])),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'originating brief' }],
    live_test_refs: [],
  });
}

function writeOwnedFile(dir, path, content) {
  const abs = join(dir, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Registers touches.json entries WITHOUT touching file content — the caller
 * writes actual file bytes separately via writeOwnedFile so settlement hashes
 * the fixture's deliberately-chosen final content. */
function registerTouches(dir, paths, at = NOW) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function captureDecision(store, at = NOW) {
  return store.create({ ...envelope('decision', at), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
}

const stop = (dir, env = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir, env);
const reconcileItems = (store) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.source === 'system' && t.system_reason === 'reconcile_needed');

// =========================================================================
// AC1 — H7 touch time: candidate-only, no mint
// =========================================================================

test('AC1 [H7 touch time]: a governed touch lands in the candidate register but mints NO reconcile_needed item — sabotage: reinstate an immediate enqueueSystemTodo(\'reconcile_needed\', ...) call inside H7\'s PostToolUse handler, which must flip this red', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    store.create({
      ...envelope('feature_article'),
      slug: 'feat-a',
      title: 'feat-a',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/a.mjs', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });

    const r = runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'src', 'a.mjs') } }), dir);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(reconcileItems(store).length, 0, 'H7 Arm 1 must not mint reconcile_needed at touch time any more — minting moves to settlement');

    // CONTROL: the touch must still land in the candidate register — this
    // rules out the degenerate "H7 does nothing at all" reading of a zero
    // mint count (a dead hook would also show zero mints here).
    const touches = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'touches.json'), 'utf8'));
    assert.ok(touches.some((t) => t.path === 'src/a.mjs'), 'the touch still registers as a settlement candidate');
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC2 — settlement mints when content differs from baseline (CONTROL for AC3/AC4)
// =========================================================================

test('AC2 [settlement, control]: Stop mints exactly one reconcile_needed item, grouped on the owning article, when final content differs from the article baseline — sabotage: delete/no-op the settlement mint step, which must flip this red (0 items)', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    const original = 'export const b = 1;\n';
    const changed = 'export const b = 2;\n';
    const article = articleWithBaseline(store, 'feat-b', [{ path: 'src/b.mjs', content: original }]);
    writeOwnedFile(dir, 'src/b.mjs', changed);
    registerTouches(dir, ['src/b.mjs']);
    captureDecision(store, NOW);

    const r = stop(dir);
    assert.equal(r.code, 0, `settlement Stop must not itself soft-block once capture/article-demand duties are satisfied — stderr=${r.stderr}`);

    const items = reconcileItems(store);
    assert.equal(items.length, 1, 'exactly one reconcile_needed item minted for the changed path');
    assert.equal(items[0].feature_link, article.id, 'grouped on the owning article');
    assert.deepEqual([...items[0].file_keys].sort(), ['src/b.mjs']);
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC3 — edit-then-revert mints nothing
// =========================================================================

test('AC3 [edit-then-revert]: final content equal to the baseline mints nothing, even though the path was touched — sabotage: mint unconditionally for every touched+owned path regardless of a content comparison, which must flip this red (>=1 item)', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    const original = 'export const c = 1;\n';
    articleWithBaseline(store, 'feat-c', [{ path: 'src/c.mjs', content: original }]);
    // touched, but the FINAL on-disk content is byte-identical to the baseline
    writeOwnedFile(dir, 'src/c.mjs', original);
    registerTouches(dir, ['src/c.mjs']);
    captureDecision(store, NOW);

    const r = stop(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reconcileItems(store).length, 0, 'edit-then-revert must mint nothing (see AC2 above for proof the mechanism can mint at all)');
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC4 — an intervening knowledge write that already rebaselined suppresses the mint
// =========================================================================

test('AC4 [intervening rebaseline]: a knowledge write that already moved the article baseline to match current content suppresses the mint, even though content changed since the ORIGINAL baseline — sabotage: compare final content against the baseline captured AT TOUCH TIME instead of re-reading the CURRENT article baseline at settlement, which must flip this red (1 item minted)', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    const original = 'export const d = 1;\n';
    const changed = 'export const d = 2;\n';
    // The article's baseline is created ALREADY matching the CHANGED content —
    // simulating a reconcile (knowledge_update) that landed between the touch
    // and settlement and rebaselined the article to current reality.
    const article = articleWithBaseline(store, 'feat-d', [{ path: 'src/d.mjs', content: changed }]);
    writeOwnedFile(dir, 'src/d.mjs', changed);
    registerTouches(dir, ['src/d.mjs']);
    captureDecision(store, NOW);
    void original; // documents what the content changed FROM; never written to disk in this fixture

    const r = stop(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reconcileItems(store).length, 0, 'the intervening rebaseline already made the article true again — nothing left to reconcile');
    void article;
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC5 — multiple changed paths owned by one article settle to ONE grouped item
// =========================================================================

test('AC5 [grouping]: two changed paths owned by the SAME article settle to ONE item carrying both file_keys — sabotage: mint one reconcile_needed item PER FILE instead of grouping per owning article, which must flip this red (2 items, or 1 item missing a file_key)', () => {
  const { dir, store, cleanup } = makeH10Project();
  try {
    const article = articleWithBaseline(store, 'feat-e', [
      { path: 'src/e1.mjs', content: 'export const e1 = 1;\n' },
      { path: 'src/e2.mjs', content: 'export const e2 = 1;\n' },
    ]);
    writeOwnedFile(dir, 'src/e1.mjs', 'export const e1 = 2;\n');
    writeOwnedFile(dir, 'src/e2.mjs', 'export const e2 = 2;\n');
    registerTouches(dir, ['src/e1.mjs', 'src/e2.mjs']);
    captureDecision(store, NOW);

    const r = stop(dir);
    assert.equal(r.code, 0, r.stderr);

    const items = reconcileItems(store);
    assert.equal(items.length, 1, 'AC5: two changed paths under one article settle to ONE item, not two');
    assert.equal(items[0].feature_link, article.id);
    assert.deepEqual([...items[0].file_keys].sort(), ['src/e1.mjs', 'src/e2.mjs'], 'the single item carries BOTH changed paths');
  } finally {
    cleanup();
  }
});

// --------------------------- direct-merge live predicate ---------------------------

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeGitProjectNoRun() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dm-settle-'));
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

// =========================================================================
// AC6a — direct-merge, control: live predicate TRUE still refuses
// =========================================================================

test('AC6a [direct-merge, control]: an open reconcile_needed item whose live predicate is TRUE (content really differs from the owning article baseline) still refuses the merge — sabotage: remove the reconcile_needed refusal check from direct-merge.mjs entirely, which must flip this red (merge succeeds)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const original = 'export const t = 1;\n';
    const changed = 'export const t = 2;\n';
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const article = store.create({
      ...envelope('feature_article'),
      slug: 'feat-live-true',
      title: 'feat-live-true',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/touched.mjs', role: 'impl' }],
      file_baselines: { 'src/touched.mjs': sha256hex(original) },
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    const item = store.create({
      ...envelope('todo'),
      text: "reconcile article 'feat-live-true' — file changed",
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['src/touched.mjs'],
      feature_link: article.id,
    });
    store.close();

    git(dir, ['checkout', '-b', 'feat/live-true']);
    writeFileSync(join(dir, 'src', 'touched.mjs'), changed);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change touched file']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a genuinely-still-drifted article must still refuse the merge — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /reconcile_needed/);
    assert.match(r.stderr, /src\/touched\.mjs/);
    void item;
  } finally {
    cleanup();
  }
});

// =========================================================================
// AC6b — direct-merge, target: live predicate FALSE does not block (stale row)
// =========================================================================

test('AC6b [direct-merge, target]: a stale reconcile_needed item whose live predicate is now FALSE (article baseline already matches current content) does NOT block the merge — sabotage: refuse on ANY open reconcile_needed item matching file_keys without re-hashing against current baselines (today\'s behavior), which must flip this red (merge refuses)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const changed = 'export const t = 2;\n';
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    // The article's baseline is created ALREADY matching what the branch will
    // commit — i.e. the article was already reconciled to current reality by
    // the time this queue item is (still, staleley) sitting open.
    const article = store.create({
      ...envelope('feature_article'),
      slug: 'feat-live-false',
      title: 'feat-live-false',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/touched.mjs', role: 'impl' }],
      file_baselines: { 'src/touched.mjs': sha256hex(changed) },
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    store.create({
      ...envelope('todo'),
      text: "reconcile article 'feat-live-false' — stale row, already reconciled",
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['src/touched.mjs'],
      feature_link: article.id,
    });
    store.close();

    git(dir, ['checkout', '-b', 'feat/live-false']);
    writeFileSync(join(dir, 'src', 'touched.mjs'), changed);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change touched file to what the article baseline already reflects']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `a stale queue row whose live predicate is false must not block the merge on its own authority — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/live-false');
  } finally {
    cleanup();
  }
});
