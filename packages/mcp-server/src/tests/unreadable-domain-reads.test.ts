import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { MountedStores, createDomain, type DomainMount } from '@sterling/store';
import { SterlingTools, mountedDomainSurface } from '../tools.js';

// Board a-mounted-pre-v2-domain-store-breaks-knowledge-query-and-kno (06f72a10):
// with a pre-v2 domain store mounted, knowledge_query and knowledge_get failed
// with "no such table: record_relations". The read now drops that domain and
// the tool result names it with the error, as unreadable_domains.

/** Project + pre-v2 domain 'old' (one record seeded before the downgrade) + healthy domain 'genesys'. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-tools-'));
  const dbPath = (name: string) => join(dir, 'domains', name, 'sterling.db');
  const mounts: DomainMount[] = ['old', 'genesys'].map((name) => ({ name, dbPath: dbPath(name) }));
  for (const m of mounts) createDomain(m.name, `${m.name} domain`, m.dbPath);
  const config = parseConfig({ stack_tags: mounts.map((m) => m.name) });
  const open = () => {
    const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), mounts, { skipMissing: true });
    const tools = new SterlingTools({ store, config, domains: mountedDomainSurface(store), now: () => '2026-10-03T12:00:00.000Z', newId: randomUUID });
    return { store, tools };
  };

  const seeding = open();
  const oldRecord = seeding.tools.knowledgeCreate('decision', decision('Queue overflow retry policy for the old domain', { scope: 'domain:old' })).record;
  seeding.store.close();
  const raw = new DatabaseSync(dbPath('old'));
  raw.exec('DROP TABLE record_relations; PRAGMA user_version = 1;');
  raw.close();

  const { store, tools } = open();
  return {
    tools,
    oldRecord,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const decision = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  statement: title,
  alternatives_rejected: [],
  rationale: 'r',
  ...extra,
});

const assertNamesOld = (unreadable: { name: string; error: string }[] | undefined, where: string) => {
  assert.equal(unreadable?.length, 1, where);
  assert.equal(unreadable?.[0].name, 'old', where);
  assert.match(unreadable?.[0].error ?? '', /record_relations/, where);
};

test('knowledge_query with a pre-v2 domain mounted serves the project and the healthy domain and names the dropped domain', () => {
  const h = harness();
  try {
    const p = h.tools.knowledgeCreate('decision', decision('Queue overflow retry policy')).record;
    const g = h.tools.knowledgeCreate('decision', decision('Queue overflow retry policy for IVR', { scope: 'domain:genesys' })).record;
    for (const projection of ['full', 'digest'] as const) {
      const res = h.tools.knowledgeQueryResult({ types: ['decision'], cap: 10, projection });
      const byId = new Map(res.records.map((r) => [r.id, r]));
      assert.equal(byId.get(p.id)?.source, 'project', projection);
      assert.equal(byId.get(g.id)?.source, 'domain:genesys', projection);
      assert.equal(byId.has(h.oldRecord.id), false, projection);
      assertNamesOld(res.unreadable_domains, projection);
    }
    const counted = h.tools.knowledgeQueryResult({ types: ['decision'], projection: 'count' });
    assert.equal(counted.matched_filter, 2);
    assertNamesOld(counted.unreadable_domains, 'count');
  } finally {
    h.cleanup();
  }
});

test('knowledge_get with a pre-v2 domain mounted serves a project record and names the dropped domain', () => {
  const h = harness();
  try {
    const p = h.tools.knowledgeCreate('decision', decision('Queue overflow retry policy')).record;
    const got = h.tools.knowledgeGet(p.id) as Record<string, unknown>;
    assert.equal(got.id, p.id);
    assertNamesOld(got.unreadable_domains as { name: string; error: string }[], 'get');
  } finally {
    h.cleanup();
  }
});

test('knowledge_get of a record held only by the dropped domain is a not-found refusal that names the domain and its error', () => {
  const h = harness();
  try {
    assert.throws(
      () => h.tools.knowledgeGet(h.oldRecord.id),
      (e: Error) => {
        assert.doesNotMatch(e.message, /^no such table/);
        assert.match(e.message, /domain 'old' was not read/);
        assert.match(e.message, /record_relations/);
        return true;
      }
    );
  } finally {
    h.cleanup();
  }
});

test('knowledge_preflight with a pre-v2 domain mounted names the dropped domain', () => {
  const h = harness();
  try {
    h.tools.knowledgeCreate('decision', decision('Queue overflow retry policy'));
    const res = h.tools.knowledgePreflight('queue overflow retry policy');
    assert.equal(res.answerability, 'verify_targets');
    assertNamesOld(res.unreadable_domains, 'preflight');
  } finally {
    h.cleanup();
  }
});

test('a domain dropped after mount is disclosed with a note that it stays dropped until the session restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-late-tools-'));
  const mount = { name: 'genesys', dbPath: join(dir, 'domains', 'genesys', 'sterling.db') };
  createDomain(mount.name, 'genesys domain', mount.dbPath);
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [mount], { skipMissing: true });
  try {
    const tools = new SterlingTools({ store, config: parseConfig({ stack_tags: ['genesys'] }), domains: mountedDomainSurface(store), now: () => '2026-10-03T12:00:00.000Z', newId: randomUUID });
    const p = tools.knowledgeCreate('decision', decision('Queue overflow retry policy')).record;
    const g = tools.knowledgeCreate('decision', decision('Queue overflow retry policy for IVR', { scope: 'domain:genesys' })).record;
    const raw = new DatabaseSync(mount.dbPath);
    raw.exec('DROP TABLE record_relations');
    raw.close();

    const res = tools.knowledgeQueryResult({ types: ['decision'] });
    assert.deepEqual(res.records.map((r) => r.id), [p.id]);
    assert.equal(res.unreadable_domains?.[0]?.name, 'genesys');
    assert.match(res.unreadable_domains?.[0]?.note ?? '', /until the session restarts/);
    assert.throws(() => tools.knowledgeGet(g.id), /domain 'genesys' was not read .*until the session restarts/s);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with every domain readable, knowledge_query and knowledge_get carry no unreadable_domains key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-none-'));
  const mount = { name: 'genesys', dbPath: join(dir, 'domains', 'genesys', 'sterling.db') };
  createDomain(mount.name, 'genesys domain', mount.dbPath);
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [mount], { skipMissing: true });
  try {
    const tools = new SterlingTools({ store, config: parseConfig({ stack_tags: ['genesys'] }), domains: mountedDomainSurface(store), now: () => '2026-10-03T12:00:00.000Z', newId: randomUUID });
    const p = tools.knowledgeCreate('decision', decision('Queue overflow retry policy')).record;
    assert.equal('unreadable_domains' in tools.knowledgeQueryResult({ types: ['decision'] }), false);
    assert.equal('unreadable_domains' in (tools.knowledgeGet(p.id) as Record<string, unknown>), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
