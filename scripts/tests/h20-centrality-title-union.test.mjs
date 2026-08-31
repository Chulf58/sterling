// H20 stage-2 RECORD CENTRALITY — TITLE-ISH UNION fix (research_finding 5f3e0a42,
// slug 'a-rulings-principle-is-unretrievable-by-its-own-subject-when-buried-in-incident-evidence').
//
// THE DEFECT: a record's narrow text (e.g. a decision's title+statement, flattened
// into one unweighted pool) lets a long body drown a short, distinctive title —
// a title term appearing twice can be outranked out of the frequency top-K by
// ordinary words repeated many times across a long statement, silencing a record
// on a question squarely about its own subject.
//
// THE FIX UNDER TEST: a record's title-ish terms (per type: `title` for decision
// and anti_pattern; `slug`+`concept_family`+`title` for feature_article; `question`
// for research_finding/disconfirmed_hypothesis) are ALWAYS eligible as central
// terms, unioned with the frequency top-K, regardless of body length.
//
// This is a SEPARATE file from scripts/tests/h20-centrality.test.mjs (studied only
// for harness shape per dispatch brief — not edited, not duplicated). It is
// deliberately BLIND to packages/store/src/axis.ts and to how the union is
// implemented; every fixture is built from observable frequency arithmetic only.
//
// SPEC-ONLY / RED-GATE FILE: written before the fix lands. AC1 is expected to
// FAIL against today's code; AC2/AC3/AC5 are expected to PASS both before and
// after (they pin behaviour the fix must not disturb); AC4 is expected to FAIL
// today for the same reason as AC1, on a different record type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-30T12:00:00.000Z';

let hasRecordCentralityHit;
let recordCentralityHits;
// Dynamic import + destructure: an export that does not exist yet resolves to
// `undefined` here rather than crashing the whole file at load time (unlike a
// static `import { x } from ...`), so each test fails on its OWN call/assertion
// instead of every test in the file going red for the same reason at once.
const before = (async () => {
  ({ hasRecordCentralityHit, recordCentralityHits } = await import(
    pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href
  ));
})();

// --- fixture plumbing ----------------------------------------------------

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function decision(title, statement) {
  return {
    ...envelope('decision'),
    title,
    statement,
    alternatives_rejected: [],
    rationale: 'rationale text — not part of narrow text (title+statement only)',
    file_keys: [],
  };
}

function antiPattern(title, trigger) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance text — not part of narrow text (title+trigger only)',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: [],
  };
}

// Builds narrow-body text where exactly `words` (length 6) repeat once per
// repetition — reaching frequency `reps` each — while every other token
// (blockstart/mid/blockend + index) is UNIQUE per repetition and therefore
// stays at frequency 1. This is what guarantees the 6 dominant words occupy
// the entire frequency top-6, with nothing else able to tie into it. Real
// English connector words (the/a/and/...) are deliberately never used here —
// several are confirmed dropped by the extractor already, but the ones that
// AREN'T dropped would otherwise repeat every rep and contaminate the top-6,
// which is exactly the ambiguity this construction avoids.
// `extraAt` optionally splices one extra, once-only peripheral word into a
// specific repetition (frequency 1, never top-6, never title-ish).
function buildDominantText(words, reps, extraAt = {}) {
  const parts = [];
  for (let i = 0; i < reps; i++) {
    const extra = extraAt[i] ? ` peripheralnote${i} ${extraAt[i]} peripheralend${i}` : '';
    parts.push(
      `blockstart${i} ${words[0]} mid${i}a ${words[1]} mid${i}b ${words[2]} mid${i}c ${words[3]} ` +
        `mid${i}d ${words[4]} mid${i}e ${words[5]} blockend${i}${extra}`
    );
  }
  return parts.join(' ');
}

// --- AC1 fixture: short distinctive title vs. a long dominated statement ---
//
// Title: 'quorumite' appears TWICE, 'escrow' once — both freq well under the
// 6 dominant statement words' frequency of 30 each. Statement: ~4.5k chars,
// deliberately in the same shape as the measured defect (178-char title,
// distinctive term x2, drowned by a 4106-char statement).
const AC1_DOMINANT = ['pipeline', 'queue', 'worker', 'retry', 'timeout', 'latency'];
const AC1_TITLE = 'Quorumite ordering halts on quorumite escrow drift';
const AC1_STATEMENT = buildDominantText(AC1_DOMINANT, 30, { 5: 'gazebo', 15: 'trombone' });
const ac1Record = () => decision(AC1_TITLE, AC1_STATEMENT);

// --- AC3 fixture: terse record, degenerate scaling ------------------------
//
// Statement is built ENTIRELY from words the extractor is already confirmed
// to drop (per scripts/tests/h20-centrality.test.mjs: verify/record/store/
// report/evidence/this/file/the never survive extraction), contributing ZERO
// extractable terms. The title supplies the record's only extractable own
// term. Total distinct own terms = 1, so AXIS_MIN_RECORD_TERMS must scale
// down to 1 (existing degenerate-scaling rule) — the union must not raise
// this bar, and must not accidentally zero it either (see sabotage below).
const AC3_TITLE = 'Palladium';
const AC3_STATEMENT =
  'verify record store report evidence this file the verify record store report evidence this file the ' +
  'verify record store report evidence this file the';
const ac3Record = () => decision(AC3_TITLE, AC3_STATEMENT);

