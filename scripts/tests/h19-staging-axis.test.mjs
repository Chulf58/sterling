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
//
// REPAIR NOTE (this dispatch): arms b, e, f and g originally asserted
// `stdout === ''` for their negative cases. Since commit 593787f
// (2026-08-31) h19-dispatch-staging.mjs ALWAYS emits the STERLING DEFAULT
// RETURN CONTRACT envelope for a non-exempt agent_type (the absorbed H28),
// so an empty-stdout assertion is stale and would fail for a reason
// unrelated to what each arm is actually pinning. Each of the four arms now
// asserts the envelope is present AND that no delivery/pointer content
// beyond it is emitted — the original NEGATIVE intent (no subject-matched
// payload) is unchanged, only the "silent" shape it was expressed through.
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

// --- dispatch fixture helpers ---------------------------------------------
//
// STATE-MACHINE RE-CUT (board 5445066b, decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution`,
// knowledge_get 7c515e52 — opened, not paraphrased): H19 no longer recovers
// the dispatch prompt from the PARENT TRANSCRIPT (3.4-5.5 s of lag, 4 of 6
// spawns saw an older unrelated block — finding 51506eec). A dispatch is now
// declared by firing its real PreToolUse Task event through
// h22-dispatch-register.mjs, the registered owner of that seam (§7(d)), and
// SubagentStart's transcript_path points at a file that does NOT exist.
//
// This matters for the NEGATIVE arms too, not just the delivering ones: with
// no state record at all, b/e/f/g would pass VACUOUSLY (nothing is staged, so
// every doesNotMatch trivially holds) — a hollow pass that reads exactly like
// a real one. Staging a real Pre in every arm is what keeps those pins
// load-bearing.

const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');

function noTranscript(dir) {
  return join(dir, 'no-such-parent-transcript.jsonl');
}

/** Fire a real PreToolUse Task event; `subagent_type` MUST match the Start's
 *  agent_type (§5(iii) derivation is exact by construction over the type). */
function stageDispatch(dir, prompt, { subagent_type = 'general-purpose', tool_use_id = `toolu_ax_${randomUUID().slice(0, 8)}` } = {}) {
  const r = spawnSync(process.execPath, [H22_PATH], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id,
      tool_input: { subagent_type, prompt, description: 'a lane' },
      session_id: 's1',
      cwd: dir,
      transcript_path: noTranscript(dir),
      prompt_id: 'p1',
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
  assert.notEqual(r.status, 2, `PreToolUse must never deny a dispatch: ${r.stderr ?? ''}`);
  return noTranscript(dir);
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
    const transcript = stageDispatch(dir, CENTRAL_PROMPT);
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

// REPAIRED (this dispatch): since commit 593787f (2026-08-31) H19 always
// emits the STERLING DEFAULT RETURN CONTRACT envelope for a non-exempt
// agent_type (the absorbed H28), so `stdout === ''` is stale — it is now
// contract-only, never empty. The arm's original negative intent (no
// subject-matched delivery on a peripheral-only overlap) is preserved via
// the doesNotMatch assertions below.
test('b. no path, prompt hits only the record\'s PERIPHERAL (non-central) words: contract-only, no subject-matched payload', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER));
    const transcript = stageDispatch(dir, PERIPHERAL_PROMPT);
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'the absorbed H28 contract always fires for a non-exempt agent_type, even with nothing to stage');
    assert.doesNotMatch(ctx, new RegExp(CENTRAL_TITLE), 'peripheral-only overlap must not count as a subject match, mirroring the 2026-08-09 Blender case');
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'no knowledge-staging payload when nothing was staged');
  } finally {
    cleanup();
  }
});
// SABOTAGE: widen the centrality/hit floor so a peripheral-only overlap
// counts as a subject match — the CENTRAL_TITLE match then appears in ctx
// and the `doesNotMatch(ctx, new RegExp(CENTRAL_TITLE))` assertion goes red.
// (A cruder sabotage — dropping the unconditional contract emit — fails the
// `STERLING DEFAULT RETURN CONTRACT` match instead, which is exactly the
// stale property this repair stops asserting via an empty-stdout check.)

// --- c. composition: one payload, both channels present -------------------

test('c. prompt names a governed file AND subject-matches a different anti_pattern: ONE stdout JSON carries both blocks', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER)); // no file_keys — subject-channel only
    const transcript = stageDispatch(dir, `Go read src/a.mjs and fix the bug there. Separately: ${CENTRAL_PROMPT}`);
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
    const transcript = stageDispatch(dir, `Go read src/a.mjs. ${CENTRAL_PROMPT}`);
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

