// DIRECT-MERGE RECEIPT GATE — ROSTER-PATTERN TRAILER VALIDATION
// (campaign slice S2b-4; decision 57984926, slug
// review-ledger-v2-lifecycle-refuse-flip-and-external-review-design, §5
// "MERGE READER FIX").
//
// SPEC UNDER TEST (decision 57984926 §5, verbatim):
//   "(5) MERGE READER FIX (verified at direct-merge.mjs:528: any non-empty
//    Reviewed-By-Agent value currently passes): the merge gate requires at
//    least one trailer value matching the roster reviewer pattern; unrelated or
//    malformed values do not satisfy it."
// And, from §4, the fence on the other trailer key:
//   "if external provenance ever reaches commits it uses a distinct
//    External-Review: trailer, never Reviewed-By-Agent."
//
// Written BLIND to scripts/direct-merge.mjs's internals (H4 read wall) — only
// its CLI surface (--target, exit conventions, JSON stdout on success, stderr
// on refusal) is used, learned from the sibling TEST files
// scripts/tests/merge-review-receipts.test.mjs and
// scripts/tests/merge-review-receipts-hardening.test.mjs, whose
// makeReceiptGateRepo() / writeAndCommit() / runDirectMerge() idioms are
// REPRODUCED here (not imported) so this file stays independently runnable.
// The `:528` line reference above is quoted from the decision record; this
// file's author did not open it.
//
// WHAT IS PINNED AT THE END-TO-END SEAM: the full CLI is driven (temp repo,
// main + feature branch, real commits with real git trailers), exactly as the
// two sibling suites do — no narrower seam was needed, and nothing here reaches
// past the CLI boundary.
//
// ===========================================================================
// ASSUMED PATTERN — STATED SO THE CONDUCTOR CAN ADJUDICATE.
// The brief gives the roster reviewer pattern as ^reviewer-[A-Za-z0-9_-]+$.
// THE UNRESOLVED QUESTION, and the reason T1b exists: is that pattern matched
// against the WHOLE trailer value, or against the value's LEADING IDENTITY
// TOKEN?
//   * Whole-value anchoring would REGRESS the already-frozen sibling suite:
//     merge-review-receipts.test.mjs's PASS/EXEMPT/dirty-tree tests all commit
//     `Reviewed-By-Agent: reviewer-correctness (opus) — findings adjudicated`
//     and assert the merge SUCCEEDS. That decorated shape is real (it is what
//     the sibling suites' fixtures use); the bare shape is also real (per
//     review-ledger-discharge.test.mjs, commit-reviewed stamps a bare
//     `reviewer-<class>` value).
//   * So this file pins BOTH shapes as passing (T1 bare, T1b decorated) and
//     leaves the exact implementation (leading-token match, or a per-value
//     `^reviewer-[A-Za-z0-9_-]+\b` test) to the coder.
// IF THE CONDUCTOR RULES THAT ONLY BARE VALUES MAY PASS, T1b is the pin to
// change — and the frozen sibling suite changes with it, which is a ruling, not
// a defect.
//
// AMBIGUITIES FLAGGED, NOT RESOLVED (reported to the launching agent):
//   (a) "the refusal names the malformed value" (T2) is the BRIEF's
//       requirement; §5 says only that malformed values "do not satisfy" the
//       gate. Naming it is the P5 reading (a gate that refuses without showing
//       what it rejected sends the conductor hunting), but it is adjudicable.
//   (b) "the malformed one disclosed, not fatal" (T3) is likewise the brief's;
//       §5 is silent on disclosure when a VALID value is also present. T3's
//       merge-succeeds assertion is the hard half; the disclosure assertion is
//       the SOFTEST pin in this file and is flagged as such at its site.
//   (c) WHERE disclosure lands (stdout summary vs stderr advisory) is
//       unspecified — T3 asserts against stdout+stderr combined.
//   (d) Case sensitivity of the pattern is unspecified. No pin uses a
//       differently-cased value (`Reviewer-Correctness`), so nothing here
//       constrains it.
// ===========================================================================

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Anti-pattern ee89c3fd guard: flatten before interpolating into a message.
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');

