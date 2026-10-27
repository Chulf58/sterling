// SterlingStore.retireRemovedFeature — the store half of knowledge_retire(id,
// reason: 'feature_removed') (GitHub #217). The caller's eligibility check runs
// inside the write transaction on the record as read there; a refusal writes
// nothing. The retired record has no supersedes edge and no superseded_by, and
// carries retired_reason 'feature_removed', which the schema accepts only in
// that pairing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRecord } from '@sterling/schemas';
import { SterlingStore } from '../index.js';

const NOW = '2026-10-27T12:00:00.000Z';
const LATER = '2026-10-27T13:00:00.000Z';
type Loose = Record<string, unknown>;

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-store-retire-removed-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function article(slug: string, over: Loose = {}): Loose {
  return {
    id: randomUUID(), type: 'feature_article', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope: 'project', stack_tags: [],
    slug, title: slug, what_it_does: 'x', intended_behavior: 'x', files: [{ path: 'src/gone.ts', role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'deprecated', version: 1,
    history: [{ date: NOW, event: 'seed' }], live_test_refs: [], ...over,
  };
}

test('retireRemovedFeature: runs the check on the stored record, retires with no successor, and keeps the record', () => {
  const { store, cleanup } = harness();
  try {
    const a = store.create(article('old-feature'));
    let seen: Loose | undefined;
    const retired = store.retireRemovedFeature(a.id, LATER, (r) => {
      seen = r as unknown as Loose;
    }) as unknown as Loose;
    assert.equal(seen?.id, a.id);
    assert.equal(seen?.status, 'active', 'the check sees the record before the retirement');
    assert.equal(retired.status, 'superseded');
    assert.equal(retired.superseded_by, null);
    assert.equal(retired.retired_reason, 'feature_removed');
    assert.equal(retired.updated_at, LATER);
    const got = store.get(a.id) as unknown as Loose;
    assert.equal(got.status, 'superseded');
    assert.equal(got.lifecycle, 'retired');
    assert.equal(got.superseded_by, null);
    assert.equal(got.retired_reason, 'feature_removed');
    assert.deepEqual(store.inboundSupersedes(a.id), [], 'no supersedes edge is written');
    assert.deepEqual(store.resolveTerminus(a.id), { id: a.id, status: 'superseded', hops: 0 });
    assert.ok(!store.query({ types: ['feature_article'], cap: 50 }).some((r) => r.id === a.id), 'ordinary queries exclude it');
    assert.equal(store.count({ types: ['feature_article'] }), 0);
  } finally {
    cleanup();
  }
});

test('retireRemovedFeature: a throwing check writes nothing; non-articles and already-retired records are refused', () => {
  const { store, cleanup } = harness();
  try {
    const a = store.create(article('old-feature'));
    assert.throws(
      () => store.retireRemovedFeature(a.id, LATER, () => {
        throw new Error('not eligible: a file is present');
      }),
      /not eligible: a file is present/
    );
    const after = store.get(a.id) as unknown as Loose;
    assert.equal(after.status, 'active');
    assert.equal(after.retired_reason, undefined);
    assert.equal(after.updated_at, NOW);

    const todo = store.create({
      id: randomUUID(), type: 'todo', created_at: NOW, updated_at: NOW, author: 'user', status: 'active', superseded_by: null,
      links: [], scope: 'project', stack_tags: [], text: 'a task', source: 'user',
    });
    assert.throws(() => store.retireRemovedFeature(todo.id, LATER, () => {}), /only a feature_article can be retired as a removed feature/);
    assert.throws(() => store.retireRemovedFeature(randomUUID(), LATER, () => {}), /no record/);

    store.retireRemovedFeature(a.id, LATER, () => {});
    assert.throws(() => store.retireRemovedFeature(a.id, LATER, () => {}), /already superseded/);
  } finally {
    cleanup();
  }
});

test('a removed-feature record survives the retired-record path rewrite (renameFileKey) still retired with its reason', () => {
  const { store, cleanup } = harness();
  try {
    const a = store.create(article('old-feature'));
    store.retireRemovedFeature(a.id, LATER, () => {});
    store.renameFileKey('src/gone.ts', 'src/moved.ts');
    const got = store.get(a.id) as unknown as Loose;
    assert.equal(got.status, 'superseded');
    assert.equal(got.superseded_by, null);
    assert.equal(got.retired_reason, 'feature_removed');
    assert.deepEqual((got.files as { path: string }[]).map((f) => f.path), ['src/moved.ts']);
  } finally {
    cleanup();
  }
});

test('schema: retired_reason pairs only with status superseded and no superseded_by; other types keep the strict pairing', () => {
  const ok = article('x', { status: 'superseded', superseded_by: null, retired_reason: 'feature_removed' });
  assert.doesNotThrow(() => validateRecord(ok));
  assert.throws(() => validateRecord(article('x', { retired_reason: 'feature_removed' })), /retired_reason requires status 'superseded'/);
  assert.throws(
    () => validateRecord(article('x', { status: 'superseded', superseded_by: randomUUID(), retired_reason: 'feature_removed' })),
    /retired_reason forbids superseded_by/
  );
  assert.throws(() => validateRecord(article('x', { status: 'superseded', superseded_by: null })), /status 'superseded' requires superseded_by/);
  assert.throws(() => validateRecord(article('x', { status: 'superseded', superseded_by: null, retired_reason: 'obsolete' })));
  const { store, cleanup } = harness();
  try {
    assert.throws(() => store.create(article('live-with-reason', { retired_reason: 'feature_removed' })), /retired_reason requires status 'superseded'/);
    assert.throws(
      () => store.create(article('born-retired', { status: 'superseded', superseded_by: null, retired_reason: 'feature_removed' })),
      /cannot be requested at creation without a successor/
    );
  } finally {
    cleanup();
  }
});
