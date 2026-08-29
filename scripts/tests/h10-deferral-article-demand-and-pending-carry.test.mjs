// H10 SPEC-ONLY tests for TWO PAIRED DEFECTS (boards cdaf2824 + cb457cbd,
// objective consumer-feedback-2026-08-28). Both have ONE root cause: H10
// maintains live-dispatch state and does not consult it everywhere it should.
//
// NEW SIBLING FILE by established precedent: scripts/tests/hooks-full.test.mjs,
// scripts/tests/h22-dispatch-register.test.mjs and the h10-*.test.mjs siblings
// stay FROZEN and unedited; they duplicate harness/fixture helpers rather than
// importing one test file as a module (importing would double-run its
// registered `test()` calls). The harness below is copied verbatim in shape
// from h22-dispatch-register.test.mjs, which owns the H10-deferral fixtures.
//
// ---------------------------------------------------------------------------
// SPEC (from the store, NOT from reading the hook — this author holds a read
// wall over implementation):
//
// AC18 of feature_article h10-direct-capture-gate (1e1544e3, v101), verbatim:
//   "FAN-OUT-AWARE DEFERRAL (decision ec9eacaa): touched files owned by a LIVE
//    H22 register entry (same session_id, 0 <= age < config.dispatch_register.
//    stale_minutes) are excluded from the capture trigger set AND THE
//    ARTICLE-DEMAND UNOWNED SET; ... duties re-arm on the first Stop after the
//    entry is gone; a non-deferred file's duty still fires"
// The same article's what_it_does repeats it: "...EXCLUDED from the capture-duty
// trigger set ... and from the article-demand unowned set", and adds "research
// and concept duties are untouched".
//
// Decision ec9eacaa REJECTED the alternative "Defer research/concept duties too
// when any dispatch is live", reason: "Those duties are file-less and keyed to
// conductor-registered events ... a live dispatch owns files, not the
// conductor's own research/design debts; muting them would widen the deferral
// past what the defect evidence supports." => THE CONCEPT DEMAND IS NOT
// DEFERRED. That is a settled ruling, so C0/C1 below pin it as behaviour that
// must SURVIVE the defect-1 fix, rather than documenting an open question.
//
// AC14 + decision bd594c03: capture_pending covers touches/debug events before
// AND after the declaration; first pending Stop allows WITHOUT clearing the
// registers; second pending Stop converts to exactly ONE deduped capture_owed
// citing the target, then clears. Board cb457cbd narrows this: WHILE THE NAMED
// TARGET IS STILL A LIVE DISPATCH the declaration is CARRIED across Stops
// instead of converting; it re-arms when the target lands; and — the anti-drift
// property that makes the change safe — after the target lands a still-pending
// duty must STILL become exactly one deduped capture_owed. A pending
// declaration can never quietly evaporate (P5).
//
// ---------------------------------------------------------------------------
// EXECUTION DISCLOSURE: this role holds no Bash by design (H4 read wall), so
// NONE of these tests were run. Each assertion's message states the exact
// failure shape it produces, and the dispatch report names the one-line
// sabotage that must turn each pin red.
//
// JUDGEMENT CALLS, disclosed because the design is silent (see the report):
//  (a) HOW the hook decides a capture_pending target "is still a live
//      dispatch" is unspecified (agent_id? agent_type? any live entry?). The
//      P-tests therefore write a detail string containing the agent_id, the
//      agent_type AND the entry's declared file, so EVERY plausible matching
//      rule matches — the oracle pins the BEHAVIOUR, never a matching rule it
//      would have had to invent.
//  (b) Whether the mint lands on the FIRST or the SECOND Stop after the target
//      lands is not stated (the pre-existing two-Stop grace could legitimately
//      restart). P2 therefore pins the property that matters and is stated —
//      "exactly one, bounded, never evaporating" — inside a bounded 2-Stop
//      window, and separately pins that it never mints twice.
//  (c) The article says a deferring release preserves touches.json/
//      session-events.json "when anything is deferred" (non-terminal), which
//      makes the TERMINAL behaviour of a PARTIAL deferral ambiguous. A1/A2
//      therefore assert only the FIRST Stop, where the spec is unambiguous;
//      the re-arm direction is pinned by A0 (empty register => the same path is
//      demanded again), which is also A1's control arm.

import { test, before } from 'node:test';
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
const CAPTURE_AT = '2026-06-10T13:00:00.000Z';
const PENDING_AT = '2026-06-10T12:30:00.000Z';

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

