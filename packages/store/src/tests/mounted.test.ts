import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MountedStores, SterlingStore, createDomain, missingDomainWarning } from '../index.js';
import type { QueryOptions } from '../index.js';

const NOW = '2026-06-16T12:00:00.000Z';

function env(type: string, scope = 'project') {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope, stack_tags: [] };
}
const ref = (scope: string) => ({ ...env('reference_material', scope), title: 't', kind: 'doc', location: 'docs/x.md', summary: 's', source_date: '2026-06-16', capture_date: '2026-06-16', basis: 'platform' });

function harness(domains: string[] = ['genesys']) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-mounted-'));
  const mounts = domains.map((name) => ({ name, dbPath: join(dir, 'domains', name, 'sterling.db') }));
  for (const m of mounts) createDomain(m.name, `test domain ${m.name}`, m.dbPath);
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

test('count: cross-mount COUNT(*) summed project-first — the number knowledge_query discloses as matched_filter', () => {
  const { stores, cleanup } = harness(['alpha', 'beta']);
  try {
    stores.create(ref('domain:alpha'));
    stores.create({ ...ref('domain:alpha'), location: 'docs/y.md' });
    stores.create(ref('domain:beta'));

    // The tool layer reports this as matched_filter so a capped retrieval can say
    // how many records matched the filter it was given. It must span mounts: a
    // project-only count would under-report and re-create the very "you are
    // holding the whole store" misread the disclosure exists to prevent.
    assert.equal(stores.count({ types: ['reference_material'] }), 3, 'sums every mounted store, not just the project one');
    assert.equal(
      stores.count({ types: ['reference_material'] }),
      stores.countBySource({ types: ['reference_material'] }).reduce((n, s) => n + s.count, 0),
      'count never drifts from the per-source fan it sums'
    );
    // cap is a RETRIEVAL bound, never a counting one — otherwise the disclosure
    // could never report more matches than the window it is disclosing.
    assert.equal(stores.query({ types: ['reference_material'], cap: 1 }).length, 1, 'the cap bounds the window');
    assert.equal(stores.count({ types: ['reference_material'], cap: 1 }), 3, 'but never the count');
    assert.equal(stores.count({ types: ['decision'] }), 0, 'an unmatched filter counts zero');
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
  // bring 'present' into existence first through createDomain
  createDomain('present', 'present domain', presentDb);
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

    // the domain store file was created by createDomain in the harness
    assert.ok(existsSync(join(dir, 'domains', 'genesys', 'sterling.db')), 'domain store exists');
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

test('recordIdIndex fans every mounted store project-first, tombstones included (the citation resolver universe)', () => {
  const { stores, cleanup } = harness(['genesys', 'fuel-prices']);
  try {
    const projectRec = stores.create(ref('project')) as { id: string };
    const genesysRec = stores.create(ref('domain:genesys')) as { id: string };
    const fuelRec = stores.create(ref('domain:fuel-prices')) as { id: string };
    // a tombstone in a DOMAIN store — the shape a cross-store citation hits
    const replacement = stores.supersede(genesysRec.id, { ...ref('domain:genesys'), updated_at: '2026-06-16T13:00:00.000Z' }) as { id: string };

    const index = stores.recordIdIndex();
    const ids = index.map((r) => r.id);
    assert.equal(ids[0], projectRec.id, 'project store first (§3.3 bias)');
    for (const id of [genesysRec.id, fuelRec.id, replacement.id]) {
      assert.ok(ids.includes(id), `mounted-store id ${id} is in the index`);
    }
    assert.equal(
      index.find((r) => r.id === genesysRec.id)?.status,
      'superseded',
      'a domain tombstone resolves — a project-only lookup would call it dangling'
    );
    assert.equal(ids.length, 4);
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

test('MountedStores: the default mount mode REFUSES a missing domain, naming createDomain, and creates no file (board 675daf9d (c))', () => {
  // Lazy creation of a domain on first mount is gone: a new domain store needs a
  // description, so it is made only by createDomain(name, description, dbPath).
  // skipMissing (AC7) is still the opt-in way to mount only what exists.
  const dir = mkdtempSync(join(tmpdir(), 'sterling-default-refuse-'));
  const freshDb = join(dir, 'domains', 'fresh', 'sterling.db');
  try {
    assert.throws(
      () => new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'fresh', dbPath: freshDb }]),
      (e: Error) => /createDomain/.test(e.message) && /'fresh'/.test(e.message) && e.message.includes(freshDb)
    );
    assert.equal(existsSync(freshDb), false, 'no domain db is created by a refused mount');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MountedStores skipMissing records each skipped domain in missingDomains, and the warning names the domain, path and fix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-missing-list-'));
  const presentDb = join(dir, 'domains', 'present', 'sterling.db');
  const ghostDb = join(dir, 'domains', 'ghost', 'sterling.db');
  createDomain('present', 'present domain', presentDb);
  const stores = new MountedStores(
    join(dir, '.sterling', 'sterling.db'),
    [{ name: 'present', dbPath: presentDb }, { name: 'ghost', dbPath: ghostDb }],
    { skipMissing: true }
  );
  try {
    assert.deepEqual(stores.domainNames(), ['present']);
    assert.deepEqual(stores.missingDomains, [{ name: 'ghost', dbPath: ghostDb }]);
    const line = missingDomainWarning(stores.missingDomains[0]);
    assert.ok(line.includes("'ghost'") && line.includes(ghostDb), line);
    assert.match(line, /createDomain/);
    assert.match(line, /init/);
    assert.ok(!line.includes('\n'), 'one line');
  } finally {
    stores.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MountedStores: with every domain present, missingDomains is empty', () => {
  const { stores, cleanup } = harness(['genesys']);
  try {
    assert.deepEqual(stores.missingDomains, []);
  } finally {
    cleanup();
  }
});

test('createDomain: writes the description as the store_meta description key; the domain then mounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-create-domain-'));
  const db = join(dir, 'domains', 'genesys', 'sterling.db');
  try {
    createDomain('genesys', '  Genesys Cloud: routing, flows, APIs  ', db);
    assert.ok(existsSync(db), 'the domain db exists');
    const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: db }]);
    try {
      assert.deepEqual(stores.domainNames(), ['genesys']);
      assert.equal(stores.domainDescription('genesys'), 'Genesys Cloud: routing, flows, APIs', 'stored trimmed');
    } finally {
      stores.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDomain: a missing or blank description fails loud and creates no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-create-domain-blank-'));
  const db = join(dir, 'domains', 'genesys', 'sterling.db');
  try {
    for (const bad of ['', '   ', undefined as unknown as string]) {
      assert.throws(() => createDomain('genesys', bad, db), /description/);
      assert.equal(existsSync(db), false, `no file after a refused create (${JSON.stringify(bad)})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDomain: refuses a domain whose store already exists, and leaves it untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-create-domain-exists-'));
  const db = join(dir, 'domains', 'genesys', 'sterling.db');
  try {
    createDomain('genesys', 'first', db);
    assert.throws(() => createDomain('genesys', 'second', db), /already exists/);
    const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: db }]);
    try {
      assert.equal(stores.domainDescription('genesys'), 'first');
    } finally {
      stores.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MountedStores: an EXISTING domain store with no description still mounts and is readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-domain-nodesc-'));
  const db = join(dir, 'domains', 'legacy', 'sterling.db');
  try {
    // a domain made before descriptions existed: a plain store, no meta row
    mkdirSync(dirname(db), { recursive: true });
    const seed = new SterlingStore(db);
    const r = seed.create(ref('domain:legacy'));
    seed.close();

    const stores = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'legacy', dbPath: db }]);
    try {
      assert.deepEqual(stores.domainNames(), ['legacy']);
      assert.equal(stores.domainDescription('legacy'), undefined, 'no description recorded');
      assert.equal(stores.get(r.id)?.id, r.id, 'its records are readable');
    } finally {
      stores.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MountedStores.domainDescription: an unmounted domain is refused, never answered as undefined', () => {
  const { stores, cleanup } = harness(['genesys']);
  try {
    assert.throws(() => stores.domainDescription('nope'), /not mounted/);
  } finally {
    cleanup();
  }
});

// -- read shares (board 675daf9d (b)) ------------------------------------------

const shareDec = (title: string, scope = 'project') => ({ ...env('decision', scope), title, statement: 'shareterm', alternatives_rejected: [], rationale: 'r' });

test('MountedStores.query read shares: the project gets ceil(0.6 x cap) when a domain matches; each store keeps its own order', () => {
  const { stores, cleanup } = harness(['alpha']);
  try {
    for (let i = 0; i < 15; i++) stores.create(shareDec(`p${i}`));
    for (let i = 0; i < 15; i++) stores.create(shareDec(`a${i}`, 'domain:alpha'));
    const got = stores.query({ rank_terms: ['shareterm'], cap: 10 });
    assert.equal(got.length, 10);
    assert.deepEqual(got.map((r) => r.scope), [...Array(6).fill('project'), ...Array(4).fill('domain:alpha')], 'project first, 6 + 4');
    const projectOwn = stores.project.query({ rank_terms: ['shareterm'], cap: 10 }).map((r) => r.id);
    assert.deepEqual(got.slice(0, 6).map((r) => r.id), projectOwn.slice(0, 6), "the project slice is the project store's own top 6");
    const alphaOwn = stores.querySource('alpha', { rank_terms: ['shareterm'], cap: 10 }).map((r) => r.id);
    assert.deepEqual(got.slice(6).map((r) => r.id), alphaOwn.slice(0, 4), "the domain slice is the domain store's own top 4");
  } finally {
    cleanup();
  }
});

test('MountedStores.query read shares: unused domain share spills back to the project', () => {
  const { stores, cleanup } = harness(['alpha', 'beta']);
  try {
    for (let i = 0; i < 15; i++) stores.create(shareDec(`p${i}`));
    stores.create(shareDec('a0', 'domain:alpha'));
    const got = stores.query({ rank_terms: ['shareterm'], cap: 10 });
    assert.deepEqual(got.map((r) => r.scope), [...Array(9).fill('project'), 'domain:alpha']);
  } finally {
    cleanup();
  }
});

test('MountedStores.query read shares: when only the project matches, the result is unchanged (the project fills the cap)', () => {
  const { stores, cleanup } = harness(['alpha']);
  try {
    for (let i = 0; i < 15; i++) stores.create(shareDec(`p${i}`));
    stores.create({ ...ref('domain:alpha') });
    const got = stores.query({ rank_terms: ['shareterm'], cap: 10 });
    assert.deepEqual(got.map((r) => r.id), stores.project.query({ rank_terms: ['shareterm'], cap: 10 }).map((r) => r.id));
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
  createDomain('genesys', 'shared genesys domain', sharedDomainDb);
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

// ------------------- cross-store link targets (Deepdots bug report 2026-07-14) -------------------
// addLink routes on the SOURCE id but must validate the TARGET mount-wide: promotion
// itself writes cross-store edges (supersedes / informed_by across project↔domain),
// so knowledge_link refusing that edge shape was a validation asymmetry, not policy.

const dec = (title: string) => ({ ...env('decision'), title, statement: 's', alternatives_rejected: [], rationale: 'r' });

test('addLink: a project-scoped source links a domain-scoped target — the edge shape promotion itself writes', () => {
  const { stores, cleanup } = harness(['genesys']);
  try {
    const source = stores.create(dec('project source'));
    const target = stores.create(ref('domain:genesys'));
    const updated = stores.addLink(source.id, 'cites', target.id);
    assert.ok(updated.links.some((l) => l.rel === 'cites' && l.target_id === target.id), 'cross-store edge recorded on the source');
    // the edge lives with its SOURCE, in the source's holding (project) store
    assert.ok(stores.project.get(source.id)!.links.some((l) => l.target_id === target.id), 'edge persisted in the project store');
  } finally {
    cleanup();
  }
});

test('addLink: a domain-scoped source links a project-scoped target (reverse direction)', () => {
  const { stores, cleanup } = harness(['genesys']);
  try {
    const source = stores.create(ref('domain:genesys'));
    const target = stores.create(dec('project target'));
    const updated = stores.addLink(source.id, 'cites', target.id);
    assert.ok(updated.links.some((l) => l.rel === 'cites' && l.target_id === target.id), 'domain→project edge recorded');
    // the edge lives with its SOURCE, in the domain store — never the project store
    assert.ok(!stores.project.get(source.id), 'the domain source stays out of the project store');
  } finally {
    cleanup();
  }
});

test('addLink: a target in NO mounted store is still rejected loudly', () => {
  const { stores, cleanup } = harness(['genesys']);
  try {
    const source = stores.create(dec('project source'));
    assert.throws(() => stores.addLink(source.id, 'cites', randomUUID()), /no target record/);
  } finally {
    cleanup();
  }
});

test('addLink: an existing identical cross-store edge dedups — source returned unchanged', () => {
  const { stores, cleanup } = harness(['genesys']);
  try {
    const source = stores.create(dec('project source'));
    const target = stores.create(ref('domain:genesys'));
    stores.addLink(source.id, 'cites', target.id);
    const again = stores.addLink(source.id, 'cites', target.id);
    assert.equal(again.links.filter((l) => l.rel === 'cites' && l.target_id === target.id).length, 1, 'no duplicate edge');
  } finally {
    cleanup();
  }
});

// ------------------- reviewer knowledge loop v2 (run r-d630, phase 1 — AC1) -------------------

// per-mount transaction routing via withTransactionForScope — RETIRED 2026-09-06, decision
// `domain-held-subject-queue-items-close-two-step-named-mount-refusal-on-every-lane-label-routed-transaction-retired`
// (knowledge_get f2c61919-59ca-482e-8fab-53a7ddf13a2f): the six tests that lived here covered a
// label-routed opener with zero production callers, retired outright rather than fixed.

test('withTransaction (pre-existing, project-only) still works unchanged — regression guard against withTransactionForScope replacing it', () => {
  const { stores, cleanup } = harness(['alpha']);
  try {
    let recId!: string;
    (stores as unknown as { withTransaction: (fn: () => void) => void }).withTransaction(() => {
      recId = stores.create(dec('legacy-withTransaction')).id;
    });
    // SABOTAGE: remove/rename the old withTransaction method while adding
    // withTransactionForScope -> TypeError instead of reaching this line.
    assert.ok(stores.project.get(recId), 'the pre-existing project-only withTransaction still works and still writes to the project store (used unchanged by knowledgeSplit)');
  } finally {
    cleanup();
  }
});

// The setRunReviewMandatory forwarding test that lived here was removed with
// the staged-pipeline run/handoff protocol (decision
// sterling-claude-code-scale-down-boundary, 2ad87dd1) — setRunReviewMandatory
// no longer exists on SterlingStore or MountedStores.
