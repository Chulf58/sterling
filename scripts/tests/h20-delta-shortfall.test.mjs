// H20 RE-ASK DELTA SHORTFALL — regression pins for behaviour that already
// exists in the working tree but is currently unpinned.
//
// SUBJECT: renderDenyOnceMessage in scripts/hooks/lib/delivery.mjs
// (~460-472); shortfall computation in scripts/hooks/h20-mechanism-axis.mjs
// (~453-503); constant DELTA_MIN_NEW_TERMS. Extends the deny-once contract
// already pinned in scripts/tests/h20-deny-once.test.mjs (decision
// 68332e4b-da25-474e-a973-7cb53a0da40b): a retry that cites the denied
// ruling's id but does not add enough NEW vocabulary beyond the original
// denied question is still denied, and — the part this file adds pins for —
// the denial names HOW SHORT the re-ask fell: "re-ask delta: your re-ask
// added N of the >=DELTA_MIN_NEW_TERMS new terms".
//
// This file does NOT edit h20-deny-once.test.mjs, h20-deny-boundary.test.mjs
// or h20-consult-carriage.test.mjs — new, separate suite, same harness idiom
// (spawnSync the hook with JSON stdin under --disable-warning, fixture
// project dir + SterlingStore, envelope/decisionRecord/askQuestion helpers
// copied verbatim from h20-deny-once.test.mjs's own recipe).
//
// CONSTANT DERIVATION (requirement 3 of the brief): the required-count
// number in the message must be read OUT OF THE SOURCE at test time, never
// hardcoded as a literal in this file — so a future change to
// DELTA_MIN_NEW_TERMS (e.g. 5 -> 6) is reflected in what this suite expects
// without editing the suite. readDeltaMinNewTerms() below does that: it
// reads scripts/hooks/h20-mechanism-axis.mjs's own source text at RUN TIME
// (not authored-time inspection by this agent, which the read wall forbids)
// and regexes out the declared value.
//
// EXECUTION DISCLOSURE: this agent has no Bash and cannot run these tests;
// the conductor's red/mutation gate executes them. Per-test expected failure
// shape and named sabotage are stated in the comment above each test.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const MECHANISM_PATH = join(HOOKS, 'h20-mechanism-axis.mjs');
// DELTA_MIN_NEW_TERMS is DECLARED here (lib/delivery.mjs:236) and imported by
// h20-mechanism-axis.mjs — the declaration site is what the reader below greps.
const DELIVERY_PATH = join(HOOKS, 'lib', 'delivery.mjs');

