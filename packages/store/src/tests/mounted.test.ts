import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountedStores } from '../index.js';
import type { QueryOptions } from '../index.js';

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

// ---------------------------------------------------------------------------
// FROZEN P1 oracle (run r-dd88) — SPEC-ONLY, written before the surface exists.
// These must fail RED on AssertionError (never by throwing) until the coder
// implements bySource (AC2) and the skip-missing mount mode (AC7).
//
// The not-yet-existent surface is reached through NARROW casts so the file
// compiles under tsc strict; an existence assertion runs FIRST so an
// unimplemented method/option yields a clean AssertionError, not a TypeError.
// ---------------------------------------------------------------------------

/** Minimal record shape the bySource assertions read — narrowed to the fields
 *  these tests touch so the oracle never depends on DurableRecord being
 *  re-exported from ../index.js. */
interface RecordLike {
  id: string;
  type: string;
  scope: string;
}

/** The bySource contract (brief interface MountedStores.bySource) — narrowed to
 *  exactly what AC2 asserts, so tsc compiles before MountedStores declares it. */
type BySource = (opts?: QueryOptions) => { source: string; records: RecordLike[] }[];
const bySourceOf = (s: MountedStores): BySource | undefined =>
  (s as unknown as { bySource?: BySource }).bySource?.bind(s);

/** The skip-missing mount mode (brief interface "MountedStores skip-missing
 *  mount") — the brief leaves the exact surface to the implementor; this oracle
 *  ASSUMES a 3rd constructor options argument `{ skipMissing: true }` and tests
 *  the BEHAVIOUR (file-not-created / source-absent), not the flag name. The cast
 *  lets tsc accept the 3rd arg before the ctor signature grows it. */
type MountedCtor = new (
  projectDbPath: string,
  mounts: { name: string; dbPath: string }[],
  options?: { skipMissing?: boolean }
) => MountedStores;
const MountedStoresX = MountedStores as unknown as MountedCtor;

