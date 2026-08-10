// H20 stage-2 THIRD floor: RECORD CENTRALITY (board/decision TBD — reconstructs
// the measured 2026-08-09 Blender false-positive). The first two stage-2 floors
// (>=2 distinct prompt-term hits; at least one discriminating hit) ask whether
// the OUTGOING prompt is specific enough. Neither asks whether the matched
// terms are CENTRAL TO THE RECORD ITSELF — a record whose subject is modeling
// topology can still fire on a game/field/cell dispatch if those words happen
// to appear once each in its trigger, because frequency inside the record was
// never examined. This file specifies the fix: a record's OWN top-K terms
// (frequency-ranked over its narrow text) must overlap the outgoing text
// before it may be delivered — composing AFTER the existing floors, never
// replacing them.
//
// This file is deliberately a SEPARATE test file, not an edit to
// scripts/tests/h20-mechanism-axis.test.mjs — it reuses that file's harness
// style (temp project + store fixtures, runHook/dispatch helpers) without
// modifying it.
//
// NEW exports under test (do not exist yet — this is the red gate):
//   AXIS_RECORD_TOP_K = 6, AXIS_MIN_RECORD_TERMS = 2 (constants)
//   hasRecordCentralityHit(record, outgoingText, opts?) -> boolean
// and a header change: when H20 fires, its 'matched on: ...' line also
// carries a clause containing 'central to the record' naming the covered
// central terms.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-03T12:00:00.000Z';

let SterlingStore;
let hasRecordCentralityHit;
let AXIS_RECORD_TOP_K;
let AXIS_MIN_RECORD_TERMS;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  // Dynamic import: destructuring a not-yet-existing named export yields
  // `undefined` here rather than throwing at load time (unlike a static
  // `import { x } from ...`), so each test fails on its OWN assertion/call
  // instead of the whole file crashing before any test runs.
  ({ hasRecordCentralityHit, AXIS_RECORD_TOP_K, AXIS_MIN_RECORD_TERMS } = await import(
    pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href
  ));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h20-mechanism-axis.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function antiPattern(title, trigger, paths = []) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: paths,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-centrality-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function dispatch(dir, prompt, subagent_type = 'coder') {
  return { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type, prompt }, cwd: dir };
}

// --- fixture vocabulary -------------------------------------------------
//
// Six modeling-domain words repeated 3x each (title 1x + trigger 2x) so they
// deterministically dominate the record's own top-6 by raw frequency; every
// other content word in the same narrow text (title+trigger) appears exactly
// once, so none of them can crowd into the top-6.
const CENTRAL_TITLE = 'Boolean modifier mesh manifold topology solver stability failure';
const CENTRAL_TRIGGER =
  'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
// -> boolean/modifier/mesh/manifold/topology/solver: freq 3 each (title+trigger)
//    recur/constantly/though/bug/rarely/touches/game/field/cell/setup/work: freq 1 each

// --- 1. UNIT: true/false on a hand-built top-6 -----------------------------

test('hasRecordCentralityHit: true when >=2 of the record\'s own top-6 terms appear in the outgoing text', () => {
  const record = antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER);
  // Shares 'boolean' and 'mesh' (2 of the top-6) with the record's narrow text.
  const outgoing = 'Please handle the boolean operation and clean up the mesh before export.';
  assert.equal(hasRecordCentralityHit(record, outgoing), true);
});

test('hasRecordCentralityHit: false when the outgoing text hits only PERIPHERAL (non-top-6) words', () => {
  const record = antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER);
  // Shares every peripheral, freq-1 word (game/field/cell/bug/setup) but NONE
  // of the six dominant modeling terms — must not count as central.
  const outgoing = 'The bug in the game field cell setup recurs constantly though it rarely touches anything else.';
  assert.equal(hasRecordCentralityHit(record, outgoing), false, 'peripheral overlap is not centrality');
});

// --- 2. UNIT: degenerate scaling (fewer than AXIS_MIN_RECORD_TERMS own terms)

// Narrow text built almost entirely from words confirmed dropped by the
// existing extractor (scripts/tests/h20-mechanism-axis.test.mjs: 'extractAxisTerms:
// drops dispatch boilerplate and short words' proves verify/record/store/report/
// evidence/file/this/the never survive extraction) plus ONE substantive word
// repeated — so the record has exactly one extractable own term.
const TERSE_TITLE = 'Quaternion';
const TERSE_TRIGGER =
  'verify record store report evidence this file the quaternion quaternion quaternion ' +
  'the file evidence report store record verify this';