let SterlingStore;
let MAX_RANK_TERMS;
let extractAxisTermsUncapped;
let stripCitations;
let subQuestionText;
let DELTA_TERMS_VERSION;
let extractAxisTerms;
let denyLedgerPath;
let writeDenyLedger;
before(async () => {
  ({ SterlingStore, MAX_RANK_TERMS } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  // extractAxisTermsUncapped / stripCitations / subQuestionText are imported
  // from delivery.mjs, NOT the store package directly, and NOT the OLD
  // (capped, unstripped) extractAxisTerms this file used before decision
  // b34a9f92 (h20-novelty-counted-over-citation-stripped-uncapped-terms,
  // board 98ce3925): novelty is now computed over citation-stripped,
  // UNCAPPED terms, using the SAME shared matcher/extractor the hook itself
  // calls — delivery.mjs is where H20's own axis-hit machinery consumes
  // these functions, so importing from there tests against the same
  // instance, not a re-export guessed off '@sterling/store'.
  //
  // ARM 8 (conductor follow-up) additionally needs: DELTA_TERMS_VERSION (the
  // version stamp a fresh deny-ledger entry is written with), the OLD
  // extractAxisTerms (to construct a deliberately STALE entry.terms
  // representation predating that version), and denyLedgerPath/
  // writeDenyLedger (the ledger's own read/write helpers) so the test can
  // inject staleness through the same file the hook itself reads/writes,
  // rather than guessing at the ledger's on-disk shape from outside.
  ({
    extractAxisTermsUncapped,
    stripCitations,
    subQuestionText,
    DELTA_TERMS_VERSION,
    extractAxisTerms,
    denyLedgerPath,
    writeDenyLedger,
  } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(HOOKS, 'h20-mechanism-axis.mjs')],
    { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 60_000 }
  );
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Substance may land on either stream depending on how the deny is signalled. */
function combined(r) {
  return `${r.stdout}\n${r.stderr}`;
}

/**
 * Reads DELTA_MIN_NEW_TERMS's currently-declared value straight out of its
 * declaring module's source text, at test RUN time. This is what lets every
 * assertion below avoid embedding the literal "5" — if the constant is
 * later bumped, this helper (and therefore the expectations built from it)
 * moves with it, while a message-rendering call site that still hardcodes
 * the old number diverges and gets caught.
 */
function readDeltaMinNewTerms() {
  const src = readFileSync(DELIVERY_PATH, 'utf8');
  const m = src.match(/export const DELTA_MIN_NEW_TERMS\s*=\s*(\d+)/);
  assert.ok(m, 'DELTA_MIN_NEW_TERMS declaration not found in scripts/hooks/lib/delivery.mjs — spec/constant-name mismatch, see brief');
  return Number(m[1]);
}

function shortfallLineRegex(threshold) {
  return new RegExp(`re-ask delta: your re-ask added (\\d+) of the ≥${threshold} new terms`);
}

function extractShortfallCount(text, threshold) {
  const m = text.match(shortfallLineRegex(threshold));
  return m ? Number(m[1]) : null;
}

/**
 * Reconstructs the corpus an attempt's axis terms are extracted from, using
 * the PRODUCTION builder itself (subQuestionText from delivery.mjs) rather
 * than a hand-rolled join — the shape (question + header + option
 * label/description) is now read from the same function the hook calls,
 * not guessed at from outside the read wall.
 */
const corpus = (q, o = STRICT_OPTIONS, h = 'Countdown Display') => subQuestionText({ question: q, header: h, options: o });

/**
 * The count of NEW axis terms a re-ask contributes, independently computed
 * per decision b34a9f92 (h20-novelty-counted-over-citation-stripped-
 * uncapped-terms): both sides are CITATION-STRIPPED (stripCitations, given
 * the ledger record ids the retry is expected to cite) and extracted
 * UNCAPPED (extractAxisTermsUncapped) — never the old capped, unstripped
 * extractAxisTerms this file used before that decision, which let a
 * mandatory uuid citation supply the novelty count for free. Not read back
 * out of the hook's own rendered message.
 */
function computeAddedTermCount(retryQuestion, options, header, recordIds) {
  const first = new Set(extractAxisTermsUncapped(stripCitations(corpus(STRICT_QUESTION, STRICT_OPTIONS, header), recordIds)));
  return extractAxisTermsUncapped(stripCitations(corpus(retryQuestion, options, header), recordIds)).filter((t) => !first.has(t)).length;
}

function envelope(type) {
  return {
    id: randomUUID(),
    type,
    created_at: '2026-09-05T12:00:00.000Z',
    updated_at: '2026-09-05T12:00:00.000Z',
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-delta-'));
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

// --- fixture vocabulary -----------------------------------------------------
//
// STRICT fixture verbatim-equivalent to h20-deny-once.test.mjs's own proven
// STRICT recipe (six domain terms repeated >=3x each) — known to clear the
// strict-deny bar on first attempt. Duplicated here rather than imported,
// per this suite's own convention (a separate, self-contained file).
const STRICT_TITLE = 'Breach countdown seconds display banned for the player';
const STRICT_STATEMENT =
  'No breach countdown may ever display breach countdown seconds to the player; breach countdown seconds ' +
  'display stays hidden from the player during the campaign campaign campaign, regardless of settings menu ' +
  'preference options requested elsewhere in unrelated modules.';
const STRICT_QUESTION = 'Add a breach countdown widget so the player sees the breach countdown seconds display during the campaign.';
const STRICT_OPTIONS = [
  { label: 'Numeric seconds', description: 'Show the breach countdown seconds display to the player numerically' },
  { label: 'Graphical arc', description: 'Show an arc instead of numbers' },
];

/**
 * A SECOND, independent STRICT fixture (S2, conductor follow-up — VERIFIED
 * BY PROBE against the live hook by the hooks coder) — same
 * six-domain-terms-repeated-3x recipe as STRICT above, but with entirely
 * disjoint vocabulary, so a project can deny TWO distinct rulings and hold
 * two genuinely separate deny-ledger entries: measured with both rulings
 * seeded in one store, each denies its own first attempt, and neither names
 * the other.
 */
const STRICT2_TITLE = 'Harbour dredging schedule is never driven by barge tonnage';
const STRICT2_STATEMENT =
  'The harbour dredging schedule is fixed quarterly and never driven by barge tonnage; harbour dredging ' +
  'schedule changes require a quarterly review, and barge tonnage may not shorten the harbour dredging ' +
  'schedule. Quarterly tonnage reports inform the barge operator only, never the dredging schedule itself.';
const STRICT2_QUESTION = 'Let barge tonnage shorten the harbour dredging schedule between quarterly reviews, so a heavy tonnage week re-runs the dredging.';
const STRICT2_OPTIONS = [
  { label: 'Tonnage trigger', description: 'Re-run the harbour dredging schedule whenever barge tonnage passes a quarterly ceiling' },
  { label: 'Manual override', description: 'Let the barge operator shorten the dredging schedule by hand' },
];
const STRICT2_HEADER = 'Dredging Schedule';

/**
 * A re-ask that cites the ruling id and states an ABUNDANT amount of
 * genuinely new, substantive vocabulary — proven-shape reuse of the ALLOWED
 * override example already established (and passing) in
 * h20-deny-once.test.mjs's own "AC (override contract)" test, so this is
 * known-good production behaviour, not a guess.
 */
function abundantDeltaReask(rulingId) {
  return (
    `Override decision ${rulingId}: proceeding to add a breach countdown widget for a debug-only ` +
    'diagnostic overlay visible solely on the developer console — the unresolved delta is that the ' +
    'ruling\'s player-facing display ban never addressed a developer-only diagnostic surface, a materially ' +
    'different audience than "the player" the ruling covers.'
  );
}

/**
 * LOW ARM: cites the ruling id INLINE, using only the ruling's own vocabulary —
 * deliberately avoiding the words "override"/"decision", which are themselves
 * new axis terms relative to the first attempt.
 *
 * MEASURED HEADROOM (conductor, 2026-09-05, against the live hook): the
 * shortfall count and the override threshold share one scale, so a comparative
 * pair only exists strictly BELOW DELTA_MIN_NEW_TERMS, and the window is
 * narrow. subTerms is capped at MAX_RANK_TERMS (16,
 * packages/store/src/index.ts:305) and this fixture's question+options
 * vocabulary already SATURATES that cap, so added novelty DISPLACES existing
 * terms roughly one-for-one instead of accumulating. Measured against the live
 * hook: the bare "Override decision <id>: ..." form already scores 4 (=
 * threshold - 1), and a six-novel-word form crosses the floor and is ALLOWED.
 * Hence the low arm below must shed the citation phrasing's own new terms to
 * leave the high arm anywhere to go.
 */
function fewNewTermsReask(rulingId) {
  return `Per ruling ${rulingId}, the breach countdown seconds display should still show the player the breach countdown during the campaign.`;
}

/** HIGH ARM: the ordinary "Override decision <id>:" citation form, whose own phrasing contributes the extra new axis terms. Still below threshold. */
function moreNewTermsReask(rulingId) {
  return `Override decision ${rulingId}: add a breach countdown widget so the player sees the breach countdown seconds display during the campaign.`;
}

// --------------------------------------------------------------------------
// CONTROL (placed first): a re-ask citing the ruling id with ABUNDANT new
// substantive terms is ALLOWED and carries NO "re-ask delta" shortfall line.
// This must pass for the OPPOSITE reason from the shortfall pins below —
// it rules out "the shortfall line (or a denial) fires on every citing
// retry regardless of how much new vocabulary was actually added".
// --------------------------------------------------------------------------

test('CONTROL: a re-ask citing the ruling id with abundant new substantive terms is ALLOWED and shows no re-ask-delta shortfall line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must actually be denied for this to be a real retry');

    const retry = runHook(askQuestion(dir, abundantDeltaReask(ruling.id), STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 0, 'a retry with abundant new substantive vocabulary must be allowed through');
    assert.doesNotMatch(
      combined(retry),
      /re-ask delta:/,
      'an allowed override must not carry a shortfall line at all — the line is reserved for denials that fell short'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: render the "re-ask delta: ..." line unconditionally on every
// citing retry (allowed or not), instead of only on the shortfall/deny
// branch — this control goes red on the doesNotMatch assertion (the line
// leaks into an allowed retry's output) even though retry.code stays 0.
// A second, cruder sabotage — deny every citing retry unconditionally
// regardless of added vocabulary — flips retry.code to 2 and this control
// goes red on the equal(retry.code, 0) assertion instead.

// --------------------------------------------------------------------------
// 1. CORE: a re-ask citing the ruling id but adding fewer than
// DELTA_MIN_NEW_TERMS new terms is DENIED with the shortfall line, and the
// required-count number in that line is the CONSTANT (read out of source),
// never a hardcoded literal.
// --------------------------------------------------------------------------

test('AC1 + AC3: a re-ask citing the ruling id but adding too few new terms is DENIED with "re-ask delta: your re-ask added N of the >=<DELTA_MIN_NEW_TERMS> new terms", N COMPUTED and equal to the rendered value, the threshold read from source', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const declaredThreshold = readDeltaMinNewTerms();
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must actually be denied for this to be a real retry');

    const retryQuestion = fewNewTermsReask(ruling.id);
    // COMPUTED, not hoped-for: this is what makes the assertion below able to
    // catch a renderer hardcoded to e.g. "added 0" — a hardcoded literal
    // would only coincidentally match computedAdded, and never on a second
    // run with a different minted uuid.
    const computedAdded = computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display', [ruling.id]);

    if (computedAdded >= declaredThreshold) {
      // BRANCH, not a retry loop (chosen deliberately — see file header):
      // this run's minted uuid happened to contribute enough hex-fragment
      // axis terms to cross the override floor by itself. That is not a
      // test failure; it is the ALLOWED shape the CONTROL above already
      // covers, so assert it here too rather than silently skipping (the
      // brief forbids a silent skip) or looping to re-roll a fresh uuid
      // (which would spend attempts hiding the very branch this handles).
      const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
      assert.equal(retry.code, 0, `computed added-term count (${computedAdded}) reached the threshold (${declaredThreshold}) for this run's uuid — the re-ask must be ALLOWED, not denied`);
      assert.doesNotMatch(combined(retry), /re-ask delta:/, 'an allowed override carries no shortfall line, matching the CONTROL above');
      return;
    }

    const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 2, 'a re-ask citing the ruling id but adding too few new terms must still be denied');

    const text = combined(retry);
    const renderedCount = extractShortfallCount(text, declaredThreshold);
    assert.ok(
      renderedCount !== null,
      `denial text must contain the re-ask-delta shortfall line reading "...of the ≥${declaredThreshold} new terms"; got: ${JSON.stringify(text)}`
    );
    assert.equal(
      renderedCount,
      computedAdded,
      `the rendered added-term count (${renderedCount}) must equal the INDEPENDENTLY COMPUTED count (${computedAdded}) for this exact minted uuid — not merely "some digit below threshold"`
    );
    assert.ok(renderedCount < declaredThreshold, `the reported added-term count (${renderedCount}) must itself be below the declared threshold (${declaredThreshold}) — that is what makes it a shortfall`);
  } finally {
    cleanup();
  }
});
// SABOTAGE (AC1): drop the "re-ask delta: ..." line from the shortfall deny
// branch entirely (keep denying, but revert to the generic deny-once
// message with no shortfall accounting) — this test goes red on the
// `renderedCount !== null` assertion (extractShortfallCount returns null)
// even though retry.code still correctly reads 2.
// SABOTAGE (AC3): hardcode the rendered threshold text to a literal "5"
// (e.g. a template literal with `5` typed in directly instead of
// interpolating DELTA_MIN_NEW_TERMS) while the constant declaration itself
// is later bumped to a different value (e.g. 5 -> 6) without updating the
// hardcoded render call site — since this test derives declaredThreshold by
// re-reading the SAME constant declaration from source at run time, the
// regex it builds would expect ">=6" while the hardcoded renderer still
// emits ">=5", so extractShortfallCount returns null and
// `renderedCount !== null` goes red.
// SABOTAGE (count realness — the gap this rewrite closes): hardcode the
// rendered "added N" number to a fixed digit (e.g. always render "added 0")
// while still gating denial correctly on the real count internally — this
// test goes red on `assert.equal(renderedCount, computedAdded, ...)` (a
// hardcoded "0" will not equal the independently computed count, which for
// this fixture is always > 0 since the retry text itself contributes at
// least the ruling id's own hex fragments as new terms). The OLD version of
// this test (count !== null && count < threshold) would NOT have caught this
// sabotage: a hardcoded "0" is non-null and trivially below any positive
// threshold.

// --------------------------------------------------------------------------
// 2. COMPARATIVE: proves the reported count is COMPUTED from the actual
// re-ask content, not a fixed literal — two shortfall re-asks with a
// strictly different number of genuinely new content words must report
// strictly different counts.
// --------------------------------------------------------------------------

// COMPARATIVE ARM REMOVED, count realness CLOSED A DIFFERENT WAY (conductor,
// measured 2026-09-05, board: h20 override-floor term accounting).
//
// The originally-intended arm was anti-hollow: two re-asks of differing
// novelty must report DIFFERENT shortfall counts, so a hardcoded digit
// cannot satisfy the AC1 regex. It could not be built as a same-suite
// COMPARISON between two fixture strings, for two measured reasons that
// still hold and are kept here as the record of why:
//
//  1. NO WINDOW. The shortfall count and the override floor share one scale, so
//     both arms must land strictly below DELTA_MIN_NEW_TERMS (5). The ordinary
//     "Override decision <id>: ..." citation form already scores 3-4, and a
//     six-novel-word form CROSSES the floor and is allowed. subTerms is capped
//     at MAX_RANK_TERMS (16, packages/store/src/index.ts:305) and this
//     fixture's question+options vocabulary saturates it, so added novelty
//     DISPLACES existing terms roughly one-for-one rather than accumulating:
//     measured +0/+1/+3 novel words all produced the SAME count.
//
//  2. NOT DETERMINISTIC. extractAxisTerms treats a cited UUID's hex segments as
//     axis terms — a random v4 id contributes 4-5 of them (measured over six
//     ids). So the count moves with whichever uuid the fixture happened to
//     mint, and two runs of byte-identical fixture text reported 4 and then 3.
//
// What was previously "the one thing currently unpinned" — a rendering call
// site that hardcoded the "added N" number while the threshold kept coming
// from the constant — is now closed by the AC1 test above WITHOUT a same-
// suite comparative arm: rather than comparing two fixture strings against
// EACH OTHER, it computes the expected count directly via extractAxisTerms
// + MAX_RANK_TERMS (imported, not read-and-parsed) against THIS RUN's exact
// minted uuid, then asserts the rendered value equals that computation. A
// hardcoded "added 0" now fails on that equality every single run, since the
// computed value is never 0 for this fixture (the retry text always
// contributes at least the ruling id's own hex fragments as new terms) —
// this needed the term accounting to be CALLABLE from a test, not fixed,
// which it already was (extractAxisTerms/MAX_RANK_TERMS are exported); no
// production change was required.

// --------------------------------------------------------------------------
// 3. AC2: a FIRST attempt's deny text never contains "re-ask delta" — the
// shortfall accounting is reserved for a citing retry, not the initial deny.
// --------------------------------------------------------------------------

test('AC2: a FIRST-attempt (non-citing) denial never contains "re-ask delta"', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'the first attempt must be denied for this to be a meaningful "no re-ask delta" pin');
    assert.doesNotMatch(
      combined(first),
      /re-ask delta:/,
      'a plain first-attempt denial (no citation, no retry) must never render the re-ask-delta shortfall line'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: render the shortfall/"re-ask delta" line unconditionally on
// every deny (first attempt included), rather than gating it on "this is a
// retry citing a previously-denied ruling id" — this test goes red (the
// doesNotMatch assertion fails; the line appears on the very first denial).

// --------------------------------------------------------------------------
// 4. NEW ARMS (decision b34a9f92 — h20-novelty-counted-over-citation-
// stripped-uncapped-terms — board 98ce3925): novelty is now computed over
// citation-stripped, UNCAPPED terms. Each arm pins one shape off the
// decision's own pin list: "bare full-uuid citation + 0 content words -> 0
// new terms; 8-char-prefix citation -> 0; +0/+2 filler/+5 content -> 0/0/5
// ... two runs same count; a verbose re-ask (>16 surviving tokens) with +5
// content words still clears."
//
// NAMED SABOTAGES for arms 1-4 (each restores a piece of the OLD, broken
// accounting the decision replaced — apply one, confirm it landed, then
// run):
//  - restoring the OLD capped, unstripped accounting (reverting
//    deltaTermsFor at h20-mechanism-axis.mjs to filter over
//    p.subTerms/entry.terms instead of the new stripCitations +
//    extractAxisTermsUncapped pair) makes arms 1-4 report ~3-5 new terms
//    instead of 0 — the ruling id's own hex fragments count as novel again.
//  - dropping the GENERIC full-uuid stripping pass from stripCitations (so
//    only the CITED entry's own id/prefix is stripped, never an unrelated
//    full uuid) raises arm 3's computed count above 0: the second,
//    unrelated uuid in "(see also <uuid>)" would then count as new terms.
//  - dropping the citation-BOILERPLATE stripping ("Override decision",
//    the trailing ":") from stripCitations makes arms 1-4 report 2 instead
//    of 0 — the citation phrasing's own words survive as new terms.
// --------------------------------------------------------------------------

test('NEW ARM 1: a bare full-uuid citation with no other content contributes zero new terms', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const declaredThreshold = readDeltaMinNewTerms();
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');

    const retryQuestion = `Override decision ${ruling.id}: ${STRICT_QUESTION}`;
    const computedAdded = computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display', [ruling.id]);
    assert.equal(computedAdded, 0, 'a bare full-uuid citation must contribute zero new terms once uuids and citation boilerplate are stripped before extraction');

    const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 2, 'a bare citation with no added vocabulary must still be denied');
    assert.equal(
      extractShortfallCount(combined(retry), declaredThreshold),
      0,
      'the rendered shortfall count must match the independently computed zero'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: see the NAMED SABOTAGES block above — restoring the old
// capped/unstripped accounting or dropping the boilerplate-strip pass both
// push computedAdded / the rendered count above 0, failing the two
// assert.equal(..., 0) calls above.

test('NEW ARM 2: an 8-char-prefix citation of the ruling id also contributes zero new terms', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const declaredThreshold = readDeltaMinNewTerms();
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');

    const retryQuestion = `Override decision ${ruling.id.slice(0, 8)}: ${STRICT_QUESTION}`;
    const computedAdded = computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display', [ruling.id]);
    assert.equal(computedAdded, 0, 'an 8-char-prefix citation of the KNOWN cited ruling id must be stripped like the full uuid');

    const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 2, 'an 8-char-prefix citation with no added vocabulary must still be denied');
    assert.equal(
      extractShortfallCount(combined(retry), declaredThreshold),
      0,
      'the rendered shortfall count must match the independently computed zero'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the KNOWN-8-char-prefix half of stripCitations (strip only
// full uuids, never the cited entry's own prefix) — the surviving prefix
// token (e.g. "31a22fa1") counts as a new term and both assert.equal(...,0)
// calls above fail.

test('NEW ARM 3: a second, unrelated uuid pasted alongside the citation adds nothing — the exploit the recordIds-intersection check never covered', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const declaredThreshold = readDeltaMinNewTerms();
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');

    const retryQuestion = `Override decision ${ruling.id} (see also ${randomUUID()}): ${STRICT_QUESTION}`;
    const computedAdded = computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display', [ruling.id]);
    assert.equal(computedAdded, 0, 'a second, unrelated full uuid must be stripped generically — pasting one uuid should never buy free novelty');

    const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 2, 'a citation plus one unrelated pasted uuid with no other content must still be denied');
    assert.equal(
      extractShortfallCount(combined(retry), declaredThreshold),
      0,
      'the rendered shortfall count must match the independently computed zero'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: narrow stripCitations to strip only the CITED entry's own
// uuid/prefix (the rejected alternative "Strip only the cited record's
// uuid" the decision names by name) instead of every canonical full uuid in
// the text — the second, unrelated uuid then survives as new hex-fragment
// terms and both assert.equal(...,0) calls above fail.

test('NEW ARM 4: citation-phrasing filler ("and then") adds nothing — filler is not content', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const declaredThreshold = readDeltaMinNewTerms();
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');

    const retryQuestion = `Override decision ${ruling.id}: ${STRICT_QUESTION} and then`;
    const computedAdded = computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display', [ruling.id]);
    assert.equal(computedAdded, 0, 'two bare filler words must not register as new content terms');

    const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 2, 'a citation plus bare filler with no substantive content must still be denied');
    assert.equal(
      extractShortfallCount(combined(retry), declaredThreshold),
      0,
      'the rendered shortfall count must match the independently computed zero'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: see the NAMED SABOTAGES block above — dropping the
// boilerplate-strip pass (which arms 1-4 share) makes this arm report 2
// instead of 0, failing both assert.equal(..., 0) calls above.

test('NEW ARM 5: five genuinely new content words clear the floor and carry no shortfall line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');

    const retryQuestion =
      `Override decision ${ruling.id}: ${STRICT_QUESTION} ` +
      'The unresolved delta concerns telemetry instrumentation.';
    const computedAdded = computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display', [ruling.id]);
    assert.equal(computedAdded, 5, 'five distinct new content words (unresolved/delta/concerns/telemetry/instrumentation) must be counted');

    const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 0, 'five new content terms must clear the override floor');
    assert.doesNotMatch(combined(retry), /re-ask delta:/, 'an allowed override carries no shortfall line at all');
  } finally {
    cleanup();
  }
});
// SABOTAGE: reintroduce the 16-term retrieval cap into the novelty count
// (i.e. call extractAxisTerms(text, MAX_RANK_TERMS) instead of
// extractAxisTermsUncapped for either side) — for this saturated fixture the
// five new content words get evicted/displaced instead of accumulated,
// computedAdded drops below 5, retry.code flips to 2, and both the
// assert.equal(computedAdded, 5) and assert.equal(retry.code, 0) lines fail.

test('NEW ARM 6 (VERBOSE): a re-ask whose surviving term set exceeds MAX_RANK_TERMS still reports the true 5-word content delta', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');

    const retryQuestion =
      `Override decision ${ruling.id}: ${STRICT_QUESTION} ` +
      'Show the breach countdown seconds display to the player numerically, or show an arc instead of numbers during the campaign. ' +
      'The unresolved delta concerns telemetry instrumentation.';

    const survivingTerms = extractAxisTermsUncapped(stripCitations(corpus(retryQuestion), [ruling.id]));
    assert.ok(
      survivingTerms.length > MAX_RANK_TERMS,
      `FIXTURE LIVENESS: the verbose re-ask must surface more surviving terms than the retrieval cap (${MAX_RANK_TERMS}) so this arm actually exercises the uncapped path — got ${survivingTerms.length}`
    );

    const computedAdded = computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display', [ruling.id]);
    assert.equal(computedAdded, 5, 'the true content delta stays 5 regardless of how many terms the verbose re-ask surfaces in total');

    const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 0, 'five new content terms must clear the override floor even inside a verbose re-ask');
    assert.doesNotMatch(combined(retry), /re-ask delta:/, 'an allowed override carries no shortfall line at all');
  } finally {
    cleanup();
  }
});
// SABOTAGE: reintroduce the 16-term retrieval cap into the novelty count —
// the verbose re-ask's own repeated/echoed option vocabulary crowds out the
// five genuinely new content words once capped, so computedAdded no longer
// equals 5 and/or retry.code no longer equals 0, failing the corresponding
// assertions above.

test('NEW ARM 7 (DETERMINISM): two independently-minted rulings produce the SAME computed count for the identical bare-citation shape', () => {
  const counts = [];
  for (let i = 0; i < 2; i += 1) {
    const { dir, store, cleanup } = makeProject();
    try {
      const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
      const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
      assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');
      const retryQuestion = `Override decision ${ruling.id}: ${STRICT_QUESTION}`;
      counts.push(computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display', [ruling.id]));
    } finally {
      cleanup();
    }
  }
  assert.deepEqual(counts, [0, 0], 'the arm-1 bare-citation shape must compute to zero regardless of which random uuid was minted — a uuid-dependent count is exactly the nondeterminism the decision closes');
});
// SABOTAGE: revert to the OLD unstripped-uuid accounting (extractAxisTerms
// over the raw, un-stripped corpus) — each minted uuid's hex fragments then
// contribute a random-looking handful of "new" terms (measured 4-5 per id
// over six random ids in the board evidence), so the two counts are no
// longer both 0 and assert.deepEqual(counts, [0, 0]) fails.

// --------------------------------------------------------------------------
// 5. ARM 8 (conductor follow-up, same fixture/harness as arms 1-7):
// stale-representation re-seed. A deny-ledger entry persisted BEFORE
// DELTA_TERMS_VERSION existed (or otherwise missing/behind it) must not be
// trusted outright for the override check — it is re-seeded and the re-ask
// that triggered the re-seed is denied ONCE MORE (forced unresolved, never
// itself compared against a real baseline).
//
// RE-SEED SEMANTICS, REVISED (conductor follow-up, outside-review laundering
// hole): the re-seeded entry's terms are the UNION of the OLD (stale) terms
// and the current attempt's citation-stripped, uncapped terms — NEVER a
// REPLACEMENT of old-with-current. A replacement re-seed launders: an
// attacker could cite the id once with abundant vocabulary to seed a fresh
// baseline, then repeat the IDENTICAL text next session and be waved through
// with zero actual new terms relative to that freshly-planted baseline. The
// union closes this: a repeat of the SAME re-seeding text against the union
// baseline it just wrote reports ZERO new terms (its own terms are already
// IN the union) and is denied again — only text carrying genuinely NEW
// vocabulary beyond that union clears the floor.
//
// LEDGER SHAPE (conductor follow-up, gate-run-verified): the ledger object is
// `{entries: {<recordId>: {...}}, overrides: [...]}`, keyed by the cited
// record's id — NOT an array and not a flat map of unknown keys. The single
// entry after the first denial lives at `ledger.entries[ruling.id]`.
//
// WRITE SIGNATURE (conductor follow-up, gate-run-verified): writeDenyLedger's
// FIRST argument is the ledger FILE PATH itself (it writes tmp+rename onto
// that exact path), not the project dir — calling it with `dir` throws
// EISDIR renaming the tmp file onto a directory. The correct call is
// writeDenyLedger(denyLedgerPath(dir, undefined), ledgerBefore), writing
// back the WHOLE ledger object (entries + overrides), not just the mutated
// entry, and re-reading through that same resolved path.
// --------------------------------------------------------------------------

/** True iff every element of `subsetArr` is present in `supersetArr`. */
function isSuperset(supersetArr, subsetArr) {
  const s = new Set(supersetArr);
  return subsetArr.every((t) => s.has(t));
}

test('CONTROL (ARM 8 baseline, placed FIRST — must pass for the OPPOSITE reason from ARM 8): without any ledger mutation, abundantDeltaReask is ALLOWED on the very first re-ask', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');

    const retry = runHook(askQuestion(dir, abundantDeltaReask(ruling.id), STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(
      retry.code,
      0,
      'CONTROL BROKEN: without any ledger mutation, an abundant re-ask must be allowed on the very first retry — if this is not 0, ARM 8 below proves nothing about the stale-representation re-seed specifically, since a second denial would happen regardless of ledger freshness',
    );
    assert.doesNotMatch(combined(retry), /re-ask delta:/, 'CONTROL BROKEN: an allowed override carries no shortfall line');
  } finally {
    cleanup();
  }
});
// SABOTAGE: any change that unconditionally requires two citing-retry
// cycles before allowing an override (regardless of ledger freshness) flips
// this control red — which would mean ARM 8's own step-1-denied assertion
// is not attributable to the injected staleness at all.

test('ARM 8 (stale-representation re-seed, UNION semantics): a deny-ledger entry predating DELTA_TERMS_VERSION is re-seeded onto the UNION of old+current terms, forced unresolved, and a bare repeat is still denied (the laundering pin) — only genuinely new vocabulary beyond the union clears the floor', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const declaredThreshold = readDeltaMinNewTerms();
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt seeds the deny ledger');

    const ledgerPath = denyLedgerPath(dir, undefined);
    const ledgerBefore = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.equal(
      Object.keys(ledgerBefore.entries ?? {}).length,
      1,
      `FIXTURE LIVENESS: exactly one deny-ledger entry must exist after the first denial; got: ${JSON.stringify(ledgerBefore)}`
    );
    const entry = ledgerBefore.entries[ruling.id];
    assert.ok(entry, `FIXTURE LIVENESS: the single ledger entry must be keyed by the cited ruling's id (${ruling.id}); got keys: ${Object.keys(ledgerBefore.entries)}`);
    delete entry.terms_version;
    // The OLD (pre-decision) representation: capped, computed over the FIRST
    // attempt's own text, which carries no citation at all — nothing here
    // needs stripping, so this doubles as "the stripped old terms" verbatim.
    const oldTerms = extractAxisTerms(
      subQuestionText({ question: STRICT_QUESTION, header: 'Countdown Display', options: STRICT_OPTIONS }),
      MAX_RANK_TERMS
    );
    entry.terms = oldTerms;
    writeDenyLedger(ledgerPath, ledgerBefore);

    // --- STEP 1: the abundant re-ask against the stale v1 entry ----------
    const abundant = abundantDeltaReask(ruling.id);
    const abundantCurrentTerms = extractAxisTermsUncapped(stripCitations(corpus(abundant), [ruling.id]));
    const step1 = runHook(askQuestion(dir, abundant, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(
      step1.code,
      2,
      'STALE-REPRESENTATION SHAPE (RED before the fix): a ledger entry missing terms_version (the OLD, pre-decision representation) must be re-seeded and denied ONCE MORE — the re-seeding attempt is FORCED UNRESOLVED, never itself compared against a real baseline',
    );
    assert.doesNotMatch(combined(step1), /re-ask delta:/, 'the re-seed denial is not a shortfall denial — it never got to compare against a fresh baseline on this attempt');

    const ledgerAfter1 = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.equal(Object.keys(ledgerAfter1.entries ?? {}).length, 1, 'still exactly one deny-ledger entry after the re-seed');
    const entryAfter1 = ledgerAfter1.entries[ruling.id];
    assert.ok(entryAfter1, `the re-seeded entry must still be keyed by the cited ruling's id (${ruling.id}); got keys: ${Object.keys(ledgerAfter1.entries)}`);
    assert.equal(entryAfter1.terms_version, DELTA_TERMS_VERSION, 'the persisted entry must be stamped with the CURRENT terms_version after the re-seed');
    // UNION, not replacement — asserted both ways (superset, not deepEqual):
    // the re-seeded entry must carry EVERY current-attempt term AND EVERY
    // old term, because a REPLACEMENT re-seed is exactly the laundering hole
    // outside review found (see the file-header note above this test).
    assert.ok(
      isSuperset(entryAfter1.terms, abundantCurrentTerms),
      `UNION SHAPE: the re-seeded entry must carry every term of the CURRENT re-ask's citation-stripped, uncapped representation. Persisted terms: ${JSON.stringify(entryAfter1.terms)}; current terms: ${JSON.stringify(abundantCurrentTerms)}`
    );
    assert.ok(
      isSuperset(entryAfter1.terms, oldTerms),
      `UNION SHAPE: the re-seeded entry must ALSO still carry every term of the OLD (stale) representation — a REPLACEMENT re-seed would drop these. Persisted terms: ${JSON.stringify(entryAfter1.terms)}; old terms: ${JSON.stringify(oldTerms)}`
    );

    // --- STEP 2 (THE LAUNDERING PIN): the SAME abundant text again --------
    // Its own terms are already IN the union the re-seed just wrote, so it
    // contributes ZERO new terms against that baseline and must be denied
    // again — a repeat can never launder itself into an override.
    const step2 = runHook(askQuestion(dir, abundant, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(
      step2.code,
      2,
      'LAUNDERING SHAPE (RED under a replacement re-seed): a bare repeat of the exact re-seeding text must still be denied — its own terms are already inside the union baseline, so it adds zero new terms',
    );
    assert.equal(
      extractShortfallCount(combined(step2), declaredThreshold),
      0,
      'the repeat computes to exactly zero new terms against the union baseline'
    );

    // --- STEP 3: the abundant text PLUS genuinely new content words ------
    // "unresolved" and "delta" are NOT novel here — abundantDeltaReask's own
    // text already reads "...the unresolved delta is that the ruling's...",
    // so those two words are already inside the union baseline. An earlier
    // draft of this sentence ("The unresolved delta concerns telemetry
    // instrumentation cadence.") therefore added only 4 new terms
    // (instrumentation, telemetry, concerns, cadence) — one short of
    // DELTA_MIN_NEW_TERMS — and step3 wrongly stayed denied. This sentence
    // avoids both repeated words and adds six genuinely novel tokens,
    // measured through the production extractor.
    const step3Question = `${abundant} Concerns telemetry instrumentation cadence sampling drift.`;
    const step3 = runHook(askQuestion(dir, step3Question, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(step3.code, 0, 'text carrying genuinely NEW vocabulary beyond the union baseline must clear the floor');
    assert.doesNotMatch(combined(step3), /re-ask delta:/, 'an allowed override carries no shortfall line');
  } finally {
    cleanup();
  }
});
// SABOTAGE (verbatim, conductor follow-up): dropping the terms_version guard
// at h20-mechanism-axis.mjs:487 makes step1.code read 0 instead of 2 (the
// stale entry is trusted outright, never re-seeded) — the
// `assert.equal(step1.code, 2, ...)` line goes red.
// SABOTAGE (verbatim, conductor follow-up): keeping the guard but dropping
// its `continue` grants the override off the freshly re-seeded terms on the
// SAME attempt — step1.code again reads 0 instead of 2, failing the same
// assertion, but via a different code path (the re-seed write itself is
// correct; only the early-grant on the re-seeding attempt is wrong).
// SABOTAGE (verbatim, conductor follow-up — THE LAUNDERING HOLE): re-seed by
// REPLACEMENT (entry.terms = abundantCurrentTerms) instead of UNION — the
// `isSuperset(entryAfter1.terms, oldTerms)` assertion goes red immediately
// (the old terms are gone), AND EVEN IF that assertion were skipped, step2
// would return 0 instead of 2 (a bare repeat now computes its own terms
// against a baseline that IS exactly its own terms via replacement, netting
// zero new terms by coincidence rather than by union-inclusion — the
// distinguishing case is any repeat containing tokens absent from BOTH old
// and current, which a pure replacement baseline would also wrongly permit
// on a subsequent unrelated repeat; the union baseline does not). A third,
// narrower sabotage — re-seeding correctly (union) but never persisting
// DELTA_TERMS_VERSION or the widened terms onto the entry — would still deny
// step1 correctly (masking the defect from step1.code alone) but fails the
// `entryAfter1.terms_version`/superset assertions, and step2 would
// incorrectly read 2 for the wrong reason (stale terms_version re-triggering
// the re-seed guard on every subsequent attempt) rather than converging.

// --------------------------------------------------------------------------
// 6. S1 (conductor follow-up, VERIFIED BY PROBE against the live hook by the
// hooks coder): a re-ask that RETRIEVES the cited ruling via partial
// vocabulary overlap (through its OPTIONS) but fails STRICT full-coverage
// matching — the record's narrow top-6 terms include "campaign", which
// lives only in STRICT_QUESTION and is deliberately omitted here — must
// still resolve the ruling BY ID, contribute zero new terms, and be denied
// with a settled row naming it.
// --------------------------------------------------------------------------

test('S1: a re-ask that retrieves the ruling via partial vocabulary overlap but fails STRICT full-coverage matching still resolves it by id, contributes zero new terms, and is denied with a settled row beneath the header', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must be denied for this to be a real retry');

    // Deliberately omits "campaign" — present only in STRICT_QUESTION and
    // part of the record's narrow top-6 — so this re-ask RETRIEVES the
    // ruling (its own text plus STRICT_OPTIONS overlaps the record) but
    // fails STRICT full-coverage matching, contributing zero new terms.
    const retryQuestion = `Override decision ${ruling.id}: show the breach countdown seconds display to the player.`;
    const retry = runHook(askQuestion(dir, retryQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 2, 'a re-ask that retrieves the ruling but fails strict full-coverage matching (0 new terms) must still be denied');

    const text = combined(retry);
    assert.match(text, new RegExp(ruling.id), 'the denial must name the cited ruling by id');
    assert.match(
      text,
      /— ".*" → decision \[/,
      'a settled row must render BENEATH the header — a header with nothing beneath it means the ruling was cited but never actually surfaced as a real, named record'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: resolve cited records from the retrieval pool ONLY, with no
// direct id-lookup fallback for a re-ask whose OWN relevance score falls
// short of the retrieval floor — note this specific fixture still overlaps
// the record via STRICT_OPTIONS, so it does not by itself force `decisions`
// to `[]`; what this arm actually pins is that CITING the id resolves the
// exact record and renders its settled row even when the re-ask's own
// coverage of the record's terms is incomplete (strict match fails, 0 new
// terms) — a renderer that only shows a settled row for a STRICT match would
// print the header with nothing beneath it here, and both text assertions
// above would go red.

// --------------------------------------------------------------------------
// 7. S2 (conductor follow-up): a MALFORMED sibling deny-ledger entry (terms
// not an array) must be dropped LOUDLY (P5) rather than crashing the whole
// deny-once check or silently laundering the malformed entry into an
// override. CONTROL is placed FIRST: the identical two-ruling ledger,
// UNMUTATED, must deny a shortfall re-ask against the valid ruling exactly
// as it would with only one ruling on the ledger — proving S2's denial is
// not merely "two rulings on the ledger changes behaviour" on its own.
// --------------------------------------------------------------------------

test('S2 (CONTROL, placed FIRST — must pass for the OPPOSITE reason): a two-ruling ledger, UNMUTATED, denies a shortfall re-ask against the valid ruling identically to the single-ruling case', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const rulingA = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const rulingB = store.create(decisionRecord(STRICT2_TITLE, STRICT2_STATEMENT));
    const firstA = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(firstA.code, 2, 'setup: ruling A denies its own first attempt');
    const firstB = runHook(askQuestion(dir, STRICT2_QUESTION, STRICT2_OPTIONS, STRICT2_HEADER), dir);
    assert.equal(firstB.code, 2, 'setup: ruling B denies its own first attempt');

    const retry = runHook(askQuestion(dir, fewNewTermsReask(rulingA.id), STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(
      retry.code,
      2,
      'CONTROL BROKEN: an unmutated two-ruling ledger must still deny a shortfall re-ask against ruling A — if this is not 2, S2 below proves nothing about the malformed-entry handling specifically',
    );
    assert.match(combined(retry), /re-ask delta:/, 'CONTROL: the ordinary shortfall line still renders with two valid entries on the ledger');
  } finally {
    cleanup();
  }
});
// SABOTAGE: any change that stops denying a plain shortfall re-ask once a
// SECOND ruling is on the ledger (e.g. an accidental cross-ruling term leak)
// flips this control red — which would mean S2's own denial is not
// attributable to the malformed-entry handling at all.

test('S2: a malformed sibling deny-ledger entry (non-array terms) is dropped with a loud stderr line, while the VALID entry still denies a shortfall re-ask normally', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const rulingA = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const rulingB = store.create(decisionRecord(STRICT2_TITLE, STRICT2_STATEMENT));
    const firstA = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(firstA.code, 2, 'setup: ruling A denies its own first attempt');
    const firstB = runHook(askQuestion(dir, STRICT2_QUESTION, STRICT2_OPTIONS, STRICT2_HEADER), dir);
    assert.equal(firstB.code, 2, 'setup: ruling B denies its own first attempt');

    const ledgerPath = denyLedgerPath(dir, undefined);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    assert.equal(
      Object.keys(ledger.entries ?? {}).length,
      2,
      `FIXTURE LIVENESS: exactly two deny-ledger entries must exist after denying two distinct rulings; got: ${JSON.stringify(ledger)}`
    );
    assert.ok(ledger.entries[rulingA.id], `FIXTURE LIVENESS: ruling A's entry must be present (id ${rulingA.id})`);
    assert.ok(ledger.entries[rulingB.id], `FIXTURE LIVENESS: ruling B's entry must be present (id ${rulingB.id})`);
    ledger.entries[rulingB.id].terms = 7; // malformed: not an array at all
    writeDenyLedger(ledgerPath, ledger);

    const retry = runHook(askQuestion(dir, fewNewTermsReask(rulingA.id), STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 2, 'a shortfall re-ask against the VALID ruling A must still be denied despite a malformed sibling entry on the ledger');
    assert.match(combined(retry), /re-ask delta:/, 'the shortfall line still renders for the valid entry');
    assert.match(
      retry.stderr,
      /dropped 1 malformed deny-once ledger entry/,
      'the malformed sibling entry is dropped LOUDLY, not silently swallowed or allowed to crash the whole check (P5)'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: read the ledger unvalidated and iterate straight into
// entry.recordIds (or an equivalent field) on the malformed entry — the
// access throws, the whole deny-once check fails, and the question is
// ALLOWED (retry.code reads 0) instead of denied; the
// `assert.equal(retry.code, 2, ...)` line goes red.
