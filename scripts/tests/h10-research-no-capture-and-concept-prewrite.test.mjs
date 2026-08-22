// H10 SPEC-ONLY tests for two behaviors being implemented in parallel
// (scripts/hooks/h10-direct-capture.mjs). NEITHER exists yet — every test
// below is expected to be RED (or, where noted, a boundary/regression guard
// that may already pass under today's code) — this file is deliberately a
// SEPARATE test file from scripts/tests/hooks-full.test.mjs, mirroring the
// established scripts/tests/h10-delegation-watch.test.mjs /
// scripts/tests/h10-touch-noise.test.mjs precedent for adding new H10
// coverage without touching the giant frozen battery. This file duplicates
// the minimal harness/fixture helpers those files already duplicate
// (runHook, makeProject, hookInput, envelope, session-events register
// writer) rather than importing hooks-full.test.mjs as a module (test files
// register their `test()` calls at import time — importing one as a module
// would double-run its suite).
//
// The session-events register shape, the research-duty fixtures (rEvent,
// researchFinding), the no_capture fixtures (ncEvent), and the concept-duty
// fixtures (cEvent, conceptArticle) are reused verbatim from
// scripts/tests/hooks-full.test.mjs's existing "H10 AC1-AC7" / "no-capture
// duty" / "H10 concept duty" sections — this file only adds NEW cases, never
// edits or weakens those existing ones.
//
// ===========================================================================
// SPEC 1 — the RESEARCH lane honors the no_capture declaration cutoff
// (symmetry with the CAPTURE lane's existing no_capture handling: a
// declaration at/after an earlier event discharges it; work arriving AFTER
// the declaration re-arms the duty; see hooks-full.test.mjs "no-capture
// duty" tests for the capture-lane precedent this mirrors).
//
//   1a — a research event followed by a no_capture declaration whose cutoff
//        COVERS it (declaration at/after the event) discharges the research
//        duty: no nag, register clears, nothing owed.
//   1b — a research event occurring AFTER the latest no_capture cutoff still
//        triggers the research-duty demand: the declaration never
//        pre-forgives future events.
//   1c (regression) — a research_finding/decision/anti_pattern write since
//        the event still discharges the duty (existing behavior, pinned so
//        the no_capture wiring does not disturb it).
//
// ===========================================================================
// SPEC 2 — the CONCEPT duty accepts the natural write-then-register
// ordering: a live feature_article carrying the concept_family, created or
// updated within A FIXED 15-MINUTE GRACE WINDOW BEFORE the concept_designed
// event, satisfies the duty EVEN WITH NO OTHER SESSION EVENT to widen the
// existing "session-window floor" (the session-window fix in
// hooks-full.test.mjs widens the floor only when an EARLIER session-register
// event of ANY kind exists this session — this spec is a distinct,
// unconditional pre-write grace period that does not depend on any other
// event being present).
//
//   2a — an article 1 minute BEFORE the event, with no other session event
//        at all, satisfies the duty.
//   2b — an article MORE than 15 minutes before the event (16 minutes),
//        with no later write, does NOT satisfy — the duty still nags. This
//        already holds under today's (unimplemented) code by omission —
//        pinned here as the grace window's outer boundary so the fix cannot
//        widen the window past 15 minutes.
//   2c (regression) — an article created/updated AFTER the event still
//        satisfies (existing register-then-write ordering, pinned so the
//        pre-write grace window does not disturb it).
//
// Interpretation note (disclosed, not invented): "within 15 minutes before"
// is read as INCLUSIVE of the boundary itself (<= 15 minutes early still
// satisfies) — the more common reading of "within N". An exact-boundary case
// is included (2d) pinning that reading; if the intended semantics are
// exclusive instead, 2d is the one test to renegotiate, not 2a/2b/2c.
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-rc-'));
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
const ncEvent = (reason, at) => ({ kind: 'no_capture', detail: reason, at });
const cEvent = (family, at) => ({ kind: 'concept_designed', detail: family, at });

function researchFinding(store, at) {
  return store.create({
    ...envelope('research_finding', at),
    question: 'genesys webhook signature scope?',
    answer: 'per-org secret, validated at the edge',
    source_urls: ['https://developer.genesys.cloud/x'],
    source_date: '2026-06-10',
    capture_date: '2026-06-10',
  });
}

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

// ===========================================================================
// SPEC 1 — research lane honors the no_capture cutoff
// ===========================================================================

test('SPEC1a: a no_capture declaration AT/AFTER the research event discharges the research duty — symmetry with the capture lane', () => {
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
    assert.equal(r.code, 0, 'a no_capture declaration at/after the research event discharges the research duty immediately, mirroring the capture-lane no_capture cutoff — no soft-block phase at all');
    assert.doesNotMatch(r.stderr, /research duty|nothing was researched/i, 'no research nag when discharged by no_capture');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared on the discharged terminal path');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed — the duty was discharged, not deferred');
  } finally {
    cleanup();
  }
});

