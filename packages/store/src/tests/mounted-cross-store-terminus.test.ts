import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountedStores, createDomain } from '../index.js';
import { sqliteOnly } from './pg-test-support.js';

// MountedStores.resolveTerminus follows a superseded record's successor into
// another mounted store (decision foreign_de1a7329: disclose, never redirect).
// knowledge_promote leaves a project tombstone whose superseded_by names the
// live copy in a domain store; the store-level walk cannot see across stores,
// so the mounted layer must continue the walk where each store's walk ends.

const NOW = '2026-10-16T12:00:00.000Z';

function ref(scope: string, title = 't') {
  return {
    id: randomUUID(), type: 'reference_material', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
    superseded_by: null, links: [], scope, stack_tags: [],
    title, kind: 'doc', location: 'docs/x.md', summary: 's', source_date: '2026-06-16', capture_date: '2026-06-16', basis: 'platform',
  };
}

function harness(domainNames: string[] = ['alpha']) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-cross-terminus-'));
  const projectPath = join(dir, '.sterling', 'sterling.db');
  const mounts = domainNames.map((name) => ({ name, dbPath: join(dir, 'domains', name, 'sterling.db') }));
  for (const m of mounts) createDomain(m.name, `test domain ${m.name}`, m.dbPath);
  const stores = new MountedStores(projectPath, mounts);
  return { dir, projectPath, mounts, stores, cleanup: () => { stores.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a project tombstone left by a promotion resolves to its live domain copy', { skip: sqliteOnly('mounted routing') }, () => {
  const h = harness();
  try {
    const original = h.stores.create(ref('project'));
    const copy = h.stores.create(ref('domain:alpha'));
    h.stores.retireInFavorOf(original.id, copy.id, NOW, 'promoted');

    assert.deepEqual(h.stores.resolveTerminus(original.id), { id: copy.id, status: 'active', hops: 1 });
    assert.deepEqual(h.stores.resolveTerminus(copy.id), { id: copy.id, status: 'active', hops: 0 });
  } finally {
    h.cleanup();
  }
});

test('the walk continues inside the second store: hops add across the store boundary', { skip: sqliteOnly('mounted routing') }, () => {
  const h = harness();
  try {
    const original = h.stores.create(ref('project'));
    const copy = h.stores.create(ref('domain:alpha'));
    h.stores.retireInFavorOf(original.id, copy.id, NOW, 'promoted');
    const next = h.stores.supersede(copy.id, ref('domain:alpha', 'v2'));

    assert.deepEqual(h.stores.resolveTerminus(original.id), { id: next.id, status: 'active', hops: 2 });
  } finally {
    h.cleanup();
  }
});

test('a cross-store cycle terminates, reports truncated and does not throw', { skip: sqliteOnly('mounted routing') }, () => {
  const h = harness();
  try {
    const a = h.stores.create(ref('project'));
    const b = h.stores.create(ref('domain:alpha'));
    h.stores.retireInFavorOf(a.id, b.id, NOW, 'promoted');
    h.stores.retireInFavorOf(b.id, a.id, NOW);

    const out = h.stores.resolveTerminus(a.id);
    assert.ok(out, 'a result is returned');
    assert.equal(out.truncated, true);
    assert.equal(out.status, 'superseded', 'it never claims a live end it did not reach');
    assert.equal(out.id, b.id, 'it reports the last record reached before the revisit');
    assert.equal(out.hops, 1);
  } finally {
    h.cleanup();
  }
});

test('a chain longer than 32 hops that alternates between stores truncates at 32 and does not claim the unreached end', { skip: sqliteOnly('mounted routing') }, () => {
  const h = harness();
  try {
    // nodes 0..33: even in the project store, odd in the domain; node 33 is live.
    const nodes = Array.from({ length: 34 }, (_, i) => h.stores.create(ref(i % 2 === 0 ? 'project' : 'domain:alpha', `n${i}`)));
    for (let i = 0; i < 33; i++) h.stores.retireInFavorOf(nodes[i].id, nodes[i + 1].id, NOW);

    const out = h.stores.resolveTerminus(nodes[0].id);
    assert.deepEqual(out, { id: nodes[32].id, status: 'superseded', hops: 32, truncated: true });
    assert.notEqual(out?.id, nodes[33].id, 'the live end past the cap is not claimed');

    // one hop shorter: the live node 33 is reachable at exactly 32 hops, so it is reported.
    assert.deepEqual(h.stores.resolveTerminus(nodes[1].id), { id: nodes[33].id, status: 'active', hops: 32 });
  } finally {
    h.cleanup();
  }
});

