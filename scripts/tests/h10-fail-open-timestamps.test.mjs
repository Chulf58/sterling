// H10 SPEC-ONLY tests pinning the FAIL-CLOSED direction for timestamp handling
// in scripts/hooks/h10-direct-capture.mjs — fixes for a fail-open class of bugs
// being implemented IN PARALLEL with this file. NOT read here (test-writer does
// not read in-flight implementation changes, by design): the hook's own
// existing comment already states the intended contract —
//
//   "A missing/malformed `at` is treated as arriving AFTER the cutoff — the
//   safe direction, since it keeps the duty armed rather than silently
//   clearing it."
//
// H10 raises DUTIES at Stop (research capture, capture-from-debug, concept
// article). A duty wrongly DISCHARGED is durable knowledge silently lost —
// that is the severe direction. Every spec below pins: when a timestamp used
// to decide "has this been covered / satisfied?" cannot be trusted (absent,
// or present but unparseable), the duty must stay ARMED, never be silently
// cleared. SPEC G pins the mirror-image regression: the good paths (valid,
// well-ordered timestamps) must still discharge/satisfy exactly as before —
// a fail-closed OVER-correction (nagging on valid input) is its own bug.
//
// This is a NEW SIBLING file — scripts/tests/h10-research-no-capture-and-
// concept-prewrite.test.mjs stays frozen and unedited. Per that file's own
// precedent (itself following scripts/tests/h10-delegation-watch.test.mjs /
// scripts/tests/h10-touch-noise.test.mjs), this file duplicates the minimal
// harness/fixture helpers (runHook, makeProject, hookInput, envelope, the
// session-events register writer, rEvent/ncEvent/cEvent/conceptArticle)
// rather than importing another test file as a module (test files register
// their `test()` calls at import time — importing one as a module would
// double-run its suite). The debug_scope fixture (dEvent) is likewise
// reused verbatim in shape from scripts/tests/hooks-full.test.mjs's existing
// H10 capture-duty section.
//
// EXECUTION DISCLOSURE: the test-writer role holds no Bash by design (H4) —
// these tests were never run. Every test below states, in its own assertion
// message and in this header's per-spec notes, the exact failure shape a
// still-fail-open implementation would produce, so the conductor's red-gate
// run can hold the implementation to that shape rather than to a guess.
//
// Per-spec current-status disclosure (honest, not inferred from code — the
// hook's OWN comment proves the safe-direction intent exists SOMEWHERE in the
// file already; whether it is applied uniformly across the research lane,
// the capture/debug lane, and the concept lane, and across BOTH "missing"
// and "malformed-but-truthy" `at` values, is exactly what is being fixed in
// parallel and exactly what these tests exist to pin):
//   SPEC A/B (research lane, event's own `at` missing/malformed) — may
//     already pass if the promised comment is implemented at this exact
//     comparison site; if not yet applied here, the event is silently
//     treated as "covered" by the no_capture cutoff and `nag.code` comes
//     back 0 instead of 2 — that is the fail-open shape this pins against.
//   SPEC C (no_capture's own `at` malformed) — fails open if the cutoff
//     comparison is a bare string/lexicographic compare (or a `|| ''`
//     fallback) that lets "n/a" out-sort a real ISO string, or if a NaN
//     epoch from `new Date('n/a').getTime()` is treated as +Infinity by an
//     unguarded `Math.max`; `nag.code` comes back 0 instead of 2.
//   SPEC D (capture/debug lane, mirrors A) — same fail-open shape as A/B,
//     on the sibling comparison site for debug_scope events.
//   SPEC E (concept event's own `at` malformed, "0") — fails open if the
//     session-window floor computation folds the concept event's own
//     malformed `at` in via a `|| 0` epoch fallback (dragging the floor to
//     1970 and letting a 30-day-old article satisfy it) rather than
//     excluding it / treating it as unbounded-late.
//   SPEC F (concept event's own `at` missing, real wall-clock trap) — fails
//     open if a missing `at` falls back to `Date.now()` and treats "written
//     within the last few minutes of real Stop time" as satisfying, which
//     would let ANY incidentally-recent article discharge an unrelated duty.
//   SPEC G (regression) — pins the good paths so a fail-closed
//     over-correction (nagging on valid, well-ordered input) is caught too;
//     these already pass today per the frozen sibling's SPEC1a/SPEC2c and
//     must keep passing after the parallel fix lands.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

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

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-fo-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
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