// Same fixture as the two sibling receipt-gate suites: a git project with a
// store but NO active run, plus a .sterling/config.json declaring this repo's
// registered toolchain globs (the **/*.mjs / **/*.ts pair the CODE-TOUCHING
// definition keys on).
function makeReceiptGateRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-trailer-pattern-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({
      toolchains: [
        { adapter: 'node', path_globs: ['**/*.mjs', '**/*.ts'], test_globs: ['tests/**'], run_commands: { test: 'node --test' } },
      ],
    })
  );
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close(); // store present, no active run
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// `trailerBlock` is passed as a SEPARATE `-m` paragraph (subject, blank line,
// trailer lines) — the shape a real git trailer needs. It may hold SEVERAL
// lines, which is how a commit carries two Reviewed-By-Agent values.
function writeAndCommit(dir, { path: relPath, content, subject, trailerBlock }) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ['add', '-A']);
  const args = trailerBlock ? ['commit', '-m', subject, '-m', trailerBlock] : ['commit', '-m', subject];
  git(dir, args);
  const sha = git(dir, ['rev-parse', 'HEAD']);
  const short = git(dir, ['rev-parse', '--short', sha]);
  return { sha, short, subject };
}

// The EXACT read the sibling suites use, so a fixture guard here proves the
// same thing the gate itself will see.
function trailerValues(dir, key, sha = 'HEAD') {
  const out = git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly,unfold)`, sha]);
  return out.split('\n').filter((l) => l.trim() !== '');
}

function runDirectMerge(dir, extra = []) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'direct-merge.mjs'), '--target', dir, ...extra], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
  });
}

// ===========================================================================
// T1 — CONTROL, PLACED FIRST.
// Every refusal pin below (T2's four arms, T4) would be satisfied identically
// by a gate that refuses EVERY branch — including one broken by an
// over-anchored pattern that no real trailer value can match. Without T1 (and
// T1b) green, no refusal pin in this file carries a verdict.
// ===========================================================================

// EXPECTED STATE: GREEN today (any non-empty value passes today, so a bare
// `reviewer-correctness` passes) AND after the fix. This is a pure control.
// SABOTAGE: anchor the pattern such that a bare roster value cannot match (for
// instance requiring a parenthetical model suffix, or requiring the value to
// CONTAIN a space) -> this arm goes red. That matters because a bare value is
// exactly what commit-reviewed stamps (review-ledger-discharge.test.mjs's
// trailer assertions read back the bare `reviewer-<class>` form), so an
// over-anchored pattern would refuse every machine-stamped commit in the repo.
test('direct-merge trailer pattern T1 (CONTROL, first): a bare roster value (reviewer-correctness) satisfies the receipt gate and the branch merges', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/bare-roster']);
    const c = writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature, bare roster trailer',
      trailerBlock: 'Reviewed-By-Agent: reviewer-correctness',
    });
    assert.deepEqual(trailerValues(dir, 'Reviewed-By-Agent', c.sha), ['reviewer-correctness'], 'fixture guard: git parses exactly one bare roster trailer value');

    const r = runDirectMerge(dir);
    assert.equal(r.status, 0, `a value matching the roster reviewer pattern must satisfy the gate — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.branch_merged, 'feat/bare-roster');
    assert.equal(out.merged_into, 'main');
  } finally {
    cleanup();
  }
});

