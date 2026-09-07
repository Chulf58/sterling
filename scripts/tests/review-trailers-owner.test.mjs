// scripts/lib/review-trailers.mjs — THE ONE TRAILER OWNER (NEW FILE, R1 PIN
// RE-CUT).
//
// AUTHORITY: decision review-receipt-rebuild-invariant-three-owner-modules-
// tri-state-liveness-receipt-bound-supersession — "a shared trailer parser
// (scripts/lib/review-trailers.mjs) used by commit-reviewed, direct-merge and the
// supersession verifier" — projected by contract sheet §1.3:
//
//   TRAILER = { roster: 'Reviewed-By-Agent', waiver: 'Review-Bytes-Waiver', receipt: 'Review-Receipt' }
//   ROSTER_TRAILER_VALUE = /^reviewer-[A-Za-z0-9_-]+(\s|$)/
//   readCommitTrailers(cwd, sha) -> { roster: string[], waiver: string[], receipt: string[] }
//   isRosterTrailerValue(v), formatTrailerBlock({roster:[], waiver:[], receipt:[]}) -> string
//
// WHY THIS FILE EXISTS AT ALL: these three shapes were previously spelled out
// once per consumer, and the only thing keeping the spellings identical was a
// test that compared two regex LITERALS as source text. Drift there was silent
// and one-directional — the discharge verb would retire receipts behind commits
// the merge gate itself would refuse. The re-cut replaces that source comparison
// with an owner module plus these behavioural pins; the IMPORT-identity half (no
// consumer declares its own copy) is pinned in
// scripts/tests/direct-merge-trailer-pattern.test.mjs.
//
// These are UNIT pins: they call the module directly, and the one function with a
// git dependency is exercised against a real fixture repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRAILER, ROSTER_TRAILER_VALUE, readCommitTrailers, isRosterTrailerValue, formatTrailerBlock } from '../lib/review-trailers.mjs';

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-review-trailers-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function commitWith(dir, { path: relPath = 'src/feature.mjs', content, subject, trailerBlock }) {
  writeFileSync(join(dir, relPath), content);
  git(dir, ['add', '-A']);
  const args = trailerBlock ? ['commit', '-m', subject, '-m', trailerBlock] : ['commit', '-m', subject];
  git(dir, args);
  return git(dir, ['rev-parse', 'HEAD']);
}

const RECEIPT_ID = 'a0000000-0000-4000-8000-00000000000a';
const SECOND_ID = 'a0000000-0000-4000-8000-00000000000b';

// ===========================================================================
// R1-C95 — THE THREE KEYS ARE A COMPATIBILITY CONTRACT.
// ===========================================================================

// SABOTAGE: rename any key (a tidier 'Review-Receipt-Id', a lowercase spelling)
// -> the deepEqual goes red. Two of these three keys are already written into
// this repo's committed history and into every consumer's, so their spelling is
// not a naming choice any more: a renamed roster key makes every past reviewed
// commit read as unreviewed at the merge gate, and a renamed receipt key breaks
// every binding the supersession commit form depends on.
// WHY deepEqual RATHER THAN THREE equals: it also pins that there is no FOURTH
// key — a new trailer minted here would be invisible to every consumer that
// switches on this object.
test('R1-C95: TRAILER names exactly the three keys, spelled as git writes them — Reviewed-By-Agent, Review-Bytes-Waiver, Review-Receipt', () => {
  assert.deepEqual(
    TRAILER,
    { roster: 'Reviewed-By-Agent', waiver: 'Review-Bytes-Waiver', receipt: 'Review-Receipt' },
    `these keys are written into committed history and read by the merge gate, so their spelling is a compatibility contract — got ${JSON.stringify(TRAILER)}`
  );
});

// ===========================================================================
// R1-C96 — THE ROSTER VALUE RULE, PINNED THROUGH ITS PREDICATE.
// ===========================================================================

