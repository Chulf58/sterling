// H20 ASKUSERQUESTION DENY-ONCE PRE-STEP — SPEC ONLY, red-first.
//
// Spec source (authoritative, read directly — not inferred from any
// implementation): decision 68332e4b-da25-474e-a973-7cb53a0da40b
// (slug askuserquestion-deny-once-pre-step-a-strong-store-match-deni),
// board item 237ac64d-8fbb-41a9-9b5a-678c9bca96fe.
//
// Every prior h20-mechanism-axis test asserts "no path through this hook may
// exit 2" (AC7, universal). Decision 68332e4b NARROWLY amends that for the
// AskUserQuestion surface only: a first-attempt question whose subject
// STRONGLY matches a store ruling is now DENIED (exit 2), carrying the
// ruling's substance (incl. status/supersession/scope) so the denial cannot
// be laundered around; a retry that explicitly cites the delivered ruling id
// and states the unresolved delta is allowed and logged; a bare re-ask or a
// paraphrase without that citation stays denied; a multi-question form is
// denied whole when ANY sub-question strongly matches, naming which items are
// settled and which remain open for resubmission; one recall pool (built with
// the store's canonical rank_terms extraction) feeds two thresholds — loose
// for the pre-existing non-blocking post-answer audit (unchanged), strict for
// deny eligibility. Task|Agent dispatch delivery (the non-AskUserQuestion
// path) is NOT covered by this file — see h20-mechanism-axis.test.mjs.
//
// DENY MECHANISM ASSUMPTION (disclosed, not read from implementation): every
// other blocking hook in this suite (H3/H14/H15/H18 — see
// scripts/tests/h15-precision.test.mjs etc.) signals a deny via exit code 2
// with the reason on stderr; a repo-wide search for a JSON
// permissionDecision/"block" convention turned up zero precedent. This file
// follows that unanimous convention: r.code === 2 is the authoritative deny
// signal; substance assertions match against COMBINED stdout+stderr so a
// message landing on either stream still pins correctly.
//
// LOG ARTIFACT (tightened per roster review, 2026-08-24): the override log is
// .sterling/transient/delivery/deny-ledger-conductor.json, an
// { overrides: [...] } file. That same file is ALSO written by the plain
// DENIAL path (it records the denial's matched record ids there too), so a
// bare "the ledger contains the ruling id" check is satisfiable by the first
// (denied) attempt alone and never actually distinguishes a real override
// from a call that merely got denied — hollow. The pin below asserts the
// BEFORE/AFTER differential instead: no overrides[] entry for this ruling
// exists after the deny, and one does exist after the override retry.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { renderDenyOnceMessage } from '../hooks/lib/delivery.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-24T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  // Match production invocation (hooks.json, decision fedc4e84): every hook is
  // spawned with --disable-warning=ExperimentalWarning. Without it, Node 24's
  // two-line node:sqlite ExperimentalWarning lands on stderr and gets counted
  // by messageLines()/combined(), inflating a true 3-line message to 5 lines.
  // Measuring what production actually emits, not post-filtering stderr, is
  // the truthful fix.
  const r = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(HOOKS, 'h20-mechanism-axis.mjs')],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      cwd,
      timeout: 60_000,
    }
  );
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Substance may land on either stream depending on how the deny is signalled. */
function combined(r) {
  return `${r.stdout}\n${r.stderr}`;
}

/**
 * Non-empty, trimmed lines — normalizes the stdout+stderr join in combined()
 * (which always inserts one joining '\n', producing a spurious blank line
 * when all content lands on a single stream) so line-count pins measure the
 * message's own structure, not the test harness's stream-join artifact.
 */
function messageLines(text) {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-deny-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Single-question AskUserQuestion PreToolUse shape (verbatim idiom from h20-mechanism-axis.test.mjs). */
function askQuestion(dir, question, options = [], header = 'Choice') {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question, header, multiSelect: false, options }] },
    cwd: dir,
  };
}

/** Multi-question form — same tool, `questions` array carries more than one entry. */
function askForm(dir, questions) {
  return { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions }, cwd: dir };
}

// Ledger path + shape per roster-review finding (2026-08-24): the deny-once
// pre-step's override log is .sterling/transient/delivery/deny-ledger-conductor.json,
// an { overrides: [...] } file whose entries carry a deny-intent key + recordIds.
// This is the SAME file the first (denied) attempt already writes to (it
// records the denial's matched record ids there too) — so a bare
// "does the ledger contain the ruling id" check is satisfied by the FIRST
// attempt alone and never distinguishes a real override from one that merely
// deny-logged. The differential (absent before the override retry, present
// after) is what makes this pin bind to the override path specifically.
function ledgerPath(dir) {
  return join(dir, '.sterling', 'transient', 'delivery', 'deny-ledger-conductor.json');
}

function readOverrides(dir) {
  const p = ledgerPath(dir);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data.overrides) ? data.overrides : [];
  } catch {
    return [];
  }
}

function hasOverrideEntryFor(overrides, recordId) {
  return overrides.some((o) => (Array.isArray(o.recordIds) ? o.recordIds.includes(recordId) : JSON.stringify(o).includes(recordId)));
}

// --- fixture vocabulary -------------------------------------------------
//
// STRICT fixture: six domain terms (breach/countdown/seconds/display/player/
// campaign) repeated >=3x each across title+statement, mirroring the proven
// centrality-saturation recipe from h20-centrality.test.mjs — built to clear
// not just the existing minimal floors but whatever stricter deny bar sits
// above them.
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

// WEAK fixture: verbatim reuse of the EXISTING, already-passing
// h20-mechanism-axis.test.mjs AskUserQuestion fixture (proven today to clear
// the CURRENT non-blocking audit floor at low saturation — freq-1 terms, no
// tripled repetition). Decision 68332e4b states "the existing post-answer
// audit stays" unchanged, so this exact pair must remain non-denied; if it
// were denied, h20-mechanism-axis.test.mjs's own regression test for it would
// also break.
const WEAK_TITLE = 'Breach timing is never shown to the player';
const WEAK_STATEMENT = 'No surface may display when the next breach arrives — no seconds, no minutes, no numeric or graphical countdown.';
const WEAK_QUESTION = 'How should the breach countdown be displayed?';
const WEAK_OPTIONS = [
  { label: 'Numeric seconds', description: 'A countdown showing seconds until the next breach arrives' },
  { label: 'Graphical arc', description: 'A filling arc instead of numbers' },
];