// The spec pins WHAT is disclosed (deferred count + owning agent_ids), not
// which stream carries it — checking the union avoids anchoring the oracle to
// an unstated delivery channel (same helper the h22 suite uses).
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

// Defaults are deliberately NOT overridden: article_demand.min_unowned_files
// defaults to 3 and dispatch_register.stale_minutes to 60, which is what the
// existing frozen suites rely on. Fixtures below are sized against those
// defaults and say so at each use site.
const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-defer-'));
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

// ------------------------------- registers ---------------------------------

const touchesPath = (dir) => join(dir, '.sterling', 'transient', 'touches.json');
const eventsPath = (dir) => join(dir, '.sterling', 'transient', 'session-events.json');
const registerPath = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');

function touchRegister(dir, paths, at = NOW) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n'); // H10 acts only on files that still exist
  }
  writeFileSync(touchesPath(dir), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function writeSessionEvents(dir, events) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(eventsPath(dir), JSON.stringify(events));
}

function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), typeof content === 'string' ? content : JSON.stringify(content));
}

const readRegister = (dir) => JSON.parse(readFileSync(registerPath(dir), 'utf8'));

const agoISO = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const liveEntry = (agentId, files, agentType = 'coder', sessionId = 's1') => ({
  agent_id: agentId,
  agent_type: agentType,
  session_id: sessionId,
  files,
  at: agoISO(0),
});

const cpEvent = (detail, at = PENDING_AT) => ({ kind: 'capture_pending', detail, at });
const conceptEvent = (family, at = NOW) => ({ kind: 'concept_designed', detail: family, at });

function captureDecision(store, at = CAPTURE_AT) {
  store.create({ ...envelope('decision', at), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
}

const owed = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === reason);
const articleMissing = (store) => owed(store, 'article_missing');
const captureOwed = (store) => owed(store, 'capture_owed');

// ===========================================================================
// DEFECT 1 — board cdaf2824: the ARTICLE DEMAND must subtract the very paths
// the same Stop message defers to a live dispatch.
//
// Fixture geometry (all four files unowned, capture satisfied so ONLY the
// article demand can speak): 4 unowned touched files against the default
// threshold of 3. A0 (no live entry) => all 4 demanded. A1 (one live entry
// owning ALPHA) => the remaining 3 still hit the threshold, so the demand
// still fires and the ONLY observable difference is that ALPHA is gone from
// it. A2 (a live entry owning two of them) => the subtracted set is 2, under
// the threshold, so nothing demands at all.
// ===========================================================================

const ALPHA = 'src/fanout/alpha.mjs';
const BETA = 'src/fanout/beta.mjs';
const GAMMA = 'src/fanout/gamma.mjs';
const DELTA = 'src/fanout/delta.mjs';

test('A0 (CONTROL, must pass for the OPPOSITE reason — placed first): with an EMPTY dispatch register the SAME four unowned files DO raise the article demand, and ALPHA is named in it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [ALPHA, BETA, GAMMA, DELTA]);
    captureDecision(store); // capture duty satisfied — the article demand is the only duty that can fire
    writeRegisterRaw(dir, []); // nothing in flight

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'CONTROL BROKEN if this is not 2: four unowned touched files at the default threshold of 3 must raise the demand — if this fixture cannot demand at all, A1/A2 prove nothing');
    assert.match(r.stderr, /article demand/i, 'CONTROL BROKEN: the demand text itself must appear');
    for (const p of [ALPHA, BETA, GAMMA, DELTA]) {
      assert.match(r.stderr, new RegExp(p.replace(/[.]/g, '\\.')), `CONTROL BROKEN: ${p} must be named when NOTHING is deferred — this is what makes A1's absence of ALPHA attributable to the deferral and to nothing else about that path`);
    }
    // Format-independent: with an empty register no agent_id can possibly be
    // disclosed, so this proves "nothing was deferred here" without pinning any
    // wording (the word "deferred" also occurs in article-demand prose).
    assert.doesNotMatch(out(r), /sub-alpha/, 'CONTROL BROKEN: no owning agent may be disclosed when the register is empty');
    assert.equal(articleMissing(store).length, 0, 'the first Stop nags, it does not yet mint (unchanged cadence)');
  } finally {
    cleanup();
  }
});