// EXPECTED STATE: GREEN today AND expected green after the fix. This is the
// COMPATIBILITY control described in the header: the decorated value is the
// shape the already-frozen merge-review-receipts.test.mjs suite commits and
// asserts merges, so the new pattern check must be applied to the value's
// leading identity token, not to the whole free-text value.
// SABOTAGE: implement the check as a WHOLE-VALUE match
// (/^reviewer-[A-Za-z0-9_-]+$/.test(value)) -> this arm goes red AND the frozen
// sibling suite's PASS test goes red with it. A red here is the earliest signal
// that the pattern was anchored too hard; without it the regression would first
// surface as an unexplained failure in another file.
test('direct-merge trailer pattern T1b (COMPAT CONTROL): a DECORATED roster value (reviewer-correctness (opus) — findings adjudicated) still satisfies the gate — the pattern matches the identity token, not the whole free text', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/decorated-roster']);
    writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature, decorated roster trailer',
      trailerBlock: 'Reviewed-By-Agent: reviewer-correctness (opus) — findings adjudicated',
    });

    const r = runDirectMerge(dir);
    assert.equal(
      r.status,
      0,
      `the decorated trailer shape the existing frozen suite commits must keep passing — an over-anchored pattern regresses every hand-written receipt — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.branch_merged, 'feat/decorated-roster');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// T2 — MALFORMED / UNRELATED VALUES DO NOT SATISFY THE GATE (§5).
// ===========================================================================

// EXPECTED STATE: AS AUTHORED (pre-fix), RED on every arm — §5's own
// measurement says any non-empty value currently passes, so pre-fix
// direct-merge MERGES each of these branches (status 0) and the first
// assertion, `assert.notEqual(r.status, 0, ...)`, is the line that reports red
// with stdout/stderr embedded: a legible missing-refusal, never a crash.
// AGAINST THE IMPLEMENTED TREE all six arms are GREEN — the last two (added
// after roster review, see below) were green from the moment the pattern
// landed and are MUTATION pins, not red-first pins.
// SABOTAGE (the defect this pin exists for, and the one §5 measured): test the
// value with a non-empty check (`value.trim() !== ''`) instead of the roster
// pattern -> all four arms merge and go red. The consequence is not cosmetic:
// `Reviewed-By-Agent: yes` is a receipt naming nobody, and the merge gate is
// the ONLY mechanism standing between an unreviewed diff and main.
// SIX ARMS, each a DIFFERENT class of wrong value — a nonsense affirmation, a
// mis-keyed external attestation, a human name that merely starts with the word
// "reviewer", an external tool identity, a BARE PREFIX naming nobody, and a
// valid-looking token BURIED MID-STRING. One guard can pass on one arm while
// failing another (a substring test for "reviewer" accepts arms 3 and rejects
// 1; a hyphen test accepts arm 4's `codex-cli`), so no arm can witness
// another's absence.
// THE LAST TWO ARMS ARE MUTATION PINS on the pattern itself, added after roster
// review of the implementation observed that the first four leave the two
// likeliest hollowing edits invisible. They are expected GREEN against the
// implemented pattern (/^reviewer-[A-Za-z0-9_-]+(\s|$)/) and exist so a later
// edit to it cannot pass unnoticed:
//   * 'note: reviewer-security' pins the LEADING ANCHOR. Drop the `^` and a
//     valid token anywhere inside free text satisfies the gate — so any prose
//     mentioning a reviewer becomes a receipt. No other arm carries a valid
//     token mid-string, so no other arm reddens on that edit.
//   * 'reviewer-' pins the QUANTIFIER. Change `+` to `*` and the bare prefix
//     matches: a receipt naming NOBODY, which is exactly the empty-value
//     defect merge-review-receipts-hardening.test.mjs already refuses in its
//     other spelling. No other arm is a bare prefix.
//     CAVEAT ON THAT ARM'S value-naming assertion: the refusal's remedy text
//     may itself contain the substring `reviewer-`, so for THIS arm the
//     load-bearing assertion is the REFUSAL (and main not moving), not the
//     naming match.
test('direct-merge trailer pattern T2: a commit whose ONLY Reviewed-By-Agent value is malformed or unrelated is treated as trailer-less — the gate refuses, names the value, and main never moves', () => {
  const arms = ['yes', 'External-Review: codex', 'reviewer bob', 'codex-cli', 'reviewer-', 'note: reviewer-security'];
  for (const value of arms) {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/malformed']);
      const c = writeAndCommit(dir, {
        path: 'src/feature.mjs',
        content: 'export const f = 1;\n',
        subject: `add feature with a malformed receipt value`,
        trailerBlock: `Reviewed-By-Agent: ${value}`,
      });
      // Fixture guard: the malformed value really is what git hands the gate —
      // otherwise a red here would be about trailer formatting, not the pattern.
      assert.deepEqual(
        trailerValues(dir, 'Reviewed-By-Agent', c.sha),
        [value],
        `[${value}] fixture guard: git parses exactly this one Reviewed-By-Agent value`
      );

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      assert.notEqual(
        r.status,
        0,
        `[${value}] a value that does not match the roster reviewer pattern is NO RECEIPT AT ALL — the gate must refuse exactly as if the trailer were absent — stdout=${r.stdout} stderr=${flat(r.stderr)}`
      );
      assert.match(r.stderr, new RegExp(escapeRegex(c.short)), `[${value}] the refusal names the offending commit by short sha — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, /add feature with a malformed receipt value/, `[${value}] and by subject — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, /Reviewed-By-Agent/, `[${value}] and names the amend/record-trailer remedy — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, /--waive-reviews/, `[${value}] and the --waive-reviews remedy — stderr=${flat(r.stderr)}`);

      // Ambiguity (a): the brief requires the rejected value to be shown. A
      // gate that refuses without showing WHAT it rejected sends the conductor
      // to `git log` to guess which of several trailers failed.
      assert.match(
        r.stderr,
        new RegExp(escapeRegex(value)),
        `[${value}] the refusal NAMES THE MALFORMED VALUE it rejected, so the conductor can see why a trailered commit was still refused — stderr=${flat(r.stderr)}`
      );

      assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, `[${value}] a refused merge never moves the base branch HEAD`);
    } finally {
      cleanup();
    }
  }
});