// REPAIRED (this dispatch): the second call is contract-only, not empty —
// the absorbed H28 contract carries no staging guard (decision 04982f45),
// so it fires again on the repeat call even while the KNOWLEDGE DELIVERY
// payload stays guarded. The arm's original negative intent (no re-delivery
// of the subject-matched record) is preserved via the doesNotMatch
// assertions below.
test('e. a second identical SubagentStart after a subject-only delivery is contract-only (guard dedup on staging, not on the contract)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER));
    const transcript = stageDispatch(dir, CENTRAL_PROMPT);
    const first = runHook(subagentStart(dir, transcript), dir);
    assert.equal(first.code, 0, first.stderr);
    assert.notEqual(first.stdout, '', 'sanity: the first run must actually deliver something to guard against');

    const second = runHook(subagentStart(dir, transcript), dir);
    assert.equal(second.code, 0, second.stderr);
    const secondCtx = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    assert.match(secondCtx, /STERLING DEFAULT RETURN CONTRACT/, 'the absorbed contract still fires on the second call — it is not gated by the staging guard');
    assert.doesNotMatch(secondCtx, /STERLING KNOWLEDGE DELIVERY/, 'nothing fresh to stage — the guard already marked this record for this agent');
    assert.doesNotMatch(secondCtx, new RegExp(CENTRAL_TITLE), 'the subject-matched record is not re-delivered');
  } finally {
    cleanup();
  }
});
// SABOTAGE: reuse the STAGING guard to also suppress the contract on repeat
// calls (or otherwise gate the contract emit behind "something fresh was
// staged") — the `STERLING DEFAULT RETURN CONTRACT` match on secondCtx goes
// red. A second, opposite sabotage — dropping the staging guard so the
// record is re-delivered every call — fails the CENTRAL_TITLE
// doesNotMatch assertion instead.

// --- f. pre-existing floors still govern the subject channel --------------

// REPAIRED (this dispatch): the composed hook is always contract-only for a
// non-exempt agent_type, so `stdout === ''` is stale here too. The arm's
// original negative intent (AXIS_MIN_HITS silences a single-shared-term
// overlap regardless of the scaled-down centrality floor) is preserved via
// the doesNotMatch assertions below.
test('f. floors preserved: a prompt sharing only ONE distinct term with the record\'s narrow text is contract-only, no subject-matched payload', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // TERSE record has exactly one extractable own term ('quaternion'), so
    // AXIS_MIN_RECORD_TERMS scales down to 1 and centrality is trivially
    // satisfiable by that single shared word. The pre-existing AXIS_MIN_HITS
    // (>=2 distinct prompt-term hits) must still silence it on its own.
    store.create(antiPattern(TERSE_TITLE, TERSE_TRIGGER));
    const transcript = stageDispatch(dir, 'Refactor the quaternion interpolation code in the physics module.');
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'the absorbed contract always fires for a non-exempt agent_type');
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'only one distinct shared term — AXIS_MIN_HITS must silence this regardless of the centrality floor');
    assert.doesNotMatch(ctx, new RegExp(TERSE_TITLE), 'the record must not be delivered on a single shared term');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop or relax the pre-existing AXIS_MIN_HITS (>=2 distinct hits)
// floor so a single shared term becomes sufficient — the STERLING KNOWLEDGE
// DELIVERY / TERSE_TITLE doesNotMatch assertions above go red.

// --- g. (requirement 2, second half) neither channel matches --------------

// REPAIRED (this dispatch): "stays silent" is stale — the composed hook is
// always contract-only for a non-exempt agent_type. The arm's original
// negative intent (neither channel delivers anything, never a throw/crash)
// is preserved via the doesNotMatch assertions below.
test('g. no path candidates AND no subject match in the prompt: contract-only under the composed hook, exit 0', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('alpha', ['src/a.mjs']));
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER));
    const transcript = stageDispatch(dir, 'Please investigate the login flow and report back.');
    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'neither channel matches, but the absorbed contract still fires — never a throw/crash, never empty');
    assert.doesNotMatch(ctx, /STERLING KNOWLEDGE DELIVERY/, 'no knowledge-staging payload when neither channel matches');
    assert.doesNotMatch(ctx, /alpha does the alpha thing/, 'the unmatched article is not delivered');
    assert.doesNotMatch(ctx, new RegExp(CENTRAL_TITLE), 'the unmatched anti_pattern is not delivered');
  } finally {
    cleanup();
  }
});
// SABOTAGE: let a non-matching prompt fall through to delivering EITHER
// fixture record anyway (e.g. a path/subject matcher that defaults to "match"
// on no signal instead of "no match") — one of the two content
// doesNotMatch assertions above goes red. A cruder sabotage — dropping the
// unconditional contract emit — fails the STERLING DEFAULT RETURN CONTRACT
// match instead.

