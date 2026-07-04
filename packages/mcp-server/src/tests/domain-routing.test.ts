import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { MountedStores, resolveDomainMounts } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// The §10 tool surface over a MountedStores (project + one mounted domain): the
// tools are agnostic to mounting, so this pins that scope routing, cross-store
// retrieval, holding-store updates, and PROJECT-LOCAL run state all hold when
// the conductor drives them through SterlingTools (§3.3 / §3.4).
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-domain-'));
  const domainDb = join(dir, 'domains', 'genesys', 'sterling.db');
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: domainDb }]);
  const config = parseConfig({ stack_tags: ['genesys'] });
  const tools = new SterlingTools({ store, config, now: () => '2026-06-16T12:00:00.000Z', newId: randomUUID });
  return { dir, domainDb, store, tools, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const refFields = (scope: string) => ({
  scope,
  title: 'Genesys routing rule',
  kind: 'doc',
  location: 'docs/genesys.md',
  summary: 's',
  source_date: '2026-06-16',
  capture_date: '2026-06-16',
  basis: 'platform',
});

test('knowledge_create routes by scope through the tool surface; query/get span stores project-first (§3.3/§3.4)', () => {
  const { domainDb, store, tools, cleanup } = harness();
  try {
    const dec = tools.knowledgeCreate('decision', { title: 'project dec', statement: 's', alternatives_rejected: [], rationale: 'r' }).record;
    const ref = tools.knowledgeCreate('reference_material', refFields('domain:genesys')).record;

    // the domain store materialized on mount, and the domain record landed there — not in the project store
    assert.ok(existsSync(domainDb), 'domain store created on mount');
    assert.ok(store.project.get(dec.id), 'project-scoped decision lives in the project store');
    assert.equal(store.project.get(ref.id), undefined, 'domain-scoped reference is NOT in the project store');
    assert.equal(tools.knowledgeGet(ref.id).scope, 'domain:genesys', 'knowledge_get spans to the domain store');

    // retrieval fans across both, project-first
    const ids = tools.knowledgeQuery({ cap: 10 }).map((r) => r.id);
    assert.ok(ids.includes(dec.id) && ids.includes(ref.id), 'query spans project + domain');
    assert.ok(ids.indexOf(dec.id) < ids.indexOf(ref.id), 'project results rank ahead of domain (§3.3 bias)');
  } finally {
    cleanup();
  }
});

test('knowledge_update of a domain record supersedes IN the domain store; project store never gains it', () => {
  const { store, tools, cleanup } = harness();
  try {
    const ref = tools.knowledgeCreate('reference_material', refFields('domain:genesys')).record;
    const v2 = tools.knowledgeUpdate(ref.id, { summary: 'trued up' });

    assert.equal(v2.scope, 'domain:genesys', 'the new version stays domain-scoped');
    assert.equal((v2 as { summary: string }).summary, 'trued up');
    assert.equal(store.project.get(v2.id), undefined, 'the new version is not in the project store');
    assert.equal(store.project.get(ref.id), undefined, 'the superseded prior is not in the project store either');
    // the prior is retained (superseded) in the domain store, the new version is active there
    assert.equal(store.get(v2.id)?.status, 'active');
  } finally {
    cleanup();
  }
});

test('run protocol stays PROJECT-LOCAL through MountedStores: a run is created/advanced and lives only in the project store', () => {
  const { store, tools, cleanup } = harness();
  try {
    store.createRun({
      id: 'r-0001',
      brief_ref: randomUUID(),
      branch: 'sterling/run-r-0001',
      machine_state: 'running',
      phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
      dispatch_counts: {},
      escalations: [],
      started_at: '2026-06-10T12:00:00.000Z',
    });
    // delegated run reads resolve the active run via the project store
    assert.equal(tools.runState().id, 'r-0001');
    assert.ok(store.project.getRun(), 'the run record lives in the project store');

    // run-state forwards land in the project store, never a domain — H7 marks
    // reconcile_needed on the run through exactly this MountedStores forward.
    store.appendRunReconcileNeeded('r-0001', 'art-0001');
    assert.deepEqual(
      store.project.getRun('r-0001')!.reconcile_needed,
      ['art-0001'],
      'appendRunReconcileNeeded routes to the project store'
    );

    // a single-phase complete drives the brain to the completion sequence — all
    // run/transient writes (handoff, pending-exit, CAS) route to the project store
    tools.handoffWrite({
      handoff: {
        phase_id: 'p1', agent_role: 'coder',
        what_changed: [{ path: 'src/x.ts', change_role: 'implemented' }],
        wired: [], deferred: [], decisions_made: [], tests_produced: [],
        exit_signal: 'complete', unresolved: [],
      },
    });
    tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    const sig = tools.runSignal({});
    assert.equal(sig.action.action, 'complete_run');
    assert.equal(sig.machine_state, 'completing');
  } finally {
    cleanup();
  }
});

test('§3.3 project-store-then-promote: a project-scoped reference surfaces ONE promotion_review; domain-scoped and non-candidate types do not', () => {
  const { tools, cleanup } = harness();
  try {
    // project-scoped reference/research → domain-candidate → surfaces a promotion_review
    const ref = tools.knowledgeCreate('reference_material', refFields('project')).record;
    const research = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'genesys retry semantics?', answer: 'a', source_urls: ['https://x'], source_date: '2026-06-16', capture_date: '2026-06-16',
    }).record;
    // a reference already scoped to the domain is NOT a candidate (it is already shared)
    tools.knowledgeCreate('reference_material', refFields('domain:genesys'));
    // a non reference/research type is never a promotion candidate
    tools.knowledgeCreate('decision', { title: 'd', statement: 's', alternatives_rejected: [], rationale: 'r' });

    const reviews = tools.maintenanceQuery({ system_reason: 'promotion_review', cap: 100 });
    const links = reviews.map((r) => (r as { feature_link?: string }).feature_link).sort();
    assert.deepEqual(links, [ref.id, research.id].sort(), 'exactly the two project-scoped candidates surfaced, one item each');
  } finally {
    cleanup();
  }
});

