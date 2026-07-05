import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DurableRecord } from '@sterling/schemas';
import { REVIEWER_ROLES } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { SterlingTools, type NoteExtractionPayload } from '../tools.js';

const NOW = '2026-06-10T12:00:00.000Z';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tools-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const tools = new SterlingTools({ store, now: () => NOW });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { store, tools, cleanup };
}

function startRun(store: SterlingStore, phases = ['p1', 'p2']) {
  return store.createRun({
    id: 'r-0001',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-0001',
    machine_state: 'running',
    phases: phases.map((id, i) => ({ id, status: i === 0 ? 'in_progress' : 'pending', signals: [], commits: [] })),
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });
}

test('knowledge_create assembles the envelope server-side and emits check_skipped (never silent — §16.1.9)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record, check_skipped } = tools.knowledgeCreate('decision', {
      title: 'Use SQLite',
      statement: 'SQLite it is.',
      alternatives_rejected: [],
      rationale: 'Fits the criteria.',
      stack_tags: ['node'],
    });
    assert.equal(record.type, 'decision');
    assert.equal(record.status, 'active');
    assert.equal(record.author, 'conductor');
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(check_skipped, [{ check: 'dedup-merge', reason: 'not_built' }]);
    assert.throws(() => tools.knowledgeCreate('escalation_log', { title: 'x' }), /unregistered record type/);
  } finally {
    cleanup();
  }
});

test('note_remove deletes a note outright and refuses non-notes; inbound cites survive (§3.2.6)', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: note } = tools.knowledgeCreate('note', {
      raw_text: 'a user note, later spent',
      captured_at: NOW,
      capture_source: 'tui',
      derived: [],
    });
    const { record: extraction } = tools.knowledgeCreate('decision', {
      title: 'extracted',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
      links: [{ rel: 'cites', target_id: note.id }],
    });
    const { record: keeper } = tools.knowledgeCreate('note', {
      raw_text: 'another note that stays',
      captured_at: NOW,
      capture_source: 'command',
      derived: [],
    });

    assert.throws(() => tools.noteRemove(extraction.id), /not a note/);
    assert.throws(() => tools.noteRemove(randomUUID()), /no record/);

    assert.deepEqual(tools.noteRemove(note.id), { removed: note.id });
    assert.throws(() => tools.knowledgeGet(note.id), /no record/, 'the note is gone, not superseded');
    assert.deepEqual(
      tools.knowledgeQuery({ types: ['note'] }).map((r) => r.id),
      [keeper.id],
      'only the removed note left the Notes surface'
    );
    const survivor = tools.knowledgeGet(extraction.id);
    assert.ok(survivor.links.some((l) => l.rel === 'cites' && l.target_id === note.id), 'extraction stands alone with its cite intact');
  } finally {
    cleanup();
  }
});

test('knowledge_update writes a new version and supersedes the prior; article version auto-bumps', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: v1 } = tools.knowledgeCreate('feature_article', {
      slug: 'csv-export',
      title: 'CSV export',
      what_it_does: 'Exports the board.',
      intended_behavior: 'User clicks Export and gets a file.',
      files: [{ path: 'src/export/csv.ts', role: 'serializer' }],
      current_ac: [{ ac_id: 'AC1', text: 'export works', verifiable_at: 'final' }],
      dependencies: { relies_on: [], relied_by: [] },
      state: 'active',
      version: 1,
      history: [{ date: NOW, event: 'originating brief' }],
      live_test_refs: [],
    });
    const v2 = tools.knowledgeUpdate(v1.id, { what_it_does: 'Exports the board with headers.' });
    assert.equal((v2 as { version: number }).version, 2, 'version auto-bumped');
    assert.equal(tools.knowledgeGet(v1.id).status, 'superseded', 'prior retained and flagged');
    assert.ok(v2.links.some((l) => l.rel === 'supersedes' && l.target_id === v1.id));
    assert.equal(tools.knowledgeQuery({ types: ['feature_article'] }).length, 1, 'only current version retrieved');
  } finally {
    cleanup();
  }
});

const mkArticle = (tools: SterlingTools, slug: string, path: string) =>
  tools.knowledgeCreate('feature_article', {
    slug,
    title: slug,
    what_it_does: 'does',
    intended_behavior: 'b',
    files: [{ path, role: 'impl' }],
    current_ac: [],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
  }).record;