const UNRELATED_QUESTION = 'Should the invoice export be CSV or XLSX?';
const UNRELATED_OPTIONS = [
  { label: 'CSV', description: 'Comma separated, one row per invoice line' },
  { label: 'XLSX', description: 'Excel workbook with a sheet per month' },
];

// --------------------------------------------------------------------------
// 1. CONTROL — must run and pass FIRST: proves the mechanism discriminates
// rather than unconditionally denying every AskUserQuestion call once the
// store is non-empty. Sabotage this pins against: replacing the real match
// logic with `return deny()` unconditionally whenever the store has any
// ruling at all.
// --------------------------------------------------------------------------

test('CONTROL: a question matching NO ruling passes through undenied, even with a strong ruling seeded elsewhere in the store', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(askQuestion(dir, UNRELATED_QUESTION, UNRELATED_OPTIONS, 'Export Format'), dir);
    assert.notEqual(r.code, 2, 'an unrelated question must never be denied');
    assert.doesNotMatch(combined(r), /breach countdown/i, 'the unrelated ruling never surfaces for an unrelated question');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the pre-step deny every AskUserQuestion call whenever the
// store contains at least one decision record, regardless of match — this
// control goes red (r.code becomes 2).

// --------------------------------------------------------------------------
// 2. First attempt, strong match → DENIED, substance incl. status/scope.
// --------------------------------------------------------------------------

test('AC (deny-once core): a first-attempt question strongly matching a seeded ruling is DENIED, carrying the ruling id, statement substance, status and scope', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(r.code, 2, 'a strongly-matched first attempt must be denied, not merely audited');
    const text = combined(r);
    assert.match(text, new RegExp(ruling.id), 'the denial names the ruling id so a retry can cite it');
    assert.match(text, /breach countdown seconds/i, 'the denial carries the ruling\'s own substance, not a bare sentence');
    assert.match(text, /\bactive\b/i, 'the denial discloses the ruling\'s status');
    assert.match(text, /\bproject\b/i, 'the denial discloses the ruling\'s scope');
  } finally {
    cleanup();
  }
});
// SABOTAGE: change the deny branch to emit a fixed string like "denied: see
// your store" instead of interpolating the matched record's id/statement/
// status/scope — this test goes red on the id/statement/status/scope
// assertions while r.code may still read 2 (proving those assertions, not
// just the code check, carry real weight).

// --------------------------------------------------------------------------
// 3. Valid override retry → ALLOWED, and logged.
// --------------------------------------------------------------------------

test('AC (override contract): a retry citing the ruling id + an unresolved delta is ALLOWED, and the override is logged with the ruling id', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2, 'setup: the first attempt must actually be denied for this to be a real retry');

    // BEFORE differential: the first (denied) attempt already writes this same
    // ledger file (it records the denial's matched record ids too), so an
    // `overrides[]` entry for this ruling must NOT be present yet — otherwise
    // the "after" check below would be satisfied by prior state alone and
    // never actually pin the override path.
    assert.equal(
      hasOverrideEntryFor(readOverrides(dir), ruling.id),
      false,
      'before the override retry, overrides[] must not yet carry an entry for this ruling — only the deny path has run so far'
    );

    const overrideQuestion =
      `Override decision ${ruling.id}: proceeding to add a breach countdown widget for a debug-only ` +
      'diagnostic overlay visible solely on the developer console — the unresolved delta is that the ' +
      'ruling\'s player-facing display ban never addressed a developer-only diagnostic surface, a materially ' +
      'different audience than "the player" the ruling covers.';
    const retry = runHook(askQuestion(dir, overrideQuestion, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(retry.code, 0, 'an explicit override citing the ruling id + unresolved delta must be allowed through');

    // AFTER differential: only the override retry may produce this entry.
    assert.equal(
      hasOverrideEntryFor(readOverrides(dir), ruling.id),
      true,
      'after the override retry, .sterling/transient/delivery/deny-ledger-conductor.json overrides[] must carry an entry (deny-intent key + recordIds) for the overridden ruling'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: make the override branch allow through (return early / skip
// deny) without ever appending an overrides[] entry to the ledger — the
// AFTER-differential assertion goes red (hasOverrideEntryFor stays false)
// while retry.code still (correctly) reads 0, proving the log-write is
// independently pinned rather than riding along with the allow decision. A
// weaker sabotage — logging the MATCH as a plain deny-record instead of an
// override entry — is exactly what the BEFORE assertion catches, since that
// path already runs on the first (denied) attempt and would make the BEFORE
// check wrongly true.

// --------------------------------------------------------------------------
// 4. Retry WITHOUT the citation, or an identical re-ask → still denied.
// --------------------------------------------------------------------------

test('AC (no-dodge): an identical re-ask of a denied question, with no citation, is still denied', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2);
    const second = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(second.code, 2, 'repeating the exact same question verbatim, with no override citation, must still deny');
  } finally {
    cleanup();
  }
});
// SABOTAGE: make deny-once literal — track "have I denied this exact record
// once?" and allow through on the SECOND encounter regardless of citation —
// this test goes red (second.code becomes 0).

test('AC (no-dodge): a PARAPHRASE of the same denied question, with no citation, is still denied — a paraphrase does not dodge', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2);
    const paraphrase =
      'Give the player a way to watch the breach timer tick down in seconds during the campaign, using a countdown readout for the breach.';
    const second = runHook(askQuestion(dir, paraphrase, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(second.code, 2, 'reworded but same-intent question, with no citation, must still deny (keyed on intent, not exact text)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: key suppression/deny purely on exact string equality of the
// question text instead of normalized intent + matched record ids — this
// test goes red because the reworded text no longer string-matches anything
// and the mutated code allows it through.

test('AC (override contract, both halves required): citing the ruling id WITHOUT stating any unresolved delta is still denied', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const first = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(first.code, 2);
    const idOnly =
      `Overriding decision ${ruling.id}, add a breach countdown widget so the player sees the breach countdown seconds display during the campaign.`;
    const second = runHook(askQuestion(dir, idOnly, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(second.code, 2, 'citing the id alone, without stating what is unresolved/different, must not be accepted as a valid override');
  } finally {
    cleanup();
  }
});
// SABOTAGE: weaken the override check to "question text contains a known
// ruling id" only, dropping the delta requirement — this test goes red
// (second.code becomes 0) even though no delta was ever stated.

// --------------------------------------------------------------------------
// 5. Two thresholds over one candidate pool: loose-audit vs strict-deny.
// --------------------------------------------------------------------------

test('AC (recall/precision split): a WEAK match lands in the loose-audit band — delivered as before, never denied', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(WEAK_TITLE, WEAK_STATEMENT));
    const r = runHook(askQuestion(dir, WEAK_QUESTION, WEAK_OPTIONS, 'Choice'), dir);
    assert.equal(r.code, 0, 'a weak, low-saturation match must land in the loose-audit band, not be denied — regression floor for the existing audit');
    assert.match(combined(r), /breach/i, 'the ruling still surfaces via the pre-existing non-blocking audit');
  } finally {
    cleanup();
  }
});
// SABOTAGE: lower the strict-deny threshold to equal the loose-audit
// threshold (collapse the two bands into one) — this test goes red
// (r.code becomes 2) because the weak fixture, built to clear only the old
// minimal floors, now also clears the (wrongly-lowered) strict bar.

test('AC (recall/precision split): a STRONG match over the SAME candidate pool lands in the strict-deny band', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // Both bands are fed by one candidate pool: seed the weak AND the strict
    // fixture together, then prove the strict one still denies while the
    // pool itself is not narrowed to compensate.
    store.create(decisionRecord(WEAK_TITLE, WEAK_STATEMENT));
    const strict = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(r.code, 2, 'the strongly-matched record in the same pool must still clear the strict-deny band');
    assert.match(combined(r), new RegExp(strict.id), 'the denial names the strict-band record specifically');
  } finally {
    cleanup();
  }
});
// SABOTAGE: raise the strict-deny threshold so high that even the saturated
// STRICT fixture no longer clears it (equivalent to disabling deny in
// practice) — this test goes red (r.code stays 0).

