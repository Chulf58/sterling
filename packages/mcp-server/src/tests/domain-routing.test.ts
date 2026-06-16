import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountedStores } from '@sterling/store';
import { SterlingTools } from '../tools.js';

// The §10 tool surface over a MountedStores (project + one mounted domain): the
// tools are agnostic to mounting, so this pins that scope routing, cross-store
// retrieval, holding-store updates, and PROJECT-LOCAL run state all hold when
// the conductor drives them through SterlingTools (§3.3 / §3.4).
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-domain-'));
  const domainDb = join(dir, 'domains', 'genesys', 'sterling.db');
  const store = new MountedStores(join(dir, '.sterling', 'sterling.db'), [{ name: 'genesys', dbPath: domainDb }]);
  const tools = new SterlingTools({ store, now: () => '2026-06-16T12:00:00.000Z', newId: randomUUID });
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
