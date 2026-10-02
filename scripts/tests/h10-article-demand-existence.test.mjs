// H10 — ARTICLE-DEMAND EXISTENCE AT MINT TIME (board 97ddfcc6).
//
// THE DEFECT THIS FILE PINS: H10 minted a PERMANENTLY UNCLOSABLE
// article_missing item for a TRANSIENT probe file that no longer existed by
// the time the Stop hook ran (measured twice, 2026-09-05 and 2026-09-06 —
// queue items 5b70cd3f.../8abc81ec... both named a scripts/zz-*.mjs path
// that was never tracked and had already been removed with
// scripts/fs-remove.mjs). Closing such an item requires an article to OWN a
// file that does not exist, which is drift by construction — the
// append-join admission refuses every other disposition route, so
// `maintenance_remove` is the only escape and it needs a human to notice
// the item is void.
//
// SPECIFIED SHAPE (per this dispatch's brief, corrected against the SHIPPED
// contract — gitKnowsNow, not "ever tracked"): the check asks whether the
// path is known NOW — present in the git INDEX or HEAD tree at the moment of
// the check — never whether it was EVER tracked at some point in history. A
// path absent from disk at Stop time is dropped from the unowned/demand set
// when git currently has NO record of it at all (never added, or a REAL
// removal that was itself committed — e.g. `git rm` + commit — so the
// deletion is now known; this is DROPPED BY DESIGN, not a gap: board
// 97ddfcc6's "an intentionally DELETED tracked file ... is a different case"
// concern is about NOT sweeping up a genuine, committed removal into the
// unclosable-item shape, and gitKnowsNow's current-state check achieves
// exactly that — it drops a committed deletion the same way it drops a path
// that was never tracked). A path still present in the index/HEAD RIGHT NOW
// (e.g. removed from the working tree without a matching `git rm`/commit) is
// KEPT. If git cannot answer at all (unavailable), the safe default is to
// KEEP the name too, loudly, via a check_skipped receipt (P5: fail loud,
// never silent) rather than silently reproducing the drop for a case that
// was never confirmed safe.
//
// DELIBERATELY NOT WRITTEN: a "tracked-then-deleted still mints" arm. Per
// this dispatch's brief, h10:627 already filters deleted files out of the
// touch set before this existence check runs, so a plain tracked-then-
// deleted fixture never reaches the code path this file is pinning — that
// arm would be unreachable/vacuous, not a real pin.
//
// UNPINNED (conductor follow-up, gate-run-verified TWICE): the no_git
// DEGRADE branch — a vanished-but-tracked CARRIED key kept, with
// check_skipped `article-demand-vanished-tracked`/`no_git` recorded — has no
// arm in this file. Two fixture shapes were tried and both proved
// unreachable, not merely inconvenient:
//   (a) touching the vanished path directly: h10:627's touch-set filter
//       drops an absent touched path from the touch set BEFORE any
//       git-dependent guard runs, and with git additionally stripped for
//       that same Stop the ordinary mint path's own git dependencies also
//       fail, so no demand is minted at all (measured: demandedPaths() was
//       empty).
//   (b) planting the vanished path as a CARRIED key on an already-open item
//       (mint with git available, delete the file without git rm, then
//       recompute with git stripped): the live recompute's OWN existence
//       prune (h10:1331) removes a non-existent carried name UNCONDITIONALLY
//       before the git-dependent guard ever runs (measured: demandedPaths()
//       came back with the other two carried names but not the vanished
//       one). The guard's degrade branch is reachable only when the live
//       recompute ITSELF throws (the h10:1317 catch) and the item falls back
//       to its own overlapping.file_keys — not a condition this harness (or
//       the sibling h10-article-missing-live-recompute.test.mjs's harness,
//       whose E-4/E-4b arms break a DIFFERENT probe — the gitignore check,
//       not the existence prune) can force honestly without reaching for an
//       implementation-anchored mock.
// Its fail-closed direction (names KEPT on a degraded recompute) is BY
// CONSTRUCTION from the same P5 fail-loud posture SKIP/CONTROL/OWNERSHIP
// above already exercise, not independently verified here.
//
// EXTENDED (conductor follow-up): the ORDINARY (non-degraded) KEEP branch —
// `|| known.has(p)`, keeping a carried/touched path that IS currently known
// to git (present in the index/HEAD right now) even though it is absent from
// disk — is EQUALLY unpinned in this file, for the identical reachability
// reason as the no_git DEGRADE branch above: both fixture shapes tried to
// reach it (touch-time and carried-key-recompute) hit the SAME two
// obstacles (the touch-set filter dropping it before any guard runs; the
// recompute's own unconditional existence prune removing it before
// `known.has(p)` is ever consulted). SKIP pins the DROP half of this check
// (not known now); the KEEP half (known.has(p) true) has no arm here either.
//
// ---------------------------------------------------------------------------
// EXECUTION DISCLOSURE: the test-writer role holds no Bash by design (H4
// read wall), so NONE of these tests were run, and no implementation file
// was read — this file is authored from the dispatch brief (itself derived
// from board 97ddfcc6 and the governing decision) and from the sibling
// harness scripts/tests/h10-lane-scope-leak-and-owed-truncation.test.mjs,
// copied verbatim for its fixture conventions. Each arm names, in its own
// comment, the ONE-LINE SABOTAGE that must turn it RED; the dispatch report
// repeats them with expected pass/fail so the conductor can gate. An arm
// that stays green under its own named sabotage is HOLLOW and is evidence
// for the conductor, not a passing test.
//
// SOURCE, NOT BUNDLE: HOOKS resolves to join(root,'scripts','hooks'),
// matching every H10 sibling suite. The repo-root `hooks/` bundle is STALE
// for this fix (source-only, deliberately not rebuilt).
// ---------------------------------------------------------------------------

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

