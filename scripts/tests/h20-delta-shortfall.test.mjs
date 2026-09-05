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
let extractAxisTerms;
before(async () => {
  ({ SterlingStore, MAX_RANK_TERMS } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  // extractAxisTerms is imported from delivery.mjs, NOT the store package
  // directly — this is the SAME import path already proven in
  // scripts/tests/h20-mechanism-axis.test.mjs (its own "the extractor,
  // directly" section calls extractAxisTerms(text, cap) after importing it
  // from exactly this module). delivery.mjs is where H20's own axis-hit
  // machinery consumes the function, so importing it from there — rather
  // than guessing at a re-export off '@sterling/store' — tests against the
  // same instance the hook itself calls.
  ({ extractAxisTerms } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href));
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
 * Reconstructs the corpus an attempt's axis terms are extracted from: the
 * question text plus the header plus every option's label+description,
 * joined into one string. This mirrors the file's own pre-existing (and
 * measured-against-the-live-hook) characterization above ("subTerms is
 * capped at MAX_RANK_TERMS ... this fixture's question+options vocabulary
 * already saturates that cap") — which only holds if extraction runs over
 * question+options combined, not the question alone (a 15-word question by
 * itself would not saturate a 16-term cap). ASSUMPTION, stated plainly: the
 * exact separator and whether the header is included could not be verified
 * without reading h20-mechanism-axis.mjs (denied by the read wall); if this
 * assumption is wrong, the equality assertion below (renderedCount ===
 * computedAdded) will mismatch by a small, likely CONSTANT offset even when
 * the hook is otherwise correct — report that shape, don't silently loosen
 * the assertion to "roughly equal".
 */
function questionCorpus(question, options, header) {
  return [question, header, ...options.map((o) => `${o.label} ${o.description}`)].join(' ');
}

/** The count of NEW axis terms a re-ask contributes, independently computed
 * with the SAME extraction function and cap the hook itself uses — not read
 * back out of the hook's own rendered message. */
function computeAddedTermCount(retryQuestion, options, header) {
  const firstTerms = new Set(extractAxisTerms(questionCorpus(STRICT_QUESTION, STRICT_OPTIONS, header), MAX_RANK_TERMS));
  const retryTerms = extractAxisTerms(questionCorpus(retryQuestion, options, header), MAX_RANK_TERMS);
  return retryTerms.filter((t) => !firstTerms.has(t)).length;
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
    const computedAdded = computeAddedTermCount(retryQuestion, STRICT_OPTIONS, 'Countdown Display');

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
