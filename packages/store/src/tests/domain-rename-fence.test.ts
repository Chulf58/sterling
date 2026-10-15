import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStoreFence, STORE_FENCE_KEY } from '@sterling/schemas';
import { DomainRenamedError, MountedStores, SterlingStore, StoreMovedError, createDomain } from '../index.js';
import { MoveRenamedStoreError, readSqliteFence } from '../store-move.js';
import { sqliteOnly } from './pg-test-support.js';

// The rename fence (decision domain-rename-is-a-fenced-copy-verb-on-domain-doctor):
// one member of the store_meta 'move_fence' union. A write to a rename-fenced
// store is refused naming the new domain, a session mounting it is refused at
// mount naming the new domain, and the store-move code refuses it outright.

const NOW = '2026-10-15T12:00:00.000Z';

const ref = (scope: string) => ({
  id: randomUUID(), type: 'reference_material', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null,
  links: [], scope, stack_tags: [], title: 't', kind: 'doc', location: 'docs/x.md', summary: 's', source_date: '2026-06-16', capture_date: '2026-06-16', basis: 'platform',
});

const renameFence = (toPath: string) => ({
  kind: 'rename', operation_id: randomUUID(), from_domain: 'chulf', to_domain: 'customerhub', to_path: toPath, fenced_at: NOW,
});

function domainStore(dir: string, name: string): string {
  const path = join(dir, 'domains', name, 'sterling.db');
  mkdirSync(join(dir, 'domains', name), { recursive: true });
  createDomain(name, `${name} knowledge`, path);
  return path;
}

test('parseStoreFence: a fence with no kind is a move fence; kind rename is the rename member; anything else throws', () => {
  const move = parseStoreFence(JSON.stringify({ move_id: 'm1', to: 'postgres:x', fenced_at: NOW, manifest_digest: null }));
  assert.equal(move.kind, 'move');
  assert.equal(move.kind === 'move' && move.move_id, 'm1');
  const rename = parseStoreFence(JSON.stringify(renameFence('/x/customerhub/sterling.db')));
  assert.equal(rename.kind, 'rename');
  assert.equal(rename.kind === 'rename' && rename.to_domain, 'customerhub');
  assert.throws(() => parseStoreFence(JSON.stringify({ kind: 'merge', move_id: 'm', to: 't' })), /unknown fence kind/);
  assert.throws(() => parseStoreFence(JSON.stringify({ kind: 'rename', from_domain: 'chulf' })), /malformed rename fence/);
  assert.throws(() => parseStoreFence('{not json'), /not JSON/);
});

test('a write to a rename-fenced store is refused with StoreMovedError naming the new domain', { skip: sqliteOnly('SQLite fence row') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rename-fence-'));
  const path = domainStore(dir, 'chulf');
  const store = new SterlingStore(path);
  try {
    store.create(ref('domain:chulf'));
    store.setMeta(STORE_FENCE_KEY, JSON.stringify(renameFence(join(dir, 'domains', 'customerhub', 'sterling.db'))));
    assert.throws(
      () => store.create(ref('domain:chulf')),
      (e: unknown) => {
        assert.ok(e instanceof StoreMovedError);
        assert.equal(e.renamed_to, 'customerhub');
        assert.match(e.message, /renamed: domain 'chulf' is now 'customerhub'/);
        assert.match(e.message, /nothing was written/);
        return true;
      }
    );
  } finally {
    store.close();
  }
});

test('a write to a move-fenced store keeps the move wording', { skip: sqliteOnly('SQLite fence row') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rename-fence-'));
  const path = domainStore(dir, 'chulf');
  const store = new SterlingStore(path);
  try {
    store.setMeta(STORE_FENCE_KEY, JSON.stringify({ move_id: 'm1', to: 'postgres:x', fenced_at: NOW, manifest_digest: null }));
    assert.throws(() => store.create(ref('domain:chulf')), (e: unknown) => e instanceof StoreMovedError && e.renamed_to === null && /was moved/.test(e.message));
  } finally {
    store.close();
  }
});

test('mounting a rename-fenced domain store refuses it loudly, naming the new domain, and mounts its siblings', { skip: sqliteOnly('SQLite mount') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rename-fence-'));
  const oldPath = domainStore(dir, 'chulf');
  const siblingPath = domainStore(dir, 'node');
  const newPath = join(dir, 'domains', 'customerhub', 'sterling.db');
  const seed = new SterlingStore(oldPath);
  const held = ref('domain:chulf');
  seed.create(held);
  seed.setMeta(STORE_FENCE_KEY, JSON.stringify(renameFence(newPath)));
  seed.close();
  const sibling = new SterlingStore(siblingPath);
  const siblingRecord = ref('domain:node');
  sibling.create(siblingRecord);
  sibling.close();

  const stores = new MountedStores(join(dir, 'project.db'), [
    { name: 'chulf', dbPath: oldPath },
    { name: 'node', dbPath: siblingPath },
  ]);
  try {
    assert.equal(stores.unreadableDomains.length, 1);
    const dropped = stores.unreadableDomains[0];
    assert.equal(dropped.name, 'chulf');
    assert.match(dropped.error, /renamed to 'customerhub'/);
    assert.ok(dropped.error.includes(newPath), 'the refusal names where the domain lives now');
    assert.match(dropped.note, /renamed/);
    // Not read: the fenced copy's record is not served.
    assert.equal(stores.get(held.id), undefined);
    assert.ok(stores.get(siblingRecord.id), 'a sibling domain still mounts');
    // Not written: a write routed to the old name is refused, naming the rename.
    assert.throws(() => stores.create(ref('domain:chulf')), /renamed to 'customerhub'/);
  } finally {
    stores.close();
  }
  // The error type itself carries the new name.
  const e = new DomainRenamedError('chulf', oldPath, renameFence(newPath) as never);
  assert.equal(e.renamed_to, 'customerhub');
});

test('store-move refuses a rename-fenced store and still reads a move fence', { skip: sqliteOnly('SQLite fence read') }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rename-fence-'));
  const renamed = domainStore(dir, 'chulf');
  const s = new SterlingStore(renamed);
  s.setMeta(STORE_FENCE_KEY, JSON.stringify(renameFence(join(dir, 'domains', 'customerhub', 'sterling.db'))));
  s.close();
  assert.throws(() => readSqliteFence(renamed), (e: unknown) => e instanceof MoveRenamedStoreError && /renamed to 'customerhub'/.test((e as Error).message) && /nothing was moved/.test((e as Error).message));

  const moved = domainStore(dir, 'node');
  const m = new SterlingStore(moved);
  const fence = { move_id: 'm1', to: 'postgres:x', fenced_at: NOW, manifest_digest: null };
  m.setMeta(STORE_FENCE_KEY, JSON.stringify(fence));
  m.close();
  assert.deepEqual(readSqliteFence(moved), fence, 'a move fence reads back exactly as stored, with no kind added');
});
