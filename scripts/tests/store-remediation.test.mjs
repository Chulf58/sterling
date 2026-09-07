// Adversarial regression pins for the CONFIG-SPACE SANCTIONED-SCRIPT REACH
// (board 52c1d504 — the generalization of the two-script "remediation reach"
// originally pinned here for board 1b3c7bf3 / decision bc0f81e3).
//
// scripts/lib/store-remediation.mjs (dependency-free, node builtins only) exports:
//   - SANCTIONED_SCRIPTS: a frozen array, element-identical to config.ts's
//     store_guard.allow_scripts DEFAULT — i.e. exactly what Sterling ships as
//     sanctioned for the H15 store guard, no more and no less.
//   - appendMissingSanctioned(allowScripts): pure fn returning { next, added }.
//     next = input + any SANCTIONED_SCRIPTS not already present, APPENDED after
//     all existing entries, in SANCTIONED_SCRIPTS order. added = the scripts
//     actually appended. NEVER dedupes/removes/reorders existing entries
//     (including pre-existing duplicates). Idempotent on an array already
//     containing all of them (added empty, next element-equal to input).
//
// WHAT THIS MECHANISM IS AND IS NOT (the invariant the whole suite defends):
// it changes WHICH PROJECTS the shipped sanctioned list reaches — a config
// carrying an EXPLICIT allow_scripts array never grows with the zod default,
// because a default applies only when the field is ABSENT. It NEVER changes
// WHAT IS ON that list. Widening the allow surface means editing config.ts's
// shipped default (and this module's mirror with it), reviewed as the policy
// change it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANCTIONED_SCRIPTS, appendMissingSanctioned } from '../lib/store-remediation.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The shipped list, spelled out ONCE in this suite as a literal. Every other
// expectation below derives from this constant rather than from the module
// under test, so a corrupted SANCTIONED_SCRIPTS cannot make its own tests pass.
//
// RE-CUT 2026-09-05 (re-cut discipline per decision 77c5b85a, the same one this
// file's header block below already records).
//   OLD PREMISE: the shipped sanctioned set is these NINE entries.
//   NEW PREMISE: it is TEN. `scripts/review-ledger.mjs` was added as a SINGLE,
//     INDIVIDUAL disposition under decision 1434cd54 Ruling 6 — which forbids
//     BULK-adding the 12 unsanctioned store writers and requires each to earn
//     its own disposition — because decision 57984926 (3) makes
//     `node <clone>/scripts/review-ledger.mjs discharge …` the ONE route for an
//     unspendable review receipt, and H1 prints that route. A remedy the guard
//     denies is not a remedy: 1434cd54 Ruling 2 names exactly that shape ("the
//     sanctioned recovery route … is UNREACHABLE BY ITS OPERATOR"), and the
//     consuming project reported it live on 2026-09-03. Board 891284a9, slice 1
//     of objective dome-farmer-issues-2026-09-05.
//   WHAT DID NOT CHANGE: the widening rule. This list grows ONLY by editing
//     config.ts's shipped default and this module's mirror together, reviewed as
//     the policy change it is — which is what the drift pin below enforces, and
//     it is NOT weakened by this re-cut.
//
// ⚠ POSITION ASSUMPTION, STATED SO A RED IS DIAGNOSED IN ONE LINE: this author
// holds no read access to packages/schemas/src/config.ts or to
// scripts/lib/store-remediation.mjs (H4 read wall), so the new entry is placed
// LAST — after `packages/tui/bundle/sterling-tui.mjs` — following the precedent
// of the previous addition (board 52c1d504 appended the TUI launcher at the end)
// and of board 891284a9's own pointer at store-remediation.mjs:79. If the
// implementation placed it elsewhere, the deepEqual and the drift pin below both
// go red PRINTING BOTH ORDERS: that is a RE-POINT of this literal to the shipped
// order, in one edit — never a reordering of the shipped list to match the test,
// and never a relaxation of either deepEqual into a set comparison.
//
// RE-CUT 2026-09-05 (b) (re-cut discipline per decision 77c5b85a — same
// mechanism, a second re-cut after slice 1b of board 77fe18af).
//   OLD PREMISE: the shipped sanctioned set is these TEN entries.
//   NEW PREMISE: it is FOURTEEN. Four scripts joined as SINGLE, INDIVIDUAL
//     dispositions (decision 1434cd54 Ruling 6 forbids bulk-adding the
//     unsanctioned store writers; each earns its own justification), appended
//     in this order after `scripts/review-ledger.mjs`:
//       - `scripts/rotation-note.mjs` — decision 665be1f3: always meant to be
//         sanctioned (the context-rotation note writer), never actually added.
//       - `scripts/no-capture.mjs` — H10's Stop text prints the exact command
//         as the sanctioned remedy; a guard that denies its own printed
//         remedy is the inverted-protection shape this suite exists to catch.
//       - `scripts/test-repair.mjs` — H5's frozen-test denial names it BY NAME
//         as THE route past the frozen-test wall; same inverted-protection
//         shape.
//       - `scripts/delivery-oracle.mjs` — board a6b118e4 point 9: the layer-1
//         delivery audit must run from a Bash-gated agent, so its script
//         needs the same sanctioned reach.
//   WHAT DID NOT CHANGE: the widening rule (edit config.ts's shipped default
//     and this module's mirror together, reviewed as the policy change it is)
//     and the position-assumption discipline above (this author holds no read
//     access to config.ts or store-remediation.mjs — H4 — so the four new
//     entries are placed LAST, after `scripts/review-ledger.mjs`, following
//     the same precedent; if the implementation placed them elsewhere the
//     deepEqual and drift pin below both go red printing both orders, which is
//     a RE-POINT of this literal, never a reordering of the shipped list to
//     match the test).
const SHIPPED = [
  'scripts/dispose-run.mjs',
  'scripts/init.mjs',
  'scripts/consume-exit.mjs',
  'scripts/architecture-projection.mjs',
  'scripts/domain-doctor.mjs',
  'scripts/commit-reviewed.mjs',
  'scripts/migration-preflight.mjs',
  'scripts/migrate-stores.mjs',
  'packages/tui/bundle/sterling-tui.mjs',
  'scripts/review-ledger.mjs',
  'scripts/rotation-note.mjs',
  'scripts/no-capture.mjs',
  'scripts/test-repair.mjs',
  'scripts/delivery-oracle.mjs',
  'scripts/plan-lock.mjs',
];

/**
 * Read config.ts's allow_scripts DEFAULT out of the SOURCE (not the built
 * dist, and not @sterling/schemas): the module under test is dependency-free
 * by contract and must stay testable on an unbuilt clone, and the thing that
 * actually ships to a fresh install is the source literal.
 */