test('§3.3 no domain mounted → no promotion noise: a project reference surfaces nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-nodomain-'));
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), []);
  const tools = new SterlingTools({ store, config: parseConfig({}), now: () => '2026-06-16T12:00:00.000Z', newId: randomUUID });
  try {
    tools.knowledgeCreate('reference_material', refFields('project'));
    assert.equal(tools.maintenanceQuery({ system_reason: 'promotion_review', cap: 100 }).length, 0, 'nowhere to promote → nothing surfaced');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§3.3 knowledge_promote: moves a project record into the domain store as a tombstone, draining its promotion_review', () => {
  const { store, tools, cleanup } = harness();
  try {
    const ref = tools.knowledgeCreate('reference_material', refFields('project')).record;
    const review = tools.maintenanceQuery({ system_reason: 'promotion_review', cap: 100 }).find((t) => (t as { feature_link?: string }).feature_link === ref.id);
    assert.ok(review, 'a project-scoped reference surfaced a promotion_review to drain');

    const out = tools.knowledgePromote(ref.id, 'genesys');

    // the promoted copy lives in the domain store, scoped + linked back to the origin
    assert.equal(out.promoted.scope, 'domain:genesys');
    assert.equal(store.project.get(out.promoted.id), undefined, 'the promoted copy is not in the project store');
    assert.equal(store.get(out.promoted.id)?.scope, 'domain:genesys');
    assert.ok(
      (out.promoted.links as { rel: string; target_id: string }[]).some((l) => l.rel === 'informed_by' && l.target_id === ref.id),
      'promoted copy is informed_by the origin'
    );

    // the project original is a superseded tombstone pointing forward — provenance survives
    const tomb = store.project.get(ref.id)!;
    assert.equal(tomb.status, 'superseded');
    assert.equal(tomb.superseded_by, out.promoted.id);

    // default retrieval drops the superseded original but serves the domain copy
    const served = tools.knowledgeQuery({ types: ['reference_material'], cap: 50 }).map((r) => r.id);
    assert.ok(!served.includes(ref.id), 'superseded project original is no longer served');
    assert.ok(served.includes(out.promoted.id), 'promoted domain copy is served');

    // promoting was the review outcome — its queue item drained
    assert.equal(out.drained_review, review.id);
    assert.equal(tools.maintenanceQuery({ system_reason: 'promotion_review', cap: 100 }).length, 0, 'the promotion_review was drained');
  } finally {
    cleanup();
  }
});

