// H10 STOP-FLOOD PINS — SPEC-ONLY, written BLIND to scripts/hooks/h10-direct-capture.mjs.
//
// CONTRACT SOURCE: decision `h10-stop-flood-shorter-and-fewer-repeat-compaction-once-per-session-unknown-note`
// (knowledge_get ee8ab1f5-0fd7-400b-887b-fcb11b86d523), read in full. Every arm
// below pins BEHAVIOUR at the hook's real entry point (a Stop payload on stdin),
// never a rendering helper.
//
// NEW SIBLING FILE by the established H10 precedent: every h10-*.test.mjs stays
// frozen and duplicates the harness rather than importing a sibling (importing
// would double-run its registered test() calls). The harness below is the idiom
// of scripts/tests/h10-dispatch-status-policy.test.mjs and
// scripts/tests/h10-no-capture-lane-scope.test.mjs.
//
// THE SECOND-NAG-CYCLE DRIVE (used by C3/C4/C5): the decision states the Stop
// IMMEDIATELY after a nag is NOT a repeat — the existing capture-nagged
// semantics convert it and release. So each cycle here is driven the way the
// frozen L7b arm re-arms a duty: touch -> nag -> SATISFY the duty with a
// capture (terminal release, registers cleared, no queue noise) -> touch again
// with a LATER `at` -> the next nag cycle. Nothing in the drive deletes a
// marker by hand.
//
// EXECUTION DISCLOSURE: this role holds no Bash by design (H4), so NONE of
// these tests were run. Each assertion message states the failure shape it
// produces and carries its contract id.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H10 = join(HOOKS, 'h10-direct-capture.mjs');

const T1 = '2026-06-10T10:00:00.000Z'; // first cycle's work
const CAP1 = '2026-06-10T11:00:00.000Z'; // the capture that settles cycle 1
const T2 = '2026-06-10T12:00:00.000Z'; // second cycle's work (AFTER the capture => re-armed)
const RES2 = '2026-06-10T12:05:00.000Z';

const FILE_A = 'src/flood/a.mjs';
const FILE_B = 'src/flood/b.mjs';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
  dispatch_register: { stale_minutes: 5 },
  session_events: { research_agents: ['researcher', 'claude-code-guide'] },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-flood-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const hookInput = (dir, over = {}) => ({
  session_id: 's1',
  transcript_path: join(dir, 't', 's1.jsonl'),
  cwd: dir,
  permission_mode: 'default',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  ...over,
});

function runStop(dir, over = {}, stdio) {
  const opts = {
    input: JSON.stringify(hookInput(dir, over)),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  };
  if (stdio) opts.stdio = stdio;
  // Match the PRODUCTION invocation (hooks.json, decision fedc4e84): every hook
  // is spawned with --disable-warning=ExperimentalWarning. Without it Node 24's
  // node:sqlite ExperimentalWarning lands on stderr FIRST and the strict
  // header/line-count assertions below measure the noise instead of the
  // message. Measuring what production emits beats post-filtering stderr
  // (same reasoning as scripts/tests/h20-deny-once.test.mjs:61-70).
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', H10], opts);
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const out = (r) => `${r.stdout}\n${r.stderr}`;
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

// -------------------------------- registers ---------------------------------
const tPath = (dir, name) => join(dir, '.sterling', 'transient', name);
const touchesPath = (dir) => tPath(dir, 'touches.json');
const eventsPath = (dir) => tPath(dir, 'session-events.json');
const dutyNagged = (dir) => tPath(dir, 'duty-nagged.json');
const captureNagged = (dir) => tPath(dir, 'capture-nagged.json');
const unknownNoted = (dir) => tPath(dir, 'dispatch-unknown-noted.json');
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

function touch(dir, paths, at) {
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n');
  }
  writeFileSync(touchesPath(dir), JSON.stringify(paths.map((path) => ({ path, at }))));
}
const writeEvents = (dir, events) => writeFileSync(eventsPath(dir), JSON.stringify(events));
const rEvent = (detail, at) => ({ kind: 'research_tool', detail, at });
const conceptEvent = (family, at) => ({ kind: 'concept_designed', detail: family, at });
const FAMILY = 'gizmo-transport';
// Four unowned files against the DEFAULT article_demand.min_unowned_files of 3
// (deliberately not overridden — same geometry the frozen A0 arm of
// h10-deferral-article-demand-and-pending-carry.test.mjs relies on).
const DEMAND_1 = ['src/demand/a1.mjs', 'src/demand/b1.mjs', 'src/demand/c1.mjs', 'src/demand/d1.mjs'];
const DEMAND_2 = ['src/demand/a2.mjs', 'src/demand/b2.mjs', 'src/demand/c2.mjs', 'src/demand/d2.mjs'];
const writeRegister = (dir, entries) => writeFileSync(tPath(dir, 'dispatch-register.json'), JSON.stringify(entries));

const envelope = (type, at) => ({
  id: randomUUID(), type, created_at: at, updated_at: at, author: 'conductor',
  status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
});
const captureDecision = (store, at = CAP1) =>
  store.create({ ...envelope('decision', at), title: 'learned things', statement: 's', alternatives_rejected: [], rationale: 'r' });
const owed = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === reason);