test('knowledge_update drains the article\'s drift maintenance items (reconcile_needed/refresh_reference) but never promotion_review — P4 lifecycle-bind', () => {
  const { tools, cleanup } = harness();
  try {
    const article = mkArticle(tools, 'thing', 'src/thing.ts');
    const other = mkArticle(tools, 'other', 'src/other.ts');
    // drift debt for `thing` the conductor is about to reconcile, a human-gated
    // promotion review for `thing`, and unrelated drift debt for `other`.
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: `reconcile 'thing'`, file_keys: ['src/thing.ts'], feature_link: article.id });
    tools.maintenanceEnqueue({ reason: 'refresh_reference', text: `refresh 'thing'`, file_keys: ['src/thing.ts'], feature_link: article.id });
    tools.maintenanceEnqueue({ reason: 'promotion_review', text: `promote 'thing'`, feature_link: article.id });
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: `reconcile 'other'`, file_keys: ['src/other.ts'], feature_link: other.id });
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 4);

    tools.knowledgeUpdate(article.id, { what_it_does: 'does, now reconciled' });

    const open = tools.maintenanceQuery({ cap: 1000 });
    const has = (reason: string, link: string) =>
      open.some((t) => (t as { system_reason?: string }).system_reason === reason && (t as { feature_link?: string }).feature_link === link);
    assert.equal(has('reconcile_needed', article.id), false, 'reconcile_needed drained by the reconcile');
    assert.equal(has('refresh_reference', article.id), false, 'refresh_reference drained by the reconcile');
    assert.equal(has('promotion_review', article.id), true, 'promotion_review survives — promotion is a human gate (P1)');
    assert.equal(has('reconcile_needed', other.id), true, "an unrelated article's debt is untouched");
  } finally {
    cleanup();
  }
});

test('knowledge_update drains a drift item whose feature_link points to an ANCESTOR version (supersede-chain match)', () => {
  const { tools, cleanup } = harness();
  try {
    const v1 = mkArticle(tools, 'thing', 'src/thing.ts');
    const v2 = tools.knowledgeUpdate(v1.id, { what_it_does: 'v2' });
    // an item raised against the now-superseded v1 (a flag that lagged a version);
    // reconciling v2→v3 must still drain it via the supersede chain.
    tools.maintenanceEnqueue({ reason: 'reconcile_needed', text: `reconcile 'thing'`, file_keys: ['src/thing.ts'], feature_link: v1.id });
    tools.knowledgeUpdate(v2.id, { what_it_does: 'v3' });
    assert.equal(tools.maintenanceQuery({ cap: 1000 }).length, 0, 'ancestor-linked drift item drained via the chain');
  } finally {
    cleanup();
  }
});

test('board tools: add/query separates board from maintenance queue; remove is todo-only', () => {
  const { tools, cleanup } = harness();
  try {
    const { record: userTodo } = tools.boardAdd({ text: 'ship csv export', source: 'user', priority: 'high' });
    tools.boardAdd({ text: 'reconcile auth article', source: 'system', system_reason: 'reconcile_needed' });
    assert.equal(tools.boardQuery({}).length, 2);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 1, 'board view filters user');
    assert.equal(tools.boardQuery({ source: 'system' }).length, 1, 'maintenance queue is source=system');
    assert.throws(() => tools.boardAdd({ text: 'x', source: 'system' }), /system_reason/);

    const { record: d } = tools.knowledgeCreate('decision', {
      title: 't',
      statement: 's',
      alternatives_rejected: [],
      rationale: 'r',
    });
    assert.throws(() => tools.boardRemove(d.id), /not a todo/);
    const res = tools.boardRemove(userTodo.id);
    assert.deepEqual(res.check_skipped, [{ check: 'board-remove-artifact-binding', reason: 'not_built' }]);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0);
  } finally {
    cleanup();
  }
});