// -------- session-events register (H16 writer format; reused verbatim) --------
const H16_REGISTER = ['.sterling', 'transient', 'session-events.json'];
const eventsPath = (dir) => join(dir, ...H16_REGISTER);
function writeSessionEvents(dir, events) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(eventsPath(dir), JSON.stringify(events));
}
function seedEventsConfig(dir, research_agents = ['researcher', 'claude-code-guide']) {
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ ...CONFIG, session_events: { research_agents } }));
}

// `at` left `undefined` is dropped entirely by JSON.stringify — this is how
// these fixtures simulate a MISSING `at` key, as opposed to a malformed-but-
// present string like 'n/a' or '0'.
const rEvent = (detail, at) => ({ kind: 'research_tool', detail, at });
// `lane` is an OPTIONAL third argument (added 2026-08-22 per decision
// `no-capture-discharge-is-lane-scoped`, 51ebe0dd — see SPEC G1 below): when
// omitted the produced event is byte-identical to the pre-ruling bare shape
// (no `lane` key at all), so every existing bare call site in this file
// (SPEC A/B/C/D/E/F/H) is unaffected. Mirrors the identical minimal-change
// pattern already used in scripts/tests/h10-research-no-capture-and-concept-
// prewrite.test.mjs.
const ncEvent = (reason, at, lane) =>
  lane === undefined ? { kind: 'no_capture', detail: reason, at } : { kind: 'no_capture', detail: reason, at, lane };
const cEvent = (family, at) => ({ kind: 'concept_designed', detail: family, at });
const dEvent = (detail, at) => ({ kind: 'debug_scope', detail, at });

function conceptArticle(store, family, at) {
  return store.create({
    ...envelope('feature_article', at),
    slug: `${family}-concept`,
    title: `${family} (concept)`,
    what_it_does: `what ${family} IS + members`,
    intended_behavior: 'INTENT + INTERACTIONS',
    concept_family: family,
    files: [],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'concept article created' }],
    live_test_refs: [],
  });
}

const owed = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === reason);

// -------- file-touch register (H7 writer format; reused verbatim in shape
// from scripts/tests/h10-touch-noise.test.mjs / scripts/tests/hooks-full
// .test.mjs's touchRegister helper) --------
const TOUCH_REGISTER = ['.sterling', 'transient', 'touches.json'];
const touchesPath = (dir) => join(dir, ...TOUCH_REGISTER);
// `at` left `undefined` on an entry is dropped entirely by JSON.stringify —
// the same MISSING-key simulation as rEvent/dEvent/cEvent above, applied to
// the touch register's own `{ path, at }` shape (written by
// scripts/hooks/h7-file-touch.mjs). H10 only acts on touched paths that
// still exist on disk (existsSync filter per the sibling touch tests), so
// each entry's path is written for real — otherwise the capture duty never
// arms and the test would pass for the wrong reason.
function writeTouches(dir, entries) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const { path } of entries) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), '// touched\n');
  }
  writeFileSync(touchesPath(dir), JSON.stringify(entries.map(({ path, at }) => ({ path, at }))));
}

// ===========================================================================
// SPEC A — research event, MISSING `at`, must never be discharged by a
// no_capture cutoff.
// ===========================================================================