// The UNKNOWN-dispatch fixture: exactly the entry shape the frozen
// h10-dispatch-status-policy.test.mjs (R1-A41/A42) proves classifies UNKNOWN —
// same session, no `ended`, `at` far outside the 5-minute lease, so liveness
// cannot be confirmed and death cannot be confirmed either.
// The declared `files` OVERLAP the paths these Stops touch, mirroring R1-A42
// (touches ['src/x.mjs'], entry declares ['src/x.mjs']): the pre-existing
// "biting" filter only notes an unknown owner of a path THIS Stop touched, and
// the once-per-session dedup sits on top of that filter, never replacing it. An
// entry declaring an untouched path would make every "no note" assertion below
// green for the wrong reason. Both cycle files are declared so the entry keeps
// biting after the register is re-armed with FILE_B.
const agoISO = (min) => new Date(Date.now() - min * 60_000).toISOString();
const unknownEntry = (agentId = 'expired-note-1', files = [FILE_A, FILE_B]) => ({
  agent_id: agentId, agent_type: 'coder', session_id: 's1', files,
  attribution: 'block', at: agoISO(60),
});

// ------------------------------ form assertions ------------------------------
function assertFullForm(r, id, why) {
  const L = lines(r.stderr);
  assert.equal(r.code, 2, `${id}: an open duty must still block — ${why}; out=${out(r)}`);
  assert.ok(L.length >= 2, `${id}: the FULL form is a header plus one line per duty, got ${L.length} line(s) — ${why}: ${r.stderr}`);
  assert.ok(L[0].startsWith('H10 ▸'), `${id}: the first line is the 'H10 ▸' header — got ${JSON.stringify(L[0])}`);
  assert.doesNotMatch(r.stderr, /unchanged since/, `${id}: this render must NOT be the compacted repeat — ${why}`);
}

// `remedies` is a PARAMETER, defaulting to the capture lane's tokens, because
// remedies are LANE-SPECIFIC: the concept and article-demand lanes have no
// no_capture remedy at all — they are discharged only by OWNERSHIP (general
// capture does not satisfy them, and decision
// `no-capture-discharge-is-lane-scoped` scopes no_capture to the capture and
// research lanes), so asserting it there would pin a remedy the hook must
// never offer.
function assertCompactForm(r, id, { remedies = [/knowledge_create/, /no_capture/], forbid = [] } = {}) {
  const L = lines(r.stderr);
  assert.equal(r.code, 2, `${id}: compaction changes the TEXT, never the channel — the repeat still exits 2; out=${out(r)}`);
  assert.equal(L.length, 1, `${id}: the repeat nag is EXACTLY one line (no header + bullets), got ${L.length}: ${r.stderr}`);
  assert.match(L[0], /unchanged since/, `${id}: the one-liner states the duty set is unchanged; got ${JSON.stringify(L[0])}`);
  for (const re of remedies) {
    assert.match(L[0], re, `${id}: the repeat keeps this lane's EXECUTABLE remedy ${re} (context compaction can evict CLAUDE.md mid-session, so a repeat without its token leaves the reader nothing to act on); got ${JSON.stringify(L[0])}`);
  }
  for (const re of forbid) {
    assert.doesNotMatch(L[0], re, `${id}: this lane must NOT be offered ${re} — offering a discharge that does not discharge it is a FALSE remedy, worse than no remedy; got ${JSON.stringify(L[0])}`);
  }
}

// Drives cycle 1 (nag -> satisfy -> terminal release) then re-arms cycle 2.
// `tamper(path)` runs after the release, i.e. on the marker the next nag reads.
function driveSecondCycle(dir, store, { over = {}, cycle2Events = null, tamper = null } = {}) {
  touch(dir, [FILE_A], T1);
  const first = runStop(dir, over);
  captureDecision(store, CAP1);
  const release = runStop(dir, over);
  if (tamper) {
    // An assertion, not a crash: with the feature absent there is no marker to
    // corrupt, and a bare readFileSync here would give a crash-red that proves
    // nothing about the fail-loud rule.
    assert.equal(existsSync(dutyNagged(dir)), true, 'PRECONDITION: the first nag must spend duty-nagged.json — without a marker the fail-loud arms have nothing to corrupt');
    tamper(dutyNagged(dir));
  }
  touch(dir, [FILE_B], T2);
  if (cycle2Events) writeEvents(dir, cycle2Events);
  return { first, release, second: runStop(dir, over) };
}

// ===========================================================================
// C8 — CONTROL ARMS, PLACED FIRST. Without these, every "the text got shorter"
// or "no marker was spent" verdict below is equally satisfiable by an H10 that
// stopped nagging (or stopped writing markers) at all.
// ===========================================================================

test('C8a CONTROL (first): a Stop with NO touches and NO session events exits 0 and writes none of the three markers', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runStop(dir);
    assert.equal(r.code, 0, `C8a CONTROL BROKEN: an idle session is never blocked — out=${out(r)}`);
    for (const [name, p] of [['duty-nagged', dutyNagged(dir)], ['capture-nagged', captureNagged(dir)], ['dispatch-unknown-noted', unknownNoted(dir)]]) {
      assert.equal(existsSync(p), false, `C8a: ${name}.json must not exist when nothing was ever rendered — a marker written on an empty Stop would silence the first real nag`);
    }
  } finally { cleanup(); }
});

