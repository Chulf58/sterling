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
// PER-DISPATCH JOIN (board d33d8ac4, superseding the LANE-WIDE design this
// file originally pinned): H16 now records the launching PostToolUse's
// tool_response.agentId as `agent_id` on the `agent_dispatch` event, so each
// event joins to its OWN H22 register entry — never a sibling's. This fixes
// two residual defects the lane-wide design had:
//   (1) a rolling stream of live research dispatches could keep deferring a
//       SIBLING dispatch that had already returned (its own evidence said
//       "done", but an unrelated live dispatch silenced it anyway);
//   (2) a lease-expired dispatch with no `ended.at` of its own could be
//       DISCHARGED by a no_capture declared after an UNRELATED dispatch's
//       `ended.at` — evidence that says nothing about the lease-expired one.
// `agent_dispatch` events in session-events.json now carry `agent_id` when
// H16 recorded it; `research_tool` events (WebSearch/WebFetch) never carry
// one and are never gated — those are synchronous conductor actions, already
// complete by construction.
//
// LEGACY-EVENT RULE (an `agent_dispatch` event with no `agent_id`, e.g. one
// written by an H16 build before this fix shipped, mid-session): it has NO
// join to any register entry, by construction. Chosen safe behaviour: it is
// NEVER treated as live (so it is never deferred merely because some OTHER
// dispatch happens to be presumed-active — defect (1)'s shape) and NEVER
// discharged by no_capture on ANY register evidence, its own or another
// dispatch's (defect (2)'s shape, made unconditional for the id-less case).
// This is strictly stronger than the pre-return-gate lane-wide behaviour a
// legacy event otherwise inherits (no_capture used to discharge every earlier
// research event unconditionally) but never a regression: the event still
// leaves the pool via a real research_finding/decision/anti_pattern (the
// group `researchSatisfied` anchor, unaffected by this fix) or via the
// research_owed queue once nagged — Sol confirmed there is no trap in that
// direction (board d33d8ac4).
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
// `toolUseId` (4th positional/options arg) is OPTIONAL — set it to construct
// a round H22 bound from real Pre/Post evidence (source 'post'/
// 'derived-type-unique'); omit it for a 'resume'/'unattributable' Start,
// which the resolver leaves tool_use_id-less by its own design.
const liveEntry = (agentId, agentType, sessionId = 's1', { toolUseId } = {}) => ({
  agent_id: agentId,
  agent_type: agentType,
  session_id: sessionId,
  files: [],
  at: agoISO(0),
  ...(toolUseId ? { tool_use_id: toolUseId } : {}),
});
// endedAt defaults to real-now (agoISO(0)) — fine for every test that never
// compares it against a fictional no_capture declaration timestamp. A test
// that DOES (the return-anchored discharge fixture below) passes an explicit
// fictional endedAt so the two timelines line up.
const endedEntry = (agentId, agentType, sessionId = 's1', endedAt = agoISO(0), { toolUseId } = {}) => ({
  ...liveEntry(agentId, agentType, sessionId, { toolUseId }),
  ended: { at: endedAt, event: 'subagent-stop' }, // A1: H22 marks ended, never deletes
});

// `agentId` is OPTIONAL: omitting it produces a LEGACY event (no join key),
// exactly the shape H16 wrote before this fix. `toolUseId` is OPTIONAL too —
// H10's join PREFERS it (exact per-launch key) and falls back to
// (session_id, agent_id) when absent (board d33d8ac4 round 2, Sol HIGH).
const aEvent = (detail, at = R_EVENT_AT, agentId, toolUseId) => ({
  kind: 'agent_dispatch',
  detail,
  at,
  ...(agentId ? { agent_id: agentId } : {}),
  ...(toolUseId ? { tool_use_id: toolUseId } : {}),
});
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

