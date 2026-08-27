// ===========================================================================
// DELIVERY NOTE — fixer lane C2. THIS IS THE COMPLETE INTENDED FILE, not a patch.
// H5 denied the edit to scripts/tests/check-failclosed-boundary-hardening.test.mjs
// verbatim:
//   H5: 'scripts/tests/check-failclosed-boundary-hardening.test.mjs' is a test path
//   ('**/*.test.mjs', node toolchain) — test paths are frozen for pipeline agents.
//   If you believe a test is wrong, exit tests-invalid with evidence; never edit it
//   silently. A demonstrably buggy test is a conductor repair, recorded via
//   node scripts/test-repair.mjs — never a silent pipeline-agent edit.
//
// EXACTLY WHAT DIFFERS from the version now at scripts/tests/ (line numbers refer
// to THAT file as it stands):
//   • lines 3-37   — header rewritten: a THIRD residual (c) is described (the
//                    zero-observed-denials fail-open), and the MUTATION STATUS
//                    paragraph now also cites decision
//                    `clean-room-mutation-runs-via-conductor-only-helper` as the
//                    reason sabotage stays PREDICTED rather than measured.
//   • lines 47-52  — FINDING 3. The "SCRATCHPAD-ONLY LINE … hardcoded here" note
//                    was false about the very line beneath it (line 53 already
//                    holds the repo form). Replaced with an accurate note.
//                    LINE 53 ITSELF IS UNCHANGED.
//   • after line 125 — two new fixtures added: EXEMPT_ZERO_DENY and
//                    EXEMPT_DENY_VIA_LOCAL_HELPER.
//   • after line 336 — FINDING 1's missing pins added, controls first:
//                    (a7-CONTROL-A), (a7-CONTROL-B), (a7), (a8), (a9-EVIDENCE).
//   • lines 397-405 — FINDING 2. (b2)'s assertions reworked so the pin binds the
//                    EXACTNESS of the founding lock instead of "nonzero exit plus
//                    /founding/i", which a mere unrecognized-argument refusal
//                    satisfied (the usage string itself contains "founding-total").
// Nothing else changed. No existing assertion was weakened or removed.
// ===========================================================================
//
// scripts/tests/check-failclosed-boundary-hardening.test.mjs
//
// The RESIDUAL hardening pins for scripts/check-failclosed-boundary.mjs (board
// 9f8d4c03, objective `fail-closed-boundaries`). Deliberately a SEPARATE file from
// check-failclosed-boundary.test.mjs: that file holds the frozen AC1-AC8 pins from
// the slice that shipped the checker and is not reopened here.
//
// WHAT THESE PIN, AND WHY THE PREMISE IS ADVERSARIAL
// This item exists because a checker reported GREEN while holes existed. Three
// structural escape hatches in the checker itself are the subject:
//
//   (a) THE EXEMPT CLASS WAS NEVER CROSS-CHECKED. The manifest mislabel check
//       fired only for `cls === 'advisory'`; a hook classified `exempt` was
//       skipped outright, so MOVING a hook to `exempt` retired its fail-closed
//       boundary requirement with NO complaint. The class is the one place the
//       checker is told "this gate may fail open" — and being told to ignore
//       something is exactly what has to be loud (P5).
//
//   (b) THE BASELINE IS STRUCTURALLY A SUPPRESSION LIST. The shrink-only ratchet
//       stops a hole being suppressed by ACCIDENT, but nothing distinguished
//       "one entry pruned because it was fixed" from "one entry appended because
//       it was inconvenient". The pins below require growth to be either LOCKED
//       (a declared founding total that must match exactly, itself pinned by a
//       test, so raising it cannot happen quietly) or ADMITTED (an entry carrying
//       its own justification, reprinted on EVERY run for as long as it exists).
//
//   (c) THE FIRST FIX FOR (a) CONTAINED THE SAME DEFECT ONE LAYER IN — a FAIL-OPEN
//       INSIDE A FAIL-CLOSED CHECKER, found by two independent reviewers (one
//       outside-family) and pinned here by (a7)/(a8). A bare
//       `if (identities.length === 0) continue;` sat ABOVE the register lookup and
//       skipped the ENTIRE exemption cross-check whenever an exempt hook had zero
//       observed deny identities — shape validation and the stale-denial arm
//       included. So deleting an exempt hook's sole deny() while leaving its
//       EXEMPTIONS entry and `denials` list intact passed GREEN: the entry was not
//       a ghost (the ghost check only asks whether the hook is still classified
//       exempt, never whether its listed denials are still live), nothing was
//       unlisted, and the listed denials were compared against nothing. A later
//       deny whose flattened identity matched the stale string would then be
//       auto-covered with NO review. The shipped (a5) pin CANNOT see this: its
//       fixture retains one live deny and adds a second stale identity, so the
//       comparison it exercises is the non-empty one. Zero observed identities is
//       not "nothing to check" — it is the STRONGEST stale signal there is,
//       because EVERY listed denial is gone. (a7-CONTROL-A) and (a7-CONTROL-B)
//       fence the correct, deliberate half of the behaviour: an exempt hook with
//       zero denies needs NO entry at all, and an accurate empty `denials` list
//       still passes.
//
// MUTATION STATUS — stated flat, because a claimed verification nobody performed
// is worse than an acknowledged gap. The sabotage named under each test below is
// PREDICTED, and NOT EXECUTED. It could not be: decision
// `clean-room-mutation-runs-via-conductor-only-helper` makes mutation runs
// CONDUCTOR-ONLY BY PROTOCOL (superseding the earlier assumption that an agent
// could self-verify a mutation), and anti-pattern 37b3cb0a forbids mutating the
// implementation in place. Each comment also names WHICH GUARD is expected to
// carry the verdict, so the conductor's mutation pass has a prediction to falsify
// rather than a blank to fill. Several arms are deliberately paired — (a4)/(a4-swap),
// the two halves of (b3), and (a7)/(a8) against (a7-CONTROL-A)/(a7-CONTROL-B) —
// each designed to survive the OTHER's single-guard mutation, which is how a pair
// distinguishes defence-in-depth from a hollow pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, resolved from this file's own location — the same form the
// sibling frozen test uses. (An earlier draft of this comment described the line
// below as "SCRATCHPAD-ONLY" and "hardcoded", which was true of the pre-placement
// copy and FALSE of the line it sat above. A note asserting something false about
// the file it lives in is its own small defect; corrected here.)
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'check-failclosed-boundary.mjs');