test('C8b CONTROL (first): the existing capture-nagged cadence still holds — first Stop nags and writes capture-nagged.json, the next converts to capture_owed and releases', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    const nag = runStop(dir);
    assert.equal(nag.code, 2, `C8b CONTROL BROKEN: the first Stop with an unpaid capture duty must block — out=${out(nag)}`);
    assert.equal(existsSync(captureNagged(dir)), true, 'C8b: the shared nag marker is written on the first nag');
    assert.equal(owed(store, 'capture_owed').length, 0, 'C8b: the first nag does not yet mint debt');

    const release = runStop(dir);
    assert.equal(release.code, 0, `C8b CONTROL BROKEN: the Stop after a nag releases (this is why it is NOT a compaction repeat) — out=${out(release)}`);
    assert.equal(owed(store, 'capture_owed').length, 1, 'C8b: it converts to exactly one capture_owed');
    assert.equal(existsSync(touchesPath(dir)), false, 'C8b: the conversion is terminal — registers clear together (P4)');
  } finally { cleanup(); }
});

// ===========================================================================
// C1 — channel unchanged.
// ===========================================================================

test('C1: a Stop with an open capture duty still exits 2 with the duty text on STDERR (the channel is unchanged; only length and frequency change)', () => {
  const { dir, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    const r = runStop(dir);
    assert.equal(r.code, 2, `C1: exit 2 is the one route whose first attempt is guaranteed to block — an exit-0 feedback envelope loses that guarantee; out=${out(r)}`);
    assert.match(r.stderr, /H10 ▸/, `C1: the text rides STDERR, not stdout — stdout=${JSON.stringify(r.stdout)}`);
    assert.match(r.stderr, /knowledge_create/, 'C1: the remedy the reader must act on is in the blocking text itself');
  } finally { cleanup(); }
});

// ===========================================================================
// C2 — FIRST nag text: header + one line per duty, remedy tokens, no prose.
// Two lanes are armed so the "one line per duty" shape is observable.
// ===========================================================================

test('C2: the FIRST nag is a "H10 ▸" header plus ONE line per open duty, each carrying its executable remedy tokens, with the explanatory clauses GONE', () => {
  const { dir, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    writeEvents(dir, [{ kind: 'research_tool', detail: 'cache eviction policy threshold', at: T1 }]);
    const r = runStop(dir);
    assert.equal(r.code, 2, `C2: both lanes are armed, so the Stop blocks — out=${out(r)}`);
    const L = lines(r.stderr);
    assert.ok(L[0].startsWith('H10 ▸'), `C2: header line begins 'H10 ▸' — got ${JSON.stringify(L[0])}`);

    const capLines = L.filter((l) => l.includes('knowledge_create'));
    assert.equal(capLines.length, 1, `C2: the capture duty is ONE line, not a section — found ${capLines.length} lines carrying knowledge_create: ${r.stderr}`);
    for (const tok of ['knowledge_create', 'no_capture', 'capture_pending']) {
      assert.ok(capLines[0].includes(tok), `C2: the capture line carries the token '${tok}' on the SAME line (a remedy split across lines is the flood this replaces) — got ${JSON.stringify(capLines[0])}`);
    }

    const resLines = L.filter((l) => l.includes('research_finding'));
    assert.equal(resLines.length, 1, `C2: the research duty is ONE line — found ${resLines.length}: ${r.stderr}`);
    assert.ok(resLines[0].includes('--lane research'), `C2: the research line keeps '--lane research' (the lane distinction changes the outcome) — got ${JSON.stringify(resLines[0])}`);
    assert.notEqual(capLines[0], resLines[0], 'C2: capture and research are SEPARATE lines — one line per duty');

    assert.doesNotMatch(r.stderr, /false declaration is drift/i, 'C2: the "a false declaration is drift" clause is DROPPED — CLAUDE.md and H1 carry it');
    assert.doesNotMatch(r.stderr, /BARE declaration covers the capture lane/i, 'C2: the "a BARE declaration covers the capture lane only" clause is DROPPED');
    assert.ok(L.length <= 5, `C2: a two-duty nag is a header plus two duty lines (slack of 2 allowed); ${L.length} lines is the flood this change removes: ${r.stderr}`);
  } finally { cleanup(); }
});

// ===========================================================================
// C3 — REPEAT COMPACTION on the NEXT nag cycle, plus the marker's shape.
// ===========================================================================

test('C3: the NEXT nag cycle with the SAME lane set renders EXACTLY one line carrying "unchanged since" and the remedy tokens; duty-nagged.json is written on the first nag with {session_id, 64-hex fingerprint, at}', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    const first = runStop(dir);
    assertFullForm(first, 'C3', 'the FIRST nag of the session is never compacted');

    assert.equal(existsSync(dutyNagged(dir)), true, 'C3: the first rendering spends the duty-nagged marker — without it there is nothing to compact against');
    const m = readJSON(dutyNagged(dir));
    assert.equal(m.session_id, 's1', `C3: the marker records the session it was rendered in — got ${JSON.stringify(m.session_id)}`);
    assert.match(String(m.fingerprint), /^[0-9a-f]{64}$/, `C3: the fingerprint is 64 lowercase hex (sha256 of the canonical SEMANTIC projection) — got ${JSON.stringify(m.fingerprint)}`);
    assert.ok(!Number.isNaN(Date.parse(String(m.at))), `C3: 'at' is a parseable instant (the one-liner prints its HH:MM) — got ${JSON.stringify(m.at)}`);

    captureDecision(store, CAP1);
    const release = runStop(dir);
    assert.equal(release.code, 0, `C3: the satisfied duty releases terminally — out=${out(release)}`);
    assert.equal(owed(store, 'capture_owed').length, 0, 'C3: a paid duty mints no queue noise, so the second cycle is a clean re-arm');

    touch(dir, [FILE_B], T2); // NEW work of the SAME lane set re-arms the duty
    const second = runStop(dir);
    assert.equal(second.code, 2, `C3 FIXTURE PRECONDITION: the re-armed capture duty must nag again — if this is 0 the second nag cycle never happened and nothing below can pin compaction; out=${out(second)}`);
    assertCompactForm(second, 'C3');
    assert.equal(existsSync(dutyNagged(dir)), true, 'C3: the marker survives the repeat — a marker cleared by a nag could never compact a third cycle');
    assert.equal(readJSON(dutyNagged(dir)).fingerprint, m.fingerprint, 'C3: the fingerprint is over the LANE SET, not counts or paths — a different file in the same lane must not change it (including counts would make compaction inert during active work)');
  } finally { cleanup(); }
});