// --------------------------------------------------------------------------
// 6. Per-sub-question form handling.
// --------------------------------------------------------------------------

test('AC (per-sub-question form): one ruled + one unruled sub-question denies the WHOLE form, naming the settled item and instructing resubmission of only the open one', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(
      askForm(dir, [
        { question: STRICT_QUESTION, header: 'Countdown Display', multiSelect: false, options: STRICT_OPTIONS },
        { question: UNRELATED_QUESTION, header: 'Export Format', multiSelect: false, options: UNRELATED_OPTIONS },
      ]),
      dir
    );
    assert.equal(r.code, 2, 'any strongly-matched sub-question denies the whole form');
    const text = combined(r);
    assert.match(text, /breach countdown seconds/i, 'the settled sub-question\'s ruling substance is named');
    assert.match(text, /Export Format/i, 'the open sub-question is named so only it need be resubmitted');
    assert.match(text, /resubmi\w*|only the open/i, 'the denial instructs resubmission of only the open item(s)');
  } finally {
    cleanup();
  }
});
// SABOTAGE: deny the form but only ever report the FIRST sub-question
// regardless of which one matched, or drop the "Export Format" naming
// entirely from the denial text — this test goes red on the
// Export-Format-naming assertion even though r.code correctly stays 2.

// --------------------------------------------------------------------------
// 7. MESSAGE COMPACTION — decision 80d0ab62 (deny-once-message-compaction).
// AMENDS PRESENTATION ONLY of decision 68332e4b: eligibility, ledger,
// override mechanics and whole-form denial are exercised above and stay
// untouched. These pins are spec-only against renderDenyOnceMessage
// (scripts/hooks/lib/delivery.mjs) — expected RED today (pre-compaction):
// today's message runs >=4 lines (two header lines + settled row + a
// three-clause override paragraph), discloses status/scope as prose
// ("status: active, scope: project") rather than a bracket, the override
// paragraph runs well past 220 chars (~340), and the multi-question form
// emits a multi-line "— OPEN (resubmit only these):" block instead of one
// inline preamble line.
// --------------------------------------------------------------------------

/**
 * Extracts the substance clip from a settled row: the text after the
 * bracket-closing "]: " boundary. Split on "]: " (the bracket's OWN close)
 * rather than the first colon found after the id — the bracket itself can
 * contain a colon (", superseded_by: <id>"), so splitting on the first colon
 * is brittle and would cut the substance off mid-bracket. (Roster review
 * finding, test-hygiene item (a) — replaces the old indexOf(':') split used
 * below.) Returns null when no "]: " boundary is present at all.
 */
function substanceAfterBracket(row) {
  const idx = row.indexOf(']: ');
  if (idx === -1) return null;
  return row.slice(idx + 3).trim();
}

test('AC (80d0ab62 — header+structure): single-question, one matched ruling renders EXACTLY 3 lines: one header line naming decision 68332e4b, one settled row starting with "—", one override line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(r.code, 2);
    const lines = messageLines(combined(r));
    assert.equal(
      lines.length,
      3,
      `single-question one-ruling denial must render exactly 3 lines (header, settled row, override); got ${lines.length}: ${JSON.stringify(lines)}`
    );
    assert.match(lines[0], /68332e4b/, 'line 1 (header) must name the governing decision id 68332e4b');
    assert.match(lines[1], /^—/, 'line 2 (settled row) must start with an em-dash, i.e. the old second header line is gone and this is already the settled row');
    assert.match(lines[1], new RegExp(ruling.id), 'the settled row carries the full ruling id');
  } finally {
    cleanup();
  }
});
// SABOTAGE: re-add the dropped second header line (the old "the store already
// decides this..." lecture) above the settled row — lines.length becomes 4
// and this test goes red on the length assertion even though the header and
// settled-row content checks would still individually pass.

