// H20 ASKUSERQUESTION DENY RUNG — TITLE-UNION BOUNDARY PIN
// SPEC ONLY, blind to the fix. Derived from:
//   - decision 00b23915 (record-centrality-gains-a-title-union...) — the
//     change under review: recordCentralityHits/hasRecordCentralityHit union
//     the narrow (title+statement frequency) top-6 with a separate
//     title-only top-6, growing the record's central set up to 12 terms.
//     NO threshold moves — AXIS_RECORD_TOP_K stays 6.
//   - research_finding 5f3e0a42 — the motivating defect (a ruling buried in
//     its own long statement, unreachable by its own title's vocabulary).
//   - scripts/tests/h20-deny-once.test.mjs — read for harness shape, fixture
//     style (repetition-saturated STRICT/WEAK fixtures) and the
//     spawnSync-driven end-to-end deny/allow idiom. NOT edited.
//   - the dispatch brief's own quotation of scripts/hooks/lib/delivery.mjs
//     (lines 181-193, quoted verbatim in the brief, not read directly by
//     this agent — H4 denies reading delivery.mjs itself): the deny rung
//     requires FULL COVERAGE of the record's own top-K central terms —
//     "EVERY one of the record's own dominant terms is present, not just
//     most of them" — implemented as minTerms = AXIS_RECORD_TOP_K = 6,
//     relying on the invariant that a central set never exceeds 6.
//
// THE GAP THIS FILE CLOSES. Two independent reviewers established that the
// 22 existing deny-once pins do not cover the interaction between the
// title-union change and the deny rung's full-coverage bar:
//   - h20-deny-once.test.mjs's own STRICT fixture drifted: its TITLE
//     contains 'banned' but its QUESTION does not, so once title terms are
//     unioned in, that fixture's central set grows from 6 to 7 and its
//     existing "denied" assertion (line 242) now passes on six-of-seven
//     rather than full coverage — right answer, wrong reason.
//   - the WEAK/control fixture sits far below the bar; a one-term weakening
//     cannot flip it.
//   - nothing sits AT the boundary: a question that covers fewer than 6 of
//     a record's own (pre-union) narrow top-6 terms, but would newly reach 6
//     covered terms once title-derived terms are added to the same central
//     pool the deny rung counts against.
//
// WHAT "CORRECT" MEANS HERE, stated so the fixture's honesty can be checked.
// The deny rung's own documented purpose ("the record's OWN dominant
// terms") is defined over the narrow (title+statement frequency) top-6 —
// the general title-union is a RECALL improvement for the loose audit /
// preflight surfaces, not a license to relax the strict deny bar. A fix
// that preserved the existing STRICT fixture's behavviour unchanged (which
// the dispatch brief implies, since neither reviewer asked for that fixture
// to be edited) must therefore keep the deny rung's full-coverage
// requirement scoped to the record's pre-union narrow top-6, independent of
// how large the general-purpose union grows elsewhere. That is the
// behaviour this file pins — not "assume the union never touches deny",
// but "the deny rung's own full-coverage bar must stay anchored to the
// narrow top-6 regardless of what the shared union machinery computes for
// other callers."
//
// EXECUTION DISCLOSURE: this agent has no Bash and cannot run these tests.
// Expected outcomes per arm are stated below and in each SABOTAGE comment;
// the conductor's red/mutation gate is what actually executes them.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(HOOKS, 'h20-mechanism-axis.mjs')],
    { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 60_000 }
  );
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function combined(r) {
  return `${r.stdout}\n${r.stderr}`;
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: '2026-08-30T12:00:00.000Z',
    updated_at: '2026-08-30T12:00:00.000Z',
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function decisionRecord(title, statement, paths = []) {
  return {
    ...envelope('decision'),
    title,
    statement,
    alternatives_rejected: [{ option: 'leave it unshown entirely', reason: 'placeholder rejected alternative' }],
    rationale: 'rationale text',
    file_keys: paths,
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-boundary-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function askQuestion(dir, question, options = [], header = 'Choice') {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question, header, multiSelect: false, options }] },
    cwd: dir,
  };
}

// --- fixture construction --------------------------------------------------
//
// TITLE: five distinct content words, each appearing EXACTLY ONCE across the
// whole record (title + statement combined) — conveyor / calibration /
// mandates / rotor / alignment. Because AXIS_RECORD_TOP_K=6 exceeds the
// title's own 5 distinct words, extracting the title-only top-6 returns ALL
// FIVE of them untouched by any tie-break — this is the "title-derived
// central set" a union arm would add.
//
// STATEMENT: six distinct content words — socket / buffer / threshold /
// packet / retry / timeout — each repeated in exactly 4 of 4 sentences (a
// fixed six-word stem "socket buffer threshold packet retry timeout"
// prefixing four otherwise-unique sentences, so no other word in the
// statement repeats more than once). Frequency ranking over the combined
// title+statement text is therefore unambiguous: the six repeated words
// (count 4 each) strictly dominate every other word in the record,
// including the five title words (count 1 each) — so the record's PRE-UNION
// narrow top-6 is exactly {socket, buffer, threshold, packet, retry,
// timeout}, with zero overlap against the five title words. This is the
// same repetition-saturation recipe h20-deny-once.test.mjs's STRICT fixture
// uses, deliberately kept disjoint from the title vocabulary (unlike that
// fixture, whose title/question drift is exactly what left this boundary
// uncovered).
const BOUNDARY_TITLE = 'Conveyor calibration mandates rotor alignment';
const BOUNDARY_STATEMENT =
  'Socket buffer threshold packet retry timeout must never drift below the configured minimum. ' +
  'Every socket buffer threshold packet retry timeout is logged for audit purposes. ' +
  'A socket buffer threshold packet retry timeout violation triggers an immediate rollback. ' +
  'Operators cannot override socket buffer threshold packet retry timeout without executive sign-off.';

