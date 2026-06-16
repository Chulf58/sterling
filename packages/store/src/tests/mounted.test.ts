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
