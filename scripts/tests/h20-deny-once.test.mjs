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

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-24T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h20-mechanism-axis.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Substance may land on either stream depending on how the deny is signalled. */
function combined(r) {
  return `${r.stdout}\n${r.stderr}`;
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
