// DIRECT-MERGE BOARD-PAYMENT NUDGE (user-directed 2026-08-27).
//
// SPEC UNDER TEST (dispatch brief, NOT read from any in-flight implementation
// diff): scripts/direct-merge.mjs, on a SUCCESSFUL merge, prints to STDERR an
// advisory listing every OPEN, USER-source board todo whose file_keys
// intersect the files the merged branch changed. Contract pinned here:
//   - advisory only: never refuses a merge, never closes/removes anything,
//     never alters the stdout JSON report shape or the exit code;
//   - printed ONLY on a successful merge, ONLY when >=1 user item intersects
//     (empty intersection => zero nudge output, not an empty header);
//   - matches on file_keys ∩ branch-changed files, user-source items ONLY —
//     system/maintenance items (a different, existing report) never trigger it;
//   - each listed line carries the item's FULL id (board_remove demands exact
//     full ids — no prefix, no truncation), a clipped text prefix, and the
//     intersecting keys;
//   - header line contains the literal phrase "BOARD-PAYMENT NUDGE".
//
// This file authors tests from THAT SPEC, not from scripts/direct-merge.mjs,
// which was not read (spec-only dispatch). Fixture/harness idiom cribbed from
// scripts/tests/direct-merge-cleared-report.test.mjs (makeGitProjectNoRun /
// runDirectMerge / envelope / articleWithBaseline / git helpers), duplicated
// here rather than imported — that file exports nothing; test files are not
// designed as modules. Store writes go through the store API in-process
// (SterlingStore.create), the sanctioned test path per that file's precedent.
//
// The real board-item field shapes used below (user todo: text/source/
// file_keys/priority/objective/status; system todo: text/source/file_keys/
// feature_link/system_reason/status) were confirmed live against this
// project's own store via board_query (source:'user' and source:'system',
// projection:'full') before writing this file — not guessed from memory.
// 'promotion_review' is a real, currently-live system_reason distinct from
// 'reconcile_needed' (the only system_reason the merge gate's existing
// liveness predicate refuses on), which is what makes it safe for the
// SOURCE-DISCRIMINATION pin: it covers a changed file without itself being
// eligible to block the merge, isolating the source-filter behavior from the
// reconcile-refusal behavior entirely.
//
// CAUTION (anti-pattern ee89c3fd): raw child-process stderr is NEVER
// interpolated directly into an assertion message expected to fail — always
// flattened via oneLine() first, so a multi-line diagnostic cannot start a
// YAML line and misdirect the TAP crash classifier.
//
// FIVE PINS (pin 5 added at roster-review's recommendation after the first
// four were authored). Each test names its SABOTAGE in the test title
// (documented intent — sabotages are never applied in this file):
//   1. CONTROL (placed first) — an open user todo exists but its file_keys do
//      NOT intersect the branch's changed files; merge succeeds and NO nudge
//      output appears. Proves the header cannot be satisfied by printing it
//      unconditionally whenever any open user todo exists.
//   2. POSITIVE — an open user todo's file_keys DO intersect; merge succeeds
//      and stderr carries the header + the todo's full id.
//   3. SOURCE DISCRIMINATION — only an intersecting SYSTEM-source item
//      (system_reason: promotion_review, non-blocking) exists; no user item;
//      merge succeeds and the header never appears.
//   4. NEVER-A-GATE — with an intersecting user todo present, the exit code
//      and stdout JSON shape are identical to a no-intersection run (same
//      keys, same exit code, a 'pushed' key present in both) — the nudge
//      must not touch the machine-readable contract.
//   5. REFUSAL-SILENCE — an intersecting open user todo exists (the nudge
//      WOULD print on success) but live reconcile_needed debt independently
//      refuses the merge; stderr names the reconcile refusal and never the
//      nudge header. Forward guard against a refactor hoisting the nudge
//      print above the refusal gates.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = '2026-08-27T12:00:00.000Z';

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
      files.map((f) => [f.path, f.baseline !== undefined ? f.baseline : sha256hex(f.content)])
    ),
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: at, event: 'originating brief' }],
    live_test_refs: [],
  });
}

