// ------------------- board `blocked_by` field, SCHEMA half -------------------
// decision every-user-ask-is-boarded-at-intake-with-slim-blocked-by, rule 6.
//
// todoSchema gains an OPTIONAL `blocked_by`: a list of board slugs. The schema
// owns the shape and the two rules it can judge alone: a system (maintenance)
// item never carries it, and an item never lists its own slug. Whether each
// entry names an existing open board item is the TOOL layer's check (it needs
// the store), pinned in packages/mcp-server board-blocked-by.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { todoSchema } from '../index.js';

const NOW = '2026-10-01T12:00:00.000Z';

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
  return { ...envelope('todo'), text: 'wire the consumer', source: 'user', slug: 'wire-the-consumer', ...extra };
}

function systemTodo(extra: Record<string, unknown> = {}) {
  return { ...envelope('todo'), text: 'reconcile an article', source: 'system', system_reason: 'reconcile_needed', ...extra };
}

type WithBlockedBy = { blocked_by?: string[] };

test('todo.blocked_by: OPTIONAL — an item without it round-trips with no invented field', () => {
  const bare = todoSchema.parse(userTodo()) as WithBlockedBy;
  assert.equal('blocked_by' in bare, false);
});

test('todo.blocked_by: a user item ACCEPTS a list of board slugs and stores them verbatim', () => {
  const parsed = todoSchema.parse(userTodo({ blocked_by: ['define-the-schema', 'land-the-store'] })) as WithBlockedBy;
  assert.deepEqual(parsed.blocked_by, ['define-the-schema', 'land-the-store']);
});

test('todo.blocked_by: an empty-string entry or a non-string entry is refused', () => {
  assert.equal(todoSchema.safeParse(userTodo({ blocked_by: [''] })).success, false);
  assert.equal(todoSchema.safeParse(userTodo({ blocked_by: [42] })).success, false);
  assert.equal(todoSchema.safeParse(userTodo({ blocked_by: 'define-the-schema' })).success, false);
});

test('todo.blocked_by: REFUSED on a source:system item, loudly naming the field', () => {
  const res = todoSchema.safeParse(systemTodo({ blocked_by: ['define-the-schema'] }));
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error?.issues), /blocked_by/);
});

test('todo.blocked_by: an item listing its OWN slug is refused (an item cannot block itself)', () => {
  const res = todoSchema.safeParse(userTodo({ blocked_by: ['wire-the-consumer'] }));
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error?.issues), /itself/);
});
