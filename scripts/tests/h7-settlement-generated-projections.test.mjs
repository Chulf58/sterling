// H7 SETTLEMENT-TIME MINTING — GENERATED-PROJECTIONS EXEMPTION (settled
// ruling e1275166: generated projections are exempt from drift machinery;
// the settlement-time minting path introduced in board c198866d dropped that
// exemption — measured 2026-08-25 as a merge-blocking regen<->reconcile loop).
//
// This file is authored BLIND to scripts/hooks/lib/settlement.mjs and every
// file under scripts/hooks/ — the harness idioms below (store fixture setup,
// how the Stop hook and direct-merge.mjs are invoked, baseline mechanics) are
// learned ONLY from the existing scripts/tests/h7-settlement-minting.test.mjs
// and duplicated locally. That file drives mintSettlementReconcile entirely
// through the h10-direct-capture.mjs Stop hook, and isLiveReconcileDebt
// entirely through direct-merge.mjs's live-predicate re-check (its AC6a/AC6b)
// — this suite exercises the exemption through the exact same two surfaces,
// never by importing the settlement library directly (no such import exists
// in the file this suite is allowed to learn from).
//
// SPEC UNDER TEST:
//   PIN1 (mint exemption)  — mintSettlementReconcile never mints for a
//        candidate path listed in .sterling/config.json's top-level
//        generated_projections: string[], even when that path shows live
//        content drift. An unlisted co-candidate owned by the same article
//        still mints, and the minted item's file_keys never contains the
//        exempt path.
//   PIN2 (regression net)  — a config with NO generated_projections key
//        behaves exactly as today: empty exemption set, a drifted candidate
//        mints.
//   PIN3 (isLiveReconcileDebt exemption) — an open reconcile_needed item
//        whose file_keys are ONLY exempt paths is NOT live (falsy), even
//        when those files are genuinely drifted. An item mixing one exempt
//        path with one drifted UNLISTED path is still live.
//   PIN4 (fail-open on malformed config) — a syntactically malformed
//        .sterling/config.json costs only the exemption (treated as empty);
//        the mint / live-predicate call never throws and still proceeds
//        normally on genuine, unrelated drift.
//
// EXPECTED FAILURE SHAPE TODAY: PIN1-TARGET and PIN3-TARGET are RED (the
// exemption does not exist anywhere in the settlement path today). PIN1-
// CONTROL, PIN2 and PIN3-CONTROL are GREEN today (none of them depend on the
// exemption existing — they pin that the mint/live mechanism stays alive,
// which the exemption's arrival must not break).
//
// PIN4a/PIN4b pin the MEASURED, ruling-compliant posture for a malformed
// .sterling/config.json — ruling e13f0fb5: hooks reading config wrap
// fail-CLOSED/loud on corrupt config (P5, "failing loud, never half-
// applying"). Measured by running against today's code: H10 Stop on a
// malformed config exits non-zero and mints nothing; direct-merge on a
// malformed config refuses on the CONFIG itself, before ever reaching the
// reconcile check, so /reconcile_needed/ never appears in its stderr. Both
// are GREEN today and after the fix — they are regression nets guarding
// against the new generated_projections exemption reading swallowing the
// config-parse error and letting settlement half-apply instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-25T12:00:00.000Z';

// Loaded once, lazily, exactly like the existing suite's `before` hook — but
// each test resolves it via this promise instead of a shared `before`, so a
// single fresh `test()` file needs no extra harness plumbing beyond what the
// existing suite already demonstrates the shape of.
let storeModulePromise;
async function getSterlingStore() {
  storeModulePromise ??= import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href);
  return (await storeModulePromise).SterlingStore;
}

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

