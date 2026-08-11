// ------------------- board `objective` grouping field, SCHEMA half -------------------
// decision a8d2ce6c-ccb5-4176-8130-a23d619b6d5a, slice 1.
//
// todoSchema gains an OPTIONAL `objective`: a non-empty string. THE LAYERING IS THE
// POINT — the schema stores whatever non-empty string it is given; the literal
// "standalone" is normalized to ABSENT at the TOOL layer (board_add / board_update),
// never here. Absent stays absent; an empty string is rejected loud.
//
// Written RED-FIRST: `objective` does not exist on todoSchema yet, so every parsed
// result is cast through `unknown` (the cast-through-unknown pattern used for
// not-yet-built fields in config.test.ts / schemas.test.ts) — the assertions below
// fail cleanly on an AssertionError, never on a package build error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { todoSchema, RECORD_TYPES, digestRecord } from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';

// envelope is duplicated from schemas.test.ts deliberately: importing it from that
// module would re-execute every test it declares.
function envelope(type: string) {
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
    stack_tags: ['node'],
  };
}

function userTodo(extra: Record<string, unknown> = {}) {
  return { ...envelope('todo'), text: 'ship the animation pass', source: 'user', ...extra };
}

type TodoWithObjective = { objective?: string; text?: string; priority?: string; source?: string };

test('todo.objective: OPTIONAL — an ungrouped item round-trips with no invented field (decision a8d2ce6c slice 1)', () => {
  const bare = todoSchema.parse(userTodo()) as unknown as TodoWithObjective;
  assert.ok(
    !('objective' in bare) || bare.objective === undefined,
    'a todo without objective round-trips unchanged — absent stays absent, the field is never invented'
  );
  // a legacy SYSTEM item is likewise untouched by the new field
  const queued = todoSchema.parse({
    ...envelope('todo'),
    text: 'reconcile auth article',
    source: 'system',
    system_reason: 'reconcile_needed',
  }) as unknown as TodoWithObjective;
  assert.ok(
    !('objective' in queued) || queued.objective === undefined,
    'a maintenance item carries no objective — lanes group the queue, objectives group the board'
  );
});

test('todo.objective: a supplied non-empty string survives parsing verbatim, siblings untouched (decision a8d2ce6c slice 1)', () => {
  // front-load the presence assertion so a STRIPPED field yields an AssertionError,
  // never a TypeError further down
  const grouped = todoSchema.parse(userTodo({ objective: 'Animation pass', priority: 'high' })) as unknown as TodoWithObjective;
  assert.equal(grouped.objective, 'Animation pass', 'objective survives parsing verbatim — never stripped, never normalized at this layer');
  assert.equal(grouped.text, 'ship the animation pass', 'the sibling text field is untouched by the new field');
  assert.equal(grouped.priority, 'high', 'the sibling priority field is untouched by the new field');
});

test('todo.objective: an EMPTY string is rejected loud; a non-string is rejected loud (decision a8d2ce6c slice 1)', () => {
  // a blank grouping key is indistinguishable from ungrouped, so it must never be
  // storable — z.string().min(1), fail loud (P5)
  assert.throws(() => todoSchema.parse(userTodo({ objective: '' })), 'an empty objective is rejected — a blank grouping key is not a group');
  assert.throws(() => todoSchema.parse(userTodo({ objective: 42 })), 'objective is a string field — a number is rejected');
  assert.throws(() => todoSchema.parse(userTodo({ objective: ['Animation pass'] })), 'objective is a single string — an array is rejected');
  assert.throws(() => todoSchema.parse(userTodo({ objective: null })), 'objective is absent-or-string — an explicit null is rejected, never coerced to absent');
});

test('todo.objective: the schema stores "standalone" VERBATIM — normalization is the tool layer\'s job (decision a8d2ce6c slice 1)', () => {
  // The decision pins this split explicitly: board_add/board_update collapse the exact
  // literal "standalone" to ABSENT; the schema is not where that happens, so a record
  // handed "standalone" directly (a store-level write, a migration, a test fixture)
  // keeps it as an ordinary non-empty string.
  const parsed = todoSchema.parse(userTodo({ objective: 'standalone' })) as unknown as TodoWithObjective;
  assert.equal(parsed.objective, 'standalone', 'the schema does not normalize "standalone" — only the tool layer does');
});

test("todo.objective is a DIGEST headline field — a grouped item's digest line carries its objective (decision a8d2ce6c slice 1)", () => {
  assert.ok(
    'objective' in RECORD_TYPES.todo.digest,
    "RECORD_TYPES.todo.digest must name 'objective' so a digest board read shows the grouping without a full-body read"
  );
  const grouped = digestRecord({
    ...envelope('todo'),
    text: 'ship the animation pass',
    source: 'user',
    priority: 'high',
    objective: 'Animation pass',
  });
  assert.equal(grouped.objective, 'Animation pass', 'the objective survives into the digest projection whole (a grouping key is a headline, never clipped away)');
  const ungrouped = digestRecord({ ...envelope('todo'), text: 'a one-off chore', source: 'user' });
  assert.ok(!('objective' in ungrouped), 'an ungrouped item costs nothing — no null placeholder in the digest');
});
