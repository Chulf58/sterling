// H10 — TWO LANDED FIXES THAT SHIPPED UNPINNED (authored 2026-08-29).
//
// WHY THIS FILE EXISTS AT ALL: all 102 tests across the ten existing H10 suites
// are green BOTH BEFORE AND AFTER the two fixes pinned here. They prove no
// regression; they prove NOTHING about either hole being closed. The closest
// existing witness (arm D-1 in scripts/tests/h10-article-missing-live-recompute
// .test.mjs) cannot see fix 1: its session-2 fixture touches only OWNED files,
// so `unowned` is empty and the article demand was false on that release either
// way. Every arm below is therefore the ONLY evidence that will ever exist for
// the behaviour it names.
//
// ---------------------------------------------------------------------------
// GROUP A — THE LANE-SCOPE LEAK (board f4616312, hole 1).
//
// THE RULING (decision `no-capture-discharge-is-lane-scoped`, 51ebe0dd,
// carried with its justification clause): "a discharge must be no broader than
// the claim the human actually made ... where a declaration's scope is
// ambiguous the duty stays armed", BECAUSE silent knowledge loss is the severe
// direction (P5 fail loud, P2 the KB is the product). A CAPTURE-lane
// declaration therefore cannot discharge the ARTICLE-DEMAND lane: the human
// declared "nothing durable was learned", never "this territory needs no
// owning article".
//
// THE SECOND RULING, WHICH DOES NOT YIELD (board 05e298f0, AC1 of
// scripts/tests/h10-touch-noise.test.mjs): image/binary-only activity is
// inspection, not knowledge-producing work. It never TRIGGERS an article duty,
// so nothing is discharged there — the exemption is not a lane-scope
// violation, it is the absence of a duty. Both rulings hold; arm A-5 pins the
// image ruling and arm A-6 pins that the exemption was NOT applied globally,
// which is the single easiest way for a later refactor to break it.
//
// GOVERNING ACs (feature_article `h10-direct-capture-gate`, v105): AC9 (the
// article_missing item is a LIVE VIEW; its KNOWN LIMITATION clause is what
// board f4616312 tracks), AC11 (absence of git/HEAD degrades loud via
// check_skipped, never silently disabling the NEW-FILE trigger), AC13 (the
// no_capture declaration and what it covers).
//
// GROUP C — capture_owed TRUNCATION DISCLOSURE (board 40b378e8). The item's
// `file_keys` are still capped at 20 (deliberately: an identical slice(0,20)
// lives at scripts/hooks/h1-session-start.mjs and desynchronising the two was
// rejected), but the cap must now be DISCLOSED. Board 40b378e8's own item 3:
// "If truncation stays, it must be DISCLOSED. A silent `.slice()` is what made
// the article_missing case dangerous — the reader cannot tell a complete list
// from a truncated one." Both mint sites are covered, because the
// capture_pending conversion site previously carried NO COUNT AT ALL and is
// the weaker of the two.
//
// ---------------------------------------------------------------------------
// EXECUTION DISCLOSURE: the test-writer role holds no Bash by design (H4 read
// wall), so NONE of these tests were run, and no implementation file was read.
// Each arm names, in its own comment, the ONE-LINE SABOTAGE that must turn it
// RED; the dispatch report repeats them with expected pass/fail so the
// conductor can gate. An arm that stays green under its own named sabotage is
// HOLLOW and is evidence for the conductor, not a passing test.
//
// CONTROL DISCIPLINE: every verdict below with more than one possible cause
// carries a CONTROL ARM PLACED FIRST that must pass for the OPPOSITE reason.
// "H10 soft-blocked" has many causes; "H10 released" has more. Where an arm
// depends on a fixture condition (a git probe answering, a CLI declaration
// actually landing in the register), that condition is ASSERTED, not assumed —
// a silently-unarmed fixture makes its target arm pass VACUOUSLY and reads
// exactly like a real green.
//
// SOURCE, NOT BUNDLE: HOOKS resolves to join(root,'scripts','hooks'), matching
// every H10 sibling suite. The repo-root `hooks/` bundle is STALE for these
// fixes (source-only, deliberately not rebuilt).
//
// FROZEN / SPEC-ONLY: authored against the ACs, the two board items and the
// governing decision — never against the implementation. If an arm here is
// wrong, that is evidence for the conductor, not a licence to edit it.

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

// Deliberately in the PAST relative to any CLI-stamped declaration (the
// no_capture / test_repair writer scripts stamp `at` = now), so a declaration
// always sits AFTER the work it covers. AC13: work after a declaration
// re-arms the duty — every fixture here keeps the declaration last in time.
const TOUCH_AT = '2026-06-10T12:00:00.000Z';
const OWNED_AT = '2026-06-10T08:00:00.000Z'; // owning articles pre-date every touch, see note at makeProject
const PENDING_AT = '2026-06-10T12:30:00.000Z';

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

