// H7 PIPELINE ARM — GENERATED-PROJECTIONS EXEMPTION (ruling e1275166: generated
// projections — files listed in .sterling/config.json's generated_projections,
// repo-relative POSIX paths, exact-string match — are store-generated read-only
// outputs; a content change to one is "the system's own heartbeat, not drift"
// and must NOT mint reconcile debt).
//
// Board 1784d6fc: the settlement-time rewrite (board c198866d) restored this
// exemption on the DIRECT-mode arms (mintSettlementReconcile + isLive
// ReconcileDebt, pinned by scripts/tests/h7-settlement-generated-projections.
// test.mjs) but left the PIPELINE arm unrestored — h7-file-touch.mjs's `if
// (run)` branch (the one that calls store.appendRunReconcileNeeded for the
// owning articles of a touched path, marking run.reconcile_needed) contains
// no generated_projections read anywhere (grep 0 hits at the fix commit per
// the board item). This suite pins the SPEC the pipeline arm must satisfy
// once that gap is closed: it does not exist as a distinct code path today,
// so the pipeline arm treats every owned, touched path identically regardless
// of config.
//
// This file is authored BLIND to scripts/hooks/h7-file-touch.mjs and every
// other file under scripts/hooks/ or scripts/lib/ — the harness idioms below
// (makeProject({withRun:true}), hookInput, runHook, the article helper, how
// run.reconcile_needed is read back) are learned ONLY from the existing,
// already-passing pipeline tests in scripts/tests/hooks-full.test.mjs (search
// "H7 [pipeline]" and "H7 [§3.2.5 pipeline]") and duplicated locally, exactly
// as scripts/tests/h7-settlement-generated-projections.test.mjs states it does
// for the direct-mode arms. The PIN naming/CONTROL-first structure mirrors
// that file's PIN1/PIN2/PIN3 shape, adapted to the pipeline surface's actual
// mechanism: run.reconcile_needed is an array of ARTICLE IDS marked at touch
// time (no baseline hashing happens on this arm today — the existing pipeline
// tests mint on a bare Edit touch with no file even written to disk), so the
// exemption question here is purely "was this touched PATH in
// generated_projections", never "did content drift from a baseline".
//
// SETUP-AMBIGUITY CHECK (per the dispatch brief): none found. makeProject
// ({withRun:true}) in hooks-full.test.mjs (lines ~62-101) fully demonstrates
// how a run becomes visible to h7-file-touch.mjs: store.createRun({id:'r-h5',
// brief_ref, branch, machine_state:'running', phases:[...], dispatch_counts:
// {}, escalations:[], started_at}) — no env var, no session wiring, no git
// init. The two existing pipeline tests (line 632 and line 810) call the hook
// exactly as any direct-mode test does and read store.getRun('r-h5')
// .reconcile_needed back. Duplicated verbatim below.
//
// SPEC UNDER TEST:
//   CONTROL — a touched NON-exempt path still mints its owning article onto
//        run.reconcile_needed even when generated_projections is populated
//        (with an unrelated entry) — proves the pipeline mint mechanism is
//        alive and that a populated config key alone doesn't suppress it.
//   TARGET — a touched path listed in generated_projections does NOT mint its
//        owning article, even though that article's file content on disk
//        genuinely differs from what it was created with (drift is real; the
//        exemption applies regardless, because the pipeline arm has no
//        content-hash concept to begin with — the exemption must be path-only).
//   MIXED — a single article co-owns one exempt path and one non-exempt path.
//        Touching ONLY the exempt path must NOT mint the article (path-level,
//        not "article owns a non-exempt file so never exempt it"); touching
//        the non-exempt path afterward MUST mint the article (path-level, not
//        "article owns an exempt file so blanket-exempt the whole article").
//   REGRESSION NET — a config with NO generated_projections key at all mints
//        exactly as today (empty exemption set).
//
// EXPECTED FAILURE SHAPE TODAY: TARGET and the first (exempt-touch) half of
// MIXED are RED — the exemption does not exist anywhere on the pipeline arm
// today, so every owned, touched path mints unconditionally. CONTROL, the
// second (non-exempt-touch) half of MIXED, and REGRESSION NET are GREEN today
// — none of them depend on the exemption existing, they pin that the mint
// mechanism itself stays alive and unconditional-by-default.
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