test('A1 (DEFECT 1, RED at HEAD): a path deferred to a LIVE dispatch is SUBTRACTED from the article demand — one Stop message can never both defer a file and demand its article', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [ALPHA, BETA, GAMMA, DELTA]);
    captureDecision(store);
    const entry = liveEntry('sub-alpha', [ALPHA], 'test-writer');
    writeRegisterRaw(dir, [entry]);

    const r = stopOnce(dir);

    // The deferral half of the message — unchanged, and the reason A1's other
    // half is a self-contradiction rather than a mere omission.
    assert.match(out(r), /defer/i, 'the release still discloses the deferral');
    assert.match(out(r), /sub-alpha/, 'the disclosure still names the owning agent_id');

    assert.equal(r.code, 2, 'the three NON-deferred unowned files still hit the threshold — the deferral must narrow the demand, never mute a duty another file legitimately owes');
    assert.match(r.stderr, /article demand/i, 'the demand for the non-deferred remainder still fires');
    // Whole-stderr negative is safe: the deferral disclosure prints a COUNT and
    // agent_ids, never paths — AC18 ("count + owning agent_id(s)"), the frozen
    // h22 suite, and the HEAD output quoted on board cdaf2824 ("deferred: 4
    // file(s) owned by live dispatch(es) [a773cd38…]") all agree. So ALPHA
    // appearing anywhere in the demand output means the DEMAND named it.
    assert.doesNotMatch(
      r.stderr,
      new RegExp(ALPHA.replace(/[.]/g, '\\.')),
      'DEFECT 1 SHAPE (this is the assertion that is RED at HEAD): the same Stop message named ALPHA as deferred to a live dispatch AND demanded an owning article for it — `unowned` is filtered by ownership only and never subtracts `deferredPaths`'
    );
    for (const p of [BETA, GAMMA, DELTA]) {
      assert.match(r.stderr, new RegExp(p.replace(/[.]/g, '\\.')), `OVER-SUBTRACTION SHAPE if this fires: ${p} is owned by NO live entry and must stay in the demand — the fix must subtract the deferred paths, not collapse the demand whenever anything is deferred`);
    }
    assert.deepEqual(readRegister(dir), [entry], 'H10 never mutates the dispatch register — that is H22 territory');
  } finally {
    cleanup();
  }
});

test('A2 (DEFECT 1, RED at HEAD): the THRESHOLD counts the SUBTRACTED set — two deferred + two non-deferred unowned files is 2 unowned, under the default threshold of 3, so nothing demands and nothing is minted', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [ALPHA, BETA, GAMMA, DELTA]);
    captureDecision(store);
    writeRegisterRaw(dir, [liveEntry('sub-alpha', [ALPHA], 'test-writer'), liveEntry('sub-beta', [BETA], 'coder')]);

    const r = stopOnce(dir);
    assert.equal(
      r.code,
      0,
      'DEFECT 1 SHAPE (RED at HEAD, fires as 2): with ALPHA and BETA deferred, only GAMMA and DELTA are genuinely unowned-and-undeferred — 2 is under the default threshold of 3, so the demand must not fire at all. At HEAD the unsubtracted count is 4 and it fires.'
    );
    assert.doesNotMatch(out(r), /article demand/i, 'no demand text at all — a sub-threshold set is not a demand');
    assert.match(out(r), /defer/i, 'the deferral is still disclosed on the release (silence would be a different defect)');
    assert.equal(articleMissing(store).length, 0, 'and nothing is minted for territory that is still being authored');
    assert.equal(existsSync(touchesPath(dir)), true, 'a deferring release is non-terminal — touches.json survives so the duty re-arms when the dispatches land');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// CONCEPT DEMAND — decision ec9eacaa's REJECTED alternative settles this: the
// file-less duties are NOT deferred. C0 is C1's control arm: same fixture,
// concept event removed, so C1's exit 2 can only be caused by the concept duty.
// Both are expected GREEN at HEAD; they exist to stop the defect-1 fix from
// over-reaching into a duty the decision deliberately left armed.
// ===========================================================================

const CFILE = 'src/fanout/concept-lane.mjs';
const FAMILY = 'gizmo-transport';

test('C0 (CONTROL for C1 — placed first): the same wholly-deferred fixture WITHOUT a concept_designed event is silent (exit 0), so C1 exit 2 is attributable to the concept duty alone', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [CFILE]);
    captureDecision(store);
    writeRegisterRaw(dir, [liveEntry('sub-concept', [CFILE], 'coder')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'CONTROL BROKEN if this is not 0: the sole touched file is deferred and the capture duty is satisfied — nothing may block');
    assert.match(out(r), /defer/i, 'CONTROL BROKEN: the deferral is disclosed');
    assert.equal(owed(store, 'concept_article_missing').length, 0, 'no concept duty exists in this arm');
  } finally {
    cleanup();
  }
});