// Defaults deliberately NOT overridden — article_demand.min_unowned_files
// defaults to 3 (packages/schemas/src/config.ts) and every frozen H10 suite is
// sized against that. Fixtures below say at each use site which side of 3 they
// sit on and why.
const H10_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject(prefix = 'sterling-h10-lane-leak-') {
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
const eventsPath = (dir) => join(dir, '.sterling', 'transient', 'session-events.json');
const registerPath = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');

/** Simulates a session's file-touch register — files that exist, at a given time. */
function touchRegister(dir, paths, at = TOUCH_AT) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(touchesPath(dir), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function writeSessionEvents(dir, events) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(eventsPath(dir), JSON.stringify(events));
}

function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

const readEvents = (dir) => (existsSync(eventsPath(dir)) ? JSON.parse(readFileSync(eventsPath(dir), 'utf8')) : []);

/**
 * An owning feature_article. created_at is deliberately EARLIER than every
 * touch in these fixtures: if feature_article ever counts toward the capture
 * duty's satisfied-types set, an article stamped BEFORE the work cannot
 * discharge it, so "the capture duty was armed" keeps exactly one cause.
 */
function article(store, slug, files, at = OWNED_AT) {
  return store.create({
    ...envelope('feature_article', at),
    slug,
    title: slug,
    what_it_does: 'x',
    intended_behavior: 'x',
    files: files.map((path) => ({ path, role: 'impl' })),
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
const captureOwed = (store) => owed(store, 'capture_owed');
const demandedPaths = (store) => [...new Set(articleMissing(store).flatMap((d) => d.file_keys ?? []))].sort();

const names = (prefix, n, dir = 'src') => Array.from({ length: n }, (_, i) => `${dir}/${prefix}${String(i + 1).padStart(2, '0')}.mjs`);

// --------------------------------------------------------------------------
// Real writer surfaces. Both declarations go through the SHIPPED CLI, never a
// hand-written register entry: the fix under test is about what a declaration
// DISCHARGES, and a hand-forged event could differ from what the writer
// actually emits. Each helper asserts BOTH that the CLI accepted the
// declaration AND that the event landed in the register — a silently-unarmed
// declaration would make its arm pass vacuously (soft-block for the ordinary
// capture-duty reason) and read exactly like a real green.
// --------------------------------------------------------------------------

function declareNoCapture(dir, reason = 'read-only follow-up; nothing durable learned') {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'no-capture.mjs'), '--reason', reason], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  assert.equal(r.status, 0, `FIXTURE LIVENESS: the BARE no_capture declaration must be accepted by scripts/no-capture.mjs: ${r.stderr}`);
  const events = readEvents(dir).filter((e) => e.kind === 'no_capture');
  assert.equal(events.length, 1, 'FIXTURE LIVENESS: exactly one no_capture event landed in the register — an unarmed declaration would leave the capture duty armed and make this arm green for the wrong reason');
  assert.equal(events[0].lane, undefined, 'FIXTURE LIVENESS: this is the BARE (capture-lane) declaration shape — no lane field at all (decision 51ebe0dd: bare covers CAPTURE only)');
  return r;
}

function declareTestRepair(dir, path, evidence) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'test-repair.mjs'), '--path', path, '--evidence', evidence], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  assert.equal(r.status, 0, `FIXTURE LIVENESS: the test_repair declaration for ${path} must be accepted by scripts/test-repair.mjs: ${r.stderr}`);
  return r;
}

// --------------------------------------------------------------------------
// git fixtures. Two arms need the `git ls-tree` NEW-FILE probe to ANSWER
// rather than degrade (AC11: absence of git/HEAD degrades loud via
// check_skipped, never silently disabling the new-file trigger), so both the
// repo and the tracked/untracked status of each fixture path are asserted
// rather than assumed.
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
  assert.equal(init.status, 0, `FIXTURE LIVENESS: git init failed, so the new-file probe would degrade to no_git and this arm would not exercise the tracked/untracked distinction at all: ${init.stderr}`);
  mkdirSync(join(dir, 'seed'), { recursive: true });
  writeFileSync(join(dir, 'seed', 'baseline.mjs'), '// seed\n');
  assert.equal(git(dir, ['add', 'seed']).status, 0, 'FIXTURE LIVENESS: git add of the seed file');
  const commit = git(dir, ['commit', '-m', 'baseline']);
  assert.equal(commit.status, 0, `FIXTURE LIVENESS: the seed commit must succeed so HEAD exists — without HEAD the ls-tree probe degrades and the new-file trigger is not exercised: ${commit.stderr}`);
  assert.equal(git(dir, ['rev-parse', 'HEAD']).status, 0, 'FIXTURE LIVENESS: HEAD resolves');
}