test('stale-at-read (§3.4): research findings get both clocks + flag; platform basis gets verify_before_use', () => {
  const { tools, cleanup } = harness();
  try {
    const mk = (over: Record<string, unknown>) =>
      tools.knowledgeCreate('research_finding', {
        question: `q-${Math.random()}`,
        answer: 'a',
        source_urls: [],
        source_date: '2026-05-20',
        capture_date: '2026-06-01',
        ...over,
      });
    mk({ volatility_hint: 'stable', question: 'fresh-stable' });
    mk({ source_date: '2026-01-15', volatility_hint: 'medium', question: 'old-medium' });
    const served = tools.knowledgeQuery({ types: ['research_finding'], cap: 10 }) as unknown as {
      question: string;
      staleness: { stale: boolean; source_age_days: number; note?: string };
    }[];
    const fresh = served.find((r) => r.question === 'fresh-stable')!;
    const old = served.find((r) => r.question === 'old-medium')!;
    assert.equal(fresh.staleness.stale, false);
    assert.equal(old.staleness.stale, true, 'born from an old source on a medium topic = stale at first read');
    assert.match(old.staleness.note!, /re-verify/);
    assert.equal(typeof old.staleness.source_age_days, 'number');

    tools.knowledgeCreate('reference_material', {
      title: 'old platform doc',
      kind: 'url',
      location: 'https://x',
      summary: 's',
      source_date: '2025-01-01',
      capture_date: '2025-01-01',
      basis: 'platform',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    });
    const refs = tools.knowledgeQuery({ types: ['reference_material'], cap: 10 }) as unknown as { verify_before_use?: boolean }[];
    assert.equal(refs[0].verify_before_use, true, 'wrong old knowledge is worse than no knowledge');
  } finally {
    cleanup();
  }
});

test('dedup guard (§3.2.2): an overlapping anti_pattern is REFUSED naming the match — the author merges via knowledge_update or stores with dedup_override', () => {
  const { tools, cleanup } = harness();
  try {
    const first = tools.knowledgeCreate('anti_pattern', {
      title: 'No raw SQL concatenation',
      trigger: 'building queries from user input',
      guidance: 'parameterize',
      wrong_way: 'concat',
      right_way: 'prepare',
      source_evidence: 'run r-1, src/db.ts:10',
      file_keys: ['src/db.ts'],
    });
    // a genuine restatement (strong token overlap + shared key) is refused loudly, never silently merged
    const restatement = {
      title: 'SQL concatenation strikes again',
      trigger: 'queries from user input',
      guidance: 'parameterize',
      wrong_way: 'concat',
      right_way: 'prepare',
      source_evidence: 'run r-2, src/api.ts:44',
      file_keys: ['src/db.ts'],
    };
    assert.throws(() => tools.knowledgeCreate('anti_pattern', restatement), new RegExp(first.record.id), 'the refusal names the match');
    assert.throws(() => tools.knowledgeCreate('anti_pattern', restatement), /dedup_override/, 'the refusal teaches the distinct-lesson verb');
    assert.equal(tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 }).length, 1, 'a refused create writes nothing — no version bump, no new record');

    // same-finding verb: the author merges evidence through knowledge_update
    const prior = tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 })[0] as unknown as { source_evidence: string };
    tools.knowledgeUpdate(first.record.id, { source_evidence: `${prior.source_evidence}\n${restatement.source_evidence}` });
    const active = tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 });
    assert.equal(active.length, 1);
    const evidence = (active[0] as unknown as { source_evidence: string }).source_evidence;
    assert.ok(evidence.includes('run r-1') && evidence.includes('run r-2'), 'evidence merged into the surviving record');

    // distinct-lesson verb: dedup_override stores it, and the directive is never persisted
    const overridden = tools.knowledgeCreate('anti_pattern', { ...restatement, dedup_override: true });
    assert.equal((overridden.record as unknown as Record<string, unknown>).dedup_override, undefined, 'dedup_override is a create-time directive, not a field');
    assert.equal(tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 }).length, 2);
  } finally {
    cleanup();
  }
});