test('SPEC A: a research event with a MISSING `at` is never discharged by a no_capture cutoff — the research duty stays armed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    // NC_AT is deliberately very late: if a missing `at` were ever treated as
    // sorting BEFORE this cutoff (e.g. an unguarded `|| 0` epoch fallback),
    // the declaration would wrongly appear to cover it.
    const NC_AT = '2026-06-10T23:00:00.000Z';
    // Explicit `--lane research` (added 2026-08-22, decision
    // no-capture-discharge-is-lane-scoped/51ebe0dd): a BARE declaration's
    // research cutoff is `null`, and `dischargedByCutoff` short-circuits on
    // `cutoff !== null` before `isValidAt` is ever reached — so a bare
    // declaration here would make this test pass vacuously (no cutoff to
    // discharge against) rather than because the timestamp guard rejected a
    // missing `at`. The explicit lane is what keeps this test pinned to the
    // guard, not to lane-scoping's unrelated null-cutoff behavior (that
    // property is pinned separately, with well-formed timestamps, by L2 in
    // scripts/tests/h10-no-capture-lane-scope.test.mjs).
    writeSessionEvents(dir, [
      rEvent('queue backpressure threshold check', undefined),
      ncEvent('read-only investigation, nothing durable', NC_AT, 'research'),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a research event with no `at` at all was silently discharged by a later-looking no_capture cutoff instead of staying armed');
    assert.match(nag.stderr, /queue backpressure threshold check/, 'the nag cites the actual query, proving the research duty (not some other lane) is what fired');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the re-armed research duty still enqueues on release');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC B — research event, MALFORMED-but-truthy `at` ("n/a"), same guard.
// ===========================================================================

test('SPEC B: a research event with a MALFORMED-but-truthy `at` ("n/a") is never discharged by a no_capture cutoff — the research duty stays armed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const NC_AT = '2026-06-10T23:00:00.000Z';
    // Explicit `--lane research`, same reasoning as SPEC A: a bare
    // declaration's research cutoff is `null` and the `cutoff !== null`
    // short-circuit in `dischargedByCutoff` would skip `isValidAt` entirely,
    // making this pass vacuously instead of via the timestamp guard.
    writeSessionEvents(dir, [
      rEvent('genesys retry backoff cap', 'n/a'),
      ncEvent('read-only investigation, nothing durable', NC_AT, 'research'),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a research event whose `at` is a truthy-but-unparseable string ("n/a") was silently discharged instead of staying armed — a truthy check alone (without a parse-success check) is not enough');
    assert.match(nag.stderr, /genesys retry backoff cap/, 'the nag cites the actual query');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the re-armed research duty still enqueues on release');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC C — a MALFORMED no_capture `at` must NOT become the cutoff.
// ===========================================================================

test('SPEC C: a MALFORMED no_capture `at` ("n/a") must not become the cutoff — a garbage stamp must not out-sort a valid ISO timestamp and discharge the research duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
    // Explicit `--lane research`: this is the case the whole spec is named
    // for — the malformed `at` must poison the RESEARCH cutoff selection,
    // which only exists when the declaration claims the research lane. A
    // bare declaration has no research cutoff at all (`null`), so
    // `dischargedByCutoff`'s `cutoff !== null` short-circuit would make this
    // pass vacuously — the malformed stamp would never be compared against
    // anything.
    writeSessionEvents(dir, [
      rEvent('idempotency key retry window', R_EVENT_AT),
      ncEvent('malformed declaration', 'n/a', 'research'),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a no_capture declaration whose only `at` is malformed ("n/a") was treated as a valid — or worse, infinitely late — cutoff (e.g. a bare lexicographic string compare lets "n/a" out-sort any ISO date; or an unguarded `new Date(\'n/a\').getTime()` NaN is coerced to +Infinity/0 by an unguarded max/min) and wrongly discharged a real, valid research event');
    assert.match(nag.stderr, /idempotency key retry window/, 'the research duty still fires, citing the real query');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the re-armed research duty still enqueues on release');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC D — the same missing-`at` protection on the CAPTURE lane's debug_scope
// events.
// ===========================================================================

test('SPEC D: a debug_scope event with a MISSING `at` is never discharged by a no_capture cutoff — the capture duty stays armed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const NC_AT = '2026-06-10T23:00:00.000Z';
    writeSessionEvents(dir, [
      dEvent('src/probe.mjs', undefined),
      ncEvent('read-only investigation, nothing durable', NC_AT),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a debug_scope event with no `at` at all was silently discharged by a later-looking no_capture cutoff instead of staying armed — the same defect class as SPEC A, on the capture lane\'s comparison site');
    assert.match(nag.stderr, /disconfirmed_hypothesis/, 'the capture-duty nag fires (names the debug capture types), proving the capture lane — not silence — is what triggered');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'capture_owed').length, 1, 'the re-armed capture duty still enqueues on release');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC E — concept_designed event, MALFORMED `at` ("0"), must not make a
// stale article satisfy the duty.
// ===========================================================================

test('SPEC E: a concept_designed event with a MALFORMED `at` ("0") must not make a 30-day-stale family article satisfy the duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const STALE_ARTICLE_AT = '2026-05-11T12:00:00.000Z'; // ~30 days before this session's NOW
    writeSessionEvents(dir, [cEvent('gadgets', '0')]); // malformed — the event's OWN `at`
    conceptArticle(store, 'gadgets', STALE_ARTICLE_AT);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a malformed concept_designed `at` ("0") collapsed the session-window floor down to (or below) a 30-day-old article — e.g. via an unguarded `|| 0` epoch fallback treating "0" as epoch zero — wrongly satisfying the duty for ANY pre-existing article regardless of how stale');
    assert.match(nag.stderr, /gadgets/, 'the nag names the unmet family verbatim');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'concept_article_missing').filter((t) => t.text.includes("'gadgets'")).length, 1, 'the owed item still lands');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC F — concept_designed event, MISSING `at`, must not be satisfied by an
// article that merely happens to be recent in REAL wall-clock time.
// ===========================================================================

test('SPEC F: a concept_designed event with a MISSING `at` must not be satisfied by an article written shortly before the real Stop invocation, for an unrelated reason', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    // Deliberately REAL wall-clock (not the fixture's fictional 2026-06-10
    // NOW) — this is the exact trap a `Date.now()` fallback for a missing
    // `at` would fall into: an article touched minutes ago for a completely
    // unrelated reason would look "recent enough" relative to "now".
    const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeSessionEvents(dir, [cEvent('sensors', undefined)]);
    conceptArticle(store, 'sensors', FIVE_MIN_AGO);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a missing concept_designed `at` fell back to treating real "now" (actual Stop invocation time) as the window floor, so an article that happens to be a few real-world minutes old satisfied a duty it has nothing to do with');
    assert.match(nag.stderr, /sensors/, 'the nag names the unmet family verbatim');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'concept_article_missing').filter((t) => t.text.includes("'sensors'")).length, 1, 'the owed item still lands');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC G (regression) — the good paths must still work: fail-closed must not
// become an OVER-correction that nags on valid, well-ordered input.
// ===========================================================================

// REVISED 2026-08-22 per decision `no-capture-discharge-is-lane-scoped`
// (51ebe0dd, user-ruled the same day) — this reverses the premise SPEC G1
// was originally written on. It used to declare a BARE no_capture and
// assert the research duty was discharged by it; under the ruling a bare
// declaration covers the CAPTURE lane ONLY, and discharging the RESEARCH
// duty now requires an explicit `--lane research` (or `--lane all`) claim.
// The test is failing (fires 2, expects 0) because the SPEC changed under
// it by a later user ruling, not because code regressed — same disposition
// class as scripts/tests/h10-research-no-capture-and-concept-prewrite
// .test.mjs's SPEC1a. Rewritten below to declare `--lane research` so the
// test's real intent survives unchanged: a declaration whose SCOPE covers
// the earlier research event still discharges it, and — this file's own
// point — still does so through the fail-closed timestamp guard (a valid,
// well-ordered timestamp must not be over-corrected into a nag).
test('SPEC G1 (regression, revised per decision 51ebe0dd, no-capture-discharge-is-lane-scoped): an explicit `--lane research` no_capture declaration AT/AFTER a valid research event still discharges the research duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
    const NC_AT = '2026-06-10T11:30:00.000Z'; // after the research event — covers it
    writeSessionEvents(dir, [
      rEvent('genesys webhook signature validation', R_EVENT_AT),
      ncEvent('read-only investigation, nothing durable', NC_AT, 'research'),
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'OVER-CORRECTION SHAPE if this fires as 2: a well-formed, covering no_capture declaration stopped discharging the research duty once the fail-closed guards were added');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed — the duty was discharged, not deferred');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared on the discharged terminal path');
  } finally {
    cleanup();
  }
});

test('SPEC G2 (regression): a family concept article created AFTER a valid concept_designed event still satisfies the duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z';
    const ARTICLE_AT = '2026-06-10T13:00:00.000Z'; // after the event — the existing register-then-write path
    writeSessionEvents(dir, [cEvent('turrets', CONCEPT_AT)]);
    conceptArticle(store, 'turrets', ARTICLE_AT);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'OVER-CORRECTION SHAPE if this fires as 2: a valid article written after a valid concept_designed event stopped satisfying the duty once the fail-closed guards were added');
    assert.equal(owed(store, 'concept_article_missing').length, 0, 'nothing owed when satisfied');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared on the satisfied path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC H — the same missing-`at` protection on the TOUCHES lane: a file-touch
// register entry (scripts/hooks/h7-file-touch.mjs writes `{ path, at }` into
// .sterling/transient/touches.json) with a MISSING `at` must never be
// discharged by a no_capture cutoff.
// ===========================================================================

test('SPEC H: a file-touch register entry with a MISSING `at` is never discharged by a no_capture cutoff — the capture duty stays armed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    // NC_AT is deliberately very late, mirroring SPEC A/D: if a missing `at`
    // were ever treated as sorting BEFORE this cutoff (e.g. an unguarded
    // `|| 0` epoch fallback), the declaration would wrongly appear to cover
    // the touch.
    const NC_AT = '2026-06-10T23:00:00.000Z';
    writeTouches(dir, [{ path: 'src/real-touch.mjs', at: undefined }]);
    writeSessionEvents(dir, [ncEvent('read-only investigation, nothing durable', NC_AT)]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a file-touch register entry with no `at` at all was silently discharged by a later-looking no_capture cutoff instead of staying armed — the same defect class as SPEC A/D, on the touches lane\'s comparison site');
    assert.match(nag.stderr, /nothing was captured/, 'the standard capture-duty nag fires, proving the touches lane — not silence — is what triggered');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'capture_owed').length, 1, 'the re-armed capture duty still enqueues on release');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC I/J/K — the LOW-SORTING mirror of A/B/D/H, added after a mutation test
// (the conductor swapped isValidAt for `(a) => true` and reran this file)
// showed SPEC A, B, D, F and H still passed with the guard fully disabled.
// Those five pass on the strength of the LEXICAL COMPARISON alone: their
// malformed `at` values (`undefined`, "n/a") happen to out-sort any real ISO
// cutoff string ("n" > "2" in "n/a" vs "2026-...", and `undefined` is dropped
// by JSON.stringify entirely, which the comparison site also treats as
// sorting late) — so `event_at <= cutoff` is false REGARDLESS of whether
// isValidAt does anything at all. isValidAt is therefore UNPINNED on the
// event side by this file's original suite: SPEC C and E are the only two
// that actually depend on it (C on the no_capture cutoff's own `at`, E on the
// concept event's own `at`), and both use "n/a"/"0" specifically because
// their comparison site treats "the cutoff itself is garbage" as the
// dangerous direction, not "the event sorts late".
//
// A malformed `at` that sorts BELOW the cutoff — "0" is used here — inverts
// that: "0" <= "2026-06-10T23:00:00.000Z" is TRUE by plain string comparison
// (the character '0' precedes '2' in ASCII), so a lexical-only implementation
// would treat the event as having happened before the cutoff and DISCHARGE
// the duty — the exact fail-open outcome this whole file exists to prevent.
// Only isValidAt actually rejecting "0" (it fails the canonical-ISO shape
// test) keeps the duty armed. These three tests are what actually pin
// isValidAt on the event-side comparison for the research, debug and touch
// lanes; do not delete them as "redundant" with A/B/D/H — the two shapes
// (high-sorting and low-sorting malformed values) exercise different halves
// of the same comparison and only the low-sorting half depends on the guard.
// ===========================================================================

test("SPEC I (research lane): a malformed `at` that sorts BELOW the cutoff ('0') is never discharged — the guard, not the comparison, is what rejects it", () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const NC_AT = '2026-06-10T23:00:00.000Z';
    // High-sorting sibling: SPEC B ("n/a"). "n/a" > NC_AT lexically, so SPEC B
    // passes even with the guard weakened to accept anything. "0" < NC_AT
    // lexically, so a lexical-only comparison would discharge this event —
    // only isValidAt rejecting "0" keeps the research duty armed. Explicit
    // `--lane research`, same reasoning as SPEC A/B/C: a bare declaration's
    // research cutoff is `null` and the `cutoff !== null` short-circuit in
    // `dischargedByCutoff` would skip isValidAt entirely, making this pass
    // vacuously instead of via the timestamp guard.
    writeSessionEvents(dir, [
      rEvent('cache eviction policy check', '0'),
      ncEvent('read-only investigation, nothing durable', NC_AT, 'research'),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a research event whose `at` is the low-sorting malformed value "0" was silently discharged because "0" <= the cutoff lexically — the guard, not the comparison, must be what rejects it');
    assert.match(nag.stderr, /cache eviction policy check/, 'the nag cites the actual query, proving the research duty (not some other lane) is what fired');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the re-armed research duty still enqueues on release');
  } finally {
    cleanup();
  }
});

test("SPEC J (capture/debug lane): a malformed `at` that sorts BELOW the cutoff ('0') is never discharged — the guard, not the comparison, is what rejects it", () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const NC_AT = '2026-06-10T23:00:00.000Z';
    // High-sorting sibling: SPEC D (`undefined`, dropped by JSON.stringify),
    // which passes even with the guard weakened to accept anything because a
    // missing `at` sorts late at this comparison site. "0" < NC_AT lexically,
    // so a lexical-only comparison would discharge this event — only
    // isValidAt rejecting "0" keeps the capture duty armed here. Bare
    // (capture-lane) declaration, mirroring SPEC D.
    writeSessionEvents(dir, [
      dEvent('src/probe2.mjs', '0'),
      ncEvent('read-only investigation, nothing durable', NC_AT),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a debug_scope event whose `at` is the low-sorting malformed value "0" was silently discharged because "0" <= the cutoff lexically — the guard, not the comparison, must be what rejects it, the same defect class as SPEC I on the capture lane\'s comparison site');
    assert.match(nag.stderr, /disconfirmed_hypothesis/, 'the capture-duty nag fires (names the debug capture types), proving the capture lane — not silence — is what triggered');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'capture_owed').length, 1, 'the re-armed capture duty still enqueues on release');
  } finally {
    cleanup();
  }
});

test("SPEC K (touch lane): a malformed `at` that sorts BELOW the cutoff ('0') is never discharged — the guard, not the comparison, is what rejects it", () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const NC_AT = '2026-06-10T23:00:00.000Z';
    // High-sorting sibling: SPEC H (`undefined`, dropped by JSON.stringify),
    // which passes even with the guard weakened to accept anything because a
    // missing `at` sorts late at this comparison site. "0" < NC_AT lexically,
    // so a lexical-only comparison would discharge this entry — only
    // isValidAt rejecting "0" keeps the capture duty armed here. Bare
    // (capture-lane) declaration, mirroring SPEC H. The touched path is
    // written for real to disk by writeTouches (a distinct path from SPEC
    // H's, to keep the two fixtures visibly independent) — H10 only acts on
    // touches whose path still `existsSync`, per the sibling touch tests, so
    // an entry pointing at a path that was never created would never arm the
    // capture duty in the first place and this test would pass for the wrong
    // reason.
    writeTouches(dir, [{ path: 'src/real-touch2.mjs', at: '0' }]);
    writeSessionEvents(dir, [ncEvent('read-only investigation, nothing durable', NC_AT)]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a file-touch register entry whose `at` is the low-sorting malformed value "0" was silently discharged because "0" <= the cutoff lexically — the guard, not the comparison, must be what rejects it, the same defect class as SPEC I/J on the touches lane\'s comparison site');
    assert.match(nag.stderr, /nothing was captured/, 'the standard capture-duty nag fires, proving the touches lane — not silence — is what triggered');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'capture_owed').length, 1, 'the re-armed capture duty still enqueues on release');
  } finally {
    cleanup();
  }
});