test('(a) a dispatched researcher still presumed-active in its OWN H22 register entry is NOT nagged — the research lane stays quiet while the agent runs', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [aEvent('researcher', R_EVENT_AT, 'sub-researcher-1')]);
    writeRegisterRaw(dir, [liveEntry('sub-researcher-1', 'researcher')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'PREMATURE-DEMAND SHAPE if this is 2: the dispatched researcher has not returned yet, so H10 must not ask for a research_finding/no_capture for work that does not exist');
    assert.doesNotMatch(out(r), /research/i, 'no research nag text at all while the agent is still running');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed while the agent is live');
    assert.deepEqual(readSessionEvents(dir), [aEvent('researcher', R_EVENT_AT, 'sub-researcher-1')], 'EVAPORATION SHAPE if this is []: the agent_dispatch event must survive this quiet Stop untouched, or the duty can never re-arm once the agent returns');
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
    writeSessionEvents(dir, [aEvent('researcher', R_EVENT_AT, 'sub-researcher-1')]);
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
    writeSessionEvents(dir, [aEvent('researcher', R_EVENT_AT, 'sub-researcher-1')]);
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
    const returnedAt = '2026-06-10T11:15:00.000Z'; // the dispatch returned BEFORE the declaration
    const noCaptureAt = '2026-06-10T11:30:00.000Z'; // declared after the event AND after the return, so it legitimately discharges it
    writeSessionEvents(dir, [aEvent('researcher', R_EVENT_AT, 'sub-researcher-1'), { kind: 'no_capture', detail: 'nothing durable from this scout', lane: 'research', at: noCaptureAt }]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-1', 'researcher', 's1', returnedAt)]);

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
// RETURN-ANCHORED DISCHARGE FIX (Sol review, HIGH found on commit 4b75112): a
// no_capture declaration made WHILE a dispatch is still presumed-active cannot
// honestly discharge that dispatch's event — its result does not exist yet,
// however far in the fictional past the event's own dispatch-time `at` sits
// relative to the declaration. `dischargedOnResearchLane` alone compares
// against the event's dispatch-time `at`, which is always EARLIER than any
// later declaration by construction, so it always looked "discharged" — and
// once dropped by clearRegisters(), the event never re-arms even after the
// dispatch genuinely returns with nothing captured (P5 silent loss).
// ===========================================================================

test('RETURN-ANCHORED DISCHARGE FIX: a no_capture declared WHILE the dispatch is still live must not discharge (and delete) its event — the duty still blocks once the dispatch returns with nothing captured', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const DISPATCH_AT = '2026-06-10T10:00:00.000Z';
    const NO_CAPTURE_AT = '2026-06-10T10:05:00.000Z'; // declared WHILE still live — premature, before any result exists
    writeSessionEvents(dir, [aEvent('researcher', DISPATCH_AT, 'sub-researcher-live'), { kind: 'no_capture', detail: 'nothing seen so far', lane: 'research', at: NO_CAPTURE_AT }]);
    writeRegisterRaw(dir, [liveEntry('sub-researcher-live', 'researcher')]); // still live when the declaration was made

    const deferred = stopOnce(dir);
    assert.equal(deferred.code, 0, 'still live — the lane defers quietly');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('researcher', DISPATCH_AT, 'sub-researcher-live')],
      'PREMATURE-DISCHARGE SHAPE if this is []: a no_capture declared before return must not discharge (and thereby delete) the still-live dispatch event — its result does not exist yet'
    );

    // The dispatch returns; nothing new was ever captured.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-live', 'researcher', 's1', agoISO(0))]);
    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'NEVER-RE-ARMS SHAPE if this is 0: the premature no_capture declaration must not discharge an event whose dispatch had not returned at declaration time — it must still block once the dispatch returns with nothing captured'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

test('RETURN-ANCHORED DISCHARGE: a no_capture declared AFTER the dispatch actually returns still legitimately discharges it — satisfied, no nag', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const DISPATCH_AT = '2026-06-10T10:00:00.000Z';
    const RETURN_AT = '2026-06-10T10:10:00.000Z';
    const NO_CAPTURE_AT = '2026-06-10T10:15:00.000Z'; // declared AFTER the dispatch returned — legitimate
    writeSessionEvents(dir, [aEvent('researcher', DISPATCH_AT, 'sub-researcher-returned'), { kind: 'no_capture', detail: 'nothing durable', lane: 'research', at: NO_CAPTURE_AT }]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-returned', 'researcher', 's1', RETURN_AT)]);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'OVER-CORRECTION SHAPE if this is 2: the declaration came after the dispatch genuinely returned — it must still legitimately discharge the event');
    assert.doesNotMatch(out(r), /research duty|nothing was researched/i, 'no research nag when discharged');
    assert.equal(existsSync(eventsPath(dir)), false, 'session-events register cleared once the discharge is terminal');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// NO-VALID-RETURN-EVIDENCE FIX (Sol review, second HIGH found on commit
// 7f9f0b5): when an agent_dispatch's OWN register entry carries no valid
// `ended.at`, the discharge anchor must NOT fall back to the event's own
// dispatch-time `at` — that fallback reintroduces the ORIGINAL bug, since a
// dispatch-time anchor is always earlier than any later declaration by
// construction and would always look "discharged". Without proof the
// dispatch actually returned (a lease-expired entry with no SubagentStop
// ever recorded, or a register that cannot be read at all), the event must
// stay ARMED and re-arm as an ordinary unmet research event — never silently
// discharged on uncertain evidence (P5).
// ===========================================================================

test('NO-VALID-RETURN-EVIDENCE FIX: a lease-expired dispatch with NO SubagentStop ever recorded must not be discharged by a no_capture declared during its run — the duty blocks', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const DISPATCH_AT = '2026-06-10T10:00:00.000Z';
    const NO_CAPTURE_AT = '2026-06-10T10:05:00.000Z'; // declared while the dispatch was still (apparently) running
    writeSessionEvents(dir, [aEvent('researcher', DISPATCH_AT, 'sub-researcher-stale'), { kind: 'no_capture', detail: 'nothing seen so far', lane: 'research', at: NO_CAPTURE_AT }]);
    // 90 real minutes old (past the default 60-minute lease) and NEVER ended —
    // classifyRegister reads this as 'unknown', not 'presumed-active' and not
    // 'inactive-confirmed': no valid return evidence exists at all.
    writeRegisterRaw(dir, [{ agent_id: 'sub-researcher-stale', agent_type: 'researcher', session_id: 's1', files: [], at: agoISO(90) }]);

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'FALLBACK-TO-DISPATCH-TIME SHAPE if this is 0: no `ended.at` exists anywhere on THIS dispatch\'s own entry, so the declaration has nothing valid to anchor against — falling back to the event\'s own (always-earlier) dispatch time would silently discharge it exactly like the original bug'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

test('NO-VALID-RETURN-EVIDENCE FIX: an unreadable dispatch register plus a no_capture declaration must not discharge the event — the duty blocks', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const DISPATCH_AT = '2026-06-10T10:00:00.000Z';
    const NO_CAPTURE_AT = '2026-06-10T10:05:00.000Z';
    writeSessionEvents(dir, [aEvent('researcher', DISPATCH_AT, 'sub-researcher-unreadable'), { kind: 'no_capture', detail: 'nothing seen so far', lane: 'research', at: NO_CAPTURE_AT }]);
    writeRegisterRaw(dir, 'not valid json{'); // classifyRegister -> availability 'corrupt', no entries readable at all

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'FALLBACK-TO-DISPATCH-TIME SHAPE if this is 0: an unreadable register can prove no return happened — the declaration must not discharge the event on the strength of its own (always-earlier) dispatch time'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DEFECT 1 FIX (Sol, board d33d8ac4, MEDIUM at h10-direct-capture.mjs:1222-
// 1227 pre-fix): under the OLD lane-wide gate, ANY presumed-active
// research-type register entry deferred EVERY agent_dispatch research event,
// including one whose OWN dispatch had already returned with nothing
// captured. The per-dispatch join fixes this: each event's own register
// entry decides its own fate.
// ===========================================================================

test('DEFECT 1 FIX (board d33d8ac4): a still-live research dispatch must not keep deferring a SIBLING dispatch that has already returned', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const RETURNED_AT = '2026-06-10T11:00:00.000Z';
    const LIVE_AT = '2026-06-10T11:05:00.000Z';
    writeSessionEvents(dir, [aEvent('researcher', RETURNED_AT, 'sub-researcher-returned'), aEvent('claude-code-guide', LIVE_AT, 'sub-guide-live')]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-returned', 'researcher'), liveEntry('sub-guide-live', 'claude-code-guide')]);

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'LANE-WIDE-DEFERRAL BUG if this is 0: the returned dispatch has nothing captured and must nag on its OWN evidence, regardless of the still-live sibling'
    );
    assert.match(nag.stderr, /researcher/, 'the nag names the returned dispatch');
    assert.doesNotMatch(nag.stderr, /claude-code-guide/, 'the still-live sibling must not be named in a duty nag — it stays quietly deferred on its own merits');

    const second = stopOnce(dir);
    assert.equal(second.code, 0, 'soft-blocked exactly once — the second Stop releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'the returned dispatch\'s duty is durably queued');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('claude-code-guide', LIVE_AT, 'sub-guide-live')],
      'the still-live sibling\'s event must survive to re-arm once IT returns; the returned dispatch\'s event was already consumed by the research_owed conversion'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DEFECT 2 FIX (Sol, board d33d8ac4, HIGH at h10-direct-capture.mjs:1260,
// 1268 pre-fix): under the OLD lane-wide discharge anchor
// (`latestResearchReturnAt`), a lease-expired dispatch with NO `ended.at` of
// its own could be discharged by a no_capture declared after an UNRELATED
// dispatch's `ended.at` — evidence that proves nothing about the
// lease-expired one. The per-dispatch join fixes this: discharge requires the
// event's OWN register entry to be `inactive-confirmed` with a valid
// `ended.at`.
// ===========================================================================

test('DEFECT 2 FIX (board d33d8ac4): a lease-expired dispatch with no ended.at of its own must not be discharged by an UNRELATED dispatch\'s return', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const A_DISPATCH_AT = '2026-06-10T09:00:00.000Z';
    const A_RETURNED_AT = '2026-06-10T09:30:00.000Z';
    const B_DISPATCH_AT = '2026-06-10T10:00:00.000Z';
    const NO_CAPTURE_AT = '2026-06-10T09:45:00.000Z'; // after A returned — legitimately discharges A, nothing else
    writeSessionEvents(dir, [
      aEvent('researcher', A_DISPATCH_AT, 'sub-researcher-a'),
      aEvent('researcher', B_DISPATCH_AT, 'sub-researcher-b'),
      { kind: 'no_capture', detail: 'nothing durable from A', lane: 'research', at: NO_CAPTURE_AT },
    ]);
    writeRegisterRaw(dir, [
      endedEntry('sub-researcher-a', 'researcher', 's1', A_RETURNED_AT),
      // B is lease-expired with NO SubagentStop ever recorded — 'unknown', not 'inactive-confirmed'.
      { agent_id: 'sub-researcher-b', agent_type: 'researcher', session_id: 's1', files: [], at: agoISO(90) },
    ]);

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'LANE-WIDE-DISCHARGE BUG if this is 0: B carries no ended.at of its own — A\'s return, an unrelated dispatch\'s evidence, must not discharge B'
    );
    assert.match(nag.stderr, /research/i, 'B\'s duty still nags (A was legitimately discharged on its own evidence and is silent)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// LEGACY EVENTS (no agent_id — written before this fix, or a Post that never
// bound one): never treated as live off an unrelated dispatch, and never
// discharged off any register evidence, own or unrelated (see the file
// header's LEGACY-EVENT RULE).
// ===========================================================================

test('LEGACY EVENT (no agent_id): a live UNRELATED dispatch must not defer it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const LEGACY_AT = '2026-06-10T09:00:00.000Z';
    writeSessionEvents(dir, [aEvent('researcher', LEGACY_AT)]); // no agent_id: legacy shape
    writeRegisterRaw(dir, [liveEntry('sub-researcher-live', 'researcher')]); // unrelated, still live

    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'LANE-WIDE-DEFERRAL SHAPE if this is 0: a legacy event with no join key must not be silenced merely because an unrelated dispatch is live');
    assert.match(nag.stderr, /research/i, 'the legacy event still nags on its own merit');
  } finally {
    cleanup();
  }
});

test('LEGACY EVENT (no agent_id): an unrelated dispatch\'s ended.at must not discharge it — it has no own evidence to anchor on, ever', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const LEGACY_AT = '2026-06-10T09:00:00.000Z';
    const OTHER_RETURNED_AT = '2026-06-10T09:15:00.000Z';
    const NO_CAPTURE_AT = '2026-06-10T09:30:00.000Z';
    writeSessionEvents(dir, [aEvent('researcher', LEGACY_AT), { kind: 'no_capture', detail: 'nothing durable', lane: 'research', at: NO_CAPTURE_AT }]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-other', 'researcher', 's1', OTHER_RETURNED_AT)]); // unrelated to the legacy event

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'a legacy event has no register row of its own, so the per-event join finds no valid return evidence at all — it stays ARMED rather than falling back to any evidence, own or unrelated (stricter than pre-fix, Sol-confirmed safe: a research_finding or research_owed still closes it)'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// STALE SATISFACTION FIX (Sol review, HIGH found on commit 5306735): a
// research event that is already INDIVIDUALLY satisfied by an earlier finding
// must be consumed on the deferring Stop that discovers it, exactly as a
// non-deferring Stop would consume it — never carried alongside a genuinely
// outstanding sibling event, or the group's earliest-active-event anchor gets
// dragged back to the settled event's stale timestamp once the live dispatch
// returns and the gate lifts, letting the earlier finding silently satisfy
// the later, still-outstanding dispatch (decision b2474b26's rejected
// alternative 1: "retaining settled evidence lets an old capture satisfy
// later research"). Also exercises DEFECT 1's fix directly: dispatch A has
// ALREADY RETURNED (its own register entry is `inactive-confirmed`) while
// dispatch B is still live — A must be evaluated (and here, satisfied) on
// its own merits, not silenced by B's liveness.
// ===========================================================================

test('STALE SATISFACTION FIX: dispatch A already satisfied by an earlier finding must not let that finding silently satisfy dispatch B once B returns — the deferring Stop consumes A, preserves only B, and B is still blocked with nothing new captured', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const A_AT = '2026-06-10T11:00:00.000Z';
    const A_RETURNED_AT = '2026-06-10T11:05:00.000Z';
    const FINDING_AT = '2026-06-10T12:00:00.000Z';
    const B_AT = '2026-06-10T13:00:00.000Z';
    writeSessionEvents(dir, [aEvent('researcher', A_AT, 'sub-researcher-a'), aEvent('researcher', B_AT, 'sub-researcher-b')]);
    researchFinding(store, FINDING_AT); // satisfies A (created after A, before B)
    // A has already returned (per-dispatch evidence of its own); only B is
    // still live.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-a', 'researcher', 's1', A_RETURNED_AT), liveEntry('sub-researcher-b', 'researcher')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'A is satisfied by the finding on its own merits; B is still live — no nag either way');
    assert.doesNotMatch(out(r), /research/i, 'no research nag while B runs and A is satisfied');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('researcher', B_AT, 'sub-researcher-b')],
      'STALE-PRESERVATION SHAPE if A survives too: A is already individually satisfied by the 12:00 finding and must be CONSUMED on this deferring Stop — only the genuinely outstanding event (B) may be preserved'
    );

    // B returns; nothing new was captured after it.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-a', 'researcher', 's1', A_RETURNED_AT), endedEntry('sub-researcher-b', 'researcher')]);
    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'STALE SATISFACTION BUG if this is 0: the 12:00 finding satisfied A, not B — once B alone anchors the earliest-active-event window (13:00), the pre-existing finding (12:00) must not satisfy it'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty, now correctly unmet for B');
  } finally {
    cleanup();
  }
});

test('ALREADY-QUEUED SYNCHRONOUS RESEARCH FIX: a research_tool event already converted to research_owed must not be re-nagged on a later Stop merely because an unrelated research dispatch is still live', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation'), aEvent('researcher', R_EVENT_AT, 'sub-researcher-c')]);
    writeRegisterRaw(dir, [liveEntry('sub-researcher-c', 'researcher')]); // live across every Stop below

    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'the synchronous research_tool event is never gated — it nags on its own merit even while the dispatch stays live');
    assert.match(nag.stderr, /genesys webhook signature validation/, 'cites the query');

    const convert = stopOnce(dir);
    assert.equal(convert.code, 0, 'second Stop converts the unmet duty to research_owed and releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'exactly one research_owed minted for the synchronous event');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('researcher', R_EVENT_AT, 'sub-researcher-c')],
      'RE-NAG-BY-PRESERVATION SHAPE if the research_tool event survives too: it was just consumed by the conversion — only the still-live dispatch event may survive'
    );

    // A later, otherwise-quiet Stop with the SAME dispatch still live must not
    // resurrect a nag for the already-queued synchronous event.
    const later = stopOnce(dir);
    assert.equal(
      later.code,
      0,
      'RE-NAG SHAPE if this is 2: the synchronous event was already consumed on conversion — an unrelated still-live research dispatch must not resurrect it'
    );
    assert.equal(owed(store, 'research_owed').length, 1, 'still exactly one — no duplicate mint');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// (e) two dispatches, each with its OWN join: one returned (own evidence:
// nags), one still running (own evidence: defers). Per-dispatch semantics —
// no partial-lane assumption left to document; each event's fate is decided
// solely by its own register entry.
// ===========================================================================

test('(e) two research dispatches, one ENDED and one still presumed-active: EACH is judged on its OWN register entry, not the lane', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [aEvent('researcher', '2026-06-10T11:00:00.000Z', 'sub-researcher-1'), aEvent('claude-code-guide', '2026-06-10T11:05:00.000Z', 'sub-guide-1')]);
    writeRegisterRaw(dir, [endedEntry('sub-researcher-1', 'researcher'), liveEntry('sub-guide-1', 'claude-code-guide')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'PER-DISPATCH SEMANTICS: the returned dispatch nags on its own evidence — it is no longer silenced by the still-live sibling (the lane-wide defect this fix closes)');
    assert.match(r.stderr, /researcher/, 'the nag names the returned dispatch');
    assert.doesNotMatch(r.stderr, /claude-code-guide/, 'the still-live sibling is not named — it defers quietly on its own merits');

    const settle = stopOnce(dir);
    assert.equal(settle.code, 0, 'soft-blocked exactly once — the second Stop releases and queues the returned dispatch\'s duty');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('claude-code-guide', '2026-06-10T11:05:00.000Z', 'sub-guide-1')],
      'the still-live sibling survives to re-arm once IT returns; the returned one was already consumed into research_owed'
    );

    // The live sibling now returns too; nothing was ever captured for it.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-1', 'researcher'), endedEntry('sub-guide-1', 'claude-code-guide')]);
    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'RE-ARM SHAPE: once the sibling has returned too, its own still-unmet duty nags');
    // Same 'research' lane fingerprint as Stop 1 within the SAME session ->
    // the pre-existing once-per-session duty-nag dedup (duty-nagged.json,
    // unrelated to this fix) renders the compact 'duty(ies) unchanged' form
    // instead of repeating full per-event detail, so the sibling's name is
    // not expected to appear literally here.
    assert.match(nag.stderr, /duty\(ies\) unchanged/, 'the research lane re-arms and nags, in the compact dedup form');
    assert.match(nag.stderr, /research→/, 'the compact form still names the OPEN LANE (research), even without per-event detail');
    assert.equal(owed(store, 'research_owed').length, 1, 'exactly one research_owed so far (the first dispatch\'s)');
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
    writeSessionEvents(dir, [aEvent('researcher', R_EVENT_AT, 'sub-researcher-1')]);
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
// JOIN-KEY ROUND 2 FIXES (Sol review HIGH, board d33d8ac4): `agent_id` alone
// recurs across ROUNDS of the same dispatch (a resumed agent keeps its id)
// and across SESSIONS, and the register is not session-filtered by
// `classifyRegister`. A last-write-wins map keyed only by agent_id could join
// an event to a FOREIGN round's or FOREIGN session's row. The fix prefers an
// exact `tool_use_id` join (stamped by both H16 and H22 at launch), falls
// back to (session_id, agent_id) ONLY when that resolves to exactly one row,
// and treats every remaining ambiguous/missing case as legacy (never live,
// never no_capture-discharged).
// ===========================================================================

test('SAME AGENT_ID ACROSS ROUNDS FIX: round 1 ended, round 2 live — round 2 is joined to ITS OWN row by tool_use_id, never round 1\'s, regardless of register array order', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ROUND1_ENDED_AT = '2026-06-10T09:00:00.000Z';
    const ROUND2_EVENT_AT = '2026-06-10T10:00:00.000Z';
    const PREMATURE_NO_CAPTURE_AT = '2026-06-10T09:30:00.000Z'; // after round 1 returned — an old agent_id-only join could misread this as covering round 2
    writeSessionEvents(dir, [
      aEvent('researcher', ROUND2_EVENT_AT, 'sub-researcher-resumed', 'tu-round-2'),
      { kind: 'no_capture', detail: 'nothing seen yet', lane: 'research', at: PREMATURE_NO_CAPTURE_AT },
    ]);
    // Register array order deliberately puts round 1 (ended) AFTER round 2
    // (live) — a last-write-wins map keyed only by agent_id resolves to round
    // 1's row here; the exact tool_use_id join must not care about order.
    writeRegisterRaw(dir, [
      liveEntry('sub-researcher-resumed', 'researcher', 's1', { toolUseId: 'tu-round-2' }),
      endedEntry('sub-researcher-resumed', 'researcher', 's1', ROUND1_ENDED_AT, { toolUseId: 'tu-round-1' }),
    ]);

    const deferred = stopOnce(dir);
    assert.equal(
      deferred.code,
      0,
      'ROUND-COLLISION BUG if this is 2: round 2 is live on ITS OWN row (tool_use_id tu-round-2) and must defer quietly — never discharged or nagged off round 1\'s unrelated ended.at, and never off a no_capture declared before round 2 even existed'
    );
    assert.doesNotMatch(out(deferred), /research/i, 'no research nag at all — round 2 is correctly read as live');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('researcher', ROUND2_EVENT_AT, 'sub-researcher-resumed', 'tu-round-2')],
      'the still-live round 2 event must survive to re-arm once IT returns'
    );

    // Round 2 now ends too, with its OWN later timestamp. A no_capture
    // declared strictly BETWEEN round 1's and round 2's own return must NOT
    // discharge round 2 — only round 2's OWN ended.at can.
    const ROUND2_ENDED_AT = '2026-06-10T10:10:00.000Z';
    const MID_NO_CAPTURE_AT = '2026-06-10T09:45:00.000Z'; // after round 1's return, before round 2's own return
    writeSessionEvents(dir, [
      aEvent('researcher', ROUND2_EVENT_AT, 'sub-researcher-resumed', 'tu-round-2'),
      { kind: 'no_capture', detail: 'still nothing', lane: 'research', at: MID_NO_CAPTURE_AT },
    ]);
    writeRegisterRaw(dir, [
      endedEntry('sub-researcher-resumed', 'researcher', 's1', ROUND2_ENDED_AT, { toolUseId: 'tu-round-2' }),
      endedEntry('sub-researcher-resumed', 'researcher', 's1', ROUND1_ENDED_AT, { toolUseId: 'tu-round-1' }),
    ]);
    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'CROSS-ROUND-DISCHARGE BUG if this is 0: the no_capture at 09:45 is after round 1\'s 09:00 return but BEFORE round 2\'s OWN 10:10 return — discharging off round 1\'s evidence would silently drop round 2\'s still-unmet duty'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty, unmet for round 2 on its own evidence');
  } finally {
    cleanup();
  }
});

