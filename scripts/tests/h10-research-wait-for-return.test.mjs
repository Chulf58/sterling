// H10 SPEC-ONLY tests for the RESEARCH RETURN GATE (user-ruled 2026-09-22,
// through the question form, verbatim intent: "Wait for return" — H10 must
// not raise the research duty for a dispatched research/scout agent while
// that agent is still running; only after it has returned).
//
// NEW SIBLING FILE by established precedent (see
// h10-deferral-article-demand-and-pending-carry.test.mjs's own header):
// scripts/tests/hooks-full.test.mjs and the h10-*.test.mjs siblings stay
// FROZEN and unedited; they duplicate harness/fixture helpers rather than
// importing one test file as a module (importing would double-run its
// registered `test()` calls). The harness below is copied verbatim in shape
// from h10-deferral-article-demand-and-pending-carry.test.mjs, which owns the
// H10-deferral fixtures (dispatch-register.json seeding, `liveEntry`, etc).
//
// ---------------------------------------------------------------------------
// SEMANTICS CHOSEN (case (e), disclosed because the design has no per-event
// join key to work with — see h10-direct-capture.mjs's `researchDispatchLive`
// comment): `agent_dispatch` events in session-events.json carry only
// {kind, detail, at} — no agent_id — so an event cannot be joined to the ONE
// H22 register entry that produced it. The gate is therefore LANE-WIDE: while
// ANY presumed-active register entry names a configured research agent type,
// EVERY agent_dispatch research event defers together. With two outstanding
// research dispatches, one returned and one still running, the whole lane
// stays quiet until BOTH leave presumed-active — it does not release just the
// returned one. `research_tool` events (WebSearch/WebFetch) are never gated:
// those are synchronous conductor actions, already complete by construction.
// ---------------------------------------------------------------------------

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
const NOW = '2026-06-10T12:00:00.000Z';
const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
const CAPTURE_AT = '2026-06-10T13:00:00.000Z';

let SterlingStore;
const ready = (async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
})();

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
  session_events: { research_agents: ['researcher', 'claude-code-guide'] },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-research-return-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const hookInput = (dir, over = {}) => ({
  session_id: 's1',
  transcript_path: join(dir, 't', 's1.jsonl'),
  cwd: dir,
  permission_mode: 'default',
  ...over,
});

const stopOnce = (dir) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

const eventsPath = (dir) => join(dir, '.sterling', 'transient', 'session-events.json');
const registerPath = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');

function writeSessionEvents(dir, events) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(eventsPath(dir), JSON.stringify(events));
}

function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

const readSessionEvents = (dir) => (existsSync(eventsPath(dir)) ? JSON.parse(readFileSync(eventsPath(dir), 'utf8')) : []);

const agoISO = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
// `at` on a register entry is compared against `now` for the presumed-active
// lease window (config.dispatch_register.stale_minutes, default 60m) — agoISO(0)
// keeps every fixture well inside it.
const liveEntry = (agentId, agentType, sessionId = 's1') => ({
  agent_id: agentId,
  agent_type: agentType,
  session_id: sessionId,
  files: [],
  at: agoISO(0),
});
const endedEntry = (agentId, agentType, sessionId = 's1') => ({
  ...liveEntry(agentId, agentType, sessionId),
  ended: { at: agoISO(0), event: 'subagent-stop' }, // A1: H22 marks ended, never deletes
});

const aEvent = (detail, at = R_EVENT_AT) => ({ kind: 'agent_dispatch', detail, at });
const rEvent = (detail, at = R_EVENT_AT) => ({ kind: 'research_tool', detail, at });

function researchFinding(store, at = CAPTURE_AT) {
  return store.create({
    ...envelope('research_finding', at),
    question: 'genesys webhook signature scope?',
    answer: 'per-org secret, validated at the edge',
    source_urls: ['https://developer.genesys.cloud/x'],
    source_date: '2026-06-10',
    capture_date: '2026-06-10',
  });
}

const owed = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === reason);

test('setup', async () => {
  await ready;
});

// ===========================================================================
// (a) research dispatched, NOT yet returned -> Stop does NOT block on the
// research lane, and the event survives on disk so the duty can re-arm once
// the agent returns (the debt cannot evaporate, P5 / decision b2474b26).
// ===========================================================================