test('C1: a concept_designed duty is NOT deferred by a live dispatch — the file-less duty still fires while every touched file is deferred (decision ec9eacaa rejected deferring research/concept duties)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [CFILE]);
    captureDecision(store); // satisfies capture, does NOT satisfy the concept duty
    writeSessionEvents(dir, [conceptEvent(FAMILY)]);
    writeRegisterRaw(dir, [liveEntry('sub-concept', [CFILE], 'coder')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'OVER-DEFERRAL SHAPE if this fires as 0: a live dispatch owns FILES, never the conductor\'s own settled-design debt — muting the concept demand widens the deferral past what decision ec9eacaa allows');
    assert.match(r.stderr, new RegExp(FAMILY), 'the nag names the family whose concept article is missing');
    assert.doesNotMatch(r.stderr, /nothing was captured/, 'the capture duty is satisfied — the concept duty, not the capture duty, is what fired');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DEFECT 2 — board cb457cbd: while a capture_pending's named target is STILL a
// live dispatch, the declaration is CARRIED across Stops instead of converting
// to debt; it re-arms when the target lands, and a still-pending duty then
// still becomes exactly ONE deduped capture_owed.
//
// Fixture geometry: the touched file is deliberately NOT in the live entry's
// `files`, so the fan-out file deferral cannot be what defers it — only the
// capture_pending declaration can. One unowned touched file is under the
// article-demand threshold, and there are no research/concept events, so the
// capture lane is the only lane in play.
//
// Matching-rule robustness (judgement call (a) in the header): PENDING_DETAIL
// contains the agent_id, the agent_type and the entry's declared file, so any
// plausible "is the named target still live?" rule matches.
// ===========================================================================

const WORKFILE = 'src/pending/work.mjs';
const LANE_FILE = 'packages/store/src/librarian-lane.mjs';
const PENDING_DETAIL = 'librarian sub-lib-1 (agent_id sub-lib-1, agent_type librarian, files packages/store/src/librarian-lane.mjs) — article appends in flight';
const lanePending = () => liveEntry('sub-lib-1', [LANE_FILE], 'librarian');

test('P0 (CONTROL, must pass for the OPPOSITE reason — placed first): with NO live dispatch at all, capture_pending still converts on the SECOND Stop to exactly one capture_owed citing the target, and clears', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(PENDING_DETAIL)]);
    writeRegisterRaw(dir, []); // the named target is NOT live

    const first = stopOnce(dir);
    assert.equal(first.code, 0, 'CONTROL BROKEN: the first pending Stop defers');
    assert.equal(captureOwed(store).length, 0, 'CONTROL BROKEN: no debt on the first pending Stop');
    assert.equal(existsSync(touchesPath(dir)), true, 'CONTROL BROKEN: the first pending release is non-terminal');

    const second = stopOnce(dir);
    assert.equal(second.code, 0, 'CONTROL BROKEN: the second pending Stop releases');
    const items = captureOwed(store);
    assert.equal(items.length, 1, 'CONTROL BROKEN if this is not 1: with nothing live the unchanged two-Stop cadence must still mint the debt — this is what proves a GREEN in P1 is caused by liveness and not by a fixture that can never mint anything');
    assert.match(items[0].text, /sub-lib-1/, 'CONTROL BROKEN: the minted item cites the pending target so a drain can verify it landed');
    assert.equal(existsSync(touchesPath(dir)), false, 'CONTROL BROKEN: the conversion IS terminal — registers clear together (P4)');
    assert.equal(existsSync(eventsPath(dir)), false);
  } finally {
    cleanup();
  }
});