test('hasRecordCentralityHit: degenerate scaling — a record with only 1 extractable own term needs only that 1 present', () => {
  const record = antiPattern(TERSE_TITLE, TERSE_TRIGGER);
  const hit = 'Refactor the quaternion interpolation code in the physics module.';
  const miss = 'Refactor the vector interpolation code in the physics module.';
  assert.equal(hasRecordCentralityHit(record, hit), true, 'min(AXIS_MIN_RECORD_TERMS, 1) === 1, and it is present');
  assert.equal(hasRecordCentralityHit(record, miss), false, 'the one required term is absent');
});

// --- exported constants ------------------------------------------------

test('delivery.mjs exports AXIS_RECORD_TOP_K=6 and AXIS_MIN_RECORD_TERMS=2', () => {
  assert.equal(AXIS_RECORD_TOP_K, 6);
  assert.equal(AXIS_MIN_RECORD_TERMS, 2);
});

// --- 3. E2E: the reconstructed Blender false positive — must go SILENT -----

test('H20: SILENT on a modeling-dominated record when only its PERIPHERAL words match the prompt (the 2026-08-09 Blender case)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // A record whose subject, by frequency, is unmistakably boolean/modifier/
    // mesh/manifold/topology/solver — but whose trigger also happens to
    // mention game/field/cell once each, in passing.
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER, ['modeling/boolean_tool.gd']));
    // A dispatch about an entirely different subject (game field cells) that
    // repeats 'game'/'field'/'cell' enough to satisfy the OLD stage-2 floors
    // on its own: >=2 distinct hits, at least one discriminating (none of
    // game/field/cell is universal dev vocabulary) — so under the OLD code
    // (no centrality floor) this record FIRES. That firing is exactly the
    // bug: this test must fail against current code.
    const r = runHook(
      dispatch(
        dir,
        'Write tests for the game field cell logic: cover the game field cell grid, ' +
          'the field cell adjacency rules, and the game field cell lifecycle events.'
      ),
      dir
    );
    assert.equal(r.code, 0, 'never blocks (AC7)');
    assert.equal(
      r.stdout,
      '',
      'the record\'s central vocabulary (boolean/modifier/mesh/manifold/topology/solver) never ' +
        'appears in this prompt — only its peripheral words do, so the centrality floor must silence it'
    );
  } finally {
    cleanup();
  }
});

// --- 4. E2E: still fires when central terms genuinely overlap -------------

test('H20: still FIRES when >=2 of the record\'s own central terms appear in the prompt, and the header names the centrality clause', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER, ['modeling/boolean_tool.gd']));
    const r = runHook(
      dispatch(
        dir,
        'Investigate why the boolean operation corrupts the mesh: check whether the modifier ' +
          'stack introduces non-manifold geometry that breaks downstream processing.'
      ),
      dir
    );
    assert.equal(r.code, 0);
    assert.notEqual(r.stdout, '', 'boolean/mesh/modifier are central terms of the record — it must still deliver');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /Boolean modifier mesh manifold topology solver stability failure/, 'the hazard reaches the conductor');
    const matchedLine = ctx.split('\n').find((l) => l.includes('matched on:'));
    assert.ok(matchedLine, 'the header names which terms matched');
    assert.match(matchedLine, /central to the record/, 'the header carries the new centrality clause');
    assert.match(matchedLine, /\b(boolean|mesh|modifier)\b/, 'and names which central terms were covered');
  } finally {
    cleanup();
  }
});

// --- 5. E2E: existing floors are preserved, not replaced -------------------

test('H20: centrality passing is NOT enough on its own — a single distinct prompt-term hit still stays silent (AXIS_MIN_HITS preserved)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // Degenerate record (as in the unit test above): exactly one extractable
    // own term, 'quaternion', so AXIS_MIN_RECORD_TERMS scales down to 1 and
    // centrality is trivially satisfiable by that single word.
    store.create(antiPattern(TERSE_TITLE, TERSE_TRIGGER, ['physics/quat.gd']));
    // The prompt shares ONLY 'quaternion' with the record's narrow text — one
    // distinct hit total, below the pre-existing AXIS_MIN_HITS=2 floor. If the
    // new centrality floor were composed in place of (rather than after) the
    // old floors, this would wrongly fire; it must not.
    const r = runHook(dispatch(dir, 'Refactor the quaternion interpolation code in the physics module.'), dir);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'only one distinct prompt-term hit — the pre-existing floor silences it regardless of centrality');
  } finally {
    cleanup();
  }
});
