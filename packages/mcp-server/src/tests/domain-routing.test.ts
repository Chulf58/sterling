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

// === promote-metadata-sanitisation (board ff07e314, first half) ===
// knowledge_promote sanitises local scaffolding at the promotion boundary:
// file_keys are project-scoped and cannot mean anything in a shared per-user
// domain store; stack_tags are intersected with the target domain; suspicious
// project-local prose labels warn (never refuse). research_finding is used
// throughout (unlike reference_material, it legitimately carries file_keys —
// see the server.test.ts refusal pin cited in CLAUDE.md's per-type file-key
// table) and is a real promotion candidate per §3.3.

test('knowledge_promote drops file_keys at the promotion boundary — a repo-relative path is project-scoped and meaningless in a domain store', () => {
  const { store, tools, cleanup } = harness();
  try {
    const research = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'genesys retry semantics?', answer: 'a', source_urls: ['https://x'],
      source_date: '2026-06-16', capture_date: '2026-06-16',
      file_keys: ['packages/store/src/index.ts'],
    }).record;

    const out = tools.knowledgePromote(research.id, 'genesys');

    // hard pin: the domain copy carries NO origin file_keys. Sabotage: stop
    // sanitising file_keys on promote (pass `fields.file_keys` through
    // unchanged instead of dropping them) — this goes red.
    const domainRecord = store.get((out.promoted as { id: string }).id) as unknown as { file_keys?: string[] };
    assert.deepEqual(domainRecord.file_keys ?? [], [], 'no origin file_keys cross the promotion boundary');

    // disclosed: a dropped_file_keys count and/or a warning naming the drop.
    // Sabotage: drop file_keys silently (no disclosure) — this goes red.
    const disclosedCount = (out as unknown as { dropped_file_keys?: number }).dropped_file_keys;
    const warnings = (out as unknown as { warnings?: string[] }).warnings ?? [];
    assert.ok(
      disclosedCount === 1 || warnings.some((w) => /file_keys/i.test(w)),
      'the file_keys drop is disclosed on the result, not silent'
    );
  } finally {
    cleanup();
  }
});

test('knowledge_promote CONTROL: stack_tags already scoped to exactly the target domain promote unchanged, nothing disclosed as dropped', () => {
  const { store, tools, cleanup } = harness();
  try {
    const research = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'q', answer: 'a', source_urls: ['https://x'],
      source_date: '2026-06-16', capture_date: '2026-06-16', stack_tags: ['genesys'],
    }).record;

    const out = tools.knowledgePromote(research.id, 'genesys');

    const domainRecord = store.get((out.promoted as { id: string }).id) as unknown as { stack_tags: string[] };
    assert.deepEqual(domainRecord.stack_tags, ['genesys'], 'tags exactly matching the domain promote unchanged');

    // control for the NEXT test: with nothing dropped, nothing is disclosed as
    // dropped. Sabotage: unconditionally report a stack_tags drop — this goes red.
    const warnings = (out as unknown as { warnings?: string[] }).warnings ?? [];
    const droppedTags = (out as unknown as { dropped_stack_tags?: string[] }).dropped_stack_tags;
    assert.ok(!warnings.some((w) => /stack_tag/i.test(w)), 'no tag-drop warning when nothing was dropped');
    assert.ok(droppedTags === undefined || droppedTags.length === 0, 'no dropped_stack_tags when nothing was dropped');
  } finally {
    cleanup();
  }
});

test('knowledge_promote intersects stack_tags with the target domain — non-domain tags drop, the domain tag survives regardless of order', () => {
  const { store, tools, cleanup } = harness();
  try {
    const a = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'q1', answer: 'a', source_urls: ['https://x'],
      source_date: '2026-06-16', capture_date: '2026-06-16', stack_tags: ['genesys', 'sterling'],
    }).record;
    const b = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'q2', answer: 'a', source_urls: ['https://x'],
      source_date: '2026-06-16', capture_date: '2026-06-16', stack_tags: ['sterling', 'genesys'],
    }).record;

    const outA = tools.knowledgePromote(a.id, 'genesys');
    const outB = tools.knowledgePromote(b.id, 'genesys');

    // hard pin: only the target-domain tag survives, in BOTH orderings —
    // sabotage: copy stack_tags through verbatim instead of intersecting with
    // [domain] (this goes red), and a second sabotage that keeps only
    // stack_tags[0] instead of really intersecting is caught by the reversed
    // ordering in `b` (it would keep 'sterling' there, not 'genesys').
    const recA = store.get((outA.promoted as { id: string }).id) as unknown as { stack_tags: string[] };
    const recB = store.get((outB.promoted as { id: string }).id) as unknown as { stack_tags: string[] };
    assert.deepEqual(recA.stack_tags, ['genesys'], 'only the domain tag survives (domain tag listed first)');
    assert.deepEqual(recB.stack_tags, ['genesys'], 'only the domain tag survives (domain tag listed second)');

    // disclosed: dropped ('sterling') and kept ('genesys') are both named.
    // Sabotage: intersect correctly but never disclose the drop — this goes red.
    const text = JSON.stringify(outA);
    assert.match(text, /sterling/, 'the dropped tag is named in the disclosure');
  } finally {
    cleanup();
  }
});

