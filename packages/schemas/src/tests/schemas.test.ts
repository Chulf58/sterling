import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  normalizeRepoPath,
  toRepoRelative,
  matchesGlob,
  decisionSchema,
  featureArticleSchema,
  todoSchema,
  noteSchema,
  briefSchema,
  handoffSchema,
  runRecordSchema,
  RECORD_TYPES,
  validateRecord,
  SPINE_SIGNALS,
} from '../index.js';

const NOW = '2026-06-10T12:00:00.000Z';

export function envelope(type: string) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

export function validDecision() {
  return {
    ...envelope('decision'),
    title: 'Use SQLite',
    statement: 'SQLite via node:sqlite is the storage substrate.',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no file-key joins, no FTS rank' }],
    rationale: 'Satisfies all six §3.1 criteria with zero native dependencies.',
    file_keys: ['packages/store/src/index.ts'],
  };
}

test('path invariant: normalization and rejections (§3.2)', () => {
  assert.equal(normalizeRepoPath('src\\auth\\login.ts'), 'src/auth/login.ts');
  assert.equal(normalizeRepoPath('./src//x/./y.ts'), 'src/x/y.ts');
  assert.equal(normalizeRepoPath('a/b/'), 'a/b');
  assert.throws(() => normalizeRepoPath('C:\\repo\\src\\a.ts'), /drive-prefixed/);
  assert.throws(() => normalizeRepoPath('/abs/path.ts'), /absolute/);
  assert.throws(() => normalizeRepoPath('../escape.ts'), /parent-escaping/);
  assert.throws(() => normalizeRepoPath(''), /empty/);
  assert.throws(() => normalizeRepoPath('./.'), /empty/);
});

test('matchesGlob: ** crosses segments, * stays within, ? single char', () => {
  assert.equal(matchesGlob('tests/a/b.test.ts', 'tests/**'), true);
  assert.equal(matchesGlob('src/x.test.ts', '**/*.test.ts'), true);
  assert.equal(matchesGlob('x.test.ts', '**/*.test.ts'), true);
  assert.equal(matchesGlob('src/x.ts', '**/*.test.ts'), false);
  assert.equal(matchesGlob('src/a/b.ts', 'src/*.ts'), false);
  assert.equal(matchesGlob('src/b.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src\\b.ts', 'src/*.ts'), true, 'backslash input normalized');
  assert.equal(matchesGlob('axts', 'a?ts'), true);
  assert.equal(matchesGlob('a/ts', 'a?ts'), false, '? never matches a separator');
});

test('toRepoRelative relativizes against repo root', () => {
  assert.equal(toRepoRelative('C:\\repo\\src\\a.ts', 'C:\\repo'), 'src/a.ts');
  assert.equal(toRepoRelative('C:/repo/src/a.ts', 'C:/repo/'), 'src/a.ts');
  assert.throws(() => toRepoRelative('C:/elsewhere/a.ts', 'C:/repo'), /not under repo root/);
});

test('record schemas normalize file paths at the boundary', () => {
  const d = decisionSchema.parse({ ...validDecision(), file_keys: ['src\\store\\db.ts'] });
  assert.deepEqual(d.file_keys, ['src/store/db.ts']);
});

test('supersession field pairing is enforced both ways (§3.2)', () => {
  assert.throws(() => decisionSchema.parse({ ...validDecision(), status: 'superseded' }), /requires superseded_by/);
  assert.throws(
    () => decisionSchema.parse({ ...validDecision(), superseded_by: randomUUID() }),
    /forbids superseded_by/
  );
  const ok = decisionSchema.parse({ ...validDecision(), status: 'superseded', superseded_by: randomUUID() });
  assert.equal(ok.status, 'superseded');
});

test('todo: system source requires system_reason; no done status exists (§3.2.7)', () => {
  const base = { ...envelope('todo'), text: 'reconcile auth article', source: 'system' };
  assert.throws(() => todoSchema.parse(base), /requires system_reason/);
  const ok = todoSchema.parse({ ...base, system_reason: 'reconcile_needed' });
  assert.equal(ok.system_reason, 'reconcile_needed');
  assert.ok(!('done' in ok));
  todoSchema.parse({ ...envelope('todo'), text: 'user item', source: 'user' });
  const prio = todoSchema.parse({ ...envelope('todo'), text: 'user item', source: 'user', priority: 'high' });
  assert.equal(prio.priority, 'high');
  assert.throws(() => todoSchema.parse({ ...envelope('todo'), text: 'x', source: 'user', priority: 'urgent' }), /invalid/i);
});