const TOUCH_AT = '2026-06-10T12:00:00.000Z';
const OWNED_AT = '2026-06-10T08:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

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

const out = (r) => `${r.stdout}\n${r.stderr}`;

function envelope(type, at) {
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

const H10_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject(prefix = 'sterling-h10-article-demand-existence-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(H10_CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const hookInput = (dir, over = {}) => ({ session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over });
const stop = (dir, env = {}) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir, env);

const touchesPath = (dir) => join(dir, '.sterling', 'transient', 'touches.json');

/** Simulates a session's file-touch register — files that exist, at a given time. */
function touchRegister(dir, paths, at = TOUCH_AT) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n');
  }
  writeFileSync(touchesPath(dir), JSON.stringify(paths.map((path) => ({ path, at }))));
}

/**
 * Registers a touch WITHOUT ever creating the file on disk — this is
 * board 97ddfcc6's exact shape: a throwaway probe created and removed
 * within the session, before this Stop ever ran.
 */
function touchRegisterAbsent(dir, paths, at = TOUCH_AT) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(touchesPath(dir), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function article(store, slug, files, at = OWNED_AT) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files,
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'originating brief' }],
    live_test_refs: [],
  });
}

const owed = (store, reason) => store.query({ types: ['todo'], cap: 200 }).filter((t) => t.source === 'system' && t.system_reason === reason);
const articleMissing = (store) => owed(store, 'article_missing');
const demandedPaths = (store) => [...new Set(articleMissing(store).flatMap((d) => d.file_keys ?? []))].sort();

function declareNoCapture(dir, reason = 'read-only follow-up; nothing durable learned') {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'no-capture.mjs'), '--reason', reason], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  assert.equal(r.status, 0, `FIXTURE LIVENESS: the bare no_capture declaration must be accepted: ${r.stderr}`);
  return r;
}

// --------------------------------------------------------------------------
// git fixtures. Every arm below needs a repo WITH AT LEAST ONE COMMIT: the
// existence check (gitKnowsNow) returns null — cannot answer — on a repo
// with no HEAD at all, which would confound "not known now" with "cannot
// tell", collapsing the SKIP and DEGRADE fixture shapes together.
// --------------------------------------------------------------------------

function git(dir, args) {
  return spawnSync(
    'git',
    ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', timeout: 60_000 },
  );
}

function initRepoWithHead(dir) {
  const init = git(dir, ['init', '--initial-branch=main']);
  assert.equal(init.status, 0, `FIXTURE LIVENESS: git init failed: ${init.stderr}`);
  mkdirSync(join(dir, 'seed'), { recursive: true });
  writeFileSync(join(dir, 'seed', 'baseline.mjs'), '// seed\n');
  assert.equal(git(dir, ['add', 'seed']).status, 0, 'FIXTURE LIVENESS: git add of the seed file');
  const commit = git(dir, ['commit', '-m', 'baseline']);
  assert.equal(commit.status, 0, `FIXTURE LIVENESS: the seed commit must succeed so HEAD exists: ${commit.stderr}`);
  assert.equal(git(dir, ['rev-parse', 'HEAD']).status, 0, 'FIXTURE LIVENESS: HEAD resolves');
}

const isTracked = (dir, path) => git(dir, ['ls-files', '--error-unmatch', path]).status === 0;