test('P1 (DEFECT 2, RED at HEAD): while the named target is STILL a live dispatch the capture_pending declaration is CARRIED across Stops — three Stops, no re-declaration, no debt, registers preserved', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(PENDING_DETAIL)]);
    writeRegisterRaw(dir, [lanePending()]); // the named target IS live, and stays live across all three Stops

    const first = stopOnce(dir);
    assert.equal(first.code, 0, 'the first pending Stop defers, exactly as today');
    assert.equal(captureOwed(store).length, 0, 'no debt on the first pending Stop');

    const second = stopOnce(dir);
    assert.equal(second.code, 0, 'still released, never trapped (P1)');
    assert.equal(
      captureOwed(store).length,
      0,
      'DEFECT 2 SHAPE (this is the assertion that is RED at HEAD, firing as 1 !== 0): the target named by the declaration is STILL a live dispatch, so the declaration must be carried, not converted to debt — at HEAD the register survives exactly one Stop and the conductor must re-type an unchanged declaration'
    );
    assert.equal(existsSync(eventsPath(dir)), true, 'the carried declaration must SURVIVE on disk — a cleared session-events.json is exactly what forces the manual re-declaration this closes');
    assert.equal(existsSync(touchesPath(dir)), true, 'the carry is non-terminal — touches.json survives so a landed write can still settle the duty cleanly');

    const third = stopOnce(dir);
    assert.equal(third.code, 0, 'a long-running lane never traps the session');
    assert.equal(captureOwed(store).length, 0, 'CARRY-IS-ONLY-ONE-EXTRA-GRACE SHAPE if this fires as 1: the carry is bounded by the TARGET\'s liveness, not by a fixed Stop count — while the dispatch is live the declaration keeps holding');
    assert.deepEqual(readRegister(dir).map((e) => e.agent_id), ['sub-lib-1'], 'H10 never mutates the dispatch register');
  } finally {
    cleanup();
  }
});

test('P2 (ANTI-DRIFT — the property that makes the carry safe): once the named target LANDS, a still-pending duty still becomes exactly ONE deduped capture_owed citing the target — a pending declaration can never quietly evaporate', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(PENDING_DETAIL)]);
    writeRegisterRaw(dir, [lanePending()]);

    assert.equal(stopOnce(dir).code, 0, 'carried while live');
    assert.equal(captureOwed(store).length, 0, 'no debt while the target is live');

    writeRegisterRaw(dir, []); // the named dispatch LANDS; nothing was ever captured

    // The spec states the duty re-arms and converts; it does NOT state whether
    // the pre-existing two-Stop grace restarts, so the window is bounded at two
    // Stops rather than pinned to one (judgement call (b), disclosed).
    const codes = [];
    let items = [];
    for (let i = 0; i < 2 && items.length === 0; i++) {
      codes.push(stopOnce(dir).code);
      items = captureOwed(store);
    }
    assert.equal(
      items.length,
      1,
      `EVAPORATION SHAPE (the drift this fix must not introduce): after the named target landed with nothing captured, the pending duty must convert to exactly one capture_owed within two Stops — got ${items.length} after Stops [${codes.join(', ')}]. A carry that outlives its target is silent knowledge loss (P5).`
    );
    assert.match(items[0].text, /sub-lib-1/, 'the minted item still cites the pending target, so a drain can verify whether it landed');
    assert.equal(codes[codes.length - 1], 0, 'the converting Stop releases the session');
    assert.equal(existsSync(touchesPath(dir)), false, 'the conversion IS terminal — registers clear together (P4)');
    assert.equal(existsSync(eventsPath(dir)), false, 'including the carried declaration itself');

    stopOnce(dir);
    assert.equal(captureOwed(store).length, 1, 'DUPLICATION SHAPE if this exceeds 1: the debt is minted exactly once and deduped, however many Stops the carry spanned');
  } finally {
    cleanup();
  }
});

test('P3 (ZERO-QUEUE-NOISE, unchanged by the carry): a capture landing WHILE the named target is still live settles the duty terminally — no debt, registers cleared', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(PENDING_DETAIL)]);
    writeRegisterRaw(dir, [lanePending()]);

    assert.equal(stopOnce(dir).code, 0, 'carried while live');
    captureDecision(store); // the in-flight capture lands, target still running

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'released');
    assert.equal(captureOwed(store).length, 0, 'REGRESSION SHAPE if this is 1: the landed write PAID the duty — carrying the declaration must never convert a satisfied duty into queue noise (the whole reason the registers survive a deferral)');
    assert.equal(existsSync(eventsPath(dir)), false, 'STUCK-CARRY SHAPE if this is true: a SATISFIED duty is terminal — the carry may outlive a Stop, never its own satisfaction (AC6: all terminal H10 paths clear the registers together)');
    assert.equal(existsSync(touchesPath(dir)), false);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// DEFECT 3 — TARGET IMPERSONATION in the capture_pending carry. Raised by an