// --- AC4 fixture: anti_pattern, a NON-decision type -----------------------
//
// title-ish for anti_pattern is `title` alone (narrow text is title+trigger).
// 'palisade'/'escalation' sit in the title only, at freq 1 each — the 6
// dominant trigger words (freq 15 each) fill the entire top-6, so under the
// old algorithm the title terms are excluded exactly as in AC1.
const AC4_DOMINANT = ['gantry', 'conveyor', 'actuator', 'calibrate', 'threshold', 'sensor'];
const AC4_TITLE = 'Palisade escalation protocol';
const AC4_TRIGGER = buildDominantText(AC4_DOMINANT, 15, { 7: 'gazelle' });
const ac4Record = () => antiPattern(AC4_TITLE, AC4_TRIGGER);

// =========================================================================
// CONTROL ARMS FIRST — each must pass for the OPPOSITE reason from the
// positive pins below, so a green AC1/AC4 always carries its evidence.
// =========================================================================

test('AC5 control: outgoing text sharing NO vocabulary with the record stays uncovered (before AND after the fix)', async () => {
  await before;
  const shares_nothing = 'The weather today is calm with light clouds drifting slowly over the bay.';
  assert.equal(
    hasRecordCentralityHit(ac1Record(), shares_nothing),
    false,
    'zero shared vocabulary must never be central — rules out an "always true" implementation'
  );
});

test('AC2 control: outgoing text hitting only PERIPHERAL (non-title, non-top-6) terms stays uncovered (before AND after the fix)', async () => {
  await before;
  // 'gazebo' and 'trombone' are each freq-1, injected once into the long
  // statement, never in the title, never able to reach the top-6 (which the
  // 6 dominant words occupy at freq 30 each). Two of them satisfy the
  // AXIS_MIN_RECORD_TERMS=2 count on their own, so this is NOT satisfiable by
  // a floor that merely checks "count >= 2 shared words" — it specifically
  // rules out a fix that widens eligibility to ALL record terms instead of
  // just title-ish ones union'd with the top-K.
  const shares_only_periphery = 'Please double check the gazebo and trombone settings before deploy.';
  assert.equal(
    hasRecordCentralityHit(ac1Record(), shares_only_periphery),
    false,
    'peripheral overlap alone is not centrality, even at count >= 2 — a naive "everything is eligible" fix would flip this to true'
  );
});

test('AC4 control (anti_pattern): outgoing text hitting only a peripheral trigger word stays uncovered', async () => {
  await before;
  const shares_only_periphery = 'Can you check the gazelle reading from last night?';
  assert.equal(
    hasRecordCentralityHit(ac4Record(), shares_only_periphery),
    false,
    'same control as AC2, on a NON-decision type, so a per-type mapping bug cannot hide behind AC2 alone'
  );
});

// =========================================================================
// AC1 — THE CORE PIN. Expected to FAIL today.
// =========================================================================

test('AC1: a short, distinctive title term (x2) plus one other title term IS covered despite a long dominated statement', async () => {
  await before;
  const record = ac1Record();
  // Shares the title's distinctive term ('quorumite', appears twice in the
  // title) plus one other title term ('escrow'). Neither is in the
  // statement's frequency top-6 (pipeline/queue/worker/retry/timeout/latency,
  // freq 30 each vs. quorumite's freq 2 / escrow's freq 1).
  const outgoing = 'Please check whether the quorumite escrow configuration still needs rebalancing.';
  assert.equal(
    hasRecordCentralityHit(record, outgoing),
    true,
    'a title term must not be crowded out of centrality by body repetition'
  );
});

test('AC1b (if exported): recordCentralityHits names exactly the covered central terms, not just a boolean', async () => {
  await before;
  assert.equal(typeof recordCentralityHits, 'function', 'recordCentralityHits is not exported at the declared import path');
  const record = ac1Record();
  const outgoing = 'Please check whether the quorumite escrow configuration still needs rebalancing.';
  const hits = recordCentralityHits(record, outgoing);
  assert.ok(Array.isArray(hits), 'recordCentralityHits must return an array');
  assert.deepEqual(
    [...hits].sort(),
    ['escrow', 'quorumite'],
    'exactly the two title terms the outgoing text shares — nothing else in this record\'s vocabulary overlaps it'
  );
});

// =========================================================================
// AC3 — TERSE-RECORD DEGENERATE SCALING. Must be unchanged before/after.
// =========================================================================

test('AC3: a record with exactly one extractable own term still needs only that one term present (degenerate scaling unchanged)', async () => {
  await before;
  const record = ac3Record();
  const hit = 'Investigate why the palladium alloy corrodes early in the test rig.';
  const miss = 'Investigate why the vector alloy corrodes early in the test rig.';
  assert.equal(
    hasRecordCentralityHit(record, hit),
    true,
    'min(AXIS_MIN_RECORD_TERMS, 1) === 1, and the one required term is present'
  );
  assert.equal(
    hasRecordCentralityHit(record, miss),
    false,
    'the one required term is absent — the bar must not be silently zeroed by the union logic'
  );
});

// =========================================================================
// AC4 — TYPE COVERAGE (anti_pattern). Expected to FAIL today.
// =========================================================================

test('AC4: anti_pattern title terms outside the trigger-dominated top-6 ARE covered (title-ish union applies per-type, not just to decision)', async () => {
  await before;
  const record = ac4Record();
  const outgoing = 'We need to trigger the palisade escalation review before shipping this build.';
  assert.equal(
    hasRecordCentralityHit(record, outgoing),
    true,
    'anti_pattern title-ish is `title` alone — a per-type mapping bug (wrong field, or anti_pattern omitted) would leave this false'
  );
});