/** An OPEN user-source board todo — "open" means the record simply exists;
 * board items are removed only by board_remove (P4), never by a status flag. */
function userTodo(store, { text, file_keys, priority = 'normal', objective = 'test-objective' } = {}) {
  return store.create({
    ...envelope('todo'),
    text,
    source: 'user',
    file_keys,
    priority,
    objective,
  });
}

/** A SYSTEM-source maintenance-queue item using a real, non-blocking
 * system_reason (promotion_review) — distinct from reconcile_needed, the
 * only system_reason the merge gate's existing liveness predicate refuses
 * a merge on. Linked to a real article so feature_link is never dangling. */
function systemPromotionItem(store, { text, file_keys, article }) {
  return store.create({
    ...envelope('todo'),
    text,
    source: 'system',
    file_keys,
    feature_link: article.id,
    system_reason: 'promotion_review',
  });
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${oneLine(r.stderr)}`);
  return (r.stdout ?? '').trim();
}

function makeGitProjectNoRun(prefix = 'sterling-dm-nudge-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
// 1. CONTROL (placed first) — open user todo exists, but does NOT intersect
//    the branch's changed files. Merge succeeds; NO nudge output.
// =========================================================================

test('1 [control]: an open user todo exists but its file_keys do not intersect the branch-changed files — merge succeeds and stderr carries no BOARD-PAYMENT NUDGE — sabotage: printing the nudge header whenever any open user todo exists, without checking file_keys intersection at all, which must flip this red (header present despite zero intersection)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'src', 'y.mjs'), 'export const y = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed x and y']);

    const store = openStore(dir);
    // file_keys names y, which the branch below never touches.
    const item = userTodo(store, { text: 'unrelated todo about y', file_keys: ['src/y.mjs'] });
    store.close();

    git(dir, ['checkout', '-b', 'feat/no-intersect']);
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 2;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change x only']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `merge with a non-intersecting user todo must still succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /BOARD-PAYMENT NUDGE/, 'no intersecting user item exists, so the nudge header must not appear');
    assert.ok(!r.stderr.includes(item.id), 'the non-intersecting item id must not be printed either');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 2. POSITIVE — an open user todo intersects the branch-changed files.
// =========================================================================

test('2 [positive]: an open user todo whose file_keys intersect the branch-changed files is named on stderr after a successful merge — sabotage: never emitting the nudge advisory (deleting/never wiring the board-scan-and-print step), which must flip this red (no BOARD-PAYMENT NUDGE header, no item id in stderr)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed x']);

    const store = openStore(dir);
    const item = userTodo(store, { text: 'follow up on x once the branch lands', file_keys: ['src/x.mjs'] });
    store.close();

    git(dir, ['checkout', '-b', 'feat/intersect']);
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 2;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change x']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `merge must succeed — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /BOARD-PAYMENT NUDGE/, 'an intersecting open user todo must produce the nudge header');
    assert.ok(r.stderr.includes(item.id), 'the nudge names the todo by its FULL id (board_remove demands exact full ids)');
    assert.ok(r.stderr.includes('src/x.mjs'), 'the nudge names the intersecting file_keys');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 3. SOURCE DISCRIMINATION — only a system-source item intersects.
// =========================================================================

