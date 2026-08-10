// H19/H20 relevance slice 3 (board 8f3141d4) — MECHANISM-AXIS STAGING at
// SubagentStart. scripts/hooks/h19-dispatch-staging.mjs today stages ONLY
// path-scoped knowledge (governed territory named by repo-relative paths in
// the recovered dispatch prompt). This file specifies the NEW composed
// behavior: the SAME recovered prompt text is also run through the H20
// mechanism-axis (subject) match, and subject-matched anti_patterns/decisions
// are appended to the SAME payload under the SAME guard — including for
// dispatches that name NO path at all (today: silent early exit).
//
// This is a NEW file. It does not edit scripts/tests/h19-dispatch-staging.mjs
// (path-channel coverage, untouched) or scripts/tests/h20-centrality.test.mjs
// (unit-level centrality floor coverage, untouched) — it reuses both files'
// fixture patterns (transcript replay + antiPattern vocabulary trick) at the
// h19-dispatch-staging.mjs entry point, which is the seam this slice changes.
//
// RED-GATE NOTE: none of this behavior exists yet. Every test below is
// expected to fail against current HEAD — see the per-test comment for the
// expected failure shape (empty stdout where a payload is required, or a
// payload missing the new header clause / still-guarded content).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-10T12:00:00.000Z';

let SterlingStore;
const { before } = await import('node:test');
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h19-dispatch-staging.mjs')], {
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

function article(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-axis-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

// --- transcript fixture helpers (h19-dispatch-staging.test.mjs pattern) ----

function taskBlock(prompt, name = 'Task') {
  return { type: 'tool_use', name, input: { prompt } };
}

function assistantLine(blocks) {
  return JSON.stringify({ type: 'assistant', message: { content: blocks } });
}

function writeTranscript(dir, lines) {
  const p = join(dir, `transcript-${randomUUID()}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

const subagentStart = (dir, transcriptPath, extra = {}) => ({
  hook_event_name: 'SubagentStart',
  session_id: 's1',
  transcript_path: transcriptPath,
  cwd: dir,
  prompt_id: 'p1',
  agent_id: 'agent-1',
  agent_type: 'general-purpose',
  ...extra,
});

const guardOf = (dir, agentId) => {
  const p = join(dir, '.sterling', 'transient', 'delivery', `guard-agent-${agentId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

// --- fixture vocabulary (h20-centrality.test.mjs pattern) ------------------
//
// Six modeling-domain words repeated 3x each (title 1x + trigger 2x) so they
// deterministically dominate the record's own top-6 by raw frequency; every
// other content word in the same narrow text (title+trigger) appears exactly
// once, so none of them can crowd into the top-6.
const CENTRAL_TITLE = 'Boolean modifier mesh manifold topology solver stability failure';
const CENTRAL_TRIGGER =
  'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const PERIPHERAL_PROMPT =
  'The bug in the game field cell setup recurs constantly though it rarely touches anything else.';
const CENTRAL_PROMPT =
  'Investigate why the boolean operation corrupts the mesh: check whether the modifier stack ' +
  'introduces non-manifold geometry that breaks downstream processing.';

// A record with exactly one extractable own term ('quaternion') — the rest of
// its narrow text is confirmed-dropped dispatch boilerplate (h20-mechanism-
// axis.test.mjs: 'extractAxisTerms: drops dispatch boilerplate and short
// words'). Used to prove the pre-existing AXIS_MIN_HITS>=2 floor still governs
// even when the (trivially-satisfied, scaled-down) centrality floor passes.
const TERSE_TITLE = 'Quaternion';
const TERSE_TRIGGER =
  'verify record store report evidence this file the quaternion quaternion quaternion ' +
  'the file evidence report store record verify this';

function findRecordByTitle(store, title) {
  const hits = store.query({ types: ['anti_pattern'], rank_terms: [title.split(' ')[0].toLowerCase()], cap: 20 });
  return hits.find((r) => r.title === title);
}

// --- a. subject-only delivery ------------------------------------------

test('a. no path in the prompt, but the prompt matches a stored anti_pattern\'s central terms: payload delivered with the new header clauses and the guard is written', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock(CENTRAL_PROMPT)])]);
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(r.stdout, '', 'a subject match with no path must still deliver (today: silent early exit)');

    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(CENTRAL_TITLE), 'the subject-matched record reaches the spawned agent');

    const matchedLine = ctx.split('\n').find((l) => l.includes('matched on:'));
    assert.ok(matchedLine, 'a header line names what matched');
    assert.match(matchedLine, /central to the record:/, 'the header carries the centrality clause');
    assert.doesNotMatch(ctx, /about to dispatch/i, 'addressed to the SPAWNED agent, not the dispatching conductor');

    const rec = findRecordByTitle(store, CENTRAL_TITLE);
    assert.ok(rec, 'fixture record recorded in the store');
    const guard = guardOf(dir, 'agent-1');
    assert.ok(guard, 'guard file written for the spawned agent');
    assert.ok(guard.records.includes(rec.id), 'subject-matched record id appended to the guard');
  } finally {
    cleanup();
  }
});