const isTracked = (dir, path) => git(dir, ['ls-files', '--error-unmatch', path]).status === 0;

function commitPaths(dir, paths) {
  assert.equal(git(dir, ['add', ...paths]).status, 0, 'FIXTURE LIVENESS: git add of the fixture paths');
  const commit = git(dir, ['commit', '-m', 'track fixture paths']);
  assert.equal(commit.status, 0, `FIXTURE LIVENESS: committing the fixture paths must succeed — untracked paths would make these files NEW and the arm would not isolate the threshold trigger: ${commit.stderr}`);
}

// ===========================================================================
// GROUP A — THE LANE-SCOPE LEAK
//
// A-4 is the CONTROL and is placed FIRST. Every target arm below ends in "H10
// soft-blocked (exit 2)", and a soft-block has many possible causes — an
// undischarged capture duty being the obvious one. A-4 runs the IDENTICAL
// fixture with the touched files OWNED and must pass for the OPPOSITE reason:
// H10 releases immediately and mints nothing. Ownership is the only difference
// between A-4 and A-1, so A-1's exit 2 is attributable to the ARTICLE DEMAND
// and to nothing else. Every target arm additionally asserts the capture nag
// text is ABSENT and that ZERO capture_owed items are minted, which closes the
// same alternative cause from the other side.
// ===========================================================================

test('A-4 (CONTROL, must pass for the OPPOSITE reason — placed FIRST): the identical bare-no_capture fixture whose touched files ARE owned releases on the FIRST Stop and mints nothing at all', () => {
  // SABOTAGE that must turn THIS red: make the no-duty terminal release
  // unreachable (e.g. drop the `!hasCaptureDuty` conjunct, or return 2
  // unconditionally). A control that cannot release proves nothing about A-1.
  const { dir, store, cleanup } = makeProject();
  try {
    initRepoWithHead(dir);
    const paths = ['src/o1.mjs', 'src/o2.mjs', 'src/o3.mjs'];
    touchRegister(dir, paths);
    commitPaths(dir, paths);
    for (const p of paths) assert.ok(isTracked(dir, p), `FIXTURE LIVENESS: ${p} is TRACKED, so it is not a NEW file and only ownership distinguishes this arm from A-1`);

    // The ONLY difference from A-1: these three files have an owning article.
    article(store, 'feat-owned-three', paths);
    declareNoCapture(dir);

    const r = stop(dir);
    assert.equal(
      r.code,
      0,
      `CONTROL BROKEN if this is not 0: with the capture duty discharged by a valid bare no_capture, no research/concept event, and every touched file OWNED, there is no duty left to fire — the no-duty terminal release must be reached. If this arm soft-blocks, A-1/A-2/A-3/A-6 below are not evidence about the article lane at all. stderr: ${r.stderr}`,
    );
    assert.doesNotMatch(out(r), /article demand/i, 'CONTROL BROKEN: owned territory raises no article demand — this is the "opposite reason" half');
    assert.doesNotMatch(out(r), /nothing was captured/, 'CONTROL BROKEN: the bare no_capture discharged the capture duty (AC13)');
    assert.equal(articleMissing(store).length, 0, 'CONTROL BROKEN: nothing minted on the article lane');
    assert.equal(captureOwed(store).length, 0, 'CONTROL BROKEN: nothing minted on the capture lane');
  } finally {
    cleanup();
  }
});