test('AC2 bySource: project entry FIRST, then each mounted domain in manifest order, named by physical store', () => {
  const { stores, cleanup } = harness(['alpha', 'beta']);
  try {
    const bySource = bySourceOf(stores);
    assert.strictEqual(typeof bySource, 'function', 'MountedStores.bySource must exist (AC2)');

    const dec = stores.create({ ...env('decision'), title: 'project dec', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const a = stores.create(ref('domain:alpha'));
    const b = stores.create(ref('domain:beta'));

    const groups = bySource!();
    assert.deepEqual(groups.map((g) => g.source), ['project', 'alpha', 'beta'], 'project first, then domains in manifest order');

    // each record surfaces ONLY under its physical store — never double-listed
    const project = groups.find((g) => g.source === 'project')!;
    const alpha = groups.find((g) => g.source === 'alpha')!;
    const beta = groups.find((g) => g.source === 'beta')!;
    assert.ok(project.records.some((r) => r.id === dec.id), 'project-scoped record under the project source');
    assert.ok(!project.records.some((r) => r.id === a.id || r.id === b.id), 'a domain record never appears under the project source');
    assert.ok(alpha.records.some((r) => r.id === a.id) && !alpha.records.some((r) => r.id === b.id), "alpha's record only under alpha");
    assert.ok(beta.records.some((r) => r.id === b.id) && !beta.records.some((r) => r.id === a.id), "beta's record only under beta");
  } finally {
    cleanup();
  }
});

test('AC2 bySource: each store runs the query INDEPENDENTLY — type filter and cap are PER-STORE', () => {
  const { stores, cleanup } = harness(['alpha']);
  try {
    const bySource = bySourceOf(stores);
    assert.strictEqual(typeof bySource, 'function', 'MountedStores.bySource must exist (AC2)');

    // project: 2 decisions + 1 reference; alpha: 2 references
    stores.create({ ...env('decision'), title: 'p1', statement: 's', alternatives_rejected: [], rationale: 'r' });
    stores.create({ ...env('decision'), title: 'p2', statement: 's', alternatives_rejected: [], rationale: 'r' });
    stores.create(ref('project'));
    stores.create(ref('domain:alpha'));
    stores.create({ ...ref('domain:alpha'), location: 'docs/y.md' });

    // type filter is applied INSIDE each store: only references survive, both stores
    const refs = bySource!({ types: ['reference_material'], cap: 10 });
    const refProject = refs.find((g) => g.source === 'project')!;
    const refAlpha = refs.find((g) => g.source === 'alpha')!;
    assert.equal(refProject.records.length, 1, 'project: exactly the 1 project reference (decisions filtered out per-store)');
    assert.equal(refAlpha.records.length, 2, 'alpha: both alpha references');
    assert.ok(refProject.records.every((r) => r.type === 'reference_material'), 'project group is type-filtered');
    assert.ok(refAlpha.records.every((r) => r.type === 'reference_material'), 'alpha group is type-filtered');

    // cap is PER-STORE, not a global slice: cap:1 yields up to 1 PER source
    const capped = bySource!({ cap: 1 });
    assert.equal(capped.find((g) => g.source === 'project')!.records.length, 1, 'cap:1 limits the project store to 1');
    assert.equal(capped.find((g) => g.source === 'alpha')!.records.length, 1, 'cap:1 limits the alpha store to 1 (cap is per-store)');
  } finally {
    cleanup();
  }
});

test('countBySource: COUNT(*) twin of bySource — project FIRST then domains, per-store counts matching bySource (no body fetch)', () => {
  const { stores, cleanup } = harness(['alpha', 'beta']);
  try {
    stores.create({ ...env('decision'), title: 'project dec', statement: 's', alternatives_rejected: [], rationale: 'r' });
    stores.create(ref('domain:alpha'));
    stores.create({ ...ref('domain:alpha'), location: 'docs/y.md' });
    stores.create(ref('domain:beta'));

    const counts = stores.countBySource({ types: ['reference_material'] });
    assert.deepEqual(counts.map((g) => g.source), ['project', 'alpha', 'beta'], 'project first, then domains in manifest order');
    assert.equal(counts.find((g) => g.source === 'project')!.count, 0, 'no references in the project store');
    assert.equal(counts.find((g) => g.source === 'alpha')!.count, 2, 'two references in alpha');
    assert.equal(counts.find((g) => g.source === 'beta')!.count, 1, 'one reference in beta');
    // never drifts from bySource record counts (same base filter, just COUNT(*))
    for (const g of stores.bySource({ types: ['reference_material'] })) {
      assert.equal(counts.find((c) => c.source === g.source)!.count, g.records.length, `countBySource == bySource length for ${g.source}`);
    }
  } finally {
    cleanup();
  }
});

test('querySource: records from ONE named source only; an unknown source → []', () => {
  const { stores, cleanup } = harness(['alpha']);
  try {
    const p = stores.create({ ...env('decision'), title: 'proj', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const a = stores.create(ref('domain:alpha'));
    const projRecs = stores.querySource('project', { types: ['decision'] });
    assert.ok(projRecs.some((r) => r.id === p.id), 'the project source returns the project record');
    assert.ok(!projRecs.some((r) => r.id === a.id), 'the project source never returns a domain record');
    const alphaRecs = stores.querySource('alpha', { types: ['reference_material'] });
    assert.ok(alphaRecs.some((r) => r.id === a.id), 'the alpha source returns its record');
    assert.deepEqual(stores.querySource('nonexistent', {}), [], 'an unknown source yields []');
  } finally {
    cleanup();
  }
});

test('AC2 bySource: zero mounted domains → exactly one project entry', () => {
  const { stores, cleanup } = harness([]);
  try {
    const bySource = bySourceOf(stores);
    assert.strictEqual(typeof bySource, 'function', 'MountedStores.bySource must exist (AC2)');

    const dec = stores.create({ ...env('decision'), title: 'only-project', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const groups = bySource!();
    assert.equal(groups.length, 1, 'no domains mounted → a single group');
    assert.equal(groups[0].source, 'project', 'the single group is the project store');
    assert.ok(groups[0].records.some((r) => r.id === dec.id), 'the project record is present');
  } finally {
    cleanup();
  }
});

test('AC7 skip-missing: a domain whose db file does NOT exist is SKIPPED — file not created, store absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-skipmissing-'));
  const missingDb = join(dir, 'domains', 'ghost', 'sterling.db');
  const stores = new MountedStoresX(
    join(dir, '.sterling', 'sterling.db'),
    [{ name: 'ghost', dbPath: missingDb }],
    { skipMissing: true }
  );
  try {
    // BEHAVIOURAL signals asserted BEFORE any call that could throw:
    // (1) the db file is NOT brought into being for a non-existent mount
    assert.equal(existsSync(missingDb), false, 'skip-missing must NOT create a domain db that did not exist (AC7)');
    // (2) the absent store is not in the mounted set
    assert.ok(!stores.domainNames().includes('ghost'), 'a skipped domain is absent from domainNames() (AC7)');
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC7 skip-missing: an EXISTING sibling domain is still mounted while a missing one is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-skipmissing-sibling-'));
  const presentDb = join(dir, 'domains', 'present', 'sterling.db');
  const missingDb = join(dir, 'domains', 'absent', 'sterling.db');
  // bring 'present' into existence first via a normal (creating) mount, then close it
  const seed = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'present', dbPath: presentDb }]);
  seed.close();
  assert.ok(existsSync(presentDb), 'precondition: the present domain db exists on disk');

  const stores = new MountedStoresX(
    join(dir, '.sterling', 'sterling.db'),
    [
      { name: 'present', dbPath: presentDb },
      { name: 'absent', dbPath: missingDb },
    ],
    { skipMissing: true }
  );
  try {
    assert.equal(existsSync(missingDb), false, 'the absent domain db is still not created under skip-missing (AC7)');
    assert.deepEqual(stores.domainNames(), ['present'], 'only the existing sibling is mounted; the missing one is skipped (AC7)');
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('MountedStores: the existing default mount mode STILL lazily creates a missing domain db on mount (regression guard for AC7)', () => {
  // AC7 adds an OPT-IN skip-missing mode; the default (no options arg) must keep
  // the §2.3 lazy-create behaviour mounted.test relies on — pin it so the new
  // mode can never silently become the default.
  const dir = mkdtempSync(join(tmpdir(), 'sterling-default-lazy-'));
  const freshDb = join(dir, 'domains', 'fresh', 'sterling.db');
  const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'fresh', dbPath: freshDb }]);
  try {
    assert.ok(existsSync(freshDb), 'default mode lazily creates the domain db on mount (§2.3)');
    assert.deepEqual(stores.domainNames(), ['fresh'], 'the lazily-created domain is mounted');
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
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
