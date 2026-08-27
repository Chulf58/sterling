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
  const input = [
    'scripts/a.mjs',
    'scripts/migrate-stores.mjs',
    'packages/tui/bundle/sterling-tui.mjs',
    'scripts/init.mjs',
    'scripts/b.mjs',
    'scripts/dispose-run.mjs',
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
  assert.deepEqual(added, [
    'scripts/dispose-run.mjs',
    'scripts/init.mjs',
    'scripts/consume-exit.mjs',
    'scripts/architecture-projection.mjs',
    'scripts/domain-doctor.mjs',
    'scripts/commit-reviewed.mjs',
    'packages/tui/bundle/sterling-tui.mjs',
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
  const input = [
    'scripts/migrate-stores.mjs',
    'scripts/some-admin-script.mjs',
    'packages/tui/bundle/sterling-tui.mjs',
    'scripts/migration-preflight.mjs',
    'scripts/commit-reviewed.mjs',
    'scripts/domain-doctor.mjs',
    'scripts/architecture-projection.mjs',
    'scripts/consume-exit.mjs',
    'scripts/init.mjs',
    'scripts/dispose-run.mjs',
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
