import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MountedStores, SterlingStore, createDomain } from '../index.js';

// Board a-mounted-pre-v2-domain-store-breaks-knowledge-query-and-kno (06f72a10):
// a mounted domain store that cannot answer a read (a pre-v2 store has no
// record_relations table) used to fail every fanned read on MountedStores.
// Each domain read is now isolated: the failing domain is dropped from reads
// and listed on unreadableDomains with the error. The project store is never
// isolated: its failure still throws.

const NOW = '2026-10-03T12:00:00.000Z';

function env(type: string, scope = 'project') {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope, stack_tags: [] };
}
const ref = (scope: string) => ({ ...env('reference_material', scope), title: 't', kind: 'doc', location: 'docs/x.md', summary: 's', source_date: '2026-06-16', capture_date: '2026-06-16', basis: 'platform' });

const dec = (scope: string, slug: string) => ({ ...env('decision', scope), slug, title: 't', statement: 's', alternatives_rejected: [], rationale: 'r', file_keys: [] });

/** Turn the store at `path` into a pre-v2 one: record bodies in the pre-v2
 *  shape (status in the body, no lifecycle), no record_relations table, and the
 *  schema marker rolled back to 1, so it opens read-only pre-migration. Such a
 *  store answers get, query and a slug lookup, but not inboundSupersedes. */
function makePreV2(path: string): void {
  const raw = new DatabaseSync(path);
  try {
    raw.exec(
      `UPDATE records SET body = json_set(json_remove(body, '$.lifecycle', '$.freshness'), '$.status', 'active', '$.superseded_by', json('null'));
       DROP TABLE record_relations;
       PRAGMA user_version = 1;`
    );
  } finally {
    raw.close();
  }
}

