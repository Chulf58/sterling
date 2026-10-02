import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, MountedStores } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// ---------------------------------------------------------------------------
// board a00689b9 (RAW-ZOD LEAK INVENTORY): handoffWrite/handoffRead and
// knowledgePromote (packages/mcp-server/src/tools.ts) now catch ZodError
// NARROWLY (instanceof check) and route it through renderValidationFailure
// with the op name ('handoff_write' / 'handoff_read' / 'knowledge_promote'),
// instead of letting a raw ZodError / raw issues array reach the caller.
// Non-Zod errors (e.g. "no run", "never promotes", "unmounted domain") must
// still be rethrown untouched — the catch is narrow, not a blanket reshape.
//
// This file is authored from the dispatch's spec (THE PINS), not from the
// implementation (H4 read wall) — see the per-test comments for the exact
// contract each assertion pins and the one ambiguity resolved along the way.
// ---------------------------------------------------------------------------

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-valshape-'));
  const dbPath = join(dir, 'sterling.db');
  const store = new SterlingStore(dbPath);
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, cleanup };
}

function domainHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-valshape-domain-'));
  const domainDb = join(dir, 'domains', 'node', 'sterling.db');
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'node', dbPath: domainDb }]);
  const config = parseConfig({ stack_tags: ['node'] });
  const tools = new SterlingTools({ store, config, now: () => NOW, newId: randomUUID });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, cleanup };
}

// startRun / validHandoffBody / corruptSoleHandoffWhatChanged (fixtures for
// the deleted PIN 1/2/3/6b handoff tests) were removed with the
// staged-pipeline run/handoff protocol (decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1).