// --- b. centrality floor holds through the composed hook -----------------

test('b. no path, prompt hits only the record\'s PERIPHERAL (non-central) words: stays silent, exit 0', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock(PERIPHERAL_PROMPT)])]);
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      '',
      'peripheral-only overlap must not count as a subject match, mirroring the 2026-08-09 Blender case'
    );
  } finally {
    cleanup();
  }
});

// --- c. composition: one payload, both channels present -------------------

test('c. prompt names a governed file AND subject-matches a different anti_pattern: ONE stdout JSON carries both blocks', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER)); // no file_keys — subject-channel only
    const transcript = writeTranscript(dir, [
      assistantLine([taskBlock(`Go read src/a.mjs and fix the bug there. Separately: ${CENTRAL_PROMPT}`)]),
    ]);
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(r.stdout, '');

    // JSON.parse on the WHOLE stdout succeeding is itself proof of "one
    // payload" — two independently-emitted JSON blobs would fail this parse.
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /alpha does the alpha thing/, 'path-scoped article block present');
    assert.match(ctx, new RegExp(CENTRAL_TITLE), 'subject-matched hazard block present in the SAME payload');
  } finally {
    cleanup();
  }
});

// --- d. cross-channel dedup -------------------------------------------

test('d. a record reachable through BOTH the path channel (owns the named file) and the subject channel appears exactly once', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER, ['src/a.mjs']));
    const transcript = writeTranscript(dir, [
      assistantLine([taskBlock(`Go read src/a.mjs. ${CENTRAL_PROMPT}`)]),
    ]);
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(r.stdout, '');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const occurrences = (ctx.match(new RegExp(CENTRAL_TITLE, 'g')) || []).length;
    assert.equal(occurrences, 1, 'reachable via both channels, but must not be duplicated in the payload');
  } finally {
    cleanup();
  }
});

// --- e. guard dedup on a second identical dispatch -------------------------

test('e. a second identical SubagentStart after a subject-only delivery yields empty stdout (guard dedup)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER));
    const transcript = writeTranscript(dir, [assistantLine([taskBlock(CENTRAL_PROMPT)])]);
    const first = runHook(subagentStart(dir, transcript), dir);
    assert.equal(first.code, 0, first.stderr);
    assert.notEqual(first.stdout, '', 'sanity: the first run must actually deliver something to guard against');

    const second = runHook(subagentStart(dir, transcript), dir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, '', 'nothing fresh to stage — the guard already marked this record for this agent');
  } finally {
    cleanup();
  }
});

// --- f. pre-existing floors still govern the subject channel --------------

test('f. floors preserved: a prompt sharing only ONE distinct term with the record\'s narrow text stays silent even though centrality trivially scales down', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // TERSE record has exactly one extractable own term ('quaternion'), so
    // AXIS_MIN_RECORD_TERMS scales down to 1 and centrality is trivially
    // satisfiable by that single shared word. The pre-existing AXIS_MIN_HITS
    // (>=2 distinct prompt-term hits) must still silence it on its own.
    store.create(antiPattern(TERSE_TITLE, TERSE_TRIGGER));
    const transcript = writeTranscript(dir, [
      assistantLine([taskBlock('Refactor the quaternion interpolation code in the physics module.')]),
    ]);
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      '',
      'only one distinct shared term — AXIS_MIN_HITS must silence this regardless of the centrality floor'
    );
  } finally {
    cleanup();
  }
});

// --- g. (requirement 2, second half) neither channel matches --------------

test('g. no path candidates AND no subject match in the prompt: stays silent under the composed hook, exit 0', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER));
    const transcript = writeTranscript(dir, [
      assistantLine([taskBlock('Please investigate the login flow and report back.')]),
    ]);
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '', 'neither channel matches — composed hook must still go silent, never a throw/crash');
  } finally {
    cleanup();
  }
});