// outside-family review (Codex, gpt-5.2) at CRITICAL against the carry as
// currently built; P1/P2 above CANNOT see it, and the review said exactly why:
// P2 lands the target by emptying the ENTIRE dispatch register, so no
// unrelated dispatch ever survives beside the landed target. The real failure
// needs one to survive.
//
// THE PROPERTY, stated exactly (anti-drift; this is what makes the carry safe
// at all — AC14 + decision bd594c03 + board cb457cbd, P5):
//   once the NAMED TARGET lands, a still-pending duty becomes exactly ONE
//   deduped capture_owed citing the target, EVEN IF OTHER DISPATCHES ARE STILL
//   LIVE.
// Liveness of SOME dispatch is not liveness of THE TARGET. Replace long-lived
// lanes faster than their TTLs expire and a declaration whose target landed
// hours ago is carried forever while the real duty silently evaporates — the
// exact knowledge loss the two-Stop conversion exists to prevent.
//
// WRITTEN AGAINST BEHAVIOUR, NOT MECHANISM. Every assertion below is either
// "the target landed => the duty converts" or "the target is live => the duty
// is carried". No arm asserts HOW a declaration names its target, so a
// structural fix (e.g. recording an exact agent_id at declare time instead of
// grepping prose) leaves the oracle intact. The one unavoidable mechanism
// touch is fixture CONSTRUCTION — a declaration has to be written somehow — so
// it is isolated in the single helper `pendingDetail()` below, which
// reproduces the prose shape of the frozen PENDING_DETAIL constant used by
// P0-P3. If a fix changes how a declaration records its target, that helper is
// the ONLY line in this block to update (P0-P3 carry the same dependency in
// their own constant, so the fragility is shared, not introduced here).
//
// FIXTURE GEOMETRY, constant across all four arms: exactly one touched file
// (WORKFILE), owned by NO live entry in any arm, so (a) the capture duty is
// genuinely armed and cannot be muted by the fan-out FILE deferral, and (b)
// one unowned file is under the default article-demand threshold of 3, leaving
// the capture lane the only lane that can speak. Every surviving entry's
// declared files are disjoint from the touched set, deliberately.
// ===========================================================================

const pendingDetail = ({ agentId, agentType, files, reason }) =>
  `${agentType} ${agentId} (agent_id ${agentId}, agent_type ${agentType}, files ${files.join(', ')}) — ${reason}`;

// Bounded window, the SAME size P2 uses and for the same reason: the spec
// states the duty re-arms and converts once the target lands, but not whether
// the pre-existing two-Stop grace restarts (judgement call (b) in the header),
// so allow at most two Stops and report the codes in the failure message.
function stopsUntilOwed(dir, store, max = 2) {
  const codes = [];
  let items = captureOwed(store);
  for (let i = 0; i < max && items.length === 0; i += 1) {
    codes.push(stopOnce(dir).code);
    items = captureOwed(store);
  }
  return { codes, items };
}

// --- P4 family fixtures. Each arm isolates ONE impersonation vector, because
// the review names all three register keys as broken and a fix that hardens
// only one leaves the others live.
const TARGET_LANE_FILE = 'src/pending/target-lane.mjs';
const OTHER_LANE_FILE = 'src/unrelated/other.mjs';
// agent_id "sub-target" is neither a substring of "sub-other" nor vice versa,
// and no declared path is shared, so agent_type is the ONLY key that can
// impersonate here.
const TYPE_DETAIL = pendingDetail({
  agentId: 'sub-target',
  agentType: 'coder',
  files: [TARGET_LANE_FILE],
  reason: 'capture auth findings',
});
const typeTarget = () => liveEntry('sub-target', [TARGET_LANE_FILE], 'coder');
const typeOther = () => liveEntry('sub-other', [OTHER_LANE_FILE], 'coder');