test('AC (80d0ab62 — bracketed disclosure): the settled row discloses "[status·scope]" as a compact bracket, and the old "status: X, scope: Y" prose form is gone', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(r.code, 2);
    const lines = messageLines(combined(r));
    const row = lines.find((l) => l.includes(ruling.id));
    assert.ok(row, 'a settled row containing the ruling id must exist');
    assert.match(row, /\[active·project\]/, 'settled row must carry the bracketed [status·scope] disclosure, e.g. "[active·project]"');
    assert.doesNotMatch(row, /status:\s*active/i, 'the old "status: active" prose form must be gone from the settled row');
    assert.doesNotMatch(row, /scope:\s*project/i, 'the old "scope: project" prose form must be gone from the settled row');
  } finally {
    cleanup();
  }
});
// SABOTAGE: keep emitting the old prose "status: active, scope: project"
// alongside or instead of a bracket — the bracket-format assertion goes red
// (no "[active·project]" substring), and if the prose is emitted alongside
// the bracket the doesNotMatch assertions catch that too.

test('AC (80d0ab62 — superseded_by is conditional): CONTROL first — the bracket carries no "superseded_by" token at all when the record has none; CASE — it names the id when the record has one', () => {
  const { dir: dir1, store: store1, cleanup: cleanup1 } = makeProject();
  try {
    // CONTROL, placed first: rules out a formatter that always prints the
    // superseded_by field (e.g. "superseded_by: none") regardless of whether
    // the record actually carries one — that would pass a bare presence
    // check on the CASE below for the wrong reason.
    store1.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const rControl = runHook(askQuestion(dir1, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir1);
    assert.equal(rControl.code, 2);
    assert.doesNotMatch(
      combined(rControl),
      /superseded_by/i,
      'CONTROL: no "superseded_by" token anywhere in the message when the record has none set'
    );
  } finally {
    cleanup1();
  }

  // Test-hygiene note (roster review item (b)): CONTROL above exercises the
  // full hook BUNDLE end-to-end — match + eligibility + ledger + render wired
  // together, driven through the spawned subprocess exactly as production
  // invokes it. CASE below calls the SOURCE renderer directly, imported and
  // invoked in-process — same rendering logic, two different entry points
  // (bundle vs source), which is why neither can substitute for the other.
  //
  // CASE, re-shaped as a direct unit pin of the renderer (not end-to-end):
  // store.create() rightly refuses status:'active' + superseded_by together
  // (packages/schemas/src/envelope.ts:74), and 'superseded' is a
  // store-lifecycle status not reachable by a plain create() call either — so
  // a superseded-with-superseded_by fixture cannot be produced by seeding the
  // real store and driving it through the hook end-to-end. This pins the
  // renderer directly instead: still 68332e4b's laundering guard (status,
  // scope and supersession must never be hidden behind a bare sentence), just
  // exercised as a unit call on renderDenyOnceMessage rather than a fixture
  // walked through create(). Worth pinning even though today's live candidate
  // pool rarely serves an actually-superseded record.
  const supersededByPlaceholder = randomUUID();
  const syntheticRuling = {
    ...decisionRecord(STRICT_TITLE, STRICT_STATEMENT),
    status: 'superseded',
    superseded_by: supersededByPlaceholder,
  };
  const message = renderDenyOnceMessage([{ index: 0, label: 'Countdown Display', decisions: [syntheticRuling] }], 1);
  assert.match(
    message,
    new RegExp(`superseded_by:\\s*${supersededByPlaceholder}`),
    'CASE: when superseded_by is set, the settled row\'s bracket names it as ", superseded_by: <id>"'
  );
  assert.match(
    message,
    /superseded·project/,
    'CASE: the bracket still opens with "superseded·project" (status first) even when superseded_by is also present'
  );
});
// SABOTAGE (CASE): strip the superseded_by interpolation so the bracket is
// always exactly "[status·scope]" with no optional suffix — the CASE
// assertion goes red (no "superseded_by:<id>" substring) while the CONTROL
// stays green, proving the CONTROL passes for its own, opposite reason.
// SABOTAGE (CONTROL): change the formatter to always append
// ", superseded_by: null"/"none" boilerplate regardless of the record — the
// CONTROL assertion goes red (the token now appears even with none set).

test('AC (80d0ab62 — substance clip bound): the settled row\'s substance is non-trivial (>40 chars) yet bounded (<=~175 chars) when the source statement is long', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    assert.ok(STRICT_STATEMENT.length > 200, 'fixture sanity: the source statement must actually be long for this clip-bound pin to mean anything');
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(r.code, 2);
    const lines = messageLines(combined(r));
    const row = lines.find((l) => l.includes(ruling.id));
    assert.ok(row, 'a settled row containing the ruling id must exist');
    const substance = substanceAfterBracket(row);
    assert.ok(substance !== null, 'the settled row must carry a "]: " boundary separating the bracket from the substance clip');
    assert.ok(
      substance.length > 40,
      `substance clip must be non-trivial (>40 chars, laundering guard: never a bare sentence) when source is long — got ${substance.length} chars: ${JSON.stringify(substance)}`
    );
    assert.ok(
      substance.length <= 175,
      `substance clip must be bounded to ~160 chars (170 target, 175 slack) — got ${substance.length} chars: ${JSON.stringify(substance)}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE (upper bound): stop clipping and print the full 260+ char
// STRICT_STATEMENT verbatim — the <=175 assertion goes red while the >40
// assertion would still (wrongly) look satisfied, proving the bound is
// pinned independently of mere presence.
// SABOTAGE (lower bound): replace the clip with a fixed bare sentence like
// "See the ruling for details." instead of interpolating the record's own
// statement — the >40 assertion goes red (or the substring falls well under
// 40 chars), catching the exact laundering shape 68332e4b's guard exists for.

test('AC (80d0ab62 — override line compacted): the override contract renders as ONE line, <=220 chars, still citing a ruling id, the unresolved-delta requirement, and the denied+logged consequence', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const ruling = store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(askQuestion(dir, STRICT_QUESTION, STRICT_OPTIONS, 'Countdown Display'), dir);
    assert.equal(r.code, 2);
    const lines = messageLines(combined(r));
    const overrideLine = lines[lines.length - 1];
    assert.ok(
      overrideLine.length <= 220,
      `override line must be <=220 chars — got ${overrideLine.length}: ${JSON.stringify(overrideLine)}`
    );
    assert.match(overrideLine, new RegExp(ruling.id), 'override line still cites a ruling id');
    assert.match(overrideLine, /delta/i, 'override line still states the unresolved-delta requirement');
    assert.match(overrideLine, /denied/i, 'override line still states that a no-delta re-ask is denied again');
    assert.match(overrideLine, /logged/i, 'override line still states that overrides are logged');
    assert.doesNotMatch(
      overrideLine,
      /\bone of\b/i,
      'with exactly one matched ruling the override line must NOT read "one of" — that phrasing is reserved for when the gate is choosing among multiple citable ids'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: revert renderDenyOnceMessage's override section back to the old
// three-clause paragraph (~340 chars) — the <=220 length assertion goes red
// even though the content-word assertions (delta/denied/logged) would still
// pass, proving the length bound is pinned independently of content.
// A second, narrower sabotage — compact the line but drop the word "logged"
// — leaves length passing while the /logged/i assertion goes red.
// A third sabotage — always emit "one of" phrasing regardless of match count
// (drop the >1 gate entirely) — the doesNotMatch(/\bone of\b/i) assertion
// goes red for this single-ruling case even though every other assertion in
// this test would still pass.
//
// NOTE (amended per roster+Codex review, PIN 4): the <=220 bound above is
// pinned only for the single-ruling case. The bound must hold for ANY
// matched-ruling count, not just one — see "PIN 4b (override line 'one of'
// for exactly two rulings)" and "PIN 4 (override line bounded for
// multi-ruling)" below, which pin the SAME <=220 ceiling and the "one of"
// phrasing once more than one ruling matches, where an unbounded id list
// would otherwise run ~240+ chars.

test('AC (80d0ab62 — multi-question preamble): a multi-question form denial renders ONE preamble line (not the old multi-line "— OPEN (resubmit only these):" block) carrying the total/settled counts and the open sub-question label inline', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
    const r = runHook(
      askForm(dir, [
        { question: STRICT_QUESTION, header: 'Countdown Display', multiSelect: false, options: STRICT_OPTIONS },
        { question: UNRELATED_QUESTION, header: 'Export Format', multiSelect: false, options: UNRELATED_OPTIONS },
      ]),
      dir
    );
    assert.equal(r.code, 2);
    const lines = messageLines(combined(r));
    assert.match(lines[0], /68332e4b/, 'the single header line applies to multi-question forms too');
    const preamble = lines[1];
    assert.match(preamble, /\b2\b/, 'preamble states the total question count (2)');
    assert.match(preamble, /\b1\b/, 'preamble states the settled count (1)');
    assert.match(preamble, /Export Format/i, 'preamble names the open sub-question label inline, clipped');
    const oldBlockLines = lines.filter((l) => /^—?\s*OPEN\b/i.test(l) || /resubmit only these/i.test(l));
    assert.equal(
      oldBlockLines.length,
      0,
      'the old multi-line "— OPEN (resubmit only these):" block header must be gone — the open label now lives inline in the one preamble line'
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE: revert to the old multi-line block — a "— OPEN (resubmit only
// these):" header line followed by one line per open sub-question — this
// test goes red on oldBlockLines.length (now >=1) and on the preamble
// assertions, since line[1] would no longer itself carry the open label,
// total, and settled counts all inline on one line.

// --------------------------------------------------------------------------
// PINS below: adjudicated fixes from the dual review (roster + outside-family
// Codex) of the 80d0ab62 compaction, which found renderDenyOnceMessage
// non-defensive against absent-substance records, embedded control-like
// whitespace, empty-header fallback and unbounded multi-ruling id lists.
// Spec-only, RED-FIRST against the fixes named in each comment below — every
// one of these describes CURRENT (pre-fix) behavior as the expected red.
// --------------------------------------------------------------------------

test('PIN 1 (HIGH — substance never silently absent): a decision with no statement and an anti_pattern with neither trigger nor right_way each render a LOUD marker naming the record id as the read target, never an empty substance', () => {
  const noStatementDecision = {
    ...envelope('decision'),
    title: 'No-statement decision probe',
    statement: undefined,
    alternatives_rejected: [],
    rationale: '',
    file_keys: [],
  };
  const noSubstanceAntiPattern = {
    ...envelope('anti_pattern'),
    title: 'No-substance anti-pattern probe',
    trigger: undefined,
    right_way: undefined,
    guidance: '',
    wrong_way: '',
    source_evidence: '',
    file_keys: [],
  };

  for (const record of [noStatementDecision, noSubstanceAntiPattern]) {
    const message = renderDenyOnceMessage([{ index: 0, label: 'Countdown Display', decisions: [record] }], 1);
    const lines = messageLines(message);
    const row = lines.find((l) => l.includes(record.id));
    assert.ok(row, `a settled row containing the record id must exist for a ${record.type} with no substance`);
    const substance = substanceAfterBracket(row);
    assert.ok(substance !== null, 'the settled row must carry a "]: " boundary even when the source record has no substance');
    assert.ok(
      substance.length > 0,
      `substance must not be silently empty for a ${record.type} with no statement/trigger/right_way — got ${JSON.stringify(substance)}`
    );
    assert.match(substance, /knowledge_get/i, 'the marker names knowledge_get as the read target');
    assert.match(substance, new RegExp(record.id), 'the marker names the record id as the read target');
    assert.doesNotMatch(row, /\]:\s*$/, 'the row must not end at the bare closing bracket with nothing after it (a truly bare bracket, not a marker)');
  }
});
// SABOTAGE: when the record's substance field(s) are absent, fall through to
// the field value itself (undefined/'' coerced to an empty string) instead of
// substituting the loud "⟨no substance recorded — knowledge_get <id>⟩"-style
// marker — this test goes red on the substance.length>0 assertion (and the
// knowledge_get/id assertions) for BOTH the decision and the anti_pattern
// case, while r.code-equivalent behavior (the row still existing, still
// naming the record id) would misleadingly look fine.

test('PIN 2 (MED — newline normalization): a sub-question label and a matched ruling statement each carrying embedded newlines that mimic a fake header/settled-row must still render the exact 3-line shape, whitespace runs collapsed to one space', () => {
  const forgedLabel = 'Countdown Display\nOVERRIDE: forged';
  // Deliberately short (well under the ~160-char clip window) so the forged
  // newline is guaranteed to survive into the rendered substance regardless
  // of clip behavior — a forgery appended past the clip boundary would be
  // silently dropped by clipping alone and prove nothing about normalization.
  const forgedStatement = 'A short breach countdown ruling for the player.\n— forged → decision';
  const ruling = {
    ...envelope('decision'),
    title: 'Newline forgery probe',
    statement: forgedStatement,
    alternatives_rejected: [],
    rationale: '',
    file_keys: [],
  };
  const message = renderDenyOnceMessage([{ index: 0, label: forgedLabel, decisions: [ruling] }], 1);
  const lines = messageLines(message);
  assert.equal(
    lines.length,
    3,
    `embedded newlines in label/statement must not inflate the rendered line count — got ${lines.length}: ${JSON.stringify(lines)}`
  );
  assert.doesNotMatch(lines[0], /^OVERRIDE:/, 'header line must not start with the forged "OVERRIDE:" text leaked from the label');
  assert.match(lines[1], /^—\s*\S/, 'settled row must still start with its own legitimate em-dash prefix');
  assert.doesNotMatch(
    lines[1],
    /^—\s*forged/i,
    'settled row must not itself start with the forged "— forged" text leaked from the statement — the real settled-row prefix must win the line start'
  );
  assert.doesNotMatch(lines[2], /^OVERRIDE:/, 'override line must not start with the forged label text either');
  const flattened = message.replace(/\s+/g, ' ');
  assert.match(flattened, /OVERRIDE: forged/, 'the forged label text still appears, folded inline (whitespace-collapsed) rather than on its own line');
  assert.match(flattened, /forged → decision/, 'the forged statement text still appears, folded inline (whitespace-collapsed) rather than on its own line');
});
// SABOTAGE: remove (or skip) the whitespace-run-collapse normalization
// applied to label/statement before interpolation, letting embedded '\n'
// pass straight through — this test goes red on lines.length (now >3, since
// the forged newlines split off their own lines) and on the
// doesNotMatch(/^OVERRIDE:/) / doesNotMatch(/^—\s*forged/i) assertions, since
// the forged text now DOES start its own line.

test('PIN 3 (MED — empty header falls back to question text): a sub-question with header:\'\' renders its own question text as the label — in the settled row when it is the matched sub-question, and in the open-list mention when it is the unmatched one — never a literal empty label', () => {
  // Case A: the header:'' sub-question is the SETTLED (matched) one. The
  // ZQPROBE tag is a short, unique first token that survives any reasonable
  // clip length, so its presence proves the question TEXT (not the empty
  // header) supplied the label.
  {
    const { dir, store, cleanup } = makeProject();
    try {
      store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
      const r = runHook(
        askForm(dir, [
          { question: `ZQPROBE ${STRICT_QUESTION}`, header: '', multiSelect: false, options: STRICT_OPTIONS },
          { question: UNRELATED_QUESTION, header: 'Export Format', multiSelect: false, options: UNRELATED_OPTIONS },
        ]),
        dir
      );
      assert.equal(r.code, 2);
      const text = combined(r);
      assert.doesNotMatch(text, /""/, 'the settled row must never render a literal empty-string label \'""\'');
      assert.match(text, /ZQPROBE/, 'the settled row uses the sub-question\'s own question text as its label when header is empty');
    } finally {
      cleanup();
    }
  }

  // Case B: the header:'' sub-question is the OPEN (unmatched) one — its
  // open-list mention (naming which item remains open) must also fall back
  // to the question text.
  {
    const { dir, store, cleanup } = makeProject();
    try {
      store.create(decisionRecord(STRICT_TITLE, STRICT_STATEMENT));
      const r = runHook(
        askForm(dir, [
          { question: STRICT_QUESTION, header: 'Countdown Display', multiSelect: false, options: STRICT_OPTIONS },
          { question: `ZQOPEN ${UNRELATED_QUESTION}`, header: '', multiSelect: false, options: UNRELATED_OPTIONS },
        ]),
        dir
      );
      assert.equal(r.code, 2);
      const text = combined(r);
      assert.doesNotMatch(text, /""/, 'the open-list mention must never render a literal empty-string label \'""\'');
      assert.match(text, /ZQOPEN/, 'the open sub-question\'s own question text names it in the preamble when header is empty');
    } finally {
      cleanup();
    }
  }
});
// SABOTAGE: swap the fixed `header || question` (or equivalent truthy-string
// fallback) back to `header ?? question` (nullish coalescing) in
// h20-mechanism-axis.mjs's label pick — since '' is not nullish, '' wins the
// fallback again and this test goes red on both ZQPROBE (Case A) and ZQOPEN
// (Case B) never appearing in the rendered text.

test('PIN 4 (LOW — override line bounded for multi-ruling): when THREE rulings match one sub-question, the override line stays ONE line <=220 chars, "cite one of" with at most the first two ids spelled out and a "+N more" remainder', () => {
  const rulingA = { ...envelope('decision'), title: 'Ruling A', statement: STRICT_STATEMENT, alternatives_rejected: [], rationale: '', file_keys: [] };
  const rulingB = { ...envelope('decision'), title: 'Ruling B', statement: STRICT_STATEMENT, alternatives_rejected: [], rationale: '', file_keys: [] };
  const rulingC = { ...envelope('decision'), title: 'Ruling C', statement: STRICT_STATEMENT, alternatives_rejected: [], rationale: '', file_keys: [] };
  const message = renderDenyOnceMessage([{ index: 0, label: 'Countdown Display', decisions: [rulingA, rulingB, rulingC] }], 1);
  const lines = messageLines(message);
  const overrideLine = lines[lines.length - 1];
  assert.ok(
    overrideLine.length <= 220,
    `override line must stay <=220 chars even with 3 matched rulings — got ${overrideLine.length}: ${JSON.stringify(overrideLine)}`
  );
  assert.match(overrideLine, /cite one of/i, 'the multi-ruling override line reads as "cite one of"');
  assert.match(overrideLine, new RegExp(rulingA.id), 'the first ruling id is spelled out explicitly');
  assert.match(overrideLine, new RegExp(rulingB.id), 'the second ruling id is spelled out explicitly');
  assert.doesNotMatch(overrideLine, new RegExp(rulingC.id), 'the third ruling id must NOT be spelled out explicitly — only a "+N more" remainder covers it');
  assert.match(overrideLine, /\+\s*1\s*more/i, 'the remainder beyond the first two ids reads as "+1 more" (3 total - 2 explicit)');
});
// SABOTAGE: revert the override-line ruling-id join to interpolate ALL
// matched ids unconditionally (e.g. `decisions.map(d => d.id).join(', ')`)
// instead of capping at the first two + "+N more" — with 3 rulings this goes
// red on the <=220 length assertion (~240+ chars) AND on the
// doesNotMatch(rulingC.id) assertion, since the third id is now spelled out.

test('PIN 4b (MED — override line "one of" for exactly two rulings): when TWO rulings match one sub-question, the override line already reads "cite one of" and spells out both ids explicitly', () => {
  const rulingA = { ...envelope('decision'), title: 'Ruling A', statement: STRICT_STATEMENT, alternatives_rejected: [], rationale: '', file_keys: [] };
  const rulingB = { ...envelope('decision'), title: 'Ruling B', statement: STRICT_STATEMENT, alternatives_rejected: [], rationale: '', file_keys: [] };
  const message = renderDenyOnceMessage([{ index: 0, label: 'Countdown Display', decisions: [rulingA, rulingB] }], 1);
  const lines = messageLines(message);
  const overrideLine = lines[lines.length - 1];
  assert.match(
    overrideLine,
    /cite one of/i,
    'with exactly two matched rulings the override line must already read "cite one of" — the gate accepts citing any single id among the matches, not just at 3+'
  );
  assert.match(overrideLine, new RegExp(rulingA.id), 'the first ruling id is spelled out explicitly');
  assert.match(overrideLine, new RegExp(rulingB.id), 'the second ruling id is spelled out explicitly');
});
// SABOTAGE: gate the "one of" / multi-id phrasing behind a >2 ruling count
// (e.g. `if (decisions.length > 2)` instead of `> 1`) — with exactly two
// rulings this test goes red on the /cite one of/i assertion, since the
// implementation falls through to the bare single-ruling phrasing (reported
// red-today shape: a bare "Cite id1, id2 +" with no "one of") even though
// both ids would still individually appear in the line.

test('PIN 5 (LOW — clip is code-point safe): a statement whose ~160-code-point clip boundary lands mid-surrogate-pair (170 ASCII chars + one emoji straddling the boundary) must clip without splitting the pair, and the cut must actually occur', () => {
  // 159 ascii + 1 emoji (surrogate pair, UTF-16 code-unit positions 159-160)
  // + 11 trailing ascii = 170 ASCII chars, 171 code points total. The old
  // 159-ascii-plus-emoji-only fixture was exactly 160 code points — equal to
  // the clip target, so the clip path never actually fired and the pin passed
  // for the wrong reason. The trailing ascii forces a real cut while the
  // emoji still straddles the same UTF-16 code-unit boundary a naive
  // `.slice(0, 160)` would split.
  const longStatement = 'a'.repeat(159) + '\u{1F600}' + 'a'.repeat(11);
  const ruling = {
    ...envelope('decision'),
    title: 'Surrogate pair clip probe',
    statement: longStatement,
    alternatives_rejected: [],
    rationale: '',
    file_keys: [],
  };
  const message = renderDenyOnceMessage([{ index: 0, label: 'Countdown Display', decisions: [ruling] }], 1);
  const lines = messageLines(message);
  const row = lines.find((l) => l.includes(ruling.id));
  assert.ok(row, 'a settled row containing the ruling id must exist');
  const substance = substanceAfterBracket(row);
  assert.ok(substance !== null, 'the settled row must carry a "]: " boundary separating the bracket from the substance clip');
  assert.doesNotMatch(substance, /�/, 'the clipped substance must never contain a U+FFFD replacement character');
  assert.doesNotMatch(
    substance,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
    'the clipped substance must never contain a lone (unpaired) high surrogate — the clip must not split a surrogate pair'
  );
  assert.match(
    substance,
    /(…|\.\.\.)$/,
    'the clipped substance must end with a truncation ellipsis marker ("…" or "...") — this proves the cut actually happened, not merely that a cut would have been safe'
  );
});
// SABOTAGE (surrogate safety): revert the code-point-aware clip back to a
// plain UTF-16 code-unit slice (`statement.slice(0, N)`) — this test goes red
// on the lone high-surrogate regex assertion (the sliced string ends
// mid-pair), and may also go red on the U+FFFD assertion if the clip path
// itself substitutes a replacement character for the orphaned surrogate
// before returning.
// SABOTAGE (cut-happens): make clipping a no-op above the ~160 target (an
// inverted length check, or a `try/catch` around the code-point-safe path
// that swallows an error and falls through to the raw statement) — the
// ellipsis-marker assertion goes red because the substance ends with the
// fixture's trailing 'a' characters instead of a marker, closing the gap the
// old exactly-160-code-point fixture left open (no cut ever executed, so the
// pin passed regardless of clip correctness).

test('PIN 6 (MED — partial anti_pattern substance never lopsided): a trigger-only anti_pattern (right_way missing) and its mirror (right_way-only, trigger missing) each render the present half\'s text PLUS a loud incompleteness marker naming the missing half and the record id as a knowledge_get target — never a dangling "text —" or "— text"', () => {
  const triggerText = 'Fires when a retry silently drops the delta clause, a recognizable trigger fragment.';
  const rightWayText = 'Always restate the delta clause verbatim on retry, a recognizable right-way fragment.';

  const triggerOnly = {
    ...envelope('anti_pattern'),
    title: 'Trigger-only probe (right_way missing)',
    trigger: triggerText,
    right_way: undefined,
    guidance: '',
    wrong_way: '',
    source_evidence: '',
    file_keys: [],
  };
  const rightWayOnly = {
    ...envelope('anti_pattern'),
    title: 'Right-way-only probe (trigger missing)',
    trigger: undefined,
    right_way: rightWayText,
    guidance: '',
    wrong_way: '',
    source_evidence: '',
    file_keys: [],
  };

  const cases = [
    { record: triggerOnly, presentText: triggerText, missingField: /right_way/i },
    { record: rightWayOnly, presentText: rightWayText, missingField: /trigger/i },
  ];

  for (const { record, presentText, missingField } of cases) {
    const message = renderDenyOnceMessage([{ index: 0, label: 'Countdown Display', decisions: [record] }], 1);
    const lines = messageLines(message);
    const row = lines.find((l) => l.includes(record.id));
    assert.ok(row, `a settled row containing the record id must exist for ${record.title}`);
    const substance = substanceAfterBracket(row);
    assert.ok(substance !== null, 'the settled row must carry a "]: " boundary separating the bracket from the substance');
    assert.match(
      substance,
      new RegExp(presentText.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `the present half's own text must appear in the substance for ${record.title}`
    );
    assert.match(substance, missingField, 'the substance names WHICH half is missing, not just that something is missing');
    assert.match(substance, /knowledge_get/i, 'the incompleteness marker names knowledge_get as the read target');
    assert.match(substance, new RegExp(record.id), 'the incompleteness marker names the record id as the knowledge_get target');
    assert.doesNotMatch(substance, /—\s*$/, 'the substance must never end in a dangling "text —" with nothing after the dash');
    assert.doesNotMatch(substance, /^\s*—/, 'the substance must never start with a dangling "— text" with nothing before the dash');
  }
});
// SABOTAGE: render the partial anti_pattern by naive concatenation —
// `${trigger ?? ''} — ${right_way ?? ''}` with no incompleteness marker —
// this test goes red on the knowledge_get and missingField assertions (no
// mention of the missing half or a knowledge_get pointer), AND on the
// dangling-dash assertions, since a missing half leaves a bare trailing or
// leading "—" exactly as the two doesNotMatch checks are built to catch —
// this describes CURRENT (pre-fix) behavior and is expected RED today.