test('FOREIGN SESSION FIX: the SAME agent_id ended in a FOREIGN session must not discharge this session\'s event', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const EVENT_AT = '2026-06-10T09:00:00.000Z';
    const FOREIGN_ENDED_AT = '2026-06-10T09:15:00.000Z';
    const NO_CAPTURE_AT = '2026-06-10T09:30:00.000Z'; // after the FOREIGN session's own return
    writeSessionEvents(dir, [
      aEvent('researcher', EVENT_AT, 'sub-researcher-shared-id'), // no tool_use_id -> (session, agent_id) fallback
      { kind: 'no_capture', detail: 'nothing seen', lane: 'research', at: NO_CAPTURE_AT },
    ]);
    // Same agent_id, but session 's2' — a DIFFERENT session than this Stop's
    // 's1'. classifyRegister does not filter this row out of `entries`.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-shared-id', 'researcher', 's2', FOREIGN_ENDED_AT)]);

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'FOREIGN-SESSION-DISCHARGE BUG if this is 0: a same-agent_id row in ANOTHER session must never discharge this session\'s event — this event has no register row of its own in ITS session, so it stays ARMED (legacy rule)'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

test('AMBIGUOUS ROUND FIX: 2+ rounds sharing an agent_id with no tool_use_id to split them falls to the LEGACY RULE — never treated live, never discharged', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const EVENT_AT = '2026-06-10T09:00:00.000Z';
    writeSessionEvents(dir, [aEvent('researcher', EVENT_AT, 'sub-researcher-ambiguous')]); // agent_id present, no tool_use_id
    // Two rounds share this agent_id in the SAME session, neither carrying a
    // tool_use_id — the (session_id, agent_id) fallback cannot tell them
    // apart, even though one of the two IS genuinely live.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-ambiguous', 'researcher', 's1'), liveEntry('sub-researcher-ambiguous', 'researcher', 's1')]);

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'WRONGLY-JOINED-LIVE SHAPE if this is 0: with 2 rounds and nothing to split them, the event must NOT be read as live off either row — the legacy rule applies and the duty nags on its own merit'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// JOIN-KEY ROUND 3 FIX (Sol re-check HIGH, board d33d8ac4): the exact
// tool_use_id join's 0-match fallthrough to the (session_id, agent_id)
// singleton must not blindly trust a singleton row that itself carries a
// DIFFERENT, non-empty tool_use_id — that row is evidence of ANOTHER round,
// never this event's own. A 2+-exact-match hit must also refuse straight to
// legacy, never fall through. Only a singleton row with NO usable
// tool_use_id (null/empty — the 'resume'/'unattributable' Start shape, since
// a SendMessage resume creates no new H16 event and H22 records it with
// tool_use_id null) is a legitimate fallback join.
// ===========================================================================

test("MISMATCHED TOOL_USE_ID FIX: event tool_use_id X, the sole same-session/same-agent row carries a DIFFERENT tool_use_id Y and is ended — must NOT be discharged (legacy rule, not the row's ended.at)", () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const EVENT_AT = '2026-06-10T09:00:00.000Z';
    const ROW_ENDED_AT = '2026-06-10T09:15:00.000Z';
    const NO_CAPTURE_AT = '2026-06-10T09:30:00.000Z'; // after the OTHER round's return
    writeSessionEvents(dir, [
      aEvent('researcher', EVENT_AT, 'sub-researcher-mismatch', 'tu-X'),
      { kind: 'no_capture', detail: 'nothing seen', lane: 'research', at: NO_CAPTURE_AT },
    ]);
    // Same session, same agent_id, but a DIFFERENT tool_use_id (Y) — evidence
    // of another round, not this event's own.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-mismatch', 'researcher', 's1', ROW_ENDED_AT, { toolUseId: 'tu-Y' })]);

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      "WRONG-ROUND-DISCHARGE BUG if this is 0: the singleton row's tool_use_id (tu-Y) differs from the event's own (tu-X) — it must never be accepted as this event's row, so the event stays ARMED (legacy rule) rather than being discharged off tu-Y's ended.at"
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

test('DUPLICATE TOOL_USE_ID FIX: two rows sharing the exact SAME tool_use_id refuses straight to the legacy rule, never falls through to the agent_id fallback', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const EVENT_AT = '2026-06-10T09:00:00.000Z';
    writeSessionEvents(dir, [aEvent('researcher', EVENT_AT, 'sub-researcher-dup', 'tu-dup')]);
    // Corrupt/impossible shape: 2 rows carry the SAME tool_use_id. One is
    // live — a fall-through to the agent_id singleton fallback would find
    // 2 rows too (ambiguous, correctly legacy either way), but this pins
    // that the EXACT-MATCH branch itself refuses immediately rather than
    // ever reaching the fallback.
    writeRegisterRaw(dir, [
      liveEntry('sub-researcher-dup', 'researcher', 's1', { toolUseId: 'tu-dup' }),
      endedEntry('sub-researcher-dup', 'researcher', 's1', undefined, { toolUseId: 'tu-dup' }),
    ]);

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'FALSE-LIVE-BUG if this is 0: 2 exact tool_use_id matches is corruption — never trusted, straight to the legacy rule; the event must not be read as live off either row'
    );
    assert.match(nag.stderr, /research/i, 'the nag is the research duty');
  } finally {
    cleanup();
  }
});

