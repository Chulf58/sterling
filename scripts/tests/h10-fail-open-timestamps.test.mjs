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
const ncEvent = (reason, at) => ({ kind: 'no_capture', detail: reason, at });
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
    writeSessionEvents(dir, [
      rEvent('queue backpressure threshold check', undefined),
      ncEvent('read-only investigation, nothing durable', NC_AT),
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
    writeSessionEvents(dir, [
      rEvent('genesys retry backoff cap', 'n/a'),
      ncEvent('read-only investigation, nothing durable', NC_AT),
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
    writeSessionEvents(dir, [
      rEvent('idempotency key retry window', R_EVENT_AT),
      ncEvent('malformed declaration', 'n/a'),
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

test('SPEC G1 (regression): a valid no_capture declaration AT/AFTER a valid research event still discharges the research duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
    const NC_AT = '2026-06-10T11:30:00.000Z'; // after the research event — covers it
    writeSessionEvents(dir, [
      rEvent('genesys webhook signature validation', R_EVENT_AT),
      ncEvent('read-only investigation, nothing durable', NC_AT),
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