test('P4-CONTROL (must pass for the OPPOSITE reason — placed FIRST among the impersonation arms): while the named target is GENUINELY still live BESIDE an unrelated live dispatch, the declaration is still CARRIED — no debt across the same two-Stop window P4/P4b/P4c convert in', () => {
  // WITHOUT THIS ARM the whole P4 family is satisfiable by an implementation
  // that converts UNCONDITIONALLY — which passes P4, P4b and P4c identically
  // while destroying the carry feature. This is the most important arm here:
  // the P4 verdict "debt was minted" has more than one possible cause, and
  // this is the arm that discriminates them.
  // SABOTAGE that must turn THIS red: make the target-liveness test always say
  // "gone" (`return false` at the top of the liveness helper, or drop the
  // liveness guard from the carry branch) — i.e. convert-always.
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(TYPE_DETAIL)]);
    writeRegisterRaw(dir, [typeTarget(), typeOther()]); // target LIVE, plus an unrelated lane

    const { codes, items } = stopsUntilOwed(dir, store);
    assert.equal(
      items.length,
      0,
      `CONTROL BROKEN if this is 1 — CONVERT-ALWAYS SHAPE: the named target sub-target is live in the register on every Stop, so the declaration must be carried, never converted. A conversion here means the fix stopped consulting the target's liveness at all, and P4/P4b/P4c below would then be green for a reason that has nothing to do with impersonation. Codes: [${codes.join(', ')}]`
    );
    assert.deepEqual(codes, [0, 0], 'CONTROL BROKEN: a carried declaration releases the session on every Stop, never traps it (P1)');
    assert.equal(existsSync(eventsPath(dir)), true, 'CONTROL BROKEN: the carried declaration survives on disk — a cleared session-events.json is the manual re-declaration this feature closes');
    assert.equal(existsSync(touchesPath(dir)), true, 'CONTROL BROKEN: the carry is non-terminal, so a landed write can still settle the duty cleanly');
    assert.deepEqual(readRegister(dir).map((e) => e.agent_id), ['sub-target', 'sub-other'], 'CONTROL BROKEN: H10 never mutates the dispatch register — that is H22 territory');
  } finally {
    cleanup();
  }
});

test('P4 (DEFECT 3, RED as built — the CRITICAL arm): once the NAMED TARGET lands, the duty converts to exactly ONE deduped capture_owed citing it, even though an unrelated dispatch of the SAME agent_type is still live', () => {
  // SABOTAGE that must turn this red: decide target liveness by substring —
  // `entries.some((e) => detail.includes(e.agent_type))` — i.e. the
  // implementation as reviewed.
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(TYPE_DETAIL)]);
    writeRegisterRaw(dir, [typeTarget(), typeOther()]);

    // Precondition, implementation-neutral (a first pending Stop is a grace
    // under the old cadence AND a carry under the new one): released, no debt.
    assert.equal(stopOnce(dir).code, 0, 'PRECONDITION: the first pending Stop releases');
    assert.equal(captureOwed(store).length, 0, 'PRECONDITION: no debt while the target is live');

    // The TARGET lands. The unrelated coder lane stays live and keeps its type.
    writeRegisterRaw(dir, [typeOther()]);

    const { codes, items } = stopsUntilOwed(dir, store);
    assert.equal(
      items.length,
      1,
      `IMPERSONATION SHAPE (this is the assertion that is RED as built, firing as 0 !== 1): sub-target LANDED and nothing was captured, so the pending duty must convert within two Stops. An unrelated live entry that merely SHARES the target's agent_type ("coder") is not the target — matching a declaration's free text against live entries' agent_type lets any surviving lane of the same class impersonate a landed one, and the duty is then carried forever while the real debt evaporates (P5). Codes: [${codes.join(', ')}]`
    );
    assert.match(items[0].text, /sub-target/, 'the minted item cites the LANDED TARGET, so a drain can verify whether its capture landed');
    assert.equal(codes[codes.length - 1], 0, 'the converting Stop releases the session');
    assert.equal(existsSync(touchesPath(dir)), false, 'the conversion IS terminal — the registers clear together (AC6/P4), unchanged by other dispatches still being live');
    assert.equal(existsSync(eventsPath(dir)), false, 'including the carried declaration itself');
    // Deliberately NOT asserted: whether the DISPATCH register survives a
    // terminal H10 path. AC6 speaks of H10's own registers; the frozen suite
    // pins non-mutation only on non-terminal paths, and inventing the terminal
    // case would be an oracle for a rule nobody has stated.

    stopOnce(dir);
    assert.equal(captureOwed(store).length, 1, 'DUPLICATION SHAPE if this exceeds 1: exactly one deduped item, however many Stops the carry spanned and however many lanes stayed live');
  } finally {
    cleanup();
  }
});

