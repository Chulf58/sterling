// operation_id (decision postgres-operation-id-minted-by-caller-refused-on-repeat-no-schema-bump):
// a create, enqueue or supersede carries a caller-minted operation_id; a repeat
// is refused naming the original record id and writes nothing. Backend-neutral:
// under STERLING_TEST_PG=1 the same tests run on Postgres through pg-test-setup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountedStores, OperationRepeatedError, SterlingStore } from '../index.js';

const NOW = '2026-10-06T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-opid-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function envelope(type: string) {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: ['node'] };
}

function decision(over: Record<string, unknown> = {}) {
  return {
    ...envelope('decision'),
    title: 'Use operation ids',
    statement: 'A repeated create is refused.',
    alternatives_rejected: [{ option: 'retry', reason: 'duplicates' }],
    rationale: 'Uncertain commits.',
    ...over,
  };
}

function systemTodo(over: Record<string, unknown> = {}) {
  return { ...envelope('todo'), author: 'system', stack_tags: [], text: 're-verify finding', source: 'system', system_reason: 'stale_research', feature_link: randomUUID(), ...over };
}

function isRepeat(op: string, originalId: string) {
  return (e: unknown) => e instanceof OperationRepeatedError && e.operation_id === op && e.original_id === originalId && e.message.includes(originalId);
}

test('a repeated operation_id on create is refused naming the original record, and nothing is written', () => {
  const { store, cleanup } = harness();
  try {
    const op = randomUUID();
    const first = store.create(decision(), { operation_id: op });
    const second = decision();
    assert.throws(() => store.create(second, { operation_id: op }), isRepeat(op, first.id));
    assert.equal(store.get(second.id), undefined, 'the repeat wrote nothing');
    assert.equal(store.query({ types: ['decision'] }).length, 1);
  } finally {
    cleanup();
  }
});

test('creates with distinct operation_ids, or none, all land', () => {
  const { store, cleanup } = harness();
  try {
    store.create(decision(), { operation_id: randomUUID() });
    store.create(decision(), { operation_id: randomUUID() });
    store.create(decision());
    store.create(decision());
    assert.equal(store.query({ types: ['decision'] }).length, 4);
  } finally {
    cleanup();
  }
});

test('a repeated operation_id on enqueue is refused before content dedup, naming the original item', () => {
  const { store, cleanup } = harness();
  try {
    const op = randomUUID();
    const item = systemTodo();
    const first = store.enqueueSystemTodo(item, { operation_id: op });
    assert.equal(first.deduped, false);
    assert.throws(() => store.enqueueSystemTodo({ ...item, id: randomUUID() }, { operation_id: op }), isRepeat(op, first.record.id));
    // A NEW operation that matches the open item is still content-deduped, not refused.
    const again = store.enqueueSystemTodo({ ...item, id: randomUUID() }, { operation_id: randomUUID() });
    assert.equal(again.deduped, true);
  } finally {
    cleanup();
  }
});

test('a repeated operation_id on supersede is refused and the old record stays live', () => {
  const { store, cleanup } = harness();
  try {
    const op = randomUUID();
    const a = store.create(decision());
    const b = store.create(decision());
    const replacement = store.supersede(a.id, decision(), undefined, { operation_id: op });
    assert.throws(() => store.supersede(b.id, decision(), undefined, { operation_id: op }), isRepeat(op, replacement.id));
    assert.equal(store.get(b.id)?.status, 'active', 'the refused supersede retired nothing');
  } finally {
    cleanup();
  }
});

test('an operation_id must be a non-empty string of at most 200 characters', () => {
  const { store, cleanup } = harness();
  try {
    assert.throws(() => store.create(decision(), { operation_id: '' }), /operation_id/);
    assert.throws(() => store.create(decision(), { operation_id: 'x'.repeat(201) }), /operation_id/);
  } finally {
    cleanup();
  }
});

test('MountedStores passes operation_id through to the store that takes the write', () => {
  const { dir, store, cleanup } = harness();
  store.close();
  const mounted = new MountedStores(join(dir, 'sterling.db'), []);
  try {
    const op = randomUUID();
    const first = mounted.create(decision(), { operation_id: op });
    assert.throws(() => mounted.create(decision(), { operation_id: op }), isRepeat(op, first.id));
    const todoOp = randomUUID();
    const queued = mounted.enqueueSystemTodo(systemTodo(), { operation_id: todoOp });
    assert.throws(() => mounted.enqueueSystemTodo(systemTodo(), { operation_id: todoOp }), isRepeat(todoOp, queued.record.id));
  } finally {
    mounted.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