test('dedup guard Dice threshold (§3.2.2): strong token overlap refuses naming the match; shared domain words alone do not', () => {
  const { tools, cleanup } = harness();
  try {
    // no file_keys → matching is purely token-based (Dice coefficient over title+trigger)
    const base = tools.knowledgeCreate('anti_pattern', {
      title: 'Power Automate apply-to-each swallows errors',
      trigger: 'apply to each over a large array without concurrency control',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'run r-base',
    });

    // a genuine restatement of the SAME gotcha — high token overlap (Dice >= 0.5) → refused naming the match
    assert.throws(
      () =>
        tools.knowledgeCreate('anti_pattern', {
          title: 'Power Automate apply-to-each swallows errors silently',
          trigger: 'apply to each over a large array without concurrency',
          guidance: 'g',
          wrong_way: 'w',
          right_way: 'r',
          source_evidence: 'run r-restate',
        }),
      new RegExp(base.record.id),
      'a genuine restatement is refused on strong token overlap'
    );

    // a DIFFERENT gotcha sharing only domain words ("power","automate") — Dice < 0.5 → distinct.
    // The prior `shared >= 2` gate wrongly collapsed these same-domain findings.
    const other = tools.knowledgeCreate('anti_pattern', {
      title: 'Power Automate connection references expire after tenant migration',
      trigger: 'reusing exported connection references across environments',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'run r-other',
    });
    assert.ok(other.record.id, 'shared domain words alone must not flag distinct gotchas');

    assert.equal(tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 }).length, 2, 'restatement refused; distinct gotcha stands alone');
  } finally {
    cleanup();
  }
});

test('dedup guard (board 3f9591e9 replay): one shared file_key never swallows a distinct lesson; the key-assist tier still flags look-alikes; validation precedes dedup', () => {
  const { tools, cleanup } = harness();
  try {
    const machineFlip = tools.knowledgeCreate('anti_pattern', {
      title: 'Machine-context flip leaves installed agent hooks dead — sync-agents reports up_to_date',
      trigger: 'running sessions from a machine context other than the one that last installed or synced the agents',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'run r-ea9e, 2026-07-03',
      file_keys: ['scripts/lib/agent-distribution.mjs'],
    });

    // the 2026-07-04 incident, replayed: a DISTINCT lesson sharing ONE busy file_key,
    // near-zero token overlap → stores directly (the old hard key signal swallowed it)
    const distinct = tools.knowledgeCreate('anti_pattern', {
      title: 'Wiring a formerly-inert config field to authoritative without migrating live values silently reverts policy',
      trigger: 'promoting a config declaration to the source of truth while gitignored configs carry stale values',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'conductor-direct 2026-07-04',
      file_keys: ['scripts/lib/agent-distribution.mjs'],
    });
    assert.ok(distinct.record.id, 'a shared file_key alone never swallows a distinct lesson');
    assert.equal(tools.knowledgeQuery({ types: ['anti_pattern'], cap: 10 }).length, 2);

    // the ASSIST tier: shared key + moderate token overlap (0.3 <= Dice < 0.5) still flags…
    const lookAlike = {
      title: 'Machine context flip breaks hook execution for installed agents',
      trigger: 'agents installed by another launcher fail their hook commands at sessions',
      guidance: 'g',
      wrong_way: 'w',
      right_way: 'r',
      source_evidence: 'probe',
      file_keys: ['scripts/lib/agent-distribution.mjs'],
    };
    assert.throws(() => tools.knowledgeCreate('anti_pattern', lookAlike), new RegExp(machineFlip.record.id), 'shared key + look-alike tokens still flags the match');
    // …and is key-driven: the same tokens WITHOUT the shared key stay below the standalone threshold
    const noSharedKey = tools.knowledgeCreate('anti_pattern', { ...lookAlike, file_keys: ['scripts/other.mjs'] });
    assert.ok(noSharedKey.record.id, 'the assist tier is key-driven — no shared key, no flag at moderate overlap');

    // validation precedes dedup: a schema-invalid candidate that WOULD overlap gets the schema error, not a dedup refusal
    assert.throws(
      () =>
        tools.knowledgeCreate('anti_pattern', {
          title: 'Machine-context flip leaves installed agent hooks dead — sync-agents reports up_to_date',
          trigger: 'running sessions from a machine context other than the one that last installed or synced the agents',
          guidance: 'g',
          wrong_way: 'w',
          right_way: 'r',
          file_keys: ['scripts/lib/agent-distribution.mjs'],
        }),
      /source_evidence/,
      'schema validation runs before the dedup guard'
    );
  } finally {
    cleanup();
  }
});