// ===========================================================================
// C3a/C3b/C3c — the repeat is ONE line for EVERY lane shape, not just capture.
//
// DRIVE (different from C3's, disclosed): these lanes are re-armed through the
// EXISTING conversion cadence — nag, then the following Stop converts the duty
// to a queue item and CLEARS the registers (C8b pins that cadence), then the
// same subject is re-seeded with a LATER `at`. Satisfying a research or concept
// duty would mean authoring records this oracle has no interface slice for. The
// cycle-2 Stop therefore carries a loud PRECONDITION assertion: if a re-armed
// duty does not nag again, that is a fixture/spec finding reported as such, not
// a compaction failure.
//
// The re-seeded SUBJECT is deliberately identical (same family, same research
// query) because the fingerprint is over the canonical SEMANTIC projection —
// which includes the concept-family set — so a new family would legitimately
// render full (that is C4's property, not this one). C3b is the exception: the
// projection carries article-demand PRESENCE, not paths, so it re-arms with
// four fresh unowned files.
// ===========================================================================

const REPEAT_ARMS = [
  {
    id: 'C3a concept-only',
    seed: (dir) => writeEvents(dir, [conceptEvent(FAMILY, T1)]),
    reseed: (dir) => writeEvents(dir, [conceptEvent(FAMILY, T2)]),
    // The concept demand is discharged ONLY by the family's own article, so the
    // one-liner must carry knowledge_create and must NOT offer no_capture.
    remedies: [/concept→knowledge_create/],
    forbid: [/no_capture/],
  },
  {
    id: 'C3b article-demand-only',
    seed: (dir, store) => { touch(dir, DEMAND_1, T1); captureDecision(store, CAP1); },
    // A second capture dated after T2 keeps the CAPTURE lane closed, so cycle 2
    // holds the same single lane as cycle 1 rather than gaining one.
    reseed: (dir, store) => { touch(dir, DEMAND_2, T2); captureDecision(store, '2026-06-10T13:00:00.000Z'); },
    // Ownership is the only discharge here too — no no_capture.
    remedies: [/articles→knowledge_create feature_article/],
    forbid: [/no_capture/],
  },
  {
    id: 'C3c mixed capture+research+concept',
    seed: (dir) => {
      touch(dir, [FILE_A], T1);
      writeEvents(dir, [rEvent('cache eviction policy threshold', T1), conceptEvent(FAMILY, T1)]);
    },
    reseed: (dir) => {
      touch(dir, [FILE_B], T2);
      writeEvents(dir, [rEvent('cache eviction policy threshold', T2), conceptEvent(FAMILY, T2)]);
    },
    // no_capture is asserted SEGMENT-SCOPED (the one-liner joins lanes with
    // '; '), so it is pinned exactly where it is a real discharge — the
    // capture and research lanes — and never demanded of the concept lane.
    remedies: [/capture→[^;\n]*no_capture/, /research→[^;\n]*no_capture --lane research/, /concept→knowledge_create/],
  },
];

test('C3a/C3b/C3c: the repeat is EXACTLY one line for a concept-only, an article-demand-only and a three-lane cycle, each still naming every open lane and its remedy', () => {
  for (const arm of REPEAT_ARMS) {
    const { dir, store, cleanup } = makeProject();
    try {
      arm.seed(dir, store);
      const first = runStop(dir);
      assertFullForm(first, arm.id, 'the first nag of the session is always the full form');

      const convert = runStop(dir);
      assert.equal(convert.code, 0, `${arm.id}: the Stop after a nag converts the duty and RELEASES — it is never the compaction repeat; out=${out(convert)}`);

      arm.reseed(dir, store);
      const second = runStop(dir);
      assert.equal(second.code, 2, `${arm.id} FIXTURE PRECONDITION: the re-armed duty must nag again — a 0 here means the lane did not re-arm (e.g. an already-queued item suppressing it) and nothing about compaction is being measured; out=${out(second)}`);
      assertCompactForm(second, arm.id, { remedies: arm.remedies, forbid: arm.forbid ?? [] });
    } finally { cleanup(); }
  }
});

// C3d — THE EXCEPTION. Deferral lines carry live file ownership, so they are
// NOT compacted away: the repeat is the one-liner PLUS the deferral line(s).
// Fixture: one presumed-active entry (`at` 1 minute ago against stale_minutes
// 5) owning DEFERRED, exactly as the frozen R1-A40 control arm of
// h10-dispatch-status-policy.test.mjs constructs it, beside one NON-deferred
// touched file that keeps a real duty open.
const DEFERRED = 'src/flood/deferred.mjs';
const liveEntry = () => ({
  agent_id: 'sub-live-1', agent_type: 'coder', session_id: 's1',
  files: [DEFERRED], attribution: 'block', at: agoISO(1),
});