// BOUNDARY QUESTION: covers exactly 3 of the 6 narrow (pre-union) top-6
// terms (socket, buffer, threshold — omitting packet, retry, timeout) PLUS
// exactly 3 of the 5 title-only terms (conveyor, calibration, alignment —
// omitting mandates, rotor). Options carry none of the 11 target words, so
// coverage is attributable solely to the question text regardless of
// whether option text also feeds the matcher.
//   - narrow-only coverage: 3  (< 6  -> must NOT deny under full coverage
//     of the record's own dominant terms, today AND after a correct fix)
//   - union coverage (narrow ∪ title-only): 6 (>= AXIS_RECORD_TOP_K=6 -> a
//     fix that reuses the enlarged union set with minTerms left fixed at 6
//     would wrongly deny this)
const BOUNDARY_QUESTION =
  'Should conveyor calibration verify socket buffer threshold values before alignment testing?';
const BOUNDARY_OPTIONS = [
  { label: 'Yes', description: 'Proceed with the requested check' },
  { label: 'No', description: 'Skip this step for now' },
];

// CONTROL QUESTION: covers ALL 6 narrow (pre-union) top-6 terms and ZERO
// title-only terms. Narrow-only coverage = 6 = full coverage of the
// record's own dominant terms -> must DENY, independent of the union.
const CONTROL_QUESTION =
  'Should the socket buffer threshold packet retry timeout limits be relaxed for staging environments?';
const CONTROL_OPTIONS = [
  { label: 'Relax', description: 'Loosen the limits for staging only' },
  { label: 'Keep', description: 'Leave the limits as configured' },
];

// --------------------------------------------------------------------------
// 1. CONTROL — placed first: proves the deny rung still fires on genuine
// full coverage of the record's own (pre-union) narrow top-6, over the SAME
// fixture the boundary arm below uses. Without this arm, the boundary arm's
// "not denied" assertion would be satisfiable by a deny rung that has simply
// stopped denying anything.
// --------------------------------------------------------------------------

test('CONTROL: a question covering ALL 6 of the record\'s pre-union narrow top-6 terms is still DENIED, regardless of the title-union change', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(BOUNDARY_TITLE, BOUNDARY_STATEMENT));
    const r = runHook(askQuestion(dir, CONTROL_QUESTION, CONTROL_OPTIONS, 'Limits'), dir);
    assert.equal(r.code, 2, 'full coverage of the record\'s own dominant (narrow top-6) terms must still deny');
    assert.match(combined(r), new RegExp(ruling.id), 'the denial names the matched ruling');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the deny rung unconditionally allow every AskUserQuestion
// call through (e.g. short-circuit the strict-deny branch to always return
// allow) — this control goes red (r.code becomes 0). A second, narrower
// sabotage that would ALSO flip this control red: redefine "full coverage"
// post-union as requiring ALL union terms (narrow ∪ title-only, 11 here)
// rather than just the narrow top-6 — CONTROL_QUESTION covers 6 of 11 and
// would then wrongly fall short of denial.

// --------------------------------------------------------------------------
// 2. BOUNDARY — the pin two independent reviewers found missing: a question
// covering FEWER than 6 of the narrow top-6 must NOT deny, even though it
// would reach the AXIS_RECORD_TOP_K=6 floor if title-derived terms were
// wrongly folded into the same central pool the deny rung counts against.
// --------------------------------------------------------------------------

test('AC (title-union must not ease the deny rung): a question covering only 3 of the record\'s 6 narrow top-6 terms is ALLOWED, even though it covers 3 more title-only terms that would reach 6 under a naive union', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(BOUNDARY_TITLE, BOUNDARY_STATEMENT));
    const r = runHook(askQuestion(dir, BOUNDARY_QUESTION, BOUNDARY_OPTIONS, 'Calibration'), dir);
    assert.notEqual(r.code, 2, 'partial coverage of the record\'s own dominant terms must not deny, regardless of incidental title-vocabulary overlap');
  } finally {
    cleanup();
  }
});
// SABOTAGE: reuse the general-purpose union-based central set (decision
// 00b23915's recordCentralityHits, narrow top-6 ∪ title-only top-6) for the
// deny rung's eligibility check while leaving minTerms fixed at
// AXIS_RECORD_TOP_K=6, instead of computing deny coverage against the
// record's pre-union narrow top-6 alone — this test goes red (r.code
// becomes 2), because BOUNDARY_QUESTION's 3 narrow + 3 title-only hits then
// satisfy covered.length(6) >= min(6, central.length(11)).
