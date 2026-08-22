// H10 SPEC-ONLY tests pinning the LANE-SCOPED no_capture ruling — decision
// `no-capture-discharge-is-lane-scoped` (knowledge_get
// 51ebe0dd-099e-40a9-abc5-d3c8cc767883). NOT YET IMPLEMENTED: this is a NEW
// sibling file (scripts/tests/h10-fail-open-timestamps.test.mjs and
// scripts/tests/h10-research-no-capture-and-concept-prewrite.test.mjs stay
// frozen and unedited, per their own established precedent of duplicating
// harness/fixture helpers rather than importing one test file as a module —
// importing would double-run its registered `test()` calls).
//
// THE RULING (verbatim substance, from the decision statement): the
// no_capture declaration takes an explicit --lane scope (research|capture|
// all). A BARE declaration covers ONLY the CAPTURE lane, exactly as it did
// before 2026-08-22; discharging the RESEARCH duty requires an explicit
// lane claim. The appended session event carries the declared lane, and
// H10 consults it per lane: activeDebugEvents/activeTouches honour a
// capture-or-all declaration, activeResearchEvents honour a research-or-all
// one. Reason (P5, fail loud never silent / P2, the KB is the product): a
// single global cutoff turns a locally-true declaration ("typo fix, nothing
// durable") into a globally-false one that silently clears an unrelated
// earlier research duty — silent knowledge loss, the severe direction.
//
// SUPERSEDED-IMPLEMENTATION NOTE (important for the conductor, not edited
// here): the decision's own rationale states the FIRST fix for the
// underlying defect (item 353416a9) made the research lane consult the
// SAME global no_capture cutoff as the capture lane — i.e. today's code
// (commit 213d015) already discharges research on ANY no_capture
// declaration at/after the research event, regardless of any lane content,
// because no lane concept exists yet. That is exactly what
// scripts/tests/h10-research-no-capture-and-concept-prewrite.test.mjs's
// SPEC1a pins as a PASSING case today (a bare-shaped no_capture at/after a
// research event discharges it). Once lane-scoping lands, SPEC1a's
// declaration (no lane field) must, per this ruling, STOP discharging
// research — SPEC1a will flip from green to red. This is a real
// implementation-shape conflict between a frozen sibling and this ruling.
// It is disclosed here, not resolved: this test-writer does not edit frozen
// siblings; SPEC1a's disposition (retire/rewrite once lane-scoping ships)
// is the conductor's call, cited by the decision id above.
//
// ASSUMED SURFACE (disclosed, not invented): the session event's lane
// field name is inferred from the decision's own prose ("the event...
// carries the declared lane") as `lane` — packages/schemas/src/transient.ts
// (sessionEventSchema) is not visible in this brief's interface slice. If
// the implementer picks a different field name, L3/L4/L5/L6/L7a/L7b/L10
// (which write a `lane` key directly into the session-events register via
// the `ncEvent` fixture below) need updating to match; L1/L2/L8/L9 do not
// depend on the field name — they test the bare/legacy/CLI-refusal paths.
//
// EXECUTION DISCLOSURE: the test-writer role holds no Bash by design (H4)
// — none of these tests were run. Each test's assertion message states the
// exact failure shape a not-yet-implemented (or partially-implemented)
// hook would produce.

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-lane-'));
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

const rEvent = (detail, at) => ({ kind: 'research_tool', detail, at });
const dEvent = (detail, at) => ({ kind: 'debug_scope', detail, at });
// `lane` omitted entirely (undefined, third arg not passed) reproduces BOTH
// the "bare declaration" shape AND the "legacy pre-ruling event" shape —
// they are the identical JSON object (no `lane` key at all), which is
// exactly the point of L8: a legacy write and a fresh bare declaration must
// be read identically (capture-lane only).
const ncEvent = (reason, at, lane) =>
  lane === undefined ? { kind: 'no_capture', detail: reason, at } : { kind: 'no_capture', detail: reason, at, lane };