test('C3d: a repeat with a live presumed-active DEFERRAL renders the one-liner PLUS the deferral line(s) — live file ownership is never compacted away', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeRegister(dir, [liveEntry()]);
    touch(dir, [FILE_A, DEFERRED], T1);
    const first = runStop(dir);
    assertFullForm(first, 'C3d', 'the first nag; FILE_A is unowned so a duty is genuinely open');
    assert.match(out(first), /defer/i, 'C3d PRECONDITION: the deferral is disclosed on the first nag — if nothing is deferred here the exception is not being measured');

    captureDecision(store, CAP1);
    const release = runStop(dir);
    assert.equal(release.code, 0, `C3d: the satisfied duty releases — out=${out(release)}`);

    touch(dir, [FILE_A, DEFERRED], T2); // same lane set, same deferral owner
    const second = runStop(dir);
    assert.equal(second.code, 2, `C3d FIXTURE PRECONDITION: the re-armed duty on the NON-deferred file must nag again; out=${out(second)}`);
    const L = lines(second.stderr);
    const compacted = L.filter((l) => /unchanged since/.test(l));
    assert.equal(compacted.length, 1, `C3d: the duty half is still compacted to exactly one line, got ${compacted.length}: ${second.stderr}`);
    assert.match(compacted[0], /knowledge_create/, 'C3d: and it still carries the remedy tokens');
    assert.match(out(second), /defer/i, 'C3d: the deferral line SURVIVES the compaction — it names live file ownership the reader cannot reconstruct from a count, which is exactly why it is the stated exception');
    assert.match(out(second), /sub-live-1/, 'C3d: including the owning agent_id — a deferral line stripped of its owner is not a deferral disclosure');
    assert.ok(L.length <= 3, `C3d: one compacted duty line plus the deferral disclosure, not a re-expanded message; got ${L.length} lines: ${second.stderr}`);
  } finally { cleanup(); }
});

// ===========================================================================
// C4 — a NEW LANE re-renders the FULL form. C3 is this arm's control: the same
// drive with no new lane compacts, so a full render here is attributable to
// the lane change and not to compaction never working.
// ===========================================================================

test('C4: a NEW LANE appearing beside the capture lane renders the FULL multi-line form again, never the one-liner', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const { first, second } = driveSecondCycle(dir, store, {
      cycle2Events: [{ kind: 'research_tool', detail: 'leader election heartbeat interval', at: RES2 }],
    });
    assertFullForm(first, 'C4', 'the first nag of the session');
    assertFullForm(second, 'C4', 'the research lane is NEW in this cycle, so the semantic fingerprint changed and the reader has never seen this lane\'s remedy');
    assert.match(second.stderr, /research_finding/, 'C4: the new lane is actually rendered with its own remedy line');
    assert.match(second.stderr, /knowledge_create/, 'C4: the still-open capture lane keeps its line too — a changed set re-renders EVERY duty');
  } finally { cleanup(); }
});

// ===========================================================================
// C5 — FAIL-LOUD on the marker. The untampered CONTROL runs FIRST inside this
// test: "the full form rendered" has two possible causes (the marker was
// rejected, or compaction is not implemented), and only the control separates
// them.
// ===========================================================================

test('C5 (a/b/c): a duty-nagged marker that is malformed, mis-shaped, or from ANOTHER session is never salvaged — the FULL text is re-shown; the untampered CONTROL arm compacts', () => {
  const arms = [
    ['CONTROL untampered', null, true],
    ['(a) unreadable/malformed JSON', (p) => writeFileSync(p, '{ not json,,,'), false],
    ['(b) fingerprint not 64-hex', (p) => writeFileSync(p, JSON.stringify({ ...readJSON(p), fingerprint: 'deadbeef' })), false],
    ['(c) a DIFFERENT session_id', (p) => writeFileSync(p, JSON.stringify({ ...readJSON(p), session_id: 's-somewhere-else' })), false],
  ];
  for (const [label, tamper, expectCompact] of arms) {
    const { dir, store, cleanup } = makeProject();
    try {
      const { first, second } = driveSecondCycle(dir, store, { tamper });
      assertFullForm(first, `C5 ${label}`, 'the first nag is always full');
      if (expectCompact) {
        assertCompactForm(second, `C5 ${label} CONTROL BROKEN — if this arm does not compact, arms (a)-(c) are green for the wrong reason (compaction simply never happens)`);
      } else {
        assertFullForm(second, `C5 ${label}`, 'an unusable marker must fail LOUD toward SHOWING the text — a partially valid or foreign-session marker is never salvaged into a silent one-liner');
      }
    } finally { cleanup(); }
  }
});

test('C5d: with the Stop payload\'s session_id ABSENT there is NO compaction at all — every cycle renders the FULL form', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const { first, second } = driveSecondCycle(dir, store, { over: { session_id: undefined } });
    assertFullForm(first, 'C5d', 'the first nag');
    assertFullForm(second, 'C5d', 'without a session_id nothing can prove the marker belongs to THIS session, so compaction must not happen at all');
  } finally { cleanup(); }
});

// ===========================================================================
// C6 — the unknown-dispatch NOTE, once per session per key, on BOTH paths.
// ===========================================================================