// Same base config shape as hooks-full.test.mjs's CONFIG, duplicated locally
// (never imported — that file is not edited and does not export it).
// generated_projections is layered on top per-test via spread, exactly as
// the direct-arm exemption suite does with H10_CONFIG_BASE.
const CONFIG_BASE = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

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

/** Mirrors makeProject({withRun:true}) from hooks-full.test.mjs exactly: a
 * brief + a running run with a fixed id, so h7-file-touch.mjs's `if (run)`
 * pipeline arm has a live run to mark. */
async function makeRunProject(config = CONFIG_BASE) {
  const SterlingStore = await getSterlingStore();
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h7-pipeline-genproj-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(config));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const brief = store.create({
    ...envelope('brief'),
    slug: 'f',
    title: 'F',
    problem: 'p',
    feature: 'f',
    user_stated: { criteria: [], constraints: [] },
    conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
    technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
    blast_radius: { files: [{ path: 'src/a.mjs', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: [],
    out_of_scope: [],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  });
  store.createRun({
    id: 'r-h7pg',
    brief_ref: brief.id,
    branch: 'sterling/run-r-h7pg',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

/** feature_article owning `files` (array of {path, content}) — same shape as
 * the direct-arm suite's articleWithBaseline, duplicated locally. The
 * pipeline arm has no known baseline-hashing concept today (the existing
 * pipeline tests mint on a bare touch with no file even on disk), but
 * file_baselines is set anyway so a genuinely-drifted TARGET/MIXED fixture
 * is truthful regardless of how the fix is implemented. */
function articleWithFiles(store, slug, files, at = NOW) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((f) => ({ path: f.path, role: 'impl' })),
    file_baselines: Object.fromEntries(files.map((f) => [f.path, sha256hex(f.originalContent)])),
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

function touch(dir, path) {
  return runHook('h7-file-touch.mjs', hookInput(dir, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, path) } }), dir);
}

const reconcileNeeded = (store) => store.getRun('r-h7pg').reconcile_needed;

// =========================================================================
// CONTROL — placed first: the pipeline mint mechanism is alive, and a
// POPULATED (but irrelevant) generated_projections key does not suppress it.
// =========================================================================

test('CONTROL [pipeline mint mechanism alive]: a touched NON-exempt path still marks its owning article on run.reconcile_needed even though generated_projections is populated with an unrelated entry — EXPECTED GREEN TODAY AND AFTER THE FIX (this exercises no exemption logic at all; it only proves the underlying appendRunReconcileNeeded call still fires, so a "nothing mints" reading of TARGET below cannot masquerade as the exemption working). Sabotage: remove/stub out the appendRunReconcileNeeded call in the pipeline arm entirely — this control, not TARGET, must flip red (reconcile_needed stays empty).', async () => {
  const { dir, store, cleanup } = await makeRunProject({ ...CONFIG_BASE, generated_projections: ['docs/unrelated-exempt.md'] });
  try {
    const a = articleWithFiles(store, 'feat-control', [{ path: 'src/control.mjs', originalContent: 'export const c = 1;\n' }]);
    const r = touch(dir, 'src/control.mjs');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(reconcileNeeded(store), [a.id], 'a non-exempt touched path still marks its owning article');
  } finally {
    cleanup();
  }
});

// =========================================================================
// TARGET — an exempt touched path must not mint, even with genuine drift.
// =========================================================================

test('TARGET [pipeline exemption]: a touched path listed in generated_projections does NOT mark its owning article on run.reconcile_needed, even though the file on disk genuinely differs from the article\'s original content — EXPECTED RED TODAY (h7-file-touch.mjs\'s pipeline arm contains no generated_projections read at all today, per board 1784d6fc\'s grep-0-hits evidence; docs/exempt.md currently still marks the article). Sabotage: never add the generated_projections filter before the pipeline arm\'s appendRunReconcileNeeded call for the touched path — the article stays marked, flipping this red.', async () => {
  const { dir, store, cleanup } = await makeRunProject({ ...CONFIG_BASE, generated_projections: ['docs/exempt.md'] });
  try {
    articleWithFiles(store, 'feat-target', [{ path: 'docs/exempt.md', originalContent: '# exempt\noriginal\n' }]);
    writeOwnedFile(dir, 'docs/exempt.md', '# exempt\nchanged — a real regen, not drift\n');
    const r = touch(dir, 'docs/exempt.md');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(reconcileNeeded(store), [], 'a path listed in generated_projections must never mark its owning article, drifted or not');
  } finally {
    cleanup();
  }
});

// =========================================================================
// MIXED — path-level filtering, not article-level, on a single article that
// co-owns one exempt and one non-exempt path.
// =========================================================================

test('MIXED [path-level, not article-level, filtering]: an article co-owning an exempt path and a non-exempt path is NOT marked by touching only the exempt path, but IS marked once the non-exempt path is also touched — EXPECTED RED TODAY on the first assertion (no exemption exists yet, so the exempt-only touch already marks the article today) and GREEN TODAY on the second (the mint mechanism already marks on a non-exempt touch). Sabotage A (blanket article-level exemption — "article owns an exempt path, so never mark it at all"): flips the SECOND assertion red (article stays unmarked after the non-exempt touch). Sabotage B (no filtering, or filtering keyed off "does the article own any non-exempt path" instead of the touched path itself): flips the FIRST assertion red (article gets marked from the exempt-only touch).', async () => {
  const { dir, store, cleanup } = await makeRunProject({ ...CONFIG_BASE, generated_projections: ['docs/exempt.md'] });
  try {
    const a = articleWithFiles(store, 'feat-mixed', [
      { path: 'docs/exempt.md', originalContent: '# exempt\noriginal\n' },
      { path: 'src/mixed.mjs', originalContent: 'export const m = 1;\n' },
    ]);
    writeOwnedFile(dir, 'docs/exempt.md', '# exempt\nchanged — a real regen, not drift\n');
    writeOwnedFile(dir, 'src/mixed.mjs', 'export const m = 2;\n');

    const r1 = touch(dir, 'docs/exempt.md');
    assert.equal(r1.code, 0, r1.stderr);
    assert.deepEqual(reconcileNeeded(store), [], 'touching only the exempt path must not mark the co-owning article (path-level, not "article owns a non-exempt file so always mark")');

    const r2 = touch(dir, 'src/mixed.mjs');
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(reconcileNeeded(store), [a.id], 'touching the non-exempt path must still mark the article (path-level, not "article owns an exempt file so blanket-exempt it")');
  } finally {
    cleanup();
  }
});

// =========================================================================
// REGRESSION NET — no generated_projections key at all behaves as today.
// =========================================================================

test('REGRESSION NET [absent config key]: a config with NO generated_projections key mints exactly as today for any touched, owned path — EXPECTED GREEN TODAY AND AFTER THE FIX (the exemption set is empty; this is the net that catches an implementation that mis-handles absence). Sabotage: default a missing generated_projections key to "exempt everything" instead of an empty array — must flip this red (reconcile_needed stays empty).', async () => {
  const { dir, store, cleanup } = await makeRunProject(CONFIG_BASE); // no generated_projections key at all
  try {
    const a = articleWithFiles(store, 'feat-net', [{ path: 'src/net.mjs', originalContent: 'export const n = 1;\n' }]);
    const r = touch(dir, 'src/net.mjs');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(reconcileNeeded(store), [a.id], 'no generated_projections key means an empty exemption set — the touched path still marks its owning article');
  } finally {
    cleanup();
  }
});