test('SPEC1b: a research event AFTER the latest no_capture cutoff still triggers the research-duty demand — the declaration never pre-forgives future events', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const NC_AT = '2026-06-10T10:00:00.000Z'; // declared FIRST
    const R_EVENT_AT = '2026-06-10T11:00:00.000Z'; // research happens AFTER the declaration
    writeSessionEvents(dir, [
      ncEvent('early note, nothing durable at that point', NC_AT),
      rEvent('genesys webhook signature validation', R_EVENT_AT),
    ]);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'a research event occurring after the no_capture cutoff still arms the research duty — the earlier declaration does not cover future work');
    assert.match(nag.stderr, /genesys webhook signature validation/, 'the nag cites the actual post-declaration query verbatim');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    const items = owed(store, 'research_owed');
    assert.equal(items.length, 1, 'exactly one research_owed enqueued for the re-armed, post-declaration research event');
    assert.match(items[0].text, /genesys webhook signature validation/, 'the owed item carries the re-armed query');
  } finally {
    cleanup();
  }
});

test('SPEC1c (regression): a research_finding created since the earliest research event still discharges the duty, undisturbed by the no_capture wiring', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
    const CAPTURE_AT = '2026-06-10T13:00:00.000Z';
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation', R_EVENT_AT)]);
    researchFinding(store, CAPTURE_AT); // created after the event, no no_capture involved
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'a research_finding since the earliest research event still discharges the research duty (existing path)');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed when satisfied by a finding');
    assert.equal(existsSync(eventsPath(dir)), false, 'register cleared on the satisfied path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// SPEC 2 — concept duty accepts a fixed 15-minute pre-write grace window
// ===========================================================================

test('SPEC2a: a concept-family article created 1 minute BEFORE the concept_designed event satisfies the duty, with no other session event present to widen the floor', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z';
    const ARTICLE_AT = '2026-06-10T11:59:00.000Z'; // 1 minute before — the ONLY session event is the concept_designed one
    writeSessionEvents(dir, [cEvent('weapons', CONCEPT_AT)]);
    conceptArticle(store, 'weapons', ARTICLE_AT);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'the natural write-then-register order (article 1 minute before the registration) satisfies the duty even with no earlier session event to widen the session-window floor');
    assert.equal(owed(store, 'concept_article_missing').length, 0, 'nothing owed — satisfied, not deferred');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared on the satisfied path');
  } finally {
    cleanup();
  }
});

test('SPEC2b: a concept-family article MORE than 15 minutes before the event (16 minutes), with no later write, does NOT satisfy — the duty still nags', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z';
    const ARTICLE_AT = '2026-06-10T11:44:00.000Z'; // 16 minutes before — outside the grace window
    writeSessionEvents(dir, [cEvent('weapons', CONCEPT_AT)]);
    conceptArticle(store, 'weapons', ARTICLE_AT);
    const stop = () => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

    const nag = stop();
    assert.equal(nag.code, 2, 'an article 16 minutes before the event falls outside the 15-minute grace window — the duty still nags');
    assert.match(nag.stderr, /weapons/, 'the nag names the unmet family verbatim');

    const release = stop();
    assert.equal(release.code, 0, 'second Stop releases');
    assert.equal(owed(store, 'concept_article_missing').filter((t) => t.text.includes("'weapons'")).length, 1, 'the owed item still lands — the grace window has a real outer edge');
  } finally {
    cleanup();
  }
});

test('SPEC2c (regression): a concept-family article created AFTER the concept_designed event still satisfies the duty, undisturbed by adding the pre-write grace window', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z';
    const ARTICLE_AT = '2026-06-10T13:00:00.000Z'; // after the event — the existing register-then-write path
    writeSessionEvents(dir, [cEvent('weapons', CONCEPT_AT)]);
    conceptArticle(store, 'weapons', ARTICLE_AT);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'register-then-write still satisfies, unaffected by the new pre-write grace window');
    assert.equal(owed(store, 'concept_article_missing').length, 0);
  } finally {
    cleanup();
  }
});

test('SPEC2d (boundary): a concept-family article EXACTLY 15 minutes before the event satisfies the duty — "within 15 minutes" is read inclusive of the boundary', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    seedEventsConfig(dir);
    const CONCEPT_AT = '2026-06-10T12:00:00.000Z';
    const ARTICLE_AT = '2026-06-10T11:45:00.000Z'; // exactly 15 minutes before
    writeSessionEvents(dir, [cEvent('weapons', CONCEPT_AT)]);
    conceptArticle(store, 'weapons', ARTICLE_AT);
    const r = runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);
    assert.equal(r.code, 0, 'exactly 15 minutes before is still WITHIN the grace window (inclusive boundary reading)');
    assert.equal(owed(store, 'concept_article_missing').length, 0);
  } finally {
    cleanup();
  }
});