function assertNoRawZodLeak(message: string, label: string) {
  assert.ok(!message.includes('"issues"'), `${label}: no raw zod issues-array key leaks`);
  assert.ok(!message.includes('"code":"invalid_type"'), `${label}: no raw zod issue code leaks verbatim`);
  assert.ok(!/invalid_type|invalid_string|invalid_enum_value/.test(message), `${label}: no raw zod issue-code token leaks`);
  assert.ok(!/^\s*\[\s*\{/.test(message), `${label}: message is not a raw serialized zod issue array`);
  assert.ok(!message.includes('ZodError'), `${label}: no ZodError class name leak`);
}

// PIN 1/2/3 (handoff_write/handoff_read validation shaping + the valid-write
// control) were removed with the staged-pipeline run/handoff protocol
// (decision sterling-claude-code-scale-down-boundary, 2ad87dd1) —
// handoffWrite/handoffRead no longer exist. PIN 4/5/6a (knowledge_promote)
// below are unaffected and stay.

// ---------------------------------------------------------------------------
// PIN 4 — knowledge_promote, an invalid domain string.
//
// AMBIGUITY RESOLVED: the dispatch's own regex names the quoted schema/type
// token as a placeholder (`'<type>'`), and the exact field name the promote
// arg-schema reports for the domain string (a bare 'domain' field on a
// promote-args schema, vs. the general 'scope' field SCOPE_RE also governs
// elsewhere) is not discoverable without reading tools.ts (H4). The op prefix
// and "failed validation" shape are pinned exactly; the quoted schema-name
// token is left as a wildcard, and the offending-field assertion accepts
// either 'domain' or 'scope' so the test pins the CONTRACT (op-prefixed,
// caller-facing, no-raw-zod, discriminator named) without asserting an
// unverifiable literal.
//
// EXPECTED FAILURE SHAPE (red, pre-fix / on the named sabotage): the thrown
// message is a raw ZodError / raw issues array for the SCOPE_RE mismatch, so
// the shaped-message regex fails and/or assertNoRawZodLeak fails.
//
// SABOTAGE: remove the new try/catch in knowledgePromote → this test goes red.
// ---------------------------------------------------------------------------
test('PIN 4: knowledge_promote of an active project-scoped decision with an invalid domain ("My Domain", fails SCOPE_RE) is refused naming the scope/domain field, never a raw ZodError', () => {
  const { store, tools, cleanup } = domainHarness();
  try {
    const { record: dec } = tools.knowledgeCreate('decision', {
      title: 'a promotable decision',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    const decRec = dec as unknown as { id: string; status: string; scope: string };
    assert.equal(decRec.status, 'active', 'precondition: an ACTIVE record');
    assert.equal(decRec.scope, 'project', 'precondition: a PROJECT-scoped record');

    assert.throws(
      () => tools.knowledgePromote(decRec.id, 'My Domain'),
      (err: Error) => {
        assert.match(err.message, /knowledge_promote: '[^']+' failed validation/, `op prefix + failed-validation shape; got: ${err.message}`);
        assert.match(err.message, /domain|scope/i, `names the offending scope/domain field; got: ${err.message}`);
        assertNoRawZodLeak(err.message, 'PIN4');
        return true;
      }
    );
    assert.equal(tools.knowledgeGet(decRec.id).status, 'active', 'a refused promote leaves the original active and untouched');
    assert.equal(store.get(decRec.id)?.status, 'active', 'nothing was written anywhere by the refused promote');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PIN 5 — CONTROL for PIN 4: the same record promoted with a valid, mounted
// domain must be entirely unaffected by the new narrow catch — full receipt
// shape unchanged.
//
// SABOTAGE, RESTATED (review finding, both roster + Codex): "invert the
// instanceof check" cannot flip this test either, for the same reason as
// PIN 3 — a successful promote never throws, so it never reaches the catch.
// This is a PURE REGRESSION CONTROL: it must pass for the SAME reason it
// always did (a change scoped to error handling leaves a successful promote
// untouched). Its job is proving PIN 4's refusal is not bought by narrowing
// or altering the SUCCESS receipt itself — a regression that dropped fields
// off the receipt (see the full-shape assertions below, Codex finding 2)
// would flip THIS test red while PIN 4 stays green.
// ---------------------------------------------------------------------------
test('PIN 5 CONTROL: knowledge_promote of the same record with a valid domain ("node") still promotes with the full receipt shape unchanged', () => {
  const { store, tools, cleanup } = domainHarness();
  try {
    const { record: dec } = tools.knowledgeCreate('decision', {
      title: 'a promotable decision',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    const id = (dec as unknown as { id: string }).id;

    const out = tools.knowledgePromote(id, 'node') as unknown as Record<string, unknown> & { promoted: { id: string; scope: string } };
    assert.equal(out.promoted.scope, 'domain:node', 'promotion succeeded — the new validation catch never interferes with a valid domain');
    assert.equal(store.get(out.promoted.id)?.scope, 'domain:node', 'the promoted copy actually landed in the domain store');
    assert.equal(tools.knowledgeGet(id).status, 'superseded', 'the project original is tombstoned exactly as an unwrapped promote would leave it');
    assert.equal(tools.knowledgeGet(id).superseded_by, out.promoted.id, 'the tombstone points forward at the promoted copy');

    // FULL RECEIPT SHAPE (Codex finding 2): asserting promoted.scope alone
    // passes a regression that returns only {promoted} — every other receipt
    // key must still be PRESENT, each with its verified type. Types below are
    // pinned exactly against the coordinator-verified return declaration
    // (tools.ts:3765-3773): { promoted: DurableRecord; retired: string;
    // drained_review: string | null; dropped_file_keys: number;
    // dropped_stack_tags: string[]; kept_stack_tags: string[]; warnings:
    // string[] } — an initial 'retired'/'drained_review' boolean guess was
    // wrong (retired is a string) and is corrected here, not left silent.
    for (const key of ['retired', 'drained_review', 'dropped_file_keys', 'dropped_stack_tags', 'kept_stack_tags', 'warnings']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(out, key),
        `the receipt must carry '${key}' — a regression returning only {promoted} must not pass this control`
      );
    }
    assert.equal(typeof out.retired, 'string', "'retired' is a string (verified return declaration, tools.ts:3765-3773)");
    assert.ok(
      out.drained_review === null || typeof out.drained_review === 'string',
      "'drained_review' is a string or null (verified return declaration, tools.ts:3765-3773)"
    );
    assert.equal(typeof out.dropped_file_keys, 'number', "'dropped_file_keys' is a count (established by the existing promote-sanitisation tests)");
    assert.ok(Array.isArray(out.dropped_stack_tags), "'dropped_stack_tags' is an array (established by the existing promote-sanitisation tests)");
    assert.ok(Array.isArray(out.kept_stack_tags), "'kept_stack_tags' is an array, paired with dropped_stack_tags");
    assert.ok(Array.isArray(out.warnings), "'warnings' is an array (established by every other write-tool receipt in this suite)");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PIN 6 — NARROWNESS ITSELF (roster finding, MEDIUM): PINs 1/2/4 only prove a
// ZodError gets reshaped; they cannot distinguish a narrow `instanceof
// ZodError` catch from a BLANKET `catch (err) { throw renderValidationFailure(err,
// ...) }` that reshapes every error indiscriminately — all three prior pins
// stay green either way. This test forces exactly that distinction on the two
// remaining non-Zod error paths the boundary must still pass through VERBATIM.
//
// Arm (a): knowledge_promote to a domain string that PASSES SCOPE_RE format
// but is NOT mounted — the fixture (domainHarness) mounts only 'node', so
// 'python' is valid-shaped and unmounted. This must surface the store's
// pre-existing unmounted-domain routing error untouched.
// Arm (b): handoff_write called with no active run — this harness never
// calls startRun, so the pre-existing conductor-direct guidance error (pinned
// elsewhere in tools.test.ts, e.g. /no run is active/) must surface untouched.
//
// EXPECTED FAILURE SHAPE (red, pre-fix / on the named sabotage): under a
// blanket catch, BOTH arms' thrown messages get run through
// renderValidationFailure and start matching /failed validation/ — the
// doesNotMatch assertions below fail.
//
// SABOTAGE: replace the narrow `instanceof ZodError` check at ANY of the
// three call sites (handoffWrite, handoffRead, knowledgePromote) with a
// blanket catch that reshapes every error → this test goes red on the
// corresponding arm.
// ---------------------------------------------------------------------------
test('PIN 6a: knowledge_promote to a valid-format but UNMOUNTED domain surfaces the store\'s routing error verbatim — never shaped as a validation failure', () => {
  const { tools, cleanup } = domainHarness();
  try {
    const { record: dec } = tools.knowledgeCreate('decision', {
      title: 'a promotable decision',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    const id = (dec as unknown as { id: string }).id;

    // precondition: 'python' is not among the fixture's mounted domains.
    assert.throws(
      () => tools.knowledgePromote(id, 'python'),
      (err: Error) => {
        assert.doesNotMatch(err.message, /failed validation/, `an unmounted-domain routing error must never carry the shaped validation-failure wording; got: ${err.message}`);
        assert.doesNotMatch(err.message, /^knowledge_promote: '/, `must not carry the shaped op-prefix either; got: ${err.message}`);
        assert.match(err.message, /unmounted domain/i, `the pre-existing routing refusal must surface untouched; got: ${err.message}`);
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

// PIN 6b (handoff_write with no active run) was removed with the
// staged-pipeline run/handoff protocol (decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1).