test('A-1: three TRACKED unowned source files with the capture duty fully discharged by a bare no_capture still raise the ARTICLE demand — a CAPTURE-lane declaration can never discharge the ARTICLE-DEMAND lane', () => {
  // SABOTAGE that must turn this red: move `newUnowned`/`articleDemand` back
  // BELOW the no-duty terminal release (equivalently: drop the
  // `(!articleDemand || imageBinaryOnly)` conjunct from the release
  // condition). EXPECT RED — the first Stop releases with 0 and no
  // article_missing item is ever minted for territory that became unowned on a
  // declaration-discharged Stop.
  const { dir, store, cleanup } = makeProject();
  try {
    initRepoWithHead(dir);
    // Three unowned files is exactly the default article-demand threshold, and
    // they are TRACKED so the NEW-FILE trigger is NOT what fires here — this
    // arm isolates the threshold trigger; A-2 isolates the new-file trigger.
    const paths = ['src/u1.mjs', 'src/u2.mjs', 'src/u3.mjs'];
    touchRegister(dir, paths);
    commitPaths(dir, paths);
    for (const p of paths) assert.ok(isTracked(dir, p), `FIXTURE LIVENESS: ${p} must be TRACKED — an untracked file would fire the new-file trigger and this arm would stop isolating the threshold one`);

    declareNoCapture(dir);

    const first = stop(dir);
    assert.equal(
      first.code,
      2,
      `LANE-SCOPE LEAK SHAPE (RED before the fix, releasing with 0): the human declared "nothing durable was learned" — a CAPTURE-lane claim (decision no-capture-discharge-is-lane-scoped, 51ebe0dd). They never declared that three unowned files need no owning article. A discharge must be no broader than the claim actually made, because silent knowledge loss is the severe direction (P5/P2). stderr: ${first.stderr}`,
    );
    assert.match(first.stderr, /article demand/i, 'the ARTICLE demand is what fired');
    assert.doesNotMatch(
      first.stderr,
      /nothing was captured/,
      'ATTRIBUTION: the capture nag must be ABSENT. Its presence would mean the bare declaration failed to discharge the capture lane, and this soft-block would be the ordinary capture nag rather than the article-only demand this arm exists to pin',
    );

    const second = stop(dir);
    assert.equal(second.code, 0, `the second Stop releases (P1 — soft-block exactly once): ${second.stderr}`);
    assert.equal(articleMissing(store).length, 1, 'exactly ONE article_missing item is minted for the three unowned files');
    assert.deepEqual(demandedPaths(store), paths.slice().sort(), 'and it names every unowned file');
    assert.equal(
      captureOwed(store).length,
      0,
      'ZERO capture_owed: the declaration DID discharge the capture lane. The two halves together are the ruling — the declaration is honoured exactly as far as it reaches, and no further',
    );
  } finally {
    cleanup();
  }
});

test('A-2: ONE newly-created unowned file — BELOW the min_unowned_files threshold — still raises the article demand on a bare-no_capture Stop, proving the NEW-FILE trigger reaches this release and not merely the threshold', () => {
  // SABOTAGE that must turn this red: move `newUnowned` back below the no-duty
  // terminal release. EXPECT RED — release with 0, nothing minted.
  //
  // WHY THIS ARM IS NOT REDUNDANT WITH A-1: the defect is that a file which
  // BECOMES unowned during such a Stop is never RAISED (board f4616312 hole 1:
  // "the lane will correct an existing item but will never RAISE one for a
  // file that became unowned during it"). A single NEW file is that shape
  // exactly. An arm that only ever exercises the >=3 threshold would leave the
  // real trigger unpinned, and a fix that restored only the threshold path
  // would pass A-1 while the reported hole stayed open.
  const { dir, store, cleanup } = makeProject();
  try {
    initRepoWithHead(dir);
    const brandNew = 'src/brand-new.mjs';
    touchRegister(dir, [brandNew]);
    assert.ok(
      !isTracked(dir, brandNew),
      'FIXTURE LIVENESS: the file must be UNTRACKED against HEAD — that is what makes it NEW. If it were tracked, the new-file trigger could not fire and a green here would mean nothing',
    );
    assert.equal(git(dir, ['rev-parse', 'HEAD']).status, 0, 'FIXTURE LIVENESS: HEAD exists, so the ls-tree probe ANSWERS instead of degrading to no_git (AC11)');

    declareNoCapture(dir);

    const first = stop(dir);
    assert.equal(
      first.code,
      2,
      `LANE-SCOPE LEAK SHAPE, NEW-FILE VECTOR (RED before the fix): ONE file created into unowned territory on a Stop whose capture duty was discharged by declaration. 1 is under the default threshold of 3, so ONLY the new-file trigger can raise this — which is precisely the trigger board f4616312 reports as muted. This is not a threshold bug and an arm that tested only the threshold would miss it. stderr: ${first.stderr}`,
    );
    assert.match(first.stderr, /article demand/i, 'the ARTICLE demand fired');
    assert.doesNotMatch(first.stderr, /nothing was captured/, 'ATTRIBUTION: not the capture nag — the bare declaration discharged that lane');

    const second = stop(dir);
    assert.equal(second.code, 0, `second Stop releases: ${second.stderr}`);
    assert.equal(articleMissing(store).length, 1, 'exactly one article_missing item');
    assert.deepEqual(demandedPaths(store), [brandNew], 'naming the newly-unowned file — the demand this hole silently dropped');
    assert.equal(captureOwed(store).length, 0, 'the capture lane stays discharged (the declaration is honoured, just not widened)');
  } finally {
    cleanup();
  }
});