test('knowledge_promote CONTROL: clean, portable prose promotes with no project-local-label warning', () => {
  const { tools, cleanup } = harness();
  try {
    const research = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'q',
      answer: 'SQLite WAL mode allows concurrent readers during a writer transaction; see sqlite.org docs for the durability tradeoffs.',
      source_urls: ['https://sqlite.org'], source_date: '2026-06-16', capture_date: '2026-06-16',
    }).record;

    const out = tools.knowledgePromote(research.id, 'genesys');

    // control for the next test: portable prose never trips the scan. Sabotage:
    // warn unconditionally on every promote — this goes red.
    const warnings = (out as unknown as { warnings?: string[] }).warnings ?? [];
    assert.ok(
      !warnings.some((w) => /\bS\d+\b/.test(w) || /project.local/i.test(w) || /packages\//.test(w)),
      'portable prose triggers no suspicious-label warning'
    );
  } finally {
    cleanup();
  }
});

test('knowledge_promote WARN-ONLY: a project-local slice label / repo-relative path in the prose warns but still promotes (never a refusal)', () => {
  const { tools, cleanup } = harness();
  try {
    const research = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'q',
      answer: 'Net guidance for S1: retry with backoff; see packages/store/src/index.ts for the write path.',
      source_urls: ['https://x'], source_date: '2026-06-16', capture_date: '2026-06-16',
    }).record;

    // hard pin #1: promotion SUCCEEDS despite the suspicious label — sabotage:
    // turn the warn into a refusal (throw on a flagged label) — this goes red.
    const out = tools.knowledgePromote(research.id, 'genesys');
    assert.equal((out.promoted as { scope: string }).scope, 'domain:genesys', 'promotion succeeded — warn-only, never a refusal');

    // hard pin #2: the warning fires and names what tripped it — sabotage:
    // remove the suspicious-label scan (never populate `warnings`) — this goes red.
    const warnings = (out as unknown as { warnings?: string[] }).warnings ?? [];
    assert.ok(
      warnings.some((w) => /\bS1\b/.test(w) || /packages\/store\/src\/index\.ts/.test(w)),
      'the warning names the flagged label or path'
    );
  } finally {
    cleanup();
  }
});

test('knowledge_promote server-boundary receipt defaults to a slim digest (disclosures included, body dropped); projection:"full" opts back in (board 7ddf13a7 pattern)', () => {
  const { tools, cleanup } = harness();
  try {
    const bigAnswer = `Net guidance for S1: ${'x'.repeat(3000)}`;

    const r1 = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'q1', answer: bigAnswer, source_urls: ['https://x'],
      source_date: '2026-06-16', capture_date: '2026-06-16',
      file_keys: ['packages/store/src/index.ts'], stack_tags: ['genesys', 'sterling'],
    }).record;

    // DEFAULT — no projection argument passed to writeProjected — is the slim
    // digest (board 7ddf13a7's write-tool convention). Sabotage: default the
    // receipt projection to 'full' instead of 'digest' — this goes red (the
    // 3KB body would be re-echoed).
    const digested = tools.writeProjected(tools.knowledgePromote(r1.id, 'genesys')) as unknown;
    assert.ok(
      JSON.stringify(digested).length < bigAnswer.length,
      'the digest receipt does not re-echo the body the caller just promoted'
    );
    assert.ok(
      Array.isArray((digested as { warnings?: unknown[] }).warnings),
      'the disclosure/warnings channel survives the digest projection'
    );

    // projection:'full' opts back into the whole record — sabotage: ignore the
    // projection argument (always digest) — this goes red.
    const r2 = tools.knowledgeCreate('research_finding', {
      scope: 'project', question: 'q2', answer: bigAnswer, source_urls: ['https://x'],
      source_date: '2026-06-16', capture_date: '2026-06-16',
    }).record;
    const full = tools.writeProjected(tools.knowledgePromote(r2.id, 'genesys'), 'full') as unknown;
    assert.ok(JSON.stringify(full).includes(bigAnswer), 'projection:"full" opts back into the whole promoted record');
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