test('knowledge_link, run_escalate, maintenance queue tools (§10)', () => {
  const { store, tools, cleanup } = harness();
  try {
    const { record: a } = tools.knowledgeCreate('decision', { title: 'a', statement: 's', alternatives_rejected: [], rationale: 'r' });
    const { record: b } = tools.knowledgeCreate('note', { raw_text: 'context note', captured_at: NOW, capture_source: 'conductor', derived: [] });
    const linked = tools.knowledgeLink(a.id, 'informed_by', b.id);
    assert.ok(linked.links.some((l) => l.rel === 'informed_by' && l.target_id === b.id));
    assert.throws(() => tools.knowledgeLink(a.id, 'replaces', b.id), /invalid/i, 'rel is the closed §3.2 set');
    assert.throws(() => tools.knowledgeLink(a.id, 'cites', randomUUID()), /no target record/);

    startRun(store);
    const esc = tools.runEscalate({ kind: 'plan-broken', detail: 'assumption X contradicted' });
    assert.equal(esc.escalations, 1);

    const { record: item } = tools.maintenanceEnqueue({ reason: 'stale_research', text: 're-verify genesys limits' });
    assert.equal((item as { source: string }).source, 'system');
    assert.equal(tools.maintenanceQuery({ system_reason: 'stale_research' }).length, 1);
    assert.equal(tools.maintenanceQuery({ system_reason: 'capture_owed' }).length, 0);
    assert.equal(tools.boardQuery({ source: 'user' }).length, 0, 'maintenance items never pollute the user board');
  } finally {
    cleanup();
  }
});

test('agent_exit: in-band rejection of non-enum signals; valid exit lands on the run record (§5.2)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'victory' }), /enum is closed/);
    const { recorded } = tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    assert.equal(recorded.signal, 'complete');
    assert.equal(store.getPendingExit('r-0001')!.phase_id, 'p1');
    assert.throws(
      () => tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'blocked', payload: { reason: 'second exit' } }),
      /unconsumed exit/,
      'a second exit before run_signal is a protocol violation'
    );
  } finally {
    cleanup();
  }
});

test('agent_exit: a phase_id not on the active run is refused at RECORD time — nothing enters the slot (board 7d051522)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    // the 2026-07-03 incident: a conductor-direct subagent's exit bound to the
    // active run with a phase that does not exist, wedging the wire for the
    // whole phase. The seam must fail HERE, loudly, with nothing recorded.
    assert.throws(
      () => tools.agentExit({ phase_id: 'conductor-direct', agent_role: 'reviewer-correctness', signal: 'complete', payload: { handoff_ref: 'x/y' } }),
      /no phase 'conductor-direct' on run 'r-0001'.*phases: p1/s,
      'unknown phase refused, run phases named'
    );
    assert.equal(store.getPendingExit('r-0001'), undefined, 'nothing recorded — the slot stays empty');
    // abnormal signals with a bogus phase are refused the same way (never wedged)
    assert.throws(
      () => tools.agentExit({ phase_id: 'nope', agent_role: 'coder', signal: 'blocked', payload: { reason: 'r' } }),
      /no phase 'nope'/
    );
    // a valid phase still records exactly as before
    const { recorded } = tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    assert.equal(recorded.phase_id, 'p1');
  } finally {
    cleanup();
  }
});

test('run_signal: reads the stored exit, applies the CAS transition, advances phases', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    tools.agentExit({ phase_id: 'p1', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p1/coder' } });
    const r1 = tools.runSignal();
    assert.deepEqual(r1.action, { action: 'spawn', phase_id: 'p2', respawn: false });
    const after = tools.runState();
    assert.equal(after.phases[0].status, 'complete');
    assert.equal(after.phases[1].status, 'in_progress');
    assert.equal(after.phases[0].signals.length, 1);
    assert.equal(store.getPendingExit('r-0001'), undefined, 'exit consumed');

    // final phase → completing + complete_run
    tools.agentExit({ phase_id: 'p2', agent_role: 'coder', signal: 'complete', payload: { handoff_ref: 'p2/coder' } });
    const r2 = tools.runSignal();
    assert.equal(r2.action.action, 'complete_run');
    assert.equal(tools.runState('r-0001').machine_state, 'completing');
  } finally {
    cleanup();
  }
});

test('run_signal: conductor-reported agent-died, respawn then death cap; no exit at all is guided', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.runSignal(), /no exit recorded.*agent-died/s);
    const died = { signal: 'agent-died', phase_id: 'p1', payload: { observed: 'crash' as const } };
    const r1 = tools.runSignal({ exit: died });
    assert.equal(r1.action.action, 'spawn');
    assert.equal((r1.action as { respawn: boolean }).respawn, true);
    assert.equal(tools.runState().phases[0].status, 'in_progress', 'respawn keeps the phase open');

    const r2 = tools.runSignal({ exit: { ...died, payload: { observed: 'empty_output' } } });
    assert.equal(r2.action.action, 'judgment_needed');
    assert.equal(tools.runState().escalations.length, 1, 'escalation recorded on the run record');
  } finally {
    cleanup();
  }
});