function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeHook(scanDir, basename, lines) {
  writeFileSync(join(scanDir, basename), lines.join('\n') + '\n');
}

function writeJson(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd, timeout: 120_000 });
  return {
    code: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

// An `exempt`-shaped hook that GENUINELY DENIES — h24's real shape: its own catch
// calls allow() by decision, and its verdict is a deny() reached from top level,
// outside any fail-closed boundary. This is the fixture that matters: an exempt
// hook with ZERO deny calls is harmless (it cannot block anything), and the frozen
// CONTROL-3 pin in the sibling file already covers that shape.
const EXEMPT_ONE_DENY = [
  "import { deny, allow } from '../lib/common.mjs';",
  '',
  'try {',
  '  work();',
  '} catch (e) {',
  '  allow();',
  '}',
  '',
  "deny('first verdict');",
  'allow();',
];

const EXEMPT_TWO_DENIES = [
  "import { deny, allow } from '../lib/common.mjs';",
  '',
  'try {',
  '  work();',
  '} catch (e) {',
  '  allow();',
  '}',
  '',
  "deny('first verdict');",
  "deny('second verdict');",
  'allow();',
];

const EXEMPT_SWAPPED_DENY = [
  "import { deny, allow } from '../lib/common.mjs';",
  '',
  'try {',
  '  work();',
  '} catch (e) {',
  '  allow();',
  '}',
  '',
  "deny('a completely different verdict');",
  'allow();',
];

// RESIDUAL (c)'s fixture: the exempt hook's SOLE deny() has been DELETED and only
// the import remains. Zero observed deny identities — the exact state in which the
// whole exemption cross-check used to be skipped.
const EXEMPT_ZERO_DENY = [
  "import { deny, allow } from '../lib/common.mjs';",
  '',
  'try {',
  '  work();',
  '} catch (e) {',
  '  allow();',
  '}',
  '',
  'allow();',
];

// The other route to a zero-identity set that the review named: a deny reached only
// through a LOCAL helper. (a9-EVIDENCE) measures whether that actually yields an
// empty set, rather than assuming it — the checker enumerates deny calls by walking
// EVERY node of the file, so a deny inside a local function IS reached.
const EXEMPT_DENY_VIA_LOCAL_HELPER = [
  "import { deny, allow } from '../lib/common.mjs';",
  '',
  'function refuse() {',
  "  deny('helper verdict');",
  '}',
  '',
  'try {',
  '  work();',
  '} catch (e) {',
  '  allow();',
  '}',
  '',
  'refuse();',
  'allow();',
];

const GOOD_EXEMPTION = {
  decision: 'gate-exit-lint-h24-masked-exit-codes',
  reason: 'failing closed on a corrupt config would deny every Bash command machine-wide',
  denials: ["deny('first verdict')"],
};

// =========================================================================
// CONTROL ARMS — PLACED FIRST.
// Every subject below asserts a NONZERO exit. An implementation that had
// degenerated into "any exempt entry fails" or "any baseline fails" would satisfy
// all of them identically. These two pass for the OPPOSITE reason.
// =========================================================================

test('HC-CONTROL-1: an exempt hook that DOES deny, carrying a complete exemption entry (decision + reason + the exact denial listed), passes — the exempt class still has a pass surface', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-control1-');
  try {
    writeHook(dir, 'x1-exempt.mjs', EXEMPT_ONE_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'x1-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', { 'x1-exempt.mjs': GOOD_EXEMPTION });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.equal(r.code, 0, r.out);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): make the exempt branch push every exempt hook onto
// unjustifiedExemptions regardless of its register entry -> HC-CONTROL-1 red.

test('HC-CONTROL-2: the real repo with no flags still passes — the shipped exemption register and the founding-total lock describe HEAD, they do not simply fail everything', () => {
  const r = run([], root);
  assert.equal(r.code, 0, `expected the real-repo scan to pass at HEAD; got: ${r.out}`);
});
// SABOTAGE (PREDICTED, not executed — see the header): drop the h24 entry from the shipped EXEMPTIONS register ->
// HC-CONTROL-2 red (h24's deny becomes an unjustified exemption). Also red on
// setting FOUNDING_BASELINE_TOTAL to anything other than the shipped count.

// =========================================================================
// RESIDUAL (a) — THE EXEMPT CLASS IS CROSS-CHECKED, AND AN UNEXPLAINED
// EXEMPTION FAILS LOUD.
// =========================================================================

test('(a1): a hook classified `exempt` that CALLS deny with NO entry in the exemption register FAILS — moving a hook to exempt can no longer retire its boundary requirement silently', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a1-');
  try {
    writeHook(dir, 'a1-exempt.mjs', EXEMPT_ONE_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a1-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {});
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, 'an exempt hook that denies, with no justification, must fail the check');
    assert.match(r.out, /a1-exempt\.mjs/, 'the failure must name the hook');
    assert.match(r.out, /exempt/i, 'the failure must say the exemption is the problem');
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): restore `if (cls !== 'blocking') continue;` ahead of the
// exempt branch (the HEAD behaviour) -> (a1) red, exit 0.

test('(a2): an exemption entry with no `decision` naming the governing record FAILS — a justification that cites nothing is not a justification', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a2-');
  try {
    writeHook(dir, 'a2-exempt.mjs', EXEMPT_ONE_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a2-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {
      'a2-exempt.mjs': { reason: GOOD_EXEMPTION.reason, denials: GOOD_EXEMPTION.denials },
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, 'an exemption with no governing decision must fail');
    assert.match(r.out, /a2-exempt\.mjs/);
    assert.match(r.out, /decision/i);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): accept any object as an exemption entry (skip the
// decision/reason/denials shape validation) -> (a2) red, exit 0.

test('(a3): an exemption entry with an EMPTY `reason` FAILS — the field being present is not the requirement, its saying something is', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a3-');
  try {
    writeHook(dir, 'a3-exempt.mjs', EXEMPT_ONE_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a3-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {
      'a3-exempt.mjs': { decision: GOOD_EXEMPTION.decision, reason: '   ', denials: GOOD_EXEMPTION.denials },
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, 'a blank reason must fail, not satisfy the field');
    assert.match(r.out, /a3-exempt\.mjs/);
    assert.match(r.out, /reason/i);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): test `'reason' in entry` instead of a non-empty trimmed
// string -> (a3) red, exit 0.

test('(a4): an exempt hook that GROWS a second deny not listed in its exemption FAILS — the exemption covers a named deny set, not the file forever', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a4-');
  try {
    writeHook(dir, 'a4-exempt.mjs', EXEMPT_TWO_DENIES);
    const manifest = writeJson(dir, 'manifest.json', { 'a4-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', { 'a4-exempt.mjs': GOOD_EXEMPTION });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, 'a new deny inside an exempt hook must fail: the exemption did not cover it');
    assert.match(r.out, /a4-exempt\.mjs/);
    assert.match(r.out, /second verdict/, 'the failure must print the unlisted denial so it can be reviewed');
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): compare only the COUNT of observed denials against
// entry.denials.length -> (a4) still red (2 !== 1), so the count guard alone
// carries this arm; (a4-swap) is the arm that kills the count comparison.

test('(a4-swap): an exempt hook whose ONE deny is REPLACED by a different one FAILS — same count, different identity; a count-based exemption would pass this', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a4swap-');
  try {
    writeHook(dir, 'a4s-exempt.mjs', EXEMPT_SWAPPED_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a4s-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', { 'a4s-exempt.mjs': GOOD_EXEMPTION });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, 'a swapped denial (1 -> 1) must still fail');
    assert.match(r.out, /a4s-exempt\.mjs/);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): replace the multiset identity comparison with a length
// comparison -> (a4-swap) red (1 === 1 passes). This is the arm proving the
// exemption's deny set is keyed by identity, exactly as the baseline ratchet is.

test('(a5): an exemption listing a denial that is no longer in the file FAILS as stale — the register shrinks with the code, it does not rot', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a5-');
  try {
    writeHook(dir, 'a5-exempt.mjs', EXEMPT_ONE_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a5-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {
      'a5-exempt.mjs': {
        ...GOOD_EXEMPTION,
        denials: ["deny('first verdict')", "deny('a verdict deleted last week')"],
      },
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, 'a stale listed denial must fail, not silently pass');
    assert.match(r.out, /a5-exempt\.mjs/);
    assert.match(r.out, /deleted last week/, 'the failure must print the stale entry to delete');
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): report only unlisted denials and drop the leftover-entry
// arm -> (a5) red, exit 0.
// NOTE ON THIS ARM'S BLIND SPOT (residual (c), pinned by (a7)): this fixture keeps
// ONE LIVE DENY, so it only ever exercises the NON-EMPTY comparison. It therefore
// stays GREEN under the `if (identities.length === 0) continue;` fail-open, which is
// precisely why (a7) had to be added rather than folded into this arm.

test('(a6): an exemption entry naming a hook that is NOT classified exempt is a stale register and FAILS — a leftover justification must never sit ready to excuse a future move', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a6-');
  try {
    writeHook(dir, 'a6-blocking.mjs', [
      "import { deny } from '../lib/common.mjs';",
      '',
      'let input;',
      'try {',
      '  input = 1;',
      '} catch (e) {',
      "  deny('boundary');",
      '}',
    ]);
    const manifest = writeJson(dir, 'manifest.json', { 'a6-blocking.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', { 'a6-blocking.mjs': GOOD_EXEMPTION });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, 'an exemption for a non-exempt hook must fail as a stale register entry');
    assert.match(r.out, /a6-blocking\.mjs/);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): iterate only over exempt hooks found on disk and never
// cross-check the register's OWN keys -> (a6) red, exit 0. Same shape as AC4c's
// manifest-ghost arm, and it fails for the same reason.

// =========================================================================
// RESIDUAL (c) — AN EXEMPT HOOK WITH ZERO OBSERVED DENIES IS STILL CHECKED.
// The fail-open inside the fail-closed checker. CONTROLS FIRST, because both
// subjects below assert a NONZERO exit and an over-fix ("any entry on a zero-deny
// hook fails") would satisfy them both while being wrong.
// =========================================================================

test('(a7-CONTROL-A): an exempt hook with ZERO deny calls and NO register entry PASSES — it cannot block, so no boundary requirement is being retired and no entry is required', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a7ca-');
  try {
    writeHook(dir, 'a7ca-exempt.mjs', EXEMPT_ZERO_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a7ca-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {});
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.equal(r.code, 0, `a zero-deny exempt hook must need no exemption entry: ${r.out}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): move the zero-identities test to AFTER the
// unjustifiedExemptions push (i.e. require an entry unconditionally) -> (a7-CONTROL-A)
// red. GUARD EXPECTED TO CARRY THE VERDICT: the `if (identities.length === 0) continue;`
// that now lives INSIDE the `entry === undefined` branch. This arm exists to fence
// exactly that guard's remaining, correct job — the fix narrowed the skip, it did
// not delete it.

test('(a7-CONTROL-B): an exempt hook with ZERO deny calls whose entry ACCURATELY lists no denials PASSES — an empty deny set that matches reality is not stale', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a7cb-');
  try {
    writeHook(dir, 'a7cb-exempt.mjs', EXEMPT_ZERO_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a7cb-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {
      'a7cb-exempt.mjs': { ...GOOD_EXEMPTION, denials: [] },
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.equal(r.code, 0, `an accurate empty deny set must pass, not fail merely for existing: ${r.out}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): make the zero-identities case push onto
// staleDenials/unjustifiedExemptions unconditionally whenever an entry exists ->
// (a7-CONTROL-B) red while (a7) stays green. GUARD: the multiset comparison itself
// (an empty `remaining` yields no stale entries). This is the arm that distinguishes
// "the entry is checked" from "the entry is condemned".

test('(a7): an exempt hook whose SOLE deny() has been DELETED, with its exemption entry and `denials` list left behind, FAILS AS STALE — a leftover justification must never sit ready to excuse a future deny that happens to match it', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a7-');
  try {
    writeHook(dir, 'a7-exempt.mjs', EXEMPT_ZERO_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a7-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {
      'a7-exempt.mjs': { ...GOOD_EXEMPTION, denials: ["deny('a verdict deleted last week')"] },
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(
      r.code,
      0,
      `zero observed denies is the STRONGEST stale signal, not a reason to skip the cross-check: ${r.out}`
    );
    assert.match(r.out, /a7-exempt\.mjs/, 'the failure must name the hook');
    assert.match(r.out, /deleted last week/, 'the failure must print the stale identity to delete');
    assert.match(r.out, /no longer in the file/i, 'the verdict must be the STALE arm specifically');
    // NOT a ghost: the hook IS still classified exempt, which is all the ghost
    // check asks. If this ever reported a ghost instead, the pin would be passing
    // for the wrong reason.
    assert.doesNotMatch(r.out, /NOT classified 'exempt' on disk/, r.out);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): reinstate `if (identities.length === 0) continue;`
// ABOVE the `const entry = exemptions[name];` lookup (the reviewed defect) -> (a7)
// red, exit 0, with (a5) and every other (a) arm still GREEN. GUARD EXPECTED TO
// CARRY THE VERDICT: the POSITION of the zero-identities skip relative to the
// register lookup — this arm is keyed to a control-flow ordering, not to a
// comparison. STRIP-EVERY-LAYER PREDICTION: (a7) survives the single-guard mutation
// "drop the stale-denial arm" only if the shape validation also objects, which for
// THIS fixture (a well-formed entry) it does not — so the stale arm alone carries
// (a7), and (a8) is the arm that carries the shape validation. The two do not mask
// each other.

test('(a8): an exempt hook with ZERO observed denies whose exemption entry is MALFORMED is still SHAPE-VALIDATED — an unvalidated justification is not a justification just because nothing currently denies', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a8-');
  try {
    writeHook(dir, 'a8-exempt.mjs', EXEMPT_ZERO_DENY);
    const manifest = writeJson(dir, 'manifest.json', { 'a8-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {
      // No `decision`, and `denials` is accurate — so the ONLY thing wrong is the
      // shape, and only the shape validation can catch it.
      'a8-exempt.mjs': { reason: GOOD_EXEMPTION.reason, denials: [] },
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, `a malformed entry must be validated even when the hook denies nothing: ${r.out}`);
    assert.match(r.out, /a8-exempt\.mjs/);
    assert.match(r.out, /decision/i, 'the failure must name the missing governing decision');
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): reinstate the zero-identities skip above the lookup ->
// (a8) red, exit 0. Second SABOTAGE: keep the skip removed but drop the
// exemptionProblems() call -> (a8) red while (a7) stays GREEN. GUARD EXPECTED TO
// CARRY THE VERDICT: exemptionProblems' `decision` check, reached only because the
// zero-identities skip no longer precedes it. Deliberately paired with (a7): each
// arm survives the other's single-guard mutation, so the pair proves two distinct
// guards rather than one guard credited twice.

test('(a9-EVIDENCE): a deny reached only through a LOCAL helper IS still enumerated — the zero-identity hole is caused by DELETION, not by helper indirection, so switching the enumeration to denyReachingNames would not close it', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-a9-');
  try {
    writeHook(dir, 'a9-exempt.mjs', EXEMPT_DENY_VIA_LOCAL_HELPER);
    const manifest = writeJson(dir, 'manifest.json', { 'a9-exempt.mjs': 'exempt' });
    const baseline = writeJson(dir, 'baseline.json', {});
    const exemptions = writeJson(dir, 'exemptions.json', {});
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--exemptions', exemptions],
      root
    );
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /1 deny call\(s\)/, `the helper-reached deny must be COUNTED, not yield an empty set: ${r.out}`);
    assert.match(r.out, /deny\('helper verdict'\)/, 'and the identity printed must be the deny call site itself');
  } finally {
    cleanup();
  }
});
// WHY THIS ARM EXISTS: the review suspected the enumeration at
// `denyCallsIn(sourceFile, denyBindingNames(sourceFile))` left helper-reached denies
// invisible, and asked whether switching to denyReachingNames was needed. It is not:
// eachNode() walks EVERY descendant, so the inner `deny('helper verdict')` is found
// wherever it sits. Switching to denyReachingNames would instead ADD the helper CALL
// (`refuse()`) as a second identity for one verdict, requiring both in the register —
// a widening, not a closure. The genuinely-zero causes (a deleted deny; a cross-file
// helper; a re-aliased binding `const d = deny`) are unreachable by denyReachingNames
// too, and are closed for ALL of them by (a7)/(a8) instead.
// SABOTAGE (PREDICTED, not executed — see the header): make denyCallsIn iterate only
// sourceFile.statements instead of recursing -> (a9-EVIDENCE) red, and this file's
// own premise changes.

// =========================================================================
// RESIDUAL (b) — AN APPEND TO THE BASELINE CANNOT BE DONE SILENTLY.
// =========================================================================

const B_HOOK_LINES = [
  "import { deny } from '../lib/common.mjs';",
  '',
  'const leakOne = doOne();',
  'const leakTwo = doTwo();',
  'let input;',
  'try {',
  '  input = 1;',
  '} catch (e) {',
  "  deny('boundary');",
  '}',
];

test('(b1): a baseline holding MORE unjustified entries than the declared founding total FAILS — an append is a distinct event from a fix, and it is the append that is refused', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-b1-');
  try {
    writeHook(dir, 'b1-hook.mjs', B_HOOK_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'b1-hook.mjs': 'blocking' });
    // Both findings are genuinely observed, so the ratchet itself is satisfied:
    // the ONLY thing wrong here is that the list grew past its declared size.
    const baseline = writeJson(dir, 'baseline.json', {
      'b1-hook.mjs': [{ statement: 'const leakOne = doOne();' }, { statement: 'const leakTwo = doTwo();' }],
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--founding-total', '1'],
      root
    );
    assert.notEqual(r.code, 0, 'a baseline larger than its declared founding total must fail');
    assert.match(r.out, /founding/i, 'the failure must name the founding-total lock, not read as an ordinary finding');
    assert.match(r.out, /\b2\b/, 'the failure must print the observed unjustified count');
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): drop the founding-total comparison entirely -> (b1) red,
// exit 0 (both entries match observed findings, so nothing else objects).

test('(b2): a baseline holding FEWER unjustified entries than the declared founding total also FAILS — the lock is exact, so a pruned entry forces the number DOWN and the ratchet cannot rot upward', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-b2-');
  try {
    writeHook(dir, 'b2-hook.mjs', [
      "import { deny } from '../lib/common.mjs';",
      '',
      'const leakOne = doOne();',
      'let input;',
      'try {',
      '  input = 1;',
      '} catch (e) {',
      "  deny('boundary');",
      '}',
    ]);
    const manifest = writeJson(dir, 'manifest.json', { 'b2-hook.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {
      'b2-hook.mjs': [{ statement: 'const leakOne = doOne();' }],
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--founding-total', '2'],
      root
    );
    assert.notEqual(r.code, 0, 'an over-declared founding total must fail: lower it in the change that fixed the entry');
    // THE PIN BINDS THE EXACTNESS, NOT MERELY A NONZERO EXIT. `/founding/i` alone
    // was HOLLOW: a build that does not know `--founding-total` at all refuses it as
    // an unrecognized argument, and THAT usage string contains "founding-total"
    // too — so the old assertions passed with no exactness lock present. The three
    // assertions below cannot be satisfied by a usage refusal, by the opposite
    // (append) direction, or by a ceiling comparison.
    assert.doesNotMatch(
      r.out,
      /unrecognized argument/i,
      `--founding-total must be a REAL flag; a usage refusal is not the lock: ${r.out}`
    );
    assert.match(r.out, /FOUNDING TOTAL IS STALE/, `must be the exact-lock STALE arm specifically: ${r.out}`);
    assert.doesNotMatch(r.out, /BASELINE APPEND REFUSED/, 'the append arm is the other direction of the same lock');
    assert.match(
      r.out,
      /1 unjustified baseline entry\(ies\) against a declared founding total of 2/,
      `the failure must print BOTH numbers it compared: ${r.out}`
    );
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): change the lock from `!==` to `>` (a ceiling instead of an
// exact match) -> (b2) red, exit 0. That mutation is the point of this arm: a
// ceiling-only lock leaves headroom behind every fix, and headroom is precisely
// the silent-append space the residual is about. GUARD EXPECTED TO CARRY THE
// VERDICT: `foundingTotal !== foundingTotalDeclared` plus the `else` branch that
// prints FOUNDING TOTAL IS STALE. Second SABOTAGE: remove '--founding-total' from
// FLAGS -> (b2) red on the doesNotMatch(/unrecognized argument/) assertion, which
// is the arm the reworked pin adds; under the OLD assertions that mutation passed.

test('(b3): an entry carrying its own `admitted` justification does NOT count toward the founding total, and is REPRINTED on every passing run — the sanctioned append is permanently loud instead of invisible', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-b3-');
  try {
    writeHook(dir, 'b3-hook.mjs', B_HOOK_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'b3-hook.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {
      'b3-hook.mjs': [
        { statement: 'const leakOne = doOne();' },
        { statement: 'const leakTwo = doTwo();', admitted: 'board 9f8d4c03 — accepted while the fix is scheduled' },
      ],
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--founding-total', '1'],
      root
    );
    assert.equal(r.code, 0, `an admitted entry must not trip the founding lock: ${r.out}`);
    assert.match(r.out, /b3-hook\.mjs/, 'the admitted fail-open must be named on a PASSING run');
    assert.match(r.out, /const leakTwo = doTwo\(\);/, 'the admitted statement itself must be printed');
    assert.match(r.out, /board 9f8d4c03/, 'the justification must be printed with it');
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): print the admitted-entry notice only on a FAILING run ->
// (b3) red on the naming assertions while the exit code still passes. Second
// SABOTAGE (PREDICTED, not executed — see the header): count admitted entries toward the founding total -> (b3)
// red on the exit-code assertion. Two guards, two arms, neither masks the other.

test('(b4): an `admitted` field that is present but blank FAILS — the escape hatch cannot be opened with an empty string', () => {
  const { dir, cleanup } = makeDir('sterling-fcbh-b4-');
  try {
    writeHook(dir, 'b4-hook.mjs', B_HOOK_LINES);
    const manifest = writeJson(dir, 'manifest.json', { 'b4-hook.mjs': 'blocking' });
    const baseline = writeJson(dir, 'baseline.json', {
      'b4-hook.mjs': [
        { statement: 'const leakOne = doOne();' },
        { statement: 'const leakTwo = doTwo();', admitted: '  ' },
      ],
    });
    const r = run(
      ['--scan-dir', dir, '--manifest', manifest, '--baseline', baseline, '--founding-total', '1'],
      root
    );
    assert.notEqual(r.code, 0, 'a blank admitted string must fail rather than silently exempt the entry');
    assert.match(r.out, /admitted/i);
  } finally {
    cleanup();
  }
});
// SABOTAGE (PREDICTED, not executed — see the header): accept any `admitted` value that is not undefined ->
// (b4) red, exit 0.

test('(b5) [THE PIN THAT MAKES A BUMP LOUD]: the shipped baseline declares exactly 107 founding entries — raising the in-file lock to admit a 108th cannot be done without also editing this line', () => {
  const r = run([], root);
  assert.equal(r.code, 0, `real-repo scan must pass: ${r.out}`);
  assert.match(
    r.out,
    /107 founding/,
    'the shipped founding total is 107; if a real fix lowered it, lower this pin in the SAME change and say so in the commit'
  );
});
// SABOTAGE (PREDICTED, not executed — see the header): change FOUNDING_BASELINE_TOTAL to 108 and append one
// unjustified baseline entry -> (b5) red on the regex (and the run also fails the
// ratchet, because the appended statement is not observed). Changing the constant
// ALONE -> (b5) red on the exit code via the founding lock. Both doors are closed
// by different guards: the lock catches the constant, this pin catches the lock.