// THE ACCEPTED ARMS ARE THE CONTROL, and they are deliberately the two shapes
// that really occur: commit-reviewed stamps a BARE `reviewer-<class>`, while
// hand-written and post-hoc receipts carry a DECORATED value. An over-anchored
// pattern (whole-value `$`) refuses the decorated form and would reject most of
// this repo's history; a too-loose one accepts prose.
// SABOTAGE (the leading anchor): drop the `^` -> 'note: reviewer-security' is
// accepted and that arm goes red — any prose mentioning a reviewer becomes a
// receipt. No other arm carries a valid token mid-string.
// SABOTAGE (the quantifier): change `+` to `*` -> the bare prefix 'reviewer-'
// is accepted and that arm goes red — a receipt naming NOBODY.
// SABOTAGE (the boundary): the separator group is `(?:[ \t].*)?$` — a SPACE OR
// TAB, then anything, then end. Widen it to `\s` (or add the /m flag, or use
// `[\s\S]`) and a value may carry a NEWLINE: `reviewer-x\nReviewed-By-Agent:
// forged` then passes, and since git renders trailer values into text that other
// tools re-parse, one accepted value becomes two — a forged attestation smuggled
// inside a real one. The two multi-line arms below are that edge, and nothing
// else in this file covers it.
// SABOTAGE (the predicate): implement isRosterTrailerValue as
// `ROSTER_TRAILER_VALUE.test(v)` on a /g regex, or reuse one stateful regex
// across calls -> the repeated-call arm goes red on lastIndex drift, which is the
// classic way a shared regex becomes order-dependent.
test('R1-C96: isRosterTrailerValue accepts a bare and a decorated roster value and rejects everything else — and is not order-dependent across calls', () => {
  const accepted = [
    'reviewer-correctness',
    'reviewer-security',
    'reviewer-x',
    'reviewer-x (opus) — note',
    'reviewer-correctness (opus) — findings adjudicated',
    'reviewer-x\tnote', // a TAB is a legitimate separator: the value is one line
    'reviewer-skeptic  trailing spaces',
  ];
  const rejected = [
    'yes',
    'reviewer bob',
    'reviewer-',
    'note: reviewer-security',
    'codex-cli',
    'External-Review: codex',
    '',
    '   ',
    'reviewer-x\nReviewed-By-Agent: forged', // a newline would smuggle a second attestation inside one accepted value
    'reviewer-x\rjunk', // a bare CR is the same trick where a reader splits on \r
  ];

  for (const v of accepted) assert.equal(isRosterTrailerValue(v), true, `a real roster value must be accepted — ${JSON.stringify(v)}`);
  for (const v of rejected) assert.equal(isRosterTrailerValue(v), false, `a value that names no roster reviewer must be rejected — ${JSON.stringify(v)}`);

  // Non-string inputs are a plain false, never a throw: the values come from git
  // and from an agent-writable ledger, and a parser that throws on the shapes it
  // is meant to reject fails the whole gate instead of one value.
  for (const v of [null, undefined, 42, {}, ['reviewer-correctness']]) {
    assert.equal(isRosterTrailerValue(v), false, `a non-string is false, not an exception — ${JSON.stringify(v)}`);
  }

  // Order independence: the SAME value, asked twice, answers the same way, and
  // interleaving a rejected value between two accepted ones changes nothing.
  assert.equal(isRosterTrailerValue('reviewer-correctness'), true, 'first call');
  assert.equal(isRosterTrailerValue('yes'), false, 'interleaved rejection');
  assert.equal(isRosterTrailerValue('reviewer-correctness'), true, 'second call on the same value answers identically — a stateful /g regex would fail here');

  // The exported pattern is the SAME rule the predicate applies, not a second
  // spelling of it — a consumer that matches with the regex directly (the
  // supersession commit form does) must get the same verdicts.
  for (const v of accepted) assert.match(v, ROSTER_TRAILER_VALUE, `the exported pattern agrees with the predicate on ${JSON.stringify(v)}`);
  for (const v of rejected) assert.doesNotMatch(v, ROSTER_TRAILER_VALUE, `the exported pattern agrees with the predicate on ${JSON.stringify(v)}`);
});

// ===========================================================================
// R1-C97 — readCommitTrailers READS ONE NAMED COMMIT, BY EXACT KEY.
// ===========================================================================