test('run_signal: unknown signal reaching the brain halts the run loudly and durably (P5)', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const r = tools.runSignal({ exit: { signal: 'garbage', phase_id: 'p1' } });
    assert.equal(r.action.action, 'halt');
    assert.equal(tools.runState('r-0001').machine_state, 'halted');
  } finally {
    cleanup();
  }
});

test('handoff pair: write validates, read filters by phase and files', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    assert.throws(() => tools.handoffWrite({ handoff: { phase_id: 'p1' } }), /invalid/i);
    tools.handoffWrite({
      handoff: {
        phase_id: 'p1',
        agent_role: 'coder',
        what_changed: [{ path: 'src\\a.ts', change_role: 'implemented' }],
        wired: [],
        deferred: [],
        decisions_made: [],
        tests_produced: [],
        exit_signal: 'complete',
        unresolved: [],
      },
    });
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 1);
    assert.equal(tools.handoffRead({ files: ['src/a.ts'] }).length, 1);
    assert.equal(tools.handoffRead({ phase_id: 'p2' }).length, 0);
  } finally {
    cleanup();
  }
});

// --------------------------- AC2: reviewer disposition coverage enforcement (run r-d630 phase 2) ---------------------------
// A reviewer-role handoff_write must disposition EXACTLY the record_ids the run
// record's review_mandatory holds for that handoff's phase — set equality. A
// missing or extra id refuses the write LOUDLY, naming the offending ids, and
// nothing is persisted. Non-reviewer roles are entirely unaffected. Placement
// mirrors the 32fa4a05 agent_exit off-run-phase refusal (fail-loud at the seam,
// nothing written). REVIEWER_ROLES is imported, never redefined (invariant 1).

// The four exact agent_role strings the reviewer templates emit — pinned here so
// the wire is proven to fire for exactly these and no others (the free-string
// hole is left to the phase-3 disposal-fold backstop per decision 628c4b7f).
const REVIEWER_ROLE_STRINGS = ['reviewer-correctness', 'reviewer-security', 'reviewer-performance', 'reviewer-skeptic'] as const;

type Disposition = { record_id: string; disposition: 'addressed' | 'not_applicable_because'; reason?: string };

const handoffArgs = (agent_role: string, phase_id: string, dispositions?: Disposition[]) => ({
  handoff: {
    phase_id,
    agent_role,
    what_changed: [],
    wired: [],
    deferred: [],
    decisions_made: [],
    tests_produced: [],
    exit_signal: 'complete',
    unresolved: [],
    ...(dispositions ? { dispositions } : {}),
  },
});

test('AC2: the enforced reviewer role strings are exactly REVIEWER_ROLES — the wire fires for these four and no others', () => {
  // The pinned template strings and the imported registry must set-equal; if a
  // template role were renamed or a fifth reviewer added, this fails loudly.
  assert.deepEqual([...REVIEWER_ROLES].sort(), [...REVIEWER_ROLE_STRINGS].sort());
});

test('AC2: a reviewer handoff without exact review_mandatory coverage is REFUSED loudly (missing/extra ids named) with nothing written — all four roles', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const m1 = randomUUID();
    const m2 = randomUUID();
    const extra = randomUUID();

    for (const role of REVIEWER_ROLE_STRINGS) {
      // replace-by-phase: p1 requires exactly {m1, m2}
      store.setRunReviewMandatory('r-0001', 'p1', [
        { record_id: m1, reason: 'blocking anti-pattern' },
        { record_id: m2, reason: 'blocking anti-pattern' },
      ]);

      // (a) no dispositions at all → both mandatory ids missing, both named
      assert.throws(
        () => tools.handoffWrite(handoffArgs(role, 'p1')),
        (err: Error) => new RegExp(m1).test(err.message) && new RegExp(m2).test(err.message) && /missing/i.test(err.message),
        `${role}: empty dispositions refused, both missing ids named`
      );

      // (b) partial coverage → the one uncovered id is named as missing
      assert.throws(
        () => tools.handoffWrite(handoffArgs(role, 'p1', [{ record_id: m1, disposition: 'addressed' }])),
        (err: Error) => new RegExp(m2).test(err.message) && /missing/i.test(err.message),
        `${role}: partial coverage refused, the missing id named`
      );

      // (c) superset → the id not in the mandatory set is named as extra
      assert.throws(
        () =>
          tools.handoffWrite(
            handoffArgs(role, 'p1', [
              { record_id: m1, disposition: 'addressed' },
              { record_id: m2, disposition: 'addressed' },
              { record_id: extra, disposition: 'addressed' },
            ])
          ),
        (err: Error) => new RegExp(extra).test(err.message) && /extra/i.test(err.message),
        `${role}: superset refused, the extra id named`
      );
    }

    // every refused write persisted NOTHING (the seam refuses before writing)
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 0, 'no refused reviewer handoff was persisted');
  } finally {
    cleanup();
  }
});