test('3 [source discrimination]: only an intersecting SYSTEM-source item (system_reason: promotion_review, a real non-blocking reason) exists — no user item — merge succeeds and the nudge header never appears — sabotage: matching on file_keys intersection regardless of source (folding system-source items into the same scan as user-source items), which must flip this red (BOARD-PAYMENT NUDGE present, sourced from the system item alone)', () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed x']);

    const store = openStore(dir);
    // The article's OWNED file (files[]/file_baselines) is deliberately
    // docs/unrelated.md, never src/x.mjs — the branch below only ever
    // changes src/x.mjs, so this article can never mint reconcile_needed
    // debt against it. The system todo's file_keys still name src/x.mjs (the
    // field this pin's source-discrimination check must key on), decoupling
    // "does the system item's file_keys intersect the branch diff" (yes) from
    // "does the linked article own a branch-changed file" (no) so the merge
    // gate's own settlement minting can never refuse before the nudge runs.
    const article = articleWithBaseline(store, 'feat-source-disc', [{ path: 'docs/unrelated.md', content: '# unrelated\n' }]);
    const item = systemPromotionItem(store, {
      text: 'review this research finding for promotion',
      file_keys: ['src/x.mjs'],
      article,
    });
    store.close();

    git(dir, ['checkout', '-b', 'feat/system-only']);
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 2;\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change x']);

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `a promotion_review item never blocks a merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.doesNotMatch(r.stderr, /BOARD-PAYMENT NUDGE/, 'a system-source item alone must never trigger the user-todo nudge');
    assert.ok(!r.stderr.includes(item.id), 'the system item id must not appear under the nudge header');
  } finally {
    cleanup();
  }
});

// =========================================================================
// 4. NEVER-A-GATE — exit code and stdout JSON shape are unaffected.
// =========================================================================

test('4 [never-a-gate]: with an intersecting user todo present, the exit code and stdout JSON shape (including a present \'pushed\' key) are identical to a run with no intersecting item — sabotage: making the nudge alter the stdout report (e.g. appending nudge data to the JSON) or the exit code (e.g. nonzero to force acknowledgment) whenever items are found, which must flip this red (differing key sets and/or differing exit codes between the two runs)', () => {
  const baseline = makeGitProjectNoRun('sterling-dm-nudge-baseline-');
  const withNudge = makeGitProjectNoRun('sterling-dm-nudge-present-');
  try {
    // Baseline run: an initialized-but-EMPTY store (zero items) — every other
    // pin gets its store as a side effect of openStore() creating the db file
    // on first open; this fixture must do the same explicitly, or the gate
    // refuses outright with "no Sterling store at <dir>/.sterling/sterling.db
    // — not an initialized project" before it ever reaches nudge logic.
    openStore(baseline.dir).close();

    mkdirSync(join(baseline.dir, 'src'), { recursive: true });
    writeFileSync(join(baseline.dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    git(baseline.dir, ['add', '-A']);
    git(baseline.dir, ['commit', '-m', 'seed x']);
    git(baseline.dir, ['checkout', '-b', 'feat/baseline']);
    writeFileSync(join(baseline.dir, 'src', 'x.mjs'), 'export const x = 2;\n');
    git(baseline.dir, ['add', '-A']);
    git(baseline.dir, ['commit', '-m', 'change x']);
    const rBaseline = runDirectMerge(baseline.dir);
    assert.equal(rBaseline.status, 0, `baseline merge must succeed — stdout=${oneLine(rBaseline.stdout)} stderr=${oneLine(rBaseline.stderr)}`);
    assert.doesNotMatch(rBaseline.stderr, /BOARD-PAYMENT NUDGE/, 'baseline run has no board items, so no nudge should appear');

    // Nudge-present run: an intersecting open user todo exists.
    mkdirSync(join(withNudge.dir, 'src'), { recursive: true });
    writeFileSync(join(withNudge.dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    git(withNudge.dir, ['add', '-A']);
    git(withNudge.dir, ['commit', '-m', 'seed x']);
    const store = openStore(withNudge.dir);
    userTodo(store, { text: 'follow up on x', file_keys: ['src/x.mjs'] });
    store.close();
    git(withNudge.dir, ['checkout', '-b', 'feat/with-nudge']);
    writeFileSync(join(withNudge.dir, 'src', 'x.mjs'), 'export const x = 2;\n');
    git(withNudge.dir, ['add', '-A']);
    git(withNudge.dir, ['commit', '-m', 'change x']);
    const rNudge = runDirectMerge(withNudge.dir);
    assert.equal(rNudge.status, 0, `nudge-present merge must still succeed — stdout=${oneLine(rNudge.stdout)} stderr=${oneLine(rNudge.stderr)}`);
    assert.match(rNudge.stderr, /BOARD-PAYMENT NUDGE/, 'sanity: this run really does carry the nudge');

    assert.equal(rNudge.status, rBaseline.status, 'the nudge must never change the merge gate exit code');

    let baselineJson, nudgeJson;
    assert.doesNotThrow(() => { baselineJson = JSON.parse(rBaseline.stdout); }, 'baseline stdout must be pure JSON');
    assert.doesNotThrow(() => { nudgeJson = JSON.parse(rNudge.stdout); }, 'nudge-present stdout must be pure JSON');

    assert.ok(Object.prototype.hasOwnProperty.call(baselineJson, 'pushed'), "baseline stdout JSON must carry a 'pushed' key");
    assert.ok(Object.prototype.hasOwnProperty.call(nudgeJson, 'pushed'), "nudge-present stdout JSON must carry a 'pushed' key");

    const baselineKeys = Object.keys(baselineJson).sort();
    const nudgeKeys = Object.keys(nudgeJson).sort();
    assert.deepEqual(nudgeKeys, baselineKeys, 'the nudge must never add, remove, or rename stdout JSON keys — the report shape is unaffected by advisory output on stderr');
  } finally {
    baseline.cleanup();
    withNudge.cleanup();
  }
});

// =========================================================================
// 5. REFUSAL-SILENCE — the nudge never prints on a refused merge.
// =========================================================================
//
// Added at roster-review's recommendation: the shipped implementation
// computes and prints the nudge in a self-contained block immediately after
// the merge lands (structurally unreachable pre-merge), so this pin is a
// forward guard against a future refactor hoisting that print above a
// refusal gate rather than a defect found in the current shape.

test("5 [refusal-silence]: an intersecting open user todo exists (the nudge WOULD print on success) but the merge is independently refused by live reconcile_needed debt — stderr names the reconcile refusal and never the nudge header — sabotage: moving the nudge print above the refusal gates (e.g. computing/printing it before checking mint results), which must flip this red (BOARD-PAYMENT NUDGE present despite a refused merge)", () => {
  const { dir, cleanup } = makeGitProjectNoRun();
  try {
    const original = 'export const x = 1;\n';
    const changed = 'export const x = 2;\n';
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.mjs'), original);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'seed x']);

    const store = openStore(dir);
    // Article baseline is stamped to the ORIGINAL content — the branch below
    // changes src/x.mjs, so the gate's own settlement minting (no manually
    // created reconcile_needed item needed) mints live debt against this
    // owning article at merge time and refuses. This is the exact shape
    // pin 3 used before its decoupling fix, confirmed live to produce
    // "1 open reconcile_needed item(s) ... reconcile before merging".
    articleWithBaseline(store, 'feat-refusal-silence', [{ path: 'src/x.mjs', content: original }]);
    // An intersecting open user todo — if the refusal gate did not fire
    // first, this is exactly the shape pin 2 proved produces the nudge.
    userTodo(store, { text: 'follow up on x once it lands', file_keys: ['src/x.mjs'] });
    store.close();

    git(dir, ['checkout', '-b', 'feat/refusal-silence']);
    writeFileSync(join(dir, 'src', 'x.mjs'), changed);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'change x under live reconcile debt']);

    const r = runDirectMerge(dir);
    assert.notEqual(r.status, 0, `a genuinely-drifted article must refuse the merge — stdout=${oneLine(r.stdout)} stderr=${oneLine(r.stderr)}`);
    assert.match(r.stderr, /reconcile before merging/, 'the refusal is attributed to reconcile debt specifically — a control against passing via some unrelated failure');
    assert.doesNotMatch(r.stderr, /BOARD-PAYMENT NUDGE/, 'the nudge must never print on a refused merge, even when an intersecting user todo exists');
  } finally {
    cleanup();
  }
});