test("RESUME SINGLETON FIX (Sol-confirmed): event carries tool_use_id X, the sole same-session/same-agent row's tool_use_id is null (a genuine SendMessage resume, source 'resume') — the singleton fallback is still used", () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [aEvent('researcher', R_EVENT_AT, 'sub-researcher-resume-null', 'tu-X')]);
    // H22 records a 'resume' Start with tool_use_id: null (no fresh Pre/Post
    // binding to attribute) — liveEntry's default (toolUseId omitted) is
    // exactly that shape.
    writeRegisterRaw(dir, [liveEntry('sub-researcher-resume-null', 'researcher')]);

    const r = stopOnce(dir);
    assert.equal(
      r.code,
      0,
      'RESUME-SINGLETON BUG if this is 2: the sole row has NO usable tool_use_id of its own (the legitimate resume shape) — the (session_id, agent_id) singleton fallback must still apply and read it as live'
    );
    assert.doesNotMatch(out(r), /research/i, 'no research nag — the resumed dispatch is correctly read as live');
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
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation'), aEvent('researcher', R_EVENT_AT, 'sub-researcher-1')]);
    writeRegisterRaw(dir, []);

    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'CONTROL BROKEN: with no live register entry the pre-existing research duty must still nag immediately');
    assert.match(nag.stderr, /genesys webhook signature validation/, 'CONTROL BROKEN: the research_tool query is cited, unaffected by the gate');
    assert.match(nag.stderr, /researcher/, 'CONTROL BROKEN: the agent_dispatch detail is cited too');
  } finally {
    cleanup();
  }
});