// agent_id vector. Sequential lane numbering is the realistic id shape here
// (sub-lane-1 … sub-lane-104 in one session), and it produces the collision in
// BOTH directions, so this arm seeds one survivor of each rather than betting
// on which way the substring test runs:
//   sub-lane-1   is a substring OF the declaration's text (it names sub-lane-10)
//   sub-lane-104 CONTAINS the landed target's id sub-lane-10
// Whichever direction the implementation greps, a survivor impersonates the
// landed target. Neither survivor shares the target's agent_type, and neither
// declares a path named in the declaration, so the id is the only vector.
const ID_TARGET_FILE = 'src/pending/lane-10.mjs';
const ID_DETAIL = pendingDetail({
  agentId: 'sub-lane-10',
  agentType: 'test-writer',
  files: [ID_TARGET_FILE],
  reason: 'capture the schema findings',
});
const idSurvivors = () => [
  liveEntry('sub-lane-1', ['src/unrelated/lane-1.mjs'], 'reviewer'),
  liveEntry('sub-lane-104', ['src/unrelated/lane-104.mjs'], 'librarian'),
];

test('P4b (DEFECT 3, RED as built): the duty converts once the target lands even when a surviving lane\'s agent_id substring-collides with the landed target\'s id — in EITHER direction', () => {
  // SABOTAGE that must turn this red: decide target liveness by id substring —
  // `entries.some((e) => detail.includes(e.agent_id) || e.agent_id.includes(targetId))`.
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(ID_DETAIL)]);
    writeRegisterRaw(dir, [liveEntry('sub-lane-10', [ID_TARGET_FILE], 'test-writer'), ...idSurvivors()]);

    assert.equal(stopOnce(dir).code, 0, 'PRECONDITION: the first pending Stop releases');
    assert.equal(captureOwed(store).length, 0, 'PRECONDITION: no debt while the target is live');

    writeRegisterRaw(dir, idSurvivors()); // ONLY sub-lane-10 lands

    const { codes, items } = stopsUntilOwed(dir, store);
    assert.equal(
      items.length,
      1,
      `IMPERSONATION SHAPE (id vector, RED as built, firing as 0 !== 1): sub-lane-10 landed, but sub-lane-1 and sub-lane-104 are still live and each substring-collides with it — one in each direction. A prefix relation between two unrelated lane ids is not identity, and treating it as identity carries the declaration past its own target's death. Codes: [${codes.join(', ')}]`
    );
    assert.match(items[0].text, /sub-lane-10/, 'the minted item cites the landed target');
    assert.equal(codes[codes.length - 1], 0, 'the converting Stop releases the session');
  } finally {
    cleanup();
  }
});

// declared-path vector. A capture_pending REASON routinely names the file the
// capture is about; an unrelated lane may legitimately hold that same file
// open. The path below is NOT touched, so the fan-out FILE deferral is not in
// play — the only thing this path can do is impersonate the landed target.
const NOTES_FILE = 'packages/store/src/lane-notes.mjs';
const PATH_DETAIL = pendingDetail({
  agentId: 'sub-notes-3',
  agentType: 'coder',
  files: ['src/pending/notes-lane.mjs'],
  reason: `writing up the findings recorded in ${NOTES_FILE}`,
});
const pathSurvivor = () => liveEntry('sub-render-9', [NOTES_FILE], 'reviewer');

test('P4c (DEFECT 3, RED as built): the duty converts once the target lands even when a surviving lane DECLARES a file path that the declaration\'s free-text reason happens to mention', () => {
  // SABOTAGE that must turn this red: decide target liveness by declared-path
  // substring — `entries.some((e) => e.files.some((f) => detail.includes(f)))`.
  const { dir, store, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE]);
    writeSessionEvents(dir, [cpEvent(PATH_DETAIL)]);
    writeRegisterRaw(dir, [liveEntry('sub-notes-3', ['src/pending/notes-lane.mjs'], 'coder'), pathSurvivor()]);

    assert.equal(stopOnce(dir).code, 0, 'PRECONDITION: the first pending Stop releases');
    assert.equal(captureOwed(store).length, 0, 'PRECONDITION: no debt while the target is live');

    writeRegisterRaw(dir, [pathSurvivor()]); // ONLY sub-notes-3 lands

    const { codes, items } = stopsUntilOwed(dir, store);
    assert.equal(
      items.length,
      1,
      `IMPERSONATION SHAPE (declared-path vector, RED as built, firing as 0 !== 1): sub-notes-3 landed, and the only surviving lane sub-render-9 is unrelated — it merely holds ${NOTES_FILE}, a path the declaration's PROSE mentions. A file named in a reason is subject matter, not an owner; treating it as proof the target lives means the duty never converts. Codes: [${codes.join(', ')}]`
    );
    assert.match(items[0].text, /sub-notes-3/, 'the minted item cites the landed target, not the surviving lane');
    assert.equal(codes[codes.length - 1], 0, 'the converting Stop releases the session');
  } finally {
    cleanup();
  }
});