/** Project + healthy domain 'genesys' + pre-v2 domain 'old', each holding one record. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-'));
  const projectPath = join(dir, '.sterling', 'sterling.db');
  const genesys = { name: 'genesys', dbPath: join(dir, 'domains', 'genesys', 'sterling.db') };
  const old = { name: 'old', dbPath: join(dir, 'domains', 'old', 'sterling.db') };
  createDomain(genesys.name, 'test domain genesys', genesys.dbPath);
  createDomain(old.name, 'test domain old', old.dbPath);
  const seed = new SterlingStore(old.dbPath);
  const oldRecord = seed.create(ref('domain:old'));
  const oldSlugged = seed.create(dec('domain:old', 'taken-slug'));
  seed.close();
  makePreV2(old.dbPath);
  const stores = new MountedStores(projectPath, [old, genesys]);
  const projectRecord = stores.create(ref('project'));
  const genesysRecord = stores.create(ref('domain:genesys'));
  return {
    dir,
    stores,
    old,
    genesys,
    oldRecord,
    oldSlugged,
    projectRecord,
    genesysRecord,
    cleanup: () => {
      stores.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('unreadable domain: query returns the project and healthy-domain records and names the dropped domain with its error', () => {
  const h = harness();
  try {
    const ids = h.stores.query({}).map((r) => r.id);
    assert.ok(ids.includes(h.projectRecord.id), 'the project record is served');
    assert.ok(ids.includes(h.genesysRecord.id), 'the healthy domain record is served');
    assert.ok(!ids.includes(h.oldRecord.id), 'the dropped domain is not read');
    assert.equal(h.stores.unreadableDomains.length, 1);
    const [dropped] = h.stores.unreadableDomains;
    assert.equal(dropped.name, 'old');
    assert.equal(dropped.dbPath, h.old.dbPath);
    assert.match(dropped.error, /record_relations/);
    assert.match(dropped.note, /dropped at mount.*restart the session after the store is repaired/);
  } finally {
    h.cleanup();
  }
});

test('unreadable domain: get serves a project record, and a record held only by the dropped domain is not found', () => {
  const h = harness();
  try {
    assert.equal(h.stores.get(h.projectRecord.id)?.id, h.projectRecord.id);
    assert.equal(h.stores.get(h.genesysRecord.id)?.id, h.genesysRecord.id);
    assert.equal(h.stores.get(h.oldRecord.id), undefined);
    assert.deepEqual(h.stores.unreadableDomains.map((d) => d.name), ['old']);
  } finally {
    h.cleanup();
  }
});

test('unreadable domain: inboundSupersedes over the mounted set answers from the readable stores', () => {
  const h = harness();
  try {
    const replacement = h.stores.supersede(h.genesysRecord.id, { ...ref('domain:genesys'), title: 'replacement' });
    assert.deepEqual(h.stores.inboundSupersedes(h.genesysRecord.id).map((r) => r.id), [replacement.id]);
    assert.deepEqual(h.stores.inboundSupersedes(h.projectRecord.id), []);
    assert.equal(h.stores.scopeOfHolder(h.projectRecord.id), 'project');
  } finally {
    h.cleanup();
  }
});

test('unreadable domain: every other fanned read skips it instead of throwing', () => {
  const h = harness();
  try {
    assert.equal(h.stores.count({}), 2);
    assert.equal(h.stores.countAboveScore({ rank_terms: ['zzzz'] }, 0), 0);
    assert.deepEqual(h.stores.countBySource({}).map((s) => s.source), ['project', 'genesys']);
    assert.deepEqual(h.stores.bySource({}).map((s) => s.source), ['project', 'genesys']);
    assert.deepEqual(h.stores.querySource('old', {}), []);
    assert.deepEqual(h.stores.recordIdIndex().map((r) => r.id).sort(), [h.projectRecord.id, h.genesysRecord.id].sort());
    assert.deepEqual(h.stores.recordAliases(), []);
    assert.deepEqual(h.stores.articlesBySlug('nope'), []);
    assert.deepEqual(h.stores.recordsBySlug('nope'), []);
    assert.deepEqual(h.stores.supersededRecordsBySlug('nope'), []);
    assert.equal(h.stores.resolveTerminus(h.oldRecord.id), null);
  } finally {
    h.cleanup();
  }
});

test('unreadable domain: it stays listed, every write into it refuses naming the domain, its error and the restart, and a missing record names it', () => {
  const h = harness();
  try {
    assert.deepEqual(h.stores.domainNames(), ['old', 'genesys']);
    const refusal = /domain 'old' cannot be written: this session cannot read it \(no such table: record_relations.*\)\. Nothing was written\. Repair the store, then restart the session\./s;
    assert.throws(() => h.stores.create(ref('domain:old')), refusal);
    assert.throws(() => h.stores.setDomainDescription('old', 'new text'), refusal);
    assert.throws(() => h.stores.scopeOfHolder(h.oldRecord.id), /is held by domain 'old', which this session cannot read \(no such table: record_relations/);
    assert.throws(() => h.stores.scopeOfHolder(randomUUID()), /no record .*Not read: domain 'old'/s);
    for (const id of [h.oldRecord.id, randomUUID()]) {
      assert.throws(
        () => h.stores.scopeOfHolder(id),
        (e: Error) => !e.message.includes(h.old.dbPath),
        'the refusal text carries no absolute path'
      );
    }
  } finally {
    h.cleanup();
  }
});

test('unreadable domain: a domain that breaks after mount is dropped on the read that fails, and later reads keep working', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-late-'));
  const genesys = { name: 'genesys', dbPath: join(dir, 'domains', 'genesys', 'sterling.db') };
  createDomain(genesys.name, 'test domain genesys', genesys.dbPath);
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), [genesys]);
  try {
    const p = stores.create(ref('project'));
    const g = stores.create(ref('domain:genesys'));
    assert.equal(stores.unreadableDomains.length, 0);
    assert.equal(stores.get(g.id)?.id, g.id);

    const raw = new DatabaseSync(genesys.dbPath);
    raw.exec('DROP TABLE record_relations');
    raw.close();

    assert.deepEqual(stores.inboundSupersedes(p.id), []);
    assert.deepEqual(stores.unreadableDomains.map((d) => d.name), ['genesys']);
    assert.match(stores.unreadableDomains[0].error, /record_relations/);
    assert.match(stores.unreadableDomains[0].note ?? '', /dropped after mount.*until the session restarts/);
    assert.throws(() => stores.scopeOfHolder(g.id), /Not read: domain 'genesys'.*until the session restarts/s);
    assert.deepEqual(stores.query({}).map((r) => r.id), [p.id]);
    assert.equal(stores.unreadableDomains.length, 1, 'a dropped domain is listed once');
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unreadable domain: a broken PROJECT store is never isolated, its reads still throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-project-'));
  const projectPath = join(dir, '.sterling', 'sterling.db');
  const genesys = { name: 'genesys', dbPath: join(dir, 'domains', 'genesys', 'sterling.db') };
  createDomain(genesys.name, 'test domain genesys', genesys.dbPath);
  mkdirSync(dirname(projectPath), { recursive: true });
  new SterlingStore(projectPath).close();
  makePreV2(projectPath);
  const stores = new MountedStores(projectPath, [genesys]);
  try {
    assert.throws(() => stores.inboundSupersedes(randomUUID()), /record_relations/);
    assert.equal(stores.unreadableDomains.length, 0);
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('slugHolders: a dropped domain that can still answer a slug lookup is asked, so its slug counts as taken', () => {
  const h = harness();
  try {
    assert.deepEqual(h.stores.recordsBySlug('taken-slug'), [], 'the guarded read skips the dropped domain');
    assert.deepEqual(h.stores.slugHolders('taken-slug').map((r) => r.id), [h.oldSlugged.id]);
    assert.deepEqual(h.stores.slugHolders('free-slug'), []);
    assert.deepEqual(h.stores.articleSlugHolders('free-slug'), []);
  } finally {
    h.cleanup();
  }
});

test('slugHolders: a domain whose slug read throws makes the check refuse, naming the domain and the error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-slug-'));
  const genesys = { name: 'genesys', dbPath: join(dir, 'domains', 'genesys', 'sterling.db') };
  createDomain(genesys.name, 'test domain genesys', genesys.dbPath);
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), [genesys]);
  try {
    const raw = new DatabaseSync(genesys.dbPath);
    raw.exec('ALTER TABLE records RENAME TO records_gone');
    raw.close();
    const refusal = /slug 'some-slug' cannot be checked: domain 'genesys' could not be read \(no such table: .*records/s;
    assert.throws(() => stores.slugHolders('some-slug'), refusal);
    assert.throws(() => stores.articleSlugHolders('some-slug'), refusal);
    assert.throws(() => stores.slugHolders('some-slug'), refusal, 'a dropped domain is asked again on every check');
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unreadable domain: a record held by a dropped domain that still answers get is refused by holder routing, never reported absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-holder-'));
  const genesys = { name: 'genesys', dbPath: join(dir, 'domains', 'genesys', 'sterling.db') };
  createDomain(genesys.name, 'test domain genesys', genesys.dbPath);
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), [genesys]);
  try {
    stores.create(ref('project'));
    const g = stores.create(ref('domain:genesys'));
    const raw = new DatabaseSync(genesys.dbPath);
    raw.exec('DROP TABLE records_fts');
    raw.close();
    stores.query({ rank_terms: ['anything'] });
    assert.deepEqual(stores.unreadableDomains.map((d) => d.name), ['genesys']);
    assert.equal(stores.get(g.id), undefined, 'reads skip the dropped domain');
    const held = /record '.*' is held by domain 'genesys', which this session cannot read \(no such table: records_fts.*until the session restarts\)/s;
    assert.throws(() => stores.scopeOfHolder(g.id), held);
    assert.throws(() => stores.updateRecordMetadata(g.id, {} as never), held);
    assert.throws(() => stores.create(ref('domain:genesys')), /domain 'genesys' cannot be written/);
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the read guard drops a domain only on a database error: a caller-input error is rethrown and drops nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-unreadable-guard-'));
  const genesys = { name: 'genesys', dbPath: join(dir, 'domains', 'genesys', 'sterling.db') };
  createDomain(genesys.name, 'test domain genesys', genesys.dbPath);
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), [genesys]);
  try {
    const g = stores.create(ref('domain:genesys'));
    const tooMany = Array.from({ length: 2000 }, (_, i) => `x${i}`);
    assert.throws(() => stores.querySource('genesys', { rank_terms: tooMany }), (e: Error) => e.name === 'ZodError');
    assert.throws(() => stores.query({ rank_terms: tooMany }), (e: Error) => e.name === 'ZodError');
    assert.equal(stores.unreadableDomains.length, 0, 'a bad option is the caller\'s error, not the domain\'s');
    assert.equal(stores.get(g.id)?.id, g.id, 'the domain is still read');
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