// -------- file-touch register (H7 writer format; reused verbatim in shape) --------
const TOUCH_REGISTER = ['.sterling', 'transient', 'touches.json'];
const touchesPath = (dir) => join(dir, ...TOUCH_REGISTER);
function writeTouches(dir, entries) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const { path } of entries) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), '// touched\n');
  }
  writeFileSync(touchesPath(dir), JSON.stringify(entries));
}

const owed = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === reason);

// ===========================================================================
// L1 — bare no_capture discharges CAPTURE (touches + debug_scope), unchanged
// ===========================================================================

test('L1: a BARE no_capture (no lane) discharges the CAPTURE duty for earlier touches AND debug_scope events, exactly its pre-2026-08-22 behavior', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const TOUCH_AT = '2026-06-10T10:00:00.000Z';
    const DEBUG_AT = '2026-06-10T10:15:00.000Z';
    const NC_AT = '2026-06-10T11:00:00.000Z'; // after both — covers them
    writeTouches(dir, [{ path: 'src/l1-touch.mjs', at: TOUCH_AT }]);
    writeSessionEvents(dir, [
      dEvent('src/l1-touch.mjs', DEBUG_AT),
      ncEvent('typo fix, nothing durable', NC_AT), // bare
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'REGRESSION SHAPE if this fires as 2: a bare no_capture stopped discharging the capture duty it always covered pre-ruling — lane-scoping must narrow the RESEARCH lane, never the capture lane\'s own default coverage');
    assert.equal(owed(store, 'capture_owed').length, 0, 'nothing owed on the capture lane — bare still fully discharges it');
    assert.equal(existsSync(eventsPath(dir)), false, 'register cleared on the discharged terminal path, matching pre-ruling behavior');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L2 — bare no_capture does NOT discharge research (the defect being closed)
// ===========================================================================

test('L2: a BARE no_capture does NOT discharge the research duty — a research event earlier than the declaration still leaves the research duty demanded', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
    const NC_AT = '2026-06-10T11:30:00.000Z'; // after the research event — covered it under the SUPERSEDED global-cutoff fix
    writeSessionEvents(dir, [
      rEvent('cache eviction policy threshold', R_EVENT_AT),
      ncEvent('typo fix, nothing durable', NC_AT), // bare — capture lane only
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN (pre-ruling / superseded-fix) SHAPE if this fires as 0: a bare no_capture declaration silently discharged the research duty — exactly the defect closed by decision no-capture-discharge-is-lane-scoped (51ebe0dd)');
    assert.match(nag.stderr, /cache eviction policy threshold/, 'the research nag cites the actual query, proving the research duty — not silence — is what fired');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the un-discharged research duty still enqueues on release');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L3 — `--lane research` discharges research
// ===========================================================================

test('L3: `--lane research` discharges the research duty for earlier research events', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
    const NC_AT = '2026-06-10T11:30:00.000Z';
    writeSessionEvents(dir, [
      rEvent('rate limiter token bucket sizing', R_EVENT_AT),
      ncEvent('research dead-ended, nothing new confirmed', NC_AT, 'research'),
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'NOT-YET-WIRED SHAPE if this fires as 2: an explicit `--lane research` declaration at/after the research event failed to discharge it');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed — discharged, not deferred');
    assert.equal(existsSync(eventsPath(dir)), false, 'register cleared on the discharged terminal path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L4 — `--lane research` does NOT discharge capture
// ===========================================================================

test('L4: `--lane research` does NOT discharge the capture duty — earlier touches still demand capture', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const TOUCH_AT = '2026-06-10T10:00:00.000Z';
    const NC_AT = '2026-06-10T11:00:00.000Z';
    writeTouches(dir, [{ path: 'src/l4-touch.mjs', at: TOUCH_AT }]);
    writeSessionEvents(dir, [ncEvent('research dead-ended, nothing new confirmed', NC_AT, 'research')]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'OVER-BROAD-DISCHARGE SHAPE if this fires as 0: a `--lane research` declaration wrongly discharged the CAPTURE duty too — lane scoping must be narrow, not just additive');
    assert.match(nag.stderr, /nothing was captured/, 'the standard capture-duty nag fires, proving the capture lane — not silence — is what triggered');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'capture_owed').length, 1, 'the un-discharged capture duty still enqueues on release');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L5 — `--lane all` discharges BOTH
// ===========================================================================

test('L5: `--lane all` discharges BOTH the research and capture duties for earlier work', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T10:00:00.000Z';
    const TOUCH_AT = '2026-06-10T10:15:00.000Z';
    const NC_AT = '2026-06-10T11:00:00.000Z';
    writeTouches(dir, [{ path: 'src/l5-touch.mjs', at: TOUCH_AT }]);
    writeSessionEvents(dir, [
      rEvent('session affinity cookie ttl', R_EVENT_AT),
      ncEvent('read-only investigation across the board, nothing durable', NC_AT, 'all'),
    ]);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'NOT-YET-WIRED SHAPE if this fires as 2: `--lane all` failed to cover one of the two lanes');
    assert.equal(owed(store, 'research_owed').length, 0, 'research duty discharged');
    assert.equal(owed(store, 'capture_owed').length, 0, 'capture duty discharged');
    assert.equal(existsSync(eventsPath(dir)), false, 'register cleared on the fully-discharged terminal path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L6 — `--lane capture` behaves identically to bare
// ===========================================================================

test('L6: `--lane capture` behaves identically to a bare declaration — capture discharged, research still demanded', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T10:00:00.000Z';
    const TOUCH_AT = '2026-06-10T10:15:00.000Z';
    const NC_AT = '2026-06-10T11:00:00.000Z';
    writeTouches(dir, [{ path: 'src/l6-touch.mjs', at: TOUCH_AT }]);
    writeSessionEvents(dir, [
      rEvent('connection pool drain timeout', R_EVENT_AT),
      ncEvent('typo fix, nothing durable', NC_AT, 'capture'),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'DIVERGES-FROM-BARE SHAPE if this fires as 0: an explicit `--lane capture` declaration must behave exactly like a bare one — it must NOT additionally clear the research duty');
    assert.match(nag.stderr, /connection pool drain timeout/, 'the research nag cites the actual query');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'research duty still owed');
    assert.equal(owed(store, 'capture_owed').length, 0, 'capture duty WAS discharged by the explicit capture-lane declaration, matching the bare case');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L7a/L7b — after-the-cutoff re-arm survives lane scoping
// ===========================================================================

test('L7a: a research event arriving AFTER a `--lane all` declaration re-arms the research duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const NC_AT = '2026-06-10T10:00:00.000Z'; // declared FIRST
    const R_EVENT_AT = '2026-06-10T11:00:00.000Z'; // research happens AFTER the declaration
    writeSessionEvents(dir, [
      ncEvent('early note, nothing durable at that point', NC_AT, 'all'),
      rEvent('backpressure queue depth alarm', R_EVENT_AT),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'PRE-FORGIVENESS SHAPE if this fires as 0: even a `--lane all` declaration must not cover research work that arrives after it');
    assert.match(nag.stderr, /backpressure queue depth alarm/, 'the nag cites the actual post-declaration query');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the re-armed, post-declaration research event still enqueues');
  } finally {
    cleanup();
  }
});

test('L7b: a touch arriving AFTER a `--lane all` declaration re-arms the capture duty', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const NC_AT = '2026-06-10T10:00:00.000Z'; // declared FIRST
    const TOUCH_AT = '2026-06-10T11:00:00.000Z'; // touch happens AFTER the declaration
    writeTouches(dir, [{ path: 'src/l7b-touch.mjs', at: TOUCH_AT }]);
    writeSessionEvents(dir, [ncEvent('early note, nothing durable at that point', NC_AT, 'all')]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'PRE-FORGIVENESS SHAPE if this fires as 0: even a `--lane all` declaration must not cover a touch that arrives after it');
    assert.match(nag.stderr, /nothing was captured/, 'the standard capture-duty nag fires');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'capture_owed').length, 1, 'the re-armed, post-declaration touch still enqueues');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L8 — backward compatibility: a legacy event with NO lane field at all
// ===========================================================================

test('L8: a LEGACY no_capture event with NO lane field at all (the exact shape a pre-2026-08-22 writer produced) is read as CAPTURE-lane only — it must not silently gain research-clearing power it never had', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T10:00:00.000Z';
    const TOUCH_AT = '2026-06-10T10:15:00.000Z';
    const NC_AT = '2026-06-10T11:00:00.000Z';
    writeTouches(dir, [{ path: 'src/l8-touch.mjs', at: TOUCH_AT }]);
    // Deliberately hand-built with exactly {kind, detail, at} — no `lane`
    // key — reproducing the literal JSON a pre-ruling writer left on disk.
    writeSessionEvents(dir, [
      rEvent('idle connection reaper cadence', R_EVENT_AT),
      { kind: 'no_capture', detail: 'typo fix, nothing durable', at: NC_AT },
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'SILENT-UPGRADE-TO-ALL SHAPE if this fires as 0: a legacy no-lane-field event was read as if it were `--lane all`, silently gaining research-clearing power it never had');
    assert.match(nag.stderr, /idle connection reaper cadence/, 'the research nag cites the actual query — research was NOT discharged by the legacy event');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'research duty still owed — the legacy event never covered it');
    assert.equal(owed(store, 'capture_owed').length, 0, 'capture duty WAS discharged by the legacy event — it must not be read as "covers nothing" either');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L9 — an invalid --lane value is refused loudly
// ===========================================================================
//
// SURFACE CHOICE (disclosed): the decision's own statement phrases the
// scope as "an explicit --lane scope" (CLI flag syntax) and lists
// scripts/no-capture.mjs among its file_keys, so this spec is pinned at the
// CLI script surface. The parallel MCP tool surface (`no_capture` on
// packages/mcp-server/src/tools.ts, per decision aafbd49e) almost certainly
// needs the identical validation, but its parameter shape for lane is not
// specified anywhere in the interface slice available to this test-writer
// — that half of the spec is NOT expressed here; flagged in the handoff.

test('L9: an INVALID `--lane` value is refused loudly by the no_capture CLI script (scripts/no-capture.mjs) — never silently treated as `all` or `capture`', () => {
  const { dir, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const scriptPath = join(root, 'scripts', 'no-capture.mjs');
    const r = spawnSync(
      process.execPath,
      [scriptPath, '--reason', 'trivial rename, nothing durable', '--lane', 'bogus'],
      { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' } },
    );
    assert.notEqual(r.status, 0, 'SILENT-ACCEPT SHAPE if this exits 0: an unrecognized --lane value must be refused, not silently accepted as if it were a valid lane (or ignored as an unknown flag)');
    assert.match(`${r.stderr}\n${r.stdout}`, /lane/i, 'the refusal names the offending parameter ("lane") — a generic/opaque failure is not a loud refusal');
    assert.equal(existsSync(eventsPath(dir)), false, 'REFUSAL-AFTER-WRITE SHAPE if this fails: the refusal happens BEFORE any session-event write, matching the existing honesty-surface precedent (blank reason/target/family refused before any write, decision aafbd49e) — no event register should exist at all');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// L10 — fail-open timestamp regression survives lane scoping
// ===========================================================================

test('L10 (fail-open regression): a research event with a MISSING `at` is still never discharged, even by an explicit `--lane research` declaration', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    // NC_AT deliberately very late: if a missing `at` were ever treated as
    // sorting BEFORE this cutoff, an explicit research-lane declaration
    // would wrongly appear to cover it — the same defect class as SPEC A/B
    // in the sibling h10-fail-open-timestamps.test.mjs, now checked against
    // the NEW lane-aware comparison site rather than the old global one.
    const NC_AT = '2026-06-10T23:00:00.000Z';
    writeSessionEvents(dir, [
      rEvent('leader election heartbeat interval', undefined),
      ncEvent('research dead-ended, nothing new confirmed', NC_AT, 'research'),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'FAIL-OPEN SHAPE if this fires as 0: a research event with no `at` at all was silently discharged by an explicit `--lane research` cutoff instead of staying armed — the lane-scoping rewrite must not regress the fail-open timestamp guard');
    assert.match(nag.stderr, /leader election heartbeat interval/, 'the nag cites the actual query, proving the research duty is what fired');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the re-armed research duty still enqueues on release');
  } finally {
    cleanup();
  }
});