// EXPECTED STATE: RED today, but on the DISCLOSURE assertion only. Today's gate
// accepts any non-empty value, so the merge SUCCEEDS (the status assertion is
// green today and must stay green after the fix); nothing prints the rejected
// value, so the final `assert.match(combined, /yes/)` is the line that reports
// red.
// SABOTAGE (fatal-vs-not half): implement the pattern as "EVERY value must
// match" instead of "AT LEAST ONE value matches" (§5's words) -> the merge
// refuses and the status assertion goes red. That is a real hazard: a commit
// legitimately carrying both a roster receipt and a hand-written note would be
// blocked by the gate meant to require the receipt.
// SABOTAGE (disclosure half): drop the disclosure -> only the last assertion
// goes red. FLAGGED AS THE SOFTEST PIN IN THIS FILE (ambiguity (b)): §5 does
// not require disclosure when a valid value is present, so if the conductor
// rules silence acceptable, THIS assertion is the one to drop — the
// merge-succeeds half above stands either way.
test('direct-merge trailer pattern T3: a commit carrying one MALFORMED and one VALID Reviewed-By-Agent value passes on the valid one — the malformed value is disclosed, never fatal', () => {
  const { dir, cleanup } = makeReceiptGateRepo();
  try {
    git(dir, ['checkout', '-b', 'feat/mixed-values']);
    const c = writeAndCommit(dir, {
      path: 'src/feature.mjs',
      content: 'export const f = 1;\n',
      subject: 'add feature with one junk and one real receipt value',
      trailerBlock: 'Reviewed-By-Agent: yes\nReviewed-By-Agent: reviewer-security',
    });
    assert.deepEqual(
      trailerValues(dir, 'Reviewed-By-Agent', c.sha),
      ['yes', 'reviewer-security'],
      'fixture guard: git parses BOTH values on this one commit — otherwise this pin would be testing single-value handling'
    );

    const r = runDirectMerge(dir);
    assert.equal(
      r.status,
      0,
      `§5 requires AT LEAST ONE matching value — a junk value alongside a real one must not block the merge — stdout=${r.stdout} stderr=${flat(r.stderr)}`
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.branch_merged, 'feat/mixed-values', 'the branch really merged');

    const combined = `${r.stdout}\n${r.stderr}`;
    assert.match(
      combined,
      /\byes\b/,
      `the unmatched value is DISCLOSED — a silently-ignored junk receipt is how a value nobody meant as a receipt keeps living in commit messages — got: ${flat(combined)}`
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// T4 — THE OTHER TRAILER KEY (§4: external provenance "uses a distinct
// External-Review: trailer, never Reviewed-By-Agent").
// ===========================================================================

// EXPECTED STATE: GREEN today — the commit carries NO Reviewed-By-Agent trailer
// at all, and today's gate already refuses that (pinned by
// merge-review-receipts.test.mjs). It is a FORWARD pin against the widening §4
// invites once External-Review: trailers start appearing on real commits.
// SABOTAGE: read the receipt trailer by a loose key match (any trailer key
// matching /review/i, or `%(trailers:valueonly)` unkeyed) so an External-Review
// line satisfies the gate -> the status/HEAD assertions go red. That would let
// a conductor-attested consult — §4's "evidence of a completed consult, NOT
// proof" — discharge the mandatory independent-review requirement, which is the
// precise laundering §4's separate trailer key exists to prevent.
// SECOND ARM (control, inside this test): the same branch plus a VALID
// Reviewed-By-Agent trailer merges, so the refusal above cannot be explained by
// "an External-Review trailer breaks the gate outright".
test('direct-merge trailer pattern T4: an External-Review: trailer ALONE never satisfies the Reviewed-By-Agent gate — and it does not poison a commit that also carries a valid roster receipt', () => {
  const EXTERNAL = 'codex (gpt-5.2) thread 01a057ee round 2 — conductor-attested consult';

  // Arm 1: External-Review only -> refused.
  {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/external-only']);
      const c = writeAndCommit(dir, {
        path: 'src/feature.mjs',
        content: 'export const f = 1;\n',
        subject: 'add feature reviewed only by an external consult',
        trailerBlock: `External-Review: ${EXTERNAL}`,
      });
      assert.deepEqual(trailerValues(dir, 'External-Review', c.sha), [EXTERNAL], 'fixture guard: git parses the External-Review trailer');
      assert.deepEqual(trailerValues(dir, 'Reviewed-By-Agent', c.sha), [], 'fixture guard: and there is NO Reviewed-By-Agent trailer');

      const mainBefore = git(dir, ['rev-parse', 'main']);
      const r = runDirectMerge(dir);
      assert.notEqual(
        r.status,
        0,
        `an external consult is evidence, not the mandatory roster review — it must never satisfy the Reviewed-By-Agent gate — stdout=${r.stdout} stderr=${flat(r.stderr)}`
      );
      assert.match(r.stderr, new RegExp(escapeRegex(c.short)), `the refusal names the offending commit — stderr=${flat(r.stderr)}`);
      assert.match(r.stderr, /Reviewed-By-Agent/, `and names the trailer it actually requires — stderr=${flat(r.stderr)}`);
      assert.equal(git(dir, ['rev-parse', 'main']), mainBefore, 'and main never moved');
    } finally {
      cleanup();
    }
  }

  // Arm 2 (CONTROL for arm 1): External-Review BESIDE a valid roster receipt
  // -> merges. Arm 1's refusal must be caused by the ABSENCE of a roster
  // receipt, not by the PRESENCE of an External-Review trailer.
  {
    const { dir, cleanup } = makeReceiptGateRepo();
    try {
      git(dir, ['checkout', '-b', 'feat/external-plus-roster']);
      writeAndCommit(dir, {
        path: 'src/feature.mjs',
        content: 'export const f = 1;\n',
        subject: 'add feature reviewed by roster AND an external consult',
        trailerBlock: `Reviewed-By-Agent: reviewer-security\nExternal-Review: ${EXTERNAL}`,
      });

      const r = runDirectMerge(dir);
      assert.equal(
        r.status,
        0,
        `an External-Review trailer must not BLOCK a properly-reviewed commit either — it is orthogonal evidence — stdout=${r.stdout} stderr=${flat(r.stderr)}`
      );
      assert.equal(JSON.parse(r.stdout).branch_merged, 'feat/external-plus-roster');
    } finally {
      cleanup();
    }
  }
});
