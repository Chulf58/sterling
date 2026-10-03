// Decision a-supersedes-link-on-create-or-update-is-refused-use-knowledge-supersede
// (board ec9789f0): create and the in-place update path refuse a links entry
// with rel 'supersedes', write nothing, and point to knowledge_supersede (which
// retires the old record) or rel 'cites' (a deliberate partial override).
// supersede() keeps writing its own edge, and edges that already exist stay as
// they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, MountedStores } from '../index.js';
import { seedLegacySupersedesEdge } from './legacy-supersedes-edge.js';

const NOW = '2026-10-03T12:00:00.000Z';

function decision(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type: 'decision',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
    title: 'a decision',
    statement: 'the statement',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no joins' }],
    rationale: 'r',
    ...over,
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-raw-supersedes-'));
  return { dir, store: new SterlingStore(join(dir, 'sterling.db')) };
}

function relations(store: SterlingStore, sourceId: string, rel: string, targetId: string): unknown[] {
  const s = store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } };
  return s.db.prepare('SELECT * FROM record_relations WHERE source_id = ? AND rel = ? AND target_id = ?').all(sourceId, rel, targetId);
}

const REFUSAL = /rel 'supersedes'[\s\S]*knowledge_supersede[\s\S]*'cites'[\s\S]*Nothing was written/;

test('create refuses a supersedes link, writes no row and no edge, and leaves the target active', () => {
  const { dir, store } = tempStore();
  try {
    const target = store.create(decision({ statement: 'old' }));
    const candidate = decision({ statement: 'new', links: [{ rel: 'supersedes', target_id: target.id }] });
    assert.throws(() => store.create(candidate), REFUSAL);
    assert.equal(store.get(candidate.id), undefined, 'no record row was written');
    assert.equal(relations(store, candidate.id, 'supersedes', target.id).length, 0, 'no relation row was written');
    assert.equal(store.get(target.id)?.status, 'active', 'the target is untouched');
    assert.equal(store.listActivityLog(50).filter((e) => e.id === candidate.id).length, 0, 'no activity row');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MountedStores.create (the knowledge_create route) refuses a supersedes link the same way', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-raw-supersedes-mounted-'));
  const store = new MountedStores(join(dir, 'sterling.db'), []);
  try {
    const target = store.create(decision({ statement: 'old' }));
    const candidate = decision({ statement: 'new', links: [{ rel: 'supersedes', target_id: target.id }] });
    assert.throws(() => store.create(candidate), REFUSAL);
    assert.equal(store.get(candidate.id), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateRecord adding a supersedes link is refused: no version bump, no edge, target active', () => {
  const { dir, store } = tempStore();
  try {
    const target = store.create(decision({ statement: 'old' }));
    const rec = store.create(decision({ statement: 'new' }));
    assert.throws(
      () => store.updateRecord(rec.id, { ...rec, links: [{ rel: 'supersedes', target_id: target.id }] }),
      REFUSAL
    );
    const after = store.get(rec.id) as unknown as { version: number; links: unknown[] };
    assert.equal(after.version, 1, 'no version was written');
    assert.deepEqual(after.links, []);
    assert.equal(relations(store, rec.id, 'supersedes', target.id).length, 0);
    assert.equal(store.get(target.id)?.status, 'active');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendRecordField onto links with a supersedes entry is refused (same in-place boundary)', () => {
  const { dir, store } = tempStore();
  try {
    const target = store.create(decision({ statement: 'old' }));
    const rec = store.create(decision({ statement: 'new' }));
    assert.throws(() => store.appendRecordField(rec.id, 'links', { rel: 'supersedes', target_id: target.id }), REFUSAL);
    assert.equal(relations(store, rec.id, 'supersedes', target.id).length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('supersede() still writes its edge and retires the old record; the successor stays updatable with that edge', () => {
  const { dir, store } = tempStore();
  try {
    const old = store.create(decision({ statement: 'old' }));
    const next = store.supersede(old.id, decision({ statement: 'new' }));
    assert.equal(relations(store, next.id, 'supersedes', old.id).length, 1, 'supersede wrote the edge');
    assert.equal(store.get(old.id)?.status, 'superseded');
    assert.equal(store.get(old.id)?.superseded_by, next.id);
    // The successor's served links carry the existing edge; an in-place update
    // that keeps it is not "adding" one and must go through.
    const current = store.get(next.id)!;
    const updated = store.updateRecord(next.id, { ...current, rationale: 'edited' }) as unknown as { version: number };
    assert.equal(updated.version, 2);
    assert.equal(relations(store, next.id, 'supersedes', old.id).length, 1, 'the existing edge is untouched');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cites link still works on create and on update', () => {
  const { dir, store } = tempStore();
  try {
    const target = store.create(decision({ statement: 'old' }));
    const a = store.create(decision({ statement: 'partial override', links: [{ rel: 'cites', target_id: target.id }] }));
    assert.equal(relations(store, a.id, 'cites', target.id).length, 1);
    const b = store.create(decision({ statement: 'another' }));
    store.updateRecord(b.id, { ...b, links: [{ rel: 'cites', target_id: target.id }] });
    assert.equal(relations(store, b.id, 'cites', target.id).length, 1);
    assert.equal(store.get(target.id)?.status, 'active');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing raw supersedes edge (seeded through the legacy fixture path) is left as it is and survives an update', () => {
  const { dir, store } = tempStore();
  try {
    const target = store.create(decision({ statement: 'old' }));
    const holder = store.create(decision({ statement: 'new' }));
    seedLegacySupersedesEdge(store, holder.id, target.id);
    assert.equal(relations(store, holder.id, 'supersedes', target.id).length, 1);
    assert.equal(store.get(target.id)?.status, 'active', 'the legacy shape leaves the target active');
    const current = store.get(holder.id)!;
    store.updateRecord(holder.id, { ...current, rationale: 'edited' });
    assert.equal(relations(store, holder.id, 'supersedes', target.id).length, 1, 'the edge survives an update that keeps it');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