test('AC2: a reviewer handoff with EXACT coverage lands — any mix of addressed / not_applicable_because+reason — all four roles', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const m1 = randomUUID();
    const m2 = randomUUID();
    store.setRunReviewMandatory('r-0001', 'p1', [
      { record_id: m1, reason: 'blocking anti-pattern' },
      { record_id: m2, reason: 'blocking anti-pattern' },
    ]);
    for (const role of REVIEWER_ROLE_STRINGS) {
      assert.doesNotThrow(
        () =>
          tools.handoffWrite(
            handoffArgs(role, 'p1', [
              { record_id: m1, disposition: 'addressed' },
              { record_id: m2, disposition: 'not_applicable_because', reason: 'out of scope for this surface' },
            ])
          ),
        `${role}: exact-coverage reviewer handoff lands`
      );
      assert.ok(
        tools.handoffRead({ phase_id: 'p1' }).some((h) => (h as { agent_role?: string }).agent_role === role),
        `${role}: the landed reviewer handoff is readable`
      );
    }
  } finally {
    cleanup();
  }
});

test('AC2: a reviewer handoff lands with NO dispositions when the phase mandatory set is empty; a DIFFERENT phase\'s review_mandatory never binds this phase', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    // (1) no review_mandatory anywhere → empty set-equals empty → lands, no dispositions
    assert.doesNotThrow(() => tools.handoffWrite(handoffArgs('reviewer-correctness', 'p1')));
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 1);

    // (2) review_mandatory seeded ONLY for p2 must not bind a p1 handoff
    store.setRunReviewMandatory('r-0001', 'p2', [{ record_id: randomUUID(), reason: 'blocking anti-pattern' }]);
    assert.doesNotThrow(() => tools.handoffWrite(handoffArgs('reviewer-security', 'p1')));
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 2, "another phase's mandatory set never binds p1");
  } finally {
    cleanup();
  }
});

test('AC2: non-reviewer handoffs are entirely unaffected — they land with or without dispositions regardless of review_mandatory state', () => {
  const { store, tools, cleanup } = harness();
  try {
    startRun(store);
    const m1 = randomUUID();
    // a non-empty mandatory set that a reviewer WOULD have to satisfy exactly
    store.setRunReviewMandatory('r-0001', 'p1', [{ record_id: m1, reason: 'blocking anti-pattern' }]);

    // coder with NO dispositions → lands despite the non-empty mandatory set
    assert.doesNotThrow(() => tools.handoffWrite(handoffArgs('coder', 'p1')));
    // test-writer WITH non-matching dispositions → dispositions ignored, lands
    assert.doesNotThrow(() =>
      tools.handoffWrite(handoffArgs('test-writer', 'p1', [{ record_id: randomUUID(), disposition: 'addressed' }]))
    );
    assert.equal(tools.handoffRead({ phase_id: 'p1' }).length, 2, 'both non-reviewer handoffs persisted, coverage never checked');
  } finally {
    cleanup();
  }
});

// --------------------------- note structuring dispatch (board ccb14030) ---------------------------
// PostToolUse never fires on MCP tool calls (research_finding 5e7d0a78), so
// knowledgeCreate itself dispatches the bundled worker. These tests pin the
// dispatch seam; the worker's own behavior stays covered in hooks-full.test.mjs.