test('C6a: the first Stop discloses the UNKNOWN dispatch with [dispatch_status_unknown] and "settle via SubagentStop/TaskStop", never "abandonment"; dispatch-unknown-noted.json = {session_id, keys:[64-hex]}', () => {
  const { dir, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    writeRegister(dir, [unknownEntry()]);
    const r = runStop(dir);
    const text = out(r);
    assert.equal(r.code, 2, `C6a: the open capture duty still blocks — an unknown owner defers nothing; out=${text}`);
    assert.match(text, /\[dispatch_status_unknown\]/, `C6a: the uncertainty carries its code token — out=${text}`);
    assert.match(text, /settle via SubagentStop\/TaskStop/, `C6a: the remedy names the ONLY mechanism that ends a round — out=${text}`);
    assert.doesNotMatch(text, /abandonment/i, 'C6a: the "explicit abandonment" remedy is REMOVED — no such mechanism exists, and a hand-ended entry loses a real review round');

    assert.equal(existsSync(unknownNoted(dir)), true, 'C6a: the note is spent, so it cannot repeat every turn');
    const m = readJSON(unknownNoted(dir));
    assert.equal(m.session_id, 's1', `C6a: the marker is session-scoped — got ${JSON.stringify(m.session_id)}`);
    assert.ok(Array.isArray(m.keys) && m.keys.length === 1, `C6a: keys is a string[] with one entry per noted dispatch round — got ${JSON.stringify(m.keys)}`);
    assert.match(String(m.keys[0]), /^[0-9a-f]{64}$/, `C6a: the key is a sha256 over [agent_id, round, registered_at], never a raw '|' concatenation — got ${JSON.stringify(m.keys[0])}`);
  } finally { cleanup(); }
});

test('C6b: the note fires ONCE per session across a MIX of the exit-2 and exit-0 paths, and fires again under a NEW session_id', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    writeRegister(dir, [unknownEntry()]);

    const nag = runStop(dir); // path (i): duty open, exit 2, stderr
    assert.match(out(nag), /\[dispatch_status_unknown\]/, `C6b PRECONDITION: the note is delivered on the deny path first — out=${out(nag)}`);

    captureDecision(store, CAP1);
    const release = runStop(dir); // path (ii): duty settled, exit 0, systemMessage
    assert.equal(release.code, 0, `C6b: the settled duty releases — out=${out(release)}`);
    assert.doesNotMatch(out(release), /\[dispatch_status_unknown\]/, 'C6b: ONCE PER SESSION holds ACROSS the two output paths — a deny-path spend must also silence the exit-0 systemMessage release, which is the exact hole a deny-only spend leaves open');

    touch(dir, [FILE_B], T2);
    const secondNag = runStop(dir);
    assert.doesNotMatch(out(secondNag), /\[dispatch_status_unknown\]/, `C6b: and it stays silenced on a later deny-path Stop in the same session — out=${out(secondNag)}`);

    // Attribution for the two silences above: the SAME on-disk state, changing
    // ONLY session_id, must speak again. Without this arm a green could mean
    // the entry stopped biting (its declared files cover both cycle files
    // exactly so it never stops) rather than that the dedup held.
    const foreign = runStop(dir, { session_id: 's9' });
    assert.match(out(foreign), /\[dispatch_status_unknown\]/, `C6b: a NEW session has never been told, so the same key is noted again (the marker is scoped to a session, never to the machine) — out=${out(foreign)}`);
  } finally { cleanup(); }
});

test('C6c: with NO open duty the note rides the exit-0 stdout JSON systemMessage, and a second no-duty Stop in the same session does not repeat it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    captureDecision(store, CAP1); // the duty is paid before the FIRST Stop
    writeRegister(dir, [unknownEntry()]);

    const firstRelease = runStop(dir);
    assert.equal(firstRelease.code, 0, `C6c: nothing is owed, so nothing blocks — out=${out(firstRelease)}`);
    let env;
    try {
      env = JSON.parse(firstRelease.stdout);
    } catch {
      assert.fail(`C6c: the no-duty release must emit a JSON envelope on stdout to carry the disclosure — got ${JSON.stringify(firstRelease.stdout)}`);
    }
    assert.equal(typeof env.systemMessage, 'string', `C6c: the note rides systemMessage on the exit-0 path — envelope=${firstRelease.stdout}`);
    assert.match(env.systemMessage, /\[dispatch_status_unknown\]/, 'C6c: an unknown dispatch is disclosed even when no duty is open — otherwise the uncertainty is only ever reported to sessions that happen to owe something');
    assert.match(env.systemMessage, /settle via SubagentStop\/TaskStop/, 'C6c: the exit-0 path carries the same remedy as the deny path');
    assert.equal(existsSync(unknownNoted(dir)), true, 'C6c: the exit-0 path SPENDS the key too — the fatal shape is a deny-only spend that lets the exit-0 release repeat forever');

    touch(dir, [FILE_A], T1); // more covered work: still no duty, still an unknown owner
    const secondRelease = runStop(dir);
    assert.equal(secondRelease.code, 0, `C6c: still nothing owed — out=${out(secondRelease)}`);
    assert.doesNotMatch(out(secondRelease), /\[dispatch_status_unknown\]/, 'C6c: once per session per key, on the exit-0 path as well');
  } finally { cleanup(); }
});