test('PIN 7 (MED — incompleteness marker never evicted by clip on a long present half): a trigger-only anti_pattern with a 200+ char trigger (right_way missing) and its mirror (200+ char right_way, trigger missing) each still render BOTH a prefix of the long present text AND the knowledge_get+id incompleteness marker — the clip must never push the marker out', () => {
  // Long present halves deliberately exceed the ~160-175 char clip window on
  // their own, so a substanceFor that concatenates presentText+marker BEFORE
  // clipping would clip the marker straight off the end.
  const longTrigger =
    'Fires whenever a long-running retry silently drops the delta clause and keeps going without ever ' +
    'restating it, which is exactly the shape of a single overlong trigger clause that could by itself ' +
    'fill the entire clip window before any incompleteness marker ever gets a chance to appear in the ' +
    'rendered row if the clip is applied to the whole concatenated string instead of to the free text alone.';
  const longRightWay =
    'Always restate the delta clause verbatim on every retry attempt, appending the prior context so the ' +
    'reviewer can see exactly what changed, which is exactly the shape of a single overlong right-way ' +
    'clause that could by itself fill the entire clip window before any incompleteness marker ever gets a ' +
    'chance to appear in the rendered row if the clip is applied to the whole concatenated string instead.';
  assert.ok(longTrigger.length > 200, 'fixture sanity: longTrigger must exceed 200 chars for this eviction pin to mean anything');
  assert.ok(longRightWay.length > 200, 'fixture sanity: longRightWay must exceed 200 chars for this eviction pin to mean anything');

  const longTriggerOnly = {
    ...envelope('anti_pattern'),
    title: 'Long-trigger-only probe (right_way missing)',
    trigger: longTrigger,
    right_way: undefined,
    guidance: '',
    wrong_way: '',
    source_evidence: '',
    file_keys: [],
  };
  const longRightWayOnly = {
    ...envelope('anti_pattern'),
    title: 'Long-right-way-only probe (trigger missing)',
    trigger: undefined,
    right_way: longRightWay,
    guidance: '',
    wrong_way: '',
    source_evidence: '',
    file_keys: [],
  };

  const cases = [
    { record: longTriggerOnly, presentText: longTrigger, missingField: /right_way/i },
    { record: longRightWayOnly, presentText: longRightWay, missingField: /trigger/i },
  ];

  for (const { record, presentText, missingField } of cases) {
    const message = renderDenyOnceMessage([{ index: 0, label: 'Countdown Display', decisions: [record] }], 1);
    const lines = messageLines(message);
    const row = lines.find((l) => l.includes(record.id));
    assert.ok(row, `a settled row containing the record id must exist for ${record.title}`);
    assert.match(
      row,
      new RegExp(presentText.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `a prefix of the long present half's own text must still appear in the row for ${record.title}, even though it is 200+ chars`
    );
    assert.match(row, /knowledge_get/i, `the incompleteness marker's knowledge_get token must survive the clip for ${record.title}`);
    assert.match(row, new RegExp(record.id), `the incompleteness marker's record id must survive the clip for ${record.title}`);
    assert.match(row, missingField, `the incompleteness marker must still name which half is missing for ${record.title}`);
  }
});
// SABOTAGE: clip the FULL concatenated string (`(presentText + marker).slice
// or clip to ~N chars`) instead of clipping the free text alone and
// appending the marker outside the clip window — with a 200+ char present
// half this test goes red on the knowledge_get/id/missingField assertions
// (the marker, appended last, is the part that falls off the end of the clip
// window) while the presentText-prefix assertion would misleadingly still
// pass, proving the marker-survival checks — not mere prefix presence — are
// what this pin actually needs to catch the eviction bug.