test('A-3-CONTROL (must pass for the OPPOSITE reason — placed FIRST for A-3): the SAME test-glob paths with NO discharge at all fire BOTH duties, proving these paths do participate in the article demand', () => {
  // SABOTAGE that must turn THIS red: exclude toolchain test_globs from the
  // article-demand unowned set.
  //
  // WITHOUT THIS ARM, A-3 is unfalsifiable in one direction: if H10 excluded
  // test-glob paths from the unowned set, A-3's fixture could never demand
  // anything and its red would be indistinguishable from a real regression.
  // This arm asserts the fixture geometry itself.
  const { dir, store, cleanup } = makeProject();
  try {
    const paths = ['tests/alpha.test.mjs', 'tests/beta.test.mjs', 'tests/gamma.test.mjs'];
    touchRegister(dir, paths);
    // No declaration of any kind, no capture record.

    const first = stop(dir);
    assert.equal(first.code, 2, `CONTROL BROKEN if this is not 2: three unowned touched files with nothing captured must raise duties. stderr: ${first.stderr}`);
    assert.match(first.stderr, /nothing was captured/, 'CONTROL: the capture duty is genuinely ARMED by these paths — so A-3\'s absence of this text is caused by the declaration');
    assert.match(
      first.stderr,
      /article demand/i,
      'CONTROL BROKEN if absent: these test-glob paths must count toward the article demand. If H10 excludes test_globs from the unowned set, A-3\'s fixture cannot demand anything and A-3 must be re-shaped onto non-test paths — that is evidence for the conductor, not a reason to relax A-3',
    );
  } finally {
    cleanup();
  }
});

test('A-3: the same lane-scope leak through the OTHER escape — a path-specific test_repair discharge — still raises the article demand', () => {
  // SABOTAGE that must turn this red: move `articleDemand` below the no-duty
  // terminal release. EXPECT RED — release with 0, nothing minted.
  //
  // WHY A SEPARATE ARM: test_repair has the IDENTICAL escape shape to
  // no_capture (both are removed from `activeTouches`, never from `paths`), so
  // it is closed BY CONSTRUCTION rather than by a second guard. "By
  // construction" is a claim about code the oracle cannot see — unpinned, the
  // next refactor that splits the two discharge paths reopens exactly this
  // hole on the branch nobody tested.
  const { dir, store, cleanup } = makeProject();
  try {
    const paths = ['tests/alpha.test.mjs', 'tests/beta.test.mjs', 'tests/gamma.test.mjs'];
    touchRegister(dir, paths);
    for (const p of paths) declareTestRepair(dir, p, 'the assertion pinned a stale export name from before the rename, not a behavior of the code');
    assert.equal(
      readEvents(dir).filter((e) => e.kind === 'test_repair').length,
      3,
      'FIXTURE LIVENESS: all three path-specific declarations landed — a partial discharge would leave the capture duty armed and this arm would be green for the ordinary capture-nag reason',
    );

    const first = stop(dir);
    assert.equal(
      first.code,
      2,
      `LANE-SCOPE LEAK SHAPE, test_repair vector (RED before the fix): a repair declaration says "this frozen TEST was wrong, here is the evidence" — a capture-lane claim about one file. It says nothing about whether three unowned files need an owning article. stderr: ${first.stderr}`,
    );
    assert.match(first.stderr, /article demand/i, 'the ARTICLE demand fired');
    assert.doesNotMatch(
      first.stderr,
      /nothing was captured/,
      'ATTRIBUTION: the capture nag is absent, so the test_repair declarations DID discharge the capture lane and this soft-block is the article demand alone',
    );

    const second = stop(dir);
    assert.equal(second.code, 0, `second Stop releases: ${second.stderr}`);
    assert.equal(articleMissing(store).length, 1, 'exactly one article_missing item');
    assert.equal(captureOwed(store).length, 0, 'and the capture lane stays discharged — the declaration is honoured exactly as far as it reaches');
  } finally {
    cleanup();
  }
});