test('the cap counts hops across stores, not per-store segments: a project node followed by 33 domain-held nodes stops at hop 32', { skip: sqliteOnly('mounted routing') }, () => {
  const h = harness();
  try {
    // node 0 in the project store, nodes 1..33 in the domain; node 33 is live.
    const nodes = Array.from({ length: 34 }, (_, i) => h.stores.create(ref(i === 0 ? 'project' : 'domain:alpha', `n${i}`)));
    for (let i = 0; i < 33; i++) h.stores.retireInFavorOf(nodes[i].id, nodes[i + 1].id, NOW);

    assert.deepEqual(h.stores.resolveTerminus(nodes[0].id), { id: nodes[32].id, status: 'superseded', hops: 32, truncated: true });
    assert.deepEqual(h.stores.resolveTerminus(nodes[1].id), { id: nodes[33].id, status: 'active', hops: 32 });
  } finally {
    h.cleanup();
  }
});

test('a cycle that closes on an interior node of an earlier segment stops at the revisit', { skip: sqliteOnly('mounted routing') }, () => {
  const h = harness();
  try {
    // project A -> B -> C, then C -> D (domain), then D -> B: B is interior to the first segment.
    const [a, b, c] = [h.stores.create(ref('project', 'A')), h.stores.create(ref('project', 'B')), h.stores.create(ref('project', 'C'))];
    const d = h.stores.create(ref('domain:alpha', 'D'));
    h.stores.retireInFavorOf(a.id, b.id, NOW);
    h.stores.retireInFavorOf(b.id, c.id, NOW);
    h.stores.retireInFavorOf(c.id, d.id, NOW);
    h.stores.retireInFavorOf(d.id, b.id, NOW);

    assert.deepEqual(h.stores.resolveTerminus(a.id), { id: d.id, status: 'superseded', hops: 3, truncated: true });
  } finally {
    h.cleanup();
  }
});

test('a domain that breaks after mount is skipped by the walk: the tombstone is returned truncated and the domain is listed unreadable', { skip: sqliteOnly('mounted routing') }, () => {
  const h = harness(['alpha', 'beta']);
  try {
    const p = h.stores.create(ref('project', 'P'));
    const a = h.stores.create(ref('domain:alpha', 'A'));
    const b = h.stores.create(ref('domain:beta', 'B'));
    h.stores.retireInFavorOf(p.id, a.id, NOW, 'promoted');
    h.stores.retireInFavorOf(a.id, b.id, NOW);
    assert.deepEqual(h.stores.resolveTerminus(p.id), { id: b.id, status: 'active', hops: 2 });

    const raw = new DatabaseSync(h.mounts[0].dbPath);
    raw.exec('DROP TABLE record_relations');
    raw.close();

    assert.deepEqual(h.stores.resolveTerminus(p.id), { id: p.id, status: 'superseded', hops: 0, truncated: true });
    assert.deepEqual(h.stores.unreadableDomains.map((d) => d.name), ['alpha']);
  } finally {
    h.cleanup();
  }
});

test('a successor held by a domain that is not mounted leaves the walk truncated at the tombstone', { skip: sqliteOnly('mounted routing') }, () => {
  const h = harness();
  const original = h.stores.create(ref('project'));
  const copy = h.stores.create(ref('domain:alpha'));
  h.stores.retireInFavorOf(original.id, copy.id, NOW, 'promoted');
  h.stores.close();

  const unmounted = new MountedStores(h.projectPath, []);
  try {
    assert.deepEqual(unmounted.resolveTerminus(original.id), { id: original.id, status: 'superseded', hops: 0, truncated: true });
  } finally {
    unmounted.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});
