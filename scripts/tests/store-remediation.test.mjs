// Adversarial regression pins for board item 1b3c7bf3 (config-space remediation-
// script merge — decision bc0f81e3 supersession). SPEC-ONLY: scripts/lib/init.mjs
// and scripts/lib/update.mjs were NOT read to author these; only the SPEC handed
// to the test-writer and this module's own declared export names (already
// established by scripts/tests/update.test.mjs's stampConsumerRoleIfAbsent
// sibling shape) were used.
//
// scripts/lib/store-remediation.mjs (dependency-free, node builtins only) exports:
//   - REMEDIATION_SCRIPTS: a frozen array === ['scripts/migration-preflight.mjs',
//     'scripts/migrate-stores.mjs'] (exact contents, exact order).
//   - appendMissingRemediation(allowScripts): pure fn returning { next, added }.
//     next = input + any REMEDIATION_SCRIPTS not already present, APPENDED after
//     all existing entries, in REMEDIATION_SCRIPTS order. added = the scripts
//     actually appended. NEVER dedupes/removes/reorders existing entries
//     (including pre-existing duplicates). Idempotent on an array already
//     containing both (added empty, next element-equal to input).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMEDIATION_SCRIPTS, appendMissingRemediation } from '../lib/store-remediation.mjs';

void dirname; void join; void fileURLToPath; // (no fs/spawn needed — pure module)

// ── REMEDIATION_SCRIPTS ──────────────────────────────────────────────────────

test('REMEDIATION_SCRIPTS: exact contents, exact order, frozen', () => {
  assert.deepEqual(
    [...REMEDIATION_SCRIPTS],
    ['scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs'],
    'exact contents in exact order — migration-preflight before migrate-stores'
  );
  assert.ok(Object.isFrozen(REMEDIATION_SCRIPTS), 'REMEDIATION_SCRIPTS is frozen');
  // module code runs in strict mode (ESM) — mutating a frozen array throws,
  // it does not silently no-op.
  assert.throws(() => REMEDIATION_SCRIPTS.push('scripts/extra.mjs'), TypeError);
});
// SABOTAGE (order): swap the two entries in the source array literal — the
// deepEqual assertion goes red.
// SABOTAGE (frozen): delete the Object.freeze(...) call — isFrozen goes red
// AND the .push() throws-assertion goes red (push silently succeeds instead).

// ── appendMissingRemediation: both missing ──────────────────────────────────

test('appendMissingRemediation: both missing — appends both, in REMEDIATION_SCRIPTS order, after existing entries', () => {
  const input = ['scripts/some-other-script.mjs'];
  const { next, added } = appendMissingRemediation(input);
  assert.deepEqual(next, ['scripts/some-other-script.mjs', 'scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs']);
  assert.deepEqual(added, ['scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs']);
  assert.deepEqual(input, ['scripts/some-other-script.mjs'], 'input array is not mutated (pure function)');
});
// SABOTAGE: prepend the missing scripts instead of appending (or emit them in
// reversed order) — the `next` deepEqual on ordering/position goes red.
// SABOTAGE (purity): have the function `input.push(...)` the missing scripts
// directly onto the caller's array instead of building a new array — the
// final `assert.deepEqual(input, ['scripts/some-other-script.mjs'])` goes red.

test('appendMissingRemediation: empty input — next becomes exactly REMEDIATION_SCRIPTS, added is the same', () => {
  const { next, added } = appendMissingRemediation([]);
  assert.deepEqual(next, ['scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs']);
  assert.deepEqual(added, ['scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs']);
});
// SABOTAGE: return REMEDIATION_SCRIPTS itself (the frozen singleton) as `next`
// instead of a fresh array — a later mutation test elsewhere would then throw
// on a frozen array; more directly, swapping the two entries' order here also
// goes red on the deepEqual.

// ── appendMissingRemediation: one missing — existing entries/order preserved ─

test('appendMissingRemediation: one missing (migrate-stores present) — only the missing one is appended; the present one is NOT moved to canonical position', () => {
  const input = ['scripts/a.mjs', 'scripts/migrate-stores.mjs', 'scripts/b.mjs'];
  const { next, added } = appendMissingRemediation(input);
  assert.deepEqual(next, ['scripts/a.mjs', 'scripts/migrate-stores.mjs', 'scripts/b.mjs', 'scripts/migration-preflight.mjs']);
  assert.deepEqual(added, ['scripts/migration-preflight.mjs']);
});
// SABOTAGE: reorder existing entries into REMEDIATION_SCRIPTS canonical order
// (moving 'scripts/migrate-stores.mjs' after the newly-appended
// 'scripts/migration-preflight.mjs') — the `next` deepEqual goes red because
// the existing entries' positions shifted.