// SABOTAGE (key precision): read the trailers with a loose key match (any key
// matching /review/i, or `%(trailers:valueonly)` unkeyed) -> External-Review's
// value lands in `roster` or `receipt` and those deepEquals go red. That is the
// laundering the separate key exists to prevent: an external consult is
// conductor-attested evidence, never the mandatory independent review.
// SABOTAGE (multiplicity): return the first value per key instead of all of them
// -> the two-roster/two-receipt assertions go red; one commit routinely spends
// several receipts and each mints its own line.
// SABOTAGE (the sha argument): read HEAD regardless of the sha passed -> the
// older-commit assertion goes red. Every caller asks about a NAMED commit — the
// merge gate walks a range, the supersession verifier names a survivor — so
// reading HEAD would answer a question nobody asked.
// SABOTAGE (absence): return undefined instead of [] for a missing key -> the
// empty-array assertions go red and every consumer needs its own null guard.
test('R1-C97: readCommitTrailers(cwd, sha) returns {roster,waiver,receipt} for the NAMED commit — every value per key, no other key\'s values, and [] where a key is absent', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const older = commitWith(dir, {
      content: 'export const f = 1;\n',
      subject: 'a commit spending two receipts, one of them waived',
      trailerBlock: [
        'Reviewed-By-Agent: reviewer-correctness',
        'Reviewed-By-Agent: reviewer-security (opus) — findings adjudicated',
        `Review-Receipt: ${RECEIPT_ID}`,
        `Review-Receipt: ${SECOND_ID}`,
        `Review-Bytes-Waiver: ${RECEIPT_ID}`,
        'External-Review: codex (gpt-5.2) thread 01a057ee round 2 — conductor-attested consult',
      ].join('\n'),
    });
    const newer = commitWith(dir, { path: 'src/other.mjs', content: 'export const g = 1;\n', subject: 'a later commit with no review trailers at all' });
    assert.notEqual(older, newer, 'fixture guard: two distinct commits');

    const t = readCommitTrailers(dir, older);
    assert.deepEqual(
      t.roster,
      ['reviewer-correctness', 'reviewer-security (opus) — findings adjudicated'],
      `every roster value, in commit order, and NOTHING from another key — got ${JSON.stringify(t)}`
    );
    assert.deepEqual(t.receipt, [RECEIPT_ID, SECOND_ID], `every Review-Receipt value — got ${JSON.stringify(t)}`);
    assert.deepEqual(t.waiver, [RECEIPT_ID], `every Review-Bytes-Waiver value — got ${JSON.stringify(t)}`);
    assert.deepEqual(Object.keys(t).sort(), ['receipt', 'roster', 'waiver'], `and exactly the three categories — an External-Review value belongs to none of them — got ${JSON.stringify(t)}`);

    const none = readCommitTrailers(dir, newer);
    assert.deepEqual(none, { roster: [], waiver: [], receipt: [] }, `a commit with no review trailers yields three EMPTY ARRAYS, never undefined — got ${JSON.stringify(none)}`);

    // Reading the OLDER sha while HEAD sits on the newer one is the whole point
    // of taking a sha: this must not answer about HEAD.
    assert.equal(git(dir, ['rev-parse', 'HEAD']), newer, 'fixture guard: HEAD is the trailer-less commit');
    assert.deepEqual(readCommitTrailers(dir, older).receipt, [RECEIPT_ID, SECOND_ID], 'the named commit is what was read, not HEAD');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C98 — formatTrailerBlock IS THE WRITE SIDE OF THE SAME PARSER.
// ===========================================================================

// THE ROUND TRIP IS THE PIN: whatever this function formats must come back out of
// readCommitTrailers unchanged. Pinning the exact string would freeze a spelling;
// pinning the round trip freezes the CONTRACT, which is that the writer and the
// reader are one module and cannot disagree.
// SABOTAGE (the separator): join the lines with '; ' or omit the newline between
// the subject and the block -> git stops parsing them as trailers and the
// round-trip deepEquals go red.
// SABOTAGE (empty categories): emit `Review-Receipt: ` for an empty list -> the
// empty-input assertion goes red, and a commit carrying a valueless trailer would
// then be read back with an empty-string value that no consumer expects.
// SABOTAGE (ordering/duplication): dedupe or reorder the values -> the round-trip
// deepEqual on two roster values goes red; multiplicity is how several receipts
// spent by one commit stay individually accountable.
test('R1-C98: formatTrailerBlock round-trips through readCommitTrailers — every value survives in order, and empty categories emit no line at all', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const input = { roster: ['reviewer-correctness', 'reviewer-security'], waiver: [SECOND_ID], receipt: [RECEIPT_ID, SECOND_ID] };
    const block = formatTrailerBlock(input);
    assert.equal(typeof block, 'string', `the block is a string ready to be a commit-message paragraph — got ${JSON.stringify(block)}`);

    const sha = commitWith(dir, { content: 'export const f = 1;\n', subject: 'a commit whose trailers were formatted by the owner module', trailerBlock: block });
    assert.deepEqual(readCommitTrailers(dir, sha), input, `what the owner wrote is exactly what the owner reads back — block=${flat(block)}`);

    // An empty request produces no trailer lines — never a valueless key.
    const empty = formatTrailerBlock({ roster: [], waiver: [], receipt: [] });
    assert.equal(empty.trim(), '', `an empty trailer set formats to nothing at all — got ${JSON.stringify(empty)}`);
    for (const key of Object.values(TRAILER)) {
      assert.ok(!empty.includes(key), `and mentions no key — ${key} appears in ${JSON.stringify(empty)}`);
    }

    // A partial set writes only the categories it was given.
    const partial = formatTrailerBlock({ roster: ['reviewer-security'], waiver: [], receipt: [] });
    const partialSha = commitWith(dir, { path: 'src/partial.mjs', content: 'export const p = 1;\n', subject: 'roster only', trailerBlock: partial });
    assert.deepEqual(readCommitTrailers(dir, partialSha), { roster: ['reviewer-security'], waiver: [], receipt: [] }, `a partial set writes only what it was given — block=${flat(partial)}`);
  } finally {
    cleanup();
  }
});