test('C6e: with the Stop payload\'s session_id ABSENT the note is shown on EVERY Stop and dispatch-unknown-noted.json is never written', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    writeRegister(dir, [unknownEntry()]);
    const over = { session_id: undefined };

    const first = runStop(dir, over);
    assert.match(out(first), /\[dispatch_status_unknown\]/, `C6e: the uncertainty is disclosed even when the session cannot be identified — withholding it would be the one failure direction P5 forbids; out=${out(first)}`);
    assert.equal(existsSync(unknownNoted(dir)), false, 'C6e: no marker is written — a marker keyed on an absent/empty session_id would silence the note for every future session that also arrives without one');

    const secondStop = runStop(dir, over);
    assert.match(out(secondStop), /\[dispatch_status_unknown\]/, `C6e: and it is shown AGAIN — without a session_id there is nothing to dedup against, so the note repeats rather than disappearing; out=${out(secondStop)}`);
    assert.equal(existsSync(unknownNoted(dir)), false, 'C6e: still no marker after a second Stop');
    void store;
  } finally { cleanup(); }
});

// The NO-DUTY DENY fixture (C6d). h10's third output path is a Stop with NO
// duty that denies anyway because an advisory part rides the emission. It is
// driven here through the DELEGATION advisory, whose fixture is proven by the
// frozen scripts/tests/h10-delegation-watch.test.mjs test (a): >= 15 distinct
// hand Reads with 0 Task/Agent blocks in the conductor's own transcript denies
// standalone, with no duty pending. `input_tokens: 1000` against the 200_000
// window keeps the independent context-pressure classifier below_soft so it
// cannot be what fires. DISCLOSED: the context-pressure gauge itself is NOT
// what this arm drives — its soft threshold is not stated in the decision or
// in any test fixture visible to this author, and inventing a number would be
// an oracle for a rule nobody stated. What the arm pins is the property the
// reviewer named: disclosureParts carried through a deny that no DUTY caused.
function writeHandWorkTranscript(dir) {
  const p = join(dir, 't', 's1.jsonl');
  mkdirSync(dirname(p), { recursive: true });
  const content = Array.from({ length: 16 }, (_, i) => ({
    type: 'tool_use', name: 'Read', input: { file_path: join(dir, 'src', `hand-${i}.mjs`) },
  }));
  writeFileSync(p, [
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0 }, model: 'claude-fable-5' } }),
    JSON.stringify({ type: 'assistant', isSidechain: false, message: { content } }),
  ].join('\n') + '\n');
}

test('C6d: the once-per-session note also holds on the NO-DUTY deny path — an advisory-riding deny shows [dispatch_status_unknown] once and spends the key; the next deny in the session does not repeat it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    touch(dir, [FILE_A], T1);
    captureDecision(store, CAP1); // the duty is PAID before the first Stop
    writeRegister(dir, [unknownEntry()]);
    writeHandWorkTranscript(dir);

    const advisoryDeny = runStop(dir);
    assert.equal(advisoryDeny.code, 2, `C6d PRECONDITION: no duty is open, so this deny is caused by the advisory alone — if this is 0 the no-duty deny path was never exercised; out=${out(advisoryDeny)}`);
    assert.doesNotMatch(advisoryDeny.stderr, /nothing was captured/, 'C6d PRECONDITION: the capture duty is paid — no duty may be what denies here');
    assert.match(out(advisoryDeny), /\[dispatch_status_unknown\]/, `C6d: the disclosure rides the advisory deny too — a Stop that denies without a duty must not lose the uncertainty; out=${out(advisoryDeny)}`);
    assert.match(out(advisoryDeny), /settle via SubagentStop\/TaskStop/, 'C6d: with the same remedy as every other path');
    assert.equal(existsSync(unknownNoted(dir)), true, 'C6d: and it SPENDS the key — a path that delivers without spending repeats the note every turn, which is the flood');

    touch(dir, [FILE_B], T2); // re-arms the capture duty (T2 is after the capture)
    const dutyDeny = runStop(dir);
    assert.equal(dutyDeny.code, 2, `C6d: the re-armed duty denies — out=${out(dutyDeny)}`);
    assert.doesNotMatch(out(dutyDeny), /\[dispatch_status_unknown\]/, 'C6d: ONCE PER SESSION holds ACROSS paths in both directions — a key spent on the advisory deny must also silence the later duty deny');

    // Attribution: same on-disk state, only session_id changes, so the silence
    // above is the dedup and not an entry that stopped biting.
    const foreign = runStop(dir, { session_id: 's9' });
    assert.match(out(foreign), /\[dispatch_status_unknown\]/, `C6d CONTROL: a new session is told again — this is what makes the preceding silence attributable to the once-per-session marker; out=${out(foreign)}`);
  } finally { cleanup(); }
});

// ===========================================================================
// C7 — SPEND AFTER DELIVERY. A marker spent before the text is delivered
// silences a nag that was never shown; the capture-nagged half of this is the
// pre-existing hazard (marker written before the deny) the change closes.
// ===========================================================================

const MARKERS = (dir) => [
  ['duty-nagged', dutyNagged(dir)],
  ['capture-nagged', captureNagged(dir)],
  ['dispatch-unknown-noted', unknownNoted(dir)],
];