test('A-5 (AC1 ANTI-REGRESSION, the ruling that SURVIVES): an image/binary-only session raises NO article demand and mints NO article_missing, even well past the unowned threshold', () => {
  // SABOTAGE that must turn this red: drop `|| imageBinaryOnly` from the
  // no-duty terminal release condition.
  //
  // DEFENSE-IN-DEPTH DISCLOSURE (do not read this arm as the sole carrier):
  // the frozen AC1 arm in scripts/tests/h10-touch-noise.test.mjs also goes RED
  // under that same sabotage, on its exit-code assertion. What THIS arm adds,
  // and AC1 does not check at all, is that no article_missing ITEM is minted —
  // the durable half. The guard that carries both verdicts is the same
  // `imageBinaryOnly` conjunct; that is stated rather than implied, because a
  // comment naming a guard that is not load-bearing is how a hollow pin
  // escapes notice.
  //
  // THE RULING (board 05e298f0): inspecting an image is not knowledge-producing
  // work, so it never TRIGGERS an article duty — nothing is discharged there,
  // which is why this coexists with the lane-scope ruling rather than
  // contradicting it.
  const { dir, store, cleanup } = makeProject();
  try {
    // Four unowned image/binary touches — past the default threshold of 3, so
    // an unguarded article demand WOULD fire here.
    touchRegister(dir, ['assets/logo.png', 'assets/photo.jpg', 'assets/anim.gif', 'docs/spec.pdf']);

    const r = stop(dir);
    assert.equal(
      r.code,
      0,
      `AC1 REGRESSION SHAPE (fires as 2): hoisting the article demand above the no-duty release must NOT resurrect a duty for image/binary-only activity. Reading four images is inspection; demanding an owning article for a PNG is exactly the false demand board 05e298f0 measured (~8 in one session). stderr: ${r.stderr}`,
    );
    assert.doesNotMatch(out(r), /article demand/i, 'no demand text at all for an image/binary-only session');
    assert.equal(articleMissing(store).length, 0, 'and nothing durable is minted — the half AC1 does not check');
    assert.equal(captureOwed(store).length, 0, 'the capture lane stays silent too (AC1, unchanged)');
  } finally {
    cleanup();
  }
});