test('knowledge_promote refuses what §3.3 forbids: non-project scope, unpromotable type, unmounted domain (atomic)', () => {
  const { tools, cleanup } = harness();
  try {
    // feature_article is always project — never promotes
    const art = tools.knowledgeCreate('feature_article', {
      slug: 'x', title: 'x', what_it_does: 'x', intended_behavior: 'x', files: [{ path: 'src/x.ts', role: 'impl' }],
      current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }], dependencies: { relies_on: [], relied_by: [] },
      state: 'active', version: 1, history: [{ date: '2026-06-16T00:00:00.000Z', event: 'x' }], live_test_refs: [],
    }).record;
    assert.throws(() => tools.knowledgePromote(art.id, 'genesys'), /never promotes/);

    // a record already in a domain is not a candidate
    const dref = tools.knowledgeCreate('reference_material', refFields('domain:genesys')).record;
    assert.throws(() => tools.knowledgePromote(dref.id, 'genesys'), /only project-scoped/);

    // an unmounted target domain is rejected by store routing — and nothing is written
    const pref = tools.knowledgeCreate('reference_material', refFields('project')).record;
    assert.throws(() => tools.knowledgePromote(pref.id, 'fuel-prices'), /unmounted domain/);
    assert.equal(tools.knowledgeGet(pref.id).status, 'active', 'a failed promote leaves the original active and untouched');
  } finally {
    cleanup();
  }
});

test('maintenance_enqueue → board_remove lifecycle completes by id WITH a domain mounted (regression: todo b6fb321f)', () => {
  // The queue is PROJECT-LOCAL, but a system todo is created scope:project through
  // knowledgeCreate, so with a domain mounted the by-id paths (get/remove) must
  // still resolve it. The 2026-07-03 report of an unremovable item ('no record')
  // was a stale running MCP server predating the get/remove mount-fan; this pins
  // the whole create→find→remove cycle through the tool surface so it can't
  // silently regress. (§3.2.7 / §3.3)
  const { store, tools, cleanup } = harness();
  try {
    const item = tools.maintenanceEnqueue({ reason: 'capture_owed', text: 'stuck-item probe' }).record;
    assert.equal(item.scope, 'project', 'a maintenance item is project-scoped');
    assert.ok(store.project.get(item.id), 'it lives in the PROJECT store, not a domain');

    // query fans and finds it; the by-id paths must too, with the domain mounted
    assert.ok(
      tools.maintenanceQuery({ system_reason: 'capture_owed', cap: 100 }).some((t) => t.id === item.id),
      'maintenance_query surfaces the enqueued item'
    );
    assert.equal(tools.knowledgeGet(item.id).id, item.id, 'knowledge_get resolves it by id across mounts');

    // the lifecycle completes: board_remove by id succeeds and it leaves the queue
    assert.equal(tools.boardRemove(item.id).removed, item.id, 'board_remove removes it by id');
    assert.equal(
      tools.maintenanceQuery({ system_reason: 'capture_owed', cap: 100 }).filter((t) => t.id === item.id).length,
      0,
      'the item is gone from the queue after removal'
    );
    assert.equal(store.project.get(item.id), undefined, 'and gone from the project store');
  } finally {
    cleanup();
  }
});

test('§3.3 resolveDomainMounts: stack_tags ARE the mount manifest; default per-user root + per-tag domain_paths override', () => {
  // each stack tag mounts one store at the per-user root by default
  const def = resolveDomainMounts(parseConfig({ stack_tags: ['genesys', 'node'] }));
  assert.deepEqual(def.map((m) => m.name), ['genesys', 'node'], 'one mount per stack tag, in manifest order');
  assert.equal(def[0].dbPath, join(homedir(), '.sterling', 'domains', 'genesys', 'sterling.db'), 'default path is the per-user root');

  // config.domain_paths overrides the path for a named tag (spec line 94); others keep the default
  const ov = resolveDomainMounts(parseConfig({ stack_tags: ['genesys', 'node'], domain_paths: { genesys: 'D:/shared/genesys.db' } }));
  assert.equal(ov.find((m) => m.name === 'genesys')!.dbPath, 'D:/shared/genesys.db', 'per-tag override redirects the store');
  assert.equal(ov.find((m) => m.name === 'node')!.dbPath, join(homedir(), '.sterling', 'domains', 'node', 'sterling.db'), 'un-overridden tag keeps the default');

  // no stack tags → no mounts (single-store behaviour)
  assert.deepEqual(resolveDomainMounts(parseConfig({})), [], 'empty manifest mounts nothing');
});