test('appendMissingRemediation: one missing (migration-preflight present) — order/position of existing entries preserved', () => {
  const input = ['scripts/migration-preflight.mjs', 'scripts/a.mjs'];
  const { next, added } = appendMissingRemediation(input);
  assert.deepEqual(next, ['scripts/migration-preflight.mjs', 'scripts/a.mjs', 'scripts/migrate-stores.mjs']);
  assert.deepEqual(added, ['scripts/migrate-stores.mjs']);
});
// SABOTAGE: append missing scripts BEFORE existing entries instead of after —
// the `next` deepEqual goes red (position of 'scripts/a.mjs' would shift).

// ── appendMissingRemediation: idempotency + duplicate preservation ──────────

test('appendMissingRemediation: both already present (non-canonical order, with an unrelated entry between) — idempotent no-op', () => {
  const input = ['scripts/migrate-stores.mjs', 'scripts/some-admin-script.mjs', 'scripts/migration-preflight.mjs'];
  const { next, added } = appendMissingRemediation(input);
  assert.deepEqual(added, [], 'nothing appended — both already present, regardless of their order');
  assert.deepEqual(next, input, 'next is element-equal to input — no reordering, no rewrite');
});
// SABOTAGE: check presence by requiring the two scripts to appear in
// REMEDIATION_SCRIPTS canonical ORDER (a strict subsequence check) rather than
// simple presence — this non-canonical-order fixture would then be treated as
// "still missing something" and `added` would come back non-empty, going red.

test('appendMissingRemediation: pre-existing duplicates are preserved as-is, never deduped, even while adding the genuinely missing one', () => {
  const input = ['scripts/migrate-stores.mjs', 'scripts/migrate-stores.mjs'];
  const { next, added } = appendMissingRemediation(input);
  assert.deepEqual(next, ['scripts/migrate-stores.mjs', 'scripts/migrate-stores.mjs', 'scripts/migration-preflight.mjs'], 'the duplicate migrate-stores.mjs entries are BOTH preserved untouched; only the missing migration-preflight.mjs is appended');
  assert.deepEqual(added, ['scripts/migration-preflight.mjs']);
});
// SABOTAGE: dedupe the input before appending (e.g. `next = [...new
// Set(input), ...missing]`) — the first assertion goes red because only one
// 'scripts/migrate-stores.mjs' survives instead of two.

// ── appendMissingRemediation: throws on non-array input (round 2, board 1b3c7bf3) ──
//
// SPEC-ONLY: the silent `Array.isArray(x) ? x : []` coercion is replaced with a
// loud throw naming the received type — a caller passing a malformed
// allow_scripts (e.g. a string from a wrong-shaped config) must fail loud at
// this seam rather than have it silently treated as an empty array.

test('appendMissingRemediation: throws on a non-array string input, the message naming the received type', () => {
  assert.throws(
    () => appendMissingRemediation('bad'),
    (err) => err instanceof Error && /string/i.test(err.message),
    'throws an Error whose message names the received type (string)'
  );
});
// SABOTAGE: restore the silent `Array.isArray(x) ? x : []` coercion — this
// assertion goes red because appendMissingRemediation('bad') returns
// { next: [...REMEDIATION_SCRIPTS], added: [...REMEDIATION_SCRIPTS] } instead
// of throwing.

test('appendMissingRemediation: throws on a non-array plain-object input, the message naming the received type', () => {
  assert.throws(
    () => appendMissingRemediation({}),
    (err) => err instanceof Error && /object/i.test(err.message),
    'throws an Error whose message names the received type (object)'
  );
});
// SABOTAGE: restore the silent `Array.isArray(x) ? x : []` coercion —
// appendMissingRemediation({}) returns a coerced-to-empty-array result instead
// of throwing, and this assertion goes red.

test('appendMissingRemediation: a genuine array input is entirely unaffected by the new throw guard', () => {
  const { next, added } = appendMissingRemediation(['scripts/x.mjs']);
  assert.deepEqual(next, ['scripts/x.mjs', 'scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs']);
  assert.deepEqual(added, ['scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs']);
});
// SABOTAGE: make the new Array.isArray guard also reject genuine arrays (e.g.
// an inverted condition `if (Array.isArray(x)) throw ...`) — this call throws
// instead of returning, and the test errors out / fails.

test('appendMissingRemediation: fully idempotent across two calls once both are present', () => {
  const first = appendMissingRemediation(['scripts/x.mjs']);
  assert.deepEqual(first.added, ['scripts/migration-preflight.mjs', 'scripts/migrate-stores.mjs']);
  const second = appendMissingRemediation(first.next);
  assert.deepEqual(second.added, [], 'a second call on an already-remediated array adds nothing');
  assert.deepEqual(second.next, first.next, 'a second call is a true no-op — element-equal to its input');
});
// SABOTAGE: have the function always re-append REMEDIATION_SCRIPTS
// unconditionally (ignore presence entirely) — `second.added` would come back
// non-empty and `second.next` would carry duplicate remediation entries,
// going red on both assertions.