function shippedDefaultFromConfigSource() {
  const src = readFileSync(join(REPO_ROOT, 'packages', 'schemas', 'src', 'config.ts'), 'utf8');
  const block = src.match(/allow_scripts:[\s\S]*?\.default\(\[([\s\S]*?)\]\)/);
  assert.ok(
    block,
    'DRIFT PIN BROKEN, not the list: could not locate the store_guard.allow_scripts .default([...]) literal in packages/schemas/src/config.ts — fix this matcher, do not weaken the pin'
  );
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// ── SANCTIONED_SCRIPTS: contents, freeze, and the single-source drift pin ────
//
// RE-CUT (board 52c1d504). The predecessor of this test was named
// "REMEDIATION_SCRIPTS: exact contents, exact order, frozen" and asserted the
// list was exactly ['scripts/migration-preflight.mjs','scripts/migrate-stores.mjs'].
// That PREMISE — that the reach carries a curated two-script migration sublist
// — is no longer true: the user ruled (board 52c1d504) that the reach carries
// the SHIPPED SANCTIONED LIST, because a "remediation" label mislabels every
// entry that is not a migration script (the TUI launcher is a launcher), and a
// sealed list quietly widened destroys the seal's meaning. So the assertion is
// re-cut to pin the NEW invariant: the list is exactly what config.ts ships,
// verified three independent ways (literal, live source-derived equality, and
// membership of the two entries whose absence was actually measured in the
// field) plus a control that a non-shipped script is NOT a member.

test('SANCTIONED_SCRIPTS: exact contents, exact order, frozen, and element-identical to the SHIPPED config.ts default', () => {
  assert.deepEqual([...SANCTIONED_SCRIPTS], SHIPPED, 'exact contents in exact order');

  // THE SINGLE-SOURCE PIN. config.ts cannot import this module (its tsconfig
  // pins rootDir to src) and this module cannot import config.ts (bootstrap
  // independence — update.mjs must load on an unbuilt clone), so the two
  // literals are mirrored by hand. This is the mechanism that makes "ONE list"
  // true: it goes red the moment either side is edited alone.
  assert.deepEqual(
    shippedDefaultFromConfigSource(),
    SHIPPED,
    "packages/schemas/src/config.ts's store_guard.allow_scripts default has drifted from SANCTIONED_SCRIPTS — a config-space reach that carries a DIFFERENT list from the one a fresh install gets is exactly the bug board 52c1d504 closed. Edit both, in the same order."
  );

  // The two incidents that produced this mechanism, pinned by name so a future
  // edit that drops either is loud rather than merely different.
  assert.ok(SANCTIONED_SCRIPTS.includes('scripts/migration-preflight.mjs'), 'the mandated migration remediation stays sanctioned (decision bc0f81e3, the Salesforce trap)');
  assert.ok(SANCTIONED_SCRIPTS.includes('scripts/migrate-stores.mjs'), 'the mandated migration remediation stays sanctioned (decision bc0f81e3, the Salesforce trap)');
  assert.ok(SANCTIONED_SCRIPTS.includes('packages/tui/bundle/sterling-tui.mjs'), 'the TUI launcher — the false-deny that triggered board 52c1d504 — is carried by the reach, repo-relative, never as a bare basename');
  // RE-CUT 2026-09-05: the third incident, pinned by name on the same footing as
  // the two above, so a future edit that drops it is LOUD rather than merely
  // different. Its absence was measured in the field — the consuming project's
  // 2026-09-03 unreachable-receipt-discharge report — and decision 57984926 (3)
  // makes this script the only discharge route (board 891284a9).
  assert.ok(SANCTIONED_SCRIPTS.includes('scripts/review-ledger.mjs'), 'the receipt-discharge route stays sanctioned (decision 57984926 (3); 1434cd54 Ruling 2 — a sanctioned recovery route its operator cannot run is not a route)');

  // CONTROL (must pass for the opposite reason): the list is a closed set, not
  // "everything under scripts/". A script that is not shipped-sanctioned is
  // absent, so the reach can never introduce it into any consumer config.
  assert.ok(!SANCTIONED_SCRIPTS.includes('scripts/build-hooks.mjs'), 'a real but NON-sanctioned repo script is not on the list');
  assert.ok(!SANCTIONED_SCRIPTS.some((s) => !s.includes('/')), 'no bare basenames — H15 matches whole-word repo-relative paths, so a basename sanctions nothing (anti_pattern caecf8a6)');

  assert.ok(Object.isFrozen(SANCTIONED_SCRIPTS), 'SANCTIONED_SCRIPTS is frozen');
  // module code runs in strict mode (ESM) — mutating a frozen array throws,
  // it does not silently no-op.
  assert.throws(() => SANCTIONED_SCRIPTS.push('scripts/extra.mjs'), TypeError);
});
// SABOTAGE (order): swap two entries in the source array literal — the first
// deepEqual AND the drift pin both go red.
// SABOTAGE (widening): add 'scripts/build-hooks.mjs' to SANCTIONED_SCRIPTS
// only — the drift pin goes red (config.ts does not ship it) and the control
// assertion goes red. Adding it to config.ts only — the drift pin goes red the
// other way. Neither half can be widened silently.
// SABOTAGE (regression to bare basename): change the TUI entry to
// 'sterling-tui.mjs' — the deepEqual, the drift pin, the named-membership
// assertion and the no-bare-basenames assertion all go red.
// SABOTAGE (frozen): delete the Object.freeze(...) call — isFrozen goes red
// AND the .push() throws-assertion goes red (push silently succeeds instead).

// ── the reach never widens the allow surface (board 52c1d504) ────────────────

test('appendMissingSanctioned: everything it adds is a SHIPPED sanctioned script — it can never introduce an unsanctioned one', () => {
  for (const input of [[], ['scripts/some-admin-script.mjs'], ['scripts/migrate-stores.mjs'], [...SHIPPED]]) {
    const { next, added } = appendMissingSanctioned(input);
    for (const s of added) {
      assert.ok(SHIPPED.includes(s), `appended '${s}', which is not a shipped sanctioned script`);
    }
    // nothing appears in `next` that was neither already recorded nor shipped
    for (const s of next) {
      assert.ok(input.includes(s) || SHIPPED.includes(s), `'${s}' is in the result but was neither in the recorded config nor shipped-sanctioned`);
    }
    assert.ok(!next.includes('scripts/build-hooks.mjs'), 'a non-sanctioned script is never introduced');
  }
});
// SABOTAGE: have the function append an extra entry beyond SANCTIONED_SCRIPTS
// (e.g. `[...existing, ...added, 'scripts/build-hooks.mjs']`) — the `added`
// membership loop and the final assertion both go red.

// ── appendMissingSanctioned: none present ───────────────────────────────────

test('appendMissingSanctioned: none present — appends all shipped sanctioned scripts, in order, after existing entries', () => {
  const input = ['scripts/some-other-script.mjs'];
  const { next, added } = appendMissingSanctioned(input);
  // RE-CUT 2026-09-05: written out INDEPENDENTLY of SHIPPED (not `[input,
  // ...SHIPPED]`), deliberately — this is the one place the expected order is
  // spelled a second time, so a single-sided edit to SHIPPED is caught here too.
  // `scripts/review-ledger.mjs` is appended last, matching the SHIPPED literal's
  // position assumption documented at the top of this file.
  // RE-CUT 2026-09-05 (b): the four individually-dispositioned entries
  // (rotation-note, no-capture, test-repair, delivery-oracle; board 77fe18af
  // slice 1b) join at the end, after `scripts/review-ledger.mjs`.
  assert.deepEqual(next, [
    'scripts/some-other-script.mjs',
    'scripts/dispose-run.mjs',
    'scripts/init.mjs',
    'scripts/consume-exit.mjs',
    'scripts/architecture-projection.mjs',
    'scripts/domain-doctor.mjs',
    'scripts/commit-reviewed.mjs',
    'scripts/migration-preflight.mjs',
    'scripts/migrate-stores.mjs',
    'packages/tui/bundle/sterling-tui.mjs',
    'scripts/review-ledger.mjs',
    'scripts/rotation-note.mjs',
    'scripts/no-capture.mjs',
    'scripts/test-repair.mjs',
    'scripts/delivery-oracle.mjs',
    'scripts/plan-lock.mjs',
  ]);
  assert.deepEqual(added, SHIPPED);
  assert.deepEqual(input, ['scripts/some-other-script.mjs'], 'input array is not mutated (pure function)');
});
// SABOTAGE: prepend the missing scripts instead of appending (or emit them in
// reversed order) — the `next` deepEqual on ordering/position goes red.
// SABOTAGE (purity): have the function `input.push(...)` the missing scripts
// directly onto the caller's array instead of building a new array — the
// final `assert.deepEqual(input, ['scripts/some-other-script.mjs'])` goes red.

test('appendMissingSanctioned: empty input — next becomes exactly the shipped list (a FRESH array, never the frozen singleton), added is the same', () => {
  const { next, added } = appendMissingSanctioned([]);
  assert.deepEqual(next, SHIPPED);
  assert.deepEqual(added, SHIPPED);
  assert.notEqual(next, SANCTIONED_SCRIPTS, 'next is not the frozen module singleton itself');
  assert.ok(!Object.isFrozen(next), 'next is a fresh mutable array — a caller writing it back must not be handed the module constant');
});
// SABOTAGE: return SANCTIONED_SCRIPTS itself (the frozen singleton) as `next`
// — the notEqual and isFrozen assertions go red (and a caller mutating the
// result would throw at runtime).

// ── appendMissingSanctioned: one missing — existing entries/order preserved ──

test('appendMissingSanctioned: exactly one missing — only that one is appended; present entries are NOT moved to canonical position', () => {
  // every shipped script except migration-preflight, deliberately in a
  // NON-canonical order with unrelated admin entries interleaved.
  // RE-CUT 2026-09-05: `scripts/review-ledger.mjs` joined the shipped list
  // (board 891284a9), so it is present here too — without it this fixture would
  // be missing TWO scripts and `added` would carry two entries, which is a
  // different test from the "exactly one missing" behaviour pinned here.
  // RE-CUT 2026-09-05 (b): the four individually-dispositioned entries
  // (rotation-note, no-capture, test-repair, delivery-oracle; board 77fe18af
  // slice 1b) join the shipped list too, so they are present here as well —
  // without them this fixture would be missing FIVE scripts, not one.
  const input = [
    'scripts/a.mjs',
    'scripts/migrate-stores.mjs',
    'packages/tui/bundle/sterling-tui.mjs',
    'scripts/init.mjs',
    'scripts/b.mjs',
    'scripts/dispose-run.mjs',
    'scripts/review-ledger.mjs',
    'scripts/rotation-note.mjs',
    'scripts/no-capture.mjs',
    'scripts/test-repair.mjs',
    'scripts/delivery-oracle.mjs',
    'scripts/plan-lock.mjs',
    'scripts/consume-exit.mjs',
    'scripts/architecture-projection.mjs',
    'scripts/domain-doctor.mjs',
    'scripts/commit-reviewed.mjs',
  ];
  const { next, added } = appendMissingSanctioned(input);
  assert.deepEqual(added, ['scripts/migration-preflight.mjs']);
  assert.deepEqual(next, [...input, 'scripts/migration-preflight.mjs'], 'the recorded array is preserved verbatim, the one missing script appended at the end');
});
// SABOTAGE: reorder existing entries into SANCTIONED_SCRIPTS canonical order —
// the `next` deepEqual goes red because the recorded positions shifted.
// SABOTAGE: check presence via a canonical-order subsequence test instead of
// membership — this scrambled fixture would report several "missing" and
// `added` would come back with more than one entry, going red.

test('appendMissingSanctioned: a partially-covered config gains exactly the gap, appended after everything recorded', () => {
  const input = ['scripts/migration-preflight.mjs', 'scripts/a.mjs', 'scripts/migrate-stores.mjs'];
  const { next, added } = appendMissingSanctioned(input);
  // RE-CUT 2026-09-05: the gap is now EIGHT entries — `scripts/review-ledger.mjs`
  // joined the shipped list (board 891284a9) and is absent from this input, so it
  // is part of the gap, in SANCTIONED_SCRIPTS order (last, per the position
  // assumption documented at the top of this file).
  // RE-CUT 2026-09-05 (b): the gap is now TWELVE entries — the four
  // individually-dispositioned additions (rotation-note, no-capture,
  // test-repair, delivery-oracle; board 77fe18af slice 1b) are also absent
  // from this input, so they join the gap, in SANCTIONED_SCRIPTS order (last).
  assert.deepEqual(added, [
    'scripts/dispose-run.mjs',
    'scripts/init.mjs',
    'scripts/consume-exit.mjs',
    'scripts/architecture-projection.mjs',
    'scripts/domain-doctor.mjs',
    'scripts/commit-reviewed.mjs',
    'packages/tui/bundle/sterling-tui.mjs',
    'scripts/review-ledger.mjs',
    'scripts/rotation-note.mjs',
    'scripts/no-capture.mjs',
    'scripts/test-repair.mjs',
    'scripts/delivery-oracle.mjs',
    'scripts/plan-lock.mjs',
  ], 'the gap only — the two already-present migration scripts are not re-added, and the added set is in SANCTIONED_SCRIPTS order');
  assert.deepEqual(next, [...input, ...added]);
});
// SABOTAGE: append missing scripts BEFORE existing entries instead of after —
// the `next` deepEqual goes red (position of 'scripts/a.mjs' would shift).
// SABOTAGE: ignore presence and always append the whole list — `added` would
// carry the two migration scripts again and both assertions go red.

// ── appendMissingSanctioned: idempotency + duplicate preservation ────────────
//
// RE-CUT (board 52c1d504). The predecessor fixture was
// ['scripts/migrate-stores.mjs','scripts/some-admin-script.mjs','scripts/migration-preflight.mjs']
// and its PREMISE was "a config listing both migration scripts is fully
// covered, so this is a no-op". Under the ruling that premise is false — such
// a config is missing seven shipped sanctioned scripts and MUST gain them.
// The behaviour actually under test (presence is checked by MEMBERSHIP, never
// by canonical order or position) is unchanged, so the fixture is re-cut to a
// config that genuinely IS fully covered — every shipped script present, in a
// deliberately scrambled order with an unrelated admin entry between them.

test('appendMissingSanctioned: fully covered (scrambled order, unrelated entry interleaved) — idempotent no-op', () => {
  // RE-CUT 2026-09-05: "fully covered" now means TEN shipped entries, so
  // `scripts/review-ledger.mjs` is present (board 891284a9). Without it this
  // fixture would no longer be fully covered and the no-op claim would be tested
  // against a config that genuinely needs an append — exactly the dead-premise
  // shape the board 52c1d504 re-cut recorded below.
  // RE-CUT 2026-09-05 (b): "fully covered" now means FOURTEEN shipped entries —
  // the four individually-dispositioned additions (rotation-note, no-capture,
  // test-repair, delivery-oracle; board 77fe18af slice 1b) are present here too,
  // interleaved out of canonical order, for the same reason.
  const input = [
    'scripts/migrate-stores.mjs',
    'scripts/some-admin-script.mjs',
    'scripts/no-capture.mjs',
    'packages/tui/bundle/sterling-tui.mjs',
    'scripts/migration-preflight.mjs',
    'scripts/commit-reviewed.mjs',
    'scripts/review-ledger.mjs',
    'scripts/test-repair.mjs',
    'scripts/domain-doctor.mjs',
    'scripts/rotation-note.mjs',
    'scripts/architecture-projection.mjs',
    'scripts/consume-exit.mjs',
    'scripts/init.mjs',
    'scripts/dispose-run.mjs',
    'scripts/delivery-oracle.mjs',
    'scripts/plan-lock.mjs',
  ];
  const { next, added } = appendMissingSanctioned(input);
  assert.deepEqual(added, [], 'nothing appended — every shipped sanctioned script is present, regardless of its position');
  assert.deepEqual(next, input, 'next is element-equal to input — no reordering, no rewrite');
});
// SABOTAGE: check presence by requiring the shipped scripts to appear in
// SANCTIONED_SCRIPTS canonical ORDER (a strict subsequence check) rather than
// simple membership — this scrambled fixture would be treated as "still
// missing something", `added` comes back non-empty, and both assertions go red.

test('appendMissingSanctioned: pre-existing duplicates are preserved as-is, never deduped, even while adding the genuinely missing ones', () => {
  const input = ['scripts/migrate-stores.mjs', 'scripts/migrate-stores.mjs'];
  const { next, added } = appendMissingSanctioned(input);
  assert.deepEqual(
    next.slice(0, 2),
    ['scripts/migrate-stores.mjs', 'scripts/migrate-stores.mjs'],
    'the duplicate migrate-stores.mjs entries are BOTH preserved untouched at the head of the array'
  );
  assert.equal(next.filter((s) => s === 'scripts/migrate-stores.mjs').length, 2, 'still exactly two — never deduped, never re-added');
  assert.deepEqual(added, SHIPPED.filter((s) => s !== 'scripts/migrate-stores.mjs'));
});
// SABOTAGE: dedupe the input before appending (e.g. `next = [...new
// Set(input), ...missing]`) — only one 'scripts/migrate-stores.mjs' survives
// and the first two assertions go red.

// ── appendMissingSanctioned: throws on non-array input ──────────────────────
//
// The silent `Array.isArray(x) ? x : []` coercion is replaced with a loud
// throw naming the received type — a caller passing a malformed allow_scripts
// (e.g. a string from a wrong-shaped config) must fail loud at this seam
// rather than have it silently treated as an empty array.

test('appendMissingSanctioned: throws on a non-array string input, the message naming the received type', () => {
  assert.throws(
    () => appendMissingSanctioned('bad'),
    (err) => err instanceof Error && /string/i.test(err.message),
    'throws an Error whose message names the received type (string)'
  );
});
// SABOTAGE: restore the silent `Array.isArray(x) ? x : []` coercion — this
// assertion goes red because appendMissingSanctioned('bad') returns
// { next: [...SANCTIONED_SCRIPTS], added: [...SANCTIONED_SCRIPTS] } instead
// of throwing.

test('appendMissingSanctioned: throws on a non-array plain-object input, the message naming the received type', () => {
  assert.throws(
    () => appendMissingSanctioned({}),
    (err) => err instanceof Error && /object/i.test(err.message),
    'throws an Error whose message names the received type (object)'
  );
});
// SABOTAGE: restore the silent `Array.isArray(x) ? x : []` coercion —
// appendMissingSanctioned({}) returns a coerced-to-empty-array result instead
// of throwing, and this assertion goes red.

test('appendMissingSanctioned: a genuine array input is entirely unaffected by the throw guard', () => {
  const { next, added } = appendMissingSanctioned(['scripts/x.mjs']);
  assert.deepEqual(next, ['scripts/x.mjs', ...SHIPPED]);
  assert.deepEqual(added, SHIPPED);
});
// SABOTAGE: make the Array.isArray guard also reject genuine arrays (e.g.
// an inverted condition `if (Array.isArray(x)) throw ...`) — this call throws
// instead of returning, and the test errors out / fails.

test('appendMissingSanctioned: fully idempotent across two calls once everything is present', () => {
  const first = appendMissingSanctioned(['scripts/x.mjs']);
  assert.deepEqual(first.added, SHIPPED);
  const second = appendMissingSanctioned(first.next);
  assert.deepEqual(second.added, [], 'a second call on an already-covered array adds nothing');
  assert.deepEqual(second.next, first.next, 'a second call is a true no-op — element-equal to its input');
});
// SABOTAGE: have the function always re-append SANCTIONED_SCRIPTS
// unconditionally (ignore presence entirely) — `second.added` would come back
// non-empty and `second.next` would carry duplicate entries, going red on both
// assertions.

// ############################################################################
// R5 ADDITION — THE AUDITED WRITER MANIFEST (slice R5 of objective
// rebuild-2026-09; boards a416e276 + a506e9a7).
//
// GOVERNING SPEC: decision
// `sanctioned-script-store-writes-one-containment-helper-one-arg-parser`
// (knowledge_get d0cdd940-aa4c-40fb-9fd1-5359d5bfb41c), part (A). Quoted,
// because the SHAPE of this pin is itself a ruling and was chosen over the
// obvious alternative:
//
//   "Every sanctioned script that WRITES under `.sterling/` derives its path
//    through it. The pin is an EXPLICIT AUDITED WRITER MANIFEST (which
//    sanctioned entries write, which are read-only), never 'every sanctioned
//    source that names .sterling' — the 14 entries include reads, SQLite
//    paths, sandboxes, domain stores and comments, and init.mjs delegates to
//    init-impl.mjs. … R5 converts the SIMPLE writers now (no-capture,
//    rotation-note, plan-lock, delivery-oracle, domain-doctor, …);
//    commit-reviewed.mjs and review-ledger.mjs keep their locked atomic-write
//    machinery for R1's rebuild and are recorded as PENDING, not covered — a
//    one-line path import does not secure their lock/rename sequence."
//
// The record's own `alternatives_rejected` names the shape this pin must NOT
// take: "Pin by grepping every sanctioned source that names `.sterling` —
// reads, SQLite paths, sandboxes, domain stores and comments all match;
// init.mjs delegates to init-impl.mjs — a manifest of audited writers is the
// honest pin."
//
// WHAT THIS PIN IS: a per-entry VERDICT table, keyed by the live
// SANCTIONED_SCRIPTS list (imported above, so the table cannot drift from the
// real list in either direction), plus a source-grep enforcement of the
// `converted` verdict only.
//
// WHAT IT CANNOT PROVE — stated because a pin that overclaims is worse than no
// pin (the source grep is a grep, not a dataflow analysis):
//   · it cannot prove the resolved path is the one actually WRITTEN to — only
//     that the helper is imported and called in the file;
//   · it cannot see a path assembled in a HELPER MODULE the script imports
//     (init.mjs → init-impl.mjs is exactly this shape, which is one reason
//     init.mjs is not classified `converted` here);
//   · it cannot distinguish a READ from a WRITE, so a converted writer that
//     also reads through a lexical join will go red — see
//     READ_ONLY_JOIN_EXEMPTIONS below for the ONE reviewed way to resolve that;
//   · it greps THREE assembly forms — join/resolve calls, template literals,
//     and path-shaped string concatenation — and those three are all it sees.
//     Specifically NOT covered, and named here rather than left implied: a
//     bare `root + '.sterling'` with no following separator; a path assembled
//     across statements through an intermediate variable (`const seg =
//     '.sterl' + 'ing';`); a segment read from a constant defined elsewhere;
//     and anything built by a called function. A grep is a lexical check, not
//     a dataflow analysis, and this list is the honest boundary of it;
//   · it says nothing about the TOCTOU residual the record scopes and states
//     ("check-then-mkdirSync remains a TOCTOU window; the helper provides
//     single-user local containment, not adversarial concurrent safety").
//
// ⚠ VERDICTS THIS AUTHOR HAD TO GUESS — the dispatch brief's instruction, and
// the conductor's reconciliation point before the gate. The record names five
// simple writers, two read-only entries and two pending-locked entries; that is
// NINE of the FIFTEEN shipped entries. A tenth — the TUI BUNDLE — is settled by
// its own nature rather than by the record (`bundle-not-applicable`: a built
// artifact cannot import a script-relative helper).
//
// RECONCILED 2026-09-07 — the `unknown` set is now EMPTY: the conductor
// adjudicated the remaining five against the R5 coder's audited manifest, and
// two of those verdicts were CORRECTED in review (init and consume-exit were
// both provisionally `read-only`, and neither is: see their entries). An
// `unknown` reappearing means a NEW sanctioned entry awaiting audit — it is
// DELIBERATELY NOT source-grepped, because an unknown verdict must never
// masquerade as coverage; neither does `bundle-not-applicable` or
// `delegates-unconverted`, which claim exemption, not compliance. The
// UNKNOWN_TODAY assertion below is what forces every future reconciliation to
// be a deliberate, reviewable edit rather than a silent drift.
// ############################################################################

const VERDICT = Object.freeze({
  // ── CONVERTED: derives its `.sterling/` write path through
  //    resolveStoreWritePath() from scripts/lib/store-path.mjs.
  //    All five are named verbatim in the record's "R5 converts the SIMPLE
  //    writers now (…)" list.
  'scripts/no-capture.mjs': 'converted',
  'scripts/rotation-note.mjs': 'converted',
  // DISCLOSURE (review finding), so this verdict is not read as more than it
  // is: plan-lock's CONVERTED status covers the CLI's OWN `.sterling/` write
  // path. Its lock and claim-by-rename MARKER writes are joined inside
  // scripts/hooks/lib/plan-lock.mjs — a HOOK LIB, which is not a sanctioned
  // entry and is therefore outside this manifest's reach entirely. Converting
  // the CLI does not contain those writes, and this pin does not claim it does.
  'scripts/plan-lock.mjs': 'converted',
  'scripts/delivery-oracle.mjs': 'converted',
  'scripts/domain-doctor.mjs': 'converted',

  // ── READ-ONLY: named as such by the record ("the audit found 12 logical
  //    writers (projection and migration-preflight read-only)").
  'scripts/architecture-projection.mjs': 'read-only',
  'scripts/migration-preflight.mjs': 'read-only',

  // ── PENDING-LOCKED: named as such by the record — their locked atomic-write
  //    machinery is R1 rebuild territory, and "a one-line path import does not
  //    secure their lock/rename sequence". NOT covered by R5, and recorded as
  //    not covered rather than silently omitted.
  'scripts/commit-reviewed.mjs': 'pending-locked',
  'scripts/review-ledger.mjs': 'pending-locked',

  // ── UNKNOWN: the record's "…" in its converted list does not enumerate
  //    these, and this author holds no read access to any of them (H4 read
  //    wall). Each carries the reason it could not be settled from the spec.
  //    A wrong guess here would be worse than an honest `unknown`: guessing
  //    `converted` would turn on a source grep that may legitimately fail, and
  //    guessing `read-only` would claim an audit that was never performed.
  //    RECONCILED 2026-09-07 against the R5 coder's audited manifest (conductor
  //    adjudication; the evidence file:lines are in the R5 commit message):
  //    dispose-run — its only store write path is runDir() in
  //    scripts/lib/project.mjs, converted AT THE SOURCE (runDir calls the
  //    helper); the script constructs no path itself → `converted-via-lib`
  //    (path greps run on the script; the import/call requirement is asserted
  //    on project.mjs). init — zero store-path construction in its own source
  //    (delegates in-process to init-impl.mjs, not a sanctioned entry).
  //    consume-exit — every write is store.casTransitionMerge(...), the
  //    validated store path, never a raw join. migrate-stores — five sites
  //    converted; its LOCAL flag parser stays (dependency-free bootstrap
  //    constraint in its header). test-repair — configPath/eventsPath
  //    converted, flags on the shared parser.
  'scripts/dispose-run.mjs': 'converted-via-lib',
  // REVIEW CORRECTION: init is NOT read-only — it MATERIALIZES config.json and
  // the store. It constructs no store path in its OWN source because it
  // delegates in-process to scripts/init-impl.mjs, which is not a sanctioned
  // entry and so lies outside this manifest's reach. `read-only` would have
  // been a false claim about a script whose whole job is to write; the honest
  // verdict names the delegation and the fact that R5 did not convert it.
  'scripts/init.mjs': 'delegates-unconverted',
  // REVIEW CORRECTION (Codex thread 01a07ad1): consume-exit is NOT read-only
  // either — it performs store TRANSITIONS through store.casTransitionMerge,
  // the validated @sterling/store surface. It constructs no store path, so the
  // helper does not apply, but "writes only through the store API" is a
  // different claim from "does not write" and gets its own class. The path
  // greps still run on it and must find nothing.
  'scripts/consume-exit.mjs': 'writes-via-store-api',
  'scripts/migrate-stores.mjs': 'converted',
  'scripts/test-repair.mjs': 'converted',

  // ── BUNDLE-NOT-APPLICABLE: a BUILT ARTIFACT, not a script. esbuild emits it
  //    from packages/tui, so it cannot import scripts/lib/store-path.mjs the
  //    way a script does, and its store access goes through packages/store
  //    rather than a joined path. Classified as its own class rather than
  //    `unknown` (it is not awaiting an audit) and rather than `read-only`
  //    (which would be a false claim — the TUI writes). Source-grepping a
  //    generated bundle would pin the bundler's output, not anyone's code.
  'packages/tui/bundle/sterling-tui.mjs': 'bundle-not-applicable',
});

// The verdict vocabulary. Each class is a DIFFERENT claim, and the difference
// is exactly what stops one from laundering another:
//   converted            — derives its own `.sterling/` write path through the helper
//   converted-via-lib    — constructs no path itself; its write path comes from a
//                          converted lib site (asserted separately, on the lib)
//   writes-via-store-api — writes only through @sterling/store; no path construction
//   delegates-unconverted— writes by delegating to a non-sanctioned module; NOT covered
//   read-only            — does not write under `.sterling/` at all
//   pending-locked       — a writer R5 deliberately did not convert (R1 territory)
//   bundle-not-applicable— a built artifact, not a script
//   unknown              — not yet audited; deliberately not grepped
const CLASSES = Object.freeze([
  'converted',
  'converted-via-lib',
  'writes-via-store-api',
  'delegates-unconverted',
  'read-only',
  'pending-locked',
  'bundle-not-applicable',
  'unknown',
]);

// Classes whose sources must be PATH-GREPPED even though they do not import the
// helper: each claims "constructs no store path", and the greps are what make
// that claim checkable rather than asserted.
const GREP_ONLY_CLASSES = Object.freeze(['converted-via-lib', 'writes-via-store-api']);

// The LIB SITE behind `converted-via-lib`. dispose-run's only store write path
// is runDir() in scripts/lib/project.mjs, so the import/call requirement lands
// HERE rather than on the script — and the same path greps run on the lib, or
// the conversion would be provable nowhere at all.
const LIB_SITES = Object.freeze(['scripts/lib/project.mjs']);

const entriesWith = (verdict) => Object.keys(VERDICT).filter((k) => VERDICT[k] === verdict);

// The FIVE remaining unknowns, spelled out a SECOND time on purpose: this is
// what turns a silent table edit into a red test. Reconciling a verdict is a
// two-line edit (the table + this list), which is exactly the deliberateness
// this pin wants. (`packages/tui/bundle/sterling-tui.mjs` left this list when
// it was classified `bundle-not-applicable` — it is settled, not unaudited.)
const UNKNOWN_TODAY = [
  // EMPTY since 2026-09-07 — every shipped entry is audited. An `unknown`
  // reappearing here means a NEW sanctioned entry awaiting its audit.
];

// A converted writer that trips the source grep for a reason that is NOT a
// store write-path construction is a REVIEWED DECISION POINT, not a reason to
// loosen the regex. Record the exemption here, with an ANCHOR and the reason.
//
// THE ANCHOR IS WHAT KEEPS THIS HONEST: an exemption is not "this file is
// excused". It excuses only a match WHOSE OWN MATCHED TEXT the anchor matches.
// Every OTHER match in the same file is still an offender, which is what the
// mechanism control below proves on a synthetic source carrying both shapes —
// INCLUDING both shapes on ONE LINE. A file-level skip would have blinded the
// pin to every genuine construction in delivery-oracle.mjs.
//
// NARROWED (review finding, LOW): the anchor test previously also accepted a
// hit on the RAW LINE the match started on, which meant a genuine construction
// written on the SAME LINE as the exempted one would be excused with it. The
// anchor is now tested against `m[0]` alone. Consequence, and the reason the
// anchor is a REGEX rather than a substring: `m[0]` comes from the SCRUBBED
// code, where `'.gitignore'` has been blanked to spaces (it is not a
// KEEP_LITERAL), so the anchor must describe the scrubbed shape.
//
// A stale anchor is loud too: each anchor must still match somewhere in its
// file's scrubbed code (asserted below), so an exemption cannot outlive the
// code it excuses.
const READ_ONLY_JOIN_EXEMPTIONS = Object.freeze({
  // GATE FINDING (measured): delivery-oracle.mjs:1055 is
  //   writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  // The `.sterling/` string is GITIGNORE CONTENT written into a sandbox file —
  // not a path being constructed. The `join(` builds the `.gitignore` path and
  // CLOSES; the content literal is an argument to the ENCLOSING writeFileSync.
  // KEEP_LITERAL preserves the content literal on purpose, so the two co-match.
  // The regex is correct and stays as it is; the honest resolution is a narrow,
  // anchored, reasoned exemption.
  //
  // THE ANCHOR, read against the SCRUBBED text `join(dir,        ), '.sterling`:
  //   `join(<identifier>,` + a RUN OF BLANKS (the scrubbed non-.sterling
  //   literal argument) + `)` + `,` + the `.sterling` literal.
  // The blank run is the load-bearing part: it says the join's own arguments
  // did NOT include `.sterling`, which is precisely what distinguishes this
  // from `join(findProjectRoot(), '.sterling', …)` — the nested-call shape that
  // MUST keep matching (it has no blank run and its `.sterling` is a join
  // argument). If the line is reformatted, this anchor stops matching and the
  // stale-exemption assertion goes red printing the file — re-point the anchor
  // to the new shape, never widen it.
  'scripts/delivery-oracle.mjs': [
    {
      anchor: /join\(\s*\w+\s*,\s{2,}\)\s*,\s*['"`]\.sterling/,
      reason: "gitignore CONTENT literal ('.sterling/'), not a path construction — the join() on this line builds the .gitignore path and closes before the .sterling literal, which is an argument to the enclosing writeFileSync",
    },
  ],
});

/**
 * Every non-exempt match of `re` in the SCRUBBED code, reported against the RAW
 * source so each failure names a real file line (the scrubber is
 * position-preserving, so indexes map straight across). Returns [] when clean.
 *
 * Scans ALL matches rather than the first: a single offender must never hide
 * the ones behind it (anti-pattern `early-assertion-masks-every-later-
 * assertion-in-the-same-test`, applied here to matches rather than asserts).
 */
function pathOffenders(rawSrc, code, re, exemptions = []) {
  const rawLines = rawSrc.split('\n');
  const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  const offenders = [];
  let m;
  while ((m = g.exec(code)) !== null) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    const lineNo = code.slice(0, m.index).split('\n').length;
    const rawLine = rawLines[lineNo - 1] ?? '';
    // MATCH-anchored: the anchor is tested against THIS match's own text, never
    // against the line it sits on. Two constructions on one line are two
    // independent verdicts.
    if (exemptions.some((e) => e.anchor.test(m[0]))) continue;
    offenders.push(`line ${lineNo}: ${rawLine.trim()}  [matched: ${JSON.stringify(m[0])}]`);
  }
  return offenders;
}

// ── SOURCE SCRUBBING (measured false-red, fixed here) ───────────────────────
//
// THE DEFECT THIS CLOSES: with the argument run widened to `[^;]{0,200}?`, the
// LEXICAL_JOIN pattern false-red on scripts/delivery-oracle.mjs — it matched a
// real `join(` call and then ran THROUGH A COMMENT BLOCK that mentions
// `'.sterling` about 200 characters later ("join() call. It is materialized
// later // by applyWrites()/sandboxPath() … rel: '.sterling"). Prose is not a
// path construction, and a pin that reds on a comment teaches people to weaken
// the pin.
//
// THE FIX: grep CODE, not prose. scrubSource blanks line comments, block
// comments, string/template literals and regex literals with spaces,
// PRESERVING every line and column so a reported line number stays exact. The
// shape is copied (deliberately, not imported — test files do not depend on
// each other) from scripts/tests/hook-terminal-calls-return.test.mjs, which
// already solved this for the terminal-call scan.
//
// ONE DELIBERATE DIVERGENCE from that original: a string/template literal
// whose text contains `.sterling` is KEPT, because that literal IS the write
// path segment these greps exist to see — blanking it would scrub away the
// very evidence. A literal naming `store-path.mjs` is kept for the same
// reason (the helper import specifier is checked on the scrubbed text too).
//
// It is a character scanner, not a parser. Its one deliberate bound: an
// unterminated single/double-quoted string bails at end of line, so the worst
// a mis-scan can do is blank the remainder of ONE line rather than swallow the
// rest of the file.
//
// RESIDUAL, disclosed rather than hidden: because `.sterling` literals are
// kept, a DIAGNOSTIC string that names a `.sterling` path still participates
// in the scan, so a `join(` call within 200 non-semicolon characters of such a
// message could still co-match. The CONCAT/TEMPLATE controls above pin that
// prose alone is not flagged; this residual needs a `join(` call in the same
// statement window, which is a far narrower shape than the comment case that
// actually bit.

const REGEX_PREV_CHARS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
const REGEX_PREV_KEYWORD = /\b(return|typeof|case|in|of|do|else|void|delete|new|yield|await)$/;
// The ONLY literal worth keeping: the write-path segment itself.
//
// NARROWED (Codex review, thread 01a07ad1): this used to keep `store-path.mjs`
// literals too, so the import specifier would survive scrubbing. That opened a
// laundering route — ONE inert string literal,
//   "import { resolveStoreWritePath } from './lib/store-path.mjs'; resolveStoreWritePath("
// sitting in a message or a comment-as-string, satisfied BOTH the
// NO-HELPER-IMPORT and IMPORTED-BUT-UNUSED assertions while the file imported
// and called nothing. The specifier is no longer kept; instead the import
// assertion runs against RAW LINES THAT BEGIN WITH `import` (a string literal
// cannot be an import statement) and the call assertion runs against scrubbed
// code (where such a literal is now blanked). Both halves are pinned by the
// inert-literal control below.
const KEEP_LITERAL = /\.sterling/;

/**
 * The raw source restricted to its IMPORT STATEMENTS — lines whose trimmed text
 * begins with `import`. A string literal, however carefully worded, is not an
 * import statement, and a commented-out import does not start a line with
 * `import` after trimming (`// import …` starts with `/`).
 */
function importLines(rawSrc) {
  return rawSrc
    .split('\n')
    .filter((l) => l.trimStart().startsWith('import'))
    .join('\n');
}

// Checked against importLines(raw) — never against the whole source.
const HELPER_IMPORT = /import\s*\{[^}]*\bresolveStoreWritePath\b[^}]*\}\s*from\s*['"][^'"]*store-path\.mjs['"]/;
// Checked against scrubSource(raw) — never against the raw text, so a mention
// inside a comment or a string cannot stand in for a call site.
const HELPER_CALL = /\bresolveStoreWritePath\s*\(/;

function scrubSource(src) {
  const n = src.length;
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prev = ''; // last significant (non-whitespace) character seen in code position
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        if (c !== '`' && src[j] === '\n') break; // unterminated: bounded to this line
        j++;
      }
      j = Math.min(j, n);
      // THE DIVERGENCE: keep a literal that carries the evidence.
      if (!KEEP_LITERAL.test(src.slice(i, j))) blank(i, j);
      i = j;
      prev = c;
      continue;
    }
    if (c === '/' && (REGEX_PREV_CHARS.has(prev) || REGEX_PREV_KEYWORD.test(src.slice(Math.max(0, i - 12), i).trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const e = src[j];
        if (e === '\\') {
          j += 2;
          continue;
        }
        if (e === '\n') break;
        if (inClass) {
          if (e === ']') inClass = false;
        } else if (e === '[') {
          inClass = true;
        } else if (e === '/') {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i, j);
        i = j;
        prev = '/';
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

/**
 * First match of `re` in the SCRUBBED code, reported against the RAW source so
 * the failure names a real file line (the scrubber is position-preserving, so
 * the index maps straight across). Returns null when there is no match.
 */
function offendingLine(rawSrc, code, re) {
  const m = code.match(re);
  if (!m) return null;
  const lineNo = code.slice(0, m.index).split('\n').length;
  return `line ${lineNo}: ${rawSrc.split('\n')[lineNo - 1].trim()}  [matched: ${JSON.stringify(m[0])}]`;
}

// A lexically-joined `.sterling` path — the construction the helper replaces.
// Matches `join(root, '.sterling'`, `path.join(dir, '.sterling'`,
// `resolve(projectRoot, '.sterling'` including across a line break. Does NOT
// match `resolveStoreWritePath(root, '.sterling', …)`, because `resolve` there
// is not immediately followed by `(`.
//
// WIDENED (review finding): the argument run was `[^;)]{0,200}?`, whose `)`
// exclusion made the pattern MISS a nested call before the segment —
// `join(findProjectRoot(), '.sterling', 'transient', 'x.json')` slipped
// through, which is a perfectly ordinary way to write the very construction
// being banned. The run is now bounded by the statement terminator alone
// (`[^;]`), so an intervening `)` no longer stops the match; the added
// MUST-MATCH control below is that exact string.
//
// TEMPERED (gate finding, measured on scripts/migrate-stores.mjs:799):
//   const domainDbPath = rawMount ? resolve(repoPath, rawMount)
//     : resolveStoreWritePath(homedir(), '.sterling', 'domains', tag, 'sterling.db');
// The leading, entirely unrelated `resolve(repoPath, rawMount)` matched, and
// its `[^;]` run then reached the `'.sterling'` literal that belongs to the
// HELPER CALL — i.e. correctly-converted code was flagged by the very literal
// that proves it is converted. The argument run is now a TEMPERED token
// (`(?!resolveStoreWritePath\()[^;]`): it may not cross a
// `resolveStoreWritePath(` token, so a store-path literal owned by the helper
// call can never be attributed to a preceding call. A genuine construction that
// PRECEDES a helper call in the same statement still matches, because its own
// `.sterling` literal comes before that token — pinned as a MUST-MATCH control.
const LEXICAL_JOIN = /\b(?:path\s*\.\s*)?(?:join|resolve)\s*\(\s*(?:(?!resolveStoreWritePath\()[^;]){0,200}?['"`]\.sterling\b/;
// A template-literal `.sterling` path — the obvious way around the grep above.
const TEMPLATE_PATH = /\$\{[^}]*\}\s*[/\\]\s*\.sterling\b/;
// String-CONCATENATION path assembly — the other way around the two above
// (review finding: `root + '/.sterling/…'` was covered by neither pattern).
// Both directions are matched. Deliberately requires the quoted fragment to
// BEGIN at `.sterling` (with at most a leading separator) and to be FOLLOWED
// by a separator, i.e. to be path-shaped: that is what keeps ordinary error
// prose such as `throw new Error('bad .sterling path: ' + p)` from being
// flagged as a path construction, which would be a false red on exactly the
// diagnostic messages these writers should be emitting.
const CONCAT_PATH = /(?:\+\s*['"`][/\\]?\.sterling[/\\])|(?:['"`][/\\]?\.sterling[/\\][^'"`\n]*['"`]\s*\+)/;

test('R5 writer manifest: the regexes themselves detect what they claim to (control — a green table means nothing if the grep matches nothing)', () => {
  // MUST MATCH — if any of these stops matching, every "no lexical join"
  // assertion below becomes vacuously green and the whole manifest pin is
  // hollow. This is the control arm for the entire section.
  for (const bad of [
    "const p = join(root, '.sterling', 'transient', 'session-events.json');",
    'const p = path.join(dir, ".sterling", "config.json");',
    "const p = resolve(projectRoot, '.sterling');",
    "const p = join(\n  root,\n  '.sterling',\n  'transient',\n);",
    // NESTED CALL before the segment — the review finding. The previous
    // `[^;)]` argument run stopped at the inner `)` and MISSED this entirely.
    "const p = join(findProjectRoot(), '.sterling', 'transient', 'x.json');",
    // A GENUINE construction that PRECEDES a helper call in the same statement
    // must still match — the tempering below must not become a blanket
    // "any statement mentioning the helper is excused".
    "const p = resolve(root, '.sterling', 'x') || resolveStoreWritePath(root, '.sterling', 'y');",
  ]) {
    assert.match(bad, LEXICAL_JOIN, `CONTROL-ARM-BROKEN SHAPE: LEXICAL_JOIN must match a lexically joined .sterling path: ${bad}`);
  }
  assert.match('const p = `${root}/.sterling/transient/x.json`;', TEMPLATE_PATH, 'CONTROL-ARM-BROKEN SHAPE: TEMPLATE_PATH must match a template-literal .sterling path');
  // CONCAT controls, both directions.
  for (const bad of [
    "const p = root + '/.sterling/transient/x.json';",
    'const p = dir + "/.sterling/config.json";',
    "const p = '/.sterling/transient/' + name;",
  ]) {
    assert.match(bad, CONCAT_PATH, `CONTROL-ARM-BROKEN SHAPE: CONCAT_PATH must match a concatenated .sterling path: ${bad}`);
  }

  // MUST NOT MATCH (the opposite reason) — the sanctioned call itself passes
  // '.sterling' as a segment, so a regex that flagged it would make every
  // correctly-converted writer red and the pin unusable.
  for (const good of [
    "const p = resolveStoreWritePath(root, '.sterling', 'transient', 'session-events.json');",
    "import { resolveStoreWritePath } from './lib/store-path.mjs';",
    "// writes under .sterling/transient — see store-path.mjs",
    // Diagnostic prose that merely NAMES a path is not a path construction.
    // A converted writer's own refusal messages must not be what makes it red.
    "throw new Error('bad .sterling path: ' + p);",
    "console.error('refusing to write ' + target + ' (.sterling containment)');",
    // THE MEASURED FALSE POSITIVE, verbatim (scripts/migrate-stores.mjs:799):
    // an unrelated `resolve(repoPath, rawMount)` whose argument run would
    // otherwise reach the HELPER CALL's own '.sterling' literal. Correctly
    // converted code must never be flagged by the literal that proves it.
    "const domainDbPath = rawMount ? resolve(repoPath, rawMount) : resolveStoreWritePath(homedir(), '.sterling', 'domains', tag, 'sterling.db');",
  ]) {
    assert.doesNotMatch(good, LEXICAL_JOIN, `OVER-MATCH SHAPE: LEXICAL_JOIN must not flag the sanctioned call, a comment or diagnostic prose: ${good}`);
    assert.doesNotMatch(good, TEMPLATE_PATH, `OVER-MATCH SHAPE: TEMPLATE_PATH must not flag the sanctioned call, a comment or diagnostic prose: ${good}`);
    assert.doesNotMatch(good, CONCAT_PATH, `OVER-MATCH SHAPE: CONCAT_PATH must not flag the sanctioned call, a comment or diagnostic prose: ${good}`);
  }
});

test('R5 writer manifest: scrubSource removes PROSE from the scan without removing the write path (the delivery-oracle false-red)', () => {
  // The measured false-red, reduced: a real join() call followed by a COMMENT
  // that mentions a `.sterling` path inside the same statement window. This is
  // scripts/delivery-oracle.mjs's actual shape.
  // NO SEMICOLON between the join() and the comment — that is what the
  // measured false-red actually looked like, and it is load-bearing: a `;`
  // terminates the `[^;]{0,200}?` run, so a semicolon-carrying sample never
  // matched raw and the non-vacuity arm below was asserting nothing (gate
  // finding: CONTROL-ARM-BROKEN, this sample was wrong, not the regex).
  const commentCase =
    "const p = join(a, b) // materialized later\n// by applyWrites()/sandboxPath() with rel: '.sterling/transient/x.json'\n";
  // FIRST, the non-vacuity control: the RAW text really does match — so a
  // green below proves the SCRUBBER did the work, not that the sample was
  // harmless all along. Without this arm, deleting the scrubber's comment
  // branch would leave this test green.
  assert.match(commentCase, LEXICAL_JOIN, 'CONTROL-ARM-BROKEN SHAPE: the raw comment case must match, or this test proves nothing about scrubbing');
  // EXPECTED FAILURE SHAPE if this goes red: prose is being scanned as code
  // again, and every converted writer with a `.sterling` comment near a join()
  // call goes red for a documentation reason.
  assert.doesNotMatch(scrubSource(commentCase), LEXICAL_JOIN, 'COMMENT-SCANNED-AS-CODE SHAPE: a .sterling mention inside a line comment must not be scanned');

  // Same, in a block comment.
  // Likewise semicolon-free, for the same reason.
  const blockCase = "const p = join(a, b)\n/* rel: '.sterling/transient/x.json' is written by the helper */\n";
  assert.match(blockCase, LEXICAL_JOIN, 'CONTROL-ARM-BROKEN SHAPE: the raw block-comment case must match');
  assert.doesNotMatch(scrubSource(blockCase), LEXICAL_JOIN, 'COMMENT-SCANNED-AS-CODE SHAPE (block comment)');

  // AND THE OTHER HALF — the scrubber must not scrub away the evidence. A real
  // lexical construction still matches AFTER scrubbing, in all three forms.
  // EXPECTED FAILURE SHAPE if any goes red: the scrubber blanks `.sterling`
  // string literals, which would silently disarm the entire manifest pin while
  // every test still passed.
  assert.match(
    scrubSource("const p = join(root, '.sterling', 'transient', 'session-events.json');"),
    LEXICAL_JOIN,
    'EVIDENCE-SCRUBBED SHAPE: a genuine join(root, \'.sterling\', …) must still match after scrubbing',
  );
  assert.match(scrubSource('const p = `${root}/.sterling/transient/x.json`;'), TEMPLATE_PATH, 'EVIDENCE-SCRUBBED SHAPE (template literal)');
  assert.match(scrubSource("const p = root + '/.sterling/transient/x.json';"), CONCAT_PATH, 'EVIDENCE-SCRUBBED SHAPE (concatenation)');

  // The import specifier is NO LONGER kept by KEEP_LITERAL (see its note), so
  // the import check reads raw import LINES instead. A real import statement is
  // found there; the inert-literal control below proves a string cannot be.
  assert.match(
    importLines("const x = 1;\nimport { resolveStoreWritePath } from './lib/store-path.mjs';\n"),
    HELPER_IMPORT,
    'IMPORT-CHECK-BROKEN SHAPE: a real import statement must be visible to importLines()',
  );

  // Position preservation — a reported line number must be the real one.
  const multi = "const a = 1;\n// '.sterling' in prose\nconst p = join(root, '.sterling');\n";
  assert.equal(scrubSource(multi).split('\n').length, multi.split('\n').length, 'POSITION-DRIFT SHAPE: scrubbing must preserve line count');
  assert.match(offendingLine(multi, scrubSource(multi), LEXICAL_JOIN), /^line 3:/, 'POSITION-DRIFT SHAPE: the offender is reported on its real line (3), not the commented line 2');
});
test('R5 writer manifest: an INERT STRING LITERAL cannot satisfy the helper import/call checks (the KEEP_LITERAL laundering route)', () => {
  // Codex review, thread 01a07ad1: while KEEP_LITERAL preserved `store-path.mjs`
  // literals, ONE inert string sitting anywhere in a file satisfied BOTH the
  // import and the call assertions — a file that imported and called nothing
  // could be certified converted. This is the shape, verbatim.
  const laundered =
    'const msg = "import { resolveStoreWritePath } from \'./lib/store-path.mjs\'; resolveStoreWritePath(";\n' +
    "const p = join(root, '.sterling', 'x.json');\n";

  // EXPECTED FAILURE SHAPE if this goes red: the import check is reading the
  // whole source again (or KEEP_LITERAL kept the specifier), so a string can
  // pose as an import statement.
  assert.doesNotMatch(
    importLines(laundered),
    HELPER_IMPORT,
    'IMPORT-LAUNDERED SHAPE: a string literal containing an import statement must not satisfy the import check — importLines() sees only lines that BEGIN with `import`',
  );
  // EXPECTED FAILURE SHAPE if this goes red: KEEP_LITERAL is keeping
  // `store-path.mjs` literals again, so the scrubbed code still contains the
  // fake call text.
  assert.doesNotMatch(
    scrubSource(laundered),
    HELPER_CALL,
    'CALL-LAUNDERED SHAPE: a call site mentioned inside a string literal must be scrubbed away before the call check runs',
  );

  // CONTROL (must pass for the OPPOSITE reason): the real thing still passes
  // both checks — otherwise this test would be satisfied by checks that never
  // match anything.
  const genuine = "import { resolveStoreWritePath } from './lib/store-path.mjs';\nconst p = resolveStoreWritePath(root, '.sterling', 'x.json');\n";
  assert.match(importLines(genuine), HELPER_IMPORT, 'CONTROL-ARM-BROKEN SHAPE: a real import must still satisfy the import check');
  assert.match(scrubSource(genuine), HELPER_CALL, 'CONTROL-ARM-BROKEN SHAPE: a real call must still satisfy the call check');

  // And a COMMENTED-OUT import is not an import (it starts with `/`, not
  // `import`), which the raw-source check could never tell apart.
  assert.doesNotMatch(
    importLines("// import { resolveStoreWritePath } from './lib/store-path.mjs';\n"),
    HELPER_IMPORT,
    'COMMENTED-IMPORT SHAPE: a commented-out import must not satisfy the import check',
  );
});
// SABOTAGE: restore `store-path\.mjs` to KEEP_LITERAL — the CALL-LAUNDERED
// assertion goes red immediately.
// SABOTAGE: check the import against the whole raw source instead of
// importLines() — the IMPORT-LAUNDERED and COMMENTED-IMPORT assertions go red.

test('R5 writer manifest: a READ_ONLY_JOIN_EXEMPTION excuses ONLY its anchored match — including a genuine construction on the SAME LINE', () => {
  // A synthetic source carrying BOTH shapes. Line 1 is the delivery-oracle
  // gitignore-content case the exemption covers; line 2 is a genuine store
  // write-path construction; LINE 3 puts BOTH on one line — the review's LOW
  // finding, and the reason the anchor is tested against the matched text
  // rather than the line it sits on.
  const sample =
    "writeFileSync(join(dir, '.gitignore'), '.sterling/\\n');\n" +
    "const p = join(root, '.sterling', 'transient', 'x.json');\n" +
    "writeFileSync(join(dir, '.gitignore'), '.sterling/\\n'); const q = join(root, '.sterling', 'q.json');\n";
  const code = scrubSource(sample);

  // NON-VACUITY ARM FIRST: with NO exemptions there are FOUR matches (one on
  // line 1, one on line 2, two on line 3). If this ever reports fewer, the
  // assertions below would pass because the pattern stopped matching rather
  // than because the exemption was narrow.
  const unexempted = pathOffenders(sample, code, LEXICAL_JOIN, []);
  assert.equal(unexempted.length, 4, `CONTROL-ARM-BROKEN SHAPE: all four constructions must match before exemptions are applied. got=${JSON.stringify(unexempted)}`);

  // THE MECHANISM: the real exemption entry, applied verbatim from the table.
  const withExemption = pathOffenders(sample, code, LEXICAL_JOIN, READ_ONLY_JOIN_EXEMPTIONS['scripts/delivery-oracle.mjs']);
  // EXPECTED FAILURE SHAPE at length 0: the exemption is behaving as a
  // FILE-level skip and has swallowed the genuine constructions too.
  // EXPECTED FAILURE SHAPE at length 1: the LINE-anchored behaviour is back and
  // line 3's genuine construction was excused by its gitignore neighbour.
  assert.equal(withExemption.length, 2, `FILE-LEVEL-SKIP / LINE-ANCHORED SHAPE: exactly the two genuine constructions must survive. got=${JSON.stringify(withExemption)}`);
  assert.match(withExemption[0], /^line 2:/, 'WRONG-MATCH-EXEMPTED SHAPE: the first survivor is line 2');
  assert.match(withExemption[1], /^line 3:/, 'SAME-LINE-EXEMPTED SHAPE: the second survivor is the genuine construction sharing line 3 with an exempted one');
  for (const o of withExemption) {
    assert.match(o, /join\(root, '\.sterling'/, `WRONG-MATCH-EXEMPTED SHAPE: every survivor must be a join(root, '.sterling', …) construction, got ${o}`);
  }
});
// SABOTAGE: change the exemption test in pathOffenders to a file-level
// `if (exemptions.length) return []` — the length assertion goes red (0 instead
// of 2), which is why the exemption is anchored rather than file-scoped.
// SABOTAGE: restore the `|| rawLine.includes(e.anchor)` half of the anchor test
// with a substring anchor — line 3's genuine construction is excused by its
// neighbour, length becomes 1, and the SAME-LINE assertion goes red.

// SABOTAGE: delete the `if (c === '/' && d === '/')` line-comment branch from
// scrubSource — the COMMENT-SCANNED-AS-CODE assertion goes red.
// SABOTAGE: drop the KEEP_LITERAL exception entirely (blank every string
// literal, including `.sterling` ones) — the three EVIDENCE-SCRUBBED
// assertions go red, which is the disarm-the-pin shape this test's second half
// exists for. (The import check is unaffected: it reads raw import lines.)
// SABOTAGE: relax LEXICAL_JOIN to something that cannot match (e.g. require
// `join(` and `.sterling` to be adjacent with no argument between them) — the
// four MUST-MATCH assertions go red here, BEFORE the converted-writer loop
// below silently passes. That ordering is the point: the grep is proven to
// work before any verdict is drawn from it.

test('R5 writer manifest: every SANCTIONED_SCRIPTS entry carries exactly one verdict, and the table carries no entry that is not shipped', () => {
  // Keyed off the LIVE list (imported from the module), so a script added to
  // SANCTIONED_SCRIPTS without an audited verdict cannot slip through
  // unclassified — the honest failure mode for a manifest pin.
  for (const script of SANCTIONED_SCRIPTS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(VERDICT, script),
      `UNCLASSIFIED-ENTRY SHAPE: '${script}' is shipped-sanctioned but carries no verdict in this manifest. Audit it and add one of ${CLASSES.join(' | ')} — never delete the assertion.`,
    );
    assert.ok(CLASSES.includes(VERDICT[script]), `BAD-VERDICT SHAPE: '${script}' carries verdict '${VERDICT[script]}', which is not one of ${CLASSES.join(' | ')}`);
  }

  // The other direction — a verdict for a script that is no longer shipped is
  // dead audit text pretending to be coverage.
  for (const script of Object.keys(VERDICT)) {
    assert.ok(
      SANCTIONED_SCRIPTS.includes(script),
      `STALE-VERDICT SHAPE: this manifest classifies '${script}', which is not on the shipped sanctioned list — remove the verdict or restore the entry`,
    );
  }

  // Counts, so a wholesale table rewrite is loud rather than merely different.
  assert.equal(Object.keys(VERDICT).length, SANCTIONED_SCRIPTS.length, 'the manifest classifies exactly the shipped list, one verdict per entry');
});
// SABOTAGE: add a new script to SANCTIONED_SCRIPTS (and config.ts, so the
// drift pin stays green) without touching this table — the UNCLASSIFIED-ENTRY
// assertion goes red naming it, which is the whole reason the table is keyed
// off the live list instead of a second literal.

test('R5 writer manifest: the record-named verdicts are exactly as the decision states them', () => {
  // The five SIMPLE writers the record converts now, by name.
  for (const script of ['scripts/no-capture.mjs', 'scripts/rotation-note.mjs', 'scripts/plan-lock.mjs', 'scripts/delivery-oracle.mjs', 'scripts/domain-doctor.mjs']) {
    assert.equal(VERDICT[script], 'converted', `RECORD-DRIFT SHAPE: the decision names '${script}' among the simple writers R5 converts`);
  }
  // The two the record calls read-only.
  for (const script of ['scripts/architecture-projection.mjs', 'scripts/migration-preflight.mjs']) {
    assert.equal(VERDICT[script], 'read-only', `RECORD-DRIFT SHAPE: the decision names '${script}' as read-only ("the audit found 12 logical writers (projection and migration-preflight read-only)")`);
  }
  // The two the record explicitly records as PENDING, not covered. Marking
  // either of these `converted` would claim coverage the record denies — "a
  // one-line path import does not secure their lock/rename sequence".
  for (const script of ['scripts/commit-reviewed.mjs', 'scripts/review-ledger.mjs']) {
    assert.equal(VERDICT[script], 'pending-locked', `FALSE-COVERAGE SHAPE: '${script}' is R1 rebuild territory and is recorded as PENDING by the decision — it must not be claimed as converted`);
  }
});
// SABOTAGE: re-mark 'scripts/review-ledger.mjs' as 'converted' to make a
// coverage number look better — the FALSE-COVERAGE assertion goes red naming
// it. This is the pin that stops "pending" from quietly becoming "done".

test('R5 writer manifest: the UNKNOWN set is EMPTY (every shipped entry is audited) and each exemption class holds exactly its one entry', () => {
  assert.deepEqual(
    entriesWith('unknown').sort(),
    [...UNKNOWN_TODAY].sort(),
    'UNKNOWN-DRIFT SHAPE: the set of unaudited entries changed. That is fine and expected once the coder\'s manifest lands — update BOTH the VERDICT table and UNKNOWN_TODAY in the same edit, so the change is visible in review rather than silent.',
  );
  // A non-vacuity control: if the table were ever reduced to all-unknown, the
  // converted-writer grep below would loop zero times and pass for free.
  assert.ok(entriesWith('converted').length >= 5, 'VACUOUS-MANIFEST SHAPE: at least the five record-named simple writers must be classified converted, or the source-grep test below asserts nothing at all');

  // `bundle-not-applicable` is an EXEMPTION class, and an exemption class is
  // exactly the thing that spreads. It applies to the one built artifact on
  // the shipped list and to nothing else — a `scripts/*.mjs` entry can never
  // wear it, because a script CAN import scripts/lib/store-path.mjs.
  // EXPECTED FAILURE SHAPE if this goes red: someone reached for the exemption
  // to make a real script's grep go away.
  // SABOTAGE: re-mark 'scripts/dispose-run.mjs' as 'bundle-not-applicable' —
  // this deepEqual goes red naming it.
  assert.deepEqual(
    entriesWith('bundle-not-applicable'),
    ['packages/tui/bundle/sterling-tui.mjs'],
    'EXEMPTION-SPREAD SHAPE: bundle-not-applicable applies to the built TUI bundle alone — a script under scripts/ can import the helper and must be classified on its merits',
  );

  // `delegates-unconverted` is the OTHER exemption class, and the more
  // dangerous one: it says "this script writes, and R5 did not convert it".
  // That is an honest admission for init.mjs (its writes happen inside
  // scripts/init-impl.mjs, which is not a sanctioned entry) and a laundering
  // route for anything else — an unconverted writer could wear it to skip the
  // greps entirely.
  // EXPECTED FAILURE SHAPE if this goes red: a second script reached for the
  // admission instead of doing the conversion.
  // SABOTAGE: re-mark 'scripts/domain-doctor.mjs' as 'delegates-unconverted' to
  // dodge its greps — this deepEqual goes red naming it.
  assert.deepEqual(
    entriesWith('delegates-unconverted'),
    ['scripts/init.mjs'],
    'EXEMPTION-SPREAD SHAPE: delegates-unconverted covers init.mjs alone (it materializes config.json/store by delegating in-process to scripts/init-impl.mjs, which is not a sanctioned entry) — every other writer is converted or explicitly pending',
  );

  // `writes-via-store-api` is a CLAIM, not an exemption: consume-exit writes
  // only through store.casTransitionMerge and constructs no path — which is why
  // it is still path-grepped above. Pinned to one entry for the same
  // spread reason.
  // SABOTAGE: re-mark 'scripts/no-capture.mjs' as 'writes-via-store-api' (it
  // would skip the import/call checks) — this deepEqual goes red naming it.
  assert.deepEqual(
    entriesWith('writes-via-store-api'),
    ['scripts/consume-exit.mjs'],
    'EXEMPTION-SPREAD SHAPE: writes-via-store-api covers consume-exit alone — a script that constructs a store path must be converted, not reclassified',
  );
});
// SABOTAGE: mark every entry 'unknown' (the cheapest way to make the source
// greps pass) — the deepEqual goes red AND the >= 5 converted control goes
// red, so "audit nothing" is not an available route to green.

test('R5 writer manifest: every CONVERTED writer imports and calls resolveStoreWritePath, and constructs no lexical .sterling write path of its own', () => {
  // GREP-ONLY CLASSES — `converted-via-lib` and `writes-via-store-api`. Both
  // CLAIM "this script constructs no store path"; neither imports the helper,
  // so the import/call checks do not apply and the greps are the ONLY thing
  // making the claim checkable. Without this loop those two classes would be
  // pure assertion, which is how an exemption class becomes a hiding place.
  //   · converted-via-lib   (dispose-run) — path comes from the lib site below
  //   · writes-via-store-api (consume-exit) — writes go through
  //     store.casTransitionMerge, the validated @sterling/store surface
  // SABOTAGE: add a `join(cwd, '.sterling', 'x')` to either script — the
  // GREP-ONLY-LEXICAL assertion goes red naming the file and line.
  const grepOnly = GREP_ONLY_CLASSES.flatMap((cls) => entriesWith(cls));
  for (const script of grepOnly) {
    const src = readFileSync(join(REPO_ROOT, script), 'utf8');
    const code = scrubSource(src);
    const exemptions = READ_ONLY_JOIN_EXEMPTIONS[script] ?? [];
    for (const [name, re] of [['LEXICAL', LEXICAL_JOIN], ['TEMPLATE', TEMPLATE_PATH], ['CONCAT', CONCAT_PATH]]) {
      assert.deepEqual(
        pathOffenders(src, code, re, exemptions),
        [],
        `GREP-ONLY-${name} SHAPE: '${script}' is classified ${VERDICT[script]} — it claims to construct no store path, and this ${name.toLowerCase()} match says otherwise`,
      );
    }
  }

  // THE LIB SITE behind `converted-via-lib`. Both halves are required, and the
  // second is the one that is easy to forget: the lib must import AND call the
  // helper, and it must itself be lexically clean — a converted-via-lib verdict
  // is only as true as the lib it points at.
  // SABOTAGE: restore a lexical join in runDir() → LIB-SITE-LEXICAL red while
  // the import/call assertions stay green, which is exactly the half-conversion
  // shape this pair exists to separate.
  if (entriesWith('converted-via-lib').length > 0) {
    for (const libPath of LIB_SITES) {
      const libSrc = readFileSync(join(REPO_ROOT, libPath), 'utf8');
      const libCode = scrubSource(libSrc);
      assert.match(
        importLines(libSrc),
        HELPER_IMPORT,
        `LIB-SITE-NO-IMPORT SHAPE: ${libPath} must import resolveStoreWritePath — it is the converted site every converted-via-lib verdict points at`,
      );
      assert.match(libCode, HELPER_CALL, `LIB-SITE-NO-CALL SHAPE: ${libPath} must CALL resolveStoreWritePath (runDir), not merely import it`);
      const libExemptions = READ_ONLY_JOIN_EXEMPTIONS[libPath] ?? [];
      for (const [name, re] of [['LEXICAL', LEXICAL_JOIN], ['TEMPLATE', TEMPLATE_PATH], ['CONCAT', CONCAT_PATH]]) {
        assert.deepEqual(
          pathOffenders(libSrc, libCode, re, libExemptions),
          [],
          `LIB-SITE-${name} SHAPE: ${libPath} still constructs a store path lexically — the via-lib verdicts rest on this file being clean`,
        );
      }
    }
  }

  const converted = entriesWith('converted');
  assert.ok(converted.length > 0, 'VACUOUS-LOOP SHAPE: no converted entries to check');

  for (const script of converted) {
    const abs = join(REPO_ROOT, script);
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch (err) {
      assert.fail(`MISSING-SOURCE SHAPE: '${script}' is classified converted but could not be read at ${abs} (${err.code}). Either the file moved (fix the path) or the verdict is wrong (fix the table) — never delete the entry to get green.`);
    }
    // The path greps and the CALL check run on the SCRUBBED source: comments
    // and string literals are blanked (positions preserved), so prose can
    // neither trigger a match nor satisfy one. Only `.sterling` literals
    // survive — see KEEP_LITERAL. The IMPORT check runs on raw import LINES,
    // for the reason recorded at importLines().
    const code = scrubSource(src);

    // (1) It IMPORTS the helper from the one containment module. A converted
    // writer that hand-rolls its own containment check is the per-script shape
    // the record's rejected-alternative list rules out ("Fixes one writer and
    // one flag; every other sanctioned writer and CLI keeps the same hole").
    // EXPECTED FAILURE SHAPE if this goes red: no import of
    // resolveStoreWritePath from a store-path.mjs specifier — the script
    // either still joins lexically or grew a private containment check.
    // (Read from RAW IMPORT LINES: a string literal is not an import statement,
    // and a commented-out import does not begin a line with `import`.)
    assert.match(
      importLines(src),
      HELPER_IMPORT,
      `NO-HELPER-IMPORT SHAPE: '${script}' is classified converted but has no import statement bringing in resolveStoreWritePath from store-path.mjs`,
    );

    // (2) It CALLS it. An import alone is a hollow conversion — the symbol can
    // be imported and never used, and every other assertion here would stay
    // green.
    // EXPECTED FAILURE SHAPE if this goes red: the import exists but there is
    // no call site.
    assert.match(
      code,
      HELPER_CALL,
      `IMPORTED-BUT-UNUSED SHAPE: '${script}' imports resolveStoreWritePath but never calls it — an unused import is not a conversion (a mention inside a comment or a string does not count: the source is scrubbed)`,
    );

    // (3) It builds NO `.sterling` path lexically of its own. This is the
    // assertion that makes (1) and (2) mean something: without it, a script
    // could import the helper, call it once for show, and keep writing through
    // its old joined path.
    // EXPECTED FAILURE SHAPE if either goes red: a surviving
    // `join(root, '.sterling', …)` / `${root}/.sterling/…` construction.
    // If the offending line turns out to be a READ, that is the reviewed
    // decision point documented at READ_ONLY_JOIN_EXEMPTIONS — record it there
    // with its reason, or route the read through the helper too. Do NOT widen
    // the regex.
    const exemptions = READ_ONLY_JOIN_EXEMPTIONS[script] ?? [];
    // A stale exemption is dead text pretending to be a reviewed decision.
    // EXPECTED FAILURE SHAPE if this goes red: the code the exemption excuses
    // no longer exists — delete the exemption (and re-run), never keep it.
    // (Tested against the SCRUBBED code, because that is the text the anchor
    // describes — see the anchor note on READ_ONLY_JOIN_EXEMPTIONS.)
    for (const e of exemptions) {
      assert.ok(
        e.anchor.test(code),
        `STALE-EXEMPTION SHAPE: '${script}' carries an exemption anchored on ${String(e.anchor)}, which no longer matches anything in the file. Re-point it to the code's current shape, or delete it — an unused exemption silently widens the pin.`,
      );
    }

    assert.deepEqual(
      pathOffenders(src, code, LEXICAL_JOIN, exemptions),
      [],
      `LEXICAL-PATH-SURVIVES SHAPE: '${script}' still constructs a .sterling path with join/resolve`,
    );
    assert.deepEqual(
      pathOffenders(src, code, TEMPLATE_PATH, exemptions),
      [],
      `TEMPLATE-PATH-SURVIVES SHAPE: '${script}' still constructs a .sterling path by string interpolation`,
    );
    assert.deepEqual(
      pathOffenders(src, code, CONCAT_PATH, exemptions),
      [],
      `CONCAT-PATH-SURVIVES SHAPE: '${script}' still constructs a .sterling path by string concatenation`,
    );
  }
});
// SABOTAGE (per converted writer, one line each):
//   · delete the `import { resolveStoreWritePath } …` line from
//     scripts/no-capture.mjs — the NO-HELPER-IMPORT assertion goes red naming it;
//   · keep the import but restore `const p = join(root, '.sterling',
//     'transient', 'session-events.json');` as the write path — the
//     LEXICAL-PATH-SURVIVES assertion goes red while (1) and (2) stay green,
//     which is exactly the hollow-conversion shape assertion (3) exists for;
//   · replace every call site with the helper still imported — the
//     IMPORTED-BUT-UNUSED assertion goes red.
// NOT A SABOTAGE THIS PIN CATCHES (disclosed, not hidden): moving the lexical
// join into an imported helper module. The grep is file-scoped by design; the
// record's manifest discipline, not this regex, is what covers that.