test('note create dispatches note-structuring with the hook-shaped payload; success is not a skip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tools-'));
  const store = new SterlingStore(join(dir, 'sterling.db'));
  const payloads: NoteExtractionPayload[] = [];
  const tools = new SterlingTools({
    store,
    now: () => NOW,
    repoRoot: dir,
    noteExtraction: (p) => {
      payloads.push(p);
      return { dispatched: true };
    },
  });
  try {
    const { record, check_skipped } = tools.knowledgeCreate('note', {
      raw_text: 'queue-level retries beat global backoff',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].cwd, dir, 'worker opens the store at the project root');
    assert.equal(payloads[0].tool_input.type, 'note');
    assert.equal(payloads[0].tool_input.fields.raw_text, 'queue-level retries beat global backoff');
    const echoed = JSON.parse(payloads[0].tool_response.content[0].text) as { record: { id: string } };
    assert.equal(echoed.record.id, record.id, 'tool_response carries the created record like the hook input did');
    assert.ok(
      !check_skipped.some((s) => s.check === 'note-structuring-h11'),
      'a dispatched extraction is not a skipped check'
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('note-structuring dispatch failure is loud: reason in the envelope AND a store row (P5)', () => {
  // no repoRoot → the server cannot tell the worker where the store lives
  const { store, tools, cleanup } = harness();
  try {
    const { check_skipped } = tools.knowledgeCreate('note', {
      raw_text: 'a note with nowhere to extract',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    assert.ok(check_skipped.some((s) => s.check === 'note-structuring-h11' && s.reason === 'no_repo_root'));
    assert.ok(store.listCheckSkipped().some((s) => s.check_name === 'note-structuring-h11' && s.reason === 'no_repo_root'));
  } finally {
    cleanup();
  }

  // an injected dispatcher that reports failure (e.g. worker script missing) surfaces its reason
  const dir = mkdtempSync(join(tmpdir(), 'sterling-tools-'));
  const store2 = new SterlingStore(join(dir, 'sterling.db'));
  const tools2 = new SterlingTools({
    store: store2,
    now: () => NOW,
    repoRoot: dir,
    noteExtraction: () => ({ dispatched: false, reason: 'worker_script_missing' }),
  });
  try {
    const { check_skipped } = tools2.knowledgeCreate('note', {
      raw_text: 'another note',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    assert.ok(check_skipped.some((s) => s.check === 'note-structuring-h11' && s.reason === 'worker_script_missing'));
  } finally {
    store2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default dispatch spawns the bundled worker end-to-end: candidate lands derived_unconfirmed citing the note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-note-e2e-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const fake = join(dir, 'fake-extractor.mjs');
  writeFileSync(
    fake,
    `process.stdout.write(JSON.stringify({ candidates: [{ type: 'decision', fields: { title: 'Queue-level retries', statement: 'Retry per queue, not global backoff.', alternatives_rejected: [], rationale: 'per-org limits' } }] }));`
  );
  const prevExtractor = process.env.STERLING_H11_EXTRACTOR;
  process.env.STERLING_H11_EXTRACTOR = fake;
  const tools = new SterlingTools({ store, repoRoot: dir }); // default noteExtraction — the real spawn
  try {
    const { record, check_skipped } = tools.knowledgeCreate('note', {
      raw_text: 'genesys rate limits are per-org; we chose queue-level retries',
      captured_at: NOW,
      capture_source: 'conductor',
      derived: [],
    });
    assert.ok(!check_skipped.some((s) => s.check === 'note-structuring-h11'), 'dispatch started');
    // fire-and-forget: poll the store for the worker's cross-process write
    const deadline = Date.now() + 20_000;
    let candidates: DurableRecord[] = [];
    while (Date.now() < deadline) {
      candidates = store.query({ types: ['decision'], include_unconfirmed: true, cap: 5 });
      if (candidates.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(candidates.length, 1, 'worker wrote the extraction candidate');
    assert.equal(candidates[0].derived_unconfirmed, true);
    assert.ok(candidates[0].links.some((l) => l.rel === 'cites' && l.target_id === record.id), 'candidate cites the note');
    assert.deepEqual((store.get(record.id) as { derived: string[] }).derived, [candidates[0].id], 'note.derived[] updated');
  } finally {
    if (prevExtractor === undefined) delete process.env.STERLING_H11_EXTRACTOR;
    else process.env.STERLING_H11_EXTRACTOR = prevExtractor;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