test('A-6 (the image exemption is NOT global): one image beside two unowned source files still COUNTS toward the unowned set and appears in the minted item\'s file_keys', () => {
  // SABOTAGE that must turn this red: apply the image filter to `paths` (or to
  // the `unowned` set) instead of only to the terminal-release conjunct — i.e.
  // subtract images globally. EXPECT RED twice over: the unowned count drops to
  // 2, under the threshold, so the demand never fires AND assets/shot.png
  // never reaches file_keys.
  //
  // WHY THIS ARM EXISTS: `imageBinaryOnly` appears in exactly ONE place. A
  // later refactor "simplifying" it into a global path filter is the single
  // easiest way to break this, and every other arm in this file would stay
  // green while it happened.
  const { dir, store, cleanup } = makeProject();
  try {
    const paths = ['assets/shot.png', 'src/m1.mjs', 'src/m2.mjs'];
    touchRegister(dir, paths);
    declareNoCapture(dir); // the two source touches arm the capture duty; the declaration discharges it

    const first = stop(dir);
    assert.equal(
      first.code,
      2,
      `SHAPE (fires as 0 if the image were subtracted from the unowned set): three unowned files — one of them an image — is exactly the threshold. The image exemption is about whether image-only activity TRIGGERS a duty, never about removing images from a demand that other files already raised. stderr: ${first.stderr}`,
    );
    assert.match(first.stderr, /article demand/i, 'the article demand fired: this session is NOT image-only, so the exemption does not apply');
    assert.doesNotMatch(first.stderr, /nothing was captured/, 'ATTRIBUTION: the bare declaration discharged the capture lane');

    const second = stop(dir);
    assert.equal(second.code, 0, `second Stop releases: ${second.stderr}`);
    assert.equal(articleMissing(store).length, 1, 'exactly one item');
    assert.deepEqual(
      demandedPaths(store),
      paths.slice().sort(),
      'GLOBAL-EXEMPTION SHAPE if assets/shot.png is missing: the image must still be NAMED. Two rulings coexist only because the exemption is scoped to the release condition — a global subtraction would silently shrink every mixed session\'s demand, which is the under-report direction (AC9: an under-reporting demand lane is worse than an over-reporting one)',
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// GROUP C — capture_owed TRUNCATION DISCLOSURE (board 40b378e8).
//
// The cap STAYS (a byte-identical slice(0,20) lives at
// scripts/hooks/h1-session-start.mjs and desynchronising the two was
// deliberately rejected), so these arms pin the DISCLOSURE, not the removal:
// an item whose keys were clipped must SAY SO, because "the reader cannot tell
// a complete list from a truncated one" is what made the same shape dangerous
// on the article_missing lane. Before the fix the text said only "touched 25
// file(s)" while carrying 20 keys, making the mismatch an INFERENCE.
//
// Each control is placed FIRST within its branch and must pass for the
// OPPOSITE reason: with the cap NOT binding there must be NO clause at all.
// Without them, both target arms are satisfied by an unconditional string.
// Both mint sites are covered — the ordinary second-pass site and the
// capture_pending conversion site, which previously carried NO COUNT AT ALL.
// ===========================================================================

const TRUNCATION_CLAUSE = /naming\s+(\d+)\s+of\s+(\d+)\s+touched\s+path/i;

const cpEvent = (detail, at = PENDING_AT) => ({ kind: 'capture_pending', detail, at });
const PENDING_TARGET = 'sub-lib-1';
const PENDING_DETAIL = `librarian ${PENDING_TARGET} (agent_id ${PENDING_TARGET}, agent_type librarian, files packages/store/src/librarian-lane.mjs) — article appends in flight`;

/**
 * Bounded window, same size and same reason as the frozen deferral suite: the
 * spec states the pending duty converts once the target has landed but not
 * whether the two-Stop grace restarts, so allow at most two Stops and report
 * the codes on failure.
 */
function stopsUntilOwed(dir, store, max = 2) {
  const codes = [];
  let items = captureOwed(store);
  for (let i = 0; i < max && items.length === 0; i += 1) {
    codes.push(stop(dir).code);
    items = captureOwed(store);
  }
  return { codes, items };
}

test('CO-2 (CONTROL, must pass for the OPPOSITE reason — placed FIRST): when the 20-key cap does NOT bind, the minted capture_owed carries every key and states NO truncation clause', () => {
  // SABOTAGE that must turn THIS red: append the truncation clause
  // unconditionally (drop the `clipped` guard).
  //
  // WITHOUT THIS ARM, CO-1 is satisfied by a hardcoded string that is always
  // present — a measured failure mode: "an assertion satisfiable by any
  // hardcoded literal".
  const { dir, store, cleanup } = makeProject('sterling-h10-owed-cap-');
  try {
    const paths = names('s', 5);
    article(store, 'feat-small-owned', paths); // owned, so ONLY the capture lane can speak
    touchRegister(dir, paths);

    const first = stop(dir);
    assert.equal(first.code, 2, `CONTROL BROKEN if this is not 2: five touched files with nothing captured must raise the capture duty. stderr: ${first.stderr}`);
    assert.match(first.stderr, /nothing was captured/, 'CONTROL: the capture duty, not another lane, is what fired');
    assert.equal(stop(dir).code, 0, 'the second Stop releases and mints');

    const items = captureOwed(store);
    assert.equal(items.length, 1, 'CONTROL BROKEN: exactly one capture_owed item');
    assert.equal(items[0].file_keys.length, 5, 'CONTROL BROKEN: all five keys are carried — the cap does not bind at 5');
    assert.match(String(items[0].text ?? ''), /\b5\b/, 'CONTROL BROKEN if absent: the item still states its touch count, so CO-1\'s clause assertion is about a CHANGED disclosure and not about text appearing where there was none');
    assert.doesNotMatch(
      String(items[0].text ?? ''),
      TRUNCATION_CLAUSE,
      'UNCONDITIONAL-STRING SHAPE: an item whose key list is COMPLETE must not claim a truncation. A clause that is always present tells the reader nothing, which is the same illegibility board 40b378e8 is closing',
    );
  } finally {
    cleanup();
  }
});

test('CO-1: 25 touched paths mint a capture_owed carrying 20 keys AND a text that DISCLOSES the clip — "naming 20 of 25 touched path(s)", never a bare count the reader must reconcile against the keys', () => {
  // SABOTAGE that must turn this red: revert either half — drop the appended
  // `clipped` clause, or mint `file_keys: activePaths.slice(0,20)` while the
  // text keeps counting the untruncated list.
  const { dir, store, cleanup } = makeProject('sterling-h10-owed-cap-');
  try {
    const paths = names('s', 25);
    article(store, 'feat-large-owned', paths); // owned, so the article lane is silent and only capture_owed is in play
    touchRegister(dir, paths);

    const first = stop(dir);
    assert.equal(first.code, 2, `PRECONDITION: 25 touched files with nothing captured raise the capture duty. stderr: ${first.stderr}`);
    assert.doesNotMatch(first.stderr, /article demand/i, 'PRECONDITION: every touched file is owned, so the article lane is silent and this arm is about capture_owed alone');
    assert.equal(stop(dir).code, 0, 'the second Stop releases and mints');

    const items = captureOwed(store);
    assert.equal(items.length, 1, 'exactly one capture_owed item');
    assert.equal(items[0].file_keys.length, 20, 'the cap is UNCHANGED at 20 — this fix disclosed the clip, it did not remove it (a second identical slice(0,20) lives in H1 and desynchronising them was rejected)');
    for (const k of items[0].file_keys) assert.ok(paths.includes(k), `every carried key is one of the touched paths (got ${k})`);

    const text = String(items[0].text ?? '');
    const m = text.match(TRUNCATION_CLAUSE);
    assert.ok(
      m,
      `SILENT-TRUNCATION SHAPE (this is the assertion that was RED before the fix): the item carries 20 keys for 25 touched paths and must SAY so. The pre-fix text said only "touched 25 file(s)", which makes the count/keys mismatch an INFERENCE the reader has to perform — and a reader who does not perform it cannot tell a complete list from a truncated one (board 40b378e8, item 3). Text was: ${text}`,
    );
    assert.equal(Number(m[1]), 20, `the clause states the number of keys ACTUALLY named (20). Text was: ${text}`);
    assert.equal(Number(m[2]), 25, `and the number of paths actually touched (25) — the two numbers come off the two real lists, so a reader can see exactly what is missing. Text was: ${text}`);
  } finally {
    cleanup();
  }
});

test('CO-4 (CONTROL for the capture_pending branch, must pass for the OPPOSITE reason — placed FIRST): a pending conversion whose cap does NOT bind carries every key and states NO truncation clause', () => {
  // SABOTAGE that must turn THIS red: append the clause unconditionally at the
  // capture_pending conversion site.
  const { dir, store, cleanup } = makeProject('sterling-h10-owed-cap-');
  try {
    const paths = names('p', 5);
    article(store, 'feat-pending-small-owned', paths);
    touchRegister(dir, paths);
    writeSessionEvents(dir, [cpEvent(PENDING_DETAIL)]);
    writeRegisterRaw(dir, []); // the named target is NOT live, so the declaration converts rather than carrying

    const { codes, items } = stopsUntilOwed(dir, store);
    assert.equal(items.length, 1, `CONTROL BROKEN if this is not 1: with nothing live, a capture_pending must convert to exactly one capture_owed within two Stops. Codes: [${codes.join(', ')}]`);
    assert.match(
      String(items[0].text ?? ''),
      new RegExp(PENDING_TARGET),
      'CONTROL BROKEN if absent: the item cites the pending TARGET, which is what proves this item came from the capture_pending CONVERSION site and not from the ordinary second-pass site — without it, CO-3 could be measuring the wrong branch entirely',
    );
    assert.equal(items[0].file_keys.length, 5, 'CONTROL BROKEN: all five keys carried — the cap does not bind at 5');
    assert.doesNotMatch(
      String(items[0].text ?? ''),
      TRUNCATION_CLAUSE,
      'UNCONDITIONAL-STRING SHAPE at the pending site: a complete key list must not claim a truncation',
    );
  } finally {
    cleanup();
  }
});

test('CO-3: the capture_pending CONVERSION site discloses its clip too — 25 touched paths convert to one capture_owed with 20 keys and "naming 20 of 25 touched path(s)"', () => {
  // SABOTAGE that must turn this red: revert the conversion site alone (leave
  // the second-pass site fixed) — i.e. mint `file_keys: activePaths.slice(0,20)`
  // there without the disclosure. CO-1 stays GREEN under that sabotage, which
  // is exactly why this branch needs its own arm.
  //
  // THIS IS THE WEAKER OF THE TWO SITES: before the fix the pending branch
  // carried NO COUNT AT ALL, so its truncation was not merely an inference —
  // it was invisible.
  const { dir, store, cleanup } = makeProject('sterling-h10-owed-cap-');
  try {
    const paths = names('p', 25);
    article(store, 'feat-pending-large-owned', paths); // owned: the article lane stays silent
    touchRegister(dir, paths);
    writeSessionEvents(dir, [cpEvent(PENDING_DETAIL)]);
    writeRegisterRaw(dir, []); // target not live => the declaration converts to debt

    const { codes, items } = stopsUntilOwed(dir, store);
    assert.equal(items.length, 1, `PRECONDITION: the pending declaration converts to exactly one capture_owed within two Stops. Codes: [${codes.join(', ')}]`);
    assert.match(
      String(items[0].text ?? ''),
      new RegExp(PENDING_TARGET),
      'BRANCH LIVENESS: the item cites the pending target, proving this measurement is of the capture_pending CONVERSION site — the branch this arm exists for — and not of the ordinary mint',
    );
    assert.equal(items[0].file_keys.length, 20, 'the cap binds identically on this branch (unchanged value, by design)');
    for (const k of items[0].file_keys) assert.ok(paths.includes(k), `every carried key is one of the touched paths (got ${k})`);

    const text = String(items[0].text ?? '');
    const m = text.match(TRUNCATION_CLAUSE);
    assert.ok(
      m,
      `SILENT-TRUNCATION SHAPE at the WEAKER site (RED before the fix): this branch previously stated no path count at all, so a reader could not even infer that 5 of the 25 touched paths were missing from the item. Text was: ${text}`,
    );
    assert.equal(Number(m[1]), 20, `the clause names the keys actually carried. Text was: ${text}`);
    assert.equal(Number(m[2]), 25, `and the paths actually touched. Text was: ${text}`);
  } finally {
    cleanup();
  }
});