test('(a) a dispatched researcher still presumed-active in the H22 register is NOT nagged — the research lane stays quiet while the agent runs', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [aEvent('researcher')]);
    writeRegisterRaw(dir, [liveEntry('sub-researcher-1', 'researcher')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'PREMATURE-DEMAND SHAPE if this is 2: the dispatched researcher has not returned yet, so H10 must not ask for a research_finding/no_capture for work that does not exist');
    assert.doesNotMatch(out(r), /research/i, 'no research nag text at all while the agent is still running');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed while the agent is live');
    assert.deepEqual(readSessionEvents(dir), [aEvent('researcher')], 'EVAPORATION SHAPE if this is []: the agent_dispatch event must survive this quiet Stop untouched, or the duty can never re-arm once the agent returns');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (b) research dispatched AND returned (H22 marked the entry `ended`), no
// capture -> Stop DOES block, exactly as the pre-existing research duty did.
// ===========================================================================

test('(b) once the H22 register marks the dispatch ENDED (SubagentStop), the unmet research duty nags exactly as it always has', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [aEvent('researcher')]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-1', 'researcher')]);

    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'the agent has returned with nothing captured — the research duty must still nag');
    assert.match(nag.stderr, /researcher/, 'the nag cites the configured research agent');
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');

    const second = stopOnce(dir);
    assert.equal(second.code, 0, 'soft-blocked exactly once — the second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the unmet, returned research duty is durably queued');
    assert.equal(existsSync(eventsPath(dir)), false, 'a terminal release clears session-events.json (P4)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (c) returned + a research_finding captured after the event -> satisfied,
// no nag, registers clear.
// ===========================================================================

test('(c) a returned dispatch followed by a research_finding satisfies the duty — no nag, both registers clear', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [aEvent('researcher')]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-1', 'researcher')]);
    researchFinding(store); // created AFTER the earliest research event -> satisfies the duty

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'a research_finding since the earliest research event satisfies the research duty');
    assert.doesNotMatch(r.stderr, /research duty|nothing was researched/i, 'no research nag when satisfied');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared on the satisfied terminal path');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed when the duty is met');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (d) returned + no_capture --lane research -> satisfied, discharged.
// ===========================================================================

test('(d) a returned dispatch discharged by a no_capture --lane research declaration is satisfied — no nag, registers clear', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const noCaptureAt = '2026-06-10T11:30:00.000Z'; // after the event, so it discharges it
    writeSessionEvents(dir, [aEvent('researcher'), { kind: 'no_capture', detail: 'nothing durable from this scout', lane: 'research', at: noCaptureAt }]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-1', 'researcher')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'a no_capture --lane research declaration discharges the returned dispatch\'s research event');
    assert.doesNotMatch(r.stderr, /research duty|nothing was researched/i, 'no research nag when discharged');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared once the discharge is terminal');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed when the duty is discharged');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (e) two dispatches, one returned and one still running -> chosen semantics:
// the WHOLE research lane defers until every live research-type dispatch has
// left presumed-active (no per-event join key exists to release the returned
// one alone — see the header). Documented, not silently assumed.
// ===========================================================================

test('(e) two research dispatches, one ENDED and one still presumed-active: the WHOLE lane stays quiet (chosen semantics), and both events survive for re-arming', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [aEvent('researcher', '2026-06-10T11:00:00.000Z'), aEvent('claude-code-guide', '2026-06-10T11:05:00.000Z')]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-1', 'researcher'), liveEntry('sub-guide-1', 'claude-code-guide')]);

    const r = stopOnce(dir);
    assert.equal(
      r.code,
      0,
      'CHOSEN SEMANTICS: with no join key from an event back to a specific register entry, one still-live research dispatch defers the ENTIRE research lane, including the already-returned one — a partial per-dispatch release is not attempted'
    );
    assert.doesNotMatch(out(r), /research/i, 'no research nag at all while any research dispatch is still live');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('researcher', '2026-06-10T11:00:00.000Z'), aEvent('claude-code-guide', '2026-06-10T11:05:00.000Z')],
      'EVAPORATION SHAPE if this is []: BOTH events must survive — the returned one\'s debt cannot be lost just because it happened to defer alongside a live sibling'
    );

    // The live sibling now returns too; nothing was ever captured, so the
    // duty (for BOTH events) must now nag.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-1', 'researcher'), endedEntry('sub-guide-1', 'claude-code-guide')]);
    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'RE-ARM SHAPE: once every tracked research dispatch has returned, the still-unmet duty nags');
    assert.match(nag.stderr, /researcher/, 'both agent types are still represented in the nag');
    assert.match(nag.stderr, /claude-code-guide/, 'both agent types are still represented in the nag');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// LEASE-EXPIRY BOUND (P5): an unattributed/never-SubagentStopped dispatch
// must not defer the research lane forever — once its lease
// (config.dispatch_register.stale_minutes, default 60m) expires, its status
// drops from presumed-active and the duty re-arms, mirroring the existing
// file fan-out deferral's own bound (decision foreign_ec9eacaa).
// ===========================================================================

test('LEASE BOUND: a dispatch whose lease has expired (no SubagentStop ever recorded) no longer defers the research lane — it re-arms rather than staying silent forever', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [aEvent('researcher')]);
    // 90 minutes old, well past the default 60-minute lease, and never ended:
    // classifyRegister must read this as 'unknown', not 'presumed-active'.
    writeRegisterRaw(dir, [{ agent_id: 'sub-researcher-1', agent_type: 'researcher', session_id: 's1', files: [], at: agoISO(90) }]);

    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'EVAPORATION-BY-SILENCE SHAPE if this is 0: an expired lease is not a licence to defer forever (P5) — the duty must re-arm once the presumed-active window has passed, even with no explicit SubagentStop');
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONTROL: with an EMPTY dispatch register (the pre-existing shape every
// hooks-full.test.mjs research test exercises), behaviour is BYTE-IDENTICAL
// to before this fix — proves the gate costs nothing when there is nothing to
// gate.
// ===========================================================================

test('CONTROL: an empty dispatch register behaves exactly as before — the research duty nags immediately, unaffected by the return gate', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation'), aEvent('researcher')]);
    writeRegisterRaw(dir, []);

    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'CONTROL BROKEN: with no live register entry the pre-existing research duty must still nag immediately');
    assert.match(nag.stderr, /genesys webhook signature validation/, 'CONTROL BROKEN: the research_tool query is cited, unaffected by the gate');
    assert.match(nag.stderr, /researcher/, 'CONTROL BROKEN: the agent_dispatch detail is cited too');
  } finally {
    cleanup();
  }
});
