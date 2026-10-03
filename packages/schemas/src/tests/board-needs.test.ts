// ------------------- board `needs` field, SCHEMA half -------------------
// decision board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start.
//
// todoSchema gains an OPTIONAL `needs`: user, grill or investigation. It says
// what a user board item waits on besides its blockers; `status` keeps meaning
// supersession only. A maintenance (system) item never carries it, mirroring
// blocked_by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { todoSchema, BOARD_NEEDS } from '../index.js';

const NOW = '2026-10-03T12:00:00.000Z';

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

const userTodo = (extra: Record<string, unknown> = {}) => ({ ...envelope('todo'), text: 'grill the plan', source: 'user', ...extra });
const systemTodo = (extra: Record<string, unknown> = {}) => ({
  ...envelope('todo'),
  text: 'reconcile an article',
  source: 'system',
  system_reason: 'reconcile_needed',
  ...extra,
});

test('BOARD_NEEDS is exactly user, grill, investigation', () => {
  assert.deepEqual([...BOARD_NEEDS], ['user', 'grill', 'investigation']);
});

test('todo.needs: OPTIONAL — an item without it round-trips with no invented field', () => {
  const bare = todoSchema.parse(userTodo()) as { needs?: string };
  assert.equal('needs' in bare, false);
});

test('todo.needs: a user item accepts each enum value', () => {
  for (const needs of BOARD_NEEDS) {
    assert.equal((todoSchema.parse(userTodo({ needs })) as { needs?: string }).needs, needs);
  }
});

test('todo.needs: a value outside the enum is refused', () => {
  assert.throws(() => todoSchema.parse(userTodo({ needs: 'review' })), /needs/);
});

test('todo.needs: a system item carrying it is refused, naming the field', () => {
  const r = todoSchema.safeParse(systemTodo({ needs: 'investigation' }));
  assert.equal(r.success, false);
  const issue = r.success ? undefined : r.error.issues.find((i) => i.path[0] === 'needs');
  assert.ok(issue, 'the refusal names needs');
  assert.match(issue!.message, /source:'user' board tasks only/);
});