// --- h. RE-CUT: ONE PROMPT PER START, so a long sibling prompt is not even
//        visible to this Start (was: per-prompt matching inside a union;
//        review finding 5, commit follows 45bb722) -------------------------
//
// RE-CUT BY DECISION 7c515e52 (board 5445066b). The original arm pinned that
// subject matching ran PER PROMPT *within a union of the dispatching message's
// prompts* — the union was the thing that could dilute a short prompt, and
// per-prompt matching was the fix. The UNION SEMANTICS ARE DELETED: a Start
// resolves exactly ONE prompt (its own) from its own state record, so a
// sibling's prompt is not merely matched separately, it is NEVER READ. The
// property under test is preserved and strengthened — a long, term-dominating
// sibling cannot silence this spawn's match — while the mechanism that made
// dilution possible no longer exists.
//
// Also re-cut: the old `/dispatched in this turn/` assertion pinned the
// header's parallel-dispatch HEDGE. §3 of the decision removes it verbatim:
// "a single prompt, so the subject label is 'your task's SUBJECT' — the
// 'possibly a sibling' wording is gone". So the hedge must now be ABSENT.
// DISCLOSED, NOT GUESSED: §3 names the label but no exact rendered sentence,
// so this pin asserts only the ABSENCE of the hedge (which the ruling states
// directly) — the positive wording stays unpinned here rather than invented,
// and is owned by the porch/header pins in
// scripts/tests/h19-dispatch-porch.test.mjs.
test('h. parallel dispatch: a Start sees only ITS OWN prompt, so a long sibling prompt cannot dilute a short matching one to silence', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(antiPattern(CENTRAL_TITLE, CENTRAL_TRIGGER));
    // Sibling prompt: 20 distinct unrelated words repeated 3x each — under the
    // DELETED union match these dominated the top-16 extracted terms and
    // evicted boolean/mesh/modifier entirely, silencing the short prompt.
    const sibWords = [
      'ledger', 'warehouse', 'invoice', 'shipment', 'customs', 'freight', 'container', 'harbor',
      'manifest', 'pallet', 'carrier', 'tariff', 'voyage', 'dockyard', 'consignment', 'logistics',
      'clearance', 'transit', 'billing', 'quotation',
    ];
    const sibling = Array.from({ length: 3 }, () => sibWords.join(' ')).join(' ');
    const short = 'Investigate why the boolean operation corrupts the mesh: the modifier stack introduces non-manifold geometry.';
    // Two dispatches in flight, DIFFERENT types, so each Start's slot is
    // type-unique (§5(iii)); this Start is the short-prompt agent.
    stageDispatch(dir, sibling, { subagent_type: 'explorer', tool_use_id: 'toolu_ax_sibling' });
    const transcript = stageDispatch(dir, short, { subagent_type: 'general-purpose', tool_use_id: 'toolu_ax_short' });

    const r = runHook(subagentStart(dir, transcript), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(r.stdout, '', 'the short prompt matches on its own — this Start must deliver');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(CENTRAL_TITLE), 'the subject-matched record reaches the spawned agent');
    for (const w of ['ledger', 'warehouse', 'freight', 'quotation']) {
      assert.doesNotMatch(ctx, new RegExp(w, 'i'), `the sibling dispatch's vocabulary ('${w}') never reaches this spawn — its prompt is not this spawn's prompt`);
    }
    assert.doesNotMatch(
      ctx,
      /dispatched in this turn/,
      "§3: with exactly one resolved prompt the 'possibly a sibling' hedge is gone — a hedge here would tell the agent its own staged subject might not be its own"
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: union every pending record's prompt before extracting axis terms
// (the deleted behaviour) — the sibling's 60 dominating terms evict
// boolean/mesh/modifier and the CENTRAL_TITLE match goes red, while the
// sibling-vocabulary doesNotMatch arms go red too if the union is also staged.
// SABOTAGE: keep the parallel-dispatch hedge in the header builder — the last
// assertion goes red on its own, which is why it is separate from the content
// arms.