// Same toolchain/caps/context_watch shape as the existing suite's H10_CONFIG,
// duplicated locally (never imported — that file is not edited and does not
// export it). generated_projections is layered on top per-test via spread.
const H10_CONFIG_BASE = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function writeConfig(dir, config) {
  writeFileSync(join(dir, '.sterling', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

async function makeH10Project(config = H10_CONFIG_BASE) {
  const SterlingStore = await getSterlingStore();
  const dir = mkdtempSync(join(tmpdir(), 'sterling-settlement-genproj-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeConfig(dir, config);
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
 * time (decision 57d9a52d). Duplicated from the existing suite's helper. */
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

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeGitProjectNoRun() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dm-settle-genproj-'));
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
// PIN1 — mint exemption (settlement / Stop hook surface)
// =========================================================================

test('PIN1 [mint exemption, CONTROL — placed first]: an unlisted co-candidate owned by the same article as an exempt, equally-drifted path still mints, grouped normally — EXPECTED GREEN TODAY (this does not exercise the exemption at all; it only proves the mint mechanism is alive so a "nothing mints" reading cannot masquerade as PIN1-TARGET below passing). Sabotage: break settlement grouping/minting outright (e.g. return early with no mint) — this control, not the target, must flip red.', async () => {
  const { dir, store, cleanup } = await makeH10Project({ ...H10_CONFIG_BASE, generated_projections: ['docs/exempt.md'] });
  try {
    const article = articleWithBaseline(store, 'feat-exempt-control', [
      { path: 'docs/exempt.md', content: '# exempt\noriginal\n' },
      { path: 'src/f1.mjs', content: 'export const f1 = 1;\n' },
    ]);
    writeOwnedFile(dir, 'docs/exempt.md', '# exempt\nchanged\n');
    writeOwnedFile(dir, 'src/f1.mjs', 'export const f1 = 2;\n');
    registerTouches(dir, ['docs/exempt.md', 'src/f1.mjs']);
    captureDecision(store);

    const r = stop(dir);
    assert.equal(r.code, 0, r.stderr);

    const items = reconcileItems(store);
    assert.equal(items.length, 1, 'the mint mechanism is alive: an unlisted co-candidate still mints even though a sibling path is exempt');
    assert.equal(items[0].feature_link, article.id);
    assert.ok(items[0].file_keys.includes('src/f1.mjs'), 'the unlisted co-candidate path is present in the minted item');
  } finally {
    cleanup();
  }
});

test('PIN1 [mint exemption, TARGET]: a path listed in generated_projections never appears in any minted item\'s file_keys, even though it shows live content drift — EXPECTED RED TODAY (no exemption exists anywhere in the settlement path; docs/exempt.md currently still mints). Sabotage: remove/never-add the generated_projections exemption filter inside mintSettlementReconcile — the exempt path reappears in file_keys, flipping this red.', async () => {
  const { dir, store, cleanup } = await makeH10Project({ ...H10_CONFIG_BASE, generated_projections: ['docs/exempt.md'] });
  try {
    articleWithBaseline(store, 'feat-exempt-target', [
      { path: 'docs/exempt.md', content: '# exempt\noriginal\n' },
      { path: 'src/f2.mjs', content: 'export const f2 = 1;\n' },
    ]);
    writeOwnedFile(dir, 'docs/exempt.md', '# exempt\nchanged\n');
    writeOwnedFile(dir, 'src/f2.mjs', 'export const f2 = 2;\n');
    registerTouches(dir, ['docs/exempt.md', 'src/f2.mjs']);
    captureDecision(store);

    const r = stop(dir);
    assert.equal(r.code, 0, r.stderr);

    const items = reconcileItems(store);
    for (const item of items) {
      assert.equal(item.file_keys.includes('docs/exempt.md'), false, "a path listed in generated_projections must never appear in a minted item's file_keys");
    }
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN2 — regression net: no generated_projections key behaves as today
// =========================================================================

test('PIN2 [regression net]: a config with NO generated_projections key mints exactly as today for a drifted candidate — EXPECTED GREEN TODAY AND AFTER THE FIX (the exemption set is empty; this is the net that catches an implementation that mis-handles absence). Sabotage: default a missing generated_projections key to "exempt everything" instead of an empty array — must flip this red (0 items minted).', async () => {
  const { dir, store, cleanup } = await makeH10Project(H10_CONFIG_BASE); // no generated_projections key at all
  try {
    const original = 'export const g = 1;\n';
    const changed = 'export const g = 2;\n';
    const article = articleWithBaseline(store, 'feat-g', [{ path: 'src/g.mjs', content: original }]);
    writeOwnedFile(dir, 'src/g.mjs', changed);
    registerTouches(dir, ['src/g.mjs']);
    captureDecision(store);

    const r = stop(dir);
    assert.equal(r.code, 0, r.stderr);

    const items = reconcileItems(store);
    assert.equal(items.length, 1, 'no generated_projections key means an empty exemption set — the drifted candidate still mints');
    assert.equal(items[0].feature_link, article.id);
    assert.deepEqual([...items[0].file_keys].sort(), ['src/g.mjs']);
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN3 — isLiveReconcileDebt exemption (direct-merge live-predicate surface)
// =========================================================================

test('PIN3 [isLiveReconcileDebt exemption, CONTROL — placed first]: an item mixing one exempt path with one drifted UNLISTED path is still live and still refuses the merge — EXPECTED GREEN TODAY AND AFTER THE FIX (proves the exemption cannot blanket-suppress an item merely for containing an exempt path). Sabotage: treat a reconcile_needed item as not-live whenever ANY of its file_keys is exempt, instead of only when ALL of them are — must flip this red (merge succeeds).', async () => {
  const SterlingStore = await getSterlingStore();
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    writeConfig(dir, { ...H10_CONFIG_BASE, generated_projections: ['docs/exempt.md'] });
    const originalUnlisted = 'export const h = 1;\n';
    const changedUnlisted = 'export const h = 2;\n';
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const article = store.create({
      ...envelope('feature_article'),
      slug: 'feat-mixed',
      title: 'feat-mixed',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'docs/exempt.md', role: 'impl' }, { path: 'src/h.mjs', role: 'impl' }],
      file_baselines: { 'docs/exempt.md': sha256hex('# exempt\noriginal\n'), 'src/h.mjs': sha256hex(originalUnlisted) },
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    store.create({
      ...envelope('todo'),
      text: "reconcile article 'feat-mixed' — mixed exempt + unlisted",
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['docs/exempt.md', 'src/h.mjs'],
      feature_link: article.id,
    });
    store.close();

    git(dir, ['checkout', '-b', 'feat/mixed']);
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'exempt.md'), '# exempt\nchanged\n');
    writeFileSync(join(dir, 'src', 'h.mjs'), changedUnlisted);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change both paths']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `an item with a genuinely-drifted UNLISTED path must still refuse the merge — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /reconcile_needed/);
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN3 — isLiveReconcileDebt exemption, TARGET
// =========================================================================

test('PIN3 [isLiveReconcileDebt exemption, TARGET]: an open reconcile_needed item whose file_keys are ONLY exempt paths is NOT live and does not block the merge, even though that path is genuinely drifted — EXPECTED RED TODAY (no exemption exists in isLiveReconcileDebt yet; today\'s live predicate sees genuine drift and refuses). Sabotage: omit the generated_projections check from isLiveReconcileDebt entirely — must flip this red (merge refuses).', async () => {
  const SterlingStore = await getSterlingStore();
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    writeConfig(dir, { ...H10_CONFIG_BASE, generated_projections: ['docs/exempt.md'] });
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const article = store.create({
      ...envelope('feature_article'),
      slug: 'feat-exempt-only',
      title: 'feat-exempt-only',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'docs/exempt.md', role: 'impl' }],
      file_baselines: { 'docs/exempt.md': sha256hex('# exempt\noriginal\n') },
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    store.create({
      ...envelope('todo'),
      text: "reconcile article 'feat-exempt-only' — exempt-only file_keys",
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['docs/exempt.md'],
      feature_link: article.id,
    });
    store.close();

    git(dir, ['checkout', '-b', 'feat/exempt-only']);
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'exempt.md'), '# exempt\nchanged\n'); // genuinely drifted content
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change only the exempt path']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `an item whose file_keys are ONLY exempt paths must not block the merge — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/exempt-only');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN4 — fail-open on a syntactically malformed .sterling/config.json
// =========================================================================

test('PIN4a [fail-closed/loud, mint path]: a syntactically malformed .sterling/config.json makes H10 Stop refuse LOUD and mint NOTHING (never half-apply) — EXPECTED GREEN TODAY AND AFTER THE FIX (ruling e13f0fb5, measured against today\'s code: Stop already exits non-zero and mints nothing on a malformed config). Sabotage: have the new generated_projections exemption read swallow the config parse error and let settlement proceed/mint anyway — must flip this red (exit 0 and/or an item minted).', async () => {
  const { dir, store, cleanup } = await makeH10Project(H10_CONFIG_BASE);
  try {
    // Overwrite with syntactically malformed JSON — the fixture's own
    // config-writing helper always emits valid JSON, so corrupt it
    // deliberately here to exercise the fail-closed/loud path (P5).
    writeFileSync(join(dir, '.sterling', 'config.json'), '{ not: valid json,,, ');

    const original = 'export const p = 1;\n';
    const changed = 'export const p = 2;\n';
    articleWithBaseline(store, 'feat-p', [{ path: 'src/p.mjs', content: original }]);
    writeOwnedFile(dir, 'src/p.mjs', changed);
    registerTouches(dir, ['src/p.mjs']);
    captureDecision(store);

    const r = stop(dir);
    assert.notEqual(r.code, 0, `a malformed config must refuse loud, not proceed — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /session-end duties skipped/i, "H10's degraded-loud shape for a malformed config: session-end duties skipped, not a silent no-op");
    assert.match(r.stderr, /check_skipped h10-stop-duties/, 'the disclosure names the check_skipped reason, per H10\'s designed degraded-loud posture');

    assert.equal(reconcileItems(store).length, 0, 'never half-apply: a malformed config must mint NOTHING, not mint the drifted candidate anyway');
  } finally {
    cleanup();
  }
});

test('PIN4b [fail-closed/loud, isLiveReconcileDebt path]: a syntactically malformed .sterling/config.json makes direct-merge refuse LOUD on the config itself, before ever reaching the reconcile_needed check — EXPECTED GREEN TODAY AND AFTER THE FIX (ruling e13f0fb5, measured against today\'s code: direct-merge already refuses on the malformed config with a loud message, never reaching /reconcile_needed/ or an uncaught SyntaxError stack). Sabotage: have the new generated_projections exemption read swallow the config parse error and let the live-predicate check proceed as if the config were absent — must flip this red (merge succeeds, or refuses citing reconcile_needed instead of the malformed config).', async () => {
  const SterlingStore = await getSterlingStore();
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), '{{{ malformed');

    const originalUnlisted = 'export const q = 1;\n';
    const changedUnlisted = 'export const q = 2;\n';
    const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
    const article = store.create({
      ...envelope('feature_article'),
      slug: 'feat-q',
      title: 'feat-q',
      what_it_does: 'x',
      intended_behavior: 'x',
      files: [{ path: 'src/q.mjs', role: 'impl' }],
      file_baselines: { 'src/q.mjs': sha256hex(originalUnlisted) },
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    store.create({
      ...envelope('todo'),
      text: "reconcile article 'feat-q' — genuine drift, malformed config present",
      source: 'system',
      system_reason: 'reconcile_needed',
      file_keys: ['src/q.mjs'],
      feature_link: article.id,
    });
    store.close();

    git(dir, ['checkout', '-b', 'feat/q']);
    writeFileSync(join(dir, 'src', 'q.mjs'), changedUnlisted);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'genuine drift with malformed config present']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a malformed config must refuse the merge loud — stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /malformed \.sterling\/config\.json/, 'the loud refusal names the malformed config, per ruling e13f0fb5');
    assert.match(r.stderr, /failing loud/i, 'the refusal states the P5 fail-loud posture');
    assert.doesNotMatch(r.stderr, /reconcile_needed/, 'the config refusal fires BEFORE the reconcile_needed live-predicate check is ever reached');
    assert.doesNotMatch(r.stderr, /SyntaxError|at Object\.|at Module\./i, 'the config-parse failure is a deliberate loud refusal, never a raw uncaught exception stack');
  } finally {
    cleanup();
  }
});
