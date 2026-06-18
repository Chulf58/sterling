import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountedStores } from '../index.js';

const NOW = '2026-06-16T12:00:00.000Z';

function env(type: string, scope = 'project') {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope, stack_tags: [] };
}
const ref = (scope: string) => ({ ...env('reference_material', scope), title: 't', kind: 'doc', location: 'docs/x.md', summary: 's', source_date: '2026-06-16', capture_date: '2026-06-16', basis: 'platform' });

function harness(domains: string[] = ['genesys']) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mounted-'));
  const mounts = domains.map((name) => ({ name, dbPath: join(dir, 'domains', name, 'sterling.db') }));
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), mounts);
  return { dir, stores, cleanup: () => { stores.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('MountedStores: routes writes by scope, fans query project-first, get spans stores (§3.3/§3.4)', () => {
  const { dir, stores, cleanup } = harness(['genesys']);
  try {
    const dec = stores.create({ ...env('decision'), title: 'project dec', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const r = stores.create(ref('domain:genesys'));

    // §2.3 lazy creation: the domain store file came into being on mount
    assert.ok(existsSync(join(dir, 'domains', 'genesys', 'sterling.db')), 'domain store created on mount');
    // routing: project-scoped → project store; domain-scoped → NOT the project store
    assert.ok(stores.project.get(dec.id), 'project-scoped record lives in the project store');
    assert.equal(stores.project.get(r.id), undefined, 'domain-scoped record does not live in the project store');
    // cross-store get finds both
    assert.equal(stores.get(dec.id)?.scope, 'project');
    assert.equal(stores.get(r.id)?.scope, 'domain:genesys');
    // cross-store query spans both, project-first (§3.3 bias)
    const ids = stores.query({ cap: 10 }).map((x) => x.id);
    assert.ok(ids.includes(dec.id) && ids.includes(r.id), 'query spans project + domain');
    assert.ok(ids.indexOf(dec.id) < ids.indexOf(r.id), 'project results come first');
  } finally {
    cleanup();
  }
});

test('MountedStores: a write to an unmounted domain is rejected loudly', () => {
  const { stores, cleanup } = harness(['genesys']);
  try {
    assert.throws(() => stores.create(ref('domain:fuel-prices')), /unmounted domain/);
  } finally {
    cleanup();
  }
});

test('MountedStores: a domain record written through one project mount is read back through ANOTHER mount of the same shared file (cross-project sharing, §3.3)', () => {
  // The real cross-project shape: two projects with SEPARATE project stores, both
  // mounting the SAME shared domain file. domain-routing.test.ts exercises a single
  // MountedStores; this pins the two-readers/one-file path that actually carries
  // knowledge between sibling projects (the path the stale-server incident hid).
  const dir = mkdtempSync(join(tmpdir(), 'sterling-xmount-'));
  const sharedDomainDb = join(dir, 'shared-domains', 'genesys', 'sterling.db');
  // both servers open the shared file up front (as concurrent project servers do)
  const projA = new MountedStores(join(dir, 'projA', '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: sharedDomainDb }]);
  const projB = new MountedStores(join(dir, 'projB', '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: sharedDomainDb }]);
  try {
    // A writes a domain record (the promote/create path) into the shared store...
    const shared = projA.create(ref('domain:genesys'));
    const aLocal = projA.create({ ...env('decision'), title: 'A-only', statement: 's', alternatives_rejected: [], rationale: 'r' });

    // ...and B — a SEPARATE project store over the SAME shared file — reads it back
    assert.equal(projB.get(shared.id)?.scope, 'domain:genesys', 'B reads the domain record A wrote to the shared file');
    assert.ok(projB.query({ cap: 10 }).some((x) => x.id === shared.id), 'B query surfaces the shared domain record');

    // boundary: A's PROJECT-scoped record never crosses — project stores are separate
    assert.equal(projB.get(aLocal.id), undefined, "B cannot see A's project-scoped record (project stores are not shared)");
    assert.equal(projB.project.get(shared.id), undefined, 'the shared record is NOT in B’s project store — it lives in the shared domain file');
  } finally {
    projA.close();
    projB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