test('feature_article: dormant requires state_reason + wiring_todo_id (§3.2.3)', () => {
  const art = {
    ...envelope('feature_article'),
    slug: 'csv-export',
    title: 'CSV export',
    what_it_does: 'Exports the board as CSV.',
    intended_behavior: 'User clicks Export and receives a CSV file.',
    files: [{ path: 'src\\export\\csv.ts', role: 'serializer' }],
    current_ac: [{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'dormant',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [{ ac_id: 'AC1', test_paths: ['tests\\export.test.ts'] }],
  };
  assert.throws(() => featureArticleSchema.parse(art), /dormant/);
  const ok = featureArticleSchema.parse({ ...art, state_reason: 'wired in next phase', wiring_todo_id: randomUUID() });
  assert.equal(ok.files[0].path, 'src/export/csv.ts');
  assert.equal(ok.live_test_refs[0].test_paths[0], 'tests/export.test.ts');
  assert.throws(() => featureArticleSchema.parse({ ...art, state: 'built', version: 0 }), /version/i);
});

test('brief: attribution sections and verifiable_at syntax (§4)', () => {
  const brief = {
    ...envelope('brief'),
    slug: 'csv-export',
    title: 'CSV export',
    problem: 'No way to get data out.',
    feature: 'Export the board as CSV.',
    user_stated: { criteria: ['user said: must be Excel-openable'], constraints: [] },
    conductor_proposals: [{ text: 'stream rather than buffer', status: 'unconfirmed' }],
    acceptance_criteria: [
      { ac_id: 'AC1', text: 'user clicks Export and gets a file', verifiable_at: 'final' },
      { ac_id: 'AC2', text: 'header row present', verifiable_at: 'phase:1' },
    ],
    technical_design: { approach: 'serializer module', interfaces: [], shared_structures: [] },
    blast_radius: { files: [{ path: 'src\\export\\csv.ts', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: ['src/board/types.ts'],
    out_of_scope: ['changing board storage'],
    phases: [
      {
        phase_id: 'p1',
        goal: 'serializer',
        subtasks: ['write serializer'],
        ac_ids: ['AC2'],
        difficulty: { level: 'normal', reasons: [] },
        model_hint: 'sonnet',
      },
    ],
    decisions_made: [],
  };
  const ok = briefSchema.parse(brief);
  assert.equal(ok.blast_radius.files[0].path, 'src/export/csv.ts');
  assert.throws(
    () => briefSchema.parse({ ...brief, acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'phase1' }] }),
    /invalid/i
  );

  // §7.1/§7.6 risk flags: closed set, frozen into data before the run
  const flagged = briefSchema.parse({ ...brief, risk_flags: ['security_relevant'] });
  assert.deepEqual(flagged.risk_flags, ['security_relevant']);
  assert.throws(() => briefSchema.parse({ ...brief, risk_flags: ['urgent'] }), /invalid/i);

  // §8.1 per-phase interface slice: names must exist in technical_design.interfaces
  const withInterfaces = {
    ...brief,
    technical_design: { approach: 'a', interfaces: [{ name: 'exportBoard', contract: '(todos) -> csv' }], shared_structures: [] },
    phases: [{ ...brief.phases[0], interfaces: ['exportBoard'] }],
  };
  briefSchema.parse(withInterfaces);
  assert.throws(
    () => briefSchema.parse({ ...withInterfaces, phases: [{ ...brief.phases[0], interfaces: ['ghostInterface'] }] }),
    /undeclared interface 'ghostInterface'/
  );
});

test('note schema and handoff/run-record transient shapes', () => {
  noteSchema.parse({
    ...envelope('note'),
    raw_text: 'genesys api rate limits are per-org not per-token',
    captured_at: NOW,
    capture_source: 'tui',
    derived: [],
  });
  const h = handoffSchema.parse({
    phase_id: 'p1',
    agent_role: 'coder',
    what_changed: [{ path: 'src\\a.ts', change_role: 'implemented serializer' }],
    wired: [],
    deferred: [],
    decisions_made: [],
    tests_produced: ['tests/a.test.ts'],
    exit_signal: 'complete',
    unresolved: [],
  });
  assert.equal(h.what_changed[0].path, 'src/a.ts');
  assert.throws(
    () => handoffSchema.parse({ ...h, exit_signal: 'victory' }),
    /invalid/i,
    'non-enum exit signal must be rejected'
  );
  runRecordSchema.parse({
    id: 'r-0001',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-0001',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: { coder: 1 },
    escalations: [],
    started_at: NOW,
  });
});

test('full §3.2 record set: anti_pattern, research_finding, reference_material, disconfirmed_hypothesis', () => {
  const ap = validateRecord({
    ...envelope('anti_pattern'),
    title: 'No raw SQL concat',
    trigger: 'when building queries from user input',
    guidance: 'use parameterized queries, not string concat',
    wrong_way: '"SELECT * FROM x WHERE id=" + id',
    right_way: 'db.prepare("... WHERE id = ?").get(id)',
    source_evidence: 'run r-0042, src/db.ts:88',
    file_keys: ['src\\db.ts'],
    severity: 'block',
  });
  assert.equal((ap as { basis: string }).basis, 'codebase', 'basis defaults to codebase');
  assert.deepEqual((ap as { file_keys: string[] }).file_keys, ['src/db.ts']);

  const rf = validateRecord({
    ...envelope('research_finding'),
    question: 'genesys rate limit scope?',
    answer: 'per-org, not per-token',
    source_urls: ['https://developer.genesys.cloud/x'],
    source_date: '2026-01-15',
    capture_date: '2026-06-01',
    volatility_hint: 'medium',
  });
  assert.equal(rf.type, 'research_finding');
  // research adds flagged_stale to the status enum (§3.2.4)
  validateRecord({ ...(rf as unknown as Record<string, unknown>), id: randomUUID(), status: 'flagged_stale' });
  assert.throws(() => validateRecord({ ...(envelope('decision') as object), status: 'flagged_stale', title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' }), /invalid/i);

  validateRecord({
    ...envelope('reference_material'),
    title: 'Genesys API guide',
    kind: 'url',
    location: 'https://developer.genesys.cloud',
    summary: 'platform API reference',
    source_date: '2025-11-01',
    capture_date: '2026-06-01',
    basis: 'platform',
  });

  validateRecord({
    ...envelope('disconfirmed_hypothesis'),
    question: 'is the cache stale?',
    rejected_answer: 'no — TTL was correct; root cause was clock skew',
    evidence: 'debug run r-0099, traces at src/cache.ts:40',
    file_keys: ['src/cache.ts'],
  });
});

test('registry: full record set registered 1:1, unregistered type rejected loudly (invariant 3)', () => {
  assert.deepEqual(Object.keys(RECORD_TYPES).sort(), [
    'anti_pattern',
    'brief',
    'decision',
    'disconfirmed_hypothesis',
    'feature_article',
    'note',
    'reference_material',
    'research_finding',
    'todo',
  ]);
  for (const [name, entry] of Object.entries(RECORD_TYPES)) {
    assert.equal(typeof entry.fts, 'function', `${name} needs an fts extractor`);
    assert.equal(typeof entry.fileKeys, 'function', `${name} needs a fileKeys extractor`);
  }
  assert.equal(RECORD_TYPES.decision.immutable, true);
  const validated = validateRecord(validDecision());
  assert.equal(validated.type, 'decision');
  assert.throws(() => validateRecord({ ...envelope('escalation_log'), title: 'x' }), /unregistered record type 'escalation_log'/);
  assert.throws(() => validateRecord({ no_type: true }), /no record type/);
});

test('the signal enum is closed at the full nine §5.1 members', () => {
  assert.deepEqual(
    [...SPINE_SIGNALS],
    ['complete', 'research-needed', 'review-unresolved', 'blocked', 'tests-invalid', 'contract-violated', 'bug-found', 'phase-overflow', 'agent-died']
  );
});