// The write is production-shaped as a synchronous fd-2 write, so both failure
// arms probe with `fs.writeSync(2, …)` — the exact call whose failure the
// ordering rule is about. Two different errno classes, because they fail at
// different layers: EBADF (fd 2 is not writable at all) and EPIPE (fd 2 is a
// pipe whose reader is gone — the shape a real terminal/harness produces).
const WRITE_PROBE = "try { require('fs').writeSync(2, 'x'); process.stdout.write('WROTE'); } catch (e) { process.stdout.write('THREW:' + e.code); }";

// EPIPE shape: spawn with a piped stderr and destroy the PARENT's read end
// before the child execs, so the child's first fd-2 write finds no reader.
function runWithDeadStderrPipe(argv, { cwd, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.destroy(); // the reader is gone before the child can write
    for (const s of [child.stdin, child.stdout, child.stderr]) s.on('error', () => {});
    child.on('error', () => {});
    child.stdin.end(input ?? '');
    child.on('close', (code) => resolve({ code, stdout, stderr: '' }));
  });
}

function assertNothingSpent(dir, id, errno) {
  for (const [name, p] of MARKERS(dir)) {
    assert.equal(
      existsSync(p),
      false,
      `${id}: ${name}.json was SPENT although the fd-2 write failed with ${errno} — the nag was never shown, so the next Stop is silenced (capture-nagged additionally converts the duty to queued debt for a message nobody ever saw). Every marker is spent only AFTER the text is delivered.`,
    );
  }
}

test('C7: when the fd-2 write FAILS, none of the three markers is spent (the text is re-shown next Stop, never silenced)', async (t) => {
  // CONTROL FIRST: the same fixture with a working stderr spends all three.
  // Without it, both failure arms are satisfied by an H10 that never writes a
  // marker at all.
  await t.test('C7 CONTROL (first): a DELIVERED nag spends all three markers', () => {
    const { dir, cleanup } = makeProject();
    try {
      touch(dir, [FILE_A], T1);
      writeRegister(dir, [unknownEntry()]);
      const ok = runStop(dir);
      assert.equal(ok.code, 2, `C7 CONTROL BROKEN: the fixture must produce a real nag — out=${out(ok)}`);
      assert.match(out(ok), /\[dispatch_status_unknown\]/, 'C7 CONTROL BROKEN: the fixture must also produce the unknown note, or the note marker can never be spent');
      for (const [name, p] of MARKERS(dir)) {
        assert.equal(existsSync(p), true, `C7 CONTROL BROKEN: ${name}.json must be spent on a DELIVERED nag — if it is never written, the failure arms prove nothing`);
      }
    } finally { cleanup(); }
  });

  await t.test('C7 EBADF: stderr bound to a READ-ONLY fd', (st) => {
    const { dir, cleanup } = makeProject();
    let fd;
    try {
      const roFile = join(dir, 'ro-stderr-target');
      writeFileSync(roFile, '');
      fd = openSync(roFile, 'r');
      const probe = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', WRITE_PROBE], {
        stdio: ['ignore', 'pipe', fd], encoding: 'utf8', timeout: 30_000,
      });
      if (!(probe.stdout ?? '').startsWith('THREW')) {
        st.skip(`C7 EBADF NOT PINNED on this platform: a read-only fd on child fd 2 did not make fs.writeSync(2, …) throw (probe said ${JSON.stringify(probe.stdout)}) — a sabotage that fails to land looks exactly like a hollow pin, so this arm reports UNVERIFIED rather than green.`);
        return;
      }

      touch(dir, [FILE_A], T1);
      writeRegister(dir, [unknownEntry()]);
      const failed = runStop(dir, {}, ['pipe', 'pipe', fd]);

      // SINGLE-CAUSE GUARD: "no marker was spent" is equally satisfied by a
      // hook that DIED on the write and never reached the spend. The deny must
      // still stand — a failed delivery loses the text, never the block.
      assert.equal(failed.code, 2, `C7 EBADF: the Stop must still exit 2 (got ${failed.code}: the hook died or released instead of denying) — without this the marker verdict cannot distinguish "the spend moved after delivery" from "the process never got that far"`);
      assertNothingSpent(dir, 'C7 EBADF', 'EBADF');
    } finally {
      if (fd !== undefined) closeSync(fd);
      cleanup();
    }
  });

  await t.test('C7 EPIPE: stderr is a pipe whose READ end is closed (the production-shaped failure)', async (st) => {
    const { dir, cleanup } = makeProject();
    try {
      const probe = await runWithDeadStderrPipe(['--disable-warning=ExperimentalWarning', '-e', WRITE_PROBE], { cwd: dir, input: '' });
      if (!probe.stdout.startsWith('THREW')) {
        st.skip(`C7 EPIPE NOT PINNED on this platform: destroying the parent's read end did not make fs.writeSync(2, …) throw (probe said ${JSON.stringify(probe.stdout)}) — reported UNVERIFIED rather than green.`);
        return;
      }

      touch(dir, [FILE_A], T1);
      writeRegister(dir, [unknownEntry()]);
      const failed = await runWithDeadStderrPipe(['--disable-warning=ExperimentalWarning', H10], {
        cwd: dir, input: JSON.stringify(hookInput(dir)),
      });

      assert.equal(failed.code, 2, `C7 EPIPE: the Stop must still exit 2 (got ${failed.code}) — an EPIPE on the duty text loses the MESSAGE, never the BLOCK; this is also what separates "spend moved after delivery" from "the hook crashed"`);
      assertNothingSpent(dir, 'C7 EPIPE', 'EPIPE');
    } finally { cleanup(); }
  });
});
