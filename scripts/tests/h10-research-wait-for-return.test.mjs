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
// endedAt defaults to real-now (agoISO(0)) — fine for every test that never
// compares it against a fictional no_capture declaration timestamp. A test
// that DOES (the return-anchored discharge fixture below) passes an explicit
// fictional endedAt so the two timelines line up.
const endedEntry = (agentId, agentType, sessionId = 's1', endedAt = agoISO(0)) => ({
  ...liveEntry(agentId, agentType, sessionId),
  ended: { at: endedAt, event: 'subagent-stop' }, // A1: H22 marks ended, never deletes
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
    const returnedAt = '2026-06-10T11:15:00.000Z'; // the dispatch returned BEFORE the declaration
    const noCaptureAt = '2026-06-10T11:30:00.000Z'; // declared after the event AND after the return, so it legitimately discharges it
    writeSessionEvents(dir, [aEvent('researcher'), { kind: 'no_capture', detail: 'nothing durable from this scout', lane: 'research', at: noCaptureAt }]);
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
    writeSessionEvents(dir, [aEvent('researcher', DISPATCH_AT), { kind: 'no_capture', detail: 'nothing seen so far', lane: 'research', at: NO_CAPTURE_AT }]);
    writeRegisterRaw(dir, [liveEntry('sub-researcher-live', 'researcher')]); // still live when the declaration was made

    const deferred = stopOnce(dir);
    assert.equal(deferred.code, 0, 'still live — the lane defers quietly');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('researcher', DISPATCH_AT)],
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
    writeSessionEvents(dir, [aEvent('researcher', DISPATCH_AT), { kind: 'no_capture', detail: 'nothing durable', lane: 'research', at: NO_CAPTURE_AT }]);
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
// 7f9f0b5): when an agent_dispatch's register entry carries no valid
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
    writeSessionEvents(dir, [aEvent('researcher', DISPATCH_AT), { kind: 'no_capture', detail: 'nothing seen so far', lane: 'research', at: NO_CAPTURE_AT }]);
    // 90 real minutes old (past the default 60-minute lease) and NEVER ended —
    // classifyRegister reads this as 'unknown', not 'presumed-active' and not
    // 'inactive-confirmed': no valid return evidence exists at all.
    writeRegisterRaw(dir, [{ agent_id: 'sub-researcher-stale', agent_type: 'researcher', session_id: 's1', files: [], at: agoISO(90) }]);

    const nag = stopOnce(dir);
    assert.equal(
      nag.code,
      2,
      'FALLBACK-TO-DISPATCH-TIME SHAPE if this is 0: no `ended.at` exists anywhere in the register, so the declaration has nothing valid to anchor against — falling back to the event\'s own (always-earlier) dispatch time would silently discharge it exactly like the original bug'
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
    writeSessionEvents(dir, [aEvent('researcher', DISPATCH_AT), { kind: 'no_capture', detail: 'nothing seen so far', lane: 'research', at: NO_CAPTURE_AT }]);
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
// STALE SATISFACTION FIX (Sol review, HIGH found on commit 5306735): a
// research event that is already INDIVIDUALLY satisfied by an earlier finding
// must be consumed on the deferring Stop that discovers it, exactly as a
// non-deferring Stop would consume it — never carried alongside a genuinely
// outstanding sibling event, or the group's earliest-active-event anchor gets
// dragged back to the settled event's stale timestamp once the live dispatch
// returns and the gate lifts, letting the earlier finding silently satisfy
// the later, still-outstanding dispatch (decision b2474b26's rejected
// alternative 1: "retaining settled evidence lets an old capture satisfy
// later research").
// ===========================================================================

test('STALE SATISFACTION FIX: dispatch A already satisfied by an earlier finding must not let that finding silently satisfy dispatch B once B returns — the deferring Stop consumes A, preserves only B, and B is still blocked with nothing new captured', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const A_AT = '2026-06-10T11:00:00.000Z';
    const FINDING_AT = '2026-06-10T12:00:00.000Z';
    const B_AT = '2026-06-10T13:00:00.000Z';
    writeSessionEvents(dir, [aEvent('researcher', A_AT), aEvent('researcher', B_AT)]);
    researchFinding(store, FINDING_AT); // satisfies A (created after A, before B)
    writeRegisterRaw(dir, [liveEntry('sub-researcher-b', 'researcher')]); // only B is still live

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'B is still live — the whole lane defers, no nag');
    assert.doesNotMatch(out(r), /research/i, 'no research nag while B runs');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('researcher', B_AT)],
      'STALE-PRESERVATION SHAPE if A survives too: A is already individually satisfied by the 12:00 finding and must be CONSUMED on this deferring Stop — only the genuinely outstanding event (B) may be preserved'
    );

    // B returns; nothing new was captured after it.
    writeRegisterRaw(dir, [endedEntry('sub-researcher-b', 'researcher')]);
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
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation'), aEvent('researcher')]);
    writeRegisterRaw(dir, [liveEntry('sub-researcher-c', 'researcher')]); // live across every Stop below

    const nag = stopOnce(dir);
    assert.equal(nag.code, 2, 'the synchronous research_tool event is never gated — it nags on its own merit even while the dispatch stays live');
    assert.match(nag.stderr, /genesys webhook signature validation/, 'cites the query');

    const convert = stopOnce(dir);
    assert.equal(convert.code, 0, 'second Stop converts the unmet duty to research_owed and releases');
    assert.equal(owed(store, 'research_owed').length, 1, 'exactly one research_owed minted for the synchronous event');
    assert.deepEqual(
      readSessionEvents(dir),
      [aEvent('researcher')],
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