function commitPaths(dir, paths) {
  assert.equal(git(dir, ['add', ...paths]).status, 0, 'FIXTURE LIVENESS: git add of the fixture paths');
  const commit = git(dir, ['commit', '-m', 'track fixture paths']);
  assert.equal(commit.status, 0, `FIXTURE LIVENESS: committing the fixture paths must succeed: ${commit.stderr}`);
}

// ===========================================================================
// 1. SKIP — a vanished, NEVER-tracked touched path raises nothing at all.
// ===========================================================================

test('SKIP: a touched path absent at Stop and never git-tracked raises no article demand and names no item for it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    initRepoWithHead(dir);
    const vanished = 'scripts/zz-probe.mjs';
    touchRegisterAbsent(dir, [vanished]);
    assert.ok(!existsSync(join(dir, vanished)), 'FIXTURE LIVENESS: the file does not exist on disk at Stop time');
    assert.ok(!isTracked(dir, vanished), 'FIXTURE LIVENESS: the file was never committed/tracked — this is the ephemeral-probe shape board 97ddfcc6 measured, not a real removal');

    declareNoCapture(dir);
    const r = stop(dir);
    assert.equal(
      r.code,
      0,
      `SHAPE (RED before the fix, soft-blocking or minting for a path that cannot be inspected): a vanished, never-tracked touched path must be dropped entirely — no article demand can be raised for it. stderr: ${r.stderr}`,
    );
    assert.doesNotMatch(out(r), /article demand/i, 'no demand text at all for a vanished never-tracked path');
    assert.equal(articleMissing(store).length, 0, 'no article_missing item minted at all — the unclosable-item shape board 97ddfcc6 measured');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the "never tracked" existence filter entirely (revert to
// treating every touched path — existent or not — as demand-eligible once
// it is merely present in touches.json) — this test goes red on either the
// exit-code assertion (a demand/soft-block fires for a path that cannot be
// inspected) or the articleMissing length assertion (an unclosable item is
// minted, reproducing board 97ddfcc6 exactly).

// ===========================================================================
// 2. CONTROL (the opposite of SKIP) — three tracked, EXISTING, unowned
// source files still raise the ordinary demand and name all three. Without
// this arm, SKIP is unfalsifiable in one direction: an implementation that
// suppressed the article demand ENTIRELY (not just for vanished paths)
// would also pass SKIP.
// ===========================================================================

test('CONTROL (must pass for the OPPOSITE reason from SKIP): three tracked, existing, unowned files still raise the demand and name all three', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    initRepoWithHead(dir);
    const paths = ['src/e1.mjs', 'src/e2.mjs', 'src/e3.mjs'];
    touchRegister(dir, paths);
    commitPaths(dir, paths);
    for (const p of paths) assert.ok(isTracked(dir, p), `FIXTURE LIVENESS: ${p} is tracked and exists — only the SKIP arm's vanished-path shape should differ from this`);

    declareNoCapture(dir);
    const first = stop(dir);
    assert.equal(
      first.code,
      2,
      `CONTROL BROKEN if this is not 2: three unowned, EXISTING, tracked files with the capture duty discharged must still raise the article demand. stderr: ${first.stderr}`,
    );
    assert.match(first.stderr, /article demand/i, 'CONTROL: the article demand fires for ordinary existing unowned files');

    const second = stop(dir);
    assert.equal(second.code, 0, `CONTROL BROKEN: the session releases: ${second.stderr}`);
    assert.equal(articleMissing(store).length, 1, 'CONTROL BROKEN: exactly one article_missing item');
    assert.deepEqual(demandedPaths(store), paths.slice().sort(), 'CONTROL BROKEN: and it names every one of the three existing unowned files');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the existence check over-eager (e.g. treat any touched path
// as unverifiable and drop it, not only ones absent from disk) — this
// control goes red on the exit-code or demandedPaths assertions, proving the
// SKIP fix would have been a blanket suppression rather than a targeted one.

// ===========================================================================
// 3. OWNERSHIP — an `unverified: true` files[] entry still counts as
// ownership for the existence/demand check.
//
// (The DEGRADE arm that would have been section 3 is deliberately absent —
// see the top-of-file UNPINNED note: it is unreachable through this harness.)
// ===========================================================================

test('OWNERSHIP: a files[] entry marked unverified:true still counts as ownership — no demand even for a brand-new untracked path', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    initRepoWithHead(dir);
    const ordinary = ['src/o1.mjs', 'src/o2.mjs'];
    const unverifiedOwned = 'src/o3-unverified.mjs';
    touchRegister(dir, [...ordinary, unverifiedOwned]);
    commitPaths(dir, ordinary); // only the two ordinarily-owned files are tracked
    assert.ok(
      !isTracked(dir, unverifiedOwned),
      'FIXTURE LIVENESS: the unverified-owned path is untracked/brand-new — if unverified ownership did NOT count, this alone would raise the NEW-FILE demand trigger regardless of the >=3 threshold',
    );

    article(store, 'feat-unverified-ownership', [
      { path: ordinary[0], role: 'impl' },
      { path: ordinary[1], role: 'impl' },
      { path: unverifiedOwned, role: 'impl', unverified: true },
    ]);

    declareNoCapture(dir);
    const r = stop(dir);
    assert.equal(
      r.code,
      0,
      `SABOTAGE SHAPE if this is 2: an unverified files[] entry must still count as ownership for the demand check — rejecting it as unowned raises the NEW-FILE trigger for a path an article already names. stderr: ${r.stderr}`,
    );
    assert.doesNotMatch(out(r), /article demand/i, 'no demand text — the unverified entry still counts as ownership');
    assert.equal(articleMissing(store).length, 0, 'no article_missing item minted');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make isUnowned reject `unverified: true` rows (treat them as if
// the path were not in files[] at all) — the NEW-FILE trigger then fires for
// the untracked unverifiedOwned path and both the exit-code and
// articleMissing-length assertions above go red.

// ===========================================================================
// 4. IGNORE GLOBS — per-project policy data (Dome Farmer issue #52; decision
// article-demand-ignore-globs-per-project-policy-data). Godot 4 writes a
// one-line `.uid` identity sidecar beside every script; a project opts out of
// demanding ownership for such files with article_demand.ignore_globs. The
// filter is PER PATH: the sibling .gd is still demanded.
// ===========================================================================

const GD = 'game/player.gd';
const GD_UID = 'game/player.gd.uid';

function makeGodotProject(articleDemand) {
  const proj = makeProject('sterling-h10-ignore-globs-');
  const config = articleDemand ? { ...H10_CONFIG, article_demand: articleDemand } : H10_CONFIG;
  writeFileSync(join(proj.dir, '.sterling', 'config.json'), JSON.stringify(config));
  initRepoWithHead(proj.dir);
  touchRegister(proj.dir, [GD, GD_UID]);
  return proj;
}

test('IGNORE GLOBS: with ignore_globs ["**/*.uid"] a touched .gd.uid is not demanded while its sibling .gd still is', () => {
  const { dir, store, cleanup } = makeGodotProject({ ignore_globs: ['**/*.uid'] });
  try {
    declareNoCapture(dir);
    const first = stop(dir);
    assert.equal(first.code, 2, `the brand-new unowned .gd still raises the demand: ${first.stderr}`);
    assert.match(first.stderr, /article demand/i);
    assert.match(first.stderr, /game\/player\.gd\b(?!\.uid)/, 'the .gd is named');
    assert.doesNotMatch(first.stderr, /player\.gd\.uid/, 'the ignored .uid sidecar is not named in the demand');

    const second = stop(dir);
    assert.equal(second.code, 0, `the session releases: ${second.stderr}`);
    assert.deepEqual(demandedPaths(store), [GD], 'only the .gd is demanded — the ignore glob applies per path');
  } finally {
    cleanup();
  }
});

test('IGNORE GLOBS REGRESSION GUARD: with no article_demand config the .gd.uid IS demanded beside the .gd (nothing ships in the default)', () => {
  const { dir, store, cleanup } = makeGodotProject(null);
  try {
    declareNoCapture(dir);
    const first = stop(dir);
    assert.equal(first.code, 2, `demand fires: ${first.stderr}`);
    assert.match(first.stderr, /player\.gd\.uid/, 'the .uid is named when no project policy ignores it');
    const second = stop(dir);
    assert.equal(second.code, 0, `the session releases: ${second.stderr}`);
    assert.deepEqual(demandedPaths(store), [GD, GD_UID].sort(), 'both files are demanded without ignore_globs');
  } finally {
    cleanup();
  }
});

test('IGNORE GLOBS SCHEMA: article_demand.ignore_globs defaults to [] and refuses an empty-string glob', async () => {
  const { parseConfig } = await import('@sterling/schemas');
  assert.deepEqual(parseConfig({}).article_demand.ignore_globs, []);
  assert.deepEqual(parseConfig({ article_demand: { ignore_globs: ['**/*.uid'] } }).article_demand.ignore_globs, ['**/*.uid']);
  assert.throws(() => parseConfig({ article_demand: { ignore_globs: [''] } }));
});
